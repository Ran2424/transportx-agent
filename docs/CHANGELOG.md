# 版本修改与 GitHub 操作日志

本文记录项目每次提交、推送的主要内容、影响范围与验证结果，作为 README 之外的工程演进记录。

## 维护规则

- 当前发布线从 `v2.10` 开始，每次正式提交递增 `0.01`，即 `v2.10`、`v2.11`、`v2.12`、`v2.13`。
- npm 使用三段式 SemVer：日志版本 `vX.Y` 对应 `package.json` 的 `X.Y.0`；例如 `v2.11` 对应 `2.11.0`。
- 新版本写在最上方；一次版本原则上对应一次提交并推送到 `origin/main`。
- 每条记录至少包含日期、GitHub 操作、主要修改和验证情况。
- 历史记录根据本地 Git 提交补录。Git 不保存普通 `git push` 的精确时间，因此旧版本使用提交时间，并以提交已经存在于 `origin/main` 作为推送完成依据。
- 若仅提交到开发分支，应明确记录分支名；合并到 `main` 后再补充合并与推送结果。

## v2.13 — 可信引用、报告产物与知识库索引

- 日期：2026-07-26
- GitHub 操作：提交并合并至 `origin/main`；发布 GitHub Release `v2.13.0`。
- 提交主题：`release: v2.13.0 citation and report artifacts`

主要修改：

- 新增 `pi-citation/1.0` 共享契约与 `tau_cite` 工具，将知识库条目和当前任务产物注册为可持久化、可恢复的可信引用；服务端按会话、真实路径边界和 SHA-256 校验提供只读原件。
- 新增交通保障知识库索引 Skill，统一检索法规、标准、预案、案例和项目资料，并以稳定知识 ID、PDF 页码、章节及原文摘要向引用系统提供结构化数据。
- 正文引用渲染为紧凑序号，消息末尾按来源分组展示引用依据；支持 PDF 对应页大图预览、普通文档定位和图片缩略图，并在原件缺失或变化时显示明确状态。
- 自动识别同一轮任务生成的 Markdown、PDF、图片及 CSV/TSV/XLS/XLSX 数据产物，以独立于知识库文献的卡片列入“本次产出”；图片使用对应文件图标。
- Markdown 报告预览会根据正文实际引用，由系统去重并按首次出现的引用序号自动追加逐条参考依据，不再依赖模型手写参考章节；报告可直接渲染并下载为 PDF。
- 更新架构文档、引用功能设计、README 与自动化测试，覆盖引用契约、投影恢复、资源访问、Markdown 安全、报告产物和浏览器交互。
- 将 npm 包版本更新为 `2.13.0`。

验证：

- `npm run typecheck` 通过。
- `npm test` 通过。
- `npm run test:react-smoke` 通过。
- 知识库索引 Skill `quick_validate.py` 校验通过。

## v2.12 — Geo 增量交互、Task 稳定性与工具界面统一

- 日期：2026-07-23
- GitHub 操作：提交并推送至 `origin/main`；发布 GitHub Release `v2.12.0`。
- 提交主题：`release: v2.12.0 geo task and tool interaction`

主要修改：

- 完成 Geo 第一阶段升级：明确 Agent 先分析、查询、聚合与校验，再通过 `present_visualization` 维护带版本号的 GeoScene；同一地图持续复用 `visualizationId`，一次命令只承担一种场景变更。
- 将地图 Runtime 拆分为图层编译、场景协调与交互控制三部分，支持 `replace`、`patch`、`focus`、`select` 和 `clear`；实时更新不再重建地图画布，并保留用户本地设置的图层显隐状态。
- 修复实时编辑地图时图例勾选状态失真；新增“回到范围”，图层选择改为三列并仅设置可滚动的最大高度，地图说明最多显示四行且内容较少时不占用多余画布。
- 扩充上海交通数据 Skill 与资产生成器，新增 `common.dim_poi` 及上海火车站、上海南站、上海虹桥站、上海浦东国际机场四个 WGS84 重要场站 POI；Geo Skill 要求具名 POI 尽量配套名称标签。
- 收紧 Task 模式边界：未开启时不注入 Task 提示词或工具，界面开关静默执行；首个任务自动弹出任务面板，连续任务实时刷新，任务面板采用更紧凑的扁平样式并支持桌面端拖拽移动。
- 统一对话区工具调用体验：完成后自动收起，流式阶段只保留“发送引导”和“终止当前任务”；使用暖色时间线样式，按命令、任务、Geo、读取、写入等实质显示不同图标，并用不超过四字的中文工具名替代内部名称。
- 将工具结果展示上限提高到 50,000 字符，避免读取较长 Skill 文档时过早截断；同步补充 Geo 增量更新、Task 生命周期、工具折叠与图标映射等自动化测试。
- 将 npm 包版本更新为 `2.12.0`。

