/**
 * POST /work-refine-retry 端点契约测试（ADR-0010）。
 *
 * 这条端点是"提炼失败后用户能自救"的出口，因此契约有三条硬要求：
 * 1. **workspaceId 必填**——缺了/写错必须 400/404，绝不静默退化成"第一个工作区"
 *    （否则用户对 A 的重试会打到 B 上，两边状态都被改坏）；
 * 2. **返回形状与 /works 完全一致**——多一个少一个字段都会让客户端解包崩掉；
 * 3. **强制带模型重跑**——上一次提炼失败（no_model / failed）后，
 *    重试必须真的再调一次模型，并把最新的 refineStatus 带回来。
 *
 * 只测导出函数与路由处理器，不起真实 HTTP 服务、不用 child_process。
 *
 * Run: node tests/refine-retry-endpoint.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { apply } from '../lib/index.js'

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

// 端点内部用的是真实 Date.now() 判沉降，所以夹具必须贴近"现在"，
// 否则会话一造出来就超过 dormantDays，卡片会被沉降成 settled 而看不到。
const BASE_TIME = Date.now() - 5 * 60_000
const WS = 'ws-retry-1'
const WS_OTHER = 'ws-retry-2'

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'refine-retry-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

function makeEvents(specs, baseTime = BASE_TIME) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = spec.start ?? (baseTime + index * 60_000)
    const end = spec.end ?? (start + 5_000)
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `问题 ${turn}` }],
      source: { kind: 'user' },
    }, start + 100)
    if (Array.isArray(spec.toolCalls)) {
      for (const tc of spec.toolCalls) {
        push('tool/call', { name: tc.name, arguments: tc.arguments ?? {} }, start + 500)
      }
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `回答 ${turn}` }],
        source: { kind: 'model', provider: 'fake', model: 'fake-1' },
      },
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, end)
  })
  return events
}

function makeCtx(events, llm) {
  const sessionIds = Object.keys(events)
  const workspaces = [
    { id: WS, path: 'E:\\retry-ws', title: '重试测试工作区', sessionIds },
    { id: WS_OTHER, path: 'E:\\retry-ws-2', title: '另一个工作区', sessionIds: [] },
  ]
  const registeredRoutes = []
  const webScope = {
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(config) {
          registeredRoutes.push(config)
          return () => {}
        },
      }
    },
    effect(fn) { return fn() },
  }
  const ctx = {
    _routes: registeredRoutes,
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      if (name === 'llm') return llm
      return undefined
    },
    on() { return () => {} },
    effect(fn) { return fn() },
    inject(names, callback) {
      if (names.includes('webServer')) callback(webScope)
    },
    sessionQuery: {
      async readSession(id) {
        if (!(id in events)) return null
        return { header: { id }, events: events[id] }
      },
      async listSessions() {
        return sessionIds.map(id => ({ header: { id } }))
      },
      async readTitleSnapshots(ids) {
        return ids.map(sessionId => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: `会话 ${sessionId.slice(0, 12)}` } },
        }))
      },
    },
    sessionPersistence: { async stat() { return { revision: 'rev-1' } } },
    workspaceChanges: { async summary() { return undefined } },
  }
  return ctx
}

/** 假 llm：`responder` 返回正文或抛错。记录每次调用收到的 sessionId。 */
function makeFakeLlm(responder) {
  const state = { calls: 0, sessionIds: [] }
  return {
    get calls() { return state.calls },
    get sessionIds() { return state.sessionIds },
    async prepareCall(call) {
      state.calls += 1
      state.sessionIds.push(call.sessionId)
      return {
        config: { ...call, provider: 'fake', model: 'fake-1' },
        async *stream() {
          const out = typeof responder === 'function' ? await responder(call, state.calls) : responder
          if (out instanceof Error) throw out
          yield { type: 'text-delta', text: String(out ?? '') }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    listProviders() { return [{ id: 'fake' }] },
  }
}

async function callRoute(handler, method, action, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(payload)
  req.url = `/api/topic-map/${action}`
  req.method = method
  let status = 0
  let text = ''
  const res = {
    writeHead(code) { status = code },
    end(value) { text = value },
  }
  await handler(req, res)
  return { status, body: text === '' ? null : JSON.parse(text) }
}

function clusterIdsIn(prompt) {
  const ids = []
  const re = /\[(cl-\d+)\]/g
  let m = re.exec(prompt.messages?.[0]?.content?.[0]?.text ?? '')
  while (m !== null) {
    ids.push(m[1])
    m = re.exec(prompt.messages?.[0]?.content?.[0]?.text ?? '')
  }
  return ids
}

function refineReply(clusterIds, title) {
  return JSON.stringify({
    works: [{
      clusterIds,
      title,
      goal: '目标',
      state: 'active',
      statusSummary: '现状',
      nextStep: '下一步',
      decisions: [],
    }],
    chatClusterIds: [],
  })
}

const EVENTS = {
  'session-0000aaaa-1111-4aaa-8bbb-000000000000': makeEvents([{
    prompt: '实现 lib/retry-target.js 里的重试逻辑',
    response: '完成重试逻辑',
    toolCalls: [{ name: 'edit', arguments: { file_path: 'lib/retry-target.js' } }],
  }]),
}

console.log('\nrefine-retry-endpoint')

// ── 参数校验 ────────────────────────────────────────────────────────

await test('POST /work-refine-retry：缺 workspaceId → 400，且不触发任何模型调用', async () => {
  await withTempHome(async () => {
    const llm = makeFakeLlm('should not be called')
    const ctx = makeCtx(EVENTS, llm)
    apply(ctx)
    const handler = ctx._routes[0].handler

    const res = await callRoute(handler, 'POST', 'work-refine-retry', {})
    assert.equal(res.status, 400)
    assert.equal(res.body.ok, false)
    assert.equal(res.body.error, 'workspaceId required')
    assert.equal(llm.calls, 0, '校验失败不得触发模型调用')
  })
})

await test('POST /work-refine-retry：workspaceId 为空串/空白 → 400', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx(EVENTS, makeFakeLlm('x'))
    apply(ctx)
    const handler = ctx._routes[0].handler

    for (const bad of ['', '   ', null]) {
      const res = await callRoute(handler, 'POST', 'work-refine-retry', { workspaceId: bad })
      assert.equal(res.status, 400, `workspaceId=${JSON.stringify(bad)} 应 400`)
    }
  })
})

