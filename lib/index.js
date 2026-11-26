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

import { mkdir, open, readFile, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { ENGINE_VERSION, assignLanes, jaccard, lanesFromAssignment, tokenize } from './lane-engine.js'
import { buildSessionPayloadParts } from './payload.js'
import { buildTurnModel, emptyUsage } from './turn-model.js'
import {
  defaultSessionsDir,
  indexFilePath,
  buildTurnRows,
  messageText,
  readIndexFile,
  readIndexMeta,
  syncSessionIndex,
} from './turn-index.js'
import {
  assignSession,
  emptyStore,
  toTree,
  upsertCategory,
} from './category-store.js'
import { applyPlan, planOrganize, undoOrganize } from './organize.js'
import {
  AUTO_START_MAX_SESSIONS,
  COLD_START_BATCH_MAX,
  DAILY_MAINTENANCE_UNCLASSIFIED_THRESHOLD,
  STARTUP_SCAN_DELAY_MS,
  addAutoProcessedSessions,
  applyAutoClassification,
  applyColdStartBatch,
  applyMaintenanceSteps,
  buildMaintenancePrompt,
  carryLockedSessions,
  configureAutoClassify,
  createAutoStartThrottle,
  createDailyMaintenanceGate,
  createDiagnosticsLog,
  createNewCategorySupport,
  flushAutoClassifyQueue,
  isSessionLocked,
  isSessionUnclassified,
  listCategoryPaths,
  lockSession,
  normalizeAutoClassifyState,
  normalizeMaintenanceOps,
  parseMaintenanceOps,
  purgeEmptyCategories,
  queueAutoClassify,
  queueAutoClassifyNow,
  removeAutoProcessedSessions,
  resetModelCategories,
  runStartupScan,
} from './category-auto.js'
import { planRollback } from './rollback-plan.js'
import { buildChanges } from './changes-view.js'
import { DEFAULT_LIMIT as SEARCH_DEFAULT_LIMIT, searchTurns } from './search-index.js'
import { codeBlocksOf } from './code-blocks.js'
import { extractJsonArray } from './model-output.js'
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
import { buildSessionOutline } from './outline.js'
import { createForkEndpoints, createRetryDeduper } from './fork.js'
import { briefFileName, createBriefEndpoint } from './brief.js'
import { aggregateWorkspaceStats, localDayKey } from './workspace-stats.js'

/** Cordis plugin name. */
export const name = 'topic-map'

/**
 * Hard dependencies: without these there is nothing to read.
 *
 * `workspaceChanges` 必须声明：Cordis 的服务代理是严格模式，未 inject 的
 * 属性访问会直接抛 `cannot get property ... without inject`（不是返回
 * undefined），F-7 的 changes 落盘全靠它。声明成硬依赖比到处 try/catch
 * 干净；校验脚本会保证这个服务在宿主里确实存在。
 */
export const inject = ['sessionQuery', 'sessionPersistence', 'workspaceChanges']

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
  // 顺手清理过期缓存。不 await：启动路径上绝不能因为磁盘 I/O 变慢，
  // 而且清理失败也只是留下几个旧文件，不影响任何功能。
  pruneOldCache().catch(() => { /* 清理失败忽略 */ })
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

  // 引用指针的两个消费端：显式工具（模型主动调）与自动展开（wire 层注入）。
  // 都走可选作用域：宿主缺 tools/systemPrompt 时只少对应能力，插件照常启动。
  registerHistoryTurnTool(ctx)
  registerQuoteExpansion(ctx)
  // 「分类全自动」：队列、会话结束钩子、延迟 30 秒的启动扫描。
  // 放在最后：前面任何一步不可用都不影响自动归类自己降级（无模型就跳过）。
  installCategoryAuto(ctx)
}

