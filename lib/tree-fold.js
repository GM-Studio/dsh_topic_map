/**
 * 树形折叠与联动：决定哪些节点展开、如何定位路径。
 *
 * 为什么单独成模块：折叠状态是一张 Map，而"点节点时要展开哪些祖先"、
 * "筛选时哪些阶段该自动展开"这类推导很容易写错，且完全可以用纯函数验证。
 * 界面只负责把它渲染出来。
 *
 * 关键概念：
 *   - **折叠键**用名字而不是位置索引：重新分析后阶段顺序会变，用索引会把
 *     展开状态错位到别的节点上。
 *   - **路径**是从阶段到任务的链，点任意一处都要能算出完整链。
 *
 * @module dsh-topic-map/tree-fold
 */

/** 折叠键：阶段。 */
export function stageKey(name) {
  return 'S:' + name
}

/** 折叠键：工作流。 */
export function workflowKey(stageName, workflowName) {
  return 'S:' + stageName + ':W:' + workflowName
}

/**
 * 从 stages 结构里找出某个轮次所在的完整路径。
 *
 * @param stages - 阶段树。
 * @param turn - 轮次号。
 * @returns `{ stage, workflow, task }` 或 null。
 */
export function pathOfTurn(stages, turn) {
  for (const stage of Array.isArray(stages) ? stages : []) {
    for (const wf of stage.workflows ?? []) {
      for (const task of wf.tasks ?? []) {
        if (Array.isArray(task.turns) && task.turns.includes(turn)) {
          return { stage: stage.name, workflow: wf.name, task: task.name }
        }
      }
    }
  }
  return null
}

/**
 * 算出"只展开目标路径、收起其他阶段"的折叠状态。
 *
 * 为什么收起其他：一条会话可能有四五个阶段、十几个工作流。全都保持展开时
 * 点一个节点，目标仍然淹没在长列表里。收起其他阶段能让人立刻看到"我在哪"。
 *
 * @param stages - 阶段树。
 * @param path - `{ stage, workflow }`。
 * @returns 新的折叠状态对象（collapsed map）。
 */
export function foldToPath(stages, path) {
  const next = {}
  if (path === null || path === undefined) return next
  for (const stage of Array.isArray(stages) ? stages : []) {
    // 不是目标阶段的，整段收起
    if (stage.name !== path.stage) {
      next[stageKey(stage.name)] = true
      continue
    }
    // 目标阶段展开；其中不是目标工作流的收起
    for (const wf of stage.workflows ?? []) {
      if (wf.name !== path.workflow) {
        next[workflowKey(stage.name, wf.name)] = true
      }
    }
  }
  return next
}

/**
 * 全部展开：清空折叠状态。
 * @returns 空对象。
 */
export function expandAll() {
  return {}
}

/**
 * 全部折叠：收起所有阶段与工作流。
 *
 * 注意：只标记"阶段"就够了——阶段收起后其下工作流不渲染，
 * 再标记工作流会让"之后手动展开阶段"时发现子项也是折叠的，体验很怪。
 *
 * @param stages - 阶段树。
 * @returns 折叠状态。
 */
export function collapseAll(stages) {
  const next = {}
  for (const stage of Array.isArray(stages) ? stages : []) {
    next[stageKey(stage.name)] = true
  }
  return next
}

/**
 * 只看阶段：展开阶段，收起其下所有工作流。
 *
 * @param stages - 阶段树。
 * @returns 折叠状态。
 */
export function collapseToStages(stages) {
  const next = {}
  for (const stage of Array.isArray(stages) ? stages : []) {
    for (const wf of stage.workflows ?? []) {
      next[workflowKey(stage.name, wf.name)] = true
    }
  }
  return next
}

/**
 * 默认状态：展开阶段与工作流，只收起任务层。
 *
 * 这里复用"任务层不收"的语义——当前实现里任务没有独立折叠键，
 * 所以返回"只收起无"实际上就是全展开。保留这个函数是为了让默认值
 * 有一处显式定义，将来若给任务加折叠只需改这里。
 *
 * @returns 空折叠状态。
 */
export function defaultFold() {
  return {}
}

/**
 * 筛选联动：自动展开"有可见任务"的阶段与工作流，收起没有的。
 *
 * 为什么需要：筛选后如果命中的任务藏在一个收起的阶段里，用户会以为
 * 筛选坏了（明明显示 3/16，却看不到东西）。
 *
 * @param stages - 阶段树。
 * @param visibleTaskNames - Set，可见任务名。
 * @param taskKeyOf - `(task) => string`，取任务标识（默认用 name）。
 * @returns 折叠状态。
 */
export function foldForFilter(stages, visibleTaskNames, taskKeyOf) {
  const visible = visibleTaskNames instanceof Set ? visibleTaskNames : new Set()
  const idOf = typeof taskKeyOf === 'function' ? taskKeyOf : (t => t.name)
  const next = {}

  for (const stage of Array.isArray(stages) ? stages : []) {
    let stageHasVisible = false
    for (const wf of stage.workflows ?? []) {
      const wfVisible = (wf.tasks ?? []).some(t => visible.has(idOf(t)))
      if (wfVisible) {
        stageHasVisible = true
        // 有可见任务的工作流：不写折叠标记 = 展开
      } else {
        next[workflowKey(stage.name, wf.name)] = true
      }
    }
    if (!stageHasVisible) next[stageKey(stage.name)] = true
  }
  return next
}

/**
 * 判断某阶段是否展开。
 * @param collapsed - 折叠状态。
 * @param name - 阶段名。
 */
export function isStageOpen(collapsed, name) {
  return collapsed === null || collapsed === undefined ? true : collapsed[stageKey(name)] !== true
}

/** 判断某工作流是否展开。 */
export function isWorkflowOpen(collapsed, stageName, workflowName) {
  if (collapsed === null || collapsed === undefined) return true
  if (collapsed[stageKey(stageName)] === true) return false
  return collapsed[workflowKey(stageName, workflowName)] !== true
}

/**
 * 统计展开状态，供按钮显示当前模式。
 *
 * @param stages - 阶段树。
 * @param collapsed - 折叠状态。
 * @returns 'all' | 'none' | 'stages' | 'mixed'
 */
export function foldMode(stages, collapsed) {
  const list = Array.isArray(stages) ? stages : []
  if (list.length === 0) return 'all'

  const c = collapsed ?? {}
  const stageClosed = list.every(s => c[stageKey(s.name)] === true)
  if (stageClosed) return 'none'

  const allStageOpen = list.every(s => c[stageKey(s.name)] !== true)
  if (allStageOpen) {
    const anyWfOpen = list.some(s =>
      (s.workflows ?? []).some(w => c[workflowKey(s.name, w.name)] !== true))
    return anyWfOpen ? 'all' : 'stages'
  }
  return 'mixed'
}
