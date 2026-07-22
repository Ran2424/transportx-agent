# Pi Traffic Workspace 架构与目录治理

更新时间：2026-07-22

本文是项目唯一的总体架构基准，统一维护系统边界、运行时链路、目录职责、依赖方向、协议恢复和演进阶段。README 只保留产品功能、启动方式和使用注意事项，不再复制目录树或实现细节。

## 1. 架构决策

项目维持单仓库、单 npm 包和单 Web 服务，采用 **模块化单体 + 垂直功能切片 + Ports/Adapters**，而不是现在拆成两个仓库或两个应用。

当前主要工作域是：

1. **Agent Web 平台**：管理 Pi RPC 子进程、会话、历史、消息、工具卡片、文件和工作区 UI。
2. **GIS 可视化模块**：通过 Pi Extension 生成受控 GeoScene，经会话和资源接口传到浏览器，再由 MapLibre 渲染。
3. **任务交互模块**：通过 Pi Extension 维护结构化任务状态并请求用户输入，由 Web 恢复 TaskCard、模式状态和交互 Dialog。

GIS 是第一个跨边界功能切片，任务交互是第二个。它们都依赖平台提供的会话和工具结果；平台核心不应依赖 MapLibre、任务状态或交通领域语义。后续每项能力都按同一结构落地：

```text
功能切片
  ├─ Pi Adapter       Extension / Tool，负责让 Agent 产生结构化结果
  ├─ Server Adapter   API / 会话资源，负责权限、存储和传输
  ├─ Web Adapter      WebFeature / WorkspaceView，负责交互和展示
  ├─ Contract         跨边界声明式数据协议
  └─ Tests            契约、适配器与端到端路由测试
```

这不是要求把每项功能强行建成独立 npm 包，而是要求它有清楚的入口、契约和依赖方向。

只有满足以下任一条件时，才考虑 npm workspaces、独立包或独立部署：

- 共享 Contract 出现第二个独立发布或仓库消费者。
- GIS Runtime 需要独立版本和发布节奏。
- Web 前端与服务端需要分别部署。
- 单包构建或测试耗时已经造成明确工程问题。

## 2. 系统链路

```text
Browser Agent Web UI
  ├─ React Web Adapter（默认 `/`；Shell、Session、Dialog、Conversation、Task 与 Geo UI 已接入 Kernel）
  ├─ app-main（legacy DOM 组合入口；仅 `/legacy/` 回退周期保留）
  ├─ Browser Application Kernel
  │    ├─ Event Normalizer / Command Ports
  │    ├─ Runtime / Session / Conversation / Tool / Extension UI Stores
  │    └─ Snapshot + Live Overlay reconcile
  ├─ WebSocketClient（transport adapter）
  ├─ WorkspaceController（右侧工作区壳层）
  └─ FeatureRegistry
       ├─ GeoFeature（GIS Web Adapter）
       │    └─ VisualizationHost
       │         └─ MapLibreGeoRuntime
       └─ TaskModeFeature（任务 Web Adapter）
            ├─ SessionTaskStore
            └─ TaskCardRenderer
                    ▲
                    │ WebSocket：toolResult.details / Extension UI
Node Web Server
  ├─ 类型化 HTTP Router + WebSocket / RPC 适配
  ├─ LiveSessionManager
  ├─ branch-aware SessionProjection
  └─ Session-scoped Geo Resource API
                    ▲
                    │ JSONL RPC
Pi Agent Child
  ├─ pi-geo-visualization Extension
  │    ├─ publish_geodata
  │    └─ present_visualization
  ├─ pi-task-mode Extension
  │    ├─ tau_task
  │    └─ tau_ask_user
  └─ pi-web-bridge Extension
       ├─ 完整 Tool Manifest
       └─ model / thinking 状态 Envelope
```

GeoScene 是跨边界的共享契约。它必须保持声明式、可验证且不携带 JavaScript、HTML、CSS、任意 URL 或 MapLibre 原生表达式。Agent 侧不直接构造该契约，而是调用 `present_visualization` 的命令式参数；Extension 负责组装、字段级验证并生成完整快照。

### 2.1 会话事实来源与恢复

Pi JSONL 是会话历史的事实来源。运行中事件只用于降低实时展示延迟，不建立另一份具有独立语义的历史数据库。

服务端通过 `SessionProjection` 将 live、history 和 resume 统一投影为同一种 Snapshot：

