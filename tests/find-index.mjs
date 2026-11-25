/**
 * /find 改读索引的测试（P0-5）。
 *
 * 三条线都要锁住：
 *   1. 索引可用时搜全文——80/160 字预览之外的词也能命中，且不读日志；
 *   2. 索引缺失 / 损坏 / revision 过期时回退旧实现，结果形状与旧行为一致；
 *   3. 既有语义不变：一个会话只报第一条命中、按时间倒序、截断口径。
 *
 * 索引目录用 DSH_HOME 指到临时目录，绝不碰真实的 ~/.dsh。
 *
 * Run: node tests/find-index.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findAcrossSessions, syncSessionIndexFor } from '../lib/index.js'
import { defaultSessionsDir, indexFilePath, removeIndexFile } from '../lib/turn-index.js'

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

/**
 * 造一段会话事件流。spec：`{turn, prompt, response, baseTime}`。
 */
function makeEvents(specs, offset = 0) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = BASE_TIME + offset + index * 60_000
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

/**
 * 假 Host context：会话、标题、revision、变更摘要都可注入。
 */
function makeCtx(options = {}) {
  const events = options.events ?? {}
  const titles = options.titles ?? {}
  const revisions = options.revisions ?? {}
  const state = { readSession: 0, readTitle: 0 }
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
        return ids.map(id => ({
          status: 'fulfilled',
          sessionId: id,
          value: { title: { title: titles[id] ?? id } },
        }))
      },
      async readSession(id) {
        state.readSession += 1
        return { events: events[id] ?? [] }
      },
    },
    sessionPersistence: {
      async stat(id) {
        return { revision: revisions[id] ?? 'rev-1' }
      },
    },
  }
  if (options.summary !== undefined) {
    ctx.workspaceChanges = { summary: options.summary }
  }
  return { ctx, state, revisions }
}

/** 建一个测试专属 home；用例结束删掉。 */
async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'find-index-'))
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

console.log('\nfind-index')

// ── 索引可用：搜全文、不读日志 ──────────────────────────────────────

await test('索引可用时搜全文，且不读会话日志', async () => {
  await withTempHome(async () => {
    const longTail = '焦点词XYZ'
    const events = {
      'sess-full': makeEvents([{
        prompt: '把左栏改一下',
        response: `${'填'.repeat(400)}${longTail}收尾`,
      }]),
    }
    const { ctx, state } = makeCtx({ events })
    const built = await syncSessionIndexFor(ctx, 'sess-full')
    assert.equal(built.skipped, false)

    // 旧实现只留 160 字预览，这个词根本不在检索范围里。
    state.readSession = 0
    const result = await findAcrossSessions(ctx, 'ws-1', longTail, 20)
    assert.equal(result.status, 'ready')
    assert.equal(result.total, 1)
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].sessionId, 'sess-full')
    assert.equal(result.hits[0].type, 'response')
    assert.equal(result.hits[0].turn, 0)
    assert.equal(result.hits[0].seq, 0)
    assert.equal(result.hits[0].time, BASE_TIME)
    assert.ok(result.hits[0].snippet.includes(longTail), `片段里没有命中词：${result.hits[0].snippet}`)
    assert.equal(state.readSession, 0, '索引可用时不该再读会话日志')
  })
})

await test('返回结构与旧实现逐字段一致', async () => {
  await withTempHome(async () => {
    const events = { 'sess-shape': makeEvents([{ prompt: '请检查这个问题', response: '好的，已修复' }]) }
    const { ctx } = makeCtx({ events, titles: { 'sess-shape': '会话标题' } })
    await syncSessionIndexFor(ctx, 'sess-shape')

    const result = await findAcrossSessions(ctx, 'ws-1', '检查', 20)
    assert.deepEqual(result, {
      status: 'ready',
      query: '检查',
      workspace: { id: 'ws-1', path: 'E:\\ws', title: '工作区 A' },
      hits: [{
        sessionId: 'sess-shape',
        title: '会话标题',
        turn: 0,
        seq: 0,
        type: 'prompt',
        snippet: '请检查这个问题',
        time: BASE_TIME,
      }],
      total: 1,
      scanned: 1,
      truncated: false,
    })
  })
})

await test('一个会话只报第一条命中（既有语义不变）', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-multi': makeEvents([
        { prompt: '第一次提到关键词', response: '甲' },
        { prompt: '第二次也提到关键词', response: '乙' },
      ]),
    }
    const { ctx } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-multi')
    const result = await findAcrossSessions(ctx, 'ws-1', '关键词', 20)
    assert.equal(result.hits.length, 1)
    assert.equal(result.hits[0].turn, 0)
  })
})

await test('结果按时间倒序，scanned/total/truncated 口径不变', async () => {
  await withTempHome(async () => {
    const early = makeEvents([{ prompt: '共同词 早' }], 0)
    const late = makeEvents([{ prompt: '共同词 晚' }], 600_000)
    const events = { 'sess-early': early, 'sess-late': late }
    const { ctx } = makeCtx({ events, sessions: ['sess-early', 'sess-late'] })
    await syncSessionIndexFor(ctx, 'sess-early')
    await syncSessionIndexFor(ctx, 'sess-late')

    const all = await findAcrossSessions(ctx, 'ws-1', '共同词', 20)
    assert.deepEqual(all.hits.map(h => h.sessionId), ['sess-late', 'sess-early'])
    assert.equal(all.total, 2)
    assert.equal(all.scanned, 2)
    assert.equal(all.truncated, false)

    const firstOnly = await findAcrossSessions(ctx, 'ws-1', '共同词', 1)
    assert.equal(firstOnly.hits.length, 1)
    assert.equal(firstOnly.total, 1)
    assert.equal(firstOnly.scanned, 2)
    assert.equal(firstOnly.truncated, true)
  })
})

