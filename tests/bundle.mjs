/**
 * bundle 完整性测试：嵌入模块的导出必须覆盖客户端的全部使用。
 *
 * 这条测试是为了一次真实事故加的：客户端调用了 `PM.inferFromEvidence`，
 * 而生成脚本的导出清单里漏了它，于是运行时抛 TypeError、面板白屏——
 * 但所有既有单元测试全绿，因为它们测的是 lib/ 源码，不是 bundle。
 *
 * 教训：**单元测试通过 ≠ 插件能跑**。bundle 的符号完整性必须单独验证。
 *
 * Run: node tests/bundle.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

function moduleBlock(name) {
  const re = new RegExp(`var ${name} = \\(function \\(\\)[\\s\\S]*?\\n    \\}\\)\\(\\)`)
  const m = src.match(re)
  return m === null ? null : m[0]
}
function exportedNames(block) {
  if (block === null) return []
  const ret = block.lastIndexOf('return {')
  if (ret < 0) return []
  const end = block.indexOf('}', ret)
  return [...block.slice(ret + 7, end).matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map(m => m[1])
}
function usedNames(prefix) {
  const re = new RegExp(`\\b${prefix}\\.([A-Za-z_$][\\w$]*)`, 'g')
  return [...new Set([...src.matchAll(re)].map(m => m[1]))]
}

console.log('\nbundle')

// ── 四个嵌入模块 ────────────────────────────────────────────────────
for (const name of ['THEME', 'FILTER', 'PM', 'UISTATE', 'FOLD', 'DELIV', 'REPORT', 'GMODE']) {
  test(`${name} 的导出覆盖客户端的全部使用`, () => {
    const block = moduleBlock(name)
    assert.ok(block !== null, `bundle 里找不到 ${name}，生成段缺失`)
    const exported = exportedNames(block)
    const used = usedNames(name)
    const missing = used.filter(u => !exported.includes(u))
    assert.deepEqual(missing, [],
      `${name} 缺少导出：${missing.join(', ')}（运行时会白屏）`)
  })
}

// ── 生成段完整存在 ──────────────────────────────────────────────────
test('四个生成段都在 bundle 里', () => {
  for (const marker of [
    '从 lib/viewport.js',
    '从 lib/theme.js',
    '从 lib/filter.js',
    '从 lib/pm-model.js',
    '从 lib/ui-state.js',
  ]) {
    assert.ok(src.includes(marker), `缺少生成段：${marker}`)
  }
})

test('每个生成段都有结束标记（避免替换时吞掉后续代码）', () => {
  const starts = (src.match(/以下由 scripts\/build-/g) || []).length
  const ends = (src.match(/生成段结束 ══/g) || []).length
  assert.equal(starts, ends, `开始标记 ${starts} 与结束标记 ${ends} 不匹配`)
})

// ── 客户端语法可解析 ────────────────────────────────────────────────
test('bundle 是合法 JavaScript', () => {
  // 用 node --check 验证，比正则可靠
  execFileSync(process.execPath, ['--check', join(root, 'lib', 'client.js')], { stdio: 'pipe' })
})

// ── 构建脚本本身的行为 ──────────────────────────────────────────────
test('verify-bundle 脚本存在且通过', () => {
  const out = execFileSync(process.execPath, [join(root, 'scripts', 'verify-bundle.mjs')], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
  assert.ok(out.includes('导出都完整'), `verify-bundle 未通过：${out}`)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
