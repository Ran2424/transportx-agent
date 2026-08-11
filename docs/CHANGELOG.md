# 版本修改与 GitHub 操作日志

本文记录项目每次提交、推送的主要内容、影响范围与验证结果，作为 README 之外的工程演进记录。

## 维护规则

- 产品版本遵循 SemVer：不兼容改造递增主版本，向后兼容的新能力递增次版本，向后兼容的问题修复递增补丁版本。
- npm、桌面安装包、Agent Host 平台版本和发布日志使用相同的三段式版本号。
- 新版本写在最上方；一次版本原则上对应一次提交并推送到 `origin/main`。
- 每条记录至少包含日期、GitHub 操作、主要修改和验证情况。
- 历史记录根据本地 Git 提交补录。Git 不保存普通 `git push` 的精确时间，因此旧版本使用提交时间，并以提交已经存在于 `origin/main` 作为推送完成依据。
- 若仅提交到开发分支，应明确记录分支名；合并到 `main` 后再补充合并与推送结果。

## v3.0.6 — 设置工作台与上海数据问答口径

- 日期：2026-08-11
- GitHub 操作：直接提交并推送至 `origin/main`。

主要修改：

- 将设置由弹窗调整为主工作区页面，新增常规、Agent 与模块导航；补充已配置模型概览、模块统计、响应式布局，以及返回工作台后的宽度恢复回归覆盖。
- 统一用户消息与助手消息的 Markdown 块级渲染，保证粘贴的表格、列表和段落能正确展示；新增相应单元测试。
- 更新 TransportX 品牌 Logo、浏览器图标和桌面应用图标，并归档原始 Logo 素材。
- 为 Shanghai Data 模块补充物理站跨线路汇总规则与 SQL 模板，新增数据审计和问答题库，避免将线路—站点单行结果误报为全站客流。
- 同步 Pi 系统提示的中文过程语言规则，以及界面主题与选中态的视觉细节。
- npm 包与平台版本同步更新为 `3.0.6`。

验证：

- `git diff --check` 与 `npm run typecheck` 通过。
- `node --experimental-transform-types --test test/markdown.test.ts` 通过。
- `npm run test:react-smoke` 完成构建和设置页流程，但在既有的会话产出卡片断言（等待“本次产出”）超时，待后续排查。

## v3.0.5 — Citation 服务与模块装配收敛

- 日期：2026-08-11
- GitHub 操作：直接提交并推送至 `origin/main`。

主要修改：

- 将 Citation、Geo、Task 与 Web Bridge 的 Pi Extension、Skill 和 Prompt 贡献收敛至模块目录，由 Module Registry 统一发现和装配；移除旧的顶层 Extension、Skill 与 Session Context 入口。
- 新增 Citation compiler、registry 与 service，补齐会话引用资源、证据定位、溯源关系和工作台引用管理界面；文件预览与对话投影同步使用新的引用契约。
- 更新平台能力投影、模块作者材料、安装模块清单与相关安全校验；同步调整 HTTP、桌面运行时、模块系统与任务生命周期回归用例。
- 工作台补充地图/对话分栏及侧栏面板的统一过渡效果，地图模式中的对话区采用 420ms 压缩/展开，其余面板保持 240ms。
- npm 包与平台版本同步更新为 `3.0.5`。

验证：

- `npm run typecheck:react` 通过。
- `npm run test:react-smoke` 通过。
- 本次提交前执行完整 `npm test` 回归。

## v3.0.4 — 附件系统与空间分析基础

- 日期：2026-08-10
- GitHub 操作：直接提交并推送至 `origin/main`。

主要修改：

- 将原有图片临时输入升级为 Session 级统一附件系统。文件经独立 multipart 上传接口保存至当前 Session，消息仅保留 `attachmentIds`；支持选择、拖拽和剪贴板入口，以及图片、PDF、Office、表格、文本和未知后缀文件。
- 附件元数据与消息引用支持历史恢复；服务端执行归属、路径、符号链接、哈希和大小校验，并向 Agent 注入安全相对路径上下文。具备视觉输入能力的模型额外接收图片内容。
- 文件工作区补充附件预览和附件卡片展示；Geo 场景新增 `remove_layer`、`reorder_layers` 原子操作。
- 桌面内置 Python runtime 新增 `pandas`、`pyproj` 和 `shapely`，并在打包前验证模块可导入，为后续交通空间分析提供表格处理、坐标投影与几何计算基础。
- 将历史实施资料、测试基线、评审与报告归档至 `docs/archive/`，根目录仅保留当前架构与变更记录；同步更新 README 链接与发布文件包含规则。
- npm 包与平台版本同步更新为 `3.0.4`。

