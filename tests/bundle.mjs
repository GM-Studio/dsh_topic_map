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

// ── 嵌入模块 ────────────────────────────────────────────────────────
for (const name of ['THEME', 'FILTER', 'PM', 'UISTATE', 'FOLD', 'DELIV', 'REPORT', 'GMODE', 'SCAT', 'HITVIEW', 'CITE', 'RAILVIEW', 'STATSFMT', 'SETTINGVIEW', 'CLUEVIEW', 'CHANGESVIEW', 'ROLLBACKPLAN']) {
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
test('所有生成段都在 bundle 里', () => {
  for (const marker of [
    '从 lib/viewport.js',
    '从 lib/theme.js',
    '从 lib/filter.js',
    '从 lib/pm-model.js',
    '从 lib/ui-state.js',
    '从 lib/tree-fold.js',
    '从 lib/deliverables.js',
    '从 lib/report.js',
    '从 lib/graph-mode.js',
    '从 lib/session-category.js',
    '从 lib/hit-view.js',
    '从 lib/cite.js',
    '从 lib/rail-view.js',
    '从 lib/stats-format.js',
    '从 lib/settings-view.js',
    '从 lib/clue-view.js',
    '从 lib/changes-view.js',
    '从 lib/rollback-plan.js',
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

// ── 嵌入模块的真实可执行性（防白屏）────────────────────────────────
//
// 符号存在 ≠ 能跑。SCAT 依赖 model-output 的抽取函数，而 client.js 没有
// import——构建脚本会把 import 删掉，所以必须把 model-output 的源码嵌进
// 同一个 IIFE。少嵌一次就是运行时 "xxx is not defined" + 面板白屏，
// 而所有单元测试仍然是绿的（它们测 lib/ 源码）。
//
// 所以这里不只查符号，而是**真的执行**嵌入段并调用它的函数。

/** 抽出嵌入段并真实执行，返回它的导出对象。 */
function evalEmbedded(name) {
  const block = moduleBlock(name)
  assert.ok(block !== null, `client.js 里找不到 ${name} 段`)
  const module = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', `${block}\n;module.exports = ${name};`)(module, module.exports)
  return module.exports
}

test('SCAT 嵌入后能真实执行（依赖的抽取函数在同作用域内）', () => {
  const SCAT = evalEmbedded('SCAT')
  assert.equal(typeof SCAT.extractJsonArrayOfLength, 'function',
    'SCAT 必须能访问 model-output 的抽取函数，否则运行时白屏')
  assert.deepEqual(
    SCAT.extractJsonArrayOfLength('我先分 [草稿]，答案：["a","b"]', 2),
    ['a', 'b'],
    '嵌入后的抽取逻辑应真实可用',
  )
})

test('SCAT 的会话识别能真实执行', () => {
  const SCAT = evalEmbedded('SCAT')
  assert.equal(SCAT.looksAutomated({ title: '[dsh-mnemon:delegated review]', firstPrompt: '' }), true)
})

test('GMODE 嵌入后能真实执行', () => {
  const GMODE = evalEmbedded('GMODE')
  assert.ok(GMODE.statusColor('done', 0, 'light').includes('hsl('))
})

test('CITE 嵌入后能真实执行（引用块与预算）', () => {
  const CITE = evalEmbedded('CITE')
  const built = CITE.buildCite({
    topic: '插件开发', title: '索引方案', turn: 7, sessionId: 'sess-1',
    intent: '把索引做出来', points: ['先用倒排', '再补中文分词'],
  })
  assert.ok(built.text.includes('出处：session/sess-1#7'))
  assert.ok(built.tokens > 0)
  assert.deepEqual(CITE.parseCite(built.text), {
    sessionId: 'sess-1', turn: 7, header: '〔引用〕插件开发 › 索引方案 · 第 7 轮',
  })
})

// ── V-12 起：三个模块由 build-theme 正式嵌入 ─────────────────────────
//
// 手工同步是白屏的温床（改了 lib 忘了改 client）。现在 rail-view /
// stats-format / settings-view 都走 scripts/build-theme.mjs，这里仍然做
// **逐字节**校验：嵌入段必须等于源文件按同一规则去掉模块声明后的原文。

/** 与 scripts/build-theme.mjs 的 strip + indent 完全同规则。 */
function builtBody(file) {
  const source = readFileSync(join(root, 'lib', file), 'utf8')
  const stripped = source
    .replace(/^\/\*\*[\s\S]*?\*\/\s*/m, '')
    .replace(/^export const /gm, 'var ')
    .replace(/^export function /gm, 'function ')
    .replace(/^import .*$/gm, '')
    .replace(/\s+$/, '')
  return stripped.split('\n').map(line => (line === '' ? '' : '  ' + line)).join('\n')
}

for (const [name, file] of [
  ['RAILVIEW', 'rail-view.js'],
  ['STATSFMT', 'stats-format.js'],
  ['SETTINGVIEW', 'settings-view.js'],
  ['CLUEVIEW', 'clue-view.js'],
  ['CHANGESVIEW', 'changes-view.js'],
  ['ROLLBACKPLAN', 'rollback-plan.js'],
]) {
  test(`${name} 嵌入段与 lib/${file} 逐字节一致`, () => {
    const block = moduleBlock(name)
    assert.ok(block !== null, `client.js 里找不到 ${name} 嵌入段`)
    assert.ok(block.includes(builtBody(file)),
      `嵌入段与源码不一致：改 lib/${file} 后必须运行 node scripts/build-theme.mjs`)
  })
}

test('RAILVIEW 嵌入后能真实执行，且导出覆盖接管层的全部 view.* 调用', () => {
  const RAILVIEW = evalEmbedded('RAILVIEW')
  for (const name of ['tierOf', 'snapWidth', 'turnOfLabel', 'rowsOf', 'activeIndexOf', 'anchorFor', 'selfCheck']) {
    assert.equal(typeof RAILVIEW[name], 'function', `RAILVIEW.${name} 必须是函数，否则运行时白屏`)
  }
  assert.equal(RAILVIEW.TIER_WIDTHS.hair, 40)
  assert.equal(RAILVIEW.tierOf(40), 'hair')
  assert.deepEqual(
    RAILVIEW.rowsOf([{ dataIndex: '0', ariaLabel: '跳转到第 7 轮' }]).map(row => row.turn),
    [7],
    '嵌入后的解析逻辑应真实可用',
  )

  // 接管层只用 `view.xxx` 访问嵌入模块；清单漏一个就是运行时 TypeError。
  const start = src.indexOf('var RAILTAKE = (function ()')
  assert.ok(start >= 0, '找不到 RAILTAKE 段')
  const end = src.indexOf('\n    })()', start)
  assert.ok(end >= 0, 'RAILTAKE 段没有闭合')
  const takeover = src.slice(start, end)
  const used = [...new Set([...takeover.matchAll(/\bview\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]))]
  assert.ok(used.length > 0, '接管层没有调用 view.*？')
  for (const name of used) {
    assert.ok(name in RAILVIEW, `接管层用到 view.${name}，但 RAILVIEW 没有导出`)
  }
})

test('STATSFMT 嵌入后能真实执行（头条 / 行 / 用量拆分）', () => {
  const STATSFMT = evalEmbedded('STATSFMT')
  const headline = STATSFMT.statsHeadline({
    totals: {
      sessions: 3, turns: 12, activeDays: 2,
      tokens: { input: 1500, output: 500, total: 2000 },
    },
  })
  assert.equal(headline.length, 4)
  assert.equal(headline[0].value, '3')
  assert.equal(headline[3].value, '2k tokens')
  const rows = STATSFMT.statsRows(
    [{ title: 'A', turns: 4 }, { title: 'B', turns: 2 }],
    { now: 1_700_000_060_000 },
  )
  assert.deepEqual(rows.map(row => row.barPercent), [100, 50])
  assert.equal(STATSFMT.usageSplit({ input: 30, output: 10 }).ratio, 0.25)
})

test('SETTINGVIEW 嵌入后能真实执行（模型 / 校验 / 差异）', () => {
  const SETTINGVIEW = evalEmbedded('SETTINGVIEW')
  const model = SETTINGVIEW.settingsModel({ turnLimit: 80, digestLevel: 'rich' })
  const turnLimit = model.groups.flatMap(group => group.items).find(item => item.key === 'turnLimit')
  assert.equal(turnLimit.value, 80)
  const applied = SETTINGVIEW.applySetting({ turnLimit: 80 }, 'turnLimit', 120)
  assert.equal(applied.config.turnLimit, 120)
  assert.ok(SETTINGVIEW.applySetting({}, 'turnLimit', 1).error.includes('5–500'))
  assert.deepEqual(
    SETTINGVIEW.diffConfig({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 }),
    { b: 3, c: 4 },
  )
})

test('CLUEVIEW 嵌入后能真实执行（时间线聚类 / 统计 / 空态）', () => {
  const CLUEVIEW = evalEmbedded('CLUEVIEW')
  const built = CLUEVIEW.buildClue([
    { sessionId: 's1', sessionTitle: '会话 A', turn: 1, time: 1_700_000_000_000, promptHead: '第一次提索引' },
    { sessionId: 's1', sessionTitle: '会话 A', turn: 2, time: 1_700_000_060_000, promptHead: '同一天又提索引' },
    { sessionId: 's2', sessionTitle: '会话 B', turn: 5, time: 1_700_200_000_000, promptHead: '另一个会话' },
  ], { keywords: '索引', now: 1_700_300_000_000 })
  assert.equal(built.empty, false)
  assert.equal(built.timeline.length, 2)
  assert.equal(built.timeline[0].delta, '首次提及')
  assert.equal(built.timeline[0].count, 2)
  assert.deepEqual(built.stats.sessions, 2)
  assert.deepEqual(built.stats.turns, 3)
  assert.equal(built.stats.spanDays, 2)
  assert.equal(CLUEVIEW.buildClue([], { keywords: '' }).empty, true)
})

test('CHANGESVIEW 嵌入后能真实执行（分组 / ±行 / lost）', () => {
  const CHANGESVIEW = evalEmbedded('CHANGESVIEW')
  const view = CHANGESVIEW.buildChanges({
    changes: {
      files: [
        { path: 'lib/a.js', added: 3, deleted: 1 },
        { path: 'README.md', added: 2, deleted: 0 },
        { path: 'package.json', added: 1, deleted: 1 },
        { path: 'icon.svg', added: 0, deleted: 4 },
      ],
    },
  })
  assert.equal(view.files.length, 4)
  assert.deepEqual(view.totals, { files: 4, added: 6, deleted: 6 })
  assert.deepEqual(
    CHANGESVIEW.groupByKind(view.files).map(group => group.kind),
    ['code', 'doc', 'config', 'other'],
  )
  assert.deepEqual(
    CHANGESVIEW.sortChanges(view.files, 'size').map(file => file.path),
    ['icon.svg', 'lib/a.js', 'package.json', 'README.md'],
  )
  const lost = CHANGESVIEW.buildChanges({ changes: { lost: true } })
  assert.equal(lost.lost, true)
  assert.equal(lost.summary, '该轮变更明细已不可读')
})

test('ROLLBACKPLAN 嵌入后能真实执行（四态 / 文本）', () => {
  const ROLLBACKPLAN = evalEmbedded('ROLLBACKPLAN')
  const preview = ROLLBACKPLAN.planRollback(
    [
      { path: 'a.js', added: 2, deleted: 0, hash: 'aaa' },
      { path: 'b.js', added: 1, deleted: 1, beforeHash: 'same' },
      { path: 'c.js', added: 2, deleted: 2, hash: 'expected' },
      { path: 'd.js', added: 1, deleted: 0, hash: 'x' },
    ],
    { 'a.js': 'aaa', 'b.js': 'same', 'c.js': 'changed', 'd.js': null },
  )
  assert.deepEqual(preview.counts, { apply: 1, same: 1, modified: 1, missing: 1 })
  const text = ROLLBACKPLAN.formatPlan(preview.plan)
  assert.ok(text.includes('✓ 可回滚  a.js'))
  assert.ok(text.includes('⚠ 已被修改  c.js'))
})

test('接管层已接进 apply（不是写完忘了挂）', () => {
  assert.ok(src.includes("dsh-topic-map: 历史轨接管"), 'apply 里没有启动历史轨接管')
  assert.ok(src.includes('RAILTAKE.start({'), 'apply 里没有调用 RAILTAKE.start')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
