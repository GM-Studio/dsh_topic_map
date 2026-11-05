/**
 * 项目管理模型：任务状态与依赖。
 *
 * 这一层回答"这件事进展到哪了、谁挡着谁"，而不只是"什么时候聊了什么"。
 *
 * 两个必须说清的前提：
 *
 * 1. **状态是推导出来的，不是真实字段。** 会话日志里没有"任务状态"这种东西，
 *    只能从"这一轮怎么结束、后续是否还在改它"推断。因此每个状态都带
 *    `inferred: true` 与 `basis`（依据），且允许用户覆盖。
 *
 * 2. **依赖也是推导的。** 真实依赖要么来自显式声明（没有），要么来自
 *    "后续出现失败并回头修复"这种时序信号。所以只输出**有证据的**那条，
 *    没有证据就不画线——宁可少画，不要画错。
 *
 * @module dsh-topic-map/pm-model
 */

/** 任务状态。 */
export const TASK_STATES = ['todo', 'active', 'blocked', 'done']

/** 状态的中文名与配色语义。 */
export const STATE_META = {
  todo: { label: '待办', tone: 'idle' },
  active: { label: '进行中', tone: 'brand' },
  blocked: { label: '阻塞', tone: 'warn' },
  done: { label: '已完成', tone: 'ok' },
}

/**
 * 会修改文件的工具名。
 *
 * 为什么用工具名而不是 `files`：`files` 只记工具参数里出现的路径，**读和写
 * 混在一起**（实测某会话 442 条里绝大多数是读到的文件），无法据此判断
 * "有没有实际产出"。工具名是可靠得多的信号——只有 edit/write 这类才会改文件。
 */
export const MUTATING_TOOLS = ['edit', 'write', 'plugin_manager', 'bash', 'ops_bash']

/** 工具调用次数超过这个值，认为"反复折腾"，值得复核。 */
export const HEAVY_TOOL_THRESHOLD = 20

/**
 * 收集一轮的硬证据。
 *
 * 这些是**客观信号**，不依赖语义判断：
 *   - 有没有修改类工具被调用（说明有实际产出）
 *   - 工具调用次数（多说明反复折腾）
 *   - 结束原因（报错/中断/超长）
 *   - 该话题出现过几轮（多说明反复在改）
 *
 * @param lane - 泳道。
 * @param factOf - `(turn) => fact`。
 * @returns 证据对象。
 */
export function collectEvidence(lane, factOf) {
  const turns = Array.isArray(lane?.turns) ? lane.turns : []
  let mutatingCalls = 0
  let toolCalls = 0
  let steps = 0
  const errorTurns = []
  const seenTools = new Set()

  for (const t of turns) {
    const fact = factOf(t)
    if (fact === undefined || fact === null) continue
    toolCalls += Number(fact.toolCalls) || 0
    steps += Number(fact.steps) || 0
    for (const name of (Array.isArray(fact.tools) ? fact.tools : [])) {
      if (typeof name !== 'string') continue
      seenTools.add(name)
      if (MUTATING_TOOLS.includes(name)) mutatingCalls += 1
    }
    if (['error', 'max-tokens', 'aborted', 'interrupted', 'blocked'].includes(fact.endReason)) {
      errorTurns.push(t)
    }
  }

  return {
    turnCount: turns.length,
    toolCalls,
    steps,
    mutatingCalls,
    hasOutput: mutatingCalls > 0,
    errorTurns,
    hasError: errorTurns.length > 0,
    heavyTools: toolCalls >= HEAVY_TOOL_THRESHOLD,
    tools: [...seenTools],
  }
}

/**
 * 由硬证据推导一个基础状态（不调用模型）。
 *
 * 判定顺序刻意如此：
 *   - 有报错且之后没再改 → 阻塞（事情没做成）
 *   - 有实际产出（改过文件）+ 之后转向别的话题 → 已完成（做出来了才可能收尾）
 *   - 没产出但轮次多、工具多 → 进行中（在折腾）
 *   - 其余 → 待办/进行中
 *
 * @param lane - 泳道。
 * @param factOf - `(turn) => fact`。
 * @param ctx - `{ lastTurnInSession, supersededAfter }`。
 * @returns `{ state, basis, evidence, suspect }`。
 */
