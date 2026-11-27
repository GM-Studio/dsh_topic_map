/**
 * 变更快照落盘测试（P0-9 / F-7）。
 *
 * 分两层测：
 *   1. `syncSessionIndex` 的 enrich 钩子：纯函数边界不被 ctx 污染，
 *      重建时能拿到 previous 行，跳过时不调用；
 *   2. `syncSessionIndexFor` 的 Host 包装：`workspace/changes` → summary →
 *      索引行 `changes`，summary 不可用时留 `lost:true`，重复重建不重复请求。
 *
 * Run: node tests/index-changes.mjs
 */

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSessionIndexes, inject, syncSessionIndexFor } from '../lib/index.js'
import {
  INDEX_SCHEMA,
  defaultSessionsDir,
  parseIndexText,
  readIndexFile,
  syncSessionIndex,
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
const BIG_FILE_BYTES = 2 * 1024 * 1024 + 1

function sha256Of(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** 造事件流；spec.changes === true 时在轮内插一条 workspace/changes 指针。 */
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
    if (spec.changes === true) {
      push('workspace/changes', { turn }, start + 2000)
    }
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  })
  return events
}

/** 取事件流里 workspace/changes 的 seq（summary 的参数）。 */
function changesSeqOf(events) {
  return events.find(event => event.type === 'workspace/changes').seq
}

/** 假 Host context：事件流、revision、变更摘要服务都可注入。 */
function makeHostCtx(options = {}) {
  const state = { revision: options.revision ?? 'rev-1' }
  const events = options.events ?? []
  const ctx = {
    get(name) {
      if (name !== 'workspaceRegistry' || !Array.isArray(options.sessions)) return undefined
      return {
        list: () => [{
          id: 'ws-1',
          path: 'E:\\ws',
          title: '工作区 A',
          sessionIds: options.sessions,
        }],
      }
    },
    sessionQuery: {
      async readSession(id) {
        const list = Array.isArray(events) ? events : (events[id] ?? [])
        return { events: list }
      },
    },
    sessionPersistence: {
      async stat() {
        return { revision: state.revision }
      },
    },
  }
  if (options.service !== false) {
    ctx.workspaceChanges = { summary: options.summary ?? (async () => undefined) }
  }
  return { ctx, state }
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'index-changes-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 临时 home（/index-build 这类走默认索引目录的用例用）。 */
async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'index-changes-home-'))
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

/** 读索引文件里某轮的 changes。 */
async function changesOfTurn(path, turn) {
  const parsed = parseIndexText(await readFile(path, 'utf8'))
  assert.equal(parsed.ok, true, `索引损坏：${parsed.reason}`)
  const row = parsed.turns.find(item => item.turn === turn)
  assert.ok(row !== undefined, `找不到第 ${turn} 轮`)
  return { row, has: 'changes' in row }
}

console.log('\nindex-changes')

// ── enrich 钩子（turn-index 层） ────────────────────────────────────

await test('enrich 钩子拿到 turns/events/previous，改动落盘', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([{ prompt: '甲' }])
    const calls = []
    const first = await syncSessionIndex({
      dir,
      sessionId: 'sess-enrich',
      revision: 'r1',
      loadEvents: async () => events,
      enrich: async payload => {
        calls.push(payload)
        payload.turns[0].marker = 'x'
      },
    })
    assert.equal(calls.length, 1)
    assert.ok(Array.isArray(calls[0].turns) && calls[0].turns.length === 1)
    assert.equal(calls[0].events, events)
    assert.deepEqual(calls[0].previous, [])
    assert.equal(calls[0].sessionId, 'sess-enrich')
    assert.equal(calls[0].revision, 'r1')

    const parsed = parseIndexText(await readFile(first.path, 'utf8'))
    assert.equal(parsed.turns[0].marker, 'x', 'enrich 的改动没有落盘')
  })
})

await test('enrich 跳过时不调用；重建时 previous 是旧索引行', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([{ prompt: '甲' }])
    const calls = []
    await syncSessionIndex({
      dir,
      sessionId: 'sess-enrich2',
      revision: 'r1',
      loadEvents: async () => events,
      enrich: async payload => {
        calls.push(payload)
        payload.turns[0].marker = 'v1'
      },
    })

    const skipped = await syncSessionIndex({
      dir,
      sessionId: 'sess-enrich2',
      revision: 'r1',
      loadEvents: async () => events,
      enrich: async () => {
        calls.push('不该被调用')
      },
    })
    assert.equal(skipped.skipped, true)
    assert.equal(calls.length, 1, '跳过路径不该调用 enrich')

    await syncSessionIndex({
      dir,
      sessionId: 'sess-enrich2',
      revision: 'r2',
      loadEvents: async () => events,
      enrich: async payload => {
        calls.push(payload)
      },
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[1].previous.length, 1)
    assert.equal(calls[1].previous[0].marker, 'v1')
  })
})

