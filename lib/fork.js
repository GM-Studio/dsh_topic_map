/**
 * 分叉 / 重试的纯逻辑与端点编排（不直接依赖 Cordis ctx）。
 *
 * 宿主契约（已从 asar 核实，见 README/报告）：
 * - `sessionController.fork({sessionId, atSeq?, allowMigration?})`
 *   → `{sessionId}`；`atSeq` 是 **exact inclusive source event seq**；
 * - `sessionController.prompt({requestId, sessionId, mode, content})`
 *   → `{accepted:true}`；
 * - `sessionController.rename({sessionId, title})`。
 *
 * 本模块只做四类事：参数归一、`atSeq` 计算、宿主错误 → 中文错误映射、
 * 5 分钟去重。真正 I/O（读轮次、调宿主、生成 requestId）全部走注入的
 * deps，便于单测且让 `lib/index.js` 只做接线。
 *
 * @module dsh-topic-map/fork
 */

/** 重试去重窗口：同会话 + 同轮 5 分钟内复用既有结果。 */
export const RETRY_DEDUPE_WINDOW_MS = 5 * 60 * 1000

/** 新会话标题上限（宿主会再做归一，这里只防超长）。 */
const TITLE_MAX = 200

/** 是否普通对象（排除 null / 数组）。 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从宿主错误里取 code（RemoteError 的 code 是 own property）。 */
function errorCodeOf(error) {
  return typeof error?.code === 'string' ? error.code : ''
}

/** 错误信息文本；非 Error 也安全。 */
function errorMessageOf(error) {
  if (error instanceof Error && typeof error.message === 'string') return error.message
  if (typeof error === 'string') return error
  try {
    return String(error)
  } catch {
    return ''
  }
}

/**
 * 轮次参数归一：只接受非负整数。
 *
 * 注意不接受字符串 `"1"`：HTTP 调用方传错类型时应该显式 400，而不是
 * 悄悄替它转换。
 *
 * @param value - 原始值。
 * @returns 非负整数或 null。
 */
export function normalizeTurn(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * 在轮次行里找某一轮。
 *
 * @param rows - 轮次行数组。
 * @param turn - 轮号。
 * @returns 轮次行或 null。
 */
export function findTurnRow(rows, turn) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row !== null && typeof row === 'object' && row.turn === turn) return row
  }
  return null
}

/**
 * "从第 N 轮之前分叉"的 inclusive 边界。
 *
 * 宿主的 `atSeq` 是**包含**该事件的切割点，而我们要的是不含第 N 轮的
 * 前缀，所以必须退到 `turn/start(N)` 的前一个事件：`seq - 1`。直接用
 * `turn/start` 的 seq 会把第 N 轮的提问也复制进去。
 *
 * 第 0 轮之前没有历史（seq-1 < 0）→ 400；索引缺 seq → 502（数据坏了，
 * 不是调用方的错）。
 *
 * @param row - 目标轮次行。
 * @returns `{ok:true, atSeq}` 或 `{ok:false, error, httpStatus}`。
 */
export function forkAtSeqOfRow(row) {
  const startSeq = Number.isInteger(row?.seq) && row.seq >= 0 ? row.seq : null
  if (startSeq === null) {
    return { ok: false, error: '索引缺少轮次起始序号，无法定位分叉点', httpStatus: 502 }
  }
  const atSeq = startSeq - 1
  if (atSeq < 0) {
    return { ok: false, error: '第 0 轮之前没有可复制的历史，无法分叉', httpStatus: 400 }
  }
  return { ok: true, atSeq }
}

/**
 * 宿主 fork 错误 → 中文可读错误。
 *
 * 只对外暴露固定中文文案，不把宿主的英文 message 原样抛给用户；未知
 * 错误保留截断后的原因，便于排障。
 *
 * @param error - 宿主抛出的错误。
 * @returns `{ok:false, error, httpStatus}`。
 */
export function mapForkFailure(error) {
  const code = errorCodeOf(error)
  switch (code) {
    case 'session/not-found':
      return { ok: false, error: '源会话不存在，无法分叉', httpStatus: 404 }
    case 'session/fork-unavailable':
      return { ok: false, error: '分叉位置不可用：源会话在该位置没有可复制的历史', httpStatus: 409 }
    case 'session/migration-required':
      return { ok: false, error: '源会话需要先打开完成格式迁移，再分叉', httpStatus: 409 }
    case 'session/workspace-attach-failed':
      return { ok: false, error: '分叉已创建，但没能加入工作区；请重试或手动打开新会话', httpStatus: 502 }
    case 'gateway/bad-request':
      return { ok: false, error: '分叉参数不合法', httpStatus: 400 }
    case 'gateway/cancelled':
      return { ok: false, error: '分叉被取消', httpStatus: 504 }
    default: {
      const detail = errorMessageOf(error).slice(0, 200).trim()
      return {
        ok: false,
        error: detail === '' ? '分叉失败：宿主未返回原因' : `分叉失败：${detail}`,
        httpStatus: 502,
      }
    }
  }
}

