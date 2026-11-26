/**
 * 历史轨接管测试（V-12）：假 DOM harness。
 *
 * 为什么不在真实界面里测：接管是 DOM 级行为（隐藏原生 nav、插入自绘轨、
 * 点击跳转、开关恢复），在真实 DSH 里每跑一次都要开会话、等渲染，且无法
 * 断言「原生有没有被隐藏」这种中间状态。这里用一个只实现所需 API 的假 DOM，
 * 把 client.js 里的 RAILTAKE 段原样 eval 出来跑——测的是将要进 bundle 的那份代码。
 *
 * 覆盖验收要求的四条路径：
 *   1. 接管成功：原生被隐藏、自绘轨渲染、轮号/摘要正确；
 *   2. 失配：原生**不隐藏**、不渲染自绘轨、底部灰字写明原因；
 *   3. 点击：调用注入的跳转函数，参数正确；
 *   4. 开关：勾上恢复原生、撤掉自绘轨，再取消能重新接管。
 *
 * Run: node tests/rail-takeover.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import * as VIEW from '../lib/rail-view.js'
import { extractFunction } from './client-harness.mjs'

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── 从 client.js 抽出接管段（常量 + RAILTAKE IIFE）──────────────────
function extractTakeover() {
  const start = src.indexOf('    var RAIL_NATIVE_KEY')
  assert.ok(start >= 0, 'client.js 里找不到 RAIL_NATIVE_KEY（接管段缺失）')
  const moduleStart = src.indexOf('    var RAILTAKE = (function () {', start)
  assert.ok(moduleStart >= 0, 'client.js 里找不到 RAILTAKE 段')
  const tail = src.indexOf('\n    })()', moduleStart)
  assert.ok(tail >= 0, 'RAILTAKE 段没有闭合')
  const helperStart = src.indexOf('    function resolveActiveTurn')
  const helperEnd = src.indexOf('    var HISTORY_CATEGORY_EMPTY_TEXT', helperStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'client.js 里找不到当前轮单一事实源')
  return src.slice(helperStart, helperEnd) + '\n' + src.slice(start, tail + '\n    })()'.length)
}

const TAKEOVER = extractTakeover()

/** 假元素：只实现接管代码实际用到的 API。 */
class FakeElement {
  constructor(tag, owner) {
    this.tagName = String(tag).toUpperCase()
    this.ownerDocument = owner
    this.children = []
    this.attributes = new Map()
    this.style = {}
    this.className = ''
    this.textContent = ''
    this.parentElement = null
    this.listeners = new Map()
    this.scrollTop = 0
    this.clientHeight = 200
    this.offsetTop = 0
    this.offsetHeight = 22
    this.top = 0
    this.height = 40
    this.title = ''
    this.type = ''
  }

  get firstChild() { return this.children.length === 0 ? null : this.children[0] }

  // 真实 DOM 里 id 是反射属性；假元素也得反射，否则 getElementById 找不到灰字提示。
  get id() { const value = this.getAttribute('id'); return value === null ? '' : value }
  set id(value) { this.setAttribute('id', value) }

  get isConnected() {
    let node = this
    while (node !== null && node !== undefined) {
      if (node.tagName === 'BODY') return true
      node = node.parentElement
    }
    return false
  }

  appendChild(child) { return this.insertBefore(child, null) }

  insertBefore(child, reference) {
    if (child.parentElement !== null && child.parentElement !== undefined) child.parentElement.removeChild(child)
    let at = this.children.length
    if (reference !== null && reference !== undefined) {
      const found = this.children.indexOf(reference)
      if (found >= 0) at = found
    }
    this.children.splice(at, 0, child)
    child.parentElement = this
    return child
  }

  removeChild(child) {
    const at = this.children.indexOf(child)
    if (at >= 0) this.children.splice(at, 1)
    child.parentElement = null
    return child
  }

