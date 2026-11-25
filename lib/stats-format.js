/**
 * 统计展示格式化：把 `buildStats` / 会话列表的输出变成页头卡片、会话行与用量拆分。
 *
 * 纯函数约定：不 import、不碰 DOM、不读系统时钟——`now` 一律由参数传入；
 * 本文件稍后由 `build-theme` 原样嵌进客户端 bundle，所以小工具自带一份。
 *
 * 为什么这里又写了一遍紧凑数字 / 费用格式（**有意的重复**）：嵌入机制只删
 * `import` 行、不解析依赖；`lib/stats-view.js` 的口径在浏览器里不一定同作用域，
 * 独立成文件后必须能单独跑测试。两处口径（`formatCompact` / `formatCost`）
 * 保持一致，改口径时一起改，测试分别覆盖。
 *
 * @module dsh-topic-map/stats-format
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 「更早」阈值：超过 30 天不再报具体天数（与统计页停滞口径一致）。 */
const EARLIER_DAYS = 30

const UNKNOWN_RELATIVE = '未知'

/** 会话行默认上限（Top 列表一屏的量）。 */
const DEFAULT_ROW_LIMIT = 10

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

/** 非负有限值；缺失 / 负数 / NaN 一律记 0。 */
function toNonNegative(value) {
  if (value === null || value === undefined || value === '') return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return number
}

/** 非负整数（轮数 / 会话数）；缺失或非法记 0。 */
function toCount(value) {
  return Math.trunc(toNonNegative(value))
}

/** 统一成可显示文本；对象 / null 返回空串。 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 压缩连续空白。 */
function compress(value) {
  return textOf(value).replace(/\s+/g, ' ').trim()
}

/** 保留一位小数并去掉 `.0`（1.234 → 1.2，2 → 2）。 */
function trimOneDecimal(value) {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/**
 * 紧凑数字：`0` / `999` / `1.2k` / `12.3k` / `1.2M`。
 *
 * 与 `lib/stats-view.js` 的 `formatCompact` 同口径：四舍五入到一位小数、
 * 999.95 这类进位值直接升档，不输出 `1000k`。
 *
 * @param {number} value - 数字。
 * @returns {string} 紧凑文案；非法输入记 `0`。
 */
function compactNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  const sign = number < 0 ? '-' : ''
  const abs = Math.abs(number)
  const rounded = Math.round(abs)
  if (rounded < 1000) return `${sign}${rounded}`
  if (rounded < 1000000) {
    const thousands = Math.round(abs / 100) / 10
    if (thousands < 1000) return `${sign}${trimOneDecimal(thousands)}k`
  }
  const millions = Math.round(abs / 100000) / 10
  return `${sign}${trimOneDecimal(millions)}M`
}

/**
 * 千分位整数：`0` / `999` / `1,234` / `123,456`。
 *
 * @param {number} value - 数字。
 * @returns {string} 千分位文案；非法输入记 `0`。
 */
