# TransportX Traffic Agent 最终代码优化与架构整理审阅意见

## 1. 整体结论

当前项目整体架构是健康的，核心设计不需要推翻。

现有的几个基础决策应继续保持：

- `src/contracts/` 作为跨进程、跨层共享协议的唯一权威来源；
- Electron Main 只负责生命周期和桌面集成，不承载业务逻辑；
- Browser Kernel 与 React 展示层分离；
- React 不直接理解原始 Pi RPC；
- HTTP RPC 负责命令，WebSocket 负责事件；
- `conversation-store.ts` 的 Snapshot + Live Overlay 状态模型继续保留；
- Geo、Video、Citation 等领域资源在服务端继续保持独立，不建设通用 Resource Framework；
- Module 继续作为能力安装和冻结的核心单元。

本轮优化的主要目标不是增加新的安全机制，也不是为了减少文件数量而重构，而是：

> **删除无效抽象和历史冗余，合并重复逻辑，恢复已经存在但被部分新代码绕过的架构边界，并为未来 Geo、Video、Report、Chart、Table 等 Agent 能力建立稳定的扩展位置。**

目前最明显的扩展压力集中在：

```text
server-main.ts
sessions.ts / PiRpcSession
ConversationWorkspace.tsx
App.tsx
```

另外，Geo / Video 已经证明项目需要一个比“独立面板”更高层的展示模型。

因此，本轮整理建议围绕以下几类问题开展。

---

# 2. 无效代码、历史兼容层与仓库冗余问题

当前存在少量已经失去实际价值的兼容入口、无引用 export 和重复资产。

这类内容会制造额外认知成本，也容易让后续开发者误判哪些才是权威入口。

## 优化建议

### 1. 删除未使用品牌资产

处理：

```text
public/icons/TX_LOGO.zip
public/icons/TX_LOGO/
```

执行步骤：

1. 全仓确认无运行时、Electron packaging、installer、build config 引用。
2. 确认实际图标来源仍为：

```text
src/web/assets/x-icon.svg
```

3. 删除 ZIP 与解压目录。
4. 重新执行桌面构建和图标 smoke test。

设计源文件如果仍需保存，应转移至设计资源仓库或发布附件，不应继续进入生产 npm / Electron 包。

---

### 2. 删除 `task-state.ts` re-export shim

当前：

```text
modules/capabilities/task/extensions/pi-task-mode/task-state.ts
```

仅重新导出：

```text
src/contracts/task.ts
```

而生产代码已经直接使用正式 contract。

建议：

1. 将唯一测试改为直接 import：

```text
src/contracts/task.ts
```

2. 删除 `task-state.ts`。
3. 明确：

```text
src/contracts/task.ts
```

是 Task contract 的唯一权威入口。

避免长期存在两套等价导入路径。

---

### 3. 清理无仓内引用的 contracts export

重点包括已经识别出的：

```text
JsonPrimitive
asOptionalText
CONTRACT_PACKAGE_VERSION
SchemaVersion
*VersionIsSupported
revisionRegressionDiagnostic
asNumberIfPresent
部分 namespace 常量
部分 value | null wrapper
```

处理原则：

1. 使用 `rg` 再确认仓内无引用。
2. 如果 contracts 只是项目内部协议，直接删除。
3. 如果 contracts 存在仓外 consumer，则先 deprecated，在后续 major release 删除。
4. 连同只服务这些 export 的注释、helper 和测试一起收缩。

目标不是缩短 contracts，而是让 contracts 只表达**真实存在的协议和解析行为**。

---

# 3. 重复纯逻辑与展示格式化问题

当前部分 UI 对同一个领域对象存在重复解释逻辑。

这种重复规模目前不大，但会导致后续 Model UI、Citation UI 等逐渐出现不同展示规则。

## 优化建议

### 1. 合并两个 Model `normalizeModel`

涉及：

```text
src/web/platform/model/ModelPickerDialog.tsx
src/web/platform/sessions/NewSessionDialog.tsx
```

两边当前重复处理：

```text
model display name
provider
capability labels
context metadata
展示文本
```

建议合并到：

```text
src/web/lib/formatting.ts
```

形成唯一函数，例如：

```ts
normalizeModelForDisplay(...)
```

或：

```ts
formatModelOption(...)
```

