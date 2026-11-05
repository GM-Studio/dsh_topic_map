/**
 * Host half: serve the panel's data over one HTTP route.
 *
 * The browser half cannot read session logs, so every number it draws comes
 * from here. The transport is a plain `webServer` route rather than a bespoke
 * RPC channel: the route contract is public and stable, and the panel calls it
 * with `fetch` exactly like the harness's own plugin panels do.
 *
 * `webServer` is optional: a composition without it leaves the plugin inert
 * (the panel shows an unavailable notice) instead of failing to boot.
 *
 * @module dsh-topic-map
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ENGINE_VERSION, lanesFromAssignment } from './lane-engine.js'
import { buildSessionPayloadParts } from './payload.js'
import { SessionCache } from './session-cache.js'
import {
  DEFAULT_TURN_LIMIT,
  analysisWindowStart,
  buildAssignmentPrompt,
  parseAssignment,
  summarizeTurns,
} from './semantic.js'
import {
  STAGE_RANGE,
  WORKFLOWS_PER_STAGE,
  buildMergePrompt,
  buildTree,
  parseMerge,
  turnPathIndex,
  validateTree,
} from './hierarchy.js'
import { SegmentStore, askOnce } from './llm-call.js'
import { callRemote, hasCustomEndpoint } from './remote-llm.js'
import { mergeUiState, normalizeUiState, safeSessionId } from './ui-state.js'
import { computeComeBack, computeSupersession, inferFromEvidence } from './pm-model.js'
import { buildReviewPrompt, parseReview, pickSuspects } from './status-review.js'
import { ProgressStore, advanceRun, finishRun, isStale, runView } from './progress.js'
import {
  buildMergePrompt as buildTopicMergePrompt,
  parseMergeVerdict,
  pickMergeCandidates,
  toMergeInstructions,
} from './topic-merge.js'
import { applyMerges } from './topic-graph.js'

/** Cordis plugin name. */
export const name = 'topic-map'

/** Hard dependencies: without these there is nothing to read. */
export const inject = ['sessionQuery', 'sessionPersistence']

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/api/topic-map'

/**
 * Install the Host half.
 *
 * @param ctx - Host root context.
 */
export function apply(ctx) {
  const cache = new SessionCache()
  // 分段结果落盘：切走会话（面板卸载）再回来仍然是精细结构。
  // 目录与配置文件同级，都放在 DSH home 下，不污染源码工作区。
  const segDir = segmentsDir()
  const segments = new SegmentStore(segDir)
  // 分析进度：短生命周期的运行时状态，放内存即可（进程重启后分析本来就中断了）。
  const progress = new ProgressStore()
  // 取消标记：分析在步骤之间检查它，实现"下一步不再继续"。
  const cancelFlag = new Map()
  segments.bindPersistence({ writeFile, mkdir, dirname })

  ctx.inject(['webServer'], scope => {
    const server = scope.get('webServer')
    if (server === undefined) return

    scope.effect(
      () =>
        server.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: routeHandler(ctx, cache, segments, progress, cancelFlag),
        }),
      'topic-map: routes',
    )
  })
}