function thousands(value) {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return '0'
  const sign = number < 0 ? '-' : ''
  return sign + String(Math.abs(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 费用：`$0.00` / `$1.23` / `$12.3` / `<$0.01`。
 *
 * 与 `lib/stats-view.js` 的 `formatCost` 同口径。
 *
 * @param {number} value - 金额（美元）。
 * @returns {string} 费用文案。
 */
function costText(value) {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '$0.00'
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  if (abs === 0) return '$0.00'
  if (abs < 0.01) return '<$0.01'
  const rounded = Math.round(abs * 100) / 100
  if (rounded >= 10) return `${sign}$${(Math.round(rounded * 10) / 10).toFixed(1)}`
  return `${sign}$${rounded.toFixed(2)}`
}

/**
 * 相对时间：`刚刚` / `N 分钟前` / `N 小时前` / `N 天前` / `更早`。
 *
 * - 未来时间与 1 分钟内都算「刚刚」；
 * - 分钟 / 小时向下取整；超过 30 天统一「更早」；
 * - 任一时间非法返回「未知」，不读系统时钟。
 *
 * @param {number|Date} ms - 目标时间。
 * @param {number|Date} now - 参照时间。
 * @returns {string} 相对时间文案。
 */
export function formatRelative(ms, now) {
  const target = toMs(ms)
  const base = toMs(now)
  if (!Number.isFinite(target) || !Number.isFinite(base)) return UNKNOWN_RELATIVE
  const diff = base - target
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  const days = Math.floor(diff / DAY)
  return days <= EARLIER_DAYS ? `${days} 天前` : '更早'
}

/**
 * 统计页头四卡：会话数、轮次数、活跃天数、总用量。
 *
 * 兼容 `buildStats()` 的 `{totals}` 包装与直接 totals 两种输入。
 * 计数用千分位，用量用紧凑数字；`now` 不参与页头，活跃天数按调用方口径直出。
 *
 * @param {object} stats - 统计模型或 totals。
 * @returns {{label: string, value: string, hint: string}[]} 四张卡片。
 */
export function statsHeadline(stats) {
  const source = isPlainObject(stats) ? stats : {}
  const totals = isPlainObject(source.totals) ? source.totals : source
  const tokens = isPlainObject(totals.tokens) ? totals.tokens : {}
  const sessions = toCount(totals.sessions)
  const turns = toCount(totals.turns)
  const activeDays = toCount(totals.activeDays)
  const input = toNonNegative(tokens.input)
  const output = toNonNegative(tokens.output)
  const total = input + output > 0 ? input + output : toNonNegative(tokens.total)
  const cost = toNonNegative(totals.cost)

  let usageHint = `输入 ${compactNumber(input)} · 输出 ${compactNumber(output)}`
  if (cost > 0) usageHint += ` · ${costText(cost)}`

  return [
    { label: '会话数', value: thousands(sessions), hint: '工作区内的会话' },
    { label: '轮次数', value: thousands(turns), hint: '累计对话轮次' },
    { label: '活跃天数', value: `${thousands(activeDays)} 天`, hint: '有活动的自然日' },
    { label: '总用量', value: `${compactNumber(total)} tokens`, hint: usageHint },
  ]
}

/** 行上限归一：缺省 10，非法回 10，显式 0 / 负数表示不显示。 */
function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_ROW_LIMIT
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_ROW_LIMIT
  return Math.max(0, Math.floor(number))
}

/** 会话轮数：认 `turnCount` 与 `turns` 两种字段名。 */
function turnsOf(session) {
  return toCount(session.turnCount ?? session.turns)
}

/**
 * 统计页会话行：标题、轮数、最近活动、相对最大值 bar。
 *
 * - 保持调用方给的顺序（`topSessions` 已排好），只按 `limit` 截断；
 * - `barPercent` 以**完整输入列表**的最大轮数为分母计算，再夹到 0–100；
 * - 轮数为 0 或全为 0 时 bar 记 0，不会出现除零。
 *
 * @param {object[]} topSessions - 会话行输入 `[{title, turnCount|turns, lastActivity}]`。
 * @param {object} [options] - 选项。
 * @param {number|Date} [options.now] - 参照时间；缺省时相对时间显示「未知」。
 * @param {number} [options.limit=10] - 最多返回几行。
 * @returns {{title: string, turns: string, lastActiveText: string, barPercent: number}[]} 可渲染行。
 */
export function statsRows(topSessions, options) {
  const opts = isPlainObject(options) ? options : {}
  const list = (Array.isArray(topSessions) ? topSessions : []).filter(isPlainObject)
  const limit = normalizeLimit(opts.limit)
  const now = toMs(opts.now)

  let maxTurns = 0
  for (const session of list) {
    const turns = turnsOf(session)
    if (turns > maxTurns) maxTurns = turns
  }

  return list.slice(0, limit).map(session => {
    const turns = turnsOf(session)
    const barPercent = maxTurns > 0
      ? Math.min(100, Math.max(0, Math.round((turns / maxTurns) * 100)))
      : 0
    return {
      title: compress(session.title) || '未命名会话',
      turns: thousands(turns),
      lastActiveText: formatRelative(session.lastActivity, now),
      barPercent,
    }
  })
}

/**
 * 用量拆分：输入 / 输出 / 总量文本 + 输出占比。
 *
 * `ratio` 是输出 token 占总量（input+output）的比例，保留两位小数（0–1）；
 * 同时给了 input/output 时不信上游声明的 total，避免缓存 token 重复计数。
 *
 * @param {object} usage - `{input, output, total?}`。
 * @returns {{inputText: string, outputText: string, totalText: string, ratio: number}} 拆分结果。
 */
export function usageSplit(usage) {
  const source = isPlainObject(usage) ? usage : {}
  const input = toNonNegative(source.input)
  const output = toNonNegative(source.output)
  const declared = toNonNegative(source.total)
  const total = input + output > 0 ? input + output : declared
  const ratio = total > 0 ? Math.round((output / total) * 100) / 100 : 0
  return {
    inputText: compactNumber(input),
    outputText: compactNumber(output),
    totalText: compactNumber(total),
    ratio,
  }
}
