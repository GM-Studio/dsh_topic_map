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
      '.dsh_tm_semapply{border:0;border-radius:6px;padding:3px 12px;background:var(--tm-accent);color:#fff;font:inherit;font-size:11px;cursor:pointer}',
      '.dsh_tm_semapply:hover{filter:brightness(1.08)}',
      '.dsh_tm_diagclose{margin-left:auto;border:0;background:transparent;color:var(--tm-text3);cursor:pointer;font:inherit;font-size:11px;padding:2px 6px;border-radius:5px}',
      '.dsh_tm_diagclose:hover{background:var(--tm-hover);color:var(--tm-text)}',
      // ── 历史右栏（C2：查询列表）──────────────────────────────────
      //
      // 字号只用 12/13/14 三档（ui.md §8）。颜色全部走现有主题令牌，
      // 不新增色板；右栏可能先于话题地图面板打开，所以组件挂载时会把
      // data-tm-theme 写到根节点（与面板同一套解析逻辑），否则这些
      // var(--tm-*) 会解析为空。
      '.dsh_tm_history{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;background:var(--tm-bg);color:var(--tm-text);font-size:13px;overflow:hidden}',
      '.dsh_tm_histhead{flex:none;display:flex;align-items:center;gap:8px;padding:10px 12px 8px;min-width:0}',
      '.dsh_tm_histtitle{flex:auto;display:flex;align-items:baseline;min-width:0;font-size:14px;font-weight:600;letter-spacing:.2px;overflow:hidden;white-space:nowrap}',
      '.dsh_tm_histtitlemain{flex:0 0 auto;white-space:nowrap}',
      '.dsh_tm_histtitlews{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text3);font-weight:400}',
      // 极小快捷键提示：入口自身要把"怎么打开"说清楚。
      '.dsh_tm_histkey{flex:none;font-size:11px;line-height:16px;color:var(--tm-text3);opacity:.8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}',
      '.dsh_tm_histcmd{flex:none;font-size:12px;line-height:16px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      // 图钉在 C2 仍是占位：明确置灰，避免用户点了以为坏了。
      '.dsh_tm_histpin{flex:none;width:24px;height:24px;display:grid;place-items:center;padding:0;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--tm-text3);font:inherit;font-size:12px;line-height:1;opacity:.5;cursor:default}',
      '.dsh_tm_histsearch{flex:none;padding:0 12px 10px}',
      '.dsh_tm_history_search{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:16px;padding:6px 9px;border-radius:7px;border:1px solid var(--tm-border);background:var(--tm-surface);color:var(--tm-text);outline:none}',
      '.dsh_tm_history_search:focus{border-color:var(--tm-accent);box-shadow:0 0 0 2px var(--tm-accent-soft)}',
      '.dsh_tm_history_search::placeholder{color:var(--tm-text3)}',
      '.dsh_tm_histbody{flex:1 1 auto;min-height:0;overflow-y:auto}',
      '.dsh_tm_history_empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;height:100%;min-height:120px;padding:24px 16px;color:var(--tm-text3);font-size:12px;line-height:18px;text-align:center}',
      '.dsh_tm_histidle-sub{font-size:12px;line-height:17px;color:var(--tm-text3)}',
      // 列表：两行 56px；第一行 12px 次要色，第二行 13px 正文（ui.md §2.2/§8）。
      '.dsh_tm_histlist{display:flex;flex-direction:column;padding:4px 8px 6px}',
      '.dsh_tm_histskel{height:56px;margin:2px 0;border-radius:8px;background:linear-gradient(90deg,var(--tm-surface2) 25%,var(--tm-hover) 37%,var(--tm-surface2) 63%);background-size:400% 100%;animation:dsh_tm_histshimmer 1.2s ease-in-out infinite}',
      '@keyframes dsh_tm_histshimmer{0%{background-position:100% 0}100%{background-position:0 0}}',
      '.dsh_tm_histrow{display:flex;flex-direction:column;gap:3px;width:100%;min-height:56px;box-sizing:border-box;padding:7px 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--tm-text);font:inherit;font-size:13px;text-align:left;cursor:pointer}',
      '.dsh_tm_histrow:hover{background:var(--tm-hover)}',
      // 键盘选中行：背景 + 边框一起给，深浅主题下都看得见。
      '.dsh_tm_histrow_on{background:var(--tm-accent-soft);border-color:var(--tm-accent)}',
      '.dsh_tm_histrow[data-current="1"]{box-shadow:inset 2px 0 0 var(--tm-accent)}',
      '.dsh_tm_histrow_selected{background:var(--tm-accent-soft);box-shadow:inset 3px 0 0 var(--tm-accent)}',
      '.dsh_tm_histrow_selected:hover{background:var(--tm-accent-soft)}',
      '.dsh_tm_histdcurrent{margin-left:6px;padding:0 5px;border-radius:4px;background:var(--tm-accent-soft);color:var(--tm-accent);font-size:10px;font-weight:600;line-height:15px}',
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
      '.dsh_tm_histfoot{position:sticky;bottom:0;z-index:3;flex:0 0 auto;display:flex;flex-direction:column;gap:2px;padding:7px 12px 9px;border-top:1px solid var(--tm-border);background:var(--tm-surface);font-size:12px;line-height:17px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
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
      // 动作区：元信息行 / 主次动作行 / ⋯ 菜单。高度统一 24px，圆角 6px。
      '.dsh_tm_histactions{display:flex;flex-direction:column;gap:6px;padding:4px 8px 7px;min-width:0}',
      '.dsh_tm_histmeta{display:flex;align-items:center;flex-wrap:wrap;font-size:12px;line-height:16px;color:var(--tm-text3);min-width:0}',
      '.dsh_tm_histmetastatus{color:var(--tm-text3)}',
      '.dsh_tm_histmetastatus_err{color:var(--tm-err)}',
      '.dsh_tm_histactionrow{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;min-width:0}',
      '.dsh_tm_histbtn{flex:0 0 auto;box-sizing:border-box;height:24px;min-width:max-content;display:inline-flex;align-items:center;justify-content:center;gap:4px;padding:0 10px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface);color:var(--tm-text2);font:inherit;font-size:12px;line-height:16px;white-space:nowrap;cursor:pointer}',
      '.dsh_tm_histbtn:hover{border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_histbtn_primary{border-color:var(--tm-accent);background:var(--tm-accent);color:#fff}',
      '.dsh_tm_histbtn_primary:hover{filter:brightness(1.06);color:#fff}',
      '.dsh_tm_histbtn_outline{background:var(--tm-surface)}',
      '.dsh_tm_histbtn_on{border-color:var(--tm-accent);background:var(--tm-accent-soft);color:var(--tm-accent)}',
      '.dsh_tm_histbtn_icon{width:24px;padding:0;margin-left:auto;border-color:transparent;background:transparent;color:var(--tm-text3)}',
      '.dsh_tm_histbtn_icon:hover{background:var(--tm-hover);border-color:var(--tm-border);color:var(--tm-text)}',
      '.dsh_tm_histbtnicon{flex:none;font-size:13px;line-height:1}',
      '.dsh_tm_histbtnlabel{flex:none;min-width:max-content;white-space:nowrap;overflow:visible;text-overflow:clip}',
      '.dsh_tm_histactionrow[data-icon-only="1"] .dsh_tm_histbtnlabel{display:none}',
      '.dsh_tm_histactionrow[data-icon-only="1"] .dsh_tm_histbtn{width:24px;min-width:24px;padding:0;gap:0}',
      '.dsh_tm_histmenu{display:flex;flex-direction:column;min-width:0;padding:4px;border:1px solid var(--tm-border);border-radius:8px;background:var(--tm-surface);box-shadow:var(--tm-shadow)}',
      '.dsh_tm_histmenuitem{box-sizing:border-box;width:100%;height:28px;display:flex;align-items:center;gap:6px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:var(--tm-text2);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer}',
      '.dsh_tm_histmenuitem:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_histmenuitem_on{color:var(--tm-accent)}',
      '.dsh_tm_histmenuitem_disabled{opacity:.45;cursor:not-allowed}',
      '.dsh_tm_histmenuitem_disabled:hover{background:transparent;color:var(--tm-text2)}',
      '.dsh_tm_histmenuicon{flex:none;width:16px;text-align:center;color:var(--tm-text3)}',
      '.dsh_tm_histmenutext{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_histmenusep{height:1px;margin:4px 2px;background:var(--tm-border)}',
      '.dsh_tm_histmenugroup{display:flex;flex-direction:column;gap:1px}',
      '.dsh_tm_histmenugrouplabel{display:flex;align-items:center;gap:6px;padding:4px 8px 2px;font-size:11px;line-height:15px;color:var(--tm-text3)}',
      // 只有动作条真实宽度 < 220px 才降级为纯图标；由 HistoryActionBar 的
      // ResizeObserver 在阈值处切 data-icon-only，不做逐帧抖动。
      '.dsh_tm_histact{font:inherit;font-size:12px;line-height:17px;padding:3px 9px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface);color:var(--tm-text2);cursor:pointer;white-space:nowrap}',
      '.dsh_tm_histact:hover{border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_histact_on{border-color:var(--tm-accent);background:var(--tm-accent-soft);color:var(--tm-accent)}',
      '.dsh_tm_histdetail{margin:0 8px 8px;padding:8px 10px;border:1px solid var(--tm-border);border-radius:8px;background:var(--tm-surface2);color:var(--tm-text2);font-size:12px;line-height:17px;overflow-wrap:anywhere}',
      '.dsh_tm_histdsec{padding:3px 0}',
      '.dsh_tm_histdsec b{display:block;font-size:12px;color:var(--tm-text3);font-weight:600;margin-bottom:2px}',
      '.dsh_tm_histdtext{white-space:pre-wrap}',
      '.dsh_tm_histdmeta{margin-top:5px;padding-top:5px;border-top:1px solid var(--tm-border);color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_histdfiles,.dsh_tm_histdneighbors{margin:0;padding-left:16px}',
      '.dsh_tm_histdact{display:flex;gap:6px;padding-top:6px}',
      '.dsh_tm_histnotice{margin:0 12px 8px;padding:5px 8px;border-radius:6px;background:var(--tm-surface2);color:var(--tm-text2);font-size:12px;line-height:17px;overflow-wrap:anywhere;display:flex;align-items:center;gap:8px}',
      '.dsh_tm_histnoticetext{flex:1 1 auto;min-width:0}',
      '.dsh_tm_histnoticeact{flex:none;height:20px;padding:0 6px;border:1px solid currentColor;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:11px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_histnoticeact:hover{background:var(--tm-hover)}',
      '.dsh_tm_histnotice[data-tone="ok"]{color:var(--tm-ok)}',
      '.dsh_tm_histnotice[data-tone="error"]{color:var(--tm-err);background:color-mix(in srgb, var(--tm-err) 10%, transparent)}',
      '.dsh_tm_histconfirm{left:50%;right:auto;top:50%;width:min(360px,calc(100vw - 32px));height:auto;max-height:none;transform:translate(-50%,-50%)}',
      '.dsh_tm_histconfirmtext{padding:16px 14px;font-size:13px;line-height:20px;color:var(--tm-text)}',
      '.dsh_tm_histconfirmactions{display:flex;justify-content:flex-end;gap:8px;padding:0 14px 14px}',
      // 右栏三个 tab 的共用切换条：注册是三个 kind，条本身只是导航入口。
      '.dsh_tm_righttabs{flex:none;display:flex;align-items:center;gap:2px;padding:6px 12px 0}',
      '.dsh_tm_righttab{height:24px;padding:0 9px;border:0;border-radius:6px;background:transparent;color:var(--tm-text3);font:inherit;font-size:12px;line-height:24px;cursor:pointer}',
      '.dsh_tm_righttab:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_righttab_on{background:var(--tm-accent-soft);color:var(--tm-accent);font-weight:600}',
      // ── 统计 tab ──
      '.dsh_tm_stats,.dsh_tm_settings{display:flex;flex-direction:column;min-height:0;height:100%;color:var(--tm-text)}',
      '.dsh_tm_statshead,.dsh_tm_sethead{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px 6px;min-width:0}',
      '.dsh_tm_statstitle,.dsh_tm_settitle{font-size:13px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_statsws{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_statsrefresh{flex:none;margin-left:auto;width:24px;height:24px;display:grid;place-items:center;padding:0;border:1px solid var(--tm-border);border-radius:6px;background:transparent;color:var(--tm-text3);font:inherit;font-size:13px;cursor:pointer}',
      '.dsh_tm_statsrefresh:hover{color:var(--tm-accent);border-color:var(--tm-accent)}',
      '.dsh_tm_statsrefresh:disabled{opacity:.45;cursor:default}',
      '.dsh_tm_statsbody,.dsh_tm_setbody{flex:1 1 auto;min-height:0;overflow:auto;padding:0 12px 12px}',
      '.dsh_tm_statshero{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-bottom:12px}',
      '.dsh_tm_statscard{min-width:0;padding:8px 9px;border:1px solid var(--tm-border);border-radius:8px;background:var(--tm-surface2)}',
      '.dsh_tm_statscardlabel{font-size:11px;line-height:15px;color:var(--tm-text3)}',
      '.dsh_tm_statscardvalue{margin-top:2px;font-size:18px;line-height:24px;font-weight:600;color:var(--tm-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_statscardhint{margin-top:1px;font-size:10.5px;line-height:14px;color:var(--tm-text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_statssectiontitle{margin:2px 0 6px;font-size:12px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_statssectionhead{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dsh_tm_statssectionhead .dsh_tm_statssectiontitle{margin-bottom:6px;flex:1 1 auto;min-width:0}',
      '.dsh_tm_statssort{flex:none;display:inline-flex;align-items:center;gap:1px;padding:1px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface2)}',
      '.dsh_tm_statssortbtn{height:20px;padding:0 7px;border:0;border-radius:4px;background:transparent;color:var(--tm-text3);font:inherit;font-size:11px;line-height:20px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_statssortbtn:hover:not(:disabled){color:var(--tm-text)}',
      '.dsh_tm_statssortbtn_on{background:var(--tm-surface);color:var(--tm-accent);font-weight:600;box-shadow:0 1px 2px #0001}',
      '.dsh_tm_statssortbtn:disabled{opacity:.42;cursor:not-allowed}',
      '.dsh_tm_statsusage{margin-bottom:12px}',
      '.dsh_tm_statsusagebar{height:8px;border-radius:4px;background:var(--tm-surface3,var(--tm-surface2));overflow:hidden}',
      '.dsh_tm_statsusagefill{height:100%;border-radius:4px;background:var(--tm-accent);opacity:.75}',
      '.dsh_tm_statsusagelegend{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:5px;font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_statsusageinput{color:var(--tm-text2)}',
      '.dsh_tm_statsusageoutput{color:var(--tm-accent)}',
      '.dsh_tm_statslistwrap{margin-bottom:8px}',
      '.dsh_tm_statslist{display:flex;flex-direction:column;gap:7px}',
      '.dsh_tm_statsrowhead{display:flex;align-items:baseline;gap:7px;min-width:0;font-size:12px}',
      '.dsh_tm_statsrowtitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text)}',
      '.dsh_tm_statsrowturns{flex:none;color:var(--tm-text2);font-variant-numeric:tabular-nums}',
      '.dsh_tm_statsrowtime{flex:none;font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_statsbarbg{margin-top:4px;height:4px;border-radius:2px;background:var(--tm-surface2);overflow:hidden}',
      '.dsh_tm_statsbar{height:100%;border-radius:2px;background:var(--tm-accent);opacity:.7}',
      '.dsh_tm_statsempty{padding:26px 12px;text-align:center;font-size:12px;color:var(--tm-text3)}',
      '.dsh_tm_statsrowsempty{padding:8px 0;font-size:12px;color:var(--tm-text3)}',
      '.dsh_tm_statserr{margin:10px 0;padding:10px 12px;border:1px solid color-mix(in srgb,var(--tm-err) 35%,transparent);border-radius:8px;background:color-mix(in srgb,var(--tm-err) 8%,transparent);font-size:12px;line-height:18px;color:var(--tm-err)}',
      '.dsh_tm_statsretry{margin-top:8px;height:24px;padding:0 10px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_statsretry:hover{background:var(--tm-hover)}',
      // ── 设置 tab ──
      '.dsh_tm_setgroup{display:flex;flex-direction:column;gap:7px;padding:11px 0;border-bottom:1px solid var(--tm-border)}',
      '.dsh_tm_setgroup:first-child{padding-top:2px}',
      '.dsh_tm_setgrouptitle{font-size:12px;font-weight:600;color:var(--tm-text);margin-bottom:1px}',
      '.dsh_tm_setnote{font-size:11px;line-height:16px;color:var(--tm-text3)}',
      '.dsh_tm_setrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:18px;color:var(--tm-text2);cursor:default}',
      'label.dsh_tm_setrow{cursor:pointer}',
      '.dsh_tm_setlabel{flex:0 0 auto;min-width:92px;color:var(--tm-text2)}',
      '.dsh_tm_sethelp{flex:1 1 100%;font-size:11px;line-height:15px;color:var(--tm-text3)}',
      '.dsh_tm_setinput{width:88px;box-sizing:border-box;font:inherit;font-size:12px;line-height:17px;padding:3px 7px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface);color:var(--tm-text);outline:none}',
      '.dsh_tm_setinput:focus{border-color:var(--tm-accent)}',
      '.dsh_tm_setrange{flex:1 1 110px;min-width:80px;accent-color:var(--tm-accent)}',
      '.dsh_tm_setseg{display:flex;align-items:center;gap:1px;padding:1px;border:1px solid var(--tm-border);border-radius:7px;background:var(--tm-surface2)}',
      '.dsh_tm_setsegbtn{height:22px;padding:0 7px;border:0;border-radius:5px;background:transparent;color:var(--tm-text3);font:inherit;font-size:11px;line-height:22px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_setsegbtn:hover{color:var(--tm-text)}',
      '.dsh_tm_setsegbtn_on{background:var(--tm-surface);color:var(--tm-accent);font-weight:600;box-shadow:0 1px 2px #0001}',
      '.dsh_tm_setreadonly{color:var(--tm-text);font-variant-numeric:tabular-nums}',
      '.dsh_tm_setseg{display:inline-flex;align-items:center;gap:1px;padding:1px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface2)}',
      '.dsh_tm_setsegbtn{height:20px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:var(--tm-text3);font:inherit;font-size:11px;line-height:20px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_setsegbtn:hover{color:var(--tm-text)}',
      '.dsh_tm_setsegbtn_on{background:var(--tm-surface);color:var(--tm-accent);font-weight:600;box-shadow:0 1px 2px #0001}',
      '.dsh_tm_seterr{flex:1 1 100%;font-size:11px;line-height:15px;color:var(--tm-err)}',
      '.dsh_tm_setstatus{font-size:11px;line-height:16px;color:var(--tm-text3)}',      '.dsh_tm_setstatus[data-tone="ok"]{color:var(--tm-ok)}',
      '.dsh_tm_setstatus[data-tone="error"]{color:var(--tm-err)}',
      '.dsh_tm_setindexrow{gap:8px}',
      '.dsh_tm_setindextext{min-width:0;flex:1 1 auto;font-size:11px;line-height:16px;color:var(--tm-text3);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
      '.dsh_tm_setindextext[data-tone="error"]{color:var(--tm-err)}',
      '.dsh_tm_setbutton{height:26px;padding:0 10px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface2);color:var(--tm-text);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_setbutton:hover:not(:disabled){border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_setbutton:disabled{opacity:.5;cursor:default}',
      '.dsh_tm_setactions{position:sticky;bottom:0;display:flex;align-items:center;gap:8px;padding:10px 0 2px;background:var(--tm-surface)}',
      '.dsh_tm_setsave{height:28px;padding:0 16px;border:0;border-radius:6px;background:var(--tm-accent);color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer}',
      '.dsh_tm_setsave:disabled{opacity:.5;cursor:default}',
      '.dsh_tm_setdefault{height:28px;padding:0 12px;border:1px solid var(--tm-border);border-radius:6px;background:transparent;color:var(--tm-text2);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_setdefault:hover:not(:disabled){border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_setdefault:disabled{opacity:.5;cursor:default}',
      '.dsh_tm_setnotice{margin:0 12px 8px;padding:6px 9px;border-radius:6px;background:var(--tm-surface2);color:var(--tm-text2);font-size:12px;line-height:17px;overflow-wrap:anywhere}',
      '.dsh_tm_setnotice[data-tone="ok"]{color:var(--tm-ok)}',
      '.dsh_tm_setnotice[data-tone="error"]{color:var(--tm-err);background:color-mix(in srgb,var(--tm-err) 10%,transparent)}',
      // ── 分类 tab ──
      '.dsh_tm_cat,.dsh_tm_clue{display:flex;flex-direction:column;min-height:0;height:100%;color:var(--tm-text)}',
      '.dsh_tm_cathead,.dsh_tm_cluehead{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px 6px;min-width:0}',
      '.dsh_tm_cattitle,.dsh_tm_cluetitle{flex:none;font-size:13px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_catws{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_catnew{flex:none;height:24px;padding:0 9px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface);color:var(--tm-text2);font:inherit;font-size:12px;line-height:22px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_catnew:hover{border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_catnew:disabled{opacity:.5;cursor:default}',
      '.dsh_tm_catrefresh{flex:none;width:24px;height:24px;display:grid;place-items:center;padding:0;border:1px solid var(--tm-border);border-radius:6px;background:transparent;color:var(--tm-text3);font:inherit;font-size:13px;cursor:pointer}',
      '.dsh_tm_catrefresh:hover{color:var(--tm-accent);border-color:var(--tm-accent)}',
      '.dsh_tm_catrefresh:disabled{opacity:.45;cursor:default}',
      '.dsh_tm_catbody{flex:1 1 auto;min-height:0;display:flex;border-top:1px solid var(--tm-border)}',
      '.dsh_tm_cattree{flex:0 0 44%;min-width:96px;max-width:196px;display:flex;flex-direction:column;min-height:0;overflow:auto;padding:6px 4px;border-right:1px solid var(--tm-border)}',
      '.dsh_tm_cattreetitle{flex:none;padding:0 6px 5px;font-size:11px;line-height:15px;color:var(--tm-text3)}',
      '.dsh_tm_catnodes{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.dsh_tm_catmenuitem_off{opacity:.45;cursor:not-allowed}',
      '.dsh_tm_catmenuitem_off:hover{background:transparent;color:var(--tm-text2)}',
      // ── 历史页：左分类树 + 右结果区 ──
      '.dsh_tm_histmain{flex:1 1 auto;min-height:0;display:flex;min-width:0}',
      '.dsh_tm_histside{flex:none;width:164px;min-width:132px;max-width:210px;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--tm-border);overflow:hidden}',
      '.dsh_tm_histpane{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column}',
      '.dsh_tm_histbar{flex:none;display:flex;align-items:flex-start;gap:6px;padding:0 10px 6px;min-width:0}',
      '.dsh_tm_histsearchwrap{flex:1 1 auto;min-width:0;position:relative}',
      '.dsh_tm_histsearch{position:relative;display:flex;align-items:center;min-width:0;padding:0}',
      '.dsh_tm_histsearchicon{position:absolute;left:7px;font-size:11px;opacity:.55;pointer-events:none}',
      '.dsh_tm_history_search{padding-left:24px;padding-right:22px}',
      '.dsh_tm_histspin{position:absolute;right:6px;top:50%;margin-top:-8px;font-size:12px;line-height:16px;color:var(--tm-accent);animation:dsh_tm_spin .9s linear infinite;pointer-events:none}',
      '@keyframes dsh_tm_spin{to{transform:rotate(360deg)}}',
      '.dsh_tm_histprefixlist{position:absolute;left:0;right:0;top:100%;z-index:20;margin-top:2px;display:flex;flex-direction:column;padding:3px;border:1px solid var(--tm-border-strong);border-radius:7px;background:var(--tm-surface);box-shadow:var(--tm-shadow)}',
      '.dsh_tm_histprefixitem{display:flex;align-items:baseline;gap:7px;min-width:0;padding:4px 7px;border:0;border-radius:5px;background:transparent;color:var(--tm-text2);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.dsh_tm_histprefixitem:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_histprefixname{flex:none;color:var(--tm-text)}',
      '.dsh_tm_histprefixpath{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_histprefixempty{position:absolute;left:0;right:0;top:100%;z-index:20;margin-top:2px;padding:6px 8px;border:1px solid var(--tm-border);border-radius:7px;background:var(--tm-surface);font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_histviewtabs{flex:none;display:flex;align-items:center;gap:1px;padding:1px;border:1px solid var(--tm-border);border-radius:7px;background:var(--tm-surface2)}',
      '.dsh_tm_histviewtab{height:22px;padding:0 7px;border:0;border-radius:5px;background:transparent;color:var(--tm-text3);font:inherit;font-size:11px;line-height:22px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_histviewtab:hover{color:var(--tm-text)}',
      '.dsh_tm_histviewtab_on{background:var(--tm-surface);color:var(--tm-accent);font-weight:600;box-shadow:0 1px 2px #0001}',
      '.dsh_tm_histcatpanel{display:flex;flex-direction:column;min-height:0;height:100%}',
      '.dsh_tm_histcathead{flex:none;display:flex;align-items:baseline;gap:5px;padding:4px 8px 5px}',
      '.dsh_tm_histcattitle{font-size:11.5px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_histcatcount{margin-left:auto;font-size:10.5px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_histcatauto{flex:none;height:20px;padding:0 5px;border:1px solid var(--tm-border);border-radius:4px;background:var(--tm-surface2);color:var(--tm-text2);font:inherit;font-size:10.5px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_histcatauto:hover:not(:disabled){border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_histcatauto:disabled{opacity:.45;cursor:default}',
      '.dsh_tm_histcatundo{flex:none;height:22px;padding:0 6px;border:0;border-radius:4px;background:var(--tm-accent-soft);color:var(--tm-accent);font:inherit;font-size:10.5px;cursor:pointer}',
      '.dsh_tm_catsuggest{left:50%;right:auto;top:50%;width:min(520px,calc(100vw - 32px));height:min(520px,calc(100vh - 48px));max-height:min(520px,calc(100vh - 48px));transform:translate(-50%,-50%)}',
      '.dsh_tm_catsuggestlist{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 10px}',
      '.dsh_tm_catsuggestrow{display:flex;align-items:baseline;gap:8px;padding:5px 4px;border-bottom:1px solid var(--tm-border);font-size:12px;color:var(--tm-text2);cursor:pointer}',
      '.dsh_tm_catsuggestrow:hover{background:var(--tm-hover)}',
      '.dsh_tm_catsuggestname{flex:1 1 60%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text)}',
      '.dsh_tm_catsuggestpath{flex:1 1 40%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-accent)}',
      '.dsh_tm_catsuggestconf{flex:none;font-size:11px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_catsuggestempty{padding:20px 14px;text-align:center;font-size:12px;color:var(--tm-text3)}',
      '.dsh_tm_catsuggesterror{margin:0 12px 6px;padding:5px 8px;border-radius:5px;background:color-mix(in srgb,var(--tm-err) 10%,transparent);color:var(--tm-err);font-size:12px;line-height:17px;overflow-wrap:anywhere}',
      '.dsh_tm_catsuggestprogress{padding:4px 12px;font-size:11.5px;line-height:17px;color:var(--tm-accent)}',
      '.dsh_tm_catsuggestfoot{flex:none;display:flex;justify-content:flex-end;gap:8px;padding:8px 12px 10px;border-top:1px solid var(--tm-border)}',
      '.dsh_tm_catdialogcancel{height:26px;padding:0 12px;border:1px solid var(--tm-border);border-radius:6px;background:transparent;color:var(--tm-text2);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_catdialogcancel:hover:not(:disabled){border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_catdialogcancel:disabled{opacity:.5;cursor:default}',
      '.dsh_tm_histcattree{flex:1 1 auto;min-height:0;overflow:auto;padding:0 4px 4px;display:flex;flex-direction:column;gap:1px}',
      '.dsh_tm_histcatempty{padding:10px 8px;font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_histcaterr{padding:6px 8px;font-size:11px;line-height:15px;color:var(--tm-err);overflow-wrap:anywhere}',
      '.dsh_tm_histcatretry{margin-top:4px;height:20px;padding:0 6px;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer}',
      '.dsh_tm_histcatnotice{margin:0 6px 4px}',
      '.dsh_tm_histcatfoot{flex:none;display:flex;align-items:center;gap:4px;padding:5px 6px;border-top:1px solid var(--tm-border)}',
      '.dsh_tm_histcatnew{flex:1 1 auto;min-width:0;height:24px;padding:0 6px;border:1px solid var(--tm-border);border-radius:5px;background:var(--tm-surface2);color:var(--tm-text2);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh_tm_histcatnew:hover:not(:disabled){border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_histcatnew:disabled{opacity:.5;cursor:default}',
      '.dsh_tm_histcatrefresh{flex:none;width:24px;height:24px;display:grid;place-items:center;padding:0;border:1px solid var(--tm-border);border-radius:5px;background:var(--tm-surface2);color:var(--tm-text3);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_histcatrefresh:hover:not(:disabled){color:var(--tm-accent);border-color:var(--tm-accent)}',
      '.dsh_tm_histcatrefresh:disabled{opacity:.45;cursor:default}',
      '.dsh_tm_catfoldbtn{flex:none;width:16px;height:24px;display:grid;place-items:center;padding:0;border:0;border-radius:4px;background:transparent;color:var(--tm-text3);font:inherit;font-size:9px;cursor:pointer}',
      '.dsh_tm_catfoldbtn:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_catfoldspace{flex:none;width:16px}',
      '.dsh_tm_catfixed .dsh_tm_catnode{font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_catnode[data-depth="1"]{padding-left:11px}',
      '.dsh_tm_catnode[data-depth="2"]{padding-left:17px}',
      '.dsh_tm_catchildren{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.dsh_tm_histcatlist{display:flex;flex-direction:column;gap:4px}',
      '.dsh_tm_histcatsession{display:flex;align-items:baseline;gap:8px;min-width:0;padding:6px 8px;border:1px solid var(--tm-border);border-radius:6px;background:transparent;color:var(--tm-text2);font:inherit;text-align:left;cursor:pointer}',
      '.dsh_tm_histcatsession:hover{background:var(--tm-hover);border-color:var(--tm-border-strong);color:var(--tm-text)}',
      '.dsh_tm_histcatsessiontitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--tm-text)}',
      '.dsh_tm_histcatsessionmeta{flex:none;font-size:10.5px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_histretry{margin-top:6px;height:24px;padding:0 10px;border:1px solid currentColor;border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_histretry:hover{background:var(--tm-hover)}',
      '.dsh_tm_histtimeline{display:flex;flex-direction:column;gap:4px}',
      '.dsh_tm_histtimelinewrap{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dsh_tm_catnoderow{display:flex;align-items:center;gap:1px;min-width:0;border-radius:6px}',
      '.dsh_tm_catnoderow:hover{background:var(--tm-hover)}',
      '.dsh_tm_catnode{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:5px;height:26px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--tm-text2);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.dsh_tm_catnode:hover{color:var(--tm-text)}',
      '.dsh_tm_catnode_on{background:var(--tm-accent-soft);color:var(--tm-accent);font-weight:600}',
      '.dsh_tm_catnode_on:hover{color:var(--tm-accent)}',
      '.dsh_tm_catnodename{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_catnodecount{flex:none;font-size:11px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_catnode_on .dsh_tm_catnodecount{color:var(--tm-accent)}',
      '.dsh_tm_catnodmore{flex:none;width:20px;height:20px;display:grid;place-items:center;padding:0;border:0;border-radius:5px;background:transparent;color:var(--tm-text3);font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.55}',
      '.dsh_tm_catnodmore:hover{background:var(--tm-accent-soft);color:var(--tm-accent);opacity:1}',
      '.dsh_tm_catchildren{padding-left:10px;min-width:0}',
      '.dsh_tm_catmenu{display:flex;flex-direction:column;margin:2px 0 4px 4px;padding:3px;border:1px solid var(--tm-border);border-radius:7px;background:var(--tm-surface);box-shadow:var(--tm-shadow)}',
      '.dsh_tm_catmenuitem{box-sizing:border-box;width:100%;height:26px;display:flex;align-items:center;padding:0 8px;border:0;border-radius:5px;background:transparent;color:var(--tm-text2);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer}',
      '.dsh_tm_catmenuitem:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_catlist{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:auto;padding:6px 6px}',
      '.dsh_tm_catlisthead{flex:none;display:flex;align-items:baseline;gap:6px;padding:1px 4px 6px;min-width:0;font-size:12px;line-height:16px;color:var(--tm-text3)}',
      '.dsh_tm_catlistname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_catlistcount{flex:none;margin-left:auto;font-variant-numeric:tabular-nums}',
      '.dsh_tm_catrowwrap{border-bottom:1px solid var(--tm-border)}',
      '.dsh_tm_catrow{display:flex;align-items:center;gap:1px;min-width:0}',
      '.dsh_tm_catrowmain{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;padding:6px;border:0;border-radius:7px;background:transparent;color:var(--tm-text);font:inherit;text-align:left;cursor:pointer}',
      '.dsh_tm_catrowmain:hover{background:var(--tm-hover)}',
      '.dsh_tm_catrowtitle{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:16px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_catrowmeta{font-size:11px;line-height:15px;color:var(--tm-text3);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_catrowmore{flex:none;width:22px;height:22px;display:grid;place-items:center;padding:0;border:0;border-radius:5px;background:transparent;color:var(--tm-text3);font:inherit;font-size:12px;line-height:1;cursor:pointer;opacity:.55}',
      '.dsh_tm_catrowmore:hover{background:var(--tm-accent-soft);color:var(--tm-accent);opacity:1}',
      '.dsh_tm_catempty,.dsh_tm_catloading{padding:18px 8px;text-align:center;font-size:12px;line-height:18px;color:var(--tm-text3)}',
      '.dsh_tm_caterr{margin:8px 12px 0;padding:8px 10px;border:1px solid color-mix(in srgb,var(--tm-err) 35%,transparent);border-radius:7px;background:color-mix(in srgb,var(--tm-err) 8%,transparent);font-size:12px;line-height:17px;color:var(--tm-err);overflow-wrap:anywhere}',
      '.dsh_tm_catretry{margin-top:6px;height:22px;padding:0 9px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_catretry:hover{background:var(--tm-hover)}',
      '.dsh_tm_catnotice{margin:0 12px 8px;padding:6px 9px;border-radius:6px;background:var(--tm-surface2);color:var(--tm-text2);font-size:12px;line-height:17px;overflow-wrap:anywhere}',
      '.dsh_tm_catnotice[data-tone="ok"]{color:var(--tm-ok)}',
      '.dsh_tm_catnotice[data-tone="error"]{color:var(--tm-err);background:color-mix(in srgb,var(--tm-err) 10%,transparent)}',
      '.dsh_tm_catundo{flex:none;display:flex;align-items:center;gap:8px;margin:0 12px 8px;padding:5px 8px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface2);font-size:12px;line-height:17px;color:var(--tm-text2);min-width:0}',
      '.dsh_tm_catundotext{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_catundobtn{flex:none;height:22px;padding:0 8px;border:1px solid var(--tm-accent);border-radius:5px;background:var(--tm-accent-soft);color:var(--tm-accent);font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_catundobtn:hover{filter:brightness(1.04)}',
      '.dsh_tm_catundobtn:disabled{opacity:.5;cursor:default}',
      '.dsh_tm_catdialog{width:min(340px,calc(100vw - 32px));height:auto;max-height:min(440px,calc(100vh - 32px))}',
      '.dsh_tm_catdialogbody{padding:12px 12px 4px;min-height:0;overflow:auto}',
      '.dsh_tm_catdialoglabel{font-size:12px;line-height:17px;color:var(--tm-text3);margin-bottom:6px;overflow-wrap:anywhere}',
      '.dsh_tm_catinput{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:13px;line-height:18px;padding:5px 8px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface);color:var(--tm-text);outline:none}',
      '.dsh_tm_catinput:focus{border-color:var(--tm-accent);box-shadow:0 0 0 2px var(--tm-accent-soft)}',
      '.dsh_tm_catdialogfoot{flex:none;display:flex;justify-content:flex-end;gap:8px;padding:10px 12px 12px}',
      '.dsh_tm_catdialogok{height:26px;padding:0 14px;border:0;border-radius:6px;background:var(--tm-accent);color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer}',
      '.dsh_tm_catdialogok:disabled{opacity:.5;cursor:default}',
      '.dsh_tm_catdialogdanger{height:26px;padding:0 14px;border:0;border-radius:6px;background:var(--tm-err);color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer}',
      '.dsh_tm_catpicklist{display:flex;flex-direction:column;gap:1px;max-height:260px;overflow:auto;padding:2px;border:1px solid var(--tm-border);border-radius:7px;background:var(--tm-surface2)}',
      '.dsh_tm_catpick{display:flex;align-items:center;gap:6px;min-width:0;height:26px;padding:0 7px;border:0;border-radius:5px;background:transparent;color:var(--tm-text2);font:inherit;font-size:12px;text-align:left;cursor:pointer}',
      '.dsh_tm_catpick:hover{background:var(--tm-hover);color:var(--tm-text)}',
      '.dsh_tm_catpickname{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_catpickcount{flex:none;font-size:11px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      // ── 线索 tab ──
      '.dsh_tm_cluebar{flex:none;display:flex;align-items:center;gap:6px;padding:0 12px 8px}',
      '.dsh_tm_clueinput{flex:1 1 auto;min-width:0;font:inherit;font-size:12px;line-height:17px;padding:5px 8px;border:1px solid var(--tm-border);border-radius:7px;background:var(--tm-surface);color:var(--tm-text);outline:none}',
      '.dsh_tm_clueinput:focus{border-color:var(--tm-accent);box-shadow:0 0 0 2px var(--tm-accent-soft)}',
      '.dsh_tm_cluesubmit{flex:none;height:26px;padding:0 11px;border:1px solid var(--tm-accent);border-radius:6px;background:var(--tm-accent);color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer}',
      '.dsh_tm_cluesubmit:hover{filter:brightness(1.06)}',
      '.dsh_tm_cluesubmit:disabled{opacity:.5;cursor:default}',
      '.dsh_tm_cluestats{flex:none;padding:0 12px 7px;font-size:11px;line-height:16px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_cluebody{flex:1 1 auto;min-height:0;overflow:auto;padding:0 8px 12px}',
      '.dsh_tm_cluerow{display:flex;flex-direction:column;gap:3px;width:100%;box-sizing:border-box;padding:6px 7px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--tm-text);font:inherit;text-align:left;cursor:pointer}',
      '.dsh_tm_cluerow:hover{background:var(--tm-hover)}',
      '.dsh_tm_cluerow:focus-visible{outline:2px solid var(--tm-accent);outline-offset:-2px}',
      '.dsh_tm_cluerowhead{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:11px;line-height:16px;color:var(--tm-text3)}',
      '.dsh_tm_cluetime{flex:none;font-variant-numeric:tabular-nums}',
      '.dsh_tm_clueat{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text2);font-weight:600}',
      '.dsh_tm_clueturn{flex:none;font-variant-numeric:tabular-nums}',
      '.dsh_tm_cluedelta{flex:none;padding:0 5px;border-radius:5px;background:var(--tm-accent-soft);color:var(--tm-accent);font-size:10px;line-height:15px}',
      '.dsh_tm_clueheadtext{font-size:12px;line-height:17px;color:var(--tm-text2);overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}',
      '.dsh_tm_cluesub{font-size:10.5px;line-height:15px;color:var(--tm-text3)}',
      '.dsh_tm_clueempty{display:flex;align-items:center;justify-content:center;height:100%;min-height:120px;padding:24px 18px;text-align:center;font-size:12px;line-height:18px;color:var(--tm-text3)}',
      '.dsh_tm_clueloading{padding:18px 12px;text-align:center;font-size:12px;color:var(--tm-text3)}',
      '.dsh_tm_clueerr{margin:6px 4px;padding:8px 10px;border:1px solid color-mix(in srgb,var(--tm-err) 35%,transparent);border-radius:7px;background:color-mix(in srgb,var(--tm-err) 8%,transparent);font-size:12px;line-height:17px;color:var(--tm-err);overflow-wrap:anywhere}',
      '.dsh_tm_clueretry{margin-top:6px;height:22px;padding:0 9px;border:1px solid currentColor;border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh_tm_clueretry:hover{background:var(--tm-hover)}',
      '.dsh_tm_cluenotice{margin:0 12px 8px;padding:5px 8px;border-radius:6px;background:var(--tm-surface2);font-size:12px;line-height:17px;color:var(--tm-text2);overflow-wrap:anywhere}',
      '.dsh_tm_cluenotice[data-tone="ok"]{color:var(--tm-ok)}',
      '.dsh_tm_cluenotice[data-tone="error"]{color:var(--tm-err);background:color-mix(in srgb,var(--tm-err) 10%,transparent)}',
      '.dsh_tm_cluetruncated{padding:4px 4px 0;font-size:11px;color:var(--tm-text3)}',
      // ── 历史详情的变更区 + 回滚预演浮窗 ──
      '.dsh_tm_histdchanges{border-top:1px dashed var(--tm-border)}',
      '.dsh_tm_histdchsum{font-size:11px;line-height:16px;color:var(--tm-text3);margin-bottom:2px}',
      '.dsh_tm_histdchangegroup{margin-top:4px}',
      '.dsh_tm_histdchangehead{font-size:11px;line-height:16px;color:var(--tm-text3);font-weight:600}',
      '.dsh_tm_histdchangerow{display:flex;align-items:baseline;gap:6px;min-width:0;padding:1px 0;list-style:none}',
      '.dsh_tm_histdchangepath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.dsh_tm_histdchangechurn{flex:none;font-size:11px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_histdchangelist{margin:0;padding:0}',
      '.dsh_tm_histdlost{font-size:12px;line-height:17px;color:var(--tm-warn);overflow-wrap:anywhere}',
      '.dsh_tm_histrollbackbtn{margin-top:6px}',
      '.dsh_tm_rbdialog{width:min(420px,calc(100vw - 32px));height:auto;max-height:min(520px,calc(100vh - 32px))}',
      '.dsh_tm_rbbody{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 12px 4px;font-size:12px;line-height:17px;color:var(--tm-text2)}',
      '.dsh_tm_rbsummary{padding:2px 0 6px;color:var(--tm-text);font-weight:600;overflow-wrap:anywhere}',
      '.dsh_tm_rbcounts{padding:0 0 6px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_rbgroup{margin-top:5px;border:1px solid var(--tm-border);border-radius:7px;background:var(--tm-surface2);overflow:hidden}',
      '.dsh_tm_rbgrouphead{display:flex;align-items:baseline;gap:6px;padding:4px 8px;border-bottom:1px solid var(--tm-border);min-width:0}',
      '.dsh_tm_rbstate{flex:1 1 auto;min-width:0;font-size:12px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_rbgroup[data-state="apply"] .dsh_tm_rbstate{color:var(--tm-ok)}',
      '.dsh_tm_rbgroup[data-state="modified"] .dsh_tm_rbstate{color:var(--tm-warn)}',
      '.dsh_tm_rbgroup[data-state="missing"] .dsh_tm_rbstate{color:var(--tm-err)}',
      '.dsh_tm_rbcount{flex:none;font-size:11px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_rbfiles{margin:0;padding:2px 8px 4px;list-style:none}',
      '.dsh_tm_rbfile{display:flex;align-items:baseline;gap:6px;min-width:0;padding:1px 0;color:var(--tm-text2)}',
      '.dsh_tm_rbpath{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
      '.dsh_tm_rbchurn{flex:none;font-size:11px;color:var(--tm-text3);font-variant-numeric:tabular-nums}',
      '.dsh_tm_rbempty{padding:2px 8px 4px;font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_rberr{padding:4px 0;color:var(--tm-err);overflow-wrap:anywhere}',
      '.dsh_tm_rbnote{font-size:11px;line-height:16px;color:var(--tm-text3)}',
      // 标题栏工作区 / 底部补齐索引。
      '.dsh_tm_histws{flex:0 1 auto;min-width:0;max-width:52%;font-size:12px;line-height:16px;color:var(--tm-text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.dsh_tm_histwswarn{flex:0 1 auto;min-width:0;max-width:52%;font-size:12px;line-height:16px;color:var(--tm-warn);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_histfootrow{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}',
      '.dsh_tm_histfootlines{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dsh_tm_histfoottools{flex:0 0 auto;display:flex;align-items:center;gap:10px;margin-left:auto;flex-wrap:wrap}',
      '.dsh_tm_histpager{display:flex;align-items:center;gap:6px;flex:0 0 auto}',
      '.dsh_tm_histpagebtn{height:24px;padding:0 9px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface2);color:var(--tm-text2);font:inherit;font-size:11.5px;line-height:22px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_histpagebtn:hover:not(:disabled){border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_histpagebtn:disabled{opacity:.45;cursor:not-allowed}',
      '.dsh_tm_histpagenum{min-width:74px;text-align:center;white-space:nowrap}',
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

      // ── V-12 历史轨接管：自绘轨 / 失配降级 / 设置开关 ──
      //
      // 自绘轨在对话区（不在本面板里），主题变量 --tm-* 不可用，颜色一律取宿主
      // 的 --dsw-alias-* 并给 fallback；宿主改主题时它跟着变，不需要额外同步。
      '.dsh_tm_rail{position:absolute;right:12px;top:50%;z-index:6;display:flex;flex-direction:column;box-sizing:border-box;width:var(--dsh-tm-rail-max-width,260px);max-height:50vh;min-height:0;transform:translateY(-50%);contain:layout;pointer-events:auto;border-radius:10px;border:1px solid var(--dsw-alias-border-l3,#333);background:var(--dsw-alias-bg-layer-1,#1b1b1b);color:var(--dsw-alias-label-primary,#eee);box-shadow:none;overflow:visible;font-variant-numeric:tabular-nums;clip-path:none;transition:opacity .12s ease-out;will-change:opacity;--rail-row-h:clamp(18px,1.6vh,24px);--rail-font:clamp(10px,0.75vw,12px);--rail-pad:clamp(4px,0.5vh,8px)}',
      '@keyframes dsh_tm_rail_fade{from{opacity:.35}to{opacity:1}}',
      '.dsh_tm_rail[data-animating="1"]{animation:dsh_tm_rail_fade .12s ease-out}',
      '.dsh_tm_railmeasure{position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;font-size:11px;line-height:16px;font-weight:600;letter-spacing:0;font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}',
      '.dsh_tm_railhead{flex:none;display:flex;align-items:center;gap:2px;width:var(--dsh-tm-rail-visible-width,200px);margin-left:auto;height:calc(var(--rail-row-h) + 2px);padding:0 var(--rail-pad);border-bottom:1px solid var(--dsw-alias-border-l3,#333);user-select:none}',
      '.dsh_tm_railcollapse{flex:1 1 auto;min-width:0;height:calc(var(--rail-row-h) - 4px);display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:3px;background:transparent;color:var(--dsw-alias-label-caption,#888);font:inherit;font-size:var(--rail-font);line-height:1;cursor:pointer}',
      '.dsh_tm_railcollapse:hover{background:var(--dsw-alias-bg-layer-2,#262626);color:var(--dsw-alias-label-primary,#eee)}',
      '.dsh_tm_railmore{flex:none;width:16px;height:16px;display:grid;place-items:center;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-caption,#888);font:inherit;font-size:var(--rail-font);line-height:1;cursor:pointer}',
      '.dsh_tm_railmore:hover{background:var(--dsw-alias-bg-layer-2,#262626);color:var(--dsw-alias-label-primary,#eee)}',
      '.dsh_tm_railmenu{position:absolute;right:2px;top:calc(var(--rail-row-h) + 2px);z-index:9;display:flex;flex-direction:column;min-width:152px;padding:3px;border:1px solid var(--dsw-alias-border-l3,#333);border-radius:7px;background:var(--dsw-alias-bg-layer-1,#1b1b1b);box-shadow:0 8px 20px #0004}',
      '.dsh_tm_railmenuitem{display:flex;align-items:center;gap:5px;width:100%;box-sizing:border-box;height:calc(var(--rail-row-h) + 2px);padding:0 7px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#bbb);font:inherit;font-size:var(--rail-font);text-align:left;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_railmenuitem:hover{background:var(--dsw-alias-bg-layer-2,#262626);color:var(--dsw-alias-label-primary,#eee)}',
      '.dsh_tm_railmenucheck{flex:none;width:12px;text-align:center;color:var(--dsw-alias-state-business-primary,#4f8cff);font-size:10px}',
      '.dsh_tm_railmenutext{flex:1 1 auto;min-width:0}',
      '.dsh_tm_railmenusep{height:1px;margin:3px 2px;background:var(--dsw-alias-border-l3,#333)}',
      '.dsh_tm_railrows{position:relative;flex:1 1 auto;min-height:0;width:var(--dsh-tm-rail-visible-width,200px);margin-left:auto;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;padding:var(--rail-pad) 0}',
      '.dsh_tm_railrow{display:flex;align-items:center;gap:calc(var(--rail-pad) / 2);width:100%;box-sizing:border-box;height:var(--rail-row-h);padding:0 var(--rail-pad);border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#bbb);font:inherit;font-size:var(--rail-font);text-align:left;cursor:pointer}',
      '.dsh_tm_railrow:hover{background:var(--dsw-alias-bg-layer-2,#262626);color:var(--dsw-alias-label-primary,#eee)}',
      '.dsh_tm_railrow:focus-visible{outline:1px solid var(--dsw-focus-ring-color,#4f8cff);outline-offset:-1px}',
      '.dsh_tm_railtick{flex:none;width:14px;height:2px;border-radius:2px;background:var(--dsw-alias-border-l4,#555);transition:background-color .12s}',
      '.dsh_tm_railrow[data-active="1"] .dsh_tm_railtick{width:20px;background:var(--dsw-alias-label-primary,#fff)}',
      '.dsh_tm_railrow[data-hit="1"] .dsh_tm_railtick{background:var(--dsw-alias-state-business-primary,#4f8cff)}',
      '.dsh_tm_railnum{flex:0 0 auto;width:auto;min-width:0;text-align:right;font-size:var(--rail-font);color:var(--dsw-alias-label-caption,#888);white-space:nowrap;overflow:visible;font-variant-numeric:tabular-nums}',
      '.dsh_tm_railrow[data-active="1"]{color:var(--dsw-alias-label-primary,#fff);font-weight:600}',
      '.dsh_tm_railrow[data-active="1"] .dsh_tm_railnum{color:inherit}',
      '.dsh_tm_railtext{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_railnohead{color:var(--dsw-alias-label-caption,#888);font-style:italic}',
      '.dsh_tm_railtime{flex:none;font-size:calc(var(--rail-font) - 0.5px);color:var(--dsw-alias-label-caption,#888)}',
      '.dsh_tm_railnote{flex:none;width:var(--dsh-tm-rail-visible-width,200px);margin-left:auto;box-sizing:border-box;padding:4px var(--rail-pad);border-top:1px solid var(--dsw-alias-border-l3,#333);font-size:9.5px;line-height:13px;color:var(--dsw-alias-label-caption,#888)}',
      '.dsh_tm_railnote:empty{display:none}',
      '.dsh_tm_rail[data-tier="std"] .dsh_tm_railtime{display:none}',
      '.dsh_tm_rail[data-tier="min"] .dsh_tm_railtext,.dsh_tm_rail[data-tier="min"] .dsh_tm_railtime,.dsh_tm_rail[data-tier="min"] .dsh_tm_railnote,.dsh_tm_rail[data-tier="min"] .dsh_tm_railseg{display:none}',
      '.dsh_tm_railseg{display:flex;align-items:center;gap:4px;width:100%;box-sizing:border-box;min-height:18px;margin-top:4px;padding:2px var(--rail-pad);border:0;border-top:1px solid var(--dsw-alias-border-l3,#333);background:transparent;color:var(--dsw-alias-label-caption,#888);font:inherit;font-size:calc(var(--rail-font) - 0.5px);line-height:1.3;text-align:left;cursor:pointer}',
      '.dsh_tm_railseg:first-child{margin-top:0;border-top:0}',
      '.dsh_tm_railseg:hover{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-bg-layer-2,#262626)}',
      '.dsh_tm_railseg[data-active="1"]{color:var(--dsw-alias-label-primary,#fff);font-weight:600}',
      '.dsh_tm_railsegdot{flex:none;width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-border-l4,#666)}',
      '.dsh_tm_railseg[data-kind="work"] .dsh_tm_railsegdot{background:var(--dsw-alias-state-business-primary,#4f8cff)}',
      '.dsh_tm_railseg[data-error="1"] .dsh_tm_railsegdot{background:#f85149}',
      '.dsh_tm_railsegtitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_railsegrange{flex:none;font-size:calc(var(--rail-font) - 1px);opacity:.8;font-variant-numeric:tabular-nums}',
      '.dsh_tm_rail[data-tier="min"] .dsh_tm_railhead{padding:0;justify-content:center;gap:0}',
      '.dsh_tm_rail[data-tier="min"] .dsh_tm_railcollapse{flex:0 0 12px;width:12px;padding:0}',
      '.dsh_tm_rail[data-tier="min"] .dsh_tm_railmore{flex:0 0 12px;width:12px;height:14px}',
      '.dsh_tm_rail[data-tier="min"] .dsh_tm_railrows{padding:4px 2px;width:100%;box-sizing:border-box}',
      '.dsh_tm_rail[data-tier="min"] .dsh_tm_railrow{display:flex;align-items:center;justify-content:center;gap:3px;padding:0 2px;box-sizing:border-box;width:100%;min-width:0;margin-left:0;overflow:visible}',
      '.dsh_tm_rail[data-tier="min"] .dsh_tm_railtick{display:block;flex:0 0 2px;width:2px;height:8px;margin:0;border-radius:1px}',
      '.dsh_tm_rail[data-tier="min"] .dsh_tm_railnum{flex:0 0 auto;width:auto;min-width:0;padding:0;text-align:center;white-space:nowrap;overflow:visible;font-variant-numeric:tabular-nums;font-size:11px;line-height:16px;font-weight:600;letter-spacing:0;-webkit-font-smoothing:antialiased}',
      '.dsh_tm_rail[data-tier="min"] .dsh_tm_railrow[data-active="1"] .dsh_tm_railtick{width:2px;background:var(--dsw-alias-label-primary,#fff)}',
      '.dsh_tm_rail[data-tier="min"] .dsh_tm_railrow[data-hit="1"] .dsh_tm_railtick{background:var(--dsw-alias-state-business-primary,#4f8cff)}',
      '.dsh_tm_rail[data-autohide="1"]{opacity:.55}',
      '.dsh_tm_rail[data-autohide="1"]:hover{opacity:1}',
      // ── 自绘右侧抽屉（shell.overlay）──
      '.dsh_tm_drawerpill{position:fixed;right:2px;top:50%;z-index:62;width:20px;height:44px;margin-top:-22px;display:flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--dsw-alias-border-l3,#333);border-right:0;border-radius:8px 0 0 8px;background:var(--dsw-alias-bg-layer-1,#1b1b1b);color:var(--dsw-alias-label-caption,#888);font:inherit;font-size:12px;line-height:1;letter-spacing:-2px;cursor:pointer;box-shadow:0 2px 10px #0003;pointer-events:auto}',
      '.dsh_tm_drawerpill:hover{color:var(--dsw-alias-label-primary,#eee);background:var(--dsw-alias-bg-layer-2,#262626)}',
      '.dsh_tm_drawer{position:fixed;right:0;z-index:61;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1,#1b1b1b);color:var(--dsw-alias-label-primary,#eee);border-left:1px solid var(--dsw-alias-border-l3,#333);box-shadow:-8px 0 24px #0002;container-type:inline-size;container-name:tm-drawer;overflow:hidden;pointer-events:auto}',
      '.dsh_tm_drawerresize{position:absolute;left:-3px;top:0;bottom:0;width:6px;z-index:5;cursor:col-resize;touch-action:none}',
      '.dsh_tm_drawerresize::after{content:"";position:absolute;left:2px;top:calc(50% - 16px);width:2px;height:32px;border-radius:2px;background:var(--dsw-alias-border-l4,#555);opacity:.5}',
      '.dsh_tm_drawerresize:hover::after{opacity:1;background:var(--dsw-alias-state-business-primary,#4f8cff)}',
      '.dsh_tm_drawerhead{flex:none;display:flex;align-items:center;gap:6px;height:34px;padding:0 8px 0 12px;border-bottom:1px solid var(--dsw-alias-border-l3,#333)}',
      '.dsh_tm_drawertitle{flex:1 1 auto;min-width:0;display:flex;align-items:baseline;font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden}',
      '.dsh_tm_drawertitlemain{flex:0 0 auto;white-space:nowrap}',
      '.dsh_tm_drawertitlews{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:400;color:var(--dsw-alias-label-caption,#888)}',
      '.dsh_tm_drawerfold,.dsh_tm_drawericon{flex:none;display:grid;place-items:center;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-caption,#888);font:inherit;cursor:pointer}',
      '.dsh_tm_drawerfold{width:22px;height:22px;font-size:15px;line-height:1}',
      '.dsh_tm_drawerfold:hover,.dsh_tm_drawericon:hover{background:var(--dsw-alias-bg-layer-2,#262626);color:var(--dsw-alias-label-primary,#eee)}',
      '.dsh_tm_drawertabs{flex:none;display:flex;align-items:center;gap:2px;padding:6px 10px 0;border-bottom:1px solid var(--dsw-alias-border-l3,#333)}',
      '.dsh_tm_drawertab{height:26px;padding:0 10px;border:0;border-radius:6px 6px 0 0;background:transparent;color:var(--dsw-alias-label-caption,#888);font:inherit;font-size:12px;line-height:26px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_drawertab:hover{color:var(--dsw-alias-label-primary,#eee)}',
      '.dsh_tm_drawertab_on{color:var(--dsw-alias-label-primary,#fff);font-weight:600;background:var(--dsw-alias-bg-layer-2,#262626);box-shadow:inset 0 -2px 0 var(--dsw-alias-state-business-primary,#4f8cff)}',
      '.dsh_tm_drawersurface{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;--tm-bg:var(--dsw-alias-bg-layer-1,#1b1b1b);--tm-surface:var(--dsw-alias-bg-layer-1,#1b1b1b);--tm-surface2:var(--dsw-alias-bg-layer-2,#262626);--tm-text:var(--dsw-alias-label-primary,#eee);--tm-text2:var(--dsw-alias-label-secondary,#bbb);--tm-text3:var(--dsw-alias-label-caption,#888);--tm-border:var(--dsw-alias-border-l3,#333);--tm-hover:var(--dsw-alias-bg-layer-2,#262626);--tm-accent:var(--dsw-alias-state-business-primary,#4f8cff);--tm-accent-soft:color-mix(in srgb,var(--tm-accent) 16%,transparent);--tm-ok:#3fb950;--tm-err:#f85149;--tm-shadow:0 8px 24px #0004}',
      '.dsh_tm_drawerbody{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}',
      '.dsh_tm_drawerbody .dsh_tm_history{height:100%;min-height:0}',
      '.dsh_tm_drawerbody .dsh_tm_works,.dsh_tm_drawerbody .dsh_tm_stats,.dsh_tm_drawerbody .dsh_tm_settings{height:auto;min-height:100%}',
      // ── 续接（Works）首页：高信噪比 4 行窄卡片 + 非阻塞拐点/重开条 ──
      '.dsh_tm_works{display:flex;flex-direction:column;gap:8px;padding:10px;box-sizing:border-box;color:var(--tm-text);font-size:12px;line-height:1.45}',
      '.dsh_tm_workshead{display:flex;align-items:center;gap:6px;flex:none}',
      '.dsh_tm_workstitle{font-size:12.5px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_workscount{font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_worksgrow{flex:1 1 auto}',
      // 顶部工作区切换器（ADR-0008）：轻量、不抢标题，切换即清态重载。
      '.dsh_tm_workspick{max-width:150px;height:22px;padding:0 4px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface2);color:var(--tm-text2);font:inherit;font-size:11px;cursor:pointer}',
      '.dsh_tm_workspick:hover{border-color:var(--tm-accent);color:var(--tm-text)}',
      '.dsh_tm_workspick:disabled{opacity:.5;cursor:default}',
      // 提炼状态条（ADR-0010）：已深度提炼 / 仅基础规则 + 原因 + 一键重试。
      '.dsh_tm_worksrefine{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;border-radius:7px;border:1px solid var(--tm-border);background:var(--tm-surface2);font-size:11px;color:var(--tm-text3);flex:none}',
      '.dsh_tm_worksrefine[data-state="ok"]{color:var(--tm-ok,#3a9b5c)}',
      '.dsh_tm_worksrefine[data-state="rule"]{color:var(--tm-text2)}',
      '.dsh_tm_worksbanner_readonly{border-color:var(--tm-accent);background:var(--tm-accent-soft)}',
      '.dsh_tm_workpick{display:flex;flex-direction:column;gap:4px;padding:6px;border:1px dashed var(--tm-border);border-radius:7px;background:var(--tm-surface2)}',
      '.dsh_tm_workpickhead{font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_workpickitem{justify-content:flex-start;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
      '.dsh_tm_worksrefinetext{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_worksbtn{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface2);color:var(--tm-text2);font:inherit;font-size:11px;line-height:22px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_worksbtn:hover{border-color:var(--tm-accent);color:var(--tm-text)}',
      '.dsh_tm_worksbtn:disabled{opacity:.5;cursor:default}',
      '.dsh_tm_worksbtn_primary{border-color:var(--tm-accent);background:var(--tm-accent-soft);color:var(--tm-accent);font-weight:600}',
      '.dsh_tm_worksbtn_ghost{border-color:transparent;background:transparent;color:var(--tm-text3)}',
      '.dsh_tm_worksbtn_ghost:hover{color:var(--tm-text);background:var(--tm-hover);border-color:transparent}',
      '.dsh_tm_worksbtn_danger{color:var(--tm-err)}',
      '.dsh_tm_worksbtn_danger:hover{border-color:var(--tm-err);color:var(--tm-err)}',
      '.dsh_tm_worksnotice{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:7px;border:1px solid var(--tm-border);background:var(--tm-surface2);font-size:11.5px;color:var(--tm-text2)}',
      '.dsh_tm_worksnotice[data-tone="ok"]{border-color:color-mix(in srgb,var(--tm-ok) 45%,transparent);color:var(--tm-ok)}',
      '.dsh_tm_worksnotice[data-tone="error"]{border-color:color-mix(in srgb,var(--tm-err) 50%,transparent);color:var(--tm-err)}',
      '.dsh_tm_worksbanner{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:8px;border:1px solid var(--tm-border);background:var(--tm-surface2)}',
      '.dsh_tm_worksbanner_inflection{border-color:color-mix(in srgb,var(--tm-accent) 45%,var(--tm-border));background:var(--tm-accent-soft)}',
      '.dsh_tm_worksbanner_reopen{border-style:dashed;border-color:color-mix(in srgb,var(--tm-accent) 55%,var(--tm-border))}',
      '.dsh_tm_worksbanner_review{border-color:color-mix(in srgb,var(--tm-accent) 60%,var(--tm-border));background:var(--tm-accent-soft)}',
      '.dsh_tm_worksbanner_refining{border-style:dashed;border-color:color-mix(in srgb,var(--tm-accent) 55%,var(--tm-border));background:var(--tm-surface2)}',
      '.dsh_tm_worksbannermsg{font-size:11.5px;color:var(--tm-text);line-height:1.4}',
      '.dsh_tm_worksbannerdesc{font-size:11px;color:var(--tm-text2);line-height:1.45}',
      '.dsh_tm_worksbanneracts{display:flex;flex-wrap:wrap;gap:6px}',
      '.dsh_tm_workslist{display:flex;flex-direction:column;gap:8px}',
      '.dsh_tm_workcard{display:flex;flex-direction:column;gap:5px;padding:9px 10px;border-radius:8px;border:1px solid var(--tm-border);background:var(--tm-surface2)}',
      '.dsh_tm_workcard[data-confidence="inferred"]{border-style:dashed}',
      '.dsh_tm_workcard[data-state="blocked"]{border-left:3px solid var(--tm-err)}',
      '.dsh_tm_workcard[data-pinned="1"]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tm-accent) 35%,transparent)}',
      '.dsh_tm_workcard[data-reviewing="1"]{border-style:solid;border-color:var(--tm-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--tm-accent) 40%,transparent)}',
      '.dsh_tm_workrow1{display:flex;align-items:center;gap:5px;min-width:0}',
      '.dsh_tm_worktitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_workbadge{flex:none;padding:0 5px;height:18px;line-height:16px;border-radius:999px;font-size:10.5px;border:1px solid var(--tm-border);color:var(--tm-text2)}',
      '.dsh_tm_workbadge[data-state="active"]{border-color:color-mix(in srgb,var(--tm-accent) 50%,transparent);color:var(--tm-accent)}',
      '.dsh_tm_workbadge[data-state="blocked"]{border-color:color-mix(in srgb,var(--tm-err) 55%,transparent);color:var(--tm-err)}',
      '.dsh_tm_workbadge[data-state="done"]{border-color:color-mix(in srgb,var(--tm-ok) 50%,transparent);color:var(--tm-ok)}',
      '.dsh_tm_workconf{flex:none;padding:0 5px;height:18px;line-height:16px;border-radius:999px;font-size:10px;border:1px solid var(--tm-border);color:var(--tm-text3)}',
      '.dsh_tm_workconf[data-style="dashed"]{border-style:dashed}',
      '.dsh_tm_workconf[data-style="solid"]{border-style:solid;color:var(--tm-ok);border-color:color-mix(in srgb,var(--tm-ok) 45%,transparent)}',
      '.dsh_tm_worktime{flex:none;font-size:10.5px;color:var(--tm-text3);white-space:nowrap}',
      '.dsh_tm_workpin{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--tm-text3);font-size:12px;line-height:1;cursor:pointer}',
      '.dsh_tm_workpin:hover,.dsh_tm_workpin[data-pinned="1"]{color:var(--tm-accent)}',
      '.dsh_tm_workrow2{font-size:11.5px;color:var(--tm-text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_workrow3{padding:4px 7px;border-radius:6px;background:var(--tm-accent-soft);color:var(--tm-text);font-size:11.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh_tm_workrow3[data-empty="1"]{background:transparent;padding-left:0;color:var(--tm-text3);font-weight:400}',
      '.dsh_tm_workrow4{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding-top:2px}',
      '.dsh_tm_workdetail{display:flex;flex-direction:column;gap:8px;margin-top:4px;padding-top:8px;border-top:1px solid var(--tm-border)}',
      '.dsh_tm_worksec{display:flex;flex-direction:column;gap:4px}',
      '.dsh_tm_worksectitle{font-size:11px;font-weight:600;color:var(--tm-text3)}',
      '.dsh_tm_workdec{display:flex;flex-direction:column;gap:2px;padding:5px 7px;border-radius:6px;background:var(--tm-surface);border:1px solid var(--tm-border)}',
      '.dsh_tm_workdec[data-status="superseded"]{opacity:.68}',
      '.dsh_tm_workdechead{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11.5px}',
      '.dsh_tm_workdec[data-status="superseded"] .dsh_tm_workdectext{text-decoration:line-through}',
      '.dsh_tm_workdecrat{font-size:11px;color:var(--tm-text3)}',
      '.dsh_tm_workhandle{padding:0 5px;height:18px;border:1px solid var(--tm-border);border-radius:4px;background:transparent;color:var(--tm-accent);font:inherit;font-size:10.5px;cursor:pointer}',
      '.dsh_tm_workhandle:hover{background:var(--tm-accent-soft)}',
      '.dsh_tm_workfiles{display:flex;flex-wrap:wrap;gap:4px}',
      '.dsh_tm_workfile{padding:1px 6px;border-radius:4px;background:var(--tm-surface);border:1px solid var(--tm-border);font-size:10.5px;color:var(--tm-text2);word-break:break-all}',
      '.dsh_tm_workseg{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:4px 7px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface);color:var(--tm-text2);font:inherit;font-size:11px;text-align:left;cursor:pointer}',
      '.dsh_tm_workseg:hover{border-color:var(--tm-accent);color:var(--tm-text)}',
      '.dsh_tm_worksegrange{margin-left:auto;color:var(--tm-text3);font-size:10.5px;white-space:nowrap}',
      '.dsh_tm_workeditrow{display:flex;align-items:center;gap:5px}',
      '.dsh_tm_workinput{flex:1 1 auto;min-width:0;height:26px;padding:0 7px;border:1px solid var(--tm-border);border-radius:6px;background:var(--tm-surface);color:var(--tm-text);font:inherit;font-size:11.5px}',
      '.dsh_tm_workinput:focus{outline:1px solid var(--tm-accent);border-color:var(--tm-accent)}',
      '.dsh_tm_worksettled{display:flex;flex-direction:column;gap:6px;padding-top:4px;border-top:1px solid var(--tm-border)}',
      '.dsh_tm_worksettledtoggle{display:flex;align-items:center;justify-content:space-between;width:100%;padding:4px 2px;border:0;background:transparent;color:var(--tm-text3);font:inherit;font-size:11.5px;cursor:pointer}',
      '.dsh_tm_worksettledtoggle:hover{color:var(--tm-text)}',
      '.dsh_tm_worksempty{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:14px 12px;border:1px dashed var(--tm-border);border-radius:8px;background:var(--tm-surface2)}',
      '.dsh_tm_worksemptytitle{font-size:12.5px;font-weight:600;color:var(--tm-text)}',
      '.dsh_tm_worksemptydesc{font-size:11.5px;color:var(--tm-text3)}',
      '.dsh_tm_drawerbody .dsh_tm_histbody{overflow-y:auto;flex:1 1 auto;min-height:0}',
      '.dsh_tm_drawerbody .dsh_tm_statsbody,.dsh_tm_drawerbody .dsh_tm_setbody{overflow:visible;flex:none}',
      '.dsh_tm_drawerbody .dsh_tm_histhead,.dsh_tm_drawerbody .dsh_tm_statshead,.dsh_tm_drawerbody .dsh_tm_sethead{display:none}',
      '.dsh_tm_drawerbody .dsh_tm_setgrouptitle{position:sticky;top:0;z-index:2;padding:4px 0;background:var(--tm-surface)}',
      '.dsh_tm_drawerwarn{flex:none;padding:4px 12px;border-bottom:1px solid var(--dsw-alias-border-l3,#333);font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#888);background:var(--dsw-alias-bg-layer-2,#262626)}',
      '.dsh_tm_drawercollapsedhead{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 0;min-height:0;overflow:hidden}',
      '.dsh_tm_drawericon{width:30px;height:30px;font-size:14px;line-height:1}',
      '.dsh_tm_drawer[data-collapsed="1"] .dsh_tm_drawerresize{display:none}',
      '.dsh_tm_drawer[data-collapsed="1"] .dsh_tm_drawerfold{display:none}',
      // 历史页顶部胶囊：只做只读过滤，窄容器横向滚动、不换行压扁。
      '.dsh_tm_histcatpillswrap{position:relative;display:flex;align-items:center;gap:8px;flex:none;min-width:0}',
      '.dsh_tm_histcatpills{flex:1 1 auto;display:flex;align-items:center;gap:6px;padding:0 10px 6px;min-width:0;overflow-x:auto;overflow-y:hidden;white-space:nowrap;scrollbar-width:thin}',
      '.dsh_tm_histcatauto{flex:0 0 auto;padding:0 10px 6px 0;color:var(--tm-text3);font-size:11px;line-height:17px;white-space:nowrap}',
      '.dsh_tm_histcatpill{flex:0 0 auto;height:24px;display:inline-flex;align-items:center;gap:4px;padding:0 10px;border:1px solid var(--tm-border);border-radius:999px;background:var(--tm-surface2);color:var(--tm-text2);font:inherit;font-size:11.5px;line-height:22px;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_histcatpill:hover{border-color:var(--tm-accent);color:var(--tm-accent)}',
      '.dsh_tm_histcatpill_on{background:var(--tm-accent-soft);border-color:var(--tm-accent);color:var(--tm-accent);font-weight:600}',
      '.dsh_tm_histcatpill_more{color:var(--tm-text3)}',
      '.dsh_tm_histcatmore{position:relative;flex:0 0 auto}',
      '.dsh_tm_histcatmoremenu{position:absolute;right:10px;top:30px;z-index:40;display:flex;flex-direction:column;min-width:140px;padding:3px;border:1px solid var(--tm-border-strong,var(--tm-border));border-radius:8px;background:var(--tm-surface);box-shadow:var(--tm-shadow)}',
      '.dsh_tm_histcatmoreitem{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;height:26px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:var(--tm-text2);font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap}',
      '.dsh_tm_histcatmoreitem:hover,.dsh_tm_histcatmoreitem_on{background:var(--tm-hover);color:var(--tm-accent)}',
      '.dsh_tm_histcatmorecount{margin-left:auto;color:var(--tm-text3);font-size:11px}',
      '.dsh_tm_histcatloading,.dsh_tm_histcaterr{flex:0 0 auto;font-size:11px;color:var(--tm-text3);white-space:nowrap}',
      '.dsh_tm_histcaterr{color:var(--tm-err)}',
      '.dsh_tm_histlock{flex:none;font-size:11px;line-height:16px;color:var(--tm-text3);cursor:help}',
      '@container tm-drawer (max-width:419px){.dsh_tm_statshero{grid-template-columns:1fr}.dsh_tm_setrow{flex-direction:column;align-items:flex-start;gap:3px}.dsh_tm_setrow .dsh_tm_setlabel{order:1}.dsh_tm_setrow input,.dsh_tm_setrow select,.dsh_tm_setrow textarea,.dsh_tm_setrow .dsh_tm_setreadonly{order:2}}',
      '@container tm-drawer (max-width:719px){.dsh_tm_setgrouptitle{position:sticky;top:0;z-index:2;padding:4px 0;background:var(--tm-surface)}}',
      '.dsh_tm_rail[data-autohide="1"]{opacity:.55}',
      '.dsh_tm_rail[data-autohide="1"]:hover{opacity:1}',
      '.dsh_tm_railnotice{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:9998;display:flex;align-items:center;gap:8px;max-width:min(560px,calc(100vw - 40px));padding:4px 8px 4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3,#333);background:var(--dsw-alias-bg-layer-1,#1b1b1b);color:var(--dsw-alias-label-caption,#888);font-size:11px;line-height:16px;box-shadow:0 2px 10px #0002}',
      '.dsh_tm_railnoticex{flex:none;width:18px;height:18px;display:grid;place-items:center;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:1;cursor:pointer}',
      '.dsh_tm_railnoticex:hover{background:var(--dsw-alias-bg-layer-2,#262626);color:var(--dsw-alias-label-primary,#eee)}',
      // 原生模式下的切回入口：容器右缘的小药丸，不压原生轨和滚动条。
      '.dsh_tm_railrestore{position:fixed;z-index:8;width:20px;height:44px;display:flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--dsw-alias-border-l3,#333);border-right:0;border-radius:8px 0 0 8px;background:var(--dsw-alias-bg-layer-1,#1b1b1b);color:var(--dsw-alias-label-caption,#888);font:inherit;font-size:11px;line-height:1;letter-spacing:-2px;cursor:pointer;pointer-events:auto;box-shadow:none;opacity:.55;transition:opacity .12s,width .12s}',
      '.dsh_tm_railrestore:hover,.dsh_tm_railrestore:focus-visible{width:24px;opacity:1;color:var(--dsw-alias-label-primary,#eee);outline:none}',
      '.dsh_tm_railrestore:focus-visible{outline:1px solid var(--dsw-focus-ring-color,#4f8cff);outline-offset:1px}',
      '.dsh_tm_check{display:flex;align-items:center;gap:7px;margin-bottom:8px;font-size:11.5px;color:var(--tm-text2);cursor:pointer}',
      '.dsh_tm_check input{accent-color:var(--tm-accent)}',

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

    // ══ 以下由 scripts/build-theme.mjs 从 lib/rail-view.js
    // 历史轨视图模型（V-12），纯函数，独立测试过（tests/rail-view.mjs）。
    // V-12 起改由本脚本嵌入：手工同步段已删除，改源码后重新生成即可。
    var RAILVIEW = (function () {
  /** 三档目标宽度（px）：细轨 / 标准 / 宽轨。拖拽释放时吸附到这三档。 */
  var TIER_WIDTHS = Object.freeze({ hair: 40, normal: 200, wide: 320 })

  /** 细轨与标准档的分界：两档目标宽度的中点 (40+200)/2。 */
  const HAIR_MAX = 120

  /** 标准档与宽档的分界：(200+320)/2。 */
  const NORMAL_MAX = 260

  /** 是否普通对象（排除 null / 数组）。 */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /**
   * 归一成数字；`null` / `undefined` / 空白串 / 非有限值一律 null。
   *
   * 注意不能用裸 `Number()`：`Number(null) === 0` 会把「没有」悄悄变成第 0 轮。
   *
   * @param {*} value - 候选值。
   * @returns {number|null} 有限数字或 null。
   */
  function toNumber(value) {
    if (value === null || value === undefined) return null
    if (typeof value === 'string' && value.trim() === '') return null
    if (typeof value === 'boolean') return null
    const number = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(number) ? number : null
  }

  /** 压缩连续空白（摘要里不能留换行）。 */
  function compress(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim()
  }

  /** 两位补零。 */
  function pad2(value) {
    return value < 10 ? '0' + value : String(value)
  }

  /** 把毫秒时间戳换算成 HH:MM（只做换算，不读当前时间）。 */
  function clockText(ms) {
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) return ''
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  }

  /**
   * 宽度 → 三档。
   *
   * 目标是三档可拖拽：40 / 200 / 320。档位按两档目标宽度的中点切开，
   * 拖过 120px 就进标准档、拖过 260px 就进宽档。缺失或非法宽度按标准档
   * （200px 是默认观感最稳的一档）。
   *
   * @param {number|string} [width] - 轨道宽度（px）。
   * @returns {'hair'|'normal'|'wide'} 档位。
   */
  function tierOf(width) {
    if (width === null || width === undefined || width === '') return 'normal'
    const px = Number(width)
    if (!Number.isFinite(px)) return 'normal'
    if (px < HAIR_MAX) return 'hair'
    if (px < NORMAL_MAX) return 'normal'
    return 'wide'
  }

  /**
   * 把任意宽度吸附到最近的目标档位，并夹在 40…320 之间。
   *
   * 拖拽释放时用它收口：许拖出中间值，最终只停在三个档位上，
   * 这样「按会话记住的宽度」不会变成一堆 137、188 px 的碎片。
   *
   * @param {number|string} width - 拖拽中的宽度。
   * @returns {number} 40 / 200 / 320。
   */
  function snapWidth(width) {
    const px = Number(width)
    if (!Number.isFinite(px)) return TIER_WIDTHS.normal
    const clamped = Math.min(TIER_WIDTHS.wide, Math.max(TIER_WIDTHS.hair, px))
    let best = TIER_WIDTHS.hair
    let distance = Math.abs(clamped - best)
    for (const key of ['normal', 'wide']) {
      const candidate = TIER_WIDTHS[key]
      const next = Math.abs(clamped - candidate)
      if (next < distance) { best = candidate; distance = next }
    }
    return best
  }

  /**
   * 从按钮文案里解析轮号。
   *
   * 只接受 aria-label / title 这类**机器写的**文案，绝不拿用户提问当输入：
   * 用户完全可能在提问里写「第 3 轮」，那不代表这是第 3 轮。
   *
   * 支持宿主现有文案：`跳转到第 12 轮`、`加载并跳转到第 12 轮`、`第 12 轮`、
   * `Jump to turn 12`、`Turn 12`，以及 `#12`。
   *
   * @param {*} label - 按钮文案。
   * @returns {number|null} 轮号；解析不到返回 null。
   */
  function turnOfLabel(label) {
    const text = String(label ?? '')
    if (text === '') return null
    const zh = text.match(/第\s*#?\s*(\d+)\s*轮/)
    if (zh !== null) return toNumber(zh[1])
    const en = text.match(/[Tt]urn\s*#?\s*(\d+)/)
    if (en !== null) return toNumber(en[1])
    const hash = text.match(/(?:^|\s)#\s*(\d+)/)
    if (hash !== null) return toNumber(hash[1])
    return null
  }

  /** 从节点上读一个属性；兼容 `{dataIndex}` / `{'data-index'}` / `{attrs:{...}}` 三种形状。 */
  function readField(node, camel, kebab) {
    if (node[camel] !== undefined && node[camel] !== null) return node[camel]
    if (kebab !== undefined && node[kebab] !== undefined && node[kebab] !== null) return node[kebab]
    if (isPlainObject(node.attrs)) {
      if (node.attrs[camel] !== undefined && node.attrs[camel] !== null) return node.attrs[camel]
      if (kebab !== undefined && node.attrs[kebab] !== undefined && node.attrs[kebab] !== null) return node.attrs[kebab]
    }
    return undefined
  }

  /** 节点在原生合并列表里的绝对下标（data-index）；没有或非法返回 null。 */
  function indexOfNode(node) {
    // 优先读 data-index 的几种写法；裸 `index` 只作为调用方显式给下标的兜底，
    // 不能先读它——行原料上的 index 常常是「第几行」，与原生合并列表不是一回事。
    let raw = readField(node, 'dataIndex', 'data-index')
    if (raw === undefined) raw = readField(node, 'index', 'index')
    const value = toNumber(raw)
    if (value === null || !Number.isInteger(value) || value < 0) return null
    return value
  }

  /** 节点上的 aria-current 值。 */
  function ariaCurrentOf(node) {
    const raw = readField(node, 'ariaCurrent', 'aria-current')
    if (raw === true) return 'true'
    if (raw === false || raw === null || raw === undefined) return ''
    return String(raw)
  }

  /** 节点是否活动。 */
  function isActiveNode(node) {
    if (node.active === true) return true
    const current = ariaCurrentOf(node)
    return current === 'true' || current === 'page'
  }

  /** 节点上可用于解析轮号的机器文案（绝不含用户正文）。 */
  function machineLabelOf(node) {
    const raw = readField(node, 'ariaLabel', 'aria-label')
    if (typeof raw === 'string' && raw.trim() !== '') return raw
    const title = readField(node, 'title', 'title')
    if (typeof title === 'string' && title.trim() !== '') return title
    return ''
  }

  /**
   * 解析一轮的轮号。
   *
   * 优先级（每一级都写明了来源，便于失配时排查）：
   * 1. 节点自带 `turn`（宿主以后若暴露 data-turn，直接可用）；
   * 2. `options.turns[index]`——调用方给出的「与原生同源的升序轮次表」，
   *    这是唯一正确的 data-index → turn 映射方式（下标查表，**不是 dataIndex+1**）；
   * 3. aria-label / title 里的「第 N 轮」正则；
   * 4. 降级：按节点在**本次快照里的先后顺序**编号（第 i 个节点 → i+1）。
   *
   * 第 4 级是降级路径：虚拟化后快照可能从第 40 个按钮开始，此时顺序编号会
   * 与真实轮号错开；界面据此只保证「可点击、有刻度」，不保证轮号准确。
   *
   * @param {object} node - 节点描述。
   * @param {number[]|null} turns - 与原生同源的升序轮次表。
   * @param {number} index - 节点的绝对下标（data-index，缺失时为快照位置）。
   * @param {number} position - 节点在快照里的位置（0-based）。
   * @returns {number} 轮号（一定 ≥ 1）。
   */
  function resolveTurn(node, turns, index, position) {
    const explicit = toNumber(node.turn)
    if (explicit !== null && explicit > 0) return explicit
    if (Array.isArray(turns)) {
      const mapped = toNumber(turns[index])
      if (mapped !== null && mapped > 0) return mapped
    }
    const fromLabel = turnOfLabel(machineLabelOf(node))
    if (fromLabel !== null && fromLabel > 0) return fromLabel
    return position + 1
  }

  /** 节点上的时间显示文本。 */
  function timeTextOf(node) {
    const explicit = readField(node, 'timeText', 'time-text')
    if (typeof explicit === 'string' && explicit.trim() !== '') return compress(explicit)
    // 优先该轮**开始**时间：长轮次用结束时间会显示成"半小时后"，不符合直觉。
    const startedAt = readField(node, 'start')
    if (typeof startedAt === 'number' && Number.isFinite(startedAt)) return clockText(startedAt)
    const raw = readField(node, 'time', 'time')
    if (typeof raw === 'string') {
      const text = raw.trim()
      if (text === '') return ''
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text)) return text.slice(0, 5)
      const parsed = Date.parse(text)
      return Number.isFinite(parsed) ? clockText(parsed) : compress(text)
    }
    if (typeof raw === 'number' && Number.isFinite(raw)) return clockText(raw)
    return ''
  }

  /** 节点上的摘要文本（promptHead 优先，其次调用方给的 label/text）。 */
  function labelOf(node) {
    for (const key of ['promptHead', 'label', 'text']) {
      const value = node[key]
      if (typeof value === 'string' && value.trim() !== '') return compress(value)
    }
    return ''
  }

  /**
   * 把节点描述映射成轨行。
   *
   * 节点可以是原生按钮的快照（`{dataIndex, ariaLabel, ariaCurrent}`），也可以是
   * 调用方用轮次大纲拼出来的行原料（`{turn, promptHead, time}`）。函数只做归一，
   * 不关心来源；**行序 = 节点序**，不去重、不排序——排序由调用方决定，避免
   * 「DOM 顺序」与「轮号顺序」被悄悄混为一谈。
   *
   * 行模型：
   * - `index`：节点在原生合并列表里的绝对下标（有 data-index 用它，否则用快照位置）；
   * - `turn`：轮号，永不缺失（最差走顺序编号降级）；
   * - `label`：摘要（promptHead / label / text，压缩空白；没有就空串）；
   * - `active`：是否当前轮（`active:true` 或 `aria-current="true"/"page"`）；
   * - `timeText`：时间显示文本（HH:MM 或调用方给的原样文本；没有就空串）；
   * - `hit`：是否命中（透传 `node.hit === true`，供命中标记用；默认 false）。
   *
   * @param {Array<object>} nodes - 节点描述数组。
   * @param {object} [options] - 选项。
   * @param {Array<number|string>} [options.turns] - 与原生同源的升序轮次表（data-index → turn）。
   * @returns {Array<{index:number, turn:number, label:string, active:boolean, timeText:string, hit:boolean}>} 行模型。
   */
  function rowsOf(nodes, options) {
    const list = Array.isArray(nodes) ? nodes : []
    const settings = isPlainObject(options) ? options : {}
    const turns = Array.isArray(settings.turns) ? settings.turns : null
    const rows = []
    for (let position = 0; position < list.length; position += 1) {
      const node = isPlainObject(list[position]) ? list[position] : {}
      const dataIndex = indexOfNode(node)
      const index = dataIndex === null ? position : dataIndex
      const turn = resolveTurn(node, turns, index, position)
      rows.push({
        index,
        turn,
        label: labelOf(node),
        active: isActiveNode(node),
        timeText: timeTextOf(node),
        hit: node.hit === true,
      })
    }
    return rows
  }

  /**
   * 活动行在行数组里的位置。
   *
   * 返回的是**数组下标**（给滚动/高亮用），不是 `row.index`、也不是轮号。
   * 没有任何行活动时返回 -1（虚拟化把活动刻度移出 DOM 时就会这样）。
   *
   * @param {Array<object>} rows - `rowsOf` 的行数组。
   * @returns {number} 数组下标；没有活动行 -1。
   */
  function activeIndexOf(rows) {
    if (!Array.isArray(rows)) return -1
    for (let i = 0; i < rows.length; i += 1) {
      if (isPlainObject(rows[i]) && rows[i].active === true) return i
    }
    return -1
  }

  /**
   * 某一轮在行数组里的锚点位置。
   *
   * 点击跳转后用它把该行滚进轨道的可视区；纯查表，找不到返回 -1。
   * 返回数组下标，与 `activeIndexOf` 同一套坐标。
   *
   * @param {Array<object>} rows - `rowsOf` 的行数组。
   * @param {number|string} turn - 轮号。
   * @returns {number} 数组下标；该轮不在行里 -1。
   */
  function anchorFor(rows, turn) {
    if (!Array.isArray(rows)) return -1
    const target = toNumber(turn)
    if (target === null) return -1
    for (let i = 0; i < rows.length; i += 1) {
      if (isPlainObject(rows[i]) && toNumber(rows[i].turn) === target) return i
    }
    return -1
  }

  /**
   * 接管前自检。
   *
   * 只检查「能不能安全隐藏原生容器」这一件事，**不检查轮号是否准确**：
   * 轮号解析失败还有顺序编号降级，属于「能接管」；容器或按钮缺失则会
   * 变出一个空轨，那才是失配。失配时调用方必须**不隐藏原生**、继续用原生，
   * 并把这句 `reason` 写进界面底部一行灰字。
   *
   * @param {object} snapshot - 快照。
   * @param {*} [snapshot.container] - 原生轨道容器（nav）。
   * @param {Array<object>} [snapshot.buttons] - 容器内的轮次按钮快照。
   * @returns {{ok:boolean, code:string, reason:string}} 自检结果（`reason` 面向界面）。
   */
  function selfCheck(snapshot) {
    const input = isPlainObject(snapshot) ? snapshot : {}
    const container = input.container
    if (container === null || container === undefined) {
      return { ok: false, code: 'no-container', reason: '未找到原生导航轨容器' }
    }
    const buttons = Array.isArray(input.buttons) ? input.buttons : null
    if (buttons === null || buttons.length === 0) {
      return { ok: false, code: 'no-buttons', reason: '原生导航轨没有轮次按钮' }
    }
    let indexed = 0
    for (const button of buttons) {
      if (!isPlainObject(button)) continue
      const raw = readField(button, 'dataIndex', 'data-index')
      if (toNumber(raw) !== null) indexed += 1
    }
    if (indexed === 0) {
      return { ok: false, code: 'no-index', reason: '原生轮次按钮缺少 data-index' }
    }
    return { ok: true, code: 'ok', reason: '' }
  }

  /** 读取一段的起止轮号；兼容 startTurn/endTurn 与 turnRange，非法返回 null。 */
  function segmentBoundsOf(segment) {
    if (!isPlainObject(segment)) return null
    let start = toNumber(segment.startTurn)
    let end = toNumber(segment.endTurn)
    if ((start === null || end === null) && Array.isArray(segment.turnRange) && segment.turnRange.length >= 2) {
      start = toNumber(segment.turnRange[0])
      end = toNumber(segment.turnRange[1])
    }
    if (start === null || end === null) return null
    start = Math.trunc(start)
    end = Math.trunc(end)
    if (end < start) {
      const tmp = start
      start = end
      end = tmp
    }
    return { startTurn: start, endTurn: end }
  }

  /** 兜底段标题（如「第 1–3 轮」或「第 4 轮」）。 */
  function fallbackSegmentTitle(startTurn, endTurn) {
    return startTurn === endTurn ? ('第 ' + startTurn + ' 轮') : ('第 ' + startTurn + '–' + endTurn + ' 轮')
  }

  /**
   * 把历史轨行列表与 `/session-outline` 返回的 `segments` 组合成「段头 → 轮次行」两级目录模型。
   *
   * - 无 segments、空 rows，或 segments 与 rows 毫无交集时，平滑退回空数组 `[]`，
   *   调用方可无条件回退到原有扁平 `rows` 渲染；
   * - 若有部分连续轮次尚未被 segments 覆盖（例如刚新增的尾部轮次），自动补齐相邻未覆盖段，
   *   保证绝不丢失任何轮次行；
   * - 纯函数，不修改入参。
   *
   * @param {Array<object>} rows - `rowsOf` 产出的行数组。
   * @param {Array<object>} segments - `/session-outline` 返回的段数组。
   * @returns {Array<{id:string, title:string, startTurn:number, endTurn:number, turnCount:number, kindCandidate:'work'|'chat', hasError:boolean, active:boolean, rows:Array<object>}>}
   */
  function segmentGroupsOf(rows, segments) {
    const rowList = Array.isArray(rows) ? rows.filter(isPlainObject) : []
    const segList = Array.isArray(segments) ? segments.filter(isPlainObject) : []
    if (rowList.length === 0 || segList.length === 0) return []

    // 解析合法段并保留原次序（同一轮优先归入第一个覆盖它的段）
    const parsedSegments = []
    for (let i = 0; i < segList.length; i += 1) {
      const seg = segList[i]
      const bounds = segmentBoundsOf(seg)
      if (bounds === null) continue
      const errorTurns = new Set()
      if (Array.isArray(seg.errorTurns)) {
        for (const value of seg.errorTurns) {
          const turn = toNumber(value)
          if (turn !== null) errorTurns.add(Math.trunc(turn))
        }
      }
      const rawId = typeof seg.id === 'string' && seg.id.trim() !== '' ? seg.id.trim() : ''
      const rawTitle = typeof seg.title === 'string' ? compress(seg.title) : ''
      parsedSegments.push({
        id: rawId !== '' ? rawId : ('seg-' + bounds.startTurn + '-' + bounds.endTurn + '-' + i),
        title: rawTitle !== '' ? rawTitle : fallbackSegmentTitle(bounds.startTurn, bounds.endTurn),
        startTurn: bounds.startTurn,
        endTurn: bounds.endTurn,
        kindCandidate: seg.kindCandidate === 'work' ? 'work' : 'chat',
        hasError: seg.hasError === true || errorTurns.size > 0,
        errorTurns,
        matchedRows: [],
        firstPos: -1,
      })
    }
    if (parsedSegments.length === 0) return []

    // 将每一行分配到覆盖它的段；记录未被任何段覆盖的行位置
    const ownerOfPos = new Array(rowList.length).fill(-1)
    let coveredCount = 0
    for (let pos = 0; pos < rowList.length; pos += 1) {
      const row = rowList[pos]
      const turn = toNumber(row.turn)
      if (turn === null) continue
      const t = Math.trunc(turn)
      for (let s = 0; s < parsedSegments.length; s += 1) {
        const seg = parsedSegments[s]
        if (t >= seg.startTurn && t <= seg.endTurn) {
          ownerOfPos[pos] = s
          seg.matchedRows.push(row)
          if (seg.firstPos < 0) seg.firstPos = pos
          coveredCount += 1
          break
        }
      }
    }

    // segments 未覆盖任何一行时平滑退回空数组
    if (coveredCount === 0) return []

    // 按 rows 出现顺序组装段，并把连续未覆盖的孤立行收集为兜底段，避免静默丢行
    const groups = []
    const emitted = new Set()
    let orphanRows = []

    const flushOrphans = () => {
      if (orphanRows.length === 0) return
      const turns = orphanRows
        .map(r => toNumber(r.turn))
        .filter(v => v !== null)
        .map(Math.trunc)
      const startTurn = turns.length > 0 ? Math.min(...turns) : 1
      const endTurn = turns.length > 0 ? Math.max(...turns) : startTurn
      const hasError = orphanRows.some(r => r.hasError === true)
      const active = orphanRows.some(r => r.active === true)
      groups.push({
        id: 'seg-orphan-' + startTurn + '-' + endTurn + '-' + groups.length,
        title: fallbackSegmentTitle(startTurn, endTurn),
        startTurn,
        endTurn,
        turnCount: orphanRows.length,
        kindCandidate: 'chat',
        hasError,
        active,
        rows: orphanRows.slice(),
      })
      orphanRows = []
    }

    for (let pos = 0; pos < rowList.length; pos += 1) {
      const owner = ownerOfPos[pos]
      if (owner < 0) {
        orphanRows.push(rowList[pos])
        continue
      }
      flushOrphans()
      if (emitted.has(owner)) continue
      emitted.add(owner)
      const seg = parsedSegments[owner]
      const segRows = seg.matchedRows.slice()
      const hasError = seg.hasError || segRows.some(r => {
        if (r.hasError === true) return true
        const t = toNumber(r.turn)
        return t !== null && seg.errorTurns.has(Math.trunc(t))
      })
      const active = segRows.some(r => r.active === true)
      groups.push({
        id: seg.id,
        title: seg.title,
        startTurn: seg.startTurn,
        endTurn: seg.endTurn,
        turnCount: segRows.length,
        kindCandidate: seg.kindCandidate,
        hasError,
        active,
        rows: segRows,
      })
    }
    flushOrphans()

    return groups
  }

      return {
        TIER_WIDTHS: TIER_WIDTHS, tierOf: tierOf, snapWidth: snapWidth,
        turnOfLabel: turnOfLabel, rowsOf: rowsOf, activeIndexOf: activeIndexOf,
        anchorFor: anchorFor, selfCheck: selfCheck, segmentGroupsOf: segmentGroupsOf,
      }
    })()
    // ══ rail-view 生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/stats-format.js
    // 统计页格式化（页头四卡 / 会话行 / 用量拆分），纯函数，
    // 独立测试过（tests/stats-format.mjs）。
    var STATSFMT = (function () {
  const MINUTE = 60 * 1000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  /** 「更早」阈值：超过 30 天不再报具体天数（与统计页停滞口径一致）。 */
  const EARLIER_DAYS = 30

  const UNKNOWN_RELATIVE = '未知'

  /** 会话行默认上限（Top 列表一屏的量）。 */
  const DEFAULT_ROW_LIMIT = 10

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

  /** 非负有限值；缺失 / 负数 / NaN 一律记 0。 */
  function toNonNegative(value) {
    if (value === null || value === undefined || value === '') return 0
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return 0
    return number
  }

  /** 非负整数（轮数 / 会话数）；缺失或非法记 0。 */
  function toCount(value) {
    return Math.trunc(toNonNegative(value))
  }

  /** 统一成可显示文本；对象 / null 返回空串。 */
  function textOf(value) {
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return ''
  }

  /** 压缩连续空白。 */
  function compress(value) {
    return textOf(value).replace(/\s+/g, ' ').trim()
  }

  /** 保留一位小数并去掉 `.0`（1.234 → 1.2，2 → 2）。 */
  function trimOneDecimal(value) {
    const rounded = Math.round(value * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  }

  /**
   * 紧凑数字：`0` / `999` / `1.2k` / `12.3k` / `1.2M`。
   *
   * 与 `lib/stats-view.js` 的 `formatCompact` 同口径：四舍五入到一位小数、
   * 999.95 这类进位值直接升档，不输出 `1000k`。
   *
   * @param {number} value - 数字。
   * @returns {string} 紧凑文案；非法输入记 `0`。
   */
  function compactNumber(value) {
    const number = Number(value)
    if (!Number.isFinite(number)) return '0'
    const sign = number < 0 ? '-' : ''
    const abs = Math.abs(number)
    const rounded = Math.round(abs)
    if (rounded < 1000) return `${sign}${rounded}`
    if (rounded < 1000000) {
      const thousands = Math.round(abs / 100) / 10
      if (thousands < 1000) return `${sign}${trimOneDecimal(thousands)}k`
    }
    const millions = Math.round(abs / 100000) / 10
    return `${sign}${trimOneDecimal(millions)}M`
  }

  /**
   * 千分位整数：`0` / `999` / `1,234` / `123,456`。
   *
   * @param {number} value - 数字。
   * @returns {string} 千分位文案；非法输入记 `0`。
   */
  function thousands(value) {
    const number = Math.trunc(Number(value))
    if (!Number.isFinite(number)) return '0'
    const sign = number < 0 ? '-' : ''
    return sign + String(Math.abs(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  /**
   * 费用：`$0.00` / `$1.23` / `$12.3` / `<$0.01`。
   *
   * 与 `lib/stats-view.js` 的 `formatCost` 同口径。
   *
   * @param {number} value - 金额（美元）。
   * @returns {string} 费用文案。
   */
  function costText(value) {
    const amount = Number(value)
    if (!Number.isFinite(amount)) return '$0.00'
    const sign = amount < 0 ? '-' : ''
    const abs = Math.abs(amount)
    if (abs === 0) return '$0.00'
    if (abs < 0.01) return '<$0.01'
    const rounded = Math.round(abs * 100) / 100
    if (rounded >= 10) return `${sign}$${(Math.round(rounded * 10) / 10).toFixed(1)}`
    return `${sign}$${rounded.toFixed(2)}`
  }

  /**
   * 相对时间：`刚刚` / `N 分钟前` / `N 小时前` / `N 天前` / `更早`。
   *
   * - 未来时间与 1 分钟内都算「刚刚」；
   * - 分钟 / 小时向下取整；超过 30 天统一「更早」；
   * - 任一时间非法返回「未知」，不读系统时钟。
   *
   * @param {number|Date} ms - 目标时间。
   * @param {number|Date} now - 参照时间。
   * @returns {string} 相对时间文案。
   */
  function formatRelative(ms, now) {
    const target = toMs(ms)
    const base = toMs(now)
    if (!Number.isFinite(target) || !Number.isFinite(base)) return UNKNOWN_RELATIVE
    const diff = base - target
    if (diff < MINUTE) return '刚刚'
    if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
    if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
    const days = Math.floor(diff / DAY)
    return days <= EARLIER_DAYS ? `${days} 天前` : '更早'
  }

  /**
   * 统计页头四卡：会话数、轮次数、活跃天数、总用量。
   *
   * 兼容 `buildStats()` 的 `{totals}` 包装与直接 totals 两种输入。
   * 计数用千分位，用量用紧凑数字；`now` 不参与页头，活跃天数按调用方口径直出。
   *
   * @param {object} stats - 统计模型或 totals。
   * @returns {{label: string, value: string, hint: string}[]} 四张卡片。
   */
  function statsHeadline(stats) {
    const source = isPlainObject(stats) ? stats : {}
    const totals = isPlainObject(source.totals) ? source.totals : source
    const tokens = isPlainObject(totals.tokens) ? totals.tokens : {}
    const sessions = toCount(totals.sessions)
    const turns = toCount(totals.turns)
    const activeDays = toCount(totals.activeDays)
    const input = toNonNegative(tokens.input)
    const output = toNonNegative(tokens.output)
    const total = input + output > 0 ? input + output : toNonNegative(tokens.total)
    const cost = toNonNegative(totals.cost)

    let usageHint = `输入 ${compactNumber(input)} · 输出 ${compactNumber(output)}`
    if (cost > 0) usageHint += ` · ${costText(cost)}`

    return [
      { label: '会话数', value: thousands(sessions), hint: '工作区内的会话' },
      { label: '轮次数', value: thousands(turns), hint: '累计对话轮次' },
      { label: '活跃天数', value: `${thousands(activeDays)} 天`, hint: '有活动的自然日' },
      { label: '总用量', value: `${compactNumber(total)} tokens`, hint: usageHint },
    ]
  }

  /** 行上限归一：缺省 10，非法回 10，显式 0 / 负数表示不显示。 */
  function normalizeLimit(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_ROW_LIMIT
    const number = Number(value)
    if (!Number.isFinite(number)) return DEFAULT_ROW_LIMIT
    return Math.max(0, Math.floor(number))
  }

  /** 会话轮数：认 `turnCount` 与 `turns` 两种字段名。 */
  function turnsOf(session) {
    return toCount(session.turnCount ?? session.turns)
  }

  /**
   * 统计页会话行：标题、轮数、最近活动、相对最大值 bar。
   *
   * - 保持调用方给的顺序（`topSessions` 已排好），只按 `limit` 截断；
   * - `barPercent` 以**完整输入列表**的最大轮数为分母计算，再夹到 0–100；
   * - 轮数为 0 或全为 0 时 bar 记 0，不会出现除零。
   *
   * @param {object[]} topSessions - 会话行输入 `[{title, turnCount|turns, lastActivity}]`。
   * @param {object} [options] - 选项。
   * @param {number|Date} [options.now] - 参照时间；缺省时相对时间显示「未知」。
   * @param {number} [options.limit=10] - 最多返回几行。
   * @returns {{title: string, turns: string, lastActiveText: string, barPercent: number}[]} 可渲染行。
   */
  function statsRows(topSessions, options) {
    const opts = isPlainObject(options) ? options : {}
    const list = (Array.isArray(topSessions) ? topSessions : []).filter(isPlainObject)
    const limit = normalizeLimit(opts.limit)
    const now = toMs(opts.now)

    let maxTurns = 0
    for (const session of list) {
      const turns = turnsOf(session)
      if (turns > maxTurns) maxTurns = turns
    }

    return list.slice(0, limit).map(session => {
      const turns = turnsOf(session)
      const barPercent = maxTurns > 0
        ? Math.min(100, Math.max(0, Math.round((turns / maxTurns) * 100)))
        : 0
      return {
        title: compress(session.title) || '未命名会话',
        turns: thousands(turns),
        lastActiveText: formatRelative(session.lastActivity, now),
        barPercent,
      }
    })
  }

  /**
   * 用量拆分：输入 / 输出 / 总量文本 + 输出占比。
   *
   * `ratio` 是输出 token 占总量（input+output）的比例，保留两位小数（0–1）；
   * 同时给了 input/output 时不信上游声明的 total，避免缓存 token 重复计数。
   *
   * @param {object} usage - `{input, output, total?}`。
   * @returns {{inputText: string, outputText: string, totalText: string, ratio: number}} 拆分结果。
   */
  function usageSplit(usage) {
    const source = isPlainObject(usage) ? usage : {}
    const input = toNonNegative(source.input)
    const output = toNonNegative(source.output)
    const declared = toNonNegative(source.total)
    const total = input + output > 0 ? input + output : declared
    const ratio = total > 0 ? Math.round((output / total) * 100) / 100 : 0
    return {
      inputText: compactNumber(input),
      outputText: compactNumber(output),
      totalText: compactNumber(total),
      ratio,
    }
  }

      return {
        formatRelative: formatRelative, statsHeadline: statsHeadline,
        statsRows: statsRows, usageSplit: usageSplit,
      }
    })()
    // ══ stats-format 生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/settings-view.js
    // 设置表单模型（分组 / 单字段校验 / 只提交差异），纯函数，
    // 独立测试过（tests/settings-view.mjs）。
    var SETTINGVIEW = (function () {
  const DEFAULT_TURN_LIMIT = 50
  const TURN_LIMIT_MIN = 5
  const TURN_LIMIT_MAX = 500

  const DEFAULT_QUOTE_MAX_COUNT = 5
  const QUOTE_MAX_COUNT_MIN = 1
  const QUOTE_MAX_COUNT_MAX = 20

  const DEFAULT_QUOTE_MAX_CHARS = 2400
  const QUOTE_MAX_CHARS_MIN = 400
  const QUOTE_MAX_CHARS_MAX = 8000

  const DEFAULT_DORMANT_DAYS = 14
  const DORMANT_DAYS_MIN = 0
  const DORMANT_DAYS_MAX = 365

  /** 自动沉降天数预设选项（也允许在 0–365 之间自定义整数）。 */
  const DORMANT_DAYS_OPTIONS = Object.freeze([
    { value: 7, label: '7 天' },
    { value: 14, label: '14 天（默认）' },
    { value: 30, label: '30 天' },
    { value: 0, label: '从不自动沉降(0)' },
  ])

  const DEFAULT_INFLECTION_NOTICE = true

  const DIGEST_LEVELS = ['compact', 'standard', 'rich']
  const DEFAULT_DIGEST_LEVEL = 'standard'

  /** 摘要档位选项（文案里直接写清字数，用户不必再记常量）。 */
  const DIGEST_LEVEL_OPTIONS = Object.freeze([
    { value: 'compact', label: '精简（200 字）' },
    { value: 'standard', label: '标准（400 字）' },
    { value: 'rich', label: '详尽（800 字）' },
  ])

  /** 是否普通对象（排除 null / 数组）。 */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** 统一成可显示文本；对象 / null 返回空串。 */
  function textOf(value) {
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return ''
  }

  /** 去首尾空白后的字符串。 */
  function trimText(value) {
    return textOf(value).trim()
  }

  /**
   * 严格数字：认有限数字与数字字符串，拒绝空串 / 布尔 / null / 对象。
   *
   * @param {*} value - 原始值。
   * @returns {number|null} 有限数字或 null。
   */
  function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string' && value.trim() !== '') {
      const number = Number(value.trim())
      return Number.isFinite(number) ? number : null
    }
    return null
  }

  /** 取整并夹到 [min, max]；非法回默认。 */
  function clampInt(value, min, max, fallback) {
    const number = toNumber(value)
    if (number === null) return fallback
    return Math.min(max, Math.max(min, Math.floor(number)))
  }

  /** 摘要档位归一：非法回 standard。 */
  function normalizeDigestLevel(value) {
    return DIGEST_LEVELS.includes(value) ? value : DEFAULT_DIGEST_LEVEL
  }

  /**
   * 宽松布尔解析：只认明确的真 / 假表示，其它返回 null（交给调用方报错）。
   *
   * @param {*} value - 原始值。
   * @returns {boolean|null} true / false / null。
   */
  function toBoolean(value) {
    if (typeof value === 'boolean') return value
    if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1
    if (typeof value === 'string') {
      const text = value.trim().toLowerCase()
      if (text === 'true' || text === '1' || text === 'on') return true
      if (text === 'false' || text === '0' || text === 'off') return false
    }
    return null
  }

  /**
   * 生成设置表单模型。
   *
   * 每次返回全新对象，输入配置只读；模型组四项均为 `type:'readonly'`，
   * 其中 `apiKey` 只显示「已设置 / 未设置」，序列化整个模型也拿不到明文。
   *
   * @param {object} [config] - 当前配置（可缺项、可含越界值）。
   * @returns {{groups: object[]}} 分组表单模型。
   */
  function settingsModel(config) {
    const c = isPlainObject(config) ? config : {}
    const provider = trimText(c.provider)
    const model = trimText(c.model)
    const baseUrl = trimText(c.baseUrl)
    const apiKeySet = trimText(c.apiKey) !== ''

    const inflectionNotice = toBoolean(c.inflectionNotice)

    return {
      groups: [
        {
          id: 'work',
          title: '续接与事',
          items: [
            {
              key: 'dormantDays',
              label: '自动沉降天数',
              type: 'select',
              value: clampInt(c.dormantDays, DORMANT_DAYS_MIN, DORMANT_DAYS_MAX, DEFAULT_DORMANT_DAYS),
              default: DEFAULT_DORMANT_DAYS,
              min: DORMANT_DAYS_MIN,
              max: DORMANT_DAYS_MAX,
              options: DORMANT_DAYS_OPTIONS.map(option => ({ ...option })),
              help: '推测态且未置顶的事超过此天数无活动时自动转入已搁置；0 表示从不自动沉降',
            },
            {
              key: 'inflectionNotice',
              label: '拐点轻确认提示',
              type: 'boolean',
              value: inflectionNotice === null ? DEFAULT_INFLECTION_NOTICE : inflectionNotice,
              default: DEFAULT_INFLECTION_NOTICE,
              help: '切换话题、疑似收尾/卡住或重返未收束会话时，在顶部显示非阻塞轻确认条',
            },
          ],
        },
        {
          id: 'model',
          title: '模型',
          items: [
            {
              key: 'provider',
              label: '服务商',
              type: 'readonly',
              value: provider === '' ? '跟随当前会话' : provider,
              default: '跟随当前会话',
              help: '空值表示跟随当前会话使用的模型',
            },
            {
              key: 'model',
              label: '模型',
              type: 'readonly',
              value: model === '' ? '跟随当前会话' : model,
              default: '跟随当前会话',
              help: '空值表示跟随当前会话使用的模型',
            },
            {
              key: 'baseUrl',
              label: '接口地址',
              type: 'readonly',
              value: baseUrl === '' ? '未设置' : baseUrl,
              default: '未设置',
              help: '自定义端点需要接口地址与模型名同时填写才生效',
            },
            {
              key: 'apiKey',
              label: '密钥',
              type: 'readonly',
              value: apiKeySet ? '已设置' : '未设置',
              default: '未设置',
              help: '只读展示状态，密钥不会在界面回显明文',
            },
          ],
        },
        {
          id: 'index',
          title: '索引',
          items: [
            {
              key: 'turnLimit',
              label: '分析轮次上限',
              type: 'number',
              value: clampInt(c.turnLimit, TURN_LIMIT_MIN, TURN_LIMIT_MAX, DEFAULT_TURN_LIMIT),
              default: DEFAULT_TURN_LIMIT,
              min: TURN_LIMIT_MIN,
              max: TURN_LIMIT_MAX,
              help: '每次分析最多读取的最近轮次数',
            },
            {
              key: 'rebuildIndex',
              label: '重建索引',
              type: 'button',
              value: '重建索引',
              default: '重建索引',
              help: '清空并重新建立检索索引；不影响会话记录',
            },
          ],
        },
        {
          id: 'quote',
          title: '引用',
          items: [
            {
              key: 'digestLevel',
              label: '摘要档位',
              type: 'select',
              value: normalizeDigestLevel(c.digestLevel),
              default: DEFAULT_DIGEST_LEVEL,
              options: DIGEST_LEVEL_OPTIONS.map(option => ({ ...option })),
              help: '单条引用注入的摘要长度；命令由程序按档位追加',
            },
            {
              key: 'quoteMaxCount',
              label: '单条消息引用条数',
              type: 'number',
              value: clampInt(
                c.quoteMaxCount,
                QUOTE_MAX_COUNT_MIN,
                QUOTE_MAX_COUNT_MAX,
                DEFAULT_QUOTE_MAX_COUNT,
              ),
              default: DEFAULT_QUOTE_MAX_COUNT,
              min: QUOTE_MAX_COUNT_MIN,
              max: QUOTE_MAX_COUNT_MAX,
              help: '一条消息最多自动展开几条引用；先到者停',
            },
            {
              key: 'quoteMaxChars',
              label: '单条消息引用字数',
              type: 'number',
              value: clampInt(
                c.quoteMaxChars,
                QUOTE_MAX_CHARS_MIN,
                QUOTE_MAX_CHARS_MAX,
                DEFAULT_QUOTE_MAX_CHARS,
              ),
              default: DEFAULT_QUOTE_MAX_CHARS,
              min: QUOTE_MAX_CHARS_MIN,
              max: QUOTE_MAX_CHARS_MAX,
              help: '一条消息最多展开多少字引用；与条数配额先到者生效',
            },
          ],
        },
        {
          id: 'ui',
          title: '界面',
          items: [
            {
              key: 'railNative',
              label: '恢复原生导航轨',
              type: 'boolean',
              value: toBoolean(c.railNative) === true,
              default: false,
              help: '开启后不再接管会话右缘的轮次导航，改用宿主原生控件',
            },
          ],
        },
      ],
    }
  }

  /**
   * 应用一项设置：类型转换 + 范围校验；失败时返回中文错误且配置保持原样。
   *
   * `config` 不被修改；成功时返回浅拷贝后的新配置。
   *
   * @param {object} config - 当前配置。
   * @param {string} key - 设置键。
   * @param {*} raw - 表单原始值（字符串 / 数字 / 布尔均可）。
   * @returns {{config: object, error?: string}} 新配置或错误。
   */
  function applySetting(config, key, raw) {
    const base = isPlainObject(config) ? config : {}
    /** 失败：返回未改动的配置副本，避免调用方误用半成品。 */
    const fail = message => ({ config: { ...base }, error: message })
    /** 成功：在副本上写一项。 */
    const ok = patch => ({ config: { ...base, ...patch } })

    switch (key) {
      case 'provider':
      case 'model':
      case 'baseUrl':
      case 'apiKey': {
        const value = raw === null || raw === undefined ? '' : trimText(raw)
        return ok({ [key]: value })
      }
      case 'digestLevel': {
        const value = typeof raw === 'string' ? raw.trim() : ''
        if (!DIGEST_LEVELS.includes(value)) {
          return fail('摘要档位需为 compact、standard 或 rich')
        }
        return ok({ digestLevel: value })
      }
      case 'turnLimit': {
        const number = toNumber(raw)
        if (number === null) return fail('分析轮次上限需为数字')
        const value = Math.floor(number)
        if (value < TURN_LIMIT_MIN || value > TURN_LIMIT_MAX) {
          return fail(`分析轮次上限需在 ${TURN_LIMIT_MIN}–${TURN_LIMIT_MAX} 之间`)
        }
        return ok({ turnLimit: value })
      }
      case 'quoteMaxCount': {
        const number = toNumber(raw)
        if (number === null) return fail('引用条数需为数字')
        const value = Math.floor(number)
        if (value < QUOTE_MAX_COUNT_MIN || value > QUOTE_MAX_COUNT_MAX) {
          return fail(`引用条数需在 ${QUOTE_MAX_COUNT_MIN}–${QUOTE_MAX_COUNT_MAX} 之间`)
        }
        return ok({ quoteMaxCount: value })
      }
      case 'quoteMaxChars': {
        const number = toNumber(raw)
        if (number === null) return fail('引用字数需为数字')
        const value = Math.floor(number)
        if (value < QUOTE_MAX_CHARS_MIN || value > QUOTE_MAX_CHARS_MAX) {
          return fail(`引用字数需在 ${QUOTE_MAX_CHARS_MIN}–${QUOTE_MAX_CHARS_MAX} 之间`)
        }
        return ok({ quoteMaxChars: value })
      }
      case 'dormantDays': {
        const number = toNumber(raw)
        if (number === null) return fail('自动沉降天数需为数字')
        const value = Math.floor(number)
        if (value < DORMANT_DAYS_MIN || value > DORMANT_DAYS_MAX) {
          return fail(`自动沉降天数需在 ${DORMANT_DAYS_MIN}–${DORMANT_DAYS_MAX} 之间`)
        }
        return ok({ dormantDays: value })
      }
      case 'inflectionNotice': {
        const value = toBoolean(raw)
        if (value === null) return fail('inflectionNotice 需为 true 或 false')
        return ok({ inflectionNotice: value })
      }
      case 'railNative': {
        const value = toBoolean(raw)
        if (value === null) return fail('railNative 需为 true 或 false')
        return ok({ railNative: value })
      }
      default:
        return fail(`未知设置项：${String(key)}`)
    }
  }

  /** 浅层值相等：原始值用 Object.is，普通对象 / 数组递归比较。 */
  function sameValue(left, right) {
    if (Object.is(left, right)) return true
    if (isPlainObject(left) && isPlainObject(right)) {
      const leftKeys = Object.keys(left)
      const rightKeys = Object.keys(right)
      if (leftKeys.length !== rightKeys.length) return false
      return leftKeys.every(key => (
        Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key])
      ))
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      return left.length === right.length && left.every((entry, index) => sameValue(entry, right[index]))
    }
    return false
  }

  /**
   * 只挑出 `after` 里发生变化的键值。
   *
   * 以 `after` 为准（调用方给它一份完整配置）：`before` 里没有的键也算变化；
   * `after` 缺少的键视为本次未提交，不进 POST。
   *
   * @param {object} before - 修改前配置。
   * @param {object} after - 修改后配置。
   * @returns {object} 变化项；无变化返回 `{}`。
   */
  function diffConfig(before, after) {
    const previous = isPlainObject(before) ? before : {}
    const next = isPlainObject(after) ? after : {}
    const changes = {}
    for (const key of Object.keys(next)) {
      if (!Object.prototype.hasOwnProperty.call(previous, key) || !sameValue(previous[key], next[key])) {
        changes[key] = next[key]
      }
    }
    return changes
  }

      return {
        settingsModel: settingsModel, applySetting: applySetting,
        diffConfig: diffConfig,
      }
    })()
    // ══ settings-view 生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/clue-view.js
    // 线索时间线视图模型（V-4），纯函数，独立测试过（tests/clue-view.mjs）。
    var CLUEVIEW = (function () {
  /** 默认最多显示多少条 cluster（时间线是浏览用的，不承接全量结果）。 */
  const DEFAULT_LIMIT = 200

  /** 提问头最多保留的码点数（含省略号）。 */
  const HEAD_LIMIT = 60

  const MINUTE = 60 * 1000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  /** 是否普通对象（排除 null / 数组）。 */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** 只接受字符串文本；数字、对象、null 一律当缺失，避免把对象写进界面。 */
  function textOf(value) {
    return typeof value === 'string' ? value : ''
  }

  /** 压缩连续空白（含换行），用于单行提问头与会话标题。 */
  function compress(value) {
    return textOf(value).replace(/\s+/g, ' ').trim()
  }

  /** 把时间统一成 epoch ms；认 Date 与有限数字，其余返回 NaN。 */
  function toMs(value) {
    if (value instanceof Date) return value.getTime()
    if (typeof value === 'number' && Number.isFinite(value)) return value
    return NaN
  }

  /** 轮号：认数字与数字字符串；空白 / 非法返回 null（不悄悄当 0）。 */
  function toTurn(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null
    if (typeof value === 'string' && value.trim() !== '') {
      const number = Number(value)
      return Number.isFinite(number) ? number : null
    }
    return null
  }

  /** 主题词归一：字符串或数组，去空白；全空表示"没有主题词"。 */
  function keywordList(value) {
    const list = Array.isArray(value)
      ? value
      : (value === null || value === undefined ? [] : [value])
    const out = []
    for (const item of list) {
      if (typeof item !== 'string') continue
      const keyword = item.trim()
      if (keyword !== '') out.push(keyword)
    }
    return out
  }

  /** 显示条数：非法值回默认 200，负数按 0 处理。 */
  function normalizeLimit(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_LIMIT
    const number = Number(value)
    if (!Number.isFinite(number)) return DEFAULT_LIMIT
    return Math.max(0, Math.floor(number))
  }

  /** 本地自然日的 0 点。 */
  function startOfLocalDay(ms) {
    const date = new Date(ms)
    date.setHours(0, 0, 0, 0)
    return date.getTime()
  }

  /** 同一本地自然日。 */
  function sameLocalDay(a, b) {
    return startOfLocalDay(a) === startOfLocalDay(b)
  }

  /** 同一本地年份（跨年一律用绝对日期）。 */
  function sameLocalYear(a, b) {
    return new Date(a).getFullYear() === new Date(b).getFullYear()
  }

  /** 本地日期 `YYYY-MM-DD`。 */
  function formatDate(ms) {
    const date = new Date(ms)
    const year = String(date.getFullYear()).padStart(4, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  /**
   * 相对时间文案（与 `lib/hit-view.js` 的 `formatRelativeTime` 同口径）。
   *
   * 分档：刚刚 / N 分钟前 / N 小时前 / 今天 / 昨天 / N 天前 / 绝对日期。
   * `ts` 或 `now` 非法时返回空串——绝不回退到系统时钟。
   *
   * @param {number|Date} ts - 目标时间。
   * @param {number|Date} now - 参照时间。
   * @returns {string} 文案；参数非法时为空串。
   */
  function formatRelativeTime(ts, now) {
    const target = toMs(ts)
    const base = toMs(now)
    if (!Number.isFinite(target) || !Number.isFinite(base)) return ''
    const diff = base - target
    if (diff < 0) return sameLocalDay(target, base) ? '今天' : formatDate(target)
    if (diff < MINUTE) return '刚刚'
    if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
    if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
    const days = Math.round((startOfLocalDay(base) - startOfLocalDay(target)) / DAY)
    if (!sameLocalYear(target, base)) return formatDate(target)
    if (days <= 0) return '今天' // 夏令时等边界兜底
    if (days === 1) return '昨天'
    if (days < 7) return `${days} 天前`
    return formatDate(target)
  }

  /** 提问头：压缩空白后按码点截断，总长不超过 HEAD_LIMIT（含省略号）。 */
  function truncateHead(value) {
    const text = compress(value)
    const points = Array.from(text)
    if (points.length <= HEAD_LIMIT) return text
    return `${points.slice(0, HEAD_LIMIT - 1).join('')}…`
  }

  /** 空统计的固定形状（每次新建，调用方改自己的副本不会串）。 */
  function emptyStats() {
    return { sessions: 0, turns: 0, firstAt: null, lastAt: null, spanDays: 0 }
  }

  /**
   * 生成线索时间线。
   *
   * @param {Array<object>} rows - `[{sessionId, sessionTitle, turn, time, promptHead, endReason}]`，
   *   已按时间升序；没有可用 `time` 的行会被跳过（时间线无法定位它）。
   * @param {object} [options] - 选项。
   * @param {string|string[]} [options.keywords] - 主题词；为空时直接返回空视图。
   * @param {number|Date} [options.now] - 参照时间，用于 `timeText`；不传则留空。
   * @param {number} [options.limit=200] - 最多显示多少个 cluster（不影响 stats）。
   * @returns {{timeline: Array<object>, stats: object, empty: boolean}} 视图模型。
   */
  function buildClue(rows, options = {}) {
    const opts = isPlainObject(options) ? options : {}
    const keywords = keywordList(opts.keywords)
    if (keywords.length === 0) {
      return { timeline: [], stats: emptyStats(), empty: true }
    }

    const list = Array.isArray(rows) ? rows : []
    const now = toMs(opts.now)
    const limit = normalizeLimit(opts.limit)

    // 第一遍：筛掉没有可用时间的行，同时算"该会话的第几次提及"。
    // 次数按行累计，而不是按 cluster 累计；这样 cluster 里的第 2 条被合并后，
    // 后面的真实第 3 次仍然显示"第 3 次"。
    const mentions = new Map()
    const items = []
    for (const raw of list) {
      if (!isPlainObject(raw)) continue
      const time = toMs(raw.time)
      if (!Number.isFinite(time)) continue
      const sessionKey = raw.sessionId === null || raw.sessionId === undefined
        ? ''
        : String(raw.sessionId)
      const ordinal = (mentions.get(sessionKey) || 0) + 1
      mentions.set(sessionKey, ordinal)
      items.push({
        time,
        sessionKey,
        ordinal,
        turn: toTurn(raw.turn),
        head: truncateHead(raw.promptHead),
        sessionTitle: compress(raw.sessionTitle),
      })
    }

    // 第二遍：统计按"全部命中"算，limit 只影响显示条数。
    let firstAt = null
    let lastAt = null
    const sessions = new Set()
    for (const item of items) {
      sessions.add(item.sessionKey)
      if (firstAt === null || item.time < firstAt) firstAt = item.time
      if (lastAt === null || item.time > lastAt) lastAt = item.time
    }
    const spanDays = firstAt === null
      ? 0
      : Math.max(0, Math.round((startOfLocalDay(lastAt) - startOfLocalDay(firstAt)) / DAY))
    const stats = {
      sessions: sessions.size,
      turns: items.length,
      firstAt,
      lastAt,
      spanDays,
    }

    // 第三遍：相邻同会话同自然日合并成 cluster。
    const clusters = []
    let current = null
    for (const item of items) {
      const dayKey = formatDate(item.time)
      if (
        current !== null &&
        current.sessionKey === item.sessionKey &&
        current.dayKey === dayKey
      ) {
        current.count += 1
        current.lastTime = item.time
        if (item.turn !== null) current.turns.push(item.turn)
        continue
      }

      current = {
        sessionKey: item.sessionKey,
        dayKey,
        time: item.time,
        timeText: formatRelativeTime(item.time, now),
        sessionId: item.sessionKey,
        sessionTitle: item.sessionTitle,
        turn: item.turn,
        head: item.head,
        delta: item.ordinal === 1 ? '首次提及' : `第 ${item.ordinal} 次`,
        count: 1,
        turns: item.turn === null ? [] : [item.turn],
        lastTime: item.time,
      }
      clusters.push(current)
    }

    const timeline = clusters.slice(0, limit).map(cluster => ({
      time: cluster.time,
      timeText: cluster.timeText,
      sessionId: cluster.sessionId,
      sessionTitle: cluster.sessionTitle,
      turn: cluster.turn,
      head: cluster.head,
      delta: cluster.delta,
      count: cluster.count,
      turns: cluster.turns,
      lastTime: cluster.lastTime,
    }))

    return { timeline, stats, empty: timeline.length === 0 }
  }

      return {
        buildClue: buildClue,
      }
    })()
    // ══ clue-view 生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/changes-view.js
    // 变更清单视图模型（P3-1 / A-7），纯函数，独立测试过（tests/changes-view.mjs）。
    var CHANGESVIEW = (function () {
  /** 扩展名 → kind。只认契约列出的这些；其余一律 other。 */
  const EXT_KIND = new Map([
    ['js', 'code'], ['ts', 'code'], ['mjs', 'code'], ['py', 'code'],
    ['go', 'code'], ['rs', 'code'], ['java', 'code'], ['c', 'code'], ['h', 'code'],
    ['md', 'doc'], ['txt', 'doc'],
    ['json', 'config'], ['yml', 'config'], ['yaml', 'config'],
    ['toml', 'config'], ['ini', 'config'],
  ])

  /** 固定分组顺序。 */
  const KIND_ORDER = Object.freeze(['code', 'doc', 'config', 'other'])

  /** 分组中文名。 */
  const KIND_LABEL = Object.freeze({
    code: '代码',
    doc: '文档',
    config: '配置',
    other: '其他',
  })

  /** 明细不可读时的固定文案。 */
  const LOST_SUMMARY = '该轮变更明细已不可读'

  /** 没有变更时的固定文案。 */
  const EMPTY_SUMMARY = '该轮没有文件变更'

  /** 是否普通对象（排除 null / 数组）。 */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** 非负整数：接受数字与数字字符串；负数 / 非有限 / 空值一律 0。 */
  function toCount(value) {
    if (value === null || value === undefined || value === '') return 0
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return 0
    return Math.floor(number)
  }

  /**
   * 一条变更文件归一成 `{path, added, deleted}`。
   *
   * 兼容两种输入：契约里的对象，以及只给路径字符串的旧形状（按 ±0 处理）。
   * 路径去首尾空白但保留中间空格；空路径、非对象、非字符串一律丢弃。
   *
   * @param {*} value - 原始条目。
   * @returns {{path: string, added: number, deleted: number}|null} 归一结果。
   */
  function normalizeFile(value) {
    if (typeof value === 'string') {
      const path = value.trim()
      return path === '' ? null : { path, added: 0, deleted: 0 }
    }
    if (!isPlainObject(value)) return null
    const path = typeof value.path === 'string' ? value.path.trim() : ''
    if (path === '') return null
    return {
      path,
      added: toCount(value.added),
      deleted: toCount(value.deleted),
    }
  }

  /** 归一一个文件数组；非数组返回空数组。 */
  function normalizeFiles(files) {
    if (!Array.isArray(files)) return []
    const out = []
    for (const file of files) {
      const normalized = normalizeFile(file)
      if (normalized !== null) out.push(normalized)
    }
    return out
  }

  /** 空总计的新对象。 */
  function emptyTotals() {
    return { files: 0, added: 0, deleted: 0 }
  }

  /** 按扩展名判 kind；点号在文件名开头（如 `.gitignore`）不算扩展名。 */
  function kindOfPath(path) {
    const slashed = path.replace(/\\/g, '/')
    const base = slashed.slice(slashed.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    if (dot <= 0) return 'other'
    return EXT_KIND.get(base.slice(dot + 1).toLowerCase()) || 'other'
  }

  /** 路径比较：先按小写（NTFS 不区分大小写），再按原串，保证稳定确定。 */
  function comparePath(a, b) {
    const lowerA = a.path.toLowerCase()
    const lowerB = b.path.toLowerCase()
    if (lowerA < lowerB) return -1
    if (lowerA > lowerB) return 1
    if (a.path < b.path) return -1
    if (a.path > b.path) return 1
    return 0
  }

  /** 改动量：added + deleted；溢出成 Infinity 时按最大有限值参与排序。 */
  function churnOf(file) {
    const sum = file.added + file.deleted
    return Number.isFinite(sum) ? sum : Number.MAX_VALUE
  }

  /** size 排序比较器：改动量降序，同量按路径升序。 */
  function compareSize(a, b) {
    const diff = churnOf(b) - churnOf(a)
    if (diff !== 0) return diff
    return comparePath(a, b)
  }

  /**
   * 一轮 → 变更清单模型。
   *
   * @param {object} turn - 轮次行；读 `turn.changes = {files, lost}`。
   * @returns {{files: Array<object>, lost: boolean, summary: string, totals: object}} 视图模型。
   */
  function buildChanges(turn) {
    const source = isPlainObject(turn) ? turn : {}
    const changes = source.changes
    const lost = isPlainObject(changes) && changes.lost === true

    if (lost) {
      return {
        files: [],
        lost: true,
        summary: LOST_SUMMARY,
        totals: emptyTotals(),
      }
    }

    const rawFiles = Array.isArray(changes)
      ? changes
      : (isPlainObject(changes) && Array.isArray(changes.files) ? changes.files : [])
    const files = normalizeFiles(rawFiles)

    const totals = { files: files.length, added: 0, deleted: 0 }
    for (const file of files) {
      totals.added += file.added
      totals.deleted += file.deleted
    }

    const summary = files.length === 0
      ? EMPTY_SUMMARY
      : `该轮改了 ${files.length} 个文件，+${totals.added} -${totals.deleted} 行`

    return { files, lost: false, summary, totals }
  }

  /**
   * 按扩展名分组（固定顺序，只返回非空组）。
   *
   * @param {Array<object>} files - `buildChanges` 的文件清单（也接受原始形状）。
   * @returns {Array<{kind: string, label: string, files: Array<object>}>} 分组。
   */
  function groupByKind(files) {
    const buckets = new Map(KIND_ORDER.map(kind => [kind, []]))
    for (const file of normalizeFiles(files)) {
      buckets.get(kindOfPath(file.path)).push(file)
    }
    const groups = []
    for (const kind of KIND_ORDER) {
      const bucket = buckets.get(kind)
      if (bucket.length > 0) {
        groups.push({ kind, label: KIND_LABEL[kind], files: bucket })
      }
    }
    return groups
  }

  /**
   * 排序变更文件；返回新数组，不改入参。
   *
   * @param {Array<object>} files - 文件清单。
   * @param {'path'|'size'} [mode='path'] - `path` 按路径；`size` 按 added+deleted 降序。
   * @returns {Array<object>} 排序后的新清单。
   */
  function sortChanges(files, mode) {
    const normalized = normalizeFiles(files)
    if (mode === 'size') normalized.sort(compareSize)
    else normalized.sort(comparePath)
    return normalized
  }

      return {
        buildChanges: buildChanges, groupByKind: groupByKind,
        sortChanges: sortChanges,
      }
    })()
    // ══ changes-view 生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/rollback-plan.js
    // 回滚预演四态（P3-2 / A-12），纯函数，独立测试过（tests/rollback-plan.mjs）。
    var ROLLBACKPLAN = (function () {
  /** state 的固定顺序与中文标签（formatPlan 用）。 */
  const STATE_TEXT = Object.freeze({
    apply: '✓ 可回滚',
    same: '≡ 无需回滚',
    modified: '⚠ 已被修改',
    missing: '✗ 已不存在',
  })

  /** formatPlan 里非 apply 状态的短注。 */
  const STATE_NOTE = Object.freeze({
    apply: '',
    same: '',
    modified: '（需人工确认）',
    missing: '（文件已不存在）',
  })

  /** state 的固定顺序（counts / summary / formatPlan 共用）。 */
  const STATE_ORDER = Object.freeze(['apply', 'same', 'modified', 'missing'])

  /** 变更后（快照时）内容哈希的字段名，`hash` 是契约名，其余为兼容别名。 */
  const AFTER_HASH_KEYS = Object.freeze(['hash', 'sha256', 'afterHash', 'postHash'])

  /** 回滚目标（变更前）内容哈希的字段名；用于精确判 same。 */
  const BEFORE_HASH_KEYS = Object.freeze(['beforeHash', 'baseHash', 'prevHash'])

  /** 空计划的固定文案。 */
  const EMPTY_SUMMARY = '没有可回滚的文件'

  /** 是否普通对象（排除 null / 数组）。 */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** 非负整数：接受数字与数字字符串；负数 / 非有限 / 空值一律 0。 */
  function toCount(value) {
    if (value === null || value === undefined || value === '') return 0
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return 0
    return Math.floor(number)
  }

  /** sha256 归一：字符串去空白、转小写；其它类型视为"没有哈希"。 */
  function normalizeHash(value) {
    if (typeof value !== 'string') return null
    const hash = value.trim().toLowerCase()
    return hash === '' ? null : hash
  }

  /** 路径查找键：大小写不敏感，斜杠方向等价，忽略 `./` 前缀。 */
  function pathKey(path) {
    return path
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+/g, '/')
      .replace(/^\.\//, '')
      .toLowerCase()
  }

  /** 从记录的若干别名字段里取第一个可用哈希。 */
  function recordedHashOf(file, keys) {
    for (const key of keys) {
      const hash = normalizeHash(file[key])
      if (hash !== null) return hash
    }
    return null
  }

  /** 一条待回滚文件归一；坏条目返回 null。 */
  function normalizeFile(value) {
    if (!isPlainObject(value)) return null
    const path = typeof value.path === 'string' ? value.path.trim() : ''
    if (path === '') return null
    return {
      path,
      added: toCount(value.added),
      deleted: toCount(value.deleted),
      hash: recordedHashOf(value, AFTER_HASH_KEYS),
      beforeHash: recordedHashOf(value, BEFORE_HASH_KEYS),
    }
  }

  /** 当前哈希表 → `[key, hash]`；支持普通对象与 Map。 */
  function currentEntries(currentHashes) {
    if (currentHashes instanceof Map) return Array.from(currentHashes.entries())
    if (isPlainObject(currentHashes)) return Object.entries(currentHashes)
    return []
  }

  /** 比对快照与当前内容，判 state（顺序见模块注释）。 */
  function stateOf(file, currentHash) {
    if (currentHash === null) return 'missing'
    if (file.beforeHash !== null && file.beforeHash === currentHash) return 'same'
    if (file.added === 0 && file.deleted === 0) return 'same'
    if (file.hash !== null && file.hash !== currentHash) return 'modified'
    return 'apply'
  }

  /** 每个 state 给一句可读原因（apply 区分"无哈希"与"有哈希一致"）。 */
  function reasonOf(state, file, currentHash) {
    if (state === 'apply') {
      return file.hash === null
        ? '文件存在但未记录快照哈希，可执行回滚（无法校验）'
        : '文件内容与快照一致，可安全回滚'
    }
    if (state === 'same') {
      return file.beforeHash !== null && file.beforeHash === currentHash
        ? '当前内容已是回滚目标，无需回滚'
        : '内容未变，无需回滚'
    }
    if (state === 'missing') return '文件已不存在'
    return '文件在变更后已被修改，需人工确认'
  }

  /** 每种 state 的中文摘要片段。 */
  const SUMMARY_PARTS = Object.freeze([
    ['apply', count => `${count} 个可回滚`],
    ['same', count => `${count} 个无需回滚`],
    ['modified', count => `${count} 个已被修改`],
    ['missing', count => `${count} 个已不存在`],
  ])

  /** 按固定顺序拼摘要；全是 0 时给空态文案。 */
  function summarize(counts) {
    const parts = []
    for (const [state, render] of SUMMARY_PARTS) {
      if (counts[state] > 0) parts.push(render(counts[state]))
    }
    return parts.length === 0 ? EMPTY_SUMMARY : parts.join('，')
  }

  /**
   * 预演一批文件的回滚。
   *
   * @param {Array<{path: string, added: number, deleted: number, hash?: string, beforeHash?: string}>} files - 变更快照。
   * @param {object|Map<string, string|null>} currentHashes - 当前磁盘内容哈希；null 表示文件不存在。
   * @returns {{plan: Array<object>, summary: string, counts: object}} 预演结果。
   */
  function planRollback(files, currentHashes) {
    // 先建精确键与归一键两套索引：精确键优先，避免两个只差大小写的路径互相覆盖。
    const exact = new Map()
    const normalized = new Map()
    for (const [key, raw] of currentEntries(currentHashes)) {
      if (typeof key !== 'string') continue
      const hash = normalizeHash(raw)
      exact.set(key, hash)
      const lookup = pathKey(key)
      if (!normalized.has(lookup)) normalized.set(lookup, hash)
    }

    const plan = []
    const counts = {}
    for (const state of STATE_ORDER) counts[state] = 0
    const source = Array.isArray(files) ? files : []

    for (const value of source) {
      const file = normalizeFile(value)
      if (file === null) continue

      let currentHash
      if (exact.has(file.path)) {
        currentHash = exact.get(file.path)
      } else {
        const lookup = pathKey(file.path)
        currentHash = normalized.has(lookup) ? normalized.get(lookup) : null
      }

      const state = stateOf(file, currentHash)
      counts[state] += 1
      plan.push({
        path: file.path,
        added: file.added,
        deleted: file.deleted,
        hash: file.hash,
        currentHash,
        state,
        reason: reasonOf(state, file, currentHash),
      })
    }

    return { plan, summary: summarize(counts), counts }
  }

  /**
   * 把预演结果渲染成多行文本（简报 / 剪贴板）。
   *
   * 接受 `planRollback` 返回的 `plan` 数组，也接受完整结果对象 `{plan}`。
   * 每行格式：`<state 标签>  <路径>  +<added> -<deleted>`，modified / missing
   * 追加一句短注。空计划返回单行文案，不返回空串。
   *
   * @param {Array<object>|{plan: Array<object>}} plan - 预演计划。
   * @returns {string} 多行文本（无结尾换行）。
   */
  function formatPlan(plan) {
    const list = Array.isArray(plan)
      ? plan
      : (isPlainObject(plan) && Array.isArray(plan.plan) ? plan.plan : [])
    if (list.length === 0) return EMPTY_SUMMARY

    const lines = []
    for (const item of list) {
      if (!isPlainObject(item)) continue
      const state = typeof item.state === 'string' ? item.state : ''
      const label = STATE_TEXT[state] || '? 未知状态'
      const path = typeof item.path === 'string' ? item.path : ''
      const added = toCount(item.added)
      const deleted = toCount(item.deleted)
      const note = STATE_NOTE[state] || ''
      lines.push(`${label}  ${path}  +${added} -${deleted}${note}`)
    }
    return lines.length === 0 ? EMPTY_SUMMARY : lines.join('\n')
  }

      return {
        planRollback: planRollback, formatPlan: formatPlan,
      }
    })()
    // ══ rollback-plan 生成段结束 ══

    // ══ 以下由 scripts/build-theme.mjs 从 lib/work-view.js
    // 「续接」首页视图模型（ADR-0001~0004），纯函数，独立测试过（tests/work-view.mjs）。
    var WORKVIEW = (function () {
  const MINUTE = 60 * 1000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR

  /** 现状/卡点第 2 行的最大显示字数（按 Unicode 码点计，含省略号）。 */
  const STATUS_LINE_MAX = 60

  /** 事的四态中文文案。 */
  const STATE_LABELS = Object.freeze({
    active: '进行中',
    blocked: '卡住',
    done: '已完成',
    shelved: '已搁置',
  })

  /** 未收束状态集合。 */
  const UNRESOLVED_STATES = new Set(['active', 'blocked'])

  /** 三类合法拐点标识。 */
  const INFLECTION_KINDS = new Set([
    'topic_switch',
    'likely_settled_or_blocked',
    'revisit_unresolved',
  ])

  /** 决策状态中文文案。 */
  const DECISION_STATUS_LABELS = Object.freeze({
    active: '现行',
    superseded: '已否决',
  })

  /** 是否普通对象（排除 null 与数组）。 */
  function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** 转安全字符串。 */
  function textOf(value) {
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    return ''
  }

  /** 压缩连续空白（含换行）。 */
  function compress(value) {
    return textOf(value).replace(/\s+/g, ' ').trim()
  }

  /** 按 Unicode 码点截断，超长末尾加省略号，总长不超过 max。 */
  function clipText(value, max) {
    const text = compress(value)
    if (text === '') return ''
    const chars = Array.from(text)
    if (chars.length <= max) return text
    if (max <= 1) return chars.slice(0, Math.max(0, max)).join('')
    return chars.slice(0, max - 1).join('') + '…'
  }

  /** 把时间统一成 epoch ms；认 Date 与有限数字，其余返回 NaN。 */
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

  /** 是否同一个本地年份。 */
  function sameLocalYear(a, b) {
    return new Date(a).getFullYear() === new Date(b).getFullYear()
  }

  /** 格式化为本地 YYYY-MM-DD。 */
  function formatDate(ms) {
    const date = new Date(ms)
    const year = String(date.getFullYear()).padStart(4, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return year + '-' + month + '-' + day
  }

  /**
   * 相对时间文案（纯函数，不读系统时钟）。
   *
   * 分档：
   * - < 1 分钟：刚刚
   * - < 1 小时：N 分钟前
   * - 同一本地自然日：今天
   * - 昨天（同一年前一天）：昨天
   * - 2–6 天（同一年）：N 天前
   * - ≥ 7 天或跨年：YYYY-MM-DD
   *
   * @param {number|Date} ts - 目标时间戳。
   * @param {number|Date} now - 参照当前时间戳。
   * @returns {string} 相对时间文案；参数非法返回空串。
   */
  function formatRelativeTime(ts, now) {
    const time = toMs(ts)
    const base = toMs(now)
    if (!Number.isFinite(time) || !Number.isFinite(base)) return ''
    const diff = base - time
    if (diff < 0) return sameLocalDay(time, base) ? '今天' : formatDate(time)
    if (diff < MINUTE) return '刚刚'
    if (diff < HOUR) return Math.floor(diff / MINUTE) + ' 分钟前'
    if (sameLocalDay(time, base)) return '今天'
    if (!sameLocalYear(time, base)) return formatDate(time)
    const days = Math.round((startOfLocalDay(base) - startOfLocalDay(time)) / DAY)
    if (days <= 0) return '今天'
    if (days === 1) return '昨天'
    if (days < 7) return days + ' 天前'
    return formatDate(time)
  }

  /** 会话短 id：去掉常见 session- 前缀后取前 8 位。 */
  function shortSessionId(sessionId) {
    const raw = compress(sessionId)
    if (raw === '') return ''
    return raw.replace(/^session[-_:]/i, '').slice(0, 8)
  }

  /** 归一化事的四态。 */
  function normalizeState(state) {
    return typeof state === 'string' && Object.prototype.hasOwnProperty.call(STATE_LABELS, state)
      ? state
      : 'active'
  }

  /** 归一化可信度（confirmed / inferred）。 */
  function normalizeConfidence(card) {
    const raw = compress(card.confidence || card.stateSource)
    return raw === 'confirmed' ? 'confirmed' : 'inferred'
  }

  /** 去重非空字符串数组。 */
  function uniqueStrings(list) {
    const seen = new Set()
    const out = []
    for (const item of Array.isArray(list) ? list : []) {
      const text = compress(typeof item === 'string' ? item : (isPlainObject(item) ? item.path : ''))
      if (text === '' || seen.has(text)) continue
      seen.add(text)
      out.push(text)
    }
    return out
  }

  /** 格式化单条决策详情项。 */
  function formatDecisionItem(raw, now) {
    if (!isPlainObject(raw)) return null
    const summary = compress(raw.summary)
    if (summary === '') return null
    const status = raw.status === 'superseded' ? 'superseded' : 'active'
    const at = toMs(raw.at)
    return {
      id: compress(raw.id),
      summary,
      rationale: compress(raw.rationale),
      status,
      statusLabel: DECISION_STATUS_LABELS[status],
      supersededBy: status === 'superseded' ? (compress(raw.supersededBy) || null) : null,
      evidenceHandle: compress(raw.evidenceHandle),
      source: raw.source === 'confirmed' ? 'confirmed' : 'inferred',
      timeLabel: Number.isFinite(at) ? formatRelativeTime(at, now) : '',
    }
  }

  /** 提取段的起止轮号并拼装区间文案（#1–#12 或 #4）。 */
  function segmentRangeOf(seg) {
    let start = null
    let end = null
    if (Array.isArray(seg.turnRange) && seg.turnRange.length >= 2) {
      const a = Number(seg.turnRange[0])
      const b = Number(seg.turnRange[1])
      if (Number.isFinite(a) && Number.isFinite(b)) {
        start = Math.trunc(a)
        end = Math.trunc(b)
      }
    }
    if (start === null || end === null) {
      const a = Number(seg.startTurn !== undefined ? seg.startTurn : seg.fromTurn)
      const b = Number(seg.endTurn !== undefined ? seg.endTurn : seg.toTurn)
      if (Number.isFinite(a) && Number.isFinite(b)) {
        start = Math.trunc(a)
        end = Math.trunc(b)
      }
    }
    if (start === null || end === null) {
      return { startTurn: null, endTurn: null, turnRangeLabel: '' }
    }
    if (end < start) {
      const tmp = start
      start = end
      end = tmp
    }
    const label = start === end ? ('#' + start) : ('#' + start + '–#' + end)
    return { startTurn: start, endTurn: end, turnRangeLabel: label }
  }

  /** 格式化跨会话段清单项。 */
  function formatSegmentItem(raw) {
    if (!isPlainObject(raw)) return null
    const id = compress(raw.id || raw.segmentId)
    const sessionId = compress(raw.sessionId)
    const range = segmentRangeOf(raw)
    const title = compress(raw.title || raw.label) || (range.turnRangeLabel !== '' ? ('轮次 ' + range.turnRangeLabel) : '未命名段')
    return {
      id,
      sessionId,
      shortSessionId: shortSessionId(sessionId),
      sessionTitle: compress(raw.sessionTitle),
      title,
      startTurn: range.startTurn,
      endTurn: range.endTurn,
      turnRangeLabel: range.turnRangeLabel,
    }
  }

  /** 构造第 4 行卡片动作条（未收束 vs 已收束）。 */
  function buildCardActions(resolved) {
    if (resolved) {
      return [
        { id: 'reopen', label: '重新打开', kind: 'primary' },
        { id: 'inspect', label: '看决策与证据', kind: 'secondary' },
        {
          id: 'more',
          label: '更多',
          kind: 'menu',
          items: [
            { id: 'inspect', label: '看决策与证据' },
            { id: 'merge', label: '合并' },
            { id: 'split', label: '拆段' },
            { id: 'dismiss', label: '不算事' },
          ],
        },
      ]
    }
    return [
      { id: 'resume', label: '回到现场', kind: 'primary' },
      { id: 'handoff', label: '新会话交接', kind: 'secondary' },
      { id: 'confirm_done', label: '已完成', kind: 'secondary' },
      {
        id: 'more',
        label: '更多',
        kind: 'menu',
        items: [
          { id: 'inspect', label: '看决策与证据' },
          { id: 'merge', label: '合并' },
          { id: 'split', label: '拆段' },
          { id: 'dismiss', label: '不算事' },
        ],
      },
    ]
  }

  /**
   * 把后端投影的单张「事」卡片格式化为可直接渲染的 4 行窄卡片 + 展开详情 UI 模型。
   *
   * @param {object} card - 后端投影卡片或 Work 对象。
   * @param {number|Date} [now] - 参照时间戳。
   * @returns {object} 格式化后的卡片 UI 模型。
   */
  function formatWorkCard(card, now) {
    const src = isPlainObject(card) ? card : {}
    const id = compress(src.id)
    const title = compress(src.title) || '未命名工作'
    const state = normalizeState(src.state)
    const resolved = !UNRESOLVED_STATES.has(state)
    const confidence = normalizeConfidence(src)
    const confirmed = confidence === 'confirmed'
    const pinned = src.pinned === true
    const lastActivityAt = toMs(src.lastActivityAt)

    const rawTime = formatRelativeTime(lastActivityAt, now)
    const timeLabel = rawTime !== '' ? rawTime : compress(src.relativeTime)

    const statusFull = compress(src.statusLine || src.statusSummary || src.goal)
    const statusLine = statusFull !== '' ? clipText(statusFull, STATUS_LINE_MAX) : '暂无现状摘要'

    const rawNextStep = compress(src.nextStep)
    const hasNextStep = rawNextStep !== ''
    const nextStepLine = hasNextStep ? ('→ 下一步：' + rawNextStep) : '→ 下一步：待补充下一步行动'

    const decisions = []
    for (const item of Array.isArray(src.decisions) ? src.decisions : []) {
      const formatted = formatDecisionItem(item, now)
      if (formatted !== null) decisions.push(formatted)
    }
    // 现行决策排前，已否决决策排后，保持各自原有相对顺序
    decisions.sort((a, b) => {
      if (a.status === b.status) return 0
      return a.status === 'active' ? -1 : 1
    })

    const files = uniqueStrings(src.files)
    const segments = []
    for (const seg of Array.isArray(src.segments) ? src.segments : []) {
      const formatted = formatSegmentItem(seg)
      if (formatted !== null) segments.push(formatted)
    }

    const sessionCount = Number.isInteger(src.sessionCount) && src.sessionCount >= 0
      ? src.sessionCount
      : (Array.isArray(src.sessionIds) ? src.sessionIds.length : 0)
    const segmentCount = Number.isInteger(src.segmentCount) && src.segmentCount >= 0
      ? src.segmentCount
      : (segments.length > 0 ? segments.length : (Array.isArray(src.segmentIds) ? src.segmentIds.length : 0))
    const decisionCount = Number.isInteger(src.decisionCount) && src.decisionCount >= 0
      ? src.decisionCount
      : decisions.length

    return {
      id,
      title,
      state,
      resolved,
      pinned,
      reviewStatus: src.reviewStatus === 'reviewed' ? 'reviewed' : 'pending',
      // 第 1 行元数据
      stateBadge: {
        state,
        label: STATE_LABELS[state],
      },
      confidenceBadge: {
        confidence,
        label: confirmed ? '已确认' : '推测',
        style: confirmed ? 'solid' : 'dashed',
        confirmed,
      },
      timeLabel,
      lastActivityAt: Number.isFinite(lastActivityAt) ? lastActivityAt : 0,
      // 第 2 行：现状 / 卡点
      statusLine,
      statusFull,
      // 第 3 行：下一步
      nextStep: rawNextStep,
      nextStepLine,
      hasNextStep,
      // 第 4 行：动作条
      actions: buildCardActions(resolved),
      // 统计与展开详情
      sessionCount,
      segmentCount,
      decisionCount,
      decisions,
      files,
      segments,
      evidenceHandles: uniqueStrings(src.evidenceHandles),
    }
  }

  /**
   * 把三类自然拐点（topic_switch / likely_settled_or_blocked / revisit_unresolved）
   * 格式化为非阻塞轻确认条文案与 1 秒一键动作按钮清单。
   *
   * @param {object} inflection - 后端或 detectInflection 产出的拐点对象。
   * @returns {object|null} 轻确认条 UI 模型；输入为空或非合法拐点返回 null。
   */
  function formatInflectionBanner(inflection) {
    if (!isPlainObject(inflection)) return null
    const kind = compress(inflection.kind)
    if (!INFLECTION_KINDS.has(kind)) return null

    const workId = compress(inflection.workId)
    const title = compress(inflection.title) || '当前工作'
    const suggestedState = normalizeState(inflection.suggestedState)
    const customPrompt = compress(inflection.prompt)

    let message = customPrompt
    let actions = []

    if (kind === 'topic_switch') {
      if (message === '') message = '刚刚切离了「' + title + '」，这件事现在是什么状态？'
      actions = [
        { id: 'confirm_done', label: '✓ 标为已完成', state: 'done', kind: 'primary' },
        { id: 'keep_active', label: '确认进行中', state: 'active', kind: 'secondary' },
        { id: 'mark_shelved', label: '先搁置', state: 'shelved', kind: 'secondary' },
        { id: 'ignore', label: '忽略', state: null, kind: 'ghost' },
      ]
    } else if (kind === 'likely_settled_or_blocked') {
      if (suggestedState === 'blocked') {
        if (message === '') message = '「' + title + '」刚才出现异常或中断，是否标为卡住？'
        actions = [
          { id: 'confirm_blocked', label: '标为卡住', state: 'blocked', kind: 'primary' },
          { id: 'keep_active', label: '确认进行中', state: 'active', kind: 'secondary' },
          { id: 'ignore', label: '忽略', state: null, kind: 'ghost' },
        ]
      } else {
        if (message === '') message = '「' + title + '」看起来已经收尾，是否标为已完成？'
        actions = [
          { id: 'confirm_done', label: '✓ 标为已完成', state: 'done', kind: 'primary' },
          { id: 'keep_active', label: '确认进行中', state: 'active', kind: 'secondary' },
          { id: 'ignore', label: '忽略', state: null, kind: 'ghost' },
        ]
      }
    } else {
      // revisit_unresolved
      if (message === '') message = '回到未收束的「' + title + '」，是否继续推进？'
      actions = [
        { id: 'confirm_continue', label: '确认进行中', state: suggestedState, kind: 'primary' },
        { id: 'confirm_done', label: '✓ 标为已完成', state: 'done', kind: 'secondary' },
        { id: 'ignore', label: '忽略', state: null, kind: 'ghost' },
      ]
    }

    return {
      kind,
      workId,
      title,
      suggestedState,
      message,
      actions,
    }
  }

  /**
   * 把撞上已确认完成老事时的重开建议格式化为轻提示条文案与动作。
   *
   * @param {object} suggestion - suggest_reopen 建议对象。
   * @returns {object|null} 重开轻提示条 UI 模型；无效输入返回 null。
   */
  function formatReopenBanner(suggestion) {
    if (!isPlainObject(suggestion)) return null
    const workId = compress(suggestion.relatedDoneWorkId || suggestion.workId || suggestion.id)
    const title = compress(suggestion.relatedDoneWorkTitle || suggestion.title)
    if (workId === '' && title === '') return null

    const displayTitle = title || workId
    const reasonText = suggestion.reason === 'files'
      ? '改动了相同的业务文件'
      : (suggestion.reason === 'handle'
        ? '引用了原事的对话轮次'
        : (suggestion.reason === 'fork' ? '分叉自原事会话' : '与已完成的事高度相关'))

    return {
      workId,
      title: displayTitle,
      level: compress(suggestion.level),
      reason: compress(suggestion.reason),
      sharedFiles: uniqueStrings(suggestion.sharedFiles),
      message: '检测到当前工作' + reasonText + '，可能延续已完成的「' + displayTitle + '」',
      actions: [
        { id: 'reopen_link', label: '关联重开', kind: 'primary' },
        { id: 'keep_separate', label: '保持独立', kind: 'secondary' },
      ],
    }
  }

  /** 未收束卡片排序：置顶优先 > blocked 优先于 active > 最近活动时间倒序 > id 稳定兜底。 */
  function compareUnresolvedCards(a, b) {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    const aBlocked = a.state === 'blocked' ? 1 : 0
    const bBlocked = b.state === 'blocked' ? 1 : 0
    if (aBlocked !== bBlocked) return bBlocked - aBlocked
    if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt
    return a.id.localeCompare(b.id)
  }

  /** 已收束卡片排序：最近活动时间倒序 > id 稳定兜底。 */
  function compareSettledCards(a, b) {
    if (b.lastActivityAt !== a.lastActivityAt) return b.lastActivityAt - a.lastActivityAt
    return a.id.localeCompare(b.id)
  }

  /**
   * 把 `POST /works` 返回组装成完整「续接」页视图模型。
   *
   * @param {object} payload - 后端 `/works` 响应。
   * @param {{ now?: number|Date, showSettled?: boolean }} [options] - 渲染选项。
   * @returns {object} 续接页完整视图模型。
   */
  function workBoardModel(payload, options) {
    const data = isPlainObject(payload) ? payload : {}
    const opts = isPlainObject(options) ? options : {}
    const now = opts.now
    const showSettled = opts.showSettled === true

    const rawUnresolved = Array.isArray(data.unresolved) ? data.unresolved : []
    const rawSettled = Array.isArray(data.settled) ? data.settled : []

    const cards = rawUnresolved
      .filter(isPlainObject)
      .map(item => formatWorkCard(item, now))
      .sort(compareUnresolvedCards)

    const settledCards = rawSettled
      .filter(isPlainObject)
      .map(item => formatWorkCard(item, now))
      .sort(compareSettledCards)

    const rawPending = Number(data.pendingReviewCount)
    const pendingReviewCount = Number.isFinite(rawPending) && rawPending > 0
      ? Math.floor(rawPending)
      : 0
    const pendingReviewBanner = pendingReviewCount > 0
      ? {
          count: pendingReviewCount,
          message: '系统自动整理出 ' + pendingReviewCount + ' 件待确认的事 — 确认哪些还在推进，改完即锁定不再被覆盖',
          action: { id: 'open_review', label: '开始逐条核对' },
          exitAction: { id: 'exit_review', label: '退出核对' },
          confirmAllAction: { id: 'confirm_all', label: '全部确认无误' },
        }
      : null

    const reopenBanners = []
    for (const item of Array.isArray(data.reopenSuggestions) ? data.reopenSuggestions : []) {
      const formatted = formatReopenBanner(item)
      if (formatted !== null) reopenBanners.push(formatted)
    }

    const inflectionBanner = formatInflectionBanner(data.inflection)

    const coldStartStatus = compress(data.coldStartStatus || data.status)
    const isColdStarting = data.coldStarting === true
      || data.scanning === true
      || coldStartStatus === 'scanning'
      || coldStartStatus === 'warming'
      || coldStartStatus === 'indexing'

    // 空态判定（ADR-0008）：四种情况必须可区分，不能让用户把
    // 「还没扫描」「正在扫描」「扫描失败」「确实无事」看成同一句话。
    const failedText = compress(data.error)
    const neverScanned = data.initialized === false

    let empty = null
    if (cards.length === 0) {
      if (failedText !== '') {
        // 失败态：明确告诉用户是读取失败，并给出重试入口（不是「无事」）。
        empty = {
          kind: 'failed',
          title: '盘点失败',
          description: '读取这个工作区的事时出错了：' + clipText(failedText, 120)
            + '。已经存下的结果不会丢，可以直接重试。',
          action: { id: 'retry_scan', label: '重试' },
        }
      } else if (isColdStarting) {
        // 顺序很重要：正在盘点时先说「正在盘点」，而不是「还没盘点过」——
        // 后者会让用户以为要手动点一下，其实它正在跑（ADR-0008 的四态本意）。
        empty = {
          kind: 'cold_start',
          title: '冷启动整理中，正在盘点本工作区的工作记录…',
          description: '首次盘点会在后台异步完成，可先在「历史」页检索与浏览对话。',
          action: { id: 'open_history', label: '去「历史」查看对话' },
        }
      } else if (neverScanned) {
        // 未扫描态：从没盘点过 ≠ 没有事要办。
        empty = {
          kind: 'unscanned',
          title: '这个工作区还没有盘点过',
          description: '点下面的按钮开始盘点已有的事；盘点结果会一直保留，不用每次重扫。',
          action: { id: 'start_scan', label: '开始盘点' },
        }
      } else if (data.conversationCount === 0 && Number(data.emptySessionCount) > 0) {
        // 五态之 no_content（ADR-0012）：有会话壳，但没有可读对话。
        // 必须与「确实无事」分开，否则等于告诉用户「你已经做完了」。
        const empties = Math.max(0, Math.floor(Number(data.emptySessionCount)))
        empty = {
          kind: 'no_content',
          title: '本工作区没有可读的对话',
          description: empties + ' 个会话都没有任何轮次（0 轮），所以既切不出段、也没有可续接的事。'
            + '这不是提取失败，重扫也不会变出内容。',
          action: { id: 'open_history', label: '去「历史」看看' },
        }
      } else {
        empty = {
          kind: 'no_unresolved',
          title: '本工作区暂无未收束的事',
          description: '所有进行中或卡住的工作都会自动汇集到这里；日常交流可去「历史」看话题回溯。',
          action: { id: 'open_history', label: '去「历史」看话题回溯' },
        }
      }
    }

    return {
      pendingReviewCount,
      pendingReviewBanner,
      reopenBanners,
      inflectionBanner,
      cards,
      settledSection: {
        count: settledCards.length,
        expanded: showSettled,
        label: settledCards.length > 0 ? ('已收束（' + settledCards.length + '）') : '已收束',
        cards: settledCards,
        visibleCards: showSettled ? settledCards : [],
      },
      empty,
    }
  }
  // ── 工作区切区状态机与空态（ADR-0008）──────────────────────────────

  /**
   * 续接面板的「我该显示什么」状态机（纯函数）。
   *
   * 解决两个真机问题：
   * 1. **串台**：切工作区时旧的 `raw` 还挂在 state 上被继续渲染，用户会看到
   *    上一个工作区的卡片短暂出现。这里把「数据所属工作区」与「当前绑定工作区」
   *    显式比对，不一致就立刻回到 loading 并禁止展示旧数据。
   * 2. **四态不可区分**：以前「没扫描过 / 正在扫描 / 扫描失败 / 确实没事」
   *    都渲染成同一句「暂无未收束的事」，用户无法判断该等、该重试还是该安心。
   *
   * @param {object} input - `{ boundWorkspaceId, dataWorkspaceId, raw, error, scanning, refining }`。
   * @returns {{
   *   status: 'loading'|'ready'|'error',
   *   showStale: boolean,
   *   emptyKind: ''|'unscanned'|'scanning'|'failed'|'empty',
   *   unresolvedCount: number,
   * }} 渲染状态。
   */
  function resolveWorksViewState(input) {
    const src = isPlainObject(input) ? input : {}
    const bound = typeof src.boundWorkspaceId === 'string' ? src.boundWorkspaceId.trim() : ''
    const dataWs = typeof src.dataWorkspaceId === 'string' ? src.dataWorkspaceId.trim() : ''
    const raw = isPlainObject(src.raw) ? src.raw : null
    const errorText = typeof src.error === 'string' ? src.error.trim() : ''
    const scanning = src.scanning === true
    const refining = src.refining === true

    // 切区瞬间：数据属于别的工作区 → 立刻清态，绝不展示旧数据。
    // 只有两边都非空且确实不同才算「串台」；未知（空串）时按当前数据继续，避免闪屏。
    const switching = bound !== '' && dataWs !== '' && bound !== dataWs
    if (switching) {
      return { status: 'loading', showStale: false, emptyKind: '', unresolvedCount: 0 }
    }

    if (errorText !== '') {
      return { status: 'error', showStale: false, emptyKind: 'failed', unresolvedCount: 0 }
    }

    if (raw === null) {
      return {
        status: 'loading',
        showStale: false,
        emptyKind: scanning || refining ? 'scanning' : 'unscanned',
        unresolvedCount: 0,
      }
    }

    const cards = isPlainObject(raw.cards) ? raw.cards : {}
    const unresolved = Array.isArray(cards.unresolved)
      ? cards.unresolved
      : (Array.isArray(raw.unresolved) ? raw.unresolved : [])
    const unresolvedCount = unresolved.length

    // 已经拿过结果：先看是否正在扫描，再看是否真的无事。
    if (scanning || refining) {
      return { status: 'ready', showStale: false, emptyKind: 'scanning', unresolvedCount }
    }
    if (raw.initialized === false) {
      return { status: 'ready', showStale: false, emptyKind: 'unscanned', unresolvedCount }
    }
    if (unresolvedCount === 0) {
      // 会话是壳，对话是瓤（ADR-0012）：这个工作区可能一个可读对话都没有。
      // 那时说「没有未收束的事」是在撒谎——用户会以为自己漏了什么，然后反复重扫，
      // 而重扫永远不会有用，因为源头就是空的。
      const conversations = typeof raw.conversationCount === 'number' ? raw.conversationCount : null
      const empties = typeof raw.emptySessionCount === 'number' ? raw.emptySessionCount : 0
      if (conversations === 0 && empties > 0) {
        return { status: 'ready', showStale: false, emptyKind: 'no_content', unresolvedCount, emptySessionCount: empties }
      }
      return { status: 'ready', showStale: false, emptyKind: 'empty', unresolvedCount }
    }
    return { status: 'ready', showStale: false, emptyKind: '', unresolvedCount }
  }

  /**
   * 四种空态的文案（纯函数）。
   *
   * 关键要求：四句话**必须互不相同**，用户据此判断该等待、该重试还是可以放心。
   *
   * @param {string} emptyKind - `resolveWorksViewState` 给出的 `emptyKind`。
   * @param {object} [params] - `{ refineReason, workspaceName }`。
   * @returns {{ title: string, hint: string, retry: boolean }} 文案与是否显示重试。
   */
  function emptyStateText(emptyKind, params = {}) {
    const p = isPlainObject(params) ? params : {}
    const wsName = typeof p.workspaceName === 'string' && p.workspaceName.trim() !== ''
      ? p.workspaceName.trim()
      : '当前工作区'

    if (emptyKind === 'unscanned') {
      return {
        title: wsName + ' 还没有盘点过',
        hint: '点「扫描」开始盘点这个工作区已有的事，盘点结果会一直保留。',
        retry: false,
      }
    }
    if (emptyKind === 'scanning') {
      return {
        title: '正在盘点 ' + wsName + '…',
        hint: '先给你看硬信号结果，语义提炼在后台继续；完成后会自动刷新。',
        retry: false,
      }
    }
    if (emptyKind === 'no_content') {
      const empties = Number.isFinite(Number(p.emptySessionCount)) ? Math.max(0, Math.floor(Number(p.emptySessionCount))) : 0
      const countText = empties > 0 ? empties + ' 个会话' : '这些会话'
      return {
        title: wsName + ' 没有可读的对话',
        // 必须与「确实无事」明确区别：这里不是「你做完了」，是「没有东西可读」。
        hint: countText + '都没有任何轮次（0 轮），所以既切不出段、也没有可续接的事。'
          + '这不是提取失败，重扫也不会变出内容。',
        retry: false,
      }
    }
    if (emptyKind === 'failed') {
      return {
        title: '盘点失败',
        hint: '读取这个工作区的事时出错了，可以重试；已经存下的结果不会丢。',
        retry: true,
      }
    }
    return {
      title: '这个工作区没有未收束的事',
      hint: '盘点过 ' + wsName + '，当前确实没有需要接手的事；做完的已折叠到下方。',
      retry: false,
    }
  }
      return {
        formatWorkCard: formatWorkCard, workBoardModel: workBoardModel,
        formatInflectionBanner: formatInflectionBanner, formatReopenBanner: formatReopenBanner,
        formatRelativeTime: formatRelativeTime,
      }
    })()
    // ══ work-view 生成段结束 ══

    // ── 格式化与请求 ────────────────────────────────────────────────
    function fmtDuration(ms) {
      if (!isFinite(ms) || ms < 0) return '—'
      var total = Math.round(ms / 1000)
      if (total < 60) return total + 's'
      var m = Math.floor(total / 60)
      var s = total % 60
      if (m < 60) return s === 0 ? m + 'm' : m + 'm' + s + 's'
      return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
    }

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

    // ── 定位与跳转 ──────────────────────────────────────────────────
    /**
     * 复用已核实的 DSH 原生轮次导航，让 Chat 自己取消跟随底部并保存阅读位置。
     * 导航轨道会虚拟化：用已渲染按钮的实际间距滚动轨道，最终只点击精确标签。
     */
    function activateChatTurn(turnNo, turns, explicitNav) {
      if (typeof document === 'undefined') return false
      // 历史轨接管后文档里可能同时存在多个会话的 nav（后台会话也在 DOM 里），
      // 调用方知道该点哪一个，优先用它；节点已被 React 换掉时才退回全局查找。
      var nav = explicitNav !== null && explicitNav !== undefined && explicitNav.isConnected !== false
        ? explicitNav
        : document.querySelector('nav[aria-label="轮次导航"],nav[aria-label="Turn navigation"]')
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

    // ── 抽屉内的历史 / 统计 / 设置 ─────────────────────────────────
    //
    // 三个视图共用 RIGHT_TABS 清单，由自绘抽屉的固定头部切换；抽屉本身
    // 只依赖宿主自带的 shell.overlay，不再注册 better-sidebar 的右栏。
    //
    // 历史正文接真实检索（POST /api/topic-map/search）：受控搜索框 +
    // 400ms 防抖 + 两行结果列表 + 底部状态条。
    var WORKS_ID = 'dsh-topic-map:works'
    var WORKS_KIND = 'topic-map-works'
    var WORKS_TITLE = '续接'
    var HISTORY_ID = 'dsh-topic-map:history'
    var HISTORY_KIND = 'topic-map-history'
    var HISTORY_TITLE = '历史检索'
    var HISTORY_TAB_TITLE = '历史'
    var STATS_ID = 'dsh-topic-map:stats'
    var STATS_KIND = 'topic-map-stats'
    var STATS_TITLE = '统计'
    var STATS_SORT_PREFIX = 'dsh.tm.stats.sort.'
    var STATS_SORT_TURNS = 'turns'
    var STATS_SORT_TOKENS = 'tokens'
    var SETTINGS_ID = 'dsh-topic-map:settings'
    var SETTINGS_KIND = 'topic-map-settings'
    var SETTINGS_TITLE = '设置'
    var CATEGORIES_ID = 'dsh-topic-map:categories'
    var CATEGORIES_KIND = 'topic-map-categories'
    var CATEGORIES_TITLE = '分类'
    var CLUE_ID = 'dsh-topic-map:clue'
    var CLUE_KIND = 'topic-map-clue'
    var CLUE_TITLE = '线索'
    /** 右栏四个 tab 的唯一清单：［续接］［历史］［统计］［设置］。 */
    var RIGHT_TABS = [
      {
        id: typeof WORKS_ID === 'string' ? WORKS_ID : 'dsh-topic-map:works',
        kind: typeof WORKS_KIND === 'string' ? WORKS_KIND : 'topic-map-works',
        title: typeof WORKS_TITLE === 'string' ? WORKS_TITLE : '续接',
      },
      { id: HISTORY_ID, kind: HISTORY_KIND, title: '历史' },
      { id: STATS_ID, kind: STATS_KIND, title: STATS_TITLE },
      { id: SETTINGS_ID, kind: SETTINGS_KIND, title: SETTINGS_TITLE },
    ]
    /** 多代码块复制时的分隔线。 */
    var HISTORY_BLOCK_SEP = String.fromCharCode(10, 10) + '---' + String.fromCharCode(10, 10)
    /** 重试二次确认的固定文案（不要用原生 confirm）。 */
    var HISTORY_RETRY_CONFIRM_TEXT = '将新建会话并重新提交该轮提问，继续？'

    /** 输入防抖：输入即搜；400ms 比 200ms 更不容易把每个键都变成请求。 */
    var HISTORY_DEBOUNCE_MS = 400

    /** 与 ui.md §2.4 的示例一致：右栏只取前 30 条，其余交给主面板。 */
    var HISTORY_SEARCH_LIMIT = 30
    /** 历史视图持久化与前缀解析用到的常量。 */
    var HISTORY_LIST_VIEW = 'list'
    var HISTORY_TIMELINE_VIEW = 'timeline'
    /** 时间线暂缓：先固定列表；改回 true 即恢复入口与分支。 */
    var HISTORY_TIMELINE_ENABLED = false
    var HISTORY_IDLE_TEXT = '输入关键词检索，或从左侧选择分类'
    var HISTORY_EMPTY_TEXT = '没有匹配的轮次'
    /**
     * 对话位置 → 当前轮的单一事实源。
     *
     * 只看对话视口：顶部 +24px 处第一个完整可见的 [data-chat-turn]；
     * 都不满足就取离顶部最近的一个；没有 data-chat-turn 时才退回原生
     * 导航按钮的 aria-label。轨道、历史列表、详情都订阅同一份结果。
     */
    function resolveActiveTurn(scroller) {
      if (scroller === null || scroller === undefined || typeof scroller.querySelectorAll !== 'function') return null
      var viewport = null
      try { viewport = typeof scroller.getBoundingClientRect === 'function' ? scroller.getBoundingClientRect() : null } catch (error) { viewport = null }
      if (viewport === null || viewport === undefined || !Number.isFinite(Number(viewport.top))) return null
      var top = Number(viewport.top)
      var bottom = Number(viewport.bottom)
      var threshold = top + 24
      var list = scroller.querySelectorAll('[data-chat-turn]')
      var before = null
      var nearest = null
      var nearestDistance = Infinity
      for (var i = 0; i < list.length; i += 1) {
        var node = list[i]
        var turn = Number(node.getAttribute('data-chat-turn'))
        if (!Number.isFinite(turn)) continue
        if (typeof node.getBoundingClientRect !== 'function') continue
        var rect = null
        try { rect = node.getBoundingClientRect() } catch (error) { rect = null }
        if (rect === null || rect === undefined) continue
        var nodeTop = Number(rect.top)
        var nodeBottom = Number(rect.bottom)
        if (!Number.isFinite(nodeTop) || !Number.isFinite(nodeBottom)) continue
        var distance = Math.abs(nodeTop - threshold)
        if (distance < nearestDistance) { nearestDistance = distance; nearest = turn }
        if (nodeTop >= top && nodeBottom <= bottom && nodeTop >= threshold) return turn
        if (nodeTop <= threshold && nodeBottom > threshold) before = turn
      }
      if (before !== null) return before
      if (nearest !== null) return nearest
      // 没有 data-chat-turn：退回原生轨的 aria-label（只作兜底）。
      var current = scroller.querySelector('nav[aria-label="轮次导航"] button[aria-current="true"], nav[aria-label="Turn navigation"] button[aria-current="true"]')
      if (current === null || current === undefined) current = scroller.querySelector('nav button[data-index]')
      if (current === null || current === undefined) return null
      var label = current.getAttribute('aria-label') === null ? '' : String(current.getAttribute('aria-label'))
      var match = label.match(/(\d+)\s*轮|turn\s*(\d+)/i)
      if (match === null) return null
      var parsed = Number(match[1] !== undefined ? match[1] : match[2])
      return Number.isFinite(parsed) ? parsed : null
    }

    /** 当前轮广播：轨道解析后写这里，历史列表/详情只读。 */
    var TOPIC_ACTIVE = (function () {
      var state = { sessionId: '', turn: null }
      var listeners = []
      var retryListeners = []
      return {
        snapshot: function () { return { sessionId: state.sessionId, turn: state.turn } },
        set: function (sessionId, turn) {
          var nextSession = sessionId === null || sessionId === undefined ? '' : String(sessionId)
          var nextTurn = Number.isFinite(Number(turn)) && turn !== null ? Number(turn) : null
          if (state.sessionId === nextSession && state.turn === nextTurn) return
          state = { sessionId: nextSession, turn: nextTurn }
          for (var i = listeners.length - 1; i >= 0; i -= 1) {
            try { listeners[i](state) } catch (error) { /* 单个订阅者失败不影响其它 */ }
          }
        },
        /** 程序化跳转后通知轨道做 150/300/450 校验。 */
        requestRetry: function (turn) {
          for (var i = retryListeners.length - 1; i >= 0; i -= 1) {
            try { retryListeners[i](Number(turn)) } catch (error) { /* 忽略 */ }
          }
        },
        onRetry: function (listener) {
          if (typeof listener !== 'function') return function () {}
          retryListeners.push(listener)
          return function () {
            var at = retryListeners.indexOf(listener)
            if (at >= 0) retryListeners.splice(at, 1)
          }
        },
        subscribe: function (listener) {
          if (typeof listener !== 'function') return function () {}
          listeners.push(listener)
          return function () {
            var at = listeners.indexOf(listener)
            if (at >= 0) listeners.splice(at, 1)
          }
        },
      }
    })()

    function useTopicActiveTurn(sessionId) {
      var state = useState(TOPIC_ACTIVE.snapshot())
      useEffect(function () {
        return TOPIC_ACTIVE.subscribe(function (next) { state[1](next) })
      }, [])
      var current = state[0]
      var wanted = sessionId === null || sessionId === undefined ? '' : String(sessionId)
      return current.sessionId === wanted ? current.turn : null
    }

    /** 历史行是否属于当前打开会话，并且正好是当前轮。 */
    function historyEntryIsCurrent(entry, sessionId, activeTurn) {
      if (activeTurn === null || entry === null || entry === undefined || entry.hit === null || entry.hit === undefined) return false
      var hit = entry.hit
      var hitSession = hit.sessionId === null || hit.sessionId === undefined ? '' : String(hit.sessionId)
      var wanted = sessionId === null || sessionId === undefined ? '' : String(sessionId)
      return hitSession !== '' && hitSession === wanted && Number(hit.turn) === Number(activeTurn)
    }

    var HISTORY_CATEGORY_EMPTY_TEXT = '该分类下还没有会话'

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
      categoryId: '',
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
          if (result !== null && result !== undefined && result.ok === true) {
            try { TOPIC_ACTIVE.requestRetry(turn) } catch (error) { /* 联动失败不影响定位结果 */ }
          }
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
     * 异步提交：execCommand 在 ProseMirror/Lexical 里调用返回后编辑器还没
     * 重渲染，所以不能同步读回。流程：
     *   1. execCommand insertText → 每 30ms 轮询，最多 400ms；
     *   2. 400ms 仍没有 → 再确认一次 → DOM 兜底 → 每 30ms 轮询，最多 200ms；
     *   3. 成功/失败只 resolve 一次；轮询期间不弹任何提示。
     * 文本出现后先静置 60ms 再确认，避免"出现一下又被撤回"被当成成功。
     * 成功返回 `{ok:true, method}`；失败返回 `{ok:false, reason:'rejected'}`，
     * 由调用方复制到剪贴板并明说。
     *
     * @param text - 指针文本（不含【】）。
     * @returns {Promise<{ok:boolean, method?:string, reason?:string}>}
     */
    function historyWriteToComposer(text, options) {
      var value = String(text === null || text === undefined ? '' : text)
      if (value === '') return Promise.resolve({ ok: false, reason: 'empty' })
      var el = historyComposerElement()
      if (el === null) return Promise.resolve({ ok: false, reason: 'no-composer' })
      var kind = historyComposerKind(el)
      var rich = kind === 'rich'
      var rawMode = options !== null && options !== undefined && options.raw === true
      var inserted = rawMode ? value : ('【' + value + '】')
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

      return new Promise(function (resolve) {
        var settled = false
        function done(result) {
          if (settled) return
          settled = true
          cleanupInput()
          resolve(result)
        }

        /** 等一次 input；100ms 没有就补发，再读回确认。 */
        function ensureInput() {
          return new Promise(function (resolveInput) {
            if (inputSeen) {
              resolveInput(true)
              return
            }
            var inputSettled = false
            var timer = setTimeout(function () {
              if (inputSettled) return
              if (inputSeen) {
                inputSettled = true
                resolveInput(true)
                return
              }
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
              inputSettled = true
              resolveInput(dispatched && accepted())
            }, 100)
            inputWaiters.push(function () {
              if (inputSettled) return
              inputSettled = true
              clearTimeout(timer)
              resolveInput(true)
            })
          })
        }

        function finalizeSuccess(method) {
          ensureInput().then(function (ok) {
            if (settled) return
            if (!ok || !accepted()) {
              done({ ok: false, reason: 'rejected' })
              return
            }
            try { el.focus() } catch (error) { /* 忽略 */ }
            try {
              if (!rich) {
                var at = String(el.value || '').lastIndexOf(inserted)
                if (at >= 0 && typeof el.setSelectionRange === 'function') el.setSelectionRange(at + inserted.length, at + inserted.length)
              }
            } catch (error) { /* 光标失败不影响已插入 */ }
            done({ ok: true, method: method })
          }, function () {
            done({ ok: false, reason: 'rejected' })
          })
        }

        /** 每 30ms 查一次；出现后静置 60ms 再确认一次，撤回则继续等超时。 */
        function poll(timeoutMs, callback) {
          var started = Date.now()
          var seen = false
          var retracted = false
          function tick() {
            if (settled) return
            if (accepted()) {
              if (seen && retracted) {
                callback(true, retracted)
                return
              }
              if (!seen) {
                seen = true
                setTimeout(function () {
                  if (settled) return
                  if (accepted()) {
                    callback(true, retracted)
                    return
                  }
                  retracted = true
                  tick()
                }, 60)
                return
              }
              callback(true, retracted)
              return
            }
            if (Date.now() - started >= timeoutMs) {
              callback(false, retracted)
              return
            }
            setTimeout(tick, 30)
          }
          tick()
        }

        function domFallback() {
          if (settled) return
          // 兜底前再查一次：execCommand 可能刚好在 400ms 边界后才落盘。
          if (accepted()) {
            finalizeSuccess('exec')
            return
          }
          var domOk = rich ? historyDomInsertRich(el, inserted) : historyDomInsertText(el, inserted)
          if (!domOk) {
            done({ ok: false, reason: 'rejected' })
            return
          }
          poll(200, function (found, domRetracted) {
            if (settled) return
            if (found && !domRetracted) {
              finalizeSuccess('dom')
              return
            }
            done({ ok: false, reason: 'rejected' })
          })
        }

        // 1) 宿主编辑器优先路径：execCommand insertText；调用后不立即判定。
        var execAttempted = false
        if (typeof document !== 'undefined' && document !== null && typeof document.execCommand === 'function') {
          try {
            if (historyComposerSelect(el)) {
              execAttempted = true
              document.execCommand('insertText', false, inserted)
            }
          } catch (error) { execAttempted = true }
        }

        if (!execAttempted) {
          domFallback()
          return
        }

        poll(400, function (found, retracted) {
          if (settled) return
          if (found && !retracted) {
            finalizeSuccess('exec')
            return
          }
          if (retracted) {
            // 出现过又被撤回：不要再用 DOM 补插，直接判失败。
            done({ ok: false, reason: 'rejected' })
            return
          }
          domFallback()
        })
      })
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
     *              反查当前会话所属工作区（统一按工作区列表反查）。
     */
    // ── 右栏公共：三个 tab / 统一请求 / 统计与设置模型 ───────────────
    //
    // 历史、统计、设置都在同一个右栏里。网络请求只有一个入口，统一处理
    // Host 的 `{ok,value}` 信封：成功给 value，失败把 Host 的中文 error
    // 原样带出（409 运行中 / 503 不可用 / 404 不存在），绝不吞成"未知错误"。

    /**
     * POST /api/topic-map/<action>，统一信封。
     *
     * @param action - 端点名（stats / workspaces / config / fork / retry / brief…）。
     * @param body - 请求体；GET 请求传 null。
     * @param options - `{method}`，默认 POST。
     * @returns {Promise<{ok:true,value:*,status:number}|{ok:false,error:string,status:number,aborted?:boolean}>}
     */
    function requestTopicMap(action, body, options) {
      if (typeof fetch !== 'function') {
        return Promise.resolve({ ok: false, error: '当前环境没有 fetch', status: 0 })
      }
      var opts = options === null || options === undefined ? {} : options
      var method = typeof opts.method === 'string' ? opts.method : 'POST'
      var init = { method: method }
      if (method !== 'GET') {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body === null || body === undefined ? {} : body)
      }
      if (opts.signal !== undefined && opts.signal !== null) init.signal = opts.signal
      return fetch('api/topic-map/' + action, init).then(function (res) {
        var status = res === null || res === undefined ? 0 : Number(res.status)
        if (!Number.isFinite(status)) status = 0
        if (res === null || res === undefined) {
          return { ok: false, error: '没有响应', status: 0 }
        }
        return res.json().then(function (payload) {
          if (payload !== null && typeof payload === 'object' && payload.ok === true) {
            return { ok: true, value: payload.value, status: status }
          }
          var reason = payload !== null && typeof payload === 'object'
            && typeof payload.error === 'string' && payload.error !== ''
            ? payload.error
            : '接口返回失败（HTTP ' + String(status) + '）'
          return { ok: false, error: reason, status: status }
        }, function () {
          return { ok: false, error: '响应不是 JSON（HTTP ' + String(status) + '）', status: status }
        })
      }, function (error) {
        if (error !== null && error !== undefined && (error.name === 'AbortError' || error.historyAborted === true)) {
          return { ok: false, error: '请求已取消', status: 0, aborted: true }
        }
        return { ok: false, error: '网络请求失败：' + errorText(error), status: 0 }
      }).catch(function (error) {
        // res.json() 同步抛错等极端情况：统一信封，调用方永远拿到 ok:false。
        if (error !== null && error !== undefined && (error.name === 'AbortError' || error.historyAborted === true)) {
          return { ok: false, error: '请求已取消', status: 0, aborted: true }
        }
        return { ok: false, error: '网络请求失败：' + errorText(error), status: 0 }
      })
    }

    /** POST /workspaces 反查当前会话所属工作区；拿不到返回空串（请求体就不带）。 */
    /** 工作区显示名：title 优先，其次 path 最后一段，都没有返回空串。 */
    function workspaceDisplayName(workspace) {
      if (workspace === null || workspace === undefined || typeof workspace !== 'object') return ''
      var title = typeof workspace.title === 'string' ? workspace.title.trim() : ''
      if (title !== '') return title
      var path = typeof workspace.path === 'string' ? workspace.path.trim() : ''
      if (path === '') return ''
      var parts = path.split(/[\\/]+/).filter(function (part) { return part !== '' })
      return parts.length > 0 ? parts[parts.length - 1] : ''
    }

    function resolveWorkspaceIdForSession(sessionId) {      if (sessionId === null || sessionId === undefined || String(sessionId) === '') return Promise.resolve('')
      var wanted = String(sessionId)
      return requestTopicMap('workspaces', {}).then(function (result) {
        if (result.ok !== true || !Array.isArray(result.value)) return ''
        for (var i = 0; i < result.value.length; i += 1) {
          var workspace = result.value[i]
          if (workspace === null || typeof workspace !== 'object') continue
          var ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []
          for (var k = 0; k < ids.length; k += 1) {
            if (String(ids[k]) === wanted) return String(workspace.id)
          }
        }
        return ''
      })
    }

    /** 统计页数据：先反查工作区，再 POST /stats；反查不到就不带 workspaceId。 */
    function loadStatsForSession(sessionId) {
      return resolveWorkspaceIdForSession(sessionId).then(function (workspaceId) {
        var body = workspaceId === '' ? {} : { workspaceId: workspaceId }
        return requestTopicMap('stats', body).then(function (result) {
          return {
            ok: result.ok === true,
            value: result.ok === true ? result.value : null,
            error: result.ok === true ? '' : result.error,
            status: result.status,
            workspaceId: workspaceId,
          }
        })
      })
    }

    /** 字节 → `3.2 MB`（1024 进制，保留一位小数，整数不带 .0）。 */
    function formatIndexBytes(bytes) {
      var value = Number(bytes)
      if (!Number.isFinite(value) || value < 0) return '—'
      if (value < 1024) return Math.round(value) + ' B'
      if (value < 1024 * 1024) return (Math.round(value / 102.4) / 10) + ' KB'
      if (value < 1024 * 1024 * 1024) return (Math.round(value / 104857.6) / 10) + ' MB'
      return (Math.round(value / 107374182.4) / 10) + ' GB'
    }

    /**
     * 索引体积行文案：`12 个会话 · 3.2 MB`。
     * 缺少字段时返回 `—`，由调用方在 title 里给原因。
     */
    function indexStatsText(value) {
      var source = value !== null && typeof value === 'object' ? value : null
      if (source === null) return '—'
      var sessions = Number(source.sessions)
      var bytes = Number(source.bytes)
      if (!Number.isFinite(sessions) || sessions < 0) return '—'
      var bytesText = Number.isFinite(bytes) && bytes >= 0 ? formatIndexBytes(bytes) : '—'
      return Math.trunc(sessions) + ' 个会话 · ' + bytesText
    }

    /** 索引体积行的 title：把轮次/摘要等细节摊平，排障时能看到口径。 */
    function indexStatsTitle(value) {
      var source = value !== null && typeof value === 'object' ? value : {}
      var parts = []
      if (Number.isFinite(Number(source.sessions))) parts.push('会话 ' + Number(source.sessions))
      if (Number.isFinite(Number(source.turns))) parts.push('轮次 ' + Number(source.turns))
      if (Number.isFinite(Number(source.digests))) parts.push('摘要 ' + Number(source.digests))
      if (Number.isFinite(Number(source.bytes))) parts.push('索引 ' + formatIndexBytes(Number(source.bytes)))
      if (Number.isFinite(Number(source.digestBytes))) parts.push('摘要体积 ' + formatIndexBytes(Number(source.digestBytes)))
      return parts.length === 0 ? '索引统计不可用' : parts.join(' · ')
    }

    /** Top 会话排序的持久化键（按工作区）。 */
    function statsSortKey(workspaceId) {
      return STATS_SORT_PREFIX + (workspaceId === null || workspaceId === undefined || workspaceId === ''
        ? 'default'
        : String(workspaceId))
    }

    function readStatsSort(workspaceId) {
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
          return localStorage.getItem(statsSortKey(workspaceId)) === STATS_SORT_TOKENS
            ? STATS_SORT_TOKENS
            : STATS_SORT_TURNS
        }
      } catch (error) { /* 存储不可用只影响记忆 */ }
      return STATS_SORT_TURNS
    }

    function saveStatsSort(workspaceId, mode) {
      var next = mode === STATS_SORT_TOKENS ? STATS_SORT_TOKENS : STATS_SORT_TURNS
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
          localStorage.setItem(statsSortKey(workspaceId), next)
        }
      } catch (error) { /* 存储不可用只影响记忆 */ }
      return next
    }

    function statsCompactNumber(value) {
      var number = Number(value)
      if (!Number.isFinite(number)) return '0'
      var abs = Math.abs(number)
      var rounded = Math.round(abs)
      if (rounded < 1000) return String(rounded)
      if (rounded < 1000000) {
        var thousands = Math.round(abs / 100) / 10
        if (thousands < 1000) {
          return (Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(1)) + 'k'
        }
      }
      var millions = Math.round(abs / 100000) / 10
      return (Number.isInteger(millions) ? String(millions) : millions.toFixed(1)) + 'M'
    }

    function statsThousands(value) {
      var number = Math.trunc(Number(value))
      if (!Number.isFinite(number) || number <= 0) return '0'
      return String(number).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    }

    /**
     * 统计视图模型：页头四卡 / 用量拆分 / Top 会话行。
     * `now` 由调用方传入，纯函数便于测试。
     */
    function statsPageModel(value, now, sortMode) {
      var stats = value !== null && typeof value === 'object' ? value : {}
      var usage = stats.usage !== null && typeof stats.usage === 'object' ? stats.usage : {}
      var headline = STATSFMT.statsHeadline({
        totals: {
          sessions: stats.sessions,
          turns: stats.turns,
          activeDays: stats.activeDays,
          tokens: usage,
          cost: stats.cost,
        },
      })
      // Host 的 topSessions 字段叫 lastActive，stats-format 的行模型叫
      // lastActivity。这一层必须归一，否则相对时间永远显示「未知」。
      var topSessions = Array.isArray(stats.topSessions) ? stats.topSessions.map(function (session, index) {
        var item = session !== null && typeof session === 'object' ? session : {}
        var turns = Number(item.turns !== undefined ? item.turns : item.turnCount)
        var tokens = Number(item.tokens)
        var lastActivity = Number(item.lastActivity !== undefined ? item.lastActivity : item.lastActive)
        return {
          title: item.title,
          turns: Number.isFinite(turns) ? Math.max(0, Math.trunc(turns)) : 0,
          tokens: Number.isFinite(tokens) ? Math.max(0, tokens) : 0,
          hasTokens: item.tokens !== undefined && item.tokens !== null && Number.isFinite(Number(item.tokens)),
          lastActivity: Number.isFinite(lastActivity) ? lastActivity : null,
          index: index,
        }
      }) : []
      var hasTokens = topSessions.some(function (item) { return item.hasTokens === true })
      var mode = sortMode === STATS_SORT_TOKENS && hasTokens ? STATS_SORT_TOKENS : STATS_SORT_TURNS
      topSessions.sort(function (left, right) {
        var leftValue = mode === STATS_SORT_TOKENS ? left.tokens : left.turns
        var rightValue = mode === STATS_SORT_TOKENS ? right.tokens : right.turns
        if (rightValue !== leftValue) return rightValue - leftValue
        var leftTime = left.lastActivity === null ? -Infinity : left.lastActivity
        var rightTime = right.lastActivity === null ? -Infinity : right.lastActivity
        if (rightTime !== leftTime) return rightTime - leftTime
        return left.index - right.index
      })
      var maxValue = 0
      for (var i = 0; i < topSessions.length; i += 1) {
        var metric = mode === STATS_SORT_TOKENS ? topSessions[i].tokens : topSessions[i].turns
        if (metric > maxValue) maxValue = metric
      }
      var rows = topSessions.slice(0, 10).map(function (item) {
        var metric = mode === STATS_SORT_TOKENS ? item.tokens : item.turns
        return {
          title: typeof item.title === 'string' && item.title.trim() !== '' ? item.title.trim() : '未命名会话',
          turns: statsThousands(item.turns),
          tokens: item.tokens,
          metricText: mode === STATS_SORT_TOKENS ? statsCompactNumber(item.tokens) : statsThousands(item.turns) + ' 轮',
          lastActiveText: item.lastActivity === null ? '未知' : STATSFMT.formatRelative(item.lastActivity, now),
          barPercent: maxValue > 0 ? Math.min(100, Math.max(0, Math.round((metric / maxValue) * 100))) : 0,
        }
      })
      var sessions = Number(stats.sessions)
      if (!Number.isFinite(sessions)) sessions = 0
      return {
        headline: headline,
        usage: STATSFMT.usageSplit(usage),
        rows: rows,
        sessions: sessions,
        turns: Number.isFinite(Number(stats.turns)) ? Number(stats.turns) : 0,
        empty: sessions <= 0,
        hasUsage: Number(usage.input) > 0 || Number(usage.output) > 0,
        sortMode: mode,
        hasTokens: hasTokens,
      }
    }

    /**
     * 统计正文的 DOM 结构（不含外壳/加载/失败态）。
     *
     * 抽成 h 驱动的纯函数：测试用假 h 就能断言头条、bar 与空态，不必
     * 在 Node 里搭一套 React DOM。
     */
    function statsPageNodes(h, model, sortMode, onSortChange) {
      var mode = sortMode === STATS_SORT_TOKENS ? STATS_SORT_TOKENS : STATS_SORT_TURNS
      var sortSwitch = h('div', { className: 'dsh_tm_statssort', role: 'group', 'aria-label': 'Top 会话排序' },
        h('button', {
          type: 'button', className: 'dsh_tm_statssortbtn' + (mode === STATS_SORT_TURNS ? ' dsh_tm_statssortbtn_on' : ''),
          'data-sort': STATS_SORT_TURNS, 'aria-pressed': mode === STATS_SORT_TURNS ? 'true' : 'false',
          onClick: function () { if (typeof onSortChange === 'function') onSortChange(STATS_SORT_TURNS) },
        }, '轮数'),
        h('button', {
          type: 'button', className: 'dsh_tm_statssortbtn' + (mode === STATS_SORT_TOKENS ? ' dsh_tm_statssortbtn_on' : ''),
          'data-sort': STATS_SORT_TOKENS, 'aria-pressed': mode === STATS_SORT_TOKENS ? 'true' : 'false',
          title: model.hasTokens === true ? '按 Token 排序' : '统计接口未提供 token 数据',
          disabled: model.hasTokens !== true,
          onClick: function () { if (typeof onSortChange === 'function') onSortChange(STATS_SORT_TOKENS) },
        }, 'Token'))
      var hero = h('div', { className: 'dsh_tm_statshero', key: 'hero' },
        model.headline.map(function (card, index) {
          return h('div', { className: 'dsh_tm_statscard', key: 'card-' + index },
            h('div', { className: 'dsh_tm_statscardlabel' }, card.label),
            h('div', { className: 'dsh_tm_statscardvalue' }, card.value),
            h('div', { className: 'dsh_tm_statscardhint', title: card.hint }, card.hint))
        }))
      var usageWidth = Math.max(0, Math.min(100, Math.round((Number(model.usage.ratio) || 0) * 100)))
      var usage = h('div', { className: 'dsh_tm_statsusage', key: 'usage' },
        h('div', { className: 'dsh_tm_statssectiontitle' }, '用量拆分'),
        h('div', { className: 'dsh_tm_statsusagebar', 'data-output-percent': String(usageWidth) },
          h('div', { className: 'dsh_tm_statsusagefill', style: { width: usageWidth + '%' } })),
        h('div', { className: 'dsh_tm_statsusagelegend' },
          h('span', { className: 'dsh_tm_statsusageinput' }, '输入 ' + model.usage.inputText),
          h('span', { className: 'dsh_tm_statsusageoutput' }, '输出 ' + model.usage.outputText),
          h('span', { className: 'dsh_tm_statsusagetotal' }, '合计 ' + model.usage.totalText)))
      var list = h('div', { className: 'dsh_tm_statslistwrap', key: 'list' },
        h('div', { className: 'dsh_tm_statssectionhead' },
          h('div', { className: 'dsh_tm_statssectiontitle' }, 'Top 会话'),
          sortSwitch),
        model.rows.length === 0
          ? h('div', { className: 'dsh_tm_statsrowsempty' }, '没有可列出的会话')
          : h('div', { className: 'dsh_tm_statslist' },
            model.rows.map(function (row, index) {
              var percent = Math.max(0, Math.min(100, Number(row.barPercent) || 0))
              return h('div', { className: 'dsh_tm_statsrow', key: 'row-' + index, 'data-percent': String(percent) },
                h('div', { className: 'dsh_tm_statsrowhead' },
                  h('span', { className: 'dsh_tm_statsrowtitle', title: row.title }, row.title),
                  h('span', { className: 'dsh_tm_statsrowturns' }, row.metricText),
                  h('span', { className: 'dsh_tm_statsrowtime' }, row.lastActiveText)),
                h('div', { className: 'dsh_tm_statsbarbg' },
                  h('div', { className: 'dsh_tm_statsbar', style: { width: percent + '%' } })))
            })))
      return [hero, usage, list]
    }

    /** 轨道档位文案：设置页与按钮共用。 */
    function railTierText(tierValue) {
      if (tierValue === RAIL_TIER_MIN) return '最小'
      if (tierValue === RAIL_TIER_MAX) return '最大'
      return '标准'
    }

    /** 三个设置面共读的一份轨道偏好快照。 */
    function railPrefsSnapshot() {
      if (typeof RAILTAKE === 'undefined' || RAILTAKE === null) {
        return {
          native: false, autoHide: true, tier: RAIL_TIER_STD,
          effectiveTier: RAIL_TIER_STD, tierText: '标准', width: RAIL_STD_FALLBACK,
        }
      }
      return {
        native: RAILTAKE.nativePreferred(),
        autoHide: RAILTAKE.autoHideEnabled(),
        tier: RAILTAKE.tier(),
        effectiveTier: RAILTAKE.effectiveTier(),
        tierText: RAILTAKE.tierText(),
        width: RAILTAKE.tierWidthOf(),
      }
    }


    /** 三个 tab 的切换条：右栏正文顶部。 */
    function RightTabStrip(props) {
      var active = props === null || props === undefined ? '' : props.active
      var open = props === null || props === undefined || typeof props.open !== 'function'
        ? null
        : props.open
      return h('div', { className: 'dsh_tm_righttabs', role: 'tablist', 'aria-label': '历史检索' },
        RIGHT_TABS.map(function (tab) {
          var on = tab.kind === active
          return h('button', {
            key: tab.kind,
            type: 'button',
            role: 'tab',
            'aria-selected': on ? 'true' : 'false',
            className: 'dsh_tm_righttab' + (on ? ' dsh_tm_righttab_on' : ''),
            'data-kind': tab.kind,
            onClick: function (event) {
              if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') {
                event.stopPropagation()
              }
              if (open !== null) open(tab.kind)
            },
          }, tab.title)
        }))
    }

    /**
     * 历史动作的请求体（纯函数）：分叉 / 重试 / 生成简报。
     *
     * 历史列表里的一条命中就是一轮，所以简报的 turns 只含这一轮。
     * 参数非法返回 null，由调用方显示"缺少会话或轮次信息"。
     */
    function historyActionRequest(kind, hit) {
      var sessionId = hit !== null && hit !== undefined && typeof hit.sessionId === 'string'
        ? hit.sessionId.trim()
        : ''
      var turn = Number(hit !== null && hit !== undefined ? hit.turn : NaN)
      if (sessionId === '' || !Number.isInteger(turn) || turn < 0) return null
      if (kind === 'fork') return { action: 'fork', body: { sessionId: sessionId, turn: turn } }
      if (kind === 'retry') return { action: 'retry', body: { sessionId: sessionId, turn: turn } }
      if (kind === 'brief') return { action: 'brief', body: { sessionId: sessionId, turns: [turn] } }
      return null
    }

    /** 是否要二次确认：只有重试会新建会话并重新提交，分叉/简报不需要。 */
    function historyActionNeedsConfirm(kind) {
      return kind === 'retry'
    }

    /** 发一个历史动作；返回统一信封。 */
    function runHistoryAction(kind, hit) {
      var request = historyActionRequest(kind, hit)
      if (request === null) return Promise.resolve({ ok: false, error: '缺少会话或轮次信息', status: 0 })
      return requestTopicMap(request.action, request.body)
    }

    /** 动作成功文案（中文，带新会话 id / 文件路径）。 */
    function historyActionSuccessText(kind, hit, value) {
      var turn = Number(hit !== null && hit !== undefined ? hit.turn : NaN)
      if (kind === 'fork') return '已从第 ' + turn + ' 轮之前分叉'
      if (kind === 'retry') {
        var id = value !== null && typeof value === 'object' ? String(value.sessionId ?? '') : ''
        return id === '' ? '已重试' : '已重试：新会话 ' + id
      }
      if (kind === 'brief') {
        var path = value !== null && typeof value === 'object' ? String(value.path ?? '') : ''
        return path === '' ? '简报已生成' : '简报已生成：' + path
      }
      return '操作完成'
    }

    /** 动作失败文案：Host 的中文 error 原样带出。 */
    function historyActionErrorText(kind, error) {
      var prefix = kind === 'fork' ? '分叉失败' : kind === 'retry' ? '重试失败' : '生成简报失败'
      var reason = error === null || error === undefined || String(error) === '' ? '未知原因' : String(error)
      return prefix + '：' + reason
    }

    /**
     * 从一次历史检索结果里取「当前会话」的命中轮号。
     *
     * 跨会话检索会同时命中别的会话；轨道只标记当前会话，别把别人的轮号
     * 标到自己的刻度上。结果按轮号去重、只认正整数。
     */
    function historyRailHitTurns(hits, sessionId) {
      var wanted = String(sessionId === null || sessionId === undefined ? '' : sessionId)
      var out = []
      if (wanted === '' || !Array.isArray(hits)) return out
      for (var i = 0; i < hits.length; i += 1) {
        var hit = hits[i]
        if (hit === null || typeof hit !== 'object') continue
        if (String(hit.sessionId === null || hit.sessionId === undefined ? '' : hit.sessionId) !== wanted) continue
        var turn = Number(hit.turn)
        if (!Number.isInteger(turn) || turn <= 0) continue
        if (out.indexOf(turn) < 0) out.push(turn)
      }
      return out
    }

    /** 设置页的默认值（来自 settingsModel 的模型默认，railNative 不在 Host 配置里）。 */
    function settingsDefaultValues() {
      var model = SETTINGVIEW.settingsModel({})
      var out = {}
      for (var g = 0; g < model.groups.length; g += 1) {
        for (var i = 0; i < model.groups[g].items.length; i += 1) {
          var item = model.groups[g].items[i]
          if (item.type === 'readonly' || item.type === 'button') continue
          out[item.key] = item.value
        }
      }
      delete out.railNative
      return out
    }

    /** 当前会话所属工作区（设置页重建索引用）；拿不到返回空串。 */
    function currentWorkspaceId(sessionId) {
      return resolveWorkspaceIdForSession(sessionId)
    }

    function useTopicMapTheme() {
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
    }

    /**
     * 解析输入框里的 `分类:名称 关键词` 前缀。
     *
     * 只做本地匹配：名称取第一个空格前的片段（分类名里通常没有空格），
     * 在已有分类选项里按「完全相同 > 包含」收集候选。唯一命中就返回
     * matched，多个返回 candidates 给下拉，零个返回空候选（不硬猜）。
     *
     * @param raw - 输入框原文。
     * @param options - `categoryFlatOptions` 的扁平分类列表。
     * @returns `{active, name, keywords, candidates, matched}`。
     */
    function parseCategoryPrefix(raw, options) {
      var text = String(raw === null || raw === undefined ? '' : raw)
      var match = text.match(/^分类\s*[:：]\s*([\s\S]*)$/)
      if (match === null) {
        return { active: false, name: '', keywords: text.trim(), candidates: [], matched: null }
      }
      var rest = match[1].replace(/^\s+/, '')
      var cut = rest.search(/\s/)
      var name = cut < 0 ? rest : rest.slice(0, cut)
      var keywords = cut < 0 ? '' : rest.slice(cut).trim()
      var list = Array.isArray(options) ? options : []
      var exact = []
      var partial = []
      if (name !== '') {
        for (var i = 0; i < list.length; i += 1) {
          var option = list[i]
          if (option === null || typeof option !== 'object') continue
          if (option.name === name) exact.push(option)
          else if (String(option.name).indexOf(name) >= 0 || String(option.path).indexOf(name) >= 0) partial.push(option)
        }
      }
      var candidates = exact.length > 0 ? exact : partial
      return {
        active: true,
        name: name,
        keywords: keywords,
        candidates: candidates,
        matched: candidates.length === 1 ? candidates[0] : null,
      }
    }


    var HISTORY_PAGE_SIZE_DEFAULT = 10
    var HISTORY_PAGE_SIZE_OPTIONS = [10, 15, 20]
    var HISTORY_PAGE_SIZE_PREFIX = 'dsh.tm.history.pageSize.'

    function historyPageSizeKey(workspaceId) {
      return HISTORY_PAGE_SIZE_PREFIX + (workspaceId === null || workspaceId === undefined || workspaceId === ''
        ? 'default'
        : String(workspaceId))
    }

    function readHistoryPageSize(workspaceId) {
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
          var value = Number(localStorage.getItem(historyPageSizeKey(workspaceId)))
          if (HISTORY_PAGE_SIZE_OPTIONS.indexOf(value) >= 0) return value
        }
      } catch (error) { /* 存储不可用只影响记忆 */ }
      return HISTORY_PAGE_SIZE_DEFAULT
    }

    function saveHistoryPageSize(workspaceId, value) {
      var next = HISTORY_PAGE_SIZE_OPTIONS.indexOf(Number(value)) >= 0 ? Number(value) : HISTORY_PAGE_SIZE_DEFAULT
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
          localStorage.setItem(historyPageSizeKey(workspaceId), String(next))
        }
      } catch (error) { /* 存储不可用只影响记忆 */ }
      return next
    }

    function historyPageCount(total, pageSize) {
      var size = Number(pageSize)
      if (!Number.isFinite(size) || size <= 0) size = HISTORY_PAGE_SIZE_DEFAULT
      var count = Number(total)
      if (!Number.isFinite(count) || count <= 0) return 1
      return Math.max(1, Math.ceil(count / size))
    }

    /** 空结果文案：选中分类但覆盖会话为 0 时，说明是分类范围问题。 */
    function historyEmptyText(result, categoryId) {
      var selected = categoryId === null || categoryId === undefined ? '' : String(categoryId)
      var coverage = result !== null && result !== undefined ? result.coverage : null
      var sessions = coverage !== null && coverage !== undefined ? Number(coverage.sessions) : NaN
      if (selected !== '' && Number.isFinite(sessions) && sessions === 0) {
        return '该分类下没有可检索的会话'
      }
      return HISTORY_EMPTY_TEXT
    }

    var HISTORY_CACHE_TTL_MS = 5 * 60 * 1000
    var HISTORY_CACHE = new Map()
    var HISTORY_WARMED = {}
    var HISTORY_JUMP_RESTORE = null

    function historyCacheGet(workspaceId) {
      var key = workspaceId === null || workspaceId === undefined ? '' : String(workspaceId)
      if (key === '' || typeof HISTORY_CACHE.get !== 'function') return null
      var value = HISTORY_CACHE.get(key)
      if (value === null || value === undefined) return null
      return {
        categories: value.categories || null,
        firstPage: value.firstPage || null,
        at: Number(value.at) || 0,
        stale: Date.now() - (Number(value.at) || 0) > HISTORY_CACHE_TTL_MS,
      }
    }

    function historyCacheEnsure(workspaceId) {
      var key = workspaceId === null || workspaceId === undefined ? '' : String(workspaceId)
      if (key === '') return null
      var value = HISTORY_CACHE.get(key)
      if (value === undefined || value === null || typeof value !== 'object') {
        value = { categories: null, firstPage: null, at: Date.now() }
        HISTORY_CACHE.set(key, value)
      }
      return value
    }

    function historyCachePutCategories(workspaceId, value) {
      var record = historyCacheEnsure(workspaceId)
      if (record === null || value === null || value === undefined) return
      record.categories = value
      record.at = Date.now()
    }

    function historyCachePutFirstPage(workspaceId, result) {
      var record = historyCacheEnsure(workspaceId)
      if (record === null || result === null || result === undefined) return
      record.firstPage = result
      record.at = Date.now()
    }

    /** 工作区预热：每次运行每个工作区只发一次，不 await、失败静默。 */
    function historyWarmup(workspaceId) {
      var key = workspaceId === null || workspaceId === undefined ? '' : String(workspaceId)
      if (key === '' || HISTORY_WARMED[key] === true) return
      HISTORY_WARMED[key] = true
      try {
        requestTopicMap('workspace-warmup', { workspaceId: key }).catch(function () { /* 预热失败静默 */ })
      } catch (error) { /* 端点未就绪时静默 */ }
    }

    /** 历史页最近一次渲染快照，供轨道诊断读取（只读，不参与渲染）。 */
    var HISTORY_DIAG = {
      plan: { keywords: '', categoryId: '', idle: true },
      result: { status: 'idle', hits: 0, total: 0, recent: false, hasMore: false },
      categoryData: { hasStore: false, categories: 0, sessions: 0 },
      browse: { rows: 0, page: 0, pageCount: 1, total: 0 },
      branch: 'idle',
    }

    function recordHistoryDiagnostics(next) {
      if (next === null || next === undefined || typeof next !== 'object') return
      HISTORY_DIAG = next
    }

    /** 动作条纯图标阈值：只有真实宽度低于 220px 才降级。 */
    var HISTORY_ACTION_ICON_WIDTH = 220

    function historyActionsIconOnly(width) {
      var value = Number(width)
      return Number.isFinite(value) && value > 0 && value < HISTORY_ACTION_ICON_WIDTH
    }

    /**
     * 历史结果动作条：始终保留文字，窄时换行；只有 <220px 才切纯图标。
     *
     * ResizeObserver 只在跨阈值时 setState，避免宽度连续变化引发重渲染抖动。
     * `measureWidth` 仅给测试注入固定宽度，生产不传。
     */
    function HistoryActionBar(props) {
      var actions = props !== null && props !== undefined && Array.isArray(props.actions)
        ? props.actions
        : []
      var initialWidth = props !== null && props !== undefined ? props.measureWidth : undefined
      var iconState = useState(historyActionsIconOnly(initialWidth))
      var iconOnly = iconState[0]; var setIconOnly = iconState[1]
      var rowRef = useRef(null)

      useEffect(function () {
        var node = rowRef.current
        if (node === null || node === undefined) return undefined
        function apply(width) {
          if (!Number.isFinite(Number(width)) || Number(width) <= 0) return
          var next = historyActionsIconOnly(width)
          setIconOnly(function (prev) { return prev === next ? prev : next })
        }
        var Observer = typeof ResizeObserver === 'function' ? ResizeObserver : null
        if (Observer !== null && typeof Observer === 'function') {
          var observer = new Observer(function (entries) {
            var list = Array.isArray(entries) ? entries : []
            var width = list.length > 0 && list[0] !== null && list[0] !== undefined
              && list[0].contentRect !== null && list[0].contentRect !== undefined
              ? list[0].contentRect.width
              : (node.clientWidth || 0)
            apply(width)
          })
          try { observer.observe(node) } catch (error) { /* 不支持就退回一次测量 */ }
          try {
            if (typeof node.getBoundingClientRect === 'function') {
              apply(node.getBoundingClientRect().width)
            }
          } catch (error) { /* 忽略测量失败 */ }
          return function () {
            try { observer.disconnect() } catch (error) { /* 已断开 */ }
          }
        }
        try {
          if (typeof node.getBoundingClientRect === 'function') {
            apply(node.getBoundingClientRect().width)
          }
        } catch (error) { /* 忽略测量失败 */ }
        return undefined
      }, [props.actionKey])

      var buttons = actions.map(function (item) {
        var attrs = item !== null && item !== undefined && item.attrs !== null
          && typeof item.attrs === 'object' ? item.attrs : {}
        var buttonProps = {
          key: item.key,
          type: 'button',
          className: item.className,
          title: item.title,
          'aria-label': item.ariaLabel,
          onClick: item.onClick,
          style: {
            flex: '0 0 auto',
            flexShrink: 0,
            whiteSpace: 'nowrap',
            minWidth: 'max-content',
          },
        }
        for (var name in attrs) buttonProps[name] = attrs[name]
        return h('button', buttonProps,
          h('span', { className: 'dsh_tm_histbtnicon', 'aria-hidden': 'true' }, item.icon),
          item.label === null || item.label === undefined || item.label === ''
            ? null
            : h('span', { className: 'dsh_tm_histbtnlabel' }, item.label))
      })

      return h('div', {
        className: 'dsh_tm_histactionrow',
        ref: rowRef,
        'data-icon-only': iconOnly ? '1' : '0',
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px 8px',
          alignItems: 'center',
        },
      }, buttons)
    }

    /** 历史页的时间线视图：同一份搜索命中交给 CLUEVIEW 渲染。 */
    function HistoryClueTimeline(props) {
      var hits = props !== null && props !== undefined && Array.isArray(props.hits) ? props.hits : []
      var keywords = props !== null && props !== undefined ? props.keywords : ''
      var onJump = props !== null && props !== undefined && typeof props.onJump === 'function'
        ? props.onJump
        : function () {}
      var model = useMemo(function () {
        return CLUEVIEW.buildClue(clueRowsOfHits(hits), {
          keywords: keywords === '' ? '分类浏览' : keywords,
          now: Date.now(),
          limit: 200,
        })
      }, [hits, keywords])
      if (model.timeline.length === 0) {
        return h('div', { className: 'dsh_tm_history_empty' }, HISTORY_EMPTY_TEXT)
      }
      return h('div', { className: 'dsh_tm_histtimelinewrap' },
        h('div', { className: 'dsh_tm_cluestats' }, clueStatsText(model.stats)),
        h('div', { className: 'dsh_tm_histtimeline' },
          model.timeline.map(function (item, index) {
            return clueRowNode(item, index, onJump)
          })))
    }

    /**
     * 渲染入口的 idle 判定：结果与当前计划不一致时，不允许旧结果再画一帧。
     * 分类浏览和「全部」现在都用 /search 的轮次行，不再有独立的会话清单分支。
     */
    function historyIdleGuide(result, plan) {
      if (result === null || result === undefined) return true
      if (result.status === 'idle') return true
      var expectedKeywords = plan !== null && plan !== undefined && plan.keywords !== undefined
        ? String(plan.keywords) : ''
      var expectedCategory = plan !== null && plan !== undefined && plan.categoryId !== undefined
        ? String(plan.categoryId) : ''
      var actualKeywords = result.query === null || result.query === undefined ? '' : String(result.query)
      var actualCategory = result.categoryId === null || result.categoryId === undefined ? '' : String(result.categoryId)
      return actualKeywords !== expectedKeywords || actualCategory !== expectedCategory
    }

    function HistoryTabBody(props) {
      var boundSessionId = props === null || props === undefined ? null : props.sessionId
      var activeTurn = useTopicActiveTurn(boundSessionId)

      function isCurrentEntry(entry) {
        return historyEntryIsCurrent(entry, boundSessionId, activeTurn)
      }

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
      var selectedState = useState(-1)
      var selected = selectedState[0]; var setSelected = selectedState[1]
      var activeRowKeyState = useState('')
      var activeRowKey = activeRowKeyState[0]; var setActiveRowKey = activeRowKeyState[1]
      var selectionRef = useRef({ key: '', index: -1 })
      // C3：动作条 / 详情 / 标记 / 行内提示 / 引用预算确认。
      var labelsState = useState({})
      var labels = labelsState[0]; var setLabels = labelsState[1]
      var menuState = useState(false)
      var menuOpen = menuState[0]; var setMenuOpen = menuState[1]
      var detailState = useState(null)
      var detail = detailState[0]; var setDetail = detailState[1]
      var noticeState = useState(null)
      var notice = noticeState[0]; var setNotice = noticeState[1]
      // 历史管理动作：分叉 / 重试 / 生成简报。
      var actionBusyState = useState('')
      var actionBusy = actionBusyState[0]; var setActionBusy = actionBusyState[1]
      var confirmState = useState(null)
      var confirmAction = confirmState[0]; var setConfirmAction = confirmState[1]
      var diagState = useState(HISTORY_DIAGNOSTIC)
      var diagText = diagState[0]; var setDiagText = diagState[1]
      // 复制浮窗：null / {kind:'commands',...} / {kind:'conclusion',...}
      var modalState = useState(null)
      var modal = modalState[0]; var setModal = modalState[1]
      // 回滚预演浮窗：null / {key, status:'loading'|'ready'|'error', value, error}。
      // 只读，不提供任何写文件动作（A-12 的执行层不在本轮）。
      var rollbackState = useState(null)
      var rollback = rollbackState[0]; var setRollback = rollbackState[1]
      // 历史页：分类过滤 / 分类数据 / 列表-时间线视图 / 手动触发序号。
      var categoryIdState = useState('')
      var categoryId = categoryIdState[0]; var setCategoryId = categoryIdState[1]
      var categoryDataState = useState(null)
      var categoryData = categoryDataState[0]; var setCategoryData = categoryDataState[1]
      var viewMode = HISTORY_LIST_VIEW
      var categoryRefreshState = useState(0)
      var categoryRefresh = categoryRefreshState[0]; var setCategoryRefresh = categoryRefreshState[1]
      var overrideState = useState(null)
      var override = overrideState[0]; var setOverride = overrideState[1]
      var lockedState = useState({})
      var lockedSessions = lockedState[0]; var setLockedSessions = lockedState[1]
      var searchNonceState = useState(0)
      var searchNonce = searchNonceState[0]; var setSearchNonce = searchNonceState[1]
      var pageState = useState(0)
      var page = pageState[0]; var setPage = pageState[1]
      var pageSizeState = useState(HISTORY_PAGE_SIZE_DEFAULT)
      var pageSize = pageSizeState[0]; var setPageSize = pageSizeState[1]
      var pageSizeWorkspaceRef = useRef('')
      var immediateSearchRef = useRef(false)
      var workspaceLabelState = useState('')
      var workspaceLabel = workspaceLabelState[0]; var setWorkspaceLabel = workspaceLabelState[1]
      var workspaceLabelSeqRef = useRef(0)
      var workspaceLabelRef = useRef('')
      var searchBoundRef = useRef('')

      // 并发控制：seq 每次新查询自增；abort 断掉上一次的网络请求。
      var seqRef = useRef(0)
      var abortRef = useRef(null)
      // 历史检索 → 轨道命中标记：记录上一次非空查询，区分「首次空态」与「清空搜索」。
      var lastRailQueryRef = useRef('')
      // 防抖定时器与列表滚动容器（选中行要滚进视野）。
      var timerRef = useRef(0)
      var listRef = useRef(null)
      var noticeTimerRef = useRef(0)
      var modalListRef = useRef(null)
      var modalSeqRef = useRef(0)
      var modalFilterTimerRef = useRef(0)
      var modalRef = useRef(null)
      modalRef.current = modal
      // 回滚预演请求序号：关闭浮窗或换一条后，迟到的响应不得把浮窗重新打开。
      var rollbackSeqRef = useRef(0)

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

      /** 4 秒后自动消失的行内提示；可带一个动作按钮（打开新会话 / 复制路径）。 */
      function showHistoryNotice(text, tone, action) {
        var message = String(text === null || text === undefined ? '' : text)
        if (message === '') return
        setNotice({
          text: message,
          tone: tone === 'error' ? 'error' : (tone === 'ok' ? 'ok' : 'info'),
          action: action !== null && action !== undefined && typeof action.onClick === 'function'
            ? { label: String(action.label === undefined ? '' : action.label), onClick: action.onClick }
            : null,
        })
        if (noticeTimerRef.current !== 0) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = setTimeout(function () {
          noticeTimerRef.current = 0
          setNotice(null)
        }, 4000)
      }

      /** 通过 uiWorkspace 打开一个会话（分叉 / 重试成功后跳转）。 */
      function openSessionById(sessionId) {
        var id = String(sessionId === null || sessionId === undefined ? '' : sessionId)
        if (id === '') return
        var opener = UI_WORKSPACE_SERVICE
        if (opener === null || opener === undefined || typeof opener.openSession !== 'function') {
          showHistoryNotice('无法打开新会话：uiWorkspace.openSession 不可用', 'error')
          return
        }
        try {
          var maybe = opener.openSession(id)
          if (maybe !== null && maybe !== undefined && typeof maybe.then === 'function') {
            maybe.catch(function () { /* 切换失败不影响已经完成的分叉/重试 */ })
          }
        } catch (error) {
          showHistoryNotice('打开新会话失败：' + errorText(error), 'error')
        }
      }

      /** 真正发请求（重试已确认后才走到这里）。 */
      function executeHistoryAction(kind, entry) {
        if (entry === null || entry === undefined || actionBusy !== '') return
        setMenuOpen(false)
        setActionBusy(kind)
        showHistoryNotice(kind === 'fork' ? '正在分叉…' : kind === 'retry' ? '正在重试…' : '正在生成简报…', 'info')
        runHistoryAction(kind, entry.hit).then(function (result) {
          setActionBusy('')
          if (result === null || result === undefined || result.ok !== true) {
            showHistoryNotice(historyActionErrorText(kind, result === null || result === undefined ? '没有响应' : result.error), 'error')
            return
          }
          var text = historyActionSuccessText(kind, entry.hit, result.value)
          var action = null
          if (kind === 'fork' || kind === 'retry') {
            var newId = result.value !== null && typeof result.value === 'object' ? result.value.sessionId : ''
            action = {
              label: '打开新会话',
              onClick: function () { openSessionById(newId) },
            }
          } else if (kind === 'brief') {
            var path = result.value !== null && typeof result.value === 'object' ? result.value.path : ''
            action = {
              label: '复制路径',
              onClick: function () {
                historyCopyText(path).then(function (ok) {
                  showHistoryNotice(ok ? '已复制简报路径' : '复制失败：剪贴板不可用', ok ? 'ok' : 'error')
                })
              },
            }
          }
          showHistoryNotice(text, 'ok', action)
        })
      }

      /** 将当前历史轮次/话题段一键升格为「事」（POST /work-promote）。 */
      function promoteHistoryEntryToWork(entry) {
        if (entry === null || entry === undefined || entry.hit === null || entry.hit === undefined) return
        if (actionBusy !== '') return
        var seg = buildPromoteSegmentPayload(entry.hit)
        if (seg === null) return
        setMenuOpen(false)
        setActionBusy('promote')
        showHistoryNotice('正在转为事…', 'info')
        currentWorkspaceId(entry.hit.sessionId || boundSessionId).then(function (wsId) {
          var body = { segment: seg }
          if (wsId !== '') body.workspaceId = wsId
          return requestTopicMap('work-promote', body)
        }).then(function (result) {
          setActionBusy('')
          if (result === null || result === undefined || result.ok !== true) {
            showHistoryNotice('转为事失败：' + (result && result.error ? result.error : '未知错误'), 'error')
            return
          }
          var openWorks = props !== null && props !== undefined && typeof props.openTab === 'function'
            ? { label: '去「续接」查看', onClick: function () { props.openTab(WORKS_KIND) } }
            : null
          showHistoryNotice('已转为「事」并加入续接清单', 'ok', openWorks)
        })
      }

      /** 菜单入口：重试先弹确认，其余直接执行。 */
      function requestHistoryAction(kind, entry) {
        if (actionBusy !== '') return
        if (historyActionNeedsConfirm(kind)) {
          setMenuOpen(false)
          setConfirmAction(entry)
          return
        }
        executeHistoryAction(kind, entry)
      }

      /** 重试确认浮层（不用原生 confirm）。 */
      function renderActionConfirm() {
        if (confirmAction === null || confirmAction === undefined) return null
        return h('div', {
          className: 'dsh_tm_histmodal',
          role: 'dialog',
          'aria-modal': 'true',
          onClick: function () { setConfirmAction(null) },
        },
          h('div', {
            className: 'dsh_tm_histdialog dsh_tm_histconfirm',
            onClick: function (event) { event.stopPropagation() },
          },
            h('div', { className: 'dsh_tm_histdialoghead' },
              h('div', { className: 'dsh_tm_histdialogtitle' }, '确认重试'),
              h('button', {
                type: 'button', className: 'dsh_tm_histdialogclose',
                'aria-label': '取消',
                onClick: function () { setConfirmAction(null) },
              }, '×')),
            h('div', { className: 'dsh_tm_histconfirmtext' }, HISTORY_RETRY_CONFIRM_TEXT),
            h('div', { className: 'dsh_tm_histconfirmactions' },
              h('button', {
                type: 'button', className: 'dsh_tm_semapply', 'data-action': 'retry-confirm',
                onClick: function () {
                  var entry = confirmAction
                  setConfirmAction(null)
                  executeHistoryAction('retry', entry)
                },
              }, '继续'),
              h('button', {
                type: 'button', className: 'dsh_tm_diagclose',
                onClick: function () { setConfirmAction(null) },
              }, '取消'))))
      }
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
       * 历史检索结果 → 当前会话的历史轨命中标记。
       *
       * 三条规则：
       *   - 新查询/查询中：先清空，避免旧结果在轨道上残留；
       *   - ready：只取当前会话命中的轮号，整组替换；
       *   - 失败：清空（失败结果不可信）。
       * 首次打开面板（query 为空）不动已持久化的标记，这样切回来还能看到
       * 上一次搜索的命中；用户主动清空搜索才整组清掉。
       */
      useEffect(function () {
        if (typeof RAILTAKE === 'undefined' || RAILTAKE === null || typeof RAILTAKE.setHits !== 'function') return
        var sid = boundSessionId === null || boundSessionId === undefined ? '' : String(boundSessionId)
        if (sid === '') return
        var plan = currentHistoryPlan()
        var text = plan.paused || plan.idle ? '' : String(plan.keywords === null || plan.keywords === undefined ? '' : plan.keywords).trim()
        if (text === '') {
          if (lastRailQueryRef.current !== '') {
            lastRailQueryRef.current = ''
            RAILTAKE.setHits(sid, [])
          }
          return
        }
        lastRailQueryRef.current = text
        if (result.status === 'ready' && String(result.query === null || result.query === undefined ? '' : result.query) === text) {
          RAILTAKE.setHits(sid, historyRailHitTurns(result.hits, sid))
        } else {
          RAILTAKE.setHits(sid, [])
        }
      }, [query, categoryId, categoryData, result.status, result.hits, boundSessionId])

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
       * @returns {Promise<object|null>} 归一化结果；被取消时由调用方丢弃。
       */
      function requestHistory(plan) {
        var request = plan !== null && plan !== undefined && typeof plan === 'object' ? plan : {}
        var text = String(request.keywords === null || request.keywords === undefined ? '' : request.keywords).trim()
        var filter = String(request.categoryId === null || request.categoryId === undefined ? '' : request.categoryId).trim()

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
        var body = {
          sessionId: boundSessionId,
          keywords: text,
          offset: page * pageSize,
          limit: pageSize,
        }
        // 分类 id 属于某个工作区：与 /categories 使用同一个 workspaceId，避免
        // 用当前会话反解到另一个工作区后交集为空。
        var searchWorkspaceId = categoryData !== null && categoryData !== undefined
          && typeof categoryData.workspaceId === 'string' ? categoryData.workspaceId : ''
        if (searchWorkspaceId !== '') body.workspaceId = searchWorkspaceId
        // 全部 = 不传；未归类 = __none__；具体分类 = id。
        if (filter !== '') body.categoryId = filter
        var init = {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
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
            categoryId: filter,
            offset: Number.isFinite(Number(value.offset)) ? Number(value.offset) : page * pageSize,
            hasMore: value.hasMore === true,
          }
        })
      }

      /** 发一次查询，并把结果落到状态机（loading → ready / error）。 */
      function startHistorySearch(plan) {
        var planKeywords = plan !== null && plan !== undefined && plan.keywords !== undefined
          ? String(plan.keywords) : ''
        var planCategory = plan !== null && plan !== undefined && plan.categoryId !== undefined
          ? String(plan.categoryId) : ''
        selectionRef.current = { key: '', index: -1 }
        setSelected(-1)
        setActiveRowKey('')
        // 先清掉旧模式的命中，避免“全部/分类/关键词”切换时闪一帧旧行。
        setResult(function (prev) {
          return {
            status: 'loading',
            hits: [],
            total: prev.total,
            truncated: false,
            indexed: prev.indexed,
            workspace: prev.workspace,
            workspaceReason: prev.workspaceReason,
            coverage: prev.coverage,
            elapsedMs: prev.elapsedMs,
            error: '',
            query: planKeywords,
            categoryId: planCategory,
            offset: page * pageSize,
            hasMore: false,
          }
        })

        var pending
        try {
          pending = requestHistory(plan)
        } catch (error) {
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
              query: planKeywords,
              categoryId: planCategory,
              offset: prev.offset,
              hasMore: prev.hasMore,
            }
          })
          return
        }
        if (pending === null || pending === undefined) return
        var seq = seqRef.current
        pending.then(function (value) {
          if (value === null || seq !== seqRef.current) return
          if (abortRef.current !== null) abortRef.current = null
          var ready = {
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
            categoryId: value.categoryId,
            offset: value.offset,
            hasMore: value.hasMore,
          }
          setResult(ready)
          if (page === 0 && planKeywords === '' && planCategory === '' && categoryWorkspaceId !== '') {
            historyCachePutFirstPage(categoryWorkspaceId, ready)
          }
          setSelected(-1)
          setActiveRowKey('')
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
              categoryId: prev.categoryId,
              offset: prev.offset,
              hasMore: prev.hasMore,
            }
          })
        })
      }

      /** 当前工作区 id（分类数据优先，其次检索结果），用于视图/折叠记忆。 */
      function historyWorkspaceId() {
        if (categoryData !== null && categoryData !== undefined && categoryData.workspaceId) {
          return String(categoryData.workspaceId)
        }
        if (result.workspace !== null && result.workspace !== undefined && result.workspace.id) {
          return String(result.workspace.id)
        }
        return ''
      }

      /** 当前分类树的可选项（分类名 → id）；分类未加载时为空。 */
      function historyCategoryOptions() {
        return categoryData !== null && categoryData !== undefined && categoryData.store !== null
          ? categoryFlatOptions(categoryData.store, '')
          : []
      }

      /**
       * 当前输入 + 分类树 + `分类:` 前缀 → 一次检索计划。
       *
       * - 全部 + 无关键词 = idle（显示引导空态）；
       * - 选中分类 + 无关键词 = 该分类（含全部）的会话浏览态；
       * - 前缀唯一命中 = 用命中分类；多个候选/零候选 = 暂停检索，等用户选择。
       */
      function currentHistoryPlan() {
        var options = historyCategoryOptions()
        var prefix = parseCategoryPrefix(query, options)
        if (prefix.active) {
          if (prefix.candidates.length > 1) {
            return { idle: false, paused: true, reason: 'multiple', keywords: prefix.keywords, categoryId: categoryId, prefix: prefix }
          }
          if (prefix.matched === null) {
            return { idle: false, paused: true, reason: 'none', keywords: prefix.keywords, categoryId: categoryId, prefix: prefix }
          }
          return {
            idle: false,
            paused: false,
            keywords: prefix.keywords,
            categoryId: prefix.matched.id,
            prefix: prefix,
          }
        }
        var text = String(query === null || query === undefined ? '' : query).trim()
        if (text === '' && categoryId === '') {
          // 全部也是检索态：空关键词 + 不带 categoryId，走 /search 拿轮次。
          return { idle: false, paused: false, keywords: '', categoryId: '', prefix: prefix }
        }
        return { idle: false, paused: false, keywords: text, categoryId: categoryId, prefix: prefix }
      }

      var historyPlan = currentHistoryPlan()

      // 每页条数按工作区记忆；工作区变化时重新读并回第 1 页。
      useEffect(function () {
        var workspace = historyWorkspaceId()
        if (pageSizeWorkspaceRef.current === workspace) return
        pageSizeWorkspaceRef.current = workspace
        setPageSize(readHistoryPageSize(workspace))
        setPage(0)
      }, [categoryData, result.workspace])

      // 标题里的工作区名：/workspaces 的 title 优先，path 最后一段兜底。
      useEffect(function () {
        var id = historyWorkspaceId()
        if (id === workspaceLabelRef.current) return
        workspaceLabelRef.current = id
        workspaceLabelSeqRef.current += 1
        var token = workspaceLabelSeqRef.current
        if (id === '') {
          setWorkspaceLabel('')
          return
        }
        var immediate = result.workspace !== null && result.workspace !== undefined
          && String(result.workspace.id || '') === id ? workspaceDisplayName(result.workspace) : ''
        if (immediate !== '') setWorkspaceLabel(immediate)
        requestTopicMap('workspaces', {}).then(function (res) {
          if (token !== workspaceLabelSeqRef.current) return
          var list = res !== null && res !== undefined && res.ok === true && Array.isArray(res.value) ? res.value : []
          var found = null
          for (var i = 0; i < list.length; i += 1) {
            if (list[i] !== null && list[i] !== undefined && String(list[i].id) === id) { found = list[i]; break }
          }
          setWorkspaceLabel(found === null ? immediate : workspaceDisplayName(found))
        }, function () {
          if (token === workspaceLabelSeqRef.current) setWorkspaceLabel(immediate)
        })
      }, [categoryData, result.workspace])

      // 命中工作区缓存：先用首屏结果渲染，网络请求在后台校验。
      useEffect(function () {
        if (categoryWorkspaceId === '') return
        var cached = historyCacheGet(categoryWorkspaceId)
        if (cached === null || cached.firstPage === null) return
        if (result.status !== 'idle') return
        setResult(cached.firstPage)
      }, [categoryWorkspaceId])

      useEffect(function () {
        setPage(0)
        setCategoryId('')
        setCategoryData(null)
        setResult(HISTORY_IDLE_RESULT)
        setSelected(-1)
        setActiveRowKey('')
        setWorkspaceLabel('')
        workspaceLabelRef.current = ''
      }, [boundSessionId])

      // 分类被删除 / 改名后，当前选中的 id 失效就回到「全部」。
      useEffect(function () {
        if (categoryId === '' || categoryId === '__none__') return
        if (categoryData === null || categoryData === undefined || categoryData.store === null) return
        // store 尚未就绪时绝不重置：loading/error 阶段清空分类会让“点了分类却没进浏览态”。
        if (categoryData.status !== undefined && categoryData.status !== 'ready') return
        if (!Array.isArray(categoryData.store.categories)) return
        if (categoryNameOf(categoryData.store, categoryId) === '') {
          setPage(0)
          setCategoryId('')
        }
      }, [categoryData, categoryId])

      /** 分类树点击：清掉输入里的 `分类:` 前缀（保留关键词），立即检索。 */
      function chooseHistoryCategory(nextCategoryId) {
        setCategoryId(nextCategoryId === null || nextCategoryId === undefined ? '' : String(nextCategoryId))
        setPage(0)
        setSelected(-1)
        setActiveRowKey('')
        var options = historyCategoryOptions()
        var parsed = parseCategoryPrefix(query, options)
        if (parsed.active) setQuery(parsed.keywords)
        immediateSearchRef.current = true
        setSearchNonce(function (value) { return value + 1 })
      }

      // 只有输入以「分类:」开头时，分类数据加载完成才需要重跑检索计划；
      // 否则分类树刷新不应打断正在进行的关键词检索。
      var categoryWorkspaceId = categoryData !== null && categoryData !== undefined
        && typeof categoryData.workspaceId === 'string' ? categoryData.workspaceId : ''
      var prefixDataDependency = /^\s*分类\s*[:：]/.test(String(query === null || query === undefined ? '' : query))
        ? categoryData
        : null

      /** 输入即搜：400ms 防抖；回车 / 清空 / 分类点击立即。 */
      useEffect(function () {
        var plan = currentHistoryPlan()
        var boundKey = boundSessionId === null || boundSessionId === undefined ? '' : String(boundSessionId)
        if (searchBoundRef.current !== boundKey) {
          // 切会话先作废旧请求，等 categoryId 重置后的下一帧再发。
          searchBoundRef.current = boundKey
          cancelHistorySearch()
          immediateSearchRef.current = false
          return undefined
        }
        // 等 /categories 给出 workspaceId 再检索：分类 id 必须和同一工作区一起用。
        if (categoryWorkspaceId === '') {
          cancelHistorySearch()
          immediateSearchRef.current = false
          return undefined
        }
        if (plan.paused) {
          if (timerRef.current !== 0) {
            clearTimeout(timerRef.current)
            timerRef.current = 0
          }
          cancelHistorySearch()
          immediateSearchRef.current = false
          return undefined
        }
        if (plan.keywords === '') {
          // 「全部」/分类浏览不防抖，进入或切页就发请求。
          immediateSearchRef.current = false
          startHistorySearch(plan)
          return function () { cancelHistorySearch() }
        }
        var delay = immediateSearchRef.current ? 0 : HISTORY_DEBOUNCE_MS
        immediateSearchRef.current = false
        timerRef.current = setTimeout(function () {
          timerRef.current = 0
          startHistorySearch(plan)
        }, delay)
        return function () {
          if (timerRef.current !== 0) {
            clearTimeout(timerRef.current)
            timerRef.current = 0
          }
          cancelHistorySearch()
        }
      }, [query, categoryId, prefixDataDependency, categoryWorkspaceId, boundSessionId, searchNonce, page, pageSize])

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

      // 跨会话定位后：等新工作区数据 ready，再恢复选中行与滚动位置。
      useEffect(function () {
        var pending = HISTORY_JUMP_RESTORE
        if (pending === null || pending === undefined) return
        if (String(pending.targetSession || '') !== String(boundSessionId || '')) return
        if (result.status !== 'ready') return
        var index = -1
        for (var i = 0; i < rows.length; i += 1) {
          if (historyRowKey(rows[i].hit) === pending.selectedKey) { index = i; break }
        }
        setSelected(index)
        setActiveRowKey(pending.selectedKey || '')
        var top = Number(pending.scrollTop) || 0
        historyRestoreScroll(top)
        HISTORY_JUMP_RESTORE = null
      }, [result.status, rows, boundSessionId])

      useEffect(function () {
        if (typeof document === 'undefined' || document === null
          || typeof document.addEventListener !== 'function') return undefined
        function onPointerDown(event) {
          var target = event === null || event === undefined ? null : event.target
          if (target !== null && target !== undefined && typeof target.closest === 'function'
            && target.closest('.dsh_tm_histrowwrap') !== null) return
          clearHistorySelection()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return function () { document.removeEventListener('pointerdown', onPointerDown, true) }
      }, [])

      // 行获得焦点或按 Esc：选中态在文档级也能取消（不碰搜索词）。
      useEffect(function () {
        if (typeof document === 'undefined' || document === null
          || typeof document.addEventListener !== 'function') return undefined
        function onKeyDown(event) {
          if (event === null || event === undefined || event.key !== 'Escape') return
          if (selectionRef.current.key !== '' || selectionRef.current.index >= 0) {
            event.preventDefault()
            clearHistorySelection()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return function () { document.removeEventListener('keydown', onKeyDown, true) }
      }, [])

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
        var entry = rows[index]
        selectionRef.current = { key: entry !== undefined ? historyRowKey(entry.hit) : '', index: index }
        setSelected(index)
        setActiveRowKey(entry !== undefined ? historyRowKey(entry.hit) : '')
        setMenuOpen(false)
        setDetail(null)
      }

      function clearHistorySelection() {
        selectionRef.current = { key: '', index: -1 }
        setSelected(-1)
        setActiveRowKey('')
        setMenuOpen(false)
        setDetail(null)
      }

      function historyRestoreScroll(top) {
        function apply() {
          var body = listRef.current
          if (body !== null && body !== undefined) body.scrollTop = top
        }
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply)
        else setTimeout(apply, 0)
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

      /**
       * 打开该轮的回滚预演（只读）。
       *
       * 只发 /rollback-plan，不做任何生成、确认或写盘动作；失败原因保留在
       * 浮窗里，用户能看清是端点未就绪还是索引缺失。
       */
      function previewHistoryRollback(entry) {
        var hit = entry.hit
        var key = historyRowKey(hit)
        var body = rollbackPlanRequest(hit.sessionId, hit.turn)
        if (body === null) {
          showHistoryNotice('回滚预演失败：缺少会话或轮次信息', 'error')
          return
        }
        var token = rollbackSeqRef.current + 1
        rollbackSeqRef.current = token
        setRollback({ key: key, status: 'loading', value: null, error: '' })
        loadRollbackPlan(hit.sessionId, hit.turn).then(function (result) {
          if (token !== rollbackSeqRef.current) return
          if (result !== null && result !== undefined && result.ok === true) {
            setRollback({ key: key, status: 'ready', value: result.value, error: '' })
            return
          }
          var reason = result === null || result === undefined ? '没有响应' : result.error
          setRollback({ key: key, status: 'error', value: null, error: reason })
        }, function (error) {
          if (token !== rollbackSeqRef.current) return
          setRollback({ key: key, status: 'error', value: null, error: errorText(error) })
        })
      }

      /** 关掉预演浮窗，并作废在途请求。 */
      function closeHistoryRollback() {
        rollbackSeqRef.current += 1
        setRollback(null)
      }

      /** 定位到某轮；失败原因必须可见。 */
      function locateHistoryEntry(entry) {
        var hit = entry.hit
        var turnLabel = Number.isFinite(Number(hit.turn)) ? ('第 ' + Number(hit.turn) + ' 轮') : '该轮'
        var sameSession = String(hit.sessionId === null || hit.sessionId === undefined ? '' : hit.sessionId)
          === String(boundSessionId === null || boundSessionId === undefined ? '' : boundSessionId)
        var savedKey = activeRowKey
        if (savedKey === '' && selected >= 0 && rows[selected] !== undefined) {
          savedKey = historyRowKey(rows[selected].hit)
        }
        var savedScroll = listRef.current !== null && listRef.current !== undefined
          ? Number(listRef.current.scrollTop) || 0 : 0
        if (!sameSession) {
          HISTORY_JUMP_RESTORE = {
            targetSession: hit.sessionId,
            selectedKey: savedKey,
            scrollTop: savedScroll,
            at: Date.now(),
          }
        }
        showHistoryNotice('正在定位' + turnLabel + '…', 'info')
        locateHistoryTurn(hit.sessionId, hit.turn, hit.seq, boundSessionId).then(function (result) {
          if (result.ok) {
            showHistoryNotice('已定位到' + turnLabel, 'ok')
            return
          }
          if (!sameSession) HISTORY_JUMP_RESTORE = null
          var reason = result.reason || '未知原因'
          historyDiag('定位失败：' + reason)
          showHistoryNotice('定位失败：' + reason, 'error')
        }, function (error) {
          if (!sameSession) HISTORY_JUMP_RESTORE = null
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
       * 两种输入框统一纯文本；execCommand 后异步轮询（30ms/400ms），
       * DOM 兜底再轮询 200ms；期间不提示。仍失败则复制并明说。
       */
      function quoteHistoryEntry(entry) {
        var text = historyCitePointer(entry)
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
        var pending
        try {
          pending = historyWriteToComposer(text)
        } catch (error) {
          pending = Promise.resolve({ ok: false, reason: 'rejected' })
        }
        Promise.resolve(pending).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            historyDiag('引用插入成功：' + (result.method === 'exec' ? 'execCommand' : 'DOM 兜底'))
            showHistoryNotice('已插入引用【' + text + '】', 'ok')
            return
          }
          fallbackCopy(result !== null && result !== undefined && result.reason === 'rejected')
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
          var down = Number.isFinite(selected) ? selected + 1 : 0
          if (down > count - 1) down = count - 1
          if (count > 0) {
            setSelected(down)
            setActiveRowKey(rows[down] !== undefined ? historyRowKey(rows[down].hit) : '')
          }
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          var up = Number.isFinite(selected) ? selected - 1 : 0
          if (up < 0) up = 0
          if (count > 0) {
            setSelected(up)
            setActiveRowKey(rows[up] !== undefined ? historyRowKey(rows[up].hit) : '')
          }
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          immediateSearchRef.current = true
          setSearchNonce(function (value) { return value + 1 })
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          if (activeRowKey !== '' || selected >= 0) {
            clearHistorySelection()
            return
          }
          immediateSearchRef.current = true
          setPage(0)
          setQuery('')
          setSelected(-1)
          setActiveRowKey('')
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

      /** 选中行的动作区：元信息行 + 主/次/治理三层动作 + ⋯ 菜单。 */
      function renderHistoryActions(entry) {
        var hit = entry.hit
        var row = entry.row
        var key = historyRowKey(hit)
        var detailOpen = detail !== null && detail !== undefined && detail.key === key
        var commandCount = commandCountOf(entry)
        var noCommands = commandCount !== null && commandCount === 0

        var turnNo = Number(hit.turn)
        var turnLabel = Number.isFinite(turnNo)
          ? '第' + turnNo + '轮'
          : (typeof row.turnLabel === 'string' ? row.turnLabel : '')
        var timeLabel = typeof row.timeLabel === 'string' ? row.timeLabel : ''
        var statusLabel = typeof row.statusLabel === 'string' ? row.statusLabel : ''
        var statusTone = hit.endReason === 'error' || statusLabel.indexOf('失败') >= 0 ? 'error' : ''

        var meta = []
        if (turnLabel !== '') meta.push(h('span', { key: 'turn', className: 'dsh_tm_histmetaturn' }, turnLabel))
        if (timeLabel !== '') meta.push(h('span', { key: 'time' }, (meta.length > 0 ? ' · ' : '') + timeLabel))
        if (statusLabel !== '') {
          meta.push(h('span', {
            key: 'status',
            className: statusTone === 'error' ? 'dsh_tm_histmetastatus dsh_tm_histmetastatus_err' : 'dsh_tm_histmetastatus',
          }, (meta.length > 0 ? ' · ' : '') + statusLabel))
        }

        var actionRow = [
          {
            key: 'locate',
            className: 'dsh_tm_histbtn dsh_tm_histbtn_primary',
            title: turnLabel === '' ? '定位到该轮' : '定位到' + turnLabel,
            ariaLabel: turnLabel === '' ? '定位到该轮' : '定位到' + turnLabel,
            icon: '⌖',
            label: '定位',
            onClick: function (event) { event.stopPropagation(); locateHistoryEntry(entry) },
          },
          {
            key: 'detail',
            className: detailOpen
              ? 'dsh_tm_histbtn dsh_tm_histbtn_outline dsh_tm_histbtn_on'
              : 'dsh_tm_histbtn dsh_tm_histbtn_outline',
            title: detailOpen ? '收起该轮详情' : '查看该轮详情',
            ariaLabel: detailOpen ? '收起该轮详情' : '查看该轮详情',
            icon: 'ⓘ',
            label: '详情',
            attrs: { 'aria-expanded': detailOpen ? 'true' : 'false' },
            onClick: function (event) { event.stopPropagation(); toggleHistoryDetail(entry) },
          },
          {
            key: 'quote',
            className: 'dsh_tm_histbtn dsh_tm_histbtn_outline',
            title: '插入轮次引用【…】',
            ariaLabel: '插入轮次引用',
            icon: '❝',
            label: '引用',
            onClick: function (event) { event.stopPropagation(); quoteHistoryEntry(entry) },
          },
          {
            key: 'menu',
            className: 'dsh_tm_histbtn dsh_tm_histbtn_icon',
            title: '更多动作',
            ariaLabel: '更多动作',
            icon: '⋯',
            label: '',
            attrs: { 'aria-expanded': menuOpen ? 'true' : 'false' },
            onClick: function (event) { event.stopPropagation(); setMenuOpen(!menuOpen) },
          },
        ]

        var menuNode = null
        if (menuOpen === true) {
          var statuses = historyLabelStatuses(currentHistoryLabel(entry))
          function menuItem(keyName, icon, label, onClick, disabled, title) {
            var className = 'dsh_tm_histmenuitem' + (disabled === true ? ' dsh_tm_histmenuitem_disabled' : '')
            return h('button', {
              key: keyName, type: 'button', className: className,
              role: 'menuitem', disabled: disabled === true, title: title,
              'data-action': keyName,
              onClick: function (event) { event.stopPropagation(); if (onClick) onClick() },
            },
              h('span', { className: 'dsh_tm_histmenuicon', 'aria-hidden': 'true' }, icon),
              h('span', { className: 'dsh_tm_histmenutext' }, label))
          }
          var labelButtons = []
          for (var i = 0; i < HISTORY_LABEL_KEYS.length; i += 1) {
            ;(function (status) {
              var on = statuses.indexOf(status) >= 0
              labelButtons.push(h('button', {
                key: 'label-' + status,
                type: 'button',
                className: on ? 'dsh_tm_histmenuitem dsh_tm_histmenugroupbtn dsh_tm_histmenuitem_on' : 'dsh_tm_histmenuitem dsh_tm_histmenugroupbtn',
                role: 'menuitemcheckbox', 'aria-checked': on ? 'true' : 'false',
                title: on ? '取消' + HISTORY_LABEL_TEXT[status] : '标记为' + HISTORY_LABEL_TEXT[status],
                onClick: function (event) { event.stopPropagation(); toggleHistoryLabel(entry, status) },
              },
                h('span', { className: 'dsh_tm_histmenuicon', 'aria-hidden': 'true' }, on ? '✓' : '○'),
                h('span', { className: 'dsh_tm_histmenutext' }, HISTORY_LABEL_TEXT[status])))
            })(HISTORY_LABEL_KEYS[i])
          }
          menuNode = h('div', { key: 'menu', className: 'dsh_tm_histmenu', role: 'menu' },
            menuItem('copy-commands', '⧉', '复制命令块',
              function () { openCommandModal(entry) },
              noCommands,
              noCommands ? '该轮没有命令块' : '查看并复制该轮命令块'),
            menuItem('copy-conclusion', '❝', '复制结论',
              function () { openConclusionModal(entry) },
              false,
              '复制该轮结论全文'),
            menuItem('promote-work', '★', '转为事',
              function () { promoteHistoryEntryToWork(entry) },
              actionBusy !== '',
              '把这条对话升级为工作「事」并加入续接首页'),
            menuItem('override-category', '🏷', '归错了…',
              function () { openOverride(entry) },
              false,
              '人工指定该会话的分类，之后模型不再覆盖'),
            h('div', { key: 'sep-manage', className: 'dsh_tm_histmenusep', role: 'separator' }),
            h('div', { key: 'manage-group', className: 'dsh_tm_histmenugroup', role: 'group', 'aria-label': '历史管理' },
              h('div', { className: 'dsh_tm_histmenugrouplabel' },
                h('span', { className: 'dsh_tm_histmenuicon', 'aria-hidden': 'true' }, '⑂'),
                h('span', null, '历史管理')),
              menuItem('fork-turn', '⑂', '分叉',
                function () { requestHistoryAction('fork', entry) },
                actionBusy !== '',
                '从第 ' + String(entry.hit.turn) + ' 轮之前分叉'),
              menuItem('retry-turn', '↻', '重试',
                function () { requestHistoryAction('retry', entry) },
                actionBusy !== '',
                '分叉并重新提交该轮提问'),
              menuItem('brief-turn', '▤', '生成简报',
                function () { requestHistoryAction('brief', entry) },
                actionBusy !== '',
                '把这一轮整理成 Markdown 简报')),
            h('div', { key: 'sep', className: 'dsh_tm_histmenusep', role: 'separator' }),
            h('div', { key: 'mark-group', className: 'dsh_tm_histmenugroup', role: 'group', 'aria-label': '标记' },
              h('div', { className: 'dsh_tm_histmenugrouplabel' },
                h('span', { className: 'dsh_tm_histmenuicon', 'aria-hidden': 'true' }, '⚑'),
                h('span', null, '标记')),
              labelButtons))
        }

        return h('div', { className: 'dsh_tm_histactions' },
          h('div', { className: 'dsh_tm_histmeta' }, meta),
          h(HistoryActionBar, { actions: actionRow, actionKey: key }),
          menuNode)
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
        // 旧形状（只有 turn.files）仍然保留；有 turn.changes 时统一走
        // changes-view 的分组 / lost 文案，避免两套口径。
        var legacyFiles = Array.isArray(turn.files) ? turn.files : []
        var neighbors = Array.isArray(value.neighbors) ? value.neighbors : []
        var labelValue = value.label !== undefined && value.label !== null
          ? value.label
          : currentHistoryLabel(entry)
        var statuses = historyLabelStatuses(labelValue)

        var sections = [
          h('div', { className: 'dsh_tm_histdsec', key: 'prompt' },
            h('b', null, '提问', isCurrentEntry(entry)
              ? h('span', { className: 'dsh_tm_histdcurrent' }, '当前轮')
              : null),
            h('div', { className: 'dsh_tm_histdtext' }, promptText === '' ? '—' : promptText)),
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
        var changeNode = changeSectionNode(h, turn, function () { previewHistoryRollback(entry) })
        if (changeNode !== null) {
          sections.push(changeNode)
        } else if (legacyFiles.length > 0) {
          sections.push(h('div', { className: 'dsh_tm_histdsec', key: 'files' },
            h('b', null, '文件变更'),
            h('ul', { className: 'dsh_tm_histdfiles' }, legacyFiles.map(function (file, index) {
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
        var isActive = activeRowKey !== '' && activeRowKey === historyRowKey(hit)
        var isCurrent = isCurrentEntry(entry)
        var commandCount = commandCountOf(entry)
        return h('div', {
          key: historyRowKey(hit),
          className: isSelected ? 'dsh_tm_histrowwrap dsh_tm_histrowwrap_on' : 'dsh_tm_histrowwrap',
        },
          h('button', {
            type: 'button',
            className: 'dsh_tm_histrow'
              + (isSelected ? ' dsh_tm_histrow_on' : '')
              + (isActive ? ' dsh_tm_histrow_selected' : ''),
            'data-hist-index': index,
            'data-selected': isActive ? '1' : undefined,
            'data-current': isCurrent ? '1' : undefined,
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
              h('span', { className: 'dsh_tm_histname', title: row.title }, row.title),
              sessionLocked(hit)
                ? h('span', { className: 'dsh_tm_histlock', title: '已人工指定，模型不会覆盖', 'aria-label': '已人工指定' }, '🔒')
                : null,
              row.turnLabel === '' ? null : h('span', { className: 'dsh_tm_histturn' }, row.turnLabel),
              commandCount !== null && commandCount > 0
                ? h('span', { className: 'dsh_tm_histcmd', title: '该轮包含 ' + commandCount + ' 个代码块' }, '代码块 ' + commandCount)
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

      /** 时间线模式下点一条：复用历史定位轮询。 */
      function jumpHistoryClue(item) {
        var turn = Number(item.turn)
        if (item.sessionId === '' || item.sessionId === null || item.sessionId === undefined) {
          showHistoryNotice('缺少会话信息，无法跳转', 'error')
          return
        }
        if (!Number.isFinite(turn)) {
          showHistoryNotice('缺少轮次信息，无法跳转', 'error')
          return
        }
        showHistoryNotice('正在定位第 ' + turn + ' 轮…', 'info')
        locateHistoryTurn(item.sessionId, turn, null, boundSessionId).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            showHistoryNotice('已定位到第 ' + turn + ' 轮', 'ok')
            return
          }
          var reason = result !== null && result !== undefined && typeof result.reason === 'string'
            ? result.reason
            : '未知原因'
          showHistoryNotice('定位失败：' + reason, 'error')
        }, function (error) {
          showHistoryNotice('定位失败：' + errorText(error), 'error')
        })
      }

      /** 分类浏览态（无关键词）用 /sessions + 分类树显示会话列表。 */
      function categoryBrowseRows() {
        if (historyPlan.keywords !== '') return []
        if (categoryData === null || categoryData === undefined) return []
        if (historyPlan.categoryId === '') {
          return categorySessionRows(categoryData.store, categoryData.sessions, null, Date.now())
        }
        if (categoryData.store === null || categoryData.store === undefined) return []
        if (historyPlan.categoryId === '__none__') {
          return categorySessionRows(categoryData.store, categoryData.sessions, CATEGORY_ROOT_ID, Date.now())
        }
        var subtreeIds = categorySubtreeIds(categoryData.store, historyPlan.categoryId)
        return categorySessionRows(categoryData.store, categoryData.sessions, Object.keys(subtreeIds), Date.now())
      }

      function openHistoryCategorySession(row) {
        var opened = openWorkspaceSession(row.sessionId)
        if (opened !== null && opened !== undefined && opened.ok === true) {
          showHistoryNotice('已打开会话：' + row.title, 'ok')
          var latest = Number(row.turns)
          if (Number.isFinite(latest) && latest > 0) {
            locateHistoryTurn(row.sessionId, latest, null, boundSessionId).then(function (result) {
              if (result === null || result === undefined || result.ok !== true) {
                var why = result !== null && result !== undefined && typeof result.reason === 'string'
                  ? result.reason : '未知原因'
                showHistoryNotice('定位最近轮次失败：' + why, 'error')
              }
            }, function (error) {
              showHistoryNotice('定位最近轮次失败：' + errorText(error), 'error')
            })
          }
          return
        }
        var reason = opened !== null && opened !== undefined && typeof opened.reason === 'string'
          ? opened.reason
          : '未知原因'
        showHistoryNotice('打开会话失败：' + reason, 'error')
      }

      function renderCategoryBrowseRow(row, index) {
        return h('button', {
          key: 'cat-session-' + index,
          type: 'button',
          className: 'dsh_tm_histcatsession',
          'data-session-id': row.sessionId,
          title: row.title,
          onClick: function () { openHistoryCategorySession(row) },
        },
          h('span', { className: 'dsh_tm_histcatsessiontitle' }, row.title),
          lockedSessionById(row.sessionId)
            ? h('span', { className: 'dsh_tm_histlock', title: '已人工指定，模型不会覆盖', 'aria-label': '已人工指定' }, '🔒')
            : null,
          h('span', { className: 'dsh_tm_histcatsessionmeta' }, row.meta))
      }

      function lockedSessionById(sessionId) {
        var key = sessionId === null || sessionId === undefined ? '' : String(sessionId)
        if (key === '') return false
        if (lockedSessions[key] === true) return true
        if (categoryData === null || categoryData === undefined) return false
        return categorySessionLockedBy(categoryData.store, categoryData.lockedSessions, key)
      }

      function sessionLocked(hit) {
        if (hit === null || hit === undefined) return false
        return lockedSessionById(hit.sessionId)
      }

      function overrideOptions() {
        if (categoryData === null || categoryData === undefined) return []
        return categoryCapsuleModel(categoryData.store, categoryData.sessions).options
      }

      /** 唯一的分类写操作：人工指定分类，Host 之后不再让模型覆盖。 */
      function openOverride(entry) {
        if (entry === null || entry === undefined || entry.hit === null || entry.hit === undefined) return
        var hit = entry.hit
        if (hit.sessionId === null || hit.sessionId === undefined || String(hit.sessionId) === '') return
        setMenuOpen(false)
        setOverride({ sessionId: String(hit.sessionId), title: String(hit.title || hit.sessionId), busy: false, error: '' })
      }

      function submitOverride(categoryId) {
        if (override === null || override === undefined || override.busy === true) return
        var sessionId = override.sessionId
        var workspaceId = categoryData !== null && categoryData !== undefined && categoryData.workspaceId
          ? String(categoryData.workspaceId) : ''
        var name = categoryId === null || categoryId === undefined
          ? CATEGORY_ROOT_NAME
          : (categoryNameOf(categoryData === null || categoryData === undefined ? null : categoryData.store, categoryId) || CATEGORY_ROOT_NAME)
        setOverride(function (prev) {
          return prev === null ? prev : { sessionId: prev.sessionId, title: prev.title, busy: true, error: '' }
        })
        requestTopicMap('category-override', categoryOverrideBody(workspaceId, sessionId, categoryId)).then(function (result) {
          if (result === null || result === undefined || result.ok !== true) {
            var reason = result === null || result === undefined ? '没有响应' : (result.error || '未知原因')
            setOverride(function (prev) {
              return prev === null ? prev : { sessionId: prev.sessionId, title: prev.title, busy: false, error: String(reason) }
            })
            return
          }
          setOverride(null)
          setLockedSessions(function (prev) {
            var next = {}
            for (var key in prev) next[key] = prev[key]
            next[String(sessionId)] = true
            return next
          })
          setCategoryRefresh(function (value) { return value + 1 })
          setSearchNonce(function (value) { return value + 1 })
          showHistoryNotice('已改为「' + name + '」，模型不会再动这个会话', 'ok')
        }, function (error) {
          setOverride(function (prev) {
            return prev === null ? prev : { sessionId: prev.sessionId, title: prev.title, busy: false, error: errorText(error) }
          })
        })
      }

      function renderOverrideDialog() {
        if (override === null || override === undefined) return null
        var options = overrideOptions()
        var optionNodes = [h('button', {
          key: 'override-root',
          type: 'button',
          className: 'dsh_tm_catpick',
          'data-cat-id': CATEGORY_ROOT_ID,
          disabled: override.busy === true,
          onClick: function () { submitOverride(null) },
        }, h('span', { className: 'dsh_tm_catpickname' }, CATEGORY_ROOT_NAME))]
        for (var i = 0; i < options.length; i += 1) {
          ;(function (option) {
            optionNodes.push(h('button', {
              key: 'override-' + option.id,
              type: 'button',
              className: 'dsh_tm_catpick',
              'data-cat-id': option.id,
              title: option.path,
              disabled: override.busy === true,
              onClick: function () { submitOverride(option.id) },
            },
              h('span', { className: 'dsh_tm_catpickname' }, option.path),
              h('span', { className: 'dsh_tm_catpickcount' }, String(option.count))))
          })(options[i])
        }
        return h('div', {
          className: 'dsh_tm_histmodal',
          role: 'presentation',
          onClick: function () { if (override.busy !== true) setOverride(null) },
        },
          h('div', {
            className: 'dsh_tm_histdialog dsh_tm_catdialog',
            role: 'dialog',
            'aria-modal': 'true',
            onClick: function (event) {
              if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
            },
          },
            h('div', { className: 'dsh_tm_histdialoghead' },
              h('div', { className: 'dsh_tm_histdialogtitle' }, '归错了… · ' + override.title),
              h('button', {
                type: 'button', className: 'dsh_tm_histdialogclose', title: '关闭', 'aria-label': '关闭',
                disabled: override.busy === true,
                onClick: function () { if (override.busy !== true) setOverride(null) },
              }, '✕')),
            h('div', { className: 'dsh_tm_catdialogbody' },
              h('div', { className: 'dsh_tm_catdialoglabel' }, '选择已有分类（不能新建）'),
              override.error === ''
                ? null
                : h('div', { className: 'dsh_tm_caterr', role: 'alert' }, override.error),
              h('div', { className: 'dsh_tm_catpicklist' }, optionNodes)),
            h('div', { className: 'dsh_tm_catdialogfoot' },
              h('button', {
                type: 'button', className: 'dsh_tm_histact', 'data-action': 'dialog-cancel',
                disabled: override.busy === true,
                onClick: function () { if (override.busy !== true) setOverride(null) },
              }, '取消'))))
      }

      // ── 正文 ────────────────────────────────────────────────────
      var resultTotal = Number(result.total)
      var pageTotal = Number.isFinite(resultTotal) ? resultTotal : 0
      var pageCount = historyPageCount(pageTotal, pageSize)

      useEffect(function () {
        if (page >= pageCount) setPage(Math.max(0, pageCount - 1))
      }, [page, pageCount])

      var bodyChildren = []
      var branch = 'idle'
      var renderCache = categoryWorkspaceId === '' ? null : historyCacheGet(categoryWorkspaceId)
      var hasCachedPage = renderCache !== null && renderCache.firstPage !== null
      var showSkeleton = (result.status === 'idle' || (result.status === 'loading' && rows.length === 0))
        && hasCachedPage !== true
      if (showSkeleton) {
        branch = 'idle'
        for (var sk = 0; sk < 6; sk += 1) {
          bodyChildren.push(h('div', { className: 'dsh_tm_histskel', key: 'skel-' + sk, 'aria-hidden': 'true' }))
        }
      } else if (historyIdleGuide(result, historyPlan)) {
        branch = 'idle'
        bodyChildren.push(h('div', { className: 'dsh_tm_history_empty', key: 'idle' },
          h('div', null, HISTORY_IDLE_TEXT),
          h('div', { className: 'dsh_tm_histidle-sub' }, '输入即搜；回车立即检索；清空输入回到所有会话'),
        ))
      } else if (result.status === 'error') {
        branch = 'empty'
        bodyChildren.push(h('div', { className: 'dsh_tm_histerr', key: 'error' },
          h('div', null, '检索失败：' + result.error),
          h('button', {
            type: 'button', className: 'dsh_tm_histretry', 'data-action': 'history-retry',
            onClick: function () { startHistorySearch(historyPlan) },
          }, '重试')))
      } else if (HISTORY_TIMELINE_ENABLED && viewMode === HISTORY_TIMELINE_VIEW) {
        if (result.status === 'loading' && result.hits.length === 0) {
          branch = 'idle'
          bodyChildren.push(h('div', { className: 'dsh_tm_history_empty', key: 'loading' }, '检索中…'))
        } else if (result.status === 'ready' || result.hits.length > 0) {
          branch = 'timeline'
          bodyChildren.push(h(HistoryClueTimeline, {
            key: 'timeline',
            hits: result.hits,
            keywords: historyPlan.keywords,
            onJump: jumpHistoryClue,
          }))
        } else if (result.status === 'loading') {
          branch = 'idle'
          bodyChildren.push(h('div', { className: 'dsh_tm_history_empty', key: 'loading2' }, '检索中…'))
        } else {
          branch = 'empty'
        }
      } else if (rows.length > 0) {
        branch = 'rows'
        if (result.status === 'loading') {
          bodyChildren.push(h('div', { className: 'dsh_tm_histnote', key: 'busy' }, '检索中…'))
        }
        bodyChildren.push(h('div', { className: 'dsh_tm_histlist', key: 'list' }, rows.map(renderRow)))
      } else if (result.status === 'loading') {
        branch = 'idle'
        bodyChildren.push(h('div', { className: 'dsh_tm_history_empty', key: 'loading' }, '检索中…'))
      } else if (result.status === 'ready') {
        branch = 'empty'
        bodyChildren.push(h('div', { className: 'dsh_tm_history_empty', key: 'empty' },
          historyEmptyText(result, historyPlan.categoryId)))
      }

      var diagStore = categoryData !== null && categoryData !== undefined && categoryData.store !== null
        && categoryData.store !== undefined ? categoryData.store : null
      var diagCategories = diagStore === null ? [] : categoryStoreOf(diagStore).categories
      recordHistoryDiagnostics({
        plan: {
          keywords: String(historyPlan.keywords === null || historyPlan.keywords === undefined ? '' : historyPlan.keywords),
          categoryId: String(historyPlan.categoryId === null || historyPlan.categoryId === undefined ? '' : historyPlan.categoryId),
          idle: historyPlan.idle === true,
        },
        result: {
          status: String(result.status === null || result.status === undefined ? 'idle' : result.status),
          hits: Array.isArray(result.hits) ? result.hits.length : 0,
          total: Number.isFinite(Number(result.total)) ? Number(result.total) : 0,
          recent: false,
          hasMore: result.hasMore === true,
        },
        categoryData: {
          hasStore: diagStore !== null,
          categories: diagCategories.length,
          sessions: Array.isArray(categoryData === null || categoryData === undefined ? null : categoryData.sessions)
            ? categoryData.sessions.length : 0,
        },
        browse: {
          rows: 0,
          page: page,
          pageCount: pageCount,
          total: 0,
        },
        branch: branch,
      })

      // 底部状态条：结果摘要 + 分页 + 补齐索引。
      var footLines = []
      var scannedFromLog = result.coverage !== null && typeof result.coverage === 'object'
        ? Number(result.coverage.scannedFromLog) : NaN
      if (Number.isFinite(scannedFromLog) && scannedFromLog > 0) {
        footLines.push(h('div', { className: 'dsh_tm_histcoverage', key: 'coverage' },
          '正在为 ' + scannedFromLog + ' 个会话建立索引，本次检索已直接读取日志（稍慢）'))
      }
      var footerSummary = '共 ' + pageTotal + ' 条 · ' + (historyPlan.keywords === '' ? '时间' : '相关度')
      var prevDisabled = page <= 0
      var nextDisabled = page >= pageCount - 1
        || (result.status === 'ready' && result.hasMore === false)
      var pager = h('div', { className: 'dsh_tm_histpager', role: 'group', 'aria-label': '分页' },
        h('button', {
          type: 'button', className: 'dsh_tm_histpagebtn', 'data-action': 'page-prev',
          disabled: prevDisabled,
          onClick: function () {
            if (page > 0) {
              immediateSearchRef.current = true
              setSelected(-1)
              setActiveRowKey('')
              setPage(page - 1)
            }
          },
        }, '上一页'),
        h('span', { className: 'dsh_tm_histpagenum' }, '第 ' + (page + 1) + ' / ' + pageCount + ' 页'),
        h('button', {
          type: 'button', className: 'dsh_tm_histpagebtn', 'data-action': 'page-next',
          disabled: nextDisabled,
          onClick: function () {
            if (page < pageCount - 1) {
              immediateSearchRef.current = true
              setSelected(-1)
              setActiveRowKey('')
              setPage(page + 1)
            }
          },
        }, '下一页'))

      var prefixInfo = historyPlan.prefix
      var prefixVisible = prefixInfo.active
        && (prefixInfo.candidates.length > 1 || prefixInfo.candidates.length === 0)
      var prefixNodes = null
      if (prefixVisible) {
        if (prefixInfo.candidates.length === 0) {
          prefixNodes = h('div', { className: 'dsh_tm_histprefixempty' }, '没有匹配的分类：' + prefixInfo.name)
        } else {
          prefixNodes = h('div', { className: 'dsh_tm_histprefixlist', role: 'listbox', 'aria-label': '匹配的分类' },
            prefixInfo.candidates.slice(0, 8).map(function (option) {
              return h('button', {
                key: 'prefix-' + option.id,
                type: 'button',
                className: 'dsh_tm_histprefixitem',
                'data-cat-id': option.id,
                onClick: function () {
                  setPage(0)
                  setCategoryId(option.id)
                  setQuery(prefixInfo.keywords)
                  immediateSearchRef.current = true
                  setSearchNonce(function (value) { return value + 1 })
                },
              },
                h('span', { className: 'dsh_tm_histprefixname' }, option.name),
                h('span', { className: 'dsh_tm_histprefixpath', title: option.path }, option.path))
            }))
        }
      }

      var historyWorkspaceName = workspaceLabel !== ''
        ? workspaceLabel
        : workspaceDisplayName(result.workspace)
      var historyTitleText = historyWorkspaceName === ''
        ? HISTORY_TITLE
        : HISTORY_TITLE + ' · ' + historyWorkspaceName

      return h('div', { className: 'dsh_tm_history' },
        props !== null && props !== undefined && props.hideTabStrip === true ? null : h(RightTabStrip, {
          active: HISTORY_KIND,
          open: props === null || props === undefined ? undefined : props.openTab,
        }),
        h('div', { className: 'dsh_tm_histhead' },
          h('div', { className: 'dsh_tm_histtitle', title: historyTitleText },
            h('span', { className: 'dsh_tm_histtitlemain' }, HISTORY_TITLE),
            historyWorkspaceName === ''
              ? null
              : h('span', { className: 'dsh_tm_histtitlews' }, ' · ' + historyWorkspaceName)),
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
        ),
        h(CategoriesTabBody, {
          embedded: true,
          sessionId: boundSessionId,
          selectedCategory: historyPlan.categoryId,
          refreshToken: categoryRefresh,
          onSelect: chooseHistoryCategory,
          onData: setCategoryData,
        }),
        h('div', { className: 'dsh_tm_histmain' },
          h('section', { className: 'dsh_tm_histpane' },
            h('div', { className: 'dsh_tm_histbar' },
              h('div', { className: 'dsh_tm_histsearchwrap' },
                h('div', { className: 'dsh_tm_histsearch' },
                  h('span', { className: 'dsh_tm_histsearchicon', 'aria-hidden': 'true' }, '🔍'),
                  h('input', {
                    type: 'search',
                    className: 'dsh_tm_history_search',
                    placeholder: '输入即搜，或 分类:名称 关键词',
                    'aria-label': '搜索历史对话',
                    value: query,
                    onChange: function (event) {
                      var next = ''
                      if (event !== null && event !== undefined && event.target !== null && event.target !== undefined) {
                        next = event.target.value === null || event.target.value === undefined ? '' : String(event.target.value)
                      }
                      if (next.trim() === '') immediateSearchRef.current = true
                      setPage(0)
                      setSelected(-1)
                      setActiveRowKey('')
                      setQuery(next)
                    },
                    onKeyDown: handleSearchKeyDown,
                  }),
                  result.status === 'loading'
                    ? h('span', { className: 'dsh_tm_histspin', role: 'status', 'aria-label': '检索中' }, '◌')
                    : null),
                prefixNodes)),
            notice === null || notice === undefined
              ? null
              : h('div', {
                  className: 'dsh_tm_histnotice',
                  'data-tone': notice.tone,
                  role: 'status',
                },
                  h('span', { className: 'dsh_tm_histnoticetext' }, notice.text),
                  notice.action === null || notice.action === undefined
                    ? null
                    : h('button', {
                        type: 'button', className: 'dsh_tm_histnoticeact',
                        onClick: function (event) {
                          event.stopPropagation()
                          try { notice.action.onClick() } catch (error) { /* 动作按钮失败不打断提示 */ }
                        },
                      }, notice.action.label)),
            h('div', { className: 'dsh_tm_histbody', ref: listRef }, bodyChildren),
            h('div', { className: 'dsh_tm_histfoot', 'data-footer': 'pager' },
              h('div', { className: 'dsh_tm_histfootrow' },
                h('div', { className: 'dsh_tm_histfootlines' },
                  h('div', { className: 'dsh_tm_histstats', key: 'total' }, footerSummary),
                  footLines),
                h('div', { className: 'dsh_tm_histfoottools' },
                  result.workspace !== null && result.workspace !== undefined && result.workspace.id !== null && result.workspace.id !== undefined
                    ? h('button', {
                        type: 'button', className: 'dsh_tm_histreindex',
                        title: '为该工作区补齐索引',
                        onClick: function () { reindexWorkspace() },
                      }, '补齐索引')
                    : null,
                  pager))),
            typeof diagText === 'string' && diagText !== ''
              ? h('div', { className: 'dsh_tm_histdiag' }, '最近诊断：' + diagText)
              : null)),
        renderOverrideDialog(),
        renderHistoryModal(),
        renderActionConfirm(),
        rollbackPreviewNodes(h, rollback, {
          close: closeHistoryRollback,
          copy: function (text) {
            historyCopyText(text).then(function (ok) {
              showHistoryNotice(ok ? '预演清单已复制' : '复制失败：剪贴板不可用', ok ? 'ok' : 'error')
            })
          },
        }),
      )
    }

    // ── 统计 tab ─────────────────────────────────────────────────────
    function StatsTabBody(props) {
      useTopicMapTheme()
      var boundSessionId = props === null || props === undefined ? null : props.sessionId
      var stateState = useState({ status: 'idle', value: null, error: '', workspaceId: '' })
      var state = stateState[0]; var setState = stateState[1]
      var seqRef = useRef(0)
      var sortState = useState(STATS_SORT_TURNS)
      var sortMode = sortState[0]; var setSortMode = sortState[1]
      var sortLoadedRef = useRef('')

      function load() {
        seqRef.current += 1
        var seq = seqRef.current
        setState(function (prev) {
          return { status: 'loading', value: prev.value, error: '', workspaceId: prev.workspaceId }
        })
        loadStatsForSession(boundSessionId).then(function (result) {
          if (seq !== seqRef.current) return
          if (result.ok === true) {
            setState({ status: 'ready', value: result.value, error: '', workspaceId: result.workspaceId })
          } else {
            setState(function (prev) {
              return { status: 'error', value: prev.value, error: result.error, workspaceId: result.workspaceId }
            })
          }
        })
      }

      useEffect(function () {
        load()
        return function () { seqRef.current += 1 }
      }, [boundSessionId])

      // 排序选择按工作区记忆；换工作区先读存储，不触发 /stats 重拉。
      useEffect(function () {
        var workspace = state.workspaceId === '' ? 'default' : state.workspaceId
        if (sortLoadedRef.current === workspace) return
        sortLoadedRef.current = workspace
        setSortMode(readStatsSort(state.workspaceId))
      }, [state.workspaceId])

      function changeStatsSort(mode) {
        setSortMode(saveStatsSort(state.workspaceId, mode))
      }

      var model = state.value === null ? null : statsPageModel(state.value, Date.now(), sortMode)
      var body = null
      if (state.status === 'loading' && model === null) {
        body = h('div', { className: 'dsh_tm_statsempty' }, '正在统计…')
      } else if (state.status === 'error') {
        body = h('div', { className: 'dsh_tm_statserr', role: 'alert' },
          h('div', { className: 'dsh_tm_statserrtext' }, '统计失败：' + state.error),
          h('button', {
            type: 'button', className: 'dsh_tm_statsretry', 'data-action': 'retry',
            onClick: function () { load() },
          }, '重试'))
      } else if (model !== null && model.empty) {
        body = h('div', { className: 'dsh_tm_statsempty' }, '这个工作区还没有可统计的会话')
      } else if (model !== null) {
        body = h(React.Fragment, null, statsPageNodes(h, model, model.sortMode, changeStatsSort))
      } else {
        body = h('div', { className: 'dsh_tm_statsempty' }, '正在统计…')
      }

      return h('div', { className: 'dsh_tm_stats' },
        props !== null && props !== undefined && props.hideTabStrip === true ? null : h(RightTabStrip, {
          active: STATS_KIND,
          open: props === null || props === undefined ? undefined : props.openTab,
        }),
        h('div', { className: 'dsh_tm_statshead' },
          h('div', { className: 'dsh_tm_statstitle' }, STATS_TITLE),
          state.workspaceId === ''
            ? null
            : h('span', { className: 'dsh_tm_statsws', title: state.workspaceId }, state.workspaceId),
          h('button', {
            type: 'button', className: 'dsh_tm_statsrefresh',
            title: '重新统计', 'aria-label': '重新统计',
            disabled: state.status === 'loading',
            onClick: function () { load() },
          }, '↻')),
        h('div', { className: 'dsh_tm_statsbody' }, body))
    }

    // ── 续接（Works）首页 ────────────────────────────────────────────
    /**
     * 把后端 POST /works 或 POST /works-scan 返回的响应归一为 WORKVIEW.workBoardModel 所需载荷。
     *
     * 兼容后端两种常见形状：
     *   - `{ cards: { unresolved, settled, pendingReviewCount }, works, latestInflection, reopenSuggestion, initialized, refining }`
     *   - `{ unresolved, settled, pendingReviewCount, inflection, reopenSuggestions }`
     * 同时把 works 里的完整 decisions / files / evidenceHandles / segments 合并进卡片对象，
     * 以便展开详情时直接看到完整决策序列与跨会话段清单。
     */
    function normalizeWorksPayload(raw) {
      var data = raw !== null && raw !== undefined && typeof raw === 'object' ? raw : {}
      var worksList = Array.isArray(data.works) ? data.works : []
      var workById = {}
      for (var i = 0; i < worksList.length; i += 1) {
        var w = worksList[i]
        if (w !== null && typeof w === 'object' && typeof w.id === 'string' && w.id !== '') {
          workById[w.id] = w
        }
      }
      var segMap = data.segments !== null && data.segments !== undefined && typeof data.segments === 'object'
        ? data.segments : {}

      function enrichCard(card) {
        if (card === null || card === undefined || typeof card !== 'object') return card
        var full = typeof card.id === 'string' && workById[card.id] !== undefined ? workById[card.id] : null
        if (full === null) return card
        var merged = {}
        var keys = Object.keys(full)
        for (var k = 0; k < keys.length; k += 1) merged[keys[k]] = full[keys[k]]
        var cKeys = Object.keys(card)
        for (var j = 0; j < cKeys.length; j += 1) {
          var key = cKeys[j]
          if (card[key] !== undefined) merged[key] = card[key]
        }
        if (!Array.isArray(merged.segments) || merged.segments.length === 0) {
          var segIds = Array.isArray(full.segmentIds) ? full.segmentIds : []
          var segOut = []
          for (var s = 0; s < segIds.length; s += 1) {
            var sid = segIds[s]
            var foundSeg = segMap[sid]
            if (foundSeg !== null && foundSeg !== undefined && typeof foundSeg === 'object') {
              segOut.push(foundSeg)
            } else if (typeof sid === 'string' && sid !== '') {
              segOut.push({ id: sid, sessionId: Array.isArray(full.sessionIds) && full.sessionIds.length > 0 ? full.sessionIds[0] : '' })
            }
          }
          if (segOut.length === 0 && Array.isArray(full.sessionIds) && full.sessionIds.length > 0) {
            for (var si = 0; si < full.sessionIds.length; si += 1) {
              segOut.push({ id: 'sess-' + full.sessionIds[si], sessionId: full.sessionIds[si], title: '会话 ' + String(full.sessionIds[si]).slice(0, 8), startTurn: 1, endTurn: 1 })
            }
          }
          if (segOut.length > 0) merged.segments = segOut
        }
        return merged
      }

      var cardsObj = data.cards !== null && data.cards !== undefined && typeof data.cards === 'object' && !Array.isArray(data.cards)
        ? data.cards : null
      var unresolved = Array.isArray(data.unresolved)
        ? data.unresolved
        : (cardsObj !== null && Array.isArray(cardsObj.unresolved) ? cardsObj.unresolved : [])
      var settled = Array.isArray(data.settled)
        ? data.settled
        : (cardsObj !== null && Array.isArray(cardsObj.settled) ? cardsObj.settled : [])

      var pending = Number(data.pendingReviewCount)
      if (!Number.isFinite(pending) && cardsObj !== null) pending = Number(cardsObj.pendingReviewCount)
      if (!Number.isFinite(pending)) pending = 0

      var reopenSuggestions = []
      if (Array.isArray(data.reopenSuggestions)) {
        reopenSuggestions = data.reopenSuggestions
      } else if (data.reopenSuggestion !== null && data.reopenSuggestion !== undefined && typeof data.reopenSuggestion === 'object') {
        reopenSuggestions = [data.reopenSuggestion]
      }

      var inflection = data.inflection !== undefined ? data.inflection : (data.latestInflection !== undefined ? data.latestInflection : null)
      var coldStarting = data.coldStarting === true
        || data.scanning === true
        || data.refining === true
        || (data.initialized === false && unresolved.length === 0 && settled.length === 0)

      // 会话是壳，对话是瓤（ADR-0012）：这两个计数必须原样透传到板模型，
      // 否则「有 3 个空会话」会被渲染成「你没有未收束的事」——就是在撒谎。
      var conv = Number(data.conversationCount)
      var empties = Number(data.emptySessionCount)
      return {
        unresolved: unresolved.map(enrichCard),
        settled: settled.map(enrichCard),
        pendingReviewCount: pending,
        reopenSuggestions: reopenSuggestions,
        inflection: inflection,
        coldStarting: coldStarting,
        initialized: data.initialized === true ? true : (data.initialized === false ? false : undefined),
        conversationCount: Number.isFinite(conv) ? conv : undefined,
        emptySessionCount: Number.isFinite(empties) ? empties : undefined,
        error: typeof data.error === 'string' && data.error !== '' ? data.error : undefined,
      }
    }

    /** 解析证据句柄 `〔8hex#N〕` 或 `8hex#N` 为 `{ prefix, turn }`。 */
    function parseWorkEvidenceHandle(handle) {
      var text = String(handle === null || handle === undefined ? '' : handle).trim()
      if (text === '') return null
      var m = text.match(/([0-9a-zA-Z_-]+)#(\d+)/)
      if (m === null) return null
      var turn = Number(m[2])
      if (!Number.isFinite(turn) || turn <= 0) return null
      return { prefix: m[1], turn: turn }
    }

    /** 按证据前缀在给定会话 id 清单里找完整 sessionId（优先匹配前缀，否则退回第一个会话）。 */
    function resolveWorkEvidenceSession(prefix, card) {
      var p = String(prefix === null || prefix === undefined ? '' : prefix)
      if (p === '') return ''
      var candidates = []
      if (card !== null && card !== undefined && typeof card === 'object') {
        if (Array.isArray(card.segments)) {
          for (var i = 0; i < card.segments.length; i += 1) {
            var sid = card.segments[i] && card.segments[i].sessionId
            if (typeof sid === 'string' && sid !== '' && candidates.indexOf(sid) < 0) candidates.push(sid)
          }
        }
      }
      for (var j = 0; j < candidates.length; j += 1) {
        var cid = candidates[j]
        if (cid === p || cid.indexOf(p) === 0 || cid.replace(/^session[-_:]/i, '').indexOf(p) === 0) {
          return cid
        }
      }
      return candidates.length > 0 ? candidates[0] : p
    }

    /** 根据一条历史命中构造 POST /work-promote 所需的 segment 载荷。 */
    function buildPromoteSegmentPayload(hit) {
      if (hit === null || hit === undefined || typeof hit !== 'object') return null
      var sid = typeof hit.sessionId === 'string' ? hit.sessionId.trim() : ''
      var turn = Number(hit.turn)
      var turnNo = Number.isFinite(turn) && turn > 0 ? Math.trunc(turn) : 1
      var rawTitle = typeof hit.promptHead === 'string' && hit.promptHead.trim() !== ''
        ? hit.promptHead.trim()
        : (typeof hit.title === 'string' && hit.title.trim() !== '' ? hit.title.trim() : '未命名工作')
      var title = rawTitle.length > 40 ? rawTitle.slice(0, 39) + '…' : rawTitle
      var summary = typeof hit.digest === 'string' && hit.digest.trim() !== ''
        ? hit.digest.trim()
        : rawTitle
      var ts = Number(hit.time)
      return {
        id: 'promote-' + (sid === '' ? 'unknown' : sid) + '-' + turnNo,
        sessionId: sid,
        title: title,
        summary: summary,
        startTurn: turnNo,
        endTurn: turnNo,
        lastActivityAt: Number.isFinite(ts) ? ts : Date.now(),
        evidenceHandles: sid !== '' ? ['〔' + sid.replace(/^session[-_:]/i, '').slice(0, 8) + '#' + turnNo + '〕'] : [],
      }
    }

    /** 从 startSession 返回值提取新会话 id（兼容字符串、{ sessionId }、{ id }）。 */
    function extractStartedSessionId(result) {
      if (typeof result === 'string' && result.trim() !== '') return result.trim()
      if (result === null || result === undefined || typeof result !== 'object') return ''
      if (typeof result.sessionId === 'string' && result.sessionId.trim() !== '') return result.sessionId.trim()
      if (typeof result.id === 'string' && result.id.trim() !== '') return result.id.trim()
      if (result.session !== null && result.session !== undefined && typeof result.session === 'object') {
        if (typeof result.session.id === 'string' && result.session.id.trim() !== '') return result.session.id.trim()
        if (typeof result.session.sessionId === 'string' && result.session.sessionId.trim() !== '') return result.session.sessionId.trim()
      }
      return ''
    }

    /** 续接首页组件：打开即显物化快照 + 拐点/重开轻确认 + 4 行窄卡片 + 三层交接。 */
    function WorksTabBody(props) {
      useTopicMapTheme()
      var boundSessionId = props === null || props === undefined ? null : props.sessionId
      var openTab = props === null || props === undefined ? null : props.openTab
      var stateTuple = useState({
        status: 'loading',
        workspaceId: '',
        raw: null,
        error: '',
      })
      var state = stateTuple[0]; var setState = stateTuple[1]
      var scanningTuple = useState(false)
      var scanning = scanningTuple[0]; var setScanning = scanningTuple[1]
      var busyTuple = useState('')
      var busyId = busyTuple[0]; var setBusyId = busyTuple[1]
      var showSettledTuple = useState(false)
      var showSettled = showSettledTuple[0]; var setShowSettled = showSettledTuple[1]
      var expandedTuple = useState({})
      var expandedMap = expandedTuple[0]; var setExpandedMap = expandedTuple[1]
      var nextStepEditTuple = useState({})
      var nextStepEdits = nextStepEditTuple[0]; var setNextStepEdits = nextStepEditTuple[1]
      var reviewModeTuple = useState(false)
      var reviewMode = reviewModeTuple[0]; var setReviewMode = reviewModeTuple[1]
      // 合并 / 拆段的选择器状态（ADR-0001 的事级动作）：空串表示未在选择中。
      var mergePickTuple = useState('')
      var mergePickId = mergePickTuple[0]; var setMergePickId = mergePickTuple[1]
      var splitPickTuple = useState('')
      var splitPickId = splitPickTuple[0]; var setSplitPickId = splitPickTuple[1]
      var hiddenReopenTuple = useState({})
      var hiddenReopen = hiddenReopenTuple[0]; var setHiddenReopen = hiddenReopenTuple[1]
      var noticeTuple = useState(null)
      var notice = noticeTuple[0]; var setNotice = noticeTuple[1]
      var noticeTimerRef = useRef(0)
      var reqSeqRef = useRef(0)
      var refinePollTimerRef = useRef(0)
      var refinePollCountRef = useRef(0)
      var wasRefiningRef = useRef(false)
      var unmountedRef = useRef(false)
      var wsCacheRef = useRef({ sessionId: null, workspaceId: '' })
      // 顶部工作区切换器（ADR-0008）：默认跟随当前会话，用户可显式切换。
      var wsListTuple = useState([])
      var wsList = wsListTuple[0]; var setWsList = wsListTuple[1]
      // 巡检工作区由抽屉标题栏统一管理（ADR-0011）：这里只消费，不再自己放一个下拉。
      var pickedWs = props !== null && props !== undefined && typeof props.inspectedWorkspaceId === 'string'
        ? props.inspectedWorkspaceId : ''
      var readonly = props !== null && props !== undefined && props.readonly === true

      /**
       * 把 refineStatus.reason 翻成人话。
       *
       * 刻意声明在组件**内部**：客户端测试harness 会把这个函数单独抽出来求值，
       * 放到模块作用域会变成 ReferenceError。
       */
      function refineReasonText(reason) {
        var r = String(reason === null || reason === undefined ? '' : reason)
        if (r === 'ok') return '已深度提炼'
        if (r === 'running') return '正在深度提炼…'
        if (r === 'no_model') return '未配置模型'
        if (r === 'timeout') return '模型超时'
        if (r === 'invalid_json') return '模型返回无法解析'
        if (r === 'failed') return '调用失败'
        return '还没提炼过'
      }

      function flashNotice(text, tone) {
        var msg = String(text === null || text === undefined ? '' : text)
        if (msg === '') return
        setNotice({ text: msg, tone: tone === 'error' ? 'error' : (tone === 'ok' ? 'ok' : 'info') })
        if (noticeTimerRef.current !== 0) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = setTimeout(function () {
          noticeTimerRef.current = 0
          setNotice(null)
        }, 4200)
      }

      function stopRefinePoll() {
        if (refinePollTimerRef.current !== 0) {
          clearTimeout(refinePollTimerRef.current)
          refinePollTimerRef.current = 0
        }
      }

      useEffect(function () {
        unmountedRef.current = false
        return function () {
          unmountedRef.current = true
          if (noticeTimerRef.current !== 0) clearTimeout(noticeTimerRef.current)
          stopRefinePoll()
        }
      }, [])

      function loadWorks(silent, onLoaded) {
        reqSeqRef.current += 1
        var seq = reqSeqRef.current
        if (silent !== true) {
          // 切区即清态（ADR-0008）：非静默加载一律先清空旧数据。
          // 以前这里保留 prev.raw 并要求 status 保持 'ready'，导致切工作区瞬间
          // 仍在渲染上一个工作区的卡片（串台）。
          setState({ status: 'loading', workspaceId: '', raw: null, error: '' })
        }
        return resolveWs().then(function (wsId) {
          var body = {}
          if (wsId !== '') body.workspaceId = wsId
          if (boundSessionId !== null && boundSessionId !== undefined && String(boundSessionId) !== '') {
            body.sessionId = String(boundSessionId)
          }
          return requestTopicMap('works', body).then(function (res) {
            if (unmountedRef.current || seq !== reqSeqRef.current) return null
            if (res.ok === true) {
              var resolvedWs = res.value !== null && res.value !== undefined && typeof res.value.workspaceId === 'string' && res.value.workspaceId !== ''
                ? res.value.workspaceId : wsId
              setState({ status: 'ready', workspaceId: resolvedWs, raw: res.value, error: '' })
              if (typeof onLoaded === 'function') onLoaded(res.value)
              return res.value
            } else {
              setState(function (prev) {
                return { status: 'error', workspaceId: wsId || prev.workspaceId, raw: prev.raw, error: res.error || '读取续接清单失败' }
              })
              return null
            }
          })
        })
      }

      useEffect(function () {
        loadWorks(false)
      }, [boundSessionId, pickedWs])

      // 拉一次工作区清单供顶部切换器使用（失败就静默保留单选，不影响主流程）。
      useEffect(function () {
        requestTopicMap('workspaces', {}).then(function (res) {
          if (unmountedRef.current) return
          if (res.ok === true && Array.isArray(res.value)) setWsList(res.value)
        }).catch(function () {})
      }, [])

      var isRefining = state.raw !== null && state.raw !== undefined && state.raw.refining === true

      useEffect(function () {
        if (isRefining) {
          wasRefiningRef.current = true
          if (refinePollTimerRef.current === 0 && refinePollCountRef.current < 25) {
            refinePollTimerRef.current = setTimeout(function () {
              refinePollTimerRef.current = 0
              if (unmountedRef.current) return
              refinePollCountRef.current += 1
              loadWorks(true, function (nextVal) {
                if (!nextVal || nextVal.refining !== true) {
                  wasRefiningRef.current = false
                  refinePollCountRef.current = 0
                  var nextCards = nextVal && nextVal.cards && Array.isArray(nextVal.cards.unresolved)
                    ? nextVal.cards.unresolved.length
                    : (nextVal && Array.isArray(nextVal.unresolved) ? nextVal.unresolved.length : 0)
                  flashNotice('深度提炼已完成（未收束 ' + nextCards + ' 件）', 'ok')
                }
              })
            }, 2500)
          }
        } else {
          stopRefinePoll()
          if (wasRefiningRef.current) {
            wasRefiningRef.current = false
            refinePollCountRef.current = 0
          }
        }
      }, [isRefining, state.raw])

      function resolveWs() {
        // 用户在工作区切换器里显式选过的，以选择为准。
        if (pickedWs !== '') return Promise.resolve(pickedWs)
        // 缓存必须绑定到「哪个会话」上（ADR-0008）：
        // 以前只要 state.workspaceId 非空就直接返回，切会话后会把上一个会话/
        // 工作区的 id 继续用在扫描、确认、重试上，请求打到了别的工作区。
        var cache = wsCacheRef.current
        if (cache.sessionId === boundSessionId && cache.workspaceId !== '') {
          return Promise.resolve(cache.workspaceId)
        }
        return currentWorkspaceId(boundSessionId).then(function (wsId) {
          wsCacheRef.current = { sessionId: boundSessionId, workspaceId: wsId }
          return wsId
        })
      }

      function countPendingFromPayload(val) {
        if (val === null || val === undefined || typeof val !== 'object') return 0
        if (Number.isFinite(Number(val.pendingReviewCount))) return Math.max(0, Math.floor(Number(val.pendingReviewCount)))
        if (val.cards && Number.isFinite(Number(val.cards.pendingReviewCount))) return Math.max(0, Math.floor(Number(val.cards.pendingReviewCount)))
        return 0
      }

      /**
       * 一键重试语义提炼（ADR-0010）。
       *
       * 与「重新盘点」的区别：盘点先跑硬信号，再视情况提炼；
       * 重试是用户看到「仅基础规则（超时）」后明确要求再提炼一次，所以直连
       * POST /work-refine-retry，并且必须显式给 workspaceId（该端点强制要求）。
       */
      function runRefineRetry() {
        if (readonly) { refuseWrite(); return }
        if (scanning) return
        setScanning(true)
        resolveWs().then(function (wsId) {
          if (wsId === '') throw new Error('还不知道当前工作区，先点「重新盘点」')
          var retryBody = { workspaceId: wsId }
          if (boundSessionId) retryBody.requesterSessionId = String(boundSessionId)
          return requestTopicMap('work-refine-retry', retryBody)
        }).then(function (res) {
          if (unmountedRef.current) return
          setScanning(false)
          if (res.ok === true) {
            var nextVal = res.value
            if (nextVal) setState({ status: 'ready', workspaceId: nextVal.workspaceId || '', raw: nextVal, error: '' })
            var rs = nextVal && nextVal.refineStatus ? nextVal.refineStatus : null
            if (rs && rs.used === true) flashNotice('深度提炼成功', 'ok')
            else flashNotice('仍然只拿到基础规则（' + refineReasonText(rs && rs.reason) + '）', 'error')
          } else {
            flashNotice(res.error || '重新提炼失败', 'error')
          }
        }).catch(function (error) {
          if (unmountedRef.current) return
          setScanning(false)
          flashNotice((error && error.message) || '重新提炼失败', 'error')
        })
      }

      /** 把 source 并进 target（ADR-0001：事级合并，可人工指定方向）。 */
      function runMergeWorks(sourceWorkId, targetWorkId) {
        if (readonly) { refuseWrite(); return }
        if (!sourceWorkId || !targetWorkId || sourceWorkId === targetWorkId) return
        if (busyId !== '') return
        setBusyId('__merge__')
        resolveWs().then(function (wsId) {
          var body = { targetWorkId: targetWorkId, sourceWorkId: sourceWorkId }
          if (wsId !== '') body.workspaceId = wsId
          if (boundSessionId) body.requesterSessionId = String(boundSessionId)
          return requestTopicMap('work-merge', body)
        }).then(function (res) {
          setBusyId('')
          setMergePickId('')
          if (res.ok === true) {
            flashNotice('已合并为「' + String((res.value && res.value.work && res.value.work.title) || '同一件事') + '」', 'ok')
            loadWorks(true)
          } else {
            flashNotice('合并失败：' + (res.error || '未知错误'), 'error')
          }
        }, function (error) {
          setBusyId('')
          setMergePickId('')
          flashNotice('合并失败：' + ((error && error.message) || '未知错误'), 'error')
        })
      }

      /** 把某个段从这件事里拆出去，独立成新事。 */
      function runSplitWork(workId, segmentId) {
        if (readonly) { refuseWrite(); return }
        if (!workId || !segmentId) return
        if (busyId !== '') return
        setBusyId('__split__')
        resolveWs().then(function (wsId) {
          var body = { workId: workId, segmentId: segmentId }
          if (wsId !== '') body.workspaceId = wsId
          if (boundSessionId) body.requesterSessionId = String(boundSessionId)
          return requestTopicMap('work-split', body)
        }).then(function (res) {
          setBusyId('')
          setSplitPickId('')
          if (res.ok === true) {
            flashNotice('已拆出独立的一段', 'ok')
            loadWorks(true)
          } else {
            flashNotice('拆段失败：' + (res.error || '未知错误'), 'error')
          }
        }, function (error) {
          setBusyId('')
          setSplitPickId('')
          flashNotice('拆段失败：' + ((error && error.message) || '未知错误'), 'error')
        })
      }

      function runManualScan() {
        if (readonly) { refuseWrite(); return }
        if (scanning) return
        setScanning(true)
        refinePollCountRef.current = 0
        stopRefinePoll()
        resolveWs().then(function (wsId) {
          var body = { force: true, asyncRefine: true }
          if (wsId !== '') body.workspaceId = wsId
          if (boundSessionId) body.requesterSessionId = String(boundSessionId)
          return requestTopicMap('works-scan', body)
        }).then(function (res) {
          setScanning(false)
          if (res.ok === true) {
            var val = res.value || {}
            setState(function (prev) {
              var nextWs = typeof val.workspaceId === 'string' && val.workspaceId !== ''
                ? val.workspaceId : prev.workspaceId
              return { status: 'ready', workspaceId: nextWs, raw: val, error: '' }
            })
            var st = val.stats || val.lastScanSummary || null
            var unresolvedNum = st && Number.isFinite(Number(st.unresolvedCount))
              ? Number(st.unresolvedCount)
              : (val.cards && Array.isArray(val.cards.unresolved) ? val.cards.unresolved.length : 0)
            var settledNum = st && Number.isFinite(Number(st.settledCount))
              ? Number(st.settledCount)
              : (val.cards && Array.isArray(val.cards.settled) ? val.cards.settled.length : 0)
            var sessNum = st && Number.isFinite(Number(st.sessionsScanned)) ? Number(st.sessionsScanned) : 0
            if (val.refining === true) {
              flashNotice(
                '已完成规则盘点（' + sessNum + ' 个会话 → ' + unresolvedNum + ' 件未收束 / ' + settledNum + ' 件已收束），正在后台深度提炼…',
                'info',
              )
            } else if (st !== null) {
              flashNotice(
                '盘点完成：共扫描 ' + sessNum + ' 个会话，整理出 ' + unresolvedNum + ' 件未收束、' + settledNum + ' 件已收束',
                'ok',
              )
            } else {
              flashNotice('盘点完成（未收束 ' + unresolvedNum + ' 件，已收束 ' + settledNum + ' 件）', 'ok')
            }
          } else {
            flashNotice('重新盘点失败：' + (res.error || '未知错误'), 'error')
          }
        })
      }

      /** 只读巡检时统一拒绝写操作并说明（ADR-0011）：不是拦人，是让他知道站在哪。 */
      function refuseWrite() {
        flashNotice('跨工作区只读：想在这里修改，请在这个工作区打开一个会话，或用「交接」把自己带过去', 'error')
        return true
      }

      function confirmPatch(workId, patch, successText, fromReview) {
        if (readonly) { refuseWrite(); return }
        if (!workId || busyId !== '') return
        setBusyId(workId)
        resolveWs().then(function (wsId) {
          var body = { workId: workId, patch: patch }
          if (wsId !== '') body.workspaceId = wsId
          // 带上发起会话：后端据此判断是否为跨区写（ADR-0011）。
          if (boundSessionId) body.requesterSessionId = String(boundSessionId)
          return requestTopicMap('work-confirm', body)
        }).then(function (res) {
          setBusyId('')
          if (res.ok === true) {
            loadWorks(true, function (nextVal) {
              var rem = countPendingFromPayload(nextVal)
              if (fromReview === true && rem === 0) {
                setReviewMode(false)
                flashNotice('全部核对完成', 'ok')
              } else {
                flashNotice(successText || '已更新', 'ok')
              }
            })
          } else {
            flashNotice('更新失败：' + (res.error || '未知错误'), 'error')
          }
        })
      }

      function confirmAllPending() {
        if (busyId !== '') return
        setBusyId('__all__')
        resolveWs().then(function (wsId) {
          var body = wsId === '' ? {} : { workspaceId: wsId }
          return requestTopicMap('work-review-all', body)
        }).then(function (res) {
          setBusyId('')
          if (res.ok === true) {
            setReviewMode(false)
            var count = res.value && Number.isFinite(Number(res.value.confirmedCount)) ? Number(res.value.confirmedCount) : 0
            flashNotice(count > 0 ? ('全部核对完成（已确认锁定 ' + count + ' 件）') : '全部核对完成', 'ok')
            loadWorks(true)
          } else {
            flashNotice('批量确认失败：' + (res.error || '未知错误'), 'error')
          }
        })
      }

      function dismissAsChat(workId, fromReview) {
        if (!workId || busyId !== '') return
        setBusyId(workId)
        resolveWs().then(function (wsId) {
          var body = { workId: workId }
          if (wsId !== '') body.workspaceId = wsId
          return requestTopicMap('work-dismiss', body)
        }).then(function (res) {
          setBusyId('')
          if (res.ok === true) {
            loadWorks(true, function (nextVal) {
              var rem = countPendingFromPayload(nextVal)
              if (fromReview === true && rem === 0) {
                setReviewMode(false)
                flashNotice('已退回话题，全部核对完成', 'ok')
              } else {
                flashNotice('已退回话题，不再在续接页提醒', 'ok')
              }
            })
          } else {
            flashNotice('操作失败：' + (res.error || '未知错误'), 'error')
          }
        })
      }

      function dismissInflectionBanner() {
        resolveWs().then(function (wsId) {
          var body = wsId === '' ? {} : { workspaceId: wsId }
          return requestTopicMap('work-inflection-dismiss', body)
        }).then(function (res) {
          if (res.ok === true) {
            setState(function (prev) {
              if (prev.raw === null || prev.raw === undefined) return prev
              var copy = Object.assign({}, prev.raw, { latestInflection: null, inflection: null })
              return { status: prev.status, workspaceId: prev.workspaceId, raw: copy, error: prev.error }
            })
          } else {
            flashNotice('忽略失败：' + (res.error || '未知错误'), 'error')
          }
        })
      }

      function handleInflectionAction(banner, action) {
        if (banner === null || action === null) return
        if (action.id === 'ignore' || action.state === null) {
          dismissInflectionBanner()
          return
        }
        confirmPatch(banner.workId, { state: action.state, reviewStatus: 'reviewed' }, '已确认「' + banner.title + '」状态')
      }

      function handleReopenAction(banner, actionId) {
        if (banner === null) return
        if (actionId === 'reopen_link') {
          confirmPatch(banner.workId, { state: 'active', reviewStatus: 'reviewed' }, '已关联重开「' + banner.title + '」')
        }
        setHiddenReopen(function (prev) {
          var next = Object.assign({}, prev)
          next[banner.workId || banner.title] = true
          return next
        })
      }

      function handleSameSessionResume(card) {
        if (!card || !card.id || busyId !== '') return
        setBusyId(card.id)
        resolveWs().then(function (wsId) {
          var body = { workId: card.id, mode: 'same-session' }
          if (wsId !== '') body.workspaceId = wsId
          return requestTopicMap('work-handoff', body)
        }).then(function (res) {
          setBusyId('')
          if (res.ok !== true || res.value === null || res.value === undefined) {
            flashNotice('生成回到现场失败：' + (res.error || '未知错误'), 'error')
            return
          }
          var val = res.value
          var targetSid = typeof val.targetSessionId === 'string' ? val.targetSessionId : ''
          var targetTurn = Number(val.targetTurn)
          var targetSeq = val.targetSeq === undefined ? null : val.targetSeq
          var draft = typeof val.draft === 'string' ? val.draft : ''

          var afterLocate = function () {
            if (draft === '') {
              flashNotice('已定位到上次现场', 'ok')
              return
            }
            historyWriteToComposer(draft, { raw: true }).then(function (written) {
              if (written && written.ok === true) {
                flashNotice('已定位并预填续接草稿（未自动发送）', 'ok')
              } else {
                historyCopyText(draft).then(function (copied) {
                  flashNotice(copied ? '已定位现场，草稿已复制到剪贴板' : '已定位现场，请手动粘贴草稿', copied ? 'ok' : 'info')
                })
              }
            })
          }

          if (targetSid !== '' && Number.isFinite(targetTurn) && targetTurn > 0) {
            locateHistoryTurn(targetSid, targetTurn, targetSeq, boundSessionId).then(function () {
              afterLocate()
            }, function () {
              afterLocate()
            })
          } else {
            afterLocate()
          }
        })
      }

      function handleNewSessionHandoff(card) {
        if (!card || !card.id || busyId !== '') return
        setBusyId(card.id)
        var resolvedWs = ''
        resolveWs().then(function (wsId) {
          resolvedWs = wsId
          var body = { workId: card.id, mode: 'new-session' }
          if (wsId !== '') body.workspaceId = wsId
          return requestTopicMap('work-handoff', body)
        }).then(function (res) {
          setBusyId('')
          if (res.ok !== true || res.value === null || res.value === undefined) {
            flashNotice('生成交接草稿失败：' + (res.error || '未知错误'), 'error')
            return
          }
          var draft = typeof res.value.draft === 'string' ? res.value.draft : ''
          var wsId = typeof res.value.workspaceId === 'string' && res.value.workspaceId !== ''
            ? res.value.workspaceId : resolvedWs
          var opener = typeof UI_WORKSPACE_SERVICE !== 'undefined' ? UI_WORKSPACE_SERVICE : null
          var prevSessionId = typeof drawerCurrentSessionId === 'function' ? drawerCurrentSessionId() : boundSessionId

          function bindNewSession(newSid) {
            if (!newSid) return
            var bindBody = { workId: card.id, sessionId: newSid }
            if (wsId !== '') bindBody.workspaceId = wsId
            requestTopicMap('work-handoff-bind', bindBody).catch(function () { /* 血缘绑定失败不阻塞草稿 */ })
          }

          if (opener !== null && opener !== undefined && typeof opener.startSession === 'function') {
            try {
              var started = opener.startSession(wsId, { prompt: draft, whenDraftExists: 'replace' })
              Promise.resolve(started).then(function (startedRes) {
                var newSid = extractStartedSessionId(startedRes)
                if (newSid !== '') {
                  bindNewSession(newSid)
                } else if (typeof drawerCurrentSessionId === 'function') {
                  setTimeout(function () {
                    var polled = drawerCurrentSessionId()
                    if (polled && polled !== prevSessionId) bindNewSession(polled)
                  }, 600)
                }
                flashNotice('已打开新会话并预填交接草稿（未自动发送）', 'ok')
              }, function () {
                historyCopyText(draft).then(function (copied) {
                  flashNotice(copied ? '新开会话失败，交接草稿已复制到剪贴板' : '新开会话失败', 'error')
                })
              })
              return
            } catch (error) {
              // 降级到剪贴板
            }
          }

          historyCopyText(draft).then(function (copied) {
            flashNotice(copied ? '宿主未提供 startSession，交接草稿已复制到剪贴板' : '交接草稿生成完成，请复制使用', copied ? 'ok' : 'info')
          })
        })
      }

      function jumpToSegment(seg) {
        if (!seg || !seg.sessionId) return
        var turn = Number.isFinite(Number(seg.startTurn)) && Number(seg.startTurn) > 0 ? Number(seg.startTurn) : 1
        locateHistoryTurn(seg.sessionId, turn, null, boundSessionId).then(function (res) {
          if (res && res.ok === false) flashNotice('跳转失败：' + (res.reason || '未知原因'), 'error')
        })
      }

      function jumpToEvidence(handle, card) {
        var parsed = parseWorkEvidenceHandle(handle)
        if (parsed === null) return
        var sid = resolveWorkEvidenceSession(parsed.prefix, card)
        if (sid === '') return
        locateHistoryTurn(sid, parsed.turn, null, boundSessionId).then(function (res) {
          if (res && res.ok === false) flashNotice('跳转证据失败：' + (res.reason || '未知原因'), 'error')
        })
      }

      function toggleExpand(workId) {
        setExpandedMap(function (prev) {
          var next = Object.assign({}, prev)
          next[workId] = !prev[workId]
          return next
        })
      }

      var normalized = state.raw !== null ? normalizeWorksPayload(state.raw) : null
      var board = normalized !== null
        ? WORKVIEW.workBoardModel(normalized, { now: Date.now(), showSettled: showSettled })
        : null

      var visibleReopenBanners = []
      if (board !== null && Array.isArray(board.reopenBanners)) {
        for (var r = 0; r < board.reopenBanners.length; r += 1) {
          var rb = board.reopenBanners[r]
          var rKey = rb.workId || rb.title
          if (!hiddenReopen[rKey]) visibleReopenBanners.push(rb)
        }
      }

      function renderCard(card, isSettled) {
        var expanded = expandedMap[card.id] === true
        var isBusy = busyId === card.id
        // 写按钮的 disabled 判据（ADR-0011）：只读巡检时把「在远方改数据」的按钮全灰掉，
        // 但交接的两种形态保持可用——它们不在远方改数据，而是把用户带到那边去。
        var busyForWrite = isBusy || readonly
        var editVal = nextStepEdits[card.id] !== undefined ? nextStepEdits[card.id] : card.nextStep

        var detailNode = null
        if (expanded) {
          detailNode = h('div', { className: 'dsh_tm_workdetail', 'data-work-detail': card.id },
            // 决策序列
            h('div', { className: 'dsh_tm_worksec' },
              h('div', { className: 'dsh_tm_worksectitle' }, '决策序列（' + card.decisions.length + '）'),
              card.decisions.length === 0
                ? h('div', { className: 'dsh_tm_workdecrat' }, '暂无记录决策')
                : card.decisions.map(function (dec, idx) {
                    return h('div', {
                      key: dec.id || ('dec-' + idx),
                      className: 'dsh_tm_workdec',
                      'data-status': dec.status,
                    },
                      h('div', { className: 'dsh_tm_workdechead' },
                        h('span', { className: 'dsh_tm_workbadge' }, dec.statusLabel),
                        h('span', { className: 'dsh_tm_workdectext' }, dec.summary),
                        dec.evidenceHandle !== ''
                          ? h('button', {
                              type: 'button',
                              className: 'dsh_tm_workhandle',
                              title: '跳到原文证据 ' + dec.evidenceHandle,
                              onClick: function () { jumpToEvidence(dec.evidenceHandle, card) },
                            }, dec.evidenceHandle)
                          : null),
                      dec.rationale !== ''
                        ? h('div', { className: 'dsh_tm_workdecrat' }, dec.rationale)
                        : null)
                  })),
            // 涉及文件
            card.files.length > 0
              ? h('div', { className: 'dsh_tm_worksec' },
                  h('div', { className: 'dsh_tm_worksectitle' }, '涉及文件（' + card.files.length + '）'),
                  h('div', { className: 'dsh_tm_workfiles' },
                    card.files.map(function (f) {
                      return h('span', { key: f, className: 'dsh_tm_workfile' }, f)
                    })))
              : null,
            // 跨会话段清单
            card.segments.length > 0
              ? h('div', { className: 'dsh_tm_worksec' },
                  h('div', { className: 'dsh_tm_worksectitle' }, '跨会话段（' + card.segments.length + '）'),
                  card.segments.map(function (seg, idx) {
                    return h('button', {
                      key: seg.id || ('seg-' + idx),
                      type: 'button',
                      className: 'dsh_tm_workseg',
                      'data-segment-id': seg.id,
                      onClick: function () { jumpToSegment(seg) },
                    },
                      h('span', null, seg.title),
                      h('span', { className: 'dsh_tm_worksegrange' },
                        (seg.shortSessionId ? seg.shortSessionId + ' ' : '') + seg.turnRangeLabel))
                  }))
              : null,
            // 行内修改下一步 + 置顶 / 退回话题
            h('div', { className: 'dsh_tm_worksec' },
              h('div', { className: 'dsh_tm_worksectitle' }, '编辑下一步'),
              h('div', { className: 'dsh_tm_workeditrow' },
                h('input', {
                  type: 'text',
                  className: 'dsh_tm_workinput',
                  'data-work-nextstep': card.id,
                  value: editVal,
                  placeholder: '填写明确的下一步行动…',
                  onChange: function (event) {
                    var v = event && event.target ? String(event.target.value || '') : ''
                    setNextStepEdits(function (prev) {
                      var next = Object.assign({}, prev)
                      next[card.id] = v
                      return next
                    })
                  },
                }),
                h('button', {
                  type: 'button',
                  className: 'dsh_tm_worksbtn',
                  'data-action': 'save-nextstep',
                  disabled: busyForWrite,
                  onClick: function () {
                    confirmPatch(card.id, { nextStep: editVal, reviewStatus: 'reviewed' }, '已锁定下一步')
                  },
                }, '保存'))),
            h('div', { className: 'dsh_tm_workrow4' },
              h('button', {
                type: 'button',
                className: 'dsh_tm_worksbtn',
                'data-action': 'toggle-pin',
                disabled: busyForWrite,
                onClick: function () {
                  confirmPatch(card.id, { pinned: !card.pinned, reviewStatus: 'reviewed' }, card.pinned ? '已取消置顶' : '已置顶')
                },
              }, card.pinned ? '取消置顶' : '置顶'),
              !isSettled
                ? h('button', {
                    type: 'button',
                    className: 'dsh_tm_worksbtn',
                    'data-action': 'mark-blocked',
                    disabled: busyForWrite,
                    onClick: function () {
                      confirmPatch(card.id, { state: card.state === 'blocked' ? 'active' : 'blocked', reviewStatus: 'reviewed' },
                        card.state === 'blocked' ? '已恢复进行中' : '已标为卡住')
                    },
                  }, card.state === 'blocked' ? '解除卡住' : '标为卡住')
                : null,
              h('button', {
                type: 'button',
                className: 'dsh_tm_worksbtn dsh_tm_worksbtn_danger',
                'data-action': 'dismiss-work',
                disabled: busyForWrite,
                onClick: function () { dismissAsChat(card.id) },
              }, '不算事（退回话题）')))
        }

        var isReviewCard = reviewMode && !isSettled && card.reviewStatus === 'pending'
        var actionButtons = isSettled
          ? [
              h('button', {
                key: 'reopen', type: 'button',
                className: 'dsh_tm_worksbtn dsh_tm_worksbtn_primary',
                'data-action': 'reopen',
                disabled: busyForWrite,
                onClick: function () { confirmPatch(card.id, { state: 'active', reviewStatus: 'reviewed' }, '已重新打开「' + card.title + '」') },
              }, '重新打开'),
              h('button', {
                key: 'detail', type: 'button',
                className: 'dsh_tm_worksbtn',
                'data-action': 'expand',
                'aria-expanded': expanded ? 'true' : 'false',
                onClick: function () { toggleExpand(card.id) },
              }, expanded ? '收起' : '详情'),
            ]
          : (isReviewCard
            ? [
                h('button', {
                  key: 'review-keep', type: 'button',
                  className: 'dsh_tm_worksbtn dsh_tm_worksbtn_primary',
                  'data-action': 'review-keep',
                  title: '确认这件事仍在推进中，并锁定状态防止后台推断覆盖',
                  disabled: busyForWrite,
                  onClick: function () {
                    confirmPatch(card.id, { state: card.state, reviewStatus: 'reviewed' }, '已确认保留「' + card.title + '」', true)
                  },
                }, '✓ 确认还在做'),
                h('button', {
                  key: 'review-done', type: 'button',
                  className: 'dsh_tm_worksbtn',
                  'data-action': 'review-done',
                  title: '这件事早就做完了，移入底部已收束区',
                  disabled: busyForWrite,
                  onClick: function () {
                    confirmPatch(card.id, { state: 'done', reviewStatus: 'reviewed' }, '已标记完成「' + card.title + '」', true)
                  },
                }, '✓ 已完成'),
                h('button', {
                  key: 'review-dismiss', type: 'button',
                  className: 'dsh_tm_worksbtn dsh_tm_worksbtn_danger',
                  'data-action': 'review-dismiss',
                  title: '只是日常讨论或系统误拆，退回历史话题不再在续接页提醒',
                  disabled: busyForWrite,
                  onClick: function () { dismissAsChat(card.id, true) },
                }, '不算事'),
                h('button', {
                  key: 'detail', type: 'button',
                  className: 'dsh_tm_worksbtn dsh_tm_worksbtn_ghost',
                  'data-action': 'expand',
                  'aria-expanded': expanded ? 'true' : 'false',
                  onClick: function () { toggleExpand(card.id) },
                }, expanded ? '收起' : '详情'),
              ]
            : [
                h('button', {
                  key: 'resume', type: 'button',
                  className: 'dsh_tm_worksbtn dsh_tm_worksbtn_primary',
                  'data-action': 'resume',
                  // 交接的一种形态：只读区仍可用（ADR-0011 唯一例外）。
                  disabled: isBusy,
                  onClick: function () { handleSameSessionResume(card) },
                }, '回到现场'),
                h('button', {
                  key: 'handoff', type: 'button',
                  className: 'dsh_tm_worksbtn',
                  'data-action': 'handoff',
                  // 交接：只读区仍可用（ADR-0011 唯一例外）。
                  disabled: isBusy,
                  onClick: function () { handleNewSessionHandoff(card) },
                }, '新会话交接'),
                h('button', {
                  key: 'merge', type: 'button',
                  className: 'dsh_tm_worksbtn',
                  'data-action': 'merge-work',
                  title: readonly
                    ? '跨工作区只读：合并会改那个工作区的事，请切回本工作区'
                    : '把这件事并进另一件事（合并后只留一条）',
                  'aria-expanded': mergePickId === card.id ? 'true' : 'false',
                  disabled: busyForWrite,
                  onClick: function () { setMergePickId(mergePickId === card.id ? '' : card.id) },
                }, mergePickId === card.id ? '取消合并' : '合并'),
                card.segmentCount >= 2
                  ? h('button', {
                      key: 'split', type: 'button',
                      className: 'dsh_tm_worksbtn',
                      'data-action': 'split-work',
                      title: readonly
                        ? '跨工作区只读：拆段会改那个工作区的事，请切回本工作区'
                        : '把其中一段拆成独立的一件事',
                      'aria-expanded': splitPickId === card.id ? 'true' : 'false',
                      disabled: busyForWrite,
                      onClick: function () { setSplitPickId(splitPickId === card.id ? '' : card.id) },
                    }, splitPickId === card.id ? '取消拆段' : '拆段')
                  : null,
                h('button', {
                  key: 'done', type: 'button',
                  className: 'dsh_tm_worksbtn',
                  'data-action': 'confirm-done',
                  disabled: busyForWrite,
                  onClick: function () { confirmPatch(card.id, { state: 'done', reviewStatus: 'reviewed' }, '已完成「' + card.title + '」') },
                }, '✓ 已完成'),
                h('button', {
                  key: 'detail', type: 'button',
                  className: 'dsh_tm_worksbtn dsh_tm_worksbtn_ghost',
                  'data-action': 'expand',
                  'aria-expanded': expanded ? 'true' : 'false',
                  onClick: function () { toggleExpand(card.id) },
                }, expanded ? '收起' : '详情'),
              ])

        return h('article', {
          key: card.id,
          className: 'dsh_tm_workcard',
          'data-work-id': card.id,
          'data-state': card.state,
          'data-confidence': card.confidenceBadge.confidence,
          'data-pinned': card.pinned ? '1' : '0',
          'data-reviewing': isReviewCard ? '1' : '0',
        },
          // 第 1 行：标题 + 状态徽标 + 推测(虚线)/已确认(实线)标识 + 相对时间 + 置顶星标
          h('div', { className: 'dsh_tm_workrow1' },
            h('span', { className: 'dsh_tm_worktitle', title: card.title }, card.title),
            h('span', { className: 'dsh_tm_workbadge', 'data-state': card.state }, card.stateBadge.label),
            h('span', {
              className: 'dsh_tm_workconf',
              'data-style': card.confidenceBadge.style,
              title: card.confidenceBadge.confirmed ? '人工已确认，系统不会覆盖' : '系统自动推测，确认后锁定',
            }, card.confidenceBadge.label),
            card.timeLabel !== '' ? h('span', { className: 'dsh_tm_worktime' }, card.timeLabel) : null,
            h('button', {
              type: 'button',
              className: 'dsh_tm_workpin',
              'data-pinned': card.pinned ? '1' : '0',
              title: card.pinned ? '取消置顶' : '置顶（不自动沉降）',
              'aria-label': card.pinned ? '取消置顶' : '置顶',
              disabled: busyForWrite,
              onClick: function () {
                confirmPatch(card.id, { pinned: !card.pinned, reviewStatus: 'reviewed' }, card.pinned ? '已取消置顶' : '已置顶')
              },
            }, card.pinned ? '★' : '☆')),
          // 第 2 行：现状 / 卡点（单行）
          h('div', { className: 'dsh_tm_workrow2', title: card.statusFull || card.statusLine }, card.statusLine),
          // 第 3 行：高亮下一步
          h('div', {
            className: 'dsh_tm_workrow3',
            'data-empty': card.hasNextStep ? '0' : '1',
            title: card.nextStepLine,
          }, card.nextStepLine),
          // 第 4 行：主动作条
          h('div', { className: 'dsh_tm_workrow4' }, actionButtons),
          // 合并选择器：列出同区其它未收束的事，点谁就并进谁。
          mergePickId === card.id
            ? h('div', { className: 'dsh_tm_workpick', 'data-pick': 'merge' },
                h('div', { className: 'dsh_tm_workpickhead' }, '合并到哪一件？'),
                board === null ? null : board.cards
                  .filter(function (other) { return other && other.id !== card.id })
                  .map(function (other) {
                    return h('button', {
                      key: other.id,
                      type: 'button',
                      className: 'dsh_tm_worksbtn dsh_tm_workpickitem',
                      'data-action': 'merge-target',
                      'data-work-id': other.id,
                      disabled: busyForWrite,
                      title: '把「' + card.title + '」并进「' + other.title + '」',
                      onClick: function () { runMergeWorks(card.id, other.id) },
                    }, other.title)
                  }))
            : null,
          // 拆段选择器：列出这件事包含的每一段，点谁就把谁拆出去。
          splitPickId === card.id
            ? h('div', { className: 'dsh_tm_workpick', 'data-pick': 'split' },
                h('div', { className: 'dsh_tm_workpickhead' }, '把哪一段拆出去？'),
                (Array.isArray(card.segments) ? card.segments : []).map(function (seg) {
                  var sid = String(seg && seg.id ? seg.id : '')
                  var label = String((seg && (seg.title || seg.summary)) || sid.slice(0, 12))
                  return h('button', {
                    key: sid,
                    type: 'button',
                    className: 'dsh_tm_worksbtn dsh_tm_workpickitem',
                    'data-action': 'split-segment',
                    'data-segment-id': sid,
                    disabled: busyForWrite,
                    onClick: function () { runSplitWork(card.id, sid) },
                  }, label)
                }))
            : null,
          detailNode)
      }

      var contentNodes = []
      if (state.status === 'loading' && board === null) {
        contentNodes.push(h('div', { key: 'loading', className: 'dsh_tm_worksempty' },
          h('div', { className: 'dsh_tm_worksemptytitle' }, '正在读取续接清单…')))
      } else if (state.status === 'error' && board === null) {
        contentNodes.push(h('div', { key: 'error', className: 'dsh_tm_worksempty', role: 'alert' },
          h('div', { className: 'dsh_tm_worksemptytitle' }, '续接清单读取失败'),
          h('div', { className: 'dsh_tm_worksemptydesc' }, state.error),
          h('button', {
            type: 'button', className: 'dsh_tm_worksbtn dsh_tm_worksbtn_primary', 'data-action': 'retry',
            onClick: function () { loadWorks(false) },
          }, '重试')))
      } else if (board !== null) {
        // 0) 只读巡检说明条（ADR-0011）：卡片上的写按钮会整片变灰，
        // 必须有就近解释，否则用户第一眼会以为功能坏了，而不是「我在别人的区」。
        if (readonly) {
          contentNodes.push(h('div', {
            key: 'readonly',
            className: 'dsh_tm_worksbanner dsh_tm_worksbanner_readonly',
            'data-banner': 'readonly',
            role: 'status',
          },
            h('div', { className: 'dsh_tm_worksbannermsg' }, '只读巡检：你正在看别的工作区'),
            h('div', { className: 'dsh_tm_worksbannerdesc' },
              '可以查看卡片、详情、决策与统计，也可以用「回到现场」「新会话交接」把自己带过去；'
              + '其余修改（确认、改下一步、置顶、不算事、合并、重扫、重提炼）需要先切回本工作区。')))
        }

        // 0.1) 后台模型深度提炼中状态条
        if (isRefining) {
          contentNodes.push(h('div', {
            key: 'refining',
            className: 'dsh_tm_worksbanner dsh_tm_worksbanner_refining',
            'data-banner': 'refining',
            role: 'status',
          },
            h('div', { className: 'dsh_tm_worksbannermsg' }, '正在用模型深度归并提炼中…'),
            h('div', { className: 'dsh_tm_worksbannerdesc' }, '当前先展示规则盘点结果，提炼完成后将自动刷新列表，期间可照常操作。')))
        }

        // 1) 待核对横幅（含核对说明条与一键全部确认无误）
        if (board.pendingReviewBanner !== null) {
          var prb = board.pendingReviewBanner
          var exitLabel = prb.exitAction && prb.exitAction.label ? prb.exitAction.label : '退出核对'
          var confirmAllLabel = prb.confirmAllAction && prb.confirmAllAction.label ? prb.confirmAllAction.label : '全部确认无误'
          contentNodes.push(h('div', {
            key: 'pending-review',
            className: 'dsh_tm_worksbanner' + (reviewMode ? ' dsh_tm_worksbanner_review' : ''),
            'data-banner': 'pending-review',
            'data-review-mode': reviewMode ? '1' : '0',
          },
            h('div', { className: 'dsh_tm_worksbannermsg' },
              reviewMode
                ? ('核对模式：剩余 ' + prb.count + ' 件未收束的事待确认')
                : prb.message),
            reviewMode
              ? h('div', { className: 'dsh_tm_worksbannerdesc', 'data-review-guide': '1' },
                  '逐条确认系统自动推测出的未收束工作是否准确：点「✓ 确认还在做」锁定保留，点「✓ 已完成」归入已收束，点「不算事」退回历史话题；确认后不会被后台覆盖。')
              : null,
            h('div', { className: 'dsh_tm_worksbanneracts' },
              h('button', {
                type: 'button',
                className: 'dsh_tm_worksbtn' + (reviewMode ? '' : ' dsh_tm_worksbtn_primary'),
                'data-action': 'open-review',
                title: readonly
                  ? '跨工作区只读：核对模式只用于批量确认写操作，请切回本工作区再核对'
                  : (reviewMode
                    ? '退出核对模式，返回正常续接视图'
                    : '逐条核对系统自动推测的未收束工作，确认后锁定不再被覆盖'),
                // 只读区不进核对模式：进去之后每张卡都是写动作，纯死路（ADR-0011）。
                disabled: readonly,
                onClick: function () { setReviewMode(function (v) { return !v }) },
              }, reviewMode ? exitLabel : prb.action.label),
              h('button', {
                type: 'button',
                className: 'dsh_tm_worksbtn' + (reviewMode ? ' dsh_tm_worksbtn_primary' : ''),
                'data-action': 'confirm-all-review',
                title: readonly
                  ? '跨工作区只读：切回本工作区后才能批量确认'
                  : '一键确认并锁定当前所有待核对的未收束工作',
                disabled: busyId !== '' || readonly,
                onClick: function () { confirmAllPending() },
              }, busyId === '__all__' ? '确认中…' : confirmAllLabel))))
        }

        // 2) 重开老事轻提示条
        for (var rIdx = 0; rIdx < visibleReopenBanners.length; rIdx += 1) {
          ;(function (rb, idx) {
            contentNodes.push(h('div', {
              key: 'reopen-' + (rb.workId || idx),
              className: 'dsh_tm_worksbanner dsh_tm_worksbanner_reopen',
              'data-banner': 'reopen',
            },
              h('div', { className: 'dsh_tm_worksbannermsg' }, rb.message),
              h('div', { className: 'dsh_tm_worksbanneracts' },
                rb.actions.map(function (act) {
                  return h('button', {
                    key: act.id,
                    type: 'button',
                    className: 'dsh_tm_worksbtn' + (act.kind === 'primary' ? ' dsh_tm_worksbtn_primary' : ''),
                    'data-reopen-action': act.id,
                    onClick: function () { handleReopenAction(rb, act.id) },
                  }, act.label)
                }))))
          })(visibleReopenBanners[rIdx], rIdx)
        }

        // 3) 非阻塞拐点轻确认条
        if (board.inflectionBanner !== null) {
          var ib = board.inflectionBanner
          contentNodes.push(h('div', {
            key: 'inflection',
            className: 'dsh_tm_worksbanner dsh_tm_worksbanner_inflection',
            'data-banner': 'inflection',
            'data-inflection-kind': ib.kind,
          },
            h('div', { className: 'dsh_tm_worksbannermsg' }, ib.message),
            h('div', { className: 'dsh_tm_worksbanneracts' },
              ib.actions.map(function (act) {
                var cls = 'dsh_tm_worksbtn'
                if (act.kind === 'primary') cls += ' dsh_tm_worksbtn_primary'
                else if (act.kind === 'ghost') cls += ' dsh_tm_worksbtn_ghost'
                return h('button', {
                  key: act.id,
                  type: 'button',
                  className: cls,
                  'data-inflection-action': act.id,
                  onClick: function () { handleInflectionAction(ib, act) },
                }, act.label)
              }))))
        }

        // 4) 未收束卡片列表或空态
        var displayCards = reviewMode
          ? board.cards.filter(function (c) { return c.reviewStatus === 'pending' })
          : board.cards
        if (board.cards.length === 0 && board.empty !== null) {
          contentNodes.push(h('div', {
            key: 'empty',
            className: 'dsh_tm_worksempty',
            'data-empty-kind': board.empty.kind,
          },
            h('div', { className: 'dsh_tm_worksemptytitle' }, board.empty.title),
            h('div', { className: 'dsh_tm_worksemptydesc' }, board.empty.description),
            h('button', {
              type: 'button',
              className: 'dsh_tm_worksbtn dsh_tm_worksbtn_primary',
              'data-action': 'open-history',
              onClick: function () {
                if (typeof openTab === 'function') openTab(HISTORY_KIND)
              },
            }, board.empty.action.label)))
        } else {
          contentNodes.push(h('div', { key: 'cards', className: 'dsh_tm_workslist' },
            displayCards.map(function (c) { return renderCard(c, false) })))
        }

        // 5) 底部折叠区：已收束（N）
        if (board.settledSection.count > 0) {
          contentNodes.push(h('div', { key: 'settled', className: 'dsh_tm_worksettled' },
            h('button', {
              type: 'button',
              className: 'dsh_tm_worksettledtoggle',
              'data-action': 'toggle-settled',
              'aria-expanded': showSettled ? 'true' : 'false',
              onClick: function () { setShowSettled(function (v) { return !v }) },
            },
              h('span', null, board.settledSection.label),
              h('span', null, showSettled ? '▾' : '▸')),
            showSettled
              ? h('div', { className: 'dsh_tm_workslist' },
                  board.settledSection.visibleCards.map(function (c) { return renderCard(c, true) }))
              : null))
        }
      }

      // 提炼状态条（ADR-0010）：必须让用户看见「已深度提炼」还是「仅基础规则」，
      // 后者要给出具体原因并提供一键重试，绝不静默降级。
      var refineRaw = state.raw !== null && state.raw !== undefined ? state.raw.refineStatus : null
      var refineReason = refineRaw && typeof refineRaw.reason === 'string' ? refineRaw.reason : ''
      var refineUsed = refineRaw !== null && refineRaw !== undefined && refineRaw.used === true
      var refineBar = null
      if (state.raw !== null && state.raw !== undefined) {
        if (refineUsed) {
          refineBar = h('div', { className: 'dsh_tm_worksrefine', 'data-state': 'ok' },
            h('span', null, '已深度提炼：标题、现状、下一步与决策来自模型'))
        } else {
          var refineDetail = refineRaw && typeof refineRaw.detail === 'string' ? refineRaw.detail.trim() : ''
          refineBar = h('div', {
            className: 'dsh_tm_worksrefine',
            'data-state': 'rule',
            title: refineDetail !== '' ? refineDetail : '语义提炼没有成功，卡片内容来自硬规则',
          },
            h('span', { className: 'dsh_tm_worksrefinetext' },
              '仅基础规则：' + refineReasonText(refineReason)
              + (refineDetail !== '' ? '（' + refineDetail + '）' : '')),
            h('button', {
              type: 'button',
              className: 'dsh_tm_worksbtn dsh_tm_worksbtn_ghost',
              'data-action': 'works-refine-retry',
              title: readonly
                ? '跨工作区只读：重提炼会改那个工作区的标题/现状/下一步，请切回本区'
                : '再试一次语义提炼（会真的调用模型）',
              disabled: scanning || readonly,
              onClick: function () { runRefineRetry() },
            }, scanning ? '重试中…' : '重试提炼'))
        }
      }

      return h('div', { className: 'dsh_tm_works' },
        props !== null && props !== undefined && props.hideTabStrip === true ? null : h(RightTabStrip, {
          active: WORKS_KIND,
          open: openTab || undefined,
        }),
        h('div', { className: 'dsh_tm_workshead' },
          h('span', { className: 'dsh_tm_workstitle' }, WORKS_TITLE),
          board !== null
            ? h('span', { className: 'dsh_tm_workscount' }, '未收束 ' + board.cards.length)
            : null,

          h('span', { className: 'dsh_tm_worksgrow' }),
          h('button', {
            type: 'button',
            className: 'dsh_tm_worksbtn',
            'data-action': 'works-scan',
            title: '立即按硬规则重新盘点本工作区会话（不覆盖已确认锁定的事），并在后台异步用模型深度提炼',
            disabled: scanning || readonly,
            title: readonly
              ? '跨工作区只读：切回本工作区或打开其中一个会话后才能重新盘点'
              : '立即按硬规则重新盘点本工作区会话（不覆盖已确认锁定的事），并在后台异步用模型深度提炼',
            onClick: function () { runManualScan() },
          }, scanning ? '盘点中…' : '重新盘点')),
        refineBar,
        notice !== null
          ? h('div', { className: 'dsh_tm_worksnotice', 'data-tone': notice.tone, role: 'status' },
              h('span', null, notice.text),
              h('button', {
                type: 'button', className: 'dsh_tm_worksbtn dsh_tm_worksbtn_ghost',
                onClick: function () { setNotice(null) },
              }, '×'))
          : null,
        contentNodes)
    }

    // ── 设置 tab ─────────────────────────────────────────────────────
    function SettingsTabBody(props) {
      useTopicMapTheme()
      var boundSessionId = props === null || props === undefined ? null : props.sessionId
      var configState = useState(null)
      var config = configState[0]; var setConfig = configState[1]
      var draftState = useState({})
      var draft = draftState[0]; var setDraft = draftState[1]
      var rawState = useState({})
      var raw = rawState[0]; var setRaw = rawState[1]
      var errorState = useState({})
      var errors = errorState[0]; var setErrors = errorState[1]
      var loadState = useState('loading')
      var loadStatus = loadState[0]; var setLoadStatus = loadState[1]
      var saveState = useState(false)
      var saving = saveState[0]; var setSaving = saveState[1]
      var noticeState = useState(null)
      var notice = noticeState[0]; var setNotice = noticeState[1]
      var rebuildState = useState(null)
      var rebuild = rebuildState[0]; var setRebuild = rebuildState[1]
      var indexStatsState = useState({ status: 'idle', value: null, error: '' })
      var indexStats = indexStatsState[0]; var setIndexStats = indexStatsState[1]
      var railRevState = useState(0)
      var railRev = railRevState[0]; var setRailRev = railRevState[1]
      var pageSizeState = useState(HISTORY_PAGE_SIZE_DEFAULT)
      var settingsPageSize = pageSizeState[0]; var setSettingsPageSize = pageSizeState[1]
      var pageSizeWorkspaceRef = useRef('')

      useEffect(function () {
        currentWorkspaceId(boundSessionId).then(function (workspaceId) {
          pageSizeWorkspaceRef.current = workspaceId
          setSettingsPageSize(readHistoryPageSize(workspaceId))
        })
      }, [boundSessionId])

      // 轨道偏好在 localStorage；rail 菜单 / 设置 tab / 折叠条都会改它。
      useEffect(function () {
        if (typeof RAILTAKE === 'undefined' || RAILTAKE === null) return undefined
        return RAILTAKE.subscribe(function () { setRailRev(function (value) { return value + 1 }) })
      }, [])

      function resetFromConfig(value) {
        var next = value !== null && typeof value === 'object' ? value : {}
        setConfig(next)
        setDraft(next)
        setRaw({})
        setErrors({})
      }

      /** 读 Host 的索引体积统计（POST /index-stats）；失败只影响这一行。 */
      function loadIndexStats() {
        setIndexStats(function (prev) {
          return { status: 'loading', value: prev === null || prev === undefined ? null : prev.value, error: '' }
        })
        currentWorkspaceId(boundSessionId).then(function (workspaceId) {
          var body = workspaceId === '' ? {} : { workspaceId: workspaceId }
          return requestTopicMap('index-stats', body)
        }).then(function (result) {
          if (result.ok === true) {
            setIndexStats({ status: 'ready', value: result.value, error: '' })
          } else {
            setIndexStats({ status: 'error', value: null, error: result.error })
          }
        })
      }

      function loadSettings() {
        setLoadStatus('loading')
        requestTopicMap('config', null, { method: 'GET' }).then(function (result) {
          if (result.ok === true) {
            resetFromConfig(result.value)
            setLoadStatus('ready')
          } else {
            resetFromConfig({})
            setLoadStatus('ready')
            setNotice({ tone: 'error', text: '读取配置失败：' + result.error + '（可继续修改后保存）' })
          }
        })
        loadIndexStats()
      }

      useEffect(function () {
        loadSettings()
      }, [boundSessionId])

      function changeSetting(key, value) {
        setRaw(function (prev) {
          var next = {}
          for (var name in prev) next[name] = prev[name]
          next[key] = value
          return next
        })
        var applied = SETTINGVIEW.applySetting(draft, key, value)
        if (applied.error !== undefined) {
          setErrors(function (prev) {
            var next = {}
            for (var name in prev) next[name] = prev[name]
            next[key] = applied.error
            return next
          })
          return
        }
        setErrors(function (prev) {
          var next = {}
          for (var name in prev) {
            if (name !== key) next[name] = prev[name]
          }
          return next
        })
        setDraft(applied.config)
      }

      function saveSettings() {
        if (saving) return
        if (Object.keys(errors).length > 0) {
          setNotice({ tone: 'error', text: '有字段未通过校验，请先修正再保存' })
          return
        }
        var changes = SETTINGVIEW.diffConfig(config === null ? {} : config, draft)
        // railNative 走 localStorage，永远不进 Host 配置。
        delete changes.railNative
        if (Object.keys(changes).length === 0) {
          setNotice({ tone: 'info', text: '没有需要保存的改动' })
          return
        }
        setSaving(true)
        requestTopicMap('config', changes).then(function (result) {
          setSaving(false)
          if (result.ok !== true) {
            setNotice({ tone: 'error', text: '保存失败：' + result.error })
            return
          }
          resetFromConfig(result.value)
          setNotice({ tone: 'ok', text: '已保存' })
        })
      }

      function restoreDefaults() {
        var defaults = settingsDefaultValues()
        var next = {}
        for (var key in draft) next[key] = draft[key]
        for (var name in defaults) next[name] = defaults[name]
        setDraft(next)
        setRaw({})
        setErrors({})
        setNotice({ tone: 'info', text: '已恢复默认值，点保存后写入' })
        if (typeof RAILTAKE !== 'undefined' && RAILTAKE !== null) {
          RAILTAKE.setNativePreferred(false)
          RAILTAKE.setAutoHide(true)
          RAILTAKE.setTier(RAIL_TIER_STD)
        }
      }

      function rebuildIndex() {
        if (rebuild !== null && rebuild.status === 'running') return
        setRebuild({ status: 'running', text: '正在排队重建索引…' })
        currentWorkspaceId(boundSessionId).then(function (workspaceId) {
          if (workspaceId === '') {
            setRebuild({ status: 'error', text: '没有找到当前会话所属的工作区' })
            return
          }
          requestTopicMap('workspace-reindex', { workspaceId: workspaceId }).then(function (result) {
            if (result.ok !== true) {
              setRebuild({ status: 'error', text: '重建索引失败：' + result.error })
              return
            }
            var queued = result.value !== null && typeof result.value === 'object'
              ? Number(result.value.queued) : 0
            setRebuild({
              status: 'done',
              text: Number.isFinite(queued) && queued > 0
                ? '已排队 ' + queued + ' 个会话'
                : '没有需要重建的会话',
            })
            // 后台队列刚排进去，体积统计可能还是旧值；再读一次。
            loadIndexStats()
          })
        })
      }

      var model = SETTINGVIEW.settingsModel(draft)
      var groups = {}
      for (var gi = 0; gi < model.groups.length; gi += 1) groups[model.groups[gi].id] = model.groups[gi]
      var prefs = railPrefsSnapshot()

      function itemValue(item) {
        var hasRaw = Object.prototype.hasOwnProperty.call(raw, item.key)
        return hasRaw ? raw[item.key] : item.value
      }

      function errorNode(item) {
        return errors[item.key] === undefined
          ? null
          : h('div', { className: 'dsh_tm_seterr', role: 'alert' }, errors[item.key])
      }

      function numberRow(item, withRange) {
        var value = itemValue(item)
        return h('label', { className: 'dsh_tm_setrow', key: item.key },
          h('span', { className: 'dsh_tm_setlabel' }, item.label),
          h('input', {
            className: 'dsh_tm_setinput', type: 'number',
            'data-setting': item.key,
            min: item.min, max: item.max,
            value: value,
            onChange: function (event) { changeSetting(item.key, event.target.value) },
          }),
          withRange
            ? h('input', {
                className: 'dsh_tm_setrange', type: 'range',
                'data-setting-range': item.key,
                min: item.min, max: item.max,
                value: Number(value),
                onChange: function (event) { changeSetting(item.key, event.target.value) },
                'aria-label': item.label,
              })
            : null,
          h('span', { className: 'dsh_tm_sethelp' }, item.help),
          errorNode(item))
      }

      function renderGroup(group) {
        if (group === undefined) return null
        var rows = []
        for (var i = 0; i < group.items.length; i += 1) {
          // 这里必须用 let：分段控件的 onClick 闭包要捕获当次 item，
          // 用 var 会全部指向最后一个字段（点「详尽」却改了引用字数）。
          let item = group.items[i]
          if (item.type === 'button') continue
          if (item.type === 'select' && item.key === 'digestLevel') {
            rows.push(h('div', { className: 'dsh_tm_setrow', key: item.key },
              h('span', { className: 'dsh_tm_setlabel' }, item.label),
              h('div', { className: 'dsh_tm_setseg', role: 'group', 'aria-label': item.label },
                item.options.map(function (option) {
                  var on = item.value === option.value
                  return h('button', {
                    key: option.value, type: 'button',
                    className: 'dsh_tm_setsegbtn' + (on ? ' dsh_tm_setsegbtn_on' : ''),
                    'data-setting': item.key,
                    'data-value': option.value,
                    'aria-pressed': on ? 'true' : 'false',
                    onClick: function () { changeSetting(item.key, option.value) },
                  }, option.label)
                })),
              h('span', { className: 'dsh_tm_sethelp' }, item.help),
              errorNode(item)))
          } else if (item.type === 'number') {
            rows.push(numberRow(item, item.key === 'quoteMaxCount'))
          } else if (item.type === 'readonly') {
            rows.push(h('div', { className: 'dsh_tm_setrow', key: item.key },
              h('span', { className: 'dsh_tm_setlabel' }, item.label),
              h('span', { className: 'dsh_tm_setreadonly' }, String(item.value)),
              h('span', { className: 'dsh_tm_sethelp' }, item.help)))
          }
        }
        return h('div', { className: 'dsh_tm_setgroup', key: group.id },
          h('div', { className: 'dsh_tm_setgrouptitle' }, group.title),
          rows)
      }

      var bodyChildren = []
      if (loadStatus !== 'ready') {
        bodyChildren.push(h('div', { className: 'dsh_tm_setstatus', key: 'loading' }, '正在读取配置…'))
      } else {
        bodyChildren.push(renderGroup(groups.quote))
        bodyChildren.push(h('div', { className: 'dsh_tm_setnote', key: 'quote-note' },
          '超过配额的部分不会展开，并在注入块末尾注明'))
        // 索引：轮次上限 + 重建按钮 + 只读索引状态。
        var indexItems = groups.index === undefined ? [] : groups.index.items
        var turnLimitItem = null
        for (var ii = 0; ii < indexItems.length; ii += 1) {
          if (indexItems[ii].key === 'turnLimit') turnLimitItem = indexItems[ii]
        }
        function renderIndexStats() {
          if (indexStats.status === 'error') {
            return h('span', {
              className: 'dsh_tm_setindextext',
              'data-tone': 'error',
              'data-setting': 'indexStats',
              title: '索引统计失败：' + (indexStats.error === '' ? '未知原因' : indexStats.error),
            }, '—')
          }
          if (indexStats.status === 'loading' && (indexStats.value === null || indexStats.value === undefined)) {
            return h('span', {
              className: 'dsh_tm_setindextext',
              'data-setting': 'indexStats',
              title: '正在读取索引统计',
            }, '统计中…')
          }
          return h('span', {
            className: 'dsh_tm_setindextext',
            'data-setting': 'indexStats',
            title: indexStatsTitle(indexStats.value),
          }, indexStatsText(indexStats.value))
        }
        bodyChildren.push(h('div', { className: 'dsh_tm_setgroup', key: 'index' },
          h('div', { className: 'dsh_tm_setgrouptitle' }, '索引'),
          turnLimitItem === null ? null : numberRow(turnLimitItem, false),
          h('div', { className: 'dsh_tm_setrow dsh_tm_setindexrow' },
            h('button', {
              type: 'button', className: 'dsh_tm_setbutton', 'data-action': 'rebuild',
              disabled: rebuild !== null && rebuild.status === 'running',
              onClick: function () { rebuildIndex() },
            }, '重建当前工作区索引'),
            renderIndexStats(),
            rebuild === null
              ? null
              : h('span', {
                  className: 'dsh_tm_setstatus',
                  'data-tone': rebuild.status === 'error' ? 'error' : rebuild.status === 'done' ? 'ok' : 'info',
                }, rebuild.text))))
        // 界面：轨道三个开关/状态（localStorage，不进 Host 配置）。
        bodyChildren.push(h('div', { className: 'dsh_tm_setgroup', key: 'ui' },
          h('div', { className: 'dsh_tm_setgrouptitle' }, '界面'),
          h('label', { className: 'dsh_tm_setrow' },
            h('input', {
              type: 'checkbox',
              'data-setting': 'railNative',
              checked: prefs.native,
              onChange: function (event) {
                if (typeof RAILTAKE !== 'undefined' && RAILTAKE !== null) {
                  RAILTAKE.setNativePreferred(event.target.checked === true)
                }
              },
            }),
            h('span', { className: 'dsh_tm_setlabel' }, '恢复原生导航轨')),
          h('label', { className: 'dsh_tm_setrow' },
            h('input', {
              type: 'checkbox',
              'data-setting': 'railAutoHide',
              checked: prefs.autoHide,
              'data-rail-rev': String(railRev),
              onChange: function (event) {
                if (typeof RAILTAKE !== 'undefined' && RAILTAKE !== null) {
                  RAILTAKE.setAutoHide(event.target.checked === true)
                }
              },
            }),
            h('span', { className: 'dsh_tm_setlabel' }, '自动隐藏导航轨')),
          h('div', { className: 'dsh_tm_setrow' },
            h('span', { className: 'dsh_tm_setlabel' }, '轨道显示档位'),
            h('div', { className: 'dsh_tm_setseg', role: 'group', 'aria-label': '轨道显示档位' },
              [RAIL_TIER_MIN, RAIL_TIER_STD, RAIL_TIER_MAX].map(function (value) {
                return h('button', {
                  key: value,
                  type: 'button',
                  className: 'dsh_tm_setsegbtn' + (prefs.tier === value ? ' dsh_tm_setsegbtn_on' : ''),
                  'data-setting': 'railTier',
                  'data-tier': value,
                  'aria-pressed': prefs.tier === value ? 'true' : 'false',
                  onClick: function () {
                    if (typeof RAILTAKE !== 'undefined' && RAILTAKE !== null) RAILTAKE.setTier(value)
                  },
                }, railTierText(value))
              }))),
          h('div', { className: 'dsh_tm_setrow' },
            h('span', { className: 'dsh_tm_setlabel' }, '历史每页条数'),
            h('div', { className: 'dsh_tm_setseg', role: 'group', 'aria-label': '历史每页条数' },
              HISTORY_PAGE_SIZE_OPTIONS.map(function (value) {
                return h('button', {
                  key: 'page-' + value,
                  type: 'button',
                  className: 'dsh_tm_setsegbtn' + (settingsPageSize === value ? ' dsh_tm_setsegbtn_on' : ''),
                  'data-setting': 'historyPageSize',
                  'data-size': String(value),
                  'aria-pressed': settingsPageSize === value ? 'true' : 'false',
                  onClick: function () {
                    setSettingsPageSize(saveHistoryPageSize(pageSizeWorkspaceRef.current, value))
                  },
                }, String(value))
              })))))
        // 模型：只读展示（apiKey 只显示是否设置）。
        bodyChildren.push(renderGroup(groups.model))
      }

      bodyChildren.push(h('div', { className: 'dsh_tm_setactions', key: 'actions' },
        h('button', {
          type: 'button', className: 'dsh_tm_setsave', 'data-action': 'save',
          disabled: saving || loadStatus !== 'ready',
          onClick: function () { saveSettings() },
        }, saving ? '保存中…' : '保存'),
        h('button', {
          type: 'button', className: 'dsh_tm_setdefault', 'data-action': 'default',
          disabled: saving || loadStatus !== 'ready',
          onClick: function () { restoreDefaults() },
        }, '恢复默认')))

      return h('div', { className: 'dsh_tm_settings' },
        props !== null && props !== undefined && props.hideTabStrip === true ? null : h(RightTabStrip, {
          active: SETTINGS_KIND,
          open: props === null || props === undefined ? undefined : props.openTab,
        }),
        h('div', { className: 'dsh_tm_sethead' },
          h('div', { className: 'dsh_tm_settitle' }, SETTINGS_TITLE)),
        notice === null || notice === undefined
          ? null
          : h('div', {
              className: 'dsh_tm_setnotice',
              'data-tone': notice.tone,
              role: 'status',
            }, notice.text),
        h('div', { className: 'dsh_tm_setbody' }, bodyChildren))
    }

    // ── 历史页分类树 / 时间线 / 变更与回滚预演 ───────────────────────
    //
    // 三块都只读或只写本插件自己的元数据：
    //   - 分类：人工优先。所有写操作必须经过 /category-*，成功后重新读
    //     /categories 局部刷新，绝不在客户端猜 Host 的计数与排序口径。
    //   - 线索：/search 的命中行交给 buildClue 排成时间线，只读。
    //   - 变更 / 回滚预演：/rollback-plan 只出计划，不写任何文件。
    //
    // 端点未就绪或失败时一律显示 Host 的中文 error，不白屏、不吞错。

    /** 「未归类」根节点的固定 id（不是分类 id，不参与任何写操作）。 */
    var CATEGORY_ROOT_ID = 'root'
    var CATEGORY_ROOT_NAME = '未归类'
    /** 历史页分类树的「全部」节点（不是分类 id）。 */
    var CATEGORY_ALL_ID = '__all__'
    var CATEGORY_ALL_NAME = '全部'
    var CATEGORY_AUTO_POLL_MS = 30000
    var CATEGORY_AUTO_POLL_MAX = 4

    /** 状态/启动响应是否表示「没有可用模型」。 */
    function categoryAutoNoModel(value, error) {
      var reason = error === null || error === undefined ? '' : String(error)
      if (reason === 'no-model' || reason.indexOf('no-model') >= 0) return true
      if (value === null || value === undefined || typeof value !== 'object') return false
      if (value.noModel === true || value.modelAvailable === false) return true
      if (value.status === 'no-model' || value.state === 'no-model') return true
      if (value.reason === 'no-model' || value.code === 'no-model') return true
      return false
    }

    function categoryAutoUnclassified(value) {
      if (value === null || value === undefined || typeof value !== 'object') return null
      var count = Number(value.unclassified)
      return Number.isFinite(count) && count >= 0 ? Math.floor(count) : null
    }

    /** 胶囊行右侧的自动归类灰字；空串表示不显示。 */
    function categoryAutoText(auto) {
      if (auto === null || auto === undefined) return ''
      if (auto.status === 'no-model') return '未配置模型，无法自动归类'
      if (auto.status === 'running') {
        var count = Number(auto.unclassified)
        return Number.isFinite(count) && count > 0
          ? '正在归类 ' + Math.floor(count) + ' 个会话…'
          : '正在归类…'
      }
      return ''
    }
    /** 整理成功后「撤销」按钮的可用时长。 */
    var CLUE_EMPTY_TEXT = '输入关键词，看看这个话题在这些会话里怎么演变的'
    var CLUE_SEARCH_PLACEHOLDER = '关键词，空格分隔'
    var ROLLBACK_NOTE = '仅预演，不会修改文件'
    var ROLLBACK_STATE_ORDER = ['apply', 'same', 'modified', 'missing']
    var ROLLBACK_STATE_TEXT = {
      apply: '可回滚',
      same: '已一致',
      modified: '已被修改',
      missing: '已不存在',
    }

    /** 测试环境里 unref：撤销条 / 提示条的定时器不该拖住进程退出。 */
    function unrefTimer(timer) {
      if (timer === null || timer === undefined) return
      if (typeof timer.unref === 'function') {
        try { timer.unref() } catch (error) { /* 浏览器里是数字，没有 unref */ }
      }
    }

    /** 分类 store 归一：Host 可能回 null；assignments 兼容字符串/对象两种值。 */
    function categoryStoreOf(store) {
      var base = store !== null && store !== undefined && typeof store === 'object' ? store : {}
      var categories = []
      if (Array.isArray(base.categories)) {
        for (var i = 0; i < base.categories.length; i += 1) {
          var raw = base.categories[i]
          if (raw === null || raw === undefined || typeof raw !== 'object') continue
          var id = typeof raw.id === 'string' ? raw.id.trim() : ''
          if (id === '') continue
          var parentId = typeof raw.parentId === 'string' && raw.parentId.trim() !== ''
            ? raw.parentId.trim()
            : null
          categories.push({
            id: id,
            name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : id,
            parentId: parentId,
            source: raw.source === 'model' ? 'model' : 'user',
          })
        }
      }
      var assignments = base.assignments !== null && base.assignments !== undefined
        && typeof base.assignments === 'object' && !Array.isArray(base.assignments)
        ? base.assignments
        : {}
      return { categories: categories, assignments: assignments }
    }

    /** 一条 assignment 归一成 categoryId；非法值返回 null。 */
    function categoryIdOfAssignment(raw) {
      if (typeof raw === 'string') {
        var text = raw.trim()
        return text === '' ? null : text
      }
      if (raw === null || raw === undefined || typeof raw !== 'object') return null
      var id = typeof raw.categoryId === 'string' ? raw.categoryId.trim() : ''
      if (id === '') id = typeof raw.id === 'string' ? raw.id.trim() : ''
      return id === '' ? null : id
    }

    /** store 里的全部归类关系（只保留能解析出 categoryId 的）。 */
    function categoryAssignmentsOf(store) {
      var base = categoryStoreOf(store)
      var out = []
      var keys = Object.keys(base.assignments)
      for (var i = 0; i < keys.length; i += 1) {
        var categoryId = categoryIdOfAssignment(base.assignments[keys[i]])
        if (categoryId === null) continue
        out.push({ sessionId: keys[i], categoryId: categoryId })
      }
      return out
    }

    /** 分类名；找不到返回空串（调用方据此回退到「未归类」）。 */
    function categoryNameOf(store, id) {
      var base = categoryStoreOf(store)
      for (var i = 0; i < base.categories.length; i += 1) {
        if (base.categories[i].id === id) return base.categories[i].name
      }
      return ''
    }

    /**
     * store → 左树模型（根「未归类」+ 大类 → 子类）。
     *
     * count 只算**直接**归到该分类的会话，与 Host `toTree` 同口径：
     * 大类的数字不与子类相加，避免同一批会话被数两遍。
     * 「未归类」= 会话清单里没有有效归类的那些；会话清单缺失时退化为
     * "assignments 指向不存在分类"的条数。
     */
    function categoryTreeNodes(store, sessions) {
      var base = categoryStoreOf(store)
      var nodes = {}
      var list = []
      for (var i = 0; i < base.categories.length; i += 1) {
        var category = base.categories[i]
        var node = {
          id: category.id,
          name: category.name,
          parentId: category.parentId,
          count: 0,
          children: [],
        }
        nodes[category.id] = node
        list.push(node)
      }
      var roots = []
      for (var n = 0; n < list.length; n += 1) {
        var item = list[n]
        var parent = item.parentId === null ? null : nodes[item.parentId]
        if (parent !== undefined && parent !== null && parent !== item) parent.children.push(item)
        else roots.push(item)
      }

      var assignments = categoryAssignmentsOf(base)
      var assigned = {}
      for (var a = 0; a < assignments.length; a += 1) {
        var target = nodes[assignments[a].categoryId]
        if (target !== undefined) {
          target.count += 1
          assigned[assignments[a].sessionId] = true
        }
      }

      var rootCount = 0
      if (Array.isArray(sessions) && sessions.length > 0) {
        for (var s = 0; s < sessions.length; s += 1) {
          var session = sessions[s]
          if (session === null || session === undefined || typeof session !== 'object') continue
          var sessionId = String(session.sessionId !== undefined
            ? session.sessionId
            : (session.id !== undefined ? session.id : ''))
          if (sessionId === '' || assigned[sessionId] !== true) rootCount += 1
        }
      } else {
        for (var o = 0; o < assignments.length; o += 1) {
          if (nodes[assignments[o].categoryId] === undefined) rootCount += 1
        }
      }

      return {
        root: { id: CATEGORY_ROOT_ID, name: CATEGORY_ROOT_NAME, count: rootCount, children: [] },
        roots: roots,
      }
    }

    /**
     * 分类胶囊模型。
     *
     * 顶层胶囊按 `会话数 × 最近活动时间` 从大到小排序；count 含子孙分类，
     * 最近活动取该子树内会话的最大 lastActive。没有会话的分类 score=0。
     */
    function categoryCapsuleModel(store, sessions, lockedSessions) {
      var tree = categoryTreeNodes(store, sessions)
      var base = categoryStoreOf(store)
      var assignments = categoryAssignmentsOf(base)
      var locks = lockedSessions !== null && lockedSessions !== undefined
        && typeof lockedSessions === 'object' ? lockedSessions : {}
      var known = {}
      for (var c = 0; c < base.categories.length; c += 1) known[base.categories[c].id] = true
      var directSessions = {}
      for (var a = 0; a < assignments.length; a += 1) {
        if (known[assignments[a].categoryId] !== true) continue
        var key = assignments[a].sessionId
        if (directSessions[key] === undefined) directSessions[key] = assignments[a].categoryId
      }
      var meta = {}
      var list = Array.isArray(sessions) ? sessions : []
      for (var s = 0; s < list.length; s += 1) {
        if (list[s] === null || list[s] === undefined || typeof list[s] !== 'object') continue
        var id = list[s].sessionId !== undefined ? list[s].sessionId : list[s].id
        if (id !== null && id !== undefined && String(id) !== '') meta[String(id)] = list[s]
      }
      // 「未归类」只统计 /sessions 里确实存在、没有有效 assignment、也没被锁定的会话。
      var rootCount = 0
      for (var u = 0; u < list.length; u += 1) {
        if (list[u] === null || list[u] === undefined || typeof list[u] !== 'object') continue
        var uid = list[u].sessionId !== undefined ? list[u].sessionId : list[u].id
        var ukey = uid === null || uid === undefined ? '' : String(uid)
        if (ukey === '') continue
        if (directSessions[ukey] !== undefined) continue
        if (categorySessionLockedBy(store, locks, ukey)) continue
        rootCount += 1
      }
      var visited = {}
      function statsOf(node, trail) {
        if (node === null || node === undefined || trail.indexOf(node.id) >= 0) {
          return { count: 0, lastActive: 0, sessions: {}, score: 0 }
        }
        if (visited[node.id] !== undefined) return visited[node.id]
        var nextTrail = trail.concat([node.id])
        var sessionSet = {}
        var lastActive = 0
        var keys = Object.keys(directSessions)
        for (var i = 0; i < keys.length; i += 1) {
          if (directSessions[keys[i]] !== node.id) continue
          sessionSet[keys[i]] = true
          var time = sessionTimeInfoOf(meta[keys[i]]).time
          if (time !== null && time > lastActive) lastActive = time
        }
        for (var j = 0; j < node.children.length; j += 1) {
          var child = statsOf(node.children[j], nextTrail)
          var childKeys = Object.keys(child.sessions)
          for (var k = 0; k < childKeys.length; k += 1) sessionSet[childKeys[k]] = true
          if (child.lastActive > lastActive) lastActive = child.lastActive
        }
        var result = {
          count: Object.keys(sessionSet).length,
          lastActive: lastActive,
          sessions: sessionSet,
          score: Object.keys(sessionSet).length * lastActive,
        }
        visited[node.id] = result
        return result
      }
      function walkFlat(nodes, depth, prefix, out) {
        for (var i = 0; i < nodes.length; i += 1) {
          var node = nodes[i]
          if (visited[node.id] !== undefined && visited[node.id].flat === true) continue
          var stats = statsOf(node, [])
          visited[node.id].flat = true
          var path = prefix === '' ? node.name : prefix + ' › ' + node.name
          out.push({ id: node.id, name: node.name, path: path, count: stats.count, lastActive: stats.lastActive, score: stats.score })
          walkFlat(node.children, depth + 1, path, out)
        }
        return out
      }
      var flat = walkFlat(tree.roots, 0, '', [])
      flat.sort(function (left, right) {
        if (right.score !== left.score) return right.score - left.score
        if (right.count !== left.count) return right.count - left.count
        return String(left.name).localeCompare(String(right.name), 'zh')
      })
      var top = []
      for (var r = 0; r < tree.roots.length; r += 1) {
        var root = tree.roots[r]
        var rootStats = statsOf(root, [])
        if (rootStats.count <= 0) continue
        top.push({
          id: root.id,
          name: root.name,
          count: rootStats.count,
          lastActive: rootStats.lastActive,
          score: rootStats.score,
        })
      }
      top.sort(function (left, right) {
        if (right.score !== left.score) return right.score - left.score
        if (right.count !== left.count) return right.count - left.count
        return String(left.name).localeCompare(String(right.name), 'zh')
      })
      return { rootCount: rootCount, items: top, options: flat }
    }

    /** assignment 是否人工锁定（Host 可能用 locked / manual / source=manual）。 */
    function categorySessionLocked(store, sessionId) {
      var base = categoryStoreOf(store)
      var key = sessionId === null || sessionId === undefined ? '' : String(sessionId)
      if (key === '' || !Object.prototype.hasOwnProperty.call(base.assignments, key)) return false
      var raw = base.assignments[key]
      if (raw === true) return true
      if (raw === null || raw === undefined || typeof raw !== 'object') return false
      return raw.locked === true || raw.manual === true || raw.overridden === true
        || raw.source === 'manual' || raw.source === 'user'
    }

    /** 锁定判定：Host lockedSessions 里存在，或 assignment.source==='user'。 */
    function categorySessionLockedBy(store, lockedSessions, sessionId) {
      var key = sessionId === null || sessionId === undefined ? '' : String(sessionId)
      if (key === '') return false
      if (lockedSessions !== null && lockedSessions !== undefined
        && typeof lockedSessions === 'object'
        && Object.prototype.hasOwnProperty.call(lockedSessions, key)) return true
      return categorySessionLocked(store, key)
    }

    /** POST /category-override 请求体（categoryId=null 表示移出分类）。 */
    function categoryOverrideBody(workspaceId, sessionId, categoryId) {
      var body = categoryBodyOf(workspaceId)
      body.sessionId = sessionId === null || sessionId === undefined ? '' : String(sessionId)
      body.categoryId = categoryId === undefined || categoryId === null ? null : String(categoryId)
      return body
    }
    function categoryFlatOptions(store, excludeId) {
      var model = categoryTreeNodes(store, [])
      var out = []
      var hiddenId = typeof excludeId === 'string' && excludeId !== '' ? excludeId : ''
      var seen = {}
      function walk(nodes, depth, prefix, hidden) {
        for (var i = 0; i < nodes.length; i += 1) {
          var node = nodes[i]
          // 损坏的 store 可能有环：见过就跳过，宁可少列一项也不能卡死界面。
          if (seen[node.id] === true) continue
          seen[node.id] = true
          var isHidden = hidden === true || node.id === hiddenId
          if (isHidden !== true) {
            out.push({
              id: node.id,
              name: node.name,
              depth: depth,
              path: prefix === '' ? node.name : prefix + ' › ' + node.name,
              count: node.count,
            })
          }
          walk(node.children, depth + 1, prefix === '' ? node.name : prefix + ' › ' + node.name, isHidden)
        }
      }
      walk(model.roots, 0, '', false)
      return out
    }

    /** 会话的最后活动时间：Host 各版本字段名不一，按优先级归一。 */
    function sessionTimeInfoOf(session) {
      if (session === null || session === undefined || typeof session !== 'object') {
        return { time: null, kind: '' }
      }
      var fields = ['lastActive', 'lastActivity', 'updatedAt', 'createdAt']
      for (var i = 0; i < fields.length; i += 1) {
        var value = Number(session[fields[i]])
        if (Number.isFinite(value) && value > 0) {
          return { time: value, kind: fields[i] === 'createdAt' ? 'created' : 'active' }
        }
      }
      return { time: null, kind: '' }
    }

    /** 会话行第二行：`N 轮 · 最后活动 X`；Host 没给时间就明写「—」。 */
    function categorySessionMetaText(turns, time, kind, now) {
      var parts = []
      parts.push(turns === null ? '轮数未知' : turns + ' 轮')
      if (time === null) {
        parts.push('最后活动 —')
      } else {
        var relative = HITVIEW.formatRelativeTime(time, now)
        parts.push((kind === 'created' ? '创建于 ' : '最后活动 ') + (relative === '' ? '—' : relative))
      }
      return parts.join(' · ')
    }

    /** 收集分类自身 + 全部子孙的 id 集合。 */
    function categorySubtreeIds(store, rootId) {
      var base = categoryStoreOf(store)
      var wanted = rootId === null || rootId === undefined ? '' : String(rootId)
      var set = {}
      if (wanted !== '') set[wanted] = true
      var children = {}
      for (var i = 0; i < base.categories.length; i += 1) {
        var category = base.categories[i]
        var parent = category.parentId === null || category.parentId === undefined ? '' : String(category.parentId)
        if (children[parent] === undefined) children[parent] = []
        children[parent].push(category.id)
      }
      var queue = wanted === '' ? [] : [wanted]
      var guard = 0
      while (queue.length > 0 && guard < 10000) {
        guard += 1
        var current = queue.shift()
        var list = children[current] === undefined ? [] : children[current]
        for (var j = 0; j < list.length; j += 1) {
          if (set[list[j]] === true) continue
          set[list[j]] = true
          queue.push(list[j])
        }
      }
      return set
    }

    /**
     * 分类会话行。
     *
     * subtreeIds 为 null 表示不过滤（「全部」）；为分类 id 数组/集合时按子树
     * 匹配；为 __none__ 时只取无归属或归属到不存在分类的会话。
     */
    function categorySessionRows(store, sessions, subtreeIds, now) {
      var base = categoryStoreOf(store)
      var list = Array.isArray(sessions) ? sessions : []
      var meta = {}
      for (var s = 0; s < list.length; s += 1) {
        var session = list[s]
        if (session === null || session === undefined || typeof session !== 'object') continue
        var id = session.sessionId !== undefined ? session.sessionId : session.id
        var key = id === null || id === undefined ? '' : String(id)
        if (key !== '') meta[key] = session
      }
      var known = {}
      for (var c = 0; c < base.categories.length; c += 1) known[base.categories[c].id] = true
      var assignments = categoryAssignmentsOf(base)
      var assignedValid = {}
      for (var a = 0; a < assignments.length; a += 1) {
        if (known[assignments[a].categoryId] === true) assignedValid[assignments[a].sessionId] = true
      }

      var subtree = null
      var unclassified = false
      if (Array.isArray(subtreeIds) || (typeof Set === 'function' && subtreeIds instanceof Set)) {
        subtree = {}
        var subtreeList = Array.isArray(subtreeIds) ? subtreeIds : Array.from(subtreeIds)
        for (var t = 0; t < subtreeList.length; t += 1) {
          if (subtreeList[t] !== null && subtreeList[t] !== undefined) subtree[String(subtreeList[t])] = true
        }
      } else if (subtreeIds === CATEGORY_ROOT_ID) {
        unclassified = true
      } else if (subtreeIds !== null && subtreeIds !== undefined) {
        // 兼容旧调用：传具体分类 id 时自动补成整棵子树。
        subtree = categorySubtreeIds(store, subtreeIds)
      }

      var picked = []
      var seen = {}
      if (subtree === null && unclassified !== true) {
        // 全部：会话列表本身就是全集；列表缺失时退回有归属的会话 id。
        if (list.length > 0) {
          for (var r = 0; r < list.length; r += 1) {
            var allSession = list[r]
            if (allSession === null || allSession === undefined || typeof allSession !== 'object') continue
            var allId = allSession.sessionId !== undefined ? allSession.sessionId : allSession.id
            var allKey = allId === null || allId === undefined ? '' : String(allId)
            if (allKey === '' || seen[allKey] === true) continue
            seen[allKey] = true
            picked.push(allKey)
          }
        } else {
          for (var o = 0; o < assignments.length; o += 1) {
            if (seen[assignments[o].sessionId] === true) continue
            seen[assignments[o].sessionId] = true
            picked.push(assignments[o].sessionId)
          }
        }
      } else if (unclassified) {
        if (list.length > 0) {
          for (var u = 0; u < list.length; u += 1) {
            var unSession = list[u]
            if (unSession === null || unSession === undefined || typeof unSession !== 'object') continue
            var unId = unSession.sessionId !== undefined ? unSession.sessionId : unSession.id
            var unKey = unId === null || unId === undefined ? '' : String(unId)
            if (unKey === '' || assignedValid[unKey] === true || seen[unKey] === true) continue
            seen[unKey] = true
            picked.push(unKey)
          }
        } else {
          for (var n = 0; n < assignments.length; n += 1) {
            if (known[assignments[n].categoryId] === true) continue
            if (seen[assignments[n].sessionId] === true) continue
            seen[assignments[n].sessionId] = true
            picked.push(assignments[n].sessionId)
          }
        }
      } else {
        for (var p = 0; p < assignments.length; p += 1) {
          if (subtree[assignments[p].categoryId] !== true) continue
          if (seen[assignments[p].sessionId] === true) continue
          seen[assignments[p].sessionId] = true
          picked.push(assignments[p].sessionId)
        }
      }

      var rows = []
      for (var i = 0; i < picked.length; i += 1) {
        var sessionId = picked[i]
        var info = meta[sessionId] !== undefined ? meta[sessionId] : null
        var turnsValue = info === null ? NaN : Number(info.turns)
        var turns = Number.isFinite(turnsValue) ? Math.max(0, Math.floor(turnsValue)) : null
        var title = info !== null && typeof info.title === 'string' && info.title !== ''
          ? info.title
          : sessionId
        var timeInfo = sessionTimeInfoOf(info)
        rows.push({
          sessionId: sessionId,
          title: title,
          turns: turns,
          time: timeInfo.time,
          meta: categorySessionMetaText(turns, timeInfo.time, timeInfo.kind, now),
        })
      }
      rows.sort(function (left, right) {
        var leftTime = left.time === null ? -Infinity : left.time
        var rightTime = right.time === null ? -Infinity : right.time
        if (leftTime !== rightTime) return rightTime - leftTime
        if (left.title !== right.title) return left.title < right.title ? -1 : 1
        return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
      })
      return rows
    }

    /** 分类写操作的请求体：workspaceId 只在确实拿到时才带，交给 Host 兜底。 */
    function categoryBodyOf(workspaceId) {
      var body = {}
      if (typeof workspaceId === 'string' && workspaceId !== '') body.workspaceId = workspaceId
      return body
    }

    /** 写操作失败文案：前缀说清哪一步，Host 的中文 error 原样跟在后面。 */
    function categoryErrorText(prefix, error) {
      var reason = error === null || error === undefined || String(error) === ''
        ? '未知原因'
        : String(error)
      return prefix + '：' + reason
    }

    /** 通过 uiWorkspace 打开一个会话（分类列表点会话跳转）。 */
    function openWorkspaceSession(sessionId) {
      var id = sessionId === null || sessionId === undefined ? '' : String(sessionId)
      if (id === '') return { ok: false, reason: '缺少会话 id' }
      var opener = UI_WORKSPACE_SERVICE
      if (opener === null || opener === undefined || typeof opener.openSession !== 'function') {
        return { ok: false, reason: 'uiWorkspace.openSession 不可用' }
      }
      try {
        var maybe = opener.openSession(id)
        if (maybe !== null && maybe !== undefined && typeof maybe.then === 'function') {
          maybe.catch(function () { /* 切换失败时当前页面不变，不额外打断 */ })
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: errorText(error) }
      }
    }

    // ── 分类 tab ─────────────────────────────────────────────────────

    /**
     * 自动归类状态是独立组件：轮询只更新它自己的灰字，不触发胶囊树/列表重建。
     */
    function CategoryAutoStatus(props) {
      var enabled = props !== null && props !== undefined && props.enabled === true
      var workspaceId = props !== null && props !== undefined && typeof props.workspaceId === 'string'
        ? props.workspaceId : ''
      var sessionCount = props !== null && props !== undefined && Number.isFinite(Number(props.sessionCount))
        ? Number(props.sessionCount) : 0
      var onComplete = props !== null && props !== undefined && typeof props.onComplete === 'function'
        ? props.onComplete : null
      var resetKey = props !== null && props !== undefined && props.resetKey !== undefined && props.resetKey !== null
        ? String(props.resetKey) : ''
      var stateState = useState({ status: 'idle', unclassified: 0 })
      var auto = stateState[0]; var setAuto = stateState[1]
      var startedRef = useRef('')
      var pollRef = useRef({ timer: 0, token: 0, workspace: '' })

      function stop() {
        pollRef.current.token += 1
        if (pollRef.current.timer !== 0) {
          clearTimeout(pollRef.current.timer)
          pollRef.current.timer = 0
        }
      }

      function schedule(workspace, attempt, token, fallbackCount) {
        if (attempt >= CATEGORY_AUTO_POLL_MAX) { stop(); return }
        var visibility = typeof document !== 'undefined' && document !== null
          ? String(document.visibilityState || 'visible') : 'visible'
        if (visibility !== 'visible') {
          pollRef.current.timer = setTimeout(function () {
            schedule(workspace, attempt + 1, token, fallbackCount)
          }, CATEGORY_AUTO_POLL_MS)
          return
        }
        requestTopicMap('category-auto-status', { workspaceId: workspace }).then(function (result) {
          if (token !== pollRef.current.token || pollRef.current.workspace !== workspace) return
          if (result === null || result === undefined || result.ok !== true) {
            if (categoryAutoNoModel(null, result === null || result === undefined ? '' : result.error)) {
              stop()
              setAuto({ status: 'no-model', unclassified: 0 })
              return
            }
            stop()
            setAuto({ status: 'running', unclassified: fallbackCount })
            return
          }
          var value = result.value !== null && result.value !== undefined && typeof result.value === 'object'
            ? result.value : {}
          if (categoryAutoNoModel(value, '')) {
            stop()
            setAuto({ status: 'no-model', unclassified: 0 })
            return
          }
          var count = categoryAutoUnclassified(value)
          if (count === 0) {
            stop()
            setAuto({ status: 'idle', unclassified: 0 })
            if (onComplete !== null) onComplete()
            return
          }
          setAuto({ status: 'running', unclassified: count === null ? fallbackCount : count })
          if (attempt + 1 < CATEGORY_AUTO_POLL_MAX) {
            pollRef.current.timer = setTimeout(function () {
              schedule(workspace, attempt + 1, token, fallbackCount)
            }, CATEGORY_AUTO_POLL_MS)
          } else {
            stop()
          }
        }, function () {
          if (token !== pollRef.current.token) return
          stop()
          setAuto({ status: 'running', unclassified: fallbackCount })
        })
      }

      function start(workspace, count) {
        stop()
        var token = pollRef.current.token
        pollRef.current.workspace = workspace
        setAuto({ status: 'running', unclassified: count })
        requestTopicMap('category-auto-start', { workspaceId: workspace }).then(function (result) {
          if (token !== pollRef.current.token || pollRef.current.workspace !== workspace) return
          if (result === null || result === undefined || result.ok !== true) {
            if (categoryAutoNoModel(null, result === null || result === undefined ? '' : result.error)) {
              stop()
              setAuto({ status: 'no-model', unclassified: 0 })
            } else {
              stop()
              setAuto({ status: 'idle', unclassified: 0 })
            }
            return
          }
          var value = result.value !== null && result.value !== undefined && typeof result.value === 'object'
            ? result.value : {}
          if (categoryAutoNoModel(value, '')) {
            stop()
            setAuto({ status: 'no-model', unclassified: 0 })
            return
          }
          schedule(workspace, 0, token, count)
        }, function () {
          if (token !== pollRef.current.token) return
          stop()
          setAuto({ status: 'idle', unclassified: 0 })
        })
      }

      useEffect(function () {
        stop()
        startedRef.current = ''
        setAuto({ status: 'idle', unclassified: 0 })
        return function () { stop() }
      }, [workspaceId, resetKey])

      useEffect(function () {
        if (!enabled || workspaceId === '') {
          if (startedRef.current !== '') {
            stop()
            startedRef.current = ''
            setAuto({ status: 'idle', unclassified: 0 })
          }
          return
        }
        if (startedRef.current === workspaceId) return
        startedRef.current = workspaceId
        start(workspaceId, sessionCount)
      }, [enabled, workspaceId, sessionCount])

      var text = categoryAutoText(auto)
      return text === ''
        ? null
        : h('span', {
            className: 'dsh_tm_histcatauto',
            role: 'status',
            'data-auto-status': auto.status,
            title: text,
          }, text)
    }

    /**
     * 分类胶囊栏：只读 /categories + /sessions，不再提供任何分类编辑入口。
     * 最多显示 5 个分类胶囊，第 6 个起进「更多」。
     */
    function CategoriesTabBody(props) {
      useTopicMapTheme()
      var boundSessionId = props === null || props === undefined ? null : props.sessionId
      var embedded = props !== null && props !== undefined && props.embedded === true
      var externalCategory = props !== null && props !== undefined && typeof props.selectedCategory === 'string'
        ? props.selectedCategory
        : ''
      var refreshToken = props !== null && props !== undefined && props.refreshToken !== undefined
        ? props.refreshToken
        : 0
      var viewState = useState({
        status: 'loading', store: null, sessions: [], lockedSessions: {}, error: '', sessionsError: '', workspaceId: '',
      })
      var view = viewState[0]; var setView = viewState[1]
      var moreState = useState(false)
      var moreOpen = moreState[0]; var setMoreOpen = moreState[1]
      var seqRef = useRef(0)
      var viewBoundRef = useRef('')
      var loadAbortRef = useRef(null)

      function loadCategories(silent) {
        seqRef.current += 1
        var seq = seqRef.current
        if (typeof AbortController === 'function') {
          if (loadAbortRef.current !== null) {
            try { loadAbortRef.current.abort() } catch (error) { /* 已结束 */ }
          }
          loadAbortRef.current = new AbortController()
        }
        var signal = loadAbortRef.current !== null ? loadAbortRef.current.signal : undefined
        var boundKey = boundSessionId === null || boundSessionId === undefined ? '' : String(boundSessionId)
        var switching = viewBoundRef.current !== boundKey
        viewBoundRef.current = boundKey
        if (silent !== true) {
          setView(function (prev) {
            return {
              status: 'loading',
              store: switching ? null : prev.store,
              sessions: switching ? [] : prev.sessions,
              lockedSessions: switching ? {} : (prev.lockedSessions || {}),
              error: '', sessionsError: '',
              workspaceId: switching ? '' : prev.workspaceId,
            }
          })
        }
        return currentWorkspaceId(boundSessionId).then(function (workspaceId) {
          var body = workspaceId === '' ? {} : { workspaceId: workspaceId }
          var cached = workspaceId === '' ? null : historyCacheGet(workspaceId)
          if (cached !== null && cached.categories !== null && seq === seqRef.current) {
            setView({
              status: 'ready',
              store: cached.categories.store,
              sessions: cached.categories.sessions,
              lockedSessions: cached.categories.lockedSessions || {},
              error: '',
              sessionsError: '',
              workspaceId: workspaceId,
            })
          }
          if (workspaceId !== '') historyWarmup(workspaceId)
          return Promise.all([
            requestTopicMap('categories', body, { signal: signal }),
            requestTopicMap('sessions', body, { signal: signal }),
          ]).then(function (results) {
            if (seq !== seqRef.current) return
            var categories = results[0]
            var sessions = results[1]
            var sessionsOk = sessions !== null && sessions !== undefined && sessions.ok === true
            var sessionList = []
            if (sessionsOk && sessions.value !== null && typeof sessions.value === 'object'
              && Array.isArray(sessions.value.sessions)) {
              sessionList = sessions.value.sessions
            }
            var sessionsError = sessionsOk
              ? ''
              : categoryErrorText('读取会话失败', sessions === null || sessions === undefined ? '没有响应' : sessions.error)
            if (categories === null || categories === undefined || categories.ok !== true) {
              setView(function (prev) {
                return {
                  status: 'error',
                  store: prev.store,
                  sessions: sessionList.length > 0 ? sessionList : prev.sessions,
                  lockedSessions: prev.lockedSessions || {},
                  error: categoryErrorText('读取分类失败',
                    categories === null || categories === undefined ? '没有响应' : categories.error),
                  sessionsError: sessionsError,
                  workspaceId: workspaceId,
                }
              })
              return
            }
            var value = categories.value !== null && categories.value !== undefined
              && typeof categories.value === 'object' ? categories.value : {}
            setView({
              status: 'ready',
              store: value.store !== undefined ? value.store : null,
              sessions: sessionList,
              lockedSessions: value.lockedSessions !== null && value.lockedSessions !== undefined
                && typeof value.lockedSessions === 'object' && !Array.isArray(value.lockedSessions)
                ? value.lockedSessions : {},
              error: '',
              sessionsError: sessionsError,
              workspaceId: workspaceId,
            })
            if (workspaceId !== '') {
              historyCachePutCategories(workspaceId, {
                store: value.store !== undefined ? value.store : null,
                sessions: sessionList,
                lockedSessions: value.lockedSessions !== null && value.lockedSessions !== undefined
                  && typeof value.lockedSessions === 'object' && !Array.isArray(value.lockedSessions)
                  ? value.lockedSessions : {},
              })
            }
          })
        }, function (error) {
          if (seq !== seqRef.current) return
          setView(function (prev) {
            return {
              status: 'error', store: prev.store, sessions: prev.sessions,
              lockedSessions: prev.lockedSessions || {},
              error: categoryErrorText('读取分类失败', errorText(error)),
              sessionsError: '', workspaceId: prev.workspaceId,
            }
          })
        })
      }

      useEffect(function () {
        loadCategories(false)
        return function () {
          if (loadAbortRef.current !== null) {
            try { loadAbortRef.current.abort() } catch (error) { /* 已结束 */ }
          }
        }
      }, [boundSessionId, refreshToken])

      useEffect(function () {
        if (!embedded || typeof props.onData !== 'function') return
        if (view.status === 'loading' && view.store === null) return
        props.onData({
          store: view.store,
          sessions: view.sessions,
          lockedSessions: view.lockedSessions,
          workspaceId: view.workspaceId,
          status: view.status,
          error: view.error,
          sessionsError: view.sessionsError,
        })
      }, [view.store, view.sessions, view.lockedSessions, view.workspaceId, view.status, view.error, view.sessionsError, embedded])

      if (!embedded) {
        return h('div', { className: 'dsh_tm_histcatpills', role: 'navigation', 'aria-label': '分类过滤' },
          view.status === 'error'
            ? h('span', { className: 'dsh_tm_histcaterr' }, view.error)
            : h('span', { className: 'dsh_tm_histcatloading' }, '正在读取分类…'))
      }

      var model = categoryCapsuleModel(view.store, view.sessions, view.lockedSessions)
      var categoryCount = categoryStoreOf(view.store).categories.length
      var autoEnabled = view.status === 'ready' && view.workspaceId !== ''
        && categoryCount === 0 && view.sessions.length > 0
      var autoNode = h(CategoryAutoStatus, {
        enabled: autoEnabled,
        workspaceId: view.workspaceId,
        resetKey: boundSessionId,
        sessionCount: view.sessions.length,
        onComplete: function () { loadCategories(true) },
      })
      var selected = externalCategory
      var items = [{ id: CATEGORY_ALL_ID, name: CATEGORY_ALL_NAME, count: view.sessions.length }]
      if (model.rootCount > 0) items.push({ id: CATEGORY_ROOT_ID, name: CATEGORY_ROOT_NAME, count: model.rootCount })
      for (var i = 0; i < model.items.length; i += 1) items.push(model.items[i])
      var visible = items.slice(0, 5)
      var rest = items.slice(5)
      var selectedId = selected === '' ? CATEGORY_ALL_ID : (selected === '__none__' ? CATEGORY_ROOT_ID : selected)

      function choose(id) {
        setMoreOpen(false)
        if (typeof props.onSelect !== 'function') return
        props.onSelect(id === CATEGORY_ALL_ID ? '' : (id === CATEGORY_ROOT_ID ? '__none__' : String(id)))
      }

      var pills = []
      for (var p = 0; p < visible.length; p += 1) {
        ;(function (item) {
          var on = item.id === selectedId
          pills.push(h('button', {
            key: 'pill-' + item.id,
            type: 'button',
            className: 'dsh_tm_histcatpill' + (on ? ' dsh_tm_histcatpill_on' : ''),
            'data-cat-id': item.id,
            'aria-pressed': on ? 'true' : 'false',
            title: item.count === undefined ? item.name : item.name + ' · ' + item.count + ' 个会话',
            onClick: function () { choose(item.id) },
          }, h('span', { className: 'dsh_tm_histcatpillname' }, item.name)))
        })(visible[p])
      }
      var moreButton = null
      var moreMenu = null
      if (rest.length > 0) {
        moreButton = h('div', { className: 'dsh_tm_histcatmore' },
          h('button', {
            type: 'button',
            className: 'dsh_tm_histcatpill dsh_tm_histcatpill_more',
            'data-action': 'category-more',
            'aria-expanded': moreOpen ? 'true' : 'false',
            title: '更多分类',
            onClick: function () { setMoreOpen(!moreOpen) },
          }, '更多 ▾'))
        if (moreOpen) {
          moreMenu = h('div', { className: 'dsh_tm_histcatmoremenu', role: 'menu', 'aria-label': '更多分类' },
            rest.map(function (item) {
              var on = item.id === selectedId
              return h('button', {
                key: 'more-' + item.id,
                type: 'button',
                className: 'dsh_tm_histcatmoreitem' + (on ? ' dsh_tm_histcatmoreitem_on' : ''),
                role: 'menuitem',
                'data-cat-id': item.id,
                onClick: function () { choose(item.id) },
              }, item.name, h('span', { className: 'dsh_tm_histcatmorecount' }, String(item.count === undefined ? '' : item.count)))
            }))
        }
      }

      return h('div', { className: 'dsh_tm_histcatpillswrap' },
        h('div', { className: 'dsh_tm_histcatpills', role: 'navigation', 'aria-label': '分类过滤' },
          view.status === 'loading' && view.store === null
            ? h('span', { className: 'dsh_tm_histcatloading' }, '读取分类…')
            : null,
          view.status === 'error'
            ? h('span', { className: 'dsh_tm_histcaterr', role: 'alert', title: view.error }, view.error)
            : null,
          pills,
          moreButton),
        autoNode,
        moreMenu)
    }

    // ── 线索 tab ─────────────────────────────────────────────────────

    /** /search 命中 → buildClue 的输入行；按时间升序（模块要求）并去掉无时间行。 */
    /** 一条时间线记录 → 线索行；历史页与线索 tab 共用同一套 DOM/类名。 */
    function clueRowNode(item, index, onJump) {
      var turn = Number(item.turn)
      var turnLabel = Number.isFinite(turn) ? '第 ' + turn + ' 轮' : ''
      return h('div', {
        key: 'clue-' + index,
        className: 'dsh_tm_cluerow',
        role: 'button',
        tabIndex: 0,
        'data-session-id': item.sessionId,
        'data-turn': Number.isFinite(turn) ? String(turn) : '',
        onClick: function () { onJump(item) },
        onKeyDown: function (event) {
          if (event !== null && event !== undefined && event.key === 'Enter') {
            event.preventDefault()
            onJump(item)
          }
        },
      },
        h('div', { className: 'dsh_tm_cluerowhead' },
          h('span', { className: 'dsh_tm_cluetime' }, item.timeText || ''),
          h('span', { className: 'dsh_tm_clueat', title: item.sessionTitle }, item.sessionTitle || item.sessionId),
          turnLabel === '' ? null : h('span', { className: 'dsh_tm_clueturn' }, turnLabel),
          h('span', { className: 'dsh_tm_cluedelta' }, item.delta)),
        h('div', { className: 'dsh_tm_clueheadtext' },
          item.head === '' ? '（无提问摘要）' : item.head),
        item.count > 1
          ? h('div', { className: 'dsh_tm_cluesub' }, '同日合并 ' + item.count + ' 次')
          : null)
    }

    function clueRowsOfHits(hits) {
      var list = Array.isArray(hits) ? hits : []
      var rows = []
      for (var i = 0; i < list.length; i += 1) {
        var hit = list[i]
        if (hit === null || hit === undefined || typeof hit !== 'object') continue
        var time = Number(hit.time)
        if (!Number.isFinite(time)) continue
        var sessionId = hit.sessionId === null || hit.sessionId === undefined
          ? ''
          : String(hit.sessionId)
        var turn = Number(hit.turn)
        rows.push({
          sessionId: sessionId,
          sessionTitle: typeof hit.title === 'string' && hit.title !== '' ? hit.title : sessionId,
          turn: Number.isFinite(turn) ? turn : null,
          time: time,
          promptHead: typeof hit.promptHead === 'string' ? hit.promptHead : '',
        })
      }
      rows.sort(function (left, right) {
        if (left.time !== right.time) return left.time - right.time
        if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1
        var leftTurn = left.turn === null ? -1 : left.turn
        var rightTurn = right.turn === null ? -1 : right.turn
        return leftTurn - rightTurn
      })
      return rows
    }

    /** 顶部统计：`N 个会话 / M 轮 / 跨度 X 天`。 */
    function clueStatsText(stats) {
      var source = stats !== null && stats !== undefined && typeof stats === 'object' ? stats : {}
      var sessions = Number(source.sessions)
      var turns = Number(source.turns)
      var spanDays = Number(source.spanDays)
      return (Number.isFinite(sessions) ? sessions : 0) + ' 个会话 / '
        + (Number.isFinite(turns) ? turns : 0) + ' 轮 / 跨度 '
        + (Number.isFinite(spanDays) ? spanDays : 0) + ' 天'
    }

    function ClueTabBody(props) {
      useTopicMapTheme()
      var boundSessionId = props === null || props === undefined ? null : props.sessionId
      var inputState = useState('')
      var input = inputState[0]; var setInput = inputState[1]
      var stateState = useState({
        status: 'idle',
        keywords: '',
        value: null,
        error: '',
        total: 0,
        hits: 0,
        truncated: false,
      })
      var state = stateState[0]; var setState = stateState[1]
      var noticeState = useState(null)
      var notice = noticeState[0]; var setNotice = noticeState[1]
      var seqRef = useRef(0)
      var noticeTimerRef = useRef(0)

      function showNotice(text, tone) {
        setNotice({
          text: String(text === null || text === undefined ? '' : text),
          tone: tone === 'error' ? 'error' : (tone === 'ok' ? 'ok' : 'info'),
        })
        if (noticeTimerRef.current !== 0) clearTimeout(noticeTimerRef.current)
        noticeTimerRef.current = setTimeout(function () {
          noticeTimerRef.current = 0
          setNotice(null)
        }, 4000)
        unrefTimer(noticeTimerRef.current)
      }

      function runSearch(raw) {
        var keywords = String(raw === null || raw === undefined ? '' : raw).trim()
        if (keywords === '') {
          seqRef.current += 1
          setState({
            status: 'idle',
            keywords: '',
            value: null,
            error: '',
            total: 0,
            hits: 0,
            truncated: false,
          })
          return
        }
        seqRef.current += 1
        var seq = seqRef.current
        setState(function (prev) {
          return {
            status: 'loading',
            keywords: keywords,
            value: prev.value,
            error: '',
            total: prev.total,
            hits: prev.hits,
            truncated: prev.truncated,
          }
        })
        requestTopicMap('search', { sessionId: boundSessionId, keywords: keywords }).then(function (result) {
          if (seq !== seqRef.current) return
          if (result === null || result === undefined || result.ok !== true) {
            var reason = result === null || result === undefined ? '没有响应' : result.error
            setState(function (prev) {
              return {
                status: 'error',
                keywords: keywords,
                value: prev.value,
                error: reason,
                total: prev.total,
                hits: prev.hits,
                truncated: prev.truncated,
              }
            })
            return
          }
          var value = result.value !== null && result.value !== undefined
            && typeof result.value === 'object'
            ? result.value
            : {}
          var hits = Array.isArray(value.hits) ? value.hits : []
          var model = CLUEVIEW.buildClue(clueRowsOfHits(hits), {
            keywords: keywords,
            now: Date.now(),
            limit: 200,
          })
          var total = Number(value.total)
          setState({
            status: 'ready',
            keywords: keywords,
            value: model,
            error: '',
            total: Number.isFinite(total) ? total : hits.length,
            hits: hits.length,
            truncated: value.truncated === true,
          })
        }, function (error) {
          if (seq !== seqRef.current) return
          setState(function (prev) {
            return {
              status: 'error',
              keywords: keywords,
              value: prev.value,
              error: errorText(error),
              total: prev.total,
              hits: prev.hits,
              truncated: prev.truncated,
            }
          })
        })
      }

      useEffect(function () {
        return function () {
          seqRef.current += 1
          if (noticeTimerRef.current !== 0) {
            clearTimeout(noticeTimerRef.current)
            noticeTimerRef.current = 0
          }
        }
      }, [boundSessionId])

      function jumpToClue(item) {
        var turn = Number(item.turn)
        if (item.sessionId === '' || item.sessionId === null || item.sessionId === undefined) {
          showNotice('缺少会话信息，无法跳转', 'error')
          return
        }
        if (!Number.isFinite(turn)) {
          showNotice('缺少轮次信息，无法跳转', 'error')
          return
        }
        showNotice('正在定位第 ' + turn + ' 轮…', 'info')
        locateHistoryTurn(item.sessionId, turn, null, boundSessionId).then(function (result) {
          if (result !== null && result !== undefined && result.ok === true) {
            showNotice('已定位到第 ' + turn + ' 轮', 'ok')
            return
          }
          var reason = result !== null && result !== undefined && typeof result.reason === 'string'
            ? result.reason
            : '未知原因'
          showNotice('定位失败：' + reason, 'error')
        }, function (error) {
          showNotice('定位失败：' + errorText(error), 'error')
        })
      }

      function renderClueRow(item, index) {
        return clueRowNode(item, index, jumpToClue)
      }

      function renderBody() {
        if (state.status === 'loading' && (state.value === null || state.value.timeline.length === 0)) {
          return h('div', { className: 'dsh_tm_clueloading' }, '正在检索…')
        }
        if (state.status === 'error') {
          return h('div', { className: 'dsh_tm_cluebody' },
            h('div', { className: 'dsh_tm_clueerr', role: 'alert' },
              h('div', null, categoryErrorText('检索失败', state.error)),
              h('button', {
                type: 'button',
                className: 'dsh_tm_clueretry',
                onClick: function () { runSearch(state.keywords === '' ? input : state.keywords) },
              }, '重试')))
        }
        if (state.status === 'idle') {
          return h('div', { className: 'dsh_tm_clueempty' }, CLUE_EMPTY_TEXT)
        }
        var model = state.value
        if (model === null || model === undefined || model.empty === true) {
          return h('div', { className: 'dsh_tm_clueempty' },
            '没有找到与「' + state.keywords + '」相关的轮次')
        }
        return h('div', { className: 'dsh_tm_cluebody' },
          model.timeline.map(renderClueRow),
          state.truncated
            ? h('div', { className: 'dsh_tm_cluetruncated' },
                '命中 ' + state.total + ' 轮，只展示前 ' + state.hits + ' 条')
            : null)
      }

      return h('div', { className: 'dsh_tm_clue' },
        h(RightTabStrip, {
          active: CLUE_KIND,
          open: props === null || props === undefined ? undefined : props.openTab,
        }),
        h('div', { className: 'dsh_tm_cluehead' },
          h('div', { className: 'dsh_tm_cluetitle' }, CLUE_TITLE)),
        h('div', { className: 'dsh_tm_cluebar' },
          h('input', {
            type: 'search',
            className: 'dsh_tm_clueinput',
            placeholder: CLUE_SEARCH_PLACEHOLDER,
            'aria-label': '线索关键词',
            value: input,
            onChange: function (event) {
              var next = ''
              if (event !== null && event !== undefined && event.target !== null && event.target !== undefined) {
                next = event.target.value === null || event.target.value === undefined
                  ? ''
                  : String(event.target.value)
              }
              setInput(next)
            },
            onKeyDown: function (event) {
              if (event !== null && event !== undefined && event.key === 'Enter') {
                event.preventDefault()
                runSearch(input)
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'dsh_tm_cluesubmit',
            'data-action': 'clue-search',
            disabled: state.status === 'loading',
            onClick: function () { runSearch(input) },
          }, state.status === 'loading' ? '搜索中…' : '搜索')),
        notice === null || notice === undefined
          ? null
          : h('div', {
              className: 'dsh_tm_cluenotice',
              'data-tone': notice.tone,
              role: 'status',
            }, notice.text),
        state.status === 'ready' && state.value !== null && state.value.timeline.length > 0
          ? h('div', { className: 'dsh_tm_cluestats' }, clueStatsText(state.value.stats))
          : null,
        renderBody())
    }

    // ── 历史详情里的变更区 + 回滚预演浮窗 ──────────────────────────

    /** 文件行右侧的 `+a −d`。 */
    function changeChurnText(file) {
      var added = Number(file !== null && file !== undefined ? file.added : NaN)
      var deleted = Number(file !== null && file !== undefined ? file.deleted : NaN)
      return '+' + (Number.isFinite(added) ? added : 0)
        + ' −' + (Number.isFinite(deleted) ? deleted : 0)
    }

    /**
     * 详情里的「变更」区；`turn.changes` 不存在时返回 null（保留旧 files 路径）。
     *
     * 分组、lost 文案、总计都来自共用的纯模块 changes-view，客户端不再
     * 自己写一套口径。
     */
    function changeSectionNode(h, turn, onPreview) {
      var source = turn !== null && turn !== undefined && typeof turn === 'object' ? turn : {}
      var changes = source.changes
      if (changes === undefined || changes === null) return null
      var view = CHANGESVIEW.buildChanges(source)
      var children = []
      if (view.lost) {
        children.push(h('div', { className: 'dsh_tm_histdlost', key: 'lost' }, view.summary))
        return h('div', { className: 'dsh_tm_histdsec dsh_tm_histdchanges', key: 'changes' },
          h('b', null, '变更'), children)
      }
      children.push(h('div', { className: 'dsh_tm_histdchsum', key: 'summary' }, view.summary))
      var groups = CHANGESVIEW.groupByKind(view.files)
      for (var g = 0; g < groups.length; g += 1) {
        ;(function (group) {
          children.push(h('div', {
            className: 'dsh_tm_histdchangegroup',
            key: 'group-' + group.kind,
            'data-kind': group.kind,
          },
            h('div', { className: 'dsh_tm_histdchangehead' }, group.label + ' · ' + group.files.length),
            h('ul', { className: 'dsh_tm_histdchangelist' }, group.files.map(function (file, index) {
              return h('li', { className: 'dsh_tm_histdchangerow', key: 'file-' + index },
                h('span', { className: 'dsh_tm_histdchangepath', title: file.path }, file.path),
                h('span', { className: 'dsh_tm_histdchangechurn' }, changeChurnText(file)))
            }))))
        })(groups[g])
      }
      if (view.files.length > 0 && typeof onPreview === 'function') {
        children.push(h('button', {
          key: 'preview',
          type: 'button',
          className: 'dsh_tm_histact dsh_tm_histrollbackbtn',
          'data-action': 'rollback-preview',
          onClick: function (event) {
            if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') {
              event.stopPropagation()
            }
            onPreview()
          },
        }, '回滚预演'))
      }
      return h('div', { className: 'dsh_tm_histdsec dsh_tm_histdchanges', key: 'changes' },
        h('b', null, '变更'), children)
    }

    /** 回滚预演请求体；会话或轮次不完整时返回 null（不发请求）。 */
    function rollbackPlanRequest(sessionId, turn) {
      var id = sessionId === null || sessionId === undefined ? '' : String(sessionId).trim()
      var number = Number(turn)
      if (id === '' || !Number.isInteger(number) || number < 0) return null
      return { sessionId: id, turn: number }
    }

    /** 读回滚预演；参数不完整时直接给可读错误，不浪费一次网络请求。 */
    function loadRollbackPlan(sessionId, turn) {
      var body = rollbackPlanRequest(sessionId, turn)
      if (body === null) {
        return Promise.resolve({ ok: false, error: '缺少会话或轮次信息', status: 0 })
      }
      return requestTopicMap('rollback-plan', body)
    }

    /**
     * 预演结果 → 四态分组。
     *
     * 未知 state 归到「已被修改」（需要人工确认），不伪造一个可回滚态。
     */
    function rollbackPreviewModel(value) {
      var source = value !== null && value !== undefined && typeof value === 'object' ? value : {}
      var plan = Array.isArray(source.plan) ? source.plan : []
      var buckets = { apply: [], same: [], modified: [], missing: [] }
      for (var i = 0; i < plan.length; i += 1) {
        var item = plan[i]
        if (item === null || item === undefined || typeof item !== 'object') continue
        var state = ROLLBACK_STATE_ORDER.indexOf(item.state) >= 0 ? item.state : 'modified'
        var added = Number(item.added)
        var deleted = Number(item.deleted)
        buckets[state].push({
          path: typeof item.path === 'string' ? item.path : '',
          added: Number.isFinite(added) ? added : 0,
          deleted: Number.isFinite(deleted) ? deleted : 0,
          state: state,
        })
      }
      var groups = []
      var counts = {}
      for (var s = 0; s < ROLLBACK_STATE_ORDER.length; s += 1) {
        var key = ROLLBACK_STATE_ORDER[s]
        counts[key] = buckets[key].length
        groups.push({ state: key, label: ROLLBACK_STATE_TEXT[key], files: buckets[key] })
      }
      return {
        groups: groups,
        counts: counts,
        summary: typeof source.summary === 'string' ? source.summary : '',
        lost: source.lost === true,
        total: plan.length,
      }
    }

    /** 数量摘要：`可回滚 2 · 已一致 1 · ...`。 */
    function rollbackCountsText(counts) {
      var source = counts !== null && counts !== undefined && typeof counts === 'object' ? counts : {}
      var parts = []
      for (var i = 0; i < ROLLBACK_STATE_ORDER.length; i += 1) {
        var key = ROLLBACK_STATE_ORDER[i]
        parts.push(ROLLBACK_STATE_TEXT[key] + ' ' + (Number(source[key]) || 0))
      }
      return parts.join(' · ')
    }

    /** 只读预演浮窗：四态分组 + 数量摘要 + 明确「不写文件」。 */
    function rollbackPreviewNodes(h, state, handlers) {
      if (state === null || state === undefined) return null
      var options = handlers !== null && handlers !== undefined && typeof handlers === 'object' ? handlers : {}
      var onClose = typeof options.close === 'function' ? options.close : function () {}
      function stop(event) {
        if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') {
          event.stopPropagation()
        }
      }
      var body = []
      var planText = ''
      if (state.status === 'loading') {
        body.push(h('div', { className: 'dsh_tm_clueloading', key: 'loading' }, '正在预演…'))
      } else if (state.status === 'error') {
        body.push(h('div', {
          className: 'dsh_tm_rberr',
          role: 'alert',
          key: 'error',
        }, categoryErrorText('回滚预演失败', state.error)))
      } else {
        var model = rollbackPreviewModel(state.value)
        var source = state.value !== null && state.value !== undefined && typeof state.value === 'object'
          ? state.value
          : {}
        // 复制清单复用纯模块的 formatPlan，避免再写一套「状态 + 路径 + ±行」。
        planText = ROLLBACKPLAN.formatPlan(Array.isArray(source.plan) ? source.plan : [])
        body.push(h('div', { className: 'dsh_tm_rbsummary', key: 'summary' },
          model.summary === '' ? '没有可回滚的文件' : model.summary))
        body.push(h('div', { className: 'dsh_tm_rbcounts', key: 'counts' },
          rollbackCountsText(model.counts)))
        if (model.lost !== true) {
          for (var g = 0; g < model.groups.length; g += 1) {
            ;(function (group) {
              body.push(h('div', {
                className: 'dsh_tm_rbgroup',
                key: 'group-' + group.state,
                'data-state': group.state,
              },
                h('div', { className: 'dsh_tm_rbgrouphead' },
                  h('span', { className: 'dsh_tm_rbstate' }, group.label),
                  h('span', { className: 'dsh_tm_rbcount' }, String(group.files.length))),
                group.files.length === 0
                  ? h('div', { className: 'dsh_tm_rbempty' }, '无')
                  : h('ul', { className: 'dsh_tm_rbfiles' }, group.files.map(function (file, index) {
                      return h('li', {
                        className: 'dsh_tm_rbfile',
                        key: 'file-' + index,
                        'data-state': group.state,
                      },
                        h('span', { className: 'dsh_tm_rbpath', title: file.path }, file.path),
                        h('span', { className: 'dsh_tm_rbchurn' }, changeChurnText(file)))
                    }))))
            })(model.groups[g])
          }
        }
      }
      return h('div', {
        className: 'dsh_tm_histmodal dsh_tm_rbmodal',
        role: 'presentation',
        onClick: onClose,
      },
        h('div', {
          className: 'dsh_tm_histdialog dsh_tm_rbdialog',
          role: 'dialog',
          'aria-modal': 'true',
          onClick: stop,
        },
          h('div', { className: 'dsh_tm_histdialoghead' },
            h('div', { className: 'dsh_tm_histdialogtitle' }, '回滚预演'),
            h('button', {
              type: 'button',
              className: 'dsh_tm_histdialogclose',
              title: '关闭',
              'aria-label': '关闭',
              onClick: function (event) { stop(event); onClose() },
            }, '✕')),
          h('div', { className: 'dsh_tm_rbbody' }, body),
          h('div', { className: 'dsh_tm_histdialogfoot' },
            h('span', { className: 'dsh_tm_rbnote' }, ROLLBACK_NOTE),
            h('span', { className: 'dsh_tm_histgrow' }),
            state.status === 'ready' && typeof options.copy === 'function'
              ? h('button', {
                  type: 'button',
                  className: 'dsh_tm_histact',
                  'data-action': 'rollback-copy',
                  onClick: function (event) {
                    stop(event)
                    options.copy(planText)
                  },
                }, '复制清单')
              : null,
            h('button', {
              type: 'button',
              className: 'dsh_tm_histact',
              'data-action': 'rollback-close',
              onClick: function (event) { stop(event); onClose() },
            }, '关闭'))))
    }

    // ── V-12 历史轨接管（DOM 级）────────────────────────────────────
    //
    // 原生轮次轨由 ChatView 直接渲染（`TurnNavigator`），没有 slot 座位，
    // 所以只能在 DOM 层接管：把原生 nav 隐藏、在原位旁边渲染自绘轨（轮号 +
    // 摘要 + 点击跳转），并保留原生节点作为锚点与退路。
    //
    // 隐藏方式用 `visibility:hidden` 而**不是** `display:none` / `hidden` 属性：
    // 原生轨用 @tanstack/react-virtual 虚拟化，display:none 会让滚动区高度
    // 变成 0，虚拟化停摆、aria-current 也跟着消失；visibility 保留布局、
    // 渲染与 React 更新，只是看不见、不可点、不进 Tab 序——这正是要的。
    //
    // 选择器全部来自 spike（见 lib/rail-view.js 顶部注释）：类名是构建 hash，
    // 只能按 `[data-conversation-scroll] nav[aria-label=…]` 这种语义属性定位。
    var RAIL_NATIVE_KEY = 'dsh.tm.rail.native'
    var RAIL_TIER_PREFIX = 'dsh.tm.rail.tier.'
    var RAIL_HITS_PREFIX = 'dsh.tm.rail.hits.'
    var RAIL_AUTOHIDE_KEY = 'dsh.tm.rail.autohide'
    var RAIL_RESTORE_TITLE = '启用插件导航轨'
    var RAIL_TIER_MIN = 'min'
    var RAIL_TIER_STD = 'std'
    var RAIL_TIER_MAX = 'max'
    var RAIL_TIER_DEFAULT = RAIL_TIER_STD
    var RAIL_STD_FALLBACK = 200
    var RAIL_MAX_FALLBACK = 260
    var RAIL_RESIZE_EPSILON = 8
    var RAIL_AUTO_HIDE_DELAY_MS = 600
    var RAIL_SYNC_DELAY_MS = 200
    var RAIL_ACTIVE_DELAY_MS = 80
    var RAIL_ROW_CHECK_DELAY_MS = 200
    var RAIL_SCROLL_SETTLE_MS = 250
    var RAIL_OUTLINE_REFRESH_DELAY_MS = 800
    var RAIL_OUTLINE_TTL_MS = 60 * 1000
    var RAIL_NOTICE_ID = 'dsh_tm_rail_notice'
    var RAIL_NATIVE_HIDE_STYLE_ID = 'dsh_tm_native_hide_style'
    var RAIL_NATIVE_HIDE_CSS = '[data-dsh-tm-native]{visibility:hidden !important}'
    var RAIL_ANIM_MS = 120

    /**
     * 最小档初始候选：只用来启动溢出迭代，最终宽度以 fitMinWidth 量出的
     * scrollWidth - clientWidth 收敛值为准。
     */
    function railInitialMinWidth(measuredWidth) {
      var measured = Number(measuredWidth)
      if (!Number.isFinite(measured) || measured <= 0) return 28
      return Math.max(28, Math.round(measured + 18))
    }

    function railTierWidthFor(tier, containerWidth, minWidth) {
      var width = Number(containerWidth)
      if (!Number.isFinite(width) || width <= 0) width = RAIL_STD_FALLBACK * 5 / 3
      var narrow = width < 900
      var stdLow = narrow ? 140 : 150
      var std = Math.min(240, Math.max(stdLow, Math.round(width * 0.16)))
      var maxHigh = narrow ? 280 : 340
      var max = Math.min(maxHigh, Math.max(200, Math.round(width * 0.22)))
      if (max <= std) max = Math.min(maxHigh, std + 20)
      if (tier === RAIL_TIER_MIN) return railInitialMinWidth(minWidth)
      if (tier === RAIL_TIER_MAX) return max
      return std
    }

    /** 摘要：压缩空白，按码点截 10 字，第 11 字起用省略号（总长 11）。 */
    function railSummaryText(value) {
      var text = String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim()
      if (text === '') return ''
      var chars = Array.from(text)
      return chars.length > 10 ? chars.slice(0, 10).join('') + '…' : chars.join('')
    }

    function railTierIcon(tier) {
      if (tier === RAIL_TIER_MIN) return '⌄'
      if (tier === RAIL_TIER_MAX) return '≡'
      return '···'
    }

    function railTierLabel(tier) {
      if (tier === RAIL_TIER_MIN) return '最小'
      if (tier === RAIL_TIER_MAX) return '最大'
      return '标准'
    }

    /** 时间统一成本地 HH:mm（两位补零），无法解析返回空串。 */
    function railTimeText(value) {
      if (value === null || value === undefined || value === '') return ''
      var text = String(value).trim()
      var match = text.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/)
      if (match !== null) {
        var hour = Number(match[1])
        var minute = Number(match[2])
        if (hour >= 0 && hour < 24 && minute >= 0 && minute < 60) {
          return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0')
        }
      }
      var parsed = Date.parse(text)
      if (Number.isFinite(parsed)) {
        var date = new Date(parsed)
        return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
      }
      return ''
    }

    var RAILTAKE = (function () {
      var host = null
      var doc = null
      var win = null
      var store = null
      var view = null

      var disposed = true
      var mounted = false
      var nav = null
      var rail = null
      var rowsBox = null
      var noteEl = null
      var railHead = null
      var tierBtn = null
      var moreBtn = null
      var menuEl = null
      var rowEls = new Map()
      var segHeaderEls = []
      var rows = []
      var sessionId = ''
      var tier = RAIL_TIER_DEFAULT
      var lastTier = RAIL_TIER_DEFAULT
      var autoMin = false
      var autoHideTimer = null
      var rowTimer = null
      var outlineRefreshTimer = null
      var scrollSettleTimer = null
      var lastNativeSignature = ''
      var lastRowsSignature = ''
      var lastScrollAt = 0
      var geometryDirty = false
      var prefsListeners = []
      var restoreBtn = null
      var restoreScroller = null
      var hitMemory = {}
      var currentHits = new Set()
      var activeTurn = null
      var outline = []
      var outlineTurns = []
      var outlineSegments = []
      var outlineCache = new Map()
      var outlinePendingFor = ''
      var outlineSessionId = null
      var outlineAvailable = true
      var syncTimer = null
      var activeTimer = null
      var activeRaf = null
      var nativeCheckTimer = null
      var animationTimer = null
      var hoverRaf = null
      var hoverPending = ''
      var nativeStyleEl = null
      var checkedNav = null
      var isAnimating = false
      var lastEffectiveTier = null
      var dockObscured = false
      var noticeReason = ''
      var docObserver = null
      var navObserver = null
      var memoryStore = {}
      var scrollBound = false
      var resizeBound = false
      var keyBound = false
      var menuOutsideBound = false
      var metrics = { containerW: 0, containerH: 0, std: RAIL_STD_FALLBACK, max: RAIL_MAX_FALLBACK, min: 28 }
      var containerObserver = null
      var metricsRaf = null
      var activeRetryUnsub = null
      var measureEl = null
      var measuredText = ''
      var measuredTextWidth = 0
      var fitMinText = ''
      var fittedMinWidth = 0
      var fitMinIterations = 0

      /** 写一条诊断：接管失败必须能解释，不能静默。 */
      function note(message) {
        try {
          if (typeof host.diag === 'function') host.diag(message)
        } catch (error) { /* 诊断本身不能影响接管 */ }
      }

      function setTimer(fn, delay) {
        if (win !== null && typeof win.setTimeout === 'function') return win.setTimeout(fn, delay)
        if (typeof setTimeout === 'function') return setTimeout(fn, delay)
        return null
      }

      function clearTimer(id) {
        if (id === null || id === undefined) return
        if (win !== null && typeof win.clearTimeout === 'function') { win.clearTimeout(id); return }
        if (typeof clearTimeout === 'function') clearTimeout(id)
      }

      function observerOf() {
        if (win !== null && win.MutationObserver !== undefined) return win.MutationObserver
        if (typeof MutationObserver === 'function') return MutationObserver
        return null
      }

      // ── 本地存储（读写都可能抛：隐私模式 / 沙箱 iframe）──────────
      function readStore(key) {
        if (store !== null && store !== undefined && typeof store.getItem === 'function') {
          try {
            var value = store.getItem(key)
            if (value !== null && value !== undefined) return value
          } catch (error) { /* 退回内存 */ }
        }
        return memoryStore[key] === undefined ? null : memoryStore[key]
      }

      function writeStore(key, value) {
        memoryStore[key] = String(value)
        if (store !== null && store !== undefined && typeof store.setItem === 'function') {
          try { store.setItem(key, String(value)) } catch (error) { /* 写不进去不影响本次会话 */ }
        }
      }

      /** 是否要求恢复原生轨（设置面板的开关）。 */
      function nativePreferred() {
        return readStore(RAIL_NATIVE_KEY) === '1'
      }

      function tierKey() {
        return RAIL_TIER_PREFIX + (sessionId === '' ? 'default' : sessionId)
      }

      function normalizeTier(value) {
        return value === RAIL_TIER_MIN || value === RAIL_TIER_MAX ? value : RAIL_TIER_STD
      }

      function loadTier() {
        tier = normalizeTier(readStore(tierKey()))
        lastTier = tier === RAIL_TIER_MIN ? RAIL_TIER_STD : tier
        autoMin = false
      }

      function saveTier() {
        writeStore(tierKey(), tier)
      }

      // ── 档位 / 自动隐藏 / 偏好订阅（三个设置面读同一份 localStorage）──
      //
      // 三处会改这些偏好：自绘轨自己的 ⋯ 菜单、自绘轨的档位按钮、设置页。
      // 写 localStorage 后通过订阅通知各界面重读，任何一处改动其它两处立刻跟上。

      // ── 搜索命中标记（当前会话）──────────────────────────────────
      //
      // 历史搜索完成后把本会话命中的轮号写进来；自绘轨据此给行加
      // data-hit="1"（蓝色刻度）。写入同时进内存与 localStorage，轨道
      // 重新挂载（切会话/面板重开）时能恢复；清空搜索则整组清掉。

      function hitsKey(id) {
        return RAIL_HITS_PREFIX + (id === null || id === undefined || String(id) === '' ? 'default' : String(id))
      }

      function normalizeHits(value) {
        var out = []
        var list = Array.isArray(value) ? value : []
        for (var i = 0; i < list.length; i += 1) {
          var turn = Number(list[i])
          if (!Number.isInteger(turn) || turn <= 0) continue
          if (out.indexOf(turn) < 0) out.push(turn)
        }
        return out
      }

      function loadHits(id) {
        var key = String(id === null || id === undefined ? '' : id)
        if (hitMemory[key] !== undefined) return hitMemory[key].slice()
        var raw = readStore(hitsKey(key))
        var list = []
        if (raw !== null && raw !== undefined && raw !== '') {
          try { list = normalizeHits(JSON.parse(raw)) } catch (error) { list = [] }
        }
        hitMemory[key] = list
        return list.slice()
      }

      /**
       * 整组替换某会话的命中轮号。
       *
       * @param id - 会话 id。
       * @param turns - 命中轮号数组；非法项忽略，负数/0/重复丢弃。
       * @returns 归一后的轮号数组。
       */
      function setHits(id, turns) {
        var key = String(id === null || id === undefined ? '' : id)
        var list = normalizeHits(turns)
        hitMemory[key] = list
        writeStore(hitsKey(key), JSON.stringify(list))
        if (key === (sessionId === '' ? '' : sessionId)) {
          currentHits = new Set(list)
          applyHitAttributes()
        }
        return list.slice()
      }

      /** 把当前命中集合写到已渲染的行上；不重建 DOM，避免打断滚动。 */
      function applyHitAttributes() {
        for (var i = 0; i < rows.length; i += 1) {
          var on = currentHits.has(Number(rows[i].turn))
          rows[i].hit = on
          var button = rowEls.get(rows[i].turn)
          if (button === undefined) continue
          if (on) button.setAttribute('data-hit', '1')
          else button.removeAttribute('data-hit')
        }
      }

      // ── 原生模式的切回入口（小药丸）────────────────────────────
      //
      // 用户勾「恢复原生导航轨」后自绘轨撤掉，必须还能切回来。药丸挂在
      // 对话滚动容器右缘（fixed 定位跟随容器矩形），只覆盖内容区，不压
      // 原生轨与滚动条；设置 tab 的开关读到的是同一个 localStorage 键。

      /** 当前可见的对话滚动容器（后台会话的容器也在 DOM 里但 hidden）。 */
      function visibleScrollerOf() {
        if (doc !== null && typeof doc.querySelectorAll === 'function') {
          var list = doc.querySelectorAll('[data-conversation-scroll]')
          for (var i = 0; i < list.length; i += 1) {
            var candidate = list[i]
            try {
              if (typeof candidate.closest === 'function') {
                var root = candidate.closest('[data-conversation-session]')
                if (root !== null && root !== undefined && root.hidden === true) continue
              }
            } catch (error) { /* 没有 closest 就当可见 */ }
            return candidate
          }
        }
        return scrollerOf()
      }

      function updateRestorePosition() {
        if (restoreBtn === null) return
        if (restoreBtn.style === undefined || restoreBtn.style === null) return
        var scroller = visibleScrollerOf()
        if (scroller !== null && scroller !== undefined) restoreScroller = scroller
        if (scroller === null || scroller === undefined) scroller = restoreScroller
        var rect = null
        try {
          if (scroller !== null && scroller !== undefined && typeof scroller.getBoundingClientRect === 'function') {
            rect = scroller.getBoundingClientRect()
          }
        } catch (error) { rect = null }
        var viewportWidth = win !== null && typeof win.innerWidth === 'number' ? win.innerWidth : 0
        var viewportHeight = win !== null && typeof win.innerHeight === 'number' ? win.innerHeight : 0
        var right = 14
        var top = viewportHeight > 0 ? Math.max(4, viewportHeight / 2 - 22) : 0
        if (rect !== null && rect !== undefined) {
          var rightEdge = Number(rect.right)
          if (Number.isFinite(rightEdge) && viewportWidth > 0) {
            // 容器右缘内侧 14px：让开滚动条。
            right = Math.max(4, viewportWidth - rightEdge + 14)
          }
          var rectTop = Number(rect.top)
          var rectHeight = Number(rect.height)
          // 容器高度为 0（尚未布局/被折叠）时不要用 rectTop 算，否则药丸会贴到右上角。
          if (Number.isFinite(rectTop) && Number.isFinite(rectHeight) && rectHeight > 0) {
            top = Math.max(4, rectTop + rectHeight / 2 - 22)
          }
        }
        restoreBtn.style.right = right + 'px'
        restoreBtn.style.top = top + 'px'
      }

      function removeRestoreButton() {
        if (restoreBtn !== null && restoreBtn.parentElement !== null && restoreBtn.parentElement !== undefined
          && typeof restoreBtn.parentElement.removeChild === 'function') {
          restoreBtn.parentElement.removeChild(restoreBtn)
        }
        restoreBtn = null
        restoreScroller = null
      }

      function mountRestoreButton() {
        if (doc === null) return
        if (restoreBtn !== null && restoreBtn.parentElement !== null && restoreBtn.parentElement !== undefined) {
          updateRestorePosition()
          return
        }
        removeRestoreButton()
        restoreScroller = visibleScrollerOf()
        restoreBtn = el('button', 'dsh_tm_railrestore')
        restoreBtn.type = 'button'
        restoreBtn.id = 'dsh_tm_rail_restore'
        restoreBtn.title = RAIL_RESTORE_TITLE
        restoreBtn.setAttribute('aria-label', RAIL_RESTORE_TITLE)
        restoreBtn.textContent = '⋮⋮'
        if (typeof restoreBtn.addEventListener === 'function') {
          restoreBtn.addEventListener('click', function (event) {
            if (event !== null && event !== undefined && typeof event.preventDefault === 'function') {
              event.preventDefault()
            }
            setNativePreferred(false)
          })
        }
        if (doc.body !== null && doc.body !== undefined && typeof doc.body.appendChild === 'function') {
          doc.body.appendChild(restoreBtn)
          updateRestorePosition()
        } else {
          restoreBtn = null
          restoreScroller = null
        }
      }

      function autoHideEnabled() {
        // 默认开：缺失或读不到都按开处理；只有明确写了 '0' 才关。
        return readStore(RAIL_AUTOHIDE_KEY) !== '0'
      }

      function notifyPrefs() {
        for (var i = prefsListeners.length - 1; i >= 0; i -= 1) {
          try { prefsListeners[i]() } catch (error) { /* 单个订阅者失败不影响轨道 */ }
        }
      }

      /** 订阅偏好变化（宽度 / 折叠 / 自动隐藏 / 原生开关）；返回退订函数。 */
      function subscribePrefs(listener) {
        if (typeof listener !== 'function') return function () {}
        prefsListeners.push(listener)
        return function () {
          var at = prefsListeners.indexOf(listener)
          if (at >= 0) prefsListeners.splice(at, 1)
        }
      }

      function setAutoHide(value) {
        var on = value === true
        writeStore(RAIL_AUTOHIDE_KEY, on ? '1' : '0')
        if (!on) {
          clearAutoHideTimer()
          autoMin = false
          applyPresentation()
        }
        notifyPrefs()
        return on
      }

      function maxTurnOfRows() {
        var maxTurn = 0
        for (var i = 0; i < rows.length; i += 1) {
          var turn = Number(rows[i].turn)
          if (Number.isFinite(turn) && turn > maxTurn) maxTurn = turn
        }
        for (var j = 0; j < outlineTurns.length; j += 1) {
          var outlineTurn = Number(outlineTurns[j])
          if (Number.isFinite(outlineTurn) && outlineTurn > maxTurn) maxTurn = outlineTurn
        }
        return maxTurn
      }

      function readContainerSize() {
        var scroller = scrollerOf()
        var width = 0
        var height = 0
        try {
          if (scroller !== null && scroller !== undefined) {
            var rect = typeof scroller.getBoundingClientRect === 'function' ? scroller.getBoundingClientRect() : null
            width = rect === null || rect === undefined ? 0 : Number(rect.width) || 0
            height = rect === null || rect === undefined ? 0 : Number(rect.height) || 0
            if (!(width > 0)) width = Number(scroller.clientWidth) || 0
            if (!(height > 0)) height = Number(scroller.clientHeight) || 0
          }
        } catch (error) { /* 量不到就回退默认 */ }
        return { width: width, height: height }
      }

      function computeMetrics() {
        var size = readContainerSize()
        var narrow = size.width > 0 && size.width < 900
        var std = railTierWidthFor(RAIL_TIER_STD, size.width, metrics.min)
        var max = railTierWidthFor(RAIL_TIER_MAX, size.width, metrics.min)
        var min = Math.round(metrics.min)
        var changed = Math.abs(std - metrics.std) > RAIL_RESIZE_EPSILON
          || Math.abs(max - metrics.max) > RAIL_RESIZE_EPSILON
          || min !== metrics.min
          || Math.abs(size.width - metrics.containerW) > 1
        metrics = { containerW: size.width, containerH: size.height, std: std, max: max, min: min, narrow: narrow }
        return changed
      }

      function effectiveTier() {
        return autoMin ? RAIL_TIER_MIN : tier
      }

      function tierWidth() {
        var value = effectiveTier()
        if (value === RAIL_TIER_MIN) return metrics.min
        if (value === RAIL_TIER_MAX) return metrics.max
        return metrics.std
      }

      /** 档位循环：min → std → max → min。 */
      function nextTierOf(value) {
        if (value === RAIL_TIER_MIN) return RAIL_TIER_STD
        if (value === RAIL_TIER_STD) return RAIL_TIER_MAX
        return RAIL_TIER_MIN
      }

      function setTier(value) {
        var next = normalizeTier(value)
        autoMin = false
        clearAutoHideTimer()
        if (next === RAIL_TIER_MIN) {
          if (tier !== RAIL_TIER_MIN) lastTier = tier
          closeMoreMenu()
        } else {
          lastTier = next
        }
        tier = next
        saveTier()
        applyPresentation()
        notifyPrefs()
        return tier
      }

      function cycleTier() {
        return setTier(nextTierOf(effectiveTier()))
      }

      /** Alt+[：min 与上次档位之间切换，不循环。 */
      function toggleMinTier() {
        if (effectiveTier() === RAIL_TIER_MIN) {
          return setTier(lastTier === RAIL_TIER_MIN ? RAIL_TIER_STD : lastTier)
        }
        lastTier = tier
        return setTier(RAIL_TIER_MIN)
      }

      function clearAnimationTimer() {
        if (animationTimer !== null) {
          clearTimer(animationTimer)
          animationTimer = null
        }
      }

      function finishAnimation() {
        animationTimer = null
        isAnimating = false
        if (rail !== null) rail.removeAttribute('data-animating')
        if (geometryDirty) {
          geometryDirty = false
          syncGeometry()
        }
      }

      /**
       * 隐藏量尺：量当前最大轮号的实际文本宽。
       *
       * 量尺在 rail 内，字体/字重和 min 档数字完全一致；同一文本只量一次，
       * 大纲刷新、行重建导致最大轮号变化时重新量。
       */
      function refreshMinMeasure(maxTurn) {
        if (measureEl === null) return measuredTextWidth
        var text = String(Math.max(1, Math.floor(Number(maxTurn) || 1)))
        if (measuredText === text && measuredTextWidth > 0) return measuredTextWidth
        measureEl.textContent = text
        var width = 0
        try {
          if (typeof measureEl.getBoundingClientRect === 'function') {
            var rect = measureEl.getBoundingClientRect()
            width = rect === null || rect === undefined ? 0 : Number(rect.width) || 0
          }
          if (!(width > 0)) width = Number(measureEl.scrollWidth) || 0
          if (!(width > 0)) width = Number(measureEl.offsetWidth) || 0
        } catch (error) { width = 0 }
        if (!(width > 0)) return measuredTextWidth
        measuredText = text
        measuredTextWidth = width
        return measuredTextWidth
      }

      /** 用 row 的真实 scrollWidth/clientWidth 迭代补宽，最多 3 次。 */
      function fitMinWidth(maxTurn) {
        var measured = refreshMinMeasure(maxTurn)
        if (!(measured > 0)) return metrics.min
        if (fitMinText === measuredText && fittedMinWidth > 0) {
          metrics.min = fittedMinWidth
          return fittedMinWidth
        }
        var width = railInitialMinWidth(measured)
        fitMinIterations = 0
        try { rail.style.width = width + 'px' } catch (error) { /* 保留候选值 */ }
        for (var i = 0; i < 3; i += 1) {
          var row = rowsBox !== null && typeof rowsBox.querySelector === 'function'
            ? rowsBox.querySelector('.dsh_tm_railrow') : null
          if (row === null) break
          fitMinIterations += 1
          var overflow = (Number(row.scrollWidth) || 0) - (Number(row.clientWidth) || 0)
          if (!(overflow > 0)) break
          width += Math.ceil(overflow) + 1
          try { rail.style.width = width + 'px' } catch (error) { /* 下一轮再读 */ }
        }
        fitMinText = measuredText
        fittedMinWidth = width
        metrics.min = width
        return width
      }

      /** 把档位宽度/数字列宽写成 CSS 变量；宽度瞬变，不用裁剪。 */
      function applyRailVars() {
        if (rail === null) return
        var maxTurn = maxTurnOfRows()
        var tierValue = effectiveTier()
        refreshMinMeasure(maxTurn)
        var visible = tierValue === RAIL_TIER_MIN
          ? fitMinWidth(maxTurn)
          : (tierValue === RAIL_TIER_MAX ? Math.round(metrics.max) : Math.round(metrics.std))
        var maxWidth = Math.max(visible, Math.round(metrics.max))
        try {
          if (typeof rail.style.setProperty === 'function') {
            rail.style.setProperty('--dsh-tm-rail-visible-width', visible + 'px')
            rail.style.setProperty('--dsh-tm-rail-num-width', Math.round(measuredTextWidth) + 'px')
            rail.style.setProperty('--dsh-tm-rail-max-width', maxWidth + 'px')
          } else {
            rail.style['--dsh-tm-rail-visible-width'] = visible + 'px'
            rail.style['--dsh-tm-rail-num-width'] = Math.round(measuredTextWidth) + 'px'
            rail.style['--dsh-tm-rail-max-width'] = maxWidth + 'px'
          }
          // 轨道宽度直接等于当前档位宽度；max 变量只给 std/max 的自适应公式用。
          if (rail.style.width !== visible + 'px') rail.style.width = visible + 'px'
          rail.style.clipPath = 'none'
        } catch (error) { /* 样式不可写时保留基础样式 */ }
      }

      function applyPresentation() {
        if (rail === null) return
        var value = effectiveTier()
        applyRailVars()
        if (rail.style !== undefined && rail.style !== null) rail.style.visibility = dockObscured ? 'hidden' : ''
        rail.setAttribute('data-tier', value)
        rail.setAttribute('data-autohide', autoMin ? '1' : '0')
        if (rowsBox !== null && outlineSegments.length > 0 && rows.length > 0) {
          renderRows()
          if (activeTurn !== null) applyActive(activeTurn)
        }
        if (lastEffectiveTier !== null && lastEffectiveTier !== value) {
          isAnimating = true
          rail.setAttribute('data-animating', '1')
          clearAnimationTimer()
          animationTimer = setTimer(function () {
            animationTimer = null
            finishAnimation()
          }, RAIL_ANIM_MS)
        }
        lastEffectiveTier = value
        var next = nextTierOf(value)
        if (railHead !== null) {
          railHead.setAttribute('title', '轨道档位：' + railTierLabel(value) + '（点击切到' + railTierLabel(next) + '）')
          railHead.setAttribute('aria-expanded', value === RAIL_TIER_MIN ? 'false' : 'true')
        }
        if (tierBtn !== null) {
          tierBtn.textContent = railTierIcon(value)
          tierBtn.title = '当前：' + railTierLabel(value) + '，点击切到' + railTierLabel(next)
          tierBtn.setAttribute('aria-label', '轨道档位：' + railTierLabel(value))
        }
      }

      /** 容器尺寸变化：rAF 合并，std/max 变化超过 8px 才重排。 */
      function scheduleMetrics() {
        if (metricsRaf !== null) return
        var run = function () {
          metricsRaf = null
          if (disposed || rail === null) return
          var before = { std: metrics.std, max: metrics.max, height: metrics.containerH }
          computeMetrics()
          if (Math.abs(metrics.std - before.std) <= RAIL_RESIZE_EPSILON
            && Math.abs(metrics.max - before.max) <= RAIL_RESIZE_EPSILON) {
            if (Math.abs(metrics.containerH - before.height) > 1) syncGeometry()
            return
          }
          applyRailVars()
          applyPresentation()
          if (Math.abs(metrics.containerH - before.height) > 1) syncGeometry()
        }
        if (win !== null && typeof win.requestAnimationFrame === 'function') {
          metricsRaf = win.requestAnimationFrame(run)
        } else {
          metricsRaf = setTimer(run, 16)
        }
      }

      function observeContainer() {
        if (containerObserver !== null) {
          try { containerObserver.disconnect() } catch (error) { /* 已断开 */ }
          containerObserver = null
        }
        var Observer = win !== null && win.ResizeObserver !== undefined ? win.ResizeObserver
          : (typeof ResizeObserver === 'function' ? ResizeObserver : null)
        var scroller = scrollerOf()
        if (Observer === null || scroller === null || scroller === undefined) return
        try {
          containerObserver = new Observer(function () { scheduleMetrics() })
          containerObserver.observe(scroller)
        } catch (error) { containerObserver = null }
      }

      // ── 原生轨定位 ────────────────────────────────────────────────
      /** 后台会话的容器也在 DOM 里但 hidden；优先接当前可见的那一个。 */
      function isVisibleNav(native) {
        try {
          if (native === null || typeof native.closest !== 'function') return true
          var root = native.closest('[data-conversation-session]')
          if (root === null || root === undefined) return true
          if (root.hidden === true) return false
          if (typeof root.getAttribute === 'function' && root.getAttribute('hidden') !== null) return false
          return true
        } catch (error) {
          return true
        }
      }

      function findNav() {
        if (doc === null || typeof doc.querySelectorAll !== 'function') return null
        var candidates = []
        var selectors = [
          '[data-conversation-scroll] nav[aria-label="轮次导航"]',
          '[data-conversation-scroll] nav[aria-label="Turn navigation"]',
        ]
        for (var i = 0; i < selectors.length; i += 1) {
          var found = doc.querySelectorAll(selectors[i])
          for (var j = 0; j < found.length; j += 1) candidates.push(found[j])
        }
        // aria-label 来自宿主 locale，未来换文案时上面的选择器会全部落空。
        // 结构兜底：滚动容器里唯一一种「nav 内含 data-index 按钮」的组件就是轮次轨。
        if (candidates.length === 0) {
          var navs = doc.querySelectorAll('[data-conversation-scroll] nav')
          for (var k = 0; k < navs.length; k += 1) {
            if (typeof navs[k].querySelector !== 'function') continue
            if (navs[k].querySelector('button[data-index]') !== null) candidates.push(navs[k])
          }
        }
        for (var n = 0; n < candidates.length; n += 1) {
          if (isVisibleNav(candidates[n])) return candidates[n]
        }
        return candidates.length === 0 ? null : candidates[0]
      }

      /** 原生容器快照：容器 + 当前虚拟窗口里的按钮属性。 */
      function snapshotOf(native) {
        var buttons = []
        if (native !== null && native !== undefined && typeof native.querySelectorAll === 'function') {
          var list = native.querySelectorAll('button[data-index]')
          for (var i = 0; i < list.length; i += 1) {
            var node = list[i]
            var read = function (name) {
              return node !== null && node !== undefined && typeof node.getAttribute === 'function'
                ? node.getAttribute(name) : null
            }
            buttons.push({
              dataIndex: read('data-index'),
              ariaLabel: read('aria-label'),
              ariaCurrent: read('aria-current'),
              ariaBusy: read('aria-busy'),
            })
          }
        }
        return { container: native, buttons: buttons }
      }

      // ── 原生轨隐藏 / 恢复 ────────────────────────────────────────
      /**
       * 一次性注入 CSS。
       *
       * React 重渲染可能把 nav 上的 inline style 清掉；属性 + 带 !important
       * 的样式表比 inline style 更抗覆写。样式只注入一次，卸载时移除。
       */
      function ensureNativeHideStyle() {
        if (nativeStyleEl !== null && nativeStyleEl !== undefined
          && (nativeStyleEl.isConnected !== false || nativeStyleEl.parentElement !== null)) {
          return
        }
        if (doc === null || typeof doc.createElement !== 'function') return
        try {
          var existing = typeof doc.getElementById === 'function'
            ? doc.getElementById(RAIL_NATIVE_HIDE_STYLE_ID)
            : null
          if (existing !== null && existing !== undefined) {
            nativeStyleEl = existing
            return
          }
          var style = doc.createElement('style')
          style.id = RAIL_NATIVE_HIDE_STYLE_ID
          style.textContent = RAIL_NATIVE_HIDE_CSS
          var parent = doc.head !== null && doc.head !== undefined ? doc.head : doc.body
          if (parent !== null && parent !== undefined && typeof parent.appendChild === 'function') {
            parent.appendChild(style)
            nativeStyleEl = style
          }
        } catch (error) { /* 样式注入失败还有 inline style 兜底 */ }
      }

      function removeNativeHideStyle() {
        if (nativeStyleEl !== null && nativeStyleEl !== undefined
          && nativeStyleEl.parentElement !== null && nativeStyleEl.parentElement !== undefined
          && typeof nativeStyleEl.parentElement.removeChild === 'function') {
          try { nativeStyleEl.parentElement.removeChild(nativeStyleEl) } catch (error) { /* 已移除 */ }
        }
        nativeStyleEl = null
      }

      /** 幂等打标：属性、aria、inline style 三者缺一补一。 */
      function ensureNativeHidden(native) {
        if (native === null || native === undefined) return false
        var changed = false
        if (native.getAttribute === null || native.getAttribute === undefined
          || native.getAttribute('data-dsh-tm-native') !== 'hidden') {
          if (typeof native.setAttribute === 'function') native.setAttribute('data-dsh-tm-native', 'hidden')
          changed = true
        }
        if (native.getAttribute === null || native.getAttribute === undefined
          || native.getAttribute('aria-hidden') !== 'true') {
          if (typeof native.setAttribute === 'function') native.setAttribute('aria-hidden', 'true')
          changed = true
        }
        if (native.style !== undefined && native.style !== null) {
          if (native.style.visibility !== 'hidden') {
            if (typeof native.style.setProperty === 'function') {
              try { native.style.setProperty('visibility', 'hidden', 'important') } catch (error) { native.style.visibility = 'hidden' }
            } else {
              native.style.visibility = 'hidden'
            }
            changed = true
          }
        }
        return changed
      }

      function hideNative(native) {
        if (native === null || native === undefined) return
        ensureNativeHideStyle()
        ensureNativeHidden(native)
      }

      function restoreNative(native) {
        if (native === null || native === undefined) return
        if (native.style !== undefined && native.style !== null) {
          if (typeof native.style.removeProperty === 'function') {
            try { native.style.removeProperty('visibility') } catch (error) { native.style.visibility = '' }
          } else {
            native.style.visibility = ''
          }
        }
        if (typeof native.removeAttribute === 'function') {
          native.removeAttribute('aria-hidden')
          native.removeAttribute('data-dsh-tm-native')
        }
      }

      function sessionOf(native) {
        try {
          if (native !== null && typeof native.closest === 'function') {
            var root = native.closest('[data-conversation-session]')
            if (root !== null && root !== undefined && typeof root.getAttribute === 'function') {
              var value = root.getAttribute('data-conversation-session')
              return value === null || value === undefined ? '' : String(value)
            }
          }
        } catch (error) { /* 没有 closest 就退化成无会话 */ }
        return ''
      }

      function scrollerOf() {
        try {
          if (nav !== null && typeof nav.closest === 'function') {
            var inner = nav.closest('[data-conversation-scroll]')
            if (inner !== null && inner !== undefined) return inner
          }
        } catch (error) { /* 忽略 */ }
        if (doc !== null && typeof doc.querySelector === 'function') return doc.querySelector('[data-conversation-scroll]')
        return null
      }

      function el(tag, className, text) {
        var node = doc.createElement(tag)
        if (className !== undefined) node.className = className
        if (text !== undefined) node.textContent = text
        return node
      }

      // ── 渲染 ──────────────────────────────────────────────────────
      /** 与原生 frame 同坐标系：同父节点、同样 absolute，top / max-height 自适应容器。 */
      function syncGeometry() {
        if (rail === null || nav === null) return
        if (isAnimating) {
          geometryDirty = true
          return
        }
        computeMetrics()
        applyRailVars()
        if (win === null || typeof win.getComputedStyle !== 'function') return
        var computed = null
        try { computed = win.getComputedStyle(nav) } catch (error) { computed = null }
        if (computed === null || computed === undefined) return
        var right = computed.right
        var top = computed.top
        rail.style.right = right === undefined || right === null || right === '' || right === 'auto' ? '12px' : right
        rail.style.top = top === undefined || top === null || top === '' || top === 'auto' ? '50%' : top
        var viewportHeight = win !== null && Number.isFinite(Number(win.innerHeight)) ? Number(win.innerHeight) : 720
        var containerHeight = Number(metrics.containerH) || 0
        var limit = containerHeight > 0 && containerHeight < 500
          ? Math.min(viewportHeight * 0.4, containerHeight - 80)
          : Math.min(viewportHeight * 0.5, containerHeight > 0 ? containerHeight - 120 : viewportHeight * 0.5)
        rail.style.maxHeight = Math.max(120, Math.round(limit)) + 'px'
      }

      /** 当前档位是否展示「段 → 轮次」段头分隔行（仅 std / max 档且有段时启用）。 */
      function railSegmentsActive() {
        return effectiveTier() !== RAIL_TIER_MIN
          && Array.isArray(outlineSegments)
          && outlineSegments.length > 0
          && view !== null
          && typeof view.segmentGroupsOf === 'function'
      }

      /** 行数据的稳定签名：含行集合与文本（含段头签名），不含 active/hit（它们用属性更新）。 */
      function rowsDataSignature() {
        var parts = []
        var useSegs = railSegmentsActive()
        parts.push(useSegs ? 'seg:1' : 'seg:0')
        if (useSegs) {
          for (var s = 0; s < outlineSegments.length; s += 1) {
            var seg = outlineSegments[s]
            if (seg !== null && seg !== undefined && typeof seg === 'object') {
              parts.push('S|' + String(seg.id || '') + '|' + String(seg.title || '') + '|' + String(seg.startTurn || '') + '|' + String(seg.endTurn || '') + '|' + String(seg.kindCandidate || ''))
            }
          }
        }
        for (var i = 0; i < rows.length; i += 1) {
          var row = rows[i]
          parts.push(row.turn + '|' + row.index + '|' + row.label + '|' + row.timeText)
        }
        return parts.join('\n')
      }

      /** 原生按钮快照签名：用于判断「按钮/aria-label 集合」是否发生结构变化。 */
      function buttonsSignature(buttons) {
        var parts = []
        var list = Array.isArray(buttons) ? buttons : []
        for (var i = 0; i < list.length; i += 1) {
          parts.push(String(list[i].dataIndex === undefined ? '' : list[i].dataIndex)
            + ':' + String(list[i].ariaLabel === undefined ? '' : list[i].ariaLabel))
        }
        return parts.join('\n')
      }

      function renderRows() {
        if (rowsBox === null) return
        applyRailVars()
        var signature = rowsDataSignature()
        // 行集合与文本都没变就不动 DOM；active/hit 是高频属性，走 applyActive/applyHitAttributes。
        if (signature === lastRowsSignature && rowsBox.firstChild !== null && rowsBox.firstChild !== undefined) {
          applyHitAttributes()
          return
        }
        lastRowsSignature = signature
        fitMinText = ''
        fittedMinWidth = 0
        while (rowsBox.firstChild !== null && rowsBox.firstChild !== undefined) {
          rowsBox.removeChild(rowsBox.firstChild)
        }
        rowEls = new Map()
        segHeaderEls = []
        function appendTurnRow(row) {
          var button = el('button', 'dsh_tm_railrow')
          button.type = 'button'
          button.setAttribute('data-turn', String(row.turn))
          button.setAttribute('data-index', String(row.index))
          button.setAttribute('data-active', row.active === true ? '1' : '0')
          if (row.hit === true) button.setAttribute('data-hit', '1')
          button.title = row.label === '' ? '第 ' + row.turn + ' 轮' : '第 ' + row.turn + ' 轮 · ' + row.label
          var displayLabel = railSummaryText(row.label)
          button.appendChild(el('span', 'dsh_tm_railtick'))
          button.appendChild(el('span', 'dsh_tm_railnum', String(row.turn)))
          button.appendChild(el('span',
            displayLabel === '' ? 'dsh_tm_railtext dsh_tm_railnohead' : 'dsh_tm_railtext',
            displayLabel === '' ? '（无摘要）' : displayLabel))
          button.appendChild(el('span', 'dsh_tm_railtime', railTimeText(row.timeText)))
          rowsBox.appendChild(button)
          rowEls.set(row.turn, button)
        }
        var groups = railSegmentsActive() ? view.segmentGroupsOf(rows, outlineSegments) : []
        if (groups.length > 0) {
          for (var g = 0; g < groups.length; g += 1) {
            var group = groups[g]
            var firstTurn = Array.isArray(group.rows) && group.rows.length > 0
              ? Number(group.rows[0].turn)
              : Number(group.startTurn)
            var rangeText = group.startTurn === group.endTurn
              ? ('#' + group.startTurn)
              : ('#' + group.startTurn + '–#' + group.endTurn)
            var segBtn = el('button', 'dsh_tm_railseg')
            segBtn.type = 'button'
            segBtn.setAttribute('data-segment-id', String(group.id || ''))
            segBtn.setAttribute('data-turn', String(firstTurn))
            segBtn.setAttribute('data-kind', group.kindCandidate === 'work' ? 'work' : 'chat')
            segBtn.setAttribute('data-active', group.active === true ? '1' : '0')
            if (group.hasError === true) segBtn.setAttribute('data-error', '1')
            segBtn.title = group.title + '（' + rangeText + '）'
            segBtn.appendChild(el('span', 'dsh_tm_railsegdot'))
            segBtn.appendChild(el('span', 'dsh_tm_railsegtitle', group.title))
            segBtn.appendChild(el('span', 'dsh_tm_railsegrange', rangeText))
            rowsBox.appendChild(segBtn)
            segHeaderEls.push({ el: segBtn, startTurn: group.startTurn, endTurn: group.endTurn })
            for (var r = 0; r < group.rows.length; r += 1) {
              appendTurnRow(group.rows[r])
            }
          }
        } else {
          for (var i = 0; i < rows.length; i += 1) {
            appendTurnRow(rows[i])
          }
        }
        // 行集合重建后再量一次：最大轮号变了，min 档宽度必须跟着收敛。
        applyRailVars()
      }

      /** 只改 active 属性，不重建 DOM：滚动/aria-current 变化是高频路径。 */
      function applyActive(turn) {
        var next = Number(turn)
        if (!Number.isFinite(next)) return
        var changed = activeTurn !== next
        var previous = activeTurn
        activeTurn = next
        for (var i = 0; i < rows.length; i += 1) {
          rows[i].active = rows[i].turn === next
        }
        // 只写上一个/当前两个按钮的 data-active，避免每次滚动全量写属性。
        if (previous !== null && previous !== next) {
          var oldButton = rowEls.get(previous)
          if (oldButton !== undefined) oldButton.setAttribute('data-active', '0')
        }
        var button = rowEls.get(next)
        if (button !== undefined && button.getAttribute('data-active') !== '1') {
          button.setAttribute('data-active', '1')
        }
        for (var s = 0; s < segHeaderEls.length; s += 1) {
          var segEntry = segHeaderEls[s]
          var segOn = next >= segEntry.startTurn && next <= segEntry.endTurn ? '1' : '0'
          if (segEntry.el.getAttribute('data-active') !== segOn) {
            segEntry.el.setAttribute('data-active', segOn)
          }
        }
        if (changed) revealTurn(next)
      }

      function revealTurn(turn) {
        var button = rowEls.get(turn)
        if (button === undefined || rowsBox === null) return
        var top = Number(button.offsetTop)
        var height = Number(button.offsetHeight)
        var viewHeight = Number(rowsBox.clientHeight)
        if (!Number.isFinite(top) || !Number.isFinite(height) || !Number.isFinite(viewHeight) || viewHeight <= 0) return
        var current = Number(rowsBox.scrollTop)
        if (!Number.isFinite(current)) current = 0
        if (top < current) rowsBox.scrollTop = top
        else if (top + height > current + viewHeight) rowsBox.scrollTop = top + height - viewHeight
      }

      function setNote(text) {
        if (noteEl === null) return
        noteEl.textContent = text === null || text === undefined ? '' : String(text)
      }

      // ── 活动轮 ────────────────────────────────────────────────────
      function activeTurnFromNative() {
        if (nav === null || typeof nav.querySelector !== 'function') return null
        var button = nav.querySelector('button[aria-current="true"]')
        if (button === null || button === undefined) return null
        var turn = typeof button.getAttribute === 'function' ? view.turnOfLabel(button.getAttribute('aria-label')) : null
        if (turn !== null) return turn
        var index = Number(button.getAttribute('data-index'))
        if (Number.isInteger(index) && index >= 0 && index < outlineTurns.length) return outlineTurns[index]
        return null
      }

      /**
       * 活动刻度被虚拟化移出 DOM 时的兜底：取视口顶部第一条可见轮次行。
       * 这与宿主自己的 activeTurn 语义一致（「当前读到的轮」）。
       */
      function activeTurnFromScroll() {
        var scroller = scrollerOf()
        if (scroller === null || typeof scroller.querySelectorAll !== 'function') return null
        if (typeof scroller.getBoundingClientRect !== 'function') return null
        var top = scroller.getBoundingClientRect().top
        var list = scroller.querySelectorAll('[data-chat-turn]')
        var bestTop = null
        var bestTurn = null
        for (var i = 0; i < list.length; i += 1) {
          var node = list[i]
          if (typeof node.getBoundingClientRect !== 'function') continue
          var rect = node.getBoundingClientRect()
          if (rect === null || !Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) continue
          if (rect.bottom <= top + 1) continue
          var turn = Number(node.getAttribute('data-chat-turn'))
          if (!Number.isFinite(turn)) continue
          if (bestTop === null || rect.top < bestTop) { bestTop = rect.top; bestTurn = turn }
        }
        return bestTurn
      }

      function syncActive() {
        if (disposed || !mounted) return
        var scroller = scrollerOf()
        var turn = resolveActiveTurn(scroller)
        if (turn === null) turn = activeTurnFromNative()
        if (turn !== null) {
          TOPIC_ACTIVE.set(sessionId, turn)
          applyActive(turn)
        }
      }

      /** 滚动：rAF 合并同一帧，再延迟 80ms 取稳定位置。 */
      function scheduleActive() {
        if (disposed || activeTimer !== null || activeRaf !== null) return
        var run = function () {
          activeRaf = null
          activeTimer = setTimer(function () {
            activeTimer = null
            syncActive()
          }, RAIL_ACTIVE_DELAY_MS)
        }
        if (win !== null && typeof win.requestAnimationFrame === 'function') {
          activeRaf = win.requestAnimationFrame(run)
        } else {
          run()
        }
      }

      /** 程序化跳转后 150/300/450ms 各校验一次，最终以实际位置为准。 */
      function retryActiveFor(target) {
        var delays = [150, 300, 450]
        for (var i = 0; i < delays.length; i += 1) {
          setTimer(function () {
            if (disposed || !mounted) return
            syncActive()
            if (activeTurn === target) return
          }, delays[i])
        }
      }

      // ── 点击跳转 ──────────────────────────────────────────────────
      function onRowsClick(event) {
        var target = event === null || event === undefined ? null : event.target
        if (target === null || typeof target.closest !== 'function') return
        var button = target.closest('.dsh_tm_railrow') || target.closest('.dsh_tm_railseg')
        if (button === null || button === undefined) return
        var turn = Number(button.getAttribute('data-turn'))
        if (!Number.isFinite(turn)) return
        if (typeof host.jump !== 'function') return
        var seq = null
        for (var i = 0; i < outline.length; i += 1) {
          if (Number(outline[i].turn) === turn) { seq = outline[i].endSeq; break }
        }
        retryActiveFor(turn)
        try {
          var result = host.jump({ sessionId: sessionId, turn: turn, seq: seq, turns: outlineTurns.slice(), nav: nav })
          if (result !== null && result !== undefined && typeof result.then === 'function') {
            result.then(function (settled) {
              if (settled !== null && settled !== undefined && settled.ok === false) {
                note('历史轨跳转失败：' + (settled.reason === undefined ? '未知原因' : settled.reason))
              }
            }, function (error) {
              note('历史轨跳转异常：' + (error === null || error === undefined ? '未知错误' : String(error.message || error)))
            })
          }
        } catch (error) {
          note('历史轨跳转异常：' + (error === null || error === undefined ? '未知错误' : String(error.message || error)))
        }
      }

      // ── 大纲加载与降级 ────────────────────────────────────────────
      function applyOutline(entry) {
        var raw = entry !== null && entry !== undefined && Array.isArray(entry.turns) ? entry.turns : []
        var clean = []
        var seen = {}
        for (var i = 0; i < raw.length; i += 1) {
          var item = raw[i]
          if (item === null || typeof item !== 'object') continue
          var turn = Number(item.turn)
          if (!Number.isFinite(turn) || seen[turn] === true) continue
          seen[turn] = true
          clean.push(item)
        }
        // 与原生 mergeTurnRailItems 同序：按 turn 升序。行序必须和 data-index 对齐，
        // 否则 active 回映射会整体偏移。
        clean.sort(function (left, right) { return Number(left.turn) - Number(right.turn) })
        outlineAvailable = entry === null || entry === undefined || entry.available !== false
        outline = clean
        outlineTurns = clean.map(function (item) { return Number(item.turn) })
        outlineSegments = entry !== null && entry !== undefined && Array.isArray(entry.segments) ? entry.segments : []
        if (clean.length > 0) {
          var nodes = clean.map(function (item, index) {
            var turn = Number(item.turn)
            return {
              index: index,
              turn: turn,
              promptHead: item.promptHead,
              time: item.time,
              hit: currentHits.has(turn),
            }
          })
          rows = view.rowsOf(nodes, { turns: outlineTurns })
          setNote('')
          renderRows()
          lastNativeSignature = buttonsSignature(snapshotOf(nav).buttons)
          if (activeTurn !== null) applyActive(activeTurn)
          syncActive()
          return
        }
        // 端点没上线 / 还没有大纲：退回原生已渲染的刻度，用 aria-label 解析轮号。
        renderFromNative()
        if (outlineAvailable === false) setNote('轮次摘要不可用（接口未就绪），只显示已渲染刻度')
        else setNote('')
        if (activeTurn !== null) applyActive(activeTurn)
        syncActive()
      }

      function renderFromNative() {
        var snapshot = snapshotOf(nav)
        rows = view.rowsOf(snapshot.buttons, { turns: outlineTurns.length > 0 ? outlineTurns : undefined })
        for (var i = 0; i < rows.length; i += 1) rows[i].hit = currentHits.has(Number(rows[i].turn))
        renderRows()
      }

      function loadOutlineForRail() {
        // 换会话或第一次接管时清掉上一会话的大纲，避免行号串台。
        if (outlineSessionId !== sessionId) {
          outlineSessionId = sessionId
          outline = []
          outlineTurns = []
          outlineSegments = []
          outlineAvailable = true
        }
        if (sessionId === '' || typeof host.loadOutline !== 'function') {
          var emptyEntry = { available: false, turns: [], segments: [] }
          outlineCache.set(sessionId === '' ? '<none>' : sessionId, { at: Date.now(), available: false, turns: [], segments: [] })
          applyOutline(emptyEntry)
          return
        }
        var cached = outlineCache.get(sessionId)
        if (cached !== undefined && Date.now() - cached.at < RAIL_OUTLINE_TTL_MS) {
          applyOutline(cached)
          return
        }
        if (outlinePendingFor === sessionId) return
        outlinePendingFor = sessionId
        var wanted = sessionId
        var pending = null
        try { pending = host.loadOutline(wanted) } catch (error) { pending = null }
        Promise.resolve(pending).then(function (result) {
          if (outlinePendingFor === wanted) outlinePendingFor = ''
          if (disposed) return
          var turns = result !== null && result !== undefined && Array.isArray(result.turns) ? result.turns : []
          var segments = result !== null && result !== undefined && Array.isArray(result.segments) ? result.segments : []
          var entry = {
            at: Date.now(),
            available: result !== null && result !== undefined && result.available !== false,
            turns: turns,
            segments: segments,
          }
          outlineCache.set(wanted, entry)
          if (wanted !== sessionId) return
          applyOutline(entry)
        }, function () {
          if (outlinePendingFor === wanted) outlinePendingFor = ''
          if (disposed || wanted !== sessionId) return
          var entry = { at: Date.now(), available: false, turns: [], segments: [] }
          outlineCache.set(wanted, entry)
          applyOutline(entry)
        })
      }

      // ── 结构变化检查（只在按钮集合/aria-label 变化时重建行）────────
      //
      // 原生轨是虚拟列表：滚动时 DOM 里的按钮窗口本来就会变，不能拿它当
      // 「有新轮次」的信号。这里用 200ms 合并检查：
      //   - 已有大纲：只盯「是否出现超过大纲最大轮号的新轮」，有才后台刷新
      //     大纲；虚拟窗口滑动不重建 DOM。
      //   - 没有大纲（降级）：滚动停止后再按当前原生刻度重建，避免滚动中重建。

      function scheduleRowCheck() {
        if (disposed || rowTimer !== null) return
        rowTimer = setTimer(function () {
          rowTimer = null
          maybeRefreshRows()
        }, RAIL_ROW_CHECK_DELAY_MS)
      }

      function scheduleScrollSettle() {
        if (disposed || scrollSettleTimer !== null) return
        scrollSettleTimer = setTimer(function () {
          scrollSettleTimer = null
          maybeRefreshRows()
        }, RAIL_SCROLL_SETTLE_MS)
      }

      function scheduleOutlineRefresh() {
        if (disposed || outlineRefreshTimer !== null) return
        outlineRefreshTimer = setTimer(function () {
          outlineRefreshTimer = null
          if (disposed || sessionId === '') return
          // 新轮次不在缓存里：丢掉本会话缓存，重新拉一次窄大纲。
          outlineCache.delete(sessionId)
          loadOutlineForRail()
        }, RAIL_OUTLINE_REFRESH_DELAY_MS)
      }

      function maybeRefreshRows() {
        if (disposed || !mounted || rail === null || nav === null) return
        // 滚动期间原生虚拟列表的按钮窗口本来就会变；等滚动停下再做结构比较，
        // 避免把「虚拟窗口滑动」误判成新轮次。
        if (lastScrollAt > 0 && Date.now() - lastScrollAt < RAIL_SCROLL_SETTLE_MS) {
          scheduleScrollSettle()
          return
        }
        var snapshot = snapshotOf(nav)
        var signature = buttonsSignature(snapshot.buttons)
        if (signature === lastNativeSignature) {
          syncActive()
          return
        }
        lastNativeSignature = signature

        var outlineMax = 0
        for (var i = 0; i < outlineTurns.length; i += 1) {
          if (outlineTurns[i] > outlineMax) outlineMax = outlineTurns[i]
        }
        var nativeRows = view.rowsOf(snapshot.buttons, {
          turns: outlineTurns.length > 0 ? outlineTurns : undefined,
        })
        var hasNewTurn = false
        for (var k = 0; k < nativeRows.length; k += 1) {
          if (Number(nativeRows[k].turn) > outlineMax) { hasNewTurn = true; break }
        }

        if (outline.length > 0) {
          // 有大纲时行集合来自大纲；只有「出现大纲外的新轮」才值得重新拉。
          if (hasNewTurn) scheduleOutlineRefresh()
          syncActive()
          return
        }

        // 降级模式：滚动已停（前面已做 settle 检查），按当前原生刻度对齐一次。
        renderFromNative()
        syncActive()
      }

      // ── 自动最小化 / ⋯ 菜单 ───────────────────────────────────────
      //
      // 离开 600ms 切到 min 档（仍显示轮号），只改临时 autoMin；
      // 移入回到用户档位，不写按会话持久化的档位。
 
      function clearAutoHideTimer() {
        if (autoHideTimer !== null) {
          clearTimer(autoHideTimer)
          autoHideTimer = null
        }
      }

      /** 统一清理轨道自己的全部定时器（卸载/重挂载/测试开关都走这里）。 */
      function clearRailTimers() {
        clearAutoHideTimer()
        if (rowTimer !== null) { clearTimer(rowTimer); rowTimer = null }
        if (outlineRefreshTimer !== null) { clearTimer(outlineRefreshTimer); outlineRefreshTimer = null }
        if (scrollSettleTimer !== null) { clearTimer(scrollSettleTimer); scrollSettleTimer = null }
        if (nativeCheckTimer !== null) { clearTimer(nativeCheckTimer); nativeCheckTimer = null }
        if (animationTimer !== null) { clearTimer(animationTimer); animationTimer = null }
        if (hoverRaf !== null) {
          if (win !== null && typeof win.cancelAnimationFrame === 'function') {
            try { win.cancelAnimationFrame(hoverRaf) } catch (error) { /* 已结束 */ }
          } else {
            clearTimer(hoverRaf)
          }
          hoverRaf = null
        }
        hoverPending = ''
      }

      function scheduleAutoHide() {
        if (rail === null || !autoHideEnabled() || effectiveTier() === RAIL_TIER_MIN) return
        clearAutoHideTimer()
        autoHideTimer = setTimer(function () {
          autoHideTimer = null
          if (disposed || rail === null) return
          autoMin = true
          closeMoreMenu()
          applyPresentation()
        }, RAIL_AUTO_HIDE_DELAY_MS)
      }

      function applyHoverEnter() {
        clearAutoHideTimer()
        if (!autoMin) return
        autoMin = false
        applyPresentation()
      }

      function applyHoverLeave() {
        scheduleAutoHide()
      }

      /**
       * hover 合帧：同一帧内多次 enter/leave 只处理最后一个状态。
       * 回调里只切状态/属性，不做 DOM 重建或几何测量。
       */
      function queueHover(action) {
        hoverPending = action
        if (hoverRaf !== null) return
        var run = function () {
          hoverRaf = null
          var next = hoverPending
          hoverPending = ''
          if (next === 'enter') applyHoverEnter()
          else if (next === 'leave') applyHoverLeave()
        }
        if (win !== null && typeof win.requestAnimationFrame === 'function') {
          hoverRaf = win.requestAnimationFrame(run)
        } else {
          // 测试/旧环境没有 rAF 时同步执行，保持行为可预测。
          run()
        }
      }

      function onRailEnter() {
        clearAutoHideTimer()
        queueHover('enter')
      }

      function onRailLeave() {
        queueHover('leave')
      }

      function menuNode() {
        return el('div', 'dsh_tm_railmenu')
      }

      function menuItem(label, checked, onClick) {
        var button = el('button', 'dsh_tm_railmenuitem')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        if (checked !== null && checked !== undefined) {
          button.setAttribute('data-checked', checked === true ? '1' : '0')
          button.setAttribute('aria-checked', checked === true ? 'true' : 'false')
          button.appendChild(el('span', 'dsh_tm_railmenucheck', checked === true ? '✓' : '○'))
        }
        button.appendChild(el('span', 'dsh_tm_railmenutext', label))
        if (typeof button.addEventListener === 'function') {
          button.addEventListener('click', function (event) {
            if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') {
              event.stopPropagation()
            }
            try { onClick() } catch (error) { note('历史轨设置失败：' + String(error && error.message ? error.message : error)) }
            closeMoreMenu()
          })
        }
        return button
      }

      function closeMoreMenu() {
        if (menuOutsideBound && doc !== null && typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('pointerdown', onDocPointerDown, true)
          menuOutsideBound = false
        }
        if (menuEl !== null) {
          if (menuEl.parentElement !== null && menuEl.parentElement !== undefined
            && typeof menuEl.parentElement.removeChild === 'function') {
            menuEl.parentElement.removeChild(menuEl)
          }
          menuEl = null
        }
        if (moreBtn !== null) moreBtn.setAttribute('aria-expanded', 'false')
      }

      function onDocPointerDown(event) {
        if (menuEl === null) return
        var target = event === null || event === undefined ? null : event.target
        if (target !== null && typeof target.closest === 'function') {
          if (target.closest('.dsh_tm_railmenu') !== null) return
          if (target.closest('.dsh_tm_railmore') !== null) return
        }
        closeMoreMenu()
      }

      /** 一个元素在右上角诊断里的字段。 */
      function topRightInfo(el) {
        var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
        var style = null
        try {
          if (win !== null && typeof win.getComputedStyle === 'function') style = win.getComputedStyle(el)
        } catch (error) { style = null }
        var className = typeof el.className === 'string' ? el.className.slice(0, 80) : ''
        var background = style === null ? '' : String(style.backgroundImage || '')
        return {
          tag: String(el.tagName || '').toLowerCase(),
          cls: className,
          id: String(el.id || ''),
          rect: {
            x: rect === null ? 0 : Math.round(Number(rect.x) || 0),
            y: rect === null ? 0 : Math.round(Number(rect.y) || 0),
            w: rect === null ? 0 : Math.round(Number(rect.width) || 0),
            h: rect === null ? 0 : Math.round(Number(rect.height) || 0),
          },
          pos: style === null ? '' : String(style.position || ''),
          z: style === null ? '' : String(style.zIndex || ''),
          shadow: style === null ? '' : String(style.boxShadow || '').slice(0, 80),
          bg: background !== 'none' ? 'gradient' : (style === null ? '' : String(style.backgroundColor || '')),
          opacity: style === null ? '' : String(style.opacity || ''),
          owner: typeof el.hasAttribute === 'function' && el.hasAttribute('data-dsh-tm-native')
            ? 'topic-map-native' : '',
        }
      }

      /** 多采样点元素栈：视口顶部与对话区右上各取几处，合并去重。 */
      function topRightStack() {
        var stack = []
        try {
          if (doc === null || typeof doc.elementsFromPoint !== 'function') return stack
          var width = win !== null && Number.isFinite(Number(win.innerWidth)) ? Number(win.innerWidth) : 0
          var height = win !== null && Number.isFinite(Number(win.innerHeight)) ? Number(win.innerHeight) : 0
          var points = [
            [Math.max(0, width - 24), 24],
            [Math.max(0, width - 24), 88],
            [Math.max(0, width - 24), 160],
            [Math.max(0, width - 80), 88],
            [Math.max(0, width - 24), Math.max(0, Math.round(height * 0.25))],
            [Math.max(0, width - 40), Math.max(0, Math.round(height * 0.4))],
          ]
          var seen = []
          for (var p = 0; p < points.length; p += 1) {
            var elements = doc.elementsFromPoint(points[p][0], points[p][1])
            if (!Array.isArray(elements)) continue
            for (var i = 0; i < elements.length; i += 1) {
              var el = elements[i]
              if (el === null || el === undefined || seen.indexOf(el) >= 0) continue
              seen.push(el)
              stack.push(topRightInfo(el))
              if (stack.length >= 24) return stack
            }
          }
        } catch (error) { return stack }
        return stack
      }

      /** 右上方带 box-shadow 的元素（最多 8 条）。 */
      function shadowScan(width, height) {
        var out = []
        if (doc === null || typeof doc.querySelectorAll !== 'function') return out
        var nodes = []
        try {
          nodes = doc.querySelectorAll('div,nav,aside,section,header,button,span')
        } catch (error) { return out }
        var limit = Math.min(nodes.length, 3000)
        for (var i = 0; i < limit && out.length < 8; i += 1) {
          var el = nodes[i]
          if (el === null || el === undefined) continue
          var style = null
          try {
            if (win !== null && typeof win.getComputedStyle === 'function') style = win.getComputedStyle(el)
          } catch (error) { style = null }
          if (style === null || String(style.boxShadow || 'none') === 'none') continue
          var rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null
          if (rect === null) continue
          var x = Number(rect.x) || 0
          var y = Number(rect.y) || 0
          if (!(x > width * 0.55 && y < height * 0.55)) continue
          var className = typeof el.className === 'string' ? el.className.slice(0, 80) : ''
          var background = String(style.backgroundImage || '')
          out.push({
            cls: className,
            id: String(el.id || ''),
            rect: {
              x: Math.round(x), y: Math.round(y),
              w: Math.round(Number(rect.width) || 0), h: Math.round(Number(rect.height) || 0),
            },
            shadow: String(style.boxShadow || '').slice(0, 80),
            bg: background !== 'none' ? 'gradient' : String(style.backgroundColor || ''),
            z: String(style.zIndex || ''),
            owner: className.split(/\s+/).some(function (name) { return name.indexOf('dsh_tm_') === 0 })
              ? 'ours' : '',
          })
        }
        return out
      }

      /** culprit 顺序：阴影扫描有我们 → ours；否则元素栈有我们 → ours；否则宿主。 */
      function topRightCulprit(stack, shadows) {
        var shadowList = Array.isArray(shadows) ? shadows : []
        for (var s = 0; s < shadowList.length; s += 1) {
          var shadowCls = shadowList[s] !== null && shadowList[s] !== undefined
            ? String(shadowList[s].cls || '') : ''
          if (shadowList[s] !== null && shadowList[s] !== undefined && shadowList[s].owner === 'ours') return 'ours'
          if (shadowCls.split(/\s+/).some(function (name) { return name.indexOf('dsh_tm_') === 0 })) return 'ours'
        }
        var list = Array.isArray(stack) ? stack : []
        for (var i = 0; i < list.length; i += 1) {
          var cls = list[i] !== null && list[i] !== undefined ? String(list[i].cls || '') : ''
          var names = cls.split(/\s+/)
          for (var j = 0; j < names.length; j += 1) {
            if (names[j].indexOf('dsh_tm_') === 0) return 'ours'
          }
        }
        return 'host-or-other'
      }

      /** 诊断 JSON 超过 4KB 时逐步裁掉可选数组，并标注 truncated。 */
      function fitRailDiagnostics(value) {
        var max = 4096
        function bytes(text) {
          try {
            if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length
          } catch (error) { /* 回退字符数 */ }
          return text.length
        }
        var text = JSON.stringify(value)
        if (bytes(text) <= max) return text
        value.truncated = true
        var keys = ['shadowScan', 'topRight']
        while (bytes(text) > max) {
          var removed = false
          for (var k = 0; k < keys.length; k += 1) {
            var list = value[keys[k]]
            if (Array.isArray(list) && list.length > 1) {
              list.pop()
              removed = true
              break
            }
          }
          if (!removed) break
          text = JSON.stringify(value)
        }
        if (bytes(text) > max) {
          value.topRight = Array.isArray(value.topRight) ? value.topRight.slice(0, 1) : []
          value.shadowScan = Array.isArray(value.shadowScan) ? value.shadowScan.slice(0, 1) : []
          text = JSON.stringify(value)
        }
        if (bytes(text) > max) {
          text = JSON.stringify({
            tier: value.tier,
            culprit: value.culprit,
            history: value.history,
            nativeNav: value.nativeNav,
            truncated: true,
          })
        }
        return text
      }

      /** 轨道诊断 JSON：用户反馈 min 档问题时，以这份实测数据为准。 */
      function railDiagnostics() {
        var railRect = rail !== null && typeof rail.getBoundingClientRect === 'function'
          ? rail.getBoundingClientRect() : null
        var row = rowsBox !== null && typeof rowsBox.querySelector === 'function'
          ? rowsBox.querySelector('.dsh_tm_railrow') : null
        var num = row !== null && typeof row.querySelector === 'function'
          ? row.querySelector('.dsh_tm_railnum') : null
        var tick = row !== null && typeof row.querySelector === 'function'
          ? row.querySelector('.dsh_tm_railtick') : null
        var rowRect = row !== null && typeof row.getBoundingClientRect === 'function' ? row.getBoundingClientRect() : null
        var numRect = num !== null && typeof num.getBoundingClientRect === 'function' ? num.getBoundingClientRect() : null
        var tickRect = tick !== null && typeof tick.getBoundingClientRect === 'function' ? tick.getBoundingClientRect() : null
        var railStyle = null
        var numStyle = null
        var rowStyle = null
        try {
          if (win !== null && typeof win.getComputedStyle === 'function') {
            if (rail !== null) railStyle = win.getComputedStyle(rail)
            if (num !== null) numStyle = win.getComputedStyle(num)
            if (row !== null) rowStyle = win.getComputedStyle(row)
          }
        } catch (error) { railStyle = null; numStyle = null; rowStyle = null }
        function size(rect, key) {
          return rect === null || rect === undefined ? 0 : Math.round(Number(rect[key]) || 0)
        }
        var numWidthVar = ''
        try {
          numWidthVar = typeof rail.style.getPropertyValue === 'function'
            ? rail.style.getPropertyValue('--dsh-tm-rail-num-width')
            : String(rail.style['--dsh-tm-rail-num-width'] || '')
        } catch (error) { numWidthVar = '' }
        var visibleWidth = ''
        try {
          visibleWidth = typeof rail.style.getPropertyValue === 'function'
            ? rail.style.getPropertyValue('--dsh-tm-rail-visible-width')
            : String(rail.style['--dsh-tm-rail-visible-width'] || '')
        } catch (error) { visibleWidth = '' }
        var historySnapshot = typeof HISTORY_DIAG !== 'undefined'
          && HISTORY_DIAG !== null && HISTORY_DIAG !== undefined
          ? HISTORY_DIAG : { plan: {}, result: {}, categoryData: {}, browse: {}, branch: 'idle' }
        var historyEl = doc !== null && typeof doc.querySelector === 'function'
          ? doc.querySelector('.dsh_tm_history') : null
        var histBody = historyEl !== null && typeof historyEl.querySelector === 'function'
          ? historyEl.querySelector('.dsh_tm_histbody') : null
        var histFoot = historyEl !== null && typeof historyEl.querySelector === 'function'
          ? historyEl.querySelector('.dsh_tm_histfoot') : null
        var historyRect = historyEl !== null && typeof historyEl.getBoundingClientRect === 'function'
          ? historyEl.getBoundingClientRect() : null
        var footRect = histFoot !== null && typeof histFoot.getBoundingClientRect === 'function'
          ? histFoot.getBoundingClientRect() : null
        var footerFixed = historyRect !== null && footRect !== null
          && Math.abs((Number(footRect.bottom) || 0) - (Number(historyRect.bottom) || 0)) <= 1
        var bodyScrollable = histBody !== null
          && Number(histBody.scrollHeight) > Number(histBody.clientHeight)
        var nativeEl = nav !== null ? nav : (typeof findNav === 'function' ? findNav() : null)
        var nativeStyle = null
        try {
          if (nativeEl !== null && win !== null && typeof win.getComputedStyle === 'function') {
            nativeStyle = win.getComputedStyle(nativeEl)
          }
        } catch (error) { nativeStyle = null }
        var viewportWidth = win !== null && Number.isFinite(Number(win.innerWidth)) ? Number(win.innerWidth) : 0
        var viewportHeight = win !== null && Number.isFinite(Number(win.innerHeight)) ? Number(win.innerHeight) : 0
        var shadows = shadowScan(viewportWidth, viewportHeight)
        var stack = topRightStack()
        return {
          tier: effectiveTier(),
          rail: {
            rect: { x: size(railRect, 'x'), y: size(railRect, 'y'), w: size(railRect, 'width'), h: size(railRect, 'height') },
            w: size(railRect, 'width'),
            h: size(railRect, 'height'),
            overflow: railStyle === null ? '' : String(railStyle.overflow || ''),
          },
          row: { w: size(rowRect, 'width'), h: size(rowRect, 'height') },
          num: {
            text: num === null ? '' : String(num.textContent || ''),
            w: size(numRect, 'width'),
            h: size(numRect, 'height'),
            font: numStyle === null ? '' : String(numStyle.fontSize || ''),
            x: railRect === null || numRect === null ? 0 : Math.round((Number(numRect.left) || 0) - (Number(railRect.left) || 0)),
            y: railRect === null || numRect === null ? 0 : Math.round((Number(numRect.top) || 0) - (Number(railRect.top) || 0)),
          },
          tick: {
            w: size(tickRect, 'width'),
            h: size(tickRect, 'height'),
            present: tick !== null,
          },
          css: {
            numWidthVar: numWidthVar,
            visibleWidth: visibleWidth.replace(/px$/, ''),
            borderLeft: railStyle === null ? 0 : Number.parseFloat(railStyle.borderLeftWidth) || 0,
            paddingLeft: rowStyle === null ? 0 : Number.parseFloat(rowStyle.paddingLeft) || 0,
          },
          topRight: stack,
          shadowScan: shadows,
          culprit: topRightCulprit(stack, shadows),
          history: {
            plan: historySnapshot.plan || {},
            result: historySnapshot.result || {},
            categoryData: historySnapshot.categoryData || {},
            browse: historySnapshot.browse || {},
            dom: {
              histRows: historyEl !== null && typeof historyEl.querySelectorAll === 'function'
                ? historyEl.querySelectorAll('.dsh_tm_histrow').length : 0,
              catSessions: historyEl !== null && typeof historyEl.querySelectorAll === 'function'
                ? historyEl.querySelectorAll('.dsh_tm_histcatsession').length : 0,
              footerFixed: footerFixed,
              bodyScrollable: bodyScrollable,
            },
            branch: historySnapshot.branch || 'idle',
          },
          nativeNav: {
            found: nativeEl !== null && nativeEl !== undefined,
            tag: nativeEl === null || nativeEl === undefined ? '' : String(nativeEl.tagName || '').toLowerCase(),
            cls: nativeEl === null || nativeEl === undefined || typeof nativeEl.className !== 'string'
              ? '' : nativeEl.className.slice(0, 80),
            visibility: nativeStyle === null ? '' : String(nativeStyle.visibility || ''),
            display: nativeStyle === null ? '' : String(nativeStyle.display || ''),
            dataAttr: nativeEl === null || nativeEl === undefined || typeof nativeEl.getAttribute !== 'function'
              ? '' : String(nativeEl.getAttribute('data-dsh-tm-native') || ''),
          },
        }
      }

      function copyRailDiagnostics() {
        var text = ''
        try { text = fitRailDiagnostics(railDiagnostics()) } catch (error) { text = '' }
        var done = function (ok) {
          if (ok === true) showJumpNotice('已复制轨道诊断')
          else note('复制轨道诊断失败')
        }
        try {
          if (typeof navigator !== 'undefined' && navigator !== null
            && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(function () { done(true) }, function () { done(false) })
            return
          }
        } catch (error) { /* 落到失败提示 */ }
        done(false)
      }

      function openMoreMenu() {
        if (rail === null || menuEl !== null) return
        var menu = menuNode()
        menu.setAttribute('role', 'menu')
        menu.setAttribute('aria-label', '历史轨设置')
        menu.appendChild(menuItem('恢复原生导航轨', nativePreferred(), function () {
          setNativePreferred(!nativePreferred())
        }))
        menu.appendChild(menuItem('自动隐藏', autoHideEnabled(), function () {
          setAutoHide(!autoHideEnabled())
        }))
        menu.appendChild(menuItem('复制轨道诊断', null, function () {
          copyRailDiagnostics()
        }))
        menu.appendChild(el('div', 'dsh_tm_railmenusep'))
        menu.appendChild(menuItem('切换显示档位', null, function () { cycleTier() }))
        menuEl = menu
        rail.appendChild(menu)
        if (moreBtn !== null) moreBtn.setAttribute('aria-expanded', 'true')
        if (doc !== null && typeof doc.addEventListener === 'function' && !menuOutsideBound) {
          doc.addEventListener('pointerdown', onDocPointerDown, true)
          menuOutsideBound = true
        }
      }

      function toggleMoreMenu() {
        if (menuEl !== null) closeMoreMenu()
        else openMoreMenu()
      }

      function bindRailControls() {
        if (rail !== null && typeof rail.addEventListener === 'function') {
          rail.addEventListener('pointerenter', onRailEnter)
          rail.addEventListener('pointerleave', onRailLeave)
        }
        if (tierBtn !== null && typeof tierBtn.addEventListener === 'function') {
          tierBtn.addEventListener('click', function (event) {
            if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') {
              event.stopPropagation()
            }
            cycleTier()
          })
        }
        if (moreBtn !== null && typeof moreBtn.addEventListener === 'function') {
          moreBtn.addEventListener('click', function (event) {
            if (event !== null && event !== undefined && typeof event.stopPropagation === 'function') {
              event.stopPropagation()
            }
            toggleMoreMenu()
          })
        }
      }

      // ── 挂载 / 卸载 ───────────────────────────────────────────────
      function teardownRail() {
        if (navObserver !== null) { navObserver.disconnect(); navObserver = null }
        if (containerObserver !== null) { try { containerObserver.disconnect() } catch (error) { /* 已断开 */ } containerObserver = null }
        if (sessionId !== '') TOPIC_ACTIVE.set(sessionId, null)
        if (metricsRaf !== null) {
          if (win !== null && typeof win.cancelAnimationFrame === 'function') {
            try { win.cancelAnimationFrame(metricsRaf) } catch (error) { /* 已结束 */ }
          } else {
            clearTimer(metricsRaf)
          }
          metricsRaf = null
        }
        closeMoreMenu()
        clearRailTimers()
        if (rail !== null && rail.parentElement !== null && rail.parentElement !== undefined
          && typeof rail.parentElement.removeChild === 'function') {
          rail.parentElement.removeChild(rail)
        }
        rail = null
        rowsBox = null
        noteEl = null
        measureEl = null
        measuredText = ''
        measuredTextWidth = 0
        fitMinText = ''
        fittedMinWidth = 0
        fitMinIterations = 0
        railHead = null
        tierBtn = null
        moreBtn = null
        menuEl = null
        rowEls = new Map()
        segHeaderEls = []
        rows = []
        outlineSegments = []
        activeTurn = null
        autoMin = false
        lastNativeSignature = ''
        lastRowsSignature = ''
        lastScrollAt = 0
        geometryDirty = false
        currentHits = new Set()
        mounted = false
        isAnimating = false
        lastEffectiveTier = null
        hoverPending = ''
      }

      function observeNav() {
        var Observer = observerOf()
        if (Observer === null || nav === null) return
        navObserver = new Observer(function (records) {
          var active = false
          var structural = false
          var list = Array.isArray(records) ? records : []
          for (var i = 0; i < list.length; i += 1) {
            var record = list[i]
            if (record === null || typeof record !== 'object') continue
            if (record.type === 'attributes' && (record.attributeName === 'style' || record.attributeName === 'class')) {
              // React 覆写 inline style 时立刻补回标记，不等 200ms sync。
              ensureNativeHidden(nav)
              continue
            }
            if (record.type === 'attributes' && record.attributeName === 'aria-current') {
              active = true
              continue
            }
            // aria-label / data-index / childList 都算结构变化；aria-current
            // 是高频状态，绝不能触发整行重建。
            structural = true
          }
          if (active) scheduleActive()
          if (structural) scheduleRowCheck()
        })
        navObserver.observe(nav, {
          attributes: true,
          attributeFilter: ['aria-current', 'aria-label', 'data-index', 'style', 'class'],
          childList: true,
          subtree: true,
        })
      }

      function mountRail(native) {
        var nextSession = sessionOf(native)
        if (mounted && nav === native && rail !== null && rail.parentElement !== null
          && nextSession === sessionId) {
          syncGeometry()
          return
        }
        teardownRail()
        sessionId = nextSession
        loadTier()
        computeMetrics()
        currentHits = new Set(loadHits(sessionId))
        var slot = native.parentElement
        if (slot === null || slot === undefined || typeof slot.insertBefore !== 'function') {
          note('原生导航轨没有可插入的父节点')
          restoreNative(native)
          nav = null
          return
        }
        nav = native
        rail = el('nav', 'dsh_tm_rail')
        rail.setAttribute('data-rail', 'topic-map')
        rail.setAttribute('aria-label', '轮次导航（历史检索）')
        rail.setAttribute('data-tier', effectiveTier())
        railHead = el('div', 'dsh_tm_railhead')
        tierBtn = el('button', 'dsh_tm_railcollapse', railTierIcon(effectiveTier()))
        tierBtn.type = 'button'
        tierBtn.setAttribute('aria-label', '轨道档位：' + railTierLabel(effectiveTier()))
        moreBtn = el('button', 'dsh_tm_railmore', '⋯')
        moreBtn.type = 'button'
        moreBtn.title = '历史轨设置'
        moreBtn.setAttribute('aria-label', '历史轨设置')
        moreBtn.setAttribute('aria-expanded', 'false')
        railHead.appendChild(tierBtn)
        railHead.appendChild(moreBtn)
        rail.appendChild(railHead)
        rowsBox = el('div', 'dsh_tm_railrows')
        rail.appendChild(rowsBox)
        noteEl = el('div', 'dsh_tm_railnote')
        rail.appendChild(noteEl)
        measureEl = el('span', 'dsh_tm_railmeasure')
        rail.appendChild(measureEl)
        if (typeof rowsBox.addEventListener === 'function') rowsBox.addEventListener('click', onRowsClick)
        bindRailControls()
        slot.insertBefore(rail, native)
        mounted = true
        applyPresentation()
        // 先按原生已渲染刻度画一版，别等大纲接口——接管必须是瞬时的。
        renderFromNative()
        lastNativeSignature = buttonsSignature(snapshotOf(native).buttons)
        geometryDirty = false
        syncGeometry()
        observeNav()
        observeContainer()
        loadOutlineForRail()
        syncActive()
      }

      // ── 接管失败只写控制台，不在界面上打扰用户 ────────────────────
      function removeNotice() {
        if (doc === null || typeof doc.getElementById !== 'function') return
        var old = doc.getElementById(RAIL_NOTICE_ID)
        if (old !== null && old !== undefined && old.parentElement !== null && old.parentElement !== undefined
          && typeof old.parentElement.removeChild === 'function') {
          old.parentElement.removeChild(old)
        }
      }

      function showNotice(reason, exact) {
        var text = reason === null || reason === undefined ? '' : String(reason)
        if (text === '' || text === noticeReason) return
        noticeReason = text
        var fullText = exact === true ? text : 'rail takeover fallback: ' + text
        try {
          if (typeof console !== 'undefined' && console !== null && typeof console.debug === 'function') {
            console.debug('[dsh-topic-map] ' + fullText)
          }
        } catch (error) { /* 控制台不可用不影响降级 */ }
      }

      /**
       * 100ms 复核：原生 nav 的计算样式必须真的 hidden，且自绘轨已挂载。
       *
       * 只要仍可见就拆掉自绘轨、恢复原生，绝不允许两条轨并存。
       */
      function scheduleNativeHiddenCheck(native) {
        if (native === null || native === undefined) return
        if (nativeCheckTimer !== null) {
          clearTimer(nativeCheckTimer)
          nativeCheckTimer = null
        }
        nativeCheckTimer = setTimer(function () {
          nativeCheckTimer = null
          if (disposed || nav !== native || rail === null || mounted !== true) return
          if (isAnimating) {
            scheduleNativeHiddenCheck(native)
            return
          }
          if (win === null || typeof win.getComputedStyle !== 'function') return
          var computed = null
          try { computed = win.getComputedStyle(native) } catch (error) { computed = null }
          if (computed === null || computed === undefined) return
          var visibility = computed.visibility
          // 老测试环境可能不实现 visibility：无法判断时宁可继续用自绘轨。
          if (visibility === undefined || visibility === null) return
          if (String(visibility) === 'hidden') {
            checkedNav = native
            return
          }
          note('原生轨无法隐藏')
          restoreNative(native)
          teardownRail()
          nav = null
          showNotice('原生轨无法隐藏', true)
        }, 100)
      }

      // ── 同步主循环 ────────────────────────────────────────────────
      function syncNow() {
        if (disposed) return
        if (nativePreferred()) {
          if (nav !== null) restoreNative(nav)
          teardownRail()
          nav = null
          mountRestoreButton()
          return
        }
        removeRestoreButton()
        var native = findNav()
        if (native === null) {
          // 未挂载 / 轮次 < 2（宿主这时不渲染 nav）：没有可接管的东西，静默等待。
          if (nav !== null) restoreNative(nav)
          teardownRail()
          nav = null
          return
        }
        // 幂等快路径：同一个 nav、同一条自绘轨、同一会话 → 不再 selfCheck/
        // mountRail/syncGeometry（getComputedStyle + 多次 style 写入正是卡顿来源）。
        if (mounted && nav === native && rail !== null && rail.parentElement !== null
          && rail.parentElement !== undefined && sessionOf(native) === sessionId) {
          ensureNativeHideStyle()
          ensureNativeHidden(native)
          if (checkedNav !== native && nativeCheckTimer === null) scheduleNativeHiddenCheck(native)
          if (geometryDirty && !isAnimating) {
            geometryDirty = false
            syncGeometry()
          }
          syncActive()
          return
        }
        var check = view.selfCheck(snapshotOf(native))
        if (check.ok !== true) {
          // 失配：绝不隐藏原生，继续用原生；只写控制台，不打扰用户。
          restoreNative(native)
          if (nav !== null && nav !== native) restoreNative(nav)
          teardownRail()
          nav = null
          showNotice(check.reason)
          return
        }
        hideNative(native)
        mountRail(native)
        if (rail !== null) scheduleNativeHiddenCheck(native)
        syncActive()
      }

      function scheduleSync(delay) {
        if (disposed) return
        var wait = typeof delay === 'number' ? delay : RAIL_SYNC_DELAY_MS
        if (syncTimer !== null) {
          if (wait !== 0) return
          clearTimer(syncTimer)
          syncTimer = null
        }
        syncTimer = setTimer(function () {
          syncTimer = null
          syncNow()
        }, wait)
      }

      function onScrollCapture(event) {
        var target = event === null || event === undefined ? null : event.target
        // 只关心对话滚动容器；右栏/设置页滚动不触发轨道计算。
        if (target !== null && target !== undefined && typeof target.closest === 'function'
          && target.closest('[data-conversation-scroll]') === null) {
          return
        }
        lastScrollAt = Date.now()
        scheduleActive()
        if (mounted && outline.length === 0) scheduleScrollSettle()
        updateRestorePosition()
      }

      function onResize() {
        geometryDirty = true
        scheduleMetrics()
        scheduleSync()
        updateRestorePosition()
      }

      /**
       * Alt+[：在 min 与上次档位之间切换；原生模式下切回插件轨。
       *
       * 用捕获阶段：宿主如果也在文档上监听 keydown，冒泡阶段可能先被它处理
       * 或阻止；这是本插件的保留键，命中即吃掉。
       */
      function onRailKeydown(event) {
        if (event === null || event === undefined) return
        if (event.altKey !== true) return
        var code = event.code === undefined || event.code === null ? '' : String(event.code)
        var key = event.key === undefined || event.key === null ? '' : String(event.key)
        if (code !== 'BracketLeft' && key !== '[') return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof event.stopPropagation === 'function') event.stopPropagation()
        if (nativePreferred()) {
          // 原生模式下没有可折叠的轨：这个键的语义就是切回插件轨。
          setNativePreferred(false)
          return
        }
        if (rail === null) return
        toggleMinTier()
      }

      function bindGlobalListeners() {
        if (doc !== null && typeof doc.addEventListener === 'function' && !scrollBound) {
          // 滚动不冒泡，用捕获阶段听对话容器的滚动。
          doc.addEventListener('scroll', onScrollCapture, true)
          scrollBound = true
        }
        if (doc !== null && typeof doc.addEventListener === 'function' && !keyBound) {
          doc.addEventListener('keydown', onRailKeydown, true)
          keyBound = true
        }
        if (win !== null && typeof win.addEventListener === 'function' && !resizeBound) {
          win.addEventListener('resize', onResize)
          resizeBound = true
        }
      }

      function unbindGlobalListeners() {
        if (doc !== null && typeof doc.removeEventListener === 'function' && scrollBound) {
          doc.removeEventListener('scroll', onScrollCapture, true)
          scrollBound = false
        }
        if (doc !== null && typeof doc.removeEventListener === 'function' && keyBound) {
          doc.removeEventListener('keydown', onRailKeydown, true)
          keyBound = false
        }
        if (win !== null && typeof win.removeEventListener === 'function' && resizeBound) {
          win.removeEventListener('resize', onResize)
          resizeBound = false
        }
      }

      /**
       * 启动接管。返回 disposer（scope 卸载时调用）。
       *
       * @param {object} options - 依赖注入，便于用假 DOM 测试。
       * @returns {Function} 停止函数。
       */
      function start(options) {
        stop()
        host = options === null || options === undefined ? {} : options
        doc = host.document || null
        win = host.window || null
        store = host.store || null
        view = host.view || (typeof RAILVIEW === 'undefined' ? null : RAILVIEW)
        disposed = false
        noticeReason = ''
        memoryStore = {}
        checkedNav = null
        if (activeRetryUnsub !== null) { activeRetryUnsub(); activeRetryUnsub = null }
        activeRetryUnsub = TOPIC_ACTIVE.onRetry(function (turn) {
          if (!disposed && mounted && Number.isFinite(turn)) retryActiveFor(turn)
        })
        lastEffectiveTier = null
        autoMin = false
        metrics = { containerW: 0, containerH: 0, std: RAIL_STD_FALLBACK, max: RAIL_MAX_FALLBACK, min: 28 }
        isAnimating = false
        if (doc === null || view === null) {
          disposed = true
          return function () {}
        }
        ensureNativeHideStyle()
        var Observer = observerOf()
        if (Observer !== null && doc.body !== null && doc.body !== undefined) {
          docObserver = new Observer(function () {
            // 已接管且原生节点还挂在树上时，体内的高频 DOM 变化（流式输出、
            // 代码块渲染）与轨道无关；navObserver 会处理 aria-current 和结构
            // 变化。这里只在「还没接管 / nav 已被移除 / 自绘轨没了」时探测。
            if (mounted && nav !== null && rail !== null && rail.isConnected !== false
              && nav.isConnected !== false && isVisibleNav(nav)) {
              // React 可能把 nav 重建或清掉 inline style：立刻补打标，不重建轨道。
              ensureNativeHidden(nav)
              return
            }
            // nav 被替换时不要等 200ms 节流，立即重新接管，避免双轨并存的窗口。
            scheduleSync(0)
          })
          docObserver.observe(doc.body, { childList: true, subtree: true })
        }
        bindGlobalListeners()
        syncNow()
        return function () { stop() }
      }

      function stop() {
        disposed = true
        if (activeRetryUnsub !== null) { activeRetryUnsub(); activeRetryUnsub = null }
        if (syncTimer !== null) { clearTimer(syncTimer); syncTimer = null }
        if (activeTimer !== null) { clearTimer(activeTimer); activeTimer = null }
        if (activeRaf !== null) {
          if (win !== null && typeof win.cancelAnimationFrame === 'function') {
            try { win.cancelAnimationFrame(activeRaf) } catch (error) { /* 已结束 */ }
          } else clearTimer(activeRaf)
          activeRaf = null
        }
        clearRailTimers()
        closeMoreMenu()
        if (docObserver !== null) { docObserver.disconnect(); docObserver = null }
        if (navObserver !== null) { navObserver.disconnect(); navObserver = null }
        unbindGlobalListeners()
        removeRestoreButton()
        if (nav !== null) restoreNative(nav)
        teardownRail()
        removeNotice()
        removeNativeHideStyle()
        checkedNav = null
        nav = null
        sessionId = ''
        outline = []
        outlineTurns = []
        outlinePendingFor = ''
        host = null
        doc = null
        win = null
        store = null
        view = null
        scrollBound = false
        resizeBound = false
        keyBound = false
        autoMin = false
        tier = RAIL_TIER_DEFAULT
        lastTier = RAIL_TIER_DEFAULT
      }

      /** 立即同步一次（测试与设置开关用，绕过节流）。 */
      function sync() {
        syncNow()
      }

      function setNativePreferred(value) {
        var on = value === true
        writeStore(RAIL_NATIVE_KEY, on ? '1' : '0')
        if (disposed) {
          notifyPrefs()
          return on
        }
        if (on) {
          clearAutoHideTimer()
          autoMin = false
          closeMoreMenu()
          if (nav !== null) restoreNative(nav)
          teardownRail()
          nav = null
          // 用户主动选了原生，降级提示就没意义了；重置原因，将来自己再关掉开关时还能重新提示。
          removeNotice()
          noticeReason = ''
          mountRestoreButton()
        } else {
          removeRestoreButton()
          syncNow()
        }
        notifyPrefs()
        return on
      }

      return {
        start: start,
        stop: stop,
        sync: sync,
        nativePreferred: nativePreferred,
        setNativePreferred: setNativePreferred,
        autoHideEnabled: autoHideEnabled,
        setAutoHide: setAutoHide,
        tier: function () { return tier },
        effectiveTier: effectiveTier,
        tierText: function () { return railTierLabel(effectiveTier()) },
        tierWidthOf: function () { return Math.round(tierWidth()) },
        nextTier: function () { return nextTierOf(effectiveTier()) },
        setTier: setTier,
        cycleTier: cycleTier,
        toggleMinTier: toggleMinTier,
        animating: function () { return isAnimating },
        currentTurn: function () { return activeTurn },
        fitIterations: function () { return fitMinIterations },
        setDockObscured: function (value) {
          dockObscured = value === true
          if (rail !== null && rail.style !== undefined && rail.style !== null) {
            rail.style.visibility = dockObscured ? 'hidden' : ''
          }
        },
        setHits: setHits,
        hitsOf: function (id) { return loadHits(id) },
        subscribe: subscribePrefs,
      }
    })()

    /** 读会话大纲；端点未上线（404 / 非 ok / 网络错）时按不可用降级。 */
    function railOutlineOf(sessionId) {
      if (typeof fetch !== 'function') return Promise.resolve({ available: false, turns: [], segments: [] })
      return fetch('api/topic-map/session-outline', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
      }).then(function (res) {
        if (res === null || res === undefined) return { available: false, turns: [], segments: [] }
        if (res.status === 404) return { available: false, turns: [], segments: [] }
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json().then(function (payload) {
          if (payload === null || payload === undefined || typeof payload !== 'object' || payload.ok !== true) {
            return { available: false, turns: [], segments: [] }
          }
          var value = payload.value
          var turns = value !== null && value !== undefined && Array.isArray(value.turns) ? value.turns : []
          var segments = value !== null && value !== undefined && Array.isArray(value.segments) ? value.segments : []
          return { available: true, turns: turns, segments: segments }
        })
      }).catch(function () {
        // 优雅降级：接口没实现 / 报错都不能白屏，也不能挡住原生轨。
        return { available: false, turns: [], segments: [] }
      })
    }

    /**
     * 历史轨点击。
     *
     * 先点宿主原生按钮（快、由宿主自己处理「加载并跳转」）；原生按钮被虚拟化
     * 移出窗口时退回已有的 locateHistoryTurn 轮询定位（慢一点但覆盖未加载轮）。
     */
    function railJump(payload) {
      var turn = Number(payload === null || payload === undefined ? NaN : payload.turn)
      if (!Number.isFinite(turn)) return Promise.resolve({ ok: false, reason: '轮次信息不完整' })
      var turns = []
      if (payload !== null && payload !== undefined && Array.isArray(payload.turns)) {
        for (var i = 0; i < payload.turns.length; i += 1) turns.push({ turn: Number(payload.turns[i]) })
      }
      var nav = payload === null || payload === undefined ? null : payload.nav
      if (activateChatTurn(turn, turns, nav)) return Promise.resolve({ ok: true })
      // 目标刻度被虚拟化移出了 DOM：activateChatTurn 已把原生轨道滚到大致位置，
      // 等一帧让 React 渲染出目标按钮再点一次；仍点不到才退回轮询定位。
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (activateChatTurn(turn, turns, nav)) { resolve({ ok: true }); return }
          locateHistoryTurn(payload.sessionId, turn, payload.seq, payload.sessionId).then(function (result) {
            // 跳不过去必须说清原因：轨道点了没反应比报错更难排查。
            if (result !== null && result !== undefined && result.ok === false) {
              showJumpNotice('跳转到第 ' + turn + ' 轮失败：' + (result.reason === undefined ? '未知原因' : result.reason))
            }
            resolve(result)
          })
        }, 60)
      })
    }

    /** 只在真的可用时返回 localStorage；隐私模式/沙箱里会抛，不能让它影响面板。 */
    function railStore() {
      try {
        if (typeof window === 'undefined' || window === null) return null
        var store = window.localStorage
        var probe = '__dsh_tm_rail_probe__'
        store.setItem(probe, '1')
        store.removeItem(probe)
        return store
      } catch (error) {
        return null
      }
    }

    // ── 自绘右侧停靠抽屉（shell.overlay）──────────────────────────
    //
    // 不依赖 better-sidebar：抽屉永远通过宿主自带的 shell.overlay 渲染。
    // 打开时给对话中列加 margin-right 让位；若宿主反复冲掉 margin，
    // 连续 3 次检测后降级为覆盖模式，并把历史轨临时隐藏，避免压在一起。
    var DRAWER_MIN_WIDTH = 300
    var DRAWER_MAX_WIDTH = 560
    var DRAWER_NARROW_MAX_WIDTH = 420
    var DRAWER_NARROW_BREAKPOINT = 1100
    var DRAWER_SMALL_BREAKPOINT = 760
    var DRAWER_COLLAPSED_WIDTH = 48
    var DRAWER_OPEN_KEY = 'dsh.tm.drawer.open'
    var DRAWER_WIDTH_KEY = 'dsh.tm.drawer.width'
    var DRAWER_COLLAPSED_KEY = 'dsh.tm.drawer.collapsed'
    var DRAWER_PUSH_CHECK_MS = 700

    function drawerViewportWidth() {
      if (typeof window !== 'undefined' && window !== null && Number.isFinite(Number(window.innerWidth))) {
        return Number(window.innerWidth)
      }
      return 1280
    }

    function drawerMaxWidth(viewportWidth) {
      var viewport = Number(viewportWidth)
      if (!Number.isFinite(viewport) || viewport <= 0) viewport = 1280
      return viewport < DRAWER_NARROW_BREAKPOINT ? DRAWER_NARROW_MAX_WIDTH : DRAWER_MAX_WIDTH
    }

    function drawerDefaultWidth(viewportWidth) {
      var viewport = Number(viewportWidth)
      if (!Number.isFinite(viewport) || viewport <= 0) viewport = 1280
      return Math.max(DRAWER_MIN_WIDTH, Math.min(drawerMaxWidth(viewport), Math.round(viewport * 0.30)))
    }

    function drawerClampWidth(value, viewportWidth) {
      var number = Number(value)
      var viewport = Number(viewportWidth)
      if (!Number.isFinite(number)) return drawerDefaultWidth(viewport)
      return Math.max(DRAWER_MIN_WIDTH, Math.min(drawerMaxWidth(viewport), Math.round(number)))
    }
    function drawerRead(key, fallback) {
      try {
        if (typeof localStorage !== 'undefined' && localStorage !== null) {
          var value = localStorage.getItem(key)
          if (value !== null) return value
        }
      } catch (error) { /* 存储不可用只影响记忆 */ }
      return fallback
    }

    var DRAWER = (function () {
      var initialViewport = drawerViewportWidth()
      var storedWidth = drawerRead(DRAWER_WIDTH_KEY, null)
      var state = {
        open: initialViewport < DRAWER_SMALL_BREAKPOINT ? false : drawerRead(DRAWER_OPEN_KEY, '1') !== '0',
        collapsed: drawerRead(DRAWER_COLLAPSED_KEY, '0') === '1',
        width: storedWidth === null
          ? drawerDefaultWidth(initialViewport)
          : drawerClampWidth(storedWidth, initialViewport),
        manualWidth: storedWidth !== null,
        available: false,
      }
      var listeners = []
      function snapshot() { return { open: state.open, collapsed: state.collapsed, width: state.width, manualWidth: state.manualWidth, available: state.available } }
      function notify() {
        var snap = snapshot()
        for (var i = listeners.length - 1; i >= 0; i -= 1) {
          try { listeners[i](snap) } catch (error) { /* 单个订阅者失败不影响抽屉 */ }
        }
      }
      function write(key, value) {
        try {
          if (typeof localStorage !== 'undefined' && localStorage !== null) localStorage.setItem(key, String(value))
        } catch (error) { /* 存储不可用只影响记忆 */ }
      }
      function setOpen(next) {
        var value = next === true
        if (state.open === value) return state.open
        state.open = value
        write(DRAWER_OPEN_KEY, value ? '1' : '0')
        notify()
        return state.open
      }
      function setCollapsed(next) {
        var value = next === true
        if (state.collapsed === value) return state.collapsed
        state.collapsed = value
        write(DRAWER_COLLAPSED_KEY, value ? '1' : '0')
        notify()
        return state.collapsed
      }
      function setWidth(next, persist) {
        var value = drawerClampWidth(next, drawerViewportWidth())
        var changed = state.width !== value
        if (changed) state.width = value
        if (persist !== false) {
          state.manualWidth = true
          write(DRAWER_WIDTH_KEY, value)
        }
        if (changed) notify()
        return state.width
      }
      function persistWidth() {
        state.manualWidth = true
        write(DRAWER_WIDTH_KEY, state.width)
      }
      /** 视口变化：未手动拖过就按 30% 重算，拖过也只做边界夹紧。 */
      function reflowWidth() {
        var viewport = drawerViewportWidth()
        var next = state.manualWidth
          ? drawerClampWidth(state.width, viewport)
          : drawerDefaultWidth(viewport)
        if (next === state.width) return state.width
        state.width = next
        notify()
        return state.width
      }
      return {
        snapshot: snapshot,
        subscribe: function (listener) {
          if (typeof listener !== 'function') return function () {}
          listeners.push(listener)
          return function () {
            var at = listeners.indexOf(listener)
            if (at >= 0) listeners.splice(at, 1)
          }
        },
        setOpen: setOpen,
        toggle: function () { return setOpen(!state.open) },
        setCollapsed: setCollapsed,
        setWidth: setWidth,
        persistWidth: persistWidth,
        reflowWidth: reflowWidth,
        setAvailable: function (value) {
          var next = value === true
          if (state.available === next) return next
          state.available = next
          notify()
          return next
        },
      }
    })()

    /** 找对话主列：优先 better-sidebar 标的中心列，再按 conversation 槽向上找有盒子的祖先。 */
    function drawerColumn() {
      if (typeof document === 'undefined' || document === null) return null
      var anchor = null
      try {
        anchor = document.querySelector('[data-dsh-center-col]')
          || document.querySelector('main.conversation')
          || document.querySelector('[data-conversation-session]')
      } catch (error) { anchor = null }
      var node = anchor
      while (node !== null && node !== undefined && node !== document.body) {
        try {
          var style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null
          var rect = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null
          var width = rect === null || rect === undefined ? 0 : Number(rect.width)
          if (style !== null && style.display !== 'contents' && Number.isFinite(width) && width > 0) return node
        } catch (error) { /* 继续向上 */ }
        node = node.parentElement
      }
      return null
    }

    /** 抽屉内部：四个 tab（续接 / 历史 / 统计 / 设置）共用一个固定头部和可滚动正文。 */
    function TopicMapDrawerSurface(props) {
      var inspectedWs = props !== null && props !== undefined && typeof props.inspectedWorkspaceId === 'string'
        ? props.inspectedWorkspaceId : ''
      var inspecting = props !== null && props !== undefined && props.readonly === true
      var defaultKind = typeof WORKS_KIND === 'string' ? WORKS_KIND : HISTORY_KIND
      var initial = props !== null && props !== undefined && typeof props.initialTab === 'string'
        ? props.initialTab
        : defaultKind
      var tabState = useState(initial)
      var active = tabState[0]; var setActive = tabState[1]
      var sessionId = props !== null && props !== undefined ? props.sessionId : null
      var body = null
      if (typeof WORKS_KIND === 'string' && active === WORKS_KIND && typeof WorksTabBody === 'function') {
        body = h(WorksTabBody, {
          sessionId: sessionId,
          openTab: setActive,
          hideTabStrip: true,
          inspectedWorkspaceId: inspectedWs,
          readonly: inspecting,
        })
      } else if (active === STATS_KIND) {
        body = h(StatsTabBody, { sessionId: sessionId, openTab: setActive, hideTabStrip: true })
      } else if (active === SETTINGS_KIND) {
        body = h(SettingsTabBody, { sessionId: sessionId, openTab: setActive, hideTabStrip: true })
      } else {
        body = h(HistoryTabBody, { sessionId: sessionId, openTab: setActive, hideTabStrip: true })
      }
      return h('div', { className: 'dsh_tm_drawersurface' },
        h('div', { className: 'dsh_tm_drawertabs', role: 'tablist', 'aria-label': '历史检索' },
          RIGHT_TABS.map(function (tab) {
            var on = tab.kind === active
            return h('button', {
              key: tab.kind,
              type: 'button', role: 'tab',
              'aria-selected': on ? 'true' : 'false',
              className: 'dsh_tm_drawertab' + (on ? ' dsh_tm_drawertab_on' : ''),
              'data-kind': tab.kind,
              onClick: function () { setActive(tab.kind) },
            }, tab.title)
          })),
        h('div', { className: 'dsh_tm_drawerbody' }, body))
    }

    /**
     * 工作区下拉里的后缀文案（ADR-0012）。
     *
     * 三种情况必须说不同的话，否则用户会以为插件读不到内容：
     * - 有对话：显示真实对话数；
     * - 会话全是空的：说「只有 N 个空会话」，而不是干巴巴一个「0 对话」；
     * - 还没统计过：**什么都不显示**——绝不能显示 0（Number(null) 会得到 0，
     *   那正是把「不知道」谎报成「是 0」）。
     */
    function workPickSuffix(workspace) {
      var w = workspace !== null && workspace !== undefined && typeof workspace === 'object' ? workspace : {}
      var conv = w.conversationCount
      var empties = w.emptySessionCount
      var hasConv = typeof conv === 'number' && isFinite(conv)
      var hasEmpty = typeof empties === 'number' && isFinite(empties)
      if (hasConv && conv > 0) return '（' + conv + ' 对话）'
      if (hasConv && conv === 0) {
        return hasEmpty && empties > 0 ? ('（只有 ' + empties + ' 个空会话）') : '（无对话）'
      }
      return ''
    }

    /**
     * 主对话换了归属工作区时，巡检视角要不要跟回去（ADR-0011）。
     *
     * 规则：**归属真的变了**才跟随。这样既能让面板跟着对话走，
     * 又不会把用户手动挑选的巡检区每秒冲掉（轮询会反复算到同一个归属）。
     *
     * @returns 需要重置巡检视角时 true。
     */
    /**
     * 主对话**换了一个会话**时，巡检视角要不要跟回本区（ADR-0011）。
     *
     * 只有「从一个会话切到另一个会话」才算切换；首次确定会话（prev 为空）
     * 与同一会话的轮询重复读到都不算，否则会把用户手动挑选的巡检区反复冲掉。
     */
    function shouldFollowSessionSwitch(prevSessionId, nextSessionId) {
      var prev = String(prevSessionId === null || prevSessionId === undefined ? '' : prevSessionId)
      var next = String(nextSessionId === null || nextSessionId === undefined ? '' : nextSessionId)
      if (prev === '' || next === '') return false
      return prev !== next
    }

    function shouldFollowOwnWorkspace(prevOwnWs, nextOwnWs) {
      var prev = String(prevOwnWs === null || prevOwnWs === undefined ? '' : prevOwnWs)
      var next = String(nextOwnWs === null || nextOwnWs === undefined ? '' : nextOwnWs)
      if (prev === '' || next === '') return false
      return prev !== next
    }

    /** 当前可见会话 id：shell.overlay 不一定带 sessionId，从对话 DOM 兜底。 */
    function drawerCurrentSessionId() {
      if (typeof document === 'undefined' || document === null) return null
      try {
        var roots = document.querySelectorAll('[data-conversation-session]')
        for (var i = 0; i < roots.length; i += 1) {
          var root = roots[i]
          if (root !== null && root !== undefined && root.hidden !== true) {
            var value = root.getAttribute('data-conversation-session')
            if (value !== null && value !== undefined && String(value) !== '') return String(value)
          }
        }
      } catch (error) { /* 没有 DOM 就让 Host 用默认工作区 */ }
      return null
    }

    /**
     * 抽屉本体（shell.overlay）。关闭时只渲染右缘小药丸入口。
     */
    function TopicMapDrawer(props) {
      useTopicMapTheme()
      var state = useState(DRAWER.snapshot())
      var snap = state[0]; var setSnap = state[1]
      var overlayState = useState(false)
      var overlayMode = overlayState[0]; var setOverlayMode = overlayState[1]
      var viewportState = useState(drawerViewportWidth())
      var viewportW = viewportState[0]; var setViewportW = viewportState[1]
      var drawerRef = useRef(null)
      var pillRef = useRef(null)
      var dragRef = useRef(null)
      var providedSession = props !== null && props !== undefined && props.sessionId !== undefined
        && props.sessionId !== null && props.sessionId !== '' ? String(props.sessionId) : ''
      var sessionState = useState(providedSession === '' ? drawerCurrentSessionId() : providedSession)
      var sessionId = sessionState[0]; var setSessionId = sessionState[1]
      var drawerWorkspaceState = useState('')
      var drawerWorkspaceLabel = drawerWorkspaceState[0]; var setDrawerWorkspaceLabel = drawerWorkspaceState[1]
      var drawerWorkspaceSeqRef = useRef(0)
      // 归属工作区 = 当前会话所属的工作区；availWs 是巡检清单；
      // pickedWs 是「我正在看哪个工作区」（空串 = 跟随归属）——三者语义不同（ADR-0011）。
      var ownWsState = useState('')
      var ownWsId = ownWsState[0]; var setOwnWsId = ownWsState[1]
      var availWsState = useState([])
      var availWs = availWsState[0]; var setAvailWs = availWsState[1]
      var pickedWsState = useState('')
      var pickedWs = pickedWsState[0]; var setPickedWs = pickedWsState[1]
      var lastOwnWsRef = useRef('')
      var lastSessionRef = useRef(null)

      useEffect(function () {
        drawerWorkspaceSeqRef.current += 1
        var token = drawerWorkspaceSeqRef.current
        var sid = sessionId === null || sessionId === undefined ? '' : String(sessionId)
        if (sid === '') {
          setDrawerWorkspaceLabel('')
          return
        }
        requestTopicMap('workspaces', {}).then(function (result) {
          if (token !== drawerWorkspaceSeqRef.current) return
          var list = result !== null && result !== undefined && result.ok === true && Array.isArray(result.value)
            ? result.value : []
          var found = null
          for (var i = 0; i < list.length; i += 1) {
            var ids = Array.isArray(list[i] && list[i].sessionIds) ? list[i].sessionIds : []
            if (ids.some(function (id) { return String(id) === sid })) { found = list[i]; break }
          }
          setDrawerWorkspaceLabel(found === null ? '' : workspaceDisplayName(found))
          setAvailWs(list)
          var nextOwnWs = found === null ? '' : String(found.id || '')
          // 主对话换了归属工作区时，巡检视角必须跟回去（否则会一直停在
          // 上一次手动选的那个区，用户会以为面板没跟着对话走）。
          // 只在「归属真的变了」时重置，避免把用户手动挑选的结果每秒冲掉。
          if (shouldFollowOwnWorkspace(lastOwnWsRef.current, nextOwnWs)) {
            setPickedWs('')
          }
          lastOwnWsRef.current = nextOwnWs
          setOwnWsId(nextOwnWs)
        }, function () {
          if (token === drawerWorkspaceSeqRef.current) {
            setDrawerWorkspaceLabel('')
          }
        })
      }, [sessionId])

      // 宿主若**直接传** sessionId（providedSession），必须跟着 prop 变化同步：
      // useState 只取初值，prop 变了状态不会自己更新——这是「主对话切走后右侧面板
      // 不级联」的根因之一（另一条路径是下方 DOM 轮询）。
      useEffect(function () {
        if (providedSession === '') return
        if (lastSessionRef.current === providedSession) return
        var prevSession = lastSessionRef.current
        lastSessionRef.current = providedSession
        setSessionId(providedSession)
        if (shouldFollowSessionSwitch(prevSession, providedSession)) setPickedWs('')
      }, [providedSession])

      useEffect(function () {
        if (providedSession !== '') return undefined
        var timer = setInterval(function () {
          var next = drawerCurrentSessionId()
          if (next === null || next === undefined || next === '') return
          if (lastSessionRef.current === next) return
          var prevSession = lastSessionRef.current
          lastSessionRef.current = next
          setSessionId(next)
          // 主对话真的换了（不是同一会话的轮询重复读到）→ 巡检视角跟回本区。
          // 否则用户上次手动选的别区会一直黏住，看起来就是「面板没跟着对话走」。
          if (shouldFollowSessionSwitch(prevSession, next)) setPickedWs('')
        }, 1000)
        return function () { clearInterval(timer) }
      }, [providedSession])

      useEffect(function () {
        DRAWER.setAvailable(true)
        var unsubscribe = DRAWER.subscribe(function (next) { setSnap(next) })
        function onViewportResize() {
          var width = drawerViewportWidth()
          setViewportW(width)
          DRAWER.reflowWidth()
        }
        DRAWER.reflowWidth()
        if (typeof window !== 'undefined' && window !== null && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', onViewportResize)
        }
        return function () {
          unsubscribe()
          if (typeof window !== 'undefined' && window !== null && typeof window.removeEventListener === 'function') {
            window.removeEventListener('resize', onViewportResize)
          }
          DRAWER.setAvailable(false)
        }
      }, [])

      var visibleWidth = snap.collapsed ? DRAWER_COLLAPSED_WIDTH : snap.width
      var forceOverlay = viewportW < DRAWER_SMALL_BREAKPOINT

      // 打开时给对话主列让位；连续 3 次被冲掉就降级覆盖。
      useEffect(function () {
        if (typeof window === 'undefined' || window === null) return undefined
        var disposed = false
        var timer = null
        var observer = null
        var target = null
        var previousValue = ''
        var previousPriority = ''
        var failures = 0
        var stable = 0
        function restore() {
          if (target === null) return
          try {
            if (previousValue === '') target.style.removeProperty('margin-right')
            else target.style.setProperty('margin-right', previousValue, previousPriority)
          } catch (error) { /* 目标已卸载 */ }
          target = null
        }
        function measure() {
          if (disposed) return null
          if (target !== null && target.isConnected !== false) return target
          target = drawerColumn()
          if (target !== null) {
            previousValue = target.style.getPropertyValue('margin-right')
            previousPriority = target.style.getPropertyPriority('margin-right')
          }
          return target
        }
        function expectedPx() { return snap.open ? visibleWidth : 0 }
        function applyMargin() {
          var el = measure()
          if (el === null) return false
          try { el.style.setProperty('margin-right', expectedPx() + 'px') } catch (error) { return false }
          return true
        }
        var overlayActive = overlayMode || forceOverlay
        function verify() {
          if (disposed) return
          if (!snap.open) {
            restore()
            if (typeof RAILTAKE !== 'undefined' && RAILTAKE !== null && typeof RAILTAKE.setDockObscured === 'function') {
              RAILTAKE.setDockObscured(false)
            }
            return
          }
          if (overlayActive) {
            restore()
            if (typeof RAILTAKE !== 'undefined' && RAILTAKE !== null && typeof RAILTAKE.setDockObscured === 'function') {
              RAILTAKE.setDockObscured(true)
            }
            return
          }
          var el = measure()
          if (el === null) {
            // 找不到主列：也按连续 3 次失配降级，避免 boot 早期一次误判。
            stable = 0
            failures += 1
            if (failures >= 3) setOverlayMode(true)
            return
          }
          var current = 0
          try { current = parseFloat(window.getComputedStyle(el).marginRight) || 0 } catch (error) { current = 0 }
          if (Math.abs(current - expectedPx()) <= 1) {
            stable += 1
            if (stable >= 2) failures = 0
            if (typeof RAILTAKE !== 'undefined' && RAILTAKE !== null && typeof RAILTAKE.setDockObscured === 'function') {
              RAILTAKE.setDockObscured(false)
            }
            return
          }
          stable = 0
          failures += 1
          if (failures >= 3) {
            setOverlayMode(true)
            restore()
            if (typeof RAILTAKE !== 'undefined' && RAILTAKE !== null && typeof RAILTAKE.setDockObscured === 'function') {
              RAILTAKE.setDockObscured(true)
            }
            return
          }
          applyMargin()
        }
        if (snap.open && !overlayActive) {
          applyMargin()
          timer = setInterval(verify, DRAWER_PUSH_CHECK_MS)
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(function () {
              if (target !== null && target.isConnected !== false) verify()
            })
            try { if (target !== null) observer.observe(target) } catch (error) { /* 忽略 */ }
          }
        }
        verify()
        return function () {
          disposed = true
          if (timer !== null) clearInterval(timer)
          if (observer !== null) { try { observer.disconnect() } catch (error) { /* 已断开 */ } }
          restore()
          if (typeof RAILTAKE !== 'undefined' && RAILTAKE !== null && typeof RAILTAKE.setDockObscured === 'function') {
            RAILTAKE.setDockObscured(false)
          }
        }
      }, [snap.open, visibleWidth, overlayMode, forceOverlay])

      // 抽屉 top/bottom 与对话主列对齐。
      useEffect(function () {
        if (!snap.open || drawerRef.current === null) return
        function align() {
          var el = drawerRef.current
          if (el === null) return
          var column = drawerColumn()
          if (column === null) {
            el.style.top = '0px'
            el.style.bottom = '0px'
            return
          }
          var rect = column.getBoundingClientRect()
          el.style.top = Math.max(0, Math.round(rect.top)) + 'px'
          el.style.bottom = Math.max(0, Math.round(window.innerHeight - rect.bottom)) + 'px'
        }
        align()
        window.addEventListener('resize', align)
        return function () { window.removeEventListener('resize', align) }
      }, [snap.open, snap.width, snap.collapsed])

      // 关闭态药丸贴着对话区右缘，而不是整个视口右缘。
      useEffect(function () {
        if (snap.open || pillRef.current === null) return
        function place() {
          var pill = pillRef.current
          if (pill === null) return
          var column = drawerColumn()
          if (column === null) {
            pill.style.right = '2px'
            pill.style.top = '50%'
            return
          }
          var rect = column.getBoundingClientRect()
          var right = Math.max(2, Math.round((window.innerWidth || 0) - rect.right + 2))
          pill.style.right = right + 'px'
          pill.style.top = Math.max(8, Math.round(rect.top + rect.height / 2 - 22)) + 'px'
          pill.style.marginTop = '0px'
        }
        place()
        window.addEventListener('resize', place)
        return function () { window.removeEventListener('resize', place) }
      }, [snap.open])

      if (!snap.open) {
        return h('button', {
          ref: pillRef,
          type: 'button',
          className: 'dsh_tm_drawerpill',
          title: '历史检索',
          'aria-label': '历史检索',
          onClick: function () { DRAWER.setOpen(true) },
        }, '⋮⋮')
      }

      function startResize(event) {
        if (event === null || event === undefined) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        dragRef.current = {
          startX: Number(event.clientX),
          startWidth: snap.width,
        }
        var onMove = function (moveEvent) {
          var drag = dragRef.current
          if (drag === null) return
          var x = Number(moveEvent.clientX)
          if (!Number.isFinite(x)) return
          DRAWER.setWidth(drag.startWidth + (drag.startX - x), false)
        }
        var onUp = function () {
          dragRef.current = null
          DRAWER.persistWidth()
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      }

      // 视角（我在看哪个区）与身份（我属于哪个区）分开算（ADR-0011）：
      // 只有两者不一致时才是「只读巡检」。
      var pickedEntry = null
      for (var pi = 0; pi < availWs.length; pi += 1) {
        if (String(availWs[pi] && availWs[pi].id || '') === pickedWs) { pickedEntry = availWs[pi]; break }
      }
      var viewingLabel = pickedEntry === null ? drawerWorkspaceLabel : workspaceDisplayName(pickedEntry)
      var isInspecting = pickedWs !== '' && ownWsId !== '' && pickedWs !== ownWsId
      var head = snap.collapsed
        ? h('div', { className: 'dsh_tm_drawercollapsedhead' },
            h('button', {
              type: 'button', className: 'dsh_tm_drawericon', title: '续接',
              onClick: function () { DRAWER.setCollapsed(false); },
            }, '▸'),
            h('button', {
              type: 'button', className: 'dsh_tm_drawericon', title: '历史',
              onClick: function () { DRAWER.setCollapsed(false); },
            }, '◷'),
            h('button', {
              type: 'button', className: 'dsh_tm_drawericon', title: '统计',
              onClick: function () { DRAWER.setCollapsed(false); },
            }, '▥'),
            h('button', {
              type: 'button', className: 'dsh_tm_drawericon', title: '设置',
              onClick: function () { DRAWER.setCollapsed(false); },
            }, '⚙'),
            h('button', {
              type: 'button', className: 'dsh_tm_drawericon', title: '展开历史检索',
              onClick: function () { DRAWER.setCollapsed(false) },
            }, '›'))
        : h('div', { className: 'dsh_tm_drawerhead' },
            h('div', { className: 'dsh_tm_drawertitle', title: viewingLabel === '' ? '历史检索' : '历史检索 · ' + viewingLabel },
              h('span', { className: 'dsh_tm_drawertitlemain' }, '历史检索'),
              viewingLabel === ''
                ? null
                : h('span', { className: 'dsh_tm_drawertitlews' }, ' · ' + viewingLabel),
              isInspecting === true
                ? h('span', {
                    className: 'dsh_tm_drawerro',
                    title: '你正在看另一个工作区：可以浏览与交接，但不能在这里做修改',
                  }, '只读')
                : null),
            availWs.length > 0
              ? h('select', {
                  className: 'dsh_tm_drawerpick',
                  title: '巡检哪个工作区（只读查看别区，修改要回本区）',
                  value: pickedWs,
                  onChange: function (event) {
                    var next = event && event.target ? String(event.target.value || '') : ''
                    setPickedWs(next)
                  },
                }, [h('option', { key: '__own__', value: '' }, '本区：' + (drawerWorkspaceLabel === '' ? '（未绑定）' : drawerWorkspaceLabel))]
                  .concat(availWs.filter(function (w) {
                    return w && String(w.id || '') !== '' && String(w.id || '') !== ownWsId
                  }).map(function (w) {
                    var id = String(w.id || '')
                    var nm = String(w.title || id.slice(0, 8))
                    var suffix = workPickSuffix(w)
                    return h('option', { key: id, value: id }, nm + suffix)
                  })))
              : null,
            h('button', {
              type: 'button', className: 'dsh_tm_drawerfold',
              title: '折叠成图标条', 'aria-label': '折叠历史检索',
              onClick: function () { DRAWER.setCollapsed(true) },
            }, '›'),
            h('button', {
              type: 'button', className: 'dsh_tm_drawerfold',
              title: '关闭历史检索（Ctrl+Shift+H）', 'aria-label': '关闭历史检索',
              onClick: function () { DRAWER.setOpen(false) },
            }, '×'))


      return h('aside', {
        ref: drawerRef,
        className: 'dsh_tm_drawer',
        'data-collapsed': snap.collapsed ? '1' : '0',
        'data-overlay': overlayMode || forceOverlay ? '1' : '0',
        style: { width: visibleWidth + 'px' },
        'aria-label': '历史检索',
      },
        h('div', { className: 'dsh_tm_drawerresize', title: '拖动调整宽度', onPointerDown: startResize }),
        head,
        overlayMode
          ? h('div', { className: 'dsh_tm_drawerwarn', role: 'status' }, '无法为对话区让位，已切换覆盖模式')
          : null,
        snap.collapsed
          ? null
          : h(TopicMapDrawerSurface, {
            sessionId: sessionId,
            inspectedWorkspaceId: pickedWs,
            readonly: isInspecting,
          }))
    }




    // ── locale ──────────────────────────────────────────────────────
    var ZH = {
      title: '历史检索',
      loading: '正在读取会话…',
      empty: '这个会话还没有任何对话',
      noSession: '请先打开一个会话',
      unavailable: '历史检索暂不可用',
    }
    var EN = {
      title: 'History Search',
      loading: 'Reading session…',
      empty: 'No turns in this session yet',
      noSession: 'Open a session first',
      unavailable: 'Topic Map is unavailable',
    }

    var NS = 'topic-map'
    // 只列核心服务。slots 是宿主自带能力（抽屉用 shell.overlay）；
    // 不依赖 better-sidebar，也不再声明任何右栏服务。
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

      // 分类入口已迁到右侧抽屉；旧的 conversation.view 话题地图面板不再注册。

      // 自绘停靠抽屉：只走宿主自带的 shell.overlay，不依赖 better-sidebar。
      // slots 在 inject 里是硬依赖；这里仍做形状检查，避免旧宿主直接抛错。
      try {
        ctx.effect(function () {
          if (ctx.slots === null || ctx.slots === undefined || typeof ctx.slots.inject !== 'function') {
            historyDiag('slots.inject 不可用，历史检索抽屉未注册')
            return function () {}
          }
          return ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register({
              name: 'shell.overlay',
              id: 'dsh-topic-map-drawer',
              locale: NS,
            }, TopicMapDrawer)
          })
        }, 'dsh-topic-map: 右侧抽屉')
      } catch (error) {
        historyDiag('注册右侧抽屉失败：' + errorText(error))
      }

      // Ctrl+Shift+H / Alt+H：抽屉开关。捕获阶段监听，宿主 stopPropagation 前拿到。
      try {
        ctx.effect(function () {
          var host = typeof window !== 'undefined' ? window : null
          if (host === null || typeof host.addEventListener !== 'function') return function () {}
          function onKey(event) {
            if (event === null || event === undefined) return
            if (event.ctrlKey !== true && event.altKey !== true) return
            if (event.metaKey === true) return
            var key = event.key === null || event.key === undefined ? '' : String(event.key)
            if (event.code !== 'KeyH' && key.toLowerCase() !== 'h') return
            var ctrlShift = event.ctrlKey === true && event.shiftKey === true && event.altKey !== true
            var altOnly = event.altKey === true && event.ctrlKey !== true && event.shiftKey !== true
            if (!ctrlShift && !altOnly) return
            if (DRAWER.snapshot().available !== true) return
            DRAWER.toggle()
            event.preventDefault()
            event.stopPropagation()
          }
          host.addEventListener('keydown', onKey, true)
          return function () { host.removeEventListener('keydown', onKey, true) }
        }, 'dsh-topic-map: 抽屉快捷键')
      } catch (error) {
        historyDiag('注册抽屉快捷键失败：' + errorText(error))
      }

      // V-12：历史轨接管。挂在全局而不是面板里——原生轨在对话区，
      // 用户不打开话题地图面板时也应该已经被换掉。
      try {
        ctx.effect(function () {
          return RAILTAKE.start({
            document: typeof document === 'undefined' ? null : document,
            window: typeof window === 'undefined' ? null : window,
            store: railStore(),
            view: RAILVIEW,
            loadOutline: railOutlineOf,
            jump: railJump,
            diag: historyDiag,
          })
        }, 'dsh-topic-map: 历史轨接管')
      } catch (error) {
        historyDiag('历史轨接管启动失败：' + errorText(error))
      }
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
