# GIS Web 展示模块：架构与技术实施方案

> 状态：基础版本已实现（阶段 0 完成，阶段 1 核心闭环完成）  
> 面向项目：`pi-tau-traffic`  
> 文档目标：将通用 GIS 可视化能力嵌入现有 Pi RPC + Tau Web 工作台，作为后续实现、测试和验收的基线。

## 1. 结论先行

本项目不应增加一个交通专用的 `TransitMap` 页面，而应增加一套由 Pi Agent 驱动的通用地理空间可视化模块：

```text
地理数据文件 / 分析结果
        │
        ▼
publish_geodata
        │ 生成会话内可访问的 Geo Resource
        ▼
present_visualization
        │ 返回声明式 VisualizationEnvelope
        ▼
Pi RPC tool_execution_end / toolResult.details
        │
        ▼
Tau WebSocket + Session JSONL
        │
        ▼
VisualizationHost
        │
        ▼
GeoMapRuntime → MapLibre GL JS
```

交通线路、站点、客流、道路拥堵等不进入底层协议，它们只是交通 Skill 对通用点、线、面和视觉编码的组合。

首期实施选择：

- 产品形态：对话区右侧的持久“可视化工作区”，工具卡只显示操作摘要和“打开地图”入口。
- 地图引擎：只实现 MapLibre GL JS；协议不暴露 MapLibre API。
- 数据范围：只支持 RFC 7946 GeoJSON，并要求 WGS 84 / `OGC:CRS84` 经度、纬度坐标顺序。
- 图层范围：`circle`、`line`、`fill`、文本 `label`。
- 样式范围：常量样式、分类映射、分段映射和连续数值映射。
- 交互范围：缩放/平移、图层显隐、图例、安全 Popup、高亮、`fitBounds`。
- 会话状态：每次可视化操作返回完整的规范化 Scene Snapshot，会话恢复时取同一 `visualizationId` 的最后一份快照。
- 建设边界：首期不直接解析 SHP，不开放任意外部 URL，不实现时序动画、编辑绘制、栅格、3D 或地图到 Agent 的反向联动。

### 1.1 当前代码落地状态

截至当前版本，扩展、服务端与 Web 端已放入同一个 `pi-traffic-workspace` npm package，并完成以下闭环：

| 模块 | 已实现 |
|---|---|
| Pi Extension | 会话自动加载；`publish_geodata`；`present_visualization` 的 replace/patch/focus/select/clear；revision 与分支历史恢复 |
| 通用协议 | `VisualizationEnvelope`、`GeoSceneSnapshot`、内联/资源 GeoJSON、点线面文字图层、受控视觉编码与运行时校验 |
| 资源服务 | 任务 cwd 内发布、resource ID、manifest、会话隔离路由、realpath 边界、大小限制、ETag/304 |
| Web | 工具结果识别、会话级快照存储、工具卡摘要、“地图”工作区、MapLibre 懒加载、图层显隐、Popup、selection 与 bounds/camera |
| 恢复 | live event、最终 toolResult、live snapshot、历史 JSONL 与 resume 均使用同一份规范化快照；clear 使用 revision 墓碑防止旧事件复活 |
| 工程 | MapLibre 独立 bundle、扩展类型检查、协议/扩展/资源/会话测试、npm 单包发布清单 |

“基础版本”不等于本文阶段 1 的全部增强项已完成。当前尚未实现：GeoFilter DSL、自动图例、显式 fit-to-data 按钮、hover、日期格式 Popup、外部底图配置，以及 SHP/GeoPackage/MVT/栅格/时序等阶段 2–4 能力。它们继续按本文后续路线推进，不在本次基础闭环中伪装成已交付能力。

## 2. 前提、假设与非目标

### 2.1 已确认的项目现状

当前代码库是原生 TypeScript + DOM 的单页应用，不是 React/Vue 应用：

- `src/server/sessions.ts` 管理多个 `pi --mode rpc` 子进程，并把 Pi 事件广播给浏览器。
- `src/server/server-main.ts` 提供 HTTP API、WebSocket、会话快照、文件浏览和静态资源服务。
- `src/public/app-main.ts` 负责会话切换、实时事件、历史回放与右侧工作区。
- `src/public/tool-card.ts` 当前把工具输出当作文本或图片预览，不识别结构化可视化结果。
- Pi RPC 的 `tool_execution_end.result.details` 会在实时事件中出现；最终 `toolResult` 消息也会将 `details` 写入会话 JSONL。
- 现有前端恢复路径会遍历 `toolResult`，但目前仅将 `content` 交给工具卡，丢弃了 `details`。
- 前端使用 `tsc` 生成未打包的 ES Modules。浏览器无法直接解析 npm 裸导入 `maplibre-gl`，因此 GIS Runtime 需要独立 bundle 产物。
- 每个新任务在 `scenario/<timestamp-name>/` 中拥有独立 cwd，Pi 子进程不会自动从仓库根目录的 `.pi/extensions` 发现项目扩展。

### 2.2 实施假设

- GIS 模块是本项目自带的能力，新建和恢复的 Pi 会话都应自动加载它。
- 第一个可用版本优先证明端到端闭环，而不是一次性覆盖所有 GIS 格式、引擎和交互。
- 地理数据资源随任务 cwd 保存；会话 JSONL 只保存稳定引用和 Scene Snapshot，不嵌入大型数据。
- 大型 GIS 处理属于后续的 Python/GDAL 执行层，不应在浏览器或 Pi Extension 中重新实现。该层如开始建设，项目内脚本统一使用 `/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10`。

### 2.3 首期非目标