之后所有 Model Picker 都复用这一层。

---

### 2. 将纯展示规则与 React Component 分离

如果组件中还存在重复的：

```text
context window formatting
capability labels
provider/model display name
metadata 拼接
```

继续移动到 `formatting.ts`。

目标结构：

```text
Model Contract
      ↓
统一 Formatting
      ↓
ModelPickerDialog
NewSessionDialog
未来其他 Model UI
```

不要让多个 React Component 各自重新理解同一个 Contract。

---

# 4. 模型配置 CRUD 重复问题

当前新增的模型编辑功能中：

```text
add
update
delete model
delete provider
```

各自重复读取、解析和判断：

```text
models.json
providers
modelOverrides
```

这会让以后修改 `models.json` 格式时，需要同步修改多个持久化分支。

## 优化建议

### 1. 建立唯一 `readModelsConfig(agentDir)` 入口

在：

```text
src/server/pi-model-config.ts
```

增加统一私有函数：

```ts
readModelsConfig(agentDir)
```

统一负责：

```text
定位 models.json
→ 读取
→ JSON.parse
→ 校验 shape
→ 标准化 providers
→ 返回标准配置对象
```

之后所有 CRUD 都只能通过这个入口读取配置。

---

### 2. 收口 Provider 读取

避免每一个操作都出现：

```ts
const parsed = JSON.parse(...)
const providers = parsed.providers ?? {}
```

可以让：

```ts
readModelsConfig()
```

直接返回：

```ts
{
  path,
  config,
  providers
}
```

或者建立明确的：

```ts
getProviders(config)
```

---

### 3. Add / Update 共用 `modelPatch`

如果 Add 与 Update 当前分别构造相似 Model Definition，建议统一成：

```text
base model definition
        +
modelPatch
        ↓
final model definition
```

形成：

```ts
applyModelPatch(base, patch)
```

Add：

```text
default model + patch
```

Update：

```text
existing model + patch
```

这样以后增加：

```text
capabilities
context metadata
model options
```

只需维护一套 patch 语义。

---

### 4. 重命名生产环境正在使用的 Test Hook

如果生产代码正在调用：

```ts
_clearModelListCacheForTest()
```

应改成：

```ts
invalidateModelListCache()
```

测试继续调用正式 API。

不要让实际的运行时缓存生命周期动作继续使用 Test-only 命名。

---

# 5. Server 小型公共逻辑重复问题

Geo、Video、Citation 在服务端存在少量相同基础动作。

这里应该只合并**明确相同的基础逻辑**，不应该抽象三个领域资源本身。

## 优化建议

### 1. 统一 JSON Response Writer

涉及：

```text
geo-resources.ts
video-resources.ts
citation-resources.ts
```

将重复的：

```text
sendJson
writeJson
json
```

收口到例如：

```text
src/server/http/response.ts
```

提供：

```ts
writeJson(res, status, body)
```

统一：

```text
status code
Content-Type
nosniff
JSON.stringify
```

---

### 2. 合并 Session Service Token 解析

当前：

```text
Citation
Spatial
Video
```

都存在：

```text
解析 session
→ 找 live session
→ 取得对应 service token
→ 校验
```

建议定义：

```ts
type SessionService =
  | "citation"
  | "spatial"
  | "video";
```

并提供：

```ts
resolveServiceSession(service, ...)
```

以后增加新 session-scoped service 时，不需要继续复制：

```text
resolveCitationSession
resolveVideoSession
resolveSpatialSession
```

---

### 3. 不合并 Geo / Video / Citation Resource Handler

应该继续保留：

```text
geo-resources.ts
video-resources.ts
citation-resources.ts
```

因为三者在：

```text
缓存
Range
资源生命周期
内容完整性
预览
业务语义
```

上存在真实差异。

因此本轮只统一：

```text
writeJson
service session resolution
其他完全相同的小型 helper
```

不建设：

```text
GenericResourceFramework
UniversalResourceHandler
```

---

# 6. Agent 工作内容展示模型分散问题

这是对原有 Geo / Video 优化意见最重要的一次升级。

当前 Geo 和 Video 是独立的特殊 Workspace。

如果以后继续增加：

```text
Report
Chart
Table
Image
Browser
Document Preview
```

按照现有方式，`App.tsx` 很可能继续出现：