/** Build the request handler bound to one cache instance. */
function routeHandler(ctx, cache, segments, progress, cancelFlag) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const action = url.pathname.slice(ROUTE_PREFIX.length + 1) || 'health'

      if (req.method === 'GET' && action === 'health') {
        // 统一走 { ok, value } 信封：早先这个端点把 engineVersion 放在顶层，
        // 是全网关唯一的例外，调用方得记两套形状。
        return sendJson(res, 200, { ok: true, value: { engineVersion: ENGINE_VERSION } })
      }

      if (req.method === 'POST' && action === 'session') {
        const body = await readJson(req)
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (sessionId === '') return sendJson(res, 400, { ok: false, error: 'sessionId required' })
        const payload = await buildSessionPayload(ctx, cache, sessionId, body?.force === true, segments)
        // P0-9 接线 (a)：会话打开即把索引落盘（含 F-7 的 changes）。
        // 排进后台队列、不 await：落盘失败或很慢都不影响本次响应。
        queueSessionIndexSync(ctx, sessionId)
        // 分类全自动：会话活动即记一次（60 秒防抖后自动归类），并检查
        // 今天是否该跑一次每日维护（每天至多一次，没触发就空转）。
        noteCategoryAutoActivity(ctx, { sessionId })
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
      //   /find        —— 跨会话全文检索（旧端点，形状不变）
      //   /search      —— 新检索端点：内核检索 + 过滤/分组 + 索引状态
      //   /index-build —— 索引维护/重建（设置页与排障用）
      //   /workspace-reindex —— 工作区一键补齐（全部会话排进后台队列）
      //   /session-commands  —— 会话命令清单（连续编号 + 分页）
      //   /turn-digest       —— 单轮摘要（引用摘要档，缓存按 endSeq）
      //   /expand-preview    —— 引用展开诊断（与真实注入同源）
      //   /labels      —— 状态标签读取（全量或单条）
      //   /label-set   —— 状态标签合并写入（三开关 + 备注）
      //   /label-clear —— 状态标签删除（整条清掉）
      //   /turn-detail —— 单轮详情：详情字段 + 前后邻居 + 标签（A-1 定位）
      //   /session-outline —— 会话窄大纲（历史轨；每轮一行，不含正文）
      //   /fork        —— 在第 N 轮之前分叉（宿主 atSeq 是 inclusive，故传 startSeq-1）
      //   /retry       —— 分叉后把第 N 轮的提问重新提交（同会话+同轮 5 分钟去重）
      //   /brief       —— 生成 Markdown 简报落盘（200KB 上限，末尾附命令清单）
      //   /stats       —— 工作区统计（活跃度为主、用量为辅）

      if (req.method === 'POST' && action === 'workspaces') {
        return sendJson(res, 200, { ok: true, value: listWorkspaces(ctx) })
      }

      if (req.method === 'POST' && action === 'sessions') {
        const body = await readJson(req)
        const result = await listWorkspaceSessions(ctx, cache, body?.workspaceId)
        noteCategoryAutoActivity(ctx, { workspaceId: body?.workspaceId })
        return sendJson(res, 200, { ok: true, value: result })
      }

      if (req.method === 'POST' && action === 'categorize') {
        const body = await readJson(req)
        // 旧的一键归类已下线：客户端改用 /category-suggest + /category-apply-suggestions。
        // 端点先保留一个版本（老客户端可能还在调），但明确标 deprecated，
        // 并把访问记进诊断日志，方便确认"还有谁在调旧路径"。
        recordDeprecatedCategorize()
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
        return sendJson(res, 200, { ok: true, value: { ...result, deprecated: true } })
      }

      if (req.method === 'POST' && action === 'find') {
        const body = await readJson(req)
        const result = await findAcrossSessions(ctx, body?.workspaceId, body?.query, body?.limit)
        return sendJson(res, 200, { ok: true, value: result })
      }

      // P0-3：新检索端点。接线层负责会话枚举、stamp 与索引/回退双数据源；
      // 检索口径（关键词/时间/过滤/分组/截断）在内核 lib/search-index.js。
      if (req.method === 'POST' && action === 'search') {
        const body = await readJson(req)
        const value = await searchWorkspaceIndex(ctx, body ?? {})
        return sendJson(res, 200, { ok: true, value })
      }

      // P0-9 接线 (b)：索引维护/重建入口。给设置页与排障用，显式调用，
      // 走完整校验（同 revision 也解析，损坏即自愈）。
      if (req.method === 'POST' && action === 'index-build') {
        const body = await readJson(req)
        const value = await buildSessionIndexes(ctx, body ?? {})
        return sendJson(res, 200, { ok: true, value })
      }

      // 一键补齐：把工作区全部会话排进后台索引队列，立即返回排队数。
      if (req.method === 'POST' && action === 'workspace-reindex') {
        const body = await readJson(req)
        const result = reindexWorkspace(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: { queued: result.queued } })
      }

      // 会话命令清单（复制浮窗）：全会话连续编号 + 分页。
      if (req.method === 'POST' && action === 'session-commands') {
        const body = await readJson(req)
        const result = await listSessionCommands(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 轮次摘要：引用摘要档的数据源；缓存按轮次 endSeq，force 可强制重算。
      if (req.method === 'POST' && action === 'turn-digest') {
        const body = await readJson(req)
        const result = await generateTurnDigest(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 引用展开诊断：与真实注入共用扫描/解析/摘要获取，只返回诊断信息。
      if (req.method === 'POST' && action === 'expand-preview') {
        const body = await readJson(req)
        const result = await previewExpansion(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // A-3：状态三开关 + 一行备注的 Host 半边。标签按工作区存
      // `~/.dsh/topic-map/index/labels/<workspaceId>.json`，与轮次事实层
      // 物理分离（F-4）；写入失败/文件损坏都要明确回错，不许静默。
      if (req.method === 'POST' && action === 'labels') {
        const body = await readJson(req)
        const result = await readWorkspaceLabels(body?.workspaceId, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: { labels: result.labels, count: result.count } })
      }

      if (req.method === 'POST' && action === 'label-set') {
        const body = await readJson(req)
        const result = await setWorkspaceLabel(body?.workspaceId, body?.sessionId, body?.turn, body?.patch)
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: { key: result.key, label: result.label } })
      }

      if (req.method === 'POST' && action === 'label-clear') {
        const body = await readJson(req)
        const result = await clearWorkspaceLabel(body?.workspaceId, body?.sessionId, body?.turn)
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: { removed: result.removed } })
      }

      // 单轮详情：点中一条命中后看"这一轮到底在干什么"。
      // 只回该会话该轮；索引命中不读日志，缺失才兜底且受超时保护。
      if (req.method === 'POST' && action === 'turn-detail') {
        const body = await readJson(req)
        const result = await readTurnDetail(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 历史轨：整个会话的窄大纲（每轮一行，不含正文）。
      if (req.method === 'POST' && action === 'session-outline') {
        const body = await readJson(req)
        const result = await readSessionOutline(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 历史管理：在第 N 轮之前分叉（宿主 sessionController.fork）。
      if (req.method === 'POST' && action === 'fork') {
        const body = await readJson(req)
        const result = await forkSession(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 历史管理：分叉后把第 N 轮的提问重新提交（5 分钟去重）。
      if (req.method === 'POST' && action === 'retry') {
        const body = await readJson(req)
        const result = await retryTurn(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 历史管理：生成 Markdown 简报落盘（200KB 上限）。
      if (req.method === 'POST' && action === 'brief') {
        const body = await readJson(req)
        const result = await createSessionBrief(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 工作区统计：活跃度为主、用量为辅。
      if (req.method === 'POST' && action === 'stats') {
        const body = await readJson(req)
        const result = await readWorkspaceStats(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 索引体积：设置页「12 个会话 · 3.2 MB」。按工作区过滤；目录缺失回零。
      if (req.method === 'POST' && action === 'index-stats') {
        const body = await readJson(req)
        const result = await readIndexStats(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 分类实体化（P1-3）：稳定 id + 人工优先。数据按工作区落
      // `<topic-map>/categories/<workspaceId>.json`，与旧的归类缓存物理分开。
      if (req.method === 'POST' && action === 'categories') {
        const body = await readJson(req)
        const result = await readCategoryIndex(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        noteCategoryAutoActivity(ctx, { workspaceId: body?.workspaceId })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      if (req.method === 'POST' && action === 'category-save') {
        const body = await readJson(req)
        const result = await saveCategory(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      if (req.method === 'POST' && action === 'category-assign') {
        const body = await readJson(req)
        const result = await assignCategory(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      if (req.method === 'POST' && action === 'category-override') {
        const body = await readJson(req)
        const result = await overrideCategoryAssignment(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      if (req.method === 'POST' && action === 'category-auto-start') {
        const body = await readJson(req)
        const result = await startCategoryAuto(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      if (req.method === 'POST' && action === 'category-auto-status') {
        const body = await readJson(req)
        const result = await statusCategoryAuto(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 危险操作：清空模型分类并让工作区重新归类；必须 confirm:true。
      if (req.method === 'POST' && action === 'category-reset') {
        const body = await readJson(req)
        const result = await resetCategoryWorkspace(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      if (req.method === 'POST' && action === 'category-organize') {
        const body = await readJson(req)
        const result = await organizeCategories(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      if (req.method === 'POST' && action === 'category-undo') {
        const body = await readJson(req)
        const result = await undoCategoryOrganize(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 自动归类（只填空白）：先给建议供用户确认，再应用。
      if (req.method === 'POST' && action === 'category-suggest') {
        const body = await readJson(req)
        const result = await suggestCategories(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      if (req.method === 'POST' && action === 'category-apply-suggestions') {
        const body = await readJson(req)
        const result = await applyCategorySuggestions(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 变更可视化（P3-1）：仅从已落盘的索引行 `changes` 读，不现场问宿主。
      if (req.method === 'POST' && action === 'changes') {
        const body = await readJson(req)
        const result = await readTurnChanges(body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
      }

      // 回滚预演（P3-2）：只读。只出计划，不写任何文件。
      if (req.method === 'POST' && action === 'rollback-plan') {
        const body = await readJson(req)
        const result = await buildRollbackPlan(ctx, body ?? {})
        if (!result.ok) return sendJson(res, result.httpStatus ?? 500, { ok: false, error: result.error })
        return sendJson(res, 200, { ok: true, value: result.value })
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
        await hydrateAndTouch(segments, sessionId)
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
  await hydrateAndTouch(segments, sessionId)
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
 * DSH 的 home 目录（Windows 口径）。
 *
 * 三种来源按优先级：
 *   1. DSH_HOME      —— 平台显式指定，最可靠
 *   2. USERPROFILE   —— Windows 默认
 *   3. HOME          —— Git Bash / CI 等环境的兜底（无 USERPROFILE 时）
 *
 * 抽成一个函数是因为原先这段在三个地方各写了一遍（配置、分段、界面状态），
 * 改一处忘另外两处就会不一致——那种 bug 只在某个平台才暴露。
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
    // 读到就算用过（清理按"最后使用"判断）
    touchCacheFile(path)
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

// ── 状态标签（A-3 / F-4 / F-5） ──────────────────────────────────

/** 一行备注的长度上限（防止把标签文件写成日志）。 */
const LABEL_NOTE_MAX = 500

/** 三个状态开关的固定顺序（文件键序、读取归一都用它）。 */
const LABEL_SWITCHES = ['followUp', 'solved', 'starred']

/** 错误文本（Endpoint 只回一句话，不泄露堆栈）。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 标签文件路径：`<topic-map>/index/labels/<workspaceId>.json`。
 *
 * workspaceId 里的路径分隔符替换成下划线，防止写出目录。
 *
 * @param workspaceId - 工作区 id。
 * @returns 绝对路径，或 null（无法确定 DSH home）。
 */
function labelsFilePath(workspaceId) {
  const dir = topicMapDir()
  if (dir === null) return null
  const safe = String(workspaceId ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_')
  return join(dir, 'index', 'labels', `${safe}.json`)
}

/**
 * 把一条标签收敛成固定形状（键序固定）。
 *
 * @param raw - 任意历史形状（对象 / 字符串 / 数组）。
 * @returns `{followUp, solved, starred, note, source, updatedAt}`。
 */
function canonicalLabel(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const updatedAt = Number(src.updatedAt)
  return {
    followUp: src.followUp === true,
    solved: src.solved === true,
    starred: src.starred === true,
    note: typeof src.note === 'string' ? src.note.slice(0, LABEL_NOTE_MAX) : '',
    source: src.source === 'user' ? 'user' : 'model',
    updatedAt: Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0,
  }
}

/**
 * 归一一条历史标签。
 *
 * 兼容 rank.js 支持过的 `'solved'` / `['solved','starred']` 写法：读进来
 * 一律变成三个布尔，写回时就是新形状——旧文件不会因此读不出来。
 *
 * @param raw - 文件里的一条值。
 * @returns 归一后的标签。
 */
function normalizeLabelEntry(raw) {
  if (typeof raw === 'string' || Array.isArray(raw)) {
    const names = typeof raw === 'string' ? [raw] : raw
    return canonicalLabel({
      followUp: names.includes('followUp'),
      solved: names.includes('solved'),
      starred: names.includes('starred'),
      source: 'model',
      updatedAt: 0,
    })
  }
  return canonicalLabel(raw)
}

/**
 * 把标签文件内容归一成扁平 map。
 *
 * 扁平 `{'sid#turn': entry}` 与 `{labels:{...}}` 都认；不是对象（数组、
 * 字符串、null）返回 null，由调用方按"文件损坏"处理（绝不覆盖）。
 *
 * @param raw - JSON.parse 的结果。
 * @returns `{labels, count}`，或 null。
 */
function normalizeLabelsDocument(raw) {
  if (!isPlainObject(raw)) return null
  const source = isPlainObject(raw.labels) ? raw.labels : raw
  const labels = {}
  for (const [key, value] of Object.entries(source)) {
    if (typeof key !== 'string' || key === '') continue
    labels[key] = normalizeLabelEntry(value)
  }
  return { labels, count: Object.keys(labels).length }
}

/** 文件损坏的统一返回（读写清三处共用，保证提示一致）。 */
function corruptLabels() {
  return { ok: false, error: 'labels 文件损坏', httpStatus: 500 }
}

/**
 * 读标签文件。
 *
 * 缺失 → 空标签；JSON 损坏 → `ok:false`（调用方绝不能把它当空文件写回）。
 *
 * @param workspaceId - 工作区 id。
 * @returns `{ok:true, labels, count}` 或 `{ok:false, error, httpStatus}`。
 */
async function readLabelsDocument(workspaceId) {
  const path = labelsFilePath(workspaceId)
  if (path === null) return { ok: false, error: '无法确定 DSH home', httpStatus: 500 }
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, labels: {}, count: 0 }
    return { ok: false, error: `labels 文件读取失败：${errorText(error)}`, httpStatus: 500 }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return corruptLabels()
  }
  const doc = normalizeLabelsDocument(raw)
  return doc === null ? corruptLabels() : { ok: true, ...doc }
}

/**
 * 原子写标签文件：tmp + rename，键排序保证文件可 diff。
 *
 * 失败会抛出——调用方必须把错误交给用户，不能静默。
 *
 * @param workspaceId - 工作区 id。
 * @param labels - 扁平标签 map。
 */
async function writeLabelsDocument(workspaceId, labels) {
  const path = labelsFilePath(workspaceId)
  if (path === null) throw new Error('无法确定 DSH home')
  const sorted = {}
  for (const key of Object.keys(labels).sort()) sorted[key] = labels[key]
  const tmp = `${path}.tmp`
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(tmp, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {
      // tmp 可能根本没写出来；原错误更重要。
    }
    throw error
  }
}

/** 同一 workspace 的写盘串行队列：读-改-写不能互相插队。 */
const labelWriteChains = new Map()

/**
 * 把一次读-改-写排进 workspace 队列。
 *
 * 前一个任务失败也不能毒化队列：链上存的是"已吞错"的版本，调用方拿到的
 * 仍是原始结果。
 *
 * @param workspaceId - 工作区 id。
 * @param task - 实际执行读-改-写的异步函数。
 * @returns task 的结果。
 */
function enqueueLabelWrite(workspaceId, task) {
  const prev = labelWriteChains.get(workspaceId) ?? Promise.resolve()
  const run = prev.then(task)
  labelWriteChains.set(workspaceId, run.then(() => {}, () => {}))
  return run
}

/** 合法 turn：非负整数（0 是合法轮次）。 */
function validLabelTurn(turn) {
  return typeof turn === 'number' && Number.isInteger(turn) && turn >= 0
}

/** 只认 patch 里的四个键；开关必须是布尔，note 截断到上限。 */
function normalizeLabelPatch(patch) {
  const src = isPlainObject(patch) ? patch : {}
  const out = {}
  for (const key of LABEL_SWITCHES) {
    if (typeof src[key] === 'boolean') out[key] = src[key]
  }
  if (typeof src.note === 'string') out.note = src.note.trim().slice(0, LABEL_NOTE_MAX)
  return out
}

/**
 * 读标签：全量或单条（`sessionId` + `turn`）。
 *
 * @param workspaceId - 工作区 id。
 * @param selector - `{sessionId?, turn?}`；两个都给才是单条。
 * @returns `{ok:true, labels, count}` 或 `{ok:false, error, httpStatus}`。
 */
export async function readWorkspaceLabels(workspaceId, selector = {}) {
  const ws = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  if (ws === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  const src = isPlainObject(selector) ? selector : {}
  const hasSession = typeof src.sessionId === 'string' && src.sessionId !== ''
  const hasTurn = src.turn !== undefined && src.turn !== null
  if (hasSession !== hasTurn) {
    return { ok: false, error: '需要同时提供 sessionId 与 turn', httpStatus: 400 }
  }
  if (hasTurn && !validLabelTurn(src.turn)) {
    return { ok: false, error: 'turn 非法', httpStatus: 400 }
  }

  const doc = await readLabelsDocument(ws)
  if (!doc.ok) return doc
  if (!hasSession) return doc
  const key = `${src.sessionId}#${src.turn}`
  const label = doc.labels[key]
  const labels = label === undefined ? {} : { [key]: label }
  return { ok: true, labels, count: Object.keys(labels).length }
}

/**
 * 合并写入一条标签（A-3）。
 *
 * `source` 固定 `'user'`、`updatedAt` 每次刷新；patch 里只认
 * `followUp/solved/starred/note`，其余键忽略。读-改-写整体进 workspace
 * 串行队列，并发请求不会丢更新。
 *
 * @param workspaceId - 工作区 id。
 * @param sessionId - 会话 id。
 * @param turn - 轮次（非负整数）。
 * @param patch - 要改的字段。
 * @returns `{ok:true, key, label}` 或 `{ok:false, error, httpStatus}`。
 */
export async function setWorkspaceLabel(workspaceId, sessionId, turn, patch) {
  const ws = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  if (ws === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }
  if (!validLabelTurn(turn)) return { ok: false, error: 'turn 非法', httpStatus: 400 }

  const key = `${sid}#${turn}`
  const changes = normalizeLabelPatch(patch)
  return enqueueLabelWrite(ws, async () => {
    const doc = await readLabelsDocument(ws)
    if (!doc.ok) return doc
    const current = doc.labels[key] ?? canonicalLabel(null)
    const label = canonicalLabel({
      followUp: changes.followUp ?? current.followUp,
      solved: changes.solved ?? current.solved,
      starred: changes.starred ?? current.starred,
      note: changes.note ?? current.note,
      source: 'user',
      updatedAt: Date.now(),
    })
    try {
      await writeLabelsDocument(ws, { ...doc.labels, [key]: label })
    } catch (error) {
      return { ok: false, error: `labels 写入失败：${errorText(error)}`, httpStatus: 500 }
    }
    return { ok: true, key, label }
  })
}

/**
 * 删除一条标签（三个开关与备注整条清掉）。
 *
 * @param workspaceId - 工作区 id。
 * @param sessionId - 会话 id。
 * @param turn - 轮次。
 * @returns `{ok:true, removed}` 或 `{ok:false, error, httpStatus}`。
 */
export async function clearWorkspaceLabel(workspaceId, sessionId, turn) {
  const ws = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  if (ws === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }
  if (!validLabelTurn(turn)) return { ok: false, error: 'turn 非法', httpStatus: 400 }

  const key = `${sid}#${turn}`
  return enqueueLabelWrite(ws, async () => {
    const doc = await readLabelsDocument(ws)
    if (!doc.ok) return doc
    if (doc.labels[key] === undefined) return { ok: true, removed: false }
    const labels = { ...doc.labels }
    delete labels[key]
    try {
      await writeLabelsDocument(ws, labels)
    } catch (error) {
      return { ok: false, error: `labels 写入失败：${errorText(error)}`, httpStatus: 500 }
    }
    return { ok: true, removed: true }
  })
}

/** 排队写盘，避免并发请求互相覆盖。 */
let configWriteChain = Promise.resolve()

/** 摘要三档：字数上限与确定性命令补丁条数。 */
const DIGEST_LEVELS = Object.freeze({
  compact: Object.freeze({ maxChars: 200, commands: 0 }),
  standard: Object.freeze({ maxChars: 400, commands: 3 }),
  rich: Object.freeze({ maxChars: 800, commands: 8 }),
})

/** 配置里的档位归一：非法值回 standard。 */
function normalizeDigestLevel(value) {
  return value === 'compact' || value === 'rich' ? value : 'standard'
}

/** 单条消息引用配额默认值。 */
const DEFAULT_QUOTE_MAX_COUNT = 5
const DEFAULT_QUOTE_MAX_CHARS = 2400

/** 配额归一：正整数，缺省用默认值。 */
function normalizeQuoteMaxCount(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : DEFAULT_QUOTE_MAX_COUNT
}

function normalizeQuoteMaxChars(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.min(50000, Math.floor(n)) : DEFAULT_QUOTE_MAX_CHARS
}

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
    // 摘要档位：compact 200 / standard 400 / rich 800 字。
    digestLevel: normalizeDigestLevel(c.digestLevel),
    quoteMaxCount: normalizeQuoteMaxCount(c.quoteMaxCount),
    quoteMaxChars: normalizeQuoteMaxChars(c.quoteMaxChars),
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
    // 分类全自动总开关。缺省开启；显式 false 才关闭（老配置文件没有这个键，
    // 不能因为缺省值被当成关闭）。
    autoClassify: c.autoClassify !== false,
  }
}

/**
 * 保存配置，并等待落盘。
 *
 * @param body - 请求体。
 * @returns 归一化后的配置。
 */
/**
 * 把请求体的补丁合并到当前配置上。
 *
 * 设置页只提交差异（`diffConfig`），所以**缺失的键必须保持原值**——否则改一次摘要档位
 * 就会把 provider / apiKey / turnLimit 这类没提交的字段清空。显式提交空字符串仍表示清空。
 * 非法值回落**当前值**（而不是默认值），避免一次手滑把配置重置。
 *
 * @param current - 当前配置，可为 null。
 * @param body - 补丁，可为 null。
 * @returns 归一化后的完整配置。
 */
export function mergeConfigPatch(current, body) {
  const base = current && typeof current === 'object' ? current : {}
  const patch = body && typeof body === 'object' ? body : {}
  const has = (key) => Object.prototype.hasOwnProperty.call(patch, key)

  const textOf = (key) => {
    if (!has(key)) return typeof base[key] === 'string' ? base[key] : ''
    if (typeof patch[key] !== 'string') return typeof base[key] === 'string' ? base[key] : ''
    return patch[key].trim()
  }

  const numOf = (key, min, max, fallback) => {
    const candidate = has(key) ? patch[key] : base[key]
    const value = Number(candidate)
    if (Number.isFinite(value) && value >= min && value <= max) return Math.floor(value)
    const kept = Number(base[key])
    if (Number.isFinite(kept) && kept >= min && kept <= max) return Math.floor(kept)
    return fallback
  }

  const levelOf = () => {
    const candidate = has('digestLevel') ? patch.digestLevel : base.digestLevel
    return normalizeDigestLevel(candidate)
  }

  const merged = {
    // 空字符串表示"跟随当前会话模型"。
    provider: textOf('provider'),
    model: textOf('model'),
    turnLimit: numOf('turnLimit', 1, 500, DEFAULT_TURN_LIMIT),
    // 摘要档位：compact 200 / standard 400 / rich 800 字。
    digestLevel: levelOf(),
    quoteMaxCount: numOf('quoteMaxCount', 1, 100, DEFAULT_QUOTE_MAX_COUNT),
    quoteMaxChars: numOf('quoteMaxChars', 1, 50000, DEFAULT_QUOTE_MAX_CHARS),
    // 自定义端点：三项齐全时才生效，否则一律走会话模型。
    baseUrl: textOf('baseUrl'),
    apiKey: textOf('apiKey'),
    modelName: textOf('modelName'),
    // 归类分批大小：一次让模型归太多会话，输出容易错位（长度校验会整批作废）。
    categoryBatch: numOf('categoryBatch', 10, 500, 100),
    // 归类上限：超过就提示用户先筛选，而不是硬归。
    categoryLimit: numOf('categoryLimit', 50, 10000, 1000),
  }
  // 旧配置里没有这个键时不凭空新增，避免"空 patch 返回等价对象"的契约被打破；
  // 一旦配置里出现过（readConfig 会补默认值），就按布尔语义合并。
  if (has('autoClassify') || Object.prototype.hasOwnProperty.call(base, 'autoClassify')) {
    merged.autoClassify = has('autoClassify') ? patch.autoClassify !== false : base.autoClassify !== false
  }
  return merged
}

/**
 * 保存配置，并等待落盘。
 *
 * @param body - 请求体。
 * @returns 归一化后的配置。
 */
async function saveConfig(body) {
  const current = readConfig()
  const next = mergeConfigPatch(current, body)
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
  await hydrateAndTouch(segments, sessionId)
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
          sessionId,
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
        sessionId,
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
        const text = await callRemote({ fetch }, config, system, user, { maxTokens, signal, sessionId })
        return text
      } catch (error) {
        usage.fellBack = true
        usage.fallbackReason = error instanceof Error ? error.message : String(error)
        // 落到会话模型；此时若会话模型也不可用就只能失败。
        if (llm === undefined || route === null) throw error
      }
    }
    if (llm === undefined || route === null) throw new Error('no model available')
    return askOnce(llm, route, system, user, signal, { maxTokens, sessionId })
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
 * 只读标题、不读日志正文——这是"秒开"的关键。轮次数按需轻量读；最后活动
 * 时间只读索引文件的首行 meta 与末行（不整份解析），索引缺失才退到宿主的
 * 会话摘要时间。整份列表可能有一百多条，所以每条都不能读全文。
 *
 * 向后兼容：原有字段（sessionId/title/turns/tokens/subagent/
 * delegationDepth/createdAt）保持不变，只新增 `lastActive`。
 *
 * @param ctx - Host context。
 * @param cache - 会话缓存（已算过的直接复用轮次数）。
 * @param workspaceId - 工作区 id。
 * @returns `{ workspace, sessions }`。
 */
export async function listWorkspaceSessions(ctx, cache, workspaceId) {
  const workspace = resolveWorkspace(ctx, workspaceId)
  if (workspace === undefined) return { workspace: null, sessions: [] }

  const ids = [...(workspace.sessionIds ?? [])]

  // ── 读 header：拿 origin / formatStatus 这些权威标记 ──
  //
  // 为什么必须用 header 而不是靠标题文字猜：平台在 SessionHeader 里明确
  // 标了 `origin: 'subagent'`。正则匹配 "dsh-mnemon" 只能识别一种委派方式，
  // 换个委派流程就漏；formatStatus 还能标出格式不兼容的会话。
  const headers = new Map()
  // 会话摘要时间：宿主 listSessions 记录里若带摘要/投影时间，作为索引缺失
  // 时的兜底。版本差异用多个字段名兼容；拿不到就不放。
  const summaries = new Map()
  try {
    if (typeof ctx.sessionQuery.listSessions === 'function') {
      const records = await ctx.sessionQuery.listSessions()
      for (const rec of Array.isArray(records) ? records : []) {
        const id = String(rec?.header?.id ?? '')
        if (id === '') continue
        headers.set(id, rec.header)
        const summaryTime = summaryActivityTime(rec)
        if (summaryTime !== null) summaries.set(id, summaryTime)
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
  const indexDir = defaultSessionsDir()
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
      // 历史页排序/时间线：最后一轮结束时间（或开始时间）。索引 → 摘要 → null。
      lastActive: await lastActiveOfSession(sessionId, indexDir, summaries),
    })
  }

  return {
    workspace: { id: workspace.id, path: workspace.path, title: workspace.title },
    sessions,
    total: ids.length,
    hidden,
  }
}

// ── lastActive（历史页：列表按"最后活动"排序 / 时间线） ─────────────

/** 读索引末行的初始窗口；一轮文本有 32k 上限，64KB 通常够。 */
const INDEX_ACTIVITY_TAIL_BYTES = 64 * 1024

/** 末行被窗口切断时的最大扩窗；再大说明索引异常，退摘要。 */
const INDEX_ACTIVITY_TAIL_MAX_BYTES = 1024 * 1024

/** 只认正的 epoch ms；null / 字符串 / 0 都算"没有时间"。 */
function positiveTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * 索引首行 meta 里的活动时间。
 *
 * 当前写盘格式的 meta 只有 revision/turnCount；这里兼容未来/旧版可能把
 * `lastActive` 一类字段放进 meta 的情形。没有就返回 null，继续看末行。
 */
function metaActivityTime(meta) {
  if (!isPlainObject(meta)) return null
  for (const key of ['lastActive', 'lastActiveAt', 'lastPromptAt', 'updatedAt']) {
    const time = positiveTime(meta[key])
    if (time !== null) return time
  }
  return null
}

/** 一轮索引行的活动时间：`turn/end` 的时间优先，未收尾用 `turn/start`。 */
function indexRowActivityTime(row) {
  if (!isPlainObject(row)) return null
  return positiveTime(row.end) ?? positiveTime(row.start)
}

/**
 * 会话摘要时间（宿主 listSessions 记录上的兼容读取）。
 *
 * DSH 自己的会话列表把"最近活动"定义为摘要时间与最后一次用户提问的较晚
 * 值；不同版本把它放在 updatedAt / lastPromptAt / projections 等位置。
 * 这里只取**活动**时间，不拿 createdAt 冒充——创建时间由 createdAt 字段
 * 单独表达，客户端会显示成"创建于"。
 */
function summaryActivityTime(record) {
  if (!isPlainObject(record)) return null
  const candidates = [
    record.updatedAt,
    record.lastActive,
    record.lastActiveAt,
    record.lastPromptAt,
    record.summaryAt,
    record.summaryUpdatedAt,
    record.summary?.updatedAt,
    record.summary?.lastActive,
    record.metadata?.lastPromptAt,
    record.projections?.lastPromptAt,
    record.projections?.sessionListMetadata?.lastPromptAt,
    record.projections?.values?.sessionListMetadata?.lastPromptAt,
  ]
  let best = null
  for (const raw of candidates) {
    const time = positiveTime(raw)
    if (time !== null && (best === null || time > best)) best = time
  }
  return best
}

/** 只读索引首行；meta 带活动时间就返回，否则 null。 */
async function readIndexMetaActivity(path) {
  let handle
  try {
    handle = await open(path, 'r')
    // meta 是定长小对象；8KB 足够，超过还没换行只可能是坏文件。
    const buffer = Buffer.alloc(8 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead <= 0) return null
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    if (newline === -1 && bytesRead >= buffer.length) return null
    const line = (newline === -1 ? text : text.slice(0, newline)).trim()
    if (line === '') return null
    let meta
    try {
      meta = JSON.parse(line)
    } catch {
      return null
    }
    return metaActivityTime(meta)
  } catch {
    return null
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // 关不上不影响已读到的结果
      }
    }
  }
}

/**
 * 从索引文件末尾读最后一轮的活动时间。
 *
 * 只读尾部窗口、不整份解析：一个工作区可能上百个会话，整份读会把"秒开"
 * 变成秒级。窗口第一段可能是半行（从行中间开始），丢掉即可；最后一行必须
 * 完整解析成功，否则扩窗重试——绝不退到倒数第二行冒充"最后活动"。
 */
async function readIndexLastRowActivity(path) {
  let size
  try {
    const info = await stat(path)
    size = info.size
  } catch {
    return null
  }
  if (!Number.isFinite(size) || size <= 0) return null

  let window = Math.min(INDEX_ACTIVITY_TAIL_BYTES, size)
  for (;;) {
    const alignedStart = Math.max(0, size - window)
    // 多读窗口起点前的一个字节：用它判断窗口是否正好落在行首，避免把
    // 一行完整的末行当成"半行"丢掉（窗口边界恰好等于换行符时会发生）。
    const readOffset = alignedStart > 0 ? alignedStart - 1 : 0
    let text
    let handle
    try {
      handle = await open(path, 'r')
      const buffer = Buffer.alloc(size - readOffset)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, readOffset)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } catch {
      return null
    } finally {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch {
          // 同上：读失败已经反映在返回值里
        }
      }
    }

    // 窗口从行中间开始时，丢掉第一段半行；正好在行首时保留整段。
    let body
    if (readOffset === 0) {
      body = text
    } else if (text.startsWith('\n')) {
      body = text.slice(1)
    } else {
      const newline = text.indexOf('\n')
      body = newline === -1 ? '' : text.slice(newline + 1)
    }

    let line = ''
    if (body !== '') {
      const lines = body.split('\n')
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const candidate = lines[index].trim()
        if (candidate !== '') {
          line = candidate
          break
        }
      }
    }

    if (line === '') {
      // 窗口整个落在最后一轮内部（一轮可能接近 100KB UTF-8）：扩窗重试。
      const wider = Math.min(INDEX_ACTIVITY_TAIL_MAX_BYTES, window * 4)
      if (readOffset > 0 && wider > window) {
        window = Math.min(size, wider)
        continue
      }
      return null
    }

    let row
    try {
      row = JSON.parse(line)
    } catch {
      // 走到这里 line 已是完整的一行，解析失败说明索引真的坏了。
      return null
    }

    // 最后一行的位置优先于 meta（单行索引时这一行就是 meta）。
    return indexRowActivityTime(row) ?? metaActivityTime(row)
  }
}

/**
 * 一个会话的最后活动时间。
 *
 * 顺序：索引首行 meta → 索引末行 → 会话摘要 → null。
 */
async function lastActiveOfSession(sessionId, indexDir, summaries) {
  const fromSummary = summaries?.get(sessionId) ?? null
  if (indexDir === '') return fromSummary
  let path
  try {
    path = indexFilePath(indexDir, sessionId)
  } catch {
    return fromSummary
  }
  const metaTime = await readIndexMetaActivity(path)
  if (metaTime !== null) return metaTime
  const rowTime = await readIndexLastRowActivity(path)
  if (rowTime !== null) return rowTime
  return fromSummary
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

  // 并行计数：走 revision 增量判断，没变化的会话不读事件流。
  //
  // 尚未预热过的会话**这次先跳过**（沿用树里缓存的值），交给
  // warmTurnCounts 在后台补。否则进程刚启动的第一次打开要等 3.8 秒。
  // 当前会话例外：它是唯一会变的那个，必须这次就准。
  const counts = new Map()
  await Promise.all(ids.map(async (id) => {
    const isActive = onlySessionId !== null && onlySessionId !== undefined
      && String(onlySessionId) !== '' && String(onlySessionId) === id
    if (!isActive && !turnCountCache.has(id)) return
    try {
      const n = await countTurnsCached(ctx, id)
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

/**
 * 轮数缓存：sessionId → { revision, turns }。
 *
 * 为什么需要：全量刷新 32 个会话的轮数要 3.9 秒（实测），因为它对每个
 * 会话都走一遍 listEvents 读事件流。但绝大多数会话**根本没变** ——
 * 用户不会回头往旧会话里说话。
 *
 * 做法：先用 stat 读 revision（很便宜），与上次记下的比较；
 * 没变就直接返回旧值，一次事件流都不读。
 * 这样"刷新全部"的成本从"32 次 listEvents"降到"32 次 stat + 少数几次计数"。
 */
const turnCountCache = new Map()

async function countTurnsCached(ctx, sessionId) {
  let revision = null
  try {
    revision = await readRevision(ctx, sessionId)
  } catch {
    // 读不到 revision 就退化成直接计数（保证正确性优先）
    revision = null
  }

  const hit = turnCountCache.get(sessionId)
  if (hit !== undefined && revision !== null && hit.revision === revision) return hit.turns

  const n = await countTurns(ctx, sessionId)
  if (n !== null && Number.isFinite(n)) {
    // revision 读不到时记一个特殊值：下回仍会重数，但至少这次能用
    turnCountCache.set(sessionId, { revision: revision === null ? 'unknown' : revision, turns: n })
  }
  return n
}

/**
 * 后台预热轮数缓存。
 *
 * 刚启动时缓存是空的，把所有会话的轮数都数一遍要 3.8 秒 —— 不能让用户等。
 * 所以首屏只算"当前会话"（457ms），其余用后台按并发慢慢填。
 * 填完之后就靠 revision 判断，后续刷新只要 124ms。
 *
 * 故意不带 await：调用方要立刻返回响应。单个失败不影响其它。
 *
 * @param ctx - Host context。
 * @param ids - 候选会话 id。
 * @param concurrency - 并发数（读事件流是 I/O，但别把磁盘打满）。
 */
function warmTurnCounts(ctx, ids, concurrency = 4) {
  const queue = []
  for (const id of ids) {
    const key = String(id)
    if (!turnCountCache.has(key)) queue.push(key)
  }
  if (queue.length === 0) return

  let next = 0
  const workers = []
  const width = Math.max(1, Math.min(concurrency, queue.length))
  for (let w = 0; w < width; w += 1) {
    workers.push((async () => {
      while (next < queue.length) {
        const id = queue[next]
        next += 1
        if (turnCountCache.has(id)) continue
        try { await countTurnsCached(ctx, id) } catch { /* 单个失败忽略 */ }
      }
    })())
  }
  Promise.all(workers).catch(() => { /* 预热失败不影响任何功能 */ })
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
          // 命中即"用过"：更新 mtime，让清理按"最后使用"判断而不是"最后写入"
          touchCacheFile(cachePath)
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
              const n = await countTurnsCached(ctx, id)
              if (n !== null && n > 0) nonEmpty.push({ sessionId: id, turns: n })
            } catch { /* 读不出来就先带上 */ nonEmpty.push({ sessionId: id, turns: null }) }
          }
          // 后台预热：把还没数过的会话补上。
          // 不 await —— 首屏要立刻返回，慢慢填就行（填完后续刷新约 124ms）。
          warmTurnCounts(ctx, workspace.sessionIds ?? [])
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

  // 归类是工作区级动作，但请求信封仍需要一个会话 id 供适配器路由；
  // 优先用打开面板的 activeSessionId，缺失时取工作区第一个会话。
  const modelSessionId = activeSessionId ?? Array.from(workspace.sessionIds ?? [])[0]

  /** 统一的模型调用：自定义端点优先，失败回退会话模型。 */
  async function ask(system, user, maxTokens) {
    if (custom) {
      try {
        const t = await callRemote({ fetch }, config, system, user, {
          maxTokens,
          signal,
          sessionId: modelSessionId,
        })
        return { text: t, via: 'custom' }
      } catch {
        // 回退
      }
    }
    if (llm === undefined || route === null) throw new Error('no model available')
    const t = await askOnce(llm, route, system, user, signal, {
      maxTokens,
      sessionId: modelSessionId,
    })
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

  // 归类刚跑完，顺手把轮数缓存填上，后续刷新就不必再读事件流。
  warmTurnCounts(ctx, items.map(i => i.id))

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

/**
 * 索引行 → 检索行。
 *
 * 索引里存的是全文与 `{seq, start}`；这里收敛成和旧实现一样的四个检索
 * 字段，下面的匹配/片段逻辑就不必关心数据来自哪条路。
 *
 * @param row - 索引文件里的一行。
 * @returns `{turn, prompt, response, seq, time}`。
 */
function indexSearchRow(row) {
  return {
    turn: row.turn,
    prompt: String(row.prompt ?? ''),
    response: String(row.response ?? ''),
    seq: row.seq ?? null,
    time: row.start ?? null,
  }
}

/**
 * 旧实现行 → 检索行（字段名不同，语义相同）。
 *
 * @param row - `sessionTurnsOf` 返回的一行。
 * @returns `{turn, prompt, response, seq, time}`。
 */
function legacySearchRow(row) {
  return {
    turn: row.turn,
    prompt: row.prompt,
    response: row.response,
    seq: row.startSeq ?? null,
    time: row.startTime ?? null,
  }
}

/**
 * 判断一个会话的索引能否用于检索。
 *
 * 条件是"文件完好 + revision 与宿主一致"：revision 不一致说明日志前进过，
 * 索引里的全文已经过期，不能拿它冒充最新。任何异常（stat 失败、目录不可
 * 写、文件损坏）都返回 null，让调用方回退旧实现——N-3 要求索引问题绝不
 * 能让检索失效。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @returns 轮次行数组，或 null（不可用）。
 */
async function sessionIndexTurnsOf(ctx, sessionId) {
  try {
    const dir = defaultSessionsDir()
    if (dir === '') return null
    const revision = await readRevision(ctx, sessionId)
    const file = await readIndexFile(dir, sessionId)
    if (!file.ok || file.meta.revision !== revision) return null
    return file.turns
  } catch {
    return null
  }
}

/**
 * 跨会话全文检索。
 *
 * 数据源分两层：先读本插件的轮次索引（全文、能越过 80/160 字预览），
 * 索引缺失/损坏/过期时回退"逐会话读日志 + turn-model 预览"的旧实现。
 * 平台自带的 `searchSessions` 在本部署被配置成 `openAt: "never"`，不能用。
 *
 * 保持旧语义不变：一个会话只报第一条命中；结果按时间倒序；返回形状
 * 逐字段不变（P0-3 的多命中/分组在检索端点另做）。
 *
 * @param ctx - Host context。
 * @param workspaceId - 工作区。
 * @param query - 关键字。
 * @param limit - 条数。
 * @returns `{ status, query, workspace, hits, total, scanned, truncated }`。
 */
export async function findAcrossSessions(ctx, workspaceId, query, limit) {
  const q = String(query ?? '').trim()
  if (q === '') return { status: 'ready', query: '', hits: [] }

  const workspace = resolveWorkspace(ctx, workspaceId)
  if (workspace === undefined) return { status: 'unavailable', reason: '没有工作区', hits: [] }

  const ids = [...(workspace.sessionIds ?? [])]
  const needle = q.toLowerCase()
  const maxHits = Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 20

  // 标题先读，快且能覆盖很大一部分搜索需求
  const titles = await readTitleMap(ctx, ids)

  const hits = []

  for (const sessionId of ids) {
    if (hits.length >= maxHits) break

    const title = titles.get(sessionId) ?? sessionId
    const titleHit = String(title).toLowerCase().includes(needle)

    // 索引优先：全文可搜，能越过 80/160 字的预览边界。
    // 缺失/损坏/过期（revision 不一致）一律回退旧实现，索引问题不得让检索失效（N-3）。
    const indexed = await sessionIndexTurnsOf(ctx, sessionId)
    let rows
    if (indexed !== null) {
      rows = indexed.map(indexSearchRow)
    } else {
      // 旧路径：走 60 秒缓存，重复检索只做字符串扫描，不再重读日志
      const legacy = await sessionTurnsOf(ctx, sessionId)
      if (legacy === null) continue      // 读不出来的会话跳过
      rows = legacy.map(legacySearchRow)
    }
    // 先做一次整块预筛：没有命中就直接跳过，省掉逐轮扫描
    if (!titleHit) {
      let any = false
      for (const r of rows) {
        if (r.prompt.toLowerCase().includes(needle) || r.response.toLowerCase().includes(needle)) { any = true; break }
      }
      if (!any) continue
    }

    let got = false
    for (const row of rows) {
      if (hits.length >= maxHits) break
      const prompt = row.prompt
      const response = row.response
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
        turn: row.turn,
        seq: row.seq ?? null,
        type: inPrompt ? 'prompt' : 'response',
        snippet: snippet.replace(/\s+/g, ' ').slice(0, 200),
        time: row.time ?? null,
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

// ── 索引写入（P0-9 / F-7） ─────────────────────────────────────────

/**
 * 读事件流的严格版本。
 *
 * `readEvents` 会把任何读失败吞成空数组；建索引时那会被当成"这个会话
 * 没有轮次"，把已有历史整文件覆盖成空。这里让错误抛出去：同步失败就
 * 不落盘，检索照旧走回退路径。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @returns 原始事件数组。
 */
async function readEventsOrThrow(ctx, sessionId) {
  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  if (snapshot === null || snapshot === undefined) return []
  return Array.isArray(snapshot.events) ? snapshot.events : []
}

/**
 * summary 拿不到明细时的 changes。
 *
 * F-7 明确要求留痕：事件存在就说明这一轮改过文件，只是明细已经不可读
 * （会话 dispose / 宿主没记录），不能静默当成"没有变更"。
 *
 * @returns `{files: [], total: 0, added: 0, deleted: 0, lost: true}`
 */
function lostChanges() {
  return { files: [], total: 0, added: 0, deleted: 0, lost: true }
}

/** 计数收敛：非有限数或负数一律回退。 */
function countOf(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** 单轮最多哈希多少个变更文件：一次批量改动不应拖垮索引构建。 */
const CHANGE_HASH_LIMIT = 50
/** 单文件哈希上限：超过 2MB 的文件不读进内存，留 hashSkipped。 */
const CHANGE_HASH_MAX_BYTES = 2 * 1024 * 1024

/**
 * 把宿主的变更摘要收敛成索引里的 `changes` 形状。
 *
 * 只保留检索/展示需要的 `{path, added, deleted}`；`hash` 由调用方紧接着
 * 用 {@link attachChangeHashes} 补，避免这个纯数据函数碰文件系统。
 * `binary` / `oversized` 这类明细标记等 A-7 需要时再加。summary 不是对象
 * （含 undefined）时返回 `lost:true`。
 *
 * @param summary - `ctx.workspaceChanges.summary` 的返回值。
 * @returns `{files, total, added, deleted, lost}`。
 */
function changesFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return lostChanges()
  const files = []
  if (Array.isArray(summary.files)) {
    for (const file of summary.files) {
      if (!file || typeof file !== 'object') continue
      const path = typeof file.path === 'string' && file.path !== ''
        ? file.path
        : String(file.display ?? '')
      if (path === '') continue
      files.push({ path, added: countOf(file.added), deleted: countOf(file.deleted) })
    }
  }
  return {
    files,
    total: countOf(summary.total, files.length),
    added: countOf(summary.added, files.reduce((sum, file) => sum + file.added, 0)),
    deleted: countOf(summary.deleted, files.reduce((sum, file) => sum + file.deleted, 0)),
    lost: false,
  }
}

/** 变更文件解析根目录：优先 summary.cwd，其次当前会话所属工作区。 */
function changeHashRoot(summary, ctx, sessionId) {
  if (typeof summary?.cwd === 'string' && summary.cwd.trim() !== '') return summary.cwd.trim()
  const workspace = workspaceOfSession(ctx, sessionId)
  return typeof workspace?.path === 'string' ? workspace.path : ''
}

/**
 * 给 changes.files 逐个补变更后内容的 sha256。
 *
 * 时机是 F-7 拉到 summary 之后、写索引行之前；这是唯一还能读到"变更后
 * 文件状态"的窗口。规则：
 *   - 成功：`hash` = 64 位小写 sha256，不写 `hashSkipped`；
 *   - 文件不存在：`hash:null, hashSkipped:'missing'`；
 *   - 超过 2MB：`hash:null, hashSkipped:'too-large'`；
 *   - 其它读失败（权限/目录/IO）：`hash:null, hashSkipped:'unreadable'`；
 *   - 单轮超过 50 个文件：后续文件 `hash:null, hashSkipped:'limited'`。
 *
 * `legacy:true`（修复旧结构索引）时只补 `hash:null`，绝不拿"现在"的磁盘
 * 内容冒充历史轮次当时的快照。
 *
 * @param changes - `changesFromSummary` 的结果（原地写）。
 * @param summary - 宿主 summary（取 cwd）。
 * @param ctx - Host context（兜底工作区根目录）。
 * @param sessionId - 会话 id。
 * @param options - `{legacy}`。
 */
async function attachChangeHashes(changes, summary, ctx, sessionId, options = {}) {
  if (!changes || changes.lost === true || !Array.isArray(changes.files)) return
  const legacy = options.legacy === true
  const root = changeHashRoot(summary, ctx, sessionId)
  for (let index = 0; index < changes.files.length; index += 1) {
    const file = changes.files[index]
    if (!file || typeof file.path !== 'string' || file.path === '') continue
    delete file.hashSkipped
    if (legacy) {
      file.hash = null
      continue
    }
    if (index >= CHANGE_HASH_LIMIT) {
      file.hash = null
      file.hashSkipped = 'limited'
      continue
    }
    const absolute = isAbsolute(file.path)
      ? file.path
      : (root === '' ? '' : resolvePath(root, file.path))
    if (absolute === '') {
      file.hash = null
      file.hashSkipped = 'missing'
      continue
    }
    try {
      const info = await stat(absolute)
      if (!info.isFile()) {
        file.hash = null
        file.hashSkipped = 'unreadable'
        continue
      }
      if (Number(info.size) > CHANGE_HASH_MAX_BYTES) {
        file.hash = null
        file.hashSkipped = 'too-large'
        continue
      }
      const buffer = await readFile(absolute)
      if (buffer.length > CHANGE_HASH_MAX_BYTES) {
        file.hash = null
        file.hashSkipped = 'too-large'
        continue
      }
      file.hash = createHash('sha256').update(buffer).digest('hex')
    } catch (error) {
      file.hash = null
      file.hashSkipped = error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
        ? 'missing'
        : 'unreadable'
    }
  }
}

/**
 * 问宿主拿某一轮的变更摘要。
 *
 * `workspaceChanges.summary` 对已 dispose 的会话、或宿主从未记录的会话
 * 返回 undefined；服务缺失或调用抛错也按"明细不可读"处理，绝不让变更
 * 摘要拖垮索引写入。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @param seq - `workspace/changes` 事件的 seq（宿主按它定位记录）。
 * @returns summary 对象，或 undefined。
 */
async function readChangeSummary(ctx, sessionId, seq) {
  try {
    // Cordis 的严格代理会在未 inject 时直接抛；把"取服务"也放进 try，
    // 保证任何原因读不到明细都退化成 lost:true，而不是让整批构建失败。
    const service = ctx.workspaceChanges
    if (!service || typeof service.summary !== 'function') return undefined
    return await service.summary(sessionId, seq)
  } catch {
    return undefined
  }
}

/**
 * 给索引行补 `changes`（F-7）。
 *
 * 日志里的 `workspace/changes` 只带 `{turn}` 指针，文件清单在宿主内存里，
 * 所以必须在看到事件时立刻拉 summary 落盘。规则：
 *   - 拿到 summary → `changes:{files, total, added, deleted, lost:false}`；
 *   - 事件在、summary 不可读 → `lost:true` 留痕；
 *   - 事件不在 → 不写 `changes` 字段。
 *
 * 重建时复用 `previous` 里已有明细（`lost:false`）的轮次，避免对同一轮
 * 重复请求；`lost:true` 不复用，下次重建重试。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @param turns - 本次构建的轮次行（原地写入）。
 * @param events - 本次事件流。
 * @param previous - 上一版索引行。
 * @param options - `{legacy}`；legacy 重建不补历史 hash。
 */
async function attachWorkspaceChanges(ctx, sessionId, turns, events, previous = [], options = {}) {
  const rows = new Map()
  for (const row of turns) rows.set(row.turn, row)
  if (rows.size === 0) return

  const reusable = new Map()
  for (const row of Array.isArray(previous) ? previous : []) {
    if (!row || !Number.isFinite(row.turn)) continue
    const changes = row.changes
    // 只有真正拿到过明细的轮次才复用；lost:true 要重新问一次。
    if (changes && changes.lost === false) reusable.set(row.turn, changes)
  }

  const seen = new Set()
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'workspace/changes') continue
    const turn = Number(event.data?.turn)
    if (!Number.isFinite(turn) || seen.has(turn)) continue
    seen.add(turn)
    const row = rows.get(turn)
    if (row === undefined) continue
    const cached = reusable.get(turn)
    if (cached !== undefined) {
      row.changes = cached
      continue
    }
    const summary = await readChangeSummary(ctx, sessionId, event.seq)
    const changes = changesFromSummary(summary)
    await attachChangeHashes(changes, summary, ctx, sessionId, options)
    row.changes = changes
  }
}

/**
 * 同步一个会话的索引（Host 侧包装）。
 *
 * 依赖 Host context 的三样东西留在这里：revision（`sessionPersistence.stat`）、
 * 事件流（`sessionQuery.readSession`）、变更摘要（`workspaceChanges.summary`）。
 * `lib/turn-index.js` 只接收纯数据与一个 enrich 钩子，不认 ctx。
 *
 * 这是 F-7 的写入口：调用方应在会话加载/检索时对目标会话调用一次；第二
 * 次同 revision 会整文件跳过，不读事件流，也不会重复请求 summary。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @param options - `{dir, revision, events}`，供测试或"已读过事件"的调用方注入。
 * @returns `syncSessionIndex` 的结果。
 */
export async function syncSessionIndexFor(ctx, sessionId, options = {}) {
  const revision = options.revision ?? await readRevision(ctx, sessionId)
  return syncSessionIndex({
    dir: options.dir,
    sessionId,
    revision,
    loadEvents: async () => {
      if (Array.isArray(options.events)) return options.events
      return readEventsOrThrow(ctx, sessionId)
    },
    enrich: async payload => {
      await attachWorkspaceChanges(ctx, sessionId, payload.turns, payload.events, payload.previous, {
        legacy: payload.legacy === true,
      })
    },
  })
}

// ── 检索端点与索引维护（P0-3 / P0-9 接线 b） ──────────────────────

/** 新检索端点的返回上限（S-8；与内核默认 50 分开，端点是产品口径）。 */
const SEARCH_LIMIT_MAX = 200

/** /index-build 的会话并发上限。 */
const INDEX_BUILD_CONCURRENCY = 2

/** 后台补索引的并发上限（检索时可能一次排进很多会话）。 */
const INDEX_BACKGROUND_CONCURRENCY = 2

/** 同一会话后台同步的最小间隔：频繁打开/检索时不要打转。 */
const INDEX_SYNC_TTL_MS = 60 * 1000

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读会话标题表（/find 与 /search 共用）。
 *
 * 标题是可选的：读失败就当没有，不能因此让检索失败。
 *
 * @param ctx - Host context。
 * @param ids - 会话 id 数组。
 * @returns `Map<sessionId, title>`。
 */
async function readTitleMap(ctx, ids) {
  const titles = new Map()
  try {
    for (const item of await ctx.sessionQuery.readTitleSnapshots(ids)) {
      if (item.status === 'fulfilled' && item.value?.title !== undefined) {
        titles.set(item.sessionId, item.value.title.title)
      }
    }
  } catch {
    // 标题可选。
  }
  return titles
}

/** 检索 limit：非法值交给内核默认，合法值封顶 200。 */
function clampSearchLimit(limit) {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return undefined
  return Math.min(SEARCH_LIMIT_MAX, Math.floor(value))
}

/** 检索 offset：缺省/负数/非数字归 0；合法数字或数字字符串向下取整。 */
function clampSearchOffset(offset) {
  const value = typeof offset === 'number'
    ? offset
    : typeof offset === 'string' && offset.trim() !== '' ? Number(offset) : NaN
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

/** 结构化 sessionIds 过滤：先窄化要扫描的会话，避免白读日志。 */
function narrowSessionIds(sessionIds, filters) {
  const all = Array.isArray(sessionIds) ? sessionIds.map(String) : []
  const wanted = isPlainObject(filters) && Array.isArray(filters.sessionIds)
    ? filters.sessionIds.map(String)
    : []
  if (wanted.length === 0) return all
  const allowed = new Set(wanted)
  return all.filter(id => allowed.has(id))
}

// ── 分类过滤（历史页：分类树当检索过滤器） ────────────────────────

/** 「未归类」的保留 id；分类实体 id 由 `c-` 前缀生成，不会撞。 */
const CATEGORY_NONE_FILTER = '__none__'

/** 归一分类实体 id（兼容旧 assignments：值直接是 id 字符串）。 */
function categoryIdOfAssignment(raw) {
  if (typeof raw === 'string') {
    const id = raw.trim()
    return id === '' ? null : id
  }
  if (!isPlainObject(raw)) return null
  const id = typeof raw.categoryId === 'string'
    ? raw.categoryId.trim()
    : typeof raw.id === 'string' ? raw.id.trim() : ''
  return id === '' ? null : id
}

/** store 里真实存在的分类 id 集合（脏数据跳过，不抛错）。 */
function knownCategoryIdsOf(store) {
  const known = new Set()
  const categories = Array.isArray(store?.categories) ? store.categories : []
  for (const category of categories) {
    if (!isPlainObject(category)) continue
    const id = typeof category.id === 'string' ? category.id.trim() : ''
    if (id !== '') known.add(id)
  }
  return known
}

/** 从 rootId 向下收集整棵子树（含自身）；有环也不会死循环。 */
function categorySubtreeIdsOf(store, rootId) {
  const categories = Array.isArray(store?.categories) ? store.categories : []
  const childrenOf = new Map()
  for (const category of categories) {
    if (!isPlainObject(category)) continue
    const id = typeof category.id === 'string' ? category.id.trim() : ''
    if (id === '') continue
    const parentId = typeof category.parentId === 'string' ? category.parentId.trim() : ''
    if (parentId === '') continue
    const list = childrenOf.get(parentId)
    if (list === undefined) childrenOf.set(parentId, [id])
    else list.push(id)
  }
  const subtree = new Set([rootId])
  const queue = [rootId]
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of childrenOf.get(queue[index]) ?? []) {
      if (subtree.has(child)) continue
      subtree.add(child)
      queue.push(child)
    }
  }
  return subtree
}

/** 该会话的归类 id；没有 assignment 返回 null。 */
function assignedCategoryOf(store, sessionId) {
  const assignments = isPlainObject(store?.assignments) ? store.assignments : {}
  if (!Object.prototype.hasOwnProperty.call(assignments, sessionId)) return null
  return categoryIdOfAssignment(assignments[sessionId])
}

/**
 * 把请求的 categoryId 解析成允许检索的会话集合。
 *
 * - 分类文件缺失/损坏/无法确定 home → `{active:false}`（无过滤，不能报错）；
 * - `__none__` → 未归类；悬空 categoryId（分类已不存在）也算未归类，
 *   与客户端右栏的口径一致；
 * - 普通分类 → 自身 + 全部后代；
 * - 分类文件存在但 id 不存在 → 空集合（不放宽成全部）。
 *
 * @returns `{active, allowed}`；active 为 false 时 allowed 无意义。
 */
async function resolveCategorySessionScope(workspaceId, categoryId, workspaceSessionIds) {
  const wanted = typeof categoryId === 'string' ? categoryId.trim() : ''
  if (wanted === '') return { active: false, allowed: null }
  const path = categoryStorePath(workspaceId)
  if (path === null) return { active: false, allowed: null }

  // 直接读原文：必须区分"文件缺失"（无过滤）与"空 store"（分类不存在 →
  // 空结果）。readCategoryStoreFile 会把 ENOENT 折成空 store，这里不能用。
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { active: false, allowed: null }
  }
  let store
  try {
    store = JSON.parse(text)
  } catch {
    return { active: false, allowed: null }
  }
  if (!isPlainObject(store)) return { active: false, allowed: null }

  const ids = (Array.isArray(workspaceSessionIds) ? workspaceSessionIds : []).map(String)
  const known = knownCategoryIdsOf(store)
  const allowed = new Set()

  if (wanted === CATEGORY_NONE_FILTER) {
    for (const sessionId of ids) {
      const assigned = assignedCategoryOf(store, sessionId)
      if (assigned === null || !known.has(assigned)) allowed.add(sessionId)
    }
    return { active: true, allowed }
  }

  if (!known.has(wanted)) return { active: true, allowed }
  const subtree = categorySubtreeIdsOf(store, wanted)
  for (const sessionId of ids) {
    const assigned = assignedCategoryOf(store, sessionId)
    if (assigned !== null && subtree.has(assigned)) allowed.add(sessionId)
  }
  return { active: true, allowed }
}

/**
 * 请求里出现的 sessionIds 约束（`filters.sessionIds` 与顶层 `sessionIds`）。
 *
 * 多个非空列表取交集；全都没给返回 null（不限制）。空数组沿用内核口径
 * 视为"不限制"。
 */
function requestedSessionIdSet(request) {
  const lists = []
  if (Array.isArray(request?.sessionIds)) lists.push(request.sessionIds)
  if (isPlainObject(request?.filters) && Array.isArray(request.filters.sessionIds)) {
    lists.push(request.filters.sessionIds)
  }
  const sets = lists
    .filter(list => list.length > 0)
    .map(list => new Set(list.map(String)))
  if (sets.length === 0) return null
  let allowed = sets[0]
  for (const set of sets.slice(1)) {
    allowed = new Set([...allowed].filter(id => set.has(id)))
  }
  return allowed
}

/**
 * 索引不可用时的检索兜底：现场读日志、用 turn-index 的全文抽取重建轮次。
 *
 * 不走旧 `/find` 的 80/160 预览——检索要求"结果完整但慢"，先把这一轮搜
 * 全，慢是索引缺失的代价；读完失败就当没有轮次。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @returns 轮次行数组（无 sessionId/title，由调用方 stamp）。
 */
async function searchFallbackTurns(ctx, sessionId) {
  try {
    return buildTurnRows(await readEventsOrThrow(ctx, sessionId))
  } catch {
    return []
  }
}

/**
 * 读工作区的状态标签（F-4 的 `labels/<workspaceId>.json`）。
 *
 * P1-1 之前标签层可能不存在；文件缺失/损坏都当"没有标签"，不影响检索。
 * 兼容扁平 `{ 'sid#turn': label }` 与 `{ labels: {...} }` 两种顶层形状。
 *
 * @param workspaceId - 工作区 id。
 * @returns 标签对象，或 undefined。
 */
async function loadWorkspaceLabels(workspaceId) {
  try {
    // 检索只关心状态位：文件损坏/缺失都当"没有标签"，不能让检索失败。
    const doc = await readLabelsDocument(String(workspaceId ?? 'default'))
    return doc.ok && doc.count > 0 ? doc.labels : undefined
  } catch {
    return undefined
  }
}

/**
 * 给检索命中补代码块计数。
 *
 * 口径与 `/session-commands` 完全一致：该轮 response 的 markdown 围栏代码块
 * 数量，**不是** tool/call 命令数。`commandCount` 保留为旧界面别名字段，
 * `blockCount` 是推荐字段；分组对象上两者都是组内合计。
 *
 * 只解析命中轮次的 response，不预扫全库。
 */
function attachCodeBlockCounts(hits, turnsByKey) {
  return hits.map(hit => {
    if (Array.isArray(hit.hits)) {
      const inner = attachCodeBlockCounts(hit.hits, turnsByKey)
      const count = inner.reduce((sum, item) => sum + (item.blockCount ?? 0), 0)
      return { ...hit, hits: inner, blockCount: count, commandCount: count }
    }
    const row = turnsByKey.get(`${hit.sessionId}#${hit.turn}`)
    const count = codeBlocksOf(row?.response ?? '').length
    return { ...hit, blockCount: count, commandCount: count }
  })
}

/**
 * 按会话 id 反查它所属的工作区。
 *
 * 用于 `/search` 没给 workspaceId 时确定检索范围——**不做"退第一个工作区"**
 * 的猜测，查不到就由调用方报"当前会话不属于任何工作区"。
 *
 * @param ctx - Host context。
 * @param sessionId - 当前会话 id。
 * @returns Workspace，或 undefined。
 */
function workspaceOfSession(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  try {
    const all = registry.list()
    if (!Array.isArray(all)) return undefined
    const wanted = String(sessionId)
    return all.find(workspace => Array.from(workspace?.sessionIds ?? []).some(id => String(id) === wanted))
  } catch {
    return undefined
  }
}

/**
 * 跨会话检索端点（P0-3）。
 *
 * 检索范围（按优先级）：
 *   1. 显式 `workspaceId`；
 *   2. 请求带 `sessionId` 时，按它反查所属工作区；
 *   3. 两个都没给时退回第一个工作区（兼容旧调用）。
 * 反解失败不静默退第一个：返回 `workspace:null` + `reason`。
 *
 * 索引不可用就现场读日志（结果不能缺），同时把缺索引的会话排进后台队列；
 * `coverage.indexing` 是本次真正排进队列的数量。
 *
 * 分类过滤（历史页）：`categoryId` 命中该分类及其全部后代；`__none__`
 * 表示未归类。分类文件缺失/损坏视为无过滤；与请求里的 sessionIds 取交集。
 *
 * 分页：`offset` 缺省/非法归 0；`limit` 语义不变（默认 50、封顶 200）。
 * 排序/分组完成后才取 `offset..offset+limit`；`total` 仍是过滤后总命中数，
 * `hasMore` 在扁平模式按命中数、分组模式按组数判断。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId?, sessionId?, keywords, timeRange?, filters?, categoryId?, offset?, limit?, groupBy?, sort?, now?}`。
 * @returns `{hits, total, truncated, offset, hasMore, scanned, elapsedMs, indexed, coverage, workspace, workspaceId, reason?}`。
 */
export async function searchWorkspaceIndex(ctx, body = {}) {
  const started = Date.now()
  const request = isPlainObject(body) ? body : {}
  const offset = clampSearchOffset(request.offset)
  const pageLimit = clampSearchLimit(request.limit) ?? SEARCH_DEFAULT_LIMIT
  const groupBy = request.groupBy === 'session' ? 'session' : 'none'
  const empty = {
    hits: [],
    total: 0,
    truncated: false,
    offset,
    hasMore: false,
    scanned: 0,
    elapsedMs: 0,
    indexed: { ready: 0, missing: 0 },
    coverage: { sessions: 0, indexed: 0, scannedFromLog: 0, indexing: 0 },
    workspace: null,
    workspaceId: null,
  }

  const explicitWorkspaceId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
  const requestSessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
  let workspace
  if (explicitWorkspaceId !== '' || requestSessionId === '') {
    workspace = resolveWorkspace(ctx, explicitWorkspaceId === '' ? undefined : explicitWorkspaceId)
  } else {
    workspace = workspaceOfSession(ctx, requestSessionId)
    if (workspace === undefined) {
      return {
        ...empty,
        elapsedMs: Date.now() - started,
        reason: '当前会话不属于任何工作区',
      }
    }
  }
  if (workspace === undefined) return { ...empty, elapsedMs: Date.now() - started }

  const workspaceInfo = { id: workspace.id, path: workspace.path, title: workspace.title }
  // 分类过滤先算允许集合，再与请求里的 sessionIds 求交集；分类文件缺失/
  // 损坏时 `active:false`，退回原有的 filters.sessionIds 行为，不报错。
  const workspaceSessionIds = Array.isArray(workspace.sessionIds)
    ? workspace.sessionIds.map(String)
    : []
  const categoryScope = await resolveCategorySessionScope(
    workspace.id,
    request.categoryId,
    workspaceSessionIds,
  )
  let ids
  if (categoryScope.active) {
    ids = workspaceSessionIds.filter(id => categoryScope.allowed.has(id))
    const requested = requestedSessionIdSet(request)
    if (requested !== null) ids = ids.filter(id => requested.has(id))
  } else {
    ids = narrowSessionIds(workspace.sessionIds, request.filters)
  }
  const titles = await readTitleMap(ctx, ids)
  const dir = defaultSessionsDir()
  const indexed = { ready: 0, missing: 0 }
  let indexing = 0
  const turns = []

  for (const sessionId of ids) {
    const title = titles.get(sessionId) ?? sessionId
    let revision = null
    try {
      revision = await readRevision(ctx, sessionId)
    } catch {
      revision = null
    }

    let rows = null
    if (revision !== null && dir !== '') {
      const file = await readIndexFile(dir, sessionId)
      if (file.ok && file.meta.revision === revision) rows = file.turns
    }

    if (rows !== null) {
      indexed.ready += 1
    } else {
      indexed.missing += 1
      // 不等待：本次先用日志兜底，同时后台补索引（同会话去重 + 60s 节流）。
      // force：这里已经完整读过索引并确认不可用，别再让 meta 快速路径把
      // "meta 完好但轮次行损坏"的文件当成新鲜索引跳过。
      if (queueSessionIndexSync(ctx, sessionId, { revision, force: true })) indexing += 1
      rows = await searchFallbackTurns(ctx, sessionId)
    }

    for (const row of rows) turns.push({ ...row, sessionId, title })
  }

  // 分页要发生在排序/分组之后：向内核多要 offset + limit + 1 条（分组模式
  // 是"组"数），再从第 offset 条切片。+1 只为精确判断分组模式是否还有下一页。
  const fetchLimit = Math.min(Number.MAX_SAFE_INTEGER, offset + pageLimit + 1)
  const result = searchTurns(turns, {
    keywords: request.keywords,
    timeRange: request.timeRange,
    filters: request.filters,
    limit: fetchLimit,
    groupBy,
    sort: request.sort,
    now: typeof request.now === 'number' && Number.isFinite(request.now) ? request.now : Date.now(),
    labels: await loadWorkspaceLabels(workspace.id),
  })

  const pageHits = result.hits.slice(offset, offset + pageLimit)
  const hasMore = groupBy === 'session'
    // 分组模式按"组数"判断：内核最多回 fetchLimit 组，超过 offset+limit 组即还有。
    ? result.hits.length > offset + pageLimit
    : offset + pageHits.length < result.total

  const turnsByKey = new Map(turns.map(row => [`${row.sessionId}#${row.turn}`, row]))
  return {
    hits: attachCodeBlockCounts(pageHits, turnsByKey),
    total: result.total,
    truncated: hasMore,
    offset,
    hasMore,
    scanned: ids.length,
    elapsedMs: Date.now() - started,
    indexed,
    coverage: {
      sessions: ids.length,
      indexed: indexed.ready,
      scannedFromLog: indexed.missing,
      indexing,
    },
    workspace: workspaceInfo,
    workspaceId: workspaceInfo.id,
  }
}

// ── 单轮详情（A-1 定位的数据接口） ────────────────────────────────

/** 前后邻居最多各取几轮。 */
const TURN_DETAIL_NEIGHBOR_MAX = 3

/** 兜底读日志的超时：索引缺失可以慢，但不能把请求挂住。 */
const TURN_DETAIL_TIMEOUT_MS = 2000

/** 提问首句（≤40 字），与检索内核的 L0 摘要同口径。 */
function promptHeadOf(prompt) {
  const text = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  const stop = text.search(/[。！？!?；;]/)
  const sentence = (stop === -1 ? text : text.slice(0, stop)).trim()
  return (sentence === '' ? text : sentence).slice(0, 40)
}

/** before/after 归一：默认 1，非法值回退默认，负数当 0，封顶 3。 */
function neighborCount(value) {
  if (value === undefined || value === null || value === '') return 1
  const n = Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.max(0, Math.min(TURN_DETAIL_NEIGHBOR_MAX, Math.floor(n)))
}

/**
 * 轮次行 → 详情视图。
 *
 * 字段与契约一一对应；索引行与日志兜底行形状相同，所以投影只有这一处。
 *
 * @param row - 索引行或 `buildTurnRows` 的行。
 * @returns 详情对象。
 */
function turnDetailOf(row) {
  return {
    turn: row.turn,
    seq: row.seq ?? null,
    start: row.start ?? null,
    end: row.end ?? null,
    ms: row.ms ?? null,
    prompt: typeof row.prompt === 'string' ? row.prompt : '',
    response: typeof row.response === 'string' ? row.response : '',
    model: row.model ?? null,
    usage: row.usage ?? emptyUsage(),
    endReason: row.endReason ?? 'open',
    interrupted: row.interrupted === true,
    steps: Number.isFinite(row.steps) ? row.steps : 0,
    tools: Array.isArray(row.tools) ? row.tools : [],
    files: Array.isArray(row.files) ? row.files : [],
    commands: Array.isArray(row.commands) ? row.commands : [],
    changes: row.changes ?? null,
    truncated: row.truncated === true,
  }
}

/** 轮次行 → 邻居精简行（给"上一轮/下一轮"用，不夹带全文）。 */
function turnNeighborOf(row) {
  return {
    turn: row.turn,
    promptHead: promptHeadOf(row.prompt),
    time: row.end ?? row.start ?? null,
    endReason: row.endReason ?? 'open',
  }
}

/**
 * 把索引行里的 `changes` 按轮次合并到日志兜底行。
 *
 * revision 不一致时不能整份用索引（prompt/response 可能过期），但 F-7 的
 * `changes` 只存在于索引行里，日志折叠不会产生它。合并规则：
 *   - 只认 `file.ok` 的索引；
 *   - 按 turn 对齐，只补日志行没有的 changes；
 *   - 索引行 endSeq 非 null 时必须与日志行 endSeq 完全一致，防止把别的内容
 *     贴到错轮；索引行 endSeq 为 null（当时轮次还没终结）时退化为按 turn
 *     号合并；
 *   - prompt/response/commands 等仍以日志行为准，绝不用索引覆盖。
 *
 * @param rows - `buildTurnRows` 的日志行（原地写）。
 * @param file - `readIndexFile` 的返回值（可空/损坏）。
 * @returns 合并后的 rows。
 */
function mergeIndexChanges(rows, file) {
  if (!file || file.ok !== true || !Array.isArray(file.turns)) return rows
  const byTurn = new Map()
  for (const row of file.turns) {
    if (!row || !Number.isFinite(row.turn)) continue
    if (row.changes === undefined || row.changes === null) continue
    byTurn.set(row.turn, row)
  }
  if (byTurn.size === 0) return rows
  for (const row of rows) {
    const indexed = byTurn.get(row.turn)
    if (indexed === undefined) continue
    // 日志行若已经有 changes（未来可能来自日志本身），不覆盖。
    if (row.changes !== undefined && row.changes !== null) continue
    const indexedEnd = indexed.endSeq
    if (indexedEnd !== null && indexedEnd !== undefined && row.endSeq !== indexedEnd) continue
    row.changes = indexed.changes
  }
  return rows
}

/**
 * 取一个会话的轮次行：索引优先，索引缺失/损坏/过期退回日志全文抽取。
 *
 * 与 `/search` 同一套判定，但这里读失败要抛出来——详情端点必须区分
 * "会话读不到"和"轮次不存在"。不写任何落盘逻辑。
 *
 * revision 不一致（活会话几乎总在变）时走日志兜底，但**不能丢掉 F-7 的
 * changes**：回退前若索引可读，按 turn/endSeq 把 changes 合并回来。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @returns 轮次行数组。
 * @throws 会话读不到时抛出。
 */
async function loadTurnDetailRows(ctx, sessionId) {
  const dir = defaultSessionsDir()
  let revision = null
  try {
    revision = await readRevision(ctx, sessionId)
  } catch {
    revision = null
  }
  // 索引读取失败不影响详情：合并是"尽力而为"，读日志才是兜底主体。
  let file = null
  if (dir !== '') {
    try {
      file = await readIndexFile(dir, sessionId)
    } catch {
      file = null
    }
  }
  if (revision !== null && file !== null && file.ok && file.meta.revision === revision) {
    return file.turns
  }
  const snapshot = await ctx.sessionQuery.readSession(sessionId)
  if (snapshot === null || snapshot === undefined) throw new Error('会话不存在')
  const rows = buildTurnRows(Array.isArray(snapshot.events) ? snapshot.events : [])
  return mergeIndexChanges(rows, file)
}

/**
 * 给一次读取加超时。
 *
 * 超时后底层 promise 可能还在跑（读日志无法取消），这里只保证请求不再
 * 等待它；不写盘，所以迟到的结果不会造成副作用。
 *
 * @param promise - 要等的异步操作。
 * @param timeoutMs - 上限（毫秒）。
 * @returns promise 的结果。
 * @throws 超时抛 `读取该会话超时`。
 */
async function withDetailTimeout(promise, timeoutMs) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('读取该会话超时')), Math.max(1, timeoutMs))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 会话属于哪个工作区（标签按 workspaceId 存；找不到返回空串）。 */
function workspaceIdOfSession(ctx, sessionId) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return ''
  try {
    for (const workspace of registry.list()) {
      const ids = Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []
      if (ids.some(id => String(id) === sessionId)) return String(workspace.id ?? '')
    }
  } catch {
    // 注册表异常只影响标签，不影响详情主体。
  }
  return ''
}

/**
 * 取该轮的标签。
 *
 * 复用 labels 那套归一化；没标签 / 不认识这个会话 / 标签文件损坏都返回
 * null——详情主体不能因为标签不可读而失败。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @param turn - 轮次。
 * @returns 归一化标签或 null。
 */
async function labelOfTurn(ctx, sessionId, turn) {
  try {
    const workspaceId = workspaceIdOfSession(ctx, sessionId)
    if (workspaceId === '') return null
    const doc = await readLabelsDocument(workspaceId)
    if (!doc.ok) return null
    return doc.labels[`${sessionId}#${turn}`] ?? null
  } catch {
    return null
  }
}

/**
 * 单轮详情（POST /api/topic-map/turn-detail）。
 *
 * 只回该会话该轮：详情字段 + 前后邻居的精简行 + 标签。索引命中时不做
 * 任何日志读取；索引不可用才现场读日志抽全文，并受 2 秒超时保护。
 *
 * @param ctx - Host context。
 * @param body - `{sessionId, turn, before?, after?}`。
 * @param options - `{timeoutMs}`，测试可注入更短的超时。
 * @returns `{ok:true, value:{turn, neighbors, label}}` 或
 *   `{ok:false, error, httpStatus}`。
 */
export async function readTurnDetail(ctx, body = {}, options = {}) {
  const request = isPlainObject(body) ? body : {}
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
  if (sessionId === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }
  if (!validLabelTurn(request.turn)) return { ok: false, error: 'turn 非法', httpStatus: 400 }

  const turn = request.turn
  const before = neighborCount(request.before)
  const after = neighborCount(request.after)
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : TURN_DETAIL_TIMEOUT_MS

  let rows
  try {
    rows = await withDetailTimeout(loadTurnDetailRows(ctx, sessionId), timeoutMs)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '读取该会话超时') {
      return { ok: false, error: '读取该会话超时', httpStatus: 504 }
    }
    return { ok: false, error: '读不到该会话', httpStatus: 502 }
  }

  const index = rows.findIndex(row => row.turn === turn)
  if (index === -1) return { ok: false, error: '轮次不存在', httpStatus: 404 }

  const neighbors = []
  for (const row of rows.slice(Math.max(0, index - before), index)) {
    neighbors.push(turnNeighborOf(row))
  }
  for (const row of rows.slice(index + 1, index + 1 + after)) {
    neighbors.push(turnNeighborOf(row))
  }

  const value = {
    turn: turnDetailOf(rows[index]),
    neighbors,
    label: await labelOfTurn(ctx, sessionId, turn),
  }
  // 详情已成功返回：摘要预生成只入队，绝不 await（详情响应不被模型拖住）。
  queueTurnDigest(ctx, sessionId, turn)
  return { ok: true, value }
}

/** 命令清单分页：offset 默认 0（负数/非法都归 0）。 */
function normalizeCommandOffset(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** 命令清单分页：limit 默认 20、封顶 100。 */
function normalizeCommandLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 20
  return Math.min(100, Math.floor(n))
}

/**
 * `lang:'shell'` 语言组：只匹配这些围栏语言（大小写不敏感）。
 */
const SHELL_FENCE_LANGS = new Set([
  'bash', 'sh', 'shell', 'zsh', 'powershell', 'ps1', 'bat', 'cmd', 'console',
])

/** 围栏语言是否属于 shell 组。 */
function isShellFenceLang(lang) {
  return SHELL_FENCE_LANGS.has(String(lang ?? '').toLowerCase())
}

/**
 * 会话命令清单（复制浮窗用，A-2）。
 *
 * 只提取 assistant 回答里的 markdown 围栏代码块：一条命令 = 一个代码块，
 * 不包含 tool/call 产生的命令（那是执行动作，不是对话内容）。
 * 块按轮号升序、轮内出现顺序排列；`text` 保留块内换行。
 * `seq` 在合并全量时分配，过滤后保留原序号（命令身份不随筛选变化）。
 * `q` 大小写不敏感匹配 text；`lang` 默认 `*` = 全部，`'shell'` = shell 语言组
 * （bash/sh/shell/zsh/powershell/ps1/bat/cmd/console，大小写不敏感），
 * `''` = 只看无标注，其它值按语言标注精确匹配。过滤先于分页。
 *
 * @param ctx - Host context。
 * @param body - `{sessionId, offset?, limit?, q?, lang?}`。
 * @returns `{ok:true, value:{total, offset, limit, hasMore, commands}}` 或
 *   `{ok:false, error, httpStatus}`。
 */
export async function listSessionCommands(ctx, body = {}) {
  const request = isPlainObject(body) ? body : {}
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
  if (sessionId === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }
  const offset = normalizeCommandOffset(request.offset)
  const limit = normalizeCommandLimit(request.limit)
  const q = typeof request.q === 'string' ? request.q.trim().toLowerCase() : ''
  const rawLang = typeof request.lang === 'string' ? request.lang.trim() : '*'
  const lang = rawLang.toLowerCase() === 'shell' ? 'shell' : rawLang

  let rows
  try {
    rows = await withDetailTimeout(loadTurnDetailRows(ctx, sessionId), 2000)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '读取该会话超时') return { ok: false, error: '读取该会话超时', httpStatus: 504 }
    return { ok: false, error: '读不到该会话', httpStatus: 502 }
  }

  const merged = []
  const ordered = [...rows].sort((a, b) => Number(a.turn) - Number(b.turn))
  for (const row of ordered) {
    let blocks = []
    try {
      blocks = codeBlocksOf(row.response)
    } catch {
      blocks = []
    }
    for (const block of blocks) {
      merged.push({ turn: row.turn, lang: block.lang, text: block.text })
    }
  }

  // seq 是命令的全会话身份；过滤只缩小结果集，不重排/重编号。
  const all = merged.map((command, index) => ({ seq: index + 1, ...command }))
  const filtered = all.filter(command => {
    if (lang === 'shell') {
      if (!isShellFenceLang(command.lang)) return false
    } else if (lang !== '*' && command.lang !== lang) {
      return false
    }
    if (q !== '' && !command.text.toLowerCase().includes(q)) return false
    return true
  })

  const page = filtered.slice(offset, offset + limit)
  return {
    ok: true,
    value: {
      total: filtered.length,
      offset,
      limit,
      hasMore: offset + page.length < filtered.length,
      commands: page,
    },
  }
}

// ── 历史轨 / 历史管理 / 简报 / 统计（P1 历史管理） ────────────────

/** 大纲读取超时：历史轨是前台操作，不能无限等日志。 */
const OUTLINE_TIMEOUT_MS = 3000
/** 分叉 / 重试前读轮次的超时。 */
const FORK_ROWS_TIMEOUT_MS = 3000
/** 简报按会话读取的超时（工作区多会话时逐个兜底）。 */
const BRIEF_SESSION_TIMEOUT_MS = 5000
/** 统计按会话读取的超时。 */
const STATS_SESSION_TIMEOUT_MS = 5000

/** 重试去重表：模块级共享，同会话同轮 5 分钟内不重复执行。 */
const retryDedupeRegistry = createRetryDeduper()

/** 选项里的正数超时；非法值用兜底。 */
function timeoutOption(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * 取宿主 sessionController（可选服务）。
 *
 * Cordis 的严格代理在未 inject 时属性访问会抛，`ctx.get` 是安全入口；
 * 拿不到返回 undefined，由端点回 503 而不是把原样异常抛给客户端。
 *
 * @param ctx - Host context。
 * @returns sessionController 或 undefined。
 */
function sessionControllerOf(ctx) {
  try {
    const controller = ctx.get('sessionController')
    return controller === null ? undefined : controller
  } catch {
    return undefined
  }
}

/**
 * 是否是"会话不存在"的读取错误。
 *
 * 宿主 `sessionQuery.readSession` 对不存在的会话是**抛错**（不是返回
 * null），错误码为 `SESSION_QUERY_SESSION_NOT_FOUND`；RemoteError 则用
 * `session/not-found`。两类都要映射成 404，而不是笼统的 502。
 *
 * @param error - 读取抛出的错误。
 * @returns 是否属于"会话不存在"。
 */
function isSessionMissingError(error) {
  const code = typeof error?.code === 'string' ? error.code : ''
  if (code === 'SESSION_QUERY_SESSION_NOT_FOUND' || code === 'session/not-found') return true
  const message = error instanceof Error ? error.message : ''
  return /session[^\n]{0,80}not found|会话不存在|未找到该会话/i.test(message)
}

/**
 * 统一读轮次行：索引优先，索引缺失/损坏/过期退回日志；三类失败收敛成
 * 端点信封（400 由调用方负责，这里只处理读取）。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @param timeoutMs - 读取上限。
 * @returns `{ok:true, rows}` 或 `{ok:false, error, httpStatus}`。
 */
async function loadEndpointRows(ctx, sessionId, timeoutMs) {
  try {
    const rows = await withDetailTimeout(loadTurnDetailRows(ctx, sessionId), timeoutMs)
    return { ok: true, rows }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '读取该会话超时') return { ok: false, error: '读取该会话超时', httpStatus: 504 }
    if (message === '会话不存在' || isSessionMissingError(error)) {
      return { ok: false, error: '会话不存在', httpStatus: 404 }
    }
    return { ok: false, error: '读不到该会话', httpStatus: 502 }
  }
}

/**
 * 会话是否正在运行（拿不到状态时按"没在跑"处理）。
 *
 * 宿主没有单独的 running 查询，`sessionController.list` 的 SessionSummary
 * 带 `running` 是唯一权威来源；该调用失败只影响这层提前拦截，最终仍由
 * 宿主 fork 自己裁决，所以失败不报错。
 *
 * @param controller - sessionController（可为 undefined）。
 * @param sessionId - 会话 id。
 * @returns 是否正在运行。
 */
async function sessionRunningOf(controller, sessionId) {
  if (controller === undefined || typeof controller.list !== 'function') return false
  try {
    const value = await controller.list({}, new AbortController().signal)
    const items = Array.isArray(value?.items) ? value.items : []
    return items.some(item => String(item?.sessionId ?? '') === sessionId && item?.running === true)
  } catch {
    return false
  }
}

/**
 * 批量读会话标题（展示用；失败退回空表，端点不该因标题读不到而失败）。
 *
 * @param ctx - Host context。
 * @param ids - 会话 id 数组。
 * @returns `Map<sessionId, title>`。
 */
async function readSessionTitles(ctx, ids) {
  const map = new Map()
  if (!Array.isArray(ids) || ids.length === 0) return map
  try {
    if (typeof ctx.sessionQuery?.readTitleSnapshots === 'function') {
      for (const item of await ctx.sessionQuery.readTitleSnapshots(ids)) {
        if (item?.status === 'fulfilled' && typeof item.value?.title?.title === 'string') {
          map.set(item.sessionId, item.value.title.title)
        }
      }
    }
  } catch {
    // 标题只是展示用。
  }
  return map
}

/**
 * 给大纲行补 `start`（该轮 `turn/start` 时间，缺失为 null）。
 *
 * 大纲投影在 `lib/outline.js` 里只输出 `time`（end 优先），但历史轨
 * "这一轮是什么时候开始的"需要 start。这里按 turn 号从原始轮次行回填，
 * 不改 `time` 语义，旧消费者仍可只读原字段。
 *
 * @param outline - `buildSessionOutline` 的输出 `{turns}`。
 * @param rows - 原始轮次行（含 `start`）。
 * @returns `{turns}`，每行多一个 `start`。
 */
function withOutlineStart(outline, rows) {
  const starts = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    if (!Number.isInteger(row.turn) || row.turn < 0) continue
    if (starts.has(row.turn)) continue
    starts.set(row.turn, Number.isFinite(row.start) ? row.start : null)
  }
  return {
    ...outline,
    turns: (Array.isArray(outline?.turns) ? outline.turns : []).map(row => ({
      ...row,
      start: starts.get(row.turn) ?? null,
    })),
  }
}

/**
 * 会话大纲（POST /api/topic-map/session-outline）。
 *
 * 给历史轨用：索引优先、日志兜底，只回窄字段，不含提问/回答全文。
 * 每行含 `{turn, promptHead, time, start, endReason, endSeq}`：`time` 仍是
 * end 优先（兼容旧消费者），`start` 是该轮开始时间，缺失为 null。
 *
 * @param ctx - Host context。
 * @param body - `{sessionId}`。
 * @param options - `{timeoutMs}`，测试可注入更短的超时。
 * @returns `{ok:true, value:{turns}}` 或 `{ok:false, error, httpStatus}`。
 */
export async function readSessionOutline(ctx, body = {}, options = {}) {
  const request = isPlainObject(body) ? body : {}
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
  if (sessionId === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }
  const timeoutMs = timeoutOption(options?.timeoutMs, OUTLINE_TIMEOUT_MS)

  const loaded = await loadEndpointRows(ctx, sessionId, timeoutMs)
  if (loaded.ok !== true) return loaded
  return { ok: true, value: withOutlineStart(buildSessionOutline(loaded.rows), loaded.rows) }
}

/** 组装分叉 / 重试的注入依赖（每次请求绑定当前 ctx 与超时）。 */
function forkEndpointDeps(ctx, options = {}) {
  const controller = sessionControllerOf(ctx)
  const timeoutMs = timeoutOption(options?.timeoutMs, FORK_ROWS_TIMEOUT_MS)
  const registry = options?.registry ?? retryDedupeRegistry
  return {
    registry,
    available: () => controller !== undefined && typeof controller.fork === 'function',
    loadRows: sessionId => loadEndpointRows(ctx, sessionId, timeoutMs),
    isRunning: sessionId => sessionRunningOf(controller, sessionId),
    forkAt: request => controller.fork(request),
    renameSession: request => controller.rename(request),
    submitPrompt: request => controller.prompt({
      requestId: request.requestId,
      sessionId: request.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: request.text }],
    }, new AbortController().signal),
    newRequestId: () => `topic-map-retry-${randomUUID()}`,
  }
}

/**
 * 在会话第 N 轮之前分叉（POST /api/topic-map/fork）。
 *
 * `atSeq = turn/start 序 - 1`：宿主契约是 inclusive source event seq，
 * 退一格才能把第 N 轮的提问排除在新会话之外。
 *
 * @param ctx - Host context。
 * @param body - `{sessionId, turn, title?}`。
 * @param options - `{timeoutMs}`。
 * @returns `{ok:true, value:{sessionId, atSeq, turn}}` 或错误信封。
 */
export async function forkSession(ctx, body = {}, options = {}) {
  const endpoints = createForkEndpoints(forkEndpointDeps(ctx, options))
  return endpoints.fork(body)
}

/**
 * 重试第 N 轮（POST /api/topic-map/retry）：先在第 N 轮之前分叉，再把
 * 该轮 prompt 提交给新会话；同会话同轮 5 分钟内去重。
 *
 * @param ctx - Host context。
 * @param body - `{sessionId, turn}`。
 * @param options - `{timeoutMs, registry?}`。
 * @returns `{ok:true, value:{sessionId, prompt}}` 或错误信封。
 */
export async function retryTurn(ctx, body = {}, options = {}) {
  const deps = forkEndpointDeps(ctx, options)
  const endpoints = createForkEndpoints(deps)
  return endpoints.retry(body, { registry: deps.registry })
}

/**
 * 解析简报范围：会话优先，否则工作区（缺省用当前工作区）。
 *
 * @param ctx - Host context。
 * @param selection - `normalizeBriefSelection` 的结果。
 * @param timeoutMs - 单会话读取上限。
 * @returns `{ok:true, scope}` 或错误信封。
 */
async function resolveBriefScope(ctx, selection, timeoutMs) {
  if (selection.sessionId !== '') {
    const loaded = await loadEndpointRows(ctx, selection.sessionId, timeoutMs)
    if (loaded.ok !== true) return loaded
    const titles = await readSessionTitles(ctx, [selection.sessionId])
    const title = titles.get(selection.sessionId) ?? selection.sessionId
    return {
      ok: true,
      scope: {
        sessions: [{ sessionId: selection.sessionId, title, rows: loaded.rows }],
        scopeLabel: `会话 ${title}（${selection.sessionId}）`,
        defaultTitle: `会话简报：${title}`,
      },
    }
  }

  const explicit = selection.workspaceId !== ''
  const workspace = resolveWorkspace(ctx, explicit ? selection.workspaceId : undefined)
  if (workspace === undefined) {
    return { ok: false, error: explicit ? '工作区不存在' : '没有可用的工作区', httpStatus: 404 }
  }
  if (explicit && String(workspace.id) !== selection.workspaceId) {
    return { ok: false, error: '工作区不存在', httpStatus: 404 }
  }

  const ids = [...(workspace.sessionIds ?? [])].map(String)
  const titles = await readSessionTitles(ctx, ids)
  const sessions = []
  let failures = 0
  let timeouts = 0
  let missing = 0
  for (const id of ids) {
    const loaded = await loadEndpointRows(ctx, id, timeoutMs)
    if (loaded.ok !== true) {
      failures += 1
      if (loaded.httpStatus === 504) timeouts += 1
      if (loaded.httpStatus === 404) missing += 1
      continue
    }
    sessions.push({ sessionId: id, title: titles.get(id) ?? id, rows: loaded.rows })
  }
  if (ids.length > 0 && sessions.length === 0) {
    if (missing === failures) return { ok: false, error: '工作区里没有可读的会话', httpStatus: 404 }
    return timeouts === failures
      ? { ok: false, error: '读取该工作区超时', httpStatus: 504 }
      : { ok: false, error: '读不到该工作区的会话', httpStatus: 502 }
  }
  return {
    ok: true,
    scope: {
      sessions,
      scopeLabel: `工作区 ${workspace.title ?? workspace.id}（${workspace.id}）`,
      defaultTitle: `工作区简报：${workspace.title ?? workspace.id}`,
    },
  }
}

/**
 * 原子写简报：`~/.dsh/topic-map/briefs/<时间戳>-<slug>.md`。
 *
 * 用 `wx` 打开，同名时追加 `-2`、`-3`……；时间戳只到秒，同一秒内生成
 * 两份简报不该互相覆盖。
 *
 * @param input - `{slug, markdown, atMs}`。
 * @returns `{ok:true, path, bytes}` 或 `{ok:false, error, httpStatus}`。
 */
async function writeBriefFile({ slug, markdown, atMs }) {
  const dir = topicMapDir()
  if (dir === null) {
    return { ok: false, error: '无法确定 DSH 数据目录，简报未写入', httpStatus: 502 }
  }
  const briefs = join(dir, 'briefs')
  const base = briefFileName(atMs, slug)
  try {
    await mkdir(briefs, { recursive: true })
    for (let attempt = 1; attempt <= 50; attempt += 1) {
      const name = attempt === 1 ? base : `${base.slice(0, -3)}-${attempt}.md`
      const path = join(briefs, name)
      try {
        await writeFile(path, markdown, { encoding: 'utf8', flag: 'wx' })
        return { ok: true, path, bytes: Buffer.byteLength(markdown, 'utf8') }
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
    return { ok: false, error: '写入简报失败：同名文件过多', httpStatus: 502 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `写入简报失败：${message.slice(0, 200)}`, httpStatus: 502 }
  }
}

/**
 * 生成 Markdown 简报（POST /api/topic-map/brief）。
 *
 * 结论摘要与 `/turn-digest` 同源（`ensureTurnDigest`：同一份缓存与在途
 * 去重）；摘要失败退回原文摘录，不让模型不可用拖垮整份简报。
 *
 * @param ctx - Host context。
 * @param body - `{sessionId?, workspaceId?, turns?, from?, to?, title?}`。
 * @param options - `{timeoutMs, digest?, maxBytes?, digestBudgetMs?, digestMaxTurns?, now?}`。
 * @returns `{ok:true, value:{path, bytes, turns}}` 或错误信封。
 */
export async function createSessionBrief(ctx, body = {}, options = {}) {
  const timeoutMs = timeoutOption(options?.timeoutMs, BRIEF_SESSION_TIMEOUT_MS)
  const digest = typeof options?.digest === 'function'
    ? options.digest
    : async ({ sessionId, turn, row }) => {
        const result = await ensureTurnDigest(ctx, sessionId, turn, row)
        if (result.ok === true) return { ok: true, summary: result.value.summary }
        return result
      }
  const endpoint = createBriefEndpoint({
    resolveScope: selection => resolveBriefScope(ctx, selection, timeoutMs),
    digestOf: digest,
    writeBrief: writeBriefFile,
    now: typeof options?.now === 'function' ? options.now : () => Date.now(),
    maxBytes: options?.maxBytes,
    digestBudgetMs: options?.digestBudgetMs,
    digestMaxTurns: options?.digestMaxTurns,
  })
  return endpoint(body)
}

/**
 * 单会话 token 合计：索引行 `usage.input` + `usage.output`，缺失/非法记 0。
 *
 * 索引行由 turn-index 累加，本来通常是整数；这里再兜一层非负与取整，
 * 避免脏数据把 JSON 里的"整数"契约破坏掉。
 */
function topSessionTokenCount(rows) {
  let total = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    const usage = row.usage
    if (usage === null || typeof usage !== 'object') continue
    const input = Number(usage.input)
    const output = Number(usage.output)
    if (Number.isFinite(input) && input > 0) total += input
    if (Number.isFinite(output) && output > 0) total += output
  }
  return Math.floor(total)
}

/**
 * `/stats` 的 topSessions：全量算完、排序、再截前 5。
 *
 * 必须先排序再截断，否则 `sortBy:'tokens'` 会变成"只在前 5 个轮数最高的
 * 会话里按 token 排"。默认排序保持原口径：轮数倒序，同轮数按 lastActive
 * 倒序，再按 sessionId 稳定。
 *
 * @param sessions - `[{sessionId,title,rows,lastActive?}]`。
 * @param sortBy - `'turns' | 'tokens'`。
 * @returns 最多 5 条会话行（含 tokens）。
 */
function topSessionsOfStats(sessions, sortBy) {
  const list = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session === null || typeof session !== 'object') continue
    const rows = Array.isArray(session.rows) ? session.rows : []
    if (rows.length === 0) continue

    let lastActive = null
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      for (const time of [row.start, row.end]) {
        if (!Number.isFinite(time)) continue
        if (lastActive === null || time > lastActive) lastActive = time
      }
    }
    if (Number.isFinite(session.lastActive)) {
      if (lastActive === null || session.lastActive > lastActive) lastActive = session.lastActive
    }

    list.push({
      sessionId: String(session.sessionId ?? ''),
      title: typeof session.title === 'string' && session.title !== ''
        ? session.title
        : String(session.sessionId ?? ''),
      turns: rows.length,
      lastActive,
      tokens: topSessionTokenCount(rows),
    })
  }

  list.sort((left, right) => {
    const primary = sortBy === 'tokens'
      ? right.tokens - left.tokens
      : right.turns - left.turns
    if (primary !== 0) return primary
    const leftTime = left.lastActive === null ? -Infinity : left.lastActive
    const rightTime = right.lastActive === null ? -Infinity : right.lastActive
    if (rightTime !== leftTime) return rightTime - leftTime
    return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
  })
  return list.slice(0, 5)
}

/** 统计响应：保留聚合字段，替换 topSessions 并回传有效 sortBy。 */
function statsValue(sessions, sortBy) {
  const aggregated = aggregateWorkspaceStats(sessions)
  return {
    ...aggregated,
    topSessions: topSessionsOfStats(sessions, sortBy),
    sortBy,
  }
}

/**
 * 工作区统计（POST /api/topic-map/stats）。
 *
 * 活跃度为主（本地自然日去重）、用量为辅；会话轮次走索引优先 + 日志兜底。
 * `sortBy` 可选 `'turns' | 'tokens'`：两者都倒序，同值按 lastActive 倒序；
 * 非法/缺省回落 `'turns'`。topSessions 固定前 5，但先排序后截断。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId?, sortBy?}`；缺省用当前（第一个）工作区。
 * @param options - `{timeoutMs}`。
 * @returns `{ok:true, value:{sessions, turns, activeDays, topSessions, usage, sortBy}}` 或错误信封。
 */
export async function readWorkspaceStats(ctx, body = {}, options = {}) {
  const request = isPlainObject(body) ? body : {}
  if (request.workspaceId !== undefined && request.workspaceId !== null && typeof request.workspaceId !== 'string') {
    return { ok: false, error: 'workspaceId 必须是字符串', httpStatus: 400 }
  }
  const sortBy = request.sortBy === 'tokens' ? 'tokens' : 'turns'
  const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
  const explicit = workspaceId !== ''
  const workspace = resolveWorkspace(ctx, explicit ? workspaceId : undefined)
  if (workspace === undefined) {
    return { ok: false, error: explicit ? '工作区不存在' : '没有可用的工作区', httpStatus: 404 }
  }
  if (explicit && String(workspace.id) !== workspaceId) {
    return { ok: false, error: '工作区不存在', httpStatus: 404 }
  }

  const ids = [...(workspace.sessionIds ?? [])].map(String)
  if (ids.length === 0) return { ok: true, value: statsValue([], sortBy) }

  const timeoutMs = timeoutOption(options?.timeoutMs, STATS_SESSION_TIMEOUT_MS)
  const sessions = []
  let failures = 0
  let timeouts = 0
  let missing = 0
  for (const id of ids) {
    const loaded = await loadEndpointRows(ctx, id, timeoutMs)
    if (loaded.ok !== true) {
      failures += 1
      if (loaded.httpStatus === 504) timeouts += 1
      if (loaded.httpStatus === 404) missing += 1
      continue
    }
    sessions.push({ sessionId: id, rows: loaded.rows })
  }
  if (sessions.length === 0) {
    if (missing === failures) return { ok: false, error: '工作区里没有可读的会话', httpStatus: 404 }
    return timeouts === failures
      ? { ok: false, error: '读取该工作区超时', httpStatus: 504 }
      : { ok: false, error: '读不到该工作区的会话', httpStatus: 502 }
  }

  const titles = await readSessionTitles(ctx, ids)
  for (const session of sessions) {
    session.title = titles.get(session.sessionId) ?? session.sessionId
  }
  return { ok: true, value: statsValue(sessions, sortBy) }
}

// ── 索引统计 / 分类实体化 / 变更可视化 / 回滚预演 ────────────────
//
// 这一组端点都只做"读事实 + 少量元数据写"：
//   /index-stats       —— 索引与摘要的文件体积（设置页）
//   /categories 等     —— 分类实体存储（P1-3，人工优先）
//   /changes           —— 某轮变更清单（P3-1，数据来自索引行 changes）
//   /rollback-plan     —— 回滚预演（P3-2，只读，不写工作区文件）

/** 索引体积扫描上限：几百个文件也只是 stat + 首行。 */
const INDEX_STATS_TIMEOUT_MS = 5000
/** 单轮变更读取上限。 */
const CHANGES_TIMEOUT_MS = 3000
/** 回滚预演要逐个读文件算哈希，给宽一点。 */
const ROLLBACK_TIMEOUT_MS = 5000
/** 分类文件都是本地小 JSON，读写很快。 */
const CATEGORY_TIMEOUT_MS = 5000

/**
 * 给端点 I/O 加超时。
 *
 * 超时后底层 promise 可能还在跑（文件 I/O 无法真正取消），但请求不再挂住。
 * 只用于只读或原子写，迟到的结果不会把数据写坏。
 *
 * @param promise - 要等的操作。
 * @param timeoutMs - 上限（毫秒）。
 * @param message - 超时错误文案。
 * @returns promise 的结果。
 */
async function withEndpointTimeout(promise, timeoutMs, message) {
  let timer = null
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(message), { code: 'ETIMEDOUT' }))
    }, Math.max(1, timeoutMs))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 端点异常统一成 502 / 504；不把堆栈泄露给客户端。 */
function endpointFailure(error, label) {
  if (error?.code === 'ETIMEDOUT') {
    return { ok: false, error: `${label}超时`, httpStatus: 504 }
  }
  const message = errorText(error).slice(0, 200)
  return { ok: false, error: `${label}失败：${message}`, httpStatus: 502 }
}

/** 请求体必须是普通对象。 */
function requireRequestBody(body) {
  if (isPlainObject(body)) return null
  return { ok: false, error: '请求参数必须是对象', httpStatus: 400 }
}

/** `workspaceId?` 字段：缺省 / null / 空串都表示"用当前工作区"。 */
function normalizeWorkspaceIdField(request) {
  if (
    request.workspaceId === undefined ||
    request.workspaceId === null ||
    (typeof request.workspaceId === 'string' && request.workspaceId.trim() === '')
  ) {
    return { ok: true, value: undefined }
  }
  if (typeof request.workspaceId !== 'string') {
    return { ok: false, error: 'workspaceId 必须是字符串', httpStatus: 400 }
  }
  return { ok: true, value: request.workspaceId.trim() }
}

/**
 * 解析端点要用的工作区。
 *
 * 与 `resolveWorkspace` 的差异：显式给错 id 时明确 404，不退回第一个。
 * 没有 workspaceRegistry 时，索引统计可以退化成"全库扫描"；分类端点
 * 需要落盘文件名，必须拿到工作区。
 */
function resolveEndpointWorkspace(ctx, requested, options = {}) {
  const required = options.required === true
  const registry = ctx !== null && ctx !== undefined && typeof ctx.get === 'function'
    ? ctx.get('workspaceRegistry')
    : undefined
  if (registry === undefined || registry === null) {
    if (required || requested !== undefined) return { ok: false, error: '工作区不存在', httpStatus: 404 }
    return { ok: true, workspace: null }
  }
  let all
  try {
    all = registry.list()
  } catch (error) {
    return { ok: false, error: `读取工作区失败：${errorText(error).slice(0, 200)}`, httpStatus: 502 }
  }
  if (!Array.isArray(all) || all.length === 0) {
    if (required || requested !== undefined) return { ok: false, error: '工作区不存在', httpStatus: 404 }
    return { ok: true, workspace: null }
  }
  if (requested === undefined) return { ok: true, workspace: all[0] }
  const found = all.find(workspace => String(workspace?.id ?? '') === requested)
  if (found === undefined) return { ok: false, error: '工作区不存在', httpStatus: 404 }
  return { ok: true, workspace: found }
}

// ── /index-stats ─────────────────────────────────────────────────

/**
 * 读一个索引文件的首行 meta，取轮次数。
 *
 * 只读首块 4KB：索引可能几十 MB，为了一行 `turnCount` 读全文不值得。
 * 首行损坏返回 0——体积统计不该因为一个坏文件整体失败。
 *
 * @param path - 索引文件绝对路径。
 * @returns 轮次数（非负整数）。
 */
async function readIndexTurnCount(path) {
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(4096)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (!bytesRead) return 0
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const newline = text.indexOf('\n')
    const line = newline === -1 ? text : text.slice(0, newline)
    const meta = JSON.parse(line)
    if (meta && meta.kind === 'meta' && Number.isFinite(meta.turnCount) && meta.turnCount >= 0) {
      return Math.floor(meta.turnCount)
    }
    return 0
  } catch {
    return 0
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        // 关不上不影响统计。
      }
    }
  }
}

/**
 * 列出目录里满足条件的普通文件并取大小。
 *
 * 目录不存在返回空数组（"还没有索引"是正常状态）；其它读取错误抛出去，
 * 由端点回 502。`options.readdir` / `options.statOf` 供测试注入。
 */
async function scanSizedFiles(dir, filter, options) {
  const readdirImpl = typeof options?.readdir === 'function' ? options.readdir : readdir
  const statImpl = typeof options?.statOf === 'function' ? options.statOf : stat
  let entries
  try {
    entries = await readdirImpl(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return []
    throw error
  }
  if (!Array.isArray(entries)) throw new Error('目录列表格式无效')
  const out = []
  for (const entry of entries) {
    const name = typeof entry === 'string'
      ? entry
      : (typeof entry?.name === 'string' ? entry.name : '')
    if (name === '' || !filter(name)) continue
    if (typeof entry !== 'string' && typeof entry?.isFile === 'function' && !entry.isFile()) continue
    const path = join(dir, name)
    let info
    try {
      info = await statImpl(path)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const size = Number(info?.size)
    out.push({
      name,
      path,
      bytes: Number.isFinite(size) && size > 0 ? Math.floor(size) : 0,
    })
  }
  return out
}

/**
 * 索引体积统计（POST /index-stats）。
 *
 * 统计口径是**文件体积**，不是内容字符数：
 *   - `sessions` / `bytes`   ← `index/sessions/*.jsonl`
 *   - `digests` / `digestBytes` ← `digests/*.json`
 *   - `turns`                ← 每个索引首行 meta 的 `turnCount` 之和
 * 目录缺失一律返回 0；显式给了错误的工作区返回 404；读盘失败 502。
 *
 * @param ctx - Host context（可空；空时不做工作区过滤）。
 * @param body - `{workspaceId?}`。
 * @param options - `{timeoutMs, sessionsDir, digestsDir, readdir, statOf, turnCountOf}`。
 * @returns `{ok:true,value:{sessions,turns,bytes,digests,digestBytes}}` 或错误信封。
 */
export async function readIndexStats(ctx, body = {}, options = {}) {
  const badBody = requireRequestBody(body)
  if (badBody !== null) return badBody
  const request = body
  const wsField = normalizeWorkspaceIdField(request)
  if (!wsField.ok) return wsField
  const ws = resolveEndpointWorkspace(ctx, wsField.value)
  if (!ws.ok) return ws

  const sessionsDir = typeof options?.sessionsDir === 'string'
    ? options.sessionsDir
    : defaultSessionsDir()
  const digestDir = typeof options?.digestsDir === 'string'
    ? options.digestsDir
    : digestsDir()
  if (sessionsDir === '' || digestDir === null) {
    return { ok: false, error: '无法确定 DSH home', httpStatus: 502 }
  }

  const workspace = ws.workspace
  const indexNames = new Set()
  const digestPrefixes = []
  if (workspace !== null) {
    for (const rawId of Array.isArray(workspace?.sessionIds) ? workspace.sessionIds : []) {
      const id = String(rawId)
      try {
        indexNames.add(basename(indexFilePath(sessionsDir, id)))
      } catch {
        // 非法会话 id 不可能有索引文件，忽略。
      }
      digestPrefixes.push(`${safeSessionId(id)}#`)
    }
  }
  const filterIndex = name =>
    name.endsWith('.jsonl') && (workspace === null || indexNames.has(name))
  const filterDigest = name =>
    name.endsWith('.json') &&
    (workspace === null || digestPrefixes.some(prefix => name.startsWith(prefix)))

  const timeoutMs = timeoutOption(options?.timeoutMs, INDEX_STATS_TIMEOUT_MS)
  const turnCountOf = typeof options?.turnCountOf === 'function'
    ? options.turnCountOf
    : readIndexTurnCount
  try {
    const [indexFiles, digestFiles] = await withEndpointTimeout(
      Promise.all([
        scanSizedFiles(sessionsDir, filterIndex, options),
        scanSizedFiles(digestDir, filterDigest, options),
      ]),
      timeoutMs,
      '读取索引统计',
    )
    const turns = await withEndpointTimeout(
      Promise.all(indexFiles.map(file => turnCountOf(file.path))),
      timeoutMs,
      '读取索引统计',
    )
    return {
      ok: true,
      value: {
        sessions: indexFiles.length,
        turns: turns.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0),
        bytes: indexFiles.reduce((sum, file) => sum + file.bytes, 0),
        digests: digestFiles.length,
        digestBytes: digestFiles.reduce((sum, file) => sum + file.bytes, 0),
      },
    }
  } catch (error) {
    return endpointFailure(error, '读取索引统计')
  }
}

// ── 分类实体化（P1-3） ───────────────────────────────────────────

/** 分类文件目录：`<topic-map>/categories`。 */
function categoriesDir() {
  const dir = topicMapDir()
  return dir === null ? null : join(dir, 'categories')
}

/** 分类文件路径：`<topic-map>/categories/<workspaceId>.json`。 */
function categoryStorePath(workspaceId) {
  const dir = categoriesDir()
  if (dir === null) return null
  const safe = String(workspaceId ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_')
  return join(dir, `${safe}.json`)
}

/** 读一份分类 store；文件不存在按空 store，损坏则报错，不静默覆盖。 */
async function readCategoryStoreFile(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyStore()
    throw error
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('分类文件损坏')
  }
  if (!isPlainObject(raw)) throw new Error('分类数据格式无法识别')
  return raw
}

/** 原子写分类 store（tmp + rename）。 */
async function writeCategoryStoreFile(path, store) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
    await rename(tmp, path)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {
      // tmp 可能根本没写出来；原错误更重要。
    }
    throw error
  }
}

/** 同一工作区的分类写操作串行化，避免读改写互相覆盖。 */
const categoryWriteChains = new Map()

/**
 * 把一次分类读改写排进工作区队列。
 *
 * 分类是小文件，但用户可能连点保存/整理；串行化保证后一次读到前一次
 * 的结果，而不是两个请求都基于旧 store 覆盖。
 */
function queueCategoryWrite(path, task) {
  const previous = categoryWriteChains.get(path) ?? Promise.resolve()
  const run = previous.then(task, task)
  categoryWriteChains.set(path, run.then(() => undefined, () => undefined))
  return run
}

/** 解析分类端点共用的工作区与落盘路径。 */
function resolveCategoryTarget(ctx, body) {
  const badBody = requireRequestBody(body)
  if (badBody !== null) return badBody
  const request = body
  const wsField = normalizeWorkspaceIdField(request)
  if (!wsField.ok) return wsField
  const ws = resolveEndpointWorkspace(ctx, wsField.value, { required: true })
  if (!ws.ok) return ws
  const path = categoryStorePath(ws.workspace.id)
  if (path === null) return { ok: false, error: '无法确定 DSH home', httpStatus: 502 }
  return { ok: true, workspace: ws.workspace, path }
}

/**
 * 解析分类目标，并在首次访问时把旧归类缓存导入新 store。
 *
 * 旧文件是 `ui/workspace-category-<ws>.json`（`/categorize` 的缓存树）。
 * 产品下线旧系统后，第一次打开这个工作区必须把已有分类接过来，否则用户
 * 会看到"分类全没了"。导入失败只记日志、不阻断正常请求。
 *
 * @param ctx - Host context。
 * @param body - 请求体。
 * @returns 与 `resolveCategoryTarget` 同形状。
 */
async function resolveReadyCategoryTarget(ctx, body) {
  const target = resolveCategoryTarget(ctx, body)
  if (!target.ok) return target
  try {
    await ensureLegacyCategoryImport(ctx, target.workspace.id, target.path)
  } catch (error) {
    recordAutoDiagnostic(`旧分类导入失败：${errorText(error).slice(0, 120)}`, {
      kind: 'legacy-import-failed',
      workspaceId: target.workspace.id,
    })
  }
  return target
}

/** 已完成（或确认无需）旧缓存导入的工作区，避免每个请求都碰磁盘。 */
const legacyCategoryImported = new Set()

/**
 * 首次访问某工作区时导入旧分类缓存（只做一次）。
 *
 * 口径：
 *   - 同父级同名分类合并到已有分类，来源一律 `source:'model'`；
 *   - 只填空：已有归类、已锁定会话都不覆盖；
 *   - 成功后把旧文件改名为 `<name>.imported`（存在该标记就不再导入）；
 *   - 任何一步失败都只记日志，不影响调用方读取新 store。
 *
 * @param ctx - Host context。
 * @param workspaceId - 工作区 id。
 * @param storePath - 新 store 路径。
 * @returns `{imported:boolean, reason?}`。
 */
async function ensureLegacyCategoryImport(ctx, workspaceId, storePath) {
  const key = String(workspaceId ?? '')
  if (key === '' || legacyCategoryImported.has(key)) return { imported: false, reason: 'done' }
  const legacyPath = categoryCachePath(key)
  if (legacyPath === null) {
    legacyCategoryImported.add(key)
    return { imported: false, reason: 'no-path' }
  }

  // 已有 `.imported` 标记 = 这台机器上已经导过一次；即使旧文件又出现也不再导。
  try {
    await readFile(`${legacyPath}.imported`, 'utf8')
    legacyCategoryImported.add(key)
    return { imported: false, reason: 'already-imported' }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      recordAutoDiagnostic(`旧分类导入标记读取失败：${errorText(error).slice(0, 120)}`, {
        kind: 'legacy-import-failed',
        workspaceId: key,
      })
    }
  }

  let text
  try {
    text = await readFile(legacyPath, 'utf8')
  } catch (error) {
    legacyCategoryImported.add(key)
    if (error?.code !== 'ENOENT') {
      recordAutoDiagnostic(`旧分类缓存读取失败：${errorText(error).slice(0, 120)}`, {
        kind: 'legacy-import-failed',
        workspaceId: key,
      })
    }
    return { imported: false, reason: 'missing' }
  }

  let legacy
  try {
    legacy = JSON.parse(text)
  } catch {
    legacyCategoryImported.add(key)
    recordAutoDiagnostic('旧分类缓存损坏，已跳过导入', { kind: 'legacy-import-failed', workspaceId: key })
    return { imported: false, reason: 'corrupt' }
  }
  const tree = Array.isArray(legacy?.tree) ? legacy.tree : []

  let created = 0
  let assigned = 0
  try {
    await queueCategoryWrite(storePath, async () => {
      let store = await readCategoryStoreFile(storePath)

      /** 递归导入，最多 3 级；第 4 级及更深直接忽略。 */
      const walk = async (nodes, parentId, depth) => {
        if (depth > CATEGORY_SUGGEST_MAX_DEPTH) return
        for (const node of Array.isArray(nodes) ? nodes : []) {
          if (!isPlainObject(node)) continue
          const name = canonicalCategoryName(node.name).slice(0, CATEGORY_SUGGEST_NAME_MAX)
          if (name === '') continue
          let category = findCategoryByPathName(store.categories, name, parentId)
          if (category === null) {
            const upserted = upsertCategory(store, { name, parentId, source: 'model' })
            if (upserted.error) {
              recordAutoDiagnostic(`导入旧分类失败：${upserted.error}`, {
                kind: 'legacy-import-failed',
                workspaceId: key,
                name,
              })
              continue
            }
            store = carryLockedSessions(store, upserted.store)
            category = { id: upserted.id }
            created += 1
          }
          for (const rawSession of Array.isArray(node.sessions) ? node.sessions : []) {
            const sessionId = typeof rawSession === 'string'
              ? rawSession.trim()
              : typeof rawSession?.sessionId === 'string' ? rawSession.sessionId.trim() : ''
            if (sessionId === '') continue
            if (isSessionLocked(store, sessionId)) continue
            if (!isSessionUnclassified(store, sessionId)) continue
            const result = assignSession(store, sessionId, category.id, 'model')
            if (result.error) continue
            store = carryLockedSessions(store, result.store)
            assigned += 1
          }
          const children = Array.isArray(node.subcategories)
            ? node.subcategories
            : Array.isArray(node.children) ? node.children : []
          await walk(children, category.id, depth + 1)
        }
      }

      await walk(tree, null, 1)
      if (created > 0 || assigned > 0) await writeCategoryStoreFile(storePath, store)
    })

    // Windows 上 rename 到已存在的目标会失败；先清掉可能残留的旧标记。
    try {
      await unlink(`${legacyPath}.imported`)
    } catch {
      // 没有旧标记是正常情况。
    }
    await rename(legacyPath, `${legacyPath}.imported`)
    legacyCategoryImported.add(key)
    recordAutoDiagnostic(`已导入旧分类缓存：${created} 个分类、${assigned} 个会话`, {
      kind: 'legacy-import',
      workspaceId: key,
      created,
      assigned,
    })
    return { imported: true, created, assigned }
  } catch (error) {
    recordAutoDiagnostic(`旧分类导入失败：${errorText(error).slice(0, 120)}`, {
      kind: 'legacy-import-failed',
      workspaceId: key,
    })
    return { imported: false, reason: 'error' }
  }
}

/** 分类端点共用的超时/异常收口。 */
function categoryFailure(error) {
  return endpointFailure(error, '分类操作')
}

/**
 * 读取整份分类 store（POST /categories）。
 *
 * 返回 `{...store, tree}`：`value` 本身就是整份 store，`tree` 是 `toTree`
 * 的嵌套视图（count 只算直接会话）。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId}`。
 * @param options - `{timeoutMs, loadStore}`。
 */
export async function readCategoryIndex(ctx, body = {}, options = {}) {
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target
  const load = typeof options?.loadStore === 'function'
    ? options.loadStore
    : readCategoryStoreFile
  const timeoutMs = timeoutOption(options?.timeoutMs, CATEGORY_TIMEOUT_MS)
  try {
    const store = await withEndpointTimeout(load(target.path), timeoutMs, '读取分类')
    // 平铺字段（version/categories/assignments）保持兼容；同时提供 `store`，
    // 因为客户端按 `value.store` 读取——两边形状不一致会导致"分类永远为空"。
    return { ok: true, value: { ...store, store, tree: toTree(store) } }
  } catch (error) {
    return categoryFailure(error)
  }
}

/**
 * 自动归类（建议 → 应用）。
 *
 * 与旧的「一键归类」区别：旧流程一次把整个工作区重新分类并缓存；这两个
 * 端点只处理**未归类**的会话，建议先给用户看，确认后才落盘，而且只填空，
 * 不动人工数据。
 */

/** 单条材料各段的截断上限（标题 / 提问 / 关键词个数）。 */
const CATEGORY_SUGGEST_TITLE_LIMIT = 60
const CATEGORY_SUGGEST_PROMPT_LIMIT = 120
const CATEGORY_SUGGEST_KEYWORD_LIMIT = 8
/** 一次模型调用的会话数与材料字数上限；超过就分批。 */
const CATEGORY_SUGGEST_BATCH_SESSIONS_MAX = 20
const CATEGORY_SUGGEST_BATCH_CHARS_MAX = 12000
/** 一次建议的默认会话数 / 上限。 */
const CATEGORY_SUGGEST_DEFAULT_LIMIT = 20
const CATEGORY_SUGGEST_MAX_LIMIT = 30
/** 分类名保留字符数（与旧归类解析的 24 字上限一致）。 */
const CATEGORY_SUGGEST_NAME_MAX = 24
/** 读会话材料的并发上限。 */
const CATEGORY_SUGGEST_READ_CONCURRENCY = 4
/** 分类最多 3 级。 */
const CATEGORY_SUGGEST_MAX_DEPTH = 3

/** 中文 2-gram 的常见停用词。 */
const CJK_STOP_WORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '为什', '可以', '需要',
  '应该', '已经', '还是', '就是', '没有', '因为', '所以', '但是', '然后', '如果',
  '现在', '这样', '那样', '一下', '这些', '那些', '一个', '不是', '以及', '进行',
  '使用', '问题', '时候', '地方', '东西', '这边', '那边', '如何', '是否', '可能',
  '知道', '看到', '觉得', '感觉', '目前', '之后', '之前', '同时', '其中', '通过',
  '关于', '对于', '以及', '并且', '或者', '不过', '而且', '由于', '因此', '这里',
  '那里', '上面', '下面', '里面', '外面', '起来', '出来', '回来', '过去', '一下',
  '这是', '那是', '还有', '只是', '而是', '不能', '不会', '不要', '一起', '以后',
  '以前', '目前', '现在', '开始', '结束', '继续', '一下', '直接', '具体', '相关',
])

/** 中文单字停用字符：双字都由停用字组成时直接丢弃。 */
const CJK_STOP_CHARS = new Set(
  '的了着过是在有和与或就都也又很太把被让给对从到向往里上下中外这那我你他她它们个些吗呢吧啊呀哦嗯之其并且但所因'.split(''),
)

/** 英文停用词。 */
const EN_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'so', 'to', 'of',
  'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these', 'those', 'there',
  'here', 'we', 'you', 'i', 'me', 'my', 'our', 'your', 'he', 'she', 'they', 'them',
  'their', 'his', 'her', 'not', 'no', 'do', 'does', 'did', 'can', 'could', 'will',
  'would', 'should', 'may', 'might', 'must', 'have', 'has', 'had', 'about', 'into',
  'over', 'after', 'before', 'more', 'most', 'some', 'such', 'only', 'also', 'just',
  'up', 'out', 'use', 'using', 'via', 'per', 'all', 'any', 'each', 'other', 'when',
  'where', 'which', 'who', 'why', 'how', 'what', 'while', 'because', 'between',
])

/** 分类名归一：去首尾、内部连续空白压成一个空格（同级同名判定用）。 */
function canonicalCategoryName(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** 标题 / 提问统一压成一行，再按指定字数截断。 */
function clipSuggestionText(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : text.slice(0, limit)
}

/** limit 归一：缺省 20；非正数回默认；上限 30。 */
function categorySuggestionLimit(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return CATEGORY_SUGGEST_DEFAULT_LIMIT
  return Math.min(CATEGORY_SUGGEST_MAX_LIMIT, Math.floor(number))
}

/** 一个关键词归一：压空白、英文转小写。 */
function normalizeKeyword(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text === '' ? '' : text.toLowerCase()
}

/**
 * 本地预提取关键词（零成本，不调模型）。
 *
 * 口径：
 *   1. 索引各行 `prompt` 文本 → 中文 2-gram / 英文单词，去停用词，按 TF 排序；
 *   2. `files[]` 取文件名主干、`commands[]` 取命令首词，各取高频前 2 个作锚点；
 *   3. 锚点必须保留，最终关键词最多 8 个（TF 优先、锚点兜底）。
 *
 * 这样材料里既有"反复提到的词"，也有"实际动了哪些文件/跑了哪些命令"。
 *
 * @param rows - 索引轮次行（也接受 `{prompt, files, commands}` 的纯数据）。
 * @returns 关键词数组（≤8）。
 */
export function extractCategoryKeywords(rows) {
  const list = Array.isArray(rows) ? rows : []
  const counts = new Map()
  const firstSeen = new Map()
  let seen = 0

  const addToken = token => {
    if (token === '') return
    if (!counts.has(token)) {
      counts.set(token, 0)
      firstSeen.set(token, seen)
      seen += 1
    }
    counts.set(token, counts.get(token) + 1)
  }

  for (const row of list) {
    if (!isPlainObject(row)) continue
    const text = typeof row.prompt === 'string' ? row.prompt : ''
    for (const match of text.matchAll(/[\u4e00-\u9fff]+/g)) {
      const run = match[0]
      for (let index = 0; index + 1 < run.length; index += 1) {
        const gram = run.slice(index, index + 2)
        if (CJK_STOP_WORDS.has(gram)) continue
        if (CJK_STOP_CHARS.has(gram[0]) && CJK_STOP_CHARS.has(gram[1])) continue
        addToken(gram)
      }
    }
    for (const match of text.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
      const word = match[0].toLowerCase()
      if (word.length < 2 || EN_STOP_WORDS.has(word)) continue
      addToken(word)
    }
  }

  const ranked = [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return firstSeen.get(left[0]) - firstSeen.get(right[0])
    })
    .map(([token]) => token)

  /** 高频锚点：files 的文件名主干 / commands 的命令首词。 */
  function topFragments(pick) {
    const fragmentCounts = new Map()
    const fragmentOrder = new Map()
    let order = 0
    for (const row of list) {
      if (!isPlainObject(row)) continue
      for (const raw of Array.isArray(row.files) ? row.files : []) {
        const fragment = pick.file(raw)
        if (fragment === '') continue
        if (!fragmentCounts.has(fragment)) {
          fragmentCounts.set(fragment, 0)
          fragmentOrder.set(fragment, order)
          order += 1
        }
        fragmentCounts.set(fragment, fragmentCounts.get(fragment) + 1)
      }
      for (const raw of Array.isArray(row.commands) ? row.commands : []) {
        const fragment = pick.command(raw)
        if (fragment === '') continue
        if (!fragmentCounts.has(fragment)) {
          fragmentCounts.set(fragment, 0)
          fragmentOrder.set(fragment, order)
          order += 1
        }
        fragmentCounts.set(fragment, fragmentCounts.get(fragment) + 1)
      }
    }
    return [...fragmentCounts.entries()]
      .sort((left, right) => {
        if (right[1] !== left[1]) return right[1] - left[1]
        return fragmentOrder.get(left[0]) - fragmentOrder.get(right[0])
      })
      .slice(0, 2)
      .map(([fragment]) => fragment)
  }

  const fileAnchors = topFragments({
    file: raw => {
      const cleaned = String(raw ?? '').trim().replace(/[?#].*$/, '')
      const base = cleaned.split(/[\\/]/).filter(part => part !== '').pop() ?? ''
      const stem = base.replace(/\.[^.]+$/, '')
      if (stem === '' || stem === '.' || stem === '..') return ''
      return normalizeKeyword(stem)
    },
    command: () => '',
  })
  const commandAnchors = topFragments({
    file: () => '',
    command: raw => {
      const words = String(raw ?? '').trim().split(/\s+/).filter(Boolean)
      let index = 0
      // 跳过 `FOO=bar` 这类环境变量前缀，取真正的命令首词。
      while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1
      const first = words[index]
      if (first === undefined) return ''
      const token = first.replace(/^["']|["']$/g, '')
      if (token === '' || token.startsWith('-') || token.startsWith('#')) return ''
      return normalizeKeyword(token)
    },
  })

  const anchors = []
  for (const anchor of [...fileAnchors, ...commandAnchors]) {
    if (!anchors.includes(anchor)) anchors.push(anchor)
  }

  const keywords = []
  const addKeyword = token => {
    if (keywords.length >= CATEGORY_SUGGEST_KEYWORD_LIMIT) return
    if (!keywords.includes(token)) keywords.push(token)
  }
  // 先留出锚点位置，再按 TF 填；锚点重叠时继续用 TF 补满。
  const reserved = Math.max(0, CATEGORY_SUGGEST_KEYWORD_LIMIT - anchors.length)
  for (const token of ranked) {
    if (keywords.length >= reserved) break
    addKeyword(token)
  }
  for (const anchor of anchors) addKeyword(anchor)
  for (const token of ranked) addKeyword(token)
  return keywords
}

/** 两组关键词的 Jaccard 相似度；空集返回 0。 */
function jaccardOfKeywords(left, right) {
  const a = left instanceof Set ? left : new Set(left)
  const b = right instanceof Set ? right : new Set(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) if (b.has(token)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/**
 * 本地分组提示：关键词 Jaccard ≥ 0.5 的会话先聚成一组。
 *
 * 用并查集做连通分量（A-B、B-C 相似时三者同组），组内共享关键词也一并
 * 给模型，减少"同一主题被拆成多个分类名"。`sessions` 是材料里的 1-based
 * 序号（不是 sessionId），与提示词里的编号一致。
 *
 * @param materials - `[{sessionId, keywords}]`。
 * @returns `[{group, sessions, sharedKeywords}]`。
 */
export function groupCategorySuggestions(materials) {
  const list = Array.isArray(materials) ? materials : []
  const sets = list.map(material => new Set(
    Array.isArray(material?.keywords) ? material.keywords : [],
  ))
  const parent = list.map((_, index) => index)
  const find = start => {
    let current = start
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]]
      current = parent[current]
    }
    return current
  }
  const union = (left, right) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[b] = a
  }

  for (let left = 0; left < list.length; left += 1) {
    for (let right = left + 1; right < list.length; right += 1) {
      if (jaccardOfKeywords(sets[left], sets[right]) >= 0.5) union(left, right)
    }
  }

  const buckets = new Map()
  for (let index = 0; index < list.length; index += 1) {
    const root = find(index)
    const bucket = buckets.get(root)
    if (bucket === undefined) buckets.set(root, [index])
    else bucket.push(index)
  }

  const groups = []
  for (const members of [...buckets.values()].sort((a, b) => a[0] - b[0])) {
    if (members.length < 2) continue
    const firstKeywords = Array.isArray(list[members[0]]?.keywords) ? list[members[0]].keywords : []
    const sharedKeywords = firstKeywords.filter(keyword =>
      members.every(index => sets[index].has(keyword)))
    groups.push({
      group: groups.length + 1,
      sessions: members.map(index => index + 1),
      sharedKeywords,
    })
  }
  return groups
}

/** 单会话材料字数（用于 12000 字分批预算）。 */
function categoryMaterialCharsOf(material) {
  if (!isPlainObject(material)) return 0
  const keywords = Array.isArray(material.keywords) ? material.keywords.join('、') : ''
  return String(material.sessionTitle ?? '').length
    + String(material.firstPrompt ?? '').length
    + String(material.lastPrompt ?? '').length
    + keywords.length
}

/**
 * 批次规划：每批 ≤20 个会话，且材料字数尽量不超过 12000。
 *
 * 单个会话材料自身超预算时也允许独占一批（不能因为一条长材料就丢弃）。
 *
 * @param materials - 材料数组。
 * @returns 批次数组（每批仍是材料数组）。
 */
export function planCategorySuggestionBatches(materials) {
  const list = Array.isArray(materials) ? materials : []
  const batches = []
  let current = []
  let chars = 0
  for (const material of list) {
    const materialChars = categoryMaterialCharsOf(material)
    const overSessions = current.length >= CATEGORY_SUGGEST_BATCH_SESSIONS_MAX
    const overChars = current.length > 0
      && chars + materialChars > CATEGORY_SUGGEST_BATCH_CHARS_MAX
    if (overSessions || overChars) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(material)
    chars += materialChars
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * 自动归类提示词。
 *
 * 材料四段：标题 ≤60、首轮提问 ≤120、最后一轮提问 ≤120、本地关键词 ≤8。
 * 首轮只代表"开始"，最后一轮代表"现在在做什么"；关键词是零成本锚点。
 *
 * @param materials - `[{sessionId, sessionTitle, firstPrompt, lastPrompt, keywords}]`。
 * @param groups - `groupCategorySuggestions` 的输出（可选）。
 * @param existingPaths - 已有分类路径清单（可选）。自动归类会传，
 *   让模型优先从已有分类里选；不传时提示词与旧版完全一致。
 * @returns `{system, user}`。
 */
export function buildCategorySuggestionPrompt(materials, groups = [], existingPaths = null) {
  const list = Array.isArray(materials) ? materials : []
  const existing = Array.isArray(existingPaths) ? existingPaths : null
  const system = [
    '你在帮一个工作区里的「未归类」会话做自动归类。',
    '把每个会话归入「大类 → 子类 → 子子类」分类树，最多 3 级。',
    '只输出 JSON 数组，不要 Markdown 代码围栏、不要解释。',
    '每项形如 {"sessionId":"材料里的会话 id","path":["大类","子类"],"reason":"40 字内依据","confidence":0.8,"alt":"可选次要分类名"}。',
    'path 至少 1 级、最多 3 级；同一主题的会话必须使用完全相同的 path。',
    'reason 必须说明分类依据，40 字以内；confidence 是 0-1 的小数。',
    '一个会话明显跨两个主题时，可给 alt（次要分类名，只记录不生效）。',
    '分类名用 2-8 个字概括主题，不要用「其他」「未分类」「杂项」这类空词。',
    '只处理材料里列出的会话，每个会话最多一条，不要编造 sessionId。',
    ...(existing === null ? [] : [
      '已有分类优先：能归入下面「已有分类」里的路径就直接用那条 path，不要换名字。',
      '只有确实没有合适分类时才给出新的 path；新路径会与其它会话的同类提案累计，',
      '累计达到 3 个会话支持才会创建。你只需按最合适的分类给 path，不要为单次材料凑数。',
    ]),
  ].join('\n')

  const groupHints = Array.isArray(groups) && groups.length > 0
    ? `本地分组提示（关键词 Jaccard ≥ 0.5 的会话已聚组，同组内优先使用同一个分类名）：\n${JSON.stringify(groups)}\n\n`
    : ''
  const existingHints = existing === null
    ? ''
    : `已有分类（优先从这里选，路径用 › 分隔）：\n${existing.length === 0
      ? '（还没有任何分类）'
      : existing.map(item => `- ${item.pathText || item.name}`).join('\n')}\n\n`
  const body = list.map((material, index) => [
    `${index + 1}. sessionId: ${material.sessionId}`,
    `   标题：${material.sessionTitle === '' ? '（无）' : material.sessionTitle}`,
    `   首轮提问：${material.firstPrompt === '' ? '（无）' : material.firstPrompt}`,
    `   最后一轮提问：${material.lastPrompt === '' ? '（无）' : material.lastPrompt}`,
    `   关键词：${Array.isArray(material.keywords) && material.keywords.length > 0
      ? material.keywords.join('、')
      : '（无）'}`,
  ].join('\n')).join('\n\n')

  return {
    system,
    user: `以下是 ${list.length} 个未归类会话：\n\n${existingHints}${groupHints}${body}\n\n`
      + `请只输出 JSON 数组（最多 ${list.length} 项），每项含 sessionId、path（1-3 级）、`
      + 'reason（≤40 字）、confidence（0-1）；可选 alt。',
  }
}

/** path 归一：最多 3 级；任一级为空/非字符串则整条作废。 */
function normalizeSuggestionPath(rawPath) {
  if (!Array.isArray(rawPath) || rawPath.length === 0) return null
  const depth = Math.min(CATEGORY_SUGGEST_MAX_DEPTH, rawPath.length)
  const path = []
  for (let index = 0; index < depth; index += 1) {
    const name = canonicalCategoryName(rawPath[index])
    if (name === '') return null
    path.push(name.slice(0, CATEGORY_SUGGEST_NAME_MAX))
  }
  return path
}

/** 次要分类名（alt）：只接受单个名字，数组取第一个字符串。 */
function normalizeSuggestionAlt(value) {
  const raw = typeof value === 'string'
    ? value
    : Array.isArray(value) ? value.find(item => typeof item === 'string') : ''
  const name = canonicalCategoryName(raw)
  return name === '' ? null : name.slice(0, CATEGORY_SUGGEST_NAME_MAX)
}

/**
 * 从模型输出里抽「建议数组」。
 *
 * 不能直接用 `extractJsonArray`：它会优先取最后一个能解析的数组，而每项
 * 的 `path` 本身就是数组（例如 `["大类","子类"]`），会被误当成答案。这里
 * 优先找"元素是对象且带 sessionId/path"的跨度，再退回通用抽取。
 */
function extractCategorySuggestionArray(text) {
  const source = String(text ?? '').replace(/```[a-zA-Z]*\n?/g, '')
  const direct = source.trim()
  try {
    const parsed = JSON.parse(direct)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // 前后有解释文字，继续按跨度找
  }

  const starts = []
  const ends = []
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '[') starts.push(index)
    else if (source[index] === ']') ends.push(index)
  }
  for (let si = starts.length - 1; si >= 0; si -= 1) {
    const from = starts[si]
    for (let ei = 0; ei < ends.length; ei += 1) {
      const to = ends[ei]
      if (to <= from) continue
      let parsed
      try {
        parsed = JSON.parse(source.slice(from, to + 1))
      } catch {
        continue
      }
      if (!Array.isArray(parsed) || parsed.length === 0) continue
      const looksLikeSuggestions = parsed.some(item =>
        isPlainObject(item)
        && (Object.prototype.hasOwnProperty.call(item, 'sessionId')
          || Object.prototype.hasOwnProperty.call(item, 'path')
          || Object.prototype.hasOwnProperty.call(item, 'categoryPath')))
      if (looksLikeSuggestions) return parsed
    }
  }
  return extractJsonArray(text)
}

/**
 * 解析模型输出。
 *
 * 不要求条数与材料严格相等：模型可能只标有把握的会话，少几条比错位安全。
 * 但 sessionId 必须来自材料、path 必须可用，否则整条忽略；一条可用都没有
 * 时返回空建议 + error（由端点降级成 200，不抛 500）。
 *
 * @param text - 模型输出文本。
 * @param materials - 本次材料（含 sessionTitle）。
 * @returns `{suggestions, error?}`。
 */
export function parseCategorySuggestions(text, materials) {
  const list = Array.isArray(materials) ? materials : []
  const bySession = new Map(list.map(item => [item.sessionId, item]))
  const parsed = extractCategorySuggestionArray(text)
  if (parsed === null) {
    return { suggestions: [], error: '模型输出不是可解析的 JSON 数组' }
  }

  const picked = new Map()
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : ''
    if (sessionId === '' || !bySession.has(sessionId) || picked.has(sessionId)) continue
    const path = normalizeSuggestionPath(
      Array.isArray(item.path)
        ? item.path
        : Array.isArray(item.categoryPath) ? item.categoryPath : null,
    )
    if (path === null) continue
    const hasConfidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
    const rawConfidence = hasConfidence ? item.confidence : 0.5
    const alt = normalizeSuggestionAlt(item.alt)
    picked.set(sessionId, {
      sessionId,
      categoryPath: path,
      confidence: Math.min(1, Math.max(0, rawConfidence)),
      // 模型没给 confidence 时不当作"存疑"：冷启动批量据此决定是否要求票数。
      ...(hasConfidence ? {} : { confidenceMissing: true }),
      reason: typeof item.reason === 'string'
        ? item.reason.replace(/\s+/g, ' ').trim().slice(0, 40)
        : '',
      ...(alt === null ? {} : { alt }),
    })
  }

  if (parsed.length > 0 && picked.size === 0) {
    return { suggestions: [], error: '模型输出缺少可用的 sessionId/path' }
  }

  // 按材料顺序返回（= 按 lastActive 倒序），而不是模型输出顺序。
  const suggestions = []
  for (const material of list) {
    const hit = picked.get(material.sessionId)
    if (hit === undefined) continue
    suggestions.push({
      sessionId: hit.sessionId,
      sessionTitle: material.sessionTitle,
      categoryPath: hit.categoryPath,
      confidence: hit.confidence,
      ...(hit.confidenceMissing === true ? { confidenceMissing: true } : {}),
      reason: hit.reason,
      ...(hit.alt === undefined ? {} : { alt: hit.alt }),
    })
  }
  return { suggestions }
}

/** 读一条 assignment；旧式字符串按 source:'user' 处理。 */
function categoryAssignmentOfStore(store, sessionId) {
  const assignments = isPlainObject(store?.assignments) ? store.assignments : {}
  if (!Object.prototype.hasOwnProperty.call(assignments, sessionId)) return null
  const raw = assignments[sessionId]
  if (typeof raw === 'string') {
    const categoryId = raw.trim()
    return { categoryId: categoryId === '' ? null : categoryId, source: 'user' }
  }
  if (!isPlainObject(raw)) return null
  return {
    categoryId: categoryIdOfAssignment(raw),
    source: raw.source === 'user' ? 'user' : 'model',
  }
}

/** 同级同名分类查找（parentId 必须一致；名称空白归一后比较）。 */
function findCategoryByPathName(categories, name, parentId) {
  const wanted = canonicalCategoryName(name)
  if (wanted === '') return null
  for (const category of Array.isArray(categories) ? categories : []) {
    if (!isPlainObject(category)) continue
    if (canonicalCategoryName(category.name) !== wanted) continue
    if ((category.parentId ?? null) !== (parentId ?? null)) continue
    return category
  }
  return null
}

/** 应用建议前归一：去重（同会话取第一条）、path 1–3 级、忽略非法项。 */
function normalizeCategorySuggestions(raw) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isPlainObject(item)) continue
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : ''
    if (sessionId === '' || seen.has(sessionId)) continue
    const path = normalizeSuggestionPath(
      Array.isArray(item.categoryPath)
        ? item.categoryPath
        : Array.isArray(item.path) ? item.path : null,
    )
    if (path === null) continue
    seen.add(sessionId)
    out.push({ sessionId, categoryPath: path })
  }
  return out
}

/**
 * 读一个会话的轮次行，优先用索引（关键词/首末提问都从 prompt 取）。
 *
 * 索引缺失或损坏时退回读日志并用同一套 fold 生成行；单个会话失败返回空，
 * 不影响其余材料。
 */
async function loadCategorySuggestionRows(ctx, sessionId) {
  const dir = defaultSessionsDir()
  if (dir !== '') {
    try {
      const file = await readIndexFile(dir, sessionId)
      if (file.ok && Array.isArray(file.turns) && file.turns.length > 0) return file.turns
    } catch {
      // 索引读不了就退日志
    }
  }
  try {
    return buildTurnRows(await readEvents(ctx, sessionId))
  } catch {
    return []
  }
}

/**
 * 单会话材料：与 /category-suggest 完全同源（标题 + 首末提问 + 本地关键词）。
 *
 * 抽出来是为了让自动归类队列**复用**同一套取材口径，而不是另写一份；
 * 任何截断/关键词规则一改，两条路径同时生效。
 *
 * @param ctx - Host context。
 * @param session - `listWorkspaceSessions` 的会话行（至少含 sessionId / title）。
 * @returns 材料对象。
 */
async function categoryMaterialOfSession(ctx, session) {
  const rows = await loadCategorySuggestionRows(ctx, session.sessionId)
  const firstTurn = rows[0]
  const lastTurn = rows[rows.length - 1]
  return {
    sessionId: session.sessionId,
    sessionTitle: clipSuggestionText(session.title, CATEGORY_SUGGEST_TITLE_LIMIT),
    firstPrompt: clipSuggestionText(firstTurn?.prompt ?? '', CATEGORY_SUGGEST_PROMPT_LIMIT),
    lastPrompt: clipSuggestionText(lastTurn?.prompt ?? '', CATEGORY_SUGGEST_PROMPT_LIMIT),
    keywords: extractCategoryKeywords(rows),
  }
}

/** 批量取材料；读会话日志的并发上限与 /category-suggest 一致。 */
async function categoryMaterialsOf(ctx, sessions) {
  return mapWithLimit(sessions, CATEGORY_SUGGEST_READ_CONCURRENCY, session =>
    categoryMaterialOfSession(ctx, session))
}

/**
 * 分批请求归类建议：`/category-suggest` 与冷启动批量归类共用。
 *
 * 每批 ≤20 个会话 / ≤12000 字材料；组提示按批内序号重映射。
 * 某批失败只记该批，不影响其它批（由调用方决定如何暴露）。
 *
 * @param llm - llm 服务。
 * @param route - `{provider, model}`。
 * @param materials - 材料数组（顺序即提示词编号）。
 * @param groups - `groupCategorySuggestions(materials)` 的结果。
 * @param options - `{existingPaths}`；缺省按旧提示词（不追加已有分类规则）。
 * @returns `{suggestions, failures, batches}`。
 */
async function requestCategorySuggestions(llm, route, materials, groups, options = {}) {
  const list = Array.isArray(materials) ? materials : []
  const batches = planCategorySuggestionBatches(list)
  const existingPaths = Array.isArray(options?.existingPaths) ? options.existingPaths : null
  const suggestions = []
  const failures = []

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex]
    const batchPosition = new Map(batch.map((material, index) => [material.sessionId, index + 1]))
    const batchGroups = (Array.isArray(groups) ? groups : [])
      .map(group => {
        const sessions = group.sessions
          .map(globalIndex => list[globalIndex - 1]?.sessionId)
          .filter(sessionId => sessionId !== undefined && batchPosition.has(sessionId))
          .map(sessionId => batchPosition.get(sessionId))
        if (sessions.length < 2) return null
        return { group: group.group, sessions, sharedKeywords: group.sharedKeywords }
      })
      .filter(Boolean)

    const prompt = buildCategorySuggestionPrompt(batch, batchGroups, existingPaths)
    let text
    try {
      text = await askOnce(llm, route, prompt.system, prompt.user, undefined, {
        maxTokens: Math.max(4096, batch.length * 160),
        // 必须带 sessionId：opencode 等适配器用它写路由头，缺了会 400。
        sessionId: batch[0].sessionId,
      })
    } catch (error) {
      failures.push({
        batch: batchIndex + 1,
        error: `模型调用失败：${errorText(error).slice(0, 120)}`,
      })
      continue
    }

    const parsed = parseCategorySuggestions(text, batch)
    if (parsed.error !== undefined) {
      failures.push({ batch: batchIndex + 1, error: parsed.error })
      continue
    }
    suggestions.push(...parsed.suggestions)
  }
  return { suggestions, failures, batches }
}

/**
 * 给未归类会话生成归类建议（POST /category-suggest）。
 *
 * 取材顺序（零成本本地步骤在前）：
 *   1. 索引行 prompt → 标题 / 首轮提问 / 最后一轮提问 / 本地关键词；
 *   2. 关键词 Jaccard ≥0.5 的会话先聚组，作为分组提示交给模型；
 *   3. 按每批 ≤20 个会话、≤12000 字材料分批调用模型；
 *   4. 任一批失败只标记该批，其余继续，返回 partial + failedBatches。
 *
 * 模型调用复用 `resolveRoute`（经 `resolveWorkspaceRoute`）与 `askOnce`；
 * `askOnce` 的 limits 必须带 sessionId，否则真机 400 MissingSessionID。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId?, limit?}`。
 * @returns `{ok:true,value:{suggestions,model,elapsedMs,usage,partial?,failedBatches?,error?}}`
 *   或错误信封。
 */
export async function suggestCategories(ctx, body = {}) {
  const started = Date.now()
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target

  const workspace = target.workspace
  const config = readConfig()
  const llm = ctx.get('llm')
  const route = await resolveWorkspaceRoute(ctx, config, workspace.sessionIds ?? [])
  if (llm === undefined || route === null) {
    return { ok: false, error: '自动归类需要先配置模型', httpStatus: 503 }
  }

  let store
  try {
    store = await readCategoryStoreFile(target.path)
  } catch (error) {
    return categoryFailure(error)
  }

  const limit = categorySuggestionLimit(body?.limit)
  const list = await listWorkspaceSessions(ctx, null, workspace.id)
  // 「未归类」= 没有 assignment，或 categoryId 为空（空 id 的残留记录也算空白）。
  const candidates = list.sessions.filter(session => {
    const assignment = categoryAssignmentOfStore(store, session.sessionId)
    return assignment === null || assignment.categoryId === null
  })
  const sorted = [...candidates].sort((left, right) => {
    const leftTime = Number.isFinite(left.lastActive) ? left.lastActive : -Infinity
    const rightTime = Number.isFinite(right.lastActive) ? right.lastActive : -Infinity
    if (rightTime !== leftTime) return rightTime - leftTime
    return 0
  })
  const selected = sorted.slice(0, Math.max(0, limit))

  const materials = await categoryMaterialsOf(ctx, selected)

  const model = typeof route.model === 'string' ? route.model : ''
  const usage = {
    sessions: materials.length,
    chars: materials.reduce((sum, material) => sum + categoryMaterialCharsOf(material), 0),
    batches: 0,
  }
  if (materials.length === 0) {
    return {
      ok: true,
      value: { suggestions: [], model, elapsedMs: Date.now() - started, usage },
    }
  }

  // 分组提示用全量 material 序号；分批后按批内序号重映射，只保留批内 ≥2 人的组。
  const groups = groupCategorySuggestions(materials)
  const requested = await requestCategorySuggestions(llm, route, materials, groups)
  usage.batches = requested.batches.length

  const suggestions = requested.suggestions
  const failures = requested.failures

  const value = {
    suggestions,
    model,
    elapsedMs: Date.now() - started,
    usage,
  }
  if (failures.length > 0) {
    value.partial = true
    value.failedBatches = failures.map(item => item.batch)
    value.error = failures
      .map(item => `第 ${item.batch} 批：${item.error}`)
      .join('；')
      .slice(0, 400)
  }
  return { ok: true, value }
}

/**
 * 应用归类建议（POST /category-apply-suggestions）。
 *
 * 只填空：已有非空 `source:'user'` 归类的会话跳过（计入 skipped），人工
 * 分类名不覆盖。其余会话按 path 逐级找「同级同名」分类，找不到才以
 * `source:'model'` 新建，最后归到最深一级。整体在一次同工区写队列里串行
 * 完成，避免并发读改写互相覆盖。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId?, suggestions}`。
 * @param options - `{timeoutMs, loadStore, saveStore}`。
 * @returns `{ok:true,value:{store,tree,applied,skipped}}` 或错误信封。
 */
export async function applyCategorySuggestions(ctx, body = {}, options = {}) {
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target
  if (!Array.isArray(body?.suggestions)) {
    return { ok: false, error: 'suggestions 必须是数组', httpStatus: 400 }
  }

  const suggestions = normalizeCategorySuggestions(body.suggestions)
  const load = typeof options?.loadStore === 'function' ? options.loadStore : readCategoryStoreFile
  const save = typeof options?.saveStore === 'function' ? options.saveStore : writeCategoryStoreFile
  const timeoutMs = timeoutOption(options?.timeoutMs, CATEGORY_TIMEOUT_MS)
  const path = target.path

  try {
    return await withEndpointTimeout(
      queueCategoryWrite(path, async () => {
        let store = await load(path)
        let applied = 0
        let skipped = 0

        for (const suggestion of suggestions) {
          // 人工纠正过的会话（lockedSessions）模型永远不再碰。
          if (isSessionLocked(store, suggestion.sessionId)) {
            skipped += 1
            continue
          }
          const previous = categoryAssignmentOfStore(store, suggestion.sessionId)
          // 只保护"真正有分类的人工归类"；空 id 的残留 assignment 仍算空白。
          if (previous !== null && previous.source === 'user' && previous.categoryId !== null) {
            skipped += 1
            continue
          }

          let parentId = null
          let categoryId = null
          for (const name of suggestion.categoryPath) {
            const existing = findCategoryByPathName(store.categories, name, parentId)
            if (existing !== null) {
              categoryId = existing.id
              parentId = existing.id
              continue
            }
            const created = upsertCategory(store, { name, parentId, source: 'model' })
            if (created.error) throw new Error(created.error)
            store = carryLockedSessions(store, created.store)
            categoryId = created.id
            parentId = created.id
          }
          if (categoryId === null) continue

          const assigned = assignSession(store, suggestion.sessionId, categoryId, 'model')
          if (assigned.error) throw new Error(assigned.error)
          store = carryLockedSessions(store, assigned.store)
          applied += 1
        }

        if (applied > 0) await save(path, store)
        return {
          ok: true,
          value: { store, tree: toTree(store), applied, skipped },
        }
      }),
      timeoutMs,
      '应用归类建议',
    )
  } catch (error) {
    return categoryFailure(error)
  }
}

/**
 * 新建或改名分类（POST /category-save）。
 *
 * 所有手工改动固定写 `source:'user'`：分类名一旦被人改过，模型后续只能
 * 走 `applyModelFill` 的"只填空白"路径，不能覆盖。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId, id?, name, parentId?}`。
 * @param options - `{timeoutMs, loadStore, saveStore}`。
 */
export async function saveCategory(ctx, body = {}, options = {}) {
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target
  const request = body
  if (typeof request.name !== 'string' || request.name.trim() === '') {
    return { ok: false, error: 'name 不能为空', httpStatus: 400 }
  }
  if (request.id !== undefined && request.id !== null && typeof request.id !== 'string') {
    return { ok: false, error: 'id 必须是字符串', httpStatus: 400 }
  }
  if (request.parentId !== undefined && request.parentId !== null && typeof request.parentId !== 'string') {
    return { ok: false, error: 'parentId 必须是字符串或 null', httpStatus: 400 }
  }
  const id = typeof request.id === 'string' ? request.id.trim() : ''
  if (request.id !== undefined && request.id !== null && id === '') {
    return { ok: false, error: 'id 不能为空', httpStatus: 400 }
  }
  const input = { name: request.name.trim(), source: 'user' }
  if (id !== '') input.id = id
  if (request.parentId !== undefined) {
    input.parentId = request.parentId === null || request.parentId.trim() === ''
      ? null
      : request.parentId.trim()
  }

  const load = typeof options?.loadStore === 'function' ? options.loadStore : readCategoryStoreFile
  const save = typeof options?.saveStore === 'function' ? options.saveStore : writeCategoryStoreFile
  const timeoutMs = timeoutOption(options?.timeoutMs, CATEGORY_TIMEOUT_MS)
  const path = target.path
  try {
    const result = await withEndpointTimeout(
      queueCategoryWrite(path, async () => {
        const store = await load(path)
        const upserted = upsertCategory(store, input)
        if (upserted.error) return { ok: false, error: upserted.error, httpStatus: 400 }
        const next = carryLockedSessions(store, upserted.store)
        await save(path, next)
        return {
          ok: true,
          value: { ...next, store: next, tree: toTree(next), id: upserted.id },
        }
      }),
      timeoutMs,
      '保存分类',
    )
    return result
  } catch (error) {
    return categoryFailure(error)
  }
}

/**
 * 会话归类 / 取消归类（POST /category-assign）。
 *
 * `categoryId:null` 表示取消；手工操作固定 `source:'user'`。分类不存在
 * 由 category-store 拒绝（400），不会静默落到别的分类。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId, sessionId, categoryId}`。
 * @param options - `{timeoutMs, loadStore, saveStore}`。
 */
export async function assignCategory(ctx, body = {}, options = {}) {
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target
  const request = body
  if (typeof request.sessionId !== 'string' || request.sessionId.trim() === '') {
    return { ok: false, error: 'sessionId 不能为空', httpStatus: 400 }
  }
  const hasCategory = Object.prototype.hasOwnProperty.call(request, 'categoryId')
  if (!hasCategory) {
    return { ok: false, error: 'categoryId 必须是字符串或 null', httpStatus: 400 }
  }
  let categoryId = null
  if (request.categoryId !== null) {
    if (typeof request.categoryId !== 'string' || request.categoryId.trim() === '') {
      return { ok: false, error: 'categoryId 必须是非空字符串或 null', httpStatus: 400 }
    }
    categoryId = request.categoryId.trim()
  }

  const load = typeof options?.loadStore === 'function' ? options.loadStore : readCategoryStoreFile
  const save = typeof options?.saveStore === 'function' ? options.saveStore : writeCategoryStoreFile
  const timeoutMs = timeoutOption(options?.timeoutMs, CATEGORY_TIMEOUT_MS)
  const path = target.path
  try {
    return await withEndpointTimeout(
      queueCategoryWrite(path, async () => {
        const store = await load(path)
        const assigned = assignSession(store, request.sessionId.trim(), categoryId, 'user')
        if (assigned.error) return { ok: false, error: assigned.error, httpStatus: 400 }
        const next = carryLockedSessions(store, assigned.store)
        await save(path, next)
        return { ok: true, value: { ...next, store: next, tree: toTree(next) } }
      }),
      timeoutMs,
      '保存归类',
    )
  } catch (error) {
    return categoryFailure(error)
  }
}

/**
 * 整理动作（POST /category-organize）。
 *
 * 客户端传 `{kind:'merge'|'move'|'split'|'assign'|'upsert'|'delete', ...}`；
 * 这里透传给 `planOrganize` / `applyPlan`，并强制 `source:'user'`——
 * 模型没有调用这个端点的资格。
 *
 * 返回 `{store, undo}`；undo 原样交给 `/category-undo`。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId, op}`。
 * @param options - `{timeoutMs, loadStore, saveStore}`。
 */
export async function organizeCategories(ctx, body = {}, options = {}) {
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target
  const request = body
  if (!isPlainObject(request.op)) {
    return { ok: false, error: 'op 必须是对象', httpStatus: 400 }
  }
  const rawOp = request.op
  const op = { ...rawOp, source: 'user' }
  // 兼容两种客户端写法：规范键 `kind` 与历史键 `action` / `type`。
  if (
    op.action === undefined &&
    op.type === undefined &&
    op.op === undefined &&
    typeof op.kind === 'string'
  ) {
    op.action = op.kind
  }

  const load = typeof options?.loadStore === 'function' ? options.loadStore : readCategoryStoreFile
  const save = typeof options?.saveStore === 'function' ? options.saveStore : writeCategoryStoreFile
  const timeoutMs = timeoutOption(options?.timeoutMs, CATEGORY_TIMEOUT_MS)
  const path = target.path
  try {
    return await withEndpointTimeout(
      queueCategoryWrite(path, async () => {
        const store = await load(path)
        const planned = planOrganize(store, op)
        if (planned.error) return { ok: false, error: planned.error, httpStatus: 400 }
        if (planned.noop === true) {
          return { ok: true, value: { store, undo: { kind: 'noop' } } }
        }
        const applied = applyPlan(store, planned.plan)
        if (applied.error) return { ok: false, error: applied.error, httpStatus: 400 }
        const next = carryLockedSessions(store, applied.store)
        await save(path, next)
        return { ok: true, value: { store: next, undo: applied.undo } }
      }),
      timeoutMs,
      '保存整理',
    )
  } catch (error) {
    return categoryFailure(error)
  }
}

/**
 * 撤销一次整理（POST /category-undo）。
 *
 * `undo` 必须是 `/category-organize` 原样返回的对象；未知 undo 是无操作。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId, undo}`。
 * @param options - `{timeoutMs, loadStore, saveStore}`。
 */
export async function undoCategoryOrganize(ctx, body = {}, options = {}) {
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target
  const request = body
  if (!isPlainObject(request.undo)) {
    return { ok: false, error: 'undo 必须是对象', httpStatus: 400 }
  }

  const load = typeof options?.loadStore === 'function' ? options.loadStore : readCategoryStoreFile
  const save = typeof options?.saveStore === 'function' ? options.saveStore : writeCategoryStoreFile
  const timeoutMs = timeoutOption(options?.timeoutMs, CATEGORY_TIMEOUT_MS)
  const path = target.path
  try {
    return await withEndpointTimeout(
      queueCategoryWrite(path, async () => {
        const store = await load(path)
        const undone = undoOrganize(store, request.undo)
        if (undone.error) return { ok: false, error: undone.error, httpStatus: 400 }
        const next = carryLockedSessions(store, undone.store)
        await save(path, next)
        return { ok: true, value: { ...next, store: next, tree: toTree(next) } }
      }),
      timeoutMs,
      '撤销整理',
    )
  } catch (error) {
    return categoryFailure(error)
  }
}

// ── 分类全自动（队列 / 启动扫描 / 每日维护 / 人工纠正） ──────────
//
// 产品定稿：人不再建分类、不再管分类，只保留「归错了」的纠正权。
// 这一节的模型写入一律遵守：
//   1. 只填空：已归类 / 已锁定 / source:'user' 的数据不碰；
//   2. 自动归类只允许从已有分类名里选；新建必须先攒够支持度；
//   3. 任何失败只记诊断、不重试、不影响其它会话。

/** 自动归类诊断日志（有界内存；不落盘、不泄露正文）。 */
const autoDiagnostics = createDiagnosticsLog({ limit: 200 })

/** 每日维护闸门：每个工作区每个本地自然日至多一次。 */
const dailyMaintenanceGate = createDailyMaintenanceGate()

/** 正在跑维护的工作区，避免同一工作区并发两次模型调用。 */
const maintenanceInFlight = new Set()

/**
 * 空分类清理的每日标记（`<workspaceId>\u0000<本地日>`）。
 *
 * 清理不属于「未归类 >3 / 候选主题 ≥3」那个触发条件：模型建的空分类
 * 恰恰常出现在 unclassified=0 的工作区。所以它每天独立跑一次，只做一次
 * 廉价扫描，不依赖模型是否可用。
 */
const purgedEmptyCategoriesDay = new Set()

/** 工作区 → 新分类支持度累计器（进程内共享，重启后从零开始）。 */
const autoSupportByWorkspace = new Map()

/** 统一记一条自动归类诊断；`detail.kind` 用于分类检索。 */
function recordAutoDiagnostic(message, detail = {}) {
  autoDiagnostics.record({ kind: 'auto-classify', message, ...detail })
}

/**
 * 读自动归类诊断（最新在前）；排障与测试用。
 *
 * @param limit - 最多返回几条。
 */
export function getAutoClassifyDiagnostics(limit = 50) {
  return autoDiagnostics.list(limit)
}

/** 清空诊断（测试用）。 */
export function clearAutoClassifyDiagnostics() {
  autoDiagnostics.clear()
}

/** 新分类支持度累计器（按工作区隔离）。 */
function autoSupportOf(workspaceId) {
  const key = String(workspaceId ?? '')
  let support = autoSupportByWorkspace.get(key)
  if (support === undefined) {
    support = createNewCategorySupport()
    autoSupportByWorkspace.set(key, support)
  }
  return support
}

// ── 启动扫描游标（持久化） ────────────────────────────────────────
//
// 文件：`<topic-map>/auto-classify-state.json`
// 形状：`{ lastRunAt, processed: { [sessionId]: ts } }`
// 作用：下次启动优先处理「从没扫过」的会话，已处理的跳过，避免每次启动
// 都从同一批最近会话开始（那会反复饿死后面的会话）。

/** 游标文件路径。 */
function autoClassifyStatePath() {
  const dir = topicMapDir()
  return dir === null ? null : join(dir, 'auto-classify-state.json')
}

/** 游标写入串行化：两个扫描/进程收尾同时写时后写覆盖前写。 */
let autoStateWriteChain = Promise.resolve()

/** 读游标；缺失/损坏读成空状态（扫描会重新扫，不报错）。 */
async function readAutoClassifyState() {
  const path = autoClassifyStatePath()
  if (path === null) return normalizeAutoClassifyState(null)
  try {
    const text = await readFile(path, 'utf8')
    return normalizeAutoClassifyState(JSON.parse(text))
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      recordAutoDiagnostic(`自动归类游标读取失败：${errorText(error).slice(0, 120)}`, {
        kind: 'auto-state-failed',
      })
    }
    return normalizeAutoClassifyState(null)
  }
}

/** 原子写游标（tmp + rename）；失败只记诊断，不影响扫描本身。 */
async function writeAutoClassifyState(state) {
  const path = autoClassifyStatePath()
  const normalized = normalizeAutoClassifyState(state)
  if (path === null) return normalized
  autoStateWriteChain = autoStateWriteChain.then(async () => {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(normalized, null, 2), 'utf8')
    await rename(tmp, path)
  }).catch(error => {
    recordAutoDiagnostic(`自动归类游标写入失败：${errorText(error).slice(0, 120)}`, {
      kind: 'auto-state-failed',
    })
  })
  await autoStateWriteChain
  return normalized
}

/** 按需触发节流：同一工作区 10 分钟内只允许手动触发一次。 */
const autoStartThrottle = createAutoStartThrottle()

// ── 队列进度（状态端点用） ────────────────────────────────────────

/** 工作区 → 已入队（含在跑）的 sessionId；`running`/`queued` 由它算。 */
const autoQueuedByWorkspace = new Map()

function autoQueuedSet(workspaceId) {
  const key = String(workspaceId ?? '')
  let set = autoQueuedByWorkspace.get(key)
  if (set === undefined) {
    set = new Set()
    autoQueuedByWorkspace.set(key, set)
  }
  return set
}

function trackAutoQueued(workspaceId, sessionId) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') return
  autoQueuedSet(workspaceId).add(sid)
}

function untrackAutoQueued(workspaceId, sessionId) {
  const key = String(workspaceId ?? '')
  const set = autoQueuedByWorkspace.get(key)
  if (set === undefined) return
  set.delete(sessionId)
  // 空集合不长期占内存。
  if (set.size === 0) autoQueuedByWorkspace.delete(key)
}

function autoQueuedCount(workspaceId) {
  return autoQueuedByWorkspace.get(String(workspaceId ?? ''))?.size ?? 0
}

// ── 冷启动批次进度 ────────────────────────────────────────────────

/**
 * 工作区 → 本次队列代里已经参与过冷启动批处理的 sessionId。
 *
 * 冷启动是"一次批量调模型、批内互相投票"：同一队列里的后续任务如果再次
 * 触发批量，会对同一批会话反复调模型且票数不会增长。所以批处理过的会话
 * 在本代里跳过；只有它重新产生活动（再次入队）才清除该标记。
 */
const coldStartTouchedByWorkspace = new Map()

function coldStartTouchedSet(workspaceId) {
  const key = String(workspaceId ?? '')
  let set = coldStartTouchedByWorkspace.get(key)
  if (set === undefined) {
    set = new Set()
    coldStartTouchedByWorkspace.set(key, set)
  }
  return set
}

function forgetColdStartSession(workspaceId, sessionId) {
  const set = coldStartTouchedByWorkspace.get(String(workspaceId ?? ''))
  if (set === undefined) return
  set.delete(sessionId)
  if (set.size === 0) coldStartTouchedByWorkspace.delete(String(workspaceId ?? ''))
}

/**
 * 解析会话所属工作区并把它入队。
 *
 * `immediate:true` 跳过 60 秒防抖（按需触发用）；默认走防抖。
 *
 * @returns `{queued, workspaceId}`；找不到工作区/参数非法时 `queued:false`。
 */
function enqueueAutoSession(ctx, sessionId, options = {}) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') return { queued: false, reason: 'invalid-session' }
  const workspace = resolveWorkspaceOfSession(ctx, sid)
  if (workspace === null) return { queued: false, reason: 'no-workspace' }
  // 重新产生活动 = 允许它再次进入冷启动批次（例如上一批因低置信度没落库）。
  forgetColdStartSession(workspace.id, sid)
  const queued = options.immediate === true
    ? queueAutoClassifyNow(ctx, sid)
    : queueAutoClassify(ctx, sid)
  if (queued) trackAutoQueued(workspace.id, sid)
  return { queued, workspaceId: workspace.id }
}

/**
 * 记一次 `/categorize` 的弃用访问。
 *
 * 旧端点保留一个版本给老客户端，但每次访问都留痕：产品上它已经被
 * `/category-suggest` + `/category-apply-suggestions` 取代。
 */
function recordDeprecatedCategorize() {
  autoDiagnostics.record({
    kind: 'deprecated-endpoint',
    message: '/categorize 已弃用，客户端应改用 /category-suggest',
  })
}

/** 从一个宿主事件 payload 里尽力取 sessionId（事件形状各版本不同）。 */
function sessionIdOfAutoEvent(payload) {
  if (payload === null || payload === undefined) return ''
  if (typeof payload === 'string') return payload.trim()
  if (!isPlainObject(payload)) return ''
  const candidates = [
    payload.sessionId,
    typeof payload.id === 'string' ? payload.id : '',
    payload.session?.id,
    payload.session?.header?.id,
    payload.header?.id,
    payload.info?.id,
    payload.data?.sessionId,
    payload.data?.session?.id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

/** 会话属于哪个工作区（registry 的 sessionIds 是权威来源）。 */
function resolveWorkspaceOfSession(ctx, sessionId) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') return null
  for (const workspace of listWorkspaces(ctx)) {
    if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sid)) return workspace
  }
  return null
}

/** 自动归类有没有可用模型：显式配置 / 自定义端点 / 宿主 llm 服务。 */
function hasAutoClassifyModel(ctx, config = readConfig()) {
  if (config.provider !== '' && config.model !== '') return true
  if (hasCustomEndpoint(config)) return true
  try {
    return ctx.get('llm') !== undefined
  } catch {
    return false
  }
}

/**
 * 自动归类一个会话（队列的实际执行体）。
 *
 * 流程与 `/category-suggest` 完全同源：
 *   1. 预检：开关 / 锁定 / 已归类 / 会话存在 / 模型；
 *   2. 取材：`categoryMaterialOfSession`（与建议端点共用）；
 *   3. 提示：`buildCategorySuggestionPrompt` + 现有分类路径；
 *   4. 落库：`applyAutoClassification`（只填空、锁定优先、新建攒够 3 个会话）。
 *
 * 只在模型调用前读一次分类文件做预检；模型返回后在同一写队列里重读再落库，
 * 避免"模型跑的时候人纠正了"被覆盖。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @returns `{status, ...}`；任何异常都在内部收口，不向队列抛。
 */
export async function autoClassifySession(ctx, sessionId) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') return { status: 'skipped', reason: 'invalid-session' }
  try {
    return await autoClassifySessionInner(ctx, sid)
  } finally {
    // 状态端点的 running/queued 跟着执行结束一起归零。
    const workspace = resolveWorkspaceOfSession(ctx, sid)
    if (workspace !== null) untrackAutoQueued(workspace.id, sid)
  }
}

/** `autoClassifySession` 的实现体；包一层是为了 finally 清理排队进度。 */
async function autoClassifySessionInner(ctx, sessionId) {
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') return { status: 'skipped', reason: 'invalid-session' }
  const config = readConfig()
  if (config.autoClassify === false) return { status: 'skipped', reason: 'disabled' }

  const workspace = resolveWorkspaceOfSession(ctx, sid)
  if (workspace === null) return { status: 'skipped', reason: 'no-workspace' }
  const path = categoryStorePath(workspace.id)
  if (path === null) return { status: 'skipped', reason: 'no-store' }

  try {
    await ensureLegacyCategoryImport(ctx, workspace.id, path)
  } catch {
    // 导入失败不影响自动归类。
  }

  let preview
  try {
    preview = await readCategoryStoreFile(path)
  } catch (error) {
    recordAutoDiagnostic(`自动归类读取分类失败：${errorText(error).slice(0, 120)}`, {
      kind: 'auto-classify-failed',
      sessionId: sid,
    })
    return { status: 'failed', reason: 'store-read' }
  }
  if (isSessionLocked(preview, sid)) return { status: 'skipped', reason: 'locked' }
  if (!isSessionUnclassified(preview, sid)) return { status: 'skipped', reason: 'classified' }

  // 冷启动：工作区还没有任何分类时，单会话 1 票永远达不到新建阈值；
  // 改为把队列里至多 20 个未归类会话批量送模型、批内互相投票。
  const coldTouched = coldStartTouchedSet(workspace.id)
  if (coldTouched.has(sid)) return { status: 'skipped', reason: 'cold-start-batch' }
  if (!Array.isArray(preview.categories) || preview.categories.length === 0) {
    return await autoClassifyColdStart(ctx, workspace, preview, config, path, sid)
  }

  const llm = ctx.get('llm')
  const route = await resolveWorkspaceRoute(ctx, config, workspace.sessionIds ?? [])
  if (llm === undefined || route === null) {
    recordAutoDiagnostic('自动归类跳过：模型未配置', {
      kind: 'auto-classify-skipped',
      sessionId: sid,
      reason: 'no-model',
    })
    return { status: 'skipped', reason: 'no-model' }
  }

  let material
  let suggestion
  try {
    const list = await listWorkspaceSessions(ctx, null, workspace.id)
    const session = list.sessions.find(item => item.sessionId === sid)
    if (session === undefined) return { status: 'skipped', reason: 'no-session' }
    material = await categoryMaterialOfSession(ctx, session)
    const prompt = buildCategorySuggestionPrompt([material], [], listCategoryPaths(preview))
    const text = await askOnce(llm, route, prompt.system, prompt.user, undefined, {
      maxTokens: 2048,
      // limits 必须带 sessionId，否则真机 400 MissingSessionID。
      sessionId: sid,
    })
    const parsed = parseCategorySuggestions(text, [material])
    const first = parsed.suggestions[0]
    if (first === undefined) {
      recordAutoDiagnostic(`自动归类未采纳：${parsed.error ?? '模型没有给出可用归类'}`, {
        kind: 'auto-classify-skipped',
        sessionId: sid,
        reason: 'unparsed',
      })
      return { status: 'failed', reason: 'unparsed' }
    }
    suggestion = first
  } catch (error) {
    recordAutoDiagnostic(`自动归类失败：${errorText(error).slice(0, 160)}`, {
      kind: 'auto-classify-failed',
      sessionId: sid,
    })
    return { status: 'failed', reason: 'model' }
  }

  try {
    return await queueCategoryWrite(path, async () => {
      const store = await readCategoryStoreFile(path)
      const result = applyAutoClassification(store, sid, suggestion, autoSupportOf(workspace.id))
      if (result.action === 'skip') return { status: 'skipped', reason: result.reason }
      if (result.action === 'pending-new') {
        recordAutoDiagnostic(
          `自动归类等待更多支持：${result.displayPath ?? (result.path ?? []).join(' › ')}（${result.count}/${result.threshold}）`,
          { kind: 'auto-classify-pending', sessionId: sid, count: result.count, threshold: result.threshold },
        )
        return { status: 'pending', count: result.count, threshold: result.threshold }
      }
      if (result.action === 'failed') {
        recordAutoDiagnostic(`自动归类落库失败：${result.error}`, {
          kind: 'auto-classify-failed',
          sessionId: sid,
        })
        return { status: 'failed', reason: result.error }
      }
      await writeCategoryStoreFile(path, result.store)
      return {
        status: result.action,
        categoryId: result.categoryId ?? null,
        assigned: Array.isArray(result.assigned) ? result.assigned : [],
      }
    })
  } catch (error) {
    recordAutoDiagnostic(`自动归类落库失败：${errorText(error).slice(0, 160)}`, {
      kind: 'auto-classify-failed',
      sessionId: sid,
    })
    return { status: 'failed', reason: 'store-write' }
  }
}

/**
 * 冷启动批量归类。
 *
 * 触发条件：该工作区 store 里 `categories.length === 0`。把当前队列里
 * 至多 20 个未归类、未锁定的会话一次性送模型（复用 /category-suggest 的
 * 批量提示词 + 本地分组），批内投票后由 `applyColdStartBatch` 落库。
 *
 * 同一队列代里每个会话只参与一次批量；重新产生活动（再次入队）才允许
 * 再次参与，避免对同一批会话反复调模型。
 *
 * @param ctx - Host context。
 * @param workspace - 工作区。
 * @param preview - 冷启动判定时读到的空 store。
 * @param config - 运行配置。
 * @param path - 分类 store 路径。
 * @param sessionId - 当前正在执行的会话（保证它在批次里）。
 */
async function autoClassifyColdStart(ctx, workspace, preview, config, path, sessionId) {
  const key = String(workspace.id ?? '')
  const touched = coldStartTouchedSet(key)

  const ids = []
  if (!touched.has(sessionId)) ids.push(sessionId)
  for (const queuedId of autoQueuedSet(key)) {
    if (ids.length >= COLD_START_BATCH_MAX) break
    if (touched.has(queuedId) || ids.includes(queuedId)) continue
    ids.push(queuedId)
  }

  // 先确认模型可用：冷启动批量比单会话贵，不能因为聊天记录读不到就白跑。
  const llm = ctx.get('llm')
  const route = await resolveWorkspaceRoute(ctx, config, workspace.sessionIds ?? [])
  if (llm === undefined || route === null) {
    recordAutoDiagnostic('冷启动批量归类跳过：模型未配置', {
      kind: 'auto-classify-skipped',
      workspaceId: key,
      reason: 'no-model',
    })
    return { status: 'skipped', reason: 'no-model' }
  }

  const list = await listWorkspaceSessions(ctx, null, key)
  const byId = new Map(list.sessions.map(session => [session.sessionId, session]))
  const selected = []
  for (const id of ids) {
    if (selected.length >= COLD_START_BATCH_MAX) break
    const session = byId.get(id)
    if (session === undefined) continue
    if (isSessionLocked(preview, id) || !isSessionUnclassified(preview, id)) continue
    selected.push(session)
  }
  if (selected.length === 0) return { status: 'skipped', reason: 'cold-start-empty' }
  for (const session of selected) touched.add(session.sessionId)

  try {
    const materials = await categoryMaterialsOf(ctx, selected)
    if (materials.length === 0) return { status: 'skipped', reason: 'cold-start-empty' }
    const groups = groupCategorySuggestions(materials)
    // 冷启动用 /category-suggest 的原始批量提示词（不追加"已有分类/≥3票"规则）。
    const requested = await requestCategorySuggestions(llm, route, materials, groups)
    if (requested.failures.length > 0) {
      recordAutoDiagnostic(
        `冷启动批量归类部分失败：${requested.failures.map(item => `第 ${item.batch} 批：${item.error}`).join('；').slice(0, 200)}`,
        { kind: 'auto-classify-failed', workspaceId: key, coldStart: true },
      )
    }
    if (requested.suggestions.length === 0) {
      recordAutoDiagnostic('冷启动批量归类未采纳：模型没有给出可用归类', {
        kind: 'auto-classify-skipped',
        workspaceId: key,
        reason: 'unparsed',
      })
      return { status: 'failed', reason: 'unparsed' }
    }

    const applied = await queueCategoryWrite(path, async () => {
      const store = await readCategoryStoreFile(path)
      const result = applyColdStartBatch(store, requested.suggestions)
      if (result.assigned.length > 0 || result.created.length > 0) {
        await writeCategoryStoreFile(path, result.store)
      }
      return result
    })

    recordAutoDiagnostic(
      `冷启动批量归类：${selected.length} 个会话、${requested.suggestions.length} 条建议、落库 ${applied.assigned.length} 个`,
      {
        kind: 'cold-start',
        workspaceId: key,
        sessions: selected.length,
        suggestions: requested.suggestions.length,
        assigned: applied.assigned.length,
        created: applied.created.length,
        kept: applied.kept.length,
      },
    )
    const mine = applied.assigned.find(item => item.sessionId === sessionId)
    return {
      status: mine === undefined ? 'pending' : 'assigned',
      coldStart: true,
      batch: {
        sessions: selected.length,
        suggestions: requested.suggestions.length,
        assigned: applied.assigned.length,
        created: applied.created.length,
        kept: applied.kept.length,
      },
      ...(mine === undefined
        ? { reason: 'cold-start-kept' }
        : { categoryId: mine.categoryId }),
    }
  } catch (error) {
    recordAutoDiagnostic(`冷启动批量归类失败：${errorText(error).slice(0, 160)}`, {
      kind: 'auto-classify-failed',
      workspaceId: key,
      coldStart: true,
    })
    return { status: 'failed', reason: 'cold-start' }
  }
}

/**
 * 启动全量扫描（Host 接线版）：遍历所有工作区、把未归类会话公平入队。
 *
 * 延迟 30 秒由 `installCategoryAuto` 负责；模型未配置 / 关闭时直接跳过。
 * 名额按工作区轮转分配（每区首轮最多 10 个），剩余按未归类数补；
 * 单次最多 60 个。已写进游标的会话跳过，入队成功的会记进游标。
 *
 * @param ctx - Host context。
 * @returns `runStartupScan` 的结果。
 */
export async function runStartupCategoryScan(ctx) {
  const config = readConfig()
  const state = await readAutoClassifyState()
  const result = await runStartupScan({
    enabled: config.autoClassify !== false,
    isModelConfigured: () => hasAutoClassifyModel(ctx, config),
    listWorkspaces: () => listWorkspaces(ctx),
    collectSessions: async workspaceId => (await listWorkspaceSessions(ctx, null, workspaceId)).sessions,
    readStore: async workspaceId => {
      const path = categoryStorePath(workspaceId)
      if (path === null) return {}
      await ensureLegacyCategoryImport(ctx, workspaceId, path)
      return readCategoryStoreFile(path)
    },
    isProcessed: sessionId => Object.prototype.hasOwnProperty.call(state.processed, sessionId),
    enqueue: candidateSessionId => enqueueAutoSession(ctx, candidateSessionId).queued,
    log: (message, detail) => autoDiagnostics.record({ message, ...detail }),
  })
  // 跳过（关闭 / 无模型）时不写游标：下次启动还要继续尝试。
  if (result.skipped === '') {
    const at = Date.now()
    const next = addAutoProcessedSessions(state, result.enqueued, { at })
    await writeAutoClassifyState(next)
  }
  return result
}

/**
 * 把工作区里**未归类且未锁定**的会话立即入队（单次 ≤20）。
 *
 * 是 `/category-auto-start` 与 `/category-reset` 共用的落点，节流规则一致：
 * 同一工作区 10 分钟内只允许触发一次。
 *
 * @returns `{queued, throttled?, retryAfterMs?}`。
 */
async function enqueueWorkspaceUnclassified(ctx, workspace, store) {
  const key = String(workspace.id ?? '')
  if (key === '') return { queued: 0, reason: 'no-workspace' }
  const claim = autoStartThrottle.claim(key)
  if (!claim.allowed) {
    return { queued: 0, throttled: true, retryAfterMs: claim.retryAfterMs }
  }
  const list = await listWorkspaceSessions(ctx, null, key)
  const candidates = list.sessions
    .filter(session =>
      isSessionUnclassified(store, session.sessionId) && !isSessionLocked(store, session.sessionId))
    .sort((left, right) => {
      const leftTime = Number.isFinite(left.lastActive) ? left.lastActive : -Infinity
      const rightTime = Number.isFinite(right.lastActive) ? right.lastActive : -Infinity
      if (rightTime !== leftTime) return rightTime - leftTime
      return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
    })
    .slice(0, AUTO_START_MAX_SESSIONS)

  let queued = 0
  for (const session of candidates) {
    const result = enqueueAutoSession(ctx, session.sessionId, { immediate: true })
    if (result.queued) queued += 1
  }
  return { queued }
}

/**
 * 按需触发自动归类（POST /category-auto-start）。
 *
 * 用户显式点"现在归类"时不该再等 60 秒防抖：
 *   - 立即把该工作区未归类且未锁定的会话入队（单次 ≤20，按 lastActive 倒序）；
 *   - 队列本身并发 1，所以只会串行跑；
 *   - 同一工作区 10 分钟内只允许触发一次（内存节流，返回 throttled）。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId}`。
 * @returns `{ok:true, value:{queued, throttled?, retryAfterMs?}}` 或错误信封。
 */
export async function startCategoryAuto(ctx, body = {}) {
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target
  const key = String(target.workspace.id ?? '')
  if (key === '') return { ok: false, error: '工作区不存在', httpStatus: 404 }

  let store
  try {
    store = await readCategoryStoreFile(target.path)
  } catch (error) {
    return categoryFailure(error)
  }
  const queued = await enqueueWorkspaceUnclassified(ctx, target.workspace, store)
  return { ok: true, value: queued }
}

/**
 * 工作区「重新归类」（POST /category-reset）。
 *
 * 语义：把模型建的分类与归类整个清掉，让工作区回到「只有人工数据」的状态，
 * 然后重新入队未归类会话。**危险操作，必须显式 `confirm:true`。**
 *
 * 保留规则见 `resetModelCategories`：
 *   - `source:'user'` 分类；
 *   - 人工归类指向的分类（纠错不能被一次重置抹掉）；
 *   - 锁定会话指向的分类与 `lockedSessions` 本身。
 *
 * 同时清掉启动游标里该工作区的会话，让它们重新参与扫描；入队遵循既有
 * 「单次 ≤20 + 10 分钟节流」规则。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId, confirm:true}`。
 * @param options - `{timeoutMs, loadStore, saveStore}`。
 * @returns `{ok:true, value:{removedCategories, removedAssignments, queued, keptUser}}`。
 */
export async function resetCategoryWorkspace(ctx, body = {}, options = {}) {
  if (!isPlainObject(body) || body.confirm !== true) {
    return { ok: false, error: 'confirm 必须为 true（危险操作请显式确认）', httpStatus: 400 }
  }
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target

  const load = typeof options?.loadStore === 'function' ? options.loadStore : readCategoryStoreFile
  const save = typeof options?.saveStore === 'function' ? options.saveStore : writeCategoryStoreFile
  const timeoutMs = timeoutOption(options?.timeoutMs, CATEGORY_TIMEOUT_MS)
  const path = target.path
  const key = String(target.workspace.id ?? '')

  let reset
  try {
    reset = await withEndpointTimeout(
      queueCategoryWrite(path, async () => {
        const store = await load(path)
        const result = resetModelCategories(store)
        if (result.removedCategories > 0 || result.removedAssignments > 0) {
          await save(path, result.store)
        }
        return result
      }),
      timeoutMs,
      '重置分类',
    )
  } catch (error) {
    return categoryFailure(error)
  }

  // 清掉该工作区的启动游标：这些会话要能重新参与扫描。
  try {
    const state = await readAutoClassifyState()
    const sessionIds = Array.isArray(target.workspace.sessionIds)
      ? target.workspace.sessionIds.map(String)
      : []
    await writeAutoClassifyState(removeAutoProcessedSessions(state, sessionIds))
  } catch (error) {
    recordAutoDiagnostic(`重置分类清理游标失败：${errorText(error).slice(0, 120)}`, {
      kind: 'maintenance-reset-failed',
      workspaceId: key,
    })
  }

  // 清掉进程内该工作区的新分类支持度与冷启动批次标记：重置后要重新投票。
  autoSupportByWorkspace.delete(key)
  coldStartTouchedByWorkspace.delete(key)

  let queued = 0
  let throttled = null
  try {
    const info = await enqueueWorkspaceUnclassified(ctx, target.workspace, reset.store)
    queued = info.queued
    if (info.throttled === true) throttled = info
  } catch (error) {
    recordAutoDiagnostic(`重置分类入队失败：${errorText(error).slice(0, 120)}`, {
      kind: 'maintenance-reset-failed',
      workspaceId: key,
    })
  }

  const value = {
    removedCategories: reset.removedCategories,
    removedAssignments: reset.removedAssignments,
    queued,
    keptUser: reset.keptUser,
  }
  if (throttled !== null) {
    value.throttled = true
    value.retryAfterMs = throttled.retryAfterMs
  }
  recordAutoDiagnostic(
    `重置分类：删除 ${reset.removedCategories} 个分类、${reset.removedAssignments} 条归类，保留人工分类 ${reset.keptUser} 个`,
    {
      kind: 'maintenance-reset',
      workspaceId: key,
      removedCategories: reset.removedCategories,
      removedAssignments: reset.removedAssignments,
      keptUser: reset.keptUser,
      queued,
    },
  )
  return { ok: true, value }
}

/**
 * 自动归类状态（POST /category-auto-status）。
 *
 * 给界面显示「正在归类 N 个会话…」：`queued` 是本次进程里已入队（含在跑）
 * 的会话数，`running` 是它的布尔化；`model:'no-model'` 表示暂时没法归类。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId}`。
 * @returns `{ok:true, value:{categories, unclassified, running, queued, lastRunAt, model}}`。
 */
export async function statusCategoryAuto(ctx, body = {}) {
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target
  const key = String(target.workspace.id ?? '')
  let store
  try {
    store = await readCategoryStoreFile(target.path)
  } catch (error) {
    return categoryFailure(error)
  }
  const list = await listWorkspaceSessions(ctx, null, key)
  const unclassified = list.sessions.filter(session =>
    isSessionUnclassified(store, session.sessionId) && !isSessionLocked(store, session.sessionId)).length
  const state = await readAutoClassifyState()
  const queued = autoQueuedCount(key)
  return {
    ok: true,
    value: {
      categories: Array.isArray(store.categories) ? store.categories.length : 0,
      unclassified,
      running: queued > 0,
      queued,
      lastRunAt: state.lastRunAt,
      model: hasAutoClassifyModel(ctx) ? 'ready' : 'no-model',
    },
  }
}

/** 等自动归类队列当前串行链跑完（测试与进程收尾用）。 */
export async function flushAutoClassify() {
  await flushAutoClassifyQueue()
}

/**
 * 每日维护：合并近义分类 / 拆分过大会话组 / 改名。
 *
 * 触发口在路由层（每天首次活动），这里只负责：
 *   - 用与建议端点同源的取材判断条件；
 *   - 满足条件才调模型；
 *   - 模型输出经 `normalizeMaintenanceOps` 保护后，走 `applyMaintenanceSteps`
 *     （内部只用 applyModelFill + organize 的 plan/apply）。
 *
 * 模型调用失败只记日志；当天不再重试（产品要的是每天一次，不是追到成功）。
 *
 * @param ctx - Host context。
 * @param workspaceId - 工作区 id（可缺省）。
 * @returns `{ran, reason?, applied?}`。
 */
export async function runDailyCategoryMaintenance(ctx, workspaceId) {
  const config = readConfig()
  if (config.autoClassify === false) return { ran: false, reason: 'disabled' }
  const target = resolveEndpointWorkspace(ctx, workspaceId, { required: false })
  if (!target.ok || target.workspace === null || target.workspace === undefined) {
    return { ran: false, reason: 'no-workspace' }
  }
  const workspace = target.workspace
  const key = String(workspace.id ?? '')
  if (key === '') return { ran: false, reason: 'no-workspace' }
  if (dailyMaintenanceGate.ranToday(key)) return { ran: false, reason: 'already-ran' }
  if (maintenanceInFlight.has(key)) return { ran: false, reason: 'in-flight' }

  const path = categoryStorePath(key)
  if (path === null) return { ran: false, reason: 'no-store' }
  await ensureLegacyCategoryImport(ctx, key, path)

  let store
  try {
    store = await readCategoryStoreFile(path)
  } catch (error) {
    recordAutoDiagnostic(`每日维护读取分类失败：${errorText(error).slice(0, 120)}`, {
      kind: 'maintenance-failed',
      workspaceId: key,
    })
    return { ran: false, reason: 'store-read' }
  }

  // 每日维护第一步：清理「模型建了但从未归进过会话」的空分类。
  // 不依赖未归类数量触发（unclassified=0 的工作区恰恰最容易留空分类），
  // 也不依赖模型可用；每个工作区每个本地自然日只扫一次。
  const purgeKey = `${key}\u0000${localDayKey(Date.now())}`
  if (!purgedEmptyCategoriesDay.has(purgeKey)) {
    try {
      // 走与用户写同一队列：清理时重读最新 store，避免和 /category-save 抢写。
      const purged = await queueCategoryWrite(path, async () => {
        const latest = await readCategoryStoreFile(path)
        const result = purgeEmptyCategories(latest)
        if (result.count > 0) await writeCategoryStoreFile(path, result.store)
        return result
      })
      if (purged.count > 0) {
        store = purged.store
        recordAutoDiagnostic(`purged-empty-categories: ${purged.count}`, {
          kind: 'maintenance-purge',
          workspaceId: key,
          purged: purged.count,
          categories: purged.purged.map(item => item.id),
        })
      }
    } catch (error) {
      recordAutoDiagnostic(`空分类清理失败：${errorText(error).slice(0, 120)}`, {
        kind: 'maintenance-purge-failed',
        workspaceId: key,
      })
    }
    purgedEmptyCategoriesDay.add(purgeKey)
  }

  if (!Array.isArray(store.categories) || store.categories.length === 0) {
    // 还没有任何分类时维护无事可做；不占当天名额，留给自动归类先建分类。
    return { ran: false, reason: 'no-categories' }
  }

  const list = await listWorkspaceSessions(ctx, null, key)
  const unclassified = list.sessions.filter(session =>
    isSessionUnclassified(store, session.sessionId) && !isSessionLocked(store, session.sessionId))

  // 条件一：未归类 > 3 直接成立；否则看本地聚类里有没有 ≥3 个会话的候选主题。
  let themeSizes = []
  if (unclassified.length <= DAILY_MAINTENANCE_UNCLASSIFIED_THRESHOLD) {
    try {
      const materials = await categoryMaterialsOf(ctx, unclassified.slice(0, 30))
      themeSizes = groupCategorySuggestions(materials).map(group => group.sessions.length)
    } catch {
      themeSizes = []
    }
  }
  const claim = dailyMaintenanceGate.claim(key, {
    unclassifiedCount: unclassified.length,
    themeSizes,
  })
  if (!claim.run) return { ran: false, reason: claim.reason }

  const llm = ctx.get('llm')
  const route = await resolveWorkspaceRoute(ctx, config, workspace.sessionIds ?? [])
  if (llm === undefined || route === null) {
    recordAutoDiagnostic('每日维护跳过：模型未配置', { kind: 'maintenance-skipped', workspaceId: key })
    return { ran: false, reason: 'no-model' }
  }

  maintenanceInFlight.add(key)
  try {
    const prompt = buildMaintenancePrompt(store, unclassified.map(session => ({
      sessionId: session.sessionId,
      title: session.title,
    })))
    const text = await askOnce(llm, route, prompt.system, prompt.user, undefined, {
      maxTokens: 2048,
      sessionId: unclassified[0]?.sessionId ?? String((workspace.sessionIds ?? [])[0] ?? ''),
    })
    const parsed = parseMaintenanceOps(text)
    if (parsed.error !== undefined) {
      recordAutoDiagnostic(`每日维护未采纳：${parsed.error}`, { kind: 'maintenance-skipped', workspaceId: key })
      return { ran: true, applied: 0, reason: 'unparsed' }
    }
    const normalized = normalizeMaintenanceOps(store, parsed.ops)
    if (normalized.steps.length === 0) {
      return { ran: true, applied: 0, skipped: normalized.skipped.length }
    }
    const applied = applyMaintenanceSteps(store, normalized.steps)
    if (applied.applied.length > 0) await writeCategoryStoreFile(path, applied.store)
    recordAutoDiagnostic(`每日维护完成：${applied.applied.length} 项`, {
      kind: 'maintenance',
      workspaceId: key,
      applied: applied.applied.length,
      skipped: applied.skipped.length,
    })
    return {
      ran: true,
      applied: applied.applied.length,
      skipped: applied.skipped.length,
      summaries: applied.applied.map(item => item.summary),
    }
  } catch (error) {
    recordAutoDiagnostic(`每日维护失败：${errorText(error).slice(0, 160)}`, {
      kind: 'maintenance-failed',
      workspaceId: key,
    })
    return { ran: true, applied: 0, reason: 'error' }
  } finally {
    maintenanceInFlight.delete(key)
  }
}

/**
 * 路由层的"活动"钩子：会话入队 + 尝试每日维护。
 *
 * 永远同步返回、异常全吞：自动能力不能影响正常请求的响应。
 */
function noteCategoryAutoActivity(ctx, body) {
  try {
    const config = readConfig()
    if (config.autoClassify === false) return
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId !== '') enqueueAutoSession(ctx, sessionId)
    runDailyCategoryMaintenance(ctx, body?.workspaceId).catch(() => { /* 已内部记录 */ })
  } catch {
    // 自动能力是旁路，不影响主流程。
  }
}

/**
 * 会话归类纠正（POST /category-override）。
 *
 * 这是产品里人唯一保留的权力：归错了就改，并且锁住不让模型再动。
 *   - `categoryId:null` = 移出分类（保持锁定）；
 *   - 归类与锁定都写 `source:'user'` / `by:'user'`；
 *   - 幂等：重复调用得到完全相同的 store（锁定时间戳不刷新）。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId, sessionId, categoryId|null}`。
 * @param options - `{timeoutMs, loadStore, saveStore, now}`。
 * @returns `{ok:true, value:{store, tree, locked:true}}` 或错误信封。
 */
export async function overrideCategoryAssignment(ctx, body = {}, options = {}) {
  const target = await resolveReadyCategoryTarget(ctx, body)
  if (!target.ok) return target
  const request = body
  if (typeof request.sessionId !== 'string' || request.sessionId.trim() === '') {
    return { ok: false, error: 'sessionId 不能为空', httpStatus: 400 }
  }
  if (!Object.prototype.hasOwnProperty.call(request, 'categoryId')) {
    return { ok: false, error: 'categoryId 必须是字符串或 null', httpStatus: 400 }
  }
  let categoryId = null
  if (request.categoryId !== null) {
    if (typeof request.categoryId !== 'string' || request.categoryId.trim() === '') {
      return { ok: false, error: 'categoryId 必须是非空字符串或 null', httpStatus: 400 }
    }
    categoryId = request.categoryId.trim()
  }

  const load = typeof options?.loadStore === 'function' ? options.loadStore : readCategoryStoreFile
  const save = typeof options?.saveStore === 'function' ? options.saveStore : writeCategoryStoreFile
  const timeoutMs = timeoutOption(options?.timeoutMs, CATEGORY_TIMEOUT_MS)
  const now = typeof options.now === 'function' ? options.now : Date.now
  const path = target.path
  const sessionId = request.sessionId.trim()

  try {
    return await withEndpointTimeout(
      queueCategoryWrite(path, async () => {
        const store = await load(path)
        const assigned = assignSession(store, sessionId, categoryId, 'user')
        if (assigned.error) return { ok: false, error: assigned.error, httpStatus: 400 }
        const locked = lockSession(carryLockedSessions(store, assigned.store), sessionId, { at: now() })
        if (locked.error) return { ok: false, error: locked.error, httpStatus: 400 }
        await save(path, locked.store)
        return {
          ok: true,
          value: { store: locked.store, tree: toTree(locked.store), locked: true },
        }
      }),
      timeoutMs,
      '保存归类纠正',
    )
  } catch (error) {
    return categoryFailure(error)
  }
}

/**
 * 安装分类全自动：默认队列 + 会话结束事件 + 延迟 30 秒的启动扫描。
 *
 * 事件名在不同宿主版本里不一样，逐个 best-effort 订阅；订阅不到也没关系，
 * `/session` 等路由上的活动钩子仍会在 60 秒防抖后把会话入队。
 */
function installCategoryAuto(ctx) {
  configureAutoClassify({
    execute: (jobCtx, sessionId) => autoClassifySession(jobCtx, sessionId),
    onError: (error, jobCtx, sessionId) => {
      autoDiagnostics.record({
        kind: 'auto-classify-failed',
        sessionId,
        message: errorText(error).slice(0, 160),
      })
    },
  })

  if (typeof ctx.on === 'function') {
    for (const eventName of ['agent/end', 'session/disposed', 'session/close']) {
      try {
        ctx.on(eventName, payload => {
          const sessionId = sessionIdOfAutoEvent(payload)
          if (sessionId !== '') enqueueAutoSession(ctx, sessionId)
        })
      } catch {
        // 宿主不认识这个事件：忽略，其它钩子仍然生效。
      }
    }
  }

  const scheduleScan = () => {
    const timer = setTimeout(() => {
      runStartupCategoryScan(ctx).catch(() => { /* 内部已记录诊断 */ })
    }, STARTUP_SCAN_DELAY_MS)
    if (timer !== null && timer !== undefined && typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(scheduleScan)
      return
    } catch {
      // effect 注册失败就退化成裸定时器（同样 unref）。
    }
  }
  scheduleScan()
}

// ── /changes 与 /rollback-plan ───────────────────────────────────

/** 变更文件扩展名粗分：只服务展示，不追求语言学精确。 */
const CHANGE_CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'vue', 'svelte',
  'py', 'pyw', 'go', 'rs', 'java', 'kt', 'kts', 'cs', 'fs', 'vb',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'm', 'mm', 'swift',
  'rb', 'php', 'pl', 'pm', 'lua', 'r', 'jl', 'scala', 'clj', 'ex', 'exs',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql',
  'css', 'scss', 'sass', 'less', 'styl', 'html', 'htm', 'xml', 'svg',
  'proto', 'graphql', 'gql', 'dockerfile', 'makefile',
])
const CHANGE_DOC_EXT = new Set([
  'md', 'markdown', 'mdx', 'txt', 'rst', 'adoc', 'asciidoc', 'text',
  'tex', 'pdf', 'doc', 'docx', 'rtf', 'org', 'typ',
])
const CHANGE_CONFIG_EXT = new Set([
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'properties', 'plist', 'lock', 'editorconfig', 'npmrc', 'nvmrc',
  'gitignore', 'gitattributes', 'gitmodules', 'dockerignore',
])

/**
 * 按扩展名粗分变更类型：`code | doc | config | other`。
 *
 * 无扩展名、二进制、图片等都归 `other`；配置优先于文档——`README.md`
 * 是文档，`package.json` 是配置，两者都不该混进代码统计。
 */
function changeKindOf(path) {
  const text = String(path ?? '').replace(/\\/g, '/')
  const base = text.slice(text.lastIndexOf('/') + 1).toLowerCase()
  if (base === '') return 'other'
  const dot = base.lastIndexOf('.')
  const ext = dot <= 0 ? '' : base.slice(dot + 1)
  const bare = base.startsWith('.') ? base.slice(1) : base
  if (ext !== '' && CHANGE_CODE_EXT.has(ext)) return 'code'
  if (ext !== '' && CHANGE_DOC_EXT.has(ext)) return 'doc'
  if (ext !== '' && CHANGE_CONFIG_EXT.has(ext)) return 'config'
  if (CHANGE_CODE_EXT.has(base) || CHANGE_CODE_EXT.has(bare)) return 'code'
  if (CHANGE_DOC_EXT.has(base) || CHANGE_DOC_EXT.has(bare)) return 'doc'
  if (CHANGE_CONFIG_EXT.has(base) || CHANGE_CONFIG_EXT.has(bare)) return 'config'
  return 'other'
}

/**
 * 读某会话某轮的索引行。
 *
 * 只读索引，不现场重建；索引缺失和轮次不存在必须区分：
 *   - 索引文件没有 → 404「会话索引不存在」
 *   - 文件有、轮次没有 → 404「找不到第 N 轮」
 *   - 文件损坏/读失败 → 502
 */
async function loadIndexTurnRow(sessionId, turn, options = {}) {
  const dir = typeof options.sessionsDir === 'string' ? options.sessionsDir : defaultSessionsDir()
  if (dir === '') return { ok: false, error: '无法确定索引目录', httpStatus: 502 }
  const readImpl = typeof options.readIndexFile === 'function' ? options.readIndexFile : readIndexFile
  const file = await readImpl(dir, sessionId)
  if (!file || file.ok !== true) {
    if (file?.reason === 'missing') {
      return { ok: false, error: '会话索引不存在', httpStatus: 404 }
    }
    return {
      ok: false,
      error: `索引读取失败（${String(file?.reason ?? 'unknown')}）`,
      httpStatus: 502,
    }
  }
  const row = file.turns.find(item => item.turn === turn)
  if (row === undefined) {
    return { ok: false, error: `找不到第 ${turn} 轮`, httpStatus: 404 }
  }
  return { ok: true, row }
}

/** 校验 `{sessionId, turn}`；成功返回规范化后的请求。 */
function parseTurnRequest(body) {
  if (!isPlainObject(body)) {
    return { ok: false, error: '请求参数必须是对象', httpStatus: 400 }
  }
  if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
    return { ok: false, error: 'sessionId 不能为空', httpStatus: 400 }
  }
  if (!Number.isInteger(body.turn) || body.turn < 0) {
    return { ok: false, error: 'turn 必须是非负整数', httpStatus: 400 }
  }
  return { ok: true, sessionId: body.sessionId.trim(), turn: body.turn }
}

/**
 * 单轮变更清单（POST /changes）。
 *
 * 数据只来自索引行 `changes`（F-7 落盘），不重新问宿主：
 *   - 没有 changes 字段 → 空清单（这一轮没改文件）
 *   - `lost:true` → files 为空，summary 明确"明细已不可读"
 *   - 正常 → 每个文件补 kind 粗分
 *
 * @param body - `{sessionId, turn}`。
 * @param options - `{timeoutMs, sessionsDir, readIndexFile}`。
 * @returns `{ok:true,value:{files,lost,summary}}` 或错误信封。
 */
export async function readTurnChanges(body = {}, options = {}) {
  const parsed = parseTurnRequest(body)
  if (!parsed.ok) return parsed
  const timeoutMs = timeoutOption(options?.timeoutMs, CHANGES_TIMEOUT_MS)
  let loaded
  try {
    loaded = await withEndpointTimeout(
      loadIndexTurnRow(parsed.sessionId, parsed.turn, options),
      timeoutMs,
      '读取变更',
    )
  } catch (error) {
    return endpointFailure(error, '读取变更')
  }
  if (!loaded.ok) return loaded

  const changes = loaded.row.changes
  // `changes-view` 是客户端与 Host 共用的纯视图模型：摘要文案、空态、
  // lost 判定都以它为准，端点只额外补一个 kind 粗分。
  const rawFiles = Array.isArray(changes?.files)
    ? changes.files.map(file => {
        if (!file || typeof file !== 'object') return file
        if (typeof file.path === 'string' && file.path !== '') return file
        return typeof file.display === 'string' ? { ...file, path: file.display } : file
      })
    : changes?.files
  const view = Array.isArray(changes)
    ? buildChanges({ ...loaded.row, changes })
    : buildChanges(
        changes === undefined || changes === null
          ? loaded.row
          : { ...loaded.row, changes: { ...changes, files: rawFiles } },
      )
  return {
    ok: true,
    value: {
      files: view.files.map(file => ({ ...file, kind: changeKindOf(file.path) })),
      lost: view.lost,
      summary: view.summary,
    },
  }
}

/**
 * 回滚预演（POST /rollback-plan）。
 *
 * **只读**：只读取工作区文件和索引，绝不写任何文件。每个变更文件算当前
 * sha256，再交给纯函数 `planRollback` 判定 state：
 *   - `missing`  ：磁盘上已不存在
 *   - `same`     ：该轮没有净行变更，或当前内容已回到 beforeHash
 *   - `modified` ：记录了快照哈希且当前内容已不同
 *   - `apply`    ：没有快照哈希，或快照哈希与当前一致，计划可执行
 *
 * 快照哈希来自索引行 `changes.files[].hash`（F-7 的后续增强）。当前 F-7
 * 尚未落盘哈希时，有行变更的文件仍按 `apply` 计划，但 reason 明确写出
 * "未记录快照哈希，无法校验"——真正写入前必须再确认。
 *
 * @param ctx - Host context（用于按会话反查工作区根目录）。
 * @param body - `{sessionId, turn}`。
 * @param options - `{timeoutMs, sessionsDir, readIndexFile, readFile, root}`。
 * @returns `{ok:true,value:{plan,summary}}` 或错误信封。
 */
export async function buildRollbackPlan(ctx, body = {}, options = {}) {
  const parsed = parseTurnRequest(body)
  if (!parsed.ok) return parsed
  const timeoutMs = timeoutOption(options?.timeoutMs, ROLLBACK_TIMEOUT_MS)
  let loaded
  try {
    loaded = await withEndpointTimeout(
      loadIndexTurnRow(parsed.sessionId, parsed.turn, options),
      timeoutMs,
      '读取回滚计划',
    )
  } catch (error) {
    return endpointFailure(error, '读取回滚计划')
  }
  if (!loaded.ok) return loaded

  const changes = loaded.row.changes
  if (changes === undefined || changes === null) {
    return { ok: true, value: { plan: [], summary: '该轮没有变更记录' } }
  }
  if (changes.lost === true || !Array.isArray(changes.files)) {
    return { ok: true, value: { plan: [], summary: '该轮变更明细已不可读', lost: true } }
  }

  // 快照记录里可能用 hash / afterHash / beforeHash 等别名；保留原始字段，
  // 由纯函数统一归一（planRollback 认识这些键）。
  const files = []
  for (const raw of changes.files) {
    if (!raw || typeof raw !== 'object') continue
    const path = typeof raw.path === 'string'
      ? raw.path
      : (typeof raw.display === 'string' ? raw.display : '')
    if (path === '') continue
    files.push({
      ...raw,
      path,
      added: countOf(raw.added),
      deleted: countOf(raw.deleted),
    })
  }
  if (files.length === 0) {
    return { ok: true, value: { plan: [], summary: '没有可回滚的文件' } }
  }

  const workspace = workspaceOfSession(ctx, parsed.sessionId)
  const root = typeof options?.root === 'string' && options.root !== ''
    ? options.root
    : (typeof workspace?.path === 'string' ? workspace.path : '')
  const readImpl = typeof options?.readFile === 'function' ? options.readFile : readFile

  try {
    const currentHashes = await withEndpointTimeout(
      (async () => {
        const hashes = {}
        for (const file of files) {
          const absolute = isAbsolute(file.path)
            ? file.path
            : (root === '' ? '' : resolvePath(root, file.path))
          if (absolute === '') {
            hashes[file.path] = null
            continue
          }
          let buffer
          try {
            buffer = await readImpl(absolute)
          } catch (error) {
            if (
              error?.code === 'ENOENT' ||
              error?.code === 'ENOTDIR' ||
              error?.code === 'EISDIR'
            ) {
              hashes[file.path] = null
              continue
            }
            throw error
          }
          hashes[file.path] = createHash('sha256').update(buffer).digest('hex')
        }
        return hashes
      })(),
      timeoutMs,
      '生成回滚计划',
    )
    const preview = planRollback(files, currentHashes)
    return { ok: true, value: { plan: preview.plan, summary: preview.summary } }
  } catch (error) {
    return endpointFailure(error, '生成回滚计划')
  }
}

// ── 轮次摘要（引用摘要档） ────────────────────────────────────────

/** 摘要输入预算：避免把整条超长回答塞进模型。 */
const DIGEST_PROMPT_INPUT = 6000
const DIGEST_RESPONSE_INPUT = 12000

/** 摘要生成超时：模型慢时不能让引用插入一直挂着。 */
const DIGEST_TIMEOUT_MS = 30_000

/** 后台失败诊断最多留几条（只记最近失败，不打堆栈）。 */
const DIGEST_DIAGNOSTIC_LIMIT = 20

/** 取配置对应的摘要档（缺省 standard）。 */
function digestLevelOf(config) {
  return DIGEST_LEVELS[normalizeDigestLevel(config?.digestLevel)]
}

/** 摘要缓存目录。 */
function digestsDir() {
  const dir = topicMapDir()
  return dir === null ? null : join(dir, 'digests')
}

/** `<sessionId>#<turn>.json`；sessionId 里的路径分隔符替换掉。 */
function digestCachePath(sessionId, turn) {
  const dir = digestsDir()
  return dir === null ? null : join(dir, `${safeSessionId(sessionId)}#${turn}.json`)
}

/** 读缓存；文件损坏/缺字段都当"没有缓存"。 */
function readDigestCache(sessionId, turn) {
  const path = digestCachePath(sessionId, turn)
  if (path === null) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (raw === null || typeof raw !== 'object') return null
    if (typeof raw.revision !== 'string' || typeof raw.summary !== 'string' || raw.summary === '') return null
    // 旧版缓存没有 endSeq/level：直接当 miss，让新逻辑重算一次。
    if (!Number.isInteger(raw.endSeq) || raw.endSeq < 0) return null
    if (raw.level !== 'compact' && raw.level !== 'standard' && raw.level !== 'rich') return null
    return { path, entry: raw }
  } catch {
    return null
  }
}

/** 缓存写盘串行化，避免同一文件并发覆盖。 */
let digestWriteChain = Promise.resolve()

/** 原子写摘要缓存；失败只影响下次是否重算，不影响本次返回。 */
async function writeDigestCache(path, entry) {
  if (path === null) return
  digestWriteChain = digestWriteChain.then(async () => {
    try {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(entry, null, 2), 'utf8')
      await rename(tmp, path)
    } catch {
      // 缓存写不进去只影响下次是否重算。
    }
  })
  await digestWriteChain
}

/** 按档位构造摘要提示词；明确"结论永不丢"和丢弃顺序。 */
function buildDigestSystemPrompt(levelName, level) {
  const requirement = levelName === 'compact'
    ? '保留结论 + 关键决定；'
    : levelName === 'rich'
      ? `保留结论 + 关键决定 + 命令（最多 ${level.commands} 条）+ 涉及文件 + 关键数据/报错；`
      : `保留结论 + 关键决定 + 命令（最多 ${level.commands} 条）+ 涉及文件；`
  return [
    `你是对话摘要助手。把给定的一轮对话压缩成不超过 ${level.maxChars} 字的要点。`,
    '要求：',
    '- 结论永不丢；',
    `- ${requirement}`,
    '- 超预算时按 文件 → 命令(detail) → 决定细节 的顺序先丢；',
    '- 不要复述过程、不要按时间顺序记账、不要写“首先/然后/最后”；',
    '- 不要编造原文没有的信息；',
    '- 只输出要点正文，不要标题、Markdown 代码块或解释。',
  ].join('\n')
}

/** 摘要输入的硬截断（避免超长对话把模型预算吃光）。 */
function clipDigestInput(text, limit) {
  const value = String(text ?? '')
  return value.length <= limit ? value : `${value.slice(0, limit)}…（后略）`
}

/** 构造一次摘要请求的 system/user。 */
function buildTurnDigestPrompt(sessionId, turn, row, levelName, level) {
  const commands = Array.isArray(row.commands) ? row.commands : []
  const files = Array.isArray(row.files) ? row.files : []
  const parts = [
    `会话：${sessionId}`,
    `轮次：第 ${turn} 轮（结束原因：${row.endReason ?? 'open'}）`,
    '提问：',
    clipDigestInput(row.prompt, DIGEST_PROMPT_INPUT) || '（空）',
    '回答：',
    clipDigestInput(row.response, DIGEST_RESPONSE_INPUT) || '（空）',
  ]
  if (commands.length > 0) parts.push('命令：', ...commands.map(command => `- ${command}`))
  if (files.length > 0) parts.push('涉及文件：', ...files.map(file => `- ${file}`))
  parts.push('', `请输出不超过 ${level.maxChars} 字的要点。`)
  return { system: buildDigestSystemPrompt(levelName, level), user: parts.join('\n') }
}

/** 模型输出归一：去代码块、折叠空白（字数由档位/命令补丁统一裁）。 */
function normalizeDigestSummary(text) {
  return String(text ?? '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 该轮命令的确定性补丁行；compact/无命令返回 ''。 */
function digestCommandLine(row, level) {
  const commands = Array.isArray(row.commands)
    ? row.commands.filter(command => typeof command === 'string' && command !== '')
    : []
  if (level.commands <= 0 || commands.length === 0) return ''
  const shown = commands.slice(0, level.commands)
  return `命令：${shown.join('；')}（共 ${commands.length} 条）`
}

/**
 * 摘要 + 命令确定性补丁。
 *
 * 模型可能漏掉命令；只要该轮有命令，程序就把前 N 条追加到摘要末尾。
 * 摘要里已经有同一行/同一批命令时去重；最终总字数封顶该档上限。
 */
function applyDigestCommandPatch(summary, row, level) {
  const line = digestCommandLine(row, level)
  if (line === '') return summary.slice(0, level.maxChars)
  const shown = line.slice('命令：'.length, line.lastIndexOf('（共')).split('；')
  const already = summary.includes(line)
    || (summary.includes('命令：') && shown.every(command => summary.includes(command)))
  if (already) return summary.slice(0, level.maxChars)
  const room = level.maxChars - line.length - 1
  if (room <= 0) return line.slice(0, level.maxChars)
  return `${summary.slice(0, room).trimEnd()}\n${line}`
}

/** 摘要缓存条目 → 统一的成功返回值。 */
function digestSuccess(summary, cached, revision, level) {
  return {
    ok: true,
    value: {
      summary,
      chars: summary.length,
      cached,
      revision,
      level,
    },
  }
}

/** 已终结轮次的不可变键：`turn/end` 的 seq；仍在进行中返回 null。 */
function turnEndSeqOf(row) {
  return Number.isInteger(row?.endSeq) && row.endSeq >= 0 ? row.endSeq : null
}

/**
 * 从已经读到的轮次行生成摘要（调用方已确认缓存未命中）。
 *
 * 模型不可用/超时/空输出都返回人话错误，不抛异常。
 */
async function generateDigestFromRow(ctx, sessionId, row, revision, levelName, level) {
  const config = readConfig()
  const llm = ctx.get('llm')
  const custom = hasCustomEndpoint(config)
  const route = await resolveRoute(ctx, sessionId, config)
  if (!custom && (llm === undefined || llm === null)) {
    return { ok: false, error: '模型不可用，无法生成摘要', httpStatus: 503 }
  }
  const prompt = buildTurnDigestPrompt(sessionId, row.turn, row, levelName, level)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DIGEST_TIMEOUT_MS)
  let text = null
  let model = route?.model ?? ''
  try {
    if (custom) {
      try {
        text = await callRemote({ fetch }, config, prompt.system, prompt.user, {
          maxTokens: 2048,
          signal: controller.signal,
          sessionId,
        })
        model = config.modelName
      } catch {
        // 自定义端点失败：回退会话模型，与归类/精化同一策略。
      }
    }
    if (text === null) {
      if (llm === undefined || llm === null || route === null) throw new Error('no model available')
      text = await askOnce(llm, route, prompt.system, prompt.user, controller.signal, {
        maxTokens: 2048,
        sessionId,
      })
    }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: '生成摘要超时', httpStatus: 504 }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `生成摘要失败：${message.slice(0, 300)}`, httpStatus: 502 }
  } finally {
    clearTimeout(timer)
  }

  const rawSummary = normalizeDigestSummary(text)
  if (rawSummary === '') return { ok: false, error: '模型没有输出摘要', httpStatus: 502 }
  const summary = applyDigestCommandPatch(rawSummary, row, level)
  if (summary === '') return { ok: false, error: '模型没有输出摘要', httpStatus: 502 }

  // 未终结的轮次内容还会变：本次摘要可用，但不落缓存（下次重算）。
  const endSeq = turnEndSeqOf(row)
  if (endSeq === null) return digestSuccess(summary, false, revision ?? 'missing', levelName)

  const entry = {
    revision: String(revision ?? 'missing'),
    endSeq,
    level: levelName,
    summary,
    model,
    at: Date.now(),
  }
  await writeDigestCache(digestCachePath(sessionId, row.turn), entry)
  return digestSuccess(summary, false, entry.revision, levelName)
}

/** 同一 `sessionId#turn` 的在途生成：同步端点、工具、后台任务共用。 */
const digestInFlight = new Map()

/** 共用同一个在途 Promise，避免同轮并发重复调模型。 */
function withDigestInFlight(key, factory) {
  const existing = digestInFlight.get(key)
  if (existing !== undefined) return existing
  const promise = factory().finally(() => {
    if (digestInFlight.get(key) === promise) digestInFlight.delete(key)
  })
  digestInFlight.set(key, promise)
  return promise
}

/** 缓存命中判断 + 未命中时读行生成；`/turn-digest` 的主路径。 */
async function generateTurnDigestInternal(ctx, sessionId, turn, force) {
  const config = readConfig()
  const levelName = normalizeDigestLevel(config.digestLevel)
  const level = DIGEST_LEVELS[levelName]
  let revision = null
  try {
    revision = await readRevision(ctx, sessionId)
  } catch {
    revision = null
  }

  let rows
  try {
    rows = await withDetailTimeout(loadTurnDetailRows(ctx, sessionId), 3000)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === '读取该会话超时') return { ok: false, error: '读取该会话超时', httpStatus: 504 }
    return { ok: false, error: '读不到该会话，无法生成摘要', httpStatus: 502 }
  }
  const row = rows.find(item => item.turn === turn)
  if (row === undefined) {
    return { ok: false, error: `会话 ${sessionId} 里没有第 ${turn} 轮`, httpStatus: 404 }
  }

  // 命中条件：endSeq 相同 + level 相同；revision 只作诊断。
  const endSeq = turnEndSeqOf(row)
  if (!force && endSeq !== null) {
    const cached = readDigestCache(sessionId, turn)
    if (cached !== null && cached.entry.endSeq === endSeq && cached.entry.level === levelName) {
      const summary = String(cached.entry.summary).slice(0, level.maxChars)
      return digestSuccess(summary, true, revision ?? cached.entry.revision, levelName)
    }
  }
  return generateDigestFromRow(ctx, sessionId, row, revision ?? 'missing', levelName, level)
}

/**
 * 生成/读取某轮摘要（HTTP `/turn-digest` 的实现）。
 *
 * `force:true` 绕过缓存与在途共享，强制重新调用模型；其余情况同轮并发
 * 请求会共享同一个生成 Promise。
 *
 * @param ctx - Host context。
 * @param body - `{sessionId, turn, force?}`。
 * @returns `{ok:true,value:{summary,chars,cached,revision,level}}` 或 `{ok:false,error,httpStatus}`。
 */
export async function generateTurnDigest(ctx, body = {}) {
  const request = isPlainObject(body) ? body : {}
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
  const turn = request.turn
  if (sessionId === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }
  if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) {
    return { ok: false, error: 'turn 非法', httpStatus: 400 }
  }
  const force = request.force === true
  const key = `${sessionId}#${turn}`
  if (force) return generateTurnDigestInternal(ctx, sessionId, turn, true)
  return withDigestInFlight(key, () => generateTurnDigestInternal(ctx, sessionId, turn, false))
}

/**
 * 自动展开/工具路径：已有行时直接生成，避免再读一次索引。
 *
 * @param ctx - Host context。
 * @param sessionId - 目标会话。
 * @param turn - 轮号。
 * @param row - 已读到的轮次行。
 * @returns 同 `generateTurnDigest`。
 */
async function ensureTurnDigest(ctx, sessionId, turn, row) {
  const key = `${sessionId}#${turn}`
  return withDigestInFlight(key, async () => {
    const config = readConfig()
    const levelName = normalizeDigestLevel(config.digestLevel)
    const level = DIGEST_LEVELS[levelName]
    let revision = null
    try {
      revision = await readRevision(ctx, sessionId)
    } catch {
      revision = null
    }
    const endSeq = turnEndSeqOf(row)
    if (endSeq !== null) {
      const cached = readDigestCache(sessionId, turn)
      if (cached !== null && cached.entry.endSeq === endSeq && cached.entry.level === levelName) {
        const summary = String(cached.entry.summary).slice(0, level.maxChars)
        return digestSuccess(summary, true, revision ?? cached.entry.revision, levelName)
      }
    }
    return generateDigestFromRow(ctx, sessionId, row, revision ?? 'missing', levelName, level)
  })
}

/** 后台预生成队列：并发上限 1，同轮在途去重。 */
const digestQueue = []
const digestPending = new Set()
const digestDiagnostics = []
let digestRunning = 0

/** 记录一条后台摘要失败诊断（不写堆栈、不打扰用户）。 */
function recordDigestDiagnostic(sessionId, turn, error) {
  digestDiagnostics.push({
    sessionId: String(sessionId),
    turn,
    error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    at: Date.now(),
  })
  if (digestDiagnostics.length > DIGEST_DIAGNOSTIC_LIMIT) digestDiagnostics.shift()
}

/** 后台任务泵：一次只跑一个，模型不可用时任务会快速失败。 */
function pumpDigestQueue() {
  if (digestRunning > 0) return
  const task = digestQueue.shift()
  if (task === undefined) return
  digestRunning = 1
  ;(async () => {
    try {
      const result = await getOrGenerateTurnDigest(task.ctx, task.sessionId, task.turn)
      if (!result.ok) recordDigestDiagnostic(task.sessionId, task.turn, result.error)
    } catch (error) {
      recordDigestDiagnostic(task.sessionId, task.turn, error)
    } finally {
      digestPending.delete(task.key)
      digestRunning = 0
      pumpDigestQueue()
    }
  })()
}

/** 走统一在途表的内部入口（后台用，不强制）。 */
function getOrGenerateTurnDigest(ctx, sessionId, turn) {
  const key = `${sessionId}#${turn}`
  return withDigestInFlight(key, () => generateTurnDigestInternal(ctx, sessionId, turn, false))
}

/**
 * `/turn-detail` 成功后 fire-and-forget 排一次摘要预生成。
 *
 * 只做三件事：同轮去重、入队、立即返回；不 await 模型，不影响详情响应。
 * 缓存新鲜时后台任务会直接跳过（仍会做一次 stat + 缓存读）。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话。
 * @param turn - 轮号。
 * @returns 是否真的排进队列。
 */
export function queueTurnDigest(ctx, sessionId, turn) {
  const key = `${sessionId}#${turn}`
  if (digestPending.has(key) || digestInFlight.has(key)) return false
  digestPending.add(key)
  digestQueue.push({ ctx, sessionId, turn, key })
  pumpDigestQueue()
  return true
}

/** 等待后台预生成队列清空（测试/退出用）。 */
export function flushTurnDigests() {
  if (digestRunning === 0 && digestQueue.length === 0) return Promise.resolve()
  return new Promise(resolve => {
    const check = () => {
      if (digestRunning === 0 && digestQueue.length === 0) resolve()
      else setTimeout(check, 5)
    }
    check()
  })
}

/** 读最近的后台摘要失败诊断（测试/排障用）。 */
export function getDigestDiagnostics() {
  return digestDiagnostics.slice()
}

// ── 召回工具 history_turn + 引用自动展开 ──────────────────────────

/** 召回工具名（引用指针的显式解析端）。 */
export const HISTORY_TURN_TOOL = 'history_turn'

/** 句柄前缀歧义时最多列出几个候选。 */
const HISTORY_TURN_MATCH_LIMIT = 3

/** 自动展开注入的 context 名。 */
const QUOTE_CONTEXT_NAME = 'topic-map:引用摘要'

/** 自动展开识别的句柄形态：〔8 位十六进制#轮号〕；不认 `·全文` 后缀。 */
const QUOTE_HANDLE_RE = /〔([0-9a-fA-F]{8})#(\d+)〕/g

/**
 * `agent/inbox/claimed` 早于 assembly 触发，但消息尚未提交进 session 历史。
 * 这里暂存"正在发送"的人类消息文本，供本次 assembly 扫描句柄。
 * agentId → 文本数组（最多 4 条）。
 */
const pendingClaimedTexts = new Map()
const PENDING_CLAIMED_LIMIT = 4

/** 记下一条 claimed 的用户消息（仅当前 step 用，扫描后删除）。 */
function rememberClaimedUserText(agent, message) {
  const agentId = String(agent?.id ?? agent?.session?.id ?? '')
  if (agentId === '' || message?.role !== 'user' || message?.source?.kind !== 'user') return
  const text = messageText(message.content)
  if (text.trim() === '') return
  const entry = pendingClaimedTexts.get(agentId) ?? []
  entry.push(text)
  while (entry.length > PENDING_CLAIMED_LIMIT) entry.shift()
  pendingClaimedTexts.set(agentId, entry)
}

/** 取出并清掉某 agent 的 pending 文本（最新在后，调用方按新→旧使用）。 */
function takeClaimedUserTexts(agentId) {
  const key = String(agentId ?? '')
  const entry = pendingClaimedTexts.get(key)
  if (entry === undefined) return []
  pendingClaimedTexts.delete(key)
  return entry
}

/**
 * 引用注入 ledger：`<topic-map>/quote-ledger/<safeSessionId>.json`。
 *
 * 严格幂等：同一会话里同一句柄只注入一次；文件持久化，进程重启后仍然
 * 生效。内存只是读缓存，按文件路径区分（测试切换 DSH_HOME 不会串）。
 * 单文件最多保留最近 200 条（按 at 裁）。
 */
const QUOTE_LEDGER_MAX = 200
const quoteLedgerCache = new Map()
const quoteLedgerLoading = new Map()
const quoteLedgerWriteChains = new Map()

/** 句柄的去重键。 */
function quoteHandleKey(handle) {
  return `${handle.prefix}#${handle.turn}`
}

/** ledger 文件路径；无法确定 home 时返回 null。 */
function quoteLedgerPath(sessionId) {
  const dir = topicMapDir()
  if (dir === null) return null
  return join(dir, 'quote-ledger', `${safeSessionId(sessionId)}.json`)
}

/** 单文件超过上限时按 at 保留最近 200 条。 */
function trimQuoteLedger(entries) {
  const keys = Object.keys(entries)
  if (keys.length <= QUOTE_LEDGER_MAX) return entries
  keys.sort((a, b) => (Number(entries[b]?.at) || 0) - (Number(entries[a]?.at) || 0))
  for (const key of keys.slice(QUOTE_LEDGER_MAX)) delete entries[key]
  return entries
}

/** 读 ledger（带缓存与同路径并发去重）；损坏文件当空。 */
async function loadQuoteLedger(sessionId) {
  const path = quoteLedgerPath(sessionId)
  if (path === null) return {}
  const cached = quoteLedgerCache.get(path)
  if (cached !== undefined) return cached
  const loading = quoteLedgerLoading.get(path)
  if (loading !== undefined) return loading

  const promise = (async () => {
    const entries = {}
    try {
      const raw = JSON.parse(await readFile(path, 'utf8'))
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw)) {
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            entries[key] = value
          }
        }
      }
    } catch {
      // 文件不存在/损坏：都当没有注入过。
    }
    trimQuoteLedger(entries)
    quoteLedgerCache.set(path, entries)
    return entries
  })()
  quoteLedgerLoading.set(path, promise)
  try {
    return await promise
  } finally {
    quoteLedgerLoading.delete(path)
  }
}