```text
Pi JSONL / live entries
  -> SessionProjection（按最后叶节点回溯 parentId）
  -> SessionSnapshot { schemaVersion, entries }
  -> Browser Application Kernel（SessionStore / ConversationStore）与 FeatureRegistry
```

- 恢复时只选择当前分支，舍弃已经放弃的兄弟分支。
- 旧会话中没有 `id` 的旁路记录继续按顺序保留，避免丢失历史扩展状态。
- 内存 entries 是实时窗口与缓存，不得成为比 JSONL 更高优先级的事实来源。
- Extension 自定义状态使用显式 Envelope。Task Web 解析器兼容旧版未版本化 mode entry；未知 schema/version 与 revision 回退由 `ContractDiagnostic` 显式报告，不再只能静默返回 `null`。

### 2.2 Pi Web Bridge 与工具结果分发

`pi-web-bridge` 负责补足 Pi RPC 当前没有直接发布给 Web 的会话能力。Bridge Envelope 包含 `schemaVersion`、单调递增的 `revision`、完整 Tool Manifest、当前 model/thinking level，以及 `RuntimeCapabilities` 最小声明（Pi、Bridge、Task、Geo 版本、Extension UI kinds、event replay）。

服务端在会话构造时建立初始 capabilities，收到 Bridge 后校验并把不兼容项作为协议诊断发布；Web 端从统一 Snapshot 和 live entry 中恢复，不在每次 prompt 后使用宽泛 `get_state` 轮询。工具执行结果进入 `ToolExecutionController` 后，再交给 `FeatureRegistry` 分发到任务或 GIS 等垂直功能，组合入口不判断具体工具名。

### 2.3 任务模式运行链路

```text
Web 模式开关 / /task command
  -> pi-task-mode Extension
  -> tau_task / tau_ask_user
  -> versioned Task Envelope
  -> SessionTaskStore（按 session + revision 去重）
  -> 可拖动 TaskCard / Extension UI Dialog
```

- 模式状态和任务快照都带 `schemaVersion` 与 `revision`，同时兼容既有未版本化记录。
- `tau_task` 负责结构化任务生命周期；`tau_ask_user` 复用 Pi RPC Extension UI 协议，不另造 Web 专属问答协议。
- Agent 遗漏终态、进程异常结束或恢复旧会话时，未完成任务会落为 `interrupted`，保证刷新和 resume 后仍可解释。
- Web 只投影 Extension 状态，不维护与 Pi 相互竞争的第二套任务状态机。

### 2.4 GIS 数据与展示链路

```text
任务目录 GeoJSON
  -> publish_geodata（ID、坐标、大小和会话边界校验）
  -> session-scoped resourceId
  -> present_visualization command
  -> validated GeoScene snapshot
  -> VisualizationHost
  -> lazy-loaded MapLibre Runtime
```

- Agent 使用命令式 `create_map`、`add_layer`、`set_*` 等参数，不手写完整 Scene JSON。
- 地图资源只能从对应 live session 的任务目录读取，服务端负责路径与资源隔离。
- 历史会话可以恢复 Scene Snapshot，但资源型 GeoJSON 只有在 live session 或 resume 后才有可用的数据路由；当前不支持直接从只读历史页渲染资源型地图。
- `default`、`light`、`dark` 使用白名单在线底图；`none` 提供纯色离线底图。
- 非地图会话不加载 MapLibre bundle，地图视觉增强属于 Runtime，不能反向污染 GeoScene 契约。

### 2.5 项目提示词、Skill 与本地资产

每个 Pi Web 会话启动时，服务端读取 `prompts/PI_SESSION_CONTEXT.md`，替换目录占位符后作为项目级上下文注入。支持的占位符为：

- `PROJECT_ROOT`
- `TASK_WORKING_DIRECTORY`
- `PROJECT_SKILLS_DIR`
- `TRAFFIC_TOOLS_DIR`
- `TRAFFIC_DATA_DIR`
- `PROJECT_PROMPT_PATH`

未知占位符会阻止会话启动，避免静默注入错误路径。项目级 Skill 由服务端通过 `--skill` 显式加载，因此会话即使运行在 `scenario/` 内也能发现仓库 Skill。本地 SQLite、临时 GeoJSON 和任务输出不属于仓库源资产，必须继续由 `.gitignore` 隔离。

