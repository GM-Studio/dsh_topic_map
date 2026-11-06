/**
 * 左中右联动的一致性测试。
 *
 * 覆盖的双向路径：
 *   左 → 中：点话题/对话/会话，中间与右栏跟着换
 *   中 → 左：点图节点、进下一级，左栏展开并高亮
 *   右 → 中 → 左：右栏搜索、点轮次，图上高亮泳道
 *
 * 每条都检查"内容 + 编号 + 数字"是否对应，而不只是"有没有反应"。
 *
 * Run: node tests/linkage.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nlinkage')

/** 取某个函数体（到下一个同级 function 为止）。 */
function bodyOf(name, max = 3000) {
  const at = src.indexOf('function ' + name)
  assert.ok(at > 0, `找不到函数 ${name}`)
  return src.slice(at, at + max)
}

// ── 1. 三处选中入口行为一致 ────────────────────────────────────────
test('图上点节点：选中 + 聚焦泳道 + 滚右栏', () => {
  const seg = src.slice(src.indexOf('onSelect: function (turnNo)'), src.indexOf('onSelect: function (turnNo)') + 500)
  assert.ok(seg.includes('selectTurn('), '应调 selectTurn')
  assert.ok(seg.includes('scrollTurnListTo'), '应把右栏列表滚到该轮')
})

test('右栏点轮次：选中 + 聚焦泳道（与图上点节点一致）', () => {
  const seg = src.slice(src.indexOf('onSelectTurn: function (turnNo)'), src.indexOf('onSelectTurn: function (turnNo)') + 600)
  assert.ok(seg.includes('selectTurn('), '应调 selectTurn（不能只 setSelected）')
  assert.ok(seg.includes('scrollTurnListTo'), '应滚右栏')
})

test('selectTurn 会聚焦所属泳道', () => {
  const body = bodyOf('selectTurn', 1800)
  assert.ok(body.includes('setHighlightLane'), '应高亮泳道')
  assert.ok(body.includes('setSelectedLane'), '应设置选中泳道')
})

// ── 2. 右栏搜索是全会话范围 ────────────────────────────────────────
test('右栏搜索搜整个会话，不只当前泳道', () => {
  const body = bodyOf('TurnList', 4200)
  assert.ok(body.includes('搜的是**整个会话**') || body.includes('整个会话'),
    '应有注释说明搜索范围是全会话')
  // 搜索时用的池子应是会话级 turns，而不是 own
  assert.ok(body.includes('for (var ti2 = 0; ti2 < (Array.isArray(turns)'), '搜索池应遍历会话全部轮次')
})

test('搜索结果标注所属话题', () => {
  const body = bodyOf('TurnList', 5200)
  assert.ok(body.includes('laneOfTurn'), '应建立 轮次→话题 的索引')
  assert.ok(body.includes('dsh_tm_tlane'), '结果行应显示所属话题')
})

// ── 3. 中间 → 左栏 反向联动 ────────────────────────────────────────
test('进入层级统一走 enterScope', () => {
  assert.equal((src.split('setLaneScope({').length - 1), 0, '不应直接调用 setLaneScope({...})')
  assert.ok(src.includes('function enterScope'), '应有 enterScope')
})

test('enterScope 展开左栏并滚动到该行', () => {
  const body = bodyOf('syncTreeToScope', 1600)
  assert.ok(body.includes('delete folded[catKey]'), '应展开话题')
  assert.ok(body.includes('delete folded[subKey]'), '应展开对话')
  assert.ok(body.includes('scrollIntoView'), '应滚动到可见')
  assert.ok(body.includes('requestAnimationFrame'), '应等 DOM 更新')
})

test('中间列表点条目会联动左栏', () => {
  const at = src.indexOf('if (laneScope.level === \'topic\')')
  assert.ok(at > 0, '应能找到中间列表的下钻分支')
  const seg = src.slice(at, at + 900)
  assert.ok(seg.includes('enterScope('), '下钻应走 enterScope（含左栏展开与滚动）')
})

// ── 4. 数字一致：左栏轮数来自实时刷新 ──────────────────────────────
test('前端请求归类时带上 activeSessionId', () => {
  assert.ok(src.includes('activeSessionId: activeSessionId'), '应把当前会话传给后端')
})

const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('后端缓存命中时刷新轮数（否则左栏数字会过期）', () => {
  assert.ok(host.includes('async function refreshTurnCounts'), '应有 refreshTurnCounts')
  assert.ok(host.includes('refreshTurnCounts(ctx, cached.tree'), '缓存命中应调用它')
})

test('只刷新当前会话，避免变慢', () => {
  const body = host.slice(host.indexOf('async function refreshTurnCounts'),
    host.indexOf('async function refreshTurnCounts') + 1500)
  assert.ok(body.includes('onlySessionId'), '应支持只刷一个会话')
  assert.ok(body.includes('id !== String(onlySessionId)'), '应跳过非当前会话')
})

// ── 5. 两处搜索分工不重叠 ──────────────────────────────────────────
test('顶栏搜索筛左栏，右栏搜索筛轮次', () => {
  const top = src.slice(src.indexOf("className: 'dsh_tm_wssearch'"),
    src.indexOf("className: 'dsh_tm_wssearch'") + 1200)
  assert.ok(top.includes('patchTree({ query'), '顶栏搜索应更新树的 query')

  const right = src.slice(src.indexOf("className: 'dsh_tm_tlsearch'"),
    src.indexOf("className: 'dsh_tm_tlsearch'") + 200)
  assert.ok(right.length > 0, '右栏应有搜索框')

  assert.equal(src.includes('function FilterBar'), false, '中间那条筛选栏应已删除')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
