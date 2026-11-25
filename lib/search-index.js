/**
 * 检索内核（S-1 ~ S-4、S-6、S-8）：在轮次数组上做关键词 / 时间 / 结构过滤。
 *
 * 只依赖内存里的轮次数组——索引落盘、增量重建由别的模块负责。这里全是纯函数：
 * 给什么搜什么，不读文件、不调模型（S-9）。
 *
 * 关键词口径（S-1）：中文子串、多词 AND、大小写不敏感；**不切词、不解释正则**。
 * 用户输入 `a.b` 就只找字面上的 `a.b`，输入 `a|b` 也不会变成"或"。
 * 逐条 `indexOf` 线性扫描，不做倒排（design §3：1 万轮 ≈ 10MB，够用）。
 *
 * 时间口径（S-2）：`[from, to]` 含头含尾，直接比较传入的本地时间戳（epoch ms），
 * 不做时区转换。命中时间取该轮的 `end`，没有则取 `start`。
 *
 * 排序：默认调 `rank.js` 的 S-5 相关度；`sort: 'time'` 时按 `end/start` 倒序，
 * 但仍保留 `score` 与拆解，供界面显示"分数来源"（A-14）。
 *
 * @module dsh-topic-map/search-index
 */

import { rankHits, resolveLabel, statusesOf } from './rank.js'

/** 默认返回上限（S-8 的截断口径）。 */
export const DEFAULT_LIMIT = 50

/** 片段取命中位置前后各多少字。 */
export const SNIPPET_CONTEXT = 40

/** 片段硬上限（字符）。 */
export const SNIPPET_MAX = 200

/** 状态名的归一（过滤条件允许小写书写）。 */
const STATUS_ALIASES = Object.freeze({
  followup: 'followUp',
  solved: 'solved',
  starred: 'starred',
})

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

/** 轮次在结果里的时间：结束时刻优先，其次开始时刻；都没有则 null。 */
function timeOf(turn) {
  const end = toMs(turn.end)
  if (Number.isFinite(end)) return end
  const start = toMs(turn.start)
  if (Number.isFinite(start)) return start
  return null
}

/** 把各种"单个 / 数组 / Set"的输入摊平成数组。 */
function toArray(value) {
  if (value === null || value === undefined || value === '') return []
  if (Array.isArray(value)) return value
  if (value instanceof Set) return [...value]
  return [value]
}

/** 把输入里的空白分词并归一成小写关键词；去重保序。 */
export function normalizeKeywords(keywords) {
  const raw = toArray(keywords).flatMap(value => (typeof value === 'string' ? value.split(/\s+/) : []))
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const keyword = item.trim().toLowerCase()
    if (keyword === '' || seen.has(keyword)) continue
    seen.add(keyword)
    out.push(keyword)
  }
  return out
}

/** 状态名归一：小写输入也能认出 `followUp`。 */
function canonicalStatus(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return null
  return STATUS_ALIASES[raw.toLowerCase()] ?? null
}

/**
 * 归一结构过滤条件。
 *
 * 每类条件内部是"或"，条件之间是"与"（S-4）。空数组 = 不限。
 *
 * @param {object} [filters] - 原始过滤条件。
 * @returns {object} 归一后的条件（均为数组）。
 */
function normalizeFilters(filters) {
  const src = isPlainObject(filters) ? filters : {}
  return {
    sessionIds: toArray(src.sessionIds).map(value => String(value)),
    tools: toArray(src.tools).map(value => String(value).toLowerCase()),
    files: toArray(src.files).map(value => String(value).toLowerCase()),
    endReasons: toArray(src.endReason).map(value => String(value).toLowerCase()),
    statuses: toArray(src.statuses).map(canonicalStatus).filter(Boolean),
  }
}

/** 归一 limit：正数取整，其余回退默认值。 */
function normalizeLimit(limit) {
  const value = Number(limit)
  if (Number.isFinite(value) && value > 0) return Math.floor(value)
  return DEFAULT_LIMIT
}

/** 轮次上的工具名（保留原始写法，供界面显示）。 */
function toolListOf(turn) {
  return toArray(turn.tools)
    .map(tool => (typeof tool === 'string' ? tool : isPlainObject(tool) && typeof tool.name === 'string' ? tool.name : ''))
    .filter(name => name !== '')
}

