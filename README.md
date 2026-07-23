# Pi Traffic Workspace

面向交通分析的 Pi Agent 工作台。它在一个浏览器界面中管理 Pi RPC 会话、结构化任务、会话文件和地图结果。

项目采用单仓库、模块化单体：Pi Extension 负责产生受控数据，Node 服务负责会话与资源边界，React 负责交互和展示。当前没有第二套 Web UI 或回退入口。

## 能做什么

- 创建、切换、恢复和关闭多个 Pi RPC 任务；历史会话按最后一次对话时间排序。
- 展示流式回复、思考过程、工具执行与上下文状态。
- 用 `tau_task` 与 `tau_ask_user` 管理任务步骤和用户交互。
- 按会话浏览并预览代码、表格、Markdown 报告和图片；预览窗口可拖动、缩放、并行打开。
- 发布受会话目录约束的 GeoJSON，并按需加载 MapLibre 地图。

## 快速开始

```bash
npm install
./start.sh
```

默认地址：<http://127.0.0.1:3000>。

也可手动构建并启动：

```bash
npm run build
node bin/tau.js --host 127.0.0.1 --port 3001 --open
```

开发 React 页面时，另开终端运行：

```bash
npm run dev:web
```

它会代理 API 和 WebSocket 到 `127.0.0.1:3000`。

## 验证

```bash
npm run typecheck
npm test
npm run test:react-smoke
npm run test:pi-smoke
```

- `npm test`：构建并运行 49 个默认测试，覆盖共享契约、会话投影、HTTP/WebSocket、鉴权 Cookie、任务 Extension 生命周期、Geo 资源隔离和 Markdown 安全渲染。
- `test:react-smoke`：真实 Node 服务、fake Pi 和 Chrome 的 React 工作台冒烟。
- `test:pi-smoke`：真实本机 Pi RPC 离线冒烟；它会启动子进程，不纳入默认测试。

`bin/`、`public/*.js`、`public/geo-runtime.*` 和 `dist/web/` 都是本地生成物，不手工编辑或提交。

## 运行约束

- 用当前用户权限启动；服务需要访问本机 `pi`、`~/.pi/agent/` 和任务目录。不要用 `sudo`。
- 新建任务默认位于仓库 `scenario/` 下，每次任务独立目录；这些运行资产默认不进入 Git。
- 在线底图需要网络；GeoScene 的 `none` 底图可离线使用。
- 本机交通数据库、密钥和原始数据资产不在仓库内，换机后需单独准备。

## 文档

- [架构与目录治理](./docs/ARCHITECTURE.md)：当前系统边界、依赖方向和模块职责。
- [React UI 改造 ADR](./docs/REACT_UI_MIGRATION_PLAN.md)：已完成的迁移决策与删除 legacy 的记录。
- [版本修改与 GitHub 操作日志](./docs/CHANGELOG.md)：发布与提交历史。
- [测试基线](./docs/TEST_BASELINES.md)：默认测试与浏览器验证范围。

## License

MIT
