/**
 * 检索端点测试（P0-3）：POST /api/topic-map/search 的接线层。
 *
 * 只测"接线"：会话枚举、索引/回退双数据源、stamp（sessionId/title）、
 * 过滤与排序透传、limit 上限、offset/hasMore 分页、ready/missing 口径、
 * 后台补索引不阻塞。检索口径本身由 tests/search-index.mjs 覆盖。
 *
 * Run: node tests/search-endpoint.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flushIndexSyncs,
  listSessionCommands,
  reindexWorkspace,
  searchWorkspaceIndex,
  syncSessionIndexFor,
} from '../lib/index.js'
import { defaultSessionsDir, indexFilePath, readIndexFile } from '../lib/turn-index.js'

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

/** 造事件流；spec 支持 prompt/response/calls/endReason/baseTime。 */
function makeEvents(specs, offset = 0) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = spec.start ?? (BASE_TIME + offset + index * 60_000)
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `问题 ${turn}` }],
      source: { kind: 'user' },
    }, start + 100)
    for (const call of spec.calls ?? []) {
      push('tool/call', { name: call.name, arguments: JSON.stringify(call.args ?? {}) }, start + 300)
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `回答 ${turn}` }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, start + 5000)
  })
  return events
}

/** 假 Host context：会话/标题/revision/读取行为都可注入。 */
function makeCtx(options = {}) {
  const events = options.events ?? {}
  const titles = options.titles ?? {}
  const revisions = options.revisions ?? {}
  const state = { readSession: 0, readTitle: 0 }
  const workspaces = options.workspaces ?? [{
    id: 'ws-1',
    path: 'E:\\ws',
    title: '工作区 A',
    sessionIds: options.sessions ?? Object.keys(events),
  }]
  const ctx = {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return { list: () => workspaces }
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
        if (typeof options.onRead === 'function') await options.onRead(id)
        return { events: events[id] ?? [] }
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

/** 临时 home（DSH_HOME 指过去）；用例结束恢复并清理。 */
async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'search-endpoint-'))
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

console.log('\nsearch-endpoint')

// ── 索引数据源与 stamp ──────────────────────────────────────────────

await test('索引可用：命中带上 sessionId/title，按会话分组不塌', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-a': makeEvents([{ prompt: '共同词 甲', response: '答甲' }, { prompt: '共同词 乙', response: '答乙' }]),
      'sess-b': makeEvents([{ prompt: '共同词 丙', response: '答丙' }]),
    }
    const { ctx } = makeCtx({ events, titles: { 'sess-a': '会话 A', 'sess-b': '会话 B' } })
    await syncSessionIndexFor(ctx, 'sess-a')
    await syncSessionIndexFor(ctx, 'sess-b')

    const grouped = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '共同词',
      groupBy: 'session',
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(grouped.total, 3)
    assert.equal(grouped.scanned, 2)
    assert.deepEqual(grouped.indexed, { ready: 2, missing: 0 })
    assert.equal(grouped.hits.length, 2, '同会话命中应折成一组')
    const groupA = grouped.hits.find(group => group.sessionId === 'sess-a')
    assert.ok(groupA !== undefined, '分组丢了 sessionId（stamp 失败）')
    assert.equal(groupA.title, '会话 A')
    assert.equal(groupA.count, 2)
    assert.ok(Array.isArray(groupA.hits) && groupA.hits.length === 2)
    assert.ok(typeof groupA.score === 'number')

    const flat = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '共同词',
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(flat.hits.length, 3)
    for (const hit of flat.hits) {
      assert.ok(hit.sessionId === 'sess-a' || hit.sessionId === 'sess-b', `命中缺 sessionId：${hit.sessionId}`)
      assert.ok(typeof hit.title === 'string' && hit.title !== '')
      assert.ok(hit.snippet.includes('共同词'))
      assert.ok(typeof hit.score === 'number')
      assert.ok(Array.isArray(hit.breakdown.parts))
    }
  })
})