- 不将 MapLibre Style Spec 原样暴露给 Agent。
- 不允许 Agent 生成 JavaScript、HTML、CSS 或任意 MapLibre expression。
- 不提前实现 OpenLayers/Cesium/deck.gl 空适配器。待第二个真实引擎接入时，再从 MapLibre Runtime 中抽取已被验证的通用边界。
- 不把全部 GIS 分析都塞进 `present_visualization`。展示工具仅校验、规范化和更新 Scene。
- 不把地图放在只有 260px 宽的现有文件列表中，也不把可交互地图塞进会自动折叠的工具卡中。

## 3. 产品形态与交互设计

### 3.1 桌面端布局

右侧现有的“工作区”升级为两种宽度模式：

```text
左侧会话栏 | 对话与输入区 | 右侧工作区
                                      ├─ 文件 / 技能 / 工具：260px
                                      └─ 可视化：clamp(420px, 42vw, 760px)
```

“可视化”成为右侧栏的第四个 tab，但使用独立面板宽度。第一张地图产生时自动打开，用户可以关闭，关闭不销毁会话 Scene 状态。

地图面板由上到下包含：

1. 场景标题、状态和可视化切换器。
2. 地图画布，右上角只保留缩放、回到数据范围和全屏。
3. 可折叠图层/图例区，不与 Popup 抢占地图中心空间。
4. 数据来源、时间、简化/抽样警告等可解释性元数据。

视觉方向延续现有白色/淡蓝工作台，但地图区采用“城市制图控制台”的功能性风格：中性浅灰底图、清晰图层层级、少量高饱和强调色、可读的数字和图例，不使用装饰性动画干扰空间判读。

### 3.2 工具卡与地图的分工

`present_visualization` 的工具卡不渲染完整 Scene JSON，只显示：

```text
地图已更新 · 行政区人口分布
3 个图层 · 1 个数据源 · revision 4       [打开地图]
```

原始参数仍可在工具卡展开后查看，但大型内联 GeoJSON 必须截断或省略。

### 3.3 移动端

窄屏不维持三栏。可视化面板以全屏图层覆盖对话，顶部显示返回对话按钮。地图面板在移动端的最小高度为可视视口高度，图例以底部 sheet 呈现。

### 3.4 无数据、加载与错误状态

- 未选会话：“请先选择一个任务”。
- 当前会话无地图：说明 Agent 可以通过 GIS 工具生成地图。
- 资源加载中：地图骨架 + 具体资源名称，不使用无限旋转的空白屏。
- 协议校验失败：不尝试部分渲染，显示具体字段错误和工具调用 ID。
- 资源丢失：保留 Scene 与图层列表，将失败图层标为“数据不可用”，不让整个面板崩溃。
- WebGL 不可用：显示可理解的降级提示和数据下载入口，首期不自动切换到第二套地图引擎。

## 4. 模块总体架构

```text
Pi Extension
├─ publish_geodata
├─ present_visualization
└─ SceneState (per Pi session)
        │
        │ ToolResult.details.visualization
        ▼
PiRpcSession
├─ 实时转发 tool_execution_end
├─ 记录最终 toolResult 消息
└─ snapshot.entries
        │
        ▼
Browser
├─ VisualizationResultRouter
├─ SessionVisualizationStore
└─ VisualizationHost
      └─ GeoMapRuntime
            ├─ SceneReducer
            ├─ ResourceLoader
            ├─ StyleCompiler
            ├─ InteractionController
            ├─ LegendRenderer
            └─ MapLibreAdapter
```

首期不做通用插件注册中心。`VisualizationHost` 只识别 `kind: "geo"`，但保留 `kind` 字段。等真正增加 `chart` 或 `table` 时，再将这个分支提取为 `PluginRegistry`，避免为单一实现预建抽象层。

## 5. 三层契约

### 5.1 Agent Tool Contract

首期对 Agent 暴露两个工具。

#### `publish_geodata`

作用：将当前任务目录内的 GeoJSON 文件登记成 Web 可读的不可变资源。

参数：

```json
{
  "path": "result/areas.geojson",
  "title": "行政区人口结果",
  "idField": "area_id"
}
```

处理要求：

- 解析后的真实路径必须在 Pi 会话 cwd 之内。
- 仅接受 `.geojson` 或内容为 GeoJSON 的 `.json`。
- 校验 `FeatureCollection`、几何类型、坐标有限值、经纬度范围和 `idField` 唯一性。
- 计算 `sha256`、字节数、feature 数、geometry types、bounds 和属性 schema。
- 将稳定副本写入 `.tau/geo-resources/<resourceId>/data.geojson`，并同步写入 `manifest.json`。
- 对原文件的后续修改不影响已发布资源。内容 hash 相同时可重用已有资源。

返回的 `details.resource` 形式：

```json
{
  "resourceId": "geo_01J...",
  "format": "geojson",
  "geometryTypes": ["Polygon", "MultiPolygon"],
  "featureCount": 16,
  "bounds": [120.85, 30.67, 122.20, 31.88],
  "idField": "area_id",
  "bytes": 184320,
  "sha256": "..."
}
```

#### `present_visualization`

作用：新建、替换或更新当前会话的地理可视化 Scene。

操作类型：

- `replace`：提交一份完整 Scene，原子替换同 ID 的 Scene。
- `patch`：使用受限、有类型的 upsert/remove 集合局部更新。
- `focus`：仅更新视角。
- `select`：更新按 source/layer/feature ID 表达的高亮集合。
- `clear`：删除指定 Scene，或清空其选中状态。

工具内部负责：

1. 用 TypeBox 工具参数 schema 校验输入。
2. 在扩展内存中对 Scene 副本执行操作。
3. 校验更新后的完整 Scene，成功后才提交，禁止半更新。
4. 由扩展分配单调 `revision`，不信任 Agent 提供的版本号。
5. 在 `details.visualization` 中返回完整规范化 Snapshot；`content` 只返回短文本摘要给模型和工具卡。

