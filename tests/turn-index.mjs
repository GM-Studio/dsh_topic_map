/**
 * 轮次索引测试：全文抽取、轮次行字段、32k 截断、JSONL 往返、增量跳过、损坏重建。
 *
 * 索引是检索的事实层，坏了会让整个面板"看起来很空"而不是报错，所以这里
 * 同时测纯函数（事件折叠、序列化、meta 解析）和薄 I/O（tmp/rename、revision
 * 比对、损坏自愈）。I/O 用例一律用临时目录，绝不碰真实的 ~/.dsh。
 *
 * Run: node tests/turn-index.mjs
 */

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  INDEX_SCHEMA,
  MAX_TURN_TEXT,
  buildTurnRows,
  capTurnText,
  defaultSessionsDir,
  indexFilePath,
  messageText,
  parseIndexText,
  parseMetaLine,
  readIndexFile,
  readIndexMeta,
  removeIndexFile,
  serializeIndex,
  syncSessionIndex,
} from '../lib/turn-index.js'
import { PROMPT_PREVIEW_LIMIT, RESPONSE_PREVIEW_LIMIT } from '../lib/turn-model.js'

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

// ── 夹具 ────────────────────────────────────────────────────────────

const BASE_TIME = 1_700_000_000_000

/**
 * 造一段会话事件流。一个 spec 是一轮；字段都省略时给最朴素的一轮。
 */
function makeEvents(specs) {
  let seq = 0
  const events = []
  const push = (type, data, time) => {
    events.push({ type, seq: seq++, time, data })
  }
  specs.forEach((spec, index) => {
    const start = BASE_TIME + index * 60_000
    const turn = spec.turn ?? index
    push('turn/start', { turn }, start)
    if (spec.prompt !== undefined) {
      push('user/message', {
        content: [{ type: 'text', text: spec.prompt }],
        source: { kind: 'user' },
      }, start + 100)
    }
    if (spec.steering !== undefined) {
      push('user/message', {
        content: [{ type: 'text', text: spec.steering }],
        source: { kind: 'user' },
      }, start + 150)
    }
    if (spec.system !== undefined) {
      // 系统注入也走 user/message，但它不是人说的话。
      push('user/message', {
        content: [{ type: 'text', text: spec.system }],
        source: { kind: 'system' },
      }, start + 180)
    }
    for (let step = 0; step < (spec.steps ?? 1); step += 1) {
      push('step/start', {}, start + 200 + step)
    }
    for (const call of spec.calls ?? []) {
      push('tool/call', { name: call.name, arguments: JSON.stringify(call.args ?? {}) }, start + 300)
    }
    const messages = spec.messages ?? (
      spec.response === undefined
        ? []
        : [{ text: spec.response, usage: spec.usage, interrupted: spec.interrupted }]
    )
    for (const message of messages) {
      push('assistant/message', {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: message.text }],
          source: {
            kind: 'model',
            provider: 'agent2api',
            model: message.model ?? spec.model ?? 'DeepSeek-Flash',
          },
        },
        usage: message.usage ?? spec.usage,
        interrupted: message.interrupted === true,
      }, start + 1000)
    }
    push('turn/end', { turn, reason: { kind: spec.endReason ?? 'completed' } }, start + 5000)
  })
  return events
}

/** 建一个测试专属索引目录；用例结束无论成败都删掉。 */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'turn-index-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 排序后哈希：只比内容集合，不比落盘顺序。 */
function hashLines(text) {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  const body = lines.slice(1).sort().join('\n')
  return createHash('sha256').update(body).digest('hex')
}

