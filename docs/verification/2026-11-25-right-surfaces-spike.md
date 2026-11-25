# DSH 右侧两个面的可接管性调查（2026-11-25）

只读契约调查。除本文件外未改任何文件；未运行 `build-theme` / `build-viewport` / 测试；未提交。

- 调查对象：本机 DSH `0.2.1-rc.5`（`app.asar` 内包版本号一致）。
- 宿主代码：`D:\Program Files\dsh\resources\app.asar`（未压缩，可直接 `grep -a` / `tail -c +偏移`）。
- 参考实现：`C:\Users\Administrator\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\`（v0.28.2）。
- 既有验证：`docs/verification/2026-11-06-workspace-jump.md`（原生轮次导航“标签/虚拟轨道”已核实，但未记录选择器）。
- 结论限定：以下“已核实”指源码/类型声明/槽位目录层面已核实；**本次没有拿到运行时 DOM 快照**（原因见 §6）。

## 结论速览

| 面 | 问题 | 结论 | 一句话 |
|---|---|---|---|
| A | 右栏 tab 注册 | **可行（官方座位）** | `ctx.sidebarRightTabs.register(definition)` + `sidebar.right.pane.tab` 带键座位；两段式，正文/标题的 key 都是定义的 `id`。 |
| A | 打开 | **可行** | `ctx.sidebarRight.openTab(kind, options)`，**没有 sessionId 参数**；只作用于当前 mounted 的会话，列会展开。 |
| A | 设置默认选中 tab | **不可行（无公开 API）** | 没有 `defaultTab` / `setActive`；新列的默认页由 `defaultSeed()` 按 guide 条目数决定，标准 Web 装配/本机 profile 已有多个 guide 条目，因此默认是 guide。`openTab` 能做到“打开即选中”。 |
| A | 与系统 tab 共存 | **可行（加法式）** | 新 kind 不碰撞即可共存；系统 tab/正文/标题都不会被挤掉。只有同 kind 发生不兼容碰撞（`fallback`、同 band、或该 kind 已占两个 band）才会抛错。 |
| E | 接管原生轮次导航条 | **条件可行（DOM 级，非官方座位）** | 原生 nav 不是 slot；只能“CSS 隐藏 + 自绘轨 + 保留原生节点当锚点/降级”。没有稳定类名，`data-index` 是**序号不是轮号**。 |
| E | `turnOutline` 可达 | **可达（会话投影）** | 会话作用域 slot 内用 `useProjection("turnOutline")`；任意上下文用 `ctx.sessions.binding(id).session.projections.faceOf("turnOutline")`。加载集合另由 `useChat(s => s.navigation.items())` 提供。 |

---

## 0. 证据等级与来源

| 等级 | 含义 | 本次来源 |
|---|---|---|
| S | 宿主源码/类型声明 | `app.asar` 内包源码、`dsh-better-sidebar/src/*.ts` |
| C | 宿主槽位目录/包文档 | `app.asar` 内 `slots` 目录、包 README |
| R | 运行时实测 | **无**（client inspect 超时，见 §6） |
| I | 由上面三条推断 | 文中会标“推断” |

`cordis_inspect_list` 能列出 client 的 `Service` / `Slots` / `Builtin` provider，但本次 `cordis_inspect_query` 对这三个 provider 都在 10s 后超时（“Open or reconnect the Harness page, then retry”）。按任务要求省略 `input` 重试仍超时，说明这个 agent 会话没有连上可应答的页面。因此没有实时 Slot 树/服务签名，改用宿主包源码与打包在 `app.asar` 内的槽位目录。

---

## 1. 右栏 tab 的注册方法

### 1.1 两个服务面

宿主 `@deepseek-ai/dsh-client-ui-sidebar-right` 在客户端启动时提供两个 Cordis 服务：

```js
const disposeRegistry = ctx.reflect.provide("sidebarRightTabs", tabs)
const disposeService  = ctx.reflect.provide("sidebarRight", controller)
```

证据：`app.asar`，包 `@deepseek-ai/dsh-client-ui-sidebar-right`，`lib/types/client/index.js`（偏移约 `46937141`）。

- `ctx.sidebarRightTabs`：**静态类型注册表**，不是运行时导航接口。`register(definition)` 返回 disposer。
- `ctx.sidebarRight`：**导航/布局控制器**，`openTab` / `openResource` / `focus` / `close` / `active` / `isExpanded` / `mounted` / `openTabs` 等。

### 1.2 `ctx.sidebarRightTabs.register(definition)` 的定义对象

宿主 `lib/types/client/tab-registry.js` 的实现（偏移约 `46920990`）：

```js
register(definition) {
  const { id, kind } = definition
  const entries = definition.guide ?? []
  if (new Set(entries.map(entry => entry.id)).size !== entries.length)
    throw new Error(`sidebarRight: duplicate guide entry id in "${id}"`)
  const band = definition.priority ?? DEFAULT_BAND
  if (this.ids.has(id))
    throw new Error(`sidebarRight: tab type id "${id}" is already registered`)
  const held = this.kinds.get(kind)
  if (held !== void 0 && !coexists(held, band))
    throw new Error(`sidebarRight: tab kind "${kind}" is already registered (${held.inForce.band})`)
  ...
  const dispose = this.ctx.effect(() => { ... }, `sidebarRight.tabs.register(${JSON.stringify(id)})`)
  return () => { dispose() }
}
```

字段（S；`priority`/`multiple`/`keepMounted` 的语义同时由包 README 与实现确认）：

| 字段 | 必填 | 类型 | 语义 |
|---|---|---|---|
| `id` | 是 | `string` | 这个实现的全局唯一身份；**同时是正文/标题座位的 key**。重复即抛。自然值用包名，例如 `dsh-topic-map`。 |
| `kind` | 是 | `string` | tab 类型判别值，例如 `topic-map-history`。一个 kind 最多一个 `builtin` + 一个 `extension`；`fallback` 不能与任何 band 共存。 |
| `title` | 是 | `(address: string) => string` | tab chip 的文字，在 **open 时**捕获；之后改语言不会自动变。要动态标题就再注册 `sidebar.right.pane.tab.title`。 |
| `guide` | 否 | `Array<{ id, order, title, description?, icon?, commandId? }>` | 只影响 guide 页里的一张卡；不注册也能用 `openTab` 打开。 |
| `patterns` | 否 | `readonly string[]` | 资源型 tab 的地址 glob；页面型 tab（我们）不需要。 |
| `priority` | 否 | `'extension' \| 'builtin' \| 'fallback'` | 默认 `extension`。新 kind 填不填都不影响共存。 |
| `canOpen` | 否 | `(address: string) => boolean` | 资源型 tab 的否决器；页面型不需要。 |
| `multiple` | 否 | `boolean` | 同一 kind 可开多个独立实例（terminal/browser）。我们的历史栏是单实例，省略。 |
| `keepMounted` | 否 | `boolean` | 访问过的正文在隐藏/切 tab/切会话后仍挂载，保留滚动与内部状态。历史栏建议 `true`。 |

`guide` 条目字段（S；shipped `files`/`terminal`/`browser` 的定义都在用）：

```js
guide: [{
  id: 'workspace',                    // provider 内唯一
  order: 10,                          // 升序；决定卡片位置
  title: () => t('guide.title'),
  description: () => t('guide.description'),
  icon: GuideArtworkFiles,            // React 组件，不是字符串；省略则占位方块
  commandId: 'workspace.files',       // 可选：让卡片显示对应快捷键提示
}]
```

注意：`icon` 是 **guide 条目**的字段，不是 definition 顶层字段；definition 顶层没有 `icon`。

### 1.3 正文与标题座位

槽位目录（C，`app.asar` 偏移约 `50217347`）：

```text
key: "sidebar.right.pane.tab"
kind: "keyed"
scope: "session"
summary: "One tab's body, dispatched with the `id` of the type in force for `tab.kind`."
declaredBy: "an entry in 'rightbar.session' (client-ui-sidebar-right)"
occupants: [
  "client-ui-deliverables ReviewTab",
  "client-ui-plan PlanPreview",
  "client-ui-schedule ScheduleTaskTab",
  "client-ui-sidebar-browser BrowserBody",
  "client-ui-sidebar-documentpreview TextPreview",
  "client-ui-sidebar-files FilesBody",
  "client-ui-sidebar-right GuideBody",
  "client-ui-sidebar-terminal LazyTerminalBody",
  "client-ui-subagent SidebarChatTab",
  "experimental-session-inspector SessionInspectorView"
]
```

`sidebar.right.pane.tab.title` 同构，`dispatch key` 也是 definition 的 `id`。

最小注册形状（参考宿主内 shipped 的 `SessionInspector`——另一个包，偏移约 `80946298`；以及 `dsh-better-sidebar/src/client/native/index.ts:318`）：

```js
// 必须等 slot 被声明后再 register：这个 slot 声明在 rightbar.session 里，
// 不是根级 slot；直接 ctx.slots.register 可能在声明前落到未声明座位。
ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: DEFINITION_ID,          // 必须等于 tabs.register 的 id，不是 kind
  locale: NS,                  // 可选；有则组件内 t 可用
  // inject: (sessionId) => ({ ... })  // 可选，注入 owner 数据
}, HistoryTabBody))
```

正文组件会收到框架标准 props（C：该槽位 `standardProps` 列表）：

```text
useSessions / useSession / useSessionStatus / useSessionRetainInfo
useChat / useConversation / useInput / useProjection / useAccess
sessionId / useTrajectory / useRemoteAccess / useResource / ...
```

并且 `hookContext: TabHookContext`、`slotInject: SidebarRightTabInjected`，正文里可通过 `props.useTabInfo()` 读 `{ sidebar, panel, tab }`（`tab` 含 `id/kind/title/contentId/visible/navigation{address,params,revision}/signal/actions`）。`dsh-better-sidebar/src/client/native/tab-adapter.tsx` 的 `NativeTabInfo` 是同一形状的结构镜像。

### 1.4 `ctx.sidebarRight.openTab(...)` 的参数

实现（S，偏移约 `46839605`）：

```js
openTab(kind, options = {}) {
  const { sessionId, actions } = this.require()
  this.placeTab(sessionId, actions, kind, options)
}
```

**签名**：

```ts
ctx.sidebarRight.openTab(
  kind: string,
  options?: {
    params?: unknown                  // 到达正文 tab.navigation.params，JSON-shaped，运行时不校验
    revealIfOpened?: boolean          // 同一 (kind, contentId) 已开时是否聚焦；普通页面 tab 在目标 pane 内本就按唯一性去重
    preferNewPane?: boolean           // 先尝试把目标 dock pane 拆成两半，再退回原 pane
    replaceTab?: string               // 要顶掉的 tab id（不是 kind）；优先于 preferNewPane
    paneId?: string                   // 目标 pane id（paneN / floatN）；省略用活动 dock pane
  }
): void
```

- 返回 `void`；失败抛错，不返回 `false`。
- `require()` 在没有“当前屏幕上的会话”（全局面板、无选中会话、store 尚未 mint）时抛
  `sidebarRight: no session surface is mounted`。
- **没有 `sessionId` 参数**。`openTab` 只作用于 `sidebarRight.mounted.getSnapshot()` 指向的会话。
- 具体控制器上有 `openTabIn(sessionId, kind, options)`，但它**不属于 `ISidebarRight`**，且对 “runtime 未 adopt 的会话” 是**静默 no-op**（不报错、不返回结果）。跨会话打开不要依赖它；先切会话，再 `openTab`。
- 文档明确：打开会**展开右列**；新 tab 落在目标 pane 并成为该 pane 的活动 tab（“活动 tab”这一点未单独实测，见 §6）。
- 普通页面 tab 会按 pane 内唯一性去重；重复 `openTab` 是“聚焦已有”。

`ctx.sidebarRight` 其余与本调查相关的方法（S）：

```ts
openResource(address: string, options?: { kind?: string; params?; revealIfOpened?; preferNewPane?; replaceTab?; paneId? }): void
close(tabId: string): void
active(): TabRecord | undefined
isExpanded(): boolean
toggleExpanded(): void
focus(tabId: string): void
mounted: ObservableSnapshot<string | undefined>
openTabs: ObservableSnapshot<Array<{ sessionId; tabId; kind; contentId }>>
```

`openTabs` 的元数据形状来自 `SidebarTabInventory`（S，偏移约 `46835142`）：`{ sessionId, tabId, kind, contentId }`，只读、跨 saved/adopted 会话；未 adopt 前可能为空。

### 1.5 能否设置默认选中的 tab

**不能通过公开 API 设置。** 已核实：

1. `SidebarRightTabRegistry` 没有 `defaultTab` / `setActive` 字段或方法。
2. `SidebarRightController` 没有“设置默认 tab”的方法；只有 `openTab` / `focus` 等一次性动作。
3. 新会话/新展开的默认页由 `defaultSeed(tabs)` 计算（S，`contract/seed.js`）：

```js
function defaultSeed(tabs) {
  const [only, ...others] = tabs.guide()
  const kind = only !== void 0 && others.length === 0 ? only.kind : GUIDE_KIND
  const definition = tabs.get(kind)
  if (definition === void 0) throw new Error(`sidebarRight: default tab kind "${kind}" is not registered`)
  return { kind, title: definition.title(pageAddress(kind)) }
}
```

规则（包文档原文）：

> Default pages depend on the number of registered guide entries, not the number of tab types or open tabs.
> Exactly one entry opens its page directly; zero or multiple entries open the guide.

宿主的 shipped guide 条目至少有 `files`（order 10）、`terminal`（order 20）、`browser`（order 30）；本机 profile 还装了 `dsh-better-sidebar`，它会把多个描述符也注册成 guide 条目。只要 guide 条目 ≥ 2 条，**默认页就是 `guide`**；只有装配里恰好只有 1 条 guide 条目时，那个条目对应的页面才会成为默认。我们再加一条 guide 只会让条目更多，不会让我们的 tab 变成默认。反过来，如果某个极简装配原本 **0 条** guide 条目，我们加上 1 条后反而会让我们的页面成为默认——这是 `defaultSeed` 的边界，标准 Web 装配不适用。

可做到的替代（按推荐顺序）：

1. **打开即选中**：用户按 `Ctrl+K` 或点 guide 卡片时调用 `openTab(kind)`；`openTab` 会展开并选中。这是正常入口，不需要“默认”语义。
2. **首次打开后记住**：在 `sessionStorage` 记“本会话已引导过”，之后不再自动打开；避免每次切会话都抢焦点。
3. **顶掉 guide（不推荐，且不是默认设置）**：用 `openTabs` 找到当前会话的 guide tab，`openTab(kind, { replaceTab: guide.tabId })`。这会移走 guide，用户失去“工具入口页”，只在明确的产品决策下使用。
4. **写 `localStorage['dsh.sidebar-right.v1.<sessionId>']` 预置布局**：这是**私有持久化格式**（`SidebarTabInventory` / `persistence.js` 读取并校验），带 schema/版本，和宿主 store 会互相覆盖。**不要用**；未列入可行路径。

### 1.6 与系统 tab 共存

**可行，加法式；注册新 kind 不会挤掉文件/文档/指引 tab。** 证据：

- 槽位是 `keyed`，按 definition `id` 分发；系统占用的 key 是各自的包 id（见上面槽位目录的 10 个 `occupants`）。我们用自己的 id 就是新增一个 cell，不替换任何已有 cell。
- 注册表的碰撞规则只针对 **同 kind**：

```js
function coexists(slot, band) {
  return band !== "fallback"
    && slot.inForce.band !== "fallback"
    && slot.inForce.band !== band
    && slot.shadowed === void 0
}
```

  - 新 kind：`held === undefined`，直接进；与任何系统 tab 无关。
  - 同 kind 但不同 band（`extension` + `builtin`）：允许，extension 暂时压过 builtin；builtin 在我们的 registration dispose 后恢复。
  - 同 kind 同 band、或任一方是 `fallback`：抛错。这是“不要占用 `files`/`guide` 等系统 kind”的硬约束。
- `id` 全局唯一；取 `dsh-topic-map` / `dsh-topic-map:history` 这类命名空间值即可。

需要知道的副作用（不是“挤掉”，但会改变 guide 页）：

- 我们的 `guide` 条目会多一张卡，位置由 `order` 决定。
- guide 页在**条目 > 4** 时不再显示 `description`（包文档）。宿主已有多条，再加一条通常只是多一张卡；如果当前装配正好在 4 条边界，会触发“描述全部隐藏”的视觉变化。
- 若不想动 guide：**不注册 `guide`**，只保留可通过 `openTab` / 快捷键打开的 tab。代价是用户没有发现入口。

---

## 2. 原生轮次导航条的 DOM 特征

### 2.1 组件与 DOM 层级

源码：`@deepseek-ai/dsh-client-ui-chat` 的 `TurnNavigator`（`app.asar` 偏移约 `23688100`）。JSX 结构（S）：

```jsx
<div className={slot}>                          {/* .SNx2jG_slot，height:0 */}
  <nav className={frame} aria-label={t("chat.turnNavigation.label")}>
    <div ref={scrollerRef} className={fadeClasses.join(" ")}>   {/* .SNx2jG_scroller */}
      <div ref={virtualizer.containerRef} className={marks}>    {/* .SNx2jG_marks */}
        {virtualItems.map(({ index, key }) => (
          <TurnMark key={key} index={index} item={items[index]} ... />
        ))}
      </div>
    </div>
    {preview && <div role="tooltip" className={preview} ... />}  {/* hover/focus 预览，scroller 的兄弟 */}
  </nav>
