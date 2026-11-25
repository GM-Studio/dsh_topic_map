/**
 * 简报端点测试（POST /api/topic-map/brief）。
 *
 * 锁：落盘路径 `~/.dsh/topic-map/briefs/<时间戳>-<slug>.md`、范围说明、
 * 每轮时间线（时间/提问/结论/代码块数/变更文件数）、末尾相关命令、
 * 轮次范围与 turns 选择、会话/工作区两种范围、空范围 404、参数 400、
 * 摘要失败退回原文摘录、以及 200KB 上限截断。
 *
 * Run: node tests/brief.mjs
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createSessionBrief, flushIndexSyncs, syncSessionIndexFor } from '../lib/index.js'

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
const SESSION = 'session-77778888-aaaa-4bbb-8ccc-000000000001'
const SESSION_B = 'session-77778888-bbbb-4bbb-8ccc-000000000002'
const WS = 'ws-brief-1'

/** 一段带两个围栏代码块的回答。 */
function responseWithBlocks(text = '结论正文') {
  return `${text}\n\n\`\`\`bash\nnpm test\n\`\`\`\n\n\`\`\`js\nconsole.log(1)\n\`\`\``
}

/**
 * 造事件流；spec.commands 是 tool/call 里的 shell 命令。
 * spec.changes 为 true 时在轮内插一条 workspace/changes 事件。
 */
function makeEvents(specs) {
  let seq = 0
  const events = []
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })
  specs.forEach((spec, index) => {
    const start = spec.start ?? (BASE_TIME + index * 60_000)
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    push('user/message', {
      content: [{ type: 'text', text: spec.prompt ?? `问题 ${turn}` }],
      source: { kind: 'user' },
    }, start + 100)
    for (const command of spec.commands ?? []) {
      push('tool/call', { name: 'ops_bash', arguments: JSON.stringify({ command }) }, start + 200)
    }
    if (spec.changes === true) {
      push('workspace/changes', { turn }, start + 300)
    }
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: spec.response ?? responseWithBlocks(`结论 ${turn}`) }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
    }, start + 1000)
    push('turn/end', { turn, reason: { kind: 'completed' } }, start + 5000)
  })
  return events
}

function makeCtx(options = {}) {
  const events = options.events ?? {}
  const workspaces = options.workspaces ?? [{
    id: WS,
    path: 'E:\\ws',
    title: '简报工作区',
    sessionIds: options.sessionIds ?? [SESSION],
  }]
  return {
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => workspaces,
          get: id => workspaces.find(w => w.id === id),
        }
      }
      return options.services?.get?.(name)
    },
    sessionQuery: {
      async readSession(id) {
        if (typeof options.readSession === 'function') return options.readSession(id)
        return { events: events[id] ?? [] }
      },
      async readTitleSnapshots(ids) {
        return ids.map(sessionId => ({
          sessionId,
          status: 'fulfilled',
          value: { title: { title: options.titles?.[sessionId] ?? `会话 ${sessionId.slice(-4)}` } },
        }))
      },
      async listSessions() {
        return []
      },
    },
    sessionPersistence: {
      async stat(id) {
        if (typeof options.stat === 'function') return options.stat(id)
        return { revision: options.revisions?.[id] ?? 'rev-1' }
      },
    },
    workspaceChanges: {
      async summary() {
        return {
          files: [
            { path: 'src/a.js', added: 3, deleted: 1 },
            { path: 'src/b.js', added: 1, deleted: 0 },
          ],
          total: 2,
          added: 4,
          deleted: 1,
        }
      },
    },
  }
}

async function withTempHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'brief-'))
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

const digestOk = async ({ turn }) => ({ ok: true, summary: `第 ${turn} 轮结论摘要` })

console.log('\nbrief')

