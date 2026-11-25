/**
 * 统计视图模型（V-5）：把工作区会话按大类 / 子类聚合成可排序、可格式化的纯数据。
 *
 * 三条产品口径（spec V-5、ui.md §3 统计页签）：
 * 1. **活跃度是第一指标**：`sortCategories` 默认按 `metrics.lastActivity` 倒序，
 *    不是按会话数或 token 量。"大而慢"的类会排在"小而新"的类后面。
 * 2. **用量是第二层**：turns / tokens / cost / durationMs 只在同屏对比时用，
 *    默认不参与排序；调用方显式传 `by` 才切成按量排序。
 * 3. **结构健康单独出**：未归类、未收尾、空类、停滞类各自可数，见 `health`。
 *
 * 纯函数约定：不 import（`build-theme` 会把本文原样嵌进浏览器 bundle，`strip()`
 * 只删 import 行、不解析依赖，所以这里连小工具都自带一份）、不读 DOM、
 * 不读系统时钟——`now` 一律由调用方传入；没传时 `activeDays` 记 0、
 * `stale` 判定直接跳过，绝不偷偷调用 `Date.now()`。
 * 输入数组与对象只读，返回的都是新对象；「未归类」兜底桶永远排在最后。
 *
 * @module dsh-topic-map/stats-view
 */

/** 「未归类」是保留名：出现在 topicPath 第一段即视为未归类。 */
const UNCATEGORIZED_NAME = '未归类'

/** 活跃天数默认窗口（V-5：近 30 天）。 */
const DEFAULT_WINDOW_DAYS = 30

/** 判"停滞"的天数阈值：最后活动超过 30 天。 */
const STALE_DAYS = 30

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// ── 基础工具 ──────────────────────────────────────────────────────────

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

/** 把时间统一成 epoch ms；认 Date 与数字，其余返回 NaN。 */
function toMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return NaN
}

/** 时间戳：非法返回 null（统计里"没有时间"与 0 点不是一回事）。 */
function toTime(value) {
  const ms = toMs(value)
  return Number.isFinite(ms) ? ms : null
}

/** 非负有限的计量值；缺失、负数、NaN 一律记 0。 */
function toNonNegative(value) {
  if (value === null || value === undefined || value === '') return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return number
}

/** 非负整数（轮数 / 段数）；缺失或非法记 0。 */
function toCount(value) {
  return Math.trunc(toNonNegative(value))
}

