/**
 * 三层分级的纯逻辑测试。
 *
 * 重点在"树必须自洽"：每个轮次恰好出现一次、层级不空、顺序不乱。
 * 一棵有重复或遗漏的树画出来必然错位，所以用断言而不是默默容忍。
 *
 * Run: node tests/hierarchy.mjs
 */

import { strict as assert } from 'node:assert'
import {
  STAGE_RANGE,
  WORKFLOWS_PER_STAGE,
  buildMergePrompt,
  buildTree,
  capGroups,
  groupByName,
  parseMerge,
  turnPathIndex,
  validateTree,
} from '../lib/hierarchy.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 造一组任务，覆盖 1..n 轮。 */
function makeTasks(sizes, prefix = 'T') {
  let turn = 1
  return sizes.map((n, i) => {
    const turns = []
    for (let k = 0; k < n; k += 1) turns.push(turn++)
    return { id: `${prefix}${i}`, name: `${prefix}${i}名字`, turns }
  })
}

console.log('\nhierarchy')

// ── 提示词 ──────────────────────────────────────────────────────────
test('归并提示词带上每项的内容摘要（这是分得准的关键）', () => {
  const items = [
    { id: 'a', name: '跳转定位', sample: '点击节点后应该落到用户输入那一行' },
    { id: 'b', name: '地图交互', sample: '滚轮缩放、拖拽平移、缩略条' },
  ]
  const { system, user } = buildMergePrompt(items, 'stage', '2-4 个')
  assert.ok(system.includes('阶段'))
  assert.ok(system.includes('摘要里写的是该条目实际在做什么'), '必须指示以摘要为准')
  assert.ok(user.includes('跳转定位'))
  assert.ok(user.includes('点击节点后应该落到用户输入那一行'), '摘要必须进提示词')
  assert.ok(user.includes('长度 2'))
})

test('摘要超长被截断，控制请求大小', () => {
  const items = [{ id: 'a', name: 'x', sample: 'y'.repeat(5000) }]
  const { user } = buildMergePrompt(items, 'workflow', '2-3 个')
  assert.ok(user.length < 500, `提示词过长：${user.length}`)
})

test('没有摘要时不产生空行噪声', () => {
  const { user } = buildMergePrompt([{ id: 'a', name: '甲', sample: '' }], 'stage', '2-4')
  assert.ok(!user.includes('摘要：'))
})

// ── 解析 ────────────────────────────────────────────────────────────
test('解析归并结果', () => {
  assert.deepEqual(parseMerge('["A","A","B"]', 3), ['A', 'A', 'B'])
})

test('容忍围栏与解释', () => {
  assert.deepEqual(parseMerge('结果：\n```\n["A","B"]\n```', 2), ['A', 'B'])
})

test('长度不符整批作废', () => {
  assert.equal(parseMerge('["A","B"]', 3), null)
  assert.equal(parseMerge('["A"]', 2), null)
})

test('非字符串或空值作废', () => {
  assert.equal(parseMerge('[1,2]', 2), null)
  assert.equal(parseMerge('["A",""]', 2), null)
})

// ── 归组 ────────────────────────────────────────────────────────────
test('同名归入同组并保持顺序', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const groups = groupByName(items, ['乙', '甲', '乙'])
  assert.equal(groups.length, 2)
  assert.equal(groups[0].name, '乙')
  assert.deepEqual(groups[0].ids, ['a', 'c'])
  assert.equal(groups[1].name, '甲')
})

test('组数超上限时最小的并入「其他」，条目不能丢', () => {
  const items = Array.from({ length: 8 }, (_, i) => ({ id: 'i' + i }))
  const names = items.map((_, i) => '组' + i)
  const capped = capGroups(groupByName(items, names), 4)
  assert.equal(capped.length, 4)
  const ids = capped.flatMap(g => g.ids).sort()
  assert.deepEqual(ids, items.map(i => i.id).sort(), '合并不能丢条目')
})

// ── 建树（核心）─────────────────────────────────────────────────────
test('三层：阶段 → 工作流 → 任务', () => {
  const tasks = makeTasks([2, 2, 2, 2])
  const workflows = ['甲流', '甲流', '乙流', '乙流']
  const stages = ['阶段一', '阶段二']

  const tree = buildTree(tasks, workflows, stages)
  assert.equal(tree.twoLevel, false)
  assert.equal(tree.stages.length, 2)
  assert.equal(tree.stages[0].workflows.length, 1)
  assert.equal(tree.stages[0].workflows[0].tasks.length, 2)
  assert.deepEqual(tree.stages[0].workflows[0].tasks[0].turns, [1, 2])
})

test('建出的树通过自检（无重复、无遗漏、层级不空）', () => {
  const tasks = makeTasks([3, 2, 4, 1])
  const workflows = ['甲', '甲', '乙', '丙']
  const stages = ['阶段一', '阶段一', '阶段二']
  const tree = buildTree(tasks, workflows, stages)
  assert.deepEqual(validateTree(tree), [], '树应当健康')
})

test('每个轮次恰好出现一次', () => {
  const tasks = makeTasks([2, 3, 1])
  const tree = buildTree(tasks, ['A', 'A', 'B'], ['S1', 'S2'])
  const seen = []
  for (const s of tree.stages) for (const w of s.workflows) for (const t of w.tasks) for (const turn of t.turns) seen.push(turn)
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6])
  assert.equal(new Set(seen).size, seen.length, '不能有重复')
})

test('工作流层缺失时退化为两层：任务直接当第二层', () => {
  const tasks = makeTasks([2, 2])
  // 两层模式的阶段名应与**任务**等长（阶段直接管任务）
  const tree = buildTree(tasks, null, ['阶段一', '阶段二'])
  assert.equal(tree.twoLevel, true)
  assert.equal(tree.stages.length, 2, '两个阶段各自管一个任务')
  assert.equal(tree.stages[0].workflows.length, 1)
  assert.deepEqual(tree.stages[0].workflows[0].tasks[0].turns, [1, 2])
  assert.deepEqual(validateTree(tree), [], '两层树也必须自洽')
})

