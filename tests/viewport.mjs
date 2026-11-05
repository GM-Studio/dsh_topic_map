/**
 * 视口数学测试。
 *
 * 缩放平移最怕三类问题：滚轮时图乱跑、能拖飞、缩到看不见。这三类都能
 * 用数字断言验证，不必靠手感。
 *
 * Run: node tests/viewport.mjs
 */

import { strict as assert } from 'node:assert'
import {
  EDGE_SLACK, MAX_SCALE, MIN_SCALE,
  clampScale, constrain, fitToView, overviewRange, panBy, seekTo, toScreen, zoomAt,
} from '../lib/viewport.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const CONTENT = { width: 2000, height: 800 }
const VIEWPORT = { width: 1000, height: 600 }
const near = (a, b, tol = 0.5) => Math.abs(a - b) <= tol

console.log('\nviewport')

// ── 缩放夹取 ────────────────────────────────────────────────────────
test('缩放被夹在上下限之间', () => {
  assert.equal(clampScale(0.01), MIN_SCALE)
  assert.equal(clampScale(99), MAX_SCALE)
  assert.equal(clampScale(1.5), 1.5)
  assert.equal(clampScale(NaN), 1)
})

// ── 锚点缩放 ────────────────────────────────────────────────────────
test('以鼠标位置为锚缩放，锚点内容不动（核心手感）', () => {
  // 用无约束形式验证纯锚定数学；约束在下面的用例里单独验证。
  const view = { scale: 1, offsetX: 0, offsetY: 0 }
  const anchorX = 300
  const anchorY = 200

  // 锚点当前对应的内容坐标
  const before = { cx: (anchorX - view.offsetX) / view.scale, cy: (anchorY - view.offsetY) / view.scale }

  const zoomed = zoomAt(view, anchorX, anchorY, 2)
  const screen = toScreen(zoomed, before.cx, before.cy)

  assert.ok(near(screen.x, anchorX), `X 漂移了：期望 ${anchorX}，实际 ${screen.x}`)
  assert.ok(near(screen.y, anchorY), `Y 漂移了：期望 ${anchorY}，实际 ${screen.y}`)
})

test('带约束时，中间区域的锚点仍然不漂移', () => {
  // 内容足够大、锚点取在中间，约束不会介入，此时锚定应完全保持。
  const big = { width: 20000, height: 20000 }
  const view = { scale: 1, offsetX: -2000, offsetY: -2000 }
  const anchorX = 500
  const anchorY = 300
  const cx = (anchorX - view.offsetX) / view.scale
  const cy = (anchorY - view.offsetY) / view.scale

  const zoomed = zoomAt(view, anchorX, anchorY, 1.6, big, VIEWPORT)
  const p = toScreen(zoomed, cx, cy)
  assert.ok(near(p.x, anchorX, 1), `X 漂移：${p.x}`)
  assert.ok(near(p.y, anchorY, 1), `Y 漂移：${p.y}`)
})

test('带约束时结果立即合法（调用方无需再约束一次）', () => {
  const view = fitToView(CONTENT, VIEWPORT)
  for (const scale of [0.4, 1.5, 2.5, 3.8]) {
    const zoomed = zoomAt(view, 100, 100, scale, CONTENT, VIEWPORT)
    const checked = constrain(zoomed, CONTENT, VIEWPORT)
    assert.equal(zoomed.offsetX, checked.offsetX, `scale=${scale} 的 X 未约束`)
    assert.equal(zoomed.offsetY, checked.offsetY, `scale=${scale} 的 Y 未约束`)
  }
})

test('连续放大缩小时锚点仍不漂移', () => {
  let view = { scale: 1, offsetX: 0, offsetY: 0 }
  const anchorX = 500
  const anchorY = 300
  const cx = (anchorX - view.offsetX) / view.scale
  const cy = (anchorY - view.offsetY) / view.scale

  for (const s of [1.2, 1.8, 3, 1.4, 0.6, 1]) {
    view = zoomAt(view, anchorX, anchorY, s)
    const p = toScreen(view, cx, cy)
    assert.ok(near(p.x, anchorX, 1), `scale=${s} 时 X 漂移：${p.x}`)
    assert.ok(near(p.y, anchorY, 1), `scale=${s} 时 Y 漂移：${p.y}`)
  }
})

test('缩放值不变时视图完全不动', () => {
  const view = { scale: 1.5, offsetX: 40, offsetY: 20 }
  const next = zoomAt(view, 100, 100, 1.5)
  assert.equal(next.offsetX, 40)
  assert.equal(next.offsetY, 20)
})

test('缩放不会超出上下限', () => {
  const view = { scale: 1, offsetX: 0, offsetY: 0 }
  assert.equal(zoomAt(view, 0, 0, 100).scale, MAX_SCALE)
  assert.equal(zoomAt(view, 0, 0, 0).scale, MIN_SCALE)
})

// ── 平移与边界 ──────────────────────────────────────────────────────
test('内容小于视口时自动居中', () => {
  const small = { width: 200, height: 100 }
  const view = constrain({ scale: 1, offsetX: 999, offsetY: -999 }, small, VIEWPORT)
  assert.equal(view.offsetX, (VIEWPORT.width - 200) / 2)
  assert.equal(view.offsetY, (VIEWPORT.height - 100) / 2)
})

test('内容大于视口时允许拖动，但不允许拖飞（左边界）', () => {
  const view = { scale: 1, offsetX: 0, offsetY: 0 }
  // 使劲往右拖：内容左边会被推出视口，最多推出 EDGE_SLACK
  const dragged = panBy(view, 5000, 0, CONTENT, VIEWPORT)
  assert.equal(dragged.offsetX, EDGE_SLACK, '右拖过头应被夹住')
})

