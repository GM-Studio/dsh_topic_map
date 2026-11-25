/**
 * 历史详情的「变更」区与回滚预演浮窗。
 *
 * 覆盖：changes-view 分组与 ±行、lost 文案、回滚四态分组与数量摘要、
 * 「仅预演，不会修改文件」、/rollback-plan 请求参数与 Host 中文错误。
 */

import { strict as assert } from 'node:assert'
import * as CHANGESVIEW from '../lib/changes-view.js'
import * as ROLLBACKPLAN from '../lib/rollback-plan.js'
import {
  readClient,
  extractFunction,
  extractAssignment,
  makeFetch,
  makeRunner,
  h,
  byClass,
  findAll,
  textOf,
  click,
} from './client-harness.mjs'

const src = readClient()
const { test, finish } = makeRunner('client-changes')

function stringConstant(name) {
  const found = src.match(new RegExp(`var ${name} = '([^']*)'`))
  if (found === null) throw new Error(`client.js 里找不到常量 ${name}`)
  return found[1]
}
function literalConstant(name) {
  return new Function(`return ${extractAssignment(src, name)}`)()
}

const ROLLBACK_NOTE = stringConstant('ROLLBACK_NOTE')
const ROLLBACK_STATE_ORDER = literalConstant('ROLLBACK_STATE_ORDER')
const ROLLBACK_STATE_TEXT = literalConstant('ROLLBACK_STATE_TEXT')

const SOURCE = [
  extractFunction(src, 'categoryErrorText'),
  extractFunction(src, 'changeChurnText'),
  extractFunction(src, 'changeSectionNode'),
  extractFunction(src, 'rollbackPlanRequest'),
  extractFunction(src, 'requestTopicMap'),
  extractFunction(src, 'loadRollbackPlan'),
  extractFunction(src, 'rollbackPreviewModel'),
  extractFunction(src, 'rollbackCountsText'),
  extractFunction(src, 'rollbackPreviewNodes'),
].join('\n')

function api(fetchImpl) {
  return new Function(
    'h',
    'CHANGESVIEW',
    'ROLLBACKPLAN',
    'ROLLBACK_NOTE',
    'ROLLBACK_STATE_ORDER',
    'ROLLBACK_STATE_TEXT',
    'fetch',
    'errorText',
    `${SOURCE};return {
      changeChurnText: changeChurnText,
      changeSectionNode: changeSectionNode,
      rollbackPlanRequest: rollbackPlanRequest,
      loadRollbackPlan: loadRollbackPlan,
      rollbackPreviewModel: rollbackPreviewModel,
      rollbackCountsText: rollbackCountsText,
      rollbackPreviewNodes: rollbackPreviewNodes,
    }`,
  )(
    h,
    CHANGESVIEW,
    ROLLBACKPLAN,
    ROLLBACK_NOTE,
    ROLLBACK_STATE_ORDER,
    ROLLBACK_STATE_TEXT,
    fetchImpl,
    error => String(error && error.message ? error.message : error),
  )
}

const TURN = {
  changes: {
    files: [
      { path: 'lib/client.js', added: 30, deleted: 4 },
      { path: 'tests/client-changes.mjs', added: 12, deleted: 0 },
      { path: 'README.md', added: 3, deleted: 1 },
      { path: 'package.json', added: 1, deleted: 1 },
      { path: 'icon.svg', added: 0, deleted: 2 },
    ],
  },
}

await test('变更区：按 kind 分组（代码/文档/配置/其他），逐行 +a −d', () => {
  const built = api(() => ({ value: {} }))
  const onPreview = []
  const section = built.changeSectionNode(h, TURN, () => onPreview.push('preview'))
  assert.ok(section !== null)
  assert.deepEqual(
    byClass(section, 'dsh_tm_histdchangegroup').map(group => group.props['data-kind']),
    ['code', 'doc', 'config', 'other'],
  )
  assert.deepEqual(
    byClass(section, 'dsh_tm_histdchangehead').map(textOf),
    ['代码 · 2', '文档 · 1', '配置 · 1', '其他 · 1'],
  )
  const rows = byClass(section, 'dsh_tm_histdchangerow')
  assert.equal(rows.length, 5)
  assert.equal(textOf(byClass(section, 'dsh_tm_histdchangepath')[0]), 'lib/client.js')
  assert.deepEqual(
    byClass(section, 'dsh_tm_histdchangechurn').map(textOf).slice(0, 3),
    ['+30 −4', '+12 −0', '+3 −1'],
  )
  assert.equal(textOf(byClass(section, 'dsh_tm_histdchsum')[0]),
    '该轮改了 5 个文件，+46 -8 行')

  const preview = byClass(section, 'dsh_tm_histrollbackbtn')[0]
  assert.ok(preview !== undefined, '有变更时必须有「回滚预演」按钮')
  assert.equal(textOf(preview), '回滚预演')
  click(preview)
  assert.deepEqual(onPreview, ['preview'])
})

