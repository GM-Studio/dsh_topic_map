/**
 * 会话归类测试。
 *
 * 数据依据是实测的：某工作区 108 个会话里 86 个是子代理单轮会话
 * （首轮提问以 `[dsh-mnemon:delegated review]` 开头）。识别这些是
 * 让列表可用的前提。
 *
 * Run: node tests/session-category.mjs
 */

import { strict as assert } from 'node:assert'
import {
  CATEGORY_RANGE,
  SESSION_LIMIT,
  SUBCATEGORY_LIMIT,
  buildCategoryPrompt,
  buildCategoryTree,
  fallbackTree,
  filterTree,
  looksAutomated,
  parseCategories,
  prepareSessions,
} from '../lib/session-category.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const REAL = [
  { sessionId: 's1', title: '会话归类检索回滚分析', firstPrompt: '1. 当前会话 当前轮次 属于哪个归类', turns: 4 },
  { sessionId: 's2', title: '话题地图状态栏', firstPrompt: '目前有关任务的状态信息和进度条展示', turns: 12 },
  { sessionId: 's3', title: '插件调研', firstPrompt: '请问 现在harness是什么', turns: 4 },
]
const ROBOT = [
  { sessionId: 'r1', title: '[dsh-mnemon:delegated review]', firstPrompt: '[dsh-mnemon:delegated review]\nBounded completed check', turns: 1 },
  { sessionId: 'r2', title: 'delegated review', firstPrompt: '[dsh-mnemon:delegated review]', turns: 1 },
]

console.log('\nsession-category')

// ── 自动会话识别 ────────────────────────────────────────────────────
test('识别 dsh-mnemon 子代理会话', () => {
  assert.equal(looksAutomated(ROBOT[0]), true)
  assert.equal(looksAutomated(ROBOT[1]), true)
})

test('真实对话不被误判', () => {
  for (const s of REAL) assert.equal(looksAutomated(s), false, s.title)
})

test('识别审批策略变更这类系统消息', () => {
  assert.equal(looksAutomated({ title: '', firstPrompt: 'The approval policy changed from "ask" to "never"' }), true)
})

test('空会话不判为自动', () => {
  assert.equal(looksAutomated({ title: '', firstPrompt: '' }), false)
  assert.equal(looksAutomated(null), false)
})

// ── 准备数据 ────────────────────────────────────────────────────────
test('准备时带上 id / 名称 / 摘要 / 轮次 / 自动标记', () => {
  const items = prepareSessions([...REAL, ...ROBOT])
  assert.equal(items.length, 5)
  assert.equal(items[0].id, 's1')
  assert.equal(items[0].automated, false)
  assert.equal(items[3].automated, true)
})

test('超长标题与摘要被截断', () => {
  const items = prepareSessions([{ sessionId: 'x', title: 'x'.repeat(300), firstPrompt: 'y'.repeat(300), turns: 1 }])
  assert.ok(items[0].name.length <= 60)
  assert.ok(items[0].sample.length <= 90)
})

test('会话数有上限', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ sessionId: 's' + i, title: 't' + i, firstPrompt: '', turns: 1 }))
  assert.equal(prepareSessions(many).length, SESSION_LIMIT)
})

// ── 提示词 ──────────────────────────────────────────────────────────
test('提示词要求两层结构且说明数量区间', () => {
  const { system, user } = buildCategoryPrompt(prepareSessions(REAL))
  assert.ok(system.includes(String(CATEGORY_RANGE[0])))
  assert.ok(system.includes(String(SUBCATEGORY_LIMIT)))
  assert.ok(system.includes('category'))
  assert.ok(system.includes('sub'))
  assert.ok(user.includes('长度 3'))
})

test('提示词标出自动会话（让模型能单独归组）', () => {
  const { user } = buildCategoryPrompt(prepareSessions([...REAL, ...ROBOT]))
  assert.ok(user.includes('自动'), '自动会话应带标记')
})

test('提示词带上标题与首轮内容', () => {
  const { user } = buildCategoryPrompt(prepareSessions(REAL))
  assert.ok(user.includes('会话归类检索回滚分析'))
  assert.ok(user.includes('当前轮次 属于哪个归类'))
})

// ── 解析 ────────────────────────────────────────────────────────────
test('解析两层结果', () => {
  const got = parseCategories('[{"category":"插件","sub":"地图"},{"category":"插件","sub":"归档"}]', 2)
  assert.equal(got.length, 2)
  assert.equal(got[0].category, '插件')
  assert.equal(got[1].sub, '归档')
})

test('长度不符整批作废', () => {
  assert.equal(parseCategories('[{"category":"a","sub":"b"}]', 2), null)
})

