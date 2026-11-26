/**
 * 分类全自动（Host 侧）：自动归类队列、启动扫描、每日维护、人工锁定。
 *
 * 产品定稿：人不再建分类、不再管分类，只保留「归错了」的纠正权。
 * 因此这里的所有模型写入都遵守两条硬约束：
 *   1. 只填空白：已归类 / 已锁定的会话不碰；
 *   2. `source:'user'` 的数据（分类名、归类、锁定）永不被模型覆盖。
 *
 * 与既有模块的分工：
 *   - `category-store.js` 是纯数据层（单步写 + 精确 undo）；
 *   - `organize.js` 是操作层（先算后写）；
 *   - 本模块只做**策略与队列**：什么时候跑、跑哪一步、允不允许新建。
 *     模型调用、文件读写留在 `index.js`，方便纯逻辑直接测试。
 *
 * 本模块不读时钟做业务判断时都允许注入 `now`；默认使用系统时间。
 * 定时器一律 `unref()`，插件被测试或进程收尾时不拖住事件循环。
 *
 * 启动扫描的名额按工作区轮转分配，并把「已处理会话」持久化成游标：
 * 否则大工作区的最近会话会永远占满 60 个名额，小工作区每次启动都被饿死。
 *
 * @module dsh-topic-map/category-auto
 */

import { applyModelFill, assignSession } from './category-store.js'
import { applyPlan, planOrganize } from './organize.js'
import { localDayKey } from './workspace-stats.js'

/** 会话结束后的防抖窗口：60 秒内不再有活动才真正跑一次。 */
export const DEFAULT_AUTO_DEBOUNCE_MS = 60_000
/** 启动扫描延迟：避开启动高峰。 */
export const STARTUP_SCAN_DELAY_MS = 30_000
/** 单次启动最多归类的会话数；其余留给下次启动。 */
export const STARTUP_SCAN_LIMIT = 60
/**
 * 启动扫描的「每工作区首轮名额」。
 *
 * 为什么需要它：以前把所有工作区的会话按 lastActive 全局倒序取前 60，
 * 结果大工作区（44 个会话）把名额吃光，小工作区每次启动都轮不到——
 * 同一批会话被反复饿死。现在第一轮按工作区轮转，每区最多 10 个，
 * 保证每个有未归类会话的工作区都能先拿到名额；剩余名额再按未归类
 * 数量从大到小补。
 */
export const STARTUP_SCAN_WORKSPACE_QUOTA = 10
/** 按需触发（/category-auto-start）单次最多入队的会话数。 */
export const AUTO_START_MAX_SESSIONS = 20
/** 同一工作区两次按需触发之间的节流窗口。 */
export const AUTO_START_THROTTLE_MS = 10 * 60 * 1000
/** 启动扫描游标文件里最多保留多少条「已处理」记录。 */
export const AUTO_CLASSIFY_STATE_PROCESSED_MAX = 5000
/** 同一「新分类」至少要有这么多个会话支持才允许创建。 */
export const NEW_CATEGORY_MIN_SUPPORT = 3
/** 未归类会话超过这个数就触发每日维护（严格大于）。 */
export const DAILY_MAINTENANCE_UNCLASSIFIED_THRESHOLD = 3
/** 某个候选主题达到这个会话数就触发每日维护。 */
export const DAILY_MAINTENANCE_THEME_THRESHOLD = 3
/** 分类名长度上限，与 /category-suggest 的解析口径一致。 */
const CATEGORY_NAME_MAX = 24
/** 分类最多 3 级。 */
const CATEGORY_MAX_DEPTH = 3
/** 提示词里给「过大会话组」列出的会话 id 条数上限。 */
const MAINTENANCE_SPLIT_SESSIONS_HINT = 12
/** 至少这么多会话的分类才算「过大」，值得在提示词里列出会话 id。 */
const MAINTENANCE_OVERSIZED_MIN = 6
const SOURCE_USER = 'user'
const SOURCE_MODEL = 'model'

