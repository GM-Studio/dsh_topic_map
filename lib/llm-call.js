/**
 * 模型调用：把一个边界判定变成一次 LLM 请求。
 *
 * 与业务判断分离：本文件只管"问一次模型并拿到文本"，怎么用这个答案
 * 由 semantic.js 决定。这样测试时可以替换掉模型，逻辑仍可验证。
 *
 * @module dsh-topic-map/llm-call
 */

/**
 * 用 llm 服务问一次，返回模型输出的全文。
 *
 * 走 `prepareCall` + `stream`：这是 harness 的标准调用路径，会带上该路由
 * 的适配器与默认参数。只累积 text 类增量，reasoning 与工具调用都丢掉——
 * 这里要的只是一个词。
 *
 * @param llm - `ctx.llm` 服务。
 * @param config - `{ provider, model }`。
 * @param system - 系统提示。
 * @param user - 用户消息。
 * @param signal - 取消信号。
 * @param limits - 可选 `{ maxTokens }`，覆盖默认输出预算。
 * @returns 模型输出的文本；调用失败时抛出。
 */
export async function askOnce(llm, config, system, user, signal, limits = {}) {
  if (llm === undefined || llm === null) throw new Error('llm service unavailable')

  const maxTokens = Number.isFinite(limits.maxTokens) && limits.maxTokens > 0
    ? Math.min(4096, Math.floor(limits.maxTokens))
    : 32

  const call = {
    provider: config.provider,
    model: config.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    system,
    // 分类/标注任务不需要发散。
    temperature: 0,
    maxTokens,
    signal,
  }

  const prepared = await llm.prepareCall(call, signal)

  const chunks = []
  for await (const chunk of prepared.stream(call)) {
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      chunks.push(chunk.text)
    }
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') {
      // 失败要显式抛出：调用方需要区分"模型给了答案"和"模型没说话"。
      const reason = chunk.reason
      if (reason !== null && typeof reason === 'object' && (reason.kind === 'error' || reason.kind === 'aborted')) {
        const failure = reason.failure
        throw new Error(failure && failure.message ? failure.message : `model ${reason.kind}`)
      }
    }
  }
  return chunks.join('')
}

/**
 * 分段结果的持有者。
 *
 * 刻意做成"显式替换"：本地结果与模型结果分开存放，界面上可以来回切换，
 * 不会因为一次失败的调用把已经调好的图弄丢。
 */
/**
 * 分段结果的持有者，带磁盘持久化。
 *
 * 为什么必须落盘：分段结果只存内存时，切换会话（面板卸载）再切回来就退回
 * 本地规则——用户花了 token 调出来的精细结构白费了。这个 bug 在实测里
 * 表现为「采纳后 lanes 11 → 重新打开变成 14」。
 *
 * 存放位置：`<DSH home>/topic-map/segments/<sessionId>.json`。
 * 放在 home 而不是插件目录，避免污染源码工作区。
 */
export class SegmentStore {
  /** @type {Map<string, object>} */
  #bySession = new Map()

  /** @type {Map<string, Promise<void>>} 每会话一个写队列，避免并发覆盖。 */
  #writes = new Map()

  /**
   * @param rootDir - 存放目录；省略则纯内存（测试用）。
   */
  constructor(rootDir = null) {
    this.rootDir = rootDir
  }