export function inferFromEvidence(lane, factOf, ctx = {}) {
  const turns = Array.isArray(lane?.turns) ? lane.turns : []
  if (turns.length === 0) {
    return {
      state: 'todo',
      basis: '没有轮次',
      evidence: collectEvidence(lane, factOf),
      suspect: false,
    }
  }

  const ev = collectEvidence(lane, factOf)
  const last = factOf(turns[turns.length - 1])
  const maxTurn = Math.max(...turns)
  const atTail = Number.isFinite(ctx.lastTurnInSession) && maxTurn >= ctx.lastTurnInSession
  const superseded = Number.isFinite(ctx.supersededAfter)

  // 最后一轮还没结束
  if (last !== undefined && last !== null && last.endReason === 'open') {
    return { state: 'active', basis: `最后一轮（T${last.turn}）仍在进行`, evidence: ev, suspect: false }
  }

  // 有报错：如果之后转向了别的话题，说明绕过去了但这条没成
  if (ev.hasError) {
    const which = ev.errorTurns.join('、')
    return {
      state: 'blocked',
      basis: `第 ${which} 轮报错或中断`,
      evidence: ev,
      // 报错但仍在反复尝试 -> 值得复核（可能后来解决了）
      suspect: ev.turnCount > 1 || !superseded,
    }
  }

  /**
   * 完成判定必须过三关，缺一不可：
   *
   * 1. 有产出（改过文件）——光讨论不算做完
   * 2. 之后转向了别的话题——没人再谈它了
   * 3. **之后没有再回来改它**——回来了说明还没成
   *
   * 第 3 条是这次新加的。实测发现：一个会话里几乎每轮都在写文件，
   * 于是"改过文件 + 之后转向"几乎对每条都成立，22 条里 21 条被判 done，
   * 完全没有区分度。真正的区别在于"后来有没有回头继续修"。
   */
  const cameBack = Number.isFinite(ctx.laterTurnsOfSameLane)
    ? ctx.laterTurnsOfSameLane > 0
    : false

  if (ev.hasOutput && superseded && !cameBack) {
    return {
      state: 'done',
      basis: `改过文件（${ev.mutatingCalls} 次写），之后转向别的话题且未再回头`,
      evidence: ev,
      // 反复出现多次、或工具调用很多 -> 可能只是"改了很多遍"而非真做完
      suspect: ev.turnCount > 2 || ev.heavyTools,
    }
  }

  // 有产出、也转向了，但后来又回来改 —— 说明当时没成
  if (ev.hasOutput && superseded && cameBack) {
    return {
      state: 'active',
      basis: `改过文件，但之后又回来继续处理（共 ${ctx.laterTurnsOfSameLane} 轮），尚未收尾`,
      evidence: ev,
      suspect: true,
    }
  }

  // 有产出但还在会话末尾
  if (ev.hasOutput && atTail) {
    return {
      state: 'active',
      basis: '有写操作，但位于会话末尾，可能还会继续',
      evidence: ev,
      suspect: false,
    }
  }

  // 没有产出：只是聊了
  if (!ev.hasOutput) {
    if (atTail) {
      return { state: 'active', basis: '位于会话末尾', evidence: ev, suspect: false }
    }
    return {
      state: 'active',
      basis: '没有写操作，只是讨论',
      evidence: ev,
      // 讨论很多轮却没有任何产出 -> 可疑（是不是该动手了）
      suspect: ev.turnCount > 2 || ev.heavyTools,
    }
  }

  return {
    state: 'active',
    basis: '有写操作但之后仍在延续',
    evidence: ev,
    suspect: ev.heavyTools,
  }
}