test('两层且没有阶段名时，全部归入一个阶段', () => {
  const tasks = makeTasks([2, 2])
  const tree = buildTree(tasks, null, null)
  assert.equal(tree.twoLevel, true)
  assert.equal(tree.stages.length, 1)
  assert.equal(tree.stages[0].name, '全部')
  assert.equal(tree.stages[0].workflows.length, 2)
})

test('阶段层不可用时退成"全部"一个阶段，树不消失', () => {
  const tasks = makeTasks([2, 2])
  const tree = buildTree(tasks, ['甲', '乙'], null)
  assert.equal(tree.stages.length, 1)
  assert.equal(tree.stages[0].name, '全部')
  assert.equal(tree.stages[0].workflows.length, 2)
})

test('阶段层的长度必须与工作流数一致，否则作废该层', () => {
  const tasks = makeTasks([2, 2, 2])
  // 3 个任务归成 2 个工作流，但给了 3 个阶段名 -> 不一致
  const tree = buildTree(tasks, ['甲', '甲', '乙'], ['S1', 'S2', 'S3'])
  assert.equal(tree.stages.length, 1, '长度不符应退回单阶段')
  assert.equal(tree.stages[0].name, '全部')
})

test('轮次在每个层级的 turns 汇总都正确', () => {
  // 任务 0 占 1,2；任务 1 占 3；任务 2 占 4,5,6
  const tasks = makeTasks([2, 1, 3])
  const workflows = ['甲', '甲', '乙']
  const stages = ['S1', 'S2']
  const tree = buildTree(tasks, workflows, stages)
  // 甲（任务0+1）= 1,2,3 -> S1；乙（任务2）= 4,5,6 -> S2
  assert.deepEqual(tree.stages[0].turns, [1, 2, 3])
  assert.deepEqual(tree.stages[1].turns, [4, 5, 6])
})

test('空输入得到空树而不是抛异常', () => {
  assert.deepEqual(buildTree([], null, null), { stages: [], twoLevel: false })
  assert.deepEqual(buildTree(null, null, null), { stages: [], twoLevel: false })
})

test('阶段内部保持时间顺序', () => {
  const tasks = makeTasks([2, 2, 2])
  const tree = buildTree(tasks, ['甲', '乙', '甲'], ['S1', 'S1', 'S1'])
  const turns = tree.stages[0].workflows.flatMap(w => w.tasks.flatMap(t => t.turns))
  const sorted = [...turns].sort((a, b) => a - b)
  assert.deepEqual(tree.stages[0].turns, sorted, '阶段汇总必须升序')
})

// ── 路径索引 ────────────────────────────────────────────────────────
test('路径索引能回答"这一轮属于哪一级"', () => {
  const tasks = makeTasks([2, 2])
  const tree = buildTree(tasks, ['甲', '乙'], ['S1', 'S2'])
  const idx = turnPathIndex(tree.stages)
  assert.deepEqual(idx.get(1), { stage: 'S1', workflow: '甲', task: 'T0名字' })
  assert.deepEqual(idx.get(3), { stage: 'S2', workflow: '乙', task: 'T1名字' })
})

test('路径索引覆盖全部轮次', () => {
  const tasks = makeTasks([3, 3, 3])
  const tree = buildTree(tasks, ['甲', '甲', '乙'], ['S1', 'S2'])
  const idx = turnPathIndex(tree.stages)
  assert.equal(idx.size, 9)
})

// ── 自检能力本身 ────────────────────────────────────────────────────
test('自检能发现重复轮次', () => {
  const bad = {
    stages: [{
      name: 'S', turns: [1, 2],
      workflows: [{ name: 'W', tasks: [{ name: 'A', turns: [1] }, { name: 'B', turns: [1] }] }],
    }],
  }
  const problems = validateTree(bad)
  assert.ok(problems.some(p => p.includes('同时出现')), `应报告重复：${problems}`)
})

test('自检能发现空工作流', () => {
  const bad = { stages: [{ name: 'S', turns: [1], workflows: [{ name: 'W', tasks: [] }] }] }
  assert.ok(validateTree(bad).some(p => p.includes('没有任务')))
})

test('阶段下只有一个同名工作流时折平（不留冗余层）', () => {
  const tasks = makeTasks([2, 2])
  // 阶段名与工作流名相同——模型常犯这个错
  const tree = buildTree(tasks, ['面板设计', '面板设计'], ['面板设计'])
  assert.equal(tree.stages.length, 1)
  assert.equal(tree.stages[0].name, '面板设计')
  // 折平后仍只有一层工作流，但标记了 collapsed，客户端可据此不显示冗余层
  assert.equal(tree.stages[0].workflows.length, 1)
  assert.equal(tree.stages[0].workflows[0].collapsed, true)
  assert.equal(tree.stages[0].workflows[0].tasks.length, 2)
  assert.deepEqual(validateTree(tree), [], '折平后仍须自洽')
})

test('阶段下一个工作流但名字不同时，不折叠', () => {
  const tasks = makeTasks([2, 2])
  const tree = buildTree(tasks, ['渲染', '渲染'], ['地图开发'])
  assert.equal(tree.stages[0].workflows.length, 1)
  assert.equal(tree.stages[0].workflows[0].collapsed, undefined, '名字不同就不该折')
})

test('常量符合约定', () => {
  assert.deepEqual(STAGE_RANGE, [2, 4])
  assert.equal(WORKFLOWS_PER_STAGE, 3)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