  setAttribute(name, value) { this.attributes.set(String(name), String(value)) }
  getAttribute(name) { return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null }
  removeAttribute(name) { this.attributes.delete(String(name)) }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || []
    const at = list.indexOf(listener)
    if (at >= 0) list.splice(at, 1)
  }

  setPointerCapture(pointerId) { this.capturedPointer = pointerId }
  releasePointerCapture(pointerId) {
    this.releasedPointer = pointerId
    if (this.capturedPointer === pointerId) this.capturedPointer = null
  }

  /** 冒泡派发：真实 DOM 里 click 会冒泡到 rows 容器上的委托监听。 */
  dispatchEvent(event) {
    let node = this
    while (node !== null && node !== undefined) {
      const list = node.listeners === undefined ? undefined : node.listeners.get(event.type)
      if (list !== undefined) {
        for (const listener of list) {
          listener({
            ...event,
            type: event.type,
            target: this,
            currentTarget: node,
            preventDefault: event.preventDefault || function () {},
            stopPropagation: event.stopPropagation || function () {},
          })
        }
      }
      node = node.parentElement
    }
  }

  querySelectorAll(selector) { return collect(this.children, selector) }
  querySelector(selector) { const found = this.querySelectorAll(selector); return found.length === 0 ? null : found[0] }

  closest(selector) {
    let node = this
    while (node !== null && node !== undefined) {
      if (node.tagName !== undefined && matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }

  getBoundingClientRect() {
    const width = this.width === undefined ? 100 : this.width
    return { top: this.top, bottom: this.top + this.height, height: this.height, left: 0, right: width, width }
  }
}

// ── 极简选择器：只支持本测试与接管代码用到的写法 ─────────────────────
function splitSelector(selector) {
  const parts = []
  let buffer = ''
  let quote = null
  let depth = 0
  for (const char of selector.trim()) {
    if (quote !== null) {
      buffer += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") { quote = char; buffer += char; continue }
    if (char === '[') depth += 1
    if (char === ']') depth -= 1
    if (char === ' ' && depth === 0) { if (buffer !== '') parts.push(buffer); buffer = ''; continue }
    buffer += char
  }
  if (buffer !== '') parts.push(buffer)
  return parts
}

function parseSimple(text) {
  const simple = { tag: null, id: null, classes: [], attrs: [] }
  let rest = text
  const tag = rest.match(/^[a-zA-Z][\w-]*/)
  if (tag !== null) { simple.tag = tag[0].toUpperCase(); rest = rest.slice(tag[0].length) }
  const re = /(?:\.([\w-]+))|#([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g
  let match = re.exec(rest)
  while (match !== null) {
    if (match[1] !== undefined) simple.classes.push(match[1])
    else if (match[2] !== undefined) simple.id = match[2]
    else simple.attrs.push([match[3], match[4] !== undefined ? match[4] : (match[5] !== undefined ? match[5] : match[6])])
    match = re.exec(rest)
  }
  return simple
}

function matchesSimple(element, simple) {
  if (simple.tag !== null && element.tagName !== simple.tag) return false
  if (simple.id !== null && element.getAttribute('id') !== simple.id) return false
  const classes = String(element.className === undefined ? '' : element.className).split(/\s+/).filter(Boolean)
  for (const name of simple.classes) if (!classes.includes(name)) return false
  for (const pair of simple.attrs) {
    if (!element.attributes.has(pair[0])) return false
    if (pair[1] !== null && pair[1] !== undefined && element.getAttribute(pair[0]) !== pair[1]) return false
  }
  return true
}

function matches(element, selector) {
  const parts = splitSelector(selector)
  if (parts.length === 0) return false
  if (!matchesSimple(element, parseSimple(parts[parts.length - 1]))) return false
  let cursor = element.parentElement
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const step = parseSimple(parts[i])
    let found = false
    while (cursor !== null && cursor !== undefined) {
      if (matchesSimple(cursor, step)) { found = true; cursor = cursor.parentElement; break }
      cursor = cursor.parentElement
    }
    if (!found) return false
  }
  return true
}

function collect(roots, selector) {
  const found = []
  const walk = node => {
    for (const child of node.children) {
      if (matches(child, selector)) found.push(child)
      walk(child)
    }
  }
  for (const root of roots) {
    if (matches(root, selector)) found.push(root)
    walk(root)
  }
  return found
}

/** 假 document：只支持 body / createElement / 选择器 / getElementById / 事件。 */
class FakeDocument {
  constructor() {
    this.listeners = new Map()
    this.head = new FakeElement('head', this)
    this.body = new FakeElement('body', this)
    this.head.ownerDocument = this
    this.body.ownerDocument = this
  }

  createElement(tag) { return new FakeElement(tag, this) }
  querySelectorAll(selector) { return collect([this.body], selector) }
  querySelector(selector) { const found = this.querySelectorAll(selector); return found.length === 0 ? null : found[0] }
  getElementById(id) { return this.querySelectorAll('#' + id)[0] || null }

  addEventListener(type, listener) {
    const list = this.listeners.get(type) || []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type, listener) {
    const list = this.listeners.get(type) || []
    const at = list.indexOf(listener)
    if (at >= 0) list.splice(at, 1)
  }

  dispatch(type, event) {
    const list = this.listeners.get(type) || []
    for (const listener of list) {
      listener({
        ...event,
        type,
        preventDefault: (event && event.preventDefault) || function () {},
        stopPropagation: (event && event.stopPropagation) || function () {},
        clientX: event === undefined ? 0 : event.clientX,
      })
    }
  }
}

/** 假 window：定时器队列 + getComputedStyle + 存储 + 可触发的 MutationObserver。 */
function makeWindow(store, settings) {
  const options = settings || {}
  const timers = []
  const observers = []
  let nextId = 1
  let computedStyleCalls = 0
  class FakeObserver {
    constructor(callback) {
      this.callback = callback
      this.target = null
      this.options = null
      this.connected = false
    }
    observe(target, options) {
      this.target = target
      this.options = options === undefined ? null : options
      this.connected = true
      observers.push(this)
    }
    disconnect() { this.connected = false }
    takeRecords() { return [] }
  }
  return {
    timers,
    observers,
    innerHeight: options.innerHeight === undefined ? 720 : options.innerHeight,
    innerWidth: options.innerWidth === undefined ? 1280 : options.innerWidth,
    setTimeout(fn, delay) {
      const timer = { id: nextId, delay: delay === undefined ? 0 : delay, fn, cancelled: false }
      nextId += 1
      timers.push(timer)
      return timer.id
    },
    clearTimeout(id) {
      for (const timer of timers) {
        if (timer.id === id) timer.cancelled = true
      }
    },
    /** 运行所有未取消的定时器（测试用；真实浏览器按 delay 等待）。 */
    runTimers() {
      const due = timers.splice(0)
      for (const timer of due) {
        if (!timer.cancelled) timer.fn()
      }
    },
    /** 向观察某节点的 MutationObserver 派发一批 mutation 记录。 */
    fireMutation(target, records) {
      for (const observer of observers) {
        if (observer.connected && observer.target === target) observer.callback(records)
      }
    },
    getComputedStyle(element) {
      computedStyleCalls += 1
      let visibility = 'visible'
      if (element !== null && element !== undefined && typeof element.getAttribute === 'function'
        && element.getAttribute('data-dsh-tm-native') === 'hidden') {
        visibility = 'hidden'
      }
      if (element !== null && element !== undefined && element.style !== undefined
        && element.style.visibility === 'hidden') visibility = 'hidden'
      if (options.nativeNeverHidden === true) visibility = 'visible'
      return { right: '12px', top: '300px', maxHeight: '420px', visibility }
    },
    getComputedStyleCalls() { return computedStyleCalls },
    addEventListener() {},
    removeEventListener() {},
    MutationObserver: FakeObserver,
    localStorage: store,
  }
}

function makeStore(initial) {
  const map = new Map(Object.entries(initial || {}))
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null },
    setItem(key, value) { map.set(key, String(value)) },
    removeItem(key) { map.delete(key) },
  }
}

// ── 场景搭建 ────────────────────────────────────────────────────────
function buildScene(options) {
  const settings = options || {}
  const doc = new FakeDocument()
  const session = doc.createElement('div')
  session.setAttribute('data-conversation-session', settings.sessionId === undefined ? 's1' : settings.sessionId)
  doc.body.appendChild(session)
  const scroller = doc.createElement('div')
  scroller.setAttribute('data-conversation-scroll', '')
  scroller.width = settings.containerWidth === undefined ? 1280 : settings.containerWidth
  scroller.height = settings.containerHeight === undefined ? 720 : settings.containerHeight
  session.appendChild(scroller)
  const slot = doc.createElement('div')
  slot.className = 'slot'
  scroller.appendChild(slot)

  let nav = null
  if (settings.withNav !== false) {
    nav = doc.createElement('nav')
    if (settings.navLabel !== null) nav.setAttribute('aria-label', settings.navLabel === undefined ? '轮次导航' : settings.navLabel)
    slot.appendChild(nav)
    const railScroller = doc.createElement('div')
    railScroller.className = 'scroller'
    nav.appendChild(railScroller)
    const marks = doc.createElement('div')
    marks.className = 'marks'
    railScroller.appendChild(marks)
    const count = settings.buttonCount === undefined ? 3 : settings.buttonCount
    for (let i = 0; i < count; i += 1) {
      const button = doc.createElement('button')
      button.setAttribute('data-index', String(i))
      button.setAttribute('aria-label', '跳转到第 ' + (i + 1) + ' 轮')
      if (settings.activeIndex === undefined ? i === 1 : i === settings.activeIndex) {
        button.setAttribute('aria-current', 'true')
      }
      marks.appendChild(button)
    }
  }

  // 对话轮次行：活动轮兜底用（aria-current 被虚拟化移出时）。
  const rows = settings.turnRows === undefined ? [] : settings.turnRows
  for (const turn of rows) {
    const row = doc.createElement('div')
    row.setAttribute('data-chat-turn', String(turn))
    row.top = 10 + turn
    scroller.appendChild(row)
  }

  return { doc, session, scroller, slot, nav }
}