/**
 * 由一条泳道的轮次事实推导状态。
 *
 * 判据按优先级：
 *   - 最后一轮出错 / 超长 / 中断 → blocked（事情没做成）
 *   - 最后一轮仍在进行（open）→ active
 *   - 最后一轮正常结束，且**之后转向了新话题** → done（这一支告一段落）
 *   - 最后一轮正常结束，但之后仍是同一话题的延续 → active
 *   - 它就是会话末尾 → active（事情刚说完，不能断言完成）
 *
 * 为什么 done 需要"后续转向新话题"：
 *   上一版只要求"不在会话末尾"就算 done，结果一个 16 条任务的会话里
 *   16 条全是 done——因为每条后面都还有别的轮次。那样状态就没有区分度，
 *   失去了 PM 视角的意义。
 *
 *   真正说明"这件事做完了"的信号是：**后面的轮次不再谈它了**。
 *   所以判据改成"后续存在属于其他话题的轮次"。
 *
 * @param lane - 泳道（需 turns）。
 * @param factOf - `(turn) => fact`。
 * @param ctx - `{ lastTurnInSession, supersededAfter }`。
 *   `supersededAfter` 是该泳道最后一轮之后、属于**其他话题**的最小轮次号；
 *   没有则为 null。
 * @returns `{ state, inferred, basis }`。
 */
export function inferTaskState(lane, factOf, ctx = {}) {
  const turns = Array.isArray(lane?.turns) ? lane.turns : []
  if (turns.length === 0) {
    return { state: 'todo', inferred: true, basis: '没有轮次' }
  }

  const last = factOf(turns[turns.length - 1])
  if (last === undefined || last === null) {
    return { state: 'todo', inferred: true, basis: '找不到轮次事实' }
  }

  const reason = last.endReason
  if (reason === 'error') {
    return { state: 'blocked', inferred: true, basis: `最后一轮（T${last.turn}）报错` }
  }
  if (reason === 'max-tokens') {
    return { state: 'blocked', inferred: true, basis: `最后一轮（T${last.turn}）超出长度上限` }
  }
  if (reason === 'aborted' || reason === 'interrupted' || reason === 'blocked') {
    return { state: 'blocked', inferred: true, basis: `最后一轮（T${last.turn}）被中断` }
  }
  if (reason === 'open') {
    return { state: 'active', inferred: true, basis: `最后一轮（T${last.turn}）仍在进行` }
  }

  const maxTurn = Math.max(...turns)
  const lastTurnInSession = Number.isFinite(ctx.lastTurnInSession) ? ctx.lastTurnInSession : null

  // 会话末尾：事情刚说完，可能还会继续
  if (lastTurnInSession !== null && maxTurn >= lastTurnInSession) {
    return { state: 'active', inferred: true, basis: '位于会话末尾，可能还会继续' }
  }

  // 后面出现了别的话题 -> 这一支告一段落
  const superseded = Number.isFinite(ctx.supersededAfter) ? ctx.supersededAfter : null
  if (superseded !== null) {
    return {
      state: 'done',
      inferred: true,
      basis: `T${maxTurn} 之后（T${superseded} 起）转向了别的话题`,
    }
  }

  // 后面仍在谈这件事
  return { state: 'active', inferred: true, basis: `之后仍有同一话题的延续` }
}

/**
 * 判断每条泳道"是否被后续其他话题接管"，供状态推导使用。
 *
 * 做法：按时间扫描所有轮次，记录每条泳道最后一轮之后，第一个属于
 * **不同泳道**的轮次号。
 *
 * @param lanes - 泳道数组。
 * @returns Map<laneId, number|null>，值是接管轮次号，没有则为 null。
 */
export function computeSupersession(lanes) {
  const list = Array.isArray(lanes) ? lanes : []
  const out = new Map()

  // 轮次 -> 泳道
  const owner = new Map()
  for (const lane of list) {
    for (const t of (Array.isArray(lane.turns) ? lane.turns : [])) owner.set(t, lane.laneId)
  }

  for (const lane of list) {
    const turns = Array.isArray(lane.turns) ? lane.turns : []
    if (turns.length === 0) { out.set(lane.laneId, null); continue }
    const maxTurn = Math.max(...turns)
    let hit = null
    // 找最小的、大于 maxTurn 且属于别的泳道的轮次
    for (const t of owner.keys()) {
      if (t <= maxTurn) continue
      if (owner.get(t) === lane.laneId) continue
      if (hit === null || t < hit) hit = t
    }
    out.set(lane.laneId, hit)
  }
  return out
}

