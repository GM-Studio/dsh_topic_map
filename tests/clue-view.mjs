/**
 * 线索视图模型测试（V-4）。
 *
 * 纯函数：`now` 一律由参数传入，不读系统时钟、不碰 DOM。
 *
 * Run: node tests/clue-view.mjs
 */

import { strict as assert } from 'node:assert'
import { buildClue } from '../lib/clue-view.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 固定"现在"：2026-11-25 10:00（本地时区）。 */
const NOW = new Date(2026, 10, 25, 10, 0, 0).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 2026-11-<day> <hour>:<minute> 的本地时间戳。 */
const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute, 0).getTime()

/** 一条接近 Host 输出的线索行。 */
function rowOf(patch = {}) {
  return {
    sessionId: 's1',
    sessionTitle: '会话一',
    turn: 3,
    time: at(24, 9),
    promptHead: '把跳转做到准确',
    endReason: 'completed',
    ...patch,
  }
}

/** 空统计的固定形状。 */
const EMPTY_STATS = { sessions: 0, turns: 0, firstAt: null, lastAt: null, spanDays: 0 }

console.log('\nclue-view')

// ── 空态 ────────────────────────────────────────────────────────────
test('没有主题词：empty=true，timeline 为空，不读 rows', () => {
  for (const options of [undefined, null, {}, { keywords: [] }, { keywords: '' }, { keywords: '   ' }, { keywords: [null, '  '] }]) {
    const result = buildClue([rowOf()], options)
    assert.deepEqual(result, { timeline: [], stats: EMPTY_STATS, empty: true }, JSON.stringify(options))
  }
})

test('空输入：有主题词也返回空视图', () => {
  for (const rows of [undefined, null, [], 'not-an-array', {}]) {
    const result = buildClue(rows, { keywords: '跳转', now: NOW })
    assert.deepEqual(result, { timeline: [], stats: EMPTY_STATS, empty: true })
  }
})

// ── 基本时间线 ──────────────────────────────────────────────────────
test('基本时间线：字段、时间文案与统计', () => {
  const rows = [
    rowOf({ sessionId: 's1', sessionTitle: '会话一', turn: 3, time: at(24, 9), promptHead: '第一段' }),
    rowOf({ sessionId: 's2', sessionTitle: '会话二', turn: 1, time: at(24, 10, 30), promptHead: '第二段' }),
    rowOf({ sessionId: 's1', sessionTitle: '会话一', turn: 4, time: at(25, 9), promptHead: '第三段' }),
  ]
  const result = buildClue(rows, { keywords: ['跳转'], now: NOW })

  assert.equal(result.empty, false)
  assert.deepEqual(result.timeline[0], {
    time: at(24, 9),
    timeText: '昨天',
    sessionId: 's1',
    sessionTitle: '会话一',
    turn: 3,
    head: '第一段',
    delta: '首次提及',
    count: 1,
    turns: [3],
    lastTime: at(24, 9),
  })
  assert.equal(result.timeline[1].timeText, '23 小时前')
  assert.equal(result.timeline[1].delta, '首次提及')
  assert.equal(result.timeline[2].timeText, '1 小时前')
  assert.equal(result.timeline[2].delta, '第 2 次')
  assert.deepEqual(result.stats, {
    sessions: 2,
    turns: 3,
    firstAt: at(24, 9),
    lastAt: at(25, 9),
    spanDays: 1,
  })
})

test('delta：同一会话内按行累计，换会话重新从"首次提及"开始', () => {
  const rows = [
    rowOf({ sessionId: 's1', time: at(20, 9) }),
    rowOf({ sessionId: 's1', time: at(21, 9) }),
    rowOf({ sessionId: 's2', time: at(22, 9) }),
    rowOf({ sessionId: 's1', time: at(23, 9) }),
    rowOf({ sessionId: 's2', time: at(24, 9) }),
    rowOf({ sessionId: 's1', time: at(25, 9) }),
  ]
  const deltas = buildClue(rows, { keywords: '跳转', now: NOW }).timeline.map(item => item.delta)
  assert.deepEqual(deltas, ['首次提及', '第 2 次', '首次提及', '第 3 次', '第 2 次', '第 4 次'])
})

