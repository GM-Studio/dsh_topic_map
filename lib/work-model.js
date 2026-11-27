/**
 * 「事（Work）」核心域模型、状态机、决策演化、沉降、拐点检测与双表分离。
 *
 * 遵循 GLOSSARY.md 与 ADR 0001 / 0002 / 0003：
 * - 纯函数模块：不 import 外部模块、不碰文件系统、不读 DOM、不读系统时钟（所有时间由调用方传入），
 *   所有写操作返回新对象，不修改入参。
 * - 事的生命周期四态：active / blocked / done / shelved；未收束仅指 active / blocked。
 * - 双态可信度：inferred（推测态）与 confirmed（已确认态）；用户确认并锁定后，后台推断永不覆盖。
 * - 决策是一等但按需累积的事件（允许 decisions: []），支持 supersede 取代关系。
 * - 话题 ↔ 事 一键互转，并维护 dismissedSegments 防止系统反复重提。
 * - 沉降仅作用于超时且仍为推测态、未置顶的未收束事；重聊时自动浮回 active。
 *
 * @module dsh-topic-map/work-model
 */

/** 事的生命周期四态：进行中 / 卡住 / 已完成 / 已搁置。 */
export const WORK_STATES = Object.freeze(['active', 'blocked', 'done', 'shelved'])

/** 未收束状态：续接屏仅对未收束的事负责。 */
export const UNRESOLVED_STATES = Object.freeze(['active', 'blocked'])

/** 状态与字段的可信度：推测态 / 已确认态。 */
export const WORK_CONFIDENCE = Object.freeze(['inferred', 'confirmed'])

/** 默认无活动沉降天数（GLOSSARY / ADR-0003）。 */
export const DEFAULT_DORMANT_DAYS = 14

/** 判定“隔了一段时间重返未收束会话”的默认间隔（4 小时）。 */
export const DEFAULT_REVISIT_GAP_MS = 4 * 60 * 60 * 1000

const STORE_VERSION = 1
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const VALID_STATE_SET = new Set(WORK_STATES)
const UNRESOLVED_STATE_SET = new Set(UNRESOLVED_STATES)
const CONFIDENCE_SET = new Set(WORK_CONFIDENCE)
const REVIEW_STATUS_SET = new Set(['pending', 'reviewed'])
const DECISION_STATUS_SET = new Set(['active', 'superseded'])

const FAIL_END_REASONS = new Set(['error', 'failed', 'blocked', 'aborted', 'interrupted', 'max-tokens', 'max-turns'])

const SETTLED_CUE_RE = /(?:好了|搞定|完成了?|已修复|全部.*通过|测试通过|可以提交|先这样|收尾了|done|all tests pass)/i
const BLOCKED_CUE_RE = /(?:报错|失败|卡住|超时|异常|无法继续|阻塞|econnrefused|enoent|typeerror|referenceerror|syntaxerror|error:|failed)/i

const STATE_LABELS = Object.freeze({
  active: '进行中',
  blocked: '卡住',
  done: '已完成',
  shelved: '已搁置',
})