</div>
```

`TurnMark` 的按钮（S）：

```jsx
<button
  ref={registerElement}
  data-index={index}
  type="button"
  className={classes.join(" ")}
  aria-label={t(item.anchor.kind === "loaded" ? "chat.turnNavigation.jump" : "chat.turnNavigation.jumpLoad", { turn: item.turn })}
  aria-current={active ? "true" : undefined}
  aria-busy={busy ? "true" : undefined}
  aria-describedby={previewId}
  onClick={() => onNavigate(item)}
/>
```

实际 DOM（推断自 JSX，等级 I；与源码一致）：

```text
div[data-conversation-content][data-conversation-session][data-conversation-region="chat"]
└─ div[data-conversation-scroll]                         ← 外层会话滚动体（稳定内部标记）
   ├─ … conversation.view → ChatView
   │  └─ div.V4vHZW_frame                                ← ChatView 的 frame（类名是 hash）
   │     ├─ div.SNx2jG_slot                              ← height:0；在 [data-conversation-scroll] 下改 sticky
   │     │  └─ nav.SNx2jG_frame[aria-label="轮次导航"]    ← 原生导航容器
   │     │     ├─ div.SNx2jG_scroller                    ← 轨道自己的滚动容器
   │     │     │  └─ div.SNx2jG_marks
   │     │     │     └─ button.SNx2jG_mark[data-index]
   │     │     └─ div[role="tooltip"]                    ← 悬停/聚焦预览
   │     └─ div.V4vHZW_root
   │        └─ div.V4vHZW_scroll
   │           └─ div.V4vHZW_column[data-chat-flow]
   │              └─ [data-chat-turn] / [data-chat-anchor-key]  ← 每轮内容行
   └─ div[data-composer-seat]