/** 串行写 ledger，tmp + rename。 */
function writeQuoteLedger(path, entries) {
  if (path === null) return Promise.resolve()
  const previous = quoteLedgerWriteChains.get(path) ?? Promise.resolve()
  const next = previous.then(async () => {
    try {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, JSON.stringify(entries, null, 2), 'utf8')
      await rename(tmp, path)
    } catch {
      // 写不进去只影响重启后的幂等，本次内存仍生效。
    }
  })
  quoteLedgerWriteChains.set(path, next)
  return next
}

/** 成功注入后记账；调用方只在 `source !== null` 时调用。 */
async function recordQuoteInjection(sessionId, key, meta) {
  if (sessionId === '') return
  const entries = await loadQuoteLedger(sessionId)
  entries[key] = {
    at: Date.now(),
    chars: Number.isFinite(meta?.chars) ? meta.chars : 0,
    source: String(meta?.source ?? ''),
  }
  trimQuoteLedger(entries)
  await writeQuoteLedger(quoteLedgerPath(sessionId), entries)
}

/** 该会话是否已经注入过这个句柄。 */
async function quoteLedgerHas(sessionId, key) {
  if (sessionId === '') return false
  const entries = await loadQuoteLedger(sessionId)
  return Object.prototype.hasOwnProperty.call(entries, key)
}