### 5.2 Visualization Protocol

传输外壳固定为 `VisualizationEnvelope`：

```ts
type VisualizationEnvelope = {
  protocol: "pi-visualization";
  version: "1.0";
  kind: "geo";
  visualizationId: string;
  revision: number;
  operation: "replace" | "patch" | "focus" | "select" | "clear";
  scene: GeoSceneSnapshot | null;
  summary: {
    title: string;
    description?: string;
  };
  generatedAt: string;
};
```

首期的重要约定：

- `scene` 是操作后的完整规范化快照，不是 patch 本身。
- `operation` 用于工具卡语义、审计和动画决策；恢复只需最终 Snapshot。
- `revision` 必须对每个 `visualizationId` 单调增长。前端忽略小于当前 revision 的迟到事件。
- `clear` 后 `scene` 为 `null`。
- 不在协议中出现 `map.addLayer`、`paint`、MapLibre expression 等引擎语义。

### 5.3 Runtime Contract

首期 Runtime 对内只需要一组小接口：

```ts
interface GeoMapRuntime {
  mount(container: HTMLElement): Promise<void>;
  replace(scene: GeoSceneSnapshot): Promise<void>;
  resize(): void;
  destroy(): void;
}
```

由于 Envelope 已经携带最终 Snapshot，Runtime 无需实现公开 `patch/focus/select` 方法；`VisualizationHost` 将新快照交给 `replace`，Runtime 内部再比较新旧 Scene，采用最小 MapLibre 变更。这保持外部状态模型简单，同时避免每次都销毁地图实例。

## 6. GeoScene v1 协议

### 6.1 总体结构

```ts
type GeoSceneSnapshot = {
  view: GeoView;
  basemap: BasemapRef;
  sources: GeoSource[];
  layers: GeoLayer[];
  legends?: GeoLegend[];
  interactions?: GeoInteractions;
  controls?: GeoControls;
  selection?: GeoSelection[];
  metadata: GeoMetadata;
};
```

### 6.2 View

v1 固定为 2D Web Mercator 显示，输入数据坐标为 WGS 84 经纬度。`view` 二选一：

```json
{ "mode": "bounds", "bounds": [120.85, 30.67, 122.20, 31.88], "padding": 32 }
```

或：

```json
{ "mode": "camera", "center": [121.47, 31.23], "zoom": 10, "bearing": 0, "pitch": 0 }
```

约束：

- `padding` 限制在 0–128 px。
- v1 的 `bearing` 固定或规范化为 0，`pitch` 固定或规范化为 0，避免交通主题图产生无意义透视。
- bounds 必须是 `[west, south, east, north]`，不在 v1 处理跨日期变更线范围。

### 6.3 Basemap

```ts
type BasemapRef = {
  id: "default" | "light" | "dark" | "none";
};
```

Agent 仅选择底图 ID，不传 URL。前端/服务端配置将 ID 映射为经允许的 style URL 和 attribution。`none` 使用项目自带的空白中性 MapLibre style，确保离线时业务图层仍可渲染。

当前 Web 实现将 `default` 与 `light` 映射到 OpenFreeMap Positron，将 `dark` 映射到 OpenFreeMap Dark；URL 固定在 Runtime 白名单中，Agent 不能覆盖。远程底图负责道路、水系、行政区和地名语境，业务线/面插入到底图注记下方，点位与业务注记位于上方。线路统一增加白色或深色 casing，点位统一增加 halo、hover/select 反馈，避免交通色带与底图混在一起。

OpenFreeMap 是当前开发和演示默认值，依赖网络且不承诺项目级 SLA。生产部署应替换为具备明确服务等级与许可条款的自托管/商业 style；切换不改变 Agent 协议。离线或内网环境使用 `none`，后续可按第 17.4 节接入自托管 PMTiles。

生产底图必须明确数据供应商、凭证、并发限制、字体/sprite 资源与署名条款，不把 MapLibre 演示地图当作生产依赖。

### 6.4 Sources

v1 只接受两类 source：

```ts
type GeoSource =
  | {
      id: string;
      type: "geojson-resource";
      resourceId: string;
      idField?: string;
    }
  | {
      id: string;
      type: "geojson-inline";
      data: GeoJSON.FeatureCollection;
      idField?: string;
    };
```

限制：

- 内联 GeoJSON 只用于少量简单 feature；默认上限为序列化后 256 KiB 且 1,000 features，两者任一超过就必须先发布资源。
- GeoJSON 遵循 RFC 7946：WGS 84，坐标顺序为经度、纬度。其他 CRS 必须在发布前转换。
- 需要 hover/select 时必须存在稳定 feature ID：优先使用 GeoJSON `Feature.id`，否则由 `idField` 提升。
- Source 不包含样式。同一 source 可被多个 layer 引用。

### 6.5 Layers

```ts
type GeoLayer = {
  id: string;
  sourceId: string;
  type: "circle" | "line" | "fill" | "label";
  title?: string;
  visible?: boolean;
  minZoom?: number;
  maxZoom?: number;
  filter?: GeoFilter;
  encoding: GeoEncoding;
  popup?: { fields: PopupField[] };
};
```

数组顺序就是图层顺序，后出现的 layer 在上方。不再额外增加 `zIndex`，避免两套排序信息冲突。

`filter` 只允许以下受控 DSL：

```ts
type GeoFilter =
  | { op: "eq" | "neq"; field: string; value: string | number | boolean | null }
  | { op: "in"; field: string; values: Array<string | number> }
  | { op: "range"; field: string; min?: number; max?: number }
  | { op: "and" | "or"; filters: GeoFilter[] };
```

