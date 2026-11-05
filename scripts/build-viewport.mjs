/**
 * 把 lib/viewport.js 的算法原样嵌入 client bundle。
 *
 * client bundle 是浏览器单文件，不能 `import`；而这些函数已经独立测试过
 * （tests/viewport.mjs 20 项），所以这里只做文本替换，保证浏览器里跑的
 * 与测试的是同一套公式。
 *
 * Run: node scripts/build-viewport.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const src = readFileSync(join(root, 'lib', 'viewport.js'), 'utf8')

// 去掉模块声明与 export 关键字，保留函数与常量原文。
const body = src
  .replace(/^\/\*\*[\s\S]*?\*\/\s*/m, '')      // 模块头注释
  .replace(/^export const /gm, 'var ')
  .replace(/^export function /gm, 'function ')
  .replace(/^import .*$/gm, '')

const wrapped = [
  '    // ══ 以下由 scripts/build-viewport.mjs 从 lib/viewport.js 生成 ══',
  '    // 浏览器单文件 bundle 无法 import，因此把测试过的实现原样嵌入。',
  '    // 修改请改 lib/viewport.js 后重新生成，不要直接编辑这一段。',
  '    var VIEWPORT = (function () {',
  body.split('\n').map(line => (line === '' ? '' : '  ' + line)).join('\n'),
  '      return {',
  '        MIN_SCALE: MIN_SCALE, MAX_SCALE: MAX_SCALE, EDGE_SLACK: EDGE_SLACK,',
  '        clampScale: clampScale, zoomAt: zoomAt, panBy: panBy, constrain: constrain,',
  '        fitToView: fitToView, toScreen: toScreen, overviewRange: overviewRange, seekTo: seekTo,',
  '      }',
  '    })()',
  '    // ══ 生成段结束 ══',
].join('\n')

const clientPath = join(root, 'lib', 'client.js')
const client = readFileSync(clientPath, 'utf8')

const START = '    // ══ 以下由 scripts/build-viewport.mjs'
const END = '    // ══ 生成段结束 ══'

const s = client.indexOf(START)
if (s >= 0) {
  const e = client.indexOf(END, s)
  if (e < 0) throw new Error('生成段缺少结束标记')
  const next = client.slice(0, s) + wrapped + client.slice(e + END.length)
  writeFileSync(clientPath, next)
  console.log('已替换生成段')
} else {
  // 首次插入：放在 CSS 常量之后、第一个函数之前
  const anchor = '    // ── 格式化 ──'
  const at = client.indexOf(anchor)
  if (at < 0) throw new Error('找不到插入锚点')
  const next = client.slice(0, at) + wrapped + '\n\n' + client.slice(at)
  writeFileSync(clientPath, next)
  console.log('已插入生成段')
}