await test('命中计数 = markdown 代码块数（tool 命令不参与；分组给合计）', async () => {
  await withTempHome(async () => {
    const twoBlocks = [
      '结论如下。',
      '```bash',
      'npm test',
      '```',
      '```js',
      'console.log(1)',
      '```',
    ].join('\n')
    const events = {
      'sess-cmd': makeEvents([
        {
          prompt: '跑命令 关键词',
          response: twoBlocks,
          calls: [
            { name: 'run_code', args: { command: 'npm test' } },
            { name: 'run_code', args: { command: 'npm run build' } },
            { name: 'run_code', args: { command: 'git status' } },
          ],
        },
        {
          prompt: '没代码块 关键词',
          response: '这一轮只有普通回答',
          calls: [
            { name: 'run_code', args: { command: 'echo 1' } },
            { name: 'run_code', args: { command: 'echo 2' } },
          ],
        },
      ]),
      'sess-nocmd': makeEvents([{ prompt: '关键词 无命令' }]),
    }
    const { ctx } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-cmd')
    await syncSessionIndexFor(ctx, 'sess-nocmd')

    const flat = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '关键词',
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    const blockTurn = flat.hits.find(hit => hit.sessionId === 'sess-cmd' && hit.turn === 0)
    assert.equal(blockTurn.blockCount, 2, '两个围栏块')
    assert.equal(blockTurn.commandCount, 2, 'commandCount 是 blockCount 的别名')
    const toolOnlyTurn = flat.hits.find(hit => hit.sessionId === 'sess-cmd' && hit.turn === 1)
    assert.equal(toolOnlyTurn.blockCount, 0, 'tool 命令再多也不计入')
    assert.equal(toolOnlyTurn.commandCount, 0)
    const other = flat.hits.find(hit => hit.sessionId === 'sess-nocmd')
    assert.equal(other.blockCount, 0)

    const grouped = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '关键词',
      groupBy: 'session',
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    const group = grouped.hits.find(item => item.sessionId === 'sess-cmd')
    assert.ok(Array.isArray(group.hits))
    assert.equal(group.hits.find(hit => hit.turn === 0).blockCount, 2)
    assert.equal(group.hits.find(hit => hit.turn === 1).blockCount, 0)
    assert.equal(group.blockCount, 2, '分组上应是组内代码块合计')
    assert.equal(group.commandCount, 2)
  })
})

await test('tool 命令变化不改变计数；只有代码块变化才改变', async () => {
  await withTempHome(async () => {
    const oneBlock = ['```bash', 'npm test', '```'].join('\n')
    const twoBlocks = ['```bash', 'a', '```', '```js', 'b', '```'].join('\n')
    const events = {
      'sess-tool-0': makeEvents([{ prompt: '计数 关键词', response: oneBlock, calls: [] }]),
      'sess-tool-3': makeEvents([{
        prompt: '计数 关键词',
        response: oneBlock,
        calls: [
          { name: 'run_code', args: { command: 'a' } },
          { name: 'run_code', args: { command: 'b' } },
          { name: 'run_code', args: { command: 'c' } },
        ],
      }]),
      'sess-block-0': makeEvents([{
        prompt: '计数 关键词',
        response: '纯文字',
        calls: [{ name: 'run_code', args: { command: 'a' } }, { name: 'run_code', args: { command: 'b' } }],
      }]),
      'sess-block-2': makeEvents([{
        prompt: '计数 关键词',
        response: twoBlocks,
        calls: [{ name: 'run_code', args: { command: 'a' } }, { name: 'run_code', args: { command: 'b' } }],
      }]),
    }
    const { ctx } = makeCtx({ events })
    for (const id of Object.keys(events)) await syncSessionIndexFor(ctx, id)

    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '关键词',
      limit: 20,
      now: BASE_TIME + 10_000,
    })
    const countOf = id => result.hits.find(hit => hit.sessionId === id)?.blockCount
    assert.equal(countOf('sess-tool-0'), 1)
    assert.equal(countOf('sess-tool-3'), 1, 'tool 命令从 0 变 3，计数必须不变')
    assert.equal(countOf('sess-block-0'), 0)
    assert.equal(countOf('sess-block-2'), 2, '代码块从 0 变 2，计数才变')
  })
})

await test('/search 计数与 /session-commands total 一致（同会话、无筛选）', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-consistency': makeEvents([
        {
          prompt: '一致性 关键词',
          response: ['```bash', 'npm test', '```', '```', 'plain', '```'].join('\n'),
          calls: [{ name: 'run_code', args: { command: 'ignored' } }],
        },
        {
          prompt: '一致性 关键词 第二',
          response: '没有块',
          calls: [{ name: 'run_code', args: { command: 'ignored-2' } }],
        },
      ]),
    }
    const { ctx } = makeCtx({ events, sessions: ['sess-consistency'] })
    await syncSessionIndexFor(ctx, 'sess-consistency')

    const search = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '一致性',
      limit: 100,
      now: BASE_TIME + 10_000,
    })
    const searchTotal = search.hits.reduce((sum, hit) => sum + (hit.blockCount ?? 0), 0)
    const commands = await listSessionCommands(ctx, { sessionId: 'sess-consistency' })
    assert.equal(commands.ok, true, commands.error)
    assert.equal(searchTotal, commands.value.total, '同一会话无筛选时两边计数必须一致')
    assert.equal(searchTotal, 2)
  })
})

