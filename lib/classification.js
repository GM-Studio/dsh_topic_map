/** Reconcile saved classification against the current, authoritative turn set. */
export function reconcileClassification(turns, savedLanes, sessionId) {
  const valid = new Set(turns.map(t => t.turn))
  const claimed = new Set()
  const lanes = []
  for (const saved of savedLanes ?? []) {
    const own = (saved.turns ?? []).filter(t => valid.has(t) && !claimed.has(t))
    if (!own.length) continue
    own.forEach(t => claimed.add(t))
    lanes.push({ ...saved, turns: own, sharedTurns: (saved.sharedTurns ?? []).filter(t => valid.has(t)) })
  }
  const missing = turns.filter(t => !claimed.has(t.turn))
  if (missing.length) {
    // 这批轮次是"上次精化分析之后新产生的对话"——分析覆盖不到它们，
    // 所以要单独成组。
    //
    // 三层用不同名字：之前阶段/工作流/任务全叫"待归类"，折平渲染后
    // 只剩一行同名的任务，看起来像"这个阶段下面什么都没有"。
    const first = missing[0].turn
    const last = missing[missing.length - 1].turn
    const span = missing.length === 1 ? `第 ${first} 轮` : `第 ${first}–${last} 轮`
    lanes.push({
      laneId: `${sessionId}:unassigned`,
      title: `新增未归类（${span}）`,
      taskName: `新增对话 ${missing.length} 轮`,
      stageName: '新增未归类',
      workflowName: '上次分析之后',
      category: '新增未归类',
      turns: missing.map(t => t.turn), sharedTurns: [], segments: [], subtopics: [],
      parentLaneId: null, origin: 'unassigned', confidence: 0,
    })
  }
  return { lanes, stages: stagesFromLanes(lanes), unclassifiedTurns: missing.map(t => t.turn) }
}

/** Build the tree from stable lane identities, never from regenerated titles. */
export function stagesFromLanes(lanes) {
  const stages = new Map()
  for (const lane of lanes) {
    const stageName = lane.stageName || '未分类'
    const workflowName = lane.workflowName || stageName
    if (!stages.has(stageName)) {
      stages.set(stageName, {
        name: stageName,
        workflows: [],
        turns: [],
        // 标记"这批是分析之后的新对话"：客户端据此显示"点此归类"，
        // 并把它排在最后（它是新东西，不该插在已经理好的结构中间）。
        isUnclassified: lane.origin === 'unassigned',
      })
    }
    const stage = stages.get(stageName)
    let workflow = stage.workflows.find(w => w.name === workflowName)
    if (!workflow) { workflow = { name: workflowName, tasks: [], collapsed: workflowName === stageName }; stage.workflows.push(workflow) }
    workflow.tasks.push({ id: lane.laneId, name: lane.title, turns: [...lane.turns] })
    stage.turns.push(...lane.turns)
  }
  for (const stage of stages.values()) stage.turns = [...new Set(stage.turns)].sort((a, b) => a - b)
  // 未归类阶段放最后：它是"还没整理的新内容"，排在中间会打断阅读
  const out = [...stages.values()]
  out.sort((a, b) => (a.isUnclassified === b.isUnclassified ? 0 : a.isUnclassified ? 1 : -1))
  return out
}