验证：

- `npm run typecheck` 通过。
- `npm test`：56 项通过，0 项失败。
- `npm run test:react-smoke` 通过。

## v2.11 — React 单一工作台与交通 Skill 收敛

- 日期：2026-07-23
- GitHub 操作：提交至 `codex/shanghai-traffic-data-assets-unification`；本次未执行 push 或合并。
- 提交主题：`release: v2.11.0 react workspace and skills`

主要修改：

- 删除旧 DOM/legacy Web 入口、样式、Service Worker、Feature Registry 和回退浏览器脚本，React 成为唯一生产 UI。
- 拆分 `server-main.ts`：静态资源、会话历史、文件 API、WebSocket 分别由独立 handler 负责，HTTP 路由继续收敛于 `api-routes.ts`。
- 默认测试维持 49 项，以 Cookie 鉴权、任务 Extension 生命周期、Geo 会话资源隔离、Markdown 安全渲染替换低价值检查。
- README、架构文档和测试基线改为描述当前系统；React 迁移计划收敛为已采纳 ADR，旧 GIS/任务方案明确标注为历史记录。
- 重整 `shanghai-traffic-data-assets`：将原本偏向案例说明的 Skill 收敛为交通数据资产的查询入口。根 Skill 负责识别问题、选择数据域和调用查询脚本；`references/` 按 `catalog`、`common`、`road`、`metro`、`bus`、`ridehail`、`coverage`、`metrics`、`spatial`、`schema` 拆分，避免一次向 Agent 注入无关字段和口径。
- 明确六个数据库域及访问方式：查询必须使用 `catalog.*`、`common.*`、`road.*`、`metro.*`、`bus.*`、`ridehail.*` 全限定对象名；先读取覆盖范围、时间粒度、实体与指标定义，再选择事实表或汇总集市，禁止用表名猜测口径。
- 重新梳理网约车资产模型：四类原始订单来源统一进入 `ridehail.std_trip`，以订单哈希去重；订单、上下车端点、场馆到离场事件分别使用 `fact_trip`、`fact_ridehail_event`、`fact_venue_trip` / `fact_venue_event`，趋势优先使用 15 分钟、小时、日三个粒度的 mart，避免把同一订单体系的不同视图相加。
- 固化数据治理边界：交通需求、OD、行程时长、端点、场馆关联和道路/轨道/公交指标分别给出权威来源；坐标按 WGS84 经度/纬度处理，活动背景仅用于解释，不进入订单事实或集市，也不把并发活动错误归因于单一演出。
- 升级地理可视化 Skill：使用说明、Agent 元数据和失败恢复流程全面中文化；补充 GeoJSON 发布限制、稳定 ID、图层/编码约束、会话资源隔离与渐进建图流程；上海地铁专题图必须采用官方线路色板，并通过 `set_categorical` 进行线路分类编码。
- 将 npm 包版本更新为 `2.11.0`。

验证：

- `npm run typecheck` 通过。
- `npm test`：49 项通过，0 项失败。
- `npm run test:react-smoke` 通过。

## v2.10 — React 工作台重构发布

- 日期：2026-07-22
- GitHub 操作：提交后合并并推送至 `origin/main`。
- 提交主题：`release: v2.10.0 react workspace`