// ── 聚类 ────────────────────────────────────────────────────────────
test('相邻同会话同一天合并成一个 cluster，delta / head / time 保留首条', () => {
  const rows = [
    rowOf({ sessionId: 's1', turn: 1, time: at(23, 9), promptHead: '上午那次' }),
    rowOf({ sessionId: 's1', turn: 2, time: at(23, 11), promptHead: '同一天又提了一次' }),
    rowOf({ sessionId: 's1', turn: 3, time: at(24, 9), promptHead: '第二天' }),
  ]
  const { timeline } = buildClue(rows, { keywords: '跳转', now: NOW })

  assert.equal(timeline.length, 2)
  assert.equal(timeline[0].count, 2)
  assert.deepEqual(timeline[0].turns, [1, 2])
  assert.equal(timeline[0].delta, '首次提及', '合并后仍保留首条的 delta')
  assert.equal(timeline[0].head, '上午那次')
  assert.equal(timeline[0].time, at(23, 9))
  assert.equal(timeline[0].lastTime, at(23, 11))
  assert.equal(timeline[0].timeText, '2 天前')

  assert.equal(timeline[1].count, 1)
  assert.equal(timeline[1].delta, '第 3 次', '被合并的第 2 行仍计入累计')
})

test('非相邻同会话同一天不合并', () => {
  const rows = [
    rowOf({ sessionId: 's1', turn: 1, time: at(23, 9) }),
    rowOf({ sessionId: 's2', turn: 1, time: at(23, 10) }),
    rowOf({ sessionId: 's1', turn: 2, time: at(23, 11) }),
  ]
  const { timeline } = buildClue(rows, { keywords: '跳转', now: NOW })
  assert.equal(timeline.length, 3)
  assert.deepEqual(timeline.map(item => item.count), [1, 1, 1])
  assert.deepEqual(timeline.map(item => item.delta), ['首次提及', '首次提及', '第 2 次'])
})

test('同会话跨自然日不合并（含跨零点）', () => {
  const rows = [
    rowOf({ sessionId: 's1', turn: 1, time: at(24, 23, 59) }),
    rowOf({ sessionId: 's1', turn: 2, time: at(25, 0, 1) }),
  ]
  const { timeline } = buildClue(rows, { keywords: '跳转', now: NOW })
  assert.equal(timeline.length, 2)
  assert.deepEqual(timeline.map(item => item.turn), [1, 2])
  assert.deepEqual(timeline.map(item => item.delta), ['首次提及', '第 2 次'])
})

test('缺 sessionId 的相邻行按同一会话聚类，文案留空不编造', () => {
  const rows = [
    rowOf({ sessionId: undefined, sessionTitle: undefined, turn: 1, time: at(24, 9) }),
    rowOf({ sessionId: null, sessionTitle: '   ', turn: 2, time: at(24, 10) }),
  ]
  const { timeline } = buildClue(rows, { keywords: '跳转', now: NOW })
  assert.equal(timeline.length, 1)
  assert.equal(timeline[0].sessionId, '')
  assert.equal(timeline[0].sessionTitle, '')
  assert.equal(timeline[0].count, 2)
  assert.equal(timeline[0].delta, '首次提及')
})

