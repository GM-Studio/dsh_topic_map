#!/usr/bin/env node
/**
 * 只读「事续接」质量体检（脱敏）。
 *
 * 直接读取本机 <DSH home>/topic-map/works/*.json，逐工作区统计：
 *   - 会话数 / 事数 / 未收束数 / 每会话平均事数（碎卡率）
 *   - 下一步留白数（空串或含「待补充」）
 *   - 现状摘要留白数
 *   - 决策数（跨会话是否真提炼出决策）
 *   - 跨会话事的数量
 *   - 待确认（awaiting）信号数
 *   - 准入被拒数与原因分布
 *   - refineStatus（是否用过模型 / 失败原因）
 *
 * 只输出聚合数字，绝不打印会话正文、文件路径、密钥或用户输入。
 *
 * 用法：
 *   node scripts/dry-run-resume-quality.mjs
 *   node scripts/dry-run-resume-quality.mjs --json
 *   node scripts/dry-run-resume-quality.mjs --dir <topic-map/works 目录>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function parseArgs(argv) {
  const out = { json: false, dir: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--dir') { out.dir = String(argv[i + 1] ?? ''); i += 1 }
  }
  return out
}

function defaultWorksDir() {
  const home = process.env.DSH_HOME || process.env.DSH_HOME_DIR || ''
  const bases = []
  if (home) bases.push(home)
  if (process.env.USERPROFILE) bases.push(path.join(process.env.USERPROFILE, '.dsh'))
  if (os.homedir()) bases.push(path.join(os.homedir(), '.dsh'))
  for (const b of bases) {
    const p = path.join(b, 'topic-map', 'works')
    try { if (fs.statSync(p).isDirectory()) return p } catch { /* try next */ }
  }
  return ''
}

const BLANK_RE = /^(?:$|待补充|待补充下一步行动|待定|无|暂无)$/

function isBlank(v) {
  if (typeof v !== 'string') return true
  return BLANK_RE.test(v.trim())
}

function auditStore(store) {
  const works = Array.isArray(store?.works) ? store.works : []
  const unresolved = works.filter(w => w && (w.state === 'active' || w.state === 'blocked') && w.dismissedAsChat !== true)
  const sessions = new Set()
  for (const w of works) for (const s of (Array.isArray(w?.sessionIds) ? w.sessionIds : [])) sessions.add(String(s))

  let blankNext = 0
  let blankStatus = 0
  let decisions = 0
  let crossSession = 0
  let awaiting = 0
  let excluded = 0
  const reasons = {}

  for (const w of works) {
    if (!w) continue
    if (isBlank(w.nextStep)) blankNext += 1
    if (isBlank(w.statusSummary)) blankStatus += 1
    decisions += Array.isArray(w.decisions) ? w.decisions.length : 0
    if (Array.isArray(w.sessionIds) && w.sessionIds.length > 1) crossSession += 1
    if (w.awaiting && w.awaiting.active === true) awaiting += 1
    if (w.admission && w.admission.admitted === false) {
      excluded += 1
      for (const r of (Array.isArray(w.admission.reasons) ? w.admission.reasons : [])) {
        reasons[r] = (reasons[r] ?? 0) + 1
      }
    }
  }

  const rs = store?.refineStatus
  return {
    sessions: sessions.size,
    works: works.length,
    unresolved: unresolved.length,
    worksPerSession: sessions.size === 0 ? 0 : Number((works.length / sessions.size).toFixed(2)),
    blankNext,
    blankStatus,
    decisions,
    crossSession,
    awaiting,
    excluded,
    admissionReasons: reasons,
    refineUsed: rs ? rs.used === true : null,
    refineReason: rs ? String(rs.reason ?? '') : '',
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dir = args.dir || defaultWorksDir()
  if (dir === '') {
    console.error('找不到 topic-map/works 目录，请用 --dir 指定。')
    process.exit(2)
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
  const rows = []
  const totals = { sessions: 0, works: 0, unresolved: 0, blankNext: 0, blankStatus: 0, decisions: 0, crossSession: 0, awaiting: 0, excluded: 0, refineUsed: 0, refineFailed: 0 }

  for (const f of files) {
    let store = null
    try { store = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { continue }
    const r = auditStore(store)
    // 工作区 id 只保留前 8 位做区分，不含任何正文
    rows.push({ ws: String(store?.workspaceId ?? f.replace(/\.json$/, '')).slice(0, 8), ...r })
    totals.sessions += r.sessions
    totals.works += r.works
    totals.unresolved += r.unresolved
    totals.blankNext += r.blankNext
    totals.blankStatus += r.blankStatus
    totals.decisions += r.decisions
    totals.crossSession += r.crossSession
    totals.awaiting += r.awaiting
    totals.excluded += r.excluded
    if (r.refineUsed === true) totals.refineUsed += 1
    if (r.refineUsed === false) totals.refineFailed += 1
  }

  if (args.json) {
    console.log(JSON.stringify({ dir, rows, totals }, null, 2))
    return
  }

  console.log('事续接质量体检（只读 · 脱敏）')
  console.log('目录：' + dir)
  console.log('')
  console.log('工作区   会话  事数  未收束  事/会话  下一步留白  现状留白  决策  跨会话  待确认  未准入  提炼')
  for (const r of rows) {
    const refine = r.refineUsed === true ? 'model' : (r.refineUsed === false ? 'rule(' + (r.refineReason || '?') + ')' : 'n/a')
    console.log(
      [String(r.ws).padEnd(8), String(r.sessions).padStart(4), String(r.works).padStart(5), String(r.unresolved).padStart(6),
       String(r.worksPerSession).padStart(7), String(r.blankNext).padStart(10), String(r.blankStatus).padStart(8),
       String(r.decisions).padStart(4), String(r.crossSession).padStart(6), String(r.awaiting).padStart(6),
       String(r.excluded).padStart(6), refine].join('  '),
    )
  }
  console.log('')
  console.log('合计：会话 ' + totals.sessions + ' / 事 ' + totals.works + ' / 未收束 ' + totals.unresolved
    + ' / 下一步留白 ' + totals.blankNext + ' / 现状留白 ' + totals.blankStatus
    + ' / 决策 ' + totals.decisions + ' / 跨会话 ' + totals.crossSession
    + ' / 待确认 ' + totals.awaiting + ' / 未准入 ' + totals.excluded)
  console.log('提炼：成功 ' + totals.refineUsed + ' 个工作区，失败 ' + totals.refineFailed + ' 个工作区')
}

main()