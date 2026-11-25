/**
 * 工作区统计聚合纯模型（`/stats` 端点）。
 *
 * 产品口径：
 * - **活跃度为主**：`activeDays` 按本地自然日去重；`topSessions` 先按轮数、
 *   同轮数按最后活动时间倒序。
 * - **用量为辅**：只汇总索引里已有的 `usage.input` / `usage.output` 与总数。
 * - 会话只统计"有轮次"的（0 轮会话在列表里本来就被隐藏，避免虚高）。
 *
 * 纯函数：不读时钟、不读文件、不认 ctx；输入只读，返回新对象。
 *
 * @module dsh-topic-map/workspace-stats
 */

/** 非负有限数；缺失/非法/负数一律 0。 */
function toNonNegative(value) {
  if (value === null || value === undefined || value === '') return 0
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return 0
  return number
}

/**
 * 本地自然日键 `YYYY-MM-DD`。
 *
 * 用本地时区（不是 UTC）：用户看到的"今天"就是本地今天。非法时间返回
 * 空串，调用方不应把它计入去重集合。
 *
 * @param ms - epoch ms。
 * @returns 日期键或空串。
 */
export function localDayKey(ms) {
  const time = Number(ms)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 一轮的活动时间点：turn/start 与 turn/end 都算（有就记）。 */
function activityTimesOf(row) {
  const times = []
  if (Number.isFinite(row?.start)) times.push(row.start)
  if (Number.isFinite(row?.end)) times.push(row.end)
  return times
}

/**
 * 聚合工作区统计。
 *
 * @param sessions - `[{sessionId, title, rows, lastActive?}]`；rows 是轮次行。
 * @returns `{sessions, turns, activeDays, topSessions, usage}`。
 */
export function aggregateWorkspaceStats(sessions) {
  const list = Array.isArray(sessions) ? sessions : []
  const days = new Set()
  const topSessions = []
  let sessionCount = 0
  let turns = 0
  let input = 0
  let output = 0

  for (const session of list) {
    if (session === null || typeof session !== 'object') continue
    const rows = Array.isArray(session.rows) ? session.rows : []
    if (rows.length === 0) continue
    sessionCount += 1

    let lastActive = null
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      turns += 1
      for (const time of activityTimesOf(row)) {
        const key = localDayKey(time)
        if (key !== '') days.add(key)
        if (lastActive === null || time > lastActive) lastActive = time
      }
      input += toNonNegative(row.usage?.input)
      output += toNonNegative(row.usage?.output)
    }

    // 会话列表里的最后活动时间只作补充（索引行缺失时间时仍能算活跃日）。
    if (Number.isFinite(session.lastActive)) {
      const key = localDayKey(session.lastActive)
      if (key !== '') days.add(key)
      if (lastActive === null || session.lastActive > lastActive) lastActive = session.lastActive
    }

    topSessions.push({
      sessionId: String(session.sessionId ?? ''),
      title: typeof session.title === 'string' && session.title !== '' ? session.title : String(session.sessionId ?? ''),
      turns: rows.length,
      lastActive,
    })
  }

  topSessions.sort((left, right) => {
    if (right.turns !== left.turns) return right.turns - left.turns
    const leftTime = left.lastActive === null ? -Infinity : left.lastActive
    const rightTime = right.lastActive === null ? -Infinity : right.lastActive
    if (rightTime !== leftTime) return rightTime - leftTime
    return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
  })

  return {
    sessions: sessionCount,
    turns,
    activeDays: days.size,
    topSessions: topSessions.slice(0, 5),
    usage: { input, output, total: input + output },
  }
}