test('内容大于视口时允许拖动，但不允许拖飞（右边界）', () => {
  const view = { scale: 1, offsetX: 0, offsetY: 0 }
  const dragged = panBy(view, -5000, 0, CONTENT, VIEWPORT)
  assert.equal(dragged.offsetX, VIEWPORT.width - 2000 - EDGE_SLACK, '左拖过头应被夹住')
})

test('正常范围内的拖动不受影响', () => {
  const view = { scale: 1, offsetX: -300, offsetY: 0 }
  const dragged = panBy(view, 50, 0, CONTENT, VIEWPORT)
  assert.equal(dragged.offsetX, -250)
})

test('纵向同样受约束', () => {
  const tall = { width: 2000, height: 3000 }
  const dragged = panBy({ scale: 1, offsetX: 0, offsetY: 0 }, 0, 9999, tall, VIEWPORT)
  assert.equal(dragged.offsetY, EDGE_SLACK)
})

// ── 全览 ────────────────────────────────────────────────────────────
test('全览能放下全部内容', () => {
  const view = fitToView(CONTENT, VIEWPORT)
  const right = view.offsetX + CONTENT.width * view.scale
  const bottom = view.offsetY + CONTENT.height * view.scale
  assert.ok(view.offsetX >= 0, `左边越界：${view.offsetX}`)
  assert.ok(view.offsetY >= 0, `上边越界：${view.offsetY}`)
  assert.ok(right <= VIEWPORT.width + 1, `右边越界：${right}`)
  assert.ok(bottom <= VIEWPORT.height + 1, `下边越界：${bottom}`)
})

test('全览后内容居中', () => {
  const view = fitToView(CONTENT, VIEWPORT)
  const leftGap = view.offsetX
  const rightGap = VIEWPORT.width - (view.offsetX + CONTENT.width * view.scale)
  assert.ok(near(leftGap, rightGap, 1), `左右留白不等：${leftGap} vs ${rightGap}`)
})

test('极大内容全览时不会缩到看不见', () => {
  const huge = { width: 200000, height: 100 }
  const view = fitToView(huge, VIEWPORT)
  assert.ok(view.scale >= MIN_SCALE, `缩过头：${view.scale}`)
})

// ── 缩略条 ──────────────────────────────────────────────────────────
test('缩略条范围随缩放变化', () => {
  const full = fitToView(CONTENT, VIEWPORT)
  const r1 = overviewRange(CONTENT, full, VIEWPORT)
  assert.ok(r1.start <= 0.001, `全览时应当从 0 开始：${r1.start}`)
  assert.ok(r1.end >= 0.999, `全览时应当到 1 结束：${r1.end}`)

  const zoomed = zoomAt(full, 500, 300, 3)
  const r2 = overviewRange(CONTENT, zoomed, VIEWPORT)
  assert.ok(r2.end - r2.start < 0.99, `放大后视口范围应更窄：${r2.end - r2.start}`)
})

test('缩略条位置总在 0..1 内', () => {
  for (const scale of [0.35, 1, 2, 4]) {
    const view = constrain({ scale, offsetX: -99999, offsetY: 0 }, CONTENT, VIEWPORT)
    const r = overviewRange(CONTENT, view, VIEWPORT)
    assert.ok(r.start >= 0 && r.start <= 1, `start 越界 ${r.start}`)
    assert.ok(r.end >= 0 && r.end <= 1, `end 越界 ${r.end}`)
    assert.ok(r.end >= r.start, 'end 不应小于 start')
  }
})

test('点缩略条某处能移到对应位置', () => {
  const view = fitToView(CONTENT, VIEWPORT)
  const zoomed = zoomAt(view, 500, 300, 3)
  const moved = seekTo(CONTENT, zoomed, VIEWPORT, 0.8)
  const scaled = CONTENT.width * moved.scale
  // 0.8 处的内容点应落在视口中心附近
  const centerX = 0.8 * scaled + moved.offsetX
  assert.ok(near(centerX, VIEWPORT.width / 2, 2), `中心偏移：${centerX} vs ${VIEWPORT.width / 2}`)
})

test('缩略条 seek 超出 0..1 会被夹住', () => {
  const view = fitToView(CONTENT, VIEWPORT)
  const zoomed = zoomAt(view, 500, 300, 3)
  const a = seekTo(CONTENT, zoomed, VIEWPORT, -5)
  const b = seekTo(CONTENT, zoomed, VIEWPORT, 0)
  assert.equal(a.offsetX, b.offsetX)
})

// ── 不变量 ──────────────────────────────────────────────────────────
test('任何操作后偏移都满足边界约束', () => {
  let view = fitToView(CONTENT, VIEWPORT)
  // 全部按真实调用方式传尺寸，模拟界面里的实际操作序列
  const actions = [
    v => zoomAt(v, 100, 100, 2.5, CONTENT, VIEWPORT),
    v => panBy(v, -3000, -3000, CONTENT, VIEWPORT),
    v => zoomAt(v, 800, 500, 0.4, CONTENT, VIEWPORT),
    v => panBy(v, 8000, 0, CONTENT, VIEWPORT),
    v => seekTo(CONTENT, v, VIEWPORT, 0.3),
  ]
  for (const act of actions) {
    view = act(view)
    const checked = constrain(view, CONTENT, VIEWPORT)
    assert.equal(view.offsetX, checked.offsetX, 'X 未满足约束')
    assert.equal(view.offsetY, checked.offsetY, 'Y 未满足约束')
    assert.ok(view.scale >= MIN_SCALE && view.scale <= MAX_SCALE)
    assert.ok(Number.isFinite(CONTENT.width * view.scale))
    assert.ok(Number.isFinite(CONTENT.height * view.scale))
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
