/**
 * 旧话题地图面板已下线；重挂载缓存属于该面板的行为，随入口移除。
 *
 * 这里只锁住“旧入口不再注册、旧 /categorize 不再调用”，避免测试继续
 * 从源码里抓一个已经不可挂载的 Panel。
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

console.log('\nremount-cache')

test('旧 conversation.view 面板不再注册', () => {
  assert.equal(src.includes("slots.inject('conversation.view'"), false)
})

test('旧 /categorize 请求已删除', () => {
  assert.equal(src.includes("'categorize'"), false)
})

if (failures.length > 0) {
  console.error(`\n${passed} passed, ${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\n${passed} passed`)
}