legacy 新建会话表单仍保留 `app-main.ts` 内的本机绝对 `DEFAULT_TASK_CWD`，这是待 legacy 删除时一并清理的兼容债务。React 新建任务不会复制该路径，也不发送 cwd；服务端统一以 `process.cwd()/scenario` 为默认根目录，并创建带时间戳的独立任务目录，因此 React 入口可随仓库位置迁移。

## 3. 当前目录职责

```text
src/
  contracts/                      Extension、Server、Web 共用的项目协议权威
    index.ts                      统一重导出入口
    common.ts                     JSON/Model/Validation 共享原语
    session.ts                    SessionSnapshot v1 与纯分支投影
    task.ts                       TaskSnapshot v1、解析和状态变更
    geo.ts                        GeoScene / VisualizationEnvelope 1.0
    bridge.ts                     PiWebBridgeEnvelope v1 与 revision 诊断
    capabilities.ts               RuntimeCapabilities 最小声明
    errors.ts                     可序列化 AppError
    diagnostic.ts, version.ts     结构化诊断与协议版本常量

  server/                         Agent Web 服务端核心
    server-main.ts                HTTP、WebSocket、RPC 的组合入口
    router.ts                     类型化 method/path 路由器
    api-routes.ts                 API 路由表与服务端端口
    sessions.ts                   Pi 子进程和 live session 生命周期
    session-projection.ts         按 parentId 选择当前分支并生成统一 Snapshot
    pi-runtime.ts                 Pi CLI 版本兼容检查
    pi-web-bridge.ts              Bridge Contract 兼容重导出层
    auth.ts                       浏览器会话认证
    config.ts                     环境、目录和扩展定位
    model-utils.ts                模型标识与列表解析
    geo-resources.ts              GIS 的服务端适配器

  public/                         浏览器端源码
    app-main.ts                   legacy DOM 布局、组合入口与 Kernel 事件接线
    app-types.ts                  浏览器端平台类型
    kernel/                       Browser Application Kernel
      app-kernel.ts               transport、Normalizer、Dispatcher 与 UI 事件边界
      actions.ts                  归一化 AppAction 类型
      commands.ts                 Agent/Session/Extension UI Command Ports
      event-normalizer.ts         原始 WebSocket 消息到 AppAction 的唯一归一化入口
      dispatcher.ts               跨 Store action 分发
      stores/                     Runtime、Session、Conversation、Tool、Extension UI Store
    controllers/                  仍需 DOM 计时的工具卡视图控制器
      tool-execution-controller.ts
    workspace/                    Web 工作区壳层
      workspace-controller.ts     文件/资源/功能视图切换与侧栏生命周期
      workspace-types.ts          功能可依赖的最小工作区端口
    features/                     Web 垂直功能适配器
      feature-registry.ts         功能注册和会话/工具结果生命周期分发
      geo/geo-feature.ts          GIS 对平台的唯一组合入口
      task/                       任务模式 Web Adapter
        task-mode-feature.ts      模式开关、会话与工具结果接线
        task-protocol.ts          Task Contract 兼容重导出层
        session-task-store.ts     按会话和 revision 去重
        task-card-renderer.ts     独立任务板内的 TaskCard 内容渲染
    visualization/               通用声明式可视化子系统
      visualization-host.ts      Scene 存储、地图视图与 Runtime 桥接
      session-visualization-store.ts
      geo/
        protocol.ts               Geo Contract 兼容重导出层
        geo-runtime-entry.ts      MapLibre Runtime 唯一入口

extensions/
  pi-geo-visualization/           Agent 侧 GIS 工具适配器
  pi-task-mode/                   Agent 侧任务状态与用户交互适配器
  pi-web-bridge/                  Pi 到 Web 的工具、模型与思考状态桥接

skills/                           项目拥有、随 Web 会话显式加载的 Pi Skill
  geo-visualization-explanation/  Geo 工具工作流与制图约束
  plot-from-data/                 静态科研绘图模板
  shanghai-traffic-data-assets/   上海交通数据、查询脚本与治理说明

prompts/
  PI_SESSION_CONTEXT.md           Pi 子进程追加系统提示模板；会话启动时替换目录占位符

public/                           Web 发布目录
  index.html                      legacy 手写静态入口
  style.css                       legacy 手写全局样式
  icons/                          手写/设计源静态资产
  *.js, features/, visualization/ 编译产物，不跟踪
  contracts/                      共享 Contract 浏览器编译产物，不跟踪
  workspace/                      编译产物，不跟踪
  geo-runtime.*                  编译产物，不跟踪

src/web/                          React/Vite Web Adapter
  index.html, main.tsx            独立 React 入口
  app/                            Composition Root、Providers、Store hooks 与 AppShell
  platform/                       Session、Settings、Model、Command、Extension UI、Workspace 平台界面
  components/, lib/               shadcn/Radix 风格基元、图标与纯格式化函数

dist/web/                         Vite 生产产物，不跟踪

test/                             Node 测试；文件名前缀对应模块
docs/                             工程文档与截图资产
scenario/                         本地任务工作区，不跟踪
```

