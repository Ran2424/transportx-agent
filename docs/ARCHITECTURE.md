# Pi Traffic Workspace 架构与目录治理

更新时间：2026-07-20

## 1. 架构决策

项目维持单仓库、单 npm 包和单 Web 服务，采用 **模块化单体 + 垂直功能切片 + Ports/Adapters**，而不是现在拆成两个仓库或两个应用。

两个主要工作域是：

1. **Agent Web 平台**：管理 Pi RPC 子进程、会话、历史、消息、工具卡片、文件和工作区 UI。
2. **GIS 可视化模块**：通过 Pi Extension 生成受控 GeoScene，经会话和资源接口传到浏览器，再由 MapLibre 渲染。

GIS 是第一个跨边界功能切片。它依赖平台提供的会话、工具结果和右侧工作区；平台核心不应依赖 MapLibre 或交通领域语义。后续每项能力都按同一结构落地：

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

- GeoScene 协议出现第二个独立消费者。
- GIS Runtime 需要独立版本和发布节奏。
- Web 前端与服务端需要分别部署。
- 单包构建或测试耗时已经造成明确工程问题。

## 2. 系统链路

```text
Browser Agent Web UI
  ├─ app-main（平台组合入口）
  ├─ WorkspaceController（右侧工作区壳层）
  └─ FeatureRegistry
       └─ GeoFeature（GIS Web Adapter）
            └─ VisualizationHost
                 └─ MapLibreGeoRuntime
              ▲
              │ VisualizationEnvelope / GeoScene
Node Web Server
  ├─ HTTP + WebSocket + RPC 路由
  ├─ LiveSessionManager
  └─ Session-scoped Geo Resource API
              ▲
              │ JSONL RPC / toolResult.details
Pi Agent Child
  └─ pi-geo-visualization Extension
       ├─ publish_geodata
       └─ present_visualization
```

GeoScene 是跨边界的共享契约。它必须保持声明式、可验证且不携带 JavaScript、HTML、CSS、任意 URL 或 MapLibre 原生表达式。

## 3. 当前目录职责

```text
src/
  server/                         Agent Web 服务端核心
    server-main.ts                HTTP、WebSocket、RPC 的组合入口；功能路由在适配器实现
    sessions.ts                   Pi 子进程和 live session 生命周期
    auth.ts                       浏览器会话认证
    config.ts                     环境、目录和扩展定位
    model-utils.ts                模型标识与列表解析
    geo-resources.ts              GIS 的服务端适配器

  public/                         浏览器端源码
    app-main.ts                   应用组合入口与平台级会话事件接线
    app-types.ts                  浏览器端平台类型
    workspace/                    Web 工作区壳层
      workspace-controller.ts     文件/资源/功能视图切换与侧栏生命周期
      workspace-types.ts          功能可依赖的最小工作区端口
    features/                     Web 垂直功能适配器
      feature-registry.ts         功能注册和会话/工具结果生命周期分发
      geo/geo-feature.ts          GIS 对平台的唯一组合入口
    visualization/               通用声明式可视化子系统
      visualization-host.ts      Scene 存储、地图视图与 Runtime 桥接
      session-visualization-store.ts
      geo/
        protocol.ts               GeoScene 共享契约（当前物理位置）
        geo-runtime-entry.ts      MapLibre Runtime 唯一入口

extensions/
  pi-geo-visualization/           Agent 侧 GIS 工具适配器

public/                           Web 发布目录
  index.html                      手写静态入口
  style.css                       手写全局样式
  icons/                          手写/设计源静态资产
  *.js, features/, visualization/,
  workspace/                     编译产物，不跟踪
  geo-runtime.*                  编译产物，不跟踪

test/                             Node 测试；文件名前缀对应模块
docs/                             工程文档与截图资产
scenario/                         本地任务工作区，不跟踪
```

`protocol.ts` 逻辑上属于共享契约，但暂时保留在浏览器输出路径内，因为当前前端采用 TypeScript 逐文件编译。为了目录形式强行迁移它，会连带改变发布路径和构建系统。等出现第二个 Runtime 或独立协议包需求时，再提取为 `packages/geo-protocol`。

## 4. 依赖方向

允许的依赖：

