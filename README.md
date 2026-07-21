# Pi Traffic Workspace

一个面向交通分析场景的 Pi Web 工作台。项目基于 [milanglacier/pi-tau-web-server](https://github.com/milanglacier/pi-tau-web-server) 改造，保留其独立 Web Server 和多 Pi RPC 会话架构，并在此基础上做了中文化、界面整理和交通工作台方向的产品化探索。

> 当前阶段更接近“交通 Agent 工作台底座”：已经具备多会话、工具调用、思考过程、文件浏览、技能/工具查看等通用能力；真实交通数据、交通专用工具和业务结果卡片仍在规划中。

## 核心形态

```text
Browser UI
  <-> HTTP / WebSocket
Pi Traffic Workspace Server
  <-> JSONL RPC
pi --mode rpc child session 1
pi --mode rpc child session 2
pi --mode rpc child session N
```

相比把一个终端 Pi 会话镜像到浏览器，这个项目更像一个浏览器里的多任务工作台：浏览器负责展示与交互，Node.js Server 负责管理多个 `pi --mode rpc` 子进程，后端 Pi 会话不会因为页面刷新而立刻丢失。

## 主要能力

- 多个 Pi RPC 会话并行运行、切换、恢复和关闭。
- 左侧会话栏同时展示历史会话和运行中会话。
- 顶部任务标签页、模型选择、思考级别、上下文统计。
- Codex 风格的白色 / 淡蓝简洁 UI。
- 思考卡片与工具调用卡片的统一视觉展示。
- 工具调用耗时、思考耗时展示，并尽量在历史会话中恢复。
- 代码块和渲染卡片支持折叠 / 展开。
- 右侧工作区面板支持切换查看：
  - 文件
  - 技能
  - 工具
  - 地图
- 内置 Pi GIS Extension，Agent 可发布会话内 GeoJSON，并在 Web 端展示声明式交互地图。
- 内置 `pi-task-mode` Extension，通过 `tau_task` 维护结构化任务步骤，并通过 `tau_ask_user` 请求确认、单选或文本输入。
- Web 顶部可按会话切换任务模式，聊天流中的 TaskCard 支持 live 更新、等待用户状态和历史恢复。
- 地图支持点、线、面、文字图层，常量/分类/分段/连续编码，安全 Popup、图层显隐和选中高亮。
- 默认新建任务目录指向 `scenario/`，适合作为后续交通 demo 的工作目录。

## 产品示意图

![Pi Traffic Workspace overview](docs/images/traffic-workspace-overview.png)

![Thinking and tool cards](docs/images/traffic-workspace-tools.png)

## 快速开始

```bash
npm install
npm run build
pi-traffic-workspace
```

默认访问地址：

```text
http://localhost:3001
```

也可以指定端口和主机：

```bash
pi-traffic-workspace --host 127.0.0.1 --port 3001 --open
```

项目兼容上游的 `TAU_*` 环境变量：

```bash
TAU_PORT=3001 TAU_HOST=0.0.0.0 pi-traffic-workspace
```

## 开发命令

```bash
npm run build
npm test
npm run typecheck
```

在本项目的 Codex 工作流里，通常使用：

```bash
rtk npm run build
```

如果本地调试需要直接启动编译后的入口：

```bash
rtk node bin/tau.js --host 127.0.0.1 --port 3000
```

启动后可检查服务状态：

```bash
curl -s http://127.0.0.1:3000/api/health
```

### 启动权限说明

服务不仅要监听本地端口，还会调用本机的 `pi` 命令，并读写 `~/.pi/agent/` 下的配置、信任记录和锁文件。因此应在具有当前用户正常文件权限的终端中启动。

如果通过 Codex 或其他带文件系统沙箱的执行环境启动，需要明确选择“在沙箱外运行”或授予正常系统权限。否则 Web 页面和健康接口可能可以打开，但 Pi 子进程会因为无法创建锁文件而退出，常见报错为：

```text
EPERM: operation not permitted, mkdir '~/.pi/agent/settings.json.lock'
EPERM: operation not permitted, mkdir '~/.pi/agent/trust.json.lock'
```

遇到这类报错时，应停止受限进程并以正常权限重新启动，不要使用 `sudo`，也不要修改 `~/.pi` 的文件归属。开发服务可以用 `Ctrl-C` 停止。

## 项目结构

项目采用“Agent Web 平台 + GIS 功能模块”的单仓库模块化架构。完整边界、依赖方向和资产规则见 [架构与目录治理](./docs/ARCHITECTURE.md)，文档入口见 [docs/README.md](./docs/README.md)。

```text
src/server/
  server-main.ts       # HTTP API、WebSocket、RPC 分发、文件与资源接口
  sessions.ts          # Pi RPC 子进程和 live session 生命周期管理
  config.ts            # 端口、host、session 目录、静态资源目录
  model-utils.ts       # 模型列表与 provider/model 解析
  geo-resources.ts     # 会话隔离的 GeoJSON 资源读取、缓存和边界校验

src/public/
  app-main.ts          # 平台组合入口、会话状态与 WebSocket 事件接线
  message-renderer.ts  # 消息、Markdown、思考卡片、复制逻辑
  tool-card.ts         # 工具调用卡片、中文工具名、耗时、折叠/展开
  session-sidebar.ts   # 左侧会话列表与 live session 同步
  file-browser.ts      # 右侧文件树和拖拽插入路径
  model-picker.ts      # 模型和 thinking level 选择
  workspace/           # 右侧工作区壳层与功能视图端口
  features/            # Web 功能注册表及 GIS 等垂直功能适配器
    task/               # 任务协议、会话 Store、TaskCard 与模式开关
  visualization/       # 声明式可视化协议、会话状态与 MapLibre Runtime

extensions/
  pi-geo-visualization/ # 随 Pi 会话自动加载的 GIS Extension
  pi-task-mode/         # 任务模式、结构化进度和用户交互 Extension

skills/
  geo-visualization-explanation/ # GeoJSON 发布、GeoScene 构建与调试手册
  plot-from-data/                # 静态科研绘图模板与脚本
  shanghai-traffic-data-assets/  # 上海交通治理数据、查询脚本与本地资产

prompts/
  PI_SESSION_CONTEXT.md          # 每个 Pi Web 会话追加的项目级系统提示模板

public/
  index.html           # 页面骨架
  style.css            # 全局样式
  geo-runtime.*        # 构建生成的 MapLibre 懒加载 bundle

docs/
  ARCHITECTURE.md      # 系统边界、依赖方向、目录与资产规则
  REACT_UI_MIGRATION_PLAN.md # React UI 迁移评估与实施路线
  TASK_MODE_INTERACTION_PLAN.md # Pi 任务模式、交互工具与 Web 适配计划
  PROJECT_HANDOFF.md   # 给下一位 Agent 和人类开发者的交接说明
  GIS_WEB_VISUALIZATION_TECHNICAL_PLAN.md
```

## 构建产物说明

TypeScript 源码会编译到：

```text
bin/*.js
public/*.js
public/visualization/*.js
public/geo-runtime.*
```

这些文件被 `.gitignore` 忽略。修改 `src/` 后需要运行 `npm run build`，本地启动时才会看到最新逻辑。

## 当前实现状态

已完成：

- 从 `pi-tau-web-server` 改造成交通工作台方向的独立项目。
- 包名和 CLI 名称调整为 `pi-traffic-workspace`。
- 浏览器 UI 主要文案中文化。
- 会话创建改为“输入会话名称”，任务目录默认使用 `scenario/`。
- 左侧侧栏与运行中会话同步。
- 思考卡片、工具卡片、消息渲染、代码块折叠和整体 UI 美化。
- 右侧面板增加 `文件 / 技能 / 工具` 切换。
- 增加 `地图` 工作区、内置 Pi GIS Extension、GeoJSON 资源发布和 MapLibre Web 渲染闭环。
- 可视化快照随工具结果进入会话历史，支持 live snapshot、历史查看和 resume 恢复。
- 增加 `pi-task-mode` Extension、`tau_task`、`tau_ask_user`、`/task on|off|status` 和会话状态恢复。
- Pi 子进程通过内置 Extension Registry 同时加载任务模式与 GIS Extension。
- 全局 Pi Skill 已迁入仓库，并由服务端通过 `--skill` 显式加载到每个 Web 会话。
- 增加任务模式 Web Adapter：模式开关、TaskCard、等待状态、交互 Dialog 和 live/history/resume 恢复。
- 建立架构、GIS 技术方案和项目交接文档。

尚未完成：

- 真实交通数据接入。
- `traffic.*` 业务工具。
- 交通结果卡片。
- GIS filter/图例、通用格式转换、矢量瓦片、栅格、时序和地图到 Agent 的反向联动。
- Pi 完整工具清单的原生 RPC 暴露。

## 技能与工具查看

右侧工作区面板里的 `技能` 来自 Pi 当前会话的 `get_commands` 结果，并筛选 `source === "skill"`。项目级 Skill 位于 `skills/`，服务端显式传给每个 Pi 子进程，因此会话工作目录即使位于 `scenario/` 也能发现它们。

`工具` 当前展示：

- 内置工具：`读取`、`命令`、`编辑`、`创建`
- 当前会话中已经出现过的工具调用统计

注意：Pi 扩展 API 中存在 `pi.getActiveTools()` 和 `pi.getAllTools()`，但当前 Pi RPC 没有原生 `get_tools`。如果后续要展示完整注册工具列表，需要增加 Pi 扩展桥接或扩展 RPC。

## 项目提示词

项目级提示词位于 [`prompts/PI_SESSION_CONTEXT.md`](./prompts/PI_SESSION_CONTEXT.md)。服务端在创建每个 Pi 会话时读取该文件并替换目录占位符，因此修改正文后只需新建会话即可生效，不需要修改 `sessions.ts`。支持的占位符包括：`PROJECT_ROOT`、`TASK_WORKING_DIRECTORY`、`PROJECT_SKILLS_DIR`、`TRAFFIC_TOOLS_DIR`、`TRAFFIC_DATA_DIR` 和 `PROJECT_PROMPT_PATH`；占位符写法为双花括号包裹名称。未知占位符会阻止会话启动并返回明确错误，避免静默注入错误路径。

## Pi 任务模式

每个 Pi 会话都会加载 `pi-task-mode` Extension。选择运行中的会话后，可以通过顶部“任务”开关按会话控制模式；也可以在 Web 输入框发送以下命令：

```text
/task on
/task off
/task status
```

开启后，Pi 会在复杂任务中使用：

- `tau_task`：通过 `start/revise/update_step/finish/fail/cancel` 创建、修订、更新并终结 2–8 个结构化步骤；快照保存在工具结果 `details.task` 中。
- `tau_ask_user`：通过现有 Pi RPC Extension UI 链路发起确认、单选、短文本和长文本交互。

Web 会从结构化 `details.task` 渲染唯一 TaskCard，并按 revision 更新当前步骤、完成/失败/阻塞状态；等待回答时显示 `waiting_user`。Extension 还会把最新终态写入会话自定义状态，因此 Agent 遗漏 `finish/fail/cancel`、进程异常结束或恢复旧会话时，任务会自动落为 `interrupted`，刷新、历史查看和 resume 不会丢失任务卡。`tau_ask_user` 继续使用 Pi RPC 原生交互协议，Web 已适配确认、单选、短文本和长文本 Dialog。详细边界见 [Pi 任务模式与 Web 人机交互实施方案](./docs/TASK_MODE_INTERACTION_PLAN.md)。

## GIS 地图工作流

每个 Pi 会话都会自动加载包内的 GIS Extension，并获得两个声明式工具：

- `publish_geodata`：校验并发布任务目录内的 `.geojson`/`.json` 文件，返回稳定的会话资源 ID。
- `present_visualization`：接收 `create_map`、`add_layer`、`set_*`、`select`、`clear` 等命令式参数，由 Extension 内部构建并校验地图 Scene；Agent 不再手写完整 Scene JSON。

地图数据统一先通过 `publish_geodata` 发布，再把返回的 `resourceId` 交给 `present_visualization`。新建会话的系统提示会明确当前任务目录、项目 Skills 目录、交通查询脚本目录和 SQLite 数据目录。Web 端从工具卡进入右侧“地图”工作区，资源只允许从对应 live session 的任务目录读取。完整协议、边界和后续阶段见 [GIS Web 展示模块技术方案](./docs/GIS_WEB_VISUALIZATION_TECHNICAL_PLAN.md)。

`default`/`light`/`dark` 使用 Runtime 白名单内的 OpenFreeMap 矢量底图，需要网络；`none` 保留项目自带的纯色离线底图。Web 制图层会自动为业务线路增加 casing、为点位增加交互 halo，并让底图地名保留在交通线网上方。

## 后续计划（Todo）

近期：

- [x] 开发 `pi-task-mode` Extension，为 Pi 增加按会话启用的任务模式。
- [x] 实现 `tau_task` 工具，以结构化快照创建、修订和更新任务步骤。
- [x] 实现 `tau_ask_user` 工具，通过 Pi RPC 支持确认、单选、短文本和长文本交互。
- [x] 实现 Web TaskCard、等待用户状态、会话隔离以及 live/history/resume 恢复。
- [x] 将 Pi Extension 加载改成内置 Registry，同时保留 GIS 默认扩展。
- [x] 为任务模式补充取消、失败、异常结束和恢复回归测试。
- [ ] 为任务模式补充 RPC 超时、断线重连和浏览器回归测试。

中期：

- [ ] 按 [React UI 迁移方案](./docs/REACT_UI_MIGRATION_PLAN.md) 建立 Vite、React、shadcn/ui、Radix 和 Motion 基座。
- [ ] 增加交通 Prompt / Skill，规范分析口径和结构化输出。
- [ ] 增加 mock traffic tools，跑通工具调用和业务结果链路。
- [ ] 增加交通结果卡片，让结构化结果不只依赖 Markdown。
- [ ] 增加 GIS filter/图例、格式转换、矢量瓦片、栅格、时序和地图到 Agent 的反向联动。

远期：

- [ ] 接入真实交通数据库或外部 API。
- [ ] 增加早高峰拥堵排行、异常路段诊断、区域运行态势和交通运行日报等任务模板。
- [ ] 在出现并行 DAG、后台运行或断点恢复需求后，评估 Taskflow Adapter；不开发流程编辑器。

任务模式的协议、交互闭环和分阶段验收见 [Pi 任务模式与 Web 人机交互实施方案](./docs/TASK_MODE_INTERACTION_PLAN.md)。更详细的交接、坑点和下一步建议请看 [PROJECT_HANDOFF.md](./docs/PROJECT_HANDOFF.md)。

## 与上游的关系

本项目基于 [milanglacier/pi-tau-web-server](https://github.com/milanglacier/pi-tau-web-server) 改造。建议把本仓库作为独立产品仓库维护，同时保留上游 remote：

```bash
git remote add upstream https://github.com/milanglacier/pi-tau-web-server.git
```

以后如需同步上游能力，可以选择性 merge 或 cherry-pick，而不是直接覆盖当前交通工作台方向的改动。

## License

MIT
