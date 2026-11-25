/**
 * 整理计划（plan / apply / undo / describe）的测试。
 *
 * planOrganize 只做纯计算：不改入参、返回可序列化 plan；
 * applyPlan 幂等；任何会丢分类的 plan 必须带 warnings。
 *
 * Run: node tests/organize.mjs
 */

import { strict as assert } from 'node:assert'
import {
  emptyStore,
  upsertCategory,
  assignSession,
  mergeCategories,
} from '../lib/category-store.js'
import {
  planOrganize,
  applyPlan,
  undoOrganize,
  describeUndo,
} from '../lib/organize.js'

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

function catOf(store, sessionId) {
  const raw = store?.assignments?.[sessionId]
  if (raw == null) return null
  return typeof raw === 'string' ? raw : raw.categoryId
}

function find(store, id) {
  return store.categories.find(c => c.id === id) ?? null
}

/** 基础夹具：工作（s1/s2）→ 子项（s3）；其他（s4）。 */
function fixture() {
  let store = emptyStore()
  let r = upsertCategory(store, { id: 'c-work', name: '工作', parentId: null, source: 'user' })
  assert.equal(r.error, undefined)
  store = r.store
  r = upsertCategory(store, { id: 'c-child', name: '子项', parentId: 'c-work', source: 'user' })
  assert.equal(r.error, undefined)
  store = r.store
  r = upsertCategory(store, { id: 'c-other', name: '其他', parentId: null, source: 'user' })
  assert.equal(r.error, undefined)
  store = r.store
  for (const [sid, cid] of [['s1', 'c-work'], ['s2', 'c-work'], ['s3', 'c-child'], ['s4', 'c-other']]) {
    const a = assignSession(store, sid, cid, 'user')
    assert.equal(a.error, undefined)
    store = a.store
  }
  return store
}

/** 把 s1/s2/s3 全部改到 c-other，并把 s4 挪走，制造「删掉它有 3 个会话失去归类」的夹具。 */
function threeOnOther() {
  let store = fixture()
  for (const sid of ['s1', 's2', 's3']) {
    const a = assignSession(store, sid, 'c-other', 'user')
    assert.equal(a.error, undefined)
    store = a.store
  }
  const moved = assignSession(store, 's4', 'c-work', 'user')
  assert.equal(moved.error, undefined)
  return moved.store
}

console.log('\norganize')

// ── planOrganize：纯计算与形状 ─────────────────────────────────────

test('planOrganize 不改入参，plan 可 JSON 往返', () => {
  const store = fixture()
  const before = clone(store)
  const r = planOrganize(store, { action: 'merge', ids: ['c-work', 'c-other'], name: '合并后' })
  assert.equal(r.error, undefined)
  assert.ok(r.plan, '应返回 plan')
  assert.deepEqual(store, before, 'planOrganize 必须是纯计算')
  const roundTripped = JSON.parse(JSON.stringify(r.plan))
  assert.deepEqual(roundTripped, r.plan)
})

test('规范键 kind 可用，且 type/op 别名仍兼容', () => {
  const byKind = planOrganize(fixture(), { kind: 'move', id: 'c-other', parentId: 'c-work' })
  assert.equal(byKind.error, undefined)
  assert.equal(byKind.plan.action, 'move')
  assert.equal(byKind.plan.kind, 'move', 'plan 也带规范键 kind')

  const byType = planOrganize(fixture(), { type: 'move', id: 'c-other', parentId: 'c-work' })
  assert.equal(byType.error, undefined)
  assert.equal(byType.plan.action, 'move')
  const byOp = planOrganize(fixture(), { op: 'assign', sessionId: 's1', categoryId: 'c-other' })
  assert.equal(byOp.error, undefined)
  assert.equal(byOp.plan.source, 'user')
})

