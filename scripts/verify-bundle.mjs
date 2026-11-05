/**
 * 检查 client bundle 里嵌入的模块导出是否覆盖客户端的全部使用。
 *
 * 为什么需要这个脚本：`lib/client.js` 是单文件 bundle，它通过
 * `THEME.xxx` / `FILTER.xxx` / `PM.xxx` 这样访问外部模块，而这些模块是
 * **文本嵌入**的——导出的名字列表是脚本里手写的。手写清单漏一个函数，
 * 运行时就是 `TypeError: PM.inferFromEvidence is not a function`，
 * 整个面板白屏，而单元测试全绿（它们测的是 lib/ 里的源码，不是 bundle）。
 *
 * 这个脚本把"客户端用到的"和"bundle 里导出的"对一遍，任何一个缺失就让
 * 构建失败。白屏这类问题应该在构建时暴露，而不是等用户看到空白页。
 *
 * Run: node scripts/verify-bundle.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const src = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

/** 从 bundle 里取一个嵌入模块的返回对象文本。 */
function moduleBlock(name) {
  const re = new RegExp(`var ${name} = \\(function \\(\\)[\\s\\S]*?\\n    \\}\\)\\(\\)`)
  const m = src.match(re)
  return m === null ? null : m[0]
}

/** 取出该模块 return { ... } 里的导出名。 */
function exportedNames(block) {
  if (block === null) return []
  const ret = block.lastIndexOf('return {')
  if (ret < 0) return []
  const end = block.indexOf('}', ret)
  const body = block.slice(ret + 'return {'.length, end)
  // 形如 `a: a, b: b` 或跨行
  return [...body.matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map(m => m[1])
}

/** 客户端对该模块的调用集合。 */
function usedNames(prefix) {
  const re = new RegExp(`\\b${prefix}\\.([A-Za-z_$][\\w$]*)`, 'g')
  return [...new Set([...src.matchAll(re)].map(m => m[1]))]
}

const MODULES = ['THEME', 'FILTER', 'PM', 'UISTATE', 'FOLD', 'DELIV', 'REPORT', 'GMODE', 'SCAT']
let failed = false

for (const name of MODULES) {
  const block = moduleBlock(name)
  if (block === null) {
    console.error(`✗ 找不到嵌入模块 ${name}`)
    failed = true
    continue
  }
  const exported = exportedNames(block)
  const used = usedNames(name)
  const missing = used.filter(u => !exported.includes(u))

  if (missing.length > 0) {
    console.error(`✗ ${name}: 客户端用到但未导出 → ${missing.join(', ')}`)
    console.error(`  已导出：${exported.join(', ')}`)
    failed = true
  } else {
    console.log(`✓ ${name}: ${used.length} 个使用全部有导出`)
  }
}

if (failed) {
  console.error('\n构建失败：存在未导出的符号，运行时会白屏。')
  console.error('修法：在 scripts/build-theme.mjs 的 return 清单里补上缺失的名字，然后重新生成。')
  process.exit(1)
}
console.log('\n所有嵌入模块的导出都完整。')
