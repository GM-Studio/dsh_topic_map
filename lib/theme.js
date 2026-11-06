/**
 * 主题：把插件自己的变量映射到宿主 token 或固定色值。
 *
 * 为什么要这一层：直接写 `--dsw-alias-label-tertiary` 这类 token 有个隐患——
 * 宿主只保证导出 token 列表里的那些名字。实测发现上一版用了三个**不存在**
 * 的 token（label-tertiary / interactive-bg-hover / button-info-fill），
 * 它们解析为空，于是文字没颜色、悬停无反馈——这就是"配色不好看"的一部分原因。
 *
 * 因此这里分成两层：
 *   1. 宿主 token（有就用，跟随 DSH 明暗）
 *   2. 本插件自定义（Claude 风格的暖调色板，白/黑各一套）
 *
 * 切主题只改 `data-theme`，不重渲染组件。
 *
 * @module dsh-topic-map/theme
 */

/** 主题名。 */
export const THEMES = ['auto', 'light', 'dark']

/**
 * 泳道色板：**专用**的 10 色，不借状态色。
 *
 * 为什么不能用 state-* 那套：状态色是语义色——橙=警告、红=错误。拿它给
 * 泳道编号上色，第 1 条泳道看起来像"有警告"，第 3 条像"出错了"。精细化后
 * 泳道有十几条，这种误读会到处都是。
 *
 * 所以这里是一套中性的分类色：10 色循环，暖调为主，与主题同族。
 * 白/黑各一套，深色版整体提亮、降饱和，避免在黑底上刺眼。
 */
export const TRACK_PALETTE = {
  light: [
    '#c96442', '#5b7fa6', '#6b9e78', '#a8756b', '#8b7bab',
    '#5f9ea0', '#b08d4f', '#7d8b9c', '#a06b8f', '#6f8f5f',
  ],
  dark: [
    '#e08a68', '#7ba3cc', '#8ec49b', '#c99287', '#ab9ccb',
    '#82c2c4', '#d4ac68', '#9dabbb', '#c78fb4', '#93b580',
  ],
}

/**
 * 取第 i 条泳道的颜色。
 *
 * @param i - 泳道序号。
 * @param mode - 'light' | 'dark'。
 * @returns CSS 颜色。
 */
export function trackColorAt(i, mode = 'light') {
  const list = TRACK_PALETTE[mode] ?? TRACK_PALETTE.light
  const idx = ((Number(i) % list.length) + list.length) % list.length
  return list[idx]
}

/**
 * 阶段底色：同阶段的泳道共享一个色相，靠透明度做背景带。
 *
 * 与泳道色分开取值：泳道色区分"哪一条"，阶段色区分"哪一组"。
 * 两者同源会造成"同色的线看着像同一阶段"的误会。
 *
 * @param index - 阶段序号。
 * @param mode - 'light' | 'dark'。
 * @param pct - 透明度百分比。
 */
export function stageTintAt(index, mode = 'light', pct = 10) {
  const list = TRACK_PALETTE[mode] ?? TRACK_PALETTE.light
  const idx = ((Number(index) % list.length) + list.length) % list.length
  return { color: list[idx], alpha: pct }
}

/** 存储键：记住用户的手动选择。 */
export const THEME_STORAGE_KEY = 'dsh-topic-map:theme'

/**
 * 生成主题 CSS。
 *
 * `:root[data-tm-theme="..."]` 而不是 `:root`：插件的样式不能污染宿主，
 * 反过来宿主也不该覆盖插件。
 *
 * @returns CSS 文本。
 */
