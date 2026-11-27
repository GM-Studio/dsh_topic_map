# 三元触发来源模型：折叠异步续跑轮，彻底排除子代理与自动化会话

## Status
accepted (2026-11-27)

## Context

在真实多 Agent / 后台子代理协作场景下，原始事件流里存在两类严重污染工作区记忆的噪音：
1. **父会话内的异步续跑轮**：后台子代理完成回调（`subagent-settled`）、Agent 间消息（`agent-message` / `team-message`）、Goal 自动续跑（`goal`）或后台任务唤醒（`tool-jobs`）会触发新的 `turn/start`，但没有人类输入（`prompt === ''`）。实测本地历史中约 9.9% 的轮次属于此类，直接平铺会导致历史列表与历史轨刷出大量“进度同步 1/4、2/4”心跳行、切碎连续工作段，而粗暴丢弃又会丢失最后一个收口轮的最终结论与文件变更。
2. **子代理独立会话与定时自动化会话**：通过 `subagent` / `subagent_fork` 派生的独立子会话（宿主权威标记 `header.origin === 'subagent'`、`delegationDepth >= 1`）以及定时/系统自动化会话本质是内部施工过程，若混入工作区会话枚举、检索、统计、分类或盘点，会淹没人类真正推进的「事」与「话题」。

## Decision

引入基于宿主权威字段（`user/message.data.source.kind` 与 `SessionHeader.origin`）的三元触发来源模型：

1. **`human`（一等锚点）**：`source.kind ∈ { 'user', 'retry' }` 触发的轮次，作为独立逻辑轮次进入索引、检索、历史轨、切段与「事」。
2. **`continuation`（折叠吸收）**：`source.kind ∈ { 'subagent-settled', 'agent-message', 'team-message', 'goal', 'tool-jobs' }`（或紧随人类轮之后、无人类输入的异步回调轮）**不作为独立轮次暴露**，而是将其全部工具、文件、命令、变更快照、异常状态、用量、步数、终结时间/`endSeq` 以及最终收口回复折叠吸收回发起它的前一个 `human` 轮（保留原始 `turn` 与 `seq` 以便跳转定位；并记下折叠轮数 `foldedTurns` 与 `trigger: 'human'`）。中间纯进度心跳自然消隐，最终收口结论与全部硬事实 100% 保留。
3. **`automated`（彻底排除）**：`header.origin === 'subagent'`、`delegationDepth >= 1`、以及定时/自动化会话彻底不进入工作区记忆库（不参与索引构建、跨会话检索、自动分类、工作区统计与「事」盘点），一切以父会话折叠后的最终结果为准。
4. **父发给子的原始派工指令不倒灌正文**：维持仅记录父 Agent 面向人的总结与真实产出硬事实，不把 `tool/call` 里的内部派工长 prompt 混入对话正文与摘要。

## Considered Options

- **直接丢弃所有非人类触发的轮次**：最省事，但当最后一个后台子代理交卷后父 Agent 在回调轮里跑全量测试、顺手修 bug、提交并给出最终总结时，这些高价值结论与文件变更会全部丢失。
- **保留子代理独立会话并加一个“含子代理”检索开关**：保留了排查子代理原文的后路，但需要持续索引、存储与过滤几十倍于人工会话的子代理记录，违背“工作区记忆只记人与 AI 的协作主线”的第一性原理，且 DSH 宿主本身已保存子代理原始记录。
- **用启发式规则挑“有信息量”的回调轮单列**：难以准确定义何为“有信息量”，且仍会在历史轨与切段中制造无人类提问的孤儿轮。

## Consequences

- `lib/turn-index.js` 的 `INDEX_SCHEMA` 升至 `6`（自动触发旧索引增量重建），轮次行新增 `trigger` 与 `foldedTurns` 字段，同时对 `changes` 等硬事实在跨回调轮折叠时按文件去重合并、取最新快照。
- `listWorkspaceSessions`、`searchWorkspaceIndex`、`readWorkspaceStats`、`indexBuildTargets`、`work-store` 在源头统一排除 `origin === 'subagent'` 与自动化会话。
- 若某会话开头在任何人类轮之前就出现孤立非人类轮（如纯定时/系统触发），不强行无头折叠，交由 `automated` 会话边界排除。
