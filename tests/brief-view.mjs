/**
 * 简报视图模型测试。
 *
 * 纯函数：`now` 一律由参数传入，不读系统时钟、不碰 DOM。
 * 覆盖：完整结构、范围说明、轮次排序、单轮 1200 字截断、总量上限、
 * 命令汇总、文件名 slug 与非法边界。
 *
 * Run: node tests/brief-view.mjs
 */

import { strict as assert } from 'node:assert'
import {
  briefFileName,
  buildBrief,
  formatTime,
} from '../lib/brief-view.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 固定"现在"：2026-11-25 14:30（本地时区）。 */
const NOW = new Date(2026, 10, 25, 14, 30, 0).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** 码点长度：中文 / emoji 都按"一个字"算。 */
const charLength = text => Array.from(text).length
/** 只取单轮简报的"时间线"段（用于量单轮渲染长度）。 */
const timelineOf = doc => doc.split('## 时间线\n\n')[1].split('\n\n## 相关命令')[0]

console.log('\nbrief-view')

// ── formatTime ──────────────────────────────────────────────────────
test('formatTime：本地 24 小时制、补零', () => {
  assert.equal(formatTime(new Date(2026, 10, 25, 14, 30).getTime()), '2026-11-25 14:30')
  assert.equal(formatTime(new Date(2026, 0, 2, 0, 5).getTime()), '2026-01-02 00:05')
  assert.equal(formatTime(new Date(2026, 11, 31, 23, 59).getTime()), '2026-12-31 23:59')
  assert.equal(formatTime(NaN), '')
  assert.equal(formatTime(undefined), '')
})

// ── 完整结构 ────────────────────────────────────────────────────────
test('buildBrief：标题、范围、时间线与命令汇总', () => {
  const from = new Date(2026, 10, 20, 0, 0).getTime()
  const doc = buildBrief({
    title: '话题地图周报',
    scope: {
      workspace: 'E:\\dsh_plugin',
      session: '历史索引',
      from,
      to: NOW,
    },
    turns: [
      {
        turn: 2,
        time: new Date(2026, 10, 24, 9, 5).getTime(),
        promptHead: '检查引用配额',
        digest: '确认 quoteMaxCount / quoteMaxChars 生效。',
        commandCount: 2,
        changedFiles: ['lib/index.js', 'tests/quote-quota.mjs'],
      },
      {
        turn: 1,
        time: new Date(2026, 10, 23, 10, 0).getTime(),
        promptHead: '先看现状',
        digest: '',
        commandCount: 0,
        changedFiles: [],
      },
    ],
    now: NOW,
  })

  assert.ok(doc.startsWith('# 话题地图周报\n\n'))
  assert.ok(doc.includes('> 生成时间：2026-11-25 14:30'))
  assert.ok(doc.includes('> 范围：工区 E:\\dsh_plugin ｜ 会话 历史索引 ｜ 时间窗 2026-11-20 00:00 – 2026-11-25 14:30'))
  assert.ok(doc.includes('## 时间线'))
  assert.ok(doc.includes('### 第 1 轮 · 2026-11-23 10:00'))
  assert.ok(doc.includes('### 第 2 轮 · 2026-11-24 09:05'))
  assert.ok(doc.includes('**提问**：先看现状'))
  assert.ok(doc.includes('**提问**：检查引用配额'))
  assert.ok(doc.includes('确认 quoteMaxCount / quoteMaxChars 生效。'))
  assert.ok(doc.includes('- 命令：2 条'))
  assert.ok(doc.includes('- 变更文件：`lib/index.js`、`tests/quote-quota.mjs`'))

  const summary = doc.split('## 相关命令\n\n')[1]
  assert.ok(summary.includes('- 第 2 轮：2 条命令'))
  assert.ok(summary.includes('共 2 条命令，来自 1 轮。'))
})

