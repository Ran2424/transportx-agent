# Geo 1.1.0 双向空间交互闭环实施方案

> 状态：Proposal / 开发规格
> 日期：2026-09-01
> 目标版本：Geo 1.1.0
> 涉及范围：Geo Extension、Agent Host、Public Kernel、React Workbench

## 1. 决策摘要

本次升级只解决一个问题：让用户、地图与 Agent 之间形成可验证的双向空间交互闭环。

需要同时交付两条链路：

1. 用户在地图上点选、落点、框选或采用当前视野，将空间上下文附到消息；Agent 读取后继续分析。
2. Agent 主动请求用户在地图上完成一次空间输入；用户提交后，结果返回 Agent，Agent 继续执行。

两条链路必须在同一个 Geo 1.1.0 版本完成并联合验收，不再拆成 1.1、1.2、1.3 多阶段路线。只做“地图交互输入”，不把截图、通用空间分析、地图编辑或更复杂选择能力带入本次开发。

## 2. 本期范围

### 2.1 必须交付

| 能力 | 本期结果 |
|---|---|
| Feature 点选 | 用户选择资源型 GeoJSON 中具有稳定标识的要素 |
| Point 落点 | 用户在地图上提供一个 WGS84 坐标 |
| Rectangle 框选 | 用户拖拽得到一个轴对齐矩形范围 |
| Viewport 取景 | 用户把当前地图视野作为空间范围 |
| 上下文附消息 | 地图输入以结构化引用绑定到当前用户消息 |
| Agent 读取上下文 | `inspect_map_context` 按确定性规则读取 |
| Agent 请求输入 | `request_geo_input` 发起并等待一次用户地图输入 |
| 恢复与终态 | 刷新、重连、取消、超时、场景失效均有明确行为 |
| 端到端验收 | 一条真实闭环覆盖用户主动输入与 Agent 反向请求 |

### 2.2 明确不做

以下内容不纳入 Geo 1.1.0，也不在本文设计未来接口：

- 地图截图、截图分析及截图转 Citation；
- 多边形、套索、圆形、自由绘制和混合选择；
- Geo 内置 buffer、nearest、spatial join 等空间计算；
- 地理编码、路线规划、POI 搜索；
- 地图要素编辑、属性编辑和写回数据源；
- 独立的时间上下文模型；
- 上下文历史管理、上下文集合和复杂批量管理 UI；
- 跨桌面应用重启恢复尚未完成的交互请求。

已有 `com.transportx.spatial-analysis` 继续承担通用空间分析；Citation 继续承担证据引用；Session Profile 继续承担时间范围。Geo 不复制这些职责。

## 3. 现有基础与改造边界

项目现有 Geo 能力已经具备：

- Geo 可视化资源与 `visualizationId`；
- GeoJSON inline / resource 两类数据源；
- `sceneRevision` 与图层显隐；
- `Feature.id`、manifest `idField` / `promoteId`；
- React 地图面板、Public Kernel、Bridge Tool 和 Session Snapshot。

因此本次不重建地图渲染系统，只增加四部分：

1. Public Kernel 中可被 React 控制的地图交互端口；
2. Host 持久化的空间上下文与交互请求；
3. React 中的选择、附加与请求响应界面；
4. Agent 可调用的 `inspect_map_context` 和 `request_geo_input`。

能力是否可用，以当前会话实际注册的 Bridge Tool 为准，不扩张全局 `RuntimeCapabilities` 协议。

### 3.1 模块归属与无地图降级

Geo 1.1.0 的业务能力归属 `com.transportx.geo`，但实现不会全部放在该模块目录：

| 层级 | 职责 |
|---|---|
| Geo Module | Skill、Pi Extension、Tool 定义及 Geo 能力版本 |
| 共享 Contracts | Geo Context / Request / Response 的跨进程协议 |
| Agent Host | 会话内校验、持久化、等待器和受控 API |
| Public Kernel / React | 地图选择端口和交互界面 |

共享层只提供惰性的基础设施，不得在 Geo 未激活时主动写入 Prompt、消息或其他上下文。

当前默认 `com.transportx.workbench` 依赖 `com.transportx.geo`，因此 Geo 会随默认 Session Plan 加载；这不等于每个会话都存在地图上下文。需要区分两种情况：

