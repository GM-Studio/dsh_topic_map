/**
 * 历史轨视图模型测试（V-12 / ui.md §10）。
 *
 * 纯函数：不读 DOM、不读系统时钟、不 import 其他模块。
 * 时间相关的事实（命中、活动轮、状态）全部由参数传入，结果可复现。
 *
 * Run: node tests/rail-view.mjs
 */

import { strict as assert } from 'node:assert'
import {
  hitOnly,
  mapIndexToTurn,
  scrollAnchor,
  statusOf,
  tierOf,
  toRailRows,
} from '../lib/rail-view.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 固定语料：outline 形状与宿主 turnOutline 一致（turn 1-based、seq、prompt、response）。 */
const OUTLINE = [
  { turn: 1, seq: 101, prompt: '把跳转做到准确，跳转不要跑偏，顺便看看定位逻辑是否稳定', response: '好，先看导航流程。' },
  { turn: 2, seq: 120, prompt: '', response: '只有回答的轮次，用回答当摘要' },
  { turn: 3, seq: 140, prompt: '第三轮提问', response: '' },
  { turn: 5, seq: 170, prompt: '第五轮提问', response: '' },
]

console.log('\nrail-view')

// ── data-index → 轮号 ──────────────────────────────────────────────
test('mapIndexToTurn：位置映射，不是 dataIndex+1', () => {
  const rows = [{ turn: 4 }, { turn: 9 }, { turn: 11 }]
  assert.equal(mapIndexToTurn(rows, 0), 4)   // 不是 1
  assert.equal(mapIndexToTurn(rows, 1), 9)   // 不是 2
  assert.equal(mapIndexToTurn(rows, 2), 11)
})

test('mapIndexToTurn：越界 / 非法索引返回 null', () => {
  const rows = [{ turn: 4 }, { turn: 9 }]
  assert.equal(mapIndexToTurn(rows, 2), null)
  assert.equal(mapIndexToTurn(rows, -1), null)
  assert.equal(mapIndexToTurn(rows, 1.5), null)
  assert.equal(mapIndexToTurn(rows, 99), null)
  assert.equal(mapIndexToTurn(null, 0), null)
  assert.equal(mapIndexToTurn(rows, null), null)
  assert.equal(mapIndexToTurn(rows, ''), null)
  // DOM 的 data-index 读出来是字符串，数字字符串照常认
  assert.equal(mapIndexToTurn(rows, '1'), 9)
})

// ── 三档宽度 ────────────────────────────────────────────────────────
test('tierOf：60 / 260 两个阈值', () => {
  assert.equal(tierOf(40), 'narrow')
  assert.equal(tierOf(59), 'narrow')
  assert.equal(tierOf(60), 'normal')
  assert.equal(tierOf(200), 'normal')
  assert.equal(tierOf(259), 'normal')
  assert.equal(tierOf(260), 'wide')
  assert.equal(tierOf(320), 'wide')
})

test('tierOf：宽度缺失或非法时按标准档', () => {
  assert.equal(tierOf(undefined), 'normal')
  assert.equal(tierOf(null), 'normal')
  assert.equal(tierOf('bad'), 'normal')
})

test('三档截断：narrow 0 / normal 24 / wide 40', () => {
  const long = '一二三四五六七八九十'.repeat(5) // 50 个字
  const outline = [{ turn: 1, seq: 1, prompt: long, response: '' }]
  const narrow = toRailRows({ outline, width: 40 })
  const normal = toRailRows({ outline, width: 200 })
  const wide = toRailRows({ outline, width: 320 })
  assert.equal(narrow[0].primary, '')
  assert.equal(narrow[0].secondary, '')
  assert.equal(normal[0].primary, Array.from(long).slice(0, 24).join(''))
  assert.equal(wide[0].primary, Array.from(long).slice(0, 40).join(''))
  assert.equal(Array.from(normal[0].primary).length, 24)
  assert.equal(Array.from(wide[0].primary).length, 40)
  assert.equal(narrow[0].tier, 'narrow')
  assert.equal(normal[0].tier, 'normal')
  assert.equal(wide[0].tier, 'wide')
})

test('摘要首句 / 空白压缩 / response 兜底', () => {
  const rows = toRailRows({
    outline: [
      { turn: 1, prompt: '  第一句要短。  第二句很长  ', response: '回答' },
      { turn: 2, prompt: '   ', response: '  只有回答  ' },
      { turn: 3, prompt: '', response: '' },
    ],
    width: 320,
  })
  assert.equal(rows[0].primary, '第一句要短')
  assert.equal(rows[1].primary, '只有回答')
  assert.equal(rows[2].primary, '')
})