```text
mapOpen
videoOpen
reportOpen
chartOpen
...
```

同时新增：

```text
openedMapKey
openedVideoKey
openedReportKey
大量 useEffect
```

这不是长期可扩展的工作区模型。

建议引入一个统一的：

# `AgentCanvas`

它表示：

> **Agent 可以向一个持续存在的工作画布中发布可独立查看、切换和交互的工作成果。**

Geo 和 Video 成为 Canvas 的两种 Renderer，而不是两个顶层特殊面板。

---

## 优化建议

### 1. 定义统一 `CanvasItem`

第一阶段只覆盖现有能力：

```ts
type CanvasItemKind =
  | "geo"
  | "video";
```

定义基础结构：

```ts
interface CanvasItemBase {
  id: string;
  kind: CanvasItemKind;
  title?: string;
  resourceId: string;
  revision: number;
}
```

具体类型使用 discriminated union：

```ts
interface GeoCanvasItem extends CanvasItemBase {
  kind: "geo";
}

interface VideoCanvasItem extends CanvasItemBase {
  kind: "video";
}

type CanvasItem =
  | GeoCanvasItem
  | VideoCanvasItem;
```

以后可以自然扩展：

```text
report
table
chart
image
document
```

---

### 2. Canvas Item 只描述展示关系，不承载完整资源内容

不要把：

```text
GeoJSON
Video Blob
PDF
完整 Report 数据
```

塞入 `CanvasItem`。

Canvas Item 只负责：

```text
id
kind
title
resource reference
revision
少量展示状态
```

真正的资源继续由：

```text
Geo Resource API
Video Resource API
Report Resource API
```

分别管理。

明确：

```text
Presentation Model
≠
Resource Model
```

---

### 3. 建立 `AgentCanvas`

建议结构：

```text
AgentCanvas/
  AgentCanvas.tsx
  CanvasHeader.tsx
  CanvasTabs.tsx
  CanvasRenderer.tsx
  canvas-registry.ts

  renderers/
    GeoCanvasRenderer.tsx
    VideoCanvasRenderer.tsx
```

`AgentCanvas` 本身只负责：

```text
当前有哪些 Canvas Items
当前激活哪一个
打开/关闭
切换
标题
展示容器
Renderer 分发
```

不理解 Geo 或 Video 的业务细节。

---

### 4. 保留 `GeoWorkspace` 与 `VideoWorkspace`

不要把两个领域组件强行合并。

结构应该变成：

```text
AgentCanvas
    ↓
CanvasRenderer
    ├─ GeoCanvasRenderer
    │      ↓
    │  GeoWorkspace
    │
    └─ VideoCanvasRenderer
           ↓
       VideoWorkspace
```

统一的是：

```text
承载方式
生命周期
激活模型
工作区入口
```

而不是：

```text
Geo 业务
Video 业务
```

---

### 5. 使用 Renderer Registry

不要让 `AgentCanvas` 最终形成新的巨大 `if`：

```tsx
if (item.kind === "geo") ...
if (item.kind === "video") ...
```

建立：

```ts
const canvasRenderers = {
  geo: GeoCanvasRenderer,
  video: VideoCanvasRenderer,
};
```

未来增加：

```text
report
chart
table
```

只增加 Renderer 和 Registry Entry。

这样“新的展示类型”就成为一个真正稳定的扩展维度。

---

### 6. Canvas Store 使用 `items[] + activeItemId`

不要只保存一个当前资源。

建议第一版就使用：

```ts
interface CanvasState {
  items: CanvasItem[];
  activeItemId: string | null;
  isOpen: boolean;
}
```

因为一次 Agent 工作流完全可能同时产生：

```text
地图
视频
报告
```

即使第一版 UI 暂时不展示 Tabs，内部状态也应该支持多个 Item。

---

### 7. 替换 `mapOpen / videoOpen`

将现在 App 层的：

```text
mapOpen
videoOpen
openedMapKey
openedVideoKey
相关 useEffect
```

逐渐收敛为：

```text
CanvasStore
```

操作统一成：

```text
UPSERT_ITEM
ACTIVATE_ITEM
REMOVE_ITEM
OPEN_CANVAS
CLOSE_CANVAS
```

以后增加新能力不再增加新的顶层 boolean。

---