test('buildBrief：turns 乱序按轮号升序，缺失轮号排最后', () => {
  const doc = buildBrief({
    title: '排序',
    scope: '全部',
    turns: [
      { turn: 3, time: NOW, promptHead: '三' },
      { turn: 1, time: NOW, promptHead: '一' },
      { time: NOW, promptHead: '无轮号' },
      { turn: 2, time: NOW, promptHead: '二' },
    ],
    now: NOW,
  })
  const turns = [...doc.matchAll(/^### (?:第 (\d+) 轮|轮次未知)/gm)].map(match => match[1] ?? '未知')
  assert.deepEqual(turns, ['1', '2', '3', '未知'])
})

test('buildBrief：空轮次仍保留完整骨架', () => {
  const doc = buildBrief({ title: '空简报', scope: {}, turns: [], now: NOW })
  assert.ok(doc.includes('# 空简报'))
  assert.ok(doc.includes('> 范围：未指定'))
  assert.ok(doc.includes('## 时间线\n\n（没有可列出的轮次）'))
  assert.ok(doc.includes('## 相关命令\n\n（没有可汇总的命令）'))
})

test('buildBrief：scope 字符串直接作范围说明', () => {
  const doc = buildBrief({ title: '范围', scope: '  全工作区 · 近 7 天  ', turns: [], now: NOW })
  assert.ok(doc.includes('> 范围：全工作区 · 近 7 天'))
})

test('buildBrief：scope 数组工区与只给起始时间', () => {
  const doc = buildBrief({
    title: '范围',
    scope: { workspaces: ['E:\\a', 'E:\\b'], from: new Date(2026, 10, 1, 8, 0).getTime() },
    turns: [],
    now: NOW,
  })
  assert.ok(doc.includes('> 范围：工区 E:\\a、E:\\b ｜ 时间窗 自 2026-11-01 08:00'))
})

test('buildBrief：时长与命令为 0 时不生成噪声行', () => {
  const doc = buildBrief({
    title: '零值',
    turns: [{ turn: 1, time: NOW, promptHead: '看', digest: '结论', commandCount: 0, changedFiles: [] }],
    now: NOW,
  })
  assert.ok(!doc.includes('- 命令：'))
  assert.ok(!doc.includes('- 变更文件：'))
  assert.ok(doc.includes('（没有可汇总的命令）'))
})

// ── 单轮截断 ────────────────────────────────────────────────────────
test('buildBrief：单轮渲染超过 1200 字截断并标注', () => {
  const doc = buildBrief({
    title: '长摘要',
    turns: [{ turn: 1, time: NOW, digest: '字'.repeat(3000), commandCount: 0, changedFiles: [] }],
    now: NOW,
  })
  const block = timelineOf(doc)
  assert.ok(charLength(block) <= 1200, `单轮 ${charLength(block)} 字，应 ≤ 1200`)
  assert.ok(block.includes('已截断'))
  assert.ok(block.startsWith('### 第 1 轮'))
  assert.ok(block.endsWith('已截断）'))
})

test('buildBrief：恰好 1200 字不截断，1201 字才截断', () => {
  const build = digest => buildBrief({
    title: '边界',
    turns: [{ turn: 1, time: NOW, digest, commandCount: 0, changedFiles: [] }],
    now: NOW,
  })
  const single = build('x')
  const overhead = charLength(timelineOf(single)) - 1
  const exact = timelineOf(build('x'.repeat(1200 - overhead)))
  assert.equal(charLength(exact), 1200)
  assert.ok(!exact.includes('已截断'))

  const over = timelineOf(build('x'.repeat(1201 - overhead)))
  assert.ok(charLength(over) <= 1200)
  assert.ok(over.includes('已截断'))
})

test('buildBrief：超长提问头保留可见前缀并加省略号', () => {
  const longPrompt = '提'.repeat(300)
  const doc = buildBrief({
    title: '长提问',
    turns: [{ turn: 1, time: NOW, promptHead: longPrompt, digest: '摘要', commandCount: 0 }],
    now: NOW,
  })
  assert.ok(doc.includes('**提问**：' + '提'.repeat(199) + '…'))
  assert.ok(!doc.includes(longPrompt))
})

test('buildBrief：emoji 截断不切代理对', () => {
  const doc = buildBrief({
    title: '表情',
    turns: [{ turn: 1, time: NOW, digest: '🚀'.repeat(2000), commandCount: 0 }],
    now: NOW,
  })
  const block = timelineOf(doc)
  assert.ok(charLength(block) <= 1200)
  // 每个 🚀 是一个码点；截断后不能出现落单的代理项。
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(block))
  assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(block))
})