  /** 某会话的持久化文件路径。 */
  #pathFor(sessionId) {
    if (this.rootDir === null || typeof this.rootDir !== 'string' || this.rootDir === '') return null
    // 会话 id 里可能出现路径分隔符，替换掉以防写出目录之外。
    const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')
    return `${this.rootDir}/${safe}.json`
  }

  /**
   * 从磁盘恢复某会话的分段。
   *
   * 只在内存里**没有**有效 semantic 时才读盘：内存版本是本进程最新的
   * （可能刚采纳过），用磁盘覆盖它会把刚做的操作冲掉。反过来，若内存里
   * 只有一份不含 semantic 的残留记录，那它不该挡住读盘——所以判断条件是
   * "有 semantic"，而不是单纯"有这个键"。上一版正是用 `has()` 判断，
   * 于是一份空记录就永久屏蔽了磁盘上的正确结构。
   *
   * @param sessionId - 会话。
   * @param readFile - 注入的读文件函数（避免在浏览器半依赖 node:fs）。
   * @returns 是否可用（内存或磁盘任一有 semantic）。
   */
  async hydrate(sessionId, readFile) {
    const existing = this.#bySession.get(sessionId)
    if (existing !== undefined && existing.semantic !== undefined) return true

    const path = this.#pathFor(sessionId)
    if (path === null || typeof readFile !== 'function') return existing !== undefined
    try {
      const text = await readFile(path, 'utf8')
      const data = JSON.parse(text)
      if (data && typeof data === 'object' && data.semantic !== undefined) {
        this.#bySession.set(sessionId, data)
        return true
      }
      if (existing === undefined && data && typeof data === 'object') {
        this.#bySession.set(sessionId, data)
      }
    } catch {
      // 文件不存在或损坏：都当作"没有保存过"。
    }
    return existing !== undefined
  }

  /** 排队写盘。 */
  #persist(sessionId, writeFile, mkdir, dirname) {
    const path = this.#pathFor(sessionId)
    if (path === null || typeof writeFile !== 'function') return
    const data = this.#bySession.get(sessionId)
    const prev = this.#writes.get(sessionId) ?? Promise.resolve()
    const next = prev.then(async () => {
      try {
        if (typeof mkdir === 'function' && typeof dirname === 'function') {
          await mkdir(dirname(path), { recursive: true })
        }
        await writeFile(path, JSON.stringify(data), 'utf8')
      } catch {
        // 写不进去只影响"下次能否恢复"，不影响本次使用。
      }
    })
    this.#writes.set(sessionId, next)
  }

  /**
   * 绑定持久化能力（由 Host 在挂载时注入 node:fs 函数）。
   * @param io - `{ writeFile, mkdir, dirname }`。
   */
  bindPersistence(io) {
    this.io = io
  }

  /** 触发一次写盘。 */
  #save(sessionId) {
    if (this.io === undefined) return
    this.#persist(sessionId, this.io.writeFile, this.io.mkdir, this.io.dirname)
  }

  /**
   * 读取某会话当前生效的分段。
   * @param sessionId - 会话。
   * @returns 记录，或 undefined。
   */
  get(sessionId) {
    return this.#bySession.get(sessionId)
  }

  /**
   * 记录一份"待确认"的模型结果。
   *
   * 不直接生效——界面需要先展示预览，用户点确认才切换。
   *
   * @param sessionId - 会话。
   * @param pending - 模型给出的分段。
   */
  setPending(sessionId, pending) {
    const current = this.#bySession.get(sessionId) ?? {}
    this.#bySession.set(sessionId, { ...current, pending })
    // 待确认结果也存下来：分析可能要几十秒，用户中途切走不该白算。
    this.#save(sessionId)
  }

  /**
   * 采纳待确认结果。
   *
   * @param sessionId - 会话。
   * @param localSnapshot - 采纳前的本地分段（保留以便回退）。
   */
  applyPending(sessionId, localSnapshot) {
    const current = this.#bySession.get(sessionId)
    if (current === undefined || current.pending === undefined) return undefined
    const applied = { semantic: current.pending, localSnapshot, appliedAt: Date.now() }
    this.#bySession.set(sessionId, applied)
    this.#save(sessionId)
    return applied.semantic
  }

  /**
   * 丢弃模型结果，回到本地规则。
   * @param sessionId - 会话。
   */
  revert(sessionId) {
    this.#bySession.delete(sessionId)
  }

  /**
   * 当前生效的是否为模型结果。
   * @param sessionId - 会话。
   * @returns 是否。
   */
  isSemantic(sessionId) {
    const current = this.#bySession.get(sessionId)
    return current !== undefined && current.semantic !== undefined
  }
}