```text
server-main ───────> server core + feature route adapters
app-main ──────────> platform controllers + FeatureRegistry
FeatureRegistry ───> WorkspaceRegistration（最小端口）
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
| GIS 会话资源 | `src/server/geo-resources.ts`、服务端路由接入点 | `test/http-routes.test.ts` |
| GIS 平台接入 | `src/public/features/geo/geo-feature.ts` | `test/feature-registry.test.ts` + 浏览器验收 |
| 地图 Scene 与渲染 | `src/public/visualization/`、GIS 样式区 | 协议测试 + 真实浏览器视觉验收 |

跨越三个以上区域的改动应在 PR 描述中明确说明数据从哪里产生、通过哪个契约传输、最终在哪里消费。

## 6. 资产与生成物规则

### 跟踪到 Git

- TypeScript 源码、Extension 源码和测试。
- `public/index.html`、`public/style.css`、`public/icons/` 等静态源资产。
- `docs/` 内的长期文档和正在使用的截图。
- package、TypeScript 和容器配置。

### 不跟踪到 Git

- `bin/*.js`、`public/*.js`、`public/visualization/`、`public/geo-runtime.*` 等构建产物。
- `scenario/`、`.tau/`、Pi session HTML 和本地 Agent 配置。
- 临时 GeoJSON、性能日志、浏览器截图和一次性分析输出。

源码变更后的标准验证顺序：

```bash
rtk npm run typecheck
rtk npm test
```

`npm test` 会重新生成运行所需的服务端、浏览器端和 MapLibre bundle。不要手工修改编译后的 JavaScript。

## 7. 增长控制

当前需要重点控制三个组合文件：

- `src/public/app-main.ts`：新增功能先实现 `WebFeature`；入口只实例化、注册并转发平台事件。
- `src/server/server-main.ts`：新增 API 先实现为返回 `boolean`（是否命中）的独立 route handler，再由入口挂载。
- `public/style.css`：新功能样式使用稳定前缀集中成段；下一次实质性 UI 模块增加时，再引入 CSS 分文件构建。

不以行数机械拆分文件。只有出现独立职责、独立测试或第二个调用方时才抽模块。

## 8. 分阶段治理路线

### 阶段 A：治理层（已完成）

- 建立本架构文档和文档索引。
- 统一模块化构建命令、资产规则和仓库元数据。
- 建立 `WorkspaceController`、`FeatureRegistry` 与 `GeoFeature` 三层 Web 集成点。
- 将 GIS 资源 URL 的识别、解码和会话查找移入 `geo-resources.ts`。

### 阶段 B：继续瘦身组合入口

- 按独立职责逐步从 `app-main.ts` 提取附件、输入、会话视图 controller；每次只提取一个可独立验证的职责。
- 按资源域继续从 `server-main.ts` 提取 route adapter；不进行一次性重写。
- 将 GIS CSS 从全局样式中抽为源码片段，并由构建流程合并；不直接增加运行时请求数量。

### 阶段 C：构建系统升级（独立变更）

- 引入 Vite，将浏览器源码和发布目录分开，获得模块图、静态资产处理和 CSS code splitting。
- 保留现有 Node 服务；Vite 只负责 Web build/dev，不与服务端框架迁移绑在一次改动里。
- 迁移前先增加关键浏览器路径的自动化验收，避免构建系统变化掩盖行为回归。
- React、shadcn/ui、Radix 和 Motion 的完整边界及分阶段计划见 [REACT_UI_MIGRATION_PLAN.md](./REACT_UI_MIGRATION_PLAN.md)。

### 阶段 D：共享契约包

仅当出现第二个消费者时，将 GeoScene 协议提取为独立包；Extension、Web Runtime 和测试共同依赖该包。此前不引入 workspace 和包间版本管理。

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
- **Web UI 框架**：暂不迁移 React/Vue。当前风险来自职责和生命周期混在入口文件，不是 DOM 渲染能力不足；先稳定 Feature 与 Workspace 边界。
- **Web 构建工具**：Vite 是下一阶段的合适选择，用于源码/发布目录分离、CSS 模块化和按需加载；应作为独立迁移完成。
- **Server 框架**：不立即迁移 Fastify。其插件封装和作用域依赖模型值得借鉴，但当前 raw Node 服务已有大量稳定路由，替换框架会把治理变成重写。
- **Monorepo/workspaces**：当前不引入。只有共享契约产生第二个独立消费者或独立发布需求时才拆包。

## 11. 变更验收

目录或架构治理必须同时满足：

- `npm run typecheck` 通过。
- `npm test` 全部通过。
- npm 发布清单仍包含 Extension、源码和 GIS 技术方案。
- 编译产物、本地会话与 `.tau` 资源没有进入 Git。
- Agent Web 的非地图会话不加载 MapLibre bundle。
- GIS 工具结果仍可在 live、历史恢复和 resume 场景中显示。
