/**
 * Host 路由接线测试：把 `apply(ctx)` 注册的 handler 真正喂一遍。
 *
 * 前面的端点测试直接调用实现函数；这个文件只锁"action → 函数 → HTTP 状态"
 * 这一层：/index-stats /categories /category-save /changes /rollback-plan
 * 是否真的挂在 `/api/topic-map/*` 上，以及 400/404 是否原样返回。
 *
 * Run: node tests/endpoints-route.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { serializeIndex } from '../lib/turn-index.js'

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

const WS = 'ws-route-1'

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'endpoints-route-'))
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

/** 用假 ctx 调 apply，拿到注册的 webServer handler。 */
function registerHandler() {
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
          list: () => [{ id: WS, path: 'E:\\route-ws', title: '路由工作区', sessionIds: [] }],
        }
      }
      return undefined
    },
    inject(names, callback) {
      // 只模拟 webServer 可用；其它可选服务缺席，注册函数会自行跳过。
      if (names.includes('webServer')) callback(webScope)
    },
    effect(fn) {
      fn()
    },
  }
  apply(ctx)
  assert.equal(registered.length, 1, 'apply 应注册一个前缀路由')
  assert.equal(registered[0].kind, 'prefix')
  assert.equal(registered[0].path, '/api/topic-map')
  return registered[0].handler
}

/** 直接调用 handler；返回状态码与解析后的 JSON。 */
async function call(handler, action, body) {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = Readable.from(payload)
  req.url = `/api/topic-map/${action}`
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

console.log('\nendpoints-route')

await test('/index-stats 已接线：200 + 统一 {ok,value} 信封', async () => {
  await withTempHome(async () => {
    const handler = registerHandler()
    const result = await call(handler, 'index-stats', { workspaceId: WS })
    assert.equal(result.status, 200)
    assert.equal(result.body.ok, true)
    assert.deepEqual(result.body.value, {
      sessions: 0,
      turns: 0,
      bytes: 0,
      digests: 0,
      digestBytes: 0,
    })
  })
})

await test('/category-save → /categories 已接线：写入后读回', async () => {
  await withTempHome(async () => {
    const handler = registerHandler()
    const saved = await call(handler, 'category-save', { workspaceId: WS, name: '路由分类' })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.ok, true)
    assert.match(saved.body.value.id, /^c-[0-9a-z]{6}$/)

    const read = await call(handler, 'categories', { workspaceId: WS })
    assert.equal(read.status, 200)
    assert.equal(read.body.ok, true)
    assert.equal(read.body.value.categories.length, 1)
    assert.equal(read.body.value.tree[0].name, '路由分类')
  })
})

await test('/category-assign 与 /category-organize 已接线', async () => {
  await withTempHome(async () => {
    const handler = registerHandler()
    const category = await call(handler, 'category-save', { workspaceId: WS, name: '目标' })
    const assigned = await call(handler, 'category-assign', {
      workspaceId: WS,
      sessionId: 'sess-route',
      categoryId: category.body.value.id,
    })
    assert.equal(assigned.status, 200)
    assert.equal(assigned.body.value.assignments['sess-route'].categoryId, category.body.value.id)

    const organized = await call(handler, 'category-organize', {
      workspaceId: WS,
      op: { kind: 'upsert', name: '新分类' },
    })
    assert.equal(organized.status, 200)
    assert.ok(organized.body.value.undo)
  })
})

await test('/changes 找不到 → 404；/rollback-plan 参数错误 → 400', async () => {
  await withTempHome(async () => {
    const handler = registerHandler()
    const missing = await call(handler, 'changes', { sessionId: 'session-none', turn: 0 })
    assert.equal(missing.status, 404)
    assert.equal(missing.body.ok, false)
    assert.match(missing.body.error, /会话索引不存在/)

    const bad = await call(handler, 'rollback-plan', { sessionId: 'session-none', turn: -1 })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.ok, false)
    assert.match(bad.body.error, /turn/)
  })
})

await test('/changes 正常 → 200；/rollback-plan 正常 → 200', async () => {
  await withTempHome(async home => {
    const dir = join(home, 'topic-map', 'index', 'sessions')
    await mkdir(dir, { recursive: true })
    const row = {
      turn: 0,
      seq: 0,
      prompt: '',
      response: '',
      endSeq: null,
      changes: { files: [{ path: 'missing.js', added: 1, deleted: 0 }], lost: false },
    }
    await writeFile(join(dir, 'session-route.jsonl'), serializeIndex({ revision: 'r1', turns: [row] }), 'utf8')
    const handler = registerHandler()

    const changes = await call(handler, 'changes', { sessionId: 'session-route', turn: 0 })
    assert.equal(changes.status, 200)
    assert.equal(changes.body.ok, true)
    assert.equal(changes.body.value.files[0].kind, 'code')

    const plan = await call(handler, 'rollback-plan', { sessionId: 'session-route', turn: 0 })
    assert.equal(plan.status, 200)
    assert.equal(plan.body.ok, true)
    assert.equal(plan.body.value.plan[0].state, 'missing')
  })
})

await test('未知 action 仍是 404；坏 workspaceId 走 400', async () => {
  await withTempHome(async () => {
    const handler = registerHandler()
    const unknown = await call(handler, 'no-such-action', {})
    assert.equal(unknown.status, 404)
    assert.match(unknown.body.error, /unknown action/)

    const bad = await call(handler, 'index-stats', { workspaceId: 42 })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error, /workspaceId/)
  })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