项目自有跨边界协议统一位于 `src/contracts/`，且不得导入 React、Node、DOM 或 MapLibre。旧 `task-protocol.ts`、Geo `protocol.ts`、`pi-web-bridge.ts` 与 Kernel errors 文件只保留重导出兼容层。TypeScript 以 `src/` 为共享编译根，发布后布局脚本恢复现有平面入口，并生成不入 Git 的 `bin/contracts/`、`public/contracts/`；项目仍是单仓库、单 npm 包。

## 4. 依赖方向

允许的依赖：

```text
Extension / Server / Web ──> src/contracts（单向依赖）
server-main ────────────────> server core + feature route adapters
React Platform UI ─────────> Kernel Store selectors + Command Ports
app-main ──────────────────> platform controllers + FeatureRegistry
FeatureRegistry ───────────> WorkspaceRegistration（最小端口）
GeoFeature ─────────> VisualizationHost
VisualizationHost ─> GeoScene protocol + MapLibre runtime loader
MapLibre runtime ───> GeoScene protocol + maplibre-gl
Pi GIS extension ───> GeoScene contract
```

禁止的依赖：

- 服务端会话核心不得导入 MapLibre、DOM 或地图样式代码。
- GeoScene 协议不得导入 Node、DOM、MapLibre 或交通领域模块。
- `geo-resources.ts` 只处理会话资源和 HTTP，不处理地图视觉表达。
- `file-browser.ts` 不承载技能、工具或 GIS 业务逻辑。
- `WorkspaceController` 不识别 GIS、图表或交通业务；它只认识 `WorkspaceView`。
- `FeatureRegistry` 不判断具体工具名；判断一个工具结果是否属于某功能，是功能适配器自己的职责。
- `app-main.ts` 和 `server-main.ts` 只做组合、平台级状态与路由挂载；新增完整功能应先进入独立模块。
- Agent 不得直接生成 MapLibre source/layer/expression 或外部底图 URL。

当前 Web 端最小扩展接口是：

```ts
interface WebFeature {
  readonly id: string;
  readonly workspaceView?: WorkspaceView;
  setSession(context: FeatureSessionContext, reset: boolean): void;
  handleToolResult(context: FeatureToolResultContext): FeatureToolResult | null;
}
```

`app-main.ts` 只负责创建、注册功能并把平台事件送入 `FeatureRegistry`。功能不能反向读取入口文件的全局状态；需要平台能力时，应增加小型 port/callback，而不是导入 `app-main.ts`。

## 5. 两个工作域的代码所有权

| 改动类型 | 主要目录 | 配套测试 |
|---|---|---|
| 会话、RPC、历史恢复 | `src/server/sessions.ts`、`src/server/server-main.ts` | `pi-rpc-session`、`live-session-manager`、`rpc-command` |
| Agent Web 消息与工作区 | `src/public/*.ts`、`src/public/workspace/`、`public/index.html`、`public/style.css` | 浏览器验收及相关 Node 测试 |
| GeoScene 契约 | `src/public/visualization/geo/protocol.ts` | `test/geo-protocol.test.ts` |
| Agent GIS 工具 | `extensions/pi-geo-visualization/` | `test/geo-extension.test.ts` |
| Agent 任务模式工具 | `extensions/pi-task-mode/` | `test/task-mode-extension.test.ts` |
| Pi 项目 Skill | `skills/`、`src/server/config.ts`、`src/server/sessions.ts` | `pi-rpc-session` 中的加载路径检查 |
| 任务模式 Web Adapter | `src/public/features/task/` | `test/task-mode-web.test.ts` |
| GIS 会话资源 | `src/server/geo-resources.ts`、服务端路由接入点 | `test/http-routes.test.ts` |
| GIS 平台接入 | `src/public/features/geo/geo-feature.ts` | `test/feature-registry.test.ts` + 浏览器验收 |
| 地图 Scene 与渲染 | `src/public/visualization/`、GIS 样式区 | 协议测试 + 真实浏览器视觉验收 |

