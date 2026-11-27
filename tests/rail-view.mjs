/**
 * 历史轨视图模型测试（V-12）。
 *
 * 纯函数：不读 DOM、不读系统时钟。所有「当前轮 / 时间」都由参数传入。
 *
 * 覆盖三件容易出错的事：
 *   1. data-index 是合并列表的绝对下标，不是轮号（不能 +1）；
 *   2. 轮号解析失败时要按顺序编号降级，而不是白屏；
 *   3. 自检失配必须返回「给界面看」的原因，且不得把「轮号不准」当成失配。
 *
 * Run: node tests/rail-view.mjs
 */

import { strict as assert } from 'node:assert'
import {
  TIER_WIDTHS,
  activeIndexOf,
  anchorFor,
  rowsOf,
  segmentGroupsOf,
  selfCheck,
  snapWidth,
  tierOf,
  turnOfLabel,
} from '../lib/rail-view.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nrail-view')

// ── data-index → 行 ─────────────────────────────────────────────────
test('rowsOf：index 是 data-index 绝对下标，不因为快照从中间开始而改写成 0', () => {
  // 原生轨道虚拟化后可能只渲染 37…40 这几个按钮。
  const nodes = [
    { dataIndex: '37', ariaLabel: '跳转到第 38 轮' },
    { dataIndex: '38', ariaLabel: '跳转到第 39 轮' },
  ]
  const rows = rowsOf(nodes)
  assert.equal(rows[0].index, 37)
  assert.equal(rows[1].index, 38)
  assert.equal(rows[0].turn, 38)
  assert.equal(rows[1].turn, 39)
})

test('rowsOf：turns 表按 index 查表映射，不是 dataIndex+1', () => {
  // 合并列表：轮次 2、5、9、11；data-index 1 应该是第 5 轮。
  const nodes = [{ dataIndex: '1', ariaLabel: '' }, { dataIndex: '3', ariaLabel: '' }]
  const rows = rowsOf(nodes, { turns: [2, 5, 9, 11] })
  assert.equal(rows[0].turn, 5)   // 不是 2、也不是 1+1
  assert.equal(rows[1].turn, 11)  // 不是 4
})

test('rowsOf：turns 表越界时退回 aria-label 解析', () => {
  const rows = rowsOf([{ dataIndex: '99', ariaLabel: '加载并跳转到第 7 轮' }], { turns: [1, 2] })
  assert.equal(rows[0].turn, 7)
})

test('rowsOf：aria-label 中英两种文案都能解析', () => {
  const zh = rowsOf([{ ariaLabel: '跳转到第 12 轮' }, { ariaLabel: '第 3 轮' }])
  assert.deepEqual(zh.map(r => r.turn), [12, 3])
  const en = rowsOf([{ ariaLabel: 'Jump to turn 8' }, { ariaLabel: 'Load and jump to turn 9' }])
  assert.deepEqual(en.map(r => r.turn), [8, 9])
})

test('rowsOf：节点自带 turn 最优先', () => {
  const rows = rowsOf([{ turn: 5, dataIndex: '0', ariaLabel: '跳转到第 99 轮' }], { turns: [1, 2, 3] })
  assert.equal(rows[0].turn, 5)
})

test('rowsOf：解析不到轮号时按顺序编号降级（写入注释的降级路径）', () => {
  const rows = rowsOf([{ dataIndex: '40' }, { dataIndex: '41' }, {}])
  assert.deepEqual(rows.map(r => r.turn), [1, 2, 3])
  assert.deepEqual(rows.map(r => r.index), [40, 41, 2], 'index 仍取数据下标，只有 turn 是顺序号')
})

test('rowsOf：空数组 / 非数组输入返回空行', () => {
  assert.deepEqual(rowsOf([]), [])
  assert.deepEqual(rowsOf(null), [])
  assert.deepEqual(rowsOf(undefined), [])
  assert.deepEqual(rowsOf('oops'), [])
})

