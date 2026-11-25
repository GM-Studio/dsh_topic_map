/**
 * 召回工具 `history_turn` 测试。
 *
 * 这个工具是引用指针（`@第33轮对话〔4c42ff36#33〕`）的解析端：模型只有
 * 在工具描述里看到"什么时候该调它"，句柄才真的可用。所以这里既锁定义
 * （name/description/parameters），也锁 handle 解析、歧义、错误文案、
 * 截断与渲染。
 *
 * Run: node tests/history-tool.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createHistoryTurnTool,
  flushIndexSyncs,
  flushTurnDigests,
  generateTurnDigest,
  registerHistoryTurnTool,
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
const SESSION_A = 'session-4c42ff36-aaaa-4bbb-8ccc-000000000001'
const SESSION_B = 'session-abcd1234-1111-4aaa-8bbb-000000000001'
const SESSION_C = 'session-abcd1234-2222-4aaa-8bbb-000000000002'

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
    for (const call of spec.calls ?? []) {
      push('tool/call', { name: call.name, arguments: JSON.stringify(call.args ?? {}) }, start + 200)
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? `第 ${turn} 轮回答` }],
        source: { kind: 'model', provider: 'agent2api', model: spec.model ?? 'DeepSeek-Flash' },
      },
    }, start + 1000)
    if (spec.changes === true) push('workspace/changes', { turn }, start + 1500)
    push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, start + 5000)
  })
  return events
}

/** 假模型：记录调用次数；可 gate 卡住；可失败。 */
function makeFakeLlm(options = {}) {
  const state = { calls: 0 }
  return {
    get calls() {
      return state.calls
    },
    async prepareCall(call) {
      state.calls += 1
      return {
        config: { ...call, provider: 'fake', model: 'fake-1' },
        async *stream() {
          if (options.gate !== undefined) await options.gate.promise
          if (options.fail === true) throw new Error('model down')
          yield { type: 'text-delta', text: options.text ?? '摘要：定位逻辑改好了。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
    listProviders() {
      return [{ id: 'fake' }]
    },
  }
}

function makeCtx(options = {}) {
  const events = options.events ?? {}
  const revisions = options.revisions ?? {}
  const llm = options.llm === undefined ? makeFakeLlm(options.llmOptions) : options.llm
  const workspaces = options.workspaces ?? [{
    id: 'ws-1',
    path: 'E:\\ws',
    title: '工作区 A',
    sessionIds: options.sessions ?? Object.keys(events),
  }]
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      if (name === 'llm') return llm
      return undefined
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
  if (options.summary !== undefined) {
    ctx.workspaceChanges = { summary: options.summary }
  }
  ctx.llm = llm
  return ctx
}

const AGENT = { id: 'caller-session', session: { header: { cwd: 'E:\\ws' } } }

async function run(tool, args, agent = AGENT) {
  const controller = new AbortController()
  return tool.execute(args, { agent, signal: controller.signal })
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'history-tool-'))
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

/** 三个带命令/文件/变更的轮次。 */
function sampleEvents() {
  return makeEvents([
    {
      prompt: '第一轮：把跳转修好',
      response: '先看导航流程。',
      calls: [{ name: 'ops_bash', args: { command: 'npm test' } }],
    },
    {
      prompt: '第二轮：为什么还是没反应',
      response: '定位逻辑改好了。',
      calls: [
        { name: 'ops_bash', args: { command: 'npm run build' } },
        { name: 'ops_bash', args: { command: 'npm test' } },
        { name: 'edit', args: { path: 'lib/client.js' } },
      ],
      changes: true,
      endReason: 'completed',
    },
    { prompt: '第三轮：继续', response: '好的。' },
  ])
}

console.log('\nhistory-tool')

// ── 定义与注册 ──────────────────────────────────────────────────────

await test('工具定义：name/description/parameters 符合摘要契约', () => {
  const ctx = makeCtx({ events: { [SESSION_A]: sampleEvents() } })
  const tool = createHistoryTurnTool(ctx)
  assert.equal(tool.name, 'history_turn')
  assert.ok(tool.description.includes('〔xxxxxxxx#N〕'), '描述必须给出句柄形态线索')
  assert.ok(tool.description.includes('轮次句柄'), '描述必须说明何时调用')
  assert.ok(tool.description.includes('400'), '描述应说明摘要上限')
  assert.ok(tool.description.includes('摘要'), '描述应说明返回摘要')
  assert.ok(tool.description.includes('truncated'), '描述应说明原文未返回的标记')
  assert.equal(tool.description.includes('6000'), false, '不应再承诺全文')

  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['handle', 'sessionId', 'turn'])
  assert.equal(tool.parameters.properties.handle.type, 'string')
  assert.equal(tool.parameters.properties.sessionId.type, 'string')
  assert.equal(tool.parameters.properties.turn.type, 'integer')
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(typeof tool.execute, 'function')

  assert.equal(tool.output.schema.type, 'object')
  const rendered = tool.output.render({}, { ok: false, error: '测试错误' })
  assert.ok(Array.isArray(rendered))
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.includes('测试错误'))
})

await test('可选作用域注册：服务在就注册，缺失不崩', () => {
  let captured = null
  const scope = {
    tools: {
      register(definition) {
        captured = definition
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
  }
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['tools'])
      callback(scope)
    },
  }
  registerHistoryTurnTool(ctx)
  assert.ok(captured !== null, 'tools 可用时没有注册')
  assert.equal(captured.name, 'history_turn')

  // 宿主没有 tools 服务：inject 不回调，不能抛。
  assert.doesNotThrow(() => registerHistoryTurnTool({ inject() {} }))
  assert.doesNotThrow(() => registerHistoryTurnTool({}))
})

