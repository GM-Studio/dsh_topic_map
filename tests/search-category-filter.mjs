/**
 * `/search` 的分类过滤（历史页：分类树当过滤器）。
 *
 * 契约：
 *   - `categoryId: '<id>'` → 该分类及其全部子分类下的会话；
 *   - `categoryId: '__none__'` → 未归类会话（含悬空 categoryId，口径与客户端一致）；
 *   - 不传 → 全部（现状不变）；
 *   - 与 `filters.sessionIds`（以及请求顶层 sessionIds）求交集；
 *   - 分类文件缺失/损坏 → 视为无过滤，不报错也不返回空；
 *   - `coverage.sessions` 是窄化后的会话数；
 *   - 响应结构不新增字段。
 *
 * Run: node tests/search-category-filter.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flushIndexSyncs,
  searchWorkspaceIndex,
  syncSessionIndexFor,
} from '../lib/index.js'

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
const WORKSPACE_ID = 'ws-1'
const ALL_SESSIONS = ['sess-a', 'sess-b', 'sess-c', 'sess-none', 'sess-legacy', 'sess-deep', 'sess-dangling']

/** 每会话一轮，都含检索词「分类词」。 */
function makeEvents() {
  const events = {}
  ALL_SESSIONS.forEach((id, index) => {
    const start = BASE_TIME + index * 60_000
    let seq = 0
    const push = (type, data, time) => events[id].push({ type, seq: seq++, time, data })
    events[id] = []
    push('turn/start', { turn: 0 }, start)
    push('user/message', {
      content: [{ type: 'text', text: `${id} 的分类词` }],
      source: { kind: 'user' },
    }, start + 100)
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `回答 ${id}` }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }, start + 1000)
    push('turn/end', { turn: 0, reason: { kind: 'completed' } }, start + 5000)
  })
  return events
}

function makeCtx(events) {
  return {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return {
        list: () => [{
          id: WORKSPACE_ID,
          path: 'E:\\ws',
          title: '工作区 A',
          sessionIds: ALL_SESSIONS,
        }],
      }
    },
    sessionQuery: {
      async readTitleSnapshots(ids) {
        return ids.map(id => ({ status: 'fulfilled', sessionId: id, value: { title: { title: id } } }))
      },
      async readSession(id) {
        return { events: events[id] ?? [] }
      },
    },
    sessionPersistence: {
      async stat() {
        return { revision: 'rev-1' }
      },
    },
  }
}

/** 分类文件：cat-a → cat-a-1 → cat-a-1-1；另有一个空分类。 */
const STORE = {
  version: 1,
  categories: [
    { id: 'cat-a', name: '大类 A', parentId: null, source: 'user' },
    { id: 'cat-a-1', name: '子类 A1', parentId: 'cat-a', source: 'model' },
    { id: 'cat-a-1-1', name: '孙类 A11', parentId: 'cat-a-1', source: 'model' },
    { id: 'cat-b', name: '大类 B', parentId: null, source: 'user' },
    { id: 'cat-empty', name: '空分类', parentId: null, source: 'model' },
  ],
  assignments: {
    'sess-a': { categoryId: 'cat-a', source: 'user' },
    'sess-b': { categoryId: 'cat-a-1', source: 'model' },
    'sess-deep': { categoryId: 'cat-a-1-1', source: 'model' },
    // 旧形状：值直接是 categoryId 字符串
    'sess-legacy': 'cat-a',
    'sess-c': { categoryId: 'cat-b', source: 'user' },
    // 悬空分类：与客户端一致，算「未归类」
    'sess-dangling': { categoryId: 'cat-missing', source: 'model' },
  },
}

