/**
 * 图的着色模式：话题色 / 状态色。
 *
 * 两种模式回答不同的问题：
 *   - **话题色**（默认）：这条线是哪个话题？——适合"找东西"
 *   - **状态色**：这条线健康吗？——适合"看全局"
 *
 * 状态色的关键设计：同状态的泳道用**同一色系的深浅变化**，而不是完全同色。
 *
 * 为什么不是完全同色：一个会话常有十几条"完成"的泳道，全涂同一个绿会让它们
 * 在视觉上糊成一片，连"这是两条线"都分不出来。而同色系深浅既保留了"都是绿=都完成"
 * 的语义，又让每条线仍可分辨。
 *
 * 节点在状态色模式下**保持话题色**：节点是"轮次"，它的归属是话题，不是状态。
 * 状态是任务级属性，压在整条线上更合理。
 *
 * @module dsh-topic-map/graph-mode
 */

/** 着色模式。 */
export const GRAPH_MODES = ['topic', 'status']

/** 存储键。 */
export const GRAPH_MODE_KEY = 'dsh-topic-map:graphmode'

/**
 * 状态色的基准色相（HSL 的色相角）。
 *
 * 用 HSL 而不是固定色表：同色系深浅需要按序号调制明度，
 * 固定色表做不出"连续可区分"的变化。
 */
export const STATUS_HUE = {
  done: { h: 145, s: 46 },     // 绿：完成
  active: { h: 214, s: 62 },   // 蓝：进行中
  blocked: { h: 32, s: 72 },   // 橙：阻塞
  todo: { h: 220, s: 8 },      // 灰：待办
}

/**
 * 生成状态色。
 *
 * 同状态内按 index 在明度上铺开：从较深到较浅循环，保证相邻两条线不同深浅。
 *
 * @param state - 'done' | 'active' | 'blocked' | 'todo'
 * @param index - 该状态内的序号（0 起）。
 * @param mode - 'light' | 'dark'。
 * @returns CSS 颜色。
 */
export function statusColor(state, index, mode = 'light') {
  const base = STATUS_HUE[state] ?? STATUS_HUE.todo
  const n = Number.isFinite(index) ? Math.abs(index) : 0

  // 在同状态内铺开 5 档明度，第 6 条回到第 1 档
  const step = n % 5
  // 深色主题整体提亮、降饱和，避免在暖黑底上刺眼
  const lightBase = 46
  const lightSpan = 16
  const darkBase = 58
  const darkSpan = 12

  const lightness = mode === 'dark'
    ? darkBase + (step / 4) * darkSpan
    : lightBase + (step / 4) * lightSpan
  const sat = mode === 'dark' ? Math.max(24, base.s - 12) : base.s

  return `hsl(${base.h} ${sat}% ${Math.round(lightness)}%)`
}

/**
 * 取一条泳道在某种模式下的颜色。
 *
 * @param options - `{ mode, state, stateIndex, topicIndex, theme }`。
 * @returns CSS 颜色。
 */
export function laneColor(options) {
  const { mode = 'topic', state = 'todo', stateIndex = 0, topicIndex = 0, theme = 'light' } = options ?? {}
  if (mode === 'status') return statusColor(state, stateIndex, theme)
  // 话题色由调用方提供的 topicColorOf 决定（theme.js 的 10 色板）
  return null
}

/**
 * 为一批泳道预先算出"该状态内的序号"。
 *
 * 为什么需要预计算：深浅变化要按"同一状态内的第几条"来定，
 * 而不是全局序号——否则 10 条完成里只有前两条颜色不同。
 *
 * @param lanes - `[{ laneId, state }]`。
 * @returns Map<laneId, number>。
 */
export function stateIndexMap(lanes) {
  const counters = {}
  const out = new Map()
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    const state = lane.state ?? 'todo'
    const next = counters[state] ?? 0
    out.set(lane.laneId, next)
    counters[state] = next + 1
  }
  return out
}

/**
 * 下一个模式（两态循环）。
 * @param current - 当前模式。
 * @returns 另一个模式。
 */
export function nextGraphMode(current) {
  return current === 'status' ? 'topic' : 'status'
}

/** 读取保存的模式。 */
export function loadGraphMode(storage) {
  try {
    const raw = storage === null || storage === undefined ? null : storage.getItem(GRAPH_MODE_KEY)
    if (raw === 'topic' || raw === 'status') return raw
  } catch {
    // 忽略
  }
  return 'topic'
}

/** 保存模式。 */
export function saveGraphMode(storage, mode) {
  try {
    if (storage !== null && storage !== undefined) storage.setItem(GRAPH_MODE_KEY, mode)
  } catch {
    // 忽略
  }
}

/** 按钮的图标与提示。 */
export function graphModeLabel(mode) {
  if (mode === 'status') {
    return { icon: '◍', title: '着色：状态（绿=完成 蓝=进行中 橙=阻塞）· 点击切回话题色' }
  }
  return { icon: '◌', title: '着色：话题（每条线一个颜色）· 点击切到状态色' }
}
