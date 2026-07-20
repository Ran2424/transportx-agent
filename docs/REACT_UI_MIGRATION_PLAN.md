# React UI 迁移评估与实施方案

更新时间：2026-07-20

状态：建议实施，尚未开始迁移

## 1. 结论

本项目适合迁移到 React。随着 GIS、图表、结构化交通结果卡片和更多 Agent 交互进入 Web 端，声明式组件、统一状态管理和可访问的交互原语会逐步产生明显收益。

迁移难度为中高，约为 `7/10`。困难不在 React 语法或 shadcn/ui，而在于完整保留以下已有行为：

- 多个 Pi RPC 会话的创建、切换、恢复和关闭。
- WebSocket 断线重连、流式消息和工具调用增量更新。
- 历史会话、live snapshot 和 resume 三种消息恢复路径。
- Extension UI 请求排队、暂停和响应。
- 文件、技能、工具和地图工作区。
- MapLibre Runtime 的按需加载、会话隔离和生命周期。
- 六套主题、移动端布局和可访问性设置。

不建议一次性重写。推荐先建立 Vite/React 基座，再按可独立验收的 UI 区域渐进迁移。React 官方支持把 React 逐步加入已有页面，并从小型交互组件向上扩大接管范围。

## 2. 当前项目基线

迁移评估基于当前代码，而不是一个理想化的新项目：

| 区域 | 当前规模 | 特征 |
|---|---:|---|
| 浏览器端源码 | 约 12,300 行 | 原生 TypeScript + 直接 DOM 操作 |
| `src/public/app-main.ts` | 2,433 行 | 平台状态、WebSocket 事件、会话和 UI 编排 |
| `public/style.css` | 4,515 行 | 六套主题、响应式布局和全部组件样式 |
| `public/index.html` | 292 行 | 页面骨架、所有 Overlay、Dialog 和工作区容器 |
| `tool-card.ts` | 643 行 | 工具状态、折叠、Diff、图片和增量更新 |
| `session-sidebar.ts` | 594 行 | 历史/live 会话、搜索和分组 |
| `message-renderer.ts` | 398 行 | Markdown、thinking 和消息 DOM |

当前 UI 模块普遍直接持有 `HTMLElement`，并通过 `innerHTML`、`classList`、`onclick` 和 `addEventListener` 更新。这些模块不能直接作为 React 组件复用，但其中的纯函数、协议和数据格式可以保留。

### 2.1 可直接保留

- `src/server/` 下的 Node Server、HTTP API、WebSocket 和会话管理。
- `extensions/` 下的 Pi Extension。
- `src/public/app-types.ts` 中与 DOM 无关的协议类型。
- `WebSocketClient` 的连接、重连和消息传输能力。
- GeoScene 与 VisualizationEnvelope 校验逻辑。
- MapLibre Geo Runtime。
- Markdown、工具输出格式化和路径图标等纯函数。
- FeatureRegistry 的“平台只注册功能、不识别功能内部逻辑”这一架构原则。

### 2.2 需要适配

- `WebSocketClient`：保留传输层，在外部增加 typed action adapter。
- `FeatureRegistry`：从 `HTMLElement` 面板注册改为 React 组件描述注册。
- `VisualizationHost`：拆成 React hook/controller，内部继续调用现有 MapLibre Runtime。
- 主题：保留现有 CSS variables，映射到 shadcn/Tailwind token。
- Service Worker、manifest 和 icons：调整为 Vite 静态资产输入。

### 2.3 需要重写

- `app-main.ts` 中的平台 UI 状态和 DOM 接线。
- 静态 `index.html` 中的应用结构。
- Message、Thinking、ToolCard、SessionSidebar、Dialog、Command 和 Workspace 的 DOM Renderer。
- 直接使用 `.hidden`、`.expanded` 和 `classList.toggle()` 的交互状态。

## 3. 目标技术栈

```text
React + TypeScript
Vite
Tailwind CSS
shadcn/ui（Radix base）
Motion for React
现有 Node Server / WebSocket / Pi Extension / MapLibre
```

暂不引入 React Router。当前产品是单页工作台，没有 URL 路由需求。暂不引入 Redux；先用一个可测试的外部 store 和 React 官方订阅接口承接现有事件模型，只有状态复杂度继续增加时再评估第三方状态库。

### 3.1 UI 组件分层

业务代码统一从项目内的 `components/ui/*` 导入组件，不在 Feature 中混用 raw Radix 和 shadcn：

