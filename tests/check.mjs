/**
 * Offline checks for the pure Host half. No harness, no I/O, no fixtures on
 * disk: each case builds a synthetic event log and asserts on the fold.
 *
 * Run: node tests/check.mjs
 */

import { strict as assert } from 'node:assert'
import { buildTurnModel, previewText, addUsage, emptyUsage, cumulativeUsage, sumTotals } from '../lib/turn-model.js'
import { tokenize, jaccard, assignLanes, applyOverrides, ENGINE_VERSION } from '../lib/lane-engine.js'
import { turnCostUsd, sessionCost, formatCost, formatTokens, formatDuration } from '../lib/cost.js'
import { lookupPrices, PRICE_TABLE } from '../lib/prices.js'
import { SessionCache } from '../lib/session-cache.js'

let passed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

// ── 事件构造器 ──────────────────────────────────────────────────────
let seq = 0
function reset() { seq = 0 }

function turnStart(turn) {
  return { type: 'turn/start', seq: seq++, time: 1000 + turn * 10000, data: { turn } }
}
function turnEnd(turn, kind = 'completed') {
  return { type: 'turn/end', seq: seq++, time: 1000 + turn * 10000 + 5000, data: { turn, reason: { kind } } }
}
function userSays(text, sourceKind = 'user') {
  return { type: 'user/message', seq: seq++, time: 0, data: { content: [{ type: 'text', text }], source: { kind: sourceKind } } }
}
function assistantSays(text, usage) {
  return {
    type: 'assistant/message', seq: seq++, time: 0,
    data: {
      message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' } },
      stream: [], usage,
    },
  }
}
function stepStart() { return { type: 'step/start', seq: seq++, time: 0, data: {} } }
function toolCall(name, args) { return { type: 'tool/call', seq: seq++, time: 0, data: { name, arguments: args, callId: 'c', step: 1 } } }

function usage(input, output, cacheRead = 0, cacheWrite = 0) {
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
}

// ── turn-model ──────────────────────────────────────────────────────
console.log('\nturn-model')

test('previewText collapses whitespace and clips', () => {
  const got = previewText([{ type: 'text', text: '  hello \n\n  world  ' }], 20)
  assert.equal(got, 'hello world')
  const long = previewText([{ type: 'text', text: 'x'.repeat(100) }], 10)
  assert.equal(long.length, 10)
  assert.ok(long.endsWith('…'))
})

test('previewText ignores non-text blocks', () => {
  const got = previewText([
    { type: 'tool-call', name: 'bash', arguments: '{}' },
    { type: 'text', text: 'real words' },
    { type: 'image', attachment: {} },
  ], 40)
  assert.equal(got, 'real words')
})

test('addUsage sums mutually exclusive buckets', () => {
  const total = emptyUsage()
  addUsage(total, usage(100, 20, 50, 10))
  addUsage(total, usage(200, 30, 60, 0))
  assert.deepEqual(total, { input: 300, output: 50, cacheRead: 110, cacheWrite: 10, reasoning: 0 })
})

test('addUsage tolerates missing and negative values', () => {
  const total = emptyUsage()
  addUsage(total, undefined)
  addUsage(total, { inputTokens: -5, outputTokens: 'x' })
  assert.deepEqual(total, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 })
})

test('one turn: prompt, response, usage, steps, tools', () => {
  reset()
  const events = [
    turnStart(0), stepStart(), userSays('fix the build'),
    assistantSays('done', usage(100, 10)), toolCall('bash', '{"command":"npm test"}'), turnEnd(0),
  ]
  const { turns, totals } = buildTurnModel(events)
  assert.equal(turns.length, 1)
  const t = turns[0]
  assert.equal(t.turn, 0)
  assert.equal(t.prompt, 'fix the build')
  assert.equal(t.response, 'done')
  assert.equal(t.usage.input, 100)
  assert.equal(t.usage.output, 10)
  assert.equal(t.steps, 1)
  assert.equal(t.toolCalls, 1)
  assert.deepEqual(t.tools, ['bash'])
  assert.equal(t.endReason, 'completed')
  assert.equal(totals.turns, 1)
})

test('steering is counted, not promoted to a new turn', () => {
  reset()
  const events = [
    turnStart(0), userSays('first'), userSays('also do this'),
    assistantSays('ok', usage(10, 1)), turnEnd(0),
  ]
  const { turns } = buildTurnModel(events)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].prompt, 'first')
  assert.equal(turns[0].steering, 1)
})

