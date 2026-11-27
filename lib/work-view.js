/**
 * 「续接」页纯函数视图模型（供 scripts/build-theme.mjs 原样嵌入 lib/client.js）。
 *
 * 遵循 GLOSSARY.md 与 ADR 0001 / 0002 / 0003 / 0004：
 * - 零 import、无 DOM、不读系统时钟（所有时间基准由 `now` 入参传入）；
 * - 只产出纯数据对象、字符串、数字与数组，不做 HTML 拼接或副作用；
 * - 窄抽屉默认 4 行卡片：
 *   1) 标题 + 状态徽章 + 可信度徽章（推测虚线 / 已确认实线）+ 相对时间 + 置顶标记；
 *   2) 现状/卡点（超长按码点截断至 60 字）；
 *   3) → 下一步（空时给明确占位提示）；
 *   4) 动作条（主动作 + 更多操作菜单）；
 *   展开详情附带决策序列（现行 / 已否决 + 证据句柄）、涉及文件与跨会话段清单。
 *
 * @module dsh-topic-map/work-view
 */

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 现状/卡点第 2 行的最大显示字数（按 Unicode 码点计，含省略号）。 */
const STATUS_LINE_MAX = 60

/** 事的四态中文文案。 */
const STATE_LABELS = Object.freeze({
  active: '进行中',
  blocked: '卡住',
  done: '已完成',
  shelved: '已搁置',
})

/** 未收束状态集合。 */
const UNRESOLVED_STATES = new Set(['active', 'blocked'])

/** 三类合法拐点标识。 */
const INFLECTION_KINDS = new Set([
  'topic_switch',
  'likely_settled_or_blocked',
  'revisit_unresolved',
])

/** 决策状态中文文案。 */
const DECISION_STATUS_LABELS = Object.freeze({
  active: '现行',
  superseded: '已否决',
})

/** 是否普通对象（排除 null 与数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 转安全字符串。 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 压缩连续空白（含换行）。 */
function compress(value) {
  return textOf(value).replace(/\s+/g, ' ').trim()
}

/** 按 Unicode 码点截断，超长末尾加省略号，总长不超过 max。 */
function clipText(value, max) {
  const text = compress(value)
  if (text === '') return ''
  const chars = Array.from(text)
  if (chars.length <= max) return text
  if (max <= 1) return chars.slice(0, Math.max(0, max)).join('')
  return chars.slice(0, max - 1).join('') + '…'
}

/** 把时间统一成 epoch ms；认 Date 与有限数字，其余返回 NaN。 */
function toMs(value) {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return NaN
}

