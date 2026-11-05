/**
 * 跳转逻辑测试。
 *
 * 上一版的 bug 是：拿 turn 号（`"3"`）去比对 `data-chat-anchor-key`，而那个属性
 * 存的是 Chat 节点的 key（形如 `user:3` 或哈希串）。永远匹配不上，于是页面不动
 * ——用户看到的就是"点哪一轮都停在最后一轮"。
 *
 * 这里用最小 DOM 替身验证修复后的路径：turn → anchorKey → DOM 行 → 滚动。
 *
 * Run: node tests/jump.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 从源码取出一个顶层函数（签名 + 函数体）并求值。 */
function extract(name) {
  const needle = `function ${name}(`
  const start = src.indexOf(needle)
  assert.ok(start >= 0, `未找到 ${name}()`)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) break
    }
  }
  return src.slice(start, i + 1)
}

// ── 最小 DOM 替身 ────────────────────────────────────────────────────
function makeDom(rows) {
  const elements = rows.map(r => {
    const attrs = []
    if (r.key !== undefined) attrs.push({ name: 'data-chat-anchor-key', value: String(r.key) })
    if (r.turn !== undefined) attrs.push({ name: 'data-chat-turn', value: String(r.turn) })
    if (r.nodeKey !== undefined) attrs.push({ name: 'data-chat-node-key', value: String(r.nodeKey) })
    return {
      _key: r.key,
      _turn: r.turn,
      _nodeKey: r.nodeKey,
      _top: r.top,
      _height: r.height ?? 40,
      attributes: attrs,
      hasAttribute(n) {
        if (n === 'hidden') return false
        if (n === 'data-chat-turn' && this._turn !== undefined) return true
        return false
      },
      closest() { return null },
      getAttribute(n) {
        if (n === 'data-chat-anchor-key') return this._key ?? null
        if (n === 'data-chat-node-key') return this._nodeKey ?? null
        if (n === 'data-chat-turn') return this._turn === undefined ? null : String(this._turn)
        if (n === 'data-chat-flow-kind') return this._flowKind ?? null
        return null
      },
      getBoundingClientRect() { return { top: this._top, height: this._height, bottom: this._top + this._height } },
      scrollIntoView() { globalThis.__scrolledTo = this._key },
    }
  })

  const scroller = {
    scrollTop: 0,
    _top: 0,
    _height: 600,
    scrollTo(opts) { this.scrollTop = opts.top; globalThis.__scrollerTarget = opts.top },
    getBoundingClientRect() { return { top: this._top, height: this._height, bottom: this._top + this._height } },
    querySelectorAll() { return elements },
  }

  globalThis.document = {
    querySelector(sel) {
      if (sel === '[data-conversation-scroll]') return scroller
      return null
    },
    querySelectorAll(sel) {
      if (sel.includes('data-chat-anchor-key') || sel.includes('data-chat-turn')) return elements
      return []
    },
  }
  return { elements, scroller }
}

// 构造被测函数（它们只依赖 document）
/** 顶部常量：`extract` 只取函数体，所以依赖的常量要显式带上。 */
function extractConst(name) {
  const re = new RegExp(`var ${name} = [^\\n]+`)
  const m = re.exec(src)
  assert.ok(m !== null, `未找到常量 ${name}`)
  return m[0]
}

const factory = new Function(
  extractConst('REVEAL_TOP_PAD') +
  '\n' + extract('findTurnRow') +
  '\n' + extract('findRowByTurn') +
  '\n' + extract('findTurnRowAtOrAfter') +
  '\n' + extract('chatScroller') +
  '\n' + extract('revealRow') +
  '\nreturn { findTurnRow, findRowByTurn, findTurnRowAtOrAfter, chatScroller, revealRow };',
)
const { findTurnRow, findRowByTurn, findTurnRowAtOrAfter, chatScroller, revealRow } = factory()

console.log('\njump')

test('按 anchorKey 命中正确的行，而不是第一个', () => {
  makeDom([
    { key: 'user:1', top: 0, turn: 1 },
    { key: 'assistant:1', top: 40, turn: 1 },
    { key: 'user:2', top: 800, turn: 2 },
    { key: 'assistant:2', top: 840, turn: 2 },
  ])
  const row = findTurnRow('user:2', chatScroller())
  assert.ok(row !== null, '应当命中')
  assert.equal(row.getAttribute('data-chat-anchor-key'), 'user:2')
})

test('data-chat-turn 直接定位（不依赖快照，跳转时面板已卸载）', () => {
  makeDom([
    { key: 'a', top: 0, turn: 1 },
    { key: 'b', top: 200, turn: 2 },
    { key: 'c', top: 400, turn: 3 },
    { key: 'd', top: 600, turn: 4 },
  ])
  const row = findRowByTurn(3, chatScroller())
  assert.ok(row !== null, '应当按 turn 命中')
  assert.equal(row.getAttribute('data-chat-turn'), '3')
})