### 8. Agent 的语义逐渐从“打开地图”升级为“发布 Canvas Item”

当前已有 Spatial / Video Event 可以先继续保留。

第一阶段：

```text
spatial event
    ↓
Kernel Canvas Projection
    ↓
Geo CanvasItem
```

```text
video event
    ↓
Kernel Canvas Projection
    ↓
Video CanvasItem
```

不需要立即修改 Pi ↔ Server 协议。

等 Canvas 模型稳定以后，再考虑逐渐加入：

```text
canvas_item_published
canvas_item_updated
canvas_item_removed
canvas_item_focus_requested
```

这样的通用 presentation event。

---

### 9. Task 暂时不进入 Canvas

Task 与 Geo / Video 的语义不同。

建议仍然：

```text
Workbench
 ├─ Conversation
 ├─ AgentCanvas
 │   ├─ Geo
 │   ├─ Video
 │   ├─ Future Report
 │   └─ Future Chart
 │
 └─ Tasks
```

Task 属于：

```text
Workflow / Execution State
```

而 Canvas Item 属于：

```text
Agent Artifact / Presentation
```

暂时不要为了统一而把二者合并。

---

### 10. Citation 只在独立展示时进入 Canvas

普通 Citation 继续属于 Conversation。

但：

```text
打开 PDF
查看引用文档第 N 页
独立浏览报告
```

这类内容未来可以通过：

```text
document CanvasItem
```

进入 Canvas。

判断原则：

> 需要一个独立、持续、可切换的工作展示面的 Agent Artifact，才进入 AgentCanvas。

---

# 7. React 组件绕过 Kernel Command Ports 问题

目前：

```text
ConversationWorkspace.tsx
FilePreview.tsx
VideoWorkspace.tsx
```

存在直接 `fetch()`。

这不只是网络调用重复，而是在项目中产生了第二条前端数据访问路径。

## 优化建议

### 1. 建立 Citation Commands

在 Kernel 增加：

```text
citation.list
citation.preview
```

复用已有：

```text
httpJson
HttpClient
toAppError
```

---

### 2. 合并 Citation Candidate 生成

当前 CitationManager 与 Composer 存在重复：

```text
获取 citations
→ 转换
→ 构造 candidate
```

建议建立唯一：

```ts
getCitationCandidates(...)
```

React 只消费标准化候选对象。

---

### 3. 建立 Video Commands

将：

```text
VideoWorkspace.tsx
```

中的 metrics 请求迁入：

```text
commands.video
```

---

### 4. Report / File Preview 同样走 Kernel

将：

```text
FilePreview.tsx
/api/reports/pdf/download
```

等调用移动到已有或新增的 Kernel Command Port。

---

### 5. React Component 最终只处理 UI

目标：

```text
React
  ↓
Kernel Commands
  ↓
HTTP
  ↓
Server
```

不再出现：

```text
React
  ↓
fetch()
  ↓
Server
```

这与 AgentCanvas 也应保持一致：

```text
AgentCanvas Renderer
        ↓
Kernel command / store
        ↓
对应资源服务
```

---

# 8. `server-main.ts` 组合根职责膨胀问题

当前 `handleRpcCommandOnce()` 已经形成巨型命令分发：

```text
auth
model CRUD
module
session
attachment
export
...
```

这与项目已有的：

```text
server-main.ts 只做组合
```

规约不一致。

## 优化建议

### 1. 将 RPC Command 改为 Handler Registry

先不移动文件，只将巨大 if/switch 改成：

```ts
const rpcHandlers = {
  add_model: {
    native: true,
    handle: handleAddModel,
  },

  set_session_name: {
    native: false,
    handle: handleSetSessionName,
  },
};
```

---

### 2. Native Command Whitelist 由 Registry 派生

删除：

```text
命令实现一处登记
native whitelist 另一处登记
```

改成：

```text
type
handler
native
```

只存在于同一 registration。

---

### 3. 再按领域拆 Handler

建议逐步形成：

```text
src/server/rpc-handlers/
  auth.ts
  model.ts
  module.ts
  session.ts
  workspace.ts
```

每个领域可以导出自己的 registry：

```text
modelRpcHandlers
moduleRpcHandlers
sessionRpcHandlers
```

最后组合：

