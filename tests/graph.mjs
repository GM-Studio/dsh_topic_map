/**
 * Offline checks for the graph topology. The recycling rule is the one that
 * matters: if a finished topic's column is never reused, a long session grows
 * one empty row per topic and the panel becomes unreadable.
 *
 * Run: node tests/graph.mjs
 */

import { strict as assert } from 'node:assert'
import { allocateColumns, buildGraph } from '../lib/graph-layout.js'

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

const turnsOf = n => Array.from({ length: n }, (_, i) => ({ turn: i }))

function indexOfMap(n) {
  const m = new Map()
  for (let i = 0; i < n; i += 1) m.set(i, i)
  return m
}

console.log('\ngraph-layout')

test('first topic always takes column 0', () => {
  const lanes = [
    { laneId: 'A', turns: [0, 1, 2], parentLaneId: null },
    { laneId: 'B', turns: [3, 4, 5], parentLaneId: 'A' },
  ]
  const cols = allocateColumns(lanes, indexOfMap(10))
  assert.equal(cols.get('A'), 0)
  assert.ok(cols.get('B') >= 1)
})

test('每条话题独占一行（不再复用列）', () => {
  // 这是被实测推翻后的设计：复用列会让 10 条话题挤进 2 行，
  // 标签全落在同一 y 上互相覆盖。
  const lanes = [
    { laneId: 'A', turns: [0, 1, 2, 3, 4, 5], parentLaneId: null },
    { laneId: 'B', turns: [6, 7, 8], parentLaneId: 'A' },
    { laneId: 'D', turns: [9, 10, 11], parentLaneId: 'A' },
  ]
  const cols = allocateColumns(lanes, indexOfMap(20))
  assert.equal(cols.get('A'), 0)
  assert.equal(cols.get('B'), 1)
  assert.equal(cols.get('D'), 2, '第三条话题必须占第三行，不能复用 B 的行')
})

test('overlapping topics never share a column', () => {
  const lanes = [
    { laneId: 'A', turns: [0, 1, 2, 3, 4, 5, 6, 7], parentLaneId: null },
    { laneId: 'B', turns: [2, 3, 4], parentLaneId: 'A' },
    { laneId: 'C', turns: [3, 4, 5], parentLaneId: 'A' },
  ]
  const cols = allocateColumns(lanes, indexOfMap(20))
  assert.notEqual(cols.get('B'), cols.get('C'), 'B and C overlap in time')
})

test('40 条话题得到 40 行（每话题独立一行）', () => {
  const lanes = []
  for (let i = 0; i < 40; i += 1) {
    lanes.push({
      laneId: `L${i}`,
      turns: [i * 3, i * 3 + 1, i * 3 + 2],
      parentLaneId: i === 0 ? null : 'L0',
    })
  }
  const cols = allocateColumns(lanes, indexOfMap(120))
  const used = new Set(cols.values())
  assert.equal(used.size, 40, `每条话题一行，应得 40 行，实际 ${used.size}`)
  // 行号必须连续
  assert.equal(Math.max(...used), 39)
})

test('empty lanes are skipped without shifting others', () => {
  const lanes = [
    { laneId: 'A', turns: [0, 1], parentLaneId: null },
    { laneId: 'EMPTY', turns: [], parentLaneId: null },
    { laneId: 'B', turns: [2, 3], parentLaneId: 'A' },
  ]
  const cols = allocateColumns(lanes, indexOfMap(6))
  assert.equal(cols.has('EMPTY'), false)
  assert.equal(cols.get('A'), 0)
  assert.ok(cols.has('B'))
})

test('buildGraph emits one node per turn per track', () => {
  const lanes = [
    { laneId: 'A', turns: [0, 1, 2], parentLaneId: null, title: 'A' },
    { laneId: 'B', turns: [3, 4, 5], parentLaneId: 'A', title: 'B' },
  ]
  const g = buildGraph(turnsOf(6), lanes)
  assert.equal(g.nodes.length, 6)
  assert.equal(new Set(g.nodes.map(n => n.turn)).size, 6)
  assert.equal(g.columnCount, 2)
})

test('buildGraph draws a fork from parent to child', () => {
  const lanes = [
    { laneId: 'A', turns: [0, 1, 2], parentLaneId: null, title: 'A' },
    { laneId: 'B', turns: [3, 4, 5], parentLaneId: 'A', title: 'B' },
  ]
  const g = buildGraph(turnsOf(6), lanes)
  const forks = g.edges.filter(e => e.kind === 'fork')
  assert.equal(forks.length, 1)
  assert.ok(forks[0].from < forks[0].to, 'fork goes left to right')
  assert.notEqual(forks[0].fromCol, forks[0].toCol, 'fork changes track')
})

test('shared turns get a node on each track plus a tie', () => {
  const lanes = [
    { laneId: 'A', turns: [0, 1, 2, 3], parentLaneId: null, title: 'A' },
    { laneId: 'B', turns: [4, 5], parentLaneId: 'A', sharedTurns: [3], title: 'B' },
  ]
  const g = buildGraph(turnsOf(6), lanes)
  const at3 = g.nodes.filter(n => n.turn === 3)
  assert.equal(at3.length, 2, 'turn 3 belongs to both topics')
  const ties = g.edges.filter(e => e.kind === 'share')
  assert.ok(ties.length >= 1, 'shared turn needs a tie')
  assert.equal(ties[0].index, 3)
})

