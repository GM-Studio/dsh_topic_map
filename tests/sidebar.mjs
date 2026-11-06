/**
 * 左栏一致性回归测试。
 *
 * 这里锁定的都是"实际出过错"的问题：
 *   1. 颜色变量未定义 → 第 4、5 个大类色条透明
 *   2. 子类点击的 var 闭包陷阱 → 所有对话回调都指向最后一个
 *   3. 三级缩进/字号必须递进，不能平级
 *   4. 右栏在列表视图下必须切换，不能挂着旧会话
 *
 * Run: node tests/sidebar.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nsidebar')

// ── 1. CSS 变量必须都有定义 ─────────────────────────────────────────
test('所有引用的 --tm-* 变量都已定义', () => {
  const defined = new Set()
  for (const m of src.matchAll(/--tm-([a-z0-9-]+):/g)) defined.add(m[1])
  const used = new Set()
  for (const m of src.matchAll(/var\(--tm-([a-z0-9-]+)\)/g)) used.add(m[1])
  const missing = [...used].filter(v => !defined.has(v))
  assert.deepEqual(missing, [],
    `未定义的变量会让对应元素透明/无色：${missing.join(', ')}`)
})

test('分类色板用到的颜色变量都存在', () => {
  // 色板里有 purple / info，这两个曾经漏定义
  for (const name of ['accent', 'ok', 'warn', 'purple', 'info', 'err']) {
    assert.ok(src.includes(`--tm-${name}:`), `--tm-${name} 应有定义`)
  }
})

// ── 2. 子类点击不能有 var 闭包陷阱 ──────────────────────────────────
test('子类按钮的点击回调被 IIFE 隔离（避免所有回调指向最后一个）', () => {
  // 特征：subBlocks.push((function (curSub, curKey, ...) { ... })(sub, subKey, ...))
  assert.ok(src.includes('subBlocks.push((function (curSub, curKey, curList, curOpen, curColor)'),
    '子类渲染应包在 IIFE 里，把当次循环值固定下来')
  assert.ok(src.includes('})(sub, subKey, list, subOpen, color))'),
    'IIFE 应传入当次的 sub/subKey/list/subOpen/color')
})

test('子类回调里用的是隔离后的参数，不是外层 var', () => {
  // 回调体内应引用 curSub 而不是 sub
  const body = src.slice(
    src.indexOf('subBlocks.push((function (curSub'),
    src.indexOf('})(sub, subKey, list, subOpen, color))'),
  )
  assert.ok(body.includes('curSub.name'), '回调应使用 curSub.name')
  assert.ok(!/onScope\(\{[\s\S]*?name:\s*sub\.name/.test(body), '不应再直接引用外层 sub.name')
})

// ── 3. 三级缩进与字号递进 ──────────────────────────────────────────
test('三级缩进逐级加深（话题 < 对话 < 会话）', () => {
  const padOf = (cls) => {
    const m = src.match(new RegExp('\\.' + cls + '\\{[^}]*padding:(\\d+)px \\d+px(?: (\\d+)px)?(?: (\\d+)px)?'))
    if (m === null) return null
    // padding: A B 或 padding: A B C D
    return m[3] !== undefined ? Number(m[3]) : Number(m[2] ?? m[1])
  }
  const cat = padOf('dsh_tm_ccathd')
  const sub = padOf('dsh_tm_csubhd')
  const conv = padOf('dsh_tm_cconv')
  assert.ok(cat !== null && sub !== null && conv !== null, '三级样式都应存在')
  assert.ok(sub > cat, `对话缩进 ${sub} 应大于话题 ${cat}`)
  assert.ok(conv > sub, `会话缩进 ${conv} 应大于对话 ${sub}`)
})

test('三级字号递进（话题 > 对话 > 会话）', () => {
  const sizeOf = (cls) => {
    const m = src.match(new RegExp('\\.' + cls + '\\{[^}]*font-size:([\\d.]+)px'))
    return m === null ? null : Number(m[1])
  }
  const cat = sizeOf('dsh_tm_ccathd')
  const sub = sizeOf('dsh_tm_csubhd')
  const conv = sizeOf('dsh_tm_cconv')
  assert.ok(cat !== null && sub !== null && conv !== null)
  assert.ok(cat > sub, `话题字号 ${cat} 应大于对话 ${sub}`)
  assert.ok(sub > conv, `对话字号 ${sub} 应大于会话 ${conv}`)
})

test('三级都有各自的计算色标记', () => {
  assert.ok(src.includes("className: 'dsh_tm_ccatbar'"), '话题：色条')
  assert.ok(src.includes("className: 'dsh_tm_csubbar'"), '对话：短竖线')
  assert.ok(src.includes("className: 'dsh_tm_cdot'"), '会话：圆点')
  // 三者都用同一个话题色（color / curColor）
  assert.ok(src.includes("style: { background: color }"), '话题色条用话题色')
  assert.ok(src.includes("style: { background: curColor }"), '对话竖线与会话圆点继承话题色')
})

// ── 4. 右侧在列表视图下必须切换 ────────────────────────────────────
test('列表视图下右栏不再显示旧会话轮次', () => {
  // 右栏渲染应判断 laneScope
  const idx = src.indexOf('右栏：三种情况')
  assert.ok(idx > 0, '右栏应有关于三种情况的注释')
  const seg = src.slice(idx, idx + 900)
  assert.ok(seg.includes('laneScope !== null'), '右栏应判断 laneScope')
  assert.ok(seg.includes('dsh_tm_lvsummary'), '列表视图下右栏应显示层级范围说明')
})

// ── 5. 全折/全展按钮存在 ────────────────────────────────────────────
test('左栏有全部展开与全部折叠按钮', () => {
  assert.ok(src.includes("title: '全部展开'"), '应有全部展开')
  assert.ok(src.includes("title: '全部折叠'"), '应有全部折叠')
  assert.ok(src.includes("foldAll(false)"), '展开应调 foldAll(false)')
  assert.ok(src.includes("foldAll(true)"), '折叠应调 foldAll(true)')
})

test('折叠状态按工作区持久化', () => {
  assert.ok(src.includes("'dsh-topic-map:treefold:'"), '折叠状态应存 sessionStorage')
  assert.ok(src.includes('persistTreeFold'), '应有持久化函数')
})

// ── 6. 中间 → 左栏 的反向联动 ───────────────────────────────────────
test('进入层级统一走 enterScope（不能直接 setLaneScope）', () => {
  // enterScope 会同时展开左栏并滚动到该行。
  // 直接 setLaneScope 就会漏掉联动，导致"中间变了、左栏没动"。
  const direct = (src.split('setLaneScope({').length - 1)
  assert.equal(direct, 0, '不应再有直接 setLaneScope({...}) 的调用，应改用 enterScope')
  assert.ok(src.includes('function enterScope'), '应有 enterScope 函数')
})

test('enterScope 会展开左栏对应分区', () => {
  assert.ok(src.includes('function syncTreeToScope'), '应有 syncTreeToScope')
  const body = src.slice(src.indexOf('function syncTreeToScope'), src.indexOf('function enterScope'))
  assert.ok(body.includes("'cat:' + topicName"), '应构造话题折叠键')
  assert.ok(body.includes("':sub:' + dialogName"), '应构造对话折叠键')
  assert.ok(body.includes('delete folded[catKey]'), '应展开话题')
  assert.ok(body.includes('delete folded[subKey]'), '应展开对话')
})

test('enterScope 会滚动到对应的左栏行', () => {
  const body = src.slice(src.indexOf('function syncTreeToScope'), src.indexOf('function enterScope'))
  assert.ok(body.includes('scrollIntoView'), '应调用 scrollIntoView')
  assert.ok(body.includes('requestAnimationFrame'), '应等 DOM 更新后再滚')
})

test('对话层级下父话题也高亮', () => {
  // 从 crumbs 里找父话题，这样进入对话后左栏的话题行也亮着
  const seg = src.slice(src.indexOf('高亮当前层级'), src.indexOf('高亮当前层级') + 900)
  assert.ok(seg.includes('crumbs'), '话题高亮应检查 crumbs')
  assert.ok(seg.includes("crumbs[ci2].level === 'topic'"), '应从 crumbs 找父话题')
})

// ── 7. 两个搜索框的分工 ─────────────────────────────────────────────
test('中间筛选条已删除（只留顶栏与右栏两个搜索）', () => {
  assert.equal(src.includes('function FilterBar'), false, 'FilterBar 组件应已删除')
  assert.equal(src.includes('h(FilterBar'), false, 'FilterBar 不应再被挂载')
  // 已失效的筛选维度也不该残留
  assert.equal(src.includes('stageOptions'), false, '阶段筛选已失效，应删除')
  assert.equal(src.includes('toggleInList'), false, '多选切换只服务于旧筛选条，应删除')
})

test('顶栏搜索仍只筛左栏（跨会话）', () => {
  assert.ok(src.includes("className: 'dsh_tm_wssearch'"), '顶栏应有工作区搜索框')
  // 顶栏搜索的 onChange 应该更新左栏树的 query，而不是筛当前会话轮次
  const idx = src.indexOf("className: 'dsh_tm_wssearch'")
  const seg = src.slice(idx, idx + 1200)
  assert.ok(seg.includes('patchTree({ query'), '顶栏搜索应更新左栏树的 query')
})

test('右栏有会话内搜索，且只筛轮次', () => {
  assert.ok(src.includes("className: 'dsh_tm_tlsearch'"), '右栏应有搜索框容器')
  assert.ok(src.includes("placeholder: '搜本会话轮次…'"), '右栏搜索的占位文案应说明只搜本会话')
  // 过滤逻辑：匹配 prompt 或 response
  const seg = src.slice(src.indexOf('搜索过滤：匹配提问或回复内容'), src.indexOf('搜索过滤：匹配提问或回复内容') + 1600)
  assert.ok(seg.includes('f.prompt'), '应匹配提问')
  assert.ok(seg.includes('f.response'), '应匹配回复')
})

test('右栏搜索匹配数会显示出来', () => {
  assert.ok(src.includes('dsh_tm_tlbhit'), '应有匹配计数徽章')
})

// ── 8. 左栏数字：对话层显示「N 段 · M 轮」────────────────────────
test('对话层显示段数与轮数，而不是会话数', () => {
  assert.ok(src.includes("sumSegs + ' 段 · ' + sumTurns + ' 轮'"), '应拼出「N 段 · M 轮」')
  // 段数来自 laneCount，当前会话用实时值纠正
  assert.ok(src.includes('sess.laneCount'), '应读会话的 laneCount')
  assert.ok(src.includes('liveLaneCount'), '当前会话应使用实时段数纠正')
})

test('一级话题仍显示会话数（不改成段数）', () => {
  const seg = src.slice(src.indexOf("className: 'dsh_tm_ccatn'"), src.indexOf("className: 'dsh_tm_ccatn'") + 120)
  assert.ok(seg.includes('shown'), '话题层应显示会话数 shown')
})

// ── 9. 右栏顶部：归属路径取代「未分类」──────────────────────────
test('右栏顶部显示归属路径，不再读已删除的阶段名', () => {
  const at = src.indexOf("className: 'dsh_tm_tlpath'")
  assert.ok(at > 0, '应能找到路径元素')
  const seg = src.slice(at, at + 300)
  assert.ok(seg.includes('ownerPath'), '应读 ownerPath')
  assert.equal(seg.includes('stageName'), false, '不应再读 stageName（阶段系统已删，只会永远显示未分类）')
})

test('ownerPathOf 从归类树里查话题›对话', () => {
  assert.ok(src.includes('function ownerPathOf'), '应有 ownerPathOf')
  const body = src.slice(src.indexOf('function ownerPathOf'), src.indexOf('function ownerPathOf') + 1200)
  assert.ok(body.includes("tree[i].name + ' › ' + subs[j].name"), '应拼出 话题 › 对话')
})

// ── 10. 后端：段数透传与降级保护 ────────────────────────────────
test('归类时计算每条会话的段数', () => {
  assert.ok(host.includes('assignLanes({ turns: facts'), '应用 assignLanes 算段数')
  assert.ok(host.includes('laneCount,'), '应把 laneCount 带进 raw')
})

test('段数一路透传到归类树（提炼阶段不能丢）', () => {
  const digest = readFileSync(new URL('../lib/session-digest.js', import.meta.url), 'utf8')
  assert.ok(digest.includes('laneCount'), 'prepareDigestInput 应保留 laneCount')
  const toCat = digest.slice(digest.indexOf('export function toCategoryInput'),
    digest.indexOf('export function toCategoryInput') + 700)
  assert.ok(toCat.includes('laneCount'), 'toCategoryInput 必须透传 laneCount（漏了会导致段数全是 0）')
})

test('模型全失败时不覆盖好缓存', () => {
  assert.ok(host.includes('allFailed'), '应有降级判定')
  assert.ok(host.includes('if (!allFailed)'), '降级时不应写缓存')
})

test('LLM 调用用 prepared.config 派发', () => {
  const llm = readFileSync(new URL('../lib/llm-call.js', import.meta.url), 'utf8')
  assert.ok(llm.includes('prepared.config'), '应用准备后的配置派发（否则报 config changed）')
  assert.ok(llm.includes('reasoningEffort'), '应请求低推理强度（带推理模型会把预算吃光）')
  assert.ok(llm.includes('模型没有输出正文'), '空正文应显式报错，便于定位')
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