| 情况 | 必须行为 |
|---|---|
| Session Plan 不含 Geo Module | 不加载 Geo Skill/Extension，不注册 Geo Tool，不显示 Geo 交互 UI，Geo API 返回能力不可用 |
| Session Plan 含 Geo，但当前没有 Geo visualization/context/request | Geo 保持静默；不注入任何 Geo Context，不创建目录或 Snapshot 状态，不影响普通消息 |

具体隔离规则：

- `inspect_map_context` 和 `request_geo_input` 必须由 Geo Extension 注册，不能变成全局常驻 Tool；
- Host API 在处理请求前校验当前 Resolved Session Plan 包含 `com.transportx.geo`；
- `request_geo_input` 在目标 visualization 不存在时返回 `geo_not_available`，不得创建 waiting Request；
- 普通消息不带 `geoContextIds` 时，不增加 Geo Prompt 片段或占位数据；
- Session Snapshot 仅在存在 Draft 之外的持久 Geo Context 或 waiting Request 时携带 Geo 交互状态；
- React 只有在当前会话暴露 Geo Tool 或打开 Geo visualization 时挂载相关交互组件；
- Geo 数据只写入当前 Session 的 `.tau/geo-interactions/`，不得写入全局对话状态；
- 禁止以历史最近 Context 作为隐式输入。

## 4. 核心事实模型

| 事实 | 权威来源 |
|---|---|
| 地图内容 | Geo visualization manifest + resource |
| 当前场景版本 | `visualizationId + sceneRevision` |
| 用户本次地图输入 | Geo Context |
| 上下文属于哪条消息 | Message Geo Reference |
| Agent 正在等待什么 | Geo Interaction Request |
| 用户如何结束请求 | Geo Interaction Response |
| 要素身份是否稳定 | resource SHA-256 + Feature ID 策略 |

Geo Context 是一次已提交、不可变的空间输入。未提交的选择仅是浏览器 Draft，不得被 Agent 读取。

## 5. 协议设计

### 5.1 Geo Context

```ts
export type GeoContextMode =
  | "feature"
  | "point"
  | "rectangle"
  | "viewport";

export interface GeoClientContextV1 {
  version: 1;
  contextId: string;
  visualizationId: string;
  sceneRevision: number;
  mode: GeoContextMode;
  createdAt: string;

  view: {
    center: [number, number];
    zoom: number;
    bounds: [number, number, number, number];
    bearing: number;
    pitch: number;
  };

  visibleLayerIds: string[];
  selection?: {
    layerId: string;
    featureIds: Array<string | number>;
  };
  geometry?: GeoJSON.Point | GeoJSON.Polygon;
  summary: string;
}
```

各模式允许的字段固定如下：

| mode | selection | geometry | 空间含义 |
|---|---|---|---|
| `feature` | 必填 | 禁止 | 一组稳定要素引用 |
| `point` | 禁止 | `Point` 必填 | 一个 WGS84 点 |
| `rectangle` | 禁止 | 闭合 `Polygon` 必填 | 一个轴对齐矩形 |
| `viewport` | 禁止 | 禁止 | 使用 `view.bounds` |

一个 Context 只表达一种空间意图。用户需要同时提供“路段 + 范围”时，应附加两个 Context，不使用混合结构。

### 5.2 Host 返回引用

```ts
export interface GeoContextReferenceV1 {
  contextId: string;
  sessionId: string;
  visualizationId: string;
  sceneRevision: number;
  mode: GeoContextMode;
  summary: string;
  createdAt: string;
}
```

消息只保存轻量引用，完整 Context 由 Host 按 `contextId` 读取。

### 5.3 Feature 来源证明

```ts
export interface GeoContextProvenanceV1 {
  sourceKind: "resource";
  geoResourceId: string;
  sha256: string;
  bytes: number;
  idStrategy:
    | { kind: "feature-id" }
    | { kind: "id-field"; field: string };
}
```

Feature 模式仅允许引用 resource-backed GeoJSON，并满足以下任一条件：

- 每个可选要素具有稳定的顶层 `Feature.id`；
- manifest 明确声明 `idField`，且字段值在该图层内唯一。