// ── handle 解析与取回 ──────────────────────────────────────────────

await test('handle 唯一匹配：取回该轮摘要与命令/文件/变更', async () => {
  await withTempHome(async () => {
    const events = sampleEvents()
    const llm = makeFakeLlm({ text: '摘要：定位逻辑改好了，跳转恢复。' })
    const ctx = makeCtx({
      events: { [SESSION_A]: events },
      llm,
      summary: async () => ({
        files: [{ path: 'lib/client.js', added: 3, deleted: 1 }],
        total: 1,
        added: 3,
        deleted: 1,
      }),
    })
    await syncSessionIndexFor(ctx, SESSION_A)
    const tool = createHistoryTurnTool(ctx)

    const result = await run(tool, { handle: '4c42ff36#1' })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.sessionId, SESSION_A)
    assert.equal(result.turn, 1)
    assert.equal(result.mode, 'digest')
    assert.ok(result.summary.includes('摘要：定位逻辑改好了，跳转恢复。'))
    assert.ok(result.summary.includes('命令：npm run build；npm test（共 2 条）'), '程序应确定性补上命令')
    assert.equal(result.chars, result.summary.length)
    assert.equal('prompt' in result, false, '摘要档不应再返回全文提问')
    assert.equal('response' in result, false, '摘要档不应再返回全文回答')
    assert.equal(result.model, 'DeepSeek-Flash')
    assert.equal(result.endReason, 'completed')
    assert.deepEqual(result.commands, ['npm run build', 'npm test'])
    assert.deepEqual(result.files, ['lib/client.js'])
    assert.deepEqual(result.changes.files, [{ path: 'lib/client.js', added: 3, deleted: 1 }])
    assert.equal(result.changes.lost, false)
    assert.equal(result.truncated, true, '摘要档应提示还有原文')
    assert.deepEqual(result.neighbors, [
      { turn: 0, promptHead: '第一轮：把跳转修好' },
      { turn: 2, promptHead: '第三轮：继续' },
    ])
  })
})

await test('sessionId + turn 直连路径', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: { [SESSION_A]: sampleEvents() } })
    await syncSessionIndexFor(ctx, SESSION_A)
    const tool = createHistoryTurnTool(ctx)

    const result = await run(tool, { sessionId: SESSION_A, turn: 2 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.turn, 2)
    assert.equal(result.mode, 'digest')
    assert.ok(result.summary.length > 0)
    assert.deepEqual(result.neighbors, [{ turn: 1, promptHead: '第二轮：为什么还是没反应' }])
  })
})

await test('带 session- 前缀的完整句柄也能解析', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: { [SESSION_A]: sampleEvents() } })
    await syncSessionIndexFor(ctx, SESSION_A)
    const tool = createHistoryTurnTool(ctx)

    const result = await run(tool, { handle: `${SESSION_A}#0` })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.turn, 0)
    assert.equal(result.neighbors.length, 1)
    assert.equal(result.neighbors[0].turn, 1)
  })
})

await test('同会话引用：当前会话不在 workspace registry 也能命中', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [SESSION_A]: sampleEvents() },
      workspaces: [],
      sessions: [],
    })
    await syncSessionIndexFor(ctx, SESSION_A)
    const tool = createHistoryTurnTool(ctx)
    const selfAgent = { id: SESSION_A, session: { header: { cwd: 'E:\\ws' } } }

    const result = await run(tool, { handle: '4c42ff36#0' }, selfAgent)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.sessionId, SESSION_A)
    assert.equal(result.turn, 0)
  })
})

await test('工作区元数据缺失：用索引目录兜底匹配跨会话引用', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [SESSION_A]: sampleEvents() },
      workspaces: [], // 当前会话所属工作区解析不到
      sessions: [],
    })
    await syncSessionIndexFor(ctx, SESSION_A)
    const tool = createHistoryTurnTool(ctx)
    const otherAgent = { id: 'session-99998888-0000-4000-8000-000000000001', session: { header: { cwd: 'E:\\ws' } } }

    const result = await run(tool, { handle: '4c42ff36#1' }, otherAgent)
    assert.equal(result.ok, true, result.error)
    assert.equal(result.sessionId, SESSION_A)
    assert.equal(result.turn, 1)
  })
})

