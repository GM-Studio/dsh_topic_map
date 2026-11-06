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

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
