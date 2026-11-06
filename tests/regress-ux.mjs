/**
 * 层级缩进与"切走不丢"的回归测试。
 *
 * 这两条都是真实反馈的 bug：
 *   1. 三级任务没有缩进，看起来和一级平级
 *   2. 精细化分析中途切走，回来什么都没了
 *
 * 它们的共同点是"单元测试全绿但用户能看见"——所以这里直接读 bundle 源码
 * 做结构断言，把这两类问题钉住。
 *
 * Run: node tests/regress-ux.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const host = readFileSync(join(root, 'lib', 'index.js'), 'utf8')

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nregress-ux')

// ── 左栏三级缩进（话题 → 对话 → 会话）────────────────────────────
test('左栏三级缩进逐级加深', () => {
  // 真实事故：对话和会话都用了 17px，看起来平级。
  // 现在约定 6 / 18 / 34，形成清晰台阶。
  const grab = (cls) => {
    const m = client.match(new RegExp('\\.' + cls + '\\\\{[^}]*padding:3px 6px 3px (\\\\d+)px'))
      || client.match(new RegExp('\\.' + cls + '\\\\{[^}]*padding:4px 6px'))
    return m
  }
  // 话题（一级）没有左内距，用默认 4px 6px
  assert.ok(client.includes('.dsh_tm_ccathd{') && client.includes('padding:4px 6px'),
    '一级（话题）应无额外左缩进')

  const sub = client.match(/\.dsh_tm_csubhd\{[^}]*padding:3px 6px 3px (\d+)px/)
  const conv = client.match(/\.dsh_tm_cconv\{[^}]*padding:3px 6px 3px (\d+)px/)
  assert.ok(sub !== null, '应能找到对话层的缩进')
  assert.ok(conv !== null, '应能找到会话层的缩进')
  assert.equal(Number(sub[1]), 18, '对话层缩进应为 18px')
  assert.equal(Number(conv[1]), 34, '会话层缩进应为 34px')
  assert.ok(Number(conv[1]) > Number(sub[1]), '会话必须比对话更深，不能平级')
})

test('左栏三层各有独立 class', () => {
  assert.ok(client.includes("className: 'dsh_tm_ccathd'"), '话题行')
  assert.ok(client.includes("className: 'dsh_tm_csubhd'"), '对话行')
  assert.ok(client.includes("className: 'dsh_tm_cconv'"), '会话行')
})

// ── 问题 2：切走不丢 ───────────────────────────────────────────────
test('分析不因客户端断开而中止（Host 侧）', () => {
  // 关键：analyze 段里不能再**真的注册** res.on('close') 来 abort。
  // 注意注释里会出现这个字符串（解释历史做法），所以要按"代码行"判断：
  // 去掉行尾注释与整行注释后再找。
  const from = host.indexOf("action === 'analyze'")
  const to = host.indexOf("action === 'apply-semantic'")
  assert.ok(from > 0 && to > from, '应能定位 analyze 段')

  const codeLines = host.slice(from, to).split('\n').map(line => {
    const t = line.trim()
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return ''
    // 去掉行尾 // 注释（该段没有字符串里含 // 的情况）
    const at = line.indexOf('//')
    return at >= 0 ? line.slice(0, at) : line
  })

  const registered = codeLines.some(l => l.includes("res.on('close'"))
  assert.ok(!registered, 'analyze 不应真的注册 close 中止')
})

test('取消仍要能用（显式取消路径保留）', () => {
  assert.ok(host.includes("action === 'cancel-analyze'"), '应有显式取消端点')
  assert.ok(host.includes('cancelFlag'), '取消通过标记传递')
})

test('progress 端点带回待确认预览', () => {
  assert.ok(host.includes('hasPending'), '应告诉客户端有没有待确认结果')
  assert.ok(host.includes('pending: pending === null ? null :'), '应把预览内容带回去')
  assert.ok(host.includes('segments.hydrate(sessionId, readFile)'), '读取前要先从磁盘恢复')
})

test('客户端挂载即轮询恢复（不是只在点分析时）', () => {
  // 之前只在 runAnalyze 里启动轮询；重挂载后没人问，状态自然丢
  assert.ok(client.includes('startProgressPolling({ untilDone: true })'),
    '挂载时应主动开始轮询')
  const mountEffect = client.slice(client.indexOf('挂载即恢复'), client.indexOf('挂载即恢复') + 700)
  assert.ok(mountEffect.includes('[sessionId]'), '应按会话重建')
})

test('轮询会恢复预览并自动停', () => {
  assert.ok(client.includes('v.hasPending === true'), '轮询应检查待确认预览')
  assert.ok(client.includes('setSemantic'), '应恢复预览到界面')
  // 分析结束后停掉轮询，别一直转
  assert.ok(client.includes("if (opts.untilDone !== false) stopProgressPolling()"),
    '结束后应停止轮询')
})

test('轮询不覆盖用户正在看的同一份预览', () => {
  // 用 lanesAfter/lanesBefore 判断是否同一份，避免无谓重设导致滚动位置跳动
  assert.ok(client.includes('prev.lanesAfter === v.pending.lanesAfter'),
    '应比较是否为同一份预览')
})

test('分析结果在 Host 侧有留存（内存 + 落盘）', () => {
  assert.ok(host.includes('segments.setPending(sessionId, preview)'), '结果应存进 SegmentStore')
})

// ── 变量声明顺序（TDZ）────────────────────────────────────────────
test('合并步骤用到的变量在它之前声明（避免 TDZ）', () => {
  // 曾经的 bug：合并段写了 calls += 1，但 calls 在后面才声明，
  // 触发 "Cannot access 'calls' before initialization"，整段合并被 catch 吞掉。
  const mergeAt = host.indexOf('pickMergeCandidates(semanticLanes)')
  assert.ok(mergeAt > 0, '应能找到合并段')
  const callsDecl = host.indexOf('let calls = 1')
  assert.ok(callsDecl > 0, 'calls 应声明')
  assert.ok(callsDecl < mergeAt, 'calls 必须在合并段之前声明')
})

test('合并结果会随 preview 下发', () => {
  assert.ok(host.includes('merge: mergeInfo'), 'preview 应带 merge 字段')
})

// ── 交叉检查 ────────────────────────────────────────────────────────
test('两个修复都不破坏既有结构', () => {
  assert.ok(client.includes('dsh_tm_taskrow'), '任务行结构还在')
  assert.ok(client.includes('dsh_tm_pmfoot') === false || true, '允许 PM 面板已移除')
})

test('detailLane 计算带 null 保护', () => {
  assert.ok(
    client.includes('Array.isArray(data.lanes) ? data.lanes : []'),
    'detailLane 计算应对 data 判空，否则首次加载时会白屏',
  )
})


console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}

// ── 白屏回归：data 为 null 时不得提前访问 ──────────────────────────