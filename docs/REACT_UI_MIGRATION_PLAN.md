# React Web Adapter 改造与实施方案

更新时间：2026-07-21

状态：方向已确定，尚未开始实施

本文确定下一阶段的具体改造方向。它不是“把现有页面翻译成 React”，而是先稳定浏览器应用内核，再让 React 成为可替换的 Web Adapter。当前运行事实仍以 [ARCHITECTURE.md](./ARCHITECTURE.md) 为准；本文中的目标目录、接口和阶段表示未来实施约束，不代表仓库已经具备这些文件。

## 1. 最终决策

项目正式采用以下架构定位：

> **以 Pi JSONL 和版本化协议为稳定内核，以独立 Pi RPC 子进程为运行边界，以模块化单体和垂直功能切片组织能力，以 React 作为可替换 Web Adapter 的 Agent Workspace。**

对应原则：

```text
JSONL              负责长期事实
Contract           负责跨边界语义
SessionProjection  负责历史分支恢复
Browser Runtime    负责实时事件与命令
Store              负责浏览器投影
Feature            负责垂直能力
React              负责交互和展示
MapLibre           负责地图 Runtime
```

这轮确定以下决策：

1. 保留现有 Node Server、Pi RPC 子进程、Extension、SessionProjection 和版本化协议，不借 React 迁移重写后端。
2. 先建立 Browser Application Kernel，再迁移 React UI；React 组件不直接处理原始 Pi event、JSONL 或 WebSocket。
3. 不建立一个包揽全部状态的巨大 Store；按职责和更新频率拆分 Store，并通过 selector 暴露稳定读取接口。
4. Feature 拆成不依赖 React 的 Domain Module 和只注册界面的 UI Module。
5. Vite 的源码与产物和现有 `public/` 分离；迁移期间 legacy 与 React 使用独立 HTML/DOM 根节点，不共同拥有同一 DOM subtree。
6. MapLibre Runtime 保留为命令式 Adapter，不改写成 React layer。
7. 单仓库、单 npm 包不变；共享协议进入 `src/contracts/`，暂不建立 workspace 或独立包。
8. React 切换前必须先具备事件回放、关键浏览器路径和性能基线。

## 2. 为什么迁移，以及迁移什么

### 2.1 当前项目不是普通聊天页面

项目已经同时承担三类平台能力和若干垂直 Feature：

```text
Pi Traffic Workspace
├─ Agent Platform
│  ├─ Session
│  ├─ Runtime / Reconnect
│  ├─ Conversation / Streaming
│  ├─ Tool Execution
│  └─ Extension UI
│
├─ Workspace Platform
│  ├─ View Registration
│  ├─ Resource Access
│  ├─ Desktop / Mobile Layout
│  └─ File / Skill / Tool Views
│
├─ Feature Platform
│  ├─ Feature Registry
│  ├─ Contract Validation
│  ├─ Snapshot Hydration
│  └─ Tool Result Routing
│
└─ Vertical Features
   ├─ Task Mode
   ├─ Geo Visualization
   └─ Future Traffic Chart / Metrics / Reports
```

Session、Runtime、Conversation、Tool Execution、Extension UI 和 Workspace 是平台能力；Task、Geo 和未来交通结果卡片是垂直 Feature。React 只替换最外层表现和交互，不改变这一归属。

### 2.2 当前真实规模

| 区域 | 当前规模 | 主要问题 |
|---|---:|---|
| 浏览器端 TypeScript | 约 8,400 行 / 37 个文件 | 原生 DOM、状态和事件接线混合 |
| `src/public/app-main.ts` | 约 2,356 行 | 会话、输入、附件、状态和组合职责仍集中 |
| `public/style.css` | 约 4,969 行 | 六套主题、响应式和全部组件样式共存 |
| `public/index.html` | 约 313 行 | 页面骨架、Overlay、Dialog 和工作区容器 |
| `tool-card.ts` | 约 647 行 | 工具状态、Diff、图片和增量更新 |
| `session-sidebar.ts` | 约 594 行 | history/live、搜索、分组和 DOM 生命周期 |
| `message-renderer.ts` | 约 398 行 | Markdown、thinking 和流式消息 DOM |

