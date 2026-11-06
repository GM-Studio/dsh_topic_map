#!/usr/bin/env node
/**
 * 一键自检：确认 Host 半是否已经载入当前磁盘上的代码。
 *
 * 用法：node check-host.mjs [port]
 *
 * 存在意义：Host 半是长驻进程里的 ESM 模块，改了磁盘上的文件不会自动生效，
 * 而"面板空白"和"代码写错了"在浏览器里长得一模一样。这个脚本把两者分开：
 * 它对比磁盘上的 ENGINE_VERSION 与 Host 自报的版本，从而直接指出是哪一种。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const port = process.argv[2] ?? '1909'
const base = `http://127.0.0.1:${port}`

// 磁盘上的版本：直接读源码文本，不 import（避免缓存假象）。
const source = readFileSync(join(here, 'lib', 'lane-engine.js'), 'utf8')
const diskMatch = /ENGINE_VERSION\s*=\s*(\d+)/.exec(source)
const diskVersion = diskMatch ? Number(diskMatch[1]) : null

console.log(`端口       ${port}`)
console.log(`磁盘版本   ${diskVersion}`)

let live
try {
  live = await (await fetch(`${base}/api/topic-map/health`)).json()
} catch (error) {
  console.error(`\n无法连接 ${base} —— DSH 没在跑，或端口不是这个。`)
  console.error(`错误：${error.message}`)
  process.exit(2)
}

// health 走 { ok, value } 信封（与其它端点统一）。
// 兼容旧形状：插件是热重载的，可能刚换成新代码而 DSH 里还是旧的。
const liveVersion = live?.value?.engineVersion ?? live?.engineVersion ?? null

console.log(`Host 自报  ${liveVersion}`)

if (liveVersion !== diskVersion) {
  console.log('\n结论：Host 仍在运行旧代码。')
  console.log('ESM 模块在进程内被缓存，改文件不会重新执行。')
  console.log('\n处理：重启 DSH，然后强刷页面（Ctrl+Shift+R）。')
  process.exit(1)
}

// 版本一致，再验一次真实会话是否真的带 graph。
const sessions = await (await fetch(`${base}/api/topic-map/overview`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
})).json()

const first = sessions?.value?.sessions?.[0]
if (first === undefined) {
  console.log('\n结论：版本一致，但没有可测的会话。')
  process.exit(0)
}

const payload = await (await fetch(`${base}/api/topic-map/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ sessionId: first.sessionId, force: true }),
})).json()

const value = payload?.value
if (!value) {
  console.log(`\n结论：会话读取失败（${payload?.error ?? '未知错误'}）。`)
  process.exit(1)
}

const hasGraph = value.graph !== undefined && value.graph !== null
console.log(`\n样例会话   ${first.sessionId}`)
console.log(`  轮次     ${value.turns.length}`)
console.log(`  graph    ${hasGraph ? '有' : '缺失'}`)
if (hasGraph) {
  console.log(`  轨道     ${value.graph.columnCount}`)
  console.log(`  节点     ${value.graph.nodes.length}`)
  const kinds = {}
  for (const e of value.graph.edges) kinds[e.kind] = (kinds[e.kind] || 0) + 1
  console.log(`  边       ${JSON.stringify(kinds)}`)
  console.log(`  费用     ${value.cost?.label ?? '—'}`)
}

if (!hasGraph) {
  console.log('\n结论：版本一致但 payload 缺 graph —— 说明代码本身有问题，不是缓存。')
  process.exit(1)
}

console.log('\n结论：一切正常。面板刷新后应能出图。')
