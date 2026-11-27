#!/usr/bin/env node
/**
 * 只读干跑诊断脚本（ADR-0003 强制验证要求）。
 *
 * 直接只读扫描 `~/.dsh/topic-map/index/sessions/*.jsonl`（或 `--index-dir` 指定目录），
 * 串起整条「轮次索引 → 切段 → 冷启动硬信号聚类 → 沉降与续接投影 → 硬事实与 Wire 交接上下文」流水线，
 * 仅输出**脱敏统计报告**与异常样本类型分布，严禁修改任何真实数据，严禁输出完整会话正文、敏感路径或密钥。
 *
 * 用法：
 *   node scripts/dry-run-works.mjs
 *   node scripts/dry-run-works.mjs --max-sessions 50 --dormant-days 14
 *   node scripts/dry-run-works.mjs --index-dir <path> --workspace <workspaceId>
 *   node scripts/dry-run-works.mjs --json
 */

import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { defaultSessionsDir, parseIndexText } from '../lib/turn-index.js'
import { isAutomatedSession, sliceSessionSegments } from '../lib/segment.js'
import {
  DEFAULT_DORMANT_DAYS,
  applyDormancySettlement,
  emptyWorkStore,
  projectResumeCards,
} from '../lib/work-model.js'
import {
  GENERIC_CONFIG_FILES,
  planColdStartWorks,
} from '../lib/work-merge.js'
import {
  extractWorkHardFacts,
  renderWorkContextForAgent,
} from '../lib/handoff.js'

const DAY_MS = 24 * 60 * 60 * 1000

// ── CLI 解析 ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    indexDir: '',
    workspace: '',
    maxSessions: 0,
    dormantDays: DEFAULT_DORMANT_DAYS,
    nowMs: Date.now(),
    json: false,
    help: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--help' || token === '-h') {
      args.help = true
    } else if (token === '--json') {
      args.json = true
    } else if (token === '--index-dir' || token === '--dir') {
      args.indexDir = String(argv[++i] ?? '').trim()
    } else if (token.startsWith('--index-dir=')) {
      args.indexDir = token.slice('--index-dir='.length).trim()
    } else if (token === '--workspace' || token === '-w') {
      args.workspace = String(argv[++i] ?? '').trim()
    } else if (token.startsWith('--workspace=')) {
      args.workspace = token.slice('--workspace='.length).trim()
    } else if (token === '--max-sessions') {
      args.maxSessions = parsePositiveInt(argv[++i], 0)
    } else if (token.startsWith('--max-sessions=')) {
      args.maxSessions = parsePositiveInt(token.slice('--max-sessions='.length), 0)
    } else if (token === '--dormant-days') {
      args.dormantDays = parseNonNegativeNumber(argv[++i], DEFAULT_DORMANT_DAYS)
    } else if (token.startsWith('--dormant-days=')) {
      args.dormantDays = parseNonNegativeNumber(token.slice('--dormant-days='.length), DEFAULT_DORMANT_DAYS)
    } else if (token === '--now') {
      const parsed = Number(argv[++i])
      if (Number.isFinite(parsed) && parsed > 0) args.nowMs = parsed
    }
  }
  return args
}

