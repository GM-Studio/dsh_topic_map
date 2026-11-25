/**
 * Markdown 围栏代码块解析：`/session-commands` 与 `/search` 的唯一来源。
 *
 * 只做行级围栏扫描，不引入 Markdown AST；一条代码块 = 一条命令/一个 block。
 *
 * @module dsh-topic-map/code-blocks
 */

/** 围栏开头：最多 3 个前导空格，3 个以上反引号/波浪线。 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/** 围栏结束：同种围栏字符且长度不小于开头。 */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/

/**
 * 从一条 assistant 回答里提取所有 markdown 围栏代码块。
 *
 * `text` 保留块内换行；`lang` 是围栏信息串的第一个 token（无标注为 ''）。
 * 支持 4 个反引号包裹内部 3 个反引号的嵌套写法；未闭合的围栏整块忽略。
 *
 * @param response - 该轮回答全文。
 * @returns `[{lang, text}]`（按出现顺序）。
 */
export function codeBlocksOf(response) {
  const text = typeof response === 'string' ? response : ''
  if (text === '') return []
  const lines = text.split(/\r?\n/)
  const blocks = []
  let index = 0

  while (index < lines.length) {
    const open = lines[index].match(FENCE_OPEN_RE)
    if (open === null) {
      index += 1
      continue
    }
    const marker = open[1]
    const fenceChar = marker[0]
    const fenceLength = marker.length
    const info = open[2].trim()

    let close = -1
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      const candidate = lines[scan].match(FENCE_CLOSE_RE)
      if (candidate === null) continue
      if (candidate[1][0] !== fenceChar || candidate[1].length < fenceLength) continue
      close = scan
      break
    }
    if (close === -1) break

    blocks.push({
      lang: info === '' ? '' : info.split(/\s+/)[0],
      text: lines.slice(index + 1, close).join('\n'),
    })
    index = close + 1
  }
  return blocks
}
