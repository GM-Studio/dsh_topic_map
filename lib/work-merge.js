/**
 * 存量一次性冷启动盘点 + 日常增量三级匹配引擎（ADR-0003）。
 *
 * 设计铁律：
 * 1. 纯函数、无 I/O、不读时钟、不改入参；
 * 2. 存量冷启动先做零模型硬信号预聚类（fork 血缘、〔8hex#N〕引用句柄互指、
 *    时间窗内非通用业务文件高重叠），再提供一次语义精化 prompt/parser（解析失败安全降级）；
 * 3. 日常增量严格走三级管道：L1 硬血缘 → L2 业务文件重叠 → L3 同工作区未收束事语义候选（≤10）；
 * 4. 三条防污染红线：
 *    - 子代理/自动化会话默认排除在自动立事之外；
 *    - 命中已确认 done 的老事绝不自动改写，返回 suggest_reopen 轻提示；
 *    - 通用配置文件（package.json / README.md / lockfile 等）单独共享绝不触发误合并。
 *
 * @module dsh-topic-map/work-merge
 */

import {
  DEFAULT_DORMANT_DAYS,
  UNRESOLVED_STATES,
  WORK_STATES,
  createWork,
} from './work-model.js'
import { suggestNextStep } from './next-step.js'

const DAY = 24 * 60 * 60 * 1000

/** 默认文件硬信号聚类的最大时间间隔（14 天）。 */
export const DEFAULT_FILE_WINDOW_DAYS = 14

/** L3 增量语义匹配最多送给模型的未收束候选事数量（ADR-0003）。 */
export const MAX_SEMANTIC_CANDIDATES = 10

/**
 * 主线聚合的会话内合并间隔（ADR-0007）。
 *
 * 同一会话内相邻两段若间隔小于它，视为**同一条主线**的连续推进，合并立一条事；
 * 超过它才认为是「隔了一段时间回来又干」的转折，允许拆成两条。
 *
 * 取 45 分钟与切段的硬断点阈值一致：切段时因长间隔切开的段，
 * 在这里不应该又被悄悄并回去 —— 否则「切段」与「立事」两处口径互相打脸。
 */
export const DEFAULT_MAINLINE_MERGE_GAP_MS = 45 * 60 * 1000

/** 通用配置文件集合（小写 basename）：单独重叠极易造成跨事误连，排除在文件硬连之外。 */
export const GENERIC_CONFIG_FILES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'readme.md',
  'changelog.md',
  'license',
  'license.md',
  '.gitignore',
  '.npmrc',
  '.editorconfig',
  'tsconfig.json',
  'jsconfig.json',
  'agents.md',
  'claude.md',
])

const UNRESOLVED_SET = new Set(UNRESOLVED_STATES)
const VALID_STATE_SET = new Set(WORK_STATES)
const FAIL_END_REASONS = new Set(['error', 'failed', 'blocked', 'aborted', 'interrupted', 'max-tokens', 'max-turns'])

/** 轮次引用句柄正则：兼容带 〔〕 括号的 〔8hex#N〕 与裸 8hex#N。 */
const BRACKET_HANDLE_RE = /〔([0-9a-fA-F]{8})#(\d+)〕/g
const BARE_HANDLE_RE = /\b([0-9a-fA-F]{8})#(\d+)\b/g

// ── 内部工具 ───────────────────────────────────────────────────────

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

