/**
 * 单轮详情端点测试（POST /api/topic-map/turn-detail）。
 *
 * 锁住：详情字段完整、neighbors 边界（首轮无前、末轮无后、上下限）、
 * 标签挂接、索引缺失/损坏时的日志兜底、非法参数 400、轮次不存在、
 * 读不到会话、以及索引命中时的耗时上限。
 *
 * Run: node tests/turn-detail.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flushIndexSyncs,
  readTurnDetail,
  setWorkspaceLabel,
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

/**
 * 造事件流。spec：`{turn, prompt, response, calls, steps, endReason, usage, interrupted}`。
 */
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
    for (let step = 0; step < (spec.steps ?? 1); step += 1) {
      push('step/start', {}, start + 200 + step)
    }
    for (const call of spec.calls ?? []) {
      push('tool/call', { name: call.name, arguments: JSON.stringify(call.args ?? {}) }, start + 300)
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `回答 ${turn}` }],
        source: { kind: 'model', provider: 'agent2api', model: spec.model ?? 'DeepSeek-Flash' },
      },
      usage: spec.usage,
      interrupted: spec.interrupted === true,
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, start + 5000)
  })
  return events
}

/** 假 Host context：注册表 + 会话读 + revision 都可注入。 */
function makeCtx(options = {}) {
  const events = options.events ?? {}
  const revisions = options.revisions ?? {}
  return {
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
      async readSession(id) {
        if (typeof options.readSession === 'function') return options.readSession(id)
        return { events: events[id] ?? [] }
      },
    },
    sessionPersistence: {
      async stat(id) {
        if (typeof options.stat === 'function') return options.stat(id)
        return { revision: revisions[id] ?? 'rev-1' }
      },
    },
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'turn-detail-'))
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

const USAGE = {
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
  reasoningTokens: 2,
}

console.log('\nturn-detail')

// ── 字段与邻居 ──────────────────────────────────────────────────────

await test('详情字段完整（索引命中）', async () => {
  await withTempHome(async () => {
    const events = makeEvents([
      { prompt: '第一句。后面还有很多内容' },
      {
        prompt: '第二轮问题',
        response: '第二轮回答',
        steps: 2,
        calls: [{ name: 'edit', args: { path: 'lib/client.js' } }],
        usage: USAGE,
        endReason: 'completed',
      },
      { prompt: '第三轮' },
    ])
    const ctx = makeCtx({ events: { 'sess-1': events } })
    await syncSessionIndexFor(ctx, 'sess-1')

    const result = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 1 })
    assert.equal(result.ok, true, result.error)
    const detail = result.value.turn
    assert.deepEqual(Object.keys(detail).sort(), [
      'changes', 'commands', 'end', 'endReason', 'files', 'interrupted', 'model', 'ms',
      'prompt', 'response', 'seq', 'start', 'steps', 'tools', 'truncated',
      'turn', 'usage',
    ])
    assert.equal(detail.turn, 1)
    assert.equal(detail.seq, 5, 'seq 应是 turn/start 的 seq')
    assert.equal(detail.start, BASE_TIME + 60_000)
    assert.equal(detail.end, BASE_TIME + 65_000)
    assert.equal(detail.ms, 5000)
    assert.equal(detail.prompt, '第二轮问题')
    assert.equal(detail.response, '第二轮回答')
    assert.equal(detail.model, 'DeepSeek-Flash')
    assert.deepEqual(detail.usage, { input: 120, output: 30, cacheRead: 10, cacheWrite: 5, reasoning: 2 })
    assert.equal(detail.endReason, 'completed')
    assert.equal(detail.interrupted, false)
    assert.equal(detail.steps, 2)
    assert.deepEqual(detail.tools, ['edit'])
    assert.deepEqual(detail.files, ['lib/client.js'])
    assert.deepEqual(detail.commands, [])
    assert.equal(detail.changes, null)
    assert.equal(detail.truncated, false)

    // neighbors：默认前后各 1，按轮号升序；promptHead ≤ 40。
    assert.equal(result.value.neighbors.length, 2)
    assert.deepEqual(result.value.neighbors.map(item => item.turn), [0, 2])
    const head = result.value.neighbors[0]
    assert.deepEqual(Object.keys(head).sort(), ['endReason', 'promptHead', 'time', 'turn'])
    assert.equal(head.promptHead, '第一句', 'promptHead 应取首句且不超过 40 字')
    assert.ok(head.promptHead.length <= 40)
    assert.equal(head.time, BASE_TIME + 5000, 'time 应取该轮结束时刻')
    assert.equal(head.endReason, 'completed')
  })
})

await test('详情透传 commands（schema 2）', async () => {
  await withTempHome(async () => {
    const events = makeEvents([{
      prompt: '跑测试',
      calls: [
        { name: 'run_code', args: { command: 'npm test' } },
        { name: 'run_code', args: { code: 'console.log(1)' } },
      ],
    }])
    const ctx = makeCtx({ events: { 'sess-1': events } })
    await syncSessionIndexFor(ctx, 'sess-1')

    const result = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 0 })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.turn.commands, ['npm test', 'console.log(1)'])
  })
})

await test('neighbors 边界：首轮无前、末轮无后，上下限 3', async () => {
  await withTempHome(async () => {
    const events = makeEvents(Array.from({ length: 8 }, (_, index) => ({ prompt: `问题 ${index}` })))
    const ctx = makeCtx({ events: { 'sess-1': events } })
    await syncSessionIndexFor(ctx, 'sess-1')

    const first = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 0 })
    assert.deepEqual(first.value.neighbors.map(item => item.turn), [1])

    const last = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 7 })
    assert.deepEqual(last.value.neighbors.map(item => item.turn), [6])

    const middle = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 4, before: 2, after: 2 })
    assert.deepEqual(middle.value.neighbors.map(item => item.turn), [2, 3, 5, 6])

    const capped = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 4, before: 99, after: 99 })
    assert.deepEqual(capped.value.neighbors.map(item => item.turn), [1, 2, 3, 5, 6, 7])

    const none = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 4, before: 0, after: 0 })
    assert.deepEqual(none.value.neighbors, [])
  })
})

