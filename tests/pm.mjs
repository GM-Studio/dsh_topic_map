/**
 * PM 状态与依赖的测试。
 *
 * 重点：状态必须是**可解释的**（每条都有 basis），依赖必须是**有证据的**
 * （不能凭时间先后就画线）。这两条决定了这些信息能不能被信任。
 *
 * Run: node tests/pm.mjs
 */

import { strict as assert } from 'node:assert'
import {
  STATE_META,
  TASK_STATES,
  applyOverride,
  computeSupersession,
  inferDependencies,
  inferTaskState,
  stageProgress,
  summarizeStates,
} from '../lib/pm-model.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 造 factOf。 */
function facts(map) {
  return t => map[t]
}

const LANE_A = { laneId: 'A', title: '甲', turns: [1, 2, 3] }
const LANE_B = { laneId: 'B', title: '乙', turns: [4, 5] }
const LANE_C = { laneId: 'C', title: '丙', turns: [6, 7, 8] }

console.log('\npm')

// ── 状态推导 ────────────────────────────────────────────────────────
test('最后一轮报错 -> 阻塞', () => {
  const r = inferTaskState(LANE_A, facts({ 3: { turn: 3, endReason: 'error' } }), { lastTurnInSession: 10 })
  assert.equal(r.state, 'blocked')
  assert.ok(r.basis.includes('报错'), '必须给出依据')
  assert.equal(r.inferred, true, '必须标明是推导的')
})

test('超长 -> 阻塞', () => {
  const r = inferTaskState(LANE_A, facts({ 3: { turn: 3, endReason: 'max-tokens' } }), { lastTurnInSession: 10 })
  assert.equal(r.state, 'blocked')
  assert.ok(r.basis.includes('长度'))
})

test('中断 -> 阻塞', () => {
  for (const reason of ['aborted', 'interrupted', 'blocked']) {
    const r = inferTaskState(LANE_A, facts({ 3: { turn: 3, endReason: reason } }), { lastTurnInSession: 10 })
    assert.equal(r.state, 'blocked', `${reason} 应归为阻塞`)
  }
})

test('仍在进行 -> 进行中', () => {
  const r = inferTaskState(LANE_A, facts({ 3: { turn: 3, endReason: 'open' } }), { lastTurnInSession: 10 })
  assert.equal(r.state, 'active')
})

test('正常结束且后续转向新话题 -> 已完成', () => {
  const r = inferTaskState(LANE_A, facts({ 3: { turn: 3, endReason: 'completed' } }),
    { lastTurnInSession: 10, supersededAfter: 5 })
  assert.equal(r.state, 'done')
  assert.ok(r.basis.includes('转向了别的话题'), '依据应说明为何判定完成')
})

test('正常结束但后续仍是同一话题 -> 进行中', () => {
  const r = inferTaskState(LANE_A, facts({ 3: { turn: 3, endReason: 'completed' } }),
    { lastTurnInSession: 10, supersededAfter: null })
  assert.equal(r.state, 'active')
  assert.ok(r.basis.includes('延续'))
})

test('正常结束但在会话末尾 -> 进行中（事情刚说完，不能断言完成）', () => {
  const r = inferTaskState(LANE_A, facts({ 3: { turn: 3, endReason: 'completed' } }), { lastTurnInSession: 3 })
  assert.equal(r.state, 'active')
  assert.ok(r.basis.includes('末尾'))
})

test('空泳道 -> 待办', () => {
  const r = inferTaskState({ laneId: 'X', turns: [] }, facts({}), {})
  assert.equal(r.state, 'todo')
})

test('找不到事实 -> 待办而不是崩溃', () => {
  const r = inferTaskState(LANE_A, facts({}), { lastTurnInSession: 10 })
  assert.equal(r.state, 'todo')
  assert.ok(r.basis.length > 0)
})

test('每个状态推导都带非空依据', () => {
  const cases = [
    [{ 3: { turn: 3, endReason: 'error' } }, { lastTurnInSession: 10 }],
    [{ 3: { turn: 3, endReason: 'open' } }, { lastTurnInSession: 10 }],
    [{ 3: { turn: 3, endReason: 'completed' } }, { lastTurnInSession: 10 }],
    [{}, {}],
  ]
  for (const [f, ctx] of cases) {
    const r = inferTaskState(LANE_A, facts(f), ctx)
    assert.ok(typeof r.basis === 'string' && r.basis !== '', '依据不能为空')
    assert.ok(TASK_STATES.includes(r.state), `状态必须是合法值：${r.state}`)
  }
})