/** 本地自然日的 0 点时间戳。 */
function startOfLocalDay(ms) {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 是否同一个本地自然日。 */
function sameLocalDay(a, b) {
  return startOfLocalDay(a) === startOfLocalDay(b)
}

/** 是否同一个本地年份。 */
function sameLocalYear(a, b) {
  return new Date(a).getFullYear() === new Date(b).getFullYear()
}

/** 格式化为本地 YYYY-MM-DD。 */
function formatDate(ms) {
  const date = new Date(ms)
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return year + '-' + month + '-' + day
}

/**
 * 相对时间文案（纯函数，不读系统时钟）。
 *
 * 分档：
 * - < 1 分钟：刚刚
 * - < 1 小时：N 分钟前
 * - 同一本地自然日：今天
 * - 昨天（同一年前一天）：昨天
 * - 2–6 天（同一年）：N 天前
 * - ≥ 7 天或跨年：YYYY-MM-DD
 *
 * @param {number|Date} ts - 目标时间戳。
 * @param {number|Date} now - 参照当前时间戳。
 * @returns {string} 相对时间文案；参数非法返回空串。
 */
export function formatRelativeTime(ts, now) {
  const time = toMs(ts)
  const base = toMs(now)
  if (!Number.isFinite(time) || !Number.isFinite(base)) return ''
  const diff = base - time
  if (diff < 0) return sameLocalDay(time, base) ? '今天' : formatDate(time)
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return Math.floor(diff / MINUTE) + ' 分钟前'
  if (sameLocalDay(time, base)) return '今天'
  if (!sameLocalYear(time, base)) return formatDate(time)
  const days = Math.round((startOfLocalDay(base) - startOfLocalDay(time)) / DAY)
  if (days <= 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 7) return days + ' 天前'
  return formatDate(time)
}

/** 会话短 id：去掉常见 session- 前缀后取前 8 位。 */
function shortSessionId(sessionId) {
  const raw = compress(sessionId)
  if (raw === '') return ''
  return raw.replace(/^session[-_:]/i, '').slice(0, 8)
}

/** 归一化事的四态。 */
function normalizeState(state) {
  return typeof state === 'string' && Object.prototype.hasOwnProperty.call(STATE_LABELS, state)
    ? state
    : 'active'
}

/** 归一化可信度（confirmed / inferred）。 */
function normalizeConfidence(card) {
  const raw = compress(card.confidence || card.stateSource)
  return raw === 'confirmed' ? 'confirmed' : 'inferred'
}

/** 去重非空字符串数组。 */
function uniqueStrings(list) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const text = compress(typeof item === 'string' ? item : (isPlainObject(item) ? item.path : ''))
    if (text === '' || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/** 格式化单条决策详情项。 */
function formatDecisionItem(raw, now) {
  if (!isPlainObject(raw)) return null
  const summary = compress(raw.summary)
  if (summary === '') return null
  const status = raw.status === 'superseded' ? 'superseded' : 'active'
  const at = toMs(raw.at)
  return {
    id: compress(raw.id),
    summary,
    rationale: compress(raw.rationale),
    status,
    statusLabel: DECISION_STATUS_LABELS[status],
    supersededBy: status === 'superseded' ? (compress(raw.supersededBy) || null) : null,
    evidenceHandle: compress(raw.evidenceHandle),
    source: raw.source === 'confirmed' ? 'confirmed' : 'inferred',
    timeLabel: Number.isFinite(at) ? formatRelativeTime(at, now) : '',
  }
}

/** 提取段的起止轮号并拼装区间文案（#1–#12 或 #4）。 */
function segmentRangeOf(seg) {
  let start = null
  let end = null
  if (Array.isArray(seg.turnRange) && seg.turnRange.length >= 2) {
    const a = Number(seg.turnRange[0])
    const b = Number(seg.turnRange[1])
    if (Number.isFinite(a) && Number.isFinite(b)) {
      start = Math.trunc(a)
      end = Math.trunc(b)
    }
  }
  if (start === null || end === null) {
    const a = Number(seg.startTurn !== undefined ? seg.startTurn : seg.fromTurn)
    const b = Number(seg.endTurn !== undefined ? seg.endTurn : seg.toTurn)
    if (Number.isFinite(a) && Number.isFinite(b)) {
      start = Math.trunc(a)
      end = Math.trunc(b)
    }
  }
  if (start === null || end === null) {
    return { startTurn: null, endTurn: null, turnRangeLabel: '' }
  }
  if (end < start) {
    const tmp = start
    start = end
    end = tmp
  }
  const label = start === end ? ('#' + start) : ('#' + start + '–#' + end)
  return { startTurn: start, endTurn: end, turnRangeLabel: label }
}

/** 格式化跨会话段清单项。 */
function formatSegmentItem(raw) {
  if (!isPlainObject(raw)) return null
  const id = compress(raw.id || raw.segmentId)
  const sessionId = compress(raw.sessionId)
  const range = segmentRangeOf(raw)
  const title = compress(raw.title || raw.label) || (range.turnRangeLabel !== '' ? ('轮次 ' + range.turnRangeLabel) : '未命名段')
  return {
    id,
    sessionId,
    shortSessionId: shortSessionId(sessionId),
    sessionTitle: compress(raw.sessionTitle),
    title,
    startTurn: range.startTurn,
    endTurn: range.endTurn,
    turnRangeLabel: range.turnRangeLabel,
  }
}

/** 构造第 4 行卡片动作条（未收束 vs 已收束）。 */
function buildCardActions(resolved) {
  if (resolved) {
    return [
      { id: 'reopen', label: '重新打开', kind: 'primary' },
      { id: 'inspect', label: '看决策与证据', kind: 'secondary' },
      {
        id: 'more',
        label: '更多',
        kind: 'menu',
        items: [
          { id: 'inspect', label: '看决策与证据' },
          { id: 'merge', label: '合并' },
          { id: 'split', label: '拆段' },
          { id: 'dismiss', label: '不算事' },
        ],
      },
    ]
  }
  return [
    { id: 'resume', label: '回到现场', kind: 'primary' },
    { id: 'handoff', label: '新会话交接', kind: 'secondary' },
    { id: 'confirm_done', label: '已完成', kind: 'secondary' },
    {
      id: 'more',
      label: '更多',
      kind: 'menu',
      items: [
        { id: 'inspect', label: '看决策与证据' },
        { id: 'merge', label: '合并' },
        { id: 'split', label: '拆段' },
        { id: 'dismiss', label: '不算事' },
      ],
    },
  ]
}

/**
 * 把后端投影的单张「事」卡片格式化为可直接渲染的 4 行窄卡片 + 展开详情 UI 模型。
 *
 * @param {object} card - 后端投影卡片或 Work 对象。
 * @param {number|Date} [now] - 参照时间戳。
 * @returns {object} 格式化后的卡片 UI 模型。
 */
export function formatWorkCard(card, now) {
  const src = isPlainObject(card) ? card : {}
  const id = compress(src.id)
  const title = compress(src.title) || '未命名工作'
  const state = normalizeState(src.state)
  const resolved = !UNRESOLVED_STATES.has(state)
  const confidence = normalizeConfidence(src)
  const confirmed = confidence === 'confirmed'
  const pinned = src.pinned === true
  const lastActivityAt = toMs(src.lastActivityAt)

  const rawTime = formatRelativeTime(lastActivityAt, now)
  const timeLabel = rawTime !== '' ? rawTime : compress(src.relativeTime)

  const statusFull = compress(src.statusLine || src.statusSummary || src.goal)
  const statusLine = statusFull !== '' ? clipText(statusFull, STATUS_LINE_MAX) : '暂无现状摘要'

  const rawNextStep = compress(src.nextStep)
  const hasNextStep = rawNextStep !== ''
  const nextStepLine = hasNextStep ? ('→ 下一步：' + rawNextStep) : '→ 下一步：待补充下一步行动'

  const decisions = []
  for (const item of Array.isArray(src.decisions) ? src.decisions : []) {
    const formatted = formatDecisionItem(item, now)
    if (formatted !== null) decisions.push(formatted)
  }
  // 现行决策排前，已否决决策排后，保持各自原有相对顺序
  decisions.sort((a, b) => {
    if (a.status === b.status) return 0
    return a.status === 'active' ? -1 : 1
  })

  const files = uniqueStrings(src.files)
  const segments = []
  for (const seg of Array.isArray(src.segments) ? src.segments : []) {
    const formatted = formatSegmentItem(seg)
    if (formatted !== null) segments.push(formatted)
  }

  const sessionCount = Number.isInteger(src.sessionCount) && src.sessionCount >= 0
    ? src.sessionCount
    : (Array.isArray(src.sessionIds) ? src.sessionIds.length : 0)
  const segmentCount = Number.isInteger(src.segmentCount) && src.segmentCount >= 0
    ? src.segmentCount
    : (segments.length > 0 ? segments.length : (Array.isArray(src.segmentIds) ? src.segmentIds.length : 0))
  const decisionCount = Number.isInteger(src.decisionCount) && src.decisionCount >= 0
    ? src.decisionCount
    : decisions.length

  return {
    id,
    title,
    state,
    resolved,
    pinned,
    reviewStatus: src.reviewStatus === 'reviewed' ? 'reviewed' : 'pending',
    // 第 1 行元数据
    stateBadge: {
      state,
      label: STATE_LABELS[state],
    },
    confidenceBadge: {
      confidence,
      label: confirmed ? '已确认' : '推测',
      style: confirmed ? 'solid' : 'dashed',
      confirmed,
    },
    timeLabel,
    lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : 0,
    // 第 2 行：现状 / 卡点
    statusLine,
    statusFull,
    // 第 3 行：下一步
    nextStep: rawNextStep,
    nextStepLine,
    hasNextStep,
    // 第 4 行：动作条
    actions: buildCardActions(resolved),
    // 统计与展开详情
    sessionCount,
    segmentCount,
    decisionCount,
    decisions,
    files,
    segments,
    evidenceHandles: uniqueStrings(src.evidenceHandles),
  }
}

/**
 * 把三类自然拐点（topic_switch / likely_settled_or_blocked / revisit_unresolved）
 * 格式化为非阻塞轻确认条文案与 1 秒一键动作按钮清单。
 *
 * @param {object} inflection - 后端或 detectInflection 产出的拐点对象。
 * @returns {object|null} 轻确认条 UI 模型；输入为空或非合法拐点返回 null。
 */
export function formatInflectionBanner(inflection) {
  if (!isPlainObject(inflection)) return null
  const kind = compress(inflection.kind)
  if (!INFLECTION_KINDS.has(kind)) return null

  const workId = compress(inflection.workId)
  const title = compress(inflection.title) || '当前工作'
  const suggestedState = normalizeState(inflection.suggestedState)
  const customPrompt = compress(inflection.prompt)

  let message = customPrompt
  let actions = []

  if (kind === 'topic_switch') {
    if (message === '') message = '刚刚切离了「' + title + '」，这件事现在是什么状态？'
    actions = [
      { id: 'confirm_done', label: '✓ 标为已完成', state: 'done', kind: 'primary' },
      { id: 'keep_active', label: '确认进行中', state: 'active', kind: 'secondary' },
      { id: 'mark_shelved', label: '先搁置', state: 'shelved', kind: 'secondary' },
      { id: 'ignore', label: '忽略', state: null, kind: 'ghost' },
    ]
  } else if (kind === 'likely_settled_or_blocked') {
    if (suggestedState === 'blocked') {
      if (message === '') message = '「' + title + '」刚才出现异常或中断，是否标为卡住？'
      actions = [
        { id: 'confirm_blocked', label: '标为卡住', state: 'blocked', kind: 'primary' },
        { id: 'keep_active', label: '确认进行中', state: 'active', kind: 'secondary' },
        { id: 'ignore', label: '忽略', state: null, kind: 'ghost' },
      ]
    } else {
      if (message === '') message = '「' + title + '」看起来已经收尾，是否标为已完成？'
      actions = [
        { id: 'confirm_done', label: '✓ 标为已完成', state: 'done', kind: 'primary' },
        { id: 'keep_active', label: '确认进行中', state: 'active', kind: 'secondary' },
        { id: 'ignore', label: '忽略', state: null, kind: 'ghost' },
      ]
    }
  } else {
    // revisit_unresolved
    if (message === '') message = '回到未收束的「' + title + '」，是否继续推进？'
    actions = [
      { id: 'confirm_continue', label: '确认进行中', state: suggestedState, kind: 'primary' },
      { id: 'confirm_done', label: '✓ 标为已完成', state: 'done', kind: 'secondary' },
      { id: 'ignore', label: '忽略', state: null, kind: 'ghost' },
    ]
  }

  return {
    kind,
    workId,
    title,
    suggestedState,
    message,
    actions,
  }
}

/**
 * 把撞上已确认完成老事时的重开建议格式化为轻提示条文案与动作。
 *
 * @param {object} suggestion - suggest_reopen 建议对象。
 * @returns {object|null} 重开轻提示条 UI 模型；无效输入返回 null。
 */
export function formatReopenBanner(suggestion) {
  if (!isPlainObject(suggestion)) return null
  const workId = compress(suggestion.relatedDoneWorkId || suggestion.workId || suggestion.id)
  const title = compress(suggestion.relatedDoneWorkTitle || suggestion.title)
  if (workId === '' && title === '') return null

  const displayTitle = title || workId
  const reasonText = suggestion.reason === 'files'
    ? '改动了相同的业务文件'
    : (suggestion.reason === 'handle'
      ? '引用了原事的对话轮次'
      : (suggestion.reason === 'fork' ? '分叉自原事会话' : '与已完成的事高度相关'))

  return {
    workId,
    title: displayTitle,
    level: compress(suggestion.level),
    reason: compress(suggestion.reason),
    sharedFiles: uniqueStrings(suggestion.sharedFiles),
    message: '检测到当前工作' + reasonText + '，可能延续已完成的「' + displayTitle + '」',
    actions: [
      { id: 'reopen_link', label: '关联重开', kind: 'primary' },
      { id: 'keep_separate', label: '保持独立', kind: 'secondary' },
    ],
  }
}

/** 未收束卡片排序：置顶优先 > blocked 优先于 active > 最近活动时间倒序 > id 稳定兜底。 */
function compareUnresolvedCards(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  const aBlocked = a.state === 'blocked' ? 1 : 0
  const bBlocked = b.state === 'blocked' ? 1 : 0
  if (aBlocked !== bBlocked) return bBlocked - aBlocked
  if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt
  return a.id.localeCompare(b.id)
}

/** 已收束卡片排序：最近活动时间倒序 > id 稳定兜底。 */
function compareSettledCards(a, b) {
  if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt
  return a.id.localeCompare(b.id)
}

/**
 * 把 `POST /works` 返回组装成完整「续接」页视图模型。
 *
 * @param {object} payload - 后端 `/works` 响应。
 * @param {{ now?: number|Date, showSettled?: boolean }} [options] - 渲染选项。
 * @returns {object} 续接页完整视图模型。
 */
export function workBoardModel(payload, options) {
  const data = isPlainObject(payload) ? payload : {}
  const opts = isPlainObject(options) ? options : {}
  const now = opts.now
  const showSettled = opts.showSettled === true

  const rawUnresolved = Array.isArray(data.unresolved) ? data.unresolved : []
  const rawSettled = Array.isArray(data.settled) ? data.settled : []

  const cards = rawUnresolved
    .filter(isPlainObject)
    .map(item => formatWorkCard(item, now))
    .sort(compareUnresolvedCards)

  const settledCards = rawSettled
    .filter(isPlainObject)
    .map(item => formatWorkCard(item, now))
    .sort(compareSettledCards)

  const rawPending = Number(data.pendingReviewCount)
  const pendingReviewCount = Number.isFinite(rawPending) && rawPending > 0
    ? Math.floor(rawPending)
    : 0
  const pendingReviewBanner = pendingReviewCount > 0
    ? {
        count: pendingReviewCount,
        message: '系统自动整理出 ' + pendingReviewCount + ' 件待确认的事 — 确认哪些还在推进，改完即锁定不再被覆盖',
        action: { id: 'open_review', label: '开始逐条核对' },
        exitAction: { id: 'exit_review', label: '退出核对' },
        confirmAllAction: { id: 'confirm_all', label: '全部确认无误' },
      }
    : null

  const reopenBanners = []
  for (const item of Array.isArray(data.reopenSuggestions) ? data.reopenSuggestions : []) {
    const formatted = formatReopenBanner(item)
    if (formatted !== null) reopenBanners.push(formatted)
  }

  const inflectionBanner = formatInflectionBanner(data.inflection)

  const coldStartStatus = compress(data.coldStartStatus || data.status)
  const isColdStarting = data.coldStarting === true
    || data.scanning === true
    || coldStartStatus === 'scanning'
    || coldStartStatus === 'warming'
    || coldStartStatus === 'indexing'

  // 空态判定（ADR-0008）：四种情况必须可区分，不能让用户把
  // 「还没扫描」「正在扫描」「扫描失败」「确实无事」看成同一句话。
  const failedText = compress(data.error)
  const neverScanned = data.initialized === false

  let empty = null
  if (cards.length === 0) {
    if (failedText !== '') {
      // 失败态：明确告诉用户是读取失败，并给出重试入口（不是「无事」）。
      empty = {
        kind: 'failed',
        title: '盘点失败',
        description: '读取这个工作区的事时出错了：' + clipText(failedText, 120)
          + '。已经存下的结果不会丢，可以直接重试。',
        action: { id: 'retry_scan', label: '重试' },
      }
    } else if (neverScanned) {
      // 未扫描态：从没盘点过 ≠ 没有事要办。
      empty = {
        kind: 'unscanned',
        title: '这个工作区还没有盘点过',
        description: '点下面的按钮开始盘点已有的事；盘点结果会一直保留，不用每次重扫。',
        action: { id: 'start_scan', label: '开始盘点' },
      }
    } else if (data.conversationCount === 0 && Number(data.emptySessionCount) > 0) {
      // 五态之 no_content（ADR-0012）：有会话壳，但没有可读对话。
      // 必须与「确实无事」分开，否则等于告诉用户「你已经做完了」。
      const empties = Math.max(0, Math.floor(Number(data.emptySessionCount)))
      empty = {
        kind: 'no_content',
        title: '本工作区没有可读的对话',
        description: empties + ' 个会话都没有任何轮次（0 轮），所以既切不出段、也没有可续接的事。'
          + '这不是提取失败，重扫也不会变出内容。',
        action: { id: 'open_history', label: '去「历史」看看' },
      }
    } else if (isColdStarting) {
      empty = {
        kind: 'cold_start',
        title: '冷启动整理中，正在盘点本工作区的工作记录…',
        description: '首次盘点会在后台异步完成，可先在「历史」页检索与浏览对话。',
        action: { id: 'open_history', label: '去「历史」查看对话' },
      }
    } else {
      empty = {
        kind: 'no_unresolved',
        title: '本工作区暂无未收束的事',
        description: '所有进行中或卡住的工作都会自动汇集到这里；日常交流可去「历史」看话题回溯。',
        action: { id: 'open_history', label: '去「历史」看话题回溯' },
      }
    }
  }

  return {
    pendingReviewCount,
    pendingReviewBanner,
    reopenBanners,
    inflectionBanner,
    cards,
    settledSection: {
      count: settledCards.length,
      expanded: showSettled,
      label: settledCards.length > 0 ? ('已收束（' + settledCards.length + '）') : '已收束',
      cards: settledCards,
      visibleCards: showSettled ? settledCards : [],
    },
    empty,
  }
}
// ── 工作区切区状态机与空态（ADR-0008）──────────────────────────────

/**
 * 续接面板的「我该显示什么」状态机（纯函数）。
 *
 * 解决两个真机问题：
 * 1. **串台**：切工作区时旧的 `raw` 还挂在 state 上被继续渲染，用户会看到
 *    上一个工作区的卡片短暂出现。这里把「数据所属工作区」与「当前绑定工作区」
 *    显式比对，不一致就立刻回到 loading 并禁止展示旧数据。
 * 2. **四态不可区分**：以前「没扫描过 / 正在扫描 / 扫描失败 / 确实没事」
 *    都渲染成同一句「暂无未收束的事」，用户无法判断该等、该重试还是该安心。
 *
 * @param {object} input - `{ boundWorkspaceId, dataWorkspaceId, raw, error, scanning, refining }`。
 * @returns {{
 *   status: 'loading'|'ready'|'error',
 *   showStale: boolean,
 *   emptyKind: ''|'unscanned'|'scanning'|'failed'|'empty',
 *   unresolvedCount: number,
 * }} 渲染状态。
 */
export function resolveWorksViewState(input) {
  const src = isPlainObject(input) ? input : {}
  const bound = typeof src.boundWorkspaceId === 'string' ? src.boundWorkspaceId.trim() : ''
  const dataWs = typeof src.dataWorkspaceId === 'string' ? src.dataWorkspaceId.trim() : ''
  const raw = isPlainObject(src.raw) ? src.raw : null
  const errorText = typeof src.error === 'string' ? src.error.trim() : ''
  const scanning = src.scanning === true
  const refining = src.refining === true

  // 切区瞬间：数据属于别的工作区 → 立刻清态，绝不展示旧数据。
  // 只有两边都非空且确实不同才算「串台」；未知（空串）时按当前数据继续，避免闪屏。
  const switching = bound !== '' && dataWs !== '' && bound !== dataWs
  if (switching) {
    return { status: 'loading', showStale: false, emptyKind: '', unresolvedCount: 0 }
  }

  if (errorText !== '') {
    return { status: 'error', showStale: false, emptyKind: 'failed', unresolvedCount: 0 }
  }

  if (raw === null) {
    return {
      status: 'loading',
      showStale: false,
      emptyKind: scanning || refining ? 'scanning' : 'unscanned',
      unresolvedCount: 0,
    }
  }

  const cards = isPlainObject(raw.cards) ? raw.cards : {}
  const unresolved = Array.isArray(cards.unresolved)
    ? cards.unresolved
    : (Array.isArray(raw.unresolved) ? raw.unresolved : [])
  const unresolvedCount = unresolved.length

  // 已经拿过结果：先看是否正在扫描，再看是否真的无事。
  if (scanning || refining) {
    return { status: 'ready', showStale: false, emptyKind: 'scanning', unresolvedCount }
  }
  if (raw.initialized === false) {
    return { status: 'ready', showStale: false, emptyKind: 'unscanned', unresolvedCount }
  }
  if (unresolvedCount === 0) {
    // 会话是壳，对话是瓤（ADR-0012）：这个工作区可能一个可读对话都没有。
    // 那时说「没有未收束的事」是在撒谎——用户会以为自己漏了什么，然后反复重扫，
    // 而重扫永远不会有用，因为源头就是空的。
    const conversations = typeof raw.conversationCount === 'number' ? raw.conversationCount : null
    const empties = typeof raw.emptySessionCount === 'number' ? raw.emptySessionCount : 0
    if (conversations === 0 && empties > 0) {
      return { status: 'ready', showStale: false, emptyKind: 'no_content', unresolvedCount, emptySessionCount: empties }
    }
    return { status: 'ready', showStale: false, emptyKind: 'empty', unresolvedCount }
  }
  return { status: 'ready', showStale: false, emptyKind: '', unresolvedCount }
}

/**
 * 四种空态的文案（纯函数）。
 *
 * 关键要求：四句话**必须互不相同**，用户据此判断该等待、该重试还是可以放心。
 *
 * @param {string} emptyKind - `resolveWorksViewState` 给出的 `emptyKind`。
 * @param {object} [params] - `{ refineReason, workspaceName }`。
 * @returns {{ title: string, hint: string, retry: boolean }} 文案与是否显示重试。
 */
export function emptyStateText(emptyKind, params = {}) {
  const p = isPlainObject(params) ? params : {}
  const wsName = typeof p.workspaceName === 'string' && p.workspaceName.trim() !== ''
    ? p.workspaceName.trim()
    : '当前工作区'

  if (emptyKind === 'unscanned') {
    return {
      title: wsName + ' 还没有盘点过',
      hint: '点「扫描」开始盘点这个工作区已有的事，盘点结果会一直保留。',
      retry: false,
    }
  }
  if (emptyKind === 'scanning') {
    return {
      title: '正在盘点 ' + wsName + '…',
      hint: '先给你看硬信号结果，语义提炼在后台继续；完成后会自动刷新。',
      retry: false,
    }
  }
  if (emptyKind === 'no_content') {
    const empties = Number.isFinite(Number(p.emptySessionCount)) ? Math.max(0, Math.floor(Number(p.emptySessionCount))) : 0
    const countText = empties > 0 ? empties + ' 个会话' : '这些会话'
    return {
      title: wsName + ' 没有可读的对话',
      // 必须与「确实无事」明确区别：这里不是「你做完了」，是「没有东西可读」。
      hint: countText + '都没有任何轮次（0 轮），所以既切不出段、也没有可续接的事。'
        + '这不是提取失败，重扫也不会变出内容。',
      retry: false,
    }
  }
  if (emptyKind === 'failed') {
    return {
      title: '盘点失败',
      hint: '读取这个工作区的事时出错了，可以重试；已经存下的结果不会丢。',
      retry: true,
    }
  }
  return {
    title: '这个工作区没有未收束的事',
    hint: '盘点过 ' + wsName + '，当前确实没有需要接手的事；做完的已折叠到下方。',
    retry: false,
  }
}