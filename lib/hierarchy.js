/**
 * 三层分级：阶段 → 工作流 → 任务 → 轮次。
 *
 * 三次调用逐层向上归并，而不是一次让模型输出整棵树：
 *
 * - 一次输出整棵树，模型容易编错长度与嵌套，且一处错位整张图就乱；
 * - 逐层归并每步只做一件事（把 N 项分成几组），每步都能独立校验长度；
 * - 某层失败时只退到"该层不存在"，上下层仍然可用——不会整棵树作废。
 *
 * 允许只有两层：内容不支持时，阶段下直接挂任务，不为了凑数硬造工作流。
 *
 * @module dsh-topic-map/hierarchy
 */

import { extractJsonArray, extractJsonArrayOfLength, extractJsonField } from './model-output.js'

/** 阶段数量的建议区间。 */
export const STAGE_RANGE = [2, 4]

/** 每个阶段下的工作流数量上限。 */
export const WORKFLOWS_PER_STAGE = 3

/** 每条描述在提示词里的预算（字符）。 */
const DESC_BUDGET = 120

/** 截断。 */
function clip(text, budget) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length <= budget ? s : `${s.slice(0, budget - 1)}…`
}

/**
 * 构造"归并上一层"的提示词。
 *
 * 同一套提示词用于两次归并（任务→工作流、工作流→阶段），只换措辞与数量建议。
 * 每次都给模型**每项的名字与内容摘要**——只给名字是上一版的缺陷：短词没有
 * 上下文，模型只能凭字面猜，所以分得不准。
 *
 * @param items - `[{ id, name, sample }]`，name 是标题，sample 是内容摘要。
 * @param level - `'workflow'` 或 `'stage'`。
 * @param suggestion - 数量建议，写进提示词。
 * @returns `{ system, user }`。
 */
export function buildMergePrompt(items, level, suggestion) {
  const what = level === 'stage' ? '阶段' : '工作流'
  const system = [
    `你在帮助把一串条目归并成少数几个${what}。`,
    level === 'stage'
      ? '每个阶段代表一件相对完整的事，例如某个功能的设计、某次故障的排查、某个子系统的重构。'
      : '每个工作流代表一个阶段内的一个部分，例如「面板架构」「数据结构」「渲染」。',
    suggestion,
    '规则：',
    `- 条目是${what}的细分，不要把每一条都单独立成一个${what}；`,
    `- ${what}的名字要能概括组内所有条目，用 4-8 个字；`,
    level === 'workflow'
      ? '- 工作流是阶段的下级，名字要比阶段更具体（例如阶段「地图开发」下有工作流「渲染」「交互」），不要与阶段同名；'
      : '- 阶段之间要有明显区分，不要出现两个意思相近的阶段；',
    '- 按「哪几条其实在讲同一件事」判断，不要只看字面；',
    '- 摘要里写的是该条目实际在做什么，以它为准。',
    '只输出 JSON 数组，长度与条目数一致，元素是该条目所属的' + what + '名字，不要解释。',
  ].join('\n')

  const body = items.map((item, i) => {
    const sample = clip(item.sample, DESC_BUDGET)
    return `${i + 1}. ${item.name}` + (sample === '' ? '' : `\n   摘要：${sample}`)
  }).join('\n')

  return {
    system,
    user: `以下是按时间排列的 ${items.length} 个条目：\n\n${body}\n\n请输出长度 ${items.length} 的 JSON 字符串数组，每个元素是该条目所属${what}的名字。`,
  }
}

/**
 * 解析归并结果。
 *
 * 与其它层同样严格：长度不符整批作废。错位的分组比"没有分组"更糟。
 *
 * @param text - 模型输出。
 * @param expected - 条目数。
 * @returns 名字数组，或 null。
 */
