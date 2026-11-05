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
import { ENGINE_VERSION, jaccard, lanesFromAssignment, tokenize } from './lane-engine.js'
import { buildSessionPayloadParts } from './payload.js'
import { buildTurnModel } from './turn-model.js'
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
import { applyMerges, findRelated, pickTopRelated } from './topic-graph.js'
import {
  buildCategoryPrompt,
  buildCategoryTree,
  fallbackTree,
  parseCategories,
  prepareSessions,
} from './session-category.js'
import { reconcileClassification } from './classification.js'

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

      // ── 工作区与跨会话 ────────────────────────────────────────────
      //
      // 这一组端点回答"这个工作区里有哪些会话"，而不是"某个会话里有哪些话题"。
      // 分工：
      //   /workspaces  —— 列出可切换的工作区
      //   /sessions    —— 某个工作区的会话清单（含自动会话标记）
      //   /categorize  —— 让模型把这些会话归成「大类 → 子类」
      //   /find        —— 跨会话全文检索

      if (req.method === 'POST' && action === 'workspaces') {
        return sendJson(res, 200, { ok: true, value: listWorkspaces(ctx) })
      }

      if (req.method === 'POST' && action === 'sessions') {
        const body = await readJson(req)
        const result = await listWorkspaceSessions(ctx, cache, body?.workspaceId)
        return sendJson(res, 200, { ok: true, value: result })
      }

      if (req.method === 'POST' && action === 'categorize') {
        const body = await readJson(req)
        const controller = new AbortController()
        let result
        try {
          result = await categorizeSessions(ctx, body?.workspaceId, body?.force === true, controller.signal)
        } catch (error) {
          result = {
            status: 'unavailable',
            reason: error instanceof Error ? error.message : String(error),
            tree: [],
          }
        }
        return sendJson(res, 200, { ok: true, value: result })
      }

      if (req.method === 'POST' && action === 'find') {
        const body = await readJson(req)
        const result = await findAcrossSessions(ctx, body?.workspaceId, body?.query, body?.limit)
        return sendJson(res, 200, { ok: true, value: result })
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

        /**
         * 分析一旦开始就跑到底，**不因客户端断开而中止**。
         *
         * 之前的做法是 res.on('close') 就 abort，理由是"别继续烧 token"。
         * 但那带来一个更糟的后果：用户切到别的页签、或只是窗口失焦导致的
         * 连接断开，几十秒的分析就白做了，切回来什么都没有。
         *
         * 现在改为：
         *   - 只有用户**显式点取消**（cancel-analyze 端点）才中止
         *   - 断开时分析继续跑完，结果留在 SegmentStore（内存 + 落盘）
         *   - 客户端切回来轮询 progress 就能拿回结果
         *
         * 代价是"关掉面板也会跑完这一次"，但那本来也是用户主动发起的。
         */
        const controller = new AbortController()

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
          // 客户端可能已经断开（返回会失败），但结果/进度都已记录，
          // 用户切回来轮询 progress 就能看到失败原因。
          try {
            return sendJson(res, 200, { ok: true, value: { status: 'failed', reason: error instanceof Error ? error.message : String(error) } })
          } catch {
            return
          }
        }
        try {
          return sendJson(res, 200, { ok: true, value: result })
        } catch {
          // 连接已断：分析结果已经存进 SegmentStore，客户端轮询能拿回来。
          return
        }
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

        // 顺带把"待确认的预览"带回去。
        //
        // 为什么合并到这一个端点：客户端切走再回来时，需要同时知道
        // "分析跑到哪了"和"有没有已经算完等我确认的结果"。分两个请求会让
        // 这两件事出现时间差，界面会闪。
        //
        // 这也是"切走不丢"的关键：分析结果在 Host 侧一直是活的（内存 + 落盘），
        // 客户端重挂载后只要问一次就能拿回来。
        await segments.hydrate(sessionId, readFile)
        const record = segments.get(sessionId)
        const pending = record?.pending ?? null

        return sendJson(res, 200, {
          ok: true,
          value: Object.assign(runView(run), {
            stale: isStale(run),
            hasPending: pending !== null,
            pending: pending === null ? null : {
              status: pending.status ?? 'ready',
              provider: pending.provider ?? '',
              model: pending.model ?? '',
              via: pending.via ?? 'session',
              fellBack: pending.fellBack === true,
              fallbackReason: pending.fallbackReason ?? null,
              lanesBefore: pending.lanesBefore ?? 0,
              lanesAfter: pending.lanesAfter ?? 0,
              lanes: pending.lanes ?? [],
              stages: pending.stages ?? [],
              twoLevel: pending.twoLevel === true,
              hierarchyReason: pending.hierarchyReason ?? null,
              analyzedFrom: pending.analyzedFrom ?? 0,
              totalTurns: pending.totalTurns ?? 0,
              asked: pending.asked ?? 0,
              answered: pending.answered ?? 0,
              failures: pending.failures ?? [],
            },
          }),
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

        // 与 analyze 同理：状态复核也要跑到底，不因客户端断开而中止。
        // 一次复核会花 token，用户切走就白费的话比"继续跑完"更糟。
        const controller = new AbortController()

        let result
        try {
          result = await runStatusReview(ctx, cache, segments, sessionId, controller.signal)
        } catch (error) {
          try {
            return sendJson(res, 200, {
              ok: true,
              value: { status: 'unavailable', reason: error instanceof Error ? error.message : String(error), entries: [] },
            })
          } catch {
            return
          }
        }
        try {
          return sendJson(res, 200, { ok: true, value: result })
        } catch {
          // 连接已断：复核结果已经由调用方落盘，客户端重挂载后能读回来。
          return
        }
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
  if (hit !== undefined && !force) {
    // 缓存命中也补一次相关性：老缓存（这个功能加上之前存的）里没有
    // related 字段，直接返回会让图上永远看不到提示连线。
    attachRelated(hit)
    return hit
  }

  const events = await readEvents(ctx, sessionId)
  // All derivation lives in the pure module so it can be exercised in Node
  // without a running harness; this half owns only the I/O around it.
  const payload = await buildSessionPayloadParts(events, sessionId, cache.overridesOf(sessionId))

  // 话题相关性：纯本地计算、零 token 成本，所以**总是**算出来，
  // 不等到语义分析。这样即使从不点 ✦，图上也能看到"这两条线内容像"。
  attachRelated(payload)

  // 恢复上次采纳的分层结果。这是「切走再回来结构变了」那个 bug 的修复点：
  // 不恢复的话，每次重新打开都退回本地规则的平铺结构。
  const restored = await restoreApplied(ctx, sessionId, payload, segments)
  attachRelated(restored)

  // `options.cache === false` 表示"只要一份基线，别动缓存"。
  // rebuildWithCuts 用它取干净的 turns/totals，再由自己写入正确的条目——
  // 否则这里会把本地规则版本留在缓存里，覆盖掉精细结构。
  if (options.cache !== false) {
    cache.set(sessionId, revision, ENGINE_VERSION, restored)
  }
  return restored
}

/**
 * 给 payload 附上话题相关性。
 *
 * 为什么放在这里而不是只在语义分析后算：相关性是**纯本地**的（标题分词 +
 * Jaccard），零 token 成本。只在分析后算的话，从不点 ✦ 的用户永远看不到它。
 *
 * 阈值策略：不用绝对阈值，而用**相对阈值**（最高分的一定比例）。
 * 理由：标题是长短不一的中文长句，Jaccard 绝对值普遍偏低（实测某会话
 * 最高只有 0.139），固定 0.3 这样的门槛会在不同数据上时松时紧。
 * 相对阈值让"这份数据里最像的那几条"总能被选出来。
 *
 * @param payload - 会话 payload（就地修改 edges 与 related）。
 */
function attachRelated(payload) {
  if (payload === null || payload === undefined) return
  const lanes = Array.isArray(payload.lanes) ? payload.lanes : []
  if (lanes.length < 2) {
    payload.related = []
    return
  }
  try {
    const similar = (a, b) => jaccard(new Set(tokenize(String(a.title ?? ''))), new Set(tokenize(String(b.title ?? ''))))
    // 先全收（阈值 0），再由纯函数按相对阈值挑——
    // 阈值策略抽到 topic-graph 里，可独立测试。
    const all = findRelated(lanes, similar, 0)
    const related = pickTopRelated(all, { floor: 0.08, ratio: 0.45, limit: 12 })

    payload.related = related
    if (payload.graph !== null && payload.graph !== undefined) {
      // 与已有边合并：重复调用时先剔掉旧的 related，避免越叠越多
      const base = Array.isArray(payload.graph.edges)
        ? payload.graph.edges.filter(e => e.kind !== 'related')
        : []
      payload.graph.edges = related.length === 0 ? base : [...base, ...related.map(r => ({
        kind: 'related',
        fromLaneId: r.a,
        toLaneId: r.b,
        score: r.score,
      }))]
    }
  } catch {
    payload.related = []
  }
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
  const reconciled = reconcileClassification(payload.turns, applied.lanes, sessionId)
  return {
    ...payload,
    lanes: reconciled.lanes,
    graph: buildGraph(payload.turns, reconciled.lanes),
    stages: reconciled.stages,
    unclassifiedTurns: reconciled.unclassifiedTurns,
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
 * DSH 的 home 目录，跨平台。
 *
 * 三种来源按优先级：
 *   1. DSH_HOME      —— 平台显式指定，最可靠
 *   2. USERPROFILE   —— Windows 默认
 *   3. HOME          —— Linux / macOS 默认
 *
 * 抽成一个函数是因为原先这段在三个地方各写了一遍（配置、分段、界面状态），
 * 改一处忘另外两处就会不一致——那种 bug 只在某个平台上才暴露。
 *
 * @returns 绝对路径，或 ''（无法确定）。
 */
function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  if (process.env.USERPROFILE) return join(process.env.USERPROFILE, '.dsh')
  if (process.env.HOME) return join(process.env.HOME, '.dsh')
  return ''
}

/**
 * 插件自己的数据目录。
 * @returns 绝对路径，或 null（无法确定 home）。
 */
function topicMapDir() {
  const home = dshHome()
  return home === '' ? null : join(home, 'topic-map')
}

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
  const dir = topicMapDir()
  return dir === null ? null : join(dir, 'config.json')
}

/**
 * 分段结果的存放目录。
 * @returns 绝对路径，或 null。
 */
function segmentsDir() {
  const dir = topicMapDir()
  return dir === null ? null : join(dir, 'segments')
}

/**
 * 界面状态的存放目录（任务状态的手动覆盖 + 筛选条件）。
 * @returns 绝对路径，或 null。
 */
function uiStateDir() {
  const dir = topicMapDir()
  return dir === null ? null : join(dir, 'ui')
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
/**
 * 在工作区内找一个可用的模型路由。
 *
 * 为什么不能只问第一个会话：工作区里的会话参差不齐，第一个可能是空的
 * （实测某工作区第一个会话只有 4 个事件）。要往后找，直到遇到真正用过模型的会话。
 *
 * @param ctx - Host context。
 * @param config - 插件配置。
 * @param sessionIds - 候选会话。
 * @returns `{ provider, model }` 或 null。
 */
async function resolveWorkspaceRoute(ctx, config, sessionIds) {
  if (config.provider !== '' && config.model !== '') {
    return { provider: config.provider, model: config.model }
  }
  const ids = Array.isArray(sessionIds) ? sessionIds : []
  // 只试前若干个：会话再多，模型路由也不会差太远，扫太多反而慢
  for (const sessionId of ids.slice(0, 8)) {
    try {
      const route = await resolveRoute(ctx, sessionId, config)
      if (route !== null) return route
    } catch {
      // 这个会话读不出来就试下一个
    }
  }
  return null
}

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
  // 合并步骤也要计入模型调用次数，所以 calls 必须在这里就可见。
  // （之前 calls 在后面才声明，合并段引用它会触发 TDZ 错误，
  //   导致整段合并逻辑被 catch 吞掉、merge 永远是 0 条。）
  let calls = 1
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

  // ── 话题相关性 ──────────────────────────────────────────────────
  //
  // "这两条线在讲同一类东西吗"——内容相似但各自独立成线。
  //
  // 与合并的区别：合并是"结构上就是同一条"（轮次重合），相关性是
  // "内容像但确实是两件事"。前者改变归属，后者只是提示。
  //
  // 相关性统一由 attachRelated 处理（相对阈值），这里不再算一份，
  // 避免"两个地方各有一套阈值"这种必然分叉的实现。
  let related = []

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
    // 合并信息：界面据此显示"这几条是合并来的"以及合并了多少
    merge: mergeInfo,
    // 话题相关性：内容相似但独立成线的两条，供界面画提示连线
    related,
    // 实际使用的通道：界面据此显示"自定义端点"或"已回退到会话模型"。
    via: usage.via,
    fellBack: usage.fellBack,
    fallbackReason: usage.fallbackReason,
    lanes: lanesWithPath,
  }

  // 用同一套相关性计算（相对阈值），保证 preview 与日常视图口径一致
  attachRelated(preview)
  // attachRelated 会把边塞进 preview.graph，但 preview 这里没有 graph；
  // 采纳时 rebuildWithCuts 会重新 buildGraph 并再次调用 attachRelated，
  // 所以这里只要 related 列表就够了。
  delete preview.graph

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
  const graph = buildGraph(base.turns, lanes)
  // 把相关性提示并进图的边集合：它没有方向，只是"这两条线内容像"。
  // 客户端据此画淡虚线，与 fork/merge 的实线区分开。
  if (Array.isArray(preview?.related) && preview.related.length > 0) {
    graph.edges = [...graph.edges, ...preview.related.map(r => ({
      kind: 'related',
      fromLaneId: r.a,
      toLaneId: r.b,
      score: r.score,
    }))]
  }
  const next = {
    ...base,
    lanes,
    graph,
    stages: Array.isArray(preview?.stages) ? preview.stages : [],
    twoLevel: preview?.twoLevel === true,
    hierarchyReason: preview?.hierarchyReason ?? null,
    // 相关性随采纳一起保留，否则采纳后图上的提示连线会消失
    related: Array.isArray(preview?.related) ? preview.related : [],
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
/**
 * 列出可切换的工作区。
 *
 * 顺序沿用 registry 的持久顺序（最近使用的在前），只暴露界面需要的字段。
 *
 * @param ctx - Host context。
 * @returns `[{ id, path, title, sessionCount }]`。
 */
function listWorkspaces(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return []
  try {
    return registry.list().map(w => ({
      id: w.id,
      path: w.path,
      title: w.title,
      sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : 0,
    }))
  } catch {
    return []
  }
}

/**
 * 解析要用的工作区：给了 id 就用它，否则取第一个（即"当前工作区"）。
 *
 * @param ctx - Host context。
 * @param workspaceId - 可选的 id。
 * @returns Workspace 或 undefined。
 */
function resolveWorkspace(ctx, workspaceId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  try {
    const all = registry.list()
    if (all.length === 0) return undefined
    if (typeof workspaceId === 'string' && workspaceId !== '') {
      return all.find(w => w.id === workspaceId) ?? all[0]
    }
    return all[0]
  } catch {
    return undefined
  }
}

/**
 * 把一个工作区的会话整理成列表。
 *
 * 只读标题，不读日志正文——这是"秒开"的关键。首轮提问与轮次数按需读，
 * 且用很小的预算，因为整份列表可能有一百多条。
 *
 * @param ctx - Host context。
 * @param cache - 会话缓存（已算过的直接复用轮次数）。
 * @param workspaceId - 工作区 id。
 * @returns `{ workspace, sessions }`。
 */
async function listWorkspaceSessions(ctx, cache, workspaceId) {
  const workspace = resolveWorkspace(ctx, workspaceId)
  if (workspace === undefined) return { workspace: null, sessions: [] }

  const ids = [...(workspace.sessionIds ?? [])]

  // 批量读标题（平台已提供批量接口，一次读全部）
  const titles = new Map()
  if (ids.length > 0 && typeof ctx.sessionQuery.readTitleSnapshots === 'function') {
    try {
      for (const item of await ctx.sessionQuery.readTitleSnapshots(ids)) {
        if (item.status === 'fulfilled' && item.value.title !== undefined) {
          titles.set(item.sessionId, item.value.title.title)
        }
      }
    } catch {
      // 标题是展示用的，读不到就退回 id
    }
  }

  const sessions = []
  for (const sessionId of ids) {
    // cache 可能为 null（归类时不需要缓存），要能安全跳过
    const cached = cache === null || cache === undefined ? undefined : cache.peek(sessionId)
    sessions.push({
      sessionId,
      title: titles.get(sessionId) ?? sessionId,
      turns: cached?.totals.turns ?? null,
      tokens: cached === null || cached === undefined
        ? null
        : cached.totals.input + cached.totals.output,
    })
  }

  return {
    workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
    sessions,
  }
}

/**
 * 让模型把一个工作区的会话归成「大类 → 子类」。
 *
 * 结果落盘缓存：归类不常变，而一次调用要发上百条会话描述，不该反复花。
 *
 * @param ctx - Host context。
 * @param workspaceId - 工作区 id。
 * @param force - 是否强制重算。
 * @param signal - 取消信号。
 * @returns `{ status, tree, ... }`。
 */
async function categorizeSessions(ctx, workspaceId, force, signal) {
  const workspace = resolveWorkspace(ctx, workspaceId)
  if (workspace === undefined) {
    return { status: 'unavailable', reason: '没有工作区', tree: [] }
  }

  const cachePath = categoryCachePath(workspace.id)

  // 命中缓存：除非强制重算
  if (!force && cachePath !== null) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (cached && Array.isArray(cached.tree) && Array.isArray(cached.sessionIds)) {
        // 会话集合必须一致才算命中：新增了会话就该重算
        const now = [...(workspace.sessionIds ?? [])].map(String).sort().join(',')
        const then = cached.sessionIds.map(String).sort().join(',')
        if (now === then) {
          return {
            status: 'ready',
            cached: true,
            workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
            tree: cached.tree,
            total: cached.sessionIds.length,
            categorizedAt: cached.categorizedAt ?? 0,
          }
        }
      }
    } catch {
      // 缓存读不出来就重新算
    }
  }

  // 收集会话描述：标题 + 首轮提问（小预算）
  const list = await listWorkspaceSessions(ctx, null, workspace.id)
  const raw = []
  for (const s of list.sessions) {
    let firstPrompt = ''
    try {
      const events = await readEvents(ctx, s.sessionId)
      const model = buildTurnModel(events)
      if (model.turns.length > 0) {
        firstPrompt = model.turns[0].prompt ?? ''
        s.turns = model.totals.turns
      }
    } catch {
      // 单个会话读不出来不影响整体
    }
    raw.push({ sessionId: s.sessionId, title: s.title, firstPrompt, turns: s.turns ?? 0 })
  }

  const items = prepareSessions(raw)

  // 调模型
  const llm = ctx.get('llm')
  const config = readConfig()
  const custom = hasCustomEndpoint(config)
  const route = await resolveWorkspaceRoute(ctx, config, workspace.sessionIds ?? [])

  if (!custom && (llm === undefined || route === null)) {
    return {
      status: 'unavailable',
      reason: '没有可用的模型',
      tree: fallbackTree(items),
      total: items.length,
    }
  }

  let text = null
  let via = 'session'
  try {
    const prompt = buildCategoryPrompt(items)
    if (custom) {
      try {
        text = await callRemote({ fetch }, config, prompt.system, prompt.user, {
          maxTokens: Math.max(400, items.length * 20),
          signal,
        })
        via = 'custom'
      } catch {
        via = 'session'
      }
    }
    if (text === null) {
      if (llm === undefined || route === null) throw new Error('no model available')
      text = await askOnce(llm, route, prompt.system, prompt.user, signal, {
        maxTokens: Math.max(400, items.length * 20),
      })
    }
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
      tree: fallbackTree(items),
      total: items.length,
    }
  }

  const labels = parseCategories(text, items.length)
  if (labels === null) {
    return {
      status: 'partial',
      reason: '模型输出不是可用的归类数组',
      tree: fallbackTree(items),
      total: items.length,
    }
  }

  const tree = buildCategoryTree(items, labels)
  const categorizedAt = Date.now()

  // 落盘
  await writeCategoryCache(cachePath, {
    sessionIds: items.map(i => i.id),
    tree,
    categorizedAt,
  })

  return {
    status: 'ready',
    cached: false,
    via,
    workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
    tree,
    total: items.length,
    categorizedAt,
    automated: items.filter(i => i.automated).length,
  }
}

