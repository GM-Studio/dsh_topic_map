/**
 * 回滚预演模型测试（P3-2 / A-12）。
 *
 * 纯函数：不读磁盘、不读时钟、不 import；currentHashes 由调用方算好传进来。
 *
 * Run: node tests/rollback-plan.mjs
 */

import { strict as assert } from 'node:assert'
import { formatPlan, planRollback } from '../lib/rollback-plan.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 一条待回滚文件。 */
function fileOf(path, added = 1, deleted = 1, hash = 'h1') {
  return { path, added, deleted, hash }
}

/** 空 counts 的固定形状。 */
const EMPTY_COUNTS = { apply: 0, same: 0, modified: 0, missing: 0 }

console.log('\nrollback-plan')

// ── 空态 ────────────────────────────────────────────────────────────
test('空输入：空计划、空计数、固定文案', () => {
  for (const files of [undefined, null, [], 'x', {}]) {
    const result = planRollback(files, {})
    assert.deepEqual(result, {
      plan: [],
      summary: '没有可回滚的文件',
      counts: EMPTY_COUNTS,
    })
  }
})

// ── 四种 state ──────────────────────────────────────────────────────
test('apply：当前哈希与快照哈希一致 → 可回滚', () => {
  const result = planRollback([fileOf('lib/client.js', 40, 5, 'ABC')], {
    'lib/client.js': 'abc',
  })
  assert.deepEqual(result.plan, [{
    path: 'lib/client.js',
    added: 40,
    deleted: 5,
    hash: 'abc',
    currentHash: 'abc',
    state: 'apply',
    reason: '文件内容与快照一致，可安全回滚',
  }])
  assert.deepEqual(result.counts, { apply: 1, same: 0, modified: 0, missing: 0 })
  assert.equal(result.summary, '1 个可回滚')
})

test('same：没有行变更 → 无需回滚（优先于 apply / 无 hash）', () => {
  const result = planRollback([
    fileOf('README.md', 0, 0, 'h1'),
    { path: 'docs/notes.txt', added: 0, deleted: 0 },
    { path: 'docs/mismatch.txt', added: 0, deleted: 0, hash: 'h1' },
  ], {
    'README.md': 'h1',
    'docs/notes.txt': 'whatever',
    'docs/mismatch.txt': 'h2',
  })
  assert.deepEqual(result.plan.map(item => item.state), ['same', 'same', 'same'])
  assert.equal(result.plan[0].reason, '内容未变，无需回滚')
  assert.deepEqual(result.counts, { apply: 0, same: 3, modified: 0, missing: 0 })
  assert.equal(result.summary, '3 个无需回滚')
})

test('modified：磁盘内容已在变更后被改动 → 需人工确认', () => {
  const result = planRollback([fileOf('lib/index.js', 12, 3, 'h1')], {
    'lib/index.js': 'h2',
  })
  assert.equal(result.plan[0].state, 'modified')
  assert.equal(result.plan[0].currentHash, 'h2')
  assert.equal(result.plan[0].reason, '文件在变更后已被修改，需人工确认')
  assert.deepEqual(result.counts, { apply: 0, same: 0, modified: 1, missing: 0 })
  assert.equal(result.summary, '1 个已被修改')
})

test('missing：null / 缺键 / 非字符串都算磁盘上已不存在', () => {
  const result = planRollback([
    fileOf('a.js'),
    fileOf('b.js'),
    fileOf('c.js'),
    fileOf('d.js'),
    fileOf('e.js'),
  ], {
    'a.js': null,
    'b.js': undefined,
    'c.js': '',
    'd.js': 42,
    'e.js': {},
  })
  assert.deepEqual(result.plan.map(item => item.state), ['missing', 'missing', 'missing', 'missing', 'missing'])
  assert.deepEqual(result.plan.map(item => item.currentHash), [null, null, null, null, null])
  assert.equal(result.plan[0].reason, '文件已不存在')
  assert.deepEqual(result.counts, { apply: 0, same: 0, modified: 0, missing: 5 })
  assert.equal(result.summary, '5 个已不存在')
})

test('无 hash：文件存在且有行变更 → 无法校验，按 modified 处理', () => {
  const files = [
    { path: 'a.js', added: 2, deleted: 1 },
    { path: 'b.js', added: 2, deleted: 1, hash: null },
    { path: 'c.js', added: 2, deleted: 1, hash: '' },
    { path: 'd.js', added: 2, deleted: 1, hash: 42 },
  ]
  const result = planRollback(files, {
    'a.js': 'ha',
    'b.js': 'hb',
    'c.js': 'hc',
    'd.js': 'hd',
  })
  assert.deepEqual(result.plan.map(item => item.state), ['modified', 'modified', 'modified', 'modified'])
  assert.deepEqual(result.plan.map(item => item.hash), [null, null, null, null])
  assert.equal(result.plan[0].reason, '缺少快照哈希，无法验证磁盘内容，需人工确认')
})

test('state 优先级：missing 高于 same；same 高于无 hash', () => {
  const result = planRollback([
    { path: 'gone.md', added: 0, deleted: 0, hash: 'h' },
    { path: 'kept.md', added: 0, deleted: 0 },
  ], {
    'gone.md': null,
    'kept.md': 'anything',
  })
  assert.deepEqual(result.plan.map(item => item.state), ['missing', 'same'])
})