```text
rpcHandlers = {
  ...modelRpcHandlers,
  ...moduleRpcHandlers,
  ...sessionRpcHandlers
}
```

---

### 4. `server-main.ts` 最终只保留装配

最终只应该看到：

```text
load config
create managers
create rpc registry
create routes
create websocket
create server
listen
```

不再直接实现：

```text
如何编辑 model
如何安装 module
如何设置 session name
如何 export
```

---

# 9. `PiRpcSession` 职责过多问题

当前 `PiRpcSession` 同时承担：

```text
RPC Transport
pending command
timeout
Pi Event State
Capability
Diagnostics
Service Token
Timing
Attachment
Title
Projection
```

这已经成为服务端最大的扩展热点之一。

不建议一次重写，建议逐步抽离。

## 优化建议

### 1. 先统一 `serviceTokens`

将：

```text
citationToken
spatialToken
videoToken
```

收敛为：

```ts
Partial<Record<SessionService, string>>
```

与前面的：

```ts
SessionService =
  "citation" |
  "spatial" |
  "video"
```

共用。

以后新增 Session Service 只扩类型，不再增加一个实例字段。

---

### 2. 抽出 `SessionCapabilityTracker`

将：

```text
bridge envelope
capabilities
diagnostics
schema/version
capability negotiation
```

移动到：

```text
session-capability-tracker.ts
```

让其保持：

```text
纯状态
+
纯逻辑
```

不要让它知道 Child Process、WebSocket 和 Filesystem。

---

### 3. 抽 Session Pure Helpers

优先迁移：

```text
title inference
attachment context strip
event formatting
duration helper
projection helper
```

尤其是：

```text
输入 → 输出
```

的逻辑，不应该继续埋在 Process Session Class 中。

---

### 4. 最后抽 `PiRpcTransport`

只负责：

```text
spawn
stdin/stdout
JSON line parsing
request id
pending command
timeout
process exit
```

不理解：

```text
citation
title
capability
conversation
UI projection
```

最终结构建议：

```text
PiRpcTransport
      ↓
SessionRuntime / PiRpcSession
      ↓
LiveSessionManager
```

---

# 10. Session 快变状态与慢变状态混合问题

当前：

```text
handleEvent()
→ broadcastUpdated()
→ metadata()
```

在大量流式事件中不断重新构造完整 Session Metadata。

更重要的是，这说明：

```text
Snapshot State
Live State
```

在服务端没有完全区分。

## 优化建议

### 1. 将 Metadata 拆成 Snapshot 与 Live State

例如：

```text
SessionSnapshot
SessionLiveMetadata
```

---

### 2. Slow-changing 信息只进入 Snapshot

例如：

```text
resolvedSessionPlan
module metadata
asset path
hash
部分 capability definition
```

主要用于：

```text
session 创建
首次加载
client reconnect
```

---

### 3. Live State 只保留实时观察字段

例如：

```text
isStreaming
contextUsage
sessionName
status
```

---

### 4. `broadcastUpdated()` 改为 Only-on-change

从：

```text
每个 event
→ full metadata broadcast
```

变成：

```text
event
→ update state
→ live observable state 是否变化
→ broadcast
```

如果仍有高频字段，再增加轻量 coalesce。

重点不是简单加 throttle，而是明确：

```text
Snapshot
≠
Live Overlay
```

与 Browser Kernel 当前健康的状态模型保持一致。

---

# 11. Attachment Context 跨进程协议重复问题

当前附件上下文 marker 在：

```text
session-attachments.ts
sessions.ts
conversation-store.ts
```

分别硬编码。

它本质上已经是跨 Server / Kernel Contract。

## 优化建议

### 1. 下沉到：

```text
src/contracts/attachments.ts
```

统一定义：

```text
ATTACHMENT_CONTEXT_BEGIN
ATTACHMENT_CONTEXT_END
stripAttachmentContext()
```

如果 Build 函数也是纯协议逻辑，也可以一起收口。

---

### 2. 删除各层自己的 marker / regex

所有 Server 与 Kernel 代码引用 contract。

目标：

```text
一个协议
一个定义
多处消费
```

避免以后修改格式需要同步三个实现。

---

# 12. `ConversationWorkspace.tsx` 职责膨胀问题

当前该组件同时承担：

```text
message rendering
sanitizer
tool card
citation
composer
attachments
```