test('截断按字符数，中英一致，不切坏代理对', () => {
  // normal 24 字：20 个 A + 4 个中文
  const mixed = 'A'.repeat(20) + '中'.repeat(10)
  const [normalRow] = toRailRows({ outline: [{ turn: 1, prompt: mixed }], width: 200 })
  assert.equal(normalRow.primary, 'A'.repeat(20) + '中'.repeat(4))

  // 第 24 个字符是 emoji（代理对），不能被切成半个
  const prompt = '字'.repeat(23) + '😀' + '尾巴'
  const [row] = toRailRows({ outline: [{ turn: 1, prompt }], width: 200 })
  assert.equal(Array.from(row.primary).length, 24)
  assert.equal(row.primary, '字'.repeat(23) + '😀')
  assert.equal(row.primary.length, 25) // 23 个中文 + 代理对 2 个 UTF-16 单元
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(row.primary), '不能有孤立的高代理')
  assert.ok(!/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(row.primary), '不能有孤立的低代理')
})

// ── 行集合 ──────────────────────────────────────────────────────────
test('toRailRows：行字段齐全，按 turn 升序', () => {
  const rows = toRailRows({ outline: [OUTLINE[3], OUTLINE[0], OUTLINE[1]], width: 200 })
  assert.deepEqual(rows.map(row => row.turn), [1, 2, 5])
  for (const row of rows) {
    for (const key of ['turn', 'seq', 'tier', 'primary', 'secondary', 'hit', 'hitCount', 'active', 'status']) {
      assert.ok(key in row, `缺少字段 ${key}`)
    }
  }
  assert.equal(rows[0].seq, 101)
  assert.equal(rows[1].seq, 120)
  assert.equal(rows[0].tier, 'normal')
})

test('loadedTurns：只输出已加载轮次（空 = 全部）', () => {
  const all = toRailRows({ outline: OUTLINE, width: 200 })
  assert.deepEqual(all.map(row => row.turn), [1, 2, 3, 5])

  const filtered = toRailRows({ outline: OUTLINE, loadedTurns: [1, 3], width: 200 })
  assert.deepEqual(filtered.map(row => row.turn), [1, 3])

  // 已加载项是宿主 navigation 对象形状（带 turn / prompt / response）也认
  const viaObjects = toRailRows({
    outline: OUTLINE,
    loadedTurns: [{ turn: 5, prompt: '来自已加载项的摘要' }],
    width: 200,
  })
  assert.deepEqual(viaObjects.map(row => row.turn), [5])
  assert.equal(viaObjects[0].primary, '来自已加载项的摘要')
})

test('outline 缺失时用已加载项自己的摘要（turnOutline 未挂载的降级）', () => {
  const rows = toRailRows({
    outline: [],
    loadedTurns: [{ turn: 2, prompt: '只有已加载项', response: '' }],
    width: 200,
  })
  assert.deepEqual(rows.map(row => row.turn), [2])
  assert.equal(rows[0].seq, null)
  assert.equal(rows[0].primary, '只有已加载项')
})

test('空输入返回空数组', () => {
  assert.deepEqual(toRailRows({}), [])
  assert.deepEqual(toRailRows(null), [])
  assert.deepEqual(toRailRows({ outline: [], loadedTurns: [] }), [])
})

// ── 命中集合 ────────────────────────────────────────────────────────
test('命中集合：Set / 命中对象 / Map 都能算 hit 与 hitCount', () => {
  const fromSet = toRailRows({ outline: OUTLINE, hits: new Set([2, 3]), width: 200 })
  assert.deepEqual(
    fromSet.map(row => [row.turn, row.hit, row.hitCount]),
    [[1, false, 0], [2, true, 1], [3, true, 1], [5, false, 0]],
  )

  const fromHits = toRailRows({
    outline: OUTLINE,
    hits: [{ turn: 2, matchCount: 4, snippet: '命中片段' }, { turn: 3, matchCount: 1 }],
    width: 200,
  })
  assert.equal(fromHits.find(row => row.turn === 2).hitCount, 4)
  assert.equal(fromHits.find(row => row.turn === 3).hitCount, 1)

  const fromMap = toRailRows({
    outline: OUTLINE,
    hits: new Map([[3, { matchCount: 2 }], [5, true]]),
    width: 200,
  })
  assert.equal(fromMap.find(row => row.turn === 3).hitCount, 2)
  assert.equal(fromMap.find(row => row.turn === 5).hitCount, 1)
})

test('命中片段只进宽档的 secondary', () => {
  const hits = [{ turn: 2, matchCount: 2, snippet: '  命中   片段在这里  ' }]
  const wide = toRailRows({ outline: OUTLINE, hits, width: 320 })
  assert.equal(wide.find(row => row.turn === 2).secondary, '命中 片段在这里')

  const normal = toRailRows({ outline: OUTLINE, hits, width: 200 })
  assert.equal(normal.find(row => row.turn === 2).secondary, '')

  const narrow = toRailRows({ outline: OUTLINE, hits, width: 40 })
  assert.equal(narrow.find(row => row.turn === 2).secondary, '')

  const longSnippet = [{ turn: 2, snippet: '片'.repeat(60) }]
  const wideLong = toRailRows({ outline: OUTLINE, hits: longSnippet, width: 320 })
  assert.equal(Array.from(wideLong.find(row => row.turn === 2).secondary).length, 40)
})

