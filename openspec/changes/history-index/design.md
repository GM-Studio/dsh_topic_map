# 实现设计

## 1. 数据布局

```
~/.dsh/topic-map/index/
  meta.json                     { version, schema, builtAt }
  sessions/<sessionId>.jsonl    头部一行 meta，其后一行一轮
  labels/<workspaceId>.json     状态与备注
~/.dsh/topic-map/templates/*.md 简报模板（文件为准，界面编辑）
```

按会话 ID 存事实、按工作区存标签：会话归属工作区可能变（`insertSessionBefore`），两边各自稳定。

**为什么 JSONL 不用 SQLite**：Electron 下原生模块要匹配 ABI，换 DSH 版本可能加载失败；
单行 JSON 可用现有 `writeFile` 原子写、可 diff、可 grep、坏了能手改。
1 万轮 ≈ 10MB，线性扫描 20–60ms，用不到数据库（见 §3）。

**为什么不复用 `buildTurnModel` 的文本**：它按设计只留 80/160 字预览，索引要全文。
两者共享事件折叠的判断逻辑，文本抽取独立且不截断（单轮 `prompt+response` 合计 32k）。

轮次行：

```json
{"turn":37,"seq":812,"endSeq":840,"start":1793000000000,"end":1793000060000,"ms":60000,
 "prompt":"…全文…","response":"…全文…","tools":["edit"],"files":["lib/client.js"],"commands":["node scripts/test-all.mjs"],
 "usage":{"input":13700,"output":3300,"cacheRead":0,"cacheWrite":0,"reasoning":0},
 "model":"deepseek-v4","endReason":"completed","interrupted":false,"steps":12,
 "truncated":false,
 "changes":{"files":[{"path":"lib/client.js","added":40,"deleted":5}],"total":1,"added":40,"deleted":5,"lost":false}}
```

`changes` 由 F-7 在事件出现时立刻拉取并落盘；`lost:true` 表示"曾变更但明细已不可读"。

`commands` 的抽取（schema **3**）：`command/cmd/script` 直取；`code` 只有 shell 类工具直接当命令，
其它工具（如 `run_code`）只**解包** `command:"…"` 字面量——解不出来就空着，**绝不把 JS 包装当命令**。
schema < 3 的索引一律判过期：消费端先走日志兜底（结果立刻正确），后台再重建。

## 2. 增量与重建

- 头部 meta 行带 `revision` 与 `turnCount`；读取先 `stat` 取 `revision`（复用 `readRevision`），一致就整文件跳过。
- 不一致 → 重读该会话事件流、整文件重写（tmp + rename 原子）。
- 重建与增量必须产出同一内容：重建路径不做任何增量猜测。
- 校验：`turnCount` 与日志不符、或 seq 非单调 → 重建该会话。
- **同 revision 也要解析校验**：否则被截断/手改坏的索引会永远跳过、永不自愈。
  但热路径（`/session` 打开时触发）只读**首行 meta** 做廉价判定 + 进程内 60 秒节流，
  完整校验留给 `/index-build` 与检索路径。
- **enrich 钩子**：只在重建时调用一次，序列化前执行；跳过路径不调用。
  重建时 `changes.lost === false` 的轮次直接复用、不再请求宿主；`lost === true` 下次重建重试。
  `buildTurnRows` 保持不依赖 ctx，纯函数边界不变。
- **`readIndexMeta`**（只读首行、最多 64KB）是廉价判定入口：`/session` 与后台队列用它，不进全文解析。
  `/index-build` 走完整校验，按会话或整个工作区执行（并发 2，单条失败不中断，逐条记 `reason`）。
- **已确认损坏时后台同步传 `force:true`** 绕过 meta 快速路径——否则坏索引会被当成"版本一致"永远跳过。

## 3. 内存与检索

- 进程内按工作区缓存 `Map<sessionId, Turn[]>`，用文件 mtime + revision 失效。
- **加载器必须先 stamp `sessionId` / `title`**：索引行模型不含它们（按会话分文件存），
  不补就会在 `groupBy:'session'` 时全部塌进同一组、`hit.sessionId` 为空。
- `groupBy` 目前只做 `none | session`；`lanes` 是占位（有 `laneId` 计不同段，否则 1），
  按话题分组要等 P1 分类实体化。
