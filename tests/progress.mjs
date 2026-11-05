/**
 * 分析进度测试。
 *
 * Run: node tests/progress.mjs
 */

import { strict as assert } from 'node:assert'
import {
  ANALYSIS_STEPS,
  ProgressStore,
  RUN_STATUS,
  advanceRun,
  finishRun,
  isStale,
  runView,
  startRun,
} from '../lib/progress.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nprogress')

// ── 初始状态 ────────────────────────────────────────────────────────
test('新运行停在第 1 步', () => {
  const r = startRun('s1', 1000)
  assert.equal(r.status, RUN_STATUS.running)
  assert.equal(r.step, 0)
  assert.equal(r.stepId, 'segment')
  assert.equal(r.steps.segment, 'pending')
})

test('三个步骤都有 id 与中文名', () => {
  assert.equal(ANALYSIS_STEPS.length, 3)
  for (const s of ANALYSIS_STEPS) {
    assert.ok(s.id && s.label && s.detail)
  }
})

// ── 推进 ────────────────────────────────────────────────────────────
test('推进到第 2 步时第 1 步标记完成', () => {
  let r = startRun('s', 1000)
  r = advanceRun(r, 'workflow', 2000)
  assert.equal(r.step, 1)
  assert.equal(r.steps.segment, 'done')
  assert.equal(r.steps.workflow, 'active')
})

test('推进不修改入参（不可变）', () => {
  const before = startRun('s', 1000)
  const after = advanceRun(before, 'workflow', 2000)
  assert.equal(before.step, 0, '原对象不应被改')
  assert.equal(after.step, 1)
})

test('未知步骤 id 被忽略', () => {
  const r = startRun('s', 1000)
  assert.equal(advanceRun(r, 'nope', 2000).step, 0)
})

test('跳步推进也把中间步标完成', () => {
  let r = startRun('s', 1000)
  r = advanceRun(r, 'stage', 2000)
  assert.equal(r.steps.segment, 'done')
  assert.equal(r.steps.workflow, 'done')
  assert.equal(r.steps.stage, 'active')
})

// ── 结束 ────────────────────────────────────────────────────────────
test('正常结束把所有步骤标完成', () => {
  let r = startRun('s', 1000)
  r = advanceRun(r, 'stage', 2000)
  r = finishRun(r, RUN_STATUS.done, null, 3000)
  assert.equal(r.status, 'done')
  assert.equal(r.step, 3)
  assert.equal(r.label, '完成')
  for (const id of ['segment', 'workflow', 'stage']) {
    assert.equal(r.steps[id], 'done', `${id} 应完成`)
  }
})

test('失败时当前步标记 failed', () => {
  let r = startRun('s', 1000)
  r = advanceRun(r, 'workflow', 2000)
  r = finishRun(r, RUN_STATUS.failed, '上游 502', 3000)
  assert.equal(r.status, 'failed')
  assert.equal(r.steps.workflow, 'failed')
  assert.equal(r.steps.segment, 'done', '已完成的步骤保持完成')
  assert.equal(r.steps.stage, 'pending', '未开始的保持 pending')
})

test('失败原因被截断（不塞长栈）', () => {
  let r = startRun('s', 1000)
  r = finishRun(r, RUN_STATUS.failed, 'x'.repeat(1000), 2000)
  assert.ok(r.error.length <= 200)
})

test('取消也记录状态', () => {
  let r = startRun('s', 1000)
  r = finishRun(r, RUN_STATUS.cancelled, null, 2000)
  assert.equal(r.status, 'cancelled')
})

// ── 视图 ────────────────────────────────────────────────────────────
test('视图给出步骤列表与耗时', () => {
  let r = startRun('s', 1000)
  r = advanceRun(r, 'workflow', 5000)
  const v = runView(r, 6000)
  assert.equal(v.active, true)
  assert.equal(v.currentStep, 1)
  assert.equal(v.totalSteps, 3)
  assert.equal(v.elapsedMs, 5000)
  assert.equal(v.steps[0].state, 'done')
  assert.equal(v.steps[1].state, 'active')
})

test('空记录给 idle 视图而不是崩溃', () => {
  const v = runView(null, 1000)
  assert.equal(v.active, false)
  assert.equal(v.status, 'idle')
  assert.deepEqual(v.steps, [])
})

test('视图不泄露内部 bookkeeping', () => {
  const v = runView(startRun('secret-session-id', 1000), 2000)
  assert.equal(v.sessionId, undefined, '不应把 sessionId 透给前端视图')
})

// ── 超时 ────────────────────────────────────────────────────────────
test('超过 5 分钟视为卡住', () => {
  const r = startRun('s', 0)
  assert.equal(isStale(r, 4 * 60 * 1000), false)
  assert.equal(isStale(r, 6 * 60 * 1000), true)
})

test('已结束的运行不算卡住', () => {
  let r = startRun('s', 0)
  r = finishRun(r, RUN_STATUS.done, null, 1000)
  assert.equal(isStale(r, 10 * 60 * 1000), false)
})

// ── 存储 ────────────────────────────────────────────────────────────
test('ProgressStore 按会话分开', () => {
  const store = new ProgressStore()
  store.start('a', 1000)
  store.start('b', 2000)
  assert.equal(store.get('a').startedAt, 1000)
  assert.equal(store.get('b').startedAt, 2000)
})

test('开始新运行覆盖旧记录（只留最新）', () => {
  const store = new ProgressStore()
  store.start('a', 1000)
  store.start('a', 5000)
  assert.equal(store.get('a').startedAt, 5000)
})

test('清除后读不到', () => {
  const store = new ProgressStore()
  store.start('a', 1000)
  store.clear('a')
  assert.equal(store.get('a'), undefined)
})

test('set 能更新记录', () => {
  const store = new ProgressStore()
  let r = store.start('a', 1000)
  r = advanceRun(r, 'workflow', 2000)
  store.set('a', r)
  assert.equal(store.get('a').step, 1)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
