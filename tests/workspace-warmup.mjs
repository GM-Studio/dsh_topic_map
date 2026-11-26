/**
 * 工作区索引预热端点测试（POST /api/topic-map/workspace-warmup）。
 *
 * 锁：立即入队、单次上限 50 且按 lastActive 倒序、复用 60 秒节流、
 * 同工作区 5 分钟内存节流（含 retryAfterMs 与跨工作区隔离）、400/404。
 *
 * Run: node tests/workspace-warmup.mjs
 */

import { strict as assert } from 'node:assert'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  apply,
  flushIndexSyncs,
  queueSessionIndexSync,
  warmupWorkspace,
} from '../lib/index.js'
import { defaultSessionsDir, indexFilePath } from '../lib/turn-index.js'

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

/** 一轮完整事件（后台索引任务会读它）。 */
function makeEvents(prompt = '预热问题') {
  let seq = 0
  const push = (type, data, time) => ({ type, seq: seq++, time, data })
  return [
    push('turn/start', { turn: 0 }, BASE_TIME),
    push('user/message', {
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }, BASE_TIME + 100),
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '答' }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }, BASE_TIME + 1000),
    push('turn/end', { turn: 0, reason: { kind: 'completed' } }, BASE_TIME + 5000),
  ]
}

/**
 * 假 Host context。
 *
 * `lastActive` 通过 `sessionQuery.listSessions` 的 updatedAt 暴露（与 /sessions
 * 的摘要时间同口径）；没给的会话 lastActive 为 null。
 */
function makeCtx(options = {}) {
  const events = options.events ?? {}
  const lastActive = options.lastActive ?? {}
  const workspaces = options.workspaces ?? [{
    id: 'ws-warm',
    path: 'E:\\ws',
    title: '预热工作区',
    sessionIds: Object.keys(events),
  }]
  return {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      return undefined
    },
    sessionQuery: {
      async listSessions() {
        return Object.entries(lastActive).map(([id, time]) => ({
          header: { id },
          updatedAt: time,
        }))
      },
      async readSession(id) {
        return { events: events[id] ?? makeEvents(`问题 ${id}`) }
      },
    },
    sessionPersistence: {
      async stat(id) {
        return { revision: `rev-${id}` }
      },
    },
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'workspace-warmup-'))
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

async function indexExists(sessionId) {
  try {
    await access(indexFilePath(defaultSessionsDir(), sessionId))
    return true
  } catch {
    return false
  }
}

console.log('\nworkspace-warmup')

await test('立即入队；单次最多 50，按 lastActive 倒序取最新', async () => {
  await withTempHome(async () => {
    const ids = Array.from({ length: 60 }, (_, index) => `session-warm-${String(index).padStart(2, '0')}`)
    const events = Object.fromEntries(ids.map(id => [id, makeEvents(`问题 ${id}`)]))
    const lastActive = Object.fromEntries(ids.map((id, index) => [id, BASE_TIME + index * 1000]))
    // 工作区顺序故意按最旧 → 最新，验证排序不是直接用 registry 顺序。
    const ctx = makeCtx({
      events,
      lastActive,
      workspaces: [{ id: 'ws-cap', path: 'E:\\ws', title: '上限', sessionIds: ids }],
    })

    const result = await warmupWorkspace(ctx, { workspaceId: 'ws-cap' })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.queued, 50)
    assert.equal(result.value.throttled, false)
    assert.ok(result.value.running >= 0 && result.value.running <= 2, 'running 是并发 2 的后台任务数')

    await flushIndexSyncs()
    for (const id of ids.slice(10)) {
      assert.equal(await indexExists(id), true, `最新 50 个应入队：${id}`)
    }
    for (const id of ids.slice(0, 10)) {
      assert.equal(await indexExists(id), false, `最旧 10 个应被 50 上限截掉：${id}`)
    }
  })
})

await test('复用 60 秒节流：刚排过的会话不计入 queued', async () => {
  await withTempHome(async () => {
    const ids = ['session-warm-pre-a', 'session-warm-pre-b', 'session-warm-pre-c']
    const events = Object.fromEntries(ids.map(id => [id, makeEvents(`问题 ${id}`)]))
    const lastActive = Object.fromEntries(ids.map((id, index) => [id, BASE_TIME + index * 1000]))
    const ctx = makeCtx({
      events,
      lastActive,
      workspaces: [{ id: 'ws-pre', path: 'E:\\ws', title: '节流', sessionIds: ids }],
    })

    assert.equal(queueSessionIndexSync(ctx, ids[0]), true)
    await flushIndexSyncs()

    const result = await warmupWorkspace(ctx, { workspaceId: 'ws-pre' })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.queued, 2, '最近 60 秒已排过的会话应被跳过')
    assert.equal(result.value.throttled, false)
  })
})