```

`[data-conversation-scroll]` 的证据：`@deepseek-ai/dsh-client-ui-conversation` 的 `ConversationRoot`（`app.asar` 偏移约 `25136408`）：

```jsx
<div
  className={scrollBody}
  data-conversation-scroll=""
>
  {sessionId === undefined ? null : <Views />}
  {composerSeat}
</div>
```

`[data-chat-turn]` / `[data-chat-anchor-key]` 的证据：`@deepseek-ai/dsh-client-ui-chat` 的 flow item（偏移约 `23861000`）：

```jsx
<div
  data-chat-anchor-key={flowKey}
  data-chat-flow-key={flowKey}
  data-chat-node-key={routedNode.key}
  data-chat-turn={turn}
  ...
/>
```

### 2.2 选择器

可用的选择器（按稳定性排序）：

```js
// 容器：会话滚动体内的、内部含 data-index 按钮的 nav
const nav = document.querySelector('[data-conversation-scroll] nav:has(button[data-index])')

// 更保守的 find + 自检（避免 :has 兼容性与误匹配）
const scope = document.querySelector('[data-conversation-scroll]')
const nav = [...scope.querySelectorAll('nav')]
  .find(n => n.querySelector('button[data-index]') !== null)

// 轨道自己的滚动容器：nav 的第一个元素子节点
const scroller = nav.firstElementChild

