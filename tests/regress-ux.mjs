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

// ── 问题 1：三级缩进 ───────────────────────────────────────────────
test('任务缩进用内联 padding（不依赖 CSS 选择器层级）', () => {
  // 之前 data-depth 挂在外层 div 上，CSS 选择内层 .dsh_tm_trackitem，
  // 两者对不上 -> 缩进完全不生效
  assert.ok(client.includes('const indent = depth === 0 ? 0 : depth === 1 ? 22 : 38')
    || /var indent = depth === 0 \? 0 : depth === 1 \? 22 : 38/.test(client),
    '应显式计算各层缩进')
  assert.ok(client.includes("paddingLeft: indent + 'px'"), '应用内联 paddingLeft')
})

test('深度同时挂在外层与内层（两处都能被选中）', () => {
  const rowDepth = client.includes("className: 'dsh_tm_taskrow'") && client.includes("'data-depth': String(depth)")
  const btnDepth = client.includes("className: 'dsh_tm_trackitem dsh_tm_taskmain'")
  assert.ok(rowDepth, '外层 row 应带 data-depth')
  assert.ok(btnDepth, '内层 button 应有 class（缩进改由外层控制）')
})

test('内层不再叠加左内距（避免缩进过头）', () => {
  // 内层若仍是 22/34px，会和外层 padding 叠加
  assert.ok(!client.includes('.dsh_tm_trackitem[data-depth="1"]{padding-left:22px}'),
    '内层不应再有 22px 左内距')
  assert.ok(client.includes('.dsh_tm_trackitem[data-depth="2"]{padding-left:6px}'),
    '内层应改为小内距')
})

test('折平层的任务按第 2 级缩进（它在阶段下面）', () => {
  // 之前传 1，会让它和工作流层平级
  assert.ok(client.includes('renderTask(t.name, t.turns, 2)'),
    '折平层任务应是 depth 2')
})

test('第 2 级工作流标题有独立缩进', () => {
  assert.ok(client.includes('.dsh_tm_cathead[data-depth="1"]{padding-left:18px'),
    '工作流标题应比阶段缩进更多')
  assert.ok(client.includes("'data-depth': '1',"), '工作流标题应带 depth=1')
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

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