/** 读文件的原始文本；不存在时返回 null（用来查 tmp 残留）。 */
async function readOrNull(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

console.log('\nturn-index')

// ── 全文抽取 ────────────────────────────────────────────────────────

await test('提问与回答存全文，不被 80/160 预览上限截断', () => {
  const prompt = `把左栏改成三级树。\n要求：保留现有联动。\n${'细节说明'.repeat(40)}`
  const response = `## 结论\n- 用 data-owner 与 data-scope 分离高亮\n- 缓存判定改为"会话都还在"\n${'补充说明。'.repeat(120)}`
  const [row] = buildTurnRows(makeEvents([{ prompt, response }]))
  assert.equal(row.prompt, prompt)
  assert.equal(row.response, response)
  assert.ok(row.prompt.length > PROMPT_PREVIEW_LIMIT, `prompt 只有 ${row.prompt.length} 字，像是套了预览上限`)
  assert.ok(row.response.length > RESPONSE_PREVIEW_LIMIT, `response 只有 ${row.response.length} 字，像是套了预览上限`)
  assert.ok(row.prompt.includes('\n') && row.response.includes('\n'), '换行被折叠，不是原文')
  assert.equal(row.truncated, false)
})

await test('messageText 只取 text 块，并保留块内换行', () => {
  assert.equal(messageText([{ type: 'text', text: '甲\n乙' }, { type: 'image', data: 'x' }]), '甲\n乙')
  assert.equal(messageText([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]), '甲\n乙')
  assert.equal(messageText([{ type: 'tool', name: 'edit' }]), '')
  assert.equal(messageText(null), '')
})

await test('系统注入不算提问，steering 追加进提问全文', () => {
  const [row] = buildTurnRows(makeEvents([
    { prompt: '第一句', steering: '补充一句', system: '系统注入内容不应出现在提问里' },
  ]))
  assert.equal(row.prompt, '第一句\n\n补充一句')
  assert.equal(row.prompt.includes('系统注入'), false)
})

await test('多段回答按出现顺序拼接，不丢中间步骤', () => {
  const [row] = buildTurnRows(makeEvents([
    { prompt: '做吧', messages: [{ text: '先看一下' }, { text: '改好了' }] },
  ]))
  assert.equal(row.response, '先看一下\n\n改好了')
})

// ── 轮次行字段 ──────────────────────────────────────────────────────

await test('轮次行字段完整、类型正确', () => {
  const [row] = buildTurnRows(makeEvents([
    {
      turn: 7,
      prompt: '把左栏改成三级树',
      steps: 2,
      calls: [
        { name: 'edit', args: { path: 'lib/client.js', file_path: 'E:\\dsh_plugin\\lib\\client.js' } },
        { name: 'bash', args: { path: 'lib/turn-index.js' } },
        { name: 'edit', args: { path: 'lib/client.js' } },
      ],
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 2, reasoningTokens: 1 },
      response: '改完了',
      model: 'deepseek-v4',
    },
  ]))

  const required = [
    'turn', 'seq', 'start', 'end', 'endSeq', 'ms',
    'prompt', 'response', 'tools', 'files', 'commands', 'usage',
    'model', 'endReason', 'interrupted', 'steps', 'truncated',
  ]
  for (const key of required) assert.ok(key in row, `缺字段：${key}`)

  assert.equal(row.turn, 7)
  assert.equal(row.seq, 0)
  assert.equal(row.start, BASE_TIME)
  assert.equal(row.end, BASE_TIME + 5000)
  assert.equal(Number.isInteger(row.endSeq), true)
  assert.equal(row.ms, 5000)
  assert.equal(typeof row.prompt, 'string')
  assert.equal(typeof row.response, 'string')
  assert.deepEqual(row.tools, ['edit', 'bash'])
  assert.deepEqual(row.commands, [], '没有 command 类参数时 commands 应为空数组')
  assert.deepEqual(row.files, ['lib/client.js', 'E:\\dsh_plugin\\lib\\client.js', 'lib/turn-index.js'])
  assert.deepEqual(row.usage, { input: 100, output: 20, cacheRead: 5, cacheWrite: 2, reasoning: 1 })
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']) {
    assert.equal(typeof row.usage[key], 'number', `usage.${key} 不是数字`)
  }
  assert.equal(row.model, 'deepseek-v4')
  assert.equal(row.endReason, 'completed')
  assert.equal(row.interrupted, false)
  assert.equal(row.steps, 2)
})

await test('endSeq：已终结轮记录 turn/end seq，未终结轮为 null', () => {
  const events = makeEvents([{ prompt: '甲' }, { prompt: '乙' }])
  const [first, second] = buildTurnRows(events)
  const end0 = events.find(event => event.type === 'turn/end' && event.data.turn === 0)
  const end1 = events.find(event => event.type === 'turn/end' && event.data.turn === 1)
  assert.equal(first.endSeq, end0.seq)
  assert.equal(second.endSeq, end1.seq)

  const unfinished = events.filter(event => !(event.type === 'turn/end' && event.data.turn === 1))
  const [, openRow] = buildTurnRows(unfinished)
  assert.equal(openRow.endSeq, null, '没有 turn/end 的轮次不能伪造 endSeq')
})

