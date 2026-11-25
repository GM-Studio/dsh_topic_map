/**
 * Markdown 简报的纯渲染与端点编排（落盘 I/O 走注入依赖）。
 *
 * 产品要求（历史管理）：
 * - 落盘到 `~/.dsh/topic-map/briefs/<时间戳>-<slug>.md`；
 * - 范围说明 + 按轮次的时间线：时间 / 提问摘要 / 结论摘要 / 代码块数 /
 *   变更文件数；结论摘要与 `/turn-digest` 同源（由注入的 digestOf 保证）；
 * - 末尾附"相关命令"清单；
 * - 总量上限 200KB，超了写截断说明。
 *
 * 纯函数部分不读时钟、不写盘；`createBriefEndpoint` 只编排注入的
 * `resolveScope / digestOf / writeBrief`，方便单测。
 *
 * @module dsh-topic-map/brief
 */

import { codeBlocksOf } from './code-blocks.js'
import { outlinePromptHead } from './outline.js'

/** 简报总量上限（200KB）。 */
export const BRIEF_MAX_BYTES = 200 * 1024

/** 相关命令最多列多少条。 */
export const BRIEF_MAX_COMMANDS = 100

/** 单条命令展示上限（字符）。 */
const COMMAND_TEXT_MAX = 180

/** 每轮提问摘要字数。 */
const PROMPT_HEAD_MAX = 80

/** 每轮原文摘录字数（摘要不可用时）。 */
const EXCERPT_MAX = 120

/** 标题上限。 */
const TITLE_MAX = 120

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 单行压缩 + 码点截断；超长补省略号。 */
function clipLine(text, max) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized === '') return ''
  const points = Array.from(normalized)
  if (points.length <= max) return normalized
  return `${points.slice(0, max).join('')}…`
}

