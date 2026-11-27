/**
 * 把活跃抽屉与历史轨依赖的纯模块嵌入 client bundle。
 *
 * 浏览器单文件 bundle 不能 import，而这些逻辑已经独立测试过，
 * 嵌入原文才能保证"浏览器里跑的就是测过的那份"。
 *
 * Run: node scripts/build-theme.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 去掉模块声明，保留实现原文。 */
function strip(src) {
  return src
    .replace(/^\/\*\*[\s\S]*?\*\/\s*/m, '')
    .replace(/^export const /gm, 'var ')
    .replace(/^export function /gm, 'function ')
    .replace(/^import .*$/gm, '')
}

function indent(body) {
  return body.split('\n').map(line => (line === '' ? '' : '  ' + line)).join('\n')
}

const THEME_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/theme.js'
const THEME_END = '    // ══ 主题生成段结束 ══'
const HITVIEW_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/hit-view.js'
const HITVIEW_END = '    // ══ hit-view 生成段结束 ══'
const CITE_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/cite.js'
const CITE_END = '    // ══ cite 生成段结束 ══'
const RAILVIEW_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/rail-view.js'
const RAILVIEW_END = '    // ══ rail-view 生成段结束 ══'
const STATSFMT_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/stats-format.js'
const STATSFMT_END = '    // ══ stats-format 生成段结束 ══'
const SETTINGVIEW_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/settings-view.js'
const SETTINGVIEW_END = '    // ══ settings-view 生成段结束 ══'
const CLUEVIEW_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/clue-view.js'
const CLUEVIEW_END = '    // ══ clue-view 生成段结束 ══'
const CHANGESVIEW_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/changes-view.js'
const CHANGESVIEW_END = '    // ══ changes-view 生成段结束 ══'
const ROLLBACKPLAN_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/rollback-plan.js'
const ROLLBACKPLAN_END = '    // ══ rollback-plan 生成段结束 ══'
const WORKVIEW_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/work-view.js'
const WORKVIEW_END = '    // ══ work-view 生成段结束 ══'

const themeSrc = strip(readFileSync(join(root, 'lib', 'theme.js'), 'utf8'))
const themeWrapped = [
  THEME_START,
  '    // 浏览器单文件 bundle 无法 import，因此把测试过的实现原样嵌入。',
  '    // 修改请改 lib/theme.js 后重新生成，不要直接编辑这一段。',
  '    var THEME = (function () {',
  indent(themeSrc),
  '      return {',
  '        THEMES: THEMES, THEME_STORAGE_KEY: THEME_STORAGE_KEY, TRACK_PALETTE: TRACK_PALETTE,',
  '        themeCss: themeCss, detectHostTheme: detectHostTheme, resolveTheme: resolveTheme,',
  '        loadThemeChoice: loadThemeChoice, saveThemeChoice: saveThemeChoice,',
  '        nextThemeChoice: nextThemeChoice, themeLabel: themeLabel,',
  '        trackColorAt: trackColorAt, stageTintAt: stageTintAt,',
  '      }',
  '    })()',
  THEME_END,
].join('\n')

const hitSrc = strip(readFileSync(join(root, 'lib', 'hit-view.js'), 'utf8'))
const hitWrapped = [
  HITVIEW_START,
  '    // 列表视图模型（右栏两行 / 主面板三行 / 分数来源），纯函数，',
  '    // 独立测试过（tests/hit-view.mjs）。导出清单手写：客户端用了哪个',
  '    // 名字就必须在这里导出一个，否则运行时 TypeError + 白屏。',
  '    var HITVIEW = (function () {',
  indent(hitSrc),
  '      return {',
  '        formatRelativeTime: formatRelativeTime, toRow: toRow, toTwoLine: toTwoLine,',
  '        toThreeLine: toThreeLine, scoreParts: scoreParts, groupHeader: groupHeader,',
  '        copySummary: copySummary,',
  '      }',
  '    })()',
  HITVIEW_END,
].join('\n')

