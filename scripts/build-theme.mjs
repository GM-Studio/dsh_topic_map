/**
 * 把 lib/theme.js 与 lib/filter.js 嵌入 client bundle。
 *
 * 理由与 build-viewport.mjs 相同：浏览器单文件 bundle 不能 import，而这些
 * 逻辑已经独立测试过（tests/theme.mjs 25 项、tests/filter.mjs 29 项），
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
const FILTER_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/filter.js'
const FILTER_END = '    // ══ 筛选生成段结束 ══'
const PM_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/pm-model.js'
const PM_END = '    // ══ PM 生成段结束 ══'
const UI_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/ui-state.js'
const UI_END = '    // ══ UI 状态生成段结束 ══'
const FOLD_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/tree-fold.js'
const FOLD_END = '    // ══ 树折叠生成段结束 ══'
const DELIV_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/deliverables.js'
const DELIV_END = '    // ══ 交付物生成段结束 ══'
const SCAT_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/session-category.js'
const SCAT_END = '    // ══ 会话归类生成段结束 ══'
const GMODE_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/graph-mode.js'
const GMODE_END = '    // ══ 图着色模式生成段结束 ══'
const REPORT_START = '    // ══ 以下由 scripts/build-theme.mjs 从 lib/report.js'
const REPORT_END = '    // ══ 报告生成段结束 ══'

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

const filterSrc = strip(readFileSync(join(root, 'lib', 'filter.js'), 'utf8'))
const filterWrapped = [
  FILTER_START,
  '    // 筛选逻辑全部是纯函数，独立测试过（tests/filter.mjs）。',
  '    var FILTER = (function () {',
  indent(filterSrc),
  '      return {',
  '        emptyFilter: emptyFilter, isFilterEmpty: isFilterEmpty,',
  '        laneHaystack: laneHaystack, matchLane: matchLane, stateBucketOf: stateBucketOf,',
  '        STATE_BUCKETS: STATE_BUCKETS, applyFilter: applyFilter,',
  '        collectStages: collectStages, highlightParts: highlightParts,',
  '      }',
  '    })()',
  FILTER_END,
].join('\n')

const pmSrc = strip(readFileSync(join(root, 'lib', 'pm-model.js'), 'utf8'))
const pmWrapped = [
  PM_START,
  '    // 任务状态与依赖的推导，全部是纯函数，独立测试过（tests/pm.mjs）。',
  '    var PM = (function () {',
  indent(pmSrc),
  '      return {',
  '        TASK_STATES: TASK_STATES, STATE_META: STATE_META, MUTATING_TOOLS: MUTATING_TOOLS,',
  '        inferTaskState: inferTaskState, inferFromEvidence: inferFromEvidence,',
  '        inferDependencies: inferDependencies, computeSupersession: computeSupersession,',
  '        computeComeBack: computeComeBack, collectEvidence: collectEvidence,',
  '        summarizeStates: summarizeStates, applyOverride: applyOverride,',
  '        stageProgress: stageProgress,',
  '      }',
  '    })()',
  PM_END,
].join('\n')

const uiSrc = strip(readFileSync(join(root, 'lib', 'ui-state.js'), 'utf8'))
const uiWrapped = [
  UI_START,
  '    // 界面状态的归一化与合并，纯函数，独立测试过（tests/ui-state.mjs）。',
  '    var UISTATE = (function () {',
  indent(uiSrc),
  '      return {',
  '        normalizeUiState: normalizeUiState, mergeUiState: mergeUiState, safeSessionId: safeSessionId,',
  '      }',
  '    })()',
  UI_END,
].join('\n')

const foldSrc = strip(readFileSync(join(root, 'lib', 'tree-fold.js'), 'utf8'))
const foldWrapped = [
  FOLD_START,
  '    // 折叠与路径推导，纯函数，独立测试过（tests/tree-fold.mjs）。',
  '    var FOLD = (function () {',
  indent(foldSrc),
  '      return {',
  '        stageKey: stageKey, workflowKey: workflowKey, pathOfTurn: pathOfTurn,',
  '        foldToPath: foldToPath, expandAll: expandAll, collapseAll: collapseAll,',
  '        collapseToStages: collapseToStages, defaultFold: defaultFold,',
  '        foldForFilter: foldForFilter, isStageOpen: isStageOpen,',
  '        isWorkflowOpen: isWorkflowOpen, foldMode: foldMode,',
  '      }',
  '    })()',
  FOLD_END,
].join('\n')

const delivSrc = strip(readFileSync(join(root, 'lib', 'deliverables.js'), 'utf8'))
const delivWrapped = [
  DELIV_START,
  '    // 交付物抽取，纯函数，独立测试过（tests/report.mjs）。',
  '    var DELIV = (function () {',
  indent(delivSrc),
  '      return {',
  '        PRODUCING_TOOLS: PRODUCING_TOOLS, isDeliverablePath: isDeliverablePath,',
  '        baseName: baseName, shortPath: shortPath,',
  '        collectDeliverables: collectDeliverables, groupByStage: groupByStage,',
  '      }',
  '    })()',
  DELIV_END,
].join('\n')

const reportSrc = strip(readFileSync(join(root, 'lib', 'report.js'), 'utf8'))
const reportWrapped = [
  REPORT_START,
  '    // 工作量与风险报告，纯函数，独立测试过（tests/report.mjs）。',
  '    var REPORT = (function () {',
  indent(reportSrc),
  '      return {',
  '        laneWorkload: laneWorkload, workloadReport: workloadReport,',
  '        riskReport: riskReport, toCsv: toCsv, toMarkdown: toMarkdown,',
  '      }',
  '    })()',
  REPORT_END,
].join('\n')


const gmSrc = strip(readFileSync(join(root, 'lib', 'graph-mode.js'), 'utf8'))
const gmWrapped = [
  GMODE_START,
  '    // 图着色模式，纯函数，独立测试过（tests/graph-mode.mjs）。',
  '    var GMODE = (function () {',
  indent(gmSrc),
  '      return {',
  '        GRAPH_MODES: GRAPH_MODES, GRAPH_MODE_KEY: GRAPH_MODE_KEY, STATUS_HUE: STATUS_HUE,',
  '        statusColor: statusColor, laneColor: laneColor, stateIndexMap: stateIndexMap,',
  '        nextGraphMode: nextGraphMode, loadGraphMode: loadGraphMode,',
  '        saveGraphMode: saveGraphMode, graphModeLabel: graphModeLabel,',
  '      }',
  '    })()',
  GMODE_END,
].join('\n')

const scatSrc = strip(readFileSync(join(root, 'lib', 'session-category.js'), 'utf8'))
const scatWrapped = [
  SCAT_START,
  '    // 会话归类，纯函数，独立测试过（tests/session-category.mjs）。',
  '    var SCAT = (function () {',
  indent(scatSrc),
  '      return {',
  '        CATEGORY_RANGE: CATEGORY_RANGE, looksAutomated: looksAutomated,',
  '        filterTree: filterTree,',
  '      }',
  '    })()',
  SCAT_END,
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

console.log('theme:', splice(THEME_START, THEME_END, themeWrapped, '    // ══ 生成段结束 ══'))
console.log('filter:', splice(FILTER_START, FILTER_END, filterWrapped, THEME_END))
console.log('pm:', splice(PM_START, PM_END, pmWrapped, FILTER_END))
console.log('ui-state:', splice(UI_START, UI_END, uiWrapped, PM_END))
console.log('tree-fold:', splice(FOLD_START, FOLD_END, foldWrapped, UI_END))
console.log('deliverables:', splice(DELIV_START, DELIV_END, delivWrapped, FOLD_END))
console.log('report:', splice(REPORT_START, REPORT_END, reportWrapped, DELIV_END))
console.log('graph-mode:', splice(GMODE_START, GMODE_END, gmWrapped, REPORT_END))
console.log('session-category:', splice(SCAT_START, SCAT_END, scatWrapped, GMODE_END))

writeFileSync(clientPath, client)
console.log('已写入 lib/client.js')