await test('命令抽取：command→cmd→script→args.command→args.cmd 优先', () => {
  const [row] = buildTurnRows(makeEvents([{
    prompt: '跑命令',
    calls: [
      { name: 'run_code', args: { command: 'echo one' } },
      { name: 'custom_tool', args: { cmd: 'echo two' } },
      { name: 'anything', args: { script: 'echo three' } },
      { name: 'anything', args: { code: 'console.log(4)' } }, // code 要解包，整段 JS 不算命令
      { name: 'anything', args: { args: { command: 'echo five' } } },
      { name: 'anything', args: { args: { cmd: 'echo six' } } },
      { name: 'anything', args: { command: 'first-wins', cmd: 'second' } },
      { name: 'anything', args: { cmd: 'cmd-wins', code: 'code-loses' } },
    ],
  }]))
  // 工具名不写死：run_code / custom_tool / anything 都按参数键抽。
  assert.deepEqual(row.commands, [
    'echo one',
    'echo two',
    'echo three',
    'echo five',
    'echo six',
    'first-wins',
    'cmd-wins',
  ])
  assert.deepEqual(row.tools, ['run_code', 'custom_tool', 'anything'])
})

await test('run_code 解包：双引号/单引号/JSON 键/转义换行', () => {
  const doubleQuoted = 'const r = await tools.ops_bash({\n  command: "pwd; echo \'---\'; where dsh",\n  description: "x",\n});'
  const singleQuoted = "await tools.ops_bash({ cmd: 'ls -la' })"
  const jsonKey = 'const p = { "command": "git status --short" };'
  const escapedNewline = 'await tools.ops_bash({ command: "echo a\\necho b" })'

  const [row] = buildTurnRows(makeEvents([{
    prompt: '解包',
    calls: [
      { name: 'run_code', args: { code: doubleQuoted } },
      { name: 'run_code', args: { code: singleQuoted } },
      { name: 'run_code', args: { code: jsonKey } },
      { name: 'run_code', args: { code: escapedNewline } },
    ],
  }]))
  assert.deepEqual(row.commands, [
    "pwd; echo '---'; where dsh",
    'ls -la',
    'git status --short',
    'echo a\necho b',
  ])
  assert.ok(row.commands[3].includes('\n'), '转义换行应还原成真实换行')
})

await test('run_code 解包失败：不回退成整段 JS', () => {
  const [row] = buildTurnRows(makeEvents([{
    prompt: '解包失败',
    calls: [
      { name: 'run_code', args: { code: 'const x = 1;\nconsole.log(x);' } },
      { name: 'run_code', args: { code: 'await tools.ops_bash({ command: cmd })' } },
      { name: 'run_code', args: { code: 'await tools.ops_bash({ command: "unterminated })' } },
    ],
  }]))
  assert.deepEqual(row.commands, [])
})

await test('shell 类工具：code/script 直接当命令，不走 JS 解包', () => {
  const [row] = buildTurnRows(makeEvents([{
    prompt: 'shell 工具',
    calls: [
      { name: 'bash', args: { code: 'echo from bash' } },
      { name: 'powershell', args: { code: 'Get-ChildItem' } },
      { name: 'terminal', args: { script: 'ls -a' } },
      { name: 'run_shell', args: { code: 'echo via run_shell' } },
    ],
  }]))
  assert.deepEqual(row.commands, ['echo from bash', 'Get-ChildItem', 'ls -a', 'echo via run_shell'])
})

