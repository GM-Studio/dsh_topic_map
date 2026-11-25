/**
 * 会话命令清单端点测试（复制浮窗 A-2）。
 *
 * 新口径：只提取 assistant 回答里的 markdown 围栏代码块，一条命令 = 一个
 * 代码块（text 保留换行）；tool/call 产生的命令完全不出现。
 * 锁：多块顺序、跨轮 seq、围栏解析（语言/无语言/嵌套反引号）、q/lang 过滤
 * 先于分页、索引缺失兜底、错误文案。
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

/** 用代码块数组拼一条 assistant 回答。 */
function responseOf(blocks) {
  return blocks.map(block => `\`\`\`${block.lang ?? ''}\n${block.text}\n\`\`\``).join('\n\n')
}

/** 造事件流：spec.blocks 是回答里的代码块；spec.commands 是故意混入的 tool 命令。 */
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
    const response = spec.response ?? responseOf(spec.blocks ?? [])
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: response }],
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

await test('只提取回答代码块：tool 命令不出现，一条 = 一个块（保留换行）', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: makeEvents([{
        commands: ['tool-only-1', 'tool-only-2'],
        blocks: [
          { lang: 'bash', text: 'npm test\nnode scripts/test-all.mjs' },
          { lang: '', text: 'plain\nline' },
        ],
      }]),
    })
    await syncSessionIndexFor(ctx, SESSION)

    const result = await listSessionCommands(ctx, { sessionId: SESSION })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.total, 2)
    assert.deepEqual(result.value.commands, [
      { seq: 1, turn: 0, lang: 'bash', text: 'npm test\nnode scripts/test-all.mjs' },
      { seq: 2, turn: 0, lang: '', text: 'plain\nline' },
    ])
    assert.equal(result.value.commands.some(item => item.text.includes('tool-only')), false,
      'tool/call 的命令绝不能出现在结果里')
    for (const command of result.value.commands) {
      assert.equal('source' in command, false, '新响应不应再有 source')
      assert.equal('ok' in command, false, '新响应不应再有 ok')
    }
  })
})

await test('多块按出现顺序；跨轮 seq 全局连续', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: makeEvents([
        { blocks: [{ lang: 'bash', text: 'a' }, { lang: 'js', text: 'b' }] },
        { blocks: [] },
        { blocks: [{ lang: 'python', text: 'c' }, { lang: '', text: 'd' }] },
      ]),
    })
    await syncSessionIndexFor(ctx, SESSION)

    const result = await listSessionCommands(ctx, { sessionId: SESSION })
    assert.equal(result.value.total, 4)
    assert.deepEqual(result.value.commands.map(item => item.seq), [1, 2, 3, 4])
    assert.deepEqual(result.value.commands.map(item => item.turn), [0, 0, 2, 2])
    assert.deepEqual(result.value.commands.map(item => item.lang), ['bash', 'js', 'python', ''])
    assert.deepEqual(result.value.commands.map(item => item.text), ['a', 'b', 'c', 'd'])
  })
})

await test('围栏解析：带语言 / 无语言 / 4 反引号嵌套 / 未闭合忽略', async () => {
  await withTempHome(async () => {
    const response = [
      '说明文字不算。',
      '```bash',
      'echo hi',
      '```',
      '```',
      'no lang',
      '```',
      '````',
      '```js',
      'inner ``` fence stays',
      '```',
      '````',
      '```ts title="示例"',
      'const a = 1',
      '```',
      '```bash',
      'unclosed-should-not-appear',
    ].join('\n')
    const ctx = makeCtx({ events: makeEvents([{ response }]) })
    await syncSessionIndexFor(ctx, SESSION)

    const result = await listSessionCommands(ctx, { sessionId: SESSION })
    assert.equal(result.value.total, 4)
    assert.deepEqual(result.value.commands.map(item => item.lang), ['bash', '', '', 'ts'])
    assert.deepEqual(result.value.commands.map(item => item.text), [
      'echo hi',
      'no lang',
      '```js\ninner ``` fence stays\n```',
      'const a = 1',
    ])
    assert.equal(result.value.commands.some(item => item.text.includes('unclosed')), false)
  })
})

