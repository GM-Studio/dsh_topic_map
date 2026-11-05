/**
 * 折叠与联动的测试。
 *
 * Run: node tests/tree-fold.mjs
 */

import { strict as assert } from 'node:assert'
import {
  collapseAll,
  collapseToStages,
  defaultFold,
  expandAll,
  foldForFilter,
  foldMode,
  foldToPath,
  isStageOpen,
  isWorkflowOpen,
  pathOfTurn,
  stageKey,
  workflowKey,
} from '../lib/tree-fold.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const STAGES = [
  {
    name: '面板设计',
    workflows: [
      { name: '形态', tasks: [{ name: '做树', turns: [1, 2] }, { name: '做图', turns: [3] }] },
      { name: '交互', tasks: [{ name: '缩放', turns: [4] }] },
    ],
  },
  {
    name: '缺陷修复',
    workflows: [
      { name: '跳转', tasks: [{ name: '定位', turns: [5, 6, 7] }] },
    ],
  },
]

console.log('\ntree-fold')

// ── 键 ──────────────────────────────────────────────────────────────
test('键用名字而不是索引', () => {
  assert.equal(stageKey('面板设计'), 'S:面板设计')
  assert.equal(workflowKey('面板设计', '形态'), 'S:面板设计:W:形态')
})

// ── 路径查找 ────────────────────────────────────────────────────────
test('能查到轮次所在的完整路径', () => {
  assert.deepEqual(pathOfTurn(STAGES, 5), { stage: '缺陷修复', workflow: '跳转', task: '定位' })
})

test('多轮任务里任意一轮都能查到', () => {
  assert.deepEqual(pathOfTurn(STAGES, 1), { stage: '面板设计', workflow: '形态', task: '做树' })
  assert.deepEqual(pathOfTurn(STAGES, 2), { stage: '面板设计', workflow: '形态', task: '做树' })
})

test('查不到返回 null', () => {
  assert.equal(pathOfTurn(STAGES, 999), null)
  assert.equal(pathOfTurn(null, 1), null)
})

// ── 默认状态 ────────────────────────────────────────────────────────
test('默认全部展开（阶段与工作流都不折叠）', () => {
  const f = defaultFold()
  for (const s of STAGES) {
    assert.equal(isStageOpen(f, s.name), true, `${s.name} 应展开`)
    for (const w of s.workflows) {
      assert.equal(isWorkflowOpen(f, s.name, w.name), true, `${w.name} 应展开`)
    }
  }
})

// ── 三个按钮 ────────────────────────────────────────────────────────
test('全部展开清空折叠状态', () => {
  assert.deepEqual(expandAll(), {})
})

test('全部折叠收起所有阶段', () => {
  const f = collapseAll(STAGES)
  for (const s of STAGES) assert.equal(isStageOpen(f, s.name), false)
})

test('只看阶段：阶段展开、工作流收起', () => {
  const f = collapseToStages(STAGES)
  for (const s of STAGES) {
    assert.equal(isStageOpen(f, s.name), true, `${s.name} 应展开`)
    for (const w of s.workflows) {
      assert.equal(isWorkflowOpen(f, s.name, w.name), false, `${w.name} 应收起`)
    }
  }
})

test('foldMode 能识别三种模式', () => {
  assert.equal(foldMode(STAGES, expandAll()), 'all')
  assert.equal(foldMode(STAGES, collapseAll(STAGES)), 'none')
  assert.equal(foldMode(STAGES, collapseToStages(STAGES)), 'stages')
})

test('部分折叠时 foldMode 返回 mixed', () => {
  const f = { [stageKey('面板设计')]: true }
  assert.equal(foldMode(STAGES, f), 'mixed')
})

// ── 只展开目标路径（点节点时用）────────────────────────────────────
test('点节点时只展开它所在阶段，其他阶段收起', () => {
  const path = pathOfTurn(STAGES, 5)   // 缺陷修复 / 跳转 / 定位
  const f = foldToPath(STAGES, path)
  assert.equal(isStageOpen(f, '缺陷修复'), true, '目标阶段应展开')
  assert.equal(isStageOpen(f, '面板设计'), false, '其他阶段应收起')
})

test('目标阶段内只展开所在工作流，其他工作流收起', () => {
  const path = pathOfTurn(STAGES, 3)   // 面板设计 / 形态 / 做图
  const f = foldToPath(STAGES, path)
  assert.equal(isStageOpen(f, '面板设计'), true)
  assert.equal(isWorkflowOpen(f, '面板设计', '形态'), true, '命中工作流应展开')
  assert.equal(isWorkflowOpen(f, '面板设计', '交互'), false, '其他工作流应收起')
})

test('foldToPath 对 null 安全', () => {
  assert.deepEqual(foldToPath(STAGES, null), {})
})

// ── 筛选联动 ────────────────────────────────────────────────────────
test('筛选后只展开含可见任务的阶段', () => {
  const visible = new Set(['定位'])
  const f = foldForFilter(STAGES, visible)
  assert.equal(isStageOpen(f, '缺陷修复'), true, '命中阶段应展开')
  assert.equal(isStageOpen(f, '面板设计'), false, '无命中阶段应收起')
})

test('筛选后含可见任务的阶段里，空工作流收起', () => {
  const visible = new Set(['缩放'])   // 只在「交互」工作流里
  const f = foldForFilter(STAGES, visible)
  assert.equal(isStageOpen(f, '面板设计'), true)
  assert.equal(isWorkflowOpen(f, '面板设计', '交互'), true)
  assert.equal(isWorkflowOpen(f, '面板设计', '形态'), false, '无命中的工作流应收起')
})

test('筛选为空集时全部收起', () => {
  const f = foldForFilter(STAGES, new Set())
  for (const s of STAGES) assert.equal(isStageOpen(f, s.name), false)
})

test('自定义任务标识也支持', () => {
  const custom = [{
    name: '甲', workflows: [{ name: '流', tasks: [{ name: '任务A', id: 'X1', turns: [1] }] }],
  }]
  const f = foldForFilter(custom, new Set(['X1']), t => t.id)
  assert.equal(isStageOpen(f, '甲'), true)
})

// ── 展开判断的边界 ──────────────────────────────────────────────────
test('阶段收起时，内部工作流一律视为收起', () => {
  const f = { [stageKey('面板设计')]: true }
  assert.equal(isWorkflowOpen(f, '面板设计', '形态'), false, '父收起则子不可见')
})

test('collapsed 为 null 时按全展开处理', () => {
  assert.equal(isStageOpen(null, '甲'), true)
  assert.equal(isWorkflowOpen(null, '甲', '乙'), true)
})

test('空阶段树不崩', () => {
  assert.equal(foldMode([], {}), 'all')
  assert.deepEqual(collapseAll([]), {})
  assert.deepEqual(foldForFilter([], new Set(['x'])), {})
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