Runtime 将该 DSL 编译成 MapLibre filter，Agent 不能直接提供表达式数组。

### 6.6 视觉编码

每个视觉通道接受常量或数据映射：

```ts
type VisualValue<T> =
  | { mode: "constant"; value: T }
  | {
      mode: "categorical";
      field: string;
      categories: Array<{ value: string | number | boolean; output: T }>;
      fallback: T;
    }
  | {
      mode: "step";
      field: string;
      default: T;
      stops: Array<{ value: number; output: T }>;
    }
  | {
      mode: "continuous";
      field: string;
      stops: Array<{ value: number; output: T }>;
      clamp?: boolean;
    };
```

各图层允许的通道：

| Layer | 允许通道 |
|---|---|
| `circle` | `color`, `radius`, `opacity`, `strokeColor`, `strokeWidth` |
| `line` | `color`, `width`, `opacity`, `dash` |
| `fill` | `color`, `opacity`, `outlineColor` |
| `label` | `textField`, `color`, `size`, `haloColor`, `haloWidth` |

编译规则：

- `categorical` 编译为受控 `match`。
- `step` 编译为受控 `step`，stops 必须严格递增。
- `continuous` 编译为线性 `interpolate`，仅允许数字、颜色和大小输出。
- 字段不存在、类型不匹配或值为 null 时使用 fallback，并将统计警告写入面板元数据。
- 颜色经严格颜色 parser 校验，不将任意 CSS 字符串传入 DOM。

MapLibre 的数据表达式可支持 `match`、`step`和 `interpolate`，但协议只开放上述受限子集，保持可验证性和跨引擎语义。

### 6.7 Popup、图例、控件和选中

Popup 不接受 HTML template：

```ts
type PopupField = {
  field: string;
  label: string;
  format?: "text" | "integer" | "decimal" | "percent" | "datetime";
  digits?: number;
};
```

前端使用 DOM `textContent` 构建 Popup，不使用属性值拼接 `innerHTML`。

图例原则上由 Runtime 根据 encoding 自动生成。仅当业务名称、单位或顺序无法推断时，Scene 才提供 `legends` 覆盖元数据，不重复提供颜色 stop。

v1 controls：

```ts
type GeoControls = {
  navigation?: boolean;
  fullscreen?: boolean;
  layerSwitcher?: boolean;
  legend?: boolean;
  fitToData?: boolean;
};
```

选中状态引用稳定 ID：

```ts
type GeoSelection = {
  sourceId: string;
  layerId?: string;
  featureIds: Array<string | number>;
};
```

MapLibre Runtime 通过 `feature-state` 实现 hover/select，选中颜色和宽度由项目统一主题控制，Agent 不可构造一套看不清原始值的高亮样式。

### 6.8 Metadata

```ts
type GeoMetadata = {
  title: string;
  description?: string;
  provenance?: Array<{ label: string; value: string }>;
  timeRange?: { start?: string; end?: string };
  units?: Record<string, string>;
  warnings?: string[];
};
```

元数据是必要的解释层，不是装饰字段。凡数据经抽样、简化、分级或缺失值过滤，都应出现在 `warnings`。

## 7. Patch 语义与一致性

不采用任意 RFC 6902 JSON Patch，而使用类型化 patch：

```ts
type GeoScenePatch = {
  view?: GeoView;
  basemap?: BasemapRef;
  upsertSources?: GeoSource[];
  removeSourceIds?: string[];
  upsertLayers?: GeoLayer[];
  removeLayerIds?: string[];
  layerOrder?: string[];
  controls?: GeoControls;
  selection?: GeoSelection[];
  metadata?: Partial<GeoMetadata>;
};
```

执行规则：

1. 在当前 Scene 的深副本上操作。
2. 先 upsert，再 remove，最后校验引用完整性和 layer order。
3. 如剩余 layer 仍引用待删 source，整个 patch 失败。
4. `layerOrder` 如存在，必须恰好包含更新后的全部 layer ID，且不允许重复。
5. 更新后执行与 `replace` 相同的完整 Scene 校验。
6. 失败时不修改内存状态，也不发送部分结果给前端。

不依赖 WebSocket 事件到达顺序：前端以 `revision` 判断新旧，并以最终 `message_end` 中的 `toolResult.details` 或会话快照为权威状态。

## 8. 会话状态、历史恢复与分支

### 8.1 为什么首期就保存完整 Snapshot

原始手册建议先通过事件回放恢复，后续再引入 Snapshot。对本项目更稳妥的实施顺序是相反的：

- Pi Extension 官方状态模式就是将 JSON 可序列化状态放入 `toolResult.details`。
- 资源与几何数据已被抽离为 `resourceId`，因此 Scene Snapshot 本身很小。
- 仅回放 patch 会被丢失、重复事件、长会话和协议升级放大风险。
- 每次结果携带完整 Snapshot 使恢复逻辑成为“每个 ID 保留最高 revision”，可测且容易解释。

因此，操作事件仍存在，但不是恢复 Scene 的唯一依赖。

### 8.2 前端 Store

```ts
type SessionVisualizationStore = Map<
  string, // sessionId or stable session file key
  Map<string, VisualizationEnvelope> // visualizationId -> latest revision
>;
```

行为：

- 实时 `tool_execution_end`：如 `toolName === "present_visualization"`，校验 `result.details.visualization` 后写入 Store。
- 最终 `toolResult message_end`：再次接收权威结果，相同 revision 幂等覆盖。
- 加载会话 snapshot 或历史 JSONL：清空该 session Store，遍历当前分支中的 `toolResult`，保留每个 ID 的最高 revision。
- 切换会话：展示该会话上次打开的 visualization；若无偏好，展示 revision 最新者。
- 历史只读会话：地图可浏览，但“询问 Agent”、绘制、筛选回写等会改变 Pi 状态的操作不可用。

