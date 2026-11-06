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

function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function flush() { for (let i = 0; i < 6; i++) await Promise.resolve() }

test('快速 A→B 切换时，迟到的 A 分类和统计不能覆盖 B；加载时清除旧工作区', async () => {
  const calls = []
  const state = { tree: [category('旧', [{ sessionId: 'old', turns: 999 }])], total: 1, uncategorized: [] }
  const post = (action, body) => { const d = deferred(); calls.push({ action, body, ...d }); return d.promise }
  const load = new Function('post', 'patchTree', 'workspaceRequestRef', 'inferWorkspaceId', 'activeSessionId',
    extract('loadWorkspaceTree') + '; return loadWorkspaceTree')(post, patch => Object.assign(state, patch), { current: 0 }, () => 'a', 'live')
  load('a'); assert.deepEqual(state.tree, [])
  calls[0].resolve([{ id: 'a' }, { id: 'b' }]); await flush()
  const a = calls.find(c => c.action === 'categorize')
  load('b'); calls.findLast(c => c.action === 'workspaces').resolve([{ id: 'a' }, { id: 'b' }]); await flush()
  const b = calls.findLast(c => c.action === 'categorize')
  b.resolve({ tree: [category('B', [{ sessionId: 'b1', turns: 8 }])], total: 1 }); await flush()
  a.resolve({ tree: [category('A', [{ sessionId: 'a1', turns: 300 }])], total: 1 }); await flush()
  assert.equal(state.workspaceId, 'b')
  assert.equal(state.tree[0].name, 'B')
  assert.equal(totals(state.tree, state.uncategorized, null).turns, 8)
  assert.equal(b.body.activeSessionId, null, '显式切换工作区应刷新该工作区全部轮数')
})
