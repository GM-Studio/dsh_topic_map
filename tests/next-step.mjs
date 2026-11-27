/**
 * 下一步建议（ADR-0009：续接首页的下一步绝不留白）与末轮特征提取的行为测试。
 *
 * 覆盖：
 *   1. 四条规则兜底优先级严格为 awaiting > error > files > resume；
 *   2. 任何输入下 text 都非空，且绝不出现「待补充」占位空话；
 *   3. 每条建议都带具体对象（报错首行 / 命令 / 文件名 / 轮号 / 目标摘要）；
 *   4. 返回值带 turn / source / kind，kind 取值受限；
 *   5. 摘要裁剪 ≤ 60 字符，且绝不切断 UTF-16 代理对（Emoji）；
 *   6. extractTailFeatures 的字段契约（lastTurn / hasError / errorHead / errorTurn /
 *      lastCommand / changedFiles / awaitingHuman / awaitingSummary / awaitingTurn /
 *      goalSummary / closedSignals）；
 *   7. 确定性、不改入参、异常输入不抛。
 *
 * 语料全部为合成文本，不含任何真实会话正文与路径。
 *
 * Run: node tests/next-step.mjs
 */

import { strict as assert } from 'node:assert'
import { extractTailFeatures, suggestNextStep, detectAwaitingHuman } from '../lib/next-step.js'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures.push({ name, error: e })
    console.log(`  FAIL ${name}\n       ${String(e.message).split('\n').join('\n       ')}`)
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

function turn(overrides = {}) {
  return {
    turn: 1,
    seq: 1,
    prompt: '修复登录鉴权报错',
    start: 1_700_000_000_000,
    end: 1_700_000_030_000,
    files: [],
    commands: [],
    ok: true,
    ...overrides,
  }
}

/** 是否存在落单的 UTF-16 代理项（决定 Emoji 有没有被切断）。 */
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i += 1
    } else if (c >= 0xdc00 && c <= 0xdfff) return true
  }
  return false
}

const KINDS = ['error', 'awaiting', 'files', 'resume']
const SESSION = '4c42ff36-aaaa-4bbb-8ccc-000000000001'

console.log('\nnext-step')

// ── extractTailFeatures ────────────────────────────────────────────

test('extractTailFeatures 返回契约全部字段且类型正确', () => {
  const f = extractTailFeatures([turn()])
  for (const key of ['lastTurn', 'hasError', 'errorHead', 'errorTurn', 'lastCommand', 'changedFiles',
    'awaitingHuman', 'awaitingSummary', 'awaitingTurn', 'goalSummary', 'closedSignals']) {
    assert.ok(Object.prototype.hasOwnProperty.call(f, key), `缺字段 ${key}`)
  }
  assert.equal(typeof f.hasError, 'boolean')
  assert.equal(typeof f.awaitingHuman, 'boolean')
  assert.ok(Array.isArray(f.changedFiles))
  assert.equal(typeof f.errorHead, 'string')
  assert.equal(typeof f.awaitingSummary, 'string')
  assert.equal(typeof f.closedSignals, 'object')
  assert.equal(f.lastTurn, 1)
})

test('extractTailFeatures 提取末轮失败：hasError / errorHead / errorTurn', () => {
  const turns = [
    turn({ turn: 1, prompt: '修一下构建脚本' }),
    turn({
      turn: 2,
      prompt: '还是不行',
      ok: false,
      endReason: 'error',
      files: ['lib/work-view.js'],
      commands: ['node scripts/build-theme.mjs'],
      responseTail: 'TypeError: x is not a function\n    at buildTheme (scripts/build-theme.mjs:12:3)',
    }),
  ]
  const f = extractTailFeatures(turns, { sessionId: SESSION })
  assert.equal(f.hasError, true)
  assert.equal(f.errorTurn, 2)
  assert.equal(f.errorHead, 'TypeError: x is not a function')
  assert.equal(f.lastCommand, 'node scripts/build-theme.mjs')
  assert.deepEqual(f.changedFiles, ['lib/work-view.js'])
  assert.equal(f.lastTurn, 2)
})