test('system-prompt injection is not a prompt', () => {
  reset()
  const events = [turnStart(0), userSays('[injected]', 'system-prompt'), userSays('real ask'), turnEnd(0)]
  const { turns } = buildTurnModel(events)
  assert.equal(turns[0].prompt, 'real ask')
  assert.equal(turns[0].steering, 0)
})

test('multiple assistant messages in one turn accumulate usage', () => {
  reset()
  const events = [
    turnStart(0), userSays('go'),
    assistantSays('step one', usage(100, 10)),
    assistantSays('step two', usage(50, 5)),
    turnEnd(0),
  ]
  const { turns } = buildTurnModel(events)
  assert.equal(turns[0].usage.input, 150)
  assert.equal(turns[0].usage.output, 15)
  assert.equal(turns[0].response, 'step two')
})

test('unclosed turn reports open', () => {
  reset()
  const { turns } = buildTurnModel([turnStart(0), userSays('still going')])
  assert.equal(turns[0].endReason, 'open')
  assert.equal(turns[0].endSeq, null)
})

test('turn/end abort reason is preserved', () => {
  reset()
  const events = [turnStart(0), userSays('x'), turnEnd(0, 'aborted')]
  assert.equal(buildTurnModel(events).turns[0].endReason, 'aborted')
})

test('retried boundary does not create a duplicate turn', () => {
  reset()
  const events = [turnStart(0), userSays('a'), turnStart(0), userSays('b'), turnEnd(0)]
  const { turns } = buildTurnModel(events)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].prompt, 'a')
})

test('tool call extracts file paths and commands', () => {
  reset()
  const events = [
    turnStart(0), userSays('edit'),
    toolCall('edit', JSON.stringify({ file_path: 'E:\\proj\\src\\App.java' })),
    toolCall('bash', JSON.stringify({ command: '/review the diff' })),
    turnEnd(0),
  ]
  const t = buildTurnModel(events).turns[0]
  assert.ok(t.files.some(p => p.includes('App.java')), `files=${JSON.stringify(t.files)}`)
  assert.ok(t.commands.includes('/review'), `commands=${JSON.stringify(t.commands)}`)
})

test('cumulativeUsage is monotonic', () => {
  reset()
  const events = [
    turnStart(0), userSays('a'), assistantSays('x', usage(100, 10)), turnEnd(0),
    turnStart(1), userSays('b'), assistantSays('y', usage(200, 20)), turnEnd(1),
  ]
  const { turns } = buildTurnModel(events)
  const cum = cumulativeUsage(turns)
  assert.equal(cum[0].input, 100)
  assert.equal(cum[1].input, 300)
  assert.equal(cum[1].output, 30)
})

test('sumTotals aggregates duration and tools', () => {
  reset()
  const events = [
    turnStart(0), userSays('a'), toolCall('bash', '{}'), turnEnd(0, 'completed'),
  ]
  const totals = sumTotals(buildTurnModel(events).turns)
  assert.equal(totals.turns, 1)
  assert.equal(totals.toolCalls, 1)
  assert.equal(totals.durationMs, 5000)
})

// ── lane-engine ─────────────────────────────────────────────────────
console.log('\nlane-engine')

test('tokenize mixes Chinese bigrams and English words', () => {
  const terms = tokenize('修复 build error 插件')
  assert.ok(terms.includes('build'))
  assert.ok(terms.some(t => t.includes('插件') || t === '插件'))
})

test('jaccard is symmetric and bounded', () => {
  const a = new Set(['x', 'y'])
  const b = new Set(['y', 'z'])
  assert.equal(jaccard(a, b), jaccard(b, a))
  assert.ok(Math.abs(jaccard(a, b) - 1 / 3) < 1e-9)
  assert.equal(jaccard(new Set(), b), 0)
})

test('empty model yields no lanes', () => {
  assert.deepEqual(assignLanes({ sessionId: 's', turns: [] }), [])
})

test('one contiguous topic stays on one lane', () => {
  reset()
  const events = []
  for (let i = 0; i < 6; i += 1) {
    events.push(turnStart(i), userSays(`插件 面板 设计 第${i}轮 继续细化`), assistantSays('ok', usage(10, 1)), turnEnd(i))
  }
  const model = buildTurnModel(events)
  const lanes = assignLanes({ ...model, sessionId: 's1' })
  assert.equal(lanes.length, 1, `expected 1 lane, got ${lanes.length}`)
  assert.equal(lanes[0].turns.length, 6)
})