function clip(value, max) {
  const text = compress(value)
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
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

function shortSessionPrefix(sessionId) {
  const raw = compress(sessionId)
  if (raw === '') return ''
  return raw.replace(/^session[-_:]/i, '').slice(0, 8).toLowerCase()
}

function normalizePath(filePath) {
  const raw = compress(filePath).replace(/\\/g, '/').replace(/^\.\//, '')
  return raw.toLowerCase()
}

function baseNameOf(normPath) {
  const idx = normPath.lastIndexOf('/')
  return idx >= 0 ? normPath.slice(idx + 1) : normPath
}

function isGenericConfigFile(filePath) {
  const norm = normalizePath(filePath)
  if (norm === '') return true
  return GENERIC_CONFIG_FILES.has(baseNameOf(norm))
}

function segmentIdOf(seg, fallbackIndex = 0) {
  return compress(seg?.id ?? seg?.segmentId) || `seg-${fallbackIndex}`
}

function segmentTimeOf(seg) {
  return toTimestamp(
    seg?.lastActivityAt ?? seg?.endedAt ?? seg?.endTime ?? seg?.startedAt ?? seg?.startTime,
    0,
  )
}

function isSubagentOrAutomated(seg) {
  if (!isPlainObject(seg)) return true
  if (seg.isSubagent === true || seg.subagent === true) return true
  if (seg.isAutomated === true || seg.automated === true) return true
  const role = compress(seg.sessionRole ?? seg.sessionKind ?? seg.origin).toLowerCase()
  return role === 'subagent' || role === 'automated' || role === 'scheduled' || role === 'cron'
}

/** 提取段里用于文件硬匹配的业务文件（优先 changedFiles，排除通用配置文件）。 */
function significantChangedFilesOf(seg) {
  if (!isPlainObject(seg)) return []
  const raw = Array.isArray(seg.changedFiles) && seg.changedFiles.length > 0
    ? seg.changedFiles
    : (Array.isArray(seg.files) ? seg.files : [])
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const norm = normalizePath(typeof item === 'string' ? item : item?.path)
    if (norm === '' || isGenericConfigFile(norm) || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

function allFilesOf(seg) {
  if (!isPlainObject(seg)) return []
  return uniqueStrings([
    ...(Array.isArray(seg.files) ? seg.files : []),
    ...(Array.isArray(seg.changedFiles) ? seg.changedFiles.map(f => (typeof f === 'string' ? f : f?.path)) : []),
  ])
}

function significantFilesOfWork(work) {
  if (!isPlainObject(work)) return []
  const seen = new Set()
  const out = []
  for (const f of Array.isArray(work.files) ? work.files : []) {
    const norm = normalizePath(f)
    if (norm === '' || isGenericConfigFile(norm) || seen.has(norm)) continue
    seen.add(norm)
    out.push(norm)
  }
  return out
}

/** 计算两个业务文件集合的重叠度（Jaccard 与较小集合覆盖率）。 */
function fileOverlapMetrics(filesA, filesB) {
  if (filesA.length === 0 || filesB.length === 0) {
    return { sharedCount: 0, jaccard: 0, containment: 0, shared: [] }
  }
  const setB = new Set(filesB)
  const shared = filesA.filter(f => setB.has(f))
  const sharedCount = shared.length
  if (sharedCount === 0) return { sharedCount: 0, jaccard: 0, containment: 0, shared: [] }
  const union = filesA.length + filesB.length - sharedCount
  const minLen = Math.min(filesA.length, filesB.length)
  return {
    sharedCount,
    jaccard: sharedCount / Math.max(1, union),
    containment: sharedCount / Math.max(1, minLen),
    shared,
  }
}

function isStrongFileOverlap(metrics) {
  if (metrics.sharedCount >= 2 && (metrics.jaccard >= 0.3 || metrics.containment >= 0.5)) return true
  if (metrics.sharedCount === 1 && (metrics.jaccard >= 0.5 || metrics.containment >= 1)) return true
  return false
}

/** 并查集，带连接原因记录。 */
class DisjointSet {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, i) => i)
    this.reasons = Array.from({ length: size }, () => new Set())
  }

  find(x) {
    let root = x
    while (this.parent[root] !== root) root = this.parent[root]
    let cur = x
    while (this.parent[cur] !== root) {
      const next = this.parent[cur]
      this.parent[cur] = root
      cur = next
    }
    return root
  }

  union(a, b, reason) {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) {
      if (reason) this.reasons[ra].add(reason)
      return
    }
    const keep = Math.min(ra, rb)
    const drop = Math.max(ra, rb)
    this.parent[drop] = keep
    for (const r of this.reasons[drop]) this.reasons[keep].add(r)
    if (reason) this.reasons[keep].add(reason)
  }
}

function extractJsonObject(text) {
  const cleaned = String(text ?? '').replace(/```[a-zA-Z]*\n?/g, '')
  const starts = []
  const ends = []
  for (let i = 0; i < cleaned.length; i += 1) {
    if (cleaned[i] === '{') starts.push(i)
    else if (cleaned[i] === '}') ends.push(i)
  }
  if (starts.length === 0 || ends.length === 0) return null

  // 从最外层最靠后的候选对象尝试解析，避免误抽到嵌套子对象
  for (let si = 0; si < starts.length; si += 1) {
    const from = starts[si]
    for (let ei = ends.length - 1; ei >= 0; ei -= 1) {
      const to = ends[ei]
      if (to <= from) continue
      try {
        const parsed = JSON.parse(cleaned.slice(from, to + 1))
        if (isPlainObject(parsed)) return parsed
      } catch {
        // 继续尝试其他跨度
      }
    }
  }
  return null
}

// ── 公开 API：轮次引用句柄提取 ─────────────────────────────────────

/**
 * 从段文本、显式引用句柄数组及轮次内容中提取去重后的 〔8hex#N〕 轮次句柄。
 *
 * @param {object} segment - 段对象。
 * @returns {Array<{ handle: string, sessionPrefix: string, turn: number }>}
 */
export function extractTurnHandlesFromSegment(segment) {
  if (!isPlainObject(segment)) return []
  const out = []
  const seen = new Set()

  const scan = (text, allowBare = false) => {
    if (typeof text !== 'string' || text === '') return
    const re = new RegExp(allowBare ? BARE_HANDLE_RE.source : BRACKET_HANDLE_RE.source, 'g')
    let match
    while ((match = re.exec(text)) !== null) {
      const sessionPrefix = match[1].toLowerCase()
      const turn = Number(match[2])
      if (!Number.isInteger(turn) || turn < 0) continue
      const handle = `${sessionPrefix}#${turn}`
      if (seen.has(handle)) continue
      seen.add(handle)
      out.push({ handle, sessionPrefix, turn })
    }
  }

  scan(segment.title)
  scan(segment.summary)
  scan(segment.text)
  scan(segment.goal)
  scan(segment.nextStep)

  for (const h of Array.isArray(segment.referencedHandles) ? segment.referencedHandles : []) {
    scan(h, true)
  }
  for (const h of Array.isArray(segment.handles) ? segment.handles : []) {
    scan(h, true)
  }
  for (const h of Array.isArray(segment.quoteHandles) ? segment.quoteHandles : []) {
    scan(h, true)
  }
  for (const t of Array.isArray(segment.turns) ? segment.turns : []) {
    if (!isPlainObject(t)) continue
    scan(t.prompt)
    scan(t.response)
    scan(t.text)
  }
  return out
}

