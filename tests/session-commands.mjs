/**
 * 会话命令清单端点测试（复制浮窗 A-2）。
 *
 * 锁编号口径（全会话连续、跨轮累计）、分页边界（首页/末页/越界）、
 * 索引缺失的日志兜底、以及"每轮 ≤8 条/每条 ≤500 字"的索引事实不被二次截断。
 *
 * Run: node tests/session-commands.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { flushIndexSyncs, listSessionCommands, syncSessionIndexFor } from '../lib/index.js'

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
const SESSION = 'session-4c42ff36-aaaa-4bbb-8ccc-000000000001'

/** 造事件流：spec.commands 是这一轮依次执行的命令。 */
function makeEvents(specs) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = BASE_TIME + index * 60_000
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `第 ${turn} 轮问题` }],
      source: { kind: 'user' },
    }, start + 100)
    for (const command of spec.commands ?? []) {
      push('tool/call', { name: 'ops_bash', arguments: JSON.stringify({ command }) }, start + 200)
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `第 ${turn} 轮回答` }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  })
  return events
}

function makeCtx(options = {}) {
  const events = options.events ?? []
  return {
    sessionQuery: {
      async readSession() {
        if (typeof options.readSession === 'function') return options.readSession()
        return { events }
      },
    },
    sessionPersistence: {
      async stat() {
        if (typeof options.stat === 'function') return options.stat()
        return { revision: 'rev-1' }
      },
    },
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'session-commands-'))
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

console.log('\nsession-commands')

await test('编号全会话连续、跨轮累计；ok 一律 null（索引没存成败）', async () => {
  await withTempHome(async () => {
    const events = makeEvents([
      { commands: ['npm test', 'npm run build'] },
      { commands: [] },
      { commands: ['git status', 'git diff', 'git log -1'] },
    ])
    const ctx = makeCtx({ events })
    await syncSessionIndexFor(ctx, SESSION)

    const result = await listSessionCommands(ctx, { sessionId: SESSION })
    assert.equal(result.ok, true, result.error)
    const value = result.value
    assert.equal(value.total, 5)
    assert.equal(value.offset, 0)
    assert.equal(value.limit, 20)
    assert.equal(value.hasMore, false)
    assert.deepEqual(value.commands.map(item => item.seq), [1, 2, 3, 4, 5])
    assert.deepEqual(value.commands.map(item => item.turn), [0, 0, 2, 2, 2])
    assert.deepEqual(value.commands.map(item => item.text), [
      'npm test', 'npm run build', 'git status', 'git diff', 'git log -1',
    ])
    assert.deepEqual(value.commands.map(item => item.ok), [null, null, null, null, null])
  })
})

await test('分页边界：第一页 / 最后一页 / 越界 / 默认值', async () => {
  await withTempHome(async () => {
    const events = makeEvents([
      { commands: ['a', 'b'] },
      { commands: ['c'] },
      { commands: ['d', 'e'] },
    ])
    const ctx = makeCtx({ events })
    await syncSessionIndexFor(ctx, SESSION)

    const first = await listSessionCommands(ctx, { sessionId: SESSION, offset: 0, limit: 2 })
    assert.deepEqual(first.value.commands.map(item => item.seq), [1, 2])
    assert.equal(first.value.hasMore, true)

    const last = await listSessionCommands(ctx, { sessionId: SESSION, offset: 4, limit: 2 })
    assert.deepEqual(last.value.commands.map(item => item.seq), [5])
    assert.deepEqual(last.value.commands.map(item => item.text), ['e'])
    assert.equal(last.value.hasMore, false)

    const beyond = await listSessionCommands(ctx, { sessionId: SESSION, offset: 999, limit: 20 })
    assert.deepEqual(beyond.value.commands, [])
    assert.equal(beyond.value.total, 5)
    assert.equal(beyond.value.hasMore, false)

    const defaults = await listSessionCommands(ctx, { sessionId: SESSION, offset: -3, limit: 0 })
    assert.equal(defaults.value.offset, 0)
    assert.equal(defaults.value.limit, 20)
    assert.equal(defaults.value.commands.length, 5)
  })
})

await test('limit 封顶 100', async () => {
  await withTempHome(async () => {
    const specs = Array.from({ length: 13 }, (_, turn) => ({
      commands: Array.from({ length: 8 }, (_, index) => `cmd-${turn}-${index}`),
    }))
    const events = makeEvents(specs)
    const ctx = makeCtx({ events })
    await syncSessionIndexFor(ctx, SESSION)

    const result = await listSessionCommands(ctx, { sessionId: SESSION, limit: 999 })
    assert.equal(result.value.total, 104)
    assert.equal(result.value.limit, 100)
    assert.equal(result.value.commands.length, 100)
    assert.equal(result.value.hasMore, true)
    assert.equal(result.value.commands[99].seq, 100)

    const tail = await listSessionCommands(ctx, { sessionId: SESSION, offset: 100, limit: 10 })
    assert.deepEqual(tail.value.commands.map(item => item.seq), [101, 102, 103, 104])
    assert.equal(tail.value.hasMore, false)
  })
})

await test('索引缺失时走日志兜底，编号与分页一致', async () => {
  await withTempHome(async () => {
    const events = makeEvents([
      { commands: ['echo 1'] },
      { commands: ['echo 2', 'echo 3'] },
    ])
    const ctx = makeCtx({ events })
    // 不建索引。
    const result = await listSessionCommands(ctx, { sessionId: SESSION, offset: 1, limit: 2 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.total, 3)
    assert.deepEqual(result.value.commands.map(item => item.seq), [2, 3])
    assert.deepEqual(result.value.commands.map(item => item.text), ['echo 2', 'echo 3'])
  })
})

await test('500 字命令原样返回（索引已截断，端点不再二次截断）', async () => {
  await withTempHome(async () => {
    const long = 'x'.repeat(600)
    const events = makeEvents([{ commands: [long] }])
    const ctx = makeCtx({ events })
    await syncSessionIndexFor(ctx, SESSION)

    const result = await listSessionCommands(ctx, { sessionId: SESSION })
    const [command] = result.value.commands
    assert.equal(command.text.length, 500)
    assert.equal(command.text, long.slice(0, 500))
  })
})

await test('非法 sessionId 400；会话读不到有明确错误', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: makeEvents([{ commands: ['a'] }]) })
    const invalid = await listSessionCommands(ctx, { sessionId: '   ' })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.httpStatus, 400)

    const broken = makeCtx({
      events: [],
      readSession: async () => {
        throw new Error('read failed')
      },
      stat: async () => {
        throw new Error('stat failed')
      },
    })
    const unreadable = await listSessionCommands(broken, { sessionId: 'session-dead-0000' })
    assert.equal(unreadable.ok, false)
    assert.equal(unreadable.error, '读不到该会话')
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