export function parseMerge(text, expected) {
  // 共享抽取器：容忍"先说思路带方括号、再给答案"的输出。
  const parsed = extractJsonArrayOfLength(text, expected)
  if (parsed === null) return null
  const out = []
  for (const item of parsed) {
    if (typeof item !== 'string' || item.trim() === '') return null
    out.push(item.trim())
  }
  return out
}

/**
 * 按名字归组，保持首次出现顺序。
 *
 * @param items - `[{ id, ... }]`。
 * @param names - 与 items 等长的名字。
 * @returns `[{ name, ids, firstIndex }]`。
 */
export function groupByName(items, names) {
  if (!Array.isArray(items) || !Array.isArray(names) || items.length !== names.length) return []
  const order = []
  const groups = new Map()
  items.forEach((item, i) => {
    const name = names[i]
    if (!groups.has(name)) {
      groups.set(name, { name, ids: [], firstIndex: i })
      order.push(name)
    }
    groups.get(name).ids.push(item.id)
  })
  return order.map(name => groups.get(name))
}

/**
 * 组数超过上限时，把最小的几组并入「其他」。
 *
 * 上限存在的理由：层级一旦变成第二份平铺列表就失去意义。
 *
 * @param groups - `groupByName` 的输出。
 * @param max - 上限。
 * @returns 合并后的分组，按首次出现排序。
 */
export function capGroups(groups, max) {
  if (!Array.isArray(groups) || groups.length <= max) return groups
  const sorted = [...groups].sort((a, b) => b.ids.length - a.ids.length)
  const keep = sorted.slice(0, max - 1)
  const rest = sorted.slice(max - 1)
  if (rest.length === 0) return keep
  const merged = { name: '其他', ids: [], firstIndex: Infinity }
  for (const g of rest) {
    merged.ids.push(...g.ids)
    if (g.firstIndex < merged.firstIndex) merged.firstIndex = g.firstIndex
  }
  const out = [...keep, merged]
  out.sort((a, b) => a.firstIndex - b.firstIndex)
  return out
}

/**
 * 把三轮归并结果组装成树。
 *
 * 结构：
 *   stages[]         阶段
 *     workflows[]    工作流（可能为空 —— 允许只有两层）
 *       tasks[]      任务
 *         turns[]    轮次
 *
 * 若工作流层缺失（`workflowNames === null`），任务直接挂在阶段下，并把
 * `twoLevel` 置为 true，让客户端知道不要渲染空的工作流层。
 *
 * @param tasks - `[{ id, name, turns }]`，按时间序。
 * @param workflowNames - 每个任务的所属工作流名，或 null（跳过该层）。
 * @param stageNames - 每个工作流（或任务）的所属阶段名。
 * @returns `{ stages, twoLevel }`。
 */