/** Build the request handler bound to one cache instance. */
function routeHandler(ctx, cache, segments, progress, cancelFlag) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const action = url.pathname.slice(ROUTE_PREFIX.length + 1) || 'health'

      if (req.method === 'GET' && action === 'health') {
        return sendJson(res, 200, { ok: true, engineVersion: ENGINE_VERSION })
      }

      if (req.method === 'POST' && action === 'session') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })
        const payload = await buildSessionPayload(ctx, cache, sessionId, body?.force === true, segments)
        return sendJson(res, 200, { ok: true, value: payload })
      }

      if (req.method === 'POST' && action === 'overview') {
        const body = await readJson(req)
        const payload = await buildOverview(ctx, cache, body?.workspaceId)
        return sendJson(res, 200, { ok: true, value: payload })
      }

      // Ask the harness to reconcile the profile: it evicts changed modules and
      // restarts the affected plugins, which is how a Host-half edit takes
      // effect without quitting the app. Present so a code change does not need
      // a full DSH restart.
      if (req.method === 'POST' && action === 'reload') {
        const result = await reloadSelf(ctx)
        return sendJson(res, 200, { ok: true, value: result })
      }

      // 语义分段：本地初分 + 只问边界。手动触发，先产出待确认的预览。
      if (req.method === 'POST' && action === 'analyze') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })

        // 客户端断开（用户点了取消 / 关掉面板）就中止模型调用，不继续烧 token。
        const controller = new AbortController()
        let aborted = false
        res.on('close', function () {
          if (!res.writableEnded) {
            aborted = true
            controller.abort()
          }
        })

        let result
        // 开始记录进度：客户端轮询 progress 端点画分步进度条。
        cancelFlag.delete(sessionId)
        progress.start(sessionId)
        try {
          result = await runSemanticAnalysis(ctx, cache, segments, sessionId, body?.limit, controller.signal, {
            progress,
            cancelFlag,
          })
          const run = progress.get(sessionId)
          if (run !== undefined && run.status === 'running') {
            progress.set(sessionId, finishRun(run, result.status === 'ready' ? 'done' : 'failed', result.reason ?? null))
          }
        } catch (error) {
          const run = progress.get(sessionId)
          if (run !== undefined && run.status === 'running') {
            progress.set(sessionId, finishRun(run, 'failed', error instanceof Error ? error.message : String(error)))
          }
          if (aborted) return
          throw error
        }
        if (aborted) return
        return sendJson(res, 200, { ok: true, value: result })
      }

      // 采纳 / 回退模型结果。
      if (req.method === 'POST' && action === 'apply-semantic') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })
        const payload = await applySemantic(ctx, cache, segments, sessionId)
        return sendJson(res, 200, { ok: true, value: payload })
      }

      if (req.method === 'POST' && action === 'revert-semantic') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })
        segments.revert(sessionId)
        const payload = await buildSessionPayload(ctx, cache, sessionId, true, segments)
        return sendJson(res, 200, { ok: true, value: payload })
      }

      // 配置：模型与轮次上限。
      if (req.method === 'GET' && action === 'config') {
        return sendJson(res, 200, { ok: true, value: readConfig() })
      }
      if (req.method === 'POST' && action === 'config') {
        const body = await readJson(req)
        const saved = await saveConfig(body)
        return sendJson(res, 200, { ok: true, value: saved })
      }

      // 界面状态：任务状态覆盖 + 筛选条件。按会话分别持久化。
      if (req.method === 'POST' && action === 'ui-state') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })
        // 没有 patch 就是纯读取。
        if (body?.patch === undefined) {
          return sendJson(res, 200, { ok: true, value: readUiState(sessionId) })
        }
        const saved = await writeUiState(sessionId, body.patch)
        return sendJson(res, 200, { ok: true, value: saved })
      }

      // 分析进度：客户端轮询这个端点画进度条。
      if (req.method === 'POST' && action === 'progress') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })
        const run = progress.get(sessionId)
        return sendJson(res, 200, {
          ok: true,
          value: Object.assign(runView(run), { stale: isStale(run) }),
        })
      }

      // 取消正在进行的分析。
      if (req.method === 'POST' && action === 'cancel-analyze') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })
        const run = progress.get(sessionId)
        if (run !== undefined && run.status === 'running') {
          progress.set(sessionId, finishRun(run, 'cancelled'))
          cancelFlag.set(sessionId, true)
        }
        return sendJson(res, 200, { ok: true, value: true })
      }

      // 状态复核：把本地初判里"可疑"的任务交给模型确认。
      //
      // 只在用户主动点按钮时调用——自动跑会频繁烧 token，而状态变化没那么快。
      if (req.method === 'POST' && action === 'review-status') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })

        const controller = new AbortController()
        let aborted = false
        res.on('close', function () {
          if (!res.writableEnded) { aborted = true; controller.abort() }
        })

        let result
        try {
          result = await runStatusReview(ctx, cache, segments, sessionId, controller.signal)
        } catch (error) {
          if (aborted) return
          throw error
        }
        if (aborted) return
        return sendJson(res, 200, { ok: true, value: result })
      }

      return sendJson(res, 404, { ok: false, error: 'unknown action' })
    } catch (error) {
      // A panel action must never take the Host down: report and keep serving.
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 500, { ok: false, error: message })
    }
  }
}

/**
 * Read a session's full event log.
 *
 * `listEvents` returns lightweight records (seq/type/time/surface) with no
 * `data` payload, which is all a status list needs and useless for folding a
 * turn: prompts, usage, and tool names all live in `data`. `readSession`
 * returns the complete events, so that is what the fold consumes.
 *
 * @param ctx - Host context.
 * @param sessionId - target session.
 * @returns the raw events in ascending seq order.
 */
async function readEvents(ctx, sessionId) {
  try {
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    if (snapshot === null || snapshot === undefined) return []
    return Array.isArray(snapshot.events) ? snapshot.events : []
  } catch {
    // A log that fails replay validation must not take the panel down; the
    // caller renders "no turns" and the session itself reports its own error.
    return []
  }
}

/**
 * Full payload for one session: turns, lanes, totals, cost.
 *
 * @param ctx - Host context.
 * @param cache - session cache.
 * @param sessionId - target session.
 * @param force - bypass the revision cache.
 */
export async function buildSessionPayload(ctx, cache, sessionId, force = false, segments = null, options = {}) {
  const revision = await readRevision(ctx, sessionId)
  const hit = cache.get(sessionId, revision, ENGINE_VERSION)
  if (hit !== undefined && !force) return hit

  const events = await readEvents(ctx, sessionId)
  // All derivation lives in the pure module so it can be exercised in Node
  // without a running harness; this half owns only the I/O around it.
  const payload = await buildSessionPayloadParts(events, sessionId, cache.overridesOf(sessionId))

  // 恢复上次采纳的分层结果。这是「切走再回来结构变了」那个 bug 的修复点：
  // 不恢复的话，每次重新打开都退回本地规则的平铺结构。
  const restored = await restoreApplied(ctx, sessionId, payload, segments)

  // `options.cache === false` 表示"只要一份基线，别动缓存"。
  // rebuildWithCuts 用它取干净的 turns/totals，再由自己写入正确的条目——
  // 否则这里会把本地规则版本留在缓存里，覆盖掉精细结构。
  if (options.cache !== false) {
    cache.set(sessionId, revision, ENGINE_VERSION, restored)
  }
  return restored
}