/** 路径比较（Windows 口径：大小写不敏感、斜杠归一、忽略尾分隔符）。 */
function sameWorkspacePath(left, right) {
  const normalize = value => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const a = normalize(left)
  return a !== '' && a === normalize(right)
}

/**
 * 当前 Agent 所属的工作区（严格版，不猜第一个）。
 *
 * 引用解析永远以"当前这一个工作区"为范围；解析不到工作区元数据时由调用方
 * 退化为会话目录，而不是拿第一个工作区冒充。
 *
 * @param ctx - Host context。
 * @param agent - 正在执行的 Agent（`exec.agent` 或 `assembleContext.agent`）。
 * @returns Workspace，或 undefined。
 */
function workspaceForAgent(ctx, agent) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) return undefined
  let all = []
  try {
    all = registry.list()
  } catch {
    return undefined
  }
  if (!Array.isArray(all) || all.length === 0) return undefined
  const cwd = agent?.session?.header?.cwd
  if (typeof cwd === 'string' && cwd !== '') {
    const matched = all.find(workspace => sameWorkspacePath(workspace?.path, cwd))
    if (matched !== undefined) return matched
  }
  const callerId = agent?.id === undefined || agent?.id === null ? '' : String(agent.id)
  if (callerId !== '') {
    const owner = all.find(workspace => Array.from(workspace?.sessionIds ?? []).some(id => String(id) === callerId))
    if (owner !== undefined) return owner
  }
  return undefined
}

