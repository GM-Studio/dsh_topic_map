import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
function extract(name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `未找到 ${name}`)
  let depth = 0
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1)
  }
  throw Error('函数未闭合')
}
function totals(...args) {
  return new Function(extract('workspaceTotals') + '; return workspaceTotals')()(...args)
}
const category = (name, sessions) => ({ name, subcategories: [{ name: '分组', sessions }] })

test('工作区统计覆盖归类及未归类会话，去重且只使用本工作区的实时数据', () => {
  const tree = [category('开发', [{ sessionId: 'a', turns: 3 }, { sessionId: 'b', turns: 5 }]),
    category('排障', [{ sessionId: 'a', turns: 3 }])]
  const fresh = [{ sessionId: 'c', turns: 2 }]
  assert.deepEqual(totals(tree, fresh, { sessionId: 'other', totals: { turns: 99 } }), { turns: 10, topics: 2 })
  assert.deepEqual(totals(tree, fresh, { sessionId: 'a', totals: { turns: 7 } }), { turns: 14, topics: 2 })
  assert.deepEqual(totals([], [], null), { turns: 0, topics: 0 })
  assert.equal(totals([category('未知', [{ sessionId: 'x', turns: null }])], [], null).turns, null)
})

test('旧 /categorize 刷新链路已下线，不再消费 activeSessionId 归类结果', () => {
  assert.equal(src.includes("'categorize'"), false)
  assert.equal(src.includes('activeSessionId: null'), false)
})

