/**
 * 聚焦与详情的行为测试。
 *
 * 四个断言对应四个容易被做糊的点：
 *   1. 点任务要能算出目标行的位置（否则"自动滚动过去"无从谈起）
 *   2. 已经在视野内时不该乱滚
 *   3. 折叠键用名字而非索引（重新分析后不错位）
 *   4. 详情能回答"这一轮属于哪个阶段/工作流/任务"
 *
 * Run: node tests/focus.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { constrain, toScreen } from '../lib/viewport.js'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nfocus')

/** 模拟 focusLane 里"算出该不该滚、滚到哪"的那段纯逻辑。 */
function planScroll({ rowY, view, size, content }) {
  const screenY = rowY * view.scale + view.offsetY
  const margin = 60
  if (screenY >= margin && screenY <= size.h - margin) return { moved: false, view }
  const wantY = size.h * 0.25
  const next = { scale: view.scale, offsetY: wantY - rowY * view.scale, offsetX: view.offsetX }
  // constrain 期望 viewport 用 width/height 命名
  return { moved: true, view: constrain(next, content, { width: size.w, height: size.h }) }
}

const SIZE = { w: 1000, h: 600 }
/** constrain 需要 width/height 命名的视口。 */
const VIEWPORT = { width: SIZE.w, height: SIZE.h }

// ── 1. 自动滚动到目标行 ─────────────────────────────────────────────
test('目标行在视野外时会滚过去（核心）', () => {
  const content = { width: 2000, height: 2000 }
  const view = { scale: 1, offsetX: 0, offsetY: 0 }
  // 行在非常大的 y 上，初始不可见
  const rowY = 1400
  const before = toScreen(view, 0, rowY)
  assert.ok(before.y > SIZE.h, '前提：初始不可见')

  const plan = planScroll({ rowY, view, size: SIZE, content })
  assert.equal(plan.moved, true, '应当移动视图')

  const after = toScreen(plan.view, 0, rowY)
  assert.ok(after.y >= 0 && after.y <= SIZE.h, `滚动后行应在视野内，实际 y=${after.y}`)
})

test('目标行已在视野内时不动（避免每次点击画面都跳）', () => {
  const content = { width: 2000, height: 2000 }
  const view = { scale: 1, offsetX: 0, offsetY: -300 }
  const rowY = 400   // 屏幕 y = 100，在 60..540 内
  const plan = planScroll({ rowY, view, size: SIZE, content })
  assert.equal(plan.moved, false)
  assert.equal(plan.view.offsetY, view.offsetY, '不应改动视图')
})

test('滚过去之后位置仍在合法范围内（不拖飞）', () => {
  const content = { width: 2000, height: 3000 }
  const view = { scale: 1, offsetX: 0, offsetY: 0 }
  for (const rowY of [100, 500, 1500, 2800]) {
    const plan = planScroll({ rowY, view, size: SIZE, content })
    const checked = constrain(plan.view, content, VIEWPORT)
    assert.equal(plan.view.offsetX, checked.offsetX, `rowY=${rowY} X 越界`)
    assert.equal(plan.view.offsetY, checked.offsetY, `rowY=${rowY} Y 越界`)
  }
})

// ── 2. 折叠键用名字 ─────────────────────────────────────────────────
test('折叠键使用名称而非位置索引（重新分析后不错位）', () => {
  // 现在统一由 FOLD 模块生成键，键本身仍基于名字
  assert.ok(src.includes('FOLD.stageKey(stage.name)'), '阶段折叠键应基于名字')
  assert.ok(src.includes('FOLD.workflowKey(stage.name, wf.name)'), '工作流折叠键应基于名字')
  assert.ok(!src.includes("var stageKey = 's' + si"), '不应再使用位置索引')
  // 键的生成规则本身在 tree-fold.mjs 里被单独测过
})

// ── 3. 折叠状态持久化 ───────────────────────────────────────────────
test('折叠状态写入 sessionStorage 并按会话分开', () => {
  assert.ok(src.includes('dsh-topic-map:fold:'), '应有按会话分开的存储键')
  assert.ok(src.includes('sessionStorage.setItem'), '应写入 sessionStorage')
  assert.ok(src.includes('sessionStorage.getItem'), '应读取 sessionStorage')
})

// ── 4. 详情里的层级路径 ─────────────────────────────────────────────
test('详情能显示所在阶段/工作流/任务路径', () => {
  assert.ok(src.includes('stageName') && src.includes('workflowName'), '详情应读取层级字段')
  assert.ok(src.includes("dsh_tm_path"), '应渲染路径行')
  assert.ok(src.includes("' › '"), '路径用 › 连接')
})

test('详情带跳转按钮', () => {
  assert.ok(src.includes('跳转到对话'), '必须有跳转入口')
  assert.ok(src.includes('jumpTo'), '跳转应调用 jumpTo')
})

// ── 5. 聚焦时的淡化 ─────────────────────────────────────────────────
test('聚焦时其余泳道的节点、标签、连线都淡化', () => {
  // 三处 dim 判断都在
  const dimCount = (src.match(/highlightLane !== null/g) || []).length
  assert.ok(dimCount >= 3, `节点/标签/连线都应参与淡化，实际 ${dimCount} 处`)
})

test('连线透传 laneId，淡化才能按泳道判断', () => {
  assert.ok(src.includes('laneId: e.laneId'), '布局应把 laneId 传给连线')
})

// ── 6. 左栏状态点 ───────────────────────────────────────────────────
test('左栏任务带状态胶囊与轮次数（状态来自 PM 推导，可手改）', () => {
  // 状态胶囊：显示推导/标注的状态，可点击切换
  assert.ok(src.includes('dsh_tm_state'), '应有状态胶囊')
  assert.ok(src.includes('dsh_tm_statedot'), '胶囊里应有状态点')
  assert.ok(src.includes('pmState.detailOf'), '状态应来自 PM 推导')
  assert.ok(src.includes('setTaskState'), '应可手动标注')
  assert.ok(src.includes('dsh_tm_trackn'), '应有轮次数')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