test('缺字段或空值作废', () => {
  assert.equal(parseCategories('[{"category":"a"}]', 1), null)
  assert.equal(parseCategories('[{"category":"","sub":"b"}]', 1), null)
  assert.equal(parseCategories('["a"]', 1), null)
})

test('容忍代码围栏', () => {
  const text = '```json\n[{"category":"x","sub":"y"}]\n```'
  assert.equal(parseCategories(text, 1)[0].category, 'x')
})

test('无法解析返回 null', () => {
  assert.equal(parseCategories('不知道', 1), null)
})

// ── 建树 ────────────────────────────────────────────────────────────
test('按大类 → 子类建树', () => {
  const items = prepareSessions(REAL)
  const labels = [
    { category: '插件开发', sub: '地图' },
    { category: '插件开发', sub: '地图' },
    { category: '技术调研', sub: '概念' },
  ]
  const tree = buildCategoryTree(items, labels)
  assert.equal(tree.length, 2)
  assert.equal(tree[0].name, '插件开发')
  assert.equal(tree[0].count, 2)
  assert.equal(tree[0].subcategories.length, 1)
  assert.equal(tree[0].subcategories[0].sessions.length, 2)
})

test('大类顺序按首次出现（与时间线一致）', () => {
  const items = prepareSessions(REAL)
  const labels = [
    { category: '乙类', sub: 'x' },
    { category: '甲类', sub: 'y' },
    { category: '乙类', sub: 'z' },
  ]
  const tree = buildCategoryTree(items, labels)
  assert.equal(tree[0].name, '乙类', '先出现的在前')
})

test('长度不匹配返回空（不猜）', () => {
  assert.deepEqual(buildCategoryTree(prepareSessions(REAL), [{ category: 'a', sub: 'b' }]), [])
})

test('树里保留会话的轮次与自动标记', () => {
  const items = prepareSessions([...REAL, ...ROBOT])
  const labels = [
    { category: '开发', sub: 'a' }, { category: '开发', sub: 'a' }, { category: '调研', sub: 'b' },
    { category: '自动化任务', sub: '子代理' }, { category: '自动化任务', sub: '子代理' },
  ]
  const tree = buildCategoryTree(items, labels)
  const auto = tree.find(c => c.name === '自动化任务')
  assert.equal(auto.subcategories[0].sessions[0].automated, true)
  assert.equal(auto.subcategories[0].sessions[0].turns, 1)
})

// ── 兜底 ────────────────────────────────────────────────────────────
test('模型不可用时按自动/真实粗分', () => {
  const items = prepareSessions([...REAL, ...ROBOT])
  const tree = fallbackTree(items)
  const names = tree.map(c => c.name)
  assert.ok(names.includes('自动化任务'))
  const auto = tree.find(c => c.name === '自动化任务')
  assert.equal(auto.count, 2)
})

test('没有自动会话时兜底树只有真实对话', () => {
  const tree = fallbackTree(prepareSessions(REAL))
  assert.equal(tree.length, 1)
  assert.equal(tree[0].count, 3)
})

test('空输入兜底为空树', () => {
  assert.deepEqual(fallbackTree([]), [])
  assert.deepEqual(fallbackTree(null), [])
})

// ── 过滤 ────────────────────────────────────────────────────────────
test('按大类名过滤', () => {
  const items = prepareSessions(REAL)
  const labels = [
    { category: '插件开发', sub: '地图' },
    { category: '插件开发', sub: '地图' },
    { category: '技术调研', sub: '概念' },
  ]
  const tree = buildCategoryTree(items, labels)
  const hit = filterTree(tree, '调研')
  assert.equal(hit.length, 1)
  assert.equal(hit[0].name, '技术调研')
})

test('按会话标题过滤', () => {
  const items = prepareSessions(REAL)
  const labels = [
    { category: 'A', sub: 'x' }, { category: 'B', sub: 'y' }, { category: 'C', sub: 'z' },
  ]
  const tree = buildCategoryTree(items, labels)
  const hit = filterTree(tree, '状态栏')
  assert.equal(hit.length, 1)
  assert.equal(hit[0].count, 1)
})

test('空关键字原样返回', () => {
  const tree = [{ name: 'A', count: 1, subcategories: [] }]
  assert.equal(filterTree(tree, ''), tree)
})

test('全不命中返回空数组', () => {
  const items = prepareSessions(REAL)
  const labels = [{ category: 'A', sub: 'x' }, { category: 'B', sub: 'y' }, { category: 'C', sub: 'z' }]
  assert.deepEqual(filterTree(buildCategoryTree(items, labels), 'zzzzz'), [])
})

// ── 常量 ────────────────────────────────────────────────────────────
test('数量常量合理', () => {
  assert.deepEqual(CATEGORY_RANGE, [3, 6])
  assert.equal(SUBCATEGORY_LIMIT, 4)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