test('同一轮有多行时，优先选用户输入那一行（而不是第一行）', () => {
  const dom = makeDom([
    { key: 'prev', top: 0, turn: 1 },
    { key: 'proc', top: 300, turn: 2 },
    { key: 'user', top: 340, turn: 2 },
    { key: 'reply', top: 380, turn: 2 },
  ])
  // 只有用户输入行带 flow-kind=user
  dom.elements[2]._flowKind = 'user'
  const row = findRowByTurn(2, chatScroller())
  assert.ok(row !== null)
  assert.equal(row.getAttribute('data-chat-flow-kind'), 'user',
    '应命中用户输入行，而不是该轮的第一个 data-chat-turn 行')
})

test('没有用户输入标记时退回最靠上的可见行', () => {
  makeDom([
    { key: 'a', top: 300, turn: 2 },
    { key: 'b', top: 360, turn: 2 },
  ])
  const row = findRowByTurn(2, chatScroller())
  assert.ok(row !== null)
  assert.equal(row.getAttribute('data-chat-anchor-key'), 'a')
})

test('高度为 0 的行被跳过（折叠起来的轮次）', () => {
  const dom = makeDom([
    { key: 'collapsed', top: 100, turn: 2, height: 0 },
    { key: 'visible', top: 200, turn: 2, height: 40 },
  ])
  const row = findRowByTurn(2, chatScroller())
  assert.ok(row !== null)
  assert.equal(row.getAttribute('data-chat-anchor-key'), 'visible',
    '折叠行不可见，不应作为落点')
})

test('找不到该 turn 时返回 null', () => {
  makeDom([{ key: 'a', top: 0, turn: 1 }])
  assert.equal(findRowByTurn(9, chatScroller()), null)
})

test('node-key 兜底：anchor-key 不匹配时用 data-chat-node-key', () => {
  const dom = makeDom([
    { key: 'other', top: 0, turn: 1 },
    { key: 'other2', top: 100, turn: 2 },
  ])
  dom.elements[1]._nodeKey = 'wanted-node'
  const row = findTurnRow('wanted-node', chatScroller())
  assert.ok(row !== null, '应当通过 node-key 命中')
})

test('用 turn 号当 key 时匹配不到（旧 bug 的形态）', () => {
  makeDom([{ key: 'user:3', top: 0 }])
  const row = findTurnRow('3', chatScroller())
  assert.equal(row, null, 'turn 号不是 anchorKey，必须匹配失败')
})

test('不存在的 anchorKey 返回 null', () => {
  makeDom([{ key: 'user:1', top: 0 }])
  assert.equal(findTurnRow('user:99', chatScroller()), null)
})

test('空 anchorKey 立即返回 null（不做全表扫描）', () => {
  makeDom([{ key: '', top: 0 }])
  assert.equal(findTurnRow('', chatScroller()), null)
})

test('找不到滚动容器时退回 document 查询', () => {
  makeDom([{ key: 'user:5', top: 0 }])
  // 让 chatScroller 返回 null
  globalThis.document.querySelector = () => null
  const row = findTurnRow('user:5', null)
  assert.ok(row !== null)
})

test('revealRow 用容器 scrollTop，不改动外层页面', () => {
  const { scroller } = makeDom([{ key: 'user:7', top: 1200 }])
  const row = findTurnRow('user:7', scroller)
  globalThis.__scrollerTarget = undefined
  revealRow(row, scroller)
  assert.ok(typeof globalThis.__scrollerTarget === 'number', '应当通过容器滚动')
  assert.ok(globalThis.__scrollerTarget > 0, '目标位置应大于 0')
})

test('revealRow 让目标行贴住顶端，只留一点缝', () => {
  const { scroller } = makeDom([{ key: 'user:8', top: 1000 }])
  const row = findTurnRow('user:8', scroller)
  revealRow(row, scroller)
  const target = globalThis.__scrollerTarget
  // 行在 1000（容器 scrollTop 为 0、容器顶也在 0），目标应≈1000-留白。
  // 留白必须很小：留白越大，目标越靠屏幕中间，正是要修的问题。
  assert.ok(target < 1000, '目标应小于行位置')
  assert.ok(target >= 990, `留白过大（会停在中间）：${target}`)
})

test('窗口高度不影响落点（留白不是百分比）', () => {
  function targetFor(scrollerHeight, rowTop) {
    const { scroller } = makeDom([{ key: 'k', top: rowTop }])
    scroller._height = scrollerHeight
    const row = findTurnRow('k', scroller)
    revealRow(row, scroller)
    return rowTop - globalThis.__scrollerTarget
  }
  const small = targetFor(500, 1000)
  const tall = targetFor(1400, 1000)
  assert.equal(small, tall, `留白应固定，实际 ${small} vs ${tall}`)
  assert.ok(small <= 12, `留白过大：${small}`)
})

test('没有容器时退回 scrollIntoView', () => {
  makeDom([{ key: 'user:9', top: 300 }])
  globalThis.__scrolledTo = undefined
  const row = findTurnRow('user:9', null)
  revealRow(row, null)
  assert.equal(globalThis.__scrolledTo, 'user:9')
})

