/**
 * 主线聚合测试（ADR-0007）：防碎 + 该拆时仍能拆。
 * 运行：node tests/mainline.mjs
 */
import { sliceSessionSegments, detectAwaitingHuman } from '../lib/segment.js'
import { planColdStartWorks } from '../lib/work-merge.js'

let passed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1 } catch (e) { failures.push(name + ' → ' + e.message) }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m||'') + ' 实际 ' + JSON.stringify(a) + ' 期望 ' + JSON.stringify(b)) }
function ok(v, m) { if (v !== true) throw new Error((m||'') + ' 期望 true，实际 ' + JSON.stringify(v)) }

const T0 = 1_700_000_000_000
const MIN = 60_000

/** 连续 20 轮排障：间隔 1 分钟，无转折、无长间隔。 */
function continuousTurns() {
  const prompts = [
    '帮我看下这个插件加载报错','还是报错，我贴一下完整日志','试试换成动态 import',
    '现在不报错了，但是界面白屏','白屏问题定位到了，是嵌入模块导出缺失','修一下导出清单',
    '导出补齐了，但测试挂了','跑一下全量测试看看','另外 3 个用例也失败了','继续修',
    '修完了，全量测试通过','现在验证一下真实 DSH','真实 DSH 加载正常','再检查一次 bundle',
    'bundle 校验 10/10 通过','准备提交','提交前再确认一遍','还有个小问题，撤回列表没刷新',
    '顺手修了','这个改动要不要一起提交？',
  ]
  return prompts.map((p, i) => ({
    turn: i + 1, seq: i * 2 + 1, prompt: p,
    start: T0 + i * MIN, end: T0 + i * MIN + 30_000,
    files: i >= 4 ? ['lib/client.js'] : [], commands: i >= 7 ? ['node scripts/test-all.mjs'] : [],
    ok: i !== 7 && i !== 8,
  }))
}

check('mainline：20 轮连续排障切成 1 段（不再碎）', () => {
  const segs = sliceSessionSegments(continuousTurns(), { sessionId: 's-a', strategy: 'mainline' })
  eq(segs.length, 1, '段数')
})

check('boundary（旧口径）：同样输入会被切碎，证明两条策略确实不同', () => {
  const segs = sliceSessionSegments(continuousTurns(), { sessionId: 's-a' })
  ok(segs.length > 1, 'boundary 应切出多段，实际 ' + segs.length)
})

check('mainline：长间隔必须仍然切开（不能把两件事糊成一件）', () => {
  const turns = [
    { turn: 1, seq: 1, prompt: '修 auth/login.js 的 token 过期', start: T0, end: T0 + 5000, files: ['src/auth/login.js'], commands: [], ok: true },
    { turn: 2, seq: 3, prompt: '优化 billing/invoice.js 的 PDF 渲染', start: T0 + 120 * MIN, end: T0 + 120 * MIN + 5000, files: ['src/billing/invoice.js'], commands: [], ok: true },
  ]
  const segs = sliceSessionSegments(turns, { sessionId: 's-b', strategy: 'mainline' })
  eq(segs.length, 2, '两小时间隔应切成 2 段')
})

check('mainline：人类显式转折「换个话题」要切开', () => {
  const turns = [
    { turn: 1, seq: 1, prompt: '修一下导出清单', start: T0, end: T0 + 5000, files: ['lib/a.js'], commands: [], ok: true },
    { turn: 2, seq: 3, prompt: '换个话题，帮我看下部署脚本', start: T0 + 10 * MIN, end: T0 + 10 * MIN + 5000, files: ['scripts/deploy.mjs'], commands: [], ok: true },
  ]
  const segs = sliceSessionSegments(turns, { sessionId: 's-c', strategy: 'mainline' })
  eq(segs.length, 2, '显式转折应切成 2 段')
})