await test('索引缺失的会话也进结果（回退全文抽取），并计入 missing', async () => {
  await withTempHome(async () => {
    const tail = '预览外尾巴词'
    const events = {
      'sess-ready': makeEvents([{ prompt: '开头', response: `${'铺'.repeat(400)}${tail}` }]),
      'sess-missing': makeEvents([{ prompt: '开头', response: `${'垫'.repeat(400)}${tail}` }]),
    }
    const { ctx, state } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-ready')

    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: tail,
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(result.total, 2, '缺索引的会话丢了结果')
    assert.deepEqual(result.indexed, { ready: 1, missing: 1 })
    assert.equal(result.scanned, 2)
    const fromMissing = result.hits.find(hit => hit.sessionId === 'sess-missing')
    assert.ok(fromMissing !== undefined)
    assert.ok(fromMissing.snippet.includes(tail), '回退路径没有用全文（仍是 160 字预览）')

    await flushIndexSyncs()
    const built = await readIndexFile(defaultSessionsDir(), 'sess-missing')
    assert.equal(built.ok, true, '检索没有在后台补索引')
    assert.equal(built.meta.revision, 'rev-1')
    assert.ok(state.readSession >= 2)
  })
})

await test('warmup 标记：命中未索引会话为 true，补齐后为 false', async () => {
  await withTempHome(async () => {
    const events = { 'sess-warmup': makeEvents([{ prompt: '预热标记词' }]) }
    const { ctx } = makeCtx({ events })

    const first = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '预热标记词',
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(first.warmup, true, '命中未索引会话时应标记本次触发了后台同步')
    assert.ok(first.coverage.indexing >= 1)

    await flushIndexSyncs()
    const second = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '预热标记词',
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(second.warmup, false, '索引已补齐后不应再标记 warmup')
    assert.equal(second.coverage.indexing, 0)
  })
})

await test('索引损坏/过期一律回退，并计入 missing', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-stale': makeEvents([{ prompt: '甲 共同词' }]),
      'sess-corrupt': makeEvents([{ prompt: '乙 共同词' }]),
    }
    const { ctx, revisions } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-stale')
    const corrupt = await syncSessionIndexFor(ctx, 'sess-corrupt')
    revisions['sess-stale'] = 'rev-2' // 日志前进，索引过期
    // 保留 meta、删掉轮次行：结构校验判损坏。
    const text = await readFile(corrupt.path, 'utf8')
    await writeFile(corrupt.path, `${text.split('\n')[0]}\n`, 'utf8')

    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '共同词',
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(result.total, 2)
    assert.deepEqual(result.indexed, { ready: 0, missing: 2 })

    // 后台补索引不能只看 meta：损坏文件 meta 可能完好，必须走完整校验修复。
    await flushIndexSyncs()
    assert.equal((await readIndexFile(defaultSessionsDir(), 'sess-corrupt')).ok, true, '损坏索引应被后台修复')
    assert.equal((await readIndexFile(defaultSessionsDir(), 'sess-stale')).meta.revision, 'rev-2', '过期索引应被后台重建')
  })
})

// ── 过滤 / 排序 / 上限 ──────────────────────────────────────────────

await test('结构过滤、时间区间、多词 AND 都透传给内核', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-f1': makeEvents([
        {
          prompt: '改一下 与 客户端',
          calls: [{ name: 'edit', args: { path: 'lib/client.js' } }],
          endReason: 'completed',
        },
      ]),
      'sess-f2': makeEvents([
        {
          prompt: '改一下 与 服务端',
          calls: [{ name: 'bash', args: { path: 'lib/index.js' } }],
          endReason: 'error',
        },
      ]),
    }
    const { ctx } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-f1')
    await syncSessionIndexFor(ctx, 'sess-f2')
    const base = { workspaceId: 'ws-1', now: BASE_TIME + 10_000, limit: 10 }

    assert.equal((await searchWorkspaceIndex(ctx, { ...base, keywords: '改一下 与' })).total, 2)
    assert.equal((await searchWorkspaceIndex(ctx, { ...base, keywords: '改一下 不存在' })).total, 0)

    const byTool = await searchWorkspaceIndex(ctx, { ...base, keywords: '', filters: { tools: ['edit'] } })
    assert.deepEqual(byTool.hits.map(hit => hit.sessionId), ['sess-f1'])

    const byFile = await searchWorkspaceIndex(ctx, { ...base, keywords: '', filters: { files: ['client.js'] } })
    assert.deepEqual(byFile.hits.map(hit => hit.sessionId), ['sess-f1'])

    const byReason = await searchWorkspaceIndex(ctx, { ...base, keywords: '', filters: { endReason: ['error'] } })
    assert.deepEqual(byReason.hits.map(hit => hit.sessionId), ['sess-f2'])

    const bySession = await searchWorkspaceIndex(ctx, { ...base, keywords: '', filters: { sessionIds: ['sess-f2'] } })
    assert.equal(bySession.hits.length, 1)
    assert.equal(bySession.scanned, 1, 'scanned 应是窄化后的会话数')

    const early = BASE_TIME
    const end0 = early + 5000
    const inRange = await searchWorkspaceIndex(ctx, {
      ...base,
      keywords: '',
      timeRange: { from: early, to: end0 },
    })
    assert.equal(inRange.total, 2, 'from/to 应含头含尾（两个会话各一轮）')
    const beforeEnd = await searchWorkspaceIndex(ctx, { ...base, keywords: '', timeRange: { to: end0 - 1 } })
    assert.equal(beforeEnd.total, 0, 'to 早于结束时刻应排除')
    const afterEnd = await searchWorkspaceIndex(ctx, { ...base, keywords: '', timeRange: { from: end0 + 1 } })
    assert.equal(afterEnd.total, 0, 'from 晚于结束时刻应排除')
  })
})

