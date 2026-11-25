/**
 * 变更可视化模型测试（P3-1 / A-7）。
 *
 * 纯函数：不改入参、不碰 DOM、不读时钟。
 *
 * Run: node tests/changes-view.mjs
 */

import { strict as assert } from 'node:assert'
import { buildChanges, groupByKind, sortChanges } from '../lib/changes-view.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 一条变更文件。 */
function fileOf(path, added = 0, deleted = 0) {
  return { path, added, deleted }
}

/** 一轮变更快照。 */
function turnOf(changes) {
  return { turn: 7, changes }
}

console.log('\nchanges-view')

// ── buildChanges ────────────────────────────────────────────────────
test('空输入：无变更、无明细，totals 全 0', () => {
  for (const turn of [undefined, null, {}, { changes: null }, { changes: {} }, { changes: { files: [] } }]) {
    const result = buildChanges(turn)
    assert.deepEqual(result, {
      files: [],
      lost: false,
      summary: '该轮没有文件变更',
      totals: { files: 0, added: 0, deleted: 0 },
    })
  }
  assert.deepEqual(buildChanges({ changes: [] }).files, [])
})

test('正常文件：字段归一，totals 求和', () => {
  const result = buildChanges(turnOf({
    files: [
      { path: ' lib/client.js ', added: 40, deleted: 5 },
      { path: 'lib/index.js', added: '12', deleted: '3' },
      { path: 'README.md', added: 0, deleted: 2.9 },
    ],
    total: 3,
    lost: false,
  }))

  assert.equal(result.lost, false)
  assert.deepEqual(result.files, [
    { path: 'lib/client.js', added: 40, deleted: 5 },
    { path: 'lib/index.js', added: 12, deleted: 3 },
    { path: 'README.md', added: 0, deleted: 2 },
  ])
  assert.deepEqual(result.totals, { files: 3, added: 52, deleted: 10 })
  assert.equal(result.summary, '该轮改了 3 个文件，+52 -10 行')
})

test('lost:true：丢弃明细、固定文案、totals 归零', () => {
  const result = buildChanges(turnOf({
    files: [{ path: 'lib/client.js', added: 40, deleted: 5 }],
    total: 1,
    added: 40,
    deleted: 5,
    lost: true,
  }))
  assert.deepEqual(result, {
    files: [],
    lost: true,
    summary: '该轮变更明细已不可读',
    totals: { files: 0, added: 0, deleted: 0 },
  })
  // 只有严格 true 才算 lost，字符串 / 1 不冒充
  assert.equal(buildChanges(turnOf({ files: [], lost: 'true' })).lost, false)
  assert.equal(buildChanges(turnOf({ files: [], lost: 1 })).lost, false)
})

test('非法的 added / deleted：负数、NaN、Infinity、空值都记 0', () => {
  const result = buildChanges(turnOf({
    files: [
      { path: 'a.js', added: -5, deleted: Number.NaN },
      { path: 'b.js', added: Number.POSITIVE_INFINITY, deleted: null },
      { path: 'c.js', added: undefined, deleted: '' },
      { path: 'd.js', added: 7.9, deleted: 'x' },
    ],
  }))
  assert.deepEqual(result.files.map(file => [file.added, file.deleted]), [
    [0, 0], [0, 0], [0, 0], [7, 0],
  ])
  assert.deepEqual(result.totals, { files: 4, added: 7, deleted: 0 })
})

test('超大 added / deleted 原样保留（不截成 32 位）', () => {
  const added = 3_000_000_000
  const deleted = 5_000_000_000
  const result = buildChanges(turnOf({ files: [{ path: 'big.js', added, deleted }] }))

  assert.equal(result.files[0].added, added)
  assert.equal(result.files[0].deleted, deleted)
  assert.deepEqual(result.totals, { files: 1, added, deleted })
  assert.equal(result.summary, '该轮改了 1 个文件，+3000000000 -5000000000 行')
})

test('兼容 changes 为数组的旧形状；坏条目被丢掉', () => {
  const result = buildChanges({
    changes: [
      { path: 'lib/a.js', added: 3, deleted: 1 },
      null,
      {},
      { path: '   ', added: 9, deleted: 9 },
      'lib/b.md',
      { path: 'lib/c.json', added: '4', deleted: 2 },
    ],
  })
  assert.deepEqual(result.files, [
    { path: 'lib/a.js', added: 3, deleted: 1 },
    { path: 'lib/b.md', added: 0, deleted: 0 },
    { path: 'lib/c.json', added: 4, deleted: 2 },
  ])
  assert.deepEqual(result.totals, { files: 3, added: 7, deleted: 3 })
  assert.equal(result.lost, false)
})

test('summary：0 / 1 / 多文件与大量数字', () => {
  assert.equal(buildChanges({ changes: { files: [] } }).summary, '该轮没有文件变更')
  assert.equal(
    buildChanges({ changes: { files: [fileOf('a.js', 1, 0)] } }).summary,
    '该轮改了 1 个文件，+1 -0 行',
  )
  assert.equal(
    buildChanges({ changes: { files: [fileOf('a.js', 0, 0), fileOf('b.md', 2, 3)] } }).summary,
    '该轮改了 2 个文件，+2 -3 行',
  )
})

