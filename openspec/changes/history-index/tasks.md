# 执行清单

**环境**：bash 可用（`E:\dsh_plugin` 所有权已修复）；仓库为 git，最新提交见 `git log -1`。
每项完成 = 先红后绿 + 定向测试 + 全量 + 构建 + `verify-bundle` + 真实 DSH 证据 + 独立本地提交（不推送）。

**当前基线**：`59 个测试文件 / 1095 用例 / 0 失败`；`verify-bundle` 11 个嵌入模块完整。
图例：✅ 已提交且真机冒烟过；🟡 已实现，未在真实界面确认；⬜ 未开始。

## P0 — 索引与检索

- [x] ✅ P0-1 `lib/turn-index.js` 全文抽取 + 轮次行序列化（schema 4：含 `endSeq` / `commands`）。`d50d7e1`
- [x] ✅ P0-2 增量与重建：meta 行、`revision` 比对、tmp/rename 原子写、schema 升版整体重建。
- [x] ✅ P0-3 `lib/search-index.js` + `POST /search`：多词 AND、时间/结构过滤、分组、截断。`73774ed`
- [x] ✅ P0-4 `lib/rank.js` 五元权重打分（纯函数，含手算对照与同分稳定）。
- [x] ✅ P0-5 旧 `/find` 改读索引，保留返回形状，不可用回退旧实现（N-3）。`d50d7e1`
- [x] ✅ P0-3b 生产触发：`/session` 打开时 fire-and-forget 同步 + `POST /index-build`。`73774ed`
- [x] ✅ P0-6 右栏 tab 注册与打开（`sidebarRightTabs` + `slots.inject`）。
- [x] 🟡 P0-7 右栏列表：两行/就地展开/详情/定位/复制/标记；排序条与分数拆解待界面确认。
- [x] 🟡 P0-8 跨会话落点（A-1）：`fork` 语义与 `atSeq` 已核实，跳转已在真机用过。
- [x] ✅ P0-9 变更快照落盘（F-7）：`workspace/changes` → `changes`，不可读记 `lost:true`。
- [x] ✅ P0-10 Windows 清理：`MAC_TEMP` 与 macOS 断言已删除（`grep MAC_TEMP` 无残留）。
- [ ] ⬜ P0-11 历史轨 spike（V-12）：抓原生轨 DOM（容器 / `data-index` 按钮 / 滚动容器）。
- [ ] ⬜ P0-12 历史轨渲染：隐藏原生（保留节点）、三档宽度、摘要常显、命中模式、自检回退 + 开关。
- [x] ✅ P0-13 全量：`test-all` + `build-theme` + `build-viewport` + `verify-bundle`。

## P0+ — 引用体系（原 P2-3，已超计划完成）

- [x] ✅ 指针插入：`【@第N轮对话〔前缀#轮号〕】`，光标位置、选区替换、空框开头。
- [x] ✅ 插入判定：execCommand → 30ms 轮询(≤400ms) → 静置 60ms 防撤回 → DOM 兜底 → 剪贴板兜底。
- [x] ✅ 解析：当前会话 → 同工区；`agent/inbox/claimed` 补"当前消息不在历史里"的窗口缺口。
- [x] ✅ 幂等：`quote-ledger/<sessionId>.json` 落盘，每会话每句柄只注入一次。
- [x] ✅ 配额：`quoteMaxCount=5` / `quoteMaxChars=2400`，先到者停，未展开数量写在块末。
- [x] ✅ 摘要三档：`digestLevel` = compact 200 / standard 400 / rich 800；命令由程序确定性追加。
- [x] ✅ 缓存：按 `endSeq + level` 命中（活会话 revision 不再导致重算）。
- [x] ✅ 后台预生成：`/turn-detail` 成功后入队（并发 1、在途去重、失败静默）。
- [x] ✅ 拒绝：当前会话活动轮不注入；归档不可读拒绝；均不记账。
- [x] ✅ 诊断：`POST /expand-preview` 返回 `handles/blocks/reason/alreadyInjected`。
- [x] 🟡 真实界面：待用户确认"插入即成功"与两档字号观感。

