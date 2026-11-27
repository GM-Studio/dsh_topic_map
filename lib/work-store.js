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
  isAutomatedSession,
  sliceSessionSegments,
} from './segment.js'
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
const COLD_START_MODEL_MAX_TOKENS = 4096
const INCREMENTAL_MODEL_MAX_TOKENS = 512
const MODEL_TIMEOUT_MS = 25_000

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

async function listWorkspaceSessionMetas(ctx, workspaceId, deps = {}) {
  if (typeof deps.listWorkspaceSessions === 'function') {
    const items = await deps.listWorkspaceSessions(ctx, workspaceId)
    return Array.isArray(items) ? items : []
  }

  const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  const workspaces = typeof registry?.list === 'function' ? registry.list() : []
  const ws = workspaces.find(w => String(w?.id ?? '') === workspaceId) ?? (workspaceId ? null : workspaces[0] ?? null)
  const sessionIds = Array.isArray(ws?.sessionIds) ? ws.sessionIds.map(String) : []

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

async function callSemanticModel(ctx, prompt, options = {}) {
  const deps = isPlainObject(options.deps) ? options.deps : {}
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : MODEL_TIMEOUT_MS
  const controller = typeof AbortController === 'function' ? new AbortController() : null

  const runCall = async () => {
    if (typeof deps.askModel === 'function') {
      return deps.askModel(ctx, prompt, { ...options, signal: controller?.signal })
    }

    const config = isPlainObject(options.config) ? options.config : {}
    const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : COLD_START_MODEL_MAX_TOKENS

    if (hasCustomEndpoint(config)) {
      return await callRemote({ fetch }, config, prompt.system, prompt.user, {
        maxTokens,
        timeoutMs,
        signal: controller?.signal,
        sessionId: options.sessionId,
      })
    }
    const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm
    if (llm === undefined || llm === null) return null

    let route = null
    if (typeof deps.resolveRoute === 'function') {
      route = await deps.resolveRoute(ctx, config, options.sessionIds ?? [])
    } else if (config.provider && config.model) {
      route = { provider: config.provider, model: config.model }
    }
    return await askOnce(llm, route, prompt.system, prompt.user, controller?.signal, {
      maxTokens,
      sessionId: options.sessionId,
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
              mode: undefined,
              dormantDays,
            })
          } catch {
            // 后台精化失败静默降级，保留硬信号盘点结果
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

  for (const meta of metas) {
    const sessionId = compress(meta.sessionId)
    if (sessionId === '') continue
    const turns = await loadSessionTurns(ctx, sessionId, deps)
    const firstPrompt = turns.length > 0 ? String(turns[0]?.prompt ?? '') : ''
    if (isAutomatedSession({
      ...meta.header,
      ...meta,
      turns,
      firstPrompt,
    })) {
      continue
    }

    activeSessionIds.push(sessionId)
    const forkParent = meta.forkParent ?? extractForkParent(meta.header)
    if (forkParent) {
      forkEdges.push({ childSessionId: sessionId, parentSessionId: forkParent })
    }

    const rawSegments = sliceSessionSegments(turns, { sessionId, forkParent })
    for (const seg of rawSegments) {
      const turnsInSeg = turns.filter(t => t.turn >= seg.startTurn && t.turn <= seg.endTurn)
      const adapted = adaptSegment(seg, turnsInSeg, wsId, {
        forkParent,
        handoffWorkId: handoffLinks[sessionId] ?? null,
      })
      allSegments.push(adapted)
      segmentsById.set(adapted.id, adapted)
    }
  }

  // 2) 零模型硬信号预聚类
  const plan = planColdStartWorks(allSegments, {
    workspaceId: wsId,
    forkEdges,
    now,
    dormantDays,
    dismissedSegments: initialRead.store.dismissedSegments,
  })

  // 3) 可选模型语义精化（失败安全降级）
  let candidateWorks = plan.works
  let semanticUsed = false
  if (useModel && plan.clusters.length > 0) {
    try {
      const prompt = buildColdStartSemanticPrompt(plan.clusters, allSegments)
      const text = await callSemanticModel(ctx, prompt, {
        config: opts.config,
        deps,
        maxTokens: COLD_START_MODEL_MAX_TOKENS,
        timeoutMs: opts.modelTimeoutMs,
        sessionIds: activeSessionIds,
      })
      if (typeof text === 'string' && text.trim() !== '') {
        const refined = parseColdStartSemanticResult(text, plan.clusters)
        if (!refined.fallback) {
          candidateWorks = buildWorksFromColdStartRefinement(refined, plan.clusters, segmentsById, wsId, now)
          semanticUsed = true
        }
      }
    } catch {
      // 安全降级回硬信号聚类结果
      semanticUsed = false
    }
  }

  const segmentsRecord = {}
  for (const seg of allSegments) {
    segmentsRecord[seg.id] = seg
  }

  // 4) 在串行锁内重读最新 store，保护扫描期间产生的人工确认/锁定数据，合并并应用沉降后落盘
  return mutateWorkStore(wsId, async latestStore => {
    const merged = mergeScannedWithExisting(latestStore, candidateWorks, segmentsRecord, now)
    const settled = carryExtras(
      merged,
      applyDormancySettlement(merged, { now, dormantDays }),
    )
    const preliminaryStore = {
      ...settled,
      initializedAt: latestStore.initializedAt ?? now,
      semanticRefinedAt: semanticUsed ? now : latestStore.semanticRefinedAt,
      updatedAt: Math.max(settled.updatedAt ?? 0, now),
    }
    const cards = projectResumeCards(preliminaryStore, { now })
    const stats = {
      sessionsScanned: activeSessionIds.length,
      segmentsCount: allSegments.length,
      unresolvedCount: cards.unresolved.length,
      settledCount: cards.settled.length,
      semanticUsed,
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
      semanticUsed,
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
        } catch {
          // 后台精化失败静默降级，保留 L0 硬信号结果
        } finally {
          backgroundRefineInFlight.delete(wsId)
        }
      })
    }
  }

  return {
    ok: true,
    initialized: true,
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
  const turns = await loadSessionTurns(ctx, sid, deps)
  const firstPrompt = turns.length > 0 ? String(turns[0]?.prompt ?? '') : ''
  if (isAutomatedSession({ ...header, sessionId: sid, turns, firstPrompt })) {
    return { ok: true, skipped: true, reason: 'automated_session' }
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
  if (preMatch.action === 'need_semantic' && opts.useModel !== false) {
    try {
      const prompt = buildIncrementalMatchPrompt(latestSeg, preMatch.candidates)
      const text = await callSemanticModel(ctx, prompt, {
        config: opts.config,
        deps,
        maxTokens: INCREMENTAL_MODEL_MAX_TOKENS,
        sessionId: sid,
        sessionIds: [sid],
      })
      if (typeof text === 'string' && text.trim() !== '') {
        l3Decision = parseIncrementalMatchResult(text, preMatch.candidates)
      }
    } catch {
      l3Decision = null
    }
  }

  const dormantDays = opts.dormantDays === undefined
    ? (Number.isFinite(opts.config?.dormantDays) ? opts.config.dormantDays : DEFAULT_DORMANT_DAYS)
    : Number(opts.dormantDays)

  // 在工作区串行锁内重读、重判并落盘
  return mutateWorkStore(wsId, async store => {
    const curHandoffWorkId = store.handoffLinks?.[sid] ?? handoffWorkId ?? null
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

    nextStore = carryExtras(
      nextStore,
      applyDormancySettlement(nextStore, { now, dormantDays }),
    )
    nextStore.initializedAt = nextStore.initializedAt ?? now
    const cards = projectResumeCards(nextStore, { now })
    return {
      ok: true,
      store: nextStore,
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