| 组件 | 统一入口 | 底层职责 |
|---|---|---|
| Button、Card、Badge、Input | shadcn/ui | 视觉变体和 design token |
| Dialog、Tabs、Collapsible | shadcn/ui | Radix 的焦点、键盘和受控状态 |
| Tooltip、DropdownMenu、Popover | shadcn/ui | Radix 的 Portal、定位和 dismissal |
| Command | shadcn/ui | `cmdk` 搜索与键盘导航 |
| Agent 状态、列表增删、布局变化 | Motion for React | 进入/退出、共享布局和状态过渡 |
| hover、颜色和简单旋转 | CSS transition | 低成本微交互 |

shadcn/ui 是项目内可修改的组件源码，而不是需要围绕其黑盒 API 二次包装的组件包。初始化时固定选择 Radix base，并让 CLI 管理具体依赖。

### 3.2 视觉方向

目标不是套用通用 SaaS Dashboard，而是延续“精密、克制、专业交通运行台”的产品气质：

- 消息区保持低干扰，GIS 和结构化结果是主要视觉焦点。
- 蓝色用于平台交互，绿色/橙色/红色只表达运行语义。
- 保留较高的信息密度，但通过间距、层级和状态运动建立秩序。
- shadcn 默认样式只作为无障碍和结构起点，颜色、圆角、阴影和排版使用本项目 token。

## 4. 目标目录

保持单仓库和单 npm 包，不因为 React 引入 monorepo：

```text
src/
  server/                         现有服务端，保持不动
  web/
    main.tsx                      React 启动入口
    app/
      App.tsx                     Provider 和总体布局
      providers.tsx

    components/
      ui/                         shadcn 生成并由项目维护
      shell/                      Header、Sidebars、AppLayout

    features/
      agent-status/
      sessions/
      chat/
      tool-execution/
      workspace/
      geo/
      settings/

    runtime/
      websocket-client.ts
      agent-runtime.ts            RPC/Event -> typed action
      feature-registry.ts

    store/
      app-store.ts
      selectors.ts

    lib/
      markdown.ts
      formatting.ts

web/
  index.html                      Vite HTML 入口
  static/                         manifest、icons 等原始静态资产

public/                           Vite 构建输出，仅用于运行和发布
extensions/                       Pi Extension，保持不动
```

源码和发布目录必须分离。Vite 构建不得把输出写回正在维护的源码目录，也不能删除 npm 包运行所需的 Extension 和服务端产物。

## 5. 状态与运行时设计

### 5.1 数据流

```text
WebSocket / HTTP / Browser Event
              ↓
AgentRuntime（解析、归一化、产生 typed action）
              ↓
AppStore（不可变 snapshot）
              ↓
React selector hooks
              ↓
Feature Components
```

不要让 React 组件直接解析 Pi event，也不要在各个组件中分别监听 WebSocket。现有 `WebSocketClient extends EventTarget` 可以保留，由 `AgentRuntime` 统一订阅并转换成领域 action。

Store 至少按以下状态域组织：

- `connection`：连接、重连、认证和错误。
- `sessions`：live/history 列表、当前会话和 snapshot。
- `conversation`：messages、streaming、thinking 和 tool executions。
- `composer`：输入、附件和消息队列。
- `workspace`：活动视图、文件路径和功能面板状态。
- `preferences`：主题、thinking 显示和自动压缩设置。
- `extensionUi`：当前请求和后台会话请求队列。

React 通过 `useSyncExternalStore` 或等价的 selector hook 订阅稳定 snapshot。高频 token delta 只更新当前 StreamingMessage，不触发会话栏、工作区和历史消息整体重渲染。

### 5.2 Feature 接口

React 版本继续保留现有垂直功能切片原则：

```ts
type WebFeature = {
  id: string;
  workspace?: {
    title: string;
    icon: React.ComponentType;
    Component: React.ComponentType;
  };
  handleToolResult?: (context: FeatureToolResultContext) => FeatureResult | null;
};
```

`App.tsx` 只组合平台 Provider、Layout 和 Feature Registry。新增 GIS、图表或交通卡片时，不允许向入口增加工具名判断和专用 DOM 逻辑。

## 6. GIS 与 MapLibre 迁移边界

MapLibre 是命令式 Canvas Runtime，不应为了 React 而重写：

