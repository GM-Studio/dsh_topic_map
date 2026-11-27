/**
 * 三层防失真续接与交接协议（ADR-0004）纯函数模块。
 *
 * 约定：
 * - 纯函数、无 I/O、不读 DOM、不读系统时钟；入参只读。
 * - 事级句柄 `〔work:<workId>〕` 与现有轮次句柄 `〔8hex#N〕` 清晰区分且可共存。
 * - 三层职责：
 *   1. 输入框草稿：短指针/可编辑交接草稿（永不擅自发送）；
 *   2. 程序直取硬事实：变更文件 ± 行、最近命令、失败信号、关键原文句柄；
 *   3. Wire 层渲染：四块结构化现场，按严格优先级受字符预算裁剪。
 *
 * @module dsh-topic-map/handoff
 */

/** 事级句柄识别正则：`〔work:<workId>〕`，与轮次句柄 `〔8hex#N〕` 不冲突。 */
export const WORK_HANDLE_RE = /〔work:([A-Za-z0-9][A-Za-z0-9._:-]{0,63})〕/g

/** Wire 层渲染默认字符预算。 */
export const DEFAULT_WIRE_MAX_CHARS = 2800

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toText(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

function compress(value) {
  return toText(value).replace(/\s+/g, ' ').trim()
}

function clip(value, max) {
  const text = compress(value)
  if (text === '') return ''
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, max).join('')}…`
}

function toPositiveInt(value, fallback) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.floor(num)
}

function shortSessionPrefix(sessionId) {
  const raw = compress(sessionId)
  if (raw === '') return ''
  return raw.replace(/^session[-_:]/i, '').slice(0, 8).toLowerCase()
}

/** 构造事级句柄 `〔work:<workId>〕`。 */
export function formatWorkHandle(workId) {
  const id = compress(workId)
  if (id === '') return ''
  return `〔work:${id}〕`
}

/** 构造轮次句柄 `〔8hex#N〕`。 */
export function formatTurnHandle(sessionId, turn) {
  const prefix = shortSessionPrefix(sessionId)
  const num = Number(turn)
  if (prefix === '' || !Number.isInteger(num) || num < 0) return ''
  return `〔${prefix}#${num}〕`
}

/**
 * 从最近人类消息 + 待发送消息中扫描并去重事级句柄 `〔work:<workId>〕`。
 *
 * @param {string|string[]} texts - 文本或文本数组。
 * @param {{maxCount?: number}} [options] - 配置；默认 `maxCount = 2`。
 * @returns {string[]} 去重后的 workId 列表（按首次出现顺序）。
 */
export function extractWorkHandles(texts, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const maxCount = toPositiveInt(opts.maxCount, 2)
  const list = Array.isArray(texts) ? texts : (typeof texts === 'string' ? [texts] : [])
  const seen = new Set()
  const ids = []
  const re = new RegExp(WORK_HANDLE_RE.source, 'g')
  for (const item of list) {
    if (typeof item !== 'string' || item === '') continue
    re.lastIndex = 0
    let match
    while ((match = re.exec(item)) !== null) {
      const id = match[1]
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      if (ids.length >= maxCount) return ids
    }
  }
  return ids
}

/** 读取某段的起止轮号 `[start, end]`；非法返回 null。 */
function segmentTurnSpan(segment) {
  if (!isPlainObject(segment)) return null
  if (Array.isArray(segment.turnRange) && segment.turnRange.length >= 2) {
    const start = Number(segment.turnRange[0])
    const end = Number(segment.turnRange[1])
    if (Number.isFinite(start) && Number.isFinite(end)) {
      return [Math.trunc(start), Math.trunc(end)]
    }
  }
  const start = Number(segment.startTurn ?? segment.fromTurn ?? segment.from)
  const end = Number(segment.endTurn ?? segment.toTurn ?? segment.to)
  if (Number.isFinite(start) && Number.isFinite(end)) {
    return [Math.trunc(start), Math.trunc(end)]
  }
  if (Array.isArray(segment.turns) && segment.turns.length > 0) {
    const nums = segment.turns.map(Number).filter(Number.isFinite)
    if (nums.length > 0) return [Math.trunc(Math.min(...nums)), Math.trunc(Math.max(...nums))]
  }
  return null
}