`localStorage` 只保存面板开关、宽度和每会话最后打开的 visualizationId，不作为 Scene 真值源。

### 8.3 恢复阶段必须验证的边界

- 页面刷新后恢复正在存活的 Pi 会话。
- 关闭服务后，从历史 JSONL 恢复会话与 Scene。
- 会话 fork/分支后不混入另一分支的 Scene。
- 会话 compact 后是否仍能在 `ctx.sessionManager.getBranch()` 中找到最近 Snapshot。如实测发现 compact 会移除它，则在 compact hook 中写入一条不进入模型上下文的 visualization checkpoint，而不将浏览器缓存提升为真值源。

## 9. Geo Resource Store 与 HTTP API

### 9.1 目录布局

每个任务 cwd 下使用：

```text
.tau/
├─ geo-resources/
│  └─ <resourceId>/
│     ├─ manifest.json
│     └─ data.geojson
└─ visualizations/        # 仅作调试导出/备用，不是会话真值源
```

`.tau/` 不在右侧普通文件树中默认展开，但资源元数据可在地图面板中查看。

### 9.2 服务端路由

```text
GET /api/live-sessions/:sessionId/geo-resources/:resourceId/manifest
GET /api/live-sessions/:sessionId/geo-resources/:resourceId/data
```

不让客户端传入文件路径。服务端按以下顺序解析：

1. `sessionId` 必须对应存在的 live session，或使用受验证的历史 session file + cwd 读取模式。
2. `resourceId` 必须匹配固定格式，不允许斜杠、点号或 URL 编码逃逸。
3. 资源真实路径必须仍位于该会话 cwd 的 `.tau/geo-resources` 之内。
4. manifest 与数据 hash 不一致时拒绝提供数据。

HTTP 要求：

- GeoJSON 返回 `application/geo+json; charset=utf-8`。
- 返回基于 SHA-256 的 `ETag`，支持 `If-None-Match`。
- 会话资源默认 `Cache-Control: private, max-age=0, must-revalidate`。
- 设置 `X-Content-Type-Options: nosniff`。
- 数据不通过 WebSocket 传输，避免阻塞 Agent 事件流和会话快照。

引入 PMTiles 前必须为数据路由增加正确的 HTTP Range Request（`Accept-Ranges`、`Content-Range`、206/416）测试。当前通用静态文件服务没有 Range 支持，不能直接被当成 PMTiles 数据服务。

### 9.3 数据规模门槛

首期不承诺“任意 GeoJSON 都能顺滑显示”。默认门槛作为安全阀，并通过性能基准调整：

| 路径 | 默认门槛 | 超限行为 |
|---|---:|---|
| 内联 GeoJSON | 256 KiB 且 1,000 features | 要求 `publish_geodata` |
| v1 GeoJSON Resource | 20 MiB 且 50,000 features | 发布失败，建议简化/切片 |
| Popup 字段 | 每图层 12 个 | schema 校验失败 |
| Scene | 32 sources / 64 layers | schema 校验失败 |
| 一次 selection | 5,000 feature IDs | 要求用 filter 或聚合表达 |

这些不是 GIS 理论上限，而是首期防止模型误用和浏览器失去响应的可配置阀值。超出后进入 MVT/PMTiles/deck.gl 路径，不通过不断抬高 GeoJSON 上限解决。

## 10. Pi Extension 实现方案

### 10.1 位置与加载

建议作为项目内置扩展：

```text
extensions/pi-geo-visualization/
├─ index.ts
├─ schemas.ts
├─ scene-state.ts
├─ publish-geodata.ts
└─ present-visualization.ts
```

`package.json.files` 增加 `extensions`。`PiRpcSession.start()` 启动 Pi 时显式追加：

```text
--extension <resolved-package-root>/extensions/pi-geo-visualization/index.ts
```

路径由服务端从安装包位置解析，不从 session cwd 拼接，也不需要把扩展复制到每个 `scenario` 目录。

增加一个显式服务端配置开关，用于开发和故障隔离，但产品默认开启。启动时扩展文件不存在应直接拒绝创建会话，而不是创建一个没有 GIS 工具的静默降级会话。

### 10.2 扩展状态

每个 Pi RPC 子进程对应一份扩展内存：

```ts
Map<visualizationId, { revision: number; scene: GeoSceneSnapshot }>
```

`session_start` 中遍历当前 branch 的 `present_visualization` toolResult，从 `details.visualization` 恢复每个 ID 最高 revision。这一逻辑必须与前端恢复共用相同的协议样例测试。

### 10.3 工具结果格式

```ts
return {
  content: [{
    type: "text",
    text: "已更新地图‘行政区人口分布’：3 个图层，1 个数据源。"
  }],
  details: {
    visualization: envelope
  }
};
```

Scene 只放在 `details`，不放入文本 `content`。这样前端可以读取完整结构，同时不向模型上下文重复注入大段 JSON。

## 11. 前端实施方案

### 11.1 建议文件

```text
src/public/visualization/
├─ visualization-host.ts
├─ visualization-result-router.ts
├─ session-visualization-store.ts
└─ geo/
   ├─ types.ts
   ├─ validate.ts
   ├─ geo-panel.ts
   ├─ geo-map-runtime.ts
   ├─ geo-runtime-entry.ts
   ├─ resource-loader.ts
   ├─ style-compiler.ts
   ├─ interaction-controller.ts
   └─ legend-renderer.ts
```

职责边界：