1. `GeoWorkspace` 渲染一个稳定的 container ref。
2. `useGeoRuntime` 在 `useEffect` 中创建 Runtime，并在 cleanup 中销毁。
3. Scene、selection 和 layer visibility 通过明确方法同步给 Runtime。
4. MapLibre bundle 继续 dynamic import，非地图会话不加载地图依赖。
5. GeoScene protocol、Pi Extension 和服务端资源 API 保持原样。

迁移的是地图外壳、工具栏、图层列表和会话选择，不是地理渲染引擎。

## 7. Agent 状态模型与动画

Agent 状态不能压缩成一个字符串。连接状态和活动状态是两个正交维度：

```text
ConnectionState:
  connecting | connected | disconnected

ActivityState:
  idle | thinking | tool-running | streaming |
  waiting-user | compacting | complete | error
```

例如 Agent 可以同时处于 `connected + thinking`，断线重连也不应伪装成某种 Activity。

### 7.1 动画规范

| 状态/事件 | 视觉反馈 | 实现 |
|---|---|---|
| connecting | 状态点缓慢呼吸 | CSS keyframes |
| thinking | 低频光环扩散，文字交叉淡入 | CSS + AnimatePresence |
| tool-running | 状态条方向性移动高光 | CSS |
| streaming | 当前消息轻量淡入、游标流动 | CSS；禁止整个列表 layout animation |
| waiting-user | 暖色提示环出现一次 | Motion variant |
| complete | 短暂 check morph 后回到 idle | AnimatePresence |
| error | 一次轻微横向震动，随后保持静态红色 | Motion variant |
| 会话切换 | 内容淡出后淡入 | AnimatePresence `mode="wait"` |
| 动态会话 Tabs | 活动指示条平滑移动 | `layoutId` |
| ToolCard 新增/完成 | 透明度与高度协调变化 | `layout` + AnimatePresence |
| 工作区切换 | 轻微水平位移和淡入 | Motion variant |

Motion 只用于有状态意义的变化，不给每个 Button 和 Card 增加无目的动画。保留并验证 `prefers-reduced-motion`；减少运动时使用无位移的透明度变化或直接切换。

## 8. 分阶段迁移

### 阶段 0：行为基线

- 为新建/切换/resume/关闭会话增加浏览器测试。
- 覆盖流式消息、tool start/update/end 和 Extension Dialog。
- 覆盖地图工具结果打开、会话切换和历史恢复。
- 保存桌面与移动端关键页面截图作为视觉基线。

验收：当前原生 UI 的核心行为有自动化或明确的手工验收清单。

### 阶段 1：构建和 Design System

- 增加 Vite React TypeScript 构建，不改 Node API。
- 初始化 Tailwind 和 shadcn/ui，固定 Radix base。
- 将现有主题变量映射到 shadcn token。
- 建立 Button、Card、Badge、Dialog、Tabs、Tooltip、Dropdown 和 Collapsible。
- 继续保留现有全局 CSS，不在此阶段批量改写 4,500 行样式。

验收：React 示例页面可以由现有 Node Server 提供，主题切换和生产构建通过。

### 阶段 2：低耦合 Overlay

- 先建立一个 `react-overlays` root。
- 迁移 Settings、Model Picker、New Session Dialog 和 Command Palette。
- 迁移 Extension Dialog，并保持后台会话请求排队行为。
- 每迁移一个 Overlay，删除对应旧 DOM 和事件处理，不让两套实现同时响应。

验收：焦点锁定、Esc、点击外部关闭、键盘导航和移动端行为与原实现一致或更好。

### 阶段 3：平台 Shell 与状态层

- 建立 AgentRuntime、AppStore 和 selector hooks。
- 迁移 Header、AgentStatus、左侧会话栏、live tabs 和 Composer。
- 把 `app-main.ts` 中会话和连接状态转成 action/reducer。
- 接入 Agent 状态动画，并验证 reduced motion。

验收：多会话切换、断线重连、输入队列、附件和设置均可用。

### 阶段 4：消息与工具卡片

- 迁移 MessageList、StreamingMessage、ThinkingBlock 和 ToolCard。
- 复用现有 Markdown、输出截断、Diff 和图片识别纯函数。
- 将 Collapsible 状态交给组件，不再通过 inline `onclick` 操作 DOM。
- 隔离高频 streaming 更新，使用 memo/selector 控制重渲染范围。

验收：live、history 和 resume 三条路径渲染一致；长工具输出和连续 token 不产生明显卡顿。

