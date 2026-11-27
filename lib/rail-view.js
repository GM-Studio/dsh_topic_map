/**
 * 历史轨视图模型（V-12）：把原生轮次导航轨的 DOM 快照 / 轮次大纲映射成可渲染的行。
 *
 * ══ spike 结论（2026-11，app.asar 内 @deepseek-ai/dsh-client-ui-chat 源码）══
 *
 * 组件：`TurnNavigator` / `TurnNavigatorRail`（React，源码在 asar 里可读，
 * 位置关键字 `TurnNavigatorRail`、`TurnNavigator.module.css`）。
 *
 * 挂载与结构（ChatView 直接渲染 `<TurnNavigator items activeTurn busyTurn onNavigate t />`）：
 *
 *   [data-conversation-scroll]            ← 对话滚动容器（宿主自己持有）
 *     div._slot                           ← position:sticky，为轨道提供定位上下文
 *       nav._frame[aria-label]            ← **原生轨道容器本身**，absolute right:12px
 *         div._scroller                   ← 真正的轨道滚动容器（overflow-y:auto）
 *           div._marks
 *             button[data-index][aria-label][aria-current?][aria-busy?]
 *
 * 槽位继承属性：`_slot` 是 `position:absolute; top:0; left/right:0; height:0; z-index:7;
 * `pointer-events:none`（滚动容器内再改成 `position:sticky`）。**pointer-events 会继承**：
 * 自绘轨必须显式写 `pointer-events:auto`，否则点不动、也拖不了宽；原生 `_frame` 自己也是这么做的。
 *
 * 选择器（类名是构建 hash，逐版本变，**不能硬编码**）：
 *   `[data-conversation-scroll] nav[aria-label="轮次导航"]`
 *   `[data-conversation-scroll] nav[aria-label="Turn navigation"]`
 *   容器内按钮：`nav button[data-index]`；轨道滚动容器：`nav.firstElementChild`。
 *
 * 每项结构：按钮**没有文本内容**，刻度是 20×2 的伪元素；摘要只出现在
 * hover/focus 的 tooltip（`div[role=tooltip]`）里，且由 React 按 preview turn 渲染。
 *
 * 当前轮标记：**只有活动轮那一个按钮带 `aria-current="true"`**，其余按钮连
 * `aria-current` 属性都没有。活动轮不在虚拟窗口内时，DOM 里一个 `aria-current` 都没有
 * ——所以「读不到」不等于「没有活动轮」，要保留上一次的值。
 *
 * `data-index` 的实际语义：`mergeTurnRailItems(loadedItems, turnOutline)` 之后
 * **按 turn 升序的合并列表下标（0-based）**。它不是轮号，也不是「已加载第几轮」：
 * 有未加载轮时两者必然错开（例如已加载 1、2 轮 + 大纲 3…9 轮，data-index 7 可能是第 8 轮）。
 * 轨道用 @tanstack/react-virtual 虚拟化（10px 定距、overscan 3），DOM 里只有
 * 可见窗口那十几个按钮，**data-index 仍是绝对下标**，所以绝不能拿「第几个按钮」当轮号。
 *
 * `aria-label` 文案（宿主 locale）：zh `跳转到第 {turn} 轮` / `加载并跳转到第 {turn} 轮`；
 * en `Jump to turn {turn}` / `Load and jump to turn {turn}`；tooltip 里还有 `第 {turn} 轮`。
 * 轮号就在文案里，是最稳的兜底来源。
 *
 * 轮次总数 < 2 时组件直接 `return null`（DOM 里没有 nav）——「找不到容器」不一定是失配，
 * 接管方必须区分「还没挂载 / 轮次太少」与「容器在但按钮不可用」。
 *
 * ══ 本模块的边界 ═══════════════════════════════════════════════════════
 * 纯函数：不读 DOM、不 import、不读系统时钟（`new Date(value)` 只做给定时刻的换算）。
 * 渲染、拖拽、MutationObserver 全在 client.js；这里只回答「这些节点/大纲应该是哪几行」。
 *
 * @module dsh-topic-map/rail-view
 */