await test('statuses 过滤读取 labels 文件（键 sessionId#turn）', async () => {
  await withTempHome(async home => {
    const events = {
      'sess-s1': makeEvents([{ prompt: '待跟进的事' }]),
      'sess-s2': makeEvents([{ prompt: '普通的事' }]),
    }
    const { ctx } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-s1')
    await syncSessionIndexFor(ctx, 'sess-s2')
    const labelsPath = join(home, 'topic-map', 'index', 'labels', 'ws-1.json')
    await mkdir(join(home, 'topic-map', 'index', 'labels'), { recursive: true })
    await writeFile(labelsPath, JSON.stringify({ 'sess-s1#0': { followUp: true } }), 'utf8')

    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '',
      filters: { statuses: ['followUp'] },
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(result.total, 1)
    assert.equal(result.hits[0].sessionId, 'sess-s1')
    assert.deepEqual(result.hits[0].breakdown.statuses, ['followUp'])
  })
})

await test('sort=time 按结束时间倒序', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-old': makeEvents([{ prompt: '同词 旧' }], 0),
      'sess-new': makeEvents([{ prompt: '同词 新' }], 600_000),
    }
    const { ctx } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-old')
    await syncSessionIndexFor(ctx, 'sess-new')

    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '同词',
      sort: 'time',
      limit: 10,
      now: BASE_TIME + 700_000,
    })
    assert.deepEqual(result.hits.map(hit => hit.sessionId), ['sess-new', 'sess-old'])
  })
})

await test('空 keywords 默认按时间倒序（浏览态最近的在前）', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-browse': makeEvents([
        { prompt: '浏览 第一轮' },
        { prompt: '浏览 第二轮' },
        { prompt: '浏览 第三轮' },
      ]),
    }
    const { ctx } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-browse')

    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '',
      limit: 10,
      now: BASE_TIME + 10 * 60_000,
    })
    assert.equal(result.total, 3)
    assert.deepEqual(result.hits.map(hit => hit.turn), [2, 1, 0], '浏览态默认应最近一轮在前')
  })
})

await test('空 keywords + 显式 sort:relevance：尊重调用方，不强制时间倒序', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-browse-rel': makeEvents([
        { prompt: '浏览 第一轮' },
        { prompt: '浏览 第二轮' },
        { prompt: '浏览 第三轮' },
      ]),
    }
    const { ctx } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-browse-rel')

    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '',
      sort: 'relevance',
      limit: 10,
      now: BASE_TIME + 10 * 60_000,
    })
    assert.equal(result.total, 3)
    assert.deepEqual(result.hits.map(hit => hit.turn), [0, 1, 2], '显式 relevance 保持同分稳定顺序')
  })
})

