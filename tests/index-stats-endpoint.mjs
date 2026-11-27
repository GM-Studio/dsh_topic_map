/**
 * 索引体积端点测试（POST /api/topic-map/index-stats）。
 *
 * 锁：文件大小合计、索引 meta 的轮次累加、摘要文件计数、工作区过滤、
 * 目录缺失回零、坏 meta 不拖垮统计、参数错误 400 / 工作区不存在 404 /
 * 读盘失败 502 / 超时 504。
 *
 * Run: node tests/index-stats-endpoint.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readIndexStats } from '../lib/index.js'
import { INDEX_SCHEMA } from '../lib/turn-index.js'

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

const SESSION_A = 'session-aaaa0000-0000-4000-8000-000000000001'
const SESSION_B = 'session-bbbb0000-0000-4000-8000-000000000002'

function makeCtx(workspaces = [{
  id: 'ws-1',
  path: 'E:\\ws',
  title: '统计工作区',
  sessionIds: [SESSION_A, SESSION_B],
}]) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      return undefined
    },
  }
}

/** 造一行合法的索引 meta + 指定轮次数（不需要真实轮次行）。 */
function indexText(turnCount, revision = 'rev-1') {
  const meta = JSON.stringify({
    kind: 'meta',
    schema: INDEX_SCHEMA,
    revision,
    turnCount,
  })
  const rows = []
  for (let turn = 0; turn < turnCount; turn += 1) {
    rows.push(JSON.stringify({ turn, seq: turn, prompt: '', response: '', endSeq: null }))
  }
  return `${[meta, ...rows].join('\n')}\n`
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'index-stats-endpoint-'))
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

async function seed(home) {
  const sessions = join(home, 'topic-map', 'index', 'sessions')
  const digests = join(home, 'topic-map', 'digests')
  await mkdir(sessions, { recursive: true })
  await mkdir(digests, { recursive: true })
  const indexA = indexText(2)
  const indexB = indexText(3)
  await writeFile(join(sessions, `${SESSION_A}.jsonl`), indexA, 'utf8')
  await writeFile(join(sessions, `${SESSION_B}.jsonl`), indexB, 'utf8')
  // 干扰文件：临时文件、非索引扩展名、目录都不该计入。
  await writeFile(join(sessions, `${SESSION_A}.jsonl.tmp`), 'not indexed', 'utf8')
  await writeFile(join(sessions, 'notes.txt'), 'ignore me', 'utf8')
  await mkdir(join(sessions, 'subdir'), { recursive: true })
  const digestA = '{"summary":"甲"}'
  const digestB = '{"summary":"乙"}'
  await writeFile(join(digests, `${SESSION_A}#0.json`), digestA, 'utf8')
  await writeFile(join(digests, `${SESSION_B}#1.json`), digestB, 'utf8')
  await writeFile(join(digests, 'orphan.json'), '{"summary":"无主"}', 'utf8')
  return {
    sessions,
    digests,
    bytes: Buffer.byteLength(indexA, 'utf8') + Buffer.byteLength(indexB, 'utf8'),
    digestBytes: Buffer.byteLength(digestA, 'utf8') + Buffer.byteLength(digestB, 'utf8'),
  }
}

console.log('\nindex-stats-endpoint')

await test('正常：索引/摘要文件数、体积与轮次累加', async () => {
  await withTempHome(async home => {
    const seeded = await seed(home)
    const result = await readIndexStats(makeCtx(), {}, {})
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.value, {
      sessions: 2,
      turns: 5,
      bytes: seeded.bytes,
      digests: 2,
      digestBytes: seeded.digestBytes,
    })
  })
})

await test('目录缺失：全部返回 0，不报错', async () => {
  await withTempHome(async () => {
    const result = await readIndexStats(makeCtx(), {}, {})
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.value, { sessions: 0, turns: 0, bytes: 0, digests: 0, digestBytes: 0 })
  })
})