跨越三个以上区域的改动应在 PR 描述中明确说明数据从哪里产生、通过哪个契约传输、最终在哪里消费。

### 5.1 服务端接口边界

类型化 `ServerRouter` 当前挂载的主要接口分为五组：

| 接口组 | 主要路径 | 职责 |
|---|---|---|
| 健康与会话 | `GET /api/health`、`/api/live-sessions*` | 创建、恢复、查询和关闭 live session |
| 历史与项目 | `/api/projects`、`/api/sessions*`、`/api/session-history`、`/api/search` | 发现 JSONL 历史并返回统一 Snapshot |
| 会话资源 | `/api/files`、`/api/file/preview`、`/api/session-resources` | 在 live session 边界内读取文件、Skill 和 Tool Manifest；不服务只读历史会话 |
| Pi 命令 | `POST /api/rpc` | 将允许的 Web 命令代理到指定 Pi 子进程 |
| 本机操作 | `POST /api/open` | 在路径校验后调用系统打开受控文件 |

GIS GeoJSON 资源使用独立的 session-scoped route adapter。新增接口必须先进入 `api-routes.ts` 或垂直功能 route adapter，不能重新在 `server-main.ts` 建立长 `if` 链。

### 5.2 浏览器状态边界

浏览器状态当前按职责分为六类，不能混用：

1. `RuntimeStore`：WebSocket 连接状态和最后一个可序列化 `AppError`。
2. `SessionStore`：live session 列表、当前活动 session，以及每个 session 的 streaming 基准。
3. `ConversationStore`：每个 session 的稳定 Snapshot entries、optimistic prompt、token/thinking live overlay 和排队消息。
4. `ToolExecutionStore` 与 `ExtensionUiStore`：工具执行记录、Extension UI 当前请求和按 session 排队语义。
5. Feature Store：Task、Geo 等垂直功能的协议投影和恢复状态。
6. `localStorage`：主题、收藏、当前视图、任务板位置、地图选择和耗时展示等 UX 偏好。

`localStorage` 不是会话事实来源。清空它可以丢失界面偏好和历史耗时缓存，但不能导致任务、消息、地图 Snapshot 或 Pi 模型状态损坏。

模型在系统内始终表示为 `{ provider, id }`。模型 `id` 可以包含 `/`，任何层都不得通过拆分 slash 推断 provider；显示标签只能在已知 provider 与完整 id 之间拼接。

### 5.3 响应式与无障碍约束

legacy 移动端断点为 `768px`，React Shell 采用 `860px` 抽屉断点；两者都在各自 Web 入口内响应式适配，不建立独立移动端应用：

- 左侧会话栏改为带遮罩的 slide-over，并支持从屏幕左缘滑入。
- 普通资源侧栏在移动端隐藏；存在地图时，工作区使用全屏覆盖层。
- 任务板适配窄屏宽度，消息、工具卡和思考卡使用完整可用宽度。
- 移动端输入框使用 `16px` 字号避免 iOS 自动缩放；侧栏、设置和输入区等主要按钮设置了 `44px` 触控目标，任务模式等紧凑控件目前仍有例外。
- 页面从后台恢复时由 `WebSocketClient.forceReconnect()` 重新建立 transport；Kernel 重新接收 state/snapshot 并恢复浏览器投影，状态指示灯仍只消费 Store。
- 保留 `prefers-reduced-motion`、`prefers-reduced-transparency` 和高对比度媒体查询。

响应式样式的事实来源是 `public/style.css`，移动行为接线位于浏览器控制器或组合入口。不要再维护一份与实现逐项复制的移动端说明文档。

## 6. 资产与生成物规则

### 跟踪到 Git

- TypeScript 源码、Extension 源码和测试。
- `skills/` 内的 `SKILL.md`、参考文档、查询/绘图脚本和 UI 元数据。
- `public/index.html`、`public/style.css`、`public/icons/` 等静态源资产。
- `docs/` 内的长期文档和正在使用的截图。
- package、TypeScript 和容器配置。

### 不跟踪到 Git

