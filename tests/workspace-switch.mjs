/**
 * 工作区切区状态机与空态测试（ADR-0008）。
 * 运行：node tests/workspace-switch.mjs
 */
import { resolveWorksViewState, emptyStateText } from '../lib/work-view.js'

let passed = 0
const failures = []
function check(name, fn) {
  try { fn(); passed += 1 } catch (e) { failures.push(name + ' → ' + e.message) }
}
function eq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m||'') + ' 实际 ' + JSON.stringify(a) + ' 期望 ' + JSON.stringify(b)) }
function ok(v, m) { if (v !== true) throw new Error((m||'') + ' 期望 true，实际 ' + JSON.stringify(v)) }

const RAW_EMPTY = { initialized: true, cards: { unresolved: [] }, refineStatus: { used: true, reason: 'ok' } }
const RAW_ONE = { initialized: true, cards: { unresolved: [{ id: 'w-1' }] } }

// ── 切区即清态 ────────────────────────────────────────────────────
check('切区瞬间：数据属于旧工作区时必须清态，不得展示旧卡片', () => {
  const r = resolveWorksViewState({
    boundWorkspaceId: 'ws-new', dataWorkspaceId: 'ws-old', raw: RAW_ONE, error: '', scanning: false, refining: false,
  })
  eq(r.status, 'loading', 'status')
  eq(r.showStale, false, 'showStale 必须为 false')
  eq(r.unresolvedCount, 0, '不得把旧工作区的计数带过来')
})

check('同一工作区内刷新：正常展示，不误判为切区', () => {
  const r = resolveWorksViewState({
    boundWorkspaceId: 'ws-a', dataWorkspaceId: 'ws-a', raw: RAW_ONE, error: '', scanning: false, refining: false,
  })
  eq(r.status, 'ready', 'status')
  eq(r.unresolvedCount, 1, 'count')
})

check('工作区未知（空串）时不误清态，避免闪屏', () => {
  const r = resolveWorksViewState({
    boundWorkspaceId: '', dataWorkspaceId: 'ws-a', raw: RAW_ONE, error: '', scanning: false, refining: false,
  })
  eq(r.status, 'ready', 'status')
})

// ── 四态可区分 ────────────────────────────────────────────────────
check('未扫描：raw 为 null 且没在扫描 → unscanned', () => {
  const r = resolveWorksViewState({ boundWorkspaceId: 'ws-a', dataWorkspaceId: '', raw: null, error: '', scanning: false, refining: false })
  eq(r.status, 'loading', 'status')
  eq(r.emptyKind, 'unscanned', 'emptyKind')
})

check('正在扫描：scanning / refining → scanning（不能显示成「确实无事」）', () => {
  eq(resolveWorksViewState({ boundWorkspaceId: 'ws-a', dataWorkspaceId: 'ws-a', raw: RAW_EMPTY, error: '', scanning: true, refining: false }).emptyKind, 'scanning', 'scanning')
  eq(resolveWorksViewState({ boundWorkspaceId: 'ws-a', dataWorkspaceId: 'ws-a', raw: RAW_EMPTY, error: '', scanning: false, refining: true }).emptyKind, 'scanning', 'refining')
})

check('扫描失败：有 error → failed，而不是「无事」', () => {
  const r = resolveWorksViewState({ boundWorkspaceId: 'ws-a', dataWorkspaceId: 'ws-a', raw: null, error: '读取失败', scanning: false, refining: false })
  eq(r.status, 'error', 'status')
  eq(r.emptyKind, 'failed', 'emptyKind')
})

check('确实无事：已初始化且有结果但 0 条未收束 → empty', () => {
  const r = resolveWorksViewState({ boundWorkspaceId: 'ws-a', dataWorkspaceId: 'ws-a', raw: RAW_EMPTY, error: '', scanning: false, refining: false })
  eq(r.status, 'ready', 'status')
  eq(r.emptyKind, 'empty', 'emptyKind')
})

check('有四态文案且互不相同（不允许都写「暂无未收束的事」）', () => {
  const kinds = ['unscanned', 'scanning', 'failed', 'empty']
  const titles = kinds.map(k => emptyStateText(k, {}).title)
  const hints = kinds.map(k => emptyStateText(k, {}).hint)
  eq(new Set(titles).size, 4, '标题必须四种各不相同')
  eq(new Set(hints).size, 4, '提示语必须四种各不相同')
  for (const s of titles.concat(hints)) ok(s.indexOf('待补充') === -1, '空态文案不得是占位空话: ' + s)
})

check('失败态提供重试入口，其余不提供', () => {
  eq(emptyStateText('failed', {}).retry, true, 'failed.retry')
  eq(emptyStateText('empty', {}).retry, false, 'empty.retry')
  eq(emptyStateText('unscanned', {}).retry, false, 'unscanned.retry')
  eq(emptyStateText('scanning', {}).retry, false, 'scanning.retry')
})

check('空态文案带工作区名，让用户确认自己看的是哪个区', () => {
  ok(emptyStateText('unscanned', { workspaceName: 'dsh_plugin' }).title.indexOf('dsh_plugin') >= 0, '应含工作区名')
})

check('键壮性：异常输入不抛异常', () => {
  ok(resolveWorksViewState(null).status === 'loading', 'null 输入')
  ok(resolveWorksViewState(undefined).status === 'loading', 'undefined 输入')
  ok(resolveWorksViewState({}).status === 'loading', '空对象')
  ok(typeof emptyStateText('nope', {}).title === 'string', '未知 emptyKind 有兜底文案')
  ok(typeof emptyStateText(null, null).title === 'string', 'null 参数有兜底文案')
})

console.log('workspace-switch: ' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length > 0) { for (const f of failures) console.log('  ✗ ' + f); process.exit(1) }