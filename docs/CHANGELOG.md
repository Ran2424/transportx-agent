# 版本修改与 GitHub 操作日志

本文记录项目每次提交、推送的主要内容、影响范围与验证结果，作为 README 之外的工程演进记录。

## 维护规则

- 版本从 `v1.10` 开始，每次正式提交递增 `0.01`，即 `v1.10`、`v1.11`、`v1.12`。
- npm 使用三段式 SemVer：日志版本 `vX.Y` 对应 `package.json` 的 `X.Y.0`；例如 `v1.22` 对应 `1.22.0`。
- 新版本写在最上方；一次版本原则上对应一次提交并推送到 `origin/main`。
- 每条记录至少包含日期、GitHub 操作、主要修改和验证情况。
- 历史记录根据本地 Git 提交补录。Git 不保存普通 `git push` 的精确时间，因此旧版本使用提交时间，并以提交已经存在于 `origin/main` 作为推送完成依据。
- 若仅提交到开发分支，应明确记录分支名；合并到 `main` 后再补充合并与推送结果。

## v1.23 — Pi 协议恢复、入口瘦身与 Web Bridge

- 日期：2026-07-21
- GitHub 操作：提交并推送到 `origin/main`
- 提交主题：`refactor: align Pi runtime and Web bridge architecture`

主要修改：

- 将 Pi 开发依赖与运行时兼容范围对齐到 `0.80.10`，启动时检查实际 Pi 版本，避免开发 Schema 与运行时协议发生偏移。
- 建立 branch-aware `SessionProjection`，按 JSONL 的 `parentId` 选择当前分支，并统一 live、history、resume 使用的 Snapshot 结构。
- 提取类型化 Server Router 和独立 API 路由表，缩小 `server-main.ts` 的职责范围。
- 建立 `AgentRuntime`、`RuntimeStore` 以及 Session、ToolExecution、ExtensionUI 三个控制单元；状态指示灯改为只消费 Store，不再自行判断 WebSocket。
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