## P0+ — 复制与代码块

- [x] ✅ 代码块提取：只取 assistant 回答的 markdown 围栏（`lib/code-blocks.js`），所有语言。
- [x] ✅ `POST /session-commands`：`{seq,turn,lang,text}`、`q`/`lang`（含 `shell` 组）筛选、分页。
- [x] ✅ 命中计数统一：`hit.blockCount` 与浮窗同源（`commandCount` 为同值别名）。
- [x] 🟡 浮窗 UI：贴右栏 420、固定 520 高、自动换行 + 悬挂缩进、本页/全部复制。待目视。

## P1 — 断点续接与整理

- [x] ✅ P1-1 标签端点 `/labels` `/label-set` `/label-clear`。`982ad8c`
- [x] ✅ P1-2 视图模型 `lib/resume-view.js`（三组、主按钮、上限 10）。`9158330`
- [ ] ⬜ P1-3 分类实体化：稳定 ID + 人工 override，模型只填空白。
- [ ] ⬜ P1-4 整理动作（A-9）：改名/移动/合并/拆分 + 可撤销。
- [ ] ⬜ P1-5 线索视图（V-4）。
- [ ] 🟡 P1-6 统计视图（V-5）：`lib/stats-view.js` 模型已完成，界面未接。
- [ ] ⬜ P1-7 `workspace-category-*.json` 迁移。

## P2 — 承接

- [ ] ⬜ P2-1 fork@turn（A-5）：四前置条件 + 血缘 + 标题 + 上限提示。
- [ ] ⬜ P2-2 重试（A-6）：`fork(该轮之前)` + 重提原 prompt。
- [ ] ⬜ P2-4 简报（A-8）：模板驱动，生成 Markdown 落盘。
- [ ] ⬜ P2-5 设置页（V-9）：模板、`digestLevel`、`quoteMaxCount/Chars`、索引状态。

## P3 — 危险写与 agent

- [ ] ⬜ P3-1 变更可视化（A-7）：列表 → hunk → 文件演化史。
- [ ] ⬜ P3-2 单文件回滚（A-12）：哈希校验、跳过不覆盖、三态报告、可撤销。
- [x] ✅ P3-3 agent 召回（A-13）：`history_turn` 工具已注册（返回该轮摘要 + `truncated`）。

## 后期（L2 规模化检索，未排期）

**触发条件**：单工区轮次 > 2 万，或 `/search` P95 > 300ms。

- [ ] ⬜ `searchBackend` 接口层：默认 JSONL 扫描，超阈值切 SQLite（`node:sqlite` 仍 experimental，
      包一层保证可回退；最坏退回慢路径而不是崩）。
- [ ] ⬜ L0 会话元数据索引（id/title/cwd/轮数/首末时间/size/revision）：先建它，让界面秒开。
- [ ] ⬜ L1 存量批量建索引：按最近活跃优先、可中断、断点续传、并发 2。
- [ ] ⬜ L2 FTS5 `trigram`：只索引 `prompt + response[0..2000]`；**≥3 字走 MATCH**，
      **1–2 字走 L0 剪枝 + 候选集线性扫/LIKE**（trigram 两字必空，实测）。
- [ ] ⬜ 检索语法：多词 AND、短语、`turn:` / `session:` / `tool:` / `file:` / `after:`。
- [ ] ⬜ 命中后回 JSONL 取全文与高亮（FTS 只负责召回）。

**已实测（2026-11，本机 Node 24）**：2 万轮插入 60ms/查询 0–1ms；20 万轮插入 2007ms、
3 字 5ms、4 字 15ms、DB 108.4MB（0.56KB/轮，约正文 1.9×）、两字 LIKE 全表 55ms。
压测脚本：`scripts/bench-fts.mjs`（不入测试集）。

## 完成定义

1. 先有可失败的行为测试，再有实现；测试单独跑通。
2. 定向 + 全量 + 构建 + `verify-bundle` 通过。
3. 至少一条真实 DSH 证据。
4. 走查后独立本地提交；不推送；不提交会话内容、密钥、完整日志。
5. README 与本次改动一致（新增端点、动作、局限）。