/**
 * 若该会话保存过分层结果，把它套回 payload。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话。
 * @param payload - 本地规则算出的 payload。
 * @param segments - 分段持有者，可为 null。
 * @returns 应用过分层的 payload，或原样返回。
 */
async function restoreApplied(ctx, sessionId, payload, segments) {
  if (segments === null) return payload
  await segments.hydrate(sessionId, readFile)
  const record = segments.get(sessionId)
  const applied = record === undefined ? undefined : record.semantic
  if (applied === undefined || !Array.isArray(applied.lanes) || applied.lanes.length === 0) {
    return payload
  }
  const { buildGraph } = await import('./graph-layout.js')
  return {
    ...payload,
    lanes: applied.lanes,
    graph: buildGraph(payload.turns, applied.lanes),
    stages: Array.isArray(applied.stages) ? applied.stages : [],
    twoLevel: applied.twoLevel === true,
    hierarchyReason: applied.hierarchyReason ?? null,
    semantic: {
      applied: true,
      provider: applied.provider ?? '',
      model: applied.model ?? '',
      analyzedFrom: applied.analyzedFrom ?? 0,
    },
  }
}

// ── 语义分段 ───────────────────────────────────────────────────────

/**
 * 配置文件位置。
 *
 * 放在 DSH 的 home 下而不是插件目录：`~/.dsh/topic-map/config.json`。
 * 插件目录指向源码（junction），把用户设置写进去会污染工作区、也会被
 * 版本控制误提交。
 *
 * @returns 绝对路径，或 null（无法确定 home）。
 */
function configPath() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : '')
    || (process.env.HOME ? join(process.env.HOME, '.dsh') : '')
  if (home === '') return null
  return join(home, 'topic-map', 'config.json')
}

/**
 * 分段结果的存放目录。
 * @returns 绝对路径，或 null。
 */
function segmentsDir() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : '')
    || (process.env.HOME ? join(process.env.HOME, '.dsh') : '')
  if (home === '') return null
  return join(home, 'topic-map', 'segments')
}

/**
 * 界面状态的存放目录（任务状态的手动覆盖 + 筛选条件）。
 * @returns 绝对路径，或 null。
 */
function uiStateDir() {
  const home = process.env.DSH_HOME
    || (process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh') : '')
    || (process.env.HOME ? join(process.env.HOME, '.dsh') : '')
  if (home === '') return null
  return join(home, 'topic-map', 'ui')
}

/**
 * 读取某会话的界面状态。
 *
 * 读不到就返回空状态——文件损坏不该让面板打不开。
 *
 * @param sessionId - 会话。
 * @returns 归一化后的 UI 状态。
 */
function readUiState(sessionId) {
  const dir = uiStateDir()
  if (dir === null) return normalizeUiState(null)
  const path = join(dir, safeSessionId(sessionId) + '.json')
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return normalizeUiState(raw)
  } catch {
    return normalizeUiState(null)
  }
}

/** 排队写盘，避免同一会话的并发请求互相覆盖。 */
const uiWriteChains = new Map()

/**
 * 写入某会话的界面状态，并等待落盘。
 *
 * @param sessionId - 会话。
 * @param patch - 要改的字段。
 * @returns 合并后的完整状态。
 */
async function writeUiState(sessionId, patch) {
  const dir = uiStateDir()
  const current = readUiState(sessionId)
  const next = mergeUiState(current, patch)
  if (dir === null) return next

  const path = join(dir, safeSessionId(sessionId) + '.json')
  const prev = uiWriteChains.get(sessionId) ?? Promise.resolve()
  const chain = prev.then(async () => {
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(path, JSON.stringify(next, null, 2), 'utf8')
    } catch {
      // 写不进去只影响"下次能否恢复"，本次仍然按新状态返回。
    }
  })
  uiWriteChains.set(sessionId, chain)
  await chain
  return next
}

/** 排队写盘，避免并发请求互相覆盖。 */
let configWriteChain = Promise.resolve()

/**
 * 读取本插件的运行配置。
 *
 * 文件不存在或损坏时退回默认值——配置坏了不该让功能不可用。
 *
 * @returns 归一化后的配置。
 */
function readConfig() {
  const path = configPath()
  let raw = {}
  if (path !== null) {
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      raw = {}
    }
  }
  const c = raw && typeof raw === 'object' ? raw : {}
  return {
    // 空字符串表示"跟随当前会话模型"。
    provider: typeof c.provider === 'string' ? c.provider : '',
    model: typeof c.model === 'string' ? c.model : '',
    turnLimit: Number.isFinite(c.turnLimit) && c.turnLimit > 0
      ? Math.floor(c.turnLimit)
      : DEFAULT_TURN_LIMIT,
    // 自定义端点：三项齐全时才生效，否则一律走会话模型。
    baseUrl: typeof c.baseUrl === 'string' ? c.baseUrl : '',
    apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
    modelName: typeof c.modelName === 'string' ? c.modelName : '',
  }
}

/**
 * 保存配置，并等待落盘。
 *
 * @param body - 请求体。
 * @returns 归一化后的配置。
 */