test('分类扩展字段 order / createdAt 在 plan/apply/undo 中不丢', () => {
  let store = emptyStore()
  store = upsertCategory(store, {
    id: 'c-a', name: '甲', parentId: null, source: 'user', order: 4, createdAt: 1700000000000,
  }).store
  store = upsertCategory(store, {
    id: 'c-b', name: '乙', parentId: null, source: 'user', order: 9, createdAt: 1700000000001,
  }).store
  store = assignSession(store, 's1', 'c-b', 'user').store

  const plan = planOrganize(store, { kind: 'merge', ids: ['c-a', 'c-b'], name: '合并后' }).plan
  const applied = applyPlan(store, plan)
  assert.equal(find(applied.store, 'c-a').order, 4)
  const undone = undoOrganize(applied.store, applied.undo).store
  assert.equal(find(undone, 'c-b').order, 9, 'undo 恢复被并分类的扩展字段')
  assert.equal(find(undone, 'c-b').createdAt, 1700000000001)
})

test('空 store 上做合并返回错误而不是抛异常', () => {
  const r = planOrganize(emptyStore(), { action: 'merge', ids: ['c-a', 'c-b'], name: 'X' })
  assert.ok(r.error)
  assert.equal(r.plan, null)
})

test('合并 plan 无会话损失，warnings 为空', () => {
  const r = planOrganize(fixture(), { action: 'merge', ids: ['c-work', 'c-other'], name: '合并后' })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.plan.warnings, [])
  assert.equal(r.plan.action, 'merge')
  assert.deepEqual(r.plan.ids, ['c-work', 'c-other'])
  assert.equal(r.plan.targetId, 'c-work')
})

test('合并 plan 去重重复 id，应用结果与去重后一致', () => {
  const store = fixture()
  const plan = planOrganize(store, {
    kind: 'merge',
    ids: ['c-work', 'c-other', 'c-work'],
    name: '合并后',
  }).plan
  assert.deepEqual(plan.ids, ['c-work', 'c-other'])
  assert.equal(plan.targetId, 'c-work')
  const applied = applyPlan(store, plan)
  assert.equal(find(applied.store, 'c-other'), null)
  assert.deepEqual(undoOrganize(applied.store, applied.undo).store, store)
})

// ── apply / undo：合并 ────────────────────────────────────────────

test('合并 plan 应用后保留全部会话与子分类，undo 完整还原', () => {
  const store = fixture()
  const before = clone(store)
  const r = planOrganize(store, { action: 'merge', ids: ['c-work', 'c-other'], name: '合并后' })
  const applied = applyPlan(store, r.plan)
  assert.ok(applied.undo)
  assert.equal(find(applied.store, 'c-other'), null)
  assert.equal(find(applied.store, 'c-work').name, '合并后')
  for (const sid of ['s1', 's2', 's4']) assert.equal(catOf(applied.store, sid), 'c-work')
  assert.equal(catOf(applied.store, 's3'), 'c-child', '子分类的会话不因父级合并被改写')
  assert.equal(find(applied.store, 'c-child').parentId, 'c-work')
  assert.deepEqual(undoOrganize(applied.store, applied.undo).store, before)
})

test('同一合并 plan 应用两次结果相同，第二次 undo 是无操作', () => {
  const store = fixture()
  const plan = planOrganize(store, { action: 'merge', ids: ['c-work', 'c-other'], name: '合并后' }).plan
  const first = applyPlan(store, plan)
  const second = applyPlan(first.store, plan)
  assert.deepEqual(second.store, first.store)
  assert.equal(second.undo.kind, 'noop')
  assert.doesNotThrow(() => undoOrganize(second.store, second.undo))
  assert.deepEqual(undoOrganize(second.store, second.undo).store, first.store)
})

// ── 移动 ─────────────────────────────────────────────────────────

test('移动 plan：应用移动、undo 还原', () => {
  const store = fixture()
  const before = clone(store)
  const plan = planOrganize(store, { action: 'move', id: 'c-other', parentId: 'c-work' }).plan
  assert.equal(plan.action, 'move')
  const applied = applyPlan(store, plan)
  assert.equal(find(applied.store, 'c-other').parentId, 'c-work')
  assert.deepEqual(undoOrganize(applied.store, applied.undo).store, before)
})

test('移动到自己的后代被拒', () => {
  const r = planOrganize(fixture(), { action: 'move', id: 'c-work', parentId: 'c-child' })
  assert.ok(r.error)
  assert.equal(r.plan, null)
})