function parsePositiveInt(raw, fallback) {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function parseNonNegativeNumber(raw, fallback) {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function printUsage() {
  console.log([
    '只读干跑诊断脚本（ADR-0003）',
    '',
    '用法：',
    '  node scripts/dry-run-works.mjs [选项]',
    '',
    '选项：',
    '  --index-dir <path>    指定会话索引 JSONL 目录（默认 ~/.dsh/topic-map/index/sessions）',
    '  --workspace <id>      可选：按 ~/.dsh/topic-map/categories/<id>.json 过滤到单个工作区',
    '  --max-sessions <N>    最多抽检 N 个会话（按最近活跃时间倒序优先）',
    '  --dormant-days <D>    自动沉降天数阈值（默认 14；0 表示不沉降）',
    '  --json                以脱敏 JSON 格式输出报告',
    '  -h, --help            显示帮助',
  ].join('\n'))
}

// ── 脱敏工具（严守隐私红线：绝不泄漏正文/绝对路径/密钥） ────────────

function anonSessionTag(sessionId) {
  const cleaned = String(sessionId ?? '')
    .replace(/^session[-_:]/i, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
  return cleaned.slice(0, 8) || 'unknown'
}

/**
 * 将路径脱敏为“仅文件名或扩展名类别”，绝不暴露用户目录、项目绝对路径或敏感路径片段。
 */
function sanitizePathBasename(rawPath) {
  const norm = String(rawPath ?? '').trim().replace(/\\/g, '/')
  if (norm === '') return ''
  const parts = norm.split('/').filter(Boolean)
  const base = parts[parts.length - 1] ?? ''
  if (base === '') return ''
  // 若文件名本身含疑似 token/key/secret/密码字样，只保留扩展名
  if (/(secret|token|key|password|passwd|credential|cookie|auth|private|id_rsa|\.env)/i.test(base)) {
    const dot = base.lastIndexOf('.')
    return dot > 0 ? `<redacted>${base.slice(dot).toLowerCase()}` : '<redacted>'
  }
  return base.toLowerCase()
}

function pct(part, total) {
  if (!total) return '0.0%'
  return `${((part / total) * 100).toFixed(1)}%`
}

function percentile(sortedNums, p) {
  if (sortedNums.length === 0) return 0
  const idx = Math.min(sortedNums.length - 1, Math.max(0, Math.ceil((p / 100) * sortedNums.length) - 1))
  return sortedNums[idx]
}

function summarizeNumbers(nums) {
  if (nums.length === 0) {
    return { count: 0, min: 0, p50: 0, p90: 0, p95: 0, max: 0, avg: 0 }
  }
  const sorted = [...nums].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  return {
    count: sorted.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    avg: Number((sum / sorted.length).toFixed(2)),
  }
}

function bucketCount(nums, buckets) {
  const counts = Object.fromEntries(buckets.map(b => [b.label, 0]))
  for (const n of nums) {
    for (const b of buckets) {
      if (n >= b.min && n <= b.max) {
        counts[b.label] += 1
        break
      }
    }
  }
  return counts
}

function topEntries(freqMap, limit = 12) {
  return [...freqMap.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }))
}

// ── 只读加载工作区映射（如存在 categories 缓存） ─────────────────────

async function loadWorkspaceSessionMap(indexDir) {
  // indexDir 通常为 <dshHome>/topic-map/index/sessions
  const topicMapDir = resolve(indexDir, '..', '..')
  const catDir = join(topicMapDir, 'categories')
  const sessionToWorkspace = new Map()
  const workspaceSessions = new Map()

  let entries = []
  try {
    entries = await readdir(catDir)
  } catch {
    return { sessionToWorkspace, workspaceSessions }
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const wsId = name.slice(0, -'.json'.length)
    try {
      const raw = await readFile(join(catDir, name), 'utf8')
      const parsed = JSON.parse(raw)
      const assignments = parsed?.assignments && typeof parsed.assignments === 'object'
        ? Object.keys(parsed.assignments)
        : []
      if (assignments.length === 0) continue
      const set = new Set(assignments)
      workspaceSessions.set(wsId, set)
      for (const sid of assignments) {
        if (!sessionToWorkspace.has(sid)) sessionToWorkspace.set(sid, wsId)
      }
    } catch {
      // 只读跳过损坏的缓存文件
    }
  }
  return { sessionToWorkspace, workspaceSessions }
}

// ── 辅助诊断：疑似漏网子代理/自动化特征分类（不输出正文） ─────────

function detectSuspectedSubagentSignals(turns) {
  const firstPrompt = String(turns[0]?.prompt ?? '').trim()
  const reasons = []
  if (/^你是.+?(工程师|代理|助手|专家|reviewer|subagent|worker)/i.test(firstPrompt)) {
    reasons.push('role-prompt-zh')
  }
  if (/^you are (a|an|the) .*(subagent|worker|engineer|reviewer|assistant)/i.test(firstPrompt)) {
    reasons.push('role-prompt-en')
  }
  if (/^\[(task|worker|review|audit|subagent|auto|cron)/i.test(firstPrompt)) {
    reasons.push('bracket-prefix')
  }
  if (firstPrompt.includes('Your final answer is delivered automatically') || firstPrompt.includes('delegated')) {
    reasons.push('delegation-cue')
  }
  if (turns.length === 1 && firstPrompt.length >= 600) {
    reasons.push('single-turn-long-prompt')
  }
  if (turns.every(t => String(t.prompt ?? '').trim() === '')) {
    reasons.push('all-empty-prompts')
  }
  return reasons
}

// ── 把 sliceSessionSegments 输出适配到 planColdStartWorks 字段口径 ──

function inspectFieldAlignment(seg) {
  // 检查 segment.js 输出与 work-merge.js 消费的字段名差异（如 endTime vs endedAt/lastActivityAt、quoteHandles vs referencedHandles 等）
  return {
    hasStartEndTime: Number.isFinite(seg.startTime) || Number.isFinite(seg.endTime),
    hasStartedEndedAt: Number.isFinite(seg.startedAt) || Number.isFinite(seg.endedAt) || Number.isFinite(seg.lastActivityAt),
    hasQuoteHandles: Array.isArray(seg.quoteHandles) && seg.quoteHandles.length > 0,
    hasReferencedHandles: Array.isArray(seg.referencedHandles) && seg.referencedHandles.length > 0,
    hasErrorTurns: Array.isArray(seg.errorTurns) && seg.errorTurns.length > 0,
    hasHasError: seg.hasError === true,
    hasStartEndTurn: Number.isInteger(seg.startTurn) && Number.isInteger(seg.endTurn),
    hasTurnRange: Array.isArray(seg.turnRange) && seg.turnRange.length >= 2,
  }
}

function adaptSegmentForMerge(seg, turnsInSeg, workspaceId) {
  const lastTurn = turnsInSeg[turnsInSeg.length - 1] ?? null
  return {
    ...seg,
    workspaceId,
    startedAt: seg.startTime,
    endedAt: seg.endTime,
    lastActivityAt: seg.endTime ?? seg.startTime ?? 0,
    turnRange: [seg.startTurn, seg.endTurn],
    referencedHandles: seg.quoteHandles,
    hasError: Array.isArray(seg.errorTurns) && seg.errorTurns.length > 0,
    endReason: lastTurn?.endReason ?? 'completed',
    evidenceHandles: turnsInSeg.length > 0
      ? [
          `〔${anonSessionTag(seg.sessionId)}#${seg.startTurn}〕`,
          `〔${anonSessionTag(seg.sessionId)}#${seg.endTurn}〕`,
        ]
      : [],
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────

async function run() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  const indexDir = args.indexDir !== '' ? resolve(args.indexDir) : defaultSessionsDir()
  if (indexDir === '') {
    console.error('无法解析默认索引目录（DSH_HOME / USERPROFILE / HOME 均为空），请通过 --index-dir 指定。')
    process.exitCode = 1
    return
  }

  let dirEntries
  try {
    dirEntries = await readdir(indexDir)
  } catch (err) {
    console.error(`读取索引目录失败（${err?.code ?? 'ERR'}）：请检查目录是否存在。`)
    process.exitCode = 1
    return
  }

  const { sessionToWorkspace, workspaceSessions } = await loadWorkspaceSessionMap(indexDir)

  let jsonlFiles = dirEntries.filter(f => f.endsWith('.jsonl')).sort()
  if (args.workspace !== '') {
    const allowed = workspaceSessions.get(args.workspace)
    if (!allowed) {
      console.error(`未在 categories 缓存中找到工作区 ${args.workspace.slice(0, 8)}… 的会话映射。`)
      process.exitCode = 1
      return
    }
    jsonlFiles = jsonlFiles.filter(f => allowed.has(f.slice(0, -'.jsonl'.length)))
  }

  // 1. 只读解析所有 JSONL 索引文件
  const loadedSessions = []
  const parseFailures = new Map()
  let totalTurnsRaw = 0
  let turnsWithChangesField = 0
  let turnsWithChangedFiles = 0
  let turnsWithFilesField = 0
  let turnsWithCommands = 0
  let turnsWithErrors = 0
  let turnsWithTimestamps = 0

  for (const filename of jsonlFiles) {
    const sessionId = filename.slice(0, -'.jsonl'.length)
    let rawText
    try {
      rawText = await readFile(join(indexDir, filename), 'utf8')
    } catch {
      parseFailures.set('read-error', (parseFailures.get('read-error') ?? 0) + 1)
      continue
    }

    const parsed = parseIndexText(rawText)
    if (!parsed.ok) {
      const reason = parsed.reason || 'invalid'
      parseFailures.set(reason, (parseFailures.get(reason) ?? 0) + 1)
      continue
    }

    const turns = parsed.turns
    let lastTime = 0
    let firstTime = 0
    for (const t of turns) {
      const ts = Number.isFinite(t.end) ? t.end : (Number.isFinite(t.start) ? t.start : 0)
      if (ts > 0) {
        if (firstTime === 0 || ts < firstTime) firstTime = ts
        if (ts > lastTime) lastTime = ts
      }
    }

    loadedSessions.push({
      sessionId,
      anonId: anonSessionTag(sessionId),
      workspaceId: sessionToWorkspace.get(sessionId) ?? 'unknown',
      meta: parsed.meta,
      turns,
      turnCount: turns.length,
      firstTime,
      lastTime,
    })
  }

  // 按最近活跃时间倒序，支持 --max-sessions 抽样
  loadedSessions.sort((a, b) => (b.lastTime - a.lastTime) || a.sessionId.localeCompare(b.sessionId))
  const sampledSessions = args.maxSessions > 0
    ? loadedSessions.slice(0, args.maxSessions)
    : loadedSessions

  // 2. 自动化过滤 + 切段 + 字段对齐诊断
  let automatedCount = 0
  const automatedReasons = new Map()
  let humanSessionsCount = 0
  const suspectedMissedAuto = []
  const sessionTurnCounts = []
  const sessionSegCounts = []
  const segTurnCounts = []
  const segDurationMinutes = []
  let overLongSegments = 0 // >= 25 轮单段
  let hugeSingleSegSessions = 0 // >= 20 轮却只切出 1 段
  let fragmentedSessions = 0 // >= 6 轮且平均段长 <= 1.5 轮
  let singleTurnSegments = 0
  let workSegments = 0
  let chatSegments = 0
  const kindReasonFreq = new Map()
  const changedFileBaseFreq = new Map()
  const allFileBaseFreq = new Map()
  const genericFilteredFreq = new Map()
  let segsWithChangedFiles = 0
  let segsWithOnlyReadFiles = 0
  let segsWithNoFiles = 0
  let segsWithQuoteHandles = 0

  const fieldGapStats = {
    totalSegments: 0,
    timeFieldMismatch: 0,
    handleFieldMismatch: 0,
    errorFieldMismatch: 0,
    turnRangeFieldMismatch: 0,
  }

  const rawSegmentsForDirectMerge = []
  const adaptedSegmentsForMerge = []
  const sessionTurnsMap = new Map()
  const sessionAnomalies = []

  for (const sess of sampledSessions) {
    sessionTurnsMap.set(sess.sessionId, sess.turns)

    for (const t of sess.turns) {
      totalTurnsRaw += 1
      if (t.changes && typeof t.changes === 'object') {
        turnsWithChangesField += 1
        if (Array.isArray(t.changes.files) && t.changes.files.length > 0) turnsWithChangedFiles += 1
      }
      if (Array.isArray(t.files) && t.files.length > 0) turnsWithFilesField += 1
      if (Array.isArray(t.commands) && t.commands.length > 0) turnsWithCommands += 1
      if (t.interrupted === true || (typeof t.endReason === 'string' && t.endReason !== 'completed' && t.endReason !== 'open')) {
        turnsWithErrors += 1
      }
      if (Number.isFinite(t.start) || Number.isFinite(t.end)) turnsWithTimestamps += 1
    }

    const firstPrompt = String(sess.turns[0]?.prompt ?? '')
    const sessionMeta = {
      sessionId: sess.sessionId,
      title: firstPrompt.slice(0, 80),
      firstPrompt,
      turns: sess.turnCount,
      turnCount: sess.turnCount,
    }

    if (isAutomatedSession(sessionMeta)) {
      automatedCount += 1
      const reasonKey = sess.turnCount === 0
        ? 'empty-0-turns'
        : (firstPrompt.toLowerCase().includes('dsh-mnemon')
            ? 'dsh-mnemon'
            : (firstPrompt.toLowerCase().includes('delegated review')
                ? 'delegated-review'
                : 'other-automated-rule'))
      automatedReasons.set(reasonKey, (automatedReasons.get(reasonKey) ?? 0) + 1)
      continue
    }

    humanSessionsCount += 1
    sessionTurnCounts.push(sess.turnCount)

    const suspectSignals = detectSuspectedSubagentSignals(sess.turns)
    if (suspectSignals.length > 0) {
      suspectedMissedAuto.push({
        sessionTag: sess.anonId,
        turns: sess.turnCount,
        signals: suspectSignals,
      })
    }

    const segments = sliceSessionSegments(sess.turns, { sessionId: sess.sessionId })
    sessionSegCounts.push(segments.length)

    if (sess.turnCount >= 20 && segments.length === 1) {
      hugeSingleSegSessions += 1
      sessionAnomalies.push({
        type: 'giant-single-segment-session',
        sessionTag: sess.anonId,
        turns: sess.turnCount,
        segments: 1,
      })
    }
    if (sess.turnCount >= 6 && segments.length > 0 && sess.turnCount / segments.length <= 1.5) {
      fragmentedSessions += 1
      sessionAnomalies.push({
        type: 'over-fragmented-session',
        sessionTag: sess.anonId,
        turns: sess.turnCount,
        segments: segments.length,
        avgTurnsPerSeg: Number((sess.turnCount / segments.length).toFixed(2)),
      })
    }

    const turnByNum = new Map(sess.turns.map(t => [t.turn, t]))
    for (const seg of segments) {
      fieldGapStats.totalSegments += 1
      const align = inspectFieldAlignment(seg)
      if (align.hasStartEndTime && !align.hasStartedEndedAt) fieldGapStats.timeFieldMismatch += 1
      if (align.hasQuoteHandles && !align.hasReferencedHandles) fieldGapStats.handleFieldMismatch += 1
      if (align.hasErrorTurns && !align.hasHasError) fieldGapStats.errorFieldMismatch += 1
      if (align.hasStartEndTurn && !align.hasTurnRange) fieldGapStats.turnRangeFieldMismatch += 1

      segTurnCounts.push(seg.turnCount)
      if (seg.turnCount === 1) singleTurnSegments += 1
      if (seg.turnCount >= 25) overLongSegments += 1
      if (Number.isFinite(seg.startTime) && Number.isFinite(seg.endTime) && seg.endTime >= seg.startTime) {
        segDurationMinutes.push(Number(((seg.endTime - seg.startTime) / 60000).toFixed(1)))
      }

      if (seg.kindCandidate === 'work') workSegments += 1
      else chatSegments += 1
      for (const r of (seg.kindReasons ?? [])) {
        kindReasonFreq.set(r, (kindReasonFreq.get(r) ?? 0) + 1)
      }

      if (seg.changedFiles.length > 0) segsWithChangedFiles += 1
      else if (seg.files.length > 0) segsWithOnlyReadFiles += 1
      else segsWithNoFiles += 1

      if (seg.quoteHandles.length > 0) segsWithQuoteHandles += 1

      for (const f of seg.changedFiles) {
        const base = sanitizePathBasename(f)
        if (!base) continue
        changedFileBaseFreq.set(base, (changedFileBaseFreq.get(base) ?? 0) + 1)
        if (GENERIC_CONFIG_FILES.has(base)) {
          genericFilteredFreq.set(base, (genericFilteredFreq.get(base) ?? 0) + 1)
        }
      }
      for (const f of seg.files) {
        const base = sanitizePathBasename(f)
        if (!base) continue
        allFileBaseFreq.set(base, (allFileBaseFreq.get(base) ?? 0) + 1)
      }

      const turnsInSeg = []
      for (let tn = seg.startTurn; tn <= seg.endTurn; tn += 1) {
        const row = turnByNum.get(tn)
        if (row) turnsInSeg.push({ ...row, sessionId: sess.sessionId, segmentId: seg.id })
      }

      rawSegmentsForDirectMerge.push(seg)
      adaptedSegmentsForMerge.push({
        adapted: adaptSegmentForMerge(seg, turnsInSeg, sess.workspaceId),
        turnsInSeg,
      })
    }
  }

  // 3. 冷启动硬信号聚类：分别对比“直接透传 raw segments”与“字段对齐后 adapted segments”
  const nowMs = args.nowMs
  const directPlan = planColdStartWorks(rawSegmentsForDirectMerge, {
    workspaceId: args.workspace || 'dry-run-all',
    now: nowMs,
    dormantDays: args.dormantDays,
  })

  const adaptedList = adaptedSegmentsForMerge.map(x => x.adapted)
  const adaptedPlan = planColdStartWorks(adaptedList, {
    workspaceId: args.workspace || 'dry-run-all',
    now: nowMs,
    dormantDays: args.dormantDays,
  })

  // 同时按工作区分桶跑一遍（反映真实“单工作区冷启动”场景下的首页卡片规模）
  const segsByWorkspace = new Map()
  for (const item of adaptedSegmentsForMerge) {
    const ws = item.adapted.workspaceId || 'unknown'
    if (!segsByWorkspace.has(ws)) segsByWorkspace.set(ws, [])
    segsByWorkspace.get(ws).push(item.adapted)
  }

  const perWorkspaceSummary = []
  for (const [wsId, wsSegs] of segsByWorkspace.entries()) {
    const wsPlan = planColdStartWorks(wsSegs, {
      workspaceId: wsId,
      now: nowMs,
      dormantDays: args.dormantDays,
    })
    const wsStore0 = {
      ...emptyWorkStore(wsId),
      works: wsPlan.works,
      updatedAt: nowMs,
    }
    const wsSettledStore = applyDormancySettlement(wsStore0, {
      now: nowMs,
      dormantDays: args.dormantDays,
    })
    const wsCards = projectResumeCards(wsSettledStore, { now: nowMs })
    const clusterSizes = wsPlan.clusters.map(c => c.sessionIds.length)
    perWorkspaceSummary.push({
      workspaceTag: wsId === 'unknown' ? 'unmapped' : wsId.slice(0, 8),
      sessions: new Set(wsSegs.map(s => s.sessionId)).size,
      segments: wsSegs.length,
      clusters: wsPlan.clusters.length,
      worksTotal: wsPlan.works.length,
      chatTopics: wsPlan.chatTopics.length,
      maxSessionsInCluster: clusterSizes.length ? Math.max(...clusterSizes) : 0,
      unresolvedCards: wsCards.unresolved.length,
      blockedCards: wsCards.unresolved.filter(c => c.state === 'blocked').length,
      activeCards: wsCards.unresolved.filter(c => c.state === 'active').length,
      settledCards: wsCards.settled.length,
    })
  }
  perWorkspaceSummary.sort((a, b) => b.sessions - a.sessions)

  // 4. 全量沉降 + 卡片投影（基于 adaptedPlan）
  const storeBeforeSettle = {
    ...emptyWorkStore(args.workspace || 'dry-run-all'),
    works: adaptedPlan.works,
    updatedAt: nowMs,
  }
  const storeAfterSettle = applyDormancySettlement(storeBeforeSettle, {
    now: nowMs,
    dormantDays: args.dormantDays,
  })
  const resumeCards = projectResumeCards(storeAfterSettle, { now: nowMs })

  // 对比直接透传（未做时间字段对齐）时的沉降效果，定位潜在契约断层
  const directStoreAfterSettle = applyDormancySettlement(
    { ...emptyWorkStore(args.workspace || 'dry-run-all'), works: directPlan.works, updatedAt: nowMs },
    { now: nowMs, dormantDays: args.dormantDays },
  )
  const directCards = projectResumeCards(directStoreAfterSettle, { now: nowMs })

  // 5. 聚类簇规模与粘连风险分析 + handoff 硬事实与 Wire 上下文压力测试
  const clusterSegSizes = adaptedPlan.clusters.map(c => c.segmentIds.length)
  const clusterSessSizes = adaptedPlan.clusters.map(c => c.sessionIds.length)
  const mergeReasonFreq = new Map()
  const giantClusters = []
  for (const c of adaptedPlan.clusters) {
    if (c.reasons.length === 0) {
      mergeReasonFreq.set('singleton', (mergeReasonFreq.get('singleton') ?? 0) + 1)
    } else {
      for (const r of c.reasons) {
        mergeReasonFreq.set(r, (mergeReasonFreq.get(r) ?? 0) + 1)
      }
    }
    if (c.sessionIds.length >= 4 || c.segmentIds.length >= 8) {
      giantClusters.push({
        clusterId: c.clusterId,
        bucket: c.bucket,
        state: c.state,
        sessions: c.sessionIds.length,
        segments: c.segmentIds.length,
        reasons: c.reasons,
        fileCount: c.files.length,
        topBasenames: [...new Set(c.files.map(sanitizePathBasename).filter(Boolean))].slice(0, 5),
      })
    }
  }
  giantClusters.sort((a, b) => (b.sessions - a.sessions) || (b.segments - a.segments))

  // 抽取每个 Work 的硬事实与 Wire 上下文渲染指标
  const segTurnsIndex = new Map(adaptedSegmentsForMerge.map(item => [item.adapted.id, item.turnsInSeg]))
  let worksEmptyNextStep = 0
  let worksEmptyGoal = 0
  let worksNoChangedFiles = 0
  let worksNoRecentCommands = 0
  let worksWithFailedSignals = 0
  let worksNoEvidenceHandles = 0
  const wireCharLengths = []
  let wireTruncatedCount = 0
  let wireOverBudgetCount = 0

  for (const work of storeAfterSettle.works) {
    if (!work.nextStep) worksEmptyNextStep += 1
    if (!work.goal) worksEmptyGoal += 1

    const workTurns = []
    for (const segId of work.segmentIds) {
      const rows = segTurnsIndex.get(segId)
      if (rows) workTurns.push(...rows)
    }
    const facts = extractWorkHardFacts(workTurns)
    if (facts.changedFiles.length === 0) worksNoChangedFiles += 1
    if (facts.recentCommands.length === 0) worksNoRecentCommands += 1
    if (facts.failedSignals.length > 0) worksWithFailedSignals += 1
    if (facts.keyEvidenceHandles.length === 0) worksNoEvidenceHandles += 1

    const wireText = renderWorkContextForAgent(work, facts, { maxChars: 2800 })
    wireCharLengths.push(wireText.length)
    if (wireText.includes('已省略')) wireTruncatedCount += 1
    if (wireText.length > 2800) wireOverBudgetCount += 1
  }

  // 统计最近活跃分布（辅助评估 dormantDays 合理性）
  const ageBuckets = bucketCount(
    storeBeforeSettle.works.map(w => (w.lastActivityAt > 0 ? Math.max(0, (nowMs - w.lastActivityAt) / DAY_MS) : 9999)),
    [
      { label: '<=1天', min: 0, max: 1 },
      { label: '1-3天', min: 1.0001, max: 3 },
      { label: '3-7天', min: 3.0001, max: 7 },
      { label: '7-14天', min: 7.0001, max: 14 },
      { label: '14-30天', min: 14.0001, max: 30 },
      { label: '>30天/无时间', min: 30.0001, max: Infinity },
    ],
  )

  const report = {
    meta: {
      mode: 'read-only-dry-run',
      scannedAt: new Date(nowMs).toISOString(),
      dormantDays: args.dormantDays,
      maxSessionsLimit: args.maxSessions || 'all',
      workspaceFilter: args.workspace ? args.workspace.slice(0, 8) : 'all',
      indexDirBasename: basename(indexDir),
    },
    inventory: {
      totalJsonlFiles: jsonlFiles.length,
      parsedSessions: loadedSessions.length,
      sampledSessions: sampledSessions.length,
      parseFailures: Object.fromEntries(parseFailures.entries()),
      totalTurns: totalTurnsRaw,
      turnsWithChangesField,
      turnsWithChangedFiles,
      turnsWithFilesField,
      turnsWithCommands,
      turnsWithErrors,
      turnsWithTimestamps,
    },
    automationFilter: {
      filteredAutomated: automatedCount,
      filteredRate: pct(automatedCount, sampledSessions.length),
      humanSessions: humanSessionsCount,
      filteredReasons: Object.fromEntries(automatedReasons.entries()),
      suspectedMissedCount: suspectedMissedAuto.length,
      suspectedMissedBySignal: countSignalFrequency(suspectedMissedAuto),
      suspectedMissedSamples: suspectedMissedAuto.slice(0, 10),
    },
    segmentation: {
      totalSegments: segTurnCounts.length,
      sessionTurnsStats: summarizeNumbers(sessionTurnCounts),
      segmentsPerSessionStats: summarizeNumbers(sessionSegCounts),
      turnsPerSegmentStats: summarizeNumbers(segTurnCounts),
      segmentDurationMinStats: summarizeNumbers(segDurationMinutes),
      segmentLengthBuckets: bucketCount(segTurnCounts, [
        { label: '1轮', min: 1, max: 1 },
        { label: '2-3轮', min: 2, max: 3 },
        { label: '4-8轮', min: 4, max: 8 },
        { label: '9-20轮', min: 9, max: 20 },
        { label: '21+轮', min: 21, max: Infinity },
      ]),
      singleTurnSegments,
      singleTurnSegmentRate: pct(singleTurnSegments, segTurnCounts.length),
      overLongSegments25Plus: overLongSegments,
      hugeSingleSegSessions20Plus: hugeSingleSegSessions,
      fragmentedSessions6Plus: fragmentedSessions,
      kindDistribution: {
        work: workSegments,
        workRate: pct(workSegments, segTurnCounts.length),
        chat: chatSegments,
        chatRate: pct(chatSegments, segTurnCounts.length),
      },
      kindReasonsTop: topEntries(kindReasonFreq, 12),
      segmentFileCoverage: {
        withChangedFiles: segsWithChangedFiles,
        withOnlyReadFiles: segsWithOnlyReadFiles,
        withNoFiles: segsWithNoFiles,
        withQuoteHandles: segsWithQuoteHandles,
      },
      topChangedFileBasenames: topEntries(changedFileBaseFreq, 15),
      topAllFileBasenames: topEntries(allFileBaseFreq, 15),
      genericConfigHitInChanged: topEntries(genericFilteredFreq, 10),
      anomaliesSample: sessionAnomalies.slice(0, 12),
    },
    contractAlignment: fieldGapStats,
    clustering: {
      adapted: {
        totalClusters: adaptedPlan.clusters.length,
        worksTotal: adaptedPlan.works.length,
        unresolvedWorksBeforeSettle: adaptedPlan.unresolvedWorks.length,
        settledWorksBeforeSettle: adaptedPlan.settledWorks.length,
        chatTopics: adaptedPlan.chatTopics.length,
        ignoredSegments: adaptedPlan.ignoredSegments.length,
        segmentsPerClusterStats: summarizeNumbers(clusterSegSizes),
        sessionsPerClusterStats: summarizeNumbers(clusterSessSizes),
        clusterSessionBuckets: bucketCount(clusterSessSizes, [
          { label: '1会话', min: 1, max: 1 },
          { label: '2会话', min: 2, max: 2 },
          { label: '3-5会话', min: 3, max: 5 },
          { label: '6-10会话', min: 6, max: 10 },
          { label: '11+会话', min: 11, max: Infinity },
        ]),
        mergeReasons: Object.fromEntries(mergeReasonFreq.entries()),
        giantClustersTop: giantClusters.slice(0, 10),
      },
      directWithoutAdapter: {
        totalClusters: directPlan.clusters.length,
        worksTotal: directPlan.works.length,
        unresolvedCardsAfterSettle: directCards.unresolved.length,
        settledCardsAfterSettle: directCards.settled.length,
        maxSessionsInCluster: directPlan.clusters.length
          ? Math.max(...directPlan.clusters.map(c => c.sessionIds.length))
          : 0,
      },
    },
    settlementAndCards: {
      allCombined: {
        unresolvedCards: resumeCards.unresolved.length,
        blockedCards: resumeCards.unresolved.filter(c => c.state === 'blocked').length,
        activeCards: resumeCards.unresolved.filter(c => c.state === 'active').length,
        settledCards: resumeCards.settled.length,
        pendingReviewCount: resumeCards.pendingReviewCount,
        workAgeBuckets: ageBuckets,
      },
      byWorkspace: perWorkspaceSummary,
    },
    handoffQuality: {
      totalWorksEvaluated: storeAfterSettle.works.length,
      worksEmptyNextStep,
      worksEmptyNextStepRate: pct(worksEmptyNextStep, storeAfterSettle.works.length),
      worksEmptyGoal,
      worksNoChangedFilesInHardFacts: worksNoChangedFiles,
      worksNoChangedFilesRate: pct(worksNoChangedFiles, storeAfterSettle.works.length),
      worksNoRecentCommands,
      worksWithFailedSignals,
      worksNoEvidenceHandles,
      wireContextCharsStats: summarizeNumbers(wireCharLengths),
      wireTruncatedCount,
      wireOverBudgetCount,
    },
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  printHumanReport(report)
}

function countSignalFrequency(items) {
  const freq = new Map()
  for (const item of items) {
    for (const s of item.signals) {
      freq.set(s, (freq.get(s) ?? 0) + 1)
    }
  }
  return Object.fromEntries(freq.entries())
}

function printHumanReport(r) {
  const hr = '─'.repeat(72)
  console.log(`=== ADR-0003 只读干跑诊断报告（脱敏）===`)
  console.log(`时间: ${r.meta.scannedAt} | dormantDays=${r.meta.dormantDays} | maxSessions=${r.meta.maxSessionsLimit} | workspace=${r.meta.workspaceFilter}`)
  console.log(hr)

  const inv = r.inventory
  console.log(`[1] 样本规模与事实层覆盖`)
  console.log(`  索引文件: ${inv.totalJsonlFiles} | 成功解析: ${inv.parsedSessions} | 本次抽检: ${inv.sampledSessions}`)
  if (Object.keys(inv.parseFailures).length > 0) {
    console.log(`  解析失败: ${JSON.stringify(inv.parseFailures)}`)
  }
  console.log(`  总轮次: ${inv.totalTurns} | 有时间戳: ${inv.turnsWithTimestamps} (${pct(inv.turnsWithTimestamps, inv.totalTurns)})`)
  console.log(`  含 changes 字段: ${inv.turnsWithChangesField} (${pct(inv.turnsWithChangesField, inv.totalTurns)}) | changes.files 非空: ${inv.turnsWithChangedFiles} (${pct(inv.turnsWithChangedFiles, inv.totalTurns)})`)
  console.log(`  含 files 字段: ${inv.turnsWithFilesField} (${pct(inv.turnsWithFilesField, inv.totalTurns)}) | 含 commands: ${inv.turnsWithCommands} | 异常/中断轮: ${inv.turnsWithErrors}`)
  console.log(hr)

  const auto = r.automationFilter
  console.log(`[2] 子代理 / 自动化会话过滤`)
  console.log(`  命中过滤: ${auto.filteredAutomated} / ${inv.sampledSessions} (${auto.filteredRate}) | 保留人工会话: ${auto.humanSessions}`)
  console.log(`  命中原因: ${JSON.stringify(auto.filteredReasons)}`)
  console.log(`  疑似漏网自动化特征: ${auto.suspectedMissedCount} 个会话 | 特征计数: ${JSON.stringify(auto.suspectedMissedBySignal)}`)
  console.log(hr)

  const seg = r.segmentation
  console.log(`[3] 会话切段分布`)
  console.log(`  总段数: ${seg.totalSegments} | 单会话轮次: p50=${seg.sessionTurnsStats.p50}, p90=${seg.sessionTurnsStats.p90}, max=${seg.sessionTurnsStats.max}, avg=${seg.sessionTurnsStats.avg}`)
  console.log(`  单会话段数: p50=${seg.segmentsPerSessionStats.p50}, p90=${seg.segmentsPerSessionStats.p90}, max=${seg.segmentsPerSessionStats.max}, avg=${seg.segmentsPerSessionStats.avg}`)
  console.log(`  单段轮数:   p50=${seg.turnsPerSegmentStats.p50}, p90=${seg.turnsPerSegmentStats.p90}, max=${seg.turnsPerSegmentStats.max}, avg=${seg.turnsPerSegmentStats.avg}`)
  console.log(`  段长分桶:   ${JSON.stringify(seg.segmentLengthBuckets)}`)
  console.log(`  异常切段:   1轮碎片=${seg.singleTurnSegments} (${seg.singleTurnSegmentRate}) | >=25轮超长段=${seg.overLongSegments25Plus} | >=20轮全并1段会话=${seg.hugeSingleSegSessions20Plus} | 过碎会话(>=6轮且均长<=1.5)=${seg.fragmentedSessions6Plus}`)
  console.log(`  kindCandidate: work=${seg.kindDistribution.work} (${seg.kindDistribution.workRate}) vs chat=${seg.kindDistribution.chat} (${seg.kindDistribution.chatRate})`)
  console.log(`  kindReasons Top: ${seg.kindReasonsTop.map(x => `${x.key}:${x.count}`).join(', ')}`)
  console.log(`  段文件覆盖: changedFiles非空=${seg.segmentFileCoverage.withChangedFiles} | 仅读files=${seg.segmentFileCoverage.withOnlyReadFiles} | 无文件=${seg.segmentFileCoverage.withNoFiles} | 含引用句柄=${seg.segmentFileCoverage.withQuoteHandles}`)
  console.log(`  高频变更文件名(脱敏): ${seg.topChangedFileBasenames.slice(0, 10).map(x => `${x.key}(${x.count})`).join(', ') || '(无)'}`)
  console.log(`  高频出现文件名(脱敏): ${seg.topAllFileBasenames.slice(0, 10).map(x => `${x.key}(${x.count})`).join(', ') || '(无)'}`)
  console.log(hr)

  const ca = r.contractAlignment
  console.log(`[4] segment.js ↔ work-merge.js 字段契约对齐检查`)
  console.log(`  时间字段错位(startTime/endTime vs startedAt/endedAt/lastActivityAt): ${ca.timeFieldMismatch} / ${ca.totalSegments}`)
  console.log(`  句柄字段错位(quoteHandles vs referencedHandles): ${ca.handleFieldMismatch} / ${ca.totalSegments}`)
  console.log(`  异常字段错位(errorTurns vs hasError): ${ca.errorFieldMismatch} / ${ca.totalSegments}`)
  console.log(`  轮次区间错位(startTurn/endTurn vs turnRange): ${ca.turnRangeFieldMismatch} / ${ca.totalSegments}`)
  console.log(hr)

  const cl = r.clustering.adapted
  const clDir = r.clustering.directWithoutAdapter
  console.log(`[5] 冷启动硬信号聚类`)
  console.log(`  (字段对齐后) 簇总数: ${cl.totalClusters} | works=${cl.worksTotal} (未收束=${cl.unresolvedWorksBeforeSettle}, 已收尾/沉降=${cl.settledWorksBeforeSettle}) | chatTopics=${cl.chatTopics}`)
  console.log(`  簇内段数: p50=${cl.segmentsPerClusterStats.p50}, p90=${cl.segmentsPerClusterStats.p90}, max=${cl.segmentsPerClusterStats.max}, avg=${cl.segmentsPerClusterStats.avg}`)
  console.log(`  簇内会话: p50=${cl.sessionsPerClusterStats.p50}, p90=${cl.sessionsPerClusterStats.p90}, max=${cl.sessionsPerClusterStats.max}, avg=${cl.sessionsPerClusterStats.avg}`)
  console.log(`  簇会话分桶: ${JSON.stringify(cl.clusterSessionBuckets)}`)
  console.log(`  合并依据分布: ${JSON.stringify(cl.mergeReasons)}`)
  if (cl.giantClustersTop.length > 0) {
    console.log(`  大簇风险样本(>=4会话或>=8段):`)
    for (const g of cl.giantClustersTop) {
      console.log(`    - ${g.clusterId}: ${g.sessions}会话 / ${g.segments}段 / state=${g.state} / reasons=${g.reasons.join(',')} / files=${g.fileCount} / top=${g.topBasenames.join(',')}`)
    }
  } else {
    console.log(`  大簇风险样本: 无`)
  }
  console.log(`  (对照: 未经适配直传 planColdStartWorks) 簇=${clDir.totalClusters}, works=${clDir.worksTotal}, 沉降后未收束=${clDir.unresolvedCardsAfterSettle}, 已沉降=${clDir.settledCardsAfterSettle}, 最大簇会话数=${clDir.maxSessionsInCluster}`)
  console.log(hr)

  const sc = r.settlementAndCards
  console.log(`[6] 沉降与首页未收束卡片规模`)
  console.log(`  全量合并视图: 未收束=${sc.allCombined.unresolvedCards} (blocked=${sc.allCombined.blockedCards}, active=${sc.allCombined.activeCards}) | 已沉降/收尾=${sc.allCombined.settledCards}`)
  console.log(`  Work 活跃距今分布: ${JSON.stringify(sc.allCombined.workAgeBuckets)}`)
  console.log(`  按工作区分桶（贴近真实单工作区面板）:`)
  for (const ws of sc.byWorkspace) {
    console.log(`    - ws[${ws.workspaceTag}]: ${ws.sessions}会话 / ${ws.segments}段 → ${ws.worksTotal}事(${ws.chatTopics}话题) | 首页未收束=${ws.unresolvedCards} (blocked=${ws.blockedCards}, active=${ws.activeCards}) | 沉降=${ws.settledCards} | 最大簇=${ws.maxSessionsInCluster}会话`)
  }
  console.log(hr)

  const hq = r.handoffQuality
  console.log(`[7] Handoff 硬事实与 Wire 上下文体检`)
  console.log(`  评估事总数: ${hq.totalWorksEvaluated}`)
  console.log(`  空 nextStep: ${hq.worksEmptyNextStep} (${hq.worksEmptyNextStepRate}) | 空 goal: ${hq.worksEmptyGoal}`)
  console.log(`  extractWorkHardFacts 无 changedFiles: ${hq.worksNoChangedFilesInHardFacts} (${hq.worksNoChangedFilesRate}) | 无 commands: ${hq.worksNoRecentCommands} | 有失败信号: ${hq.worksWithFailedSignals} | 无证据句柄: ${hq.worksNoEvidenceHandles}`)
  console.log(`  Wire 渲染字符数: p50=${hq.wireContextCharsStats.p50}, p90=${hq.wireContextCharsStats.p90}, max=${hq.wireContextCharsStats.max} | 触发预算裁剪=${hq.wireTruncatedCount} | 超2800预算=${hq.wireOverBudgetCount}`)
}

run().catch(err => {
  console.error('干跑异常:', err?.message ?? err)
  process.exitCode = 1
})
