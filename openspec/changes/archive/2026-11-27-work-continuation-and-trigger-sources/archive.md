# 变更归档：工作「事」续接器、日常「话题」回溯与三元触发来源模型

- **状态**：已完成（Completed & Archived）
- **归档日期**：2026-11-27
- **仓库与分支**：`GM-Studio/dsh_topic_map` (`main`)
- **核心依据**：[GLOSSARY.md](<../../../../GLOSSARY.md>)、[ADR-0001](<../../../../docs/adr/0001-continuator-not-retriever.md>) ~ [ADR-0005](<../../../../docs/adr/0005-trigger-sources-fold-continuations-exclude-subagents.md>)

## 1. 背景与目标

从第一性原理重新梳理 DSH 用户在工作区里的两类核心记忆痛点：
1. **工作场景（事驱动）**：回答「这件事干完没、卡在哪、当前是什么状态、做过哪些关键决策、下一步是什么」，并支持无失真回到上次现场或新开会话交接；
2. **日常闲聊/交流场景（话题驱动）**：不强行套状态机，通过跨会话关键词检索与对话区右缘「段 → 轮次」两级历史轨，快速找回「哪个话题在哪个对话、哪一轮」，并支持话题 ↔ 事一键互转；
3. **多 Agent / 子代理防污染**：按宿主权威字段建立「`human` / `continuation` / `automated`」三元触发来源模型，折叠异步续跑回调轮（去心跳噪音、保最终收口与跨轮变更）并源头彻底排除子代理与定时自动化独立会话。

## 2. 交付成果与提交映射

| 提交 | 内容摘要 |
| --- | --- |
| `837b519` | 确立领域术语表 [GLOSSARY.md](<../../../../GLOSSARY.md>) 与 ADR-0001 ~ ADR-0004 |
| `cd16548` | 阶段一清理：删除 17 个已下线 v0 泳道图/三层树遗产模块、`scripts/build-viewport.mjs` 及 25 个死测试，精简客户端与 Host 死代码 |
| `53cc50f` | 阶段二核心纯域：[segment.js](<../../../../lib/segment.js>)、[work-model.js](<../../../../lib/work-model.js>)、[work-merge.js](<../../../../lib/work-merge.js>)、[handoff.js](<../../../../lib/handoff.js>) 与只读干跑脚本 [dry-run-works.mjs](<../../../../scripts/dry-run-works.mjs>) |
| `7865473` | Host 接入：[work-store.js](<../../../../lib/work-store.js>)、[index.js](<../../../../lib/index.js>) 物化持久化、`/work*` 端点、事件增量钩子、事级 Wire 自动展开与 E2E 测试 |
| `9c5ccf5` | 客户端升级：四页签抽屉 `［续接］［历史］［统计］［设置］`、4 行卡片、拐点轻确认、历史轨「段 → 轮次」两级目录、设置项与 [README.md](<../../../../README.md>) |
| `1b24dbf` | 修复核对模式交互（`pendingReviewCount` 仅计未收束 + 逐条核对 + `/work-review-all`）与重新盘点两阶段快返（`asyncRefine` + 25s 硬超时 + 自动轮询），并修复 6 处边界容错 |
| `39d0929` | 新增 [grill-scenarios.mjs](<../../../../tests/grill-scenarios.mjs>)（10 大真实场景）与 [resilience-edge.mjs](<../../../../tests/resilience-edge.mjs>)（14 组异常边界压测） |
| `26bdecc` | 确立 [ADR-0005](<../../../../docs/adr/0005-trigger-sources-fold-continuations-exclude-subagents.md>) 三元触发来源模型并同步 [GLOSSARY.md](<../../../../GLOSSARY.md>) 与 [README.md](<../../../../README.md>) |
| `ed7a0a5` | 索引升级 `INDEX_SCHEMA = 6` 折叠异步续跑回调轮并归并跨轮文件变更；7 大入口彻底排除子代理与自动化独立会话；新增 [trigger-sources.mjs](<../../../../tests/trigger-sources.mjs>) |

## 3. 验收证据

- **构建与嵌入校验**：`node scripts/build-theme.mjs`、`node scripts/verify-bundle.mjs`（10/10 模块导出完整）、`node --check lib/client.js`、`node --check lib/index.js` 均退出码 `0`。
- **全量测试**：83 个测试文件 / 1,335 项用例全部通过，0 失败（含场景集、容错集、端到端集与三元触发来源集）。
- **真实 DSH 验证**：热重载 `POST /api/topic-map/reload` 无告警；`POST /api/topic-map/index-build` 升级至 `schema 6` 后，工作区检索结果空提问回调轮数清零（`0/110`）；`POST /api/topic-map/works-scan` 两阶段快返耗时 ~357ms；异常 JSON 请求体返回 HTTP 400。
- **真实历史干跑**：[dry-run-works.mjs](<../../../../scripts/dry-run-works.mjs>) 已对本机历史索引只读脱敏抽检，完成切段与字段契约校准。