inline GeoJSON 可以展示，也可以作为 point、rectangle、viewport 的背景，但不得产生长期 Feature 引用。没有稳定标识时，UI 禁用该图层的 Feature 点选，并说明原因。

### 5.4 Agent 交互请求

```ts
export interface GeoInteractionRequestV1 {
  version: 1;
  requestId: string;
  sessionId: string;
  visualizationId: string;
  sceneRevision: number;
  mode: GeoContextMode;
  prompt: string;
  required: boolean;
  targetLayerIds?: string[];
  maxFeatures?: number;
  timeoutSeconds: number;
  status: "waiting";
  createdAt: string;
  expiresAt: string;
}
```

约束：

- 同一 Session 同时最多存在一个 `waiting` 请求；
- `feature` 请求可以限制 `targetLayerIds` 和 `maxFeatures`；
- 其他模式不得携带 Feature 专属字段；
- Request 创建时冻结 `visualizationId + sceneRevision`。

### 5.5 交互响应与终态

```ts
export type GeoInteractionTerminalStatus =
  | "submitted"
  | "cancelled"
  | "expired"
  | "aborted"
  | "invalidated";

export interface GeoInteractionResponseV1 {
  version: 1;
  requestId: string;
  status: GeoInteractionTerminalStatus;
  contextId?: string;
  reason?:
    | "user_cancelled"
    | "timeout"
    | "agent_aborted"
    | "session_closed"
    | "scene_revision_changed"
    | "visualization_changed"
    | "resource_changed";
  completedAt: string;
}
```

终态含义不得混用：

| 状态 | 含义 |
|---|---|
| `submitted` | 用户提交了合法 Context |
| `cancelled` | 用户主动取消 |
| `expired` | 仅表示超时 |
| `aborted` | Agent 中止或 Session 关闭 |
| `invalidated` | 场景版本、地图或资源变化导致请求失效 |

所有终态只能写入一次。

## 6. 硬限制

Host 与前端共同执行以下限制，Host 为最终裁决者：

| 项目 | 限制 |
|---|---|
| 单个 Feature Context 的要素数 | 最多 1,000 |
| 单个请求的 `targetLayerIds` | 最多 32 |
| `visibleLayerIds` | 最多 64 |
| 单条消息关联 Context | 最多 8 |
| Context JSON | 最大 256 KiB |
| `prompt` | 最大 500 字符 |
| `timeoutSeconds` | 30–1,800，默认 600 |
| 坐标系 | WGS84 / EPSG:4326 |
| Rectangle | 轴对齐、五点闭合 Polygon |

经度、纬度、bounds、Polygon 闭合性、字段组合、ID 类型和数组去重均由共享 contract validator 校验。

## 7. Public Kernel 地图交互端口

Geo Runtime 向 Kernel 暴露最小控制面：

```ts
export interface GeoInteractionPort {
  applyAgentSelection(input: {
    layerId: string;
    featureIds: Array<string | number>;
    fit?: boolean;
  }): Promise<void>;

  setLayerVisibility(layerId: string, visible: boolean): Promise<void>;
  setInteractionMode(mode: "browse" | GeoContextMode): void;
  clearUserDraft(): void;
  getUserDraft(): GeoClientContextV1 | null;
  subscribe(listener: (event: GeoInteractionEvent) => void): () => void;
  fitToData(): void;
  resize(): void;
  destroy(): void;
}
```

四种模式行为：

- `feature`：点击稳定要素；支持追加和移除；达到上限后停止追加并提示。
- `point`：单击生成一个 Point；再次单击替换。
- `rectangle`：拖拽生成矩形；再次拖拽替换。
- `viewport`：读取当前 bounds，生成可提交 Draft，不启动绘制。

地图要区分以下状态，避免样式相互覆盖：

- `selectedByAgent`
- `selectedByUser`
- `selectedForRequest`
- `hovered`

Agent 选中结果只用于展示，不自动成为用户输入。用户必须显式点击“附到对话”或“提交”。

任意 `sceneRevision` 变化后，当前 Draft 立即变为 stale，不允许继续提交。

## 8. React 交互

### 8.1 地图工具条

桌面端工具条保持单行：

```text
[地图 / rev] [浏览] [点选] [点位] [框选] [当前视野] [清除] [回到范围] [附到对话]
```