/** 过滤用的工具名（统一小写）。 */
function toolNamesOf(turn) {
  return toolListOf(turn).map(name => name.toLowerCase())
}

/** 轮次上的文件路径（保留原始写法，供界面显示）。 */
function fileListOf(turn) {
  return toArray(turn.files)
    .map(file => (typeof file === 'string' ? file : isPlainObject(file) && typeof file.path === 'string' ? file.path : ''))
    .filter(path => path !== '')
}

/** 过滤用的文件路径（统一小写，Windows 口径）。 */
function filePathsOf(turn) {
  return fileListOf(turn).map(path => path.toLowerCase())
}

/** 会话过滤。 */
function matchSession(turn, filters) {
  if (filters.sessionIds.length === 0) return true
  const sessionId = turn.sessionId === null || turn.sessionId === undefined ? '' : String(turn.sessionId)
  return filters.sessionIds.includes(sessionId)
}

/** 工具名过滤：任一命中即可，比较时忽略大小写。 */
function matchTools(turn, filters) {
  if (filters.tools.length === 0) return true
  const names = toolNamesOf(turn)
  return filters.tools.some(wanted => names.includes(wanted))
}

/** 文件路径过滤：子串匹配（Windows 口径，忽略大小写）。 */
function matchFiles(turn, filters) {
  if (filters.files.length === 0) return true
  const paths = filePathsOf(turn)
  return filters.files.some(fragment => paths.some(path => path.includes(fragment)))
}

/** 结束原因过滤。 */
function matchEndReason(turn, filters) {
  if (filters.endReasons.length === 0) return true
  const reason = typeof turn.endReason === 'string' ? turn.endReason.toLowerCase() : ''
  return reason !== '' && filters.endReasons.includes(reason)
}

/** 状态过滤：三开关任一为真即命中；没有标签就不命中。 */
function matchStatuses(label, filters) {
  if (filters.statuses.length === 0) return true
  const active = statusesOf(label)
  return filters.statuses.some(status => active.includes(status))
}

/** 统计关键词在已小写文本里出现的次数（非重叠）。 */
function countIn(haystackLower, keyword) {
  let count = 0
  let at = haystackLower.indexOf(keyword)
  while (at !== -1) {
    count += 1
    at = haystackLower.indexOf(keyword, at + keyword.length)
  }
  return count
}

/**
 * 从文本里截一段围绕命中的片段（S-8 / A-2 的"片段"口径）。
 *
 * 取最早命中位置前后各 40 字，压缩连续空白，最长 200 字。
 * 没有命中时退回开头 80 字（空关键词浏览时用）。
 *
 * @param {string} text - 原文。
 * @param {string[]|string} keywords - 关键词（内部会归一）。
 * @returns {string} 片段。
 */
export function buildSnippet(text, keywords) {
  const src = typeof text === 'string' ? text : ''
  if (src === '') return ''
  const list = normalizeKeywords(keywords)
  let at = -1
  let hitLength = 0
  if (list.length > 0) {
    const lower = src.toLowerCase()
    for (const keyword of list) {
      const index = lower.indexOf(keyword)
      if (index === -1) continue
      if (at === -1 || index < at) {
        at = index
        hitLength = keyword.length
      }
    }
  }
  const slice = at === -1
    ? src.slice(0, SNIPPET_CONTEXT * 2)
    : src.slice(Math.max(0, at - SNIPPET_CONTEXT), at + hitLength + SNIPPET_CONTEXT)
  return slice.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX)
}

/**
 * 单轮关键词扫描：多词 AND，词可分布在提问 / 回答任意一侧。
 *
 * @param {object} turn - 轮次记录。
 * @param {string[]} keywords - 已归一的小写关键词。
 * @returns {object|null} `{ prompt, response, promptMatches, responseMatches }`；不命中返回 null。
 */