// ── 公开 API：存量冷启动盘点（ADR-0003） ───────────────────────────

function hasSegmentError(seg) {
  if (seg?.hasError === true) return true
  if (Array.isArray(seg?.errorTurns) && seg.errorTurns.length > 0) return true
  return FAIL_END_REASONS.has(compress(seg?.endReason).toLowerCase())
}

function segmentTurnRangeOf(seg) {
  if (Array.isArray(seg?.turnRange) && seg.turnRange.length >= 2) {
    const a = Number(seg.turnRange[0])
    const b = Number(seg.turnRange[1])
    if (Number.isFinite(a) && Number.isFinite(b)) return [a, b]
  }
  const s = Number(seg?.startTurn)
  const e = Number(seg?.endTurn)
  if (Number.isFinite(s) && Number.isFinite(e)) return [s, e]
  return null
}

function hasWorkHardEvidence(seg) {
  if (significantChangedFilesOf(seg).length > 0) return true
  if (Array.isArray(seg.changedFiles) && seg.changedFiles.length > 0) return true
  if (seg.hasMutatingTools === true || hasSegmentError(seg)) return true
  return false
}

function classifyClusterInitial(segs, { now, dormantDays }) {
  const hasWorkSignal = segs.some(s => {
    const kind = compress(s.kindCandidate).toLowerCase()
    if (kind === 'work') return true
    if (kind === 'chat') return false
    return hasWorkHardEvidence(s)
  })
  if (!hasWorkSignal) {
    return { bucket: 'chat', state: null }
  }

  const ordered = [...segs].sort((a, b) => segmentTimeOf(a) - segmentTimeOf(b))
  const latest = ordered[ordered.length - 1]
  const lastActivityAt = Math.max(...ordered.map(segmentTimeOf))

  const isBlocked = hasSegmentError(latest)
  const isDone = latest.settled === true || compress(latest.stateCandidate).toLowerCase() === 'done'

  if (isBlocked) return { bucket: 'unresolved', state: 'blocked' }
  if (isDone) return { bucket: 'settled', state: 'done' }

  if (Number.isFinite(dormantDays) && dormantDays > 0 && Number.isFinite(now) && now > 0) {
    if (now - lastActivityAt > dormantDays * DAY) {
      return { bucket: 'settled', state: 'shelved' }
    }
  }
  return { bucket: 'unresolved', state: 'active' }
}

/**
 * 存量一次性冷启动盘点：
 * - 第一步（零模型硬信号预聚类）：fork 血缘 + 引用句柄互指 + 窗口内非通用业务文件重叠；
 * - 第二步：按 kindCandidate 与硬证据初分未收束候选「事」/ 已收尾历史「事」/ 纯「话题」；
 *   所有产出的事一律标记 stateSource: 'inferred' 与 reviewStatus: 'pending'。
 *
 * @param {object[]} segments - 全工作区段列表。
 * @param {object} [options] - workspaceId / forkEdges / now / dormantDays / fileWindowDays / dismissedSegments。
 * @returns {{ clusters: object[], works: object[], unresolvedWorks: object[], settledWorks: object[], chatTopics: object[], ignoredSegments: string[] }}
 */