/** 去掉可选的 `session-` 前缀并统一小写。 */
function normalizeSessionPrefix(prefix) {
  return String(prefix ?? '').trim().replace(/^session-/i, '').toLowerCase()
}

/**
 * 解析轮次句柄：`4c42ff36#33` 或完整 id `session-4c42ff36-…#33`。
 *
 * @param value - 模型/客户端传来的句柄。
 * @returns `{prefix, turn}`，格式非法返回 null。
 */
function parseHistoryHandle(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  const at = text.lastIndexOf('#')
  if (at <= 0 || at === text.length - 1) return null
  const prefix = normalizeSessionPrefix(text.slice(0, at))
  const turnText = text.slice(at + 1).trim()
  // 只认 8 位十六进制前缀，或它后面接完整 uuid 段（session id 是 uuid）。
  if (!/^[0-9a-f]{8}(?:-[0-9a-f-]+)?$/i.test(prefix)) return null
  const turn = Number(turnText)
  if (!Number.isInteger(turn) || turn < 0) return null
  return { prefix, turn }
}

/**
 * 按前缀/完整 id 匹配工作区内的会话。
 *
 * 完整 id 精确命中优先；否则按 `session-<前缀>` 匹配。命中多个时报歧义，
 * 不猜（猜错会把 A 会话的全文贴到 B 的引用上）。
 *
 * @param workspace - 工作区。
 * @param prefix - 已归一的前缀（可含完整 id 的剩余部分）。
 * @returns `{sessionId}` | `{ambiguous:true, matches}` | `{matches:[]}`
 */