问题与 `PiRpcSession` 类似：

> 新功能默认继续进入这个热点文件。

## 优化建议

### 1. 先迁移 Citation

建议：

```text
conversation/
  citation/
    CitationManager.tsx
    CitationPicker.tsx
    citation-formatting.ts
```

---

### 2. 再拆 Composer

建议：

```text
conversation/
  composer/
    Composer.tsx
    ComposerAttachments.tsx
```

统一：

```text
input
submit
citation insert
attachment input
```

---

### 3. 抽 Tool Card

建议：

```text
conversation/
  tool-card/
```

迁移：

```text
toolLabel
toolIconName
truncateToolText
tool rendering
```

---

### 4. Sanitizer 独立成纯逻辑文件

例如：

```text
conversation/sanitize-html.ts
```

继续保留当前 Markdown Renderer + Sanitizer 的纵深结构，不需要更换技术栈。

---

### 5. `ConversationWorkspace` 最终变成组合组件

最终只负责：

```text
ConversationMessages
ConversationComposer
Citation UI
相关布局
```

而不再直接理解：

```text
citation API
tool formatting
attachment protocol
HTML whitelist
```

---

# 13. Attachment 状态旁路问题

当前存在：

```ts
window.dispatchEvent(
  new Event("transportx-attachments-changed")
)
```

这相当于在 Kernel Store 之外建立了另一套状态通知通道。

## 优化建议

### 1. 将 Attachment State 放入现有 Store

优先考虑：

```text
conversation store
```

或现有最合适的 session state。

---

### 2. UI Action 直接更新 Store

上传成功：

```text
attachmentAdded(...)
```

WorkspaceDock 等消费者使用 selector / subscription。

统一成：

```text
Server Event / UI Action
          ↓
Kernel Store
          ↓
React
```

删除：

```text
React A
→ window event
→ React B
```

---

# 14. Workbench 面板状态扩展性问题

当前：

```text
mapOpen
videoOpen
tasksOpen
openedMapKey
openedVideoKey
多个 useEffect
```

随着能力增加，会持续膨胀。

其中 Geo / Video 应主要由 AgentCanvas 接管。

## 优化建议

### 1. Geo / Video 不再作为独立顶层布尔状态

迁移为：

```text
CanvasStore
items[]
activeItemId
isOpen
```

---

### 2. 顶层 Workbench 只保留真正不同类型区域

建议概念：

```text
Workbench
 ├─ Conversation
 ├─ AgentCanvas
 └─ Tasks
```

如果未来还有完全不同的工作区，再由 Workbench State 管理。

---

### 3. 对剩余 Panel State 使用 Reducer

不要继续增加：

```text
xxxOpen
openedXxxKey
useEffect
```

将：

```text
OPEN
CLOSE
AUTO_OPEN
USER_CLOSE
```

表达为显式 action。

---

# 15. Session History 读取职责与 HTTP Handler 耦合问题

当前历史会话列表与搜索逻辑直接理解 JSONL 存储结构。

后续如果增加缓存、索引或迁移格式，会继续扩大 handler。

## 优化建议

### 1. 抽轻量 History Reader / Repository

例如：

```text
session-history-reader.ts
```

统一：

```text
readSessionHeader
readSessionMetadata
listSessions
searchSessions
```

---

### 2. HTTP Handler 只调用 History API

不再自己：

```text
遍历目录
打开 JSONL
逐行 JSON.parse
```

未来需要：

```text
mtime cache
incremental index
```

时只修改 History 层。

不需要现在就引入数据库。

---

# 16. Server 目录结构扩展性问题

当前部分大型文件承担了太多“默认落点”职责。

完成前面的职责拆分后，建议逐渐形成：

```text
src/server/

  server-main.ts
  router.ts

  rpc-handlers/
    auth.ts
    model.ts
    module.ts
    session.ts
    workspace.ts

  sessions/
    session-runtime.ts
    capability-tracker.ts
    pi-rpc-transport.ts
    session-title.ts

  resources/
    geo-resources.ts
    video-resources.ts
    citation-resources.ts

  model/
    pi-model-config.ts
    pi-model-access.ts

  history/
    session-history-reader.ts
    session-history-handler.ts

  http/
    response.ts
```

不要求一次机械搬目录。