function makeTakeover(doc, options) {
  const settings = options || {}
  const store = settings.store || makeStore()
  const win = makeWindow(store, settings)
  const calls = { jump: [], diag: [] }
  const factory = new Function('RAILVIEW', TAKEOVER + '\n;return RAILTAKE')
  const RAILTAKE = factory(VIEW)
  const dispose = RAILTAKE.start({
    document: doc,
    window: win,
    store,
    view: VIEW,
    loadOutline: settings.loadOutline || (() => Promise.resolve({ available: true, turns: [] })),
    jump: payload => { calls.jump.push(payload); return Promise.resolve({ ok: true }) },
    diag: message => calls.diag.push(message),
  })
  return { RAILTAKE, dispose, store, win, calls }
}

const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() }

function railOf(doc) { return doc.querySelector('.dsh_tm_rail') }

/** 可见轨数量：原生标记节点未 hidden 算一条，自绘轨算一条。 */
function visibleRailCount(doc, win) {
  let count = 0
  for (const nav of doc.querySelectorAll('nav')) {
    const computed = win.getComputedStyle(nav)
    if (computed.visibility !== 'hidden') count += 1
  }
  return count
}
function rowButtons(doc) {
  const rail = railOf(doc)
  if (rail === null) return []
  return rail.querySelectorAll('.dsh_tm_railrow')
}
function rowText(button, className) {
  const node = button.querySelector('.' + className)
  return node === null ? '' : node.textContent
}

const OUTLINE = {
  available: true,
  turns: [
    { turn: 1, promptHead: '第一轮：把跳转做准', time: '09:05', endSeq: 110 },
    { turn: 2, promptHead: '第二轮：接管原生轨', time: '09:20', endSeq: 220 },
    { turn: 3, promptHead: '第三轮：失配退路', time: '09:40', endSeq: 330 },
  ],
}

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nrail-takeover')

// ── 1. 接管成功 ────────────────────────────────────────────────────
await test('接管成功：原生被隐藏、自绘轨插在原位、行数与轮号正确', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose, win } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()

  assert.equal(scene.nav.style.visibility, 'hidden', '原生 nav 必须被隐藏')
  assert.equal(scene.nav.getAttribute('aria-hidden'), 'true')
  assert.equal(scene.nav.getAttribute('data-dsh-tm-native'), 'hidden')
  assert.equal(win.getComputedStyle(scene.nav).visibility, 'hidden', '计算样式也必须 hidden')
  const rail = railOf(scene.doc)
  assert.ok(rail !== null, '必须渲染自绘轨')
  assert.equal(rail.parentElement, scene.slot, '自绘轨与原生 nav 同父节点，才能共用定位上下文')
  assert.equal(scene.slot.children[0], rail, '自绘轨应在原生之前')
  assert.equal(scene.slot.children[1], scene.nav, '原生节点必须保留（退路与锚点）')

  const rows = rowButtons(scene.doc)
  assert.equal(rows.length, 3, '行数 = 大纲轮次数')
  assert.deepEqual(rows.map(row => row.getAttribute('data-turn')), ['1', '2', '3'])
  assert.deepEqual(rows.map(row => row.getAttribute('data-index')), ['0', '1', '2'])
  assert.equal(rowText(rows[0], 'dsh_tm_railnum'), '1')
  assert.equal(rowText(rows[0], 'dsh_tm_railtext'), '第一轮：把跳转做准')
  assert.equal(rowText(rows[0], 'dsh_tm_railtime'), '09:05')
  assert.equal(rail.getAttribute('data-tier'), 'std', '默认档位是标准')

  // 当前轮：aria-label「第 2 轮」→ 第 2 行 active
  assert.equal(rows[1].getAttribute('data-active'), '1')
  assert.equal(rows[0].getAttribute('data-active'), '0')

  dispose()
})