test('rowsOf：行序 = 节点序（不偷偷排序）', () => {
  const rows = rowsOf([{ turn: 9 }, { turn: 2 }, { turn: 5 }])
  assert.deepEqual(rows.map(r => r.turn), [9, 2, 5])
})

// ── 活动轮 ─────────────────────────────────────────────────────────
test('rowsOf：active 来自 aria-current="true" / "page" / active:true', () => {
  const rows = rowsOf([
    { turn: 1, ariaCurrent: 'true' },
    { turn: 2, ariaCurrent: 'false' },
    { turn: 3, ariaCurrent: 'page' },
    { turn: 4, active: true },
  ])
  assert.deepEqual(rows.map(r => r.active), [true, false, true, true])
})

test('activeIndexOf：返回数组下标，不是轮号', () => {
  const rows = rowsOf([{ turn: 7 }, { turn: 8 }, { turn: 9, ariaCurrent: 'true' }])
  assert.equal(activeIndexOf(rows), 2)
})

test('activeIndexOf：没有活动行 / 非法输入返回 -1', () => {
  assert.equal(activeIndexOf(rowsOf([{ turn: 1 }])), -1)
  assert.equal(activeIndexOf(null), -1)
  assert.equal(activeIndexOf([]), -1)
})

// ── 锚点 ────────────────────────────────────────────────────────────
test('anchorFor：按轮号找到数组下标', () => {
  const rows = rowsOf([{ turn: 3 }, { turn: 8 }, { turn: 13 }])
  assert.equal(anchorFor(rows, 8), 1)
  assert.equal(anchorFor(rows, '13'), 2)
})

test('anchorFor：找不到 / 非法轮号返回 -1', () => {
  const rows = rowsOf([{ turn: 3 }])
  assert.equal(anchorFor(rows, 4), -1)
  assert.equal(anchorFor(rows, null), -1)
  assert.equal(anchorFor(rows, 'bad'), -1)
  assert.equal(anchorFor(null, 1), -1)
})

// ── 三档宽度 ────────────────────────────────────────────────────────
test('tierOf：40 / 200 / 320 三档，中点是 120 / 260', () => {
  assert.equal(TIER_WIDTHS.hair, 40)
  assert.equal(TIER_WIDTHS.normal, 200)
  assert.equal(TIER_WIDTHS.wide, 320)
  assert.equal(tierOf(40), 'hair')
  assert.equal(tierOf(0), 'hair')
  assert.equal(tierOf(119), 'hair')
  assert.equal(tierOf(120), 'normal')
  assert.equal(tierOf(200), 'normal')
  assert.equal(tierOf(259), 'normal')
  assert.equal(tierOf(260), 'wide')
  assert.equal(tierOf(320), 'wide')
})

test('tierOf：缺失或非法宽度按标准档', () => {
  assert.equal(tierOf(), 'normal')
  assert.equal(tierOf(null), 'normal')
  assert.equal(tierOf(''), 'normal')
  assert.equal(tierOf('bad'), 'normal')
  assert.equal(tierOf(NaN), 'normal')
})

test('snapWidth：吸附到最近一档并夹紧 40…320', () => {
  assert.equal(snapWidth(0), 40)
  assert.equal(snapWidth(40), 40)
  assert.equal(snapWidth(100), 40)
  assert.equal(snapWidth(130), 200)
  assert.equal(snapWidth(200), 200)
  assert.equal(snapWidth(300), 320)
  assert.equal(snapWidth(999), 320)
  assert.equal(snapWidth(undefined), 200)
  assert.equal(snapWidth('bad'), 200)
})

// ── 文案解析 ────────────────────────────────────────────────────────
test('turnOfLabel：只认机器文案，不把正文里的「第 N 轮」当轮号', () => {
  assert.equal(turnOfLabel('跳转到第 12 轮'), 12)
  assert.equal(turnOfLabel('加载并跳转到第 3 轮'), 3)
  assert.equal(turnOfLabel('第 5 轮'), 5)
  assert.equal(turnOfLabel('Turn 9'), 9)
  assert.equal(turnOfLabel('Turn navigation'), null)
  assert.equal(turnOfLabel(''), null)
  assert.equal(turnOfLabel(null), null)
  assert.equal(turnOfLabel('#42'), 42)
})

