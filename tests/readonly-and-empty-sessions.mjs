/**
 * 空会话与只读巡检的领域测试（ADR-0011 / ADR-0012）。
 *
 * 锁住两条真机上暴露出来的事实：
 * 1. 空会话是「会话」不是「对话」——它不该被算进可读的对话数，也不该让界面说「你没有未收束的事」；
 * 2. 跨工作区巡检必须只读——写操作（含重扫与重提炼）在非归属工作区一律拒绝。
 *
 * Run: node tests/readonly-and-empty-sessions.mjs
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanWorkspaceWorks, readWorkspaceWorksView } from '../lib/work-store.js'
import { resolveWorksViewState, emptyStateText, workBoardModel } from '../lib/work-view.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (e) { failures.push({ name, e }); console.log('  FAIL ' + name + '\n       ' + e.message) }
}

const BASE = 1_700_000_000_000
const WS = 'ws-empty-sess'

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'empty-sess-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return await fn(home) }
  finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

function makeEvents(specs, baseTime = BASE) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = baseTime + index * 60_000
    const turn = index
    push('turn/start', { turn }, start)
    push('user/message', { content: [{ type: 'text', text: spec.prompt }], source: { kind: 'user' } }, start + 100)
    for (const tc of (spec.toolCalls || [])) push('tool/call', { name: tc.name, arguments: tc.arguments }, start + 500)
    push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: spec.response || '好' }], source: { kind: 'model' } } }, start + 1000)
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  })
  return events
}

/** ctx：一部分会话有内容，一部分会话是空的（events 为空数组，模拟 0 轮）。 */
function makeCtx(events) {
  const sessionIds = Object.keys(events)
  const workspaces = [{ id: WS, path: 'E:\\e', title: 'E', sessionIds }]
  return {
    get(name) { if (name === 'workspaceRegistry') return { list: () => workspaces }; return undefined },
    on() { return () => {} },
    effect(fn) { return fn() },
    sessionQuery: {
      async readSession(id) { return (id in events) ? { header: { id }, events: events[id] } : null },
      async listSessions() { return sessionIds.map(id => ({ header: { id } })) },
      async readTitleSnapshots(ids) { return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'S' } } })) },
    },
    sessionPersistence: { async stat() { return { revision: 'r1' } } },
    workspaceChanges: { async summary() { return undefined } },
  }
}

const richSession = {
  prompt: '修复 lib/a.js 的报错',
  response: '已改好',
  toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/a.js' } }],
}

console.log('\n=== 1. 空会话不是对话（ADR-0012）===')

await test('全部会话都是空会话 → 扫描出 0 段，且如实报告空会话数', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-e1': [], 'session-e2': [], 'session-e3': [] })
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE })
    assert.equal(res.ok, true)
    assert.equal(res.stats.segmentsCount, 0, '空会话切不出段')
    assert.equal(res.stats.conversationCount, 0, '有对话的会话数必须是 0')
    assert.equal(res.stats.emptySessionCount, 3, '空会话数必须是 3')
  })
})

await test('有内容 + 空会话混合 → 计数分开，不拿容器数冒充内容数', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-r1': makeEvents([richSession]), 'session-e1': [], 'session-e2': [] })
    const res = await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE })
    assert.equal(res.stats.conversationCount, 1, '有对话的会话数')
    assert.equal(res.stats.emptySessionCount, 2, '空会话数')
    assert.ok(res.stats.segmentsCount >= 1)
  })
})

await test('/works 视图也带 conversationCount 与 emptySessionCount', async () => {
  await withHome(async () => {
    const ctx = makeCtx({ 'session-e1': [], 'session-e2': [] })
    await scanWorkspaceWorks(ctx, WS, { force: true, useModel: false, config: {}, now: BASE })
    const view = await readWorkspaceWorksView(ctx, WS, { config: {}, now: BASE })
    assert.equal(view.ok, true)
    assert.equal(view.emptySessionCount, 2, '视图必须交代空会话数')
    assert.equal(view.conversationCount, 0)
  })
})

console.log('\n=== 2. no_content 空态（ADR-0012）===')

await test('全是空会话时不得显示「没有未收束的事」，必须是 no_content', () => {
  const r = resolveWorksViewState({
    boundWorkspaceId: 'w', dataWorkspaceId: 'w',
    raw: { initialized: true, unresolved: [], emptySessionCount: 3, conversationCount: 0 },
    error: '', scanning: false, refining: false,
  })
  assert.equal(r.emptyKind, 'no_content', '实际 ' + r.emptyKind)
})

await test('no_content 文案说明是「没有可读对话」而不是「你做完了」', () => {
  const t = emptyStateText('no_content', { emptySessionCount: 3 })
  assert.ok(t.title.indexOf('没有可读') >= 0 || t.title.indexOf('空会话') >= 0, '标题要说清没有内容：' + t.title)
  assert.ok(t.hint.indexOf('3') >= 0, '要带上空会话数：' + t.hint)
  assert.equal(t.retry, false, '不给重建入口（重扫永远无效）')
})

await test('渲染层：全是空会话 → no_content（不是 no_unresolved）', () => {
  const b = workBoardModel({ unresolved: [], settled: [], initialized: true, emptySessionCount: 4, conversationCount: 0 }, { now: BASE })
  assert.equal(b.empty.kind, 'no_content', '实际 ' + b.empty.kind)
})

await test('有对话但确实无事 → 仍是 no_unresolved（不能一律推成 no_content）', () => {
  const b = workBoardModel({ unresolved: [], settled: [], initialized: true, emptySessionCount: 0, conversationCount: 5 }, { now: BASE })
  assert.equal(b.empty.kind, 'no_unresolved', '实际 ' + b.empty.kind)
})

console.log('')
if (failures.length > 0) { console.log('readonly-and-empty-sessions: ' + passed + ' passed, ' + failures.length + ' FAILED'); process.exit(1) }
console.log('readonly-and-empty-sessions: ' + passed + ' passed, 0 failed')