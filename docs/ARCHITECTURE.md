# Pi Traffic Workspace 架构与目录治理

更新时间：2026-07-23

本项目是单仓库、单 npm 包、单 Node 服务的模块化单体。它服务于本地 Pi Agent 工作流：不为了理论上的扩展性拆分微服务，也不维护第二个 Web 应用。

## 系统边界

```text
Pi Extensions
  ├─ pi-task-mode             任务状态与用户交互
  ├─ pi-geo-visualization     GeoJSON 与声明式地图
  └─ pi-web-bridge            工具、模型和能力快照
             │ JSONL / RPC
             ▼
Node Server
  ├─ server-main              认证、RPC、依赖装配
  ├─ static-handler           React 静态资源与 SPA fallback
  ├─ session-history-handler  JSONL 历史、搜索、项目列表
  ├─ file-api-handler         会话范围内的文件、预览与本机打开
  ├─ websocket-handler        同源升级、连接与心跳
  └─ api-routes               类型化 HTTP 路由表
             │ HTTP / WebSocket
             ▼
React Workspace
  ├─ Browser Application Kernel
  │   ├─ Event normalizer / Command ports
  │   └─ Runtime / Session / Conversation / Tool / Extension UI stores
  ├─ Conversation、Session、Settings、File Preview
  └─ Task Board、lazy Geo Workspace
```

## 核心决策

### 1. 共享契约先于适配器

`src/contracts/` 是 SessionSnapshot、TaskSnapshot、GeoScene、Bridge、诊断与版本的唯一权威。Extension、Server、React 都可以依赖它；契约不得依赖 Node、React、DOM 或 MapLibre。

### 2. JSONL 是历史事实来源

Pi JSONL 记录会话历史。服务端通过 `SessionProjection` 只选择最后叶节点所属分支；浏览器端仅维护实时 overlay 来减少展示延迟。刷新或恢复后，Snapshot 会重新成为权威。

### 3. React 是唯一 UI

React 页面是唯一的生产 Web 入口。`src/public/` 不再承载手写 DOM 页面，保留 Browser Kernel、WebSocket client、Markdown、工具格式化和 Geo runtime 等可复用浏览器基础设施。迁移背景见 [React UI ADR](./REACT_UI_MIGRATION_PLAN.md)。

### 4. 服务端按 handler 分边界

`server-main.ts` 只处理顶层认证、RPC 命令和依赖装配。任何新 HTTP 行为先放入 `api-routes.ts`，再进入对应 handler；不要重新把文件扫描、静态文件或 WebSocket 逻辑塞回组合入口。

### 5. 会话目录是权限边界

文件、预览、原生打开和 Geo 资源都必须通过 active session 的 cwd 解析。历史 JSONL 只能在 Pi session 根目录中读取；Geo 资源只能在发布它的 live session 下访问。路径穿越、符号链接越界和跨会话资源读取必须拒绝。

## 目录职责

```text
src/
  contracts/                   跨边界协议和纯校验
  server/
    server-main.ts             认证、RPC、装配和 CLI 生命周期
    api-routes.ts              HTTP 路由表
    static-handler.ts          React 静态入口
    session-history-handler.ts JSONL 历史、搜索、项目聚合
    file-api-handler.ts        文件/资源/预览 API
    websocket-handler.ts       WebSocket 生命周期
    sessions.ts                Pi 子进程与 live session 管理
    session-projection.ts      当前 JSONL 分支投影
    geo-resources.ts           Geo 数据资源路由
  public/
    kernel/                    Browser Application Kernel
    app-types.ts               浏览器共享类型
    markdown.ts                安全 Markdown 基础渲染
    tool-result.ts             工具结果文本格式化
    websocket-client.ts        Browser transport adapter
    visualization/geo/         MapLibre runtime（按需加载）
  web/                         React/Vite 应用
    app/                       Composition root、Provider、Shell
    platform/                  对话、会话、设置、文件等平台 UI
    features/                  Task 与 Geo React feature
    components/, lib/          纯 UI 基元与工具

extensions/                    Pi 侧工具和状态适配器
prompts/                       会话启动提示模板
skills/                        项目级 Pi Skill
public/icons/                  静态图标源文件
dist/web/                      Vite 生产物（不跟踪）
scenario/                      本地任务工作区（不跟踪）
```

## 依赖方向

```text
Extension / Server / React ──> contracts
server-main ─────────────────> handlers + sessions + api-routes
React components ────────────> Kernel stores + Command ports
React Geo runtime ───────────> contracts + maplibre-gl
```

反向依赖不允许出现：契约不能导入平台代码；Kernel 不能导入 React 组件；handler 不能依赖 UI；React 组件不能直接解析原始 Pi RPC 消息。

## 演进规则

1. 新功能先定义或复用契约，再实现 Extension、Server 与 React 的各自适配器。
2. 默认测试不超过 50 项。增加测试前先判断能否替换低价值的静态/状态码检查。
3. `server-main.ts` 只做装配；新增 API 放入 handler，路由声明放入 `api-routes.ts`。
4. 大型 Geo runtime 保持按需加载；只有性能数据表明确问题时才拆分更多 bundle。
5. 历史列表当前按需扫描 JSONL；当真实会话量造成可观察延迟时，再引入会话索引缓存，而不是提前建立数据库。