主要修改：

- 完成 React 工作台交互收敛：会话、任务、文件预览、地图、模型与设置采用一致的紧凑布局和主题。
- 默认 `/` 切换为 React Vite 应用，`/legacy/` 保留为稳定期回退；SPA fallback 在路由前校验 URI 编码与路径穿越。
- 对话区接入消息窗口、流式消息、思考过程、Markdown、工具卡、差异、图片附件和 Composer，并保持 Kernel Store 与 Command Port 的单向边界。
- Task Board 与 Geo Workspace 从 Kernel 的对话和工具执行状态投影历史与实时功能状态；MapLibre Runtime 按激活地图页签动态加载，支持选择和图层显隐。
- 修复 `agent_settled` RPC 事件、地图切换后需刷新才能渲染，以及地图弹层与文件预览的层级、加载问题。
- 文件面板支持多文件独立预览、代码/表格/Markdown/图片渲染，以及拖拽、关闭和四角缩放。
- 会话侧栏仅保留当前项目 `scenario/` 下的会话，取消项目与状态分组，并按最后活动时间倒序展示。
- 将包版本更新为 `2.10.0`。

验证：

- `npm run build` 通过。
- `node --test`：246 项测试，245 项通过、1 项真实 Pi smoke 默认跳过、0 项失败。

## v1.28 — React Shell 与低耦合平台 UI

- 日期：2026-07-22
- GitHub 操作：提交到当前分支；本次未执行 push。
- 提交主题：`feat: migrate react shell platform ui`

主要修改：

- `/react/` 通过 Composition Root 接入现有 `WebSocketClient + AppKernel`，并以 `useSyncExternalStore` 订阅 Runtime、Session 与 Extension UI Store。
- 迁移 AppShell、Header/Agent Status、Settings、Model Picker、Command Palette、New Session、SessionSidebar、Live Tabs 和 Workspace Layout。
- 引入 Radix Dialog，统一 Portal、焦点圈定/恢复、Esc 与键盘交互；Extension Dialog 覆盖 select、confirm、input、editor 和 notify，并保持按 session 排队语义。
- 扩展 Kernel Command Ports，覆盖历史会话列表/搜索/删除、Agent 设置、模型目录与认证；React 平台组件不直接访问 fetch 或 WebSocket。
- React 新建任务省略 cwd，由服务端统一创建 `scenario/时间-名称` 目录，不复制 legacy 的本机绝对路径。
- 将 React smoke 升级为真实 Node Server + fake Pi + Chrome 的阶段 4 验收，覆盖双会话切换、Extension UI、主题、移动抽屉和 Geo 懒加载边界。
- 将包版本更新为 `1.28.0`。

验证：

- `npm run typecheck` 通过；`npm test`：241 项测试，240 项通过、1 项真实 Pi smoke 默认跳过、0 项失败。
- `npm run test:react-smoke`、`npm run test:browser-smoke` 通过；`npm run test:browser-baseline` 11/11 场景通过。
- `npm audit --omit=dev` 为 0 漏洞；`npm pack --dry-run --ignore-scripts` 验证 React 源码、Radix 依赖声明与 `dist/web` 产物进入发布清单。

## v1.27 — Contract 治理与 RuntimeCapabilities

- 日期：2026-07-22
- GitHub 操作：提交到当前分支；本次未执行 push。
- 提交主题：`refactor: centralize shared contracts`

主要修改：