React 的主要收益是组件所有权、状态订阅、Overlay/焦点管理和可测试 UI，不是减少代码行数。迁移难度评估为中高，约 `7/10`。

### 2.3 保留、适配与重写边界

直接保留：

- `src/server/` 下的 Node Server、Router、LiveSessionManager 和 SessionProjection。
- `extensions/` 下的 GIS、Task Mode 和 Pi Web Bridge。
- Pi JSONL 作为会话历史事实来源的原则。
- SessionSnapshot、TaskSnapshot、Bridge Envelope、GeoScene 等协议语义。
- MapLibre Geo Runtime 及其动态加载边界。
- 与 DOM 无关的 Markdown、格式化、模型标识和工具结果纯函数。

需要适配：

- `WebSocketClient`：退回为纯 Transport，不向组件暴露原始 event。
- `AgentRuntime`：增加 Event Normalizer、重连校正和 Store dispatch。
- Session、ToolExecution、ExtensionUI Controller：改为不依赖 DOM 的应用服务。
- FeatureRegistry：拆成 Domain Registry 与 UI Registry。
- Task/Visualization Store：保留协议和恢复逻辑，改为可订阅 Store。

需要重写：

- `app-main.ts` 中的平台 UI 状态与 DOM 接线。
- 静态 `index.html` 中的应用结构。
- Message、Thinking、ToolCard、SessionSidebar、Dialog、Command、Settings 和 Workspace DOM Renderer。
- 依靠 `innerHTML`、内联 `onclick`、`.hidden` 和 `classList.toggle()` 管理的交互状态。

## 3. 目标架构

```text
┌───────────────────────────────────────────────┐
│ React Web Adapter                             │
│ AppShell / Platform UI / Feature UI           │
└──────────────────────┬────────────────────────┘
                       │ selectors / command ports
┌──────────────────────▼────────────────────────┐
│ Browser Application Kernel                    │
│ Event Normalizer / Commands / Stores           │
│ Snapshot Hydrator / Reconnect / Error Mapping  │
└──────────────────────┬────────────────────────┘
                       │ normalized events / HTTP
┌──────────────────────▼────────────────────────┐
│ Existing Node Server                          │
│ Router / LiveSessionManager / SessionProjection│
│ WebSocket Adapter / Session-scoped Resources   │
└──────────────────────┬────────────────────────┘
                       │ JSONL RPC
┌──────────────────────▼────────────────────────┐
│ Independent Pi Worker                         │
│ pi --mode rpc + Web Bridge / Task / Geo        │
└──────────────────────┬────────────────────────┘
                       │
                    Pi JSONL
                 long-term truth
```

四层职责：

| 层 | 负责 | 不负责 |
|---|---|---|
| 协议与事实层 | JSONL、Contract、revision、分支和恢复语义 | React、DOM、MapLibre 视觉样式 |
| 应用运行时层 | Event 归一化、命令、重连、Store、错误映射 | 业务组件和具体地图图层 |
| Feature 层 | Task、Geo 等垂直协议投影和状态 | AppShell、全局布局 |
| React 表现层 | selector → view、user action → command | 原始 RPC、JSONL 分支、协议去重 |

当前 `pi --mode rpc` 已经构成独立 Worker 边界，因此本轮不新建 `src/worker/`，也不把 Pi SDK直接嵌进 Node Server。

## 4. Browser Application Kernel

这是 React 开工前最优先的工程工作。目标是让 legacy DOM 和未来 React 都能消费同一套应用语义。

### 4.1 Event Normalizer

Pi、WebSocket 和 HTTP Snapshot 先转换为内部 Action，再进入 Store：

