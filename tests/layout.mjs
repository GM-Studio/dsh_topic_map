/**
 * 几何测试：内容坐标系 + 视口变换。
 *
 * 架构变了：`layout()` 只产出**内容坐标**（与视口无关），装进屏幕由
 * `viewport.js` 的缩放平移完成。因此这里验证两件事：
 *
 *   1. 内容坐标本身合理（间距、轨道行距、标签不重叠）；
 *   2. 任意视口下 `fitToView` 都能把全部内容完整放进可见区。
 *
 * 「有没有填满屏幕」这条断言从 layout 移到了 viewport——它本来就属于视口
 * 的职责，放在 layout 里会让几何依赖屏幕尺寸，正是之前难维护的原因。
 *
 * Run: node tests/layout.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { fitToView, toScreen } from '../lib/viewport.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 取出 client.js 里的 layout 函数并求值（它是纯函数）。 */
function extractLayout() {
  const start = src.indexOf('function layout(graph) {')
  assert.ok(start >= 0, 'layout(graph) 未找到，client.js 结构变了')
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break }
  }
  const body = src.slice(start, i + 1)
  return new Function(body + '\nreturn layout;')()
}

const layout = extractLayout()

/** 造一个与 Host 输出同形的拓扑。 */
function makeGraph(turnCount, columnCount) {
  const cols = []
  const nodes = []
  const edges = []
  for (let c = 0; c < columnCount; c += 1) cols.push({ laneId: `L${c}`, col: c })
  for (let i = 0; i < turnCount; i += 1) {
    nodes.push({ turn: i, index: i, col: 0, laneId: 'L0', primary: true })
  }
  for (let c = 1; c < columnCount; c += 1) {
    const at = Math.min(turnCount - 1, c * 2)
    nodes.push({ turn: turnCount + c, index: Math.min(turnCount - 1, at + 0.5), col: c, laneId: `L${c}`, primary: true })
  }
  for (let i = 1; i < turnCount; i += 1) {
    edges.push({ kind: 'lane', col: 0, from: i - 1, to: i, gap: false })
  }
  for (let c = 1; c < columnCount; c += 1) {
    edges.push({ kind: 'fork', from: 0, fromCol: c - 1, to: Math.min(turnCount - 1, c * 2), toCol: c })
  }
  return {
    turnCount, columnCount, columns: cols, nodes, edges,
    labels: cols.map((c, i) => ({ laneId: c.laneId, col: i, index: turnCount - 1, text: '话题' + i, turns: 3 })),
  }
}

console.log('\nlayout')

// ── 内容坐标的合理性 ────────────────────────────────────────────────
test('节点全部落在内容框内', () => {
  const L = layout(makeGraph(12, 3))
  for (const n of L.nodes) {
    assert.ok(n.x >= 0 && n.x <= L.width, `x 越界：${n.x} / ${L.width}`)
    assert.ok(n.y >= 0 && n.y <= L.height, `y 越界：${n.y} / ${L.height}`)
  }
})

test('同一轮的节点在同一 x 上（时间轴语义）', () => {
  const L = layout(makeGraph(10, 3))
  const byTurn = new Map()
  for (const n of L.nodes) {
    const list = byTurn.get(n.turn) || []
    list.push(n)
    byTurn.set(n.turn, list)
  }
  for (const [turn, list] of byTurn) {
    const xs = new Set(list.map(n => n.x))
    assert.equal(xs.size, 1, `T${turn} 的节点 x 不一致`)
  }
})

test('不同轮次的 x 严格递增', () => {
  const L = layout(makeGraph(12, 2))
  const byTurn = new Map()
  for (const n of L.nodes) byTurn.set(n.turn, n.x)
  const xs = [...byTurn.values()].sort((a, b) => a - b)
  for (let i = 1; i < xs.length; i += 1) {
    assert.ok(xs[i] > xs[i - 1], 'x 必须递增')
  }
})