验证：

- 持久化自包含 Python runtime 使用 `-I -B` 隔离模式导入三项空间分析库通过。
- `npm run typecheck` 通过；`npm test` 的 33 项中 31 项通过，附件与版本同步用例通过。
- 两项既有 Task Extension 用例在本机 Node 24.2.0 加载 TypeScript 的 CommonJS/ESM 边界时触发 `ERR_INTERNAL_ASSERTION`；启用 `--experimental-transform-types` 后仍复现，待 Node 运行时问题处理。

## v3.0.3 — 本地应用启动、会话恢复与平台模块边界修复

- 日期：2026-08-09
- GitHub 操作：通过 `codex/desktop-localization` 分支发布，并合并至 `origin/main`；发布后删除开发分支。
- 发布提交主题：`release: TransportX Traffic Agent 3.0.3`

主要修改：

- macOS Agent Host 改用 Electron Utility Process，避免应用启动时在 Dock 中短暂出现独立 `exec` Electron 图标，同时保留 PDF IPC、日志和退出清理能力。
- 会话历史兼容根目录与项目子目录两种持久化结构，恢复项目统计、历史会话列表、全文搜索与应用重启后的会话加载。
- 平台内置模块收敛为 Workbench、Task、Geo、Citation、Web Bridge 和 Report 等通用能力；上海交通数据、交通保障知识与绘图经验分别迁移为 `shanghaidata`、`traffic-assurance-knowledge`、`plot-style` 用户安装模块，不进入应用安装包。
- macOS 窗口使用 `hiddenInset`，将原生红黄绿窗口控件整合到工作台顶部栏，并保持 Web、Windows 与 Linux 布局不变。
- 默认 Node 回归测试由 94 项精简为 30 项必要测试，保留共享契约、桌面运行时、会话恢复、资源隔离、模块装配、Task 生命周期与 WebSocket 安全等关键边界。
- npm 包与平台版本同步更新为 `3.0.3`。

验证：

- TypeScript 桌面、React 与测试配置检查通过。
- `npm test` 通过：30 项必要回归，0 项失败。
- `npm run test:desktop-smoke` 通过，验证 Electron、Agent Host 与集成式 macOS 窗口正常启动和关闭。

## v3.0.2 — 三主题设计系统、会话侧栏能力区与桌面质感统一

- 日期：2026-08-09
- GitHub 操作：通过 `codex/desktop-localization` 分支提交 `78a143b`，尚未推送至 `origin/main`。
- 发布提交主题：`release: TransportX Traffic Agent 3.0.2`

主要修改：

- 建立 Light / Dark / Sand 三主题共用的 semantic token contract：`styles/tokens.css` 统一存放品牌 primitives、结构刻度（字号/间距/圆角/控件高度）与三套主题 token，组件只消费 semantic token；清理历史 `--react-*` 兼容别名与重复主题覆盖，切换主题只修改根节点 `data-theme`，不改变任何布局、尺寸、DOM 与交互。
- 会话侧栏新增能力扩展区：位于固定工具栏下方、会话列表上方，按 30% / 70% 拆分并分别独立滚动。提供模块、技能、数据、知识四类紧凑 Tabs（底部 2px 强调线），能力条目由现有 Platform Overview 投影（不新增服务端协议），支持 Loading 骨架、空状态与错误重试，状态统一为已启用 / 待配置 / 不可用并配状态点；能力区可收起（`localStorage` 持久化，≤860px 移动端默认收起）。
- Header 改为窗口 Chrome：有活动任务时中部视觉焦点切换为任务名称与运行状态，品牌标识退居低对比度；模型选择器、连接状态和工作区操作保持高优先级。
- 设置页收敛为 Light、Dark、Sand 三个正式主题，主题预览运行时直接读取 semantic token，不再维护第二份手写色值；旧主题偏好自动迁移（clean→light、night/dawn/midnight→dark、terracotta→sand、sage→light、未知值回退到 sand），新安装默认 Sand 主题。
- 统一桌面质感：按钮、图标按钮、输入框、Tabs、菜单、Dialog 收敛控件高度（28–36px）与圆角规则（小型控件 6px、输入 8px、容器 12px）；功能文字下限提升至 11px；欢迎页 Hero 收敛为桌面应用欢迎标题（42–56px）并缩小留白；主面板移除多余阴影与卡片化边框，阴影通过 semantic token 提供。
- 将 npm 包版本更新为 `3.0.2`，同步 `src/server/config.ts` 的 `PLATFORM_VERSION`。
- 默认 Node 回归由 94 项收敛为 30 项必要测试，删除重复 happy-path、渲染微行为与已由 React/Desktop smoke 覆盖的实现细节用例。

