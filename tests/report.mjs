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
import {
  laneWorkload,
  riskReport,
  toCsv,
  toMarkdown,
  workloadReport,
} from '../lib/report.js'

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

// ── 工作量 ──────────────────────────────────────────────────────────
test('单任务工作量累加正确', () => {
  const w = laneWorkload(LANES[0], factOf)
  assert.equal(w.turns, 2)
  assert.equal(w.toolCalls, 5 + 3)
  assert.equal(w.steps, 3 + 2)
  assert.equal(w.durationMs, 1500)
  assert.equal(w.tokens, 30 + 2)
  assert.ok(Math.abs(w.cost - 0.15) < 1e-9)
})

test('工作量汇总', () => {
  const { rows, totals } = workloadReport(LANES, factOf)
  assert.equal(rows.length, 2)
  assert.equal(totals.turns, 3)
  assert.equal(totals.toolCalls, 5 + 8 + 3)
})

test('工作量按工具调用降序（最能看出哪件事费劲）', () => {
  const { rows } = workloadReport(LANES, factOf)
  assert.ok(rows[0].toolCalls >= rows[1].toolCalls)
})

test('空泳道工作量全 0 不崩', () => {
  const w = laneWorkload({ laneId: 'X', title: 'x', turns: [] }, factOf)
  assert.equal(w.turns, 0)
  assert.equal(w.toolCalls, 0)
})

// ── 风险 ────────────────────────────────────────────────────────────
test('blocked 状态进入风险清单', () => {
  const risks = riskReport(LANES, factOf, id => ({
    state: id === 'L1' ? 'blocked' : 'done',
    basis: '卡住了',
  }))
  assert.ok(risks.some(r => r.kind === 'blocked' && r.level === 'high'))
})

test('有报错轮次的任务进入风险清单', () => {
  const risks = riskReport(LANES, factOf, () => ({ state: 'active', basis: '' }))
  // L2 的 T2 是 error
  assert.ok(risks.some(r => r.kind === 'error-turn'))
})

test('反复返工进入风险清单（中等）', () => {
  const facts = {
    1: { turn: 1, endReason: 'completed' }, 2: { turn: 2, endReason: 'completed' },
    5: { turn: 5, endReason: 'completed' }, 6: { turn: 6, endReason: 'completed' },
  }
  const lanes = [{ laneId: 'R', title: '返工', stageName: 'S', turns: [1, 2, 5, 6] }]
  const risks = riskReport(lanes, t => facts[t], () => ({ state: 'done', basis: '' }))
  const rework = risks.find(r => r.kind === 'rework')
  assert.ok(rework !== undefined, '应识别为返工')
  assert.equal(rework.level, 'medium')
})

test('连续多轮且调用量大也算返工（不只看轮次是否连续）', () => {
  // 实测场景：跳转定位是 [11,12,13,14,15] 连续五轮，工具调用 152 次。
  // 只看"轮次是否连续"会漏掉这种——它明明是反复试。
  const facts = {}
  for (const t of [11, 12, 13, 14, 15]) {
    facts[t] = { turn: t, endReason: 'completed', toolCalls: 30 }
  }
  const lanes = [{ laneId: 'T', title: '跳转定位', stageName: 'S', turns: [11, 12, 13, 14, 15] }]
  const risks = riskReport(lanes, t => facts[t], () => ({ state: 'done', basis: '' }))
  const rework = risks.find(r => r.kind === 'rework')
  assert.ok(rework !== undefined, '连续五轮 + 150 次调用应识别为返工')
  assert.ok(rework.reason.includes('150'), `原因应带上调用量：${rework.reason}`)
})

test('连续多轮但调用量小时不算返工', () => {
  const facts = {}
  for (const t of [1, 2, 3, 4]) {
    facts[t] = { turn: t, endReason: 'completed', toolCalls: 2 }
  }
  const lanes = [{ laneId: 'Q', title: '安静', stageName: 'S', turns: [1, 2, 3, 4] }]
  const risks = riskReport(lanes, t => facts[t], () => ({ state: 'done', basis: '' }))
  assert.equal(risks.filter(r => r.kind === 'rework').length, 0, '调用量小不该判返工')
})

test('健康的任务不产生风险', () => {
  const facts = { 1: { turn: 1, endReason: 'completed' } }
  const lanes = [{ laneId: 'H', title: '健康', stageName: 'S', turns: [1] }]
  assert.deepEqual(riskReport(lanes, t => facts[t], () => ({ state: 'done', basis: '' })), [])
})

test('风险按高优先排序', () => {
  const risks = riskReport(LANES, factOf, id => ({
    state: id === 'L1' ? 'blocked' : 'done', basis: '',
  }))
  if (risks.length >= 2) assert.equal(risks[0].level, 'high')
})

// ── 导出 CSV ────────────────────────────────────────────────────────
test('CSV 有表头与行', () => {
  const csv = toCsv([{ title: '甲', stage: 'S', state: 'done', turns: 2, toolCalls: 5, durationMs: 1500, cost: 0.1 }])
  const lines = csv.split('\n')
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('任务'))
  assert.ok(lines[1].includes('甲'))
})

test('CSV 转义逗号与引号', () => {
  const csv = toCsv([{ title: 'a,b', stage: '"x"', state: 'done', turns: 1, toolCalls: 0, durationMs: 0, cost: 0 }])
  assert.ok(csv.includes('"a,b"'), '含逗号要加引号')
  assert.ok(csv.includes('""x""'), '内部引号要转义')
})

test('空行给空 CSV（只有表头）', () => {
  assert.equal(toCsv([]).split('\n').length, 1)
})

// ── 导出 Markdown ───────────────────────────────────────────────────
test('Markdown 含总览、结构、风险、交付物、工作量', () => {
  const md = toMarkdown({
    title: '测试会话',
    stages: STAGES,
    detailOf: t => ({ state: t === 2 ? 'blocked' : 'done' }),
    risks: riskReport(LANES, factOf, t => ({ state: 'done', basis: '' })),
    deliverables: groupByStage(STAGES, LANES, factOf),
    workload: workloadReport(LANES, factOf),
    totals: { turns: 3, toolCalls: 16, durationMs: 3500, cost: 0.35 },
    stateLabel: s => ({ done: '已完成', active: '进行中', blocked: '阻塞', todo: '待办' })[s],
  })
  assert.ok(md.includes('# 测试会话'))
  assert.ok(md.includes('## 总览'))
  assert.ok(md.includes('## 结构与状态'))
  assert.ok(md.includes('## 风险'))
  assert.ok(md.includes('## 交付物'))
  assert.ok(md.includes('## 工作量'))
  assert.ok(md.includes('阶段A'))
})

test('没有风险与交付物时对应章节不出现', () => {
  const md = toMarkdown({ title: 'T', stages: [], risks: [], deliverables: [] })
  assert.ok(!md.includes('## 风险'))
  assert.ok(!md.includes('## 交付物'))
})

test('Markdown 空输入不崩', () => {
  const md = toMarkdown({})
  assert.ok(typeof md === 'string' && md.length > 0)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