test('移动到自己当前父级是 noop', () => {
  const r = planOrganize(fixture(), { action: 'move', id: 'c-child', parentId: 'c-work' })
  assert.equal(r.noop, true)
})

// ── 拆分 ─────────────────────────────────────────────────────────

test('拆分 plan 移走会话，来源空了删除；应用幂等、undo 还原', () => {
  let store = fixture()
  store = upsertCategory(store, { id: 'c-target', name: '目标', parentId: null, source: 'user' }).store
  const before = clone(store)
  const plan = planOrganize(store, {
    action: 'split',
    id: 'c-other',
    moves: [{ sessionId: 's4', toId: 'c-target' }],
  }).plan
  assert.deepEqual(plan.warnings, [])
  const applied = applyPlan(store, plan)
  assert.equal(find(applied.store, 'c-other'), null)
  assert.equal(catOf(applied.store, 's4'), 'c-target')
  const twice = applyPlan(applied.store, plan)
  assert.deepEqual(twice.store, applied.store)
  assert.deepEqual(undoOrganize(applied.store, applied.undo).store, before)
})

test('拆分目标不存在时返回错误', () => {
  const r = planOrganize(fixture(), {
    action: 'split',
    id: 'c-other',
    moves: [{ sessionId: 's4', toId: 'c-missing' }],
  })
  assert.ok(r.error)
  assert.equal(r.plan, null)
})

test('没有可移动会话的拆分是 noop', () => {
  const r = planOrganize(fixture(), { action: 'split', id: 'c-other', moves: [] })
  assert.equal(r.noop, true)
})

// ── 丢归类必须 warnings ───────────────────────────────────────────

test('删除分类会丢会话归类，plan 必须带 warnings', () => {
  const store = threeOnOther()
  const r = planOrganize(store, { action: 'delete', id: 'c-other' })
  assert.equal(r.error, undefined)
  assert.equal(r.plan.warnings.length, 1)
  assert.match(r.plan.warnings[0], /3 个会话将失去归类/)
})

test('取消单个归类会丢归类，plan 必须带 warnings', () => {
  const plan = planOrganize(fixture(), { action: 'assign', sessionId: 's1', categoryId: null }).plan
  assert.equal(plan.warnings.length, 1)
  assert.match(plan.warnings[0], /1 个会话将失去归类/)
})

test('删除 plan 应用后会话取消归类，undo 还原', () => {
  const store = threeOnOther()
  const before = clone(store)
  const plan = planOrganize(store, { action: 'delete', id: 'c-other' }).plan
  const applied = applyPlan(store, plan)
  assert.equal(find(applied.store, 'c-other'), null)
  for (const sid of ['s1', 's2', 's3']) assert.equal(catOf(applied.store, sid), null)
  assert.deepEqual(undoOrganize(applied.store, applied.undo).store, before)
})

test('取消归类 plan 应用后删除 assignment，undo 还原', () => {
  const store = fixture()
  const before = clone(store)
  const plan = planOrganize(store, { action: 'assign', sessionId: 's2', categoryId: null }).plan
  const applied = applyPlan(store, plan)
  assert.equal(catOf(applied.store, 's2'), null)
  assert.deepEqual(undoOrganize(applied.store, applied.undo).store, before)
})

// ── 归类 / 新建 / noop ──────────────────────────────────────────

test('归类 plan 应用与 undo', () => {
  const store = fixture()
  const before = clone(store)
  const plan = planOrganize(store, { action: 'assign', sessionId: 's4', categoryId: 'c-work' }).plan
  const applied = applyPlan(store, plan)
  assert.equal(catOf(applied.store, 's4'), 'c-work')
  assert.deepEqual(undoOrganize(applied.store, applied.undo).store, before)
})

test('归类到不存在的分类返回错误', () => {
  const r = planOrganize(fixture(), { action: 'assign', sessionId: 's1', categoryId: 'c-missing' })
  assert.ok(r.error)
})