```ts
type AppAction =
  | { type: 'runtime/connected' }
  | { type: 'runtime/disconnected'; reason?: string }
  | { type: 'session/snapshotReceived'; sessionId: string; snapshot: SessionSnapshot }
  | { type: 'conversation/streamStarted'; sessionId: string; runId: string }
  | { type: 'conversation/streamDelta'; sessionId: string; runId: string; delta: string }
  | { type: 'conversation/streamCompleted'; sessionId: string; runId: string }
  | { type: 'tool/updated'; sessionId: string; execution: ToolExecution }
  | { type: 'extensionUi/requested'; sessionId: string; request: ExtensionUiRequest }
  | { type: 'task/snapshotReceived'; sessionId: string; snapshot: TaskSnapshot }
  | { type: 'geo/envelopeReceived'; sessionId: string; envelope: VisualizationEnvelope };
```

约束：

- React、Task UI 和 Geo UI 不处理原始 Pi event。
- 原始 event type 到 AppAction 的映射只在 Normalizer 出现一次。
- Snapshot hydration 与 live event 使用同一领域 action，避免 live/history/resume 三套逻辑。
- 未知 event、非法 version 和 revision 回退产生可诊断错误，不能静默修改 Store。

### 4.2 Command Ports

组件不直接 `fetch()`、访问 WebSocket 或拼装 RPC JSON：

```ts
interface AgentCommands {
  sendPrompt(input: SendPromptInput): Promise<void>;
  abort(sessionId: string): Promise<void>;
  steer(input: SteerInput): Promise<void>;
  followUp(input: FollowUpInput): Promise<void>;
  setModel(input: SetModelInput): Promise<void>;
  setThinkingLevel(input: SetThinkingLevelInput): Promise<void>;
}

interface SessionCommands {
  list(): Promise<LiveSessionSummary[]>;
  create(input: CreateSessionInput): Promise<LiveSessionSummary>;
  resume(input: ResumeSessionInput): Promise<LiveSessionSummary>;
  loadSnapshot(sessionId: string): Promise<SessionSnapshot>;
  loadHistory(filePath: string): Promise<SessionSnapshot>;
  close(sessionId: string): Promise<void>;
}

interface ExtensionUiCommands {
  respond(input: ExtensionUiResponseInput): Promise<void>;
}
```

React 只能调用 Command Port。Transport 和 HTTP status 到领域错误的转换留在 Client/Runtime 内部。

### 4.3 Store 不做成一个巨大根对象

逻辑上存在一个应用，物理状态按职责与更新频率拆分：

```text
stores/
├─ runtime-store.ts
├─ session-store.ts
├─ conversation-store.ts
├─ tool-execution-store.ts
├─ extension-ui-store.ts
├─ workspace-store.ts
├─ preference-store.ts
└─ features/
   ├─ task-store.ts
   └─ visualization-store.ts
```

原因是 streaming token 属于高频状态，而 Session Sidebar、主题、Workspace Tab、Task Snapshot 和 Geo 偏好都是低频状态。把它们放进同一根订阅会扩大 React 重渲染范围。

第一阶段不引入 Redux、Zustand 或 XState。沿用现有 RuntimeStore 的小型外部 Store 模式，通过 `useSyncExternalStore` 建立领域 hook；出现实际 selector/equality 瓶颈后再评估第三方状态库。

建议暴露：

```ts
useConnectionState();
useActiveSessionId();
useSessionSummary(sessionId);
useConversationMessages(sessionId);
useStreamingMessage(sessionId);
useActiveToolExecutions(sessionId);
useExtensionUiRequest(sessionId);
useTaskSnapshot(sessionId);
useGeoVisualization(sessionId);
useWorkspaceState();
```

### 4.4 Stable Snapshot + Live Overlay

历史投影和实时执行必须分开：

```ts
interface ConversationState {
  snapshotEntries: SessionEntry[];
  live: {
    runId: string | null;
    optimisticPrompt: OptimisticPrompt | null;
    streamingMessage: StreamingMessage | null;
    activeTools: ToolExecution[];
    queuedMessages: QueuedMessage[];
  };
}
```

规则：

- `snapshotEntries` 只在 hydrate/reconcile 时替换，不在每个 token 到来时重写。
- token、工具 update 和 optimistic prompt 进入 live overlay。
- `agent_end` 或服务端新 Snapshot 到达后进行一次确定性 reconcile。
- reconnect 不得重复追加已经存在的 message/tool result。

这一步用于消除 RuntimeStore、StateManager 和 live session metadata 的 streaming 双写。