// ── head 截断 ───────────────────────────────────────────────────────
test('head：压缩空白，60 码点不截断，61 码点截成 59 + …', () => {
  const exactly60 = 'a'.repeat(60)
  const sixtyOne = 'a'.repeat(61)
  const result = buildClue([
    rowOf({ time: at(22, 9), promptHead: `  第一行\n第二行\t结束  ` }),
    rowOf({ time: at(23, 9), promptHead: exactly60 }),
    rowOf({ time: at(24, 9), promptHead: sixtyOne }),
  ], { keywords: '跳转', now: NOW })

  assert.equal(result.timeline[0].head, '第一行 第二行 结束')
  assert.equal(result.timeline[1].head, exactly60)
  assert.equal(result.timeline[2].head, `${'a'.repeat(59)}…`)
  assert.equal(Array.from(result.timeline[2].head).length, 60)
})

test('head 按码点算：emoji 不被切成半个代理对', () => {
  const result = buildClue([rowOf({ promptHead: '😀'.repeat(61) })], { keywords: '跳转', now: NOW })
  const head = result.timeline[0].head
  assert.equal(Array.from(head).length, 60)
  assert.equal(head, `${'😀'.repeat(59)}…`)
  assert.equal(head.includes('\uFFFD'), false)
})

test('head 缺失 / 非字符串时为空串，不把对象写进视图', () => {
  for (const value of [undefined, null, 42, {}, []]) {
    const result = buildClue([rowOf({ promptHead: value })], { keywords: '跳转', now: NOW })
    assert.equal(result.timeline[0].head, '')
  }
})

// ── limit ───────────────────────────────────────────────────────────
test('limit 只截断 timeline，stats 仍按全部命中计算', () => {
  const rows = [20, 21, 22, 23, 24].map((day, index) => rowOf({ turn: index + 1, time: at(day, 9) }))
  const result = buildClue(rows, { keywords: '跳转', now: NOW, limit: 2 })

  assert.equal(result.timeline.length, 2)
  assert.deepEqual(result.timeline.map(item => item.turn), [1, 2])
  assert.equal(result.empty, false)
  assert.deepEqual(result.stats, {
    sessions: 1,
    turns: 5,
    firstAt: at(20, 9),
    lastAt: at(24, 9),
    spanDays: 4,
  })
})

test('limit 默认 / 0 / 非法值的边界', () => {
  const rows = [22, 23, 24].map((day, index) => rowOf({ turn: index + 1, time: at(day, 9) }))

  assert.equal(buildClue(rows, { keywords: '跳转', now: NOW }).timeline.length, 3)
  assert.equal(buildClue(rows, { keywords: '跳转', now: NOW, limit: 99 }).timeline.length, 3)

  const zero = buildClue(rows, { keywords: '跳转', now: NOW, limit: 0 })
  assert.deepEqual(zero.timeline, [])
  assert.equal(zero.empty, true)
  assert.equal(zero.stats.turns, 3, 'stats 不受 limit 影响')

  assert.equal(buildClue(rows, { keywords: '跳转', now: NOW, limit: 'x' }).timeline.length, 3, '非法值回默认上限')
  assert.deepEqual(buildClue(rows, { keywords: '跳转', now: NOW, limit: -1 }).timeline, [], '负数按 0 处理')
})

test('limit 作用在聚类之后，不是原始行数', () => {
  const rows = [
    rowOf({ turn: 1, time: at(24, 9) }),
    rowOf({ turn: 2, time: at(24, 10) }),
    rowOf({ turn: 3, time: at(24, 11) }),
    rowOf({ turn: 4, time: at(25, 9) }),
  ]
  const result = buildClue(rows, { keywords: '跳转', now: NOW, limit: 2 })
  assert.equal(result.timeline.length, 2)
  assert.equal(result.timeline[0].count, 3)
  assert.equal(result.timeline[1].turn, 4)
})

// ── 时间与健壮性 ────────────────────────────────────────────────────
test('timeText：now 缺失 / 非法时留空，绝不回退系统时钟', () => {
  const rows = [rowOf({ time: NOW - 2 * HOUR })]
  assert.equal(buildClue(rows, { keywords: '跳转' }).timeline[0].timeText, '')
  assert.equal(buildClue(rows, { keywords: '跳转', now: 'x' }).timeline[0].timeText, '')
  assert.equal(buildClue(rows, { keywords: '跳转', now: NOW }).timeline[0].timeText, '2 小时前')
})

