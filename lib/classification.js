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
  if (missing.length) lanes.push({
    laneId: `${sessionId}:unassigned`, title: '待归类', taskName: '待归类',
    stageName: '待归类', workflowName: '待归类', category: '待归类',
    turns: missing.map(t => t.turn), sharedTurns: [], segments: [], subtopics: [],
    parentLaneId: null, origin: 'unassigned', confidence: 0,
  })
  return { lanes, stages: stagesFromLanes(lanes), unclassifiedTurns: missing.map(t => t.turn) }
}

/** Build the tree from stable lane identities, never from regenerated titles. */
export function stagesFromLanes(lanes) {
  const stages = new Map()
  for (const lane of lanes) {
    const stageName = lane.stageName || '待归类'
    const workflowName = lane.workflowName || stageName
    if (!stages.has(stageName)) stages.set(stageName, { name: stageName, workflows: [], turns: [] })
    const stage = stages.get(stageName)
    let workflow = stage.workflows.find(w => w.name === workflowName)
    if (!workflow) { workflow = { name: workflowName, tasks: [], collapsed: workflowName === stageName }; stage.workflows.push(workflow) }
    workflow.tasks.push({ id: lane.laneId, name: lane.title, turns: [...lane.turns] })
    stage.turns.push(...lane.turns)
  }
  for (const stage of stages.values()) stage.turns = [...new Set(stage.turns)].sort((a, b) => a - b)
  return [...stages.values()]
}