async function writeStore(home) {
  const dir = join(home, 'topic-map', 'categories')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${WORKSPACE_ID}.json`), JSON.stringify(STORE, null, 2), 'utf8')
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'search-category-'))
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

/** 建好全部索引，分类过滤只测接线。 */
async function prepare() {
  const events = makeEvents()
  const ctx = makeCtx(events)
  for (const id of ALL_SESSIONS) await syncSessionIndexFor(ctx, id)
  return ctx
}

function hitSessionIds(result) {
  return [...new Set(result.hits.map(hit => hit.sessionId))].sort()
}

function search(ctx, body = {}) {
  return searchWorkspaceIndex(ctx, {
    workspaceId: WORKSPACE_ID,
    keywords: '分类词',
    limit: 50,
    now: BASE_TIME + 10_000,
    ...body,
  })
}

console.log('\nsearch-category-filter')

// ── 1. 分类含全部子分类（3 级继承） ─────────────────────────────────

await test('categoryId=大类：包含直接、子类、孙类与会话（旧 assignments 形状也算）', async () => {
  await withTempHome(async home => {
    await writeStore(home)
    const ctx = await prepare()
    const result = await search(ctx, { categoryId: 'cat-a' })
    assert.deepEqual(hitSessionIds(result), ['sess-a', 'sess-b', 'sess-deep', 'sess-legacy'])
    assert.equal(result.total, 4)
    assert.equal(result.scanned, 4)
    assert.deepEqual(result.coverage.sessions, 4, 'coverage 是窄化后的会话数')
  })
})

// ── 2. 只选子类：不含父类其它会话 ───────────────────────────────────

await test('categoryId=子类：只含该子类及其孙类', async () => {
  await withTempHome(async home => {
    await writeStore(home)
    const ctx = await prepare()
    const result = await search(ctx, { categoryId: 'cat-a-1' })
    assert.deepEqual(hitSessionIds(result), ['sess-b', 'sess-deep'])
    assert.equal(result.coverage.sessions, 2)
  })
})

// ── 3. __none__：未归类（含悬空分类） ──────────────────────────────

await test('categoryId=__none__：只检索未归类，悬空分类也算未归类', async () => {
  await withTempHome(async home => {
    await writeStore(home)
    const ctx = await prepare()
    const result = await search(ctx, { categoryId: '__none__' })
    assert.deepEqual(hitSessionIds(result), ['sess-dangling', 'sess-none'])
    assert.equal(result.coverage.sessions, 2)
  })
})

// ── 4. 不传 categoryId：口径不变（全部） ───────────────────────────

await test('不传 categoryId：仍是全部会话，响应含分页字段', async () => {
  await withTempHome(async home => {
    await writeStore(home)
    const ctx = await prepare()
    const result = await search(ctx, {})
    assert.equal(result.total, ALL_SESSIONS.length)
    assert.equal(result.coverage.sessions, ALL_SESSIONS.length)
    assert.deepEqual(Object.keys(result).sort(), [
      'coverage', 'elapsedMs', 'hasMore', 'hits', 'indexed', 'offset', 'scanned',
      'total', 'truncated', 'warmup', 'workspace', 'workspaceId',
    ])
    assert.deepEqual(Object.keys(result.coverage).sort(), [
      'indexed', 'indexing', 'scannedFromLog', 'sessions',
    ])
  })
})

// ── 5. 分类文件缺失：视为无过滤 ─────────────────────────────────────

await test('分类文件缺失：不报错，视为无过滤（普通分类与 __none__ 都是全部）', async () => {
  await withTempHome(async () => {
    const ctx = await prepare()
    const byCategory = await search(ctx, { categoryId: 'cat-a' })
    assert.equal(byCategory.total, ALL_SESSIONS.length)
    assert.equal(byCategory.coverage.sessions, ALL_SESSIONS.length)
    const none = await search(ctx, { categoryId: '__none__' })
    assert.equal(none.total, ALL_SESSIONS.length)
  })
})

// ── 6. 分类文件损坏：视为无过滤 ─────────────────────────────────────

await test('分类文件损坏：不报错，视为无过滤', async () => {
  await withTempHome(async home => {
    const dir = join(home, 'topic-map', 'categories')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${WORKSPACE_ID}.json`), '{ 这不是 JSON', 'utf8')
    const ctx = await prepare()
    const result = await search(ctx, { categoryId: 'cat-a' })
    assert.equal(result.total, ALL_SESSIONS.length)
    assert.equal(result.coverage.sessions, ALL_SESSIONS.length)
  })
})

// ── 6b. 分类文件缺失时，其它过滤仍然生效 ───────────────────────────

await test('分类文件缺失：分类过滤作废，但 filters.sessionIds 仍然生效', async () => {
  await withTempHome(async () => {
    const ctx = await prepare()
    const result = await search(ctx, {
      categoryId: 'cat-a',
      filters: { sessionIds: ['sess-none'] },
    })
    assert.deepEqual(hitSessionIds(result), ['sess-none'])
    assert.equal(result.coverage.sessions, 1)
  })
})

// ── 7. 与 filters.sessionIds 求交集 ─────────────────────────────────

await test('与 filters.sessionIds 求交集：只扫描共同会话', async () => {
  await withTempHome(async home => {
    await writeStore(home)
    const ctx = await prepare()
    const result = await search(ctx, {
      categoryId: 'cat-a',
      filters: { sessionIds: ['sess-b', 'sess-c'] },
    })
    assert.deepEqual(hitSessionIds(result), ['sess-b'])
    assert.equal(result.coverage.sessions, 1)
  })
})

// ── 8. 与请求顶层 sessionIds 求交集 ────────────────────────────────

await test('与请求顶层 sessionIds 求交集', async () => {
  await withTempHome(async home => {
    await writeStore(home)
    const ctx = await prepare()
    const result = await search(ctx, {
      categoryId: 'cat-a',
      sessionIds: ['sess-a', 'sess-none'],
    })
    assert.deepEqual(hitSessionIds(result), ['sess-a'])
    assert.equal(result.coverage.sessions, 1)
  })
})

// ── 9. 空分类：返回空而不是"退化成全部" ────────────────────────────

await test('已有分类但没有任何会话：空结果、coverage 0，不退化成全部', async () => {
  await withTempHome(async home => {
    await writeStore(home)
    const ctx = await prepare()
    const result = await search(ctx, { categoryId: 'cat-empty' })
    assert.deepEqual(result.hits, [])
    assert.equal(result.total, 0)
    assert.equal(result.scanned, 0)
    assert.deepEqual(result.coverage, {
      sessions: 0,
      indexed: 0,
      scannedFromLog: 0,
      indexing: 0,
    })
  })
})

// ── 10. 未知分类：空结果（分类文件存在，只是 id 不存在） ───────────

await test('未知 categoryId：空结果，不报错也不放宽成全部', async () => {
  await withTempHome(async home => {
    await writeStore(home)
    const ctx = await prepare()
    const result = await search(ctx, { categoryId: 'cat-does-not-exist' })
    assert.equal(result.total, 0)
    assert.equal(result.coverage.sessions, 0)
    assert.equal(result.reason, undefined)
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