/**
 * 统计每条泳道"在中间断开之后又回来"的轮次数。
 *
 * 为什么需要它：判断"做完"的关键不是"有没有再提到"，而是**有没有回来继续改**。
 * 一个话题在第 3 轮说完、第 9 轮又回来改代码，说明当时并没做成。
 *
 * 做法：把该泳道的轮次按序看，凡是与上一个轮次不连续的，就算"回来一次"，
 * 并把这次之后新增的轮次数计进去。
 *
 * @param lanes - 泳道数组。
 * @returns Map<laneId, number>，表示该泳道末尾区段之后又追加的轮次数。
 */
export function computeComeBack(lanes) {
  const out = new Map()
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    const turns = (Array.isArray(lane.turns) ? [...lane.turns] : []).sort((a, b) => a - b)
    if (turns.length <= 1) { out.set(lane.laneId, 0); continue }

    // 找最后一个连续区段的起点：从末尾往前，只要相邻就继续
    let segStart = turns.length - 1
    while (segStart > 0 && turns[segStart] - turns[segStart - 1] === 1) segStart -= 1

    // 末尾区段之前还有轮次 => 曾经中断又回来过。
    // 计"回来之后新增了几轮"，作为"这次回来改了多少"的量化。
    const cameBack = segStart > 0
    out.set(lane.laneId, cameBack ? turns.length - segStart : 0)
  }
  return out
}

/**
 * 推导任务之间的依赖。
 *
 * 支持两类依据，都是**可解释**的：
 *
 * 1. `failure` —— A 的结尾不正常（报错/中断/超长），且 B 在 A 之后开始、
 *    属于同一话题。含义是"A 没做成，B 接着处理"。
 * 2. `sequence` —— A 与 B 属于同一工作流，且 A 的全部轮次都早于 B。
 *    含义是同一条工作线上的前后步骤。
 *
 * 为什么要有第 2 类：只看第 1 类时，一条顺利的会话会得到 0 条依赖
 * （因为没有任何失败），于是"依赖"这个视图永远是空的。而同工作流内的
 * 步骤先后是**真实存在的结构**——阶段/工作流本来就是按工作顺序拆的。
 *
 * 为什么不用"时间先后"当依赖：那会让整张图变成一条链，看不出真正的关系。
 * 所以限定在**同一工作流内**，且只连相邻两跳（前一个 → 这一个），不连
 * 所有祖先。
 *
 * @param lanes - 泳道数组。
 * @param factOf - `(turn) => fact`。
 * @param sameTopic - `(a, b) => boolean`，判断是否同一话题（默认同阶段）。
 * @returns `[{ from, to, kind, reason }]`。
 */
