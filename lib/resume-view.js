/**
 * 断点续接视图模型（V-8 / design.md §4）：把工作区内"尚未收尾"的会话排成一屏。
 *
 * 分组固定三档：① 待跟进（人工）② 未完成（自动）③ 近期（其余，最多 5 条）。
 * 组内按 `lastActivity` 倒序，总上限 `limit`（默认 10），超出置 `hasMore`。
 * 全是纯规则，不调模型；`now` 必须由调用方传入，测试才可复现。
 *
 * 为什么相对时间在这里又写了一遍（**有意的重复**）：
 * 本文件以后由 `build-theme` 原样嵌进 client bundle，而 `strip()` 只删 `import`
 * 行、不会解析依赖；一旦这里 `import` 其它模块，嵌入后就会引用到不存在的名字。
 * 因此相对时间分档与 `lib/hit-view.js` 保持同一份口径、各带一份实现：
 * 刚刚 / N 分钟前 / N 小时前 / 今天 / 昨天 / N 天前 / 绝对日期（本地自然日）。
 * 改口径时两处要一起改，测试分别覆盖。
 *
 * @module dsh-topic-map/resume-view
 */

/** 一屏最多 10 条（design §4：上限 10 条 +「查看全部」）。 */
const DEFAULT_LIMIT = 10

/** "近期"组自己的上限（design §4：其他近期最多 5 条）。 */
const RECENT_LIMIT = 5

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 固定分组顺序与标题。 */
const GROUPS = Object.freeze([
  { key: 'followUp', title: '待跟进' },
  { key: 'unfinished', title: '未完成' },
  { key: 'recent', title: '近期' },
])

/** 自动判"未完成"的结束原因。 */
const FAIL_REASONS = new Set(['error', 'failed', 'blocked', 'max-turns', 'max-tokens'])

/** 自动判"中断"的结束原因（有的记录只给 endReason，不给 interrupted 标志）。 */
const INTERRUPT_REASONS = new Set(['interrupted', 'aborted'])

/** 状态键（A-3 三个开关）。 */
const STATUS_KEYS = Object.freeze(['starred', 'solved', 'followUp'])

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

/** 同一本地年份。 */
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
 * @param {number|Date} time - 目标时间。
 * @param {number|Date} now - 参照时间。
 * @returns {string} 刚刚 / N 分钟前 / N 小时前 / 今天 / 昨天 / N 天前 / YYYY-MM-DD；非法为空串。
 */