await test('lost:true → 固定文案「该轮变更明细已不可读」，不提供预演按钮', () => {
  const built = api(() => ({ value: {} }))
  const section = built.changeSectionNode(h, { changes: { lost: true } }, () => {})
  assert.equal(textOf(byClass(section, 'dsh_tm_histdlost')[0]), '该轮变更明细已不可读')
  assert.equal(byClass(section, 'dsh_tm_histdchangegroup').length, 0)
  assert.equal(byClass(section, 'dsh_tm_histrollbackbtn').length, 0)
})

await test('没有 turn.changes 返回 null；空变更显示「该轮没有文件变更」', () => {
  const built = api(() => ({ value: {} }))
  assert.equal(built.changeSectionNode(h, { prompt: 'x' }, () => {}), null)
  const empty = built.changeSectionNode(h, { changes: [] }, () => {})
  assert.equal(textOf(byClass(empty, 'dsh_tm_histdchsum')[0]), '该轮没有文件变更')
  assert.equal(byClass(empty, 'dsh_tm_histrollbackbtn').length, 0)
})

await test('回滚预演：四态分组（可回滚/已一致/已被修改/已不存在）+ 数量摘要', () => {
  const built = api(() => ({ value: {} }))
  const value = {
    summary: '1 个可回滚，1 个无需回滚，1 个已被修改，1 个已不存在',
    plan: [
      { path: 'a.js', state: 'apply', added: 2, deleted: 1 },
      { path: 'b.js', state: 'same', added: 0, deleted: 0 },
      { path: 'c.js', state: 'modified', added: 5, deleted: 3 },
      { path: 'd.js', state: 'missing', added: 1, deleted: 0 },
    ],
  }
  const model = built.rollbackPreviewModel(value)
  assert.deepEqual(model.groups.map(group => group.state), ROLLBACK_STATE_ORDER)
  assert.deepEqual(model.groups.map(group => group.label),
    ['可回滚', '已一致', '已被修改', '已不存在'])
  assert.deepEqual(model.counts, { apply: 1, same: 1, modified: 1, missing: 1 })
  assert.equal(built.rollbackCountsText(model.counts),
    '可回滚 1 · 已一致 1 · 已被修改 1 · 已不存在 1')

  const tree = built.rollbackPreviewNodes(h, { status: 'ready', value: value }, {})
  assert.ok(tree !== null)
  const groups = byClass(tree, 'dsh_tm_rbgroup')
  assert.equal(groups.length, 4)
  assert.deepEqual(groups.map(group => group.props['data-state']),
    ['apply', 'same', 'modified', 'missing'])
  assert.deepEqual(byClass(tree, 'dsh_tm_rbstate').map(textOf),
    ['可回滚', '已一致', '已被修改', '已不存在'])
  assert.deepEqual(byClass(tree, 'dsh_tm_rbcount').map(textOf), ['1', '1', '1', '1'])
  assert.equal(byClass(tree, 'dsh_tm_rbfile').length, 4)
  assert.equal(textOf(byClass(tree, 'dsh_tm_rbsummary')[0]), value.summary)
  assert.ok(textOf(byClass(tree, 'dsh_tm_rbcounts')[0]).includes('可回滚 1'))
  assert.equal(textOf(byClass(tree, 'dsh_tm_rbnote')[0]), '仅预演，不会修改文件')
  assert.equal(ROLLBACK_NOTE, '仅预演，不会修改文件')
})