/** 本地日期 `YYYY-MM-DD`（同时用作"自然日"的去重键）。 */
function formatDate(ms) {
  const date = new Date(ms)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 保留一位小数并去掉 `.0`（1.234 → 1.2，2 → 2）。 */
function trimOneDecimal(value) {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** 金额求和后收敛到 6 位小数，避免 0.1+0.2 这类浮点尾巴进界面。 */
function roundCost(value) {
  return Math.round(value * 1e6) / 1e6
}

/** 活跃窗口天数：未传 / 非法回默认 30，显式 0 表示空窗口。 */
function normalizeWindowDays(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_WINDOW_DAYS
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_WINDOW_DAYS
  return Math.max(0, Math.floor(number))
}

/**
 * 解析 `topicPath` 为 `{ category, subcategory }`。
 *
 * 认三种输入：
 * - 字符串 `'大类 › 子类'`（也容忍 `>` 作分隔符）；
 * - 数组 `['大类', '子类']`（元素可为 `{title}` / `{name}`）；
 * - 其它（空 / 缺 / `'未归类'` / 空串）→ `null`，由调用方归到兜底桶。
 *
 * 只有一段（如 `'插件开发'`）时子类名记空串，表示"归了大类但未细分"，
 * 不算未归类。超过两段的路径只取前两段（V-5 是两层聚合）。
 *
 * @param {*} value - 会话的 `topicPath`。
 * @returns {{category: string, subcategory: string}|null} 解析结果。
 */
function parseTopicPath(value) {
  let parts
  if (Array.isArray(value)) {
    parts = value.map(part => compress(
      isPlainObject(part) ? (part.title ?? part.name ?? part.label) : part,
    ))
  } else if (typeof value === 'string') {
    parts = value.split(/\s*[›>]\s*/).map(compress)
  } else {
    return null
  }
  const cleaned = parts.filter(text => text !== '')
  if (cleaned.length === 0) return null
  // 「未归类」是兜底语义，不是真大类；即使写成 `未归类 › x` 也按兜底算。
  if (cleaned[0] === UNCATEGORIZED_NAME) return null
  return {
    category: cleaned[0],
    subcategory: cleaned.length > 1 ? cleaned[1] : '',
  }
}

// ── 会话输入归一化 ────────────────────────────────────────────────────

/**
 * 把一条会话输入摊平成聚合用的内部条目。
 *
 * 缺字段全部安全降级：`cost` / `durationMs` / `turnCount` / `openLaneCount`
 * 记 0，`tokens` 记 `{input:0, output:0, total:0}`，`lastActivity` 记 `null`。
 *
 * @param {object} session - 输入会话。
 * @returns {object} 内部条目（含原始对象与解析后的归类路径）。
 */
function normalizeItem(session) {
  const tokens = isPlainObject(session.tokens) ? session.tokens : {}
  const input = toNonNegative(tokens.input)
  const output = toNonNegative(tokens.output)
  const declared = toNonNegative(tokens.total)
  return {
    raw: session,
    id: compress(session.sessionId ?? session.id),
    title: compress(session.title),
    turnCount: toCount(session.turnCount),
    tokens: {
      input,
      output,
      // 只有 input/output 都缺、上游直接给了 total 时才拿 total 兜底；
      // 两者都在时 total = input + output，避免缓存 token 被重复计数。
      total: input + output > 0 ? input + output : declared,
    },
    cost: toNonNegative(session.cost),
    durationMs: toNonNegative(session.durationMs),
    lastActivity: toTime(session.lastActivity),
    openLaneCount: toCount(session.openLaneCount),
    solved: session.solved === true,
    followUp: session.followUp === true,
    starred: session.starred === true,
    path: parseTopicPath(session.topicPath),
    // 由归类阶段写入，供会话行回显。
    subcategory: '',
    // 会话行缓存：同一条会话在大类 / 子类两个列表里复用一个只读对象。
    row: null,
  }
}

/**
 * 会话行（统计页展开某个类时列会话用）。
 *
 * @param {object} item - 内部条目。
 * @returns {object} 只读的会话摘要。
 */
function rowOf(item) {
  if (item.row === null) {
    item.row = {
      sessionId: item.id,
      title: item.title,
      turnCount: item.turnCount,
      tokens: { ...item.tokens },
      cost: item.cost,
      durationMs: item.durationMs,
      lastActivity: item.lastActivity,
      openLaneCount: item.openLaneCount,
      solved: item.solved,
      followUp: item.followUp,
      starred: item.starred,
      subcategory: item.subcategory,
    }
  }
  return item.row
}

/** 会话行排序：最后活动倒序，无时间的排最后，再按 sessionId 稳定。 */
function compareRows(left, right) {
  const leftTime = Number.isFinite(left.lastActivity) ? left.lastActivity : -Infinity
  const rightTime = Number.isFinite(right.lastActivity) ? right.lastActivity : -Infinity
  if (leftTime !== rightTime) return rightTime - leftTime
  const leftId = textOf(left.sessionId)
  const rightId = textOf(right.sessionId)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

// ── 聚合 ──────────────────────────────────────────────────────────────

/**
 * 一组会话的指标（V-5 的"度量"层）。
 *
 * - `lastActivity`：组内最大时间戳，全无时间时为 `null`；
 * - `activeDays`：组内成员近 `windowDays` 天有活动的不同自然日数，`now` 缺省时 0；
 * - `openLanes`：未收尾段数之和；
 * - `unsolved`：未标已解决的会话数（`sessions - solved`）。
 *
 * @param {object[]} members - 内部条目。
 * @param {number|null} now - 参照时间（epoch ms），可为 null。
 * @param {number} windowDays - 活跃窗口天数。
 * @returns {object} metrics。
 */
function metricsOf(members, now, windowDays) {
  let turns = 0
  let input = 0
  let output = 0
  let total = 0
  let cost = 0
  let durationMs = 0
  let openLanes = 0
  let solved = 0
  let starred = 0
  let lastActivity = null
  for (const item of members) {
    turns += item.turnCount
    input += item.tokens.input
    output += item.tokens.output
    total += item.tokens.total
    cost += item.cost
    durationMs += item.durationMs
    openLanes += item.openLaneCount
    if (item.solved) solved += 1
    if (item.starred) starred += 1
    if (item.lastActivity !== null && (lastActivity === null || item.lastActivity > lastActivity)) {
      lastActivity = item.lastActivity
    }
  }
  return {
    sessions: members.length,
    turns,
    tokens: {
      input,
      output,
      total,
    },
    cost: roundCost(cost),
    durationMs,
    lastActivity,
    activeDays: activeDaysOf(members, { now, windowDays }),
    openLanes,
    solved,
    unsolved: members.length - solved,
    starred,
  }
}

/** 新建不重复的 key（重名大类 / 子类补 `#2`）。 */
function createKeyFactory() {
  const used = new Set()
  return (prefix, name) => {
    const base = `${prefix}:${name}`
    let key = base
    let index = 2
    while (used.has(key)) {
      key = `${base}#${index}`
      index += 1
    }
    used.add(key)
    return key
  }
}

/**
 * 输出一个聚合组：会话行按活动倒序，子类保持结构顺序。
 *
 * @param {object} bucket - 内部桶（大类）。
 * @param {number|null} now - 参照时间。
 * @param {number} windowDays - 活跃窗口天数。
 * @returns {{key: string, name: string, sessions: object[], metrics: object, subcategories: object[]}} 大类输出。
 */
function finalizeCategory(bucket, now, windowDays) {
  const subcategories = bucket.subs.map(sub => ({
    key: sub.key,
    name: sub.name,
    sessions: sub.members.map(rowOf).sort(compareRows),
    metrics: metricsOf(sub.members, now, windowDays),
  }))
  const members = bucket.members.concat(...bucket.subs.map(sub => sub.members))
  return {
    key: bucket.key,
    name: bucket.name,
    sessions: members.map(rowOf).sort(compareRows),
    metrics: metricsOf(members, now, windowDays),
    subcategories,
  }
}

/** 取子类（没有就按名字补一个，空名子类表示"未细分"）。 */
function ensureSub(makeKey, category, name) {
  const existing = category.subByName.get(name)
  if (existing !== undefined) return existing
  const sub = {
    key: makeKey('sub', `${category.name}/${name}`),
    name,
    members: [],
  }
  category.subByName.set(name, sub)
  category.subs.push(sub)
  return sub
}

/** 新建大类桶。 */
function createBucket(makeKey, name) {
  return {
    key: makeKey('cat', name),
    name,
    members: [],
    subs: [],
    subByName: new Map(),
  }
}

/**
 * 把 `tree` 子类自带的 `sessions` 记成"会话 → 位置"映射。
 *
 * 位置优先于 `topicPath`：树上已明确挂好的会话，即使路径写得不一样也按树走。
 * 同一会话在一棵树里重复出现时先到先得（后出现的忽略）。
 *
 * @param {*} list - 子类 / 大类上的 sessions。
 * @param {Map<string, object>} membership - 输出映射。
 * @param {object} category - 大类桶。
 * @param {object|null} sub - 子类桶；null 表示直挂大类。
 */
function collectSessionIds(list, membership, category, sub) {
  if (!Array.isArray(list)) return
  for (const entry of list) {
    const id = typeof entry === 'string'
      ? compress(entry)
      : compress(isPlainObject(entry) ? (entry.sessionId ?? entry.id) : '')
    if (id === '' || membership.has(id)) continue
    membership.set(id, { category, sub })
  }
}

// ── 导出：聚合 ────────────────────────────────────────────────────────

/**
 * 建统计视图模型（V-5）。
 *
 * `tree` 给了就按树的结构与顺序输出（空类也保留，交给 `health.emptyCategories`），
 * 没给就按 `topicPath` 首次出现顺序自动聚合并补一个「未归类」兜底桶。
 * 返回的 `categories` 保持结构顺序，**活跃度排序由调用方调 `sortCategories`**。
 *
 * 兜底规则：
 * - 空 / 缺 / `'未归类'` 的 `topicPath` →「未归类」桶，计入 `health.uncategorized`；
 * - 树里找不到的大类 → 同上；树里有大类但没这个子类 → 按需补子类，不丢会话；
 * - `tree` 自带 `subcategories[].sessions` 时以成员关系优先，其次才看 `topicPath`；
 * - `totals.categories` 只数真大类，「未归类」兜底桶不计入；
 * - `tree` 一个能用的名字都没有时退回自动聚合，不把会话全打进兜底桶。
 *
 * `health` 四项口径（V-5 "结构是否健康"）：
 * - `uncategorized`：没落进任何大类的会话数（含空 / 缺 / `'未归类'` 的路径）；
 * - `unsolved`：未标 `solved` 的会话数（`sessions - solved`）；
 * - `emptyCategories`：结构里有、但一个会话也没落进来的真大类名（兜底桶不算）；
 * - `staleCategories`：有会话、且最后活动严格早于 30 天前的大类名；
 *   没传 `now` 时为空数组（不读时钟，不猜"现在"）。
 *
 * @param {object[]} sessions - 会话输入；字段可缺，缺按 0 / 空处理。
 * @param {object} [options] - 选项。
 * @param {number|Date} [options.now] - 参照时间；不传则 activeDays 为 0、stale 跳过。
 * @param {object[]} [options.tree] - 归类树 `[{name, subcategories:[{name, sessions?}]}]`。
 * @param {number} [options.windowDays=30] - 活跃天数窗口。
 * @returns {{categories: object[], totals: object, health: object}} 统计模型。
 */
export function buildStats(sessions, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const now = toTime(opts.now)
  const windowDays = normalizeWindowDays(opts.windowDays)
  const items = (Array.isArray(sessions) ? sessions : []).filter(isPlainObject).map(normalizeItem)
  const makeKey = createKeyFactory()
  const buckets = []
  const uncategorized = []
  // 树里一个能用的名字都没有时退回自动聚合：坏数据不该把会话全打进兜底桶。
  const usableTree = Array.isArray(opts.tree)
    && opts.tree.some(entry => isPlainObject(entry)
      && compress(entry.name ?? entry.title ?? entry.category) !== '')

  if (usableTree) {
    // ── 按树输出：结构、顺序都听树的 ──
    const membership = new Map()
    const byName = new Map()
    let uncategorizedBucket = null
    for (const rawCategory of opts.tree) {
      if (!isPlainObject(rawCategory)) continue
      const name = compress(rawCategory.name ?? rawCategory.title ?? rawCategory.category)
      if (name === '') continue
      const category = createBucket(makeKey, name)
      buckets.push(category)
      if (!byName.has(name)) byName.set(name, category)
      if (name === UNCATEGORIZED_NAME && uncategorizedBucket === null) uncategorizedBucket = category
      const rawSubs = Array.isArray(rawCategory.subcategories)
        ? rawCategory.subcategories
        : (Array.isArray(rawCategory.children) ? rawCategory.children : [])
      for (const rawSub of rawSubs) {
        if (!isPlainObject(rawSub)) continue
        const subName = compress(rawSub.name ?? rawSub.title)
        if (category.subByName.has(subName)) continue
        const sub = ensureSub(makeKey, category, subName)
        collectSessionIds(rawSub.sessions, membership, category, sub)
      }
      collectSessionIds(rawCategory.sessions, membership, category, null)
    }

    for (const item of items) {
      const mapped = item.id === '' ? undefined : membership.get(item.id)
      if (mapped !== undefined) {
        if (mapped.sub === null) {
          mapped.category.members.push(item)
        } else {
          mapped.sub.members.push(item)
          item.subcategory = mapped.sub.name
        }
        continue
      }
      if (item.path === null) {
        uncategorized.push(item)
        continue
      }
      const category = byName.get(item.path.category)
      if (category === undefined) {
        uncategorized.push(item)
        continue
      }
      const sub = ensureSub(makeKey, category, item.path.subcategory)
      sub.members.push(item)
      item.subcategory = sub.name
    }

    // 树里没有「未归类」但有散会话：补一个兜底桶排在最后。
    if (uncategorized.length > 0 && uncategorizedBucket === null) {
      uncategorizedBucket = createBucket(makeKey, UNCATEGORIZED_NAME)
      buckets.push(uncategorizedBucket)
    }
    if (uncategorizedBucket !== null) {
      for (const item of uncategorized) uncategorizedBucket.members.push(item)
    }
  } else {
    // ── 自动聚合：按 topicPath 首次出现顺序 ──
    const byName = new Map()
    for (const item of items) {
      if (item.path === null) {
        uncategorized.push(item)
        continue
      }
      let category = byName.get(item.path.category)
      if (category === undefined) {
        category = createBucket(makeKey, item.path.category)
        byName.set(item.path.category, category)
        buckets.push(category)
      }
      const sub = ensureSub(makeKey, category, item.path.subcategory)
      sub.members.push(item)
      item.subcategory = sub.name
    }
    if (uncategorized.length > 0) {
      const fallback = createBucket(makeKey, UNCATEGORIZED_NAME)
      for (const item of uncategorized) fallback.members.push(item)
      buckets.push(fallback)
    }
  }

  const categories = buckets.map(bucket => finalizeCategory(bucket, now, windowDays))
  const totals = {
    ...metricsOf(items, now, windowDays),
    categories: buckets.filter(bucket => bucket.name !== UNCATEGORIZED_NAME).length,
    uncategorized: uncategorized.length,
  }
  const health = {
    uncategorized: uncategorized.length,
    unsolved: items.filter(item => !item.solved).length,
    // 空类：树给了结构但一个会话也没落进来（兜底桶不算"空类"问题）。
    emptyCategories: categories
      .filter(category => category.metrics.sessions === 0 && category.name !== UNCATEGORIZED_NAME)
      .map(category => category.name),
    // 停滞：有会话且最后活动确实早于阈值。没给 now 就整项跳过（不读时钟）。
    staleCategories: now === null ? [] : categories
      .filter(category => category.metrics.sessions > 0
        && category.metrics.lastActivity !== null
        && now - category.metrics.lastActivity > STALE_DAYS * DAY)
      .map(category => category.name),
  }
  return { categories, totals, health }
}

/**
 * 近 N 天里有活动的不同自然日数（本地自然日）。
 *
 * 口径：
 * - 窗口 = 今天（含）往前 `windowDays - 1` 天，`windowDays = 30` 即今天 + 前 29 天；
 *   恰好第 30 天前（更早）不算；
 * - 自然日按本地时区取 `YYYY-MM-DD` 去重，同日多次活动只算 1 天；
 * - 只用 `lastActivity`（会话本身没有逐轮活动时间），未来时间戳不计；
 * - 没传 `now` 返回 0，**不读系统时钟**；非法 `windowDays` 回默认 30。
 *
 * @param {object[]} sessions - 会话（只需 `lastActivity`）。
 * @param {object} [options] - 选项。
 * @param {number|Date} [options.now] - 参照时间，必须传才会算。
 * @param {number} [options.windowDays=30] - 窗口天数。
 * @returns {number} 不同自然日数。
 */
export function activeDaysOf(sessions, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const now = toMs(opts.now)
  if (!Number.isFinite(now)) return 0
  const windowDays = normalizeWindowDays(opts.windowDays)
  if (windowDays <= 0) return 0
  const base = new Date(now)
  const windowStart = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() - (windowDays - 1),
  ).getTime()
  const windowEnd = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate() + 1,
  ).getTime()
  const days = new Set()
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!isPlainObject(session)) continue
    const time = toMs(session.lastActivity)
    if (!Number.isFinite(time) || time < windowStart || time >= windowEnd) continue
    days.add(formatDate(time))
  }
  return days.size
}

