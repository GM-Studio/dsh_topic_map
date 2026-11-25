/**
 * 工作区统计端点测试（POST /api/topic-map/stats）。
 *
 * 锁：sessions/turns 计数、本地自然日 activeDays 去重、topSessions 排序与
 * 字段、usage 汇总、索引优先/日志兜底、标题读取、工作区不存在 404、
 * 空工作区零值、全部读不到 502。
 *
 * Run: node tests/stats-endpoint.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushIndexSyncs, readWorkspaceStats, syncSessionIndexFor } from '../lib/index.js'

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`  FAIL ${name}\n       ${error.message}`)
  }
}

const WS = 'ws-stats-1'
const SESSION_A = 'session-99990000-aaaa-4bbb-8ccc-000000000001'
const SESSION_B = 'session-99990000-bbbb-4bbb-8ccc-000000000002'

/** 用本地时间构造时间戳，避免时区差异导致自然日漂移。 */
function localTime(year, month, day, hour = 10, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime()
}

function makeEvents(specs) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = spec.start ?? (localTime(2026, 1, 5) + index * 60_000)
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `问题 ${turn}` }],
      source: { kind: 'user' },
    }, start + 100)
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `回答 ${turn}` }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
      usage: spec.usage,
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  })
  return events
}

function makeCtx(options = {}) {
  const events = options.events ?? {}
  const workspaces = options.workspaces ?? [{
    id: WS,
    path: 'E:\\ws',
    title: '统计工作区',
    sessionIds: options.sessionIds ?? [SESSION_A],
  }]
  return {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      return undefined
    },
    sessionQuery: {
      async readSession(id) {
        if (typeof options.readSession === 'function') return options.readSession(id)
        return { events: events[id] ?? [] }
      },
      async readTitleSnapshots(ids) {
        if (options.titles === 'unavailable') throw new Error('titles unavailable')
        return ids.map(sessionId => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: options.titles?.[sessionId] ?? sessionId } },
        }))
      },
      async listSessions() {
        return options.records ?? []
      },
    },
    sessionPersistence: {
      async stat(id) {
        if (typeof options.stat === 'function') return options.stat(id)
        return { revision: options.revisions?.[id] ?? 'rev-1' }
      },
    },
    workspaceChanges: {
      async summary() {
        return undefined
      },
    },
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'stats-endpoint-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    await flushIndexSyncs()
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

const USAGE_A = { inputTokens: 100, outputTokens: 40 }
const USAGE_A2 = { inputTokens: 50, outputTokens: 10 }
const USAGE_B = { inputTokens: 200, outputTokens: 60 }

console.log('\nstats-endpoint')

await test('正常：会话/轮次/活跃日/topSessions/用量', async () => {
  const ctx = makeCtx({
    events: {
      [SESSION_A]: makeEvents([
        { start: localTime(2026, 1, 5, 10), usage: USAGE_A },
        { start: localTime(2026, 1, 5, 15), usage: USAGE_A2 },
        { start: localTime(2026, 1, 6, 9), usage: USAGE_A },
      ]),
      [SESSION_B]: makeEvents([
        { start: localTime(2026, 1, 6, 11), usage: USAGE_B },
      ]),
    },
    sessionIds: [SESSION_A, SESSION_B],
    titles: { [SESSION_A]: '会话甲', [SESSION_B]: '会话乙' },
  })
  const result = await readWorkspaceStats(ctx, { workspaceId: WS })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.value.sessions, 2)
  assert.equal(result.value.turns, 4)
  assert.equal(result.value.activeDays, 2, '1/5 两轮 + 1/6 两轮，只算 2 个自然日')
  assert.deepEqual(result.value.topSessions[0], {
    sessionId: SESSION_A,
    title: '会话甲',
    turns: 3,
    lastActive: localTime(2026, 1, 6, 9) + 5000,
  })
  assert.deepEqual(result.value.topSessions[1], {
    sessionId: SESSION_B,
    title: '会话乙',
    turns: 1,
    lastActive: localTime(2026, 1, 6, 11) + 5000,
  })
  assert.deepEqual(result.value.usage, { input: 450, output: 150, total: 600 })
})

await test('活跃日：同一自然日多轮只算 1 天，跨天算 2 天', async () => {
  const ctx = makeCtx({
    events: {
      [SESSION_A]: makeEvents([
        { start: localTime(2026, 3, 1, 0, 5) },
        { start: localTime(2026, 3, 1, 23, 55) },
        { start: localTime(2026, 3, 2, 0, 1) },
      ]),
    },
    sessionIds: [SESSION_A],
  })
  const result = await readWorkspaceStats(ctx, { workspaceId: WS })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.value.activeDays, 2)
})