test('gap connector is marked when a topic resumes later', () => {
  const lanes = [{ laneId: 'A', turns: [0, 1, 5, 6], parentLaneId: null, title: 'A' }]
  const g = buildGraph(turnsOf(10), lanes)
  const gaps = g.edges.filter(e => e.kind === 'lane' && e.gap)
  assert.equal(gaps.length, 1, 'one gap between index 1 and 2')
})

test('每条话题带一个标签，其 index 是话题最后一轮（客户端可自行决定画在哪）', () => {
  const lanes = [
    { laneId: 'A', turns: [0, 1, 2], parentLaneId: null, title: 'A' },
    { laneId: 'B', turns: [3, 4, 5], parentLaneId: 'A', title: 'B' },
  ]
  const g = buildGraph(turnsOf(6), lanes)
  assert.equal(g.labels.length, 2)
  assert.equal(g.labels[0].index, 2)
  assert.equal(g.labels[1].index, 5)
  // 每条话题的标签必须落在自己那一行：这是左端标签不重叠的前提
  assert.equal(g.labels[0].col, 0)
  assert.equal(g.labels[1].col, 1)
})

test('a fork never lands on its parent column', () => {
  // Sequential, non-overlapping topics: a naive space-reuse rule would put
  // every one of them on column 1 and draw no diagonals at all.
  const lanes = [
    { laneId: 'A', turns: [0, 1, 2], parentLaneId: null, title: 'A' },
    { laneId: 'B', turns: [3], parentLaneId: 'A', title: 'B' },
    { laneId: 'C', turns: [4], parentLaneId: 'B', title: 'C' },
    { laneId: 'D', turns: [5], parentLaneId: 'C', title: 'D' },
  ]
  const g = buildGraph(turnsOf(6), lanes)
  for (const e of g.edges.filter(x => x.kind === 'fork')) {
    assert.notEqual(e.fromCol, e.toCol, 'fork must change column or it draws no diagonal')
  }
  assert.ok(g.columnCount >= 3, `expected a real tree, got ${g.columnCount} column(s)`)
})

test('a single topic produces no forks', () => {
  const g = buildGraph(turnsOf(4), [{ laneId: 'A', turns: [0, 1, 2, 3], parentLaneId: null, title: 'A' }])
  assert.equal(g.edges.filter(e => e.kind === 'fork').length, 0)
  assert.equal(g.edges.filter(e => e.kind === 'lane').length, 3)
  assert.equal(g.columnCount, 1)
})

// ── 合并与主支线 ────────────────────────────────────────────────────
test('合并产生 merge 边（方向：被吸收 → 保留）', () => {
  const lanes = [
    { laneId: 'A', turns: [0, 1, 2], parentLaneId: null, title: '甲', mergedFrom: ['B'], mergedAt: [2] },
    { laneId: 'B', turns: [2], parentLaneId: 'A', title: '乙' },
  ]
  const g = buildGraph(turnsOf(3), lanes)
  const merges = g.edges.filter(e => e.kind === 'merge')
  assert.equal(merges.length, 1)
  assert.equal(merges[0].absorbedLaneId, 'B')
  assert.equal(merges[0].laneId, 'A')
  assert.equal(merges[0].fromCol, 1, '从被吸收那条的行出发')
  assert.equal(merges[0].toCol, 0, '连到保留那条的行')
})

test('没有合并信息时不产生 merge 边', () => {
  const g = buildGraph(turnsOf(4), [
    { laneId: 'A', turns: [0, 1], parentLaneId: null, title: 'A' },
    { laneId: 'B', turns: [2, 3], parentLaneId: 'A', title: 'B' },
  ])
  assert.equal(g.edges.filter(e => e.kind === 'merge').length, 0)
})

test('第一个话题被标记为主线，其余为支线', () => {
  const g = buildGraph(turnsOf(4), [
    { laneId: 'A', turns: [0, 1], parentLaneId: null, title: 'A' },
    { laneId: 'B', turns: [2, 3], parentLaneId: 'A', title: 'B' },
  ])
  assert.equal(g.trunkLaneId, 'A')
  assert.equal(g.labels.find(l => l.laneId === 'A').role, 'trunk')
  assert.equal(g.labels.find(l => l.laneId === 'B').role, 'branch')
})

test('合并后的名字随标签下发', () => {
  const g = buildGraph(turnsOf(3), [
    { laneId: 'A', turns: [0, 1, 2], parentLaneId: null, title: '甲 / 乙', mergedFrom: ['B'] },
    { laneId: 'B', turns: [], parentLaneId: null, title: '乙' },
  ])
  const label = g.labels.find(l => l.laneId === 'A')
  assert.equal(label.text, '甲 / 乙')
  assert.deepEqual(label.mergedFrom, ['B'])
})

test('nodes are in reading order', () => {
  const lanes = [
    { laneId: 'A', turns: [0, 2], parentLaneId: null, title: 'A' },
    { laneId: 'B', turns: [1, 3], parentLaneId: 'A', title: 'B' },
  ]
  const g = buildGraph(turnsOf(4), lanes)
  for (let i = 1; i < g.nodes.length; i += 1) {
    const prev = g.nodes[i - 1]
    const cur = g.nodes[i]
    assert.ok(prev.index < cur.index || (prev.index === cur.index && prev.col <= cur.col))
  }
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
