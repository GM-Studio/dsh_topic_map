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
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve() }
function setup() {
  const calls = []
  const loads = []
  const timers = []
  const scene = { native: false, row: null, key: null }
  const scroller = { scrollTop: 0, scrollHeight: 4000, dispatchEvent: e => calls.push(e.type), getBoundingClientRect: () => ({ top: 0 }) }
  const env = {
    canJump: true, jumpAllowedRef: { current: true }, jumpRequestRef: { current: null },
    sessionId: 'live', activeSessionId: 'live', data: { sessionId: 'live', turns: [{ turn: 7 }, { turn: 8 }] }, laneScope: null,
    byTurn: new Map([[7, { turn: 7, startSeq: 70 }], [8, { turn: 8, startSeq: 80 }]]),
    props: { openView: () => calls.push('open') },
    SESSION_SERVICE: { binding: () => ({ session: { loadThrough(seq) { calls.push(['load', seq]); const d = deferred(); loads.push(d); return d.promise } } }) },
    CONVERSATION_SERVICE: { binding: () => ({ target: () => ({ getSnapshot: () => ({ navigation: { items: () => scene.key ? [{ turn: 7, anchorKey: scene.key }, { turn: 8, anchorKey: 'user:8' }] : [] } }) }) }) },
    anchorRef: { current: new Map() },
    chatScroller: () => scroller,
    activateChatTurn: n => { calls.push(['native', n]); scene.native = true; return true },
    findUserTurnRow: (n, key) => { calls.push(['find', n, key]); return scene.row },
    findTurnRow: () => scene.row, findRowByTurn: () => scene.row,
    revealRow: () => { calls.push('reveal'); return 0 },
    showJumpNotice: message => calls.push(['error', message]),
    REVEAL_TOP_PAD: 8, JUMP_TRACE: null,
    window: { setTimeout: fn => timers.push(fn), requestAnimationFrame: fn => timers.push(fn) },
  }
  const jump = new Function(...Object.keys(env), extract('jumpTo') + ';return jumpTo')(...Object.values(env))
  return { jump, calls, loads, timers, scene, env, tick() { timers.splice(0).forEach(f => f()) } }
}

test('历史先加载，再切视图；从实时宿主快照读取锚点，原生导航后精确定位用户输入', async () => {
  const s = setup()
  s.jump(7)
  assert.deepEqual(s.calls, [['load', 70]], '不能在历史加载之前卸载面板、冻结锚点')
  s.scene.key = 'fresh-user:7'
  s.scene.row = { getAttribute: n => n === 'data-chat-flow-kind' ? 'user' : null,
    getBoundingClientRect: () => ({ top: 8, height: 40 }) }
  s.loads[0].resolve(); await flush(); s.tick(); s.tick()
  assert.ok(s.calls.includes('open'))
  assert.ok(s.calls.some(c => Array.isArray(c) && c[0] === 'native' && c[1] === 7))
  assert.ok(s.calls.some(c => Array.isArray(c) && c[0] === 'find' && c[2] === 'fresh-user:7'))
  assert.ok(s.calls.includes('reveal'))
})

test('历史加载失败保留地图并明确报错，不切到错误或未加载的对话', async () => {
  const s = setup(); s.jump(7); s.loads[0].reject(Error('offline')); await flush()
  assert.equal(s.calls.includes('open'), false)
  assert.ok(s.calls.some(c => Array.isArray(c) && c[0] === 'error'))
})

test('分页完成后宿主快照延迟发布时，等待准确锚点再打开对话', async () => {
  const s = setup(); s.jump(7); s.loads[0].resolve(); await flush()
  assert.equal(s.calls.includes('open'), false)
  assert.equal(s.calls.some(c => Array.isArray(c) && c[0] === 'error'), false)
  s.scene.key = 'late-user:7'; s.tick()
  assert.equal(s.calls.includes('open'), true)
})

test('连续点击只执行最后一次；等待期间切换会话则取消旧跳转', async () => {
  const s = setup(); s.jump(7); s.jump(8)
  s.loads[0].resolve(); await flush(); s.tick()
  assert.equal(s.calls.includes('open'), false)
  s.env.jumpAllowedRef.current = false
  s.loads[1].resolve(); await flush(); s.tick()
  assert.equal(s.calls.includes('open'), false)
})

test('找不到精确用户行就提示失败，不用过程行或下一轮冒充成功', async () => {
  const s = setup(); s.jump(7); s.scene.key = 'user:7'; s.loads[0].resolve(); await flush()
  // 跳到"放弃"要跑满 80 次重试预算（大会话需要更多时间等虚拟列表渲染）
  for (let i = 0; i < 90; i++) s.tick()
  assert.equal(s.calls.includes('reveal'), false)
  assert.ok(s.calls.some(c => Array.isArray(c) && c[0] === 'error'))
})

test('精确定位排除同轮过程行、下一轮和不可见用户行', () => {
  const row = (turn, kind, height = 40) => ({ hasAttribute: () => false, closest: () => null,
    getAttribute: n => ({ 'data-chat-turn': String(turn), 'data-chat-flow-kind': kind }[n] ?? null),
    getBoundingClientRect: () => ({ top: 100, height }) })
  const proc = row(7, 'turn-process'), next = row(8, 'user'), hidden = row(7, 'user', 0), wanted = row(7, 'user')
  const find = new Function('document', 'findTurnRow', extract('findUserTurnRow') + ';return findUserTurnRow')({}, () => proc)
  assert.equal(find(7, 'wrong', { querySelectorAll: () => [proc, next, hidden, wanted] }), wanted)
  assert.equal(find(7, 'wrong', { querySelectorAll: () => [proc, next, hidden] }), null)
  const noAnchor = new Function('document', 'findTurnRow', extract('findUserTurnRow') + ';return findUserTurnRow')({}, () => null)
  assert.equal(noAnchor(7, 'another-session', { querySelectorAll: () => [wanted] }), null, '锚点不属于此滚动区时不能按轮号跨会话匹配')
})

test('原生导航只点击准确轮号；虚拟化时只滚动轨道并等待目标按钮挂载', () => {
  let clicked = []
  const mark = (index, turn, top) => ({
    getAttribute: key => key === 'data-index' ? String(index) : `跳转到第 ${turn} 轮`,
    getBoundingClientRect: () => ({ top }), click: () => clicked.push(turn),
  })
  const rail = { scrollTop: 0, clientHeight: 100, getBoundingClientRect: () => ({ top: 0 }) }
  let marks = [mark(0, 1, 10), mark(1, 2, 20)]
  const nav = { querySelectorAll: () => marks, firstElementChild: rail }
  const activate = new Function('document', extract('activateChatTurn') + ';return activateChatTurn')({ querySelector: () => nav })
  const turns = Array.from({ length: 100 }, (_, i) => ({ turn: i + 1 }))
  assert.equal(activate(72, turns), false)
  assert.ok(rail.scrollTop > 600)
  assert.deepEqual(clicked, [])
  marks = [mark(70, 71, 10), mark(71, 72, 20), mark(72, 73, 30)]
  assert.equal(activate(72, turns), true)
  assert.deepEqual(clicked, [72])
})