await test('同工作区 5 分钟节流：retryAfterMs 递减，窗口过后恢复', async () => {
  await withTempHome(async () => {
    const T = BASE_TIME
    const ids = ['session-warm-th-a', 'session-warm-th-b']
    const events = Object.fromEntries(ids.map(id => [id, makeEvents(`问题 ${id}`)]))
    const lastActive = Object.fromEntries(ids.map((id, index) => [id, T + index * 1000]))
    const ctx = makeCtx({
      events,
      lastActive,
      workspaces: [{ id: 'ws-throttle', path: 'E:\\ws', title: '节流', sessionIds: ids }],
    })

    const first = await warmupWorkspace(ctx, { workspaceId: 'ws-throttle' }, { now: T })
    assert.equal(first.ok, true, first.error)
    assert.equal(first.value.throttled, false)
    assert.equal(first.value.queued, 2)
    await flushIndexSyncs()

    const second = await warmupWorkspace(ctx, { workspaceId: 'ws-throttle' }, { now: T + 299_999 })
    assert.equal(second.ok, true, second.error)
    assert.equal(second.value.throttled, true)
    assert.equal(second.value.queued, 0)
    assert.equal(second.value.retryAfterMs, 1)

    const third = await warmupWorkspace(ctx, { workspaceId: 'ws-throttle' }, { now: T + 300_000 })
    assert.equal(third.ok, true, third.error)
    assert.equal(third.value.throttled, false, '正好 5 分钟应恢复触发')
  })
})

await test('节流按工作区隔离：A 被节流不影响 B', async () => {
  await withTempHome(async () => {
    const T = BASE_TIME
    const ctx = makeCtx({
      events: {
        'session-warm-a1': makeEvents('A 会话'),
        'session-warm-b1': makeEvents('B 会话'),
      },
      lastActive: { 'session-warm-a1': T, 'session-warm-b1': T + 1000 },
      workspaces: [
        { id: 'ws-iso-a', path: 'E:\\a', title: 'A', sessionIds: ['session-warm-a1'] },
        { id: 'ws-iso-b', path: 'E:\\b', title: 'B', sessionIds: ['session-warm-b1'] },
      ],
    })

    const a1 = await warmupWorkspace(ctx, { workspaceId: 'ws-iso-a' }, { now: T })
    const b1 = await warmupWorkspace(ctx, { workspaceId: 'ws-iso-b' }, { now: T })
    assert.equal(a1.value.throttled, false)
    assert.equal(b1.value.throttled, false)
    assert.equal(a1.value.queued, 1)
    assert.equal(b1.value.queued, 1)

    const a2 = await warmupWorkspace(ctx, { workspaceId: 'ws-iso-a' }, { now: T + 1000 })
    const b2 = await warmupWorkspace(ctx, { workspaceId: 'ws-iso-b' }, { now: T + 1000 })
    assert.equal(a2.value.throttled, true)
    assert.equal(b2.value.throttled, true)
    assert.equal(a2.value.retryAfterMs, 299_000)
    assert.equal(b2.value.retryAfterMs, 299_000)
  })
})

await test('参数与工作区错误：缺 workspaceId → 400，未知工作区 → 404', async () => {
  const ctx = makeCtx({
    events: { 'session-warm-x': makeEvents('X') },
    workspaces: [{ id: 'ws-warm', path: 'E:\\ws', title: 'W', sessionIds: ['session-warm-x'] }],
  })
  for (const body of [{}, { workspaceId: '' }, { workspaceId: '   ' }, { workspaceId: 123 }]) {
    const result = await warmupWorkspace(ctx, body)
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 400)
    assert.match(result.error, /workspaceId/)
  }
  const missing = await warmupWorkspace(ctx, { workspaceId: 'ws-not-exist' })
  assert.equal(missing.ok, false)
  assert.equal(missing.httpStatus, 404)
  assert.match(missing.error, /工作区/)

  const noRegistry = { get: () => undefined }
  const none = await warmupWorkspace(noRegistry, { workspaceId: 'ws-x' })
  assert.equal(none.ok, false)
  assert.equal(none.httpStatus, 404)
})

await test('路由接线：200 {ok,value} 信封；缺参数 400、未知工作区 404', async () => {
  const registered = []
  const webScope = {
    get(name) {
      if (name !== 'webServer') return undefined
      return {
        register(config) {
          registered.push(config)
          return () => {}
        },
      }
    },
    effect(fn) {
      fn()
    },
  }
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{ id: 'ws-route-warm', path: 'E:\\w', title: '路由', sessionIds: [] }],
        }
      }
      return undefined
    },
    inject(names, callback) {
      if (names.includes('webServer')) callback(webScope)
    },
    effect(fn) {
      fn()
    },
  }
  apply(ctx)
  assert.equal(registered.length, 1)
  const handler = registered[0].handler
  const call = async body => {
    const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')])
    req.url = '/api/topic-map/workspace-warmup'
    req.method = 'POST'
    let status = 0
    let text = ''
    const res = {
      writeHead(code) {
        status = code
      },
      end(value) {
        text = value
      },
    }
    await handler(req, res)
    return { status, body: text === '' ? null : JSON.parse(text) }
  }

  const bad = await call({})
  assert.equal(bad.status, 400)
  assert.equal(bad.body.ok, false)
  assert.match(bad.body.error, /workspaceId/)

  const missing = await call({ workspaceId: 'ws-nope' })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.ok, false)

  const ok = await call({ workspaceId: 'ws-route-warm' })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.ok, true)
  assert.equal(ok.body.value.throttled, false)
  assert.equal(ok.body.value.queued, 0)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
