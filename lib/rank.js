/**
 * 相关度排序（S-5）：给检索命中打分并排序。
 *
 * 为什么单独成模块：同一个公式有三处消费者——检索内核（默认排序）、
 * 界面（"为什么排第一"的拆解）、设置页（C-2 权重）。写在渲染层里就没法
 * 单独验证，所以这里只做纯函数：输入命中数组，输出带分数与拆解的新数组。
 *
 * 公式（默认权重，见 spec S-5 / design §5）：
 * ```
 * 3×命中在提问 + 1×命中在回答 + 0.2×min(命中次数, 10)
 * + 2×时间新鲜度（今天 1.0 / 本周 0.7 / 本月 0.4 / 更早 0.2）
 * + 状态加权（重要 +2 / 已解决 +1 / 待跟进 +0.5）
 * ```
 * 每条结果带 `breakdown`：五个分项的贡献值 + 可直接显示的 `parts`
 * （如 `提问×3 · 出现4次×0.8 · 2天前×1.4 · 重要+2`）。
 *
 * 口径决定（写下来免得以后猜）：
 * - "今天 / 本周 / 本月"按**本地自然日**倒推（今天、近 7 天、近 30 天），
 *   不是日历周/月。design §5 的示例"2天前×1.4"只有滚动天数才成立。
 * - 三个状态开关默认**相加**（A-3 允许叠用，公式本身是加项）；
 *   需要"只取最高"时传 `statusMode: 'max'`。
 * - 状态来源支持命中自带的 `label`，也支持 `labels` 参数（对象 / Map / 函数），
 *   键沿用 design §4 的 `sessionId#turn`。
 *
 * @module dsh-topic-map/rank
 */

/** 默认权重（C-2 的五个可配置项；`matchCap` 是公式里的封顶值 10）。 */
export const DEFAULT_WEIGHTS = Object.freeze({
  inPrompt: 3,      // 命中在提问
  inResponse: 1,    // 命中在回答
  match: 0.2,       // 每命中一次
  matchCap: 10,     // 命中次数封顶（min(matchCount, 10)）
  recency: 2,       // 时间新鲜度的乘数
  status: Object.freeze({ starred: 2, solved: 1, followUp: 0.5 }),
})

/** 时间新鲜度四档（S-5）。 */
export const RECENCY_TIERS = Object.freeze({
  today: 1,
  week: 0.7,
  month: 0.4,
  older: 0.2,
})

/** 状态的中文文案（与 spec 的"重要 / 已解决 / 待跟进"对齐）。 */
const STATUS_LABELS = Object.freeze({ starred: '重要', solved: '已解决', followUp: '待跟进' })

/** 状态的固定顺序：拆解与 max 模式的并列都按它取。 */
const STATUS_ORDER = Object.freeze(['starred', 'solved', 'followUp'])

/** 保留三位小数：界面显示与"同分"判定都用它，避免 0.1+0.2 的浮点噪音。 */
function round3(n) {
  const v = Number(n)
  if (!Number.isFinite(v)) return 0
  return Math.round(v * 1000) / 1000
}

/** 数字转显示文本（去掉无意义的尾零）。 */
function fmt(n) {
  return String(round3(n))
}

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
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 一条时间的新鲜度分档。
 *
 * "几天前"按本地自然日算：同一自然日 = 今天，跨过本地零点才算一天。
 * 未来时间按今天处理（时钟回拨或宿主时间偏差时不该倒扣分）。
 *
 * @param {number|Date} time - 该轮的时间（epoch ms）。
 * @param {number|Date} now - 当前时间（epoch ms）。
 * @returns {{days: number|null, tier: number, label: string}} 天数、档位系数、显示文案。
 */
export function recencyOf(time, now = Date.now()) {
  const t = toMs(time)
  const n = toMs(now)
  if (!Number.isFinite(t) || !Number.isFinite(n)) {
    return { days: null, tier: RECENCY_TIERS.older, label: '时间未知' }
  }
  // 用四舍五入吸收夏令时造成的 23/25 小时日长（Windows 上同样是本地区时）。
  const days = Math.max(0, Math.round((startOfLocalDay(n) - startOfLocalDay(t)) / 86400000))
  if (days === 0) return { days, tier: RECENCY_TIERS.today, label: '今天' }
  if (days < 7) return { days, tier: RECENCY_TIERS.week, label: `${days}天前` }
  if (days < 30) return { days, tier: RECENCY_TIERS.month, label: `${days}天前` }
  return { days, tier: RECENCY_TIERS.older, label: `${days}天前` }
}

