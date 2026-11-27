/**
 * 事续接 v2 端到端集成测试（lead 所有，验证 ADR-0006 ~ ADR-0010 的联合行为）。
 *
 * 只依赖契约文件 docs/contracts/resume-v2-interfaces.md 定义的接口。
 * 运行：node tests/resume-v2-integration.mjs
 */
import { judgeAdmission } from '../lib/admission.js'
import { suggestNextStep, extractTailFeatures } from '../lib/next-step.js'
import { sliceSessionSegments, detectAwaitingHuman } from '../lib/segment.js'
import { planColdStartWorks } from '../lib/work-merge.js'
import { projectResumeCards, createWork } from '../lib/work-model.js'

let passed = 0
let failed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failed += 1
    failures.push(name + ' → ' + (error && error.message ? error.message : String(error)))
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error((label || 'eq') + ': 实际 ' + a + ' 期望 ' + b)
}

function ok(v, label) { if (v !== true) throw new Error((label || 'ok') + ': 期望 true，实际 ' + JSON.stringify(v)) }

// ── 语料：一次连续排障（20 轮，含报错与 AI 反问） ─────────────────
function troubleShootingTurns() {
  const turns = []
  const prompts = [
    '帮我看下这个插件加载报错', '还是报错，我贴一下完整日志', '试试换成动态 import',
    '现在不报错了，但是界面白屏', '白屏问题定位到了，是嵌入模块导出缺失',
    '修一下导出清单', '导出补齐了，但测试挂了', '跑一下全量测试看看',
    '另外 3 个用例也失败了', '继续修', '修完了，全量测试通过',
    '现在验证一下真实 DSH', '真实 DSH 加载正常', '再检查一次 bundle',
    'bundle 校验 10/10 通过', '准备提交', '提交前再确认一遍',
    '还有个小问题，撤回列表没刷新', '顺手修了', '这个改动要不要一起提交？',
  ]
  for (let i = 0; i < prompts.length; i += 1) {
    turns.push({
      turn: i + 1,
      seq: i * 2 + 1,
      prompt: prompts[i],
      start: 1_700_000_000_000 + i * 60_000,
      end: 1_700_000_000_000 + i * 60_000 + 30_000,
      files: i >= 4 ? ['lib/client.js', 'lib/work-view.js'] : [],
      commands: i >= 7 ? ['node scripts/test-all.mjs'] : [],
      ok: i !== 7 && i !== 8,
    })
  }
  return turns
}

// ── 语料：纯架构咨询（无产出意图） ───────────────────────────────
function consultTurns() {
  return [
    { turn: 1, seq: 1, prompt: '什么是 CQRS？', start: 1_700_000_000_000, end: 1_700_000_030_000, files: [], commands: [], ok: true },
    { turn: 2, seq: 3, prompt: '那和事件溯源有什么区别？', start: 1_700_000_060_000, end: 1_700_000_090_000, files: [], commands: [], ok: true },
    { turn: 3, seq: 5, prompt: '明白了，谢谢', start: 1_700_000_120_000, end: 1_700_000_150_000, files: [], commands: [], ok: true },
  ]
}

// ── 语料：3 轮小修已验收收口 ─────────────────────────────────────
function smallFixTurns() {
  return [
    { turn: 1, seq: 1, prompt: '把 README 里的旧图删掉', start: 1_700_000_000_000, end: 1_700_000_010_000, files: [], commands: [], ok: true },
    { turn: 2, seq: 3, prompt: '删除并提交', start: 1_700_000_020_000, end: 1_700_000_030_000, files: ['README.md'], commands: ['git commit -m docs'], ok: true },
    { turn: 3, seq: 5, prompt: '好了，可以了，这个结束', start: 1_700_000_040_000, end: 1_700_000_050_000, files: [], commands: [], ok: true },
  ]
}

const NOW = 1_700_100_000_000

// ── ADR-0006：准入三红线 ─────────────────────────────────────────
check('ADR-0006 连续排障会话应准入（有意图 + 未收尾 + 人类主导）', () => {
  const turns = troubleShootingTurns()
  const res = judgeAdmission({ turns, title: '修复插件加载报错', sessionCount: 1, turnCount: turns.length }, { now: NOW })
  ok(res.admitted === true, 'admitted')
  eq(res.reasons, [], 'reasons 应为空')
})

check('ADR-0006 纯架构咨询不进续接（no_intent）', () => {
  const turns = consultTurns()
  const res = judgeAdmission({ turns, title: '咨询 CQRS', sessionCount: 1, turnCount: turns.length }, { now: NOW })
  ok(res.admitted === false, 'admitted 应为 false')
  ok(res.reasons.includes('no_intent'), 'reasons 应含 no_intent，实际 ' + JSON.stringify(res.reasons))
})

check('ADR-0006 已验收收口的小修不进续接（already_closed）', () => {
  const turns = smallFixTurns()
  const res = judgeAdmission({ turns, title: '删除旧图', sessionCount: 1, turnCount: turns.length, state: 'done' }, { now: NOW })
  ok(res.admitted === false, 'admitted 应为 false')
  ok(res.reasons.includes('already_closed'), 'reasons 应含 already_closed，实际 ' + JSON.stringify(res.reasons))
})

check('ADR-0006 子代理/自动化会话不进续接（not_human）', () => {
  const res = judgeAdmission({ turns: troubleShootingTurns(), trigger: 'automated', sessionCount: 1 }, { now: NOW })
  ok(res.admitted === false, 'admitted')
  ok(res.reasons.includes('not_human'), 'reasons 含 not_human，实际 ' + JSON.stringify(res.reasons))
})