// ── 总量上限 ────────────────────────────────────────────────────────
test('buildBrief：总长度上限生效并标注', () => {
  const turns = Array.from({ length: 6 }, (_, index) => ({
    turn: index + 1,
    time: NOW,
    digest: '内'.repeat(400),
    commandCount: 1,
  }))
  const doc = buildBrief({ title: '限长', turns, now: NOW, limit: 1000 })
  assert.ok(charLength(doc) <= 1000, `总长 ${charLength(doc)} 应 ≤ 1000`)
  assert.ok(doc.startsWith('# 限长'))
  assert.ok(doc.includes('超出长度上限'))
})

test('buildBrief：默认总量上限 200000', () => {
  const turns = Array.from({ length: 400 }, (_, index) => ({
    turn: index + 1,
    time: NOW,
    digest: '字'.repeat(600),
    commandCount: 0,
  }))
  const doc = buildBrief({ title: '默认限长', turns, now: NOW })
  assert.ok(charLength(doc) <= 200000, `默认上限下总长 ${charLength(doc)} 应 ≤ 200000`)
  assert.ok(doc.includes('超出长度上限'))
})

test('buildBrief：短简报不受 limit 影响，非法 limit 回默认', () => {
  const short = buildBrief({ title: '短', turns: [], now: NOW, limit: 5 })
  assert.ok(charLength(short) <= 5)
  const normal = buildBrief({ title: '短', turns: [], now: NOW, limit: -100 })
  assert.ok(normal.includes('## 时间线'))
})

// ── 文件名 ──────────────────────────────────────────────────────────
test('briefFileName：时间前缀 + 安全 slug', () => {
  const name = briefFileName('话题地图：简报  V2', NOW)
  assert.equal(name, '2026-11-25-1430-话题地图-简报-V2.md')
})

test('briefFileName：空标题回 brief，标点标题也回 brief', () => {
  assert.equal(briefFileName('', NOW), '2026-11-25-1430-brief.md')
  assert.equal(briefFileName('   ', NOW), '2026-11-25-1430-brief.md')
  assert.equal(briefFileName('///***', NOW), '2026-11-25-1430-brief.md')
  assert.equal(briefFileName(null, NOW), '2026-11-25-1430-brief.md')
})

test('briefFileName：slug 最多取 20 个安全字符', () => {
  const title = '一二三四五六七八九十一二三四五六七八九十多余的部分'
  const name = briefFileName(title, NOW)
  const slug = name.replace(/^2026-11-25-1430-/, '').replace(/\.md$/, '')
  assert.equal(charLength(slug), 20)
  assert.equal(slug, '一二三四五六七八九十一二三四五六七八九十')
})

test('briefFileName：非法字符压成连字符且去掉首尾连字符', () => {
  assert.equal(briefFileName('a/b\\c:d*e?f"g<h>i|j', NOW), '2026-11-25-1430-a-b-c-d-e-f-g-h-i-j.md')
  assert.equal(briefFileName('  --版本 2--  ', NOW), '2026-11-25-1430-版本-2.md')
})

test('briefFileName：now 非法时用 undated 前缀', () => {
  assert.equal(briefFileName('测试', NaN), 'undated-测试.md')
  assert.equal(briefFileName('测试', undefined), 'undated-测试.md')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
