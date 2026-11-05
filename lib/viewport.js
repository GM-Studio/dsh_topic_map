/**
 * 视口数学：缩放、平移、边界约束。
 *
 * 刻意与 React 和 DOM 分开：这里只做数字运算，因此可以完整地测试——而
 * 缩放平移正是最容易出现"手感不对、拖飞了、缩到看不见"这类问题的地方。
 *
 * 坐标约定：
 *   - 内容坐标（cx, cy）是图自身的坐标，与视图无关；
 *   - 屏幕坐标由 `offset` 平移、`scale` 缩放得到；
 *   - `offset` 是内容原点在屏幕上的位置。
 *
 * @module dsh-topic-map/viewport
 */

/** 缩放上下限。低于下限看不到结构，高于上限只剩下一个圈。 */
export const MIN_SCALE = 0.35
export const MAX_SCALE = 4

/** 允许内容边缘超出视图的余量（像素）；0 表示严格不出界。 */
export const EDGE_SLACK = 48

/**
 * 把缩放值夹到合法区间。
 * @param scale - 期望缩放。
 * @returns 合法缩放。
 */
export function clampScale(scale) {
  const v = Number(scale)
  if (!Number.isFinite(v)) return 1
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

/**
 * 以某个屏幕点为锚缩放，并把结果约束回边界。
 *
 * 手感的关键：锚点下的内容在缩放前后**必须停在同一个屏幕位置**，否则
 * 滚动滚轮时图会往一边跑。做法是反解出锚点对应的内容坐标，再按新缩放
 * 重新计算偏移。
 *
 * 缩放后仍要过一遍边界约束：否则在大图上缩小时，锚定可能把内容整体推出
 * 视野（例如锚点在角落、缩小后内容大幅移动）。约束会让锚定在边缘处略微
 * 让步——这比"图跑没了"要好。
 *
 * @param view - `{ scale, offsetX, offsetY }`。
 * @param anchorX - 锚点屏幕 X（相对视口左上）。
 * @param anchorY - 锚点屏幕 Y。
 * @param nextScale - 目标缩放（会被夹取）。
 * @param content - 内容尺寸；传入时结果会被约束回边界。
 * @param viewport - 视口尺寸。
 * @returns 新的 `{ scale, offsetX, offsetY }`。
 */
export function zoomAt(view, anchorX, anchorY, nextScale, content, viewport) {
  const scale = clampScale(nextScale)
  if (scale === view.scale) return { ...view, scale }
  // 锚点在内容坐标系里的位置
  const cx = (anchorX - view.offsetX) / view.scale
  const cy = (anchorY - view.offsetY) / view.scale
  const zoomed = {
    scale,
    // 让同一个内容点仍然落在 anchor 上
    offsetX: anchorX - cx * scale,
    offsetY: anchorY - cy * scale,
  }
  return content === undefined || viewport === undefined
    ? zoomed
    : constrain(zoomed, content, viewport)
}

/**
 * 平移，并约束在边界内。
 *
 * 约束规则：内容比视图小的时候居中，大的时候允许拖动但内容边缘不能离开
 * 视口超过 `EDGE_SLACK`。这样既不会"拖飞"，也不会在大图上卡得动不了。
 *
 * @param view - 当前视图。
 * @param dx - 屏幕位移 X。
 * @param dy - 屏幕位移 Y。
 * @param content - `{ width, height }` 内容尺寸（内容坐标）。
 * @param viewport - `{ width, height }` 视口尺寸。
 * @returns 约束后的视图。
 */
export function panBy(view, dx, dy, content, viewport) {
  const moved = {
    scale: view.scale,
    offsetX: view.offsetX + dx,
    offsetY: view.offsetY + dy,
  }
  return constrain(moved, content, viewport)
}

/**
 * 把视图约束回合法范围。
 *
 * @param view - 视图。
 * @param content - 内容尺寸。
 * @param viewport - 视口尺寸。
 * @returns 约束后的视图。
 */
export function constrain(view, content, viewport) {
  return {
    scale: view.scale,
    offsetX: axisLimit(view.offsetX, content.width * view.scale, viewport.width),
    offsetY: axisLimit(view.offsetY, content.height * view.scale, viewport.height),
  }
}

/**
 * 单轴约束。
 *
 * - 内容比视口小：居中。
 * - 内容比视口大：偏移必须在 `[视口 - 内容 - slack, slack]` 之间，
 *   即左右都不允许露出超过 slack 的空白。
 *
 * @param offset - 当前偏移。
 * @param scaledSize - 内容在该轴上的像素尺寸。
 * @param viewportSize - 视口在该轴上的尺寸。
 * @returns 约束后的偏移。
 */
function axisLimit(offset, scaledSize, viewportSize) {
  if (!Number.isFinite(scaledSize) || scaledSize <= viewportSize) {
    // 居中：内容原点放在 (视口 - 内容) / 2
    return (viewportSize - scaledSize) / 2
  }
  const min = viewportSize - scaledSize - EDGE_SLACK
  const max = EDGE_SLACK
  return Math.min(max, Math.max(min, offset))
}

/**
 * 全览：缩放到刚好放下全部内容，并居中。
 *
 * 留一点边距，避免最外圈的节点贴着容器边。
 *
 * @param content - 内容尺寸（内容坐标）。
 * @param viewport - 视口尺寸。
 * @param padding - 边距（像素）。
 * @returns 视图。
 */
export function fitToView(content, viewport, padding = 24) {
  const availW = Math.max(1, viewport.width - padding * 2)
  const availH = Math.max(1, viewport.height - padding * 2)
  const sx = availW / Math.max(1, content.width)
  const sy = availH / Math.max(1, content.height)
  const scale = clampScale(Math.min(sx, sy))
  const scaledW = content.width * scale
  const scaledH = content.height * scale
  return {
    scale,
    offsetX: (viewport.width - scaledW) / 2,
    offsetY: (viewport.height - scaledH) / 2,
  }
}

/**
 * 内容坐标 → 屏幕坐标。
 * @param view - 视图。
 * @param cx - 内容 X。
 * @param cy - 内容 Y。
 * @returns 屏幕坐标。
 */
export function toScreen(view, cx, cy) {
  return { x: cx * view.scale + view.offsetX, y: cy * view.scale + view.offsetY }
}

/**
 * 缩略条：把内容缩成一条，并标出当前视口范围。
 *
 * @param content - 内容尺寸。
 * @param view - 视图。
 * @param viewport - 视口尺寸。
 * @returns `{ start, end }`，均为 0..1 的比例。
 */
export function overviewRange(content, view, viewport) {
  const scaled = content.width * view.scale
  if (!Number.isFinite(scaled) || scaled <= 0) return { start: 0, end: 1 }
  // 视口左边缘对应内容的比例
  const left = (-view.offsetX) / scaled
  const width = viewport.width / scaled
  const start = Math.min(1, Math.max(0, left))
  const end = Math.min(1, Math.max(start + 0.01, left + width))
  return { start, end }
}

/**
 * 根据缩略条上的拖动位置，算出新的偏移（保持缩放不变）。
 * @param content - 内容尺寸。
 * @param view - 视图。
 * @param viewport - 视口尺寸。
 * @param ratio - 0..1，希望视口中心落在内容的位置。
 * @returns 新的视图。
 */
export function seekTo(content, view, viewport, ratio) {
  const scaled = content.width * view.scale
  const clamped = Math.min(1, Math.max(0, ratio))
  // 让 ratio 处的内容点落在视口中心
  const offsetX = viewport.width / 2 - clamped * scaled
  return constrain({ ...view, offsetX }, content, viewport)
}
