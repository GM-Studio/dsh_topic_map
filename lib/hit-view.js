/**
 * 列表视图模型（V-1 / A-2 / A-14）：把检索命中变成可直接渲染的行。
 *
 * 为什么单独成模块：右栏（两行）与主面板（三行）要显示同一条命中的不同切片，
 * 还要拼分数来源、分组头、复制反馈。这些全是字符串与时间格式化——纯函数，
 * 可以在 Node 里逐条验证，不碰 DOM，也就不用为了"看效果"反复点界面。
 *
 * 三条约束，代码里别破坏：
 * - 只产出字符串 / 数字 / 数组，不产 HTML、不做转义；
 * - `now` 一律由调用方传入，不读系统时钟，测试才可复现；
 * - 不 `import` 其他模块：本文件以后由 build-theme 原样嵌进 client bundle，
 *   标签归一化这类小逻辑在这里自带一份（与 rank.js 的 `statusesOf` 同口径）。
 *
 * @module dsh-topic-map/hit-view
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 状态键的固定顺序（与 rank.js 一致）。 */
const STATUS_ORDER = Object.freeze(['starred', 'solved', 'followUp'])

/** 状态的中文文案（A-3 三个开关）。 */
const STATUS_TEXT = Object.freeze({ starred: '重要', solved: '已解决', followUp: '待跟进' })

/** 算"失败"的结束原因：需要重试的那些。 */
const FAIL_REASONS = new Set(['error', 'failed', 'blocked', 'max-tokens', 'max-turns'])

/** 算"中断"的结束原因。 */
const INTERRUPT_REASONS = new Set(['interrupted', 'aborted'])

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把时间统一成 epoch ms；认 Date 与数字，其余返回 NaN。 */
function toMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return NaN
}

/** 本地自然日的 0 点时间戳。 */
function startOfLocalDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 是否同一个本地自然日。 */
function sameLocalDay(a, b) {
  return startOfLocalDay(a) === startOfLocalDay(b)
}

/** 是否同一个本地年份（跨年用绝对日期）。 */
function sameLocalYear(a, b) {
  return new Date(a).getFullYear() === new Date(b).getFullYear()
}

