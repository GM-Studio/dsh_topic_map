/**
 * 筛选：从泳道列表里挑出"匹配当前条件"的那些。
 *
 * 为什么单独成模块：筛选条件会越来越多（关键字、阶段、状态、轮次范围），
 * 而它的正确性完全可以用纯函数验证——不值得为了"看效果"反复手动点。
 * 界面只负责收集条件并把结果画出来。
 *
 * 设计上的一个取舍：**多条件之间是"与"**，同一条件内部（如多个阶段）是"或"。
 * 这符合一般筛选器的直觉：勾了两个阶段 = 看这两个；同时又搜了关键字 = 两者都要满足。
 *
 * @module dsh-topic-map/filter
 */

/** 空条件：不做任何筛选。 */
export function emptyFilter() {
  return {
    query: '',        // 关键字
    stages: [],       // 选中的阶段名（空数组 = 不限）
    states: [],       // 选中的状态（空数组 = 不限）
    minTurns: null,   // 轮次数下限（含）
    maxTurns: null,   // 轮次数上限（含）
  }
}

/**
 * 判断是否"没有设置任何条件"。
 * 用于界面显示"筛选生效中"标记，以及跳过无谓的计算。
 *
 * @param filter - 条件。
 * @returns 是否为空条件。
 */
export function isFilterEmpty(filter) {
  if (filter === null || filter === undefined) return true
  const q = String(filter.query ?? '').trim()
  const stages = Array.isArray(filter.stages) ? filter.stages : []
  const states = Array.isArray(filter.states) ? filter.states : []
  return q === '' && stages.length === 0 && states.length === 0
    && (filter.minTurns === null || filter.minTurns === undefined)
    && (filter.maxTurns === null || filter.maxTurns === undefined)
}

/**
 * 一条泳道的可搜索文本。
 *
 * 把阶段名、工作流名、话题名、以及该泳道包含的所有轮次的提问都拼进去：
 * 用户搜索时想找的可能是"哪个话题里提过 API key"，而那个词只出现在
 * 某一轮的对话里，不在标题上。
 *
 * @param lane - 泳道。
 * @returns 小写化的可搜索文本。
 */
export function laneHaystack(lane) {
  if (lane === null || lane === undefined) return ''
  const parts = [
    lane.title,
    lane.stageName,
    lane.workflowName,
    lane.taskName,
  ]
  // 轮次里的提问文本（如果 Host 一并下发）
  if (Array.isArray(lane.turnTexts)) parts.push(...lane.turnTexts)
  return parts
    .filter(p => typeof p === 'string' && p !== '')
    .join(' ')
    .toLowerCase()
}

/**
 * 一条泳道在筛选下的状态。
 *
 * @param lane - 泳道。
 * @param filter - 条件。
 * @param factOf - `(turn) => fact`，取轮次事实（用于状态判断）。
 * @returns `{ match: boolean, reason: string }`。
 */
export function matchLane(lane, filter, factOf) {
  if (lane === null || lane === undefined) return { match: false, reason: 'empty' }
  if (isFilterEmpty(filter)) return { match: true, reason: '' }

  // 1. 关键字
  const q = String(filter.query ?? '').trim().toLowerCase()
  if (q !== '') {
    const hay = laneHaystack(lane)
    if (!hay.includes(q)) return { match: false, reason: 'query' }
  }

  // 2. 阶段（同条件内是"或"）
  const stages = Array.isArray(filter.stages) ? filter.stages : []
  if (stages.length > 0) {
    const name = lane.stageName ?? ''
    if (!stages.includes(name)) return { match: false, reason: 'stage' }
  }

  // 3. 状态（按该泳道首个轮次的结束原因归入某个状态桶）
  const states = Array.isArray(filter.states) ? filter.states : []
  if (states.length > 0) {
    const turns = Array.isArray(lane.turns) ? lane.turns : []
    if (turns.length === 0) return { match: false, reason: 'state' }
    const fact = typeof factOf === 'function' ? factOf(turns[0]) : undefined
    const bucket = stateBucketOf(fact)
    if (!states.includes(bucket)) return { match: false, reason: 'state' }
  }

  // 4. 轮次数范围
  const n = Array.isArray(lane.turns) ? lane.turns.length : 0
  if (Number.isFinite(filter.minTurns) && n < filter.minTurns) return { match: false, reason: 'turns' }
  if (Number.isFinite(filter.maxTurns) && n > filter.maxTurns) return { match: false, reason: 'turns' }

  return { match: true, reason: '' }
}

/**
 * 把轮次事实的结束原因归入状态桶。
 *
 * 这些桶**不是**真正的任务状态（日志里没有那个字段），而是"这一轮怎么结束的"。
 * 名字用中文是为了直接显示在筛选器上。
 *
 * @param fact - 轮次事实。
 * @returns 状态名。
 */
export function stateBucketOf(fact) {
  if (fact === null || fact === undefined) return '未知'
  const reason = fact.endReason
  if (reason === 'open') return '进行中'
  if (reason === 'error') return '出错'
  if (reason === 'max-tokens') return '超长'
  if (reason === 'aborted' || reason === 'interrupted' || reason === 'blocked') return '中断'
  return '完成'
}

/** 所有可能出现状态桶，供界面列复选框。 */
export const STATE_BUCKETS = ['完成', '进行中', '出错', '超长', '中断', '未知']

/**
 * 对泳道列表应用筛选。
 *
 * @param lanes - 泳道数组。
 * @param filter - 条件。
 * @param factOf - `(turn) => fact`。
 * @returns `{ visible, hidden, counts }`：可见的、被隐藏的、以及统计信息。
 */
export function applyFilter(lanes, filter, factOf) {
  const list = Array.isArray(lanes) ? lanes : []
  const visible = []
  const hidden = []
  for (const lane of list) {
    const result = matchLane(lane, filter, factOf)
    if (result.match) visible.push(lane)
    else hidden.push(lane)
  }
  return {
    visible,
    hidden,
    counts: { total: list.length, visible: visible.length, hidden: hidden.length },
  }
}

/**
 * 收集所有可选阶段（去重，按首次出现排序）。
 *
 * @param lanes - 泳道数组。
 * @returns 阶段名数组。
 */
export function collectStages(lanes) {
  const seen = new Set()
  const out = []
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    const name = typeof lane.stageName === 'string' && lane.stageName !== '' ? lane.stageName : null
    if (name === null || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/**
 * 在文本里标出关键字命中的位置，供界面高亮。
 *
 * 返回分段数组而不是 HTML 字符串：避免把用户输入拼进 innerHTML
 * （那是一条 XSS 通路，哪怕输入只来自用户自己）。
 *
 * @param text - 原文。
 * @param query - 关键字。
 * @returns `[{ text, hit }]`。
 */
export function highlightParts(text, query) {
  const raw = String(text ?? '')
  const q = String(query ?? '').trim()
  if (q === '' || raw === '') return [{ text: raw, hit: false }]
  const lower = raw.toLowerCase()
  const needle = q.toLowerCase()
  const parts = []
  let from = 0
  for (;;) {
    const at = lower.indexOf(needle, from)
    if (at < 0) break
    if (at > from) parts.push({ text: raw.slice(from, at), hit: false })
    parts.push({ text: raw.slice(at, at + q.length), hit: true })
    from = at + q.length
  }
  if (from < raw.length) parts.push({ text: raw.slice(from), hit: false })
  return parts.length === 0 ? [{ text: raw, hit: false }] : parts
}