check('mainline：裸「另外」不算转折（真机实测会炸出碎卡）', () => {
  const turns = [
    { turn: 1, seq: 1, prompt: '把本机正式版撤回原有版本', start: T0, end: T0 + 5000, files: ['server/app.js'], commands: [], ok: true },
    { turn: 2, seq: 3, prompt: '另外 之前开发好的开关也一起带上', start: T0 + 10 * MIN, end: T0 + 10 * MIN + 5000, files: ['server/app.js'], commands: [], ok: true },
  ]
  const segs = sliceSessionSegments(turns, { sessionId: 's-g', strategy: 'mainline' })
  eq(segs.length, 1, '「另外 之前…」是同一件事的补充，不得切开')
})

check('mainline：「另外 3 个用例也失败了」不算转折（同一件事的继续）', () => {
  const turns = [
    { turn: 1, seq: 1, prompt: '导出补齐了，但测试挂了', start: T0, end: T0 + 5000, files: ['lib/a.js'], commands: [], ok: true },
    { turn: 2, seq: 3, prompt: '另外 3 个用例也失败了', start: T0 + 2 * MIN, end: T0 + 2 * MIN + 5000, files: ['lib/a.js'], commands: [], ok: true },
  ]
  const segs = sliceSessionSegments(turns, { sessionId: 's-d', strategy: 'mainline' })
  eq(segs.length, 1, '不得因「另外+数字」切开')
})

check('聚合：6 个会话的连续工作不再炸出 19 张碎卡', () => {
  const all = []
  for (let s = 1; s <= 6; s += 1) {
    const segs = sliceSessionSegments(continuousTurns(), { sessionId: 's-' + s, strategy: 'mainline' })
    for (const seg of segs) all.push({ ...seg, sessionId: 's-' + s, workspaceId: 'ws-1' })
  }
  const plan = planColdStartWorks(all, { now: T0 + 60 * MIN, workspaceId: 'ws-1' })
  ok(plan.works.length <= 12, '事数应远小于旧的 19，实际 ' + plan.works.length)
})

check('聚合：每条事都带 nextStep 且绝不留白', () => {
  const segs = sliceSessionSegments(continuousTurns(), { sessionId: 's-e', strategy: 'mainline' })
  const plan = planColdStartWorks(segs.map(s => ({ ...s, workspaceId: 'ws-1' })), { now: T0 + 60 * MIN, workspaceId: 'ws-1' })
  for (const w of plan.works) {
    ok(typeof w.nextStep === 'string' && w.nextStep.trim() !== '', 'nextStep 留白了: ' + w.id)
    ok(w.nextStep.indexOf('待补充') === -1, 'nextStep 出现占位空话: ' + w.nextStep)
  }
})

check('聚合：段带 awaiting 时聚成事的 awaiting 也可见', () => {
  const segs = sliceSessionSegments([
    { turn: 1, seq: 1, prompt: '改一下设置项', start: T0, end: T0 + 5000, files: ['lib/settings-view.js'], commands: [], ok: true,
      changes: { files: [{ path: 'lib/settings-view.js', added: 5, deleted: 1 }] } },
    { turn: 2, seq: 3, prompt: '好', start: T0 + MIN, end: T0 + MIN + 5000, files: [], commands: [], ok: true, response: '这个改动要不要一起提交？' },
  ], { sessionId: 's-f', strategy: 'mainline' })
  ok(segs.length === 1, '应聚成 1 段，实际 ' + segs.length)
  const aw = detectAwaitingHuman([
    { turn: 1, seq: 1, prompt: '改一下设置项', files: ['lib/settings-view.js'], commands: [], ok: true },
    { turn: 2, seq: 3, prompt: '好', files: [], commands: [], ok: true, response: '这个改动要不要一起提交？' },
  ], {})
  ok(aw.active === true, '应识别出待确认')
  const withAwaiting = segs.map(s => ({ ...s, workspaceId: 'ws-1', awaiting: { active: true, summary: aw.summary, turn: aw.turn } }))
  const plan = planColdStartWorks(withAwaiting, { now: T0 + 60 * MIN, workspaceId: 'ws-1' })
  const carded = plan.works.filter(w => w.awaiting && w.awaiting.active === true)
  ok(carded.length >= 1, '聚成的事应带 awaiting')
})

console.log('mainline: ' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length > 0) { for (const f of failures) console.log('  ✗ ' + f); process.exit(1) }