export function buildTree(tasks, workflowNames, stageNames) {
  if (!Array.isArray(tasks) || tasks.length === 0) return { stages: [], twoLevel: false }

  const twoLevel = !Array.isArray(workflowNames) || workflowNames.length !== tasks.length

  // 第二层：任务 → 工作流（两层时，每个任务自己就是一个第二层槽位）。
  //
  // 用**下标**而不是名字把层级串起来：任务名可能重复（模型给出两个同名任务
  // 是很常见的），按名字查找会把它们错并成一个。
  const midNames = twoLevel ? tasks.map(t => t.name) : workflowNames

  // 先把"下标 → 名字"归组，得到每个工作流包含哪些任务下标。
  const workflowGroups = groupByName(
    tasks.map((_, i) => ({ id: String(i) })),
    midNames,
  )

  const tasksOfGroup = g => g.ids
    .map(id => tasks[Number(id)])
    .filter(Boolean)
    .map(t => ({ name: t.name, turns: [...t.turns] }))

  /**
   * 阶段层的期望长度。
   *
   * 两层模式下没有工作流层，阶段直接管任务，因此阶段名应与**任务**等长；
   * 三层模式下阶段管工作流，与**工作流数**等长。搞错这个会得到一棵层级
   * 错位的树——阶段里装着本该是工作流的东西。
   */
  const expectedStageNames = twoLevel ? tasks.length : workflowGroups.length

  // 第三层：工作流 → 阶段。
  if (!Array.isArray(stageNames) || stageNames.length !== expectedStageNames) {
    // 阶段层不可用：退化成"全部"一个阶段，下层仍然完整保留。
    return {
      stages: [{
        name: '全部',
        workflows: workflowGroups.map(g => ({ name: g.name, tasks: tasksOfGroup(g) })),
        turns: tasks.flatMap(t => t.turns).sort((a, b) => a - b),
      }],
      twoLevel,
    }
  }

  const stageGroups = groupByName(
    workflowGroups.map((_, i) => ({ id: String(i) })),
    stageNames,
  )
  const stages = stageGroups.map(sg => {
    const workflows = sg.ids.map(id => {
      const g = workflowGroups[Number(id)]
      return { name: g.name, tasks: tasksOfGroup(g) }
    }).filter(wf => wf.tasks.length > 0)

    // 阶段下只有一个工作流、且两者同名时，这层是冗余的：把它折平，
    // 任务直接挂在阶段下。硬留一层只会让人看到"阶段 X → 工作流 X"。
    const collapsed = workflows.length === 1 && workflows[0].name === sg.name
    const effective = collapsed
      ? [{ name: sg.name, tasks: workflows[0].tasks, collapsed: true }]
      : workflows

    const turns = effective.flatMap(wf => wf.tasks.flatMap(t => t.turns)).sort((a, b) => a - b)
    return { name: sg.name, workflows: effective, turns }
  }).filter(s => s.workflows.length > 0)

  return { stages, twoLevel }
}

/**
 * 从树里取出"每个轮次属于哪个任务"，供泳道渲染使用。
 *
 * @param stages - `buildTree` 的结果。
 * @returns Map<turn, { stage, workflow, task }>。
 */
export function turnPathIndex(stages) {
  const index = new Map()
  for (const stage of Array.isArray(stages) ? stages : []) {
    for (const wf of stage.workflows ?? []) {
      for (const task of wf.tasks ?? []) {
        for (const turn of task.turns ?? []) {
          index.set(turn, { stage: stage.name, workflow: wf.name, task: task.name })
        }
      }
    }
  }
  return index
}

/**
 * 树形结构的自检：每个轮次只出现一次、层级完整。
 *
 * 用断言而不是默默容忍：一颗有重复或遗漏的树画出来必然错位，
 * 早点失败比画错强。
 *
 * @param tree - `buildTree` 的结果。
 * @returns 问题列表，空数组表示健康。
 */
export function validateTree(tree) {
  const problems = []
  if (!tree || !Array.isArray(tree.stages)) {
    problems.push('树结构缺失')
    return problems
  }

  const seen = new Map()
  for (const stage of tree.stages) {
    if (typeof stage.name !== 'string' || stage.name === '') problems.push('阶段缺少名字')
    if (!Array.isArray(stage.workflows) || stage.workflows.length === 0) {
      problems.push(`阶段「${stage.name}」没有工作流`)
      continue
    }
    for (const wf of stage.workflows) {
      if (typeof wf.name !== 'string' || wf.name === '') problems.push(`阶段「${stage.name}」下有工作流缺少名字`)
      if (!Array.isArray(wf.tasks) || wf.tasks.length === 0) {
        problems.push(`工作流「${wf.name}」没有任务`)
        continue
      }
      for (const task of wf.tasks) {
        if (!Array.isArray(task.turns) || task.turns.length === 0) {
          problems.push(`任务「${task.name}」没有轮次`)
          continue
        }
        for (const turn of task.turns) {
          if (seen.has(turn)) {
            problems.push(`轮次 ${turn} 同时出现在「${seen.get(turn)}」与「${task.name}」`)
          } else {
            seen.set(turn, task.name)
          }
        }
      }
    }
  }
  return problems
}
