# dsh-topic-map · 工作区记忆与事的续接

> DSH 插件。把一个工作区的全部会话日志重组成**可续接的「事」**与**可回溯的「话题」**：
> 工作场景打开抽屉即可看清未收束的事、现状卡点与下一步，一键回到现场或新开会话防失真交接；日常闲聊不强行套状态机，通过跨会话检索与「段 → 轮次」历史轨快速找回对应对话。

**版本 1.0.0** ｜ Windows ｜ 零第三方插件依赖

---

## 产品定位与解决什么

本插件统一服务两类真实使用场景，并以**「段」**（会话内连续同主题的一串轮次）作为共享中枢（详见 [术语表](<GLOSSARY.md>) 与 [ADR-0001](<docs/adr/0001-continuator-not-retriever.md>)）：

1. **一等核心 · 工作场景「事」续接器**：围绕跨会话的完整工作，自动识别未收束的事、维护「推测 / 已确认」双态、在自然拐点轻确认、按需沉淀「决策」序列，并用三层防失真协议完成原会话续接或新会话交接。
2. **兼顾场景 · 无状态日常「话题」回溯**：对没有完结状态与下一步的日常交流，不制造僵尸卡片；通过跨会话关键词检索、自动分类与对话区右缘「段 → 轮次」两级历史轨在几秒内找回原文，并支持**话题 ↔ 事一键互转**。

| 痛点 | 这个插件怎么回答 |
|---|---|
| 开了十几个会话，第二天想不起哪些事没干完、停在哪 | **［续接］首页**：只聚焦未收束的事（卡住优先、置顶优先），4 行卡片直接列出状态、卡点与唯一一个下一步 |
| 复杂工作改过几轮方案，切新会话后 agent 又踩回旧坑 | **按需决策序列 + 三层防失真交接**：保留「现行 / 已否决」决策与证据句柄，程序直取改动文件/命令/报错首行，经 `system-prompt/assemble` 注入上下文 |
| 人工维护看板太重，全自动聚类又怕把改好的记忆洗乱 | **双态推断 + 拐点轻确认 + 一次盘点后增量挂载**：推测态默认可见，人在自然拐点点一下即转已确认锁定、永不覆盖；超时未动的推测事自动沉降进「已搁置」 |
| 日常闲聊想不起「上次聊某话题在哪个对话、第几轮」 | **［历史］跨会话检索 + 「段 → 轮次」历史轨**：精确到轮次、支持分类过滤与一键定位，也能随时把某段对话一键转为「事」 |
| 想把历史轮次带进新对话，又不想粘贴一大段聊天记录 | **短句柄引用**：输入框只留 `〔8hex#N〕` 或 `〔work:<id>〕`，发给模型时按幂等账本自动展开，必要时由 `history_turn` 工具下钻原文 |

---

## 界面

### 整体：对话区 + 「段 → 轮次」历史轨 + 右侧四页签抽屉

```
┌──────────────────────────────────────┬──────────────────────────┐
│                                      │ 工作区记忆 · dsh_plugin   │
│        对话区（被抽屉挤压变窄）        │［续接］［历史］［统计］［设置］│
│                           ┊          ├──────────────────────────┤
│                           ┊ 历史轨    │ 拐点提示：切离了「…」，    │
│  ┌─────────────────────┐  ┊          │ 标为已完成？ [完成][忽略] │
│  │ 第 42 轮  ┃          │  ┊ ▾ 领域重构├──────────────────────────┤
│  │ 补齐工作区续接契约   │  ┊  ·41     │ ▸ 修复交接血缘  [卡住][推测]│
│  └─────────────────────┘  ┊  ·42 ●   │   串台检测未覆盖新分叉会话  │
│                           ┊ ▸ 日常闲聊│   → 下一步：补齐 L1 绑定测试│
│                           ┊  ·43     │   回到现场  新会话交接 ⋯  │
│                                      ├──────────────────────────┤
│                                      │ ▸ 已收束（6）             │
└──────────────────────────────────────┴──────────────────────────┘
```

抽屉关闭时，对话区右缘保留一个 **`⋮⋮` 药丸**，点击打开。
快捷键：**`Ctrl+Shift+H`** 或 **`Alt+H`** 开关抽屉；**`Alt+[`** 收起/展开历史轨。

