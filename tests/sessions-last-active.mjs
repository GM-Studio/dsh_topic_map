/**
 * `/sessions` 的 lastActive（历史页列表/时间线切换依赖）。
 *
 * 口径（按优先级）：
 *   1. 索引首行 meta 里的活动时间（新格式预留字段）；
 *   2. 索引最后一轮：`end` 优先，没有则 `start`；
 *   3. 索引缺失/不可读时读会话摘要时间（宿主 listSessions 记录里暴露的
 *      summary/updatedAt/lastPromptAt 等字段）；
 *   4. 都拿不到 → `null`（不能拿 createdAt 冒充"最后活动"）。
 *
 * 同时锁住原有字段不变：sessionId/title/turns/tokens/subagent/
 * delegationDepth/createdAt。
 *
 * Run: node tests/sessions-last-active.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  flushIndexSyncs,
  listWorkspaceSessions,
  syncSessionIndexFor,
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

/** 造事件流；`end:false` 表示这一轮没有 turn/end（仍算一轮）。 */
function makeEvents(specs) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = BASE_TIME + (spec.offset ?? index * 60_000)
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
    if (spec.end !== false) {
      push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
    }
  })
  return events
}

/**
 * 假 Host context。
 *
 * `summaries` 是会话摘要时间（数字 → 挂成记录上的 updatedAt）；
 * `recordExtras` 用于模拟其他宿主版本把摘要时间藏在 projections 里。
 */
function makeCtx(options = {}) {
  const events = options.events ?? {}
  const ids = options.sessions ?? Object.keys(events)
  const records = ids.map(id => {
    const record = {
      header: {
        id,
        createdAt: options.createdAt?.[id] ?? BASE_TIME - 10_000,
        origin: options.origin?.[id] ?? 'main',
        delegationDepth: options.depth?.[id] ?? 0,
      },
    }
    if (Number.isFinite(options.summaries?.[id])) record.updatedAt = options.summaries[id]
    if (options.recordExtras?.[id] !== undefined) Object.assign(record, options.recordExtras[id])
    return record
  })
  return {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return {
        list: () => [{
          id: 'ws-1',
          path: 'E:\\ws',
          title: '工作区 A',
          sessionIds: ids,
        }],
      }
    },
    sessionQuery: {
      async listSessions() {
        return records
      },
      async readTitleSnapshots(wanted) {
        return wanted.map(id => ({
          status: 'fulfilled',
          sessionId: id,
          value: { title: { title: options.titles?.[id] ?? id } },
        }))
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

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'sessions-last-active-'))
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

console.log('\nsessions-last-active')

// ── 1. 正常：索引最后一行 end ───────────────────────────────────────

await test('索引可用：lastActive 取最后一轮 end，原有字段保持', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-a': makeEvents([
        { prompt: '第一轮', offset: 0 },
        { prompt: '第二轮', offset: 60_000 },
      ]),
    }
    const ctx = makeCtx({
      events,
      titles: { 'sess-a': '会话 A' },
      createdAt: { 'sess-a': BASE_TIME - 5_000 },
    })
    await syncSessionIndexFor(ctx, 'sess-a')

    const list = await listWorkspaceSessions(ctx, null, 'ws-1')
    assert.equal(list.sessions.length, 1)
    const row = list.sessions[0]
    assert.equal(row.sessionId, 'sess-a')
    assert.equal(row.title, '会话 A')
    assert.equal(row.turns, 2)
    assert.equal(row.lastActive, BASE_TIME + 60_000 + 5000)
    // 原有字段向后兼容
    assert.equal(row.createdAt, BASE_TIME - 5_000)
    assert.equal(row.subagent, false)
    assert.equal(row.delegationDepth, 0)
    assert.equal(row.tokens, null)
    assert.equal(list.total, 1)
    assert.equal(list.hidden, 0)
  })
})

// ── 2. 最后一轮没结束时退 start ─────────────────────────────────────

await test('最后一轮没有 turn/end：lastActive 退该轮 start', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-open': makeEvents([{ prompt: '未收尾的一轮', offset: 30_000, end: false }]),
    }
    const ctx = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-open')

    const list = await listWorkspaceSessions(ctx, null, 'ws-1')
    assert.equal(list.sessions.length, 1)
    assert.equal(list.sessions[0].turns, 1)
    assert.equal(list.sessions[0].lastActive, BASE_TIME + 30_000)
  })
})

// ── 3. 索引缺失：读会话摘要时间 ─────────────────────────────────────

await test('索引缺失：lastActive 取宿主会话摘要的 updatedAt', async () => {
  await withTempHome(async () => {
    const summaryTime = BASE_TIME + 120_000
    const ctx = makeCtx({
      events: { 'sess-sum': makeEvents([{ prompt: '摘要时间' }]) },
      summaries: { 'sess-sum': summaryTime },
    })
    // 故意不建索引
    const list = await listWorkspaceSessions(ctx, null, 'ws-1')
    assert.equal(list.sessions.length, 1)
    assert.equal(list.sessions[0].lastActive, summaryTime)
  })
})

