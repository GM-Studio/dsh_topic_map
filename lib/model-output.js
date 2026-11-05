/**
 * 模型输出的 JSON 抽取。
 *
 * 为什么需要单独一层：四个模块（分段、层级、合并、归类）都要从模型回复里
 * 取一个 JSON 数组，而各家模型的输出习惯差异很大：
 *
 *   1. 纯 JSON                          [{...}]
 *   2. 代码围栏                          ```json\n[{...}]\n```
 *   3. 前后有客套话                      "好的，结果如下：\n[{...}]\n以上。"
 *   4. **先说思路带方括号，再给答案**    "我先分成 [三类]，最终：\n[{...}]"
 *   5. 嵌套数组                          {"stages": [{...}]}
 *
 * 第 4 种是最容易踩的：只取"第一个 [ 到最后一个 ]"切出来的片段非法，
 * 整批结果就丢了。而在弱一些的模型上这种输出很常见——把插件搬到
 * 别的环境、换成别的模型，这个缺陷才会暴露。
 *
 * 策略：从**最后一个** `[` 往前逐个尝试配对，返回第一个能解析成数组的片段。
 * 从后往前是因为真正想要的答案通常在最后（模型先思考后结论）。
 *
 * @module dsh-topic-map/model-output
 */

/**
 * 从文本里抽第一个能解析成数组的 JSON 片段。
 *
 * @param text - 模型输出。
 * @returns 数组或 null。
 */
export function extractJsonArray(text) {
  const fence = String(text ?? '').replace(/```[a-zA-Z]*\n?/g, '')

  const starts = []
  const ends = []
  for (let i = 0; i < fence.length; i += 1) {
    if (fence[i] === '[') starts.push(i)
    else if (fence[i] === ']') ends.push(i)
  }
  if (starts.length === 0 || ends.length === 0) return null

  // 候选跨度按"起点靠后、跨度更短"优先：先试更像答案的片段
  for (let si = starts.length - 1; si >= 0; si -= 1) {
    const from = starts[si]
    for (let ei = 0; ei < ends.length; ei += 1) {
      const to = ends[ei]
      if (to <= from) continue
      try {
        const parsed = JSON.parse(fence.slice(from, to + 1))
        if (Array.isArray(parsed)) return parsed
      } catch {
        // 这个跨度不合法，继续试
      }
    }
  }
  return null
}

/**
 * 抽取并校验长度。
 *
 * 长度不符一律作废：错位的结果比"没有结果"糟得多——它会让内容被放到
 * 错误的位置，而用户不会立刻发现。
 *
 * @param text - 模型输出。
 * @param expected - 期望条数。
 * @returns 数组或 null。
 */
export function extractJsonArrayOfLength(text, expected) {
  const parsed = extractJsonArray(text)
  if (parsed === null) return null
  if (!Number.isFinite(expected) || expected < 0) return null
  return parsed.length === expected ? parsed : null
}

/**
 * 从对象里按候选键名取数组（兼容模型把数组包在对象里的情况）。
 *
 * 例：期望一个分配数组，模型给了 `{"assignments":[...]}` 或 `{"result":[...]}`。
 *
 * @param text - 模型输出。
 * @param keys - 候选键名，按优先级。
 * @param expected - 期望条数（可选）。
 * @returns 数组或 null。
 */
export function extractJsonField(text, keys, expected) {
  const fence = String(text ?? '').replace(/```[a-zA-Z]*\n?/g, '')
  const from = fence.indexOf('{')
  const to = fence.lastIndexOf('}')
  if (from < 0 || to <= from) return null

  let parsed
  try {
    parsed = JSON.parse(fence.slice(from, to + 1))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null

  for (const key of Array.isArray(keys) ? keys : []) {
    const value = parsed[key]
    if (!Array.isArray(value)) continue
    if (Number.isFinite(expected) && value.length !== expected) continue
    return value
  }
  return null
}
