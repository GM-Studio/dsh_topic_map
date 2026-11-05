/**
 * 界面状态：任务状态的手动覆盖 + 筛选条件。
 *
 * 为什么放 Host 落盘而不是 sessionStorage：
 *
 * 1. 这些是"我对这个会话的判断"，换台机器、换个浏览器应该还在。
 * 2. sessionStorage 与标签页绑定，用户开两个窗口看同一个会话会不同步。
 * 3. 状态覆盖本质上是对内容的批注，属于数据而不是临时视图状态。
 *
 * 筛选条件虽然更像视图状态，但它与"我在看什么"强相关，跨会话切换后
 * 再回来还应该保持——所以一起放这里，并同样按会话分文件。
 *
 * 存储位置与分段结果同级：`<DSH home>/topic-map/ui/<sessionId>.json`。
 *
 * @module dsh-topic-map/ui-state
 */

/** 允许的状态值，与 pm-model 保持一致。 */
const VALID_STATES = ['todo', 'active', 'blocked', 'done']

/** 筛选条件里允许的字段。 */
const FILTER_FIELDS = ['query', 'stages', 'states', 'minTurns', 'maxTurns']

/**
 * 归一化一份 UI 状态，丢弃非法内容。
 *
 * 为什么严格清洗：这个文件可能被手工编辑过，也可能来自旧版本。
 * 让非法值流进渲染会以难以定位的方式出错，不如在入口就归位。
 *
 * @param raw - 原始对象。
 * @returns 干净的 UI 状态。
 */
export function normalizeUiState(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}

  // 状态覆盖：只保留 { laneId: validState }
  const overrides = {}
  const rawOverrides = src.overrides !== null && typeof src.overrides === 'object' ? src.overrides : {}
  for (const [laneId, state] of Object.entries(rawOverrides)) {
    if (typeof laneId !== 'string' || laneId === '') continue
    if (typeof state !== 'string' || !VALID_STATES.includes(state)) continue
    overrides[laneId] = state
  }

  // 筛选条件
  const rawFilter = src.filter !== null && typeof src.filter === 'object' ? src.filter : {}
  const filter = {
    query: typeof rawFilter.query === 'string' ? rawFilter.query : '',
    stages: Array.isArray(rawFilter.stages)
      ? rawFilter.stages.filter(s => typeof s === 'string' && s !== '')
      : [],
    states: Array.isArray(rawFilter.states)
      ? rawFilter.states.filter(s => typeof s === 'string' && s !== '')
      : [],
    minTurns: Number.isFinite(rawFilter.minTurns) && rawFilter.minTurns > 0
      ? Math.floor(rawFilter.minTurns)
      : null,
    maxTurns: Number.isFinite(rawFilter.maxTurns) && rawFilter.maxTurns > 0
      ? Math.floor(rawFilter.maxTurns)
      : null,
  }

  // 模型复核结果（整份存下）：一次复核要花 token，切走再回来不该白费。
  // 只保留必要字段，避免把大对象写进配置文件。
  let review = null
  if (src.review !== null && src.review !== undefined && typeof src.review === 'object') {
    const r = src.review
    const entries = Array.isArray(r.entries)
      ? r.entries
          .filter(e => e !== null && typeof e === 'object' && typeof e.laneId === 'string')
          .map(e => ({
            laneId: e.laneId,
            state: VALID_STATES.includes(e.state) ? e.state : 'todo',
            basis: typeof e.basis === 'string' ? e.basis : '',
            reviewed: e.reviewed === true,
          }))
      : []
    review = {
      status: typeof r.status === 'string' ? r.status : 'ready',
      reviewed: Number.isFinite(r.reviewed) ? r.reviewed : 0,
      total: Number.isFinite(r.total) ? r.total : entries.length,
      via: typeof r.via === 'string' ? r.via : 'session',
      entries,
      savedAt: Number.isFinite(r.savedAt) ? r.savedAt : 0,
    }
  }

  return { overrides, filter, review, updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : 0 }
}

/**
 * 合并一次状态更新。
 *
 * 只改动提交上来的字段，其余保持不变——避免"只想标一个状态，却把筛选条件冲掉"。
 *
 * @param current - 当前 UI 状态（可为空）。
 * @param patch - 要改的字段：`{ overrides?, filter? }`。
 * @returns 新的 UI 状态。
 */
export function mergeUiState(current, patch) {
  const base = normalizeUiState(current)
  const next = {
    overrides: { ...base.overrides },
    filter: { ...base.filter },
    review: base.review,
    updatedAt: Date.now(),
  }

  if (patch !== null && patch !== undefined && typeof patch === 'object') {
    // 状态覆盖：单个 { laneId, state } 或整体替换
    if (patch.override !== undefined && patch.override !== null) {
      const { laneId, state } = patch.override
      if (typeof laneId === 'string' && laneId !== '') {
        if (state === null) delete next.overrides[laneId]
        else if (typeof state === 'string' && VALID_STATES.includes(state)) next.overrides[laneId] = state
      }
    }
    if (patch.overrides !== undefined && patch.overrides !== null && typeof patch.overrides === 'object') {
      next.overrides = normalizeUiState({ overrides: patch.overrides }).overrides
    }

    // 复核结果：整份替换；传 null 表示清除
    if (patch.review !== undefined) {
      if (patch.review === null) next.review = null
      else next.review = normalizeUiState({ review: patch.review }).review
    }

    // 筛选条件
    if (patch.filter !== undefined && patch.filter !== null && typeof patch.filter === 'object') {
      const merged = { ...next.filter }
      for (const key of FILTER_FIELDS) {
        if (patch.filter[key] !== undefined) merged[key] = patch.filter[key]
      }
      next.filter = normalizeUiState({ filter: merged }).filter
    }
  }

  return next
}

/**
 * 存储键（文件名友好）。
 * @param sessionId - 会话。
 * @returns 去掉了路径分隔符的 id。
 */
export function safeSessionId(sessionId) {
  return String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
}