async function saveConfig(body) {
  const next = {
    provider: typeof body?.provider === 'string' ? body.provider.trim() : '',
    model: typeof body?.model === 'string' ? body.model.trim() : '',
    turnLimit: Number.isFinite(body?.turnLimit) && body.turnLimit > 0
      ? Math.min(500, Math.floor(body.turnLimit))
      : DEFAULT_TURN_LIMIT,
    baseUrl: typeof body?.baseUrl === 'string' ? body.baseUrl.trim() : '',
    apiKey: typeof body?.apiKey === 'string' ? body.apiKey.trim() : '',
    modelName: typeof body?.modelName === 'string' ? body.modelName.trim() : '',
  }
  const path = configPath()
  if (path === null) return next

  // 串行化：两个保存请求同时到达时，后写的才是最终值。
  configWriteChain = configWriteChain.then(async () => {
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, JSON.stringify(next, null, 2), 'utf8')
    } catch {
      // 写不进去不影响本次会话使用，只是重启后丢失。
    }
  })
  await configWriteChain
  return next
}

/**
 * 解析要用的模型路由。
 *
 * 配置为空时跟随会话：用最后一次请求头里的 provider/model。这样不必让用户
 * 先去设置页填一个模型 ID 才能用上语义分段。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话。
 * @param config - 配置。
 * @returns `{ provider, model }`，无法确定时返回 null。
 */
async function resolveRoute(ctx, sessionId, config) {
  if (config.provider !== '' && config.model !== '') {
    return { provider: config.provider, model: config.model }
  }
  try {
    const events = await readEvents(ctx, sessionId)
    // 最后一个请求头记录了实际使用的路由。
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (ev === null || typeof ev !== 'object' || ev.type !== 'request/header') continue
      const cfg = ev.data?.header?.config
      if (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
        return { provider: cfg.provider, model: cfg.model }
      }
    }
    // 退一步：任一 assistant 消息的来源。
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i]
      if (ev === null || typeof ev !== 'object' || ev.type !== 'assistant/message') continue
      const src = ev.data?.message?.source
      if (src && src.kind === 'model' && typeof src.provider === 'string') {
        return { provider: src.provider, model: String(src.model ?? '') }
      }
    }
  } catch { /* 落到 null */ }
  return null
}

/**
 * 跑一次语义分析，产出"待确认"的分段。
 *
 * 流程：
 *   1. 本地规则先分，得到基线切断集合；
 *   2. 只挑相似度处于模糊区间的边界，逐个问模型；
 *   3. 合并模型判定，重新聚合泳道；
 *   4. 结果存为 pending，等用户确认。
 *
 * 失败（模型不可用、超时、解析不出）时**保留本地结果**并把原因带回，
 * 由界面标注"未精化"——不假装成功，也不把图弄丢。
 *
 * @param ctx - Host context。
 * @param cache - 会话缓存。
 * @param segments - 分段持有者。
 * @param sessionId - 目标会话。
 * @param limitOverride - 本次分析的轮次上限。
 * @returns 预览结果。
 */
/**
 * 状态复核：本地初判 → 挑可疑 → 问模型 → 合并。
 *
 * 为什么不在分析流程里顺手做：状态复核要读每条任务的对话内容，比分段贵；
 * 而且状态变化不频繁，没必要每次分析都跑。所以做成独立动作、用户点了才跑。
 *
 * @param ctx - Host context。
 * @param cache - 会话缓存。
 * @param segments - 分段持有者。
 * @param sessionId - 会话。
 * @param signal - 取消信号。
 * @returns 复核结果：每条的初判、复核结论、以及用哪个。
 */