- **检索层三件事**：① stamp `sessionId/title` 后才进内核；② 索引不可用时现场 `buildTurnRows` 抽全文兜底
  （结果完整但慢），同时排队后台补建；③ `indexed.ready/missing` **按会话计、发生在关键词过滤之前**，
  兜底贡献了 hit 的会话仍记 missing。
- **后台队列**：并发 2、60 秒/会话节流、在途去重；不阻塞请求——`/session` 同步返回时读取事件流次数为 0。
- 141 轮语料（索引 220KB）实测 `/search` `elapsedMs` **1–2ms**。
- **单轮详情** `POST /turn-detail {sessionId, turn, before?, after?}`：索引命中直接投影（实测 **0.55ms**），
  缺失/损坏/过期回退 `readSession + buildTurnRows`（全文，非预览）并套 **2 秒超时**；
  返回 `{turn(16 字段), neighbors{ turn, promptHead≤40, time, endReason }, label}`；
  错误码区分 400 参数 / 404 轮次不存在 / 502 会话读不到 / 504 兜底超时。不新增落盘。
- **工作区反解**：`/search` 接受可选 `sessionId`，未给 `workspaceId` 时按它反解所属工作区；
  **反解失败返回 `reason` 而不是静默退第一个**（否则会静默搜错工区）。
  响应回传 `workspace/workspaceId` 与 `coverage{sessions,indexed,scannedFromLog,indexing}`。
- **补齐索引**：检索命中未建索引的会话时逐个入队（并发 2、在途去重、60 秒节流）；
  `POST /workspace-reindex {workspaceId}` 一键排空整工区，**不受节流**，立即返回 `queued`。
- **会话命令**：`POST /session-commands {sessionId, offset?, limit?}` → `{total,offset,limit,hasMore,commands[{seq,turn,text,ok}]}`；
  `seq` 跨轮连续、从 1 起；`limit` 封顶 100；`ok` 恒 `null`（索引没存每条命令的成败，**不编造**）。
- 逐条 `indexOf` 线性扫描，不做倒排：1 万轮 ≈ 10MB，中文子串 20–60ms，满足 S-7。
- 超过 5 万轮打性能日志，仍可用。
- 只回片段与元信息；全文要显式请求单轮。

## 4. 状态模型与断点续接（V-8）

**状态**只有三个独立布尔 + 一行备注：`followUp / solved / starred`，存 `labels/<workspaceId>.json`，
键 `sessionId#turn`，带 `source`。不做自由标签：在小规模上没人维护。

文件固定为**扁平 map**（写盘永远扁平、键排序、2 空格缩进）：

```json
{ "sid#37": { "followUp": true, "solved": false, "starred": true, "note": "", "source": "user", "updatedAt": 1793000000000 } }
```

- `note` 上限 500 字、写前 trim；`source` 缺失按 `model`、`updatedAt` 缺失按 0。
- **读侧兼容历史形状**（`{labels:{…}}`、`'solved'` 字符串、数组写法），统一归一成六字段。
- **损坏不覆盖**：JSON 无效或顶层非对象时，读/写/清都返回错误并保留原文件（一字节不动）。
- **串行写**：每 workspace 一条 promise 链做「读-改-写」，`tmp` + `rename` 原子替换；
  单个任务失败不会毒化后续写入。
- 三个端点：`/labels`（全量或单条）、`/label-set`（合并写，`source` 固定 user）、`/label-clear`。

**断点续接**是纯规则的一屏，算法：

```
候选 = 工作区内有轮次的会话（去掉归档）
每条：lastTurn = 最后一轮
      lastActivity = lastTurn.endTime
      lastLane = 该轮所属话题段的标题
      why = solved ? '已标记完成'
          : followUp ? '标记待跟进'
          : endReason ∈ {error, max-turns, interrupted} ? '失败/中断'
          : '静止'
分组：① 待跟进（人工） ② 自动未完成（失败/中断） ③ 其他近期（最多 5 条）
排序：组内按 lastActivity 倒序；上限 10 条 + 「查看全部」
```

主按钮按状态给：待跟进→继续；失败/中断→重试；有变更→看变更；其余→定位。
**不调模型**，只做字段组合与排序。

## 5. 排序

