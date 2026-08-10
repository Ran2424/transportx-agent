# ADR：React 成为唯一 Web UI

- 日期：2026-07-23
- 状态：已采纳并实施

## 背景

早期项目以手写 DOM 页面为主。React 改造期间，旧页面被保留在独立路径，导致两套 UI、构建链路、样式和浏览器回归长期并存。它们消费同一会话状态，却有不同的渲染和维护成本。

## 决策

1. React/Vite 是唯一 Web 入口，生产页面由 `dist/web/` 提供。
2. Browser Application Kernel 仍是会话、实时事件、Snapshot 和 Command Port 的唯一应用语义层；React 组件不直接拼装 Pi RPC 或 WebSocket 协议。
3. 删除 legacy DOM 入口、全局样式、Service Worker、旧 Feature Registry、旧工作区渲染器及其回退浏览器脚本。
4. 共享契约保留在 `src/contracts/`，Web、Server 和 Extension 都直接依赖它；不再保留为旧页面服务的协议重导出层。
5. React 冒烟测试承担浏览器级关键路径回归；默认 Node 测试保持 49 项，并优先覆盖安全边界和状态生命周期。

## 结果

- 默认路径只会加载 React 应用，`/legacy/` 不再存在。
- `src/public/` 只保留 Browser Kernel、跨 UI 的浏览器工具、Geo runtime 和类型；DOM renderer 已删除。
- `server-main.ts` 只负责认证、RPC 与装配。静态资源、会话历史、文件 API、WebSocket 分别由独立 handler 管理。
- 文件报告 Markdown 在渲染前转义原始 HTML，并限制链接与图片协议；相关测试覆盖脚本和 `javascript:` URL。

## 不做的事

- 不引入 Redux、React Query 或独立前端服务。当前实时状态由 Kernel 和 WebSocket 驱动。
- 不拆成多仓库或微服务。单包部署仍然最适合本地 Pi 工作台。
- 不因删除 legacy 改变 HTTP、WebSocket、JSONL 或 Extension 协议。

旧的阶段计划至此归档；当前架构以 [ARCHITECTURE.md](../../ARCHITECTURE.md) 为准。