const citeSrc = strip(readFileSync(join(root, 'lib', 'cite.js'), 'utf8'))
const citeWrapped = [
  CITE_START,
  '    // 引用块构造/反解（A-4），纯函数，独立测试过（tests/cite.mjs）。',
  '    // 导出清单手写：客户端用了哪个名字就必须在这里导出一个，否则白屏。',
  '    var CITE = (function () {',
  indent(citeSrc),
  '      return {',
  '        buildCite: buildCite, estimateTokens: estimateTokens, parseCite: parseCite,',
  '        citeBudgetOf: citeBudgetOf, stripBody: stripBody,',
  '      }',
  '    })()',
  CITE_END,
].join('\n')

const railviewSrc = strip(readFileSync(join(root, 'lib', 'rail-view.js'), 'utf8'))
const railviewWrapped = [
  RAILVIEW_START,
  '    // 历史轨视图模型（V-12），纯函数，独立测试过（tests/rail-view.mjs）。',
  '    // V-12 起改由本脚本嵌入：手工同步段已删除，改源码后重新生成即可。',
  '    var RAILVIEW = (function () {',
  indent(railviewSrc),
  '      return {',
  '        TIER_WIDTHS: TIER_WIDTHS, tierOf: tierOf, snapWidth: snapWidth,',
  '        turnOfLabel: turnOfLabel, rowsOf: rowsOf, activeIndexOf: activeIndexOf,',
  '        anchorFor: anchorFor, selfCheck: selfCheck, segmentGroupsOf: segmentGroupsOf,',
  '      }',
  '    })()',
  RAILVIEW_END,
].join('\n')

const statsfmtSrc = strip(readFileSync(join(root, 'lib', 'stats-format.js'), 'utf8'))
const statsWrapped = [
  STATSFMT_START,
  '    // 统计页格式化（页头四卡 / 会话行 / 用量拆分），纯函数，',
  '    // 独立测试过（tests/stats-format.mjs）。',
  '    var STATSFMT = (function () {',
  indent(statsfmtSrc),
  '      return {',
  '        formatRelative: formatRelative, statsHeadline: statsHeadline,',
  '        statsRows: statsRows, usageSplit: usageSplit,',
  '      }',
  '    })()',
  STATSFMT_END,
].join('\n')

const settingSrc = strip(readFileSync(join(root, 'lib', 'settings-view.js'), 'utf8'))
const settingWrapped = [
  SETTINGVIEW_START,
  '    // 设置表单模型（分组 / 单字段校验 / 只提交差异），纯函数，',
  '    // 独立测试过（tests/settings-view.mjs）。',
  '    var SETTINGVIEW = (function () {',
  indent(settingSrc),
  '      return {',
  '        settingsModel: settingsModel, applySetting: applySetting,',
  '        diffConfig: diffConfig,',
  '      }',
  '    })()',
  SETTINGVIEW_END,
].join('\n')

const clueviewSrc = strip(readFileSync(join(root, 'lib', 'clue-view.js'), 'utf8'))
const clueviewWrapped = [
  CLUEVIEW_START,
  '    // 线索时间线视图模型（V-4），纯函数，独立测试过（tests/clue-view.mjs）。',
  '    var CLUEVIEW = (function () {',
  indent(clueviewSrc),
  '      return {',
  '        buildClue: buildClue,',
  '      }',
  '    })()',
  CLUEVIEW_END,
].join('\n')

const changesviewSrc = strip(readFileSync(join(root, 'lib', 'changes-view.js'), 'utf8'))
const changesviewWrapped = [
  CHANGESVIEW_START,
  '    // 变更清单视图模型（P3-1 / A-7），纯函数，独立测试过（tests/changes-view.mjs）。',
  '    var CHANGESVIEW = (function () {',
  indent(changesviewSrc),
  '      return {',
  '        buildChanges: buildChanges, groupByKind: groupByKind,',
  '        sortChanges: sortChanges,',
  '      }',
  '    })()',
  CHANGESVIEW_END,
].join('\n')