### 4.5 最小统一错误模型

Kernel 统一输出可序列化错误，不把 `Error` 实例或任意 `cause` 存入 Store：

```ts
interface AppError {
  code: string;
  category: 'transport' | 'protocol' | 'session' | 'extension' | 'resource' | 'feature' | 'runtime';
  message: string;
  sessionId?: string;
  retryable: boolean;
  diagnostics?: Record<string, string | number | boolean>;
}
```

UI 根据错误类别选择 Toast、Inline Error、Session Warning 或 Fatal Screen。组件不自行解释 HTTP/RPC 错误格式。

## 5. Feature 成为完整垂直切片

### 5.1 Domain Feature

不依赖 React：

```ts
interface FeatureDomainModule {
  readonly id: string;
  hydrateEntries?(context: FeatureHydrationContext): FeatureAction[];
  acceptToolResult?(context: FeatureToolResultContext): FeatureAction | null;
  acceptExtensionEntry?(context: FeatureExtensionContext): FeatureAction | null;
}
```

它负责协议校验、Snapshot hydration 和工具结果到 FeatureAction 的转换，不创建 DOM。

### 5.2 UI Feature

只注册界面能力：

```ts
interface FeatureUiModule {
  readonly id: string;
  workspace?: WorkspaceRegistration;
  floatingPanel?: React.ComponentType;
  statusItem?: React.ComponentType;
}
```

Task Mode 的 Domain 负责 revision、任务恢复和 `tau_task` 结果；UI 只负责 Task Board。Geo Domain 负责 Envelope/Scene 投影；UI 只负责 Workspace 和 Runtime Adapter。

### 5.3 Workspace Registration

```ts
interface WorkspaceRegistration {
  id: string;
  title: string;
  icon: React.ComponentType;
  availability(context: WorkspaceAvailabilityContext): boolean;
  component: React.ComponentType;
  mobileMode?: 'panel' | 'fullscreen';
}
```

Workspace Platform 只认识 id、标题、图标、可用性、组件和移动端行为，不认识 GeoJSON、交通语义或工具名。

未来增加 TrafficChart 的标准路径：

```text
Contract
  -> Pi Extension
  -> optional Server Resource Adapter
  -> Domain Feature
  -> Feature Store
  -> React UI Registration
```

`App.tsx`、AppShell 和 WorkspaceDock 不增加 `if (toolName === ...)`。

## 6. React 作为 Web Adapter

### 6.1 目标目录

```text
src/
  contracts/                    单包共享协议
    common/
    runtime/
    session/
    extension-ui/
    task/
    geo/

  server/                       保持现有 Node Server

  web/
    main.tsx
    app/
      App.tsx
      AppProviders.tsx
      AppShell.tsx
      composition-root.ts
      feature-ui-registry.ts

    runtime/
      agent-runtime.ts
      event-normalizer.ts
      snapshot-hydrator.ts
      reconnect-controller.ts

    clients/
      agent-client.ts
      session-client.ts
      resource-client.ts

    stores/
      runtime-store.ts
      session-store.ts
      conversation-store.ts
      tool-execution-store.ts
      extension-ui-store.ts
      workspace-store.ts
      preference-store.ts

    platform/
      sessions/
      conversation/
      tool-execution/
      extension-ui/
      workspace/

    features/
      task-mode/{domain,store,ui}/
      geo/{domain,store,runtime,ui}/

    components/
      ui/
      shell/

    lib/
      markdown/
      formatting/
      model-utils/

web/
  index.html
  static/

dist/web/                        Vite 产物，不跟踪
extensions/
skills/
prompts/
test/
docs/
```

目录表示职责，不要求迁移第一天就建立所有空文件夹。只有出现实际文件时创建目录。

### 6.2 Composition Root

`main.tsx` 只挂载应用：

```tsx
createRoot(document.getElementById('root')!).render(
  <AppProviders>
    <App />
  </AppProviders>,
);
```

`App.tsx` 只组合平台视图：