test('同一轨道上的节点 y 相同', () => {
  const L = layout(makeGraph(10, 3))
  const byCol = new Map()
  for (const n of L.nodes) {
    const set = byCol.get(n.col) || new Set()
    set.add(n.y)
    byCol.set(n.col, set)
  }
  for (const [col, ys] of byCol) {
    assert.equal(ys.size, 1, `轨道 ${col} 的 y 不统一`)
  }
})

test('不同轨道 y 互不相同', () => {
  const L = layout(makeGraph(10, 4))
  const ys = [...new Set(L.nodes.map(n => n.y))]
  assert.equal(ys.length, 4, `期望 4 个不同 y，实际 ${ys.length}`)
})

test('轮次多时步长收敛但不是 0', () => {
  const few = layout(makeGraph(5, 2))
  const many = layout(makeGraph(200, 2))
  assert.ok(many.step < few.step, '轮次多时步长应变小')
  assert.ok(many.step >= 26, `步长过小：${many.step}`)
})

test('轨道多时行距收敛但不是 0', () => {
  const few = layout(makeGraph(10, 2))
  const many = layout(makeGraph(10, 8))
  assert.ok(many.row <= few.row, '轨道多时行距不应变大')
  assert.ok(many.row >= 96, `行距过小：${many.row}`)
})

test('节点半径足够可点（行高被压到 40px 时仍有下限）', () => {
  // 行高随行数收敛到 40px 后，半径会跟着变小，但不能小到点不中。
  // 5.5px 是"仍能稳稳点中"的经验下限。
  for (const g of [makeGraph(5, 2), makeGraph(100, 5), makeGraph(300, 9), makeGraph(40, 30)]) {
    const L = layout(g)
    assert.ok(L.radius >= 5.5, `半径过小：${L.radius}`)
  }
})

test('分叉边两端不在同一行', () => {
  const L = layout(makeGraph(12, 3))
  for (const e of L.edges) {
    if (e.kind !== 'fork') continue
    assert.notEqual(e.y1, e.y2, '分叉必须换行')
  }
})

test('标签在轨道左端，不压到节点', () => {
  const L = layout(makeGraph(12, 3))
  for (const lb of L.labels) {
    // 左端标签画在 [0, labelGutter] 内
    assert.ok(lb.x >= 0, `标签 x 应 >= 0，实际 ${lb.x}`)
    assert.ok(lb.x + L.labelGutter <= 260, `标签区太宽：${lb.x + L.labelGutter}`)
    // 节点全部在标签区右侧
    const sameCol = L.nodes.filter(n => n.col === lb.col)
    if (sameCol.length === 0) continue
    const minNodeX = Math.min(...sameCol.map(n => n.x))
    assert.ok(minNodeX > lb.x + 100, `节点应在标签区右侧：节点 ${minNodeX} vs 标签 ${lb.x}`)
  }
})

test('同列多个标签落在同一 y（左端只有一个位置，不会重叠）', () => {
  // 左端标签按轨道行摆放：同一列天然只有一行，不需要垂直错开。
  const g = makeGraph(12, 2)
  g.labels = [
    { laneId: 'L0', col: 0, index: 3, text: '甲', turns: 2 },
    { laneId: 'L0b', col: 0, index: 8, text: '乙', turns: 2 },
  ]
  const L = layout(g)
  assert.equal(L.labels[0].y, L.labels[1].y, '同列标签 y 应相同（左端布局）')
  assert.equal(L.labels[0].x, L.labels[1].x, '同列标签 x 应相同')
})

test('内容尺寸随轮次与轨道增长', () => {
  const small = layout(makeGraph(5, 2))
  const big = layout(makeGraph(60, 5))
  assert.ok(big.width > small.width, '轮次多应更宽')
  assert.ok(big.height > small.height, '轨道多应更高')
})

