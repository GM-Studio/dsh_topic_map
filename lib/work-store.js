/**
 * Host 侧「段（Segment）+ 事（Work）+ 交接（Handoff）」持久化、冷启动盘点、
 * 增量同步与事级 Wire 展开编排模块。
 *
 * 职责边界：
 * - 按工作区落盘到 `~/.dsh/topic-map/works/<safeWorkspaceId>.json`；
 * - 工作区级串行写入队列 + tmp+rename 原子写；损坏 JSON 绝不静默覆盖，返回明确错误；
 * - 物化快照可重建，人工确认锁定字段（confirmed / lockedWorkIds / dismissedSegments / handoffLinks）绝不被后台推断覆盖；
 * - 优先读 turn-index，缺失回退读事件流（支持通过 deps 注入复用 lib/index.js 能力）；
 * - 事级 Wire 展开（`〔work:<workId>〕`）按会话持久化幂等账本，与轮次句柄 `〔8hex#N〕` 和谐共存。
 *
 * @module dsh-topic-map/work-store
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  buildTurnRows,
  defaultSessionsDir,
  readIndexFile,
} from './turn-index.js'
import { askOnce } from './llm-call.js'
import { callRemote, hasCustomEndpoint } from './remote-llm.js'
import {
  detectAwaitingHuman,
  isAutomatedSession,
  sliceSessionSegments,
} from './segment.js'
import { judgeAdmission } from './admission.js'
import {
  DEFAULT_DORMANT_DAYS,
  UNRESOLVED_STATES,
  applyDormancySettlement,
  applyInferredUpdate,
  applyUserConfirm,
  convertChatSegmentToWork,
  createWork,
  detectInflection,
  dismissWorkAsChat,
  emptyWorkStore,
  mergeWorks,
  projectResumeCards,
  splitSegmentFromWork,
  supersedeDecision,
  wakeWorkOnActivity,
} from './work-model.js'
import {
  buildColdStartSemanticPrompt,
  buildIncrementalMatchPrompt,
  matchSegmentIncremental,
  parseColdStartSemanticResult,
  parseIncrementalMatchResult,
  planColdStartWorks,
} from './work-merge.js'
import {
  buildNewSessionHandoffDraft,
  buildSameSessionDraft,
  detectSessionDrift,
  extractWorkHandles,
  extractWorkHardFacts,
  formatTurnHandle,
  formatWorkHandle,
  renderWorkContextForAgent,
} from './handoff.js'

/** 注入给 system-prompt/assemble 的事级上下文块名称。 */
export const WORK_CONTEXT_NAME = 'topic-map:事续接现场'

/** 增量同步默认防抖窗口（ms）。 */
export const DEFAULT_SYNC_DEBOUNCE_MS = 2500

/** 模型调用预算与超时。 */
// 4096 是 llm-call.js 注释里点名的病态值：带推理的模型会先把预算花在思考上，
// 正文一个字没产出就 finish=max-tokens → 解析失败 → 真机上表现为 invalid_json /
// 空标题。冷启动要点名每个簇的标题与下一步，给足推理预算才不会截断。
const COLD_START_MODEL_MAX_TOKENS = 16_384
const INCREMENTAL_MODEL_MAX_TOKENS = 512
const MODEL_TIMEOUT_MS = 45_000

/**
 * 冷启动提炼分批上限（ADR-0010）。
 *
 * 一次把全部候选簇塞进一条提示词，在会话多的工作区（实测 44 个会话）会被
 * 单次请求过大拖到超时；分批后每批都是一次独立、可单独失败的小请求，
 * 失败也只需精确到「哪一批」而不用整轮丢弃。
 */
const REFINE_BATCH_MAX_CLUSTERS = 12
const REFINE_BATCH_MAX_PROMPT_CHARS = 6_000

/** 单次冷启动提炼最多发几批，避免病态输入把请求放大成串行风暴。 */
const REFINE_MAX_BATCHES = 8

/**
 * 超时自适应拆分深度上限（ADR-0010 补充）。
 *
 * 一批 12 簇超时后对半拆成 6+6，还超时就再拆成 3+3 …
 * 3 层足以把 12 簇降到单簇，避免「一批超时 → 整批结果作废」的真机故障。
 */
const REFINE_SPLIT_MAX_DEPTH = 3

/**
 * 提炼状态原因枚举（契约第 6 节）。空串表示「还没尝试过」。
 *
 * - ok：模型结果已被采用；
 * - no_model：未配置模型（无 llm 服务 / 无自定义端点 / 无 askModel）；
 * - timeout：调用超时或中止；
 * - invalid_json：模型返回的正文无法解析成可用的提炼结果；
 * - failed：其它调用异常；
 * - running：后台提炼正在进行中（读取时派生，不落盘）。
 */
export const REFINE_REASONS = Object.freeze({
  OK: 'ok',
  NO_MODEL: 'no_model',
  TIMEOUT: 'timeout',
  INVALID_JSON: 'invalid_json',
  FAILED: 'failed',
  RUNNING: 'running',
})

/** 事级 Wire 展开幂等账本每会话最多保留条数。 */
const WORK_LEDGER_MAX = 200

const UNRESOLVED_SET = new Set(UNRESOLVED_STATES)

// ── 内部纯工具 ──────────────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compress(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function safeId(value) {
  const cleaned = String(value ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_')
  return cleaned === '' ? 'default' : cleaned
}

function uniqueStrings(list) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const s = compress(item)
    if (s === '' || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  if (process.env.USERPROFILE) return join(process.env.USERPROFILE, '.dsh')
  if (process.env.HOME) return join(process.env.HOME, '.dsh')
  return ''
}

function topicMapDir() {
  const home = dshHome()
  return home === '' ? null : join(home, 'topic-map')
}

function shortSessionPrefix(sessionId) {
  const raw = compress(sessionId)
  if (raw === '') return ''
  return raw.replace(/^session[-_:]/i, '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase()
}

function extractForkParent(header) {
  if (!isPlainObject(header)) return null
  const candidates = [
    header.forkedFrom,
    header.forkParent,
    header.parentSessionId,
    header.sourceSessionId,
    header.fork?.sourceSessionId,
    header.fork?.sessionId,
    header.source?.sessionId,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim()
  }
  return null
}

// ── 提炼状态（ADR-0010）：绝不允许静默降级 ─────────────────────────

/**
 * 提炼状态的安全默认值。读取旧 store（没有这个字段）时用它补齐，
 * 保证 readWorkspaceWorksView 永远能透出一个形状固定的对象。
 *
 * reason 为空串表示「还没尝试过提炼」，与 no_model（想提炼但没有模型）
 * 是两回事，客户端要能区分这两态。
 */
function emptyRefineStatus() {
  return { used: false, at: null, reason: '', attempts: 0, detail: '' }
}

/**
 * 从最近一次盘点摘要里读一个整数计数。
 *
 * 旧 store 没有这些字段（本次新增），缺省返回 null 而不是 0——
 * 「不知道」和「确实是 0」必须能区分，否则前端会把老数据误判成「全是空会话」。
 */
function readCount(store, key) {
  const summary = isPlainObject(store?.lastScanSummary) ? store.lastScanSummary : null
  if (summary === null) return null
  const value = summary[key]
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/** 把任意输入规整成合法的 refineStatus（缺字段补默认，非法值丢弃）。 */
function hydrateRefineStatus(raw) {
  if (!isPlainObject(raw)) return emptyRefineStatus()
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : ''
  return {
    used: raw.used === true,
    at: Number.isFinite(raw.at) ? raw.at : null,
    reason,
    attempts: Number.isInteger(raw.attempts) && raw.attempts > 0 ? raw.attempts : 0,
    // 具体错误原文（截断）：光给一个粗粒度枚举，用户和排障者都没法知道
    // 「failed」到底是什么 failed。ADR-0010 要求原因诚实且**具体**。
    detail: typeof raw.detail === 'string' ? raw.detail.trim().slice(0, 200) : '',
  }
}

/** 调用方显式给出的状态覆盖（目前只有 running=true 这一种），其余字段不动。 */
function applyRefineStatusOverride(status, override) {
  const base = hydrateRefineStatus(status)
  if (!isPlainObject(override)) return base
  const out = { ...base }
  if (typeof override.reason === 'string' && override.reason.trim() !== '') out.reason = override.reason.trim()
  if (typeof override.used === 'boolean') out.used = override.used
  if (Number.isFinite(override.at)) out.at = override.at
  if (Number.isInteger(override.attempts) && override.attempts >= 0) out.attempts = override.attempts
  if (typeof override.detail === 'string' && override.detail.trim() !== '') out.detail = override.detail.trim().slice(0, 200)
  return out
}

/**
 * 读取时派生「正在提炼中」：不落盘，只影响这一次响应。
 *
 * 为什么用派生而不是写盘：一次提炼是几百毫秒到几十秒的事，写盘会让
 * 「正在跑」变成一个可能在崩溃后永久留下的脏状态；读时派生天然自愈。
 */
function presentedRefineStatus(store, refining) {
  const status = hydrateRefineStatus(store?.refineStatus)
  if (refining !== true) return status
  return { ...status, reason: REFINE_REASONS.RUNNING }
}

/** 错误文案里识别超时：AbortController 的 abort 与各类 ETIMEDOUT 都要算超时。 */
function isTimeoutLikeError(error) {
  if (error === null || error === undefined) return false
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true
  if (error.code === 'ETIMEDOUT' || error.code === 'ABORT_ERR') return true
  const text = errorText(error).toLowerCase()
  return text.includes('timeout') || text.includes('timed out') || text.includes('aborted')
}

/**
 * 参数漏传的识别（回归防线）。
 *
 * 适配器在缺 sessionId 时直接拒绝，整次提炼作废且用户看不到任何原因。
 * 这里把这种错误单独标出来：它不该被当成普通 failed 混在日志里。
 */
function isMissingSessionIdError(error) {
  const text = errorText(error).toLowerCase()
  return text.includes('missingsessionid') || text.includes('missing session')
}

/**
 * 把一次模型调用的异常分类到 refineStatus.reason 的口径上。
 *
 * @returns {{ reason: string, timeout: boolean, missingSessionId: boolean, message: string }}
 */
/**
 * 适配器缺失的识别：这不是「调用失败」，而是「当前环境里根本没有这个模型」。
 *
 * 真机案例：某工作区的历史会话记录着 provider='commandcode'，用户后来卸载/改配，
 * 适配器已不存在。旧实现把它归到 failed，界面只能说「调用失败」，
 * 用户既不知道要改什么，也不知道重试多少次都不会好。
 */
function isNoAdapterError(error) {
  const text = errorText(error).toLowerCase()
  return text.includes('no adapter registered')
    || text.includes('没有已注册的模型适配器')
    || text.includes('no registered adapter')
    // 适配器在、但拿不到具体 model：同样是「这个模型没配好」，不是调用失败。
    // 真机案例：某工作区的历史会话只记了 provider、没记 model，
    // 于是每个候选都报 invalid exact model metadata / no configured model。
    // 归到 no_model，界面才能说清「去配置一个模型」而不是笼统的「调用失败」。
    || text.includes('invalid exact model metadata')
    || text.includes('no configured model')
}

/**
 * 账户/额度类失败的识别。
 *
 * 真机案例：兜底 provider 返回 'Insufficient Balance'。这既不是超时也不是代码缺陷，
 * 而是账户没钱——用户需要的是一个能照着办的提示（去充值或换个模型），
 * 而不是笼统的「调用失败」然后反复重试。
 */
function isQuotaError(error) {
  const text = errorText(error).toLowerCase()
  return text.includes('insufficient balance')
    || text.includes('insufficient quota')
    || text.includes('quota exceeded')
    || text.includes('exceeded your current quota')
    || text.includes('billing')
    || text.includes('余额不足')
    || text.includes('欠费')
}

function classifyModelError(error) {
  const timeout = isTimeoutLikeError(error)
  const noAdapter = !timeout && isNoAdapterError(error)
  const quota = !timeout && !noAdapter && isQuotaError(error)
  return {
    reason: timeout
      ? REFINE_REASONS.TIMEOUT
      : (noAdapter ? REFINE_REASONS.NO_MODEL : REFINE_REASONS.FAILED),
    timeout,
    noAdapter,
    quota,
    missingSessionId: isMissingSessionIdError(error),
    message: errorText(error).slice(0, 200),
  }
}

/** 提炼失败时写进 worker 日志的人话（不静默吞错，也不谎报成功）。 */
function reportRefineFailure(scope, error) {
  const info = classifyModelError(error)
  const detail = info.missingSessionId ? '模型调用被拒绝（缺 sessionId，疑似参数漏传）' : info.message
  console.error(`${scope} 语义提炼失败（${info.reason}）：${detail}`)
}

/**
 * 从轮次推导触发来源（ADR-0006 红线 3「人类主导」的判据）。
 *
 * 全部轮次都被标为自动化/子代理时返回 'automated'，否则 'user'。
 * 证据缺失（旧索引没有 trigger 字段）时返回 'user'——fail-open，
 * 因为「不知道」不能被当成「已证明不是人类」。
 */
function triggerOfTurns(turns) {
  const list = Array.isArray(turns) ? turns : []
  if (list.length === 0) return 'user'
  let automated = 0
  let known = 0
  for (const t of list) {
    const kind = compress(t?.trigger)
    if (kind === '') continue
    known += 1
    if (kind === 'automated') automated += 1
  }
  if (known === 0) return 'user'
  return automated === known ? 'automated' : 'user'
}

/** 补齐 Host 持久化扩展字段，确保读写往返不丢失 handoffLinks / latestInflection / reopenSuggestion。 */
function hydrateStoreExtras(raw, workspaceId) {
  const base = isPlainObject(raw) ? raw : emptyWorkStore(workspaceId)
  const handoffLinks = {}
  if (isPlainObject(base.handoffLinks)) {
    for (const [sid, wid] of Object.entries(base.handoffLinks)) {
      const k = compress(sid)
      const v = compress(wid)
      if (k !== '' && v !== '') handoffLinks[k] = v
    }
  }
  const latestInflection = isPlainObject(base.latestInflection) ? { ...base.latestInflection } : null
  const reopenSuggestion = isPlainObject(base.reopenSuggestion) ? { ...base.reopenSuggestion } : null
  const semanticRefinedAt = Number.isFinite(base.semanticRefinedAt) ? base.semanticRefinedAt : null
  const lastScanSummary = isPlainObject(base.lastScanSummary) ? { ...base.lastScanSummary } : null
  const refineStatus = hydrateRefineStatus(base.refineStatus)

  return {
    version: Number.isInteger(base.version) ? base.version : 1,
    workspaceId: compress(base.workspaceId) || compress(workspaceId),
    initializedAt: base.initializedAt === null || base.initializedAt === undefined
      ? null
      : (Number.isFinite(base.initializedAt) ? base.initializedAt : null),
    works: Array.isArray(base.works) ? base.works : [],
    segments: isPlainObject(base.segments) ? base.segments : {},
    dismissedSegments: isPlainObject(base.dismissedSegments) ? base.dismissedSegments : {},
    lockedWorkIds: uniqueStrings(base.lockedWorkIds),
    handoffLinks,
    latestInflection,
    reopenSuggestion,
    semanticRefinedAt,
    lastScanSummary,
    refineStatus,
    updatedAt: Number.isFinite(base.updatedAt) ? base.updatedAt : 0,
  }
}

/** 把 `work-model` 纯变换返回的 store 与 Host 扩展字段拼回一起。 */
function carryExtras(prevStore, nextModelStore) {
  return {
    ...nextModelStore,
    handoffLinks: isPlainObject(prevStore?.handoffLinks) ? { ...prevStore.handoffLinks } : {},
    latestInflection: isPlainObject(prevStore?.latestInflection) ? { ...prevStore.latestInflection } : null,
    reopenSuggestion: isPlainObject(prevStore?.reopenSuggestion) ? { ...prevStore.reopenSuggestion } : null,
    semanticRefinedAt: Number.isFinite(prevStore?.semanticRefinedAt) ? prevStore.semanticRefinedAt : null,
    lastScanSummary: isPlainObject(prevStore?.lastScanSummary) ? { ...prevStore.lastScanSummary } : null,
    refineStatus: hydrateRefineStatus(prevStore?.refineStatus),
  }
}

/** 把 sliceSessionSegments 输出适配为 work-merge / work-model 全兼容的段对象。 */
function adaptSegment(seg, turnsInSeg, workspaceId, extra = {}) {
  const lastTurn = turnsInSeg.length > 0 ? turnsInSeg[turnsInSeg.length - 1] : null
  const prefix = shortSessionPrefix(seg.sessionId)
  const evidenceHandles = []
  if (prefix !== '' && Number.isInteger(seg.startTurn)) {
    evidenceHandles.push(`〔${prefix}#${seg.startTurn}〕`)
  }
  if (prefix !== '' && Number.isInteger(seg.endTurn) && seg.endTurn !== seg.startTurn) {
    evidenceHandles.push(`〔${prefix}#${seg.endTurn}〕`)
  }
  return {
    ...seg,
    workspaceId: compress(workspaceId),
    startedAt: seg.startTime ?? null,
    endedAt: seg.endTime ?? null,
    lastActivityAt: seg.endTime ?? seg.startTime ?? 0,
    turnRange: [seg.startTurn, seg.endTurn],
    referencedHandles: Array.isArray(seg.quoteHandles) ? [...seg.quoteHandles] : [],
    hasError: Array.isArray(seg.errorTurns) && seg.errorTurns.length > 0,
    endReason: lastTurn?.endReason ?? 'completed',
    forkParentSessionId: extra.forkParent ?? seg.forkParent ?? null,
    handoffWorkId: extra.handoffWorkId ?? null,
    evidenceHandles: uniqueStrings([...(Array.isArray(seg.evidenceHandles) ? seg.evidenceHandles : []), ...evidenceHandles]),
  }
}

/**
 * 从已适配的段里取「本工作区有哪些活跃会话、各自最近活跃在什么时候」。
 *
 * 冷启动提炼是工作区级调用，但要挑一个真实会话当模型路由信封（缺 sessionId
 * 适配器直接拒绝）。按最近活跃排序，保证选出来的是「最像当前现场」的会话，
 * 同时也让选择结果确定可回归（不依赖会话枚举顺序）。
 *
 * @param {object[]} segments - adaptSegment 产出的段。
 * @returns {Array<{ sessionId: string, lastActivityAt: number }>}
 */
function collectSessionActivity(segments) {
  const byId = new Map()
  for (const seg of Array.isArray(segments) ? segments : []) {
    if (!isPlainObject(seg)) continue
    const sessionId = compress(seg.sessionId)
    if (sessionId === '') continue
    const at = Number.isFinite(seg.lastActivityAt) ? seg.lastActivityAt : 0
    const prev = byId.get(sessionId)
    if (prev === undefined || at > prev) byId.set(sessionId, at)
  }
  return [...byId.entries()]
    .map(([sessionId, lastActivityAt]) => ({ sessionId, lastActivityAt }))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
}

// ── 持久化：路径、串行锁、原子读写 ──────────────────────────────────

/**
 * 工作区「事」存储文件路径：`~/.dsh/topic-map/works/<safeWorkspaceId>.json`。
 *
 * @param {string} workspaceId - 工作区 ID。
 * @returns {string|null} 绝对路径，无法确定 DSH home 时返回 null。
 */
export function workStorePath(workspaceId) {
  const dir = topicMapDir()
  if (dir === null) return null
  return join(dir, 'works', `${safeId(workspaceId)}.json`)
}

/** 工作区级串行队列（按绝对路径隔离，防止多窗口/并发写互相覆盖）。 */
const workWriteChains = new Map()

function enqueueWorkspaceOp(workspaceId, task) {
  const key = workStorePath(workspaceId) ?? `mem:${safeId(workspaceId)}`
  const previous = workWriteChains.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  workWriteChains.set(key, run.then(() => undefined, () => undefined))
  return run
}

async function readWorkStoreRaw(workspaceId) {
  const path = workStorePath(workspaceId)
  if (path === null) {
    return { ok: false, error: '无法确定 DSH home', httpStatus: 500 }
  }
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, exists: false, path, store: hydrateStoreExtras(emptyWorkStore(workspaceId), workspaceId) }
    }
    return { ok: false, error: `读取 works 文件失败：${errorText(error)}`, httpStatus: 500 }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'works 文件损坏（JSON 解析失败）', httpStatus: 500 }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'works 文件损坏（顶层不是对象）', httpStatus: 500 }
  }
  return { ok: true, exists: true, path, store: hydrateStoreExtras(parsed, workspaceId) }
}

