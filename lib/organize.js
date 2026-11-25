/**
 * 整理计划：把「改名 / 移动 / 合并 / 拆分 / 归类 / 删除」变成可预览、
 * 可序列化、可撤销的纯计划。
 *
 * 与 category-store 的分工：
 *   - category-store 是数据层，负责单步写与精确 undo；
 *   - 本模块是操作层，负责**先算后写**：planOrganize 不动 store，
 *     applyPlan 才落盘，并且同一个 plan 重复应用结果相同。
 *
 * 本模块同样**没有任何 import**，Host 与客户端可以直接共用。
 * 规范 op 键是 `kind`（兼容 action / type / op）：
 * ```
 * { kind:'merge', ids:[...], name }
 * { kind:'move', id, parentId }
 * { kind:'split', id, moves:[{sessionId,toId}] }
 * { kind:'assign', sessionId, categoryId }   // categoryId:null 取消归类
 * { kind:'upsert', id?, name, parentId? }
 * { kind:'delete', id }
 * ```
 *
 * @module dsh-topic-map/organize
 */

const VERSION = 1
const ID_PREFIX = 'c-'
const ID_LENGTH = 6
const ID_SPACE = 36 ** ID_LENGTH
const SOURCE_USER = 'user'
const SOURCE_MODEL = 'model'

const CATEGORY_KNOWN_KEYS = new Set(['id', 'name', 'parentId', 'source'])
const ACTION_KNOWN_KEYS = new Set([
  'kind', 'action', 'type', 'op', 'source',
  'id', 'name', 'parentId',
  'sessionId', 'categoryId',
  'ids', 'moves',
])

// ── 基础工具（与 category-store 同构，刻意不 import） ──────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSource(source, fallback = SOURCE_USER) {
  return source === SOURCE_USER || source === SOURCE_MODEL ? source : fallback
}

function canonicalName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
}

function normalizeParentId(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false, value: null }
  const value = raw.trim()
  return { ok: true, value: value === '' ? null : value }
}

function normalizeAssignment(raw) {
  if (typeof raw === 'string') {
    const categoryId = raw.trim()
    return categoryId === '' ? null : { categoryId, source: SOURCE_USER }
  }
  if (!isPlainObject(raw)) return null
  const categoryId = typeof raw.categoryId === 'string'
    ? raw.categoryId.trim()
    : typeof raw.id === 'string' ? raw.id.trim() : ''
  if (categoryId === '') return null
  return { categoryId, source: normalizeSource(raw.source, SOURCE_USER) }
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = cloneValue(item)
    return out
  }
  return value
}

function pickExtras(source, excluded) {
  const extras = {}
  if (!isPlainObject(source)) return extras
  for (const [key, value] of Object.entries(source)) {
    if (excluded.has(key)) continue
    extras[key] = cloneValue(value)
  }
  return extras
}

function cloneCategories(categories) {
  return categories.map(category => cloneValue(category))
}

function cloneAssignments(assignments) {
  const out = {}
  for (const [sessionId, assignment] of Object.entries(assignments)) {
    out[sessionId] = { categoryId: assignment.categoryId, source: assignment.source }
  }
  return out
}

function cloneStore(store) {
  return {
    version: VERSION,
    categories: cloneCategories(store.categories),
    assignments: cloneAssignments(store.assignments),
  }
}

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function stableCategoryId(name, parentId) {
  const key = `${canonicalName(name)}\u0000${parentId ?? ''}`
  return ID_PREFIX + (fnv1a(key) % ID_SPACE).toString(36).padStart(ID_LENGTH, '0')
}

function freeCategoryId(categories, name, parentId) {
  const key = `${canonicalName(name)}\u0000${parentId ?? ''}`
  for (let salt = 0; salt < 64; salt += 1) {
    const candidate = salt === 0
      ? stableCategoryId(name, parentId)
      : ID_PREFIX + (fnv1a(`${key}\u0001${salt}`) % ID_SPACE).toString(36).padStart(ID_LENGTH, '0')
    const existing = categories.find(c => c.id === candidate)
    if (!existing) return candidate
    if (canonicalName(existing.name) === canonicalName(name) && (existing.parentId ?? null) === (parentId ?? null)) {
      return candidate
    }
  }
  return ID_PREFIX + (fnv1a(`${key}\u0001overflow`) % ID_SPACE).toString(36).padStart(ID_LENGTH, '0')
}

function findCategory(store, id) {
  return store.categories.find(c => c.id === id) ?? null
}

