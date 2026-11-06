/**
 * 本轮修复的回归测试：跳转精度 + 渲染性能。
 *
 * 锁定的都是实测出过问题的点：
 *   1. 遗留的调试定时器（每 2 秒全页测量 + POST）
 *   2. 跳转要求"原生导航按钮可点"才肯滚动 —— 大部分轮次因此失败
 *   3. 锚点/重试预算太短（1.4 秒）
 *   4. 没有粗定位（虚拟列表里目标行没渲染就永远找不到）
 *   5. 非当前会话的跳转按钮直接不渲染（用户以为功能没了）
 *   6. 拖拽/悬停每个事件都重渲染
 *   7. 邻接高亮是 O(n²)
 *   8. 大会话无虚拟化、编号不降级
 *
 * Run: node tests/perf-jump.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const here = new URL('.', import.meta.url)
const src = readFileSync(new URL('../lib/client.js', here), 'utf8')
const semantic = readFileSync(new URL('../lib/semantic.js', here), 'utf8')

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nperf-jump')

// ── 1. 调试定时器必须不存在 ──
test('没有遗留的全页测量定时器', () => {
  assert.equal(src.includes('TEMP-JUMP-DIAG: bounded'), false, '调试遥测定时器应已删除')
  assert.equal(src.includes("post('jump-debug'"), false, '不应再往宿主上报调试数据')
})

test('面板不会在 apply 阶段启动周期性 DOM 测量', () => {
  const applyAt = src.indexOf('function apply(ctx)')
  assert.ok(applyAt > 0, '应能找到 apply')
  const seg = src.slice(applyAt, applyAt + 1200)
  assert.equal(seg.includes('setInterval'), false, 'apply 里不应有 setInterval（面板没打开也在跑）')
})

// ── 2. 跳转不再依赖原生导航按钮 ──
test('找到目标行就滚动，不再要求导航按钮可点', () => {
  assert.equal(src.includes('if (hit !== null && nativeActivated)'), false,
    '不应再有"两者都要成立"的条件')
  assert.ok(src.includes('if (hit !== null) {'), '找到行就应进入滚动分支')
  assert.ok(src.includes('native: nativeActivated'), '原生导航是否生效只作记录，不作门槛')
})

// ── 3. 重试预算放宽 ──
test('重试预算从 24 次放宽到 80 次', () => {
  assert.equal(src.includes('if (attempts < 24)'), false, '旧的 24 次预算应已去掉')
  assert.ok(src.includes('if (attempts < 80)'), '应有 80 次预算')
})

// ── 4. 粗定位 ──
test('找不到行时先按比例粗定位一次', () => {
  assert.ok(src.includes('coarse-seek'), '应有粗定位步骤')
  assert.ok(src.includes('var coarseDone = false'), '粗定位只做一次')
  assert.ok(/scrollTop = Math\.max\(0, Math\.min\(span, target\)\)/.test(src),
    '应按比例写入 scrollTop，并对容器尺寸做有限性检查')
})

// ── 5. 非当前会话：置灰 + 说明 ──
test('跳转不可用时按钮置灰并说明原因', () => {
  assert.ok(src.includes('jumpBlockReason'), '应计算不可用原因')
  assert.ok(src.includes('dsh_tm_primaryoff'), '应有置灰样式')
  assert.ok(src.includes('当前正在查看另一个会话'), '应说明"只能跳当前会话"')
  assert.ok(src.includes('dsh_tm_jumpwhy'), '原因应直接显示，不只放在 tooltip')
})

// ── 6. 拖拽/悬停节流 ──
test('拖拽用 rAF 合并位移，不再每个 pointermove 都重绘', () => {
  assert.ok(src.includes('dragPendingRef'), '应有拖拽位移累计器')
  assert.ok(src.includes('if (pending.raf !== 0) return'), '同一帧内只排一次')
})

test('悬停提示位置用 rAF 合并，且位移小时不更新', () => {
  assert.ok(src.includes('posPendingRef'), '应有提示框位置累计器')
  assert.ok(src.includes('Math.abs(prev.x - next.x) < 3'), '位移小于 3px 不触发重渲染')
})

// ── 7. 邻接高亮不再 O(n²) ──
test('邻接高亮改用预计算的集合', () => {
  assert.ok(src.includes('neighborTurns = new Set()'), '应预计算邻接轮次')
  assert.ok(src.includes('neighborTurns.has(nd.turn)'), '循环里只做 O(1) 查表')
  assert.equal(src.includes('var laneTurns = L.nodes\n            .filter'), false,
    '不应再在节点循环里 filter+map+sort 整张图')
})

// ── 8. 虚拟化与编号降级 ──
test('大会话启用视口虚拟化', () => {
  assert.ok(src.includes('VIRT_MIN_NODES'), '应有虚拟化阈值')
  assert.ok(src.includes('function inView(x, y)'), '应有可见性判定')
  assert.ok(src.includes('if (!inView(nd.x, nd.y)'), '视口外节点不生成元素')
})

test('节点过多时编号降级，只留关注的那几个', () => {
  assert.ok(src.includes('LABEL_MAX_NODES'), '应有编号降级阈值')
  assert.ok(src.includes('if (useLabelLimit && !isSel && !isHover && !inFocus) return'),
    '降级时只给选中/悬停/聚焦泳道画编号')
})

// ── 9. 宿主回弹不再打断定位 ──
test('宿主回到底部不被误判为用户接管', () => {
  assert.ok(src.includes('snappedToBottom'), '应识别宿主回弹')
  assert.ok(src.includes('now >= maxTop - 4'), '到达底部即视为回弹')
})

// ── 10. 分析窗口 50 ──
test('默认分析窗口是 50 轮', () => {
  assert.ok(semantic.includes('DEFAULT_TURN_LIMIT = 50'), 'semantic 默认应为 50')
  assert.ok(src.includes('cfg === null ? 50 : cfg.turnLimit'), '设置面板默认也应同步为 50')
})


// ── 11. 前端缓存：切页签回来要"瞬间恢复" ──────────────────────────
test('会话负载有前端缓存与 TTL', () => {
  assert.ok(src.includes('var SESSION_CACHE = new Map()'), '应有会话缓存')
  assert.ok(src.includes('SESSION_CACHE_TTL_MS'), '应有 TTL')
  assert.ok(src.includes('SESSION_CACHE.set(activeSessionId'), '成功后应写入缓存')
})

test('命中缓存时不再显示 loading（不白屏、不清空）', () => {
  const at = src.indexOf('var cachedEntry = SESSION_CACHE.get(activeSessionId)')
  assert.ok(at > 0, '应查询缓存')
  const seg = src.slice(at, at + 600)
  assert.ok(seg.includes('if (cacheFresh) applyPayload(cachedEntry.payload)'), '命中即渲染')
  assert.ok(seg.includes('else setLoading(true)'), '未命中才进 loading')
})

test('后台刷新失败时保留缓存内容', () => {
  const at = src.indexOf('function load(attempt)')
  const seg = src.slice(at, at + 1400)
  assert.ok(seg.includes('if (cacheFresh) return'), '有缓存时不把界面变成错误页')
})

test('工作区树有前端缓存，且命中时不清空树', () => {
  assert.ok(src.includes('var TREE_CACHE = new Map()'), '应有树缓存')
  const at = src.indexOf('function loadWorkspaceTree')
  const seg = src.slice(at, at + 1600)
  assert.ok(seg.includes('TREE_CACHE.get(cacheKey)'), '应先查缓存')
  assert.ok(seg.includes('if (treeFresh) {'), '命中走"直接填充"分支')
  assert.ok(seg.includes('} else {\n          patchTree({ loading: true, tree: [], total: 0'), '未命中才清空树')
})

// ── 12. 虚拟化阈值要能覆盖真实会话（78 轮）────────────────────────
test('虚拟化阈值降到 60，真实大会话才会启用', () => {
  assert.ok(src.includes('var VIRT_MIN_NODES = 60'), '阈值应为 60（工作区最大会话 78 轮）')
  assert.ok(src.includes('var LABEL_MAX_NODES = 100'), '编号降级阈值应为 100')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