async function writeWorkStoreAtomic(path, store) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
    await rename(tmp, path)
  } catch (error) {
    try {
      await unlink(tmp)
    } catch {
      // tmp 可能未创建；保留原始错误
    }
    throw error
  }
}

/**
 * 读取工作区「事」存储。
 * 文件不存在返回空 store（`exists: false`）；JSON 损坏绝不覆盖，返回明确错误。
 *
 * @param {string} workspaceId
 * @returns {Promise<{ok:true, exists:boolean, path:string, store:object} | {ok:false, error:string, httpStatus:number}>}
 */
export async function readWorkStore(workspaceId) {
  return readWorkStoreRaw(workspaceId)
}

/**
 * 串行 + tmp+rename 原子写入工作区「事」存储。
 *
 * @param {string} workspaceId
 * @param {object} store
 * @returns {Promise<{ok:true, path:string, store:object} | {ok:false, error:string, httpStatus:number}>}
 */
export async function writeWorkStore(workspaceId, store) {
  return enqueueWorkspaceOp(workspaceId, async () => {
    const path = workStorePath(workspaceId)
    if (path === null) return { ok: false, error: '无法确定 DSH home', httpStatus: 500 }
    const normalized = hydrateStoreExtras(store, workspaceId)
    try {
      await writeWorkStoreAtomic(path, normalized)
      return { ok: true, path, store: normalized }
    } catch (error) {
      return { ok: false, error: `写入 works 文件失败：${errorText(error)}`, httpStatus: 500 }
    }
  })
}

/**
 * 在工作区串行锁内执行「读 → 校验损坏 → 变换 → 原子写」；若文件损坏，直接报错、绝不覆盖。
 */
async function mutateWorkStore(workspaceId, mutator) {
  return enqueueWorkspaceOp(workspaceId, async () => {
    const loaded = await readWorkStoreRaw(workspaceId)
    if (!loaded.ok) return loaded
    const result = await mutator(loaded.store, loaded.exists)
    if (!result || result.ok === false) {
      return result ?? { ok: false, error: '操作失败', httpStatus: 500 }
    }
    if (result.dirty === false) {
      return { ...result, store: loaded.store }
    }
    const nextStore = hydrateStoreExtras(result.store, workspaceId)
    try {
      await writeWorkStoreAtomic(loaded.path, nextStore)
    } catch (error) {
      return { ok: false, error: `写入 works 文件失败：${errorText(error)}`, httpStatus: 500 }
    }
    return { ...result, store: nextStore }
  })
}

// ── 会话读取与模型调用抽象（优先复用注入 deps） ────────────────────

async function defaultLoadSessionTurns(ctx, sessionId) {
  const dir = defaultSessionsDir()
  let revision = null
  try {
    if (typeof ctx?.sessionPersistence?.stat === 'function') {
      const st = await ctx.sessionPersistence.stat(sessionId)
      revision = typeof st?.revision === 'string' && st.revision !== '' ? st.revision : null
    }
  } catch {
    revision = null
  }

  let indexed = null
  if (dir !== '') {
    try {
      indexed = await readIndexFile(dir, sessionId)
    } catch {
      indexed = null
    }
  }
  if (indexed !== null && indexed.ok && (revision === null || indexed.meta?.revision === revision)) {
    return indexed.turns
  }

  if (typeof ctx?.sessionQuery?.readSession === 'function') {
    try {
      const snapshot = await ctx.sessionQuery.readSession(sessionId)
      if (snapshot !== null && snapshot !== undefined) {
        const rows = buildTurnRows(Array.isArray(snapshot.events) ? snapshot.events : [])
        // 尽量回填索引中的 changes 字段，保留硬事实
        if (indexed !== null && indexed.ok && Array.isArray(indexed.turns)) {
          const byTurn = new Map(indexed.turns.map(r => [r.turn, r]))
          return rows.map(row => {
            const old = byTurn.get(row.turn)
            return old?.changes && !row.changes ? { ...row, changes: old.changes } : row
          })
        }
        return rows
      }
    } catch {
      // 回退到旧索引
    }
  }
  if (indexed !== null && indexed.ok) return indexed.turns
  return []
}

async function loadSessionTurns(ctx, sessionId, deps = {}) {
  if (typeof deps.loadSessionTurns === 'function') {
    const rows = await deps.loadSessionTurns(ctx, sessionId)
    return Array.isArray(rows) ? rows : []
  }
  return defaultLoadSessionTurns(ctx, sessionId)
}

/** ADR-0005（Q2=B）：源头快速判定会话头是否属于子代理或定时/系统自动化会话。 */
function isAutomatedHeader(header) {
  if (!isPlainObject(header)) return false
  if (header.origin === 'subagent' || header.isSubagent === true || header.subagent === true) return true
  if (Number.isFinite(header.delegationDepth) && header.delegationDepth >= 1) return true
  if (typeof header.origin === 'string') {
    const origin = header.origin.trim().toLowerCase()
    if (
      origin === 'scheduled' ||
      origin === 'schedule' ||
      origin === 'cron' ||
      origin === 'automated' ||
      origin === 'system'
    ) {
      return true
    }
  }
  return false
}

