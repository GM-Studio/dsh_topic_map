/**
 * 线索视图模型（V-4）：把同一主题下、跨会话的轮次按时间排成一条可读的时间线。
 *
 * 输入 `rows` 由调用方检索好并按时间升序给出；本模块只做"呈现前的一次整形"：
 * 截提问头、算相对时间、标"第几次提及"、把相邻的同会话同日行并成 cluster，
 * 再按 `limit` 截断。**不做二次关键词过滤**——命中可能来自回答、命令或标签，
 * 只靠 `promptHead` 再筛一遍反而会丢掉真实命中；`keywords` 在这里只用来区分
 * "有没有主题词"（没有主题词时给空视图，避免把整个工作区倒出来）。
 *
 * 三条纯函数约束：
 * - 不 `import`（`build-theme` 会把本文件原样嵌进客户端 bundle，`strip()` 只删
 *   import 行、不解析依赖，所以小工具都自带一份）；
 * - 不碰 DOM；
 * - 不读系统时钟——`now` 一律由调用方传入，非法或缺失时 `timeText` 留空，
 *   绝不回退到 `Date.now()`。
 *
 * 聚类口径（相邻 = 输入数组里的连续两行）：
 * - 会话相同且本地自然日相同 → 合并进同一个 cluster；
 * - cluster 的 `time / timeText / turn / head / delta` 取首行；
 * - `delta` 按**行**在会话内累计（合并掉的行仍然计数），cluster 保留首条的
 *   `delta`；`count / turns / lastTime` 记录被合并了多少行、哪些轮、到何时。
 *   这样"首次提及"不会因为同一天又提了一次就被抹掉，而日后的第 N 次仍指
 *   真实累计次数。
 *
 * @module dsh-topic-map/clue-view
 */

/** 默认最多显示多少条 cluster（时间线是浏览用的，不承接全量结果）。 */
const DEFAULT_LIMIT = 200

/** 提问头最多保留的码点数（含省略号）。 */
const HEAD_LIMIT = 60

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只接受字符串文本；数字、对象、null 一律当缺失，避免把对象写进界面。 */
function textOf(value) {
  return typeof value === 'string' ? value : ''
}

/** 压缩连续空白（含换行），用于单行提问头与会话标题。 */
function compress(value) {
  return textOf(value).replace(/\s+/g, ' ').trim()
}

/** 把时间统一成 epoch ms；认 Date 与有限数字，其余返回 NaN。 */
function toMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return NaN
}

/** 轮号：认数字与数字字符串；空白 / 非法返回 null（不悄悄当 0）。 */
function toTurn(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  return null
}

/** 主题词归一：字符串或数组，去空白；全空表示"没有主题词"。 */
function keywordList(value) {
  const list = Array.isArray(value)
    ? value
    : (value === null || value === undefined ? [] : [value])
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const keyword = item.trim()
    if (keyword !== '') out.push(keyword)
  }
  return out
}

/** 显示条数：非法值回默认 200，负数按 0 处理。 */
function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIMIT
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_LIMIT
  return Math.max(0, Math.floor(number))
}

/** 本地自然日的 0 点。 */
function startOfLocalDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 同一本地自然日。 */
function sameLocalDay(a, b) {
  return startOfLocalDay(a) === startOfLocalDay(b)
}

/** 同一本地年份（跨年一律用绝对日期）。 */
function sameLocalYear(a, b) {
  return new Date(a).getFullYear() === new Date(b).getFullYear()
}

