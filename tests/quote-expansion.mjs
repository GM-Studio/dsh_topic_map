/**
 * 引用自动展开测试（wire 层全、显示层短）。
 *
 * 结论：`AssembleContext` 运行时带 `agent`（`assembleContextFor` 传
 * `{agent, scope: agent}`），但 `PromptContext.text` 只能同步返回；历史
 * 会话全文要异步读索引/日志。因此自动展开挂在异步的
 * `system-prompt/assemble` waterfall 上，追加一个同名 context。
 *
 * Run: node tests/quote-expansion.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandQuoteHandlesForAgent,
  flushIndexSyncs,
  registerQuoteExpansion,
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
const CALLER = 'session-9999aaaa-1111-4aaa-8bbb-000000000001'
const TARGET = 'session-4c42ff36-aaaa-4bbb-8ccc-000000000001'
const TARGET_DEDUPE = 'session-4c42ff37-aaaa-4bbb-8ccc-000000000002'
const TARGET_LOG = 'session-4c42ff38-aaaa-4bbb-8ccc-000000000003'
const TARGET_MISS = 'session-4c42ff39-aaaa-4bbb-8ccc-000000000004'
const TARGET_BUDGET = 'session-4c42ff3a-aaaa-4bbb-8ccc-000000000005'
const TARGET_WIRE = 'session-4c42ff3b-aaaa-4bbb-8ccc-000000000006'
const OTHER = 'session-deadbeef-1111-4aaa-8bbb-000000000002'

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

function makeCtx(options = {}) {
  const events = options.events ?? {}
  const revisions = options.revisions ?? {}
  const workspaces = options.workspaces ?? [{
    id: 'ws-1',
    path: 'E:\\ws',
    title: '工作区 A',
    sessionIds: options.sessions ?? Object.keys(events),
  }]
  return {
    get(name) {
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      if (name === 'sessionQuery') {
        return {
          async readSession(id) {
            if (typeof options.readSession === 'function') return options.readSession(id)
            return { events: events[id] ?? [] }
          },
        }
      }
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
}

/** 构造 Agent：deriveMessages 返回人写消息，snapshotEvents 给当前会话的日志。 */
function makeAgent(options = {}) {
  const messages = (options.texts ?? []).map((text, index) => ({
    id: `msg-${index}`,
    role: options.role ?? 'user',
    source: { kind: options.sourceKind ?? 'user' },
    content: [{ type: 'text', text }],
  }))
  return {
    id: options.id ?? CALLER,
    session: {
      header: { cwd: options.cwd ?? 'E:\\ws' },
      deriveMessages: () => messages,
      snapshotEvents: () => options.events ?? [],
    },
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'quote-expansion-'))
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

function countBlocks(text) {
  return (text.match(/〔引用展开 /g) ?? []).length
}

console.log('\nquote-expansion')

// ── async 展开主体 ──────────────────────────────────────────────────

await test('历史会话：句柄展开成全文块（带提问/回答）', async () => {
  await withTempHome(async () => {
    const events = {
      [TARGET]: makeEvents([
        { prompt: '第一轮问题', response: '第一轮回答' },
        { prompt: '第二轮：把跳转修好', response: '定位逻辑改好了。' },
      ]),
    }
    const ctx = makeCtx({ events })
    await syncSessionIndexFor(ctx, TARGET)
    const agent = makeAgent({ texts: [`继续看这个 〔4c42ff36#1〕 的结论`] })

    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.includes('〔引用展开 4c42ff36#1〕'), text)
    assert.ok(text.includes('第二轮：把跳转修好'))
    assert.ok(text.includes('定位逻辑改好了。'))
    assert.ok(text.includes('提问：'))
    assert.ok(text.includes('回答：'))
    assert.equal(countBlocks(text), 1)

    const sample = text.slice(0, 160)
    console.log(`       样例（${text.length} 字，约 ${Math.ceil(text.length / 1.5)} tokens）：${sample.replace(/\n/g, ' / ')}…`)
  })
})

await test('没有句柄 / 非人类消息：不注入', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: { [TARGET]: makeEvents([{ prompt: '甲' }]) } })
    await syncSessionIndexFor(ctx, TARGET)

    assert.equal(await expandQuoteHandlesForAgent(ctx, makeAgent({ texts: ['普通消息，没有引用'] })), '')
    const injected = makeAgent({
      texts: ['〔4c42ff36#0〕'],
      sourceKind: 'agent-message',
    })
    assert.equal(await expandQuoteHandlesForAgent(ctx, injected), '')
    const assistant = makeAgent({ texts: ['〔4c42ff36#0〕'], role: 'assistant' })
    assert.equal(await expandQuoteHandlesForAgent(ctx, assistant), '')
  })
})

await test('同一句柄去重；多个句柄按出现顺序展开', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [TARGET_DEDUPE]: makeEvents([{ prompt: '甲' }, { prompt: '乙' }]) },
    })
    await syncSessionIndexFor(ctx, TARGET_DEDUPE)
    const agent = makeAgent({
      texts: ['看 〔4c42ff37#1〕 和 〔4c42ff37#0〕', '再看一次 〔4c42ff37#1〕'],
    })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.equal(countBlocks(text), 2)
    assert.ok(text.indexOf('4c42ff37#1') < text.indexOf('4c42ff37#0'), '应按出现顺序')
  })
})