/** 估算某段的轮次数。 */
function segmentTurnCount(segment) {
  if (!isPlainObject(segment)) return 0
  if (Number.isFinite(segment.turnCount) && segment.turnCount >= 0) {
    return Math.trunc(segment.turnCount)
  }
  if (Array.isArray(segment.turns) && segment.turns.length > 0) {
    return segment.turns.length
  }
  const span = segmentTurnSpan(segment)
  if (span !== null && span[1] >= span[0]) return span[1] - span[0] + 1
  return 0
}

/** 从 work 对象里提取归属段 id 集合。 */
function workSegmentIdSet(work) {
  const set = new Set()
  if (!isPlainObject(work)) return set
  for (const id of Array.isArray(work.segmentIds) ? work.segmentIds : []) {
    const key = compress(id)
    if (key !== '') set.add(key)
  }
  for (const item of Array.isArray(work.segments) ? work.segments : []) {
    const key = compress(isPlainObject(item) ? (item.id ?? item.segmentId) : item)
    if (key !== '') set.add(key)
  }
  return set
}

/** 判断某段是否属于指定的 work。 */
function segmentBelongsToWork(segment, workId, segIds) {
  if (!isPlainObject(segment)) return false
  const segWorkId = compress(segment.workId)
  if (workId !== '' && segWorkId !== '' && segWorkId === workId) return true
  const segId = compress(segment.id ?? segment.segmentId)
  if (segId !== '' && segIds.has(segId)) return true
  return false
}

/**
 * 检测原会话末尾是否已串台（最后一段已不属于该「事」）。
 *
 * @param {object} work - 事对象（读取 `id / segmentIds / segments`）。
 * @param {object[]} sessionSegments - 目标会话按时间顺序排列的段列表。
 * @returns {{drifted: boolean, lastSegmentTitle: string, turnsSinceWork: number}}
 */
export function detectSessionDrift(work, sessionSegments) {
  const segments = Array.isArray(sessionSegments)
    ? sessionSegments.filter(isPlainObject)
    : []
  if (segments.length === 0) {
    return { drifted: false, lastSegmentTitle: '', turnsSinceWork: 0 }
  }

  const workId = compress(work?.id ?? work?.workId)
  const segIds = workSegmentIdSet(work)
  const last = segments[segments.length - 1]
  const lastSegmentTitle = compress(last.title ?? last.label ?? last.topic ?? '')

  if (segmentBelongsToWork(last, workId, segIds)) {
    return { drifted: false, lastSegmentTitle, turnsSinceWork: 0 }
  }

  let lastWorkIdx = -1
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segmentBelongsToWork(segments[i], workId, segIds)) {
      lastWorkIdx = i
      break
    }
  }

  let turnsSinceWork = 0
  if (lastWorkIdx !== -1) {
    const workSpan = segmentTurnSpan(segments[lastWorkIdx])
    const lastSpan = segmentTurnSpan(last)
    if (workSpan !== null && lastSpan !== null && lastSpan[1] >= workSpan[1]) {
      turnsSinceWork = lastSpan[1] - workSpan[1]
    } else {
      for (let i = lastWorkIdx + 1; i < segments.length; i += 1) {
        turnsSinceWork += segmentTurnCount(segments[i])
      }
    }
  } else {
    for (const seg of segments) {
      turnsSinceWork += segmentTurnCount(seg)
    }
  }

  return { drifted: true, lastSegmentTitle, turnsSinceWork }
}

/** 事标题归一化。 */
function workTitleOf(work) {
  const title = compress(work?.title ?? work?.name ?? '')
  return title !== '' ? title : '未命名工作'
}

/** 事唯一 id 归一化。 */
function workIdOf(work) {
  return compress(work?.id ?? work?.workId ?? '')
}

/** 事目标归一化。 */
function workGoalOf(work) {
  return compress(work?.goal ?? work?.objective ?? '')
}

/** 事下一步归一化。 */
function workNextStepOf(work) {
  return compress(work?.nextStep ?? work?.next_step ?? work?.nextAction ?? '')
}

/** 事当前卡点归一化。 */
function workBlockerOf(work) {
  return compress(work?.blocker ?? work?.blockedReason ?? work?.stuckReason ?? '')
}

/**
 * 原会话续接草稿（只填入输入框，永不自动发送）。
 *
 * - `drifted: false`：末尾正是该事，简洁直接带入下一步行动，不塞冗余指针；
 * - `drifted: true`：末尾已串台，附带 `【续接「标题」〔work:<id>〕】` 触发 wire 层现场纠偏。
 *
 * @param {object} work - 事对象。
 * @param {{drifted?: boolean}} [options] - 是否串台。
 * @returns {string} 可编辑草稿文本。
 */
