/**
 * 分叉端点测试（POST /api/topic-map/fork）。
 *
 * 锁：`atSeq = turn/start 的 seq - 1`（宿主 atSeq 是 inclusive 边界）、
 * 首轮不可分叉 400、轮次不存在 404、会话不存在 404、会话运行中 409、
 * 宿主义务不可用 503、宿主错误码映射为中文、title 会改名新会话。
 *
 * Run: node tests/fork.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushIndexSyncs, forkSession } from '../lib/index.js'

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
const SESSION = 'session-33334444-aaaa-4bbb-8ccc-000000000001'
const NEW_ID = 'session-ffff0000-1111-4222-8333-444444444444'

/** 每轮 4 个事件：turn/start(seq=4n)、user、assistant、turn/end(seq=4n+3)。 */
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
        content: [{ type: 'text', text: `回答 ${turn}` }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  })
  return events
}

function makeController(options = {}) {
  const calls = { fork: [], prompt: [], rename: [], list: 0 }
  return {
    calls,
    async list() {
      calls.list += 1
      return { items: options.items ?? [{ sessionId: SESSION, running: false }] }
    },
    async fork(request) {
      calls.fork.push(request)
      if (options.forkError !== undefined) throw options.forkError
      return { sessionId: options.newId ?? NEW_ID }
    },
    async prompt(request) {
      calls.prompt.push(request)
      return { accepted: true }
    },
    async rename(request) {
      calls.rename.push(request)
      return { title: request.title, seq: 99 }
    },
  }
}

function makeCtx(options = {}) {
  const events = options.events ?? {}
  const services = new Map()
  if (options.controller !== null) services.set('sessionController', options.controller ?? makeController())
  return {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => [] }
      return services.get(name)
    },
    sessionQuery: {
      async readSession(id) {
        if (typeof options.readSession === 'function') return options.readSession(id)
        return { events: events[id] ?? [] }
      },
    },
    sessionPersistence: {
      async stat(id) {
        if (typeof options.stat === 'function') return options.stat(id)
        return { revision: 'rev-1' }
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
  const home = await mkdtemp(join(tmpdir(), 'fork-'))
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

console.log('\nfork')

await test('正常：第 2 轮之前分叉，atSeq = turn/start seq - 1', async () => {
  const controller = makeController()
  const ctx = makeCtx({
    events: { [SESSION]: makeEvents([{ prompt: 'q0' }, { prompt: 'q1' }, { prompt: 'q2' }]) },
    controller,
  })
  const result = await forkSession(ctx, { sessionId: SESSION, turn: 2 })
  assert.equal(result.ok, true, result.error)
  // 第 2 轮的 turn/start seq = 8；inclusive 边界要退一格 → 7（第 1 轮 turn/end）。
  assert.deepEqual(result.value, { sessionId: NEW_ID, atSeq: 7, turn: 2 })
  assert.deepEqual(controller.calls.fork, [{ sessionId: SESSION, atSeq: 7 }])
})

await test('边界：第 0 轮之前没有历史 → 400，不调用宿主', async () => {
  const controller = makeController()
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}]) }, controller })
  const result = await forkSession(ctx, { sessionId: SESSION, turn: 0 })
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 400)
  assert.match(result.error, /之前没有可复制的历史/)
  assert.equal(controller.calls.fork.length, 0)
})

await test('参数错误：turn 非整数/sessionId 缺失 → 400', async () => {
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}, {}]) } })
  for (const body of [
    {},
    { sessionId: SESSION },
    { sessionId: SESSION, turn: -1 },
    { sessionId: SESSION, turn: 1.5 },
    { sessionId: SESSION, turn: '1' },
    { sessionId: SESSION, turn: 1, title: 123 },
  ]) {
    const result = await forkSession(ctx, body)
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 400)
    assert.ok(result.error.length > 0)
  }
})

await test('轮次不存在 → 404', async () => {
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}]) } })
  const result = await forkSession(ctx, { sessionId: SESSION, turn: 9 })
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 404)
  assert.match(result.error, /没有第 9 轮/)
})

await test('会话不存在 → 404（null 与宿主抛 not-found 两种形态）', async () => {
  const ctx = makeCtx({ readSession: async () => null })
  const result = await forkSession(ctx, { sessionId: SESSION, turn: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 404)
  assert.match(result.error, /会话不存在/)

  const thrown = makeCtx({
    readSession: async () => {
      throw Object.assign(new Error('session not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
    },
  })
  const byThrow = await forkSession(thrown, { sessionId: SESSION, turn: 1 })
  assert.equal(byThrow.ok, false)
  assert.equal(byThrow.httpStatus, 404)
})

await test('会话运行中 → 409，不调用宿主 fork', async () => {
  const controller = makeController({ items: [{ sessionId: SESSION, running: true }] })
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}, {}]) }, controller })
  const result = await forkSession(ctx, { sessionId: SESSION, turn: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 409)
  assert.match(result.error, /正在运行/)
  assert.equal(controller.calls.fork.length, 0)
})

await test('宿主未提供分叉服务 → 503', async () => {
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}, {}]) }, controller: null })
  const result = await forkSession(ctx, { sessionId: SESSION, turn: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 503)
  assert.match(result.error, /未提供分叉服务/)
})

await test('宿主错误码映射中文：fork-unavailable → 409', async () => {
  const error = Object.assign(new Error('event 3 does not exist in session "x"'), { code: 'session/fork-unavailable' })
  const controller = makeController({ forkError: error })
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}, {}]) }, controller })
  const result = await forkSession(ctx, { sessionId: SESSION, turn: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 409)
  assert.match(result.error, /分叉位置不可用/)
  assert.equal(result.error.includes('does not exist'), false, '错误文案应为中文，不夹带宿主英文原文')
})

await test('title：给新会话改名；改名失败不影响分叉结果', async () => {
  const controller = makeController()
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}, {}]) }, controller })
  const result = await forkSession(ctx, { sessionId: SESSION, turn: 1, title: '  新分支标题  ' })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(controller.calls.rename, [{ sessionId: NEW_ID, title: '新分支标题' }])

  const failing = makeController()
  failing.rename = async () => {
    throw new Error('rename down')
  }
  const ctx2 = makeCtx({ events: { [SESSION]: makeEvents([{}, {}]) }, controller: failing })
  const result2 = await forkSession(ctx2, { sessionId: SESSION, turn: 1, title: '标题' })
  assert.equal(result2.ok, true, '改名只是装饰，不该拖垮分叉')
})

await test('读取失败 → 502；超时 → 504', async () => {
  const broken = makeCtx({
    readSession: async () => {
      throw new Error('disk on fire')
    },
  })
  const failed = await forkSession(broken, { sessionId: SESSION, turn: 1 })
  assert.equal(failed.ok, false)
  assert.equal(failed.httpStatus, 502)

  const hanging = makeCtx({ readSession: async () => new Promise(() => {}) })
  const timedOut = await forkSession(hanging, { sessionId: SESSION, turn: 1 }, { timeoutMs: 10 })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.httpStatus, 504)
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