/** `YYYY-MM-DD`（本地时区，不补时分）。 */
function formatDate(ms) {
  const date = new Date(ms)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 相对时间文案。
 *
 * 分档（与 rank 的新鲜度同为"本地自然日"口径）：
 * ```
 * < 1 分钟       刚刚
 * < 1 小时       N 分钟前
 * < 24 小时      N 小时前
 * 昨天           昨天（同一自然年的前一天）
 * 2–6 天         N 天前
 * ≥ 7 天或跨年   YYYY-MM-DD
 * ```
 * 未来时间（宿主时钟偏差）同一天显示"今天"，隔天用绝对日期。
 * `ts` / `now` 缺失或非法返回空串——绝不回退到系统时钟。
 *
 * @param {number|Date} ts - 要格式化的时间（epoch ms）。
 * @param {number|Date} now - 参照的"现在"（epoch ms）。
 * @returns {string} 文案；参数非法时为空串。
 */
export function formatRelativeTime(ts, now) {
  const time = toMs(ts)
  const base = toMs(now)
  if (!Number.isFinite(time) || !Number.isFinite(base)) return ''
  const diff = base - time
  if (diff < 0) return sameLocalDay(time, base) ? '今天' : formatDate(time)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  // 满 24 小时改按本地自然日：跨过零点才算一天，和 rank 的新鲜度一致。
  const days = Math.round((startOfLocalDay(base) - startOfLocalDay(time)) / DAY)
  if (!sameLocalYear(time, base)) return formatDate(time)
  if (days <= 0) return '今天' // 夏令时等边界兜底
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return formatDate(time)
}

/** 会话短 id：去掉常见的 `session-` 前缀后取前 8 个字符。 */
function shortSessionId(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId.trim() : String(sessionId ?? '').trim()
  if (raw === '') return ''
  const stripped = raw.replace(/^session[-_:]/i, '')
  return stripped.slice(0, 8)
}

/**
 * 命中标签的键：`sessionId#turn`（design §4；与 rank.js 同口径）。
 *
 * @param {object} hit - 命中。
 * @returns {string} 标签键；信息不全时退化为 turn 或空串。
 */
function labelKeyOf(hit) {
  const sid = hit.sessionId
  const turn = hit.turn
  if (sid === null || sid === undefined || sid === '') {
    return turn === null || turn === undefined ? '' : String(turn)
  }
  if (turn === null || turn === undefined) return String(sid)
  return `${sid}#${turn}`
}

/**
 * 从标签仓库取一条标签（对象 / Map / 函数），找不到回退命中自带的 `label`。
 *
 * @param {object} hit - 命中。
 * @param {object|Map|Function} [labels] - 标签仓库。
 * @returns {object|string|Array|null} 标签。
 */
function resolveLabel(hit, labels) {
  if (typeof labels === 'function') {
    const value = labels(hit)
    if (value !== undefined && value !== null) return value
  } else if (labels instanceof Map || isPlainObject(labels)) {
    const key = labelKeyOf(hit)
    const bare = hit.turn === null || hit.turn === undefined ? '' : String(hit.turn)
    const lookup = k => (labels instanceof Map ? (labels.has(k) ? labels.get(k) : undefined) : labels[k])
    if (key !== '' && lookup(key) !== undefined) return lookup(key)
    if (bare !== '' && lookup(bare) !== undefined) return lookup(bare)
  }
  if (hit.label !== undefined && hit.label !== null) return hit.label
  return null
}

/**
 * 把各种标签形状归一成三个状态键（顺序固定）。
 *
 * @param {object|string|Array|null} label - 标签。
 * @returns {string[]} `starred / solved / followUp` 的子集。
 */
function statusesOf(label) {
  if (!label) return []
  if (typeof label === 'string') {
    const raw = label.trim().toLowerCase()
    return STATUS_ORDER.filter(status => status.toLowerCase() === raw)
  }
  if (Array.isArray(label)) return STATUS_ORDER.filter(status => label.includes(status))
  if (!isPlainObject(label)) return []
  return STATUS_ORDER.filter(status => Boolean(label[status]))
}

/** 是否失败结束（需要重试）。 */
function isFailure(hit) {
  const reason = typeof hit.endReason === 'string' ? hit.endReason : ''
  return FAIL_REASONS.has(reason)
}

/** 是否中断。 */
function isInterrupted(hit) {
  const reason = typeof hit.endReason === 'string' ? hit.endReason : ''
  return hit.interrupted === true || INTERRUPT_REASONS.has(reason)
}

/**
 * 判断该轮是否改过文件（F-7）。
 *
 * 支持的形状：`changes: [{...}]`、`changes: {files:[...], lost}`；
 * `lost:true` 表示"曾变更但明细已不可读"，仍算有变更。
 *
 * @param {object} hit - 命中。
 * @returns {boolean} 是否有变更。
 */
function hasChanges(hit) {
  if (hit.hasChanges === true) return true
  const changes = hit.changes
  if (Array.isArray(changes)) return changes.length > 0
  if (!isPlainObject(changes)) return false
  if (changes.lost === true) return true
  return Array.isArray(changes.files) && changes.files.length > 0
}

/** 话题段名：优先名称字段，缺了就退回 laneId（占位，等话题段接进索引）。 */
function laneLabelOf(hit) {
  const lane = isPlainObject(hit.lane) ? hit.lane : {}
  const candidates = [hit.laneTitle, hit.laneName, lane.title, lane.name, hit.laneId]
  for (const candidate of candidates) {
    const text = typeof candidate === 'string' ? candidate.trim() : ''
    if (text !== '') return text
  }
  return ''
}

/** 把关键词输入摊平、小写、去重（内部用，不暴露）。 */
function flattenKeywords(keywords) {
  const list = Array.isArray(keywords)
    ? keywords
    : (keywords === null || keywords === undefined || keywords === '' ? [] : [keywords])
  const out = []
  for (const value of list) {
    if (typeof value !== 'string') continue
    for (const word of value.split(/\s+/)) {
      const keyword = word.trim().toLowerCase()
      if (keyword !== '' && !out.includes(keyword)) out.push(keyword)
    }
  }
  return out
}

/**
 * 在片段里找最早出现的关键词，返回高亮位置。
 *
 * @param {string} snippet - 纯文本片段。
 * @param {string|string[]} [keywords] - 查询关键词。
 * @returns {{start: number, len: number}|null} 0 基偏移与长度；没命中为 null。
 */
function findHighlight(snippet, keywords) {
  const text = typeof snippet === 'string' ? snippet : ''
  if (text === '') return null
  const lower = text.toLowerCase()
  let best = null
  for (const keyword of flattenKeywords(keywords)) {
    const at = lower.indexOf(keyword)
    if (at === -1) continue
    if (best === null || at < best.start) best = { start: at, len: keyword.length }
  }
  return best
}

/** 校验外部传入的 highlight，返回拷贝；非法返回 null。 */
function normalizeHighlight(value) {
  if (!isPlainObject(value)) return null
  const start = Number(value.start)
  const len = Number(value.len)
  if (!Number.isFinite(start) || start < 0) return null
  if (!Number.isFinite(len) || len <= 0) return null
  return { start: Math.floor(start), len: Math.floor(len) }
}

/**
 * 一条命中 → 行模型（供 UI 直接用）。
 *
 * 字段：
 * - `turnLabel / title / timeLabel / snippet / highlight / matchLabel / badges`：显示用；
 * - `laneLabel / statusLabel`：主面板第三行"话题段 · 状态"用；
 * - `sessionId / turn / seq / time`：身份字段，点击定位时不用再回查。
 *
 * `snippet` 是纯文本；高亮只给 `{start, len}`，由调用方自己画。关键词没传时，
 * 若命中自带 `highlight`（searchTurns 后续可直接给）就用它，否则为 null。
 *
 * @param {object} hit - `searchTurns` 的命中。
 * @param {object} [options] - 选项。
 * @param {number|Date} [options.now] - 参照时间（必传，否则 timeLabel 为空）。
 * @param {object|Map|Function} [options.labels] - 状态标签，键 `sessionId#turn`。
 * @param {string|string[]} [options.keywords] - 查询词，用于算高亮位置。
 * @returns {object} 行模型。
 */
export function toRow(hit, options = {}) {
  const source = isPlainObject(hit) ? hit : {}
  const opts = isPlainObject(options) ? options : {}
  const time = source.time ?? source.end ?? source.start
  const title = typeof source.title === 'string' ? source.title.trim() : ''
  const sessionId = source.sessionId === null || source.sessionId === undefined ? '' : String(source.sessionId)
  // null / undefined / '' 都不是"第 0 轮"：不能编造轮次号。
  const turnNumber = source.turn === null || source.turn === undefined || source.turn === ''
    ? NaN
    : Number(source.turn)
  const label = resolveLabel(source, opts.labels)
  const statuses = statusesOf(label)
  const snippet = typeof source.snippet === 'string' ? source.snippet : ''

  const badges = []
  if (isFailure(source)) badges.push('失败')
  if (isInterrupted(source)) badges.push('中断')
  if (hasChanges(source)) badges.push('有变更')
  if (statuses.length > 0) badges.push('已标记')

  return {
    sessionId: source.sessionId ?? null,
    turn: Number.isFinite(turnNumber) ? turnNumber : null,
    seq: source.seq ?? null,
    time: Number.isFinite(toMs(time)) ? toMs(time) : null,
    turnLabel: Number.isFinite(turnNumber) ? `第 ${turnNumber} 轮` : '',
    title: title !== '' ? title : (shortSessionId(sessionId) || '未命名会话'),
    timeLabel: formatRelativeTime(time, opts.now),
    snippet,
    highlight: normalizeHighlight(source.highlight) || findHighlight(snippet, opts.keywords),
    matchLabel: source.matchedIn === 'response' ? '回答命中' : source.matchedIn === 'prompt' ? '提问命中' : '',
    badges,
    laneLabel: laneLabelOf(source),
    statusLabel: statuses.map(status => STATUS_TEXT[status]).join(' · '),
  }
}

/** 第一行：会话 · 第 N 轮 · 时间（空字段不留多余分隔符）。 */
function headLine(row) {
  return [row.title, row.turnLabel, row.timeLabel]
    .filter(part => typeof part === 'string' && part !== '')
    .join(' · ')
}

/**
 * 右栏两行：`会话 · 第 N 轮 · 时间` + 片段。
 *
 * @param {object} row - `toRow` 的产物。
 * @returns {string[]} 两行文字。
 */
export function toTwoLine(row) {
  const source = isPlainObject(row) ? row : {}
  const snippet = typeof source.snippet === 'string' ? source.snippet : ''
  return [headLine(source), snippet]
}

/**
 * 主面板三行：两行 + `话题段 · 状态`。
 *
 * 第三行可能为空串（没有话题段也没有状态），保持数组长度固定，方便按行渲染。
 *
 * @param {object} row - `toRow` 的产物。
 * @returns {string[]} 三行文字。
 */
export function toThreeLine(row) {
  const source = isPlainObject(row) ? row : {}
  const [head, snippet] = toTwoLine(source)
  const foot = [source.laneLabel, source.statusLabel]
    .filter(part => typeof part === 'string' && part !== '')
    .join(' · ')
  return [head, snippet, foot]
}

/**
 * 分数来源一句话（A-14）：`提问×3 · 出现4次×0.8 · 2天前×1.4 · 重要+2`。
 *
 * @param {object} hit - 带 `breakdown.parts` 的命中。
 * @returns {string} 分项拼句；没有拆解时为空串。
 */
export function scoreParts(hit) {
  if (!isPlainObject(hit) || !isPlainObject(hit.breakdown) || !Array.isArray(hit.breakdown.parts)) return ''
  return hit.breakdown.parts
    .map(part => (typeof part === 'string' ? part : isPlainObject(part) && typeof part.text === 'string' ? part.text : ''))
    .filter(text => text !== '')
    .join(' · ')
}

/** 次数类的数字归一：非负整数，非法为 0。 */
function countOf(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
}

/**
 * 会话分组头：`提过 N 次 · M 段 · 最近 <相对时间>`。
 *
 * 没有最近时间时省略"最近 …"一段，不硬拼空文案。
 *
 * @param {object} group - `searchTurns` 的分组对象（`count / lanes / latest`）。
 * @param {object} [options] - 选项。
 * @param {number|Date} [options.now] - 参照时间。
 * @returns {string} 分组头文案。
 */
export function groupHeader(group, options = {}) {
  const source = isPlainObject(group) ? group : {}
  const opts = isPlainObject(options) ? options : {}
  const count = countOf(source.count)
  const lanes = countOf(source.lanes)
  const latest = source.latest ?? source.time ?? source.lastTime ?? null
  const head = `提过 ${count} 次 · ${lanes} 段`
  const relative = formatRelativeTime(latest, opts.now)
  return relative === '' ? head : `${head} · 最近 ${relative}`
}

/** 一条命令是否失败（A-2 的 ✓/✗ 口径）。 */
function isCommandFailed(command) {
  if (!isPlainObject(command)) return false
  if (command.ok === false || command.failed === true || command.status === 'failed') return true
  const exitCode = Number(command.exitCode)
  return Number.isFinite(exitCode) && exitCode !== 0
}

/**
 * 复制结果 → toast 文案（A-2）。
 *
 * 支持的输入形状（按优先级）：
 * - 命令数组：`[{ok}, {exitCode}]` 或 `['git status']`；
 * - `{ commands: [...] }`；
 * - 已聚合的计数：`{ count: 3, failed: 1 }`（也认 `total`）；
 * - 复制的不是命令：`{ text: '…' }` 或 `{ kind: 'conclusion' }`。
 *
 * 文案示例：`已复制 3 条命令（含 1 条失败）`；没有命令时给原因，不冒充成功。
 *
 * @param {Array|object|null} copied - 复制结果。
 * @returns {string} toast 文案。
 */
export function copySummary(copied) {
  const source = isPlainObject(copied) ? copied : {}
  const list = Array.isArray(copied)
    ? copied
    : (Array.isArray(source.commands) ? source.commands : null)

  let total = 0
  let failed = 0
  if (list !== null) {
    total = list.length
    failed = list.filter(isCommandFailed).length
  } else if (Number.isFinite(Number(source.count ?? source.total))) {
    total = Math.max(0, Math.floor(Number(source.count ?? source.total)))
    failed = Math.max(0, Math.min(total, Math.floor(Number(source.failed) || 0)))
  }

  if (total === 0) {
    if (source.kind === 'conclusion' || (typeof source.text === 'string' && source.text.trim() !== '')) {
      return '已复制结论'
    }
    return '没有可复制的命令'
  }
  return failed > 0
    ? `已复制 ${total} 条命令（含 ${failed} 条失败）`
    : `已复制 ${total} 条命令`
}