// ── 回退：缺失 / 损坏 / 过期 ────────────────────────────────────────

await test('索引缺失时回退旧实现（只搜预览文本）', async () => {
  await withTempHome(async () => {
    const hidden = '预览外词Z'
    const events = {
      'sess-missing': makeEvents([{
        prompt: '请处理',
        response: `${'铺'.repeat(400)}${hidden}`,
      }]),
    }
    const { ctx, state } = makeCtx({ events })

    const result = await findAcrossSessions(ctx, 'ws-1', hidden, 20)
    assert.equal(result.status, 'ready')
    assert.equal(result.hits.length, 0, '没有索引时不该搜到 160 字预览之外的词')
    assert.equal(state.readSession, 1, '回退路径应读会话日志')

    // 预览范围内的词仍然能搜到，保证回退不是“什么都不返回”。
    const visible = await findAcrossSessions(ctx, 'ws-1', '请处理', 20)
    assert.equal(visible.hits.length, 1)
    assert.equal(visible.hits[0].type, 'prompt')
  })
})

await test('索引文件损坏时回退旧实现', async () => {
  await withTempHome(async () => {
    const hidden = '预览外词Q'
    const events = {
      'sess-corrupt': makeEvents([{
        prompt: '请处理',
        response: `${'铺'.repeat(400)}${hidden}`,
      }]),
    }
    const { ctx, state } = makeCtx({ events })
    const built = await syncSessionIndexFor(ctx, 'sess-corrupt')
    // 保留 meta，砍掉轮次行：结构校验会判损坏。
    const text = await readFile(built.path, 'utf8')
    const metaLine = text.split('\n')[0]
    await writeFile(built.path, `${metaLine}\n`, 'utf8')

    state.readSession = 0
    const result = await findAcrossSessions(ctx, 'ws-1', hidden, 20)
    assert.equal(result.hits.length, 0)
    assert.equal(state.readSession, 1, '索引损坏时应回退旧实现')
  })
})

await test('revision 过期时回退旧实现', async () => {
  await withTempHome(async () => {
    const hidden = '预览外词W'
    const events = {
      'sess-stale': makeEvents([{
        prompt: '请处理',
        response: `${'铺'.repeat(400)}${hidden}`,
      }]),
    }
    const { ctx, state, revisions } = makeCtx({ events })
    const built = await syncSessionIndexFor(ctx, 'sess-stale')
    assert.equal(built.meta.revision, 'rev-1')

    // 日志前进了：索引的 revision 与宿主不一致，视为过期。
    revisions['sess-stale'] = 'rev-2'
    state.readSession = 0
    const result = await findAcrossSessions(ctx, 'ws-1', hidden, 20)
    assert.equal(result.hits.length, 0, '过期索引不该被当成最新全文')
    assert.equal(state.readSession, 1, '过期时应回退旧实现')
  })
})

await test('索引目录不可写/不存在时检索仍然可用', async () => {
  await withTempHome(async home => {
    // 把索引目录占成一个普通文件，readIndexFile 必然失败 → 必须回退。
    await mkdir(join(home, 'topic-map', 'index'), { recursive: true })
    await writeFile(defaultSessionsDir(), 'not a directory', 'utf8').catch(() => {})
    const events = { 'sess-blocked': makeEvents([{ prompt: '检索仍要能用' }]) }
    const { ctx } = makeCtx({ events })
    const result = await findAcrossSessions(ctx, 'ws-1', '检索', 20)
    assert.equal(result.status, 'ready')
    assert.equal(result.hits.length, 1)
  })
})

await test('revision 读不出来时也回退，不让检索失败', async () => {
  await withTempHome(async () => {
    const events = { 'sess-nostat': makeEvents([{ prompt: '仍要能搜到' }]) }
    const { ctx } = makeCtx({ events })
    ctx.sessionPersistence.stat = async () => {
      throw new Error('stat failed')
    }
    const result = await findAcrossSessions(ctx, 'ws-1', '能搜到', 20)
    assert.equal(result.status, 'ready')
    assert.equal(result.hits.length, 1)
  })
})

// ── 边界 ────────────────────────────────────────────────────────────

await test('空查询的返回形状不变', async () => {
  const { ctx } = makeCtx({ events: {} })
  assert.deepEqual(await findAcrossSessions(ctx, 'ws-1', '   ', 20), {
    status: 'ready',
    query: '',
    hits: [],
  })
})

await test('没有工作区时返回 unavailable（形状不变）', async () => {
  const ctx = { get: () => undefined }
  assert.deepEqual(await findAcrossSessions(ctx, 'ws-1', '词', 20), {
    status: 'unavailable',
    reason: '没有工作区',
    hits: [],
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