- 建立 `src/contracts/` 单一协议权威，集中 SessionSnapshot、TaskSnapshot、GeoScene/VisualizationEnvelope、PiWebBridgeEnvelope、AppError、ModelIdentity 和共享验证原语。
- Extension、Server、legacy Web 改为直接消费共享 Contract；原 task/geo/bridge/errors 路径保留 re-export 兼容层。
- 为 unknown schema/version、非法 revision 与 revision regression 增加结构化 `ContractDiagnostic`；保留旧 `value | null` parser 作为兼容入口。
- Bridge Envelope 增加 RuntimeCapabilities 最小声明，Server 在会话创建时建立初始 capabilities，并通过 metadata/协议错误暴露不兼容项。
- 新增 `test/fixtures/contracts/` 与 `test/contracts.test.ts`，统一验证 Session、Task、Geo、Bridge 的合法/非法版本及 revision regression。
- 构建新增共享 Contract 输出布局：`bin/contracts/`、`public/contracts/` 均为不入 Git 的运行产物，保持既有 `bin/*.js` 与 `public/*.js` 入口不变。
- 将包版本更新为 `1.27.0`。

验证：

- `npm run typecheck` 通过。
- `npm test`：240 项测试，239 项通过、1 项真实 Pi smoke 按默认策略跳过、0 项失败。
- `npm run test:react-smoke`、`npm run test:browser-smoke`、`npm run test:browser-baseline` 通过。
- `npm pack --dry-run` 验证 Contract 源码与运行产物进入发布清单，未包含未跟踪构建垃圾。

## v1.26 — React/Vite 基座与 legacy 独立入口

- 日期：2026-07-22
- GitHub 操作：提交到 `feature/react-migration-kernel`；本次未执行 push。
- 提交主题：`feat: add react vite foundation`

主要修改：

- 建立 `src/web/` React 入口和 `vite.config.ts`，生产产物输出到 `dist/web/`，不覆盖 legacy `public/`。
- 引入 React 19、Vite 8、Tailwind CSS 4，以及 shadcn 风格的 Button/Card UI 基元。
- 建立六套 React 主题 token、响应式空 Shell、`React.lazy` 动态模块和 `/react/` 独立静态入口。
- Node Server 增加 `/react` → `/react/` 静态托管与 `TAU_REACT_STATIC_DIR` 覆盖能力；Vite 开发代理 `/api` 和 `/ws`。
- 保持 legacy `/` 默认入口，并增加 React 基座 smoke、静态路由测试和 npm 发布清单验证。
- 将包版本更新为 `1.26.0`。

验证：

- `npm run typecheck` 通过。
- `npm test`：234 项测试，233 项通过、1 项按默认策略跳过、0 项失败。
- `npm run test:react-smoke` 通过。
- `npm run test:pi-smoke`：真实 Pi `0.80.10` RPC 冒烟通过。
- `npm run test:browser-smoke` 通过。
- `npm run test:browser-baseline`：11/11 场景通过。
- `npm pack --dry-run` 包含 `dist/web`、`src/web`、`vite.config.ts` 和 `tsconfig.web.json`。

## v1.25 — Browser Application Kernel 与 legacy Web 适配


- 日期：2026-07-22
- GitHub 操作：提交到 `feature/react-migration-kernel`；本次未执行 push。
- 提交主题：`feat: land browser application kernel and legacy adapter`

主要修改：

- 建立 `src/public/kernel/`，包含 Event Normalizer、Command Ports、Dispatcher、Runtime/Session/Conversation/Tool/Extension UI Store、Snapshot + Live Overlay reconcile 和可序列化 AppError。
- 将 legacy `src/public/app-main.ts` 改为消费 Kernel stores/commands，删除旧 StateManager、AgentRuntime、SessionController 和 ExtensionUIController 源文件，消除 streaming 领域状态双写。
- 增加 `test/fixtures/**`、Kernel replay/store/command 测试，以及 fake-pi 浏览器基线 harness。
- 固化 create/switch/resume/close、streaming、abort、Task Dialog、Geo Workspace、六套主题、移动端截图和性能基线。
- 更新 React 迁移计划与总体架构文档，明确 Browser Kernel 已完成、React/Vite 仍为下一阶段。
- 将包版本更新为 `1.25.0`。

验证：

- `npm run typecheck` 通过。
- `npm test`：233 项测试，232 项通过、1 项按默认策略跳过、0 项失败。
- `npm run test:pi-smoke`：真实 Pi `0.80.10` RPC 冒烟通过。
- `npm run test:browser-smoke`：真实 Node Server + Chrome 冒烟通过。
- `npm run test:browser-baseline`：11/11 场景通过。
- `start.sh` 启动后 `/api/health` 返回 `status: ok`。

