/**
 * 只读巡检的后端闸门测试（ADR-0011）。
 *
 * 规则：当前工作区 = 发起方会话所属的工作区；写操作只能发生在自己的归属工作区。
 * 交接是唯一例外（它把人带过去，而不是在远方改数据）。
 * 缺发起会话时 fail-open（过渡期策略）。
 *
 * Run: node tests/readonly-endpoint.mjs
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
  try { await fn(); passed += 1; console.log('  ok   ' + name) }
  catch (e) { failures.push({ name, e }); console.log('  FAIL ' + name + '\n       ' + e.message) }
}

const BASE = 1_700_000_000_000
const WS_A = 'ws-owner-a'
const WS_B = 'ws-other-b'

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'readonly-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try { return await fn(home) }
  finally {
    if (saved === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
  }
}

function makeEvents(prompt) {
  const events = []
  let seq = 0
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  for (let turn = 0; turn < 2; turn += 1) {
    const start = BASE + turn * 60_000
    push('turn/start', { turn }, start)
    push('user/message', { content: [{ type: 'text', text: turn === 0 ? prompt : '继续修同一个报错' }], source: { kind: 'user' } }, start + 100)
    push('tool/call', { name: 'edit', arguments: { file_path: 'lib/a.js' } }, start + 500)
    push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '改好了' }], source: { kind: 'model' } } }, start + 1000)
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  }
  return events
}

/** 会话 belong-A 属于 A 区；B 区另有一个会话 belong-B。 */
function makeCtx() {
  const events = { 'belong-A': makeEvents('修 A 区的任务'), 'belong-B': makeEvents('修 B 区的任务') }
  const workspaces = [
    { id: WS_A, path: 'E:\\a', title: 'A', sessionIds: ['belong-A'] },
    { id: WS_B, path: 'E:\\b', title: 'B', sessionIds: ['belong-B'] },
  ]
  const registeredRoutes = []
  const webScope = {
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(config) { registeredRoutes.push(config); return () => {} },
      }
    },
    effect(fn) { return fn() },
  }
  return {
    _routes: registeredRoutes,
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      return undefined
    },
    on() { return () => {} },
    effect(fn) { return fn() },
    inject(names, cb) { if (names.includes('webServer')) cb(webScope) },
    sessionQuery: {
      async readSession(id) { return (id in events) ? { header: { id }, events: events[id] } : null },
      async listSessions() { return Object.keys(events).map(id => ({ header: { id } })) },
      async readTitleSnapshots(ids) { return ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: { title: { title: 'S' } } })) },
    },
    sessionPersistence: { async stat() { return { revision: 'r1' } } },
    workspaceChanges: { async summary() { return undefined } },
  }
}

/** 直接调路由 handler，模拟一次 HTTP 请求。 */
async function callRoute(handler, method, action, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(payload)
  req.url = '/api/topic-map/' + action
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

async function bootCtx() {
  const ctx = makeCtx()
  apply(ctx)
  const route = ctx._routes.find(r => typeof r.handler === 'function')
  assert.ok(route, '必须注册了 HTTP 路由')
  return { ctx, handler: route.handler }
}

console.log('\n=== 写操作：跨工作区必须 403 ===')

// 闸门在 handler 之前执行，所以用不存在的 workId 就能区分「被拦(403)」与「已放行(404)」，
// 不需要先真的造出一条事——这样测试只验证闸门本身，不依赖扫描结果。
await test('在 A 区会话上确认 B 区的事 → 403（跨工作区只读）', async () => {
  await withHome(async () => {
    const { handler } = await bootCtx()
    const res = await callRoute(handler, 'POST', 'work-confirm', {
      workspaceId: WS_B,
      workId: 'w-does-not-exist',
      requesterSessionId: 'belong-A',
      patch: { state: 'done' },
    })
    assert.equal(res.status, 403, '必须 403，实际 ' + res.status + ' ' + JSON.stringify(res.body))
    assert.ok(String(res.body.error).indexOf('只读') >= 0, '错误要说清是只读约束：' + res.body.error)
  })
})

await test('在自己的归属工作区确认 → 放行到 handler（404 而非 403）', async () => {
  await withHome(async () => {
    const { handler } = await bootCtx()
    const res = await callRoute(handler, 'POST', 'work-confirm', {
      workspaceId: WS_A,
      workId: 'w-does-not-exist',
      requesterSessionId: 'belong-A',
      patch: { state: 'done' },
    })
    assert.notEqual(res.status, 403, '同区不得被只读闸门拦住')
    assert.equal(res.status, 404, '应放行到 handler 并由它报「事不存在」，实际 ' + res.status)
  })
})

await test('跨区重新盘点与重试提炼也算写 → 403', async () => {
  await withHome(async () => {
    const { handler } = await bootCtx()
    const scan = await callRoute(handler, 'POST', 'works-scan', {
      workspaceId: WS_B, force: true, requesterSessionId: 'belong-A',
    })
    assert.equal(scan.status, 403, 'works-scan 必须被拦，实际 ' + scan.status)
    const retry = await callRoute(handler, 'POST', 'work-refine-retry', {
      workspaceId: WS_B, requesterSessionId: 'belong-A',
    })
    assert.equal(retry.status, 403, 'work-refine-retry 必须被拦，实际 ' + retry.status)
  })
})

await test('读操作不受限：跨区 /works 仍能读', async () => {
  await withHome(async () => {
    const { handler } = await bootCtx()
    const res = await callRoute(handler, 'POST', 'works', { workspaceId: WS_B, requesterSessionId: 'belong-A' })
    assert.equal(res.status, 200, '读必须放行，实际 ' + res.status)
  })
})

await test('未带发起会话 → 过渡期 fail-open（不打断旧调用方）', async () => {
  await withHome(async () => {
    const { handler } = await bootCtx()
    const res = await callRoute(handler, 'POST', 'works-scan', { workspaceId: WS_B, force: true, useModel: false })
    assert.equal(res.status, 200, '缺发起会话应放行，实际 ' + res.status)
  })
})

await test('交接是唯一例外：跨区交接不拦', async () => {
  await withHome(async () => {
    const { handler } = await bootCtx()
    const res = await callRoute(handler, 'POST', 'work-handoff', {
      workspaceId: WS_B, workId: 'w-does-not-exist', mode: 'new-session', requesterSessionId: 'belong-A',
    })
    assert.notEqual(res.status, 403, '交接不得被只读闸门拦住，实际 ' + res.status)
  })
})

console.log('')
if (failures.length > 0) { console.log('readonly-endpoint: ' + passed + ' passed, ' + failures.length + ' FAILED'); process.exit(1) }
console.log('readonly-endpoint: ' + passed + ' passed, 0 failed')