/**
 * 单轮变更端点测试（POST /api/topic-map/changes，P3-1）。
 *
 * 锁：只从索引行 `changes` 读；文件按扩展名分 code/doc/config/other；
 * `lost:true` 的明确文案；无 changes 的空清单；索引/轮次缺失 404、
 * 参数 400、索引损坏 502、超时 504。
 *
 * Run: node tests/changes-endpoint.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTurnChanges } from '../lib/index.js'
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

const SESSION = 'session-changes-0001'

function makeRow(turn, changes) {
  const row = { turn, seq: turn, prompt: '', response: '', endSeq: null }
  if (changes !== undefined) row.changes = changes
  return row
}

function indexText(rows, revision = 'rev-1') {
  return serializeIndex({ revision, turns: rows })
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'changes-endpoint-'))
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

async function seedIndex(home, rows, sessionId = SESSION) {
  const dir = join(home, 'topic-map', 'index', 'sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${sessionId}.jsonl`), indexText(rows), 'utf8')
}

console.log('\nchanges-endpoint')

await test('正常：文件清单 + 扩展名分类 + 汇总', async () => {
  await withTempHome(async home => {
    await seedIndex(home, [makeRow(0, {
      files: [
        { path: 'lib/index.js', added: 10, deleted: 2 },
        { path: 'README.md', added: 3, deleted: 0 },
        { path: 'package.json', added: 1, deleted: 1 },
        { path: 'assets/logo.bin', added: 0, deleted: 0 },
      ],
      total: 4,
      added: 14,
      deleted: 3,
      lost: false,
    })])
    const result = await readTurnChanges({ sessionId: SESSION, turn: 0 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.lost, false)
    assert.deepEqual(result.value.files, [
      { path: 'lib/index.js', added: 10, deleted: 2, kind: 'code' },
      { path: 'README.md', added: 3, deleted: 0, kind: 'doc' },
      { path: 'package.json', added: 1, deleted: 1, kind: 'config' },
      { path: 'assets/logo.bin', added: 0, deleted: 0, kind: 'other' },
    ])
    assert.equal(result.value.summary, '该轮改了 4 个文件，+14 -3 行')
  })
})

await test('空：没有 changes 字段 / files 为空 / 路径为空都要安全', async () => {
  await withTempHome(async home => {
    await seedIndex(home, [
      makeRow(0),
      makeRow(1, { files: [], total: 0, added: 0, deleted: 0, lost: false }),
      makeRow(2, {
        files: [
          { added: 1 }, // 没有 path
          { path: '', added: 1 },
          { display: 'src/display.js', added: 2, deleted: 0 },
        ],
        lost: false,
      }),
    ])
    const none = await readTurnChanges({ sessionId: SESSION, turn: 0 })
    assert.equal(none.ok, true, none.error)
    assert.deepEqual(none.value, { files: [], lost: false, summary: '该轮没有文件变更' })

    const empty = await readTurnChanges({ sessionId: SESSION, turn: 1 })
    assert.deepEqual(empty.value, { files: [], lost: false, summary: '该轮没有文件变更' })

    const cleaned = await readTurnChanges({ sessionId: SESSION, turn: 2 })
    assert.deepEqual(cleaned.value.files, [
      { path: 'src/display.js', added: 2, deleted: 0, kind: 'code' },
    ])
  })
})

await test('lost:true：files 为空并返回固定中文提示', async () => {
  await withTempHome(async home => {
    await seedIndex(home, [makeRow(0, {
      files: [{ path: 'lib/index.js', added: 9, deleted: 1 }],
      total: 1,
      added: 9,
      deleted: 1,
      lost: true,
    })])
    const result = await readTurnChanges({ sessionId: SESSION, turn: 0 })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.value, {
      files: [],
      lost: true,
      summary: '该轮变更明细已不可读',
    })
  })
})

await test('找不到：索引不存在 / 轮次不存在 → 404', async () => {
  await withTempHome(async home => {
    const noIndex = await readTurnChanges({ sessionId: 'session-missing', turn: 0 })
    assert.equal(noIndex.ok, false)
    assert.equal(noIndex.httpStatus, 404)
    assert.match(noIndex.error, /会话索引不存在/)

    await seedIndex(home, [makeRow(0)])
    const noTurn = await readTurnChanges({ sessionId: SESSION, turn: 9 })
    assert.equal(noTurn.ok, false)
    assert.equal(noTurn.httpStatus, 404)
    assert.match(noTurn.error, /找不到第 9 轮/)
  })
})

await test('参数错误：非对象 / sessionId / turn → 400', async () => {
  for (const body of [null, [], 'x']) {
    const result = await readTurnChanges(body)
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 400)
  }
  for (const turn of [-1, 1.5, '0', null]) {
    const result = await readTurnChanges({ sessionId: SESSION, turn })
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 400)
    assert.match(result.error, /turn/)
  }
  for (const sessionId of ['', '   ', 42]) {
    const result = await readTurnChanges({ sessionId, turn: 0 })
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 400)
    assert.match(result.error, /sessionId/)
  }
})

await test('索引损坏 → 502；读取超时 → 504', async () => {
  await withTempHome(async home => {
    const dir = join(home, 'topic-map', 'index', 'sessions')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${SESSION}.jsonl`), 'not a meta line\n', 'utf8')
    const broken = await readTurnChanges({ sessionId: SESSION, turn: 0 })
    assert.equal(broken.ok, false)
    assert.equal(broken.httpStatus, 502)
    assert.match(broken.error, /索引读取失败/)

    const timeout = await readTurnChanges(
      { sessionId: SESSION, turn: 0 },
      { timeoutMs: 20, readIndexFile: () => new Promise(() => {}) },
    )
    assert.equal(timeout.ok, false)
    assert.equal(timeout.httpStatus, 504)
    assert.match(timeout.error, /超时/)
  })
})

await test('路径边界：Windows 分隔符、大写扩展名、无扩展名、点文件', async () => {
  await withTempHome(async home => {
    await seedIndex(home, [makeRow(0, {
      files: [
        { path: 'src\\App.JS', added: 1, deleted: 0 },
        { path: 'Dockerfile', added: 2, deleted: 0 },
        { path: '.gitignore', added: 1, deleted: 0 },
        { path: 'docs/no-extension', added: 1, deleted: 0 },
        { path: 'style.CSS', added: 1, deleted: 0 },
        { path: 'config.YAML', added: 1, deleted: 0 },
      ],
      lost: false,
    })])
    const result = await readTurnChanges({ sessionId: SESSION, turn: 0 })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(result.value.files.map(file => [file.path, file.kind]), [
      ['src\\App.JS', 'code'],
      ['Dockerfile', 'code'],
      ['.gitignore', 'config'],
      ['docs/no-extension', 'other'],
      ['style.CSS', 'code'],
      ['config.YAML', 'config'],
    ])
  })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