重点是形成稳定规则：

```text
RPC command        → rpc-handlers
Session runtime    → sessions
Domain resource    → resources
Model persistence  → model
History persistence→ history
HTTP helper        → http
```

避免新增功能继续默认进入：

```text
server-main.ts
sessions.ts
api-routes.ts
```

---

# 17. Web 目录结构扩展性问题

前端也建议逐渐形成稳定边界：

```text
src/web/

  platform/
    conversation/
      ConversationWorkspace.tsx
      composer/
      citation/
      tool-card/

    canvas/
      AgentCanvas.tsx
      CanvasRenderer.tsx
      CanvasTabs.tsx
      canvas-registry.ts
      renderers/

    model/
    sessions/
    workspace/

  features/
    geo/
    video/

  lib/
    formatting.ts
```

其中：

```text
features/geo
features/video
```

继续保存真实领域 UI。

而：

```text
platform/canvas
```

负责统一承载这些 Agent Artifact。

---

# 18. 明确本轮不应进行的抽象

为了防止本次整理从“消除冗余”反过来产生新的 AI Coding 冗余，应明确以下内容不要做。

## 1. 不建设 Generic Resource Framework

不要将：

```text
Geo
Video
Citation
```

抽成复杂的：

```text
GenericResource<T>
UniversalResourceHandler
ResourcePluginSystem
```

服务端保持领域独立。

---

## 2. 不建设万能 Canvas Item

不要设计：

```ts
interface CanvasItem {
  zoom?: ...
  currentTime?: ...
  page?: ...
  selectedRow?: ...
  chartAxis?: ...
}
```

基础字段放 Base，各种展示状态放对应 discriminated type / renderer。

---

## 3. 不建设 DI Container

`server-main.ts` 作为 composition root 是合理的。

应该整理它，而不是引入：

```text
IoC Container
Service Locator
Dependency Registry Framework
```

---

## 4. 不重写 Conversation Store

Snapshot + Live Overlay 已经是项目中质量最高的部分之一。

本轮重点是让：

```text
Citation
Attachment
Canvas
Video
```

重新遵守这套状态管理原则，而不是重新设计它。

---

## 5. 不为了文件数量机械拆文件

拆分标准应是：

```text
职责
变化原因
扩展方向
```

而不是：

```text
文件超过 300 行
```

---

# 19. 最终建议的实际修改顺序

本轮不是按风险优先级，而是按照结构依赖顺序完成。

## 第一组：删除与收缩

1. 删除 `TX_LOGO` 重复资产。
2. 删除 `task-state.ts` shim。
3. 删除未使用 contracts export。
4. 重命名 `_clearModelListCacheForTest()`。

---

## 第二组：合并现有重复逻辑

1. 合并 `normalizeModel`。
2. 收口 Model formatting。
3. 统一 `writeJson`。
4. 统一 `resolveServiceSession`。

---

## 第三组：整理模型配置

1. 建立 `readModelsConfig()`。
2. 收口 providers 获取。
3. Add / Update 共用 `modelPatch`。
4. 删除 CRUD 内重复 shape parsing。

---

## 第四组：建立 AgentCanvas

1. 定义 `CanvasItem / CanvasItemKind`。
2. 建立 Canvas Store。
3. 建立 `AgentCanvas`。
4. GeoWorkspace 接入 Geo Renderer。
5. VideoWorkspace 接入 Video Renderer。
6. 建立 Renderer Registry。
7. 支持 `items[] + activeItemId`。
8. 替换 `mapOpen / videoOpen`。
9. Kernel 将 Spatial / Video Event 投影成 Canvas Item。

---

## 第五组：恢复 Kernel Command 分层

1. Citation Commands。
2. Citation Candidate 统一。
3. Video Commands。
4. Report / File Preview Commands。
5. 删除 React Component 内直接 `fetch()`。

---

## 第六组：整理 RPC Command 结构

1. 建立 RPC Handler Registry。
2. Native flag 与 handler 同处登记。
3. Native whitelist 自动派生。
4. 按 auth/model/module/session/workspace 拆 Handler。
5. `server-main.ts` 回归 composition root。

---

## 第七组：整理 Session Service 模型

1. 定义统一 `SessionService`。
2. 收口 `serviceTokens`。
3. API route 共用 `resolveServiceSession()`。
4. 为未来 Session-scoped service 留稳定扩展点。