- `visualization-result-router`：仅识别工具结果、校验 Envelope 顶层标识，路由到 Host。
- `session-visualization-store`：处理 session 隔离、revision、clear、最后打开项。
- `visualization-host`：面板生命周期、会话切换、错误边界、懒加载 Runtime。
- `validate`：把所有来自 Agent/JSONL 的对象当作不可信数据，执行运行时验证。
- `geo-map-runtime`：管理一个 MapLibre Map 实例和 Scene diff，不负责会话。
- `style-compiler`：仅将受控视觉编码编译为 MapLibre style/filter expressions。
- `interaction-controller`：绑定/解绑图层事件，管理 hover/select/Popup，防止 replace 后重复监听。

### 11.2 构建策略

保持现有前端模块不变，只为地图引擎增加独立 bundle：

```text
src/public/visualization/geo/geo-runtime-entry.ts
        │ esbuild --bundle --format=esm
        ▼
public/geo-runtime.js
public/geo-runtime.css
```

`VisualizationHost` 第一次真正打开地图时才执行 `import('./geo-runtime.js')`。这避免 MapLibre 显著增加每次首屏对话加载。

建议脚本：

```json
{
  "build:server": "tsc -p tsconfig.server.json",
  "build:public": "tsc -p tsconfig.public.json",
  "build:geo": "esbuild src/public/visualization/geo/geo-runtime-entry.ts --bundle --format=esm --target=es2022 --outfile=public/geo-runtime.js",
  "build": "npm run build:server && npm run build:public && npm run build:geo"
}
```

实施时将 MapLibre 锁定到经测试的精确版本，不通过 CDN/unpkg 动态获取运行时脚本。如 esbuild 对 CSS 生成独立文件，由 Host 在加载 Runtime 时幂等插入 `<link>`。

### 11.3 MapLibre 实例策略

每个浏览器页面只维持一个活跃 MapLibre Map 实例：

- 会话或 visualization 切换时，使用新 Scene 替换 sources/layers，不同时保留多个 WebGL context。
- 面板关闭只隐藏，打开时调用 `resize()`。
- 页面卸载或 Runtime 错误重置时调用 `map.remove()`。
- 底图 style 变化会清除自定义 source/layer，Runtime 必须等待新 style 完成后重放 Scene，并用世代号忽略迟到的旧加载任务。

### 11.4 与现有事件流的接入点

`src/public/app-main.ts` 需要三个精确接入点：

1. `handleToolExecutionEnd`：工具卡 finalize 之前或之后，将完整 `result` 交给 `VisualizationResultRouter`。
2. `renderHistory`：遇到 `msg.role === "toolResult"` 时，将 `msg.details`、`msg.toolName`、`msg.toolCallId` 一起交给 Router，不再只传 `content`。
3. 会话切换/快照更新：在渲染新历史前重置该 session Store，在遍历完后一次性激活最终 Scene，避免回放期间连续重绘地图。

`AppMessage`、`ToolResult`、`PiMessage` 类型补充 `toolName`、`details`、`timestamp`。现有服务端已将原始对象保存与转发，不需要为了 Scene 再创造一套 WebSocket 消息类型。

## 12. 服务端改动边界

新增两个小模块：

```text
src/server/geo-extension.ts    # 解析内置 Pi Extension 路径、生成启动参数
src/server/geo-resources.ts    # manifest/data 路由与边界校验
```

不把资源路由、Range、ETag 和 manifest 解析继续堆入已很长的 `server-main.ts`。`server-main.ts` 只完成路由匹配并调用 handler。

对 `PiRpcSession` 的修改仅包含：

- 启动参数注入内置 extension。
- 补充 TypeScript 类型，确保 `toolResult.details` 在 track/snapshot 路径中不会被以后的规范化逻辑意外丢弃。
- 不在 Tau Server 重新解析或修改 Scene；Server 仅负责传输、会话范围资源授权和 HTTP 缓存语义。

## 13. 安全模型

### 13.1 不可信边界

以下数据全部按不可信输入处理：

- Agent 的工具参数。
- 会话 JSONL 中恢复的 `details`。
- GeoJSON properties 和 Popup 文本。
- 底图和数据服务返回内容。
- resourceId、sessionId 和 URL 编码路径段。

必须落实：

- 前后端各自校验 Envelope/Scene，不依赖另一端“已经校验”。
- Popup、图例、标题和错误信息使用 DOM 文本节点，禁止属性值进入 `innerHTML`。
- v1 只读同源 session resource；外部底图只允许服务端配置白名单。
- 不支持 `javascript:`、`data:` 作为 source/style URL，不支持 Agent 自定义 sprite/glyph URL。
- 不运行 Agent 生成的 expression、函数或模板。
- 限制 Scene 深度、数组长度、字符串长度、GeoJSON 字节数和 feature 数，防止内存/渲染型 DoS。
- 资源目录不接受 symlink 逃逸；读取前用 `realpath` 检查真实路径。

### 13.2 CSP 与 Worker

MapLibre 使用 Web Worker/WebGL。上线前需根据锁定的 MapLibre 版本验证 CSP，至少明确 `script-src`、`worker-src`、`connect-src`、`img-src`和 `style-src`。不为了“让地图能跑”直接使用宽泛 `*` 或不受控 `unsafe-eval`。

## 14. 性能与可观测性

### 14.1 性能策略

- MapLibre bundle 懒加载，不影响不使用 GIS 的会话。
- 一页一个 MapLibre 实例，避免多 WebGL context。
- 资源独立 HTTP 加载，不进 WebSocket/JSONL。
- 小更新对相同 GeoJSON source 使用 `setData`/差量更新能力，但先以正确性为主；只在 source 具有稳定 feature ID 时考虑真正 diff update。
- 大量图层事件监听在 Scene replace 前成对解绑，防止重复触发和内存泄漏。
- 只在面板可见且尺寸变化时调用 `resize`，使用 `ResizeObserver` 合并频繁更新。