// ── 汇总 ────────────────────────────────────────────────────────────
test('summary：按 state 固定顺序拼接，零项不出现', () => {
  const result = planRollback([
    fileOf('a.js', 1, 1, 'a'),
    fileOf('b.js', 1, 1, 'b'),
    fileOf('c.js', 1, 1, 'c'),
    fileOf('d.js', 1, 1, 'd'),
    { path: 'e.md', added: 0, deleted: 0, hash: 'e' },
    { path: 'f.txt', added: 2, deleted: 0 },
    fileOf('g.json', 1, 1, 'g'),
  ], {
    'a.js': 'a',
    'b.js': 'b',
    'c.js': 'c',
    'd.js': 'changed',
    'e.md': 'e',
    'f.txt': 'exists',
    'g.json': null,
  })
  assert.deepEqual(result.counts, { apply: 3, same: 1, modified: 2, missing: 1 })
  assert.equal(result.summary, '3 个可回滚，1 个无需回滚，2 个已被修改，1 个已不存在')
})

test('counts 始终包含四个 state 键', () => {
  const result = planRollback([fileOf('a.js')], { 'a.js': 'h1' })
  assert.deepEqual(Object.keys(result.counts), ['apply', 'same', 'modified', 'missing'])
})

// ── 路径 / 哈希归一 ─────────────────────────────────────────────────
test('路径查找按 Windows 口径：大小写、斜杠方向、./ 前缀都不敏感', () => {
  const result = planRollback([
    fileOf(' Lib\\Client.JS ', 40, 5, 'HASH'),
    fileOf('./lib/a.js', 1, 0, 'a'),
    fileOf('C:\\Work\\b.js', 1, 0, 'b'),
  ], {
    'lib/client.js': 'HASH',
    'LIB/A.JS': 'a',
    'c:/work/b.js': 'b',
  })
  assert.deepEqual(result.plan.map(item => item.state), ['apply', 'apply', 'apply'])
  assert.equal(result.plan[0].path, 'Lib\\Client.JS', '输出保留原始路径写法，只去首尾空白')
  assert.equal(result.plan[1].path, './lib/a.js')
})

test('哈希比较大小写不敏感，去首尾空白', () => {
  const result = planRollback([{ path: 'a.js', added: 1, deleted: 0, hash: '  AbC  ' }], {
    'a.js': ' ABC ',
  })
  assert.equal(result.plan[0].state, 'apply')
  assert.equal(result.plan[0].hash, 'abc')
  assert.equal(result.plan[0].currentHash, 'abc')
})

// ── 大数 / 坏输入 ───────────────────────────────────────────────────
test('超大 added / deleted 原样保留，不截成 32 位', () => {
  const added = 3_000_000_000
  const deleted = 5_000_000_000
  const result = planRollback([fileOf('big.js', added, deleted, 'h')], { 'big.js': 'h' })
  assert.equal(result.plan[0].added, added)
  assert.equal(result.plan[0].deleted, deleted)
  assert.ok(formatPlan(result.plan).includes(`+${added} -${deleted}`))
})

test('坏文件条目被丢弃；负数 / NaN 记 0；不修改入参', () => {
  const files = [
    null,
    'lib/a.js',
    {},
    { path: '   ' },
    { path: 42 },
    { path: 'ok.js', added: -2, deleted: Number.NaN, hash: 'h' },
  ]
  const currentHashes = { 'ok.js': 'h' }
  const snapshot = files.map(file => (file !== null && typeof file === 'object' ? { ...file } : file))
  const hashesSnapshot = JSON.parse(JSON.stringify(currentHashes))

  const result = planRollback(files, currentHashes)
  assert.deepEqual(result.plan, [{
    path: 'ok.js',
    added: 0,
    deleted: 0,
    hash: 'h',
    currentHash: 'h',
    state: 'same',
    reason: '内容未变，无需回滚',
  }])
  assert.deepEqual(files, snapshot)
  assert.deepEqual(currentHashes, hashesSnapshot)

  const allMissing = planRollback([fileOf('x.js')], null)
  assert.equal(allMissing.plan[0].state, 'missing')
})

// ── formatPlan ──────────────────────────────────────────────────────
test('formatPlan：一行一个文件，含 state、路径与 ±行', () => {
  const result = planRollback([
    fileOf('lib/client.js', 40, 5, 'h1'),
    { path: 'README.md', added: 0, deleted: 0, hash: 'h2' },
    fileOf('lib/index.js', 12, 3, 'h3'),
    fileOf('docs/old.md', 5, 0, 'h4'),
  ], {
    'lib/client.js': 'h1',
    'README.md': 'h2',
    'lib/index.js': 'changed',
    'docs/old.md': null,
  })
  const text = formatPlan(result.plan)
  assert.equal(text, [
    '✓ 可回滚  lib/client.js  +40 -5',
    '≡ 无需回滚  README.md  +0 -0',
    '⚠ 已被修改  lib/index.js  +12 -3（需人工确认）',
    '✗ 已不存在  docs/old.md  +5 -0（文件已不存在）',
  ].join('\n'))
  assert.equal(text.endsWith('\n'), false)
})

test('formatPlan：空计划 / null / 传入完整结果对象都支持', () => {
  assert.equal(formatPlan([]), '没有可回滚的文件')
  assert.equal(formatPlan(null), '没有可回滚的文件')
  assert.equal(formatPlan(undefined), '没有可回滚的文件')

  const result = planRollback([fileOf('a.js')], { 'a.js': 'h1' })
  assert.equal(formatPlan({ plan: result.plan }), '✓ 可回滚  a.js  +1 -1')
  assert.equal(formatPlan(result), '✓ 可回滚  a.js  +1 -1')
})

test('formatPlan 不修改计划', () => {
  const result = planRollback([fileOf('a.js')], { 'a.js': 'h1' })
  const snapshot = JSON.parse(JSON.stringify(result.plan))
  formatPlan(result.plan)
  assert.deepEqual(result.plan, snapshot)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