// ── 基础工具（刻意与 category-store / organize 同构，但不共享可变状态） ──

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalName(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function trimSessionId(value) {
  return typeof value === 'string' ? value.trim() : ''
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

function categoriesOf(store) {
  return Array.isArray(store?.categories) ? store.categories : []
}

function findCategory(store, id) {
  const key = typeof id === 'string' ? id.trim() : ''
  if (key === '') return null
  return categoriesOf(store).find(category => category?.id === key) ?? null
}

/** 同级同名分类查找（名称空白归一后比较）。 */
function findCategoryByPathName(store, name, parentId) {
  const wanted = canonicalName(name)
  if (wanted === '') return null
  for (const category of categoriesOf(store)) {
    if (!isPlainObject(category)) continue
    if (canonicalName(category.name) !== wanted) continue
    if ((category.parentId ?? null) !== (parentId ?? null)) continue
    return category
  }
  return null
}

/**
 * 读一条 assignment；旧式字符串按 `source:'user'` 处理。
 *
 * @returns `{categoryId, source}|null`；`categoryId` 可能为 null（空占位）。
 */
export function assignmentOf(store, sessionId) {
  const sid = trimSessionId(sessionId)
  if (sid === '') return null
  const assignments = isPlainObject(store?.assignments) ? store.assignments : {}
  if (!Object.prototype.hasOwnProperty.call(assignments, sid)) return null
  const raw = assignments[sid]
  if (typeof raw === 'string') {
    const categoryId = raw.trim()
    return { categoryId: categoryId === '' ? null : categoryId, source: SOURCE_USER }
  }
  if (!isPlainObject(raw)) return null
  const categoryId = typeof raw.categoryId === 'string'
    ? raw.categoryId.trim()
    : typeof raw.id === 'string' ? raw.id.trim() : ''
  return {
    categoryId: categoryId === '' ? null : categoryId,
    source: raw.source === SOURCE_USER ? SOURCE_USER : SOURCE_MODEL,
  }
}

/** 「未归类」= assignments 里没有，或 categoryId 为空（空占位也算空白）。 */
export function isSessionUnclassified(store, sessionId) {
  const assignment = assignmentOf(store, sessionId)
  return assignment === null || assignment.categoryId === null
}

// ── 人工锁定（lockedSessions） ────────────────────────────────────

/**
 * 归一锁定表。
 *
 * 形状：`{ [sessionId]: { at: number|null, by:'user' } }`。
 * 旧 store 没有这个字段 → `{}`；坏条目丢弃。`by` 只可能是 `'user'`：
 * 模型没有资格锁定，锁定就是人的纠正权。
 *
 * @param raw - store.lockedSessions（可为任意脏值）。
 * @returns 归一后的普通对象（新对象，可安全改写）。
 */
export function normalizeLockedSessions(raw) {
  if (!isPlainObject(raw)) return {}
  const out = {}
  for (const [rawSessionId, entry] of Object.entries(raw)) {
    const sessionId = trimSessionId(rawSessionId)
    if (sessionId === '') continue
    const at = isPlainObject(entry) && Number.isFinite(entry.at) ? entry.at : null
    out[sessionId] = { at, by: SOURCE_USER }
  }
  return out
}

/** 会话是否被人工纠正锁定（模型一切写入路径都要先问这一句）。 */
export function isSessionLocked(store, sessionId) {
  const sid = trimSessionId(sessionId)
  if (sid === '') return false
  return Object.prototype.hasOwnProperty.call(normalizeLockedSessions(store?.lockedSessions), sid)
}

/**
 * 锁定一个会话。
 *
 * 幂等：已锁定的会话保留原 `at`，重复调用得到完全相同的 store。
 * 这是 `/category-override` 幂等要求的一部分。
 *
 * @param store - 当前 store（可为裸 store）。
 * @param sessionId - 会话 id。
 * @param options - `{at}`，供测试固定时间。
 * @returns `{store, locked:true}`；sessionId 非法时 `{store, error}`。
 */
export function lockSession(store, sessionId, options = {}) {
  const sid = trimSessionId(sessionId)
  if (sid === '') return { store, error: '会话 id 无效' }
  const locked = normalizeLockedSessions(store?.lockedSessions)
  const existing = locked[sid]
  const at = existing !== undefined
    ? existing.at
    : Number.isFinite(options.at) ? options.at : Date.now()
  locked[sid] = { at, by: SOURCE_USER }
  return { store: { ...(isPlainObject(store) ? store : {}), lockedSessions: locked }, locked: true }
}

/**
 * 把原 store 的锁定表带回到 category-store / organize 产出的新 store 上。
 *
 * 这两个模块只认 version/categories/assignments，会在读改写时丢掉扩展字段。
 * 锁定表是 Host 侧的产品状态，不能因此静默消失。
 */
export function carryLockedSessions(base, next) {
  if (!isPlainObject(next)) return next
  const locked = normalizeLockedSessions(base?.lockedSessions)
  if (Object.keys(locked).length === 0) {
    if (Object.prototype.hasOwnProperty.call(next, 'lockedSessions')) {
      const copy = { ...next }
      delete copy.lockedSessions
      return copy
    }
    return next
  }
  return { ...next, lockedSessions: locked }
}

// ── 分类路径 ──────────────────────────────────────────────────────

/**
 * 一个分类的路径（顶层 → 叶子）；未知 id 返回 null，成环安全截断。
 *
 * @param store - 分类 store。
 * @param categoryId - 分类 id。
 * @returns 名称数组或 null。
 */
export function categoryPathOf(store, categoryId) {
  const byId = new Map()
  for (const category of categoriesOf(store)) {
    if (isPlainObject(category) && typeof category.id === 'string') byId.set(category.id, category)
  }
  const names = []
  const seen = new Set()
  let current = typeof categoryId === 'string' ? categoryId : ''
  while (current !== '' && byId.has(current) && !seen.has(current)) {
    seen.add(current)
    const category = byId.get(current)
    names.unshift(category.name)
    current = typeof category.parentId === 'string' ? category.parentId : ''
  }
  return names.length === 0 && !byId.has(typeof categoryId === 'string' ? categoryId : '')
    ? null
    : names
}

/**
 * 现有分类路径清单：喂给模型的"只能从已有分类里选"的候选集。
 *
 * @param store - 分类 store。
 * @returns `[{id, name, path, pathText, count, source}]`（顺序沿用 store）。
 */
export function listCategoryPaths(store) {
  const counts = new Map()
  const assignments = isPlainObject(store?.assignments) ? store.assignments : {}
  for (const raw of Object.values(assignments)) {
    const categoryId = typeof raw === 'string'
      ? raw.trim()
      : isPlainObject(raw) && typeof raw.categoryId === 'string' ? raw.categoryId.trim() : ''
    if (categoryId === '') continue
    counts.set(categoryId, (counts.get(categoryId) ?? 0) + 1)
  }
  const out = []
  for (const category of categoriesOf(store)) {
    if (!isPlainObject(category)) continue
    const path = categoryPathOf(store, category.id)
    if (path === null) continue
    out.push({
      id: category.id,
      name: canonicalName(category.name),
      path,
      pathText: path.map(canonicalName).join(' › '),
      count: counts.get(category.id) ?? 0,
      source: category.source === SOURCE_USER ? SOURCE_USER : SOURCE_MODEL,
    })
  }
  return out
}

/**
 * 把「名称路径」解析成现有分类。
 *
 * 逐级按「同级同名」匹配；某一级不存在就停在那里，后面的都算"需要新建"。
 * 这样模型返回 `['插件开发','子类']` 时，若 `插件开发` 已有、`子类` 没有，
 * 父级仍能复用，只新建缺的那一级。
 *
 * @param store - 分类 store。
 * @param rawPath - 名称数组（已被解析器归一过；这里再归一一次）。
 * @returns `{ok, path, full, categoryId, parentId, missing, key}`。
 */
export function resolveCategoryPath(store, rawPath) {
  const path = []
  for (const raw of Array.isArray(rawPath) ? rawPath.slice(0, CATEGORY_MAX_DEPTH) : []) {
    const name = canonicalName(raw).slice(0, CATEGORY_NAME_MAX)
    if (name === '') return { ok: false, path: [], full: false, categoryId: null, parentId: null, missing: [], key: '' }
    path.push(name)
  }
  if (path.length === 0) {
    return { ok: false, path, full: false, categoryId: null, parentId: null, missing: [], key: '' }
  }

  let parentId = null
  let index = 0
  while (index < path.length) {
    const found = findCategoryByPathName(store, path[index], parentId)
    if (found === null) break
    parentId = found.id
    index += 1
  }
  const full = index === path.length
  const missing = path.slice(index)
  // 新建支持度按「父级 id + 缺失名称」计：同一个新叶子只算一个候选分类。
  const key = `${parentId ?? ''}\u0000${missing.join('\u0000')}`
  return {
    ok: true,
    path,
    full,
    categoryId: full ? parentId : null,
    parentId,
    missing,
    key: full ? '' : key,
  }
}

/**
 * 按路径逐级补建分类（只填空，source 固定 model）。
 *
 * @param store - 分类 store。
 * @param parentId - 起点父级 id（null = 顶层）。
 * @param names - 需要新建的名称（按层级顺序）。
 * @returns `{store, categoryId}` 或 `{store, error}`。
 */
export function ensureCategoryPath(store, parentId, names) {
  const lockedBase = store
  let next = store
  let currentParent = parentId ?? null
  let categoryId = null
  for (const rawName of Array.isArray(names) ? names : []) {
    const name = canonicalName(rawName).slice(0, CATEGORY_NAME_MAX)
    if (name === '') return { store: next, error: '分类名为空' }
    const existing = findCategoryByPathName(next, name, currentParent)
    if (existing !== null) {
      categoryId = existing.id
      currentParent = existing.id
      continue
    }
    const filled = applyModelFill(next, [{ name, parentId: currentParent }])
    next = carryLockedSessions(lockedBase, filled.store)
    const created = findCategoryByPathName(next, name, currentParent)
    if (created === null) return { store: next, error: `新建分类失败：${name}` }
    categoryId = created.id
    currentParent = created.id
  }
  return { store: next, categoryId }
}

// ── 自动归类：判定与落库 ──────────────────────────────────────────

/**
 * 判断一条模型建议能不能直接落到已有分类。
 *
 * @param store - 分类 store。
 * @param sessionId - 会话 id。
 * @param suggestion - `{categoryPath}`。
 * @returns `{action:'skip'|'assign'|'new', ...}`：
 *   - `skip`：已锁定 / 已归类；
 *   - `assign`：路径完整命中，直接写 `categoryId`；
 *   - `new`：路径有缺口，交给支持度累计，达到阈值才创建。
 */
export function planAutoSuggestion(store, sessionId, suggestion) {
  const sid = trimSessionId(sessionId)
  if (sid === '') return { action: 'skip', reason: 'invalid-session' }
  if (isSessionLocked(store, sid)) return { action: 'skip', reason: 'locked' }
  if (!isSessionUnclassified(store, sid)) return { action: 'skip', reason: 'classified' }
  const resolved = resolveCategoryPath(store, suggestion?.categoryPath)
  if (!resolved.ok) return { action: 'skip', reason: 'invalid-path' }
  if (resolved.full) {
    return { action: 'assign', categoryId: resolved.categoryId, path: resolved.path }
  }
  return {
    action: 'new',
    key: resolved.key,
    parentId: resolved.parentId,
    missing: resolved.missing,
    path: resolved.path,
    displayPath: resolved.path.map(canonicalName).join(' › '),
  }
}

/**
 * 新分类支持度累计器。
 *
 * 产品口径：同一新分类必须 ≥3 个会话支持才创建。这里只记账，不建分类；
 * 计数以 sessionId 去重（同一会话重复提案只算一次）。
 *
 * @param options - `{threshold}`，默认 `NEW_CATEGORY_MIN_SUPPORT`。
 */
export function createNewCategorySupport(options = {}) {
  const threshold = Number.isFinite(options.threshold) && options.threshold > 0
    ? Math.floor(options.threshold)
    : NEW_CATEGORY_MIN_SUPPORT
  const buckets = new Map()

  function snapshot(bucket) {
    return {
      count: bucket.sessions.size,
      threshold,
      reached: bucket.sessions.size >= threshold,
      sessions: [...bucket.sessions],
      path: bucket.path.slice(),
      parentId: bucket.parentId,
      missing: bucket.missing.slice(),
    }
  }

  return {
    /** 计一次支持；返回该候选当前的支持情况。 */
    record(key, sessionId, meta = {}) {
      const bucketKey = String(key ?? '')
      const sid = trimSessionId(sessionId)
      if (bucketKey === '' || sid === '') return { count: 0, threshold, reached: false, sessions: [] }
      let bucket = buckets.get(bucketKey)
      if (bucket === undefined) {
        bucket = {
          path: Array.isArray(meta.path) ? meta.path.map(canonicalName) : [],
          parentId: meta.parentId ?? null,
          missing: Array.isArray(meta.missing) ? meta.missing.map(canonicalName) : [],
          sessions: new Set(),
        }
        buckets.set(bucketKey, bucket)
      }
      bucket.sessions.add(sid)
      return snapshot(bucket)
    },
    /** 取候选当前状态（不新增）。 */
    peek(key) {
      const bucket = buckets.get(String(key ?? ''))
      return bucket === undefined ? null : snapshot(bucket)
    },
    /** 候选已落地（或作废）：清掉计数。 */
    clear(key) {
      buckets.delete(String(key ?? ''))
    },
    /** 会话已被别处归类：把它从所有候选里摘掉，避免误带旧支持。 */
    dropSession(sessionId) {
      const sid = trimSessionId(sessionId)
      if (sid === '') return
      for (const [key, bucket] of [...buckets]) {
        bucket.sessions.delete(sid)
        if (bucket.sessions.size === 0) buckets.delete(key)
      }
    },
    /** 调试/测试用：当前所有候选。 */
    entries() {
      return [...buckets.entries()].map(([key, bucket]) => ({ key, ...snapshot(bucket) }))
    },
    reset() {
      buckets.clear()
    },
  }
}

/**
 * 把一条已通过解析的建议落到 store 上（只填空 + 人工锁定优先）。
 *
 * - 命中已有分类：直接 `assignSession(..., 'model')`；
 * - 需要新建：先累计支持度，不足阈值时**保持未归类**；
 *   达到阈值才逐级建分类，并把所有仍空白的支持会话一起归进去。
 *
 * 纯函数式：不读写文件、不调模型。调用方负责持久化返回的 store。
 *
 * @param store - 分类 store。
 * @param sessionId - 本次会话。
 * @param suggestion - `{categoryPath}`。
 * @param support - `createNewCategorySupport()` 实例（按工作区共享）。
 * @returns 结果对象；`store` 始终可直接落盘。
 */
export function applyAutoClassification(store, sessionId, suggestion, support) {
  const sid = trimSessionId(sessionId)
  const decision = planAutoSuggestion(store, sid, suggestion)
  if (decision.action === 'skip') return { store, action: 'skip', reason: decision.reason }
  if (decision.action === 'assign') {
    const assigned = assignSession(store, sid, decision.categoryId, SOURCE_MODEL)
    if (assigned.error) return { store, action: 'skip', reason: 'assign-rejected', error: assigned.error }
    return {
      store: carryLockedSessions(store, assigned.store),
      action: 'assigned',
      categoryId: decision.categoryId,
      path: decision.path,
    }
  }
  if (support === null || typeof support?.record !== 'function') {
    return { store, action: 'pending-new', count: 0, threshold: NEW_CATEGORY_MIN_SUPPORT, path: decision.path }
  }

  const record = support.record(decision.key, sid, {
    path: decision.path,
    parentId: decision.parentId,
    missing: decision.missing,
  })
  if (!record.reached) {
    return {
      store,
      action: 'pending-new',
      count: record.count,
      threshold: record.threshold,
      path: decision.path,
      displayPath: decision.displayPath,
      sessions: record.sessions,
    }
  }

  const created = ensureCategoryPath(store, decision.parentId, decision.missing)
  if (created.error) {
    support.clear(decision.key)
    return { store: created.store, action: 'failed', error: created.error, path: decision.path }
  }

  let next = created.store
  const assigned = []
  const rejected = []
  for (const supporter of record.sessions) {
    if (isSessionLocked(next, supporter)) { rejected.push({ sessionId: supporter, reason: 'locked' }); continue }
    if (!isSessionUnclassified(next, supporter)) { rejected.push({ sessionId: supporter, reason: 'classified' }); continue }
    const result = assignSession(next, supporter, created.categoryId, SOURCE_MODEL)
    if (result.error) { rejected.push({ sessionId: supporter, reason: result.error }); continue }
    next = carryLockedSessions(next, result.store)
    assigned.push(supporter)
    support.dropSession(supporter)
  }
  support.clear(decision.key)
  return {
    store: next,
    action: 'created',
    categoryId: created.categoryId,
    path: decision.path,
    createdNames: decision.missing,
    assigned,
    rejected,
    supportCount: record.count,
  }
}

// ── 自动归类队列（防抖 + 串行 + 去重） ──────────────────────────

/**
 * 创建自动归类队列。
 *
 * 三条语义：
 *   1. **防抖**：同一会话的入队会把定时器重置为 `debounceMs` 后（默认 60s）；
 *   2. **串行**：全局并发 1，后一个任务等前一个结束（模型调用不互相抢配额）；
 *   3. **去重**：同一 sessionId 在途时再次入队直接丢弃，绝不重复跑。
 *
 * 失败不会中断队列：单个任务抛错只记日志（`onError`），后续任务照跑。
 * 定时器全部 `unref()`，不阻止进程退出。
 *
 * @param options - `{execute(ctx, sessionId), debounceMs, onError, now}`。
 * @returns `{enqueue, drain, flush, stats, pendingCount, inFlightCount}`。
 */
export function createAutoClassifyQueue(options = {}) {
  if (typeof options.execute !== 'function') {
    throw new Error('createAutoClassifyQueue 需要 execute 回调')
  }
  const debounceMs = Number.isFinite(options.debounceMs)
    ? Math.max(0, Math.floor(options.debounceMs))
    : DEFAULT_AUTO_DEBOUNCE_MS
  const execute = options.execute
  const onError = typeof options.onError === 'function' ? options.onError : () => {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const schedule = typeof options.schedule === 'function' ? options.schedule : setTimeout
  const cancel = typeof options.cancel === 'function' ? options.cancel : clearTimeout

  /** sessionId → {ctx, timer, dueAt}；防抖窗口内的待执行项。 */
  const pending = new Map()
  /** 正在执行（或已排进串行链）的 sessionId；去重靠它。 */
  const inFlight = new Set()
  const counters = { enqueued: 0, promoted: 0, runs: 0, deduped: 0, debounced: 0, failed: 0 }
  /** 串行链：任何时刻只有一个 execute 在跑。 */
  let chain = Promise.resolve()

  function armTimer(sessionId, entry) {
    const timer = schedule(() => {
      // 到点时若已被别的任务占住（极端竞态），直接丢弃。
      if (pending.get(sessionId) !== entry) return
      pending.delete(sessionId)
      scheduleRun(sessionId, entry.ctx)
    }, debounceMs)
    if (timer !== null && timer !== undefined && typeof timer.unref === 'function') timer.unref()
    entry.timer = timer
  }

  function scheduleRun(sessionId, ctx) {
    if (inFlight.has(sessionId)) {
      counters.deduped += 1
      return
    }
    inFlight.add(sessionId)
    chain = chain.then(async () => {
      counters.runs += 1
      try {
        await execute(ctx, sessionId)
      } catch (error) {
        counters.failed += 1
        try {
          onError(error, ctx, sessionId)
        } catch {
          // 日志回调自己抛错不能反过来打断队列。
        }
      } finally {
        inFlight.delete(sessionId)
      }
    })
  }

  return {
    /**
     * 入队一个会话。返回 false 表示被去重丢弃（在途）或参数非法。
     */
    enqueue(ctx, sessionId) {
      const sid = trimSessionId(sessionId)
      if (sid === '') return false
      if (inFlight.has(sid)) {
        counters.deduped += 1
        return false
      }
      const existing = pending.get(sid)
      if (existing !== undefined) {
        cancel(existing.timer)
        counters.debounced += 1
        existing.ctx = ctx
        existing.dueAt = now() + debounceMs
        armTimer(sid, existing)
        pending.set(sid, existing)
        return true
      }
      const entry = { ctx, timer: null, dueAt: now() + debounceMs }
      armTimer(sid, entry)
      pending.set(sid, entry)
      counters.enqueued += 1
      return true
    },
    /**
     * 立即入队（跳过防抖）。供 `/category-auto-start` 这类用户显式触发用：
     * 用户点了按钮就不该再等 60 秒。
     *
     * 在途去重语义与 `enqueue` 相同；返回 false 表示被去重或参数非法。
     */
    enqueueNow(ctx, sessionId) {
      const sid = trimSessionId(sessionId)
      if (sid === '') return false
      if (inFlight.has(sid)) {
        counters.deduped += 1
        return false
      }
      const existing = pending.get(sid)
      if (existing !== undefined) {
        cancel(existing.timer)
        pending.delete(sid)
        counters.promoted += 1
      } else {
        counters.enqueued += 1
      }
      scheduleRun(sid, ctx)
      return true
    },
    /** 立即执行所有待执行项（测试与收尾用），返回是否全部成功。 */
    async drain() {
      for (const [sid, entry] of [...pending.entries()]) {
        cancel(entry.timer)
        pending.delete(sid)
        scheduleRun(sid, entry.ctx)
      }
      await chain
      return counters.failed === 0
    },
    /** 只等当前串行链跑完；不提前触发防抖中的项。 */
    async flush() {
      await chain
    },
    stats() {
      return { ...counters, pending: pending.size, inFlight: inFlight.size, debounceMs }
    },
    pendingCount() {
      return pending.size
    },
    inFlightCount() {
      return inFlight.size
    },
    /** 供 apply() 被卸载时清掉定时器。 */
    dispose() {
      for (const entry of pending.values()) cancel(entry.timer)
      pending.clear()
    },
  }
}

/** Host 安装后绑定的默认队列（`queueAutoClassify` 的落点）。 */
let defaultAutoQueue = null

/**
 * 安装/替换默认自动归类队列。`apply()` 每次启动调用一次。
 *
 * @param options - 同 `createAutoClassifyQueue`。
 * @returns 队列实例。
 */
export function configureAutoClassify(options = {}) {
  if (defaultAutoQueue !== null) {
    try {
      defaultAutoQueue.dispose()
    } catch {
      // 替换队列时清不掉旧定时器也不影响新队列。
    }
  }
  defaultAutoQueue = createAutoClassifyQueue(options)
  return defaultAutoQueue
}

/** 取默认队列（未安装时为 null）。 */
export function getAutoClassifyQueue() {
  return defaultAutoQueue
}

/**
 * `queueAutoClassify(ctx, sessionId)`：会话结束后入队（60 秒防抖）。
 *
 * 未安装队列（插件没启动完 / 纯单元测试）时是无操作，返回 false。
 *
 * @param ctx - Host context（原样带给 execute）。
 * @param sessionId - 会话 id。
 * @returns 是否真的入队。
 */
export function queueAutoClassify(ctx, sessionId) {
  if (defaultAutoQueue === null) return false
  return defaultAutoQueue.enqueue(ctx, sessionId)
}

/**
 * 立即入队（跳过 60 秒防抖）。按需触发端点用。
 *
 * @returns 是否真的入队。
 */
export function queueAutoClassifyNow(ctx, sessionId) {
  if (defaultAutoQueue === null) return false
  return defaultAutoQueue.enqueueNow(ctx, sessionId)
}

/** 等待默认队列当前串行链跑完（测试与收尾用）。 */
export async function flushAutoClassifyQueue() {
  if (defaultAutoQueue === null) return
  await defaultAutoQueue.flush()
}

// ── 启动游标状态（持久化形状） ────────────────────────────────────

/**
 * 归一启动扫描状态。
 *
 * 文件形状（`~/.dsh/topic-map/auto-classify-state.json`）：
 * ```
 * {
 *   "lastRunAt": 1760000000000,
 *   "processed": { "<sessionId>": 1760000000000 }
 * }
 * ```
 * 缺失 / 损坏 / 旧版本一律读成空状态（启动扫描会重新扫，不会崩）。
 *
 * @param raw - 任意 JSON 值。
 * @returns `{lastRunAt:number|null, processed:Object<string, number>}`。
 */
export function normalizeAutoClassifyState(raw) {
  const out = { lastRunAt: null, processed: {} }
  if (!isPlainObject(raw)) return out
  if (Number.isFinite(raw.lastRunAt) && raw.lastRunAt > 0) out.lastRunAt = raw.lastRunAt
  const processed = isPlainObject(raw.processed) ? raw.processed : {}
  for (const [rawSessionId, rawAt] of Object.entries(processed)) {
    const sessionId = trimSessionId(rawSessionId)
    if (sessionId === '') continue
    if (Number.isFinite(rawAt) && rawAt > 0) out.processed[sessionId] = rawAt
  }
  return out
}

/**
 * 把本次扫描入队的会话记进游标状态，并更新 `lastRunAt`。
 *
 * `processed` 按时间保留最新的 `max` 条，避免文件无限增长。
 *
 * @param state - 当前状态（`normalizeAutoClassifyState` 的输出或裸 JSON）。
 * @param sessions - sessionId 字符串或 `{sessionId}` 数组。
 * @param options - `{at, max}`。
 * @returns 新状态对象（不修改入参）。
 */
export function addAutoProcessedSessions(state, sessions, options = {}) {
  const base = normalizeAutoClassifyState(state)
  const at = Number.isFinite(options.at) ? options.at : Date.now()
  const max = Number.isFinite(options.max) && options.max > 0
    ? Math.floor(options.max)
    : AUTO_CLASSIFY_STATE_PROCESSED_MAX
  const processed = { ...base.processed }
  for (const item of Array.isArray(sessions) ? sessions : []) {
    const sessionId = trimSessionId(typeof item === 'string' ? item : item?.sessionId)
    if (sessionId === '') continue
    processed[sessionId] = at
  }
  const entries = Object.entries(processed)
  if (entries.length > max) {
    entries.sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1]
      return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0
    })
    const kept = {}
    for (const [sessionId, time] of entries.slice(0, max)) kept[sessionId] = time
    return { lastRunAt: at, processed: kept }
  }
  return { lastRunAt: at, processed }
}

