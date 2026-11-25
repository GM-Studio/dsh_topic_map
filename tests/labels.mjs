/**
 * 状态标签读写测试（A-3 / F-4 / F-5 的 Host 半边）。
 *
 * 锁住四件事：
 *   1. 三个开关独立、可叠用；`source` 固定 user，`updatedAt` 每次刷新；
 *   2. 同一 workspace 的并发写入不丢更新（串行队列 + 读-改-写 + 原子替换）；
 *   3. 损坏文件不被覆盖：读/写/清都返回 `labels 文件损坏`，原文件一字节不动；
 *   4. 读兼容扁平与 `{labels:{…}}` 两种历史形状；/search 的 statuses 过滤
 *      能直接消费新写入的标签。
 *
 * Run: node tests/labels.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearWorkspaceLabel,
  flushIndexSyncs,
  readWorkspaceLabels,
  searchWorkspaceIndex,
  setWorkspaceLabel,
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

function labelsPath(home, workspaceId) {
  return join(home, 'topic-map', 'index', 'labels', `${workspaceId}.json`)
}

async function writeRawLabels(home, workspaceId, text) {
  const path = labelsPath(home, workspaceId)
  await mkdir(join(home, 'topic-map', 'index', 'labels'), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'labels-'))
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

/** 造检索用事件流。 */
function makeEvents(count) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  for (let turn = 0; turn < count; turn += 1) {
    const start = BASE_TIME + turn * 60_000
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: `第 ${turn} 轮问题` }],
      source: { kind: 'user' },
    }, start + 100)
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `第 ${turn} 轮回答` }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  }
  return events
}

/** 检索端点用的假 Host context。 */
function makeCtx(events, revisions = {}) {
  return {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return {
        list: () => [{ id: 'ws-1', path: 'E:\\ws', title: '工作区 A', sessionIds: ['sess-1'] }],
      }
    },
    sessionQuery: {
      async readTitleSnapshots(ids) {
        return ids.map(id => ({ status: 'fulfilled', sessionId: id, value: { title: { title: id } } }))
      },
      async readSession() {
        return { events }
      },
    },
    sessionPersistence: {
      async stat(id) {
        return { revision: revisions[id] ?? 'rev-1' }
      },
    },
  }
}

console.log('\nlabels')

// ── 合并写入 ────────────────────────────────────────────────────────

await test('三个开关独立切换、可叠用，source/updatedAt 正确', async () => {
  await withTempHome(async home => {
    const before = Date.now()
    const first = await setWorkspaceLabel('ws-1', 'sess-1', 1, { followUp: true })
    assert.equal(first.ok, true)
    assert.equal(first.key, 'sess-1#1')
    assert.equal(first.label.followUp, true)
    assert.equal(first.label.solved, false)
    assert.equal(first.label.starred, false)
    assert.equal(first.label.note, '')
    assert.equal(first.label.source, 'user')
    assert.ok(first.label.updatedAt >= before && first.label.updatedAt <= Date.now())

    const second = await setWorkspaceLabel('ws-1', 'sess-1', 1, { starred: true })
    assert.equal(second.label.followUp, true, '叠用时旧开关丢了')
    assert.equal(second.label.starred, true)

    const off = await setWorkspaceLabel('ws-1', 'sess-1', 1, { followUp: false, note: '  下次继续  ' })
    assert.equal(off.label.followUp, false)
    assert.equal(off.label.starred, true, '关一个开关不该清掉别的')
    assert.equal(off.label.note, '下次继续')

    const all = await readWorkspaceLabels('ws-1')
    assert.equal(all.ok, true)
    assert.equal(all.count, 1)
    assert.deepEqual(all.labels['sess-1#1'], off.label)

    // 原子写：成功路径不应留下 .tmp。
    let leaked = false
    try {
      await readFile(`${labelsPath(home, 'ws-1')}.tmp`, 'utf8')
      leaked = true
    } catch {
      leaked = false
    }
    assert.equal(leaked, false, '原子写留下了 .tmp')
  })
})