// ── 导出：排序 ────────────────────────────────────────────────────────

/**
 * 排大类（V-5：活跃度第一）。
 *
 * - `'activity'`（默认）：`metrics.lastActivity` 倒序，无时间的排最后；
 * - `'turns'` / `'cost'` / `'sessions'`：对应用量倒序，同分再按活跃度；
 * - 其余 `by` 值按默认 `'activity'` 处理。
 *
 * 返回新数组，不修改入参；同分用 `name` 保证结果稳定。
 *
 * @param {object[]} categories - `buildStats().categories` 或同形数组。
 * @param {'activity'|'turns'|'cost'|'sessions'} [by='activity'] - 排序口径。
 * @returns {object[]} 新数组。
 */
export function sortCategories(categories, by = 'activity') {
  const list = Array.isArray(categories) ? categories.slice() : []
  const mode = by === 'turns' || by === 'cost' || by === 'sessions' ? by : 'activity'
  const metricsOfCategory = category => (
    isPlainObject(category) && isPlainObject(category.metrics) ? category.metrics : {}
  )
  const timeOf = category => {
    const time = toMs(metricsOfCategory(category).lastActivity)
    return Number.isFinite(time) ? time : null
  }
  const scoreOf = category => {
    const metrics = metricsOfCategory(category)
    if (mode === 'turns') return toNonNegative(metrics.turns)
    if (mode === 'cost') return toNonNegative(metrics.cost)
    if (mode === 'sessions') return toNonNegative(metrics.sessions)
    return 0
  }
  const nameOf = category => (isPlainObject(category) ? compress(category.name) : '')
  const compareName = (left, right) => {
    const leftName = nameOf(left)
    const rightName = nameOf(right)
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0
  }
  /** 活跃度兜底比较：时间倒序，无时间最后。 */
  const compareActivity = (left, right) => {
    const leftTime = timeOf(left)
    const rightTime = timeOf(right)
    if (leftTime === null && rightTime === null) return 0
    if (leftTime === null) return 1
    if (rightTime === null) return -1
    return rightTime - leftTime
  }
  return list.sort((left, right) => {
    if (mode === 'activity') {
      const activity = compareActivity(left, right)
      if (activity !== 0) return activity
      const leftMetrics = metricsOfCategory(left)
      const rightMetrics = metricsOfCategory(right)
      const bySessions = toNonNegative(rightMetrics.sessions) - toNonNegative(leftMetrics.sessions)
      if (bySessions !== 0) return bySessions
      const byTurns = toNonNegative(rightMetrics.turns) - toNonNegative(leftMetrics.turns)
      if (byTurns !== 0) return byTurns
      return compareName(left, right)
    }
    const diff = scoreOf(right) - scoreOf(left)
    if (diff !== 0) return diff
    const activity = compareActivity(left, right)
    if (activity !== 0) return activity
    return compareName(left, right)
  })
}