await test('双轨互斥：接管时只有一条可见轨；原生被替换后立即补打标', async () => {
  const scene = buildScene()
  const { RAILTAKE, win, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  assert.equal(visibleRailCount(scene.doc, win), 1, '原生隐藏 + 自绘轨 = 一条可见轨')

  // 模拟 React 重建 nav：旧节点移除，新节点没有标记和 inline style。
  const replacement = scene.doc.createElement('nav')
  replacement.setAttribute('aria-label', '轮次导航')
  const list = scene.doc.createElement('div')
  replacement.appendChild(list)
  for (let i = 0; i < 3; i += 1) {
    const button = scene.doc.createElement('button')
    button.setAttribute('data-index', String(i))
    button.setAttribute('aria-label', '跳转到第 ' + (i + 1) + ' 轮')
    if (i === 1) button.setAttribute('aria-current', 'true')
    list.appendChild(button)
  }
  scene.slot.appendChild(replacement)
  scene.slot.removeChild(scene.nav)
  win.fireMutation(scene.doc.body, [{ type: 'childList' }])
  win.runTimers()
  await flush()

  assert.equal(replacement.getAttribute('data-dsh-tm-native'), 'hidden', '新 nav 必须重新打标')
  assert.equal(replacement.style.visibility, 'hidden')
  assert.equal(visibleRailCount(scene.doc, win), 1, '替换过程中也不允许双轨并存')
  assert.equal(railOf(scene.doc) !== null, true)
  dispose()
})

await test('React 清掉 inline style / 标记：navObserver 立即补回 hidden', async () => {
  const scene = buildScene()
  const { win, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()

  scene.nav.style.visibility = ''
  scene.nav.removeAttribute('data-dsh-tm-native')
  win.fireMutation(scene.nav, [{ type: 'attributes', attributeName: 'style' }])
  await flush()
  assert.equal(scene.nav.style.visibility, 'hidden', 'inline style 必须补回')
  assert.equal(scene.nav.getAttribute('data-dsh-tm-native'), 'hidden', '属性必须补回')
  dispose()
})

await test('自检失败：拆掉自绘轨、保留原生、灰字写明「原生轨无法隐藏」', async () => {
  const scene = buildScene()
  const { win, calls, dispose } = makeTakeover(scene.doc, {
    loadOutline: () => Promise.resolve(OUTLINE),
    nativeNeverHidden: true,
  })
  await flush()
  win.runTimers()
  await flush()

  assert.equal(railOf(scene.doc), null, '自检失败必须移除自绘轨')
  assert.equal(scene.nav.style.visibility, '', '原生必须恢复可见')
  assert.equal(scene.nav.getAttribute('data-dsh-tm-native'), null)
  assert.equal(visibleRailCount(scene.doc, win), 1, '失败后只剩原生一条')
  const notice = scene.doc.getElementById('dsh_tm_rail_notice')
  assert.ok(notice !== null)
  assert.equal(notice.querySelector('.dsh_tm_railnoticetext').textContent, '历史轨未接管：原生轨无法隐藏')
  assert.ok(calls.diag.includes('原生轨无法隐藏'))
  dispose()
})

await test('三档宽度与内容：min 只有数字、std 摘要 10 字、max 多 HH:mm', async () => {
  const longOutline = {
    available: true,
    turns: [
      { turn: 1, promptHead: '一二三四五六七八九十十一十二', time: '9:05', endSeq: 10 },
      { turn: 2, promptHead: '', time: '09:20', endSeq: 20 },
      { turn: 3, promptHead: '第三轮', time: '23:07', endSeq: 30 },
    ],
  }
  const scene = buildScene()
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(longOutline) })
  await flush()
  const rail = railOf(scene.doc)
  assert.equal(rail.getAttribute('data-tier'), 'std', '默认 std')
  assert.equal(rowText(rowButtons(scene.doc)[0], 'dsh_tm_railtext'), '一二三四五六七八九十…', '10 字 + …')
  assert.ok(src.includes('[data-tier="std"] .dsh_tm_railtime'), 'std 用 CSS 隐藏时间')
  assert.equal(rowText(rowButtons(scene.doc)[1], 'dsh_tm_railtext'), '（无摘要）', '空摘要灰字占位')
  RAILTAKE.setTier('max')
  assert.equal(rail.getAttribute('data-tier'), 'max')
  assert.equal(rowText(rowButtons(scene.doc)[0], 'dsh_tm_railtime'), '09:05', '24 小时补零')
  assert.equal(rowText(rowButtons(scene.doc)[2], 'dsh_tm_railtime'), '23:07')
  RAILTAKE.setTier('min')
  assert.equal(rail.getAttribute('data-tier'), 'min')
  assert.equal(rowText(rowButtons(scene.doc)[0], 'dsh_tm_railnum'), '1', 'min 仍保留轮号')
  const num = rowButtons(scene.doc)[1].querySelector('.dsh_tm_railnum')
  num.scrollWidth = String(num.textContent).length * 7
  num.clientWidth = 28 - 8
  assert.ok(num.scrollWidth <= num.clientWidth, 'min 数字不裁切')
  assert.equal(rowButtons(scene.doc)[0].querySelectorAll('.dsh_tm_railtick').length, 1, 'min 保留刻度')
  dispose()
})

await test('档位循环 min → std → max → min，按钮 title 写明下一档', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rail = railOf(scene.doc)
  const btn = rail.querySelector('.dsh_tm_railcollapse')
  RAILTAKE.setTier('min'); assert.equal(rail.getAttribute('data-tier'), 'min')
  assert.ok(String(btn.title).includes('标准'), 'min 下一档是标准：' + btn.title)
  btn.dispatchEvent({ type: 'click' }); assert.equal(rail.getAttribute('data-tier'), 'std')
  btn.dispatchEvent({ type: 'click' }); assert.equal(rail.getAttribute('data-tier'), 'max')
  btn.dispatchEvent({ type: 'click' }); assert.equal(rail.getAttribute('data-tier'), 'min')
  dispose()
})

await test('Alt+[ 在 min 与上次档位间切换，不循环', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rail = railOf(scene.doc)
  RAILTAKE.setTier('max')
  scene.doc.dispatch('keydown', { altKey: true, code: 'BracketLeft', key: '[' })
  assert.equal(rail.getAttribute('data-tier'), 'min')
  scene.doc.dispatch('keydown', { altKey: true, code: 'BracketLeft', key: '[' })
  assert.equal(rail.getAttribute('data-tier'), 'max', '回到上次 max，而不是 std')
  dispose()
})