移动端可折叠，但保留相同能力。工具条不加入截图、自由绘制或空间分析入口。

### 8.2 Context Tray

地图下方显示当前 Draft：

- 模式；
- 要素数量或坐标/范围摘要；
- 数据图层；
- 场景版本；
- “清除”和“附到对话”。

Draft 未通过校验时，“附到对话”不可用，并显示具体原因。

### 8.3 Composer 引用

附加成功后，Composer 显示 Geo Context chip：

- 每个 chip 对应一个 `contextId`；
- 最多 8 个；
- 可以单独移除；
- 发送消息时与消息一起提交；
- 发送失败时保留，发送成功后清空；
- 不把大段 geometry 或 feature IDs 展开到输入框。

### 8.4 Agent 请求界面

收到 `waiting` Request 后：

- 地图上方显示固定请求条，展示 Agent 提示、模式与剩余时间；
- 自动切换到请求指定模式；
- Feature 模式只允许目标图层；
- “提交”使用当前合法 Draft；
- “取消”产生 `cancelled`；
- 场景失效时结束请求并显示原因，不静默重开；
- Request 结束后恢复普通浏览模式。

键盘用户可以切换模式、清除、提交和取消；焦点顺序、状态提示和颜色对比遵循现有主题与可访问性规范。

## 9. Host 持久化与接口

### 9.1 会话目录

```text
.tau/geo-interactions/
  contexts/
    <contextId>/
      context.json
      provenance.json
  requests/
    <requestId>/
      request.json
      response.json
  message-refs.json
```

写入采用临时文件 + rename。所有路径沿用现有 Session workspace 边界与 POSIX 磁盘序列化规则。

### 9.2 Browser API

```text
POST /api/sessions/:sessionId/geo-contexts
GET  /api/sessions/:sessionId/geo-contexts/:contextId
POST /api/sessions/:sessionId/geo-interactions/:requestId/respond
```

`POST geo-contexts` 的处理顺序固定：

1. 校验 Session、visualization 和 revision；
2. 校验 Context schema 与模式字段组合；
3. Feature 模式校验 resource、SHA-256 和 ID 策略；
4. 校验全部上限；
5. 写入不可变 Context 与 provenance；
6. 返回 `GeoContextReferenceV1`。

客户端传入的 `summary` 仅用于显示。Agent 工具的结构化输出由 Host 从已验证数据生成，不能信任客户端摘要。

### 9.3 消息关联

发送消息时，Browser 同时提交 `geoContextIds`。Host 在落盘前验证：

- Context 属于当前 Session；
- Context 存在且未损坏；
- Context 数量未超限；
- Context 与当前消息引用关系尚未写入。

Host 保存 message → contextIds 映射，并把当前用户 turn 的 Context IDs 注入本轮 Agent 上下文。历史 Context 不自动继承到下一条消息。

## 10. 上下文解析规则

`inspect_map_context` 只允许以下优先级：

1. 工具参数显式传入的 `contextIds`；
2. 当前活动用户消息携带的 `geoContextIds`；
3. 均不存在时返回 `no_geo_context`。

禁止回退到“Session 最近一次 Context”。这会把历史位置误当成当前输入，尤其在多轮对话和多个地图并存时不可控。

当一条消息附有多个 Context 时，工具返回全部 Context，不做隐式合并。Agent 应根据模式分别解释。

## 11. Agent 工具

### 11.1 `inspect_map_context`

```ts
{
  contextIds?: string[];
  maxFeatures?: number;
  includeProvenance?: boolean;
}
```

输出包含：

- 解析来源：`explicit | active_prompt`；
- visualization 与 revision；
- view、visible layers；
- 每个 Context 的 mode 与结构化内容；
- Feature 的稳定 ID 和必要的受控属性；
- provenance；
- truncation 信息。

工具不得绕过数量限制，也不得自动读取未绑定消息的历史 Context。

### 11.2 `request_geo_input`

```ts
{
  visualizationId: string;
  sceneRevision: number;
  mode: "feature" | "point" | "rectangle" | "viewport";
  prompt: string;
  required?: boolean;
  targetLayerIds?: string[];
  maxFeatures?: number;
  timeoutSeconds?: number;
}
```

调用流程：