// ── 行内容 ──────────────────────────────────────────────────────────
test('rowsOf：摘要优先 promptHead，压缩空白；缺失为空串', () => {
  const rows = rowsOf([
    { turn: 1, promptHead: '  把\n跳转   做到准确  ' },
    { turn: 2, label: 'label 兜底' },
    { turn: 3, text: 'text 兜底' },
    { turn: 4 },
  ])
  assert.equal(rows[0].label, '把 跳转 做到准确')
  assert.equal(rows[1].label, 'label 兜底')
  assert.equal(rows[2].label, 'text 兜底')
  assert.equal(rows[3].label, '')
})

test('rowsOf：timeText 原样优先，其次 time（HH:MM 或时间戳）', () => {
  const rows = rowsOf([
    { turn: 1, timeText: '昨天 14:03' },
    { turn: 2, time: '09:05' },
    { turn: 3, time: Date.UTC(2026, 0, 2, 4, 5) },
  ])
  assert.equal(rows[0].timeText, '昨天 14:03')
  assert.equal(rows[1].timeText, '09:05')
  assert.match(rows[2].timeText, /^\d{2}:\d{2}$/, '时间戳换算成本地 HH:MM')
})

test('rowsOf：hit 透传，默认 false', () => {
  const rows = rowsOf([{ turn: 1, hit: true }, { turn: 2 }])
  assert.equal(rows[0].hit, true)
  assert.equal(rows[1].hit, false)
})

test('rowsOf：turns 里的字符串轮号也认', () => {
  const rows = rowsOf([{ dataIndex: '0' }], { turns: ['3', '6'] })
  assert.equal(rows[0].turn, 3)
})

// ── 失配自检 ────────────────────────────────────────────────────────
test('selfCheck：容器存在且 data-index 按钮 > 0 才算通过', () => {
  const ok = selfCheck({ container: {}, buttons: [{ dataIndex: '0' }, { 'data-index': '1' }] })
  assert.equal(ok.ok, true)
  assert.equal(ok.code, 'ok')
  assert.equal(ok.reason, '')
})