await test('正常：落盘到 briefs、包含范围/时间线/命令', async () => {
  await withTempHome(async home => {
    const events = makeEvents([
      { prompt: '第一个问题', commands: ['npm test'], changes: true },
      { prompt: '第二个问题' },
    ])
    const ctx = makeCtx({ events: { [SESSION]: events }, sessionIds: [SESSION] })
    await syncSessionIndexFor(ctx, SESSION)

    const result = await createSessionBrief(ctx, { sessionId: SESSION, title: '回归简报' }, { digest: digestOk })
    assert.equal(result.ok, true, result.error)
    assert.ok(result.value.path.startsWith(join(home, 'topic-map', 'briefs')), result.value.path)
    assert.match(result.value.path, /\.md$/)
    assert.equal(result.value.turns, 2)
    const content = await readFile(result.value.path, 'utf8')
    assert.equal(result.value.bytes, Buffer.byteLength(content))
    assert.match(content, /^# 回归简报/m)
    assert.match(content, /## 时间线/)
    assert.match(content, /第 0 轮/)
    assert.match(content, /第一个问题/)
    assert.match(content, /第 0 轮结论摘要/)
    assert.match(content, /代码块：2/)
    assert.match(content, /变更文件：2/)
    assert.match(content, /## 相关命令/)
    assert.match(content, /npm test/)
  })
})

await test('范围：from/to 与 turns 数组过滤', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: {
        [SESSION]: makeEvents([{ prompt: 't0' }, { prompt: 't1' }, { prompt: 't2' }, { prompt: 't3' }]),
      },
    })
    const ranged = await createSessionBrief(
      ctx,
      { sessionId: SESSION, from: 1, to: 2 },
      { digest: digestOk },
    )
    assert.equal(ranged.ok, true, ranged.error)
    assert.equal(ranged.value.turns, 2)
    const rangedText = await readFile(ranged.value.path, 'utf8')
    assert.ok(rangedText.includes('t1') && rangedText.includes('t2'))
    assert.equal(rangedText.includes('t0'), false, 'from 之前的轮次不该写入')
    assert.equal(rangedText.includes('t3'), false, 'to 之后的轮次不该写入')

    const picked = await createSessionBrief(ctx, { sessionId: SESSION, turns: [0, 3] }, { digest: digestOk })
    assert.equal(picked.ok, true, picked.error)
    assert.equal(picked.value.turns, 2)
    const pickedText = await readFile(picked.value.path, 'utf8')
    assert.ok(pickedText.includes('t0') && pickedText.includes('t3'))
    assert.equal(pickedText.includes('t1'), false)
  })
})

await test('工作区范围：合并多个会话，按时间排序', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: {
        [SESSION]: makeEvents([{ prompt: '会话 A 的问题' }]),
        [SESSION_B]: makeEvents([{ prompt: '会话 B 的问题', start: BASE_TIME + 30_000 }]),
      },
      sessionIds: [SESSION, SESSION_B],
    })
    const result = await createSessionBrief(ctx, { workspaceId: WS }, { digest: digestOk })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.turns, 2)
    const content = await readFile(result.value.path, 'utf8')
    assert.ok(content.includes('会话 A 的问题') && content.includes('会话 B 的问题'))
    const atA = content.indexOf('会话 A 的问题')
    const atB = content.indexOf('会话 B 的问题')
    assert.ok(atA < atB, '时间早的会话应排前面')
  })
})

await test('空范围：会话没有轮次 → 404；会话不存在 → 404', async () => {
  await withTempHome(async () => {
    const empty = makeCtx({ events: { [SESSION]: [] } })
    const none = await createSessionBrief(empty, { sessionId: SESSION }, { digest: digestOk })
    assert.equal(none.ok, false)
    assert.equal(none.httpStatus, 404)
    assert.match(none.error, /没有可写入简报的轮次/)

    const missing = makeCtx({ readSession: async () => null })
    const gone = await createSessionBrief(missing, { sessionId: SESSION }, { digest: digestOk })
    assert.equal(gone.ok, false)
    assert.equal(gone.httpStatus, 404)
    assert.match(gone.error, /会话不存在/)
  })
})

await test('参数错误：from>to、turns 非数组、sessionId 与 workspaceId 同给 → 400', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({ events: { [SESSION]: makeEvents([{}]) } })
    for (const body of [
      { sessionId: SESSION, from: 3, to: 1 },
      { sessionId: SESSION, from: -1 },
      { sessionId: SESSION, to: 1.5 },
      { sessionId: SESSION, turns: 2 },
      { sessionId: SESSION, turns: ['1'] },
      { sessionId: SESSION, workspaceId: WS },
      { sessionId: 123 },
      { workspaceId: 123 },
      { sessionId: SESSION, title: 123 },
    ]) {
      const result = await createSessionBrief(ctx, body, { digest: digestOk })
      assert.equal(result.ok, false, JSON.stringify(body))
      assert.equal(result.httpStatus, 400, JSON.stringify(body))
    }
  })
})