test('extractTailFeatures：ok:false 的命令结果也算末轮失败（含 exit code）', () => {
  const turns = [turn({
    turn: 3,
    commands: ['node scripts/verify-bundle.mjs'],
    commandResults: [{ command: 'node scripts/verify-bundle.mjs', ok: false, exitCode: 1 }],
    response: '[exit code: 1]',
  })]
  const f = extractTailFeatures(turns)
  assert.equal(f.hasError, true)
  assert.equal(f.errorTurn, 3)
  assert.ok(f.errorHead.length > 0)
})

test('extractTailFeatures：识别末轮停在 AI 反问（awaitingHuman / awaitingSummary / awaitingTurn）', () => {
  const turns = [
    turn({ turn: 1, prompt: '改一下设置项', files: ['lib/settings-view.js'] }),
    turn({ turn: 2, prompt: '好', assistantTail: '这个改动要不要一起提交？', assistantAsked: true }),
  ]
  const f = extractTailFeatures(turns)
  assert.equal(f.awaitingHuman, true)
  assert.equal(f.awaitingTurn, 2)
  assert.ok(f.awaitingSummary.length > 0)
  assert.ok(f.awaitingSummary.indexOf('提交') >= 0, f.awaitingSummary)
})

test('extractTailFeatures：无反问时 awaitingHuman 为 false 且摘要为空串', () => {
  const f = extractTailFeatures([turn({ assistantTail: '已经改好了，测试全部通过。' })])
  assert.equal(f.awaitingHuman, false)
  assert.equal(f.awaitingSummary, '')
  assert.equal(f.awaitingTurn, null)
})

test('extractTailFeatures：goalSummary 优先取显式 goal，其次末轮 prompt；空输入给空串', () => {
  const withGoal = extractTailFeatures([turn({ prompt: '接着改' })], { goal: '消除并发刷新 401' })
  assert.equal(withGoal.goalSummary, '消除并发刷新 401')
  const withoutGoal = extractTailFeatures([turn({ turn: 4, prompt: '把导出清单补全' })])
  assert.equal(withoutGoal.goalSummary, '把导出清单补全')
  const empty = extractTailFeatures([])
  assert.equal(empty.goalSummary, '')
  assert.equal(empty.lastTurn, null)
  assert.equal(empty.hasError, false)
  assert.equal(empty.awaitingHuman, false)
  assert.deepEqual(empty.changedFiles, [])
})

test('extractTailFeatures：closedSignals 回报测试通过 / 提交 / 人收口三证据', () => {
  const turns = [
    turn({ turn: 1, prompt: '删掉旧图', files: ['README.md'], commands: ['git commit -m "docs: 删除旧图"'] }),
    turn({ turn: 2, prompt: '好了，可以了', commands: ['node scripts/test.mjs'], commandResults: [{ command: 'node scripts/test.mjs', ok: true, exitCode: 0 }] }),
  ]
  const f = extractTailFeatures(turns)
  assert.equal(f.closedSignals.committed, true)
  assert.equal(f.closedSignals.verified, true)
  assert.equal(f.closedSignals.userClosed, true)
})

test('detectAwaitingHuman：已委托 segment.js 的权威实现（数组入参 + 结论对象）', () => {
  const asked = detectAwaitingHuman([turn({ assistantTail: '要不要一起提交？' })])
  assert.equal(asked.active, true)
  assert.equal(asked.reason, 'question')
  assert.ok(asked.summary.length > 0)
  assert.equal(asked.turn, 1)

  assert.equal(detectAwaitingHuman([turn({ assistantTail: '需要我继续吗？' })]).active, true)
  assert.equal(detectAwaitingHuman([turn({ assistantAsked: true })]).active, true)
  assert.equal(detectAwaitingHuman([turn({ assistantTail: '改完了，测试通过。' })]).active, false)
  assert.equal(detectAwaitingHuman([]).active, false)
  assert.equal(detectAwaitingHuman(null).active, false)
  assert.equal(detectAwaitingHuman([turn({ assistantTail: '' })]).active, false)
})