// 所有当前已渲染的刻度（虚拟化后只有可视范围）
const marks = nav.querySelectorAll('button[data-index]')

// 活动轮
const active = nav.querySelector('button[aria-current="true"]')
```

**没有稳定的容器类名或 `data-*` 属性。** `.SNx2jG_*` 是 CSS Modules 的构建 hash，会随构建/版本变化；`aria-label` 来自 locale（中文 `轮次导航`，英文 `Turn navigation`）；`data-index` 是唯一明确的稳定数据属性，但语义是**序号**。

### 2.3 `data-index` 到底是几

`virtualItems.map(({ index }) => <TurnMark index={index} item={items[index]} />)`，`virtualItems` 来自 `useVirtualizer({ count: items.length, ... })`；`items` 是 `mergeTurnRailItems(loaded, outline)` 的结果，按 `turn` 升序。

所以：

- `data-index` = **合并列表中的 0-based 位置**，不是 `turn` 号，也不是 `seq`。
- `turn` 号在 `aria-label` 里（`跳转到第 {turn} 轮` / `加载并跳转到第 {turn} 轮`），或者用 `data-index` 反查我们自己的、同样升序的 `turnOutline` 数组。
- 开启 `turnOutline` 时，列表包含**整段历史的所有已开始轮次**（包含未加载的）；没有投影时只含已加载轮次。两种情况下顺序都是升序，索引语义一致，但**集合大小不同**。用索引反查时，必须使用与原生同源的合并列表，不能用“过滤后的可见列表”。

### 2.4 滚动容器

轨道的滚动容器是 `nav` 的第一个 `div`（`.SNx2jG_scroller`），不是外层 `[data-conversation-scroll]`。它的 CSS（S）：

```css
.SNx2jG_frame {
  --turn-rail-band: calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px));
  width: 28px;
  max-height: min(max(0px, calc(var(--turn-rail-band) - 64px)), 420px);
  position: absolute;
  right: 12px;
  top: calc(var(--turn-rail-band) / 2);
  transform: translateY(-50%);
}
.SNx2jG_scroller {
  max-height: inherit;
  overscroll-behavior: contain;
  scrollbar-width: none;
  position: relative;
  overflow-y: auto;
}
.SNx2jG_mark {
  height: 10px;
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
}
```

- 刻度固定间距 `TURN_SPACING_PX = 10`，`RAIL_INSET_PX = 6`。
- 内部溢出时在 `.SNx2jG_scroller` 里滚动；顶部/底部有 24px 渐变遮罩（`fadeTop` / `fadeBottom`）。
- 刻度是虚拟化的：**只有当前可视范围附近的 `button[data-index]` 在 DOM 里**。
- 窄容器（`@container (width <= 900px)`）直接 `display:none`，此时原生轨不存在。
- 少于 2 轮（`items.length < 2`）时 `TurnNavigator` 返回 `null`，原生轨也不存在。

### 2.5 运行时跳转建议

原生的 `onClick` 就是 `scroll.navigateToTurn(item)`：已加载轮直接对齐；未加载轮先用 `turnOutline` 的 `seq` 翻历史再落点。**最保真的跳转是复用原生按钮的 click**：

```js
async function clickNativeTurn(rail, index) {
  const find = () => rail.nav.querySelector(`button[data-index="${index}"]`)
  let button = find()
  if (!button) {
    // 虚拟化未渲染：把轨道自己的 scroller 滚到目标附近，等两帧再点
    rail.scroller.scrollTop = Math.max(0, index * 10 - rail.scroller.clientHeight / 2)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    button = find()
  }
  if (!button) return false
  button.click()
  return true
}
```

备选（不依赖原生按钮）：用公开的 `ISession.loadThrough(seq)` + 内容行 `[data-chat-turn="N"]`：

```js
async function jumpBySeq(ctx, sessionId, turn) {
  const binding = ctx.sessions.binding(sessionId)
  const session = binding?.session
  if (!session) return false
  const outline = session.projections.faceOf('turnOutline').getSnapshot()
  const entry = Array.isArray(outline) ? outline.find(row => row.turn === turn) : undefined
  if (entry) await session.loadThrough(entry.seq)
  await new Promise(resolve => requestAnimationFrame(resolve))
  const row = document.querySelector(`[data-chat-turn="${turn}"]`)
  if (!row) return false
  row.scrollIntoView({ block: 'start' })
  return true
}
```

`ISession.loadThrough(seq)` 是公开契约（S，类型声明偏移约 `49988672`），会向历史更早的方向翻页直到窗口覆盖 `seq`；失败/无更多历史时返回 resolved promise。

---

## 3. `turnOutline` 是否可达

### 3.1 它是什么

宿主插件 `@deepseek-ai/dsh-session-turn-outline`（`app.asar` 偏移约 `93731813`）注册一个 **session projection**：

- key：`turnOutline`
- state version：`2`
- 客户端 wire view：`state.turns`（`draft` 不下发）

wire 元素（S）：

```ts
{
  turn: number       // 1-based 轮号（`lastTurn` 初始 0，宿主 `turn = phase.turn + 1`；`data-index` 才是 0-based 位置）
  seq: number        // 该轮 turn/start 的事件 seq；跳转时 loadThrough 的目标
  prompt: string     // ≤ 50 字符
  response: string   // ≤ 120 字符
}
```

数组按 `turn` 严格递增；包含**整段会话日志里所有已开始的轮次**，不只当前客户端已加载的窗口。未结束轮次的 `response` 可能为空；`prompt` 是首个 user 消息的截断预览。

### 3.2 三条访问路径

| 上下文 | 写法 | 返回值 | 证据 |
|---|---|---|---|
| 会话作用域 slot 正文 | `props.useProjection('turnOutline')` | `TurnOutlineEntry[] \| undefined` | `@deepseek-ai/dsh-client-ui-chat` 的 `ChatView`：`const turnOutline = useProjection("turnOutline")` |
| 任意拿到 `ctx.sessions` 的地方 | `ctx.sessions.binding(sessionId)?.session.projections.faceOf('turnOutline')` | `ObservableSnapshot<unknown>` | `ISession.projections: ProjectionsFace`，`faceOf(key): ObservableSnapshot<unknown>` |
| 需要订阅 | `face.subscribe(fn)` + `face.getSnapshot()` | 同上 | `ProjectionValueStore.faceOf` |

`ctx.sessions.binding(sessionId)` 只对**已 retain 的 generation** 返回 binding；对后台/未打开会话可能是 `undefined`。需要读后台会话时先 `ctx.sessions.retain(sessionId, { source: ... })`（返回的 `SessionReference.binding`），读完 `release()`。不要假设列表里的每个 id 都有 binding。

宿主 chat 的消费代码（S，偏移约 `23822181`）：

```js
const turnNavigationItems = useChat(s => s.navigation.items())
const turnOutline = useProjection("turnOutline")
const railItems = useMemo(
  () => mergeTurnRailItems(turnNavigationItems, turnOutline),
  [turnNavigationItems, turnOutline],
)
```

其中 `turnNavigationItems` 是**已加载轮次**，形状是 `{ turn, prompt, response, anchorKey }`（`turn-rail-items.js` / `use-chat-navigation.js`）。`mergeTurnRailItems` 以 `turn` 为键合并：两边都有的轮次保留 loaded anchor，摘要只在 loaded 为空时用 outline 补。

### 3.3 “已加载轮次 + 摘要”到底有没有现成快照

- **全量轮次 + 摘要**：有，`turnOutline`（所有已开始轮次，摘要为截断预览）。
- **已加载轮次的摘要**：有，但只在会话作用域 slot 内通过 `useChat(s => s.navigation.items())` 拿；它不是 `ctx` 上的独立服务，也没有跨 slot 的公开快照。
- **“当前活动轮次”**：**没有公开数据**。ChatView 的 `scroll.activeTurn` 是 `useChatScroll` 内部状态，不在 `useChat` 快照里。替代：读原生导航的 `button[aria-current="true"]`，用它的 `data-index` 到同源升序列表里反查 `turn`；或自己根据 `[data-chat-turn]` 行与滚动位置计算。
- **非当前会话**：`turnOutline` 可通过 `ctx.sessions.retain(id)` + `binding.session.projections` 读；但 retain 会打开历史/占用引用，跨会话列表不要为每一行都 retain。

结论：**E 的“已加载 + 摘要”在会话作用域内可达；跨上下文需要 retain 或自己折叠 `binding.eventSource`。** 如果只是要“所有轮次 + L0 预览”，`turnOutline` 已足够，甚至比设计要求的“只列已加载”更全；是否过滤到已加载由我们决定。

---

## 4. 可直接照抄的最小骨架

以下按本仓库的 `window.__ModuleLoader__.load` + 普通 JS + React 风格写；不是要现在落地，只是把契约钉死。

### 4.1 客户端包声明

`package.json` 的 `dsh.client.inject` 需要加上右栏客户端包（当前只有 locale / conversation）：

```json
"dsh": {
  "client": {
    "inject": [
      "@deepseek-ai/dsh-client-locale",
      "@deepseek-ai/dsh-client-ui-conversation",
      "@deepseek-ai/dsh-client-ui-sidebar-right"
    ],
    "platform": "web"
  }
}
```

Cordis 服务名则在 `lib/client.js` 的 `inject` 数组里声明：

```js
var inject = ['slots', 'sessions', 'locale', 'uiConversation', 'sidebarRightTabs', 'sidebarRight']
```

### 4.2 注册 tab（定义 + 正文 + 标题）

```js
var React = require('react')
var h = React.createElement