await test('未知键被忽略，source 恒为 user，多余字段不落盘', async () => {
  await withTempHome(async () => {
    const result = await setWorkspaceLabel('ws-1', 'sess-1', 2, {
      followUp: true,
      evil: true,
      source: 'admin',
      updatedAt: 1,
      nested: { a: 1 },
    })
    assert.equal(result.ok, true)
    assert.deepEqual(Object.keys(result.label), [
      'followUp', 'solved', 'starred', 'note', 'source', 'updatedAt',
    ])
    assert.equal(result.label.source, 'user')
    assert.ok(result.label.updatedAt > 1)
    assert.equal('evil' in result.label, false)
    assert.equal('nested' in result.label, false)

    const noteOnly = await setWorkspaceLabel('ws-1', 'sess-1', 2, { note: 42 })
    assert.equal(noteOnly.label.note, '', '非字符串 note 应被忽略而不是写坏')
  })
})

await test('并发 10 次不同 turn 的写入后 10 条都在（串行队列）', async () => {
  await withTempHome(async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => (
      setWorkspaceLabel('ws-c', 'sess-c', index + 1, {
        followUp: index % 2 === 0,
        note: `n${index}`,
      })
    )))
    assert.equal(results.filter(result => result.ok).length, 10)

    const read = await readWorkspaceLabels('ws-c')
    assert.equal(read.count, 10, '并发写入丢更新（读-改-写没有串行化）')
    for (let index = 0; index < 10; index += 1) {
      const entry = read.labels[`sess-c#${index + 1}`]
      assert.ok(entry !== undefined, `缺 sess-c#${index + 1}`)
      assert.equal(entry.followUp, index % 2 === 0)
      assert.equal(entry.note, `n${index}`)
    }
  })
})

// ── 删除 ────────────────────────────────────────────────────────────

await test('label-clear 删除单条：removed 布尔正确，其它条目保留', async () => {
  await withTempHome(async () => {
    await setWorkspaceLabel('ws-1', 'sess-1', 1, { followUp: true })
    await setWorkspaceLabel('ws-1', 'sess-1', 2, { solved: true })

    const cleared = await clearWorkspaceLabel('ws-1', 'sess-1', 1)
    assert.deepEqual(cleared, { ok: true, removed: true })
    const again = await clearWorkspaceLabel('ws-1', 'sess-1', 1)
    assert.deepEqual(again, { ok: true, removed: false })

    const read = await readWorkspaceLabels('ws-1')
    assert.equal(read.count, 1)
    assert.equal(read.labels['sess-1#1'], undefined)
    assert.equal(read.labels['sess-1#2'].solved, true)
  })
})

// ── 损坏文件 ────────────────────────────────────────────────────────

await test('损坏文件不被覆盖：读/写/清都报错且原文件不动', async () => {
  await withTempHome(async home => {
    const broken = '{ 这不是 JSON'
    const path = await writeRawLabels(home, 'ws-bad', broken)

    const read = await readWorkspaceLabels('ws-bad')
    assert.equal(read.ok, false)
    assert.equal(read.error, 'labels 文件损坏')
    assert.equal(read.httpStatus, 500)

    const set = await setWorkspaceLabel('ws-bad', 'sess-1', 0, { followUp: true })
    assert.equal(set.ok, false)
    assert.equal(set.error, 'labels 文件损坏')

    const clear = await clearWorkspaceLabel('ws-bad', 'sess-1', 0)
    assert.equal(clear.ok, false)
    assert.equal(clear.error, 'labels 文件损坏')

    assert.equal(await readFile(path, 'utf8'), broken, '损坏文件被改写了')

    // 队列不能被一次失败毒化：修好文件后继续可写。
    await writeFile(path, '{}', 'utf8')
    const retry = await setWorkspaceLabel('ws-bad', 'sess-1', 0, { followUp: true })
    assert.equal(retry.ok, true)
  })
})

await test('写失败会返回错误，不静默', async () => {
  await withTempHome(async home => {
    // 把 tmp 路径占成目录，writeFile 必然失败；读文件本身是缺失（空标签）。
    const tmpDir = join(home, 'topic-map', 'index', 'labels', 'ws-writefail.json.tmp')
    await mkdir(tmpDir, { recursive: true })
    const result = await setWorkspaceLabel('ws-writefail', 'sess-1', 0, { followUp: true })
    assert.equal(result.ok, false)
    assert.equal(typeof result.error, 'string')
    assert.ok(result.error.length > 0, '写失败没有错误信息')
    assert.equal(result.httpStatus, 500)
  })
})

// ── 参数校验 ────────────────────────────────────────────────────────