test('轮号缺失但有 AI 反问时，不得静默丢成「无待确认」', () => {
  const noTurn = { prompt: '好', files: [], commands: [], ok: true, assistantTail: '这个改动要不要一起提交？' }
  const f = extractTailFeatures([noTurn, noTurn])
  assert.equal(f.awaitingHuman, true, '缺 turn 字段不得丢掉待确认信号')
  assert.equal(f.awaitingTurn, 2, '补的轮号应取数组长度')
  assert.ok(f.awaitingSummary.length > 0)
})

test('detectAwaitingHuman 委托后：extractTailFeatures 的 awaiting 字段与它一致', () => {
  const turns = [
    turn({ turn: 1, prompt: '改一下设置项', files: ['lib/settings-view.js'] }),
    turn({ turn: 2, prompt: '好', assistantTail: '这个改动要不要一起提交？' }),
  ]
  const direct = detectAwaitingHuman(turns)
  const f = extractTailFeatures(turns)
  assert.equal(f.awaitingHuman, direct.active)
  assert.equal(f.awaitingTurn, direct.turn)
  assert.equal(f.awaitingReason, direct.reason)
  assert.equal(f.awaitingHuman, true)
})

// ── suggestNextStep：优先级 ─────────────────────────────────────────

test('优先级 1：末轮反问 → kind awaiting，并引导回复确认项', () => {
  const turns = [
    turn({ turn: 1, prompt: '改一下设置项', files: ['lib/settings-view.js'] }),
    turn({ turn: 2, prompt: '好', assistantTail: '这个改动要不要一起提交？', assistantAsked: true }),
  ]
  const s = suggestNextStep({ turns }, { sessionId: SESSION })
  assert.equal(s.kind, 'awaiting')
  assert.ok(s.text.indexOf('回复') === 0 || s.text.indexOf('回复') > -1, s.text)
  assert.ok(s.text.indexOf('2') > -1, '应带轮号，实际 ' + s.text)
})

test('优先级 2：末轮失败 → kind error，带轮号与命令或报错首行', () => {
  const turns = [
    turn({ turn: 7, prompt: '跑全量测试' }),
    turn({
      turn: 8,
      prompt: '还是失败',
      ok: false,
      endReason: 'error',
      commands: ['node scripts/test.mjs'],
      responseTail: 'AssertionError: 期望 3 得到 2',
    }),
  ]
  const s = suggestNextStep({ turns })
  assert.equal(s.kind, 'error')
  assert.ok(s.text.indexOf('8') > -1, '应带轮号，实际 ' + s.text)
  assert.ok(s.text.indexOf('node scripts/test.mjs') > -1 || s.text.indexOf('AssertionError') > -1, s.text)
})

test('优先级 3：无反问无报错但有文件改动 → kind files，带文件名', () => {
  const turns = [turn({ turn: 5, files: ['lib/admission.js'], commands: ['node tests/admission.mjs'] })]
  const s = suggestNextStep({ turns })
  assert.equal(s.kind, 'files')
  assert.ok(s.text.indexOf('lib/admission.js') > -1, s.text)
})

test('优先级 4：兜底 resume，带轮号与目标摘要', () => {
  const s = suggestNextStep({ turns: [turn({ turn: 9, prompt: '把导出清单补全' })], goal: '补全导出清单' })
  assert.equal(s.kind, 'resume')
  assert.ok(s.text.indexOf('9') > -1, s.text)
  assert.ok(s.text.indexOf('补全导出清单') > -1, s.text)
})