await test('按会话记忆档位：默认 std，读 tier.s1 还原 max', async () => {
  const scene = buildScene()
  const { dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  assert.equal(railOf(scene.doc).getAttribute('data-tier'), 'std')
  dispose()
  const scene2 = buildScene()
  const second = makeTakeover(scene2.doc, {
    store: makeStore({ 'dsh.tm.rail.tier.s1': 'max' }),
    loadOutline: () => Promise.resolve(OUTLINE),
  })
  await flush()
  assert.equal(railOf(scene2.doc).getAttribute('data-tier'), 'max')
  second.dispose()
})

await test('自动收起：离开 600ms 进 min，移入回用户档位；不写 tier', async () => {
  const scene = buildScene()
  const { RAILTAKE, win, store, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rail = railOf(scene.doc)
  RAILTAKE.setTier('std')
  rail.dispatchEvent({ type: 'pointerleave' })
  assert.equal(rail.getAttribute('data-tier'), 'std', '600ms 前不动')
  win.runTimers()
  assert.equal(rail.getAttribute('data-tier'), 'min', '600ms 后进 min')
  assert.equal(store.getItem('dsh.tm.rail.tier.s1'), 'std', '自动收起不改用户档位')
  rail.dispatchEvent({ type: 'pointerenter' })
  win.runTimers()
  assert.equal(rail.getAttribute('data-tier'), 'std', '移入回 std')
  dispose()
})

await test('宽度公式：700 / 1200 / 2000 容器下 std/max 落在范围，std < max', async () => {
  for (const width of [700, 1200, 2000]) {
    const scene = buildScene({ containerWidth: width })
    const { RAILTAKE, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
    await flush()
    const rail = railOf(scene.doc)
    const narrow = width < 900
    const stdLow = narrow ? 140 : 150
    const expectedStd = Math.min(240, Math.max(stdLow, Math.round(width * 0.16)))
    const expectedMax = Math.min(narrow ? 280 : 340, Math.max(200, Math.round(width * 0.22)))
    RAILTAKE.setTier('std')
    assert.equal(rail.style['--dsh-tm-rail-visible-width'], expectedStd + 'px', width + ' std')
    RAILTAKE.setTier('max')
    assert.equal(rail.style['--dsh-tm-rail-visible-width'], expectedMax + 'px', width + ' max')
    assert.ok(expectedStd < expectedMax, 'std < max')
    assert.ok(rail.style.clipPath !== undefined)
    dispose()
  }
})

await test('源码不再有 railgrip / dsh.tm.rail.width / data-collapsed', async () => {
  assert.equal(src.includes('dsh_tm_railgrip'), false)
  assert.equal(src.includes('dsh.tm.rail.width'), false)
  assert.equal(src.includes('dsh_tm_rail[data-collapsed'), false)
  assert.ok(src.includes('--dsh-tm-rail-visible-width'))
  assert.ok(src.includes('clamp(18px,1.6vh,24px)'))
  assert.ok(src.includes('clamp(10px,0.75vw,12px)'))
  assert.ok(src.includes('clamp(4px,0.5vh,8px)'))
  assert.equal(src.includes('max-height:420px'), false, '轨道高度不能写死 420px')
  assert.ok(src.includes('max-height:50vh') || src.includes("maxHeight = Math.max(120"))
})

await test('抽屉覆盖模式：setDockObscured 临时隐藏自绘轨，关闭后恢复', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rail = railOf(scene.doc)
  assert.equal(rail.style.visibility === undefined ? '' : rail.style.visibility, '')
  RAILTAKE.setDockObscured(true)
  assert.equal(rail.style.visibility, 'hidden')
  RAILTAKE.setDockObscured(false)
  assert.equal(rail.style.visibility === undefined ? '' : rail.style.visibility, '')
  dispose()
})

await test('接管成功：aria-label 文案变了也能按结构找到原生轨', async () => {
  // 宿主 locale 改文案时，两个 aria-label 选择器都会落空；结构兜底必须生效。
  const scene = buildScene({ navLabel: null })
  const { dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  assert.equal(scene.nav.style.visibility, 'hidden', '结构兜底也要能接管')
  assert.equal(rowButtons(scene.doc).length, 3)
  dispose()
})

await test('接管成功：活动轮跟随原生 aria-current 变化', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rows = rowButtons(scene.doc)
  assert.equal(rows[1].getAttribute('data-active'), '1')

  // 原生把 aria-current 挪到第 3 个按钮
  const buttons = scene.nav.querySelectorAll('button[data-index]')
  buttons[1].removeAttribute('aria-current')
  buttons[2].setAttribute('aria-current', 'true')
  RAILTAKE.sync()
  await flush()
  assert.equal(rowButtons(scene.doc)[2].getAttribute('data-active'), '1', '自绘轨活动行要跟着走')
  assert.equal(rowButtons(scene.doc)[1].getAttribute('data-active'), '0')
  dispose()
})

// ── 2. 点击跳转 ─────────────────────────────────────────────────────
await test('点击行：调用跳转函数，带上轮号、seq、会话与轮次表', async () => {
  const scene = buildScene()
  const { dispose, calls } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rows = rowButtons(scene.doc)
  rows[2].dispatchEvent({ type: 'click' })
  await flush()

  assert.equal(calls.jump.length, 1)
  const payload = calls.jump[0]
  assert.equal(payload.turn, 3)
  assert.equal(payload.seq, 330, '大纲里的 endSeq 要传给定位逻辑')
  assert.equal(payload.sessionId, 's1')
  assert.deepEqual(payload.turns, [1, 2, 3])
  assert.equal(payload.nav, scene.nav, '优先点本会话的原生按钮，而不是全局第一个 nav')
  assert.equal(rowButtons(scene.doc)[2].getAttribute('data-active'), '0', '点击不再手动写死 active，交给 resolveActiveTurn')
  dispose()
})

await test('大纲乱序 / 重复：按 turn 升序去重后再与 data-index 对齐', async () => {
  const scene = buildScene()
  const unsorted = {
    available: true,
    turns: [
      { turn: 3, promptHead: '第三轮', endSeq: 30 },
      { turn: 1, promptHead: '第一轮', endSeq: 10 },
      { turn: 2, promptHead: '第二轮', endSeq: 20 },
      { turn: 1, promptHead: '重复的第一轮', endSeq: 10 },
    ],
  }
  const { dispose, calls } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(unsorted) })
  await flush()
  const rows = rowButtons(scene.doc)
  assert.deepEqual(rows.map(row => row.getAttribute('data-turn')), ['1', '2', '3'], '必须升序去重')
  assert.deepEqual(rows.map(row => row.getAttribute('data-index')), ['0', '1', '2'])
  assert.equal(rowText(rows[0], 'dsh_tm_railtext'), '第一轮')
  rows[2].dispatchEvent({ type: 'click' })
  await flush()
  assert.equal(calls.jump[0].seq, 30, '重排后 seq 仍跟着轮号走')
  dispose()
})

// ── 3. 失配：不隐藏原生 ─────────────────────────────────────────────
await test('失配（容器在但没有按钮）：不隐藏原生、不渲染自绘轨、底部灰字给原因', async () => {
  const scene = buildScene({ buttonCount: 0 })
  const { dispose } = makeTakeover(scene.doc)
  await flush()

  assert.equal(scene.nav.style.visibility, '', '失配时绝不能隐藏原生')
  assert.equal(scene.nav.getAttribute('aria-hidden'), null)
  assert.equal(railOf(scene.doc), null, '失配时不能渲染半成品自绘轨')
  const notice = scene.doc.getElementById('dsh_tm_rail_notice')
  assert.ok(notice !== null, '失配必须留一行灰字')
  const text = notice.querySelector('.dsh_tm_railnoticetext').textContent
  assert.ok(text.includes('原生导航轨没有轮次按钮'), '灰字要写清具体原因：' + text)
  assert.ok(text.includes('继续使用原生导航'))
  dispose()
})

await test('失配灰字可关闭，关闭后同一原因不再弹', async () => {
  const scene = buildScene({ buttonCount: 0 })
  const { RAILTAKE, dispose } = makeTakeover(scene.doc)
  await flush()
  const notice = scene.doc.getElementById('dsh_tm_rail_notice')
  notice.querySelector('.dsh_tm_railnoticex').dispatchEvent({ type: 'click' })
  assert.equal(scene.doc.getElementById('dsh_tm_rail_notice'), null)

  RAILTAKE.sync()
  assert.equal(scene.doc.getElementById('dsh_tm_rail_notice'), null, '同一原因不重复打扰')
  dispose()
})

await test('没有原生轨（轮次 < 2 / 未挂载）：静默，不报错也不弹灰字', async () => {
  const scene = buildScene({ withNav: false })
  const { dispose, calls } = makeTakeover(scene.doc)
  await flush()
  assert.equal(railOf(scene.doc), null)
  assert.equal(scene.doc.getElementById('dsh_tm_rail_notice'), null)
  assert.deepEqual(calls.diag, [], '这不是失配，不该写诊断')
  dispose()
})

