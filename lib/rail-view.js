/**
 * 历史轨视图模型（V-12 / ui.md §10）：把「已加载轮次 + turnOutline + 命中集合」
 * 变成可直接渲染的轨道行。
 *
 * 为什么单独成模块：轨道是 DOM 级接管（原生 nav 没有 slot 座位），渲染层要处理
 * 三档宽度、摘要截断、命中模式、活动轮与滚动锚点。这些全是纯数据变换，独立测试
 * 比在真实会话里反复拖宽度可靠得多。
 *
 * 防错重点（spike 已核实，别在渲染层再犯）：
 * - 原生 `button[data-index]` 是**合并列表的 0-based 序号，不是轮号**；
 *   `mapIndexToTurn` 只按同源有序列表做位置查询，绝不做 `dataIndex + 1`。
 * - 只输出已加载轮次：未加载的轮次点了跳不过去，不如不显示。
 * - 不 import、不读 DOM、不读系统时钟：以后由 build-theme 原样嵌入 client bundle。
 *
 * @module dsh-topic-map/rail-view
 */

/** 细轨上限（px）：低于它就只剩刻度。 */
const NARROW_MAX = 60

/** 标准档上限（px）：再宽就是宽档。 */
const NORMAL_MAX = 260

/** 摘要截断长度（字符数，中英一视同仁）。 */
const SUMMARY_LIMIT = Object.freeze({ narrow: 0, normal: 24, wide: 40 })

/** 状态键（A-3 三个开关）。 */
const STATUS_KEYS = Object.freeze(['starred', 'solved', 'followUp'])

/** 算"失败"的结束原因：需要重试的那些（与 hit-view 的 badges 同口径）。 */
const FAIL_REASONS = new Set(['error', 'failed', 'blocked', 'max-tokens', 'max-turns'])

/** 算"中断"的结束原因。 */
const INTERRUPT_REASONS = new Set(['interrupted', 'aborted'])

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 把数组 / Set 摊平成数组；其余返回空数组。 */
function asArray(value) {
  if (Array.isArray(value)) return value
  if (value instanceof Set) return [...value]
  return []
}

/**
 * 把轮号 / seq 归一成数字；非法返回 null。
 *
 * 注意：`null`、`undefined`、空白字符串不能被 `Number()` 悄悄变成 0。
 *
 * @param {*} value - 候选值。
 * @returns {number|null} 有限数字或 null。
 */