await test('工作区过滤：只统计该工作区会话的索引与摘要', async () => {
  await withTempHome(async home => {
    const seeded = await seed(home)
    const ctx = makeCtx([{ id: 'ws-a', path: 'E:\\a', title: 'A', sessionIds: [SESSION_A] }])
    const result = await readIndexStats(ctx, { workspaceId: 'ws-a' }, {})
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.sessions, 1)
    assert.equal(result.value.turns, 2)
    assert.equal(result.value.bytes, Buffer.byteLength(indexText(2), 'utf8'))
    assert.equal(result.value.digests, 1)
    assert.equal(result.value.digestBytes, Buffer.byteLength('{"summary":"甲"}', 'utf8'))
    assert.ok(seeded.bytes > result.value.bytes)
  })
})

await test('没有 workspaceId 时用当前（第一个）工作区；空工作区回零', async () => {
  await withTempHome(async home => {
    await seed(home)
    const first = await readIndexStats(makeCtx(), {}, {})
    assert.equal(first.ok, true, first.error)
    assert.equal(first.value.sessions, 2)

    const empty = makeCtx([{ id: 'ws-empty', path: 'E:\\empty', title: '空', sessionIds: [] }])
    const result = await readIndexStats(empty, { workspaceId: 'ws-empty' }, {})
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.value, { sessions: 0, turns: 0, bytes: 0, digests: 0, digestBytes: 0 })
  })
})

await test('参数错误：workspaceId 非字符串 → 400；显式不存在 → 404', async () => {
  await withTempHome(async () => {
    for (const workspaceId of [123, {}, []]) {
      const result = await readIndexStats(makeCtx(), { workspaceId }, {})
      assert.equal(result.ok, false)
      assert.equal(result.httpStatus, 400)
      assert.match(result.error, /workspaceId/)
    }
    const missing = await readIndexStats(makeCtx(), { workspaceId: 'ws-missing' }, {})
    assert.equal(missing.ok, false)
    assert.equal(missing.httpStatus, 404)
    assert.match(missing.error, /工作区不存在/)
  })
})

await test('坏 meta / 短文件不拖垮统计：文件仍算会话与体积，轮次记 0', async () => {
  await withTempHome(async home => {
    const sessions = join(home, 'topic-map', 'index', 'sessions')
    await mkdir(sessions, { recursive: true })
    await writeFile(join(sessions, `${SESSION_A}.jsonl`), 'broken meta\n', 'utf8')
    await writeFile(join(sessions, `${SESSION_B}.jsonl`), indexText(4), 'utf8')
    const result = await readIndexStats(makeCtx(), {}, {})
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.sessions, 2)
    assert.equal(result.value.turns, 4)
    assert.equal(result.value.bytes, Buffer.byteLength('broken meta\n', 'utf8') + Buffer.byteLength(indexText(4), 'utf8'))
  })
})

await test('无 workspaceRegistry 时退化为全库统计', async () => {
  await withTempHome(async home => {
    await seed(home)
    const result = await readIndexStats({ get: () => undefined }, {}, {})
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.sessions, 2)
    assert.equal(result.value.digests, 3, '没有工作区过滤时所有摘要都算')
  })
})

await test('请求体不是对象 → 400；读盘超时 → 504', async () => {
  await withTempHome(async () => {
    const bad = await readIndexStats(makeCtx(), 'nope', {})
    assert.equal(bad.ok, false)
    assert.equal(bad.httpStatus, 400)

    const hanging = await readIndexStats(makeCtx(), {}, {
      timeoutMs: 20,
      readdir: () => new Promise(() => {}),
    })
    assert.equal(hanging.ok, false)
    assert.equal(hanging.httpStatus, 504)
    assert.match(hanging.error, /超时/)

    const statBroken = await readIndexStats(makeCtx(), {}, {
      readdir: async () => [{ name: `${SESSION_A}.jsonl`, isFile: () => true }],
      statOf: async () => {
        const error = new Error('permission denied')
        error.code = 'EACCES'
        throw error
      },
    })
    assert.equal(statBroken.ok, false)
    assert.equal(statBroken.httpStatus, 502)
    assert.match(statBroken.error, /读取索引统计失败/)
  })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