export function inferDependencies(lanes, factOf, sameTopic) {
  const list = Array.isArray(lanes) ? lanes : []
  const deps = []
  const seen = new Set()

  const push = (from, to, kind, reason) => {
    const key = from + '->' + to
    if (seen.has(key)) return
    seen.add(key)
    deps.push({ from, to, kind, reason })
  }

  // ── 1. 失败 → 后续接管 ──
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    const aTurns = Array.isArray(a.turns) ? a.turns : []
    if (aTurns.length === 0) continue
    const aLast = factOf(aTurns[aTurns.length - 1])
    if (aLast === undefined || aLast === null) continue

    const failed = ['error', 'max-tokens', 'aborted', 'interrupted', 'blocked'].includes(aLast.endReason)
    if (!failed) continue

    for (let j = 0; j < list.length; j += 1) {
      if (i === j) continue
      const b = list[j]
      const bTurns = Array.isArray(b.turns) ? b.turns : []
      if (bTurns.length === 0) continue
      if (Math.min(...bTurns) <= Math.max(...aTurns)) continue
      if (typeof sameTopic === 'function' && !sameTopic(a, b)) continue
      push(a.laneId, b.laneId, 'failure',
        `${a.title} 在 T${Math.max(...aTurns)} 未完成，${b.title} 接着处理`)
    }
  }

  // ── 2. 同工作流内的前后步骤 ──
  // 按工作流分组，组内按首个轮次排序，连相邻两条。
  const byWorkflow = new Map()
  for (const lane of list) {
    const wf = typeof lane.workflowName === 'string' && lane.workflowName !== ''
      ? lane.workflowName
      : null
    if (wf === null) continue
    if (!byWorkflow.has(wf)) byWorkflow.set(wf, [])
    byWorkflow.get(wf).push(lane)
  }
  for (const [wfName, group] of byWorkflow) {
    if (group.length < 2) continue
    const sorted = [...group].sort((x, y) => Math.min(...x.turns) - Math.min(...y.turns))
    for (let k = 1; k < sorted.length; k += 1) {
      const prev = sorted[k - 1]
      const cur = sorted[k]
      const prevMax = Math.max(...prev.turns)
      const curMin = Math.min(...cur.turns)
      if (curMin <= prevMax) continue
      push(prev.laneId, cur.laneId, 'sequence',
        `同在「${wfName}」：${prev.title} → ${cur.title}`)
    }
  }

  return deps
}

/**
 * 汇总一组任务的状态计数。
 *
 * @param lanes - 泳道数组。
 * @param stateOf - `(laneId) => state`。
 * @returns `{ todo, active, blocked, done, total }`。
 */
export function summarizeStates(lanes, stateOf) {
  const out = { todo: 0, active: 0, blocked: 0, done: 0, total: 0 }
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    const s = stateOf(lane.laneId)
    if (out[s] !== undefined) out[s] += 1
    out.total += 1
  }
  return out
}

/**
 * 把用户的手动覆盖叠加到推导结果上。
 *
 * 覆盖优先——用户看到的比推导准。但保留 `inferred` 标记，界面据此显示
 * "这是推导的"或"这是你标的"。
 *
 * @param inferred - `{ state, inferred, basis }`。
 * @param override - `'todo'|'active'|'blocked'|'done'` 或 undefined。
 * @returns `{ state, inferred, basis, overridden }`。
 */
export function applyOverride(inferred, override) {
  if (typeof override !== 'string' || !TASK_STATES.includes(override)) {
    return { ...inferred, overridden: false }
  }
  return {
    state: override,
    inferred: false,
    basis: '由你手动标注',
    overridden: true,
  }
}

/**
 * 阶段进度：以**计数**为主，百分比只是辅助。
 *
 * 为什么改成计数：百分比是推导值，加权公式（完成 1 / 进行中 0.5 / 阻塞 0.25）
 * 里的权重是我定的，不是用户定的。写"3/5 完成"是事实，
 * 写"60%"则需要接受我那套权重——前者更诚实。
 *
 * 百分比仍然返回，但只作为次要信息（且明确它由计数推算）。
 *
 * @param laneIds - 属于该阶段的任务。
 * @param stateOf - `(laneId) => state`。
 * @returns `{ done, total, percent, counts }`。
 */
export function stageProgress(laneIds, stateOf) {
  const ids = Array.isArray(laneIds) ? laneIds : []
  const counts = { todo: 0, active: 0, blocked: 0, done: 0, total: ids.length }
  if (ids.length === 0) return { done: 0, total: 0, percent: 0, counts }

  let score = 0
  for (const id of ids) {
    const s = stateOf(id)
    if (s === 'done') { score += 1; counts.done += 1 }
    else if (s === 'active') { score += 0.5; counts.active += 1 }
    else if (s === 'blocked') { score += 0.25; counts.blocked += 1 }
    else { counts.todo += 1 }
  }
  return {
    // 主信息：完成了几个 / 共几个。这是事实。
    done: counts.done,
    total: ids.length,
    // 次信息：加权百分比（权重建在 counts 之上，可解释）
    percent: Math.round(score / ids.length * 100),
    counts,
  }
}
