/**
 * 回滚预演端点测试（POST /api/topic-map/rollback-plan，P3-2）。
 *
 * 锁：四种 state（apply / same / modified / missing）、sha256 计算、
 * 相对路径按工作区解析、绝对路径直读、lost / 无 changes、404/400/502/504，
 * 以及**只读**——预演前后工作区文件与索引一个字节都不变。
 *
 * Run: node tests/rollback-plan-endpoint.mjs
 */

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRollbackPlan } from '../lib/index.js'
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

const SESSION = 'session-rollback-0001'
const WS = 'ws-rollback-1'

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function makeRow(turn, changes) {
  const row = { turn, seq: turn, prompt: '', response: '', endSeq: null }
  if (changes !== undefined) row.changes = changes
  return row
}

function indexText(rows) {
  return serializeIndex({ revision: 'rev-1', turns: rows })
}

function makeCtx(root) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{ id: WS, path: root, title: '回滚工作区', sessionIds: [SESSION] }],
        }
      }
      return undefined
    },
  }
}

async function withTemp(fn) {
  const home = await mkdtemp(join(tmpdir(), 'rollback-plan-home-'))
  const root = await mkdtemp(join(tmpdir(), 'rollback-plan-ws-'))
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn({ home, root })
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
    await rm(home, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
}

async function seedIndex(home, rows) {
  const dir = join(home, 'topic-map', 'index', 'sessions')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${SESSION}.jsonl`), indexText(rows), 'utf8')
  return join(dir, `${SESSION}.jsonl`)
}

console.log('\nrollback-plan-endpoint')

await test('四种 state：apply / same / modified / missing + sha256', async () => {
  await withTemp(async ({ home, root }) => {
    const applyText = 'export const value = 1\n'
    const modifiedText = '{"changed":true}\n'
    await writeFile(join(root, 'apply.js'), applyText, 'utf8')
    await writeFile(join(root, 'same.md'), 'unchanged\n', 'utf8')
    await writeFile(join(root, 'modified.json'), modifiedText, 'utf8')
    // gone.txt 不创建 → missing

    await seedIndex(home, [makeRow(0, {
      files: [
        { path: 'apply.js', added: 2, deleted: 1, hash: sha256(applyText) },
        { path: 'same.md', added: 0, deleted: 0 },
        { path: 'modified.json', added: 1, deleted: 0, hash: sha256('old content\n') },
        { path: 'gone.txt', added: 1, deleted: 0 },
      ],
      total: 4,
      added: 4,
      deleted: 1,
      lost: false,
    })])

    const result = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: 0 })
    assert.equal(result.ok, true, result.error)
    assert.deepEqual(
      result.value.plan.map(item => ({
        path: item.path,
        added: item.added,
        deleted: item.deleted,
        state: item.state,
        currentHash: item.currentHash,
      })),
      [
        { path: 'apply.js', added: 2, deleted: 1, state: 'apply', currentHash: sha256(applyText) },
        { path: 'same.md', added: 0, deleted: 0, state: 'same', currentHash: sha256('unchanged\n') },
        { path: 'modified.json', added: 1, deleted: 0, state: 'modified', currentHash: sha256(modifiedText) },
        { path: 'gone.txt', added: 1, deleted: 0, state: 'missing', currentHash: null },
      ],
    )
    assert.equal(result.value.plan[0].hash, sha256(applyText))
    assert.equal(result.value.plan[0].reason, '文件内容与快照一致，可安全回滚')
    assert.equal(result.value.plan[2].reason, '文件在变更后已被修改，需人工确认')
    assert.equal(result.value.plan[3].reason, '文件已不存在')
    assert.equal(result.value.summary, '1 个可回滚，1 个无需回滚，1 个已被修改，1 个已不存在')
  })
})

await test('没有快照哈希的有行变更 → apply，但 reason 明确"无法校验"', async () => {
  await withTemp(async ({ home, root }) => {
    const current = 'no snapshot hash\n'
    await writeFile(join(root, 'unknown.js'), current, 'utf8')
    await seedIndex(home, [makeRow(0, {
      files: [{ path: 'unknown.js', added: 3, deleted: 1 }],
      lost: false,
    })])
    const result = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: 0 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.plan[0].state, 'apply')
    assert.equal(result.value.plan[0].reason, '文件存在但未记录快照哈希，可执行回滚（无法校验）')
    assert.equal(result.value.summary, '1 个可回滚')
  })
})

await test('beforeHash 命中当前内容 → same（即使 added>0）', async () => {
  await withTemp(async ({ home, root }) => {
    const current = 'already rolled back\n'
    await writeFile(join(root, 'back.js'), current, 'utf8')
    await seedIndex(home, [makeRow(0, {
      files: [{ path: 'back.js', added: 3, deleted: 1, beforeHash: sha256(current) }],
      lost: false,
    })])
    const result = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: 0 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.plan[0].state, 'same')
    assert.equal(result.value.plan[0].reason, '当前内容已是回滚目标，无需回滚')
  })
})

await test('绝对路径直接读取；没有工作区时相对路径记 missing', async () => {
  await withTemp(async ({ home, root }) => {
    const absoluteText = 'absolute\n'
    const absolute = join(root, 'absolute.txt')
    await writeFile(absolute, absoluteText, 'utf8')
    await seedIndex(home, [makeRow(0, {
      files: [
        { path: absolute, added: 1, deleted: 0, hash: sha256(absoluteText) },
        { path: 'relative.txt', added: 1, deleted: 0 },
      ],
      lost: false,
    })])

    const withWorkspace = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: 0 })
    assert.equal(withWorkspace.ok, true, withWorkspace.error)
    assert.equal(withWorkspace.value.plan[0].state, 'apply')
    assert.equal(withWorkspace.value.plan[1].state, 'missing', '文件不存在确实是 missing')

    const relativeText = 'relative\n'
    await writeFile(join(root, 'relative.txt'), relativeText, 'utf8')
    const noRegistry = { get: () => undefined }
    const withoutRoot = await buildRollbackPlan(noRegistry, { sessionId: SESSION, turn: 0 })
    assert.equal(withoutRoot.ok, true, withoutRoot.error)
    assert.equal(withoutRoot.value.plan[0].state, 'apply', '绝对路径不依赖工作区')
    assert.equal(withoutRoot.value.plan[1].state, 'missing', '无法解析的相对路径不能猜')
    assert.equal(withoutRoot.value.plan[1].currentHash, null)
  })
})

await test('lost / 无 changes：空计划 + 明确文案', async () => {
  await withTemp(async ({ home, root }) => {
    await seedIndex(home, [
      makeRow(0, { files: [{ path: 'x.js', added: 1, deleted: 0 }], lost: true }),
      makeRow(1),
    ])
    const lost = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: 0 })
    assert.equal(lost.ok, true, lost.error)
    assert.deepEqual(lost.value.plan, [])
    assert.equal(lost.value.summary, '该轮变更明细已不可读')
    assert.equal(lost.value.lost, true)

    const none = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: 1 })
    assert.deepEqual(none.value, { plan: [], summary: '该轮没有变更记录' })
  })
})

await test('只读：预演前后工作区文件与索引内容、mtime 都不变', async () => {
  await withTemp(async ({ home, root }) => {
    const content = 'do not touch\n'
    const path = join(root, 'readonly.js')
    await writeFile(path, content, 'utf8')
    const indexPath = await seedIndex(home, [makeRow(0, {
      files: [{ path: 'readonly.js', added: 1, deleted: 0 }],
      lost: false,
    })])
    const beforeFile = await stat(path)
    const beforeIndex = await stat(indexPath)
    const beforeContent = await readFile(path, 'utf8')
    const beforeIndexText = await readFile(indexPath, 'utf8')

    const result = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: 0 })
    assert.equal(result.ok, true, result.error)

    const afterFile = await stat(path)
    const afterIndex = await stat(indexPath)
    assert.equal(await readFile(path, 'utf8'), beforeContent)
    assert.equal(await readFile(indexPath, 'utf8'), beforeIndexText)
    assert.equal(afterFile.mtimeMs, beforeFile.mtimeMs)
    assert.equal(afterIndex.mtimeMs, beforeIndex.mtimeMs)
    assert.equal(afterFile.size, beforeFile.size)
    assert.equal(afterIndex.size, beforeIndex.size)
  })
})

await test('找不到：索引/轮次 → 404；参数错误 → 400', async () => {
  await withTemp(async ({ home, root }) => {
    const noIndex = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: 0 })
    assert.equal(noIndex.ok, false)
    assert.equal(noIndex.httpStatus, 404)

    await seedIndex(home, [makeRow(0)])
    const noTurn = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: 5 })
    assert.equal(noTurn.ok, false)
    assert.equal(noTurn.httpStatus, 404)

    for (const body of [null, []]) {
      const bad = await buildRollbackPlan(makeCtx(root), body)
      assert.equal(bad.ok, false)
      assert.equal(bad.httpStatus, 400)
    }
    const badTurn = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: -1 })
    assert.equal(badTurn.ok, false)
    assert.equal(badTurn.httpStatus, 400)
  })
})

await test('索引损坏 → 502；读取文件超时 → 504', async () => {
  await withTemp(async ({ home, root }) => {
    const dir = join(home, 'topic-map', 'index', 'sessions')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${SESSION}.jsonl`), 'broken\n', 'utf8')
    const broken = await buildRollbackPlan(makeCtx(root), { sessionId: SESSION, turn: 0 })
    assert.equal(broken.ok, false)
    assert.equal(broken.httpStatus, 502)

    await seedIndex(home, [makeRow(0, {
      files: [{ path: 'slow.js', added: 1, deleted: 0 }],
      lost: false,
    })])
    const timeout = await buildRollbackPlan(
      makeCtx(root),
      { sessionId: SESSION, turn: 0 },
      { timeoutMs: 20, readFile: () => new Promise(() => {}) },
    )
    assert.equal(timeout.ok, false)
    assert.equal(timeout.httpStatus, 504)
    assert.match(timeout.error, /超时/)
  })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