async function listWorkspaceSessionMetas(ctx, workspaceId, deps = {}) {
  if (typeof deps.listWorkspaceSessions === 'function') {
    const items = await deps.listWorkspaceSessions(ctx, workspaceId)
    return Array.isArray(items)
      ? items.filter(item => !isAutomatedHeader(item?.header ?? item))
      : []
  }

  const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  const workspaces = typeof registry?.list === 'function' ? registry.list() : []
  const ws = workspaces.find(w => String(w?.id ?? '') === workspaceId) ?? (workspaceId ? null : workspaces[0] ?? null)
  const rawSessionIds = Array.isArray(ws?.sessionIds) ? ws.sessionIds.map(String) : []

  const headerMap = new Map()
  try {
    if (typeof ctx?.sessionQuery?.listSessions === 'function') {
      const records = await ctx.sessionQuery.listSessions()
      for (const rec of Array.isArray(records) ? records : []) {
        const id = String(rec?.header?.id ?? rec?.id ?? '')
        if (id !== '') headerMap.set(id, rec.header ?? rec)
      }
    }
  } catch {
    // 忽略列表元数据失败
  }

  // ADR-0005：先在源头剔除子代理与定时/自动化独立会话，不再为它们读标题与事件
  const sessionIds = rawSessionIds.filter(sessionId => !isAutomatedHeader(headerMap.get(sessionId)))

  const titleMap = new Map()
  try {
    if (sessionIds.length > 0 && typeof ctx?.sessionQuery?.readTitleSnapshots === 'function') {
      const snaps = await ctx.sessionQuery.readTitleSnapshots(sessionIds)
      for (const item of Array.isArray(snaps) ? snaps : []) {
        if (item?.status === 'fulfilled' && typeof item.value?.title?.title === 'string') {
          titleMap.set(item.sessionId, item.value.title.title)
        }
      }
    }
  } catch {
    // 标题缺省不影响盘点
  }

  return sessionIds.map(sessionId => {
    const header = headerMap.get(sessionId) ?? {}
    return {
      sessionId,
      title: titleMap.get(sessionId) ?? (typeof header.title === 'string' ? header.title : ''),
      header,
      origin: header.origin,
      delegationDepth: header.delegationDepth,
      subagent: header.origin === 'subagent' || header.isSubagent === true,
      forkParent: extractForkParent(header),
    }
  })
}

/**
 * 从一个工作区的活跃会话里挑一个能当模型路由信封用的 sessionId。
 *
 * 冷启动提炼是「整个工作区」级别的调用，但宿主 llm 的请求信封必须带
 * sessionId（opencode 等适配器据此写路由头，缺了直接 MissingSessionID）。
 * 所以挑一个该工作区真实存在的会话：优先最近活跃的，其次任意一个。
 *
 * @param {object[]} sessions - `{ sessionId, lastActivityAt }`。
 * @returns {string} 会话 id；没有可用会话时返回空串。
 */
function pickRefineSessionId(sessions) {
  const list = Array.isArray(sessions) ? sessions : []
  const valid = list
    .map(item => ({
      sessionId: compress(typeof item === 'string' ? item : item?.sessionId),
      lastActivityAt: Number.isFinite(item?.lastActivityAt) ? item.lastActivityAt : 0,
    }))
    .filter(item => item.sessionId !== '')
  if (valid.length === 0) return ''
  const sorted = valid.slice().sort((a, b) => b.lastActivityAt - a.lastActivityAt)
  return sorted[0].sessionId
}

/**
 * 调一次语义模型（冷启动提炼 / 增量 L3 共用）。
 *
 * ## sessionId 是调用契约的一部分，不是可选装饰
 *
 * 宿主适配器在缺 sessionId 时直接拒绝整次调用；这里把它做成**默认继承**：
 * 调用方没给 sessionId 时会从 sessionIds / sessionIdCandidates 里挑一个，
 * 而不是把 undefined 一路传到底。真机事故（8 个工作区 7 个 semanticUsed=false）
 * 的根因就是这个字段在冷启动路径上漏传，且异常被 catch 静默吞掉。
 *
 * @returns 模型正文；未配置模型时返回 null；失败时抛出（由调用方落状态）。
 */
async function callSemanticModel(ctx, prompt, options = {}) {
  const deps = isPlainObject(options.deps) ? options.deps : {}
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : MODEL_TIMEOUT_MS
  const controller = typeof AbortController === 'function' ? new AbortController() : null

  const explicitSessionId = compress(options.sessionId)
  const candidateSessionIds = Array.isArray(options.sessionIds) ? options.sessionIds : []
  const routeSessionIds = candidateSessionIds.map(id => compress(id)).filter(id => id !== '')
  const resolvedSessionId = explicitSessionId !== ''
    ? explicitSessionId
    : (routeSessionIds[0] ?? pickRefineSessionId(options.sessionIdCandidates))

  const runCall = async () => {
    if (typeof deps.askModel === 'function') {
      return deps.askModel(ctx, prompt, {
        ...options,
        sessionId: resolvedSessionId,
        signal: controller?.signal,
      })
    }

    const config = isPlainObject(options.config) ? options.config : {}
    const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : COLD_START_MODEL_MAX_TOKENS

    if (hasCustomEndpoint(config)) {
      return await callRemote({ fetch }, config, prompt.system, prompt.user, {
        maxTokens,
        timeoutMs,
        signal: controller?.signal,
        sessionId: resolvedSessionId,
      })
    }
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm
    if (llm === undefined || llm === null) return null

    // 显式路由优先：提炼层在换用候选路由重试时直接把它传进来，
    // 避免每次都再走一遍 resolveRoute 的异步读会话逻辑。
    const explicitRoute = isPlainObject(options.route) ? options.route : null
    let route = null
    if (explicitRoute !== null && compress(explicitRoute.provider) !== '') {
      route = { provider: compress(explicitRoute.provider), model: compress(explicitRoute.model) }
    } else if (typeof deps.resolveRoute === 'function') {
      route = await deps.resolveRoute(ctx, config, routeSessionIds)
    } else if (config.provider && config.model) {
      route = { provider: config.provider, model: config.model }
    }
    return await askOnce(llm, route, prompt.system, prompt.user, controller?.signal, {
      maxTokens,
      sessionId: resolvedSessionId,
    })
  }

  let timer = null
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (controller !== null) {
        try { controller.abort() } catch { /* ignore */ }
      }
      reject(new Error(`semantic model timeout after ${timeoutMs}ms`))
    }, timeoutMs)
    if (typeof timer?.unref === 'function') timer.unref()
  })

  try {
    const task = Promise.resolve().then(runCall)
    // 防止超时后原 Promise 迟到 reject 触发未处理异常
    task.catch(() => {})
    return await Promise.race([task, timeoutPromise])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}


/**
 * 按「簇数」与「提示词长度」切批（ADR-0010 长输入分批）。
 *
 * 两条上限都要看：簇不多但每条摘要很长时，光靠簇数切不出安全批次；
 * 而单簇自己就超长时也必须单独成批——宁可让它一个人失败，也不能把整轮丢掉。
 *
 * 超出 REFINE_MAX_BATCHES 时把尾部**并进最后一批**而不是截断：
 * 截断等于丢簇，丢簇等于丢段，这是红线。
 *
 * @param {object[]} clusters
 * @param {object[]} segments
 * @returns {object[][]} 批次数组，覆盖全部簇且顺序不变。
 */
function splitRefineBatches(clusters, segments) {
  const list = Array.isArray(clusters) ? clusters : []
  const batches = []
  let current = []
  for (const cluster of list) {
    const candidate = [...current, cluster]
    const prompt = buildColdStartSemanticPrompt(candidate, segments)
    const tooMany = candidate.length > REFINE_BATCH_MAX_CLUSTERS
    const tooLong = prompt.user.length > REFINE_BATCH_MAX_PROMPT_CHARS
    if (current.length > 0 && (tooMany || tooLong)) {
      batches.push(current)
      current = [cluster]
    } else {
      current = candidate
    }
  }
  if (current.length > 0) batches.push(current)
  const packed = batches.length <= REFINE_MAX_BATCHES
    ? batches
    : [...batches.slice(0, REFINE_MAX_BATCHES - 1), batches.slice(REFINE_MAX_BATCHES - 1).flat()]
  // 自检：分批只允许「重排、不重不漏」。漏簇等于漏段（用户会丢事），
  // 重簇等于同一段被挂到两件事上。任何一处不满足都是接线错误，
  // 直接抛出去让人看见，绝不静默降级成「少提炼一点」。
  const seen = new Set()
  for (const batch of packed) {
    for (const cluster of batch) {
      const id = cluster?.clusterId
      if (typeof id !== 'string' || id === '') {
        throw new Error(`语义提炼分批自检失败：簇缺少 clusterId（共 ${list.length} 簇）`)
      }
      if (seen.has(id)) {
        throw new Error(`语义提炼分批自检失败：簇 ${id} 出现在多个批次中`)
      }
      seen.add(id)
    }
  }
  if (seen.size !== list.length) {
    throw new Error(`语义提炼分批自检失败：簇数量不匹配（输入 ${list.length}，分批后 ${seen.size}）`)
  }
  return packed
}

/**
 * 合并各批提炼结果。
 *
 * 各批的簇集合在 splitRefineBatches 里已经保证两两不相交，parseColdStartSemanticResult
 * 又只在**本批**的簇范围内认领（且批内先到先得），所以跨批重复在正常情况下不可能
 * 出现——这里不做"丢一条"的兜底，而是把重复当接线错误**直接抛出去**。
 * 理由：静默丢一条的后果是"某一批的结论凭空消失"，比崩掉难查得多。
 *
 * @returns {{ fallback: boolean, works: object[], chatClusterIds: string[] }}
 */
function mergeRefinedBatches(works, chatClusterIds) {
  const claimed = new Set()
  const claim = (id, what) => {
    if (claimed.has(id)) {
      throw new Error(`语义提炼合并自检失败：簇 ${id} 被多批同时认领（${what}）`)
    }
    claimed.add(id)
  }
  const mergedWorks = []
  for (const item of Array.isArray(works) ? works : []) {
    if (!isPlainObject(item) || !Array.isArray(item.clusterIds)) continue
    const ids = uniqueStrings(item.clusterIds)
    if (ids.length === 0) continue
    for (const id of ids) claim(id, 'works')
    mergedWorks.push({ ...item, clusterIds: ids })
  }
  const mergedChat = uniqueStrings(chatClusterIds)
  for (const id of mergedChat) claim(id, 'chatClusterIds')
  return { fallback: false, works: mergedWorks, chatClusterIds: mergedChat }
}

/**
 * 冷启动语义提炼：分批调模型、合并结果、如实记录状态（ADR-0010）。
 *
 * 关键约束：
 * 1. **绝不静默**——每一批的失败都归类到 refineStatus.reason 并写诊断日志；
 * 2. **绝不清空规则结果**——只要有一批没成功，refined 就返回 null，
 *    调用方照常使用零模型硬信号聚类（首帧秒出不因此改变）；
 * 3. 每批都**显式带上该工作区的真实 sessionId**（适配器缺它直接拒绝）。
 *
 * @param {object} ctx
 * @param {object} options - `{ clusters, segments, sessionIds, sessionIdCandidates, config, deps, modelTimeoutMs, now, scope }`
 * @returns {Promise<{ status: object, refined: object|null }>}
 */
/**
 * 依次用候选路由调用模型，直到有一条成功。
 *
 * 只对「换条路由可能就好了」的错误类型换路：适配器缺失、账户欠费/额度、
 * 以及 provider/model 元数据不合法。超时与解析失败**不换路**——那是一批内容的问题，
 * 换 provider 只是白白多花钱。
 *
 * @param ctx - Host context。
 * @param prompt - `{ system, user }`。
 * @param options - 透传给 callSemanticModel，含 `routes`。
 * @returns 模型正文。
 */
async function callWithRouteCandidates(ctx, prompt, options) {
  const routes = Array.isArray(options?.routes) ? options.routes.filter(isPlainObject) : []
  // 没有任何候选时就走原有的单次调用（内部仍会按可用适配器兜底）。
  if (routes.length === 0) return await callSemanticModel(ctx, prompt, options)

  let lastError = null
  for (let i = 0; i < routes.length; i += 1) {
    try {
      return await callSemanticModel(ctx, prompt, { ...options, route: routes[i] })
    } catch (error) {
      lastError = error
      const info = classifyModelError(error)
      const switchable = info.noAdapter || info.quota
        || /invalid exact model metadata/i.test(info.message)
      if (!switchable) throw error
      // 换下一条路由继续试
    }
  }
  const message = String(lastError && lastError.message ? lastError.message : lastError)
  const wrapped = new Error(message + '（已尝试 ' + routes.length + ' 条候选路由）')
  wrapped.cause = lastError
  throw wrapped
}