// ── changes 落盘（Host 包装） ───────────────────────────────────────

await test('summary 可用：只给有 workspace/changes 的轮次写 changes', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([
      { prompt: '没有变更' },
      { prompt: '改了文件', changes: true },
    ])
    const calls = []
    const { ctx } = makeHostCtx({
      events,
      summary: async (sessionId, seq) => {
        calls.push({ sessionId, seq })
        return {
          turn: 1,
          cwd: 'E:\\ws',
          files: [
            { path: 'lib/client.js', display: 'client.js', added: 40, deleted: 5 },
            { path: 'lib/index.js', display: 'index.js', added: 3, deleted: 0, binary: false },
          ],
          total: 2,
          added: 43,
          deleted: 5,
        }
      },
    })

    const result = await syncSessionIndexFor(ctx, 'sess-changes', { dir })
    assert.equal(result.skipped, false)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { sessionId: 'sess-changes', seq: changesSeqOf(events) })

    const changed = await changesOfTurn(result.path, 1)
    assert.equal(changed.has, true)
    assert.deepEqual(changed.row.changes, {
      files: [
        { path: 'lib/client.js', added: 40, deleted: 5, hash: null, hashSkipped: 'missing' },
        { path: 'lib/index.js', added: 3, deleted: 0, hash: null, hashSkipped: 'missing' },
      ],
      total: 2,
      added: 43,
      deleted: 5,
      lost: false,
    })

    const untouched = await changesOfTurn(result.path, 0)
    assert.equal(untouched.has, false, '没有变更事件的轮次不该写 changes')
  })
})