纯函数 `rankHits(hits, { now, weights, labels })`：

```
3×inPrompt + 1×inResponse + 0.2×min(matchCount,10)
+ 2×recency(今天1.0/本周0.7/本月0.4/更早0.2)
+ statusBonus(starred +2 / solved +1 / followUp +0.5)
```

- 只对过滤后的候选集打分（通常 < 200 条），每条 5 次乘加，< 1ms。
- **不需要后台预计算**：分数依赖查询词。
- **新鲜度按滚动自然日**：同本地日 1.0 / <7 天 0.7 / <30 天 0.4 / 更早 0.2（不是日历周、日历月）。
- **状态默认相加**（三个开关可叠用，全叠 3.5）；需要"只取最高"时传 `statusMode:'max'`。
- 同分：先 round 到 3 位再比 → `score` 降序 → `turn` 升序 → 输入顺序。
- 默认 `limit=50`；分组时 limit 作用于**组数**，`total` 恒为截断前命中数。
- 界面显示拆解：`提问×3 · 出现4次×0.8 · 2天前×1.4 · 重要+2`。

## 6. 引用协议（A-4）

分三档，默认最简：

```
① @第33轮对话〔4c42ff36#33〕                          ← 仅指针（工具上线后可用）
② @第33轮对话〔4c42ff36#33〕 · 把左栏改成三级树        ← 指针 + 一句摘要（工具上线前的默认）
③ 〔引用〕…（完整块，见下）                             ← 显式选，走预算确认
```

**裸指针没有意义**：模型看到 `@第33轮对话` 什么也拿不到。所以指针必须带句柄
`<会话前缀 8 位>#<轮号>`，并配一个宿主工具：

```
history_turn({ handle: "4c42ff36#33" }) → 该轮全文（受 token 预算截断）
```

工具用 `ctx.tools.register({ name, description, parameters, output, execute })` 注册；
description 里写明句柄格式，模型看到 `〔…#N〕` 才知道要调它。

完整块格式：

```
〔引用〕插件开发 › 话题地图 · 第 37 轮 · 2026-11-24 14:20
意图：把左栏改成三级树
结论：
- 用 data-owner 与 data-scope 分离两种高亮
- 缓存判定改为"会话都还在"
出处：session/<id>#37
```

- 摘要 ≈ 200 token，指针 ≈ 30 token；全文段落由用户在预览里勾选。
- 插入前用 `tokenMeter` 估算并显示 `约 +N tokens`；超过 `citeTokenBudget`（默认 5000）二次确认。
- 工具结果默认不带，例外：失败命令的错误首行。
- 结构化块可折叠回指针；纯文本拼接会让指针永久丢失。

### 6.1 指针解析（自动 + 工具）

**显示层短、wire 层够**：用户只看到 `@第33轮对话〔4c42ff36#33〕`，模型拿到的是该轮**摘要**（≤400 字）。

摘要由 `POST /turn-digest {sessionId, turn, force?}` 生成：缓存 `~/.dsh/topic-map/digests/<sessionId>#<turn>.json`
（形状 `{revision, endSeq, summary, model, at}`）。**命中只看 `endSeq`**——轮次一旦结束内容就不再变，
会话 `revision` 只作诊断（活会话每来一条新消息 revision 都会变，拿它当缓存键会导致每轮重算，真机踩过）。
未完成轮（`endSeq:null`）照常生成但不缓存；`force` 绕过缓存。
提示词明确"保留结论/关键决定/命令/文件，不复述过程"。**摘要调用必须与归类共用 `resolveRoute` + `askOnce`**——
`askOnce` 的 `limits` 要带 `sessionId`，否则 opencode 适配器会 400 MissingSessionID（真机踩过）。

两条通道：

1. **自动展开（首选）**——挂异步 `system-prompt/assemble` waterfall：`await next()` 后往 `assembly.contexts`
   追加 `{ name:'topic-map:引用展开', text, interpolate:false }`。
   为什么不用 `systemPrompt.context`：它的 `text` 只能同步返回，而展开要异步读索引/日志。
   `interpolate:false` 是必须的——用户内容里可能出现 `{{`。
2. **工具兜底**——`history_turn({ handle | sessionId+turn })`，description 里写明句柄格式，
   模型看到 `〔…〕` 才知道该调它。