// ── 手动覆盖 ────────────────────────────────────────────────────────
test('手动覆盖优先于推导', () => {
  const inferred = { state: 'blocked', inferred: true, basis: '报错' }
  const r = applyOverride(inferred, 'done')
  assert.equal(r.state, 'done')
  assert.equal(r.overridden, true)
  assert.equal(r.inferred, false, '覆盖后不再标记为推导')
})

test('没有覆盖时保留推导结果', () => {
  const inferred = { state: 'active', inferred: true, basis: '进行中' }
  for (const v of [undefined, null, '', 'whatever']) {
    const r = applyOverride(inferred, v)
    assert.equal(r.state, 'active')
    assert.equal(r.overridden, false)
  }
})

test('非法覆盖值被忽略', () => {
  const r = applyOverride({ state: 'todo', inferred: true, basis: 'x' }, 'finished')
  assert.equal(r.state, 'todo')
})

// ── 依赖推导 ────────────────────────────────────────────────────────
test('失败任务指向后续同话题任务', () => {
  const f = facts({ 3: { turn: 3, endReason: 'error' }, 5: { turn: 5, endReason: 'completed' } })
  const deps = inferDependencies([LANE_A, LANE_B], f, () => true)
  assert.equal(deps.length, 1)
  assert.equal(deps[0].from, 'A')
  assert.equal(deps[0].to, 'B')
  assert.ok(deps[0].reason.includes('未完成'), '依赖要说明原因')
})

test('正常结束的任务不产生依赖（不凭时序瞎连）', () => {
  const f = facts({ 3: { turn: 3, endReason: 'completed' }, 5: { turn: 5, endReason: 'completed' } })
  assert.equal(inferDependencies([LANE_A, LANE_B], f, () => true).length, 0)
})

test('后续任务必须晚于失败任务开始', () => {
  const f = facts({ 3: { turn: 3, endReason: 'error' }, 2: { turn: 2, endReason: 'completed' } })
  const early = { laneId: 'E', title: '早', turns: [1, 2] }
  assert.equal(inferDependencies([LANE_A, early], f, () => true).length, 0)
})

test('不同话题之间不连线（避免失败轮次连到所有后续）', () => {
  const f = facts({ 3: { turn: 3, endReason: 'error' }, 5: { turn: 5, endReason: 'completed' } })
  const deps = inferDependencies([LANE_A, LANE_B], f, () => false)
  assert.equal(deps.length, 0, 'sameTopic 返回 false 时不应连线')
})

test('不重复输出同一条依赖', () => {
  const f = facts({ 3: { turn: 3, endReason: 'error' }, 8: { turn: 8, endReason: 'completed' } })
  const deps = inferDependencies([LANE_A, LANE_C], f, () => true)
  const keys = deps.map(d => d.from + '>' + d.to)
  assert.equal(new Set(keys).size, keys.length)
})

test('空输入不崩', () => {
  assert.deepEqual(inferDependencies([], facts({}), () => true), [])
  assert.deepEqual(inferDependencies(null, facts({}), () => true), [])
})

// ── 依赖：同工作流内的步骤顺序 ──────────────────────────────────────
test('同工作流的相邻步骤产生 sequence 依赖', () => {
  const lanes = [
    { laneId: 'W1', title: '设计', workflowName: '面板', turns: [1, 2] },
    { laneId: 'W2', title: '实现', workflowName: '面板', turns: [3, 4] },
    { laneId: 'W3', title: '验收', workflowName: '面板', turns: [5] },
  ]
  const deps = inferDependencies(lanes, facts({}), () => false)
  const seq = deps.filter(d => d.kind === 'sequence')
  assert.equal(seq.length, 2, '三个步骤应连两条相邻边')
  assert.deepEqual(seq.map(d => d.from + '>' + d.to), ['W1>W2', 'W2>W3'])
  assert.ok(seq[0].reason.includes('面板'), '要说明依据')
})