/**
 * 按需触发的内存节流器（同一工作区 10 分钟一次）。
 *
 * 进程内状态，重启即清零：节流是防连点的，不是持久业务规则。
 *
 * @param options - `{windowMs, now}`。
 */
export function createAutoStartThrottle(options = {}) {
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? Math.floor(options.windowMs)
    : AUTO_START_THROTTLE_MS
  const now = typeof options.now === 'function' ? options.now : Date.now
  const lastAt = new Map()
  const keyOf = workspaceId => {
    const key = trimSessionId(workspaceId)
    return key === '' ? 'default' : key
  }
  return {
    /**
     * 尝试占用一次触发机会。
     *
     * @returns `{allowed:true}` 或 `{allowed:false, retryAfterMs}`。
     */
    claim(workspaceId) {
      const key = keyOf(workspaceId)
      const stamp = now()
      const previous = lastAt.get(key)
      if (previous !== undefined && stamp - previous < windowMs) {
        return { allowed: false, retryAfterMs: windowMs - (stamp - previous) }
      }
      lastAt.set(key, stamp)
      return { allowed: true }
    },
    /** 最近一次触发时间；没触发过返回 null。 */
    lastAt(workspaceId) {
      return lastAt.get(keyOf(workspaceId)) ?? null
    },
    reset(workspaceId) {
      if (workspaceId === undefined) lastAt.clear()
      else lastAt.delete(keyOf(workspaceId))
    },
  }
}