/**
 * 命中的标签键：`sessionId#turn`（design §4 的 labels 键口径）。
 *
 * @param {object} hit - 命中（至少带 sessionId / turn）。
 * @returns {string} 标签键；信息不全时退化为 turn 或空串。
 */
export function labelKeyOf(hit) {
  if (!isPlainObject(hit)) return ''
  const sid = hit.sessionId
  const turn = hit.turn
  if (sid === null || sid === undefined || sid === '') {
    return turn === null || turn === undefined ? '' : String(turn)
  }
  if (turn === null || turn === undefined) return String(sid)
  return `${sid}#${turn}`
}

/**
 * 从标签仓库里取一条标签（不读文件，只查传入的索引）。
 *
 * 支持三种来源：函数 `(hit) => label`、`Map`、普通对象（键 `sessionId#turn`）。
 * 找不到时回退到命中自带的 `hit.label`，这样检索结果可以"预先带上"标签。
 *
 * @param {object} hit - 命中。
 * @param {Function|Map|object} [labels] - 标签仓库。
 * @returns {object|string|Array|null} 标签；无则 null。
 */
export function resolveLabel(hit, labels) {
  if (typeof labels === 'function') {
    const value = labels(hit)
    if (value !== undefined && value !== null) return value
  } else if (labels instanceof Map || isPlainObject(labels)) {
    const key = labelKeyOf(hit)
    const bare = isPlainObject(hit) && hit.turn !== null && hit.turn !== undefined ? String(hit.turn) : ''
    const lookup = k => (labels instanceof Map ? (labels.has(k) ? labels.get(k) : undefined) : labels[k])
    if (key !== '' && lookup(key) !== undefined) return lookup(key)
    // 只有 turn 的旧数据键也认，避免早期标签整批失效。
    if (bare !== '' && lookup(bare) !== undefined) return lookup(bare)
  }
  if (isPlainObject(hit) && hit.label !== undefined && hit.label !== null) return hit.label
  return null
}

/**
 * 把各种标签形状归一成三个状态键（顺序固定）。
 *
 * @param {object|string|Array|null} label - 标签。
 * @returns {string[]} 生效的状态：`starred / solved / followUp` 的子集。
 */
export function statusesOf(label) {
  if (!label) return []
  if (typeof label === 'string') {
    const raw = label.trim().toLowerCase()
    return STATUS_ORDER.filter(s => s.toLowerCase() === raw)
  }
  if (Array.isArray(label)) return STATUS_ORDER.filter(s => label.includes(s))
  if (!isPlainObject(label)) return []
  return STATUS_ORDER.filter(s => Boolean(label[s]))
}

/** 取有限数字，否则回退默认值。 */
function numOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 合并权重：只认已知键，非法值回退默认，避免配置写错就打不出分。 */
function mergeWeights(input) {
  const src = isPlainObject(input) ? input : {}
  const statusSrc = isPlainObject(src.status) ? src.status : {}
  const status = {}
  for (const key of STATUS_ORDER) status[key] = numOr(statusSrc[key], DEFAULT_WEIGHTS.status[key])
  const matchCap = numOr(src.matchCap, DEFAULT_WEIGHTS.matchCap)
  return {
    inPrompt: numOr(src.inPrompt, DEFAULT_WEIGHTS.inPrompt),
    inResponse: numOr(src.inResponse, DEFAULT_WEIGHTS.inResponse),
    match: numOr(src.match, DEFAULT_WEIGHTS.match),
    // 封顶值为 0 时公式会退化成"命中次数一律不算"，这里按配置错误处理。
    matchCap: matchCap > 0 ? matchCap : DEFAULT_WEIGHTS.matchCap,
    recency: numOr(src.recency, DEFAULT_WEIGHTS.recency),
    status,
  }
}

/** 命中次数：非负整数，缺失按 0。 */
function matchCountOf(hit) {
  const n = Number(hit.matchCount)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.floor(n)
}

/** 状态加分的显示片段。 */
function statusPart(key, value) {
  const label = STATUS_LABELS[key] ?? key
  return { key: 'status', text: value < 0 ? `${label}${fmt(value)}` : `${label}+${fmt(value)}`, value }
}

/**
 * 算一条命中的分数与拆解。
 *
 * @param {object} hit - 命中。
 * @param {object} ctx - `{ now, weights, labels, statusMode }`。
 * @returns {object} 原命中字段的浅拷贝 + `score` + `breakdown`。
 */
