/**
 * 索引维护入口测试（P0-9 接线 a/b）。
 *
 * 覆盖三块：
 *   1. `readIndexMeta`：只读首行 meta，不解析其后轮次（/session 的便宜守卫）；
 *   2. `queueSessionIndexSync`：fire-and-forget、同会话去重、60 秒节流、
 *      meta.revision 一致的快速跳过；
 *   3. `buildSessionIndexes`：session/workspace 两种入口、built/skipped/failed
 *      计数、单个失败不中断、并发上限 2、损坏自愈。
 *
 * Run: node tests/index-build.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSessionIndexes,
  flushIndexSyncs,
  queueSessionIndexSync,
  syncSessionIndexFor,
} from '../lib/index.js'
import {
  defaultSessionsDir,
  indexFilePath,
  parseIndexText,
  readIndexFile,
  readIndexMeta,
} from '../lib/turn-index.js'

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

/** 造事件流；spec：`{turn, prompt, response}`。 */
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
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  })
  return events
}

/** 假 Host context。`options.fail` 里的会话读事件流会抛错。 */
function makeCtx(options = {}) {
  const events = options.events ?? {}
  const revisions = options.revisions ?? {}
  const state = { readSession: 0, readTitle: 0, active: 0, maxActive: 0 }
  const ctx = {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return {
        list: () => [{
          id: 'ws-1',
          path: 'E:\\ws',
          title: '工作区 A',
          sessionIds: options.sessions ?? Object.keys(events),
        }],
      }
    },
    sessionQuery: {
      async readTitleSnapshots(ids) {
        state.readTitle += ids.length
        return ids.map(id => ({ status: 'fulfilled', sessionId: id, value: { title: { title: id } } }))
      },
      async readSession(id) {
        state.readSession += 1
        if (options.fail && options.fail.includes(id)) throw new Error('boom')
        state.active += 1
        state.maxActive = Math.max(state.maxActive, state.active)
        try {
          if (typeof options.onRead === 'function') await options.onRead(id)
          return { events: events[id] ?? [] }
        } finally {
          state.active -= 1
        }
      },
    },
    sessionPersistence: {
      async stat(id) {
        return { revision: revisions[id] ?? 'rev-1' }
      },
    },
  }
  if (options.summary !== undefined) ctx.workspaceChanges = { summary: options.summary }
  return { ctx, state, revisions }
}

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'index-build-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'index-build-home-'))
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

console.log('\nindex-build')

// ── readIndexMeta（/session 快速路径） ──────────────────────────────

await test('readIndexMeta 只读首行：坏轮次行不影响，缺失/坏 meta 返回 null', async () => {
  await withTempDir(async dir => {
    assert.equal(await readIndexMeta(dir, 'missing'), null)

    const path = indexFilePath(dir, 'meta-ok')
    await writeFile(path, '{"kind":"meta","schema":5,"revision":"rev-7","turnCount":2}\nnot-json\n', 'utf8')
    assert.deepEqual(await readIndexMeta(dir, 'meta-ok'), {
      kind: 'meta',
      schema: 5,
      revision: 'rev-7',
      turnCount: 2,
    })

    await writeFile(path, '{"kind":"meta","schema":5,"revision":"rev-8","turnCount":0}\n', 'utf8')
    assert.equal((await readIndexMeta(dir, 'meta-ok')).revision, 'rev-8')

    await writeFile(path, 'garbage\n', 'utf8')
    assert.equal(await readIndexMeta(dir, 'meta-ok'), null)
  })
})

// ── 后台同步（/session 接线 a） ────────────────────────────────────

await test('queueSessionIndexSync 不阻塞调用方；在途去重；落盘后可读', async () => {
  await withTempHome(async () => {
    const gate = deferred()
    const { ctx, state } = makeCtx({ events: { 'sess-bg': makeEvents([{ prompt: '甲' }]) } })
    ctx.sessionQuery.readSession = async () => {
      state.readSession += 1
      await gate.promise
      return { events: makeEvents([{ prompt: '甲' }]) }
    }

    assert.equal(queueSessionIndexSync(ctx, 'sess-bg'), true, '应立刻返回而不是等同步')
    assert.equal(state.readSession, 0, '调用方不该被同步读事件流阻塞')
    assert.equal(queueSessionIndexSync(ctx, 'sess-bg'), false, '同一会话在途时应去重')

    gate.resolve()
    await flushIndexSyncs()
    assert.equal(state.readSession, 1)
    const built = await readIndexFile(defaultSessionsDir(), 'sess-bg')
    assert.equal(built.ok, true)
    assert.equal(built.meta.revision, 'rev-1')

    // 60 秒节流：刚同步过，再排队直接拒绝。
    assert.equal(queueSessionIndexSync(ctx, 'sess-bg'), false)
  })
})

await test('索引新鲜时后台任务只读首行 meta，不再读事件流', async () => {
  await withTempHome(async () => {
    const { ctx, state } = makeCtx({ events: { 'sess-fast': makeEvents([{ prompt: '甲' }]) } })
    await syncSessionIndexFor(ctx, 'sess-fast')
    const before = state.readSession

    assert.equal(queueSessionIndexSync(ctx, 'sess-fast'), true)
    await flushIndexSyncs()
    assert.equal(state.readSession, before, 'meta.revision 一致时应快速跳过')
  })
})

