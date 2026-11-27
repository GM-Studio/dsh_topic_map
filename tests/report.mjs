/**
 * 交付物与报告的测试。
 *
 * Run: node tests/report.mjs
 */

import { strict as assert } from 'node:assert'
import {
  PRODUCING_TOOLS,
  baseName,
  collectDeliverables,
  groupByStage,
  isDeliverablePath,
  shortPath,
} from '../lib/deliverables.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const FACTS = {
  1: { turn: 1, tools: ['write'], files: ['E:\\proj\\docs\\设计.md'], toolCalls: 5, steps: 3, durationMs: 1000, usage: { input: 10, output: 20 }, cost: 0.1, endReason: 'completed' },
  2: { turn: 2, tools: ['edit'], files: ['E:\\proj\\docs\\设计.md', 'E:\\proj\\lib\\a.js'], toolCalls: 8, steps: 4, durationMs: 2000, usage: { input: 5, output: 5 }, cost: 0.2, endReason: 'error' },
  3: { turn: 3, tools: ['ops_read_files'], files: ['C:\\Users\\Administrator\\AppData\\Local\\Temp\\dsh-spill-x\\a.txt'], toolCalls: 3, steps: 2, durationMs: 500, usage: { input: 1, output: 1 }, cost: 0.05, endReason: 'completed' },
}
const factOf = t => FACTS[t]

const LANES = [
  { laneId: 'L1', title: '设计', stageName: '阶段A', turns: [1, 3] },
  { laneId: 'L2', title: '实现', stageName: '阶段A', turns: [2] },
]
const STAGES = [
  { name: '阶段A', workflows: [{ name: '流', tasks: [{ name: '设计', turns: [1, 3] }, { name: '实现', turns: [2] }] }] },
]

console.log('\nreport')

// ── 交付物判定 ──────────────────────────────────────────────────────
test('真实项目文件被接受', () => {
  for (const p of ['E:\\proj\\docs\\设计.md', '/home/x/a.js', 'a/b/c.json', 'D:\\x\\y.yml']) {
    assert.equal(isDeliverablePath(p), true, `${p} 应被接受`)
  }
})

test('临时目录与 node_modules 被拒绝', () => {
  for (const p of [
    'C:\\Users\\A\\AppData\\Local\\Temp\\dsh-spill-x\\a.txt',
    '/proj/node_modules/x/a.js',
    '/proj/dist/a.js',
    '/proj/.git/config',
  ]) {
    assert.equal(isDeliverablePath(p), false, `${p} 应被拒绝`)
  }
})

test('碎片被拒绝', () => {
  for (const p of ['v0.2', 'end.time', 'https://x.com/a.js', '123']) {
    assert.equal(isDeliverablePath(p), false, `${p} 应被拒绝`)
  }
})

test('无扩展名被拒绝', () => {
  assert.equal(isDeliverablePath('/a/b/c'), false)
  assert.equal(isDeliverablePath(''), false)
  assert.equal(isDeliverablePath(null), false)
})

test('项目配置文件被拒绝（避免一堆 package.json 噪音）', () => {
  for (const p of [
    '/proj/package.json',
    '/proj/pnpm-lock.yaml',
    '/proj/tsconfig.json',
    '/proj/.gitignore',
  ]) {
    assert.equal(isDeliverablePath(p), false, `${p} 应被拒绝`)
  }
})

test('shortPath 取两段可辨识尾部', () => {
  assert.equal(shortPath('C:\\x\\dsh-topic-map\\lib\\client.js'), 'lib/client.js')
  assert.equal(shortPath('/a/b/c.md'), 'b/c.md')
  assert.equal(shortPath('c.js'), 'c.js')
})

