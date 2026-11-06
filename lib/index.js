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
import { ENGINE_VERSION, assignLanes, jaccard, lanesFromAssignment, tokenize } from './lane-engine.js'
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
  applyDigest,
  buildDigestPrompt,
  parseDigest,
  prepareDigestInput,
  toCategoryInput,
} from './session-digest.js'
import {
  buildCategoryPrompt,
  canReuseCategoryCache,
  buildCategoryTree,
  buildRenamePrompt,
  collectNames,
  fallbackTree,
  mergeBatchTrees,
  parseCategories,
  parseRenameMap,
  prepareSessions,
  splitIntoBatches,
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
          result = await categorizeSessions(ctx, body?.workspaceId, body?.force === true, controller.signal, body?.activeSessionId)
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
 * 取一组轮次的提问摘要，供左栏搜索使用。
 *
 * 与 payload.js 里的 attachTurnTexts 同一个思路（预算一致），但这里要按
 * "合并后的轮次"重算——精细分析会把多轮并进同一话题，旧的 turnTexts 就不对了。
 *
 * @param turnNos - 轮次号数组。
 * @param facts - 轮次事实数组。
 * @returns 摘要数组（可能为空数组）。
 */
function collectTurnTexts(turnNos, facts) {
  const list = Array.isArray(turnNos) ? turnNos : []
  const all = Array.isArray(facts) ? facts : []
  const byTurn = new Map()
  for (const f of all) byTurn.set(Number(f.turn), f)

  const TURN_LIMIT = 8
  const TEXT_BUDGET = 80
  const out = []
  for (const n of list.slice(0, TURN_LIMIT)) {
    const fact = byTurn.get(Number(n))
    if (fact === undefined) continue
    const raw = String(fact.prompt ?? '').replace(/\s+/g, ' ').trim()
    if (raw === '') continue
    out.push(raw.length <= TEXT_BUDGET ? raw : raw.slice(0, TEXT_BUDGET - 1) + '…')
  }
  return out
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
  // 已采纳的分层也要补 turnTexts：这些泳道的轮次与本地规则不同，
  // 不补的话左栏搜索对"精细分析后的话题"搜不到内容。
  const lanesWithTexts = reconciled.lanes.map(lane => {
    const texts = collectTurnTexts(lane.turns, payload.turns)
    return texts.length === 0 ? lane : { ...lane, turnTexts: texts }
  })
  return {
    ...payload,
    lanes: lanesWithTexts,
    graph: buildGraph(payload.turns, lanesWithTexts),
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
    // 归类分批大小：一次让模型归太多会话，输出容易错位（长度校验会整批作废）。
    // 默认 100，按批归完后再合并各批的大类名。
    categoryBatch: Number.isFinite(c.categoryBatch) && c.categoryBatch >= 10
      ? Math.min(500, Math.floor(c.categoryBatch))
      : 100,
    // 归类上限：超过就提示用户先筛选，而不是硬归。
    categoryLimit: Number.isFinite(c.categoryLimit) && c.categoryLimit >= 50
      ? Math.min(10000, Math.floor(c.categoryLimit))
      : 1000,
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
    categoryBatch: Number.isFinite(body?.categoryBatch) && body.categoryBatch >= 10
      ? Math.min(500, Math.floor(body.categoryBatch))
      : 100,
    categoryLimit: Number.isFinite(body?.categoryLimit) && body.categoryLimit >= 50
      ? Math.min(10000, Math.floor(body.categoryLimit))
      : 1000,
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
    // 预算要给足：每轮一个标签（可能带引号与逗号，约 8-14 token），
    // 再留出模型在正式回答前的推理开销。早先按 16/轮算得太紧，
    // 换成带推理的模型后输出会被截断，解出来不是合法数组。
    const text = await askModel(system, user, Math.max(8192, windowTurns.length * 80))
    labels = parseAssignment(text, windowTurns.length)
    if (labels === null) {
      // 带上原始输出片段，便于诊断"模型到底返回了什么"
      failure = '模型输出不是可用的标签数组（长度或格式不符）；原文前 300 字：'
        + String(text ?? '').slice(0, 300)
    }
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
        const text = await askModel(prompt.system, prompt.user, Math.max(4096, pairs.length * 80))
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

  // 层级归并（任务 → 工作流 → 阶段）已按需求删除。
  //
  // 那两步的结果是为左栏三层树服务的，而现在左栏改成跨会话分类列表，
  // 会话内部的三层树已经没有地方展示。保留它们只是白烧 2 次模型调用
  // 和约 20 秒等待。
  //
  // 现在只保留单层：每个分段就是一个话题，不再往上归并。

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
      // 轮次提问摘要：合并后的泳道轮次与本地规则不同，必须在这里重算一次，
      // 否则左栏搜索对"精细分析后的话题"搜不到内容。
      turnTexts: collectTurnTexts(lane.turns, base.turns),
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
    return registry.list().map(w => {
      const ids = Array.isArray(w.sessionIds) ? [...w.sessionIds] : []
      return {
        id: w.id,
        path: w.path,
        title: w.title,
        sessionCount: ids.length,
        // 前端靠它反查"当前会话属于哪个工作区"，从而把默认选中项落到正确位置。
        // 之前没返回这个字段，前端只能取 registry 第一个——那常常不是
        // 当前会话所在的工区，一打开就看到别人的内容，以为切换失灵。
        sessionIds: ids.map(String),
      }
    })
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

  // ── 读 header：拿 origin / formatStatus 这些权威标记 ──
  //
  // 为什么必须用 header 而不是靠标题文字猜：平台在 SessionHeader 里明确
  // 标了 `origin: 'subagent'`。正则匹配 "dsh-mnemon" 只能识别一种委派方式，
  // 换个委派流程就漏；formatStatus 还能标出格式不兼容的会话。
  const headers = new Map()
  try {
    if (typeof ctx.sessionQuery.listSessions === 'function') {
      const records = await ctx.sessionQuery.listSessions()
      for (const rec of Array.isArray(records) ? records : []) {
        const id = String(rec?.header?.id ?? '')
        if (id !== '') headers.set(id, rec.header)
      }
    }
  } catch {
    // 拿不到 header 就退化为"全部正常"，不影响列表本身
  }

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
  let hidden = 0
  for (const sessionId of ids) {
    // cache 可能为 null（归类时不需要缓存），要能安全跳过
    const cached = cache === null || cache === undefined ? undefined : cache.peek(sessionId)

    // 格式不兼容的会话跳过：读出来也是错的
    const header = headers.get(sessionId)
    if (header !== undefined && header.formatStatus === 'migration-required') {
      hidden += 1
      continue
    }

    // 轮次数：缓存优先，否则用 listEvents 轻量数
    let turns = cached === undefined ? null : cached.totals.turns
    if (turns === null) turns = await countTurns(ctx, sessionId)

    // 空会话（0 轮）默认不显示：实测有"新建未使用"的会话，
    // 点进去只有"还没有任何对话"，对浏览没有价值。
    if (turns === 0) {
      hidden += 1
      continue
    }

    sessions.push({
      sessionId,
      title: titles.get(sessionId) ?? sessionId,
      turns,
      tokens: cached === null || cached === undefined
        ? null
        : cached.totals.input + cached.totals.output,
      // 平台权威标记：origin 比正则匹配可靠得多
      subagent: header !== undefined && header.origin === 'subagent',
      delegationDepth: Number.isFinite(header?.delegationDepth) ? header.delegationDepth : 0,
      createdAt: Number.isFinite(header?.createdAt) ? header.createdAt : null,
    })
  }

  return {
    workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
    sessions,
    total: ids.length,
    hidden,
  }
}

/**
 * 数一个会话的轮次数。
 *
 * 优先 listEvents（轻量记录，只数 turn/start），失败才退到 readSession。
 * 读不出来返回 null，不当作 0——0 会被过滤掉，那等于把坏数据藏起来。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话。
 * @returns 轮次数或 null。
 */
/**
 * 用实时轮数刷新归类树里的 turns 数字。
 *
 * 缓存保存的是"分类结构"，但会话会继续增长。不刷新的话，
 * 左栏显示 60 轮、点进去却是 71 个节点，数字自相矛盾。
 *
 * 只改 turns 字段，不动分类结构——分类仍然是缓存里那份，
 * 这样既保证数字准确，又不需要重跑模型。
 *
 * @param ctx - Host 上下文。
 * @param tree - 归类树。
 * @returns 刷新后的新树（不修改入参）。
 */
async function refreshTurnCounts(ctx, tree, onlySessionId) {
  const list = Array.isArray(tree) ? tree : []

  // 收集要刷新的会话 id。
  //
  // 只刷"当前正在看的那个"：实测并行数 32 个会话的 listEvents 要 4.2 秒，
  // 而缓存命中本来是 2ms —— 每次打开面板等 4 秒不可接受。
  // 其它会话基本不再增长（用户不会再往里说话），当前会话才是数字会变的那一个。
  //
  // 传 onlySessionId 为空表示全量刷新（低频兜底用）。
  const ids = []
  for (const cat of list) {
    for (const sub of cat.subcategories ?? []) {
      for (const sess of sub.sessions ?? []) {
        if (sess === null || sess === undefined || sess.sessionId === undefined) continue
        const id = String(sess.sessionId)
        if (onlySessionId !== null && onlySessionId !== undefined && String(onlySessionId) !== ''
          && id !== String(onlySessionId)) continue
        ids.push(id)
      }
    }
  }
  if (ids.length === 0) return list

  // 并行计数：listEvents 只读事件类型与序号，比 readEvents 轻得多
  const counts = new Map()
  await Promise.all(ids.map(async (id) => {
    try {
      const n = await countTurns(ctx, id)
      if (n !== null && Number.isFinite(n)) counts.set(id, n)
    } catch { /* 单个失败就沿用缓存值 */ }
  }))

  // 重建树，只替换 turns
  return list.map(cat => ({
    ...cat,
    subcategories: (cat.subcategories ?? []).map(sub => ({
      ...sub,
      sessions: (sub.sessions ?? []).map(sess => {
        const n = counts.get(String(sess.sessionId))
        return n === undefined ? sess : { ...sess, turns: n }
      }),
    })),
  }))
}

async function countTurns(ctx, sessionId) {
  try {
    if (typeof ctx.sessionQuery.listEvents === 'function') {
      const events = await ctx.sessionQuery.listEvents(sessionId)
      if (Array.isArray(events)) {
        let n = 0
        for (const ev of events) if (ev !== null && ev.type === 'turn/start') n += 1
        return n
      }
    }
  } catch {
    // 落到下一条路
  }
  try {
    const model = buildTurnModel(await readEvents(ctx, sessionId))
    return model.turns.length
  } catch {
    return null
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
async function categorizeSessions(ctx, workspaceId, force, signal, activeSessionId) {
  const workspace = resolveWorkspace(ctx, workspaceId)
  if (workspace === undefined) {
    return { status: 'unavailable', reason: '没有工作区', tree: [] }
  }

  const cachePath = categoryCachePath(workspace.id)

  // ── 命中缓存判定 ──
  //
  // 判据不是"集合完全相等"，而是"缓存里的每个会话**现在都还在**"。
  //
  // 为什么不能要求相等：会话集合里混着空会话（新建未使用、0 轮），
  // 它们在归类时会被过滤掉（不占用归类名额）。如果比对用未过滤的集合，
  // 那么每出现一个空会话就会让缓存永远失效 —— 实测因此导致每次打开
  // 面板都要重跑一次模型（25-30 秒），用户看到的就是"切页面回来空白一会儿"。
  //
  // 现在改为"缓存里的都还在就算命中"。新增的会话只要还没进缓存，
  // 就会被下面的 superset 判断捕获并触发重算，不会漏掉新对话。
  if (!force && cachePath !== null) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
      if (cached && Array.isArray(cached.tree) && Array.isArray(cached.sessionIds)) {
        // 判定逻辑抽成纯函数（可独立测试）：见 session-category.canReuseCategoryCache
        //
        // 不传 tolerance = 不限新增数量：新会话一律先进「未归类」组，
        // 只有用户点「归类」才调模型。早先容错值只有 3，新建四五个会话
        // 就会让缓存失效、下次打开面板突然等 30-40 秒。
        if (canReuseCategoryCache(cached.sessionIds, workspace.sessionIds ?? [])) {
          // 命中缓存，但可能有新会话还没进分类。把它们单独列出来，
          // 让界面显示「未归类（N）」并给一个归类按钮——
          // 直接静默复用缓存会让新会话"消失"在列表里。
          const known = new Set(cached.sessionIds.map(String))
          const fresh = []
          for (const id of (workspace.sessionIds ?? [])) {
            if (known.has(String(id))) continue
            fresh.push(String(id))
          }
          // 取标题（轻量，只读 title 事件）
          const freshTitles = new Map()
          if (fresh.length > 0) {
            try {
              for (const t of await ctx.sessionQuery.readTitleSnapshots(fresh)) {
                if (t.status === 'fulfilled' && t.value.title !== undefined) {
                  freshTitles.set(t.sessionId, t.value.title.title)
                }
              }
            } catch { /* 标题可选 */ }
          }
          // 过滤掉空会话（0 轮）。
          //
          // 空会话（新建后没用过）会出现在工作区的 sessionIds 里，但它
          // 没有任何轮次可展示。如果把它列进「未归类」，用户点开看到的是
          // 一片空白，会以为功能坏了。
          const nonEmpty = []
          for (const id of fresh) {
            try {
              const n = await countTurns(ctx, id)
              if (n !== null && n > 0) nonEmpty.push({ sessionId: id, turns: n })
            } catch { /* 读不出来就先带上 */ nonEmpty.push({ sessionId: id, turns: null }) }
          }
          return {
            status: 'ready',
            cached: true,
            workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
            // 用实时轮数刷新树里的数字。
            //
            // 为什么必须刷：缓存是"分类结构"的快照，但会话一直在增长。
            // 实测某会话缓存时 60 轮、实际已 71 轮 —— 左栏显示 60、
            // 点进去看到 71 个节点，数字对不上，用户会以为"数据错了"。
            //
            // 用 countTurns（内部走 listEvents，只读事件类型不读正文）
            // 而不是 readEvents，几十个会话的刷新开销远小于重跑归类。
            tree: await refreshTurnCounts(ctx, cached.tree, activeSessionId),
            total: cached.sessionIds.length,
            categorizedAt: cached.categorizedAt ?? 0,
            // 提炼结果一并返回：列表摘要与搜索都用它
            digests: cached.digests !== undefined && cached.digests !== null ? cached.digests : {},
            // 未归类：界面据此渲染置顶的「未归类」组
            uncategorized: nonEmpty.map(item => ({
              ...item,
              title: freshTitles.get(item.sessionId) ?? item.sessionId,
            })),
          }
        }
      }
    } catch {
      // 缓存读不出来就重新算
    }
  }

  // 收集会话：标题 + 完整轮次（提炼步骤要用轮次摘要，不只是首轮）
  //
  // 为什么要读完整轮次：提炼一句话主题需要看对话的演变过程。
  // 代价是每个会话要读一次日志（约 1 秒），但这只在缓存失效时发生一次，
  // 之后都走缓存。而且提炼结果会落盘，第二次连日志都不用读。
  const list = await listWorkspaceSessions(ctx, null, workspace.id)
  const raw = []
  for (const s of list.sessions) {
    let facts = []
    let laneCount = 0
    try {
      const events = await readEvents(ctx, s.sessionId)
      const model = buildTurnModel(events)
      facts = model.turns
      s.turns = model.totals.turns
      // 顺便算分段数（泳道数）。
      //
      // 左栏「对话」那层要显示"N 段 · M 轮"，段数只能靠本地分段得出。
      // assignLanes 是纯本地计算，实测 73 轮约 60ms —— 归类本来就要
      // 读日志（约 1 秒/会话），搭车算这个几乎不增加耗时。
      // 算出来存进缓存，之后就无需重算。
      try {
        laneCount = assignLanes({ turns: facts, sessionId: s.sessionId }).length
      } catch { /* 单个失败就当 0 段 */ }
    } catch {
      // 单个会话读不出来不影响整体
    }
    raw.push({
      sessionId: s.sessionId,
      title: s.title,
      turns: s.turns ?? 0,
      laneCount,
      facts,
      // 平台标记透传：looksAutomated 优先看它，拿不到才退回正则
      origin: s.subagent ? 'subagent' : undefined,
      delegationDepth: s.delegationDepth ?? 0,
    })
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

  /** 统一的模型调用：自定义端点优先，失败回退会话模型。 */
  async function ask(system, user, maxTokens) {
    if (custom) {
      try {
        const t = await callRemote({ fetch }, config, system, user, { maxTokens, signal })
        return { text: t, via: 'custom' }
      } catch {
        // 回退
      }
    }
    if (llm === undefined || route === null) throw new Error('no model available')
    const t = await askOnce(llm, route, system, user, signal, { maxTokens })
    return { text: t, via: 'session' }
  }

  // ── 第一阶段：提炼每个会话的一句话主题 ──
  //
  // 为什么先提炼再分类：
  //   直接让模型"给 32 个会话分组"，它要同时理解每个会话 + 分组，
  //   容易被打面词汇带偏（都提到"插件"就归一类，其实一个是开发一个是调研）。
  //   先压成一句话，第二步只看这 32 句话分类，信息密度高、噪声少。
  //
  // 副产品：这句话本身就是好的列表摘要与搜索素材。
  let digested = null
  const digestFailures = []
  try {
    const digestInput = raw.map(r => prepareDigestInput({
      sessionId: r.sessionId,
      title: r.title,
      turns: r.facts,
      // 段数要一路透传到树里（左栏「对话」显示"N 段 · M 轮"）
      laneCount: r.laneCount,
    }))

    // 分批提炼：和分类一样，一次太多会错位
    const dgBatch = config.categoryBatch ?? 100
    const dgBatches = splitIntoBatches(digestInput, dgBatch)
    const allDigests = []
    let digestOk = true

    for (let bi = 0; bi < dgBatches.length; bi += 1) {
      const slice = dgBatches[bi]
      try {
        const prompt = buildDigestPrompt(slice)
        const answer = await ask(prompt.system, prompt.user, Math.max(6144, slice.length * 80))
        const parsed = parseDigest(answer.text, slice.length)
        if (parsed === null) {
          digestFailures.push(`提炼第 ${bi + 1} 批：输出不可用`)
          digestOk = false
          break
        }
        allDigests.push(...parsed)
      } catch (error) {
        digestFailures.push(`提炼第 ${bi + 1} 批：${error instanceof Error ? error.message : String(error)}`)
        digestOk = false
        break
      }
    }

    if (digestOk) {
      digested = applyDigest(digestInput, allDigests)
    }
  } catch (error) {
    digestFailures.push(`提炼失败：${error instanceof Error ? error.message : String(error)}`)
  }

  // 提炼成功就用它作为分类输入（信息密度高、噪声少）；
  // 提炼失败退回原始描述（标题 + 首轮），保证功能不中断。
  const categoryInput = digested !== null ? toCategoryInput(digested) : items

  // ── 上限检查 ──
  //
  // 会话太多时不硬归：一是成本高，二是模型一次输出几百条容易错位。
  // 明确告诉界面"请先筛选"，而不是给一个可能出错的结果。
  const limit = config.categoryLimit ?? 1000
  if (items.length > limit) {
    return {
      status: 'too-many',
      reason: `会话数 ${items.length} 超过上限 ${limit}，请先按时间或关键字筛选`,
      tree: [],
      total: items.length,
      limit,
    }
  }

  // ── 分批归类 ──
  //
  // 每批独立调一次模型。为什么分批：一次给 500 个会话，模型容易漏条或错位，
  // 而本实现严格校验长度，错位就整批作废。分批后某批失败只丢那一批。
  const batchSize = config.categoryBatch ?? 100
  const batches = splitIntoBatches(categoryInput, batchSize)
  const batchTrees = []
  let via = 'session'
  let calls = 0
  const failures = []

  for (let bi = 0; bi < batches.length; bi += 1) {
    const slice = batches[bi]
    let text = null
    try {
      const prompt = buildCategoryPrompt(slice)
      const answer = await ask(prompt.system, prompt.user, Math.max(8192, slice.length * 60))
      text = answer.text
      via = answer.via
      calls += 1
    } catch (error) {
      failures.push(`第 ${bi + 1} 批：${error instanceof Error ? error.message : String(error)}`)
      batchTrees.push(fallbackTree(slice))
      continue
    }

    const labels = parseCategories(text, slice.length)
    if (labels === null) {
      failures.push(`第 ${bi + 1} 批：输出不是可用的归类数组`)
      batchTrees.push(fallbackTree(slice))
      continue
    }
    batchTrees.push(buildCategoryTree(slice, labels))
  }

  // ── 合并各批：先把大类名归一 ──
  //
  // 各批独立归类时，同一件事可能被起了不同名字（"插件开发" / "插件研发"）。
  // 最后再调一次模型把名字合成一套，否则列表里会出现一堆近义大类。
  let tree = mergeBatchTrees(batchTrees, null)
  let renamed = false

  if (batchTrees.length > 1) {
    try {
      const names = collectNames(batchTrees)
      if (names.categories.length > 1) {
        const p = buildRenamePrompt(names.categories, 'category')
        const answer = await ask(p.system, p.user, Math.max(2048, names.categories.length * 40))
        calls += 1
        const map = parseRenameMap(answer.text, names.categories.length, names.categories)
        if (map !== null) {
          tree = mergeBatchTrees(batchTrees, map)
          renamed = true
        }
      }
    } catch {
      // 归一失败就用原名，不影响结果可用性
    }
  }

  const categorizedAt = Date.now()

  // 提炼结果单独整理成 id → { topic, keywords }，供列表摘要与搜索使用。
  // 它是"理解这段对话在做什么"的产物，比原始首轮提问可读得多。
  const digests = {}
  if (digested !== null) {
    for (const d of digested) {
      digests[d.id] = { topic: d.topic, keywords: d.keywords }
    }
  }

  // 全部批次都失败时**不要落盘**。
  //
  // 这时 tree 是 fallbackTree 的结果（所有会话塞进"未归类/真实对话"）。
  // 写进去的后果很严重：下次打开看到的就是这个降级树，而且
  // canReuseCategoryCache 会认为它有效、一直复用 —— 模型只是临时不可用，
  // 分类结果却被永久降级了。
  //
  // 保留旧缓存（若有）比写入降级结果好：用户至少还能看到上次的正确分类。
  const allFailed = batches.length > 0 && failures.length >= batches.length
  if (!allFailed) {
    // 落盘（含提炼结果：下次连日志都不用读就能显示摘要）
    await writeCategoryCache(cachePath, {
      sessionIds: items.map(i => i.id),
      tree,
      digests,
      categorizedAt,
    })
  }

  return {
    status: 'ready',
    cached: false,
    via,
    workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
    tree,
    total: items.length,
    categorizedAt,
    // 每个会话的一句话主题 + 关键词（提炼阶段产物）
    digests,
    digestFailures,
    automated: items.filter(i => i.automated).length,
    // 分批信息：界面可提示"分 3 批归类，1 批失败"
    batches: batches.length,
    calls,
    renamed,
    failures,
    // 全部批次失败（模型不可用）：此时 tree 是降级结果，且没有落盘。
    // 界面据此提示"分类暂时不可用"，而不是把降级树当成正常分类展示。
    degraded: allFailed,
    cacheKept: allFailed,
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
/**
 * 会话检索缓存：sessionId → { at, turns }。
 *
 * 为什么需要：检索要逐会话读完整日志，实测 33 个会话约 8 秒。
 * 用户是"边打字边搜"的，每次改一个字都重读一遍完全不可接受。
 *
 * 存"轮次摘要数组"而不只是拼好的正文：命中之后还要给出片段
 * （第几轮、提问还是回复、上下文）。若只存文本，命中路径还得再读一次
 * 日志，缓存就白做了。
 *
 * 过期策略用时间而非内容指纹：确认内容是否变化本身就要读日志，
 * 那就失去缓存的意义了。60 秒足够覆盖一轮"输入 → 看结果 → 改词"。
 */
const FIND_TEXT_TTL_MS = 60 * 1000
const findTextCache = new Map()

/** 取一个会话的轮次摘要（命中缓存则直接返回）。 */
async function sessionTurnsOf(ctx, sessionId) {
  const now = Date.now()
  const cached = findTextCache.get(sessionId)
  if (cached !== undefined && now - cached.at < FIND_TEXT_TTL_MS) return cached.turns

  let events
  try {
    events = await readEvents(ctx, sessionId)
  } catch {
    return null      // 读不出来：不缓存，下次再试
  }
  let model
  try {
    model = buildTurnModel(events)
  } catch {
    return null
  }

  // 只留检索需要的字段，避免把整份日志常驻内存
  const turns = model.turns.map(t => ({
    turn: t.turn,
    prompt: String(t.prompt ?? ''),
    response: String(t.response ?? ''),
    startSeq: t.startSeq ?? null,
    startTime: t.startTime ?? null,
  }))
  findTextCache.set(sessionId, { at: now, turns })
  return turns
}

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

    // 走缓存取轮次：重复检索只做字符串扫描，不再重读日志
    const rows = await sessionTurnsOf(ctx, sessionId)
    if (rows === null) continue      // 读不出来的会话跳过
    // 先做一次整块预筛：没有命中就直接跳过，省掉逐轮扫描
    if (!titleHit) {
      let any = false
      for (const r of rows) {
        if (r.prompt.toLowerCase().includes(needle) || r.response.toLowerCase().includes(needle)) { any = true; break }
      }
      if (!any) continue
    }

    let got = false
    for (const turn of rows) {
      if (hits.length >= maxHits) break
      const prompt = turn.prompt
      const response = turn.response
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
    // 命中数达到上限说明还有更多没返回，界面要明确告诉用户"已截断"，
    // 否则看到 20 条会以为总共就这些。
    truncated: hits.length >= maxHits && ids.length > hits.length,
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