check('ADR-0006 人的确认高于红线（confirmed 一律准入）', () => {
  const res = judgeAdmission({ turns: consultTurns(), title: '咨询', stateSource: 'confirmed' }, { now: NOW })
  ok(res.admitted === true, 'confirmed 应准入')
  eq(res.reasons, [], 'reasons 空')
})

// ── ADR-0009：下一步绝不留白 ─────────────────────────────────────
check('ADR-0009 任何输入下下一步都不留白且不含占位空话', () => {
  const cases = [
    { turns: troubleShootingTurns() },
    { turns: consultTurns() },
    { turns: [] },
    { turns: [{ turn: 1, seq: 1, prompt: '', files: [], commands: [], ok: true }] },
    {},
  ]
  for (let i = 0; i < cases.length; i += 1) {
    const s = suggestNextStep(cases[i], { now: NOW })
    ok(typeof s.text === 'string' && s.text.trim() !== '', 'case ' + i + ' text 非空，实际 ' + JSON.stringify(s.text))
    ok(s.text.indexOf('待补充') === -1, 'case ' + i + ' 不得含「待补充」，实际 ' + s.text)
  }
})

check('ADR-0009 末轮停在 AI 反问时优先给「回复确认项」', () => {
  const turns = [
    { turn: 1, seq: 1, prompt: '改一下设置项', start: 1, end: 2, files: ['lib/settings-view.js'], commands: [], ok: true },
    { turn: 2, seq: 3, prompt: '好', start: 3, end: 4, files: [], commands: [], ok: true, assistantTail: '这个改动要不要一起提交？', assistantAsked: true },
  ]
  const s = suggestNextStep({ turns }, { now: NOW })
  eq(s.kind, 'awaiting', 'kind')
  ok(s.text.indexOf('回复') === 0 || s.text.indexOf('回复') > -1, '应引导回复确认项，实际 ' + s.text)
})

// ── ADR-0007：主线聚合防碎 ───────────────────────────────────────
check('ADR-0007 20 轮连续排障会话聚成 1 条事（不再切碎）', () => {
  const turns = troubleShootingTurns()
  const segs = sliceSessionSegments(turns, { sessionId: 's-ts', strategy: 'mainline' })
  const plan = planColdStartWorks(segs.map(s => ({ ...s, sessionId: 's-ts' })), { now: NOW, workspaceId: 'ws-1' })
  const works = plan.works.filter(w => w.admission === undefined || w.admission.admitted !== false)
  ok(works.length <= 2, '同一连续会话产出事数应 ≤2，实际 ' + works.length)
})

check('ADR-0007 六会话不再炸出十几张碎卡', () => {
  const all = []
  for (let s = 1; s <= 6; s += 1) {
    const segs = sliceSessionSegments(troubleShootingTurns(), { sessionId: 's-' + s, strategy: 'mainline' })
    for (const seg of segs) all.push({ ...seg, sessionId: 's-' + s })
  }
  const plan = planColdStartWorks(all, { now: NOW, workspaceId: 'ws-1' })
  ok(plan.works.length <= 12, '6 会话产出事数应远小于 19，实际 ' + plan.works.length)
})

// ── ADR-0008 / 卡片投影 ─────────────────────────────────────────
check('未准入的事不进 unresolved，改入 excluded', () => {
  const store = {
    version: 1, workspaceId: 'ws-1', initializedAt: NOW, updatedAt: NOW,
    works: [
      { id: 'w-a', title: '在推的事', state: 'active', stateSource: 'inferred', lastActivityAt: NOW, admission: { admitted: true, reasons: [], kind: 'work' }, segmentIds: [], sessionIds: [], files: [], decisions: [], evidenceHandles: [] },
      { id: 'w-b', title: '问个概念', state: 'active', stateSource: 'inferred', lastActivityAt: NOW, admission: { admitted: false, reasons: ['no_intent'], kind: 'chat' }, segmentIds: [], sessionIds: [], files: [], decisions: [], evidenceHandles: [] },
    ],
    segments: {}, dismissedSegments: {}, lockedWorkIds: [],
  }
  const cards = projectResumeCards(store, { now: NOW })
  const ids = cards.unresolved.map(c => c.id)
  ok(ids.indexOf('w-a') >= 0, 'w-a 应在 unresolved')
  ok(ids.indexOf('w-b') === -1, 'w-b 不应在 unresolved')
  ok(Array.isArray(cards.excluded) && cards.excluded.some(c => c.id === 'w-b'), 'w-b 应在 excluded')
})

check('卡片透出待确认与下一步来源', () => {
  const w = createWork({
    id: 'w-c', title: '等确认', state: 'active', stateSource: 'inferred',
    awaiting: { active: true, summary: '这个改动要不要一起提交？', turn: 20 },
    nextStep: '回复第 20 轮的确认项', nextStepSource: 'inferred', nextStepKind: 'awaiting',
  }, NOW)
  const store = { version: 1, workspaceId: 'ws-1', initializedAt: NOW, updatedAt: NOW, works: [w], segments: {}, dismissedSegments: {}, lockedWorkIds: [] }
  const cards = projectResumeCards(store, { now: NOW })
  const card = cards.unresolved.find(c => c.id === 'w-c')
  ok(card !== undefined, '卡片应存在')
  ok(card.awaitingActive === true, 'awaitingActive')
  ok(typeof card.awaitingSummary === 'string' && card.awaitingSummary !== '', 'awaitingSummary 非空')
  ok(typeof card.nextStepKind === 'string' && card.nextStepKind !== '', 'nextStepKind 非空')
})

console.log('resume-v2-integration: ' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}