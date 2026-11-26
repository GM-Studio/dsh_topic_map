/**
 * 旧话题地图面板已下线：conversation.view 不再注册，/categorize 不再调用。
 *
 * 实时轮询 / 重挂载缓存等面板行为随之移除；这里锁住下线边界。
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nlive-update')

test('旧面板入口不再注册', () => {
  assert.equal(src.includes("slots.inject('conversation.view'"), false)
})

test('旧 /categorize 调用已删除', () => {
  assert.equal(src.includes("'categorize'"), false)
  assert.equal(src.includes('activeSessionId: null'), false)
})

if (failures.length > 0) {
  console.error(`\n${passed} passed, ${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\n${passed} passed`)
}
