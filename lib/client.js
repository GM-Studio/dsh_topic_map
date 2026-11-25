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
      // 顶栏：工作区下拉 / 搜索 / 归类
      '.dsh_tm_wsselect{flex:0 1 auto;min-width:80px;max-width:260px;font:inherit;font-size:10.5px;padding:3px 6px;border-radius:6px;border:1px solid var(--tm-border);background:var(--tm-bg);color:var(--tm-text2);cursor:pointer;min-width:0}',
      '.dsh_tm_wsselect:hover{border-color:var(--tm-border-strong);color:var(--tm-text)}',
      '.dsh_tm_wssearch{flex:1 1 120px;min-width:80px;max-width:240px;font:inherit;font-size:10.5px;padding:3px 8px;border-radius:6px;border:1px solid var(--tm-border);background:var(--tm-bg);color:var(--tm-text);outline:none}',
      '.dsh_tm_wssearch:focus{border-color:var(--tm-accent)}',
      '.dsh_tm_wsact{flex:none;font:inherit;font-size:10.5px;padding:3px 10px;border-radius:6px;border:1px solid var(--tm-border);background:transparent;color:var(--tm-text2);cursor:pointer;white-space:nowrap}',
      '.dsh_tm_wsact:hover{border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_wsact[data-on="1"]{border-color:var(--tm-accent);color:var(--tm-accent)}',
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
      '.dsh_tm_sidehint{flex:none;padding:0 10px 0 2px;font-size:9.5px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      // 左栏头部：标题 + 三个折叠粒度按钮
      '.dsh_tm_sidehead{flex:none;display:flex;align-items:center;gap:6px;padding:8px 10px 6px 12px;min-width:0}',
      '.dsh_tm_sidehead > .dsh_tm_sidetitle{padding:0;flex:auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_foldbtns{display:flex;align-items:center;gap:2px;margin-left:auto;flex:none}',      '.dsh_tm_foldbtn{width:20px;height:20px;display:grid;place-items:center;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--tm-text3);cursor:pointer;font-size:11px;line-height:1;padding:0}',
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

      // ── 右栏会话内搜索（原筛选条已删，只留这一条输入框样式）──
      '.dsh_tm_finput{flex:1 1 auto;min-width:0;font:inherit;font-size:11px;padding:3px 8px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-bg);color:var(--tm-text);outline:none}',
      '.dsh_tm_finput:focus{border-color:var(--tm-accent)}',
      '.dsh_tm_finput::placeholder{color:var(--tm-text3)}',
      '.dsh_tm_fx{flex:none;width:18px;height:18px;display:grid;place-items:center;border:0;border-radius:4px;background:transparent;color:var(--tm-text3);cursor:pointer;font-size:13px;line-height:1}',
      '.dsh_tm_fx:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_fcount{flex:none;font-size:9.5px;color:var(--tm-accent);font-variant-numeric:tabular-nums;font-weight:600}',
      '.dsh_tm_keyrow{display:flex;gap:5px;align-items:center}',
      '.dsh_tm_keyeye{flex:none;width:30px;height:28px;display:grid;place-items:center;border:1px solid var(--tm-border);border-radius:6px;background:transparent;color:var(--tm-text2);cursor:pointer;font-size:11px}',
      '.dsh_tm_keyeye:hover{background:var(--tm-hover)}',
      '.dsh_tm_popwarn{font-size:10px;line-height:14px;color:var(--tm-warn);background:color-mix(in srgb, var(--tm-warn) 10%, transparent);border-radius:6px;padding:6px 8px;margin-bottom:10px}',
      '.dsh_tm_popacts{display:flex;gap:8px;align-items:center;flex-wrap:wrap;row-gap:6px}',
      '.dsh_tm_svg{display:block;width:100%;height:100%}',

      '.dsh_tm_detail{flex:none;width:272px;min-width:0;min-height:0;display:flex;flex-direction:column;border-left:1px solid var(--tm-border);background:var(--tm-surface);overflow:hidden}',

      // ── 左栏上半：大类 → 对话 ──
      '.dsh_tm_clist{overflow-y:auto;min-height:0;padding:2px 4px 4px}',
      '.dsh_tm_clistempty{font-size:10.5px;color:var(--tm-text3);padding:14px 10px;text-align:center}',
      '.dsh_tm_ccat{margin-bottom:1px}',
      '.dsh_tm_ccathd{width:100%;display:flex;align-items:center;gap:5px;padding:5px 6px;border:0;border-radius:5px;background:var(--tm-surface2);color:var(--tm-text);font:inherit;font-size:12px;font-weight:650;text-align:left;cursor:pointer;min-width:0;margin-bottom:1px}',
      '.dsh_tm_ccathd:hover{background:var(--tm-hover)}',
      '.dsh_tm_ccatbar{flex:none;width:3px;height:11px;border-radius:2px;opacity:.85}',
      '.dsh_tm_ccatname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_ccatn{flex:none;width:34px;text-align:right;font-size:9.5px;font-weight:400;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      // 第三层：会话。缩进 34px，明显比子主题更深，形成清晰的三级台阶
      '.dsh_tm_cconv{width:100%;display:flex;align-items:flex-start;gap:5px;padding:3px 6px 3px 34px;border:0;border-radius:5px;background:transparent;color:var(--tm-text3);font:inherit;font-size:10.5px;text-align:left;cursor:pointer;min-width:0;line-height:1.4}',
      '.dsh_tm_cconv:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_cconv[data-on="1"]{background:var(--tm-accent-soft);color:var(--tm-text);box-shadow:inset 2px 0 0 var(--tm-accent)}',
      '.dsh_tm_cdot{flex:none;width:5px;height:5px;border-radius:50%;margin-top:4px;opacity:.85}',
      '.dsh_tm_ctxt{flex:1 1 auto;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      // 会话行：标题 + 一句主题摘要
      '.dsh_tm_cmain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.dsh_tm_cdig{font-size:9px;color:var(--tm-text3);line-height:1.3;overflow:hidden;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical}',
      '.dsh_tm_cconv[data-on="1"] .dsh_tm_cdig{color:var(--tm-accent);opacity:.85}',
      '.dsh_tm_cmeta{flex:none;text-align:right;font-size:9px;color:var(--tm-text3);font-variant-numeric:tabular-nums;margin-top:1px;white-space:nowrap}',
      '.dsh_tm_cconv[data-on="1"] .dsh_tm_cmeta{color:var(--tm-accent)}',

      // 第二层：子主题。缩进 18px，比话题深一级
      '.dsh_tm_csub{margin-bottom:1px}',
      '.dsh_tm_csubhd{width:100%;display:flex;align-items:center;gap:5px;padding:3px 6px 3px 18px;border:0;border-radius:5px;background:var(--tm-surface);color:var(--tm-text2);font:inherit;font-size:11px;font-weight:550;text-align:left;cursor:pointer;min-width:0}',
      '.dsh_tm_csubhd:hover{background:var(--tm-hover);color:var(--tm-text)}',
      // 对话层色条：比话题的 3px 更细更淡，体现从属关系
      '.dsh_tm_csubbar{flex:none;width:2px;height:9px;border-radius:1px;opacity:.55}',
