/**
 * 话题合并判断的测试。
 *
 * Run: node tests/topic-merge.mjs
 */

import { strict as assert } from 'node:assert'
import {
  PAIR_LIMIT,
  buildMergePrompt,
  parseMergeVerdict,
  pickMergeCandidates,
  toMergeInstructions,
} from '../lib/topic-merge.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

const lane = (id, title, turns) => ({ laneId: id, title, turns })

const LANES = [
  lane('A', '跳转定位', [1, 2, 3]),
  lane('B', '落点偏差', [4, 5]),
  lane('C', '面板配色', [10, 11]),
  lane('D', '打包体积', [20, 21]),
]

const FACTS = {
  1: { prompt: '点击节点后跳到了最后一轮' },
  2: { prompt: '位置还是不对' },
  4: { prompt: '落点有偏差，偏了几十像素' },
}

console.log('\ntopic-merge')

// ── 候选对筛选 ──────────────────────────────────────────────────────
test('时间相邻的话题会成为候选', () => {
  const pairs = pickMergeCandidates(LANES.slice(0, 2))
  assert.equal(pairs.length, 1, 'T1-3 与 T4-5 紧邻，应入选')
})

test('相隔太远且无共同字符的不问', () => {
  const pairs = pickMergeCandidates([LANES[0], LANES[3]])   // 跳转定位 vs 打包体积
  assert.equal(pairs.length, 0, '两者既不相邻也无共同字符')
})

test('有共同字符的远距离话题仍会入选', () => {
  const a = lane('X', '面板布局', [1])
  const b = lane('Y', '面板配色', [30])
  const pairs = pickMergeCandidates([a, b])
  assert.equal(pairs.length, 1, '共享"面板"二字，值得问')
})

test('候选对按像的程度排序', () => {
  const lanes = [
    lane('A', '面板布局', [1]),
    lane('B', '面板配色', [2]),
    lane('C', '跳转', [3]),
  ]
  const pairs = pickMergeCandidates(lanes)
  // A-B 字符重合高，应排在前面
  assert.equal(pairs[0][0].laneId, 'A')
  assert.equal(pairs[0][1].laneId, 'B')
})

test('候选数量有上限', () => {
  const many = Array.from({ length: 30 }, (_, i) => lane('L' + i, '同一个话题' + i, [i]))
  const pairs = pickMergeCandidates(many, 5)
  assert.ok(pairs.length <= 5)
  assert.ok(PAIR_LIMIT > 0)
})

test('空输入不崩', () => {
  assert.deepEqual(pickMergeCandidates([]), [])
  assert.deepEqual(pickMergeCandidates(null), [])
})

test('没有轮次的话题不参与', () => {
  assert.deepEqual(pickMergeCandidates([lane('A', '甲', []), lane('B', '乙', [])]), [])
})

// ── 提示词 ──────────────────────────────────────────────────────────
test('提示词带上两个话题的名字与内容摘要', () => {
  const pairs = [[LANES[0], LANES[1]]]
  const { system, user } = buildMergePrompt(pairs, t => FACTS[t])
  assert.ok(system.includes('同一件事'))
  assert.ok(user.includes('跳转定位'))
  assert.ok(user.includes('落点偏差'))
  assert.ok(user.includes('点击节点后跳到了最后一轮'), '要带内容，不能只看名字')
})

test('提示词说明了"同领域不同工作"不算同一件事', () => {
  const { system } = buildMergePrompt([[LANES[0], LANES[1]]], t => FACTS[t])
  assert.ok(system.includes('不同工作') || system.includes('不是同一件事'))
})

test('提示词要求结构化输出', () => {
  const { system } = buildMergePrompt([[LANES[0], LANES[1]]], t => FACTS[t])
  assert.ok(system.includes('same'))
  assert.ok(system.includes('reason'))
})

test('超长摘要被截断', () => {
  const long = lane('L', '很长的标题', [1])
  const pairs = [[long, long]]
  const { user } = buildMergePrompt(pairs, () => ({ prompt: 'x'.repeat(2000) }))
  assert.ok(user.length < 900, `提示词过长：${user.length}`)
})

test('没有 factOf 时也能构造（内容显示为空）', () => {
  const { user } = buildMergePrompt([[LANES[0], LANES[1]]], null)
  assert.ok(user.includes('跳转定位'))
})

// ── 解析 ────────────────────────────────────────────────────────────
test('解析标准结果', () => {
  const got = parseMergeVerdict('[{"same":true,"reason":"同一件事"},{"same":false,"reason":"不同"}]', 2)
  assert.equal(got.length, 2)
  assert.equal(got[0].same, true)
  assert.equal(got[1].same, false)
})

test('长度不符整批作废', () => {
  assert.equal(parseMergeVerdict('[{"same":true,"reason":"x"}]', 2), null)
})

test('same 不是布尔值就作废', () => {
  assert.equal(parseMergeVerdict('[{"same":"yes","reason":"x"}]', 1), null)
  assert.equal(parseMergeVerdict('[{"reason":"x"}]', 1), null)
})

test('容忍代码围栏', () => {
  const text = '结果：\n```json\n[{"same":false,"reason":"无关"}]\n```'
  assert.equal(parseMergeVerdict(text, 1)[0].same, false)
})

test('无法解析返回 null', () => {
  assert.equal(parseMergeVerdict('我不知道', 1), null)
  assert.equal(parseMergeVerdict('', 1), null)
})

// ── 转成合并指令 ────────────────────────────────────────────────────
test('判定为同一件事才产生合并', () => {
  const pairs = [[LANES[0], LANES[1]]]
  const out = toMergeInstructions(pairs, [{ same: true, reason: '同一件事' }])
  assert.equal(out.length, 1)
  assert.equal(out[0].keep, 'A', '保留先出现的')
  assert.equal(out[0].absorb, 'B', '吸收后出现的')
})

test('判定不同则不合并', () => {
  const pairs = [[LANES[0], LANES[1]]]
  assert.deepEqual(toMergeInstructions(pairs, [{ same: false, reason: '不同' }]), [])
})

test('一条线不会被吸收两次', () => {
  const pairs = [[LANES[0], LANES[1]], [LANES[2], LANES[1]]]
  const out = toMergeInstructions(pairs, [
    { same: true, reason: 'x' },
    { same: true, reason: 'y' },
  ])
  assert.equal(out.length, 1, 'B 已被吸收，第二次应跳过')
})

test('长度不匹配时不合并', () => {
  const pairs = [[LANES[0], LANES[1]]]
  assert.deepEqual(toMergeInstructions(pairs, []), [])
  assert.deepEqual(toMergeInstructions(pairs, null), [])
})

test('保留理由供追溯', () => {
  const pairs = [[LANES[0], LANES[1]]]
  const out = toMergeInstructions(pairs, [{ same: true, reason: '都是跳转问题' }])
  assert.equal(out[0].reason, '都是跳转问题')
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
