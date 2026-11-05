/**
 * 报告：工作量统计、风险清单、导出。
 *
 * 这三块都是"把已经算出来的东西换个方式呈现"，不需要新数据源：
 *   - 工作量：轮次事实里的 toolCalls / durationMs / usage
 *   - 风险：状态推导里的 blocked 项 + 报错轮次 + 反复返工
 *   - 导出：把上面全部拼成 Markdown / CSV
 *
 * 设计取舍：**风险只列有证据的**。没有证据的"可能有问题"不算风险——
 * 那会让清单变成噪音，PM 就不看了。
 *
 * @module dsh-topic-map/report
 */

/** 工作量统计：单个任务。 */
export function laneWorkload(lane, factOf) {
  const turns = Array.isArray(lane?.turns) ? lane.turns : []
  let toolCalls = 0
  let steps = 0
  let durationMs = 0
  let tokens = 0
  let cost = 0

  for (const t of turns) {
    const fact = factOf(t)
    if (fact === undefined || fact === null) continue
    toolCalls += Number(fact.toolCalls) || 0
    steps += Number(fact.steps) || 0
    durationMs += Number(fact.durationMs) || 0
    const u = fact.usage ?? {}
    tokens += (Number(u.input) || 0) + (Number(u.output) || 0)
      + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) + (Number(u.reasoning) || 0)
    cost += Number(fact.cost) || 0
  }

  return {
    laneId: lane?.laneId ?? '',
    title: lane?.title ?? '',
    stage: lane?.stageName ?? null,
    turns: turns.length,
    toolCalls,
    steps,
    durationMs,
    tokens,
    cost,
  }
}

/**
 * 整个会话的工作量汇总。
 *
 * @param lanes - 泳道。
 * @param factOf - `(turn) => fact`。
 * @returns `{ rows, totals }`。
 */
export function workloadReport(lanes, factOf) {
  const rows = (Array.isArray(lanes) ? lanes : []).map(l => laneWorkload(l, factOf))
  const totals = {
    turns: 0, toolCalls: 0, steps: 0, durationMs: 0, tokens: 0, cost: 0,
  }
  for (const r of rows) {
    totals.turns += r.turns
    totals.toolCalls += r.toolCalls
    totals.steps += r.steps
    totals.durationMs += r.durationMs
    totals.tokens += r.tokens
    totals.cost += r.cost
  }
  // 按工具调用降序：最能看出"哪件事最费劲"
  rows.sort((a, b) => b.toolCalls - a.toolCalls)
  return { rows, totals }
}

/**
 * 风险清单。
 *
 * 三类有证据的风险：
 *   1. blocked —— 状态推导为阻塞
 *   2. error-turn —— 该任务里有轮次报错/中断
 *   3. rework —— 同一任务被反复回来修改（轮次多且不连续）
 *
 * @param lanes - 泳道。
 * @param factOf - `(turn) => fact`。
 * @param detailOf - `(laneId) => { state, basis }`。
 * @returns `[{ laneId, title, stage, kind, level, reason }]`。
 */
export function riskReport(lanes, factOf, detailOf) {
  const out = []
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    const detail = typeof detailOf === 'function' ? detailOf(lane.laneId) : null
    const state = detail === null || detail === undefined ? 'todo' : detail.state
    const turns = Array.isArray(lane.turns) ? lane.turns : []

    if (state === 'blocked') {
      out.push({
        laneId: lane.laneId,
        title: lane.title,
        stage: lane.stageName ?? null,
        kind: 'blocked',
        level: 'high',
        reason: detail.basis || '处于阻塞状态',
      })
      continue
    }

    const errorTurns = turns.filter(t => {
      const f = factOf(t)
      return f !== undefined && f !== null
        && ['error', 'max-tokens', 'aborted', 'interrupted', 'blocked'].includes(f.endReason)
    })
    if (errorTurns.length > 0) {
      out.push({
        laneId: lane.laneId,
        title: lane.title,
        stage: lane.stageName ?? null,
        kind: 'error-turn',
        level: 'high',
        reason: `第 ${errorTurns.join('、')} 轮报错或中断`,
      })
      continue
    }

    // 返工：轮次多，或改动量异常大
    //
    // 两个判据都要，因为返工有两种形态：
    //   ① 同一任务分几段处理（中间去做别的了）—— 看轮次是否连续
    //   ② 连续多轮里工具调用量巨大 —— 在反复折腾
    // 实测某会话"跳转定位"是 [11,12,13,14,15] 连续五轮，按 ① 判不出来，
    // 但工具调用 152 次，明显是在反复试。
    //
    // 注意不能用 `tools` 判断"改了几次"：那是**去重后**的工具名列表，
    // 只能说明"用没用过 write"，不能说明用了几次。要用 toolCalls。
    if (turns.length >= 3) {
      const sorted = [...turns].sort((a, b) => a - b)
      let gaps = 0
      for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i] - sorted[i - 1] > 1) gaps += 1
      }
      const totalCalls = turns.reduce((a, t) => {
        const f = factOf(t)
        return a + (f !== undefined && f !== null ? (Number(f.toolCalls) || 0) : 0)
      }, 0)

      if (gaps > 0) {
        out.push({
          laneId: lane.laneId,
          title: lane.title,
          stage: lane.stageName ?? null,
          kind: 'rework',
          level: 'medium',
          reason: `分 ${gaps + 1} 段反复处理，共 ${turns.length} 轮`,
        })
      } else if (turns.length >= 4 && totalCalls >= 80) {
        out.push({
          laneId: lane.laneId,
          title: lane.title,
          stage: lane.stageName ?? null,
          kind: 'rework',
          level: 'medium',
          reason: `连续 ${turns.length} 轮、${totalCalls} 次工具调用，改动量大`,
        })
      }
    }
  }
  // 高优先在前
  out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1))
  return out
}

