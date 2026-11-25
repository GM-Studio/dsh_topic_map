/**
 * 重试端点测试（POST /api/topic-map/retry）。
 *
 * 锁：语义 = 第 N 轮之前分叉 + 重新提交该轮 prompt；同会话同轮 5 分钟内
 * 去重（并发也只执行一次），过后可再执行；空 prompt 400、轮次不存在 404、
 * 运行中 409、提交失败 502 且错误里带出新会话 id。
 *
 * Run: node tests/retry.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushIndexSyncs, retryTurn } from '../lib/index.js'
import { createRetryDeduper } from '../lib/fork.js'

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
const SESSION = 'session-55556666-aaaa-4bbb-8ccc-000000000001'
const NEW_ID = 'session-eeee0000-1111-4222-8333-555555555555'

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
  const calls = { fork: [], prompt: [], list: 0 }
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
      if (typeof options.promptError === 'function') {
        const error = options.promptError(request, calls.prompt.length)
        if (error !== undefined) throw error
      }
      return { accepted: true }
    },
    async rename() {
      return { title: 'x', seq: 1 }
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
      async stat() {
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
  const home = await mkdtemp(join(tmpdir(), 'retry-'))
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

console.log('\nretry')

await test('正常：先分叉再提交该轮 prompt', async () => {
  const controller = makeController()
  const ctx = makeCtx({
    events: { [SESSION]: makeEvents([{ prompt: 'q0' }, { prompt: '要重试的提问' }, { prompt: 'q2' }]) },
    controller,
  })
  const registry = createRetryDeduper()
  const result = await retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry })
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(result.value, { sessionId: NEW_ID, prompt: '要重试的提问' })
  assert.deepEqual(controller.calls.fork, [{ sessionId: SESSION, atSeq: 3 }])
  assert.equal(controller.calls.prompt.length, 1)
  const submitted = controller.calls.prompt[0]
  assert.equal(submitted.sessionId, NEW_ID)
  assert.equal(submitted.mode, 'queue')
  assert.deepEqual(submitted.content, [{ type: 'text', text: '要重试的提问' }])
  assert.ok(typeof submitted.requestId === 'string' && submitted.requestId.length > 0)
})

await test('去重：同会话同轮 5 分钟内返回既有结果，只执行一次', async () => {
  const controller = makeController()
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}, { prompt: 'retry me' }, {}]) }, controller })
  let clock = 1_000_000
  const registry = createRetryDeduper({ now: () => clock })
  const first = await retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry })
  clock += 60_000
  const second = await retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry })
  assert.equal(first.ok, true, first.error)
  assert.deepEqual(second, first)
  assert.equal(controller.calls.fork.length, 1)
  assert.equal(controller.calls.prompt.length, 1)
})

await test('并发去重：同会话同轮同时到达只执行一次', async () => {
  const controller = makeController()
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}, { prompt: 'retry me' }]) }, controller })
  const registry = createRetryDeduper()
  const [a, b] = await Promise.all([
    retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry }),
    retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry }),
  ])
  assert.equal(a.ok, true, a.error)
  assert.deepEqual(a, b)
  assert.equal(controller.calls.fork.length, 1)
  assert.equal(controller.calls.prompt.length, 1)
})

await test('边界：超过 5 分钟后允许再次执行', async () => {
  const controller = makeController()
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}, { prompt: 'retry me' }]) }, controller })
  let clock = 2_000_000
  const registry = createRetryDeduper({ now: () => clock })
  await retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry })
  clock += 5 * 60 * 1000 + 1
  await retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry })
  assert.equal(controller.calls.fork.length, 2)
})

await test('空 prompt → 400，不分叉；第 0 轮带提问也因无历史而 400', async () => {
  const controller = makeController()
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{ prompt: 'q0' }, { prompt: '' }]) }, controller })
  const registry = createRetryDeduper()
  const result = await retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry })
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 400)
  assert.match(result.error, /没有可重试的提问/)
  assert.equal(controller.calls.fork.length, 0)

  const first = await retryTurn(ctx, { sessionId: SESSION, turn: 0 }, { registry })
  assert.equal(first.ok, false)
  assert.equal(first.httpStatus, 400)
  assert.match(first.error, /之前没有可复制的历史/)
})

await test('轮次不存在 → 404；会话不存在 → 404', async () => {
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}]) } })
  const registry = createRetryDeduper()
  const missingTurn = await retryTurn(ctx, { sessionId: SESSION, turn: 5 }, { registry })
  assert.equal(missingTurn.ok, false)
  assert.equal(missingTurn.httpStatus, 404)

  const missingSession = makeCtx({ readSession: async () => null })
  const missing = await retryTurn(missingSession, { sessionId: SESSION, turn: 0 }, { registry })
  assert.equal(missing.ok, false)
  assert.equal(missing.httpStatus, 404)
  assert.match(missing.error, /会话不存在/)
})

await test('会话运行中 → 409', async () => {
  const controller = makeController({ items: [{ sessionId: SESSION, running: true }] })
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}, { prompt: 'x' }]) }, controller })
  const result = await retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry: createRetryDeduper() })
  assert.equal(result.ok, false)
  assert.equal(result.httpStatus, 409)
  assert.match(result.error, /正在运行/)
})

await test('提交失败 → 502，错误里带新会话 id；失败后可重试成功', async () => {
  let attempts = 0
  const controller = makeController({
    promptError: () => {
      attempts += 1
      return attempts === 1 ? Object.assign(new Error('prompt rejected'), { code: 'gateway/internal' }) : undefined
    },
  })
  const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}, { prompt: 'retry me' }]) }, controller })
  const registry = createRetryDeduper()
  const failed = await retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry })
  assert.equal(failed.ok, false)
  assert.equal(failed.httpStatus, 502)
  assert.match(failed.error, /重新提交提问失败/)
  assert.ok(failed.error.includes(NEW_ID), '错误文案要告诉用户新会话已经建出来了')

  const retried = await retryTurn(ctx, { sessionId: SESSION, turn: 1 }, { registry })
  assert.equal(retried.ok, true, '失败不应占用 5 分钟去重窗口')
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
