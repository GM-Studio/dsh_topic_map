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
}
const h = (type, props, ...children) => ({ type, props, children: children.flat(Infinity) })
function buttons(node) {
  if (!node || typeof node !== 'object') return []
  return [...(node.type === 'button' ? [node] : []), ...(node.children || []).flatMap(buttons)]
}

test('浏览历史会话的展开详情不显示跳转；当前会话传入跳转回调后显示并传递精确轮号', () => {
  const render = new Function('h', 'useState', 'fmtTokens', 'fmtDuration', extract('TurnList') + ';return TurnList')(
    h, () => ['', () => {}], String, String)
  const props = { lane: { turns: [7], title: '话题' }, turns: [{ turn: 7, prompt: '第七轮', tools: [] }], openTurns: { 7: true } }
  assert.equal(buttons(render(props)).filter(b => b.props.className === 'dsh_tm_tjump').length, 0)
  let selected
  const [jump] = buttons(render({ ...props, onJump: n => { selected = n } })).filter(b => b.props.className === 'dsh_tm_tjump')
  assert.ok(jump)
  jump.props.onClick({ stopPropagation() {} })
  assert.equal(selected, 7)
})

test('只有当前宿主会话、所浏览会话、已加载数据一致且位于会话层才允许跳转', () => {
  const canJump = new Function(extract('canJumpToSession') + ';return canJumpToSession')()
  assert.equal(canJump('live', 'live', { sessionId: 'live' }, null), true)
  for (const args of [
    ['live', 'history', { sessionId: 'history' }, null],
    ['live', 'live', { sessionId: 'history' }, null],
    ['live', 'live', { sessionId: 'live' }, { level: 'topic' }],
    [undefined, undefined, null, null],
  ]) assert.equal(canJump(...args), false)
})

test('历史会话即使调用旧跳转回调也不能切换对话或加载当前会话历史', () => {
  const calls = []
  const env = {
    sessionId: 'live', activeSessionId: 'history', data: { sessionId: 'history' }, laneScope: null,
    canJump: false,
    byTurn: new Map([[7, { turn: 7, startSeq: 70 }]]),
    props: { openView: () => calls.push('open') },
    SESSION_SERVICE: { binding: () => { calls.push('binding'); return { session: { loadThrough() {} } } } },
    chatScroller: () => null, anchorRef: { current: new Map() },
    findRowByTurn: () => null, window: { setTimeout() {} },
  }
  const jump = new Function(...Object.keys(env), extract('jumpTo') + ';return jumpTo')(...Object.values(env))
  jump(7)
  assert.deepEqual(calls, [])
})