await test('前缀歧义：明确报歧义并提示用完整 sessionId', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [SESSION_B]: sampleEvents(), [SESSION_C]: sampleEvents() },
      sessions: [SESSION_B, SESSION_C],
    })
    await syncSessionIndexFor(ctx, SESSION_B)
    const tool = createHistoryTurnTool(ctx)

    const result = await run(tool, { handle: 'abcd1234#0' })
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('多个'), result.error)
    assert.ok(result.error.includes(SESSION_B) && result.error.includes(SESSION_C), '歧义信息应列出候选')
    assert.ok(result.error.includes('完整'), '歧义时应提示用完整 sessionId')

    const exact = await run(tool, { handle: `${SESSION_B}#0` })
    assert.equal(exact.ok, true, exact.error)
    assert.equal(exact.sessionId, SESSION_B)
  })
})

await test('前缀无匹配 / 轮次不存在：文案明确', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: { [SESSION_A]: sampleEvents() } })
    await syncSessionIndexFor(ctx, SESSION_A)
    const tool = createHistoryTurnTool(ctx)

    const noSession = await run(tool, { handle: 'deadbeef#0' })
    assert.equal(noSession.ok, false)
    assert.ok(noSession.error.includes('deadbeef'))
    assert.ok(noSession.error.includes('没有'), noSession.error)

    const noTurn = await run(tool, { sessionId: SESSION_A, turn: 99 })
    assert.equal(noTurn.ok, false)
    assert.ok(noTurn.error.includes('99'), noTurn.error)
    assert.ok(noTurn.error.includes('共 3 轮'), noTurn.error)
  })
})

await test('句柄格式错误：给出正确格式示例', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: { [SESSION_A]: sampleEvents() } })
    const tool = createHistoryTurnTool(ctx)
    for (const handle of ['4c42ff36', '4c42ff36#x', '#1', '', 'zzzz#1', '4c42ff36#-1']) {
      const result = await run(tool, { handle })
      assert.equal(result.ok, false, `handle=${JSON.stringify(handle)} 应被拒绝`)
      assert.ok(result.error.includes('#'), `错误文案应给出格式示例：${result.error}`)
    }
    const neither = await run(tool, {})
    assert.equal(neither.ok, false)
    assert.ok(neither.error.includes('sessionId'))
  })
})

await test('会话读不到：返回明确文字而不是抛原样异常', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: {},
      stat: async () => {
        throw new Error('stat failed')
      },
      readSession: async () => null,
    })
    const tool = createHistoryTurnTool(ctx)
    const result = await run(tool, { sessionId: 'session-dead-0000', turn: 0 })
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('读不到会话'), result.error)
    assert.ok(result.error.includes('session-dead-0000'), result.error)
  })
})

// ── 摘要上限与邻居边界 ──────────────────────────────────────────────

await test('摘要强制 ≤400 字并置 truncated，渲染提示原文未返回', async () => {
  await withTempHome(async () => {
    const longPrompt = '问'.repeat(7000)
    const longResponse = '答'.repeat(7000)
    const events = makeEvents([{ prompt: longPrompt, response: longResponse }])
    const ctx = makeCtx({
      events: { [SESSION_A]: events },
      llmOptions: { text: '要'.repeat(600) },
    })
    await syncSessionIndexFor(ctx, SESSION_A)
    const tool = createHistoryTurnTool(ctx)

    const result = await run(tool, { handle: '4c42ff36#0' })
    assert.equal(result.ok, true)
    assert.equal(result.summary.length, 400)
    assert.equal(result.chars, 400)
    assert.equal(result.truncated, true)
    assert.equal(result.neighbors.length, 0, '只有一轮时没有邻居')

    const rendered = tool.output.render({}, result)
    assert.ok(rendered[0].text.includes('原文未返回'), '渲染应提示摘要压缩自更长的原文')
  })
})

await test('短内容也标 truncated（摘要不等于全文）；首轮无前、末轮无后', async () => {
  await withTempHome(async () => {
    const events = makeEvents([
      { prompt: '甲' },
      { prompt: '乙' },
      { prompt: '丙' },
    ])
    const ctx = makeCtx({ events: { [SESSION_A]: events } })
    await syncSessionIndexFor(ctx, SESSION_A)
    const tool = createHistoryTurnTool(ctx)

    const first = await run(tool, { handle: '4c42ff36#0' })
    assert.equal(first.truncated, true)
    assert.deepEqual(first.neighbors.map(item => item.turn), [1])

    const last = await run(tool, { handle: '4c42ff36#2' })
    assert.deepEqual(last.neighbors.map(item => item.turn), [1])
  })
})

await test('摘要生成失败：工具返回人话错误，不抛异常', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [SESSION_A]: sampleEvents() },
      llm: makeFakeLlm({ fail: true }),
    })
    await syncSessionIndexFor(ctx, SESSION_A)
    const tool = createHistoryTurnTool(ctx)
    const result = await run(tool, { handle: '4c42ff36#0' })
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('生成摘要失败'), result.error)
  })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