// ── 启动全量扫描 ──────────────────────────────────────────────────

/** lastActive 倒序；缺失时间的排最后，同时间按 sessionId 稳定排序。 */
function compareCandidates(left, right) {
  const leftTime = Number.isFinite(left.lastActive) ? left.lastActive : -Infinity
  const rightTime = Number.isFinite(right.lastActive) ? right.lastActive : -Infinity
  if (rightTime !== leftTime) return rightTime - leftTime
  return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
}

/**
 * 规划一次启动扫描：去重 → 按 lastActive 倒序 → 截断到上限。
 *
 * @param candidates - `[{sessionId, workspaceId, lastActive}]`。
 * @param limit - 单次上限，默认 60。
 * @returns `{selected, overflow, total}`。
 */
export function planStartupScan(candidates, limit = STARTUP_SCAN_LIMIT) {
  const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : STARTUP_SCAN_LIMIT
  const seen = new Set()
  const list = []
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    if (!isPlainObject(raw)) continue
    const sessionId = trimSessionId(raw.sessionId)
    if (sessionId === '' || seen.has(sessionId)) continue
    seen.add(sessionId)
    list.push({
      sessionId,
      workspaceId: typeof raw.workspaceId === 'string' ? raw.workspaceId : '',
      lastActive: Number.isFinite(raw.lastActive) ? raw.lastActive : null,
    })
  }
  list.sort(compareCandidates)
  return {
    selected: list.slice(0, cap),
    overflow: Math.max(0, list.length - cap),
    total: list.length,
  }
}

