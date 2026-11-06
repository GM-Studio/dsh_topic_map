/**
 * 移植性加固的回归测试。
 *
 * 锁定的六条（对应 2026-11-06 评审报告「缺口」章节）：
 *   1. 声明 DSH 版本要求（换版本要被拦下，而不是静默失效）
 *   2. 客户端服务守卫要同时挡住 null 与 undefined
 *   3. description 不能描述已下线功能
 *   4. 本地缓存要有过期清理，且不能误删 config.json
 *   5. locale/*.json 冗余（文案内嵌在 client.js）→ 不再发布
 *   6. 零工作区时给"没有工作区"的提示，并把「归类」置灰
 *
 * Run: node tests/portability-hardening.mjs
 */

import { strict as assert } from 'node:assert'
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const here = new URL('.', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('../package.json', here), 'utf8'))
const src = readFileSync(new URL('../lib/client.js', here), 'utf8')
const host = readFileSync(new URL('../lib/index.js', here), 'utf8')

let passed = 0
const failures = []
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nportability-hardening')

// ── 1. DSH 版本要求 ───────────────────────────────────────────────
await test('package.json 声明了 engines.dsh（换版本会被拦下）', () => {
  assert.ok(pkg.engines !== undefined, '应有 engines')
  assert.equal(typeof pkg.engines.dsh, 'string', '应有 engines.dsh')
  assert.ok(pkg.engines.dsh.length > 0, 'engines.dsh 不能为空')
  // 至少要能覆盖当前开发所在的 0.2.x
  assert.ok(/0\.2\./.test(pkg.engines.dsh), '应覆盖 0.2.x（当前开发版本）')
  assert.equal(typeof pkg.engines.node, 'string', 'node 版本要求应保留')
})

// ── 2. 客户端服务守卫 ─────────────────────────────────────────────
await test('可选服务统一归一成 null', () => {
  assert.ok(src.includes('SESSION_SERVICE = ctx.sessions ?? null'), '应归一 SESSION_SERVICE')
  assert.ok(src.includes('CONVERSATION_SERVICE = ctx.uiConversation ?? null'), '应归一 CONVERSATION_SERVICE')
})

await test('服务守卫用 == null，同时挡住 null 与 undefined', () => {
  assert.equal(src.includes('SESSION_SERVICE === null'), false, '不应只判 null')
  assert.equal(src.includes('CONVERSATION_SERVICE === null'), false, '不应只判 null')
  assert.ok(src.includes('SESSION_SERVICE == null'), '应使用 == null')
  assert.ok(src.includes('CONVERSATION_SERVICE == null'), '应使用 == null')
})

// ── 3. description 与实际一致 ──────────────────────────────────────
await test('description 不再提已下线功能', () => {
  const d = String(pkg.description ?? '')
  assert.ok(d.length > 0, '应有 description')
  for (const dead of ['三层分级', '状态推导']) {
    assert.equal(d.includes(dead), false, `description 不应再提「${dead}」`)
  }
  // 应当描述现在真实存在的能力
  assert.ok(/话题|对话|会话/.test(d), '应提到三级导航')
  assert.ok(/归类|检索|实时/.test(d), '应提到归类/检索/实时之一')
})

// ── 4. 缓存清理 ───────────────────────────────────────────────────
await test('Host 有缓存清理且从 apply 调用', () => {
  assert.ok(host.includes('async function pruneOldCache'), '应有 pruneOldCache')
  assert.ok(host.includes('CACHE_KEEP_DAYS'), '应有保留天数常量')
  const applyAt = host.indexOf('export function apply(ctx)')
  const seg = host.slice(applyAt, applyAt + 900)
  assert.ok(seg.includes('pruneOldCache()'), 'apply 里应触发清理')
  assert.ok(seg.includes('.catch('), '清理失败必须被吞掉，不能影响启动')
})

await test('缓存清理只碰 topic-map 下的 ui/ 与 segments/，不碰 config.json', () => {
  const at = host.indexOf('async function pruneOldCache')
  const seg = host.slice(at, at + 1400)
  assert.ok(seg.includes("join(dir, 'ui')"), '应扫描 ui/')
  assert.ok(seg.includes("join(dir, 'segments')"), '应扫描 segments/')
  assert.equal(seg.includes('config.json'), false, '不应涉及 config.json（它在上级目录）')
})