## v1.24 — 文档事实校对与 React Web Adapter 路线定稿

- 日期：2026-07-21
- GitHub 操作：提交并推送到 `origin/main`
- 提交主题：`docs: finalize React web adapter migration plan`

主要修改：

- 精简 README，使其聚焦产品能力、运行逻辑、启动方式和权限注意事项；总体架构统一由 `docs/ARCHITECTURE.md` 维护。
- 合并并移除重复的文档索引、移动端说明和项目交接文档，避免多份架构说明长期漂移。
- 依据当前源码、测试和运行链路对文档做事实校对，区分 GIS、Task、状态管理和浏览器测试中“已经实现”“部分实现”和“未来计划”的能力边界。
- 记录新会话默认任务目录仍硬编码为本机绝对路径、只读历史资源地图不能直接加载等真实限制。
- 将 React 方案确定为 Agent Workspace 的 Web Adapter 改造：先建立 Browser Application Kernel，再按 Vite、Contract、React Shell、Conversation、Feature UI 和 legacy 删除的顺序实施。
- 明确 Event Normalizer、Command Ports、分域 Store、Stable Snapshot + Live Overlay、Domain/UI 双层 Feature、MapLibre Runtime Port 和独立 Vite 产物等目标边界。
- 修正 Geo Skill 中 `defaultValue`、resourceId、ID 校验和未实现 controls 的说明；补充绘图模板原始输出路径和交通治理脚本解释器注意事项。

验证：

- 24 份 Markdown 本地链接检查通过，外部官方参考可访问。
- `git diff --check` 通过。
- 版本同步测试通过。

## v1.23 — Pi 协议恢复、入口瘦身与 Web Bridge

- 日期：2026-07-21
- GitHub 操作：提交并推送到 `origin/main`
- 提交主题：`refactor: align Pi runtime and Web bridge architecture`

主要修改：

- 将 Pi 开发依赖与运行时兼容范围对齐到 `0.80.10`，启动时检查实际 Pi 版本，避免开发 Schema 与运行时协议发生偏移。
- 建立 branch-aware `SessionProjection`，按 JSONL 的 `parentId` 选择当前分支，并统一 live、history、resume 使用的 Snapshot 结构。
- 提取类型化 Server Router 和独立 API 路由表，缩小 `server-main.ts` 的职责范围。
- 建立 `AgentRuntime`、`RuntimeStore` 以及 Session、ToolExecution、ExtensionUI 三个控制单元；状态指示灯的连接/streaming 基础状态改为消费 Store，不再自行读取 WebSocket（临时状态文字仍保留旧 DOM 更新方式）。
- 新增 Pi Web Bridge，以带 `schemaVersion` 和 `revision` 的 Envelope 发布完整工具 Manifest、模型和 thinking 状态。
- 为 Task Mode 状态增加版本与修订号，兼容旧会话恢复，并移除每次 prompt 后的宽泛 `get_state` 轮询。
- 增加真实 Pi RPC 与 Chrome 浏览器冒烟测试脚本，并补充可随终端退出的一键启动脚本。
- 更新 README 与架构文档；React、Vite、shadcn/ui 迁移明确留到下一阶段。

验证：

- `npm test`：200 项测试，199 项通过、1 项真实 Pi RPC 测试按默认策略跳过。
- `npm run test:pi-smoke` 通过。
- `npm run test:browser-smoke` 通过，应用内浏览器检查无页面错误。
- `npm run typecheck` 通过。
- `git diff --check` 通过。

## v1.22 — 任务模式、项目级 Skill 与 GIS 稳定性修复

- 日期：2026-07-21
- GitHub 操作：提交并推送到 `origin/main`
- 提交主题：`feat: stabilize task mode and GIS workflows`

主要修改：

