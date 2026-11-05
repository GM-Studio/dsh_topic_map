/**
 * 可移植性验证：用多种"非本机"形态的数据跑全链路。
 *
 * 目的不是测本机，而是测"换一台机器 / 换一份数据，这个插件还能不能正常分析"。
 * 覆盖：英文、日文、全失败、单轮、空会话、200 轮压力、三平台路径。
 *
 * Run: node tests/portability.mjs
 */

import { strict as assert } from 'node:assert'
import { buildSessionPayloadParts } from '../lib/payload.js'
import { buildCategoryTree, prepareSessions } from '../lib/session-category.js'
import { isDeliverablePath } from '../lib/deliverables.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 造一份最小但合法的会话日志。 */
function makeLog(turnCount, opts = {}) {
  const events = []
  let seq = 0
  for (let i = 1; i <= turnCount; i += 1) {
    const t = i * 1000
    events.push({ type: 'turn/start', seq: seq++, time: t, data: { turn: i } })
    events.push({
      type: 'user/message', seq: seq++, time: t + 10,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'text', text: opts.prompt === undefined ? `第${i}轮提问` : opts.prompt(i) }],
      },
    })
    events.push({
      type: 'assistant/message', seq: seq++, time: t + 500,
      data: {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: opts.reply === undefined ? `第${i}轮回复` : opts.reply(i) }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        usage: { inputTokens: 100, outputTokens: 50 },
        stream: [],
      },
    })
    events.push({
      type: 'turn/end', seq: seq++, time: t + 900,
      data: { turn: i, reason: { kind: opts.endReason === undefined ? 'completed' : opts.endReason } },
    })
  }
  return events
}

console.log('\nportability')

// ── 非中文数据 ──────────────────────────────────────────────────────
await test('英文会话能被正常分段（不依赖中文分词）', async () => {
  const events = makeLog(10, {
    prompt: i => `Question ${i} about database indexing strategy`,
    reply: i => `Answer ${i} with details`,
  })
  const p = await buildSessionPayloadParts(events, 'en-session')
  assert.equal(p.turns.length, 10, `应 10 轮，实际 ${p.turns.length}`)
  assert.ok(p.graph.nodes.length > 0, '应有节点')
  assert.ok(p.lanes.length >= 1, '应有泳道')
})

await test('日文会话不崩', async () => {
  const events = makeLog(5, { prompt: i => `質問${i}について教えて`, reply: i => `回答${i}` })
  const p = await buildSessionPayloadParts(events, 'ja-session')
  assert.equal(p.turns.length, 5)
})

await test('全失败会话：每轮都识别为 error', async () => {
  const events = makeLog(6, { endReason: 'error' })
  const p = await buildSessionPayloadParts(events, 'err-session')
  assert.equal(p.turns.length, 6)
  assert.ok(p.turns.every(t => t.endReason === 'error'), '全部应为 error')
})

await test('单轮会话也能出图', async () => {
  const p = await buildSessionPayloadParts(makeLog(1), 'one-turn')
  assert.equal(p.turns.length, 1)
  assert.ok(p.lanes.length >= 1, '单轮也应有泳道')
})

await test('空会话不崩溃，且下游取值安全', async () => {
  const p = await buildSessionPayloadParts([], 'empty')
  assert.equal(p.turns.length, 0)
  assert.equal(p.lanes.length, 0)
  // columnCount 为 0 是正确语义（没有话题），客户端用 Math.max(1, …) 兜底。
  // 这里验证"不抛异常 + 数值合法"，而不是强求 >= 1。
  assert.ok(Number.isFinite(p.graph.columnCount) && p.graph.columnCount >= 0)
  assert.equal(p.graph.nodes.length, 0)
  assert.equal(p.graph.edges.length, 0)
})

await test('200 轮在 5 秒内完成（性能不随环境退化）', async () => {
  const t0 = Date.now()
  const p = await buildSessionPayloadParts(makeLog(200), 'big')
  const ms = Date.now() - t0
  assert.equal(p.turns.length, 200)
  assert.ok(ms < 5000, `应 5 秒内，实际 ${ms}ms`)
})