- `bin/*.js`、`public/*.js`、`public/visualization/`、`public/geo-runtime.*` 等构建产物。
- `scenario/`、`.tau/`、Pi session HTML 和本地 Agent 配置。
- `skills/shanghai-traffic-data-assets/assets/databases/` 下的本地 SQLite 数据；它们由 Skill 自身的 `.gitignore` 排除，不进入主仓库。
- 临时 GeoJSON、性能日志、浏览器截图和一次性分析输出。

源码变更后的标准验证顺序：

```bash
rtk npm run typecheck
rtk npm test
rtk npm run test:pi-smoke
rtk npm run test:browser-smoke
```

`npm test` 会重新生成运行所需的服务端、浏览器端和 MapLibre bundle。不要手工修改编译后的 JavaScript。

## 7. 增长控制

当前需要重点控制三个组合文件：

- `src/public/app-main.ts`：新增功能先实现 `WebFeature`；入口只实例化、注册并转发平台事件。
- `src/server/server-main.ts`：新增 API 先进入类型化 `api-routes.ts` 或独立功能 route adapter，再由入口注入依赖并挂载。
- `public/style.css`：新功能样式使用稳定前缀集中成段；下一次实质性 UI 模块增加时，再引入 CSS 分文件构建。

不以行数机械拆分文件。只有出现独立职责、独立测试或第二个调用方时才抽模块。

## 8. 分阶段治理路线

### 阶段 A：治理层（已完成）

- 建立本架构文档；旧文档索引和重复交接说明已合并或移除。
- 统一模块化构建命令、资产规则和仓库元数据。
- 建立 `WorkspaceController`、`FeatureRegistry` 与 `GeoFeature` 三层 Web 集成点。
- 将 GIS 资源 URL 的识别、解码和会话查找移入 `geo-resources.ts`。

### 阶段 B：组合入口第一轮瘦身（已完成）

- 早期版本建立了 AgentRuntime、RuntimeStore，以及 Session、ToolExecution、ExtensionUI 三个控制单元；这些过渡边界已由后续 Browser Application Kernel 统一接管。
- 状态指示灯的连接/streaming 基础状态曾消费 RuntimeStore，不再读取 WebSocket 实例自行推断；临时成功/错误文字仍由 `app-main.ts` 直接更新 DOM。
- 已建立类型化 ServerRouter，并将 API 路由表移出 `server-main.ts`。
- GIS UI 样式目前仍在 `public/style.css`；CSS 分文件与构建合并留给 Vite/React 阶段处理。

### 阶段 C：Browser Application Kernel（已完成，2026-07-22）

- 建立 `src/public/kernel/`：Event Normalizer、Dispatcher、Command Ports、Runtime/Session/Conversation/Tool/Extension UI Store。
- 用 Stable Snapshot + Live Overlay 统一 live、history、resume 和 reconnect 的消息投影，处理迟到/重复 delta 与 abort。
- `app-main.ts` 改为消费 Kernel stores/commands；旧 StateManager、AgentRuntime、SessionController 和 ExtensionUIController 源文件删除，streaming 领域状态不再双写。
- 新增 fixture、Kernel replay/store/command 测试以及 fake-pi 浏览器基线；阶段 0/1 的实际验证记录见 `docs/TEST_BASELINES.md`。
- 当前仍保留 legacy DOM 视图适配层；React/Vite 不属于本阶段。

### 阶段 D：React 与构建系统升级（已完成，2026-07-22）

- 建立 `src/web/` React/Vite 独立入口，生产构建输出到 `dist/web/`，不清空或覆盖 legacy `public/`。
- 引入 React 19、Vite 8、Tailwind CSS 4、shadcn 风格 UI 基元和六套 React 主题 token。
- Node Server 新增 `/react` → `/react/` 静态入口；Vite dev server 代理 `/api` 与 `/ws`。
- 用 `React.lazy` 验证 dynamic import 和独立 chunk；npm 发布清单包含 React 源码、Vite 配置和 `dist/web`。
- 保持 legacy `/` 默认入口；该阶段的 React Shell 只作为独立基座验收，不复制 Kernel 状态。
- `npm run test:react-smoke`、legacy browser smoke、browser baseline 和 `npm pack --dry-run` 均通过。

### 阶段 E：Contract 治理（已完成，2026-07-22）

- 项目自有 Session、Task、Geo、Bridge、AppError、ModelIdentity 与 RuntimeCapabilities 统一迁入 `src/contracts/`。
- Extension、Server、legacy Web 共用同一协议源码；旧路径保留兼容重导出。
- Task、Geo、Bridge、SessionSnapshot 的合法/非法版本、非法 revision 与 revision regression 使用共享 fixture 验证。
- 保持单 npm 包，不建立 workspace，不包装全部 Pi 原生 event。只有出现独立发布消费者后，才评估提取 `packages/contracts`。