function scoreHit(hit, ctx) {
  const weights = ctx.weights
  const count = matchCountOf(hit)
  // 检索内核会显式给出 inPrompt / inResponse；只有 matchedIn 时按它推断。
  const inPrompt = typeof hit.inPrompt === 'boolean' ? hit.inPrompt : hit.matchedIn === 'prompt'
  const inResponse = typeof hit.inResponse === 'boolean' ? hit.inResponse : hit.matchedIn === 'response'
  const recency = recencyOf(hit.time ?? hit.end ?? hit.start, ctx.now)
  const statuses = statusesOf(resolveLabel(hit, ctx.labels))

  const parts = []
  const promptValue = inPrompt ? round3(weights.inPrompt) : 0
  const responseValue = inResponse ? round3(weights.inResponse) : 0
  const matchValue = count > 0 ? round3(weights.match * Math.min(count, weights.matchCap)) : 0
  const recencyValue = round3(weights.recency * recency.tier)

  if (inPrompt && promptValue !== 0) {
    parts.push({ key: 'inPrompt', text: `提问×${fmt(weights.inPrompt)}`, value: promptValue })
  }
  if (inResponse && responseValue !== 0) {
    parts.push({ key: 'inResponse', text: `回答×${fmt(weights.inResponse)}`, value: responseValue })
  }
  if (matchValue !== 0) {
    parts.push({ key: 'match', text: `出现${count}次×${fmt(matchValue)}`, value: matchValue })
  }
  if (recencyValue !== 0) {
    parts.push({ key: 'recency', text: `${recency.label}×${fmt(recencyValue)}`, value: recencyValue })
  }

  let statusValue = 0
  if (ctx.statusMode === 'max') {
    // 只取最高的一项：叠了三个开关时分数不会被状态项垄断。
    let best = null
    for (const key of statuses) {
      const weight = weights.status[key]
      if (!Number.isFinite(weight)) continue
      if (best === null || weight > best.weight) best = { key, weight }
    }
    if (best !== null && best.weight !== 0) {
      statusValue = round3(best.weight)
      parts.push(statusPart(best.key, statusValue))
    }
  } else {
    for (const key of statuses) {
      const value = round3(weights.status[key])
      if (!Number.isFinite(value) || value === 0) continue
      statusValue = round3(statusValue + value)
      parts.push(statusPart(key, value))
    }
  }

  const total = round3(parts.reduce((sum, part) => sum + part.value, 0))
  const breakdown = {
    inPrompt: promptValue,
    inResponse: responseValue,
    match: matchValue,
    recency: recencyValue,
    status: statusValue,
    total,
    parts,
    matchCount: count,
    recencyTier: recency.tier,
    recencyDays: recency.days,
    statuses,
  }

  return { ...hit, score: total, breakdown }
}

/** 轮次比较：数字优先，其余按字符串；保证"同分按 turn 升序"可预测。 */
function compareTurn(a, b) {
  const na = a === '' || a === null || a === undefined ? NaN : Number(a)
  const nb = b === '' || b === null || b === undefined ? NaN : Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  const sa = a === null || a === undefined ? '' : String(a)
  const sb = b === null || b === undefined ? '' : String(b)
  if (sa === sb) return 0
  return sa < sb ? -1 : 1
}

/**
 * 给命中打分并排序（S-5）。
 *
 * 纯函数：不修改 `hits`，返回浅拷贝的新数组；同分按 `turn` 升序，
 * 分数与轮次都相同时保留输入顺序（`Array#sort` 稳定）。
 *
 * @param {Array} hits - 命中数组（字段见 design：`matchedIn / matchCount / time / turn / sessionId`）。
 * @param {object} [options] - 选项。
 * @param {number|Date} [options.now] - "现在"（默认 `Date.now()`），用于新鲜度分档。
 * @param {object} [options.weights] - 五项权重的覆盖（缺省项用 S-5 默认值）。
 * @param {object|Map|Function} [options.labels] - 标签仓库，键 `sessionId#turn`。
 * @param {'sum'|'max'} [options.statusMode] - 状态叠加方式，默认 `sum`。
 * @returns {Array} 排序后的命中，每条带 `score` 与 `breakdown`。
 */
export function rankHits(hits, options = {}) {
  const list = Array.isArray(hits) ? hits : []
  const opts = isPlainObject(options) ? options : {}
  const now = Number.isFinite(toMs(opts.now)) ? toMs(opts.now) : Date.now()
  const weights = mergeWeights(opts.weights)
  const ctx = {
    now,
    weights,
    labels: opts.labels,
    statusMode: opts.statusMode === 'max' ? 'max' : 'sum',
  }
  const scored = list.filter(isPlainObject).map(hit => scoreHit(hit, ctx))
  scored.sort((a, b) => (b.score - a.score) || compareTurn(a.turn, b.turn))
  return scored
}