await test('命令去重、上限 8、单条 500 字符截断且无省略号', () => {
  const long = 'x'.repeat(600)
  const calls = [
    { name: 'run_code', args: { command: long } },
    { name: 'run_code', args: { command: 'a' } },
    { name: 'run_code', args: { command: 'a' } },
    { name: 'run_code', args: { command: 'b' } },
    ...Array.from({ length: 9 }, (_, index) => ({
      name: 'run_code',
      args: { command: `c${index}` },
    })),
  ]
  const [row] = buildTurnRows(makeEvents([{ prompt: 'x', calls }]))
  assert.equal(row.commands.length, 8, '每轮命令上限应为 8')
  assert.deepEqual(row.commands, [
    long.slice(0, 500), 'a', 'b', 'c0', 'c1', 'c2', 'c3', 'c4',
  ])
  assert.equal(row.commands[0].length, 500)
  assert.equal(row.commands[0].endsWith('…'), false, '截断不应追加省略号')
  assert.equal(row.commands.includes('c5'), false)
})

await test('空值/非字符串/坏 JSON 不产生命令', () => {
  const events = makeEvents([{
    prompt: 'x',
    calls: [
      { name: 'run_code', args: { command: '   ' } },
      { name: 'run_code', args: { command: 123 } },
      { name: 'run_code', args: {} },
    ],
  }])
  // 参数不是合法 JSON 时也不能造出命令。
  events.splice(events.length - 1, 0, {
    type: 'tool/call',
    seq: 9999,
    time: BASE_TIME + 1,
    data: { name: 'run_code', arguments: '{bad json' },
  })
  const [row] = buildTurnRows(events)
  assert.deepEqual(row.commands, [])
})

await test('中断标记来自 assistant/message，结束原因原样保留', () => {
  const [row] = buildTurnRows(makeEvents([
    {
      prompt: '跑',
      messages: [{ text: '半截', interrupted: true }],
      endReason: 'interrupted',
    },
  ]))
  assert.equal(row.interrupted, true)
  assert.equal(row.endReason, 'interrupted')
})

await test('未收尾的轮次 end/ms 为 null，endReason 为 open', () => {
  const events = makeEvents([{ prompt: '停在这' }]).filter(event => event.type !== 'turn/end')
  const [row] = buildTurnRows(events)
  assert.equal(row.end, null)
  assert.equal(row.ms, null)
  assert.equal(row.endReason, 'open')
})

// ── 32k 上限 ────────────────────────────────────────────────────────

await test('单轮文本超 32k：截断回答并置 truncated', () => {
  const prompt = '短问题'
  const response = '答'.repeat(MAX_TURN_TEXT * 2)
  const [row] = buildTurnRows(makeEvents([{ prompt, response }]))
  assert.equal(row.truncated, true)
  assert.equal(row.prompt, prompt)
  assert.equal(row.prompt.length + row.response.length, MAX_TURN_TEXT)
  assert.ok(row.response.length < response.length, '回答没有被截断')
})

await test('提问自己就超 32k：只截提问，回答为空', () => {
  const prompt = '问'.repeat(MAX_TURN_TEXT + 500)
  const [row] = buildTurnRows(makeEvents([{ prompt }]))
  assert.equal(row.truncated, true)
  assert.equal(row.prompt.length, MAX_TURN_TEXT)
  assert.equal(row.response, '')
})

await test('capTurnText 边界：恰好等于上限不算截断', () => {
  assert.deepEqual(capTurnText('ab', 'cd', 10), { prompt: 'ab', response: 'cd', truncated: false })
  assert.deepEqual(capTurnText('abcd', 'efgh', 5), { prompt: 'abcd', response: 'e', truncated: true })
  assert.deepEqual(capTurnText('abcdef', '', 5), { prompt: 'abcde', response: '', truncated: true })
  assert.deepEqual(capTurnText('12345', '', 5), { prompt: '12345', response: '', truncated: false })
})

// ── JSONL 往返 ──────────────────────────────────────────────────────

await test('meta 行是首行且可往返', () => {
  const turns = buildTurnRows(makeEvents([
    { prompt: '一', response: '二' },
    { prompt: '三', response: '四' },
  ]))
  const text = serializeIndex({ revision: 'rev-9', turns })
  const lines = text.trimEnd().split('\n')
  assert.equal(lines.length, 3)
  assert.ok(lines[0].startsWith('{"kind":"meta"'), `首行不是 meta：${lines[0]}`)
  assert.deepEqual(parseMetaLine(lines[0]), {
    kind: 'meta',
    schema: INDEX_SCHEMA,
    revision: 'rev-9',
    turnCount: 2,
  })
  const parsed = parseIndexText(text)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.turns, turns)
  assert.equal(parsed.meta.turnCount, 2)
})