function isDescendant(categories, candidateParentId, ancestorId) {
  const parentOf = new Map(categories.map(c => [c.id, c.parentId]))
  const seen = new Set()
  let current = candidateParentId
  while (current) {
    if (current === ancestorId) return true
    if (seen.has(current)) return false
    seen.add(current)
    current = parentOf.get(current) ?? null
  }
  return false
}

/** 与 category-store 同口径的宽容归一化；扩展字段原样保留。 */
function normalizeStore(store) {
  if (!isPlainObject(store)) return { version: VERSION, categories: [], assignments: {} }

  const categories = []
  const seen = new Set()
  for (const raw of Array.isArray(store.categories) ? store.categories : []) {
    if (!isPlainObject(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const parent = normalizeParentId(raw.parentId)
    categories.push({
      ...pickExtras(raw, CATEGORY_KNOWN_KEYS),
      id,
      name: typeof raw.name === 'string' ? raw.name : '',
      parentId: parent.ok ? parent.value : null,
      source: normalizeSource(raw.source, SOURCE_MODEL),
    })
  }

  const ids = new Set(categories.map(c => c.id))
  for (const category of categories) {
    if (category.parentId !== null && !ids.has(category.parentId)) category.parentId = null
  }

  const parentOf = new Map(categories.map(c => [c.id, c.parentId]))
  for (const category of categories) {
    const chain = new Set([category.id])
    let parent = parentOf.get(category.id) ?? null
    while (parent !== null) {
      if (chain.has(parent)) {
        category.parentId = null
        parentOf.set(category.id, null)
        break
      }
      chain.add(parent)
      parent = parentOf.get(parent) ?? null
    }
  }

  const assignments = {}
  if (isPlainObject(store.assignments)) {
    for (const [rawSessionId, raw] of Object.entries(store.assignments)) {
      const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
      if (sessionId === '') continue
      const assignment = normalizeAssignment(raw)
      if (assignment) assignments[sessionId] = assignment
    }
  }

  return { version: VERSION, categories, assignments }
}

function sameValue(a, b) {
  if (a === b) return true
  if (a === null || b === null || typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameValue(item, b[index]))
  }
  if (typeof a === 'object') {
    const keysA = Object.keys(a).sort()
    const keysB = Object.keys(b).sort()
    if (keysA.length !== keysB.length) return false
    return keysA.every((key, index) => key === keysB[index] && sameValue(a[key], b[key]))
  }
  return false
}

function storesEqual(a, b) {
  if (a.categories.length !== b.categories.length) return false
  for (let i = 0; i < a.categories.length; i += 1) {
    if (!sameValue(a.categories[i], b.categories[i])) return false
  }
  const keysA = Object.keys(a.assignments).sort()
  const keysB = Object.keys(b.assignments).sort()
  if (keysA.length !== keysB.length) return false
  for (let i = 0; i < keysA.length; i += 1) {
    if (keysA[i] !== keysB[i]) return false
    if (!sameValue(a.assignments[keysA[i]], b.assignments[keysB[i]])) return false
  }
  return true
}

function normalizeAction(value) {
  if (typeof value !== 'string') return ''
  const key = value.trim().toLowerCase()
  const map = {
    assign: 'assign',
    'assign-session': 'assign',
    assignsession: 'assign',
    classify: 'assign',
    unassign: 'assign',
    upsert: 'upsert',
    'upsert-category': 'upsert',
    upsertcategory: 'upsert',
    create: 'upsert',
    add: 'upsert',
    rename: 'upsert',
    move: 'move',
    'move-category': 'move',
    movecategory: 'move',
    merge: 'merge',
    'merge-category': 'merge',
    'merge-categories': 'merge',
    mergecategory: 'merge',
    mergecategories: 'merge',
    split: 'split',
    'split-category': 'split',
    splitcategory: 'split',
    delete: 'delete',
    'delete-category': 'delete',
    deletecategory: 'delete',
    remove: 'delete',
    dissolve: 'delete',
  }
  return map[key] ?? ''
}

/** 规范键 kind 优先，其次兼容 action / type / op。 */
function actionOf(raw) {
  if (!isPlainObject(raw)) return ''
  for (const key of ['kind', 'action', 'type', 'op']) {
    const action = normalizeAction(raw[key])
    if (action !== '') return action
  }
  return ''
}

function sourceOf(raw) {
  return isPlainObject(raw) ? normalizeSource(raw.source, SOURCE_USER) : SOURCE_USER
}

// ── 计划构建（只读 store） ─────────────────────────────────────────

function buildAssignDraft(base, op) {
  const sessionId = typeof op.sessionId === 'string' ? op.sessionId.trim() : ''
  if (sessionId === '') return { error: '缺少会话 id' }

  let categoryId = null
  if (op.categoryId !== undefined && op.categoryId !== null && op.categoryId !== '') {
    if (typeof op.categoryId !== 'string') return { error: '分类 id 无效' }
    categoryId = op.categoryId.trim()
    if (categoryId === '') categoryId = null
    if (categoryId !== null && !findCategory(base, categoryId)) {
      return { error: `分类不存在：${categoryId}` }
    }
  }

  return {
    draft: {
      action: 'assign',
      source: sourceOf(op),
      sessionId,
      categoryId,
    },
  }
}

function buildUpsertDraft(base, op) {
  const source = sourceOf(op)
  const hasName = Object.prototype.hasOwnProperty.call(op, 'name')
  if (hasName && typeof op.name !== 'string') return { error: '分类名必须是字符串' }
  const name = hasName ? canonicalName(op.name) : ''

  if (op.id !== undefined && op.id !== null && typeof op.id !== 'string') {
    return { error: '分类 id 必须是字符串' }
  }
  let id = typeof op.id === 'string' ? op.id.trim() : ''
  const existing = id === '' ? null : findCategory(base, id)

  const hasParent = Object.prototype.hasOwnProperty.call(op, 'parentId')
  const parentResult = normalizeParentId(op.parentId)
  if (!parentResult.ok) return { error: '父分类 id 无效' }
  let parentId = parentResult.value

  if (id === '') {
    if (name === '') return { error: '分类名不能为空' }
    if (parentId !== null && !findCategory(base, parentId)) {
      return { error: `父分类不存在：${parentId}` }
    }
    id = freeCategoryId(base.categories, name, parentId)
  } else if (!existing) {
    if (name === '') return { error: '分类名不能为空' }
  }

  if (!hasParent && existing) parentId = existing.parentId
  if (!hasParent && !existing) parentId = null

  if (parentId !== null) {
    if (parentId === id) return { error: '分类不能挂到自己下面' }
    if (!findCategory(base, parentId)) return { error: `父分类不存在：${parentId}` }
    if (isDescendant(base.categories, parentId, id)) return { error: '父子关系会形成循环' }
  }

  return {
    draft: {
      action: 'upsert',
      source,
      id,
      name,
      hasName: hasName && name !== '',
      parentId,
      hasParent,
      priorName: existing ? existing.name : null,
      // order / createdAt 等字段：创建时带过去，后续重放也保持一致。
      extras: pickExtras(op, ACTION_KNOWN_KEYS),
    },
  }
}

function buildMoveDraft(base, op) {
  const id = typeof op.id === 'string' ? op.id.trim() : ''
  if (id === '') return { error: '缺少分类 id' }
  if (!findCategory(base, id)) return { error: `分类不存在：${id}` }

  const parentResult = normalizeParentId(op.parentId)
  if (!parentResult.ok) return { error: '父分类 id 无效' }
  const parentId = parentResult.value
  if (parentId !== null) {
    if (parentId === id) return { error: '分类不能挂到自己下面' }
    if (!findCategory(base, parentId)) return { error: `父分类不存在：${parentId}` }
    if (isDescendant(base.categories, parentId, id)) return { error: '父子关系会形成循环' }
  }

  return { draft: { action: 'move', source: sourceOf(op), id, parentId } }
}

function buildMergeDraft(base, op) {
  if (!Array.isArray(op.ids)) return { error: '分类 id 列表无效' }
  const ids = []
  for (const raw of op.ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  if (ids.length === 0) return { error: '至少需要一个分类 id' }
  for (const id of ids) {
    if (!findCategory(base, id)) return { error: `分类不存在：${id}` }
  }
  if (op.name !== undefined && typeof op.name !== 'string') return { error: '分类名必须是字符串' }
  return {
    draft: {
      action: 'merge',
      source: sourceOf(op),
      ids,
      targetId: ids[0],
      name: typeof op.name === 'string' ? canonicalName(op.name) : '',
    },
  }
}

function buildSplitDraft(base, op) {
  const id = typeof op.id === 'string' ? op.id.trim() : ''
  if (id === '') return { error: '缺少分类 id' }
  if (!findCategory(base, id)) return { error: `分类不存在：${id}` }
  if (!Array.isArray(op.moves)) return { error: '拆分项必须是数组' }

  const seen = new Set()
  const moves = []
  for (const raw of op.moves) {
    if (!isPlainObject(raw)) return { error: '拆分项无效' }
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
    if (sessionId === '') return { error: '拆分项缺少会话 id' }
    const toId = typeof raw.toId === 'string' ? raw.toId.trim() : ''
    if (toId === '') return { error: '拆分项缺少目标分类' }
    if (toId === id) continue
    if (!findCategory(base, toId)) return { error: `目标分类不存在：${toId}` }
    if (seen.has(sessionId)) continue
    const current = base.assignments[sessionId]
    if (!current || current.categoryId !== id) continue
    seen.add(sessionId)
    moves.push({ sessionId, toId })
  }

  if (moves.length === 0) return { noop: true, reason: '没有可移动的会话' }
  return { draft: { action: 'split', source: sourceOf(op), id, moves } }
}

function buildDeleteDraft(base, op) {
  const id = typeof op.id === 'string' ? op.id.trim() : ''
  if (id === '') return { error: '缺少分类 id' }
  if (!findCategory(base, id)) return { noop: true, reason: '分类已不存在' }
  return { draft: { action: 'delete', source: sourceOf(op), id } }
}

function buildDraft(base, op, action) {
  switch (action) {
    case 'assign': return buildAssignDraft(base, op)
    case 'upsert': return buildUpsertDraft(base, op)
    case 'move': return buildMoveDraft(base, op)
    case 'merge': return buildMergeDraft(base, op)
    case 'split': return buildSplitDraft(base, op)
    case 'delete': return buildDeleteDraft(base, op)
    default: return { error: '未知的整理操作' }
  }
}

// ── 执行（应用与预演共用） ────────────────────────────────────────

function validateParent(store, id, parentId) {
  if (parentId === null) return null
  if (parentId === id) return '分类不能挂到自己下面'
  if (!findCategory(store, parentId)) return `父分类不存在：${parentId}`
  if (isDescendant(store.categories, parentId, id)) return '父子关系会形成循环'
  return null
}

function executeAssign(next, plan) {
  const sessionId = typeof plan.sessionId === 'string' ? plan.sessionId.trim() : ''
  if (sessionId === '') return { store: next, changed: false, error: '缺少会话 id' }

  const source = normalizeSource(plan.source, SOURCE_USER)
  const target = plan.categoryId ?? null
  const existing = next.assignments[sessionId] ?? null

  if (existing && existing.source === SOURCE_USER && source === SOURCE_MODEL) {
    return { store: next, changed: false, error: '人工归类不会被模型覆盖' }
  }

  if (target === null) {
    if (!existing) return { store: next, changed: false }
    delete next.assignments[sessionId]
    return { store: next, changed: true }
  }

  const categoryId = typeof target === 'string' ? target.trim() : ''
  if (categoryId === '' || !findCategory(next, categoryId)) {
    return { store: next, changed: false, error: `分类不存在：${String(target)}` }
  }
  if (existing && existing.categoryId === categoryId && existing.source === source) {
    return { store: next, changed: false }
  }
  next.assignments[sessionId] = { categoryId, source }
  return { store: next, changed: true }
}

function executeUpsert(next, plan) {
  const id = typeof plan.id === 'string' ? plan.id.trim() : ''
  if (id === '') return { store: next, changed: false, error: '分类 id 无效' }
  const source = normalizeSource(plan.source, SOURCE_USER)
  const name = typeof plan.name === 'string' ? canonicalName(plan.name) : ''
  const extras = isPlainObject(plan.extras) ? plan.extras : {}
  const existing = findCategory(next, id)

  if (!existing) {
    if (name === '') return { store: next, changed: false, error: '分类名不能为空' }
    const parentId = typeof plan.parentId === 'string' ? plan.parentId : null
    if (parentId !== null && !findCategory(next, parentId)) {
      return { store: next, changed: false, error: `父分类不存在：${parentId}` }
    }
    next.categories.push({
      ...cloneValue(extras),
      id,
      name,
      parentId,
      source,
    })
    return { store: next, changed: true }
  }

  let changed = false
  if (plan.hasName && name !== '' && name !== existing.name) {
    if (existing.source === SOURCE_USER && source === SOURCE_MODEL) {
      // 人工名称优先；不报错，只是这一项不写。
    } else {
      existing.name = name
      changed = true
    }
  }

  if (plan.hasParent) {
    const parentId = normalizeParentId(plan.parentId).value
    if ((existing.parentId ?? null) !== parentId) {
      const error = validateParent(next, id, parentId)
      if (error) return { store: next, changed: false, error }
      existing.parentId = parentId
      changed = true
    }
  }

  if (source === SOURCE_USER && existing.source !== SOURCE_USER) {
    existing.source = SOURCE_USER
    changed = true
  }

  if (changed) Object.assign(existing, cloneValue(extras))
  return { store: next, changed }
}

function executeMove(next, plan) {
  const id = typeof plan.id === 'string' ? plan.id.trim() : ''
  const category = findCategory(next, id)
  if (!category) return { store: next, changed: false, error: `分类不存在：${id}` }
  const parentId = normalizeParentId(plan.parentId).value
  if ((category.parentId ?? null) === parentId) return { store: next, changed: false }
  const error = validateParent(next, id, parentId)
  if (error) return { store: next, changed: false, error }
  category.parentId = parentId
  return { store: next, changed: true }
}

function executeMerge(next, plan) {
  const ids = []
  for (const raw of Array.isArray(plan.ids) ? plan.ids : []) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  const targetId = typeof plan.targetId === 'string' ? plan.targetId : ids[0]
  const target = targetId === undefined ? null : findCategory(next, targetId)
  if (!target) return { store: next, changed: false }

  const source = normalizeSource(plan.source, SOURCE_USER)
  const name = typeof plan.name === 'string' ? canonicalName(plan.name) : ''
  let changed = false

  if (name !== '' && name !== target.name && !(target.source === SOURCE_USER && source === SOURCE_MODEL)) {
    target.name = name
    changed = true
  }

  const removedIds = new Set(ids.filter(id => id !== target.id && findCategory(next, id)))
  if (removedIds.size > 0) {
    const parentOf = new Map(next.categories.map(c => [c.id, c.parentId]))
    const ancestorsOfTarget = new Set()
    {
      const seen = new Set()
      let parent = parentOf.get(target.id) ?? null
      while (parent !== null && !seen.has(parent)) {
        ancestorsOfTarget.add(parent)
        seen.add(parent)
        parent = parentOf.get(parent) ?? null
      }
    }
    let survivingParent = parentOf.get(target.id) ?? null
    {
      const seen = new Set()
      while (survivingParent !== null && removedIds.has(survivingParent)) {
        if (seen.has(survivingParent)) { survivingParent = null; break }
        seen.add(survivingParent)
        survivingParent = parentOf.get(survivingParent) ?? null
      }
    }

    target.parentId = survivingParent
    for (const category of next.categories) {
      if (category.id === target.id || removedIds.has(category.id)) continue
      if (category.parentId === null || !removedIds.has(category.parentId)) continue
      // target 的祖先要抬到幸存父级，不能挂回 target（会成环）。
      category.parentId = ancestorsOfTarget.has(category.id) ? survivingParent : target.id
    }

    next.categories = next.categories.filter(c => !removedIds.has(c.id))
    for (const assignment of Object.values(next.assignments)) {
      if (removedIds.has(assignment.categoryId)) assignment.categoryId = target.id
    }
    changed = true
  }

  if (changed && source === SOURCE_USER && target.source !== SOURCE_USER) {
    target.source = SOURCE_USER
  }
  return { store: next, changed }
}

function executeSplit(next, plan) {
  const sourceId = typeof plan.id === 'string' ? plan.id.trim() : ''
  if (sourceId === '') return { store: next, changed: false, error: '分类 id 无效' }
  if (!findCategory(next, sourceId)) {
    // 已经应用过（来源分类在拆分后删除）时是幂等 no-op。
    return { store: next, changed: false }
  }

  let applied = 0
  for (const move of Array.isArray(plan.moves) ? plan.moves : []) {
    if (!isPlainObject(move)) continue
    const sessionId = typeof move.sessionId === 'string' ? move.sessionId.trim() : ''
    const toId = typeof move.toId === 'string' ? move.toId.trim() : ''
    if (sessionId === '' || toId === '') continue
    if (!findCategory(next, toId)) {
      return { store: next, changed: false, error: `目标分类不存在：${toId}` }
    }
    const current = next.assignments[sessionId]
    if (!current || current.categoryId !== sourceId) continue
    next.assignments[sessionId] = { categoryId: toId, source: SOURCE_USER }
    applied += 1
  }

  if (applied === 0) return { store: next, changed: false }

  const stillHasSessions = Object.values(next.assignments).some(a => a.categoryId === sourceId)
  const stillHasChildren = next.categories.some(c => c.parentId === sourceId)
  if (!stillHasSessions && !stillHasChildren) {
    next.categories = next.categories.filter(c => c.id !== sourceId)
  }
  return { store: next, changed: true }
}

function executeDelete(next, plan) {
  const id = typeof plan.id === 'string' ? plan.id.trim() : ''
  const category = findCategory(next, id)
  if (!category) return { store: next, changed: false }

  const parentId = category.parentId
  next.categories = next.categories.filter(c => c.id !== id)
  for (const child of next.categories) {
    if (child.parentId === id) child.parentId = parentId
  }
  for (const [sessionId, assignment] of Object.entries(next.assignments)) {
    if (assignment.categoryId === id) delete next.assignments[sessionId]
  }
  return { store: next, changed: true }
}

function execute(store, plan) {
  const action = actionOf(plan)
  if (action === '') return { store: store, changed: false, error: '未知的整理操作' }
  const next = cloneStore(store)
  switch (action) {
    case 'assign': return executeAssign(next, plan)
    case 'upsert': return executeUpsert(next, plan)
    case 'move': return executeMove(next, plan)
    case 'merge': return executeMerge(next, plan)
    case 'split': return executeSplit(next, plan)
    case 'delete': return executeDelete(next, plan)
    default: return { store: store, changed: false, error: '未知的整理操作' }
  }
}

// ── 预览信息 ──────────────────────────────────────────────────────

function lostAssignmentCount(before, after) {
  let lost = 0
  for (const [sessionId, assignment] of Object.entries(before.assignments)) {
    if (!findCategory(before, assignment.categoryId)) continue
    const next = after.assignments[sessionId] ?? null
    if (!next || !findCategory(after, next.categoryId)) lost += 1
  }
  return lost
}

function summarize(plan, base) {
  const nameOf = id => {
    const category = findCategory(base, id)
    return category && canonicalName(category.name) !== '' ? category.name : id
  }

  switch (plan.action) {
    case 'merge': {
      const names = plan.ids.map(nameOf)
      return plan.name !== ''
        ? `合并 ${names.join('、')} → ${plan.name}`
        : `合并 ${names.join('、')}`
    }
    case 'move': {
      const category = findCategory(base, plan.id)
      const target = plan.parentId === null ? '顶层' : nameOf(plan.parentId)
      return `移动 ${category?.name || plan.id} → ${target}`
    }
    case 'split': {
      const category = findCategory(base, plan.id)
      return `拆分 ${category?.name || plan.id}（移出 ${plan.moves.length} 个会话）`
    }
    case 'assign': {
      if (plan.categoryId === null) return '取消 1 个会话的归类'
      return `归类 1 个会话 → ${nameOf(plan.categoryId)}`
    }
    case 'upsert': {
      if (plan.priorName === null) return `新建分类「${plan.name}」`
      if (plan.name !== '' && plan.name !== plan.priorName) {
        return `重命名「${plan.priorName || plan.id}」→「${plan.name}」`
      }
      return `整理分类「${plan.name || plan.priorName || plan.id}」`
    }
    case 'delete': {
      const category = findCategory(base, plan.id)
      return `删除分类「${category?.name || plan.id}」`
    }
    default:
      return '整理分类'
  }
}

function makePlanId(plan) {
  const payload = {}
  for (const key of Object.keys(plan).sort()) {
    if (key === 'planId' || key === 'summary' || key === 'warnings' || key === 'version') continue
    payload[key] = plan[key]
  }
  const hash = fnv1a(JSON.stringify(payload)) % (36 ** 8)
  return 'p-' + hash.toString(36).padStart(8, '0')
}

// ── 对外 API ──────────────────────────────────────────────────────

/**
 * 计算一个整理计划，不修改 store。
 *
 * @param store - 当前分类 store。
 * @param op - `{kind, ...}`；兼容 `action / type / op` 键。
 * @returns `{plan, warnings}`；无变化时为 `{noop:true, reason}`；非法时为 `{plan:null, error}`。
 */
export function planOrganize(store, op) {
  const base = normalizeStore(store)
  const action = actionOf(op)
  if (action === '') return { plan: null, error: '未知的整理操作' }

  const built = buildDraft(base, op, action)
  if (built.error) return { plan: null, error: built.error }
  if (built.noop) return { noop: true, reason: built.reason ?? '没有需要变更的内容' }

  const draft = built.draft
  const preview = execute(base, draft)
  if (preview.error) return { plan: null, error: preview.error }
  if (!preview.changed || storesEqual(base, preview.store)) {
    return { noop: true, reason: '没有需要变更的内容' }
  }

  const plan = {
    version: VERSION,
    ...draft,
    // 规范键是 kind；action 同时保留，旧调用方与既有测试都还能读。
    kind: action,
    warnings: [],
    summary: '',
    planId: '',
  }

  const lost = lostAssignmentCount(base, preview.store)
  if (lost > 0) plan.warnings.push(`${lost} 个会话将失去归类`)

  plan.summary = summarize(plan, base)
  plan.planId = makePlanId(plan)

  return { plan, warnings: plan.warnings }
}

/**
 * 应用计划。同一 plan 重复应用结果相同。
 *
 * @param store - 当前分类 store。
 * @param plan - `planOrganize` 返回的 plan（可经 JSON 往返）。
 * @returns `{store, undo, error?}`；无变化时 undo.kind === 'noop'。
 */
export function applyPlan(store, plan) {
  const base = normalizeStore(store)
  const action = actionOf(plan)
  if (action === '') {
    return {
      store: base,
      undo: { kind: 'noop', action: '', summary: '无变化' },
      error: '整理计划无效',
    }
  }

  const result = execute(base, plan)
  if (result.error) {
    return {
      store: base,
      undo: { kind: 'noop', action, summary: '无变化' },
      error: result.error,
    }
  }
  if (!result.changed) {
    return { store: base, undo: { kind: 'noop', action, summary: '无变化' } }
  }

  const summary = typeof plan.summary === 'string' && plan.summary.trim() !== ''
    ? plan.summary.trim()
    : summarize({ ...plan, action }, base)

  return {
    store: result.store,
    undo: {
      kind: 'plan',
      action,
      summary,
      before: {
        version: VERSION,
        categories: cloneCategories(base.categories),
        assignments: cloneAssignments(base.assignments),
      },
      warnings: Array.isArray(plan.warnings) ? plan.warnings.slice() : [],
    },
  }
}

// ── 撤销 ──────────────────────────────────────────────────────────

function restoreCategoryAtOrder(next, snapshot, order) {
  if (!isPlainObject(snapshot) || typeof snapshot.id !== 'string') return
  if (next.categories.some(c => c.id === snapshot.id)) return
  const restored = cloneValue(snapshot)
  const rebuilt = []
  let inserted = false
  for (const id of order) {
    if (id === restored.id) {
      rebuilt.push(restored)
      inserted = true
      continue
    }
    const category = next.categories.find(c => c.id === id)
    if (category) rebuilt.push(category)
  }
  if (!inserted) rebuilt.push(restored)
  const used = new Set(rebuilt.map(c => c.id))
  for (const category of next.categories) if (!used.has(category.id)) rebuilt.push(category)
  next.categories = rebuilt
}

function undoMerge(next, undo) {
  const snapshots = new Map()
  if (isPlainObject(undo.target) && typeof undo.target.id === 'string') {
    snapshots.set(undo.target.id, cloneValue(undo.target))
  }
  for (const category of Array.isArray(undo.removed) ? undo.removed : []) {
    if (isPlainObject(category) && typeof category.id === 'string') {
      snapshots.set(category.id, cloneValue(category))
    }
  }

  const order = Array.isArray(undo.order) ? undo.order.filter(id => typeof id === 'string') : []
  const current = new Map(next.categories.map(c => [c.id, c]))
  const rebuilt = []
  const used = new Set()
  for (const id of order) {
    const snapshot = snapshots.get(id)
    if (snapshot) {
      rebuilt.push(snapshot)
      used.add(id)
    } else if (current.has(id)) {
      rebuilt.push(current.get(id))
      used.add(id)
    }
  }
  for (const [id, snapshot] of snapshots) if (!used.has(id)) rebuilt.push(snapshot)
  for (const category of next.categories) if (!used.has(category.id)) rebuilt.push(category)
  next.categories = rebuilt

  if (isPlainObject(undo.assignments)) {
    for (const [sessionId, previous] of Object.entries(undo.assignments)) {
      const assignment = normalizeAssignment(previous)
      if (assignment) next.assignments[sessionId] = assignment
      else delete next.assignments[sessionId]
    }
  }
  return next
}

function undoStructured(base, undo) {
  const next = cloneStore(base)
  switch (undo.kind) {
    case 'merge':
      return undoMerge(next, undo)
    case 'move': {
      const category = findCategory(next, undo.id)
      if (category) {
        const parent = normalizeParentId(undo.from)
        category.parentId = parent.ok ? parent.value : null
      }
      return next
    }
    case 'split': {
      restoreCategoryAtOrder(
        next,
        undo.sourceCategory,
        Array.isArray(undo.order) ? undo.order.filter(id => typeof id === 'string') : [],
      )
      for (const move of Array.isArray(undo.moves) ? undo.moves : []) {
        if (!isPlainObject(move) || typeof move.sessionId !== 'string') continue
        const previous = normalizeAssignment(move.from)
        if (previous) next.assignments[move.sessionId] = previous
        else delete next.assignments[move.sessionId]
      }
      return next
    }
    case 'assignment': {
      if (typeof undo.sessionId === 'string') {
        const previous = normalizeAssignment(undo.before)
        if (previous) next.assignments[undo.sessionId] = previous
        else delete next.assignments[undo.sessionId]
      }
      return next
    }
    case 'upsert': {
      if (typeof undo.id === 'string') {
        if (undo.created) {
          next.categories = next.categories.filter(c => c.id !== undo.id)
        } else if (isPlainObject(undo.before)) {
          const index = next.categories.findIndex(c => c.id === undo.id)
          if (index >= 0) next.categories[index] = cloneValue(undo.before)
          else next.categories.push(cloneValue(undo.before))
        }
      }
      return next
    }
    case 'delete': {
      restoreCategoryAtOrder(
        next,
        undo.category,
        Array.isArray(undo.order) ? undo.order.filter(id => typeof id === 'string') : [],
      )
      if (isPlainObject(undo.assignments)) {
        for (const [sessionId, previous] of Object.entries(undo.assignments)) {
          const assignment = normalizeAssignment(previous)
          if (assignment) next.assignments[sessionId] = assignment
        }
      }
      return next
    }
    default:
      return next
  }
}

/**
 * 撤销 `applyPlan` 返回的 undo（也兼容 category-store 的 merge/move/split undo）。
 *
 * @returns `{store}`；未知 undo 原样返回。
 */
export function undoOrganize(store, undo) {
  const base = normalizeStore(store)
  if (!isPlainObject(undo)) return { store: base }
  if (isPlainObject(undo.before)) return { store: normalizeStore(undo.before) }
  return { store: normalizeStore(undoStructured(base, undo)) }
}

/**
 * 把 undo 记录描述成一句中文，供撤销按钮/历史列表显示。
 *
 * @param undo - `applyPlan` 或 category-store 产出的 undo。
 * @returns 中文短句；非法输入返回「无可撤销的操作」。
 */
export function describeUndo(undo) {
  if (!isPlainObject(undo)) return '无可撤销的操作'
  if (typeof undo.summary === 'string' && undo.summary.trim() !== '') return undo.summary.trim()

  switch (undo.kind) {
    case 'plan': {
      if (typeof undo.action !== 'string') return '撤销整理'
      const labels = {
        assign: '归类调整',
        upsert: '分类整理',
        move: '移动分类',
        merge: '合并分类',
        split: '拆分分类',
        delete: '删除分类',
      }
      return labels[undo.action] ?? '撤销整理'
    }
    case 'merge': {
      const names = []
      if (isPlainObject(undo.target) && typeof undo.target.name === 'string' && undo.target.name !== '') {
        names.push(undo.target.name)
      }
      for (const category of Array.isArray(undo.removed) ? undo.removed : []) {
        if (isPlainObject(category) && typeof category.name === 'string' && category.name !== '') {
          names.push(category.name)
        }
      }
      if (names.length === 0) return '合并分类'
      const target = typeof undo.name === 'string' && undo.name !== '' ? ` → ${undo.name}` : ''
      return `合并 ${names.join('、')}${target}`
    }
    case 'move': {
      if (typeof undo.name === 'string' && undo.name !== '') return `移动 ${undo.name}`
      return `移动 ${typeof undo.id === 'string' && undo.id !== '' ? undo.id : '分类'}`
    }
    case 'split': {
      const name = isPlainObject(undo.sourceCategory) && typeof undo.sourceCategory.name === 'string'
        ? undo.sourceCategory.name
        : typeof undo.id === 'string' ? undo.id : '分类'
      const count = Array.isArray(undo.moves) ? undo.moves.length : 0
      return `拆分 ${name}（移出 ${count} 个会话）`
    }
    case 'noop':
      return '无变化'
    default:
      return '撤销整理'
  }
}
