/**
 * 交付物：从会话日志里抽出"到底产出了什么"。
 *
 * 这是 PM 视角里最实的一块——前面几块都在描述过程（怎么聊的、卡在哪），
 * 这块回答"东西做出来了吗"。
 *
 * 数据现实（已实测确认）：
 *   - `files` 数组记的是**工具参数里出现的路径**，读和写混在一起。
 *     某会话 260 个去重路径里 203 个是读到的第三方包文件，还有 "v0.2"、
 *     "end.time" 这种明显是正则误抓的碎片。
 *   - 因此只用 `files` 会得到一堆噪声。**真正可靠的信号是工具名**：
 *     只有 `write` / `edit` / `present` 这类才意味着"产出了东西"。
 *
 * 策略：以工具名为准，再从同一轮的 files 里挑出形似真实文件的路径。
 * 宁可少列几条，也不要把 200 个 node_modules 路径倒给用户。
 *
 * @module dsh-topic-map/deliverables
 */

/** 会产出交付物的工具。 */
export const PRODUCING_TOOLS = ['write', 'edit', 'present', 'plugin_manager']

/** 形似真实文件的扩展名。 */
const FILE_EXT = /\.(md|markdown|js|mjs|cjs|ts|tsx|jsx|json|yml|yaml|html|css|scss|py|rb|go|rs|java|kt|sh|ps1|sql|txt|csv|toml|ini|conf|xml|svg|png|jpg|pdf|docx|xlsx|pptx)$/i

/**
 * 临时产物与构建产物的路径片段。
 *
 * 必须同时覆盖三个平台，否则换个机器就漏：
 *   Windows  C:\Users\x\AppData\Local\Temp、D:\proj\node_modules
 *   macOS    /var/folders/.../T/、/private/var/folders
 *   Linux    /tmp、/var/tmp、~/.cache、~/.npm
 *
 * 之前只写了 `Temp`，在 Linux 上 `/tmp/xxx` 会漏过去——这是把插件
 * 从一台机器搬到另一台会立刻暴露的问题。
 */
const NOISE = /(^|[\\/])(Temp|temp|tmp|spill|node_modules|\.git|dist|build|coverage|\.cache|\.npm|\.pnpm-store|target|\.next|\.nuxt|out|vendor|__pycache__|\.venv|venv)([\\/]|$)/i

/** macOS 的临时目录：/var/folders/xx/xxxx/T/，不属于上面任何一种形态。 */
const MAC_TEMP = /\/(private\/)?var\/folders\//i

/** 明显不是文件的碎片（正则误抓）。 */
const FRAGMENT = /^(https?:\/\/|v\d|end\.|\d+$)/i

/**
 * 项目配置文件：几乎每个包都有同名的一份，列出来只是噪音。
 *
 * 实测某会话抽出 36 条交付物里 9 条是 package.json——它们是"读到"的
 * 第三方包配置，不是这次工作的产出。
 */
const BOILERPLATE = /(^|[\\/])(package\.json|package-lock\.json|pnpm-lock\.yaml|tsconfig\.json|\.gitignore|README\.md)$/i

/**
 * 判断一个路径是否值得当作交付物。
 *
 * 四重过滤：扩展名像文件、不含临时目录、不是碎片、不是通用配置文件。
 *
 * @param path - 候选路径。
 * @returns 是否保留。
 */
export function isDeliverablePath(path) {
  if (typeof path !== 'string') return false
  const p = path.trim()
  if (p.length < 5 || p.length > 400) return false
  if (FRAGMENT.test(p)) return false
  if (NOISE.test(p)) return false
  if (MAC_TEMP.test(p)) return false
  if (BOILERPLATE.test(p)) return false
  return FILE_EXT.test(p)
}

/**
 * 取路径的"可辨识尾部"：目录名/文件名两段。
 *
 * 只显示文件名会出现多个 client.js 无法区分；显示全路径又太长。
 * 两段是实测下来最好用的折中（如 `dsh-topic-map/client.js`）。
 *
 * @param path - 完整路径。
 * @param depth - 取几段。
 * @returns 短路径。
 */
export function shortPath(path, depth = 2) {
  const parts = String(path ?? '').split(/[\\/]+/).filter(s => s !== '')
  if (parts.length === 0) return String(path ?? '')
  return parts.slice(Math.max(0, parts.length - depth)).join('/')
}

/**
 * 从路径里取文件名（用于显示）。
 *
 * @param path - 完整路径。
 * @returns 文件名。
 */
export function baseName(path) {
  const s = String(path ?? '').replace(/[\\/]+$/, '')
  const at = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return at < 0 ? s : s.slice(at + 1)
}

