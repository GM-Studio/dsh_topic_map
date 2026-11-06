/**
 * 实时性测试：新轮次 / 新会话能不能自动出现在图上。
 *
 * 两个场景：
 *   1. 当前会话新写了一轮 —— 面板**保持挂载**时也要更新
 *      （订阅 binding(id).eventSource 的 revision）
 *   2. 工作区新开了一个会话 —— 面板**保持挂载**时也要发现
 *      （轻量轮询 /workspaces 比对 sessionIds）
 *
 * Run: node tests/live-update.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

function makePayload(turnCount) {
  const turns = Array.from({ length: turnCount }, (_, i) => ({
    turn: i + 1, startSeq: i * 10, endSeq: i * 10 + 4, startTime: 1e12 + i, endTime: 1e12 + i + 1,
    durationMs: 1, prompt: 'p' + (i + 1), response: 'r' + (i + 1),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    steps: 1, toolCalls: 0, files: [], tools: [], commands: [], endReason: 'completed', model: null,
  }))
  return {
    sessionId: 'S1', engineVersion: 4, turns,
    lanes: [{ laneId: 'L1', title: '话题1', turns: turns.map(t => t.turn), categoryIndex: 0 }],
    graph: {
      nodes: turns.map((t, i) => ({ turn: t.turn, index: i, laneId: 'L1', col: 0, primary: true })),
      edges: [], labels: [{ laneId: 'L1', col: 0, text: '话题1' }],
      columns: [{ laneId: 'L1', col: 0 }], turnCount: turnCount, columnCount: 1,
    },
    totals: { turns: turnCount, cost: null }, stages: [], cost: null,
  }
}

function makeHarness() {
  let hookStates = []
  let hookIdx = 0
  const refStore = {}
  let effects = []

  const React = {
    createElement(tag, props, ...kids) {
      if (typeof tag === 'function') return tag({ ...(props ?? {}), children: kids.length === 1 ? kids[0] : kids })
      return { $$v: true, tag, props: props ?? {}, kids: kids.flat(Infinity).filter(k => k != null && k !== false && k !== true) }
    },
    useState(init) {
      const i = hookIdx++
      if (!(i in hookStates)) hookStates[i] = typeof init === 'function' ? init() : init
      return [hookStates[i], (v) => { hookStates[i] = typeof v === 'function' ? v(hookStates[i]) : v }]
    },
    useEffect(fn) { effects.push(fn) },
    useMemo(fn) { return fn() },
    useCallback(fn) { return fn },
    useRef(init) { const k = 'r' + hookIdx++; if (!(k in refStore)) refStore[k] = { current: init }; return refStore[k] },
  }
  const el = () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute() {}, getAttribute: () => null, appendChild() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, hasAttribute: () => false,
    getBoundingClientRect: () => ({ width: 900, height: 600, top: 0, left: 0 }), scrollIntoView() {}, focus() {}, click() {},
    clientWidth: 900, clientHeight: 600, textContent: '', innerHTML: '', dataset: {} })
  const document = { documentElement: el(), head: el(), body: el(), createElement: el, createElementNS: el,
    createTextNode: () => ({}), addEventListener() {}, removeEventListener() {}, querySelector: () => null,
    querySelectorAll: () => [], getElementById: () => null, visibilityState: 'visible', fonts: { ready: Promise.resolve() } }

  const counters = { session: 0, categorize: 0, workspaces: 0 }
  // 会话开会话：轮数可变，模拟"新写一轮"
  const state = { turnCount: 3, extraSessions: [] }
  // 可控的时间调度
  const timeouts = []
  const intervals = []

  function currentWorkspace() {
    return { id: 'W1', path: 'X:/demo', title: 'demo', sessionIds: ['S1', ...state.extraSessions] }
  }

  function fakeFetch(url, opts) {
    const action = String(url).split('/').pop()
    void opts
    let value = null
    if (action === 'session') { counters.session += 1; value = makePayload(state.turnCount) }
    else if (action === 'workspaces') { counters.workspaces += 1; value = [currentWorkspace()] }
    else if (action === 'categorize') {
      counters.categorize += 1
      value = {
        status: 'ready', cached: true, total: 1, uncategorized: [], digests: {},
        tree: [{ name: '话题A', count: 1, subcategories: [{ name: '对话A', sessions: [{ sessionId: 'S1', title: '会话1', turns: state.turnCount, laneCount: 1, automated: false }] }] }],
      }
    } else if (action === 'ui-state') value = { overrides: {}, filter: null }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) })
  }

  // 事件源：可以被测试主动推一次 revision
  const eventSource = {
    revision: 1,
    subscribers: [],
    getSnapshot() { return { entries: [], revision: this.revision, change: 'append' } },
    subscribe(fn) { this.subscribers.push(fn); return () => { const i = this.subscribers.indexOf(fn); if (i >= 0) this.subscribers.splice(i, 1) } },
    push() { this.revision += 1; for (const fn of [...this.subscribers]) fn() },
    // 只通知订阅者但不改 revision：用来验证"没变化就不刷新"
    notifySame() { for (const fn of [...this.subscribers]) fn() },
  }

  const window = {
    __ModuleLoader__: { load: d => { window.__DEF = d } }, addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: fn => { try { fn() } catch { /* 忽略 */ } return 0 }, cancelAnimationFrame() {},
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length }, clearTimeout() {},
    setInterval: (fn) => { intervals.push(fn); return intervals.length }, clearInterval() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }), location: { href: 'http://x/' }, document,
  }
  const sandbox = { window, document, console, Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean,
    RegExp, Error, TypeError, Promise, Symbol, parseInt, parseFloat, isNaN, isFinite,
    setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, setInterval: window.setInterval,
    clearInterval: window.clearInterval, requestAnimationFrame: window.requestAnimationFrame,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: fakeFetch,
    AbortController: class { constructor() { this.signal = {} } abort() {} },
    URLSearchParams, TextEncoder, TextDecoder, navigator: { clipboard: { writeText() {} } } }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'client.js' })

  const require = n => { if (n === 'react') return React; throw new Error('unknown ' + n) }
  const api = window.__DEF.factory(require)
  let Panel = null
  api.apply({ effect() {}, locale: { register: () => (() => {}), bind: () => (k => k) },
    slots: { inject: (n, f) => f(), register: (o, C) => { Panel = C; return () => {} } },
    sessions: { binding: () => ({ eventSource, session: { loadThrough: () => Promise.resolve() }, target: () => ({ getSnapshot: () => ({ navigation: { items: () => [] } }) }) }) },
    uiConversation: null })

  function frame() {
    hookIdx = 0
    effects = []
    const out = Panel({ sessionId: 'S1', useChat: () => ({ turns: [] }), t: k => k })
    for (const fn of [...effects]) { try { fn() } catch { /* 忽略 */ } }
    return out
  }
  function runTimeouts() { timeouts.splice(0).forEach(f => { try { f() } catch { /* 忽略 */ } }) }
  function runIntervals() { intervals.forEach(f => { try { f() } catch { /* 忽略 */ } }) }

  return { frame, counters, state, eventSource, runTimeouts, runIntervals, document }
}