await test('索引缺失：摘要时间在 projections.sessionListMetadata.lastPromptAt 也能读', async () => {
  await withTempHome(async () => {
    const promptTime = BASE_TIME + 240_000
    const ctx = makeCtx({
      events: { 'sess-proj': makeEvents([{ prompt: '投影时间' }]) },
      recordExtras: {
        'sess-proj': {
          projections: { values: { sessionListMetadata: { blank: false, lastPromptAt: promptTime } } },
        },
      },
    })
    const list = await listWorkspaceSessions(ctx, null, 'ws-1')
    assert.equal(list.sessions[0].lastActive, promptTime)
  })
})

// ── 4. 索引缺失且没有摘要：null，绝不拿 createdAt 冒充 ─────────────

await test('索引与摘要都缺失：lastActive 为 null（不是 createdAt）', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { 'sess-null': makeEvents([{ prompt: '没有时间源' }]) },
      createdAt: { 'sess-null': BASE_TIME - 99_000 },
    })
    const list = await listWorkspaceSessions(ctx, null, 'ws-1')
    assert.equal(list.sessions.length, 1)
    assert.equal(list.sessions[0].lastActive, null)
    assert.notEqual(list.sessions[0].lastActive, list.sessions[0].createdAt)
  })
})

// ── 5. 索引 meta 优先于最后一行 ────────────────────────────────────

await test('索引 meta 带活动时间：优先于最后一行', async () => {
  await withTempHome(async () => {
    const events = { 'sess-meta': makeEvents([{ prompt: '待写 meta' }]) }
    const ctx = makeCtx({ events })
    const synced = await syncSessionIndexFor(ctx, 'sess-meta')
    const metaTime = BASE_TIME + 900_000
    const metaLine = JSON.stringify({ ...synced.meta, lastActive: metaTime })
    const path = indexFilePath(defaultSessionsDir(), 'sess-meta')
    await writeFile(path, [metaLine, ...synced.turns.map(row => JSON.stringify(row)), ''].join('\n'), 'utf8')

    const list = await listWorkspaceSessions(ctx, null, 'ws-1')
    assert.equal(list.sessions[0].lastActive, metaTime)
  })
})

// ── 6. 索引损坏：退摘要，不抛错 ─────────────────────────────────────

await test('索引损坏：不抛错，lastActive 退会话摘要时间', async () => {
  await withTempHome(async () => {
    const summaryTime = BASE_TIME + 333_000
    const ctx = makeCtx({
      events: { 'sess-bad': makeEvents([{ prompt: '坏索引' }]) },
      summaries: { 'sess-bad': summaryTime },
    })
    const path = indexFilePath(defaultSessionsDir(), 'sess-bad')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'this is not json\n', 'utf8')

    const list = await listWorkspaceSessions(ctx, null, 'ws-1')
    assert.equal(list.sessions.length, 1)
    assert.equal(list.sessions[0].lastActive, summaryTime)
  })
})

// ── 7. 末行超过初始窗口：扩窗而不是误报 ────────────────────────────

await test('最后一轮超过 64KB 窗口：扩窗读取，不误报 null/上一轮', async () => {
  await withTempHome(async () => {
    // 32000 个汉字在 JSON 里约 96KB，超过 64KB 初始窗口。
    const longResponse = '填充'.repeat(16_000)
    const events = {
      'sess-big': makeEvents([
        { prompt: '短轮', offset: 0 },
        { prompt: '长轮', response: longResponse, offset: 60_000 },
      ]),
    }
    const ctx = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-big')

    const list = await listWorkspaceSessions(ctx, null, 'ws-1')
    assert.equal(list.sessions.length, 1)
    assert.equal(list.sessions[0].turns, 2)
    assert.equal(list.sessions[0].lastActive, BASE_TIME + 60_000 + 5000)
  })
})

// ── 8. 空工作区 ─────────────────────────────────────────────────────

await test('空工作区：返回空列表而不是抛错', async () => {
  const ctx = makeCtx({ events: {}, sessions: [] })
  const list = await listWorkspaceSessions(ctx, null, 'ws-1')
  assert.deepEqual(list.sessions, [])
  assert.equal(list.total, 0)
  assert.equal(list.workspace.id, 'ws-1')
})

// ── 9. 结果按原顺序，lastActive 不改变字段集合 ──────────────────────

await test('多会话：顺序与字段集合不变，每行都有 lastActive 键', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-one': makeEvents([{ prompt: '甲' }]),
      'sess-two': makeEvents([{ prompt: '乙' }]),
    }
    const ctx = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-one')
    await syncSessionIndexFor(ctx, 'sess-two')

    const list = await listWorkspaceSessions(ctx, null, 'ws-1')
    assert.deepEqual(list.sessions.map(row => row.sessionId), ['sess-one', 'sess-two'])
    for (const row of list.sessions) {
      assert.deepEqual(Object.keys(row).sort(), [
        'createdAt', 'delegationDepth', 'lastActive', 'sessionId', 'subagent', 'title', 'tokens', 'turns',
      ])
      assert.equal(typeof row.lastActive, 'number')
    }
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