### 14.2 运行指标

开发日志和错误记录至少包含：

- sessionId（脱敏/截断显示）、visualizationId、revision、toolCallId。
- Scene 校验耗时、资源下载耗时、字节数、feature 数。
- MapLibre `load`、`error`、WebGL context lost/restored。
- source/layer 数量、replace 耗时、fitBounds 耗时。

前端用户可见错误保持简短，详细 schema 路径和堆栈只进开发日志，防止泄漏本地路径和数据内容。

## 15. 测试策略

### 15.1 协议与编译单元测试

- 合法/非法 Envelope、Scene、source、layer、filter、encoding。
- 重复 ID、引用不存在 source、无效 layer order、不递增 stops。
- 颜色、数字范围、字符串和数组长度限制。
- 视觉编码到 MapLibre `match/step/interpolate` 的精确输出。
- Popup 值含 HTML/script 时仅作文本显示。
- 旧 revision、重复 revision、clear 和乱序事件的幂等性。

### 15.2 Extension 测试

- `publish_geodata` 拒绝 cwd 之外路径、symlink 逃逸、错误后缀、非 GeoJSON、非 WGS84 范围、重复 ID 和超限数据。
- 相同 hash 资源重用，原文件修改不改变已发布副本。
- `present_visualization` 的 replace/patch/focus/select/clear 原子性。
- 从会话 branch 中恢复最高 revision，并验证 fork 不污染。
- 工具 `content` 不包含完整 Scene，`details` 包含完整快照。

### 15.3 Server 测试

- Pi 子进程启动参数确实包含内置 extension，新建和 resume 一致。
- 资源路由的会话隔离、路径遍历、恶意 URL 编码、丢失 manifest、hash 不一致。
- `Content-Type`、`ETag`、`If-None-Match`、`nosniff` 与缓存头。
- WebSocket 仍原样转发 `result.details`，snapshot 保留 `toolResult.details`。
- 非 GIS 会话的现有 API 和快照测试无回归。

### 15.4 前端集成与手工验收

至少准备四份 fixture：点、线、面、混合非法数据。

核心用例：

1. 新会话中发布 Polygon GeoJSON，生成分级设色图，自动打开右侧地图。
2. 后续对话通过 patch 增加点图层，原地图视角与用户手动图层显隐行为符合规则。
3. 调用 focus 仅改变视角，不重新下载未变数据。
4. 刷新页面、切换会话、关闭重开地图，Scene 保持。
5. 重启 Tau 并 resume 历史会话，Scene 从 JSONL details 恢复，资源从任务 cwd 恢复。
6. 后台会话产生地图时不覆盖当前会话画面；切换过去后可见。
7. 一个资源加载失败时，其他图层仍可浏览，错误信息不泄漏绝对路径。
8. 手机窄屏中地图为全屏覆盖层，可明确返回对话，不出现 260px 宽的不可用地图。

### 15.5 性能基准

在主要开发浏览器上记录：

- 首次打开地图 bundle 加载时间与 gzip 大小。
- 1k、10k、50k point 的首渲染时间和交互 FPS。
- 1 MiB、10 MiB、20 MiB polygon GeoJSON 的下载、解析和首渲染时间。
- 10 次连续 patch 后的 listener 数、JS heap 和图层数，确认无重复注册。
- 连续切换 20 次会话后 WebGL context 数仍为 1。

## 16. 分阶段实施路线

### 阶段 0：协议贯通实验

目标：不接 MapLibre，先证明 `toolResult.details → WebSocket/JSONL → 前端恢复` 链路。

交付：

- 最小 `present_visualization` extension。
- 一份固定 Envelope fixture。
- 前端调试面板显示 title/revision/source/layer 数。
- 新建、实时、刷新、resume、fork/compact 探针测试。

退出条件：同一份 Scene 在五种会话路径中恢复一致，并确认 compact 边界的实际行为。

### 阶段 1：可用的 2D 矢量地图

目标：完成本文档定义的 v1 闭环。

交付：

- `publish_geodata` + Resource Store/API。
- `present_visualization` 全部 v1 操作。
- MapLibre 懒加载 Runtime。
- 点/线/面/文字、图例、Popup、图层开关、fit bounds、高亮。
- 桌面右侧面板与移动全屏面板。
- 会话恢复、资源错误和安全边界测试。

退出条件：第 18 节验收标准全部通过。

### 阶段 2：通用 GIS 文件处理

目标：将 SHP/GeoPackage/KML/CSV/GeoParquet 转为标准 Web 资源。

交付：

- `inspect_geodata`。
- `transform_geodata`：CRS 转换、几何修复、字段筛选、简化、裁剪和格式转换。
- 基于 GeoPandas/GDAL/Shapely 的独立 Python CLI，Pi Extension 使用 `execFile` 和受控参数调用，不拼接 shell 命令。
- 处理报告和 provenance/warnings 自动写入 manifest。

### 阶段 3：大数据、栅格与高级图层

目标：突破 GeoJSON 的性能边界。

交付：

- MVT/PMTiles，完整 HTTP Range 支持。
- Raster Tile/WMS/WMTS/COG，并明确各格式的重投影边界。
- 点聚合、热力、轨迹和 OD/Arc；数据规模确实需要时才增加 deck.gl overlay。
- 这一阶段再将 `GeoMapRuntime` 中的真实稳定边界提取为可替换 EngineAdapter。