/** 本地时间 `YYYY-MM-DD HH:mm`；非法时间返回空串。 */
export function formatBriefTime(ms) {
  const time = Number(ms)
  if (!Number.isFinite(time)) return ''
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return ''
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 本地时间戳 `YYYYMMDD-HHmmss`，用于文件名。 */
export function briefTimestamp(ms) {
  const date = new Date(Number(ms))
  if (Number.isNaN(date.getTime())) return '00000000-000000'
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-`
    + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/**
 * 标题 → 安全文件名 slug。
 *
 * 保留中英文与数字（文件名可读），其余字符折叠成 `-`；去掉首尾点和
 * 连字符，封顶 40 个码点，避免超过 Windows 路径长度。
 *
 * @param title - 标题。
 * @param fallback - 标题为空时的兜底文本。
 * @returns 非空 slug。
 */
export function briefSlug(title, fallback = 'brief') {
  const raw = String(title ?? '').trim() === '' ? String(fallback ?? '') : String(title)
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.\-]+|[.\-]+$/g, '')
  const points = Array.from(cleaned).slice(0, 40).join('')
  return points === '' ? 'brief' : points
}

/**
 * 简报文件名：`<时间戳>-<slug>.md`。
 *
 * @param atMs - 生成时间（epoch ms）。
 * @param slug - 安全 slug。
 * @returns 文件名（不含目录）。
 */
export function briefFileName(atMs, slug) {
  const safe = briefSlug(slug, 'brief')
  return `${briefTimestamp(atMs)}-${safe}.md`
}

/**
 * 校验并归一 `/brief` 请求参数。
 *
 * `turns` 只接受轮次号数组（显式选择）；`from` / `to` 是闭区间。两者
 * 同时给时取交集。`sessionId` 与 `workspaceId` 只能给一个，避免"到底
 * 按哪个范围生成"的歧义。
 *
 * @param body - 请求体。
 * @returns `{ok:true, selection}` 或 `{ok:false, error, httpStatus}`。
 */
export function normalizeBriefSelection(body) {
  const request = isPlainObject(body) ? body : {}
  if (request.sessionId !== undefined && request.sessionId !== null && typeof request.sessionId !== 'string') {
    return { ok: false, error: 'sessionId 必须是字符串', httpStatus: 400 }
  }
  if (request.workspaceId !== undefined && request.workspaceId !== null && typeof request.workspaceId !== 'string') {
    return { ok: false, error: 'workspaceId 必须是字符串', httpStatus: 400 }
  }
  const sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
  const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
  if (sessionId !== '' && workspaceId !== '') {
    return { ok: false, error: 'sessionId 与 workspaceId 只能给一个', httpStatus: 400 }
  }

  const numberOrNull = (value, field) => {
    if (value === undefined || value === null || value === '') return { ok: true, value: null }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return { ok: false, error: `${field} 必须是非负整数`, httpStatus: 400 }
    }
    return { ok: true, value }
  }
  const from = numberOrNull(request.from, 'from')
  if (!from.ok) return from
  const to = numberOrNull(request.to, 'to')
  if (!to.ok) return to
  if (from.value !== null && to.value !== null && from.value > to.value) {
    return { ok: false, error: 'from 不能大于 to', httpStatus: 400 }
  }

  let turns = null
  if (request.turns !== undefined && request.turns !== null) {
    if (!Array.isArray(request.turns)) {
      return { ok: false, error: 'turns 必须是轮次号数组', httpStatus: 400 }
    }
    const picked = []
    for (const value of request.turns) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return { ok: false, error: 'turns 必须是轮次号数组', httpStatus: 400 }
      }
      if (!picked.includes(value)) picked.push(value)
    }
    turns = picked
  }

  const title = typeof request.title === 'string' ? request.title.trim() : ''
  if (request.title !== undefined && request.title !== null && typeof request.title !== 'string') {
    return { ok: false, error: 'title 必须是字符串', httpStatus: 400 }
  }

  return {
    ok: true,
    selection: { sessionId, workspaceId, from: from.value, to: to.value, turns, title },
  }
}

/** 轮次是否落在选择范围内。 */
export function rowMatchesSelection(row, selection) {
  if (row === null || typeof row !== 'object' || !Number.isInteger(row.turn)) return false
  const turns = selection?.turns
  if (Array.isArray(turns) && !turns.includes(row.turn)) return false
  if (Number.isInteger(selection?.from) && row.turn < selection.from) return false
  if (Number.isInteger(selection?.to) && row.turn > selection.to) return false
  return true
}

/**
 * 轮次行的活动时间：turn/end 优先，其次 turn/start；没有就是 null。
 *
 * @param row - 轮次行。
 * @returns epoch ms 或 null。
 */
export function briefRowTime(row) {
  if (Number.isFinite(row?.end)) return row.end
  if (Number.isFinite(row?.start)) return row.start
  return null
}

/**
 * 变更文件数。
 *
 * `changes.lost:true` 表示宿主明细已不可读，不能显示成"0 个文件"；
 * 返回 `{count, lost}` 让渲染层写"不可读"。
 *
 * @param row - 轮次行。
 * @returns `{count, lost}`。
 */
export function changedFilesOf(row) {
  const changes = row?.changes
  if (!changes || typeof changes !== 'object') return { count: 0, lost: false }
  if (changes.lost === true) return { count: 0, lost: true }
  if (Number.isFinite(changes.total) && changes.total >= 0) {
    return { count: Math.trunc(changes.total), lost: false }
  }
  if (Array.isArray(changes.files)) return { count: changes.files.length, lost: false }
  return { count: 0, lost: false }
}

/** 一条回答里的 markdown 围栏代码块数；解析失败记 0。 */
export function codeBlockCountOf(text) {
  try {
    return codeBlocksOf(text).length
  } catch {
    return 0
  }
}

/** 选择范围的可读说明。 */
export function describeSelection(selection, totalTurns) {
  const parts = []
  if (Array.isArray(selection?.turns)) {
    const shown = [...selection.turns].sort((a, b) => a - b).slice(0, 20)
    const suffix = selection.turns.length > shown.length ? ' 等' : ''
    parts.push(`指定轮次 ${shown.join('、')}${suffix}`)
  }
  if (Number.isInteger(selection?.from) || Number.isInteger(selection?.to)) {
    const from = Number.isInteger(selection?.from) ? selection.from : 0
    const to = Number.isInteger(selection?.to) ? selection.to : '末轮'
    parts.push(`第 ${from}–${to} 轮`)
  }
  if (parts.length === 0) return `全部轮次（共 ${totalTurns} 轮）`
  return parts.join('；')
}

/** 从轮次行收集相关命令（tool/call 实际执行过的命令）。 */
export function collectBriefCommands(entries, limit = BRIEF_MAX_COMMANDS) {
  const commands = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const row = entry?.row
    for (const command of Array.isArray(row?.commands) ? row.commands : []) {
      if (typeof command !== 'string') continue
      const text = command.replace(/\s+/g, ' ').trim()
      if (text === '') continue
      const clipped = Array.from(text).slice(0, COMMAND_TEXT_MAX).join('')
      if (!commands.includes(clipped)) commands.push(clipped)
      if (commands.length >= limit) return commands
    }
  }
  return commands
}

/** 单轮时间线块。 */
function renderEntry(entry, options) {
  const time = entry.time === null ? '时间未知' : formatBriefTime(entry.time)
  const lines = [`### 第 ${entry.turn} 轮 · ${time}`]
  if (options.multipleSessions === true) {
    lines.push(`- 会话：${entry.sessionTitle}（${entry.sessionId}）`)
  }
  lines.push(`- 提问：${entry.promptHead === '' ? '（空）' : entry.promptHead}`)
  const digest = entry.digest === '' ? '（无）' : entry.digest
  lines.push(`- 结论：${digest}`)
  const changed = entry.changesLost
    ? '变更文件：不可读'
    : `变更文件：${entry.changedFiles}`
  lines.push(`- 代码块：${entry.codeBlocks} · ${changed}`)
  return `${lines.join('\n')}\n`
}

/** 命令区文本。 */
function renderCommands(commands) {
  if (commands.length === 0) return '## 相关命令\n\n（无）\n'
  const lines = commands.map((command, index) => `${index + 1}. \`${command}\``)
  return `## 相关命令\n\n${lines.join('\n')}\n`
}

/** UTF-8 字节数。 */
function byteLength(text) {
  return Buffer.byteLength(String(text), 'utf8')
}

/** 按字节上限硬截断（只在极端小上限下兜底用）。 */
function clipToBytes(text, maxBytes) {
  if (byteLength(text) <= maxBytes) return text
  let points = Array.from(text)
  while (points.length > 0 && byteLength(points.join('')) > maxBytes) {
    points = points.slice(0, Math.max(0, points.length - Math.max(1, Math.ceil(points.length / 10))))
  }
  return points.join('')
}

/** 截断说明。 */
function truncationNote(omitted, maxBytes = BRIEF_MAX_BYTES) {
  return `> 已截断：受 ${Math.floor(maxBytes / 1024)}KB 上限限制，剩余 ${omitted} 轮未写入。\n`
}

/**
 * 渲染简报 Markdown。
 *
 * @param document - `{title, generatedAt, scopeLabel, selectionText, totalTurns, multipleSessions, entries, commands}`；
 *   entries 需已排序，元素 `{sessionId, sessionTitle, turn, time, promptHead, digest, codeBlocks, changedFiles, changesLost}`。
 * @param options - `{maxBytes?}`。
 * @returns `{markdown, turns, truncated, omittedTurns, bytes}`。
 */
export function renderBriefMarkdown(document, options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
    ? Math.floor(opts.maxBytes)
    : BRIEF_MAX_BYTES
  const entries = Array.isArray(document?.entries) ? document.entries : []
  const commands = Array.isArray(document?.commands) ? document.commands : []
  const generatedAt = Number.isFinite(document?.generatedAt) ? document.generatedAt : null
  const title = String(document?.title ?? '').trim() || '话题地图简报'

  const header = [
    `# ${title}`,
    '',
    `- 生成时间：${generatedAt === null ? '未知' : formatBriefTime(generatedAt)}`,
    `- 范围：${String(document?.scopeLabel ?? '')}`,
    `- 筛选：${String(document?.selectionText ?? '')}`,
    `- 轮次数：${entries.length}`,
    '',
    '## 时间线',
    '',
  ].join('\n')

  // 命令区先定型：它是"末尾清单"，必须给内容轮次让出空间，但不能被
  // 轮次挤没。若命令区本身已超上限，再逐条删。
  let commandList = commands.slice()
  let commandsText = renderCommands(commandList)
  let commandsTruncated = false
  while (byteLength(commandsText) > Math.max(64, Math.floor(maxBytes / 3)) && commandList.length > 0) {
    commandList = commandList.slice(0, commandList.length - 1)
    commandsTruncated = true
    commandsText = `${renderCommands(commandList).trimEnd()}\n（命令清单已截断）\n`
  }

  const multipleSessions = document?.multipleSessions === true
  const blocks = []
  let blocksBytes = 0
  let included = 0
  // 预留截断说明 + 命令区；说明按总轮数估一个最坏长度（+1 是前面补的空行）。
  const noteWorst = byteLength(truncationNote(entries.length, maxBytes)) + 1
  const budget = maxBytes - byteLength(header) - byteLength(commandsText) - noteWorst
  for (const entry of entries) {
    const block = renderEntry(entry, { multipleSessions })
    const blockBytes = byteLength(block)
    if (blocksBytes + blockBytes > budget) break
    blocks.push(block)
    blocksBytes += blockBytes
    included += 1
  }

  const omitted = entries.length - included
  const note = omitted > 0 ? `\n${truncationNote(omitted, maxBytes)}` : ''
  let markdown = `${header}\n${blocks.join('')}${note}${commandsText}`
  if (commandsTruncated && !markdown.includes('命令清单已截断')) {
    markdown += '（命令清单已截断）\n'
  }

  // 极端情况下（maxBytes 比头部还小）硬截断，保证"总量不超限"。
  if (byteLength(markdown) > maxBytes) {
    markdown = clipToBytes(markdown, maxBytes)
    if (!markdown.endsWith('\n') && byteLength(markdown) + 1 <= maxBytes) markdown += '\n'
  }

  return {
    markdown,
    turns: included,
    truncated: omitted > 0 || commandsTruncated,
    omittedTurns: omitted,
    bytes: byteLength(markdown),
  }
}

/**
 * 组装 `/brief` 端点。
 *
 * @param deps - 注入依赖。
 * @param deps.resolveScope - `(selection) => Promise<{ok:true, scope}|{ok:false,...}>`；
 *   scope = `{sessions:[{sessionId,title,rows}], scopeLabel, defaultTitle}`。
 * @param deps.digestOf - `({sessionId, turn, row}) => Promise<{ok, summary}|{ok:false,error}>`。
 * @param deps.writeBrief - `({slug, markdown, atMs}) => Promise<{ok:true, path, bytes}|{ok:false,error,httpStatus}>`。
 * @param deps.now - `() => number`。
 * @param deps.maxBytes - 可选覆盖 200KB（测试用）。
 * @param deps.digestBudgetMs - 摘要总预算，默认 60s。
 * @param deps.digestMaxTurns - 最多调用多少次摘要，默认 40。
 * @returns `(body) => Promise<{ok:true, value:{path, bytes, turns}}|{ok:false,...}>`。
 */
export function createBriefEndpoint(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const maxBytes = Number.isFinite(deps.maxBytes) && deps.maxBytes > 0
    ? Math.floor(deps.maxBytes)
    : BRIEF_MAX_BYTES
  const digestBudgetMs = Number.isFinite(deps.digestBudgetMs) && deps.digestBudgetMs >= 0
    ? deps.digestBudgetMs
    : 60_000
  const digestMaxTurns = Number.isFinite(deps.digestMaxTurns) && deps.digestMaxTurns >= 0
    ? Math.floor(deps.digestMaxTurns)
    : 40

  return async function generateBrief(body = {}) {
    const normalized = normalizeBriefSelection(body)
    if (!normalized.ok) return normalized
    const { selection } = normalized

    let scope
    try {
      scope = await deps.resolveScope(selection)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `读不到简报范围：${message.slice(0, 200)}`, httpStatus: 502 }
    }
    if (!scope || scope.ok !== true) return scope ?? { ok: false, error: '读不到简报范围', httpStatus: 502 }

    // resolveScope 统一返回 `{ok:true, scope:{sessions, scopeLabel, defaultTitle}}`。
    const resolved = scope.scope ?? scope
    const sessions = Array.isArray(resolved.sessions) ? resolved.sessions : []
    const rows = []
    for (const session of sessions) {
      for (const row of Array.isArray(session.rows) ? session.rows : []) {
        if (!rowMatchesSelection(row, selection)) continue
        rows.push({ sessionId: session.sessionId, sessionTitle: session.title, row })
      }
    }
    if (rows.length === 0) {
      return { ok: false, error: '没有可写入简报的轮次', httpStatus: 404 }
    }

    rows.sort((left, right) => {
      const leftTime = briefRowTime(left.row)
      const rightTime = briefRowTime(right.row)
      if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime
      if (leftTime === null && rightTime !== null) return 1
      if (leftTime !== null && rightTime === null) return -1
      if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1
      return left.row.turn - right.row.turn
    })

    const started = now()
    let digestCalls = 0
    const entries = []
    const commandRows = []
    for (const item of rows) {
      const row = item.row
      const allowed = digestCalls < digestMaxTurns && now() - started <= digestBudgetMs
      let digest = ''
      let digestSource = 'excerpt'
      if (allowed && typeof deps.digestOf === 'function') {
        digestCalls += 1
        try {
          const summary = await deps.digestOf({ sessionId: item.sessionId, turn: row.turn, row })
          if (summary?.ok === true && typeof summary.summary === 'string' && summary.summary.trim() !== '') {
            digest = clipLine(summary.summary, 200)
            digestSource = 'digest'
          }
        } catch {
          // 摘要失败退回原文摘录。
        }
      }
      if (digestSource !== 'digest') {
        const excerpt = clipLine(row.response, EXCERPT_MAX)
        digest = excerpt === '' ? '（摘要不可用，且暂无回答原文）' : `（摘要不可用，原文摘录）${excerpt}`
      }
      const changed = changedFilesOf(row)
      commandRows.push({ row })
      entries.push({
        sessionId: item.sessionId,
        sessionTitle: item.sessionTitle,
        turn: row.turn,
        time: briefRowTime(row),
        promptHead: outlinePromptHead(row.prompt, PROMPT_HEAD_MAX) || '（空）',
        digest,
        codeBlocks: codeBlockCountOf(row.response),
        changedFiles: changed.count,
        changesLost: changed.lost,
      })
    }

    const commands = collectBriefCommands(commandRows)
    const defaultTitle = String(resolved.defaultTitle ?? '').trim() || '话题地图简报'
    const title = selection.title === '' ? defaultTitle : Array.from(selection.title).slice(0, TITLE_MAX).join('')
    const selectionText = describeSelection(selection, rows.length)
    const rendered = renderBriefMarkdown({
      title,
      generatedAt: now(),
      scopeLabel: String(resolved.scopeLabel ?? ''),
      selectionText,
      totalTurns: rows.length,
      multipleSessions: sessions.filter(session => (session.rows ?? []).length > 0).length > 1,
      entries,
      commands,
    }, { maxBytes })

    let written
    try {
      written = await deps.writeBrief({
        slug: briefSlug(title, selection.sessionId || selection.workspaceId || 'brief'),
        markdown: rendered.markdown,
        atMs: now(),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: `写入简报失败：${message.slice(0, 200)}`, httpStatus: 502 }
    }
    if (!written || written.ok !== true) {
      return written ?? { ok: false, error: '写入简报失败：宿主未返回路径', httpStatus: 502 }
    }
    return { ok: true, value: { path: written.path, bytes: rendered.bytes, turns: rendered.turns } }
  }
}
