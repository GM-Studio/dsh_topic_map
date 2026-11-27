# 变更归档：事续接 v2 —— 准入、主线聚合、提炼可靠性、只读巡检与空会话语义

- **状态**：已完成（Completed & Archived）
- **归档日期**：2026-11-27
- **仓库与分支**：`GM-Studio/dsh_topic_map` (`main`)
- **核心依据**：[GLOSSARY.md](<../../../../GLOSSARY.md>)、[ADR-0006](<../../../../docs/adr/0006-admission-criteria-for-resumable-works.md>) ~ [ADR-0012](<../../../../docs/adr/0012-empty-sessions-are-not-conversations.md>)
- **接口契约**：[resume-v2-interfaces.md](<../../../../docs/contracts/resume-v2-interfaces.md>)
- **改造前基线**：[resume-v2-baseline.md](<../../../../docs/audits/resume-v2-baseline.md>)

## 1. 背景与目标

用户反馈「本工作区的续接还行，但换到其它工作区就完全没达到预期」，并要求从第一性原理重新对齐「为什么要做事件续接、能续接什么、以什么标准判断、下一步建议怎么给」。

量化诊断发现四个病灶（真机 8 个工作区、74 会话、237 条事）：

| 病灶 | 证据 |
| --- | --- |
| 下一步几乎全空 | 193 / 237 = 81.4% 留白 |
| 语义层从未跑通 | 决策 0 条、提炼成功 0/8 工作区 |
| 碎卡严重 | 最高每会话 3.88 条事 |
| 失败不可见 | `semanticUsed:false` 却无任何原因 |

目标：让续接回答「我还有哪几件没办完、走到哪、卡在哪、下一步干什么」，每个工作区 1~5 条真主线而不是 20 张碎卡。

## 2. 领域决策（ADR）

| ADR | 决策 |
| --- | --- |
| [0006](<../../../../docs/adr/0006-admission-criteria-for-resumable-works.md>) | 续接准入三条红线：有意图 + 未收尾 + 人类主导，同时满足才进续接；人的确认高于红线；每条事留下准入原因 |
| [0007](<../../../../docs/adr/0007-session-mainline-aggregation-and-awaiting-signal.md>) | 自顶向下以**会话主线**聚合（1 会话 ≈ 1 主线），只在长间隔 + 话题漂移或人类显式转折处拆分；把「待确认」升为一等信号 |
| [0008](<../../../../docs/adr/0008-workspace-scope-switching-and-inspection.md>) | 严格跟随当前工作区、切区即清态、自动补齐索引与提炼、顶部切换器；空态必须可区分 |
| [0009](<../../../../docs/adr/0009-next-step-suggestion-and-resume-guidance.md>) | 下一步模型优先、规则兜底**绝不留白**；预填可执行首句；Wire 注入对齐协议 |
| [0010](<../../../../docs/adr/0010-semantic-refinement-reliability-and-visibility.md>) | 修通语义提炼调用契约 + 状态诚实可见（含具体原因）+ 一键重试，禁止静默吞错 |
| [0011](<../../../../docs/adr/0011-cross-workspace-inspection-is-read-only.md>) | 当前工作区 = 会话归属工作区；跨区一律只读（含重扫与重提炼）；交接是唯一例外且新会话落在被巡检工作区 |
| [0012](<../../../../docs/adr/0012-empty-sessions-are-not-conversations.md>) | 会话是壳、对话是瓤；空会话不进对话列表但如实计数；新增 `no_content` 空态 |

## 3. 交付成果与提交映射