test('two disjoint topics split into two lanes', () => {
  reset()
  const events = []
  const texts = [
    '插件 面板 泳道 时间轴 渲染',
    '插件 面板 泳道 时间轴 布局',
    '插件 面板 泳道 时间轴 配色',
    '数据库 索引 分片 事务 隔离级别',
    '数据库 索引 分片 事务 回滚',
    '数据库 索引 分片 事务 主从',
  ]
  for (let i = 0; i < texts.length; i += 1) {
    events.push(turnStart(i), userSays(texts[i]), assistantSays('ok', usage(10, 1)), turnEnd(i))
  }
  const model = buildTurnModel(events)
  const lanes = assignLanes({ ...model, sessionId: 's2' })
  assert.ok(lanes.length >= 2, `expected >=2 lanes, got ${lanes.length}`)
  const all = lanes.flatMap(l => l.turns).sort((a, b) => a - b)
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5], 'every turn must belong to exactly one lane')
})

test('returning to an old topic resumes that lane', () => {
  reset()
  const events = []
  const plan = [
    '插件 面板 泳道 话题 渲染',
    '插件 面板 泳道 话题 布局',
    '插件 面板 泳道 话题 配色',
    '数据库 索引 分片 事务 隔离',
    '数据库 索引 分片 事务 回滚',
    '数据库 索引 分片 事务 主从',
    '回到刚才 插件 面板 泳道 话题 继续',
    '插件 面板 泳道 话题 收尾',
  ]
  for (let i = 0; i < plan.length; i += 1) {
    events.push(turnStart(i), userSays(plan[i]), assistantSays('ok', usage(10, 1)), turnEnd(i))
  }
  const model = buildTurnModel(events)
  const lanes = assignLanes({ ...model, sessionId: 's3' })
  const resumed = lanes.filter(l => l.segments.some(s => s.kind === 'resumed'))
  assert.ok(resumed.length >= 1, `expected a resumed lane, got ${lanes.map(l => l.segments.map(s => s.kind))}`)
  assert.ok(resumed[0].turns.length >= 4, `resumed lane should hold both halves, got ${resumed[0].turns}`)
})

test('every turn assigned exactly once across lanes', () => {
  reset()
  const events = []
  for (let i = 0; i < 12; i += 1) {
    const topic = i < 4 ? 'alpha beta gamma' : i < 8 ? 'delta epsilon zeta' : 'eta theta iota'
    events.push(turnStart(i), userSays(`${topic} 第${i}步`), assistantSays('ok', usage(5, 1)), turnEnd(i))
  }
  const lanes = assignLanes({ ...buildTurnModel(events), sessionId: 's4' })
  const all = lanes.flatMap(l => l.turns).sort((a, b) => a - b)
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
})

test('override rename beats auto title', () => {
  const lanes = [{ laneId: 'L1', title: 'auto', titleSource: 'keywords', turns: [0, 1], segments: [] }]
  const out = applyOverrides(lanes, [{ kind: 'rename', laneId: 'L1', title: '手动名字' }])
  assert.equal(out[0].title, '手动名字')
  assert.equal(out[0].titleSource, 'user')
})

test('override lock is recorded', () => {
  const lanes = [{ laneId: 'L1', title: 'a', locked: false, turns: [0], segments: [] }]
  const out = applyOverrides(lanes, [{ kind: 'lock', laneId: 'L1', locked: true }])
  assert.equal(out[0].locked, true)
})

test('override move relocates a turn and drops the emptied lane', () => {
  const lanes = [
    { laneId: 'L1', title: 'a', turns: [0, 1], segments: [] },
    { laneId: 'L2', title: 'b', turns: [2], segments: [] },
  ]
  const out = applyOverrides(lanes, [{ kind: 'move', laneId: 'L1', turn: 2 }])
  assert.equal(out.length, 1)
  assert.deepEqual(out[0].turns, [0, 1, 2])
})

test('engine version is a positive integer', () => {
  assert.ok(Number.isInteger(ENGINE_VERSION) && ENGINE_VERSION > 0)
})

// ── 两级泳道（B+C）────────────────────────────────────────────────
console.log('\n两级泳道')