### 抽屉四页签

| 页签 | 定位与内容 |
|---|---|
| **续接** | 工作一等首页。展示未收束的事（窄抽屉默认 4 行卡片：标题/状态/推测或确认徽章 → 现状卡点 → 下一步 → 动作条「回到现场 / 新会话交接 / 已完成 / 更多」）；展开可看现行与已否决决策、证据句柄、涉及文件与跨会话段清单；顶部承接冷启动 30 秒核对入口、拐点轻确认条与已完成老事重开提示；底部可折叠查看「已收束」列表 |
| **历史** | 日常话题回溯与全量检索。分类胶囊 + 输入即搜（400ms 防抖）+ 真分页结果 + 行动作（定位 / 详情 / 引用 / 复制 / 标记 / 分叉 / 重试 / 简报 / 转为事） |
| **统计** | 工作区活跃度与用量：会话数 / 轮次 / 活跃天数 / Token 用量；Top 会话支持按**轮数**或 **Token** 排序 |
| **设置** | 五组设置：**续接与事**（自动沉降天数 `dormantDays`、拐点轻确认开关 `inflectionNotice`）、**模型**（只读状态，密钥永不明文回显）、**索引**（分析轮次上限与一键重建）、**引用**（摘要档位与配额）、**界面**（历史轨原生退回开关） |

### 对话区右缘历史轨（「段 → 轮次」两级目录）

- 消费 `POST /session-outline` 返回的轮次大纲与 `segments`，由 `RAILVIEW.segmentGroupsOf` 组织为**「段头 → 轮次行」两级目录**（无段数据时自动平滑退回扁平轮次列表）；
- 三档宽度可拖拽并吸附（细轨 `40px` / 标准 `200px` / 宽轨 `320px`），支持 `Alt+[` 切换、三向滚动联动与点击跳转；
- 接管原生导航轨前执行自检，宿主结构不匹配时自动保留原生轨，不弹窗打扰。

---

## 核心机制

### 1 事的生命周期：双态、拐点与防污染

- **四态 + 唯一一个下一步**：每件事处于 `进行中 (active)` / `卡住 (blocked)` / `已完成 (done)` / `已搁置 (shelved)` 之一，未收束列表只显示 `active` 与 `blocked`；
- **推测态 / 已确认态**：后台推断的结果以**推测态**直接展示，零门槛可用；用户在卡片或拐点轻确认条点一下即转**已确认态**锁定，后台永不覆盖；
- **三类自然拐点（非阻塞）**：切换话题（`topic_switch`）、疑似收尾或卡住（`likely_settled_or_blocked`）、重返未收束会话（`revisit_unresolved`），均以顶部轻条提示，可 1 秒确认或忽略；
- **自动沉降**：超过 `dormantDays`（默认 14 天，`0` 表示关闭）无活动的**推测态且未置顶**的事自动转入 `已搁置`，重新聊到时自动浮回；
- **一次盘点 + 增量永不洗牌**：工作区冷启动一次性按硬信号（分叉血缘、引用句柄、业务文件重叠，自动过滤 `package.json` 等通用配置文件）叠加可选模型语义盘点存量；之后新会话只按 **L1 硬血缘 → L2 文件重叠 → L3 同工作区未收束事语义匹配** 增量挂载；
- **防污染边界（含三元触发来源模型，见 [ADR-0005](<docs/adr/0005-trigger-sources-fold-continuations-exclude-subagents.md>)）**：
  - **子代理与自动化独立会话全链路排除**：`header.origin === 'subagent'`、`delegationDepth >= 1` 以及定时/系统自动化独立会话在源头彻底排除出索引构建、跨会话检索、自动分类、工作区统计与「事」盘点，不污染工作区记忆；
  - **异步续跑回调轮折叠吸收**：父会话内无人类输入的 `subagent-settled` / `agent-message` / `team-message` / `goal` / `tool-jobs` 等异步续跑回调轮不单列，自动折叠回发起它的前一个 `human` 轮（保留原始 `turn`/`seq` 定位并记录 `foldedTurns`），合并其工具、命令、用量、文件变更快照与最终收口结论；
  - **旧事保护与并发写入**：撞上已锁定「已完成」的旧事时不静默改写，仅出重开建议条；同一件事允许挂多个并行活跃会话并按工作区串行防抖更新。

