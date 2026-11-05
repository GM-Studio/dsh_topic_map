/**
 * 自定义模型端点：直连 OpenAI 兼容的 `/chat/completions`。
 *
 * 为什么需要它：默认只能跟随会话模型，而会话模型不一定是对的那一个——
 * 用户可能想用更便宜/更强的模型只做"分段"这一件事。因此允许填
 * `baseUrl / apiKey / modelName` 走自己的端点。
 *
 * 设计取舍：
 *   - 只实现 OpenAI 兼容协议。这是事实标准，vLLM、Ollama、LM Studio、
 *     OpenRouter、各家云厂商的兼容层都支持，覆盖绝大多数场景。
 *   - 失败**一定抛错**，由调用方决定回退。不在这里偷偷回退，否则调用方
 *     无法区分"自定义端点给了答案"和"其实用的是会话模型"。
 *
 * @module dsh-topic-map/remote-llm
 */

/** 请求超时。分段是交互动作，用户不会等太久。 */
export const DEFAULT_TIMEOUT_MS = 60000

/** 是否配置了完整的自定义端点。 */
export function hasCustomEndpoint(cfg) {
  if (cfg === null || cfg === undefined) return false
  return typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() !== ''
    && typeof cfg.modelName === 'string' && cfg.modelName.trim() !== ''
}

/**
 * 拼出 chat completions 的完整 URL。
 *
 * 用户可能填三种形式，都要能用：
 *   `https://api.x.com`             -> `https://api.x.com/v1/chat/completions`
 *   `https://api.x.com/v1`          -> `https://api.x.com/v1/chat/completions`
 *   `https://api.x.com/v1/chat/completions` -> 原样
 *
 * @param baseUrl - 用户填的地址。
 * @returns 完整 URL。
 */
export function completionUrl(baseUrl) {
  const raw = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (raw === '') throw new Error('baseUrl 为空')
  if (/\/chat\/completions$/.test(raw)) return raw
  // 已经带了版本段（/v1、/v1beta、/openai/v1 等）就不再补 /v1
  if (/\/v\d+[a-z]*(\/|$)/.test(raw)) return `${raw}/chat/completions`
  return `${raw}/v1/chat/completions`
}

/**
 * 构造请求体。
 *
 * `temperature: 0` 是刻意的：分段是分类任务，要的是稳定复现，不是创造力。
 *
 * @param cfg - `{ modelName, temperature?, maxTokens? }`。
 * @param system - 系统提示。
 * @param user - 用户消息。
 * @returns 请求体对象。
 */
export function buildRequestBody(cfg, system, user, maxTokens) {
  return {
    model: String(cfg.modelName ?? '').trim(),
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    temperature: 0,
    max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 1024,
    stream: false,
  }
}

/**
 * 从响应 JSON 里取出正文。
 *
 * 兼容 `choices[0].message.content` 与 `choices[0].text`（老式 completions）。
 * 取不到就抛，让调用方回退——静默返回空字符串会让上层误以为"模型说了空"。
 *
 * @param json - 响应体。
 * @returns 文本。
 */
export function extractText(json) {
  const choices = json === null || json === undefined ? null : json.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('响应里没有 choices')
  }
  const first = choices[0]
  const msg = first === null || first === undefined ? null : first.message
  if (msg !== null && msg !== undefined) {
    // content 可能是字符串，也可能是 [{type:'text',text:'...'}] 分段数组
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
      return msg.content
        .map(part => (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
        .join('')
    }
  }
  if (typeof first.text === 'string') return first.text
  throw new Error('响应里没有可用的文本')
}

/**
 * 调一次自定义端点。
 *
 * @param io - `{ fetch }`，注入以便测试。
 * @param cfg - `{ baseUrl, apiKey, modelName }`。
 * @param system - 系统提示。
 * @param user - 用户消息。
 * @param options - `{ maxTokens, timeoutMs, signal }`。
 * @returns 模型输出的文本（可能为空字符串）。
 */
export async function callRemote(io, cfg, system, user, options = {}) {
  const url = completionUrl(cfg.baseUrl)
  const body = buildRequestBody(cfg, system, user, options.maxTokens)

  const headers = { 'content-type': 'application/json' }
  const key = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : ''
  if (key !== '') headers.authorization = `Bearer ${key}`

  // 超时与外部取消要能同时生效：用 AbortController 串联。
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  if (controller !== null) {
    timer = setTimeout(() => { try { controller.abort() } catch { /* 忽略 */ } }, timeoutMs)
    if (options.signal !== undefined && options.signal !== null && typeof options.signal.addEventListener === 'function') {
      if (options.signal.aborted) {
        try { controller.abort() } catch { /* 忽略 */ }
      } else {
        options.signal.addEventListener('abort', () => { try { controller.abort() } catch { /* 忽略 */ } })
      }
    }
  }

  try {
    const res = await io.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller === null ? undefined : controller.signal,
    })
    if (!res.ok) {
      // 带上状态码与一小段正文：401/404 的区别对用户诊断很重要。
      let detail = ''
      try { detail = (await res.text()).slice(0, 200) } catch { /* 忽略 */ }
      throw new Error(`HTTP ${res.status}${detail === '' ? '' : '：' + detail}`)
    }
    const json = await res.json()
    return extractText(json)
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}