test('不同工作流之间不产生 sequence 依赖', () => {
  const lanes = [
    { laneId: 'A1', title: '甲事', workflowName: '流一', turns: [1] },
    { laneId: 'B1', title: '乙事', workflowName: '流二', turns: [2] },
  ]
  const deps = inferDependencies(lanes, facts({}), () => false)
  assert.equal(deps.filter(d => d.kind === 'sequence').length, 0)
})

test('同工作流但时间重叠时不连（那是并行不是先后）', () => {
  const lanes = [
    { laneId: 'P1', title: '甲', workflowName: '流', turns: [1, 5] },
    { laneId: 'P2', title: '乙', workflowName: '流', turns: [3, 4] },
  ]
  const deps = inferDependencies(lanes, facts({}), () => false)
  assert.equal(deps.filter(d => d.kind === 'sequence').length, 0, '时间重叠不能当步骤先后')
})

test('无 workflowName 的泳道不参与 sequence', () => {
  const lanes = [
    { laneId: 'X1', title: '甲', turns: [1] },
    { laneId: 'X2', title: '乙', turns: [2] },
  ]
  assert.equal(inferDependencies(lanes, facts({}), () => false).filter(d => d.kind === 'sequence').length, 0)
})

test('failure 与 sequence 可共存且不重复', () => {
  const lanes = [
    { laneId: 'F1', title: '失败的事', workflowName: '流', turns: [1] },
    { laneId: 'F2', title: '接着做', workflowName: '流', turns: [2] },
  ]
  const f = facts({ 1: { turn: 1, endReason: 'error' } })
  const deps = inferDependencies(lanes, f, () => true)
  const keys = deps.map(d => d.from + '>' + d.to)
  assert.equal(new Set(keys).size, keys.length, '同一对不该出现两次')
})

// ── supersession（判断 done 的依据）────────────────────────────────
test('computeSupersession 找出每条泳道之后的其他话题轮次', () => {
  const lanes = [
    { laneId: 'A', turns: [1, 2] },
    { laneId: 'B', turns: [3, 4] },
    { laneId: 'C', turns: [5] },
  ]
  const sup = computeSupersession(lanes)
  assert.equal(sup.get('A'), 3, 'A 之后最近的其他话题是 T3')
  assert.equal(sup.get('B'), 5)
  assert.equal(sup.get('C'), null, '最后一条之后没有别的话题')
})

test('同泳道的轮次不算接管', () => {
  const lanes = [{ laneId: 'A', turns: [1, 5] }, { laneId: 'B', turns: [3] }]
  const sup = computeSupersession(lanes)
  assert.equal(sup.get('A'), null, 'T5 仍是 A 自己，不该算被接管')
})

// ── 汇总 ────────────────────────────────────────────────────────────
test('状态计数正确', () => {
  const stateOf = id => ({ A: 'done', B: 'blocked', C: 'active' })[id] ?? 'todo'
  const s = summarizeStates([LANE_A, LANE_B, LANE_C], stateOf)
  assert.deepEqual(s, { todo: 0, active: 1, blocked: 1, done: 1, total: 3 })
})

test('阶段进度以计数为主（3/5 是事实，百分比只是参考）', () => {
  const stateOf = id => ({ A: 'done', B: 'done', C: 'done', D: 'active', E: 'todo' })[id]
  const r = stageProgress(['A', 'B', 'C', 'D', 'E'], stateOf)
  assert.equal(r.done, 3, '应报告完成了几个')
  assert.equal(r.total, 5, '应报告共几个')
  assert.equal(r.percent, 70, '加权百分比作为参考值')
})

test('全阻塞的阶段不会显示 0%', () => {
  const r = stageProgress(['A', 'B'], () => 'blocked')
  assert.equal(r.percent, 25, '阻塞算 25% 进度，体现"在但没推进"')
  assert.equal(r.done, 0)
  assert.equal(r.total, 2)
})

test('空阶段进度为 0 不崩', () => {
  const r = stageProgress([], () => 'done')
  assert.equal(r.percent, 0)
  assert.equal(r.done, 0)
  assert.equal(r.total, 0)
})

// ── 常量 ────────────────────────────────────────────────────────────
test('四个状态都有中文名与色调', () => {
  for (const s of TASK_STATES) {
    assert.ok(STATE_META[s], `${s} 缺少元信息`)
    assert.ok(typeof STATE_META[s].label === 'string' && STATE_META[s].label !== '')
    assert.ok(typeof STATE_META[s].tone === 'string')
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