await test('revision 过期时后台任务会重建索引', async () => {
  await withTempHome(async () => {
    const { ctx, state, revisions } = makeCtx({ events: { 'sess-stale': makeEvents([{ prompt: '甲' }]) } })
    await syncSessionIndexFor(ctx, 'sess-stale')
    revisions['sess-stale'] = 'rev-2'
    const before = state.readSession

    queueSessionIndexSync(ctx, 'sess-stale')
    await flushIndexSyncs()
    assert.equal(state.readSession, before + 1)
    assert.equal((await readIndexFile(defaultSessionsDir(), 'sess-stale')).meta.revision, 'rev-2')
  })
})

// ── /index-build（接线 b） ─────────────────────────────────────────

await test('session 模式：首次 built，同 revision 第二次 skipped', async () => {
  await withTempHome(async () => {
    const { ctx } = makeCtx({ events: { 'sess-one': makeEvents([{ prompt: '甲' }]) } })
    const first = await buildSessionIndexes(ctx, { sessionId: 'sess-one' })
    assert.deepEqual(Object.keys(first).sort(), ['built', 'elapsedMs', 'failed', 'sessions', 'skipped'])
    assert.equal(first.built, 1)
    assert.equal(first.skipped, 0)
    assert.equal(first.failed, 0)
    assert.deepEqual(first.sessions, [{ sessionId: 'sess-one', status: 'built' }])
    assert.equal(typeof first.elapsedMs, 'number')

    const second = await buildSessionIndexes(ctx, { sessionId: 'sess-one' })
    assert.equal(second.built, 0)
    assert.equal(second.skipped, 1)
    assert.deepEqual(second.sessions, [{ sessionId: 'sess-one', status: 'skipped' }])
  })
})

await test('workspace 模式：逐个会话构建，顺序与工作区一致', async () => {
  await withTempHome(async () => {
    const ids = ['sess-w1', 'sess-w2', 'sess-w3']
    const events = Object.fromEntries(ids.map(id => [id, makeEvents([{ prompt: id }])]))
    const { ctx } = makeCtx({ events, sessions: ids })
    const result = await buildSessionIndexes(ctx, { workspaceId: 'ws-1' })
    assert.equal(result.built, 3)
    assert.deepEqual(result.sessions.map(item => item.sessionId), ids)
    for (const id of ids) {
      assert.equal((await readIndexFile(defaultSessionsDir(), id)).ok, true)
    }
  })
})

await test('损坏文件（同 revision）走完整校验并自愈', async () => {
  await withTempHome(async () => {
    const { ctx } = makeCtx({ events: { 'sess-heal': makeEvents([{ prompt: '甲' }, { prompt: '乙' }]) } })
    const first = await buildSessionIndexes(ctx, { sessionId: 'sess-heal' })
    const text = await readFile(indexFilePath(defaultSessionsDir(), 'sess-heal'), 'utf8')
    await writeFile(indexFilePath(defaultSessionsDir(), 'sess-heal'), `${text.split('\n')[0]}\n`, 'utf8')

    const second = await buildSessionIndexes(ctx, { sessionId: 'sess-heal' })
    assert.equal(second.built, 1, '损坏文件应重建而不是跳过')
    const parsed = parseIndexText(await readFile(indexFilePath(defaultSessionsDir(), 'sess-heal'), 'utf8'))
    assert.equal(parsed.ok, true)
    assert.equal(parsed.meta.turnCount, 2)
    assert.equal(first.built, 1)
  })
})

await test('单个会话失败不中断整批，逐条记 reason', async () => {
  await withTempHome(async () => {
    const ids = ['sess-ok1', 'sess-bad', 'sess-ok2']
    const events = {
      'sess-ok1': makeEvents([{ prompt: '甲' }]),
      'sess-bad': makeEvents([{ prompt: '乙' }]),
      'sess-ok2': makeEvents([{ prompt: '丙' }]),
    }
    const { ctx } = makeCtx({ events, sessions: ids, fail: ['sess-bad'] })
    const result = await buildSessionIndexes(ctx, { workspaceId: 'ws-1' })
    assert.equal(result.built, 2)
    assert.equal(result.failed, 1)
    assert.equal(result.skipped, 0)
    assert.deepEqual(result.sessions, [
      { sessionId: 'sess-ok1', status: 'built' },
      { sessionId: 'sess-bad', status: 'failed', reason: 'boom' },
      { sessionId: 'sess-ok2', status: 'built' },
    ])
  })
})

await test('并发上限为 2', async () => {
  await withTempHome(async () => {
    const ids = ['sess-c1', 'sess-c2', 'sess-c3', 'sess-c4']
    const events = Object.fromEntries(ids.map(id => [id, makeEvents([{ prompt: id }])]))
    const { ctx, state } = makeCtx({
      events,
      sessions: ids,
      onRead: async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
      },
    })
    const result = await buildSessionIndexes(ctx, { workspaceId: 'ws-1' })
    assert.equal(result.built, 4)
    assert.ok(state.maxActive <= 2, `并发超限：${state.maxActive}`)
  })
})

await test('没有任何目标：返回零计数骨架', async () => {
  const ctx = { get: () => undefined }
  const result = await buildSessionIndexes(ctx, {})
  assert.deepEqual(result.sessions, [])
  assert.equal(result.built, 0)
  assert.equal(result.skipped, 0)
  assert.equal(result.failed, 0)
  assert.equal(typeof result.elapsedMs, 'number')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