// ── 4. 大纲不可用 → 优雅降级 ────────────────────────────────────────
await test('大纲接口 404：用原生 aria-label 轮号渲染，并标注降级', async () => {
  const scene = buildScene()
  const { dispose } = makeTakeover(scene.doc, {
    loadOutline: () => Promise.resolve({ available: false, turns: [] }),
  })
  await flush()

  const rows = rowButtons(scene.doc)
  assert.equal(rows.length, 3, '降级也要有刻度，不能白屏')
  assert.deepEqual(rows.map(row => row.getAttribute('data-turn')), ['1', '2', '3'])
  assert.equal(rowText(rows[0], 'dsh_tm_railtext'), '（无摘要）', '没有摘要时显示灰字占位')
  const note = railOf(scene.doc).querySelector('.dsh_tm_railnote')
  assert.ok(note.textContent.includes('轮次摘要不可用'), '要说明为什么没有摘要：' + note.textContent)
  dispose()
})

await test('大纲端点抛错：同样降级，不把异常抛给宿主', async () => {
  const scene = buildScene()
  const { dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.reject(new Error('boom')) })
  await flush()
  assert.equal(rowButtons(scene.doc).length, 3)
  dispose()
})

// ── 5. 设置开关 ─────────────────────────────────────────────────────
await test('开关：勾上「恢复原生」立即撤掉自绘轨并恢复 display；取消后重新接管', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose, store } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  assert.equal(scene.nav.style.visibility, 'hidden')

  RAILTAKE.setNativePreferred(true)
  assert.equal(store.getItem('dsh.tm.rail.native'), '1')
  assert.equal(scene.nav.style.visibility, '', '恢复原生 display')
  assert.equal(scene.nav.getAttribute('aria-hidden'), null)
  assert.equal(railOf(scene.doc), null, '自绘轨必须撤掉')
  assert.equal(RAILTAKE.nativePreferred(), true)

  RAILTAKE.setNativePreferred(false)
  assert.equal(store.getItem('dsh.tm.rail.native'), '0')
  assert.ok(railOf(scene.doc) !== null, '取消勾选立即重新接管')
  assert.equal(scene.nav.style.visibility, 'hidden')
  assert.equal(RAILTAKE.nativePreferred(), false)
  dispose()
})

await test('开关偏好跨启动保持：native=1 时启动不接管', async () => {
  const scene = buildScene()
  const store = makeStore({ 'dsh.tm.rail.native': '1' })
  const { dispose } = makeTakeover(scene.doc, { store })
  await flush()
  assert.equal(scene.nav.style.visibility || '', '', '启动时就不接管，不动原生')
  assert.equal(railOf(scene.doc), null)
  dispose()
})

// ── 6. 三档宽度与按会话记忆 ─────────────────────────────────────────
await test('设置与头部按钮同步：setTier 写入同一份偏好', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose, store } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rail = railOf(scene.doc)
  RAILTAKE.setTier('max')
  assert.equal(store.getItem('dsh.tm.rail.tier.s1'), 'max')
  assert.equal(RAILTAKE.tier(), 'max')
  assert.equal(RAILTAKE.effectiveTier(), 'max')
  assert.equal(rail.getAttribute('data-tier'), 'max')
  assert.equal(rail.querySelector('.dsh_tm_railcollapse').textContent, '≡')
  RAILTAKE.setTier('min')
  assert.equal(rail.querySelector('.dsh_tm_railcollapse').textContent, '⌄')
  dispose()
})

await test('抽屉覆盖模式：setDockObscured', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rail = railOf(scene.doc)
  RAILTAKE.setDockObscured(true)
  assert.equal(rail.style.visibility, 'hidden')
  RAILTAKE.setDockObscured(false)
  assert.equal(rail.style.visibility, '')
  dispose()
})

await test('min 档按最大轮号位数：1/2/3/4 位数字完整且保留刻度', async () => {
  for (const maxTurn of [7, 12, 112, 1120]) {
    const outline = {
      available: true,
      turns: [
        { turn: 1, promptHead: '一', endSeq: 10 },
        { turn: maxTurn, promptHead: '最大轮', endSeq: maxTurn * 10 },
      ],
    }
    const scene = buildScene()
    const { RAILTAKE, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(outline) })
    await flush()
    RAILTAKE.setTier('min')
    const rail = railOf(scene.doc)
    const expected = Math.min(44, Math.max(28, String(maxTurn).length * 7 + 10))
    assert.equal(rail.style['--dsh-tm-rail-visible-width'], expected + 'px')
    const nums = rail.querySelectorAll('.dsh_tm_railnum')
    assert.deepEqual(nums.map(node => node.textContent), ['1', String(maxTurn)])
    assert.equal(rail.querySelectorAll('.dsh_tm_railtick').length, 2)
    for (const num of nums) {
      num.scrollWidth = String(num.textContent).length * 7
      num.clientWidth = expected - 8
      assert.ok(num.scrollWidth <= num.clientWidth, `${maxTurn} 数字不裁切`)
    }
    dispose()
  }
})

await test('容器滚动改变 → 轨道 active 跟着变，行节点引用不变', async () => {
  const scene = buildScene({ turnRows: [1, 2, 3] })
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rows = rowButtons(scene.doc)
  const turnNodes = scene.scroller.querySelectorAll('[data-chat-turn]')
  turnNodes[0].top = 100
  turnNodes[1].top = 300
  turnNodes[2].top = 500
  RAILTAKE.sync()
  assert.equal(RAILTAKE.currentTurn(), 1, '顶部第一条完整可见轮 = 1')
  turnNodes[0].top = -100
  turnNodes[1].top = 50
  turnNodes[2].top = 250
  RAILTAKE.sync()
  assert.equal(RAILTAKE.currentTurn(), 2, '滚动后 active 跟到 2')
  assert.equal(rows[1].getAttribute('data-active'), '1')
  assert.equal(rows[0], rowButtons(scene.doc)[0], '滚动不重建行节点')
  dispose()
})