await test('hash：成功 / missing / too-large / unreadable 四种形状', async () => {
  await withTempDir(async dir => {
    const workspace = join(dir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const okText = 'export const value = 1\n'
    await writeFile(join(workspace, 'ok.js'), okText, 'utf8')
    await writeFile(join(workspace, 'big.bin'), Buffer.alloc(BIG_FILE_BYTES))
    await mkdir(join(workspace, 'folder'))

    const events = makeEvents([{ prompt: '改文件', changes: true }])
    const summary = {
      cwd: workspace,
      files: [
        { path: 'ok.js', added: 1, deleted: 0 },
        { path: 'missing.js', added: 1, deleted: 0 },
        { path: 'big.bin', added: 1, deleted: 0 },
        { path: 'folder', added: 1, deleted: 0 },
      ],
      total: 4,
      added: 4,
      deleted: 0,
    }
    const { ctx } = makeHostCtx({ events, summary: async () => summary })
    const result = await syncSessionIndexFor(ctx, 'sess-hash', { dir })
    const changed = await changesOfTurn(result.path, 0)
    assert.deepEqual(changed.row.changes.files, [
      { path: 'ok.js', added: 1, deleted: 0, hash: sha256Of(okText) },
      { path: 'missing.js', added: 1, deleted: 0, hash: null, hashSkipped: 'missing' },
      { path: 'big.bin', added: 1, deleted: 0, hash: null, hashSkipped: 'too-large' },
      { path: 'folder', added: 1, deleted: 0, hash: null, hashSkipped: 'unreadable' },
    ])
    assert.equal(changed.row.changes.lost, false)
  })
})

await test('hash 限流：前 50 个文件计算，第 51 个起 limited', async () => {
  await withTempDir(async dir => {
    const workspace = join(dir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const files = []
    for (let index = 0; index < 51; index += 1) {
      const name = `f${index}.js`
      files.push({ path: name, added: 1, deleted: 0 })
      if (index < 50) await writeFile(join(workspace, name), `file ${index}\n`, 'utf8')
    }
    const events = makeEvents([{ prompt: '批量改文件', changes: true }])
    const { ctx } = makeHostCtx({
      events,
      summary: async () => ({ cwd: workspace, files, total: files.length, added: 51, deleted: 0 }),
    })
    const result = await syncSessionIndexFor(ctx, 'sess-hash-limit', { dir })
    const changed = await changesOfTurn(result.path, 0)
    assert.equal(changed.row.changes.files.length, 51)
    for (let index = 0; index < 50; index += 1) {
      const file = changed.row.changes.files[index]
      assert.equal(file.hash, sha256Of(`file ${index}\n`), `第 ${index + 1} 个文件应有 hash`)
      assert.equal(file.hashSkipped, undefined)
    }
    assert.deepEqual(changed.row.changes.files[50], {
      path: 'f50.js',
      added: 1,
      deleted: 0,
      hash: null,
      hashSkipped: 'limited',
    })
  })
})

await test('legacy 重建：schema 4 历史轮次 hash:null，不拿当前磁盘冒充旧快照', async () => {
  await withTempDir(async dir => {
    const workspace = join(dir, 'workspace')
    await mkdir(workspace, { recursive: true })
    const current = 'current content after later edits\n'
    await writeFile(join(workspace, 'target.js'), current, 'utf8')
    const events = makeEvents([{ prompt: '历史变更', changes: true }])

    // 先造一份当前 schema 索引，再手工退回 schema 4，模拟升级前的旧索引。
    const first = await syncSessionIndex({
      dir,
      sessionId: 'sess-legacy',
      revision: 'rev-1',
      loadEvents: async () => events,
    })
    const lines = (await readFile(first.path, 'utf8')).trimEnd().split('\n')
    const meta = JSON.parse(lines[0])
    meta.schema = 4
    await writeFile(first.path, [JSON.stringify(meta), ...lines.slice(1)].join('\n') + '\n', 'utf8')

    const { ctx } = makeHostCtx({
      events,
      summary: async () => ({
        cwd: workspace,
        files: [{ path: 'target.js', added: 1, deleted: 0 }],
        total: 1,
        added: 1,
        deleted: 0,
      }),
    })
    const rebuilt = await syncSessionIndexFor(ctx, 'sess-legacy', { dir, revision: 'rev-1' })
    assert.equal(rebuilt.reason, 'meta')
    const parsed = parseIndexText(await readFile(rebuilt.path, 'utf8'))
    assert.equal(parsed.meta.schema, INDEX_SCHEMA)
    assert.equal(parsed.meta.schema, 6)
    const changed = parsed.turns[0]
    assert.deepEqual(changed.changes.files, [
      { path: 'target.js', added: 1, deleted: 0, hash: null },
    ])
    assert.equal(changed.changes.files[0].hashSkipped, undefined, '历史轮次不应标记为可重试的跳过原因')
  })
})

await test('summary 返回 undefined：留 lost:true 痕迹，不伪装成空白', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([{ prompt: '改过文件', changes: true }])
    const { ctx } = makeHostCtx({ events, summary: async () => undefined })
    const result = await syncSessionIndexFor(ctx, 'sess-lost', { dir })
    const changed = await changesOfTurn(result.path, 0)
    assert.equal(changed.has, true)
    assert.deepEqual(changed.row.changes, {
      files: [],
      total: 0,
      added: 0,
      deleted: 0,
      lost: true,
    })
  })
})

await test('宿主没有 workspaceChanges 服务：同样留 lost:true', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([{ prompt: '改过文件', changes: true }])
    const { ctx } = makeHostCtx({ events, service: false })
    const result = await syncSessionIndexFor(ctx, 'sess-noservice', { dir })
    const changed = await changesOfTurn(result.path, 0)
    assert.equal(changed.row.changes.lost, true)
  })
})

await test('未 inject 的严格服务代理（访问即抛）：整批不 failed，写 lost:true', async () => {
  await withTempHome(async () => {
    const ids = ['sess-a', 'sess-b', 'sess-c']
    const events = Object.fromEntries(ids.map(id => [
      id,
      makeEvents([{ prompt: '改过文件', changes: true }]),
    ]))
    const { ctx } = makeHostCtx({ events, sessions: ids })
    // 复刻 Cordis 严格代理：属性访问直接抛，而不是返回 undefined。
    Object.defineProperty(ctx, 'workspaceChanges', {
      configurable: true,
      get() {
        throw new Error('cannot get property "workspaceChanges" without inject')
      },
    })

    const batch = await buildSessionIndexes(ctx, { workspaceId: 'ws-1' })
    assert.equal(batch.failed, 0, `整批不应失败：${JSON.stringify(batch.sessions)}`)
    assert.equal(batch.built, 3)
    assert.deepEqual(batch.sessions.map(item => item.status), ['built', 'built', 'built'])

    const built = await readIndexFile(defaultSessionsDir(), 'sess-a')
    assert.equal(built.ok, true)
    const changed = built.turns.find(row => row.turn === 0)
    assert.deepEqual(changed.changes, {
      files: [],
      total: 0,
      added: 0,
      deleted: 0,
      lost: true,
    })
  })
})

