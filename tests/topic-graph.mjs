/**
 * 话题图关系测试。
 *
 * Run: node tests/topic-graph.mjs
 */

import { strict as assert } from 'node:assert'
import {
  RELATION,
  applyMerges,
  classifyBranches,
  findForks,
  findMerges,
  findRelated,
  findSharedTurns,
  findTrunk,
} from '../lib/topic-graph.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const lane = (id, turns, title = id, parent = null) => ({
  laneId: id, title, turns, parentLaneId: parent,
})

console.log('\ntopic-graph')

// ── 主线 ────────────────────────────────────────────────────────────
test('主线是第一个话题（不是最长的）', () => {
  const lanes = [lane('A', [1]), lane('B', [2, 3, 4, 5, 6, 7])]
  assert.equal(findTrunk(lanes), 'A', '第一个才是主线，哪怕它更短')
})

test('跳过没有轮次的话题', () => {
  const lanes = [lane('X', []), lane('A', [1])]
  assert.equal(findTrunk(lanes), 'A')
})

test('空数组返回 null', () => {
  assert.equal(findTrunk([]), null)
  assert.equal(findTrunk(null), null)
})

test('分类：一条 trunk 其余 branch', () => {
  const lanes = [lane('A', [1]), lane('B', [2]), lane('C', [3])]
  const m = classifyBranches(lanes)
  assert.equal(m.get('A'), 'trunk')
  assert.equal(m.get('B'), 'branch')
  assert.equal(m.get('C'), 'branch')
})

// ── 合并 ────────────────────────────────────────────────────────────
test('完全共享轮次的两条线合并', () => {
  // A 与 B 在 T3 之后完全重合
  const lanes = [lane('A', [1, 2, 3, 4, 5]), lane('B', [3, 4, 5])]
  const merges = findMerges(lanes)
  assert.equal(merges.length, 1)
  assert.equal(merges[0].keep, 'A')
  assert.equal(merges[0].absorb, 'B')
  assert.equal(merges[0].atTurn, 3)
})

test('只有部分重合不算合并（那是共享）', () => {
  // B 在 T4 之后还有独有轮次
  const lanes = [lane('A', [1, 2, 3]), lane('B', [3, 4, 5])]
  assert.equal(findMerges(lanes).length, 0, 'B 后续独有，说明没合并')
})

test('没有共享轮次不合并', () => {
  assert.equal(findMerges([lane('A', [1, 2]), lane('B', [3, 4])]).length, 0)
})

test('合并后名字两个都显示', () => {
  const lanes = [lane('A', [1, 2, 3], '甲'), lane('B', [3], '乙')]
  const merged = applyMerges(lanes, findMerges(lanes))
  assert.equal(merged.length, 1)
  assert.equal(merged[0].title, '甲 / 乙')
})

test('合并后轮次去重合并', () => {
  const lanes = [lane('A', [1, 2, 3]), lane('B', [3])]
  const merged = applyMerges(lanes, findMerges(lanes))
  assert.deepEqual(merged[0].turns, [1, 2, 3])
})

test('合并保留 mergedFrom 供追溯', () => {
  const lanes = [lane('A', [1, 2, 3]), lane('B', [3])]
  const merged = applyMerges(lanes, findMerges(lanes))
  assert.deepEqual(merged[0].mergedFrom, ['B'])
})

test('applyMerges 不修改入参', () => {
  const lanes = [lane('A', [1, 2, 3]), lane('B', [3])]
  const before = JSON.stringify(lanes)
  applyMerges(lanes, findMerges(lanes))
  assert.equal(JSON.stringify(lanes), before, '原数组不该被改')
})

test('空输入不崩', () => {
  assert.deepEqual(findMerges([]), [])
  assert.deepEqual(applyMerges([], []), [])
})

// ── 分支 ────────────────────────────────────────────────────────────
test('从上一轮所在话题斜出分支', () => {
  const lanes = [lane('A', [1, 2, 3]), lane('B', [4, 5])]
  const forks = findForks(lanes)
  assert.equal(forks.length, 1)
  assert.equal(forks[0].parent, 'A')
  assert.equal(forks[0].child, 'B')
  assert.equal(forks[0].atTurn, 3)
})