口径：

- 只扫最近 **20 条人类消息**（`role:'user' && source.kind==='user'`），最多 **3 个**句柄，按出现顺序去重；
- 每块 ≤ **4000 字**、总量 ≤ **12000 字**（≈8k token），超限带截断标记；
- 只认 `〔8 位十六进制#轮号〕`；**不接受 `·全文` 后缀**（该档已取消）；其它形态走工具；
- 摘要生成失败时降级为"该轮回答前 400 字"并在块首标注，**插入流程不受影响**；
- `/turn-detail` 成功后 fire-and-forget 预生成摘要（并发 1、在途去重、缓存新鲜跳过、失败只记诊断），
  所以"先看详情再引用"通常零等待；
- 当前会话用内存 `buildTurnRows`（不依赖索引），历史会话索引优先、日志兜底，整体 2 秒超时；
- **不跨工作区**：跨区引用写"当前工作区没有匹配该前缀"，不猜；
- 工具的前缀匹配：唯一命中才用，多个命中**报歧义并列候选**，要求改用完整 sessionId——猜错会贴错全文。

## 7. 动作的实现路径

| 动作 | 走哪条路 | 现状 |
|---|---|---|
| A-1 定位 | Client `uiWorkspace.openSession(target)` → 复用 `pinToTop` | **target 形状未核实** |
| A-2 复制 | Client 本地；命令取自 `tool/call.arguments.command` | 可直接做 |
| A-3 状态 | Host 端点写 labels | 可直接做 |
| A-4 引用 | Client 写输入框 + `tokenMeter` 估算 | **写 composer 未核实**；降级=剪贴板 |
| A-5 fork | Client `sessions.fork({sessionId, atSeq})`；**`atSeq` 是 inclusive**（含该 seq） | 语义已核实；剩余"会话是否需空闲" |
| A-6 重试 | A-5 + 预填原 prompt | 依赖 A-5 |
| A-7 看变更 | `workspaceChanges.summary/diff` | 需先 F-7 落盘 |
| A-9 整理 | Host 写 labels | 依赖 P1 分类实体化 |
| A-12 回滚 | `fs.writeText/editText` + 哈希校验 | P3 |
| A-13 召回 | `tools.register`，**按话题/状态召回**（平台已有 `session_search`，不重复全文检索） | 契约存在，形状待核实 |

原则（AGENTS.md）：分类、会话上下文、文件恢复分别建模；**未核实的契约只写设计不写实现**。

## 8. 待核实清单（各有降级）

0. 右栏 tab：**运行时已验证可用**——真实 DSH 里图标出现、面板打开、搜索出结果。
   两段式注册 `ctx.sidebarRightTabs.register({id,kind,title,guide})` + `ctx.slots.inject('sidebar.right.pane.tab')`
   以定义 **id** 为 key；打开用 `ctx.sidebarRight.openTab(kind, options)`（无 sessionId 参数）。
   **注意**：客户端 Service 目录里看不到这两个服务，但它们在运行时存在——**不能据目录判断可用性**。
   默认选中仍不可设（宿主无 API）。降级仍是 `shell.overlay` 自绘抽屉。
1. `uiWorkspace.openSession(target)`：宿主声明的 `SessionTarget = SessionId | SubagentAddress`，
   传会话 id 即可；运行时仍需验"切过去后的焦点与滚动落点" → 降级：只高亮左栏 + 提示。
2. `sessions.fork({atSeq})`：`atSeq` 的声明是 **"Exact inclusive source event seq"**（含该 seq，允许切在未结束轮内部）。
   所以"从第 N 轮之前分叉"传 `该轮 startSeq - 1`。剩余未知：会话是否需空闲。
3. composer 是否允许外部写入草稿 → 降级：复制到剪贴板。
4. Host 工具注册的 definition 形状 → 未核实前不做 A-13。
5. `workspaceChanges` 对历史会话是否仍可读 → 不可读时显示"不可恢复"。
6. 原生轮次导航轨的 DOM 特征（容器 / `data-index` 按钮 / 滚动容器）→ 抓不到就降级为
   "叠加命中标记"，不做隐藏接管。

## 9. Windows-only 事项