- 完成 `pi-task-mode` Extension，新增 `tau_task` 和 `tau_ask_user`；任务支持创建、修订、步骤更新、完成、失败和取消。
- 增加独立、可拖动的 Web 任务卡片，通过顶部按钮显示或隐藏，不占用文件/GIS 工作区侧栏。
- 持久化任务模式和任务快照；Agent 遗漏终态、会话恢复或异常结束时，将未完成任务安全落为 `interrupted`，避免任务卡随消息增加或刷新而丢失。
- 将用户级交通数据与绘图 Skill 迁移到项目 `skills/`，新增 `geo-visualization-explanation`，使 GIS 使用规则只在相关任务中注入。
- 增加项目级提示词 `prompts/PI_SESSION_CONTEXT.md`，统一注入任务目录、Skill、交通工具和数据目录，并约束 Python 解释器、Shell 失败传播、带空格路径及 SQL 表结构检查。
- 将 `present_visualization` 改为命令式参数接口，并修复 Pi 参数转换阶段把 `opacity`、`radius`、`width`、`strokeWidth` 等数值转换为字符串的问题。
- 增加字段级 GeoScene 校验、重复失败提示、同一地图 ID 复用约束，以及 GeoJSON ID、坐标、要素数和文件体积的发布前检查。
- 完善地图和任务模式文档，并在 README 中补充能力说明、恢复行为与剩余测试计划。

验证：

- `npm run typecheck` 通过。
- `npm test` 全量 185 项通过，0 项失败。
- `git diff --check` 通过。
- 正常权限启动服务后，`/api/health` 返回 `status: ok`。

## v1.21 — Pi 任务模式与人机交互方案

- 日期：2026-07-20 19:02 +08:00
- GitHub 操作：提交 `148a164`，已推送到 `origin/main`
- 提交主题：`docs: plan Pi task mode interactions`

主要修改：

- 编写 `TASK_MODE_INTERACTION_PLAN.md`，定义 `tau_task`、`tau_ask_user`、任务状态机和 Web 恢复策略。
- 明确任务模式只负责任务拆解与进度呈现，不引入流程编辑器。
- 在 README 和文档索引中增加任务模式的后续路线与实施入口。

## v1.20 — 工作区模块化与 React 迁移规划

- 日期：2026-07-20 17:13 +08:00
- GitHub 操作：提交 `95cf128`，已推送到 `origin/main`
- 提交主题：`refactor: modularize workspace and document UI migration`

主要修改：

- 从 `app-main.ts` 拆出 Feature Registry、GIS Feature 和 Workspace Controller，降低主入口对具体功能的直接依赖。
- 建立文件、技能、工具和地图工作区的统一控制边界。
- 整理 `docs/` 目录并补充总体架构、文档索引和项目交接说明。
- 编写 React、Vite、shadcn/ui、Radix UI 与 Motion 的迁移评估及分阶段实施方案。

## v1.19 — MapLibre GIS 可视化工作区

- 日期：2026-07-20 16:28 +08:00
- GitHub 操作：提交 `84927e2`，已推送到 `origin/main`
- 提交主题：`feat: add MapLibre GIS visualization workspace`

主要修改：

- 增加 `pi-geo-visualization` Extension，以及 `publish_geodata`、`present_visualization` 两个声明式 GIS 工具。
- 新增 GeoScene 协议、会话级可视化 Store、资源发布接口和 MapLibre Runtime。
- Web 工作区增加地图 Tab、图层控制、地图资源加载和工具卡跳转。
- 补充 GIS Web 技术方案、服务端路径安全、资源隔离和协议测试。

## v1.18 — 忽略本地工作区资产

- 日期：2026-07-14 13:01 +08:00
- GitHub 操作：提交 `fcd86e8`，已推送到 `origin/main`
- 提交主题：`chore: ignore local workspaces`

主要修改：

- 更新 `.gitignore`，排除本地任务工作区和运行期资产。
- 精简仓库级 Agent 指令入口，避免本地会话数据进入版本控制。

## v1.17 — 场景目录隔离

