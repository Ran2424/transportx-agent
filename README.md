# Pi Traffic Workspace

面向交通分析场景的 Pi Web 工作台。项目基于 [milanglacier/pi-tau-web-server](https://github.com/milanglacier/pi-tau-web-server) 改造，将 Pi 的多会话 Agent 能力、任务协作和 GIS 可视化整合到同一个浏览器界面中。

当前定位是“交通 Agent 工作台底座”：通用 Agent、任务模式和 Web GIS 链路已经可用，真实交通业务工具与结果卡片仍在持续建设。

> 系统边界、目录职责、依赖方向、运行时协议和后续治理统一维护在 [架构与目录治理](./docs/ARCHITECTURE.md)；版本变化和 GitHub 操作见 [修改与操作日志](./docs/CHANGELOG.md)。README 不重复维护详细架构。

## 主要功能

### Pi Agent 工作台

- 同时创建、切换、恢复和关闭多个 Pi RPC 会话。
- 页面刷新不会立即丢失后端运行中的会话。
- 展示模型、思考级别、上下文占用、流式回复、思考过程和工具调用。
- 提供历史会话查看；运行中会话还可浏览文件、项目级 Skill 和 Pi Web Bridge 发布的工具清单。
- 工具调用、思考卡片和代码块支持折叠，并保留必要的执行状态与耗时。

### 任务模式

- 通过顶部“任务”按钮按会话启用或关闭，也支持 `/task on|off|status`。
- `tau_task` 用于创建、修订、更新、完成、失败或取消结构化任务。
- `tau_ask_user` 支持确认、单选、短文本和长文本交互。
- 独立任务卡片展示当前进度，支持拖动、隐藏以及 live/history/resume 恢复。

### GIS 可视化

- Agent 可发布会话目录内的 GeoJSON，并在 Web 端使用 MapLibre 展示。
- 支持点、线、面和文字图层，以及常量、分类、分段和连续视觉编码。
- 支持安全 Popup、图层显隐、选中高亮、在线底图和纯色离线背景。
- 地图资源按会话隔离，不允许任意读取其他任务目录。

### 工作区

右侧工作区可切换查看：

- 文件
- 技能
- 工具
- 地图

新会话默认使用 `scenario/` 下的独立任务目录，适合存放一次分析产生的脚本、GeoJSON 和临时结果；这些本地运行资产默认不会提交到 Git。

当前 Web 新建会话表单仍在 `src/public/app-main.ts` 中以绝对路径保存默认 `scenario/` 根目录。这在本仓库当前路径下可用；如果移动仓库或换机，需要先修改 `DEFAULT_TASK_CWD` 并重新构建。后续应改为由服务端配置下发。

## 功能运行逻辑

1. 浏览器创建或恢复会话。
2. Node.js 服务为该会话管理独立的 `pi --mode rpc` 子进程。
3. Pi Extension 将任务、工具、模型状态和地图结果发布为结构化数据。
4. Web 端按功能适配这些数据，渲染消息、任务卡片、交互框和地图。
5. 会话历史以 Pi JSONL 为事实来源，恢复时只投影当前 `parentId` 分支。

这只是使用者需要了解的高层逻辑。协议、Snapshot、Bridge 和模块依赖详见 [ARCHITECTURE.md](./docs/ARCHITECTURE.md)。

## 产品示意图

![Pi Traffic Workspace overview](docs/images/traffic-workspace-overview.png)

![Thinking and tool cards](docs/images/traffic-workspace-tools.png)

## 快速开始

首次运行：

```bash
npm install
./start.sh
```

`start.sh` 会先构建项目，再以前台进程启动服务，默认地址为：

```text
http://127.0.0.1:3000
```

按 `Ctrl-C` 或关闭当前终端窗口，服务会随之停止。可以使用环境变量修改监听地址和端口：

```bash
TAU_HOST=0.0.0.0 TAU_PORT=3001 ./start.sh --open
```

如果直接启动构建后的 CLI，默认端口为 `3001`：

```bash
npm run build
node bin/tau.js --host 127.0.0.1 --port 3001 --open
```

健康检查：

```bash
curl -s http://127.0.0.1:3000/api/health
```

## 开发与验证

```bash
npm run build
npm run typecheck
npm test
npm run test:pi-smoke
npm run test:browser-smoke
```

- `npm test` 执行默认构建与测试集。
- `test:pi-smoke` 会启动真实 Pi RPC 子进程。
- `test:browser-smoke` 会启动真实 Chrome，验证主要 Web 链路。
- TypeScript 生成的 `bin/*.js`、`public/*.js` 和 `public/geo-runtime.*` 是本地构建产物，不应手工修改或提交。

## 使用注意事项

### 使用正常用户权限启动

服务需要监听本地端口、调用本机 `pi` 命令，并读写 `~/.pi/agent/` 下的配置、信任记录和锁文件。因此应在具有当前用户正常权限的终端运行。

如果从 Codex 或其他文件系统沙箱启动，需要选择“在沙箱外运行”或授予正常系统权限。否则页面可能可以打开，但 Pi 子进程会因为无法创建锁文件而退出，常见报错包括：

```text
EPERM: operation not permitted, mkdir '~/.pi/agent/settings.json.lock'
EPERM: operation not permitted, mkdir '~/.pi/agent/trust.json.lock'
```

遇到这类问题时请停止受限进程并用正常权限重新启动。不要使用 `sudo`，也不要修改 `~/.pi` 的文件归属。

### 服务生命周期

- 不要使用 `nohup`、命令末尾的 `&` 或后台守护方式运行 `start.sh`，否则服务不会再跟随当前终端退出。
- 关闭 Web 页面不会自动关闭服务；关闭启动服务的终端或按 `Ctrl-C` 才会停止服务及其会话子进程。

### Pi 与网络依赖

- 开发依赖固定在 Pi `0.80.10`；运行时接受 `>=0.80.10 <0.81.0`，服务启动时会执行版本检查。
- GIS 的 `default`、`light`、`dark` 底图需要网络；`none` 使用项目内置的纯色离线底图。
- 上海交通数据库等本地数据资产不会进入 Git，换机或重新克隆后需要单独准备。

### 项目提示词与 Skill

- 项目级提示词位于 [`prompts/PI_SESSION_CONTEXT.md`](./prompts/PI_SESSION_CONTEXT.md)，修改后对新建会话生效。
- 项目级 Skill 位于 `skills/`，由服务端显式加载到每个 Web 会话。
- GIS 操作规范见 `geo-visualization-explanation` Skill；不要让 Agent 直接生成不受控的 MapLibre 配置。

## 当前状态与后续方向

已经可用：

- 多会话 Pi Agent Web 工作台。
- 任务模式和 Web 人机交互。
- GeoJSON 发布与 MapLibre 地图展示。
- live/history/resume 的当前分支恢复。
- 完整工具 Manifest 和模型/thinking 状态桥接。

后续重点：

- 按既定方案迁移 React、Vite、shadcn/ui、Radix UI 和 Motion。
- 增加交通 Prompt、业务工具和结构化交通结果卡片。
- 扩展 GIS 图例、过滤、栅格、矢量瓦片、时序和地图到 Agent 的反向交互。
- 接入真实交通数据库或外部 API，形成可复用的交通分析任务模板。

详细阶段划分以 [架构文档](./docs/ARCHITECTURE.md) 为准；已经完成的提交与验证记录以 [CHANGELOG](./docs/CHANGELOG.md) 为准。

## 与上游的关系

本项目作为独立产品仓库维护，同时保留 `upstream` 指向原始项目。同步上游功能时应选择性 merge 或 cherry-pick，避免覆盖当前交通工作台的扩展与界面改造。

## License

MIT