/** CSV 单元格转义。 */
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * 导出任务表为 CSV。
 *
 * 列选得克制：PM 更关心状态与工作量，不需要把 token 明细全倒出来。
 *
 * @param rows - `[{ title, stage, state, turns, toolCalls, durationMs, cost }]`。
 * @returns CSV 文本。
 */
export function toCsv(rows) {
  const header = ['任务', '阶段', '状态', '轮次', '工具调用', '耗时(秒)', '费用(USD)']
  const lines = [header.join(',')]
  for (const r of Array.isArray(rows) ? rows : []) {
    lines.push([
      csvCell(r.title),
      csvCell(r.stage ?? ''),
      csvCell(r.state ?? ''),
      csvCell(r.turns ?? 0),
      csvCell(r.toolCalls ?? 0),
      csvCell(Math.round((r.durationMs ?? 0) / 1000)),
      csvCell((r.cost ?? 0).toFixed(2)),
    ].join(','))
  }
  return lines.join('\n')
}

/**
 * 导出为 Markdown 报告。
 *
 * @param input - `{ title, stages, stateOf, detailOf, risks, deliverables, workload, totals }`。
 * @returns Markdown 文本。
 */
export function toMarkdown(input) {
  const {
    title = '话题地图',
    stages = [],
    detailOf,
    risks = [],
    deliverables = [],
    workload,
    totals,
    stateLabel,
  } = input ?? {}

  const lines = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`> 由 DSH 话题地图导出`)
  lines.push('')

  // 总览
  const counts = { done: 0, active: 0, blocked: 0, todo: 0 }
  for (const stage of stages) {
    for (const wf of stage.workflows ?? []) {
      for (const task of wf.tasks ?? []) {
        const t0 = Array.isArray(task.turns) && task.turns.length > 0 ? task.turns[0] : null
        if (t0 === null) continue
        const d = typeof detailOf === 'function' ? detailOf(t0) : null
        if (d !== null && counts[d.state] !== undefined) counts[d.state] += 1
      }
    }
  }
  lines.push('## 总览')
  lines.push('')
  lines.push(`| 指标 | 值 |`)
  lines.push(`| --- | --- |`)
  const label = typeof stateLabel === 'function' ? stateLabel : (s => s)
  for (const k of ['done', 'active', 'blocked', 'todo']) {
    lines.push(`| ${label(k)} | ${counts[k]} |`)
  }
  if (totals !== undefined) {
    lines.push(`| 轮次 | ${totals.turns ?? 0} |`)
    lines.push(`| 工具调用 | ${totals.toolCalls ?? 0} |`)
    lines.push(`| 耗时 | ${Math.round((totals.durationMs ?? 0) / 1000)} 秒 |`)
    lines.push(`| 费用 | $${(totals.cost ?? 0).toFixed(2)} |`)
  }
  lines.push('')

  // 结构
  lines.push('## 结构与状态')
  lines.push('')
  for (const stage of stages) {
    lines.push(`### ${stage.name}`)
    lines.push('')
    for (const wf of stage.workflows ?? []) {
      lines.push(`**${wf.name}**`)
      lines.push('')
      for (const task of wf.tasks ?? []) {
        const t0 = Array.isArray(task.turns) && task.turns.length > 0 ? task.turns[0] : null
        const d = t0 === null || typeof detailOf !== 'function' ? null : detailOf(t0)
        const state = d === null ? '' : ` — ${label(d.state)}`
        const turns = Array.isArray(task.turns) ? ` (${task.turns.map(t => 'T' + t).join(' ')})` : ''
        lines.push(`- ${task.name}${state}${turns}`)
      }
      lines.push('')
    }
  }

  // 风险
  if (risks.length > 0) {
    lines.push('## 风险')
    lines.push('')
    lines.push(`| 任务 | 阶段 | 类型 | 说明 |`)
    lines.push(`| --- | --- | --- | --- |`)
    for (const r of risks) {
      const kind = r.kind === 'blocked' ? '阻塞' : r.kind === 'error-turn' ? '报错' : '返工'
      lines.push(`| ${r.title} | ${r.stage ?? ''} | ${kind} | ${r.reason} |`)
    }
    lines.push('')
  }

  // 交付物
  if (deliverables.length > 0) {
    lines.push('## 交付物')
    lines.push('')
    for (const g of deliverables) {
      lines.push(`### ${g.stage}`)
      lines.push('')
      for (const item of g.items) lines.push(`- \`${item.name}\``)
      lines.push('')
    }
  }

  // 工作量
  if (workload !== undefined && Array.isArray(workload.rows) && workload.rows.length > 0) {
    lines.push('## 工作量')
    lines.push('')
    lines.push(`| 任务 | 轮次 | 工具调用 | 耗时(秒) | 费用 |`)
    lines.push(`| --- | --- | --- | --- | --- |`)
    for (const r of workload.rows.slice(0, 20)) {
      lines.push(`| ${r.title} | ${r.turns} | ${r.toolCalls} | ${Math.round(r.durationMs / 1000)} | $${r.cost.toFixed(2)} |`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