```tsx
export function App() {
  return (
    <AppShell
      sidebar={<SessionSidebar />}
      conversation={<ConversationWorkspace />}
      workspace={<WorkspaceDock />}
      overlays={<GlobalOverlayLayer />}
    />
  );
}
```

禁止在 `main.tsx`、`App.tsx` 和 `composition-root.ts` 出现工具名判断、Task/Geo 解析、JSONL 分支算法或 MapLibre layer。

### 6.3 UI 技术栈

```text
React + TypeScript
Vite
Tailwind CSS
shadcn/ui（Radix base）
Motion for React
现有 Node Server / WebSocket / Pi Extensions / MapLibre
```

- shadcn/ui：Button、Card、Badge、Input、Dialog、Tabs、Collapsible、Tooltip、DropdownMenu、Popover 和 Command。
- Radix：焦点、键盘、Portal、dismissal 和受控状态。
- Motion：Agent 状态、Task step、列表增删和布局变化。
- CSS transition：hover、颜色和简单旋转。

暂不引入 React Router、Redux、React Query 或 XState。当前是单页工作台，实时状态由 WebSocket/Store 主导；只有出现明确路由、服务器缓存或状态机需求后再单独评估。

保留六套主题的 CSS variables，并映射为 Tailwind/shadcn token。Motion 必须遵守 `prefers-reduced-motion`。

### 6.4 MapLibre Runtime Adapter

MapLibre 不为 React 重写：

```ts
interface GeoRuntimePort {
  mount(container: HTMLElement): void;
  applyScene(scene: GeoSceneSnapshot, sessionId: string | null): Promise<void>;
  setLayerVisibility(layerId: string, visible: boolean): void;
  resize(): void;
  destroy(): void;
}
```

React 的 GeoWorkspace 只提供稳定 container ref、图层控件和 metadata。Runtime 继续负责 MapLibre 实例、表达式、Popup、hover/selection 和 WebGL 生命周期。非 Geo 会话不得加载 MapLibre chunk。

### 6.5 Extension UI 是平台能力

第一阶段只迁移当前已经支持的 `select`、`confirm`、`input`、`editor` 和 `notify`，并保留按 session 排队、切换恢复和取消语义。

以下能力不纳入 React 首次切换：

- WebSocket 断线后的 pending request 恢复。
- timeout 与 cancel 的可靠区分。
- `setStatus`、`setWidget` 或任意 custom UI。

它们需要先有 Pi RPC 能力和版本协商，不能仅通过新增 React 组件宣称支持。Task Mode 的 `tau_ask_user` 继续复用 Extension UI，不另造 Dialog 协议。

## 7. Contract 与 Pi RPC 治理

### 7.1 共享 Contract

Vite 基座稳定后，将当前散落在浏览器目录中的项目自有协议迁入 `src/contracts/`，供 Extension、Server 和 Web 共同引用。暂时保持单 npm 包；只有出现第二个独立发布消费者时才提取 `packages/contracts`。

必须区分：

- `schemaVersion`：结构版本。
- `revision`：Snapshot 状态版本。
- `sequence`：有明确事件序列需求时的顺序号。

不强制把 Pi 原生所有 RPC event 重新包装成一个通用 `ProtocolEnvelope<T>`。只有项目自有跨边界协议使用统一 Envelope 约束，避免为了形式统一制造额外转换层。

### 7.2 能力协商

当前已经有 Pi 版本检查和 Web Bridge Envelope。后续在实际出现多协议版本时，再扩展 Bridge manifest：

```ts
interface RuntimeCapabilities {
  piVersion: string;
  bridgeVersion: number;
  taskEnvelopeVersion: number;
  geoSceneVersion: number;
  extensionUiKinds: string[];
  eventReplay: boolean;
}
```

能力协商属于协议治理阶段，不阻塞 Browser Kernel 和 Vite 基座。Server 应在 session 创建时给出不兼容诊断；不支持的能力不能等到打开任务板或地图时才静默失败。

Pi 子进程继续遵守 `stdout = JSONL RPC`、`stderr = diagnostic`。非法 JSON、未知版本、revision 回退和超限消息必须进入结构化诊断，但不把日志混进 RPC stdout。

### 7.3 统一 ResourceReference 是后续能力

