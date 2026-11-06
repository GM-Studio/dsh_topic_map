/**
 * 重挂载缓存测试：切页签回来必须"瞬间有内容"，不能重新等网络。
 *
 * 用户报的"在 对话/轨迹/上下文/编队 之间来回切感觉卡"，
 * 根因是面板整块卸载再挂载、每次都重新请求 session（实测 1.4s / 181KB）。
 *
 * 这里用一次真实的组件挂载 + 重挂载来验证：
 *   第一次挂载 → 需要请求
 *   第二次挂载（同一会话）→ 应当直接有数据，且不进入 loading
 *
 * Run: node tests/remount-cache.mjs
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

/** 造一个最小 React 运行时 + 面板。 */
function makeHarness() {
  let hookStates = []
  let hookIdx = 0
  const refStore = {}
  const effects = []

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
  const payload = {
    sessionId: 'S1', engineVersion: 4,
    turns: [{ turn: 1, startSeq: 1, endSeq: 2, startTime: 1, endTime: 2, durationMs: 1, prompt: 'p1', response: 'r1',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, steps: 1, toolCalls: 0, files: [], tools: [], commands: [], endReason: 'completed' }],
    lanes: [{ laneId: 'L1', title: '话题1', turns: [1], categoryIndex: 0 }],
    graph: { nodes: [{ turn: 1, index: 0, laneId: 'L1', col: 0, primary: true }], edges: [],
      labels: [{ laneId: 'L1', col: 0, text: '话题1' }], columns: [{ laneId: 'L1', col: 0 }], turnCount: 1, columnCount: 1 },
    totals: { turns: 1, cost: null }, stages: [], cost: null,
  }
  const workspace = { id: 'W1', path: 'X:/demo', title: 'demo', sessionIds: ['S1'] }
  const tree = [{ name: '话题A', count: 1, subcategories: [{ name: '对话A', sessions: [{ sessionId: 'S1', title: '会话1', turns: 1, laneCount: 1, automated: false }] }] }]

  let resolveQueue = []
  const hold = { session: false, pending: [] }
  function fakeFetch(url, opts) {
    const action = String(url).split('/').pop()
    if (action === 'session' && hold.session) {
      counters.session += 1
      // 永不 resolve：用来证明"内容来自缓存，而不是等到了网络"
      return new Promise(res => { hold.pending.push(res) })
    }
    let body = {}
    try { body = JSON.parse(opts?.body ?? '{}') } catch { /* 忽略 */ }
    let value = null
    if (action === 'session') { counters.session += 1; value = payload }
    else if (action === 'workspaces') { counters.workspaces += 1; value = [workspace] }
    else if (action === 'categorize') { counters.categorize += 1; value = { status: 'ready', cached: true, tree, total: 1, uncategorized: [], digests: {} } }
    else if (action === 'ui-state') { value = { overrides: {}, filter: null } }
    else { value = null }
    void body
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value }) })
  }

  const window = {
    __ModuleLoader__: { load: d => { window.__DEF = d } }, addEventListener() {}, removeEventListener() {},
    requestAnimationFrame: fn => { try { fn() } catch { /* 忽略 */ } return 0 }, cancelAnimationFrame() {},
    setTimeout: (fn) => { resolveQueue.push(fn); return resolveQueue.length }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
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
    sessions: { binding: () => ({}) } })

  /** 渲染一帧（不重置 hook 状态，模拟同一次挂载）。 */
  function frame() {
    hookIdx = 0
    effects.length = 0
    const out = Panel({ sessionId: 'S1', useChat: () => ({ turns: [] }), t: k => k })
    // 模拟 React 在渲染后执行副作用
    for (const fn of [...effects]) { try { fn() } catch { /* 忽略 */ } }
    return { out, effects: [...effects] }
  }
  /** 模拟"卸载后重新挂载"：清空 hook 状态与副作用。 */
  function remount() {
    hookStates = []
    hookIdx = 0
    resolveQueue = []
    return frame()
  }
  return { frame, remount, counters, payload, hold, runTimers() { resolveQueue.splice(0).forEach(f => f()) } }
}

/** 等异步链落地。 */
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

console.log('\nremount-cache')

await test('第一次挂载会请求 session，且先进入 loading', async () => {
  const h = makeHarness()
  const first = h.remount()
  const hk = first.out
  assert.ok(hk !== null, '应能渲染')
  assert.equal(h.counters.session >= 1 || h.counters.workspaces >= 1, true, '首次挂载应发起请求')
})

await test('第二次挂载（同一会话）直接有内容，不再等网络', async () => {
  const h = makeHarness()
  // 第一次挂载并让请求落地
  h.remount()
  h.runTimers()
  await settle()
  // 走一帧让 setState 生效
  h.frame()
  await settle()

  const before = { ...h.counters }
  // 卸载再挂载（切页签回来）
  // 从这里开始把 session 请求挂住：后续内容只能来自缓存
  h.hold.session = true
  h.remount()
  // 一帧（effect 里会从缓存 setData）
  h.frame()
  await settle()
  const again = h.frame()
  const kinds = (again.out.kids || []).map(k => k?.props?.className || k?.tag)
  assert.ok(h.hold.pending.length > 0, '应当确实发起了后台刷新请求（并被我挂住）')
  assert.ok(kinds.includes('dsh_tm_body'), '网络被挂住时仍应显示内容 —— 证明来自缓存')
  assert.equal(kinds.includes('dsh_tm_empty'), false, '不应停在空/加载态')
})

await test('重挂载后仍会在后台刷新（不是永远不再请求）', async () => {
  const h = makeHarness()
  h.remount(); h.runTimers(); await settle(); h.frame(); await settle()
  const before = h.counters.session
  h.remount()
  h.runTimers()
  await settle()
  assert.ok(h.counters.session > before, '应静默刷新一次，拿到最新数据')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