await test('POST /work-refine-retry：workspaceId 非字符串 → 400', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx(EVENTS, makeFakeLlm('x'))
    apply(ctx)
    const handler = ctx._routes[0].handler
    const res = await callRoute(handler, 'POST', 'work-refine-retry', { workspaceId: 123 })
    assert.equal(res.status, 400)
  })
})

await test('POST /work-refine-retry：workspaceId 不存在 → 404（不得静默退回第一个工作区）', async () => {
  await withTempHome(async () => {
    const llm = makeFakeLlm('x')
    const ctx = makeCtx(EVENTS, llm)
    apply(ctx)
    const handler = ctx._routes[0].handler
    const res = await callRoute(handler, 'POST', 'work-refine-retry', { workspaceId: 'ws-does-not-exist' })
    assert.equal(res.status, 404)
    assert.equal(llm.calls, 0, '工作区不存在时不得触发模型调用')
  })
})

// ── 强制重跑并返回与 /works 同形的结果 ───────────────────────────────

await test('POST /work-refine-retry：强制带模型重跑，返回与 /works 完全同形的字段集', async () => {
  await withTempHome(async () => {
    const llm = makeFakeLlm(call => refineReply(clusterIdsIn(call), '重试后的标题'))
    const ctx = makeCtx(EVENTS, llm)
    apply(ctx)
    const handler = ctx._routes[0].handler

    const retry = await callRoute(handler, 'POST', 'work-refine-retry', { workspaceId: WS })
    assert.equal(retry.status, 200)
    assert.equal(retry.body.ok, true)

    const works = await callRoute(handler, 'POST', 'works', { workspaceId: WS })
    assert.equal(works.status, 200)

    // 形状一致：字段集合必须完全相同（多一个少一个都会让客户端崩）
    assert.deepEqual(
      Object.keys(retry.body.value).sort(),
      Object.keys(works.body.value).sort(),
      '重试返回的字段集必须与 /works 完全一致',
    )
    // refineStatus 必须存在且形状正确
    const status = retry.body.value.refineStatus
    assert.ok(status !== null && typeof status === 'object', 'refineStatus 必须存在')
    assert.deepEqual(
      Object.keys(status).sort(),
      ['at', 'attempts', 'reason', 'used'],
      'refineStatus 必须是契约的四个字段',
    )
    assert.equal(typeof status.used, 'boolean')
    assert.equal(typeof status.attempts, 'number')
  })
})