// ── 内部工具（纯函数） ─────────────────────────────────────────────

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toText(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function compress(value) {
  return toText(value).replace(/\s+/g, ' ').trim()
}

function toTimestamp(value, fallback = 0) {
  if (value instanceof Date) {
    const ms = value.getTime()
    return Number.isFinite(ms) ? ms : fallback
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return fallback
}

function uniqueStrings(list) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const text = compress(item)
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function stableId(prefix, seed) {
  const code = (fnv1a(String(seed)) % (36 ** 6)).toString(36).padStart(6, '0')
  return `${prefix}-${code}`
}

function freeId(existingIds, prefix, seed) {
  const taken = new Set(existingIds)
  for (let salt = 0; salt < 64; salt += 1) {
    const id = salt === 0 ? stableId(prefix, seed) : stableId(prefix, `${seed}#${salt}`)
    if (!taken.has(id)) return id
  }
  return stableId(prefix, `${seed}#overflow`)
}

function normalizeState(value, fallback = 'active') {
  return typeof value === 'string' && VALID_STATE_SET.has(value) ? value : fallback
}

function normalizeConfidence(value, fallback = 'inferred') {
  return typeof value === 'string' && CONFIDENCE_SET.has(value) ? value : fallback
}

function normalizeReviewStatus(value, fallback = 'pending') {
  return typeof value === 'string' && REVIEW_STATUS_SET.has(value) ? value : fallback
}

function normalizeDecision(raw, fallbackAt = 0, existingIds = []) {
  if (!isPlainObject(raw)) return null
  const summary = compress(raw.summary)
  if (summary === '') return null
  const at = toTimestamp(raw.at, fallbackAt)
  const rawId = compress(raw.id)
  const id = rawId !== '' ? rawId : freeId(existingIds, 'd', `${summary}\u0000${raw.evidenceHandle ?? ''}\u0000${at}`)
  const status = typeof raw.status === 'string' && DECISION_STATUS_SET.has(raw.status) ? raw.status : 'active'
  const supersededBy = status === 'superseded' ? (compress(raw.supersededBy) || null) : null
  return {
    id,
    summary,
    rationale: compress(raw.rationale),
    status,
    supersededBy,
    evidenceHandle: compress(raw.evidenceHandle),
    source: normalizeConfidence(raw.source, 'inferred'),
    at,
  }
}

function cloneDecision(dec) {
  return {
    id: dec.id,
    summary: dec.summary,
    rationale: dec.rationale,
    status: dec.status,
    supersededBy: dec.supersededBy ?? null,
    evidenceHandle: dec.evidenceHandle,
    source: dec.source,
    at: dec.at,
  }
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isPlainObject(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = cloneValue(v)
    return out
  }
  return value
}

function collectSegmentFiles(segment) {
  if (!isPlainObject(segment)) return []
  return uniqueStrings([
    ...(Array.isArray(segment.files) ? segment.files : []),
    ...(Array.isArray(segment.changedFiles) ? segment.changedFiles : []),
  ])
}

function collectSegmentHandles(segment) {
  if (!isPlainObject(segment)) return []
  return uniqueStrings([
    ...(Array.isArray(segment.evidenceHandles) ? segment.evidenceHandles : []),
    ...(typeof segment.evidenceHandle === 'string' ? [segment.evidenceHandle] : []),
  ])
}

function startOfLocalDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function formatDate(ms) {
  const date = new Date(ms)
  const y = String(date.getFullYear()).padStart(4, '0')
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatRelativeTime(time, now) {
  const target = toTimestamp(time, NaN)
  const base = toTimestamp(now, NaN)
  if (!Number.isFinite(target) || !Number.isFinite(base)) return ''
  const diff = base - target
  if (diff < 0) return startOfLocalDay(target) === startOfLocalDay(base) ? '今天' : formatDate(target)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  const days = Math.round((startOfLocalDay(base) - startOfLocalDay(target)) / DAY)
  if (new Date(target).getFullYear() !== new Date(base).getFullYear()) return formatDate(target)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return formatDate(target)
}

function normalizeWork(raw, fallbackWorkspaceId = '', fallbackNow = 0) {
  const src = isPlainObject(raw) ? raw : {}
  const createdAt = toTimestamp(src.createdAt, fallbackNow)
  const updatedAt = toTimestamp(src.updatedAt, createdAt)
  const lastActivityAt = toTimestamp(src.lastActivityAt, updatedAt)
  const lastInflectionAt = src.lastInflectionAt === null || src.lastInflectionAt === undefined
    ? null
    : toTimestamp(src.lastInflectionAt, null)

  const title = compress(src.title) || '未命名工作'
  const workspaceId = compress(src.workspaceId) || compress(fallbackWorkspaceId)
  const rawId = compress(src.id)
  const id = rawId !== '' ? rawId : stableId('w', `${workspaceId}\u0000${title}\u0000${createdAt}`)

  const decisions = []
  const decIds = []
  for (const item of Array.isArray(src.decisions) ? src.decisions : []) {
    const dec = normalizeDecision(item, updatedAt, decIds)
    if (!dec) continue
    if (decIds.includes(dec.id)) continue
    decIds.push(dec.id)
    decisions.push(dec)
  }

  const evidenceHandles = uniqueStrings([
    ...(Array.isArray(src.evidenceHandles) ? src.evidenceHandles : []),
    ...decisions.map(d => d.evidenceHandle),
  ])

  const confirmedFields = uniqueStrings(src.confirmedFields)
  const work = {
    id,
    workspaceId,
    title,
    goal: compress(src.goal),
    state: normalizeState(src.state, 'active'),
    stateSource: normalizeConfidence(src.stateSource, 'inferred'),
    pinned: src.pinned === true,
    statusSummary: compress(src.statusSummary),
    nextStep: compress(src.nextStep),
    nextStepSource: normalizeConfidence(src.nextStepSource, 'inferred'),
    segmentIds: uniqueStrings(src.segmentIds),
    sessionIds: uniqueStrings(src.sessionIds),
    files: uniqueStrings(src.files),
    decisions,
    evidenceHandles,
    createdAt,
    updatedAt,
    lastActivityAt,
    lastInflectionAt,
    reviewStatus: normalizeReviewStatus(src.reviewStatus, 'pending'),
    dismissedAsChat: src.dismissedAsChat === true,
    reopenedFromId: compress(src.reopenedFromId) || null,
  }
  if (confirmedFields.length > 0) work.confirmedFields = confirmedFields
  return work
}

function normalizeStore(store, fallbackWorkspaceId = '') {
  if (!isPlainObject(store)) return emptyWorkStore(fallbackWorkspaceId)
  const workspaceId = compress(store.workspaceId) || compress(fallbackWorkspaceId)
  const seenWork = new Set()
  const works = []
  for (const raw of Array.isArray(store.works) ? store.works : []) {
    if (!isPlainObject(raw)) continue
    const w = normalizeWork(raw, workspaceId, toTimestamp(store.updatedAt, 0))
    if (seenWork.has(w.id)) continue
    seenWork.add(w.id)
    works.push(w)
  }
  const segments = {}
  if (isPlainObject(store.segments)) {
    for (const [segId, rawSeg] of Object.entries(store.segments)) {
      const key = compress(segId)
      if (key === '' || !isPlainObject(rawSeg)) continue
      segments[key] = cloneValue(rawSeg)
    }
  }
  const dismissedSegments = {}
  if (isPlainObject(store.dismissedSegments)) {
    for (const [segId, meta] of Object.entries(store.dismissedSegments)) {
      const key = compress(segId)
      if (key === '') continue
      dismissedSegments[key] = isPlainObject(meta) ? cloneValue(meta) : { at: toTimestamp(meta, 0) }
    }
  }
  return {
    version: STORE_VERSION,
    workspaceId,
    initializedAt: store.initializedAt === null || store.initializedAt === undefined
      ? null
      : toTimestamp(store.initializedAt, null),
    works,
    segments,
    dismissedSegments,
    lockedWorkIds: uniqueStrings(store.lockedWorkIds),
    updatedAt: toTimestamp(store.updatedAt, 0),
  }
}

function isFieldConfirmed(work, field) {
  if (field === 'state') return work.stateSource === 'confirmed'
  if (field === 'nextStep') return work.nextStepSource === 'confirmed'
  return Array.isArray(work.confirmedFields) && work.confirmedFields.includes(field)
}

function addConfirmedFields(work, fields) {
  const merged = uniqueStrings([...(Array.isArray(work.confirmedFields) ? work.confirmedFields : []), ...fields])
  if (merged.length > 0) work.confirmedFields = merged
}

function mergeDecisionsPreservingConfirmed(existing, incoming, now) {
  const confirmedById = new Map()
  const ordered = []
  const seen = new Set()

  for (const d of Array.isArray(existing) ? existing : []) {
    const cloned = cloneDecision(d)
    if (cloned.source === 'confirmed') confirmedById.set(cloned.id, cloned)
    ordered.push(cloned)
    seen.add(cloned.id)
  }

  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const dec = normalizeDecision(raw, now, [...seen])
    if (!dec) continue
    if (confirmedById.has(dec.id)) continue
    if (seen.has(dec.id)) {
      const idx = ordered.findIndex(item => item.id === dec.id)
      if (idx >= 0 && ordered[idx].source !== 'confirmed') {
        ordered[idx] = { ...dec, source: 'inferred' }
      }
      continue
    }
    seen.add(dec.id)
    ordered.push({ ...dec, source: 'inferred' })
  }

  return ordered
}

// ── 公开 API：Store 与 Work 构造 ───────────────────────────────────

/**
 * 新建空的工作区「事」存储（双表分离：物化事与段 + 锁定/忽略元数据）。
 *
 * @param {string} [workspaceId] - 工作区标识。
 * @returns {object} 版本 1 的空 store。
 */
export function emptyWorkStore(workspaceId = '') {
  return {
    version: STORE_VERSION,
    workspaceId: compress(workspaceId),
    initializedAt: null,
    works: [],
    segments: {},
    dismissedSegments: {},
    lockedWorkIds: [],
    updatedAt: 0,
  }
}

/**
 * 构造一件标准「事（Work）」对象（遵循 GLOSSARY / ADR 0001~0003）。
 *
 * @param {object} input - 初始字段。
 * @param {number} [now=0] - 当前时间戳（epoch ms）。
 * @returns {object} 归一化后的 Work 对象。
 */
export function createWork(input, now = 0) {
  const ts = toTimestamp(now, 0)
  return normalizeWork(input, input?.workspaceId ?? '', ts)
}

// ── 公开 API：决策管理（ADR-0002） ─────────────────────────────────

/**
 * 为一件「事」追加一条决策（返回新 Work，不修改入参）。
 *
 * @param {object} work - 目标事。
 * @param {object} decision - 决策字段。
 * @returns {object} 新 Work。
 */
export function addDecision(work, decision) {
  const base = normalizeWork(work)
  const existingIds = base.decisions.map(d => d.id)
  const dec = normalizeDecision(decision, base.updatedAt, existingIds)
  if (!dec) return base

  const nextDecisions = base.decisions.some(d => d.id === dec.id)
    ? base.decisions.map(d => (d.id === dec.id ? dec : cloneDecision(d)))
    : [...base.decisions.map(cloneDecision), dec]

  const nextUpdated = Math.max(base.updatedAt, dec.at)
  return {
    ...base,
    decisions: nextDecisions,
    evidenceHandles: uniqueStrings([...base.evidenceHandles, dec.evidenceHandle]),
    updatedAt: nextUpdated,
  }
}

/**
 * 用新决策取代旧决策（旧决策置为 superseded 并记录 supersededBy）。
 * 若找不到 oldId，保持原状不抛错。
 *
 * @param {object} work - 目标事。
 * @param {string} oldId - 被取代的旧决策 id。
 * @param {object} newDecision - 取代它的新决策。
 * @returns {object} 新 Work。
 */
export function supersedeDecision(work, oldId, newDecision) {
  const base = normalizeWork(work)
  const targetId = compress(oldId)
  if (targetId === '') return base
  const idx = base.decisions.findIndex(d => d.id === targetId)
  if (idx < 0) return base

  const existingIds = base.decisions.map(d => d.id)
  const nextDec = normalizeDecision(
    { ...(isPlainObject(newDecision) ? newDecision : {}), status: 'active', supersededBy: null },
    base.updatedAt,
    existingIds,
  )
  if (!nextDec || nextDec.id === targetId) return base

  const nextDecisions = base.decisions.map(d => {
    if (d.id !== targetId) return cloneDecision(d)
    return {
      ...cloneDecision(d),
      status: 'superseded',
      supersededBy: nextDec.id,
    }
  })

  if (nextDecisions.some(d => d.id === nextDec.id)) {
    const dupIdx = nextDecisions.findIndex(d => d.id === nextDec.id)
    nextDecisions[dupIdx] = nextDec
  } else {
    nextDecisions.push(nextDec)
  }

  return {
    ...base,
    decisions: nextDecisions,
    evidenceHandles: uniqueStrings([...base.evidenceHandles, nextDec.evidenceHandle]),
    updatedAt: Math.max(base.updatedAt, nextDec.at),
  }
}

/** 返回当前仍生效（active）的决策列表。 */
export function activeDecisions(work) {
  const list = Array.isArray(work?.decisions) ? work.decisions : []
  return list.filter(d => isPlainObject(d) && d.status === 'active').map(cloneDecision)
}

/** 返回已被取代（superseded）的决策列表。 */
export function supersededDecisions(work) {
  const list = Array.isArray(work?.decisions) ? work.decisions : []
  return list.filter(d => isPlainObject(d) && d.status === 'superseded').map(cloneDecision)
}

// ── 公开 API：双态写入与不可覆盖铁律（ADR-0003） ───────────────────

/**
 * 用户确认某件事的状态 / 下一步 / 置顶 / 标题 / 目标 / 现状 / 决策。
 * 被用户点名修改或确认的字段全部转为 confirmed，并记入 lockedWorkIds。
 *
 * @param {object} store - 当前 store。
 * @param {string} workId - 目标事 id。
 * @param {object} patch - 用户确认的字段补丁。
 * @param {number} [now=0] - 当前时间戳。
 * @returns {object} 新 store。
 */
export function applyUserConfirm(store, workId, patch = {}, now = 0) {
  const base = normalizeStore(store)
  const id = compress(workId)
  const idx = base.works.findIndex(w => w.id === id)
  if (idx < 0 || !isPlainObject(patch)) return base

  const ts = toTimestamp(now, base.updatedAt)
  const current = base.works[idx]
  const next = normalizeWork(current, base.workspaceId, ts)
  const lockedFields = []

  if (patch.state !== undefined && VALID_STATE_SET.has(patch.state)) {
    next.state = patch.state
    next.stateSource = 'confirmed'
  }
  if (patch.nextStep !== undefined && typeof patch.nextStep === 'string') {
    next.nextStep = compress(patch.nextStep)
    next.nextStepSource = 'confirmed'
  }
  if (patch.pinned !== undefined) {
    next.pinned = patch.pinned === true
    lockedFields.push('pinned')
  }
  if (typeof patch.title === 'string' && compress(patch.title) !== '') {
    next.title = compress(patch.title)
    lockedFields.push('title')
  }
  if (typeof patch.goal === 'string') {
    next.goal = compress(patch.goal)
    lockedFields.push('goal')
  }
  if (typeof patch.statusSummary === 'string') {
    next.statusSummary = compress(patch.statusSummary)
    lockedFields.push('statusSummary')
  }
  if (Array.isArray(patch.decisions)) {
    const existingIds = []
    const confirmedDecisions = []
    for (const raw of patch.decisions) {
      const dec = normalizeDecision({ ...(isPlainObject(raw) ? raw : {}), source: 'confirmed' }, ts, existingIds)
      if (!dec || existingIds.includes(dec.id)) continue
      existingIds.push(dec.id)
      confirmedDecisions.push(dec)
    }
    next.decisions = confirmedDecisions
    next.evidenceHandles = uniqueStrings([...next.evidenceHandles, ...confirmedDecisions.map(d => d.evidenceHandle)])
    lockedFields.push('decisions')
  } else if (isPlainObject(patch.addDecision)) {
    const withDec = addDecision(next, { ...patch.addDecision, source: 'confirmed', at: toTimestamp(patch.addDecision.at, ts) })
    next.decisions = withDec.decisions
    next.evidenceHandles = withDec.evidenceHandles
  }
  if (patch.lastInflectionAt !== undefined) {
    next.lastInflectionAt = patch.lastInflectionAt === null ? null : toTimestamp(patch.lastInflectionAt, ts)
  }

  addConfirmedFields(next, lockedFields)
  next.reviewStatus = 'reviewed'
  next.updatedAt = Math.max(next.updatedAt, ts)

  const works = base.works.slice()
  works[idx] = next
  return {
    ...base,
    works,
    lockedWorkIds: uniqueStrings([...base.lockedWorkIds, id]),
    updatedAt: Math.max(base.updatedAt, ts),
  }
}

/**
 * 后台推断更新一件「事」：
 * - 只更新仍为 inferred（未被用户确认）的字段；
 * - 对已确认为 done / shelved 或已退回话题的事，绝不做任何篡改。
 *
 * @param {object} store - 当前 store。
 * @param {string} workId - 目标事 id。
 * @param {object} patch - 后台推断字段。
 * @param {number} [now=0] - 当前时间戳。
 * @returns {object} 新 store。
 */
export function applyInferredUpdate(store, workId, patch = {}, now = 0) {
  const base = normalizeStore(store)
  const id = compress(workId)
  const idx = base.works.findIndex(w => w.id === id)
  if (idx < 0 || !isPlainObject(patch)) return base

  const current = base.works[idx]
  // 铁律：已退回话题，或已确认为 done/shelved 的老事，绝不允许后台推断静默篡改
  if (current.dismissedAsChat) return base
  if (current.stateSource === 'confirmed' && (current.state === 'done' || current.state === 'shelved')) {
    return base
  }

  const ts = toTimestamp(now, base.updatedAt)
  const next = normalizeWork(current, base.workspaceId, ts)

  if (patch.state !== undefined && VALID_STATE_SET.has(patch.state) && !isFieldConfirmed(next, 'state')) {
    next.state = patch.state
    next.stateSource = 'inferred'
  }
  if (typeof patch.nextStep === 'string' && !isFieldConfirmed(next, 'nextStep')) {
    next.nextStep = compress(patch.nextStep)
    next.nextStepSource = 'inferred'
  }
  if (typeof patch.title === 'string' && compress(patch.title) !== '' && !isFieldConfirmed(next, 'title')) {
    next.title = compress(patch.title)
  }
  if (typeof patch.goal === 'string' && !isFieldConfirmed(next, 'goal')) {
    next.goal = compress(patch.goal)
  }
  if (typeof patch.statusSummary === 'string' && !isFieldConfirmed(next, 'statusSummary')) {
    next.statusSummary = compress(patch.statusSummary)
  }
  if (Array.isArray(patch.segmentIds)) {
    next.segmentIds = uniqueStrings([...next.segmentIds, ...patch.segmentIds])
  }
  if (Array.isArray(patch.sessionIds)) {
    next.sessionIds = uniqueStrings([...next.sessionIds, ...patch.sessionIds])
  }
  if (Array.isArray(patch.files)) {
    next.files = uniqueStrings([...next.files, ...patch.files])
  }
  if (Array.isArray(patch.evidenceHandles)) {
    next.evidenceHandles = uniqueStrings([...next.evidenceHandles, ...patch.evidenceHandles])
  }
  if (Array.isArray(patch.decisions)) {
    next.decisions = mergeDecisionsPreservingConfirmed(next.decisions, patch.decisions, ts)
    next.evidenceHandles = uniqueStrings([...next.evidenceHandles, ...next.decisions.map(d => d.evidenceHandle)])
  }
  if (patch.lastActivityAt !== undefined) {
    next.lastActivityAt = Math.max(next.lastActivityAt, toTimestamp(patch.lastActivityAt, next.lastActivityAt))
  }
  next.updatedAt = Math.max(next.updatedAt, ts)

  const works = base.works.slice()
  works[idx] = next
  return {
    ...base,
    works,
    updatedAt: Math.max(base.updatedAt, ts),
  }
}

// ── 公开 API：话题 ↔ 事 一键互转 ───────────────────────────────────

/**
 * 将一段日常交流「话题」一键升格为一件已确认的「事」，
 * 同步解除该段在 dismissedSegments 中的忽略记录。
 *
 * @param {object} store - 当前 store。
 * @param {object} segment - 目标段对象。
 * @param {number} [now=0] - 当前时间戳。
 * @returns {{ store: object, work: object|null }}
 */
export function convertChatSegmentToWork(store, segment, now = 0) {
  const base = normalizeStore(store)
  if (!isPlainObject(segment)) return { store: base, work: null }

  const ts = toTimestamp(now, base.updatedAt)
  const segId = compress(segment.id ?? segment.segmentId) || freeId(Object.keys(base.segments), 'seg', `${segment.sessionId ?? ''}\u0000${segment.title ?? ''}\u0000${ts}`)
  const title = compress(segment.title) || '未命名工作'
  const workId = freeId(base.works.map(w => w.id), 'w', `${base.workspaceId}\u0000${segId}\u0000${title}`)
  const sessionId = compress(segment.sessionId)
  const lastActivityAt = toTimestamp(segment.lastActivityAt ?? segment.endedAt ?? segment.startedAt, ts)

  const work = createWork({
    id: workId,
    workspaceId: base.workspaceId || compress(segment.workspaceId),
    title,
    goal: compress(segment.goal ?? segment.summary),
    state: 'active',
    stateSource: 'confirmed',
    pinned: false,
    statusSummary: compress(segment.statusSummary ?? segment.summary),
    nextStep: compress(segment.nextStep),
    nextStepSource: compress(segment.nextStep) !== '' ? 'confirmed' : 'inferred',
    segmentIds: [segId],
    sessionIds: sessionId ? [sessionId] : [],
    files: collectSegmentFiles(segment),
    decisions: [],
    evidenceHandles: collectSegmentHandles(segment),
    createdAt: ts,
    updatedAt: ts,
    lastActivityAt,
    lastInflectionAt: null,
    reviewStatus: 'reviewed',
    dismissedAsChat: false,
    reopenedFromId: null,
  }, ts)

  const segments = { ...base.segments }
  segments[segId] = {
    ...cloneValue(segment),
    id: segId,
    workId,
    locked: true,
  }

  const dismissedSegments = { ...base.dismissedSegments }
  delete dismissedSegments[segId]

  const nextStore = {
    ...base,
    works: [...base.works, work],
    segments,
    dismissedSegments,
    lockedWorkIds: uniqueStrings([...base.lockedWorkIds, workId]),
    updatedAt: Math.max(base.updatedAt, ts),
  }
  return { store: nextStore, work }
}

/**
 * 将一件被误立的「事」退回无状态「话题」，并把其名下所有段写入 dismissedSegments，
 * 防止后台推断或后续增量匹配反复重提。
 *
 * @param {object} store - 当前 store。
 * @param {string} workId - 要退回的事 id。
 * @param {number} [now=0] - 当前时间戳。
 * @returns {object} 新 store。
 */
export function dismissWorkAsChat(store, workId, now = 0) {
  const base = normalizeStore(store)
  const id = compress(workId)
  const idx = base.works.findIndex(w => w.id === id)
  if (idx < 0) return base

  const ts = toTimestamp(now, base.updatedAt)
  const target = base.works[idx]
  const nextWork = {
    ...normalizeWork(target, base.workspaceId, ts),
    dismissedAsChat: true,
    reviewStatus: 'reviewed',
    updatedAt: Math.max(target.updatedAt, ts),
  }

  const dismissedSegments = { ...base.dismissedSegments }
  const segments = { ...base.segments }
  for (const segId of target.segmentIds) {
    dismissedSegments[segId] = { at: ts, fromWorkId: id }
    if (isPlainObject(segments[segId])) {
      segments[segId] = { ...segments[segId], workId: null, locked: true }
    }
  }

  const works = base.works.slice()
  works[idx] = nextWork
  return {
    ...base,
    works,
    segments,
    dismissedSegments,
    lockedWorkIds: uniqueStrings([...base.lockedWorkIds, id]),
    updatedAt: Math.max(base.updatedAt, ts),
  }
}

// ── 公开 API：合并与拆段 ───────────────────────────────────────────

/**
 * 人工一键合并两件事：把 sourceWorkId 吸收进 targetWorkId，
 * 去重段/会话/文件/决策/证据，并锁定目标事与迁移段的归属。
 *
 * @param {object} store - 当前 store。
 * @param {string} targetWorkId - 保留的目标事 id。
 * @param {string} sourceWorkId - 被合并的来源事 id。
 * @param {number} [now=0] - 当前时间戳。
 * @returns {object} 新 store。
 */
export function mergeWorks(store, targetWorkId, sourceWorkId, now = 0) {
  const base = normalizeStore(store)
  const targetId = compress(targetWorkId)
  const sourceId = compress(sourceWorkId)
  if (targetId === '' || sourceId === '' || targetId === sourceId) return base

  const target = base.works.find(w => w.id === targetId)
  const source = base.works.find(w => w.id === sourceId)
  if (!target || !source) return base

  const ts = toTimestamp(now, base.updatedAt)
  const decisionMap = new Map()
  for (const d of [...target.decisions, ...source.decisions]) {
    if (!decisionMap.has(d.id)) decisionMap.set(d.id, cloneDecision(d))
  }

  const merged = normalizeWork({
    ...target,
    goal: target.goal || source.goal,
    statusSummary: target.statusSummary || source.statusSummary,
    nextStep: target.nextStep || source.nextStep,
    pinned: target.pinned || source.pinned,
    segmentIds: uniqueStrings([...target.segmentIds, ...source.segmentIds]),
    sessionIds: uniqueStrings([...target.sessionIds, ...source.sessionIds]),
    files: uniqueStrings([...target.files, ...source.files]),
    decisions: [...decisionMap.values()],
    evidenceHandles: uniqueStrings([...target.evidenceHandles, ...source.evidenceHandles]),
    createdAt: Math.min(target.createdAt, source.createdAt),
    updatedAt: Math.max(target.updatedAt, source.updatedAt, ts),
    lastActivityAt: Math.max(target.lastActivityAt, source.lastActivityAt),
    reviewStatus: 'reviewed',
  }, base.workspaceId, ts)

  const segments = { ...base.segments }
  for (const segId of merged.segmentIds) {
    if (isPlainObject(segments[segId])) {
      segments[segId] = { ...segments[segId], workId: targetId, locked: true }
    }
  }

  const works = base.works
    .filter(w => w.id !== sourceId)
    .map(w => (w.id === targetId ? merged : w))

  const lockedWorkIds = uniqueStrings([
    ...base.lockedWorkIds.filter(id => id !== sourceId),
    targetId,
  ])

  return {
    ...base,
    works,
    segments,
    lockedWorkIds,
    updatedAt: Math.max(base.updatedAt, ts),
  }
}

/**
 * 将挂错的一段从原事中拆出为独立新事，并同时锁定原事、新事与该段的归属。
 *
 * @param {object} store - 当前 store。
 * @param {string} workId - 原事 id。
 * @param {string} segmentId - 要拆出的段 id。
 * @param {number} [now=0] - 当前时间戳。
 * @returns {{ store: object, work: object|null }}
 */
export function splitSegmentFromWork(store, workId, segmentId, now = 0) {
  const base = normalizeStore(store)
  const wId = compress(workId)
  const sId = compress(segmentId)
  const idx = base.works.findIndex(w => w.id === wId)
  if (idx < 0 || sId === '') return { store: base, work: null }

  const origin = base.works[idx]
  if (!origin.segmentIds.includes(sId) || origin.segmentIds.length <= 1) return { store: base, work: null }

  const ts = toTimestamp(now, base.updatedAt)
  const seg = isPlainObject(base.segments[sId]) ? base.segments[sId] : { id: sId, title: `拆分自 ${origin.title}` }
  const remainSegIds = origin.segmentIds.filter(id => id !== sId)

  // 根据剩余段重算原事的 sessionIds 与 files（若段表完整则精确收缩）
  const remainSegObjs = remainSegIds.map(id => base.segments[id]).filter(isPlainObject)
  const remainSessionIds = remainSegObjs.length > 0
    ? uniqueStrings(remainSegObjs.map(s => s.sessionId))
    : origin.sessionIds
  const remainFiles = remainSegObjs.length > 0
    ? uniqueStrings(remainSegObjs.flatMap(collectSegmentFiles))
    : origin.files

  const updatedOrigin = normalizeWork({
    ...origin,
    segmentIds: remainSegIds,
    sessionIds: remainSessionIds,
    files: remainFiles,
    reviewStatus: 'reviewed',
    updatedAt: Math.max(origin.updatedAt, ts),
  }, base.workspaceId, ts)

  const newWorkId = freeId(base.works.map(w => w.id), 'w', `${base.workspaceId}\u0000split\u0000${sId}`)
  const segSessionId = compress(seg.sessionId)
  const newWork = createWork({
    id: newWorkId,
    workspaceId: base.workspaceId,
    title: compress(seg.title) || `拆分自 ${origin.title}`,
    goal: compress(seg.goal ?? seg.summary),
    state: 'active',
    stateSource: 'confirmed',
    pinned: false,
    statusSummary: compress(seg.statusSummary ?? seg.summary),
    nextStep: compress(seg.nextStep),
    nextStepSource: 'inferred',
    segmentIds: [sId],
    sessionIds: segSessionId ? [segSessionId] : [],
    files: collectSegmentFiles(seg),
    decisions: [],
    evidenceHandles: collectSegmentHandles(seg),
    createdAt: ts,
    updatedAt: ts,
    lastActivityAt: toTimestamp(seg.lastActivityAt ?? seg.endedAt ?? seg.startedAt, ts),
    lastInflectionAt: null,
    reviewStatus: 'reviewed',
    dismissedAsChat: false,
    reopenedFromId: null,
  }, ts)

  const segments = { ...base.segments }
  segments[sId] = { ...cloneValue(seg), id: sId, workId: newWorkId, locked: true }

  const works = base.works.slice()
  works[idx] = updatedOrigin
  works.push(newWork)

  return {
    store: {
      ...base,
      works,
      segments,
      lockedWorkIds: uniqueStrings([...base.lockedWorkIds, wId, newWorkId]),
      updatedAt: Math.max(base.updatedAt, ts),
    },
    work: newWork,
  }
}

// ── 公开 API：沉降与唤醒（ADR-0003） ───────────────────────────────

/**
 * 自动沉降：超过 dormantDays（<=0 表示永不自动沉降）无活动的
 * **推测态、未置顶、未收束**的事自动转入 shelved；已确认或置顶的事不沉降。
 *
 * @param {object} store - 当前 store。
 * @param {{ now: number, dormantDays?: number }} options - 参照时间与天数阈值。
 * @returns {object} 新 store。
 */
export function applyDormancySettlement(store, options = {}) {
  const base = normalizeStore(store)
  const opts = isPlainObject(options) ? options : {}
  const dormantDays = opts.dormantDays === undefined ? DEFAULT_DORMANT_DAYS : Number(opts.dormantDays)
  if (!Number.isFinite(dormantDays) || dormantDays <= 0) return base

  const now = toTimestamp(opts.now, NaN)
  if (!Number.isFinite(now)) return base

  const thresholdMs = dormantDays * DAY
  let changed = false
  const works = base.works.map(w => {
    if (w.dismissedAsChat) return w
    if (!UNRESOLVED_STATE_SET.has(w.state)) return w
    if (w.stateSource === 'confirmed' || w.pinned) return w
    if (now - w.lastActivityAt <= thresholdMs) return w
    changed = true
    return {
      ...w,
      state: 'shelved',
      updatedAt: Math.max(w.updatedAt, now),
    }
  })

  if (!changed) return base
  return {
    ...base,
    works,
    updatedAt: Math.max(base.updatedAt, now),
  }
}

/**
 * 重聊唤醒：已沉降（shelved）的事有新活动时自动浮回 active，并刷新 lastActivityAt。
 * 已确认为 done 的老事绝不被静默唤醒改状态。
 *
 * @param {object} store - 当前 store。
 * @param {string} workId - 事 id。
 * @param {number} [now=0] - 当前时间戳。
 * @returns {object} 新 store。
 */
export function wakeWorkOnActivity(store, workId, now = 0) {
  const base = normalizeStore(store)
  const id = compress(workId)
  const idx = base.works.findIndex(w => w.id === id)
  if (idx < 0) return base

  const current = base.works[idx]
  if (current.dismissedAsChat) return base
  if (current.state === 'done' && current.stateSource === 'confirmed') return base

  const ts = toTimestamp(now, base.updatedAt)
  const next = { ...current }
  if (next.state === 'shelved') {
    next.state = 'active'
  }
  next.lastActivityAt = Math.max(next.lastActivityAt, ts)
  next.updatedAt = Math.max(next.updatedAt, ts)

  const works = base.works.slice()
  works[idx] = next
  return {
    ...base,
    works,
    updatedAt: Math.max(base.updatedAt, ts),
  }
}

// ── 公开 API：三类自然拐点识别（ADR-0003） ─────────────────────────

/**
 * 识别适合弹出非阻塞轻确认条的三类自然拐点：
 * 1. topic_switch：会话从 A 事切到 B 事；
 * 2. likely_settled_or_blocked：疑似收尾或报错/中断卡住；
 * 3. revisit_unresolved：隔了一段时间重返未收束会话。
 *
 * 返回非阻塞轻确认提示数据或 null。
 *
 * @param {{ prevSegment?: object, currSegment?: object, work?: object, lastTurn?: object, gapMs?: number, revisitGapMs?: number }} ctx
 * @returns {object|null}
 */
export function detectInflection(ctx = {}) {
  if (!isPlainObject(ctx)) return null
  const { prevSegment, currSegment, work, lastTurn, gapMs } = ctx
  const revisitGapMs = Number.isFinite(ctx.revisitGapMs) && ctx.revisitGapMs > 0
    ? ctx.revisitGapMs
    : DEFAULT_REVISIT_GAP_MS

  const workId = compress(work?.id ?? prevSegment?.workId ?? currSegment?.workId)
  const workTitle = compress(work?.title ?? prevSegment?.title ?? currSegment?.title) || '当前工作'
  const workState = normalizeState(work?.state, 'active')
  const workConfirmed = work?.stateSource === 'confirmed'
  const isUnresolved = UNRESOLVED_STATE_SET.has(workState)

  // 已确认收束（done/shelved）的事不再发拐点打扰
  if (workConfirmed && !isUnresolved) return null

  // 1. 切换话题：上一段和当前段分属不同事（或上一段挂着未收束的事，当前段切出）
  const prevWorkId = compress(prevSegment?.workId)
  const currWorkId = compress(currSegment?.workId)
  if (prevSegment && currSegment && prevWorkId !== '' && prevWorkId !== currWorkId) {
    return {
      kind: 'topic_switch',
      workId: prevWorkId,
      title: compress(work?.id === prevWorkId ? work.title : prevSegment.title) || workTitle,
      suggestedState: 'done',
      prompt: `刚刚切离了「${compress(work?.id === prevWorkId ? work.title : prevSegment.title) || workTitle}」，这件事现在什么状态？`,
      actions: [
        { id: 'confirm_done', label: '已完成', state: 'done' },
        { id: 'keep_active', label: '仍在进行中', state: 'active' },
        { id: 'mark_shelved', label: '先搁置', state: 'shelved' },
      ],
    }
  }

  // 2. 疑似收尾或报错中断卡住
  if (isPlainObject(lastTurn)) {
    const endReason = compress(lastTurn.endReason).toLowerCase()
    const hasError = lastTurn.hasError === true
      || (typeof lastTurn.error === 'string' && lastTurn.error.trim() !== '')
      || FAIL_END_REASONS.has(endReason)
    const turnText = `${toText(lastTurn.prompt)} ${toText(lastTurn.response)}`

    if (hasError || (endReason !== 'stop' && BLOCKED_CUE_RE.test(turnText))) {
      return {
        kind: 'likely_settled_or_blocked',
        workId,
        title: workTitle,
        suggestedState: 'blocked',
        prompt: `「${workTitle}」刚才出现异常或中断，是否标记为卡住？`,
        actions: [
          { id: 'confirm_blocked', label: '标记卡住', state: 'blocked' },
          { id: 'keep_active', label: '继续进行中', state: 'active' },
        ],
      }
    }

    if (SETTLED_CUE_RE.test(turnText)) {
      return {
        kind: 'likely_settled_or_blocked',
        workId,
        title: workTitle,
        suggestedState: 'done',
        prompt: `「${workTitle}」看起来已经收尾，是否标记为已完成？`,
        actions: [
          { id: 'confirm_done', label: '标记已完成', state: 'done' },
          { id: 'keep_active', label: '还没完', state: 'active' },
        ],
      }
    }
  }

  // 3. 隔了一段时间重返未收束会话
  if (isUnresolved && Number.isFinite(gapMs) && gapMs >= revisitGapMs) {
    return {
      kind: 'revisit_unresolved',
      workId,
      title: workTitle,
      suggestedState: workState,
      prompt: `回到未收束的「${workTitle}」，是否仍按当前状态继续？`,
      actions: [
        { id: 'confirm_continue', label: '确认继续', state: workState },
        { id: 'confirm_done', label: '其实已做完', state: 'done' },
        { id: 'mark_shelved', label: '先搁置', state: 'shelved' },
      ],
    }
  }

  return null
}

// ── 公开 API：360px 窄抽屉 4 行卡片投影（ADR-0001 / 0002） ─────────

function cardActionsFor(work) {
  const isUnresolved = UNRESOLVED_STATE_SET.has(work.state)
  if (isUnresolved) {
    return [
      { id: 'resume', label: '回到上次现场' },
      { id: 'handoff', label: '新开交接' },
      { id: 'confirm_done', label: '已完成' },
    ]
  }
  return [
    { id: 'reopen', label: '重新打开' },
    { id: 'inspect', label: '查看详情' },
  ]
}

function toCardView(work, now) {
  return {
    id: work.id,
    title: work.title,
    state: work.state,
    stateLabel: STATE_LABELS[work.state] ?? work.state,
    confidence: work.stateSource,
    pinned: work.pinned,
    reviewStatus: work.reviewStatus,
    // 4 行窄卡片内容：第 1 行 标题与状态 / 第 2 行 当前卡点或现状 / 第 3 行 唯一一步 / 第 4 行 动作条
    statusLine: work.statusSummary || work.goal || '',
    nextStep: work.nextStep || '',
    nextStepConfidence: work.nextStepSource,
    sessionCount: work.sessionIds.length,
    segmentCount: work.segmentIds.length,
    decisionCount: work.decisions.length,
    lastActivityAt: work.lastActivityAt,
    relativeTime: formatRelativeTime(work.lastActivityAt, now),
    actions: cardActionsFor(work),
  }
}

/**
 * 投影给 360px 窄抽屉的 4 行卡片视图模型：
 * - 未收束优先（pinned 最前，其次 blocked 优先于 active，再按 lastActivityAt 倒序）；
 * - done / shelved 折叠在底部 settled 组；
 * - dismissedAsChat 不再出现在续接屏；
 * - 统计待核对计数 pendingReviewCount。
 *
 * @param {object} store - 当前 store。
 * @param {{ now?: number }} [options] - 参照时间。
 * @returns {{ unresolved: object[], settled: object[], settledCollapsedByDefault: boolean, pendingReviewCount: number }}
 */
export function projectResumeCards(store, options = {}) {
  const base = normalizeStore(store)
  const opts = isPlainObject(options) ? options : {}
  const now = toTimestamp(opts.now, base.updatedAt)

  const visible = base.works.filter(w => !w.dismissedAsChat)

  const unresolvedWorks = visible
    .filter(w => UNRESOLVED_STATE_SET.has(w.state))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      const aBlocked = a.state === 'blocked' ? 1 : 0
      const bBlocked = b.state === 'blocked' ? 1 : 0
      if (aBlocked !== bBlocked) return bBlocked - aBlocked
      if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt
      return a.id.localeCompare(b.id)
    })

  // 待核对计数只统计「未收束」且仍为 pending 的事，绝不把已沉降/已收束算进去
  const pendingReviewCount = unresolvedWorks.filter(w => w.reviewStatus === 'pending').length

  const settledWorks = visible
    .filter(w => !UNRESOLVED_STATE_SET.has(w.state))
    .sort((a, b) => {
      if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt
      return a.id.localeCompare(b.id)
    })

  return {
    unresolved: unresolvedWorks.map(w => toCardView(w, now)),
    settled: settledWorks.map(w => toCardView(w, now)),
    settledCollapsedByDefault: true,
    pendingReviewCount,
  }
}