验证：

- `npm run typecheck`（react / web / server）通过。
- `npm test` 通过：30 项必要回归，0 项失败。
- `npm run build:react` 通过；产物 CSS 仅保留 `light / dark / sand` 三个主题选择器，无旧主题与 `--react-*` 变量残留。
- `npm run test:react-smoke` 通过，覆盖主题切换、会话侧栏与桌面/移动端基线。
- `TRANSPORTX_PYTHON_RUNTIME_DIR=… TRANSPORTX_ALLOW_UNSIGNED_BUILD=1 npm run desktop:pack` 产出 `TransportX Traffic Agent-3.0.2-arm64.dmg`（约 242 MB），ad-hoc 签名与结构校验通过；正式外发仍要求 Developer ID Application 证书与 Apple 公证。

## v3.0.1 — 模块资产与 Mac 发布链修复

- 日期：2026-08-09
- GitHub 操作：通过 `codex/desktop-localization` 分支提交并推送，创建面向 `main` 的草稿 PR。

主要修改：

- Pi 基础系统提示词改为从 `prompts/PI_SYSTEM.md` 加载，会话路径和资产上下文继续由 `PI_SESSION_CONTEXT.md` 动态追加。
- 修复 Knowledge、Data 与 Skill 解耦后的资产根目录、脚本参数、引用原件和设置页生效状态，补充 Knowledge 清单完整性校验。
- 完善模块安装、卸载和同类资产选择规则，模块可统一贡献 Skill、Extension、Data 与 Knowledge。
- Mac 安装包显式携带并解包需要真实文件系统路径的 Skill，增加正式签名与 Apple 公证凭据前置检查。
- 同步架构、实施记录、数据资产说明和交通分析报告中的新目录与运行方式。

验证：

- `npm run typecheck`、自动化测试、桌面构建与安装包结构检查通过。
- 正式外发包仍要求 Developer ID Application 证书和 Apple 公证凭据；缺失凭据时发布脚本拒绝生成正式包。

## v3.0 — TransportX Traffic Agent 桌面化与模块化

- 日期：2026-08-09
- GitHub 操作：通过 `codex/desktop-localization` 分支提交并推送，创建面向 `main` 的草稿 PR。

主要修改：