await test('预演浮窗只读：只有复制清单 / 关闭，没有执行回滚按钮', () => {
  const built = api(() => ({ value: {} }))
  const value = { summary: '1 个可回滚', plan: [{ path: 'a.js', state: 'apply', added: 1, deleted: 0 }] }
  const tree = built.rollbackPreviewNodes(h, { status: 'ready', value: value }, { copy: function () {} })
  const actionNames = findAll(tree, node => typeof node.props['data-action'] === 'string')
    .map(node => node.props['data-action'])
  assert.deepEqual(actionNames.sort(), ['rollback-close', 'rollback-copy'])
  assert.equal(textOf(byClass(tree, 'dsh_tm_rbdialog')[0]).includes('执行回滚'), false)
})

await test('复制清单 / 关闭：回调与 ROLLBACKPLAN.formatPlan 文本', () => {
  const built = api(() => ({ value: {} }))
  const copied = []
  const closed = []
  const value = {
    summary: '1 个可回滚',
    plan: [{ path: 'a.js', state: 'apply', added: 3, deleted: 1 }],
  }
  const tree = built.rollbackPreviewNodes(h, { status: 'ready', value: value }, {
    copy: text => copied.push(text),
    close: () => closed.push('close'),
  })
  click(byClass(tree, 'dsh_tm_histact').find(node => node.props['data-action'] === 'rollback-copy'))
  assert.equal(copied.length, 1)
  assert.ok(copied[0].includes('✓ 可回滚  a.js  +3 -1'), copied[0])
  click(byClass(tree, 'dsh_tm_histact').find(node => node.props['data-action'] === 'rollback-close'))
  assert.deepEqual(closed, ['close'])
})

await test('预演失败：显示 Host 中文错误，底部仍有「仅预演」说明', () => {
  const built = api(() => ({ value: {} }))
  const tree = built.rollbackPreviewNodes(h, { status: 'error', value: null, error: '索引读取失败（corrupt）' }, {})
  assert.equal(textOf(byClass(tree, 'dsh_tm_rberr')[0]), '回滚预演失败：索引读取失败（corrupt）')
  assert.equal(textOf(byClass(tree, 'dsh_tm_rbnote')[0]), '仅预演，不会修改文件')
  assert.equal(byClass(tree, 'dsh_tm_rbgroup').length, 0)
})

await test('/rollback-plan 参数：{sessionId, turn}；不完整不发请求', async () => {
  const fake = makeFetch(({ action, body }) => {
    assert.equal(action, 'rollback-plan')
    assert.deepEqual(body, { sessionId: 's1', turn: 7 })
    return { value: { plan: [], summary: '没有可回滚的文件' } }
  })
  const built = api(fake.fetch)
  assert.deepEqual(built.rollbackPlanRequest('s1', 7), { sessionId: 's1', turn: 7 })
  assert.equal(built.rollbackPlanRequest('', 7), null)
  assert.equal(built.rollbackPlanRequest('s1', -1), null)
  assert.equal(built.rollbackPlanRequest('s1', 1.5), null)
  const result = await built.loadRollbackPlan('s1', 7)
  assert.equal(result.ok, true)
  assert.equal(fake.calls.length, 1)
  const missing = await built.loadRollbackPlan('', 7)
  assert.equal(missing.ok, false)
  assert.equal(missing.error, '缺少会话或轮次信息')
  assert.equal(fake.calls.length, 1, '参数不完整不应发请求')
})

await test('loadRollbackPlan 失败：保留 Host 中文 error', async () => {
  const fake = makeFetch(() => ({ status: 404, ok: false, error: '找不到第 7 轮' }))
  const built = api(fake.fetch)
  const result = await built.loadRollbackPlan('s1', 7)
  assert.equal(result.ok, false)
  assert.equal(result.error, '找不到第 7 轮')
  assert.equal(result.status, 404)
})

await test('详情已接线：renderHistoryDetail 用 changeSectionNode，HistoryTabBody 渲染预演浮窗', () => {
  assert.ok(
    src.includes('var changeNode = changeSectionNode(h, turn'),
    '详情展开后必须调用变更区构建器（而不是旧的 files 列表）',
  )
  assert.ok(
    src.includes('previewHistoryRollback(entry)'),
    '「回滚预演」按钮必须接到本条的会话 / 轮次',
  )
  assert.ok(
    src.includes('rollbackPreviewNodes(h, rollback'),
    'HistoryTabBody 必须把预演状态渲染成浮窗',
  )
  assert.ok(
    src.includes("requestTopicMap('rollback-plan'"),
    '预演必须走 /rollback-plan，不能本地假装计划',
  )
})

finish()