await test('程序化跳转 3 次重试：命中目标后 active 停在目标轮', async () => {
  const scene = buildScene({ turnRows: [1, 2, 3] })
  const { RAILTAKE, win, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const turnNodes = scene.scroller.querySelectorAll('[data-chat-turn]')
  turnNodes[0].top = 100
  turnNodes[1].top = 300
  turnNodes[2].top = 500
  RAILTAKE.sync()
  rowButtons(scene.doc)[2].dispatchEvent({ type: 'click' })
  turnNodes[0].top = -300
  turnNodes[1].top = -100
  turnNodes[2].top = 20
  win.runTimers()
  await flush()
  assert.equal(RAILTAKE.currentTurn(), 3, '重试后自然落到目标轮')
  assert.equal(rowButtons(scene.doc)[2].getAttribute('data-active'), '1')
  dispose()
})

await test('程序化跳转仍不匹配：以实际可见轮为准，不卡在目标值', async () => {
  const scene = buildScene({ turnRows: [1, 2, 3] })
  const { RAILTAKE, win, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const turnNodes = scene.scroller.querySelectorAll('[data-chat-turn]')
  turnNodes[0].top = 100
  turnNodes[1].top = 300
  turnNodes[2].top = 500
  RAILTAKE.sync()
  rowButtons(scene.doc)[2].dispatchEvent({ type: 'click' })
  // 跳转失败：实际仍停在轮 1。
  win.runTimers()
  await flush()
  assert.equal(RAILTAKE.currentTurn(), 1, '不能硬撑目标 3')
  assert.equal(rowButtons(scene.doc)[0].getAttribute('data-active'), '1')
  dispose()
})

await test('轨道整体高度自适应：<500 容器用 40vh，普通容器用 50vh', async () => {
  for (const [height, innerHeight, expected] of [[720, 720, 360], [400, 720, 288]]) {
    const scene = buildScene({ containerHeight: height })
    const { win, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE), innerHeight })
    await flush()
    assert.equal(railOf(scene.doc).style.maxHeight, expected + 'px', height + ' 高容器')
    dispose()
  }
})

await test('滚动只更新 data-active：轨节点与行节点引用都不变', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose, win } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rail = railOf(scene.doc)
  const before = rowButtons(scene.doc)
  assert.equal(before.length, 3)

  // 原生 aria-current 挪到第 3 轮，然后模拟滚动（宿主虚拟列表会更新 DOM）。
  const nativeButtons = scene.nav.querySelectorAll('button[data-index]')
  nativeButtons[1].removeAttribute('aria-current')
  nativeButtons[2].setAttribute('aria-current', 'true')
  scene.doc.dispatch('scroll')
  win.runTimers()

  assert.equal(railOf(scene.doc), rail, '滚动不能替换整条轨')
  const after = rowButtons(scene.doc)
  after.forEach((row, index) => assert.equal(row, before[index], '滚动不能重建行节点'))
  assert.equal(after[2].getAttribute('data-active'), '1')
  assert.equal(after[1].getAttribute('data-active'), '0')

  for (let i = 0; i < 5; i += 1) RAILTAKE.sync()
  assert.equal(railOf(scene.doc), rail, 'sync() 幂等：同 nav / 同行集合不重建')
  rowButtons(scene.doc).forEach((row, index) => assert.equal(row, after[index]))

  // syncNow 快路径不能再读 getComputedStyle / 重写几何，否则流式输出期间会持续布局抖动。
  let styleReads = 0
  const originalStyle = win.getComputedStyle.bind(win)
  win.getComputedStyle = function () {
    styleReads += 1
    return originalStyle()
  }
  const rightBefore = rail.style.right
  for (let i = 0; i < 5; i += 1) RAILTAKE.sync()
  assert.equal(styleReads, 0, '幂等 sync 不应再读样式')
  assert.equal(rail.style.right, rightBefore, '幂等 sync 不应重写定位')
  dispose()
})

await test('结构 Mutation 才重建行；aria-current Mutation 只切属性', async () => {
  const scene = buildScene()
  const { dispose, win } = makeTakeover(scene.doc, {
    loadOutline: () => Promise.resolve({ available: false, turns: [] }),
  })
  await flush()
  const before = rowButtons(scene.doc)
  assert.equal(before.length, 3)

  // 只有 aria-current：不重建。
  const nativeButtons = scene.nav.querySelectorAll('button[data-index]')
  nativeButtons[0].removeAttribute('aria-current')
  nativeButtons[1].setAttribute('aria-current', 'true')
  win.fireMutation(scene.nav, [{ type: 'attributes', attributeName: 'aria-current' }])
  win.runTimers()
  rowButtons(scene.doc).forEach((row, index) => assert.equal(row, before[index], 'aria-current 不触发重建'))

  // 原生按钮集合变化：新增第 4 轮，结构 Mutation 后补一行。
  const button = scene.doc.createElement('button')
  button.setAttribute('data-index', '3')
  button.setAttribute('aria-label', '跳转到第 4 轮')
  scene.nav.appendChild(button)
  win.fireMutation(scene.nav, [{ type: 'childList', target: scene.nav, addedNodes: [button] }])
  win.runTimers()
  const after = rowButtons(scene.doc)
  assert.equal(after.length, 4, '按钮集合变化后行集合要重建')
  assert.equal(after[3].getAttribute('data-turn'), '4')
  dispose()
})

// ── 6d. 偏好同步 / rail 自己 ⋯ 菜单 ────────────────────────────────
await test('偏好同步：setter 写同一份 localStorage，其它实例/订阅者立即可见', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose, store } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  let notified = 0
  const unsubscribe = RAILTAKE.subscribe(() => { notified += 1 })

  RAILTAKE.setNativePreferred(false)
  RAILTAKE.setAutoHide(false)
  RAILTAKE.setTier('max')
  assert.ok(notified >= 3, '每个 setter 都应通知订阅者（设置页据此重渲染）')
  assert.equal(store.getItem('dsh.tm.rail.native'), '0')
  assert.equal(store.getItem('dsh.tm.rail.autohide'), '0')
  assert.equal(store.getItem('dsh.tm.rail.tier.s1'), 'max')
  assert.equal(RAILTAKE.tier(), 'max')

  // 第二个实例模拟另一处设置面：读同一份 store，必须看到刚写的值。
  const scene2 = buildScene()
  const second = makeTakeover(scene2.doc, { store, loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  assert.equal(second.RAILTAKE.nativePreferred(), false)
  assert.equal(second.RAILTAKE.autoHideEnabled(), false)
  assert.equal(second.RAILTAKE.tier(), 'max')
  assert.equal(railOf(scene2.doc).getAttribute('data-tier'), 'max')
  second.dispose()
  unsubscribe()
  dispose()
})

await test('rail ⋯ 菜单：恢复原生 / 自动隐藏 / 切换档位都走同一套 setter', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose, store } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rail = railOf(scene.doc)
  const more = rail.querySelector('.dsh_tm_railmore')
  assert.ok(more !== null)
  assert.equal(RAILTAKE.autoHideEnabled(), true)

  more.dispatchEvent({ type: 'click' })
  let menu = rail.querySelector('.dsh_tm_railmenu')
  assert.ok(menu !== null, '⋯ 应打开菜单')
  let items = menu.querySelectorAll('.dsh_tm_railmenuitem')
  const labelOf = node => node.querySelector('.dsh_tm_railmenutext').textContent
  assert.deepEqual(items.map(labelOf), ['恢复原生导航轨', '自动隐藏', '切换显示档位'])

  items.find(item => labelOf(item) === '自动隐藏').dispatchEvent({ type: 'click' })
  assert.equal(store.getItem('dsh.tm.rail.autohide'), '0', '菜单开关写共享键')
  assert.equal(rail.querySelector('.dsh_tm_railmenu'), null, '点完关闭菜单')

  RAILTAKE.setTier('std')
  more.dispatchEvent({ type: 'click' })
  items = rail.querySelector('.dsh_tm_railmenu').querySelectorAll('.dsh_tm_railmenuitem')
  items.find(item => labelOf(item) === '切换显示档位').dispatchEvent({ type: 'click' })
  assert.equal(rail.getAttribute('data-tier'), 'max')
  dispose()
})