/** 三档目标宽度（px）：细轨 / 标准 / 宽轨。拖拽释放时吸附到这三档。 */
export const TIER_WIDTHS = Object.freeze({ hair: 40, normal: 200, wide: 320 })

/** 细轨与标准档的分界：两档目标宽度的中点 (40+200)/2。 */
const HAIR_MAX = 120

/** 标准档与宽档的分界：(200+320)/2。 */
const NORMAL_MAX = 260

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 归一成数字；`null` / `undefined` / 空白串 / 非有限值一律 null。
 *
 * 注意不能用裸 `Number()`：`Number(null) === 0` 会把「没有」悄悄变成第 0 轮。
 *
 * @param {*} value - 候选值。
 * @returns {number|null} 有限数字或 null。
 */
function toNumber(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' && value.trim() === '') return null
  if (typeof value === 'boolean') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

/** 压缩连续空白（摘要里不能留换行）。 */
function compress(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/** 两位补零。 */
function pad2(value) {
  return value < 10 ? '0' + value : String(value)
}

/** 把毫秒时间戳换算成 HH:MM（只做换算，不读当前时间）。 */
function clockText(ms) {
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

/**
 * 宽度 → 三档。
 *
 * 目标是三档可拖拽：40 / 200 / 320。档位按两档目标宽度的中点切开，
 * 拖过 120px 就进标准档、拖过 260px 就进宽档。缺失或非法宽度按标准档
 * （200px 是默认观感最稳的一档）。
 *
 * @param {number|string} [width] - 轨道宽度（px）。
 * @returns {'hair'|'normal'|'wide'} 档位。
 */
export function tierOf(width) {
  if (width === null || width === undefined || width === '') return 'normal'
  const px = Number(width)
  if (!Number.isFinite(px)) return 'normal'
  if (px < HAIR_MAX) return 'hair'
  if (px < NORMAL_MAX) return 'normal'
  return 'wide'
}

/**
 * 把任意宽度吸附到最近的目标档位，并夹在 40…320 之间。
 *
 * 拖拽释放时用它收口：许拖出中间值，最终只停在三个档位上，
 * 这样「按会话记住的宽度」不会变成一堆 137、188 px 的碎片。
 *
 * @param {number|string} width - 拖拽中的宽度。
 * @returns {number} 40 / 200 / 320。
 */
export function snapWidth(width) {
  const px = Number(width)
  if (!Number.isFinite(px)) return TIER_WIDTHS.normal
  const clamped = Math.min(TIER_WIDTHS.wide, Math.max(TIER_WIDTHS.hair, px))
  let best = TIER_WIDTHS.hair
  let distance = Math.abs(clamped - best)
  for (const key of ['normal', 'wide']) {
    const candidate = TIER_WIDTHS[key]
    const next = Math.abs(clamped - candidate)
    if (next < distance) { best = candidate; distance = next }
  }
  return best
}

/**
 * 从按钮文案里解析轮号。
 *
 * 只接受 aria-label / title 这类**机器写的**文案，绝不拿用户提问当输入：
 * 用户完全可能在提问里写「第 3 轮」，那不代表这是第 3 轮。
 *
 * 支持宿主现有文案：`跳转到第 12 轮`、`加载并跳转到第 12 轮`、`第 12 轮`、
 * `Jump to turn 12`、`Turn 12`，以及 `#12`。
 *
 * @param {*} label - 按钮文案。
 * @returns {number|null} 轮号；解析不到返回 null。
 */
export function turnOfLabel(label) {
  const text = String(label ?? '')
  if (text === '') return null
  const zh = text.match(/第\s*#?\s*(\d+)\s*轮/)
  if (zh !== null) return toNumber(zh[1])
  const en = text.match(/[Tt]urn\s*#?\s*(\d+)/)
  if (en !== null) return toNumber(en[1])
  const hash = text.match(/(?:^|\s)#\s*(\d+)/)
  if (hash !== null) return toNumber(hash[1])
  return null
}

/** 从节点上读一个属性；兼容 `{dataIndex}` / `{'data-index'}` / `{attrs:{...}}` 三种形状。 */
function readField(node, camel, kebab) {
  if (node[camel] !== undefined && node[camel] !== null) return node[camel]
  if (kebab !== undefined && node[kebab] !== undefined && node[kebab] !== null) return node[kebab]
  if (isPlainObject(node.attrs)) {
    if (node.attrs[camel] !== undefined && node.attrs[camel] !== null) return node.attrs[camel]
    if (kebab !== undefined && node.attrs[kebab] !== undefined && node.attrs[kebab] !== null) return node.attrs[kebab]
  }
  return undefined
}

/** 节点在原生合并列表里的绝对下标（data-index）；没有或非法返回 null。 */
function indexOfNode(node) {
  // 优先读 data-index 的几种写法；裸 `index` 只作为调用方显式给下标的兜底，
  // 不能先读它——行原料上的 index 常常是「第几行」，与原生合并列表不是一回事。
  let raw = readField(node, 'dataIndex', 'data-index')
  if (raw === undefined) raw = readField(node, 'index', 'index')
  const value = toNumber(raw)
  if (value === null || !Number.isInteger(value) || value < 0) return null
  return value
}

/** 节点上的 aria-current 值。 */
function ariaCurrentOf(node) {
  const raw = readField(node, 'ariaCurrent', 'aria-current')
  if (raw === true) return 'true'
  if (raw === false || raw === null || raw === undefined) return ''
  return String(raw)
}

/** 节点是否活动。 */
function isActiveNode(node) {
  if (node.active === true) return true
  const current = ariaCurrentOf(node)
  return current === 'true' || current === 'page'
}

/** 节点上可用于解析轮号的机器文案（绝不含用户正文）。 */
function machineLabelOf(node) {
  const raw = readField(node, 'ariaLabel', 'aria-label')
  if (typeof raw === 'string' && raw.trim() !== '') return raw
  const title = readField(node, 'title', 'title')
  if (typeof title === 'string' && title.trim() !== '') return title
  return ''
}

/**
 * 解析一轮的轮号。
 *
 * 优先级（每一级都写明了来源，便于失配时排查）：
 * 1. 节点自带 `turn`（宿主以后若暴露 data-turn，直接可用）；
 * 2. `options.turns[index]`——调用方给出的「与原生同源的升序轮次表」，
 *    这是唯一正确的 data-index → turn 映射方式（下标查表，**不是 dataIndex+1**）；
 * 3. aria-label / title 里的「第 N 轮」正则；
 * 4. 降级：按节点在**本次快照里的先后顺序**编号（第 i 个节点 → i+1）。
 *
 * 第 4 级是降级路径：虚拟化后快照可能从第 40 个按钮开始，此时顺序编号会
 * 与真实轮号错开；界面据此只保证「可点击、有刻度」，不保证轮号准确。
 *
 * @param {object} node - 节点描述。
 * @param {number[]|null} turns - 与原生同源的升序轮次表。
 * @param {number} index - 节点的绝对下标（data-index，缺失时为快照位置）。
 * @param {number} position - 节点在快照里的位置（0-based）。
 * @returns {number} 轮号（一定 ≥ 1）。
 */
function resolveTurn(node, turns, index, position) {
  const explicit = toNumber(node.turn)
  if (explicit !== null && explicit > 0) return explicit
  if (Array.isArray(turns)) {
    const mapped = toNumber(turns[index])
    if (mapped !== null && mapped > 0) return mapped
  }
  const fromLabel = turnOfLabel(machineLabelOf(node))
  if (fromLabel !== null && fromLabel > 0) return fromLabel
  return position + 1
}

/** 节点上的时间显示文本。 */
function timeTextOf(node) {
  const explicit = readField(node, 'timeText', 'time-text')
  if (typeof explicit === 'string' && explicit.trim() !== '') return compress(explicit)
  // 优先该轮**开始**时间：长轮次用结束时间会显示成"半小时后"，不符合直觉。
  const startedAt = readField(node, 'start')
  if (typeof startedAt === 'number' && Number.isFinite(startedAt)) return clockText(startedAt)
  const raw = readField(node, 'time', 'time')
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return ''
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return text.slice(0, 5)
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? clockText(parsed) : compress(text)
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) return clockText(raw)
  return ''
}

/** 节点上的摘要文本（promptHead 优先，其次调用方给的 label/text）。 */
function labelOf(node) {
  for (const key of ['promptHead', 'label', 'text']) {
    const value = node[key]
    if (typeof value === 'string' && value.trim() !== '') return compress(value)
  }
  return ''
}

/**
 * 把节点描述映射成轨行。
 *
 * 节点可以是原生按钮的快照（`{dataIndex, ariaLabel, ariaCurrent}`），也可以是
 * 调用方用轮次大纲拼出来的行原料（`{turn, promptHead, time}`）。函数只做归一，
 * 不关心来源；**行序 = 节点序**，不去重、不排序——排序由调用方决定，避免
 * 「DOM 顺序」与「轮号顺序」被悄悄混为一谈。
 *
 * 行模型：
 * - `index`：节点在原生合并列表里的绝对下标（有 data-index 用它，否则用快照位置）；
 * - `turn`：轮号，永不缺失（最差走顺序编号降级）；
 * - `label`：摘要（promptHead / label / text，压缩空白；没有就空串）；
 * - `active`：是否当前轮（`active:true` 或 `aria-current="true"/"page"`）；
 * - `timeText`：时间显示文本（HH:MM 或调用方给的原样文本；没有就空串）；
 * - `hit`：是否命中（透传 `node.hit === true`，供命中标记用；默认 false）。
 *
 * @param {Array<object>} nodes - 节点描述数组。
 * @param {object} [options] - 选项。
 * @param {Array<number|string>} [options.turns] - 与原生同源的升序轮次表（data-index → turn）。
 * @returns {Array<{index:number, turn:number, label:string, active:boolean, timeText:string, hit:boolean}>} 行模型。
 */
export function rowsOf(nodes, options) {
  const list = Array.isArray(nodes) ? nodes : []
  const settings = isPlainObject(options) ? options : {}
  const turns = Array.isArray(settings.turns) ? settings.turns : null
  const rows = []
  for (let position = 0; position < list.length; position += 1) {
    const node = isPlainObject(list[position]) ? list[position] : {}
    const dataIndex = indexOfNode(node)
    const index = dataIndex === null ? position : dataIndex
    const turn = resolveTurn(node, turns, index, position)
    rows.push({
      index,
      turn,
      label: labelOf(node),
      active: isActiveNode(node),
      timeText: timeTextOf(node),
      hit: node.hit === true,
    })
  }
  return rows
}

/**
 * 活动行在行数组里的位置。
 *
 * 返回的是**数组下标**（给滚动/高亮用），不是 `row.index`、也不是轮号。
 * 没有任何行活动时返回 -1（虚拟化把活动刻度移出 DOM 时就会这样）。
 *
 * @param {Array<object>} rows - `rowsOf` 的行数组。
 * @returns {number} 数组下标；没有活动行 -1。
 */
export function activeIndexOf(rows) {
  if (!Array.isArray(rows)) return -1
  for (let i = 0; i < rows.length; i += 1) {
    if (isPlainObject(rows[i]) && rows[i].active === true) return i
  }
  return -1
}

/**
 * 某一轮在行数组里的锚点位置。
 *
 * 点击跳转后用它把该行滚进轨道的可视区；纯查表，找不到返回 -1。
 * 返回数组下标，与 `activeIndexOf` 同一套坐标。
 *
 * @param {Array<object>} rows - `rowsOf` 的行数组。
 * @param {number|string} turn - 轮号。
 * @returns {number} 数组下标；该轮不在行里 -1。
 */
export function anchorFor(rows, turn) {
  if (!Array.isArray(rows)) return -1
  const target = toNumber(turn)
  if (target === null) return -1
  for (let i = 0; i < rows.length; i += 1) {
    if (isPlainObject(rows[i]) && toNumber(rows[i].turn) === target) return i
  }
  return -1
}

/**
 * 接管前自检。
 *
 * 只检查「能不能安全隐藏原生容器」这一件事，**不检查轮号是否准确**：
 * 轮号解析失败还有顺序编号降级，属于「能接管」；容器或按钮缺失则会
 * 变出一个空轨，那才是失配。失配时调用方必须**不隐藏原生**、继续用原生，
 * 并把这句 `reason` 写进界面底部一行灰字。
 *
 * @param {object} snapshot - 快照。
 * @param {*} [snapshot.container] - 原生轨道容器（nav）。
 * @param {Array<object>} [snapshot.buttons] - 容器内的轮次按钮快照。
 * @returns {{ok:boolean, code:string, reason:string}} 自检结果（`reason` 面向界面）。
 */
export function selfCheck(snapshot) {
  const input = isPlainObject(snapshot) ? snapshot : {}
  const container = input.container
  if (container === null || container === undefined) {
    return { ok: false, code: 'no-container', reason: '未找到原生导航轨容器' }
  }
  const buttons = Array.isArray(input.buttons) ? input.buttons : null
  if (buttons === null || buttons.length === 0) {
    return { ok: false, code: 'no-buttons', reason: '原生导航轨没有轮次按钮' }
  }
  let indexed = 0
  for (const button of buttons) {
    if (!isPlainObject(button)) continue
    const raw = readField(button, 'dataIndex', 'data-index')
    if (toNumber(raw) !== null) indexed += 1
  }
  if (indexed === 0) {
    return { ok: false, code: 'no-index', reason: '原生轮次按钮缺少 data-index' }
  }
  return { ok: true, code: 'ok', reason: '' }
}

/** 读取一段的起止轮号；兼容 startTurn/endTurn 与 turnRange，非法返回 null。 */
function segmentBoundsOf(segment) {
  if (!isPlainObject(segment)) return null
  let start = toNumber(segment.startTurn)
  let end = toNumber(segment.endTurn)
  if ((start === null || end === null) && Array.isArray(segment.turnRange) && segment.turnRange.length >= 2) {
    start = toNumber(segment.turnRange[0])
    end = toNumber(segment.turnRange[1])
  }
  if (start === null || end === null) return null
  start = Math.trunc(start)
  end = Math.trunc(end)
  if (end < start) {
    const tmp = start
    start = end
    end = tmp
  }
  return { startTurn: start, endTurn: end }
}

/** 兜底段标题（如「第 1–3 轮」或「第 4 轮」）。 */
function fallbackSegmentTitle(startTurn, endTurn) {
  return startTurn === endTurn ? ('第 ' + startTurn + ' 轮') : ('第 ' + startTurn + '–' + endTurn + ' 轮')
}

/**
 * 把历史轨行列表与 `/session-outline` 返回的 `segments` 组合成「段头 → 轮次行」两级目录模型。
 *
 * - 无 segments、空 rows，或 segments 与 rows 毫无交集时，平滑退回空数组 `[]`，
 *   调用方可无条件回退到原有扁平 `rows` 渲染；
 * - 若有部分连续轮次尚未被 segments 覆盖（例如刚新增的尾部轮次），自动补齐相邻未覆盖段，
 *   保证绝不丢失任何轮次行；
 * - 纯函数，不修改入参。
 *
 * @param {Array<object>} rows - `rowsOf` 产出的行数组。
 * @param {Array<object>} segments - `/session-outline` 返回的段数组。
 * @returns {Array<{id:string, title:string, startTurn:number, endTurn:number, turnCount:number, kindCandidate:'work'|'chat', hasError:boolean, active:boolean, rows:Array<object>}>}
 */
export function segmentGroupsOf(rows, segments) {
  const rowList = Array.isArray(rows) ? rows.filter(isPlainObject) : []
  const segList = Array.isArray(segments) ? segments.filter(isPlainObject) : []
  if (rowList.length === 0 || segList.length === 0) return []

  // 解析合法段并保留原次序（同一轮优先归入第一个覆盖它的段）
  const parsedSegments = []
  for (let i = 0; i < segList.length; i += 1) {
    const seg = segList[i]
    const bounds = segmentBoundsOf(seg)
    if (bounds === null) continue
    const errorTurns = new Set()
    if (Array.isArray(seg.errorTurns)) {
      for (const value of seg.errorTurns) {
        const turn = toNumber(value)
        if (turn !== null) errorTurns.add(Math.trunc(turn))
      }
    }
    const rawId = typeof seg.id === 'string' && seg.id.trim() !== '' ? seg.id.trim() : ''
    const rawTitle = typeof seg.title === 'string' ? compress(seg.title) : ''
    parsedSegments.push({
      id: rawId !== '' ? rawId : ('seg-' + bounds.startTurn + '-' + bounds.endTurn + '-' + i),
      title: rawTitle !== '' ? rawTitle : fallbackSegmentTitle(bounds.startTurn, bounds.endTurn),
      startTurn: bounds.startTurn,
      endTurn: bounds.endTurn,
      kindCandidate: seg.kindCandidate === 'work' ? 'work' : 'chat',
      hasError: seg.hasError === true || errorTurns.size > 0,
      errorTurns,
      matchedRows: [],
      firstPos: -1,
    })
  }
  if (parsedSegments.length === 0) return []

  // 将每一行分配到覆盖它的段；记录未被任何段覆盖的行位置
  const ownerOfPos = new Array(rowList.length).fill(-1)
  let coveredCount = 0
  for (let pos = 0; pos < rowList.length; pos += 1) {
    const row = rowList[pos]
    const turn = toNumber(row.turn)
    if (turn === null) continue
    const t = Math.trunc(turn)
    for (let s = 0; s < parsedSegments.length; s += 1) {
      const seg = parsedSegments[s]
      if (t >= seg.startTurn && t <= seg.endTurn) {
        ownerOfPos[pos] = s
        seg.matchedRows.push(row)
        if (seg.firstPos < 0) seg.firstPos = pos
        coveredCount += 1
        break
      }
    }
  }

  // segments 未覆盖任何一行时平滑退回空数组
  if (coveredCount === 0) return []

  // 按 rows 出现顺序组装段，并把连续未覆盖的孤立行收集为兜底段，避免静默丢行
  const groups = []
  const emitted = new Set()
  let orphanRows = []

  const flushOrphans = () => {
    if (orphanRows.length === 0) return
    const turns = orphanRows
      .map(r => toNumber(r.turn))
      .filter(v => v !== null)
      .map(Math.trunc)
    const startTurn = turns.length > 0 ? Math.min(...turns) : 1
    const endTurn = turns.length > 0 ? Math.max(...turns) : startTurn
    const hasError = orphanRows.some(r => r.hasError === true)
    const active = orphanRows.some(r => r.active === true)
    groups.push({
      id: 'seg-orphan-' + startTurn + '-' + endTurn + '-' + groups.length,
      title: fallbackSegmentTitle(startTurn, endTurn),
      startTurn,
      endTurn,
      turnCount: orphanRows.length,
      kindCandidate: 'chat',
      hasError,
      active,
      rows: orphanRows.slice(),
    })
    orphanRows = []
  }

  for (let pos = 0; pos < rowList.length; pos += 1) {
    const owner = ownerOfPos[pos]
    if (owner < 0) {
      orphanRows.push(rowList[pos])
      continue
    }
    flushOrphans()
    if (emitted.has(owner)) continue
    emitted.add(owner)
    const seg = parsedSegments[owner]
    const segRows = seg.matchedRows.slice()
    const hasError = seg.hasError || segRows.some(r => {
      if (r.hasError === true) return true
      const t = toNumber(r.turn)
      return t !== null && seg.errorTurns.has(Math.trunc(t))
    })
    const active = segRows.some(r => r.active === true)
    groups.push({
      id: seg.id,
      title: seg.title,
      startTurn: seg.startTurn,
      endTurn: seg.endTurn,
      turnCount: segRows.length,
      kindCandidate: seg.kindCandidate,
      hasError,
      active,
      rows: segRows,
    })
  }
  flushOrphans()

  return groups
}