- 删 `MAC_TEMP`（`lib/deliverables.js` 及 `lib/client.js` 嵌入副本 → 必须重跑 `build-theme.mjs`）。
- 删 `tests/portability.mjs` 的 macOS 用例，文件改 Windows 口径。
- `dshHome()` 保留 `HOME` 兜底（服务 Git Bash/CI），只改注释。
- 路径比较统一小写；显示用原生分隔符；UTF-8；时间存 epoch ms。

## 10. 与现有模块的关系

| 现有 | 处置 |
|---|---|
| `findAcrossSessions` | 保留端点形状，内部改读索引；旧行为作降级 |
| `lib/turn-model.js` | 复用事件折叠；新增全文抽取，不改预览行为 |
| `lib/session-cache.js` | 不变 |
| `lane-engine` / `session-category` | 不变；产出 laneId / 名称进标签层 |
| `lib/client.js` | 新增命中列表、断点续接、动作；旧面板保留 |
| `lib/report.js` / `deliverables.js` | 简报改为模板驱动，接上配置页 |

## 11. 版本

`index/meta.json` 带独立 `schema` 版本，与 `ENGINE_VERSION` 解耦：索引结构变就自增并整体重建。

## 12. 右栏契约（跨会话结果面）

**两段式注册**（已从宿主包与 `dsh-better-sidebar` 双向核对，更正了早前写错的签名）：

```js
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: 'dsh-topic-map:history', kind: 'topic-map-history',
  title: () => '历史', guide: [{ id: 'history', order: 15, title: () => '历史' }],
}))
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab', key: 'dsh-topic-map:history',
}, Body))
```

- **key 必须是定义 `id`，不是 `kind`**；`icon` 属于 guide 条目，不在 definition 顶层。
- 打开：`ctx.sidebarRight.openTab('topic-map-history', { params, revealIfOpened, replaceTab })`
  —— **没有 sessionId 参数**，只作用于已挂载的会话；无挂载会抛错。
- **默认选中不可设**：宿主没有 `defaultTab` / `setActive`，新列默认页由 guide 条目数决定（当前装配默认是 guide）。
  所以右栏不会默认是我们的，只能"打开即选中"（会展开右列）。
- **共存是加法式**：`sidebar.right.pane.tab` 按定义 id 分发，系统 tab（文件/文档/指引）不受影响；
  代价是 guide 页会多一张卡（条目 >4 时所有 description 会被隐藏）。

## 13. 摘要分层

| 层 | 来源 | 成本 | 何时 |
|---|---|---|---|
| L0 规则摘要 | 提问首句（≤40 字）+ 工具/文件计数 + `endReason` | **0** | 永远有 |
| L1 段级摘要 | 每话题段一次模型调用，缓存复用（即现有 lane 标题） | 低 | 归类/精化时 |
| L2「解释这段」 | 用户点击才调 | 单次 | 按需 |

检索、排序、列表、断点续接全部只依赖 L0；**模型不可用时功能不降级**，只是少了 L2。

## 14. 历史轨接管（替换原生轮次导航条）

**只能 DOM 级**：原生轨不是 slot。已核实的结构（DSH 0.2.1-rc.5，来自宿主包源码与 JSX 推断）：

```
[data-conversation-scroll]
  └ nav                          ← 含 button[data-index] 的那个
      └ div (overflow-y:auto)      ← 轨道自己的滚动容器，不是外层会话滚动
          └ div (marks)
              └ button[data-index][aria-label][aria-current]
```

- **只认 `data-index` / `aria-label` / `aria-current`**；类名是构建 hash（`SNx2jG_*`），不可依赖。
- **`data-index` 是合并列表的 0-based 序号，不是轮号**——映射走 `turnOutline` 或 `aria-label`（随 locale）。
- `turnOutline` 可达：`ctx.sessions.binding(id)?.session.projections.faceOf('turnOutline')`，
  形状 `{ turn(1-based), seq, prompt≤50, response≤120 }`。
- 已加载轮次用 `useChat(s => s.navigation.items())`；**活动轮没有公开快照** → 读 `button[aria-current="true"]` 反查。
- 接管：`visibility:hidden`（保留几何与 programmatic click），不 remove；自检失败就恢复原生。

风险口径：**失败可逆**——最坏是回到原生，不是白屏。