var HISTORY_ID = 'dsh-topic-map:history'       // 全局唯一；正文/标题 key 都用它
var HISTORY_KIND = 'topic-map-history'          // 新 kind，不碰 files/guide 等系统 kind

function HistoryTabBody(props) {
  var sessionId = props.sessionId
  var outline = props.useProjection('turnOutline') || []
  // 跨会话检索结果由本插件 Host 半提供；这里只示范会话内投影读取。
  return h('div', { className: 'dsh_tm_history' },
    outline.length === 0
      ? h('div', { className: 'dsh_tm_history_empty' }, '暂无轮次')
      : outline.map(function (row) {
          return h('button', {
            key: row.turn,
            type: 'button',
            onClick: function () { /* 跳转：见 §2.5 */ },
          }, '第 ' + row.turn + ' 轮 · ' + (row.prompt || row.response || ''))
        })
  )
}

function registerHistoryTab(ctx, t) {
  // 定义：静态声明；register 自身已是 ctx.effect 作用域，外层 effect 负责插件卸载时释放。
  ctx.effect(function () {
    return ctx.sidebarRightTabs.register({
      id: HISTORY_ID,
      kind: HISTORY_KIND,
      keepMounted: true,
      title: function () { return t('history.title') },
      guide: [{
        id: 'history',
        order: 15,                         // files 10 / terminal 20 之间
        title: function () { return t('history.title') },
        description: function () { return t('history.guide') },
        // icon 省略 → guide 显示占位方块；要图标就传 React 组件
      }],
    })
  }, 'dsh-topic-map: history tab type')

  // 正文：等 keyed slot 被 rightbar.session 声明后再注册；key 必须是定义 id。
  ctx.slots.inject('sidebar.right.pane.tab', function () {
    return ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: HISTORY_ID,
      locale: 'topic-map',
    }, HistoryTabBody)
  })

  // 标题（可选）：不注册则用 open 时捕获的 title() 文本。
  // ctx.slots.inject('sidebar.right.pane.tab.title', ...)
}
```

要点：

- `ctx.sidebarRightTabs` 要么写进插件 `inject` 数组（像 shipped inspector 那样），要么用 `ctx.inject(['sidebarRightTabs'], ...)` 等它出现（像 better-sidebar 那样）；否则 `ctx.effect` 里可能直接 `undefined.register`。
- `ctx.slots.inject` 而不是直接 `ctx.slots.register`：slot 声明在 `rightbar.session` 内部，晚于根插件启动。
- 正文 key = 定义 `id`，不是 `kind`。写错的表现是“tab 打开后正文空白 / 显示 nothing can view this”。

### 4.3 打开 tab

```js
function openHistoryTab(ctx, params) {
  var right = ctx.sidebarRight
  if (!right) return false

  // 没有屏幕上的会话时 openTab 会抛；先查 mounted，避免把异常抛到快捷键处理里。
  if (!right.mounted || right.mounted.getSnapshot() === undefined) return false

  try {
    right.openTab(HISTORY_KIND, {
      params: params || {},        // 到达正文 tab.navigation.params
      revealIfOpened: true,        // 已开则聚焦
    })
    return true
  } catch (error) {
    console.warn('[dsh-topic-map] open history tab failed:', error)
    return false
  }
}
```

跨会话场景：`openTab` 没有 session 参数，**先切到目标会话**，再调用。不要用内部的 `openTabIn` 赌它成功；它对未 adopt 的会话是静默 no-op。

### 4.4 定位原生导航容器（自检 + 隐藏 + 点击）

```js
function findNativeTurnRail(doc) {
  doc = doc || document
  var scope = doc.querySelector('[data-conversation-scroll]')
  if (!scope) return null

  var navList = scope.querySelectorAll('nav')
  var nav = null
  for (var i = 0; i < navList.length; i += 1) {
    if (navList[i].querySelector('button[data-index]') !== null) { nav = navList[i]; break }
  }
  if (!nav) return null

  var scroller = nav.firstElementChild
  if (!scroller) return null
  var overflow = getComputedStyle(scroller).overflowY
  if (overflow !== 'auto' && overflow !== 'scroll') return null

  return {
    nav: nav,
    scroller: scroller,          // 轨道自己的滚动容器（不是 [data-conversation-scroll]）
    marks: scroller.firstElementChild,
    buttons: nav.querySelectorAll('button[data-index]'),
    active: nav.querySelector('button[aria-current="true"]'),
    label: nav.getAttribute('aria-label') || '',
  }
}