1. Host 验证当前地图与 revision；
2. 创建并持久化 `waiting` Request；
3. Session Snapshot 和事件流通知 Browser；
4. 工具异步等待 Response；
5. `submitted` 时返回完整 Context；
6. 其他终态返回明确状态与 reason。

工具不是一次性长轮询 HTTP。等待器由 Session 服务管理，浏览器断线不终止等待。

## 12. 请求状态机

```text
waiting
  ├─ user submit valid context ─────────> submitted
  ├─ user cancel ───────────────────────> cancelled
  ├─ timeout ───────────────────────────> expired
  ├─ agent abort / session close ───────> aborted
  └─ scene / visualization / resource change -> invalidated
```

实现要求：

- Request 与 Response 落盘后再发布事件；
- 一个 Request 只接受一个终态；
- 重复响应返回已有结果，不重复创建 Context；
- 等待器优先使用进程内事件，文件监听只承担恢复；
- 必要时使用低频轮询兜底，不使用高频轮询；
- Session Snapshot 包含当前 `waiting` Request。

## 13. 刷新与恢复

本期保证以下情况可恢复：

- Browser 页面刷新；
- React Renderer reload；
- WebSocket 断开后重连；
- 用户切换 Session 后返回；
- 等待期间地图组件重新挂载。

恢复规则：

1. Browser 从 Session Snapshot 读取当前 `waiting` Request；
2. 重新打开对应 visualization；
3. revision 一致时恢复指定模式；
4. revision 不一致时提交 `invalidated`；
5. 已完成的历史 Request 只显示结果，不重新进入交互模式。

本期不承诺 Agent/Pi 进程或桌面应用完全退出后的等待调用续接。Session 被关闭时，请求进入 `aborted(session_closed)`。

## 14. Revision 一致性

V1 采用严格策略：

- Context 创建时冻结 `visualizationId + sceneRevision`；
- Request 创建时冻结同一组合；
- 任意 revision 变化使现有 Draft stale；
- 任意 revision 变化使 `waiting` Request 进入 `invalidated`；
- 不推断“新旧场景看起来兼容”；
- 已落盘 Context 保留为历史事实，但不能伪装成新 revision 的输入。

严格失效比兼容推断更容易解释、测试和审计。

## 15. Agent 使用规则

Geo Skill 与系统提示词需要加入以下规则：

- 用户消息带 Geo Context 时，先调用 `inspect_map_context`；
- 需要用户指出位置、要素或范围时，调用 `request_geo_input`；
- 不要求用户手工输入可由地图选择得到的经纬度；
- `cancelled`、`expired`、`aborted`、`invalidated` 必须分别处理；
- Agent 高亮不等于用户确认；
- 多个 Context 分别解释，不自动做空间并集或交集；
- 需要 buffer、nearest、join 时调用 Spatial Analysis capability，不转嫁给 Geo。

## 16. 代码改动范围

预计只涉及：

```text
src/contracts/
  geo.ts
  bridge.ts
  session.ts

src/public/
  geo runtime / kernel store

src/server/
  session snapshot
  geo context service
  geo interaction service
  bridge tools
  browser api

src/web/
  Geo panel
  Context Tray
  Composer chips
  request banner

modules/
  Geo capability manifest / skill / extension

test/
  contracts
  runtime
  host
  web e2e
```

实现时如修改 Geo Module，必须按项目纪律提升 manifest minor 版本到 1.1.0，并更新 `docs/CHANGELOG.md`。本文仅是方案修订，不提前修改模块版本。

## 17. 单版本实施顺序

以下是同一个 1.1.0 版本内的内部开发顺序，不是分期发布：

1. **共享契约**
   定义 Context、Request、Response、限制和 validator。
   验证：契约测试覆盖合法值、非法字段组合与全部上限。

2. **Host 持久化**
   实现 Context/Request/Response 原子落盘和消息关联。
   验证：重启 Session 服务后可读取已落盘事实。

3. **Geo Runtime**
   实现四种模式、Draft、状态样式与严格 revision 失效。
   验证：Runtime 单测覆盖模式切换、选择和清理。

4. **Browser 与 Composer**
   实现工具条、Context Tray、chip 和消息绑定。
   验证：主动选择可以随消息提交，发送失败不丢引用。