Geo Resource 已经证明“大数据走 session-scoped HTTP，小型结构化结果走 Envelope”的方向正确。统一 `ResourceReference` 可在图片、长工具输出、报表等出现真实复用需求后实施，不作为 React 首次迁移的前置任务。

## 8. Vite 与 legacy 共存策略

迁移期间避免 React 和旧 DOM 争夺同一节点：

```text
public/       当前 legacy 编译与静态目录
web/          React/Vite 源入口和静态源资产
dist/web/     React/Vite 构建产物
```

实施阶段由 Server 配置或开发入口选择 legacy/react 静态根。两套 UI 连接相同 Node API 与 WebSocket，但一次页面只运行一套 UI。

约束：

- Vite 不向 `public/` 输出，也不清空 legacy 资产。
- React 入口在切换前不替换默认 `/`。
- React 通过内部入口或显式配置验收，不长期维护两套产品行为。
- React 成为默认入口后保留 legacy 回退一个稳定周期，再删除旧 Renderer、StateManager、HTML 和无引用 CSS。
- npm 包必须包含实际运行需要的 `dist/web`、Extension、Skill、Prompt 和 Server 产物。

## 9. 分阶段实施与门槛

### 阶段 0：冻结事实和行为

交付：

- Session JSONL、分支、Task、Geo 和 Bridge fixture。
- 真实 Pi event replay fixture。
- create/switch/resume/close、streaming、abort、Task Dialog 和 Geo Workspace 浏览器基线。
- 六套主题、桌面和移动端截图。
- 当前 token/render、MapLibre chunk 和长会话性能基线。

退出条件：核心路径失败时能由自动化或明确手工清单识别；不再凭“页面大致能打开”判断兼容。

### 阶段 1：Browser Application Kernel

交付：

- Event Normalizer。
- Agent/Session/Extension UI Command Ports。
- 分域 Store 与 selector API。
- Stable Snapshot + Live Overlay。
- reconnect reconcile 和最小 AppError。
- legacy UI 改为消费 Kernel，删除 streaming 双写。

退出条件：同一组 Snapshot + event fixture 能确定性重放出相同状态；状态指示灯、输入禁用、会话标签和消息流不再各自判断 streaming。

### 阶段 2：Vite 基座

交付：

- 独立 `web/` 源入口和 `dist/web/` 产物。
- React、Tailwind、shadcn 和六套主题 token。
- Node dev proxy/静态托管、dynamic import 和 npm 发布清单。
- legacy/react 独立入口。

退出条件：空 React Shell 可由现有 Node Server 提供；legacy 默认行为无回归；非 Geo 页面不加载 MapLibre。

### 阶段 3：Contract 治理

交付：

- 项目自有协议迁入 `src/contracts/`。
- unknown version/revision regression 的显式诊断。
- Bridge capabilities 的最小版本声明。
- Extension、Server、Web 共用协议 fixture。

退出条件：Task、Geo、Bridge 和 SessionSnapshot 的合法/非法版本都有契约测试；不要求包装全部 Pi 原生 event。

### 阶段 4：React Shell 与低耦合平台 UI

迁移顺序：

1. AppShell、Header 和 Agent Status。
2. Settings、Model Picker、Command Palette 和 New Session Dialog。
3. Extension Dialog Layer。
4. SessionSidebar、Live Tabs 和 Workspace Layout。

退出条件：焦点、Esc、键盘导航、后台 Dialog、移动端 sidebar、主题和 session 切换达到现有行为对等。

### 阶段 5：Conversation

迁移：

- Message Window 和 Streaming Message。
- Thinking、Tool Card、Markdown、Diff 和图片。
- Composer、附件、消息队列、abort/steer/follow-up。

退出条件：live/history/resume 三条路径一致；token delta 不使稳定历史消息、SessionSidebar 和 Workspace 重渲染；长输出无明显卡顿。

### 阶段 6：Feature UI

顺序：

```text
Extension UI Platform -> Task Board
Workspace Platform    -> Geo Workspace
```

迁移 Task Domain/UI 分层、Geo Domain/UI/Runtime Port，并用同一模式验证一个最小示例 Feature。