await test('排序边界：同轮数按最后活动倒序，topSessions 最多 5 条', async () => {
  const ids = []
  const events = {}
  for (let index = 0; index < 7; index += 1) {
    const id = `session-aaaa0000-0000-4000-8000-00000000000${index}`
    ids.push(id)
    events[id] = makeEvents([{ start: localTime(2026, 2, 1) + index * 1000 }])
  }
  const ctx = makeCtx({ events, sessionIds: ids })
  const result = await readWorkspaceStats(ctx, { workspaceId: WS })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.value.topSessions.length, 5)
  assert.equal(result.value.topSessions[0].sessionId, ids[6], '最后活动的同轮数会话排第一')
  assert.equal(result.value.topSessions[4].sessionId, ids[2])
})

await test('索引优先 + 日志兜底：索引会话不读日志，缺失会话读日志', async () => {
  await withTempHome(async () => {
    const eventsA = makeEvents([{ start: localTime(2026, 4, 1) }, { start: localTime(2026, 4, 2) }])
    const eventsB = makeEvents([{ start: localTime(2026, 4, 3) }])
    let blockLogs = false
    const ctx = makeCtx({
      events: { [SESSION_A]: eventsA, [SESSION_B]: eventsB },
      sessionIds: [SESSION_A, SESSION_B],
      readSession: async id => {
        if (id === SESSION_A && blockLogs) throw new Error('索引命中时不该读日志')
        return { events: id === SESSION_A ? eventsA : eventsB }
      },
    })
    await syncSessionIndexFor(ctx, SESSION_A)
    blockLogs = true
    const result = await readWorkspaceStats(ctx, { workspaceId: WS })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.sessions, 2)
    assert.equal(result.value.turns, 3)
    assert.equal(result.value.activeDays, 3)
  })
})

await test('工作区不存在 → 404；未给 workspaceId 时用第一个工作区', async () => {
  const ctx = makeCtx({ events: { [SESSION_A]: makeEvents([{}]) }, sessionIds: [SESSION_A] })
  const missing = await readWorkspaceStats(ctx, { workspaceId: 'ws-not-exist' })
  assert.equal(missing.ok, false)
  assert.equal(missing.httpStatus, 404)
  assert.match(missing.error, /工作区不存在/)

  const fallback = await readWorkspaceStats(ctx, {})
  assert.equal(fallback.ok, true, fallback.error)
  assert.equal(fallback.value.sessions, 1)
})

await test('空工作区：零值而不是报错', async () => {
  const ctx = makeCtx({ events: {}, sessionIds: [] })
  const result = await readWorkspaceStats(ctx, { workspaceId: WS })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.value, {
    sessions: 0,
    turns: 0,
    activeDays: 0,
    topSessions: [],
    usage: { input: 0, output: 0, total: 0 },
  })
})

await test('没有工作区可用 → 404；会话全部读不到 → 502', async () => {
  const none = makeCtx({ workspaces: [] })
  const missing = await readWorkspaceStats(none, {})
  assert.equal(missing.ok, false)
  assert.equal(missing.httpStatus, 404)

  const broken = makeCtx({
    sessionIds: [SESSION_A, SESSION_B],
    readSession: async () => {
      throw new Error('disk gone')
    },
  })
  const failed = await readWorkspaceStats(broken, { workspaceId: WS })
  assert.equal(failed.ok, false)
  assert.equal(failed.httpStatus, 502)
  assert.match(failed.error, /读不到/)
})

await test('参数错误：workspaceId 非字符串 → 400', async () => {
  const ctx = makeCtx({ events: { [SESSION_A]: makeEvents([{}]) }, sessionIds: [SESSION_A] })
  for (const workspaceId of [123, {}]) {
    const result = await readWorkspaceStats(ctx, { workspaceId })
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 400)
    assert.match(result.error, /workspaceId/)
  }
})

await test('读取超时 → 504', async () => {
  const hanging = makeCtx({
    sessionIds: [SESSION_A],
    readSession: async () => new Promise(() => {}),
  })
  const result = await readWorkspaceStats(hanging, { workspaceId: WS }, { timeoutMs: 10 })
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 504)
  assert.match(result.error, /超时/)
})

await test('标题不可用/用量缺失：退回 sessionId、用量记 0', async () => {
  const ctx = makeCtx({
    events: { [SESSION_A]: makeEvents([{ usage: { inputTokens: 'x', outputTokens: -5 } }]) },
    sessionIds: [SESSION_A],
    titles: 'unavailable',
  })
  const result = await readWorkspaceStats(ctx, { workspaceId: WS })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.value.topSessions[0].title, SESSION_A)
  assert.deepEqual(result.value.usage, { input: 0, output: 0, total: 0 })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
