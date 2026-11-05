/**
 * Smoke test against a real session log on this machine.
 *
 * Reads a compressed session file through the harness-free path (zstd is not
 * available to plain Node), so instead it exercises the pipeline over a
 * synthetic log sized like a real one — 200 turns, mixed topics — to measure
 * the fold and the lane engine at realistic scale.
 *
 * Run: node tests/smoke.mjs
 */

import { buildTurnModel } from '../lib/turn-model.js'
import { assignLanes } from '../lib/lane-engine.js'
import { sessionCost } from '../lib/cost.js'
import { lookupPrices } from '../lib/prices.js'

const TURNS = 200

/** Build a log whose topics drift the way a long real session does. */
function makeLog() {
  const topics = [
    ['插件', '面板', '泳道', '时间轴', '渲染', '布局'],
    ['数据库', '索引', '分片', '事务', '隔离', '回滚'],
    ['构建', '打包', 'esbuild', 'bundle', '体积', '压缩'],
    ['测试', '断言', '夹具', '覆盖率', '用例', '回归'],
  ]
  const events = []
  let seq = 0
  const push = (type, data, time) => events.push({ type, seq: seq++, time, data })

  for (let i = 0; i < TURNS; i += 1) {
    // Occasionally jump back to an earlier topi: that is the case the panel
    // exists to make legible.
    const topicIndex = i > 120 && i % 17 === 0 ? 0 : Math.floor(i / 50) % topics.length
    const words = topics[topicIndex]
    const base = 1_700_000_000_000 + i * 60_000
    push('turn/start', { turn: i }, base)
    push('user/message', {
      content: [{ type: 'text', text: `${words.join(' ')} 第 ${i} 步 继续推进` }],
      source: { kind: 'user' },
    }, base + 100)
    push('step/start', {}, base + 200)
    push('tool/call', {
      name: i % 3 === 0 ? 'bash' : 'edit',
      arguments: JSON.stringify({ file_path: `E:\\proj\\src\\File${i % 7}.ts` }),
      callId: `c${i}`,
      step: 1,
    }, base + 300)
    push('assistant/message', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `${words[0]} 已处理完成` }],
        source: { kind: 'model', provider: 'agent2api', model: 'DeepSeek-Flash' },
      },
      stream: [],
      usage: {
        inputTokens: 9000 + (i % 40) * 300,
        outputTokens: 1200 + (i % 17) * 90,
        cacheReadTokens: 6000 + (i % 31) * 200,
        cacheWriteTokens: 0,
      },
    }, base + 4000)
    push('turn/end', { turn: i, reason: { kind: 'completed' } }, base + 5000)
  }
  return events
}

function ms(fn) {
  const t0 = process.hrtime.bigint()
  const value = fn()
  const t1 = process.hrtime.bigint()
  return { value, ms: Number(t1 - t0) / 1e6 }
}

const events = makeLog()
console.log(`log: ${events.length} events / ${TURNS} turns`)

const heap0 = process.memoryUsage().heapUsed

const fold = ms(() => buildTurnModel(events))
console.log(`fold      ${fold.ms.toFixed(1)} ms   turns=${fold.value.turns.length}`)

const lanes = ms(() => assignLanes({ ...fold.value, sessionId: 'smoke' }))
console.log(`lanes     ${lanes.ms.toFixed(1)} ms   lanes=${lanes.value.length}`)
console.log(`lane rows ${lanes.value.map(l => `L${l.row}:${l.turns.length}t/${l.segments.length}s`).join(' ')}`)

const resumed = lanes.value.filter(l => l.segments.some(s => s.kind === 'resumed'))
console.log(`resumed   ${resumed.length} lane(s)`)

const prices = await lookupPrices(fold.value.turns)
const cost = sessionCost(fold.value.turns, prices)
console.log(`cost      $${cost.amount?.toFixed(4) ?? 'null'}  priced=${cost.pricedTurns} unpriced=${cost.unpricedTurns}`)

const heap1 = process.memoryUsage().heapUsed
console.log(`heap      +${((heap1 - heap0) / 1024 / 1024).toFixed(1)} MiB`)

// —— 断言：这是烟囱测试，不是基准 ——
const problems = []
if (fold.value.turns.length !== TURNS) problems.push(`expected ${TURNS} turns, got ${fold.value.turns.length}`)
const covered = lanes.value.flatMap(l => l.turns).sort((a, b) => a - b)
if (covered.length !== TURNS) problems.push(`lanes cover ${covered.length} turns, expected ${TURNS}`)
if (new Set(covered).size !== TURNS) problems.push('a turn appears in more than one lane')
if (cost.amount === null) problems.push('cost should be priceable for agent2api/DeepSeek-Flash')

if (problems.length > 0) {
  console.error('\nFAILED')
  for (const p of problems) console.error(` - ${p}`)
  process.exit(1)
}
console.log('\nOK — realistic-scale fold, lanes, and cost all behave')
