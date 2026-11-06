/**
 * 分析进度：后台任务的分步状态。
 *
 * 为什么需要它：精细化分析要连调三次模型（任务分割 → 工作流归并 → 阶段归并），
 * 耗时几十秒。同步请求期间界面只能显示一个转圈，用户不知道卡在哪一步，
 * 也不知道还要等多久。
 *
 * 设计取舍：
 *   - **分步而不是百分比**：三次调用的耗时差别很大（第一次要读全部轮次），
 *     任何百分比都是编的。而"正在做第 2 步"是事实。
 *   - **进度放 Host 内存**：它是短生命周期的运行时状态，不值得落盘；
 *     进程重启就没了，而那时分析本来也已经中断。
 *
 * @module dsh-topic-map/progress
 */

/**
 * 分析的固定步骤。顺序即执行顺序。
 *
 * 只剩两步：原来还有「归并工作流」「归并阶段」，但它们的结果是为左栏
 * 三层树服务的——左栏改成跨会话分类列表后，那棵树不再展示，
 * 再多跑两次模型只是白烧 token 与时间。
 */
export const ANALYSIS_STEPS = [
  { id: 'segment', label: '划分话题', detail: '读取对话，把轮次切成话题段' },
  { id: 'merge', label: '合并同类', detail: '把其实是同一件事的话题并回去' },
]

/** 一次分析的完整生命周期状态。 */
export const RUN_STATUS = {
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
}

/**
 * 建一份新的运行记录。
 *
 * @param sessionId - 会话。
 * @param now - 当前时间戳（便于测试注入）。
 * @returns 运行记录。
 */
export function startRun(sessionId, now = Date.now()) {
  return {
    sessionId,
    status: RUN_STATUS.running,
    // 当前正在做第几步（0 基）。完成全部后等于步骤数。
    step: 0,
    stepId: ANALYSIS_STEPS[0].id,
    label: ANALYSIS_STEPS[0].label,
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    error: null,
    /** 各步完成情况：id -> 'pending' | 'active' | 'done' | 'failed' */
    steps: Object.fromEntries(ANALYSIS_STEPS.map(s => [s.id, 'pending'])),
  }
}

/**
 * 推进到某一步。
 *
 * @param run - 运行记录。
 * @param stepId - 步骤 id。
 * @param now - 时间戳。
 * @returns 新的运行记录（不修改入参）。
 */
export function advanceRun(run, stepId, now = Date.now()) {
  if (run === null || run === undefined) return run
  const index = ANALYSIS_STEPS.findIndex(s => s.id === stepId)
  if (index < 0) return run

  const steps = { ...run.steps }
  // 之前的所有步骤标记完成，当前标记进行中
  for (let i = 0; i < index; i += 1) {
    const id = ANALYSIS_STEPS[i].id
    if (steps[id] !== 'failed') steps[id] = 'done'
  }
  steps[stepId] = 'active'

  return {
    ...run,
    step: index,
    stepId,
    label: ANALYSIS_STEPS[index].label,
    steps,
    updatedAt: now,
  }
}

/**
 * 结束一次运行。
 *
 * @param run - 运行记录。
 * @param status - done / failed / cancelled。
 * @param error - 失败原因。
 * @param now - 时间戳。
 * @returns 新的运行记录。
 */
export function finishRun(run, status, error = null, now = Date.now()) {
  if (run === null || run === undefined) return run
  const steps = { ...run.steps }
  if (status === RUN_STATUS.done) {
    for (const s of ANALYSIS_STEPS) steps[s.id] = 'done'
  } else if (run.stepId !== null && steps[run.stepId] === 'active') {
    steps[run.stepId] = 'failed'
  }
  return {
    ...run,
    status,
    steps,
    step: status === RUN_STATUS.done ? ANALYSIS_STEPS.length : run.step,
    label: status === RUN_STATUS.done ? '完成' : run.label,
    finishedAt: now,
    updatedAt: now,
    error: error === null ? null : String(error).slice(0, 200),
  }
}

/**
 * 把运行记录转成给界面看的视图。
 *
 * 只暴露界面需要的东西：不透露内部 bookkeeping，也不泄露完整错误栈。
 *
 * @param run - 运行记录。
 * @param now - 当前时间。
 * @returns 视图对象。
 */
export function runView(run, now = Date.now()) {
  if (run === null || run === undefined) {
    return { active: false, status: 'idle', steps: [], elapsedMs: 0 }
  }
  const elapsedMs = Math.max(0, now - run.startedAt)
  return {
    active: run.status === RUN_STATUS.running,
    status: run.status,
    currentStep: run.step,
    currentLabel: run.label,
    steps: ANALYSIS_STEPS.map((s, i) => ({
      id: s.id,
      label: s.label,
      detail: s.detail,
      state: run.steps[s.id] ?? 'pending',
      index: i,
    })),
    totalSteps: ANALYSIS_STEPS.length,
    elapsedMs,
    error: run.error,
  }
}

/**
 * 是否还在合理时间内。
 *
 * 用于界面判断"是不是卡住了"：三次调用正常 10-60 秒，超过 5 分钟基本
 * 可以认为出问题了（网络挂住、模型不响应）。
 *
 * @param run - 运行记录。
 * @param now - 当前时间。
 * @param limitMs - 上限。
 * @returns 是否超时。
 */
export function isStale(run, now = Date.now(), limitMs = 5 * 60 * 1000) {
  if (run === null || run === undefined) return false
  if (run.status !== RUN_STATUS.running) return false
  return now - run.startedAt > limitMs
}

/**
 * 运行记录的持有者：按会话存，只留最新一份。
 *
 * 为什么只留最新：界面只关心"当前这次分析"；历史运行记录没有查看入口，
 * 留着只会让内存无限增长。
 */
export class ProgressStore {
  #bySession = new Map()

  /** 读取某会话的运行记录。 */
  get(sessionId) {
    return this.#bySession.get(sessionId)
  }

  /** 开始一次运行。 */
  start(sessionId, now = Date.now()) {
    const run = startRun(sessionId, now)
    this.#bySession.set(sessionId, run)
    return run
  }

  /** 更新运行记录。 */
  set(sessionId, run) {
    this.#bySession.set(sessionId, run)
    return run
  }

  /** 清除（用于取消）。 */
  clear(sessionId) {
    this.#bySession.delete(sessionId)
  }
}