test('同一归类是 noop，删除不存在的分类也是 noop', () => {
  assert.equal(planOrganize(fixture(), { action: 'assign', sessionId: 's1', categoryId: 'c-work' }).noop, true)
  assert.equal(planOrganize(fixture(), { action: 'delete', id: 'c-missing' }).noop, true)
  assert.equal(planOrganize(fixture(), { action: 'merge', ids: ['c-other'] }).noop, true)
})

test('新建分类 plan 应用幂等，undo 删除', () => {
  const store = fixture()
  const before = clone(store)
  const plan = planOrganize(store, { action: 'upsert', name: '新分类', parentId: 'c-work' }).plan
  assert.match(plan.id, /^c-[0-9a-z]{6}$/)
  const applied = applyPlan(store, plan)
  assert.equal(find(applied.store, plan.id).name, '新分类')
  const twice = applyPlan(applied.store, plan)
  assert.deepEqual(twice.store, applied.store)
  assert.deepEqual(undoOrganize(applied.store, applied.undo).store, before)
})

test('重命名 plan 应用与 undo', () => {
  const store = fixture()
  const before = clone(store)
  const plan = planOrganize(store, { action: 'upsert', id: 'c-other', name: '改名' }).plan
  const applied = applyPlan(store, plan)
  assert.equal(find(applied.store, 'c-other').name, '改名')
  assert.deepEqual(undoOrganize(applied.store, applied.undo).store, before)
})

// ── 非法输入、纯净性、describeUndo ───────────────────────────────

test('非法 op 返回错误且不抛异常', () => {
  assert.doesNotThrow(() => {
    for (const op of [null, undefined, 42, 'x', [], {}, { action: 'no-such-action' }]) {
      const r = planOrganize(fixture(), op)
      assert.ok(r.error, `op=${JSON.stringify(op)} 应报错`)
      assert.equal(r.plan, null)
    }
  })
})

test('非法 plan 应用不崩，store 不变', () => {
  const store = fixture()
  const before = clone(store)
  assert.doesNotThrow(() => {
    for (const plan of [null, undefined, 42, {}, { action: 'no-such-action' }]) {
      const r = applyPlan(store, plan)
      assert.deepEqual(r.store, before)
      assert.ok(r.undo)
    }
  })
})

test('planOrganize/applyPlan 都不修改入参（冻结输入也不崩）', () => {
  const store = deepFreeze(fixture())
  const op = deepFreeze({ action: 'merge', ids: Object.freeze(['c-work', 'c-other']), name: '合并后' })
  const before = clone(store)
  let plan = null
  assert.doesNotThrow(() => {
    plan = planOrganize(store, op).plan
    deepFreeze(plan)
    applyPlan(store, plan)
    undoOrganize(store, null)
    describeUndo(null)
  })
  assert.deepEqual(store, before)
})

test('undoOrganize 对空 undo 不崩，store 不变', () => {
  const store = fixture()
  assert.deepEqual(undoOrganize(store, null).store, store)
  assert.deepEqual(undoOrganize(store, { kind: 'noop' }).store, store)
})

test('describeUndo 生成中文短句，覆盖 organize 与 category-store 的 undo', () => {
  const store = fixture()
  const plan = planOrganize(store, { action: 'merge', ids: ['c-work', 'c-other'], name: '合并后' }).plan
  const applied = applyPlan(store, plan)
  const text = describeUndo(applied.undo)
  assert.equal(typeof text, 'string')
  assert.match(text, /合并/)
  assert.match(text, /工作/)
  assert.match(text, /合并后/)

  const moved = applyPlan(store, planOrganize(store, { action: 'move', id: 'c-other', parentId: 'c-work' }).plan)
  assert.match(describeUndo(moved.undo), /^移动/)
  assert.match(describeUndo(moved.undo), /其他/)

  const mergedByStore = mergeCategories(store, ['c-work', 'c-other'], '直接合并', 'user')
  assert.match(describeUndo(mergedByStore.undo), /合并/)
  assert.equal(describeUndo(null), '无可撤销的操作')
  assert.equal(describeUndo({ kind: 'unknown' }), '撤销整理')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exitCode = 1
}