export function buildSameSessionDraft(work, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const drifted = opts.drifted === true
  const title = workTitleOf(work)
  const id = workIdOf(work)
  const nextStep = workNextStepOf(work)
  const action = nextStep !== '' ? `继续：${nextStep}` : `继续推进「${title}」。`

  if (!drifted) return action

  const handle = formatWorkHandle(id)
  const tag = handle !== '' ? `【续接「${title}」${handle}】` : `【续接「${title}」】`
  return `${tag} ${action}`
}

/**
 * 新会话交接草稿（人类一眼可读、可编辑，永不擅自发送）。
 *
 * 输入框只放简洁交接指针 + 核心态势（目标、卡点、关键变更提示、下一步），
 * 完整硬事实、决策与证据索引留给 wire 层通过 `〔work:<id>〕` 注入。
 *
 * @param {object} work - 事对象。
 * @param {object} [hardFacts] - `extractWorkHardFacts` 返回值（可选）。
 * @param {{maxFilesPreview?: number}} [options] - 预览文件数（默认 3）。
 * @returns {string} 可编辑草稿文本。
 */
export function buildNewSessionHandoffDraft(work, hardFacts = null, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const maxFilesPreview = toPositiveInt(opts.maxFilesPreview, 3)
  const title = workTitleOf(work)
  const id = workIdOf(work)
  const handle = formatWorkHandle(id)
  const goal = workGoalOf(work)
  const blocker = workBlockerOf(work)
  const nextStep = workNextStepOf(work)

  const lines = []
  const header = handle !== ''
    ? `【交接「${title}」${handle}】`
    : `【交接「${title}」】`
  lines.push(header)

  if (goal !== '') lines.push(`目标：${clip(goal, 140)}`)
  if (blocker !== '') lines.push(`卡点：${clip(blocker, 120)}`)

  const files = Array.isArray(hardFacts?.changedFiles) ? hardFacts.changedFiles : []
  if (files.length > 0) {
    const shown = files.slice(0, maxFilesPreview).map(item => compress(item?.path ?? item)).filter(Boolean)
    if (shown.length > 0) {
      const more = files.length > shown.length ? ` 等 ${files.length} 个文件` : ''
      lines.push(`涉及文件：${shown.join('、')}${more}`)
    }
  }

  lines.push(`下一步：${nextStep !== '' ? clip(nextStep, 160) : `请基于以上交接现场继续推进「${title}」`}`)
  return lines.join('\n')
}

/** 严格按码点截断到至多 max 字符（含省略号不超过 max）。 */
function clipStrict(value, max) {
  const text = compress(value)
  if (text === '' || max <= 0) return ''
  const chars = Array.from(text)
  if (chars.length <= max) return text
  if (max === 1) return chars[0]
  return `${chars.slice(0, max - 1).join('')}…`
}

/** 非负整数归一。 */
function toNonNegInt(value) {
  if (value === null || value === undefined || value === '') return 0
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return 0
  return Math.floor(num)
}

/** 轮次活动时间戳（用于按时间排序）；缺失返回 0。 */
function turnTimeOf(row) {
  if (Number.isFinite(row?.end)) return row.end
  if (Number.isFinite(row?.start)) return row.start
  return 0
}

/** 取轮次行的会话 id（允许从 options.sessionId 兜底）。 */
function turnSessionIdOf(row, fallbackSessionId) {
  return compress(row?.sessionId ?? row?.session_id ?? fallbackSessionId ?? '')
}

/** 轮次的规范唯一键（同会话前缀 + 轮号）。 */
function turnKeyOf(sessionId, turn) {
  const prefix = shortSessionPrefix(sessionId)
  const num = Number(turn)
  if (prefix === '' || !Number.isInteger(num) || num < 0) return ''
  return `${prefix}#${num}`
}

/** 轮次是否属于失败或中断信号。 */
function isFailedTurn(row) {
  if (!isPlainObject(row)) return false
  const reason = compress(row.endReason).toLowerCase()
  if (reason === 'error' || reason === 'aborted' || reason === 'blocked' || reason === 'interrupted' || reason === 'max-tokens') {
    return true
  }
  return row.interrupted === true
}