export function planColdStartWorks(segments, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const workspaceId = compress(opts.workspaceId)
  const now = toTimestamp(opts.now, 0)
  const dormantDays = opts.dormantDays === undefined ? DEFAULT_DORMANT_DAYS : Number(opts.dormantDays)
  const fileWindowDays = Number.isFinite(opts.fileWindowDays) && opts.fileWindowDays > 0
    ? Number(opts.fileWindowDays)
    : DEFAULT_FILE_WINDOW_DAYS
  const fileWindowMs = fileWindowDays * DAY
  const dismissedMap = isPlainObject(opts.dismissedSegments) ? opts.dismissedSegments : {}

  // ADR-0007：默认按「会话主线」聚合（1 会话 ≈ 1 条主线），
  // 'boundary' 保留旧的段级聚类作为对照口径。
  const strategy = opts.strategy === 'boundary' ? 'boundary' : 'mainline'
  const mainlineGapMs = Number.isFinite(opts.mainlineGapMs) && opts.mainlineGapMs > 0
    ? opts.mainlineGapMs
    : DEFAULT_MAINLINE_MERGE_GAP_MS

  const rawList = Array.isArray(segments) ? segments.filter(isPlainObject) : []
  const eligible = []
  const ignoredSegments = []

  for (let i = 0; i < rawList.length; i += 1) {
    const seg = rawList[i]
    const id = segmentIdOf(seg, i)
    if (isSubagentOrAutomated(seg) || Object.prototype.hasOwnProperty.call(dismissedMap, id)) {
      ignoredSegments.push(id)
      continue
    }
    eligible.push({ ...seg, id })
  }

  const n = eligible.length
  const dsu = new DisjointSet(n)

  const bySession = new Map()
  const byPrefix = new Map()
  const sigFilesList = eligible.map(significantChangedFilesOf)
  const times = eligible.map(segmentTimeOf)

  for (let i = 0; i < n; i += 1) {
    const sid = compress(eligible[i].sessionId)
    if (sid !== '') {
      if (!bySession.has(sid)) bySession.set(sid, [])
      bySession.get(sid).push(i)
      const prefix = shortSessionPrefix(sid)
      if (prefix !== '') {
        if (!byPrefix.has(prefix)) byPrefix.set(prefix, [])
        byPrefix.get(prefix).push(i)
      }
    }
  }

  // 信号 0（仅 mainline）：同一会话内、间隔小于 mainlineGapMs 的相邻段并成同一条主线。
  //
  // 这是 ADR-0007 的核心反转：旧逻辑自底向上把段当独立候选、再靠相似度猜着并；
  // 新逻辑自顶向下认定「一个会话就是一条主线」，只有在客观长间隔或人类显式转折处
  // （后者已由 sliceSessionSegments 的 mainline 策略切好）才允许断开。
  if (strategy === 'mainline') {
    for (const [, indices] of bySession.entries()) {
      const ordered = indices.slice().sort((a, b) => segmentTimeOf(eligible[a]) - segmentTimeOf(eligible[b]))
      for (let k = 1; k < ordered.length; k += 1) {
        const prevT = segmentTimeOf(eligible[ordered[k - 1]])
        const curT = segmentTimeOf(eligible[ordered[k]])
        const gap = prevT > 0 && curT > 0 ? Math.abs(curT - prevT) : 0
        if (gap < mainlineGapMs) dsu.union(ordered[k - 1], ordered[k], 'mainline')
      }
    }
  }

  // 信号 1：fork 血缘直连（父会话末段 ↔ 子会话首段）
  for (const edge of Array.isArray(opts.forkEdges) ? opts.forkEdges : []) {
    if (!isPlainObject(edge)) continue
    const childId = compress(edge.childSessionId)
    const parentId = compress(edge.parentSessionId)
    if (childId === '' || parentId === '') continue
    const childIndices = bySession.get(childId) ?? []
    const parentIndices = bySession.get(parentId) ?? []
    if (childIndices.length === 0 || parentIndices.length === 0) continue
    const parentAnchor = parentIndices[parentIndices.length - 1]
    const childAnchor = childIndices[0]
    dsu.union(parentAnchor, childAnchor, 'fork')
  }

  // 信号 2：段内引用句柄 〔8hex#N〕 互指直连
  for (let i = 0; i < n; i += 1) {
    const handles = extractTurnHandlesFromSegment(eligible[i])
    for (const h of handles) {
      const targets = byPrefix.get(h.sessionPrefix) ?? []
      for (const j of targets) {
        if (j === i) continue
        const targetSeg = eligible[j]
        const range = segmentTurnRangeOf(targetSeg)
        if (range && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
          if (h.turn < range[0] || h.turn > range[1]) continue
        }
        dsu.union(i, j, 'handle')
      }
    }
  }

  // 信号 3：时间窗内（默认 14 天）非通用业务 changedFiles 高重叠聚类
  for (let i = 0; i < n; i += 1) {
    if (sigFilesList[i].length === 0) continue
    for (let j = i + 1; j < n; j += 1) {
      if (sigFilesList[j].length === 0) continue
      if (times[i] > 0 && times[j] > 0 && Math.abs(times[i] - times[j]) > fileWindowMs) continue
      const metrics = fileOverlapMetrics(sigFilesList[i], sigFilesList[j])
      if (isStrongFileOverlap(metrics)) {
        dsu.union(i, j, 'files')
      }
    }
  }

  const groups = new Map()
  for (let i = 0; i < n; i += 1) {
    const root = dsu.find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(i)
  }

  const clusters = []
  const works = []
  const unresolvedWorks = []
  const settledWorks = []
  const chatTopics = []

  let clusterSeq = 1
  for (const [root, indices] of groups.entries()) {
    const segs = indices.map(i => eligible[i]).sort((a, b) => segmentTimeOf(a) - segmentTimeOf(b))
    const clusterId = `cl-${clusterSeq}`
    clusterSeq += 1

    const reasons = [...dsu.reasons[root]]
    const segmentIds = segs.map(s => s.id)
    const sessionIds = uniqueStrings(segs.map(s => s.sessionId))
    const files = uniqueStrings(segs.flatMap(allFilesOf))
    const evidenceHandles = uniqueStrings(segs.flatMap(s => [
      ...(Array.isArray(s.evidenceHandles) ? s.evidenceHandles : []),
      ...(typeof s.evidenceHandle === 'string' ? [s.evidenceHandle] : []),
    ]))
    const createdAt = Math.min(...segs.map(s => toTimestamp(s.startedAt ?? s.startTime ?? s.lastActivityAt ?? s.endTime, now)))
    const lastActivityAt = Math.max(...segs.map(segmentTimeOf))
    const latest = segs[segs.length - 1]
    const first = segs[0]
    const title = compress(first.title) || compress(latest.title) || '未命名工作'

    const { bucket, state } = classifyClusterInitial(segs, { now, dormantDays })

    // 「待确认」是一等信号（ADR-0007）：取本簇内**最近一次**仍停等人回复的段。
    // 段的 awaiting 由 work-store 用真实轮次算好（detectAwaitingHuman），
    // 这里只做聚合，不重复判定，避免两处判据漂移。
    let awaiting = null
    for (let k = segs.length - 1; k >= 0; k -= 1) {
      const a = segs[k].awaiting
      if (isPlainObject(a) && a.active === true) {
        awaiting = {
          active: true,
          summary: compress(a.summary),
          turn: Number.isInteger(a.turn) ? a.turn : null,
        }
        break
      }
    }

    // 准入（ADR-0006）：段的准入结论由 work-store 用真实轮次判定后带下来；
    // 这里缺失时**fail-open**——证据不足不能当成不成立，否则面板会被静默清空。
    let admission = { admitted: true, reasons: [], kind: 'work' }
    for (let k = segs.length - 1; k >= 0; k -= 1) {
      const a = segs[k].admission
      if (isPlainObject(a) && typeof a.admitted === 'boolean') {
        admission = {
          admitted: a.admitted,
          reasons: Array.isArray(a.reasons) ? a.reasons.slice() : [],
          kind: a.kind === 'chat' ? 'chat' : 'work',
        }
        break
      }
    }

    // 下一步绝不留白（ADR-0009）：先信规则给的具体建议，其次退回段里的现成值。
    const nextStepInfo = suggestNextStep({
      turns: Array.isArray(latest.turns) ? latest.turns : [],
      awaiting,
      files: Array.isArray(latest.changedFiles) && latest.changedFiles.length > 0
        ? latest.changedFiles
        : files,
      goal: compress(first.goal ?? first.summary ?? latest.summary),
      errorTurns: Array.isArray(latest.errorTurns) ? latest.errorTurns : [],
      commands: Array.isArray(latest.commands) ? latest.commands : [],
      lastTurn: Number.isInteger(latest.endTurn) ? latest.endTurn : null,
    }, { now })
    const nextStepText = compress(latest.nextStep) || compress(nextStepInfo?.text) || ''

    const cluster = {
      clusterId,
      bucket,
      state,
      title,
      segmentIds,
      sessionIds,
      files,
      reasons,
      evidenceHandles,
      createdAt,
      lastActivityAt,
      admission,
      awaiting,
      nextStepKind: compress(nextStepInfo?.kind),
    }
    clusters.push(cluster)

    if (bucket === 'chat') {
      chatTopics.push({
        clusterId,
        title,
        segmentIds,
        sessionIds,
        lastActivityAt,
      })
      continue
    }

    const work = createWork({
      id: `w-cs-${clusterSeq - 1}`,
      workspaceId: workspaceId || compress(first.workspaceId),
      title,
      goal: compress(first.goal ?? first.summary ?? latest.summary),
      state,
      stateSource: 'inferred',
      pinned: false,
      statusSummary: compress(latest.statusSummary ?? latest.summary),
      nextStep: nextStepText,
      nextStepSource: 'inferred',
      nextStepKind: cluster.nextStepKind,
      awaiting: cluster.awaiting,
      admission: cluster.admission,
      segmentIds,
      sessionIds,
      files,
      decisions: [],
      evidenceHandles,
      createdAt,
      updatedAt: Math.max(lastActivityAt, now),
      lastActivityAt,
      lastInflectionAt: null,
      reviewStatus: 'pending',
      dismissedAsChat: false,
      reopenedFromId: null,
    }, now)

    works.push(work)
    if (bucket === 'unresolved') unresolvedWorks.push(work)
    else settledWorks.push(work)
  }

  return {
    clusters,
    works,
    unresolvedWorks,
    settledWorks,
    chatTopics,
    ignoredSegments,
  }
}