/**
 * 重新提交提问失败 → 中文错误（带上已经建好的新会话 id）。
 *
 * 分叉已经成功，不能让用户以为“什么都没发生”；错误里必须告诉用户
 * 新会话已经存在，可以去手动补发提问。
 *
 * @param error - 宿主抛出的错误。
 * @param newSessionId - 已创建的新会话 id。
 * @returns `{ok:false, error, httpStatus}`。
 */
export function mapPromptFailure(error, newSessionId) {
  const code = errorCodeOf(error)
  const reason = code === 'session/not-found'
    ? '新会话不存在'
    : code === 'session/agent-busy'
      ? '新会话正忙'
      : code === 'gateway/bad-request'
        ? '宿主拒绝了这个提问'
        : '宿主提交失败'
  return {
    ok: false,
    error: `已分叉出新会话 ${newSessionId}，但重新提交提问失败：${reason}`,
    httpStatus: 502,
  }
}

/**
 * 5 分钟去重表。
 *
 * 同时支持两种复用：
 * - `promise`：并发请求共享同一次执行（结果未出也不能重复分叉）；
 * - `result`：成功后 5 分钟内再请求直接拿既有结果。
 *
 * 失败不占窗口：调用方负责 `delete`。
 *
 * @param options - `{now?, windowMs?}`；测试可注入假时钟。
 * @returns 去重表。
 */
export function createRetryDeduper(options = {}) {
  const opts = isPlainObject(options) ? options : {}
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now()
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? Math.floor(opts.windowMs)
    : RETRY_DEDUPE_WINDOW_MS
  const entries = new Map()

  return {
    windowMs,
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return null
      if (now() - entry.at >= windowMs) {
        entries.delete(key)
        return null
      }
      return entry
    },
    put(key, value) {
      entries.set(key, { at: now(), ...value })
    },
    delete(key) {
      entries.delete(key)
    },
    clear() {
      entries.clear()
    },
    size() {
      return entries.size
    },
  }
}

/** 归一标题：去空白、封顶；空串返回 ''。 */
function normalizeTitle(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text === '' ? '' : Array.from(text).slice(0, TITLE_MAX).join('')
}

/**
 * 组装 `/fork` 与 `/retry` 的端点实现。
 *
 * @param deps - 注入依赖。
 * @param deps.available - `() => boolean`，宿主分叉服务是否可用。
 * @param deps.loadRows - `(sessionId) => Promise<{ok, rows}|{ok:false,error,httpStatus}>`。
 * @param deps.isRunning - `(sessionId) => Promise<boolean>`。
 * @param deps.forkAt - `({sessionId, atSeq}) => Promise<{sessionId}>`。
 * @param deps.submitPrompt - `({sessionId, text, requestId}) => Promise<{accepted}>`。
 * @param deps.renameSession - `({sessionId, title}) => Promise<unknown>`。
 * @param deps.newRequestId - `() => string`。
 * @param deps.registry - 可选去重表。
 * @returns `{fork, retry}`，两者都返回 `{ok, value|error, httpStatus}`。
 */
