# Changelog

本文件记录会影响使用者、部署者与模块作者的项目变更；不重复 Git 提交日志、分支操作或测试执行明细。

格式遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/)，项目版本遵循 [Semantic Versioning 2.0.0](https://semver.org/lang/zh-CN/)。日期采用 ISO 8601（`YYYY-MM-DD`）。

## Unreleased

### Added

- 网页常见问题页新增内测交流群二维码与有效期说明。
- 新增独立的 TransportX 网页使用文档，包含产品介绍、安装、快速上手、API 接入、模块与数据、地图及报告操作，并提供真实界面图片、文档搜索和移动端导航。
- 网页产品介绍使用 68 秒英文演示视频展示工作流程。

### Changed

- 网页指南说明模块用于积累和复用平台能力，补充通过 Agent 将共用数据、知识与技能封装为模块的操作说明。

### Changed

- 网页使用文档增加官网产品介绍入口，明确 `docs/guide/` 为官网快速上手的内容来源，并说明 GitHub 与本地同步方式。

## 3.22.0 - 2026-09-30

### Added

- 新增本地可安装 `com.transportx.train-impact-report` 1.0.0 模块，将交通运行表图片整理为可追溯的结构化班次数据，并通过确定性跨日、去重、影响时段与汇总规则生成 DOCX 运行事件报告单。

### Changed

- 自本次变更起，项目自有代码采用 AGPL-3.0-only 许可；保留上游 MIT 代码的许可说明，并提供另行商业授权的咨询方式。
- 更新 README 中英文标语，强调与用户协作解决实际交通问题。
- README 中英文首屏改为以 2 倍速覆盖完整内容的 34 秒自动循环产品演示预览，链接至纳入仓库的 68 秒 1080p 英文成片；“How it works / 工作方式”补充执行架构图。
- 恢复 README 的任务创建与地图框选截图，加入用户提供的首页、月报、活动交通、轨道接驳和网约车分析截图，并补充中英文画面说明。
- 测试入口合并为 40 个领域套件以内；`npm run test:budget` 强制校验上限及 case 文件唯一归属，新增场景需合并到既有套件。

### Fixed

- `com.transportx.geo` 升级至 1.4.1：修复地图工具参数 schema 导致模型请求被 API 拒绝、提问后无回复的问题。
- Markdown 成果引用重写后仍可打开最新内容，并提示内容已不同于引用时的版本；其他引用资源继续校验注册版本。
- Web 开发模式的任务工作区统一使用设置页展示的跨平台 `scenario` 目录，不再隐式落到仓库工作目录；新建任务提示不再写死 macOS 用户目录。
- `com.transportx.workbench` 升级至 1.2.1：移除固定的 macOS 中文字体路径，改为从当前系统选择可用字体。
- `com.transportx.module-authoring` 升级至 1.0.1：安装目录说明改为引用设置页展示的实际跨平台路径。
- 测试与协作说明不再绑定开发者个人 Python 路径，解释器通过 `TAU_PYTHON_COMMAND` 或 `PATH` 解析。

### Removed

- 仓库不再包含交通评估脚本与评估样例；交通数据库、视频和知识库资产保持为本地安装内容。
- `com.transportx.workbench` 升级至 1.2.0：移除 Task Mode、`tau_task`、任务计划面板及其新会话装配；`tau_ask_user` 拆分为独立的 `com.transportx.interaction` 1.0.0 Module。旧 Task Module 与 Task Snapshot 契约文件保留，用于恢复历史会话。

## 3.21.0 - 2026-09-23

### Changed

- Canvas 升级为共享、模块化会话表面：Geo、Video 与 Document 通过受信任 Adapter Registry 使用统一 `pi-canvas` 生命周期，历史 Geo / Video Tool Result 继续兼容重放。Module manifest 新增 `contributes.canvasViews`，Resolved Session Plan 冻结 Adapter 声明；`com.transportx.workbench` 升级至 1.1.0，`com.transportx.geo` 升级至 1.4.0。

- 产品正式名称由 TransportX Traffic Agent 调整为 TransportX Agent；npm 包与 GitHub 仓库更名为 `transportx-agent`。桌面 `appId`、CLI 命令 `transportx` 和用户数据目录保持不变，旧会话计划中的产品标识继续兼容读取。
- `com.transportx.workbench` 升级至 1.0.2，`com.transportx.cli` 升级至 1.0.1：同步会话 Prompt 中的产品名称。
- `docs/` 仅保留架构说明、变更记录和 README 使用的产品图片；测试数据迁移至 `test/fixtures/`。
- `modules/installable/` 改为用户本地可安装模块暂存目录，默认不再纳入 Git；视频能力打包与真实评测改为显式接收本地 Module 源码路径。
- `.pi/`、`.plans/` 与 `evals/` 改为本地工作目录，默认不再纳入 Git；Pi 基础系统提示词移至 `src/server/prompts/`。

- 重构 README 首屏与产品说明，以共享地图和按任务装配的领域能力替代泛化的 local-first 定位；补充项目初衷、Module 扩展机制、共享 GIS 上下文、开源项目与测试协作者致谢、品牌图标、最新工作台截图、中英文入口、产品架构流程图，以及活动交通、轨道接驳和报告生成案例。开发、运行、打包和测试说明移至开发文档。架构说明补充技术栈分工、运行链路、功能源码映射、Module 依赖图、资产边界和会话装配规则。

- Markdown 报告导出 PDF 的渲染 HTML 上限由 5 MiB 提升至 50 MiB，支持包含多张高分辨率图件的分析报告。
- Video Capability 从内置能力改为可安装、可禁用和可卸载的 Module；视频数据 Module 继续通过依赖关系启用该能力。
- 基础桌面安装包不再携带 ffmpeg/ffprobe；平台专属 Video Capability ZIP 独立携带并冻结原生运行时版本与 SHA-256。
- Pi CLI 版本探测超时由 5 秒提升至 30 秒，避免冷启动时误判运行时不可用。
- 设置页「模型接入」面板改版：新增供应商/模型/推理/图像统计卡片、供应商头像与来源及凭据标识、模型能力芯片网格，并补全窄屏与移动端自适应布局。

### Fixed

- 修复正文和复制文本将已注册的成果引用误判为“引用不可用”：成果与来源统一编号，报告引用打开 Canvas，图片成果引用打开预览。
- 会话显式名称会在 Pi 返回历史文件后持久化，现有会话支持从侧栏重命名；历史名称不再在重启后回退成首条提问。
- 修复引用注册表只在打开会话时读取一次导致的新引用偶发不可用，并为会话产物与引用资源补充受控原文件下载。
- 修复工作区 PDF 误用图片预览接口；PDF 通过支持字节范围的会话文件路由预览。
- 删除会话不再等待子进程强制终止窗口；删除成功后刷新历史侧栏，重复删除已不存在的历史记录按成功处理。
- `com.transportx.task` 升级至 1.0.2：`tau_ask_user` 提供预设选项时，用户也可以输入并提交自定义答案。
- 修复可安装模块的依赖装配：已安装依赖随上层模块自动启用；依赖缺失或不兼容的模块不再进入新任务默认选项。
- assistant 回复生成期间同步渲染 Markdown，不再等到整条回复结束后才显示标题、列表、代码等格式。
- 修复从第二条消息起提问流程中断：Pi 首次以排他方式保存会话文件时与服务器写入会话名称冲突（EEXIST），会话名称改为在 Pi 完成首次落盘后补写，侧栏重命名路径同样受保护（#35，PR #37）。
- 服务端权威状态将会话纠正为非流式时，前端同步结束流式状态，输入框不再停留在等待模式。
- 无头 CLI 提示在 `agent_settled` 时正常收尾；默认响应超时由 600 秒提升至 1000 秒（仍可用 `TRANSPORTX_AGENT_RESPONSE_TIMEOUT_SECONDS` 覆盖）。

### Added

- 新增 `com.transportx.canvas` 1.1.0 与 `com.transportx.document` 1.1.0。Agent 可用 `canvas_present` 在 Canvas 中主动打开 Markdown、CSV、PDF、DOCX、XLSX、PPTX，并定位页面、幻灯片、Sheet、单元格或搜索结果；CSV 以只读表格显示，不加载 OOXML runtime；资源由 Host 按当前任务目录、Citation 固定版本和 Session Plan 校验。
- 新增显式 `CanvasContextV1` 共享：用户可以把当前文档位置、视频时间点或地图选区附到下一轮消息，Agent 仅能通过 `canvas_inspect_context` 读取本轮附加的 Context ID。

- Canvas 新增本地只读 OOXML Viewer：DOCX、XLSX 和 PPTX 可从工作区、工具结果、成果与引用入口打开，支持搜索、缩放、连续页或 Sheet 导航、选择与批注；XLSX 支持复制选择，PPTX 支持备注面板。三种格式按需加载 Rust/WASM Viewer，禁用在线字体与超链接，并通过 HEAD、32 MiB 文件上限、解压资源限制及 Citation SHA-256 版本校验保持现有文件安全边界。
- Canvas 支持 Markdown/PDF 文档标签，文件栏、工具文件预览、成果和引用入口统一打开文档；支持 Markdown 目录与标题定位、PDF 引用页码跳转、会话内阅读状态、手动刷新、原文件下载和报告 PDF 导出。引用文档绑定注册版本，内容变化时显示失效提示；其他文件保留原有浮窗预览。PDF 使用原生阅读器，未引入 PDF.js 或自定义搜索、缩略图、页内高亮、大文件优化。
- Module manifest 支持声明经过哈希校验的平台/架构专属 Native Runtime。
- 新增 `npm run video:pack`，生成包含自包含 Extension、Skill、ffmpeg/ffprobe 和许可证说明的视频能力包。

## 3.1.8 - 2026-09-15

### Fixed

- `com.transportx.shanghai-multimodal-data` 升级至 1.0.1：明确 SQLite `NUMBER` 结果必须保持数值类型，控制精度时使用数值表达式或 `ROUND`，避免格式化为文本。

### Added

- CLI 新增 `--append-system-prompt-file <path>`，允许按次追加 UTF-8 系统提示词，同时保留 TransportX 基础提示词与 CLI 会话上下文；CLI 默认配置目录与桌面端统一。
- 新增 `com.transportx.shanghai-multimodal-data` 1.0.0 数据模块，封装 2026-08-24 上海五种交通方式与站点邻近关系的 SQLite 快照，并提供分层的数据覆盖、表结构、指标、场景和空间口径说明。

## 3.1.7 - 2026-09-13

### Added

- 新增面向用户的 `transportx` 命令行入口，支持交互式会话、单次/JSON/JSONL 输出、模型选择，以及内置和已安装 Module 的精确选择；CLI 默认不加载任何可选 Module。
- Geo 模块升级至 1.3.0：新增 `capture_geo_screenshot` 工具，Agent 可请求工作台捕获最终地图、图例和说明，保存到当前任务目录，并将返回的相对路径插入 Markdown 报告与 PDF。
- 新增 `com.transportx.shanghai-hub-traffic` 1.0.0 首版模块，将两场三站源表治理为六个可关联 SQLite 数据库，提供来源血缘、冲突处置、质量规则、指标口径、只读查询和可复现构建校验脚本。

## 3.1.6 - 2026-09-09

### Changed

- Canvas 改为顶部具名成果标签，支持多个地图与视频、关闭与重新打开、键盘切换；移除领域面板重复选择器和独立地图／视频入口。隐藏视图保留查看状态，视频暂停。移除旧 Geo runtime bundle。
- Geo 与 Video 模块升级至 1.2.0：Agent 展示结果时激活对应 Canvas 标签；Geo 新增 `show_map`，可显示已有地图而不修改内容与 revision。
- 移除无调用的浏览器发送、旧模型列表文本解析、旧静态目录搜索与无消费者契约包装；引用解析、路径边界和受控进程执行改为共享实现。
- Timing 不再作为独立 Module；历史 Session Plan 中的内置 Timing 记录在恢复边界兼容忽略。
- 重构项目 README，补齐 Windows x64 安装与发布边界、跨平台用户数据目录、双向地图交互、地图截图和当前验证入口。
- 更新 Windows 发行指南与架构说明，记录 Python runtime 结构验收开关，并移除旧 Windows 用户数据路径。

## 3.1.5 - 2026-09-04

### Added

- `prepare-runtime.mjs` 新增 `TRANSPORTX_ALLOW_INCOMPLETE_PYTHON_RUNTIME=1` 预检逃生通道，允许 CI / 离线主机在 Python runtime 模块不全时继续打包以便做发行结构验收；该环境变量对真实发布流程无任何影响。
- Geo 模块升级至 1.1.0：支持要素、点位、矩形与当前视野四类可审计地图上下文，用户可将选择附到下一条消息，Agent 也可发起阻塞式地图输入请求。
- 新增 `inspect_map_context` 与 `request_geo_input` 工具，以及会话级持久化、恢复、超时、取消、中止和场景/资源失效终态。
- 地图工作台支持将当前地图画面、底部图层图例与说明截图为 PNG，并直接保存到当前任务目录。

### Changed

- 地图工作台增加交互模式、Context Tray、Agent 请求横幅、提交倒计时与严格 revision 失效处理；Feature Context 仅接受具有稳定唯一 ID 的受管资源图层。
- 地图交互模式由五个并列按钮收拢为单一模式切换器，默认使用浏览模式。

## 3.1.4 - 2026-09-02

### Changed

- 地图底图名称改为仅显示本地非拉丁文字，不再同时显示英文或拉丁转写；道路编号与业务图层标签保持不变。

### Fixed

- 修复 macOS 与 Windows 发布流程无法从 Builder 平台名解析运行时 Profile、导致安装包预检与运行时准备提前失败的问题。
- 修复 `desktop:dir:allow-unsigned` 在 macOS 上未触发 ad-hoc 重签名、导致目录测试包无法通过签名验证的问题。

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