await test('meta 解析拒绝坏行与不认识的 schema', () => {
  assert.equal(parseMetaLine('oops'), null)
  assert.equal(parseMetaLine('{"kind":"meta"}'), null)
  assert.equal(parseMetaLine('{"kind":"meta","schema":999,"revision":"r","turnCount":0}'), null)
  assert.equal(parseMetaLine(''), null)
  assert.equal(parseMetaLine(null), null)
})

await test('行数少于 turnCount 视为损坏', () => {
  const turns = buildTurnRows(makeEvents([{ prompt: '一' }, { prompt: '二' }]))
  const text = serializeIndex({ revision: 'r', turns })
  const lines = text.trimEnd().split('\n')
  const short = `${lines[0]}\n${lines[1]}\n`
  const parsed = parseIndexText(short)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reason, 'turn-count')
})

await test('seq 回退视为损坏', () => {
  const turns = buildTurnRows(makeEvents([{ prompt: '一' }, { prompt: '二' }]))
  const regressed = turns.map((row, index) => ({ ...row, seq: index === 1 ? 0 : row.seq }))
  const parsed = parseIndexText(serializeIndex({ revision: 'r', turns: regressed }))
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reason, 'order')
})

// ── 增量 ────────────────────────────────────────────────────────────

await test('revision 相同则跳过，不再读事件流', async () => {
  await withTempDir(async dir => {
    let calls = 0
    const events = makeEvents([{ prompt: '甲', response: '乙' }])
    const loadEvents = async () => {
      calls += 1
      return events
    }
    const first = await syncSessionIndex({ dir, sessionId: 'sess-inc', revision: 'rev-1', loadEvents })
    assert.equal(first.skipped, false)
    assert.equal(calls, 1)

    const second = await syncSessionIndex({ dir, sessionId: 'sess-inc', revision: 'rev-1', loadEvents })
    assert.equal(second.skipped, true)
    assert.equal(calls, 1, '第二次构建仍然读了事件流')
    assert.equal(second.turns.length, 1)

    const third = await syncSessionIndex({ dir, sessionId: 'sess-inc', revision: 'rev-2', loadEvents })
    assert.equal(third.skipped, false)
    assert.equal(third.reason, 'revision')
    assert.equal(calls, 2)
    const onDisk = parseIndexText(await readFile(third.path, 'utf8'))
    assert.equal(onDisk.meta.revision, 'rev-2')
  })
})

await test('revision 数字入参按字符串比较', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([{ prompt: '甲' }])
    const first = await syncSessionIndex({ dir, sessionId: 'sess-num', revision: 42, loadEvents: async () => events })
    const second = await syncSessionIndex({ dir, sessionId: 'sess-num', revision: 42, loadEvents: async () => events })
    assert.equal(second.skipped, true)
    assert.equal(parseIndexText(await readFile(first.path, 'utf8')).meta.revision, '42')
  })
})

await test('schema 4 旧索引判定过期并整体重建到 schema 5', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([{
      prompt: '旧索引',
      calls: [{ name: 'ops_bash', args: { command: 'echo hi' } }],
    }])
    const first = await syncSessionIndex({
      dir,
      sessionId: 'sess-schema',
      revision: 'rev-1',
      loadEvents: async () => events,
    })

    // 手工退回 schema 4：只改 meta，模拟 F-7 hash 之前的产物。
    const lines = (await readFile(first.path, 'utf8')).trimEnd().split('\n')
    const meta = JSON.parse(lines[0])
    meta.schema = 4
    await writeFile(first.path, [JSON.stringify(meta), ...lines.slice(1)].join('\n') + '\n', 'utf8')

    assert.equal(await readIndexMeta(dir, 'sess-schema'), null, 'schema 4 不该被当成可用索引')
    const stale = await readIndexFile(dir, 'sess-schema')
    assert.equal(stale.ok, false)
    assert.equal(stale.reason, 'meta')

    let loads = 0
    const second = await syncSessionIndex({
      dir,
      sessionId: 'sess-schema',
      revision: 'rev-1',
      loadEvents: async () => {
        loads += 1
        return events
      },
    })
    assert.equal(second.skipped, false, 'schema 4 必须触发重建')
    assert.equal(second.reason, 'meta')
    assert.equal(loads, 1)
    const parsed = parseIndexText(await readFile(second.path, 'utf8'))
    assert.equal(parsed.meta.schema, INDEX_SCHEMA)
    assert.equal(parsed.meta.schema, 5)
    assert.deepEqual(parsed.turns[0].commands, ['echo hi'])
    assert.equal(Number.isInteger(parsed.turns[0].endSeq), true)
  })
})

