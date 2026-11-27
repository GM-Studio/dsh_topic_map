# 事续接 v2 接口契约（ADR-0006 ~ ADR-0010 实现契约）

> 本文件是并行实施的**唯一接口事实源**。所有模块签名以本文件为准；改动需先改本文件。

## 1. `lib/admission.js`（新增，纯函数，无 IO）

```js
export const ADMISSION_REASONS = Object.freeze({
  ADMITTED: 'admitted',
  NO_INTENT: 'no_intent',          // 没有未兑现的目标或产出意图
  ALREADY_CLOSED: 'already_closed',// 末尾已收敛：测试通过 + 提交/验收 + 明确收口
  NOT_HUMAN: 'not_human',          // 子代理/自动化/空会话
})

// 返回：{ admitted: boolean, kind: 'work'|'chat', reasons: string[], confidence: 'high'|'low', signals: object }
// 约定：admitted===true 时 reasons 为空数组；admitted===false 时 reasons 至少一项。
export function judgeAdmission(input, options = {})
```

`input` 字段（全部可选，缺失即视为未知）：
`{ turns, segments, title, goal, statusSummary, nextStep, state, files, sessionIds, awaiting, trigger, sessionCount, turnCount, tailFeatures }`

## 2. `lib/next-step.js`（新增，纯函数，无 IO）

```js
// 从轮次里提取“最后一幕”的可判定特征。
export function extractTailFeatures(turns, options = {})
// → { lastTurn, hasError, errorHead, errorTurn, lastCommand, changedFiles,
//     awaitingHuman, awaitingSummary, awaitingTurn, goalSummary, closedSignals }

// 生成“具体、带对象、可执行”的下一步。**永不返回空串，永不返回「待补充」类空话。**
export function suggestNextStep(input, options = {})
// → { text, source: 'rule'|'model', kind: 'error'|'awaiting'|'files'|'resume', turn, evidenceHandle }
```

规则兜底优先级（ADR-0009）：
1. `awaiting`（末轮 AI 反问/等验证/等拍板）→ 「回复 AI 在第 N 轮的确认项：<末句摘要>」
2. `error`（末轮有失败报错）→ 「排查第 N 轮的 <命令或报错首行>」
3. `files`（末轮有文件改动）→ 「核对 <文件名> 的改动并运行测试」
4. `resume`（其余）→ 「回到第 N 轮继续：<该轮目标摘要>」

## 3. `lib/work-model.js`（扩展，字段由本契约定义）

`normalizeWork` 新增三个字段（缺失时给安全默认）：
```js
admission: { admitted: boolean, reasons: string[], kind: 'work'|'chat' }   // 默认 { admitted: true, reasons: [], kind: 'work' }
awaiting:  { active: boolean, summary: string, turn: number|null } | null   // 默认 null
nextStepKind: 'error'|'awaiting'|'files'|'resume'|''                    // 默认 ''
```

`toCardView` 新增透出字段：
`admitted, admissionReasons, awaitingActive, awaitingSummary, awaitingTurn, nextStepKind, nextStepSource`

`projectResumeCards` 新增：未准入（`admission.admitted === false`）的事**不进 `unresolved`**，改放 `excluded` 数组并附 `reasons`；返回体新增 `excluded`。

## 4. `lib/segment.js`（扩展）

```js
// 判断末轮是否停在“等人回复”：AI 反问、等验证、等拍板、ask_user_question 停住、轮次 open。
export function detectAwaitingHuman(turns, options = {})
// → { active: boolean, summary: string, turn: number|null, reason: 'question'|'verify'|'decision'|'open'|'' }
```

`sliceSessionSegments` 新增选项 `strategy`：
- `'boundary'`（默认，保持既有行为，兼容旧测试）
- `'mainline'`：以会话为主线，**只在明确话题切换或长间隔转折处**才切，禁止切出大量碎段（ADR-0007）。

## 5. `lib/work-merge.js`（改写冷启动聚合）