/**
 * 跨会话全文检索。
 *
 * 实测发现：本部署的 `sessionQuery` 配置了 `openAt: "never"`，
 * `searchSessions` 直接报 "session search is disabled"。所以不能依赖平台索引，
 * 改为**自己扫日志**。
 *
 * 代价与取舍：
 *   - 只扫标题与轮次文本，不扫全部事件（工具结果那些太大且没意义）
 *   - 逐会话读、命中就停在该会话，不预读全部
 *   - 结果按会话聚合并按时间倒序，符合"最近提过的先看到"
 *
 * @param ctx - Host context。
 * @param workspaceId - 工作区。
 * @param query - 关键字。
 * @param limit - 条数。
 * @returns `{ status, hits }`。
 */
async function findAcrossSessions(ctx, workspaceId, query, limit) {
  const q = String(query ?? '').trim()
  if (q === '') return { status: 'ready', query: '', hits: [] }

  const workspace = resolveWorkspace(ctx, workspaceId)
  if (workspace === undefined) return { status: 'unavailable', reason: '没有工作区', hits: [] }

  const ids = [...(workspace.sessionIds ?? [])]
  const needle = q.toLowerCase()
  const maxHits = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 20

  // 标题先读，快且能覆盖很大一部分搜索需求
  const titles = new Map()
  try {
    for (const t of await ctx.sessionQuery.readTitleSnapshots(ids)) {
      if (t.status === 'fulfilled' && t.value.title !== undefined) {
        titles.set(t.sessionId, t.value.title.title)
      }
    }
  } catch { /* 标题可选 */ }

  const hits = []

  for (const sessionId of ids) {
    if (hits.length >= maxHits) break

    const title = titles.get(sessionId) ?? sessionId
    const titleHit = String(title).toLowerCase().includes(needle)

    let events
    try {
      events = await readEvents(ctx, sessionId)
    } catch {
      continue      // 读不出来的会话跳过，不影响其它
    }

    let model
    try {
      model = buildTurnModel(events)
    } catch {
      continue
    }

    let got = false
    for (const turn of model.turns) {
      if (hits.length >= maxHits) break
      const prompt = String(turn.prompt ?? '')
      const response = String(turn.response ?? '')
      const inPrompt = prompt.toLowerCase().includes(needle)
      const inResponse = response.toLowerCase().includes(needle)
      if (!inPrompt && !inResponse && !titleHit) continue

      // 取命中位置的上下文，比整段更有用
      const source = inPrompt ? prompt : response
      const at = source.toLowerCase().indexOf(needle)
      const from = Math.max(0, at - 30)
      const snippet = at < 0
        ? (prompt.slice(0, 120) || response.slice(0, 120))
        : source.slice(from, Math.min(source.length, at + needle.length + 90))

      hits.push({
        sessionId,
        title,
        turn: turn.turn,
        seq: turn.startSeq ?? null,
        type: inPrompt ? 'prompt' : 'response',
        snippet: snippet.replace(/\s+/g, ' ').slice(0, 200),
        time: turn.startTime ?? null,
      })
      got = true
      // 一个会话只报第一条命中，避免一个长会话刷满列表
      break
    }

    // 标题命中但正文没命中时也报一条
    if (!got && titleHit && hits.length < maxHits) {
      hits.push({
        sessionId,
        title,
        turn: null,
        seq: null,
        type: 'title',
        snippet: title,
        time: null,
      })
    }
  }

  // 有时间的按时间倒序，没时间的排后面
  hits.sort((a, b) => (b.time ?? 0) - (a.time ?? 0))

  return {
    status: 'ready',
    query: q,
    workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
    hits,
    total: hits.length,
    scanned: ids.length,
  }
}

/**
 * 归类缓存的落盘路径。
 * @param workspaceId - 工作区 id。
 * @returns 绝对路径，或 null。
 */
function categoryCachePath(workspaceId) {
  const dir = uiStateDir()
  if (dir === null) return null
  const safe = String(workspaceId).replace(/[^A-Za-z0-9._-]/g, '_')
  return join(dir, 'workspace-category-' + safe + '.json')
}

/**
 * 写归类缓存。
 * @param path - 路径。
 * @param data - 内容。
 */
async function writeCategoryCache(path, data) {
  if (path === null) return
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8')
  } catch {
    // 写不进去只影响"下次是否重算"
  }
}

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