await test('块内容不截断：多行/超长完整返回', async () => {
  await withTempHome(async () => {
    const long = `${'x'.repeat(600)}\n${'y'.repeat(600)}`
    const ctx = makeCtx({ events: makeEvents([{ blocks: [{ lang: 'text', text: long }] }]) })
    await syncSessionIndexFor(ctx, SESSION)

    const result = await listSessionCommands(ctx, { sessionId: SESSION })
    assert.equal(result.value.total, 1)
    assert.equal(result.value.commands[0].text, long)
    assert.equal(result.value.commands[0].text.length, 1201)
  })
})

await test('分页边界与 limit 封顶 100', async () => {
  await withTempHome(async () => {
    const specs = Array.from({ length: 13 }, (_, turn) => ({
      blocks: Array.from({ length: 8 }, (_, index) => ({
        lang: 'bash',
        text: `cmd-${turn}-${index}`,
      })),
    }))
    const ctx = makeCtx({ events: makeEvents(specs) })
    await syncSessionIndexFor(ctx, SESSION)

    const page = await listSessionCommands(ctx, { sessionId: SESSION, offset: 0, limit: 2 })
    assert.deepEqual(page.value.commands.map(item => item.seq), [1, 2])
    assert.equal(page.value.hasMore, true)

    const last = await listSessionCommands(ctx, { sessionId: SESSION, offset: 102, limit: 2 })
    assert.deepEqual(last.value.commands.map(item => item.seq), [103, 104])
    assert.equal(last.value.hasMore, false)

    const beyond = await listSessionCommands(ctx, { sessionId: SESSION, offset: 999, limit: 20 })
    assert.deepEqual(beyond.value.commands, [])
    assert.equal(beyond.value.total, 104)
    assert.equal(beyond.value.hasMore, false)

    const capped = await listSessionCommands(ctx, { sessionId: SESSION, limit: 999 })
    assert.equal(capped.value.limit, 100)
    assert.equal(capped.value.commands.length, 100)
    assert.equal(capped.value.hasMore, true)
  })
})

await test('q / lang 过滤先于分页；total 为过滤后总数', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: makeEvents([
        { blocks: [{ lang: 'bash', text: 'npm test' }, { lang: 'js', text: 'console.log(1)' }] },
        { blocks: [{ lang: '', text: 'plain text' }] },
        { blocks: [{ lang: 'bash', text: 'npm run build' }, { lang: 'python', text: 'print(1)' }] },
      ]),
    })
    await syncSessionIndexFor(ctx, SESSION)

    const all = await listSessionCommands(ctx, { sessionId: SESSION })
    assert.equal(all.value.total, 5)

    const bash = await listSessionCommands(ctx, { sessionId: SESSION, lang: 'bash' })
    assert.equal(bash.value.total, 2)
    assert.deepEqual(bash.value.commands.map(item => item.seq), [1, 4])
    assert.deepEqual(bash.value.commands.map(item => item.lang), ['bash', 'bash'])

    const unlabeled = await listSessionCommands(ctx, { sessionId: SESSION, lang: '' })
    assert.equal(unlabeled.value.total, 1)
    assert.deepEqual(unlabeled.value.commands.map(item => item.seq), [3])

    const js = await listSessionCommands(ctx, { sessionId: SESSION, lang: 'js' })
    assert.equal(js.value.total, 1)
    assert.equal(js.value.commands[0].text, 'console.log(1)')

    const byQuery = await listSessionCommands(ctx, { sessionId: SESSION, q: 'NPM' })
    assert.equal(byQuery.value.total, 2, 'q 应大小写不敏感')
    assert.deepEqual(byQuery.value.commands.map(item => item.seq), [1, 4])

    const both = await listSessionCommands(ctx, { sessionId: SESSION, q: 'npm', lang: 'bash' })
    assert.equal(both.value.total, 2)

    // 过滤后分页：q 命中 2 条，offset=1 limit=1 只取第 2 条。
    const page = await listSessionCommands(ctx, { sessionId: SESSION, q: 'npm', offset: 1, limit: 1 })
    assert.deepEqual(page.value.commands.map(item => item.seq), [4])
    assert.equal(page.value.total, 2)
    assert.equal(page.value.hasMore, false)

    const beyond = await listSessionCommands(ctx, { sessionId: SESSION, q: 'npm', offset: 2, limit: 5 })
    assert.deepEqual(beyond.value.commands, [])
    assert.equal(beyond.value.total, 2)
    assert.equal(beyond.value.hasMore, false)

    // 缺省/非法 lang 退回全部。
    const fallback = await listSessionCommands(ctx, { sessionId: SESSION, lang: '*' })
    assert.equal(fallback.value.total, 5)
  })
})