async function runStatusReview(ctx, cache, segments, sessionId, signal) {
  const config = readConfig()
  const events = await readEvents(ctx, sessionId)
  const base = await buildSessionPayloadParts(events, sessionId, cache.overridesOf(sessionId))

  // 用的是**当前生效**的分层（可能来自精细分析），而不是本地规则的。
  await segments.hydrate(sessionId, readFile)
  const record = segments.get(sessionId)
  const applied = record?.semantic
  const lanes = applied !== undefined && Array.isArray(applied.lanes) && applied.lanes.length > 0
    ? applied.lanes
    : base.lanes

  const byTurn = new Map(base.turns.map(t => [t.turn, t]))
  const factOf = turn => byTurn.get(turn)
  const lastTurn = base.turns.length === 0 ? null : base.turns[base.turns.length - 1].turn
  const supersession = computeSupersession(lanes)
  const comeBack = computeComeBack(lanes)

  // 1) 本地硬证据初判
  const entries = lanes.map(lane => {
    const verdict = inferFromEvidence(lane, factOf, {
      lastTurnInSession: lastTurn,
      supersededAfter: supersession.get(lane.laneId) ?? null,
      laterTurnsOfSameLane: comeBack.get(lane.laneId) ?? 0,
    })
    return {
      laneId: lane.laneId,
      title: lane.title,
      turns: Array.isArray(lane.turns) ? lane.turns : [],
      state: verdict.state,
      basis: verdict.basis,
      evidence: verdict.evidence,
      suspect: verdict.suspect,
    }
  })

  // 2) 挑可疑
  const suspects = pickSuspects(entries)

  const llm = ctx.get('llm')
  const route = await resolveRoute(ctx, sessionId, config)
  const custom = hasCustomEndpoint(config)

  if (suspects.length === 0) {
    return {
      status: 'ready',
      reviewed: 0,
      total: entries.length,
      via: 'local',
      entries,
      note: '没有需要复核的任务，全部按本地证据判定',
    }
  }
  if (!custom && (llm === undefined || route === null)) {
    return {
      status: 'unavailable',
      reason: '没有可用的模型',
      reviewed: 0,
      total: entries.length,
      entries,
    }
  }

  // 3) 问模型（一次批量）
  const prompt = buildReviewPrompt(suspects, factOf)
  let text = null
  let via = 'session'
  let fallbackReason = null
  try {
    if (custom) {
      try {
        text = await callRemote({ fetch }, config, prompt.system, prompt.user, {
          maxTokens: Math.max(400, suspects.length * 60),
          signal,
        })
        via = 'custom'
      } catch (error) {
        fallbackReason = error instanceof Error ? error.message : String(error)
        via = 'session'
      }
    }
    if (text === null) {
      if (llm === undefined || route === null) throw new Error('no model available')
      text = await askOnce(llm, route, prompt.system, prompt.user, signal, {
        maxTokens: Math.max(400, suspects.length * 60),
      })
    }
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
      reviewed: 0,
      total: entries.length,
      entries,
    }
  }

  const verdicts = parseReview(text, suspects.length)
  if (verdicts === null) {
    return {
      status: 'partial',
      reason: '模型输出不是可用的状态数组',
      reviewed: 0,
      total: entries.length,
      entries,
    }
  }

  // 4) 合并：只覆盖被复核的那几条
  const byLane = new Map()
  suspects.forEach((s, i) => { byLane.set(s.laneId, verdicts[i]) })
  const merged = entries.map(e => {
    const hit = byLane.get(e.laneId)
    if (hit === undefined) return { ...e, reviewed: false }
    return {
      ...e,
      state: hit.state,
      basis: hit.reason === '' ? '模型判断' : hit.reason,
      source: 'model',
      reviewed: true,
    }
  })

  return {
    status: 'ready',
    reviewed: suspects.length,
    total: entries.length,
    via,
    fellBack: fallbackReason !== null,
    fallbackReason,
    provider: via === 'custom' ? 'custom' : (route?.provider ?? ''),
    model: via === 'custom' ? config.modelName : (route?.model ?? ''),
    entries: merged,
  }
}

