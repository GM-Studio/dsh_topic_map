/**
 * 主题层测试。
 *
 * 重点是"不依赖宿主没导出的 token"：上一版用了三个宿主并不提供的
 * `--dsw-alias-*` 变量，解析为空，表现为文字没颜色、悬停无反馈。
 * 这组测试把这条教训固化下来。
 *
 * Run: node tests/theme.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  THEMES,
  THEME_STORAGE_KEY,
  detectHostTheme,
  loadThemeChoice,
  nextThemeChoice,
  resolveTheme,
  saveThemeChoice,
  themeCss,
  themeLabel,
} from '../lib/theme.js'

const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 造一个最小 document 桩。 */
function fakeDoc({ attr = null, cls = [], bg = 'rgb(255,255,255)' } = {}) {
  return {
    documentElement: {
      getAttribute: n => (n === 'data-theme' || n === 'data-color-scheme' ? attr : null),
      classList: { contains: c => cls.includes(c) },
    },
    body: { classList: { contains: () => false } },
    defaultView: { getComputedStyle: () => ({ backgroundColor: bg }) },
  }
}

console.log('\ntheme')

// ── CSS 生成 ────────────────────────────────────────────────────────
test('两套主题都生成变量', () => {
  const css = themeCss()
  assert.ok(css.includes(':root[data-tm-theme="light"]'))
  assert.ok(css.includes(':root[data-tm-theme="dark"]'))
})

test('白与黑的关键变量都有值（不是空定义）', () => {
  const css = themeCss()
  for (const v of ['--tm-bg', '--tm-surface', '--tm-text', '--tm-accent', '--tm-border']) {
    const hits = css.split(v + ':').length - 1
    assert.ok(hits >= 2, `${v} 应在两套主题里各定义一次，实际 ${hits}`)
  }
})