退出条件：Task、Geo 可以独立 hydrate 和测试；AppShell 不识别 `tau_task`、`present_visualization` 或其他具体工具名。

### 阶段 7：默认切换与删除 legacy

交付：

- React 成为默认入口。
- 保留 legacy 回退一个稳定周期。
- 删除旧 `app-main.ts` UI 接线、Renderer、StateManager、旧 HTML 容器和无引用 CSS。
- 更新 ARCHITECTURE、README、启动脚本、发布清单和截图。

退出条件：完整 Node、Pi RPC、浏览器、移动端和 npm pack 验证通过；legacy 删除后没有双实现或构建死路径。

## 10. 测试体系

| 层 | 必须覆盖 |
|---|---|
| Contract | schemaVersion、revision、unknown version、非法字段和资源引用 |
| Projection | 直线/分支 JSONL、无 id entry、Task、Geo、compaction 和 interrupted |
| Event Replay | start/delta/tool/end、迟到、重复、abort、断线和 reconnect |
| Store | session 隔离、Snapshot + overlay、selector 稳定性和 reconcile |
| Feature | Tool Result → Domain Action → Store → selector，不加载 React |
| Component | 焦点、键盘、受控状态、空/错/加载状态和 reduced motion |
| Browser E2E | 创建、resume、streaming、abort、Dialog、Task、Geo、移动端和主题 |
| Real Pi Smoke | Pi 版本、Extension 加载、Bridge manifest 和关键 RPC 往返 |

真实 Chrome smoke 当前只覆盖连接和新建会话，因此阶段 0 是强制门槛。

## 11. 性能预算

| 场景 | 约束 |
|---|---|
| token delta | 不触发 SessionSidebar、Workspace 或稳定历史消息重渲染 |
| streaming | 只更新当前 live overlay；必要时按 animation frame 批处理 |
| session 切换 | 先显示已有 Snapshot，再进行后台校正 |
| reconnect | 不重复消息、工具卡或 Feature Snapshot |
| MapLibre | 非 Geo 会话不加载 bundle；同一工作区只保留一个实例 |
| 长 thinking/tool output | 折叠内容延迟渲染，必要时转 ResourceReference |
| 长会话 | 达到真实瓶颈后引入窗口化；不在迁移初期预先实现 |
| idle | 无持续无意义 render、timer 或 reconnect loop |
| Extension UI | 后台请求不覆盖当前会话请求 |

实现期应使用 React Profiler、浏览器 Performance 和 bundle report 建立实际阈值；本文不虚构毫秒指标。

## 12. 架构治理规则

### 12.1 Composition Root

以下文件只能组合依赖和布局：

```text
server-main.ts
src/web/main.tsx
src/web/app/composition-root.ts
src/web/app/App.tsx
```

禁止出现工具名判断、Feature 协议解析、JSONL branch 算法、MapLibre layer 和大型 reducer。

### 12.2 依赖方向

允许：

```text
React UI -> Selector / Command Port
Feature UI -> Feature Store
Feature Store -> Feature Domain / Contract
Runtime -> Store / Client Port
Server Adapter -> Contract
Extension -> Contract
```

禁止：

```text
Contract -> React / Node / MapLibre
Store -> React Component
Feature -> AppShell
Workspace Platform -> Tool Name
Server Core -> GIS UI
React Component -> raw WebSocket / Pi JSONL
```

### 12.3 跨边界变更

同时修改三层以上的 PR 必须回答：

1. 数据在哪里产生？
2. 通过哪个 Contract？
3. 在哪里验证？
4. 在哪里存储？
5. 在哪里消费？
6. 如何恢复和降级？

重要决策再建立简短 ADR；不为普通实现细节批量创建 ADR。

## 13. 主要风险与控制

