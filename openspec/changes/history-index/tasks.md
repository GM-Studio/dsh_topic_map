# 执行清单

**环境**：bash 已可用（`E:\dsh_plugin` 所有权已修复）；仓库为 git，跟踪文件干净，最新提交 `50d9d39`。
每项完成 = 先红后绿 + 定向测试 + 全量 + 构建 + `verify-bundle` + 真实 DSH 证据 + 独立本地提交（不推送）。

## P0 — 索引与检索（可独立验收）

- [ ] P0-1 `lib/turn-index.js`：全文抽取 + 轮次行序列化。
      先写 `tests/turn-index.mjs`：全文不被 80/160 截断、字段完整、超长单轮 32k 截断并置标志。
- [ ] P0-2 增量与重建：头部 meta 行、`revision` 比对、tmp/rename 原子写。
      测试：连续构建两次第二次不读事件流；删除后重建哈希一致；截断文件自动重建。
- [ ] P0-3 `lib/search-index.js` + `/api/topic-map/search`：多词 AND、时间、结构过滤、分组、截断。
      测试 `tests/search-index.mjs`：中文子串、边界时间、组合过滤、`truncated`。
- [ ] P0-4 `lib/rank.js`：S-5 五元权重打分，纯函数；测试含手算对照与同分稳定。
- [x] P0-5 旧 `/find` 改读索引，保留返回形状；索引不可用回退旧实现（N-3）。已提交 `d50d7e1`。
- [x] P0-3 `POST /api/topic-map/search` 接线（searchTurns + rankHits + stamp sessionId/title）。已提交 `73774ed`。
- [x] P0-3b 生产触发：`/session` 打开时 fire-and-forget 同步（只读首行 meta + 60s 节流）；
      `POST /api/topic-map/index-build` 维护/重建入口。已提交 `73774ed`。
- [ ] P0-6 右栏 spike：用 `ctx.sidebarRightTabs` 注册空 tab、`openTab` 打开，确认注册形状与正文座位绑定；
      失败则切 `shell.overlay` 自绘抽屉（交互不变）。
- [ ] P0-7 右栏列表：查询态两行、就地展开、排序条与分数拆解、复制反馈（A-2/A-14）、L0 规则摘要（V-11）；
      空态先用自动推断的"未完成 / 近期 3 条"，P1-2 接入状态后升级为续接 Top3。
- [ ] P0-8 跨会话落点（A-1）：**先 spike** 核实 `SessionTarget` 与 `atSeq` 语义，再接入。
- [x] P0-9 变更快照落盘（F-7）：写入口 `syncSessionIndexFor` + `/session` 与 `/search` 触发。
      已提交 `d50d7e1` / `73774ed`。覆盖边界见 spec F-7：只有打开过/搜索过/显式重建的会话会落盘。
- [ ] P0-10 Windows 清理：删 `MAC_TEMP` 及嵌入副本、删 macOS 测试用例、改 `dshHome` 注释。
- [ ] P0-11 历史轨 spike（V-12）：抓原生轨 DOM（容器 / `data-index` 按钮 / 滚动容器），
      验 `turnOutline` 可达性；不可达则自己算，但必须按已加载范围截断。
- [ ] P0-12 历史轨渲染：隐藏原生（保留节点）、三档宽度、摘要常显、命中模式、点击跳转、
      自检失配回退 + 设置开关。
- [ ] P0-13 全量：`test-all` + `build-theme` + `build-viewport` + `verify-bundle`。

## P1 — 断点续接与整理

- [x] P1-1 Host 半边：三个标签端点（`/labels` `/label-set` `/label-clear`）。已提交 `982ad8c`；
      客户端开关与消费留到 P1。
- [x] P1-2 视图模型：`lib/resume-view.js`（三组归位、主按钮、上限 10）。已提交 `9158330`；界面待 P1。
- [ ] P1-3 分类实体化：稳定 ID + 人工 override，模型只填空白。
- [ ] P1-4 整理动作（A-9）：改名/移动/合并/拆分 + 整理历史可撤销。
- [ ] P1-5 线索视图（V-4）。
- [ ] P1-6 统计视图（V-5）：活跃度为主、用量为辅。
- [ ] P1-7 旧 `workspace-category-*.json` 迁移：按名称生成 ID 并保留原名称。

## P2 — 承接

- [ ] P2-1 fork@turn（A-5）：前置四条件 + 血缘自存 + 标题 + 未归类 + 上限提示。
- [ ] P2-2 重试（A-6）：`fork(该轮之前)` + 重提原 prompt；一次一执行。
- [ ] P2-3 引用（A-4）：三层 + `tokenMeter` 估算 + `citeTokenBudget`（默认 5000）+ 结构化块。
- [ ] P2-4 简报（A-8）：模板驱动，生成 Markdown 落盘。
- [ ] P2-5 设置页（V-9）：`settings.section` 独立页——模板增删改、`citeTokenBudget`、排序权重、
      索引状态（大小 / 会话数 / 重建 / 清理）。

## P3 — 危险写与 agent

- [ ] P3-1 变更可视化（A-7）：列表 → hunk → 文件演化史。
- [ ] P3-2 单文件回滚（A-12）：哈希校验、跳过不覆盖、三态报告、可撤销。
- [ ] P3-3 agent 召回（A-13）：先核实工具注册形状。

## 完成定义

1. 先有可失败的行为测试，再有实现；测试单独跑通。
2. 定向 + 全量 + 构建 + `verify-bundle` 通过。
3. 至少一条真实 DSH 证据。
4. 走查后独立本地提交；不推送；不提交会话内容、密钥、完整日志。
5. README 与本次改动一致（新增端点、动作、局限）。