function takeoverNativeRail(rail) {
  // 保留节点：visibility 仍保留布局与几何，是降级/锚点通道。
  rail.nav.setAttribute('data-dsh-tm-native-rail', '')
  // 注入一次 CSS：
  // [data-dsh-tm-native-rail]{visibility:hidden!important;pointer-events:none!important}
}

function restoreNativeRail(rail) {
  rail.nav.removeAttribute('data-dsh-tm-native-rail')
}
```

自检条件（不满足就**不要隐藏**，直接用原生并记一条诊断）：

1. `[data-conversation-scroll]` 存在；
2. `nav` 含 `button[data-index]`；
3. `nav.firstElementChild` 的 `overflow-y` 是 `auto/scroll`；
4. `button[data-index]` 至少 2 个（或当前 `items.length >= 2`；少于 2 轮原生本就不渲染）；
5. 容器宽度 > 900px（否则原生 CSS 已 `display:none`，无可接管对象）。

---

## 5. 风险与降级

### A 历史右栏

| 风险 | 表现 | 降级 |
|---|---|---|
| `sidebarRightTabs` 未注入 / 版本漂移 | `register` 抛错，guide 里没有卡 | 用 `shell.overlay` 自绘右侧抽屉（设计已列），交互不变，只是不挤开中间 |
| 正文 key 写成 kind / 注册早于 slot 声明 | tab 打开但正文空白，或 “nothing can view this” | key 固定为 `id`；用 `ctx.slots.inject`；启动时打一条 diagnostic |
| `openTab` 在无 mounted 会话时抛 | 快捷键无反应/控制台红字 | 先查 `mounted.getSnapshot()`；失败给出可见提示 |
| 跨会话打开 | `openTab` 只作用于当前会话 | 先切会话；不要依赖 `openTabIn` 的静默 no-op |
| 想“默认选中” | 标准装配下新列默认是 guide | 用 `openTab` 做显式入口（`Ctrl+K` / guide 卡）；不要写私有 localStorage |
| guide 条目过多 | >4 条时所有描述隐藏 | 只加一条、`order` 靠前；或干脆不加 guide，只留快捷键入口 |
| 多实例/多窗 | `openTabs` 是跨 saved/adopted 的元数据，未 adopt 可能为空 | 打开前以 `mounted` 为准；替换 guide 前先确认 `tabId` 存在 |

### E 历史轨

| 风险 | 表现 | 降级 |
|---|---|---|
| 容器选择器失效（类名 hash/结构变化） | 找不到 nav | 自检失败 → 不隐藏、不挂载，原生照用，记诊断 |
| `data-index` 当轮号用 | 跳错轮 | 只用它做位置；轮号从 `aria-label` 数字或同源 `turnOutline` 反查 |
| 虚拟化只渲染部分按钮 | 直接 `querySelector` 找不到目标 | 先滚 `.scroller` 到 `index*10`，等两帧再点；或走 `loadThrough(seq)` |
| `turnOutline` 未挂载 | 只有已加载轮 | `useChat(s.navigation.items())` 或折叠 `binding.eventSource`；只显示已加载、不显示“不可跳”的刻度 |
| 活动轮无公开快照 | 自绘轨无法高亮当前轮 | 读原生 `button[aria-current="true"]` 的 `data-index` 反查；或自己按 `[data-chat-turn]` + 滚动位置算 |
| 隐藏原生后键盘/焦点异常 | 用户无法 Tab 到原生 | 隐藏用 `visibility:hidden`（保留布局），自绘轨自己实现键盘与焦点环；设置页保留“恢复原生”开关 |
| portal/绝对定位漂移 | 窗口缩放/侧栏宽度变化后错位 | 用 `ResizeObserver` + `[data-sidebar-right-session]` / `[data-conversation-scroll]` 的 rect 重新锚定；窄屏放弃接管 |
| 侧栏抢占滚动/手势 | 对话区滚动被劫持 | 轨道自己 `overscroll-behavior: contain`；不要监听外层滚动做 preventDefault |

E 的最坏结果按设计口径应始终是“回到原生”，而不是白屏：**先自检，再隐藏；任何一步失败就撤掉隐藏属性与自绘 UI**。

---

## 6. 仍未确认

1. **没有实时 DOM 快照**：`cordis_inspect_query` 的 client `Service` / `Slots` / `Builtin` 均 10s 超时（页面未连接）。所有 DOM 结论来自 `app.asar` 源码 + JSX 推断，等级 S/I，不是 R。
2. **没有真实注册回执**：未在运行中的 DSH 里实际 `register` 一个空 tab、`openTab` 打开并截图。P0-6 仍需在真实宿主走一遍。
3. **`turnOutline` 在本机装配中的实际值**：包在 `app.asar` 与 `ui-chat` 依赖中存在，但未读到本机某个会话的 `face.getSnapshot()`。若装配未挂载 `@deepseek-ai/dsh-session-turn-outline`，应为 `undefined`（源码保证），但未运行时验证。
4. **`sidebar.right.pane.tab` 正文的 `useChat` / `useProjection` 实际绑定**：槽位目录写明有这两个标准 prop，未在真实 tab 正文里打印验证。
5. **`openTab` 的聚焦细节**：文档说“打开并展开”，未实测新 tab 是否立即获得 DOM 焦点（`active()` 读活动 tab 可验证）。
6. **guide 条目数边界**：本机装配是否已 ≥4 条（决定加卡是否触发描述隐藏）未实时读取 `tabs.guide()`。
7. **`data-index` 与 `turnOutline` 的集合一致性**：源码上两者都按 `turn` 升序合并；但没有运行时对比 50+ 轮会话的按钮数与 outline 长度。若某轮既无 loaded anchor 又不在 outline，索引会偏移（理论上不会）。
8. **`visibility:hidden` 下原生按钮的 programmatic click**：标准 DOM 行为应可用，未在本机 Electron 实测。
9. **窄屏/少于 2 轮时原生轨不存在**：源码明确返回 `null` / `display:none`；此时自绘轨的入口与降级尚未设计。
10. **`@deepseek-ai/dsh-client-ui-sidebar-right` 加入本仓库 `dsh.client.inject` 后的构建/加载顺序**：未改 `package.json`，只做了契约调查。
11. **新版 DSH 是否新增默认 tab API**：本报告只覆盖 `0.2.1-rc.5`；`defaultTab` 在本版不存在，不排除后续版本新增。
12. **`ctx.sessions.binding()` 对后台会话的可达性/retain 成本**：类型与实现已核实；实际 retain 一个历史会话的 I/O 与引用计数代价未测。

---

## 7. 对现有 openspec 的更正

`openspec/changes/history-index/{design,ui,spec}.md` 里有几处需要改，否则 P0-6 会按错误签名实现：

1. **错误**：`ctx.sidebarRight.openTab(sessionId, tabId)`
   **正确**：`ctx.sidebarRight.openTab(kind, options?)`；没有 session 参数，只作用于 `mounted`；跨会话先切会话。`options` 见 §1.4。
2. **不完整**：`ctx.slots.register('sidebar.right.pane.tab', { key: tabId, ... })`
   **正确**：slot 是 `rightbar.session` 内声明的 keyed slot，插件侧应先 `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(...))`；`key` = 定义 `id`；还要先 `ctx.sidebarRightTabs.register({ id, kind, title, guide? })`。
3. **需补**：`icon` 属于 `guide` 条目，不属于 definition 顶层。
4. **需补**：默认选中不可设；新列默认页由 `defaultSeed()` 按 guide 条目数决定；`openTab` 是显式入口。
5. **需补**：E 的 `data-index` 是序号不是轮号；原生轨道有独立滚动容器；没有稳定类名，必须先自检后隐藏。

`docs/verification/2026-11-06-workspace-jump.md` 的“原生轮次导航标签/虚拟轨道均已核实”仍然成立，但本文补上了选择器、层级与虚拟化语义。

---

## 8. 复现命令

```bash
# 1) 右栏注册表实现（definition 字段、碰撞规则）
tail -c +46920990 "/d/Program Files/dsh/resources/app.asar" | head -c 45000

