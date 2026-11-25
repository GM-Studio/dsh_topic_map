/**
 * 分类存储：跨会话归类的纯数据层。
 *
 * 这一个模块同时会被 Host 与客户端使用，所以它刻意**没有任何 import**：
 * 不摸文件系统、不读时钟、不碰 DOM，所有写操作都返回新 store，入参保持不变。
 *
 * 数据形状（version 1）：
 * ```
 * {
 *   version: 1,
 *   categories: [{ id, name, parentId, source }],
 *   assignments: { [sessionId]: { categoryId, source } },
 * }
 * ```
 * - `source` 只有 `'user'` / `'model'`。人工数据优先：模型不能覆盖
 *   `source:'user'` 的分类名，也不能覆盖人工 assignments。
 * - `assignments` 读取时兼容旧形状（值直接是 categoryId 字符串）。
 * - `parentId: null` 表示顶层分类。
 *
 * id 生成规则：缺省 id = `c-` + 6 位 base36，对「规范化名称 + parentId」
 * 做 FNV-1a 哈希。同输入必得同 id，所以重复调用 upsert / 模型重复提案是幂等的。
 *
 * @module dsh-topic-map/category-store
 */

const VERSION = 1
const ID_PREFIX = 'c-'
const ID_LENGTH = 6
const ID_SPACE = 36 ** ID_LENGTH
const SOURCE_USER = 'user'
const SOURCE_MODEL = 'model'

/** 新建空 store。每次返回全新的数组 / 对象，避免调用方共享可变状态。 */
export function emptyStore() {
  return { version: VERSION, categories: [], assignments: {} }
}

// ── 内部工具（不导出） ─────────────────────────────────────────────

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSource(source, fallback = SOURCE_USER) {
  return source === SOURCE_USER || source === SOURCE_MODEL ? source : fallback
}

/** 用作 id 种子与比较的名称：去掉首尾空白，内部连续空白压成一个空格。 */
function canonicalName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
}

function hasName(name) {
  return canonicalName(name) !== ''
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

function cloneAssignment(raw) {
  const assignment = normalizeAssignment(raw)
  return assignment ? { categoryId: assignment.categoryId, source: assignment.source } : null
}

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 稳定短 id：同 name + parentId 必得同 id。 */
function stableCategoryId(name, parentId) {
  const key = `${canonicalName(name)}\u0000${parentId ?? ''}`
  const hash = fnv1a(key) % ID_SPACE
  return ID_PREFIX + hash.toString(36).padStart(ID_LENGTH, '0')
}

/**
 * 生成一个当前 store 里未被占用的稳定 id。
 *
 * 哈希碰撞概率很低，但既然这是持久化 id，就不能假装不存在：
 * 撞到「不同名字的已有分类」时用固定盐重新哈希，仍然保持同输入同结果。
 */
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
  // 理论上到不了这里；仍然返回一个确定性的兜底 id，而不是抛异常。
  return ID_PREFIX + (fnv1a(`${key}\u0001overflow`) % ID_SPACE).toString(36).padStart(ID_LENGTH, '0')
}

function findCategory(store, id) {
  return store.categories.find(c => c.id === id) ?? null
}

/** candidateParentId 是否位于 ancestorId 的子树里（用来拒绝成环）。 */
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

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = cloneValue(item)
    return out
  }
  return value
}

const CATEGORY_KNOWN_KEYS = new Set(['id', 'name', 'parentId', 'source'])

/**
 * 分类上的扩展字段（order / createdAt / 未来字段）原样携带。
 * 这些字段不参与分类逻辑，但另一层可能用来排序或审计，不能在读改写时静默丢掉。
 */
function categoryExtras(raw) {
  const extras = {}
  if (!isPlainObject(raw)) return extras
  for (const [key, value] of Object.entries(raw)) {
    if (CATEGORY_KNOWN_KEYS.has(key)) continue
    extras[key] = cloneValue(value)
  }
  return extras
}

function cloneCategories(categories) {
  return categories.map(category => cloneValue(category))
}

function cloneStore(store) {
  const assignments = {}
  for (const [sessionId, assignment] of Object.entries(store.assignments)) {
    assignments[sessionId] = { categoryId: assignment.categoryId, source: assignment.source }
  }
  return { version: VERSION, categories: cloneCategories(store.categories), assignments }
}