test('selfCheck：没有容器 → 不接管，返回原因', () => {
  const result = selfCheck({ container: null, buttons: [] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-container')
  assert.equal(result.reason, '未找到原生导航轨容器')
  assert.equal(selfCheck(null).ok, false)
})

test('selfCheck：容器在但没有按钮 → 不接管，返回原因', () => {
  const result = selfCheck({ container: {}, buttons: [] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-buttons')
  assert.equal(result.reason, '原生导航轨没有轮次按钮')
})

test('selfCheck：按钮都缺 data-index → 不接管，返回原因', () => {
  const result = selfCheck({ container: {}, buttons: [{ ariaLabel: '第 1 轮' }] })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'no-index')
  assert.equal(result.reason, '原生轮次按钮缺少 data-index')
})

test('selfCheck：轮号解析不出不算失配（可顺序编号降级）', () => {
  const result = selfCheck({ container: {}, buttons: [{ dataIndex: '0' }, { dataIndex: '1', ariaLabel: '???', turn: null }] })
  assert.equal(result.ok, true)
})

// ── 段头 → 轮次行两级目录 ────────────────────────────────────────────
test('segmentGroupsOf：将 rows 与 segments 组装成「段头 → 轮次行」两级目录', () => {
  const rows = rowsOf([
    { turn: 1, promptHead: '开场讨论架构' },
    { turn: 2, promptHead: '确认接口字段' },
    { turn: 3, promptHead: '排查构建失败', ariaCurrent: 'true' },
    { turn: 4, promptHead: '修复并补单测' },
  ])
  const segments = [
    {
      id: 'seg-1',
      title: '架构讨论',
      startTurn: 1,
      endTurn: 2,
      kindCandidate: 'chat',
      hasError: false,
    },
    {
      id: 'seg-2',
      title: '排查构建失败',
      startTurn: 3,
      endTurn: 4,
      kindCandidate: 'work',
      errorTurns: [3],
    },
  ]

  const groups = segmentGroupsOf(rows, segments)
  assert.equal(groups.length, 2)

  assert.equal(groups[0].id, 'seg-1')
  assert.equal(groups[0].title, '架构讨论')
  assert.equal(groups[0].startTurn, 1)
  assert.equal(groups[0].endTurn, 2)
  assert.equal(groups[0].turnCount, 2)
  assert.equal(groups[0].kindCandidate, 'chat')
  assert.equal(groups[0].hasError, false)
  assert.equal(groups[0].active, false)
  assert.deepEqual(groups[0].rows.map(r => r.turn), [1, 2])

  assert.equal(groups[1].id, 'seg-2')
  assert.equal(groups[1].title, '排查构建失败')
  assert.equal(groups[1].startTurn, 3)
  assert.equal(groups[1].endTurn, 4)
  assert.equal(groups[1].turnCount, 2)
  assert.equal(groups[1].kindCandidate, 'work')
  assert.equal(groups[1].hasError, true)
  assert.equal(groups[1].active, true, '含活动轮次的段必须标为 active: true')
  assert.deepEqual(groups[1].rows.map(r => r.turn), [3, 4])
})

test('segmentGroupsOf：无 segments 或未覆盖任何行时平滑退回空数组', () => {
  const rows = rowsOf([{ turn: 1 }, { turn: 2 }])
  assert.deepEqual(segmentGroupsOf(rows, null), [])
  assert.deepEqual(segmentGroupsOf(rows, undefined), [])
  assert.deepEqual(segmentGroupsOf(rows, []), [])
  assert.deepEqual(segmentGroupsOf([], [{ id: 'seg-1', startTurn: 1, endTurn: 2 }]), [])
  assert.deepEqual(segmentGroupsOf(rows, [{ id: 'seg-9', startTurn: 10, endTurn: 12 }]), [])
})

test('segmentGroupsOf：支持 turnRange / 缺省标题兜底 / 孤立未覆盖轮次不丢失', () => {
  const rows = rowsOf([
    { turn: 1, promptHead: '前导问题' },
    { turn: 2, promptHead: '主体工作' },
    { turn: 3, promptHead: '收尾验证', active: true },
    { turn: 4, promptHead: '新增未切段轮次' },
  ])
  const segments = [
    { turnRange: [2, 3], kindCandidate: 'work' },
  ]
  const groups = segmentGroupsOf(rows, segments)
  // 应覆盖所有行（前导 + 命中段 + 尾部），不静默丢失轮次
  const allTurns = groups.flatMap(g => g.rows.map(r => r.turn))
  assert.deepEqual(allTurns, [1, 2, 3, 4])
  const main = groups.find(g => g.startTurn === 2 && g.endTurn === 3)
  assert.ok(main, '目标段必须存在')
  assert.equal(main.title, '第 2–3 轮')
  assert.equal(main.kindCandidate, 'work')
  assert.equal(main.active, true)
  assert.equal(main.turnCount, 2)
})

test('segmentGroupsOf：rows 中带 hasError 或 errorTurns 能透传到段头 hasError，且不改入参', () => {
  const rows = [
    { index: 0, turn: 1, label: 'a', active: false, timeText: '', hit: false, hasError: true },
    { index: 1, turn: 2, label: 'b', active: false, timeText: '', hit: false },
  ]
  const segments = [{ id: 's1', title: '错误段', startTurn: 1, endTurn: 2 }]
  const rowsSnap = JSON.stringify(rows)
  const segsSnap = JSON.stringify(segments)

  const groups = segmentGroupsOf(rows, segments)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].hasError, true)
  assert.equal(JSON.stringify(rows), rowsSnap)
  assert.equal(JSON.stringify(segments), segsSnap)
})

// ── 汇总 ────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.log(`\n${passed} passed, ${failures.length} failed`)
  for (const failure of failures) console.log(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
console.log(`\n${passed} passed`)