test('同名文件按文件名归一（同一插件的 client.js 就是同一个）', () => {
  // 实测：同一文件在不同工具调用里会写成 client.js / lib/client.js /
  // E:\...\lib\client.js，按短路径去重仍会留下多条。按文件名归一是最稳的。
  const facts = {
    1: { turn: 1, tools: ['write'], files: ['/p/a/client.js'] },
    2: { turn: 2, tools: ['edit'], files: ['/p/b/client.js'] },
  }
  const items = collectDeliverables([1, 2], t => facts[t])
  assert.equal(items.length, 1, '同名文件应合并成一条')
  assert.equal(items[0].name, 'client.js')
  assert.deepEqual(items[0].turns, [1, 2], '应记下两轮都动过')
})

test('保留更具体的路径作为来源', () => {
  const facts = {
    1: { turn: 1, tools: ['write'], files: ['client.js'] },
    2: { turn: 2, tools: ['edit'], files: ['/deep/dir/client.js'] },
  }
  const items = collectDeliverables([1, 2], t => facts[t])
  assert.ok(items[0].path.includes('deep'), '应保留更完整的路径')
})

test('baseName 取文件名', () => {
  assert.equal(baseName('E:\\proj\\docs\\设计.md'), '设计.md')
  assert.equal(baseName('/a/b/c.js'), 'c.js')
  assert.equal(baseName('c.js'), 'c.js')
})

// ── 抽取 ────────────────────────────────────────────────────────────
test('只从产出的轮次里抽', () => {
  const items = collectDeliverables([1, 3], factOf)
  // T3 是 read，不该贡献文件
  const names = items.map(i => i.name)
  assert.ok(names.includes('设计.md'))
  assert.ok(!names.includes('a.txt'), '只读的轮次不该产生交付物')
})

test('同一文件多轮修改只算一条，但记下轮次', () => {
  const items = collectDeliverables([1, 2], factOf)
  const design = items.find(i => i.name === '设计.md')
  assert.ok(design !== undefined)
  assert.deepEqual(design.turns, [1, 2], '应记下两轮都改过')
})

test('多个文件都列出', () => {
  // T2 同时改了两个文件（设计.md 与 a.js），都应列出
  const items = collectDeliverables([2], factOf)
  assert.equal(items.length, 2, '两个文件都该列出')
  const names = items.map(i => i.name).sort()
  assert.deepEqual(names, ['a.js', '设计.md'])
})

test('limit 生效', () => {
  const many = {}
  for (let i = 1; i <= 20; i += 1) {
    many[i] = { turn: i, tools: ['write'], files: [`/p/f${i}.md`] }
  }
  const items = collectDeliverables(Object.keys(many).map(Number), t => many[t], { limit: 5 })
  assert.equal(items.length, 5)
})

test('空输入不崩', () => {
  assert.deepEqual(collectDeliverables([], factOf), [])
  assert.deepEqual(collectDeliverables(null, factOf), [])
})

test('产出的工具名清单合理', () => {
  assert.ok(PRODUCING_TOOLS.includes('write'))
  assert.ok(PRODUCING_TOOLS.includes('edit'))
  assert.ok(!PRODUCING_TOOLS.includes('ops_read_files'), '读文件不该算产出')
})

// ── 按阶段分组 ──────────────────────────────────────────────────────
test('交付物按阶段归组', () => {
  const groups = groupByStage(STAGES, LANES, factOf)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].stage, '阶段A')
  assert.ok(groups[0].items.length >= 1)
})

test('同一文件不在两个阶段重复出现', () => {
  const lanes = [
    { laneId: 'A', title: 'a', stageName: 'S1', turns: [1] },
    { laneId: 'B', title: 'b', stageName: 'S2', turns: [2] },
  ]
  const stages = [
    { name: 'S1', workflows: [{ name: 'w', tasks: [{ name: 'a', turns: [1] }] }] },
    { name: 'S2', workflows: [{ name: 'w', tasks: [{ name: 'b', turns: [2] }] }] },
  ]
  const groups = groupByStage(stages, lanes, factOf)
  const all = groups.flatMap(g => g.items.map(i => i.name))
  assert.equal(new Set(all).size, all.length, '同一文件只出现一次')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