await test('turn 非法（负数/非整数/字符串）返回 400', async () => {
  await withTempHome(async () => {
    for (const turn of [-1, 1.5, '3', Number.NaN]) {
      const set = await setWorkspaceLabel('ws-t', 'sess-1', turn, { followUp: true })
      assert.equal(set.ok, false, `turn=${String(turn)} 应被拒绝`)
      assert.equal(set.httpStatus, 400)
      const clear = await clearWorkspaceLabel('ws-t', 'sess-1', turn)
      assert.equal(clear.ok, false)
      assert.equal(clear.httpStatus, 400)
    }
    const missingSession = await setWorkspaceLabel('ws-t', '', 0, { followUp: true })
    assert.equal(missingSession.httpStatus, 400)
    const missingWorkspace = await readWorkspaceLabels('')
    assert.equal(missingWorkspace.httpStatus, 400)
  })
})

// ── 读取形状兼容 ────────────────────────────────────────────────────

await test('读取兼容扁平与 {labels:{…}}，并归一化历史串/数组', async () => {
  await withTempHome(async home => {
    await writeRawLabels(home, 'ws-flat', JSON.stringify({
      's#1': { followUp: true, note: 'x', source: 'model', updatedAt: 5 },
    }))
    const flat = await readWorkspaceLabels('ws-flat')
    assert.equal(flat.count, 1)
    assert.deepEqual(flat.labels['s#1'], {
      followUp: true,
      solved: false,
      starred: false,
      note: 'x',
      source: 'model',
      updatedAt: 5,
    })

    await writeRawLabels(home, 'ws-wrap', JSON.stringify({
      labels: { 's#2': { solved: true, starred: true } },
    }))
    const wrapped = await readWorkspaceLabels('ws-wrap')
    assert.equal(wrapped.count, 1)
    assert.equal(wrapped.labels['s#2'].solved, true)
    assert.equal(wrapped.labels['s#2'].starred, true)
    assert.equal(wrapped.labels['s#2'].source, 'model')
    assert.equal(wrapped.labels['s#2'].updatedAt, 0)

    await writeRawLabels(home, 'ws-legacy', JSON.stringify({
      's#3': 'starred',
      's#4': ['solved', 'followUp'],
    }))
    const legacy = await readWorkspaceLabels('ws-legacy')
    assert.equal(legacy.labels['s#3'].starred, true)
    assert.equal(legacy.labels['s#3'].solved, false)
    assert.equal(legacy.labels['s#4'].solved, true)
    assert.equal(legacy.labels['s#4'].followUp, true)
  })
})

await test('label 单条读取：命中返回一条，未命中返回空', async () => {
  await withTempHome(async () => {
    await setWorkspaceLabel('ws-1', 'sess-1', 3, { starred: true })
    await setWorkspaceLabel('ws-1', 'sess-1', 4, { solved: true })

    const hit = await readWorkspaceLabels('ws-1', { sessionId: 'sess-1', turn: 3 })
    assert.equal(hit.count, 1)
    assert.deepEqual(Object.keys(hit.labels), ['sess-1#3'])
    assert.equal(hit.labels['sess-1#3'].starred, true)

    const miss = await readWorkspaceLabels('ws-1', { sessionId: 'sess-1', turn: 99 })
    assert.equal(miss.count, 0)
    assert.deepEqual(miss.labels, {})
  })
})

// ── 与 /search 串联 ────────────────────────────────────────────────

await test('/search 的 filters.statuses 能读到新写入的标签', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx(makeEvents(1))
    await syncSessionIndexFor(ctx, 'sess-1')
    await setWorkspaceLabel('ws-1', 'sess-1', 0, { followUp: true })

    const result = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '',
      filters: { statuses: ['followUp'] },
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(result.total, 1)
    assert.equal(result.hits[0].sessionId, 'sess-1')
    assert.deepEqual(result.hits[0].breakdown.statuses, ['followUp'])

    // 只有 model 标签、且不是 followUp 的会话不应命中。
    await setWorkspaceLabel('ws-1', 'sess-1', 0, { followUp: false, starred: true })
    const starred = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '',
      filters: { statuses: ['starred'] },
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(starred.total, 1)
    const followUpGone = await searchWorkspaceIndex(ctx, {
      workspaceId: 'ws-1',
      keywords: '',
      filters: { statuses: ['followUp'] },
      limit: 10,
      now: BASE_TIME + 10_000,
    })
    assert.equal(followUpGone.total, 0)
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