export function createForkEndpoints(deps = {}) {
  const registry = deps.registry ?? createRetryDeduper()
  const available = typeof deps.available === 'function' ? deps.available : () => true

  /** 会话是否正在运行；查询失败不影响分叉（交给宿主最终裁决）。 */
  async function runningOf(sessionId) {
    if (typeof deps.isRunning !== 'function') return false
    try {
      return (await deps.isRunning(sessionId)) === true
    } catch {
      return false
    }
  }

  /** 统一校验 sessionId；返回空串表示非法。 */
  function sessionIdOf(body) {
    const request = isPlainObject(body) ? body : {}
    return typeof request.sessionId === 'string' ? request.sessionId.trim() : ''
  }

  /** 计算分叉点；返回 `{ok:true,row,atSeq}` 或错误结果。 */
  async function locateForkPoint(sessionId, turn) {
    const loaded = await deps.loadRows(sessionId)
    if (!loaded || loaded.ok !== true) {
      return loaded ?? { ok: false, error: '读不到该会话', httpStatus: 502 }
    }
    const row = findTurnRow(loaded.rows, turn)
    if (row === null) {
      return { ok: false, error: `会话里没有第 ${turn} 轮`, httpStatus: 404 }
    }
    const boundary = forkAtSeqOfRow(row)
    if (!boundary.ok) return boundary
    return { ok: true, row, atSeq: boundary.atSeq }
  }

  /**
   * `/fork`：在第 N 轮**之前**分叉，可选给新会话改名。
   *
   * @param body - `{sessionId, turn, title?}`。
   * @returns `{ok:true, value:{sessionId, atSeq, turn}}` 或错误结果。
   */
  async function fork(body = {}) {
    const sessionId = sessionIdOf(body)
    if (sessionId === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }
    const request = isPlainObject(body) ? body : {}
    const turn = normalizeTurn(request.turn)
    if (turn === null) return { ok: false, error: 'turn 非法', httpStatus: 400 }
    if (request.title !== undefined && request.title !== null && typeof request.title !== 'string') {
      return { ok: false, error: 'title 必须是字符串', httpStatus: 400 }
    }
    if (!available()) return { ok: false, error: '当前宿主未提供分叉服务，无法分叉', httpStatus: 503 }

    const located = await locateForkPoint(sessionId, turn)
    if (located.ok !== true) return located
    if (await runningOf(sessionId)) {
      return { ok: false, error: '会话正在运行，等这一轮结束后再分叉', httpStatus: 409 }
    }

    let forked
    try {
      forked = await deps.forkAt({ sessionId, atSeq: located.atSeq })
    } catch (error) {
      return mapForkFailure(error)
    }
    const newSessionId = typeof forked?.sessionId === 'string' ? forked.sessionId : ''
    if (newSessionId === '') {
      return { ok: false, error: '分叉失败：宿主没有返回新会话', httpStatus: 502 }
    }

    // 改名是装饰：失败不回滚分叉，也不改变响应形状。
    const title = normalizeTitle(request.title)
    if (title !== '' && typeof deps.renameSession === 'function') {
      try {
        await deps.renameSession({ sessionId: newSessionId, title })
      } catch {
        // 忽略：新会话已经建好，用户仍可手动改名。
      }
    }

    return { ok: true, value: { sessionId: newSessionId, atSeq: located.atSeq, turn } }
  }

  /**
   * `/retry`：在第 N 轮之前分叉，然后把该轮 prompt 提交给新会话。
   *
   * 同会话 + 同轮 5 分钟内只执行一次；并发请求共享同一个 Promise。
   *
   * @param body - `{sessionId, turn}`。
   * @param options - `{registry?}`，测试可注入独立去重表。
   * @returns `{ok:true, value:{sessionId, prompt}}` 或错误结果。
   */
  async function retry(body = {}, options = {}) {
    const sessionId = sessionIdOf(body)
    if (sessionId === '') return { ok: false, error: 'sessionId required', httpStatus: 400 }
    const request = isPlainObject(body) ? body : {}
    const turn = normalizeTurn(request.turn)
    if (turn === null) return { ok: false, error: 'turn 非法', httpStatus: 400 }

    const deduper = isPlainObject(options) && options.registry !== undefined ? options.registry : registry
    const key = `${sessionId}#${turn}`
    const existing = deduper.get(key)
    if (existing !== null) {
      if (existing.result !== undefined) return existing.result
      if (existing.promise !== undefined) return existing.promise
    }

    const run = async () => {
      if (!available()) {
        return { ok: false, error: '当前宿主未提供分叉服务，无法重试', httpStatus: 503 }
      }
      const located = await locateForkPoint(sessionId, turn)
      if (located.ok !== true) return located
      const prompt = typeof located.row.prompt === 'string' ? located.row.prompt.trim() : ''
      if (prompt === '') {
        return { ok: false, error: `第 ${turn} 轮没有可重试的提问`, httpStatus: 400 }
      }
      if (await runningOf(sessionId)) {
        return { ok: false, error: '会话正在运行，等这一轮结束后再重试', httpStatus: 409 }
      }

      let forked
      try {
        forked = await deps.forkAt({ sessionId, atSeq: located.atSeq })
      } catch (error) {
        return mapForkFailure(error)
      }
      const newSessionId = typeof forked?.sessionId === 'string' ? forked.sessionId : ''
      if (newSessionId === '') {
        return { ok: false, error: '重试失败：宿主没有返回新会话', httpStatus: 502 }
      }

      try {
        const submitted = await deps.submitPrompt({
          sessionId: newSessionId,
          text: prompt,
          requestId: String(deps.newRequestId()),
        })
        if (!submitted || submitted.accepted !== true) {
          throw Object.assign(new Error('prompt not accepted'), { code: 'gateway/internal' })
        }
      } catch (error) {
        return mapPromptFailure(error, newSessionId)
      }
      return { ok: true, value: { sessionId: newSessionId, prompt } }
    }

    const promise = run()
    deduper.put(key, { promise })
    promise.then(
      result => {
        if (result.ok === true) deduper.put(key, { result })
        else deduper.delete(key)
      },
      () => deduper.delete(key),
    )
    return promise
  }

  return { fork, retry }
}