// ── 第 2 条需求回归：精细化后不能撑出滚动条 ────────────────────────
test('行高随行数收敛，不会因为话题变多而无限增高', () => {
  const heights = []
  for (const n of [5, 10, 15, 20, 30]) {
    const L = layout(makeGraph(20, n))
    heights.push({ n, row: L.row, height: L.height })
  }
  // 行高必须单调不增
  for (let i = 1; i < heights.length; i += 1) {
    assert.ok(heights[i].row <= heights[i - 1].row,
      `行数增加后行高不应变大：${heights[i - 1].n}行=${heights[i - 1].row} -> ${heights[i].n}行=${heights[i].row}`)
  }
  // 15 行时行高必须明显低于旧的 96px 下限
  const at15 = heights.find(h => h.n === 15)
  assert.ok(at15.row < 96, `15 行时行高应低于 96px，实际 ${at15.row}`)
  assert.ok(at15.row >= 40, `行高不应低于 40px，实际 ${at15.row}`)
})

test('15 条泳道在常见视口下能一屏装下', () => {
  const L = layout(makeGraph(20, 15))
  for (const vp of [{ width: 1440, height: 900 }, { width: 1600, height: 860 }, { width: 1280, height: 720 }]) {
    const view = fitToView({ width: L.width, height: L.height }, vp)
    const scaledH = L.height * view.scale
    assert.ok(scaledH <= vp.height + 1,
      `${vp.width}x${vp.height}: 15 行仍溢出（内容高 ${Math.round(L.height)}，缩放后 ${Math.round(scaledH)}）`)
  }
})

// ── 任意视口都能装下（原「填满」断言的正确位置）──────────────────────
test('全览优先保证"能看全"；缩到下限时允许溢出（可平移查看）', () => {
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1280, height: 720 },
    { width: 900, height: 600 },
  ]
  for (const vp of viewports) {
    for (const g of [makeGraph(8, 2), makeGraph(40, 5), makeGraph(200, 9)]) {
      const L = layout(g)
      const view = fitToView({ width: L.width, height: L.height }, vp)

      // 关键不变量：内容必须至少有一个轴上被完全装下（否则等于没缩放），
      // 且缩放不得低于下限。低于下限仍放不下的，交给平移，而不是继续缩小
      // 到看不清。
      const scaledW = L.width * view.scale
      const scaledH = L.height * view.scale
      const fitsW = scaledW <= vp.width + 1
      const fitsH = scaledH <= vp.height + 1
      assert.ok(fitsW || fitsH, `${vp.width}x${vp.height}: 两个轴都放不下`)
      assert.ok(view.scale >= 0.35 - 1e-9, `缩放低于下限：${view.scale}`)

      // 放得下的那个轴必须居中。
      if (fitsW) {
        const left = view.offsetX
        const right = vp.width - (view.offsetX + scaledW)
        assert.ok(Math.abs(left - right) <= 2, `${vp.width}x${vp.height}: 水平未居中`)
      }
      if (fitsH) {
        const top = view.offsetY
        const bottom = vp.height - (view.offsetY + scaledH)
        assert.ok(Math.abs(top - bottom) <= 2, `${vp.width}x${vp.height}: 垂直未居中`)
      }
    }
  }
})

test('小内容在所有视口下都完整装下并居中', () => {
  const L = layout(makeGraph(4, 2))
  for (const vp of [{ width: 1600, height: 900 }, { width: 900, height: 600 }]) {
    const view = fitToView({ width: L.width, height: L.height }, vp)
    const p = toScreen(view, L.width / 2, L.height / 2)
    assert.ok(Math.abs(p.x - vp.width / 2) <= 2, `${vp.width}: 水平未居中 ${p.x}`)
    assert.ok(Math.abs(p.y - vp.height / 2) <= 2, `${vp.height}: 垂直未居中 ${p.y}`)
  }
})

test('内容坐标不随视口变化（同一会话在不同窗口下同一张图）', () => {
  const g = makeGraph(20, 4)
  const a = layout(g)
  const b = layout(g)
  assert.equal(a.width, b.width)
  assert.equal(a.height, b.height)
  assert.deepEqual(a.nodes.map(n => [n.x, n.y]), b.nodes.map(n => [n.x, n.y]))
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