test('buildChanges 不修改入参，也不把 hash / 其它字段漏进 files', () => {
  const changes = {
    files: [{ path: 'lib/a.js', added: 3, deleted: 1, hash: 'sha256-x', extra: true }],
    total: 1,
    lost: false,
  }
  const turn = turnOf(changes)
  const snapshot = JSON.parse(JSON.stringify(turn))

  const result = buildChanges(turn)
  assert.deepEqual(turn, snapshot)
  assert.deepEqual(result.files, [{ path: 'lib/a.js', added: 3, deleted: 1 }])
})

// ── groupByKind ─────────────────────────────────────────────────────
test('按扩展名分组：固定顺序 code → doc → config → other，只列非空组', () => {
  const files = [
    fileOf('assets/logo.png', 0, 0),
    fileOf('package.json', 2, 0),
    fileOf('README.md', 10, 1),
    fileOf('lib/client.js', 40, 5),
    fileOf('lib/view.mjs', 3, 2),
    fileOf('docs/guide.txt', 1, 0),
  ]
  const groups = groupByKind(files)

  assert.deepEqual(groups.map(group => group.kind), ['code', 'doc', 'config', 'other'])
  assert.deepEqual(groups.map(group => group.label), ['代码', '文档', '配置', '其他'])
  assert.deepEqual(groups[0].files.map(file => file.path), ['lib/client.js', 'lib/view.mjs'])
  assert.deepEqual(groups[1].files.map(file => file.path), ['README.md', 'docs/guide.txt'])
  assert.deepEqual(groups[2].files.map(file => file.path), ['package.json'])
  assert.deepEqual(groups[3].files.map(file => file.path), ['assets/logo.png'])
})

test('扩展名映射：大小写不敏感，点号 / 目录干扰不误判', () => {
  const cases = [
    ['a.js', 'code'], ['a.ts', 'code'], ['a.mjs', 'code'], ['a.py', 'code'],
    ['a.go', 'code'], ['a.rs', 'code'], ['a.java', 'code'], ['a.c', 'code'], ['a.h', 'code'],
    ['a.MD', 'doc'], ['a.TxT', 'doc'],
    ['a.json', 'config'], ['a.yml', 'config'], ['a.yaml', 'config'],
    ['a.toml', 'config'], ['a.ini', 'config'],
    ['a.png', 'other'], ['a.jsonc', 'other'], ['README', 'other'],
    ['.gitignore', 'other'], ['a.', 'other'], ['dir.md/file', 'other'],
    ['dir.v1/file.js', 'code'], ['archive.tar.gz', 'other'],
  ]
  const groups = groupByKind(cases.map(([path]) => fileOf(path) ))
  const kindOf = new Map(groups.flatMap(group => group.files.map(file => [file.path, group.kind])))
  for (const [path, kind] of cases) assert.equal(kindOf.get(path), kind, path)
})

test('groupByKind：空输入 / 坏输入返回空数组，不修改入参', () => {
  assert.deepEqual(groupByKind([]), [])
  assert.deepEqual(groupByKind(null), [])
  assert.deepEqual(groupByKind('x'), [])
  const files = [{ path: 'lib/a.js', added: 1, deleted: 1 }, null, {}, { path: '  ' }]
  const snapshot = JSON.parse(JSON.stringify(files))
  const groups = groupByKind(files)
  assert.deepEqual(groups.map(group => group.files.length), [1])
  assert.deepEqual(files, snapshot)
})

// ── sortChanges ─────────────────────────────────────────────────────
test('path 排序：大小写不敏感 + 同小写时按原串稳定比较', () => {
  const files = [fileOf('b.md'), fileOf('a.js'), fileOf('A.js'), fileOf('C.txt')]
  const snapshot = files.slice()
  const sorted = sortChanges(files, 'path')

  assert.deepEqual(sorted.map(file => file.path), ['A.js', 'a.js', 'b.md', 'C.txt'])
  assert.deepEqual(files, snapshot, '不能原地排序')
  assert.notEqual(sorted, files)
})

test('size 排序：按 added+deleted 降序，同量按 path 升序', () => {
  const files = [
    fileOf('a.js', 10, 5),
    fileOf('c.txt', 0, 20),
    fileOf('b.md', 20, 0),
    fileOf('d.json', 1, 1),
    fileOf('e.go', 3_000_000_000, 0),
  ]
  const sorted = sortChanges(files, 'size')
  assert.deepEqual(sorted.map(file => file.path), ['e.go', 'b.md', 'c.txt', 'a.js', 'd.json'])
  assert.deepEqual(files.map(file => file.path), ['a.js', 'c.txt', 'b.md', 'd.json', 'e.go'])
})

test('sortChanges：未知 mode 回 path；坏条目丢弃；不丢字段归一', () => {
  const files = [
    { path: 'b.js', added: '2', deleted: '1' },
    null,
    { path: '  A.js  ', added: -1, deleted: 9.9 },
    { path: '' },
  ]
  const snapshot = JSON.parse(JSON.stringify(files))

  const sorted = sortChanges(files, 'SIZE')
  assert.deepEqual(sorted, [
    { path: 'A.js', added: 0, deleted: 9 },
    { path: 'b.js', added: 2, deleted: 1 },
  ])
  assert.deepEqual(files, snapshot)

  assert.deepEqual(sortChanges(null, 'size'), [])
  assert.deepEqual(sortChanges([], 'size'), [])
})

test('sortChanges 大数不溢出、结果确定', () => {
  const files = [
    fileOf('x.js', 5_000_000_000, 0),
    fileOf('y.js', 3_000_000_000, 1_000_000_000),
  ]
  assert.deepEqual(sortChanges(files, 'size').map(file => file.path), ['x.js', 'y.js'])
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