await test('当前会话：直接读内存日志，不依赖索引', async () => {
  await withTempHome(async () => {
    const sameSessionEvents = makeEvents([{ prompt: '自己的问题', response: '自己的回答' }])
    const ctx = makeCtx({ events: { [CALLER]: sameSessionEvents } })
    // 故意不建索引。
    const agent = makeAgent({
      id: CALLER,
      texts: ['回看 〔9999aaaa#0〕'],
      events: sameSessionEvents,
    })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.includes('自己的问题'), text)
    assert.ok(text.includes('自己的回答'))
  })
})

await test('目标会话没有索引：退回日志全文', async () => {
  await withTempHome(async () => {
    const longResponse = `${'铺'.repeat(400)}兜底尾巴`
    const ctx = makeCtx({
      events: { [TARGET_LOG]: makeEvents([{ prompt: '目标问题', response: longResponse }]) },
    })
    const agent = makeAgent({ texts: ['〔4c42ff38#0〕'] })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.includes('兜底尾巴'), '没有走日志兜底')
    assert.ok(text.includes('铺铺铺'))
  })
})

await test('轮次不存在 / 读取失败：给出可读说明而不是抛错', async () => {
  await withTempHome(async () => {
    const missEvents = makeEvents([{ prompt: '甲' }])
    const readable = makeCtx({
      events: { [TARGET_MISS]: missEvents },
      sessions: [TARGET_MISS],
    })
    const noTurn = await expandQuoteHandlesForAgent(readable, makeAgent({ texts: ['〔4c42ff39#99〕'] }))
    assert.ok(noTurn.includes('没有第 99 轮'), noTurn)

    const broken = makeCtx({
      events: {},
      sessions: [TARGET_MISS],
      readSession: async () => {
        throw new Error('read failed')
      },
      stat: async () => {
        throw new Error('stat failed')
      },
    })
    const unreadable = await expandQuoteHandlesForAgent(broken, makeAgent({ texts: ['〔4c42ff39#0〕'] }))
    assert.ok(unreadable.includes('读取会话失败'), unreadable)
  })
})

await test('前缀无匹配 / 跨工作区不泄露', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: {
        [OTHER]: makeEvents([{ prompt: '别的工区机密', response: '不该出现' }]),
      },
      sessions: [CALLER],
      workspaces: [
        { id: 'ws-1', path: 'E:\\ws', title: '工作区 A', sessionIds: [CALLER] },
        { id: 'ws-2', path: 'E:\\other', title: '工作区 B', sessionIds: [OTHER] },
      ],
    })
    const agent = makeAgent({ texts: ['〔deadbeef#0〕'] })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.includes('没有匹配该前缀') || text.includes('歧义'), text)
    assert.equal(text.includes('别的工区机密'), false)
  })
})

// ── 预算 ────────────────────────────────────────────────────────────

await test('单块 ≤4000 字、总预算 ≤12000 字、最多 3 个句柄', async () => {
  await withTempHome(async () => {
    const long = '答'.repeat(20000)
    const ctx = makeCtx({
      events: {
        [TARGET_BUDGET]: makeEvents([
          { prompt: '一', response: long },
          { prompt: '二', response: long },
          { prompt: '三', response: long },
          { prompt: '四', response: long },
        ]),
      },
      sessions: [TARGET_BUDGET],
    })
    await syncSessionIndexFor(ctx, TARGET_BUDGET)
    const agent = makeAgent({
      texts: ['〔4c42ff3a#0〕 〔4c42ff3a#1〕 〔4c42ff3a#2〕 〔4c42ff3a#3〕'],
    })
    const text = await expandQuoteHandlesForAgent(ctx, agent)
    assert.ok(text.length <= 12000, `总量超预算：${text.length}`)
    assert.equal(countBlocks(text), 3, '最多展开 3 个句柄')
    for (const block of text.split('\n\n')) {
      assert.ok(block.length <= 4000, `单块超预算：${block.length}`)
    }
  })
})

// ── waterfall 接线 ──────────────────────────────────────────────────

await test('注册在 system-prompt/assemble waterfall：追加同名且 interpolate:false 的 context', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [TARGET_WIRE]: makeEvents([{ prompt: '引用问题', response: '引用回答' }]) },
      sessions: [TARGET_WIRE],
    })
    await syncSessionIndexFor(ctx, TARGET_WIRE)

    let handler = null
    const scope = {
      ...ctx,
      on(name, fn) {
        assert.equal(name, 'system-prompt/assemble')
        handler = fn
        return () => {}
      },
      effect(fn) {
        return fn()
      },
    }
    const fake = {
      inject(names, callback) {
        assert.deepEqual(names, ['systemPrompt'])
        callback(scope)
      },
    }
    registerQuoteExpansion(fake)
    assert.equal(typeof handler, 'function')

    const assembly = { sections: [], contexts: [{ name: 'existing', text: '原有' }], tools: [], variables: {} }
    const agent = makeAgent({ texts: ['〔4c42ff3b#0〕'] })
    const result = await handler({ ...assembly }, { agent, scope: agent }, async () => assembly)
    assert.equal(result.contexts.length, 2)
    assert.equal(result.contexts[1].name, 'topic-map:引用展开')
    assert.equal(result.contexts[1].interpolate, false)
    assert.ok(result.contexts[1].text.includes('引用回答'))

    const untouched = await handler({ ...assembly }, {}, async () => assembly)
    assert.equal(untouched.contexts.length, 1, '没有 agent 时不应注入')
  })
})

await test('宿主没有 systemPrompt 服务：注册不崩', () => {
  assert.doesNotThrow(() => registerQuoteExpansion({ inject() {} }))
  assert.doesNotThrow(() => registerQuoteExpansion({}))
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