---

## 第八组：逐步拆 `PiRpcSession`

1. 抽 `SessionCapabilityTracker`。
2. 抽纯 Session Helper。
3. 最后抽 `PiRpcTransport`。
4. 保持 `LiveSessionManager` 外部 API 尽量不变。

---

## 第九组：整理 Session State Projection

1. 拆 `SessionSnapshot`。
2. 拆 `SessionLiveMetadata`。
3. 慢变信息只进入 Snapshot。
4. `broadcastUpdated()` 改为状态实际变化时触发。

---

## 第十组：拆 Conversation 热点

1. Citation UI。
2. Composer。
3. Tool Card。
4. Sanitizer。
5. Attachment State 回归 Kernel Store。
6. 删除 `window.dispatchEvent` 状态旁路。

---

## 第十一组：整理剩余 Workspace 状态

1. AgentCanvas 接管 Geo / Video。
2. Tasks 保持独立。
3. 对真正剩余的 Workbench Panel 使用 reducer。
4. 不再增加新的 `xxxOpen + openedXxxKey + useEffect` 模式。

---

## 第十二组：整理 History 和目录边界

1. 抽 Session History Reader。
2. HTTP Handler 不再理解 JSONL。
3. 按职责逐步整理 Server 目录。
4. 按职责整理 Web Canvas / Conversation 目录。

---

# 20. 整理后的目标扩展模型

目前新增一个 Agent 功能，很容易变成：

```text
新功能
 ├─ server-main.ts 增加命令判断
 ├─ sessions.ts 增加字段
 ├─ api-routes.ts 增加解析逻辑
 ├─ React 直接 fetch
 ├─ App.tsx 增加 xxxOpen
 └─ ConversationWorkspace 再增加一段 UI
```

完成本轮整理后，应演进成：

```text
新能力
   │
   ├─ contracts
   │    └─ 定义领域协议
   │
   ├─ Server
   │    ├─ rpc-handlers：命令
   │    ├─ resources：领域资源
   │    └─ sessions：必要的 session service
   │
   ├─ Kernel
   │    ├─ Command Port
   │    ├─ Store / Projection
   │    └─ Canvas Projection
   │
   └─ Web
        ├─ Feature Renderer
        └─ AgentCanvas / Conversation 负责承载
```

对于可展示型 Agent Artifact：

```text
Agent
  ↓
Domain Resource / Event
  ↓
Kernel Canvas Projection
  ↓
CanvasItem
  ↓
AgentCanvas
  ↓
Renderer Registry
  ├─ GeoWorkspace
  ├─ VideoWorkspace
  ├─ Future Report
  ├─ Future Chart
  └─ Future Table
```

这应当成为未来 Geo、Video、Report、Chart、Table 等交互能力的统一扩展模型。

---

# 21. 最终结论

本项目现在并不需要一次“大重构”。

真正值得做的是把已经出现的几个扩展模式正式固化下来：

1. **Contract 只有一个权威入口。**
2. **重复纯逻辑只保留一个实现。**
3. **Model 配置读写只有一个结构解析入口。**
4. **Geo / Video 服务端保持领域独立，只共享真正相同的小工具。**
5. **Geo / Video 等可视化成果在 Web 层统一进入 AgentCanvas。**
6. **React 统一通过 Kernel Command / Store 访问后端。**
7. **RPC Command 通过 Registry 和领域 Handler 扩展，而不是继续扩大 `server-main.ts`。**
8. **Session-scoped 能力统一采用 `SessionService + serviceTokens`。**
9. **`PiRpcSession` 分阶段拆为 Capability、Transport 和 Session Runtime。**
10. **Conversation、Canvas、Task 各自保持明确职责，不为了“统一”强行合并。**

本轮整理完成后，最大的收益不会只是减少若干重复代码，而是形成几个清晰且稳定的“新增功能入口”。

未来代码量即使从约 25,000 行继续增长，新增能力也不会默认堆积到：

```text
server-main.ts
sessions.ts
ConversationWorkspace.tsx
App.tsx
```

而是自然进入对应的：

```text
contracts
rpc-handlers
session services
kernel commands
AgentCanvas
feature renderer
store
```

这应当作为本次框架整理的最终目标。