await test('摘要失败：退回原文摘录，不拖垮简报', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: { [SESSION]: makeEvents([{ prompt: 'q', response: responseWithBlocks('这是回答原文，摘要不可用时应该出现。') }]) },
    })
    const result = await createSessionBrief(
      ctx,
      { sessionId: SESSION },
      { digest: async () => ({ ok: false, error: '模型不可用' }) },
    )
    assert.equal(result.ok, true, result.error)
    const content = await readFile(result.value.path, 'utf8')
    assert.match(content, /摘要不可用/)
    assert.match(content, /这是回答原文/)
  })
})

await test('边界：默认 200KB 上限对上千轮仍然生效', async () => {
  await withTempHome(async () => {
    const specs = []
    for (let turn = 0; turn < 1200; turn += 1) {
      specs.push({
        prompt: `第 ${turn} 轮提问${'很长的提问内容'.repeat(30)}`,
        response: `第 ${turn} 轮回答`,
      })
    }
    const ctx = makeCtx({ events: { [SESSION]: makeEvents(specs) } })
    const result = await createSessionBrief(ctx, { sessionId: SESSION }, { digest: digestOk })
    assert.equal(result.ok, true, result.error)
    const content = await readFile(result.value.path, 'utf8')
    const bytes = Buffer.byteLength(content)
    assert.ok(bytes <= 200 * 1024, `简报 ${bytes} 字节超过 200KB`)
    assert.match(content, /已截断/)
    assert.ok(result.value.turns > 0 && result.value.turns < 1200)
  })
})

await test('边界：超过 maxBytes 时写截断说明且总量不超限', async () => {
  await withTempHome(async () => {
    const specs = []
    for (let turn = 0; turn < 40; turn += 1) {
      specs.push({ prompt: `第 ${turn} 轮问题 `.repeat(12), response: `第 ${turn} 轮回答 `.repeat(12) })
    }
    const ctx = makeCtx({ events: { [SESSION]: makeEvents(specs) } })
    const maxBytes = 2000
    const result = await createSessionBrief(ctx, { sessionId: SESSION }, { digest: digestOk, maxBytes })
    assert.equal(result.ok, true, result.error)
    const content = await readFile(result.value.path, 'utf8')
    const bytes = Buffer.byteLength(content)
    assert.ok(bytes <= maxBytes, `简报 ${bytes} 字节超过上限 ${maxBytes}`)
    assert.match(content, /已截断/)
    assert.ok(result.value.turns < 40, '超限时应少写几轮')
    assert.ok(result.value.turns > 0, '至少保留一轮')
  })
})

await test('读取超时 → 504', async () => {
  await withTempHome(async () => {
    const hanging = makeCtx({ readSession: async () => new Promise(() => {}) })
    const result = await createSessionBrief(
      hanging,
      { sessionId: SESSION },
      { digest: digestOk, timeoutMs: 10 },
    )
    assert.equal(result.ok, false)
    assert.equal(result.httpStatus, 504)
    assert.match(result.error, /超时/)
  })
})

await test('路径：时间戳-slug.md，slug 来自标题且不含路径分隔符', async () => {
  await withTempHome(async home => {
    const ctx = makeCtx({ events: { [SESSION]: makeEvents([{ prompt: 'q' }]) } })
    const result = await createSessionBrief(
      ctx,
      { sessionId: SESSION, title: '危险/标题:带*字符?' },
      { digest: digestOk },
    )
    assert.equal(result.ok, true, result.error)
    const name = result.value.path.slice(dirname(result.value.path).length + 1)
    assert.match(name, /^\d{8}-\d{6}-.+\.md$/)
    assert.equal(/[\\/:*?"<>|]/.test(name.replace(/^\d{8}-\d{6}-/, '')), false, name)
    assert.equal(dirname(resolve(result.value.path)), resolve(join(home, 'topic-map', 'briefs')))
  })
})

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