/**
 * 按工作区公平分配的启动扫描计划。
 *
 * 算法（防饿死）：
 *   1. **首轮轮转**：每轮给每个工作区各发 1 个名额，直到每区最多
 *      `workspaceQuota`（默认 10）或总预算用完。这样即使某个大工作区
 *      有 44 个未归类会话，小工作区也一定能先拿到名额。
 *   2. **剩余补位**：还有预算时，按各工作区**未归类数量从大到小**补，
 *      区内仍按 lastActive 倒序取。
 *   3. 总数不超过 `limit`（默认 60）。
 *
 * @param groups - `[{workspaceId, sessions:[{sessionId,lastActive}]}]`；
 *   调用方已完成「未归类 / 未锁定 / 游标已处理」过滤。
 * @param options - `{limit, workspaceQuota}`。
 * @returns `{selected, overflow, total, allocation}`。
 */
export function planWorkspaceFairScan(groups, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit >= 0
    ? Math.floor(options.limit)
    : STARTUP_SCAN_LIMIT
  const quota = Number.isFinite(options.workspaceQuota) && options.workspaceQuota > 0
    ? Math.floor(options.workspaceQuota)
    : STARTUP_SCAN_WORKSPACE_QUOTA

  // 归一 + 跨工作区去重（同一会话只算一次，保留先出现的工作区）。
  const seen = new Set()
  const normalized = []
  for (const raw of Array.isArray(groups) ? groups : []) {
    const workspaceId = trimSessionId(raw?.workspaceId)
    if (workspaceId === '') continue
    const sessions = []
    for (const session of Array.isArray(raw?.sessions) ? raw.sessions : []) {
      const sessionId = trimSessionId(session?.sessionId)
      if (sessionId === '' || seen.has(sessionId)) continue
      seen.add(sessionId)
      sessions.push({
        sessionId,
        workspaceId,
        lastActive: Number.isFinite(session?.lastActive) ? session.lastActive : null,
      })
    }
    sessions.sort(compareCandidates)
    normalized.push({ workspaceId, sessions })
  }
  normalized.sort((left, right) =>
    left.workspaceId < right.workspaceId ? -1 : left.workspaceId > right.workspaceId ? 1 : 0)

  const total = normalized.reduce((sum, group) => sum + group.sessions.length, 0)
  /** workspaceId → 已选会话（先首轮，后补位）。 */
  const picked = new Map(normalized.map(group => [group.workspaceId, []]))
  let remaining = Math.min(limit, total)

  // 首轮：工作区轮转，每区最多 quota 个。
  for (let round = 0; round < quota && remaining > 0; round += 1) {
    let progressed = false
    for (const group of normalized) {
      if (remaining <= 0) break
      const taken = picked.get(group.workspaceId)
      if (taken.length >= quota) continue
      const next = group.sessions[taken.length]
      if (next === undefined) continue
      taken.push(next)
      remaining -= 1
      progressed = true
    }
    if (!progressed) break
  }

  // 补位：剩余预算按未归类数量从大到小分配。
  const leftovers = normalized
    .map(group => ({
      group,
      left: group.sessions.slice(picked.get(group.workspaceId).length),
    }))
    .filter(item => item.left.length > 0)
    .sort((left, right) => {
      if (right.group.sessions.length !== left.group.sessions.length) {
        return right.group.sessions.length - left.group.sessions.length
      }
      return left.group.workspaceId < right.group.workspaceId ? -1 : 1
    })
  for (const item of leftovers) {
    if (remaining <= 0) break
    const taken = picked.get(item.group.workspaceId)
    for (const session of item.left) {
      if (remaining <= 0) break
      taken.push(session)
      remaining -= 1
    }
  }

  const selected = []
  const allocation = []
  for (const group of normalized) {
    const taken = picked.get(group.workspaceId)
    allocation.push({
      workspaceId: group.workspaceId,
      count: taken.length,
      unclassified: group.sessions.length,
    })
    selected.push(...taken)
  }

  return {
    selected,
    overflow: Math.max(0, total - selected.length),
    total,
    allocation,
  }
}

/**
 * 启动扫描（延迟 30s 由 apply() 负责；这里只管逻辑）。
 *
 * 遍历所有工作区，把**未归类、未锁定、游标未处理过**的会话入队。
 * 名额按工作区公平分配（见 `planWorkspaceFairScan`），单次最多 60 个；
 * 其余记一条「剩余下次启动继续」。模型未配置或 `autoClassify:false`
 * 时直接跳过并记账，不报错、不抛。
 *
 * 游标：`deps.isProcessed(sessionId)` 为 true 的会话直接跳过；这样每次启动
 * 都会先处理"从没扫过"的会话，避免反复从同一批开始。入队成功的会话由
 * 调用方写进状态文件（本函数只返回 `enqueued`）。
 *
 * @param deps - `{enabled, isModelConfigured, listWorkspaces, collectSessions,
 *   readStore, isProcessed, enqueue, log, limit, workspaceQuota}`。
 *   - `listWorkspaces()` → `[{id}]`
 *   - `collectSessions(workspaceId)` → `[{sessionId, lastActive}]`
 *   - `readStore(workspaceId)` → store
 *   - `isProcessed(sessionId)` → boolean（可选）
 *   - `enqueue(sessionId, candidate)` → 返回 false 表示被队列去重（可选）
 * @returns `{enabled, queued, overflow, workspaces, skipped, allocation, enqueued}`。
 */
export async function runStartupScan(deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const enabled = deps.enabled !== false
  const isProcessed = typeof deps.isProcessed === 'function' ? deps.isProcessed : () => false
  const result = {
    enabled,
    queued: 0,
    overflow: 0,
    workspaces: 0,
    skipped: '',
    allocation: [],
    enqueued: [],
  }
  if (!enabled) {
    result.skipped = 'disabled'
    log('自动归类启动扫描跳过：autoClassify:false', { kind: 'startup-scan', skipped: 'disabled' })
    return result
  }

  let configured = true
  try {
    configured = typeof deps.isModelConfigured === 'function' ? await deps.isModelConfigured() : true
  } catch {
    configured = false
  }
  if (!configured) {
    result.skipped = 'no-model'
    log('自动归类启动扫描跳过：模型未配置', { kind: 'startup-scan', skipped: 'no-model' })
    return result
  }

  let workspaces = []
  try {
    workspaces = typeof deps.listWorkspaces === 'function' ? await deps.listWorkspaces() : []
  } catch (error) {
    result.skipped = 'list-workspaces-failed'
    log(`自动归类启动扫描失败：读取工作区失败（${error instanceof Error ? error.message : String(error)}）`,
      { kind: 'startup-scan', skipped: 'list-workspaces-failed' })
    return result
  }
  if (!Array.isArray(workspaces)) workspaces = []
  result.workspaces = workspaces.length

  const groups = []
  for (const workspace of workspaces) {
    const workspaceId = trimSessionId(workspace?.id)
    if (workspaceId === '') continue
    let sessions = []
    try {
      sessions = typeof deps.collectSessions === 'function' ? await deps.collectSessions(workspaceId) : []
    } catch (error) {
      log(`自动归类启动扫描：工作区 ${workspaceId} 读取会话失败（${error instanceof Error ? error.message : String(error)}）`,
        { kind: 'startup-scan', workspaceId, error: true })
      continue
    }
    let store = {}
    try {
      store = typeof deps.readStore === 'function' ? await deps.readStore(workspaceId) : {}
    } catch (error) {
      log(`自动归类启动扫描：工作区 ${workspaceId} 读取分类失败（${error instanceof Error ? error.message : String(error)}）`,
        { kind: 'startup-scan', workspaceId, error: true })
      continue
    }
    const candidates = []
    for (const session of Array.isArray(sessions) ? sessions : []) {
      const sessionId = trimSessionId(session?.sessionId)
      if (sessionId === '') continue
      if (!isSessionUnclassified(store, sessionId)) continue
      if (isSessionLocked(store, sessionId)) continue
      if (isProcessed(sessionId)) continue
      candidates.push({ sessionId, lastActive: session?.lastActive })
    }
    if (candidates.length > 0) groups.push({ workspaceId, sessions: candidates })
  }

  const planned = planWorkspaceFairScan(groups, {
    limit: deps.limit ?? STARTUP_SCAN_LIMIT,
    workspaceQuota: deps.workspaceQuota ?? STARTUP_SCAN_WORKSPACE_QUOTA,
  })
  result.overflow = planned.overflow
  result.allocation = planned.allocation
  for (const candidate of planned.selected) {
    try {
      const accepted = typeof deps.enqueue === 'function'
        ? await deps.enqueue(candidate.sessionId, candidate)
        : true
      if (accepted === false) continue
      result.queued += 1
      result.enqueued.push({ sessionId: candidate.sessionId, workspaceId: candidate.workspaceId })
    } catch (error) {
      log(`自动归类启动扫描：会话 ${candidate.sessionId} 入队失败（${error instanceof Error ? error.message : String(error)}）`,
        { kind: 'startup-scan', sessionId: candidate.sessionId, error: true })
    }
  }
  if (planned.overflow > 0) {
    log(`自动归类启动扫描：入队 ${result.queued} 个会话，剩余 ${planned.overflow} 个下次启动继续`,
      { kind: 'startup-scan', queued: result.queued, overflow: planned.overflow })
  } else if (result.queued > 0) {
    log(`自动归类启动扫描：入队 ${result.queued} 个会话`,
      { kind: 'startup-scan', queued: result.queued, overflow: 0 })
  }
  return result
}