const rollbackplanSrc = strip(readFileSync(join(root, 'lib', 'rollback-plan.js'), 'utf8'))
const rollbackplanWrapped = [
  ROLLBACKPLAN_START,
  '    // 回滚预演四态（P3-2 / A-12），纯函数，独立测试过（tests/rollback-plan.mjs）。',
  '    var ROLLBACKPLAN = (function () {',
  indent(rollbackplanSrc),
  '      return {',
  '        planRollback: planRollback, formatPlan: formatPlan,',
  '      }',
  '    })()',
  ROLLBACKPLAN_END,
].join('\n')

const workviewSrc = strip(readFileSync(join(root, 'lib', 'work-view.js'), 'utf8'))
const workviewWrapped = [
  WORKVIEW_START,
  '    // 「续接」首页视图模型（ADR-0001~0004），纯函数，独立测试过（tests/work-view.mjs）。',
  '    var WORKVIEW = (function () {',
  indent(workviewSrc),
  '      return {',
  '        formatWorkCard: formatWorkCard, workBoardModel: workBoardModel,',
  '        formatInflectionBanner: formatInflectionBanner, formatReopenBanner: formatReopenBanner,',
  '        formatRelativeTime: formatRelativeTime,',
  '      }',
  '    })()',
  WORKVIEW_END,
].join('\n')

const clientPath = join(root, 'lib', 'client.js')
let client = readFileSync(clientPath, 'utf8')

/**
 * 替换或插入一个生成段。
 * @param startMarker - 段开始标记。
 * @param endMarker - 段结束标记。
 * @param content - 新内容。
 * @param anchor - 首次插入时的锚点（插在其后）。
 * @returns '替换' | '插入'
 */
function splice(startMarker, endMarker, content, anchor) {
  const s = client.indexOf(startMarker)
  if (s >= 0) {
    const e = client.indexOf(endMarker, s)
    if (e < 0) throw new Error(endMarker + ' 缺失')
    client = client.slice(0, s) + content + client.slice(e + endMarker.length)
    return '替换'
  }
  const at = client.indexOf(anchor)
  if (at < 0) throw new Error('找不到锚点：' + anchor)
  const insertAt = at + anchor.length
  client = client.slice(0, insertAt) + '\n\n' + content + client.slice(insertAt)
  return '插入'
}

console.log('theme:', splice(THEME_START, THEME_END, themeWrapped, '      document.head.appendChild(tag)\n    }'))
console.log('hit-view:', splice(HITVIEW_START, HITVIEW_END, hitWrapped, THEME_END))
console.log('cite:', splice(CITE_START, CITE_END, citeWrapped, HITVIEW_END))
console.log('rail-view:', splice(RAILVIEW_START, RAILVIEW_END, railviewWrapped, CITE_END))
console.log('stats-format:', splice(STATSFMT_START, STATSFMT_END, statsWrapped, RAILVIEW_END))
console.log('settings-view:', splice(SETTINGVIEW_START, SETTINGVIEW_END, settingWrapped, STATSFMT_END))
console.log('clue-view:', splice(CLUEVIEW_START, CLUEVIEW_END, clueviewWrapped, SETTINGVIEW_END))
console.log('changes-view:', splice(CHANGESVIEW_START, CHANGESVIEW_END, changesviewWrapped, CLUEVIEW_END))
console.log('rollback-plan:', splice(ROLLBACKPLAN_START, ROLLBACKPLAN_END, rollbackplanWrapped, CHANGESVIEW_END))
console.log('work-view:', splice(WORKVIEW_START, WORKVIEW_END, workviewWrapped, ROLLBACKPLAN_END))

writeFileSync(clientPath, client)
console.log('已写入 lib/client.js')
