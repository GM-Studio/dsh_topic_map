/**
 * End-to-end payload checks: raw events in, complete panel payload out.
 *
 * This is the test that would have caught "payload.graph 缺失" before it ever
 * reached a browser. It exercises the exact function the Host calls, so a
 * refactor that drops or renames a field fails here instead of silently
 * degrading the panel to an empty state.
 *
 * Run: node tests/payload.mjs
 */

import { strict as assert } from 'node:assert'
import { buildSessionPayloadParts } from '../lib/payload.js'
import { ENGINE_VERSION } from '../lib/lane-engine.js'

let passed = 0
const failures = []

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

/** Build a plausible event log of `n` turns, alternating two subjects. */
function makeEvents(n) {
  let seq = 0
  const out = []
  const push = (type, data, time) => out.push({ type, seq: seq++, time, data })
  const subjects = [
    '插件 面板 泳道 渲染 布局',
    '数据库 索引 分片 事务 隔离',
  ]
  for (let i = 0; i < n; i += 1) {
    const words = subjects[Math.floor(i / 4) % 2]
    const base = 1_700_000_000_000 + i * 60_000
    push('turn/start', { turn: i }, base)
    push('user/message', {
      content: [{ type: 'text', text: `${words} 第 ${i} 步` }],
      source: { kind: 'user' },
    }, base + 100)
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
      stream: [],
      usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500, cacheWriteTokens: 0 },
    }, base + 4000)
    push('turn/end', { turn: i, reason: { kind: 'completed' } }, base + 5000)
  }
  return out
}

console.log('\npayload')

const payload = await buildSessionPayloadParts(makeEvents(12), 'sess-test')

await test('payload carries every field the panel reads', () => {
  for (const key of ['sessionId', 'engineVersion', 'turns', 'cumulative', 'lanes', 'graph', 'totals', 'cost']) {
    assert.ok(payload[key] !== undefined && payload[key] !== null, `missing field: ${key}`)
  }
})

await test('engineVersion matches the engine in use', () => {
  assert.equal(payload.engineVersion, ENGINE_VERSION)
})

await test('graph topology is present and complete', () => {
  const g = payload.graph
  assert.equal(typeof g.turnCount, 'number')
  assert.equal(typeof g.columnCount, 'number')
  assert.ok(Array.isArray(g.nodes) && g.nodes.length > 0, 'graph has no nodes')
  assert.ok(Array.isArray(g.edges), 'graph has no edges array')
  assert.ok(Array.isArray(g.labels), 'graph has no labels array')
  assert.ok(Array.isArray(g.columns), 'graph has no columns array')
})

await test('every column reference resolves to a real topic', () => {
  const laneIds = new Set(payload.lanes.map(l => l.laneId))
  for (const c of payload.graph.columns) {
    assert.ok(laneIds.has(c.laneId), `graph column references unknown lane ${c.laneId}`)
  }
})

await test('every node maps to a real turn and a real topic', () => {
  const turnNos = new Set(payload.turns.map(t => t.turn))
  const laneIds = new Set(payload.lanes.map(l => l.laneId))
  for (const n of payload.graph.nodes) {
    assert.ok(turnNos.has(n.turn), `node references unknown turn ${n.turn}`)
    assert.ok(laneIds.has(n.laneId), `node references unknown lane ${n.laneId}`)
  }
})

await test('graph nodes cover every turn at least once', () => {
  const seen = new Set(payload.graph.nodes.map(n => n.turn))
  for (const t of payload.turns) {
    assert.ok(seen.has(t.turn), `turn ${t.turn} has no node`)
  }
})

await test('edges only reference in-range positions', () => {
  const maxIndex = payload.graph.turnCount - 1
  const maxCol = payload.graph.columnCount - 1
  for (const e of payload.graph.edges) {
    if (e.kind === 'lane') {
      assert.ok(e.from >= 0 && e.from <= maxIndex, `lane edge from out of range: ${e.from}`)
      assert.ok(e.to >= 0 && e.to <= maxIndex, `lane edge to out of range: ${e.to}`)
      assert.ok(e.col >= 0 && e.col <= maxCol, `lane edge col out of range: ${e.col}`)
    } else if (e.kind === 'fork') {
      assert.ok(e.fromCol !== e.toCol, 'fork must change column')
    }
  }
})

await test('an alternating session forks instead of staying flat', () => {
  assert.ok(payload.graph.columnCount >= 2, `expected >=2 columns, got ${payload.graph.columnCount}`)
  assert.ok(
    payload.graph.edges.filter(e => e.kind === 'fork').length >= 1,
    'expected at least one fork edge',
  )
})

await test('cost is priced for a known model', () => {
  assert.equal(payload.cost.pricedTurns > 0, true, 'no turn was priced')
  assert.equal(typeof payload.cost.label, 'string')
  assert.ok(payload.cost.label.startsWith('$'), `unexpected label ${payload.cost.label}`)
})

await test('cumulative matches the turn count', () => {
  assert.equal(payload.cumulative.length, payload.turns.length)
})

await test('empty log yields an empty but well-formed payload', async () => {
  const empty = await buildSessionPayloadParts([], 'sess-empty')
  assert.equal(empty.turns.length, 0)
  assert.equal(empty.graph.nodes.length, 0)
  assert.equal(empty.graph.columnCount, 0)
  assert.equal(empty.cost.amount, null)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