// pruneOldCache 的真实行为：造一个临时目录跑一遍
{
  const root = mkdtempSync(join(tmpdir(), 'tm-prune-'))
  const ui = join(root, 'ui')
  const seg = join(root, 'segments')
  mkdirSync(ui, { recursive: true })
  mkdirSync(seg, { recursive: true })

  const old = join(ui, 'workspace-category-x.json')
  const fresh = join(ui, 'workspace-category-y.json')
  const junk = join(ui, 'notes.txt')
  const segOld = join(seg, 'session-a.json')
  const cfg = join(root, 'config.json')     // 上级目录，必须保留
  writeFileSync(old, '{}')
  writeFileSync(fresh, '{}')
  writeFileSync(junk, 'x')
  writeFileSync(segOld, '{}')
  writeFileSync(cfg, '{}')

  const past = (Date.now() - 200 * 24 * 60 * 60 * 1000) / 1000
  for (const f of [old, segOld, cfg]) utimesSync(f, past, past)

  // 用注入依赖的方式跑纯函数（与 index.js 里的实现同源）
  const startAt = host.indexOf('async function pruneOldCache')
  let depth = 0
  let end = startAt
  for (let i = host.indexOf('{', startAt); i < host.length; i += 1) {
    if (host[i] === '{') depth += 1
    else if (host[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  const body = host.slice(startAt, end)
  const fn = new Function('topicMapDir', 'join', 'readdir', 'stat', 'unlink',
    `const CACHE_KEEP_DAYS = 90
     ${body}
     return pruneOldCache`)(
    () => root, join,
    (p) => import('node:fs/promises').then(m => m.readdir(p)),
    (p) => import('node:fs/promises').then(m => m.stat(p)),
    (p) => import('node:fs/promises').then(m => m.unlink(p)),
  )

  // 上面注入的是 Promise 版函数，测试里同步等待
  await test('缓存清理：删过期、留新鲜、不碰非 json、不碰 config.json', async () => {
    const removed = await fn(90)
    assert.equal(removed, 2, '应删掉 2 个过期 json（ui 一个 + segments 一个）')
    assert.equal(existsSync(old), false, '过期的归类缓存应被删')
    assert.equal(existsSync(segOld), false, '过期的分段落盘应被删')
    assert.equal(existsSync(fresh), true, '新鲜文件必须保留')
    assert.equal(existsSync(junk), true, '非 json 文件不归它管')
    assert.equal(existsSync(cfg), true, 'config.json 在上级目录，绝不能被删')
    rmSync(root, { recursive: true, force: true })
  })
}

// ── 5. locale 冗余已去掉 ──────────────────────────────────────────
await test('不再发布 locale/*.json（文案已内嵌）', () => {
  assert.equal(JSON.stringify(pkg.files ?? []).includes('locale'), false, 'files 不应含 locale')
  assert.equal(JSON.stringify(pkg.exports ?? {}).includes('locale'), false, 'exports 不应含 locale')
})

// ── 6. 零工作区提示 ──────────────────────────────────────────────
await test('零工作区时给出区分于"还没归类"的提示', () => {
  assert.ok(src.includes('noWorkspace'), '应有 noWorkspace 标记')
  assert.ok(src.includes('还没有登记任何工作区'), '应有专门文案')
  const at = src.indexOf("className: 'dsh_tm_clistempty'")
  assert.ok(at > 0, '应能找到空态')
})

await test('零工作区时「归类」按钮置灰并说明', () => {
  assert.ok(src.includes('还没有登记任何工作区，无法归类'), '应说明为什么点不了')
  assert.ok(src.includes("disabled: sessionTree.busy || (sessionTree.workspaces ?? []).length === 0"),
    '没有工作区时应禁用归类')
})


// ── 7. health 统一信封 ────────────────────────────────────────────
await test('health 走统一 { ok, value } 信封', () => {
  const at2 = host.indexOf("action === 'health'")
  assert.ok(at2 > 0, '应能找到 health 路由')
  const seg = host.slice(at2, at2 + 320)
  assert.ok(seg.includes('value: { engineVersion'), 'engineVersion 应在 value 里')
  assert.equal(seg.includes('{ ok: true, engineVersion'), false, '不应再放在顶层')
})

await test('check-host 能同时读新旧两种 health 形状（热重载期间可能不一致）', () => {
  const chk = readFileSync(new URL('../check-host.mjs', here), 'utf8')
  assert.ok(chk.includes('value?.engineVersion'), '应先读新形状')
  assert.ok(chk.includes('?? live?.engineVersion'), '再兼容旧形状')
})

// ── 8. 缓存清理按"最后使用"而不是"最后写入" ──────────────────────
await test('读到缓存会刷新 mtime，且每个进程每文件只刷一次', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-touch-'))
  const file = join(root, 'a.json')
  writeFileSync(file, '{}')
  const past = (Date.now() - 300 * 24 * 60 * 60 * 1000) / 1000
  utimesSync(file, past, past)

  // 抽出 touchedCache + touchCacheFile，注入可控的 utimes
  const startAt = host.indexOf('const touchedCache = new Set()')
  const fnAt = host.indexOf('function touchCacheFile(path) {', startAt)
  if (startAt < 0 || fnAt < 0) throw new Error('未找到 touchCacheFile')
  let depth = 0
  let end = fnAt
  for (let i = host.indexOf('{', fnAt); i < host.length; i += 1) {
    if (host[i] === '{') depth += 1
    else if (host[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  const body = host.slice(startAt, end)
  let calls = 0
  // 注入的 utimes 既要计数，也要真的改 mtime —— 否则"是否刷新"根本测不到
  const touch = new Function('utimes',
    `${body}
     return touchCacheFile`)((f, atime, mtime) => {
    calls += 1
    return import('node:fs/promises').then(m => m.utimes(f, atime, mtime))
  })

  touch(file)
  touch(file)
  touch(file)
  assert.equal(calls, 1, '同一文件在同一进程里只应 touch 一次')

  await new Promise(r => setTimeout(r, 20))
  const after = statSync(file).mtimeMs
  assert.ok(Date.now() - after < 60 * 60 * 1000, 'mtime 应被刷新到最近')
  rmSync(root, { recursive: true, force: true })
})

await test('被用过但很久没写入的缓存不会被清理掉（真正的 LRU）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tm-lru-'))
  const ui = join(root, 'ui')
  const seg = join(root, 'segments')
  mkdirSync(ui, { recursive: true })
  mkdirSync(seg, { recursive: true })

  const usedOften = join(ui, 'workspace-category-often.json')
  const cold = join(ui, 'workspace-category-cold.json')
  writeFileSync(usedOften, '{}')
  writeFileSync(cold, '{}')

  const past = (Date.now() - 300 * 24 * 60 * 60 * 1000) / 1000
  utimesSync(usedOften, past, past)
  utimesSync(cold, past, past)

  // 只"使用"第一个：模拟读到缓存后 touch
  const now = new Date()
  utimesSync(usedOften, now, now)

  // 抽出 pruneOldCache 并对这个临时根目录跑一遍
  const startAt = host.indexOf('async function pruneOldCache')
  let depth = 0
  let end = startAt
  for (let i = host.indexOf('{', startAt); i < host.length; i += 1) {
    if (host[i] === '{') depth += 1
    else if (host[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
  }
  const body = host.slice(startAt, end)
  const fsPromises = await import('node:fs/promises')
  const prune = new Function('topicMapDir', 'join', 'readdir', 'stat', 'unlink',
    `const CACHE_KEEP_DAYS = 90
     ${body}
     return pruneOldCache`)(() => root, join, fsPromises.readdir, fsPromises.stat, fsPromises.unlink)

  const removed = await prune(90)
  assert.equal(removed, 1, '只应删掉真正的冷数据')
  assert.equal(existsSync(usedOften), true, '经常被读的缓存（只是没写）必须保留')
  assert.equal(existsSync(cold), false, '真正没被用过的应被删掉')
  rmSync(root, { recursive: true, force: true })
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