function formatRelativeTime(time, now) {
  const target = toMs(time)
  const base = toMs(now)
  if (!Number.isFinite(target) || !Number.isFinite(base)) return ''
  const diff = base - target
  if (diff < 0) return sameLocalDay(target, base) ? '今天' : formatDate(target)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  const days = Math.round((startOfLocalDay(base) - startOfLocalDay(target)) / DAY)
  if (!sameLocalYear(target, base)) return formatDate(target)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return formatDate(target)
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

/** 会话短 id：去掉 `session-` 前缀后取前 8 个字符。 */
function shortSessionId(sessionId) {
  const raw = compress(sessionId)
  if (raw === '') return ''
  return raw.replace(/^session[-_:]/i, '').slice(0, 8)
}

/** 卡片标题：会话标题，空则短 id，再空则占位。 */
function titleOf(session) {
  const title = compress(session.title)
  if (title !== '') return title
  const short = shortSessionId(session.sessionId)
  return short === '' ? '未命名会话' : short
}

/** 面包屑路径：数组用 ` › ` 连接，字符串原样。 */
function pathOf(topicPath) {
  if (Array.isArray(topicPath)) {
    return topicPath
      .map(part => compress(isPlainObject(part) ? (part.title ?? part.name ?? part.label) : part))
      .filter(text => text !== '')
      .join(' › ')
  }
  return compress(topicPath)
}

/** 转数字；非法返回 null。 */
function toCount(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.trunc(number) : null
}

/** 轮号：1-based 正整数；非法返回 null。 */
function toTurn(value) {
  const number = toCount(value)
  return number !== null && number > 0 ? number : null
}

/** 是否失败结束（需要重试）。 */
function isFailure(session) {
  const reason = typeof session.endReason === 'string' ? session.endReason : ''
  return FAIL_REASONS.has(reason)
}

/** 是否中断。 */
function isInterrupted(session) {
  const reason = typeof session.endReason === 'string' ? session.endReason : ''
  return session.interrupted === true || INTERRUPT_REASONS.has(reason)
}

/**
 * 该会话最近是否有文件变更（F-7 / A-7 的入口）。
 *
 * 认 `hasChanges: true`，也兼容 `changes: [...]` 与 `changes: {files, lost}`。
 *
 * @param {object} session - 会话条目。
 * @returns {boolean} 是否有变更。
 */
function hasChanges(session) {
  if (session.hasChanges === true) return true
  const changes = session.changes
  if (Array.isArray(changes)) return changes.length > 0
  if (!isPlainObject(changes)) return false
  if (changes.lost === true) return true
  return Array.isArray(changes.files) && changes.files.length > 0
}

/** 标签键：`sessionId#lastTurn`（没有 sid 时退化为轮号）。 */
function labelKeyOf(session, lastTurn) {
  if (lastTurn === null) return ''
  const sid = session.sessionId === null || session.sessionId === undefined
    ? ''
    : String(session.sessionId).trim()
  return sid === '' ? String(lastTurn) : `${sid}#${lastTurn}`
}

/**
 * 取标签（对象 / Map / 函数，与 rank 的 `resolveLabel` 同口径）。
 *
 * 函数标签收到 `{...session, turn: lastTurn}`，既能按 `sessionId#turn` 查，
 * 也能读到标题等原始字段。
 *
 * @param {object} session - 会话条目。
 * @param {number|null} lastTurn - 最后一轮。
 * @param {object|Map|Function} [labels] - 标签仓库。
 * @returns {object|string|Array|null} 标签。
 */
function resolveLabel(session, lastTurn, labels) {
  const key = labelKeyOf(session, lastTurn)
  const bare = lastTurn === null ? '' : String(lastTurn)
  let fromStore
  if (typeof labels === 'function') {
    const value = labels({ ...session, turn: lastTurn })
    if (value !== undefined && value !== null) fromStore = value
  } else if (labels instanceof Map) {
    if (key !== '' && labels.has(key)) fromStore = labels.get(key)
    else if (bare !== '' && labels.has(bare)) fromStore = labels.get(bare)
  } else if (isPlainObject(labels)) {
    if (key !== '' && labels[key] !== undefined) fromStore = labels[key]
    else if (bare !== '' && labels[bare] !== undefined) fromStore = labels[bare]
  }
  if (fromStore !== undefined && fromStore !== null) return fromStore
  if (session.label !== undefined && session.label !== null) return session.label
  return null
}

/** 状态归一：对象 / 数组 / 字符串都认，顺序固定。 */
function statusesOf(label) {
  if (!label) return []
  if (typeof label === 'string') {
    const raw = label.trim().toLowerCase()
    return STATUS_KEYS.filter(status => status.toLowerCase() === raw)
  }
  if (Array.isArray(label)) return STATUS_KEYS.filter(status => label.includes(status))
  if (!isPlainObject(label)) return []
  return STATUS_KEYS.filter(status => Boolean(label[status]))
}

/** 本地自然日差（≥0）；时间非法返回 null。 */
function dayDiff(time, now) {
  const target = toMs(time)
  const base = toMs(now)
  if (!Number.isFinite(target) || !Number.isFinite(base)) return null
  return Math.max(0, Math.round((startOfLocalDay(base) - startOfLocalDay(target)) / DAY))
}

/** 卡片理由：人话，优先人工状态与失败/中断。 */
function reasonOf(group, solved, failure, interrupted, session, activity, now) {
  if (group === 'followUp') return '标记待跟进'
  if (solved) return '已标记完成'
  if (failure) {
    const reason = typeof session.endReason === 'string' ? session.endReason : ''
    return `失败：${reason}`
  }
  if (interrupted) return '中断'
  const days = dayDiff(activity, now)
  if (days === null) return '活跃时间未知'
  return days === 0 ? '今天活跃' : `静止 ${days} 天`
}

/**
 * 语气：待跟进 warn / 失败 danger / 中断 warn / 其余 muted。
 *
 * 中断虽然不算"失败"，但它同样在"未完成"组里——用 muted 会和"近期"组一样
 * 显得"不急"，所以把 warn 也给它；`danger` 只留给真失败。
 *
 * @param {'followUp'|'unfinished'|'recent'} group - 分组。
 * @param {boolean} failure - 是否失败结束。
 * @param {boolean} interrupted - 是否中断。
 * @returns {'warn'|'danger'|'muted'} 语气。
 */
function toneOf(group, failure, interrupted) {
  if (group === 'followUp') return 'warn'
  if (group === 'unfinished' && failure) return 'danger'
  if (group === 'unfinished' && interrupted) return 'warn'
  return 'muted'
}

/** 主按钮：待跟进→继续；未完成→重试；有变更→看变更；其余→定位。 */
function actionOf(group, changes) {
  if (group === 'followUp') return 'continue'
  if (group === 'unfinished') return 'retry'
  if (changes) return 'changes'
  return 'locate'
}

/** 徽标：有变更 / 已标记（与 hit-view 同口径、同顺序）。 */
function badgesOf(statuses, changes) {
  const badges = []
  if (changes) badges.push('有变更')
  if (statuses.length > 0) badges.push('已标记')
  return badges
}

/** 把一条会话归组并生成卡片。 */
function makeCandidate(session, labels, now, turnCount) {
  const lastTurn = toTurn(session.lastTurn) ?? turnCount
  const label = resolveLabel(session, lastTurn, labels)
  const statuses = statusesOf(label)
  const solved = statuses.includes('solved')
  const followUp = statuses.includes('followUp')
  const failure = isFailure(session)
  const interrupted = isInterrupted(session)
  const changes = hasChanges(session)
  const activity = toMs(session.lastActivity)

  // 人工状态优先：solved 压过 followUp / 失败，从"未完成"捞出到"近期"。
  let group
  if (followUp && !solved) group = 'followUp'
  else if (!solved && (failure || interrupted)) group = 'unfinished'
  else group = 'recent'

  return {
    group,
    activity: Number.isFinite(activity) ? activity : -Infinity,
    card: {
      sessionId: session.sessionId ?? null,
      title: titleOf(session),
      path: pathOf(session.topicPath),
      lastActivityLabel: formatRelativeTime(activity, now),
      lastTurnLabel: lastTurn === null ? '' : `第 ${lastTurn} 轮`,
      laneLabel: compress(session.laneTitle),
      reason: reasonOf(group, solved, failure, interrupted, session, activity, now),
      tone: toneOf(group, failure, interrupted),
      primaryAction: actionOf(group, changes),
      badges: badgesOf(statuses, changes),
      // 额外带上轮号：点击"定位/继续"时不用再回查。
      turn: lastTurn,
    },
  }
}

/** limit 归一：正整数取整，否则默认 10。 */
function normalizeLimit(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : DEFAULT_LIMIT
}

/** 组内排序：lastActivity 倒序；时间非法（-Infinity）排最后。 */
function byActivityDesc(a, b) {
  if (a.activity === b.activity) return 0
  return a.activity > b.activity ? -1 : 1
}

/**
 * 生成断点续接卡片（V-8）。
 *
 * 分组顺序固定：待跟进 → 未完成 → 近期；组内按 `lastActivity` 倒序。
 * "近期"组最多 5 条，总上限 `limit`（默认 10）；`total` 是候选会话总数，
 * `shown` 是实际放出的卡片数，`hasMore = total > shown`。
 *
 * @param {object} input - 输入。
 * @param {Array} [input.sessions] - 会话条目（有轮次、未归档；调用方先过滤）。
 * @param {object|Map|Function} [input.labels] - 标签，键 `sessionId#lastTurn`。
 * @param {number|Date} input.now - 参照时间（必传；缺失时时间文案降级为空）。
 * @param {number} [input.limit] - 总上限，默认 10。
 * @returns {{groups: Array<{key: string, title: string, cards: Array}>, total: number, shown: number, hasMore: boolean}} 续接视图。
 */
export function toResumeCards(input) {
  const source = isPlainObject(input) ? input : {}
  const now = toMs(source.now)
  const limit = normalizeLimit(source.limit)
  const labels = source.labels
  const buckets = { followUp: [], unfinished: [], recent: [] }

  let total = 0
  for (const session of Array.isArray(source.sessions) ? source.sessions : []) {
    if (!isPlainObject(session)) continue
    const turnCount = toCount(session.turnCount)
    // 有轮次才进候选；turnCount 缺失时交给调用方保证，不在这里丢。
    if (turnCount !== null && turnCount <= 0) continue
    total += 1
    const candidate = makeCandidate(session, labels, now, turnCount)
    buckets[candidate.group].push(candidate)
  }

  for (const key of ['followUp', 'unfinished', 'recent']) {
    buckets[key].sort(byActivityDesc)
  }

  // 固定三组、固定顺序；近期先截到 5 条，再参与总上限。
  const groups = GROUPS.map(group => ({ key: group.key, title: group.title, cards: [] }))
  const sources = [buckets.followUp, buckets.unfinished, buckets.recent.slice(0, RECENT_LIMIT)]
  let shown = 0
  for (let i = 0; i < sources.length; i += 1) {
    for (const candidate of sources[i]) {
      if (shown >= limit) break
      groups[i].cards.push(candidate.card)
      shown += 1
    }
  }

  return { groups, total, shown, hasMore: total > shown }
}