/** 本地日期 `YYYY-MM-DD`。 */
function formatDate(ms) {
  const date = new Date(ms)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * 相对时间文案（与 `lib/hit-view.js` 的 `formatRelativeTime` 同口径）。
 *
 * 分档：刚刚 / N 分钟前 / N 小时前 / 今天 / 昨天 / N 天前 / 绝对日期。
 * `ts` 或 `now` 非法时返回空串——绝不回退到系统时钟。
 *
 * @param {number|Date} ts - 目标时间。
 * @param {number|Date} now - 参照时间。
 * @returns {string} 文案；参数非法时为空串。
 */
function formatRelativeTime(ts, now) {
  const target = toMs(ts)
  const base = toMs(now)
  if (!Number.isFinite(target) || !Number.isFinite(base)) return ''
  const diff = base - target
  if (diff < 0) return sameLocalDay(target, base) ? '今天' : formatDate(target)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  const days = Math.round((startOfLocalDay(base) - startOfLocalDay(target)) / DAY)
  if (!sameLocalYear(target, base)) return formatDate(target)
  if (days <= 0) return '今天' // 夏令时等边界兜底
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return formatDate(target)
}

/** 提问头：压缩空白后按码点截断，总长不超过 HEAD_LIMIT（含省略号）。 */
function truncateHead(value) {
  const text = compress(value)
  const points = Array.from(text)
  if (points.length <= HEAD_LIMIT) return text
  return `${points.slice(0, HEAD_LIMIT - 1).join('')}…`
}

/** 空统计的固定形状（每次新建，调用方改自己的副本不会串）。 */
function emptyStats() {
  return { sessions: 0, turns: 0, firstAt: null, lastAt: null, spanDays: 0 }
}

/**
 * 生成线索时间线。
 *
 * @param {Array<object>} rows - `[{sessionId, sessionTitle, turn, time, promptHead, endReason}]`，
 *   已按时间升序；没有可用 `time` 的行会被跳过（时间线无法定位它）。
 * @param {object} [options] - 选项。
 * @param {string|string[]} [options.keywords] - 主题词；为空时直接返回空视图。
 * @param {number|Date} [options.now] - 参照时间，用于 `timeText`；不传则留空。
 * @param {number} [options.limit=200] - 最多显示多少个 cluster（不影响 stats）。
 * @returns {{timeline: Array<object>, stats: object, empty: boolean}} 视图模型。
 */
export function buildClue(rows, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const keywords = keywordList(opts.keywords)
  if (keywords.length === 0) {
    return { timeline: [], stats: emptyStats(), empty: true }
  }

  const list = Array.isArray(rows) ? rows : []
  const now = toMs(opts.now)
  const limit = normalizeLimit(opts.limit)

  // 第一遍：筛掉没有可用时间的行，同时算"该会话的第几次提及"。
  // 次数按行累计，而不是按 cluster 累计；这样 cluster 里的第 2 条被合并后，
  // 后面的真实第 3 次仍然显示"第 3 次"。
  const mentions = new Map()
  const items = []
  for (const raw of list) {
    if (!isPlainObject(raw)) continue
    const time = toMs(raw.time)
    if (!Number.isFinite(time)) continue
    const sessionKey = raw.sessionId === null || raw.sessionId === undefined
      ? ''
      : String(raw.sessionId)
    const ordinal = (mentions.get(sessionKey) || 0) + 1
    mentions.set(sessionKey, ordinal)
    items.push({
      time,
      sessionKey,
      ordinal,
      turn: toTurn(raw.turn),
      head: truncateHead(raw.promptHead),
      sessionTitle: compress(raw.sessionTitle),
    })
  }

  // 第二遍：统计按"全部命中"算，limit 只影响显示条数。
  let firstAt = null
  let lastAt = null
  const sessions = new Set()
  for (const item of items) {
    sessions.add(item.sessionKey)
    if (firstAt === null || item.time < firstAt) firstAt = item.time
    if (lastAt === null || item.time > lastAt) lastAt = item.time
  }
  const spanDays = firstAt === null
    ? 0
    : Math.max(0, Math.round((startOfLocalDay(lastAt) - startOfLocalDay(firstAt)) / DAY))
  const stats = {
    sessions: sessions.size,
    turns: items.length,
    firstAt,
    lastAt,
    spanDays,
  }

  // 第三遍：相邻同会话同自然日合并成 cluster。
  const clusters = []
  let current = null
  for (const item of items) {
    const dayKey = formatDate(item.time)
    if (
      current !== null &&
      current.sessionKey === item.sessionKey &&
      current.dayKey === dayKey
    ) {
      current.count += 1
      current.lastTime = item.time
      if (item.turn !== null) current.turns.push(item.turn)
      continue
    }

    current = {
      sessionKey: item.sessionKey,
      dayKey,
      time: item.time,
      timeText: formatRelativeTime(item.time, now),
      sessionId: item.sessionKey,
      sessionTitle: item.sessionTitle,
      turn: item.turn,
      head: item.head,
      delta: item.ordinal === 1 ? '首次提及' : `第 ${item.ordinal} 次`,
      count: 1,
      turns: item.turn === null ? [] : [item.turn],
      lastTime: item.time,
    }
    clusters.push(current)
  }

  const timeline = clusters.slice(0, limit).map(cluster => ({
    time: cluster.time,
    timeText: cluster.timeText,
    sessionId: cluster.sessionId,
    sessionTitle: cluster.sessionTitle,
    turn: cluster.turn,
    head: cluster.head,
    delta: cluster.delta,
    count: cluster.count,
    turns: cluster.turns,
    lastTime: cluster.lastTime,
  }))

  return { timeline, stats, empty: timeline.length === 0 }
}