await test('跳过路径不需要 loadEvents，重建缺 loadEvents 时报错不写空索引', async () => {
  await withTempDir(async dir => {
    const first = await syncSessionIndex({
      dir,
      sessionId: 'sess-loader',
      revision: 'r',
      loadEvents: async () => makeEvents([{ prompt: '甲' }]),
    })
    const skipped = await syncSessionIndex({ dir, sessionId: 'sess-loader', revision: 'r' })
    assert.equal(skipped.skipped, true)
    assert.equal(skipped.path, first.path)

    await assert.rejects(
      syncSessionIndex({ dir, sessionId: 'sess-new', revision: 'r' }),
      /loadEvents/,
    )
    const after = await readIndexFile(dir, 'sess-new')
    assert.equal(after.ok, false)
    assert.equal(after.reason, 'missing')
  })
})

// ── 原子写 ──────────────────────────────────────────────────────────

await test('原子写：先 tmp 再 rename，不留下 .tmp', async () => {
  await withTempDir(async dir => {
    const result = await syncSessionIndex({
      dir,
      sessionId: 'sess-atomic',
      revision: 'r1',
      loadEvents: async () => makeEvents([{ prompt: '甲' }]),
    })
    const files = await readdir(dir)
    assert.deepEqual(files, ['sess-atomic.jsonl'])
    assert.equal(await readOrNull(`${result.path}.tmp`), null, 'tmp 文件残留')
    const text = await readFile(result.path, 'utf8')
    assert.ok(text.endsWith('\n'), '文件没有以换行结尾')
    assert.equal(text.trimEnd().split('\n').length, 2)
  })
})

await test('空事件流写一个只有 meta 行的索引', async () => {
  await withTempDir(async dir => {
    const result = await syncSessionIndex({
      dir,
      sessionId: 'sess-empty',
      revision: 'r',
      loadEvents: async () => [],
    })
    const text = await readFile(result.path, 'utf8')
    assert.equal(text.trimEnd().split('\n').length, 1)
    assert.equal(parseMetaLine(text.split('\n')[0]).turnCount, 0)
    const again = await syncSessionIndex({
      dir,
      sessionId: 'sess-empty',
      revision: 'r',
      loadEvents: async () => { throw new Error('不该读事件流') },
    })
    assert.equal(again.skipped, true)
  })
})

// ── 损坏自愈与重建 ──────────────────────────────────────────────────

await test('截断的 JSONL（同一 revision）触发重建', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([{ prompt: '一' }, { prompt: '二' }])
    const first = await syncSessionIndex({ dir, sessionId: 'sess-broken', revision: 'rev-1', loadEvents: async () => events })
    const lines = (await readFile(first.path, 'utf8')).trimEnd().split('\n')
    // 保留 meta 与半行轮次：模拟写到一半就被打断。
    await writeFile(first.path, `${lines[0]}\n${lines[1].slice(0, Math.floor(lines[1].length / 2))}\n`, 'utf8')

    const broken = await readIndexFile(dir, 'sess-broken')
    assert.equal(broken.ok, false)
    assert.equal(broken.reason, 'json')

    let calls = 0
    const result = await syncSessionIndex({
      dir,
      sessionId: 'sess-broken',
      revision: 'rev-1',
      loadEvents: async () => {
        calls += 1
        return events
      },
    })
    assert.equal(result.skipped, false)
    assert.equal(result.reason, 'json')
    assert.equal(calls, 1, '损坏文件没有触发重建')
    const repaired = parseIndexText(await readFile(result.path, 'utf8'))
    assert.equal(repaired.ok, true)
    assert.equal(repaired.meta.turnCount, 2)
  })
})