| 提交 | 内容摘要 |
| --- | --- |
| `72436f6` | ADR-0006~0010、GLOSSARY 增补、接口契约、只读体检脚本、改造前基线 |
| `a7ad9c7` | 准入三红线（[admission.js](<../../../../lib/admission.js>)）与下一步规则兜底（[next-step.js](<../../../../lib/next-step.js>)）；work-model 新增 admission/awaiting/nextStepKind 与 excluded 分组 |
| `19cf69c` | 会话主线聚合：切段 strategy + planColdStartWorks 自顶向下（[segment.js](<../../../../lib/segment.js>)、[work-merge.js](<../../../../lib/work-merge.js>)） |
| `cd6ee68` | 修通语义提炼（补 sessionId 根因）、refineStatus 落盘透出、`POST /work-refine-retry`、分批提炼 |
| `835650b` | 客户端切区即清态 + 四态空态纯函数（[work-view.js](<../../../../lib/work-view.js>)） |
| `8361f12` | README 补续接质量体检与契约导航 |
| `a7a2c95` | 端到端验收 v2 五条决策（[resume-v2-integration.mjs](<../../../../tests/resume-v2-integration.mjs>)） |
| `4080a88` | 提炼超时自适应拆分；`maxTokens` 4096 是 llm-call 注释点名的病态值 → 16384 |
| `63c4f4c` | 四态空态接进渲染层 |
| `2f22b22` | 工作区切换器与提炼状态条（含一键重试） |
| `f0fd438` | 全场景端到端矩阵：正常 / 异常 / 失败 19 场景 |
| `d6df5a2` | 审计口径区分「未收束留白」与「已收束的合理空」 |
| `0d6a738` | 历史路由适配器已卸载时不再整体失败；提炼失败原因具体可见（`refineStatus.detail`） |
| `4579f23` | `no_model` 替代笼统 `failed`；兜底轮换报第一条错误 |
| `8c7817c` | ADR-0011 / ADR-0012 与 GLOSSARY 新术语 |
| `ab97878` | 只读巡检后端闸门（8 个写端点 403）+ 客户端切换器上移抽屉标题栏 + `no_content` 态 |
| `2c9cda3` | **根因修复**：`isAutomatedSession` 第 5 条空会话规则未被 `ignoreEmpty` 包裹，导致空会话被整批丢弃 |
| `d0e6e02` | 下拉 `Number(null)===0` 谎报「0 对话」；主对话变更时巡检视角级联跟随 |
| `83a651c` | 只读巡检时 13 个写按钮禁用，交接两个保留，卡片区常驻只读说明条 |

## 4. 验收证据

### 4.1 真机前后对比

| 指标 | 改造前 | 改造后 |
| --- | --- | --- |
| 事数 | 237 | 45 |
| 未收束 | 57 | 13 |
| 每会话产出事数 | 最高 3.88 | 最高 1.33 |
| **未收束下一步留白** | 72 / 78 | **0** |
| 决策 | 0 | > 0 |
| 跨会话合并 | 2 | 12 |
| 待确认信号 | 0 | 5 |
| 语义提炼成功工作区 | **0 / 8** | **5 / 8**（其余为无簇或模型不可用，原因可见） |

### 4.2 构建与测试

- `node scripts/build-theme.mjs` 嵌入 10 个纯模块；`verify-bundle` 10/10 导出完整；`node --check` 全过。
- 全量 **94 个测试文件 93 通过**，唯一失败的 [bundle.mjs](<../../../../tests/bundle.mjs>) 是沙箱禁止 `spawnSync` 的既有环境限制（改动前即如此）。

### 4.3 真机 LIVE-E2E（14 项全过）

跨区写 / 跨区重扫 / 跨区重提炼 → **403**；本区写 → 放行到 handler；跨区读 → **200**；跨区交接 → 不拦；缺 workspaceId / 未知工作区 → 400 / 404；空会话工作区 `no_content` 数据就绪。

### 4.4 空会话识别（ADR-0012 根因）

| 工作区 | 修前 | 修后 |
| --- | --- | --- |
| `default-workspace` | registry=3，conv=0 **empty=0** excluded=3 | conv=0 **empty=3** excluded=0 |
| `llm_selector` | registry=1，conv=0 **empty=0** excluded=1 | conv=0 **empty=1** excluded=0 |

## 5. 新增工具

- [dry-run-resume-quality.mjs](<../../../../scripts/dry-run-resume-quality.mjs>)：只读、脱敏的续接质量体检，输出下一步留白率 / 决策数 / 跨会话合并 / 待确认 / 未准入原因 / 提炼状态，用于前后对比。

## 6. 遗留与后续

1. **两个工作区语义提炼仍不可用**：`specgate` 的会话历史只记 provider 未记 model，`deepseek-official` 等兜底 provider 无可用 model id，因此 `refineStatus.reason = no_model`（界面可见、可重试）。需在设置里指定 provider + model，或让该工作区产生一次新会话以写入新的 `request/header`。
2. **只读区的「合并 / 拆段」尚未在界面上出现**：当前卡片动作集里没有这两个入口，后端端点已就绪；等入口做出来时需一并纳入只读禁用清单。
3. **级联更新只验证到规则与接线层**：抽屉靠每秒轮询 `data-conversation-session` 发现会话切换，未在浏览器里实测真实切换动作；若实测不跟，应改为直接订阅 `uiConversation` 服务。