await test('inject 声明包含 workspaceChanges（Cordis 严格代理要求）', () => {
  assert.ok(
    inject.includes('workspaceChanges'),
    `inject 未声明 workspaceChanges：${JSON.stringify(inject)}`,
  )
})

await test('summary 抛错：索引照常落盘，该轮记 lost:true', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([{ prompt: '改过文件', changes: true }])
    const { ctx } = makeHostCtx({
      events,
      summary: async () => {
        throw new Error('session disposed')
      },
    })
    const result = await syncSessionIndexFor(ctx, 'sess-throw', { dir })
    assert.equal(result.skipped, false)
    const changed = await changesOfTurn(result.path, 0)
    assert.deepEqual(changed.row.changes, {
      files: [],
      total: 0,
      added: 0,
      deleted: 0,
      lost: true,
    })
  })
})

await test('同一轮重建复用已落盘的 changes，不重复请求 summary', async () => {
  await withTempDir(async dir => {
    let revision = 'rev-1'
    let calls = 0
    const events = makeEvents([{ prompt: '第 1 轮', changes: true }])
    const { ctx } = makeHostCtx({
      events,
      summary: async () => {
        calls += 1
        return {
          files: [{ path: 'lib/client.js', added: 1, deleted: 2 }],
          total: 1,
          added: 1,
          deleted: 2,
        }
      },
    })
    // 用可变 revision：先建 rev-1，再让日志前进到 rev-2 触发整文件重建。
    ctx.sessionPersistence.stat = async () => ({ revision })

    const first = await syncSessionIndexFor(ctx, 'sess-reuse', { dir })
    assert.equal(calls, 1)

    revision = 'rev-2'
    const second = await syncSessionIndexFor(ctx, 'sess-reuse', { dir })
    assert.equal(second.skipped, false)
    assert.equal(calls, 1, '重建时重复请求了 summary')

    const changed = await changesOfTurn(second.path, 0)
    assert.equal(changed.row.changes.lost, false)
    assert.deepEqual(changed.row.changes.files, [
      { path: 'lib/client.js', added: 1, deleted: 2, hash: null, hashSkipped: 'missing' },
    ])
    assert.ok(first.path === second.path)
  })
})

await test('lost:true 不缓存，下一次重建会重试 summary', async () => {
  await withTempDir(async dir => {
    let revision = 'rev-1'
    let calls = 0
    const events = makeEvents([{ prompt: '改过文件', changes: true }])
    const { ctx } = makeHostCtx({
      events,
      summary: async () => {
        calls += 1
        if (calls === 1) return undefined
        return { files: [{ path: 'lib/index.js', added: 7, deleted: 1 }], total: 1, added: 7, deleted: 1 }
      },
    })
    ctx.sessionPersistence.stat = async () => ({ revision })

    const first = await syncSessionIndexFor(ctx, 'sess-retry', { dir })
    assert.equal((await changesOfTurn(first.path, 0)).row.changes.lost, true)

    revision = 'rev-2'
    const second = await syncSessionIndexFor(ctx, 'sess-retry', { dir })
    assert.equal(calls, 2, 'lost 的轮次应重试 summary')
    const changed = await changesOfTurn(second.path, 0)
    assert.equal(changed.row.changes.lost, false)
    assert.deepEqual(changed.row.changes.files, [
      { path: 'lib/index.js', added: 7, deleted: 1, hash: null, hashSkipped: 'missing' },
    ])
  })
})

await test('新出现的变更轮次只请求新事件，旧轮次的 changes 保留', async () => {
  await withTempDir(async dir => {
    let revision = 'rev-1'
    const calls = []
    const events = makeEvents([
      { prompt: '第 1 轮', changes: true },
      { prompt: '第 2 轮', changes: true },
    ])
    const { ctx } = makeHostCtx({
      events,
      summary: async (_sessionId, seq) => {
        calls.push(seq)
        return { files: [{ path: `f-${calls.length}.js`, added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 }
      },
    })
    ctx.sessionPersistence.stat = async () => ({ revision })

    const first = await syncSessionIndexFor(ctx, 'sess-append', { dir })
    assert.equal(calls.length, 2)

    revision = 'rev-2'
    const second = await syncSessionIndexFor(ctx, 'sess-append', { dir })
    assert.equal(calls.length, 2, '旧轮次不该重复请求')
    const row0 = (await changesOfTurn(second.path, 0)).row
    const row1 = (await changesOfTurn(second.path, 1)).row
    assert.equal(row0.changes.files[0].path, 'f-1.js')
    assert.equal(row1.changes.files[0].path, 'f-2.js')
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