function toTurn(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** 压缩连续空白。 */
function compress(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 取首句：到第一个中文/英文句末标点为止（不含标点）。 */
function firstSentence(text) {
  const at = text.search(/[。！？!?；;]/)
  if (at === -1) return text
  const head = text.slice(0, at).trim()
  return head === '' ? text : head
}

/**
 * 按"字符"截断：用码点切，绝不把代理对（emoji / 生僻字）切成半个。
 *
 * @param {string} text - 原文。
 * @param {number} limit - 最多保留多少个码点。
 * @returns {string} 截断后的文本。
 */
function truncateChars(text, limit) {
  const max = Number(limit)
  if (!Number.isFinite(max) || max <= 0) return ''
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('')
}

/** 摘要首句：优先提问，空则用回答；压缩空白并取首句。 */
function summaryText(prompt, response) {
  const question = compress(prompt)
  const answer = compress(response)
  return firstSentence(question !== '' ? question : answer)
}

/**
 * 宽度 → 三档。
 *
 * 阈值：`< 60px` 细轨、`< 260px` 标准、其余宽档。默认/非法宽度按标准档（200px）。
 *
 * @param {number|string} [width] - 轨道宽度（px）。
 * @returns {'narrow'|'normal'|'wide'} 档位。
 */
export function tierOf(width) {
  if (width === null || width === undefined || width === '') return 'normal'
  const px = Number(width)
  if (!Number.isFinite(px)) return 'normal'
  if (px < NARROW_MAX) return 'narrow'
  if (px < NORMAL_MAX) return 'normal'
  return 'wide'
}

/** 一条命中记录的空壳。 */
function newHitEntry(turn) {
  return { turn, count: 0, snippet: '', hit: null }
}

/** 命中次数累加（Set / 数字集合）。 */
function bumpHit(map, turn, amount) {
  if (turn === null) return
  const entry = map.get(turn) ?? newHitEntry(turn)
  entry.count += amount
  map.set(turn, entry)
}

/** 收录一条命中的对象（带 matchCount / snippet / 状态原料）。 */
function addHitObject(map, turn, hit) {
  if (turn === null) return
  const entry = map.get(turn) ?? newHitEntry(turn)
  const count = Number(hit.matchCount)
  entry.count += Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
  if (entry.snippet === '' && typeof hit.snippet === 'string') entry.snippet = hit.snippet
  if (entry.hit === null) entry.hit = hit
  map.set(turn, entry)
}

/** 数字型命中值的次数：非法时按 1 次。 */
function valueToCount(value) {
  const count = Number(value)
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1
}

/**
 * 把各种命中集合归一成 `Map<turn, {count, snippet, hit}>`。
 *
 * 支持的形状：
 * - `Set<turn>` / `[turn, ...]`（数字字符串也认）；
 * - `searchTurns` 的命中数组（用 `matchCount` 当次数、`snippet` 当命中片段）；
 * - `Map<turn, count | hit>`、`{ [turn]: count | hit }`；
 * - 单条命中对象。
 *
 * @param {*} hits - 命中集合。
 * @returns {Map<number, object>} 按轮号索引。
 */
function collectHits(hits) {
  const map = new Map()
  if (hits instanceof Map) {
    for (const [key, value] of hits) {
      const turn = toTurn(key)
      if (isPlainObject(value)) addHitObject(map, turn, value)
      else if (value === false || value === null || value === undefined) continue
      else bumpHit(map, turn, valueToCount(value))
    }
    return map
  }
  if (hits instanceof Set) {
    for (const value of hits) {
      if (isPlainObject(value)) addHitObject(map, toTurn(value.turn), value)
      else bumpHit(map, toTurn(value), 1)
    }
    return map
  }
  if (Array.isArray(hits)) {
    for (const value of hits) {
      if (isPlainObject(value)) addHitObject(map, toTurn(value.turn), value)
      else bumpHit(map, toTurn(value), 1)
    }
    return map
  }
  if (isPlainObject(hits)) {
    if (hits.turn !== undefined) {
      addHitObject(map, toTurn(hits.turn), hits)
      return map
    }
    for (const key of Object.keys(hits)) {
      const value = hits[key]
      const turn = toTurn(key)
      if (isPlainObject(value)) addHitObject(map, turn, value)
      else if (value === false || value === null || value === undefined) continue
      else bumpHit(map, turn, valueToCount(value))
    }
  }
  return map
}

/**
 * 归一已加载轮次：数字或宿主 navigation 项（`{turn, prompt, response}`）。
 *
 * @param {*} loadedTurns - 已加载轮次。
 * @returns {Array<object>} `{turn, prompt?, response?, seq?, ...}` 数组。
 */
function normalizeLoaded(loadedTurns) {
  const items = []
  const seen = new Set()
  for (const value of asArray(loadedTurns)) {
    const item = isPlainObject(value)
      ? {
        turn: toTurn(value.turn),
        prompt: value.prompt,
        response: value.response,
        seq: value.seq,
        endReason: value.endReason,
        interrupted: value.interrupted,
        changes: value.changes,
        label: value.label,
      }
      : { turn: toTurn(value) }
    if (item.turn === null || seen.has(item.turn)) continue
    seen.add(item.turn)
    items.push(item)
  }
  return items
}

/** 归一 outline：只留合法 turn，去重并按 turn 升序。 */
function normalizeOutline(outline) {
  const entries = []
  const seen = new Set()
  for (const value of asArray(outline)) {
    if (!isPlainObject(value)) continue
    const turn = toTurn(value.turn)
    if (turn === null || seen.has(turn)) continue
    seen.add(turn)
    entries.push({ ...value, turn })
  }
  entries.sort((a, b) => a.turn - b.turn)
  return entries
}

/**
 * 合并一条轮次的状态原料。
 *
 * 优先级：已加载项（当前客户端的事实）→ outline → 命中里带的事实；
 * `label` 反过来以命中（标签层）优先。
 *
 * @param {object|null} outline - outline 条目。
 * @param {object|null} loaded - 已加载项。
 * @param {object|null} hit - 命中对象。
 * @returns {{endReason: *, interrupted: boolean, changes: *, label: *}} 状态原料。
 */
function mergeFacts(outline, loaded, hit) {
  const sources = [loaded, outline, hit].filter(isPlainObject)
  const pick = key => {
    for (const source of sources) {
      const value = source[key]
      if (value !== undefined && value !== null) return value
    }
    return null
  }
  const labels = [hit, loaded, outline].filter(isPlainObject)
  let label = null
  for (const source of labels) {
    if (source.label !== undefined && source.label !== null) {
      label = source.label
      break
    }
  }
  return {
    endReason: pick('endReason'),
    interrupted: sources.some(source => source.interrupted === true),
    changes: pick('changes'),
    label,
  }
}

/** 判断是否失败结束（需要重试）。 */
function isFailure(row) {
  const reason = typeof row.endReason === 'string' ? row.endReason : ''
  return FAIL_REASONS.has(reason)
}

/** 判断是否中断。 */
function isInterrupted(row) {
  const reason = typeof row.endReason === 'string' ? row.endReason : ''
  return row.interrupted === true || INTERRUPT_REASONS.has(reason)
}

/**
 * 判断该轮是否改过文件（F-7）。
 *
 * 支持 `changes: [...]` 与 `changes: {files:[...], lost}`；`lost:true` 仍算有变更。
 *
 * @param {object} row - 行或事实对象。
 * @returns {boolean} 是否有变更。
 */
function hasChanges(row) {
  const changes = row.changes
  if (Array.isArray(changes)) return changes.length > 0
  if (!isPlainObject(changes)) return false
  if (changes.lost === true) return true
  return Array.isArray(changes.files) && changes.files.length > 0
}

/** 标签里是否有任一状态开关为真（对象 / 数组 / 字符串都认）。 */
function hasAnyStatus(label) {
  if (!label) return false
  const matches = value => STATUS_KEYS.some(key => key.toLowerCase() === String(value).trim().toLowerCase())
  if (typeof label === 'string') return matches(label)
  if (Array.isArray(label)) return label.some(matches)
  if (!isPlainObject(label)) return false
  return STATUS_KEYS.some(key => Boolean(label[key]))
}

/**
 * 状态文案（优先级同 hit-view 的 badges）。
 *
 * @param {object} row - 行模型，或带 `endReason / interrupted / changes / label` 的事实对象。
 * @returns {''|'失败'|'中断'|'有变更'|'已标记'} 状态。
 */
export function statusOf(row) {
  const source = isPlainObject(row) ? row : {}
  if (isFailure(source)) return '失败'
  if (isInterrupted(source)) return '中断'
  if (hasChanges(source)) return '有变更'
  if (hasAnyStatus(source.label)) return '已标记'
  return ''
}

/** 造一行。 */
function makeRow(turn, source, hitEntry, activeTurn, tier) {
  const outline = source.outline
  const loaded = source.loaded
  // 摘要以已加载项为准（宿主的 merge 语义），缺了再用 outline 补。
  const pickText = key => {
    const fromLoaded = loaded !== null && typeof loaded[key] === 'string' ? loaded[key] : ''
    if (fromLoaded.trim() !== '') return fromLoaded
    return outline !== null && typeof outline[key] === 'string' ? outline[key] : ''
  }
  const prompt = pickText('prompt')
  const response = pickText('response')
  const seqRaw = outline !== null && outline.seq !== undefined
    ? outline.seq
    : (loaded !== null ? loaded.seq : undefined)
  const hitObject = hitEntry === null ? null : hitEntry.hit
  const facts = mergeFacts(outline, loaded, hitObject)
  const limit = SUMMARY_LIMIT[tier] ?? 0
  const snippet = hitEntry === null ? '' : compress(hitEntry.snippet)

  return {
    turn,
    seq: toTurn(seqRaw),
    tier,
    primary: limit > 0 ? truncateChars(summaryText(prompt, response), limit) : '',
    secondary: tier === 'wide' && snippet !== '' ? truncateChars(snippet, SUMMARY_LIMIT.wide) : '',
    hit: hitEntry !== null,
    hitCount: hitEntry === null ? 0 : hitEntry.count,
    active: activeTurn !== null && turn === activeTurn,
    status: statusOf(facts),
    // 状态原料：UI 可忽略；statusOf(row) 与后续动作（看变更/标记）要用。
    endReason: facts.endReason,
    interrupted: facts.interrupted,
    changes: facts.changes,
    label: facts.label,
  }
}

/**
 * 生成历史轨行模型。
 *
 * 输入：
 * - `outline`：`turnOutline` 数组 `[{turn, seq, prompt, response}]`（可能为 undefined）；
 * - `loadedTurns`：已加载轮次（数字，或 `{turn, prompt, response}`）；**空 = 全部**；
 * - `hits`：命中集合（Set / 命中对象数组 / Map / 按轮号索引的对象）；
 * - `activeTurn`：当前活动轮（来自 `aria-current` 反查，允许字符串）；
 * - `width`：轨道宽度（px，决定 `tier`）。
 *
 * 输出按 `turn` 升序，只含已加载轮次。`narrow` 档 `primary/secondary` 为空串；
 * 摘要按码点截断（normal 24 / wide 40），命中片段只进 `wide` 档的 `secondary`。
 * 行上另带 `endReason / interrupted / changes / label` 作为状态原料（UI 可忽略），
 * 这样 `statusOf(row)` 可以独立重算。
 *
 * @param {object} input - 输入。
 * @param {Array} [input.outline] - `turnOutline`。
 * @param {Array|Set} [input.loadedTurns] - 已加载轮次。
 * @param {*} [input.hits] - 命中集合。
 * @param {number|string} [input.activeTurn] - 活动轮。
 * @param {number|string} [input.width] - 轨道宽度。
 * @returns {Array<object>} 行模型数组。
 */
export function toRailRows(input) {
  const options = isPlainObject(input) ? input : {}
  const tier = tierOf(options.width)
  const hitIndex = collectHits(options.hits)
  const loaded = normalizeLoaded(options.loadedTurns)
  const loadedByTurn = new Map(loaded.map(item => [item.turn, item]))
  const hasLoadedFilter = loaded.length > 0
  const outline = normalizeOutline(options.outline)

  // 先放 outline（可能被已加载集合过滤），再用已加载项补 outline 里没有的轮次。
  const sources = new Map()
  for (const entry of outline) {
    if (hasLoadedFilter && !loadedByTurn.has(entry.turn)) continue
    sources.set(entry.turn, {
      outline: entry,
      loaded: loadedByTurn.get(entry.turn) ?? null,
    })
  }
  if (hasLoadedFilter) {
    for (const item of loaded) {
      if (!sources.has(item.turn)) sources.set(item.turn, { outline: null, loaded: item })
    }
  }

  const activeTurn = toTurn(options.activeTurn)
  const turns = [...sources.keys()].sort((a, b) => a - b)
  return turns.map(turn => makeRow(turn, sources.get(turn), hitIndex.get(turn) ?? null, activeTurn, tier))
}

/**
 * 命中模式：保留所有行，只给非命中行加 `dim: true`。
 *
 * **不删行**是硬要求：轨道行数一变，滚动位置和刻度密度都会跳。
 *
 * @param {Array} rows - `toRailRows` 的行数组。
 * @returns {Array} 新数组（命中行 `dim:false`，其余 `dim:true`）。
 */
export function hitOnly(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map(row => (isPlainObject(row) ? { ...row, dim: row.hit !== true } : row))
}

/**
 * 原生 `data-index` → 轮号。
 *
 * `data-index` 是**合并列表的 0-based 序号**，不是轮号：这里只做
 * `rows[dataIndex].turn` 的位置查询，不做 `dataIndex + 1`，也不做任何
 * "序号等于轮号"的假设。越界 / 非法索引返回 null。
 *
 * ⚠️ `rows` 必须是**与原生同源的合并列表**（`turnOutline` / `mergeTurnRailItems`
 * 的结果），不能传按宽度或已加载集合过滤后的可见行，否则索引会整体偏移。
 *
 * @param {Array} rows - 与原生同源的合并列表（含 `turn` 的对象或裸轮号）。
 * @param {number|string} dataIndex - 原生按钮的 `data-index`。
 * @returns {number|null} 轮号；无法映射时 null。
 */
export function mapIndexToTurn(rows, dataIndex) {
  if (!Array.isArray(rows)) return null
  let index = NaN
  if (typeof dataIndex === 'number') index = dataIndex
  else if (typeof dataIndex === 'string' && dataIndex.trim() !== '') index = Number(dataIndex)
  else return null
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) return null
  const row = rows[index]
  return isPlainObject(row) ? toTurn(row.turn) : toTurn(row)
}

/** 读视口几何；缺参数或非法返回 null。 */
function readViewport(viewport) {
  if (!isPlainObject(viewport)) return null
  const height = Number(viewport.height ?? viewport.viewportHeight)
  const rowHeight = Number(viewport.rowHeight ?? viewport.itemHeight)
  if (!Number.isFinite(height) || height < 0) return null
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return null
  return { height, rowHeight }
}

/**
 * 滚动锚点：让活动轮尽量落在视口中央，边界夹紧。
 *
 * @param {Array} rows - 行模型（需要 `turn`）。
 * @param {number|string} activeTurn - 活动轮。
 * @param {{height: number, rowHeight: number}} [viewport] - 视口高度与行高（px）。
 * @returns {{top: number, index: number}} `index` 为行下标（找不到为 -1），`top` 为滚动值。
 */
export function scrollAnchor(rows, activeTurn, viewport) {
  const list = Array.isArray(rows) ? rows : []
  const target = toTurn(activeTurn)
  let index = -1
  if (target !== null) {
    for (let i = 0; i < list.length; i += 1) {
      if (isPlainObject(list[i]) && toTurn(list[i].turn) === target) {
        index = i
        break
      }
    }
  }
  if (index < 0) return { top: 0, index: -1 }

  const geometry = readViewport(viewport)
  if (geometry === null) return { top: 0, index }

  const contentHeight = list.length * geometry.rowHeight
  const maxTop = Math.max(0, contentHeight - geometry.height)
  const centered = index * geometry.rowHeight - (geometry.height - geometry.rowHeight) / 2
  return { top: Math.min(Math.max(0, centered), maxTop), index }
}