test('暖调：白底不是纯白，黑底不是纯黑（Claude 风格）', () => {
  const css = themeCss()
  assert.ok(!/--tm-bg:#fff\b/i.test(css), '白底不应用纯白')
  assert.ok(!/--tm-bg:#000\b/i.test(css), '黑底不应用纯黑')
  assert.ok(css.includes('#faf9f5'), '浅色底应是暖白')
  assert.ok(css.includes('#1f1e1b'), '深色底应是暖黑')
})

test('主题选择器带命名空间，不污染宿主', () => {
  const css = themeCss()
  // 所有顶层选择器都应是 :root[data-tm-theme=...]
  const roots = css.match(/^:root[^{]*\{/gm) || []
  assert.ok(roots.length >= 2)
  for (const r of roots) {
    assert.ok(r.includes('data-tm-theme'), `选择器未加命名空间：${r}`)
  }
})

// ── 不存在的 token（上一版的坑）────────────────────────────────────
test('client.js 不再引用宿主未导出的 token', () => {
  // 宿主 Token 列表里没有这三个
  const banned = [
    '--dsw-alias-label-tertiary',
    '--dsw-alias-interactive-bg-hover',
    '--dsw-alias-button-info-fill',
  ]
  for (const t of banned) {
    assert.ok(!clientSrc.includes(t), `不应再使用不存在的 token：${t}`)
  }
})

test('client.js 使用自己的主题变量', () => {
  const used = new Set(clientSrc.match(/--tm-[a-z0-9-]+/g) || [])
  assert.ok(used.size >= 8, `应大量使用自有变量，实际 ${used.size} 种`)
  assert.ok(used.has('--tm-text') && used.has('--tm-bg'))
})

// ── 明暗探测 ────────────────────────────────────────────────────────
test('从 data-theme 探测', () => {
  assert.equal(detectHostTheme(fakeDoc({ attr: 'dark' })), 'dark')
  assert.equal(detectHostTheme(fakeDoc({ attr: 'light' })), 'light')
})

test('从 class="dark" 探测', () => {
  assert.equal(detectHostTheme(fakeDoc({ cls: ['dark'] })), 'dark')
})

test('从背景亮度兜底', () => {
  assert.equal(detectHostTheme(fakeDoc({ bg: 'rgb(20,20,20)' })), 'dark')
  assert.equal(detectHostTheme(fakeDoc({ bg: 'rgb(245,245,240)' })), 'light')
})

test('没有 document 时按浅色（安全默认）', () => {
  assert.equal(detectHostTheme(undefined), 'light')
  assert.equal(detectHostTheme(null), 'light')
})

test('解析：显式选择优先于宿主', () => {
  const doc = fakeDoc({ attr: 'dark' })
  assert.equal(resolveTheme('light', doc), 'light', '用户选浅色就该浅色')
  assert.equal(resolveTheme('dark', doc), 'dark')
})

test('解析：auto 跟随宿主', () => {
  assert.equal(resolveTheme('auto', fakeDoc({ attr: 'dark' })), 'dark')
  assert.equal(resolveTheme('auto', fakeDoc({ attr: 'light' })), 'light')
})

// ── 选择持久化 ──────────────────────────────────────────────────────
test('默认是 auto', () => {
  const store = { getItem: () => null }
  assert.equal(loadThemeChoice(store), 'auto')
})

test('保存后能读回', () => {
  const map = new Map()
  const store = {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  }
  saveThemeChoice(store, 'dark')
  assert.equal(map.get(THEME_STORAGE_KEY), 'dark')
  assert.equal(loadThemeChoice(store), 'dark')
})

test('非法值退回 auto', () => {
  const store = { getItem: () => 'purple' }
  assert.equal(loadThemeChoice(store), 'auto')
})

test('存储不可用时不抛异常', () => {
  const broken = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') } }
  assert.equal(loadThemeChoice(broken), 'auto')
  saveThemeChoice(broken, 'dark')  // 不应抛
})

test('没有 storage 时也能工作', () => {
  assert.equal(loadThemeChoice(undefined), 'auto')
  saveThemeChoice(undefined, 'dark')
})

// ── 切换顺序 ────────────────────────────────────────────────────────
test('切换顺序 auto → light → dark → auto', () => {
  assert.equal(nextThemeChoice('auto'), 'light')
  assert.equal(nextThemeChoice('light'), 'dark')
  assert.equal(nextThemeChoice('dark'), 'auto')
})

test('未知值回到 auto（不跳到 light，避免意外改变用户看到的样子）', () => {
  assert.equal(nextThemeChoice('xxx'), 'auto')
})

// ── 按钮文案 ────────────────────────────────────────────────────────
test('按钮图标随选择与实际明暗变化', () => {
  assert.equal(themeLabel('light', 'light').icon, '☀')
  assert.equal(themeLabel('dark', 'dark').icon, '☾')
  // auto 时图标反映实际明暗
  assert.equal(themeLabel('auto', 'dark').icon, '◐')
  assert.equal(themeLabel('auto', 'light').icon, '◑')
})

test('按钮提示文字都说明了下一步动作', () => {
  for (const c of ['auto', 'light', 'dark']) {
    const t = themeLabel(c, 'light').title
    assert.ok(t.includes('点击'), `${c} 的提示应说明点击后做什么：${t}`)
  }
})

test('THEMES 常量完整', () => {
  assert.deepEqual(THEMES, ['auto', 'light', 'dark'])
})

// ── 布局锁定（第 1 条需求的回归）─────────────────────────────────────
test('根容器不再用固定 min-height 撑高面板', () => {
  const rootRule = clientSrc.match(/\.dsh_tm_root\{[^}]*\}/)
  assert.ok(rootRule !== null, '应存在 .dsh_tm_root 规则')
  assert.ok(!/min-height:\s*\d+px/.test(rootRule[0]),
    `根容器不应有固定像素 min-height（会把面板撑出视口）：${rootRule[0]}`)
  assert.ok(/min-height:\s*0/.test(rootRule[0]), '应显式 min-height:0')
  assert.ok(/max-height:\s*100%/.test(rootRule[0]), '应限制最大高度')
})

test('画布与三栏都不会撑高外层', () => {
  const canvas = clientSrc.match(/\.dsh_tm_canvas\{[^}]*\}/)
  assert.ok(canvas !== null)
  assert.ok(/flex:\s*1 1 0/.test(canvas[0]), '画布应固定占剩余空间')
  assert.ok(/overflow:\s*hidden/.test(canvas[0]), '画布应裁剪溢出')

  const body = clientSrc.match(/\.dsh_tm_body\{[^}]*\}/)
  assert.ok(body !== null)
  assert.ok(/min-height:\s*0/.test(body[0]), 'body 需要 min-height:0 才能正确收缩')
  assert.ok(/overflow:\s*hidden/.test(body[0]), 'body 应裁剪溢出')
})

test('左右两栏各自滚动，互不影响', () => {
  const side = clientSrc.match(/\.dsh_tm_side\{[^}]*\}/)
  const detail = clientSrc.match(/\.dsh_tm_detail\{[^}]*\}/)
  assert.ok(side !== null && detail !== null)
  // 两栏外层都是 overflow:hidden（自己内部再滚）
  assert.ok(/overflow:\s*hidden/.test(side[0]))
  assert.ok(/overflow:\s*hidden/.test(detail[0]))
  assert.ok(/min-height:\s*0/.test(detail[0]), '详情栏需要 min-height:0')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