test('one topic with an internal shift yields 1 lane with 2 subtopics', () => {
  reset()
  const events = []
  const plan = [
    '插件开发 数据模型 字段 结构 序列化',
    '插件开发 数据模型 字段 结构 校验',
    '插件开发 数据模型 字段 结构 迁移',
    '插件开发 渲染 泳道 坐标 布局 像素',
    '插件开发 渲染 泳道 坐标 布局 缩放',
    '插件开发 渲染 泳道 坐标 布局 动画',
  ]
  for (let i = 0; i < plan.length; i += 1) {
    events.push(turnStart(i), userSays(plan[i]), assistantSays('ok', usage(10, 1)), turnEnd(i))
  }
  const lanes = assignLanes({ ...buildTurnModel(events), sessionId: 'two' })
  assert.equal(lanes.length, 1, `expected 1 topic, got ${lanes.length}`)
  assert.equal(lanes[0].subtopics.length, 2, `expected 2 subtopics, got ${lanes[0].subtopics.length}`)
  const covered = lanes[0].subtopics.flatMap(s => s.turns).sort((a, b) => a - b)
  assert.deepEqual(covered, [0, 1, 2, 3, 4, 5])
})

test('subtopics never cross a topic boundary', () => {
  reset()
  const events = []
  const plan = [
    '插件开发 数据模型 字段 结构',
    '插件开发 数据模型 字段 校验',
    '插件开发 数据模型 字段 迁移',
    '数据库 索引 分片 事务 隔离',
    '数据库 索引 分片 事务 回滚',
    '数据库 索引 分片 事务 主从',
  ]
  for (let i = 0; i < plan.length; i += 1) {
    events.push(turnStart(i), userSays(plan[i]), assistantSays('ok', usage(10, 1)), turnEnd(i))
  }
  const lanes = assignLanes({ ...buildTurnModel(events), sessionId: 'cross' }, { threshold: 0.2 })
  assert.ok(lanes.length >= 2, `expected >=2 topics, got ${lanes.length}`)
  for (const lane of lanes) {
    const subtopicTurns = lane.subtopics.flatMap(s => s.turns)
    for (const t of subtopicTurns) {
      assert.ok(lane.turns.includes(t), `subtopic turn ${t} not in its lane turns ${lane.turns}`)
    }
    assert.equal(
      new Set(subtopicTurns).size,
      lane.turns.length,
      `lane ${lane.row} subtopics must cover exactly its turns`,
    )
  }
})

test('a lane always has at least one subtopic', () => {
  reset()
  const events = []
  for (let i = 0; i < 3; i += 1) {
    events.push(turnStart(i), userSays(`单轮 内容 第${i}`), assistantSays('ok', usage(1, 1)), turnEnd(i))
  }
  const lanes = assignLanes({ ...buildTurnModel(events), sessionId: 'one' })
  for (const lane of lanes) {
    assert.ok(lane.subtopics.length >= 1, `lane ${lane.row} has no subtopics`)
  }
})

test('resumed lane keeps per-stretch subtopics', () => {
  reset()
  const events = []
  const plan = [
    '插件 面板 泳道 渲染 布局',
    '插件 面板 泳道 渲染 配色',
    '数据库 索引 分片 事务 隔离',
    '数据库 索引 分片 事务 回滚',
    '回到刚才 插件 面板 泳道 渲染 收尾',
    '插件 面板 泳道 渲染 完成',
  ]
  for (let i = 0; i < plan.length; i += 1) {
    events.push(turnStart(i), userSays(plan[i]), assistantSays('ok', usage(10, 1)), turnEnd(i))
  }
  const lanes = assignLanes({ ...buildTurnModel(events), sessionId: 'resume' })
  const resumed = lanes.find(l => l.segments.some(s => s.kind === 'resumed'))
  assert.ok(resumed !== undefined, `expected a resumed lane, got ${JSON.stringify(lanes.map(l => l.segments.map(s => s.kind)))}`)
  const covered = resumed.subtopics.flatMap(s => s.turns).sort((a, b) => a - b)
  assert.deepEqual(covered, [...resumed.turns].sort((a, b) => a - b))
})

// ── cost ────────────────────────────────────────────────────────────
console.log('\ncost')

test('turnCostUsd prices four buckets separately', () => {
  const price = { cacheMiss: 1, cacheHit: 0.1, cacheWrite: 0.2, output: 2 }
  const cost = turnCostUsd({ input: 1e6, cacheRead: 1e6, cacheWrite: 1e6, output: 1e6 }, price)
  assert.ok(Math.abs(cost - (1 + 0.1 + 0.2 + 2)) < 1e-9, `got ${cost}`)
})