await test('lang:shell 语言组：命中 shell 类、不命中 js/python/无标注', async () => {
  await withTempHome(async () => {
    const blocks = [
      { lang: 'bash', text: 'npm test' },
      { lang: 'SH', text: 'echo sh' },
      { lang: 'powershell', text: 'Get-ChildItem' },
      { lang: 'ps1', text: 'Write-Host' },
      { lang: 'bat', text: 'dir' },
      { lang: 'cmd', text: 'echo cmd' },
      { lang: 'zsh', text: 'echo zsh' },
      { lang: 'shell', text: 'sh' },
      { lang: 'console', text: 'npm run build' },
      { lang: 'js', text: 'console.log(1)' },
      { lang: 'python', text: 'print(1)' },
      { lang: '', text: 'plain text' },
    ]
    const ctx = makeCtx({ events: makeEvents([{ blocks }]) })
    await syncSessionIndexFor(ctx, SESSION)

    const shell = await listSessionCommands(ctx, { sessionId: SESSION, lang: 'shell' })
    assert.equal(shell.value.total, 9, 'shell 组应只含白名单语言')
    assert.deepEqual(shell.value.commands.map(item => item.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9])
    assert.deepEqual(shell.value.commands.map(item => item.lang), [
      'bash', 'SH', 'powershell', 'ps1', 'bat', 'cmd', 'zsh', 'shell', 'console',
    ])
    assert.equal(shell.value.commands.some(item => item.lang === 'js'), false)
    assert.equal(shell.value.commands.some(item => item.lang === 'python'), false)
    assert.equal(shell.value.commands.some(item => item.lang === ''), false)

    const upper = await listSessionCommands(ctx, { sessionId: SESSION, lang: 'SHELL' })
    assert.equal(upper.value.total, 9, '特殊值本身也应大小写不敏感')

    const withQuery = await listSessionCommands(ctx, { sessionId: SESSION, lang: 'shell', q: 'NPM' })
    assert.equal(withQuery.value.total, 2, 'q 与 shell 组组合后 total 应为组内过滤结果')
    assert.deepEqual(withQuery.value.commands.map(item => item.seq), [1, 9])

    // 精确语言值行为不变：bash 只命中 bash，不把 shell 组全带出来。
    const exact = await listSessionCommands(ctx, { sessionId: SESSION, lang: 'bash' })
    assert.equal(exact.value.total, 1)
    assert.equal(exact.value.commands[0].seq, 1)
  })
})

await test('索引缺失时走日志兜底，结果一致', async () => {
  await withTempHome(async () => {
    const ctx = makeCtx({
      events: makeEvents([
        { blocks: [{ lang: 'bash', text: 'echo 1' }] },
        { blocks: [{ lang: 'js', text: 'echo 2' }, { lang: '', text: 'echo 3' }] },
      ]),
    })
    // 不建索引。
    const result = await listSessionCommands(ctx, { sessionId: SESSION, offset: 1, limit: 2 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.value.total, 3)
    assert.deepEqual(result.value.commands.map(item => item.seq), [2, 3])
    assert.deepEqual(result.value.commands.map(item => item.text), ['echo 2', 'echo 3'])
  })
})

await test('没有围栏 → 空结果；非法 sessionId 400；读不到 502', async () => {
  await withTempHome(async () => {
    const noFences = makeCtx({ events: makeEvents([{ response: '只有普通回答，没有代码块' }]) })
    await syncSessionIndexFor(noFences, SESSION)
    const empty = await listSessionCommands(noFences, { sessionId: SESSION })
    assert.equal(empty.ok, true)
    assert.equal(empty.value.total, 0)
    assert.deepEqual(empty.value.commands, [])

    const invalid = await listSessionCommands(noFences, { sessionId: '   ' })
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

console.log(`\n${passed} passed, ${failures.length} failures`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
