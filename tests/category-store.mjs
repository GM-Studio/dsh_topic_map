/**
 * 分类存储纯函数的测试。
 *
 * 这些纯函数会被 Host 与客户端共用：不 import、不碰 DOM、不读时钟。
 * 本文件只通过公开签名驱动，重点盯住：稳定 id、人工优先、undo、异常输入不崩。
 *
 * Run: node tests/category-store.mjs
 */

import { strict as assert } from 'node:assert'
import {
  emptyStore,
  upsertCategory,
  assignSession,
  mergeCategories,
  moveCategory,
  splitCategory,
  undoStore,
  toTree,
  applyModelFill,
} from '../lib/category-store.js'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures.push({ name, error: e })
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`)
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/** 从 assignments 里取分类 id；同时容忍字符串与 {categoryId} 两种历史形状。 */
function catOf(store, sessionId) {
  const raw = store?.assignments?.[sessionId]
  if (raw == null) return null
  return typeof raw === 'string' ? raw : raw.categoryId
}

function find(store, id) {
  return store.categories.find(c => c.id === id) ?? null
}

function flatten(tree) {
  const out = []
  for (const node of Array.isArray(tree) ? tree : []) {
    out.push(node)
    out.push(...flatten(node.children))
  }
  return out
}

/** 基础夹具：根分类（2 个会话）→ 子分类（1 个会话）。 */
function fixture() {
  let store = emptyStore()
  let r = upsertCategory(store, { id: 'c-root', name: '根分类', parentId: null, source: 'user' })
  assert.equal(r.error, undefined)
  store = r.store
  r = upsertCategory(store, { id: 'c-child', name: '子分类', parentId: 'c-root', source: 'user' })
  assert.equal(r.error, undefined)
  store = r.store
  for (const [sid, cid] of [['s1', 'c-root'], ['s2', 'c-root'], ['s3', 'c-child']]) {
    const a = assignSession(store, sid, cid, 'user')
    assert.equal(a.error, undefined)
    store = a.store
  }
  return store
}

console.log('\ncategory-store')

// ── 空 store 与基本形状 ─────────────────────────────────────────────

test('emptyStore 返回版本 1 的空结构，且每次是新对象', () => {
  const a = emptyStore()
  const b = emptyStore()
  assert.deepEqual(a, { version: 1, categories: [], assignments: {} })
  assert.notEqual(a.categories, b.categories)
  assert.notEqual(a.assignments, b.assignments)
  a.categories.push({ id: 'c-x', name: '污染', parentId: null, source: 'user' })
  assert.equal(b.categories.length, 0, '两次调用不能共享数组')
})

// ── 稳定短 id ──────────────────────────────────────────────────────

test('id 缺省时生成 c- + 6 位 base36，同输入同 id', () => {
  const first = upsertCategory(emptyStore(), { name: '插件开发', parentId: null, source: 'model' })
  assert.match(first.id, /^c-[0-9a-z]{6}$/)
  const again = upsertCategory(first.store, { name: '插件开发', parentId: null, source: 'model' })
  assert.equal(again.id, first.id)
  assert.equal(again.store.categories.length, 1, '重复调用应复用同一分类')
})

test('name 相同但 parent 不同会得到不同 id', () => {
  const parent = upsertCategory(emptyStore(), { id: 'c-p', name: '父', parentId: null, source: 'user' })
  const rootChild = upsertCategory(parent.store, { name: '同名' })
  const nested = upsertCategory(parent.store, { name: '同名', parentId: 'c-p' })
  assert.notEqual(rootChild.id, nested.id)
  assert.equal(nested.store.categories.length, 2)
})

test('显式 id 重复时更新原分类，不追加重复项', () => {
  let store = upsertCategory(emptyStore(), { id: 'c-dup', name: '旧名', source: 'user' }).store
  store = upsertCategory(store, { id: 'c-dup', name: '新名', source: 'user' }).store
  assert.equal(store.categories.length, 1)
  assert.equal(find(store, 'c-dup').name, '新名')
})

test('分类上的 order / createdAt 等扩展字段在读写与 undo 中不丢', () => {
  const store = {
    version: 1,
    categories: [
      { id: 'c-a', name: '甲', parentId: null, source: 'user', order: 7, createdAt: 1700000000000 },
      { id: 'c-b', name: '乙', parentId: 'c-a', source: 'model', order: 2, createdAt: 1700000000001 },
    ],
    assignments: { s1: { categoryId: 'c-b', source: 'user' } },
  }
  const assigned = assignSession(store, 's2', 'c-a', 'user').store
  assert.equal(find(assigned, 'c-a').order, 7)
  assert.equal(find(assigned, 'c-b').createdAt, 1700000000001)

  const merged = mergeCategories(assigned, ['c-a', 'c-b'], '合并后', 'user')
  assert.equal(find(merged.store, 'c-a').order, 7, '合并后的目标保留扩展字段')
  const undone = undoStore(merged.store, merged.undo).store
  assert.equal(find(undone, 'c-b').order, 2, 'undo 恢复被并分类的扩展字段')
  assert.equal(find(undone, 'c-b').createdAt, 1700000000001)

  const filled = applyModelFill(store, [{ id: 'c-a', name: '模型改名' }]).store
  assert.equal(find(filled, 'c-a').order, 7, 'applyModelFill 不得丢扩展字段')
})

test('重复 id 的脏数据在 toTree 中去重，不重复挂节点', () => {
  const dirty = {
    version: 1,
    categories: [
      { id: 'c-1', name: '甲', parentId: null, source: 'user' },
      { id: 'c-1', name: '重复', parentId: null, source: 'user' },
    ],
    assignments: {},
  }
  const tree = toTree(dirty)
  assert.equal(tree.length, 1)
  assert.equal(flatten(tree).length, 1)
})

// ── 树与计数 ──────────────────────────────────────────────────────

test('toTree 嵌套正确，count 只算直接会话', () => {
  const store = fixture()
  const tree = toTree(store)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].id, 'c-root')
  assert.equal(tree[0].name, '根分类')
  assert.equal(tree[0].source, 'user')
  assert.equal(tree[0].count, 2, '根分类只算 s1/s2，不含子分类的 s3')
  assert.equal(tree[0].children.length, 1)
  assert.equal(tree[0].children[0].count, 1)
  assert.deepEqual(Object.keys(tree[0]).sort(), ['children', 'count', 'id', 'name', 'source'])
})

test('循环父子数据不会死循环，节点一个不少', () => {
  const cyclic = {
    version: 1,
    categories: [
      { id: 'c-a', name: 'A', parentId: 'c-b', source: 'user' },
      { id: 'c-b', name: 'B', parentId: 'c-a', source: 'user' },
    ],
    assignments: {},
  }
  const tree = toTree(cyclic)
  assert.equal(flatten(tree).length, 2)
  assert.equal(tree.length, 1, '断开一条边后应剩一个根')
})

test('挂到不存在的父分类按根节点显示，不丢分类', () => {
  const store = {
    version: 1,
    categories: [{ id: 'c-a', name: 'A', parentId: 'c-missing', source: 'user' }],
    assignments: {},
  }
  const tree = toTree(store)
  assert.equal(tree.length, 1)
  assert.equal(tree[0].id, 'c-a')
})

// ── 会话归类 ──────────────────────────────────────────────────────

test('assignSession 归类，传 null 取消归类', () => {
  const base = fixture()
  const freed = assignSession(base, 's1', null, 'user')
  assert.equal(freed.error, undefined)
  assert.equal(catOf(freed.store, 's1'), null)
  assert.equal(catOf(base, 's1'), 'c-root', '不得修改入参')
  const again = assignSession(freed.store, 's1', null, 'user')
  assert.equal(again.error, undefined)
  assert.equal(catOf(again.store, 's1'), null)
})

test('assignSession 拒绝不存在的分类', () => {
  const r = assignSession(fixture(), 's1', 'c-missing', 'user')
  assert.ok(r.error)
  assert.equal(catOf(r.store, 's1'), 'c-root')
})

test('模型不能覆盖人工归类', () => {
  const base = fixture()
  const r = assignSession(base, 's1', 'c-child', 'model')
  assert.ok(r.error, '用户已归类，模型改分类应被拒绝')
  assert.equal(catOf(r.store, 's1'), 'c-root')
  const cancel = assignSession(base, 's1', null, 'model')
  assert.ok(cancel.error, '模型也不能取消人工归类')
  assert.equal(catOf(cancel.store, 's1'), 'c-root')
})

test('模型可以给未归类会话归类', () => {
  const r = assignSession(fixture(), 's9', 'c-child', 'model')
  assert.equal(r.error, undefined)
  assert.equal(catOf(r.store, 's9'), 'c-child')
})

// ── upsert 的父子校验 ──────────────────────────────────────────────

test('upsertCategory 拒绝自引用与成环', () => {
  const base = fixture()
  const self = upsertCategory(base, { id: 'c-root', name: '根分类', parentId: 'c-root', source: 'user' })
  assert.ok(self.error)
  const cycle = upsertCategory(base, { id: 'c-root', name: '根分类', parentId: 'c-child', source: 'user' })
  assert.ok(cycle.error, '父分类是自己的后代必须拒绝')
  assert.equal(find(cycle.store, 'c-root').parentId, null)
})

test('upsertCategory 拒绝不存在的父分类，不改入参', () => {
  const base = fixture()
  const before = clone(base)
  const r = upsertCategory(base, { name: '新分类', parentId: 'c-missing' })
  assert.ok(r.error)
  assert.deepEqual(r.store, before)
  assert.deepEqual(base, before)
})

// ── applyModelFill：只填空白，人工优先 ─────────────────────────────

test('applyModelFill 给模型空名分类补名，但不改人工分类名', () => {
  const store = {
    version: 1,
    categories: [
      { id: 'c-fill', name: '', parentId: null, source: 'model' },
      { id: 'c-user', name: '人工名', parentId: null, source: 'user' },
    ],
    assignments: { s1: { categoryId: 'c-user', source: 'user' } },
  }
  const r = applyModelFill(store, [
    { id: 'c-fill', name: '模型补名' },
    { id: 'c-user', name: '模型改名' },
  ])
  assert.equal(find(r.store, 'c-fill').name, '模型补名')
  assert.equal(find(r.store, 'c-user').name, '人工名', '人工名称不得被模型覆盖')
  assert.deepEqual(r.store.assignments, store.assignments, 'applyModelFill 不得改 assignments')
  assert.equal(find(store, 'c-fill').name, '', '不得修改入参')
})

test('applyModelFill 只填空白，已有名称一律不覆盖', () => {
  const store = {
    version: 1,
    categories: [{ id: 'c-m', name: '已有模型名', parentId: null, source: 'model' }],
    assignments: {},
  }
  const r = applyModelFill(store, [{ id: 'c-m', name: '新名' }])
  assert.equal(find(r.store, 'c-m').name, '已有模型名')
})

test('applyModelFill 新建缺失分类，重复应用结果相同', () => {
  const first = applyModelFill(emptyStore(), [
    { name: '模型根分类', parentId: null },
    { name: '模型子分类', parentId: 'c-does-not-exist' },
  ])
  assert.equal(first.store.categories.length, 2)
  assert.equal(first.store.categories[0].source, 'model')
  const second = applyModelFill(first.store, [
    { name: '模型根分类', parentId: null },
    { name: '模型子分类', parentId: 'c-does-not-exist' },
  ])
  assert.deepEqual(second.store, first.store)
})

test('applyModelFill 支持父分类先出现的两层提案', () => {
  const root = applyModelFill(emptyStore(), [{ name: '根' }])
  const rootId = root.store.categories[0].id
  const tree = applyModelFill(root.store, [
    { id: rootId, name: '根' },
    { name: '子', parentId: rootId },
  ])
  const nodes = toTree(tree.store)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].children.length, 1)
  assert.equal(nodes[0].children[0].name, '子')
})

test('applyModelFill 忽略非法提案，不崩', () => {
  assert.doesNotThrow(() => {
    const r = applyModelFill(emptyStore(), [null, 42, 'x', {}, { name: 42 }, { name: '' }])
    assert.equal(r.store.categories.length, 0)
  })
})

// ── 合并 + undo ───────────────────────────────────────────────────

test('mergeCategories 迁移会话与子分类，undo 完整还原', () => {
  let base = fixture()
  base = upsertCategory(base, { id: 'c-other', name: '另一个', parentId: null, source: 'user' }).store
  base = assignSession(base, 's4', 'c-child', 'user').store
  const before = clone(base)

  const merged = mergeCategories(base, ['c-root', 'c-child'], '合并后', 'user')
  assert.equal(merged.error, undefined)
  assert.equal(merged.store.categories.some(c => c.id === 'c-child'), false)
  const target = find(merged.store, 'c-root')
  assert.equal(target.name, '合并后')
  assert.equal(catOf(merged.store, 's1'), 'c-root')
  assert.equal(catOf(merged.store, 's2'), 'c-root')
  assert.equal(catOf(merged.store, 's3'), 'c-root')
  assert.equal(catOf(merged.store, 's4'), 'c-root')
  assert.equal(find(merged.store, 'c-other').parentId, null)

  const undone = undoStore(merged.store, merged.undo)
  assert.deepEqual(undone.store, before, 'undo 必须还原分类、顺序、会话与 source')
})

test('mergeCategories 去掉重复 id，非法 id 整体失败且不改状态', () => {
  const base = fixture()
  const dup = mergeCategories(base, ['c-root', 'c-child', 'c-root'], '合并后', 'user')
  assert.equal(dup.error, undefined)

  const before = clone(base)
  const bad = mergeCategories(base, ['c-root', 'c-missing'], '坏合并', 'user')
  assert.ok(bad.error)
  assert.deepEqual(bad.store, before)
  assert.equal(bad.undo, undefined)
})

test('merge 的目标若是被并入者的子分类，合并后父级被提回顶层', () => {
  let store = emptyStore()
  store = upsertCategory(store, { id: 'c-p', name: '父', parentId: null, source: 'user' }).store
  store = upsertCategory(store, { id: 'c-c', name: '子', parentId: 'c-p', source: 'user' }).store
  store = assignSession(store, 's1', 'c-p', 'user').store
  const before = clone(store)

  const merged = mergeCategories(store, ['c-c', 'c-p'], '子', 'user')
  assert.equal(merged.error, undefined)
  assert.equal(find(merged.store, 'c-c').parentId, null)
  assert.equal(catOf(merged.store, 's1'), 'c-c')
  assert.deepEqual(undoStore(merged.store, merged.undo).store, before)
})

// ── 移动 + undo ──────────────────────────────────────────────────

test('moveCategory 移动父级，undo 还原，自环与后代环被拒', () => {
  let store = fixture()
  store = upsertCategory(store, { id: 'c-other', name: '另一个', parentId: null, source: 'user' }).store
  const moved = moveCategory(store, 'c-child', 'c-other')
  assert.equal(moved.error, undefined)
  assert.equal(find(moved.store, 'c-child').parentId, 'c-other')
  assert.equal(find(undoStore(moved.store, moved.undo).store, 'c-child').parentId, 'c-root')

  assert.ok(moveCategory(store, 'c-root', 'c-root').error)
  assert.ok(moveCategory(store, 'c-root', 'c-child').error, '不能挂到自己的后代下')
})

// ── 拆分 + undo ──────────────────────────────────────────────────

test('splitCategory 移走指定会话，来源空了就删除，undo 完整还原', () => {
  let store = fixture()
  store = upsertCategory(store, { id: 'c-target', name: '目标', parentId: null, source: 'user' }).store
  const before = clone(store)

  const split = splitCategory(store, 'c-child', [{ sessionId: 's3', toId: 'c-target' }])
  assert.equal(split.error, undefined)
  assert.equal(find(split.store, 'c-child'), null, '来源分类已无会话且无子分类，应删除')
  assert.equal(catOf(split.store, 's3'), 'c-target')
  assert.deepEqual(undoStore(split.store, split.undo).store, before)
})

test('splitCategory 只移动已在来源分类里的会话，来源有子分类时保留', () => {
  const store = fixture()
  const r = splitCategory(store, 'c-root', [
    { sessionId: 's1', toId: 'c-child' },
    { sessionId: 's3', toId: 'c-child' }, // s3 本来就在 c-child，不算移出
  ])
  assert.equal(r.error, undefined)
  assert.equal(catOf(r.store, 's1'), 'c-child')
  assert.equal(catOf(r.store, 's2'), 'c-root')
  assert.equal(catOf(r.store, 's3'), 'c-child')
  assert.notEqual(find(r.store, 'c-root'), null, '还有 s2 与子分类，不能删除')
})

test('splitCategory 目标不存在时整体失败，不改状态', () => {
  const store = fixture()
  const before = clone(store)
  const r = splitCategory(store, 'c-root', [{ sessionId: 's1', toId: 'c-missing' }])
  assert.ok(r.error)
  assert.deepEqual(r.store, before)
})

// ── 异常输入与纯净性 ──────────────────────────────────────────────

test('非法输入不抛异常', () => {
  assert.doesNotThrow(() => {
    for (const bad of [null, undefined, 0, 'x', [], {}]) {
      upsertCategory(bad, null)
      assignSession(bad, null, null)
      mergeCategories(bad, null)
      moveCategory(bad, null, null)
      splitCategory(bad, null, null)
      undoStore(bad, null)
      toTree(bad)
      applyModelFill(bad, null)
    }
    assignSession(fixture(), 42, 'c-root')
    moveCategory(fixture(), {}, 'c-root')
    splitCategory(fixture(), 'c-root', [null, 42, { sessionId: 42 }])
  })
})

test('未知 undo 不破坏当前 store', () => {
  const store = fixture()
  assert.deepEqual(undoStore(store, null).store, store)
  assert.deepEqual(undoStore(store, { kind: 'no-such-kind' }).store, store)
})

test('所有写函数都不修改入参（冻结输入也不崩）', () => {
  const frozen = deepFreeze(fixture())
  const before = clone(frozen)
  assert.doesNotThrow(() => {
    upsertCategory(frozen, { id: 'c-new', name: '新', parentId: null, source: 'user' })
    assignSession(frozen, 's1', 'c-child', 'user')
    mergeCategories(frozen, ['c-root', 'c-child'], 'X', 'user')
    moveCategory(frozen, 'c-child', null)
    splitCategory(frozen, 'c-root', [{ sessionId: 's1', toId: 'c-child' }])
    applyModelFill(frozen, [{ name: '模型分类' }])
    toTree(frozen)
  })
  assert.deepEqual(frozen, before)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exitCode = 1
}