test('显式 parentLaneId 优先', () => {
  const lanes = [lane('A', [1]), lane('B', [2]), lane('C', [3], 'C', 'A')]
  const forks = findForks(lanes)
  const c = forks.find(f => f.child === 'C')
  assert.equal(c.parent, 'A', '应采信显式父级')
})

test('第一个话题没有父级', () => {
  const forks = findForks([lane('A', [1, 2])])
  assert.equal(forks.length, 0)
})

// ── 共享轮次（双点）────────────────────────────────────────────────
test('一轮属于两个话题时是共享', () => {
  const lanes = [lane('A', [1, 2, 3]), lane('B', [3, 4])]
  const shared = findSharedTurns(lanes)
  assert.ok(shared.has(3))
  assert.deepEqual(shared.get(3).sort(), ['A', 'B'])
})

test('独占轮次不在共享表里', () => {
  const lanes = [lane('A', [1, 2]), lane('B', [3])]
  const shared = findSharedTurns(lanes)
  assert.equal(shared.size, 0)
})

test('三轮属于同一话题也只算一条', () => {
  const lanes = [lane('A', [5])]
  assert.equal(findSharedTurns(lanes).size, 0)
})

// ── 相关性 ──────────────────────────────────────────────────────────
test('相似度高于阈值才连线', () => {
  const lanes = [lane('A', [1]), lane('B', [2])]
  const sim = () => 0.5
  const rel = findRelated(lanes, sim, 0.28)
  assert.equal(rel.length, 1)
  assert.equal(rel[0].a, 'A')
  assert.equal(rel[0].b, 'B')
})

test('低于阈值的忽略', () => {
  const lanes = [lane('A', [1]), lane('B', [2])]
  assert.equal(findRelated(lanes, () => 0.1, 0.28).length, 0)
})

test('按分数降序（界面可只取前几条）', () => {
  const lanes = [lane('A', [1]), lane('B', [2]), lane('C', [3])]
  const scores = { 'A|B': 0.4, 'A|C': 0.9, 'B|C': 0.3 }
  const sim = (a, b) => scores[a.laneId + '|' + b.laneId] ?? 0
  const rel = findRelated(lanes, sim, 0.28)
  assert.equal(rel[0].score, 0.9, '最高分在前')
})

test('每对只出现一次（不会重复反向）', () => {
  const lanes = [lane('A', [1]), lane('B', [2])]
  const rel = findRelated(lanes, () => 0.5, 0.28)
  assert.equal(rel.length, 1)
})

test('没有 similarityOf 时返回空', () => {
  assert.deepEqual(findRelated([lane('A', [1]), lane('B', [2])], null), [])
})

test('非法分数被忽略', () => {
  const lanes = [lane('A', [1]), lane('B', [2])]
  assert.equal(findRelated(lanes, () => NaN, 0.28).length, 0)
})

// ── 关系类型常量 ────────────────────────────────────────────────────
test('四种关系类型都定义了', () => {
  assert.equal(RELATION.fork, 'fork')
  assert.equal(RELATION.merge, 'merge')
  assert.equal(RELATION.related, 'related')
  assert.equal(RELATION.shared, 'shared')
})

// ── 组合场景 ────────────────────────────────────────────────────────
test('真实形态：主线分出支线，支线回来后合并', () => {
  // A 主线 1-2，B 从 3 分出，B 与 A 在 6 之后重合
  const lanes = [
    lane('A', [1, 2, 6, 7], '主线'),
    lane('B', [3, 4, 5, 6, 7], '支线'),
  ]
  const trunk = findTrunk(lanes)
  assert.equal(trunk, 'A')
  const forks = findForks(lanes)
  assert.equal(forks[0].parent, 'A')
  assert.equal(forks[0].child, 'B')
  const merges = findMerges(lanes)
  assert.equal(merges.length, 1, 'B 与 A 在 6 之后重合，应合并')
  assert.equal(merges[0].atTurn, 6)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