- 产品统一命名为 `TransportX Traffic Agent`，新增安全沙箱化 Electron 宿主、单实例窗口和 Agent Host 进程治理。
- Agent Host 支持随机回环端口、版本化 ready/health 协议、父进程退出检测、有界日志与进程树清理。
- 新增 Runtime Manifest、内置 Pi/Python 路径解析、持久化用户目录和统一 Python Runner，移除正式能力中的开发机绝对运行时路径。
- 新增 Manifest v1、Module Registry、Asset Resolver 和 Session Assembly；Task、Citation、Geo、交通 Skill、Knowledge、Data 与 Template 通过官方模块装配。
- Module 升级为统一生命周期单元，可组合贡献 Skill、Extension、Data 和 Knowledge；单独资源安装会自动包装为受管 Module。
- 新增本地模块安装器、动态注册表重载和安全卸载，模块统一复制到 `~/.transportx/traffic-agent/modules/`，拒绝符号链接与包路径逃逸。
- Data/Knowledge 已从 Skill 目录彻底迁出；查询脚本必须使用会话注入的资产根目录，不再存在相邻目录回退。
- Data/Knowledge 查询同时支持显式 `--data-root` / `--knowledge-root` 诊断参数；Geo Extension 不再引用旧 Skill 内的数据库路径。
- 同类资产按用户安装、外部加载、内置顺序选择；同优先级冲突时要求显式资产 ID，设置页标记当前生效资产。
- Knowledge 清单从仅检查文件存在升级为逐文件 SHA-256 校验，独立安装时兼容并规范化旧 `knowledge/` 前缀。
- 支持通过环境变量选择外部 Knowledge/Data Root、导入只读外部模块 Manifest，并切换会话领域模块。
- 每个新建或恢复会话保存 `ResolvedSessionPlan`，记录实际 Platform、Pi、Python、Module 与资产版本。
- macOS 应用数据统一迁移到 `~/.transportx/traffic-agent/`，任务工作目录固定为其下的 `scenario/`，Pi 模型、认证、会话、日志和缓存不再散落到其他用户目录。
- 首次启动不再提供默认模型；新建任务、模型选择器和设置页均可添加 Pi 兼容模型，并将密钥与模型定义分开安全存储。
- 设置页新增统一模块管理，可查看每个模块贡献的 Skill、Extension、Data、Knowledge 和 Template，并安装模块包、单独资源或卸载用户模块。
- macOS 打包改用经校验的可重定位 Python 3.10 运行时，固定运行依赖并检查版本、arm64 架构、模块完整性及复制后的路径边界。
- macOS 打包将查询 Skill 与通用 Skill 放入 `app.asar.unpacked`，Session Assembly、Citation 与 Geo Extension 向 Python 传递真实文件系统路径。
- 桌面报告 PDF 改由 Electron 主进程安全渲染，不再依赖目标机器预装 Chrome；新增 macOS 应用图标、hardened runtime entitlement、公证配置和发布凭据前置检查。
- 清理旧 launchd 配置、字体测试文件、旧图标和生成缓存；仓库内 298 MB 历史任务经校验后迁移到 `~/.transportx/traffic-agent/scenario/`。
- 重写整体架构和桌面化实施文档，使组件职责、Session Assembly、Module 生命周期、Data/Knowledge 解耦、用户目录、安全边界、macOS 分发问题与当前发布限制和实际实现保持一致。

验证：

- `npm run typecheck` 通过。
- `npm test`：93 项测试，91 项通过、2 项外部 Knowledge 资产用例按默认策略跳过，0 项失败；另以本机受管资产运行 4 项引用集成测试，全部通过。
- `npm run test:react-smoke` 通过，覆盖添加模型、模块设置、桌面端与移动端基线。
- `npm run test:desktop-smoke` 通过，验证 Electron 安全选项、Mac 应用目录、无默认模型、Agent Host、包内 Python、PDF 导出和退出清理。
- arm64 `.app` 的测试构建会在生成 DMG 前应用并严格验证 ad-hoc 签名；Python 启动链禁止在 `.app` 内生成字节码缓存。应用从只读 DMG 完整启动前后均通过严格签名检查，240 MB DMG 通过 `hdiutil verify`。正式外发仍需 Developer ID 签名和 Apple 公证，发布脚本会在凭据缺失时停止。

## v2.14 — 响应式对话布局与报告预览完善

- 日期：2026-07-30
- GitHub 操作：`codex/report-relative-images` 与 `feat/style-opt` 已快进合并并推送至 `origin/main`，两个临时分支已删除；`v2.14.0` 发布提交已推送至 `origin/main`。
- 发布提交主题：`release: v2.14.0 responsive conversation layout`

主要修改：

- Markdown 报告预览支持安全解析相对图片路径，通过当前会话的文件预览接口加载图片，并在导出 PDF 时复用同一受控解析逻辑。
- 地图与对话双栏增加可拖拽分隔条，支持键盘调节、双击恢复默认宽度，并在浏览器本地保存对话区宽度。
- 重构消息输入框，将附件、任务模式和发送操作收拢到统一工具栏；无文字和附件时禁用发送按钮。
- 收紧对话区的响应式布局，避免表格、公式、图片、思考过程和工具卡片在窄栏中横向溢出，同时保持移动端地图抽屉行为不变。
- 补充相对图片安全边界、报告 PDF 导出和浏览器交互覆盖；将 npm 包版本更新为 `2.14.0`。

验证：

- `npm run typecheck` 通过。
- `npm test`：70 项通过，0 项失败。
- `npm run test:react-smoke` 通过，桌面端与移动端基线正常。

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