/**
 * 构造一次性冷启动语义精化提示词：
 * 把硬信号预聚类后的候选簇交给模型做一次性语义合并、过滤闲聊并提炼目标/现状/下一步/可选决策。
 *
 * @param {object[]} clusters - `planColdStartWorks` 产出的 clusters。
 * @param {object[]} segments - 段列表（用于补摘要与证据）。
 * @returns {{ system: string, user: string }}
 */
export function buildColdStartSemanticPrompt(clusters, segments) {
  const clusterList = Array.isArray(clusters) ? clusters : []
  const segById = new Map()
  for (const s of Array.isArray(segments) ? segments : []) {
    if (isPlainObject(s)) segById.set(segmentIdOf(s), s)
  }

  const system = [
    '你在协助做工作区历史对话的**一次性冷启动盘点**，把零散候选簇精化为「事（Work）」或「话题（Chat）」。',
    '规则：',
    '1. 只有真正有目标、有产出的工作才列为 works；纯概念咨询或日常闲聊放入 chatClusterIds。',
    '2. 属于同一项工作的多个候选簇可合并进同一条 work 的 clusterIds；不同工作不要硬并。',
    '3. 每条 work 必须提供：clusterIds、title、goal、state（active/blocked/done/shelved）、statusSummary、nextStep，decisions 按需提供（无关键方案切换或拍板时留空数组 []）。',
    '4. 只输出严格 JSON 对象：{"works":[{"clusterIds":[...],"title":"...","goal":"...","state":"active","statusSummary":"...","nextStep":"...","decisions":[{"summary":"...","rationale":"...","evidenceHandle":"〔8hex#N〕"}]}],"chatClusterIds":[...]}。',
    '不要输出多余解释。',
  ].join('\n')

  const lines = clusterList.map(c => {
    const segBriefs = (Array.isArray(c.segmentIds) ? c.segmentIds : []).slice(0, 4).map(id => {
      const s = segById.get(id)
      if (!s) return id
      const sum = clip(s.summary ?? s.goal ?? '', 80)
      return `${clip(s.title ?? id, 40)}${sum ? `：${sum}` : ''}`
    })
    const filesBrief = (Array.isArray(c.files) ? c.files : []).slice(0, 5).join(', ')
    return [
      `[${c.clusterId}] 初判=${c.bucket}(${c.state ?? 'chat'}) 标题=「${clip(c.title, 48)}」 信号=${(c.reasons || []).join(',') || 'none'}`,
      `  段摘要：${segBriefs.join(' | ') || '（无）'}`,
      filesBrief ? `  文件：${filesBrief}` : '',
    ].filter(Boolean).join('\n')
  })

  return {
    system,
    user: `共 ${clusterList.length} 个候选簇，请精化合并并提炼结构化「事」：\n\n${lines.join('\n\n')}`,
  }
}