function matchSessionByPrefix(workspace, prefix) {
  const wanted = normalizeSessionPrefix(prefix)
  const ids = Array.from(workspace?.sessionIds ?? []).map(String)
  if (wanted === '') return { matches: [] }
  const exact = ids.filter(id => {
    const lower = id.toLowerCase()
    return lower === wanted || lower === `session-${wanted}`
  })
  if (exact.length === 1) return { sessionId: exact[0] }
  const matches = ids.filter(id => id.toLowerCase().startsWith(`session-${wanted}`))
  if (matches.length === 1) return { sessionId: matches[0] }
  if (matches.length > 1) {
    return { ambiguous: true, matches: matches.slice(0, HISTORY_TURN_MATCH_LIMIT) }
  }
  return { matches: [] }
}

/** 单个会话 id 是否匹配句柄前缀（大小写不敏感）。 */
function sessionIdMatchesPrefix(sessionId, prefix) {
  return matchSessionByPrefix({ sessionIds: [String(sessionId)] }, prefix).sessionId !== undefined
}

/**
 * 会话目录 / 索引目录里能列出的会话 id。
 *
 * 只在"当前会话所属工作区"完全解析不到时作为第二级范围兜底；不拿第一个
 * 工作区冒充，也不扩大成跨工区扫描。
 *
 * 来源优先级：索引目录 `*.jsonl` 文件名 → `sessionQuery.listSessions()`。
 *
 * @param ctx - Host context。
 * @returns 去重后的会话 id 数组。
 */