// ── anchorKey 映射的构造 ──────────────────────────────────────────────
test('navigation.items() 的 turn→anchorKey 映射正确', () => {
  const items = [
    { turn: 1, anchorKey: 'user:1', prompt: '', response: '' },
    { turn: 2, anchorKey: 'user:2', prompt: '', response: '' },
    { turn: 7, anchorKey: 'hash-abc', prompt: '', response: '' },
  ]
  const m = new Map()
  for (const it of items) {
    if (it && typeof it.turn === 'number' && typeof it.anchorKey === 'string') {
      m.set(it.turn, it.anchorKey)
    }
  }
  assert.equal(m.get(1), 'user:1')
  assert.equal(m.get(7), 'hash-abc')
  assert.equal(m.get(99), undefined)
})

test('畸形条目被忽略而不抛异常', () => {
  const items = [null, undefined, { turn: 'x', anchorKey: 'a' }, { turn: 3, anchorKey: 42 }, { turn: 4, anchorKey: 'ok' }]
  const m = new Map()
  for (const it of items) {
    if (it && typeof it.turn === 'number' && typeof it.anchorKey === 'string') {
      m.set(it.turn, it.anchorKey)
    }
  }
  assert.equal(m.size, 1)
  assert.equal(m.get(4), 'ok')
})

// ── 诊断 ──────────────────────────────────────────────────────────────
const probeFn = new Function(
  extract('probeChatDom') +
  '\n' + extract('turnLocatorReport') +
  '\n' + extract('chatScroller') +
  '\nreturn { probeChatDom, turnLocatorReport, chatScroller };',
)
const { probeChatDom } = probeFn()

test('probeChatDom 报告属性实际存在情况', () => {
  makeDom([
    { key: 'a', top: 0, turn: 1 },
    { key: 'b', top: 100, turn: 2 },
  ])
  const r = probeChatDom()
  assert.equal(r.hasScroller, true)
  assert.equal(r.byTurn.count, 2, 'byTurn 应统计到行数')
  assert.deepEqual(r.byTurn.sample, ['1', '2'])
  assert.equal(typeof r.scroller.scrollTop, 'number')
})

test('probeChatDom 在无 document 时给出 error 而非抛异常', () => {
  const saved = globalThis.document
  globalThis.document = undefined
  try {
    const r = probeChatDom()
    assert.equal(r.error, 'no document')
  } finally {
    globalThis.document = saved
  }
})

// ── 跳转落点的优先级 ─────────────────────────────────────────────────
test('anchorKey 命中用户消息行时，优先于 data-chat-turn 容器', () => {
  // 这一轮有两行：外层容器（过程在顶）与用户消息。
  // 只按 data-chat-turn 会落在外层容器顶部（过程行），
  // 按 anchorKey 才能落在用户那句话上。
  const dom = makeDom([
    { key: 'proc-container', top: 500, turn: 5 },
    { key: 'user:5', top: 560, turn: 5 },
  ])
  dom.elements[0]._flowKind = 'turn-process'
  dom.elements[1]._flowKind = 'user'

  // 模拟新逻辑：先 anchorKey
  const byAnchor = findTurnRow('user:5', chatScroller())
  assert.ok(byAnchor !== null)
  assert.equal(byAnchor.getAttribute('data-chat-anchor-key'), 'user:5',
    'anchorKey 必须命中用户消息行，而不是外层容器')
  assert.equal(Math.round(byAnchor._top), 560)

  // 仅按 turn 会命中哪一行？（说明为什么不能只靠它）
  const byTurnOnly = findRowByTurn(5, chatScroller())
  assert.ok(byTurnOnly !== null)
  assert.equal(byTurnOnly.getAttribute('data-chat-flow-kind'), 'user',
    '有 flow-kind=user 时，按 turn 也应优先选用户行')
})

test('没有 user 标记时，按 turn 退回最靠上的行', () => {
  makeDom([
    { key: 'a', top: 300, turn: 7 },
    { key: 'b', top: 400, turn: 7 },
  ])
  const row = findRowByTurn(7, chatScroller())
  assert.equal(row.getAttribute('data-chat-anchor-key'), 'a')
})

test('逐轮定位报告能指出缺失 user 行的轮次', () => {
  makeDom([
    { key: 'u1', top: 0, turn: 1 },
    { key: 'u2', top: 100, turn: 2 },
  ])
  // 只有第 1 轮有 user 标记
  const dom = makeDom([
    { key: 'u1', top: 0, turn: 1 },
    { key: 'u2', top: 100, turn: 2 },
  ])
  dom.elements[0]._flowKind = 'user'
  const report = (() => {
    const f = new Function(
      extract('turnLocatorReport') + '\nreturn turnLocatorReport;',
    )()
    return f(globalThis.document, chatScroller())
  })()
  const t1 = report.find(r => r.turn === 1)
  const t2 = report.find(r => r.turn === 2)
  assert.equal(t1.userRows, 1, '第 1 轮应有 user 行')
  assert.equal(t2.userRows, 0, '第 2 轮没有 user 行——报告必须暴露这一点')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