test('命中模式不删行：hitOnly 只给非命中行标 dim', () => {
  const rows = toRailRows({ outline: OUTLINE, hits: new Set([2]), width: 200 })
  const dimmed = hitOnly(rows)
  assert.equal(dimmed.length, rows.length) // 轨道不能因搜索而缩短
  assert.deepEqual(dimmed.map(row => row.dim), [true, false, true, true])
  assert.equal(rows[0].dim, undefined) // 不改入参
  assert.notEqual(dimmed[0], rows[0])
  assert.deepEqual(hitOnly(null), [])
})

// ── 活动轮 ──────────────────────────────────────────────────────────
test('活动轮标记', () => {
  const rows = toRailRows({ outline: OUTLINE, activeTurn: 3, width: 200 })
  assert.deepEqual(rows.map(row => row.active), [false, false, true, false])
  // 从 aria-current 反查出来的是字符串也认
  const fromString = toRailRows({ outline: OUTLINE, activeTurn: '3', width: 200 })
  assert.equal(fromString.find(row => row.turn === 3).active, true)
  const none = toRailRows({ outline: OUTLINE, width: 200 })
  assert.equal(none.every(row => row.active === false), true)
})

// ── 状态 ────────────────────────────────────────────────────────────
test('状态来自 outline / 命中事实，优先级同 hit-view', () => {
  const rows = toRailRows({
    outline: [
      { turn: 1, prompt: 'a', endReason: 'error' },
      { turn: 2, prompt: 'b', interrupted: true },
      { turn: 3, prompt: 'c', changes: { files: [{ path: 'x' }] } },
      { turn: 4, prompt: 'd', label: { starred: true } },
      { turn: 5, prompt: 'e' },
    ],
    width: 320,
  })
  assert.deepEqual(rows.map(row => row.status), ['失败', '中断', '有变更', '已标记', ''])
  // 行上保留了状态原料，statusOf 可以重算
  assert.equal(statusOf(rows[0]), '失败')
})

test('statusOf：四类优先级', () => {
  assert.equal(statusOf({ endReason: 'error' }), '失败')
  assert.equal(statusOf({ endReason: 'max-tokens' }), '失败')
  assert.equal(statusOf({ endReason: 'interrupted' }), '中断')
  assert.equal(statusOf({ interrupted: true }), '中断')
  assert.equal(statusOf({ changes: { files: [{ path: 'a' }], lost: false } }), '有变更')
  assert.equal(statusOf({ changes: { files: [], lost: true } }), '有变更')
  assert.equal(statusOf({ label: { starred: true } }), '已标记')
  assert.equal(statusOf({ label: ['followUp'] }), '已标记')
  assert.equal(statusOf({}), '')
  assert.equal(statusOf(null), '')
  assert.equal(statusOf({
    endReason: 'error',
    interrupted: true,
    changes: { files: [{ path: 'a' }] },
    label: { starred: true },
  }), '失败')
  assert.equal(statusOf({
    interrupted: true,
    changes: { files: [{ path: 'a' }] },
    label: { solved: true },
  }), '中断')
  assert.equal(statusOf({
    changes: { files: [{ path: 'a' }] },
    label: { solved: true },
  }), '有变更')
})

// ── 滚动锚点 ────────────────────────────────────────────────────────
test('scrollAnchor：活动轮尽量居中，上下夹紧', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ turn: index + 1 }))
  const viewport = { height: 120, rowHeight: 24 }
  // index 5：5×24 - (120-24)/2 = 72
  assert.deepEqual(scrollAnchor(rows, 6, viewport), { top: 72, index: 5 })
  // 顶部夹紧
  assert.deepEqual(scrollAnchor(rows, 1, viewport), { top: 0, index: 0 })
  // 底部夹紧：内容 240 - 视口 120
  assert.deepEqual(scrollAnchor(rows, 10, viewport), { top: 120, index: 9 })
})

test('scrollAnchor：找不到活动轮 / 内容不足一屏 / 参数缺失', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ turn: index + 1 }))
  assert.deepEqual(scrollAnchor(rows, 99, { height: 120, rowHeight: 24 }), { top: 0, index: -1 })
  assert.deepEqual(scrollAnchor([], 1, { height: 120, rowHeight: 24 }), { top: 0, index: -1 })
  assert.deepEqual(scrollAnchor(rows, 4, { height: 1000, rowHeight: 24 }), { top: 0, index: 3 })
  assert.deepEqual(scrollAnchor(rows, 4, undefined), { top: 0, index: 3 })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