await test('POST /work-refine-retry：上一次提炼因无模型失败后，重试能真的调上模型并翻成 ok', async () => {
  await withTempHome(async () => {
    // 第一次：没有任何模型可用 → no_model
    const noLlmCtx = makeCtx(EVENTS)
    apply(noLlmCtx)
    const noLlmHandler = noLlmCtx._routes[0].handler
    const first = await callRoute(noLlmHandler, 'POST', 'work-refine-retry', { workspaceId: WS })
    assert.equal(first.status, 200)
    assert.equal(first.body.value.refineStatus.reason, 'no_model')
    assert.equal(first.body.value.refineStatus.used, false)

    // 第二次：同一个 workspace 换成有模型的 ctx（模拟用户接上模型后点重试）
    const llm = makeFakeLlm(call => refineReply(clusterIdsIn(call), '接上模型后的标题'))
    const llmCtx = makeCtx(EVENTS, llm)
    apply(llmCtx)
    const llmHandler = llmCtx._routes[0].handler
    const second = await callRoute(llmHandler, 'POST', 'work-refine-retry', { workspaceId: WS })
    assert.equal(second.status, 200)
    assert.equal(second.body.value.refineStatus.reason, 'ok')
    assert.equal(second.body.value.refineStatus.used, true)
    assert.equal(second.body.value.refineStatus.attempts, 1)
    assert.ok(llm.calls >= 1, '重试必须真的调用模型')
    assert.ok(
      second.body.value.cards.unresolved.some(c => c.title === '接上模型后的标题'),
      '重试后的精化标题必须出现在卡片上',
    )
  })
})

await test('POST /work-refine-retry：模型侧失败 → 200 + refineStatus.reason="failed"，规则结果照常返回', async () => {
  await withTempHome(async () => {
    const llm = makeFakeLlm(() => new Error('adapter exploded'))
    const ctx = makeCtx(EVENTS, llm)
    apply(ctx)
    const handler = ctx._routes[0].handler
    const res = await callRoute(handler, 'POST', 'work-refine-retry', { workspaceId: WS })
    assert.equal(res.status, 200, '模型失败不应把端点变成 5xx：规则结果仍然可用')
    assert.equal(res.body.value.refineStatus.reason, 'failed')
    assert.equal(res.body.value.refineStatus.used, false)
    assert.ok(res.body.value.cards.unresolved.length >= 1, '规则结果必须照常返回')
  })
})

await test('POST /work-refine-retry：与 /works 共用工作区串行锁（连续重试不互相覆盖）', async () => {
  await withTempHome(async () => {
    let nth = 0
    const llm = makeFakeLlm(call => {
      nth += 1
      return refineReply(clusterIdsIn(call), `第 ${nth} 次重试标题`)
    })
    const ctx = makeCtx(EVENTS, llm)
    apply(ctx)
    const handler = ctx._routes[0].handler

    // 并发发起两次重试：串行锁必须让它们依次完成，最终 store 只能有一种结果。
    const [a, b] = await Promise.all([
      callRoute(handler, 'POST', 'work-refine-retry', { workspaceId: WS }),
      callRoute(handler, 'POST', 'work-refine-retry', { workspaceId: WS }),
    ])
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.equal(a.body.value.refineStatus.reason, 'ok')
    assert.equal(b.body.value.refineStatus.reason, 'ok')
    assert.equal(a.body.value.refineStatus.attempts, 1)
    assert.equal(b.body.value.refineStatus.attempts, 1)

    // 落盘后的最终状态也必须是成功，且不能出现"半个 store"
    const works = await callRoute(handler, 'POST', 'works', { workspaceId: WS })
    assert.equal(works.body.value.refineStatus.reason, 'ok')
    assert.ok(works.body.value.works.length >= 1)
  })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) process.exit(1)