/**
 * 解析冷启动语义精化输出；若模型返回非法 JSON / 结构不符 / 丢簇，安全降级回硬信号聚类结果。
 *
 * @param {string} text - 模型输出文本。
 * @param {object[]} clusters - 原硬信号 clusters。
 * @returns {{ fallback: boolean, works: object[], chatClusterIds: string[] }}
 */
export function parseColdStartSemanticResult(text, clusters) {
  const clusterList = Array.isArray(clusters) ? clusters.filter(isPlainObject) : []
  const byId = new Map(clusterList.map(c => [c.clusterId, c]))

  const fallbackResult = () => ({
    fallback: true,
    works: clusterList
      .filter(c => c.bucket !== 'chat')
      .map(c => ({
        clusterIds: [c.clusterId],
        title: c.title,
        goal: '',
        state: VALID_STATE_SET.has(c.state) ? c.state : 'active',
        statusSummary: '',
        nextStep: '',
        decisions: [],
      })),
    chatClusterIds: clusterList.filter(c => c.bucket === 'chat').map(c => c.clusterId),
  })

  const parsed = extractJsonObject(text)
  if (!parsed || !Array.isArray(parsed.works)) return fallbackResult()

  const claimed = new Set()
  const refinedWorks = []

  for (const item of parsed.works) {
    if (!isPlainObject(item) || !Array.isArray(item.clusterIds)) continue
    const validIds = uniqueStrings(item.clusterIds).filter(id => byId.has(id) && !claimed.has(id))
    if (validIds.length === 0) continue
    for (const id of validIds) claimed.add(id)

    const primary = byId.get(validIds[0])
    const state = VALID_STATE_SET.has(item.state)
      ? item.state
      : (VALID_STATE_SET.has(primary.state) ? primary.state : 'active')

    const decisions = (Array.isArray(item.decisions) ? item.decisions : [])
      .filter(d => isPlainObject(d) && compress(d.summary) !== '')
      .map(d => ({
        summary: compress(d.summary),
        rationale: compress(d.rationale),
        evidenceHandle: compress(d.evidenceHandle),
        source: 'inferred',
      }))

    refinedWorks.push({
      clusterIds: validIds,
      title: compress(item.title) || primary.title,
      goal: compress(item.goal),
      state,
      statusSummary: compress(item.statusSummary),
      nextStep: compress(item.nextStep),
      decisions,
    })
  }

  const chatClusterIds = uniqueStrings(parsed.chatClusterIds).filter(id => byId.has(id) && !claimed.has(id))
  for (const id of chatClusterIds) claimed.add(id)

  if (refinedWorks.length === 0 && chatClusterIds.length === 0 && clusterList.length > 0) {
    return fallbackResult()
  }

  for (const c of clusterList) {
    if (claimed.has(c.clusterId)) continue
    if (c.bucket === 'chat') {
      chatClusterIds.push(c.clusterId)
    } else {
      refinedWorks.push({
        clusterIds: [c.clusterId],
        title: c.title,
        goal: '',
        state: VALID_STATE_SET.has(c.state) ? c.state : 'active',
        statusSummary: '',
        nextStep: '',
        decisions: [],
      })
    }
  }

  return {
    fallback: false,
    works: refinedWorks,
    chatClusterIds,
  }
}