### 2 决策按需累积

简单小事保持极轻（目标 + 状态 + 现状/卡点 + 下一步），不强行生成空洞决策；只在出现换方案、放弃、回退或关键拍板时记录带轮次证据与 `supersede` 取代关系的决策，避免新会话重复踩坑（见 [ADR-0002](<docs/adr/0002-decisions-are-first-class.md>)）。

### 3 三层防失真续接与交接

原会话续接（`same-session`）与新开会话交接（`new-session`）统一采用三层协议（见 [ADR-0004](<docs/adr/0004-lossless-three-layer-handoff.md>)）：

1. **程序直取硬事实**：从轮次索引确定性拼装涉及文件、变更统计、最近命令与失败报错首行，不靠模型凭记忆复述；
2. **结构化态势 + 证据句柄**：目标、现行决策、已否决方案与下一步全部绑定原文句柄 `〔8hex#N〕`；
3. **Wire 层按需展开 + 工具下钻**：
   - 回到原会话时自动检测是否已串台（末尾仍是本事仅轻带下一步，末尾已串台则附带 `〔work:<id>〕` 纠偏）；
   - 新开会话时仅预填可编辑交接草稿（**绝不擅自替用户发送**），并调用 `POST /work-handoff-bind` 立即写入 L1 交接血缘边；
   - 发送给模型时经 `system-prompt/assemble` 注入结构化现场（受 `work-ledger` 幂等账本保护，不重复展开），需要原文细节时由模型调用 `history_turn` 工具按句柄召回。

### 4 日常话题回溯：检索、分类与引用

- **跨会话检索**：`POST /search` 支持 400ms 防抖输入即搜、`分类:名称 关键词` 前缀语法、有词按相关度排序、无词浏览态按时间倒序、真分页；
- **自动分类**：模型后台完成建类、命名与归类，人工纠正后锁定永不覆盖；
- **轮次引用**：输入框写 `〔8hex#N〕` 句柄，按 `compact 200 / standard 400 / rich 800` 字档位与配额（默认 ≤5 条 / ≤2400 字）自动展开，命令由程序追加；`POST /expand-preview` 可诊断展开明细。

---

## 安装

```bash
# 本机开发（link 方式，改代码后重载插件即生效）
dsh plugin --profile desktop add link:E:/dsh_plugin
```

或在 `~/.dsh/profiles/desktop/package.json` 中：

```jsonc
"dependencies": { "dsh-topic-map": "link:E:/dsh_plugin" },
"dsh": { "profile": { "bundles": [/* … */, "dsh-topic-map"] } }
```

---

## 架构

```
┌─────────────── 浏览器（lib/client.js bundle）───────────────┐
│ 右侧四页签抽屉（续接 / 历史 / 统计 / 设置）+ 两级历史轨      │
│   └── 纯函数视图模块（lib/*-view.js，独立单测）：            │
│       work-view · rail-view · hit-view · cite               │
│       stats-format · settings-view · clue-view              │
│       changes-view · rollback-plan · theme                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ POST /api/topic-map/*
┌──────────────────────────┴──────────────────────────────────┐
│ Host 侧（lib/index.js）                                     │
│   ├ 事核心域：segment · work-model · work-merge · handoff   │
│   │           work-store（串行原子写 / 增量同步 / 事级展开） │
│   ├ 检索底座：turn-index（schema 6）· search-index · rank   │
│   ├ 摘要与引用：turn-digest · expand-preview · history_turn │
│   ├ 自动分类：category-store · organize · category-auto     │
│   └ 动作与统计：outline · fork · brief · workspace-stats    │
└──────────────────────────┬──────────────────────────────────┘
                           │
        DSH 宿主（sessionQuery / sessionPersistence /
                  workspaceChanges / llm / tools）
```

---

## 数据布局

所有数据落盘在 `~/.dsh/topic-map/`（不写入插件源码目录）：