// ── 6e. 原生模式的切回药丸 / 命中标记 ────────────────────────────────
await test('原生模式：右缘药丸存在，点击写 native=0 并立即接管', async () => {
  const scene = buildScene()
  const store = makeStore({ 'dsh.tm.rail.native': '1' })
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { store, loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()

  assert.equal(railOf(scene.doc), null, '原生模式不应挂自绘轨')
  assert.equal(scene.nav.style.visibility || '', '', '原生轨保持可见')
  const pill = scene.doc.querySelector('.dsh_tm_railrestore')
  assert.ok(pill !== null, '原生模式必须在对话容器右缘给一个切回入口')
  assert.equal(pill.getAttribute('aria-label'), '启用插件导航轨')
  assert.equal(pill.title, '启用插件导航轨')

  pill.dispatchEvent({ type: 'click' })
  await flush()
  assert.equal(store.getItem('dsh.tm.rail.native'), '0', '点击药丸写同一个 localStorage 键')
  assert.equal(RAILTAKE.nativePreferred(), false)
  assert.ok(railOf(scene.doc) !== null, '点击后立即接管')
  assert.equal(scene.nav.style.visibility, 'hidden')
  assert.equal(scene.doc.querySelector('.dsh_tm_railrestore'), null, '接管后药丸必须消失')
  dispose()
})

await test('Alt+[ 在原生模式下切回插件轨；插件轨下进 min', async () => {
  const scene = buildScene()
  const store = makeStore({ 'dsh.tm.rail.native': '1' })
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { store, loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  assert.equal(railOf(scene.doc), null)

  scene.doc.dispatch('keydown', { altKey: true, code: 'BracketLeft', key: '[' })
  await flush()
  assert.equal(store.getItem('dsh.tm.rail.native'), '0', '原生模式 Alt+[ 应切回插件轨')
  assert.ok(railOf(scene.doc) !== null)

  scene.doc.dispatch('keydown', { altKey: true, code: 'BracketLeft', key: '[' })
  assert.equal(railOf(scene.doc).getAttribute('data-tier'), 'min', '插件轨下 Alt+[ 进 min')

  RAILTAKE.setNativePreferred(true)
  await flush()
  assert.ok(scene.doc.querySelector('.dsh_tm_railrestore') !== null, '设置开关切到原生也要出现药丸')
  dispose()
})

await test('命中标记：整组替换、越界轮号忽略、清空写 localStorage', async () => {
  const scene = buildScene()
  const { RAILTAKE, dispose, store } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  assert.equal(rowButtons(scene.doc).filter(row => row.getAttribute('data-hit') === '1').length, 0)

  RAILTAKE.setHits('s1', [2, 99])
  let rows = rowButtons(scene.doc)
  assert.equal(rows[1].getAttribute('data-hit'), '1', '第 2 轮命中')
  assert.equal(rowButtons(scene.doc).filter(row => row.getAttribute('data-hit') === '1').length, 1,
    '不在大纲里的第 99 轮应被忽略，不报错')
  assert.deepEqual(JSON.parse(store.getItem('dsh.tm.rail.hits.s1')), [2, 99], '命中集合写入 localStorage')

  RAILTAKE.setHits('s1', [3])
  rows = rowButtons(scene.doc)
  assert.equal(rows[1].getAttribute('data-hit'), null, '换一组命中要整组替换')
  assert.equal(rows[2].getAttribute('data-hit'), '1')
  assert.deepEqual(RAILTAKE.hitsOf('s1'), [3])

  RAILTAKE.setHits('s1', [])
  assert.equal(rowButtons(scene.doc).filter(row => row.getAttribute('data-hit') === '1').length, 0)
  assert.deepEqual(JSON.parse(store.getItem('dsh.tm.rail.hits.s1')), [], '清空也要落盘，避免旧标记复活')
  dispose()
})

await test('命中标记：轨道重挂载后从 localStorage 恢复；别的会话不串台', async () => {
  const scene = buildScene()
  const store = makeStore({ 'dsh.tm.rail.hits.s1': '[1,3]' })
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { store, loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  const rows = rowButtons(scene.doc)
  assert.equal(rows[0].getAttribute('data-hit'), '1')
  assert.equal(rows[1].getAttribute('data-hit'), null)
  assert.equal(rows[2].getAttribute('data-hit'), '1')

  RAILTAKE.setHits('s2', [2])
  assert.equal(rowButtons(scene.doc)[1].getAttribute('data-hit'), null, '别的会话的命中不能标到当前轨')
  assert.deepEqual(JSON.parse(store.getItem('dsh.tm.rail.hits.s2')), [2])
  dispose()
})

await test('设置页索引体积文案（纯函数）：12 个会话 · 3.2 MB', async () => {
  const source = [
    extractFunction(src, 'formatIndexBytes'),
    extractFunction(src, 'indexStatsText'),
  ].join('\n')
  const api = new Function(`${source};return { indexStatsText: indexStatsText, formatIndexBytes: formatIndexBytes }`)()
  assert.equal(api.formatIndexBytes(3355443), '3.2 MB')
  assert.equal(api.indexStatsText({ sessions: 12, bytes: 3355443 }), '12 个会话 · 3.2 MB')
  assert.equal(api.indexStatsText({ sessions: 0, bytes: 0 }), '0 个会话 · 0 B')
  assert.equal(api.indexStatsText(null), '—')
})

// ── 7. 卸载 ────────────────────────────────────────────────────────
await test('dispose：撤掉自绘轨并把原生恢复（插件卸载/热重载）', async () => {
  const scene = buildScene()
  const { dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  assert.ok(railOf(scene.doc) !== null)
  dispose()
  assert.equal(railOf(scene.doc), null)
  assert.equal(scene.nav.style.visibility, '')
  assert.equal(scene.doc.getElementById('dsh_tm_rail_notice'), null)
})

// ── 汇总 ───────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.log(`\n${passed} passed, ${failures.length} failed`)
  for (const failure of failures) console.log(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
console.log(`\n${passed} passed`)