/**
 * 从一条泳道（或一组轮次）里抽交付物。
 *
 * @param turns - 轮次号列表。
 * @param factOf - `(turn) => fact`。
 * @param options - `{ limit }`，每个任务最多保留几条。
 * @returns `[{ path, name, turns: [] }]`，按首次出现排序。
 */
export function collectDeliverables(turns, factOf, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 8
  // 用**短路径**做去重键：同一个文件在不同工具调用里可能写成不同的绝对路径
  // （盘符大小写、正反斜杠混用），按原始路径去重会留下多条重复项。
  const byKey = new Map()
  const order = []

  for (const t of Array.isArray(turns) ? turns : []) {
    const fact = factOf(t)
    if (fact === undefined || fact === null) continue
    const tools = Array.isArray(fact.tools) ? fact.tools : []
    const produces = tools.some(name => PRODUCING_TOOLS.includes(name))
    if (!produces) continue

    for (const raw of (Array.isArray(fact.files) ? fact.files : [])) {
      if (!isDeliverablePath(raw)) continue
      const path = raw.trim()
      const name = baseName(path)
      // 去重键用**文件名**：同一个文件在不同调用里可能写成 `client.js`、
      // `lib/client.js`、`E:\...\lib\client.js`，短路径也会因段数不同而不一致。
      // 文件名是最稳的归一化键，代价是不同目录的同名文件会被合并——但在这个
      // 场景下（一个插件的源码）同名文件基本就是同一个。
      if (!byKey.has(name)) {
        byKey.set(name, { path, name, label: shortPath(path, 2), turns: [] })
        order.push(name)
      } else {
        // 保留更具体的路径作为来源说明
        const entry = byKey.get(name)
        if (path.length > entry.path.length) {
          entry.path = path
          entry.label = shortPath(path, 2)
        }
      }
      const entry = byKey.get(name)
      if (!entry.turns.includes(t)) entry.turns.push(t)
    }
  }

  // 只保留"被写过多次"或"出现在靠后位置"的条目。
  //
  // 为什么需要这一步：日志的 `tool/call` 只记参数，不记这次调用是读还是写。
  // 于是调研轮次里"读了一堆 PDF + 顺手写了个文件"会让 PDF 也被当成产出。
  // 实测某会话前三阶段抽出的 aclanthology/*.pdf 就是这种误判。
  //
  // 启发式：真正的产出通常会被**反复修改**（turn 数多），或出现在轮次末尾
  // （先读材料后动手写）。只出现一次且位置靠前的，多半是读到的。
  const kept = order
    .map(k => byKey.get(k))
    .filter((d) => {
      if (d.turns.length >= 2) return true      // 改过多次，确定是产出
      if (order.length <= 6) return true        // 本来就少，不必筛
      // 位置靠后的保留（后 60%）
      const at = order.indexOf(d.name)
      return at >= Math.floor(order.length * 0.4)
    })

  return kept.slice(0, limit)
}

/**
 * 把交付物按阶段归组。
 *
 * @param stages - 阶段树。
 * @param lanes - 泳道（含 stageName）。
 * @param factOf - `(turn) => fact`。
 * @returns `[{ stage, items }]`，按阶段顺序。
 */
export function groupByStage(stages, lanes, factOf) {
  const out = []
  const seen = new Set()

  for (const stage of Array.isArray(stages) ? stages : []) {
    const laneIds = (Array.isArray(lanes) ? lanes : [])
      .filter(l => l.stageName === stage.name)
      .map(l => l.laneId)
    const turns = []
    for (const lane of Array.isArray(lanes) ? lanes : []) {
      if (lane.stageName !== stage.name) continue
      for (const t of (Array.isArray(lane.turns) ? lane.turns : [])) turns.push(t)
    }
    const items = collectDeliverables(turns, factOf, { limit: 12 })
      .filter(d => {
        // 同一个文件可能出现在多个阶段（比如反复改），只在最早出现处列出
        if (seen.has(d.path)) return false
        seen.add(d.path)
        return true
      })
    if (items.length > 0) out.push({ stage: stage.name, items })
  }

  // 不属于任何阶段的（分层失败时）
  const orphanTurns = []
  for (const lane of Array.isArray(lanes) ? lanes : []) {
    if (lane.stageName === null || lane.stageName === undefined) {
      for (const t of (Array.isArray(lane.turns) ? lane.turns : [])) orphanTurns.push(t)
    }
  }
  if (orphanTurns.length > 0) {
    const items = collectDeliverables(orphanTurns, factOf, { limit: 12 })
      .filter(d => {
        if (seen.has(d.path)) return false
        seen.add(d.path)
        return true
      })
    if (items.length > 0) out.push({ stage: '未分类', items })
  }

  return out
}