// ── 每日维护 ──────────────────────────────────────────────────────

/**
 * 每日维护的触发条件：未归类 >3，或任一候选主题 ≥3 个会话。
 *
 * @param input - `{unclassifiedCount, themeSizes}`。
 * @returns 是否触发。
 */
export function shouldTriggerDailyMaintenance(input = {}) {
  const unclassified = Number(input?.unclassifiedCount)
  if (Number.isFinite(unclassified) && unclassified > DAILY_MAINTENANCE_UNCLASSIFIED_THRESHOLD) return true
  const themes = Array.isArray(input?.themeSizes) ? input.themeSizes : []
  return themes.some(size => Number.isFinite(size) && size >= DAILY_MAINTENANCE_THEME_THRESHOLD)
}

/**
 * 每日闸门：本地自然日变化后的第一次活动允许跑一次。
 *
 * `claim()` 原子地完成"看今天跑没跑 + 看条件 + 占坑"；同一天后续调用
 * 返回 `run:false`。失败也不重试（产品要的是每天至多一次，不是追到成功）。
 *
 * @param options - `{now}`。
 */
export function createDailyMaintenanceGate(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  /** workspaceId → 最近一次尝试的本地自然日。 */
  const lastDay = new Map()
  return {
    /** 今天是否已经尝试过。 */
    ranToday(workspaceId) {
      const key = trimSessionId(workspaceId) === '' ? 'default' : trimSessionId(workspaceId)
      return lastDay.get(key) === localDayKey(now())
    },
    /**
     * 尝试占用今天这一次维护机会。
     *
     * @returns `{run, day, reason}`；只有 `run:true` 时才真正调模型。
     */
    claim(workspaceId, input = {}) {
      const key = trimSessionId(workspaceId) === '' ? 'default' : trimSessionId(workspaceId)
      const day = localDayKey(now())
      if (lastDay.get(key) === day) return { run: false, day, reason: 'already-ran' }
      if (!shouldTriggerDailyMaintenance(input)) {
        return { run: false, day, reason: 'below-threshold' }
      }
      lastDay.set(key, day)
      return { run: true, day, reason: 'triggered' }
    },
    reset() {
      lastDay.clear()
    },
  }
}

/**
 * 每日维护提示词：只允许「合并近义 / 改名 / 拆分过大组」。
 *
 * @param store - 分类 store。
 * @param sessions - 未归类会话 `[{sessionId, title}]`（给拆分选会话用）。
 * @returns `{system, user}`。
 */
export function buildMaintenancePrompt(store, sessions = []) {
  const paths = listCategoryPaths(store)
  const system = [
    '你在维护一个已由模型自动生成的分类树。人只保留纠正权，不要新建大类。',
    '只输出一个 JSON 对象，不要 Markdown 代码围栏、不要解释。',
    '允许三类动作，缺省用空数组：',
    '{"merge":[{"ids":["c-xxx","c-yyy"],"name":"合并后的名字"}],',
    ' "rename":[{"id":"c-xxx","name":"新名字"}],',
    ' "split":[{"id":"c-xxx","name":"新子类名","sessions":["会话 id"]}]}',
    '规则：',
    '- merge 只合并意思相同的近义分类；ids 至少两个，name 复用更清楚的那个名字。',
    '- rename 只在名字含混时改；新名字 2-8 个字。',
    '- split 只处理会话数明显过多的分类；把其中同主题的会话拆到一个新子类下。',
    '- split 的 sessions 只能从该分类下列出的会话 id 里选，最多 12 个。',
    '- 标了 source=user 的分类不要 merge、不要 rename，也不要作为 split 的来源。',
    '- 没有把握就输出 {"merge":[],"rename":[],"split":[]}，不要硬凑。',
  ].join('\n')

  // 过大的分类要给出具体会话 id，否则模型只会看到计数、编不出可执行的 split。
  const sessionsByCategory = new Map()
  const assignments = isPlainObject(store?.assignments) ? store.assignments : {}
  for (const [sessionId, raw] of Object.entries(assignments)) {
    const categoryId = typeof raw === 'string'
      ? raw.trim()
      : isPlainObject(raw) && typeof raw.categoryId === 'string' ? raw.categoryId.trim() : ''
    if (categoryId === '') continue
    const list = sessionsByCategory.get(categoryId)
    if (list === undefined) sessionsByCategory.set(categoryId, [sessionId])
    else list.push(sessionId)
  }

  const categoryLines = paths.map(item => {
    const line = `- id ${item.id}｜${item.pathText || item.name}｜${item.count} 个会话｜source=${item.source}`
    if (item.count < MAINTENANCE_OVERSIZED_MIN) return line
    const ids = (sessionsByCategory.get(item.id) ?? []).slice(0, MAINTENANCE_SPLIT_SESSIONS_HINT)
    return ids.length === 0 ? line : `${line}｜会话：${ids.join(', ')}`
  })
  const sessionLines = (Array.isArray(sessions) ? sessions : []).slice(0, 20).map(item =>
    `- ${item.sessionId}｜${canonicalName(item.title) || '（无标题）'}`)
  const user = [
    `当前分类（共 ${paths.length} 个）：`,
    categoryLines.length > 0 ? categoryLines.join('\n') : '（空）',
    '',
    `未归类会话（最多列 20 个，共 ${Array.isArray(sessions) ? sessions.length : 0} 个）：`,
    sessionLines.length > 0 ? sessionLines.join('\n') : '（无）',
    '',
    '请只输出那个 JSON 对象。',
  ].join('\n')
  return { system, user }
}