- 日期：2026-07-14 12:59 +08:00
- GitHub 操作：提交 `d6cd9d1`，已推送到 `origin/main`
- 提交主题：`fix: isolate task sessions in scenario folders`

主要修改：

- 新建任务时为会话创建独立的 `scenario` 工作目录。
- 服务端会话、Web 文件视图和工具卡统一使用会话目录，避免不同任务互相污染文件。
- 调整任务目录的创建、选择与展示逻辑。

## v1.16 — 模型切换控件修复

- 日期：2026-07-13 19:54 +08:00
- GitHub 操作：提交 `0474660`，已推送到 `origin/main`
- 提交主题：`fix: use selects for model switching`

主要修改：

- 将模型与思考等级切换改为原生选择控件。
- 简化模型选择器状态同步，修复切换交互不稳定和选中值显示不一致的问题。
- 同步调整桌面端样式和控件布局。

## v1.15 — 工具结果图片预览

- 日期：2026-07-13 19:48 +08:00
- GitHub 操作：提交 `45afd7c`，已推送到 `origin/main`
- 提交主题：`feat: preview tool result images`

主要修改：

- 支持从 Pi 工具结果中识别并显示图片。
- 增加图片缩略图、预览交互及相关工具卡样式。
- 调整消息渲染和工具结果解析，兼容文本与图片混合结果。

## v1.14 — 恢复会话时保留历史消息

- 日期：2026-07-10 15:41 +08:00
- GitHub 操作：提交 `9ccc5f0`，已推送到 `origin/main`
- 提交主题：`fix: keep history visible while resuming sessions`

主要修改：

- 修复从历史记录恢复会话时旧消息短暂消失或被 live snapshot 覆盖的问题。
- 调整前端历史合并和服务端恢复顺序，保持恢复过程中的会话内容连续可见。

## v1.13 — README 产品截图与工具标签样式

- 日期：2026-07-09 16:41 +08:00
- GitHub 操作：提交 `47b3b11`，已推送到 `origin/main`
- 提交主题：`docs(readme): show the traffic workspace with product screenshots and keep compact tool labels from wrapping in cards`

主要修改：

- 在 README 增加工作区总览和工具调用效果截图。
- 修复紧凑工具卡中的本地化标签换行问题。

## v1.12 — 独立产品 README

- 日期：2026-07-09 16:30 +08:00
- GitHub 操作：提交 `e24faad`，已推送到 `origin/main`
- 提交主题：`docs(readme): present the traffic workspace as an independent Pi web product while clearly crediting the upstream pi-tau-web-server foundation`

主要修改：

- 将项目定位为面向交通分析的独立 Pi Web 工作区。
- 补充产品能力、架构、快速启动、目录结构、已知限制和演进方向。
- 明确标注基于 `milanglacier/pi-tau-web-server` 的上游基础与二次开发关系。

## v1.11 — Codex 风格工作区界面

- 日期：2026-07-09 16:18 +08:00
- GitHub 操作：提交 `4857213`，已推送到 `origin/main`
- 提交主题：`feat(ui): make the traffic workspace feel like a cleaner Codex-style command surface while preserving live session behavior and adding a handoff for future work`

主要修改：

- 重构聊天区、思考卡、工具卡和右侧工作区，使界面更接近紧凑的 Codex 操作面板。
- 增加会话资源接口，展示可见 Skill 和已调用工具。
- 保存思考与工具调用耗时，并保持现有 Pi RPC 会话模型不变。
- 增加项目交接文档，记录架构、风险和后续工作。

## v1.10 — 项目初始化

- 日期：2026-07-08 16:04 +08:00
- GitHub 操作：提交 `c216ed2`，已推送到 `origin/main`
- 提交主题：`Initial pi tau traffic workspace`

主要修改：

- 建立 Pi Tau Traffic Web 项目初始代码、构建脚本、测试、容器配置和桌面/移动端页面。
- 引入 Pi RPC 会话管理、历史会话、模型选择、文件与工具展示等基础能力。
- 添加 README、开发计划、项目指令和首批界面图片资产。