```
~/.dsh/topic-map/
├── works/<workspaceId>.json           工作区「事」与「段」物化快照 + 人工确认锁定 / 排除段 / 交接血缘
├── work-ledger/<sessionId>.json       事级 Wire 展开（〔work:<workId>〕）幂等账本
├── index/
│   ├── sessions/<sessionId>.jsonl     轮次索引（schema 6：首行 meta，其后每行一逻辑轮；支持三元触发来源模型）
│   └── labels/<workspaceId>.json      轮次状态标签（followUp / solved / starred）与备注
├── digests/<sessionId>#<turn>.json    轮次摘要缓存（按 endSeq + level 命中）
├── categories/<workspaceId>.json      分类树、归类与人工锁定
├── quote-ledger/<sessionId>.json      轮次引用（〔8hex#N〕）幂等账本
├── auto-classify-state.json           自动归类游标
├── config.json                        插件配置（沉降天数、拐点提示、摘要档位、引用配额等）
└── briefs/*.md                        生成的 Markdown 简报
```

轮次索引自 **schema 6** 起采用三元触发来源模型（见 [ADR-0005](<docs/adr/0005-trigger-sources-fold-continuations-exclude-subagents.md>)）：自动折叠 `subagent-settled` / `agent-message` / `goal` 等异步续跑回调轮并按文件去重合并其变更快照，同时彻底排除 `origin: 'subagent'` 与定时自动化独立会话（旧 schema 索引会自动触发增量重建）。索引与推测态物化快照**随时可重建**——以宿主会话日志为唯一事实源；用户确认锁定数据与交接血缘受独立保护，绝不被后台推断静默覆盖。

---

## 主要 HTTP 端点

统一前缀 `/api/topic-map`，响应信封 `{ ok: true, value }` 或 `{ ok: false, error }`（状态码区分 400 / 404 / 409 / 502 / 503 / 504）。

### 事（Work）与交接（Handoff）

| 端点 | 作用 |
|---|---|
| `POST /works` | 读取工作区「事」物化视图（未收束 / 已收束卡片、待核对数、最新拐点、重开建议） |
| `POST /works-scan` | 执行存量冷启动盘点或强制重扫（支持 `force`、`useModel`） |
| `POST /work-confirm` | 人工确认或编辑一条事（状态、标题、目标、卡点、下一步、置顶），转为「已确认态」锁定 |
| `POST /work-dismiss` | 将误判的事标为「不算事」（降回日常话题，并记录排除段防重复立事） |
| `POST /work-promote` | 将一个日常「话题」段一键转为一条「事」（话题 → 事） |
| `POST /work-merge` | 合并两条同源的事（`targetWorkId`、`sourceWorkId`） |
| `POST /work-split` | 将指定段从一条事中拆出为新事（`workId`、`segmentId`） |
| `POST /work-handoff` | 生成三层防失真续接/交接草稿（`mode: "same-session" \| "new-session"`），含硬事实与串台检测 |
| `POST /work-handoff-bind` | 新开会话后立即绑定 L1 交接血缘边（`handoffLinks[sessionId] = workId`） |
| `POST /work-inflection-dismiss` | 忽略并关闭当前拐点轻确认提示 |

### 检索、历史轨、分类与系统

| 端点 | 作用 |
|---|---|
| `POST /search` / `POST /find` | 跨会话轮次检索（支持 `categoryId`、`sort`、`offset/limit`、`sessionId` 反解工作区） |
| `POST /session-outline` | 会话窄大纲与 `segments` 段列表（供「段 → 轮次」两级历史轨使用） |
| `POST /turn-detail` / `POST /turn-digest` | 单轮详情（问答、用量、命令、变更、前后邻居）与缓存摘要 |
| `POST /expand-preview` | 引用展开诊断（命中哪些句柄、为何未展开） |
| `POST /session-commands` | 会话内代码块与命令清单（过滤、连续编号、分页） |
| `POST /labels` / `/label-set` / `/label-clear` | 轮次状态开关与一行备注读写 |
| `POST /index-build` / `/workspace-reindex` / `/workspace-warmup` / `/index-stats` | 索引构建、整区重建、切区预热与体积统计 |
| `POST /categories` / `/category-override` / `/category-reset` 等 | 分类读取、人工纠正锁定、重归类与结构整理 |
| `POST /fork` / `/retry` / `/brief` / `/stats` | 分叉、重试、Markdown 简报与工作区统计 |
| `POST /changes` / `/rollback-plan` | 轮次文件变更明细与只读回滚预演（不写文件） |
| `GET / POST /config` / `POST /reload` / `GET /health` | 配置读写（含 `dormantDays`、`inflectionNotice`）、插件重载与健康检查 |