async function listStoredSessionIds(ctx) {
  const ids = new Set()
  const dir = defaultSessionsDir()
  if (dir !== '') {
    try {
      for (const name of await readdir(dir)) {
        if (typeof name === 'string' && name.endsWith('.jsonl')) {
          ids.add(name.slice(0, -'.jsonl'.length))
        }
      }
    } catch {
      // 索引目录不存在：继续试会话存储。
    }
  }
  try {
    if (typeof ctx.sessionQuery?.listSessions === 'function') {
      for (const record of await ctx.sessionQuery.listSessions()) {
        const id = String(record?.header?.id ?? '')
        if (id !== '') ids.add(id)
      }
    }
  } catch {
    // 会话存储列不出来：索引目录里有多少算多少。
  }
  return [...ids]
}

/**
 * 两级解析引用句柄的会话。
 *
 * 1) 当前 Agent 的会话 id 前缀命中 → 当前会话（即使它不在 workspace registry）；
 * 2) 当前工作区内的会话；
 *    当前会话所属工作区解析不到时，用会话目录/索引目录能列出的会话代替
 *    第二级范围（仍然只按前缀唯一匹配）。
 *
 * 唯一命中才返回；多命中报歧义并给候选；零命中返回空。
 *
 * @param ctx - Host context。
 * @param options - `{agent?, currentSessionId?}`。
 * @param prefix - 已归一的前缀。
 * @returns `{sessionId, tier}` | `{ambiguous:true, matches}` | `{matches:[]}`
 */