test('时间接受 Date；非法时间的行跳过，不参与 stats / delta', () => {
  const rows = [
    null,
    'x',
    { time: 'yesterday' },
    rowOf({ sessionId: 's1', turn: 1, time: new Date(at(23, 9)) }),
    rowOf({ sessionId: 's1', turn: 2, time: Number.NaN }),
    rowOf({ sessionId: 's1', turn: 3, time: at(24, 9) }),
  ]
  const result = buildClue(rows, { keywords: '跳转', now: NOW })

  assert.equal(result.timeline.length, 2)
  assert.equal(result.timeline[0].time, at(23, 9))
  assert.equal(result.timeline[0].turn, 1)
  assert.equal(result.timeline[1].delta, '第 2 次', '非法时间的行不应占用次数')
  assert.deepEqual(result.stats, {
    sessions: 1,
    turns: 2,
    firstAt: at(23, 9),
    lastAt: at(24, 9),
    spanDays: 1,
  })
})

test('轮号：数字 / 数字字符串归一，缺省为 null', () => {
  const result = buildClue([
    rowOf({ time: at(23, 9), turn: '7' }),
    rowOf({ time: at(24, 9), turn: null }),
  ], { keywords: '跳转', now: NOW })
  assert.equal(result.timeline[0].turn, 7)
  assert.equal(result.timeline[1].turn, null)
  assert.deepEqual(result.timeline[1].turns, [])
})

test('stats.spanDays 按本地自然日差计算；同日为 0', () => {
  const sameDay = buildClue([
    rowOf({ time: at(24, 0, 1) }),
    rowOf({ time: at(24, 23, 59) }),
  ], { keywords: '跳转', now: NOW })
  assert.equal(sameDay.stats.spanDays, 0)

  const crossed = buildClue([
    rowOf({ time: at(20, 9) }),
    rowOf({ time: at(23, 23) }),
  ], { keywords: '跳转', now: NOW })
  assert.equal(crossed.stats.spanDays, 3)
})

test('不修改入参；输出是新对象', () => {
  const rows = [rowOf({ sessionId: 's1', time: at(24, 9), promptHead: '原文' })]
  const snapshot = JSON.parse(JSON.stringify(rows))
  const result = buildClue(rows, { keywords: '跳转', now: NOW })

  assert.deepEqual(rows, snapshot)
  assert.notEqual(result.timeline, rows)
  result.timeline[0].head = '改输出'
  assert.equal(rows[0].promptHead, '原文')
})

test('keywords 接受字符串与数组，不作为二次过滤条件', () => {
  const rows = [
    rowOf({ time: at(23, 9), promptHead: '只提到一次跳转' }),
    rowOf({ time: at(24, 9), promptHead: '这条正文没有主题词（Host 已经检索过）' }),
  ]
  assert.equal(buildClue(rows, { keywords: '跳转', now: NOW }).timeline.length, 2)
  assert.equal(buildClue(rows, { keywords: ['跳转', '定位'], now: NOW }).timeline.length, 2)
})

// ── 小输入不崩 ──────────────────────────────────────────────────────
test('缺字段的行也能成行（时间仍是硬条件）', () => {
  const result = buildClue([{ time: at(24, 9) }], { keywords: '跳转', now: NOW })
  assert.equal(result.timeline.length, 1)
  assert.deepEqual(result.timeline[0], {
    time: at(24, 9),
    timeText: '昨天',
    sessionId: '',
    sessionTitle: '',
    turn: null,
    head: '',
    delta: '首次提及',
    count: 1,
    turns: [],
    lastTime: at(24, 9),
  })
  assert.deepEqual(result.stats, {
    sessions: 1,
    turns: 1,
    firstAt: at(24, 9),
    lastAt: at(24, 9),
    spanDays: 0,
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
