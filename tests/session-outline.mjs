/**
 * 会话大纲端点测试（POST /api/topic-map/session-outline）。
 *
 * 锁：字段投影（不含全文）、promptHead ≤ 60 字且压平换行、时间取
 * turn/end 优先、索引优先/日志兜底、空会话返回空数组、参数 400、
 * 会话不存在 404、读取失败 502、超时 504。
 *
 * Run: node tests/session-outline.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushIndexSyncs, readSessionOutline, syncSessionIndexFor } from '../lib/index.js'

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

const BASE_TIME = 1_700_000_000_000
const SESSION = 'session-11112222-aaaa-4bbb-8ccc-000000000001'

/** 造事件流；`seq` 从 0 连续递增，turn/end 的 seq 就是 endSeq。 */
function makeEvents(specs) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = BASE_TIME + index * 60_000
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `问题 ${turn}` }],
      source: { kind: 'user' },
    }, start + 100)
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `回答 ${turn}` }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, start + 5000)
  })
  return events
}

/** 假 Host context：readSession / stat 都可注入。 */
function makeCtx(options = {}) {
  const events = options.events ?? {}
  return {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [] }
      return undefined
    },
    sessionQuery: {
      async readSession(id) {
        if (typeof options.readSession === 'function') return options.readSession(id)
        return { events: events[id] ?? [] }
      },
      async readTitleSnapshots(ids) {
        return ids.map(sessionId => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: `标题 ${sessionId}` } },
        }))
      },
      async listSessions() {
        return []
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
  const home = await mkdtemp(join(tmpdir(), 'session-outline-'))
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

console.log('\nsession-outline')

await test('正常：字段投影完整、不夹带全文、时间取 turn/end', async () => {
  const ctx = makeCtx({
    events: {
      [SESSION]: makeEvents([
        { prompt: '第一轮的问题', response: '第一轮的回答' },
        { prompt: '第二轮的问题', response: '第二轮的回答', endReason: 'aborted' },
      ]),
    },
  })
  const result = await readSessionOutline(ctx, { sessionId: SESSION })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.value.turns.length, 2)
  assert.deepEqual(result.value.turns[0], {
    turn: 0,
    promptHead: '第一轮的问题',
    time: BASE_TIME + 5000,
    endReason: 'completed',
    endSeq: 3,
  })
  assert.equal(result.value.turns[1].turn, 1)
  assert.equal(result.value.turns[1].endReason, 'aborted')
  assert.equal(result.value.turns[1].time, BASE_TIME + 60_000 + 5000)
  assert.equal(result.value.turns[1].endSeq, 7)
  for (const row of result.value.turns) {
    assert.equal('prompt' in row, false, '大纲不能带提问全文')
    assert.equal('response' in row, false, '大纲不能带回答全文')
  }
})

await test('边界：promptHead 压平换行且不超过 60 字', async () => {
  const longPrompt = `${'很长的提问'.repeat(20)}\n\n第二段`
  const ctx = makeCtx({
    events: {
      [SESSION]: makeEvents([{ prompt: longPrompt, response: '答' }]),
    },
  })
  const result = await readSessionOutline(ctx, { sessionId: SESSION })
  assert.equal(result.ok, true, result.error)
  const head = result.value.turns[0].promptHead
  assert.equal(head.includes('\n'), false, 'promptHead 不能含换行')
  assert.ok(Array.from(head).length <= 60, `promptHead 长度 ${Array.from(head).length} 超过 60`)
})

await test('空会话：返回空数组而不是 404', async () => {
  const ctx = makeCtx({ events: { [SESSION]: [] } })
  const result = await readSessionOutline(ctx, { sessionId: SESSION })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.value, { turns: [] })
})

await test('索引优先：索引可用时不再读日志', async () => {
  await withTempHome(async () => {
    const events = makeEvents([
      { prompt: '索引里的第一轮' },
      { prompt: '索引里的第二轮' },
    ])
    let blockLogs = false
    const ctx = makeCtx({
      events: { [SESSION]: events },
      readSession: async () => {
        if (blockLogs) throw new Error('不该读日志')
        return { events }
      },
    })
    await syncSessionIndexFor(ctx, SESSION)
    blockLogs = true

    const result = await readSessionOutline(ctx, { sessionId: SESSION })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.turns.length, 2)
    assert.equal(result.value.turns[0].promptHead, '索引里的第一轮')
  })
})

await test('参数错误：sessionId 缺失/空白 → 400', async () => {
  const ctx = makeCtx()
  for (const body of [{}, { sessionId: '' }, { sessionId: '   ' }, null]) {
    const result = await readSessionOutline(ctx, body)
    assert.equal(result.ok, false)
    assert.equal(result.error, 'sessionId required')
    assert.equal(result.httpStatus, 400)
  }
})

await test('会话不存在 → 404（含宿主抛 not-found 错误的形态）', async () => {
  const ctx = makeCtx({ readSession: async () => null })
  const result = await readSessionOutline(ctx, { sessionId: SESSION })
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 404)
  assert.match(result.error, /会话不存在/)

  const thrown = makeCtx({
    readSession: async () => {
      throw Object.assign(new Error(`session "${SESSION}" not found`), {
        code: 'SESSION_QUERY_SESSION_NOT_FOUND',
      })
    },
  })
  const byThrow = await readSessionOutline(thrown, { sessionId: SESSION })
  assert.equal(byThrow.ok, false)
  assert.equal(byThrow.httpStatus, 404, '真实宿主对缺失会话是抛错，不能误报 502')
  assert.match(byThrow.error, /会话不存在/)
})

await test('读取失败 → 502；超时 → 504', async () => {
  const broken = makeCtx({
    readSession: async () => {
      throw new Error('disk on fire')
    },
  })
  const failed = await readSessionOutline(broken, { sessionId: SESSION })
  assert.equal(failed.ok, false)
  assert.equal(failed.httpStatus, 502)
  assert.match(failed.error, /读不到该会话/)

  const hanging = makeCtx({ readSession: async () => new Promise(() => {}) })
  const timedOut = await readSessionOutline(hanging, { sessionId: SESSION }, { timeoutMs: 10 })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.httpStatus, 504)
  assert.match(timedOut.error, /超时/)
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