`planColdStartWorks(segments, options)` 改为**自顶向下**：先按会话主线聚合，再在必要时按转折拆分。
选项新增 `strategy: 'mainline' | 'boundary'`（默认 `'mainline'`）。
保留返回结构 `{ clusters, works, unresolvedWorks, settledWorks, chatTopics, ignoredSegments }`，
`cluster` 与 `work` 新增：`admission`、`awaiting`、`nextStepKind`。

## 6. `lib/work-store.js`（语义可靠性与可见性）

- **必须修**：冷启动 `callSemanticModel` 必须传 `sessionId`（当前 `lib/work-store.js:889` 漏传，适配器直接拒绝，且被 `catch` 静默吞掉）。
- 长输入**分批/精简**，避免会话多的工作区被超时截断。
- store 新增 `refineStatus`：
```js
refineStatus: { used: boolean, at: number|null, reason: ''|'ok'|'no_model'|'timeout'|'failed'|'invalid_json'|'running', attempts: number }
```
- `readWorkspaceWorksView` 返回值新增 `refineStatus`。
- **禁止静默吞错**：失败必须落到 `refineStatus.reason`。

## 7. `lib/index.js`

- `/works` 响应透出 `refineStatus`。
- 新增 `POST /work-refine-retry`：`{ workspaceId }` → 强制重跑语义提炼（`useModel: true`），返回同 `/works` 结构。

## 8. 客户端（`lib/client.js` + `lib/work-view.js`）

- 切区即清态：`workspaceId` 变化时立即清空上一个工作区的数据，禁止串台。
- 空态四态可区分：`unscanned` / `scanning` / `failed` / `empty`，各自不同文案。
- 顶部工作区切换器（复用 `/workspaces`），默认跟随当前会话工作区。
- 卡片显示「AI 正在等你：<摘要>」与下一步来源（模型提炼 / 规则兜底）。
- 提炼状态条：已深度提炼 / 仅基础规则 + 原因 + 一键重试。

## 9. Lead 裁决与接口补充（收口记录）

### 9.1 `detectAwaitingHuman` 的**唯一实现**在 `lib/segment.js`
`lib/segment.js` 是唯一权威实现（契约 §4）。`lib/next-step.js` **不得**保留第二份等价实现，
以免两处判据长期漂移；它应当 re-export 或委托给 `lib/segment.js`。
过渡期（`segment.js` 尚未交付时）允许 `next-step.js` 内有本地实现，**但收口时必须改为委托**。

### 9.2 `refineStatus` 与 `/work-refine-retry`（§6/§7 补充）
- `readWorkspaceWorksView` 与 `incrementalSyncSession` 的返回值都新增 `refineStatus`（纯追加，不改既有字段）。
- `POST /work-refine-retry` **必须显式给 `workspaceId`**，缺失/空白/非字符串 → 400，未知 id → 404。
  这与同族其它 works 端点「缺省退回首个工作区」的惯例**故意不同**：重试会真花模型调用，
  静默改打到别的工作区会让两边状态都变，风险不对等。
- 重试路径**不带 `asyncRefine`**：用户显式点按钮必须等出结果。
- 响应体复用 `/works` 的组装函数，保证两处字段永不漂移。

### 9.3 分批策略（§6 补充）
- 单批上限 40 簇 / 12000 字符，最多 8 批；超出上限的尾簇**并入最后一批，绝不丢弃**。
- 分批的簇 id 校验失败（重复/缺失）时**抛出**而不是静默降级：这是接线 bug，必须显形。

### 9.4 提炼失败不得静默
`lib/work-store.js` 中所有 `catch {}` 一律改为经 `reportRefineFailure` 上报并落
`refineStatus.reason`。ADR-0010 要求「失败在状态层诚实可见」，静默降级即违约。

### 9.5 已确认/锁定语义（§3 补充，防回归）
「人工确认」只由 `stateSource === 'confirmed'` 或 `lockedWorkIds` 判定。
**L0 规则推断出的非空值不算人工确认**，必须允许被语义提炼覆盖；
`decisions` 不参与批内投影覆盖。