test('优先级严格：四种信号同时存在时依次降级 awaiting → error → files → resume', () => {
  const rich = [
    turn({ turn: 1, prompt: '改一下设置项', files: ['lib/settings-view.js'] }),
    turn({
      turn: 2,
      prompt: '好，继续',
      files: ['lib/admission.js'],
      commands: ['node scripts/test.mjs'],
      ok: false,
      endReason: 'error',
      responseTail: 'Error: boom',
      assistantTail: '要不要一起提交？',
      assistantAsked: true,
    }),
  ]
  assert.equal(suggestNextStep({ turns: rich }).kind, 'awaiting')

  const noAwait = rich.map(t => ({ ...t, assistantAsked: false, assistantTail: '改完了' }))
  assert.equal(suggestNextStep({ turns: noAwait }).kind, 'error')

  const noError = noAwait.map(t => ({ ...t, ok: true, endReason: 'completed', responseTail: '' }))
  assert.equal(suggestNextStep({ turns: noError }).kind, 'files')

  const noFiles = noError.map(t => ({ ...t, files: [] }))
  assert.equal(suggestNextStep({ turns: noFiles }).kind, 'resume')
})

test('优先级：input.awaiting.active 为 true 时即使末轮没反问也走 awaiting', () => {
  const s = suggestNextStep({
    turns: [turn({ turn: 3, prompt: '接着改' })],
    awaiting: { active: true, summary: '这个改动要不要一起提交？', turn: 3 },
  })
  assert.equal(s.kind, 'awaiting')
  assert.ok(s.text.indexOf('提交') > -1, s.text)
})

// ── suggestNextStep：绝不留白 ───────────────────────────────────────

test('任何输入下都不留白、不含「待补充」「待补充下一步行动」', () => {
  const cases = [
    { turns: [] },
    {},
    null,
    undefined,
    { turns: [{ turn: 1, seq: 1, prompt: '', files: [], commands: [], ok: true }] },
    { turns: [turn({ prompt: '', files: [], commands: [], assistantTail: '', responseTail: '' })] },
    { turns: [turn({ prompt: '', assistantTail: '？' })] },
    { turns: [turn({ prompt: '   ', goal: '', title: '' })], goal: '', title: '' },
    { turns: [turn({ ok: false, endReason: 'error', responseTail: '', commands: [] })] },
    { turns: [turn({ files: [''], commands: [''] })] },
  ]
  for (let i = 0; i < cases.length; i += 1) {
    const s = suggestNextStep(cases[i])
    assert.equal(typeof s.text, 'string', 'case ' + i)
    assert.notEqual(s.text.trim(), '', 'case ' + i + ' 不得留白')
    assert.equal(s.text.indexOf('待补充'), -1, 'case ' + i + ' 不得含占位空话：' + s.text)
    assert.equal(s.text.indexOf('待定'), -1, 'case ' + i + ' 不得含「待定」：' + s.text)
    assert.ok(KINDS.indexOf(s.kind) >= 0, 'case ' + i + ' kind 受限，实际 ' + s.kind)
    assert.ok(s.text.length <= 60, 'case ' + i + ' ≤60 字符，实际 ' + s.text.length)
  }
})

test('BLANK_RE 口径：输出永不匹配干跑脚本判空的正则', () => {
  const BLANK_RE = /^(?:$|待补充|待补充下一步行动|待定|无|暂无)$/
  const inputs = [
    { turns: [] },
    {},
    { turns: [turn({ prompt: '' })] },
    { turns: [turn({ prompt: '随便', files: [], commands: [] })] },
  ]
  for (const input of inputs) {
    assert.equal(BLANK_RE.test(suggestNextStep(input).text), false, JSON.stringify(suggestNextStep(input)))
  }
})

// ── suggestNextStep：返回值形状 ─────────────────────────────────────

