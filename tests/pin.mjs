/**
 * 落点保持测试：内容变化后目标行仍然贴顶。
 *
 * 「部分轮次有偏差」的成因不是偏移量算错，而是**跳转后内容还会变**：
 * 图片解码出高度、代码块高亮、过程分组折叠 — 这些都会让目标行在文档里
 * 移动。如果只锁一个绝对 scrollTop，偏移量恰好等于那段内容的高度变化，
 * 于是只有「内容会变」的那几轮看起来偏了。
 *
 * 这里用可控的假 DOM 驱动 pinToTop，验证它在内容变化后仍把行钉在顶端。
 *
 * Run: node tests/pin.mjs
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

/** 从源码取一个顶层函数（签名 + 函数体）。 */
function extract(name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `未找到 ${name}()`)
  let depth = 0
  let i = src.indexOf('{', start)
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') { depth -= 1; if (depth === 0) break }
  }
  return src.slice(start, i + 1)
}

function extractConst(name) {
  const m = new RegExp(`var ${name} = [^\\n]+`).exec(src)
  assert.ok(m !== null, `未找到常量 ${name}`)
  return m[0]
}

// ── 可控时钟：手动推进 requestAnimationFrame ─────────────────────────
function makeClock() {
  const queue = []
  return {
    raf(cb) { queue.push(cb); return queue.length },
    /** 推进一帧。 */
    tick() {
      const batch = queue.splice(0, queue.length)
      for (const cb of batch) cb(0)
      return batch.length
    },
    /** 推进 n 帧，返回实际执行的帧数。 */
    run(n) {
      let count = 0
      for (let i = 0; i < n; i += 1) {
        if (this.tick() === 0) break
        count += 1
      }
      return count
    },
    get pending() { return queue.length },
  }
}

/**
 * 假滚动容器 + 目标行。
 *
 * 容器顶固定在 0；行在文档中的偏移由 `rowOffset` 控制，内容变化时改动它
 * 就能模拟「图片加载把行往下推」。
 */
function makeScene({ rowOffset = 1000, viewportHeight = 600 } = {}) {
  const listeners = new Map()
  const row = {
    isConnected: true,
    _offset: rowOffset,
    getBoundingClientRect() {
      // 行在屏幕上的位置 = 文档偏移 - 已滚动距离
      return { top: this._offset - scroller.scrollTop, height: 40, bottom: this._offset - scroller.scrollTop + 40 }
    },
  }
  const scroller = {
    scrollTop: 0,
    _height: viewportHeight,
    get scrollHeight() { return row._offset + 2000 },
    get clientHeight() { return this._height },
    getBoundingClientRect() { return { top: 0, height: this._height, bottom: this._height } },
    addEventListener(type, fn) { listeners.set(type, fn) },
    removeEventListener(type) { listeners.delete(type) },
    /** 模拟读者操作。 */
    emit(type) { const fn = listeners.get(type); if (fn) fn() },
  }
  return { row, scroller, listeners }
}

function build(clock) {
  const factory = new Function(
    extractConst('REVEAL_TOP_PAD') +
    '\n' + extract('pinToTop') +
    '\nreturn pinToTop;',
  )
  const pinToTop = factory()
  // 第三参数注入帧调度，避免依赖 window。
  return (scroller, el) => pinToTop(scroller, el, clock.raf)
}

console.log('\npin-to-top')

test('首次调用把目标行贴到顶端（只留 REVEAL_TOP_PAD）', () => {
  const clock = makeClock()
  const pinToTop = build(clock)
  const { row, scroller } = makeScene({ rowOffset: 1000 })

  pinToTop(scroller, row)
  clock.run(3)

  // 行的文档偏移 1000，留白 8 -> 期望 scrollTop ≈ 992
  assert.ok(Math.abs(scroller.scrollTop - 992) <= 1, `实际 ${scroller.scrollTop}`)
})