await test('未知事件类型被忽略（向前兼容新版本日志）', async () => {
  const events = makeLog(3)
  // 插入本插件不认识的事件
  events.splice(2, 0, { type: 'future/unknown-event', seq: 99, time: 5, data: { x: 1 } })
  const p = await buildSessionPayloadParts(events, 'compat')
  assert.equal(p.turns.length, 3, '未知事件不应影响折叠')
})

// ── 三平台路径 ──────────────────────────────────────────────────────
await test('Windows 临时目录被排除', () => {
  assert.equal(isDeliverablePath('C:\\Users\\x\\AppData\\Local\\Temp\\a.md'), false)
})

await test('Linux /tmp 被排除', () => {
  assert.equal(isDeliverablePath('/tmp/abc/output.md'), false)
  assert.equal(isDeliverablePath('/var/tmp/x/y.md'), false)
})

await test('macOS /var/folders 被排除', () => {
  assert.equal(isDeliverablePath('/var/folders/xy/abc/T/tmp123.md'), false)
})

await test('三平台的真实项目文件都被保留', () => {
  assert.equal(isDeliverablePath('E:\\proj\\docs\\a.md'), true, 'Windows')
  assert.equal(isDeliverablePath('/home/u/proj/docs/a.md'), true, 'Linux')
  assert.equal(isDeliverablePath('/Users/u/proj/docs/a.md'), true, 'macOS')
})

await test('node_modules 三平台都排除', () => {
  assert.equal(isDeliverablePath('C:\\p\\node_modules\\a\\b.js'), false)
  assert.equal(isDeliverablePath('/p/node_modules/a/b.js'), false)
})

await test('常见构建产物目录被排除', () => {
  for (const p of ['/p/dist/a.js', '/p/build/a.js', '/p/target/a.jar', '/p/.next/a.js', '/p/__pycache__/a.pyc']) {
    assert.equal(isDeliverablePath(p), false, p)
  }
})

// ── 归类不依赖本机 ──────────────────────────────────────────────────
await test('任意会话列表都能建树', () => {
  const items = prepareSessions([
    { sessionId: 'a', title: 'Session A', firstPrompt: 'About X', turns: 3 },
    { sessionId: 'b', title: 'Session B', firstPrompt: 'About Y', turns: 5 },
  ])
  const tree = buildCategoryTree(items, [
    { category: 'Cat1', sub: 'Sub1' },
    { category: 'Cat2', sub: 'Sub2' },
  ])
  assert.equal(tree.length, 2)
  assert.equal(tree[0].subcategories[0].sessions[0].sessionId, 'a')
})

await test('空列表不崩', () => {
  assert.equal(buildCategoryTree([], []).length, 0)
})

await test('会话标题是任意语言都能归类', () => {
  const items = prepareSessions([
    { sessionId: 'x', title: 'English Title', firstPrompt: 'hello', turns: 1 },
    { sessionId: 'y', title: '日本語タイトル', firstPrompt: 'こんにちは', turns: 1 },
    { sessionId: 'z', title: '中文标题', firstPrompt: '你好', turns: 1 },
  ])
  const tree = buildCategoryTree(items, [
    { category: 'A', sub: 'a' }, { category: 'A', sub: 'a' }, { category: 'B', sub: 'b' },
  ])
  assert.equal(tree.length, 2)
  assert.equal(tree[0].count, 2)
})

// ── 冷启动（新装环境，没有任何历史数据）────────────────────────────
await test('全新环境：空会话不崩', async () => {
  const p = await buildSessionPayloadParts([], 'brand-new')
  assert.equal(p.turns.length, 0)
  assert.equal(p.lanes.length, 0)
})

await test('全新环境：空会话列表能出空树', () => {
  assert.deepEqual(buildCategoryTree(prepareSessions([]), []), [])
})

await test('全新环境：第一轮对话就能出图', async () => {
  const p = await buildSessionPayloadParts(makeLog(1), 'first-ever')
  assert.equal(p.turns.length, 1)
  assert.ok(p.lanes.length >= 1)
  assert.ok(p.graph.nodes.length >= 1)
})

await test('全新环境：单个会话也能归类', () => {
  const items = prepareSessions([{ sessionId: 'x', title: 'Hi', firstPrompt: 'hello', turns: 1 }])
  const tree = buildCategoryTree(items, [{ category: '闲聊', sub: '问候' }])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].count, 1)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