async function runSemanticAnalysis(ctx, cache, segments, sessionId, limitOverride, signal, reporter = {}) {
  const store = reporter.progress ?? null
  const cancels = reporter.cancelFlag ?? null

  /** 上报进度并把当前记录写回 store。 */
  function step(stepId) {
    if (store === null) return
    const cur = store.get(sessionId)
    if (cur === undefined) return
    store.set(sessionId, advanceRun(cur, stepId))
  }
  /** 是否被要求取消。 */
  function cancelled() {
    return cancels !== null && cancels.get(sessionId) === true
  }
  const config = readConfig()
  const limit = Number.isFinite(limitOverride) && limitOverride > 0
    ? Math.floor(limitOverride)
    : config.turnLimit

  const events = await readEvents(ctx, sessionId)
  const base = await buildSessionPayloadParts(events, sessionId, cache.overridesOf(sessionId))

  const llm = ctx.get('llm')
  const route = await resolveRoute(ctx, sessionId, config)
  const start = analysisWindowStart(base.turns, limit)

  const custom = hasCustomEndpoint(config)
  if (!custom && (llm === undefined || route === null)) {
    return {
      status: 'unavailable',
      reason: llm === undefined ? 'llm service unavailable' : 'no model route for this session',
      analyzedFrom: start,
      totalTurns: base.turns.length,
    }
  }

  // 记录本次实际用了哪个通道，供预览条显示（也便于排查"为什么结果不一样"）。
  const usage = { via: custom ? 'custom' : 'session', fellBack: false, fallbackReason: null }

  /**
   * 统一的一次模型调用：自定义端点优先，失败自动回退会话模型。
   *
   * 回退是**显式**的：把原因记进 usage，预览条会显示"已回退"。不静默回退，
   * 否则用户分不清"自定义端点好用"和"其实一直在用会话模型"。
   */
  async function askModel(system, user, maxTokens) {
    if (custom) {
      try {
        const text = await callRemote({ fetch }, config, system, user, { maxTokens, signal })
        return text
      } catch (error) {
        usage.fellBack = true
        usage.fallbackReason = error instanceof Error ? error.message : String(error)
        // 落到会话模型；此时若会话模型也不可用就只能失败。
        if (llm === undefined || route === null) throw error
      }
    }
    if (llm === undefined || route === null) throw new Error('no model available')
    return askOnce(llm, route, system, user, signal, { maxTokens })
  }

  // 只把分析窗口内的轮次交给模型；更早的沿用本地结果。
  const windowTurns = base.turns.slice(start)
  if (windowTurns.length === 0) {
    return { status: 'unavailable', reason: 'no turns to analyze', analyzedFrom: start, totalTurns: 0 }
  }

  // 给模型一些已有话题名，方便它复用而不是造同义词。
  const existingKeys = base.lanes
    .map(l => l.title)
    .filter(t => typeof t === 'string' && t.length <= 8)
    .slice(0, 12)

  const { system, user } = buildAssignmentPrompt(windowTurns, existingKeys)

  let labels = null
  let failure = null
  try {
    step('segment')
    if (cancelled()) throw new Error('已取消')
    const text = await askModel(system, user, Math.max(256, windowTurns.length * 16))
    labels = parseAssignment(text, windowTurns.length)
    if (labels === null) failure = '模型输出不是可用的标签数组（长度或格式不符）'
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }

  if (labels === null) {
    return {
      status: 'unavailable',
      reason: failure ?? '模型未给出可用结果',
      provider: route.provider,
      model: route.model,
      analyzedFrom: start,
      totalTurns: base.turns.length,
    }
  }

  // 窗口之前的轮次沿用本地归属：它们通常已正确，重算只会引入不一致。
  const assignment = []
  for (let i = 0; i < base.turns.length; i += 1) {
    if (i < start) {
      const lane = base.lanes.find(l => Array.isArray(l.turns) && l.turns.includes(base.turns[i].turn))
      assignment.push(lane ? '本地:' + lane.laneId : '本地:未分组')
    } else {
      assignment.push(labels[i - start])
    }
  }

  const semanticLanes = lanesFromAssignment({ turns: base.turns, sessionId }, assignment)

  // ── 合并重复话题 ────────────────────────────────────────────────
  //
  // 分段是按"相邻轮次是否同一件事"做的，所以同一件事被中途打断后回来，
  // 可能被切成两条线。合并这一步把它们并回去——这是"话题图"与"话题列表"
  // 的根本差别：前者表达关系（分叉/汇合），后者只是罗列。
  //
  // 判据用模型而不是字面相似度：「跳转定位」与「落点偏差」字面几乎不重合
  // 却是同一件事；「面板空白」与「面板配色」字面高度重合却是两件事。
  let mergedLanes = semanticLanes
  let mergeInfo = { candidates: 0, merged: 0, instructions: [] }
  if (semanticLanes.length >= 2) {
    try {
      const pairs = pickMergeCandidates(semanticLanes)
      if (pairs.length > 0) {
        step('merge')
        const prompt = buildTopicMergePrompt(pairs, turn => base.turns.find(x => x.turn === turn))
        const text = await askModel(prompt.system, prompt.user, Math.max(300, pairs.length * 48))
        calls += 1
        const verdicts = parseMergeVerdict(text, pairs.length)
        if (verdicts !== null) {
          const instructions = toMergeInstructions(pairs, verdicts)
          if (instructions.length > 0) {
            // 转成 topic-graph 的格式（它在 keep/absorb 之上还带 atTurn）
            const asMerges = instructions.map(ins => {
              const keepLane = semanticLanes.find(l => l.laneId === ins.keep)
              const absorbLane = semanticLanes.find(l => l.laneId === ins.absorb)
              const shared = (absorbLane?.turns ?? []).filter(t => (keepLane?.turns ?? []).includes(t))
              const atTurn = shared.length > 0 ? Math.min(...shared) : Math.min(...(absorbLane?.turns ?? [0]))
              return { keep: ins.keep, absorb: ins.absorb, atTurn, reason: ins.reason }
            })
            mergedLanes = applyMerges(semanticLanes, asMerges)
            mergeInfo = { candidates: pairs.length, merged: asMerges.length, instructions: asMerges }
          } else {
            mergeInfo = { candidates: pairs.length, merged: 0, instructions: [] }
          }
        } else {
          mergeInfo = { candidates: pairs.length, merged: 0, instructions: [], reason: '模型输出不可用' }
        }
      }
    } catch (error) {
      mergeInfo = {
        candidates: 0, merged: 0, instructions: [],
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  // ── 逐层向上归并：任务 → 工作流 → 阶段 ────────────────────────────
  //
  // 为什么分三次而不是一次输出整棵树：
  //   一次输出，模型容易编错嵌套与长度，一处错位整张图就乱；
  //   逐层归并每步只做一件简单的事，每步都能独立校验，某层失败只退一层。
  //
  // 归并时给模型的是「名字 + 内容摘要」而不是只有名字——上一版只发标题，
  // 短词没有上下文，模型只能凭字面猜，所以分得不准。
  const tasks = mergedLanes.map((lane, i) => {
    const turns = Array.isArray(lane.turns) ? lane.turns : []
    const facts = turns
      .map(t => base.turns.find(x => x.turn === t))
      .filter(Boolean)
    return {
      id: lane.laneId || `K${i}`,
      name: lane.title,
      turns: [...turns],
      sample: summarizeTurns(facts, 120),
    }
  })

  let workflowNames = null
  let stageNames = null
  let hierarchyReason = null
  let calls = 1

  // 第 2 次调用：任务 → 工作流
  if (tasks.length >= 2) {
    try {
      const prompt = buildMergePrompt(
        tasks.map(t => ({ id: t.id, name: t.name, sample: t.sample })),
        'workflow',
        `每个工作流下 2-${WORKFLOWS_PER_STAGE} 个任务为宜，通常 2-4 个工作流。`,
      )
      step('workflow')
      if (cancelled()) throw new Error('已取消')
      const text = await askModel(prompt.system, prompt.user, Math.max(256, tasks.length * 16))
      calls += 1
      workflowNames = parseMerge(text, tasks.length)
      if (workflowNames === null) hierarchyReason = '工作流归并未给出可用结果，退回两层'
    } catch (error) {
      hierarchyReason = '工作流归并失败：' + (error instanceof Error ? error.message : String(error))
    }
  }

  // 第 3 次调用：工作流 → 阶段
  if (workflowNames !== null) {
    const wfNames = [...new Set(workflowNames)]
    if (wfNames.length >= 2) {
      try {
        // 每个工作流的摘要取它包含的任务摘要拼接。
        const wfSamples = wfNames.map(name => {
          const idxs = workflowNames
            .map((n, i) => (n === name ? i : -1))
            .filter(i => i >= 0)
          return {
            id: name,
            name,
            sample: idxs.map(i => tasks[i].sample).filter(Boolean).join(' / ').slice(0, 120),
          }
        })
        const prompt = buildMergePrompt(
          wfSamples,
          'stage',
          `阶段数量 ${STAGE_RANGE[0]}-${STAGE_RANGE[1]} 个为宜。`,
        )
        step('stage')
        if (cancelled()) throw new Error('已取消')
        const text = await askModel(prompt.system, prompt.user, Math.max(256, wfNames.length * 16))
        calls += 1
        stageNames = parseMerge(text, wfNames.length)
        if (stageNames === null) hierarchyReason = '阶段归并未给出可用结果，退回工作流层'
      } catch (error) {
        hierarchyReason = '阶段归并失败：' + (error instanceof Error ? error.message : String(error))
      }
    }
  }

  // 组装树，并自检。
  const tree = buildTree(tasks, workflowNames, stageNames)
  const problems = validateTree(tree)
  if (problems.length > 0) hierarchyReason = '层级自检未通过：' + problems.slice(0, 3).join('；')

  // 把每轮所属的"阶段 / 工作流 / 任务"写回泳道，供客户端渲染树与底色带。
  //
  // `category` / `categoryIndex` 是旧字段名，客户端标签底色还在读它们。
  // 现在语义是"所属阶段"：把 stageName 同步过去，底色带才有颜色可用，
  // 同时保持向后兼容（旧的 categories 数据结构已不再生成）。
  const stageOrder = new Map()
  tree.stages.forEach((s, i) => stageOrder.set(s.name, i))

  const pathOf = turnPathIndex(tree.stages)
  const lanesWithPath = mergedLanes.map(lane => {
    const first = Array.isArray(lane.turns) && lane.turns.length > 0 ? lane.turns[0] : null
    const path = first === null ? undefined : pathOf.get(first)
    const stageName = path ? path.stage : null
    return {
      ...lane,
      stageName,
      workflowName: path ? path.workflow : null,
      taskName: path ? path.task : lane.title,
      category: stageName,
      categoryIndex: stageName === null ? -1 : (stageOrder.get(stageName) ?? -1),
    }
  })

  // 阶段顺序决定轨道排序：同一阶段的话题相邻，图上才能用底色带区分。
  lanesWithPath.sort((a, b) => {
    const sa = a.stageName === null ? 999 : (stageOrder.get(a.stageName) ?? 999)
    const sb = b.stageName === null ? 999 : (stageOrder.get(b.stageName) ?? 999)
    if (sa !== sb) return sa - sb
    const ta = Array.isArray(a.turns) && a.turns.length > 0 ? a.turns[0] : 0
    const tb = Array.isArray(b.turns) && b.turns.length > 0 ? b.turns[0] : 0
    return ta - tb
  })

  const preview = {
    status: 'ready',
    // provider/model 反映**实际**用的通道：可能是自定义端点，也可能是回退后的会话模型。
    provider: usage.fellBack || !custom ? (route?.provider ?? '') : 'custom',
    model: usage.fellBack || !custom ? (route?.model ?? '') : config.modelName,
    asked: calls,
    answered: calls,
    failures: [],
    analyzedFrom: start,
    totalTurns: base.turns.length,
    lanesBefore: base.lanes.length,
    lanesAfter: lanesWithPath.length,
    labels,
    assignment,
    stages: tree.stages,
    twoLevel: tree.twoLevel,
    hierarchyReason,
    // 实际使用的通道：界面据此显示"自定义端点"或"已回退到会话模型"。
    via: usage.via,
    fellBack: usage.fellBack,
    fallbackReason: usage.fallbackReason,
    lanes: lanesWithPath,
  }

  segments.setPending(sessionId, preview)
  return preview
}

/** 相邻两轮的字面相似度，用于挑出"没把握"的边界。 */
function similarityBetweenTurns(turns, index) {
  const a = turns[index - 1]
  const b = turns[index]
  if (a === undefined || b === undefined) return 0
  return surfaceSimilarity(`${a.prompt} ${a.response}`, `${b.prompt} ${b.response}`)
}

/**
 * 粗略的字面相似度（词集 Jaccard）。
 *
 * 只用于"这个边界要不要问模型"的筛选，不参与最终判定，所以刻意保持廉价：
 * 真正决定切不切的是模型。
 */
function surfaceSimilarity(left, right) {
  const words = text => {
    const set = new Set()
    for (const w of String(text).toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) ?? []) set.add(w)
    for (const run of String(text).match(/[\u4e00-\u9fff]+/g) ?? []) {
      for (let i = 0; i + 1 < run.length; i += 1) set.add(run.slice(i, i + 2))
    }
    return set
  }
  const a = words(left)
  const b = words(right)
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const v of a) if (b.has(v)) shared += 1
  return shared / (a.size + b.size - shared)
}

/** 采纳待确认的模型结果，返回新 payload。 */
async function applySemantic(ctx, cache, segments, sessionId) {
  const current = segments.get(sessionId)
  const snapshot = current === undefined ? undefined : current.pending
  const applied = segments.applyPending(sessionId, snapshot)
  if (applied === undefined) {
    return buildSessionPayload(ctx, cache, sessionId, true, segments)
  }
  return rebuildWithCuts(ctx, cache, sessionId, applied)
}

/**
 * 用给定的泳道重建 payload。
 *
 * 只替换 lanes 与 graph，其余（轮次、用量、费用）保持原样——避免为了换一种
 * 分组而重算一遍统计。
 */
async function rebuildWithCuts(ctx, cache, sessionId, preview) {
  // 这里曾经埋了一个 bug：调用 buildSessionPayload(force=true) 而不传 segments，
  // 它内部会把**本地规则的 payload**写进缓存。返回给本次请求的对象被覆盖成了
  // 精细结构，但缓存里留的是错的——于是下次读取（切走再回来、刷新页面）
  // 拿到的就是"没有 stages 的平铺图"。实测表现为：采纳后 16 条 3 阶段，
  // 再读变成 17 条 0 阶段。
  //
  // 现在改成：取一份**不写缓存**的基线，再把精细结构显式写回缓存。
  const base = await buildSessionPayload(ctx, cache, sessionId, true, null, { cache: false })
  const lanes = Array.isArray(preview?.lanes) ? preview.lanes : base.lanes
  const { buildGraph } = await import('./graph-layout.js')
  const next = {
    ...base,
    lanes,
    graph: buildGraph(base.turns, lanes),
    stages: Array.isArray(preview?.stages) ? preview.stages : [],
    twoLevel: preview?.twoLevel === true,
    hierarchyReason: preview?.hierarchyReason ?? null,
    semantic: {
      applied: true,
      provider: preview?.provider ?? '',
      model: preview?.model ?? '',
      analyzedFrom: preview?.analyzedFrom ?? 0,
    },
  }
  // 把**正确**的精细结构写进缓存，这样后续读取直接命中它，不会被本地版本顶掉。
  const revision = await readRevision(ctx, sessionId)
  cache.set(sessionId, revision, ENGINE_VERSION, next)
  return next
}

/**
 * Ask the harness to reload this plugin's Host half.
 *
 * ES modules are cached for the life of the process, so an edit on disk does
 * nothing until something evicts the module. `hmr.reconcileProfile()` is the
 * harness's own answer to that: it compares the profile against disk, evicts
 * changed modules, and restarts the entries that were running them.
 *
 * Best-effort by design: a composition without `hmr`, or a reconciliation that
 * declines to restart, is reported rather than thrown — the caller is a
 * convenience endpoint, not part of the render path.
 *
 * @param ctx - Host context.
 * @returns what happened, for the caller to display.
 */
async function reloadSelf(ctx) {
  const hmr = ctx.get('hmr')
  if (hmr === undefined) {
    return { reloaded: false, reason: 'hmr-unavailable' }
  }
  try {
    const result = await hmr.runExclusive(() => hmr.reconcileProfile(['topic-map']))
    return {
      reloaded: true,
      warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      pending: Array.isArray(result?.pending) ? result.pending.length : 0,
      restartReason: result?.restartReason ?? null,
    }
  } catch (error) {
    return {
      reloaded: false,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Workspace overview: which sessions exist, and which are already expanded.
 *
 * Reads no logs. A session row carries turn counts only when its payload is
 * already cached, so opening the overview is O(sessions), not O(events).
 */
async function buildOverview(ctx, cache, workspaceId) {
  const registry = ctx.get('workspaceRegistry')
  const workspaces = registry === undefined ? [] : registry.list()
  const workspace = workspaceId === undefined
    ? workspaces[0]
    : workspaces.find(w => w.id === workspaceId)

  if (workspace === undefined) {
    return { workspace: null, sessions: [] }
  }

  const titles = new Map()
  const ids = [...workspace.sessionIds]
  if (ids.length > 0 && typeof ctx.sessionQuery.readTitleSnapshots === 'function') {
    try {
      for (const item of await ctx.sessionQuery.readTitleSnapshots(ids)) {
        if (item.status === 'fulfilled' && item.value.title !== undefined) {
          titles.set(item.sessionId, item.value.title.title)
        }
      }
    } catch {
      // Titles are cosmetic: fall back to the bare id rather than failing.
    }
  }

  const sessions = ids.map(sessionId => {
    const cached = cache.peek(sessionId)
    return {
      sessionId,
      title: titles.get(sessionId) ?? sessionId,
      expanded: cached !== undefined,
      turns: cached?.totals.turns ?? null,
      tokens: cached === null || cached === undefined
        ? null
        : cached.totals.input + cached.totals.output,
    }
  })

  return {
    workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
    sessions,
  }
}

/** Read the session revision used as a cache key. */
async function readRevision(ctx, sessionId) {
  const stat = await ctx.sessionPersistence.stat(sessionId)
  return stat === undefined ? 'missing' : String(stat.revision)
}

/** Read and parse a JSON body with a hard size cap. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** Write one JSON response. */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
     'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}