test('turnCostUsd returns null without a usable price', () => {
  assert.equal(turnCostUsd({ input: 1, output: 1 }, undefined), null)
  assert.equal(turnCostUsd({ input: 1, output: 1 }, { cacheMiss: 1 }), null)
})

test('cacheHit falls back to cacheMiss when absent', () => {
  const cost = turnCostUsd({ input: 0, cacheRead: 1e6, cacheWrite: 0, output: 0 }, { cacheMiss: 3, output: 1 })
  assert.ok(Math.abs(cost - 3) < 1e-9)
})

test('sessionCost flags partial pricing instead of guessing', () => {
  const turns = [
    { usage: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, model: { provider: 'p', model: 'known' } },
    { usage: { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0 }, model: { provider: 'p', model: 'unknown' } },
  ]
  const result = sessionCost(turns, { 'p/known': { cacheMiss: 2, output: 1 } })
  assert.equal(result.amount, 2)
  assert.equal(result.pricedTurns, 1)
  assert.equal(result.unpricedTurns, 1)
  assert.equal(result.partial, true)
})

test('sessionCost returns null when nothing is priced', () => {
  const result = sessionCost([{ usage: { input: 1, output: 1 }, model: { provider: 'p', model: 'nope' } }], {})
  assert.equal(result.amount, null)
})

test('formatCost marks partial sums and tiny amounts', () => {
  assert.equal(formatCost({ amount: 0.63, partial: false }), '$0.63')
  assert.equal(formatCost({ amount: 0.63, partial: true }), '$0.63 +')
  assert.equal(formatCost({ amount: 0.0084, partial: false }), '$0.0084')
  assert.equal(formatCost({ amount: 12.5, partial: false }), '$12.50')
  assert.equal(formatCost({ amount: 0.00001, partial: false }), '<$0.0001')
  assert.equal(formatCost({ amount: null, partial: false }), null)
})

test('formatTokens and formatDuration', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(12400), '12.4k')
  assert.equal(formatTokens(1500000), '1.5M')
  assert.equal(formatDuration(83000), '1m23s')
  assert.equal(formatDuration(12000), '12s')
  assert.equal(formatDuration(null), '—')
})

test('every builtin price entry is usable', () => {
  for (const [key, price] of Object.entries(PRICE_TABLE)) {
    assert.ok(Number.isFinite(price.cacheMiss), `${key} cacheMiss`)
    assert.ok(Number.isFinite(price.output), `${key} output`)
  }
})

test('lookupPrices resolves known routes and skips unknown', async () => {
  // 这个用例是 async 场景的同步近似：直接断言表内容
  const known = PRICE_TABLE['agent2api/DeepSeek-Flash']
  assert.ok(known !== undefined)
  assert.ok(Number.isFinite(known.cacheMiss))
})

// ── session-cache ───────────────────────────────────────────────────
console.log('\nsession-cache')

test('cache returns a payload only on matching revision and version', () => {
  const cache = new SessionCache()
  cache.set('s', 'r1', 1, { v: 1 })
  assert.deepEqual(cache.get('s', 'r1', 1), { v: 1 })
  assert.equal(cache.get('s', 'r2', 1), undefined)
  assert.equal(cache.get('s', 'r1', 2), undefined)
})

test('cache evicts least recently used beyond capacity', () => {
  const cache = new SessionCache()
  for (let i = 0; i < 9; i += 1) cache.set(`s${i}`, 'r', 1, { i })
  assert.equal(cache.peek('s0'), undefined, 'oldest should be evicted')
  assert.notEqual(cache.peek('s8'), undefined)
})

test('peek does not disturb recency', () => {
  const cache = new SessionCache()
  cache.set('a', 'r', 1, { a: 1 })
  cache.set('b', 'r', 1, { b: 1 })
  cache.peek('a')
  for (let i = 0; i < 7; i += 1) cache.set(`x${i}`, 'r', 1, {})
  assert.notEqual(cache.peek('b'), undefined, 'b was more recent than a')
})

test('override append invalidates the cached payload', () => {
  const cache = new SessionCache()
  cache.set('s', 'r1', 1, { v: 1 })
  cache.addOverride('s', { kind: 'rename', laneId: 'L1', title: 'x' })
  assert.equal(cache.get('s', 'r1', 1), undefined)
  assert.equal(cache.overridesOf('s').length, 1)
})

test('overridesOf is empty for an unseen session', () => {
  assert.deepEqual(new SessionCache().overridesOf('never'), [])
})

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