'.dsh_tm_csubname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_csubn{flex:none;text-align:right;font-size:9px;color:var(--tm-text3);font-variant-numeric:tabular-nums;white-space:nowrap}',

      // 搜索命中高亮：用左边缘竖条 + 淡底，避免整行刷色导致刺眼
      '.dsh_tm_ccathd[data-hit="1"]{background:var(--tm-accent-soft)}',
      '.dsh_tm_ccathd[data-hit="1"] .dsh_tm_ccatname{color:var(--tm-accent);font-weight:700}',
      '.dsh_tm_csubhd[data-hit="1"]{background:var(--tm-accent-soft);color:var(--tm-text)}',
      '.dsh_tm_csubhd[data-hit="1"] .dsh_tm_csubname{color:var(--tm-accent)}',
      '.dsh_tm_cconv[data-hit="1"]{box-shadow:inset 2px 0 0 var(--tm-accent)}',
      '.dsh_tm_cconv[data-hit="1"] .dsh_tm_ctxt{color:var(--tm-text);font-weight:600}',
      // 左栏高亮当前正在浏览的层级（与中间列表对应）
      '.dsh_tm_ccathd[data-scope="1"]{background:var(--tm-accent-soft)}',
      '.dsh_tm_ccathd[data-scope="1"] .dsh_tm_ccatname{color:var(--tm-accent);font-weight:700}',
      // 当前会话的归属：默认就亮，用左侧竖条区分（不抢 data-scope 的底色）
      '.dsh_tm_ccathd[data-owner="1"]{box-shadow:inset 2px 0 0 var(--tm-accent)}',
      '.dsh_tm_csubhd[data-owner="1"]{box-shadow:inset 2px 0 0 var(--tm-accent)}',
      '.dsh_tm_ccathd[data-owner="1"] .dsh_tm_ccatname{color:var(--tm-accent)}',
      '.dsh_tm_csubhd[data-owner="1"] .dsh_tm_csubname{color:var(--tm-accent)}',
      '.dsh_tm_csubhd[data-scope="1"]{background:var(--tm-accent-soft)}',
      '.dsh_tm_csubhd[data-scope="1"] .dsh_tm_csubname{color:var(--tm-accent);font-weight:700}',

      // 搜索零命中：中央图与右栏一起清空，只留这句说明
      '.dsh_tm_blank{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;color:var(--tm-text3);font-size:11.5px}',
      '.dsh_tm_blankicon{font-size:26px;opacity:.35}',
      '.dsh_tm_blankhint{font-size:10px;opacity:.7}',

      // ── 层级列表（点话题 → 对话列表；点对话 → 会话列表）──
      '.dsh_tm_lvwrap{flex:1 1 0;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--tm-bg);overflow:hidden}',
      '.dsh_tm_lvhead{flex:none;display:flex;align-items:center;gap:6px;padding:7px 12px;border-bottom:1px solid var(--tm-border);background:var(--tm-surface);font-size:11px;min-width:0;overflow:hidden}',
      '.dsh_tm_lvback{font:inherit;font-size:10.5px;padding:2px 8px;border-radius:5px;border:1px solid var(--tm-border);background:transparent;color:var(--tm-text2);cursor:pointer;flex:none}',
      '.dsh_tm_lvback:hover{border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_lvcrumbs{display:inline-flex;align-items:center;gap:6px;min-width:0}',
      '.dsh_tm_lvsep{color:var(--tm-text3);flex:none}',
      '.dsh_tm_lvcrumb{font:inherit;font-size:11px;padding:1px 4px;border:0;border-radius:4px;background:transparent;color:var(--tm-text2);cursor:pointer;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}',
      '.dsh_tm_lvcrumb:hover{background:var(--tm-hover);color:var(--tm-accent)}',
      '.dsh_tm_lvcrumb[data-on="1"]{color:var(--tm-text);font-weight:620;cursor:default}',
      '.dsh_tm_lvcount{margin-left:auto;font-size:9.5px;color:var(--tm-text3);font-variant-numeric:tabular-nums;flex:none}',
      '.dsh_tm_lvbody{flex:1 1 auto;overflow-y:auto;padding:6px 8px}',
      '.dsh_tm_lvrow{width:100%;display:flex;align-items:center;gap:8px;padding:7px 9px;margin-bottom:3px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface);color:var(--tm-text);font:inherit;font-size:11px;text-align:left;cursor:pointer;min-width:0}',
      '.dsh_tm_lvrow:hover{background:var(--tm-surface2);border-color:var(--tm-border-strong)}',
      '.dsh_tm_lvdot{width:7px;height:7px;border-radius:50%;flex:none;opacity:.85}',
      '.dsh_tm_lvmain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.dsh_tm_lvtitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}',
      '.dsh_tm_lvsub{font-size:9.5px;color:var(--tm-text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_lvmeta{flex:none;font-size:9.5px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_lvcaret{flex:none;font-size:13px;color:var(--tm-text3);opacity:.6}',
      '.dsh_tm_lvempty{padding:24px 12px;text-align:center;font-size:11px;color:var(--tm-text3)}',
      // 右栏在列表视图下的范围说明
      '.dsh_tm_lvsummary{padding:8px 12px;display:flex;flex-direction:column;gap:7px}',
      '.dsh_tm_lvnote{font-size:10px;color:var(--tm-text3);line-height:1.6;margin-top:4px}',

      '.dsh_tm_shell{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:#0b0d10}',

      // ── 未归类组（置顶）──
      '.dsh_tm_cuncat{margin-bottom:5px;padding-bottom:4px;border-bottom:1px dashed var(--tm-border-strong)}',
      '.dsh_tm_cuncathd{display:flex;align-items:center;gap:6px;padding:5px 6px;font-size:11px;font-weight:620;color:var(--tm-text)}',
      '.dsh_tm_cuncatdot{width:6px;height:6px;border-radius:50%;background:var(--tm-warn);flex:none}',
      '.dsh_tm_cuncatname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_cuncatn{flex:none;font-size:9px;color:var(--tm-warn);font-variant-numeric:tabular-nums}',
      '.dsh_tm_cuncatbtn{flex:none;font:inherit;font-size:9.5px;padding:2px 8px;border-radius:5px;border:1px solid var(--tm-warn);background:transparent;color:var(--tm-warn);cursor:pointer}',
      '.dsh_tm_cuncatbtn:hover{background:rgba(210,153,34,.12)}',
      '.dsh_tm_cuncatbtn:disabled{opacity:.6;cursor:default}',
      // ── 正文命中组（跨会话搜对话内容的结果）──
      '.dsh_tm_cfind{margin-bottom:5px;padding-bottom:4px;border-bottom:1px dashed var(--tm-border-strong)}',
      '.dsh_tm_cfindhd{display:flex;align-items:center;gap:6px;padding:5px 6px;font-size:11px;font-weight:620;color:var(--tm-text)}',
      '.dsh_tm_cfinddot{width:6px;height:6px;border-radius:50%;background:var(--tm-info);flex:none}',
      '.dsh_tm_cfindname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_cfindn{flex:none;font-size:9px;color:var(--tm-info);font-variant-numeric:tabular-nums}',
      '.dsh_tm_cfindbusy{padding:4px 8px;font-size:9.5px;color:var(--tm-text3)}',

      // 归类进行中的流动条
      '.dsh_tm_busybar{display:inline-flex;align-items:center;gap:6px;font-size:10px;color:var(--tm-accent);flex:none}',
      '.dsh_tm_busybar i{width:46px;height:3px;border-radius:2px;background:linear-gradient(90deg,transparent,var(--tm-accent),transparent);background-size:200% 100%;animation:dsh-tm-flow 1.1s linear infinite}',
      '@keyframes dsh-tm-flow{0%{background-position:200% 0}100%{background-position:-200% 0}}',

      // 左栏分段标题（上半/下半）
      '.dsh_tm_sidehalf{display:flex;flex-direction:column;min-height:0;overflow:hidden}',
      '.dsh_tm_sidehalf[data-flex="1"]{flex:1 1 50%}',
      '.dsh_tm_sidehalf[data-flex="2"]{flex:1 1 50%;border-top:1px solid var(--tm-border-strong)}',

      // ── 右栏：主题 + 轮次列表 ──
      '.dsh_tm_tlsplit{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;min-width:0}',
      '.dsh_tm_tlfoot{flex:none;max-height:42%;overflow-y:auto;border-top:1px solid var(--tm-border-strong);background:var(--tm-surface2)}',
      '.dsh_tm_turnlist{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;min-width:0}',
      '.dsh_tm_tlhead{flex:none;padding:9px 11px 8px;border-bottom:1px solid var(--tm-border)}',
      '.dsh_tm_tlpath{font-size:9.5px;color:var(--tm-text3);margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_tlname{font-size:12px;font-weight:620;line-height:1.4;margin-bottom:6px;word-break:break-word}',
      '.dsh_tm_tlbadges{display:flex;gap:5px;flex-wrap:wrap}',
      '.dsh_tm_tlbhit{color:var(--tm-accent);background:var(--tm-accent-soft)}',
      // 会话内搜索（右栏顶部）
      '.dsh_tm_tlsearch{display:flex;align-items:center;gap:5px;margin-top:7px}',
      '.dsh_tm_tlsearchicon{flex:none;font-size:11px;color:var(--tm-text3);width:12px;text-align:center}',
      // 搜索结果里的"所属话题"标注
      '.dsh_tm_tlane{font-size:9px;color:var(--tm-text3);padding:0 0 2px 22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_tlb{display:inline-flex;align-items:center;gap:4px;font-size:9.5px;padding:2px 7px;border-radius:5px;background:var(--tm-surface2);color:var(--tm-text2)}',
      '.dsh_tm_tlbody{flex:1 1 auto;overflow-y:auto;min-height:0}',

      // 单轮
      '.dsh_tm_turnrow{border-bottom:1px solid var(--tm-border);padding:5px 10px;cursor:pointer;transition:background .12s}',
      '.dsh_tm_turnrow:hover{background:var(--tm-hover)}',
      '.dsh_tm_turnrow[data-open="1"]{background:var(--tm-surface2)}',
      '.dsh_tm_turnrow[data-sel="1"]{background:var(--tm-accent-soft);box-shadow:inset 2px 0 0 var(--tm-accent)}',
      '.dsh_tm_trowline{display:flex;align-items:flex-start;gap:6px;min-width:0}',
      '.dsh_tm_tno{flex:none;font-size:9.5px;font-weight:600;color:var(--tm-text3);font-variant-numeric:tabular-nums;width:24px;padding-top:1px}',
      '.dsh_tm_turnrow[data-sel="1"] .dsh_tm_tno{color:var(--tm-accent)}',
      '.dsh_tm_tprompt{flex:1 1 auto;min-width:0;font-size:10.5px;line-height:1.42;color:var(--tm-text2);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}',
      '.dsh_tm_turnrow[data-open="1"] .dsh_tm_tprompt{-webkit-line-clamp:unset;color:var(--tm-text)}',
      '.dsh_tm_tmeta{flex:none;display:flex;align-items:center;gap:4px;font-size:9px;color:var(--tm-text3);font-variant-numeric:tabular-nums;padding-top:2px}',
      '.dsh_tm_tsdot{width:4px;height:4px;border-radius:50%;flex:none;display:inline-block}',
      '.dsh_tm_tunfold{flex:none;width:16px;height:16px;border:0;border-radius:4px;background:transparent;color:var(--tm-text3);font:inherit;font-size:11px;line-height:1;cursor:pointer;padding:0}',
      '.dsh_tm_tunfold:hover{background:var(--tm-active);color:var(--tm-text)}',

      // 轮次展开详情
      '.dsh_tm_tdetail{margin-top:6px;margin-left:30px;padding:7px 8px;background:var(--tm-bg);border:1px solid var(--tm-border);border-radius:6px;font-size:10px;line-height:1.65;color:var(--tm-text2)}',
      '.dsh_tm_tdsec{margin-bottom:6px}',
      '.dsh_tm_tdsec:last-child{margin-bottom:0}',
      '.dsh_tm_tdk{display:block;font-size:9px;color:var(--tm-text3);margin-bottom:2px}',
      '.dsh_tm_ttools{display:flex;gap:3px;flex-wrap:wrap;margin-top:2px}',
      '.dsh_tm_ttool{font-size:8.5px;padding:1px 5px;border-radius:4px;background:var(--tm-surface3);color:var(--tm-text3);font-family:ui-monospace,Menlo,monospace}',
      '.dsh_tm_tdcode{font-family:ui-monospace,Menlo,monospace;font-size:9.5px;color:var(--tm-info)}',
      '.dsh_tm_tjump{margin-top:6px;width:100%;font:inherit;font-size:9.5px;padding:3px;border-radius:5px;border:1px solid var(--tm-border);background:transparent;color:var(--tm-text2);cursor:pointer}',
      '.dsh_tm_tjump:hover{border-color:var(--tm-accent);color:var(--tm-accent)}',
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
      '.dsh_tm_act{flex:none;padding:10px 13px;border-top:1px solid var(--tm-border);display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.dsh_tm_primary{width:100%;padding:8px;border:0;border-radius:8px;background:var(--tm-accent);color:#fff;font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:filter .12s}',
      '.dsh_tm_primaryoff{opacity:.45;cursor:not-allowed}',
      '.dsh_tm_jumpwhy{flex-basis:100%;font-size:9.5px;line-height:1.5;color:var(--tm-text3);margin-top:2px}',
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

      // ── 历史右栏（C2：查询列表）──────────────────────────────────
      //
      // 字号只用 12/13/14 三档（ui.md §8）。颜色全部走现有主题令牌，
      // 不新增色板；右栏可能先于话题地图面板打开，所以组件挂载时会把
      // data-tm-theme 写到根节点（与面板同一套解析逻辑），否则这些
      // var(--tm-*) 会解析为空。
      '.dsh_tm_history{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;background:var(--tm-bg);color:var(--tm-text);font-size:13px;overflow:hidden}',
      '.dsh_tm_histhead{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px 8px;min-width:0}',
      '.dsh_tm_histtitle{flex:auto;min-width:0;font-size:14px;font-weight:600;letter-spacing:.2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 极小快捷键提示：入口自身要把"怎么打开"说清楚。
      '.dsh_tm_histkey{flex:none;font-size:11px;line-height:16px;color:var(--tm-text3);opacity:.8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}',
      '.dsh_tm_histcmd{flex:none;font-size:12px;line-height:16px;color:var(--tm-accent);font-variant-numeric:tabular-nums}',
      // 图钉在 C2 仍是占位：明确置灰，避免用户点了以为坏了。
      '.dsh_tm_histpin{flex:none;width:24px;height:24px;display:grid;place-items:center;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--tm-text3);font:inherit;font-size:12px;line-height:1;opacity:.5;cursor:default}',
      '.dsh_tm_histsearch{flex:none;padding:0 12px 10px}',
      '.dsh_tm_history_search{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:16px;padding:6px 9px;border-radius:7px;border:1px solid var(--tm-border);background:var(--tm-surface);color:var(--tm-text);outline:none}',
      '.dsh_tm_history_search:focus{border-color:var(--tm-accent);box-shadow:0 0 0 2px var(--tm-accent-soft)}',
      '.dsh_tm_history_search::placeholder{color:var(--tm-text3)}',
      '.dsh_tm_histbody{flex:1 1 auto;min-height:0;overflow:auto}',
      '.dsh_tm_history_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;height:100%;min-height:120px;padding:24px 16px;color:var(--tm-text3);font-size:12px;line-height:18px;text-align:center}',
      '.dsh_tm_histidle-sub{font-size:12px;line-height:17px;color:var(--tm-text3)}',
      // 列表：两行 56px；第一行 12px 次要色，第二行 13px 正文（ui.md §2.2/§8）。
      '.dsh_tm_histlist{display:flex;flex-direction:column;padding:4px 8px 6px}',
      '.dsh_tm_histrow{display:flex;flex-direction:column;gap:3px;width:100%;min-height:56px;box-sizing:border-box;padding:7px 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--tm-text);font:inherit;font-size:13px;text-align:left;cursor:pointer}',
      '.dsh_tm_histrow:hover{background:var(--tm-hover)}',
      // 键盘选中行：背景 + 边框一起给，深浅主题下都看得见。
      '.dsh_tm_histrow_on{background:var(--tm-accent-soft);border-color:var(--tm-accent)}',
      '.dsh_tm_histrow:focus-visible{outline:2px solid var(--tm-accent);outline-offset:-2px}',
      '.dsh_tm_histrowhead{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:12px;line-height:16px;color:var(--tm-text2)}',
      '.dsh_tm_histside{flex:none;font-size:12px;color:var(--tm-accent)}',
      '.dsh_tm_histside[data-side="response"]{color:var(--tm-text3)}',
      '.dsh_tm_histname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text);font-weight:600}',
      '.dsh_tm_histturn,.dsh_tm_histtime{flex:none;font-size:12px;font-variant-numeric:tabular-nums;color:var(--tm-text3)}',
      '.dsh_tm_histtime{margin-left:auto}',
      '.dsh_tm_histsnip{display:block;font-size:13px;line-height:18px;color:var(--tm-text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 命中高亮用背景色，不加粗（ui.md §8）。
      '.dsh_tm_histmark{background:var(--tm-accent-soft);color:inherit;border-radius:3px;padding:0 1px}',
      '.dsh_tm_histnote{padding:5px 4px 0;font-size:12px;line-height:17px;color:var(--tm-text3)}',
      '.dsh_tm_histerr{margin:8px 8px 0;padding:6px 9px;border:1px solid var(--tm-err);border-radius:7px;background:color-mix(in srgb, var(--tm-err) 12%, transparent);font-size:12px;line-height:17px;color:var(--tm-err);overflow-wrap:anywhere}',
      '.dsh_tm_histerrhint{padding:14px 16px 6px;font-size:12px;line-height:17px;text-align:center;color:var(--tm-text3)}',
      // 底部状态条：条数/耗时、截断、索引回退各占一行，不挤成一条。
      '.dsh_tm_histfoot{flex:none;display:flex;flex-direction:column;gap:2px;padding:7px 12px 9px;border-top:1px solid var(--tm-border);font-size:12px;line-height:17px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_histstats{font-size:12px;color:var(--tm-text2)}',
      '.dsh_tm_histmore{font-size:12px;color:var(--tm-text2)}',
      '.dsh_tm_histmiss{font-size:12px;color:var(--tm-text3)}',
      // 空态最底部的诊断小字：不开控制台也能看到最近一次失败原因。
      '.dsh_tm_histdiag{margin-top:6px;max-width:100%;font-size:12px;line-height:17px;color:var(--tm-text3);opacity:.85;overflow-wrap:anywhere}',
      // C3：行内动作条 / 详情 / 标记 / 行内提示。
      '.dsh_tm_histrowwrap{display:flex;flex-direction:column;min-width:0;border-radius:8px}',
      '.dsh_tm_histrowwrap_on{background:color-mix(in srgb, var(--tm-accent-soft) 55%, transparent)}',
      '.dsh_tm_histbadges{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:0 1px}',
      '.dsh_tm_histbadge{font-size:12px;line-height:16px;padding:0 5px;border-radius:5px;background:var(--tm-hover);color:var(--tm-text3);white-space:nowrap}',
      '.dsh_tm_histbadge_lab{background:var(--tm-accent-soft);color:var(--tm-accent)}',
      '.dsh_tm_histactions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;row-gap:5px;padding:2px 8px 7px}',
      '.dsh_tm_histact{font:inherit;font-size:12px;line-height:17px;padding:3px 9px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface);color:var(--tm-text2);cursor:pointer;white-space:nowrap}',
      '.dsh_tm_histact:hover{border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_histact_on{border-color:var(--tm-accent);background:var(--tm-accent-soft);color:var(--tm-accent)}',
      '.dsh_tm_histmenubtn{font:inherit;font-size:12px;line-height:17px;width:24px;padding:3px 0;border:1px solid var(--tm-border);border-radius:6px;background:transparent;color:var(--tm-text2);cursor:pointer}',
      '.dsh_tm_histmenubtn:hover{border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_histmenupane{flex-basis:100%;display:flex;align-items:center;gap:5px;flex-wrap:wrap;row-gap:5px;padding:5px 0 0}',
      '.dsh_tm_histmenulabel{font-size:12px;color:var(--tm-text3)}',
      '.dsh_tm_histdetail{margin:0 8px 8px;padding:8px 10px;border:1px solid var(--tm-border);border-radius:8px;background:var(--tm-surface2);color:var(--tm-text2);font-size:12px;line-height:17px;overflow-wrap:anywhere}',
      '.dsh_tm_histdsec{padding:3px 0}',
      '.dsh_tm_histdsec b{display:block;font-size:12px;color:var(--tm-text3);font-weight:600;margin-bottom:2px}',
      '.dsh_tm_histdtext{white-space:pre-wrap}',
      '.dsh_tm_histdmeta{margin-top:5px;padding-top:5px;border-top:1px solid var(--tm-border);color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_histdfiles,.dsh_tm_histdneighbors{margin:0;padding-left:16px}',
      '.dsh_tm_histdact{display:flex;gap:6px;padding-top:6px}',
      '.dsh_tm_histnotice{margin:0 12px 8px;padding:5px 8px;border-radius:6px;background:var(--tm-surface2);color:var(--tm-text2);font-size:12px;line-height:17px;overflow-wrap:anywhere}',
      '.dsh_tm_histnotice[data-tone="ok"]{color:var(--tm-ok)}',
      '.dsh_tm_histnotice[data-tone="error"]{color:var(--tm-err);background:color-mix(in srgb, var(--tm-err) 10%, transparent)}',
      // 标题栏工作区 / 底部补齐索引。
      '.dsh_tm_histws{flex:0 1 auto;min-width:0;max-width:52%;font-size:12px;line-height:16px;color:var(--tm-text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.dsh_tm_histwswarn{flex:0 1 auto;min-width:0;max-width:52%;font-size:12px;line-height:16px;color:var(--tm-warn);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_histfootrow{display:flex;align-items:flex-start;gap:8px;min-width:0}',
      '.dsh_tm_histfootlines{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dsh_tm_histcoverage{font-size:12px;line-height:17px;color:var(--tm-text3)}',
      '.dsh_tm_histreindex{flex:none;font:inherit;font-size:12px;line-height:17px;padding:0;border:0;background:transparent;color:var(--tm-accent);cursor:pointer;white-space:nowrap}',
      '.dsh_tm_histreindex:hover{text-decoration:underline}',
      // 复制浮窗：面板内绝对定位，遮罩点击关闭。
      '.dsh_tm_histmodal{position:fixed;top:0;right:0;bottom:0;left:0;z-index:60;background:rgba(0,0,0,.28)}',
      '.dsh_tm_histdialog{position:absolute;right:12px;top:max(12px, calc((100vh - min(520px, calc(100vh - 32px))) / 2));display:flex;flex-direction:column;width:min(420px, calc(var(--dsh-sidebar-width, calc(100vw - 16px)) - 16px));height:min(520px, calc(100vh - 32px));max-width:none;max-height:none;min-height:0;background:var(--tm-surface);border:1px solid var(--tm-border-strong);border-radius:10px;box-shadow:var(--tm-shadow);color:var(--tm-text);overflow:hidden}',
      '.dsh_tm_histdialoghead{flex:none;display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--tm-border)}',
      '.dsh_tm_histdialogtitle{flex:auto;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_histdialogclose{flex:none;width:24px;height:24px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--tm-text3);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_histdialogclose:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_histfilter{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;border-bottom:1px solid var(--tm-border)}',
      '.dsh_tm_histfilterinput{flex:1 1 120px;min-width:0;font:inherit;font-size:12px;line-height:17px;padding:3px 7px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface2);color:var(--tm-text);outline:none}',
      '.dsh_tm_histfilterinput:focus{border-color:var(--tm-accent)}',
      '.dsh_tm_histfilterlang{flex:none;font:inherit;font-size:12px;line-height:17px;padding:3px 4px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface2);color:var(--tm-text2)}',
      '.dsh_tm_histfiltercount{flex:none;margin-left:auto;font-size:12px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_histcmdlist{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 8px}',
      '.dsh_tm_histmodalempty{padding:26px 16px;text-align:center;font-size:12px;color:var(--tm-text3)}',
      '.dsh_tm_histcmdrow{display:flex;align-items:flex-start;gap:6px;min-height:24px;padding:3px 4px;border-radius:5px;font-size:12px;line-height:17px}',
      '.dsh_tm_histcmdrow:hover{background:var(--tm-hover)}',
      // 一个代码块一条：保留换行，长行自动折行；语言徽标在左。
      '.dsh_tm_histcmdindex{flex:none;min-width:26px;text-align:right;color:var(--tm-text3);font-size:11px;line-height:17px;font-variant-numeric:tabular-nums;user-select:none}',
      '.dsh_tm_histcmdlang{flex:none;min-width:38px;padding:1px 5px;border-radius:4px;background:var(--tm-surface2);border:1px solid var(--tm-border);color:var(--tm-text3);font-size:11px;line-height:15px;text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;user-select:none}',
      '.dsh_tm_histcmdtext{flex:1 1 auto;min-width:0;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:17px;color:var(--tm-text2)}',
      '.dsh_tm_histcmdcopy{flex:none;margin-top:1px;width:22px;height:20px;display:grid;place-items:center;padding:0;border:0;border-radius:5px;background:transparent;color:var(--tm-text3);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_histcmdcopy:hover{background:var(--tm-hover);color:var(--tm-accent)}',
      '.dsh_tm_histdialogfoot{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;row-gap:6px;padding:8px 10px;border-top:1px solid var(--tm-border);font-size:12px}',
      '.dsh_tm_histpage{font-size:12px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_histgrow{flex:auto}',
      '.dsh_tm_histpre{flex:1 1 auto;min-height:0;overflow:auto;margin:0;padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;color:var(--tm-text)}',
      // 会话标题右侧的图标：颜色继承宿主 header，主题变量尚未写入时也不突兀。
      '.dsh_tm_histentry{flex:none;width:24px;height:24px;display:grid;place-items:center;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;cursor:pointer;opacity:.8}',
      '.dsh_tm_histentry:hover{background:var(--tm-hover);opacity:1}',
      '.dsh_tm_histentry:focus-visible{outline:2px solid var(--tm-accent);outline-offset:1px}',

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
   * Windows-only 口径（N-1）：路径统一按 NTFS 形态判定，只保留 Windows 形态。
   * 典型形态：
   *   Windows  C:\Users\x\AppData\Local\Temp、D:\proj\node_modules
   *
   * 正则里的 `tmp` / `.cache` / `.npm` 等片段属于同一条路径判定，没有平台分支：
   * 之前只写了 `Temp`，`/tmp/xxx` 就漏过去了。
   */
  const NOISE = /(^|[\\/])(Temp|temp|tmp|spill|node_modules|\.git|dist|build|coverage|\.cache|\.npm|\.pnpm-store|target|\.next|\.nuxt|out|vendor|__pycache__|\.venv|venv)([\\/]|$)/i

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
      // 段数（泳道数）：透传给 buildCategoryTree，供左栏显示"N 段 · M 轮"
      laneCount: Number(s.laneCount) || 0,
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
        // 该会话被分成了几段（泳道）。左栏「对话」那层要显示"N 段 · M 轮"，
        // 段数是各会话之和。归类时算好存进缓存，界面直接读。
        laneCount: Number.isFinite(item.laneCount) ? item.laneCount : 0,
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

  /**
   * 判断归类缓存是否还能复用。
   *
   * 这是"切页面回来要空白等 25 秒"那个问题的核心。
   *
   * 判据不是"集合完全相等"，而是"缓存里的每个会话现在都还在"。
   * 为什么：会话集合里混着空会话（新建未使用、0 轮），它们归类时会被
   * 过滤掉。若用未过滤的集合做相等比对，每出现一个空会话就让缓存永远
   * 失效——实测因此导致每次打开面板都重跑一次模型。
   *
   * `tolerance` 决定"允许多少个新会话还没归类"。
   * 默认是**不设上限**：新会话一律先进「未归类」组，只有用户自己点
   * 「归类」才调模型。
   *
   * 为什么不设成"超过 3 个就重算"：一次性新建四五个会话是很常见的动作
   * （开几个方向并行试），而重算一次要跑 30-40 秒的模型调用。把它变成
   * "打开面板突然卡住"是最糟的体验——用户并没有要求此时归类。
   *
   * 反向的风险（缓存里的会话被删掉）仍然拦着：只要有一个缓存会话消失，
   * 就判定失效并重算，避免树上留着已经不存在的会话。
   *
   * @param cached - 缓存里的 sessionId 数组。
   * @param live - 当前工作区的 sessionId 数组。
   * @param tolerance - 允许的未覆盖数量，默认不限。
   * @returns 是否可复用。
   */
  function canReuseCategoryCache(cached, live, tolerance = Number.POSITIVE_INFINITY) {
    const saved = Array.isArray(cached) ? cached.map(String) : []
    const now = Array.isArray(live) ? live.map(String) : []
    if (saved.length === 0) return false

    const liveSet = new Set(now)
    // 缓存里的每一个都还在
    for (const id of saved) {
      if (!liveSet.has(id)) return false
    }
    // 未覆盖的新会话不超过容忍值
    return now.length - saved.length <= tolerance
  }

      return {
        CATEGORY_RANGE: CATEGORY_RANGE, looksAutomated: looksAutomated,
        filterTree: filterTree,
        extractJsonArray: extractJsonArray,
        extractJsonArrayOfLength: extractJsonArrayOfLength,
      }
    })()
    // ══ 会话归类生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/hit-view.js
    // 列表视图模型（右栏两行 / 主面板三行 / 分数来源），纯函数，
    // 独立测试过（tests/hit-view.mjs）。导出清单手写：客户端用了哪个
    // 名字就必须在这里导出一个，否则运行时 TypeError + 白屏。
    var HITVIEW = (function () {
  const MINUTE = 60 * 1000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  /** 状态键的固定顺序（与 rank.js 一致）。 */
  const STATUS_ORDER = Object.freeze(['starred', 'solved', 'followUp'])

  /** 状态的中文文案（A-3 三个开关）。 */
  const STATUS_TEXT = Object.freeze({ starred: '重要', solved: '已解决', followUp: '待跟进' })

  /** 算"失败"的结束原因：需要重试的那些。 */
  const FAIL_REASONS = new Set(['error', 'failed', 'blocked', 'max-tokens', 'max-turns'])

  /** 算"中断"的结束原因。 */
  const INTERRUPT_REASONS = new Set(['interrupted', 'aborted'])

  /** 是否普通对象（排除 null / 数组）。 */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** 把时间统一成 epoch ms；认 Date 与数字，其余返回 NaN。 */
  function toMs(value) {
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'number' && Number.isFinite(value)) return value
    return NaN
  }

  /** 本地自然日的 0 点时间戳。 */
  function startOfLocalDay(ms) {
    const date = new Date(ms)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }

  /** 是否同一个本地自然日。 */
  function sameLocalDay(a, b) {
    return startOfLocalDay(a) === startOfLocalDay(b)
  }

  /** 是否同一个本地年份（跨年用绝对日期）。 */
  function sameLocalYear(a, b) {
    return new Date(a).getFullYear() === new Date(b).getFullYear()
  }

  /** `YYYY-MM-DD`（本地时区，不补时分）。 */
  function formatDate(ms) {
    const date = new Date(ms)
    const year = String(date.getFullYear()).padStart(4, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  /**
   * 相对时间文案。
   *
   * 分档（与 rank 的新鲜度同为"本地自然日"口径）：
   * ```
   * < 1 分钟       刚刚
   * < 1 小时       N 分钟前
   * < 24 小时      N 小时前
   * 昨天           昨天（同一自然年的前一天）
   * 2–6 天         N 天前
   * ≥ 7 天或跨年   YYYY-MM-DD
   * ```
   * 未来时间（宿主时钟偏差）同一天显示"今天"，隔天用绝对日期。
   * `ts` / `now` 缺失或非法返回空串——绝不回退到系统时钟。
   *
   * @param {number|Date} ts - 要格式化的时间（epoch ms）。
   * @param {number|Date} now - 参照的"现在"（epoch ms）。
   * @returns {string} 文案；参数非法时为空串。
   */
  function formatRelativeTime(ts, now) {
    const time = toMs(ts)
    const base = toMs(now)
    if (!Number.isFinite(time) || !Number.isFinite(base)) return ''
    const diff = base - time
    if (diff < 0) return sameLocalDay(time, base) ? '今天' : formatDate(time)
    if (diff < MINUTE) return '刚刚'
    if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
    if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
    // 满 24 小时改按本地自然日：跨过零点才算一天，和 rank 的新鲜度一致。
    const days = Math.round((startOfLocalDay(base) - startOfLocalDay(time)) / DAY)
    if (!sameLocalYear(time, base)) return formatDate(time)
    if (days <= 0) return '今天' // 夏令时等边界兜底
    if (days === 1) return '昨天'
    if (days < 7) return `${days} 天前`
    return formatDate(time)
  }

  /** 会话短 id：去掉常见的 `session-` 前缀后取前 8 个字符。 */
  function shortSessionId(sessionId) {
    const raw = typeof sessionId === 'string' ? sessionId.trim() : String(sessionId ?? '').trim()
    if (raw === '') return ''
    const stripped = raw.replace(/^session[-_:]/i, '')
    return stripped.slice(0, 8)
  }

  /**
   * 命中标签的键：`sessionId#turn`（design §4；与 rank.js 同口径）。
   *
   * @param {object} hit - 命中。
   * @returns {string} 标签键；信息不全时退化为 turn 或空串。
   */
  function labelKeyOf(hit) {
    const sid = hit.sessionId
    const turn = hit.turn
    if (sid === null || sid === undefined || sid === '') {
      return turn === null || turn === undefined ? '' : String(turn)
    }
    if (turn === null || turn === undefined) return String(sid)
    return `${sid}#${turn}`
  }

  /**
   * 从标签仓库取一条标签（对象 / Map / 函数），找不到回退命中自带的 `label`。
   *
   * @param {object} hit - 命中。
   * @param {object|Map|Function} [labels] - 标签仓库。
   * @returns {object|string|Array|null} 标签。
   */
  function resolveLabel(hit, labels) {
    if (typeof labels === 'function') {
      const value = labels(hit)
      if (value !== undefined && value !== null) return value
    } else if (labels instanceof Map || isPlainObject(labels)) {
      const key = labelKeyOf(hit)
      const bare = hit.turn === null || hit.turn === undefined ? '' : String(hit.turn)
      const lookup = k => (labels instanceof Map ? (labels.has(k) ? labels.get(k) : undefined) : labels[k])
      if (key !== '' && lookup(key) !== undefined) return lookup(key)
      if (bare !== '' && lookup(bare) !== undefined) return lookup(bare)
    }
    if (hit.label !== undefined && hit.label !== null) return hit.label
    return null
  }

  /**
   * 把各种标签形状归一成三个状态键（顺序固定）。
   *
   * @param {object|string|Array|null} label - 标签。
   * @returns {string[]} `starred / solved / followUp` 的子集。
   */
  function statusesOf(label) {
    if (!label) return []
    if (typeof label === 'string') {
      const raw = label.trim().toLowerCase()
      return STATUS_ORDER.filter(status => status.toLowerCase() === raw)
    }
    if (Array.isArray(label)) return STATUS_ORDER.filter(status => label.includes(status))
    if (!isPlainObject(label)) return []
    return STATUS_ORDER.filter(status => Boolean(label[status]))
  }

  /** 是否失败结束（需要重试）。 */
  function isFailure(hit) {
    const reason = typeof hit.endReason === 'string' ? hit.endReason : ''
    return FAIL_REASONS.has(reason)
  }

  /** 是否中断。 */
  function isInterrupted(hit) {
    const reason = typeof hit.endReason === 'string' ? hit.endReason : ''
    return hit.interrupted === true || INTERRUPT_REASONS.has(reason)
  }

  /**
   * 判断该轮是否改过文件（F-7）。
   *
   * 支持的形状：`changes: [{...}]`、`changes: {files:[...], lost}`；
   * `lost:true` 表示"曾变更但明细已不可读"，仍算有变更。
   *
   * @param {object} hit - 命中。
   * @returns {boolean} 是否有变更。
   */
  function hasChanges(hit) {
    if (hit.hasChanges === true) return true
    const changes = hit.changes
    if (Array.isArray(changes)) return changes.length > 0
    if (!isPlainObject(changes)) return false
    if (changes.lost === true) return true
    return Array.isArray(changes.files) && changes.files.length > 0
  }

  /** 话题段名：优先名称字段，缺了就退回 laneId（占位，等话题段接进索引）。 */
  function laneLabelOf(hit) {
    const lane = isPlainObject(hit.lane) ? hit.lane : {}
    const candidates = [hit.laneTitle, hit.laneName, lane.title, lane.name, hit.laneId]
    for (const candidate of candidates) {
      const text = typeof candidate === 'string' ? candidate.trim() : ''
      if (text !== '') return text
    }
    return ''
  }

  /** 把关键词输入摊平、小写、去重（内部用，不暴露）。 */
  function flattenKeywords(keywords) {
    const list = Array.isArray(keywords)
      ? keywords
      : (keywords === null || keywords === undefined || keywords === '' ? [] : [keywords])
    const out = []
    for (const value of list) {
      if (typeof value !== 'string') continue
      for (const word of value.split(/\s+/)) {
        const keyword = word.trim().toLowerCase()
        if (keyword !== '' && !out.includes(keyword)) out.push(keyword)
      }
    }
    return out
  }

  /**
   * 在片段里找最早出现的关键词，返回高亮位置。
   *
   * @param {string} snippet - 纯文本片段。
   * @param {string|string[]} [keywords] - 查询关键词。
   * @returns {{start: number, len: number}|null} 0 基偏移与长度；没命中为 null。
   */
  function findHighlight(snippet, keywords) {
    const text = typeof snippet === 'string' ? snippet : ''
    if (text === '') return null
    const lower = text.toLowerCase()
    let best = null
    for (const keyword of flattenKeywords(keywords)) {
      const at = lower.indexOf(keyword)
      if (at === -1) continue
      if (best === null || at < best.start) best = { start: at, len: keyword.length }
    }
    return best
  }

  /** 校验外部传入的 highlight，返回拷贝；非法返回 null。 */
  function normalizeHighlight(value) {
    if (!isPlainObject(value)) return null
    const start = Number(value.start)
    const len = Number(value.len)
    if (!Number.isFinite(start) || start < 0) return null
    if (!Number.isFinite(len) || len <= 0) return null
    return { start: Math.floor(start), len: Math.floor(len) }
  }

  /**
   * 一条命中 → 行模型（供 UI 直接用）。
   *
   * 字段：
   * - `turnLabel / title / timeLabel / snippet / highlight / matchLabel / badges`：显示用；
   * - `laneLabel / statusLabel`：主面板第三行"话题段 · 状态"用；
   * - `sessionId / turn / seq / time`：身份字段，点击定位时不用再回查。
   *
   * `snippet` 是纯文本；高亮只给 `{start, len}`，由调用方自己画。关键词没传时，
   * 若命中自带 `highlight`（searchTurns 后续可直接给）就用它，否则为 null。
   *
   * @param {object} hit - `searchTurns` 的命中。
   * @param {object} [options] - 选项。
   * @param {number|Date} [options.now] - 参照时间（必传，否则 timeLabel 为空）。
   * @param {object|Map|Function} [options.labels] - 状态标签，键 `sessionId#turn`。
   * @param {string|string[]} [options.keywords] - 查询词，用于算高亮位置。
   * @returns {object} 行模型。
   */
  function toRow(hit, options = {}) {
    const source = isPlainObject(hit) ? hit : {}
    const opts = isPlainObject(options) ? options : {}
    const time = source.time ?? source.end ?? source.start
    const title = typeof source.title === 'string' ? source.title.trim() : ''
    const sessionId = source.sessionId === null || source.sessionId === undefined ? '' : String(source.sessionId)
    // null / undefined / '' 都不是"第 0 轮"：不能编造轮次号。
    const turnNumber = source.turn === null || source.turn === undefined || source.turn === ''
      ? NaN
      : Number(source.turn)
    const label = resolveLabel(source, opts.labels)
    const statuses = statusesOf(label)
    const snippet = typeof source.snippet === 'string' ? source.snippet : ''

    const badges = []
    if (isFailure(source)) badges.push('失败')
    if (isInterrupted(source)) badges.push('中断')
    if (hasChanges(source)) badges.push('有变更')
    if (statuses.length > 0) badges.push('已标记')

    return {
      sessionId: source.sessionId ?? null,
      turn: Number.isFinite(turnNumber) ? turnNumber : null,
      seq: source.seq ?? null,
      time: Number.isFinite(toMs(time)) ? toMs(time) : null,
      turnLabel: Number.isFinite(turnNumber) ? `第 ${turnNumber} 轮` : '',
      title: title !== '' ? title : (shortSessionId(sessionId) || '未命名会话'),
      timeLabel: formatRelativeTime(time, opts.now),
      snippet,
      highlight: normalizeHighlight(source.highlight) || findHighlight(snippet, opts.keywords),
      matchLabel: source.matchedIn === 'response' ? '回答命中' : source.matchedIn === 'prompt' ? '提问命中' : '',
      badges,
      laneLabel: laneLabelOf(source),
      statusLabel: statuses.map(status => STATUS_TEXT[status]).join(' · '),
    }
  }

  /** 第一行：会话 · 第 N 轮 · 时间（空字段不留多余分隔符）。 */
  function headLine(row) {
    return [row.title, row.turnLabel, row.timeLabel]
      .filter(part => typeof part === 'string' && part !== '')
      .join(' · ')
  }

  /**
   * 右栏两行：`会话 · 第 N 轮 · 时间` + 片段。
   *
   * @param {object} row - `toRow` 的产物。
   * @returns {string[]} 两行文字。
   */
  function toTwoLine(row) {
    const source = isPlainObject(row) ? row : {}
    const snippet = typeof source.snippet === 'string' ? source.snippet : ''
    return [headLine(source), snippet]
  }

  /**
   * 主面板三行：两行 + `话题段 · 状态`。
   *
   * 第三行可能为空串（没有话题段也没有状态），保持数组长度固定，方便按行渲染。
   *
   * @param {object} row - `toRow` 的产物。
   * @returns {string[]} 三行文字。
   */
  function toThreeLine(row) {
    const source = isPlainObject(row) ? row : {}
    const [head, snippet] = toTwoLine(source)
    const foot = [source.laneLabel, source.statusLabel]
      .filter(part => typeof part === 'string' && part !== '')
      .join(' · ')
    return [head, snippet, foot]
  }

  /**
   * 分数来源一句话（A-14）：`提问×3 · 出现4次×0.8 · 2天前×1.4 · 重要+2`。
   *
   * @param {object} hit - 带 `breakdown.parts` 的命中。
   * @returns {string} 分项拼句；没有拆解时为空串。
   */
  function scoreParts(hit) {
    if (!isPlainObject(hit) || !isPlainObject(hit.breakdown) || !Array.isArray(hit.breakdown.parts)) return ''
    return hit.breakdown.parts
      .map(part => (typeof part === 'string' ? part : isPlainObject(part) && typeof part.text === 'string' ? part.text : ''))
      .filter(text => text !== '')
      .join(' · ')
  }

  /** 次数类的数字归一：非负整数，非法为 0。 */
  function countOf(value) {
    const number = Number(value)
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
  }

  /**
   * 会话分组头：`提过 N 次 · M 段 · 最近 <相对时间>`。
   *
   * 没有最近时间时省略"最近 …"一段，不硬拼空文案。
   *
   * @param {object} group - `searchTurns` 的分组对象（`count / lanes / latest`）。
   * @param {object} [options] - 选项。
   * @param {number|Date} [options.now] - 参照时间。
   * @returns {string} 分组头文案。
   */
  function groupHeader(group, options = {}) {
    const source = isPlainObject(group) ? group : {}
    const opts = isPlainObject(options) ? options : {}
    const count = countOf(source.count)
    const lanes = countOf(source.lanes)
    const latest = source.latest ?? source.time ?? source.lastTime ?? null
    const head = `提过 ${count} 次 · ${lanes} 段`
    const relative = formatRelativeTime(latest, opts.now)
    return relative === '' ? head : `${head} · 最近 ${relative}`
  }

  /** 一条命令是否失败（A-2 的 ✓/✗ 口径）。 */
  function isCommandFailed(command) {
    if (!isPlainObject(command)) return false
    if (command.ok === false || command.failed === true || command.status === 'failed') return true
    const exitCode = Number(command.exitCode)
    return Number.isFinite(exitCode) && exitCode !== 0
  }

  /**
   * 复制结果 → toast 文案（A-2）。
   *
   * 支持的输入形状（按优先级）：
   * - 命令数组：`[{ok}, {exitCode}]` 或 `['git status']`；
   * - `{ commands: [...] }`；
   * - 已聚合的计数：`{ count: 3, failed: 1 }`（也认 `total`）；
   * - 复制的不是命令：`{ text: '…' }` 或 `{ kind: 'conclusion' }`。
   *
   * 文案示例：`已复制 3 条命令（含 1 条失败）`；没有命令时给原因，不冒充成功。
   *
   * @param {Array|object|null} copied - 复制结果。
   * @returns {string} toast 文案。
   */
  function copySummary(copied) {
    const source = isPlainObject(copied) ? copied : {}
    const list = Array.isArray(copied)
      ? copied
      : (Array.isArray(source.commands) ? source.commands : null)

    let total = 0
    let failed = 0
    if (list !== null) {
      total = list.length
      failed = list.filter(isCommandFailed).length
    } else if (Number.isFinite(Number(source.count ?? source.total))) {
      total = Math.max(0, Math.floor(Number(source.count ?? source.total)))
      failed = Math.max(0, Math.min(total, Math.floor(Number(source.failed) || 0)))
    }

    if (total === 0) {
      if (source.kind === 'conclusion' || (typeof source.text === 'string' && source.text.trim() !== '')) {
        return '已复制结论'
      }
      return '没有可复制的命令'
    }
    return failed > 0
      ? `已复制 ${total} 条命令（含 ${failed} 条失败）`
      : `已复制 ${total} 条命令`
  }

      return {
        formatRelativeTime: formatRelativeTime, toRow: toRow, toTwoLine: toTwoLine,
        toThreeLine: toThreeLine, scoreParts: scoreParts, groupHeader: groupHeader,
        copySummary: copySummary,
      }
    })()
    // ══ hit-view 生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/cite.js
    // 引用块构造/反解（A-4），纯函数，独立测试过（tests/cite.mjs）。
    // 导出清单手写：客户端用了哪个名字就必须在这里导出一个，否则白屏。
    var CITE = (function () {
  /** C-1 默认引用预算。 */
  const DEFAULT_CITE_BUDGET = 5000

  /** 非中日韩字符的折算比例：约 3.6 字符 / token。 */
  const NON_CJK_PER_TOKEN = 3.6

  /** 是否普通对象（排除 null / 数组）。 */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** 统一成字符串；null / undefined → ''。 */
  function toText(value) {
    if (typeof value === 'string') return value
    if (value === null || value === undefined) return ''
    return String(value)
  }

  /** 压缩连续空白（块内多行字段只留一行）。 */
  function compress(text) {
    return toText(text).replace(/\s+/g, ' ').trim()
  }

  /** 转整数；非法返回 null。 */
  function toInteger(value) {
    if (value === null || value === undefined || value === '') return null
    const number = Number(value)
    return Number.isFinite(number) ? Math.trunc(number) : null
  }

  /** 正整数（预算 / 次数）；非法返回 null。 */
  function toPositiveInteger(value) {
    let number = NaN
    if (typeof value === 'number') number = value
    else if (typeof value === 'string' && value.trim() !== '') number = Number(value)
    if (Number.isFinite(number) && number > 0) return Math.floor(number)
    return null
  }

  /** 预算归一：非正整数回落 5000（C-1）。 */
  function normalizeBudget(value) {
    const positive = toPositiveInteger(value)
    return positive === null ? DEFAULT_CITE_BUDGET : positive
  }

  /** 结论条目归一：数组 / 单条字符串都认，去空、压缩空白。 */
  function normalizePoints(points) {
    const list = Array.isArray(points)
      ? points
      : (points === null || points === undefined || points === '' ? [] : [points])
    return list.map(point => compress(point)).filter(point => point !== '')
  }

  /** 代码点是否属于中日韩文字（含假名、谚文、CJK 标点与扩展区）。 */
  function isCjkCodePoint(codePoint) {
    return (
      (codePoint >= 0x2E80 && codePoint <= 0x2EFF) ||   // CJK 部首补充
      (codePoint >= 0x2F00 && codePoint <= 0x2FDF) ||   // 康熙部首
      (codePoint >= 0x3000 && codePoint <= 0x303F) ||   // CJK 标点
      (codePoint >= 0x3040 && codePoint <= 0x30FF) ||   // 平假名 / 片假名
      (codePoint >= 0x3100 && codePoint <= 0x312F) ||   // 注音
      (codePoint >= 0x31A0 && codePoint <= 0x31BF) ||
      (codePoint >= 0x31F0 && codePoint <= 0x31FF) ||
      (codePoint >= 0x3400 && codePoint <= 0x4DBF) ||   // 扩展 A
      (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||   // 基本区
      (codePoint >= 0xA960 && codePoint <= 0xA97F) ||   // 谚文字母扩展 A
      (codePoint >= 0xAC00 && codePoint <= 0xD7AF) ||   // 谚文音节
      (codePoint >= 0xD7B0 && codePoint <= 0xD7FF) ||   // 谚文字母扩展 B
      (codePoint >= 0xF900 && codePoint <= 0xFAFF) ||   // 兼容表意文字
      (codePoint >= 0xFE10 && codePoint <= 0xFE1F) ||   // 竖排标点
      (codePoint >= 0xFE30 && codePoint <= 0xFE4F) ||   // 兼容形式
      (codePoint >= 0xFF00 && codePoint <= 0xFFEF) ||   // 全角 / 半角形式
      (codePoint >= 0x20000 && codePoint <= 0x2FA1F) || // 扩展 B ~ F
      (codePoint >= 0x30000 && codePoint <= 0x3134F)    // 扩展 G / H
    )
  }

  /**
   * 估算文本的 token 数（A-4 的"约 +N tokens"）。
   *
   * 口径：中日韩字符按 1 token/字，其余字符按约 3.6 字符/token 折算后向上取整。
   * 示例：`中文 abc` → 2 + ceil(4/3.6) = 4。
   *
   * **这是估算，不是真实 token 数**：真实值以宿主 `tokenMeter` 为准。偏差主要来自
   * BPE 对代码、URL、标点与 emoji 的切分，以及"1 个汉字 = 1 token"的简化假设。
   * 预算判定建议留出余量；超预算时走 A-4 的二次确认，而不是相信这里的绝对值。
   *
   * @param {string} text - 文本。
   * @returns {number} 估算 token 数；空文本为 0。
   */
  function estimateTokens(text) {
    const source = typeof text === 'string' ? text : toText(text)
    if (source === '') return 0
    let cjk = 0
    let other = 0
    for (const char of source) {
      if (isCjkCodePoint(char.codePointAt(0))) cjk += 1
      else other += 1
    }
    return cjk + Math.ceil(other / NON_CJK_PER_TOKEN)
  }

  /** 两位补零。 */
  function pad2(value) {
    return String(value).padStart(2, '0')
  }

  /**
   * 本地时区（或指定时区）格式化 `YYYY-MM-DD HH:mm`。
   *
   * @param {number} ms - epoch ms。
   * @param {string} [timeZone] - IANA 时区；不传则用运行环境默认时区。
   * @returns {string} 格式化结果；失败为空串。
   */
  function formatStamp(ms, timeZone) {
    const base = {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }
    const render = options => {
      const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(new Date(ms))
      const pick = type => {
        const part = parts.find(item => item.type === type)
        return part === undefined ? '' : part.value
      }
      return `${pick('year')}-${pad2(pick('month'))}-${pad2(pick('day'))} ${pad2(pick('hour'))}:${pad2(pick('minute'))}`
    }
    const zone = typeof timeZone === 'string' ? timeZone.trim() : ''
    try {
      return render(zone === '' ? base : { ...base, timeZone: zone })
    } catch {
      // 时区名非法时退回运行环境默认时区，避免整条引用没有时间。
      try {
        return render(base)
      } catch {
        return ''
      }
    }
  }

  /**
   * 块里的时间：字符串原样用；数字 / Date 按本地时区格式化。
   *
   * @param {number|Date|string} value - 时间戳或已格式化文本。
   * @param {string} [timeZone] - IANA 时区覆盖（便于测试）。
   * @returns {string} 展示用时间；非法为空串。
   */
  function formatCiteTime(value, timeZone) {
    // 已格式化的文本也压缩成一行，避免调用方传进来的换行把块结构撑坏。
    if (typeof value === 'string') return compress(value)
    const ms = value instanceof Date
      ? value.getTime()
      : (typeof value === 'number' && Number.isFinite(value) ? value : NaN)
    if (!Number.isFinite(ms)) return ''
    return formatStamp(ms, timeZone)
  }

  /** 首行：`〔引用〕话题 › 会话 · 第 N 轮 · 时间`。 */
  function makeHeader(topic, title, turn, timeLabel) {
    const head = [topic, title].filter(text => text !== '').join(' › ')
    const turnText = turn === null ? '' : `第 ${turn} 轮`
    const meta = [head, turnText, timeLabel].filter(text => text !== '').join(' · ')
    return meta === '' ? '〔引用〕' : `〔引用〕${meta}`
  }

  /** 按开关拼块；body / 点数为空时整段省略（不留空标题）。 */
  function composeCite({ header, intent, points, body, pointer }) {
    const lines = [header]
    if (intent !== '') lines.push(`意图：${intent}`)
    if (points.length > 0) {
      lines.push('结论：')
      for (const point of points) lines.push(`- ${point}`)
    }
    if (body !== '') {
      lines.push('原文：')
      lines.push(body)
    }
    lines.push(pointer)
    return lines.join('\n')
  }

  /** 按实际内容算层：指针恒有；摘要与原文看是否留下内容。 */
  function layersOf(intent, points, body) {
    const layers = ['pointer']
    if (intent !== '' || points.length > 0) layers.push('summary')
    if (body !== '') layers.push('body')
    return layers
  }

  /**
   * 构造引用块。
   *
   * 预算策略（A-4）：
   * 1. 先砍原文（整段）；
   * 2. 再从末尾逐条砍结论；
   * 3. 结论砍光仍超预算时，保留「指针 + 意图」——指针与意图是摘要的最小语义单位，
   *    若它们本身就超预算，返回的 `tokens` 会大于 `budget`，交由调用方二次确认，
   *    绝不为了预算删掉出处。
   *
   * @param {object} input - 引用原料。
   * @param {string} [input.topic] - 话题名。
   * @param {string} [input.title] - 会话 / 对话标题。
   * @param {number|string} [input.turn] - 轮号（1-based）。
   * @param {number|Date|string} [input.time] - 时间戳或已格式化的时间文本。
   * @param {string} [input.timeZone] - IANA 时区（不传用运行环境默认时区）。
   * @param {string} [input.intent] - 意图一句。
   * @param {string[]|string} [input.points] - 结论条目。
   * @param {string} [input.body] - 原文（可选，默认不带）。
   * @param {string} [input.sessionId] - 会话 id（出处指针用）。
   * @param {number|string} [input.budget] - 预算（默认 5000，C-1）。
   * @returns {{text: string, tokens: number, layers: string[], trimmed: boolean}} 引用块。
   */
  function buildCite(input = {}) {
    const source = isPlainObject(input) ? input : {}
    const sessionId = toText(source.sessionId).trim()
    const turn = toInteger(source.turn)
    const topic = compress(source.topic)
    const title = compress(source.title)
    const intent = compress(source.intent)
    const points = normalizePoints(source.points)
    const body = toText(source.body).trim()
    const header = makeHeader(topic, title, turn, formatCiteTime(source.time, source.timeZone))
    const pointer = `出处：session/${sessionId}#${turn === null ? '' : turn}`
    const budget = normalizeBudget(source.budget)

    const fullText = composeCite({ header, intent, points, body, pointer })
    const fullTokens = estimateTokens(fullText)
    if (fullTokens <= budget) {
      return { text: fullText, tokens: fullTokens, layers: layersOf(intent, points, body), trimmed: false }
    }

    // 1) 先砍原文：摘要一个字不动。
    if (body !== '') {
      const withoutBody = composeCite({ header, intent, points, body: '', pointer })
      const tokens = estimateTokens(withoutBody)
      if (tokens <= budget) {
        return { text: withoutBody, tokens, layers: layersOf(intent, points, ''), trimmed: true }
      }
    }

    // 2) 再从末尾砍结论：保留前缀，绝不从中间挑。
    for (let keep = points.length - 1; keep >= 0; keep -= 1) {
      const kept = points.slice(0, keep)
      const text = composeCite({ header, intent, points: kept, body: '', pointer })
      const tokens = estimateTokens(text)
      if (tokens <= budget) {
        return { text, tokens, layers: layersOf(intent, kept, ''), trimmed: true }
      }
    }

    // 3) 结论全砍，指针与意图仍保留（可能超预算，交调用方二次确认）。
    const minimal = composeCite({ header, intent, points: [], body: '', pointer })
    return {
      text: minimal,
      tokens: estimateTokens(minimal),
      layers: layersOf(intent, [], ''),
      trimmed: true,
    }
  }

  /**
   * 从块里反解出处指针（round-trip 的另一半）。
   *
   * 只认 `出处：session/<id>#<turn>` 这一行；行首的 `〔引用〕…` 作为 `header`
   * 一并带回（块被裁剪过、或用户只贴了指针时 `header` 可能为空串）。
   *
   * @param {string} text - 引用块文本。
   * @returns {{sessionId: string, turn: number, header: string}|null} 指针；脏文本为 null。
   */
  function parseCite(text) {
    if (typeof text !== 'string' || text === '') return null
    const pointer = text.match(/^出处[：:]\s*session\/(.+)#(\d+)\s*$/m)
    if (pointer === null) return null
    const sessionId = pointer[1].trim()
    const turn = Number(pointer[2])
    if (sessionId === '' || !Number.isInteger(turn) || turn <= 0) return null
    const header = text.match(/^〔引用〕.*$/m)
    return {
      sessionId,
      turn,
      header: header === null ? '' : header[0].trim(),
    }
  }

  /**
   * 配置里的引用预算（C-1）。
   *
   * @param {object} [config] - 配置对象；读取 `citeTokenBudget`。
   * @param {number} [fallback] - 配置缺失 / 非法时的回落值（默认 5000）。
   * @returns {number} 正整数预算。
   */
  function citeBudgetOf(config, fallback = DEFAULT_CITE_BUDGET) {
    const options = isPlainObject(config) ? config : {}
    const configured = toPositiveInteger(options.citeTokenBudget)
    if (configured !== null) return configured
    return normalizeBudget(fallback)
  }

  /**
   * 把带原文的引用块折叠回「指针 + 摘要」。
   *
   * 原文段 = `原文：` 行到**最后一个** `出处：` 行之间；保留其它行。
   * 没有原文段时原样返回，输入非字符串返回空串。
   *
   * @param {string} text - 引用块文本。
   * @returns {string} 折叠后的块。
   */
  function stripBody(text) {
    if (typeof text !== 'string') return ''
    if (text === '') return ''
    const lines = text.split(/\r?\n/)
    const bodyAt = lines.findIndex(line => /^原文[：:]/.test(line))
    if (bodyAt === -1) return text
    let pointerAt = -1
    for (let i = lines.length - 1; i > bodyAt; i -= 1) {
      if (/^出处[：:]/.test(lines[i])) {
        pointerAt = i
        break
      }
    }
    const kept = lines.slice(0, bodyAt)
    if (pointerAt !== -1) kept.push(...lines.slice(pointerAt))
    return kept.join('\n')
  }

      return {
        buildCite: buildCite, estimateTokens: estimateTokens, parseCite: parseCite,
        citeBudgetOf: citeBudgetOf, stripBody: stripBody,
      }
    })()
    // ══ cite 生成段结束 ══

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

    function trackColor(col) {
      return THEME.trackColorAt(col, themeMode)
    }

    /**
     * 泳道取色：恒用话题色。
     *
     * 早先还有一个"状态色"模式（按完成/进行/阻塞着色）。状态系统整体删掉后，
     * 那个模式依赖的 stateIndex 永远为空，于是每条泳道都取到
     * statusColor('todo', 0) —— 实测是 hsl(220 8% 46%)，一片灰白。
     * 用户看到的就是"有些会话点进去泳道全是灰的"。
     *
     * 现在只保留话题色，参数 laneId 也一并去掉（不再需要按泳道查表）。
     */
    function laneStrokeColor(col) {
      return trackColor(col)
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

      // ── 渲染规模控制 ──
      //
      // 轮次一多（实测单会话已到 77 轮、80+ 连线），每次重绘要生成两三百个
      // SVG 元素，拖动/悬停就明显卡。两条措施：
      //
      //   1. 视口虚拟化：只画落在当前可见区域（含半屏余量）内的节点与编号。
      //      缩放到全览时所有节点都在视口内，等于不虚拟化 —— 所见即所渲染。
      //   2. 编号降级：节点太多时只给选中/悬停/聚焦泳道的节点画轮次编号，
      //      其余只留圆点。编号是纯装饰，密度太高反而糊成一片。
      //
      // 小会话不启用，避免为一屏元素白算一遍边界。
      var VIRT_MIN_NODES = 60
      var LABEL_MAX_NODES = 100
      var nodeCount = L.nodes.length
      var useVirtual = nodeCount > VIRT_MIN_NODES
      var useLabelLimit = nodeCount > LABEL_MAX_NODES
      var vp = props.view !== null && props.view !== undefined ? props.view : { scale: 1, offsetX: 0, offsetY: 0 }
      var vpScale = vp.scale > 0 ? vp.scale : 1
      var vpW = typeof props.viewW === 'number' ? props.viewW : 800
      var vpH = typeof props.viewH === 'number' ? props.viewH : 600
      // 图坐标系里的可见矩形，外扩半屏，滚动时边缘不会突然冒出来
      var padX = vpW / vpScale * 0.5
      var padY = vpH / vpScale * 0.5
      var visLeft = (-vp.offsetX) / vpScale - padX
      var visTop = (-vp.offsetY) / vpScale - padY
      var visRight = (vpW - vp.offsetX) / vpScale + padX
      var visBottom = (vpH - vp.offsetY) / vpScale + padY
      function inView(x, y) {
        if (!useVirtual) return true
        return x >= visLeft && x <= visRight && y >= visTop && y <= visBottom
      }

      // 每条泳道的轮次序列预先算好，供"邻接高亮"O(1) 查表。
      //
      // 早先是每个节点都 filter+map+sort 一遍整张图：77 个节点约 6000 次比较，
      // 300 个节点就是十万级 —— 纯浪费，且每次重绘都要重算。
      var laneTurnsOf = new Map()
      for (var lt0 = 0; lt0 < L.nodes.length; lt0 += 1) {
        var nd0 = L.nodes[lt0]
        var arr0 = laneTurnsOf.get(nd0.laneId)
        if (arr0 === undefined) { arr0 = []; laneTurnsOf.set(nd0.laneId, arr0) }
        arr0.push(nd0.turn)
      }
      laneTurnsOf.forEach(function (arr) { arr.sort(function (a, b) { return a - b }) })
      var neighborTurns = new Set()
      if (selected !== null && selected !== undefined) {
        var selLane0 = null
        for (var sn = 0; sn < L.nodes.length; sn += 1) {
          if (L.nodes[sn].turn === selected) { selLane0 = L.nodes[sn].laneId; break }
        }
        if (selLane0 !== null) {
          var seq0 = laneTurnsOf.get(selLane0) ?? []
          var at0 = seq0.indexOf(selected)
          if (at0 > 0) neighborTurns.add(seq0[at0 - 1])
          if (at0 >= 0 && at0 < seq0.length - 1) neighborTurns.add(seq0[at0 + 1])
        }
      }


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
        // 视口虚拟化：屏幕外的节点不生成 SVG 元素。
        // 选中/悬停的那一个即使移出视口也保留，避免"选中后拖走就消失"的错觉。
        if (!inView(nd.x, nd.y)
          && nd.turn !== selected
          && nd.turn !== hovered
          && nd.laneId !== focusLaneId) return

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
        var isNeighbor = inFocus && !isSel && neighborTurns.has(nd.turn)

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
        // 编号降级：节点太多时只给"关注的那几个"画编号。
        // 否则一屏几百个数字会糊成一片，而且白白多出几百个 DOM 节点。
        if (useLabelLimit && !isSel && !isHover && !inFocus) return
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
    /**
     * 左栏：工作区的「大类 → 子类 → 对话」三层列表。
     *
     * 这是左栏**唯一**的列表。之前这里同时存在会话树、大类列表、任务树三套，
     * 互相抢注意力，用户反馈"抓不住重点"。现在只留这一套，层级清晰：
     *
     *   大类（插件开发）          默认展开
     *     └ 子类（话题地图）      默认收起
     *         └ 对话（UI 重排…）  一行一个，带轮数
     *
     * 中间图与右栏负责"对话内部"的信息（泳道、节点、轮次），
     * 左栏只负责"工作区里有什么、怎么找到它"。
     *
     * 搜索：同时匹配大类名、子类名、对话标题；命中即保留整条分支。
     */
    function CategoryList(props) {
      var tree = props.tree
      var current = props.currentSessionId
      var folded = props.folded
      var onToggle = props.onToggle
      var onOpen = props.onOpen
      var onScope = props.onScope
      var activeScope = props.activeScope !== undefined ? props.activeScope : null
      // 当前正在看的会话 + 它的实时分段数。
      // 缓存里的段数会过期，用这个纠正那一个会话。
      var liveSessionId = props.liveSessionId !== undefined ? props.liveSessionId : null
      var liveLaneCount = props.liveLaneCount !== undefined ? props.liveLaneCount : null
      // 当前会话在归类树里的归属：`{ topic, dialog }`。
      //
      // 用于**默认高亮** —— 面板一打开就该看出"我现在这条对话属于哪个
      // 话题、哪个分组"，而不是等用户去点一下才有标记。
      var ownerTopic = props.ownerTopic !== undefined ? props.ownerTopic : null
      var ownerDialog = props.ownerDialog !== undefined ? props.ownerDialog : null
      // 一个工作区都没登记（全新机器 / 全新 profile）：提示语要和"还没归类"区分开
      var noWorkspace = props.noWorkspace === true
      var query = props.query
      var uncategorized = Array.isArray(props.uncategorized) ? props.uncategorized : []
      // 跨会话正文检索结果：结构里没命中时，这些是"对话内容里提到"的会话。
      var findHits = Array.isArray(props.findHits) ? props.findHits : null
      var findHint = props.findHint !== undefined ? props.findHint : ''
      var findBusy = props.findBusy === true
      var onCategorize = props.onCategorize
      var busy = props.busy === true
      var digests = props.digests !== undefined && props.digests !== null ? props.digests : {}

      /**
       * 取某个会话的一句话主题（提炼阶段产物）。
       * 没有提炼结果时返回 null，界面就不显示第二行。
       *
       * @param sessionId - 会话。
       * @returns 主题字符串或 null。
       */
      function digestsOf(sessionId) {
        var d = digests[sessionId]
        if (d === undefined || d === null) return null
        var t = typeof d.topic === 'string' ? d.topic.trim() : ''
        return t === '' ? null : t
      }

      if (!Array.isArray(tree) || tree.length === 0) {
        // 分清两种情况：没有工作区 vs 有工作区但还没归类。
        // 混在一起会让全新环境的人一直点「归类」——而没有工作区时
        // 归类根本无从下手（后端会返回"没有工作区"）。
        if (noWorkspace) {
          return h('div', { className: 'dsh_tm_clistempty' },
            '还没有登记任何工作区。',
            h('div', { className: 'dsh_tm_diag' }, '先在 DSH 里打开一个会话或新建工作区，再回到这里。'))
        }
        return h('div', { className: 'dsh_tm_clistempty' }, '还没有归类。点顶栏「归类」让模型分析。')
      }

      var colors = ['var(--tm-accent)', 'var(--tm-ok)', 'var(--tm-warn)', 'var(--tm-purple)', 'var(--tm-info)', 'var(--tm-err)']
      var q = String(query ?? '').trim().toLowerCase()
      var searching = q !== ''
      var out = []

      // ── 正文命中（置顶）──
      //
      // 顶栏那个框同时做两件事：筛左栏结构（话题/对话/会话名），
      // 以及跨会话搜对话正文。后者命中的会话可能不在这棵树里
      // （比如标题叫"开始吧"、正文却在讲部署），所以单独列一组。
      if (searching && findHits !== null && findHits.length > 0) {
        out.push(h('div', { key: '__find', className: 'dsh_tm_cfind' },
          h('div', { className: 'dsh_tm_cfindhd' },
            h('span', { className: 'dsh_tm_cfinddot' }),
            h('span', { className: 'dsh_tm_cfindname' }, '正文命中'),
            h('span', { className: 'dsh_tm_cfindn' }, String(findHits.length)),
          ),
          findHits.map(function (hit) {
            var sid = hit.sessionId
            return h('button', {
              key: 'fh' + String(sid),
              type: 'button',
              className: 'dsh_tm_cconv',
              'data-on': String(sid) === String(current) ? '1' : undefined,
              title: hit.title || String(sid),
              onClick: function () { onOpen(sid) },
            },
              h('span', { className: 'dsh_tm_cdot', style: { background: 'var(--tm-info)' } }),
              h('span', { className: 'dsh_tm_cmain' },
                h('span', { className: 'dsh_tm_ctxt' }, hit.title || String(sid)),
                // 命中片段：让用户看到"为什么这条被搜出来"
                hit.snippet !== undefined && hit.snippet !== null && hit.snippet !== ''
                  ? h('span', { className: 'dsh_tm_cdig' }, String(hit.snippet).slice(0, 60))
                  : null,
              ),
              hit.turns !== undefined && hit.turns !== null
                ? h('span', { className: 'dsh_tm_cmeta' }, hit.turns + ' 轮')
                : null,
            )
          }),
        ))
      } else if (searching && findBusy) {
        out.push(h('div', { key: '__findbusy', className: 'dsh_tm_cfindbusy' }, '正文检索中…'))
      }

      // ── 未归类组（置顶）──
      //
      // 新产生的会话还没被归类：放在最上面并给一个「归类」按钮。
      // 不静默复用缓存，否则新会话会"消失"在列表里，用户根本不知道
      // 有新东西没归。
      var fresh = uncategorized.filter(function (u) {
        if (q === '') return true
        return String(u.title ?? '').toLowerCase().indexOf(q) >= 0
      })
      if (fresh.length > 0) {
        out.push(h('div', { key: '__uncat', className: 'dsh_tm_cuncat' },
          h('div', { className: 'dsh_tm_cuncathd' },
            h('span', { className: 'dsh_tm_cuncatdot' }),
            h('span', { className: 'dsh_tm_cuncatname' }, '未归类'),
            h('span', { className: 'dsh_tm_cuncatn' }, String(fresh.length)),
            h('button', {
              type: 'button', className: 'dsh_tm_cuncatbtn',
              title: '让模型把这些新会话归入话题',
              disabled: busy,
              onClick: function (ev) { ev.stopPropagation(); if (typeof onCategorize === 'function') onCategorize() },
            }, busy ? '归类中…' : '归类'),
          ),
          fresh.map(function (u) {
            return h('button', {
              key: u.sessionId,
              type: 'button',
              className: 'dsh_tm_cconv',
              'data-on': u.sessionId === current ? '1' : undefined,
              title: u.title,
              onClick: function () { onOpen(u.sessionId) },
            },
              h('span', { className: 'dsh_tm_cdot', style: { background: 'var(--tm-text3)' } }),
              h('span', { className: 'dsh_tm_ctxt' }, u.title ?? '(未命名)'),
              // 轮数是后端已经算好的（过滤空会话时顺手数出来的），
              // 之前没渲染出来，导致新会话看不出规模。
              Number.isFinite(u.turns) && u.turns > 0
                ? h('span', { className: 'dsh_tm_cmeta' }, u.turns + ' 轮')
                : null,
            )
          }),
        ))
      }

      tree.forEach(function (cat, ci) {
        var catKey = 'cat:' + cat.name
        var color = colors[ci % colors.length]
        var catHit = searching && String(cat.name).toLowerCase().indexOf(q) >= 0
        // 搜索时一律展开：用户正在找东西，把结果藏起来等于没搜到
        var catOpen = searching || folded[catKey] !== true

        // 子类逐个处理：过滤 + 折叠
        var subBlocks = []
        var shown = 0

        for (var si = 0; si < (cat.subcategories ?? []).length; si += 1) {
          var sub = cat.subcategories[si]
          var subKey = catKey + ':sub:' + sub.name
          var subHit = searching && String(sub.name).toLowerCase().indexOf(q) >= 0

          // 对话过滤：大类或子类命中时全保留，否则按标题
          var list = (sub.sessions ?? []).filter(function (s) {
            if (q === '') return true
            if (catHit || subHit) return true
            return String(s.title ?? '').toLowerCase().indexOf(q) >= 0
          })
          if (list.length === 0) continue
          shown += list.length

          // 默认**展开**：会话行要能直接看到并点击。
          //
          // 曾经为了"不让子类淹没话题层次"改成默认收起，结果是：
          // 打开面板只看到话题名和对话名，一个会话都点不到
          // （只剩「未归类」里那条空会话可见），用户自然觉得
          // "点会话没反应、中间只显示列表"。
          // 现在按用户明确选过的默认全展开。
          var subOpen = folded[subKey] !== true

          // 这一段（对话）下的「段数 · 总轮数」。
          //
          // 段数 = 各会话被分成几段（泳道）之和，归类时已算好随树带回；
          // 轮数是各会话轮数之和。
          //
          // 但缓存里的段数会过期（会话一直在增长），所以对**当前正在看的
          // 会话**用前端已有的实时值纠正 —— 这个会话的分段结果就在 data 里，
          // 不必再请求后端。
          var sumSegs = 0
          var sumTurns = 0
          for (var sw = 0; sw < list.length; sw += 1) {
            var sess = list[sw]
            var isLive = liveSessionId !== null && liveSessionId !== undefined
              && String(sess.sessionId) === String(liveSessionId)
            var segs = isLive && liveLaneCount !== null && liveLaneCount !== undefined
              ? liveLaneCount
              : (Number.isFinite(sess.laneCount) ? sess.laneCount : 0)
            sumSegs += segs
            sumTurns += Number(sess.turns) || 0
          }
          var numLabel = sumSegs + ' 段 · ' + sumTurns + ' 轮'

          // 用 IIFE 把当次循环的值固定下来。
          //
          // 为什么必须这样：下面 push 进去的 onClick 是闭包，而 sub /
          // subKey / list / subOpen 都是 `var`（函数作用域，整个 for 共用
          // 一份）。不隔离的话，所有对话的点击回调都指向**最后一次迭代**
          // 的那个 sub —— 点"Skill与工程化"，中间显示的却是最后一类对话。
          // 用户看到的就是"点进去的内容不是所属的子类话题"。
          subBlocks.push((function (curSub, curKey, curList, curOpen, curColor) {
            return h('div', { key: curKey, className: 'dsh_tm_csub' },
            h('button', {
              type: 'button', className: 'dsh_tm_csubhd',
              'data-hit': subHit ? '1' : undefined,
              // 当前会话所属的分组：默认高亮
              'data-owner': ownerDialog !== null && ownerDialog === curSub.name && ownerTopic === cat.name ? '1' : undefined,
              'data-scope': activeScope !== null && activeScope.level === 'dialog' && activeScope.name === curSub.name ? '1' : undefined,
              onClick: function (ev) {
                ev.stopPropagation()
                onToggle(curKey)
                // 点对话 → 中间显示它下层的「会话列表」
                if (typeof onScope !== 'function') return
                var ss = curSub.sessions ?? []
                var sessions = []
                for (var w2 = 0; w2 < ss.length; w2 += 1) {
                  sessions.push({ id: ss[w2].sessionId, title: ss[w2].title, turns: ss[w2].turns })
                }
                onScope({
                  level: 'dialog',
                  name: curSub.name,
                  sessions: sessions,
                  // 面包屑带上父话题，才能一级一级退回去
                  crumbs: [
                    { level: 'topic', name: cat.name },
                    { level: 'dialog', name: curSub.name },
                  ],
                })
              },
            },
              h('span', { className: 'dsh_tm_caret' }, curOpen ? '▾' : '▸'),
              // 对话层的颜色标记：一条 2px 短竖线，颜色继承所属话题。
              //
              // 为什么不像话题那样用粗色条：对话是从属于话题的，用同样的
              // 视觉重量会让人误以为它们是同级的。降低不透明度之后，
              // 既能看出"这个对话属于哪一类"，又不会与话题争主次。
              h('span', {
                className: 'dsh_tm_csubbar',
                style: { background: curColor },
              }),
              h('span', { className: 'dsh_tm_csubname' }, curSub.name),
              h('span', { className: 'dsh_tm_csubn' }, numLabel),
            ),
            curOpen
              ? curList.map(function (s) {
                  var titleHit = searching && String(s.title ?? '').toLowerCase().indexOf(q) >= 0
                  return h('button', {
                    key: s.sessionId,
                    type: 'button',
                    className: 'dsh_tm_cconv',
                    'data-on': s.sessionId === current ? '1' : undefined,
                    'data-hit': titleHit ? '1' : undefined,
                    title: s.title,
                    onClick: function () { onOpen(s.sessionId) },
                  },
                    h('span', { className: 'dsh_tm_cdot', style: { background: curColor } }),
                    h('span', { className: 'dsh_tm_cmain' },
                      h('span', { className: 'dsh_tm_ctxt' }, s.title ?? '(未命名)'),
                      // 第二行：提炼出的一句话主题。
                      // 这是"这段对话到底在做什么"，比标题更具体——
                      // 标题常常是"开始吧""继续"这种，看不出内容。
                      digestsOf(s.sessionId) !== null
                        ? h('span', { className: 'dsh_tm_cdig' }, digestsOf(s.sessionId))
                        : null,
                    ),
                    h('span', { className: 'dsh_tm_cmeta' },
                      // 与「对话」层一致：显示「N 段 · M 轮」，不只显示轮数。
                      // 段数优先用实时值（当前会话），否则用缓存里的 laneCount。
                      (function () {
                        var liveRow = liveSessionId !== null && liveSessionId !== undefined
                          && String(s.sessionId) === String(liveSessionId)
                        var segs = liveRow && liveLaneCount !== null && liveLaneCount !== undefined
                          ? liveLaneCount
                          : (Number.isFinite(s.laneCount) ? s.laneCount : 0)
                        var turns = Number(s.turns) || 0
                        return segs + ' 段 · ' + turns + ' 轮'
                      })()),
                  )
                })
              : null,
            )
          })(sub, subKey, list, subOpen, color))
        }

        if (shown === 0) return

        out.push(h('div', { key: catKey, className: 'dsh_tm_ccat' },
          h('button', {
            type: 'button', className: 'dsh_tm_ccathd',
            'data-hit': catHit ? '1' : undefined,
            // 高亮当前层级。
            // 两种情形都算"在这个话题下"：
            //   中间显示的是这个话题本身（level='topic'）
            //   中间显示的是它的某个对话（level='dialog'，从 crumbs 找父话题）
            // 后者也必须高亮，否则从中间列表点进对话后，
            // 左栏看起来"什么都没选中"。
            // data-owner = "当前会话属于这里"，默认就亮，不需要用户先点一下。
            // 与 data-scope（正在浏览的层级）分开：两者可能不同 ——
            // 比如你在浏览别的话题时，自己那条对话的归属仍应可见。
            'data-owner': ownerTopic !== null && ownerTopic === cat.name ? '1' : undefined,
            'data-scope': (function () {
              if (activeScope === null || activeScope === undefined) return undefined
              if (activeScope.name === cat.name) return '1'
              var crumbs = Array.isArray(activeScope.crumbs) ? activeScope.crumbs : []
              for (var ci2 = 0; ci2 < crumbs.length; ci2 += 1) {
                if (crumbs[ci2].level === 'topic' && crumbs[ci2].name === cat.name) return '1'
              }
              return undefined
            })(),
            onClick: function () {
              onToggle(catKey)
              // 点话题 → 中间显示它下层的「对话列表」。
              // 折叠照旧生效：折叠是浏览动作，与"进入下一级"不冲突。
              if (typeof onScope !== 'function') return
              var dialogs = []
              for (var q = 0; q < (cat.subcategories ?? []).length; q += 1) {
                var sub2 = cat.subcategories[q]
                var ss = sub2.sessions ?? []
                var turnSum = 0
                for (var w = 0; w < ss.length; w += 1) {
                  if (typeof ss[w].turns === 'number') turnSum += ss[w].turns
                }
                dialogs.push({ name: sub2.name, sessionCount: ss.length, turnCount: turnSum })
              }
              if (dialogs.length > 0) {
                onScope({
                  level: 'topic',
                  name: cat.name,
                  items: dialogs,
                  crumbs: [{ level: 'topic', name: cat.name, items: dialogs }],
                })
              }
            },
          },
            h('span', { className: 'dsh_tm_caret' }, catOpen ? '▾' : '▸'),
            h('span', { className: 'dsh_tm_ccatbar', style: { background: color } }),
            h('span', { className: 'dsh_tm_ccatname' }, cat.name),
            h('span', { className: 'dsh_tm_ccatn' }, String(shown)),
          ),
          catOpen ? subBlocks : null,
        ))
      })

      if (out.length === 0) {
        return h('div', { className: 'dsh_tm_clistempty' }, '没有匹配的话题或会话')
      }
      return h('div', { className: 'dsh_tm_clist' }, out)
    }


    /**
     * 右栏：当前话题的「主题 + 轮次列表」。
     *
     * 这是 v2 布局的核心：回答"这一段对话都是哪几轮、每轮干了什么"。
     *
     * 设计要点：
     *   - 顶部固定：归属（大类 › 话题）+ 状态/轮数/用量
     *   - 下方滚动：轮次列表，每轮默认两行摘要，点开看完整详情
     *   - 点某一轮 = 选中它（与图上节点联动），并滚到图上对应位置
     *
     * 为什么默认折叠：一个 44 轮的会话，全部展开要滚动很久，
     * 而且大多数时候用户只想扫一眼"都聊了什么"。
     */
    /**
     * 层级列表：点话题显示对话列表，点对话显示会话列表。
     *
     * 这是左栏与地图之间的"中间层"。左栏负责导航，地图负责细节，
     * 而这两者之间需要一个地方回答"这一级下面有什么"——
     * 否则点话题就直接跳到地图，用户看不到它的内部构成。
     *
     * 两种层级共用这一个组件，按 level 决定列什么：
     *   level='topic'   列出该话题下的「对话」（子类）
     *   level='dialog'  列出该对话下的「会话」
     */
    function LevelList(props) {
      var items = Array.isArray(props.items) ? props.items : []
      var level = props.level
      var crumbs = Array.isArray(props.crumbs) ? props.crumbs : []

      var rows = items.map(function (it, i) {
        var isTopic = level === 'topic'
        var title = isTopic ? it.name : (it.title || '(未命名)')
        var meta = isTopic
          ? (it.sessionCount + ' 个会话 · ' + it.turnCount + ' 轮')
          : (it.turns === null || it.turns === undefined ? '' : it.turns + ' 轮')

        return h('button', {
          key: isTopic ? 'c' + i : it.id,
          type: 'button',
          className: 'dsh_tm_lvrow',
          title: title,
          onClick: function () { props.onPick(it) },
        },
          h('span', { className: 'dsh_tm_lvdot', style: { background: trackColor(i % 6) } }),
          h('span', { className: 'dsh_tm_lvmain' },
            h('span', { className: 'dsh_tm_lvtitle' }, title),
            // 会话层显示提炼出的一句话主题：标题常是"开始吧""继续"，
            // 主题才能看出这段对话到底在做什么。
            !isTopic && it.topic !== undefined && it.topic !== null && it.topic !== ''
              ? h('span', { className: 'dsh_tm_lvsub' }, it.topic)
              : null,
          ),
          h('span', { className: 'dsh_tm_lvmeta' }, meta),
          h('span', { className: 'dsh_tm_lvcaret' }, '›'),
        )
      })

      return h('div', { className: 'dsh_tm_lvwrap' },
        h('div', { className: 'dsh_tm_lvhead' },
          h('button', {
            type: 'button', className: 'dsh_tm_lvback',
            title: '返回上一级',
            onClick: function (ev) { ev.stopPropagation(); props.onBack() },
          }, '‹ 返回'),
          crumbs.map(function (c, ci) {
            return h('span', { key: 'cb' + ci, className: 'dsh_tm_lvcrumbs' },
              ci > 0 ? h('span', { className: 'dsh_tm_lvsep' }, '›') : null,
              h('button', {
                type: 'button',
                className: 'dsh_tm_lvcrumb',
                'data-on': ci === crumbs.length - 1 ? '1' : undefined,
                onClick: function () { return function (ev) {
                  ev.stopPropagation()
                  props.onCrumb(c)
                } }(c),
              }, c.name),
            )
          }),
          h('span', { className: 'dsh_tm_lvcount' },
            items.length === 0 ? '' : items.length + ' 项'),
        ),
        h('div', { className: 'dsh_tm_lvbody' },
          rows.length === 0
            ? h('div', { className: 'dsh_tm_lvempty' },
                props.loading === true ? '加载中…' : '这一级下面没有内容')
            : rows,
        ),
      )
    }

    function TurnList(props) {
      var lane = props.lane
      var turns = props.turns
      var openTurns = props.openTurns
      var selected = props.selected
      var onToggleTurn = props.onToggleTurn
      var onSelectTurn = props.onSelectTurn
      var onJump = props.onJump

      /**
       * 会话内搜索：只筛当前会话的轮次。
       *
       * 与顶栏那个搜索框分工不同：
       *   顶栏 → 跨会话（筛左栏的话题/对话/会话）
       *   这里 → 当前会话内部（筛轮次）
       * 一个会话几十轮时，想找"哪几轮在讲部署"只能靠它。
       *
       * 状态放在组件内部：它是临时的浏览动作，不需要跨会话记忆。
       */
      var qState = useState('')
      var q = qState[0]; var setQ = qState[1]

      if (lane === null || lane === undefined) return null

      var own = Array.isArray(lane.turns) ? lane.turns.slice() : []
      // 正序：先看最早的，符合"读一段对话"的习惯
      own.sort(function (a, b) { return a - b })

      var byTurn = new Map()
      for (var i = 0; i < (Array.isArray(turns) ? turns.length : 0); i += 1) {
        byTurn.set(turns[i].turn, turns[i])
      }

      // 搜索过滤：匹配提问或回复内容。
      //
      // 搜索范围是**整个会话**，不是当前这一段。早先只搜 own（当前泳道），
      // 但占位文案写的是"搜本会话" —— 用户找别的话题里的内容会得到 0 条，
      // 看起来像功能坏了。现在搜全量，并在结果里标出所属话题。
      var needle = String(q === undefined || q === null ? '' : q).trim().toLowerCase()
      var matched = own
      var laneOfTurn = new Map()
      if (needle !== '') {
        // 建立"轮次 → 所属话题标题"的索引，供结果行标注
        var allLanes = Array.isArray(props.allLanes) ? props.allLanes : []
        for (var li2 = 0; li2 < allLanes.length; li2 += 1) {
          var lts = Array.isArray(allLanes[li2].turns) ? allLanes[li2].turns : []
          for (var lt = 0; lt < lts.length; lt += 1) {
            laneOfTurn.set(lts[lt], allLanes[li2].title ?? '')
          }
        }
        // 搜全部轮次（turns 是会话级全量）
        var pool = []
        for (var ti2 = 0; ti2 < (Array.isArray(turns) ? turns.length : 0); ti2 += 1) {
          pool.push(turns[ti2].turn)
        }
        pool.sort(function (a, b) { return a - b })
        matched = pool.filter(function (turnNo) {
          var f = byTurn.get(turnNo)
          if (f === undefined) return false
          var pp = String(f.prompt === undefined ? '' : f.prompt).toLowerCase()
          var rr = String(f.response === undefined ? '' : f.response).toLowerCase()
          return pp.indexOf(needle) >= 0 || rr.indexOf(needle) >= 0
        })
      }

      var rows = matched.map(function (turnNo) {
        var fact = byTurn.get(turnNo)
        var isOpen = openTurns[turnNo] === true
        var isSel = selected === turnNo
        var prompt = fact === undefined ? '（无数据）' : String(fact.prompt ?? '')
        var reason = fact === undefined ? 'completed' : fact.endReason
        var dotColor = reason === 'error' ? 'var(--tm-err)'
          : reason === 'aborted' || reason === 'interrupted' ? 'var(--tm-warn)'
            : reason === 'blocked' ? 'var(--tm-err)'
              : 'var(--tm-ok)'
        var cost = fact === undefined ? null : fmtTokens((fact.usage?.input ?? 0) + (fact.usage?.output ?? 0))

        return h('div', {
          key: 'tr' + turnNo,
          className: 'dsh_tm_turnrow',
          'data-open': isOpen ? '1' : undefined,
          'data-sel': isSel ? '1' : undefined,
          onClick: function () { onSelectTurn(turnNo) },
        },
          h('div', { className: 'dsh_tm_trowline' },
            h('span', { className: 'dsh_tm_tno' }, 'T' + turnNo),
            h('span', { className: 'dsh_tm_tprompt' }, prompt),
            h('span', { className: 'dsh_tm_tmeta' },
              h('span', { className: 'dsh_tm_tsdot', style: { background: dotColor } }),
              cost === null ? '' : cost,
            ),
            h('button', {
              type: 'button', className: 'dsh_tm_tunfold',
              title: isOpen ? '收起' : '展开详情',
              onClick: function (ev) { ev.stopPropagation(); onToggleTurn(turnNo) },
            }, isOpen ? '−' : '+'),
          ),
          // 搜索时标出这条结果属于哪个话题：
          // 搜的是整个会话，结果可能来自别的段，不标就不知道点下去会跳到哪
          needle !== '' && laneOfTurn.get(turnNo) !== undefined
            ? h('div', { className: 'dsh_tm_tlane' }, laneOfTurn.get(turnNo) ?? '')
            : null,
          isOpen
            ? h('div', { className: 'dsh_tm_tdetail' },
                h('div', { className: 'dsh_tm_tdsec' },
                  h('span', { className: 'dsh_tm_tdk' }, '回复'),
                  h('div', null, fact === undefined ? '（无）' : String(fact.response ?? '').slice(0, 400)),
                ),
                fact !== undefined && Array.isArray(fact.tools) && fact.tools.length > 0
                  ? h('div', { className: 'dsh_tm_tdsec' },
                      h('span', { className: 'dsh_tm_tdk' }, '工具调用'),
                      h('div', { className: 'dsh_tm_ttools' },
                        fact.tools.map(function (t, ti) {
                          return h('span', { key: 'tl' + ti, className: 'dsh_tm_ttool' }, t)
                        }),
                      ),
                    )
                  : null,
                h('div', { className: 'dsh_tm_tdsec' },
                  h('span', { className: 'dsh_tm_tdk' }, '用量与耗时'),
                  h('div', { className: 'dsh_tm_tdcode' },
                    fmtTokens(fact?.usage?.input ?? 0) + ' in · '
                    + fmtTokens(fact?.usage?.output ?? 0) + ' out · '
                    + fmtDuration(fact?.durationMs ?? 0)
                    + (fact?.toolCalls ? ' · ' + fact.toolCalls + ' 次工具' : ''),
                  ),
                ),
                fact !== undefined && typeof onJump === 'function'
                  ? h('button', {
                      type: 'button', className: 'dsh_tm_tjump',
                      onClick: function (ev) { ev.stopPropagation(); onJump(turnNo) },
                    }, '跳转到这段对话')
                  : null,
              )
            : null,
        )
      })

      return h('div', { className: 'dsh_tm_turnlist' },
        // 顶部：主题归属（固定）
        h('div', { className: 'dsh_tm_tlhead' },
          // 归属路径：这个话题属于哪个「话题 › 对话」。
          //
          // 早先这里读 lane.stageName（阶段名）。阶段系统删掉之后它永远是
          // null，于是**永远显示"未分类"** —— 用户看到的就是"没有显示
          // 正确的所属分类"。现在改成读归类树里的归属路径。
          h('div', { className: 'dsh_tm_tlpath' },
            props.ownerPath !== undefined && props.ownerPath !== null && props.ownerPath !== ''
              ? props.ownerPath
              : '未归类',
          ),
          h('div', { className: 'dsh_tm_tlname' }, lane.title ?? '（未命名）'),
          h('div', { className: 'dsh_tm_tlbadges' },
            h('span', { className: 'dsh_tm_tlb' }, own.length + ' 轮'),
            needle !== ''
              ? h('span', { className: 'dsh_tm_tlb dsh_tm_tlbhit' },
                  '匹配 ' + matched.length + '/' + own.length)
              : null,
          ),
          // 会话内搜索：只筛这个会话的轮次
          h('div', { className: 'dsh_tm_tlsearch' },
            h('span', { className: 'dsh_tm_tlsearchicon' }, '⌕'),
            h('input', {
              className: 'dsh_tm_finput',
              type: 'text',
              value: q,
              placeholder: '搜本会话轮次…',
              title: '只在当前会话的轮次里找，匹配提问与回复内容',
              onChange: function (ev) { setQ(ev.target.value) },
              onKeyDown: function (ev) {
                if (ev.key === 'Escape') { ev.stopPropagation(); setQ('') }
              },
            }),
            q !== ''
              ? h('button', {
                  type: 'button', className: 'dsh_tm_fx',
                  title: '清空',
                  onClick: function (ev) { ev.stopPropagation(); setQ('') },
                }, '×')
              : null,
          ),
        ),
        // 轮次列表（滚动）
        h('div', { className: 'dsh_tm_tlbody' },
          rows.length === 0 && needle !== ''
            ? h('div', { className: 'dsh_tm_lvempty' }, '本会话里没有匹配的轮次')
            : rows,
        ),
      )
    }

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

    function SettingsPopover(props) {
      var cfg = props.config
      var onSave = props.onSave
      var onClose = props.onClose
      var pState = useState(cfg === null ? '' : cfg.provider)
      var mState = useState(cfg === null ? '' : cfg.model)
      var lState = useState(cfg === null ? 50 : cfg.turnLimit)
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

    /**
     * 会话负载的前端缓存：sessionId → { at, payload }。
     *
     * 为什么需要：在「对话 / 轨迹 / 上下文 / 编队」之间来回切，面板会整块
     * 卸载再挂载，每次挂载都要重新请求一次 session —— 实测当前会话
     * 1400-1500ms，响应 181KB 还要重新解析。用户感觉到的"切页签卡一下"
     * 主要就是它。
     *
     * 有缓存后：挂载瞬间就有内容可画，随后在后台静默刷新。
     * 后端本身有缓存（命中时 5-47ms），所以刷新很便宜。
     */
    var SESSION_CACHE = new Map()
    var SESSION_CACHE_TTL_MS = 5 * 60 * 1000

    /** 工作区归类树的前端缓存：key → { at, value }。切页签回来不必重算。 */
    var TREE_CACHE = new Map()
    var TREE_CACHE_TTL_MS = 60 * 1000

    /** 浏览会话不能借用宿主当前会话的锚点、分页与阅读位置。 */
    function canJumpToSession(sessionId, viewedId, payload, scope) {
      return typeof sessionId === 'string' && sessionId !== ''
        && viewedId === sessionId && payload !== null && payload !== undefined
        && payload.sessionId === sessionId && scope === null
    }

    /** 只接受所选轮次的可见用户输入；不能把过程行或下一轮当成成功。 */
    function findUserTurnRow(turnNo, anchorKey, scrollEl) {
      if (typeof document === 'undefined' || scrollEl === null) return null
      var anchor = findTurnRow(anchorKey, scrollEl)
      if (anchor === null || Number(anchor.getAttribute('data-chat-turn')) !== turnNo) return null
      function matches(row) {
        return row !== null && !row.hasAttribute('hidden') && row.closest('[hidden]') === null
          && Number(row.getAttribute('data-chat-turn')) === turnNo
          && row.getAttribute('data-chat-flow-kind') === 'user'
          && row.getBoundingClientRect().height > 0
      }
      if (matches(anchor)) return anchor
      var rows = scrollEl.querySelectorAll('[data-chat-turn][data-chat-flow-kind="user"]')
      for (var i = 0; i < rows.length; i += 1) if (matches(rows[i])) return rows[i]
      return null
    }

    /**
     * 复用已核实的 DSH 原生轮次导航，让 Chat 自己取消跟随底部并保存阅读位置。
     * 导航轨道会虚拟化：用已渲染按钮的实际间距滚动轨道，最终只点击精确标签。
     */
    function activateChatTurn(turnNo, turns) {
      if (typeof document === 'undefined') return false
      var nav = document.querySelector('nav[aria-label="轮次导航"],nav[aria-label="Turn navigation"]')
      if (nav === null) return turns.length < 2
      var buttons = nav.querySelectorAll('button[data-index]')
      var labels = ['跳转到第 ' + turnNo + ' 轮', '加载并跳转到第 ' + turnNo + ' 轮',
        'Jump to turn ' + turnNo, 'Load and jump to turn ' + turnNo]
      for (var i = 0; i < buttons.length; i += 1) {
        if (labels.indexOf(buttons[i].getAttribute('aria-label')) >= 0) { buttons[i].click(); return true }
      }
      if (buttons.length < 2) return false
      var index = turns.map(function (f) { return f.turn }).sort(function (a, b) { return a - b }).indexOf(turnNo)
      var first = buttons[0]
      var last = buttons[buttons.length - 1]
      var deltaIndex = Number(last.getAttribute('data-index')) - Number(first.getAttribute('data-index'))
      var pitch = (last.getBoundingClientRect().top - first.getBoundingClientRect().top) / deltaIndex
      var rail = nav.firstElementChild
      if (index >= 0 && rail !== null && Number.isFinite(pitch) && pitch > 0) {
        rail.scrollTop = Math.max(0, rail.scrollTop + first.getBoundingClientRect().top
          - rail.getBoundingClientRect().top + (index - Number(first.getAttribute('data-index'))) * pitch - rail.clientHeight / 2)
      }
      return false
    }

    function showJumpNotice(message) {
      if (typeof document === 'undefined') return
      var old = document.getElementById('dsh_tm_jump_notice')
      if (old !== null) old.remove()
      var notice = document.createElement('div')
      notice.id = 'dsh_tm_jump_notice'
      notice.setAttribute('role', 'alert')
      notice.textContent = message
      notice.style.cssText = 'position:fixed;right:24px;bottom:90px;z-index:9999;max-width:380px;padding:12px 16px;border-radius:8px;background:#492c15;color:#fff;font-size:13px;box-shadow:0 4px 18px #0004'
      document.body.appendChild(notice)
      window.setTimeout(function () { notice.remove() }, 7000)
    }

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

    /**
     * 把目标行保持在滚动容器顶端，直到它稳定下来。
     *
     * 与面板里的跳转共用：定位那一刻算出的绝对位置，在内容继续变化后
     * （图片解码、代码高亮、折叠动画、字体度量）就会失效，所以每一帧
     * 重新测量并纠正，而不是锁一个固定的 scrollTop。
     *
     * 退出条件：读者自己滚动（wheel / touch / 按键 / 指针按下）立即放手；
     * 超过帧数上限放手。
     *
     * @param scroller - 对话滚动容器。
     * @param el - 目标行。
     * @param raf - 可注入的帧调度（测试用）；缺省用 window.requestAnimationFrame。
     */
    function pinRowToTop(scroller, el, raf) {
      if (scroller === null || typeof scroller.scrollTop !== 'number') return
      if (el === null || typeof el.isConnected !== 'boolean') return
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

      function desiredTop() {
        var box = scroller.getBoundingClientRect()
        var row = el.getBoundingClientRect()
        return Math.max(0, scroller.scrollTop + (row.top - box.top) - REVEAL_TOP_PAD)
      }

      function verify() {
        if (released) return
        if (!el.isConnected) { released = true; return }

        var wanted = desiredTop()
        var now = scroller.scrollTop
        var maxTop = Math.max(0, (Number(scroller.scrollHeight) || 0) - (Number(scroller.clientHeight) || 0))
        var snappedToBottom = Number.isFinite(maxTop) && maxTop > 0 && now >= maxTop - 4
        if (!snappedToBottom && Math.abs(now - lastWritten) > 4 && Math.abs(now - wanted) > 4) {
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

    /** 工作区规模：话题按左树顶层计数，轮次按会话去重汇总。 */
    function workspaceTotals(tree, uncategorized, live) {
      var topics = Array.isArray(tree) ? tree : []
      var sessions = new Map()
      topics.forEach(function (cat) {
        ;(cat.subcategories || []).forEach(function (sub) {
          ;(sub.sessions || []).forEach(function (s) { sessions.set(s.sessionId, s.turns) })
        })
      })
      ;(uncategorized || []).forEach(function (s) { sessions.set(s.sessionId, s.turns) })
      if (live && sessions.has(live.sessionId)) sessions.set(live.sessionId, live.totals.turns)
      var turns = 0
      var complete = true
      sessions.forEach(function (n) {
        if (typeof n !== 'number' || !Number.isFinite(n)) complete = false
        else turns += n
      })
      return { turns: complete ? turns : null, topics: topics.length }
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
      // 提示框位置的合并器：每帧最多提交一次（见 onHover 的说明）
      var posPendingRef = useRef(null)
      var posRafRef = useRef(0)
      var selState = useState(null); var selected = selState[0]; var setSelected = selState[1]
      /**
       * 右栏轮次列表里"已展开详情"的轮次集合。
       *
       * 与 selected 分开：selected 是"在图上/列表里高亮的那一轮"，
       * openTurns 是"哪些轮的详情被展开了"。两者可以不同——
       * 用户可能选中 A 轮但展开 B 轮的详情来对比。
       */
      var openTurnsState = useState({}); var openTurns = openTurnsState[0]; var setOpenTurns = openTurnsState[1]
      /**
       * 搜索有输入但零命中。
       *
       * 为真时中间图与右栏都不渲染——只留左栏那句"没有匹配的结果"。
       * 否则用户会以为"图没跟着搜"，因为图上还挂着上一次的内容。
       */
      var searchEmptyState = useState(false)
      var searchEmpty = searchEmptyState[0]; var setSearchEmpty = searchEmptyState[1]

      // 视口：缩放 + 平移。滚轮、拖拽、按钮都改它。
      var viewState = useState({ scale: 1, offsetX: 0, offsetY: 0 })
      var view = viewState[0]; var setView = viewState[1]

      /**
       * 当前浏览层级。这是"左栏 → 中间"的核心状态。
       *
       *   null                    只显示当前会话的地图（默认）
       *   { level: 'topic',  ... } 显示该话题下的「对话列表」
       *   { level: 'dialog', ... } 显示该对话下的「会话列表」
       *
       * 点具体会话时回到 null —— 那时中间就是那一个会话的泳道地图。
       *
       * 为什么需要这一层：左栏是导航、地图是细节，两者之间必须有个地方
       * 回答"这一级下面有什么"。少了它，点话题就直接跳进地图，
       * 用户看不到这个话题由哪几个对话组成。
       */
      var scopeState = useState(null)
      var laneScope = scopeState[0]; var setLaneScope = scopeState[1]

      /**
       * 各会话的分段数据缓存：sessionId → payload。
       *
       * 列表里要显示轮数与主题，需要读会话（约 1 秒/个）。
       * 缓存后重复点同一级是瞬时的。
       */
      var scopeDataState = useState({})
      var scopeData = scopeDataState[0]; var setScopeData = scopeDataState[1]
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
        // 还没归类的新会话（后端在缓存命中时单独返回）
        uncategorized: [],
        // 每个会话的一句话主题（提炼阶段产物）
        digests: {},
        // 左栏「大类 → 对话」列表的关键字（只筛标题，轻量）
        query: '',
      })
      var sessionTree = stState[0]; var setSessionTree = stState[1]
      var workspaceRequestRef = useRef(0)

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

      /**
       * 就地更新树里某个会话的轮数与段数。
       *
       * 用途：当前会话新写了一轮时，左栏那个「N 段 · M 轮」要立刻跟上，
       * 而不是等下次重新归类。整棵树只在必要时重建节点对象，
       * 没变的分类/对话保持同一个引用，减少无谓重渲染。
       *
       * @param sid - 会话 id。
       * @param turns - 最新轮数。
       * @param laneCount - 最新段数（未知时传 null，保留原值）。
       */
      function patchSessionStats(sid, turns, laneCount) {
        if (sid === undefined || sid === null) return
        setSessionTree(function (prev) {
          var tree = Array.isArray(prev.tree) ? prev.tree : []
          var changed = false
          var nextTree = tree.map(function (cat) {
            var subs = cat.subcategories ?? []
            var nextSubs = subs.map(function (sub) {
              var sess = sub.sessions ?? []
              var nextSess = sess.map(function (s) {
                if (String(s.sessionId) !== String(sid)) return s
                var nextTurns = Number.isFinite(turns) ? turns : s.turns
                var nextLanes = Number.isFinite(laneCount) ? laneCount : s.laneCount
                if (nextTurns === s.turns && nextLanes === s.laneCount) return s
                changed = true
                return Object.assign({}, s, { turns: nextTurns, laneCount: nextLanes })
              })
              return nextSess === sess ? sub : Object.assign({}, sub, { sessions: nextSess })
            })
            return Object.assign({}, cat, { subcategories: nextSubs })
          })
          if (!changed) return prev
          return Object.assign({}, prev, { tree: nextTree })
        })
      }

      /**
       * 找出搜索命中的第一个对话。
       *
       * 用于"搜到了就自动打开它"的联动：用户输入关键字后，
       * 左侧高亮命中的同时，中央图直接切到第一个结果，
       * 不用再手动点一次。
       *
       * 匹配优先级与大类列表一致：大类名 → 子类名 → 对话标题。
       *
       * @param tree - 归类树。
       * @param query - 关键字。
       * @returns sessionId 或 null。
       */
      /**
       * 加载一批会话的分段数据（跨会话概览用）。
       *
       * 串行而不是并发：并发 7 个请求会让 Host 同时解压 7 份日志，反而更慢。
       * 串行还能让用户"边看已到的块、边等剩下的"——配合逐块渲染，
       * 不会出现整屏空白等待。
       *
       * 已缓存的会话直接跳过，所以第二次点同一个话题是瞬时的。
       *
       * @param sessions - [{ id, title }]。
       */
      function loadScopeData(sessions) {
        var list = Array.isArray(sessions) ? sessions : []
        var next = 0
        function step() {
          if (next >= list.length) return
          var id = list[next].id
          next += 1
          if (scopeData[id] !== undefined) { step(); return }
          post('session', { sessionId: id }).then(function (value) {
            if (value !== null && value !== undefined) {
              setScopeData(function (prev) {
                var out = Object.assign({}, prev)
                out[id] = value
                return out
              })
            }
            step()
          }, function () { step() })
        }
        step()
      }

      /**
       * 从归类树里找某个话题下的某个对话（子类）。
       *
       * @param tree - 归类树。
       * @param catName - 话题名。
       * @param subName - 对话名。
       * @returns 子类对象，找不到返回 null。
       */
      function findSubcategory(tree, catName, subName) {
        var list = Array.isArray(tree) ? tree : []
        for (var i = 0; i < list.length; i += 1) {
          if (list[i].name !== catName) continue
          var subs = list[i].subcategories ?? []
          for (var j = 0; j < subs.length; j += 1) {
            if (subs[j].name === subName) return subs[j]
          }
          return null
        }
        return null
      }

      /**
       * 取某个会话提炼出的一句话主题（列表副标题用）。
       *
       * @param sid - 会话 id。
       * @returns 主题字符串，没有则返回 null。
       */
      /**
       * 查某个会话在归类树里的归属路径：`话题 › 对话`。
       *
       * 右栏顶部要告诉用户"这个泳道属于哪个话题/对话"。
       * 早先那里读的是阶段名（阶段系统已删），所以永远显示"未分类"。
       *
       * @param sid - 会话 id。
       * @returns 路径字符串；找不到返回空串。
       */
      /**
       * 查某个会话的归属，返回 `{ topic, dialog }`。
       *
       * 与 ownerPathOf 同源，但那一个拼成字符串给右栏显示，
       * 这一个给左栏做默认高亮用。
       *
       * @param sid - 会话 id。
       * @returns `{ topic, dialog }`，找不到时两者都是 null。
       */
      function ownerOf(sid) {
        var out = { topic: null, dialog: null }
        if (sid === undefined || sid === null) return out
        var tree = Array.isArray(sessionTree.tree) ? sessionTree.tree : []
        for (var i = 0; i < tree.length; i += 1) {
          var subs = tree[i].subcategories ?? []
          for (var j = 0; j < subs.length; j += 1) {
            var sess = subs[j].sessions ?? []
            for (var k = 0; k < sess.length; k += 1) {
              if (String(sess[k].sessionId) === String(sid)) {
                out.topic = tree[i].name
                out.dialog = subs[j].name
                return out
              }
            }
          }
        }
        return out
      }

      function ownerPathOf(sid) {
        if (sid === undefined || sid === null) return ''
        var tree = Array.isArray(sessionTree.tree) ? sessionTree.tree : []
        for (var i = 0; i < tree.length; i += 1) {
          var subs = tree[i].subcategories ?? []
          for (var j = 0; j < subs.length; j += 1) {
            var sess = subs[j].sessions ?? []
            for (var k = 0; k < sess.length; k += 1) {
              if (String(sess[k].sessionId) === String(sid)) {
                return tree[i].name + ' › ' + subs[j].name
              }
            }
          }
        }
        return ''
      }

      function digestTopicOf(sid) {
        var d = (sessionTree.digests ?? {})[sid]
        if (d === undefined || d === null) return null
        var t = typeof d.topic === 'string' ? d.topic.trim() : ''
        return t === '' ? null : t
      }

      /**
       * 返回上一级。
       *
       * 从对话层退回话题层时，用话题名在树里重新取出对话列表——
       * 不能只弹掉面包屑，否则退回去的页面没有内容可显示。
       */
      function goBackLevel() {
        if (laneScope === null) return
        if (laneScope.level === 'dialog') {
          var catName = laneScope.crumbs !== undefined && Array.isArray(laneScope.crumbs)
            ? laneScope.crumbs[0].name
            : null
          if (catName === null) { setLaneScope(null); return }
          openTopicLevel(catName)
          return
        }
        // 已在话题层：退回地图
        setLaneScope(null)
      }

      /** 跳到面包屑上的某一级。 */
      function goToCrumb(c) {
        if (c === null || c === undefined) return
        if (c.level === 'topic') { openTopicLevel(c.name); return }
        setLaneScope(null)
      }

      /**
       * 让左栏跟中间视图对齐：展开对应分区并滚到可见位置。
       *
       * 这是"中间 → 左栏"的反向联动。
       *
       * 缺了它的后果：在中间列表里点进「Skill与工程化」的会话列表后，
       * 左栏那边如果这个话题是折叠的、或子类没展开，用户就完全看不到
       * 自己现在在哪一层 —— 中间变了、左栏没动，看起来像"没联动"。
       *
       * 两个动作：
       *   1. 确保该层级的父分区与自身都处于展开状态（折叠键删掉即展开）
       *   2. 下一帧把该行滚到可视区（DOM 节点用 data-scope 找）
       *
       * @param level - 'topic' | 'dialog'。
       * @param topicName - 所属话题名。
       * @param dialogName - 对话名（level='dialog' 时需要）。
       */
      function syncTreeToScope(level, topicName, dialogName) {
        if (topicName === undefined || topicName === null) return

        var catKey = 'cat:' + topicName
        var subKey = level === 'dialog' && dialogName !== undefined && dialogName !== null
          ? catKey + ':sub:' + dialogName
          : null

        // 1) 展开：折叠表里删掉这些键就是展开
        setSessionTree(function (prev) {
          var folded = Object.assign({}, prev.folded)
          var changed = false
          if (folded[catKey] === true) { delete folded[catKey]; changed = true }
          if (subKey !== null && folded[subKey] === true) { delete folded[subKey]; changed = true }
          if (!changed) return prev
          persistTreeFold(folded)
          return Object.assign({}, prev, { folded: folded })
        })

        // 2) 滚动到可见：等下一帧 DOM 更新后再滚
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return
        window.requestAnimationFrame(function () {
          if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
          var el = document.querySelector('[data-scope="1"]')
          if (el !== null && el !== undefined && typeof el.scrollIntoView === 'function') {
            try { el.scrollIntoView({ block: 'nearest' }) } catch (e) { /* 忽略 */ }
          }
        })
      }

      /**
       * 设置当前层级，并同步左栏。
       *
       * 所有"进入某一层"的地方都应该走这个函数，而不是直接 setLaneScope ——
       * 否则就会漏掉左栏联动（这正是之前的问题）。
       *
       * @param scope - `{ level, name, ... }` 或 null。
       */
      function enterScope(scope) {
        setLaneScope(scope)
        if (scope === null || scope === undefined) return
        var crumbs = Array.isArray(scope.crumbs) ? scope.crumbs : []
        var topicName = null
        for (var i = 0; i < crumbs.length; i += 1) {
          if (crumbs[i].level === 'topic') { topicName = crumbs[i].name; break }
        }
        if (topicName === null && scope.level === 'topic') topicName = scope.name
        syncTreeToScope(scope.level, topicName, scope.level === 'dialog' ? scope.name : null)
      }

      /**
       * 打开某个话题的对话列表。
       *
       * @param catName - 话题名。
       */
      function openTopicLevel(catName) {
        var tree = Array.isArray(sessionTree.tree) ? sessionTree.tree : []
        for (var i = 0; i < tree.length; i += 1) {
          if (tree[i].name !== catName) continue
          var subs = tree[i].subcategories ?? []
          var dialogs = []
          for (var j = 0; j < subs.length; j += 1) {
            var ss = subs[j].sessions ?? []
            var turnSum = 0
            for (var w = 0; w < ss.length; w += 1) {
              if (typeof ss[w].turns === 'number') turnSum += ss[w].turns
            }
            dialogs.push({ name: subs[j].name, sessionCount: ss.length, turnCount: turnSum })
          }
          enterScope({
            level: 'topic',
            name: catName,
            items: dialogs,
            crumbs: [{ level: 'topic', name: catName }],
          })
          return
        }
        setLaneScope(null)
      }

      function firstMatchSession(tree, query) {
        var q = String(query ?? '').trim().toLowerCase()
        if (q === '') return null
        var list = Array.isArray(tree) ? tree : []
        for (var i = 0; i < list.length; i += 1) {
          var cat = list[i]
          var catHit = String(cat.name ?? '').toLowerCase().indexOf(q) >= 0
          for (var j = 0; j < (cat.subcategories ?? []).length; j += 1) {
            var sub = cat.subcategories[j]
            var subHit = String(sub.name ?? '').toLowerCase().indexOf(q) >= 0
            for (var k = 0; k < (sub.sessions ?? []).length; k += 1) {
              var s = sub.sessions[k]
              if (catHit || subHit || String(s.title ?? '').toLowerCase().indexOf(q) >= 0) {
                return s.sessionId
              }
            }
          }
        }
        return null
      }

      /**
       * 推断"当前会话所属"的工作区。
       *
       * 用 platform 注入的 sessionId 在 workspaces[].sessionIds 里反查。
       * 反查不到时退回 registry 第一个（至少不会空白）。
       *
       * 注意用 sessionId（平台当前会话）而不是 activeSessionId（面板内切换的）：
       * 默认工区应该跟着"用户正在聊的那个会话"走。
       *
       * @param ws - workspaces 列表。
       * @returns 工作区 id，或 null。
       */
      function inferWorkspaceId(ws) {
        var list = Array.isArray(ws) ? ws : []
        if (list.length === 0) return null

        var mine = sessionId === undefined || sessionId === null ? '' : String(sessionId)
        if (mine !== '') {
          for (var i = 0; i < list.length; i += 1) {
            var ids = Array.isArray(list[i].sessionIds) ? list[i].sessionIds : []
            for (var k = 0; k < ids.length; k += 1) {
              if (String(ids[k]) === mine) return list[i].id
            }
          }
        }
        // 反查不到（比如会话刚建、registry 还没收录）：退回第一个
        return list[0].id
      }

      /**
       * 读取工作区列表 + 某个工作区的会话归类。
       *
       * 默认工作区的确定方式（这是关键）：
       *   优先用**当前会话所属**的工作区，而不是 registry 第一个。
       *
       * 之前取 registry[0]，那通常是"最近打开过的工区"，未必是当前会话
       * 所在的。于是用户一打开面板看到的是别的工区的内容，以为数据串了
       * 或者切换失灵。现在用 sessionIds 反查，保证默认落在正确的工区。
       *
       * @param workspaceId - 显式指定的工作区；为空则自动推断。
       * @param options - `{ force }`。
       */
      function loadWorkspaceTree(workspaceId, options) {
        var opts = options ?? {}
        var request = ++workspaceRequestRef.current
        var explicit = workspaceId !== undefined && workspaceId !== null

        // 先用缓存把树填上，避免"切个页签回来左栏先空一下再填"的闪动。
        // key 用显式工作区 id；不给 id 时按"跟随当前会话"单独一档。
        var cacheKey = explicit ? 'ws:' + workspaceId : 'auto'
        var cachedTree = TREE_CACHE.get(cacheKey)
        var treeFresh = cachedTree !== undefined
          && Date.now() - cachedTree.at < TREE_CACHE_TTL_MS && opts.force !== true
        if (treeFresh) {
          patchTree({
            loading: false,
            workspaces: cachedTree.value.workspaces,
            workspaceId: cachedTree.value.workspaceId,
            tree: cachedTree.value.tree,
            total: cachedTree.value.total,
            uncategorized: cachedTree.value.uncategorized,
            digests: cachedTree.value.digests,
          })
        } else {
          patchTree({ loading: true, tree: [], total: 0, uncategorized: [], digests: {} })
        }

        post('workspaces', {}).then(function (list) {
          if (request !== workspaceRequestRef.current) return
          var ws = Array.isArray(list) ? list : []
          var target = workspaceId

          if (target === undefined || target === null) {
            target = inferWorkspaceId(ws)
          }
          patchTree({ workspaces: ws, workspaceId: target })
          if (target === null) { patchTree({ loading: false, tree: [], total: 0 }); return }

          // 刷新轮数。
          //
          // 早先只在"显式切工作区"时全量刷新，平时只刷当前会话 —— 因为
          // 全量要 3.9 秒（每个会话都读一遍事件流）。
          //
          // 现在 Host 侧按 sessionId 的 revision 做了增量判断：没变化的
          // 会话一次事件流都不读，全量刷新实测 **85ms**（原来是 3877ms）。
          // 所以这里改成始终全量刷新，左栏每个会话的数字都不会再落后。
          post('categorize', {
            workspaceId: target,
            force: opts.force === true,
            activeSessionId: null,
          }).then(function (value) {
            if (request !== workspaceRequestRef.current) return
            if (value === null || value === undefined) { patchTree({ loading: false }); return }
            var applied = {
              workspaces: ws,
              workspaceId: target,
              tree: Array.isArray(value.tree) ? value.tree : [],
              total: value.total ?? 0,
              uncategorized: Array.isArray(value.uncategorized) ? value.uncategorized : [],
              digests: value.digests !== undefined && value.digests !== null ? value.digests : {},
            }
            patchTree(Object.assign({ loading: false, busy: false }, applied))

            // 写入前端缓存：下次挂载（切页签回来）直接用，不再等网络。
            // 同时按"实际工作区 id"再存一份，这样以后显式请求同一工作区也命中。
            var snapshot = { at: Date.now(), value: applied }
            TREE_CACHE.set(cacheKey, snapshot)
            TREE_CACHE.set('ws:' + target, snapshot)
          }, function () { if (request === workspaceRequestRef.current) patchTree({ loading: false, busy: false }) })
        }, function () { if (request === workspaceRequestRef.current) patchTree({ loading: false, busy: false }) })
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

      /**
       * 折叠状态的持久化键：按工作区区分。
       *
       * 用工作区而不是会话：折叠是"这个工作区的话题树怎么摆"，
       * 切到另一个会话不该把布局重置。
       */
      function foldStoreKey() {
        var ws = sessionTree.workspaceId
        return ws === null || ws === undefined ? null : 'dsh-topic-map:treefold:' + ws
      }

      /** 把折叠状态写进 sessionStorage（失败就放弃，不影响功能）。 */
      function persistTreeFold(folded) {
        var key = foldStoreKey()
        if (key === null || typeof sessionStorage === 'undefined') return
        try { sessionStorage.setItem(key, JSON.stringify(folded || {})) } catch (e) { /* 配额满 */ }
      }

      /** 折叠/展开树节点。 */
      function toggleTreeFold(key) {
        setSessionTree(function (prev) {
          var folded = Object.assign({}, prev.folded)
          if (folded[key] === true) delete folded[key]
          else folded[key] = true
          persistTreeFold(folded)
          return Object.assign({}, prev, { folded: folded })
        })
      }

      /**
       * 全部展开 / 全部折叠。
       *
       * 折叠键的约定：
       *   话题  'cat:<名>'            折叠时值为 true
       *   对话  'cat:<名>:sub:<名>'   折叠时值为 true
       *
       * "全部展开" = 清空整张表（默认就是展开）
       * "全部折叠" = 把树里所有键都设为 true
       *
       * @param fold - true 折叠全部，false 展开全部。
       */
      function foldAll(fold) {
        if (fold !== true) {
          setSessionTree(function (prev) {
            persistTreeFold({})
            return Object.assign({}, prev, { folded: {} })
          })
          return
        }
        var folded = {}
        var tree = Array.isArray(sessionTree.tree) ? sessionTree.tree : []
        for (var i = 0; i < tree.length; i += 1) {
          var catKey = 'cat:' + tree[i].name
          folded[catKey] = true
          var subs = tree[i].subcategories ?? []
          for (var j = 0; j < subs.length; j += 1) {
            folded[catKey + ':sub:' + subs[j].name] = true
          }
        }
        setSessionTree(function (prev) {
          persistTreeFold(folded)
          return Object.assign({}, prev, { folded: folded })
        })
      }

      /** 切换工作区时恢复该工作区上次的折叠布局。 */
      useEffect(function () {
        var key = foldStoreKey()
        if (key === null) return
        var saved = {}
        try {
          var raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(key)
          if (raw !== null) saved = JSON.parse(raw) || {}
        } catch (e) {
          saved = {}
        }
        setSessionTree(function (prev) { return Object.assign({}, prev, { folded: saved }) })
      }, [sessionTree.workspaceId])

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
            // 正文有命中就把中间图恢复出来：
            // 结构没命中但正文命中时，不该让用户看到空白。
            if (hits.length > 0 && q !== '') setSearchEmpty(false)
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

      /**
       * 轻量轮询：发现工作区里"新开了会话"。
       *
       * 为什么需要：焦点/可见性事件只在切换窗口时触发。如果用户就待在
       * 话题地图这一页、另开一个窗口新建了会话，左栏不会知道。
       *
       * 为什么用 /workspaces 而不是 /categorize：
       * /workspaces 只读工作区注册表（会话 id 列表），是本项目最轻的接口；
       * 每 15 秒比对一次 sessionIds，变了才重新加载树。分类本身有缓存，
       * 所以即使重载也不会重跑模型。
       *
       * 三个约束：页面不可见时不轮询、上一轮没回来时不叠加、
       * 正在归类时不打扰。
       */
      useEffect(function () {
        if (typeof document === 'undefined' || typeof window === 'undefined') return undefined
        if (sessionTree.workspaceId === null) return undefined

        var stopped = false
        var inFlight = false

        function signatureOf(list) {
          var ws = Array.isArray(list) ? list : []
          var me = null
          for (var i = 0; i < ws.length; i += 1) {
            if (ws[i].id === sessionTree.workspaceId) { me = ws[i]; break }
          }
          if (me === null) return ''
          return (me.sessionIds ?? []).map(String).sort().join(',')
        }

        function tick() {
          if (stopped || inFlight) return
          if (document.visibilityState === 'hidden') return
          inFlight = true
          post('workspaces', {}).then(function (list) {
            inFlight = false
            if (stopped) return
            var now = signatureOf(list)
            if (now === '') return
            var prev = (sessionTree.workspaces ?? [])
            var before = signatureOf(prev)
            // 会话集合变了才重载；没变就什么都不做（零副作用）
            if (before !== '' && before !== now) loadWorkspaceTree(sessionTree.workspaceId)
          }, function () { inFlight = false })
        }

        var timer = window.setInterval(tick, 15000)
        return function () { stopped = true; window.clearInterval(timer) }
      }, [sessionTree.workspaceId, sessionTree.workspaces])

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

      // 切换会话时，把所有"按轮次/会话定位"的临时状态清掉。
      //
      // 这些状态跨会话复用会直接导致"信息错乱"：
      //   selected   存的是轮次号（T42）。新会话里 T42 是另一件事，
      //              右栏会按旧位置定位，看起来就是数据对不上号。
      //   semantic   是某个会话的分析结果。挂到另一个会话上显示，
      //              泳道结构完全不对。
      //   openTurns  以轮次号为键记"哪几轮展开了"，跨会话必然错位。
      //   highlightLane / hovered 同理，留着会高亮不存在的对象。
      //
      // 早先只在"点分析"时清 semantic，切换会话时什么都没清，
      // 于是用户看到的就是"点了会话，轮数信息全是乱的"。
      useEffect(function () {
        setSelected(null)
        setSemantic(null)
        setOpenTurns({})
        setHighlightLane(null)
        setHovered(null)
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
       * 在右栏轮次列表里把某一轮滚到可见区域。
       *
       * 点图上的节点时用：让右栏跟着跳到那一轮，用户不用自己找。
       *
       * @param turn - 轮次号。
       */
      function scrollTurnListTo(turn) {
        if (typeof document === 'undefined') return
        var list = document.querySelector('.dsh_tm_tlbody')
        if (list === null) return
        var rows = list.querySelectorAll('.dsh_tm_turnrow')
        for (var i = 0; i < rows.length; i += 1) {
          var no = rows[i].querySelector('.dsh_tm_tno')
          if (no === null) continue
          if ((no.textContent || '').trim() === 'T' + turn) {
            try { rows[i].scrollIntoView({ block: 'nearest' }) } catch (e) { /* 忽略 */ }
            return
          }
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

        /** 把一份负载应用到界面上（含选中项恢复）。 */
        function applyPayload(value) {
          setData(value); setError(null); setLoading(false)
          if (value.turns.length > 0) {
            var remembered = loadSelectedTurn(activeSessionId)
            var exists = remembered !== null
              && value.turns.some(function (t) { return t.turn === remembered })
            setSelected(exists ? remembered : value.turns[value.turns.length - 1].turn)
          }
        }

        // 命中缓存：立刻渲染，不显示 loading、不清空内容。
        // 这样切页签回来是"瞬间恢复"，而不是先白一下再填。
        var cachedEntry = SESSION_CACHE.get(activeSessionId)
        var cacheFresh = cachedEntry !== undefined
          && Date.now() - cachedEntry.at < SESSION_CACHE_TTL_MS
        if (cacheFresh) applyPayload(cachedEntry.payload)
        else setLoading(true)

        function load(attempt) {
          post('session', { sessionId: activeSessionId, force: attempt > 0 }).then(function (value) {
            if (!alive) return
            if (!value || !value.graph) {
              if (attempt < 1) { load(attempt + 1); return }
              // 后台刷新失败时保留已有的缓存内容，不要让界面变成错误页
              if (cacheFresh) return
              setError('Host 返回的数据缺少 graph（engineVersion=' + (value && value.engineVersion) + '）')
              setData(null); setLoading(false); return
            }
            SESSION_CACHE.set(activeSessionId, { at: Date.now(), payload: value })
            applyPayload(value)
          }, function (e) {
            if (!alive) return
            if (attempt < 1) { load(attempt + 1); return }
            // 已经有缓存内容在显示时，后台刷新失败就静默忽略：
            // 用户看到的还是上次的正确内容，没必要弹错误页。
            if (cacheFresh) return
            setError(e && e.message ? e.message : String(e)); setLoading(false)
          })
        }
        load(0)
        return function () { alive = false }
      }, [activeSessionId])

      /**
       * 实时跟随当前会话的新轮次。
       *
       * 为什么需要：面板只在"挂载 / 窗口获得焦点"时拉数据。如果用户就待在
       * 话题地图这一页、而 DSH 仍在产出新的轮次（agent 还在写），图上会
       * 一直停在旧状态，直到切走再切回来。
       *
       * 平台提供了会话事件的订阅快照（binding(id).eventSource，带 revision），
       * 订阅它就能在"有新内容写入"时立刻知道 —— 不需要轮询。
       *
       * 刷新用 1.2 秒防抖：一轮对话在流式过程中会连续产生多条事件
       * （assistant 增量、工具调用、settle），每次都拉一遍既浪费也会闪。
       */
      useEffect(function () {
        if (SESSION_SERVICE == null || sessionId === undefined || sessionId === null) return undefined
        var binding = null
        try { binding = SESSION_SERVICE.binding(sessionId) } catch (e) { binding = null }
        if (binding === null || binding === undefined) return undefined
        var source = binding.eventSource
        if (source === null || source === undefined
          || typeof source.getSnapshot !== 'function'
          || typeof source.subscribe !== 'function') return undefined

        var lastRevision = null
        function currentRevision() {
          try {
            var snap = source.getSnapshot()
            return snap === null || snap === undefined ? null : snap.revision
          } catch (e) { return null }
        }
        lastRevision = currentRevision()

        var timer = 0
        function flush() {
          timer = 0
          // 只刷新"正在看的那一个会话"的数据
          post('session', { sessionId: sessionId }).then(function (value) {
            if (value === null || value === undefined || !value.graph) return
            SESSION_CACHE.set(sessionId, { at: Date.now(), payload: value })
            setData(value)
            setError(null)
            // 左栏的数字就地跟上（段数 = 泳道数）
            patchSessionStats(sessionId, value.turns.length, Array.isArray(value.lanes) ? value.lanes.length : null)
          }, function () { /* 静默：网络抖动不该打断阅读 */ })
        }

        var unsubscribe = source.subscribe(function () {
          var rev = currentRevision()
          if (rev === lastRevision) return
          lastRevision = rev
          if (timer !== 0) window.clearTimeout(timer)
          timer = window.setTimeout(flush, 1200)
        })

        return function () {
          if (timer !== 0) window.clearTimeout(timer)
          if (typeof unsubscribe === 'function') unsubscribe()
        }
      }, [sessionId])

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
      //
      // 用 activeSessionId 而不是 sessionId：面板内可以浏览别的会话
      // （viewedSessionId），此时筛选条件、手动标注都该跟随**正在看的**
      // 那个会话。早先用 sessionId（平台当前会话）导致切换后
      // 筛选条件仍是旧会话的，看起来像"数据串了"。
      useEffect(function () {
        if (activeSessionId === undefined || activeSessionId === null) {
          setUserState({ overrides: {}, filter: null })
          setFilter(FILTER.emptyFilter())
          return
        }
        var alive = true
        post('ui-state', { sessionId: activeSessionId }).then(function (value) {
          if (!alive || value === null || value === undefined) return
          setUserState({ overrides: value.overrides || {}, filter: value.filter || null })
          // 恢复该会话上次的筛选条件；没有就清空，
          // 避免把上一个会话的筛选带过来。
          if (value.filter !== null && typeof value.filter === 'object') {
            setFilter(Object.assign(FILTER.emptyFilter(), value.filter))
          } else {
            setFilter(FILTER.emptyFilter())
          }
        }, function () { /* 读不到就用默认值 */ })
        return function () { alive = false }
      }, [activeSessionId])

      /** 把一次 UI 状态改动写回 Host。 */
      function pushUiState(patch) {
        if (sessionId === undefined) return
        post('ui-state', { sessionId: sessionId, patch: patch }).then(function (value) {
          if (value === null || value === undefined) return
          setUserState({ overrides: value.overrides || {}, filter: value.filter || null })
        }, function () { /* 写失败就当本地生效，下次再写 */ })
      }



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

      /**
       * 拖拽：把这一帧内累积的位移合并成一次视图更新。
       *
       * 为什么必须合并：pointermove 的触发频率可以到 120-240Hz，
       * 而一次重渲染要重画几十条泳道与上百个节点。
       * 早先每个事件都 setView，拖动时就是"事件频率 = 重渲染频率"，
       * 表现出来就是明显掉帧、甚至拖慢整个 DSH。
       *
       * 现在：事件里只累计位移，真正的 setView 每帧最多一次。
       */
      var dragPendingRef = useRef({ dx: 0, dy: 0, raf: 0 })
      function onDragMove(ev) {
        var from = dragRef.current
        if (from === null || L === null) return
        var dx = ev.clientX - from.x
        var dy = ev.clientY - from.y
        if (dx === 0 && dy === 0) return
        dragRef.current = { x: ev.clientX, y: ev.clientY }

        var pending = dragPendingRef.current
        pending.dx += dx
        pending.dy += dy

        // 已经排了一帧就不再排，等它统一提交
        if (pending.raf !== 0) return
        var schedule = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
          ? window.requestAnimationFrame.bind(window)
          : function (fn) { return window.setTimeout(fn, 16) }
        pending.raf = schedule(function () {
          pending.raf = 0
          var mvx = pending.dx
          var mvy = pending.dy
          pending.dx = 0
          pending.dy = 0
          if (mvx === 0 && mvy === 0) return
          setView(function (prev) {
            return VIEWPORT.panBy(
              prev, mvx, mvy,
              { width: L.width, height: L.height },
              { width: size.w, height: size.h },
            )
          })
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

      /**
       * 右栏要展示的话题（"主题 + 轮次列表"的输入）。
       *
       * 三级优先：
       *   1. 选中轮所属的话题 —— 用户正在看某一轮，那一段就是上下文
       *   2. 左栏聚焦的话题 —— 用户点了某个任务
       *   3. 第一个话题 —— 什么都没有时给个起点，别让右栏空着
       *
       * 为什么不用 selectedLane（那个只在点节点时设置）：从网页切回来、
       * 或直接打开面板时它是空的，右栏就会空白。
       */
      //
      // 注意 data 可能是 null（首次加载、加载失败、会话切换中）。
      // 这里必须先判空再访问 —— 这一步在早期 return 之前执行，
      // 直接读 data.lanes 会让整个面板崩成白屏。
      var detailLane = null
      var detailLanes = data !== null && data !== undefined && Array.isArray(data.lanes) ? data.lanes : []
      if (selected !== null) {
        for (var di = 0; di < detailLanes.length; di += 1) {
          var dt = detailLanes[di].turns
          if (Array.isArray(dt) && dt.indexOf(selected) >= 0) { detailLane = detailLanes[di]; break }
        }
      }
      if (detailLane === null && highlightLane !== null) {
        for (var dj = 0; dj < detailLanes.length; dj += 1) {
          if (detailLanes[dj].laneId === highlightLane) { detailLane = detailLanes[dj]; break }
        }
      }
      if (detailLane === null && detailLanes.length > 0) detailLane = detailLanes[0]

      var hoverFact = hovered === null ? null : (byTurn.get(hovered) || null)

      // 保持 Chat target 激活并随分页更新。跳转回调直接读取 target 的实时快照，
      // 不依赖切换视图后停止更新的 hook 闭包。
      useChat(function (s) { return s.navigation.items() })
      var canJump = canJumpToSession(sessionId, activeSessionId, data, laneScope)
      // 不能跳时给出**具体原因**，让按钮可以置灰并说明，
      // 而不是干脆不渲染（用户会以为是功能没了）。
      var jumpBlockReason = (function () {
        if (canJump) return null
        if (laneScope !== null) return '请先在左侧选中一个具体会话，再使用跳转'
        if (data === null || data === undefined) return '会话数据还在加载'
        if (activeSessionId !== sessionId) {
          return '当前正在查看另一个会话。平台的「对话」页只显示当前会话，'
            + '所以跳转只能用于当前会话 —— 请在左侧点回当前会话后再跳。'
        }
        return '宿主的对话历史导航暂不可用'
      })()
      var jumpAllowedRef = useRef(canJump)
      effectAssign(jumpAllowedRef, canJump)
      var jumpRequestRef = useRef(null)
      useEffect(function () {
        return function () {
          var request = jumpRequestRef.current
          if (request !== null && !request.opened) request.cancelled = true
        }
      }, [activeSessionId])

      /**
       * 跳到某一轮。
       *
       * 先加载并读取准确锚点，再切回对话。原生轮次导航交接阅读所有权后，
       * 只对齐这一轮的用户输入；不把附近的行当成成功。
       */
      function jumpTo(turnNo) {
        if (!canJump || !jumpAllowedRef.current) return
        var fact = byTurn.get(turnNo)
        if (fact === undefined) return
        var binding = sessionId === undefined || SESSION_SERVICE == null
          ? undefined : SESSION_SERVICE.binding(sessionId)
        var request = { opened: false, cancelled: false }
        jumpRequestRef.current = request
        function current() {
          return jumpRequestRef.current === request && !request.cancelled
            && (request.opened || jumpAllowedRef.current)
        }
        var attempts = 0
        var settled = false
        var nativeActivated = false
        var targetKey = null
        var anchorAttempts = 0
        // 粗定位只做一次，避免反复滚动晃眼
        var coarseDone = false

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
          // 实现已提到模块级（pinRowToTop），历史右栏的定位复用同一套逻辑。
          pinRowToTop(scroller, el, raf)
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
          if (settled || !current()) return
          attempts += 1

          var scroller = chatScroller()
          var hit = null

          if (attempts === 1) {
            var debugAnchor = scroller === null ? null : findTurnRow(targetKey, scroller)
            var debugOwner = scroller === null || typeof scroller.closest !== 'function' ? null : scroller.closest('[data-conversation-session]')
            note('begin', {
              hasScroller: scroller !== null,
              scrollerHeight: scroller === null ? 0 : Math.round(scroller.scrollHeight),
              anchorKey: targetKey,
              ownerMatches: debugOwner !== null && debugOwner.getAttribute('data-conversation-session') === sessionId,
              anchorFound: debugAnchor !== null,
              anchorTurn: debugAnchor === null ? null : debugAnchor.getAttribute('data-chat-turn'),
              anchorKind: debugAnchor === null ? null : debugAnchor.getAttribute('data-chat-flow-kind'),
              anchorHeight: debugAnchor === null ? null : debugAnchor.getBoundingClientRect().height,
            })
          }

          if (scroller !== null) hit = findUserTurnRow(turnNo, targetKey, scroller)

          // 没找到行时做一次"粗定位"：
          //
          // 长会话的轮次列表是虚拟化的，屏幕外的行根本没有 DOM，找也找不到。
          // 先按"这一轮在全会话里的位置比例"把列表滚到大概区域，让虚拟列表
          // 把目标附近渲染出来，下一次 attempt 就能精确命中。
          // 只做一次：反复粗滚会把用户晃得难受。
          if (hit === null && scroller !== null && !coarseDone && attempts >= 2) {
            coarseDone = true
            var ratio = data.turns.length <= 1 ? 0 : (turnNo - 1) / (data.turns.length - 1)
            var span = Math.max(0, (Number(scroller.scrollHeight) || 0) - (Number(scroller.clientHeight) || 0))
            var target = Math.round(span * ratio)
            // 容器尺寸拿不到时不要写 NaN：那会把 scrollTop 置成非法值
            if (Number.isFinite(span) && Number.isFinite(target)) {
              scroller.scrollTop = Math.max(0, Math.min(span, target))
            }
            note('coarse-seek', { ratio: Math.round(ratio * 100), scrollTop: Math.round(scroller.scrollTop) })
          }

          // 找到行就滚过去 —— 不再要求"原生导航按钮可点"。
          //
          // 早先的条件要求"找到行"和"导航按钮可点"两者同时成立。
          // 但导航轨道本身也是虚拟化的：按钮不在视野内时就不存在，
          // 于是 nativeActivated 恒为 false，明明找到了行也被丢弃，
          // 最后报"未能定位"。这是"大部分轮次跳不过去"的主要原因。
          if (hit !== null) {
            if (!nativeActivated) {
              nativeActivated = activateChatTurn(turnNo, data.turns)
              if (nativeActivated) note('native-navigation')
            }

            // 单轮会话没有原生导航轨道，使用宿主已监听的阅读意图事件释放滚动。
            if (data.turns.length < 2 && scroller !== null) {
              scroller.dispatchEvent(new Event('wheel', { bubbles: true }))
            }
            var applied = revealRow(hit, scroller)
            // 关键：钉住的是**元素**，不是那一刻算出的像素。跳转后图片解码、
            // 代码高亮、分组折叠都会改变目标行的位置，只有持续重测才对得上。
            pinToTop(scroller, hit, function (cb) {
              window.requestAnimationFrame(function () { if (current()) cb() })
            })

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
              native: nativeActivated,
            })
            trace.outcome = 'scrolled'
            settled = true
            return
          }

          // 尚未加载完，或已加载但还没渲染：稍后重试。
          //
          // 预算放宽到约 8 秒（80 次）：大会话要翻好几页历史，且虚拟列表
          // 渲染有延迟。早先 24 次×60ms（约 1.4 秒）常常不够，
          // 用户看到的就是"点了没反应，然后报失败"。
          if (attempts < 80) {
            var wait = attempts < 10 ? 60 : (attempts < 30 ? 120 : 200)
            window.setTimeout(attempt, wait)
            return
          }

          note('not-found')
          trace.outcome = 'miss'
          showJumpNotice('未能定位第 ' + turnNo + ' 轮的用户输入。可尝试：'
            + '①再点一次「跳转到对话」；②先在对话页手动往下滚一段再跳；'
            + '③点右上角诊断按钮查看详情。')
          settled = true
        }

        function failed(error) {
          if (!current()) return
          settled = true
          trace.outcome = 'failed'
          showJumpNotice('第 ' + turnNo + ' 轮跳转失败：' + (error && error.message ? error.message : String(error)))
        }
        function openLoaded() {
          if (!current()) return
          anchorAttempts += 1
          // useChat 在切视图后停止订阅；从已核实的 Conversation target 读取最新锚点。
          var chat = CONVERSATION_SERVICE.binding(binding).target('chat').getSnapshot()
          var items = chat && chat.navigation ? chat.navigation.items() : []
          for (var i = 0; i < items.length; i += 1) {
            if (items[i].turn === turnNo) { targetKey = items[i].anchorKey; break }
          }
          if (!targetKey) {
            if (anchorAttempts < 24) { window.setTimeout(prepareOpen, 60); return }
            throw new Error('历史已加载，但该轮锚点不可用')
          }
          if (typeof props.openView !== 'function') throw new Error('宿主未提供对话视图入口')
          request.opened = true
          props.openView('chat', '')
          window.requestAnimationFrame(attempt)
        }
        function prepareOpen() {
          try { openLoaded() } catch (e) { failed(e) }
        }
        try {
          if (binding === undefined || typeof binding.session.loadThrough !== 'function'
            || CONVERSATION_SERVICE == null) throw new Error('宿主历史导航服务不可用')
          Promise.resolve(binding.session.loadThrough(fact.startSeq)).then(prepareOpen, failed)
        } catch (e) { failed(e) }
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
          f.model !== null && f.model !== undefined
            ? h('div', { className: 'dsh_tm_kv' }, h('span', null, '模型'), h('b', null, String(f.model.model ?? '')))
            : null,
        )
      }

      return h('div', { className: 'dsh_tm_root' },
        h('div', { className: 'dsh_tm_bar' },
          h('span', { className: 'dsh_tm_brand' },
            h('span', { className: 'dsh_tm_dotlogo' }), t('title')),
          // ── 工作区切换（默认 = 当前会话所属）──
          (function () {
            var ws = sessionTree.workspaces ?? []
            if (ws.length === 0) return null
            var cur = null
            for (var i = 0; i < ws.length; i += 1) {
              if (ws[i].id === sessionTree.workspaceId) { cur = ws[i]; break }
            }
            return h('select', {
              className: 'dsh_tm_wsselect',
              value: sessionTree.workspaceId ?? '',
              title: '切换工作区（默认是当前会话所在的工区）',
              onChange: function (ev) { switchWorkspace(ev.target.value) },
            },
              ws.map(function (w) {
                return h('option', { key: w.id, value: w.id },
                  (w.path ?? w.title) + '（' + w.sessionCount + '）')
              }),
            )
          })(),
          // ── 搜索：只筛左栏结构（大类/子类/对话标题）──
          //
          // 用 onChange 而不是 onInput：React 的受控 input 依赖 onChange
          // 才能可靠地同步 value，用 onInput 时受控值可能滞后一拍，
          // 表现为"输入了但列表不动"。
          h('input', {
            className: 'dsh_tm_wssearch',
            type: 'text',
            placeholder: '搜话题 / 对话 / 会话…',
            title: '搜话题名、对话名、会话标题；命中项高亮并自动展开',
            value: sessionTree.query ?? '',
            onChange: function (ev) {
              var v = ev.target.value
              patchTree({ query: v })
              // 同一个框也触发跨会话全文检索（搜对话正文）。
              // 防抖在里面，不会每敲一个字就扫全部会话。
              onFindInput(v)
              // 联动中央图：结构有结果时自动打开第一个匹配的对话，
              // 这样"搜到了"和"看到了"是同一件事，不用再点一次。
              var first = firstMatchSession(sessionTree.tree, v)
              var q = String(v ?? '').trim()
              if (q !== '' && first === null) {
                // 结构里没命中。但正文可能命中，先看已有的检索结果：
                // 有命中就不要清空中间，等 runFind 回来再定。
                var hits = Array.isArray(findHits) ? findHits : []
                if (hits.length === 0) setSearchEmpty(true)
                return
              }
              setSearchEmpty(false)
              if (first !== null && first !== activeSessionId) {
                setViewedSessionId(first === sessionId ? null : first)
                setSelected(null)
                patchTree({ currentSessionId: first })
              }
            },
          }),
          // ── 归类 ──
          h('button', {
            type: 'button',
            className: 'dsh_tm_wsact',
            'data-on': sessionTree.busy ? '1' : undefined,
            title: (sessionTree.workspaces ?? []).length === 0
              ? '还没有登记任何工作区，无法归类'
              : (sessionTree.tree.length > 0 ? '重新归类' : '让模型把会话归成大类'),
            onClick: recategorize,
            // 没有工作区时归类无从下手（后端只会回"没有工作区"），直接置灰
            disabled: sessionTree.busy || (sessionTree.workspaces ?? []).length === 0,
          }, sessionTree.busy ? '归类中…' : '归类'),
          h('span', { className: 'dsh_tm_kpis' },
            h('span', null, '工作区'),
            (function () {
              var totals = workspaceTotals(sessionTree.tree, sessionTree.uncategorized, data)
              return h(React.Fragment, null,
                h('span', { className: 'dsh_tm_kpi' }, h('b', null,
                  sessionTree.loading || totals.turns === null ? '…' : String(totals.turns)), ' 轮'),
                h('span', { className: 'dsh_tm_kpi' }, h('b', null,
                  sessionTree.loading ? '…' : String(totals.topics)), ' 话题'),
              )
            })(),
          ),
          // 归类进行中的进度提示。
          //
          // 归类要调模型，实测 25-56 秒。只在按钮上写"归类中…"太不明显，
          // 用户会以为卡死了。这里给一个带流动动画的条，明确"在跑"。
          sessionTree.busy
            ? h('span', { className: 'dsh_tm_busybar', title: '正在调用模型归类，请稍候' },
                h('i', null),
                h('span', null, '归类中'),
              )
            : null,
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
              'data-on': themeChoice !== 'auto' ? '1' : undefined,
              title: THEME.themeLabel(themeChoice, resolvedTheme).title,
              onClick: cycleTheme,
            }, THEME.themeLabel(themeChoice, resolvedTheme).icon),
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
        h('div', { className: 'dsh_tm_body' },
          h('div', { className: 'dsh_tm_side' },
            // ── 左栏：话题 → 对话 → 会话 ──
            //
            // 三级语义（这是用户反复确认过的叫法）：
            //   话题  模型分的主题（插件开发 / 环境排障…）
            //   对话  话题下的细分（话题树插件 / 开关机动画…）
            //   会话  平台真实的那个 session（带轮数，点它看图上泳道）
            h('div', { className: 'dsh_tm_sidehalf', 'data-flex': '1' },
              h('div', { className: 'dsh_tm_sidehead' },
                h('span', { className: 'dsh_tm_sidetitle' }, '话题'),
                // 全部折叠 / 全部展开。
                //
                // 树有三级，逐个点开很费事；尤其想快速总览有哪些话题时，
                // 全是展开状态反而看不清结构。这两个按钮一次到位。
                h('span', { className: 'dsh_tm_foldbtns' },
                  h('button', {
                    type: 'button', className: 'dsh_tm_foldbtn',
                    title: '全部展开',
                    onClick: function (ev) { ev.stopPropagation(); foldAll(false) },
                  }, '⊞'),
                  h('button', {
                    type: 'button', className: 'dsh_tm_foldbtn',
                    title: '全部折叠',
                    onClick: function (ev) { ev.stopPropagation(); foldAll(true) },
                  }, '⊟'),
                ),
                h('span', { className: 'dsh_tm_sidehint' },
                  sessionTree.workspaceId === null ? '' : (sessionTree.total + ' 会话')),
              ),
              h(CategoryList, {
                tree: sessionTree.tree,
                currentSessionId: activeSessionId,
                activeScope: laneScope,
                // 当前会话的实时分段数：缓存里的段数会过期，
                // 用它纠正"正在看的这一个"。data 为空时传 null。
                liveSessionId: activeSessionId,
                liveLaneCount: data !== null && Array.isArray(data.lanes) ? data.lanes.length : null,
                // 当前会话的归属（话题 › 对话），用于左栏默认高亮
                ownerTopic: ownerOf(activeSessionId).topic,
                ownerDialog: ownerOf(activeSessionId).dialog,
                // 一个工作区都没登记时，空态提示要说明"没有工作区"而不是"还没归类"
                noWorkspace: (sessionTree.workspaces ?? []).length === 0 && sessionTree.workspaceId === null,
                folded: sessionTree.folded,
                query: sessionTree.query,
                uncategorized: sessionTree.uncategorized,
                // 跨会话正文检索结果（与结构筛选用同一个输入框）
                findHits: findHits,
                findHint: findHint,
                findBusy: findBusy,
                digests: sessionTree.digests,
                busy: sessionTree.busy,
                onCategorize: recategorize,
                onToggle: toggleTreeFold,
                onOpen: function (id) {
                  setViewedSessionId(id === sessionId ? null : id)
                  setSelected(null)
                  setSemantic(null)
                  // 点具体会话 = 回到单会话地图
                  setLaneScope(null)
                  patchTree({ currentSessionId: id })
                },
                onScope: function (scope) {
                  // 点话题 → 对话列表；点对话 → 会话列表
                  setSelected(null)
                  setSemantic(null)
                  setSearchEmpty(false)
                  // 用 enterScope 而不是直接 setLaneScope：
                  // 它会同时展开左栏对应分区并滚动到那里（反向联动）
                  enterScope(scope)
                  // 会话层列表要显示轮数与主题，先把这些会话的数据拉回来
                  if (scope.level === 'dialog') loadScopeData(scope.sessions)
                },
              }),
            ),
          ),
          // 搜索零命中：中间图不画，只留一句说明。
          // 否则图上还挂着上一次的内容，看起来像"搜索没生效"。
          searchEmpty
            ? h('div', { className: 'dsh_tm_blank' },
                h('div', { className: 'dsh_tm_blankicon' }, '⌕'),
                h('div', null, '没有匹配的话题或会话'),
                h('div', { className: 'dsh_tm_blankhint' }, '换个关键字，或清空搜索框'),
              )
            : laneScope !== null
            ? h(LevelList, {
                level: laneScope.level,
                name: laneScope.name,
                crumbs: laneScope.crumbs,
                // 话题层列出对话；对话层列出会话（轮数与主题从缓存补）
                items: laneScope.level === 'topic'
                  ? (laneScope.items || [])
                  : (laneScope.sessions || []).map(function (s) {
                      var p = scopeData[s.id]
                      return {
                        id: s.id,
                        title: s.title,
                        turns: p !== undefined && Array.isArray(p.turns) ? p.turns.length : s.turns,
                        topic: scopeData[s.id] === undefined ? null : digestTopicOf(s.id),
                      }
                    }),
                loading: laneScope.level === 'dialog'
                  && (laneScope.sessions || []).some(function (s) { return scopeData[s.id] === undefined }),
                onPick: function (item) {
                  if (laneScope.level === 'topic') {
                    // 点对话 → 进入会话列表
                    var catName = laneScope.name
                    var sub = findSubcategory(sessionTree.tree, catName, item.name)
                    if (sub === null) return
                    var sessions = (sub.sessions ?? []).map(function (x) {
                      return { id: x.sessionId, title: x.title, turns: x.turns }
                    })
                    // 用 enterScope：进入下一级的同时，把左栏那个对话
                    // 展开并高亮、滚到可见 —— 中间与左栏要一起动
                    enterScope({
                      level: 'dialog',
                      name: item.name,
                      sessions: sessions,
                      crumbs: [
                        { level: 'topic', name: catName },
                        { level: 'dialog', name: item.name },
                      ],
                    })
                    loadScopeData(sessions)
                  } else {
                    // 点会话 → 进入那一个会话的泳道地图
                    setViewedSessionId(item.id === sessionId ? null : item.id)
                    setLaneScope(null)
                    setSelected(null)
                    setSemantic(null)
                    patchTree({ currentSessionId: item.id })
                  }
                },
                onBack: function () { goBackLevel() },
                onCrumb: function (c) { goToCrumb(c) },
              })
            : h('div', {
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
              visibleLaneIds: visibleLaneIds,
              hovered: hovered,
              selected: selected,
              highlightLane: highlightLane,
              selectedLane: selectedLane,
              selectedTurn: selected,
              onHover: function (turnNo, ev) {
                // hovered 参与"节点高亮"，值不变时 React 自己会跳过更新，
                // 所以这里安全。
                setHovered(turnNo)

                // 提示框位置（pos）只给 HoverTip 用，但它**每次鼠标移动都变**，
                // 直接 setPos 会让整块面板（几十条泳道 + 上百节点）跟着重渲染，
                // 鼠标在节点上划过就明显掉帧。
                // 这里合并到一帧一次，并且位移很小时干脆不动。
                if (!ev) return
                posPendingRef.current = { x: ev.clientX, y: ev.clientY }
                if (posRafRef.current !== 0) return
                var schedule = typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function'
                  ? window.requestAnimationFrame.bind(window)
                  : function (fn) { return window.setTimeout(fn, 16) }
                posRafRef.current = schedule(function () {
                  posRafRef.current = 0
                  var next = posPendingRef.current
                  if (next === null) return
                  setPos(function (prev) {
                    if (prev !== null && Math.abs(prev.x - next.x) < 3 && Math.abs(prev.y - next.y) < 3) return prev
                    return { x: next.x, y: next.y }
                  })
                })
              },
              onLeave: function () { setHovered(null) },
              onSelect: function (turnNo) {
                // 双向联动的入口：图上点节点 → 左树展开并高亮对应任务，
                // 同时把右栏列表滚到那一轮（否则右栏停在原处，
                // 看不出图上选的这一轮在列表里的位置）。
                selectTurn(turnNo)
                requestAnimationFrame(function () { scrollTurnListTo(turnNo) })
              },
            }),
          ),
          // 右栏：三种情况
          //   搜索零命中 → 不显示
          //   列表视图（laneScope）→ 显示当前层级的范围说明，
          //     而不是上一个会话的轮次（否则左右对不上号）
          //   单会话视图 → 显示话题 + 轮次列表
          searchEmpty
            ? null
            : laneScope !== null
            ? h('div', { className: 'dsh_tm_detail' },
                h('div', { className: 'dsh_tm_dscroll' },
                  h('div', { className: 'dsh_tm_dhead' },
                    h('span', { className: 'dsh_tm_sect' },
                      laneScope.level === 'topic' ? '对话列表' : '会话列表')),
                  h('div', { className: 'dsh_tm_lvsummary' },
                    h('div', { className: 'dsh_tm_kv' },
                      h('span', null, laneScope.level === 'topic' ? '话题' : '对话'),
                      h('b', null, laneScope.name),
                    ),
                    h('div', { className: 'dsh_tm_kv' },
                      h('span', null, '下级数量'),
                      h('b', null, String(laneScope.level === 'topic'
                        ? (laneScope.items || []).length
                        : (laneScope.sessions || []).length)),
                    ),
                    h('div', { className: 'dsh_tm_lvnote' },
                      '点中间列表里的条目进入下一级；点上方的面包屑可返回。'),
                  ),
                ),
              )
            : h('div', { className: 'dsh_tm_detail' },
            // 主体是"主题 + 轮次列表"（v2 的核心）
            detailLane !== null && detailLane !== undefined
              ? h('div', { className: 'dsh_tm_tlsplit' },
                  h(TurnList, {
                    lane: detailLane,
                    turns: data.turns,
                    // 全会话搜索需要知道每条泳道含哪些轮次，用来标注结果归属
                    allLanes: data.lanes,
                    // 归属路径（话题 › 对话），替代原来永远显示"未分类"的阶段名
                    ownerPath: ownerPathOf(activeSessionId),
                    openTurns: openTurns,
                    selected: selected,
                    onToggleTurn: function (turnNo) {
                      setOpenTurns(function (prev) {
                        var next = Object.assign({}, prev)
                        if (next[turnNo] === true) delete next[turnNo]
                        else next[turnNo] = true
                        return next
                      })
                    },
                    onSelectTurn: function (turnNo) {
                      // 与"点图上节点"走同一条路径。
                      //
                      // 早先这里只 setSelected，不聚焦泳道 —— 于是从右栏
                      // 点某一轮，图上只有个小圆环，所属泳道毫无反应，
                      // 用户看不出"这一轮属于哪条线"。三处入口
                      // （图上点节点 / 右栏点轮次 / 搜索跳转）必须一致。
                      selectTurn(turnNo)
                      requestAnimationFrame(function () { scrollTurnListTo(turnNo) })
                    },
                    onJump: canJump ? function (turnNo) { jumpTo(turnNo) } : undefined,
                  }),
                  // 选中某一轮时，详情附在列表下方
                  selectedFact !== null
                    ? h('div', { className: 'dsh_tm_tlfoot' }, detail)
                    : null,
                )
              : detail,
            selectedFact !== null
              ? h('div', { className: 'dsh_tm_act' },
                  // 始终渲染按钮：不可用时置灰并说明原因。
                  // 直接不渲染会让人以为"跳转功能没了"。
                  h('button', {
                    type: 'button',
                    className: canJump ? 'dsh_tm_primary' : 'dsh_tm_primary dsh_tm_primaryoff',
                    disabled: !canJump,
                    title: canJump ? '跳到对话页并定位到这一轮的用户输入' : jumpBlockReason,
                    onClick: function () { if (canJump) jumpTo(selectedFact.turn) },
                  }, canJump ? '跳转到对话' : '跳转不可用'),
                  // 置灰时把原因直接写出来，别只放在 tooltip 里
                  canJump ? null : h('div', { className: 'dsh_tm_jumpwhy' }, jumpBlockReason ?? ''),
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

    // ── 历史右栏（C2：查询列表 + 两个入口） ─────────────────────────
    //
    // 右栏 tab 是两段式注册（见 docs/verification/2026-11-25-right-surfaces-spike.md）：
    //   1. sidebarRightTabs.register 声明"这是什么 tab"；
    //   2. sidebar.right.pane.tab 槽位按 definition.id（不是 kind）挂正文。
    //
    // 默认选中不可设：宿主按 guide 条目数决定默认页，所以这里只做
    // "打开即选中"的入口（Ctrl+Shift+H / Alt+H、会话标题工具位）与一张 guide 卡片。
    //
    // C2 起正文接真实检索（POST /api/topic-map/search）：受控搜索框 +
    // 200ms 防抖 + 两行结果列表 + 底部状态条；定位/引用等动作留给 C3。
    var HISTORY_ID = 'dsh-topic-map:history'
    var HISTORY_KIND = 'topic-map-history'
    var HISTORY_TITLE = '历史'
    /** 多代码块复制时的分隔线。 */
    var HISTORY_BLOCK_SEP = String.fromCharCode(10, 10) + '---' + String.fromCharCode(10, 10)

    /** 输入防抖：太短会把每个键都变成一次全工作区检索。 */
    var HISTORY_DEBOUNCE_MS = 200

    /** 与 ui.md §2.4 的示例一致：右栏只取前 30 条，其余交给主面板。 */
    var HISTORY_SEARCH_LIMIT = 30

    /**
     * 空态结果。
     *
     * 每次状态更新都换新对象、绝不就地改字段：setResult 用同一个引用时
     * React 会跳过重渲染，界面就会停在上一批结果上。
     */
    var HISTORY_IDLE_RESULT = {
      status: 'idle',
      hits: [],
      total: 0,
      truncated: false,
      indexed: null,
      workspace: null,
      workspaceReason: '',
      coverage: null,
      elapsedMs: 0,
      error: '',
      query: '',
    }

    /** 是否「被主动取消/已被新请求取代」的错误：这类错误不进失败态。 */
    function isHistoryAbort(error) {
      if (error === null || error === undefined) return false
      return error.historyAborted === true || error.name === 'AbortError'
    }

    /** 最近一条历史右栏诊断；宿主版本漂移时留给排查用。 */
    var HISTORY_DIAGNOSTIC = null

    /**
     * 诊断订阅者。
     *
     * 为什么需要：HISTORY_DIAGNOSTIC 是模块级变量，不会自己触发 React
     * 重渲染。面板已经打开时又发生一次打开失败，如果不通知，底部那行
     * 诊断会一直停在旧值上。
     */
    var HISTORY_DIAG_LISTENERS = []

    /** 订阅诊断变化，返回退订函数。 */
    function subscribeHistoryDiag(listener) {
      if (typeof listener !== 'function') return function () {}
      HISTORY_DIAG_LISTENERS.push(listener)
      return function () {
        var at = HISTORY_DIAG_LISTENERS.indexOf(listener)
        if (at >= 0) HISTORY_DIAG_LISTENERS.splice(at, 1)
      }
    }

    /** 把异常压成一行可读文本。 */
    function errorText(error) {
      if (error === null || error === undefined) return '未知错误'
      return error.message === undefined ? String(error) : String(error.message)
    }

    /**
     * 记一条历史右栏诊断。
     *
     * 用 debug 而不是 warn/error：降级是预期路径，不应该在控制台里看起来
     * 像插件坏了；但排查"快捷键没反应"时必须能拿到原因。有订阅者时同时
     * 推给面板的空态小字，做到不用开控制台也能看到。
     */
    function historyDiag(message) {
      HISTORY_DIAGNOSTIC = String(message)
      try {
        if (typeof console !== 'undefined' && console !== null && typeof console.debug === 'function') {
          console.debug('[dsh-topic-map] ' + HISTORY_DIAGNOSTIC)
        }
      } catch (error) {
        // 控制台不可用也不能影响主流程
      }
      for (var i = HISTORY_DIAG_LISTENERS.length - 1; i >= 0; i -= 1) {
        try {
          HISTORY_DIAG_LISTENERS[i](HISTORY_DIAGNOSTIC)
        } catch (error) {
          // 单个订阅者失败不影响其它订阅者，也不影响主流程
        }
      }
    }

    /**
     * 聚焦右栏里的搜索框。
     *
     * openTab 之后正文是异步挂载的，不能只查一次；最多等 20 次 × 50ms。
     * 只在未隐藏的 session 容器里找，避免 keepMounted 留下的其它会话
     * 隐藏输入框抢走焦点。
     */
    function focusHistorySearchInput() {
      if (typeof document === 'undefined' || document === null) return
      var attempts = 0
      function attempt() {
        var input = null
        try {
          var hosts = document.querySelectorAll('[data-sidebar-right-session]')
          for (var i = 0; i < hosts.length; i += 1) {
            if (hosts[i].hidden === true) continue
            var found = hosts[i].querySelector('.dsh_tm_history_search')
            if (found !== null) { input = found; break }
          }
          // 容器结构漂移时退回全局查找：宁可聚焦到唯一的输入框，
          // 也不要让"打开后不聚焦"变成静默失败。
          if (input === null && hosts.length === 0) input = document.querySelector('.dsh_tm_history_search')
        } catch (error) {
          input = null
        }
        if (input !== null && input !== undefined && typeof input.focus === 'function') {
          try { input.focus({ preventScroll: true }) } catch (error) { /* 输入框可能已卸载 */ }
          return
        }
        attempts += 1
        if (attempts < 20) setTimeout(attempt, 50)
      }
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(attempt)
      else attempt()
    }

    /**
     * 打开历史右栏并聚焦搜索框（两个入口共用）。
     *
     * openTab 没有 sessionId 参数，只作用于当前屏幕上的会话；没有会话时
     * 宿主会抛 "no session surface is mounted"。所以先看 mounted 快照，
     * 失败一律降级为"什么都不做 + 一条 debug"，绝不把异常抛进 keydown。
     *
     * @param scope 可选注入子作用域（只在两个右栏服务齐备时存在）。
     * @returns 是否真的发出了打开请求（快捷键命中后据此决定 preventDefault）。
     */
    function openHistoryTab(scope) {
      var right = null
      try { right = scope.sidebarRight } catch (error) { right = null }
      if (right === null || right === undefined || typeof right.openTab !== 'function') {
        historyDiag('sidebarRight 服务不可用，历史右栏未打开')
        return false
      }

      try {
        // mounted 不是所有宿主版本都有；有就用来提前拦住"没有屏幕会话"，
        // 避免让宿主抛错。
        var mounted = right.mounted
        if (mounted !== null && mounted !== undefined && typeof mounted.getSnapshot === 'function') {
          if (mounted.getSnapshot() === undefined) {
            historyDiag('当前没有挂载的会话，历史右栏未打开')
            return false
          }
        }
        right.openTab(HISTORY_KIND, { revealIfOpened: true })
      } catch (error) {
        historyDiag('打开历史右栏失败：' + errorText(error))
        return false
      }

      focusHistorySearchInput()
      return true
    }

    // ── C3：定位 / 详情 / 复制 / 引用 / 标记 ─────────────────────────
    //
    // 历史行只带轻量命中（sessionId/turn/seq/摘要），完整正文与文件变更
    // 走 POST api/topic-map/turn-detail。接口可能还没上线，所以每个动作
    // 都必须在"数据拿不到"时有可见降级，不能白屏或静默。
    var HISTORY_LOCATE_BUDGET_MS = 8000
    var HISTORY_LOCATE_SEQ = 0
    var HISTORY_LABEL_KEYS = ['starred', 'solved', 'followUp']
    var HISTORY_LABEL_TEXT = { starred: '重要', solved: '已解决', followUp: '待跟进' }

    /** 目标会话的对话根节点（带上 data-conversation-session 的那层）。 */
    function historyConversationRoot(sessionId) {
      if (typeof document === 'undefined' || document === null) return null
      if (sessionId === null || sessionId === undefined || String(sessionId) === '') return null
      var id = String(sessionId)
      var roots = document.querySelectorAll('[data-conversation-session]')
      for (var i = 0; i < roots.length; i += 1) {
        // 后台会话的容器也在 DOM 里但 hidden；定位必须等前台这份出现。
        if (roots[i].hidden === true) continue
        if (roots[i].getAttribute('data-conversation-session') === id) return roots[i]
      }
      return null
    }

    /** 根节点里的对话滚动容器。 */
    function historyScrollerFor(root) {
      if (root === null || root === undefined) return null
      if (typeof root.querySelector === 'function') {
        var inner = root.querySelector('[data-conversation-scroll]')
        if (inner !== null) return inner
      }
      return root
    }

    /** 目标轮的行：优先精确轮次，找不到时退回"第一个 ≥ 目标的可见行"。 */
    function historyTurnRow(turnNo, scroller) {
      var row = findRowByTurn(turnNo, scroller)
      if (row === null) row = findTurnRowAtOrAfter(turnNo, scroller)
      return row
    }

    /** 把目标行滚到顶端并保持几帧（复用面板跳转的 pinRowToTop）。 */
    function historyRevealRow(row, scroller) {
      revealRow(row, scroller)
      pinRowToTop(scroller, row)
    }

    /** 会话列表里是否存在这个会话；列表还没加载时按"存在"处理，避免误报。 */
    function historySessionExists(sessionId) {
      try {
        if (SESSION_SERVICE == null) return true
        var list = SESSION_SERVICE.list
        if (list === null || list === undefined || typeof list.getSnapshot !== 'function') return true
        var snapshot = list.getSnapshot()
        var byId = snapshot === null || snapshot === undefined ? null : snapshot.byId
        if (byId === null || byId === undefined) return true
        var ids = Object.keys(byId)
        if (ids.length === 0) return true
        return byId[String(sessionId)] !== undefined
      } catch (error) {
        return true
      }
    }

    /**
     * 定位到某一轮。
     *
     * 同会话：直接在当前对话 DOM 里找行并 pin 住。
     * 跨会话：先 ctx.uiWorkspace.openSession，再轮询等待目标会话的
     * `[data-conversation-session]` / `[data-chat-turn]` 出现，总预算 8 秒。
     * 失败必须给具体原因，不允许静默。
     *
     * @returns {Promise<{ok:boolean, reason?:string}>}
     */
    function locateHistoryTurn(sessionId, turn, seq, currentSessionId) {
      var token = ++HISTORY_LOCATE_SEQ
      var startedAt = Date.now()
      return new Promise(function (resolve) {
        var done = false
        function finish(result) {
          if (done) return
          done = true
          resolve(result)
        }
        if (token !== HISTORY_LOCATE_SEQ) return finish({ ok: false, reason: '已取消' })
        if (typeof document === 'undefined' || document === null) {
          return finish({ ok: false, reason: '等待超时：当前环境没有 document' })
        }
        if (sessionId === null || sessionId === undefined || String(sessionId) === '') {
          return finish({ ok: false, reason: '未找到会话' })
        }
        var turnNo = Number(turn)
        if (!Number.isFinite(turnNo)) return finish({ ok: false, reason: '轮次信息不完整' })
        if (!historySessionExists(sessionId)) return finish({ ok: false, reason: '未找到会话' })

        var same = currentSessionId !== null && currentSessionId !== undefined
          && String(currentSessionId) === String(sessionId)

        if (!same) {
          var opener = UI_WORKSPACE_SERVICE
          if (opener === null || opener === undefined || typeof opener.openSession !== 'function') {
            return finish({ ok: false, reason: 'openSession 抛错: uiWorkspace.openSession 不可用' })
          }
          try {
            var maybe = opener.openSession(String(sessionId))
            if (maybe !== null && maybe !== undefined && typeof maybe.then === 'function') {
              maybe.catch(function () { /* 轮询会兜底，最终按超时报告 */ })
            }
          } catch (error) {
            return finish({ ok: false, reason: 'openSession 抛错: ' + errorText(error) })
          }
        }

        // 目标轮可能在尚未加载的历史里：先请 Chat 加载一次；失败不致命。
        try {
          if (Number.isFinite(Number(seq)) && SESSION_SERVICE !== null
            && typeof SESSION_SERVICE.binding === 'function') {
            var binding = SESSION_SERVICE.binding(sessionId)
            if (binding && binding.session && typeof binding.session.loadThrough === 'function') {
              Promise.resolve(binding.session.loadThrough(Number(seq))).catch(function () {})
            }
          }
        } catch (error) { /* 轮询仍会尝试已渲染的行 */ }

        // 宿主没有 data-conversation-session 时，切会话 1.5s 后回退到主滚动容器。
        var fallbackAt = startedAt + 1500

        function tick() {
          if (done) return
          if (token !== HISTORY_LOCATE_SEQ) return finish({ ok: false, reason: '已取消' })
          var root = historyConversationRoot(sessionId)
          var scroller = root !== null ? historyScrollerFor(root) : null
          if (scroller === null && !same && Date.now() >= fallbackAt) scroller = chatScroller()
          if (scroller === null && same) scroller = chatScroller()
          if (scroller !== null && scroller !== undefined) {
            var row = historyTurnRow(turnNo, scroller)
            if (row !== null) {
              historyRevealRow(row, scroller)
              return finish({ ok: true })
            }
          }
          if (Date.now() - startedAt >= HISTORY_LOCATE_BUDGET_MS) {
            return finish({ ok: false, reason: '等待超时' })
          }
          setTimeout(tick, 150)
        }
        tick()
      })
    }

    /** 把文本写进剪贴板；优先 Clipboard API，失败退回 execCommand。 */
    function historyCopyText(text) {
      var value = String(text === null || text === undefined ? '' : text)
      if (value === '') return Promise.resolve(false)
      try {
        if (typeof navigator !== 'undefined' && navigator !== null
          && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(value).then(function () { return true }, function () {
            return Promise.resolve(historyCopyFallback(value))
          })
        }
      } catch (error) { /* 落到兜底 */ }
      return Promise.resolve(historyCopyFallback(value))
    }

    /** 无 Clipboard API 时的兜底：临时 textarea + execCommand。 */
    function historyCopyFallback(text) {
      if (typeof document === 'undefined' || document === null) return false
      try {
        var area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.cssText = 'position:fixed;left:-9999px;top:0'
        if (document.body === null || document.body === undefined) return false
        document.body.appendChild(area)
        if (typeof area.select === 'function') area.select()
        var ok = typeof document.execCommand === 'function' && document.execCommand('copy')
        document.body.removeChild(area)
        return ok === true
      } catch (error) {
        return false
      }
    }

    /** 可选数组 / 单值归一。 */
    function historyAsArray(value) {
      if (Array.isArray(value)) return value
      if (value === null || value === undefined) return []
      return [value]
    }

    /**
     * 从一轮数据里取命令块。
     *
     * 兼容几种可能形状：`turn.tools[].command`、`turn.tools[].arguments`
     * （JSON 字符串或对象里的 command/cmd/script）、`turn.commands[]`。
     * 只认真的命令字段，不把工具名（如 "bash"）当命令复制。
     */
    function historyCommandTexts(turn) {
      var out = []
      function push(value) {
        if (typeof value !== 'string') return
        var text = value.trim()
        if (text !== '' && out.indexOf(text) < 0) out.push(text)
      }
      function fromObj(entry) {
        if (entry === null || typeof entry !== 'object') return
        push(entry.command)
        push(entry.cmd)
        var args = entry.arguments !== undefined ? entry.arguments
          : (entry.args !== undefined ? entry.args : entry.input)
        if (typeof args === 'string') {
          var parsed = null
          try { parsed = JSON.parse(args) } catch (error) { /* 可能本身就是命令行 */ }
          if (parsed === null || typeof parsed !== 'object') { push(args); return }
          args = parsed
        }
        if (args !== null && typeof args === 'object') {
          push(args.command)
          push(args.cmd)
          push(args.script)
        }
      }
      var tools = historyAsArray(turn.tools)
      for (var i = 0; i < tools.length; i += 1) {
        if (tools[i] !== null && typeof tools[i] === 'object') fromObj(tools[i])
      }
      var lists = [historyAsArray(turn.commands), historyAsArray(turn.shellCommands), historyAsArray(turn.toolCalls)]
      for (var l = 0; l < lists.length; l += 1) {
        for (var k = 0; k < lists[l].length; k += 1) {
          var entry = lists[l][k]
          if (typeof entry === 'string') push(entry)
          else fromObj(entry)
        }
      }
      return out
    }

    /** 无命令时的"结论"：整轮回复，回复为空时退回提问。 */
    function historyConclusionText(turn) {
      if (turn === null || typeof turn !== 'object') return ''
      var response = typeof turn.response === 'string' ? turn.response : ''
      if (response.trim() !== '') return response
      var prompt = typeof turn.prompt === 'string' ? turn.prompt : ''
      return prompt
    }

    /**
     * 找对话输入框。
     *
     * 排除本历史面板与右栏自带的输入框；取最后一个可见的 textarea /
     * contenteditable，通常就是对话编辑器。
     */
    /** 输入框候选选择器：textarea / input / contenteditable / role=textbox。 */
    var HISTORY_COMPOSER_SELECTORS = [
      '[contenteditable="true"]',
      '[role="textbox"]',
      'textarea',
      'input[type="text"]',
      'input:not([type])',
      'input',
    ]

    /** 是否可见；拿不到样式时按可见处理，避免误杀测试环境。 */
    function historyComposerVisible(el) {
      try {
        if (el.hidden === true) return false
        if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false
        if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false
        if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
          var style = window.getComputedStyle(el)
          if (style !== null && style !== undefined && (style.display === 'none' || style.visibility === 'hidden')) return false
        }
      } catch (error) { /* 读不到就按可见处理 */ }
      return true
    }

    /** 是否属于我们自己的右栏/历史面板，避免把搜索框当 composer。 */
    function historyComposerExcluded(el) {
      try {
        if (el.closest && el.closest('.dsh_tm_history') !== null) return true
        if (el.closest && el.closest('[data-sidebar-right-session]') !== null) return true
      } catch (error) { /* 忽略 */ }
      return false
    }

    /**
     * 收集所有可写输入框并排序。
     *
     * 不只查第一个：宿主的 composer 可能是 textarea，也可能是嵌套在
     * form / class*=composer 容器里的 contenteditable / role=textbox。
     * 优先当前焦点，其次 role=textbox，再其次 textarea；同分取 DOM 靠后的
     * （对话输入框通常在页面底部）。
     */
    function historyComposerCandidates() {
      if (typeof document === 'undefined' || document === null) return []
      var seen = []
      var list = []
      function add(el) {
        if (el === null || el === undefined) return
        if (seen.indexOf(el) >= 0) return
        seen.push(el)
        list.push(el)
      }
      function collect(root) {
        if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return
        for (var s = 0; s < HISTORY_COMPOSER_SELECTORS.length; s += 1) {
          var nodes
          try { nodes = root.querySelectorAll(HISTORY_COMPOSER_SELECTORS[s]) } catch (error) { nodes = [] }
          for (var i = 0; i < nodes.length; i += 1) add(nodes[i])
        }
      }
      collect(document)
      try {
        var containers = document.querySelectorAll('form, [data-conversation-composer], [data-composer], [class*="composer"], [class*="Composer"]')
        for (var c = 0; c < containers.length; c += 1) collect(containers[c])
      } catch (error) { /* 容器选择器不支持就算了 */ }

      var active = null
      try { active = document.activeElement || null } catch (error) { active = null }
      var ranked = []
      for (var k = 0; k < list.length; k += 1) {
        var el = list[k]
        try {
          if (el.disabled === true) continue
          if (el.readOnly === true) continue
          if (historyComposerExcluded(el)) continue
          if (!historyComposerVisible(el)) continue
          var tag = String(el.tagName || '').toUpperCase()
          if (tag !== 'TEXTAREA' && tag !== 'INPUT') {
            if (el.getAttribute && el.getAttribute('contenteditable') === 'false') continue
          }
          if (tag === 'INPUT') {
            var inputType = String(el.type === undefined || el.type === null ? 'text' : el.type).toLowerCase()
            if (inputType === 'button' || inputType === 'submit' || inputType === 'reset'
              || inputType === 'checkbox' || inputType === 'radio' || inputType === 'file'
              || inputType === 'hidden' || inputType === 'image' || inputType === 'range'
              || inputType === 'color' || inputType === 'date' || inputType === 'datetime-local'
              || inputType === 'month' || inputType === 'week' || inputType === 'time'
              || inputType === 'number' || inputType === 'password' || inputType === 'search') continue
          }
          var score = 0
          if (el === active) score += 100
          if (el.getAttribute && el.getAttribute('role') === 'textbox') score += 20
          if (tag === 'TEXTAREA') score += 10
          if (el.closest && el.closest('form') !== null) score += 5
          if (el.closest && (el.closest('[class*="composer"]') !== null || el.closest('[class*="Composer"]') !== null)) score += 5
          ranked.push({ el: el, score: score, index: k })
        } catch (error) { /* 跳过读不到属性的节点 */ }
      }
      ranked.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score
        return b.index - a.index
      })
      var out = []
      for (var r = 0; r < ranked.length; r += 1) out.push(ranked[r].el)
      return out
    }

    function historyComposerElement() {
      var list = historyComposerCandidates()
      return list.length > 0 ? list[0] : null
    }

    /** 输入框类型：text（textarea/input）或 rich（contenteditable）。 */
    function historyComposerKind(el) {
      var tag = String(el.tagName || '').toUpperCase()
      return tag === 'TEXTAREA' || tag === 'INPUT' ? 'text' : 'rich'
    }

    /** 读回输入框文本：textarea/input 用 value，富文本用 innerText/textContent。 */
    function historyComposerText(el) {
      try {
        if (historyComposerKind(el) === 'text') return String(el.value === null || el.value === undefined ? '' : el.value)
        if (typeof el.innerText === 'string') return el.innerText
        return String(el.textContent === null || el.textContent === undefined ? '' : el.textContent)
      } catch (error) {
        return ''
      }
    }

    /** 光标/选区放进输入框；富文本没有选区就放内容末尾（空框开头）。 */
    function historyComposerSelect(el) {
      var kind = historyComposerKind(el)
      try { if (typeof el.focus === 'function') el.focus() } catch (error) { /* 忽略焦点失败 */ }
      if (kind === 'text') {
        var current = historyComposerText(el)
        var start = Number.isFinite(el.selectionStart) ? el.selectionStart : current.length
        var end = Number.isFinite(el.selectionEnd) ? el.selectionEnd : start
        if (start > end) { var swap = start; start = end; end = swap }
        if (start < 0) start = 0
        if (end > current.length) end = current.length
        if (typeof el.setSelectionRange === 'function') el.setSelectionRange(start, end)
        return true
      }
      var sel = null
      try { sel = typeof window !== 'undefined' && typeof window.getSelection === 'function' ? window.getSelection() : null } catch (error) { sel = null }
      if (sel === null) return false
      if (sel.rangeCount > 0) {
        var candidate = sel.getRangeAt(0)
        var node = candidate.commonAncestorContainer
        var host = node === null || node === undefined ? null : (node.nodeType === 1 ? node : (node.parentElement || null))
        if (host !== null && (host === el || (el.contains && el.contains(host)))) return true
      }
      if (typeof document.createRange !== 'function') return false
      var range = document.createRange()
      range.selectNodeContents(el)
      range.collapse(historyComposerText(el).trim() === '')
      sel.removeAllRanges()
      sel.addRange(range)
      return true
    }

    /** textarea/input 的 DOM 兜底：setRangeText 或 slice。 */
    function historyDomInsertText(el, marked) {
      try {
        var current = historyComposerText(el)
        var start = Number.isFinite(el.selectionStart) ? el.selectionStart : current.length
        var end = Number.isFinite(el.selectionEnd) ? el.selectionEnd : start
        if (start > end) { var swap = start; start = end; end = swap }
        if (start < 0) start = 0
        if (end > current.length) end = current.length
        if (typeof el.setRangeText === 'function') {
          el.setRangeText(marked, start, end, 'end')
        } else {
          var next = current.slice(0, start) + marked + current.slice(end)
          var win = typeof window !== 'undefined' ? window : null
          var proto = String(el.tagName || '').toUpperCase() === 'TEXTAREA'
            ? (win && win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : null)
            : (win && win.HTMLInputElement ? win.HTMLInputElement.prototype : null)
          var descriptor = proto === null ? null : Object.getOwnPropertyDescriptor(proto, 'value')
          if (descriptor !== null && descriptor !== undefined && typeof descriptor.set === 'function') {
            descriptor.set.call(el, next)
          } else {
            el.value = next
          }
          if (typeof el.setSelectionRange === 'function') el.setSelectionRange(start + marked.length, start + marked.length)
        }
        if (typeof Event === 'function') el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      } catch (error) {
        return false
      }
    }

    /** contenteditable 的 DOM 兜底：插入纯文本（统一带【】，不插 chip）。 */
    function historyDomInsertRich(el, inserted) {
      try {
        var sel = typeof window !== 'undefined' && typeof window.getSelection === 'function' ? window.getSelection() : null
        var range = null
        if (sel !== null && sel.rangeCount > 0) {
          var candidate = sel.getRangeAt(0)
          var node = candidate.commonAncestorContainer
          var host = node === null || node === undefined ? null : (node.nodeType === 1 ? node : (node.parentElement || null))
          if (host !== null && (host === el || (el.contains && el.contains(host)))) range = candidate
        }
        if (range === null) {
          if (typeof document.createRange !== 'function') return false
          range = document.createRange()
          range.selectNodeContents(el)
          range.collapse(historyComposerText(el).trim() === '')
        }
        var insertedNode = null
        if (typeof document.createTextNode === 'function') {
          insertedNode = document.createTextNode(inserted)
        } else {
          insertedNode = document.createElement('span')
          insertedNode.textContent = inserted
        }
        range.deleteContents()
        range.insertNode(insertedNode)
        if (sel !== null) {
          var after = document.createRange()
          after.setStartAfter(insertedNode)
          after.collapse(true)
          sel.removeAllRanges()
          sel.addRange(after)
        }
        if (typeof Event === 'function') el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      } catch (error) {
        return false
      }
    }

    /** 数一段文本里出现 needle 的次数（读回校验用，避免旧引用造成假阳性）。 */
    function historyCountText(haystack, needle) {
      var text = String(haystack === null || haystack === undefined ? '' : haystack)
      var part = String(needle === null || needle === undefined ? '' : needle)
      if (part === '') return 0
      var count = 0
      var at = 0
      while (at >= 0 && at < text.length) {
        at = text.indexOf(part, at)
        if (at < 0) break
        count += 1
        at += part.length
      }
      return count
    }

    /**
     * 把引用写进对话输入框（两种输入框统一写 `【@第N轮对话〔handle〕】`）。
     *
     * 顺序：execCommand('insertText') → 读回校验 → DOM 兜底 → 再校验。
     * 成功后返回 `ensureInput()`：监听一次 input 事件；100ms 内没有就补发
     * 一个 InputEvent，再读回文本确认宿主确实收下。返回 `{ok, rich, reason,
     * method}`；失败时调用方复制到剪贴板并明说。
     *
     * @param text - 指针文本（不含【】）。
     */
    function historyWriteToComposer(text) {
      var value = String(text === null || text === undefined ? '' : text)
      if (value === '') return { ok: false, rich: false, reason: 'empty' }
      var el = historyComposerElement()
      if (el === null) return { ok: false, rich: false, reason: 'no-composer' }
      var kind = historyComposerKind(el)
      var rich = kind === 'rich'
      var inserted = '【' + value + '】'
      var before = historyComposerText(el)
      var beforeCount = historyCountText(before, inserted)
      function accepted() {
        var after = historyComposerText(el)
        return historyCountText(after, inserted) > beforeCount
      }

      // input 事件观察器：宿主靠它同步 state。
      var inputSeen = false
      var inputWaiters = []
      function onComposerInput() {
        inputSeen = true
        var waiters = inputWaiters
        inputWaiters = []
        for (var w = 0; w < waiters.length; w += 1) waiters[w](true)
      }
      try {
        if (typeof el.addEventListener === 'function') el.addEventListener('input', onComposerInput, true)
      } catch (error) { /* 监听失败不阻塞插入 */ }
      function cleanupInput() {
        try {
          if (typeof el.removeEventListener === 'function') el.removeEventListener('input', onComposerInput, true)
        } catch (error) { /* 忽略 */ }
      }

      /** 写后保证：等一次 input；100ms 没有就补发并再次读回。 */
      function ensureInput() {
        return new Promise(function (resolve) {
          if (inputSeen) {
            cleanupInput()
            resolve(true)
            return
          }
          var settled = false
          var timer = setTimeout(function () {
            if (settled) return
            if (inputSeen) {
              settled = true
              cleanupInput()
              resolve(true)
              return
            }
            cleanupInput()
            var dispatched = false
            try {
              var event = null
              if (typeof InputEvent === 'function') {
                event = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })
              } else if (typeof Event === 'function') {
                event = new Event('input', { bubbles: true })
              }
              if (event !== null && event !== undefined && typeof el.dispatchEvent === 'function') {
                el.dispatchEvent(event)
                dispatched = true
              }
            } catch (error) { dispatched = false }
            settled = true
            resolve(dispatched && accepted())
          }, 100)
          inputWaiters.push(function () {
            if (settled) return
            settled = true
            clearTimeout(timer)
            cleanupInput()
            resolve(true)
          })
        })
      }

      function success(method) {
        try { el.focus() } catch (error) { /* 忽略 */ }
        try {
          if (!rich) {
            var at = String(el.value || '').lastIndexOf(inserted)
            if (at >= 0 && typeof el.setSelectionRange === 'function') el.setSelectionRange(at + inserted.length, at + inserted.length)
          }
        } catch (error) { /* 光标失败不影响已插入 */ }
        return { ok: true, rich: rich, method: method, ensureInput: ensureInput }
      }

      // 1) 宿主编辑器优先路径：execCommand insertText。
      if (typeof document !== 'undefined' && document !== null && typeof document.execCommand === 'function') {
        try {
          if (historyComposerSelect(el) && document.execCommand('insertText', false, inserted) === true) {
            if (accepted()) return success('exec')
          }
        } catch (error) { /* 落到 DOM 兜底 */ }
      }

      // 2) DOM 兜底。
      var domOk = rich ? historyDomInsertRich(el, inserted) : historyDomInsertText(el, inserted)
      if (domOk && accepted()) return success('dom')

      cleanupInput()
      return { ok: false, rich: rich, reason: 'rejected' }
    }

    /** 标签对象里的三个开关（顺序固定）。 */
    function historyLabelStatuses(label) {
      if (label === null || label === undefined) return []
      if (typeof label === 'string') {
        return HISTORY_LABEL_KEYS.filter(function (key) { return label.toLowerCase() === key.toLowerCase() })
      }
      if (Array.isArray(label)) {
        return HISTORY_LABEL_KEYS.filter(function (key) { return label.indexOf(key) >= 0 })
      }
      if (typeof label !== 'object') return []
      return HISTORY_LABEL_KEYS.filter(function (key) { return label[key] === true })
    }

    /** 详情接口未就绪 / 失败的中文文案。 */
    function historyDetailMessage(error) {
      if (error !== null && error !== undefined && error.historyDetailMissing === true) return '详情接口未就绪'
      return '详情加载失败：' + errorText(error)
    }

    /** 读某一轮的完整详情（跨会话检索结果只有摘要，详情按需拉）。 */
    function loadHistoryTurnDetail(sessionId, turn) {
      if (typeof fetch !== 'function') return Promise.reject(new Error('fetch 不可用'))
      return fetch('api/topic-map/turn-detail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, turn: turn, before: 1, after: 1 }),
      }).then(function (res) {
        if (res === null || res === undefined) throw new Error('没有响应')
        if (res.status === 404) {
          // 端点存在之后，404 也可能是"轮次不存在"；只有拿不到这个
          // 语义时才当成"详情接口未就绪"。
          return res.json().then(function (payload) {
            var reason = payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
              ? payload.error : ''
            if (reason === '轮次不存在') throw new Error('轮次不存在')
            var missing = new Error('详情接口未就绪')
            missing.historyDetailMissing = true
            throw missing
          }, function () {
            var missing = new Error('详情接口未就绪')
            missing.historyDetailMissing = true
            throw missing
          })
        }
        if (res.ok !== true) throw new Error('HTTP ' + String(res.status))
        return res.json().then(function (payload) { return payload }, function () {
          throw new Error('响应不是 JSON')
        })
      }).then(function (payload) {
        if (payload === null || typeof payload !== 'object') throw new Error('响应为空')
        if (payload.ok !== true) {
          var failed = new Error(typeof payload.error === 'string' && payload.error !== '' ? payload.error : '接口返回失败')
          failed.historyDetailMissing = true
          throw failed
        }
        var value = payload.value
        if (value === null || typeof value !== 'object') throw new Error('响应缺少 value')
        return value
      })
    }

    /**
     * 读某会话的命令分页（POST /api/topic-map/session-commands）。
     *
     * 接口未就绪（404 / ok:false）时抛「命令接口未就绪」，浮窗据此显示，
     * 不静默、不白屏。分页永远走接口，不一次拉全量。
     *
     * @returns {Promise<{total,offset,limit,hasMore,commands}>}
     */
    function fetchSessionCommands(sessionId, offset, limit, options) {
      if (typeof fetch !== 'function') return Promise.reject(new Error('fetch 不可用'))
      var opt = options !== null && typeof options === 'object' ? options : {}
      var body = { sessionId: sessionId, offset: offset, limit: limit }
      if (typeof opt.q === 'string' && opt.q !== '') body.q = opt.q
      if (typeof opt.lang === 'string' && opt.lang !== '') body.lang = opt.lang
      return fetch('api/topic-map/session-commands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }).then(function (res) {
        if (res === null || res === undefined) throw new Error('没有响应')
        if (res.status === 404) throw new Error('命令接口未就绪')
        if (res.ok !== true) throw new Error('HTTP ' + String(res.status))
        return res.json().then(function (payload) { return payload }, function () {
          throw new Error('响应不是 JSON')
        })
      }).then(function (payload) {
        if (payload === null || typeof payload !== 'object') throw new Error('响应为空')
        if (payload.ok !== true) {
          throw new Error(typeof payload.error === 'string' && payload.error !== '' ? payload.error : '命令接口未就绪')
        }
        var value = payload.value
        if (value === null || typeof value !== 'object') throw new Error('响应缺少 value')
        var list = Array.isArray(value.commands) ? value.commands : []
        var commands = []
        for (var i = 0; i < list.length; i += 1) {
          var item = list[i]
          if (item === null || typeof item !== 'object') continue
          var text = typeof item.text === 'string' ? item.text
            : (typeof item.command === 'string' ? item.command : '')
          commands.push({
            seq: Number.isFinite(Number(item.seq)) ? Number(item.seq) : (Number(offset) + i + 1),
            turn: Number.isFinite(Number(item.turn)) ? Number(item.turn) : null,
            lang: typeof item.lang === 'string' ? item.lang : '',
            text: text,
          })
        }
        var total = Number(value.total)
        var grandTotal = Number(value.grandTotal)
        if (!Number.isFinite(grandTotal)) grandTotal = Number(value.allTotal)
        if (!Number.isFinite(grandTotal)) grandTotal = Number(value.totalAll)
        var pageOffset = Number(value.offset)
        var pageLimit = Number(value.limit)
        var hasMore = typeof value.hasMore === 'boolean'
          ? value.hasMore
          : (Number.isFinite(total) && Number.isFinite(pageOffset) && Number.isFinite(pageLimit)
            ? pageOffset + commands.length < total
            : commands.length >= (Number.isFinite(pageLimit) ? pageLimit : limit))
        var langs = []
        if (Array.isArray(value.langs)) {
          for (var l = 0; l < value.langs.length; l += 1) {
            if (typeof value.langs[l] === 'string' && value.langs[l] !== '') langs.push(value.langs[l])
          }
        }
        return {
          total: Number.isFinite(total) ? total : commands.length,
          grandTotal: Number.isFinite(grandTotal) ? grandTotal : null,
          offset: Number.isFinite(pageOffset) ? pageOffset : Number(offset) || 0,
          limit: Number.isFinite(pageLimit) ? pageLimit : Number(limit) || 20,
          hasMore: hasMore,
          langs: langs,
          commands: commands,
        }
      })
    }

    /** 为「复制全部」按页拉完；仍然一页一页走接口。 */
    function fetchAllSessionCommands(sessionId, options) {
      var out = []
      var offset = 0
      var pages = 0
      function next() {
        if (pages >= 200) return Promise.resolve(out)
        pages += 1
        return fetchSessionCommands(sessionId, offset, 100, options).then(function (page) {
          out = out.concat(page.commands)
          if (!page.hasMore || page.commands.length === 0) return out
          offset = page.offset + page.commands.length
          return next()
        })
      }
      return next()
    }

    /** 三开关写标签：workspaceId 由 /search 返回，不在客户端猜。 */
    function setHistoryLabel(workspaceId, sessionId, turn, patch) {
      return post('label-set', {
        workspaceId: workspaceId,
        sessionId: sessionId,
        turn: turn,
        patch: patch,
      })
    }

    /**
     * 轮次句柄：`<sessionId 去掉 session- 前缀后的前 8 位>#<轮号>`。
     *
     * 例：`session-4c42ff36-…` 的第 33 轮 → `4c42ff36#33`。宿主侧有工具
     * 按这个句柄解析回具体轮次；拿不到 sessionId 时退化成 `#33`（仍可读，
     * 解析会失败但不会崩）。
     */
    function historyHandleOf(sessionId, turn) {
      var turnNo = Number(turn)
      var turnPart = Number.isFinite(turnNo) ? '#' + turnNo : '#'
      var raw = sessionId === null || sessionId === undefined ? '' : String(sessionId).trim()
      if (raw === '') return turnPart
      var stripped = raw.replace(/^session[-_:]/i, '')
      var prefix = stripped.slice(0, 8)
      return prefix === '' ? turnPart : prefix + turnPart
    }

    /**
     * 仅指针：`@第33轮对话〔4c42ff36#33〕`。
     *
     * 句柄是可被工具解析的，指针不再只是一段给人看的标签。
     */
    function historyCitePointer(entry) {
      var hit = entry === null || entry === undefined ? {} : entry.hit
      var turnNo = Number(hit.turn)
      var label = Number.isFinite(turnNo) ? '@第' + turnNo + '轮对话' : '@该轮对话'
      return label + '〔' + historyHandleOf(hit.sessionId, hit.turn) + '〕'
    }

    /**
     * 历史右栏正文（C2：查询态）。
     *
     * 结构对应 ui.md §2.2：标题栏（图钉仍是占位）→ 受控搜索框 → 两行结果 /
     * 状态文案 → 底部状态条。数据走 POST /api/topic-map/search（与主面板
     * 同一套内核命中），显示只用 lib/hit-view.js 的行模型，不自己拼字段。
     *
     * 状态机（ui.md §2.2 / §6）：
     *   idle    输入为空：断点续接占位（C2 不做数据）
     *   loading 防抖到期后已发请求：保留上一批结果，另给一行"检索中…"
     *   ready   有结果：两行紧凑列表；空结果给建议文案
     *   error   网络 / 非 200 / ok:false：显示"检索失败：原因"，不清空已有结果
     *
     * 并发保护：每次新查询先 abort 上一次（AbortController），并用自增
     * 请求序号挡住"已经落地但晚于新请求"的结果——abort 管网络，序号管
     * 微任务次序，两者任一失效都不会让迟到结果覆盖新结果。
     *
     * @param props 右栏 session 作用域的标准 props；`props.sessionId` 用于
     *              反查当前会话所属工作区（与 TopicMapPanel 同口径）。
     */
    function HistoryTabBody(props) {
      var boundSessionId = props === null || props === undefined ? null : props.sessionId

      // 右栏可能先于话题地图面板挂载。主题变量写在 :root[data-tm-theme]
      // 上，这里补一次同样的解析，否则本组件里的 var(--tm-*) 全为空。
      useEffect(function () {
        if (typeof document === 'undefined' || document === null) return
        var resolved = 'light'
        try {
          var choice = typeof sessionStorage === 'undefined' || sessionStorage === null
            ? 'auto'
            : THEME.loadThemeChoice(sessionStorage)
          resolved = THEME.resolveTheme(choice, document)
        } catch (error) {
          // 读不到存储就按浅色兜底：变量必须至少有一套完整值
        }
        try {
          document.documentElement.setAttribute('data-tm-theme', resolved)
        } catch (error) {
          // 根节点不可写时只影响配色，不影响使用
        }
      }, [])

      // ── 状态 ────────────────────────────────────────────────────
      var queryState = useState('')
      var query = queryState[0]; var setQuery = queryState[1]
      var resultState = useState(HISTORY_IDLE_RESULT)
      var result = resultState[0]; var setResult = resultState[1]
      var selectedState = useState(0)
      var selected = selectedState[0]; var setSelected = selectedState[1]
      // C3：动作条 / 详情 / 标记 / 行内提示 / 引用预算确认。
      var labelsState = useState({})
      var labels = labelsState[0]; var setLabels = labelsState[1]
      var menuState = useState(false)
      var menuOpen = menuState[0]; var setMenuOpen = menuState[1]
      var detailState = useState(null)
      var detail = detailState[0]; var setDetail = detailState[1]
      var noticeState = useState(null)
      var notice = noticeState[0]; var setNotice = noticeState[1]
      var diagState = useState(HISTORY_DIAGNOSTIC)
      var diagText = diagState[0]; var setDiagText = diagState[1]
      // 复制浮窗：null / {kind:'commands',...} / {kind:'conclusion',...}
      var modalState = useState(null)
      var modal = modalState[0]; var setModal = modalState[1]

      // 并发控制：seq 每次新查询自增；abort 断掉上一次的网络请求。
      var seqRef = useRef(0)
      var abortRef = useRef(null)
      // 防抖定时器与列表滚动容器（选中行要滚进视野）。
      var timerRef = useRef(0)
      var listRef = useRef(null)
      var noticeTimerRef = useRef(0)
      var modalListRef = useRef(null)
      var modalSeqRef = useRef(0)
      var modalFilterTimerRef = useRef(0)
      var modalRef = useRef(null)
      modalRef.current = modal

      // 诊断变量不是 React state；订阅变化，面板开着时也能看到最新一条原因。
      useEffect(function () {
        return subscribeHistoryDiag(function (value) { setDiagText(value) })
      }, [])

      // 卸载时清掉行内提示的定时器，避免对已卸载组件 setState。
      useEffect(function () {
        return function () {
          if (modalFilterTimerRef.current !== 0) {
            clearTimeout(modalFilterTimerRef.current)
            modalFilterTimerRef.current = 0
          }
          if (noticeTimerRef.current !== 0) {
            clearTimeout(noticeTimerRef.current)
            noticeTimerRef.current = 0
          }
        }
      }, [])

      // 浮窗打开时 Esc 关闭；只监听 Escape，不抢其它按键。
      useEffect(function () {
        if (modal === null || modal === undefined) return undefined
        if (typeof document === 'undefined' || document === null) return undefined
        function onModalKey(event) {
          if (event === null || event === undefined) return
          if (event.key !== 'Escape') return
          event.preventDefault()
          closeHistoryModal()
        }
        document.addEventListener('keydown', onModalKey)
        return function () { document.removeEventListener('keydown', onModalKey) }
      }, [modal])

      /** 4 秒后自动消失的行内提示。 */
      function showHistoryNotice(text, tone) {
        var message = String(text === null || text === undefined ? '' : text)
        if (message === '') return
        setNotice({ text: message, tone: tone === 'error' ? 'error' : (tone === 'ok' ? 'ok' : 'info') })
        if (noticeTimerRef.current !== 0) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = setTimeout(function () {
          noticeTimerRef.current = 0
          setNotice(null)
        }, 4000)
      }

      /** 行的稳定身份：sessionId#turn。 */
      function historyRowKey(hit) {
        var sessionId = hit === null || hit === undefined ? '' : String(hit.sessionId || '')
        var turn = hit === null || hit === undefined ? '' : String(hit.turn === undefined ? '' : hit.turn)
        return sessionId + '#' + turn
      }

      /**
       * 命中 → 行模型。只在结果/查询变化时重算，避免每次按键都重跑。
       * 时间一律用渲染时的 now，不读 hit.time 之外的系统时钟。
       */
      var rows = useMemo(function () {
        if (result === null || result === undefined || result.status === 'idle') return []
        var now = Date.now()
        var keywords = typeof result.query === 'string' ? result.query : ''
        var hits = Array.isArray(result.hits) ? result.hits : []
        return hits.map(function (hit) {
          var row = HITVIEW.toRow(hit, { now: now, keywords: keywords, labels: labels })
          // 有分数时把拆解挂到 title：hover 就能看到"为什么排在这里"（A-14）。
          var score = ''
          if (hit !== null && typeof hit === 'object' && Number.isFinite(hit.score)) {
            score = HITVIEW.scoreParts(hit)
          }
          return { hit: hit, row: row, score: score }
        })
      }, [result, labels])

      /**
       * 让上一次查询彻底作废：abort 网络 + 序号自增。
       *
       * 两个动作都要做——AbortController 只能断还没返回的请求；已经 resolve、
       * 只等微任务落地的结果靠序号挡。
       */
      function cancelHistorySearch() {
        seqRef.current += 1
        var controller = abortRef.current
        abortRef.current = null
        if (controller !== null && controller !== undefined) {
          try { controller.abort() } catch (error) { /* 请求可能已经结束 */ }
        }
      }

      /**
       * ── 唯一的"请求数据"入口 ─────────────────────────────────────
       *
       * 发 POST /api/topic-map/search，只传 sessionId（工作区由 Host 反解，
       * 客户端不再猜"第一个工作区"）。返回 Promise<normalized>：
       * `{ hits, total, truncated, scanned, elapsedMs, indexed,
       *    workspace, workspaceReason, coverage, query }`。
       * 渲染仍留在本组件内，不要把 fetch 散到事件回调里。
       *
       * 失败时 reject 原始错误；被新查询/卸载取消时 reject 带
       * `historyAborted` 的错误，调用方据此静默丢弃。
       *
       * @param rawQuery - 用户输入。
       * @returns {Promise<object|null>} 归一化结果；空查询返回 null。
       */
      function requestHistory(rawQuery) {
        var text = String(rawQuery === null || rawQuery === undefined ? '' : rawQuery).trim()
        if (text === '') return Promise.resolve(null)

        // 新查询发出：上一次立即 abort，并让它的序号失效。
        cancelHistorySearch()
        var seq = seqRef.current
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        if (controller !== null) abortRef.current = controller

        function abortedError() {
          var error = new Error('检索已取消')
          error.name = 'AbortError'
          error.historyAborted = true
          return error
        }
        function ensureCurrent() {
          if (seq !== seqRef.current) throw abortedError()
        }

        // 不再在客户端猜工作区：把 sessionId 交给 Host 反解，避免
        // "反查不到就退第一个工区"导致搜到别的工作区的内容。
        var init = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: boundSessionId,
            keywords: text,
            limit: HISTORY_SEARCH_LIMIT,
          }),
        }
        if (controller !== null) init.signal = controller.signal
        return fetch('/api/topic-map/search', init).then(function (res) {
          ensureCurrent()
          if (res === null || res === undefined) throw new Error('没有响应')
          if (res.ok !== true) throw new Error('HTTP ' + String(res.status))
          return res.json().then(function (payload) {
            return payload
          }, function () {
            throw new Error('响应不是 JSON')
          })
        }).then(function (payload) {
          ensureCurrent()
          if (payload === null || typeof payload !== 'object') throw new Error('响应为空')
          if (payload.ok !== true) {
            throw new Error(typeof payload.error === 'string' && payload.error !== '' ? payload.error : '检索接口返回失败')
          }
          var value = payload.value
          if (value === null || typeof value !== 'object') throw new Error('响应缺少 value')

          var hits = Array.isArray(value.hits) ? value.hits : []
          var total = Number(value.total)
          var elapsed = Number(value.elapsedMs)
          var indexed = value.indexed !== null && typeof value.indexed === 'object' ? value.indexed : null
          var workspace = value.workspace !== null && typeof value.workspace === 'object' ? value.workspace : null
          var workspaceReason = typeof value.reason === 'string' && value.reason !== ''
            ? value.reason
            : (value.workspaceId === null && typeof value.reason === 'string' ? value.reason : '')
          var coverage = value.coverage !== null && typeof value.coverage === 'object' ? value.coverage : null
          return {
            hits: hits,
            total: Number.isFinite(total) ? total : hits.length,
            truncated: value.truncated === true,
            scanned: Number.isFinite(Number(value.scanned)) ? Number(value.scanned) : null,
            elapsedMs: Number.isFinite(elapsed) ? elapsed : 0,
            indexed: indexed === null ? null : {
              ready: Number.isFinite(Number(indexed.ready)) ? Number(indexed.ready) : 0,
              missing: Number.isFinite(Number(indexed.missing)) ? Number(indexed.missing) : 0,
            },
            workspace: workspace,
            workspaceReason: workspaceReason,
            coverage: coverage,
            query: text,
          }
        })
      }

      /** 发一次查询，并把结果落到状态机（loading → ready / error）。 */
      function startHistorySearch(text) {
        // 保留上一批结果：除了避免闪空，也让"新查询失败"时旧结果还在。
        setResult(function (prev) {
          return {
            status: 'loading',
            hits: prev.hits,
            total: prev.total,
            truncated: prev.truncated,
            indexed: prev.indexed,
            workspace: prev.workspace,
            workspaceReason: prev.workspaceReason,
            coverage: prev.coverage,
            elapsedMs: prev.elapsedMs,
            error: '',
            query: prev.query,
          }
        })

        var pending
        try {
          pending = requestHistory(text)
        } catch (error) {
          // 极端情况：运行环境没有 fetch/AbortController 之类，同步抛错也不许白屏。
          if (abortRef.current !== null) abortRef.current = null
          setResult(function (prev) {
            return {
              status: 'error',
              hits: prev.hits,
              total: prev.total,
              truncated: prev.truncated,
              indexed: prev.indexed,
              workspace: prev.workspace,
              workspaceReason: prev.workspaceReason,
              coverage: prev.coverage,
              elapsedMs: prev.elapsedMs,
              error: errorText(error) || '未知错误',
              query: prev.query,
            }
          })
          return
        }
        // requestHistory 会同步自增序号；这里读到的是本次请求的序号。
        var seq = seqRef.current
        pending.then(function (value) {
          if (value === null || seq !== seqRef.current) return
          if (abortRef.current !== null) abortRef.current = null
          setResult({
            status: 'ready',
            hits: value.hits,
            total: value.total,
            truncated: value.truncated,
            indexed: value.indexed,
            workspace: value.workspace,
            workspaceReason: value.workspaceReason,
            coverage: value.coverage,
            elapsedMs: value.elapsedMs,
            error: '',
            query: value.query,
          })
          setSelected(0)
        }, function (error) {
          if (seq !== seqRef.current) return
          if (isHistoryAbort(error)) return
          if (abortRef.current !== null) abortRef.current = null
          // 硬要求：失败只加一条错误，不清空已有结果（不清 hits）。
          setResult(function (prev) {
            return {
              status: 'error',
              hits: prev.hits,
              total: prev.total,
              truncated: prev.truncated,
              indexed: prev.indexed,
              workspace: prev.workspace,
              workspaceReason: prev.workspaceReason,
              coverage: prev.coverage,
              elapsedMs: prev.elapsedMs,
              error: errorText(error) || '未知错误',
              query: prev.query,
            }
          })
        })
      }

      /**
       * 输入防抖 + 空态复位。
       *
       * 清理函数负责取消：改词、切会话、卸载都会 abort 上一次，避免
       * 旧查询在 200ms 窗口里落地。
       */
      useEffect(function () {
        var text = String(query === null || query === undefined ? '' : query).trim()
        if (text === '') {
          cancelHistorySearch()
          setResult(HISTORY_IDLE_RESULT)
          setSelected(0)
          return undefined
        }
        timerRef.current = setTimeout(function () {
          timerRef.current = 0
          startHistorySearch(text)
        }, HISTORY_DEBOUNCE_MS)
        return function () {
          if (timerRef.current !== 0) {
            clearTimeout(timerRef.current)
            timerRef.current = 0
          }
          cancelHistorySearch()
        }
      }, [query, boundSessionId])

      /** 键盘选择变化后把选中行滚进视野（不抢焦点）。 */
      useEffect(function () {
        var body = listRef.current
        if (body === null || body === undefined) return
        var node = null
        try { node = body.querySelector('[data-hist-index="' + selected + '"]') } catch (error) { node = null }
        if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') {
          try { node.scrollIntoView({ block: 'nearest' }) } catch (error) { /* 旧宿主不支持参数 */ }
        }
      }, [selected, result])

      // ── 交互 ────────────────────────────────────────────────────
      /** 命中侧的中文短标记：提问 / 回答（ui.md §2.2 行首）。 */
      function sideLabelOf(hit) {
        if (hit === null || typeof hit !== 'object') return ''
        if (hit.matchedIn === 'response') return '回答'
        if (hit.matchedIn === 'prompt') return '提问'
        return ''
      }

      /** 选中一行；上一行的菜单/详情同时收起。 */
      function selectHistoryRow(index) {
        setSelected(index)
        setMenuOpen(false)
        setDetail(null)
      }

      /**
       * 确保某一轮的详情已加载。
       *
       * 不依赖组件异步 state：直接把本次结果 resolve 给动作处理器，
       * 这样"点复制→立即拿到命令"不会因为还没重渲染而读到 null。
       */
      function ensureHistoryDetail(entry, force) {
        var hit = entry.hit
        var key = historyRowKey(hit)
        if (force !== true && detail !== null && detail !== undefined && detail.key === key) {
          if (detail.status === 'ready') return Promise.resolve({ status: 'ready', data: detail.data, error: '', key: key })
          if (detail.status === 'error') return Promise.resolve({ status: 'error', data: null, error: detail.error, key: key })
          if (detail.status === 'loading' && detail.promise) return detail.promise
        }
        var pending = loadHistoryTurnDetail(hit.sessionId, hit.turn).then(function (value) {
          setDetail({ key: key, status: 'ready', data: value, error: '', expanded: false })
          return { status: 'ready', data: value, error: '', key: key }
        }, function (error) {
          var message = historyDetailMessage(error)
          historyDiag('详情加载失败：' + message)
          setDetail({ key: key, status: 'error', data: null, error: message, expanded: false })
          return { status: 'error', data: null, error: message, key: key }
        })
        setDetail({ key: key, status: 'loading', data: null, error: '', expanded: false, promise: pending })
        return pending
      }

      /** 详情按钮：已展开则收起，否则加载/展开。 */
      function toggleHistoryDetail(entry) {
        var key = historyRowKey(entry.hit)
        if (detail !== null && detail !== undefined && detail.key === key) {
          setDetail(null)
          return
        }
        setMenuOpen(false)
        ensureHistoryDetail(entry)
      }

      /** 定位到某轮；失败原因必须可见。 */
      function locateHistoryEntry(entry) {
        var hit = entry.hit
        var turnLabel = Number.isFinite(Number(hit.turn)) ? ('第 ' + Number(hit.turn) + ' 轮') : '该轮'
        showHistoryNotice('正在定位' + turnLabel + '…', 'info')
        locateHistoryTurn(hit.sessionId, hit.turn, hit.seq, boundSessionId).then(function (result) {
          if (result.ok) {
            showHistoryNotice('已定位到' + turnLabel, 'ok')
            return
          }
          var reason = result.reason || '未知原因'
          historyDiag('定位失败：' + reason)
          showHistoryNotice('定位失败：' + reason, 'error')
        }, function (error) {
          var reason = errorText(error)
          historyDiag('定位失败：' + reason)
          showHistoryNotice('定位失败：' + reason, 'error')
        })
      }

      /** 关掉浮窗。 */
      function closeHistoryModal() {
        modalSeqRef.current += 1
        if (modalFilterTimerRef.current !== 0) {
          clearTimeout(modalFilterTimerRef.current)
          modalFilterTimerRef.current = 0
        }
        setModal(null)
      }

      /** 合并语言选项；空 lang 记成 no-lang，渲染时显示"（无标注）"。 */
      function mergeCommandLangs(prev, data) {
        var out = Array.isArray(prev) ? prev.slice() : []
        var list = data !== null && data !== undefined && Array.isArray(data.langs) ? data.langs : []
        for (var i = 0; i < list.length; i += 1) {
          if (typeof list[i] === 'string' && list[i] !== '' && out.indexOf(list[i]) < 0) out.push(list[i])
        }
        var commands = data !== null && data !== undefined && Array.isArray(data.commands) ? data.commands : []
        for (var c = 0; c < commands.length; c += 1) {
          var lang = typeof commands[c].lang === 'string' ? commands[c].lang : ''
          if (lang !== '' && out.indexOf(lang) < 0) out.push(lang)
        }
        return out
      }

      /** 拉一页命令并落到浮窗状态；过滤参数 q/lang 走接口，旧请求用序号作废。 */
      function loadCommandPage(sessionId, offset, options) {
        var opt = options !== null && typeof options === 'object' ? options : {}
        var keyword = typeof opt.keyword === 'string' ? opt.keyword : ''
        var q = typeof opt.q === 'string' ? opt.q : ''
        var lang = typeof opt.lang === 'string' ? opt.lang : ''
        var prev = modalRef.current
        var prevLangs = prev !== null && prev !== undefined && prev.kind === 'commands' && Array.isArray(prev.langs) ? prev.langs : []
        var prevGrand = prev !== null && prev !== undefined && prev.kind === 'commands' ? prev.grandTotal : null
        var token = ++modalSeqRef.current
        setModal({
          kind: 'commands', sessionId: sessionId, offset: offset,
          status: 'loading', data: null, error: '',
          keyword: keyword, q: q, lang: lang, langs: prevLangs, grandTotal: prevGrand,
        })
        fetchSessionCommands(sessionId, offset, 20, { q: q, lang: lang }).then(function (data) {
          if (token !== modalSeqRef.current) return
          var noFilter = q === '' && lang === ''
          var grandTotal = noFilter ? data.total : (data.grandTotal !== null ? data.grandTotal : prevGrand)
          setModal({
            kind: 'commands', sessionId: sessionId, offset: data.offset,
            status: 'ready', data: data, error: '',
            keyword: keyword, q: q, lang: lang,
            langs: mergeCommandLangs(prevLangs, data), grandTotal: grandTotal,
          })
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
              var list = modalListRef.current
              if (list !== null && list !== undefined) list.scrollTop = 0
            })
          }
        }, function (error) {
          if (token !== modalSeqRef.current) return
          setModal({
            kind: 'commands', sessionId: sessionId, offset: offset,
            status: 'error', data: null, error: errorText(error),
            keyword: keyword, q: q, lang: lang, langs: prevLangs, grandTotal: prevGrand,
          })
        })
      }

      /** 「复制命令」：打开本会话命令块浮窗（不再直接写剪贴板）。 */
      function openCommandModal(entry) {
        setMenuOpen(false)
        loadCommandPage(entry.hit.sessionId, 0, { keyword: '', q: '', lang: 'shell' })
      }

      /** 翻页：保留当前关键词与语言。 */
      function commandModalPage(offset) {
        if (modal === null || modal === undefined || modal.kind !== 'commands') return
        var next = Number(offset)
        if (!Number.isFinite(next) || next < 0) return
        loadCommandPage(modal.sessionId, next, { keyword: modal.keyword || '', q: modal.q || '', lang: modal.lang || '' })
      }

      /** 关键词防抖 300ms：只在接口层过滤，分页数据不预取。 */
      function onCommandKeywordInput(value) {
        if (modal === null || modal === undefined || modal.kind !== 'commands') return
        var keyword = String(value === null || value === undefined ? '' : value)
        var sessionId = modal.sessionId
        var lang = modal.lang || ''
        setModal(function (prev) {
          if (prev === null || prev === undefined || prev.kind !== 'commands') return prev
          return Object.assign({}, prev, { keyword: keyword })
        })
        if (modalFilterTimerRef.current !== 0) {
          clearTimeout(modalFilterTimerRef.current)
          modalFilterTimerRef.current = 0
        }
        modalFilterTimerRef.current = setTimeout(function () {
          modalFilterTimerRef.current = 0
          loadCommandPage(sessionId, 0, {
            keyword: keyword,
            q: keyword.trim(),
            lang: lang,
          })
        }, 300)
      }

      /** 切换语言：回到第 1 页，关键词保留。 */
      function onCommandLangChange(value) {
        if (modal === null || modal === undefined || modal.kind !== 'commands') return
        if (modalFilterTimerRef.current !== 0) {
          clearTimeout(modalFilterTimerRef.current)
          modalFilterTimerRef.current = 0
        }
        var lang = String(value === null || value === undefined ? '' : value)
        loadCommandPage(modal.sessionId, 0, {
          keyword: modal.keyword || '',
          q: String(modal.keyword || '').trim(),
          lang: lang,
        })
      }

      /** 复制浮窗里的一个代码块。 */
      function copyOneCommand(command) {
        var text = command === null || command === undefined ? '' : String(command.text === null || command.text === undefined ? '' : command.text)
        if (text.trim() === '') {
          showHistoryNotice('这个代码块没有可复制的文本', 'error')
          return
        }
        historyCopyText(text).then(function (ok) {
          if (ok) showHistoryNotice('已复制第 ' + command.seq + ' 个代码块', 'ok')
          else showHistoryNotice('复制第 ' + command.seq + ' 个代码块失败：剪贴板不可用', 'error')
        })
      }

      /** 复制当前页全部代码块（块之间用分隔线）。 */
      function copyCommandPage() {
        if (modal === null || modal === undefined || modal.kind !== 'commands' || modal.data === null) return
        var commands = Array.isArray(modal.data.commands) ? modal.data.commands : []
        var texts = commands.map(function (command) { return String(command.text || '') }).filter(function (text) { return text !== '' })
        if (texts.length === 0) {
          showHistoryNotice('本页没有命令块', 'error')
          return
        }
        historyCopyText(texts.join(HISTORY_BLOCK_SEP)).then(function (ok) {
          if (ok) showHistoryNotice('已复制本页 ' + texts.length + ' 个代码块', 'ok')
          else showHistoryNotice('复制本页失败：剪贴板不可用', 'error')
        })
      }

      /** 复制全部代码块：逐页拉取，保留当前筛选。 */
      function copyAllCommands() {
        if (modal === null || modal === undefined || modal.kind !== 'commands') return
        var options = { q: modal.q || '', lang: modal.lang || '' }
        showHistoryNotice('正在读取全部命令块…', 'info')
        fetchAllSessionCommands(modal.sessionId, options).then(function (commands) {
          var texts = commands.map(function (command) { return String(command.text || '') }).filter(function (text) { return text !== '' })
          if (texts.length === 0) {
            showHistoryNotice('本会话没有命令块', 'error')
            return
          }
          historyCopyText(texts.join(HISTORY_BLOCK_SEP)).then(function (ok) {
            if (ok) showHistoryNotice('已复制全部 ' + texts.length + ' 个代码块', 'ok')
            else showHistoryNotice('复制全部失败：剪贴板不可用', 'error')
          })
        }, function (error) {
          showHistoryNotice('读取全部命令失败：' + errorText(error), 'error')
        })
      }

      /** 「复制结论」：先拿详情，再打开只读浮窗。 */
      function openConclusionModal(entry) {
        setMenuOpen(false)
        showHistoryNotice('正在读取结论…', 'info')
        ensureHistoryDetail(entry).then(function (state) {
          if (state.status !== 'ready') {
            showHistoryNotice(state.error || '详情接口未就绪，无法查看结论', 'error')
            return
          }
          var data = state.data === null || state.data === undefined ? null : state.data
          var turn = data === null || data === undefined ? null : data.turn
          var text = historyConclusionText(turn)
          if (String(text === null || text === undefined ? '' : text).trim() === '') {
            showHistoryNotice('该轮没有可复制的结论', 'error')
            return
          }
          var turnNo = Number(entry.hit.turn)
          setModal({
            kind: 'conclusion',
            title: Number.isFinite(turnNo) ? '第 ' + turnNo + ' 轮结论' : '本轮结论',
            text: text,
          })
        })
      }

      /** 复制结论浮窗里的全文。 */
      function copyModalConclusion() {
        if (modal === null || modal === undefined || modal.kind !== 'conclusion') return
        historyCopyText(modal.text).then(function (ok) {
          if (ok) showHistoryNotice('已复制结论', 'ok')
          else showHistoryNotice('复制结论失败：剪贴板不可用', 'error')
        })
      }

      /** 标题栏工作区文案：正常显示 path/title；Host 拒绝时显示 reason。 */
      function workspaceLabelOf(res) {
        if (res === null || res === undefined) return ''
        if (typeof res.workspaceReason === 'string' && res.workspaceReason !== '') return res.workspaceReason
        var ws = res.workspace
        if (ws === null || ws === undefined) return ''
        var path = typeof ws.path === 'string' ? ws.path : ''
        var title = typeof ws.title === 'string' ? ws.title : ''
        var id = typeof ws.id === 'string' ? ws.id : ''
        return path || title || id
      }

      /** 「补齐索引」：POST /workspace-reindex，成功后提示排队数。 */
      function reindexWorkspace() {
        var ws = result.workspace
        if (ws === null || ws === undefined || ws.id === null || ws.id === undefined) {
          showHistoryNotice(result.workspaceReason || '当前没有可补齐索引的工作区', 'error')
          return
        }
        showHistoryNotice('正在排队补齐索引…', 'info')
        post('workspace-reindex', { workspaceId: ws.id }).then(function (value) {
          var queued = null
          if (value !== null && typeof value === 'object') {
            if (Number.isFinite(Number(value.queued))) queued = Number(value.queued)
            else if (Number.isFinite(Number(value.count))) queued = Number(value.count)
            else if (Number.isFinite(Number(value.total))) queued = Number(value.total)
            else if (Array.isArray(value.sessions)) queued = value.sessions.length
          }
          showHistoryNotice(queued === null ? '已排队补齐索引' : '已排队 ' + queued + ' 个会话', 'ok')
        }, function (error) {
          var reason = errorText(error)
          historyDiag('补齐索引失败：' + reason)
          showHistoryNotice('补齐索引失败：' + reason, 'error')
        })
      }

      /**
       * 插入引用（只有一档）：`【@第4轮对话〔7786241b#4〕】`。
       *
       * 两种输入框统一纯文本；写后等一次 input 事件，100ms 内没有就补发
       * InputEvent，再读回确认。仍失败则复制到剪贴板并明说。
       */
      function quoteHistoryEntry(entry) {
        var text = historyCitePointer(entry)
        var result = historyWriteToComposer(text)
        function fallbackCopy(rejected) {
          historyCopyText(text).then(function (ok) {
            if (ok) {
              showHistoryNotice(rejected
                ? '插入失败（输入框未接受），已复制到剪贴板'
                : '已复制引用（摘要）', rejected ? 'error' : 'ok')
              return
            }
            historyDiag('插入引用失败：输入框不可写且剪贴板不可用')
            showHistoryNotice(rejected
              ? '插入失败（输入框未接受），复制到剪贴板也失败'
              : '插入引用失败：输入框不可写且剪贴板不可用', 'error')
          })
        }
        if (result === null || result === undefined || result.ok !== true) {
          fallbackCopy(result !== null && result !== undefined && result.reason === 'rejected')
          return
        }
        var pending = typeof result.ensureInput === 'function' ? result.ensureInput() : Promise.resolve(true)
        pending.then(function (ok) {
          if (ok) {
            historyDiag('引用插入成功：' + (result.method === 'exec' ? 'execCommand' : 'DOM 兜底'))
            showHistoryNotice('已插入引用【' + text + '】', 'ok')
            return
          }
          fallbackCopy(true)
        }, function () {
          fallbackCopy(true)
        })
      }

      /** 当前标签（本地覆盖优先，其次命中自带）。 */
      function currentHistoryLabel(entry) {
        var key = historyRowKey(entry.hit)
        if (labels !== null && labels !== undefined && Object.prototype.hasOwnProperty.call(labels, key)) {
          return labels[key]
        }
        return entry.hit === null || entry.hit === undefined ? null : entry.hit.label
      }

      /** 三开关写标签；成功后就地更新行徽标。 */
      function toggleHistoryLabel(entry, status) {
        var hit = entry.hit
        var key = historyRowKey(hit)
        var statuses = historyLabelStatuses(currentHistoryLabel(entry))
        var on = statuses.indexOf(status) >= 0
        var workspace = result.workspace
        if (workspace === null || workspace === undefined || workspace.id === null || workspace.id === undefined) {
          showHistoryNotice(result.workspaceReason || '当前没有可写标签的工作区', 'error')
          return
        }
        var patch = {}
        patch[status] = !on
        showHistoryNotice((on ? '正在取消' : '正在标记') + HISTORY_LABEL_TEXT[status] + '…', 'info')
        setHistoryLabel(workspace.id, hit.sessionId, hit.turn, patch).then(function (value) {
          var next = Object.assign({}, labels)
          var nextKey = value !== null && value !== undefined && typeof value.key === 'string' ? value.key : key
          next[nextKey] = value === null || value === undefined ? {} : value.label
          setLabels(next)
          showHistoryNotice((on ? '已取消' : '已标记') + HISTORY_LABEL_TEXT[status], 'ok')
        }, function (error) {
          var reason = errorText(error)
          historyDiag('标记失败：' + reason)
          showHistoryNotice('标记失败：' + reason, 'error')
        })
      }

      /**
       * 键盘（ui.md §2.3）：↑/↓ 选中，Enter 暂只记 debug（定位在 C3 接），
       * Esc 清空输入回到空态。焦点始终留在输入框，符合"边打边选"。
       */
      function handleSearchKeyDown(event) {
        if (event === null || event === undefined) return
        var count = rows.length
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSelected(function (prev) {
            if (count === 0) return 0
            var next = (Number.isFinite(prev) ? prev : 0) + 1
            return next > count - 1 ? count - 1 : next
          })
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSelected(function (prev) {
            if (count === 0) return 0
            var next = (Number.isFinite(prev) ? prev : 0) - 1
            return next < 0 ? 0 : next
          })
          return
        }
        if (event.key === 'Enter') {
          if (count === 0) return
          event.preventDefault()
          var entry = rows[selected]
          if (entry !== undefined) locateHistoryEntry(entry)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setQuery('')
          setSelected(0)
        }
      }

      /** 片段按 `row.highlight` 切成 [前, <mark>, 后]；越界一律回退纯文本。 */
      function highlightNodes(text, highlight) {
        var value = typeof text === 'string' ? text : ''
        if (value === '') return []
        if (highlight === null || typeof highlight !== 'object') return [value]
        var start = Number(highlight.start)
        var len = Number(highlight.len)
        if (!Number.isFinite(start) || !Number.isFinite(len) || len <= 0 || start >= value.length) return [value]
        var from = Math.max(0, Math.floor(start))
        var size = Math.max(1, Math.min(Math.floor(len), value.length - from))
        var nodes = []
        if (from > 0) nodes.push(value.slice(0, from))
        nodes.push(h('mark', { key: 'hl', className: 'dsh_tm_histmark' }, value.slice(from, from + size)))
        if (from + size < value.length) nodes.push(value.slice(from + size))
        return nodes
      }

      /** 命令数：hit.commandCount 优先；字段未到时用已加载详情补。 */
      function commandCountOf(entry) {
        if (entry.hit !== null && entry.hit !== undefined && Number.isFinite(Number(entry.hit.commandCount))) {
          return Math.max(0, Number(entry.hit.commandCount))
        }
        var key = historyRowKey(entry.hit)
        if (detail !== null && detail !== undefined && detail.key === key && detail.status === 'ready') {
          var data = detail.data
          var turn = data === null || data === undefined ? null : data.turn
          return historyCommandTexts(turn).length
        }
        return null
      }

      /** 行徽标：失败/中断/有变更 + 三个标签的名字。 */
      function rowBadgeNodes(entry) {
        var row = entry.row
        var nodes = []
        var badges = Array.isArray(row.badges) ? row.badges : []
        for (var i = 0; i < badges.length; i += 1) {
          nodes.push(h('span', { className: 'dsh_tm_histbadge', key: 'badge-' + i }, badges[i]))
        }
        var statusLabel = typeof row.statusLabel === 'string' ? row.statusLabel : ''
        if (statusLabel !== '') {
          nodes.push(h('span', { className: 'dsh_tm_histbadge dsh_tm_histbadge_lab', key: 'badge-labels' }, statusLabel))
        }
        return nodes
      }

      /** 选中行的行内动作条：默认 定位 / 详情，其余收进 ⋯。 */
      function renderHistoryActions(entry) {
        var key = historyRowKey(entry.hit)
        var detailOpen = detail !== null && detail !== undefined && detail.key === key
        var nodes = [
          h('button', {
            key: 'locate', type: 'button', className: 'dsh_tm_histact',
            onClick: function (event) { event.stopPropagation(); locateHistoryEntry(entry) },
          }, '定位'),
          h('button', {
            key: 'detail', type: 'button',
            className: detailOpen ? 'dsh_tm_histact dsh_tm_histact_on' : 'dsh_tm_histact',
            onClick: function (event) { event.stopPropagation(); toggleHistoryDetail(entry) },
          }, detailOpen ? '收起详情' : '详情'),
          h('button', {
            key: 'quote', type: 'button', className: 'dsh_tm_histact',
            title: '插入可被工具解析的轮次句柄',
            onClick: function (event) { event.stopPropagation(); quoteHistoryEntry(entry) },
          }, '引用'),
          h('button', {
            key: 'menu', type: 'button', className: 'dsh_tm_histmenubtn',
            title: '更多动作', 'aria-label': '更多动作', 'aria-expanded': menuOpen ? 'true' : 'false',
            onClick: function (event) { event.stopPropagation(); setMenuOpen(!menuOpen) },
          }, '⋯'),
        ]
        if (menuOpen === true) {
          var statuses = historyLabelStatuses(currentHistoryLabel(entry))
          var menu = [
            h('button', {
              key: 'copy-commands', type: 'button', className: 'dsh_tm_histact',
              onClick: function (event) { event.stopPropagation(); openCommandModal(entry) },
            }, '复制命令'),
            h('button', {
              key: 'copy-conclusion', type: 'button', className: 'dsh_tm_histact',
              onClick: function (event) { event.stopPropagation(); openConclusionModal(entry) },
            }, '复制结论'),
            h('span', { key: 'mark-label', className: 'dsh_tm_histmenulabel' }, '标记'),
          ]
          for (var i = 0; i < HISTORY_LABEL_KEYS.length; i += 1) {
            ;(function (status) {
              var on = statuses.indexOf(status) >= 0
              menu.push(h('button', {
                key: 'label-' + status,
                type: 'button',
                className: on ? 'dsh_tm_histact dsh_tm_histact_on' : 'dsh_tm_histact',
                'aria-pressed': on ? 'true' : 'false',
                onClick: function (event) { event.stopPropagation(); toggleHistoryLabel(entry, status) },
              }, on ? '✓ ' + HISTORY_LABEL_TEXT[status] : HISTORY_LABEL_TEXT[status]))
            })(HISTORY_LABEL_KEYS[i])
          }
          nodes.push(h('div', { key: 'menu-pane', className: 'dsh_tm_histmenupane' }, menu))
        }
        return h('div', { className: 'dsh_tm_histactions' }, nodes)
      }

      /** token 用量文案：兼容 total / input+output 两种形状。 */
      function usageLabel(usage) {
        if (usage === null || usage === undefined || typeof usage !== 'object') return 'tokens —'
        var total = Number(usage.total)
        if (Number.isFinite(total)) return 'tokens ' + total
        var input = Number(usage.input !== undefined ? usage.input : usage.inputTokens)
        var output = Number(usage.output !== undefined ? usage.output : usage.outputTokens)
        if (Number.isFinite(input) || Number.isFinite(output)) {
          return 'tokens ' + ((Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0))
        }
        return 'tokens —'
      }

      /** 文件变更条目：字符串或 {path,added,removed}。 */
      function fileChangeLabel(file) {
        if (typeof file === 'string') return file
        if (file === null || typeof file !== 'object') return ''
        var path = file.path !== undefined ? file.path : (file.file !== undefined ? file.file : file.name)
        var added = Number(file.added)
        var removed = Number(file.removed)
        var stats = ''
        if (Number.isFinite(added) || Number.isFinite(removed)) {
          stats = ' (+' + (Number.isFinite(added) ? added : 0) + ' −' + (Number.isFinite(removed) ? removed : 0) + ')'
        }
        return String(path === undefined || path === null ? '' : path) + stats
      }

      /** 详情面板：加载中 / 失败 / 内容三态。 */
      function renderHistoryDetail(entry) {
        var key = historyRowKey(entry.hit)
        if (detail === null || detail === undefined || detail.key !== key) return null
        if (detail.status === 'loading') {
          return h('div', { className: 'dsh_tm_histdetail' },
            h('div', { className: 'dsh_tm_histnote' }, '详情加载中…'))
        }
        if (detail.status === 'error') {
          return h('div', { className: 'dsh_tm_histdetail' },
            h('div', { className: 'dsh_tm_histerr' }, detail.error),
            h('div', { className: 'dsh_tm_histdact' },
              h('button', {
                type: 'button', className: 'dsh_tm_histact',
                onClick: function (event) { event.stopPropagation(); ensureHistoryDetail(entry, true) },
              }, '重试'),
              h('button', {
                type: 'button', className: 'dsh_tm_histact',
                onClick: function (event) { event.stopPropagation(); setDetail(null) },
              }, '收起'),
            ))
        }

        var value = detail.data === null || detail.data === undefined ? {} : detail.data
        var turn = value.turn === null || value.turn === undefined || typeof value.turn !== 'object' ? {} : value.turn
        var expanded = detail.expanded === true
        var limit = expanded ? Number.MAX_SAFE_INTEGER : 300
        function clip(text) {
          var source = typeof text === 'string' ? text : ''
          return source.length > limit ? source.slice(0, limit) + '…' : source
        }
        var promptText = clip(turn.prompt)
        var responseText = clip(turn.response)
        var canExpand = String(turn.prompt || '').length > 300 || String(turn.response || '').length > 300
        var files = Array.isArray(turn.changes && turn.changes.files)
          ? turn.changes.files
          : (Array.isArray(turn.files) ? turn.files : [])
        var neighbors = Array.isArray(value.neighbors) ? value.neighbors : []
        var labelValue = value.label !== undefined && value.label !== null
          ? value.label
          : currentHistoryLabel(entry)
        var statuses = historyLabelStatuses(labelValue)

        var sections = [
          h('div', { className: 'dsh_tm_histdsec', key: 'prompt' },
            h('b', null, '提问'), h('div', { className: 'dsh_tm_histdtext' }, promptText === '' ? '—' : promptText)),
          h('div', { className: 'dsh_tm_histdsec', key: 'response' },
            h('b', null, '回答'), h('div', { className: 'dsh_tm_histdtext' }, responseText === '' ? '—' : responseText)),
        ]
        if (canExpand) {
          sections.push(h('button', {
            key: 'expand', type: 'button', className: 'dsh_tm_histact',
            onClick: function (event) {
              event.stopPropagation()
              setDetail(function (prev) {
                return prev === null ? prev : Object.assign({}, prev, { expanded: !prev.expanded })
              })
            },
          }, expanded ? '收起全文' : '展开全文'))
        }
        sections.push(h('div', { className: 'dsh_tm_histdmeta', key: 'meta' },
          '模型 ' + (turn.model === undefined || turn.model === null || turn.model === '' ? '—' : String(turn.model))
          + ' · 耗时 ' + fmtDuration(turn.ms === null || turn.ms === undefined ? NaN : Number(turn.ms))
          + ' · ' + usageLabel(turn.usage)
          + ' · ' + (turn.endReason === undefined || turn.endReason === null ? '—' : String(turn.endReason))))
        if (files.length > 0) {
          sections.push(h('div', { className: 'dsh_tm_histdsec', key: 'files' },
            h('b', null, '文件变更'),
            h('ul', { className: 'dsh_tm_histdfiles' }, files.map(function (file, index) {
              return h('li', { key: 'file-' + index }, fileChangeLabel(file))
            }))))
        }
        if (neighbors.length > 0) {
          sections.push(h('div', { className: 'dsh_tm_histdsec', key: 'neighbors' },
            h('b', null, '前后各 1 轮'),
            h('ul', { className: 'dsh_tm_histdneighbors' }, neighbors.map(function (neighbor, index) {
              var turnNo = neighbor === null || neighbor === undefined ? null : neighbor.turn
              var head = neighbor === null || neighbor === undefined || typeof neighbor.promptHead !== 'string' ? '' : neighbor.promptHead
              var when = neighbor === null || neighbor === undefined ? '' : HITVIEW.formatRelativeTime(neighbor.time, Date.now())
              return h('li', { key: 'neighbor-' + index },
                '第 ' + (turnNo === null ? '?' : turnNo) + ' 轮'
                + (when === '' ? '' : ' · ' + when)
                + (head === '' ? '' : ' · ' + head))
            }))))
        }
        sections.push(h('div', { className: 'dsh_tm_histdsec', key: 'labels' },
          h('b', null, '标记'),
          h('div', { className: 'dsh_tm_histdtext' },
            statuses.length === 0 ? '未标记' : statuses.map(function (status) { return HISTORY_LABEL_TEXT[status] }).join(' · '))))
        return h('div', { className: 'dsh_tm_histdetail' }, sections)
      }

      /** 复制浮窗：命令分页 / 结论全文。 */
      function renderHistoryModal() {
        if (modal === null || modal === undefined) return null
        function head(title) {
          return h('div', { className: 'dsh_tm_histdialoghead' },
            h('div', { className: 'dsh_tm_histdialogtitle' }, title),
            h('button', {
              type: 'button', className: 'dsh_tm_histdialogclose',
              title: '关闭', 'aria-label': '关闭',
              onClick: function (event) { event.stopPropagation(); closeHistoryModal() },
            }, '✕'))
        }
        function dialog(children) {
          return h('div', {
            className: 'dsh_tm_histmodal',
            role: 'presentation',
            onClick: function () { closeHistoryModal() },
          },
            h('div', {
              className: 'dsh_tm_histdialog',
              role: 'dialog', 'aria-modal': 'true',
              onClick: function (event) { event.stopPropagation() },
            }, children))
        }
        if (modal.kind === 'conclusion') {
          return dialog([
            head(modal.title),
            h('pre', { className: 'dsh_tm_histpre' }, modal.text),
            h('div', { className: 'dsh_tm_histdialogfoot' },
              h('span', { className: 'dsh_tm_histpage' }, '全文只读 · 可手动选择'),
              h('span', { className: 'dsh_tm_histgrow' }),
              h('button', {
                type: 'button', className: 'dsh_tm_histact',
                onClick: function (event) { event.stopPropagation(); copyModalConclusion() },
              }, '复制'),
              h('button', {
                type: 'button', className: 'dsh_tm_histact',
                onClick: function (event) { event.stopPropagation(); closeHistoryModal() },
              }, '关闭')),
          ])
        }

        var data = modal.data
        var total = data === null || data === undefined ? 0 : data.total
        var limit = data === null || data === undefined ? 20 : Math.max(1, data.limit)
        var offset = Number(modal.offset) || 0
        var pageCount = Math.max(1, Math.ceil(total / limit))
        var pageNo = Math.floor(offset / limit) + 1
        var keyword = typeof modal.keyword === 'string' ? modal.keyword : ''
        var activeLang = typeof modal.lang === 'string' ? modal.lang : ''
        var filtering = String(modal.q || '').trim() !== '' || activeLang !== ''
        var grandTotal = modal.grandTotal !== null && modal.grandTotal !== undefined ? modal.grandTotal : total
        var countText = filtering
          ? '共 ' + grandTotal + ' 条 / 匹配 ' + total + ' 条'
          : '共 ' + total + ' 条'
        var langs = Array.isArray(modal.langs) ? modal.langs : []
        var hasNoLang = activeLang === 'none'
        if (data !== null && data !== undefined && Array.isArray(data.commands)) {
          for (var n = 0; n < data.commands.length; n += 1) {
            if (String(data.commands[n].lang || '') === '') hasNoLang = true
          }
        }
        var filterChildren = [
          h('input', {
            key: 'kw', type: 'search', className: 'dsh_tm_histfilterinput',
            placeholder: '关键词…', 'aria-label': '筛选命令块',
            value: keyword,
            onChange: function (event) {
              var next = event !== null && event !== undefined && event.target !== null && event.target !== undefined
                ? event.target.value : ''
              onCommandKeywordInput(next === null || next === undefined ? '' : String(next))
            },
          }),
          h('select', {
            key: 'lang', className: 'dsh_tm_histfilterlang', 'aria-label': '按语言筛选',
            value: activeLang,
            onChange: function (event) {
              var next = event !== null && event !== undefined && event.target !== null && event.target !== undefined
                ? event.target.value : ''
              onCommandLangChange(next === null || next === undefined ? '' : String(next))
            },
          },
            h('option', { value: 'shell' }, '常用命令（shell）'),
            h('option', { value: '' }, '全部'),
            langs.filter(function (lang) { return lang !== '' && lang !== 'shell'; }).map(function (lang) {
              return h('option', { key: 'lang-' + lang, value: lang }, lang)
            }),
            hasNoLang ? h('option', { key: 'lang-none', value: 'none' }, '（无标注）') : null),
          h('span', { key: 'count', className: 'dsh_tm_histfiltercount' }, countText),
        ]

        var listNodes = []
        if (modal.status === 'loading') {
          listNodes.push(h('div', { className: 'dsh_tm_histnote', key: 'loading' }, '命令块加载中…'))
        } else if (modal.status === 'error') {
          listNodes.push(h('div', { className: 'dsh_tm_histerr', key: 'error' }, modal.error || '命令接口未就绪'))
          listNodes.push(h('button', {
            type: 'button', className: 'dsh_tm_histact', key: 'retry',
            onClick: function (event) {
              event.stopPropagation()
              loadCommandPage(modal.sessionId, offset, { keyword: keyword, q: modal.q || '', lang: activeLang })
            },
          }, '重试'))
        } else if (data === null || data === undefined || data.commands.length === 0) {
          if (activeLang === 'shell') {
            listNodes.push(h('div', { className: 'dsh_tm_histmodalempty', key: 'empty' },
              h('div', null, '当前会话没有 shell 代码块，切到「全部」看看'),
              h('button', {
                type: 'button', className: 'dsh_tm_histact',
                onClick: function (event) { event.stopPropagation(); onCommandLangChange('') },
              }, '切到「全部」')))
          } else {
            listNodes.push(h('div', { className: 'dsh_tm_histmodalempty', key: 'empty' },
              filtering ? '没有匹配的命令' : '本会话没有命令块'))
          }
        } else {
          for (var i = 0; i < data.commands.length; i += 1) {
            ;(function (command) {
              var lang = typeof command.lang === 'string' ? command.lang : ''
              var badge = lang === '' ? 'code' : lang
              listNodes.push(h('div', {
                key: 'cmd-' + command.seq,
                className: 'dsh_tm_histcmdrow',
                title: command.text,
              },
                h('span', {
                  className: 'dsh_tm_histcmdindex',
                  title: '第 ' + command.seq + ' 个代码块',
                }, '#' + command.seq),
                h('span', {
                  className: 'dsh_tm_histcmdlang',
                  title: lang === '' ? '无语言标注' : '语言：' + lang,
                }, badge),
                h('div', { className: 'dsh_tm_histcmdtext' }, command.text),
                h('button', {
                  type: 'button', className: 'dsh_tm_histcmdcopy',
                  title: '复制这个代码块', 'aria-label': '复制第 ' + command.seq + ' 个代码块',
                  onClick: function (event) { event.stopPropagation(); copyOneCommand(command) },
                }, '⧉')))
            })(data.commands[i])
          }
        }
        return dialog([
          head('本会话命令块（共 ' + grandTotal + ' 条）'),
          h('div', { className: 'dsh_tm_histfilter' }, filterChildren),
          h('div', { className: 'dsh_tm_histcmdlist', ref: modalListRef }, listNodes),
          h('div', { className: 'dsh_tm_histdialogfoot' },
            h('button', {
              type: 'button', className: 'dsh_tm_histact',
              disabled: offset <= 0 || modal.status === 'loading',
              onClick: function (event) { event.stopPropagation(); commandModalPage(Math.max(0, offset - limit)) },
            }, '上一页'),
            h('span', { className: 'dsh_tm_histpage' }, '第 ' + pageNo + ' / ' + pageCount + ' 页'),
            h('button', {
              type: 'button', className: 'dsh_tm_histact',
              disabled: data === null || data === undefined || !data.hasMore || modal.status === 'loading',
              onClick: function (event) { event.stopPropagation(); commandModalPage(offset + limit) },
            }, '下一页'),
            h('span', { className: 'dsh_tm_histgrow' }),
            h('button', {
              type: 'button', className: 'dsh_tm_histact',
              onClick: function (event) { event.stopPropagation(); copyCommandPage() },
            }, '复制本页'),
            h('button', {
              type: 'button', className: 'dsh_tm_histact',
              onClick: function (event) { event.stopPropagation(); copyAllCommands() },
            }, '复制全部')),
        ])
      }

      /** 一条命中 → 两行按钮 + 选中后的动作条/详情。 */
      function renderRow(entry, index) {
        var row = entry.row
        var hit = entry.hit
        var side = sideLabelOf(hit)
        var snippet = typeof row.snippet === 'string' && row.snippet !== ''
          ? row.snippet
          : (hit !== null && typeof hit === 'object' && typeof hit.promptHead === 'string' ? hit.promptHead : '')
        // highlight 是相对 row.snippet 的偏移；退回 promptHead 时偏移不再成立。
        var snippetHighlight = snippet === row.snippet ? row.highlight : null
        var isSelected = index === selected
        var commandCount = commandCountOf(entry)
        return h('div', {
          key: 'row-' + index,
          className: isSelected ? 'dsh_tm_histrowwrap dsh_tm_histrowwrap_on' : 'dsh_tm_histrowwrap',
        },
          h('button', {
            type: 'button',
            className: isSelected ? 'dsh_tm_histrow dsh_tm_histrow_on' : 'dsh_tm_histrow',
            'data-hist-index': index,
            'aria-current': isSelected ? 'true' : undefined,
            title: entry.score !== '' ? entry.score : undefined,
            onClick: function () { selectHistoryRow(index) },
            onFocus: function () { selectHistoryRow(index) },
          },
            h('span', { className: 'dsh_tm_histrowhead' },
              side === '' ? null : h('span', {
                className: 'dsh_tm_histside',
                'data-side': hit !== null && typeof hit === 'object' && hit.matchedIn === 'response' ? 'response' : 'prompt',
              }, side),
              h('span', { className: 'dsh_tm_histname' }, row.title),
              row.turnLabel === '' ? null : h('span', { className: 'dsh_tm_histturn' }, row.turnLabel),
              commandCount !== null && commandCount > 0
                ? h('span', { className: 'dsh_tm_histcmd', title: '该轮包含 ' + commandCount + ' 条命令' }, '⌘ ' + commandCount)
                : null,
              h('span', { className: 'dsh_tm_histtime' }, row.timeLabel),
            ),
            h('span', { className: 'dsh_tm_histsnip' }, highlightNodes(snippet, snippetHighlight)),
            rowBadgeNodes(entry).length > 0
              ? h('span', { className: 'dsh_tm_histbadges' }, rowBadgeNodes(entry))
              : null,
          ),
          isSelected ? renderHistoryActions(entry) : null,
          isSelected ? renderHistoryDetail(entry) : null,
        )
      }

      // ── 正文 ────────────────────────────────────────────────────
      var bodyChildren = []
      if (result.status === 'idle') {
        // 断点续接是 P0 的下一段数据能力，C2 只保留占位文案，不发请求。
        bodyChildren.push(h('div', { className: 'dsh_tm_history_empty', key: 'idle' },
          h('div', null, '输入关键词开始检索'),
          h('div', { className: 'dsh_tm_histidle-sub' }, '断点续接（未完成 / 近期）尚未接入，先按关键词检索历史'),
          h('div', { className: 'dsh_tm_histidle-sub' }, '选中结果后可就地定位、看详情、复制、引用或标记'),
        ))
      } else {
        if (result.status === 'error') {
          bodyChildren.push(h('div', { className: 'dsh_tm_histerr', key: 'error' }, '检索失败：' + result.error))
        }
        if (rows.length > 0) {
          if (result.status === 'loading') {
            bodyChildren.push(h('div', { className: 'dsh_tm_histnote', key: 'busy' }, '检索中…'))
          }
          bodyChildren.push(h('div', { className: 'dsh_tm_histlist', key: 'list' }, rows.map(renderRow)))
        } else if (result.status === 'loading') {
          bodyChildren.push(h('div', { className: 'dsh_tm_history_empty', key: 'loading' }, '检索中…'))
        } else if (result.status === 'ready') {
          bodyChildren.push(h('div', { className: 'dsh_tm_history_empty', key: 'empty' },
            result.workspaceReason !== '' ? result.workspaceReason : '没有找到，试试更短的关键词或放宽时间'))
        } else if (result.status === 'error') {
          bodyChildren.push(h('div', { className: 'dsh_tm_histerrhint', key: 'errorhint' }, '检索失败，可修改关键词后重试'))
        }
      }

      // 底部状态条（ui.md §2.4）：条数 · 排序 · 耗时，截断与索引回退各一行。
      var footLines = []
      var hitCount = Array.isArray(result.hits) ? result.hits.length : 0
      if (result.status === 'ready') {
        footLines.push(h('div', { className: 'dsh_tm_histstats', key: 'stats' },
          hitCount + ' 条 · 相关度 · ' + Math.max(0, Math.round(Number(result.elapsedMs) || 0)) + 'ms'))
      }
      var total = Number(result.total)
      var hiddenCount = Number.isFinite(total) ? Math.max(0, total - hitCount) : 0
      if (result.truncated === true && hiddenCount > 0) {
        footLines.push(h('div', { className: 'dsh_tm_histmore', key: 'more' }, '还有 ' + hiddenCount + ' 条未显示'))
      }
      var scannedFromLog = result.coverage !== null && typeof result.coverage === 'object'
        ? Number(result.coverage.scannedFromLog) : NaN
      if (Number.isFinite(scannedFromLog) && scannedFromLog > 0) {
        footLines.push(h('div', { className: 'dsh_tm_histcoverage', key: 'coverage' },
          '正在为 ' + scannedFromLog + ' 个会话建立索引，本次检索已直接读取日志（稍慢）'))
      }

      return h('div', { className: 'dsh_tm_history' },
        h('div', { className: 'dsh_tm_histhead' },
          h('div', { className: 'dsh_tm_histtitle' }, HISTORY_TITLE),
          workspaceLabelOf(result) === ''
            ? null
            : h('span', {
                className: result.workspaceReason !== '' ? 'dsh_tm_histwswarn' : 'dsh_tm_histws',
                title: workspaceLabelOf(result),
              }, workspaceLabelOf(result)),
          h('span', {
            className: 'dsh_tm_histkey',
            title: '打开历史：Ctrl+Shift+H 或 Alt+H',
          }, 'Ctrl+Shift+H'),
          h('button', {
            type: 'button',
            className: 'dsh_tm_histpin',
            title: '钉住（即将支持）',
            'aria-label': '钉住（即将支持）',
            disabled: true,
          }, '📌'),
        ),
        h('div', { className: 'dsh_tm_histsearch' },
          h('input', {
            type: 'search',
            className: 'dsh_tm_history_search',
            placeholder: '搜对话…',
            'aria-label': '搜索历史对话',
            value: query,
            onChange: function (event) {
              var next = ''
              if (event !== null && event !== undefined && event.target !== null && event.target !== undefined) {
                next = event.target.value === null || event.target.value === undefined ? '' : String(event.target.value)
              }
              setQuery(next)
            },
            onKeyDown: handleSearchKeyDown,
          }),
        ),
        notice === null || notice === undefined
          ? null
          : h('div', {
              className: 'dsh_tm_histnotice',
              'data-tone': notice.tone,
              role: 'status',
            }, notice.text),
        h('div', { className: 'dsh_tm_histbody', ref: listRef }, bodyChildren),
        (footLines.length > 0 || (result.workspace !== null && result.workspace !== undefined && result.workspace.id !== null && result.workspace.id !== undefined))
          ? h('div', { className: 'dsh_tm_histfoot' },
              h('div', { className: 'dsh_tm_histfootrow' },
                h('div', { className: 'dsh_tm_histfootlines' }, footLines),
                result.workspace !== null && result.workspace !== undefined && result.workspace.id !== null && result.workspace.id !== undefined
                  ? h('button', {
                      type: 'button', className: 'dsh_tm_histreindex',
                      title: '为该工作区补齐索引',
                      onClick: function () { reindexWorkspace() },
                    }, '补齐索引')
                  : null))
          : null,
        typeof diagText === 'string' && diagText !== ''
          ? h('div', { className: 'dsh_tm_histdiag' }, '最近诊断：' + diagText)
          : null,
        renderHistoryModal(),
      )
    }

    /** 会话标题右侧的历史入口图标。 */
    function HistoryHeaderButton(props) {
      if (props === null || props === undefined || typeof props.open !== 'function') return null
      return h('button', {
        type: 'button',
        className: 'dsh_tm_histentry',
        title: '历史（Ctrl+Shift+H 或 Alt+H）',
        'aria-label': '打开历史右栏',
        onClick: function () { props.open() },
      }, '◷')
    }

    /**
     * 注册历史右栏的定义、正文和两个入口。
     *
     * `scope` 是 ctx.inject(['sidebarRightTabs','sidebarRight'], ...) 给的子
     * 作用域：服务缺失时整个回调不会执行，话题地图面板不受影响；服务在、
     * 但 API 形状不对时，下面每一段再单独降级，只丢历史栏。
     */
    function registerHistorySurface(scope) {
      var tabs = null
      var right = null
      try { tabs = scope.sidebarRightTabs } catch (error) { tabs = null }
      try { right = scope.sidebarRight } catch (error) { right = null }

      if (tabs === null || tabs === undefined || typeof tabs.register !== 'function') {
        historyDiag('sidebarRightTabs API 形状不对：历史右栏不注册')
        return
      }
      if (right === null || right === undefined || typeof right.openTab !== 'function') {
        historyDiag('sidebarRight API 形状不对：历史右栏不注册')
        return
      }

      // 第一段：tab 定义。register 返回 disposer；scope.effect 负责子作用域
      // 卸载/热重载时释放，避免重复注册报 "already registered"。
      try {
        scope.effect(function () {
          return tabs.register({
            id: HISTORY_ID,
            kind: HISTORY_KIND,
            keepMounted: true,
            title: function () { return HISTORY_TITLE },
            guide: [{
              id: 'history',
              order: 15,
              title: function () { return HISTORY_TITLE },
            }],
          })
        }, 'dsh-topic-map: 历史右栏 tab 类型')
      } catch (error) {
        historyDiag('注册历史右栏 tab 定义失败：' + errorText(error))
        return
      }

      // 第二段：正文。key 必须等于 definition.id；槽位声明在
      // rightbar.session 内部，用 slots.inject 等它出现。
      try {
        scope.slots.inject('sidebar.right.pane.tab', function () {
          return scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: HISTORY_ID,
          }, HistoryTabBody)
        })
      } catch (error) {
        historyDiag('注册历史右栏正文失败：' + errorText(error))
      }

      // 入口 C：会话标题右侧工具位（list 槽）。没有会话会话头时槽位
      // 不会声明，slots.inject 会一直等，不会报错。
      try {
        scope.slots.inject('conversation.session.header.utilities', function () {
          return scope.slots.register({
            name: 'conversation.session.header.utilities',
            id: HISTORY_ID,
            order: 30,
            label: function () { return HISTORY_TITLE },
            inject: function () {
              return { open: function () { openHistoryTab(scope) } }
            },
          }, HistoryHeaderButton)
        })
      } catch (error) {
        historyDiag('注册历史入口图标失败：' + errorText(error))
      }

      // 入口 A：Ctrl+Shift+H / Alt+H。窗口捕获阶段监听：
      // 宿主全局快捷键常在冒泡阶段 stopPropagation，捕获能先拿到事件；
      // 物理键用 e.code（键盘布局/输入法下 key 可能不是 'h'）。
      try {
        scope.effect(function () {
          var host = typeof window !== 'undefined' ? window : null
          if (host === null || typeof host.addEventListener !== 'function') return function () {}
          function onKey(event) {
            if (event === null || event === undefined) return
            if (event.ctrlKey !== true && event.altKey !== true) return
            if (event.metaKey === true) return
            var key = event.key === null || event.key === undefined ? '' : String(event.key)
            var isH = event.code === 'KeyH' || key.toLowerCase() === 'h'
            if (!isH) return
            var ctrlShift = event.ctrlKey === true && event.shiftKey === true && event.altKey !== true
            var altOnly = event.altKey === true && event.ctrlKey !== true && event.shiftKey !== true
            if (!ctrlShift && !altOnly) return
            try {
              if (typeof console !== 'undefined' && console !== null && typeof console.debug === 'function') {
                console.debug('[dsh-topic-map] 历史快捷键命中', event.code)
              }
            } catch (error) { /* 控制台不可用忽略 */ }
            // 命中即吃掉这个组合键：它是本插件的保留快捷键，不能让宿主
            // 再把它当别的命令处理；打开失败的原因由 openHistoryTab 记诊断。
            openHistoryTab(scope)
            event.preventDefault()
            event.stopPropagation()
          }
          host.addEventListener('keydown', onKey, true)
          return function () { host.removeEventListener('keydown', onKey, true) }
        }, 'dsh-topic-map: 历史右栏快捷键')
      } catch (error) {
        historyDiag('注册历史快捷键失败：' + errorText(error))
      }
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
    // 只列核心服务。sidebarRightTabs / sidebarRight 是可选能力：
    // 在 apply 里用 ctx.inject([...]) 开一个子作用域，服务齐了才挂历史右栏。
    // 不能写进这个数组——那是硬依赖，缺服务会连话题地图面板一起不加载。
    var inject = ['slots', 'sessions', 'locale', 'uiConversation']
    var SESSION_SERVICE = null
    var CONVERSATION_SERVICE = null
    // uiWorkspace 只在跨会话定位时用；用 ctx.get 可选读取，不写进 inject，
    // 免得一个额外的硬依赖把整个插件拖下水。
    var UI_WORKSPACE_SERVICE = null

    function apply(ctx) {
      injectCss()
      // 统一归一成 null：宿主缺某个可选服务时拿到的是 undefined，
      // 而下面的判断写成 `=== null` 就会漏判，最后抛出的是一句
      // "Cannot read properties of undefined" 这种没法排查的错误。
      SESSION_SERVICE = ctx.sessions ?? null
      CONVERSATION_SERVICE = ctx.uiConversation ?? null
      try {
        UI_WORKSPACE_SERVICE = typeof ctx.get === 'function' ? (ctx.get('uiWorkspace') || null) : null
      } catch (error) {
        UI_WORKSPACE_SERVICE = null
      }
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

      // 历史右栏与两个入口（C2：查询列表）。可选注入：这两个服务是右栏客户端
      // 包提供的增量能力，缺任何一个时只少历史栏，话题地图照常工作。
      // 子作用域里的 effect / slots 注册会随服务消失一起释放。
      try {
        ctx.inject(['sidebarRightTabs', 'sidebarRight'], function (scope) {
          try {
            registerHistorySurface(scope)
          } catch (error) {
            historyDiag('注册历史右栏失败：' + errorText(error))
          }
        })
      } catch (error) {
        // ctx.inject 本身不可用（极端宿主版本）时也不能影响话题地图
        historyDiag('注册历史右栏作用域失败：' + errorText(error))
      }
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