await test('有关键词时默认相关度不变：高匹配的早会话仍排在新会话前', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-match-old': makeEvents([{ prompt: '共同词 共同词 共同词' }], 0),
      'sess-match-new': makeEvents([{ prompt: '共同词 新会话' }], 60_000),
    }
    const { ctx } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-match-old')
    await syncSessionIndexFor(ctx, 'sess-match-new')

    const base = {
      workspaceId: 'ws-1',
      keywords: '共同词',
      limit: 10,
      now: BASE_TIME + 10 * 60_000,
    }
    const withDefault = await searchWorkspaceIndex(ctx, base)
    const withRelevance = await searchWorkspaceIndex(ctx, { ...base, sort: 'relevance' })
    const withTime = await searchWorkspaceIndex(ctx, { ...base, sort: 'time' })
    assert.deepEqual(
      withDefault.hits.map(hit => hit.sessionId),
      withRelevance.hits.map(hit => hit.sessionId),
      '有关键词时默认必须仍是相关度',
    )
    assert.deepEqual(withDefault.hits.map(hit => hit.sessionId), ['sess-match-old', 'sess-match-new'])
    assert.deepEqual(withTime.hits.map(hit => hit.sessionId), ['sess-match-new', 'sess-match-old'])
  })
})

await test('浏览态时间倒序分页稳定：同时间按 turn 升序，跨页不重不漏', async () => {
  await withTempHome(async () => {
    const sameStart = BASE_TIME + 30 * 60_000
    const events = {
      'sess-browse-page': makeEvents([
        { prompt: '同刻 第一轮', start: sameStart },
        { prompt: '同刻 第二轮', start: sameStart },
        { prompt: '同刻 第三轮', start: sameStart },
      ]),
    }
    const { ctx } = makeCtx({ events })
    await syncSessionIndexFor(ctx, 'sess-browse-page')
    const base = {
      workspaceId: 'ws-1',
      keywords: '',
      limit: 2,
      now: BASE_TIME + 60 * 60_000,
    }

    const full = await searchWorkspaceIndex(ctx, { ...base, limit: 10 })
    assert.deepEqual(full.hits.map(hit => hit.turn), [0, 1, 2], '同时间按 turn 升序')

    const page1 = await searchWorkspaceIndex(ctx, { ...base, offset: 0 })
    const page2 = await searchWorkspaceIndex(ctx, { ...base, offset: 2 })
    assert.deepEqual(page1.hits.map(hit => hit.turn), [0, 1])
    assert.deepEqual(page2.hits.map(hit => hit.turn), [2])
    assert.equal(page1.hasMore, true)
    assert.equal(page2.hasMore, false)
    assert.equal(page1.total, 3)
    assert.equal(page2.total, 3)
  })
})

await test('limit 上限 200；空 keywords 是浏览态', async () => {
  await withTempHome(async () => {
    const specs = Array.from({ length: 201 }, (_, index) => ({
      prompt: `浏览 ${index}`,
      response: `答 ${index}`,
    }))
    const { ctx } = makeCtx({ events: { 'sess-many': makeEvents(specs) } })
    await syncSessionIndexFor(ctx, 'sess-many')

    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '',
      limit: 9999,
      now: BASE_TIME + 100 * 60_000,
    })
    assert.equal(result.total, 201)
    assert.equal(result.hits.length, 200, 'limit 应封顶 200')
    assert.equal(result.truncated, true)
    assert.equal(result.indexed.ready, 1)
  })
})

// ── 分页（offset / hasMore） ────────────────────────────────────────

await test('offset/limit 真分页：首页/第二页/末页/越界，total 不随分页变化', async () => {
  await withTempHome(async () => {
    const specs = Array.from({ length: 5 }, (_, index) => ({
      prompt: `分页 第 ${index} 轮`,
      response: `答 ${index}`,
    }))
    const { ctx } = makeCtx({ events: { 'sess-page': makeEvents(specs) } })
    await syncSessionIndexFor(ctx, 'sess-page')
    const base = {
      workspaceId: 'ws-1',
      keywords: '分页',
      sort: 'time',
      now: BASE_TIME + 10 * 60_000,
      limit: 2,
    }

    const page1 = await searchWorkspaceIndex(ctx, { ...base, offset: 0 })
    const page2 = await searchWorkspaceIndex(ctx, { ...base, offset: 2 })
    const page3 = await searchWorkspaceIndex(ctx, { ...base, offset: 4 })
    const beyond = await searchWorkspaceIndex(ctx, { ...base, offset: 10 })

    for (const page of [page1, page2, page3, beyond]) {
      assert.equal(page.total, 5, 'total 是过滤后总命中数，不受 offset/limit 影响')
    }
    assert.equal(page1.offset, 0)
    assert.equal(page2.offset, 2)
    assert.equal(page3.offset, 4)
    assert.equal(beyond.offset, 10)

    assert.deepEqual(page1.hits.map(hit => hit.turn), [4, 3], 'sort=time 倒序，首页取前 2')
    assert.deepEqual(page2.hits.map(hit => hit.turn), [2, 1])
    assert.deepEqual(page3.hits.map(hit => hit.turn), [0])
    assert.deepEqual(beyond.hits, [], 'offset 越界返回空数组')

    assert.equal(page1.hasMore, true)
    assert.equal(page2.hasMore, true)
    assert.equal(page3.hasMore, false, '末页 offset + 返回条数 = total')
    assert.equal(beyond.hasMore, false)
    assert.equal(page1.truncated, true)
    assert.equal(page3.truncated, false)

    const all = [...page1.hits, ...page2.hits, ...page3.hits].map(hit => hit.turn)
    assert.deepEqual(all, [4, 3, 2, 1, 0], '跨页拼接不重不漏')
  })
})

