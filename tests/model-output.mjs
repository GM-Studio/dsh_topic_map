/**
 * 模型输出抽取测试。
 *
 * 重点不是"标准 JSON 能不能解析"——那显然能。重点是各家模型的实际输出
 * 形态差异：代码围栏、前后客套话、**先说思路带方括号再给答案**、包在对象里。
 *
 * 最后一种最容易踩：只取"第一个 [ 到最后一个 ]"会切出非法 JSON，
 * 整批结果作废。这个缺陷只在换模型/换环境时才暴露。
 *
 * Run: node tests/model-output.mjs
 */

import { strict as assert } from 'node:assert'
import { extractJsonArray, extractJsonArrayOfLength, extractJsonField } from '../lib/model-output.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

console.log('\nmodel-output')

// ── 基本形态 ────────────────────────────────────────────────────────
test('纯 JSON 数组', () => {
  assert.deepEqual(extractJsonArray('["a","b"]'), ['a', 'b'])
})

test('代码围栏', () => {
  assert.deepEqual(extractJsonArray('```json\n["a"]\n```'), ['a'])
})

test('无语言标记的围栏', () => {
  assert.deepEqual(extractJsonArray('```\n[1,2]\n```'), [1, 2])
})

test('前后有客套话', () => {
  assert.deepEqual(extractJsonArray('好的，结果如下：\n["a"]\n以上。'), ['a'])
})

// ── 关键场景：草稿方括号 ────────────────────────────────────────────
test('先说思路带方括号，再给答案（这是最重要的场景）', () => {
  const text = '我先分成 [三类草稿]，最终结果：\n[{"category":"A","sub":"x"}]'
  const got = extractJsonArray(text)
  assert.ok(Array.isArray(got), '应能取出答案数组')
  assert.equal(got.length, 1)
  assert.equal(got[0].category, 'A')
})

test('多个草稿括号也不会取错', () => {
  const text = '思路 [a] 然后 [b] 最后答案 [{"same":true}]'
  const got = extractJsonArray(text)
  assert.equal(got[0].same, true)
})

test('草稿在前、答案在后时优先取答案', () => {
  // 从后往前找，答案在最后
  const text = '["草稿项"] 这不是答案。真正的：["真答案"]'
  assert.deepEqual(extractJsonArray(text), ['真答案'])
})

// ── 无效输入 ────────────────────────────────────────────────────────
test('没有方括号返回 null', () => {
  assert.equal(extractJsonArray('我不知道'), null)
})

test('方括号不配对返回 null', () => {
  assert.equal(extractJsonArray('["a"'), null)
  assert.equal(extractJsonArray('"a"]'), null)
})

test('对象不是数组时继续找数组', () => {
  const got = extractJsonArray('{"x":1} 还有 ["a"]')
  assert.deepEqual(got, ['a'])
})

test('空输入不崩', () => {
  assert.equal(extractJsonArray(''), null)
  assert.equal(extractJsonArray(null), null)
  assert.equal(extractJsonArray(undefined), null)
})

// ── 长度校验 ────────────────────────────────────────────────────────
test('长度符合才返回', () => {
  assert.deepEqual(extractJsonArrayOfLength('["a","b"]', 2), ['a', 'b'])
})

test('长度不符返回 null（错位比没有更糟）', () => {
  assert.equal(extractJsonArrayOfLength('["a"]', 2), null)
  assert.equal(extractJsonArrayOfLength('["a","b"]', 1), null)
})

test('非法 expected 返回 null', () => {
  assert.equal(extractJsonArrayOfLength('["a"]', -1), null)
  assert.equal(extractJsonArrayOfLength('["a"]', NaN), null)
})

// ── 对象包数组 ──────────────────────────────────────────────────────
test('按候选键名取数组', () => {
  const text = '{"assignments":["a","b"]}'
  assert.deepEqual(extractJsonField(text, ['assignments', 'result'], 2), ['a', 'b'])
})

test('候选键按顺序命中', () => {
  const text = '{"result":["x"],"assignments":["a"]}'
  assert.deepEqual(extractJsonField(text, ['assignments', 'result'], 1), ['a'], '先试 assignments')
})

test('键不存在返回 null', () => {
  assert.equal(extractJsonField('{"other":["a"]}', ['assignments'], 1), null)
})

test('长度不符时跳过该键', () => {
  const text = '{"assignments":["a"],"result":["a","b"]}'
  assert.deepEqual(extractJsonField(text, ['assignments', 'result'], 2), ['a', 'b'])
})

test('对象包数组也能容忍围栏', () => {
  const text = '```json\n{"items":[1,2]}\n```'
  assert.deepEqual(extractJsonField(text, ['items']), [1, 2])
})

// ── 真实模型输出样本 ────────────────────────────────────────────────
test('真实样本：中文解释 + 围栏 + 数组', () => {
  const text = [
    '好的，我把这 3 个会话归为两类：',
    '',
    '```json',
    '[',
    '  {"category": "插件开发", "sub": "话题地图"},',
    '  {"category": "插件开发", "sub": "话题地图"},',
    '  {"category": "技术调研", "sub": "概念"}',
    ']',
    '```',
    '',
    '这样分类的原因是……',
  ].join('\n')
  const got = extractJsonArrayOfLength(text, 3)
  assert.equal(got.length, 3)
  assert.equal(got[0].category, '插件开发')
})

test('真实样本：模型先说"我会分成 3 类"然后输出', () => {
  const text = '我会分成 3 类 [插件/调研/环境]，具体如下：\n["A","B","C"]'
  assert.deepEqual(extractJsonArrayOfLength(text, 3), ['A', 'B', 'C'])
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const f of failures) console.error(`\n${f.name}\n${f.error.stack}`)
  process.exit(1)
}