async function refineColdStartClusters(ctx, options) {
  const opts = isPlainObject(options) ? options : {}
  const clusters = Array.isArray(opts.clusters) ? opts.clusters : []
  const segments = Array.isArray(opts.segments) ? opts.segments : []
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const scope = compress(opts.scope)
  const label = scope === '' ? '冷启动提炼' : `冷启动提炼(${scope})`
  if (clusters.length === 0) return { status: emptyRefineStatus(), refined: null }

  const sessionIds = (Array.isArray(opts.sessionIds) ? opts.sessionIds : [])
    .map(id => compress(id))
    .filter(id => id !== '')
  // 会话级的调用（例如某个工作区只有一个活跃会话）优先用那个会话，
  // 没有时退回「该工作区最近活跃的会话」，最后才退回会话列表首个。
  const batchSessionId = compress(opts.sessionId)
    || pickRefineSessionId(opts.sessionIdCandidates)
    || sessionIds[0]
    || ''

  // 候选路由（按优先级）：本工作区会话历史在前，可借用的在后。
  // 只取前若干条：真机上通常 1~3 条就够，试太多既慢又费钱。
  let routes = []
  if (typeof opts.deps?.listRouteCandidates === 'function') {
    try {
      const listed = await opts.deps.listRouteCandidates(ctx, isPlainObject(opts.config) ? opts.config : {}, sessionIds)
      routes = Array.isArray(listed) ? listed.filter(isPlainObject).slice(0, 4) : []
    } catch {
      routes = []
    }
  }

  const batches = splitRefineBatches(clusters, segments)
  const collectedWorks = []
  const collectedChat = []
  let succeeded = 0
  let attempts = 0
  let firstFailure = null
  let firstFailureDetail = ''
  const noteFailure = (reason, detail) => {
    if (firstFailure === null) {
      firstFailure = reason
      firstFailureDetail = typeof detail === 'string' ? detail.trim().slice(0, 200) : ''
    }
  }

  // 跑一批；超时时**对半拆开重试**而不是整批作废（ADR-0010 补充）。
  //
  // 真机上 3 个工作区 reason='timeout'：一批 12 簇塞给模型一次跑不完，
  // 旧实现直接 continue，整批结论全丢。拆开后每半批都是可独立成败的小请求，
  // 最坏情况也只丢掉真正过大的那一半，而不是全部。
  const runBatch = async (batch, index, depth) => {
    attempts += 1
    let text = null
    try {
      const prompt = buildColdStartSemanticPrompt(batch, segments)
      text = await callWithRouteCandidates(ctx, prompt, {
        config: opts.config,
        deps: opts.deps,
        maxTokens: COLD_START_MODEL_MAX_TOKENS,
        timeoutMs: opts.modelTimeoutMs,
        // 显式传：适配器没有它会直接拒绝整次调用（真机事故根因）。
        sessionId: batchSessionId,
        sessionIds,
        sessionIdCandidates: opts.sessionIdCandidates,
        routes,
      })
    } catch (error) {
      const info = classifyModelError(error)
      if (
        info.reason === REFINE_REASONS.TIMEOUT &&
        batch.length > 1 &&
        depth < REFINE_SPLIT_MAX_DEPTH
      ) {
        const mid = Math.ceil(batch.length / 2)
        await runBatch(batch.slice(0, mid), index, depth + 1)
        await runBatch(batch.slice(mid), index, depth + 1)
        return
      }
      reportRefineFailure(`${label} 第 ${index + 1}/${batches.length} 批`, error)
      noteFailure(info.reason, info.message)
      return
    }
    if (text === null || text === undefined) {
      noteFailure(REFINE_REASONS.NO_MODEL, '没有可用的模型适配器')
      return
    }
    if (typeof text !== 'string' || text.trim() === '') {
      noteFailure(REFINE_REASONS.INVALID_JSON, '模型返回空正文')
      return
    }
    const parsed = parseColdStartSemanticResult(text, batch)
    if (parsed.fallback) {
      noteFailure(REFINE_REASONS.INVALID_JSON, '返回无法解析：' + text.trim().slice(0, 120))
      return
    }
    for (const item of parsed.works) collectedWorks.push(item)
    for (const id of parsed.chatClusterIds) collectedChat.push(id)
    succeeded += 1
  }

  for (let index = 0; index < batches.length; index += 1) {
    await runBatch(batches[index], index, 0)
  }

  if (succeeded === 0) {
    return {
      status: {
        used: false,
        at: now,
        reason: firstFailure ?? REFINE_REASONS.FAILED,
        attempts,
        detail: firstFailureDetail,
      },
      refined: null,
    }
  }

  return {
    status: { used: true, at: now, reason: REFINE_REASONS.OK, attempts, detail: '' },
    refined: mergeRefinedBatches(collectedWorks, collectedChat),
  }
}

// ── 双表合并保护：重扫绝不覆盖已确认/锁定态 ─────────────────────────

function isConfirmedOrLockedWork(work, lockedSet) {
  if (!isPlainObject(work)) return false
  if (work.dismissedAsChat === true) return true
  if (lockedSet.has(work.id)) return true
  if (work.stateSource === 'confirmed' || work.nextStepSource === 'confirmed') return true
  if (work.pinned === true) return true
  if (Array.isArray(work.confirmedFields) && work.confirmedFields.length > 0) return true
  if (Array.isArray(work.decisions) && work.decisions.some(d => d?.source === 'confirmed')) return true
  return false
}

/**
 * 将新一轮盘点产出的 inferred works 与旧 store 中人工确认/锁定的 works 安全合并：
 * - 已确认/锁定的 work 保留原 id、所有 confirmed 字段、pinned、人工决策；
 * - 若新盘点中某候选事与该已确认事共享段或会话，只把新增的 segmentIds/sessionIds/files/evidenceHandles 以及未确认字段通过 applyInferredUpdate 温和合入（对已确认 done/shelved 或已退回话题的事零改动）；
 * - 纯新候选事直接加入；
 * - 已确认事中未被新盘点提及的也完整保留，绝不丢弃。
 */
/**
 * 提取「提炼得出结论的字段」（ADR-0010 批次合并用）。
 *
 * 只取模型能改变、且属于提炼结论的字段：标题 / 目标 / 状态 / 现状 / 下一步 /
 * 证据句柄。**不取 ** `decisions`：它走 addDecision 的按需累积路径，在冷启动
 * 投影里已经被「已确认事保留人工决策」的规则过滤掉了，拿基线去比对只会把
 * 人工决策误判成「被提炼改动」。
 *
 * @param {object} store - 已经写盘的前台投影（规则结果）。
 * @returns {Map<string, {fields: object, segmentIds: Set<string>, sessionIds: Set<string>}>}
 */
function extractRefineProjection(store, refinedWorks) {
  const baseline = new Map()
  const worksById = new Map(
    (Array.isArray(store?.works) ? store.works : [])
      .filter(w => isPlainObject(w))
      .map(w => [w.id, w]),
  )
  for (const cand of Array.isArray(refinedWorks) ? refinedWorks : []) {
    if (!isPlainObject(cand)) continue
    const existing = worksById.get(cand.id)
    if (existing === undefined) continue
    baseline.set(cand.id, {
      fields: {
        title: existing.title,
        goal: existing.goal,
        state: existing.state,
        statusSummary: existing.statusSummary,
        nextStep: existing.nextStep,
        evidenceHandles: existing.evidenceHandles,
      },
      segmentIds: new Set(Array.isArray(existing.segmentIds) ? existing.segmentIds : []),
      sessionIds: new Set(Array.isArray(existing.sessionIds) ? existing.sessionIds : []),
    })
  }
  return baseline
}