function scanKeywords(turn, keywords) {
  const prompt = typeof turn.prompt === 'string' ? turn.prompt : ''
  const response = typeof turn.response === 'string' ? turn.response : ''
  if (keywords.length === 0) {
    return { prompt, response, promptMatches: 0, responseMatches: 0 }
  }
  const promptLower = prompt.toLowerCase()
  const responseLower = response.toLowerCase()
  let promptMatches = 0
  let responseMatches = 0
  for (const keyword of keywords) {
    const inPrompt = countIn(promptLower, keyword)
    const inResponse = countIn(responseLower, keyword)
    promptMatches += inPrompt
    responseMatches += inResponse
    if (inPrompt === 0 && inResponse === 0) return null
  }
  return { prompt, response, promptMatches, responseMatches }
}

/** L0 摘要原料：提问首句（≤40 字）。纯规则、零 token，模型不可用也有（V-11）。 */
function promptHeadOf(prompt) {
  const text = String(prompt ?? '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  const stop = text.search(/[。！？!?；;]/)
  const sentence = (stop === -1 ? text : text.slice(0, stop)).trim()
  return (sentence === '' ? text : sentence).slice(0, 40)
}

/** 造一条命中：只回片段与元信息，不夹带全文（design §3）。 */
function makeHit(turn, time, scan, matchedIn, keywords, label) {
  const matchCount = scan.promptMatches + scan.responseMatches
  return {
    sessionId: turn.sessionId ?? null,
    turn: turn.turn ?? null,
    seq: turn.seq ?? null, // A-1 定位要用 seq；轮次记录里本来就有
    time,
    start: Number.isFinite(toMs(turn.start)) ? toMs(turn.start) : null,
    end: Number.isFinite(toMs(turn.end)) ? toMs(turn.end) : null,
    matchedIn,
    snippet: buildSnippet(matchedIn === 'response' ? scan.response : scan.prompt, keywords),
    // L0 摘要原料：提问首句 + 下面的 tools / files / endReason，界面拼一下即可显示。
    promptHead: promptHeadOf(scan.prompt),
    matchCount,
    promptMatches: scan.promptMatches,
    responseMatches: scan.responseMatches,
    inPrompt: scan.promptMatches > 0,
    inResponse: scan.responseMatches > 0,
    endReason: turn.endReason ?? null,
    interrupted: turn.interrupted === true,
    truncated: turn.truncated === true, // F-1：该轮全文曾超 32k 被截断时告诉界面
    steps: typeof turn.steps === 'number' && Number.isFinite(turn.steps) ? turn.steps : null,
    title: typeof turn.title === 'string' ? turn.title : null,
    laneId: turn.laneId ?? null,
    tools: toolListOf(turn),
    files: fileListOf(turn),
    label,
  }
}

/** 时间倒序：结束时刻大的在前；没有时间的排最后，同刻按 turn 升序。 */
function byTimeDesc(a, b) {
  const ta = Number.isFinite(a.time) ? a.time : -Infinity
  const tb = Number.isFinite(b.time) ? b.time : -Infinity
  if (ta !== tb) return tb - ta
  const na = Number(a.turn)
  const nb = Number(b.turn)
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb
  return 0
}

/**
 * 按会话折叠。
 *
 * 组顺序 = 组内第一条命中在已排序数组里的位置（相关度排序时即最高分命中）；
 * `count` 是命中轮次总数，`lanes` 是话题段数量占位（有 `laneId` 就数不同段，没有先当 1 段）。
 *
 * @param {Array} ranked - 已排序的命中。
 * @param {number} limit - 最多返回几组。
 * @returns {Array} 组数组。
 */
function groupBySession(ranked, limit) {
  const order = []
  const map = new Map()
  for (const hit of ranked) {
    const key = hit.sessionId === null || hit.sessionId === undefined ? '' : String(hit.sessionId)
    let group = map.get(key)
    if (group === undefined) {
      group = {
        sessionId: hit.sessionId ?? null,
        title: hit.title ?? null,
        count: 0,
        lanes: 1,
        score: hit.score ?? 0,
        latest: hit.time ?? null,
        hits: [],
      }
      map.set(key, group)
      order.push(group)
    }
    group.count += 1
    group.hits.push(hit)
    if (group.title === null && hit.title) group.title = hit.title
    if (hit.score > group.score) group.score = hit.score
    if (hit.time !== null && hit.time !== undefined && (group.latest === null || hit.time > group.latest)) {
      group.latest = hit.time
    }
  }
  for (const group of order) {
    const laneIds = new Set()
    for (const hit of group.hits) {
      if (hit.laneId !== null && hit.laneId !== undefined) laneIds.add(String(hit.laneId))
    }
    group.lanes = Math.max(1, laneIds.size)
  }
  return order.slice(0, limit)
}

/**
 * 检索轮次（S-1 ~ S-4、S-6、S-8）。
 *
 * @param {Array} turns - 轮次记录数组（字段见 F-1 / design §1）。
 * @param {object} [query] - 查询。
 * @param {string|string[]} [query.keywords] - 关键词；字符串按空白拆成多词（AND）。省略或空 = 不限关键词（只走过滤/浏览）。
 * @param {{from?: number|Date, to?: number|Date}} [query.timeRange] - 时间区间，含头含尾。
 * @param {object} [query.filters] - 结构过滤：`sessionIds / tools / files / endReason / statuses`。
 * @param {number} [query.limit] - 返回上限（默认 50）；分组时作用于组数。
 * @param {'none'|'session'} [query.groupBy] - `session` 时同会话折叠成一组。
 * @param {'relevance'|'time'} [query.sort] - 默认相关度；`time` 按结束时间倒序。
 * @param {number|Date} [query.now] - 排序用的"现在"（默认取系统时间）。
 * @param {object} [query.weights] - S-5 权重覆盖（C-2）。
 * @param {object|Map|Function} [query.labels] - 状态标签，键 `sessionId#turn`。
 * @param {'sum'|'max'} [query.statusMode] - 状态叠加方式。
 * @returns {{hits: Array, total: number, truncated: boolean}} 命中、命中总数、是否被截断。
 */
export function searchTurns(turns, query) {
  const q = isPlainObject(query) ? query : {}
  const list = Array.isArray(turns) ? turns : []
  const keywords = normalizeKeywords(q.keywords)
  const filters = normalizeFilters(q.filters)
  const from = toMs(isPlainObject(q.timeRange) ? q.timeRange.from : undefined)
  const to = toMs(isPlainObject(q.timeRange) ? q.timeRange.to : undefined)
  const limit = normalizeLimit(q.limit)
  const groupBy = q.groupBy === 'session' ? 'session' : 'none'
  const sort = q.sort === 'time' ? 'time' : 'relevance'
  const labels = q.labelOf ?? q.labels ?? (isPlainObject(q.filters) ? q.filters.labels : undefined)

  const found = []
  for (const turn of list) {
    if (!isPlainObject(turn)) continue
    const time = timeOf(turn)
    // 时间区间：给了区间就必须有可比较的时间，否则无法判定"在区间内"。
    if (Number.isFinite(from) && (time === null || time < from)) continue
    if (Number.isFinite(to) && (time === null || time > to)) continue
    if (!matchSession(turn, filters)) continue
    if (!matchTools(turn, filters)) continue
    if (!matchFiles(turn, filters)) continue
    if (!matchEndReason(turn, filters)) continue

    const label = resolveLabel(turn, labels)
    if (!matchStatuses(label, filters)) continue

    const scan = scanKeywords(turn, keywords)
    if (scan === null) continue

    // 无关键词（浏览态）时用有内容的一侧展示；有关键词时取命中次数更多的一侧。
    const matchedIn = keywords.length === 0
      ? (scan.prompt.trim() !== '' ? 'prompt' : 'response')
      : (scan.promptMatches > 0 && scan.promptMatches >= scan.responseMatches ? 'prompt' : 'response')

    found.push(makeHit(turn, time, scan, matchedIn, keywords, label))
  }

  const ranked = rankHits(found, {
    now: q.now,
    weights: q.weights,
    labels,
    statusMode: q.statusMode,
  })
  if (sort === 'time') ranked.sort(byTimeDesc)

  const total = ranked.length
  if (groupBy === 'session') {
    const groups = groupBySession(ranked, limit)
    const returned = groups.reduce((count, group) => count + group.count, 0)
    return { hits: groups, total, truncated: total > returned }
  }
  const hits = ranked.slice(0, limit)
  return { hits, total, truncated: total > hits.length }
}