| 风险 | 控制 |
|---|---|
| React 与 legacy 双重响应 | 独立入口、独立 DOM root；同一页面只运行一套 UI |
| 高频 token 造成全局 render | 分域 Store、live overlay、细粒度 selector、按帧批处理 |
| Store 过度抽象 | 从现有 RuntimeStore 演进，只为真实消费者建立 Store |
| CSS/Tailwind 冲突 | 新 React root 隔离；先映射 token，再逐区域迁移 |
| MapLibre 重复实例 | 稳定 ref、幂等 mount/destroy、Feature 生命周期测试 |
| live/history/resume 不一致 | Normalizer、Snapshot hydrator 和 event replay 共用 fixture |
| Vite 清空运行资产 | 输出到 `dist/web`，不写入 legacy `public/` |
| 迁移范围扩张 | RPC capability、ResourceReference 等非必要治理项不阻塞 React Shell |
| “参考 pi-web”演变成复制结构 | 只参考交互，不复制大型 AppShell hook 或集中状态模式 |

## 14. 工作量与里程碑

以一名熟悉当前项目的工程师、包含测试和回归估算：

| 工作项 | 估算 |
|---|---:|
| 阶段 0：事实、fixture、浏览器和性能基线 | 4–6 人日 |
| 阶段 1：Browser Kernel 与双写消除 | 5–8 人日 |
| 阶段 2：Vite、React、shadcn 和主题基座 | 3–5 人日 |
| 阶段 3：Contract 治理 | 2–4 人日 |
| 阶段 4：Shell、Session、Dialog 和 Workspace | 5–8 人日 |
| 阶段 5：Conversation、Streaming 和 ToolCard | 7–11 人日 |
| 阶段 6：Task、Geo 和 Feature 验证 | 4–7 人日 |
| 阶段 7：切换、删除 legacy 和发布回归 | 3–5 人日 |
| **总计** | **33–54 人日** |

单人完整完成约需 7–11 周。若只创建 React 外壳，一周左右可以看到新页面，但不代表状态内核、历史恢复和功能对等已经完成。

每个阶段独立提交和验收；不得把 Browser Kernel、Vite、Conversation 和新 GIS 能力放入同一个大 PR。

## 15. 暂时不做

- 不迁移 Next.js。
- 不重写 Node Server 或改用 Fastify。
- 不把 Pi SDK直接嵌进 Web Server。
- 不用数据库取代 Pi JSONL。
- 不引入微服务、多个仓库或 npm workspaces。
- 不同时引入 Redux、React Query、Router 和 XState。
- 不把 MapLibre 改写成 React layer。
- 不把所有状态放进 React Context 或一个巨大 Store。
- 不创建巨大的 `useAgentSession`、`App.tsx` 或 `composition-root.ts`。
- 不在缺少真实需求时预先实现通用 Widget、任意 custom Extension UI、统一大资源平台或消息虚拟列表。

## 16. 开始实施前的检查清单

- [ ] 阶段 0 的 fixture 和浏览器基线进入仓库。
- [ ] 明确 legacy/react 静态入口和回退方式。
- [ ] Event Normalizer、Command Port 和 Store 的最小接口通过设计审阅。
- [ ] Snapshot 与 live overlay 的 reconcile 规则有测试样例。
- [ ] `DEFAULT_TASK_CWD` 不再由 React 复制一份硬编码路径，而由服务端配置提供。
- [ ] Vite 输出目录不会覆盖 `public/` 或 Extension/Skill/Prompt。
- [ ] 六套主题和移动端关键页面有截图基线。
- [ ] Task Dialog、Geo Workspace 和 resume 已进入浏览器验收范围。
- [ ] 每阶段都有清晰回退点，不依赖未完成的下一阶段。

## 17. 官方参考

- [React：向现有项目添加 React](https://react.dev/learn/add-react-to-an-existing-project)
- [React：useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)
- [shadcn/ui：Vite 安装](https://ui.shadcn.com/docs/installation/vite)
- [shadcn/ui：组件源码与组合原则](https://ui.shadcn.com/docs)
- [Radix Primitives：介绍](https://www.radix-ui.com/primitives/docs/overview/introduction)
- [Motion for React：安装](https://motion.dev/docs/react-installation)
- [Motion for React：AnimatePresence](https://motion.dev/docs/react-animate-presence)
- [MapLibre GL JS](https://maplibre.org/maplibre-gl-js/docs/)