test('返回值恒带 text / source / kind / turn / evidenceHandle', () => {
  const s = suggestNextStep({ turns: [turn({ turn: 12, prompt: '补测试' })] }, { sessionId: SESSION })
  assert.equal(s.source, 'rule')
  assert.equal(s.turn, 12)
  assert.equal(typeof s.evidenceHandle, 'string')
  assert.ok(/^[0-9a-fA-F]{8}#\d+$/.test(s.evidenceHandle), '证据句柄格式，实际 ' + s.evidenceHandle)
})

test('evidenceHandle：没有会话 id 时为空串（不编造）', () => {
  const s = suggestNextStep({ turns: [turn({ turn: 2 })] })
  assert.equal(s.evidenceHandle, '')
})

test('model 精化：显式传入 modelText 时 source 为 model，文本仍非空', () => {
  const s = suggestNextStep({ turns: [turn()] }, { modelText: '直接跑一遍 scripts/test.mjs' })
  assert.equal(s.source, 'model')
  assert.equal(s.text, '直接跑一遍 scripts/test.mjs')
})

test('model 精化：modelText 为空串/空白时忽略，回落规则且非空', () => {
  const s = suggestNextStep({ turns: [turn({ turn: 2, prompt: '补测试' })] }, { modelText: '   ' })
  assert.equal(s.source, 'rule')
  assert.notEqual(s.text.trim(), '')
})

// ── 裁剪：≤60 字符且不切断 Emoji ────────────────────────────────────

test('摘要裁剪：长 Emoji 摘要不切断代理对，且 ≤60 字符', () => {
  const emoji = '😀'.repeat(40)
  const s = suggestNextStep({ turns: [turn({ turn: 3, assistantTail: `要不要一起提交？${emoji}`, assistantAsked: true })] })
  assert.ok(Array.from(s.text).length <= 60, '长度 ' + Array.from(s.text).length)
  assert.equal(hasLoneSurrogate(s.text), false, '不得切断代理对：' + JSON.stringify(s.text))
})

test('摘要裁剪：长中文 + Emoji 混排报错首行同样不切断', () => {
  const s = suggestNextStep({
    turns: [turn({
      turn: 4,
      ok: false,
      endReason: 'error',
      commands: [],
      responseTail: `Error: 构建失败 ${'🎉'.repeat(30)} 请检查`,
    })],
  })
  assert.ok(Array.from(s.text).length <= 60)
  assert.equal(hasLoneSurrogate(s.text), false, JSON.stringify(s.text))
})

test('extractTailFeatures 的 awaitingSummary / errorHead 也遵守 60 字符与代理对约束', () => {
  const f = extractTailFeatures([
    turn({ turn: 1, assistantTail: `要不要 🚀${'🧪'.repeat(50)} 一起提交？`, assistantAsked: true }),
  ])
  assert.ok(Array.from(f.awaitingSummary).length <= 60)
  assert.equal(hasLoneSurrogate(f.awaitingSummary), false)

  const g = extractTailFeatures([turn({ turn: 2, ok: false, endReason: 'error', responseTail: 'E'.repeat(200) })])
  assert.ok(Array.from(g.errorHead).length <= 60)
})

// ── 确定性 / 健壮性 ─────────────────────────────────────────────────

test('确定性：同输入同输出，且不修改入参', () => {
  const input = deepFreeze({
    turns: deepFreeze([turn({ turn: 1, files: ['lib/admission.js'] }), turn({ turn: 2, prompt: '' })]),
  })
  const a = suggestNextStep(input)
  const b = suggestNextStep(input)
  assert.deepEqual(a, b)
  assert.equal(extractTailFeatures(input.turns).lastTurn, 2)
})

test('健壮性：异常类型输入一律安全返回，不抛异常', () => {
  for (const bad of [null, undefined, 0, '', 'x', [], true]) {
    const s = suggestNextStep(bad)
    assert.equal(typeof s.text, 'string')
    assert.ok(KINDS.indexOf(s.kind) >= 0)
    const f = extractTailFeatures(bad)
    assert.equal(typeof f.hasError, 'boolean')
  }
})

test('健壮性：options 异常值不抛，turns 非数组时按空处理', () => {
  assert.equal(suggestNextStep({ turns: 'nope' }, null).kind, 'resume')
  assert.equal(extractTailFeatures({ turns: 'nope' }).lastTurn, null)
  assert.equal(extractTailFeatures([null, 1, 'x']).lastTurn, null)
})

test('健壮性：混合脏轮次数组不会误判成 awaiting / error', () => {
  const f = extractTailFeatures([null, { turn: 'x' }, { turn: 2, prompt: 42, files: 'nope', commands: null }])
  assert.equal(f.hasError, false)
  assert.equal(f.awaitingHuman, false)
  assert.ok(KINDS.indexOf(suggestNextStep({ turns: [null, { turn: 'x' }] }).kind) >= 0)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