5. **`inspect_map_context`**
   实现显式/当前消息两级解析。
   验证：不存在上下文时返回 `no_geo_context`，不读取历史最近值。

6. **`request_geo_input`**
   实现请求发布、等待器、响应和五类终态。
   验证：提交、取消、超时、中止、失效均能解除等待。

7. **恢复**
   将 waiting Request 纳入 Session Snapshot。
   验证：刷新和 WebSocket 重连后恢复同一个请求，不生成重复请求。

8. **端到端门禁**
   跑通完整闭环和异常路径。
   验证：满足第 19、20 节后才允许发布。

## 18. 测试要求

### 18.1 契约

- 四种 mode 的字段矩阵；
- 经纬度、bounds、Polygon 闭合；
- feature ID 类型、唯一性与上限；
- Context、Request、Response 大小和状态；
- 所有终态 reason；
- 旧客户端提交未知 mode 时被拒绝。

### 18.2 Runtime

- Feature 追加、移除、上限；
- Point 替换；
- Rectangle 重绘；
- Viewport 捕获；
- Agent/User/Request/Hover 状态隔离；
- revision 变化使 Draft stale；
- destroy 后无残留 listener。

### 18.3 Host 与工具

- Session Plan 不含 Geo 时不注册 Tool，API 返回能力不可用；
- Session 含 Geo 但没有地图事实时，不产生 Prompt、消息或 Snapshot 污染；
- visualization 不存在时 `request_geo_input` 返回 `geo_not_available`，不创建请求；
- resource SHA 与稳定 ID 校验；
- inline Feature 引用被拒绝；
- message → contextIds 绑定；
- `inspect_map_context` 的确定性优先级；
- 不存在 Session 最近值回退；
- 同 Session 单 waiting Request；
- 终态幂等；
- Session 关闭触发 aborted；
- 场景与资源变化触发 invalidated；
- Snapshot 恢复 waiting Request。

## 19. 唯一主验收场景

必须用真实 Node 服务、fake Pi 和浏览器自动化跑通：

1. Agent 生成带稳定 Feature ID 的资源型 Geo 可视化；
2. 用户在地图选择两个路段；
3. 用户把 Feature Context 附到消息并发送；
4. Agent 调用 `inspect_map_context`，准确读到两个路段；
5. Agent 调用 `request_geo_input(mode=rectangle)`，请求用户补充分析范围；
6. 浏览器进入框选模式并展示请求条；
7. 用户框选并提交；
8. Agent 收到 Rectangle Context；
9. Agent 基于两类 Context 继续分析，并生成新的地图结果；
10. 新地图可正常打开，旧 Context 仍可审计。

这条场景必须连续完成，中间不得依靠用户复制坐标、手改 JSON 或刷新才能继续。

## 20. 异常验收

发布前至少覆盖：

- 没有稳定 ID 的图层不能进入 Feature 点选；
- 超过 1,000 个要素被前后端共同阻止；
- 消息最多附加 8 个 Context；
- 页面刷新后 waiting Request 恢复；
- WebSocket 重连不产生第二个 Request；
- 用户取消返回 `cancelled`；
- 超时返回 `expired`；
- Session 关闭返回 `aborted`；
- revision 变化返回 `invalidated`；
- 重复提交同一 Request 不产生第二个 Context；
- 未显式传参且当前消息无 Context 时返回 `no_geo_context`；
- 历史最近 Context 不会被误读。
- 纯文本会话连续多轮交互后，不产生 Geo Context、Request 或消息引用。

## 21. 完成定义

Geo 1.1.0 只有同时满足以下条件才算完成：

- 四种输入模式全部可用；
- 用户主动输入和 Agent 反向请求形成闭环；
- Context 与消息有稳定、可审计的关联；
- 无地图时 Geo 保持静默，不改变普通消息上下文；
- Feature 引用仅来自已校验的资源型数据；
- `inspect_map_context` 无隐式最近值回退；
- 五类终态可区分、可恢复、可测试；
- revision 变化严格失效；
- 主验收场景与异常验收全部通过；
- Geo Module 版本、Resolved Session Plan 和 CHANGELOG 同步；
- `npm run typecheck`、`npm test`、`npm run test:web` 通过。

本方案的交付边界到此为止。范围外能力只有在 1.1.0 实际使用反馈证明必要后，才另行立项。