export function themeCss() {
  return `
/* ── 白（Claude 暖白）────────────────────────────────────────── */
:root[data-tm-theme="light"]{
  --tm-bg:#faf9f5;
  --tm-surface:#ffffff;
  --tm-surface2:#f5f3ee;
  --tm-surface3:#eeece5;
  --tm-border:#e8e4da;
  --tm-border-strong:#d8d3c6;
  --tm-text:#1f1e1b;
  --tm-text2:#5c5a52;
  --tm-text3:#8e8a7e;
  --tm-accent:#c96442;
  --tm-accent-soft:rgba(201,100,66,.12);
  --tm-hover:rgba(31,30,27,.045);
  --tm-active:rgba(31,30,27,.075);
  --tm-shadow:0 1px 2px rgba(31,30,27,.05), 0 3px 10px rgba(31,30,27,.05);
  --tm-ok:#3f8f5f;
  --tm-warn:#b8862f;
  --tm-err:#c05545;
  /* 分类色板用的另外两色。
     客户端代码一直引用 --tm-purple / --tm-info，但这里从未定义，
     于是第 4、5 个大类的色条是透明的 —— 看起来"少了颜色标记"。 */
  --tm-purple:#7a5ea8;
  --tm-info:#3d7fa6;
}
/* ── 黑（Claude 暖黑）────────────────────────────────────────── */
:root[data-tm-theme="dark"]{
  --tm-bg:#1f1e1b;
  --tm-surface:#262521;
  --tm-surface2:#2e2d28;
  --tm-surface3:#383630;
  --tm-border:#3a3833;
  --tm-border-strong:#4d4a42;
  --tm-text:#edebe4;
  --tm-text2:#b5b1a5;
  --tm-text3:#85816f;
  --tm-accent:#d97757;
  --tm-accent-soft:rgba(217,119,87,.16);
  --tm-hover:rgba(237,235,228,.05);
  --tm-active:rgba(237,235,228,.09);
  --tm-shadow:0 1px 2px rgba(0,0,0,.3), 0 4px 14px rgba(0,0,0,.28);
  --tm-ok:#6fae8a;
  --tm-warn:#d6a44e;
  --tm-err:#e08272;
  /* 见浅色主题处的说明 */
  --tm-purple:#a98fd4;
  --tm-info:#6aa9c9;
}
/* 跟随宿主时先继承宿主的明暗判定，再由 JS 把 data-tm-theme 设为 light/dark */
`
}

/**
 * 从宿主页面推断当前明暗。
 *
 * 宿主可能是 `data-theme`、`class="dark"`，或者只有 CSS 变量。逐个看，
 * 都没有就按浅色处理——浅色失败的影响比深色小（深色底上放浅色字更糟）。
 *
 * @returns 'light' | 'dark'
 */
export function detectHostTheme(doc) {
  if (doc === undefined || doc === null) return 'light'
  try {
    const root = doc.documentElement
    const attr = root.getAttribute('data-theme') || root.getAttribute('data-color-scheme')
    if (attr === 'dark' || attr === 'light') return attr
    if (root.classList && root.classList.contains('dark')) return 'dark'
    if (doc.body && doc.body.classList && doc.body.classList.contains('dark')) return 'dark'
    // 背景亮度兜底。优先用 document.defaultView，浏览器里它才是可靠的
    // getComputedStyle（全局那个在 iframe / 多文档场景可能拿不到本页样式）。
    const view = doc.defaultView || (typeof window === 'undefined' ? null : window)
    if (view === null || typeof view.getComputedStyle !== 'function') return 'light'
    const bg = view.getComputedStyle(root).backgroundColor
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg || '')
    if (m !== null) {
      const lum = (Number(m[1]) * 299 + Number(m[2]) * 587 + Number(m[3]) * 114) / 1000
      return lum < 128 ? 'dark' : 'light'
    }
  } catch {
    // 读不到就按浅色
  }
  return 'light'
}

/**
 * 解析最终要用的主题。
 *
 * @param choice - 用户选择（auto / light / dark）。
 * @param doc - 用于探测宿主的 document。
 * @returns 'light' | 'dark'
 */
export function resolveTheme(choice, doc) {
  if (choice === 'light' || choice === 'dark') return choice
  return detectHostTheme(doc)
}

/** 读取用户上次的选择。 */
export function loadThemeChoice(storage) {
  try {
    const raw = storage === undefined || storage === null ? null : storage.getItem(THEME_STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw
  } catch {
    // 忽略
  }
  return 'auto'
}

/** 保存用户选择。 */
export function saveThemeChoice(storage, choice) {
  try {
    if (storage !== undefined && storage !== null) storage.setItem(THEME_STORAGE_KEY, choice)
  } catch {
    // 配额满就放弃
  }
}

/**
 * 主题选择的下一个值：auto → light → dark → auto。
 * @param current - 当前选择。
 */
export function nextThemeChoice(current) {
  const order = ['auto', 'light', 'dark']
  const i = order.indexOf(current)
  return order[(i + 1) % order.length]
}

/** 按钮上显示的图标与提示。 */
export function themeLabel(choice, resolved) {
  if (choice === 'auto') {
    return { icon: resolved === 'dark' ? '◐' : '◑', title: '主题：跟随系统（点击切换为浅色）' }
  }
  if (choice === 'light') return { icon: '☀', title: '主题：浅色（点击切换为深色）' }
  return { icon: '☾', title: '主题：深色（点击切换为跟随系统）' }
}
