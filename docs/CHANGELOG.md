# Changelog

本文件记录会影响使用者、部署者与模块作者的项目变更；不重复 Git 提交日志、分支操作或测试执行明细。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，项目版本遵循 [Semantic Versioning 2.0.0](https://semver.org/lang/zh-CN/)。日期采用 ISO 8601（`YYYY-MM-DD`）。

## Unreleased

## 3.1.3 - 2026-08-29

### Changed

- Windows 用户数据目录统一为 `%APPDATA%\\TransportX\\traffic-agent`，与 macOS 的供应商/产品目录模型一致；不再兼容旧 Windows 目录。
- Windows 与 Linux 使用统一的无边框窗口壳和 React 窗口控制；桌面运行时由平台 Profile 统一配置。
- Pi CLI 的兼容版本上限扩大至 `0.85.x`。
- 核心、Web、macOS 平台、Windows 平台测试拆分为真实用户场景的独立入口。
- 架构文档重组为目录速览、运行时边界、数据流与发布验证，明确当前单体桌面架构。

### Fixed

- 单轮完成的会话会出现在历史会话列表中。

## 3.1.2 - 2026-08-21

### Added

- 提供 Windows 10/11 x64 的离线 NSIS 安装包，内置 Pi、Python 3.10 x64 与 ffmpeg/ffprobe，不依赖系统运行时。
- 新增 Windows 发布指南与跨平台接入约束。

### Changed

- 引入平台 Profile，将 Python、ffmpeg、签名、安装器与 Release metadata 的平台差异收敛到一处；同一条 `desktop:pack` 可服务 macOS 与 Windows。
- electron-builder 拆分为 common、macOS 与 Windows 配置片段；运行时准备和发布前检查改由统一入口完成。
- 跨平台协议中的相对路径统一序列化为 POSIX `/`。

## 3.1.1 - 2026-08-21

### Changed

- 将会话、Pi RPC、HTTP RPC、模块安装、引用、报告与工作台展示进一步按领域拆分，`server-main.ts` 收敛为进程编排入口。
- Browser Kernel 接管附件、引用、视频指标、PDF 导出与资源读取等命令边界；React 组件专注状态投影与展示。
- 会话元数据、上下文用量、事件计时、提示词装配、工作目录和 Pi 启动参数拆分为可独立验证的边界。

### Fixed

- 修复压缩期间排队提示词、实时元数据重复广播、工具调用显示顺序，以及会话历史、引用和附件投影中的一致性问题。

## 3.1.0 - 2026-08-19

### Added

- 支持在桌面端拖入或选择 Module ZIP，预检并批量安装模块版本。

### Security

- ZIP 安装拒绝路径逃逸、符号链接、加密条目、异常压缩比和重复版本，并复用 Manifest 与完整性校验。

### Changed

- Hongqiao Metro Entrance Demo 改用通用视频时序指标，并提升人流检测的分辨率与阈值策略。

## 3.0.11 - 2026-08-18

### Fixed

- 修复含多张内嵌图片的 Markdown 报告导出 PDF 时因超长 `data:` URL 导致失败的问题。
- 桌面端仅在 PDF 实际写入系统下载目录后反馈成功。

## 3.0.10 - 2026-08-17

### Added

- 新增 Video Capability：视频检索、展示、截图、裁剪、抽帧、时序指标与会话级视频资源。
- 提供 demo-video 和 Hongqiao Metro Entrance Demo 模块，支持基于真实录像的交通分析。
- 增加视频双画面对比和通用 Workspace Focus 布局。

### Changed

- 打包运行时扩展为 Pi、Python 与 ffmpeg/ffprobe，并在 runtime manifest 中记录版本、架构和 SHA-256。
- Citation Evidence、工作区布局、工具调用显示和模块版本管理随视频能力一并收敛。

### Fixed

- 修复开发桌面模式未注入 ffmpeg/ffprobe、视频多关键词检索、内置模块升级后旧会话恢复及手动引用投影问题。

## 3.0.9 - 2026-08-16

### Changed

- 打磨工作台设置、能力面板与对话界面，并新增 Video Capability V1 设计文档。

## 3.0.8 - 2026-08-15

### Added

- 新增供应商分组的模型配置、连接管理和兼容供应商路径配置。

### Changed

- 优化长响应渲染、流式交互与任务创建体验；模型上下文统一以 `K` 为单位显示。

## 3.0.7 - 2026-08-14

### Added

- 引入 Headless Traffic Agent Eval、可审计评测结果，以及 `SessionProfile v1` 和 `ResolvedSessionPlan v3`。
- 新增受控 Spatial Analysis，支持 buffer、nearest 与 spatial join。

### Changed

- 有副作用命令统一使用带 `clientCommandId` 的 HTTP RPC；WebSocket 专职事件传输。

### Fixed

- 修复 ACK/事件竞态引起的重复用户消息、产物预览类型判断和真实数据引用闭环问题。

## 3.0.6 - 2026-08-11

### Added

- 设置改为主工作区页面，增加常规、Agent 与模块导航；工作台新增简体中文和英文界面。

### Changed

- 统一消息 Markdown 渲染，更新品牌图标、Pi 中文过程语言规则及上海数据问答口径。
- 2026-08-12 的同版本维护补充 Shanghai Data 的跨线路物理站汇总规则、`2.0.1` 模块升级，以及界面语言持久化与三主题适配；平台版本仍为 `3.0.6`。

## 3.0.5 - 2026-08-11

### Added

- 新增 Citation compiler、registry、service 与工作台引用管理界面。

### Changed

- Citation、Geo、Task 和 Web Bridge 的 Pi Extension、Skill 与 Prompt 统一由 Module Registry 装配。
- 调整地图/对话分栏和侧栏面板的过渡体验。

## 3.0.4 - 2026-08-10

### Added

- 增加 Session 级统一附件系统，支持选择、拖拽、剪贴板上传以及常见文件预览。
- 内置 Python runtime 增加 pandas、pyproj 与 shapely，为空间分析提供运行基础。

### Security

- 附件访问增加归属、路径、符号链接、哈希与大小校验；向 Agent 仅提供安全的相对路径上下文。

## 3.0.3 - 2026-08-09

### Changed

- macOS Agent Host 改为 Electron Utility Process，完善启动、会话恢复与退出清理。
- 内置模块收敛为平台通用能力；交通数据、知识和绘图经验改为可安装模块，不再作为应用启动依赖。
- 默认回归测试收敛为关键边界场景。

## 3.0.2 - 2026-08-09

### Added

- 建立 Light、Dark、Sand 三主题的 semantic token 体系与会话侧栏能力扩展区。

### Changed

- Header、设置页与工作台控件统一为紧凑的桌面应用视觉规范；旧主题偏好自动迁移。

### Removed

- 移除旧主题、`--react-*` 兼容变量、重复主题覆盖及低价值的重复测试。

## 3.0.1 - 2026-08-09

### Changed

- Pi 基础提示词改由 `prompts/PI_SYSTEM.md` 管理；模块资产根目录、安装卸载与选择规则完成收口。
- macOS 安装包携带需要真实路径的 Skill，并增加正式签名与公证凭据前置检查。

## 3.0.0 - 2026-08-09

### Added

- 产品更名为 TransportX Traffic Agent，提供安全沙箱化 Electron 桌面宿主、Agent Host 进程治理与可重定位的 Pi/Python runtime。
- 引入 Manifest v1、Module Registry、Asset Resolver、Session Assembly 与 Resolved Session Plan。
- 提供本地模块安装器、统一模块管理、桌面 PDF 导出与 macOS 发布链路。

### Changed

- Data/Knowledge 从 Skill 目录解耦，用户数据与任务工作区统一迁移至 `~/.transportx/traffic-agent/`。

### Security

- 模块安装拒绝符号链接和路径逃逸；Knowledge 清单升级为逐文件 SHA-256 校验。

### Removed

- 移除旧 launchd 配置、字体测试文件、旧图标和仓库内的历史任务缓存。

## 2.14.0 - 2026-07-30

### Added

- 报告预览支持受控的相对图片路径；地图与对话双栏支持可拖拽分隔。

### Changed

- 重构 Composer 工具栏并收紧窄栏响应式布局。

## 2.13.0 - 2026-07-26

### Added

- 新增可信 Citation 契约、知识库索引、引用管理、报告产物识别与 PDF 预览导出。

### Security

- 引用原件按会话、真实路径和 SHA-256 校验后只读提供。

## 2.12.0 - 2026-07-23

### Added

- GeoScene 支持增量 `replace`、`patch`、`focus`、`select` 与 `clear`；新增重要交通场站 POI。

### Changed

- 收紧 Task 模式，统一地图、任务与工具调用的交互样式。

## 2.11.0 - 2026-07-23

### Changed

- React 成为唯一生产 UI；Server 路由、交通数据资产和 Geo Skill 完成收口。

### Removed

- 移除旧 DOM/legacy Web 入口、样式、Service Worker 与回退脚本。

## 2.10.0 - 2026-07-22

### Added

- React 工作台接入会话、任务、文件预览、地图、模型与设置；MapLibre Runtime 支持按活动工作区加载。

### Changed

- 默认根路径切换到 React Vite 应用，历史会话按当前项目工作区组织。

## 1.28.0 - 2026-07-22

### Added

- React Shell 通过 Composition Root 接入 Browser Kernel，迁移平台壳、设置、模型、任务和会话侧栏。
- 引入 Radix Dialog、领域 Command Port 与真实服务 + fake Pi + Chrome 的 UI 场景测试。

## 1.27.0 - 2026-07-22

### Added

- 建立 `src/contracts/` 作为 Session、Task、Geo、Bridge、错误和模型协议的单一权威。
- Bridge Envelope 增加 RuntimeCapabilities 与结构化兼容性诊断。

## 1.26.0 - 2026-07-22

### Added

- 建立 React 19、Vite 与 Tailwind CSS 4 基座，以及独立的 `/react/` 静态入口。

## 1.25.0 - 2026-07-22

### Added

- 建立 Browser Application Kernel，包括事件标准化、Command Ports、领域 Store 与 Snapshot/Live Overlay 协调。

### Removed

- 移除 legacy 状态管理与控制器，消除流式领域状态双写。

## 1.24.0 - 2026-07-21

### Changed

- 校对架构文档事实并确定 React Web Adapter 迁移路线；合并重复文档入口。

## 1.23.0 - 2026-07-21

### Added

- 新增 Pi Web Bridge、类型化 API Router、branch-aware Session Projection 及 Pi/Chrome 冒烟测试。

### Changed

- 对齐 Pi 开发依赖与运行时协议，缩小 `server-main.ts` 的职责。

## 1.22.0 - 2026-07-21

### Added

- 完成 Task Mode、`tau_task`、`tau_ask_user`、可拖动任务卡与项目级交通/Geo Skill。

### Fixed

- 修复 Geo 参数数值被序列化为字符串的问题，并强化 GeoScene 与资源发布校验。

## 1.21.0 - 2026-07-20

### Added

- 编写 Task Mode 人机交互方案，定义任务状态机与 Web 恢复策略。

## 1.20.0 - 2026-07-20

### Changed

- 拆分工作区 Feature Registry、GIS Feature 与 Workspace Controller，并制定 React 迁移规划。

## 1.19.0 - 2026-07-20

### Added

- 新增 MapLibre GIS 工作区、GeoScene 协议、会话级可视化 Store 与资源发布接口。

## 1.18.0 - 2026-07-14

### Changed

- 忽略本地任务工作区和运行期资产，避免用户数据进入版本控制。

## 1.17.0 - 2026-07-14

### Added

- 为每个任务创建独立 `scenario` 工作目录。

### Fixed

- 会话、文件视图和工具卡统一使用任务目录，避免任务之间的文件污染。

## 1.16.0 - 2026-07-13

### Fixed

- 模型与思考等级改为原生选择控件，修复切换交互和选中值显示不一致。

## 1.15.0 - 2026-07-13

### Added

- 支持识别并预览 Pi 工具结果中的图片。

## 1.14.0 - 2026-07-10

### Fixed

- 恢复会话时保留历史消息，避免被 live snapshot 短暂覆盖。

## 1.13.0 - 2026-07-09

### Added

- README 增加工作区与工具调用截图。

### Fixed

- 修复紧凑工具卡中本地化标签换行问题。

## 1.12.0 - 2026-07-09

### Changed

- 将项目定位为独立交通分析 Pi Web 工作区，补充能力、架构、启动和已知限制说明。

## 1.11.0 - 2026-07-09

### Changed

- 重构为紧凑的 Codex 风格工作区，并增加会话资源、可见 Skill 与工具调用耗时展示。

## 1.10.0 - 2026-07-08

### Added

- 初始化 Pi Tau Traffic Web 项目，提供 Pi RPC 会话、历史会话、模型选择、文件和工具展示等基础能力。