/** 从模型输出里抽第一个可解析的 JSON 对象（容忍围栏与前后解释）。 */
function extractJsonObject(text) {
  const source = String(text ?? '').replace(/```[a-zA-Z]*\n?/g, '')
  const direct = source.trim()
  try {
    const parsed = JSON.parse(direct)
    if (isPlainObject(parsed)) return parsed
  } catch {
    // 继续按括号跨度找
  }
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < source.length; index += 1) {
      const char = source[index]
      if (inString) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') { inString = true; continue }
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) {
          try {
            const parsed = JSON.parse(source.slice(start, index + 1))
            if (isPlainObject(parsed)) return parsed
          } catch {
            break
          }
        }
      }
    }
  }
  return null
}

/**
 * 解析每日维护输出。
 *
 * @param text - 模型输出。
 * @returns `{ops:{merge,rename,split}}` 或 `{error}`。
 */
export function parseMaintenanceOps(text) {
  const parsed = extractJsonObject(text)
  if (parsed === null) return { error: '模型输出不是可解析的 JSON 对象' }
  const source = isPlainObject(parsed.ops) ? parsed.ops : parsed
  const listOf = value => (Array.isArray(value) ? value : [])
  return {
    ops: {
      merge: listOf(source.merge),
      rename: listOf(source.rename),
      split: listOf(source.split),
    },
  }
}

function normalizeDailyName(value) {
  return canonicalName(value).slice(0, CATEGORY_NAME_MAX)
}

/**
 * 把模型维护动作校验成可执行步骤（纯函数，不改 store）。
 *
 * 保护口径：
 *   - `source:'user'` 的分类不参与 merge / rename / split；
 *   - 锁定会话、`source:'user'` 的归类不会被 split 移动；
 *   - 未知 id、空名字、不足两项的 merge 直接跳过并记账。
 *
 * @param store - 分类 store。
 * @param raw - `{merge,rename,split}`（parseMaintenanceOps 的输出）。
 * @returns `{steps, skipped}`；steps 可直接交给 `applyMaintenanceSteps`。
 */
export function normalizeMaintenanceOps(store, raw) {
  const ops = isPlainObject(raw?.ops) ? raw.ops : isPlainObject(raw) ? raw : {}
  const steps = []
  const skipped = []

  const categories = categoriesOf(store)
  const userOwned = new Set(
    categories.filter(c => c?.source === SOURCE_USER).map(c => c.id),
  )

  for (const item of Array.isArray(ops.merge) ? ops.merge : []) {
    if (!isPlainObject(item)) continue
    const ids = []
    for (const value of Array.isArray(item.ids) ? item.ids : []) {
      const id = typeof value === 'string' ? value.trim() : ''
      if (id !== '' && !ids.includes(id) && findCategory(store, id) !== null) ids.push(id)
    }
    if (ids.length < 2) { skipped.push({ kind: 'merge', reason: '分类不足两个' }); continue }
    const blocked = ids.filter(id => userOwned.has(id))
    if (blocked.length > 0) {
      skipped.push({ kind: 'merge', ids: blocked, reason: '人工分类不参与合并' })
      continue
    }
    steps.push({ kind: 'merge', ids, name: normalizeDailyName(item.name), source: SOURCE_MODEL })
  }

  for (const item of Array.isArray(ops.rename) ? ops.rename : []) {
    if (!isPlainObject(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const category = findCategory(store, id)
    if (category === null) { skipped.push({ kind: 'rename', id, reason: '分类不存在' }); continue }
    if (category.source === SOURCE_USER) {
      skipped.push({ kind: 'rename', id, reason: '人工分类不改名' })
      continue
    }
    const name = normalizeDailyName(item.name)
    if (name === '') { skipped.push({ kind: 'rename', id, reason: '新名字为空' }); continue }
    steps.push({ kind: 'rename', id, name, source: SOURCE_MODEL })
  }

  for (const item of Array.isArray(ops.split) ? ops.split : []) {
    if (!isPlainObject(item)) continue
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    const category = findCategory(store, id)
    if (category === null) { skipped.push({ kind: 'split', id, reason: '分类不存在' }); continue }
    if (category.source === SOURCE_USER) {
      skipped.push({ kind: 'split', id, reason: '人工分类不拆分' })
      continue
    }
    const name = normalizeDailyName(item.name)
    if (name === '') { skipped.push({ kind: 'split', id, reason: '子类名为空' }); continue }
    const sessions = []
    for (const value of Array.isArray(item.sessions) ? item.sessions : []) {
      const sessionId = trimSessionId(value)
      if (sessionId === '' || sessions.includes(sessionId)) continue
      const assignment = assignmentOf(store, sessionId)
      if (assignment === null || assignment.categoryId !== id) continue
      if (assignment.source === SOURCE_USER) continue
      if (isSessionLocked(store, sessionId)) continue
      sessions.push(sessionId)
    }
    if (sessions.length === 0) { skipped.push({ kind: 'split', id, reason: '没有可移动的会话' }); continue }
    steps.push({ kind: 'split-new', id, name, sessions, source: SOURCE_MODEL })
  }

  return { steps, skipped }
}

/**
 * 执行维护步骤：只走 `applyModelFill` 与 organize 的 plan/apply。
 *
 * 每一步都先算后写；某一步失败只跳过该步，不影响后面的步骤。
 * 返回的 store 已带回锁定表。
 *
 * @param store - 分类 store。
 * @param steps - `normalizeMaintenanceOps` 的 steps。
 * @returns `{store, applied, skipped}`。
 */
export function applyMaintenanceSteps(store, steps) {
  let next = isPlainObject(store) ? store : { version: 1, categories: [], assignments: {} }
  const applied = []
  const skipped = []

  for (const step of Array.isArray(steps) ? steps : []) {
    if (!isPlainObject(step)) continue
    if (step.kind === 'merge' || step.kind === 'rename') {
      const ids = step.kind === 'merge' ? (Array.isArray(step.ids) ? step.ids : []) : [step.id]
      if (ids.some(id => findCategory(next, id)?.source === SOURCE_USER)) {
        skipped.push({ kind: step.kind, reason: '人工分类不参与维护' })
        continue
      }
      const planned = planOrganize(next, { ...step, source: SOURCE_MODEL })
      if (planned.error) { skipped.push({ kind: step.kind, reason: planned.error }); continue }
      if (planned.noop === true) continue
      const result = applyPlan(next, planned.plan)
      if (result.error) { skipped.push({ kind: step.kind, reason: result.error }); continue }
      next = carryLockedSessions(next, result.store)
      applied.push({ kind: step.kind, summary: planned.plan.summary })
      continue
    }

    if (step.kind === 'split-new') {
      const source = findCategory(next, step.id)
      if (source === null || source.source === SOURCE_USER) {
        skipped.push({ kind: 'split', reason: '人工分类不拆分' })
        continue
      }
      // 先筛会话再建分类，避免留下空子类。
      const moves = []
      for (const sessionId of Array.isArray(step.sessions) ? step.sessions : []) {
        const assignment = assignmentOf(next, sessionId)
        if (assignment === null || assignment.categoryId !== step.id) continue
        if (assignment.source === SOURCE_USER) continue
        if (isSessionLocked(next, sessionId)) continue
        moves.push(sessionId)
      }
      if (moves.length === 0) { skipped.push({ kind: 'split', reason: '没有可移动的会话' }); continue }

      const created = ensureCategoryPath(next, step.id, [step.name])
      if (created.error) { skipped.push({ kind: 'split', reason: created.error }); continue }
      next = created.store
      const planned = planOrganize(next, {
        kind: 'split',
        id: step.id,
        moves: moves.map(sessionId => ({ sessionId, toId: created.categoryId })),
        source: SOURCE_MODEL,
      })
      if (planned.error) { skipped.push({ kind: 'split', reason: planned.error }); continue }
      if (planned.noop === true) { skipped.push({ kind: 'split', reason: planned.reason ?? '没有变化' }); continue }
      const result = applyPlan(next, planned.plan)
      if (result.error) { skipped.push({ kind: 'split', reason: result.error }); continue }
      next = carryLockedSessions(next, result.store)
      applied.push({ kind: 'split', summary: planned.plan.summary })
    }
  }

  return { store: next, applied, skipped }
}

// ── 空分类清理 / 工作区重置 ──────────────────────────────────────

/** 所有 assignments 的 `{sessionId, categoryId, source}`（忽略空/坏值）。 */
function assignmentEntriesOf(store) {
  const out = []
  const assignments = isPlainObject(store?.assignments) ? store.assignments : {}
  for (const sessionId of Object.keys(assignments)) {
    const assignment = assignmentOf(store, sessionId)
    if (assignment === null || assignment.categoryId === null) continue
    out.push({ sessionId, categoryId: assignment.categoryId, source: assignment.source })
  }
  return out
}

/** 某分类子树里是否含被人工锁定的会话。 */
function subtreeHasLockedSession(store, categoryId) {
  const childrenOf = new Map()
  for (const category of categoriesOf(store)) {
    const parentId = typeof category?.parentId === 'string' ? category.parentId : ''
    if (parentId === '') continue
    const list = childrenOf.get(parentId)
    if (list === undefined) childrenOf.set(parentId, [category.id])
    else list.push(category.id)
  }
  const root = typeof categoryId === 'string' ? categoryId : ''
  if (root === '') return false
  const seen = new Set()
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (seen.has(current)) continue
    seen.add(current)
    for (const child of childrenOf.get(current) ?? []) stack.push(child)
  }
  // assignment 的会话是否锁定
  for (const entry of assignmentEntriesOf(store)) {
    if (!seen.has(entry.categoryId)) continue
    if (isSessionLocked(store, entry.sessionId)) return true
  }
  return false
}

/**
 * 清理「模型建了但从未归进过会话」的空分类（自底向上）。
 *
 * 产品背景：模型有时会建出空分类（父分类 + 空子类），用户点进去没有任何
 * 轮次，看起来像功能坏了。清理口径：
 *   - 只删 `source` 不是 `'user'` 的分类（历史文件没有 source 按 model 处理）；
 *   - 只删**叶子**（有子分类的先不动，等子类删掉后再判断）；
 *   - 子树会话数为 0 才删；子树里含人工锁定会话的一律不删；
 *   - 删掉子类后父类若变空，同一轮继续删（while 循环直到稳定）。
 *
 * @param store - 分类 store。
 * @returns `{store, purged:[{id,name}], count}`；锁定表原样带回。
 */
export function purgeEmptyCategories(store) {
  const base = isPlainObject(store) ? store : { version: 1, categories: [], assignments: {} }
  let categories = Array.isArray(base.categories) ? base.categories.slice() : []
  const assignments = isPlainObject(base.assignments) ? base.assignments : {}
  const purged = []
  let changed = true

  while (changed) {
    changed = false
    const childCount = new Map()
    for (const category of categories) {
      if (!isPlainObject(category)) continue
      const parentId = typeof category.parentId === 'string' ? category.parentId : ''
      if (parentId === '') continue
      childCount.set(parentId, (childCount.get(parentId) ?? 0) + 1)
    }
    const sessionsByCategory = new Map()
    for (const entry of assignmentEntriesOf({ ...base, categories, assignments })) {
      const list = sessionsByCategory.get(entry.categoryId)
      if (list === undefined) sessionsByCategory.set(entry.categoryId, [entry.sessionId])
      else list.push(entry.sessionId)
    }

    for (const category of categories) {
      if (!isPlainObject(category) || typeof category.id !== 'string') continue
      // 人工分类永远不删；历史脏数据没有 source 的按模型分类处理。
      if (category.source === SOURCE_USER) continue
      // 有子分类的先不动：先删子树，父类可能在下一轮变成叶子。
      if ((childCount.get(category.id) ?? 0) > 0) continue
      // 叶子：子树会话数 = 直接挂在这个分类下的会话数。
      const sessionIds = sessionsByCategory.get(category.id) ?? []
      if (sessionIds.length > 0) continue
      if (subtreeHasLockedSession({ ...base, categories, assignments }, category.id)) continue
      categories = categories.filter(item => item === category ? false : item)
      purged.push({ id: category.id, name: canonicalName(category.name) })
      changed = true
    }
  }

  return {
    store: carryLockedSessions(base, { ...base, categories, assignments }),
    purged,
    count: purged.length,
  }
}

/**
 * 工作区「重新归类」：删掉模型分类及对应 assignments，保留人工的东西。
 *
 * 保留规则（对应产品口径）：
 *   - `source:'user'` 的分类永远保留；
 *   - 被 `source:'user'` 归类指向的分类保留（人工纠正不能被一次重置抹掉）；
 *   - 被人工锁定会话指向的分类保留（锁定的意义就是模型不再动它）；
 *   - `lockedSessions` 原样保留。
 *
 * 被删分类的模型 assignments 一并删除；人工分类若挂在被删父分类下，会
 * 上提到最近的幸存祖先（没有就回顶层），不制造悬空 parentId。
 *
 * @param store - 分类 store。
 * @returns `{store, removedCategories, removedAssignments, keptUser}`。
 */
export function resetModelCategories(store) {
  const base = isPlainObject(store) ? store : { version: 1, categories: [], assignments: {} }
  const categories = Array.isArray(base.categories)
    ? base.categories.filter(category => isPlainObject(category)).map(category => ({ ...category }))
    : []
  const assignments = isPlainObject(base.assignments) ? { ...base.assignments } : {}
  const byId = new Map(categories.map(category => [category.id, category]))
  const entries = assignmentEntriesOf(base)

  /** 人工归类 / 锁定会话指向的模型分类：必须保留，否则会丢用户数据。 */
  const protectedIds = new Set()
  for (const entry of entries) {
    if (entry.source === SOURCE_USER || isSessionLocked(base, entry.sessionId)) {
      protectedIds.add(entry.categoryId)
    }
  }

  const removedIds = new Set()
  for (const category of categories) {
    if (category.source === SOURCE_USER) continue
    if (protectedIds.has(category.id)) continue
    removedIds.add(category.id)
  }

  let removedAssignments = 0
  for (const [sessionId] of Object.entries(assignments)) {
    const assignment = assignmentOf(base, sessionId)
    if (assignment === null || assignment.categoryId === null) continue
    if (!removedIds.has(assignment.categoryId)) continue
    delete assignments[sessionId]
    removedAssignments += 1
  }

  const survivors = categories.filter(category => !removedIds.has(category.id))
  /** 被删父级 → 最近的幸存祖先（防成环，找不到回顶层）。 */
  const survivingAncestorOf = parentId => {
    const seen = new Set()
    let current = typeof parentId === 'string' ? parentId : ''
    while (current !== '' && removedIds.has(current) && !seen.has(current)) {
      seen.add(current)
      current = typeof byId.get(current)?.parentId === 'string' ? byId.get(current).parentId : ''
    }
    return current === '' || removedIds.has(current) ? null : current
  }
  for (const category of survivors) {
    const parentId = category.parentId ?? null
    if (parentId === null) continue
    if (!removedIds.has(parentId)) continue
    category.parentId = survivingAncestorOf(parentId)
  }

  const keptUser = survivors.filter(category => category.source === SOURCE_USER).length
  return {
    store: carryLockedSessions(base, {
      ...base,
      categories: survivors,
      assignments,
    }),
    removedCategories: removedIds.size,
    removedAssignments,
    keptUser,
  }
}

/**
 * 从启动游标里移除一批会话（工作区重置后让它们重新参与扫描）。
 *
 * @param state - `normalizeAutoClassifyState` 的输出或裸 JSON。
 * @param sessionIds - 要清除的会话 id 数组。
 * @returns 新状态（`lastRunAt` 保留）。
 */
export function removeAutoProcessedSessions(state, sessionIds) {
  const base = normalizeAutoClassifyState(state)
  const processed = { ...base.processed }
  for (const item of Array.isArray(sessionIds) ? sessionIds : []) {
    const sessionId = trimSessionId(typeof item === 'string' ? item : item?.sessionId)
    if (sessionId === '') continue
    delete processed[sessionId]
  }
  return { lastRunAt: base.lastRunAt, processed }
}

// ── 诊断日志 ──────────────────────────────────────────────────────

/**
 * 有界内存诊断日志：自动归类/维护失败、跳过原因、弃用端点访问都记这里。
 *
 * 不落盘：这是排障线索，不是业务数据；进程重启后归零可以接受。
 *
 * @param options - `{limit}`，默认 200 条。
 */
export function createDiagnosticsLog(options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 200
  const entries = []
  let seq = 0
  const now = typeof options.now === 'function' ? options.now : Date.now
  return {
    /**
     * 记一条。`entry.kind` 必填（如 `auto-classify-failed`），其余字段原样带上。
     */
    record(entry) {
      if (!isPlainObject(entry)) return
      entries.unshift({ at: now(), seq: seq++, ...cloneValue(entry) })
      seq = entries.length > 0 ? entries[0].seq + 1 : 0
      if (entries.length > limit) entries.length = limit
    },
    /** 最新在前；`count` 是本次返回条数。 */
    list(count = 50) {
      const size = Number.isFinite(count) && count > 0 ? Math.floor(count) : 50
      return entries.slice(0, size)
    },
    clear() {
      entries.length = 0
      seq = 0
    },
  }
}