PMTiles 客户端可通过 MapLibre 的 protocol 扩展读取单文件 tile archive；这是未来选择，不应使 v1 的 source schema 预先承担未验证的复杂度。

### 阶段 4：时序与地图到 Agent

目标：完成对话式空间交互闭环。

交付：

- 时间字段、时间滑块、播放、历史对比和实时 source。
- 框选、绘制、可视范围、选中 feature 和当前筛选器。
- `get_visualization_context`：按需返回当前地图状态，不自动注入每次 prompt。
- “询问 Agent”显式入口，将当前选中作为一次性 follow-up context。

## 17. 建议改动清单

阶段 0–1 预计触及文件：

```text
package.json
package-lock.json
tsconfig.public.json                 # 如地图类型检查需要小幅调整
public/index.html
public/style.css

src/server/config.ts                 # GIS extension/basemap/resource 配置
src/server/sessions.ts               # Pi 启动参数 + toolResult 类型
src/server/server-main.ts            # 资源路由接入
src/server/geo-extension.ts
src/server/geo-resources.ts

src/public/app-types.ts
src/public/app-main.ts
src/public/tool-card.ts               # GIS 摘要和打开入口
src/public/visualization/**

extensions/pi-geo-visualization/**

test/geo-extension.test.ts
test/geo-resources.test.ts
test/geo-protocol.test.ts
test/geo-session-restore.test.ts
test/fixtures/geo/**
```

实施时不顺手重构现有会话、文件浏览或工具卡逻辑。只有当当前 `file-sidebar` 命名确实阻碍可视化面板接入时，才将其最小改名为 `workspace-sidebar`，并在同一次改动中完成所有引用。

## 18. 阶段 1 验收标准

只有以下条件全部满足，才视为 GIS Web 展示模块 v1 完成：

- Pi 新建与恢复会话均可调用 `publish_geodata` 和 `present_visualization`。
- Agent 只输出声明式协议，无 JavaScript/HTML/CSS/MapLibre 原生 expression 执行通道。
- GeoJSON 资源按会话隔离，不能越界读取任务 cwd 外文件。
- 点、线、面、文字、分类和连续数值编码在 MapLibre 中渲染正确。
- Popup、图例、图层开关、高亮与 fit bounds 可用且可访问。
- 工具卡不被 Scene JSON 淹没，可一键打开对应地图。
- 同页多会话严格隔离，后台会话不覆盖当前地图。
- 页面刷新、历史 resume 和分支恢复后，Scene 与 revision 正确。
- 丢失/非法资源产生可理解错误，不崩溃页面，不泄漏绝对路径。
- 地图不使用 CDN 运行时脚本，npm 依赖锁定，正常构建和离线空白底图可用。
- `npm run typecheck`、`npm test` 通过，并完成本文档第 15.4 节的手工验收。

## 19. 已决策与待验证项

### 19.1 已决策

| 问题 | 决策 |
|---|---|
| 协议名称 | `VisualizationEnvelope` + `GeoSceneSnapshot` |
| 交通语义放哪里 | Skill/领域模板，不进底层协议 |
| 首个引擎 | MapLibre GL JS |
| 首期数据 | WGS 84 GeoJSON，内联或 session resource |
| 地图容器 | 右侧持久可视化工作区 |
| 会话恢复 | 每次工具结果保存完整最终 Snapshot |
| 局部更新 | 类型化 patch，扩展原子应用后返回完整 Snapshot |
| 前端依赖 | 独立懒加载 bundle，不全面迁移现有构建链 |
| 大数据 | 后续 MVT/PMTiles/deck.gl，不无限抬高 GeoJSON 阈值 |
| 外部 URL | v1 禁止 Agent 任意提供，底图由配置白名单解析 |

### 19.2 阶段 0 必须用代码验证

- Pi RPC 实际 `toolResult.details` 在 live、snapshot、resume、fork、compact 各路径中的完整性。
- Pi 是否在当前安装方式下稳定加载安装包内的 TypeScript extension；如发布环境不安全，将 extension 增加独立编译产物，不改变协议。
- MapLibre bundle + Worker 在当前静态服务、Service Worker 和未来 CSP 下的加载行为。
- 现有历史条目是否均携带恢复 Geo Resource 所需的 cwd；如不足，先补齐受验证的历史 resource route 上下文。

## 20. 技术参考

- [MapLibre GL JS 文档](https://maplibre.org/maplibre-gl-js/docs/)：浏览器 WebGL 地图、source/layer、交互和 CSP 入口。
- [MapLibre Style Spec 表达式](https://maplibre.org/maplibre-style-spec/expressions/)：`match`、`step`、`interpolate` 与 `feature-state` 的引擎能力。
- [MapLibre GeoJSONSource API](https://maplibre.org/maplibre-gl-js/docs/API/classes/GeoJSONSource/)：GeoJSON source 加载、`setData` 与基于稳定 ID 的差量更新。
- [RFC 7946: The GeoJSON Format](https://www.rfc-editor.org/info/rfc7946/)：GeoJSON 的 WGS 84/CRS84 与经度、纬度坐标顺序。
- [PMTiles for MapLibre](https://docs.protomaps.com/pmtiles/maplibre)：后续 PMTiles protocol 接入方式。
- [PMTiles Concepts](https://docs.protomaps.com/pmtiles/)：基于 HTTP Range Request 的单文件 tile archive 读取模型。
- [deck.gl MapLibre/Mapbox integration](https://deck.gl/docs/api-reference/mapbox/overview)：未来大规模图层、OD/Arc 和 overlay 的可选路径。
- 项目本地 Pi 文档：`node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`、`session-format.md`、`extensions.md`，用于确认 `tool_execution_end.result.details`、`toolResult.details` 和 extension 状态恢复语义。
