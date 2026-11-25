/**
 * 抽屉入口与解耦：只注册宿主自带的 shell.overlay，不再碰 better-sidebar。
 *
 * 锁三件事：
 *   1. 源码里没有 sidebarRightTabs / sidebarRight / main 槽位注册；
 *   2. shell.overlay 的注册形状正确，关闭时有右缘药丸入口；
 *   3. Ctrl+Shift+H / Alt+H 的开关状态在 DRAWER 上可独立测试。
 */

import { strict as assert } from 'node:assert'
import { readClient, extractFunction, makeRunner } from './client-harness.mjs'

const src = readClient()
const { test, finish } = makeRunner('client-tabs')

await test('解耦：不再引用 better-sidebar，也不注册 main 槽位', async () => {
  for (const marker of [
    'sidebarRightTabs',
    'sidebarRight',
    'sidebar.right.pane.tab',
    "slots.inject('main'",
    'slots.inject("main"',
  ]) {
    assert.equal(src.includes(marker), false, '不应再出现 ' + marker)
  }
  assert.ok(src.includes("ctx.slots.inject('shell.overlay'"), '抽屉必须走 shell.overlay')
  assert.ok(src.includes("name: 'shell.overlay'"))
  assert.ok(src.includes('dsh-topic-map-drawer'), 'overlay 注册要有稳定 id')
})

await test('关闭态有右缘药丸入口，标题与 Ctrl+Shift+H 提示都在', async () => {
  assert.ok(src.includes("className: 'dsh_tm_drawerpill'"))
  assert.ok(src.includes("title: '话题地图（Ctrl+Shift+H）'"))
  assert.ok(src.includes("'aria-label': '打开话题地图'"))
  assert.ok(src.includes('DRAWER.setOpen(true)'))
})

await test('快捷键：Ctrl+Shift+H 与 Alt+H 都走 DRAWER.toggle，且只在可用时拦截', async () => {
  assert.ok(src.includes("event.code !== 'KeyH'"))
  assert.ok(src.includes('DRAWER.toggle()'))
  assert.ok(src.includes('DRAWER.snapshot().available !== true'))
  assert.ok(src.includes("host.addEventListener('keydown', onKey, true)"))
})

await test('抽屉状态：默认打开/420px，宽度夹在 320–720，开关可持久化', async () => {
  const start = src.indexOf('    var DRAWER = (function () {')
  const end = src.indexOf('\n    })()', start)
  assert.ok(start >= 0 && end > start)
  const body = [
    extractFunction(src, 'drawerClampWidth'),
    extractFunction(src, 'drawerRead'),
    src.slice(start, end + '\n    })()'.length),
  ].join('\n')
  const memory = new Map()
  const factory = () => new Function(
    'DRAWER_DEFAULT_WIDTH', 'DRAWER_MIN_WIDTH', 'DRAWER_MAX_WIDTH',
    'DRAWER_OPEN_KEY', 'DRAWER_WIDTH_KEY', 'DRAWER_COLLAPSED_KEY',
    'localStorage', 'console',
    `${body};return DRAWER`,
  )(420, 320, 720, 'dsh.tm.drawer.open', 'dsh.tm.drawer.width', 'dsh.tm.drawer.collapsed', {
    getItem(key) { return memory.has(key) ? memory.get(key) : null },
    setItem(key, value) { memory.set(key, String(value)) },
  }, console)

  const DRAWER = factory()
  const initial = DRAWER.snapshot()
  assert.equal(initial.open, true)
  assert.equal(initial.width, 420)
  assert.equal(initial.collapsed, false)

  DRAWER.setWidth(100)
  assert.equal(DRAWER.snapshot().width, 320)
  DRAWER.setWidth(9999)
  assert.equal(DRAWER.snapshot().width, 720)
  DRAWER.setCollapsed(true)
  assert.equal(DRAWER.snapshot().collapsed, true)
  DRAWER.toggle()
  assert.equal(DRAWER.snapshot().open, false)

  const second = factory()
  assert.equal(second.snapshot().open, false, '开关按 localStorage 还原')
  assert.equal(second.snapshot().collapsed, true)
})

finish()
