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

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── 从 client.js 抽出接管段（常量 + RAILTAKE IIFE）──────────────────
function extractTakeover() {
  const start = src.indexOf('    var RAIL_NATIVE_KEY')
  assert.ok(start >= 0, 'client.js 里找不到 RAIL_NATIVE_KEY（接管段缺失）')
  const moduleStart = src.indexOf('    var RAILTAKE = (function () {', start)
  assert.ok(moduleStart >= 0, 'client.js 里找不到 RAILTAKE 段')
  const tail = src.indexOf('\n    })()', moduleStart)
  assert.ok(tail >= 0, 'RAILTAKE 段没有闭合')
  return src.slice(start, tail + '\n    })()'.length)
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

  /** 冒泡派发：真实 DOM 里 click 会冒泡到 rows 容器上的委托监听。 */
  dispatchEvent(event) {
    let node = this
    while (node !== null && node !== undefined) {
      const list = node.listeners === undefined ? undefined : node.listeners.get(event.type)
      if (list !== undefined) {
        for (const listener of list) {
          listener({
            type: event.type,
            target: this,
            currentTarget: node,
            clientX: event.clientX,
            preventDefault: function () {},
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
    return { top: this.top, bottom: this.top + this.height, height: this.height, left: 0, right: 100, width: 100 }
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
    this.body = new FakeElement('body', this)
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
    for (const listener of list) listener({ type, preventDefault: function () {}, clientX: event === undefined ? 0 : event.clientX })
  }
}

/** 假 window：定时器队列 + getComputedStyle + 存储。 */
function makeWindow(store) {
  const timers = []
  return {
    timers,
    setTimeout(fn) { timers.push(fn); return timers.length },
    clearTimeout() {},
    getComputedStyle() { return { right: '12px', top: '300px', maxHeight: '420px' } },
    addEventListener() {},
    removeEventListener() {},
    MutationObserver: class {
      constructor(callback) { this.callback = callback }
      observe() {}
      disconnect() {}
    },
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
  const win = makeWindow(store)
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
  const { RAILTAKE, dispose } = makeTakeover(scene.doc, { loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()

  assert.equal(scene.nav.style.visibility, 'hidden', '原生 nav 必须被隐藏')
  assert.equal(scene.nav.getAttribute('aria-hidden'), 'true')
  assert.equal(scene.nav.getAttribute('data-dsh-tm-native'), 'hidden')
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
  assert.equal(rail.getAttribute('data-tier'), 'normal', '默认 200px → 标准档')

  // 当前轮：aria-label「第 2 轮」→ 第 2 行 active
  assert.equal(rows[1].getAttribute('data-active'), '1')
  assert.equal(rows[0].getAttribute('data-active'), '0')

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
  assert.equal(rowButtons(scene.doc)[2].getAttribute('data-active'), '1', '点击后立即标记为活动')
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
  assert.equal(rowText(rows[0], 'dsh_tm_railtext'), '', '没有摘要时只显示轮号')
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
await test('宽度按会话记忆：读 localStorage 键还原档位', async () => {
  const scene = buildScene()
  const store = makeStore({ 'dsh.tm.rail.width.s1': '40' })
  const { dispose } = makeTakeover(scene.doc, { store, loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()
  assert.equal(railOf(scene.doc).getAttribute('data-tier'), 'hair')
  assert.equal(railOf(scene.doc).style.width, '40px')
  dispose()
})

await test('拖拽释放：吸附到 40/200/320 并写回本会话的键', async () => {
  const scene = buildScene()
  const store = makeStore({ 'dsh.tm.rail.width.s1': '40' })
  const { dispose, RAILTAKE } = makeTakeover(scene.doc, { store, loadOutline: () => Promise.resolve(OUTLINE) })
  await flush()

  const grip = railOf(scene.doc).querySelector('.dsh_tm_railgrip')
  grip.dispatchEvent({ type: 'pointerdown', clientX: 400 })
  scene.doc.dispatch('pointermove', { clientX: 110 }) // 向左拖 290px
  scene.doc.dispatch('pointerup', {})
  await flush()

  assert.equal(store.getItem('dsh.tm.rail.width.s1'), '320', '拖到最宽吸附 320 并记住')
  assert.equal(railOf(scene.doc).getAttribute('data-tier'), 'wide')
  assert.equal(RAILTAKE.widthOf(), 320)
  dispose()
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
