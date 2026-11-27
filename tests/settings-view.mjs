/**
 * 设置表单模型测试。
 *
 * 纯函数：不读 DOM、不读系统时钟、不 import 其他模块。
 * 重点覆盖：只读项的密钥不回显、数字范围、布尔转换、错误文案、diff 只含变化项。
 *
 * Run: node tests/settings-view.mjs
 */

import { strict as assert } from 'node:assert'
import {
  applySetting,
  diffConfig,
  settingsModel,
} from '../lib/settings-view.js'

let passed = 0
const failures = []
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`) }
  catch (e) { failures.push({ name, error: e }); console.log(`  FAIL ${name}\n       ${e.message}`) }
}

/** 按组 id 取组。 */
const groupOf = (model, id) => model.groups.find(group => group.id === id)
/** 按 key 取项。 */
const itemOf = (model, groupId, key) => groupOf(model, groupId).items.find(item => item.key === key)

console.log('\nsettings-view')

// ── 结构 ────────────────────────────────────────────────────────────
test('settingsModel：五组顺序与标题（含续接与事）', () => {
  const model = settingsModel({})
  assert.deepEqual(model.groups.map(group => group.id), ['work', 'model', 'index', 'quote', 'ui'])
  assert.deepEqual(model.groups.map(group => group.title), ['续接与事', '模型', '索引', '引用', '界面'])
  for (const group of model.groups) {
    assert.ok(Array.isArray(group.items) && group.items.length > 0, `${group.id} 应有设置项`)
    for (const item of group.items) {
      assert.equal(typeof item.key, 'string')
      assert.ok(item.label.length > 0)
      assert.equal(typeof item.type, 'string')
      assert.ok(Object.prototype.hasOwnProperty.call(item, 'default'), `${item.key} 应带 default`)
    }
  }
})

test('settingsModel：模型组只读且不回显密钥明文', () => {
  const secret = 'sk-secret-abc-123'
  const model = settingsModel({
    provider: 'openai',
    model: 'gpt-x',
    baseUrl: 'https://api.example.com/v1',
    apiKey: secret,
  })
  const group = groupOf(model, 'model')
  assert.deepEqual(group.items.map(item => item.key), ['provider', 'model', 'baseUrl', 'apiKey'])
  for (const item of group.items) assert.equal(item.type, 'readonly')
  assert.equal(itemOf(model, 'model', 'provider').value, 'openai')
  assert.equal(itemOf(model, 'model', 'model').value, 'gpt-x')
  assert.equal(itemOf(model, 'model', 'baseUrl').value, 'https://api.example.com/v1')
  assert.equal(itemOf(model, 'model', 'apiKey').value, '已设置')
  assert.ok(!JSON.stringify(model).includes(secret), '模型序列化后不能出现密钥明文')
})

test('settingsModel：空配置用跟随 / 未设置文案', () => {
  const model = settingsModel(null)
  assert.equal(itemOf(model, 'model', 'provider').value, '跟随当前会话')
  assert.equal(itemOf(model, 'model', 'model').value, '跟随当前会话')
  assert.equal(itemOf(model, 'model', 'baseUrl').value, '未设置')
  assert.equal(itemOf(model, 'model', 'apiKey').value, '未设置')
})

// ── 索引组 ──────────────────────────────────────────────────────────
test('settingsModel：索引组含轮次上限与重建按钮', () => {
  const model = settingsModel({})
  const item = itemOf(model, 'index', 'turnLimit')
  assert.equal(item.type, 'number')
  assert.equal(item.value, 50)
  assert.equal(item.default, 50)
  assert.equal(item.min, 5)
  assert.equal(item.max, 500)

  const rebuild = itemOf(model, 'index', 'rebuildIndex')
  assert.equal(rebuild.type, 'button')
  assert.ok(rebuild.label.length > 0)
})

test('settingsModel：非法 turnLimit 归一或夹到边界', () => {
  assert.equal(itemOf(settingsModel({ turnLimit: 'abc' }), 'index', 'turnLimit').value, 50)
  assert.equal(itemOf(settingsModel({ turnLimit: 4 }), 'index', 'turnLimit').value, 5)
  assert.equal(itemOf(settingsModel({ turnLimit: 999 }), 'index', 'turnLimit').value, 500)
  assert.equal(itemOf(settingsModel({ turnLimit: 61.8 }), 'index', 'turnLimit').value, 61)
})

// ── 引用组 ──────────────────────────────────────────────────────────
test('settingsModel：引用组默认值与范围', () => {
  const model = settingsModel({})
  const level = itemOf(model, 'quote', 'digestLevel')
  assert.equal(level.type, 'select')
  assert.equal(level.value, 'standard')
  assert.equal(level.default, 'standard')
  assert.deepEqual(level.options.map(option => option.value), ['compact', 'standard', 'rich'])
  for (const option of level.options) assert.ok(option.label.length > 0)

  const count = itemOf(model, 'quote', 'quoteMaxCount')
  assert.equal(count.type, 'number')
  assert.equal(count.value, 5)
  assert.equal(count.default, 5)
  assert.equal(count.min, 1)
  assert.equal(count.max, 20)

  const chars = itemOf(model, 'quote', 'quoteMaxChars')
  assert.equal(chars.type, 'number')
  assert.equal(chars.value, 2400)
  assert.equal(chars.default, 2400)
  assert.equal(chars.min, 400)
  assert.equal(chars.max, 8000)
})

test('settingsModel：引用组配置回显', () => {
  const model = settingsModel({
    digestLevel: 'rich',
    quoteMaxCount: 12,
    quoteMaxChars: 6000,
  })
  assert.equal(itemOf(model, 'quote', 'digestLevel').value, 'rich')
  assert.equal(itemOf(model, 'quote', 'quoteMaxCount').value, 12)
  assert.equal(itemOf(model, 'quote', 'quoteMaxChars').value, 6000)
})

test('settingsModel：非法引用配置回默认或夹到边界', () => {
  const model = settingsModel({
    digestLevel: 'verbose',
    quoteMaxCount: 0,
    quoteMaxChars: 99999,
  })
  assert.equal(itemOf(model, 'quote', 'digestLevel').value, 'standard')
  assert.equal(itemOf(model, 'quote', 'quoteMaxCount').value, 1)
  assert.equal(itemOf(model, 'quote', 'quoteMaxChars').value, 8000)
})

// ── 续接与事组 ──────────────────────────────────────────────────────
test('settingsModel：续接与事组含 dormantDays 与 inflectionNotice 默认值与选项', () => {
  const model = settingsModel({})
  const dormant = itemOf(model, 'work', 'dormantDays')
  assert.equal(dormant.type, 'select')
  assert.equal(dormant.value, 14)
  assert.equal(dormant.default, 14)
  assert.equal(dormant.min, 0)
  assert.equal(dormant.max, 365)
  assert.deepEqual(dormant.options.map(option => option.value), [7, 14, 30, 0])
  for (const option of dormant.options) assert.ok(option.label.length > 0)

  const notice = itemOf(model, 'work', 'inflectionNotice')
  assert.equal(notice.type, 'boolean')
  assert.equal(notice.value, true)
  assert.equal(notice.default, true)
})

test('settingsModel：dormantDays 合法整数回显与越界/非法值归一', () => {
  assert.equal(itemOf(settingsModel({ dormantDays: 0 }), 'work', 'dormantDays').value, 0)
  assert.equal(itemOf(settingsModel({ dormantDays: 7 }), 'work', 'dormantDays').value, 7)
  assert.equal(itemOf(settingsModel({ dormantDays: 30 }), 'work', 'dormantDays').value, 30)
  assert.equal(itemOf(settingsModel({ dormantDays: 45 }), 'work', 'dormantDays').value, 45)
  assert.equal(itemOf(settingsModel({ dormantDays: '21' }), 'work', 'dormantDays').value, 21)
  assert.equal(itemOf(settingsModel({ dormantDays: -5 }), 'work', 'dormantDays').value, 0)
  assert.equal(itemOf(settingsModel({ dormantDays: 999 }), 'work', 'dormantDays').value, 365)
  assert.equal(itemOf(settingsModel({ dormantDays: 'abc' }), 'work', 'dormantDays').value, 14)

  assert.equal(itemOf(settingsModel({ inflectionNotice: false }), 'work', 'inflectionNotice').value, false)
  assert.equal(itemOf(settingsModel({ inflectionNotice: '0' }), 'work', 'inflectionNotice').value, false)
  assert.equal(itemOf(settingsModel({ inflectionNotice: 'invalid' }), 'work', 'inflectionNotice').value, true)
})

// ── 界面组 ──────────────────────────────────────────────────────────
test('settingsModel：railNative 布尔项', () => {
  const off = itemOf(settingsModel({}), 'ui', 'railNative')
  assert.equal(off.type, 'boolean')
  assert.equal(off.label, '恢复原生导航轨')
  assert.equal(off.value, false)
  assert.equal(off.default, false)
  const on = itemOf(settingsModel({ railNative: true }), 'ui', 'railNative')
  assert.equal(on.value, true)
  assert.equal(itemOf(settingsModel({ railNative: 'yes' }), 'ui', 'railNative').value, false)
})

// ── applySetting ────────────────────────────────────────────────────
test('applySetting：字符串键去空白且不改原对象', () => {
  const before = { provider: 'a', model: 'm' }
  const result = applySetting(before, 'provider', '  openai  ')
  assert.equal(result.error, undefined)
  assert.equal(result.config.provider, 'openai')
  assert.equal(before.provider, 'a', '原配置不能被修改')
  assert.equal(applySetting(before, 'baseUrl', '  https://x/v1 ').config.baseUrl, 'https://x/v1')
  assert.equal(applySetting(before, 'apiKey', '  sk-1  ').config.apiKey, 'sk-1')
  assert.equal(applySetting(before, 'model', null).config.model, '')
})

test('applySetting：digestLevel 三档与非法值', () => {
  assert.equal(applySetting({}, 'digestLevel', 'compact').config.digestLevel, 'compact')
  assert.equal(applySetting({}, 'digestLevel', 'rich').config.digestLevel, 'rich')
  const bad = applySetting({ digestLevel: 'standard' }, 'digestLevel', 'verbose')
  assert.ok(bad.error.includes('摘要档位'))
  assert.deepEqual(bad.config, { digestLevel: 'standard' })
  const missing = applySetting({}, 'digestLevel', undefined)
  assert.ok(missing.error.includes('摘要档位'))
})

test('applySetting：引用条数 1–20', () => {
  assert.equal(applySetting({}, 'quoteMaxCount', 1).config.quoteMaxCount, 1)
  assert.equal(applySetting({}, 'quoteMaxCount', 20).config.quoteMaxCount, 20)
  assert.equal(applySetting({}, 'quoteMaxCount', '12').config.quoteMaxCount, 12)
  assert.equal(applySetting({}, 'quoteMaxCount', 3.9).config.quoteMaxCount, 3)

  const zero = applySetting({ quoteMaxCount: 5 }, 'quoteMaxCount', 0)
  assert.ok(zero.error.includes('1–20'))
  assert.deepEqual(zero.config, { quoteMaxCount: 5 })
  assert.ok(applySetting({}, 'quoteMaxCount', 21).error.includes('1–20'))
  assert.ok(applySetting({}, 'quoteMaxCount', 'abc').error.includes('数字'))
})

test('applySetting：引用字数 400–8000', () => {
  assert.equal(applySetting({}, 'quoteMaxChars', 400).config.quoteMaxChars, 400)
  assert.equal(applySetting({}, 'quoteMaxChars', 8000).config.quoteMaxChars, 8000)
  assert.equal(applySetting({}, 'quoteMaxChars', '2400').config.quoteMaxChars, 2400)
  assert.ok(applySetting({}, 'quoteMaxChars', 399).error.includes('400–8000'))
  assert.ok(applySetting({}, 'quoteMaxChars', 8001).error.includes('400–8000'))
  assert.ok(applySetting({}, 'quoteMaxChars', '').error.includes('数字'))
})

test('applySetting：turnLimit 5–500 且取整', () => {
  assert.equal(applySetting({}, 'turnLimit', 50).config.turnLimit, 50)
  assert.equal(applySetting({}, 'turnLimit', '60').config.turnLimit, 60)
  assert.equal(applySetting({}, 'turnLimit', 60.9).config.turnLimit, 60)
  assert.ok(applySetting({}, 'turnLimit', 4).error.includes('5–500'))
  assert.ok(applySetting({}, 'turnLimit', 501).error.includes('5–500'))
  assert.ok(applySetting({}, 'turnLimit', true).error.includes('数字'))
})

test('applySetting：railNative 布尔转换', () => {
  assert.equal(applySetting({}, 'railNative', true).config.railNative, true)
  assert.equal(applySetting({}, 'railNative', false).config.railNative, false)
  for (const on of ['true', '1', 'on', ' TRUE ']) {
    assert.equal(applySetting({}, 'railNative', on).config.railNative, true, String(on))
  }
  for (const off of ['false', '0', 'off', ' FALSE ']) {
    assert.equal(applySetting({}, 'railNative', off).config.railNative, false, String(off))
  }
  const bad = applySetting({ railNative: false }, 'railNative', 'maybe')
  assert.ok(bad.error.includes('true'))
  assert.deepEqual(bad.config, { railNative: false })
})

test('applySetting：dormantDays 接受 0–365 整数并拒绝越界或非数字', () => {
  assert.equal(applySetting({}, 'dormantDays', 0).config.dormantDays, 0)
  assert.equal(applySetting({}, 'dormantDays', 7).config.dormantDays, 7)
  assert.equal(applySetting({}, 'dormantDays', 14).config.dormantDays, 14)
  assert.equal(applySetting({}, 'dormantDays', 30).config.dormantDays, 30)
  assert.equal(applySetting({}, 'dormantDays', 365).config.dormantDays, 365)
  assert.equal(applySetting({}, 'dormantDays', '45').config.dormantDays, 45)
  assert.equal(applySetting({}, 'dormantDays', 14.9).config.dormantDays, 14)

  const neg = applySetting({ dormantDays: 14 }, 'dormantDays', -1)
  assert.ok(neg.error.includes('0–365'))
  assert.deepEqual(neg.config, { dormantDays: 14 })
  assert.ok(applySetting({}, 'dormantDays', 366).error.includes('0–365'))
  assert.ok(applySetting({}, 'dormantDays', 'abc').error.includes('数字'))
  assert.ok(applySetting({}, 'dormantDays', true).error.includes('数字'))
})

test('applySetting：inflectionNotice 布尔转换与非法报错', () => {
  assert.equal(applySetting({}, 'inflectionNotice', true).config.inflectionNotice, true)
  assert.equal(applySetting({}, 'inflectionNotice', false).config.inflectionNotice, false)
  assert.equal(applySetting({}, 'inflectionNotice', 'on').config.inflectionNotice, true)
  assert.equal(applySetting({}, 'inflectionNotice', '0').config.inflectionNotice, false)
  const bad = applySetting({ inflectionNotice: true }, 'inflectionNotice', 'maybe')
  assert.ok(bad.error.includes('true'))
  assert.deepEqual(bad.config, { inflectionNotice: true })
})

test('applySetting：未知键只报错不动配置', () => {
  const before = { provider: 'keep' }
  const result = applySetting(before, 'nope', 1)
  assert.ok(result.error.includes('未知设置项'))
  assert.deepEqual(result.config, before)
  assert.equal(before.nope, undefined)
})

// ── diffConfig ──────────────────────────────────────────────────────
test('diffConfig：只含 after 中变化的键', () => {
  assert.deepEqual(diffConfig({ a: 1, b: 'x' }, { a: 1, b: 'y' }), { b: 'y' })
  assert.deepEqual(diffConfig({ a: 1 }, { a: 1 }), {})
  assert.deepEqual(diffConfig({ a: 1 }, { a: 1, c: 2 }), { c: 2 })
  assert.deepEqual(diffConfig({ a: 0 }, { a: '' }), { a: '' })
  assert.deepEqual(diffConfig({ a: 0 }, { a: false }), { a: false })
  assert.deepEqual(diffConfig({ a: { x: 1 } }, { a: { x: 1 } }), {})
})

test('diffConfig：缺失键、非对象与删除语义', () => {
  assert.deepEqual(diffConfig(null, { a: 1 }), { a: 1 })
  assert.deepEqual(diffConfig({ a: 1 }, null), {})
  assert.deepEqual(diffConfig(undefined, undefined), {})
  // after 缺少的键视为本次未提交，不进 POST。
  assert.deepEqual(diffConfig({ a: 1, b: 2 }, { a: 1 }), {})
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) console.log(`\n${failure.name}\n${failure.error.stack}`)
  process.exit(1)
}