/** 规范化失败轮次的 endReason 标签。 */
function failedReasonOf(row) {
  const reason = compress(row?.endReason).toLowerCase()
  if (reason !== '' && reason !== 'completed' && reason !== 'open') return reason
  if (row?.interrupted === true) return 'interrupted'
  return reason || 'error'
}

/** 提取文本第一个非空行作为简短提示。 */
function firstNonEmptyLine(text) {
  const raw = toText(text)
  if (raw === '') return ''
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line.replace(/\s+/g, ' ').trim()
    if (cleaned !== '') return cleaned
  }
  return ''
}

/** 判断轮次是否包含有效文件变更。 */
function validChangedFilesOf(row) {
  const changes = row?.changes
  if (!isPlainObject(changes) || changes.lost === true) return []
  const files = Array.isArray(changes.files) ? changes.files : []
  const out = []
  for (const entry of files) {
    if (typeof entry === 'string') {
      const path = entry.trim()
      if (path !== '') out.push({ path, added: 0, deleted: 0 })
      continue
    }
    if (!isPlainObject(entry)) continue
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    if (path === '') continue
    out.push({
      path,
      added: toNonNegInt(entry.added),
      deleted: toNonNegInt(entry.deleted),
    })
  }
  return out
}

/** 把调用方传入的决策证据集合归一成 `prefix#turn` Set。 */
function buildDecisionEvidenceSet(decisionEvidence, fallbackSessionId) {
  const set = new Set()
  if (!Array.isArray(decisionEvidence)) return set
  for (const item of decisionEvidence) {
    if (typeof item === 'string') {
      const m = item.match(/〔?([0-9a-fA-F]{8})#(\d+)〕?/)
      if (m !== null) set.add(`${m[1].toLowerCase()}#${Number(m[2])}`)
      continue
    }
    if (!isPlainObject(item)) continue
    const key = turnKeyOf(item.sessionId ?? item.session_id ?? fallbackSessionId, item.turn)
    if (key !== '') set.add(key)
  }
  return set
}

/**
 * 从某「事」关联的所有轮次行（turn-index 格式）确定性抽取硬事实。
 *
 * 绝不依赖模型记忆：
 * - `changedFiles`：去重文件路径 + 最近一次改动的 ±行数（默认上限 12）；
 * - `recentCommands`：按时间倒序去重（默认上限 6）；
 * - `failedSignals`：最近失败/中断轮次的错误信号（默认上限 3）；
 * - `keyEvidenceHandles`：按优先级（决策证据 > 报错 > 有变更 > 段首尾）去重取前 8 条，附 ≤30 字提问头。
 *
 * @param {object[]} turns - turn-index 轮次行数组。
 * @param {object} [options] - 上限与决策证据选项。
 * @returns {{changedFiles: object[], recentCommands: string[], failedSignals: object[], keyEvidenceHandles: object[]}}
 */
export function extractWorkHardFacts(turns, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const maxFiles = toPositiveInt(opts.maxFiles, 12)
  const maxCommands = toPositiveInt(opts.maxCommands, 6)
  const maxFailed = toPositiveInt(opts.maxFailed, 3)
  const maxEvidence = toPositiveInt(opts.maxEvidence, 8)
  const fallbackSessionId = compress(opts.sessionId)

  const rawRows = Array.isArray(turns) ? turns.filter(isPlainObject) : []
  if (rawRows.length === 0) {
    return {
      changedFiles: [],
      recentCommands: [],
      failedSignals: [],
      keyEvidenceHandles: [],
    }
  }

  // 按时间升序稳定排序（同时间按轮号、再按原下标）
  const ordered = rawRows
    .map((row, index) => ({
      row,
      index,
      time: turnTimeOf(row),
      turn: Number.isFinite(Number(row.turn)) ? Math.trunc(Number(row.turn)) : index,
      sessionId: turnSessionIdOf(row, fallbackSessionId),
    }))
    .sort((a, b) => (a.time - b.time) || (a.turn - b.turn) || (a.index - b.index))

  // 1) changedFiles：按时间倒序扫描，同路径取最近一次改动并保持最近优先
  const fileMap = new Map()
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const item = ordered[i]
    const files = validChangedFilesOf(item.row)
    for (const file of files) {
      if (fileMap.has(file.path)) continue
      fileMap.set(file.path, {
        path: file.path,
        added: file.added,
        deleted: file.deleted,
        turn: item.turn,
        handle: formatTurnHandle(item.sessionId, item.turn),
      })
    }
  }
  const changedFiles = Array.from(fileMap.values()).slice(0, maxFiles)

  // 2) recentCommands：按时间倒序（同轮内也倒序，使最近执行的命令在前）去重
  const recentCommands = []
  const seenCommands = new Set()
  for (let i = ordered.length - 1; i >= 0 && recentCommands.length < maxCommands; i -= 1) {
    const cmds = Array.isArray(ordered[i].row.commands) ? ordered[i].row.commands : []
    for (let j = cmds.length - 1; j >= 0 && recentCommands.length < maxCommands; j -= 1) {
      const cmd = compress(cmds[j])
      if (cmd === '' || seenCommands.has(cmd)) continue
      seenCommands.add(cmd)
      recentCommands.push(cmd)
    }
  }

  // 3) failedSignals：按时间倒序取最近失败/中断轮次
  const failedSignals = []
  for (let i = ordered.length - 1; i >= 0 && failedSignals.length < maxFailed; i -= 1) {
    const item = ordered[i]
    if (!isFailedTurn(item.row)) continue
    const cmds = Array.isArray(item.row.commands) ? item.row.commands : []
    const lastCmd = cmds.length > 0 ? compress(cmds[cmds.length - 1]) : ''
    const respLine = firstNonEmptyLine(item.row.response)
    const promptLine = firstNonEmptyLine(item.row.prompt)
    const hint = clipStrict(respLine || lastCmd || promptLine || failedReasonOf(item.row), 120)
    failedSignals.push({
      turn: item.turn,
      sessionId: item.sessionId,
      handle: formatTurnHandle(item.sessionId, item.turn),
      endReason: failedReasonOf(item.row),
      command: lastCmd,
      hint,
    })
  }

  // 4) keyEvidenceHandles：按段找首尾轮 + 决策证据 + 报错 + 变更，按优先级排序去重
  const decisionSet = buildDecisionEvidenceSet(opts.decisionEvidence, fallbackSessionId)

  // 段边界：优先按 segmentId，其次按 sessionId 分组找每组首尾下标
  const groupBounds = new Map()
  ordered.forEach((item, idx) => {
    const groupKey = compress(item.row.segmentId) || item.sessionId || '__default__'
    const existing = groupBounds.get(groupKey)
    if (existing === undefined) groupBounds.set(groupKey, { first: idx, last: idx })
    else existing.last = idx
  })
  const boundaryIdx = new Set()
  for (const bound of groupBounds.values()) {
    boundaryIdx.add(bound.first)
    boundaryIdx.add(bound.last)
  }

  const candidates = []
  ordered.forEach((item, idx) => {
    const handle = formatTurnHandle(item.sessionId, item.turn)
    if (handle === '') return
    const key = turnKeyOf(item.sessionId, item.turn)
    const reasons = []
    let priority = 0
    if (decisionSet.has(key)) {
      priority = Math.max(priority, 4)
      reasons.push('decision')
    }
    if (isFailedTurn(item.row)) {
      priority = Math.max(priority, 3)
      reasons.push('failed')
    }
    if (validChangedFilesOf(item.row).length > 0) {
      priority = Math.max(priority, 2)
      reasons.push('changed')
    }
    if (boundaryIdx.has(idx)) {
      priority = Math.max(priority, 1)
      reasons.push('boundary')
    }
    if (priority === 0) return

    const head = clipStrict(firstNonEmptyLine(item.row.prompt) || firstNonEmptyLine(item.row.response) || `第 ${item.turn} 轮`, 30)
    candidates.push({
      key,
      handle,
      sessionId: item.sessionId,
      turn: item.turn,
      head,
      reasons,
      priority,
      order: idx,
    })
  })

  // 同优先级按较新的轮次排前（保证重要且最新的变更/段边界先入选）
  candidates.sort((a, b) => (b.priority - a.priority) || (b.order - a.order))

  const seenHandles = new Set()
  const keyEvidenceHandles = []
  for (const item of candidates) {
    if (seenHandles.has(item.key)) continue
    seenHandles.add(item.key)
    keyEvidenceHandles.push({
      handle: item.handle,
      sessionId: item.sessionId,
      turn: item.turn,
      head: item.head,
      reasons: item.reasons,
    })
    if (keyEvidenceHandles.length >= maxEvidence) break
  }

  return {
    changedFiles,
    recentCommands,
    failedSignals,
    keyEvidenceHandles,
  }
}