---

## 只读干跑诊断（真实工作区验证）

按照 [ADR-0003](<docs/adr/0003-inferred-state-inflection-confirm-and-incremental-merge.md>) 的验证约束，仓库提供只读干跑脚本 [dry-run-works.mjs](<scripts/dry-run-works.mjs>)，直接只读扫描本机轮次索引，串联「切段 → 子代理过滤 → 冷启动硬信号聚类 → 沉降与卡片投影 → 硬事实与 Wire 上下文体检」，仅输出**脱敏统计报告**（绝不修改数据，绝不打印会话正文、敏感路径或密钥）：

```bash
# 默认扫描 ~/.dsh/topic-map/index/sessions
node scripts/dry-run-works.mjs

# 抽检最近 50 个会话，沉降阈值 14 天
node scripts/dry-run-works.mjs --max-sessions 50 --dormant-days 14

# 指定索引目录或过滤单个工作区 / 输出脱敏 JSON
node scripts/dry-run-works.mjs --index-dir <path> --workspace <workspaceId> --json
```

---

## 开发与校验

```bash
node scripts/build-theme.mjs      # 把纯函数模块嵌入 lib/client.js
node scripts/verify-bundle.mjs    # 校验嵌入模块导出完整（防运行时白屏）
node scripts/test-all.mjs         # 全量测试汇总（同时检查退出码与 FAIL 行）
```

修改被嵌入的纯函数模块后，需先运行 `build-theme.mjs` 再运行 `verify-bundle.mjs` 与 `test-all.mjs`，确认全部退出码为 0；新增被客户端调用的纯函数导出时，同步更新 [build-theme.mjs](<scripts/build-theme.mjs>) 中的导出清单。

---

## 文档导航

领域模型与核心架构决策以根目录术语表和 ADR 为唯一事实源：

- [GLOSSARY.md](<GLOSSARY.md>) — 领域词汇表（事 / 话题 / 段 / 会话 / 轮次 / 决策 / 状态 / 拐点 / 沉降 / 证据 / 续接 / 交接）
- [ADR-0001](<docs/adr/0001-continuator-not-retriever.md>) — 产品以「事的续接」为一等核心，兼顾无状态「话题」回溯
- [ADR-0002](<docs/adr/0002-decisions-are-first-class.md>) — 决策是事内一等但按需累积的事件
- [ADR-0003](<docs/adr/0003-inferred-state-inflection-confirm-and-incremental-merge.md>) — 双态推断、拐点轻确认与「一次盘点 + 增量挂载」
- [ADR-0004](<docs/adr/0004-lossless-three-layer-handoff.md>) — 三层防失真续接与交接协议
- [ADR-0005](<docs/adr/0005-trigger-sources-fold-continuations-exclude-subagents.md>) — 三元触发来源模型：折叠异步续跑回调轮，彻底排除子代理与自动化独立会话
- 早期历史索引阶段设计存档位于 `openspec/changes/history-index/`（供查阅底座演进背景）

---

## 已知限制

- **回滚只做预演**：`/rollback-plan` 给出「可回滚 / 已一致 / 已被修改 / 已不存在」四态，**不写文件**；
- **变更只到文件级**：记录文件增删行数与路径，暂无 hunk 级 diff；历史旧轮次可能因当时未记哈希而标记 `lost:true`；
- **语义增强依赖模型**：冷启动语义合并、增量 L3 匹配与自动归类在未配置可用模型时自动退回规则引擎或静默跳过，不影响首帧展示与核心检索；
- **时间线视图默认关闭**：保留在 `HISTORY_TIMELINE_ENABLED=false` 开关后；
- **仅支持 Windows**：路径归一与存储口径按 NTFS 约定。

---

## 版本沿革

- `v1.0.0` — 确立「事的续接 + 话题回溯」双层领域模型；落地段/事/决策/交接核心域（Host 持久化、10 个 `/work*` 端点、事级 Wire 展开、只读干跑诊断）、跨会话检索（索引 schema 6，支持三元触发来源模型：折叠 `subagent-settled` / `agent-message` / `goal` 等异步续跑回调轮并合并文件变更，彻底排除 `origin: 'subagent'` 与定时自动化独立会话）、自动分类、引用体系与历史轨；清理旧 v0 泳道图与三栏主面板遗产。