test('内容变高把行推下去后，仍被拉回顶端（核心用例）', () => {
  const clock = makeClock()
  const pinToTop = build(clock)
  const { row, scroller } = makeScene({ rowOffset: 1000 })

  pinToTop(scroller, row)
  clock.run(3)
  assert.ok(Math.abs(scroller.scrollTop - 992) <= 1, '先贴顶')

  // 上方图片解码出 300px 高度：行在文档里下移 300
  row._offset = 1300
  clock.run(5)

  // 若锁的是旧像素，scrollTop 会停在 992，行就下移 300 变成"偏了"
  assert.ok(Math.abs(scroller.scrollTop - 1292) <= 2,
    `内容变化后应重新对齐，实际 ${scroller.scrollTop}（停在旧值说明没有重测）`)
})

test('内容变矮把行拉上去后，同样重新对齐', () => {
  const clock = makeClock()
  const pinToTop = build(clock)
  const { row, scroller } = makeScene({ rowOffset: 1000 })

  pinToTop(scroller, row)
  clock.run(3)

  row._offset = 700
  clock.run(5)
  assert.ok(Math.abs(scroller.scrollTop - 692) <= 2, `实际 ${scroller.scrollTop}`)
})

test('连续多次内容变化都能跟上', () => {
  const clock = makeClock()
  const pinToTop = build(clock)
  const { row, scroller } = makeScene({ rowOffset: 500 })

  pinToTop(scroller, row)
  for (const offset of [800, 1200, 900, 1500]) {
    row._offset = offset
    clock.run(3)
    assert.ok(Math.abs(scroller.scrollTop - (offset - 8)) <= 2,
      `offset=${offset} 时实际 ${scroller.scrollTop}`)
  }
})

test('读者滚动（wheel）后立刻放手，不再抢滚动条', () => {
  const clock = makeClock()
  const pinToTop = build(clock)
  const { row, scroller } = makeScene({ rowOffset: 1000 })

  pinToTop(scroller, row)
  clock.run(3)

  scroller.emit('wheel')
  // 读者自己滚到别处
  scroller.scrollTop = 100
  clock.run(5)

  assert.equal(scroller.scrollTop, 100, '读者接管后不应被拉回')
})

test('读者滚动（keydown / touchstart / pointerdown）同样放手', () => {
  for (const ev of ['keydown', 'touchstart', 'pointerdown']) {
    const clock = makeClock()
    const pinToTop = build(clock)
    const { row, scroller } = makeScene({ rowOffset: 1000 })
    pinToTop(scroller, row)
    clock.run(2)
    scroller.emit(ev)
    scroller.scrollTop = 50
    clock.run(5)
    assert.equal(scroller.scrollTop, 50, `${ev} 后不应被拉回`)
  }
})

test('目标行被卸载后停止干预', () => {
  const clock = makeClock()
  const pinToTop = build(clock)
  const { row, scroller } = makeScene({ rowOffset: 1000 })

  pinToTop(scroller, row)
  clock.run(3)

  row.isConnected = false
  const frames = clock.run(5)
  assert.ok(frames <= 2, `卸载后应尽快停止，实际又跑了 ${frames} 帧`)
})

test('有帧数上限，不会永久占用（最多 90 帧）', () => {
  const clock = makeClock()
  const pinToTop = build(clock)
  const { row, scroller } = makeScene({ rowOffset: 1000 })

  pinToTop(scroller, row)
  const ran = clock.run(200)
  assert.ok(ran <= 92, `应在上限内停止，实际跑了 ${ran} 帧`)
  assert.equal(clock.pending, 0, '最终不应留有待执行的帧')
})

test('容器不可滚动时不抛异常', () => {
  const clock = makeClock()
  const pinToTop = build(clock)
  const scroller = { scrollTop: undefined, getBoundingClientRect: () => ({ top: 0, height: 0 }) }
  pinToTop(scroller, { isConnected: true, getBoundingClientRect: () => ({ top: 0 }) })
  clock.run(3)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