// ── 公开 API：日常增量三级匹配（ADR-0003） ─────────────────────────

function isConfirmedDone(work) {
  return work.state === 'done' && work.stateSource === 'confirmed'
}

function makeHitDecision(work, level, reason, confidence, extra = {}) {
  // 防污染红线：命中已确认 done 的老事，绝不自动改写，改为返回 suggest_reopen 轻提示
  if (isConfirmedDone(work)) {
    return {
      action: 'suggest_reopen',
      level,
      reason,
      relatedDoneWorkId: work.id,
      relatedDoneWorkTitle: work.title,
      confidence,
      ...extra,
    }
  }
  return {
    action: 'attach',
    level,
    reason,
    workId: work.id,
    confidence,
    ...extra,
  }
}

/**
 * 日常增量三级匹配：
 * - 忽略子代理/自动化会话与已退回话题（dismissedSegments）的段；
 * - L1 硬血缘：handoffWorkId → fork 父会话 → 段内引用句柄 〔8hex#N〕；
 * - L2 文件重叠：与同工作区未收束事的业务文件显著重叠（排除通用配置文件），
 *   若只命中已确认 done 老事则触发 suggest_reopen；
 * - L3 语义候选：筛选同工作区最多 10 件未收束事交给模型做增量归属判断。
 *
 * @param {object} store - 当前 WorkStore。
 * @param {object} segment - 新产出的段。
 * @param {{ forkParentSessionId?: string, handoffWorkId?: string, maxCandidates?: number }} [options]
 * @returns {object} 匹配指令（attach / suggest_reopen / need_semantic / new_work / ignore）。
 */
export function matchSegmentIncremental(store, segment, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  if (!isPlainObject(segment)) return { action: 'ignore', reason: 'invalid_segment' }

  const segId = segmentIdOf(segment)
  if (isSubagentOrAutomated(segment)) {
    return { action: 'ignore', reason: 'subagent_or_automated', segmentId: segId }
  }
  if (isPlainObject(store?.dismissedSegments) && Object.prototype.hasOwnProperty.call(store.dismissedSegments, segId)) {
    return { action: 'ignore', reason: 'dismissed_segment', segmentId: segId }
  }

  const works = (Array.isArray(store?.works) ? store.works : [])
    .filter(w => isPlainObject(w) && !w.dismissedAsChat)
  const segWorkspaceId = compress(segment.workspaceId || store?.workspaceId)
  const scopedWorks = segWorkspaceId === ''
    ? works
    : works.filter(w => compress(w.workspaceId) === '' || compress(w.workspaceId) === segWorkspaceId)

  const unresolved = scopedWorks.filter(w => UNRESOLVED_SET.has(w.state))
  const confirmedDone = scopedWorks.filter(isConfirmedDone)

  // ── L1 硬血缘（100% 确定） ──────────────────────────────────────
  const handoffWorkId = compress(segment.handoffWorkId ?? opts.handoffWorkId)
  if (handoffWorkId !== '') {
    const target = scopedWorks.find(w => w.id === handoffWorkId)
    if (target) {
      return makeHitDecision(target, 'L1', 'handoff', 1)
    }
  }

  const forkParent = compress(opts.forkParentSessionId ?? segment.forkParentSessionId)
  if (forkParent !== '') {
    const unresolvedHit = unresolved
      .filter(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(forkParent))
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
    if (unresolvedHit) return makeHitDecision(unresolvedHit, 'L1', 'fork', 1)

    const doneHit = confirmedDone
      .filter(w => Array.isArray(w.sessionIds) && w.sessionIds.includes(forkParent))
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
    if (doneHit) return makeHitDecision(doneHit, 'L1', 'fork', 1)
  }

  const handles = extractTurnHandlesFromSegment(segment)
  if (handles.length > 0) {
    const prefixSet = new Set(handles.map(h => h.sessionPrefix))
    const matchesPrefix = w => (Array.isArray(w.sessionIds) ? w.sessionIds : [])
      .some(sid => prefixSet.has(shortSessionPrefix(sid)))

    const unresolvedHit = unresolved
      .filter(matchesPrefix)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
    if (unresolvedHit) return makeHitDecision(unresolvedHit, 'L1', 'handle', 1)

    const doneHit = confirmedDone
      .filter(matchesPrefix)
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
    if (doneHit) return makeHitDecision(doneHit, 'L1', 'handle', 1)
  }

  // ── L2 业务文件显著重叠 ─────────────────────────────────────────
  const segSigFiles = significantChangedFilesOf(segment)
  if (segSigFiles.length > 0) {
    let bestUnresolved = null
    for (const w of unresolved) {
      const metrics = fileOverlapMetrics(segSigFiles, significantFilesOfWork(w))
      if (!isStrongFileOverlap(metrics)) continue
      const score = metrics.sharedCount * 2 + metrics.jaccard + metrics.containment
      if (!bestUnresolved || score > bestUnresolved.score) {
        bestUnresolved = { work: w, metrics, score }
      }
    }
    if (bestUnresolved) {
      return makeHitDecision(
        bestUnresolved.work,
        'L2',
        'files',
        Number(Math.min(0.95, 0.6 + bestUnresolved.metrics.jaccard * 0.35).toFixed(2)),
        { sharedFiles: bestUnresolved.metrics.shared },
      )
    }

    let bestDone = null
    for (const w of confirmedDone) {
      const metrics = fileOverlapMetrics(segSigFiles, significantFilesOfWork(w))
      if (!isStrongFileOverlap(metrics)) continue
      const score = metrics.sharedCount * 2 + metrics.jaccard + metrics.containment
      if (!bestDone || score > bestDone.score) {
        bestDone = { work: w, metrics, score }
      }
    }
    if (bestDone) {
      return makeHitDecision(
        bestDone.work,
        'L2',
        'files',
        Number(Math.min(0.9, 0.55 + bestDone.metrics.jaccard * 0.35).toFixed(2)),
        { sharedFiles: bestDone.metrics.shared },
      )
    }
  }

  // ── L3 同工作区未收束事语义候选（最多 10 件） ───────────────────
  const maxCandidates = Number.isFinite(opts.maxCandidates) && opts.maxCandidates > 0
    ? Math.min(MAX_SEMANTIC_CANDIDATES, Math.floor(opts.maxCandidates))
    : MAX_SEMANTIC_CANDIDATES

  const candidates = [...unresolved]
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
    })
    .slice(0, maxCandidates)

  if (candidates.length === 0) {
    const kind = compress(segment.kindCandidate).toLowerCase()
    if (kind === 'chat') return { action: 'ignore', level: 'L3', reason: 'chat_segment', segmentId: segId }
    return { action: 'new_work', level: 'L3', reason: 'no_unresolved_candidates', segmentId: segId }
  }

  return {
    action: 'need_semantic',
    level: 'L3',
    candidates,
    segmentId: segId,
  }
}

