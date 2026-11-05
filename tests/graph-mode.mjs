/**
 * 图着色模式测试。
 *
 * Run: node tests/graph-mode.mjs
 */

import { strict as assert } from 'node:assert'
import {
  GRAPH_MODES,
  GRAPH_MODE_KEY,
  STATUS_HUE,
  graphModeLabel,
  laneColor,
  loadGraphMode,
  nextGraphMode,
  saveGraphMode,
  stateIndexMap,
  statusColor,
} from '../lib/graph-mode.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\ngraph-mode')

// ── 状态色：同色系深浅 ──────────────────────────────────────────────
test('同状态的相邻几条颜色不同（能区分）', () => {
  const colors = [0, 1, 2, 3, 4].map(i => statusColor('done', i, 'light'))
  assert.equal(new Set(colors).size, 5, '前 5 条应有 5 种不同深浅')
})

test('同状态颜色同色相（语义一致）', () => {
  for (const i of [0, 1, 2, 3, 4]) {
    const c = statusColor('done', i, 'light')
    assert.ok(c.includes(`hsl(${STATUS_HUE.done.h}`), `${c} 应为 done 的色相`)
  }
})

test('第 6 条回到第 1 档（循环而不是无限变浅）', () => {
  assert.equal(statusColor('done', 5, 'light'), statusColor('done', 0, 'light'))
})

test('不同状态色相不同（一眼分辨）', () => {
  const hues = new Set(['done', 'active', 'blocked', 'todo'].map(s => statusColor(s, 0, 'light').match(/hsl\((\d+)/)[1]))
  assert.equal(hues.size, 4, '四种状态应有四个不同色相')
})

test('深色主题比浅色主题更亮（黑底上可读）', () => {
  const light = statusColor('done', 0, 'light')
  const dark = statusColor('done', 0, 'dark')
  const lightL = Number(light.match(/(\d+)%\)$/)[1])
  const darkL = Number(dark.match(/(\d+)%\)$/)[1])
  assert.ok(darkL > lightL, `深色版应更亮：${lightL} vs ${darkL}`)
})

test('未知状态退回灰色而不是崩溃', () => {
  const c = statusColor('whatever', 0, 'light')
  assert.ok(c.includes('hsl('), '应返回合法颜色')
})

test('负数或非数字序号不崩', () => {
  assert.ok(statusColor('done', -3, 'light').includes('hsl('))
  assert.ok(statusColor('done', undefined, 'light').includes('hsl('))
})

// ── 状态内序号 ──────────────────────────────────────────────────────
test('按状态分组编号（每种状态从 0 开始）', () => {
  const lanes = [
    { laneId: 'A', state: 'done' },
    { laneId: 'B', state: 'active' },
    { laneId: 'C', state: 'done' },
    { laneId: 'D', state: 'done' },
  ]
  const m = stateIndexMap(lanes)
  assert.equal(m.get('A'), 0)
  assert.equal(m.get('C'), 1, '第二条 done 应为 1')
  assert.equal(m.get('D'), 2)
  assert.equal(m.get('B'), 0, 'active 从 0 开始')
})

test('同一状态下 10 条泳道仍有 5 种可区分颜色', () => {
  const lanes = Array.from({ length: 10 }, (_, i) => ({ laneId: 'L' + i, state: 'done' }))
  const m = stateIndexMap(lanes)
  const colors = lanes.map(l => statusColor('done', m.get(l.laneId), 'light'))
  assert.equal(new Set(colors).size, 5, '10 条应循环出 5 种深浅')
})

test('空输入不崩', () => {
  assert.equal(stateIndexMap([]).size, 0)
  assert.equal(stateIndexMap(null).size, 0)
})

// ── laneColor ───────────────────────────────────────────────────────
test('话题模式返回 null（由调用方用话题色板）', () => {
  assert.equal(laneColor({ mode: 'topic', state: 'done' }), null)
})

test('状态模式返回状态色', () => {
  const c = laneColor({ mode: 'status', state: 'blocked', stateIndex: 1, theme: 'light' })
  assert.ok(c.includes('hsl('))
  assert.ok(c.includes(String(STATUS_HUE.blocked.h)))
})

test('laneColor 空输入不崩', () => {
  assert.equal(laneColor(null), null)
  assert.ok(laneColor({ mode: 'status' }).includes('hsl('))
})

// ── 模式切换 ────────────────────────────────────────────────────────
test('两态循环', () => {
  assert.equal(nextGraphMode('topic'), 'status')
  assert.equal(nextGraphMode('status'), 'topic')
})

test('未知值退回话题色', () => {
  assert.equal(nextGraphMode('xxx'), 'status', '不是 status 就该切到 status')
})

test('默认话题色', () => {
  const store = { getItem: () => null }
  assert.equal(loadGraphMode(store), 'topic')
})

test('保存后能读回', () => {
  const map = new Map()
  const store = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  }
  saveGraphMode(store, 'status')
  assert.equal(map.get(GRAPH_MODE_KEY), 'status')
  assert.equal(loadGraphMode(store), 'status')
})

test('非法存储值退回默认', () => {
  assert.equal(loadGraphMode({ getItem: () => 'purple' }), 'topic')
})

test('存储不可用时不抛', () => {
  const broken = { getItem() { throw new Error('x') }, setItem() { throw new Error('x') } }
  assert.equal(loadGraphMode(broken), 'topic')
  saveGraphMode(broken, 'status')
  saveGraphMode(undefined, 'status')
})

// ── 按钮文案 ────────────────────────────────────────────────────────
test('按钮图标区分两种模式', () => {
  assert.equal(graphModeLabel('topic').icon, '◌')
  assert.equal(graphModeLabel('status').icon, '◍')
})

test('提示说明当前模式与下一步', () => {
  for (const m of GRAPH_MODES) {
    const t = graphModeLabel(m).title
    assert.ok(t.includes('着色'), '应说明当前着色')
    assert.ok(t.includes('点击'), '应说明点击后的效果')
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
