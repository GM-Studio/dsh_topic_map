#!/usr/bin/env node
/**
 * 全量测试汇总。
 *
 * 两件事都要看：
 *   1. 退出码（0 = 通过）
 *   2. 输出里的 FAIL 行数
 *
 * 之前只看退出码，漏掉了一个"打印 FAIL 但不 exit(1)"的测试文件
 * （tests/pin.mjs），导致长期误报全绿。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const dir = 'tests'
const files = readdirSync(dir).filter(f => f.endsWith('.mjs')).sort()

let totalPass = 0
let bad = []
const rows = []

for (const f of files) {
  const path = join(dir, f)
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [path], { encoding: 'utf8', timeout: 180000 })
  } catch (e) {
    code = e.status === undefined || e.status === null ? 1 : e.status
    out = (e.stdout || '') + (e.stderr || '')
  }

  const failCount = (out.match(/^\s*FAIL /gm) || []).length
  // 三种计数格式
  let pass = 0
  const m1 = out.match(/^(\d+) passed/m)
  const m2 = out.match(/pass (\d+)/)
  if (m1) pass = Number(m1[1])
  else if (m2) pass = Number(m2[1])
  else if (/OK —/.test(out)) pass = 1

  totalPass += pass
  const ok = code === 0 && failCount === 0
  if (!ok) bad.push(f)
  rows.push({ f, pass, failCount, code, ok })
}

for (const r of rows) {
  const mark = r.ok ? '✓' : '✗'
  console.log(`${mark} ${r.f.padEnd(24)} pass=${String(r.pass).padStart(3)} fail=${r.failCount} exit=${r.code}`)
}
console.log(`\n文件 ${files.length} 个 | 用例 ${totalPass} 项 | 失败文件 ${bad.length} 个`)
if (bad.length > 0) {
  console.log('失败：' + bad.join(', '))
  process.exit(1)
}