await test('label 挂接：有标签返回归一化对象，无标签 null', async () => {
  await withTempHome(async () => {
    const events = makeEvents([{ prompt: '甲' }, { prompt: '乙' }])
    const ctx = makeCtx({ events: { 'sess-1': events } })
    await syncSessionIndexFor(ctx, 'sess-1')

    const before = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 0 })
    assert.equal(before.value.label, null)

    await setWorkspaceLabel('ws-1', 'sess-1', 0, { followUp: true, note: '看看' })
    const after = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 0 })
    assert.deepEqual(after.value.label, {
      followUp: true,
      solved: false,
      starred: false,
      note: '看看',
      source: 'user',
      updatedAt: after.value.label.updatedAt,
    })
    assert.ok(after.value.label.updatedAt > 0)
  })
})

// ── 兜底与错误 ──────────────────────────────────────────────────────

await test('索引缺失时用日志全文兜底（不走 160 字预览）', async () => {
  await withTempHome(async () => {
    const longResponse = `${'铺'.repeat(400)}兜底尾巴`
    const events = makeEvents([
      { prompt: '首轮', response: '短回答' },
      { prompt: '第二轮', response: longResponse },
      { prompt: '第三轮' },
    ])
    const ctx = makeCtx({ events: { 'sess-1': events } })

    const result = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 1 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.turn.response, longResponse, '兜底路径用了预览而不是全文')
    assert.ok(result.value.turn.response.length > 160)
    assert.deepEqual(result.value.neighbors.map(item => item.turn), [0, 2])
  })
})

await test('索引损坏时也退回日志兜底', async () => {
  await withTempHome(async () => {
    const events = makeEvents([{ prompt: '甲' }, { prompt: '乙' }])
    const ctx = makeCtx({ events: { 'sess-1': events } })
    const built = await syncSessionIndexFor(ctx, 'sess-1')
    const text = await readFile(built.path, 'utf8')
    await writeFile(built.path, `${text.split('\n')[0]}\n不是 JSON\n`, 'utf8')

    const result = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 1 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.turn.turn, 1)
    assert.equal(result.value.turn.prompt, '乙')
  })
})

await test('非法参数返回 400', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: { 'sess-1': makeEvents([{ prompt: '甲' }]) } })

    for (const sessionId of ['', '   ', 123, null, undefined]) {
      const result = await readTurnDetail(ctx, { sessionId, turn: 0 })
      assert.equal(result.ok, false)
      assert.equal(result.httpStatus, 400)
    }
    for (const turn of [-1, 1.5, '1', Number.NaN, null, undefined]) {
      const result = await readTurnDetail(ctx, { sessionId: 'sess-1', turn })
      assert.equal(result.ok, false, `turn=${String(turn)} 应被拒绝`)
      assert.equal(result.httpStatus, 400)
    }
  })
})

await test('轮次不存在返回 404 语义；读不到会话有专门错误', async () => {
  await withTempHome(async () => {
    const events = makeEvents([{ prompt: '甲' }, { prompt: '乙' }])
    const ctx = makeCtx({ events: { 'sess-1': events } })
    await syncSessionIndexFor(ctx, 'sess-1')

    const missing = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 99 })
    assert.equal(missing.ok, false)
    assert.equal(missing.httpStatus, 404)

    const unreadable = makeCtx({
      events: {},
      stat: async () => {
        throw new Error('stat failed')
      },
      readSession: async () => null,
    })
    const unreadableResult = await readTurnDetail(unreadable, { sessionId: 'sess-x', turn: 0 })
    assert.equal(unreadableResult.ok, false)
    assert.equal(unreadableResult.error, '读不到该会话')
  })
})

await test('兜底读取超时返回错误，不挂住', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: {},
      stat: async () => {
        throw new Error('stat failed')
      },
      readSession: () => new Promise(() => {}),
    })
    const started = Date.now()
    const result = await readTurnDetail(ctx, { sessionId: 'sess-slow', turn: 0 }, { timeoutMs: 40 })
    const elapsed = Date.now() - started
    assert.equal(result.ok, false)
    assert.equal(result.error, '读取该会话超时')
    assert.ok(elapsed < 500, `超时保护没生效：${elapsed}ms`)
  })
})

// ── 性能 ────────────────────────────────────────────────────────────

await test('索引命中时单轮详情平均耗时 < 20ms', async () => {
  await withTempHome(async () => {
    const events = makeEvents(Array.from({ length: 141 }, (_, index) => ({
      prompt: `第 ${index} 轮：详情性能词`,
      response: `回答 ${index}：${'填充'.repeat(100)}`,
    })))
    const ctx = makeCtx({ events: { 'sess-1': events } })
    await syncSessionIndexFor(ctx, 'sess-1')

    // 先预热一次（首次可能包含模块内临时分配）。
    await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 70 })
    const rounds = 20
    const started = Date.now()
    for (let index = 0; index < rounds; index += 1) {
      const result = await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 70 })
      assert.equal(result.ok, true)
    }
    const avg = (Date.now() - started) / rounds
    const single = Date.now()
    await readTurnDetail(ctx, { sessionId: 'sess-1', turn: 70 })
    const last = Date.now() - single
    console.log(`       141 轮索引：平均 ${avg.toFixed(2)}ms/次，最后一次 ${last}ms`)
    assert.ok(avg < 20, `平均耗时 ${avg}ms 超过 20ms`)
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
