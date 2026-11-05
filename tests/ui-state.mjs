/**
 * UI 状态（状态覆盖 + 筛选条件）的测试。
 *
 * 重点是**清洗**与**局部更新**：
 *   - 清洗：文件可能被手改或来自旧版本，非法值不能流进渲染
 *   - 局部更新：标一个状态不该把筛选条件冲掉
 *
 * Run: node tests/ui-state.mjs
 */

import { strict as assert } from 'node:assert'
import { mergeUiState, normalizeUiState, safeSessionId } from '../lib/ui-state.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nui-state')

// ── 归一化 ──────────────────────────────────────────────────────────
test('空输入得到干净的默认值', () => {
  const s = normalizeUiState(null)
  assert.deepEqual(s.overrides, {})
  assert.deepEqual(s.filter, { query: '', stages: [], states: [], minTurns: null, maxTurns: null })
})

test('保留合法的状态覆盖', () => {
  const s = normalizeUiState({ overrides: { L1: 'done', L2: 'blocked' } })
  assert.deepEqual(s.overrides, { L1: 'done', L2: 'blocked' })
})

test('丢弃非法的状态值', () => {
  const s = normalizeUiState({ overrides: { L1: 'done', L2: 'finished', L3: 123, '': 'done' } })
  assert.deepEqual(s.overrides, { L1: 'done' })
})

test('保留合法筛选条件', () => {
  const s = normalizeUiState({
    filter: { query: '跳转', stages: ['甲'], states: ['done'], minTurns: 2, maxTurns: 5 },
  })
  assert.deepEqual(s.filter, { query: '跳转', stages: ['甲'], states: ['done'], minTurns: 2, maxTurns: 5 })
})

test('筛选字段类型不对就归位', () => {
  const s = normalizeUiState({
    filter: { query: 42, stages: 'notarray', states: [1, 2], minTurns: -3, maxTurns: 'x' },
  })
  assert.equal(s.filter.query, '')
  assert.deepEqual(s.filter.stages, [])
  assert.deepEqual(s.filter.states, [])
  assert.equal(s.filter.minTurns, null)
  assert.equal(s.filter.maxTurns, null)
})

test('数组里的非字符串被剔除', () => {
  const s = normalizeUiState({ filter: { stages: ['甲', 2, '', '乙'] } })
  assert.deepEqual(s.filter.stages, ['甲', '乙'])
})

test('小数轮次取整', () => {
  const s = normalizeUiState({ filter: { minTurns: 2.7 } })
  assert.equal(s.filter.minTurns, 2)
})

// ── 合并 ────────────────────────────────────────────────────────────
test('设置单个覆盖', () => {
  const s = mergeUiState({ overrides: {}, filter: {} }, { override: { laneId: 'L1', state: 'done' } })
  assert.equal(s.overrides.L1, 'done')
})

test('清除单个覆盖（state 传 null）', () => {
  const cur = { overrides: { L1: 'done' }, filter: {} }
  const s = mergeUiState(cur, { override: { laneId: 'L1', state: null } })
  assert.equal(s.overrides.L1, undefined)
})

test('设置覆盖不影响筛选条件（局部更新）', () => {
  const cur = { overrides: {}, filter: { query: '跳转', stages: ['甲'], states: [] } }
  const s = mergeUiState(cur, { override: { laneId: 'L1', state: 'active' } })
  assert.equal(s.filter.query, '跳转', '筛选条件不该被冲掉')
  assert.deepEqual(s.filter.stages, ['甲'])
})

test('改筛选不影响已有覆盖', () => {
  const cur = { overrides: { L1: 'done' }, filter: {} }
  const s = mergeUiState(cur, { filter: { query: '面板' } })
  assert.equal(s.overrides.L1, 'done', '覆盖不该被冲掉')
  assert.equal(s.filter.query, '面板')
})

test('筛选的局部字段合并（只改一个不动其他）', () => {
  const cur = { overrides: {}, filter: { query: 'a', stages: ['s1'], minTurns: 2 } }
  const s = mergeUiState(cur, { filter: { query: 'b' } })
  assert.equal(s.filter.query, 'b')
  assert.deepEqual(s.filter.stages, ['s1'], '未提交的字段保持不变')
  assert.equal(s.filter.minTurns, 2)
})

test('非法覆盖值被忽略', () => {
  const s = mergeUiState({ overrides: {}, filter: {} }, { override: { laneId: 'L1', state: 'nope' } })
  assert.equal(s.overrides.L1, undefined)
})

test('整体替换 overrides', () => {
  const cur = { overrides: { L1: 'done' }, filter: {} }
  const s = mergeUiState(cur, { overrides: { L2: 'active' } })
  assert.deepEqual(s.overrides, { L2: 'active' })
})

test('合并会更新时间戳', () => {
  const before = Date.now()
  const s = mergeUiState({ overrides: {}, filter: {} }, {})
  assert.ok(s.updatedAt >= before)
})

test('空 patch 不改变内容', () => {
  const cur = { overrides: { L1: 'done' }, filter: { query: 'x' } }
  const s = mergeUiState(cur, null)
  assert.deepEqual(s.overrides, { L1: 'done' })
  assert.equal(s.filter.query, 'x')
})

// ── 复核结果持久化 ──────────────────────────────────────────────────
test('复核结果会被保存', () => {
  const review = {
    status: 'ready', reviewed: 2, total: 5, via: 'session',
    entries: [
      { laneId: 'L1', state: 'done', basis: '做完了', reviewed: true },
      { laneId: 'L2', state: 'blocked', basis: '报错', reviewed: true },
    ],
  }
  const s = mergeUiState({ overrides: {}, filter: {} }, { review })
  assert.equal(s.review.entries.length, 2)
  assert.equal(s.review.entries[1].state, 'blocked')
})

test('复核结果可以清除', () => {
  const cur = { overrides: {}, filter: {}, review: { status: 'ready', entries: [] } }
  const s = mergeUiState(cur, { review: null })
  assert.equal(s.review, null)
})

test('复核结果里的非法状态被归一', () => {
  const s = mergeUiState({ overrides: {}, filter: {} }, {
    review: { status: 'ready', entries: [{ laneId: 'X', state: 'finished', basis: '' }] },
  })
  assert.equal(s.review.entries[0].state, 'todo', '非法状态归位而不是丢弃整份')
})

test('复核结果不影响状态覆盖与筛选（三者独立）', () => {
  const cur = {
    overrides: { A: 'done' },
    filter: { query: '跳转', stages: ['甲'], states: [] },
  }
  const s = mergeUiState(cur, { review: { status: 'ready', entries: [] } })
  assert.equal(s.overrides.A, 'done')
  assert.equal(s.filter.query, '跳转')
})

test('写复核不会冲掉筛选，反之亦然', () => {
  let s = mergeUiState({ overrides: {}, filter: {} }, { review: { status: 'ready', entries: [{ laneId: 'L', state: 'done', basis: 'x', reviewed: true }] } })
  s = mergeUiState(s, { filter: { query: 'abc' } })
  assert.equal(s.review.entries.length, 1, '改筛选不该冲掉复核')
  assert.equal(s.filter.query, 'abc')
})

// ── 会话 id 安全 ────────────────────────────────────────────────────
test('会话 id 里的路径分隔符被替换', () => {
  assert.equal(safeSessionId('a/b\\c:d'), 'a_b_c_d')
  assert.equal(safeSessionId('session-abc_1.2'), 'session-abc_1.2')
})

test('空会话 id 不崩', () => {
  assert.equal(safeSessionId(null), '')
  assert.equal(safeSessionId(undefined), '')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