/** 深度等价（字段是 JSON 形状，用稳定序列化比对即可）。 */
function sameJsonShape(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * 把「提炼确实改过」的字段贴回最新 store（ADR-0010 批次合并用）。
 *
 * 为什么必须这样合并，而不是直接整份覆盖：
 * - 物理覆盖会**清空前台已发布的规则投影**，让 /works 的首帧数据倒退；
 * - 全量放弃又会丢掉目标/现状/下一步这些正是本次要修出来的东西。
 *
 * 判据是「精化投影 vs 同一次扫描的规则投影」的差异：只有差异字段才回贴。
 * 于是人工在 `nextStep` 上的修改（两版都是同一份规则值）天然不会被碰。
 *
 * @param {object} latestStore - 落盘前的最新 store（含人工确认）。
 * @param {object} mergedStore - 合并后的规则投影。
 * @param {Map<string, object>} baseline - extractRefineProjection 的产物。
 * @returns {object} 补上提炼结论后的 store。
 */
function applyRefineProjection(latestStore, mergedStore, baseline) {
  if (!(baseline instanceof Map) || baseline.size === 0) return mergedStore
  const latestById = new Map(
    (Array.isArray(latestStore?.works) ? latestStore.works : [])
      .filter(w => isPlainObject(w))
      .map(w => [w.id, w]),
  )
  const works = (Array.isArray(mergedStore.works) ? mergedStore.works : []).map(work => {
    if (!isPlainObject(work)) return work
    const base = baseline.get(work.id)
    const latest = latestById.get(work.id)
    if (base === undefined || latest === undefined) return work
    const patch = {}
    for (const [key, prevValue] of Object.entries(base.fields)) {
      if (!sameJsonShape(work[key], prevValue)) patch[key] = work[key]
    }
    if (Object.keys(patch).length === 0) return work
    // 段/会话集合取并集：提炼不该让「这件事包含哪些段」变窄。
    const mergedSegments = uniqueStrings([
      ...(Array.isArray(latest.segmentIds) ? latest.segmentIds : []),
      ...(Array.isArray(work.segmentIds) ? work.segmentIds : []),
    ])
    const mergedSessions = uniqueStrings([
      ...(Array.isArray(latest.sessionIds) ? latest.sessionIds : []),
      ...(Array.isArray(work.sessionIds) ? work.sessionIds : []),
    ])
    return {
      ...latest,
      ...patch,
      segmentIds: mergedSegments,
      sessionIds: mergedSessions,
      updatedAt: Math.max(
        Number.isFinite(latest.updatedAt) ? latest.updatedAt : 0,
        Number.isFinite(work.updatedAt) ? work.updatedAt : 0,
      ),
    }
  })
  return { ...mergedStore, works }
}

function mergeScannedWithExisting(existingStore, scannedWorks, scannedSegments, now) {
  const lockedSet = new Set(uniqueStrings(existingStore.lockedWorkIds))
  const existingWorks = Array.isArray(existingStore.works) ? existingStore.works : []
  const protectedWorks = existingWorks.filter(w => isConfirmedOrLockedWork(w, lockedSet))

  // 合并段表：保留已有被锁定段的 workId / locked 标记
  const nextSegments = { ...scannedSegments }
  for (const [segId, prevSeg] of Object.entries(existingStore.segments ?? {})) {
    if (!isPlainObject(prevSeg)) continue
    if (prevSeg.locked === true) {
      nextSegments[segId] = nextSegments[segId]
        ? { ...nextSegments[segId], workId: prevSeg.workId ?? null, locked: true }
        : { ...prevSeg }
    } else if (!nextSegments[segId]) {
      nextSegments[segId] = { ...prevSeg }
    }
  }

  // 构建以 protectedWorks 为底的临时 store，便于复用 applyInferredUpdate 的不可覆盖规则
  let tempStore = {
    ...existingStore,
    works: protectedWorks.map(w => ({ ...w })),
    segments: nextSegments,
    lockedWorkIds: uniqueStrings([...lockedSet, ...protectedWorks.map(w => w.id)]),
  }

  const protectedBySeg = new Map()
  const protectedBySession = new Map()
  for (const pw of protectedWorks) {
    for (const segId of Array.isArray(pw.segmentIds) ? pw.segmentIds : []) {
      if (!protectedBySeg.has(segId)) protectedBySeg.set(segId, pw.id)
    }
    for (const sid of Array.isArray(pw.sessionIds) ? pw.sessionIds : []) {
      if (!protectedBySession.has(sid)) protectedBySession.set(sid, pw.id)
    }
  }

  const takenWorkIds = new Set(tempStore.works.map(w => w.id))
  const freshWorks = []

  for (const cand of scannedWorks) {
    // 查找是否命中已有受保护事（优先段重叠，其次会话重叠）
    let hitProtectedId = null
    for (const segId of cand.segmentIds) {
      if (protectedBySeg.has(segId)) {
        hitProtectedId = protectedBySeg.get(segId)
        break
      }
    }
    if (hitProtectedId === null) {
      for (const sid of cand.sessionIds) {
        if (protectedBySession.has(sid)) {
          hitProtectedId = protectedBySession.get(sid)
          break
        }
      }
    }

    if (hitProtectedId !== null) {
      tempStore = carryExtras(tempStore, applyInferredUpdate(tempStore, hitProtectedId, {
        title: cand.title,
        goal: cand.goal,
        state: cand.state,
        statusSummary: cand.statusSummary,
        nextStep: cand.nextStep,
        segmentIds: cand.segmentIds,
        sessionIds: cand.sessionIds,
        files: cand.files,
        decisions: cand.decisions,
        evidenceHandles: cand.evidenceHandles,
        lastActivityAt: cand.lastActivityAt,
      }, now))
      const updatedTarget = tempStore.works.find(w => w.id === hitProtectedId)
      if (updatedTarget && !updatedTarget.dismissedAsChat) {
        for (const segId of updatedTarget.segmentIds) {
          if (isPlainObject(nextSegments[segId]) && nextSegments[segId].locked !== true) {
            nextSegments[segId] = { ...nextSegments[segId], workId: hitProtectedId }
          }
        }
      }
      continue
    }

    // 避免与受保护事 id 碰撞
    let nextCand = cand
    if (takenWorkIds.has(cand.id)) {
      let n = 1
      let alt = `${cand.id}-${n}`
      while (takenWorkIds.has(alt)) {
        n += 1
        alt = `${cand.id}-${n}`
      }
      nextCand = { ...cand, id: alt }
    }
    takenWorkIds.add(nextCand.id)
    freshWorks.push(nextCand)
    for (const segId of nextCand.segmentIds) {
      if (isPlainObject(nextSegments[segId]) && nextSegments[segId].locked !== true) {
        nextSegments[segId] = { ...nextSegments[segId], workId: nextCand.id }
      }
    }
  }

  return {
    ...tempStore,
    works: [...tempStore.works, ...freshWorks],
    segments: nextSegments,
    updatedAt: Math.max(existingStore.updatedAt ?? 0, now),
  }
}

/** 把冷启动模型精化结果组装成标准 Work 数组。 */
function buildWorksFromColdStartRefinement(refined, clusters, segmentsById, workspaceId, now) {
  const clusterById = new Map(clusters.map(c => [c.clusterId, c]))
  const out = []
  let seq = 1

  for (const item of refined.works) {
    const matchedClusters = item.clusterIds.map(id => clusterById.get(id)).filter(Boolean)
    if (matchedClusters.length === 0) continue

    const segmentIds = uniqueStrings(matchedClusters.flatMap(c => c.segmentIds))
    const sessionIds = uniqueStrings(matchedClusters.flatMap(c => c.sessionIds))
    const files = uniqueStrings(matchedClusters.flatMap(c => c.files))
    const evidenceHandles = uniqueStrings([
      ...matchedClusters.flatMap(c => c.evidenceHandles),
      ...item.decisions.map(d => d.evidenceHandle),
    ])
    const createdAt = Math.min(...matchedClusters.map(c => c.createdAt || now))
    const lastActivityAt = Math.max(...matchedClusters.map(c => c.lastActivityAt || 0))
    const firstSeg = segmentsById.get(segmentIds[0])
    const lastSeg = segmentsById.get(segmentIds[segmentIds.length - 1])

    out.push(createWork({
      id: `w-cs-${seq}`,
      workspaceId,
      title: item.title || matchedClusters[0].title,
      goal: item.goal || firstSeg?.summary || '',
      state: item.state,
      stateSource: 'inferred',
      pinned: false,
      statusSummary: item.statusSummary || lastSeg?.summary || '',
      nextStep: item.nextStep || '',
      nextStepSource: 'inferred',
      segmentIds,
      sessionIds,
      files,
      decisions: item.decisions,
      evidenceHandles,
      createdAt,
      updatedAt: Math.max(lastActivityAt, now),
      lastActivityAt,
      lastInflectionAt: null,
      reviewStatus: 'pending',
      dismissedAsChat: false,
      reopenedFromId: null,
    }, now))
    seq += 1
  }
  return out
}

// ── 存量冷启动盘点 ──────────────────────────────────────────────────

/**
 * 存量一次性冷启动扫描（或 `force: true` 重新盘点）。
 *
 * 1. 读取工作区所有会话轮次，过滤 `isAutomatedSession`；
 * 2. 对每会话运行 `sliceSessionSegments`；
 * 3. 运行 `planColdStartWorks`（fork 血缘 + 引用句柄 + 业务文件重叠）；
 * 4. 若配置模型且 `useModel !== false`，做一次性语义精化（失败安全降级回硬信号）；
 * 5. 应用 `applyDormancySettlement`；
 * 6. 合并已有已确认/锁定事（绝不覆盖）并原子落盘，返回 `projectResumeCards` 投影。
 *
 * @param {object} ctx
 * @param {string} workspaceId
 * @param {object} [options] - `{ force, useModel, dormantDays, now, config, deps }`
 */
export async function scanWorkspaceWorks(ctx, workspaceId, options = {}) {
  const wsId = compress(workspaceId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }

  const opts = isPlainObject(options) ? options : {}
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const dormantDays = opts.dormantDays === undefined
    ? (Number.isFinite(opts.config?.dormantDays) ? opts.config.dormantDays : DEFAULT_DORMANT_DAYS)
    : Number(opts.dormantDays)
  const useModel = opts.useModel !== false
  const force = opts.force === true
  const asyncRefine = opts.asyncRefine === true || opts.mode === 'fast-then-refine'
  const deps = isPlainObject(opts.deps) ? opts.deps : {}

  // asyncRefine / fast-then-refine 模式：先同步 <100ms 完成硬信号盘点返回，同时后台异步跑一次模型精化
  if (asyncRefine) {
    const fast = await scanWorkspaceWorks(ctx, wsId, {
      ...opts,
      force: true,
      useModel: false,
      asyncRefine: false,
      mode: undefined,
      now,
      dormantDays,
    })
    if (!fast.ok) return fast

    let refining = backgroundRefineInFlight.has(wsId)
    if (useModel && !refining) {
      const hasLlm = typeof deps.askModel === 'function'
        || hasCustomEndpoint(opts.config)
        || Boolean(typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm)
      if (hasLlm) {
        backgroundRefineInFlight.add(wsId)
        refining = true
        Promise.resolve().then(async () => {
          try {
            await scanWorkspaceWorks(ctx, wsId, {
              ...opts,
              force: true,
              useModel: true,
              asyncRefine: false,
              // 批次模式：后台精化时只允许写「提炼状态」与物化快照，
              // 绝不允许覆盖前台刚确认/锁定的字段（nextStep / decisions 等）。
              refineBatch: true,
              mode: undefined,
              dormantDays,
            })
          } catch (error) {
            // ADR-0010 禁止静默吞错：后台精化失败必须留下可诊断的日志。
            // 前台 L0 硬信号结果照常保留（首帧秒出不因此改变）。
            reportRefineFailure(`后台语义精化(${wsId})`, error)
          } finally {
            backgroundRefineInFlight.delete(wsId)
          }
        })
      }
    }

    return {
      ...fast,
      refining,
    }
  }

  // 预检已有 store：损坏直接报错；已初始化且非 force 时直接应用沉降并返回投影
  const initialRead = await readWorkStoreRaw(wsId)
  if (!initialRead.ok) return initialRead
  if (initialRead.exists && initialRead.store.initializedAt !== null && !force) {
    const settled = carryExtras(
      initialRead.store,
      applyDormancySettlement(initialRead.store, { now, dormantDays }),
    )
    const cards = projectResumeCards(settled, { now })
    const fallbackStats = isPlainObject(settled.lastScanSummary)
      ? {
          sessionsScanned: Number(settled.lastScanSummary.sessionsScanned) || 0,
          segmentsCount: Number(settled.lastScanSummary.segmentsCount) || Object.keys(settled.segments ?? {}).length,
          unresolvedCount: cards.unresolved.length,
          settledCount: cards.settled.length,
          semanticUsed: settled.lastScanSummary.semanticUsed === true,
        }
      : {
          sessionsScanned: 0,
          segmentsCount: Object.keys(settled.segments ?? {}).length,
          unresolvedCount: cards.unresolved.length,
          settledCount: cards.settled.length,
          semanticUsed: Number.isFinite(settled.semanticRefinedAt),
        }
    return {
      ok: true,
      scanned: false,
      semanticUsed: fallbackStats.semanticUsed,
      refineStatus: presentedRefineStatus(settled, backgroundRefineInFlight.has(wsId)),
      refining: backgroundRefineInFlight.has(wsId),
      stats: fallbackStats,
      lastScanSummary: settled.lastScanSummary ?? null,
      store: settled,
      cards,
      pendingReviewCount: cards.pendingReviewCount,
      latestInflection: settled.latestInflection,
      reopenSuggestion: settled.reopenSuggestion,
    }
  }

  // 1) 枚举会话并过滤自动化/子代理/空会话
  const metas = await listWorkspaceSessionMetas(ctx, wsId, deps)
  const allSegments = []
  const segmentsById = new Map()
  const forkEdges = []
  const activeSessionIds = []
  const handoffLinks = initialRead.store.handoffLinks ?? {}
  /** 会话 id → 该会话真实轮次：准入与「待确认」判定都要用它，不能靠段摘要猜。 */
  const sessionTurnsById = new Map()
  /** 有壳无瓤的会话（0 轮）：单独计数，不混进对话数（ADR-0012）。 */
  const emptySessionIds = []

  for (const meta of metas) {
    const sessionId = compress(meta.sessionId)
    if (sessionId === '') continue
    const turns = await loadSessionTurns(ctx, sessionId, deps)
    const firstPrompt = turns.length > 0 ? String(turns[0]?.prompt ?? '') : ''
    // 先只判「是不是子代理/自动化会话」——空会话要单独计数，不能在这一步一并丢掉（ADR-0012）。
    if (isAutomatedSession({
      ...meta.header,
      ...meta,
      turns,
      firstPrompt,
    }, { ignoreEmpty: true })) {
      continue
    }

    activeSessionIds.push(sessionId)
    // 会话是壳，对话是瓤：0 轮的会话没有对话，仍占着容器，但不该算进可读的对话数。
    if (turns.length === 0) {
      emptySessionIds.push(sessionId)
      continue
    }
    const forkParent = meta.forkParent ?? extractForkParent(meta.header)
    if (forkParent) {
      forkEdges.push({ childSessionId: sessionId, parentSessionId: forkParent })
    }

    sessionTurnsById.set(sessionId, turns)

    // ADR-0007：按会话主线切段（只在客观长间隔与人类显式转折处断开），
    // 不再用词面相似度把一个连续推进的会话剁成碎段。
    const rawSegments = sliceSessionSegments(turns, { sessionId, forkParent, strategy: 'mainline' })
    for (const seg of rawSegments) {
      const turnsInSeg = turns.filter(t => t.turn >= seg.startTurn && t.turn <= seg.endTurn)
      const adapted = adaptSegment(seg, turnsInSeg, wsId, {
        forkParent,
        handoffWorkId: handoffLinks[sessionId] ?? null,
      })
      // 「待确认」：用该段真实轮次判定 AI 是否停在等人回复。
      const awaiting = detectAwaitingHuman(turnsInSeg, {})
      adapted.awaiting = isPlainObject(awaiting) && awaiting.active === true
        ? { active: true, summary: compress(awaiting.summary), turn: Number.isInteger(awaiting.turn) ? awaiting.turn : null }
        : null
      // 段级准入（ADR-0006）：三条红线在这里拿到的是**真实轮次**，不会 fail-open。
      //
      // trigger 必须由轮次自己说明，不能硬编码成 'user'：自动化/子代理会话
      // 的轮次 trigger 是 'automated'，硬编码会把它们当成人类主导放进续接。
      const verdict = judgeAdmission({
        turns: turnsInSeg,
        title: compress(adapted.title),
        goal: compress(adapted.goal ?? adapted.summary),
        files: Array.isArray(adapted.changedFiles) ? adapted.changedFiles : [],
        trigger: triggerOfTurns(turnsInSeg),
        sessionCount: 1,
        turnCount: turnsInSeg.length,
      }, { now })
      adapted.admission = {
        admitted: verdict.admitted === true,
        reasons: Array.isArray(verdict.reasons) ? verdict.reasons.slice() : [],
        kind: verdict.kind === 'chat' ? 'chat' : 'work',
      }
      allSegments.push(adapted)
      segmentsById.set(adapted.id, adapted)
    }
  }

  // 该工作区的活跃会话（按最近活跃排序）：既是模型路由信封的取值来源，
  // 也是「选了哪个会话去调用」的可回归依据。
  const sessionActivity = collectSessionActivity(allSegments)

  // 2) 零模型硬信号预聚类
  const plan = planColdStartWorks(allSegments, {
    workspaceId: wsId,
    forkEdges,
    now,
    dormantDays,
    dismissedSegments: initialRead.store.dismissedSegments,
  })

  // 3) 可选模型语义精化：分批调用 + 失败安全降级 + 状态如实上报（ADR-0010）
  let candidateWorks = plan.works
  // null 表示「本次没有尝试提炼」：这时必须**保留**上一次的状态，
  // 否则 L0 快扫（useModel:false）会把「上次提炼成功」擦成「没提炼过」。
  let refineStatusOut = null
  if (useModel && plan.clusters.length > 0) {
    const attempt = await refineColdStartClusters(ctx, {
      clusters: plan.clusters,
      segments: allSegments,
      segmentsById,
      sessionIds: activeSessionIds,
      sessionIdCandidates: sessionActivity,
      config: opts.config,
      deps,
      modelTimeoutMs: opts.modelTimeoutMs,
      now,
      scope: wsId,
    })
    refineStatusOut = attempt.status
    if (attempt.refined !== null) {
      candidateWorks = buildWorksFromColdStartRefinement(attempt.refined, plan.clusters, segmentsById, wsId, now)
    }
  }
  // 本轮尝试过提炼才算「用了模型」；没尝试时（L0 快扫）沿用 store 里的旧结论。
  const semanticUsed = refineStatusOut !== null && refineStatusOut.used === true

  const segmentsRecord = {}
  for (const seg of allSegments) {
    segmentsRecord[seg.id] = seg
  }

  // 4) 在串行锁内重读最新 store：先提取「上次提炼给出的结论」，再合并、落盘
  return mutateWorkStore(wsId, async latestStore => {
    // 批次模式（后台精化）下，latestStore 是**前台已经发布**的 store。
    // 量化「首帧规则投影 vs 精化投影」的差异，只把精化确实改过的批内字段
    // 应用到最新 store 上——这样既保住提炼结论，又绝不回退人工确认。
    const baselineRefine = opts.refineBatch === true
      ? extractRefineProjection(latestStore, candidateWorks)
      : null
    const merged = mergeScannedWithExisting(latestStore, candidateWorks, segmentsRecord, now)
    const refineMerged = baselineRefine === null
      ? merged
      : applyRefineProjection(latestStore, merged, baselineRefine)
    const settled = carryExtras(
      refineMerged,
      applyDormancySettlement(refineMerged, { now, dormantDays }),
    )
    // 本轮没尝试提炼时：状态与「用了模型」结论都沿用 store 里的旧值，
    // 绝不用一次 L0 快扫把上次的成功记录擦掉。
    const effectiveSemanticUsed = refineStatusOut === null
      ? Number.isFinite(latestStore.semanticRefinedAt)
      : semanticUsed
    const nextRefineStatus = refineStatusOut === null
      ? hydrateRefineStatus(latestStore.refineStatus)
      : applyRefineStatusOverride(refineStatusOut, opts.refineStatusOverride)
    const preliminaryStore = {
      ...settled,
      initializedAt: latestStore.initializedAt ?? now,
      semanticRefinedAt: effectiveSemanticUsed ? (latestStore.semanticRefinedAt ?? now) : null,
      refineStatus: nextRefineStatus,
      updatedAt: Math.max(settled.updatedAt ?? 0, now),
    }
    const cards = projectResumeCards(preliminaryStore, { now })
    // conversationCount = 有对话的会话数（= 容器数 - 空会话数）；空会话单列。
    const stats = {
      sessionsScanned: activeSessionIds.length,
      conversationCount: activeSessionIds.length - emptySessionIds.length,
      emptySessionCount: emptySessionIds.length,
      segmentsCount: allSegments.length,
      unresolvedCount: cards.unresolved.length,
      settledCount: cards.settled.length,
      semanticUsed: effectiveSemanticUsed,
    }
    const lastScanSummary = {
      ...stats,
      at: now,
    }
    const finalStore = {
      ...preliminaryStore,
      lastScanSummary,
    }
    return {
      ok: true,
      scanned: true,
      conversationCount: stats.conversationCount,
      emptySessionCount: stats.emptySessionCount,
      semanticUsed: effectiveSemanticUsed,
      refineStatus: presentedRefineStatus(finalStore, backgroundRefineInFlight.has(wsId)),
      refining: backgroundRefineInFlight.has(wsId),
      stats,
      lastScanSummary,
      store: finalStore,
      cards,
      pendingReviewCount: cards.pendingReviewCount,
      latestInflection: finalStore.latestInflection,
      reopenSuggestion: finalStore.reopenSuggestion,
    }
  })
}

/** 后台一次性语义精化并发去重表（防止多请求重复跑后台精化）。 */
const backgroundRefineInFlight = new Set()

/**
 * 读取工作区「事」投影（供 POST /works 首帧秒出使用）：
 * - 已初始化：立即读物化快照、按当前 dormantDays 计算投影返回；
 * - 未初始化：先同步跑零模型 L0 硬信号盘点并落盘返回（绝不卡白屏），再后台异步排队一次模型语义精化。
 */
export async function readWorkspaceWorksView(ctx, workspaceId, options = {}) {
  const wsId = compress(workspaceId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }

  const opts = isPlainObject(options) ? options : {}
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const dormantDays = opts.dormantDays === undefined
    ? (Number.isFinite(opts.config?.dormantDays) ? opts.config.dormantDays : DEFAULT_DORMANT_DAYS)
    : Number(opts.dormantDays)

  const loaded = await readWorkStoreRaw(wsId)
  if (!loaded.ok) return loaded

  if (loaded.exists && loaded.store.initializedAt !== null) {
    const settled = carryExtras(
      loaded.store,
      applyDormancySettlement(loaded.store, { now, dormantDays }),
    )
    const cards = projectResumeCards(settled, { now })
    return {
      ok: true,
      initialized: true,
      // 会话是壳，对话是瓤（ADR-0012）：前端不得再从 sessionIds.length 推断内容量。
      conversationCount: readCount(settled, 'conversationCount'),
      emptySessionCount: readCount(settled, 'emptySessionCount'),
      refineStatus: presentedRefineStatus(settled, backgroundRefineInFlight.has(wsId)),
      refining: backgroundRefineInFlight.has(wsId),
      lastScanSummary: settled.lastScanSummary ?? null,
      store: settled,
      cards,
      works: settled.works.filter(w => !w.dismissedAsChat),
      pendingReviewCount: cards.pendingReviewCount,
      latestInflection: opts.config?.inflectionNotice === false ? null : settled.latestInflection,
      reopenSuggestion: settled.reopenSuggestion,
    }
  }

  // 首次冷启动：先同步完成零模型 L0 硬信号快速盘点（首帧秒出）
  const fast = await scanWorkspaceWorks(ctx, wsId, {
    ...opts,
    force: true,
    useModel: false,
    now,
    dormantDays,
  })
  if (!fast.ok) return fast

  // 后台异步排队一次语义精化（仅当未在跑且允许用模型）
  let refining = false
  if (opts.useModel !== false && opts.backgroundRefine !== false && !backgroundRefineInFlight.has(wsId)) {
    const hasLlm = hasCustomEndpoint(opts.config) || Boolean(typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm)
    if (hasLlm) {
      backgroundRefineInFlight.add(wsId)
      refining = true
      Promise.resolve().then(async () => {
        try {
          await scanWorkspaceWorks(ctx, wsId, {
            ...opts,
            force: true,
            useModel: true,
            dormantDays,
          })
        } catch (error) {
          // 后台精化失败**不静默**：状态与原因由它自己那次 refineBatch 扫描
          // 落进 store.refineStatus；这里只补写一份可诊断的 worker 日志，
          // 并保证 L0 硬信号结果照常保留（首帧秒出不受影响）。
          reportRefineFailure(`后台语义精化(${wsId})`, error)
        } finally {
          backgroundRefineInFlight.delete(wsId)
        }
      })
    }
  }

  return {
    ok: true,
    initialized: true,
    refineStatus: presentedRefineStatus(fast.store, refining),
    refining,
    lastScanSummary: fast.lastScanSummary ?? fast.store.lastScanSummary ?? null,
    store: fast.store,
    cards: fast.cards,
    works: fast.store.works.filter(w => !w.dismissedAsChat),
    pendingReviewCount: fast.cards.pendingReviewCount,
    latestInflection: opts.config?.inflectionNotice === false ? null : fast.store.latestInflection,
    reopenSuggestion: fast.store.reopenSuggestion,
  }
}

// ── 单会话增量同步（L1 → L2 → L3 + 拐点检测） ───────────────────────

function resolveSessionWorkspaceId(ctx, sessionId, explicitWorkspaceId) {
  const direct = compress(explicitWorkspaceId)
  if (direct !== '') return direct
  const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  if (typeof registry?.list !== 'function') return ''
  try {
    for (const ws of registry.list()) {
      const ids = Array.isArray(ws?.sessionIds) ? ws.sessionIds : []
      if (ids.some(id => String(id) === sessionId)) return String(ws.id ?? '')
    }
  } catch {
    // 忽略
  }
  return ''
}

async function readSessionHeader(ctx, sessionId) {
  try {
    if (typeof ctx?.sessionQuery?.listSessions === 'function') {
      const records = await ctx.sessionQuery.listSessions()
      for (const rec of Array.isArray(records) ? records : []) {
        const id = String(rec?.header?.id ?? rec?.id ?? '')
        if (id === sessionId) return rec.header ?? rec
      }
    }
  } catch {
    // 忽略
  }
  try {
    if (typeof ctx?.sessionQuery?.readSession === 'function') {
      const snap = await ctx.sessionQuery.readSession(sessionId)
      if (isPlainObject(snap?.header)) return snap.header
    }
  } catch {
    // 忽略
  }
  return {}
}

/**
 * 单会话增量同步（由 agent/end / session/disposed / session/close 防抖触发或显式调用）。
 *
 * 1. 读取会话轮次并过滤自动化/子代理会话；
 * 2. 切段取最新段（与上一段用于拐点检测）；
 * 3. 在工作区串行锁内跑 `matchSegmentIncremental`（L1 交接/fork/句柄 → L2 文件重叠 → L3 可选模型）；
 * 4. 命中已确认 `done` 老事时写入 `reopenSuggestion`（绝不篡改老事）；
 * 5. 运行 `detectInflection` 记录最新自然拐点，并更新物化快照落盘。
 *
 * @param {object} ctx
 * @param {string} sessionId
 * @param {object} [options] - `{ workspaceId, useModel, now, dormantDays, config, deps }`
 */
export async function incrementalSyncSession(ctx, sessionId, options = {}) {
  const sid = compress(sessionId)
  if (sid === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }

  const opts = isPlainObject(options) ? options : {}
  const now = Number.isFinite(opts.now) ? opts.now : Date.now()
  const deps = isPlainObject(opts.deps) ? opts.deps : {}
  const wsId = resolveSessionWorkspaceId(ctx, sid, opts.workspaceId)
  if (wsId === '') return { ok: true, skipped: true, reason: 'workspace_not_found' }

  const header = await readSessionHeader(ctx, sid)
  if (isAutomatedHeader(header)) {
    return { ok: true, skipped: true, reason: 'automated' }
  }
  const turns = await loadSessionTurns(ctx, sid, deps)
  const firstPrompt = turns.length > 0 ? String(turns[0]?.prompt ?? '') : ''
  if (isAutomatedSession({ ...header, sessionId: sid, turns, firstPrompt })) {
    return { ok: true, skipped: true, reason: 'automated' }
  }

  const forkParent = extractForkParent(header)
  const rawSegments = sliceSessionSegments(turns, { sessionId: sid, forkParent })
  if (rawSegments.length === 0) {
    return { ok: true, skipped: true, reason: 'no_segments' }
  }

  // 预读 store 以拿 handoffLinks，若需要 L3 模型判断则在锁外完成模型调用，避免长时间占锁
  const preRead = await readWorkStoreRaw(wsId)
  if (!preRead.ok) return preRead

  const handoffWorkId = preRead.store.handoffLinks?.[sid] ?? null
  const adaptedSegments = rawSegments.map(seg => {
    const turnsInSeg = turns.filter(t => t.turn >= seg.startTurn && t.turn <= seg.endTurn)
    return adaptSegment(seg, turnsInSeg, wsId, { forkParent, handoffWorkId })
  })

  const latestSeg = adaptedSegments[adaptedSegments.length - 1]
  const prevSeg = adaptedSegments.length >= 2 ? adaptedSegments[adaptedSegments.length - 2] : null
  const lastTurn = turns[turns.length - 1] ?? null

  const preMatch = matchSegmentIncremental(preRead.store, latestSeg, {
    forkParentSessionId: forkParent ?? undefined,
    handoffWorkId: handoffWorkId ?? undefined,
  })

  let l3Decision = null
  // 增量路径同样禁止静默吞错（ADR-0010）：上一次提炼的失败原因与计数先继承下来，
  // 本次尝试则覆盖成新的结论，读数的人永远看得到「哪一次、为什么」失败。
  let l3RefineStatus = null
  if (preMatch.action === 'need_semantic' && opts.useModel !== false) {
    const attemptedAt = now
    try {
      const prompt = buildIncrementalMatchPrompt(latestSeg, preMatch.candidates)
      const text = await callSemanticModel(ctx, prompt, {
        config: opts.config,
        deps,
        maxTokens: INCREMENTAL_MODEL_MAX_TOKENS,
        // 增量是单会话调用：显式带上这个会话的 id（适配器缺它直接拒绝）。
        sessionId: sid,
        sessionIds: [sid],
      })
      if (text === null || text === undefined) {
        l3RefineStatus = { used: false, at: attemptedAt, reason: REFINE_REASONS.NO_MODEL, attempts: 1 }
      } else if (typeof text !== 'string' || text.trim() === '') {
        l3RefineStatus = { used: false, at: attemptedAt, reason: REFINE_REASONS.INVALID_JSON, attempts: 1 }
      } else {
        l3Decision = parseIncrementalMatchResult(text, preMatch.candidates)
        l3RefineStatus = l3Decision === null
          ? { used: false, at: attemptedAt, reason: REFINE_REASONS.INVALID_JSON, attempts: 1 }
          : { used: true, at: attemptedAt, reason: REFINE_REASONS.OK, attempts: 1 }
      }
    } catch (error) {
      reportRefineFailure(`增量语义匹配(${sid.slice(0, 8)})`, error)
      l3RefineStatus = { used: false, at: attemptedAt, reason: classifyModelError(error).reason, attempts: 1 }
      l3Decision = null
    }
  }

  const dormantDays = opts.dormantDays === undefined
    ? (Number.isFinite(opts.config?.dormantDays) ? opts.config.dormantDays : DEFAULT_DORMANT_DAYS)
    : Number(opts.dormantDays)

  // 在工作区串行锁内重读、重判并落盘
  return mutateWorkStore(wsId, async store => {
    const curHandoffWorkId = store.handoffLinks?.[sid] ?? handoffWorkId ?? null
    // 本次没走 L3 模型时保留上一次状态，只把尝试计数与时间往前推；
    // 走了模型则整条以本次结论为准（含失败原因）。
    const prevRefine = hydrateRefineStatus(store.refineStatus)
    const nextRefineStatus = l3RefineStatus === null
      ? {
          ...prevRefine,
          attempts: (Number.isInteger(prevRefine.attempts) ? prevRefine.attempts : 0) + 1,
          at: now,
        }
      : {
          ...l3RefineStatus,
          attempts: (Number.isInteger(prevRefine.attempts) ? prevRefine.attempts : 0) + 1,
        }
    const currSeg = { ...latestSeg, handoffWorkId: curHandoffWorkId }

    // 同步当前会话所有切段到段表（保留已有 workId/locked）
    const nextSegments = { ...store.segments }
    for (const seg of adaptedSegments) {
      const prev = nextSegments[seg.id]
      if (isPlainObject(prev) && prev.locked === true) {
        nextSegments[seg.id] = { ...seg, workId: prev.workId ?? null, locked: true }
      } else {
        nextSegments[seg.id] = { ...seg, workId: prev?.workId ?? null }
      }
    }

    let nextStore = { ...store, segments: nextSegments }
    let match = matchSegmentIncremental(nextStore, currSeg, {
      forkParentSessionId: forkParent ?? undefined,
      handoffWorkId: curHandoffWorkId ?? undefined,
    })

    // 若 L3 需要模型且锁外已拿到合法模型裁决，应用裁决；否则按 kindCandidate 兜底
    if (match.action === 'need_semantic') {
      if (l3Decision !== null) {
        if (l3Decision.action === 'attach') {
          const exists = nextStore.works.some(w => w.id === l3Decision.workId && !w.dismissedAsChat)
          if (exists) {
            match = {
              action: 'attach',
              level: 'L3',
              reason: l3Decision.reason || 'semantic',
              workId: l3Decision.workId,
              confidence: 0.75,
            }
          } else {
            match = { action: 'new_work', level: 'L3', reason: 'candidate_gone', segmentId: currSeg.id }
          }
        } else if (l3Decision.action === 'chat') {
          match = { action: 'ignore', level: 'L3', reason: l3Decision.reason || 'semantic_chat', segmentId: currSeg.id }
        } else {
          match = { action: 'new_work', level: 'L3', reason: l3Decision.reason || 'semantic_new', segmentId: currSeg.id }
        }
      } else if (currSeg.kindCandidate === 'chat') {
        match = { action: 'ignore', level: 'L3', reason: 'chat_segment', segmentId: currSeg.id }
      } else {
        match = { action: 'new_work', level: 'L3', reason: 'no_model_fallback', segmentId: currSeg.id }
      }
    }

    let attachedWork = null
    const segActivityAt = currSeg.lastActivityAt > 0 ? currSeg.lastActivityAt : now

    if (match.action === 'attach') {
      const targetId = match.workId
      // 若之前已沉降（shelved），重聊自动唤醒
      nextStore = carryExtras(nextStore, wakeWorkOnActivity(nextStore, targetId, segActivityAt))
      nextStore = carryExtras(nextStore, applyInferredUpdate(nextStore, targetId, {
        segmentIds: [currSeg.id],
        sessionIds: [sid],
        files: currSeg.files,
        evidenceHandles: currSeg.evidenceHandles,
        statusSummary: currSeg.summary,
        lastActivityAt: segActivityAt,
      }, now))
      if (isPlainObject(nextStore.segments[currSeg.id]) && nextStore.segments[currSeg.id].locked !== true) {
        nextStore.segments = {
          ...nextStore.segments,
          [currSeg.id]: { ...nextStore.segments[currSeg.id], workId: targetId },
        }
      }
      attachedWork = nextStore.works.find(w => w.id === targetId) ?? null
    } else if (match.action === 'suggest_reopen') {
      // 红线：绝不修改已确认 done 的老事，只写入 reopenSuggestion
      nextStore = {
        ...nextStore,
        reopenSuggestion: {
          relatedDoneWorkId: match.relatedDoneWorkId,
          relatedDoneWorkTitle: match.relatedDoneWorkTitle,
          sessionId: sid,
          segmentId: currSeg.id,
          segmentTitle: currSeg.title,
          level: match.level,
          reason: match.reason,
          at: now,
        },
        updatedAt: Math.max(nextStore.updatedAt ?? 0, now),
      }
    } else if (match.action === 'new_work' && currSeg.kindCandidate !== 'chat') {
      // 仅当段尚未被绑定到某事时才新建
      const existingWork = nextStore.works.find(w => !w.dismissedAsChat && w.segmentIds.includes(currSeg.id))
      if (existingWork) {
        attachedWork = existingWork
      } else {
        const work = createWork({
          workspaceId: wsId,
          title: currSeg.title,
          goal: currSeg.summary,
          state: currSeg.hasError ? 'blocked' : 'active',
          stateSource: 'inferred',
          pinned: false,
          statusSummary: currSeg.summary,
          nextStep: '',
          nextStepSource: 'inferred',
          segmentIds: [currSeg.id],
          sessionIds: [sid],
          files: currSeg.files,
          decisions: [],
          evidenceHandles: currSeg.evidenceHandles,
          createdAt: currSeg.startedAt ?? now,
          updatedAt: now,
          lastActivityAt: segActivityAt,
          reviewStatus: 'pending',
        }, now)
        nextStore = {
          ...nextStore,
          works: [...nextStore.works, work],
          segments: {
            ...nextStore.segments,
            [currSeg.id]: { ...nextStore.segments[currSeg.id], workId: work.id },
          },
          updatedAt: Math.max(nextStore.updatedAt ?? 0, now),
        }
        attachedWork = work
      }
    }

    // 拐点检测（带 prevSegment / currSegment 归属与相邻轮次间隔）
    const prevSegWithWork = prevSeg ? (nextStore.segments[prevSeg.id] ?? prevSeg) : undefined
    const currSegWithWork = nextStore.segments[currSeg.id] ?? currSeg
    let gapMs = 0
    if (turns.length >= 2) {
      const prevT = turns[turns.length - 2]
      const prevTime = prevT.end ?? prevT.start
      const curTime = lastTurn?.start ?? lastTurn?.end
      if (Number.isFinite(prevTime) && Number.isFinite(curTime) && curTime > prevTime) {
        gapMs = curTime - prevTime
      }
    }
    const inflection = detectInflection({
      prevSegment: prevSegWithWork,
      currSegment: currSegWithWork,
      work: attachedWork ?? undefined,
      lastTurn: lastTurn ?? undefined,
      gapMs,
    })

    if (inflection !== null && opts.config?.inflectionNotice !== false) {
      nextStore = {
        ...nextStore,
        latestInflection: {
          ...inflection,
          sessionId: sid,
          segmentId: currSeg.id,
          at: now,
        },
      }
    }

    nextStore = { ...nextStore, refineStatus: nextRefineStatus }
    nextStore = carryExtras(
      nextStore,
      applyDormancySettlement(nextStore, { now, dormantDays }),
    )
    nextStore.initializedAt = nextStore.initializedAt ?? now
    const cards = projectResumeCards(nextStore, { now })
    return {
      ok: true,
      store: nextStore,
      refineStatus: nextRefineStatus,
      match,
      inflection,
      cards,
      pendingReviewCount: cards.pendingReviewCount,
    }
  })
}

// ── 增量同步防抖调度器（供 apply(ctx) 钩子调用） ─────────────────────

const syncTimers = new Map()
const syncPendingPromises = new Set()

/**
 * 预约一次会话的增量同步（同会话防抖，避免频繁 IO 与模型调用）。
 */
export function scheduleIncrementalSync(ctx, sessionId, options = {}) {
  const sid = compress(sessionId)
  if (sid === '') return false
  const debounceMs = Number.isFinite(options.debounceMs) && options.debounceMs >= 0
    ? options.debounceMs
    : DEFAULT_SYNC_DEBOUNCE_MS

  const prevTimer = syncTimers.get(sid)
  if (prevTimer !== undefined) clearTimeout(prevTimer)

  const timer = setTimeout(() => {
    syncTimers.delete(sid)
    const p = incrementalSyncSession(ctx, sid, options)
      .catch(() => { /* 后台增量同步失败静默，不影响宿主 */ })
      .finally(() => syncPendingPromises.delete(p))
    syncPendingPromises.add(p)
  }, debounceMs)
  if (timer && typeof timer.unref === 'function') timer.unref()
  syncTimers.set(sid, timer)
  return true
}

/** 等待所有已在执行中的增量同步任务结束（测试清理用）。 */
export async function flushIncrementalSyncs() {
  for (const timer of syncTimers.values()) clearTimeout(timer)
  syncTimers.clear()
  if (syncPendingPromises.size > 0) {
    await Promise.allSettled([...syncPendingPromises])
  }
}

// ── 用户动作编排 ────────────────────────────────────────────────────

/**
 * 确认/修改一件「事」的状态、下一步、标题、目标、现状、置顶、决策或标记已核对。
 * 支持在 patch 中附带 `supersedeDecision: { oldId, decision }` 取代旧决策。
 */
export async function confirmWork(workspaceId, workId, patch = {}, options = {}) {
  const wsId = compress(workspaceId)
  const wId = compress(workId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  if (wId === '') return { ok: false, error: 'workId required', httpStatus: 400 }
  if (!isPlainObject(patch)) return { ok: false, error: 'patch must be an object', httpStatus: 400 }

  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  return mutateWorkStore(wsId, async store => {
    const exists = store.works.find(w => w.id === wId)
    if (!exists) return { ok: false, error: '事不存在', httpStatus: 404 }

    let nextStore = carryExtras(store, applyUserConfirm(store, wId, patch, now))

    // 支持取代旧决策
    if (isPlainObject(patch.supersedeDecision)) {
      const { oldId, decision } = patch.supersedeDecision
      const idx = nextStore.works.findIndex(w => w.id === wId)
      if (idx >= 0 && typeof oldId === 'string' && isPlainObject(decision)) {
        const replaced = supersedeDecision(nextStore.works[idx], oldId, {
          ...decision,
          source: 'confirmed',
          at: Number.isFinite(decision.at) ? decision.at : now,
        })
        const works = nextStore.works.slice()
        works[idx] = replaced
        nextStore = {
          ...nextStore,
          works,
          updatedAt: Math.max(nextStore.updatedAt ?? 0, now),
        }
      }
    }

    // 确认后若当前拐点正指向该事，顺手清掉轻提示
    if (nextStore.latestInflection?.workId === wId) {
      nextStore = { ...nextStore, latestInflection: null }
    }

    const work = nextStore.works.find(w => w.id === wId) ?? null
    const cards = projectResumeCards(nextStore, { now })
    return { ok: true, store: nextStore, work, cards }
  })
}

/**
 * 一键批量确认本工作区所有「未收束且待核对（reviewStatus === 'pending'）」的事：
 * 保持其当前未收束状态不变，将其状态设为已确认并标记 reviewStatus = 'reviewed' 且锁定，
 * 避免后台推断再覆盖。已收束/已退回话题/已核对的事不受影响。
 */
export async function confirmAllPendingWorks(workspaceId, options = {}) {
  const wsId = compress(workspaceId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }

  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  return mutateWorkStore(wsId, async store => {
    let nextStore = store
    let confirmedCount = 0
    const targetIds = store.works
      .filter(w => !w.dismissedAsChat && UNRESOLVED_SET.has(w.state) && w.reviewStatus === 'pending')
      .map(w => w.id)

    for (const wId of targetIds) {
      const target = nextStore.works.find(w => w.id === wId)
      if (!target) continue
      nextStore = carryExtras(
        nextStore,
        applyUserConfirm(nextStore, wId, { state: target.state, reviewStatus: 'reviewed' }, now),
      )
      confirmedCount += 1
    }

    const cards = projectResumeCards(nextStore, { now })
    return {
      ok: true,
      confirmedCount,
      store: nextStore,
      cards,
      works: nextStore.works.filter(w => !w.dismissedAsChat),
      pendingReviewCount: cards.pendingReviewCount,
    }
  })
}

/** 将误立的「事」退回无状态话题，名下段记入 dismissedSegments 防重提。 */
export async function dismissWork(workspaceId, workId, options = {}) {
  const wsId = compress(workspaceId)
  const wId = compress(workId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  if (wId === '') return { ok: false, error: 'workId required', httpStatus: 400 }

  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  return mutateWorkStore(wsId, async store => {
    if (!store.works.some(w => w.id === wId)) {
      return { ok: false, error: '事不存在', httpStatus: 404 }
    }
    let nextStore = carryExtras(store, dismissWorkAsChat(store, wId, now))
    if (nextStore.latestInflection?.workId === wId) {
      nextStore = { ...nextStore, latestInflection: null }
    }
    const cards = projectResumeCards(nextStore, { now })
    return { ok: true, store: nextStore, cards }
  })
}

/** 话题段一键升格为已确认的「事」。 */
export async function promoteSegmentToWork(workspaceId, segment, options = {}) {
  const wsId = compress(workspaceId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  if (!isPlainObject(segment)) return { ok: false, error: 'segment must be an object', httpStatus: 400 }

  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  return mutateWorkStore(wsId, async store => {
    const { store: updated, work } = convertChatSegmentToWork(store, { ...segment, workspaceId: wsId }, now)
    if (!work) return { ok: false, error: '段参数非法', httpStatus: 400 }
    const nextStore = carryExtras(store, updated)
    nextStore.initializedAt = nextStore.initializedAt ?? now
    const cards = projectResumeCards(nextStore, { now })
    return { ok: true, store: nextStore, work, cards }
  })
}

/** 人工合并两件事（sourceWorkId 吸收进 targetWorkId）。 */
export async function mergeWorkspaceWorks(workspaceId, targetWorkId, sourceWorkId, options = {}) {
  const wsId = compress(workspaceId)
  const targetId = compress(targetWorkId)
  const sourceId = compress(sourceWorkId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  if (targetId === '' || sourceId === '' || targetId === sourceId) {
    return { ok: false, error: 'targetWorkId 与 sourceWorkId 必须为不同的非空字符串', httpStatus: 400 }
  }

  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  return mutateWorkStore(wsId, async store => {
    if (!store.works.some(w => w.id === targetId) || !store.works.some(w => w.id === sourceId)) {
      return { ok: false, error: '要合并的事不存在', httpStatus: 404 }
    }
    let nextStore = carryExtras(store, mergeWorks(store, targetId, sourceId, now))
    // 同步把指向 sourceId 的 handoffLinks 迁移到 targetId
    const nextLinks = { ...nextStore.handoffLinks }
    for (const [sid, wid] of Object.entries(nextLinks)) {
      if (wid === sourceId) nextLinks[sid] = targetId
    }
    nextStore = { ...nextStore, handoffLinks: nextLinks }
    const work = nextStore.works.find(w => w.id === targetId) ?? null
    const cards = projectResumeCards(nextStore, { now })
    return { ok: true, store: nextStore, work, cards }
  })
}

/** 将挂错的一段从原事中拆出为独立新事。 */
export async function splitWorkspaceWork(workspaceId, workId, segmentId, options = {}) {
  const wsId = compress(workspaceId)
  const wId = compress(workId)
  const sId = compress(segmentId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  if (wId === '' || sId === '') return { ok: false, error: 'workId 与 segmentId 必填', httpStatus: 400 }

  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  return mutateWorkStore(wsId, async store => {
    const origin = store.works.find(w => w.id === wId)
    if (!origin) return { ok: false, error: '事不存在', httpStatus: 404 }
    if (!origin.segmentIds.includes(sId)) {
      return { ok: false, error: '该段不属于指定的事', httpStatus: 400 }
    }
    if (origin.segmentIds.length <= 1) {
      return { ok: false, error: '该事只剩唯一一段，无法继续拆出', httpStatus: 400 }
    }
    const { store: updated, work } = splitSegmentFromWork(store, wId, sId, now)
    if (!work) return { ok: false, error: '拆段失败', httpStatus: 400 }
    const nextStore = carryExtras(store, updated)
    const cards = projectResumeCards(nextStore, { now })
    return { ok: true, store: nextStore, work, cards }
  })
}

/** 忽略当前拐点轻确认条（不阻塞、不修改事状态）。 */
export async function dismissInflection(workspaceId, options = {}) {
  const wsId = compress(workspaceId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  return mutateWorkStore(wsId, async store => {
    const nextStore = {
      ...store,
      latestInflection: null,
      updatedAt: Math.max(store.updatedAt ?? 0, now),
    }
    return { ok: true, store: nextStore, dismissed: true }
  })
}

// ── 三层防失真续接与交接（ADR-0004） ────────────────────────────────

/** 收集一件「事」关联的所有轮次行（按段范围精确过滤），供硬事实提取使用。 */
async function collectWorkTurns(ctx, store, work, deps = {}) {
  const segBySession = new Map()
  for (const segId of Array.isArray(work.segmentIds) ? work.segmentIds : []) {
    const seg = store.segments?.[segId]
    if (!isPlainObject(seg) || compress(seg.sessionId) === '') continue
    const sid = compress(seg.sessionId)
    if (!segBySession.has(sid)) segBySession.set(sid, [])
    segBySession.get(sid).push(seg)
  }

  const sessionIds = uniqueStrings([
    ...(Array.isArray(work.sessionIds) ? work.sessionIds : []),
    ...segBySession.keys(),
  ])

  const collected = []
  let latestTarget = null

  for (const sid of sessionIds) {
    const rows = await loadSessionTurns(ctx, sid, deps)
    const segs = segBySession.get(sid) ?? []
    for (const row of rows) {
      let matchedSegId = ''
      if (segs.length > 0) {
        const hit = segs.find(s => Number.isInteger(s.startTurn) && Number.isInteger(s.endTurn)
          && row.turn >= s.startTurn && row.turn <= s.endTurn)
        if (!hit) continue
        matchedSegId = hit.id
      }
      const enriched = {
        ...row,
        sessionId: sid,
        segmentId: matchedSegId || undefined,
      }
      collected.push(enriched)
      const t = Number.isFinite(row.end) ? row.end : (Number.isFinite(row.start) ? row.start : 0)
      if (latestTarget === null || t > latestTarget.time || (t === latestTarget.time && row.turn >= latestTarget.turn)) {
        latestTarget = {
          sessionId: sid,
          turn: row.turn,
          seq: Number.isInteger(row.endSeq) ? row.endSeq : (Number.isInteger(row.seq) ? row.seq : null),
          time: t,
        }
      }
    }
  }

  return { turns: collected, latestTarget }
}

/**
 * 适配 work 对象给 handoff.js 渲染（handoff.js 读 status / confirmed / blocker / nextStep 等）。
 */
function toHandoffWorkView(work) {
  return {
    ...work,
    status: work.state,
    confirmed: work.stateSource === 'confirmed',
    blocker: work.state === 'blocked' ? (work.statusSummary || '') : '',
  }
}

/**
 * 准备续接 / 交接包（原会话续接 `same-session` 或新会话交接 `new-session`）。
 *
 * @param {object} ctx
 * @param {string} workspaceId
 * @param {string} workId
 * @param {'same-session'|'new-session'} mode
 * @param {object} [options] - `{ deps }`
 */
export async function prepareHandoff(ctx, workspaceId, workId, mode = 'new-session', options = {}) {
  const wsId = compress(workspaceId)
  const wId = compress(workId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  if (wId === '') return { ok: false, error: 'workId required', httpStatus: 400 }
  if (mode !== 'same-session' && mode !== 'new-session') {
    return { ok: false, error: 'mode 必须是 same-session 或 new-session', httpStatus: 400 }
  }

  const loaded = await readWorkStoreRaw(wsId)
  if (!loaded.ok) return loaded
  const work = loaded.store.works.find(w => w.id === wId)
  if (!work) return { ok: false, error: '事不存在', httpStatus: 404 }

  const deps = isPlainObject(options?.deps) ? options.deps : {}
  const { turns, latestTarget } = await collectWorkTurns(ctx, loaded.store, work, deps)
  const decisionEvidence = (Array.isArray(work.decisions) ? work.decisions : [])
    .map(d => d?.evidenceHandle)
    .filter(Boolean)
  const hardFacts = extractWorkHardFacts(turns, { decisionEvidence })
  const handoffWork = toHandoffWorkView(work)

  if (mode === 'same-session') {
    const targetSessionId = latestTarget?.sessionId ?? work.sessionIds[work.sessionIds.length - 1] ?? ''
    let drift = { drifted: false, lastSegmentTitle: '', turnsSinceWork: 0 }
    if (targetSessionId !== '') {
      const sessionRows = await loadSessionTurns(ctx, targetSessionId, deps)
      const sessionSegments = sliceSessionSegments(sessionRows, { sessionId: targetSessionId })
        .map(seg => {
          const saved = loaded.store.segments?.[seg.id]
          return saved ? { ...seg, workId: saved.workId ?? null } : seg
        })
      drift = detectSessionDrift(work, sessionSegments)
    }
    const draft = buildSameSessionDraft(handoffWork, { drifted: drift.drifted })
    return {
      ok: true,
      value: {
        mode: 'same-session',
        targetSessionId,
        targetTurn: latestTarget?.turn ?? null,
        targetSeq: latestTarget?.seq ?? null,
        drifted: drift.drifted,
        lastSegmentTitle: drift.lastSegmentTitle,
        turnsSinceWork: drift.turnsSinceWork,
        draft,
        work,
        hardFacts,
      },
    }
  }

  const workHandle = formatWorkHandle(work.id)
  const draft = buildNewSessionHandoffDraft(handoffWork, hardFacts)
  return {
    ok: true,
    value: {
      mode: 'new-session',
      workspaceId: wsId,
      draft,
      work,
      hardFacts,
      workHandle,
    },
  }
}

/**
 * 新开会话后立即写入 L1 交接血缘：记录 `handoffLinks[newSessionId] = workId`，
 * 同时把 newSessionId 挂到该事的 sessionIds 中，保证后续增量同步 100% 命中 L1。
 */
export async function bindHandoffSession(workspaceId, workId, newSessionId, options = {}) {
  const wsId = compress(workspaceId)
  const wId = compress(workId)
  const sid = compress(newSessionId)
  if (wsId === '') return { ok: false, error: 'workspaceId required', httpStatus: 400 }
  if (wId === '') return { ok: false, error: 'workId required', httpStatus: 400 }
  if (sid === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }

  const now = Number.isFinite(options?.now) ? options.now : Date.now()
  return mutateWorkStore(wsId, async store => {
    const idx = store.works.findIndex(w => w.id === wId)
    if (idx < 0) return { ok: false, error: '事不存在', httpStatus: 404 }

    const target = store.works[idx]
    const updatedWork = {
      ...target,
      sessionIds: uniqueStrings([...target.sessionIds, sid]),
      updatedAt: Math.max(target.updatedAt ?? 0, now),
    }
    const works = store.works.slice()
    works[idx] = updatedWork
    const nextStore = {
      ...store,
      works,
      handoffLinks: {
        ...(isPlainObject(store.handoffLinks) ? store.handoffLinks : {}),
        [sid]: wId,
      },
      updatedAt: Math.max(store.updatedAt ?? 0, now),
    }
    return { ok: true, store: nextStore, work: updatedWork, bound: { sessionId: sid, workId: wId } }
  })
}

// ── 事级 Wire 层展开（〔work:<workId>〕，幂等账本） ────────────────────

const workLedgerCache = new Map()
const workLedgerWriteChains = new Map()

function workLedgerPath(sessionId) {
  const dir = topicMapDir()
  if (dir === null) return null
  return join(dir, 'work-ledger', `${safeId(sessionId)}.json`)
}

function trimWorkLedger(entries) {
  const keys = Object.keys(entries)
  if (keys.length <= WORK_LEDGER_MAX) return entries
  keys.sort((a, b) => (Number(entries[b]?.at) || 0) - (Number(entries[a]?.at) || 0))
  for (const k of keys.slice(WORK_LEDGER_MAX)) delete entries[k]
  return entries
}

async function loadWorkLedger(sessionId) {
  const path = workLedgerPath(sessionId)
  if (path === null) return {}
  const cached = workLedgerCache.get(path)
  if (cached !== undefined) return cached
  const entries = {}
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    if (isPlainObject(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        if (isPlainObject(v)) entries[k] = v
      }
    }
  } catch {
    // 缺失或损坏按空账本处理
  }
  trimWorkLedger(entries)
  workLedgerCache.set(path, entries)
  return entries
}

async function recordWorkInjection(sessionId, workId, chars) {
  const sid = compress(sessionId)
  if (sid === '') return
  const path = workLedgerPath(sid)
  if (path === null) return
  const entries = await loadWorkLedger(sid)
  entries[workId] = { at: Date.now(), chars }
  trimWorkLedger(entries)

  const prev = workLedgerWriteChains.get(path) ?? Promise.resolve()
  const next = prev.then(async () => {
    try {
      await writeWorkStoreAtomic(path, entries)
    } catch {
      // 落盘失败不影响本次内存幂等
    }
  })
  workLedgerWriteChains.set(path, next)
  await next
}

/**
 * 识别文本中的事级句柄 `〔work:<workId>〕`，按会话幂等去重，
 * 拉取对应事的硬事实并用 `renderWorkContextForAgent` 渲染结构化现场，
 * 供 `system-prompt/assemble` 注入 `{ name: 'topic-map:事续接现场', text, interpolate: false }`。
 *
 * @param {object} ctx - Host context。
 * @param {string} workspaceId - 当前工作区 ID。
 * @param {string|string[]} texts - 当前待发送/最近用户消息文本。
 * @param {string} sessionId - 当前会话 ID（用于幂等防重复注入与串台检测）。
 * @param {object} [options] - `{ maxCount, maxChars, deps }`。
 * @returns {Promise<string>} 渲染后的事级上下文文本，无可展开内容时返回空串。
 */
export async function expandWorkHandlesForAgent(ctx, workspaceId, texts, sessionId, options = {}) {
  const wsId = compress(workspaceId)
  const sid = compress(sessionId)
  const opts = isPlainObject(options) ? options : {}
  const maxCount = Number.isInteger(opts.maxCount) && opts.maxCount > 0 ? opts.maxCount : 2
  const allIds = extractWorkHandles(texts, { maxCount: 50 })
  if (allIds.length === 0 || wsId === '') return ''

  const ledger = sid === '' ? {} : await loadWorkLedger(sid)
  const pendingIds = allIds.filter(id => !Object.prototype.hasOwnProperty.call(ledger, id))
  if (pendingIds.length === 0) return ''

  const loaded = await readWorkStoreRaw(wsId)
  if (!loaded.ok) return ''

  const deps = isPlainObject(opts.deps) ? opts.deps : {}
  const blocks = []

  for (const workId of pendingIds) {
    if (blocks.length >= maxCount) break
    const work = loaded.store.works.find(w => w.id === workId)
    if (!work) continue
    const { turns } = await collectWorkTurns(ctx, loaded.store, work, deps)
    const decisionEvidence = (Array.isArray(work.decisions) ? work.decisions : [])
      .map(d => d?.evidenceHandle)
      .filter(Boolean)
    const hardFacts = extractWorkHardFacts(turns, { decisionEvidence })

    // 若当前就在该事的原会话里，顺便检测末尾是否已串台
    let drift = null
    if (sid !== '' && Array.isArray(work.sessionIds) && work.sessionIds.includes(sid)) {
      const sessionRows = await loadSessionTurns(ctx, sid, deps)
      const sessionSegments = sliceSessionSegments(sessionRows, { sessionId: sid })
        .map(seg => {
          const saved = loaded.store.segments?.[seg.id]
          return saved ? { ...seg, workId: saved.workId ?? null } : seg
        })
      drift = detectSessionDrift(work, sessionSegments)
    }

    const rendered = renderWorkContextForAgent(toHandoffWorkView(work), hardFacts, {
      maxChars: opts.maxChars,
      drift,
    })
    if (rendered === '') continue
    blocks.push(rendered)
    await recordWorkInjection(sid, workId, rendered.length)
  }

  return blocks.join('\n\n')
}