# 2) 右栏控制器实现（openTab / active / isExpanded / mounted / openTabs）
tail -c +46839605 "/d/Program Files/dsh/resources/app.asar" | head -c 220000

# 3) 默认页规则
grep -a -b "function defaultSeed" "/d/Program Files/dsh/resources/app.asar"

# 4) 槽位目录：sidebar.right.pane.tab（keyed/session/10 个占用者）
tail -c +50217347 "/d/Program Files/dsh/resources/app.asar" | head -c 3500

# 5) 原生 TurnNavigator（JSX + CSS）
tail -c +23688100 "/d/Program Files/dsh/resources/app.asar" | head -c 18000

# 6) ChatView 的 turnOutline/useChat 消费
tail -c +23822181 "/d/Program Files/dsh/resources/app.asar" | head -c 5000

# 7) turnOutline 投影定义与 wire view
tail -c +93731813 "/d/Program Files/dsh/resources/app.asar" | head -c 12000

# 8) 参考实现
sed -n '86,110p;280,340p' \
  ~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/src/client/native/index.ts
sed -n '40,65p;240,275p' \
  ~/.dsh/profiles/desktop/node_modules/dsh-better-sidebar/src/client/native/surface.ts
```

---

## 9. 一句话交付

A 走官方两段式座位，**注册/打开/共存都可行，默认选中不可设**；E **没有官方座位**，只能基于 `[data-conversation-scroll] nav:has(button[data-index])` 做 DOM 级接管，**`data-index` 是序号不是轮号**，自检失败就回原生；`turnOutline` **可达**（会话投影 `faceOf` / slot 内 `useProjection`），已加载集合用 `useChat(s.navigation.items())`，活动轮需要读原生 `aria-current` 或自己算。