/** 事状态中文映射（对齐 GLOSSARY.md）。 */
const STATUS_LABELS = Object.freeze({
  in_progress: '进行中',
  active: '进行中',
  ongoing: '进行中',
  blocked: '卡住',
  stuck: '卡住',
  done: '已完成',
  completed: '已完成',
  shelved: '已搁置',
  paused: '已搁置',
  settled: '已搁置',
})

function formatWorkStatus(work) {
  const raw = compress(work?.status)
  if (raw === '') return '进行中'
  const mapped = STATUS_LABELS[raw.toLowerCase()]
  return mapped !== undefined ? mapped : raw
}

function formatConfidenceTag(work) {
  if (work?.confirmed === true) return '已确认态'
  const state = compress(work?.confirmState ?? work?.confirmation ?? work?.confidence).toLowerCase()
  if (state === 'confirmed' || state === 'locked' || state === '已确认' || state === '已确认态') {
    return '已确认态'
  }
  return '推测态'
}

/** 从决策对象解析原文轮次句柄。 */
function decisionHandleOf(decision) {
  if (!isPlainObject(decision)) return ''
  const direct = compress(decision.handle)
  if (/^〔[0-9a-fA-F]{8}#\d+〕$/.test(direct)) return direct
  const ev = decision.evidence
  if (typeof ev === 'string') {
    const m = ev.match(/〔?([0-9a-fA-F]{8})#(\d+)〕?/)
    if (m !== null) return `〔${m[1].toLowerCase()}#${Number(m[2])}〕`
  }
  if (isPlainObject(ev)) {
    const built = formatTurnHandle(ev.sessionId ?? ev.session_id, ev.turn)
    if (built !== '') return built
  }
  if (Array.isArray(ev) && ev.length > 0) {
    for (const item of ev) {
      const built = decisionHandleOf({ evidence: item })
      if (built !== '') return built
    }
  }
  return formatTurnHandle(decision.sessionId ?? decision.session_id, decision.turn)
}

/** 判断一条决策是否已被否决或取代。 */
function isSupersededDecision(decision) {
  if (!isPlainObject(decision)) return false
  if (decision.superseded === true) return true
  if (compress(decision.supersededBy) !== '') return true
  const status = compress(decision.status).toLowerCase()
  return status === 'superseded' || status === 'rejected' || status === 'abandoned' || status === 'reverted'
}

/** 把 work.decisions 拆成现行决策与已否决方案两组格式化文本行。 */
function splitDecisions(work) {
  const list = Array.isArray(work?.decisions) ? work.decisions.filter(isPlainObject) : []
  const active = []
  const rejected = []
  for (const item of list) {
    const summary = compress(item.summary ?? item.title ?? item.decision ?? item.text ?? '')
    if (summary === '') continue
    const handle = decisionHandleOf(item)
    const reason = compress(item.reason ?? item.rationale ?? item.rejectedReason ?? '')
    const suffix = handle !== '' ? ` ${handle}` : ''
    if (isSupersededDecision(item)) {
      const why = reason !== '' ? `（原因：${reason}）` : ''
      rejected.push(`- [已否决] ${summary}${why}${suffix}`)
    } else {
      const why = reason !== '' ? `（理由：${reason}）` : ''
      active.push(`- ${summary}${why}${suffix}`)
    }
  }
  return { active, rejected }
}

/** 格式化单条硬事实：变更文件。 */
function formatChangedFileLine(file) {
  const path = compress(file?.path ?? file)
  if (path === '') return ''
  const added = toNonNegInt(file?.added)
  const deleted = toNonNegInt(file?.deleted)
  const stats = (added > 0 || deleted > 0) ? ` (+${added}/-${deleted})` : ''
  return `- ${path}${stats}`
}

/** 格式化单条硬事实：失败信号。 */
function formatFailedSignalLine(sig) {
  if (!isPlainObject(sig)) return ''
  const handle = compress(sig.handle) || formatTurnHandle(sig.sessionId, sig.turn)
  const reason = compress(sig.endReason) || 'error'
  const cmd = compress(sig.command)
  const hint = compress(sig.hint ?? sig.summary)
  const parts = []
  if (handle !== '') parts.push(handle)
  parts.push(`[${reason}]`)
  if (cmd !== '') parts.push('`' + clipStrict(cmd, 80) + '`')
  if (hint !== '') parts.push(clipStrict(hint, 100))
  return `- ${parts.join(' ')}`
}

/** 格式化单条硬事实：命令。 */
function formatCommandLine(cmd) {
  const text = compress(cmd)
  if (text === '') return ''
  return `- ${clipStrict(text, 120)}`
}

/** 格式化单条证据句柄行。 */
function formatEvidenceLine(ev) {
  if (!isPlainObject(ev)) return ''
  const handle = compress(ev.handle) || formatTurnHandle(ev.sessionId, ev.turn)
  if (handle === '') return ''
  const head = clipStrict(ev.head ?? ev.prompt ?? '', 30)
  return head !== '' ? `- ${handle} ${head}` : `- ${handle}`
}

/** 组装四块结构化现场文本。 */
function composeWireContext(state) {
  const {
    header,
    section1Lines,
    activeDecisions,
    rejectedDecisions,
    omittedRejected,
    failedLines,
    omittedFailed,
    fileLines,
    omittedFiles,
    commandLines,
    omittedCommands,
    nextStepLine,
    evidenceLines,
    omittedEvidence,
  } = state

  // 块 1：目标与当前态势
  const block1 = ['【目标与当前态势】', ...section1Lines].join('\n')

  // 块 2：已生效决策 / 已否决方案
  const b2 = ['【已生效决策 / 已否决方案】']
  if (activeDecisions.length === 0 && rejectedDecisions.length === 0 && omittedRejected === 0) {
    b2.push('（暂无记录）')
  } else {
    if (activeDecisions.length > 0) {
      b2.push('已生效决策：')
      b2.push(...activeDecisions)
    }
    if (rejectedDecisions.length > 0 || omittedRejected > 0) {
      b2.push('已否决方案：')
      b2.push(...rejectedDecisions)
      if (omittedRejected > 0) b2.push(`（已省略 ${omittedRejected} 条已否决方案）`)
    }
  }
  const block2 = b2.join('\n')

  // 块 3：硬事实（程序直取）
  const b3 = ['【硬事实（程序直取）】']
  const hasAnyFact = failedLines.length > 0 || fileLines.length > 0 || commandLines.length > 0
    || omittedFailed > 0 || omittedFiles > 0 || omittedCommands > 0
  if (!hasAnyFact) {
    b3.push('（暂无程序直取硬事实）')
  } else {
    if (failedLines.length > 0 || omittedFailed > 0) {
      b3.push('失败/中断信号：')
      b3.push(...failedLines)
      if (omittedFailed > 0) b3.push(`（已省略 ${omittedFailed} 条失败信号）`)
    }
    if (fileLines.length > 0 || omittedFiles > 0) {
      b3.push('变更文件：')
      b3.push(...fileLines)
      if (omittedFiles > 0) b3.push(`（已省略 ${omittedFiles} 个变更文件）`)
    }
    if (commandLines.length > 0 || omittedCommands > 0) {
      b3.push('最近命令：')
      b3.push(...commandLines)
      if (omittedCommands > 0) b3.push(`（已省略 ${omittedCommands} 条命令）`)
    }
  }
  const block3 = b3.join('\n')

  // 块 4：下一步与原文证据索引
  const b4 = ['【下一步与原文证据索引】', nextStepLine]
  if (evidenceLines.length > 0 || omittedEvidence > 0) {
    b4.push('原文证据索引（如需细节请调用 history_turn 工具按句柄拉取原文，禁止猜测）：')
    b4.push(...evidenceLines)
    if (omittedEvidence > 0) b4.push(`（已省略 ${omittedEvidence} 条原文证据句柄）`)
  } else {
    b4.push('提示：如需核对历史细节请调用 history_turn 工具按句柄拉取原文，禁止猜测。')
  }
  const block4 = b4.join('\n')

  return [header, block1, block2, block3, block4].filter(Boolean).join('\n\n')
}

/**
 * 渲染 Wire 层结构化上下文（供 `system-prompt/assemble` 注入，`interpolate: false`）。
 *
 * 严格受 `maxChars` 预算控制（默认 2800），截断优先级明确：
 * 1. **永不丢**：目标、下一步、现行已生效决策；
 * 2. **最先裁剪**：原文证据句柄清单；
 * 3. **其次裁剪**：硬事实（命令 → 变更文件 → 失败信号）；
 * 4. **最后裁剪**：已否决方案。
 * 超预算裁剪时明确注明各类裁剪数量。
 *
 * @param {object} work - 事对象。
 * @param {object|null} [hardFacts] - `extractWorkHardFacts` 返回值。
 * @param {{maxChars?: number, drift?: {drifted?: boolean, lastSegmentTitle?: string, turnsSinceWork?: number}}} [options]
 * @returns {string} 结构化上下文文本。
 */
export function renderWorkContextForAgent(work, hardFacts = null, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const maxChars = toPositiveInt(opts.maxChars, DEFAULT_WIRE_MAX_CHARS)
  const title = workTitleOf(work)
  const id = workIdOf(work)
  const handle = formatWorkHandle(id)
  const goal = workGoalOf(work)
  const blocker = workBlockerOf(work)
  const nextStep = workNextStepOf(work)
  const statusLabel = formatWorkStatus(work)
  const confidenceTag = formatConfidenceTag(work)

  const header = handle !== ''
    ? `〔事级交接现场 ${handle}〕${title}`
    : `〔事级交接现场〕${title}`

  const section1Lines = [
    `目标：${goal !== '' ? goal : title}`,
    `状态：${statusLabel}（${confidenceTag}）`,
  ]
  if (blocker !== '') section1Lines.push(`当前卡点：${blocker}`)

  const drift = isPlainObject(opts.drift) ? opts.drift : null
  if (drift?.drifted === true) {
    const lastSeg = compress(drift.lastSegmentTitle)
    const turns = toNonNegInt(drift.turnsSinceWork)
    const detail = [
      lastSeg !== '' ? `原会话末尾已切到「${lastSeg}」` : '原会话末尾已切到其他话题',
      turns > 0 ? `间隔 ${turns} 轮` : '',
    ].filter(Boolean).join('，')
    section1Lines.push(`串台纠偏：${detail}；请忽略串台对话，回到本事继续。`)
  }

  const { active: activeDecisions, rejected: allRejected } = splitDecisions(work)
  const facts = isPlainObject(hardFacts) ? hardFacts : {}
  const allFailed = (Array.isArray(facts.failedSignals) ? facts.failedSignals : [])
    .map(formatFailedSignalLine).filter(Boolean)
  const allFiles = (Array.isArray(facts.changedFiles) ? facts.changedFiles : [])
    .map(formatChangedFileLine).filter(Boolean)
  const allCommands = (Array.isArray(facts.recentCommands) ? facts.recentCommands : [])
    .map(formatCommandLine).filter(Boolean)
  const allEvidence = (Array.isArray(facts.keyEvidenceHandles) ? facts.keyEvidenceHandles : [])
    .map(formatEvidenceLine).filter(Boolean)

  const nextStepLine = `唯一行动：${nextStep !== '' ? nextStep : `继续推进「${title}」`}`

  const state = {
    header,
    section1Lines,
    activeDecisions,
    rejectedDecisions: allRejected.slice(),
    omittedRejected: 0,
    failedLines: allFailed.slice(),
    omittedFailed: 0,
    fileLines: allFiles.slice(),
    omittedFiles: 0,
    commandLines: allCommands.slice(),
    omittedCommands: 0,
    nextStepLine,
    evidenceLines: allEvidence.slice(),
    omittedEvidence: 0,
  }

  // 严格按优先级逐项裁剪：
  // 证据句柄 → 最近命令 → 变更文件 → 失败信号 → 已否决方案；
  // 目标 / 下一步 / 现行决策 永不丢。
  const trimSteps = [
    () => {
      if (state.evidenceLines.length === 0) return false
      state.evidenceLines.pop()
      state.omittedEvidence += 1
      return true
    },
    () => {
      if (state.commandLines.length === 0) return false
      state.commandLines.pop()
      state.omittedCommands += 1
      return true
    },
    () => {
      if (state.fileLines.length === 0) return false
      state.fileLines.pop()
      state.omittedFiles += 1
      return true
    },
    () => {
      if (state.failedLines.length === 0) return false
      state.failedLines.pop()
      state.omittedFailed += 1
      return true
    },
    () => {
      if (state.rejectedDecisions.length === 0) return false
      state.rejectedDecisions.pop()
      state.omittedRejected += 1
      return true
    },
  ]

  let rendered = composeWireContext(state)
  for (const step of trimSteps) {
    while (rendered.length > maxChars && step()) {
      rendered = composeWireContext(state)
    }
    if (rendered.length <= maxChars) break
  }

  return rendered
}