### 阶段 5：Workspace 与 GIS

- 将 WorkspaceController 转为 React Layout + Tabs。
- 将 FeatureRegistry 改成组件描述注册。
- 迁移文件、技能、工具和 GeoWorkspace。
- 用 ref/effect 接入现有 MapLibre Runtime，保持动态加载。

验收：非地图会话不下载 MapLibre chunk；资源仍受 live session 和 cwd 限制。

### 阶段 6：收尾

- 删除旧 Renderer、废弃 HTML 容器和已迁移 CSS。
- 完成桌面、移动端、键盘和主题视觉回归。
- 更新 ARCHITECTURE、README 和 PROJECT_HANDOFF。
- 对生产 bundle 进行分包和体积检查。

验收：旧入口被删除，完整测试和 npm 发布清单通过。

## 9. 工作量估算

以一名熟悉 React 的前端工程师、包含回归验证估算：

| 工作项 | 估算 |
|---|---:|
| Vite、React、Tailwind、shadcn 和主题基座 | 2–4 人日 |
| Runtime、Store 和 WebSocket action | 4–6 人日 |
| Shell、Session、Dialog 和 Command | 5–8 人日 |
| Streaming、Thinking 和 ToolCard | 7–10 人日 |
| Workspace、FeatureRegistry 和 GIS | 3–5 人日 |
| 移动端、无障碍、动画和回归 | 4–7 人日 |
| **总计** | **25–40 人日** |

单人达到现有功能完整对等约需 5–8 周。只制作 React 外壳演示约需一周，但不能据此判断完整迁移已经完成。

## 10. 主要风险与控制

### 高频流式更新

风险：每个 token 更新导致整个 App 重渲染。

控制：按 selector 订阅；当前 StreamingMessage 独立；历史消息不可变；不要把所有状态塞入一个 Context value。

### 双实现冲突

风险：React 与旧脚本同时修改一个 DOM subtree 或同时响应快捷键。

控制：以完整 subtree 为迁移单元；同一区域只有一个 owner；每阶段删除对应旧事件绑定。

### CSS 冲突

风险：Tailwind preflight、shadcn token 和 4,500 行全局 CSS 相互覆盖。

控制：先映射 token，保留旧 class；限制 reset 范围；只删除已迁移选择器；用视觉回归检查六套主题。

### MapLibre 生命周期

风险：React StrictMode、会话切换或 panel 隐藏造成重复实例、错误 resize 或事件泄漏。

控制：Runtime 创建/销毁幂等；effect cleanup 完整；地图 container 保持稳定；面板显示后调用 resize。

### 构建和 npm 发布

风险：Vite 清空输出目录，丢失静态资产或 npm 包运行文件。

控制：源码/输出分离；明确 `emptyOutDir` 和 copy 规则；继续执行 `npm pack --dry-run` 验证发布清单。

### 无浏览器回归测试

风险：类型检查和 Node 测试通过，但焦点、滚动、动画和移动布局退化。

控制：迁移前增加 Playwright 核心流程和截图测试；每阶段保留手工真机验收。

## 11. 实施决策

满足以下条件后开始阶段 1：

- 当前 GIS 与目录治理版本已进入 `main`。
- 核心 live session 和地图链路有稳定基线。
- React 迁移使用独立分支或 PR，不与新的 GIS 协议能力同时开发。
- 第一项垂直切片限定为 Design System + AgentStatus + 一个 Dialog，不直接重写聊天主链路。

如果第一切片无法在保持现有 Node Server 和 Pi 会话协议不变的情况下落地，应先修正边界设计，而不是扩大重写范围。

## 12. 官方参考

- [React：向现有项目添加 React](https://react.dev/learn/add-react-to-an-existing-project)
- [React：useSyncExternalStore](https://react.dev/reference/react/useSyncExternalStore)
- [shadcn/ui：Vite 安装](https://ui.shadcn.com/docs/installation/vite)
- [shadcn/ui：组件源码与组合原则](https://ui.shadcn.com/docs)
- [shadcn/ui：Command](https://ui.shadcn.com/docs/components/radix/command)
- [Radix Primitives：介绍](https://www.radix-ui.com/primitives/docs/overview/introduction)
- [Motion for React：安装](https://motion.dev/docs/react-installation)
- [Motion for React：AnimatePresence](https://motion.dev/docs/react-animate-presence)
- [Motion for React：Layout Animation](https://motion.dev/docs/react-layout-animations)