### 阶段 F：React Shell、Feature UI 与平台 UI（已完成，2026-07-22）

- React 通过独立 Composition Root 复用 `WebSocketClient + AppKernel`，组件只订阅外部 Store、调用 Command Port。
- 迁移 Header/Agent Status、Settings、Model Picker、Command Palette、New Session、Extension Dialog、SessionSidebar、Live Tabs 和 Workspace Layout。
- Radix Dialog 统一处理 Portal、焦点圈定/恢复、Esc 与键盘交互；移动端侧栏和 Workspace 分别使用抽屉与全屏布局。
- React smoke 使用真实 Node Server、fake Pi 和 Chrome 验证两任务切换、Extension UI、主题、移动端与 Geo 懒加载边界。
- Conversation、Task Board 与 Geo Workspace 已迁移至 React；Geo Runtime 在有场景的地图页签中按需加载。

### 阶段 G：React 默认入口（已完成，2026-07-22）

- Node Server 默认在 `/` 提供 React SPA，`/react` 兼容重定向到 `/`。
- legacy 静态目录只经 `/legacy/` 提供，用于一个稳定发布周期的回退；两套入口继续独占 DOM subtree。
- React smoke 验证默认入口，legacy browser smoke 与 11/11 browser baseline 验证回退入口；静态路由测试覆盖回退、兼容重定向与安全拒绝。

## 9. 新增跨边界功能的标准流程

以未来的“交通指标图表”为例：

1. 先定义不可执行的结果契约，例如 `TrafficChartEnvelope`，并写契约测试。
2. 在 `extensions/pi-traffic-chart/` 注册 Pi 工具；Extension 只产生契约数据。
3. 需要大数据或私有资源时，在 `src/server/traffic-chart-resources.ts` 实现独立 route adapter；小结果可直接放工具结果。
4. 在 `src/public/features/traffic-chart/` 实现 `WebFeature`，可选注册一个 `WorkspaceView`。
5. 在 `app-main.ts` 的组合区实例化并注册一行，不增加工具名分支和业务渲染逻辑。
6. 测试 Extension、契约、route adapter 和 FeatureRegistry 转发，再做真实浏览器验收。

目录不要求机械一致，但跨边界能力至少应能回答四个问题：Agent 产出什么、服务端保护什么、Web 消费什么、契约由谁测试。

## 10. 框架选择结论

- **现在采用的组织框架**：模块化单体、垂直功能切片、Ports/Adapters。它直接解决 Pi 与 Web 双端适配的耦合，同时不增加部署单元。
- **Web UI 框架**：React 是默认 Web Adapter，已完成 Shell、低耦合平台 UI、Conversation 与 Task/Geo Feature UI；legacy DOM 仅作为 `/legacy/` 的限期回退实现。
- **Web 构建工具**：Vite 已负责 React 源码构建、`dist/web` 产物和开发代理；legacy TypeScript 构建继续使用现有 `tsc` 链路。
- **Server 框架**：不立即迁移 Fastify。其插件封装和作用域依赖模型值得借鉴，但当前 raw Node 服务已有大量稳定路由，替换框架会把治理变成重写。
- **Monorepo/workspaces**：当前不引入。只有共享契约产生第二个独立消费者或独立发布需求时才拆包。

## 11. 变更验收

目录或架构治理必须同时满足：

- `npm run typecheck` 通过。
- `npm test` 无失败；真实 Pi RPC 冒烟测试默认跳过，需另行执行 `npm run test:pi-smoke`。
- `npm run test:react-smoke` 验证默认 `/` 连接、Session 创建/切换、Extension Dialog、焦点/Esc/键盘、主题、移动端布局、`/legacy/` 回退和非 Geo 页面不加载 MapLibre。
- npm 发布清单仍包含 Extension、源码和 GIS 技术方案。
- 编译产物、本地会话与 `.tau` 资源没有进入 Git；`dist/web` 由 Vite 构建并通过 npm 发布清单提供。
- Agent Web 的非地图会话不加载 MapLibre bundle。
- GIS Scene Snapshot 可在 live、历史和 resume 路径恢复；资源型地图的实际数据渲染当前要求 live session，因此只读历史页不作为完整地图验收路径。