await test('轮次行被整行删掉（turnCount 不符）触发重建', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([{ prompt: '一' }, { prompt: '二' }])
    const first = await syncSessionIndex({ dir, sessionId: 'sess-short', revision: 'rev-1', loadEvents: async () => events })
    const lines = (await readFile(first.path, 'utf8')).trimEnd().split('\n')
    await writeFile(first.path, `${lines[0]}\n${lines[1]}\n`, 'utf8')

    const result = await syncSessionIndex({
      dir,
      sessionId: 'sess-short',
      revision: 'rev-1',
      loadEvents: async () => events,
    })
    assert.equal(result.skipped, false)
    assert.equal(result.reason, 'turn-count')
    assert.equal(parseIndexText(await readFile(result.path, 'utf8')).meta.turnCount, 2)
  })
})

await test('meta 行损坏触发重建', async () => {
  await withTempDir(async dir => {
    const first = await syncSessionIndex({
      dir,
      sessionId: 'sess-nometa',
      revision: 'rev-1',
      loadEvents: async () => makeEvents([{ prompt: '一' }]),
    })
    await writeFile(first.path, 'not json\n', 'utf8')
    const result = await syncSessionIndex({
      dir,
      sessionId: 'sess-nometa',
      revision: 'rev-1',
      loadEvents: async () => makeEvents([{ prompt: '一' }]),
    })
    assert.equal(result.skipped, false)
    assert.equal(result.reason, 'meta')
    assert.equal(parseIndexText(await readFile(result.path, 'utf8')).ok, true)
  })
})

await test('索引缺失时读取报 missing，同步会重建', async () => {
  await withTempDir(async dir => {
    const missing = await readIndexFile(dir, 'sess-none')
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'missing')

    const result = await syncSessionIndex({
      dir,
      sessionId: 'sess-none',
      revision: 'r',
      loadEvents: async () => makeEvents([{ prompt: '甲' }]),
    })
    assert.equal(result.skipped, false)
    assert.equal(result.reason, 'missing')
    assert.equal(result.turns.length, 1)
  })
})

await test('删除后重建内容一致（F-3）', async () => {
  await withTempDir(async dir => {
    const events = makeEvents([{ prompt: '甲', response: '乙' }, { prompt: '丙', response: '丁' }])
    const first = await syncSessionIndex({ dir, sessionId: 'sess-rebuild', revision: 'rev-a', loadEvents: async () => events })
    const before = await readFile(first.path, 'utf8')
    assert.equal(await removeIndexFile(dir, 'sess-rebuild'), true)
    assert.equal(await removeIndexFile(dir, 'sess-rebuild'), false)

    const second = await syncSessionIndex({ dir, sessionId: 'sess-rebuild', revision: 'rev-a', loadEvents: async () => events })
    assert.equal(second.skipped, false)
    assert.equal(second.reason, 'missing')
    const after = await readFile(second.path, 'utf8')
    assert.equal(after, before, '重建产物与首次构建不一致')
    assert.equal(hashLines(after), hashLines(before))
  })
})

// ── 路径布局 ────────────────────────────────────────────────────────

await test('默认目录是 <DSH_HOME>/topic-map/index/sessions，文件名按会话', async () => {
  await withTempDir(async home => {
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      assert.equal(defaultSessionsDir(), join(home, 'topic-map', 'index', 'sessions'))
      assert.equal(
        indexFilePath(defaultSessionsDir(), 'session-1'),
        join(home, 'topic-map', 'index', 'sessions', 'session-1.jsonl'),
      )
      const result = await syncSessionIndex({
        sessionId: 'session-1',
        revision: 'r',
        loadEvents: async () => makeEvents([{ prompt: '甲' }]),
      })
      assert.equal(result.path, join(home, 'topic-map', 'index', 'sessions', 'session-1.jsonl'))
      assert.equal(parseIndexText(await readFile(result.path, 'utf8')).ok, true)
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })
})

await test('sessionId 里的路径分隔符不会逃出索引目录', () => {
  assert.equal(indexFilePath('D:\\idx', 'a/b'), join('D:\\idx', 'a_b.jsonl'))
  assert.equal(indexFilePath('D:\\idx', 'a\\b'), join('D:\\idx', 'a_b.jsonl'))
  assert.throws(() => indexFilePath('D:\\idx', ''), /sessionId/)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.error(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