// ── 导出：格式化 ──────────────────────────────────────────────────────

/**
 * 紧凑数字：`0` / `999` / `1.2k` / `12.3k` / `1.2M`。
 *
 * 一位小数并去掉 `.0`；`999.95` 这类四舍五入后进位到 1000 的值按 `1k` 显示，
 * 不舍入成 `1000`（否则同一列数字宽度会跳）。
 *
 * @param {number} n - 数字。
 * @returns {string} 紧凑文案；非法输入记 `0`。
 */
export function formatCompact(n) {
  const value = Number(n)
  if (!Number.isFinite(value)) return '0'
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const rounded = Math.round(abs)
  if (rounded < 1000) return `${sign}${rounded}`
  if (rounded < 1000000) {
    const thousands = Math.round(abs / 100) / 10
    if (thousands < 1000) return `${sign}${trimOneDecimal(thousands)}k`
    // 999.95k 进位到 1000k：直接跳 M，别输出 1000k。
  }
  const millions = Math.round(abs / 100000) / 10
  return `${sign}${trimOneDecimal(millions)}M`
}

/**
 * 时长：`45 秒` / `12 分` / `3.5 小时` / `2.1 天`。
 *
 * 秒与分取整（进位到下一档时自动升级），小时与天保留一位小数。
 * 非法、负数、0 都显示 `0 秒`。
 *
 * @param {number} ms - 毫秒。
 * @returns {string} 时长文案。
 */
export function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '0 秒'
  const totalSeconds = Math.round(value / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const totalMinutes = Math.round(value / MINUTE)
  if (totalMinutes < 60) return `${totalMinutes} 分`
  const hours = Math.round(value / HOUR * 10) / 10
  if (hours < 24) return `${trimOneDecimal(hours)} 小时`
  return `${trimOneDecimal(value / DAY)} 天`
}

/**
 * 费用：`$0.00` / `$1.23` / `$12.3`。
 *
 * 小于 0.01 的非零值显示 `<$0.01`；10 以上保留一位小数（金额不丢位数）；
 * 负数把符号放最前（`-$1.23`）。非法输入按 0 显示。
 *
 * @param {number} value - 金额（美元）。
 * @returns {string} 费用文案。
 */
export function formatCost(value) {
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