await test('分页默认 limit=50：首页 50、第二页剩余，hasMore 边界正确', async () => {
  await withTempHome(async () => {
    const specs = Array.from({ length: 60 }, (_, index) => ({
      prompt: `默认分页 ${index}`,
      response: `答 ${index}`,
    }))
    const { ctx } = makeCtx({ events: { 'sess-60': makeEvents(specs) } })
    await syncSessionIndexFor(ctx, 'sess-60')
    const base = {
      workspaceId: 'ws-1',
      keywords: '默认分页',
      sort: 'time',
      now: BASE_TIME + 100 * 60_000,
    }

    const first = await searchWorkspaceIndex(ctx, base)
    const second = await searchWorkspaceIndex(ctx, { ...base, offset: 50 })
    assert.equal(first.total, 60)
    assert.equal(first.hits.length, 50, '未给 limit 时沿用默认 50')
    assert.equal(first.hasMore, true)
    assert.equal(second.hits.length, 10)
    assert.equal(second.hasMore, false)
    assert.equal(second.total, 60)
  })
})

await test('非法 offset 归 0：负数 / 非数字 / null', async () => {
  await withTempHome(async () => {
    const specs = Array.from({ length: 3 }, (_, index) => ({ prompt: `偏移 ${index}` }))
    const { ctx } = makeCtx({ events: { 'sess-offset': makeEvents(specs) } })
    await syncSessionIndexFor(ctx, 'sess-offset')
    const base = { workspaceId: 'ws-1', keywords: '偏移', limit: 2, now: BASE_TIME + 10_000 }
    const normal = await searchWorkspaceIndex(ctx, { ...base, offset: 0 })
    for (const offset of [-1, -99, 'abc', {}, null, NaN, Infinity]) {
      const result = await searchWorkspaceIndex(ctx, { ...base, offset })
      assert.equal(result.offset, 0, `offset=${String(offset)} 应归一为 0`)
      assert.deepEqual(result.hits.map(hit => hit.turn), normal.hits.map(hit => hit.turn))
      assert.equal(result.hasMore, normal.hasMore)
    }
  })
})

await test('同分排序跨页稳定：sort=time 同结束时间按原顺序，拼接不重不漏', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-tie-a': makeEvents([{ prompt: '同分词 甲' }], 0),
      'sess-tie-b': makeEvents([{ prompt: '同分词 乙' }], 0),
    }
    const { ctx } = makeCtx({ events, sessions: ['sess-tie-a', 'sess-tie-b'] })
    await syncSessionIndexFor(ctx, 'sess-tie-a')
    await syncSessionIndexFor(ctx, 'sess-tie-b')
    const base = { workspaceId: 'ws-1', keywords: '同分词', sort: 'time', now: BASE_TIME + 10_000 }
    const full = await searchWorkspaceIndex(ctx, { ...base, limit: 10 })
    const page1 = await searchWorkspaceIndex(ctx, { ...base, limit: 1, offset: 0 })
    const page2 = await searchWorkspaceIndex(ctx, { ...base, limit: 1, offset: 1 })
    assert.equal(full.total, 2)
    assert.equal(full.hits[0].time, full.hits[1].time, '两命中同分/同时间')
    assert.deepEqual(
      [...page1.hits, ...page2.hits].map(hit => hit.sessionId),
      full.hits.map(hit => hit.sessionId),
      '同分时跨页顺序必须与一次性返回一致',
    )
    assert.equal(page1.hasMore, true)
    assert.equal(page2.hasMore, false)
  })
})