/**
 * 构造 L3 增量语义匹配的最小提示词。
 *
 * @param {object} segment - 新段。
 * @param {object[]} unresolvedWorks - 未收束候选事（最多 10 件）。
 * @returns {{ system: string, user: string }}
 */
export function buildIncrementalMatchPrompt(segment, unresolvedWorks) {
  const candidates = (Array.isArray(unresolvedWorks) ? unresolvedWorks : []).slice(0, MAX_SEMANTIC_CANDIDATES)
  const system = [
    '你在判断一段新的工作对话是否属于已有未收束的同一件事。',
    '只能返回以下三种动作之一（严格 JSON 对象，不要多余解释）：',
    '- {"action":"attach","workId":"<候选 id>","reason":"不超过 20 字"}：确属该未收束事的延续',
    '- {"action":"new_work","reason":"不超过 20 字"}：属于一件新的独立工作',
    '- {"action":"chat","reason":"不超过 20 字"}：纯日常闲聊/提问，不立为事',
    '判断依据是“是否围绕同一工作目标”，不是词面巧合；workId 必须严格来自候选列表。',
  ].join('\n')

  const segDesc = [
    `标题：${clip(segment?.title ?? '未命名段', 60)}`,
    `摘要：${clip(segment?.summary ?? segment?.goal ?? '（无）', 140)}`,
    `改动文件：${significantChangedFilesOf(segment).slice(0, 6).join(', ') || '（无）'}`,
  ].join('\n')

  const workLines = candidates.map((w, i) => (
    `${i + 1}. [${w.id}] 「${clip(w.title, 48)}」 状态=${w.state} 目标=${clip(w.goal || w.statusSummary || '（无）', 80)} 下一步=${clip(w.nextStep || '（无）', 60)}`
  ))

  return {
    system,
    user: `新段信息：\n${segDesc}\n\n当前未收束的事（最多 ${MAX_SEMANTIC_CANDIDATES} 件）：\n${workLines.join('\n')}`,
  }
}

/**
 * 解析 L3 增量语义匹配结果；严格校验 action 与 workId 必须在候选列表内，防模型幻觉。
 *
 * @param {string} text - 模型输出文本。
 * @param {object[]} unresolvedWorks - 候选事列表。
 * @returns {{ action: 'attach'|'new_work'|'chat', workId?: string, reason: string } | null}
 */
export function parseIncrementalMatchResult(text, unresolvedWorks) {
  const parsed = extractJsonObject(text)
  if (!parsed) return null

  const action = compress(parsed.action)
  const reason = clip(parsed.reason, 48)
  const allowedIds = new Set(
    (Array.isArray(unresolvedWorks) ? unresolvedWorks : [])
      .filter(isPlainObject)
      .map(w => compress(w.id))
      .filter(Boolean),
  )

  if (action === 'attach') {
    const workId = compress(parsed.workId)
    if (workId === '' || !allowedIds.has(workId)) return null
    return { action: 'attach', workId, reason }
  }
  if (action === 'new_work' || action === 'chat') {
    return { action, reason }
  }
  return null
}