async function settle() { for (let i = 0; i < 15; i += 1) await Promise.resolve() }

console.log('\nlive-update')

await test('会话事件 revision 变化后会重新拉取数据（新轮次自动出现）', async () => {
  const h = makeHarness()
  // 首屏 + 挂载副作用
  h.frame()
  await settle()
  h.frame()
  await settle()

  function countCircles(node) {
    let n = 0
    ;(function walk(x) {
      if (!x || typeof x !== 'object') return
      if (x.tag === 'circle') n += 1
      for (const k of x.kids || []) walk(k)
    })(node)
    return n
  }

  const before = h.counters.session
  const nodesBefore = countCircles(h.frame())

  // 模拟"新写了一轮"
  h.state.turnCount = 4
  h.eventSource.push()
  // 防抖到点
  h.runTimeouts()
  await settle()
  assert.ok(h.counters.session > before, '应当重新请求了 session')

  const nodesAfter = countCircles(h.frame())
  assert.equal(nodesAfter, nodesBefore + 1,
    '图上应多出 1 个轮次节点（' + nodesBefore + ' → ' + nodesAfter + '）')
})

await test('revision 没变则不重复请求（避免无谓刷新）', async () => {
  const h = makeHarness()
  h.frame(); await settle(); h.frame(); await settle()
  const before = h.counters.session
  // 事件来了但 revision 没变（例如只是重渲染）
  h.eventSource.notifySame()
  h.runTimeouts()
  await settle()
  assert.equal(h.counters.session, before, 'revision 未变时不该重新请求')
})

await test('工作区出现新会话时会被轮询发现', async () => {
  const h = makeHarness()
  h.frame(); await settle(); h.frame(); await settle()
  const beforeWorkspaces = h.counters.workspaces
  // 模拟"新开了一个会话窗口"
  h.state.extraSessions = ['S2']
  // 触发一次轮询
  h.runIntervals()
  await settle()
  assert.ok(h.counters.workspaces > beforeWorkspaces, '轮询应重新读取工作区列表')
})

await test('会话集合没变时轮询不触发重载', async () => {
  const h = makeHarness()
  h.frame(); await settle(); h.frame(); await settle()
  const beforeWorkspaces = h.counters.workspaces
  const beforeCategorize = h.counters.categorize
  h.runIntervals()
  await settle()
  // 只多了一次 /workspaces 探测，**不应**重新归类
  assert.equal(h.counters.workspaces, beforeWorkspaces + 1, '应有一次轻量探测')
  assert.equal(h.counters.categorize, beforeCategorize, '集合没变时不该重新加载树')
})

await test('页面不可见时不轮询', async () => {
  const h = makeHarness()
  h.frame(); await settle(); h.frame(); await settle()
  const before = h.counters.workspaces
  h.document.visibilityState = 'hidden'
  h.state.extraSessions = ['S3']
  h.runIntervals()
  await settle()
  assert.equal(h.counters.workspaces, before, '隐藏状态下不该发请求')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