await test('groupBy=session：对组分页、组内 hits 不截断，hasMore 按组数判断', async () => {
  await withTempHome(async () => {
    const sessions = Array.from({ length: 5 }, (_, index) => `sess-group-${index}`)
    const events = Object.fromEntries(sessions.map(id => [
      id,
      makeEvents([
        { prompt: `分组词 ${id} 第一轮` },
        { prompt: `分组词 ${id} 第二轮` },
      ]),
    ]))
    const { ctx } = makeCtx({ events, sessions })
    for (const id of sessions) await syncSessionIndexFor(ctx, id)
    const base = {
      workspaceId: 'ws-1',
      keywords: '分组词',
      groupBy: 'session',
      limit: 2,
      now: BASE_TIME + 10 * 60_000,
    }

    const full = await searchWorkspaceIndex(ctx, { ...base, limit: 10 })
    const page1 = await searchWorkspaceIndex(ctx, { ...base, offset: 0 })
    const page2 = await searchWorkspaceIndex(ctx, { ...base, offset: 2 })
    const page3 = await searchWorkspaceIndex(ctx, { ...base, offset: 4 })
    const beyond = await searchWorkspaceIndex(ctx, { ...base, offset: 6 })

    assert.equal(full.total, 10, 'total 仍是过滤后的命中数（5 会话 × 2 轮）')
    assert.equal(full.hits.length, 5)
    for (const page of [page1, page2, page3, beyond]) assert.equal(page.total, 10)

    assert.deepEqual(page1.hits.map(group => group.sessionId), full.hits.slice(0, 2).map(group => group.sessionId))
    assert.deepEqual(page2.hits.map(group => group.sessionId), full.hits.slice(2, 4).map(group => group.sessionId))
    assert.deepEqual(page3.hits.map(group => group.sessionId), full.hits.slice(4).map(group => group.sessionId))
    assert.deepEqual(beyond.hits, [])

    for (const group of [...page1.hits, ...page2.hits, ...page3.hits]) {
      assert.equal(group.hits.length, 2, '组内 hits 不随组的分页被截断')
      assert.equal(group.count, 2)
    }

    assert.equal(page1.hasMore, true)
    assert.equal(page2.hasMore, true)
    assert.equal(page3.hasMore, false, 'offset+返回组数 = 组总数')
    assert.equal(beyond.hasMore, false)
    assert.equal(page3.hits.length, 1, '末页只剩 1 组')
    // 若按命中数判断，page3 是 4+1 组 ×2 命中 = 10 条中的 2 条，会误判 hasMore；
    // 这里必须按组数：5 组里已到第 5 组，没有更多。
    assert.equal(page3.total, 10)
    assert.equal(page3.hasMore, false)
  })
})

// ── 性能与边界 ──────────────────────────────────────────────────────

await test('141 轮语料：elapsedMs 可测且远低于上限', async () => {
  await withTempHome(async () => {
    const specs = Array.from({ length: 141 }, (_, index) => ({
      prompt: `第 ${index} 轮：检索性能词与上下文`,
      // 每轮带一段较长的回答，让索引体积接近真实语料（约 340KB）。
      response: `回答 ${index}：${'填充内容'.repeat(100)}检索性能词`,
    }))
    const { ctx } = makeCtx({ events: { 'sess-141': makeEvents(specs) } })
    await syncSessionIndexFor(ctx, 'sess-141')

    const started = Date.now()
    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '检索性能词',
      limit: 200,
      now: Date.now(),
    })
    const wall = Date.now() - started
    assert.equal(result.total, 141)
    assert.equal(result.indexed.ready, 1)
    assert.equal(result.indexed.missing, 0)
    assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0)
    assert.ok(wall < 1000, `141 轮检索耗时 ${wall}ms，超出预期`)
    const size = (await stat(indexFilePath(defaultSessionsDir(), 'sess-141'))).size
    console.log(`       141 轮 / 索引 ${size} 字节：elapsedMs=${result.elapsedMs}ms（外层 ${wall}ms）`)
  })
})

await test('没有工作区：返回空结果骨架（不抛错）', async () => {
  const ctx = { get: () => undefined }
  const result = await searchWorkspaceIndex(ctx, { keywords: '词' })
  assert.equal(result.hits.length, 0)
  assert.equal(result.total, 0)
  assert.equal(result.scanned, 0)
  assert.equal(result.truncated, false)
  assert.equal(result.offset, 0)
  assert.equal(result.hasMore, false)
  assert.equal(result.warmup, false)
  assert.deepEqual(result.indexed, { ready: 0, missing: 0 })
  assert.equal(typeof result.elapsedMs, 'number')
})

