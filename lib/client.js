/**
 * dsh-topic-map — 话题地图面板
 *
 * 一次会话画成 git 分支图：turn 是圆点，话题是一条轨道，分叉用曲线连。
 *
 * 三栏结构：
 *   左  话题列表（点击高亮对应轨道）
 *   中  图画布（占满剩余空间，可缩放）
 *   右  选中轮次的详情（含跳转到对话）
 *
 * 数据来自 Host 半 /api/topic-map/*；拓扑由 Host 计算（index/column 单位），
 * 本文件负责像素化与绘制。
 */

window.__ModuleLoader__.load({
  id: 'dsh-topic-map',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useMemo = React.useMemo
    var useRef = React.useRef

    // ── 样式 ────────────────────────────────────────────────────────
    var CSS = [
      // 高度必须**严格**锁在宿主给的空间里。
      //
      // 上一版有 `min-height:460px` 兜底，本意是防止父级没高度时塌成细带。
      // 但它带来了更糟的后果：宿主给的高度小于 460 时，面板会把自己撑高，
      // 于是**整个面板连同左右两栏一起出现外层滚动**——缩放平移中间那张图时，
      // 左右栏跟着上下跑。
      //
      // 正确做法：min-height:0 + max-height:100%，把溢出全部下压到各栏内部。
      //
      // `contain: layout size` 是关键补充：没有它，子元素的固有宽度会把
      // 这个 flex 容器的 min-content 撑宽，`overflow:hidden` 挡不住
      // ——那正是"图下方出现横向滚动条、进而引发面板右侧与窗口整体滚动"的成因。
      '.dsh_tm_root{display:flex;flex-direction:column;height:100%;min-height:0;max-height:100%;width:100%;background:var(--tm-bg);color:var(--tm-text);font-size:13px;overflow:hidden;contain:layout size}',

      // 顶栏：允许换行。按钮多、会话标题长时，不换行就必然把面板撑宽。
      // 换行后高度会增加，但那是受控的（bar 是 flex:none，会把高的压力
      // 传给下方 body，而 body 有 min-height:0，不会溢出）。
      '.dsh_tm_bar{flex:none;display:flex;align-items:center;gap:10px;row-gap:6px;padding:9px 14px;border-bottom:1px solid var(--tm-border);background:var(--tm-surface);flex-wrap:wrap;min-width:0}',
      '.dsh_tm_brand{display:flex;align-items:center;gap:7px;font-weight:600;letter-spacing:.2px}',
      '.dsh_tm_dotlogo{width:9px;height:9px;border-radius:50%;background:var(--tm-accent);box-shadow:0 0 0 3px var(--tm-accent-soft)}',
      '.dsh_tm_kpis{display:flex;align-items:center;gap:12px;font-size:11.5px;color:var(--tm-text2);font-variant-numeric:tabular-nums;flex-wrap:wrap;row-gap:3px;min-width:0}',
      '.dsh_tm_kpi{white-space:nowrap}',
      '.dsh_tm_kpi b{color:var(--tm-text);font-weight:600;font-size:12.5px}',
      '.dsh_tm_kpistate{display:inline-flex;align-items:center;gap:5px}',
      '.dsh_tm_kpistate[data-state="done"] b{color:var(--tm-ok)}',
      '.dsh_tm_kpistate[data-state="active"] b{color:var(--tm-accent)}',
      '.dsh_tm_kpistate[data-state="blocked"] b{color:var(--tm-warn)}',
      '.dsh_tm_kpiseP{width:1px;height:12px;background:var(--tm-border);margin:0 2px}',
      '.dsh_tm_grow{flex:auto}',
      '.dsh_tm_tools{display:flex;align-items:center;gap:4px;flex-wrap:wrap;row-gap:4px;min-width:0}',
      '.dsh_tm_ico{width:28px;height:28px;display:grid;place-items:center;border:1px solid var(--tm-border);border-radius:7px;background:transparent;color:var(--tm-text2);cursor:pointer;font:inherit;font-size:13px;line-height:1;transition:background .12s,color .12s,border-color .12s}',
      '.dsh_tm_ico:hover{background:var(--tm-hover);color:var(--tm-text);border-color:var(--tm-border-strong)}',
      '.dsh_tm_ico[data-on="1"]{background:var(--tm-active);color:var(--tm-text)}',

      // 三栏：每栏自己滚，互不影响，也不影响外层。
      '.dsh_tm_body{flex:1 1 auto;display:flex;min-height:0;min-width:0;overflow:hidden}',
      '.dsh_tm_side{flex:none;width:196px;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--tm-border);background:var(--tm-surface);overflow:hidden}',
      '.dsh_tm_sidetitle{flex:none;padding:9px 12px 7px;font-size:10.5px;font-weight:600;letter-spacing:.6px;text-transform:uppercase;color:var(--tm-text3)}',
      // 左栏头部：标题 + 三个折叠粒度按钮
      '.dsh_tm_sidehead{flex:none;display:flex;align-items:center;gap:6px;padding:8px 10px 6px 12px;min-width:0}',
      '.dsh_tm_sidehead > .dsh_tm_sidetitle{padding:0;flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_foldbtns{display:flex;align-items:center;gap:2px;margin-left:auto;flex:none}',
      '.dsh_tm_foldbtn{width:20px;height:20px;display:grid;place-items:center;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--tm-text3);cursor:pointer;font-size:11px;line-height:1;padding:0}',
      '.dsh_tm_foldbtn:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_foldbtn[data-on="1"]{background:var(--tm-active);color:var(--tm-accent);border-color:var(--tm-border)}',

      // ── 上层：工作区会话树 ──
      '.dsh_tm_st{flex:none;display:flex;flex-direction:column;max-height:42%;border-bottom:1px solid var(--tm-border);background:var(--tm-surface);min-width:0}',
      '.dsh_tm_sthead{flex:none;display:flex;align-items:center;gap:7px;padding:6px 10px;border-bottom:1px solid var(--tm-border);flex-wrap:wrap;row-gap:4px;min-width:0}',
      '.dsh_tm_stws{flex:0 1 auto;min-width:90px;max-width:220px;font:inherit;font-size:10.5px;padding:2px 5px;border-radius:5px;border:1px solid var(--tm-border);background:var(--tm-bg);color:var(--tm-text);cursor:pointer}',
      '.dsh_tm_stcount{flex:none;font-size:9.5px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_stbtn{flex:none;font:inherit;font-size:10px;padding:2px 8px;border-radius:5px;border:1px solid var(--tm-border);background:transparent;color:var(--tm-text2);cursor:pointer}',
      '.dsh_tm_stbtn:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_stbtn[data-on="1"]{border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_stbody{flex:1 1 auto;overflow-y:auto;padding:3px 4px 6px;min-height:0}',
      // 跨会话检索框（与左栏"筛当前会话"的框语义不同，视觉上也分开）
      '.dsh_tm_findbox{flex:none;display:flex;align-items:center;gap:6px;padding:4px 10px 6px;border-bottom:1px solid var(--tm-border);min-width:0}',
      '.dsh_tm_findinput{flex:1 1 auto;min-width:0;font:inherit;font-size:10.5px;padding:3px 7px;border-radius:6px;border:1px solid var(--tm-border);background:var(--tm-bg);color:var(--tm-text);outline:none}',
      '.dsh_tm_findinput:focus{border-color:var(--tm-accent)}',
      '.dsh_tm_findhint{flex:none;font-size:9px;color:var(--tm-text3);white-space:nowrap}',
      '.dsh_tm_stempty{color:var(--tm-text3);font-size:10.5px;padding:14px 8px;text-align:center;line-height:16px}',
      '.dsh_tm_stcat{margin-bottom:1px}',
      '.dsh_tm_stcathd{width:100%;display:flex;align-items:center;gap:5px;padding:4px 6px;border:0;border-radius:5px;background:transparent;color:var(--tm-text);font:inherit;font-size:11px;font-weight:650;text-align:left;cursor:pointer}',
      '.dsh_tm_stcathd:hover{background:var(--tm-hover)}',
      '.dsh_tm_stcatname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_stnum{flex:none;font-size:9px;font-weight:400;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_stsubhd{width:100%;display:flex;align-items:center;gap:5px;padding:3px 6px 3px 16px;border:0;border-radius:5px;background:transparent;color:var(--tm-text2);font:inherit;font-size:10.5px;text-align:left;cursor:pointer}',
      '.dsh_tm_stsubhd:hover{background:var(--tm-hover)}',
      '.dsh_tm_stsubname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_stsess{width:100%;display:flex;align-items:center;gap:5px;padding:2px 6px 2px 28px;border:0;border-radius:5px;background:transparent;color:var(--tm-text2);font:inherit;font-size:10.5px;text-align:left;cursor:pointer;min-width:0}',
      '.dsh_tm_stsess:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_stsess[data-on="1"]{background:var(--tm-accent-soft);color:var(--tm-text);font-weight:600;box-shadow:inset 2px 0 0 var(--tm-accent)}',
      '.dsh_tm_stdot{flex:none;width:5px;height:5px;border-radius:50%;background:var(--tm-accent);opacity:.8}',
      '.dsh_tm_stdot[data-auto="1"]{background:transparent;border:1px solid var(--tm-text3);opacity:.7}',
      '.dsh_tm_stsessname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_stturns{flex:none;font-size:9px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',

      // ── 检索结果 ──
      '.dsh_tm_findlist{display:flex;flex-direction:column;gap:3px;padding:6px 10px;max-height:180px;overflow-y:auto;border-bottom:1px solid var(--tm-border);background:var(--tm-surface2)}',
      '.dsh_tm_finditem{display:grid;grid-template-columns:1fr auto;gap:2px 6px;text-align:left;padding:5px 7px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface);color:var(--tm-text2);font:inherit;font-size:10.5px;cursor:pointer;min-width:0}',
      '.dsh_tm_finditem:hover{border-color:var(--tm-accent);background:var(--tm-hover)}',
      '.dsh_tm_findtitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text);font-weight:600}',
      '.dsh_tm_findwhere{font-size:9px;color:var(--tm-accent);font-variant-numeric:tabular-nums}',
      '.dsh_tm_findsnip{grid-column:1 / -1;font-size:9.5px;color:var(--tm-text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_findnone{font-size:10.5px;color:var(--tm-text3);padding:10px 12px;text-align:center}',

      // ── 左栏下部 PM 面板 ──
      '.dsh_tm_pmtab:hover{background:var(--tm-hover);color:var(--tm-text2)}',
      '.dsh_tm_pmtab[data-on="1"]{background:var(--tm-active);color:var(--tm-accent);font-weight:600}',
      '.dsh_tm_pmbadge[data-kind="risk"]{background:color-mix(in srgb, var(--tm-warn) 22%, transparent);color:var(--tm-warn)}',
      '.dsh_tm_pmexport:hover{background:var(--tm-hover);color:var(--tm-text)}',
      // 概览：四个状态数字
      '.dsh_tm_pmstat[data-state="done"] .dsh_tm_pmstatnum{color:var(--tm-ok)}',
      '.dsh_tm_pmstat[data-state="active"] .dsh_tm_pmstatnum{color:var(--tm-accent)}',
      '.dsh_tm_pmstat[data-state="blocked"] .dsh_tm_pmstatnum{color:var(--tm-warn)}',
      // 状态分布条
      '.dsh_tm_pmdist > i{display:block;height:100%}',
      // 阶段进度行
      // 风险行
      '.dsh_tm_pmrisk:hover{background:var(--tm-hover)}',
      '.dsh_tm_pmrisk[data-level="medium"] .dsh_tm_pmriskkind{background:var(--tm-surface3);color:var(--tm-text3)}',
      // 交付物
      '.dsh_tm_pmditem:hover{background:var(--tm-hover);color:var(--tm-text)}',
      // 工作量
      '.dsh_tm_pmworkrow:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_pmworkbar > i{display:block;height:100%;background:var(--tm-accent)}',
      '.dsh_tm_tracks{flex:auto;overflow-y:auto;padding:0 6px 10px}',
      '.dsh_tm_trackitem{width:100%;display:flex;align-items:flex-start;gap:8px;padding:6px 7px;border:0;border-radius:7px;background:transparent;color:var(--tm-text2);font:inherit;font-size:11.5px;line-height:16px;text-align:left;cursor:pointer;transition:background .12s}',
      '.dsh_tm_trackitem:hover{background:var(--tm-hover)}',
      '.dsh_tm_trackitem[data-on="1"]{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_swatch{flex:none;width:3px;height:16px;border-radius:2px;margin-top:1px}',
      '.dsh_tm_tracktext{flex:auto;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}',
      '.dsh_tm_trackn{flex:none;font-size:10.5px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_dot{flex:none;width:6px;height:6px;border-radius:50%;margin-top:5px;opacity:.9}',
      '.dsh_tm_catgroup{display:flex;flex-direction:column;gap:1px;margin:5px 0 3px}',
      '.dsh_tm_cathead{width:100%;display:flex;align-items:center;gap:7px;padding:5px 7px;border:0;border-radius:7px;background:transparent;color:var(--tm-text);font:inherit;font-size:11.5px;font-weight:600;text-align:left;cursor:pointer;transition:background .12s}',
      '.dsh_tm_cathead:hover{background:var(--tm-hover)}',
      '.dsh_tm_cathead[data-on="1"]{background:var(--tm-hover)}',
      '.dsh_tm_catbar{flex:none;width:3px;height:14px;border-radius:2px;opacity:.85}',
      '.dsh_tm_catname{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_catn{flex:none;font-size:10px;font-weight:400;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      // "新增未归类"阶段的归类入口：小、不抢眼，但要能看见
      '.dsh_tm_uncbtn{flex:none;font:inherit;font-size:9px;padding:1px 6px;border-radius:5px;border:1px solid var(--tm-accent);background:transparent;color:var(--tm-accent);cursor:pointer;white-space:nowrap}',
      '.dsh_tm_uncbtn:hover{background:var(--tm-accent-soft)}',
      '.dsh_tm_trackitem[data-nested="1"]{padding-left:15px}',
      '.dsh_tm_tree{display:flex;flex-direction:column;gap:0}',
      '.dsh_tm_caret{flex:none;width:10px;font-size:9px;color:var(--tm-text3);text-align:center}',
      '.dsh_tm_cathead[data-depth="1"]{padding-left:18px;font-weight:500;font-size:11px}',
      // 任务行的缩进由外层 .dsh_tm_taskrow 的内联 paddingLeft 控制，
      // 内层 button 不再加左内距——否则两者叠加会让三级缩进过头。
      '.dsh_tm_trackitem[data-depth="1"]{padding-left:6px}',
      '.dsh_tm_trackitem[data-depth="2"]{padding-left:6px}',

      // ── 任务行：主体（点击聚焦）+ 状态胶囊（点击切换）──
      '.dsh_tm_taskrow{display:flex;align-items:center;gap:4px;border-radius:7px;padding-right:4px}',
      '.dsh_tm_taskrow[data-on="1"]{background:var(--tm-active)}',
      // 选中轮所在任务：与图上选中节点同一强调色，让人一眼对上
      '.dsh_tm_taskrow[data-selected="1"]{background:var(--tm-accent-soft);box-shadow:inset 2px 0 0 var(--tm-accent)}',
      '.dsh_tm_taskrow[data-selected="1"] .dsh_tm_tracktext{color:var(--tm-text);font-weight:600}',
      '.dsh_tm_taskrow:hover{background:var(--tm-hover)}',
      '.dsh_tm_taskmain{flex:1 1 auto;min-width:0}',
      '.dsh_tm_taskmain:hover{background:transparent}',
      '.dsh_tm_state{flex:none;display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:9.5px;line-height:1;padding:3px 6px;border-radius:99px;border:1px solid transparent;background:transparent;color:var(--tm-text3);cursor:pointer;white-space:nowrap;transition:background .12s,color .12s,border-color .12s}',
      '.dsh_tm_state:hover{background:var(--tm-surface3);color:var(--tm-text2)}',
      '.dsh_tm_state[data-state="done"]{color:var(--tm-ok)}',
      '.dsh_tm_state[data-state="active"]{color:var(--tm-accent)}',
      '.dsh_tm_state[data-state="blocked"]{color:var(--tm-warn)}',
      '.dsh_tm_state[data-overridden="1"]{border-color:currentColor;opacity:.85}',
      // 模型复核过的带一个小点，本地推导的不带——一眼能分辨结论的来源
      '.dsh_tm_state[data-source="model"]::after{content:"·";margin-left:1px;opacity:.7;font-weight:700}',
      '.dsh_tm_statedot{width:5px;height:5px;border-radius:50%;flex:none}',
      '.dsh_tm_pbar{flex:none;width:44px;height:4px;border-radius:2px;background:var(--tm-surface3);overflow:hidden}',
      '.dsh_tm_pbar > i{display:block;height:100%;border-radius:2px;transition:width .18s ease}',

      // ── 详情里的 PM 区块 ──
      '.dsh_tm_pm{background:var(--tm-surface2);border:1px solid var(--tm-border);border-radius:8px;padding:8px 10px;margin-bottom:11px}',
      '.dsh_tm_pmrow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.dsh_tm_pmstate{font-size:11.5px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_pmnote{font-size:10px;color:var(--tm-text3);flex:1 1 100%;line-height:14px}',
      '.dsh_tm_pmdep{margin-top:7px;padding-top:6px;border-top:1px dashed var(--tm-border)}',
      '.dsh_tm_pmlabel{display:block;font-size:9.5px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--tm-text3);margin-bottom:3px}',
      '.dsh_tm_pmdepitem{font-size:10.5px;line-height:15px;color:var(--tm-warn)}',
      // ── 状态复核提示条 ──
      '.dsh_tm_revbar{flex:none;display:flex;align-items:center;gap:10px;padding:6px 14px;border-bottom:1px solid var(--tm-border);background:var(--tm-surface2);font-size:10.5px;color:var(--tm-text2);flex-wrap:wrap;row-gap:4px;min-width:0}',
      '.dsh_tm_revtitle{font-weight:650;color:var(--tm-text)}',

      // ── 分析进度条 ──
      '.dsh_tm_prog{flex:none;padding:8px 14px 9px;border-bottom:1px solid var(--tm-border);background:var(--tm-surface2);min-width:0}',
      '.dsh_tm_progrow{display:flex;align-items:center;gap:9px;font-size:11px;color:var(--tm-text2);flex-wrap:wrap;row-gap:3px}',
      '.dsh_tm_progtitle{font-weight:650;color:var(--tm-text)}',
      '.dsh_tm_progtime{font-variant-numeric:tabular-nums;color:var(--tm-text3)}',
      '.dsh_tm_steps{display:flex;align-items:center;gap:6px;margin-top:7px;flex-wrap:wrap;row-gap:5px}',
      '.dsh_tm_step{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;padding:2px 8px;border-radius:99px;border:1px solid var(--tm-border);color:var(--tm-text3);background:transparent}',
      '.dsh_tm_stepmark{font-size:9px;line-height:1;min-width:9px;text-align:center}',
      '.dsh_tm_step[data-state="active"]{border-color:var(--tm-accent);color:var(--tm-accent);background:var(--tm-accent-soft)}',
      '.dsh_tm_step[data-state="done"]{border-color:var(--tm-ok);color:var(--tm-ok)}',
      '.dsh_tm_step[data-state="failed"]{border-color:var(--tm-err);color:var(--tm-err)}',
      // 进行中的那一步有个呼吸效果，让人知道还活着
      '.dsh_tm_step[data-state="active"] .dsh_tm_stepmark{animation:dsh_tm_pulse 1.1s ease-in-out infinite}',
      '@keyframes dsh_tm_pulse{0%,100%{opacity:1}50%{opacity:.35}}',

      // 画布：flex:1 1 0 + min-height:0，保证它只占据"剩下多少"，不会因为
      // 内部 SVG 或内容变大而反过来撑高外层。overflow:hidden 让缩放平移永远
      // 发生在这一块里面。
      '.dsh_tm_canvas{flex:1 1 0;min-width:0;min-height:0;position:relative;overflow:hidden;background:var(--tm-bg)}',
      '.dsh_tm_canvas[data-grabbing="1"]{cursor:grabbing}',
      '.dsh_tm_overview{flex:none;height:26px;margin:0 12px 8px;position:relative;border-radius:13px;background:var(--tm-surface2);border:1px solid var(--tm-border);cursor:pointer;overflow:hidden;min-width:0}',
      '.dsh_tm_overview_window{position:absolute;top:0;bottom:0;border-radius:14px;background:color-mix(in srgb, var(--tm-accent) 18%, transparent);border:1px solid color-mix(in srgb, var(--tm-accent) 60%, transparent);pointer-events:none;box-shadow:0 0 0 1px color-mix(in srgb, var(--tm-bg) 70%, transparent)}',
      '.dsh_tm_ovline{position:absolute;left:0;right:0;height:1px;opacity:.22}',
      '.dsh_tm_ovdot{position:absolute;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;border-radius:50%;opacity:.75}',
      // 预览条：限高且可滚。用固定像素而不是百分比——百分比按父容器算，
      // 父容器一变小就会把画布挤掉，反而更容易出滚动条。
      '.dsh_tm_sembar{flex:none;display:flex;flex-direction:column;gap:8px;padding:8px 14px 10px;border-top:1px solid var(--tm-border-strong);background:var(--tm-surface2);font-size:11.5px;color:var(--tm-text2);max-height:180px;overflow-y:auto;min-width:0}',
      '.dsh_tm_semrow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.dsh_tm_sembands{display:flex;flex-direction:column;gap:2px}',
      '.dsh_tm_semband{display:flex;align-items:center;gap:8px;font-size:11px;line-height:16px}',
      '.dsh_tm_semswatch{flex:none;width:3px;height:13px;border-radius:2px}',
      '.dsh_tm_semname{flex:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text)}',
      '.dsh_tm_semturns{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_semresumed{flex:none;font-size:10px;padding:0 4px;border-radius:4px;background:color-mix(in srgb, var(--tm-warn) 20%, transparent);color:var(--tm-warn)}',
      '.dsh_tm_pvstage{margin-bottom:6px}',
      '.dsh_tm_pvstagerow{display:flex;align-items:center;gap:7px;font-size:11.5px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_pvstagename{flex:none}',
      '.dsh_tm_pvturns{font-size:10px;font-weight:400;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_pvwf{margin-left:14px;padding-left:8px;border-left:1px solid var(--tm-border)}',
      '.dsh_tm_pvwfname{font-size:11px;color:var(--tm-text2);padding:2px 0}',
      '.dsh_tm_pvtask{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--tm-text2);padding:1.5px 0}',
      '.dsh_tm_pvtaskname{flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_semtitle{font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_semnote{font-variant-numeric:tabular-nums}',
      '.dsh_tm_semnote b[data-changed]{color:var(--tm-accent)}',
      '.dsh_tm_semwarn{color:var(--tm-warn)}',
      '.dsh_tm_semapply{border:0;border-radius:6px;padding:3px 12px;background:var(--tm-accent);color:#fff;font:inherit;font-size:11.5px;font-weight:600;cursor:pointer}',
      '.dsh_tm_semapply:hover{filter:brightness(1.08)}',
      '.dsh_tm_pop{position:absolute;right:14px;top:48px;z-index:40;width:296px;padding:14px;border-radius:12px;background:var(--tm-surface);border:1px solid var(--tm-border-strong);box-shadow:0 12px 36px rgba(0,0,0,.22)}',
      '.dsh_tm_poptitle{font-size:12.5px;font-weight:600;margin-bottom:12px}',
      '.dsh_tm_field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;font-size:11px;color:var(--tm-text2)}',
      '.dsh_tm_input{font:inherit;font-size:12px;padding:5px 8px;border-radius:6px;border:1px solid var(--tm-border-strong);background:var(--tm-bg);color:var(--tm-text);width:100%;box-sizing:border-box}',
      '.dsh_tm_input:focus{outline:1px solid var(--tm-accent);border-color:var(--tm-accent)}',
      '.dsh_tm_popnote{font-size:10.5px;line-height:15px;color:var(--tm-text3);margin-bottom:11px}',
      // 设置面板分区：会话模型与自定义端点两块，避免混在一起看不清优先级
      '.dsh_tm_popsec{font-size:10px;font-weight:650;letter-spacing:.5px;text-transform:uppercase;color:var(--tm-text3);margin:4px 0 8px;padding-top:9px;border-top:1px solid var(--tm-border)}',
      '.dsh_tm_popsec:first-of-type{padding-top:0;border-top:0}',
      '.dsh_tm_chan{flex:none;font-size:9.5px;padding:1px 7px;border-radius:99px;background:var(--tm-accent-soft);color:var(--tm-accent);font-weight:600}',
      '.dsh_tm_chan[data-fallback="1"]{background:color-mix(in srgb, var(--tm-warn) 16%, transparent);color:var(--tm-warn)}',

      // ── 筛选条 ──
      '.dsh_tm_filter{flex:none;border-bottom:1px solid var(--tm-border);background:var(--tm-surface)}',
      '.dsh_tm_filterrow{display:flex;align-items:center;gap:7px;padding:7px 12px;flex-wrap:wrap;row-gap:5px;min-width:0}',
      '.dsh_tm_ficon{flex:none;font-size:12px;color:var(--tm-text3);width:14px;text-align:center}',
      '.dsh_tm_finput{flex:1 1 auto;min-width:0;font:inherit;font-size:11.5px;padding:4px 8px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-bg);color:var(--tm-text);outline:none}',
      '.dsh_tm_finput:focus{border-color:var(--tm-accent)}',
      '.dsh_tm_finput::placeholder{color:var(--tm-text3)}',
      '.dsh_tm_fx{flex:none;width:18px;height:18px;display:grid;place-items:center;border:0;border-radius:4px;background:transparent;color:var(--tm-text3);cursor:pointer;font-size:13px;line-height:1}',
      '.dsh_tm_fx:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_fmore{flex:none;width:24px;height:24px;display:grid;place-items:center;border:1px solid var(--tm-border);border-radius:6px;background:transparent;color:var(--tm-text2);cursor:pointer;font-size:11px}',
      '.dsh_tm_fmore:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_fmore[data-on="1"]{background:var(--tm-active);border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_fmore[data-active="1"]{border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_fcount{flex:none;font-size:10.5px;color:var(--tm-accent);font-variant-numeric:tabular-nums;font-weight:600}',
      '.dsh_tm_fpanel{padding:0 12px 11px;display:flex;flex-direction:column;gap:10px}',
      '.dsh_tm_fgroup{display:flex;flex-direction:column;gap:5px}',
      '.dsh_tm_flabel{font-size:10px;font-weight:600;letter-spacing:.4px;color:var(--tm-text3);text-transform:uppercase}',
      '.dsh_tm_fchips{display:flex;flex-wrap:wrap;gap:5px}',
      '.dsh_tm_chip{font:inherit;font-size:10.5px;padding:2px 9px;border-radius:99px;border:1px solid var(--tm-border);background:transparent;color:var(--tm-text2);cursor:pointer;transition:background .12s,color .12s,border-color .12s}',
      '.dsh_tm_chip:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_chip[data-on="1"]{background:var(--tm-accent-soft);border-color:var(--tm-accent);color:var(--tm-accent);font-weight:600}',
      '.dsh_tm_fnone{font-size:10.5px;color:var(--tm-text3)}',
      '.dsh_tm_frange{display:flex;align-items:center;gap:6px}',
      '.dsh_tm_fnum{width:64px;font:inherit;font-size:11px;padding:3px 7px;border:1px solid var(--tm-border);border-radius:5px;background:var(--tm-bg);color:var(--tm-text);outline:none}',
      '.dsh_tm_fnum:focus{border-color:var(--tm-accent)}',
      '.dsh_tm_fdash{color:var(--tm-text3);font-size:11px}',
      '.dsh_tm_fclear{align-self:flex-start;font:inherit;font-size:10.5px;padding:3px 10px;border-radius:6px;border:1px solid var(--tm-border);background:transparent;color:var(--tm-text2);cursor:pointer}',
      '.dsh_tm_fclear:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_keyrow{display:flex;gap:5px;align-items:center}',
      '.dsh_tm_keyeye{flex:none;width:30px;height:28px;display:grid;place-items:center;border:1px solid var(--tm-border);border-radius:6px;background:transparent;color:var(--tm-text2);cursor:pointer;font-size:11px}',
      '.dsh_tm_keyeye:hover{background:var(--tm-hover)}',
      '.dsh_tm_popwarn{font-size:10px;line-height:14px;color:var(--tm-warn);background:color-mix(in srgb, var(--tm-warn) 10%, transparent);border-radius:6px;padding:6px 8px;margin-bottom:10px}',
      '.dsh_tm_popacts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;row-gap:6px}',
      '.dsh_tm_svg{display:block;width:100%;height:100%}',

      '.dsh_tm_detail{flex:none;width:272px;min-width:0;min-height:0;display:flex;flex-direction:column;border-left:1px solid var(--tm-border);background:var(--tm-surface);overflow:hidden}',
      '.dsh_tm_dscroll{flex:auto;overflow-y:auto;padding:0 13px 14px}',
      '.dsh_tm_dhead{display:flex;align-items:center;gap:8px;padding:11px 0 9px;flex-wrap:wrap}',
      '.dsh_tm_dturn{font-size:15px;font-weight:650;letter-spacing:.2px}',
      '.dsh_tm_pill{font-size:10.5px;padding:1.5px 7px;border-radius:99px;background:var(--tm-hover);color:var(--tm-text2)}',
      '.dsh_tm_pill[data-tone="ok"]{background:color-mix(in srgb, var(--tm-ok) 16%, transparent);color:var(--tm-ok)}',
      '.dsh_tm_pill[data-tone="bad"]{background:color-mix(in srgb, var(--tm-err) 16%, transparent);color:var(--tm-err)}',
      '.dsh_tm_pill[data-tone="warn"]{background:color-mix(in srgb, var(--tm-warn) 18%, transparent);color:var(--tm-warn)}',
      '.dsh_tm_prompt{font-size:12.5px;line-height:19px;color:var(--tm-text);background:var(--tm-bg);border:1px solid var(--tm-border);border-radius:9px;padding:9px 11px;margin-bottom:11px;overflow-wrap:anywhere;max-height:168px;overflow-y:auto}',
      '.dsh_tm_path{font-size:10.5px;color:var(--tm-text3);margin:-4px 0 9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_reply{font-size:11.5px;line-height:17px;color:var(--tm-text2);padding-left:9px;border-left:2px solid var(--tm-border-strong);margin-bottom:12px;overflow-wrap:anywhere;max-height:110px;overflow-y:auto}',
      '.dsh_tm_sect{font-size:10.5px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;color:var(--tm-text3);margin:0 0 7px}',
      '.dsh_tm_grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-bottom:13px}',
      '.dsh_tm_cell{background:var(--tm-bg);border:1px solid var(--tm-border);border-radius:8px;padding:7px 9px}',
      '.dsh_tm_cellk{font-size:10px;color:var(--tm-text3);margin-bottom:2px}',
      '.dsh_tm_cellv{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}',
      '.dsh_tm_kv{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;color:var(--tm-text2);padding:3.5px 0;border-bottom:1px solid color-mix(in srgb, var(--tm-border) 55%, transparent)}',
      '.dsh_tm_kv:last-child{border-bottom:0}',
      '.dsh_tm_kv b{color:var(--tm-text);font-weight:600;font-variant-numeric:tabular-nums}',
      '.dsh_tm_act{flex:none;padding:10px 13px;border-top:1px solid var(--tm-border)}',
      '.dsh_tm_primary{width:100%;padding:8px;border:0;border-radius:8px;background:var(--tm-accent);color:#fff;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:filter .12s}',
      '.dsh_tm_primary:hover{filter:brightness(1.08)}',
      '.dsh_tm_ghost{width:100%;padding:7px;border:1px solid var(--tm-border-strong);border-radius:8px;background:transparent;color:var(--tm-text2);font:inherit;font-size:12px;cursor:pointer;margin-top:6px}',
      '.dsh_tm_ghost:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_hint{font-size:11.5px;line-height:18px;color:var(--tm-text3);padding:4px 0}',

      '.dsh_tm_tip{position:fixed;z-index:60;width:296px;padding:10px 12px;border-radius:11px;background:var(--tm-surface);border:1px solid var(--tm-border-strong);box-shadow:0 10px 34px rgba(0,0,0,.22);pointer-events:none}',
      '.dsh_tm_tiphead{display:flex;gap:7px;align-items:center;font-size:10.5px;color:var(--tm-text2);margin-bottom:6px;flex-wrap:wrap}',
      '.dsh_tm_tipprompt{font-size:12.5px;line-height:17px;margin-bottom:8px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}',
      '.dsh_tm_tiprow{display:flex;justify-content:space-between;font-size:11px;color:var(--tm-text2);padding:1.5px 0;font-variant-numeric:tabular-nums}',
      '.dsh_tm_tiprow b{color:var(--tm-text);font-weight:600}',

      '.dsh_tm_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;height:100%;color:var(--tm-text3);font-size:12.5px;text-align:center;padding:36px;line-height:20px}',
      '.dsh_tm_diag{font-size:11px;opacity:.75;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;max-width:540px;overflow-wrap:anywhere;line-height:16px}',
      '.dsh_tm_diagbox{flex:none;max-height:38%;display:flex;flex-direction:column;border-top:1px solid var(--tm-border-strong);background:var(--tm-surface2)}',
      '.dsh_tm_diaghead{flex:none;display:flex;align-items:center;gap:8px;padding:6px 12px;font-size:11px;font-weight:600;color:var(--tm-text2)}',
      '.dsh_tm_diagclose{margin-left:auto;border:0;background:transparent;color:var(--tm-text3);cursor:pointer;font:inherit;font-size:11px;padding:2px 6px;border-radius:5px}',
      '.dsh_tm_diagclose:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_diagpre{flex:auto;overflow:auto;margin:0;padding:0 12px 10px;font-size:10.5px;line-height:15px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--tm-text2);white-space:pre-wrap;overflow-wrap:anywhere}',

      '@media (max-width:1180px){.dsh_tm_side{width:154px}.dsh_tm_detail{width:232px}}',
      '@media (max-width:980px){.dsh_tm_detail{display:none}}',
      '@media (prefers-reduced-motion:reduce){.dsh_tm_ico,.dsh_tm_trackitem,.dsh_tm_primary{transition:none}}',
    ].join('\n')

    var CSS_TAG = 'dsh-topic-map/styles'
    var THEME_TAG = 'dsh-topic-map/theme'

    /**
     * 注入主题变量层。
     *
     * 单独一个 style 标签而不是并进 CSS：主题可以在运行时切换，变量层的
     * 内容虽然固定，但保持独立能让"主题"这件事只有一个来源（lib/theme.js），
     * 也方便排查"到底是变量没定义还是选择器写错"。
     */
    function injectThemeCss() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + THEME_TAG + '"]') !== null) return
      var tag = document.createElement('style')
      tag.setAttribute('data-plugin', 'dsh-topic-map')
      tag.setAttribute('data-plugin-css', THEME_TAG)
      tag.textContent = THEME.themeCss()
      document.head.appendChild(tag)
    }

    function injectCss() {
      if (typeof document === 'undefined') return
      injectThemeCss()
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') !== null) return
      var tag = document.createElement('style')
      tag.setAttribute('data-plugin', 'dsh-topic-map')
      tag.setAttribute('data-plugin-css', CSS_TAG)
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ══ 以下由 scripts/build-viewport.mjs 从 lib/viewport.js 生成 ══
    // 浏览器单文件 bundle 无法 import，因此把测试过的实现原样嵌入。
    // 修改请改 lib/viewport.js 后重新生成，不要直接编辑这一段。
    var VIEWPORT = (function () {
  /** 缩放上下限。低于下限看不到结构，高于上限只剩下一个圈。 */
  var MIN_SCALE = 0.35
  var MAX_SCALE = 4

  /** 允许内容边缘超出视图的余量（像素）；0 表示严格不出界。 */
  var EDGE_SLACK = 48

  /**
   * 把缩放值夹到合法区间。
   * @param scale - 期望缩放。
   * @returns 合法缩放。
   */
  function clampScale(scale) {
    const v = Number(scale)
    if (!Number.isFinite(v)) return 1
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
  }

  /**
   * 以某个屏幕点为锚缩放，并把结果约束回边界。
   *
   * 手感的关键：锚点下的内容在缩放前后**必须停在同一个屏幕位置**，否则
   * 滚动滚轮时图会往一边跑。做法是反解出锚点对应的内容坐标，再按新缩放
   * 重新计算偏移。
   *
   * 缩放后仍要过一遍边界约束：否则在大图上缩小时，锚定可能把内容整体推出
   * 视野（例如锚点在角落、缩小后内容大幅移动）。约束会让锚定在边缘处略微
   * 让步——这比"图跑没了"要好。
   *
   * @param view - `{ scale, offsetX, offsetY }`。
   * @param anchorX - 锚点屏幕 X（相对视口左上）。
   * @param anchorY - 锚点屏幕 Y。
   * @param nextScale - 目标缩放（会被夹取）。
   * @param content - 内容尺寸；传入时结果会被约束回边界。
   * @param viewport - 视口尺寸。
   * @returns 新的 `{ scale, offsetX, offsetY }`。
   */
  function zoomAt(view, anchorX, anchorY, nextScale, content, viewport) {
    const scale = clampScale(nextScale)
    if (scale === view.scale) return { ...view, scale }
    // 锚点在内容坐标系里的位置
    const cx = (anchorX - view.offsetX) / view.scale
    const cy = (anchorY - view.offsetY) / view.scale
    const zoomed = {
      scale,
      // 让同一个内容点仍然落在 anchor 上
      offsetX: anchorX - cx * scale,
      offsetY: anchorY - cy * scale,
    }
    return content === undefined || viewport === undefined
      ? zoomed
      : constrain(zoomed, content, viewport)
  }

  /**
   * 平移，并约束在边界内。
   *
   * 约束规则：内容比视图小的时候居中，大的时候允许拖动但内容边缘不能离开
   * 视口超过 `EDGE_SLACK`。这样既不会"拖飞"，也不会在大图上卡得动不了。
   *
   * @param view - 当前视图。
   * @param dx - 屏幕位移 X。
   * @param dy - 屏幕位移 Y。
   * @param content - `{ width, height }` 内容尺寸（内容坐标）。
   * @param viewport - `{ width, height }` 视口尺寸。
   * @returns 约束后的视图。
   */
  function panBy(view, dx, dy, content, viewport) {
    const moved = {
      scale: view.scale,
      offsetX: view.offsetX + dx,
      offsetY: view.offsetY + dy,
    }
    return constrain(moved, content, viewport)
  }

  /**
   * 把视图约束回合法范围。
   *
   * @param view - 视图。
   * @param content - 内容尺寸。
   * @param viewport - 视口尺寸。
   * @returns 约束后的视图。
   */
  function constrain(view, content, viewport) {
    return {
      scale: view.scale,
      offsetX: axisLimit(view.offsetX, content.width * view.scale, viewport.width),
      offsetY: axisLimit(view.offsetY, content.height * view.scale, viewport.height),
    }
  }

  /**
   * 单轴约束。
   *
   * - 内容比视口小：居中。
   * - 内容比视口大：偏移必须在 `[视口 - 内容 - slack, slack]` 之间，
   *   即左右都不允许露出超过 slack 的空白。
   *
   * @param offset - 当前偏移。
   * @param scaledSize - 内容在该轴上的像素尺寸。
   * @param viewportSize - 视口在该轴上的尺寸。
   * @returns 约束后的偏移。
   */
  function axisLimit(offset, scaledSize, viewportSize) {
    if (!Number.isFinite(scaledSize) || scaledSize <= viewportSize) {
      // 居中：内容原点放在 (视口 - 内容) / 2
      return (viewportSize - scaledSize) / 2
    }
    const min = viewportSize - scaledSize - EDGE_SLACK
    const max = EDGE_SLACK
    return Math.min(max, Math.max(min, offset))
  }

  /**
   * 全览：缩放到刚好放下全部内容，并居中。
   *
   * 留一点边距，避免最外圈的节点贴着容器边。
   *
   * @param content - 内容尺寸（内容坐标）。
   * @param viewport - 视口尺寸。
   * @param padding - 边距（像素）。
   * @returns 视图。
   */
  function fitToView(content, viewport, padding = 24) {
    const availW = Math.max(1, viewport.width - padding * 2)
    const availH = Math.max(1, viewport.height - padding * 2)
    const sx = availW / Math.max(1, content.width)
    const sy = availH / Math.max(1, content.height)
    const scale = clampScale(Math.min(sx, sy))
    const scaledW = content.width * scale
    const scaledH = content.height * scale
    return {
      scale,
      offsetX: (viewport.width - scaledW) / 2,
      offsetY: (viewport.height - scaledH) / 2,
    }
  }

  /**
   * 内容坐标 → 屏幕坐标。
   * @param view - 视图。
   * @param cx - 内容 X。
   * @param cy - 内容 Y。
   * @returns 屏幕坐标。
   */
  function toScreen(view, cx, cy) {
    return { x: cx * view.scale + view.offsetX, y: cy * view.scale + view.offsetY }
  }

  /**
   * 缩略条：把内容缩成一条，并标出当前视口范围。
   *
   * @param content - 内容尺寸。
   * @param view - 视图。
   * @param viewport - 视口尺寸。
   * @returns `{ start, end }`，均为 0..1 的比例。
   */
  function overviewRange(content, view, viewport) {
    const scaled = content.width * view.scale
    if (!Number.isFinite(scaled) || scaled <= 0) return { start: 0, end: 1 }
    // 视口左边缘对应内容的比例
    const left = (-view.offsetX) / scaled
    const width = viewport.width / scaled
    const start = Math.min(1, Math.max(0, left))
    const end = Math.min(1, Math.max(start + 0.01, left + width))
    return { start, end }
  }

  /**
   * 根据缩略条上的拖动位置，算出新的偏移（保持缩放不变）。
   * @param content - 内容尺寸。
   * @param view - 视图。
   * @param viewport - 视口尺寸。
   * @param ratio - 0..1，希望视口中心落在内容的位置。
   * @returns 新的视图。
   */
  function seekTo(content, view, viewport, ratio) {
    const scaled = content.width * view.scale
    const clamped = Math.min(1, Math.max(0, ratio))
    // 让 ratio 处的内容点落在视口中心
    const offsetX = viewport.width / 2 - clamped * scaled
    return constrain({ ...view, offsetX }, content, viewport)
  }

      return {
        MIN_SCALE: MIN_SCALE, MAX_SCALE: MAX_SCALE, EDGE_SLACK: EDGE_SLACK,
        clampScale: clampScale, zoomAt: zoomAt, panBy: panBy, constrain: constrain,
        fitToView: fitToView, toScreen: toScreen, overviewRange: overviewRange, seekTo: seekTo,
      }
    })()
    // ══ 生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/theme.js
    // 浏览器单文件 bundle 无法 import，因此把测试过的实现原样嵌入。
    // 修改请改 lib/theme.js 后重新生成，不要直接编辑这一段。
    var THEME = (function () {
  /** 主题名。 */
  var THEMES = ['auto', 'light', 'dark']

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
  var TRACK_PALETTE = {
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
  function trackColorAt(i, mode = 'light') {
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
  function stageTintAt(index, mode = 'light', pct = 10) {
    const list = TRACK_PALETTE[mode] ?? TRACK_PALETTE.light
    const idx = ((Number(index) % list.length) + list.length) % list.length
    return { color: list[idx], alpha: pct }
  }

  /** 存储键：记住用户的手动选择。 */
  var THEME_STORAGE_KEY = 'dsh-topic-map:theme'

  /**
   * 生成主题 CSS。
   *
   * `:root[data-tm-theme="..."]` 而不是 `:root`：插件的样式不能污染宿主，
   * 反过来宿主也不该覆盖插件。
   *
   * @returns CSS 文本。
   */
  function themeCss() {
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
  function detectHostTheme(doc) {
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
  function resolveTheme(choice, doc) {
    if (choice === 'light' || choice === 'dark') return choice
    return detectHostTheme(doc)
  }

  /** 读取用户上次的选择。 */
  function loadThemeChoice(storage) {
    try {
      const raw = storage === undefined || storage === null ? null : storage.getItem(THEME_STORAGE_KEY)
      if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw
    } catch {
      // 忽略
    }
    return 'auto'
  }

  /** 保存用户选择。 */
  function saveThemeChoice(storage, choice) {
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
  function nextThemeChoice(current) {
    const order = ['auto', 'light', 'dark']
    const i = order.indexOf(current)
    return order[(i + 1) % order.length]
  }

  /** 按钮上显示的图标与提示。 */
  function themeLabel(choice, resolved) {
    if (choice === 'auto') {
      return { icon: resolved === 'dark' ? '◐' : '◑', title: '主题：跟随系统（点击切换为浅色）' }
    }
    if (choice === 'light') return { icon: '☀', title: '主题：浅色（点击切换为深色）' }
    return { icon: '☾', title: '主题：深色（点击切换为跟随系统）' }
  }

      return {
        THEMES: THEMES, THEME_STORAGE_KEY: THEME_STORAGE_KEY, TRACK_PALETTE: TRACK_PALETTE,
        themeCss: themeCss, detectHostTheme: detectHostTheme, resolveTheme: resolveTheme,
        loadThemeChoice: loadThemeChoice, saveThemeChoice: saveThemeChoice,
        nextThemeChoice: nextThemeChoice, themeLabel: themeLabel,
        trackColorAt: trackColorAt, stageTintAt: stageTintAt,
      }
    })()
    // ══ 主题生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/filter.js
    // 筛选逻辑全部是纯函数，独立测试过（tests/filter.mjs）。
    var FILTER = (function () {
  /** 空条件：不做任何筛选。 */
  function emptyFilter() {
    return {
      query: '',        // 关键字
      stages: [],       // 选中的阶段名（空数组 = 不限）
      states: [],       // 选中的状态（空数组 = 不限）
      minTurns: null,   // 轮次数下限（含）
      maxTurns: null,   // 轮次数上限（含）
    }
  }

  /**
   * 判断是否"没有设置任何条件"。
   * 用于界面显示"筛选生效中"标记，以及跳过无谓的计算。
   *
   * @param filter - 条件。
   * @returns 是否为空条件。
   */
  function isFilterEmpty(filter) {
    if (filter === null || filter === undefined) return true
    const q = String(filter.query ?? '').trim()
    const stages = Array.isArray(filter.stages) ? filter.stages : []
    const states = Array.isArray(filter.states) ? filter.states : []
    return q === '' && stages.length === 0 && states.length === 0
      && (filter.minTurns === null || filter.minTurns === undefined)
      && (filter.maxTurns === null || filter.maxTurns === undefined)
  }

  /**
   * 一条泳道的可搜索文本。
   *
   * 把阶段名、工作流名、话题名、以及该泳道包含的所有轮次的提问都拼进去：
   * 用户搜索时想找的可能是"哪个话题里提过 API key"，而那个词只出现在
   * 某一轮的对话里，不在标题上。
   *
   * @param lane - 泳道。
   * @returns 小写化的可搜索文本。
   */
  function laneHaystack(lane) {
    if (lane === null || lane === undefined) return ''
    const parts = [
      lane.title,
      lane.stageName,
      lane.workflowName,
      lane.taskName,
    ]
    // 轮次里的提问文本（如果 Host 一并下发）
    if (Array.isArray(lane.turnTexts)) parts.push(...lane.turnTexts)
    return parts
      .filter(p => typeof p === 'string' && p !== '')
      .join(' ')
      .toLowerCase()
  }

  /**
   * 一条泳道在筛选下的状态。
   *
   * @param lane - 泳道。
   * @param filter - 条件。
   * @param factOf - `(turn) => fact`，取轮次事实（用于状态判断）。
   * @returns `{ match: boolean, reason: string }`。
   */
  function matchLane(lane, filter, factOf) {
    if (lane === null || lane === undefined) return { match: false, reason: 'empty' }
    if (isFilterEmpty(filter)) return { match: true, reason: '' }

    // 1. 关键字
    const q = String(filter.query ?? '').trim().toLowerCase()
    if (q !== '') {
      const hay = laneHaystack(lane)
      if (!hay.includes(q)) return { match: false, reason: 'query' }
    }

    // 2. 阶段（同条件内是"或"）
    const stages = Array.isArray(filter.stages) ? filter.stages : []
    if (stages.length > 0) {
      const name = lane.stageName ?? ''
      if (!stages.includes(name)) return { match: false, reason: 'stage' }
    }

    // 3. 状态（按该泳道首个轮次的结束原因归入某个状态桶）
    const states = Array.isArray(filter.states) ? filter.states : []
    if (states.length > 0) {
      const turns = Array.isArray(lane.turns) ? lane.turns : []
      if (turns.length === 0) return { match: false, reason: 'state' }
      const fact = typeof factOf === 'function' ? factOf(turns[0]) : undefined
      const bucket = stateBucketOf(fact)
      if (!states.includes(bucket)) return { match: false, reason: 'state' }
    }

    // 4. 轮次数范围
    const n = Array.isArray(lane.turns) ? lane.turns.length : 0
    if (Number.isFinite(filter.minTurns) && n < filter.minTurns) return { match: false, reason: 'turns' }
    if (Number.isFinite(filter.maxTurns) && n > filter.maxTurns) return { match: false, reason: 'turns' }

    return { match: true, reason: '' }
  }

  /**
   * 把轮次事实的结束原因归入状态桶。
   *
   * 这些桶**不是**真正的任务状态（日志里没有那个字段），而是"这一轮怎么结束的"。
   * 名字用中文是为了直接显示在筛选器上。
   *
   * @param fact - 轮次事实。
   * @returns 状态名。
   */
  function stateBucketOf(fact) {
    if (fact === null || fact === undefined) return '未知'
    const reason = fact.endReason
    if (reason === 'open') return '进行中'
    if (reason === 'error') return '出错'
    if (reason === 'max-tokens') return '超长'
    if (reason === 'aborted' || reason === 'interrupted' || reason === 'blocked') return '中断'
    return '完成'
  }

  /** 所有可能出现状态桶，供界面列复选框。 */
  var STATE_BUCKETS = ['完成', '进行中', '出错', '超长', '中断', '未知']

  /**
   * 对泳道列表应用筛选。
   *
   * @param lanes - 泳道数组。
   * @param filter - 条件。
   * @param factOf - `(turn) => fact`。
   * @returns `{ visible, hidden, counts }`：可见的、被隐藏的、以及统计信息。
   */
  function applyFilter(lanes, filter, factOf) {
    const list = Array.isArray(lanes) ? lanes : []
    const visible = []
    const hidden = []
    for (const lane of list) {
      const result = matchLane(lane, filter, factOf)
      if (result.match) visible.push(lane)
      else hidden.push(lane)
    }
    return {
      visible,
      hidden,
      counts: { total: list.length, visible: visible.length, hidden: hidden.length },
    }
  }

  /**
   * 收集所有可选阶段（去重，按首次出现排序）。
   *
   * @param lanes - 泳道数组。
   * @returns 阶段名数组。
   */
  function collectStages(lanes) {
    const seen = new Set()
    const out = []
    for (const lane of Array.isArray(lanes) ? lanes : []) {
      const name = typeof lane.stageName === 'string' && lane.stageName !== '' ? lane.stageName : null
      if (name === null || seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
    return out
  }

  /**
   * 在文本里标出关键字命中的位置，供界面高亮。
   *
   * 返回分段数组而不是 HTML 字符串：避免把用户输入拼进 innerHTML
   * （那是一条 XSS 通路，哪怕输入只来自用户自己）。
   *
   * @param text - 原文。
   * @param query - 关键字。
   * @returns `[{ text, hit }]`。
   */
  function highlightParts(text, query) {
    const raw = String(text ?? '')
    const q = String(query ?? '').trim()
    if (q === '' || raw === '') return [{ text: raw, hit: false }]
    const lower = raw.toLowerCase()
    const needle = q.toLowerCase()
    const parts = []
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      if (at > from) parts.push({ text: raw.slice(from, at), hit: false })
      parts.push({ text: raw.slice(at, at + q.length), hit: true })
      from = at + q.length
    }
    if (from < raw.length) parts.push({ text: raw.slice(from), hit: false })
    return parts.length === 0 ? [{ text: raw, hit: false }] : parts
  }

      return {
        emptyFilter: emptyFilter, isFilterEmpty: isFilterEmpty,
        laneHaystack: laneHaystack, matchLane: matchLane, stateBucketOf: stateBucketOf,
        STATE_BUCKETS: STATE_BUCKETS, applyFilter: applyFilter,
        collectStages: collectStages, highlightParts: highlightParts,
      }
    })()
    // ══ 筛选生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/pm-model.js
    // 任务状态与依赖的推导，全部是纯函数，独立测试过（tests/pm.mjs）。
    var PM = (function () {
  /** 任务状态。 */
  var TASK_STATES = ['todo', 'active', 'blocked', 'done']

  /** 状态的中文名与配色语义。 */
  var STATE_META = {
    todo: { label: '待办', tone: 'idle' },
    active: { label: '进行中', tone: 'brand' },
    blocked: { label: '阻塞', tone: 'warn' },
    done: { label: '已完成', tone: 'ok' },
  }

  /**
   * 会修改文件的工具名。
   *
   * 为什么用工具名而不是 `files`：`files` 只记工具参数里出现的路径，**读和写
   * 混在一起**（实测某会话 442 条里绝大多数是读到的文件），无法据此判断
   * "有没有实际产出"。工具名是可靠得多的信号——只有 edit/write 这类才会改文件。
   */
  var MUTATING_TOOLS = ['edit', 'write', 'plugin_manager', 'bash', 'ops_bash']

  /** 工具调用次数超过这个值，认为"反复折腾"，值得复核。 */
  var HEAVY_TOOL_THRESHOLD = 20

  /**
   * 收集一轮的硬证据。
   *
   * 这些是**客观信号**，不依赖语义判断：
   *   - 有没有修改类工具被调用（说明有实际产出）
   *   - 工具调用次数（多说明反复折腾）
   *   - 结束原因（报错/中断/超长）
   *   - 该话题出现过几轮（多说明反复在改）
   *
   * @param lane - 泳道。
   * @param factOf - `(turn) => fact`。
   * @returns 证据对象。
   */
  function collectEvidence(lane, factOf) {
    const turns = Array.isArray(lane?.turns) ? lane.turns : []
    let mutatingCalls = 0
    let toolCalls = 0
    let steps = 0
    const errorTurns = []
    const seenTools = new Set()

    for (const t of turns) {
      const fact = factOf(t)
      if (fact === undefined || fact === null) continue
      toolCalls += Number(fact.toolCalls) || 0
      steps += Number(fact.steps) || 0
      for (const name of (Array.isArray(fact.tools) ? fact.tools : [])) {
        if (typeof name !== 'string') continue
        seenTools.add(name)
        if (MUTATING_TOOLS.includes(name)) mutatingCalls += 1
      }
      if (['error', 'max-tokens', 'aborted', 'interrupted', 'blocked'].includes(fact.endReason)) {
        errorTurns.push(t)
      }
    }

    return {
      turnCount: turns.length,
      toolCalls,
      steps,
      mutatingCalls,
      hasOutput: mutatingCalls > 0,
      errorTurns,
      hasError: errorTurns.length > 0,
      heavyTools: toolCalls >= HEAVY_TOOL_THRESHOLD,
      tools: [...seenTools],
    }
  }

  /**
   * 由硬证据推导一个基础状态（不调用模型）。
   *
   * 判定顺序刻意如此：
   *   - 有报错且之后没再改 → 阻塞（事情没做成）
   *   - 有实际产出（改过文件）+ 之后转向别的话题 → 已完成（做出来了才可能收尾）
   *   - 没产出但轮次多、工具多 → 进行中（在折腾）
   *   - 其余 → 待办/进行中
   *
   * @param lane - 泳道。
   * @param factOf - `(turn) => fact`。
   * @param ctx - `{ lastTurnInSession, supersededAfter }`。
   * @returns `{ state, basis, evidence, suspect }`。
   */
  function inferFromEvidence(lane, factOf, ctx = {}) {
    const turns = Array.isArray(lane?.turns) ? lane.turns : []
    if (turns.length === 0) {
      return {
        state: 'todo',
        basis: '没有轮次',
        evidence: collectEvidence(lane, factOf),
        suspect: false,
      }
    }

    const ev = collectEvidence(lane, factOf)
    const last = factOf(turns[turns.length - 1])
    const maxTurn = Math.max(...turns)
    const atTail = Number.isFinite(ctx.lastTurnInSession) && maxTurn >= ctx.lastTurnInSession
    const superseded = Number.isFinite(ctx.supersededAfter)

    // 最后一轮还没结束
    if (last !== undefined && last !== null && last.endReason === 'open') {
      return { state: 'active', basis: `最后一轮（T${last.turn}）仍在进行`, evidence: ev, suspect: false }
    }

    // 有报错：如果之后转向了别的话题，说明绕过去了但这条没成
    if (ev.hasError) {
      const which = ev.errorTurns.join('、')
      return {
        state: 'blocked',
        basis: `第 ${which} 轮报错或中断`,
        evidence: ev,
        // 报错但仍在反复尝试 -> 值得复核（可能后来解决了）
        suspect: ev.turnCount > 1 || !superseded,
      }
    }

    /**
     * 完成判定必须过三关，缺一不可：
     *
     * 1. 有产出（改过文件）——光讨论不算做完
     * 2. 之后转向了别的话题——没人再谈它了
     * 3. **之后没有再回来改它**——回来了说明还没成
     *
     * 第 3 条是这次新加的。实测发现：一个会话里几乎每轮都在写文件，
     * 于是"改过文件 + 之后转向"几乎对每条都成立，22 条里 21 条被判 done，
     * 完全没有区分度。真正的区别在于"后来有没有回头继续修"。
     */
    const cameBack = Number.isFinite(ctx.laterTurnsOfSameLane)
      ? ctx.laterTurnsOfSameLane > 0
      : false

    if (ev.hasOutput && superseded && !cameBack) {
      return {
        state: 'done',
        basis: `改过文件（${ev.mutatingCalls} 次写），之后转向别的话题且未再回头`,
        evidence: ev,
        // 反复出现多次、或工具调用很多 -> 可能只是"改了很多遍"而非真做完
        suspect: ev.turnCount > 2 || ev.heavyTools,
      }
    }

    // 有产出、也转向了，但后来又回来改 —— 说明当时没成
    if (ev.hasOutput && superseded && cameBack) {
      return {
        state: 'active',
        basis: `改过文件，但之后又回来继续处理（共 ${ctx.laterTurnsOfSameLane} 轮），尚未收尾`,
        evidence: ev,
        suspect: true,
      }
    }

    // 有产出但还在会话末尾
    if (ev.hasOutput && atTail) {
      return {
        state: 'active',
        basis: '有写操作，但位于会话末尾，可能还会继续',
        evidence: ev,
        suspect: false,
      }
    }

    // 没有产出：只是聊了
    if (!ev.hasOutput) {
      if (atTail) {
        return { state: 'active', basis: '位于会话末尾', evidence: ev, suspect: false }
      }
      return {
        state: 'active',
        basis: '没有写操作，只是讨论',
        evidence: ev,
        // 讨论很多轮却没有任何产出 -> 可疑（是不是该动手了）
        suspect: ev.turnCount > 2 || ev.heavyTools,
      }
    }

    return {
      state: 'active',
      basis: '有写操作但之后仍在延续',
      evidence: ev,
      suspect: ev.heavyTools,
    }
  }

  /**
   * 由一条泳道的轮次事实推导状态。
   *
   * 判据按优先级：
   *   - 最后一轮出错 / 超长 / 中断 → blocked（事情没做成）
   *   - 最后一轮仍在进行（open）→ active
   *   - 最后一轮正常结束，且**之后转向了新话题** → done（这一支告一段落）
   *   - 最后一轮正常结束，但之后仍是同一话题的延续 → active
   *   - 它就是会话末尾 → active（事情刚说完，不能断言完成）
   *
   * 为什么 done 需要"后续转向新话题"：
   *   上一版只要求"不在会话末尾"就算 done，结果一个 16 条任务的会话里
   *   16 条全是 done——因为每条后面都还有别的轮次。那样状态就没有区分度，
   *   失去了 PM 视角的意义。
   *
   *   真正说明"这件事做完了"的信号是：**后面的轮次不再谈它了**。
   *   所以判据改成"后续存在属于其他话题的轮次"。
   *
   * @param lane - 泳道（需 turns）。
   * @param factOf - `(turn) => fact`。
   * @param ctx - `{ lastTurnInSession, supersededAfter }`。
   *   `supersededAfter` 是该泳道最后一轮之后、属于**其他话题**的最小轮次号；
   *   没有则为 null。
   * @returns `{ state, inferred, basis }`。
   */
  function inferTaskState(lane, factOf, ctx = {}) {
    const turns = Array.isArray(lane?.turns) ? lane.turns : []
    if (turns.length === 0) {
      return { state: 'todo', inferred: true, basis: '没有轮次' }
    }

    const last = factOf(turns[turns.length - 1])
    if (last === undefined || last === null) {
      return { state: 'todo', inferred: true, basis: '找不到轮次事实' }
    }

    const reason = last.endReason
    if (reason === 'error') {
      return { state: 'blocked', inferred: true, basis: `最后一轮（T${last.turn}）报错` }
    }
    if (reason === 'max-tokens') {
      return { state: 'blocked', inferred: true, basis: `最后一轮（T${last.turn}）超出长度上限` }
    }
    if (reason === 'aborted' || reason === 'interrupted' || reason === 'blocked') {
      return { state: 'blocked', inferred: true, basis: `最后一轮（T${last.turn}）被中断` }
    }
    if (reason === 'open') {
      return { state: 'active', inferred: true, basis: `最后一轮（T${last.turn}）仍在进行` }
    }

    const maxTurn = Math.max(...turns)
    const lastTurnInSession = Number.isFinite(ctx.lastTurnInSession) ? ctx.lastTurnInSession : null

    // 会话末尾：事情刚说完，可能还会继续
    if (lastTurnInSession !== null && maxTurn >= lastTurnInSession) {
      return { state: 'active', inferred: true, basis: '位于会话末尾，可能还会继续' }
    }

    // 后面出现了别的话题 -> 这一支告一段落
    const superseded = Number.isFinite(ctx.supersededAfter) ? ctx.supersededAfter : null
    if (superseded !== null) {
      return {
        state: 'done',
        inferred: true,
        basis: `T${maxTurn} 之后（T${superseded} 起）转向了别的话题`,
      }
    }

    // 后面仍在谈这件事
    return { state: 'active', inferred: true, basis: `之后仍有同一话题的延续` }
  }

  /**
   * 判断每条泳道"是否被后续其他话题接管"，供状态推导使用。
   *
   * 做法：按时间扫描所有轮次，记录每条泳道最后一轮之后，第一个属于
   * **不同泳道**的轮次号。
   *
   * @param lanes - 泳道数组。
   * @returns Map<laneId, number|null>，值是接管轮次号，没有则为 null。
   */
  function computeSupersession(lanes) {
    const list = Array.isArray(lanes) ? lanes : []
    const out = new Map()

    // 轮次 -> 泳道
    const owner = new Map()
    for (const lane of list) {
      for (const t of (Array.isArray(lane.turns) ? lane.turns : [])) owner.set(t, lane.laneId)
    }

    for (const lane of list) {
      const turns = Array.isArray(lane.turns) ? lane.turns : []
      if (turns.length === 0) { out.set(lane.laneId, null); continue }
      const maxTurn = Math.max(...turns)
      let hit = null
      // 找最小的、大于 maxTurn 且属于别的泳道的轮次
      for (const t of owner.keys()) {
        if (t <= maxTurn) continue
        if (owner.get(t) === lane.laneId) continue
        if (hit === null || t < hit) hit = t
      }
      out.set(lane.laneId, hit)
    }
    return out
  }

  /**
   * 统计每条泳道"在中间断开之后又回来"的轮次数。
   *
   * 为什么需要它：判断"做完"的关键不是"有没有再提到"，而是**有没有回来继续改**。
   * 一个话题在第 3 轮说完、第 9 轮又回来改代码，说明当时并没做成。
   *
   * 做法：把该泳道的轮次按序看，凡是与上一个轮次不连续的，就算"回来一次"，
   * 并把这次之后新增的轮次数计进去。
   *
   * @param lanes - 泳道数组。
   * @returns Map<laneId, number>，表示该泳道末尾区段之后又追加的轮次数。
   */
  function computeComeBack(lanes) {
    const out = new Map()
    for (const lane of Array.isArray(lanes) ? lanes : []) {
      const turns = (Array.isArray(lane.turns) ? [...lane.turns] : []).sort((a, b) => a - b)
      if (turns.length <= 1) { out.set(lane.laneId, 0); continue }

      // 找最后一个连续区段的起点：从末尾往前，只要相邻就继续
      let segStart = turns.length - 1
      while (segStart > 0 && turns[segStart] - turns[segStart - 1] === 1) segStart -= 1

      // 末尾区段之前还有轮次 => 曾经中断又回来过。
      // 计"回来之后新增了几轮"，作为"这次回来改了多少"的量化。
      const cameBack = segStart > 0
      out.set(lane.laneId, cameBack ? turns.length - segStart : 0)
    }
    return out
  }

  /**
   * 推导任务之间的依赖。
   *
   * 支持两类依据，都是**可解释**的：
   *
   * 1. `failure` —— A 的结尾不正常（报错/中断/超长），且 B 在 A 之后开始、
   *    属于同一话题。含义是"A 没做成，B 接着处理"。
   * 2. `sequence` —— A 与 B 属于同一工作流，且 A 的全部轮次都早于 B。
   *    含义是同一条工作线上的前后步骤。
   *
   * 为什么要有第 2 类：只看第 1 类时，一条顺利的会话会得到 0 条依赖
   * （因为没有任何失败），于是"依赖"这个视图永远是空的。而同工作流内的
   * 步骤先后是**真实存在的结构**——阶段/工作流本来就是按工作顺序拆的。
   *
   * 为什么不用"时间先后"当依赖：那会让整张图变成一条链，看不出真正的关系。
   * 所以限定在**同一工作流内**，且只连相邻两跳（前一个 → 这一个），不连
   * 所有祖先。
   *
   * @param lanes - 泳道数组。
   * @param factOf - `(turn) => fact`。
   * @param sameTopic - `(a, b) => boolean`，判断是否同一话题（默认同阶段）。
   * @returns `[{ from, to, kind, reason }]`。
   */
  function inferDependencies(lanes, factOf, sameTopic) {
    const list = Array.isArray(lanes) ? lanes : []
    const deps = []
    const seen = new Set()

    const push = (from, to, kind, reason) => {
      const key = from + '->' + to
      if (seen.has(key)) return
      seen.add(key)
      deps.push({ from, to, kind, reason })
    }

    // ── 1. 失败 → 后续接管 ──
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i]
      const aTurns = Array.isArray(a.turns) ? a.turns : []
      if (aTurns.length === 0) continue
      const aLast = factOf(aTurns[aTurns.length - 1])
      if (aLast === undefined || aLast === null) continue

      const failed = ['error', 'max-tokens', 'aborted', 'interrupted', 'blocked'].includes(aLast.endReason)
      if (!failed) continue

      for (let j = 0; j < list.length; j += 1) {
        if (i === j) continue
        const b = list[j]
        const bTurns = Array.isArray(b.turns) ? b.turns : []
        if (bTurns.length === 0) continue
        if (Math.min(...bTurns) <= Math.max(...aTurns)) continue
        if (typeof sameTopic === 'function' && !sameTopic(a, b)) continue
        push(a.laneId, b.laneId, 'failure',
          `${a.title} 在 T${Math.max(...aTurns)} 未完成，${b.title} 接着处理`)
      }
    }

    // ── 2. 同工作流内的前后步骤 ──
    // 按工作流分组，组内按首个轮次排序，连相邻两条。
    const byWorkflow = new Map()
    for (const lane of list) {
      const wf = typeof lane.workflowName === 'string' && lane.workflowName !== ''
        ? lane.workflowName
        : null
      if (wf === null) continue
      if (!byWorkflow.has(wf)) byWorkflow.set(wf, [])
      byWorkflow.get(wf).push(lane)
    }
    for (const [wfName, group] of byWorkflow) {
      if (group.length < 2) continue
      const sorted = [...group].sort((x, y) => Math.min(...x.turns) - Math.min(...y.turns))
      for (let k = 1; k < sorted.length; k += 1) {
        const prev = sorted[k - 1]
        const cur = sorted[k]
        const prevMax = Math.max(...prev.turns)
        const curMin = Math.min(...cur.turns)
        if (curMin <= prevMax) continue
        push(prev.laneId, cur.laneId, 'sequence',
          `同在「${wfName}」：${prev.title} → ${cur.title}`)
      }
    }

    return deps
  }

  /**
   * 汇总一组任务的状态计数。
   *
   * @param lanes - 泳道数组。
   * @param stateOf - `(laneId) => state`。
   * @returns `{ todo, active, blocked, done, total }`。
   */
  function summarizeStates(lanes, stateOf) {
    const out = { todo: 0, active: 0, blocked: 0, done: 0, total: 0 }
    for (const lane of Array.isArray(lanes) ? lanes : []) {
      const s = stateOf(lane.laneId)
      if (out[s] !== undefined) out[s] += 1
      out.total += 1
    }
    return out
  }

  /**
   * 把用户的手动覆盖叠加到推导结果上。
   *
   * 覆盖优先——用户看到的比推导准。但保留 `inferred` 标记，界面据此显示
   * "这是推导的"或"这是你标的"。
   *
   * @param inferred - `{ state, inferred, basis }`。
   * @param override - `'todo'|'active'|'blocked'|'done'` 或 undefined。
   * @returns `{ state, inferred, basis, overridden }`。
   */
  function applyOverride(inferred, override) {
    if (typeof override !== 'string' || !TASK_STATES.includes(override)) {
      return { ...inferred, overridden: false }
    }
    return {
      state: override,
      inferred: false,
      basis: '由你手动标注',
      overridden: true,
    }
  }

  /**
   * 阶段进度：以**计数**为主，百分比只是辅助。
   *
   * 为什么改成计数：百分比是推导值，加权公式（完成 1 / 进行中 0.5 / 阻塞 0.25）
   * 里的权重是我定的，不是用户定的。写"3/5 完成"是事实，
   * 写"60%"则需要接受我那套权重——前者更诚实。
   *
   * 百分比仍然返回，但只作为次要信息（且明确它由计数推算）。
   *
   * @param laneIds - 属于该阶段的任务。
   * @param stateOf - `(laneId) => state`。
   * @returns `{ done, total, percent, counts }`。
   */
  function stageProgress(laneIds, stateOf) {
    const ids = Array.isArray(laneIds) ? laneIds : []
    const counts = { todo: 0, active: 0, blocked: 0, done: 0, total: ids.length }
    if (ids.length === 0) return { done: 0, total: 0, percent: 0, counts }

    let score = 0
    for (const id of ids) {
      const s = stateOf(id)
      if (s === 'done') { score += 1; counts.done += 1 }
      else if (s === 'active') { score += 0.5; counts.active += 1 }
      else if (s === 'blocked') { score += 0.25; counts.blocked += 1 }
      else { counts.todo += 1 }
    }
    return {
      // 主信息：完成了几个 / 共几个。这是事实。
      done: counts.done,
      total: ids.length,
      // 次信息：加权百分比（权重建在 counts 之上，可解释）
      percent: Math.round(score / ids.length * 100),
      counts,
    }
  }

      return {
        TASK_STATES: TASK_STATES, STATE_META: STATE_META, MUTATING_TOOLS: MUTATING_TOOLS,
        inferTaskState: inferTaskState, inferFromEvidence: inferFromEvidence,
        inferDependencies: inferDependencies, computeSupersession: computeSupersession,
        computeComeBack: computeComeBack, collectEvidence: collectEvidence,
        summarizeStates: summarizeStates, applyOverride: applyOverride,
        stageProgress: stageProgress,
      }
    })()
    // ══ PM 生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/ui-state.js
    // 界面状态的归一化与合并，纯函数，独立测试过（tests/ui-state.mjs）。
    var UISTATE = (function () {
  /** 允许的状态值，与 pm-model 保持一致。 */
  const VALID_STATES = ['todo', 'active', 'blocked', 'done']

  /** 筛选条件里允许的字段。 */
  const FILTER_FIELDS = ['query', 'stages', 'states', 'minTurns', 'maxTurns']

  /**
   * 归一化一份 UI 状态，丢弃非法内容。
   *
   * 为什么严格清洗：这个文件可能被手工编辑过，也可能来自旧版本。
   * 让非法值流进渲染会以难以定位的方式出错，不如在入口就归位。
   *
   * @param raw - 原始对象。
   * @returns 干净的 UI 状态。
   */
  function normalizeUiState(raw) {
    const src = raw !== null && typeof raw === 'object' ? raw : {}

    // 状态覆盖：只保留 { laneId: validState }
    const overrides = {}
    const rawOverrides = src.overrides !== null && typeof src.overrides === 'object' ? src.overrides : {}
    for (const [laneId, state] of Object.entries(rawOverrides)) {
      if (typeof laneId !== 'string' || laneId === '') continue
      if (typeof state !== 'string' || !VALID_STATES.includes(state)) continue
      overrides[laneId] = state
    }

    // 筛选条件
    const rawFilter = src.filter !== null && typeof src.filter === 'object' ? src.filter : {}
    const filter = {
      query: typeof rawFilter.query === 'string' ? rawFilter.query : '',
      stages: Array.isArray(rawFilter.stages)
        ? rawFilter.stages.filter(s => typeof s === 'string' && s !== '')
        : [],
      states: Array.isArray(rawFilter.states)
        ? rawFilter.states.filter(s => typeof s === 'string' && s !== '')
        : [],
      minTurns: Number.isFinite(rawFilter.minTurns) && rawFilter.minTurns > 0
        ? Math.floor(rawFilter.minTurns)
        : null,
      maxTurns: Number.isFinite(rawFilter.maxTurns) && rawFilter.maxTurns > 0
        ? Math.floor(rawFilter.maxTurns)
        : null,
    }

    // 模型复核结果（整份存下）：一次复核要花 token，切走再回来不该白费。
    // 只保留必要字段，避免把大对象写进配置文件。
    let review = null
    if (src.review !== null && src.review !== undefined && typeof src.review === 'object') {
      const r = src.review
      const entries = Array.isArray(r.entries)
        ? r.entries
            .filter(e => e !== null && typeof e === 'object' && typeof e.laneId === 'string')
            .map(e => ({
              laneId: e.laneId,
              state: VALID_STATES.includes(e.state) ? e.state : 'todo',
              basis: typeof e.basis === 'string' ? e.basis : '',
              reviewed: e.reviewed === true,
            }))
        : []
      review = {
        status: typeof r.status === 'string' ? r.status : 'ready',
        reviewed: Number.isFinite(r.reviewed) ? r.reviewed : 0,
        total: Number.isFinite(r.total) ? r.total : entries.length,
        via: typeof r.via === 'string' ? r.via : 'session',
        entries,
        savedAt: Number.isFinite(r.savedAt) ? r.savedAt : 0,
      }
    }

    return { overrides, filter, review, updatedAt: Number.isFinite(src.updatedAt) ? src.updatedAt : 0 }
  }

  /**
   * 合并一次状态更新。
   *
   * 只改动提交上来的字段，其余保持不变——避免"只想标一个状态，却把筛选条件冲掉"。
   *
   * @param current - 当前 UI 状态（可为空）。
   * @param patch - 要改的字段：`{ overrides?, filter? }`。
   * @returns 新的 UI 状态。
   */
  function mergeUiState(current, patch) {
    const base = normalizeUiState(current)
    const next = {
      overrides: { ...base.overrides },
      filter: { ...base.filter },
      review: base.review,
      updatedAt: Date.now(),
    }

    if (patch !== null && patch !== undefined && typeof patch === 'object') {
      // 状态覆盖：单个 { laneId, state } 或整体替换
      if (patch.override !== undefined && patch.override !== null) {
        const { laneId, state } = patch.override
        if (typeof laneId === 'string' && laneId !== '') {
          if (state === null) delete next.overrides[laneId]
          else if (typeof state === 'string' && VALID_STATES.includes(state)) next.overrides[laneId] = state
        }
      }
      if (patch.overrides !== undefined && patch.overrides !== null && typeof patch.overrides === 'object') {
        next.overrides = normalizeUiState({ overrides: patch.overrides }).overrides
      }

      // 复核结果：整份替换；传 null 表示清除
      if (patch.review !== undefined) {
        if (patch.review === null) next.review = null
        else next.review = normalizeUiState({ review: patch.review }).review
      }

      // 筛选条件
      if (patch.filter !== undefined && patch.filter !== null && typeof patch.filter === 'object') {
        const merged = { ...next.filter }
        for (const key of FILTER_FIELDS) {
          if (patch.filter[key] !== undefined) merged[key] = patch.filter[key]
        }
        next.filter = normalizeUiState({ filter: merged }).filter
      }
    }

    return next
  }

  /**
   * 存储键（文件名友好）。
   * @param sessionId - 会话。
   * @returns 去掉了路径分隔符的 id。
   */
  function safeSessionId(sessionId) {
    return String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
  }

      return {
        normalizeUiState: normalizeUiState, mergeUiState: mergeUiState, safeSessionId: safeSessionId,
      }
    })()
    // ══ UI 状态生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/tree-fold.js
    // 折叠与路径推导，纯函数，独立测试过（tests/tree-fold.mjs）。
    var FOLD = (function () {
  /** 折叠键：阶段。 */
  function stageKey(name) {
    return 'S:' + name
  }

  /** 折叠键：工作流。 */
  function workflowKey(stageName, workflowName) {
    return 'S:' + stageName + ':W:' + workflowName
  }

  /**
   * 从 stages 结构里找出某个轮次所在的完整路径。
   *
   * @param stages - 阶段树。
   * @param turn - 轮次号。
   * @returns `{ stage, workflow, task }` 或 null。
   */
  function pathOfTurn(stages, turn) {
    for (const stage of Array.isArray(stages) ? stages : []) {
      for (const wf of stage.workflows ?? []) {
        for (const task of wf.tasks ?? []) {
          if (Array.isArray(task.turns) && task.turns.includes(turn)) {
            return { stage: stage.name, workflow: wf.name, task: task.name }
          }
        }
      }
    }
    return null
  }

  /**
   * 算出"只展开目标路径、收起其他阶段"的折叠状态。
   *
   * 为什么收起其他：一条会话可能有四五个阶段、十几个工作流。全都保持展开时
   * 点一个节点，目标仍然淹没在长列表里。收起其他阶段能让人立刻看到"我在哪"。
   *
   * @param stages - 阶段树。
   * @param path - `{ stage, workflow }`。
   * @returns 新的折叠状态对象（collapsed map）。
   */
  function foldToPath(stages, path) {
    const next = {}
    if (path === null || path === undefined) return next
    for (const stage of Array.isArray(stages) ? stages : []) {
      // 不是目标阶段的，整段收起
      if (stage.name !== path.stage) {
        next[stageKey(stage.name)] = true
        continue
      }
      // 目标阶段展开；其中不是目标工作流的收起
      for (const wf of stage.workflows ?? []) {
        if (wf.name !== path.workflow) {
          next[workflowKey(stage.name, wf.name)] = true
        }
      }
    }
    return next
  }

  /**
   * 全部展开：清空折叠状态。
   * @returns 空对象。
   */
  function expandAll() {
    return {}
  }

  /**
   * 全部折叠：收起所有阶段与工作流。
   *
   * 注意：只标记"阶段"就够了——阶段收起后其下工作流不渲染，
   * 再标记工作流会让"之后手动展开阶段"时发现子项也是折叠的，体验很怪。
   *
   * @param stages - 阶段树。
   * @returns 折叠状态。
   */
  function collapseAll(stages) {
    const next = {}
    for (const stage of Array.isArray(stages) ? stages : []) {
      next[stageKey(stage.name)] = true
    }
    return next
  }

  /**
   * 只看阶段：展开阶段，收起其下所有工作流。
   *
   * @param stages - 阶段树。
   * @returns 折叠状态。
   */
  function collapseToStages(stages) {
    const next = {}
    for (const stage of Array.isArray(stages) ? stages : []) {
      for (const wf of stage.workflows ?? []) {
        next[workflowKey(stage.name, wf.name)] = true
      }
    }
    return next
  }

  /**
   * 默认状态：展开阶段与工作流，只收起任务层。
   *
   * 这里复用"任务层不收"的语义——当前实现里任务没有独立折叠键，
   * 所以返回"只收起无"实际上就是全展开。保留这个函数是为了让默认值
   * 有一处显式定义，将来若给任务加折叠只需改这里。
   *
   * @returns 空折叠状态。
   */
  function defaultFold() {
    return {}
  }

  /**
   * 筛选联动：自动展开"有可见任务"的阶段与工作流，收起没有的。
   *
   * 为什么需要：筛选后如果命中的任务藏在一个收起的阶段里，用户会以为
   * 筛选坏了（明明显示 3/16，却看不到东西）。
   *
   * @param stages - 阶段树。
   * @param visibleTaskNames - Set，可见任务名。
   * @param taskKeyOf - `(task) => string`，取任务标识（默认用 name）。
   * @returns 折叠状态。
   */
  function foldForFilter(stages, visibleTaskNames, taskKeyOf) {
    const visible = visibleTaskNames instanceof Set ? visibleTaskNames : new Set()
    const idOf = typeof taskKeyOf === 'function' ? taskKeyOf : (t => t.name)
    const next = {}

    for (const stage of Array.isArray(stages) ? stages : []) {
      let stageHasVisible = false
      for (const wf of stage.workflows ?? []) {
        const wfVisible = (wf.tasks ?? []).some(t => visible.has(idOf(t)))
        if (wfVisible) {
          stageHasVisible = true
          // 有可见任务的工作流：不写折叠标记 = 展开
        } else {
          next[workflowKey(stage.name, wf.name)] = true
        }
      }
      if (!stageHasVisible) next[stageKey(stage.name)] = true
    }
    return next
  }

  /**
   * 判断某阶段是否展开。
   * @param collapsed - 折叠状态。
   * @param name - 阶段名。
   */
  function isStageOpen(collapsed, name) {
    return collapsed === null || collapsed === undefined ? true : collapsed[stageKey(name)] !== true
  }

  /** 判断某工作流是否展开。 */
  function isWorkflowOpen(collapsed, stageName, workflowName) {
    if (collapsed === null || collapsed === undefined) return true
    if (collapsed[stageKey(stageName)] === true) return false
    return collapsed[workflowKey(stageName, workflowName)] !== true
  }

  /**
   * 统计展开状态，供按钮显示当前模式。
   *
   * @param stages - 阶段树。
   * @param collapsed - 折叠状态。
   * @returns 'all' | 'none' | 'stages' | 'mixed'
   */
  function foldMode(stages, collapsed) {
    const list = Array.isArray(stages) ? stages : []
    if (list.length === 0) return 'all'

    const c = collapsed ?? {}
    const stageClosed = list.every(s => c[stageKey(s.name)] === true)
    if (stageClosed) return 'none'

    const allStageOpen = list.every(s => c[stageKey(s.name)] !== true)
    if (allStageOpen) {
      const anyWfOpen = list.some(s =>
        (s.workflows ?? []).some(w => c[workflowKey(s.name, w.name)] !== true))
      return anyWfOpen ? 'all' : 'stages'
    }
    return 'mixed'
  }

      return {
        stageKey: stageKey, workflowKey: workflowKey, pathOfTurn: pathOfTurn,
        foldToPath: foldToPath, expandAll: expandAll, collapseAll: collapseAll,
        collapseToStages: collapseToStages, defaultFold: defaultFold,
        foldForFilter: foldForFilter, isStageOpen: isStageOpen,
        isWorkflowOpen: isWorkflowOpen, foldMode: foldMode,
      }
    })()
    // ══ 树折叠生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/deliverables.js
    // 交付物抽取，纯函数，独立测试过（tests/report.mjs）。
    var DELIV = (function () {
  /** 会产出交付物的工具。 */
  var PRODUCING_TOOLS = ['write', 'edit', 'present', 'plugin_manager']

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
  function isDeliverablePath(path) {
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
  function shortPath(path, depth = 2) {
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
  function baseName(path) {
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
  function collectDeliverables(turns, factOf, options = {}) {
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
  function groupByStage(stages, lanes, factOf) {
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

      return {
        PRODUCING_TOOLS: PRODUCING_TOOLS, isDeliverablePath: isDeliverablePath,
        baseName: baseName, shortPath: shortPath,
        collectDeliverables: collectDeliverables, groupByStage: groupByStage,
      }
    })()
    // ══ 交付物生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/report.js
    // 工作量与风险报告，纯函数，独立测试过（tests/report.mjs）。
    var REPORT = (function () {
  /** 工作量统计：单个任务。 */
  function laneWorkload(lane, factOf) {
    const turns = Array.isArray(lane?.turns) ? lane.turns : []
    let toolCalls = 0
    let steps = 0
    let durationMs = 0
    let tokens = 0
    let cost = 0

    for (const t of turns) {
      const fact = factOf(t)
      if (fact === undefined || fact === null) continue
      toolCalls += Number(fact.toolCalls) || 0
      steps += Number(fact.steps) || 0
      durationMs += Number(fact.durationMs) || 0
      const u = fact.usage ?? {}
      tokens += (Number(u.input) || 0) + (Number(u.output) || 0)
        + (Number(u.cacheRead) || 0) + (Number(u.cacheWrite) || 0) + (Number(u.reasoning) || 0)
      cost += Number(fact.cost) || 0
    }

    return {
      laneId: lane?.laneId ?? '',
      title: lane?.title ?? '',
      stage: lane?.stageName ?? null,
      turns: turns.length,
      toolCalls,
      steps,
      durationMs,
      tokens,
      cost,
    }
  }

  /**
   * 整个会话的工作量汇总。
   *
   * @param lanes - 泳道。
   * @param factOf - `(turn) => fact`。
   * @returns `{ rows, totals }`。
   */
  function workloadReport(lanes, factOf) {
    const rows = (Array.isArray(lanes) ? lanes : []).map(l => laneWorkload(l, factOf))
    const totals = {
      turns: 0, toolCalls: 0, steps: 0, durationMs: 0, tokens: 0, cost: 0,
    }
    for (const r of rows) {
      totals.turns += r.turns
      totals.toolCalls += r.toolCalls
      totals.steps += r.steps
      totals.durationMs += r.durationMs
      totals.tokens += r.tokens
      totals.cost += r.cost
    }
    // 按工具调用降序：最能看出"哪件事最费劲"
    rows.sort((a, b) => b.toolCalls - a.toolCalls)
    return { rows, totals }
  }

  /**
   * 风险清单。
   *
   * 三类有证据的风险：
   *   1. blocked —— 状态推导为阻塞
   *   2. error-turn —— 该任务里有轮次报错/中断
   *   3. rework —— 同一任务被反复回来修改（轮次多且不连续）
   *
   * @param lanes - 泳道。
   * @param factOf - `(turn) => fact`。
   * @param detailOf - `(laneId) => { state, basis }`。
   * @returns `[{ laneId, title, stage, kind, level, reason }]`。
   */
  function riskReport(lanes, factOf, detailOf) {
    const out = []
    for (const lane of Array.isArray(lanes) ? lanes : []) {
      const detail = typeof detailOf === 'function' ? detailOf(lane.laneId) : null
      const state = detail === null || detail === undefined ? 'todo' : detail.state
      const turns = Array.isArray(lane.turns) ? lane.turns : []

      if (state === 'blocked') {
        out.push({
          laneId: lane.laneId,
          title: lane.title,
          stage: lane.stageName ?? null,
          kind: 'blocked',
          level: 'high',
          reason: detail.basis || '处于阻塞状态',
        })
        continue
      }

      const errorTurns = turns.filter(t => {
        const f = factOf(t)
        return f !== undefined && f !== null
          && ['error', 'max-tokens', 'aborted', 'interrupted', 'blocked'].includes(f.endReason)
      })
      if (errorTurns.length > 0) {
        out.push({
          laneId: lane.laneId,
          title: lane.title,
          stage: lane.stageName ?? null,
          kind: 'error-turn',
          level: 'high',
          reason: `第 ${errorTurns.join('、')} 轮报错或中断`,
        })
        continue
      }

      // 返工：轮次多，或改动量异常大
      //
      // 两个判据都要，因为返工有两种形态：
      //   ① 同一任务分几段处理（中间去做别的了）—— 看轮次是否连续
      //   ② 连续多轮里工具调用量巨大 —— 在反复折腾
      // 实测某会话"跳转定位"是 [11,12,13,14,15] 连续五轮，按 ① 判不出来，
      // 但工具调用 152 次，明显是在反复试。
      //
      // 注意不能用 `tools` 判断"改了几次"：那是**去重后**的工具名列表，
      // 只能说明"用没用过 write"，不能说明用了几次。要用 toolCalls。
      if (turns.length >= 3) {
        const sorted = [...turns].sort((a, b) => a - b)
        let gaps = 0
        for (let i = 1; i < sorted.length; i += 1) {
          if (sorted[i] - sorted[i - 1] > 1) gaps += 1
        }
        const totalCalls = turns.reduce((a, t) => {
          const f = factOf(t)
          return a + (f !== undefined && f !== null ? (Number(f.toolCalls) || 0) : 0)
        }, 0)

        if (gaps > 0) {
          out.push({
            laneId: lane.laneId,
            title: lane.title,
            stage: lane.stageName ?? null,
            kind: 'rework',
            level: 'medium',
            reason: `分 ${gaps + 1} 段反复处理，共 ${turns.length} 轮`,
          })
        } else if (turns.length >= 4 && totalCalls >= 80) {
          out.push({
            laneId: lane.laneId,
            title: lane.title,
            stage: lane.stageName ?? null,
            kind: 'rework',
            level: 'medium',
            reason: `连续 ${turns.length} 轮、${totalCalls} 次工具调用，改动量大`,
          })
        }
      }
    }
    // 高优先在前
    out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1))
    return out
  }

  /** CSV 单元格转义。 */
  function csvCell(v) {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  /**
   * 导出任务表为 CSV。
   *
   * 列选得克制：PM 更关心状态与工作量，不需要把 token 明细全倒出来。
   *
   * @param rows - `[{ title, stage, state, turns, toolCalls, durationMs, cost }]`。
   * @returns CSV 文本。
   */
  function toCsv(rows) {
    const header = ['任务', '阶段', '状态', '轮次', '工具调用', '耗时(秒)', '费用(USD)']
    const lines = [header.join(',')]
    for (const r of Array.isArray(rows) ? rows : []) {
      lines.push([
        csvCell(r.title),
        csvCell(r.stage ?? ''),
        csvCell(r.state ?? ''),
        csvCell(r.turns ?? 0),
        csvCell(r.toolCalls ?? 0),
        csvCell(Math.round((r.durationMs ?? 0) / 1000)),
        csvCell((r.cost ?? 0).toFixed(2)),
      ].join(','))
    }
    return lines.join('\n')
  }

  /**
   * 导出为 Markdown 报告。
   *
   * @param input - `{ title, stages, stateOf, detailOf, risks, deliverables, workload, totals }`。
   * @returns Markdown 文本。
   */
  function toMarkdown(input) {
    const {
      title = '话题地图',
      stages = [],
      detailOf,
      risks = [],
      deliverables = [],
      workload,
      totals,
      stateLabel,
    } = input ?? {}

    const lines = []
    lines.push(`# ${title}`)
    lines.push('')
    lines.push(`> 由 DSH 话题地图导出`)
    lines.push('')

    // 总览
    const counts = { done: 0, active: 0, blocked: 0, todo: 0 }
    for (const stage of stages) {
      for (const wf of stage.workflows ?? []) {
        for (const task of wf.tasks ?? []) {
          const t0 = Array.isArray(task.turns) && task.turns.length > 0 ? task.turns[0] : null
          if (t0 === null) continue
          const d = typeof detailOf === 'function' ? detailOf(t0) : null
          if (d !== null && counts[d.state] !== undefined) counts[d.state] += 1
        }
      }
    }
    lines.push('## 总览')
    lines.push('')
    lines.push(`| 指标 | 值 |`)
    lines.push(`| --- | --- |`)
    const label = typeof stateLabel === 'function' ? stateLabel : (s => s)
    for (const k of ['done', 'active', 'blocked', 'todo']) {
      lines.push(`| ${label(k)} | ${counts[k]} |`)
    }
    if (totals !== undefined) {
      lines.push(`| 轮次 | ${totals.turns ?? 0} |`)
      lines.push(`| 工具调用 | ${totals.toolCalls ?? 0} |`)
      lines.push(`| 耗时 | ${Math.round((totals.durationMs ?? 0) / 1000)} 秒 |`)
      lines.push(`| 费用 | $${(totals.cost ?? 0).toFixed(2)} |`)
    }
    lines.push('')

    // 结构
    lines.push('## 结构与状态')
    lines.push('')
    for (const stage of stages) {
      lines.push(`### ${stage.name}`)
      lines.push('')
      for (const wf of stage.workflows ?? []) {
        lines.push(`**${wf.name}**`)
        lines.push('')
        for (const task of wf.tasks ?? []) {
          const t0 = Array.isArray(task.turns) && task.turns.length > 0 ? task.turns[0] : null
          const d = t0 === null || typeof detailOf !== 'function' ? null : detailOf(t0)
          const state = d === null ? '' : ` — ${label(d.state)}`
          const turns = Array.isArray(task.turns) ? ` (${task.turns.map(t => 'T' + t).join(' ')})` : ''
          lines.push(`- ${task.name}${state}${turns}`)
        }
        lines.push('')
      }
    }

    // 风险
    if (risks.length > 0) {
      lines.push('## 风险')
      lines.push('')
      lines.push(`| 任务 | 阶段 | 类型 | 说明 |`)
      lines.push(`| --- | --- | --- | --- |`)
      for (const r of risks) {
        const kind = r.kind === 'blocked' ? '阻塞' : r.kind === 'error-turn' ? '报错' : '返工'
        lines.push(`| ${r.title} | ${r.stage ?? ''} | ${kind} | ${r.reason} |`)
      }
      lines.push('')
    }

    // 交付物
    if (deliverables.length > 0) {
      lines.push('## 交付物')
      lines.push('')
      for (const g of deliverables) {
        lines.push(`### ${g.stage}`)
        lines.push('')
        for (const item of g.items) lines.push(`- \`${item.name}\``)
        lines.push('')
      }
    }

    // 工作量
    if (workload !== undefined && Array.isArray(workload.rows) && workload.rows.length > 0) {
      lines.push('## 工作量')
      lines.push('')
      lines.push(`| 任务 | 轮次 | 工具调用 | 耗时(秒) | 费用 |`)
      lines.push(`| --- | --- | --- | --- | --- |`)
      for (const r of workload.rows.slice(0, 20)) {
        lines.push(`| ${r.title} | ${r.turns} | ${r.toolCalls} | ${Math.round(r.durationMs / 1000)} | $${r.cost.toFixed(2)} |`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

      return {
        laneWorkload: laneWorkload, workloadReport: workloadReport,
        riskReport: riskReport, toCsv: toCsv, toMarkdown: toMarkdown,
      }
    })()
    // ══ 报告生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/graph-mode.js
    // 图着色模式，纯函数，独立测试过（tests/graph-mode.mjs）。
    var GMODE = (function () {
  /** 着色模式。 */
  var GRAPH_MODES = ['topic', 'status']

  /** 存储键。 */
  var GRAPH_MODE_KEY = 'dsh-topic-map:graphmode'

  /**
   * 状态色的基准色相（HSL 的色相角）。
   *
   * 用 HSL 而不是固定色表：同色系深浅需要按序号调制明度，
   * 固定色表做不出"连续可区分"的变化。
   */
  var STATUS_HUE = {
    done: { h: 145, s: 46 },     // 绿：完成
    active: { h: 214, s: 62 },   // 蓝：进行中
    blocked: { h: 32, s: 72 },   // 橙：阻塞
    todo: { h: 220, s: 8 },      // 灰：待办
  }

  /**
   * 生成状态色。
   *
   * 同状态内按 index 在明度上铺开：从较深到较浅循环，保证相邻两条线不同深浅。
   *
   * @param state - 'done' | 'active' | 'blocked' | 'todo'
   * @param index - 该状态内的序号（0 起）。
   * @param mode - 'light' | 'dark'。
   * @returns CSS 颜色。
   */
  function statusColor(state, index, mode = 'light') {
    const base = STATUS_HUE[state] ?? STATUS_HUE.todo
    const n = Number.isFinite(index) ? Math.abs(index) : 0

    // 在同状态内铺开 5 档明度，第 6 条回到第 1 档
    const step = n % 5
    // 深色主题整体提亮、降饱和，避免在暖黑底上刺眼
    const lightBase = 46
    const lightSpan = 16
    const darkBase = 58
    const darkSpan = 12

    const lightness = mode === 'dark'
      ? darkBase + (step / 4) * darkSpan
      : lightBase + (step / 4) * lightSpan
    const sat = mode === 'dark' ? Math.max(24, base.s - 12) : base.s

    return `hsl(${base.h} ${sat}% ${Math.round(lightness)}%)`
  }

  /**
   * 取一条泳道在某种模式下的颜色。
   *
   * @param options - `{ mode, state, stateIndex, topicIndex, theme }`。
   * @returns CSS 颜色。
   */
  function laneColor(options) {
    const { mode = 'topic', state = 'todo', stateIndex = 0, topicIndex = 0, theme = 'light' } = options ?? {}
    if (mode === 'status') return statusColor(state, stateIndex, theme)
    // 话题色由调用方提供的 topicColorOf 决定（theme.js 的 10 色板）
    return null
  }

  /**
   * 为一批泳道预先算出"该状态内的序号"。
   *
   * 为什么需要预计算：深浅变化要按"同一状态内的第几条"来定，
   * 而不是全局序号——否则 10 条完成里只有前两条颜色不同。
   *
   * @param lanes - `[{ laneId, state }]`。
   * @returns Map<laneId, number>。
   */
  function stateIndexMap(lanes) {
    const counters = {}
    const out = new Map()
    for (const lane of Array.isArray(lanes) ? lanes : []) {
      const state = lane.state ?? 'todo'
      const next = counters[state] ?? 0
      out.set(lane.laneId, next)
      counters[state] = next + 1
    }
    return out
  }

  /**
   * 下一个模式（两态循环）。
   * @param current - 当前模式。
   * @returns 另一个模式。
   */
  function nextGraphMode(current) {
    return current === 'status' ? 'topic' : 'status'
  }

  /** 读取保存的模式。 */
  function loadGraphMode(storage) {
    try {
      const raw = storage === null || storage === undefined ? null : storage.getItem(GRAPH_MODE_KEY)
      if (raw === 'topic' || raw === 'status') return raw
    } catch {
      // 忽略
    }
    return 'topic'
  }

  /** 保存模式。 */
  function saveGraphMode(storage, mode) {
    try {
      if (storage !== null && storage !== undefined) storage.setItem(GRAPH_MODE_KEY, mode)
    } catch {
      // 忽略
    }
  }

  /** 按钮的图标与提示。 */
  function graphModeLabel(mode) {
    if (mode === 'status') {
      return { icon: '◍', title: '着色：状态（绿=完成 蓝=进行中 橙=阻塞）· 点击切回话题色' }
    }
    return { icon: '◌', title: '着色：话题（每条线一个颜色）· 点击切到状态色' }
  }

      return {
        GRAPH_MODES: GRAPH_MODES, GRAPH_MODE_KEY: GRAPH_MODE_KEY, STATUS_HUE: STATUS_HUE,
        statusColor: statusColor, laneColor: laneColor, stateIndexMap: stateIndexMap,
        nextGraphMode: nextGraphMode, loadGraphMode: loadGraphMode,
        saveGraphMode: saveGraphMode, graphModeLabel: graphModeLabel,
      }
    })()
    // ══ 图着色模式生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/session-category.js
    // 会话归类 + 模型输出抽取，纯函数，独立测试过。
    // model-output 必须嵌在同一个作用域里：SCAT 要用它的抽取函数。
    var SCAT = (function () {
  /**
   * 从文本里抽第一个能解析成数组的 JSON 片段。
   *
   * @param text - 模型输出。
   * @returns 数组或 null。
   */
  function extractJsonArray(text) {
    const fence = String(text ?? '').replace(/```[a-zA-Z]*\n?/g, '')

    const starts = []
    const ends = []
    for (let i = 0; i < fence.length; i += 1) {
      if (fence[i] === '[') starts.push(i)
      else if (fence[i] === ']') ends.push(i)
    }
    if (starts.length === 0 || ends.length === 0) return null

    // 候选跨度按"起点靠后、跨度更短"优先：先试更像答案的片段
    for (let si = starts.length - 1; si >= 0; si -= 1) {
      const from = starts[si]
      for (let ei = 0; ei < ends.length; ei += 1) {
        const to = ends[ei]
        if (to <= from) continue
        try {
          const parsed = JSON.parse(fence.slice(from, to + 1))
          if (Array.isArray(parsed)) return parsed
        } catch {
          // 这个跨度不合法，继续试
        }
      }
    }
    return null
  }

  /**
   * 抽取并校验长度。
   *
   * 长度不符一律作废：错位的结果比"没有结果"糟得多——它会让内容被放到
   * 错误的位置，而用户不会立刻发现。
   *
   * @param text - 模型输出。
   * @param expected - 期望条数。
   * @returns 数组或 null。
   */
  function extractJsonArrayOfLength(text, expected) {
    const parsed = extractJsonArray(text)
    if (parsed === null) return null
    if (!Number.isFinite(expected) || expected < 0) return null
    return parsed.length === expected ? parsed : null
  }

  /**
   * 从对象里按候选键名取数组（兼容模型把数组包在对象里的情况）。
   *
   * 例：期望一个分配数组，模型给了 `{"assignments":[...]}` 或 `{"result":[...]}`。
   *
   * @param text - 模型输出。
   * @param keys - 候选键名，按优先级。
   * @param expected - 期望条数（可选）。
   * @returns 数组或 null。
   */
  function extractJsonField(text, keys, expected) {
    const fence = String(text ?? '').replace(/```[a-zA-Z]*\n?/g, '')
    const from = fence.indexOf('{')
    const to = fence.lastIndexOf('}')
    if (from < 0 || to <= from) return null

    let parsed
    try {
      parsed = JSON.parse(fence.slice(from, to + 1))
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null

    for (const key of Array.isArray(keys) ? keys : []) {
      const value = parsed[key]
      if (!Array.isArray(value)) continue
      if (Number.isFinite(expected) && value.length !== expected) continue
      return value
    }
    return null
  }




  /** 大类数量建议区间。 */
  var CATEGORY_RANGE = [3, 6]

  /** 每个大类下的子类数量上限。 */
  var SUBCATEGORY_LIMIT = 4

  /** 一次最多归类多少会话（再多就先截断，避免上下文爆炸）。 */
  var SESSION_LIMIT = 200

  /** 每个会话在提示词里的描述预算。 */
  const DESC_BUDGET = 90

  function clip(text, budget) {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim()
    return s.length <= budget ? s : `${s.slice(0, budget - 1)}…`
  }

  /**
   * 判断一个会话是不是子代理/机器人产生的。
   *
   * 为什么需要：实测某工作区 108 个会话里 86 个是子代理单轮会话
   * （日志开头是 `[dsh-mnemon:delegated review]`），它们不是人真正在推进的事。
   * 全都平铺会淹没真实对话。
   *
   * @param session - `{ title, firstPrompt }`。
   * @returns 是否像子代理会话。
   */
  function looksAutomated(session) {
    // ① 平台权威标记优先。
    //
    // 实测：当前 DSH 版本（session v4）里 `origin` 与 `delegationDepth`
    // 虽然写在类型定义中，实际日志里并不填充（是 undefined / 0）。
    // 所以这层必须保留，但不能只靠它——拿不到时要能退回正则。
    const origin = session?.origin
    if (origin === 'subagent') return true
    if (Number.isFinite(session?.delegationDepth) && session.delegationDepth > 0) return true

    // ② 正则兜底：子代理的提示词是模板化的角色设定
    const text = `${session?.title ?? ''} ${session?.firstPrompt ?? ''}`.toLowerCase()
    if (text.trim() === '') return false
    if (text.includes('dsh-mnemon')) return true
    if (text.includes('delegated review')) return true
    if (/^\s*\[[^\]]{1,40}\]\s*bounded/.test(text)) return true
    // 系统类消息：审批策略变更等
    if (/the approval policy changed from/.test(text)) return true
    if (/^the working directory is /.test(text)) return true
    return false
  }

  /**
   * 为归类准备会话描述。
   *
   * 只发标题 + 首轮提问的截断，不发全文——归类看的是"这件事是关于什么"，
   * 几轮对话就足够判断，发全文既贵又容易让模型纠结细节。
   *
   * @param sessions - `[{ sessionId, title, firstPrompt, turns }]`。
   * @param limit - 上限。
   * @returns `[{ id, name, sample, turns }]`。
   */
  function prepareSessions(sessions, limit = SESSION_LIMIT) {
    const list = Array.isArray(sessions) ? sessions : []
    return list.slice(0, limit).map(s => ({
      id: String(s.sessionId ?? ''),
      name: clip(s.title ?? s.sessionId ?? '', 60),
      sample: clip(s.firstPrompt ?? '', DESC_BUDGET),
      turns: Number(s.turns) || 0,
      automated: looksAutomated(s),
    }))
  }

  /**
   * 构造归类提示词。
   *
   * 让模型一次输出两层的扁平结果（大类 + 子类），而不是嵌套结构：
   * 嵌套容易编错括号与长度，扁平数组可以用长度校验兜住。
   *
   * @param items - `prepareSessions` 的输出。
   * @returns `{ system, user }`。
   */
  function buildCategoryPrompt(items) {
    const system = [
      '你在帮助把一个工作区里的多次对话，按主题归成「大类 → 子类」两层。',
      `大类代表一个大方向（例如"插件开发""技术调研""环境排障"），${CATEGORY_RANGE[0]}-${CATEGORY_RANGE[1]} 个为宜。`,
      `子类是某个大类下的具体分支（例如大类"插件开发"下有"话题地图""会话归档"），每个大类 1-${SUBCATEGORY_LIMIT} 个。`,
      '规则：',
      '- 按"这些对话在解决什么问题"归并，不要按时间或字数；',
      '- 子类名要能概括组内所有会话，用 2-8 个字；',
      '- 标了 [自动] 的是机器人/子代理产生的会话，可以单独归到一个"自动化任务"大类下；',
      '- 不要每一条都单独立成一个子类。',
      '只输出 JSON 数组，长度与会话数一致，元素是对象：{"category":"大类名","sub":"子类名"}。不要任何解释。',
    ].join('\n')

    const body = items.map((it, i) => {
      const flags = []
      if (it.automated) flags.push('自动')
      if (it.turns > 0) flags.push(`${it.turns} 轮`)
      const flag = flags.length > 0 ? ` [${flags.join(' · ')}]` : ''
      const sample = it.sample === '' ? '' : `\n   内容：${it.sample}`
      return `${i + 1}. ${it.name}${flag}${sample}`
    }).join('\n')

    return {
      system,
      user: `以下是 ${items.length} 个会话：\n\n${body}\n\n请输出长度 ${items.length} 的 JSON 数组，每个元素含 category 与 sub。`,
    }
  }


  /**
   * 解析归类结果。
   *
   * 严格校验长度：错位的归类会把会话放到错误的组里，那比"没归类"糟得多——
   * 用户会以为自己找错地方了。
   *
   * @param text - 模型输出。
   * @param expected - 期望条数。
   * @returns `[{ category, sub }]` 或 null。
   */
  function parseCategories(text, expected) {
    // 共享抽取器已校验长度，这里不再重复
    const parsed = extractJsonArrayOfLength(text, expected)
    if (parsed === null) return null

    const out = []
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') return null
      const category = typeof item.category === 'string' ? item.category.trim() : ''
      const sub = typeof item.sub === 'string' ? item.sub.trim() : ''
      if (category === '' || sub === '') return null
      out.push({ category: category.slice(0, 24), sub: sub.slice(0, 24) })
    }
    return out
  }

  /**
   * 把归类结果组装成两层树。
   *
   * 保持首次出现顺序：大类的顺序由它第一个会话的位置决定，子类同理。
   * 这样列表的排列与时间线一致，用户扫一眼能对上"先做的在上面"。
   *
   * @param items - `prepareSessions` 的输出（含 id/name/turns/automated）。
   * @param labels - `parseCategories` 的结果。
   * @returns `[{ name, count, subcategories: [{ name, sessions: [...] }] }]`。
   */
  function buildCategoryTree(items, labels) {
    if (!Array.isArray(items) || !Array.isArray(labels) || items.length !== labels.length) {
      return []
    }

    const order = []
    const byCategory = new Map()

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]
      const { category, sub } = labels[i]

      if (!byCategory.has(category)) {
        byCategory.set(category, { name: category, count: 0, subOrder: [], subs: new Map() })
        order.push(category)
      }
      const cat = byCategory.get(category)
      cat.count += 1

      if (!cat.subs.has(sub)) {
        cat.subs.set(sub, { name: sub, sessions: [] })
        cat.subOrder.push(sub)
      }
      cat.subs.get(sub).sessions.push({
        sessionId: item.id,
        title: item.name,
        turns: item.turns,
        automated: item.automated === true,
      })
    }

    return order.map(name => {
      const cat = byCategory.get(name)
      return {
        name: cat.name,
        count: cat.count,
        subcategories: cat.subOrder.map(s => cat.subs.get(s)),
      }
    })
  }

  /**
   * 不可用时的兜底：按"是否自动会话"粗分两组。
   *
   * 模型不可用时不该让整个列表不可用——至少让用户能区分真实对话与机器人噪音。
   *
   * @param items - `prepareSessions` 的输出。
   * @returns 两层树。
   */
  function fallbackTree(items) {
    const list = Array.isArray(items) ? items : []
    const human = { name: '真实对话', sessions: [] }
    const auto = { name: '自动化任务', sessions: [] }
    for (const it of list) {
      const target = it.automated ? auto : human
      target.sessions.push({
        sessionId: it.id,
        title: it.name,
        turns: it.turns,
        automated: it.automated === true,
      })
    }
    const out = []
    if (human.sessions.length > 0) {
      out.push({ name: '未归类', count: human.sessions.length, subcategories: [human] })
    }
    if (auto.sessions.length > 0) {
      out.push({ name: '自动化任务', count: auto.sessions.length, subcategories: [auto] })
    }
    return out
  }

  /**
   * 在树里按关键字过滤。
   *
   * 匹配范围：大类名、子类名、会话标题。正文匹配由 Host 侧的全文检索负责，
   * 这里只管已经拿到手的结构化数据。
   *
   * @param tree - `buildCategoryTree` 的输出。
   * @param query - 关键字（空则原样返回）。
   * @returns 过滤后的树（只保留有命中的分支）。
   */
  function filterTree(tree, query) {
    const q = String(query ?? '').trim().toLowerCase()
    if (q === '') return tree
    const out = []
    for (const cat of Array.isArray(tree) ? tree : []) {
      const catHit = cat.name.toLowerCase().includes(q)
      const subs = []
      let count = 0
      for (const sub of cat.subcategories ?? []) {
        const subHit = sub.name.toLowerCase().includes(q)
        const sessions = (sub.sessions ?? []).filter(s =>
          catHit || subHit || String(s.title).toLowerCase().includes(q))
        if (sessions.length > 0) {
          subs.push({ ...sub, sessions })
          count += sessions.length
        }
      }
      if (subs.length > 0) out.push({ ...cat, count, subcategories: subs })
    }
    return out
  }

  /**
   * 把会话切成若干批。
   *
   * 为什么要分批：一次让模型归 500 个会话，输出几百条 JSON 极易错位
   * （本实现严格校验长度，错位就整批作废）。分批后每批独立成败，
   * 某批失败不影响其他批。
   *
   * @param items - `prepareSessions` 的输出。
   * @param size - 每批条数。
   * @returns 二维数组。
   */
  function splitIntoBatches(items, size = 100) {
    const list = Array.isArray(items) ? items : []
    const n = Number.isFinite(size) && size > 0 ? Math.floor(size) : 100
    const out = []
    for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
    return out
  }

  /**
   * 合并多批归类结果为一棵树。
   *
   * 问题：各批独立归类时，同一件事可能被不同批起了不同名字
   * （第一批叫"插件开发"，第二批叫"插件研发"），直接拼起来会很乱。
   *
   * 做法：调用方先用模型把各批的**大类名**归并成一张映射表，再传进来。
   * 没有映射表时原样保留（至少不会丢会话）。
   *
   * @param batchTrees - 每批的 `buildCategoryTree` 结果。
   * @param renameMap - 旧名 → 新名。
   * @returns 合并后的树。
   */
  function mergeBatchTrees(batchTrees, renameMap = null) {
    const trees = Array.isArray(batchTrees) ? batchTrees : []
    const rename = renameMap instanceof Map ? renameMap : new Map()

    const order = []
    const byCategory = new Map()

    for (const tree of trees) {
      for (const cat of Array.isArray(tree) ? tree : []) {
        const name = rename.get(cat.name) ?? cat.name

        if (!byCategory.has(name)) {
          byCategory.set(name, { name, count: 0, subOrder: [], subs: new Map() })
          order.push(name)
        }
        const target = byCategory.get(name)
        target.count += cat.count ?? 0

        for (const sub of cat.subcategories ?? []) {
          // 子类名也做同样的归一（各批可能给同一小组起了不同名字）
          const subName = rename.get(sub.name) ?? sub.name
          if (!target.subs.has(subName)) {
            target.subs.set(subName, { name: subName, sessions: [] })
            target.subOrder.push(subName)
          }
          target.subs.get(subName).sessions.push(...(sub.sessions ?? []))
        }
      }
    }

    return order.map(name => {
      const c = byCategory.get(name)
      return {
        name: c.name,
        count: c.count,
        subcategories: c.subOrder.map(s => c.subs.get(s)),
      }
    })
  }

  /**
   * 收集一批树里所有的大类 / 子类名（用于让模型做名称归一）。
   *
   * @param batchTrees - 各批的树。
   * @returns `{ categories, subs }` 去重后的名字数组。
   */
  function collectNames(batchTrees) {
    const categories = new Set()
    const subs = new Set()
    for (const tree of Array.isArray(batchTrees) ? batchTrees : []) {
      for (const cat of Array.isArray(tree) ? tree : []) {
        categories.add(cat.name)
        for (const sub of cat.subcategories ?? []) subs.add(sub.name)
      }
    }
    return { categories: [...categories], subs: [...subs] }
  }

  /**
   * 构造"名称归一"的提示词。
   *
   * 只让模型做一件事：把意思相同的名字合成一个。不要求它重新归类。
   *
   * @param names - 名字数组。
   * @param level - 'category' | 'sub'。
   * @returns `{ system, user }`。
   */
  function buildRenamePrompt(names, level) {
    const list = Array.isArray(names) ? names : []
    const what = level === 'sub' ? '子类名' : '大类名'
    const system = [
      `你在帮助合并${what}里的重复项。`,
      '有些名字意思相同但用词不同（例如"插件开发"与"插件研发"、"环境排障"与"环境与部署"）。',
      `请把每个名字映射到一个规范名。规范名要短（2-8 个字），并尽量复用已有名字。`,
      `只输出 JSON 数组，长度 ${list.length}，每个元素是字符串（该位置对应的规范名）。`,
      '不要解释。',
    ].join('\n')
    const body = list.map((n, i) => `${i + 1}. ${n}`).join('\n')
    return { system, user: `以下是 ${list.length} 个${what}：\n\n${body}\n\n请输出长度 ${list.length} 的字符串数组。` }
  }

  /**
   * 解析名称归一结果。
   *
   * @param text - 模型输出。
   * @param expected - 期望长度。
   * @returns Map<旧名, 新名> 或 null。
   */
  function parseRenameMap(text, expected, names) {
    const parsed = extractJsonArrayOfLength(text, expected)
    if (parsed === null) return null
    const list = Array.isArray(names) ? names : []
    if (list.length !== expected) return null

    const map = new Map()
    for (let i = 0; i < parsed.length; i += 1) {
      const next = typeof parsed[i] === 'string' ? parsed[i].trim() : ''
      if (next === '') return null
      map.set(list[i], next.slice(0, 24))
    }
    return map
  }

      return {
        CATEGORY_RANGE: CATEGORY_RANGE, looksAutomated: looksAutomated,
        filterTree: filterTree,
        extractJsonArray: extractJsonArray,
        extractJsonArrayOfLength: extractJsonArrayOfLength,
      }
    })()
    // ══ 会话归类生成段结束 ══

    // ── 格式化 ──────────────────────────────────────────────────────
    function fmtTokens(n) {
      var v = Number(n)
      if (!isFinite(v) || v <= 0) return '0'
      if (v < 1000) return String(Math.round(v))
      if (v < 1e6) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
      return (v / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
    }

    function fmtDuration(ms) {
      if (!isFinite(ms) || ms < 0) return '—'
      var total = Math.round(ms / 1000)
      if (total < 60) return total + 's'
      var m = Math.floor(total / 60)
      var s = total % 60
      if (m < 60) return s === 0 ? m + 'm' : m + 'm' + s + 's'
      return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
    }

    var END_LABEL = {
      completed: '完成', aborted: '中断', error: '出错', 'max-tokens': '超长',
      interrupted: '被打断', forked: '已分叉', blocked: '被阻止', open: '进行中',
    }
    var END_TONE = {
      completed: 'ok', open: 'ok', forked: 'ok',
      error: 'bad', 'max-tokens': 'warn', aborted: 'warn', interrupted: 'warn', blocked: 'warn',
    }

    /**
     * 泳道配色：走 theme.js 的专用分类色板，**不借状态色**。
     *
     * 上一版是 [accent, ok, warn, err, accent] 五色循环，而且前四个是语义色：
     * 第 1 条泳道是"主色"、第 2 条像"成功"、第 3 条像"警告"。精细化后有
     * 十几条泳道，颜色既重复又语义混乱——这就是"精细化后风格不一致"的来源。
     *
     * 现在交给 theme 的 10 色分类板。明暗由 themeMode 决定，它每次渲染都会
     * 从组件状态里取，避免"改了变量但没重渲染"的问题。
     */
    var themeMode = 'light'
    /** 当前图着色模式：'topic' | 'status'。每次渲染前由组件状态同步过来。 */
    var graphMode = 'topic'
    /** 状态内序号表（laneId → 该状态内的第几条），供状态色深浅变化用。 */
    var stateIndex = new Map()

    function trackColor(col) {
      return THEME.trackColorAt(col, themeMode)
    }

    /**
     * 泳道取色：按当前模式决定。
     *
     * 话题色：10 色分类板，区分"哪条线"
     * 状态色：同状态同色系、按该状态内序号做深浅变化，区分"健不健康"且仍可分辨
     */
    function laneStrokeColor(col, laneId) {
      if (graphMode !== 'status') return trackColor(col)
      var info = stateIndex.get(laneId)
      if (info === undefined) return GMODE.statusColor('todo', 0, themeMode)
      return GMODE.statusColor(info.state, info.index, themeMode)
    }
    /** 状态颜色。与泳道分类色分开取值——状态是语义，泳道是分类。 */
    var STATUS_COLOR = {
      todo: 'var(--tm-text3)',
      active: 'var(--tm-accent)',
      blocked: 'var(--tm-warn)',
      done: 'var(--tm-ok)',
    }

    function categoryTint(index) {
      var tint = THEME.stageTintAt(index < 0 ? 0 : index, themeMode, 100)
      return tint.color
    }

    /**
     * 大类配色。
     *
     * 与轨道色分开：轨道表达"这是第几条线"，大类表达"这几条属于同一件事"。
     * 混用一套颜色会让人分不清哪个层级在说话。
     */
    // ── Host 请求 ───────────────────────────────────────────────────
    function post(action, body, signal) {
      return fetch('api/topic-map/' + action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: signal,
      }).then(function (res) {
        if (!res.ok) throw new Error('topic-map HTTP ' + res.status)
        return res.json()
      }).then(function (payload) {
        if (payload === null || payload.ok !== true) {
          throw new Error((payload && payload.error) || 'topic-map 读取失败')
        }
        return payload.value
      })
    }

    // ── 几何 ────────────────────────────────────────────────────────
    /**
     * 把 Host 的 index/column 拓扑换成像素。
     *
     * 图的重点是**填满**可用空间：轮次少时把步长放大并居中，而不是画一小撮
     * 缩在左上角；轮次多时才退回紧凑步长。
     */
    /**
     * 把 Host 的 index/column 拓扑换成**内容坐标**。
     *
     * 关键变化：这里不再关心视口大小与缩放。图有一套自己的坐标系，视口只是
     * 用 `transform` 把它映射到屏幕上。这样滚轮缩放、拖拽平移都能在不重算
     * 任何几何的前提下完成——否则每一帧都要重排整张图。
     *
     * 步长与行高按"轮次多则紧凑、少则舒展"决定，是一组与视口无关的稳定值，
     * 因此同一会话在不同窗口尺寸下看起来是同一张图。
     *
     * @param graph - Host 给出的拓扑。
     * @returns `{ nodes, edges, labels, width, height, step, row, radius }`。
     */
    function layout(graph) {
      var n = graph.turnCount
      var cols = Math.max(1, graph.columnCount)

      // 左侧留给话题名的宽度。标签画在 [0, LABEL_GUTTER] 内，节点从
      // LABEL_GUTTER 之后开始，两边不会互相压。
      var LABEL_GUTTER = 190
      var PAD_X = LABEL_GUTTER + 28
      var PAD_Y = 64
      // 右侧给依赖弧线留的宽度。弧线要绕到节点之外，不留就会被内容框裁掉。
      var DEP_GUTTER = 64

      // 步长：轮次少时拉开以便阅读，多时收敛保证一屏可览。
      var step = n <= 1 ? 160 : Math.max(26, Math.min(120, 1600 / Math.max(1, n - 1)))
      // 行高：随行数收敛，目标"全图默认一屏装得下"。
      //
      // 上一版写的是 Math.max(96, ...)，等于行高永不低于 96px。精细化后
      // 有 15 条泳道就是 1472px 内容高，远超画布高度——于是纵向溢出、
      // 出现滚动条。这个下限是元凶。
      //
      // 现在按可用高度分配：目标总高约 860px（1080p 下画布的大致高度），
      // 行多就压行高，压到 40px 为止（再小节点就难点、标签也会挤）。
      // 真压不下去时交给缩放，而不是让画布溢出。
      var TARGET_ROWS_HEIGHT = 860
      var row = cols <= 1
        ? 120
        : Math.max(40, Math.min(190, TARGET_ROWS_HEIGHT / Math.max(1, cols - 1)))

      // 半径跟着行高走，但有下限：5.5px 是"仍能稳稳点中"的经验值。
      // 行高 40 时半径约 5.5，行高 190 时到 12。再小就只剩一个点，难点也难看清。
      var radius = Math.max(5.5, Math.min(12, Math.min(step / 9, row / 4.2)))

      function px(i) { return PAD_X + i * step }
      function py(c) { return PAD_Y + c * row }

      /**
       * laneId → 行号。相关性边只带 laneId，画线前要换成行号。
       * @param laneId - 泳道 id。
       * @returns 行号，或 null。
       */
      function colOfLane(laneId) {
        var cols = Array.isArray(graph.columns) ? graph.columns : []
        for (var ci = 0; ci < cols.length; ci += 1) {
          if (cols[ci].laneId === laneId) return cols[ci].col
        }
        return null
      }

      var nodes = graph.nodes.map(function (nd) {
        return {
          turn: nd.turn, index: nd.index, col: nd.col,
          laneId: nd.laneId, primary: nd.primary,
          x: px(nd.index), y: py(nd.col),
        }
      })

      var edges = []
      graph.edges.forEach(function (e) {
        if (e.kind === 'lane') {
          edges.push({
            kind: 'lane', col: e.col, gap: e.gap, laneId: e.laneId,
            // 主线标记：图上主线画粗、支线画细
            role: e.laneId === (graph.trunkLaneId ?? null) ? 'trunk' : 'branch',
            x1: px(e.from), y1: py(e.col), x2: px(e.to), y2: py(e.col),
          })
        } else if (e.kind === 'fork') {
          edges.push({
            kind: 'fork',
            x1: px(e.from), y1: py(e.fromCol), x2: px(e.to), y2: py(e.toCol),
          })
        } else if (e.kind === 'share') {
          edges.push({
            kind: 'share',
            x1: px(e.index), y1: py(e.fromCol), x2: px(e.index), y2: py(e.toCol),
          })
        } else if (e.kind === 'merge') {
          // 合并：从被吸收那条的行斜连回保留那条的行，方向与 fork 相反
          edges.push({
            kind: 'merge',
            laneId: e.laneId,
            absorbedLaneId: e.absorbedLaneId,
            x1: px(e.from), y1: py(e.fromCol), x2: px(e.to), y2: py(e.toCol),
          })
        } else if (e.kind === 'related') {
          // 相关性：两条内容相似但独立的话题线之间画一条淡虚线。
          //
          // 用横跨的线而不是竖线：相关性没有方向、没有具体位置，
          // 它表达的是"这两条整体上像"。画成贯穿的虚线最容易读。
          var colA = colOfLane(e.fromLaneId)
          var colB = colOfLane(e.toLaneId)
          if (colA === null || colB === null) return
          edges.push({
            kind: 'related',
            score: e.score,
            fromLaneId: e.fromLaneId,
            toLaneId: e.toLaneId,
            x1: PAD_X - 12, y1: py(colA),
            x2: px(Math.max(0, graph.turnCount - 1)), y2: py(colB),
          })
        }
      })

      // 话题名标在**轨道左端**，而不是末端。
      //
      // 末端标法有三个毛病，都实测过：同列多个话题的标签会重叠、需要垂直错开
      // 之后就偏离了对应节点、长会话里末端的标签会互相挤压。改到左端后，
      // 每条轨道在 x 起点只有一个标签位置，天然不重叠，也不会随内容漂移。
      var labels = graph.labels.map(function (lb) {
        return {
          laneId: lb.laneId, col: lb.col,
          x: 8, y: py(lb.col),
          text: lb.text, locked: lb.locked, turns: lb.turns,
          category: lb.category || null,
          categoryIndex: typeof lb.categoryIndex === 'number' ? lb.categoryIndex : -1,
          stageName: lb.stageName || null,
          workflowName: lb.workflowName || null,
        }
      })

      // 内容尺寸：节点决定右边界；标签在左侧，需要额外留出负方向的空间。
      var maxX = 0
      var maxY = 0
      nodes.forEach(function (nd) {
        if (nd.x > maxX) maxX = nd.x
        if (nd.y > maxY) maxY = nd.y
      })
      labels.forEach(function (lb) {
        if (lb.y > maxY) maxY = lb.y
      })

      return {
        step: step, row: row, radius: radius,
        nodes: nodes, edges: edges, labels: labels,
        // 左侧标签区的宽度：布局时按这个量把内容整体右移。
        labelGutter: LABEL_GUTTER,
        // 内容坐标系下的画布尺寸（含留白）。
        // 右侧额外留 DEP_GUTTER：依赖弧线要绕到节点之外，不留空间会被裁掉。
        width: Math.max(320, maxX + PAD_X + DEP_GUTTER),
        height: Math.max(200, maxY + PAD_Y),
      }
    }

    // ── 图 ──────────────────────────────────────────────────────────
    function Graph(props) {
      var L = props.layout
      var r = L.radius
      var hovered = props.hovered
      var selected = props.selected
      var highlightLane = props.highlightLane
      var selectedLane = props.selectedLane
      var byTurn = props.byTurn
      var onHover = props.onHover
      var onLeave = props.onLeave
      var onSelect = props.onSelect

      /**
       * 当前聚焦的泳道：点节点产生的 selectedLane 优先，其次才是左栏点的 highlightLane。
       *
       * 为什么点节点要优先：用户刚在图上点了某个点，他想看的肯定是"这条线"，
       * 而不是之前从左栏点出来的那条。两层聚焦同时存在时以后者为准会让人困惑。
       */
      var focusLaneId = selectedLane !== null && selectedLane !== undefined
        ? selectedLane
        : highlightLane

      // ── 阶段底色带 ──
      // 相邻行若属于同一阶段，画一条横跨整幅的背景带，让人一眼看出
      // "这几条线是一个阶段的"。这是三层结构在时间轴图上的主要体现。
      var bandEls = []
      var bands = []
      var sortedLabels = L.labels
        .filter(function (lb) { return lb.stageName !== null })
        .slice()
        .sort(function (a, b) { return a.y - b.y })
      sortedLabels.forEach(function (lb) {
        var last = bands.length > 0 ? bands[bands.length - 1] : null
        if (last !== null && last.name === lb.stageName && Math.abs(lb.y - last.endY) <= L.row * 1.5) {
          last.endY = lb.y
          last.count += 1
          return
        }
        bands.push({ name: lb.stageName, index: lb.categoryIndex, startY: lb.y, endY: lb.y, count: 1 })
      })
      bands.forEach(function (b, i) {
        if (b.count < 1) return
        var half = L.row * 0.42
        // 宽度取内容宽度：底色带要覆盖整幅图，而不是只覆盖视口那一屏。
        bandEls.push(h('rect', {
          key: 'band' + i,
          x: 0,
          y: b.startY - half,
          width: L.width,
          height: (b.endY - b.startY) + half * 2,
          fill: categoryTint(b.index < 0 ? 0 : b.index),
          // 阶段带是背景，必须淡：实心色块会盖住连线与节点。
          fillOpacity: themeMode === 'dark' ? 0.10 : 0.055,
          rx: 8,
          style: { pointerEvents: 'none' },
        }))
      })

      var edgeEls = []
      L.edges.forEach(function (e, i) {
        var color = laneStrokeColor(e.col === undefined ? 0 : e.col, e.laneId)
        // 聚焦某条泳道时，其余泳道的连线也变淡——只淡化节点会让图看起来割裂。
        var edgeDim = focusLaneId !== null && e.laneId !== undefined && e.laneId !== focusLaneId
        var edgeHot = focusLaneId !== null && e.laneId === focusLaneId
        if (e.kind === 'lane') {
          // 主线画粗、支线画细：一眼分出主干与分枝
          var isTrunk = e.role === 'trunk'
          var baseW = e.gap ? 1.6 : (isTrunk ? 3.2 : 2.1)
          edgeEls.push(h('line', {
            key: 'e' + i,
            x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2,
            stroke: color,
            // 聚焦的泳道线加粗、提亮：这是"整条线被选中"的主要视觉信号
            strokeWidth: edgeHot ? baseW * 1.45 + 0.6 : baseW,
            strokeOpacity: edgeDim ? 0.08 : (edgeHot ? 1 : (e.gap ? 0.32 : (isTrunk ? 0.85 : 0.62))),
            strokeLinecap: 'round',
            strokeDasharray: e.gap ? '4 5' : undefined,
          }))
        } else if (e.kind === 'fork') {
          var mx1 = e.x1 + (e.x2 - e.x1) * 0.42
          var mx2 = e.x1 + (e.x2 - e.x1) * 0.58
          edgeEls.push(h('path', {
            key: 'e' + i,
            d: 'M ' + e.x1 + ' ' + e.y1 +
               ' C ' + mx1 + ' ' + e.y1 + ', ' + mx2 + ' ' + e.y2 + ', ' + e.x2 + ' ' + e.y2,
            fill: 'none',
            stroke: color,
            strokeWidth: 2,
            strokeOpacity: 0.5,
            strokeLinecap: 'round',
          }))
        } else if (e.kind === 'merge') {
          // 合并：用一条较粗的弧线从被吸收的行弯回保留的行，
          // 末端加一个小箭头，读起来就是"这条线汇进了那条"。
          var mmx1 = e.x1 + (e.x2 - e.x1) * 0.42
          var mmx2 = e.x1 + (e.x2 - e.x1) * 0.58
          var mergeColor = laneStrokeColor(e.toCol, e.laneId)
          edgeEls.push(h('path', {
            key: 'e' + i,
            d: 'M ' + e.x1 + ' ' + e.y1 +
               ' C ' + mmx1 + ' ' + e.y1 + ', ' + mmx2 + ' ' + e.y2 + ', ' + e.x2 + ' ' + e.y2,
            fill: 'none',
            stroke: mergeColor,
            strokeWidth: 2.4,
            strokeOpacity: 0.85,
            strokeLinecap: 'round',
          }))
          // 汇合点的小圆环，明确"在这里并进来"
          edgeEls.push(h('circle', {
            key: 'em' + i,
            cx: e.x2, cy: e.y2, r: 4.5,
            fill: 'none',
            stroke: mergeColor,
            strokeWidth: 2,
            strokeOpacity: 0.9,
          }))
        } else if (e.kind === 'related') {
          // 相关性：贯穿的淡虚线，表示"这两条整体上像"。
          // 用最轻的视觉权重——它是提示，不是结构。
          var relDim = focusLaneId !== null
            && e.fromLaneId !== focusLaneId && e.toLaneId !== focusLaneId
          edgeEls.push(h('line', {
            key: 'e' + i,
            x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2,
            stroke: 'var(--tm-accent)',
            strokeWidth: 1,
            strokeOpacity: relDim ? 0.03 : (e.score !== undefined ? 0.16 + e.score * 0.2 : 0.22),
            strokeDasharray: '2 6',
            style: { pointerEvents: 'none' },
          }))
        } else {
          edgeEls.push(h('line', {
            key: 'e' + i,
            x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2,
            stroke: 'var(--tm-text3)',
            strokeWidth: 1.2,
            strokeOpacity: 0.6,
            strokeDasharray: '3 3',
          }))
        }
      })

      var nodeEls = []
      L.nodes.forEach(function (nd, i) {
        var fact = byTurn.get(nd.turn)
        var color = trackColor(nd.col)
        var reason = fact === undefined ? 'completed' : fact.endReason
        var hollow = reason === 'aborted' || reason === 'interrupted' || reason === 'blocked'
        var dim = focusLaneId !== null && nd.laneId !== focusLaneId
        var isHover = hovered === nd.turn
        var isSel = selected === nd.turn
        var inFocus = focusLaneId !== null && nd.laneId === focusLaneId

        // 邻接高亮：当前选中节点的前后各 1 个（同泳道）。
        // 目的是让"这一轮在上下文里的位置"可读——只看一个孤立的点，
        // 很难判断它前后接的是什么。
        var isNeighbor = false
        if (selected !== null && selected !== undefined && inFocus && !isSel) {
          var laneTurns = L.nodes
            .filter(function (x) { return x.laneId === nd.laneId })
            .map(function (x) { return x.turn })
            .sort(function (a, b) { return a - b })
          var at = laneTurns.indexOf(selected)
          if (at >= 0) {
            var prev = laneTurns[at - 1]
            var next2 = laneTurns[at + 1]
            isNeighbor = nd.turn === prev || nd.turn === next2
          }
        }

        // 半径：选中最大，邻接次之，聚焦泳道略放大
        var rad = nd.primary ? r : r * 0.78
        if (isSel) rad = rad * 1.5
        else if (isNeighbor) rad = rad * 1.22
        else if (inFocus) rad = rad * 1.08

        var attrs = {
          key: 'n' + i,
          cx: nd.x, cy: nd.y,
          r: rad,
          fill: hollow ? 'var(--tm-bg)' : color,
          stroke: hollow ? 'var(--tm-text3)' : 'var(--tm-bg)',
          strokeWidth: hollow ? 2.2 : 2,
          style: {
            cursor: 'pointer',
            opacity: dim ? 0.16 : 1,
            transition: 'opacity .14s ease',
          },
          onMouseEnter: function (t) { return function (ev) { onHover(t, ev) } }(nd.turn),
          onMouseLeave: onLeave,
          onClick: function (t) { return function (ev) { ev.stopPropagation(); onSelect(t) } }(nd.turn),
        }
        if (reason === 'error') attrs.fill = 'var(--tm-err)'
        if (reason === 'max-tokens') attrs.fill = 'var(--tm-warn)'
        nodeEls.push(h('circle', attrs))

        // 轮次编号：固定画在圆点右上方，偏移量恒定。
        //
        // 只放编号不放话题名，是因为一条轨道上有很多轮次，每轮都写名字会糊成
        // 一片；而编号短、位置固定，缩放后也不会互相压。名字在轨道左端，
        // 完整内容靠悬停。
        nodeEls.push(h('text', {
          key: 'tn' + i,
          x: nd.x,
          y: nd.y - (r + 4),
          textAnchor: 'middle',
          fill: dim ? 'var(--tm-text3)' : 'var(--tm-text2)',
          fontSize: Math.max(8, Math.min(10, r * 1.15)),
          fontWeight: isSel || isHover ? 700 : 400,
          style: {
            pointerEvents: 'none',
            userSelect: 'none',
            opacity: dim ? 0.3 : 1,
            transition: 'opacity .14s ease',
          },
        }, String(nd.turn)))

        if (isSel || isHover) {
          nodeEls.push(h('circle', {
            key: 'ring' + i,
            cx: nd.x, cy: nd.y,
            r: r + (isSel ? 7 : 5),
            fill: 'none',
            stroke: isSel ? 'var(--tm-accent)' : color,
            strokeWidth: isSel ? 2.2 : 1.4,
            strokeOpacity: isSel ? 0.95 : 0.5,
            style: { pointerEvents: 'none' },
          }))
        }
      })

      var LABEL_BOX = props.labelGutter || 190
      var labelEls = []
      L.labels.forEach(function (lb, i) {
        var dim = focusLaneId !== null && lb.laneId !== focusLaneId
        var hot = focusLaneId !== null && lb.laneId === focusLaneId
        var hasCat = lb.category !== null && lb.categoryIndex >= 0
        // 左端标签：上面一行是话题名（粗），下面一行是阶段/工作流（淡）。
        // 宽度固定为标签区宽度，超长截断——绝不越界压到节点上。
        var title = truncate(lb.text, 14)
        var sub = lb.stageName !== null
          ? truncate(lb.stageName + (lb.workflowName !== null && lb.workflowName !== lb.stageName ? ' · ' + lb.workflowName : ''), 16)
          : (lb.turns + ' 轮')
        labelEls.push(h('g', {
          key: 'lb' + i,
          style: { opacity: dim ? 0.2 : 1 },
        },
          // 聚焦泳道的标签加一条左侧强调竖条，与图上的加粗线呼应
          hot
            ? h('rect', {
                x: lb.x - 8, y: lb.y - 12,
                width: 2.5, height: 24, rx: 1.5,
                fill: trackColor(lb.col),
              })
            : null,
          hasCat
            ? h('rect', {
                x: lb.x - 6, y: lb.y - 13,
                width: LABEL_BOX - 12, height: 26, rx: 7,
                fill: categoryTint(lb.categoryIndex),
                // 标签底色比阶段带稍实一点，但仍然是"浅色标记"而非色块。
                fillOpacity: themeMode === 'dark' ? 0.20 : 0.13,
              })
            : null,
          h('text', {
            x: lb.x, y: lb.y - 3, dy: '0.34em',
            fill: trackColor(lb.col), fontSize: 11, fontWeight: 600,
            style: { userSelect: 'none' },
          }, title),
          h('text', {
            x: lb.x, y: lb.y + 10, dy: '0.34em',
            fill: 'var(--tm-text3)', fontSize: 9,
            style: { userSelect: 'none' },
          }, sub),
        ))
      })

      // 视口变换全部落在这一处 transform 上：内容坐标固定，缩放平移只改
      // translate/scale。这样滚轮与拖拽不需要重算任何几何。
      var v = props.view

      // ── 依赖连线 ──
      //
      // 画成从 A 行右端绕到 B 行左端的曲线：直接连两行之间会被中间的
      // 若干行挡住，看不出"从哪来、到哪去"。走外侧用贝塞尔绕行。
      //
      // 只画"两端都可见"的依赖：筛选时被隐藏的行不该留下断头线。
      var depEls = []
      if (Array.isArray(props.dependencies) && props.dependencies.length > 0) {
        var rowOfLane = new Map()
        L.labels.forEach(function (lb2) { rowOfLane.set(lb2.laneId, lb2.y) })
        // 每行最右的节点 x，作为连线起点
        var maxXOfLane = new Map()
        L.nodes.forEach(function (nd2) {
          var cur = maxXOfLane.get(nd2.laneId)
          if (cur === undefined || nd2.x > cur) maxXOfLane.set(nd2.laneId, nd2.x)
        })

        props.dependencies.forEach(function (dep, di) {
          var y1 = rowOfLane.get(dep.from)
          var y2 = rowOfLane.get(dep.to)
          if (y1 === undefined || y2 === undefined) return
          if (props.visibleLaneIds !== undefined
              && (!props.visibleLaneIds.has(dep.from) || !props.visibleLaneIds.has(dep.to))) return

          var x1 = (maxXOfLane.get(dep.from) ?? L.width - 40) + 14
          var x2 = L.width - 14
          // 往外绕：控制点推到右边界之外一点，形成明显的弧
          var bulge = x2 + 26
          var d = 'M ' + x1 + ' ' + y1 + ' C ' + bulge + ' ' + y1 + ', ' + bulge + ' ' + y2 + ', ' + x2 + ' ' + y2

          depEls.push(h('path', {
            key: 'dep' + di,
            d: d,
            fill: 'none',
            stroke: dep.kind === 'failure' ? 'var(--tm-warn)' : 'var(--tm-text3)',
            strokeWidth: dep.kind === 'failure' ? 1.5 : 1.1,
            strokeOpacity: 0.5,
            strokeDasharray: dep.kind === 'failure' ? undefined : '3 4',
            style: { pointerEvents: 'none' },
          }))
          // 箭头：只想表达方向，不必精确
          depEls.push(h('circle', {
            key: 'depd' + di,
            cx: x2, cy: y2, r: 2.4,
            fill: dep.kind === 'failure' ? 'var(--tm-warn)' : 'var(--tm-text3)',
            fillOpacity: 0.6,
            style: { pointerEvents: 'none' },
          }))
        })
      }

      return h('svg', {
        className: 'dsh_tm_svg',
        width: props.viewW,
        height: props.viewH,
        viewBox: '0 0 ' + props.viewW + ' ' + props.viewH,
        preserveAspectRatio: 'xMidYMid meet',
      }, h('g', {
        transform: 'translate(' + v.offsetX + ',' + v.offsetY + ') scale(' + v.scale + ')',
      // 底色带最底，然后依赖、连线、标签、节点。
      }, bandEls, depEls, edgeEls, labelEls, nodeEls))
    }

    function truncate(text, n) {
      var s = String(text || '')
      return s.length > n ? s.slice(0, n - 1) + '…' : s
    }

    /**
     * 语义分段预览条。
     *
     * 模型结果一律先展示再确认：它可能把图改坏，而用户无从预料。这里把
     * "会变成几条泳道""问了几次""哪些判定不确定"都摆出来，让人能判断要不要采纳。
     */
    function SemanticPreview(props) {
      var r = props.result
      if (r === null || r === undefined) return null

      if (r.status === 'unavailable') {
        return h('div', { className: 'dsh_tm_sembar' },
          h('span', { className: 'dsh_tm_semtitle' }, '语义分段不可用'),
          h('span', { className: 'dsh_tm_semnote' }, r.reason || '未知原因'),
          h('span', { className: 'dsh_tm_grow' }),
          h('button', { type: 'button', className: 'dsh_tm_diagclose', onClick: props.onClose }, '关闭'),
        )
      }

      var partial = r.status === 'partial'
      var failed = Array.isArray(r.failures) ? r.failures.length : 0
      var changed = r.lanesBefore !== r.lanesAfter

      // 三层树预览：阶段 → 工作流 → 任务。
      //
      // 预览必须显示层级，否则用户只看得到一串任务，无从判断"是不是归对了"。
      // 没有 stages 时才退回平铺的任务列表（本地规则的结果）。
      var treeEls = []
      if (Array.isArray(r.stages) && r.stages.length > 0) {
        r.stages.forEach(function (stage, si) {
          treeEls.push(h('div', { key: 'pv' + si, className: 'dsh_tm_pvstage' },
            h('div', { className: 'dsh_tm_pvstagerow' },
              h('span', { className: 'dsh_tm_semswatch', style: { background: trackColor(si) } }),
              h('span', { className: 'dsh_tm_pvstagename' }, stage.name),
              h('span', { className: 'dsh_tm_pvturns' },
                (stage.turns || []).length + ' 轮'),
            ),
            (stage.workflows || []).map(function (wf, wi) {
              var flat = wf.collapsed === true
              return h('div', { key: 'pv' + si + 'w' + wi, className: 'dsh_tm_pvwf' },
                flat ? null : h('div', { className: 'dsh_tm_pvwfname' }, wf.name),
                (wf.tasks || []).map(function (t, ti) {
                  return h('div', { key: 'pv' + si + 'w' + wi + 't' + ti, className: 'dsh_tm_pvtask' },
                    h('span', { className: 'dsh_tm_pvtaskname', title: t.name },
                      (t.turns && t.turns.length > 0 ? 'T' + t.turns[0] + ' ' : '') + t.name),
                    h('span', { className: 'dsh_tm_pvturns' },
                      (t.turns || []).length + ' 轮'),
                  )
                }),
              )
            }),
          ))
        })
      } else {
        // 无层级：平铺任务
        var flatBands = []
        if (Array.isArray(r.lanes)) {
          r.lanes.forEach(function (lane, li) {
            if (!Array.isArray(lane.turns) || lane.turns.length === 0) return
            flatBands.push({
              key: lane.laneId || ('s' + li),
              title: lane.title || '未命名',
              turns: lane.turns,
              color: trackColor(li),
            })
          })
        }
        treeEls = flatBands.map(function (b) {
          return h('div', { key: b.key, className: 'dsh_tm_pvtask' },
            h('span', { className: 'dsh_tm_semswatch', style: { background: b.color } }),
            h('span', { className: 'dsh_tm_pvtaskname' }, b.title),
            h('span', { className: 'dsh_tm_pvturns' }, b.turns.length + ' 轮'),
          )
        })
      }

      return h('div', { className: 'dsh_tm_sembar' },
        h('div', { className: 'dsh_tm_semrow' },
          h('span', { className: 'dsh_tm_semtitle' }, '语义分段预览'),
          // 通道来源必须显式可见：用户要能分辨"自定义端点生效"和"其实回退了"。
          h('span', {
            className: 'dsh_tm_chan',
            'data-fallback': r.fellBack === true ? '1' : undefined,
            title: r.fellBack === true
              ? ('自定义端点失败，已回退会话模型：' + (r.fallbackReason || ''))
              : (r.via === 'custom' ? '使用自定义端点' : '使用会话模型'),
          }, r.fellBack === true ? '已回退' : (r.via === 'custom' ? '自定义端点' : '会话模型')),
          h('span', { className: 'dsh_tm_semnote' },
            (r.provider || '?') + '/' + (r.model || '?')),
          h('span', { className: 'dsh_tm_semnote' },
            String(r.lanesBefore), ' → ',
            h('b', { 'data-changed': changed ? '' : undefined }, String(r.lanesAfter)), ' 条话题'),
          partial
            ? h('span', { className: 'dsh_tm_semwarn' }, failed + ' 个边界未判定')
            : null,
          r.applyError ? h('span', { className: 'dsh_tm_semwarn' }, '采纳失败：' + r.applyError) : null,
          h('span', { className: 'dsh_tm_grow' }),
          h('button', { type: 'button', className: 'dsh_tm_semapply', onClick: props.onApply }, '采纳'),
          h('button', { type: 'button', className: 'dsh_tm_diagclose', onClick: props.onRetry }, '重试'),
          h('button', { type: 'button', className: 'dsh_tm_diagclose', onClick: props.onClose }, '×'),
        ),
        // 层级一览：阶段 → 工作流 → 任务，让人判断"归对了没"。
        treeEls.length > 0
          ? h('div', { className: 'dsh_tm_sembands' }, treeEls)
          : null,
      )
    }

    /**
     * 分段设置：模型与轮次上限。
     *
     * 做成面板内的轻量弹出层而不是 Settings 页的一节：这两个值只影响
     * 「精化分段」这一个动作，放在它旁边最直接，也省掉一次跨插槽接线。
     */
    /**
     * 分析进度条：三阶段分步显示。
     *
     * 为什么分步而不是百分比：三次调用的耗时差别很大（第一次要读全部轮次，
     * 第三次只需归并少量名字），任何百分比都是编的。而"正在做第 2 步"
     * 是事实，用户能据此判断还要不要等。
     */
    function ProgressBar(props) {
      var p = props.progress
      if (p === null || p === undefined) return null

      var elapsed = Math.max(0, Math.round((p.elapsedMs || 0) / 1000))
      var stale = p.stale === true

      return h('div', { className: 'dsh_tm_prog' },
        h('div', { className: 'dsh_tm_progrow' },
          h('span', { className: 'dsh_tm_progtitle' },
            p.active ? '正在分析' : (p.status === 'done' ? '分析完成' : '分析结束')),
          h('span', { className: 'dsh_tm_progtime' }, elapsed + 's'),
          stale ? h('span', { className: 'dsh_tm_semwarn' }, '可能已卡住') : null,
          p.error ? h('span', { className: 'dsh_tm_semwarn' }, String(p.error).slice(0, 40)) : null,
          h('span', { className: 'dsh_tm_grow' }),
          h('button', {
            type: 'button', className: 'dsh_tm_diagclose',
            onClick: props.onDismiss,
          }, '×'),
        ),
        h('div', { className: 'dsh_tm_steps' },
          (p.steps || []).map(function (s, i) {
            var mark = s.state === 'done' ? '✓'
              : s.state === 'active' ? '●'
              : s.state === 'failed' ? '✕'
              : String(i + 1)
            return h('div', {
              key: s.id,
              className: 'dsh_tm_step',
              'data-state': s.state,
              title: s.detail,
            },
              h('span', { className: 'dsh_tm_stepmark' }, mark),
              h('span', { className: 'dsh_tm_steplabel' }, s.label),
            )
          }),
        ),
      )
    }

    /**
     * 筛选条：搜索框常驻，点多出来的漏斗展开高级条件。
     *
     * 搜索框常驻而不是收在弹层里：按关键词找一条话题是最常用的动作，
     * 每次都要展开太啰嗦。阶段/状态/轮次这些不常用，收起来避免长期占用
     * 纵向空间。
     */
    /**
     * 上层：工作区会话树（大类 → 子类 → 会话）。
     *
     * 这是"跨会话"的入口。下层仍然是单会话的话题图，两者是主从关系：
     * 在上层点一个会话，下层就显示它的话题图。
     *
     * 为什么要分两层而不是把 100 多个会话铺在一张图上：实测某工作区
     * 33 个会话里有大量 1-2 轮的短会话，全铺开既看不清也没有关系可画。
     * 列表 + 详情是这类数据的自然形态。
     */
    function SessionTree(props) {
      var state = props.state
      if (state === null || state === undefined) return null

      var workspaces = state.workspaces ?? []
      var tree = state.tree ?? []
      var current = state.currentSessionId

      var head = h('div', { className: 'dsh_tm_sthead' },
        h('select', {
          className: 'dsh_tm_stws',
          value: state.workspaceId ?? '',
          title: '切换工作区',
          onChange: function (ev) { props.onWorkspace(ev.target.value) },
        },
          workspaces.map(function (w) {
            return h('option', { key: w.id, value: w.id },
              w.title + '（' + w.sessionCount + '）')
          }),
        ),
        h('span', { className: 'dsh_tm_stcount' },
          tree.length > 0 ? (state.total + ' 会话 / ' + tree.length + ' 类') : ''),
        h('span', { className: 'dsh_tm_grow' }),
        // 手动刷新：新的会话可能是在别处产生的，列表不会自己知道
        h('button', {
          type: 'button', className: 'dsh_tm_stbtn',
          title: '重新读取会话列表（含在别处新建的会话）',
          onClick: props.onRefresh,
          disabled: state.loading,
        }, state.loading ? '…' : '⟳'),
        h('button', {
          type: 'button', className: 'dsh_tm_stbtn',
          'data-on': state.busy ? '1' : undefined,
          title: state.tree.length > 0 ? '重新归类' : '让模型把会话归成大类',
          onClick: props.onCategorize,
          disabled: state.busy,
        }, state.busy ? '…' : '归类'),
      )

      // 跨会话全文检索框。
      //
      // 与左栏那个搜索框分工明确：
      //   这里 = 搜**整个工作区**的会话（标题 + 全部轮次正文）
      //   左栏 = 只筛**当前会话**里的话题/阶段/任务
      // 两个框语义不同，所以分开放、各自有说明，避免"一个框两套行为"的歧义。
      var findBox = h('div', { className: 'dsh_tm_findbox' },
        h('input', {
          className: 'dsh_tm_findinput',
          type: 'search',
          placeholder: '搜整个工作区（标题 + 对话内容）…',
          title: '跨会话检索：搜所有会话的标题与轮次正文',
          value: props.findQuery ?? '',
          onInput: function (ev) { props.onFindInput(ev.target.value) },
        }),
        h('span', { className: 'dsh_tm_findhint' }, props.findHint ?? ''),
      )

      var body = []
      if (state.loading) {
        body.push(h('div', { key: 'ld', className: 'dsh_tm_stempty' }, '正在读取会话…'))
      } else if (tree.length === 0) {
        body.push(h('div', { key: 'nn', className: 'dsh_tm_stempty' },
          '还没有归类。点右上「归类」让模型把会话分成大类。'))
      } else {
        tree.forEach(function (cat) {
          var catKey = 'c:' + cat.name
          var catOpen = state.folded[catKey] !== true
          body.push(h('div', { key: catKey, className: 'dsh_tm_stcat' },
            h('button', {
              type: 'button', className: 'dsh_tm_stcathd',
              onClick: function () { props.onToggleFold(catKey) },
            },
              h('span', { className: 'dsh_tm_caret' }, catOpen ? '▾' : '▸'),
              h('span', { className: 'dsh_tm_stcatname' }, cat.name),
              h('span', { className: 'dsh_tm_stnum' }, String(cat.count)),
            ),
            catOpen
              ? (cat.subcategories ?? []).map(function (sub) {
                  var subKey = catKey + ':s:' + sub.name
                  var subOpen = state.folded[subKey] !== true
                  return h('div', { key: subKey },
                    h('button', {
                      type: 'button', className: 'dsh_tm_stsubhd',
                      onClick: function () { props.onToggleFold(subKey) },
                    },
                      h('span', { className: 'dsh_tm_caret' }, subOpen ? '▾' : '▸'),
                      h('span', { className: 'dsh_tm_stsubname' }, sub.name),
                      h('span', { className: 'dsh_tm_stnum' }, String(sub.sessions.length)),
                    ),
                    subOpen
                      ? sub.sessions.map(function (s) {
                          return h('button', {
                            key: s.sessionId,
                            type: 'button',
                            className: 'dsh_tm_stsess',
                            'data-on': s.sessionId === current ? '1' : undefined,
                            'data-auto': s.automated ? '1' : undefined,
                            title: s.title + (s.automated ? '（自动会话）' : ''),
                            onClick: function () { props.onOpenSession(s.sessionId) },
                          },
                            h('span', {
                              className: 'dsh_tm_stdot',
                              'data-auto': s.automated ? '1' : undefined,
                            }),
                            h('span', { className: 'dsh_tm_stsessname' }, s.title),
                            s.turns !== null
                              ? h('span', { className: 'dsh_tm_stturns' }, s.turns + '轮')
                              : null,
                          )
                        })
                      : null,
                  )
                })
              : null,
          ))
        })
      }

      return h('div', { className: 'dsh_tm_st' }, head, findBox, h('div', { className: 'dsh_tm_stbody' }, body))
    }

    /**
     * 跨会话检索结果列表。
     */
    function SearchResults(props) {
      var hits = props.hits
      if (hits === null || hits === undefined) return null
      if (hits.length === 0) {
        return h('div', { className: 'dsh_tm_findnone' }, '没有找到匹配的会话')
      }
      return h('div', { className: 'dsh_tm_findlist' },
        hits.map(function (h2, i) {
          return h('button', {
            key: 'hit' + i,
            type: 'button',
            className: 'dsh_tm_finditem',
            title: h2.snippet,
            onClick: function () { props.onOpen(h2.sessionId, h2.turn) },
          },
            h('span', { className: 'dsh_tm_findtitle' }, h2.title),
            h('span', { className: 'dsh_tm_findwhere' },
              h2.turn !== null && h2.turn !== undefined
                ? 'T' + h2.turn
                : (h2.type === 'title' ? '标题' : '')),
            h('span', { className: 'dsh_tm_findsnip' }, h2.snippet),
          )
        }),
      )
    }

    function FilterBar(props) {
      var filter = props.filter
      var stages = props.stages
      var open = props.open
      var counts = props.counts
      var onChange = props.onChange
      var onOpenChange = props.onOpenChange
      var onClear = props.onClear
      var onToggleInList = props.onToggleInList

      var active = !FILTER.isFilterEmpty(filter)

      return h('div', { className: 'dsh_tm_filter' },
        h('div', { className: 'dsh_tm_filterrow' },
          h('span', { className: 'dsh_tm_ficon' }, '⌕'),
          h('input', {
            className: 'dsh_tm_finput',
            type: 'text',
            value: filter.query,
            // 明确写"仅当前会话"：之前这里和跨会话检索共用一个框，
            // 用户看不出区别，是歧义的来源。
            placeholder: '筛当前会话（话题/阶段/任务/对话）…',
            title: '只在当前会话里筛选话题、阶段、工作流、任务与轮次内容',
            onChange: function (ev) { onChange({ query: ev.target.value }) },
            // Esc 清空输入，符合搜索框的一般习惯
            onKeyDown: function (ev) {
              if (ev.key === 'Escape') { ev.stopPropagation(); onChange({ query: '' }) }
            },
          }),
          filter.query !== ''
            ? h('button', {
                type: 'button', className: 'dsh_tm_fx',
                title: '清空搜索',
                onClick: function () { onChange({ query: '' }) },
              }, '×')
            : null,
          h('button', {
            type: 'button',
            className: 'dsh_tm_fmore',
            'data-on': open ? '1' : undefined,
            'data-active': active && !open ? '1' : undefined,
            title: '更多筛选条件',
            onClick: function () { onOpenChange(!open) },
          }, '⚙'),
          active
            ? h('span', { className: 'dsh_tm_fcount' },
                counts.visible + '/' + counts.total)
            : null,
        ),

        open
          ? h('div', { className: 'dsh_tm_fpanel' },
              h('div', { className: 'dsh_tm_fgroup' },
                h('div', { className: 'dsh_tm_flabel' }, '阶段'),
                stages.length === 0
                  ? h('span', { className: 'dsh_tm_fnone' }, '（当前为平铺结构，无阶段）')
                  : h('div', { className: 'dsh_tm_fchips' },
                      stages.map(function (name) {
                        var on = filter.stages.indexOf(name) >= 0
                        return h('button', {
                          key: 'st' + name,
                          type: 'button',
                          className: 'dsh_tm_chip',
                          'data-on': on ? '1' : undefined,
                          onClick: function () { onToggleInList('stages', name) },
                        }, name)
                      }),
                    ),
              ),
              h('div', { className: 'dsh_tm_fgroup' },
                h('div', { className: 'dsh_tm_flabel' }, '状态'),
                h('div', { className: 'dsh_tm_fchips' },
                  FILTER.STATE_BUCKETS.map(function (name) {
                    var on = filter.states.indexOf(name) >= 0
                    return h('button', {
                      key: 'sb' + name,
                      type: 'button',
                      className: 'dsh_tm_chip',
                      'data-on': on ? '1' : undefined,
                      onClick: function () { onToggleInList('states', name) },
                    }, name)
                  }),
                ),
              ),
              h('div', { className: 'dsh_tm_fgroup' },
                h('div', { className: 'dsh_tm_flabel' }, '轮次数'),
                h('div', { className: 'dsh_tm_frange' },
                  h('input', {
                    className: 'dsh_tm_fnum', type: 'number', min: 1, placeholder: '最少',
                    value: filter.minTurns === null ? '' : filter.minTurns,
                    onChange: function (ev) {
                      var v = ev.target.value.trim()
                      onChange({ minTurns: v === '' ? null : Math.max(1, Number(v)) })
                    },
                  }),
                  h('span', { className: 'dsh_tm_fdash' }, '–'),
                  h('input', {
                    className: 'dsh_tm_fnum', type: 'number', min: 1, placeholder: '最多',
                    value: filter.maxTurns === null ? '' : filter.maxTurns,
                    onChange: function (ev) {
                      var v = ev.target.value.trim()
                      onChange({ maxTurns: v === '' ? null : Math.max(1, Number(v)) })
                    },
                  }),
                ),
              ),
              active
                ? h('button', {
                    type: 'button', className: 'dsh_tm_fclear',
                    onClick: onClear,
                  }, '清除全部条件')
                : null,
            )
          : null,
      )
    }

    function SettingsPopover(props) {
      var cfg = props.config
      var onSave = props.onSave
      var onClose = props.onClose
      var pState = useState(cfg === null ? '' : cfg.provider)
      var mState = useState(cfg === null ? '' : cfg.model)
      var lState = useState(cfg === null ? 60 : cfg.turnLimit)
      var urlState = useState(cfg === null ? '' : (cfg.baseUrl || ''))
      var keyState = useState(cfg === null ? '' : (cfg.apiKey || ''))
      var nameState = useState(cfg === null ? '' : (cfg.modelName || ''))
      var showKeyState = useState(false)
      var showKey = showKeyState[0]; var setShowKey = showKeyState[1]

      var customOn = nameState[0].trim() !== '' && urlState[0].trim() !== ''

      return h('div', { className: 'dsh_tm_pop' },
        h('div', { className: 'dsh_tm_poptitle' }, '语义分段设置'),

        // ── 区块一：跟随会话模型 ──
        h('div', { className: 'dsh_tm_popsec' }, '会话模型（留空即自动跟随）'),
        h('label', { className: 'dsh_tm_field' },
          h('span', null, 'provider'),
          h('input', {
            className: 'dsh_tm_input',
            value: pState[0],
            placeholder: '自动跟随当前会话',
            onChange: function (ev) { pState[1](ev.target.value) },
          }),
        ),
        h('label', { className: 'dsh_tm_field' },
          h('span', null, '模型 id'),
          h('input', {
            className: 'dsh_tm_input',
            value: mState[0],
            placeholder: '自动跟随当前会话',
            onChange: function (ev) { mState[1](ev.target.value) },
          }),
        ),

        // ── 区块二：自定义端点 ──
        h('div', { className: 'dsh_tm_popsec' }, '自定义端点（可选，优先使用）'),
        h('label', { className: 'dsh_tm_field' },
          h('span', null, 'base_url'),
          h('input', {
            className: 'dsh_tm_input',
            value: urlState[0],
            placeholder: 'https://api.example.com 或 …/v1',
            onChange: function (ev) { urlState[1](ev.target.value) },
          }),
        ),
        h('label', { className: 'dsh_tm_field' },
          h('span', null, 'api_key'),
          h('div', { className: 'dsh_tm_keyrow' },
            h('input', {
              className: 'dsh_tm_input',
              type: showKey ? 'text' : 'password',
              value: keyState[0],
              placeholder: 'sk-…',
              onChange: function (ev) { keyState[1](ev.target.value) },
            }),
            h('button', {
              type: 'button', className: 'dsh_tm_keyeye',
              title: showKey ? '隐藏' : '显示',
              onClick: function () { setShowKey(!showKey) },
            }, showKey ? '◉' : '◎'),
          ),
        ),
        h('label', { className: 'dsh_tm_field' },
          h('span', null, 'model_name'),
          h('input', {
            className: 'dsh_tm_input',
            value: nameState[0],
            placeholder: 'gpt-4o-mini / qwen-max / …',
            onChange: function (ev) { nameState[1](ev.target.value) },
          }),
        ),
        h('div', { className: 'dsh_tm_popwarn' },
          '⚠ api_key 以明文保存在本地配置文件，任何能读该文件的人都能看到。'),

        h('label', { className: 'dsh_tm_field' },
          h('span', null, '分析轮次上限'),
          h('input', {
            className: 'dsh_tm_input', type: 'number', min: 5, max: 500,
            value: lState[0],
            onChange: function (ev) { lState[1](ev.target.value) },
          }),
        ),
        h('div', { className: 'dsh_tm_popnote' },
          customOn
            ? 'base_url 与 model_name 都已填，将优先使用自定义端点；调用失败会自动回退到会话模型。'
            : '自定义端点需要 base_url 与 model_name 同时填写才生效。'),

        h('div', { className: 'dsh_tm_popacts' },
          h('button', {
            type: 'button', className: 'dsh_tm_semapply',
            onClick: function () {
              var limit = Number(lState[0])
              onSave({
                provider: pState[0].trim(),
                model: mState[0].trim(),
                baseUrl: urlState[0].trim(),
                apiKey: keyState[0].trim(),
                modelName: nameState[0].trim(),
                turnLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 60,
              })
            },
          }, '保存'),
          h('button', { type: 'button', className: 'dsh_tm_diagclose', onClick: onClose }, '取消'),
        ),
      )
    }

    /**
     * 底部缩略条：显示全局结构、当前视口，且可点击/拖动定位。
     *
     * 它必须真的画出内容，否则只是个空框子——放大后失去方位感时，用户需要
     * 看到"整张图长什么样、我在哪一段"。
     */
    function Overview(props) {
      var content = props.content
      var view = props.view
      var viewport = props.viewport
      var L = props.layout
      var onSeek = props.onSeek
      var range = VIEWPORT.overviewRange(content, view, viewport)
      var ref = useRef(null)

      function seekFromEvent(ev) {
        var el = ref.current
        if (el === null) return
        var box = el.getBoundingClientRect()
        if (box.width <= 0) return
        var ratio = (ev.clientX - box.left) / box.width
        onSeek(ratio)
      }

      // 内容归一化到缩略条的坐标（百分比），保证与真实图同构。
      var w = Math.max(1, content.width)
      var hgt = Math.max(1, content.height)
      var marks = []
      if (L !== null) {
        // 轨道线：每条泳道画一条极淡的底纹，能看出有几条线。
        var cols = []
        var seen = {}
        L.nodes.forEach(function (n) {
          if (seen[n.col] === true) return
          seen[n.col] = true
          cols.push(n.col)
        })
        cols.forEach(function (col) {
          var y = null
          L.nodes.forEach(function (n) { if (n.col === col && y === null) y = n.y })
          if (y === null) return
          marks.push(h('div', {
            key: 'ovl' + col,
            className: 'dsh_tm_ovline',
            style: { top: (y / hgt * 100) + '%', background: trackColor(col) },
          }))
        })
        // 节点：每个 turn 一个点，密度直接反映"哪一段聊得多"。
        L.nodes.forEach(function (n, i) {
          marks.push(h('div', {
            key: 'ovd' + i,
            className: 'dsh_tm_ovdot',
            style: {
              left: (n.x / w * 100) + '%',
              top: (n.y / hgt * 100) + '%',
              background: trackColor(n.col),
            },
          }))
        })
      }

      return h('div', {
        className: 'dsh_tm_overview',
        ref: ref,
        title: '拖动这里可以快速移动视图',
        onPointerDown: function (ev) {
          try { ev.currentTarget.setPointerCapture(ev.pointerId) } catch (e) { /* 忽略 */ }
          seekFromEvent(ev)
          props.onDragStart()
        },
        onPointerMove: function (ev) {
          if (props.dragging) seekFromEvent(ev)
        },
        onPointerUp: function (ev) {
          try { ev.currentTarget.releasePointerCapture(ev.pointerId) } catch (e) { /* 忽略 */ }
          props.onDragEnd()
        },
      },
        marks,
        h('div', {
          className: 'dsh_tm_overview_window',
          style: {
            left: (range.start * 100) + '%',
            width: Math.max(2, (range.end - range.start) * 100) + '%',
          },
        }),
      )
    }

    function HoverTip(props) {
      var fact = props.fact
      if (fact === null) return null
      var pos = props.pos || { x: 0, y: 0 }
      var style = {
        left: Math.min(pos.x + 16, Math.max(10, window.innerWidth - 316)) + 'px',
        top: Math.min(Math.max(10, pos.y - 12), Math.max(10, window.innerHeight - 220)) + 'px',
      }
      return h('div', { className: 'dsh_tm_tip', style: style },
        h('div', { className: 'dsh_tm_tiphead' },
          h('span', { className: 'dsh_tm_pill', 'data-tone': END_TONE[fact.endReason] || undefined },
            'T' + fact.turn + ' · ' + (END_LABEL[fact.endReason] || fact.endReason)),
          fact.steering > 0 ? h('span', null, '插话 ' + fact.steering) : null,
        ),
        h('div', { className: 'dsh_tm_tipprompt' }, fact.prompt || '（无文本）'),
        h('div', { className: 'dsh_tm_tiprow' }, h('span', null, '输入'), h('b', null, fmtTokens(fact.usage.input))),
        h('div', { className: 'dsh_tm_tiprow' }, h('span', null, '命中'), h('b', null, fmtTokens(fact.usage.cacheRead))),
        h('div', { className: 'dsh_tm_tiprow' }, h('span', null, '输出'), h('b', null, fmtTokens(fact.usage.output))),
        h('div', { className: 'dsh_tm_tiprow' }, h('span', null, '耗时'), h('b', null, fmtDuration(fact.durationMs))),
        h('div', { className: 'dsh_tm_tiprow' }, h('span', null, '工具'), h('b', null, String(fact.toolCalls))),
      )
    }

    /**
     * 在渲染期间把最新值写进 ref。
     *
     * 事件回调里读 ref 而不是闭包变量，才能在异步流程（loadThrough → 重渲染
     * → 重试）中看到更新后的映射。直接赋值不合规（渲染期间不应产生副作用），
     * 但写 ref 是 React 官方认可的模式，不会触发额外渲染。
     */
    function effectAssign(ref, value) {
      ref.current = value
    }

    /** 最近一次跳转的完整记录；诊断按钮读取它。 */
    var JUMP_TRACE = null

    function cell(k, v) {
      return h('div', { className: 'dsh_tm_cell' },
        h('div', { className: 'dsh_tm_cellk' }, k),
        h('div', { className: 'dsh_tm_cellv' }, v))
    }

    // ── 跳转 ────────────────────────────────────────────────────────
    /**
     * 在对话 DOM 里找到一个 turn 对应的行。
     *
     * 官方 `ChatViewport.scrollToTurn` 的做法是：
     *   turns.find(t => t.turn === turn) → anchor(anchorKey, 'node') → align()
     * 而 `anchor(key, 'node')` 优先匹配 **`data-chat-anchor-key`**，找不到再退回
     * **`data-chat-node-key`**。两者是不同的属性，只查前者会漏掉一批行。
     *
     * 这里按同样的优先级实现，并把隐藏行排除掉（折叠起来的 Turn 其行
     * `hidden` 或高度为 0，滚过去等于滚到空白）。
     *
     * @param anchorKey - 该轮在 Chat 快照里的锚点 key。
     * @param scrollEl - 滚动容器（缺省时退回 document）。
     * @returns 命中的元素，或 null。
     */
    function findTurnRow(anchorKey, scrollEl) {
      if (typeof document === 'undefined' || !anchorKey) return null
      var root = scrollEl || document
      var rows = root.querySelectorAll('[data-chat-anchor-key],[data-chat-node-key]')
      var byNodeKey = null
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i]
        if (row.hasAttribute('hidden') || row.closest('[hidden]') !== null) continue
        var anchor = row.getAttribute('data-chat-anchor-key')
        if (anchor === anchorKey) return row
        if (byNodeKey === null && row.getAttribute('data-chat-node-key') === anchorKey) {
          byNodeKey = row
        }
      }
      return byNodeKey
    }

    /**
     * 按 turn 号直接找行。
     *
     * Chat 的每一行带 `data-chat-turn`，这是**自足**的定位依据：不需要 Chat 快照、
     * 不需要 anchorKey。官方 `scrollToTurnAtOrAfter` 也用它做兜底。
     *
     * 这一点很关键：跳到对话后本面板会被卸载，`useChat` 随之停止，
     * 任何依赖快照的映射都会冻结。所以主路径必须只依赖 DOM。
     *
     * @param turnNo - 目标轮次。
     * @param scrollEl - 滚动容器。
     * @returns 命中的元素，或 null。
     */
    /**
     * 该行顶部距离 scrollport 顶端的留白（像素）。
     *
     * 取一个很小的值而不是"视口高度的某个百分比"：
     *
     * - 百分比会随窗口高度放大误差，窗口越高、目标越往下偏；
     * - 22% 对应"目标落在屏幕上方四分之一处"，读起来正是"停在中间"的观感。
     *
     * 顶部留一点缝是为了不贴着容器边框，而不是为了把目标往下推。
     */
    var REVEAL_TOP_PAD = 8

    /**
     * 找某一轮里"用户输入"那一行。
     *
     * 一轮在 DOM 里有多行（用户消息、过程、助手回复、轮尾动作条），
     * `querySelectorAll` 只会返回**第一个**匹配，那未必是用户输入所在行。
     * 跳转的语义是"从这一轮的开头读起"，所以必须优先选用户输入行；
     * 找不到时退回该轮位置最靠上的可见行。
     *
     * 高度为 0 的行被排除：折叠起来的 Turn 其容器仍然在 DOM 里，
     * 但滚过去等于滚到空白。
     *
     * @param turnNo - 目标轮次。
     * @param scrollEl - 滚动容器或 null。
     * @returns 命中的元素，或 null。
     */
    function findRowByTurn(turnNo, scrollEl) {
      if (typeof document === 'undefined') return null
      var root = scrollEl || document
      var rows = root.querySelectorAll('[data-chat-turn]')
      var userRow = null
      var topRow = null
      var topmost = Infinity

      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i]
        if (row.hasAttribute('hidden') || row.closest('[hidden]') !== null) continue
        if (Number(row.getAttribute('data-chat-turn')) !== turnNo) continue
        var rect = row.getBoundingClientRect()
        if (rect.height === 0) continue

        if (row.getAttribute('data-chat-flow-kind') === 'user' && userRow === null) {
          userRow = row
        }
        if (rect.top < topmost) {
          topmost = rect.top
          topRow = row
        }
      }

      // 用户输入行优先：跳转应该落在"这一轮从哪句话开始讲"。
      return userRow !== null ? userRow : topRow
    }

    /**
     * 兜底：按 `data-chat-turn` 找第一个 turn 号 ≥ 目标的可见行。
     *
     * 对应官方的 `scrollToTurnAtOrAfter`。目标轮次的结构被折叠或重组时，
     * 滚到"最接近的下一轮"比什么都不做要好。
     *
     * @param turnNo - 目标轮次。
     * @param scrollEl - 滚动容器。
     * @returns 命中的元素，或 null。
     */
    function findTurnRowAtOrAfter(turnNo, scrollEl) {
      if (typeof document === 'undefined') return null
      var root = scrollEl || document
      var rows = root.querySelectorAll('[data-chat-turn]')
      var best = null
      var bestTurn = Infinity
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i]
        if (row.hasAttribute('hidden') || row.closest('[hidden]') !== null) continue
        var n = Number(row.getAttribute('data-chat-turn'))
        if (!Number.isSafeInteger(n)) continue
        if (n >= turnNo && n < bestTurn) { best = row; bestTurn = n }
      }
      return best
    }

    /**
     * 诊断：把对话 DOM 的真实结构提取成可读报告。
     *
     * 跳转依赖 DOM 属性，而属性名与层级由 Chat 插件决定。为避免继续猜测，
     * 这里把**所有 `data-*` 属性的实际存在情况**和每行的样本值都导出，
     * 供人看一眼就知道该按什么定位。
     *
     * @returns 概览：滚动容器状态、各候选属性的数量与样本、以及容器尺寸。
     */
    function probeChatDom() {
      if (typeof document === 'undefined') return { error: 'no document' }
      var scroller = chatScroller()
      var root = scroller || document

      function sample(sel, attr) {
        var nodes = root.querySelectorAll(sel)
        var values = []
        for (var i = 0; i < nodes.length && values.length < 6; i += 1) {
          var v = nodes[i].getAttribute(attr)
          if (v !== null) values.push(v)
        }
        return { count: nodes.length, sample: values }
      }

      // 收集 root 下出现过的所有 data-* 属性名，按出现次数排序。
      // 这是"到底有什么可用来定位"的直接答案。
      var attrCount = new Map()
      var scan = root.querySelectorAll('*')
      for (var i = 0; i < scan.length && i < 4000; i += 1) {
        var attrs = scan[i].attributes
        for (var j = 0; j < attrs.length; j += 1) {
          var name = attrs[j].name
          if (name.indexOf('data-') !== 0) continue
          attrCount.set(name, (attrCount.get(name) || 0) + 1)
        }
      }
      var ranked = []
      attrCount.forEach(function (count, name) { ranked.push([name, count]) })
      ranked.sort(function (a, b) { return b[1] - a[1] })

      var scrollerInfo = null
      if (scroller !== null) {
        scrollerInfo = {
          scrollTop: Math.round(scroller.scrollTop),
          scrollHeight: Math.round(scroller.scrollHeight),
          clientHeight: Math.round(scroller.clientHeight),
        }
      }

      return {
        hasScroller: scroller !== null,
        scroller: scrollerInfo,
        byTurn: sample('[data-chat-turn]', 'data-chat-turn'),
        byAnchor: sample('[data-chat-anchor-key]', 'data-chat-anchor-key'),
        byNodeKey: sample('[data-chat-node-key]', 'data-chat-node-key'),
        byFlowKey: sample('[data-chat-flow-key]', 'data-chat-flow-key'),
        dataAttributes: ranked.slice(0, 20),
        // 每一轮的定位能力：有没有 data-chat-turn、有没有 user 行、行高多少。
        // 跳转"只对部分轮次偏"通常就是这张表里出现了缺项。
        perTurn: turnLocatorReport(root, scroller),
      }
    }

    /**
     * 逐轮检查定位条件。
     *
     * 对每个 turn 回答三个问题：
     *   - 有没有带 `data-chat-turn` 的行；
     *   - 这些行里有没有 `data-chat-flow-kind="user"`；
     *   - 最靠上的行距容器顶多远（判断当前是否已经在视野内）。
     *
     * 缺 user 行的那几轮，跳转会退回"最靠上的可见行"，落点自然会与
     * 预期（用户输入那句）不同——这正是要修的地方。
     *
     * @param root - 查询根（滚动容器或 document）。
     * @param scroller - 滚动容器，用于算距离。
     * @returns 每轮的定位概况，最多 40 条。
     */
    function turnLocatorReport(root, scroller) {
      if (typeof document === 'undefined') return []
      var rows = root.querySelectorAll('[data-chat-turn]')
      var byTurn = new Map()
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i]
        var n = Number(row.getAttribute('data-chat-turn'))
        if (!Number.isSafeInteger(n)) continue
        var entry = byTurn.get(n)
        if (entry === undefined) {
          entry = { turn: n, rows: 0, userRows: 0, maxHeight: 0, topOffset: null }
          byTurn.set(n, entry)
        }
        entry.rows += 1
        if (row.getAttribute('data-chat-flow-kind') === 'user') entry.userRows += 1
        var rect = row.getBoundingClientRect()
        if (rect.height > entry.maxHeight) entry.maxHeight = Math.round(rect.height)
        if (entry.topOffset === null && scroller !== null) {
          var box = scroller.getBoundingClientRect()
          entry.topOffset = Math.round(rect.top - box.top)
        }
      }
      return [...byTurn.values()].sort((a, b) => a.turn - b.turn).slice(0, 40)
    }

    /** 把诊断结果格式化成可粘贴的文本。 */
    function formatProbe(report) {
      try { return JSON.stringify(report, null, 2) } catch (e) { return String(report) }
    }
    /** 对话滚动容器；Chat view 自己持有的那个。 */
    function chatScroller() {
      if (typeof document === 'undefined') return null
      return document.querySelector('[data-conversation-scroll]')
    }

    /**
     * 滚动到指定元素，返回实际写入的 `scrollTop`。
     *
     * 两个决定：
     *
     * 1. 用容器的 `scrollTop` 计算，而不是 `scrollIntoView`——后者在嵌套滚动
     *    容器里会把**外层页面**也一起滚，面板位置会乱跳。
     * 2. 用**瞬时**写入，不用 `behavior: 'smooth'`。Chat 视图的"跟随底部"会在
     *    滚动事件里判定"不是读者触发的移动"，平滑动画的中间帧正好落在这个
     *    判定里，于是目标位置被回弹覆盖。瞬时写入至少让落点先成立，再由调用方
     *    在随后几帧里保持住。
     *
     * @param el - 目标元素。
     * @param scrollEl - 滚动容器，或 null。
     * @returns 实际写入的 scrollTop；走 `scrollIntoView` 或无容器时返回 null。
     */
    function revealRow(el, scrollEl) {
      if (el === null) return null
      if (scrollEl !== null && typeof scrollEl.scrollTop === 'number') {
        var box = scrollEl.getBoundingClientRect()
        var row = el.getBoundingClientRect()
        // 让目标行贴着顶端（只留 REVEAL_TOP_PAD 的缝），而不是停在视口中间。
        var top = Math.max(0, scrollEl.scrollTop + (row.top - box.top) - REVEAL_TOP_PAD)
        try { scrollEl.scrollTo({ top: top, behavior: 'instant' }) }
        catch (e) { /* 老浏览器不支持 options 对象 */ }
        if (Math.abs(scrollEl.scrollTop - top) > 1) scrollEl.scrollTop = top
        return scrollEl.scrollTop
      }
      try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }) }
      catch (e) { el.scrollIntoView(true) }
      return null
    }

    // ── 面板 ────────────────────────────────────────────────────────
    function TopicMapPanel(props) {
      var t = props.t
      var sessionId = props.sessionId

      /**
       * 面板内可切换的会话。
       *
       * 平台把这个面板绑定在**当前**会话上（sessionId 由插槽注入），没有提供
       * "切换到另一个会话"的接口。所以跨会话浏览放在面板内部做：
       *   viewedSessionId 为空 = 跟随平台当前会话
       *   点了别的会话 = 面板内读那个会话，平台会话不变
       *
       * 这样既能跨会话看，又不需要任何写权限，也不会打乱用户当前正在聊的会话。
       */
      var viewedState = useState(null)
      var viewedSessionId = viewedState[0]; var setViewedSessionId = viewedState[1]
      var activeSessionId = viewedSessionId === null ? sessionId : viewedSessionId
      // session 作用域插槽把当前会话的 chat 快照作为标准 hook 注入。
      var useChat = props.useChat

      var dState = useState(null); var data = dState[0]; var setData = dState[1]
      var eState = useState(null); var error = eState[0]; var setError = eState[1]
      var lState = useState(false); var loading = lState[0]; var setLoading = lState[1]
      var hovState = useState(null); var hovered = hovState[0]; var setHovered = hovState[1]
      var posState = useState(null); var pos = posState[0]; var setPos = posState[1]
      var selState = useState(null); var selected = selState[0]; var setSelected = selState[1]
      // 视口：缩放 + 平移。滚轮、拖拽、按钮都改它。
      var viewState = useState({ scale: 1, offsetX: 0, offsetY: 0 })
      var view = viewState[0]; var setView = viewState[1]
      var laneState = useState(null); var highlightLane = laneState[0]; var setHighlightLane = laneState[1]
      // 选中轮次所属的泳道。与 highlightLane 分开存：
      //   highlightLane 来自左栏点击（用户主动筛选）
      //   selectedLane  来自点节点（自动跟随）
      // 两者可以同时存在，图上按各自语义渲染。
      var selectedLaneState = useState(null)
      var selectedLane = selectedLaneState[0]; var setSelectedLane = selectedLaneState[1]

      // 筛选条件。整体替换对象触发重渲染（内部字段按不可变方式更新）。
      var filterState = useState(() => FILTER.emptyFilter())
      var filter = filterState[0]; var setFilter = filterState[1]
      var filterOpenState = useState(false)

      // ── 跨会话：工作区、会话树、检索 ──────────────────────────────
      //
      // 这一组状态支撑"上层"：当前工作区有哪些会话、它们归成什么大类。
      // 与单会话的话题图（下层）并列，互不干扰。
      var stState = useState({
        workspaces: [],
        workspaceId: null,
        tree: [],
        total: 0,
        loading: true,
        busy: false,
        folded: {},
        currentSessionId: null,
      })
      var sessionTree = stState[0]; var setSessionTree = stState[1]

      var findState = useState(null)
      var findHits = findState[0]; var setFindHits = findState[1]
      var findBusyState = useState(false)
      var findBusy = findBusyState[0]; var setFindBusy = findBusyState[1]
      /** 跨会话检索的防抖定时器（hook 必须在顶层按序调用，故放在这里）。 */
      var findTimer = useRef(0)
      /** 跨会话检索框的内容与提示（与左栏筛选完全独立）。 */
      var findQueryState = useState('')
      var findQuery = findQueryState[0]; var setFindQuery = findQueryState[1]
      var findHintState = useState('')
      var findHint = findHintState[0]; var setFindHint = findHintState[1]

      /** 合并式更新会话树状态。 */
      function patchTree(patch) {
        setSessionTree(function (prev) { return Object.assign({}, prev, patch) })
      }

      /** 读取工作区列表 + 某个工作区的会话归类。 */
      function loadWorkspaceTree(workspaceId, options) {
        var opts = options ?? {}
        patchTree({ loading: true })
        post('workspaces', {}).then(function (list) {
          var ws = Array.isArray(list) ? list : []
          var target = workspaceId
          if (target === undefined || target === null) {
            // 默认跟随当前工作区：取第一个（registry 顺序 = 最近使用）
            target = ws.length > 0 ? ws[0].id : null
          }
          patchTree({ workspaces: ws, workspaceId: target })
          if (target === null) { patchTree({ loading: false, tree: [], total: 0 }); return }

          post('categorize', { workspaceId: target, force: opts.force === true }).then(function (value) {
            if (value === null || value === undefined) { patchTree({ loading: false }); return }
            patchTree({
              loading: false,
              busy: false,
              tree: Array.isArray(value.tree) ? value.tree : [],
              total: value.total ?? 0,
            })
          }, function () { patchTree({ loading: false, busy: false }) })
        }, function () { patchTree({ loading: false, busy: false }) })
      }

      /** 强制重新归类。 */
      function recategorize() {
        if (sessionTree.workspaceId === null) return
        patchTree({ busy: true })
        loadWorkspaceTree(sessionTree.workspaceId, { force: true })
      }

      /** 切换工作区。 */
      function switchWorkspace(id) {
        patchTree({ workspaceId: id, folded: {} })
        loadWorkspaceTree(id)
      }

      /** 折叠/展开树节点。 */
      function toggleTreeFold(key) {
        setSessionTree(function (prev) {
          var folded = Object.assign({}, prev.folded)
          if (folded[key] === true) delete folded[key]
          else folded[key] = true
          return Object.assign({}, prev, { folded: folded })
        })
      }

      /**
       * 跨会话检索。
       *
       * 与左栏筛选的分工：
       *   - 这里搜**整个工作区**的会话（标题 + 全部轮次正文）
       *   - 左栏那个框只筛**当前会话**里的话题/阶段/任务
       *
       * 两个框独立，不再"一个框两套行为"——那是之前最容易被误解的地方。
       *
       * @param query - 关键字。
       */
      function runFind(query) {
        var q = String(query ?? '').trim()
        setFindQuery(q)
        if (q === '') { setFindHits(null); setFindHint(''); return }
        if (sessionTree.workspaceId === null) return
        setFindBusy(true)
        setFindHint('搜索中…')
        post('find', { workspaceId: sessionTree.workspaceId, query: q, limit: 20 })
          .then(function (value) {
            setFindBusy(false)
            var hits = value && Array.isArray(value.hits) ? value.hits : []
            setFindHits(hits)
            // 明确告诉用户"扫了多少、命中多少、有没有被上限截断"，
            // 否则看到几条结果不知道是不是全部
            var scanned = value && Number.isFinite(value.scanned) ? value.scanned : null
            var parts = []
            if (hits.length > 0) parts.push('命中 ' + hits.length + ' 个会话')
            else parts.push('没有命中')
            if (scanned !== null) parts.push('已扫 ' + scanned + ' 个')
            if (value && value.truncated === true) parts.push('已截断')
            setFindHint(parts.join(' · '))
          }, function () { setFindBusy(false); setFindHits([]); setFindHint('检索失败') })
      }

      var filterOpen = filterOpenState[0]; var setFilterOpen = filterOpenState[1]

      // 模型复核的结果：laneId → { state, basis }，以及本次复核概况。
      var reviewState = useState(null)
      var review = reviewState[0]; var setReview = reviewState[1]
      var reviewingState = useState(false)
      var reviewing = reviewingState[0]; var setReviewing = reviewingState[1]
      var reviewAbort = useRef(null)

      /**
       * 让模型复核"可疑"的任务。
       *
       * 只复核可疑的，不全部问：一条会话几十个任务，全问既慢又贵；
       * 而大部分任务用硬证据（改过文件、之后没回头）就判得比较稳。
       */
      function runReview() {
        if (sessionId === undefined || reviewing) return
        if (reviewAbort.current !== null) {
          try { reviewAbort.current.abort() } catch (e) { /* 忽略 */ }
        }
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        reviewAbort.current = controller
        setReviewing(true)
        post('review-status', { sessionId: sessionId }, controller === null ? undefined : controller.signal)
          .then(function (value) {
            reviewAbort.current = null
            setReview(value)
            setReviewing(false)
            // 落盘：切 tab、刷新页面后仍能看到这次复核结论
            if (value !== null && value !== undefined && sessionId !== undefined) {
              post('ui-state', {
                sessionId: sessionId,
                patch: { review: Object.assign({}, value, { savedAt: Date.now() }) },
              }).catch(function () { /* 写失败不打扰 */ })
            }
          }, function (e) {
            reviewAbort.current = null
            setReviewing(false)
            if (e && e.name === 'AbortError') return
            setReview({ status: 'unavailable', reason: e && e.message ? e.message : String(e) })
          })
      }

      function cancelReview() {
        if (reviewAbort.current !== null) {
          try { reviewAbort.current.abort() } catch (e) { /* 忽略 */ }
          reviewAbort.current = null
        }
        setReviewing(false)
      }

      function patchFilter(patch) {
        setFilter(function (prev) {
          var next = Object.assign({}, prev, patch)
          // 条件变化就落盘：切会话再回来仍是同一套筛选，不用重设。
          persistFilter(next)
          return next
        })
        // 注意：这个框**只筛当前会话**的话题/阶段/任务，不再同时触发
        // 跨会话检索。之前一个框干两件事，用户看不出区别——那是最容易
        // 误解的地方。跨会话检索有它自己的框（会话树上方）。
      }

      /** 跨会话检索框的输入（防抖 500ms，避免每敲一个字就扫全部会话）。 */
      function onFindInput(text) {
        setFindQuery(text)
        if (findTimer.current !== 0) window.clearTimeout(findTimer.current)
        findTimer.current = window.setTimeout(function () {
          runFind(text)
        }, 500)
      }

      /**
       * 把筛选条件写回 Host。
       *
       * 防抖 400ms：输入框每次按键都发请求既浪费也会乱序覆盖。
       */
      var filterPersistTimer = useRef(0)
      function persistFilter(next) {
        if (sessionId === undefined) return
        if (filterPersistTimer.current !== 0) window.clearTimeout(filterPersistTimer.current)
        filterPersistTimer.current = window.setTimeout(function () {
          post('ui-state', { sessionId: sessionId, patch: { filter: next } })
            .catch(function () { /* 写失败不打扰用户 */ })
        }, 400)
      }

      function toggleInList(list, value) {
        var arr = Array.isArray(list) ? list : []
        return arr.indexOf(value) >= 0 ? arr.filter(function (x) { return x !== value }) : arr.concat([value])
      }

      /**
       * 聚焦一条泳道：高亮它，并把视图滚动到它所在的行。
       *
       * 只高亮不滚动是不够的——长会话里被选中的泳道常常在屏幕之外，
       * 点了之后什么也看不见，等于没反应。
       *
       * 滚动方式：调整视口的 `offsetY`，让该行落在可见高度内。若它已经在
       * 视野里就不动，避免每次点击画面都跳。
       *
       * @param laneId - 目标泳道；传 null 表示取消聚焦。
       */
      function focusLane(laneId) {
        setHighlightLane(laneId)
        if (laneId === null || L === null) return
        // 找该泳道对应的行（col 就是纵向行号）
        var col = -1
        for (var i = 0; i < data.graph.columns.length; i += 1) {
          if (data.graph.columns[i].laneId === laneId) { col = data.graph.columns[i].col; break }
        }
        if (col < 0) return

        // 该行在内容坐标里的 y
        var rowY = null
        for (var k = 0; k < L.labels.length; k += 1) {
          if (L.labels[k].laneId === laneId) { rowY = L.labels[k].y; break }
        }
        if (rowY === null) return

        setView(function (prev) {
          var screenY = rowY * prev.scale + prev.offsetY
          var margin = 60
          // 已可见就不动
          if (screenY >= margin && screenY <= size.h - margin) return prev
          // 否则把它挪到上方 1/4 处
          var wantY = size.h * 0.25
          var next = { scale: prev.scale, offsetY: wantY - rowY * prev.scale, offsetX: prev.offsetX }
          return VIEWPORT.constrain(next, { width: L.width, height: L.height }, { width: size.w, height: size.h })
        })
      }
      var sizeState = useState({ w: 820, h: 480 }); var size = sizeState[0]; var setSize = sizeState[1]
      var diagState = useState(null); var diag = diagState[0]; var setDiag = diagState[1]
      // 语义分段：分析结果先存为预览，用户确认才替换当前结构。
      var semState = useState(null); var semantic = semState[0]; var setSemantic = semState[1]
      var anaState = useState(false); var analyzing = anaState[0]; var setAnalyzing = anaState[1]
      // 分析进度：Host 侧的分步状态，客户端轮询读取。
      var progState = useState(null); var progress = progState[0]; var setProgress = progState[1]
      // 设置弹出层的显示状态与已加载的配置。
      var cfgState = useState(null); var config = cfgState[0]; var setConfig = cfgState[1]
      var popState = useState(false); var showSettings = popState[0]; var setShowSettings = popState[1]
      // 左栏三层树的折叠状态：按节点 key 记录，展开/收起不影响图。
      // 左栏三层树的折叠状态。
      //
      // 存 sessionStorage 并按会话分开：切走再看回来，展开的层级还在原来
      // 的位置。用内存 state 的话，面板一卸载就重置，每次都要重新展开。
      // 主题：用户选择（auto/light/dark）与实际解析出的明暗。
      //
      // 两者分开存：auto 表示"跟随宿主"，此时隐藏选择但显示当前实际的明暗，
      // 用户点一下才变成显式的 light/dark。
      var themeState = useState(function () {
        return typeof sessionStorage === 'undefined' ? 'auto' : THEME.loadThemeChoice(sessionStorage)
      })
      var themeChoice = themeState[0]; var setThemeChoice = themeState[1]
      var hostThemeState = useState(function () {
        return typeof document === 'undefined' ? 'light' : THEME.detectHostTheme(document)
      })
      var hostTheme = hostThemeState[0]; var setHostTheme = hostThemeState[1]

      var resolvedTheme = THEME.resolveTheme(themeChoice, typeof document === 'undefined' ? undefined : document)
      // 每次渲染都同步一次：取色函数（trackColor/categoryTint）是纯函数，
      // 但它们的输入是这个模块级变量，必须在渲染前就是当前值。
      themeMode = resolvedTheme

      // 图着色模式：话题色（默认）/ 状态色
      var gmodeState = useState(function () {
        return typeof sessionStorage === 'undefined' ? 'topic' : GMODE.loadGraphMode(sessionStorage)
      })
      var gmode = gmodeState[0]; var setGmode = gmodeState[1]
      graphMode = gmode

      function cycleGraphMode() {
        var next = GMODE.nextGraphMode(gmode)
        setGmode(next)
        if (typeof sessionStorage !== 'undefined') GMODE.saveGraphMode(sessionStorage, next)
      }

      // 把解析结果写到根节点上，CSS 变量随之切换；不重渲染组件树。
      // 同步更新取色用的模式：SVG 的颜色是 JS 算出来的，不跟着主题走就会
      // 停在旧色板上。
      useEffect(function () {
        if (typeof document === 'undefined') return
        document.documentElement.setAttribute('data-tm-theme', resolvedTheme)
        themeMode = resolvedTheme
      }, [resolvedTheme])

      /**
       * 挂载时加载工作区与会话归类。
       *
       * 只跑一次：归类结果在 Host 侧有缓存，重复调用不会重复花 token。
       * 工作区切换与强制重算由用户动作触发，不走这里。
       */
      useEffect(function () {
        loadWorkspaceTree(null)
      }, [])

      /**
       * 面板重新可见时重拉会话列表。
       *
       * 为什么要这个：会话列表不会自己更新。用户在别的地方新建了会话、
       * 或另一个窗口里产生了新会话，这个面板原本完全不知道，只有整页刷新
       * 才会看到。这里在"切回本页签 / 窗口重新获得焦点"时静默重拉一次。
       *
       * 只重拉列表（读标题 + 数轮次），不重新归类——归类结果在 Host 有缓存，
       * 会话集合没变就不会重算，所以这个动作很便宜。
       */
      useEffect(function () {
        if (typeof document === 'undefined' || typeof window === 'undefined') return undefined

        var last = Date.now()
        function maybeRefresh() {
          if (document.visibilityState === 'hidden') return
          // 10 秒内不重复拉，避免切来切去时打满请求
          if (Date.now() - last < 10000) return
          last = Date.now()
          if (sessionTree.workspaceId !== null) loadWorkspaceTree(sessionTree.workspaceId)
        }

        document.addEventListener('visibilitychange', maybeRefresh)
        window.addEventListener('focus', maybeRefresh)
        return function () {
          document.removeEventListener('visibilitychange', maybeRefresh)
          window.removeEventListener('focus', maybeRefresh)
        }
      }, [sessionTree.workspaceId])

      // auto 模式下偶尔宿主会切明暗（用户改 DSH 主题），跟一下。
      useEffect(function () {
        if (themeChoice !== 'auto' || typeof window === 'undefined') return
        function onMaybe() {
          var now = THEME.detectHostTheme(document)
          setHostTheme(function (prev) { return prev === now ? prev : now })
        }
        var timer = window.setInterval(onMaybe, 2000)
        return function () { window.clearInterval(timer) }
      }, [themeChoice])

      function cycleTheme() {
        var next = THEME.nextThemeChoice(themeChoice)
        setThemeChoice(next)
        if (typeof sessionStorage !== 'undefined') THEME.saveThemeChoice(sessionStorage, next)
      }

      var foldState = useState({}); var collapsed = foldState[0]; var setCollapsed = foldState[1]

      function foldKey(sessionId) { return 'dsh-topic-map:fold:' + sessionId }

      /** 把折叠状态写进 sessionStorage（按会话分开）。 */
      function persistFold(next) {
        // 与读取用同一个键：activeSessionId（面板内切换后的那个）
        var target = activeSessionId
        if (target === undefined || target === null || typeof sessionStorage === 'undefined') return
        try { sessionStorage.setItem(foldKey(target), JSON.stringify(next)) } catch (e) { /* 配额满就放弃 */ }
      }

      // 切换会话时读取该会话保存的折叠状态。
      // 没有保存过就用默认值（展开阶段与工作流）——而不是全部展开：
      // 精密分析后阶段×工作流×任务三层全展开，一屏根本放不下。
      //
      // 用 activeSessionId 而不是 sessionId：面板内可以切到别的会话看，
      // 折叠状态必须跟着"当前正在看的那一个"走，否则切过去会沿用上一个
      // 会话的展开状态，看起来像随机错乱。
      useEffect(function () {
        var target = activeSessionId
        if (target === undefined || target === null) return
        try {
          var raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(foldKey(target))
          if (raw !== null) setCollapsed(JSON.parse(raw) || {})
          else setCollapsed({})
        } catch (e) {
          setCollapsed({})
        }
      }, [activeSessionId])

      function toggle(key) {
        setCollapsed(function (prev) {
          var next = Object.assign({}, prev)
          if (next[key] === true) delete next[key]
          else next[key] = true
          persistFold(next)
          return next
        })
      }

      /** 三按钮：全展开 / 只看阶段 / 全折叠。 */
      function applyFold(mode) {
        var stages = data === null ? [] : (data.stages ?? [])
        var next = mode === 'all' ? FOLD.expandAll()
          : mode === 'stages' ? FOLD.collapseToStages(stages)
          : FOLD.collapseAll(stages)
        setCollapsed(next)
        persistFold(next)
      }

      /** 当前展开粒度：'all' | 'stages' | 'none' | 'mixed'，供按钮高亮。 */      var foldModeName = data === null ? 'all' : FOLD.foldMode(data.stages ?? [], collapsed)

      /** 左栏滚动容器，用于"点节点时把对应任务滚到可见"。 */
      var treeRef = useRef(null)

      /**
       * 选中某一轮，并让左树跟着走。
       *
       * 这一处是"双向联动"的枢纽：图上点节点、详情里的跳转、以及外部的
       * 选中请求都走它，因此左树的展开/收起/滚动只需在这里实现一次。
       *
       * 具体做三件事：
       *   1. 选中该轮（详情面板随之更新）
       *   2. 收起其他阶段、展开它所在的阶段与工作流
       *      ——不收起的话，目标会淹没在长列表里，用户还是找不到
       *   3. 把对应任务行滚到可见
       *
       * @param turn - 轮次号；null 表示清除选中。
       * @param options - `{ fold: boolean }`，默认要折叠。
       */
      function selectTurn(turn, options) {
        setSelected(turn)
        if (turn === null || turn === undefined) return
        saveSelectedTurn(sessionId, turn)

        var opts = options ?? {}

        // ── 图上联动：让"这一轮属于哪条线"变得可见 ──
        //
        // 之前只设 selected（节点出现一个环），但整条泳道毫无反应——
        // 用户看不出这个点属于哪条线。这里补上泳道的聚焦。
        if (opts.focusLane !== false && data !== null && Array.isArray(data.lanes)) {
          var ownerLane = null
          for (var li = 0; li < data.lanes.length; li += 1) {
            var ts = data.lanes[li].turns
            if (Array.isArray(ts) && ts.indexOf(turn) >= 0) { ownerLane = data.lanes[li]; break }
          }
          if (ownerLane !== null) {
            setHighlightLane(ownerLane.laneId)
            setSelectedLane(ownerLane.laneId)
          }
        }

        if (data === null || !Array.isArray(data.stages) || data.stages.length === 0) return

        var path = FOLD.pathOfTurn(data.stages, turn)
        if (path === null) return

        if (opts.fold !== false) {
          var next = FOLD.foldToPath(data.stages, path)
          setCollapsed(next)
          persistFold(next)
        }

        // 等一帧让树把新展开的内容渲染出来，再滚到目标行
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(function () { scrollTreeToTask(turn) })
        }
      }

      /**
       * 把左树里"包含该轮的任务行"滚到可见区域。
       *
       * 用 data 属性定位而不是 ref 数组：任务行是动态渲染的，逐个建 ref
       * 既麻烦又容易在重渲染后失效。DOM 查询在这里足够便宜（每栏几十行）。
       *
       * @param turn - 轮次号。
       */
      function scrollTreeToTask(turn) {
        var box = treeRef.current
        if (box === null || box === undefined) return
        var row = box.querySelector('[data-turns~="' + turn + '"]')
        if (row === null) return
        try {
          row.scrollIntoView({ block: 'nearest' })
        } catch (e) {
          // 老浏览器不支持 options 时退化为粗定位
          try { row.scrollIntoView(false) } catch (e2) { /* 忽略 */ }
        }
      }

      var canvasRef = useRef(null)
      var ready = data !== null

      useEffect(function () {
        if (activeSessionId === undefined || activeSessionId === null) { setData(null); return undefined }
        var alive = true
        setLoading(true)
        function load(attempt) {
          post('session', { sessionId: activeSessionId, force: attempt > 0 }).then(function (value) {
            if (!alive) return
            if (!value || !value.graph) {
              if (attempt < 1) { load(attempt + 1); return }
              setError('Host 返回的数据缺少 graph（engineVersion=' + (value && value.engineVersion) + '）')
              setData(null); setLoading(false); return
            }
            setData(value); setError(null); setLoading(false)
            // 选中项记忆：切走再回来应停在原处，而不是跳回最后一轮。
            // 存的是 turn 号；若该轮已不存在（会话被截断），退回末尾。
            if (value.turns.length > 0) {
              var remembered = loadSelectedTurn(activeSessionId)
              var exists = remembered !== null
                && value.turns.some(function (t) { return t.turn === remembered })
              setSelected(exists ? remembered : value.turns[value.turns.length - 1].turn)
            }
          }, function (e) {
            if (!alive) return
            if (attempt < 1) { load(attempt + 1); return }
            setError(e && e.message ? e.message : String(e)); setLoading(false)
          })
        }
        load(0)
        return function () { alive = false }
      }, [activeSessionId])

      useEffect(function () {
        var el = canvasRef.current
        if (el === null) return undefined
        function measure() {
          setSize({ w: el.clientWidth || 820, h: el.clientHeight || 480 })
        }
        measure()
        if (typeof ResizeObserver !== 'function') {
          window.addEventListener('resize', measure)
          return function () { window.removeEventListener('resize', measure) }
        }
        var ro = new ResizeObserver(measure)
        ro.observe(el)
        return function () { ro.disconnect() }
      }, [ready])

      var byTurn = useMemo(function () {
        var m = new Map()
        if (data !== null) for (var i = 0; i < data.turns.length; i += 1) m.set(data.turns[i].turn, data.turns[i])
        return m
      }, [data])

      /**
       * 按当前条件切出可见泳道。
       *
       * 始终从**完整的** data.lanes 出发，而不是在上一次筛选结果上再筛：
       * 否则取消条件后就恢复不回来了。
       */
      var filtered = useMemo(function () {
        if (data === null || !Array.isArray(data.lanes)) {
          return { visible: [], hidden: [], counts: { total: 0, visible: 0, hidden: 0 } }
        }
        return FILTER.applyFilter(data.lanes, filter, function (turn) { return byTurn.get(turn) })
      }, [data, filter, byTurn])

      var visibleLaneIds = useMemo(function () {
        var set = new Set()
        for (var i = 0; i < filtered.visible.length; i += 1) set.add(filtered.visible[i].laneId)
        return set
      }, [filtered])

      var filterActive = !FILTER.isFilterEmpty(filter)
      var stageOptions = useMemo(function () {
        return data === null || !Array.isArray(data.lanes) ? [] : FILTER.collectStages(data.lanes)
      }, [data])

      /**
       * 筛选联动：自动展开含命中任务的阶段与工作流，收起没有的。
       *
       * 不做的话，命中项若藏在收起的阶段里，用户会看到"3/16"却什么都找不到，
       * 以为筛选坏了。
       */
      useEffect(function () {
        if (!filterActive) return
        if (data === null || !Array.isArray(data.stages) || data.stages.length === 0) return
        // 可见任务的「首个轮次」作为标识，与 stages 里的 tasks.turns 对齐
        var visibleFirstTurns = new Set()
        for (var i = 0; i < filtered.visible.length; i += 1) {
          var ts = filtered.visible[i].turns
          if (Array.isArray(ts) && ts.length > 0) visibleFirstTurns.add(ts[0])
        }
        var next = FOLD.foldForFilter(data.stages, visibleFirstTurns, function (task) {
          return Array.isArray(task.turns) && task.turns.length > 0 ? task.turns[0] : null
        })
        setCollapsed(next)
        persistFold(next)
      }, [filterActive, filter, data, filtered])

      /** 筛选命中后，把第一个可见任务滚到可见位置。 */
      useEffect(function () {
        if (!filterActive) return
        if (filtered.visible.length === 0) return
        var ts = filtered.visible[0].turns
        if (!Array.isArray(ts) || ts.length === 0) return
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(function () { scrollTreeToTask(ts[0]) })
        }
      }, [filterActive, filter])

      // ── PM：任务状态与依赖 ────────────────────────────────────────
      //
      // 状态是**推导**的（日志里没有任务状态字段），每条都带依据；
      // 用户可以手动覆盖，覆盖存在 Host 侧，跨会话切换与刷新都保留。
      var uiState = useState({ overrides: {}, filter: null })
      var userState = uiState[0]; var setUserState = uiState[1]

      // 切会话时读取该会话保存的覆盖与筛选条件。
      useEffect(function () {
        if (sessionId === undefined) { setUserState({ overrides: {}, filter: null }); return }
        var alive = true
        post('ui-state', { sessionId: sessionId }).then(function (value) {
          if (!alive || value === null || value === undefined) return
          setUserState({ overrides: value.overrides || {}, filter: value.filter || null })
          // 恢复上次的复核结果：一次复核花了 token，切 tab 回来不该白费
          if (value.review !== null && value.review !== undefined) setReview(value.review)
          // 恢复筛选条件：只在首次进入该会话时套用，避免覆盖用户正在编辑的内容。
          if (value.filter !== null && typeof value.filter === 'object') {
            setFilter(function (prev) {
              if (!FILTER.isFilterEmpty(prev)) return prev
              return Object.assign(FILTER.emptyFilter(), value.filter)
            })
          }
        }, function () { /* 读不到就用默认值 */ })
        return function () { alive = false }
      }, [sessionId])

      /** 把一次 UI 状态改动写回 Host。 */
      function pushUiState(patch) {
        if (sessionId === undefined) return
        post('ui-state', { sessionId: sessionId, patch: patch }).then(function (value) {
          if (value === null || value === undefined) return
          setUserState({ overrides: value.overrides || {}, filter: value.filter || null })
        }, function () { /* 写失败就当本地生效，下次再写 */ })
      }

      /** 手动标注某任务的状态；再次点同一个值即清除覆盖。 */
      function setTaskState(laneId, state) {
        var current = userState.overrides[laneId]
        var next = current === state ? null : state
        setUserState(function (prev) {
          var overrides = Object.assign({}, prev.overrides)
          if (next === null) delete overrides[laneId]
          else overrides[laneId] = next
          return { overrides: overrides, filter: prev.filter }
        })
        pushUiState({ override: { laneId: laneId, state: next } })
      }

      // 每条任务的状态：推导结果 + 用户覆盖
      var pmState = useMemo(function () {
        var empty = {
          stateOf: function () { return 'todo' },
          detailOf: function () { return { state: 'todo', inferred: true, basis: '', overridden: false } },
          byLane: new Map(),
          dependencies: [],
          counts: { todo: 0, active: 0, blocked: 0, done: 0, total: 0 },
        }
        if (data === null || !Array.isArray(data.lanes)) return empty

        var lastTurn = data.turns.length === 0 ? null : data.turns[data.turns.length - 1].turn
        var factOf = function (turn) { return byTurn.get(turn) }
        // 每条泳道"之后有没有转向别的话题"——这是判断 done 的关键依据。
        // 没有它，一条顺利的会话里所有任务都会被标成已完成，失去区分度。
        var supersession = PM.computeSupersession(data.lanes)
        var comeBack = PM.computeComeBack(data.lanes)
        // 模型复核结果：laneId → { state, basis }
        var reviewMap = new Map()
        if (review !== null && Array.isArray(review.entries)) {
          for (var ri = 0; ri < review.entries.length; ri += 1) {
            var re = review.entries[ri]
            if (re.reviewed === true) reviewMap.set(re.laneId, re)
          }
        }
        var byLane = new Map()
        for (var i = 0; i < data.lanes.length; i += 1) {
          var lane = data.lanes[i]
          // 优先用硬证据初判（比只看结束原因强）
          var inferred = PM.inferFromEvidence(lane, factOf, {
            lastTurnInSession: lastTurn,
            supersededAfter: supersession.get(lane.laneId) ?? null,
            laterTurnsOfSameLane: comeBack.get(lane.laneId) ?? 0,
          })
          // 模型复核过就用模型的结论
          var hit = reviewMap.get(lane.laneId)
          var base = hit === undefined
            ? { state: inferred.state, inferred: true, basis: inferred.basis, evidence: inferred.evidence }
            : { state: hit.state, inferred: true, basis: hit.basis, evidence: inferred.evidence, fromModel: true }
          var effective = PM.applyOverride(base, userState.overrides[lane.laneId])
          byLane.set(lane.laneId, effective)
        }

        // 依赖：只在同一话题内连线，避免把不相干的事连起来
        var dependencies = PM.inferDependencies(data.lanes, factOf, function (a, b) {
          return a.stageName !== null && b.stageName !== null && a.stageName === b.stageName
        })

        var stateOf = function (laneId) {
          var hit = byLane.get(laneId)
          return hit === undefined ? 'todo' : hit.state
        }
        return {
          stateOf: stateOf,
          detailOf: function (laneId) { return byLane.get(laneId) || { state: 'todo', inferred: true, basis: '', overridden: false } },
          byLane: byLane,
          dependencies: dependencies,
          counts: PM.summarizeStates(data.lanes, stateOf),
        }
      }, [data, byTurn, userState, review])

      /**
       * PM 报告数据：工作量、风险、交付物。
       *
       * 三块都从已算出的状态与轮次事实派生，不新增模型调用——这是它们
       * 与"复核"的关键区别：复核要读对话内容，这些只看结构。
       */
      /**
       * 状态色模式下的"同状态内序号"表。
       *
       * 深浅变化要按"同一状态里的第几条"来定，而不是全局序号——
       * 否则 10 条完成里只有前两条颜色不同。这里在渲染前把它同步给模块级
       * 变量，供 laneStrokeColor 取用。
       */
      useMemo(function () {
        if (data === null || !Array.isArray(data.lanes)) {
          stateIndex = new Map()
          return null
        }
        var idx = GMODE.stateIndexMap(data.lanes.map(function (l) {
          return { laneId: l.laneId, state: pmState.stateOf(l.laneId) }
        }))
        // laneStrokeColor 需要"状态 + 该状态内序号"两样，这里合并成一张表
        var merged = new Map()
        for (var i = 0; i < data.lanes.length; i += 1) {
          var lane = data.lanes[i]
          merged.set(lane.laneId, {
            state: pmState.stateOf(lane.laneId),
            index: idx.get(lane.laneId) ?? 0,
          })
        }
        stateIndex = merged
        return merged
      }, [data, pmState])

      /**
       * 内容坐标只依赖"可见的拓扑"，与视口无关；缩放平移不触发重排。
       *
       * 筛选生效时，这里把被隐藏的泳道从 graph 里剔除并**重排行号**，
       * 否则图上会留下空洞（行 2、5、9 空着），看着像坏了。
       */
      var L = useMemo(function () {
        if (data === null || !data.graph) return null
        if (!filterActive) return layout(data.graph)

        var g = data.graph
        // 保留可见泳道的节点/边/标签，并把 col 重新映射为 0..n-1
        var keep = new Map()
        var nextCol = 0
        for (var c = 0; c < g.columnCount; c += 1) {
          var column = null
          for (var k = 0; k < g.columns.length; k += 1) {
            if (g.columns[k].col === c) { column = g.columns[k]; break }
          }
          if (column === null) continue
          if (!visibleLaneIds.has(column.laneId)) continue
          keep.set(c, nextCol)
          nextCol += 1
        }

        var nodes = g.nodes
          .filter(function (nd) { return visibleLaneIds.has(nd.laneId) })
          .map(function (nd) { return Object.assign({}, nd, { col: keep.get(nd.col) }) })
        var labels = g.labels
          .filter(function (lb) { return visibleLaneIds.has(lb.laneId) })
          .map(function (lb) { return Object.assign({}, lb, { col: keep.get(lb.col) }) })
        var edges = g.edges.filter(function (e) {
          if (e.laneId !== undefined && !visibleLaneIds.has(e.laneId)) return false
          if (e.fromLaneId !== undefined && !visibleLaneIds.has(e.fromLaneId)) return false
          if (e.toLaneId !== undefined && !visibleLaneIds.has(e.toLaneId)) return false
          return true
        }).map(function (e) {
          var next = Object.assign({}, e)
          if (next.fromCol !== undefined) next.fromCol = keep.get(next.fromCol)
          if (next.toCol !== undefined) next.toCol = keep.get(next.toCol)
          if (next.col !== undefined) next.col = keep.get(next.col)
          return next
        }).filter(function (e) {
          // 端点被筛掉的边不能留（否则会画到不存在的行上）
          if (e.fromCol !== undefined && e.fromCol === undefined) return false
          if (e.col !== undefined && e.col === undefined) return false
          return true
        })

        // 只保留那些两端都还在的边
        var valid = edges.filter(function (e) {
          if (e.kind === 'fork') return keep.get(e.fromCol) !== undefined && keep.get(e.toCol) !== undefined
          return keep.get(e.col) !== undefined
        })

        return layout({
          turnCount: g.turnCount,
          columnCount: nextCol,
          columns: g.columns.filter(function (c2) { return visibleLaneIds.has(c2.laneId) })
            .map(function (c2) { return Object.assign({}, c2, { col: keep.get(c2.col) }) }),
          nodes: nodes,
          edges: valid,
          labels: labels,
        })
      }, [data, filterActive, visibleLaneIds])

      var contentSize = L === null ? { width: 0, height: 0 } : { width: L.width, height: L.height }

      /**
       * 全览：把内容缩放到整个可见区域。
       *
       * 在数据换新、首次打开、以及用户点复位时调用。之所以要在这里做而不是
       * 在 layout 里，是因为"装得下"取决于视口，而 layout 现在与视口无关。
       */
      function fitNow() {
        if (L === null) return
        setView(VIEWPORT.fitToView(
          { width: L.width, height: L.height },
          { width: size.w, height: size.h },
        ))
      }

      // ── 滚轮缩放：以鼠标位置为锚 ──────────────────────────────────
      function onWheel(ev) {
        if (L === null) return
        ev.preventDefault()
        var el = canvasRef.current
        if (el === null) return
        var box = el.getBoundingClientRect()
        // 锚点用相对画布左上角的坐标
        var ax = ev.clientX - box.left
        var ay = ev.clientY - box.top
        // 滚一格约 1.12 倍，方向按 deltaY 符号；触控板的小增量按比例放大。
        var factor = Math.pow(1.12, -ev.deltaY / 100)
        setView(function (prev) {
          return VIEWPORT.zoomAt(
            prev, ax, ay, prev.scale * factor,
            { width: L.width, height: L.height },
            { width: size.w, height: size.h },
          )
        })
      }

      // ── 拖拽平移 ──────────────────────────────────────────────────
      var dragState = useState(null)
      var dragging = dragState[0] !== null
      var dragRef = useRef(null)

      function onDragStart(ev) {
        // 只响应左键；节点自身的点击不应触发拖拽。
        if (ev.button !== 0) return
        if (ev.target !== ev.currentTarget && ev.target.tagName !== 'svg') return
        dragRef.current = { x: ev.clientX, y: ev.clientY }
        dragState[1]({ x: ev.clientX, y: ev.clientY })
        try { ev.currentTarget.setPointerCapture(ev.pointerId) } catch (e) { /* 忽略 */ }
      }

      function onDragMove(ev) {
        var from = dragRef.current
        if (from === null || L === null) return
        var dx = ev.clientX - from.x
        var dy = ev.clientY - from.y
        if (dx === 0 && dy === 0) return
        dragRef.current = { x: ev.clientX, y: ev.clientY }
        setView(function (prev) {
          return VIEWPORT.panBy(
            prev, dx, dy,
            { width: L.width, height: L.height },
            { width: size.w, height: size.h },
          )
        })
      }

      function onDragEnd(ev) {
        if (dragRef.current === null) return
        dragRef.current = null
        dragState[1](null)
        try { ev.currentTarget.releasePointerCapture(ev.pointerId) } catch (e) { /* 忽略 */ }
      }

      // 数据换新或视口尺寸变化后，若还没手动调过视图，就自动全览一次。
      var fittedFor = useRef('')

      /**
       * 记住每个会话的视图位置。
       *
       * 存在 sessionStorage 而不是内存：切走再切回来面板会重新挂载，内存里
       * 的 state 已经丢了。按 sessionId 分开存，互不干扰。
       */
      function viewKey(id) { return 'dsh-topic-map:view:' + id }

      /** 选中节点的存储键。 */
      function selKey(id) { return 'dsh-topic-map:sel:' + id }

      function loadSelectedTurn(id) {
        if (typeof sessionStorage === 'undefined' || id === undefined) return null
        try {
          var raw = sessionStorage.getItem(selKey(id))
          if (raw === null) return null
          var n = Number(raw)
          return Number.isSafeInteger(n) && n > 0 ? n : null
        } catch (e) { return null }
      }

      function saveSelectedTurn(id, turn) {
        if (typeof sessionStorage === 'undefined' || id === undefined) return
        try { sessionStorage.setItem(selKey(id), String(turn)) } catch (e) { /* 忽略 */ }
      }

      function loadSavedView(id) {
        if (typeof sessionStorage === 'undefined' || id === undefined) return null
        try {
          var raw = sessionStorage.getItem(viewKey(id))
          if (raw === null) return null
          var parsed = JSON.parse(raw)
          if (parsed && Number.isFinite(parsed.scale) && Number.isFinite(parsed.offsetX) && Number.isFinite(parsed.offsetY)) {
            return parsed
          }
        } catch (e) { /* 损坏就忽略 */ }
        return null
      }

      function saveView(id, v) {
        if (typeof sessionStorage === 'undefined' || id === undefined) return
        try { sessionStorage.setItem(viewKey(id), JSON.stringify(v)) } catch (e) { /* 配额满就放弃 */ }
      }

      useEffect(function () {
        if (L === null) return
        var key = sessionId + ':' + data.graph.turnCount + ':' + data.graph.columnCount
        if (fittedFor.current === key) return
        fittedFor.current = key
        // 有记住的位置就恢复，否则全览。恢复时仍要过一遍约束：内容可能已经
        // 变了（新增轮次），旧偏移未必还有效。
        var saved = loadSavedView(sessionId)
        if (saved !== null) {
          setView(VIEWPORT.constrain(
            saved,
            { width: L.width, height: L.height },
            { width: size.w, height: size.h },
          ))
        } else {
          fitNow()
        }
      }, [L === null, sessionId])

      // 视图变化后落盘（节流：拖拽时不必每帧写）。
      var saveTimer = useRef(0)
      useEffect(function () {
        if (sessionId === undefined) return
        if (saveTimer.current !== 0) window.clearTimeout(saveTimer.current)
        saveTimer.current = window.setTimeout(function () {
          saveView(sessionId, view)
        }, 300)
        return function () {
          if (saveTimer.current !== 0) window.clearTimeout(saveTimer.current)
        }
      }, [view, sessionId])

      // Esc 复位。
      useEffect(function () {
        function onKey(ev) {
          if (ev.key === 'Escape') fitNow()
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [L === null, size.w, size.h])

      // ── 语义分段 ──────────────────────────────────────────────────
      /** 读取配置（打开设置时调用）。 */
      function loadConfig() {
        return fetch('api/topic-map/config', { method: 'GET' })
          .then(function (res) { return res.json() })
          .then(function (payload) {
            if (payload && payload.ok === true) {
              setConfig(payload.value)
              return payload.value
            }
            return null
          }, function () { return null })
      }

      /** 保存配置。 */
      function saveConfig(next) {
        return fetch('api/topic-map/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(next),
        }).then(function (res) { return res.json() }).then(function (payload) {
          if (payload && payload.ok === true) {
            setConfig(payload.value)
            setShowSettings(false)
          }
        }, function () { /* 保存失败就不关闭，用户能看到 */ })
      }

      /** 跑一次模型分析，结果作为预览展示。 */
      var analyzeAbort = useRef(null)
      /** analyzing 的兜底定时器（防止请求挂起导致状态永久卡住）。 */
      var analyzeGuard = useRef(0)

      function runAnalyze() {
        // 用 activeSessionId：面板内可能切到别的会话查看，分析目标必须是
        // "当前正在看的那个"，否则点了按钮却在分析另一个会话，看起来毫无反应。
        var target = activeSessionId
        if (target === undefined || target === null || analyzing) return
        // 取消上一次仍在进行的请求（连点重试时不会堆叠）。
        if (analyzeAbort.current !== null) {
          try { analyzeAbort.current.abort() } catch (e) { /* 忽略 */ }
        }
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        analyzeAbort.current = controller
        setAnalyzing(true)
        setSemantic(null)

        // 轮询进度：三次模型调用耗时几十秒，只转圈用户不知道卡在哪一步。
        startProgressPolling()

        post('analyze', { sessionId: target }, controller === null ? undefined : controller.signal)
          .then(function (result) {
            analyzeAbort.current = null
            stopProgressPolling()
            setSemantic(result)
            setAnalyzing(false)
            // 预览条在面板**底部**。分析完如果只是悄悄出现，用户盯着左树
            // 看不到变化，会以为"点了没效果"。这里滚动到它所在的根容器底部。
            if (typeof window !== 'undefined' && typeof document !== 'undefined') {
              window.requestAnimationFrame(function () {
                var bar = document.querySelector('.dsh_tm_sembar')
                if (bar !== null && typeof bar.scrollIntoView === 'function') {
                  try { bar.scrollIntoView({ block: 'nearest' }) } catch (e) { /* 忽略 */ }
                }
              })
            }
          }, function (e) {
            analyzeAbort.current = null
            stopProgressPolling()
            setAnalyzing(false)
            if (e && e.name === 'AbortError') return
            setSemantic({
              status: 'unavailable',
              reason: e && e.message ? e.message : String(e),
            })
          })

        // 兜底：如果请求因浏览器挂起 / 睡眠而永远不 settle，analyzing 会一直是
        // true，之后点任何按钮都直接 return——表现就是"点了没反应"。
        // 这里给一个硬上限，到点就复位（分析本身仍在 Host 侧继续跑，
        // 结果会通过 progress 轮询恢复）。
        if (analyzeGuard.current !== 0) window.clearTimeout(analyzeGuard.current)
        analyzeGuard.current = window.setTimeout(function () {
          setAnalyzing(function (prev) {
            if (prev === true) {
              // 仍在分析：停掉"转圈"，但结果会由轮询补上
              stopProgressPolling()
            }
            return false
          })
        }, 300000)
      }

      /** 进度轮询的定时器。 */
      var progressTimer = useRef(0)

      /**
       * 进度轮询。
       *
       * 它承担的不只是"显示进度"，还负责**切走再回来时的状态恢复**：
       * 面板卸载后组件状态全丢，但 Host 侧的分析仍在跑、结果也在内存里。
       * 所以每次 tick 都顺带问一次"有没有已经算完等我确认的结果"。
       *
       * @param options - `{ untilDone: boolean }`：跑到结束就自动停。
       */
      function startProgressPolling(options) {
        var opts = options ?? {}
        stopProgressPolling()

        function tick() {
          if (sessionId === undefined) return
          post('progress', { sessionId: sessionId }).then(function (v) {
            if (v === null || v === undefined) return
            setProgress(v)

            // 有待确认的预览：恢复它，让用户切回来就能看到结果
            if (v.hasPending === true && v.pending !== null) {
              setSemantic(function (prev) {
                // 已经在展示同一份就别重复设置，避免打断用户的滚动位置
                if (prev !== null && prev.lanesAfter === v.pending.lanesAfter && prev.lanesBefore === v.pending.lanesBefore) {
                  return prev
                }
                return v.pending
              })
            }

            // 分析已结束：停掉轮询，界面别一直转
            if (v.active !== true) {
              if (opts.untilDone !== false) stopProgressPolling()
              setAnalyzing(false)
            } else {
              setAnalyzing(true)
            }
          }, function () { /* 轮询失败不打扰 */ })
        }

        tick()
        progressTimer.current = window.setInterval(tick, 800)
      }

      function stopProgressPolling() {
        if (progressTimer.current !== 0) {
          window.clearInterval(progressTimer.current)
          progressTimer.current = 0
        }
      }

      /**
       * 挂载即恢复：切走再回来时，把"分析跑到哪了"和"有没有待确认的结果"拿回来。
       *
       * 这是"切走不丢"的核心。之前的问题：组件状态全在 useState 里，
       * 面板一卸载就归零；而 Host 侧的分析其实还在跑、结果也存着。
       * 所以这里挂载后立刻问一次，并持续轮询到分析结束。
       *
       * 只在会话变化时重建，避免每次重渲染都重启轮询。
       */
      useEffect(function () {
        if (sessionId === undefined) return undefined
        startProgressPolling({ untilDone: true })
        return function () { stopProgressPolling() }
      }, [sessionId])

      /** 取消正在进行的分析。 */
      function cancelAnalyze() {
        if (analyzeAbort.current !== null) {
          try { analyzeAbort.current.abort() } catch (e) { /* 忽略 */ }
          analyzeAbort.current = null
        }
        // 通知 Host 在下一步之前停下，并标记为已取消
        if (sessionId !== undefined) {
          post('cancel-analyze', { sessionId: sessionId }).catch(function () { /* 忽略 */ })
        }
        stopProgressPolling()
        setAnalyzing(false)
      }

      /** 采纳预览结果。 */
      function applySemantic() {
        if (sessionId === undefined) return
        post('apply-semantic', { sessionId: sessionId }).then(function (value) {
          setData(value)
          setSemantic(null)
          fittedFor.current = ''
        }, function (e) {
          setSemantic(function (prev) {
            return Object.assign({}, prev, { applyError: e && e.message ? e.message : String(e) })
          })
        })
      }

      /** 放弃模型结果，回到本地规则。 */
      function revertSemantic() {
        if (sessionId === undefined) return
        post('revert-semantic', { sessionId: sessionId }).then(function (value) {
          setData(value)
          setSemantic(null)
          fittedFor.current = ''
        }, function () { setSemantic(null) })
      }

      var selectedFact = selected === null ? null : (byTurn.get(selected) || null)
      var hoverFact = hovered === null ? null : (byTurn.get(hovered) || null)

      /**
       * turn 号 → 锚点 key 的映射。
       *
       * 订阅 `navigation.items()` 这**一个值**而不是在事件回调里调 hook：
       * selector 返回数组，React 的 useSyncExternalStore 会在数组身份变化时
       * 重渲染，因此 `loadThrough` 拉回新历史后这张表自动变长。
       *
       * `items()` 只覆盖已加载的轮次；未加载的轮次不在表里，需要先加载。
       */
      // Hook 必须无条件调用：`conversation.view` 是 session 作用域插槽，
      // `useChat` 由 shell 恒定注入，不存在缺失分支。
      var navItems = useChat(function (s) { return s.navigation.items() })

      var anchorByTurn = useMemo(function () {
        var m = new Map()
        if (!Array.isArray(navItems)) return m
        for (var i = 0; i < navItems.length; i += 1) {
          var it = navItems[i]
          if (it && typeof it.turn === 'number' && typeof it.anchorKey === 'string') {
            m.set(it.turn, it.anchorKey)
          }
        }
        return m
      }, [navItems])

      // 跳转是异步的（loadThrough → 渲染 → 重试），回调里必须读**最新**的映射，
      // 而不是发起跳转那一刻的快照。用 ref 跟随渲染更新。
      var anchorRef = useRef(anchorByTurn)
      effectAssign(anchorRef, anchorByTurn)

      /**
       * 跳到某一轮。
       *
       * 切回对话视图、确保该轮已加载、定位并滚动。
       *
       * 两个必须应对的机制：
       *
       * 1. **切换视图**不能靠 `tabs[0].click()` 盲点第一个 tab——那只在"对话"
       *    恰好是第一个时才对。用 shell 提供的 `openView('chat')`。
       * 2. **跟随底部会把滚动弹回去**。Chat 的 `ChatReading.onScroll` 里：
       *    `if (!scroll.movedByReader && followingTail) followTail()`，而
       *    `onResize()` 在 `followingTail` 为真时同样会 `followTail()`。
       *    也就是说，只要视图认为"读者在底部"，任何非读者触发的滚动都会被
       *    立刻拉回底部。我们滚动后必须**保持住**，并在随后的几帧里复查。
       */
      function jumpTo(turnNo) {
        var fact = byTurn.get(turnNo)
        if (fact === undefined) return

        // 优先用 shell 的视图切换；拿不到才退回点 tab。
        if (typeof props.openView === 'function') {
          try { props.openView('chat', '') } catch (e) { /* 退回下面 */ }
        }
        if (typeof props.openView !== 'function') {
          var tabs = document.querySelectorAll('[role="tablist"] button[role="tab"]')
          for (var ti = 0; ti < tabs.length; ti += 1) {
            var label = (tabs[ti].textContent || '').trim()
            if (label === '对话' || label.toLowerCase() === 'chat') { tabs[ti].click(); break }
          }
        }

        var binding = sessionId === undefined || SESSION_SERVICE === null
          ? undefined : SESSION_SERVICE.binding(sessionId)

        var attempts = 0
        var settled = false

        /**
         * 把目标行保持在顶端，直到它稳定下来。
         *
         * **为什么不能锁一个固定的 `scrollTop`**：定位那一刻算出的绝对位置，
         * 在内容继续变化后就失效了。跳转之后常见的变化有：图片解码出高度、
         * 代码块高亮、过程分组折叠动画收放、字体度量生效。这些都会让目标行
         * 在文档里上移或下移，锁定旧像素值的结果就是**部分轮次**偏掉——
         * 偏移量恰好等于那一段内容的高度变化。
         *
         * 因此每一帧**重新测量目标行相对容器的位置**并纠正，而不是记住数字。
         * 这样内容怎么变，行都贴着顶端。
         *
         * 退出条件有两个，都很重要：
         *
         * - 读者自己滚动（wheel / touch / 按键 / 指针按下）→ 立刻放手。
         *   继续抢滚动条会让人无法阅读。
         * - 超过时长上限 → 放手。目标行被卸载（例如那一段被折叠）时也要能退出。
         */
        function pinToTop(scroller, el, raf) {
          if (scroller === null || typeof scroller.scrollTop !== 'number') return
          if (el === null || typeof el.isConnected !== 'boolean') return
          // 帧调度允许注入：测试环境没有 window，而这条逻辑值得被验证。
          var schedule = raf || (typeof window !== 'undefined' ? window.requestAnimationFrame.bind(window) : null)
          if (schedule === null) return

          var frames = 0
          var released = false
          var lastWritten = scroller.scrollTop

          function release() { released = true }
          var events = ['wheel', 'touchstart', 'keydown', 'pointerdown']
          for (var e = 0; e < events.length; e += 1) {
            scroller.addEventListener(events[e], release, { passive: true, once: true })
          }

          /** 目标行当前应当在容器里的顶端偏移。 */
          function desiredTop() {
            var box = scroller.getBoundingClientRect()
            var row = el.getBoundingClientRect()
            return Math.max(0, scroller.scrollTop + (row.top - box.top) - REVEAL_TOP_PAD)
          }

          function verify() {
            if (released) return

            // 目标行被移出文档（折叠、换视图、重新渲染）时没有纠正的意义。
            if (!el.isConnected) { released = true; return }

            var wanted = desiredTop()
            var now = scroller.scrollTop

            // 位置被别人改动，且不是我们上一帧写下的值 -> 读者在滚动，放手。
            if (Math.abs(now - lastWritten) > 4 && Math.abs(now - wanted) > 4) {
              released = true
              return
            }
            if (Math.abs(now - wanted) > 1) {
              scroller.scrollTop = wanted
              lastWritten = scroller.scrollTop
            } else {
              lastWritten = now
            }

            frames += 1
            if (frames < 90) schedule(verify)
          }
          schedule(verify)
        }

        /**
         * 跳转过程记录，供诊断按钮展示。
         *
         * 每次跳转都留下痕迹：走了哪条分支、当时的容器尺寸、最终落点。
         * 这样"tab 切过去了但位置不对"能立刻区分为三种情况之一：
         *   命中失败（分支 A/B/C 都没找到行）
         *   滚动了但被覆盖（记录里的 requested 与 actual 不一致）
         *   行本身不可见（候选行存在但高度为 0）
         */
        var trace = { turn: turnNo, startedAt: Date.now(), steps: [], outcome: 'pending' }
        JUMP_TRACE = trace

        function note(step, extra) {
          trace.steps.push(Object.assign({ step: step, at: Date.now() - trace.startedAt }, extra || {}))
        }

        function attempt() {
          if (settled) return
          attempts += 1

          var scroller = chatScroller()
          var hit = null

          if (attempts === 1) {
            note('begin', {
              hasScroller: scroller !== null,
              scrollerHeight: scroller === null ? 0 : Math.round(scroller.scrollHeight),
              anchorKey: anchorRef.current.get(turnNo) ?? null,
            })
          }

          var key = anchorRef.current.get(turnNo)

          // 一级：按 anchorKey 精确命中。`navigation.items()` 给的 anchorKey
          // 指向该轮**用户消息**那个节点，正是"从这句话开始读"的落点。
          //
          // 为什么它优先于 `data-chat-turn`：后者标在轮的外层容器上，而容器的
          // 顶部往往是过程分组（thinking / 工具调用）而不是用户输入。仅靠它
          // 定位，落点会停在过程行——这就是"部分轮次偏"的来源。
          if (key !== undefined) {
            hit = findTurnRow(key, scroller)
            if (hit !== null) note('hit-anchor', { attempt: attempts })
          }

          // 二级：`data-chat-turn` 兜底。该轮尚未进入已加载窗口、或 anchorKey
          // 缺失时用它，至少能落在这一轮附近。
          if (hit === null) {
            hit = findRowByTurn(turnNo, scroller)
            if (hit !== null) note('hit-turn', { attempt: attempts })
          }

          if (hit !== null) {
            var applied = revealRow(hit, scroller)
            // 关键：钉住的是**元素**，不是那一刻算出的像素。跳转后图片解码、
            // 代码高亮、分组折叠都会改变目标行的位置，只有持续重测才对得上。
            pinToTop(scroller, hit)

            // 记录落点与目标行的最终偏差，供诊断判断"还差多少"。
            var landedAt = Math.round(scroller.scrollTop)
            var rowNow = hit.getBoundingClientRect()
            var boxNow = scroller === null ? null : scroller.getBoundingClientRect()
            note('scrolled', {
              requested: typeof applied === 'number' ? Math.round(applied) : null,
              actual: landedAt,
              rowOffsetFromTop: boxNow === null ? null : Math.round(rowNow.top - boxNow.top),
              rowHeight: Math.round(rowNow.height),
              flowKind: hit.getAttribute('data-chat-flow-kind') || null,
            })
            trace.outcome = 'scrolled'
            settled = true
            return
          }

          // 尚未加载完，或已加载但还没渲染：稍后重试。
          if (attempts < 24) {
            window.setTimeout(attempt, attempts < 8 ? 60 : 160)
            return
          }

          // 三级兜底：滚到最接近的下一轮。总比什么都不发生好。
          var near = findTurnRowAtOrAfter(turnNo, scroller)
          if (near !== null) {
            var fallback = revealRow(near, scroller)
            pinToTop(scroller, near)
            note('fallback-at-or-after', { requested: typeof fallback === 'number' ? Math.round(fallback) : null })
            trace.outcome = 'fallback'
          } else {
            note('not-found', { probe: probeChatDom() })
            trace.outcome = 'miss'
            try { console.warn('[topic-map] 跳转未命中 turn ' + turnNo, probeChatDom()) }
            catch (e) { /* 诊断本身不能打断跳转 */ }
          }
          settled = true
        }

        if (binding !== undefined && typeof binding.session.loadThrough === 'function') {
          var p
          try { p = binding.session.loadThrough(fact.startSeq) } catch (e) { p = null }
          if (p !== null && typeof p.then === 'function') p.then(attempt, attempt)
          else attempt()
        } else {
          attempt()
        }
      }

      if (sessionId === undefined) {
        return h('div', { className: 'dsh_tm_root' },
          h('div', { className: 'dsh_tm_empty' },
            h('div', null, t('noSession')),
            h('div', { className: 'dsh_tm_diag' }, 'props.sessionId 为空')))
      }
      if (error !== null) {
        return h('div', { className: 'dsh_tm_root' },
          h('div', { className: 'dsh_tm_empty' },
            h('div', null, t('unavailable')),
            h('div', { className: 'dsh_tm_diag' }, error),
            h('div', { className: 'dsh_tm_diag' }, '会话 ' + sessionId)))
      }
      if (data === null || loading) {
        return h('div', { className: 'dsh_tm_root' },
          h('div', { className: 'dsh_tm_empty' },
            h('div', null, t('loading')),
            h('div', { className: 'dsh_tm_diag' }, '会话 ' + sessionId)))
      }
      if (data.turns.length === 0) {
        return h('div', { className: 'dsh_tm_root' },
          h('div', { className: 'dsh_tm_empty' },
            h('div', null, t('empty')),
            h('div', { className: 'dsh_tm_diag' }, '会话 ' + sessionId)))
      }
      if (L === null) {
        return h('div', { className: 'dsh_tm_root' }, h('div', { className: 'dsh_tm_empty' }, t('unavailable')))
      }

      var costLabel = data.cost && data.cost.label ? data.cost.label : null
      var cols = data.graph.columnCount

      // 左栏按三层树渲染：阶段 → 工作流 → 任务。
      //
      // 有 stages 时用树；没有时退回平铺（本地规则的结果）。
      // 折叠状态存在组件里，点一下展开/收起，不影响图。
      var trackItems = []
      var laneById = new Map()
      data.lanes.forEach(function (lane) { laneById.set(lane.laneId, lane) })

      /** 渲染一条任务（映射到一条泳道）。 */
      function renderTask(name, turns, depth) {
        // 任务在泳道里的对应项：按轮次首个 turn 找
        var lane = null
        if (Array.isArray(turns) && turns.length > 0) {
          for (var i = 0; i < data.lanes.length; i += 1) {
            var ls = data.lanes[i].turns
            if (Array.isArray(ls) && ls.length > 0 && ls[0] === turns[0]) { lane = data.lanes[i]; break }
          }
        }
        // 筛选生效时，被隐藏的泳道在左栏也不显示——否则点它会聚焦到画不出来的行。
        if (filterActive && lane !== null && !visibleLaneIds.has(lane.laneId)) return null
        var col = 0
        if (lane !== null) {
          // 用 L（已按筛选重排）而不是 data.graph，否则筛选后左栏色条会指到错误的行。
          var cols2 = L === null ? data.graph.columns : L.nodes
          for (var k = 0; k < cols2.length; k += 1) {
            if (cols2[k].laneId === lane.laneId) { col = cols2[k].col; break }
          }
        }
        var on = lane !== null && highlightLane === lane.laneId
        // 状态点：取该任务首个轮次的结束原因推断。
        // 这不是真正的任务状态（日志里没有那个字段），只是"这一轮怎么结束的"。
        var dotColor = 'var(--tm-text3)'
        if (Array.isArray(turns) && turns.length > 0) {
          var firstFact = byTurn.get(turns[0])
          if (firstFact !== undefined) {
            if (firstFact.endReason === 'open') dotColor = 'var(--tm-ok)'
            else if (firstFact.endReason === 'error') dotColor = 'var(--tm-err)'
            else if (firstFact.endReason === 'max-tokens') dotColor = 'var(--tm-warn)'
            else dotColor = 'var(--tm-accent)'
          }
        }
        // 状态点：用 PM 推导结果（不是"首轮怎么结束的"那种粗糙推断）。
        // 手动覆盖过的任务会带一个实心描边，区分"我标的"与"推导的"。
        var pmDetail = lane === null ? null : pmState.detailOf(lane.laneId)
        var pmMeta = pmDetail === null ? null : PM.STATE_META[pmDetail.state]
        var dotColor = STATUS_COLOR[pmDetail === null ? 'todo' : pmDetail.state]

        // 这一行包含的轮次，供"点节点时滚到这里"定位用。
        var turnsAttr = Array.isArray(turns) ? turns.join(' ') : ''
        // 选中轮次是否落在本任务里 —— 是则整行高亮，与图上选中色一致。
        var containsSelected = selected !== null && Array.isArray(turns)
          && turns.indexOf(selected) >= 0

        // 缩进直接写在内层，而不是靠 CSS 属性选择器。
        //
        // 之前的 bug：`data-depth` 挂在**外层** div 上，而 CSS 选择的是
        // `.dsh_tm_trackitem[data-depth="N"]`——内层。两者对不上，于是
        // 三级任务完全没有缩进，看起来和一级平级。
        //
        // 现在把深度同时挂在两层，并用内联 padding 保底：即使 CSS 没生效，
        // 缩进也是对的。
        var indent = depth === 0 ? 0 : depth === 1 ? 22 : 38
        return h('div', {
          key: 'task:' + name + ':' + (Array.isArray(turns) ? turns[0] : 0),
          className: 'dsh_tm_taskrow',
          'data-on': on ? '1' : undefined,
          'data-selected': containsSelected ? '1' : undefined,
          'data-turns': turnsAttr,
          'data-depth': String(depth),
          style: { paddingLeft: indent + 'px' },
        },
          // 主体：点一下聚焦该泳道，并选中它的第一个轮次
          h('button', {
            type: 'button',
            className: 'dsh_tm_trackitem dsh_tm_taskmain',
            'data-depth': String(depth),
            title: name + '（点击聚焦该泳道并查看第一个轮次）',
            onClick: function () {
              if (lane === null) return
              focusLane(on ? null : lane.laneId)
              // 双向联动的另一半：点任务 → 图上选中它的首个轮次并显示详情。
              // 已经选中本任务内的某一轮时，再点保持不动（避免把用户选好的轮次顶掉）。
              if (!containsSelected && Array.isArray(turns) && turns.length > 0) {
                selectTurn(turns[0], { fold: false })
              }
            },
          },
            h('span', { className: 'dsh_tm_swatch', style: { background: trackColor(col) } }),
            h('span', { className: 'dsh_tm_tracktext' }, name),
            h('span', { className: 'dsh_tm_trackn' }, String(Array.isArray(turns) ? turns.length : 0)),
          ),
          // 状态胶囊：点一下在四种状态间循环，Alt+点清除覆盖
          lane === null
            ? null
            : h('button', {
                type: 'button',
                className: 'dsh_tm_state',
                'data-state': pmDetail.state,
                'data-overridden': pmDetail.overridden ? '1' : undefined,
                'data-source': pmDetail.overridden ? 'manual' : (pmDetail.fromModel ? 'model' : 'local'),
                title: (pmDetail.overridden
                  ? '你手动标注：'
                  : pmDetail.fromModel ? '模型复核：' : '本地推导：') + pmDetail.basis
                  + '（点击切换，Alt+点击恢复推导）',
                onClick: function (ev) {
                  ev.stopPropagation()
                  if (ev.altKey) { setTaskState(lane.laneId, null); return }
                  var order = PM.TASK_STATES
                  var i = order.indexOf(pmDetail.state)
                  setTaskState(lane.laneId, order[(i + 1) % order.length])
                },
              },
                h('span', { className: 'dsh_tm_statedot', style: { background: dotColor } }),
                pmMeta === null ? '?' : pmMeta.label,
              ),
        )
      }

      if (Array.isArray(data.stages) && data.stages.length > 0) {
        data.stages.forEach(function (stage, si) {
          // 折叠键用**名字**而不是位置索引：重新分析后阶段顺序可能变，
          // 用索引会把"展开/收起"错位到别的节点上。
          var stageKey = FOLD.stageKey(stage.name)
          var stageOpen = collapsed[stageKey] !== true

          // 阶段进度：按任务状态加权（完成 1 / 进行中 0.5 / 阻塞 0.25）。
          // 这与"数一数有几个任务"不同——全待办的阶段不该显示 0%，
          // 全阻塞的也不该是 0，它们表达的是"在但没推进"。
          var stageLaneIds = []
          for (var li = 0; li < data.lanes.length; li += 1) {
            if (data.lanes[li].stageName === stage.name) stageLaneIds.push(data.lanes[li].laneId)
          }
          var progress = PM.stageProgress(stageLaneIds, pmState.stateOf)

          trackItems.push(h('div', { key: stageKey, className: 'dsh_tm_tree' },
            h('button', {
              type: 'button',
              className: 'dsh_tm_cathead',
              'data-depth': '0',
              title: stageOpen ? '收起' : '展开',
              onClick: function () { toggle(stageKey) },
            },
              h('span', { className: 'dsh_tm_caret' }, stageOpen ? '▾' : '▸'),
              h('span', { className: 'dsh_tm_catbar', style: { background: trackColor(si) } }),
              h('span', { className: 'dsh_tm_catname' }, stage.name),
              // "新增未归类"阶段是分析之后才出现的，给它一个明确的说明与入口。
              // 不自动归类（那会花 token），但要让用户知道"点一下就归"。
              stage.isUnclassified
                ? h('button', {
                    type: 'button',
                    className: 'dsh_tm_uncbtn',
                    // 说明写清楚：这不是"点一下就完事"，分析完还要确认。
                    // 之前只写"点此归类"，用户点完发现左树没变，以为坏了。
                    title: '这些是上次分析之后的对话，还没归类。'
                      + '点这里重新分析（会调用模型，约 1 分钟），分析完会出现预览条，'
                      + '再点「采纳」才会生效。',
                    onClick: function (ev) {
                      ev.stopPropagation()
                      runAnalyze()
                    },
                  }, analyzing ? '分析中…' : '归类')
                : null,
              // 迷你进度条 + 百分比
              // 主信息用计数（"3/5"是事实），百分比只在悬停里作为参考
              h('span', {
                className: 'dsh_tm_pbar',
                title: progress.done + '/' + progress.total + ' 完成'
                  + '（加权参考 ' + progress.percent + '%：完成 1、进行中 0.5、阻塞 0.25）',
              },
                h('i', { style: { width: progress.percent + '%', background: trackColor(si) } }),
              ),
              h('span', { className: 'dsh_tm_catn' }, progress.done + '/' + progress.total),
            ),

            stageOpen
              ? (stage.workflows || []).map(function (wf, wi) {
                  // 折平的层（阶段与工作流同名）不再画一层标题。
                  // 注意这里任务实际是第 2 级（阶段 → 任务），深度要传 2，
                  // 否则它会和「工作流」那一层平级，看不出从属关系。
                  if (wf.collapsed === true) {
                    return h('div', { key: stageKey + ':flat' },
                      (wf.tasks || []).map(function (t) { return renderTask(t.name, t.turns, 2) }))
                  }
                  var wfKey = FOLD.workflowKey(stage.name, wf.name)
                  var wfOpen = collapsed[wfKey] !== true
                  return h('div', { key: wfKey },
                    h('button', {
                      type: 'button',
                      className: 'dsh_tm_cathead',
                      'data-depth': '1',
                      title: wfOpen ? '收起' : '展开',
                      onClick: function () { toggle(wfKey) },
                    },
                      h('span', { className: 'dsh_tm_caret' }, wfOpen ? '▾' : '▸'),
                      h('span', { className: 'dsh_tm_catname' }, wf.name),
                      h('span', { className: 'dsh_tm_catn' },
                        String((wf.tasks || []).reduce(function (s, t) { return s + (t.turns || []).length }, 0))),
                    ),
                    wfOpen
                      ? (wf.tasks || []).map(function (t) { return renderTask(t.name, t.turns, 2) })
                      : null,
                  )
                })
              : null,
          ))
        })
      } else {
        // 没有层级信息：平铺按话题顺序列出。
        data.lanes.forEach(function (lane) { trackItems.push(renderTrackItem(lane)) })
      }

      /** 渲染一条话题（平铺模式用）。 */
      function renderTrackItem(lane) {
        var col = 0
        for (var i = 0; i < data.graph.columns.length; i += 1) {
          if (data.graph.columns[i].laneId === lane.laneId) { col = data.graph.columns[i].col; break }
        }
        var on = highlightLane === lane.laneId
        return h('button', {
          key: lane.laneId,
          type: 'button',
          className: 'dsh_tm_trackitem',
          'data-on': on ? '1' : undefined,
          title: lane.title,
          onClick: function () { focusLane(on ? null : lane.laneId) },
        },
          h('span', { className: 'dsh_tm_swatch', style: { background: trackColor(col) } }),
          h('span', { className: 'dsh_tm_tracktext' }, lane.title),
          h('span', { className: 'dsh_tm_trackn' }, String(lane.turns.length)),
        )
      }

      var detail
      if (selectedFact === null) {
        detail = h('div', { className: 'dsh_tm_dscroll' },
          h('div', { className: 'dsh_tm_dhead' }, h('span', { className: 'dsh_tm_sect' }, '会话总览')),
          h('div', { className: 'dsh_tm_grid' },
            cell('轮次', String(data.totals.turns)),
            cell('轨道', String(cols)),
            cell('输入', fmtTokens(data.totals.input)),
            cell('输出', fmtTokens(data.totals.output)),
            cell('命中', fmtTokens(data.totals.cacheRead)),
            cell('工具', String(data.totals.toolCalls)),
          ),
          costLabel !== null
            ? h('div', { className: 'dsh_tm_kv' }, h('span', null, '会话费用'), h('b', null, costLabel))
            : null,
          h('div', { className: 'dsh_tm_hint' }, '点击任意圆点查看该轮详情'),
        )
      } else {
        var f = selectedFact
        // 这一轮在层级里的位置：让详情能回答"这属于哪个阶段/工作流/任务"。
        var laneOfTurn = null
        for (var li2 = 0; li2 < data.lanes.length; li2 += 1) {
          var laneTurns = data.lanes[li2].turns
          if (Array.isArray(laneTurns) && laneTurns.indexOf(f.turn) >= 0) { laneOfTurn = data.lanes[li2]; break }
        }
        var pathEls = []
        if (laneOfTurn !== null) {
          if (laneOfTurn.stageName) pathEls.push(laneOfTurn.stageName)
          if (laneOfTurn.workflowName && laneOfTurn.workflowName !== laneOfTurn.stageName) pathEls.push(laneOfTurn.workflowName)
          if (laneOfTurn.title) pathEls.push(laneOfTurn.title)
        }

        detail = h('div', { className: 'dsh_tm_dscroll' },
          h('div', { className: 'dsh_tm_dhead' },
            h('span', { className: 'dsh_tm_dturn' }, 'T' + f.turn),
            h('span', { className: 'dsh_tm_pill', 'data-tone': END_TONE[f.endReason] || undefined },
              END_LABEL[f.endReason] || f.endReason),
            f.steering > 0 ? h('span', { className: 'dsh_tm_pill' }, '插话 ' + f.steering) : null,
          ),
          pathEls.length > 0
            ? h('div', { className: 'dsh_tm_path' }, pathEls.join(' › '))
            : null,
          // 这一轮所属任务的状态与依赖：回答"这件事卡在哪、被谁挡着"。
          laneOfTurn !== null
            ? (function () {
                var d = pmState.detailOf(laneOfTurn.laneId)
                var meta = PM.STATE_META[d.state]
                // 与当前任务相关的依赖：谁是它的前置、它挡住了谁
                var blockedBy = pmState.dependencies.filter(function (x) { return x.to === laneOfTurn.laneId })
                var blocking = pmState.dependencies.filter(function (x) { return x.from === laneOfTurn.laneId })
                var titleOf = function (laneId) {
                  for (var q = 0; q < data.lanes.length; q += 1) {
                    if (data.lanes[q].laneId === laneId) return data.lanes[q].title
                  }
                  return laneId
                }
                return h('div', { className: 'dsh_tm_pm' },
                  h('div', { className: 'dsh_tm_pmrow' },
                    h('span', { className: 'dsh_tm_statedot', style: { background: STATUS_COLOR[d.state] } }),
                    h('span', { className: 'dsh_tm_pmstate' }, meta === undefined ? d.state : meta.label),
                    h('span', { className: 'dsh_tm_pmnote' },
                      (d.overridden ? '手动标注' : '推导') + '：' + d.basis),
                  ),
                  blockedBy.length > 0
                    ? h('div', { className: 'dsh_tm_pmdep' },
                        h('span', { className: 'dsh_tm_pmlabel' }, '前置未完成'),
                        blockedBy.map(function (x, xi) {
                          return h('div', { key: 'bb' + xi, className: 'dsh_tm_pmdepitem' },
                            '⚠ ' + titleOf(x.from), ' — ', x.reason)
                        }),
                      )
                    : null,
                  blocking.length > 0
                    ? h('div', { className: 'dsh_tm_pmdep' },
                        h('span', { className: 'dsh_tm_pmlabel' }, '它挡住了'),
                        blocking.map(function (x, xi) {
                          return h('div', { key: 'bk' + xi, className: 'dsh_tm_pmdepitem' },
                            '→ ' + titleOf(x.to))
                        }),
                      )
                    : null,
                )
              })()
            : null,
          h('div', { className: 'dsh_tm_prompt' }, f.prompt || '（无文本）'),
          f.response !== '' ? h('div', { className: 'dsh_tm_reply' }, f.response) : null,
          h('div', { className: 'dsh_tm_sect' }, '用量'),
          h('div', { className: 'dsh_tm_grid' },
            cell('输入', fmtTokens(f.usage.input)),
            cell('输出', fmtTokens(f.usage.output)),
            cell('命中', fmtTokens(f.usage.cacheRead)),
            cell('缓存写', fmtTokens(f.usage.cacheWrite)),
          ),
          h('div', { className: 'dsh_tm_kv' }, h('span', null, '耗时'), h('b', null, fmtDuration(f.durationMs))),
          h('div', { className: 'dsh_tm_kv' }, h('span', null, '步数'), h('b', null, String(f.steps))),
          h('div', { className: 'dsh_tm_kv' }, h('span', null, '工具调用'), h('b', null, String(f.toolCalls))),
          h('div', { className: 'dsh_tm_kv' }, h('span', null, '涉及文件'), h('b', null, String(f.files.length))),
          f.model !== null
            ? h('div', { className: 'dsh_tm_kv' }, h('span', null, '模型'), h('b', null, f.model.model))
            : null,
        )
      }

      return h('div', { className: 'dsh_tm_root' },
        h('div', { className: 'dsh_tm_bar' },
          h('span', { className: 'dsh_tm_brand' },
            h('span', { className: 'dsh_tm_dotlogo' }), t('title')),
          h('span', { className: 'dsh_tm_kpis' },
            // PM 视角：先看任务状态分布，再看规模。这是"项目管理视角"的核心一眼信息。
            h('span', { className: 'dsh_tm_kpi dsh_tm_kpistate', 'data-state': 'done' },
              h('span', { className: 'dsh_tm_statedot', style: { background: STATUS_COLOR.done } }),
              h('b', null, String(pmState.counts.done)), ' 完成'),
            h('span', { className: 'dsh_tm_kpi dsh_tm_kpistate', 'data-state': 'active' },
              h('span', { className: 'dsh_tm_statedot', style: { background: STATUS_COLOR.active } }),
              h('b', null, String(pmState.counts.active)), ' 进行'),
            pmState.counts.blocked > 0
              ? h('span', { className: 'dsh_tm_kpi dsh_tm_kpistate', 'data-state': 'blocked' },
                  h('span', { className: 'dsh_tm_statedot', style: { background: STATUS_COLOR.blocked } }),
                  h('b', null, String(pmState.counts.blocked)), ' 阻塞')
              : null,
            pmState.counts.todo > 0
              ? h('span', { className: 'dsh_tm_kpi dsh_tm_kpistate', 'data-state': 'todo' },
                  h('span', { className: 'dsh_tm_statedot', style: { background: STATUS_COLOR.todo } }),
                  h('b', null, String(pmState.counts.todo)), ' 待办')
              : null,
            h('span', { className: 'dsh_tm_kpiseP' }, ''),
            h('span', { className: 'dsh_tm_kpi' }, h('b', null, String(data.totals.turns)), ' 轮'),
            h('span', { className: 'dsh_tm_kpi' }, h('b', null, fmtTokens(data.totals.input + data.totals.output)), ' tokens'),
            costLabel !== null ? h('span', { className: 'dsh_tm_kpi' }, h('b', null, costLabel)) : null,
          ),
          h('span', { className: 'dsh_tm_grow' }),
          h('span', { className: 'dsh_tm_tools' },
            h('button', {
              type: 'button', className: 'dsh_tm_ico', title: '缩小（或滚轮）',
              onClick: function () {
                var cx = size.w / 2
                var cy = size.h / 2
                setView(function (prev) {
                  return VIEWPORT.zoomAt(prev, cx, cy, prev.scale / 1.25,
                    { width: L.width, height: L.height },
                    { width: size.w, height: size.h })
                })
              },
            }, '−'),
            h('button', {
              type: 'button', className: 'dsh_tm_ico', title: '放大（或滚轮）',
              onClick: function () {
                var cx = size.w / 2
                var cy = size.h / 2
                setView(function (prev) {
                  return VIEWPORT.zoomAt(prev, cx, cy, prev.scale * 1.25,
                    { width: L.width, height: L.height },
                    { width: size.w, height: size.h })
                })
              },
            }, '+'),
            h('button', {
              type: 'button', className: 'dsh_tm_ico',
              title: '复位到全览（或双击空白 / Esc）',
              onClick: fitNow,
            }, '⤢'),
            h('button', {
              type: 'button', className: 'dsh_tm_ico', 'data-on': highlightLane !== null ? '1' : undefined,
              title: '清除筛选', onClick: function () { setHighlightLane(null) },
            }, '⚲'),
            h('button', {
              type: 'button', className: 'dsh_tm_ico',
              'data-on': semantic !== null || analyzing ? '1' : undefined,
              title: analyzing ? '取消分析' : '用模型精化分段（会调用模型，先预览再确认）',
              onClick: function () { if (analyzing) cancelAnalyze(); else runAnalyze() },
            }, analyzing ? '◼' : '✦'),
            h('button', {
              type: 'button', className: 'dsh_tm_ico',
              'data-on': review !== null || reviewing ? '1' : undefined,
              title: reviewing
                ? '取消状态复核'
                : '让模型复核任务状态（会读取对话内容，仅复核可疑的任务）',
              onClick: function () { if (reviewing) cancelReview(); else runReview() },
            }, reviewing ? '◼' : '◎'),
            h('button', {
              type: 'button', className: 'dsh_tm_ico',
              'data-on': themeChoice !== 'auto' ? '1' : undefined,
              title: THEME.themeLabel(themeChoice, resolvedTheme).title,
              onClick: cycleTheme,
            }, THEME.themeLabel(themeChoice, resolvedTheme).icon),
            // 着色模式切换：话题色 ⇄ 状态色
            h('button', {
              type: 'button', className: 'dsh_tm_ico',
              'data-on': gmode === 'status' ? '1' : undefined,
              title: GMODE.graphModeLabel(gmode).title,
              onClick: cycleGraphMode,
            }, GMODE.graphModeLabel(gmode).icon),
            h('button', {
              type: 'button', className: 'dsh_tm_ico', 'data-on': showSettings ? '1' : undefined,
              title: '语义分段设置（模型、轮次上限）',
              onClick: function () {
                var next = !showSettings
                setShowSettings(next)
                if (next) loadConfig()
              },
            }, '⚙'),
            h('button', {
              type: 'button', className: 'dsh_tm_ico', 'data-on': diag !== null ? '1' : undefined,
              title: '诊断：检查对话 DOM 与跳转过程',
              onClick: function () {
                setDiag(diag === null
                  ? formatProbe({ jump: JUMP_TRACE, dom: probeChatDom() })
                  : null)
              },
            }, '⌕'),
          ),
        ),
        diag !== null
          ? h('div', { className: 'dsh_tm_diagbox' },
              h('div', { className: 'dsh_tm_diaghead' },
                h('span', null, '诊断结果'),
                h('button', {
                  type: 'button', className: 'dsh_tm_diagclose',
                  onClick: function () { setDiag(null) },
                }, '×'),
                h('button', {
                  type: 'button', className: 'dsh_tm_diagclose',
                  title: '复制',
                  onClick: function () {
                    try { navigator.clipboard.writeText(diag) } catch (e) { /* 忽略 */ }
                  },
                }, '复制'),
              ),
              h('pre', { className: 'dsh_tm_diagpre' }, diag),
            )
          : null,
        semantic !== null
          ? h(SemanticPreview, {
              result: semantic,
              onApply: applySemantic,
              onRevert: revertSemantic,
              onClose: function () { setSemantic(null) },
              onRetry: runAnalyze,
            })
          : null,
        showSettings
          ? h(SettingsPopover, {
              config: config,
              onSave: saveConfig,
              onClose: function () { setShowSettings(false) },
            })
          : null,
        // 分析进度：分三步显示，让用户知道卡在哪
        progress !== null
          ? h(ProgressBar, {
              progress: progress,
              onDismiss: function () { setProgress(null) },
            })
          : null,
        // 复核结果提示条：说明这次复核了什么、用的哪个模型
        review !== null
          ? h('div', { className: 'dsh_tm_revbar' },
              h('span', { className: 'dsh_tm_revtitle' }, '状态复核'),
              review.status === 'unavailable'
                ? h('span', { className: 'dsh_tm_semwarn' }, review.reason || '不可用')
                : review.status === 'partial'
                  ? h('span', { className: 'dsh_tm_semwarn' }, review.reason || '部分失败')
                  : h('span', { className: 'dsh_tm_semnote' },
                      '复核 ' + review.reviewed + '/' + review.total + ' 条',
                      review.via === 'custom' ? ' · 自定义端点' : '',
                      review.fellBack ? ' · 已回退' : ''),
              review.status === 'ready' && review.note
                ? h('span', { className: 'dsh_tm_semnote' }, review.note)
                : null,
              h('span', { className: 'dsh_tm_grow' }),
              h('button', {
                type: 'button', className: 'dsh_tm_diagclose',
                title: '清除复核结果，回到本地判定',
                onClick: function () {
                  setReview(null)
                  if (sessionId !== undefined) {
                    post('ui-state', { sessionId: sessionId, patch: { review: null } })
                      .catch(function () { /* 忽略 */ })
                  }
                },
              }, '清除'),
            )
          : null,
        h(FilterBar, {
          filter: filter,
          stages: stageOptions,
          open: filterOpen,
          counts: filtered.counts,
          onChange: patchFilter,
          onOpenChange: setFilterOpen,
          onClear: function () {
            var empty = FILTER.emptyFilter()
            setFilter(empty)
            persistFilter(empty)
          },
          onToggleInList: function (field, value) {
            setFilter(function (prev) {
              var next = Object.assign({}, prev)
              next[field] = toggleInList(prev[field], value)
              persistFilter(next)
              return next
            })
          },
        }),
        // 上层：工作区会话树（跨会话入口）
        h(SessionTree, {
          state: Object.assign({}, sessionTree, { currentSessionId: activeSessionId }),
          onWorkspace: switchWorkspace,
          onCategorize: recategorize,
          onRefresh: function () { loadWorkspaceTree(sessionTree.workspaceId) },
          onToggleFold: toggleTreeFold,
          findQuery: findQuery,
          findHint: findHint,
          onFindInput: onFindInput,
          onOpenSession: function (id) {
            // 面板内切换会话：平台会话不变，只换本面板读的是哪个
            setViewedSessionId(id === sessionId ? null : id)
            setSelected(null)
            setSemantic(null)
            setReview(null)
            setFindHits(null)
            setFindHint('')
            setFindQuery('')
            patchTree({ currentSessionId: id })
          },
        }),
        // 检索结果（有结果时才显示）
        h(SearchResults, {
          hits: findHits,
          onOpen: function (id, turn) {
            setViewedSessionId(id === sessionId ? null : id)
            setSelected(turn === null || turn === undefined ? null : turn)
            setSemantic(null)
            setFindHits(null)
            patchTree({ currentSessionId: id })
          },
        }),
        h('div', { className: 'dsh_tm_body' },
          h('div', { className: 'dsh_tm_side' },
            h('div', { className: 'dsh_tm_sidehead' },
              h('span', { className: 'dsh_tm_sidetitle' }, '话题'),
              // 三按钮：一键切换展开粒度。精密分析后三层全展开一屏放不下。
              h('div', { className: 'dsh_tm_foldbtns' },
                h('button', {
                  type: 'button', className: 'dsh_tm_foldbtn',
                  'data-on': foldModeName === 'all' ? '1' : undefined,
                  title: '全部展开',
                  onClick: function () { applyFold('all') },
                }, '⊞'),
                h('button', {
                  type: 'button', className: 'dsh_tm_foldbtn',
                  'data-on': foldModeName === 'stages' ? '1' : undefined,
                  title: '只看阶段（收起工作流）',
                  onClick: function () { applyFold('stages') },
                }, '⊟'),
                h('button', {
                  type: 'button', className: 'dsh_tm_foldbtn',
                  'data-on': foldModeName === 'none' ? '1' : undefined,
                  title: '全部折叠',
                  onClick: function () { applyFold('none') },
                }, '⊠'),
              ),
            ),
            h('div', { className: 'dsh_tm_tracks', ref: treeRef }, trackItems),
          ),
          h('div', {
            className: 'dsh_tm_canvas',
            ref: canvasRef,
            onClick: function () { setSelected(null) },
            onWheel: onWheel,
            onPointerDown: onDragStart,
            onPointerMove: onDragMove,
            onPointerUp: onDragEnd,
            onPointerCancel: onDragEnd,
            // 双击空白处复位到全览。
            onDoubleClick: function (ev) {
              if (ev.target === ev.currentTarget || ev.target.tagName === 'svg') fitNow()
            },
            // 拖拽时要能捕获指针，否则拖出画布就断了。
            style: { cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' },
          },
            h(Graph, {
              layout: L,
              view: view,
              viewW: size.w,
              viewH: size.h,
              labelGutter: L.labelGutter,
              byTurn: byTurn,
              // 依赖连线：把 laneId 对映射到图上某一行，才能画在正确位置
              dependencies: pmState.dependencies,
              visibleLaneIds: visibleLaneIds,
              hovered: hovered,
              selected: selected,
              highlightLane: highlightLane,
              selectedLane: selectedLane,
              selectedTurn: selected,
              graphMode: graphMode,
              onHover: function (turnNo, ev) {
                setHovered(turnNo)
                if (ev) setPos({ x: ev.clientX, y: ev.clientY })
              },
              onLeave: function () { setHovered(null) },
              onSelect: function (turnNo) {
                // 双向联动的入口：图上点节点 → 左树展开并高亮对应任务
                selectTurn(turnNo)
              },
            }),
          ),
          h('div', { className: 'dsh_tm_detail' },
            detail,
            selectedFact !== null
              ? h('div', { className: 'dsh_tm_act' },
                  h('button', {
                    type: 'button', className: 'dsh_tm_primary',
                    onClick: function () { jumpTo(selectedFact.turn) },
                  }, '跳转到对话'),
                  h('button', {
                    type: 'button', className: 'dsh_tm_ghost',
                    onClick: function () { setSelected(null) },
                  }, '返回总览'),
                )
              : null,
          ),
        ),
        // 缩略条在 body 之外：它横跨整个宽度，不属于三栏中的任何一栏。
        h(Overview, {
          content: contentSize,
          view: view,
          viewport: { width: size.w, height: size.h },
          layout: L,
          dragging: dragging,
          onDragStart: function () { dragState[1]({ x: 0, y: 0 }) },
          onDragEnd: function () { dragState[1](null) },
          onSeek: function (ratio) {
            setView(function (prev) {
              return VIEWPORT.seekTo(
                contentSize, prev,
                { width: size.w, height: size.h },
                ratio,
              )
            })
          },
        }),
        h(HoverTip, { fact: hoverFact, pos: pos }),
      )
    }

    // ── locale ──────────────────────────────────────────────────────
    var ZH = {
      title: '话题地图',
      loading: '正在读取会话…',
      empty: '这个会话还没有任何对话',
      noSession: '请先打开一个会话',
      unavailable: '话题地图暂不可用',
    }
    var EN = {
      title: 'Topic Map',
      loading: 'Reading session…',
      empty: 'No turns in this session yet',
      noSession: 'Open a session first',
      unavailable: 'Topic Map is unavailable',
    }

    var NS = 'topic-map'
    var inject = ['slots', 'sessions', 'locale']
    var SESSION_SERVICE = null

    function apply(ctx) {
      injectCss()
      SESSION_SERVICE = ctx.sessions
      ctx.effect(function () {
        var a = ctx.locale.register(NS, 'zh', ZH)
        var b = ctx.locale.register(NS, 'en', EN)
        return function () { a(); b() }
      }, 'dsh-topic-map: locale')

      var t = ctx.locale.bind(NS)

      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({
          name: 'conversation.view',
          id: 'topic-map',
          order: 5,
          label: function () { return t('title') },
          locale: NS,
        }, TopicMapPanel)
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