/**
 * 宽容地归一化外部 store：去重、丢掉坏分类、断开自环 / 悬空父级 / 父子环。
 *
 * 这些数据可能来自旧缓存或手改文件，不能直接信任。断环策略是确定性的：
 * 从每个节点向上走，第一次遇到已在链上的节点就把当前节点的 parentId 置空。
 */
function normalizeStore(store) {
  if (!isPlainObject(store)) return emptyStore()

  const categories = []
  const seen = new Set()
  for (const raw of Array.isArray(store.categories) ? store.categories : []) {
    if (!isPlainObject(raw)) continue
    const id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const parent = normalizeParentId(raw.parentId)
    categories.push({
      ...categoryExtras(raw),
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

  // 断环。任何合法树都不会进入这个分支。
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

function snapshotCategories(categories) {
  return cloneCategories(categories)
}

// ── 分类写入 ───────────────────────────────────────────────────────

/**
 * 新增或更新一个分类。
 *
 * - `id` 缺省时按 name + parentId 生成稳定 id；同输入同 id。
 * - `parentId: null` 表示顶层；父级不存在、自引用、成环都返回 error 且不改 store。
 * - 已存在分类只更新传入的字段；`source:'user'` 不会被降级成 model。
 *
 * @param store - 当前 store（不会被修改）。
 * @param input - `{ id?, name, parentId?, source? }`。
 * @returns `{ store, id, error? }`。
 */
export function upsertCategory(store, input) {
  const base = normalizeStore(store)
  if (!isPlainObject(input)) return { store: base, error: '分类参数无效' }

  const source = normalizeSource(input.source, SOURCE_USER)
  const hasNameField = Object.prototype.hasOwnProperty.call(input, 'name')
  const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : ''
  if (hasNameField && typeof input.name !== 'string') {
    return { store: base, error: '分类名必须是字符串' }
  }

  const parentResult = normalizeParentId(input.parentId)
  if (!parentResult.ok) return { store: base, error: '父分类 id 无效' }
  const parentId = parentResult.value

  const hasParentField = Object.prototype.hasOwnProperty.call(input, 'parentId')
  let id = typeof input.id === 'string' ? input.id.trim() : ''
  if (input.id !== undefined && input.id !== null && typeof input.id !== 'string') {
    return { store: base, error: '分类 id 必须是字符串' }
  }

  if (id === '') {
    if (name === '') return { store: base, error: '分类名不能为空' }
    if (parentId !== null && !findCategory(base, parentId)) {
      return { store: base, error: `父分类不存在：${parentId}` }
    }
    id = freeCategoryId(base.categories, name, parentId)
  }

  if (parentId !== null) {
    if (parentId === id) return { store: base, error: '分类不能挂到自己下面' }
    if (!findCategory(base, parentId)) {
      return { store: base, error: `父分类不存在：${parentId}` }
    }
    if (isDescendant(base.categories, parentId, id)) {
      return { store: base, error: '父子关系会形成循环' }
    }
  }

  const next = cloneStore(base)
  const extras = categoryExtras(input)
  const existing = findCategory(next, id)
  if (existing) {
    if (hasNameField && name !== '') existing.name = name
    if (hasParentField) existing.parentId = parentId
    Object.assign(existing, extras)
    // 人工数据只升不降：已标 user 的分类不会被 model 写回 model。
    if (source === SOURCE_USER) existing.source = SOURCE_USER
  } else {
    if (name === '') return { store: base, error: '分类名不能为空' }
    next.categories.push({ ...extras, id, name, parentId, source })
  }

  return { store: next, id }
}

// ── 会话归类 ───────────────────────────────────────────────────────

/**
 * 给会话指定分类；`categoryId` 传 null 表示取消归类。
 *
 * 人工优先：已有 `source:'user'` 的归类，模型既不能改到别的分类，也不能取消。
 *
 * @param store - 当前 store。
 * @param sessionId - 会话 id。
 * @param categoryId - 目标分类 id 或 null。
 * @param source - `'user' | 'model'`，缺省 user。
 * @returns `{ store, error? }`。
 */
export function assignSession(store, sessionId, categoryId, source) {
  const base = normalizeStore(store)
  const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (sid === '') return { store: base, error: '会话 id 无效' }

  const src = normalizeSource(source, SOURCE_USER)
  let nextCategoryId = null
  if (categoryId !== undefined && categoryId !== null && categoryId !== '') {
    if (typeof categoryId !== 'string') return { store: base, error: '分类 id 无效' }
    nextCategoryId = categoryId.trim()
    if (nextCategoryId === '') nextCategoryId = null
    if (nextCategoryId !== null && !findCategory(base, nextCategoryId)) {
      return { store: base, error: `分类不存在：${nextCategoryId}` }
    }
  }

  const previous = base.assignments[sid] ?? null
  if (previous && previous.source === SOURCE_USER && src === SOURCE_MODEL) {
    return { store: base, error: '人工归类不会被模型覆盖' }
  }

  const next = cloneStore(base)
  if (nextCategoryId === null) delete next.assignments[sid]
  else next.assignments[sid] = { categoryId: nextCategoryId, source: src }
  return { store: next }
}

// ── 合并 / 移动 / 拆分 ─────────────────────────────────────────────

/**
 * 把多个分类并成一个：复用第一个 id，其余分类的会话与子分类迁过去。
 *
 * undo 记录被删分类的快照、目标原快照、原始顺序与每个被改动的 assignment，
 * 足以精确还原到合并前。
 *
 * @param store - 当前 store。
 * @param ids - 分类 id 数组（去重，至少一个）。
 * @param name - 合并后的名字；缺省保留目标原名。
 * @param source - `'user' | 'model'`，缺省 user。
 * @returns `{ store, undo, error? }`。
 */
export function mergeCategories(store, ids, name, source) {
  const base = normalizeStore(store)
  if (!Array.isArray(ids)) return { store: base, error: '分类 id 列表无效' }

  const list = []
  for (const raw of ids) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id !== '' && !list.includes(id)) list.push(id)
  }
  if (list.length === 0) return { store: base, error: '至少需要一个分类 id' }
  for (const id of list) {
    if (!findCategory(base, id)) return { store: base, error: `分类不存在：${id}` }
  }

  const src = normalizeSource(source, SOURCE_USER)
  const targetSnapshot = cloneCategories([findCategory(base, list[0])])[0]
  const removedIds = new Set(list.slice(1))
  const targetParentOf = new Map(base.categories.map(c => [c.id, c.parentId]))

  // target 的父级若也被并掉，就一路向上找最近的幸存祖先。
  const ancestorsOfTarget = new Set()
  {
    const seen = new Set()
    let parent = targetParentOf.get(list[0]) ?? null
    while (parent !== null && !seen.has(parent)) {
      ancestorsOfTarget.add(parent)
      seen.add(parent)
      parent = targetParentOf.get(parent) ?? null
    }
  }
  let survivingParent = targetParentOf.get(list[0]) ?? null
  {
    const seen = new Set()
    while (survivingParent !== null && removedIds.has(survivingParent)) {
      if (seen.has(survivingParent)) { survivingParent = null; break }
      seen.add(survivingParent)
      survivingParent = targetParentOf.get(survivingParent) ?? null
    }
  }

  const next = cloneStore(base)
  const target = findCategory(next, list[0])
  const mergedName = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : ''
  if (mergedName !== '') {
    // 人工名不会被模型合并改名；合并本身仍然进行。
    if (!(target.source === SOURCE_USER && src === SOURCE_MODEL)) target.name = mergedName
  }
  if (src === SOURCE_USER) target.source = SOURCE_USER
  target.parentId = survivingParent

  for (const category of next.categories) {
    if (category.id === target.id || removedIds.has(category.id)) continue
    if (category.parentId === null || !removedIds.has(category.parentId)) continue
    // target 的祖先必须挂到幸存父级，否则会形成 target → 子 → target 的环。
    category.parentId = ancestorsOfTarget.has(category.id) ? survivingParent : target.id
  }

  next.categories = next.categories.filter(c => !removedIds.has(c.id))

  const changedAssignments = {}
  for (const [sessionId, assignment] of Object.entries(next.assignments)) {
    if (!removedIds.has(assignment.categoryId)) continue
    changedAssignments[sessionId] = { categoryId: assignment.categoryId, source: assignment.source }
    assignment.categoryId = target.id
  }

  const undo = {
    kind: 'merge',
    ids: list.slice(),
    targetId: target.id,
    target: targetSnapshot,
    removed: list.slice(1).map(id => cloneCategories([findCategory(base, id)])[0]),
    order: base.categories.map(c => c.id),
    assignments: changedAssignments,
    // 给 describeUndo 用的可读信息；category-store 自己不用它。
    summary: `合并 ${[targetSnapshot.name, ...list.slice(1).map(id => findCategory(base, id).name)].filter(Boolean).join('、')} → ${target.name || '新分类'}`,
  }

  return { store: next, undo }
}

/**
 * 把一个分类挂到新的父分类下；`parentId: null` 表示移到顶层。
 *
 * @returns `{ store, undo, error? }`。
 */
export function moveCategory(store, id, parentId) {
  const base = normalizeStore(store)
  const categoryId = typeof id === 'string' ? id.trim() : ''
  if (categoryId === '') return { store: base, error: '分类 id 无效' }
  const category = findCategory(base, categoryId)
  if (!category) return { store: base, error: `分类不存在：${categoryId}` }

  const parentResult = normalizeParentId(parentId)
  if (!parentResult.ok) return { store: base, error: '父分类 id 无效' }
  const nextParentId = parentResult.value

  if (nextParentId !== null) {
    if (nextParentId === categoryId) return { store: base, error: '分类不能挂到自己下面' }
    if (!findCategory(base, nextParentId)) return { store: base, error: `父分类不存在：${nextParentId}` }
    if (isDescendant(base.categories, nextParentId, categoryId)) {
      return { store: base, error: '父子关系会形成循环' }
    }
  }

  const next = cloneStore(base)
  const target = findCategory(next, categoryId)
  const undo = {
    kind: 'move',
    id: categoryId,
    from: target.parentId,
    to: nextParentId,
    name: target.name,
    summary: `移动 ${target.name || categoryId} → ${nextParentId === null ? '顶层' : (findCategory(base, nextParentId)?.name || nextParentId)}`,
  }
  target.parentId = nextParentId
  return { store: next, undo }
}

/**
 * 把来源分类里的指定会话拆到别的分类；来源分类空了（无会话、无子分类）就删除。
 *
 * 只移动当前确实挂在 `id` 下的会话，避免误伤已经人工改到别处的归类。
 * `toId` 必须指向已存在的分类。
 *
 * @param store - 当前 store。
 * @param id - 来源分类 id。
 * @param moves - `[{ sessionId, toId }]`。
 * @returns `{ store, undo, error? }`。
 */
export function splitCategory(store, id, moves) {
  const base = normalizeStore(store)
  const sourceId = typeof id === 'string' ? id.trim() : ''
  if (sourceId === '') return { store: base, error: '分类 id 无效' }
  const source = findCategory(base, sourceId)
  if (!source) return { store: base, error: `分类不存在：${sourceId}` }
  if (!Array.isArray(moves)) return { store: base, error: '拆分项必须是数组' }

  const plan = []
  for (const raw of moves) {
    if (!isPlainObject(raw)) return { store: base, error: '拆分项无效' }
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
    if (sessionId === '') return { store: base, error: '拆分项缺少会话 id' }
    const toId = typeof raw.toId === 'string' ? raw.toId.trim() : ''
    if (toId === '') return { store: base, error: '拆分项缺少目标分类' }
    if (toId !== sourceId && !findCategory(base, toId)) {
      return { store: base, error: `目标分类不存在：${toId}` }
    }
    if (toId === sourceId) continue
    plan.push({ sessionId, toId })
  }

  const next = cloneStore(base)
  const applied = []
  for (const move of plan) {
    const current = next.assignments[move.sessionId]
    if (!current || current.categoryId !== sourceId) continue
    applied.push({
      sessionId: move.sessionId,
      toId: move.toId,
      from: { categoryId: current.categoryId, source: current.source },
    })
    next.assignments[move.sessionId] = { categoryId: move.toId, source: SOURCE_USER }
  }

  const stillHasSessions = Object.values(next.assignments).some(a => a.categoryId === sourceId)
  const stillHasChildren = next.categories.some(c => c.parentId === sourceId)
  const removed = applied.length > 0 && !stillHasSessions && !stillHasChildren
  if (removed) next.categories = next.categories.filter(c => c.id !== sourceId)

  const undo = {
    kind: 'split',
    id: sourceId,
    sourceCategory: removed ? cloneCategories([source])[0] : null,
    removed,
    order: base.categories.map(c => c.id),
    moves: applied,
    summary: `拆分 ${source.name || sourceId}（移出 ${applied.length} 个会话）`,
  }
  return { store: next, undo }
}

// ── 撤销 ───────────────────────────────────────────────────────────

function restoreCategoryAtOrder(next, snapshot, order) {
  if (!snapshot || next.categories.some(c => c.id === snapshot.id)) return
  const rebuilt = []
  let inserted = false
  for (const id of order) {
    if (id === snapshot.id) {
      rebuilt.push(cloneCategories([snapshot])[0])
      inserted = true
      continue
    }
    const category = next.categories.find(c => c.id === id)
    if (category) rebuilt.push(category)
  }
  if (!inserted) rebuilt.push(cloneCategories([snapshot])[0])
  const used = new Set(rebuilt.map(c => c.id))
  for (const category of next.categories) if (!used.has(category.id)) rebuilt.push(category)
  next.categories = rebuilt
}

function undoMerge(base, undo) {
  const next = cloneStore(base)
  const snapshots = new Map()
  if (isPlainObject(undo.target) && typeof undo.target.id === 'string') {
    snapshots.set(undo.target.id, cloneCategories([undo.target])[0])
  }
  for (const category of Array.isArray(undo.removed) ? undo.removed : []) {
    const snapshot = isPlainObject(category) ? cloneCategories([category])[0] : null
    if (snapshot) snapshots.set(snapshot.id, snapshot)
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
  for (const [id, snapshot] of snapshots) {
    if (!used.has(id)) rebuilt.push(snapshot)
  }
  for (const category of next.categories) if (!used.has(category.id)) rebuilt.push(category)
  next.categories = rebuilt

  if (isPlainObject(undo.assignments)) {
    for (const [sessionId, previous] of Object.entries(undo.assignments)) {
      if (previous == null) delete next.assignments[sessionId]
      else next.assignments[sessionId] = cloneAssignment(previous)
    }
  }
  return normalizeStore(next)
}

function undoMove(base, undo) {
  const next = cloneStore(base)
  const id = typeof undo.id === 'string' ? undo.id : ''
  const category = findCategory(next, id)
  if (!category) return normalizeStore(next)
  const parentResult = normalizeParentId(undo.from)
  category.parentId = parentResult.ok ? parentResult.value : null
  return normalizeStore(next)
}

function undoSplit(base, undo) {
  const next = cloneStore(base)
  const sourceId = typeof undo.id === 'string' ? undo.id : ''
  if (undo.removed && isPlainObject(undo.sourceCategory)) {
    restoreCategoryAtOrder(
      next,
      undo.sourceCategory,
      Array.isArray(undo.order) ? undo.order.filter(id => typeof id === 'string') : [],
    )
  }
  for (const move of Array.isArray(undo.moves) ? undo.moves : []) {
    if (!isPlainObject(move) || typeof move.sessionId !== 'string') continue
    if (move.from == null) delete next.assignments[move.sessionId]
    else {
      const previous = cloneAssignment(move.from)
      if (previous) next.assignments[move.sessionId] = previous
    }
  }
  return normalizeStore(next)
}

function undoUpsert(base, undo) {
  const next = cloneStore(base)
  const id = typeof undo.id === 'string' ? undo.id : ''
  if (id === '') return normalizeStore(next)
  if (undo.created) {
    next.categories = next.categories.filter(c => c.id !== id)
  } else if (isPlainObject(undo.before)) {
    const index = next.categories.findIndex(c => c.id === id)
    const snapshot = cloneCategories([undo.before])[0]
    if (index >= 0) next.categories[index] = snapshot
    else if (snapshot) next.categories.push(snapshot)
  }
  return normalizeStore(next)
}

/**
 * 按 undo 记录还原 store。
 *
 * 支持 merge / move / split / assignment / upsert，以及带完整 `before`
 * 快照的整理计划 undo（organize.js 产出）。未知 undo 原样返回，不报错。
 *
 * @param store - 当前 store。
 * @param undo - `mergeCategories` / `moveCategory` / `splitCategory` 的返回值。
 * @returns `{ store }`。
 */
export function undoStore(store, undo) {
  const base = normalizeStore(store)
  if (!isPlainObject(undo)) return { store: base }

  if (isPlainObject(undo.before)) {
    return { store: normalizeStore(undo.before) }
  }

  switch (undo.kind) {
    case 'merge':
      return { store: undoMerge(base, undo) }
    case 'move':
      return { store: undoMove(base, undo) }
    case 'split':
      return { store: undoSplit(base, undo) }
    case 'upsert':
      return { store: undoUpsert(base, undo) }
    case 'assignment': {
      const next = cloneStore(base)
      if (typeof undo.sessionId === 'string') {
        const previous = cloneAssignment(undo.before)
        if (previous) next.assignments[undo.sessionId] = previous
        else delete next.assignments[undo.sessionId]
      }
      return { store: normalizeStore(next) }
    }
    default:
      return { store: base }
  }
}

// ── 视图与模型填充 ─────────────────────────────────────────────────

/**
 * 把扁平分类表建成嵌套树。
 *
 * `count` 只算**直接**挂在分类下的会话，不含子孙；这样界面可以分别显示
 * 「本级 3 个 / 子树共 11 个」。分类顺序沿用 store 中的顺序。
 *
 * @param store - 当前 store。
 * @returns `[{ id, name, children, count, source }]`。
 */
export function toTree(store) {
  const base = normalizeStore(store)
  const nodes = new Map()
  for (const category of base.categories) {
    nodes.set(category.id, {
      id: category.id,
      name: category.name,
      children: [],
      count: 0,
      source: category.source,
    })
  }
  for (const assignment of Object.values(base.assignments)) {
    const node = nodes.get(assignment.categoryId)
    if (node) node.count += 1
  }

  const roots = []
  for (const category of base.categories) {
    const node = nodes.get(category.id)
    const parent = category.parentId === null ? null : nodes.get(category.parentId)
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/**
 * 把模型提出的分类填进 store —— **只填空白，不覆盖任何已有内容**。
 *
 * 判定点（人工优先）：
 *  1. 已有 `source:'user'` 的分类，名称永远不写；
 *  2. 已有非空名称永远不写（不论来源）；
 *  3. `assignments` 一个键都不碰。
 *
 * 其余行为：缺失分类按 `{id?, name, parentId?}` 新建（source = model）；
 * 父级若指向本次提案里稍后出现的分类，会做第二遍解析。非法提案逐条忽略。
 *
 * @param store - 当前 store。
 * @param proposed - `[{ id?, name, parentId? }]`（也接受 `{ categories: [...] }`）。
 * @returns `{ store, added, filled }`。
 */
export function applyModelFill(store, proposed) {
  const base = normalizeStore(store)
  const list = Array.isArray(proposed)
    ? proposed
    : isPlainObject(proposed) && Array.isArray(proposed.categories) ? proposed.categories : []

  const next = cloneStore(base)
  const added = []
  let filled = 0

  // 父级只在「已存在」或「本批显式给了 id」时才算数。指向不存在 id 的父级
  // 会被当成顶层处理，否则每次重放提案都会因为 id 种子不同而生成重复分类。
  const explicitProposalIds = new Set()
  for (const raw of list) {
    if (isPlainObject(raw) && typeof raw.id === 'string' && raw.id.trim() !== '') {
      explicitProposalIds.add(raw.id.trim())
    }
  }

  for (const raw of list) {
    if (!isPlainObject(raw)) continue
    const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim() : ''
    const parentResult = normalizeParentId(raw.parentId)
    const intendedParent = parentResult.ok ? parentResult.value : null
    const effectiveParent = intendedParent !== null
      && !findCategory(next, intendedParent)
      && !explicitProposalIds.has(intendedParent)
      ? null
      : intendedParent

    let id = typeof raw.id === 'string' ? raw.id.trim() : ''
    if (id === '') {
      if (name === '') continue
      id = freeCategoryId(next.categories, name, effectiveParent)
    }

    const existing = findCategory(next, id)
    if (existing) {
      // 只补空名；user 来源与已有非空名都不动。
      if (existing.source !== SOURCE_USER && !hasName(existing.name) && name !== '') {
        existing.name = name
        filled += 1
      }
      continue
    }

    if (name === '') continue

    // 显式 id 不同、但语义上同一个 name + parent 时复用已有分类，避免重复。
    const same = next.categories.find(c =>
      canonicalName(c.name) === canonicalName(name) && (c.parentId ?? null) === effectiveParent)
    if (same) continue

    next.categories.push({ id, name, parentId: null, source: SOURCE_MODEL })
    added.push({ id, intendedParent: effectiveParent })
  }

  // 第二遍：解析父级（允许父分类在提案后面才出现），并拒绝成环 / 悬空。
  for (const entry of added) {
    const category = findCategory(next, entry.id)
    if (!category || entry.intendedParent === null) continue
    if (entry.intendedParent === entry.id) continue
    if (!findCategory(next, entry.intendedParent)) continue
    if (isDescendant(next.categories, entry.intendedParent, entry.id)) continue
    category.parentId = entry.intendedParent
  }

  return { store: next, added: added.length, filled }
}