await test('sessionId 反解工作区：用所属工区检索并回传 workspace', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-a': makeEvents([{ prompt: '甲的 共同词' }]),
      'sess-b': makeEvents([{ prompt: '乙的 共同词' }]),
    }
    const { ctx } = makeCtx({
      events,
      workspaces: [
        { id: 'ws-1', path: 'E:\\ws', title: '工作区 A', sessionIds: ['sess-a'] },
        { id: 'ws-2', path: 'F:\\other', title: '工作区 B', sessionIds: ['sess-b'] },
      ],
    })
    await syncSessionIndexFor(ctx, 'sess-a')
    await syncSessionIndexFor(ctx, 'sess-b')

    const result = await searchWorkspaceIndex(ctx, {
      sessionId: 'sess-b',
      keywords: '共同词',
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(result.total, 1)
    assert.equal(result.hits[0].sessionId, 'sess-b')
    assert.deepEqual(result.workspace, { id: 'ws-2', path: 'F:\\other', title: '工作区 B' })
    assert.equal(result.workspaceId, 'ws-2')
    assert.equal(result.coverage.sessions, 1)
    assert.equal(result.coverage.indexed, 1)
  })
})

await test('sessionId 不属于任何工作区：不静默退第一个，带 reason 返回空结果', async () => {
  await withTempHome(async () => {
    const { ctx } = makeCtx({ events: { 'sess-a': makeEvents([{ prompt: '词' }]) } })
    const result = await searchWorkspaceIndex(ctx, {
      sessionId: 'session-unknown',
      keywords: '词',
      limit: 10,
    })
    assert.equal(result.hits.length, 0)
    assert.equal(result.total, 0)
    assert.equal(result.scanned, 0)
    assert.equal(result.workspace, null)
    assert.equal(result.workspaceId, null)
    assert.equal(result.reason, '当前会话不属于任何工作区')
    assert.deepEqual(result.coverage, {
      sessions: 0,
      indexed: 0,
      scannedFromLog: 0,
      indexing: 0,
    })
    assert.deepEqual(result.indexed, { ready: 0, missing: 0 })
  })
})

await test('coverage 口径：索引/日志/后台排队数量', async () => {
  await withTempHome(async () => {
    const events = {
      'sess-cov-ready': makeEvents([{ prompt: '共同词 甲' }]),
      'sess-cov-missing': makeEvents([{ prompt: '共同词 乙' }]),
    }
    const { ctx } = makeCtx({
      events,
      sessions: ['sess-cov-ready', 'sess-cov-missing'],
    })
    await syncSessionIndexFor(ctx, 'sess-cov-ready')

    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '共同词',
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(result.total, 2, '索引缺失的会话也必须出结果')
    assert.deepEqual(result.coverage, {
      sessions: 2,
      indexed: 1,
      scannedFromLog: 1,
      indexing: 1,
    })
    assert.deepEqual(result.indexed, { ready: 1, missing: 1 })

    // 后台补齐后，第二次检索应全走索引。
    await flushIndexSyncs()
    const again = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '共同词',
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.deepEqual(again.coverage, {
      sessions: 2,
      indexed: 2,
      scannedFromLog: 0,
      indexing: 0,
    })
  })
})

await test('workspace-reindex：全部会话入队、立即返回、可重复触发', async () => {
  await withTempHome(async () => {
    const ids = ['sess-r1', 'sess-r2', 'sess-r3']
    const events = Object.fromEntries(ids.map(id => [id, makeEvents([{ prompt: id }])]))
    const { ctx } = makeCtx({ events, sessions: ids })

    const first = reindexWorkspace(ctx, { workspaceId: 'ws-1' })
    assert.equal(first.ok, true)
    assert.equal(first.queued, 3)

    await flushIndexSyncs()
    for (const id of ids) {
      assert.equal((await readIndexFile(defaultSessionsDir(), id)).ok, true)
    }

    // ignoreThrottle：60 秒内再次点"一键补齐"仍会重新排队。
    const second = reindexWorkspace(ctx, { workspaceId: 'ws-1' })
    assert.equal(second.ok, true)
    assert.equal(second.queued, 3)

    assert.equal(reindexWorkspace(ctx, {}).httpStatus, 400)
    assert.equal(reindexWorkspace(ctx, { workspaceId: 'nope' }).httpStatus, 404)
  })
})

await test('响应契约字段齐全', async () => {
  await withTempHome(async () => {
    const { ctx } = makeCtx({ events: { 'sess-shape': makeEvents([{ prompt: '形状 词' }]) } })
    const result = await searchWorkspaceIndex(ctx, { workspaceId: 'ws-1', keywords: '词' })
    assert.deepEqual(Object.keys(result).sort(), [
      'coverage', 'elapsedMs', 'hasMore', 'hits', 'indexed', 'offset', 'scanned',
      'total', 'truncated', 'warmup', 'workspace', 'workspaceId',
    ])
    assert.deepEqual(Object.keys(result.indexed).sort(), ['missing', 'ready'])
    assert.deepEqual(Object.keys(result.coverage).sort(), [
      'indexed', 'indexing', 'scannedFromLog', 'sessions',
    ])
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