async function resolveQuoteSession(ctx, options, prefix) {
  const currentSessionId = String(
    options?.currentSessionId ?? options?.agent?.id ?? options?.agent?.session?.id ?? '',
  )
  if (currentSessionId !== '' && sessionIdMatchesPrefix(currentSessionId, prefix)) {
    return { sessionId: currentSessionId, tier: 'current' }
  }

  const workspace = options?.agent !== undefined
    ? workspaceForAgent(ctx, options.agent)
    : workspaceOfSession(ctx, currentSessionId)

  if (workspace !== undefined) {
    const matched = matchSessionByPrefix(workspace, prefix)
    if (matched.sessionId !== undefined) return { sessionId: matched.sessionId, tier: 'workspace' }
    if (matched.ambiguous === true) return { ambiguous: true, matches: matched.matches }
    return { matches: [] }
  }

  // 工作区元数据缺失：用会话目录/索引目录代替第二级范围。
  const matches = (await listStoredSessionIds(ctx)).filter(id => sessionIdMatchesPrefix(id, prefix))
  if (matches.length === 1) return { sessionId: matches[0], tier: 'store' }
  if (matches.length > 1) {
    return { ambiguous: true, matches: matches.slice(0, HISTORY_TURN_MATCH_LIMIT) }
  }
  return { matches: [] }
}

/** 工具失败结果：不抛异常，给模型一段能读懂的文字。 */
function historyTurnFailure(error) {
  return { ok: false, error }
}

/** 轮次行 → 工具返回值（摘要档：按 digestLevel 封顶，truncated 提示还有原文）。 */
function historyTurnValue(sessionId, row, rows, index, digest) {
  const neighbors = []
  if (index > 0) {
    neighbors.push({ turn: rows[index - 1].turn, promptHead: promptHeadOf(rows[index - 1].prompt) })
  }
  if (index + 1 < rows.length) {
    neighbors.push({ turn: rows[index + 1].turn, promptHead: promptHeadOf(rows[index + 1].prompt) })
  }
  return {
    ok: true,
    sessionId,
    turn: row.turn,
    mode: 'digest',
    summary: digest.summary,
    chars: digest.chars,
    model: row.model ?? null,
    endReason: row.endReason ?? 'open',
    commands: Array.isArray(row.commands) ? row.commands : [],
    files: Array.isArray(row.files) ? row.files : [],
    changes: row.changes ?? null,
    neighbors,
    truncated: true,
  }
}

/** 工具体结果 → 模型可读文本（content block）。 */
function renderHistoryTurn(value) {
  if (!value || value.ok !== true) {
    return [{ type: 'text', text: `取回失败：${value?.error ?? '未知原因'}` }]
  }
  const lines = [
    `第 ${value.turn} 轮 · ${value.sessionId}（摘要）`,
    `模型：${value.model ?? '未知'} · 结束：${value.endReason}`,
  ]
  if (value.truncated) lines.push('（摘要已压缩，原文未返回）')
  if (value.neighbors.length > 0) {
    lines.push(`上下文：${value.neighbors.map(item => `第 ${item.turn} 轮「${item.promptHead}」`).join('；')}`)
  }
  lines.push('', '【摘要】', value.summary || '（空）')
  if (value.commands.length > 0) {
    lines.push('', `【命令】${value.commands.length} 条`, ...value.commands.map(command => `$ ${command}`))
  }
  if (value.files.length > 0) lines.push('', `【文件】${value.files.join('、')}`)
  if (value.changes) {
    const lost = value.changes.lost === true ? '（明细已不可读）' : ''
    const files = Array.isArray(value.changes.files)
      ? value.changes.files.map(file => `${file.path} +${file.added}/-${file.deleted}`).join('、')
      : ''
    lines.push('', `【变更】${files || '无'}${lost}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * 构造 `history_turn` 工具定义。
 *
 * 描述里必须给出 `〔xxxxxxxx#N〕` 这个线索：模型只有看到它，才知道引用
 * 指针可以解析，否则工具永远不会被调用。
 *
 * @param ctx - Host context（用于读会话/工作区）。
 * @returns ToolDefinition。
 */
export function createHistoryTurnTool(ctx) {
  return {
    name: HISTORY_TURN_TOOL,
    description:
      '当对话里出现 `〔xxxxxxxx#N〕` 形式的轮次句柄时调用本工具取回该轮摘要。'
      + 'handle 形如 `4c42ff36#33`（会话 id 前缀 + # + 轮号）；也可以直接给 sessionId 与 turn。'
      + '返回不超过 400 字的摘要、模型、结束原因、命令、文件、变更摘要，以及前后各一轮的摘要；'
      + 'truncated:true 表示摘要是压缩稿、原文未返回。',
    parameters: {
      type: 'object',
      properties: {
        handle: {
          type: 'string',
          description: '轮次句柄，形如 4c42ff36#33（8 位会话 id 前缀 + # + 轮号）。与 sessionId+turn 二选一。',
        },
        sessionId: {
          type: 'string',
          description: '完整会话 id（形如 session-4c42ff36-…）。与 turn 一起用；与 handle 二选一。',
        },
        turn: {
          type: 'integer',
          minimum: 0,
          description: '轮号（从 0 开始）。与 sessionId 一起用。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          turn: { type: 'integer' },
          mode: { type: 'string' },
          summary: { type: 'string' },
          truncated: { type: 'boolean' },
        },
        required: ['ok'],
      },
      render: (_args, value) => renderHistoryTurn(value),
    },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const handle = typeof input.handle === 'string' ? input.handle.trim() : ''
      let sessionId = ''
      let turn = null

      if (handle !== '') {
        const parsed = parseHistoryHandle(handle)
        if (parsed === null) {
          return historyTurnFailure('句柄格式应为 `8位会话前缀#轮号`，例如 `4c42ff36#33`。')
        }
        turn = parsed.turn
        const agentId = String(exec?.agent?.id ?? exec?.agent?.session?.id ?? '')
        const resolved = await resolveQuoteSession(ctx, { agent: exec?.agent, currentSessionId: agentId }, parsed.prefix)
        if (resolved.sessionId === undefined) {
          if (resolved.ambiguous === true) {
            return historyTurnFailure(
              `前缀 ${parsed.prefix} 匹配到多个会话：${resolved.matches.join('、')}。请改用完整的 sessionId。`,
            )
          }
          return historyTurnFailure(
            `没有匹配该前缀的会话（${parsed.prefix}）。可以直接传完整的 sessionId + turn。`,
          )
        }
        sessionId = resolved.sessionId
      } else {
        sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : ''
        const value = input.turn
        if (sessionId === '' || typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
          return historyTurnFailure('请提供 handle（如 `4c42ff36#33`），或同时提供 sessionId 与 turn（轮号为非负整数）。')
        }
        turn = value
      }

      let rows
      try {
        rows = await withDetailTimeout(loadTurnDetailRows(ctx, sessionId), 2000)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === '读取该会话超时') {
          return historyTurnFailure(`读取会话 ${sessionId} 超时（超过 2 秒），请稍后再试。`)
        }
        return historyTurnFailure(`读不到会话 ${sessionId}，该轮内容暂不可用。`)
      }

      const index = rows.findIndex(row => row.turn === turn)
      if (index === -1) {
        return historyTurnFailure(`会话 ${sessionId} 里没有第 ${turn} 轮（该会话共 ${rows.length} 轮）。`)
      }
      const digest = await ensureTurnDigest(ctx, sessionId, turn, rows[index])
      if (!digest.ok) return historyTurnFailure(digest.error)
      return historyTurnValue(sessionId, rows[index], rows, index, digest.value)
    },
  }
}

/**
 * 以可选作用域注册 `history_turn`。
 *
 * 宿主没有 `tools` 服务时 inject 回调不执行，插件其余部分照常工作。
 *
 * @param ctx - Host root context。
 */
export function registerHistoryTurnTool(ctx) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['tools'], scope => {
    const tools = scope?.tools
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return
    const definition = createHistoryTurnTool(scope)
    if (typeof scope.effect === 'function') {
      scope.effect(() => tools.register(definition), 'topic-map: history_turn tool')
    } else {
      tools.register(definition)
    }
  })
}

/**
 * 最近 1 条人类消息文本；没有返回 ''。
 *
 * 只认 `role:'user'` 且 `source.kind:'user'` 的消息：技能注入、agent/team
 * 消息不是人写的引用，不该触发自动展开。
 */
function latestHumanMessageText(session) {
  let messages = []
  try {
    messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
  } catch {
    return ''
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message || message.role !== 'user') continue
    if (message.source?.kind !== 'user') continue
    const text = messageText(message.content)
    if (text.trim() !== '') return text
  }
  return ''
}

/** 收集句柄：按出现顺序去重；数量由单条消息配额限制。 */
function collectQuoteHandles(texts) {
  const seen = new Set()
  const handles = []
  for (const text of texts) {
    QUOTE_HANDLE_RE.lastIndex = 0
    let match
    while ((match = QUOTE_HANDLE_RE.exec(text)) !== null) {
      const key = `${match[1].toLowerCase()}#${Number(match[2])}`
      if (seen.has(key)) continue
      seen.add(key)
      handles.push({ prefix: match[1].toLowerCase(), turn: Number(match[2]) })
    }
  }
  return handles
}

/** 自动展开行缓存：sessionId → `{revision, rows}`（有界 LRU）。 */
const quoteRowsCache = new Map()
const QUOTE_CACHE_LIMIT = 32

function rememberQuoteRows(sessionId, entry) {
  quoteRowsCache.delete(sessionId)
  quoteRowsCache.set(sessionId, entry)
  while (quoteRowsCache.size > QUOTE_CACHE_LIMIT) {
    const oldest = quoteRowsCache.keys().next()
    if (oldest.done === true) break
    quoteRowsCache.delete(oldest.value)
  }
}

/**
 * 取自动展开所需的轮次行：当前会话用内存日志，历史会话索引优先、日志兜底。
 *
 * 只读不写；与 /search、/turn-detail 用同一套判定，避免三套口径。
 */
async function rowsForQuoteSession(ctx, agent, sessionId) {
  if (agent?.session !== undefined && agent?.session !== null && String(agent.id ?? '') === String(sessionId)) {
    const snapshot = typeof agent.session.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
    return buildTurnRows(Array.isArray(snapshot) ? snapshot : [])
  }

  let revision = null
  try {
    revision = await readRevision(ctx, sessionId)
  } catch {
    revision = null
  }
  const cached = quoteRowsCache.get(sessionId)
  if (cached !== undefined && revision !== null && cached.revision === revision) return cached.rows
  if (revision !== null) {
    const file = await readIndexFile(defaultSessionsDir(), sessionId)
    if (file.ok && file.meta.revision === revision) {
      rememberQuoteRows(sessionId, { revision, rows: file.turns })
      return file.turns
    }
  }
  const events = await readEventsOrThrow(ctx, sessionId)
  const rows = buildTurnRows(events)
  rememberQuoteRows(sessionId, { revision: revision ?? `log:${events.length}`, rows })
  return rows
}

/**
 * 解析一个句柄并生成/读取摘要块（自动展开与 /expand-preview 的唯一来源）。
 *
 * @returns `{matchedSessionId, reason, source, chars, text}`：
 *   - 成功：source `cache|generated`；
 *   - 摘要失败：source `fallback`、reason `摘要失败`，text 为回答前（按档位上限）；
 *   - 解析失败：source null、reason 具体原因，text 为给模型看的说明。
 */
async function resolveQuoteBlock(ctx, agent, handle, currentSessionId) {
  const header = `〔引用摘要 ${handle.prefix}#${handle.turn}〕`
  const resolved = await resolveQuoteSession(ctx, { agent, currentSessionId }, handle.prefix)
  if (resolved.sessionId === undefined) {
    const reason = resolved.ambiguous === true ? '前缀歧义' : '没有匹配该前缀'
    return {
      matchedSessionId: null,
      reason,
      source: null,
      chars: 0,
      text: `${header}\n（${reason}；可调用 history_turn 工具手动取回。）`,
    }
  }

  const sessionId = resolved.sessionId
  let rows
  try {
    rows = await rowsForQuoteSession(ctx, agent, sessionId)
  } catch {
    return {
      matchedSessionId: sessionId,
      reason: '该会话已归档或不可读',
      source: null,
      chars: 0,
      text: `${header}\n（这个会话已归档，内容读不到）`,
    }
  }
  const row = rows.find(item => item.turn === handle.turn)
  if (row === undefined) {
    return {
      matchedSessionId: sessionId,
      reason: '轮次不存在',
      source: null,
      chars: 0,
      text: `${header}\n（会话 ${sessionId} 里没有第 ${handle.turn} 轮。）`,
    }
  }

  // 只禁止"当前会话 + 当前活动轮"：历史会话里中断未结束的轮次仍可读。
  if (currentSessionId !== '' && String(sessionId) === String(currentSessionId) && turnEndSeqOf(row) === null) {
    return {
      matchedSessionId: sessionId,
      reason: '该轮仍在进行中',
      source: null,
      chars: 0,
      text: `${header}\n（这一轮还没结束，结束后再引用）`,
    }
  }

  const digest = await ensureTurnDigest(ctx, sessionId, handle.turn, row)
  if (digest.ok) {
    return {
      matchedSessionId: sessionId,
      reason: null,
      source: digest.value.cached ? 'cache' : 'generated',
      chars: digest.value.chars,
      text: [
        header,
        `会话 ${sessionId} · 第 ${row.turn} 轮（${row.endReason ?? 'open'}）`,
        '摘要：',
        digest.value.summary,
      ].join('\n'),
    }
  }

  const level = digestLevelOf(readConfig())
  const answer = typeof row.response === 'string' ? row.response : ''
  const fallback = answer.slice(0, level.maxChars)
  return {
    matchedSessionId: sessionId,
    reason: '摘要失败',
    source: 'fallback',
    chars: fallback.length,
    text: [
      header,
      '（摘要生成失败，以下是回答开头）',
      `会话 ${sessionId} · 第 ${row.turn} 轮（${row.endReason ?? 'open'}）`,
      '回答开头：',
      fallback || '（回答为空）',
    ].join('\n'),
  }
}

/**
 * 扫描当前 Agent 最近用户消息里的 `〔handle〕`，每条注入该轮摘要。
 *
 * 扫描范围 = 当前待发送 + 最近 1 条人类消息；只认无后缀句柄，同一句柄
 * 跨两条只算一次。严格幂等（ledger 已记则跳过），条数受 quoteMaxCount /
 * quoteMaxChars 双配额限制。当前会话即使不在 workspace registry 也能命中；
 * 摘要失败自动降级为回答开头。
 *
 * @param ctx - Host context。
 * @param agent - 当前 Agent（来自 `exec.agent` 或 `assembleContext.agent`）。
 * @returns 要注入的文本，或空串。
 */
export async function expandQuoteHandlesForAgent(ctx, agent) {
  const session = agent?.session
  if (session === undefined || session === null) return ''
  const agentId = String(agent?.id ?? agent?.session?.id ?? '')
  const pending = takeClaimedUserTexts(agentId)
  const previousText = latestHumanMessageText(session)
  const previousTexts = previousText !== '' && !pending.includes(previousText) ? [previousText] : []

  // 窗口：当前待发送 + 上一条；同一句柄跨两条只算一次。
  const seen = new Set()
  const candidates = []
  for (const handle of [...collectQuoteHandles(pending), ...collectQuoteHandles(previousTexts)]) {
    const key = quoteHandleKey(handle)
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push(handle)
  }
  if (candidates.length === 0) return ''

  // 严格幂等：ledger 里已有的句柄一律跳过（含当前消息里的同一句柄）。
  const ledger = agentId === '' ? {} : await loadQuoteLedger(agentId)
  const toInject = candidates.filter(handle => !Object.prototype.hasOwnProperty.call(ledger, quoteHandleKey(handle)))
  if (toInject.length === 0) return ''

  const config = readConfig()
  const maxCount = normalizeQuoteMaxCount(config.quoteMaxCount)
  const maxChars = normalizeQuoteMaxChars(config.quoteMaxChars)
  const blocks = []
  let used = 0
  let count = 0
  let skipped = 0

  for (let index = 0; index < toInject.length; index += 1) {
    const handle = toInject[index]
    let block
    try {
      block = await resolveQuoteBlock(ctx, agent, handle, agentId)
    } catch {
      continue
    }
    if (block.text === '') continue
    const addition = blocks.length === 0 ? block.text.length : 2 + block.text.length
    if (count >= maxCount || used + addition > maxChars) {
      skipped = toInject.length - index
      break
    }
    blocks.push(block.text)
    used += addition
    count += 1
    // 只有真正注入了内容才记账；失败/配额跳过都不记，下次还能重试。
    if (block.source !== null) {
      await recordQuoteInjection(agentId, quoteHandleKey(handle), {
        chars: block.chars,
        source: block.source,
      })
    }
  }

  if (skipped > 0) {
    blocks.push(`（另有 ${skipped} 条引用未展开：超出单条消息引用配额）`)
  }
  return blocks.join('\n\n')
}

/**
 * `/expand-preview`：与真实展开同源，只返回诊断信息，不注入。
 *
 * 严格幂等：ledger 里已有的句柄返回 `alreadyInjected:true`、`wouldInject:false`；
 * 全部都已注入过时 `blocks:[]`、`reason:'已注入过（幂等跳过）'`。预览本身
 * 不写 ledger，也不受 `asCurrent` 旧参数影响。
 *
 * @param ctx - Host context。
 * @param body - `{sessionId, text}`。
 * @returns `{ok:true,value:{handles,blocks,reason,alreadyInjected}}` 或错误。
 */
export async function previewExpansion(ctx, body = {}) {
  const request = isPlainObject(body) ? body : {}
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
  if (sessionId === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }
  const text = typeof request.text === 'string' ? request.text : ''
  const handles = collectQuoteHandles([text])
  if (handles.length === 0) {
    return { ok: true, value: { handles: [], blocks: [], reason: '没有句柄', alreadyInjected: false } }
  }

  const ledger = await loadQuoteLedger(sessionId)
  const config = readConfig()
  const maxCount = normalizeQuoteMaxCount(config.quoteMaxCount)
  const maxChars = normalizeQuoteMaxChars(config.quoteMaxChars)
  const handlesOut = []
  const blocks = []
  let reason = null
  let used = 0
  let count = 0
  let allAlready = true

  for (const handle of handles) {
    const key = quoteHandleKey(handle)
    if (Object.prototype.hasOwnProperty.call(ledger, key)) {
      const resolved = await resolveQuoteSession(ctx, { currentSessionId: sessionId }, handle.prefix)
      handlesOut.push({
        handle: key,
        matchedSessionId: resolved.sessionId ?? null,
        turn: handle.turn,
        alreadyInjected: true,
        wouldInject: false,
      })
      continue
    }
    allAlready = false

    const block = await resolveQuoteBlock(ctx, undefined, handle, sessionId)
    const addition = blocks.length === 0 ? block.text.length : 2 + block.text.length
    if (count >= maxCount || used + addition > maxChars) {
      handlesOut.push({
        handle: key,
        matchedSessionId: block.matchedSessionId,
        turn: handle.turn,
        alreadyInjected: false,
        wouldInject: false,
        budgetSkipped: true,
      })
      if (reason === null) reason = '超出单条消息引用配额'
      continue
    }
    used += addition
    count += 1
    handlesOut.push({
      handle: key,
      matchedSessionId: block.matchedSessionId,
      turn: handle.turn,
      alreadyInjected: false,
      wouldInject: block.source !== null,
    })
    if (block.source !== null) {
      blocks.push({
        name: QUOTE_CONTEXT_NAME,
        chars: block.chars,
        source: block.source,
      })
    }
    if (reason === null && block.reason !== null) reason = block.reason
  }

  if (allAlready) reason = '已注入过（幂等跳过）'
  return { ok: true, value: { handles: handlesOut, blocks, reason, alreadyInjected: allAlready } }
}

/**
 * 以可选作用域注册引用自动展开。
 *
 * 全局注册：`system-prompt/assemble` 是插件根 ctx 上的事件，所有会话/派生
 * agent 的 assembly 都会走到这里，不依赖 `agent/created` 之类的按 agent 注册。
 * 同时监听 `agent/inbox/claimed`，把"正在发送、尚未落库"的用户消息暂存起来，
 * 否则 assembly 阶段 `deriveMessages()` 看不到当前这条消息。
 *
 * @param ctx - Host root context。
 */
export function registerQuoteExpansion(ctx) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['systemPrompt'], scope => {
    /** 同一个 assembly 只处理一次（防止重复注入）。 */
    const handledAssemblies = new WeakSet()

    const handler = async (assembly, context, next) => {
      const result = await next()
      try {
        if (assembly !== null && typeof assembly === 'object') {
          if (handledAssemblies.has(assembly)) return result
          handledAssemblies.add(assembly)
        }
        const agent = context?.agent
        if (agent === undefined || agent === null) return result
        const text = await expandQuoteHandlesForAgent(scope, agent)
        if (text === '') return result
        const contexts = Array.isArray(result?.contexts) ? result.contexts : []
        if (contexts.some(entry => entry?.name === QUOTE_CONTEXT_NAME)) return result
        return {
          ...result,
          contexts: [
            ...contexts,
            { name: QUOTE_CONTEXT_NAME, text, interpolate: false },
          ],
        }
      } catch {
        return result
      }
    }

    const register = (event, listener, label) => {
      if (typeof scope.effect === 'function') {
        scope.effect(() => scope.on(event, listener), label)
      } else {
        scope.on(event, listener)
      }
    }
    register('system-prompt/assemble', handler, 'topic-map: 引用自动展开')
    register('agent/inbox/claimed', payload => {
      rememberClaimedUserText(payload?.agent, payload?.message)
    }, 'topic-map: 引用待发送消息')
  })
}

/** /index-build 的目标会话：sessionId 优先，否则整个工作区。 */
function indexBuildTargets(ctx, body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  if (sessionId !== '') return [sessionId]
  const workspace = resolveWorkspace(ctx, body.workspaceId)
  if (workspace === undefined) return []
  return [...(workspace.sessionIds ?? [])].map(String)
}

/** 简单工作池：保持输入顺序，最多 `limit` 个在跑。 */
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const width = Math.max(1, Math.min(limit, items.length))
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 索引维护/重建端点（P0-9 接线 b）。
 *
 * 走完整校验的 `syncSessionIndex`（同 revision 也解析，损坏即自愈），
 * 并发上限 2；单个会话失败不中断整批，逐条记 reason。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId?, sessionId?}`（二选一，sessionId 优先）。
 * @returns `{built, skipped, failed, sessions:[{sessionId,status,reason?}], elapsedMs}`。
 */
export async function buildSessionIndexes(ctx, body = {}) {
  const started = Date.now()
  const ids = indexBuildTargets(ctx, isPlainObject(body) ? body : {})
  const sessions = await mapWithLimit(ids, INDEX_BUILD_CONCURRENCY, async sessionId => {
    try {
      const result = await syncSessionIndexFor(ctx, sessionId)
      return { sessionId, status: result.skipped ? 'skipped' : 'built' }
    } catch (error) {
      return {
        sessionId,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  })
  return {
    built: sessions.filter(item => item.status === 'built').length,
    skipped: sessions.filter(item => item.status === 'skipped').length,
    failed: sessions.filter(item => item.status === 'failed').length,
    sessions,
    elapsedMs: Date.now() - started,
  }
}

/**
 * 把某个工作区的全部会话排进后台索引队列（"一键补齐"）。
 *
 * 立即返回、不等构建结果；`ignoreThrottle` 让显式操作不受 60 秒节流限制
 * （在途去重仍然生效，所以 `queued` 是本次真正排进队列的数量）。
 *
 * @param ctx - Host context。
 * @param body - `{workspaceId}`。
 * @returns `{ok:true, queued}` 或 `{ok:false, error, httpStatus}`。
 */
export function reindexWorkspace(ctx, body = {}) {
  const request = isPlainObject(body) ? body : {}
  const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
  if (workspaceId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  const registry = ctx.get('workspaceRegistry')
  let workspace
  try {
    const all = registry === undefined ? [] : registry.list()
    workspace = Array.isArray(all)
      ? all.find(item => String(item?.id ?? '') === String(workspaceId))
      : undefined
  } catch {
    workspace = undefined
  }
  if (workspace === undefined) return { ok: false, error: '没有该工作区', httpStatus: 404 }
  let queued = 0
  for (const sessionId of Array.from(workspace.sessionIds ?? [])) {
    if (queueSessionIndexSync(ctx, String(sessionId), { ignoreThrottle: true })) queued += 1
  }
  return { ok: true, queued }
}

// ── 后台索引同步队列（/session 接线 a / 检索兜底） ────────────────

/** sessionId → 上次排队时间（60 秒节流）。 */
const indexSyncAttempts = new Map()
/** 正在排队/执行中的 sessionId（并发去重）。 */
const indexSyncInFlight = new Set()
/** 待执行任务。 */
const indexSyncTasks = []
/** 正在执行的任务数。 */
let indexSyncRunning = 0
/** flushIndexSyncs 的等待者。 */
let indexSyncIdleWaiters = []

/** 节流表膨胀时清掉过期项（正常规模远小于上限）。 */
function pruneIndexSyncAttempts(now) {
  if (indexSyncAttempts.size <= 1000) return
  for (const [key, at] of indexSyncAttempts) {
    if (now - at >= INDEX_SYNC_TTL_MS) indexSyncAttempts.delete(key)
  }
}

function settleIndexSyncIfIdle() {
  if (indexSyncRunning > 0 || indexSyncTasks.length > 0) return
  const waiters = indexSyncIdleWaiters
  indexSyncIdleWaiters = []
  for (const resolve of waiters) resolve()
}

function pumpIndexSync() {
  while (indexSyncRunning < INDEX_BACKGROUND_CONCURRENCY && indexSyncTasks.length > 0) {
    const task = indexSyncTasks.shift()
    indexSyncRunning += 1
    Promise.resolve()
      .then(task)
      .catch(() => {
        // 后台落盘失败不影响任何响应。
      })
      .finally(() => {
        indexSyncRunning -= 1
        pumpIndexSync()
        settleIndexSyncIfIdle()
      })
  }
  settleIndexSyncIfIdle()
}

/**
 * 排队一次会话索引同步（fire-and-forget）。
 *
 * 调用方拿到的是"是否真的排上了队"，不会等任何 I/O：
 *   - 同一会话在途 → false；
 *   - 同会话 60 秒内已排过 → false（避免频繁打开时打转）；
 *   - 排上后后台先读首行 meta，revision 一致就快速跳过；`force:true` 跳过
 *     这个快速路径（调用方已确认索引不可用，例如"meta 完好但轮次行损坏"）。
 *
 * @param ctx - Host context。
 * @param sessionId - 会话 id。
 * @param options - `{revision, force, ignoreThrottle}`：调用方已取到 revision
 *   时传入，省一次 stat；`force:true` 表示调用方已确认索引不可用，必须走
 *   完整校验；`ignoreThrottle:true` 用于显式"一键补齐"，不受 60 秒节流限制
 *   （在途去重仍然生效）。
 * @returns 是否排入队列。
 */
export function queueSessionIndexSync(ctx, sessionId, options = {}) {
  const key = String(sessionId ?? '')
  if (key === '') return false
  if (indexSyncInFlight.has(key)) return false
  const now = Date.now()
  if (options.ignoreThrottle !== true) {
    const last = indexSyncAttempts.get(key)
    if (last !== undefined && now - last < INDEX_SYNC_TTL_MS) return false
  }
  indexSyncAttempts.set(key, now)
  pruneIndexSyncAttempts(now)
  indexSyncInFlight.add(key)

  const task = async () => {
    try {
      const revision = options.revision ?? await readRevision(ctx, key)
      if (options.force !== true) {
        const dir = defaultSessionsDir()
        if (dir !== '') {
          const meta = await readIndexMeta(dir, key)
          if (meta !== null && meta.revision === String(revision)) return
        }
      }
      await syncSessionIndexFor(ctx, key, { revision })
    } catch {
      // 后台任务失败只影响索引新鲜度；下次打开/检索会再试。
    } finally {
      indexSyncInFlight.delete(key)
    }
  }
  indexSyncTasks.push(task)
  pumpIndexSync()
  return true
}

/**
 * 等后台索引任务全部结束。
 *
 * 生产代码不调用（fire-and-forget 才有意义）；测试与进程收尾用它消除
 * 悬空任务。
 */
export async function flushIndexSyncs() {
  while (indexSyncRunning > 0 || indexSyncTasks.length > 0) {
    await new Promise(resolve => indexSyncIdleWaiters.push(resolve))
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
 * 已经"标记过在用"的缓存文件。
 *
 * 每个进程只对同一个文件 touch 一次：面板每次挂载都会读分段落盘，
 * 每次都写 mtime 既没必要也平白增加磁盘写。
 */
const touchedCache = new Set()

/**
 * 标记一个缓存文件"刚被用过"。
 *
 * 为什么需要：缓存清理如果只按 mtime（= 最后写入时间）判断，会把
 * "经常被读、但内容早已稳定不再写"的文件当冷数据删掉 —— 那恰恰是
 * 最该保留的（重建分类树、重新分析都要重跑模型，最贵）。
 *
 * 所以把 mtime 当成"最后使用时间"来维护：**读到就 touch 一下**。
 * 这样清理判据变成真正的 LRU，而不是"最后写入"。
 *
 * 失败一律忽略：touch 不成功只影响清理精度，不影响任何功能。
 *
 * @param path - 缓存文件绝对路径；空值直接跳过。
 */
function touchCacheFile(path) {
  if (path === null || path === undefined || path === '') return
  if (touchedCache.has(path)) return
  touchedCache.add(path)
  const now = new Date()
  utimes(path, now, now).catch(() => { /* 文件可能已被清掉 */ })
}

/**
 * 读分段落盘，并在真的读到内容时标记"在用"。
 *
 * 三个调用点共用：记进度、恢复已采纳的分层、组装会话负载。
 *
 * @param segments - SegmentStore。
 * @param sessionId - 会话。
 * @returns 是否可用（内存或磁盘任一有 semantic）。
 */
async function hydrateAndTouch(segments, sessionId) {
  const ok = await segments.hydrate(sessionId, readFile)
  if (ok) touchCacheFile(segments.pathFor(sessionId))
  return ok
}

/**
 * 本地缓存保留天数。超过就清掉，避免 ~/.dsh/topic-map 无限膨胀。
 *
 * 90 天足够覆盖"翻旧账"的真实需求；更早的分段/界面状态其实已经不会被读到
 * （会话本身还在，重新打开会重新算一遍，只是慢一点）。
 */
const CACHE_KEEP_DAYS = 90

/**
 * 清理过期的本地缓存文件。
 *
 * 为什么需要：`ui/` 与 `segments/` 里的文件是"每个工作区一份、每个会话一份"，
 * **只增不减**。换项目、换机器之后旧文件也永远不会再被读到，就一直躺在那里。
 *
 * 保守原则（宁可少删，绝不误删）：
 *  - 只处理我们自己目录（topic-map/ui、topic-map/segments）下的普通文件；
 *  - 只认文件名里带 .json 的（含 `.json.degraded.bak` 这类残留）；
 *  - 按 mtime 判断；
 *  - config.json 在 topic-map 根目录，不在扫描范围内；
 *  - 任何异常一律忽略：清理失败绝不影响功能。
 *
 * @param maxAgeDays - 保留天数。
 * @returns 删除的文件数（失败时返回 0）。
 */
async function pruneOldCache(maxAgeDays = CACHE_KEEP_DAYS) {
  const dir = topicMapDir()
  if (dir === null) return 0
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const targets = [join(dir, 'ui'), join(dir, 'segments')]
  let removed = 0

  for (const target of targets) {
    let names = []
    try {
      names = await readdir(target)
    } catch {
      continue      // 目录还不存在：正常
    }
    for (const name of names) {
      if (!name.includes('.json')) continue
      const full = join(target, name)
      try {
        const info = await stat(full)
        if (!info.isFile()) continue
        if (info.mtimeMs >= cutoff) continue
        await unlink(full)
        removed += 1
      } catch {
        // 单个文件删不掉（占用、权限）就跳过
      }
    }
  }
  return removed
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
