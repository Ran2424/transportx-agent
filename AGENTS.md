# AGENTS.md — TransportX Agent

本文件供 AI Agent / 协作者快速理解项目。详细设计见 [文档索引](#文档索引)；版本演进见 [docs/CHANGELOG.md](docs/CHANGELOG.md)。

## 项目概览

**TransportX Agent**：可安装的本地交通分析 Agent。产品形态为桌面工作台（Codex / VS Code 式高密度面板），面向交通分析人员，回答路段、时段、出行需求等交通问题，支持地图分析、视频查询与受控处理、任务拆解、引用与报告生成。

- **桌面生命周期**：Electron（主进程 + Agent Host Utility Process）
- **会话与资源边界**：Node Agent Host（Pi RPC、Python、会话、文件、鉴权）
- **交互与展示**：React 工作台（Vite 构建）

单仓库、模块化单体。**Pi Extension 产生受控数据 → Node 服务维护会话与资源边界 → React 负责交互展示**。没有第二套 Web UI 或 legacy 回退入口。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面 | Electron 43、electron-builder 26（DMG arm64 / NSIS x64） |
| 服务端 | Node.js + TypeScript，`src/server/` |
| 前端 | React 19、Vite、Tailwind CSS 4、Radix Dialog、MapLibre GL |
| 运行时 | 内置 Pi CLI `@earendil-works/pi-coding-agent` 0.80.10、可重定位 Python 3.10（PyYAML/numpy/matplotlib）；可安装 Video Capability 独立携带静态 ffmpeg/ffprobe 8.0 |

## 目录结构

```
src/
  contracts/        共享协议权威（Session/Task/Geo/Bridge 契约、验证原语）
  public/           浏览器内核与共享工具（kernel stores、markdown、tool-result、可视化 runtime）
  server/           Agent Host：会话、模块注册、资产解析、HTTP/WebSocket、鉴权
  web/              React 工作台（app 组合根、components UI 基元、platform 面板、features 功能）
desktop/            Electron 主进程、Agent Host supervisor、electron-builder 配置、发布脚本
modules/installable/  用户本地可安装模块暂存目录（默认不入 Git）
src/server/prompts/ 系统提示词（PI_SYSTEM.md）；内置 Skill / Extension 由 modules/capabilities 与 modules/official 贡献
test/  scripts/     node --test 测试与 smoke（react / desktop / pi-rpc）
docs/               架构、功能方案、验收与发布记录（见文档索引）
```

**构建产物（不入 Git，不手工编辑）**：`bin/`、`public/*.js`、`public/geo-runtime.*`、`dist/web/`、`dist-desktop/`、`release/`、`desktop/build/`。

## 常用命令

```bash
npm install                       # 安装依赖（prepare 会触发全量构建）
./start.sh                        # 开发启动，默认 http://127.0.0.1:3000
npm run dev:web                   # 另开终端：Vite 开发服务器（代理 API/WS 到 3000）
npm run desktop:dev               # 开发模式启动 Electron + 本地 Agent Host

npm run typecheck                 # 全部 tsconfig 类型检查（server/web/react/extensions/desktop/test）
npm run typecheck:react           # 只查 React 工作台
npm run build                     # 全量构建（server → web → react → geo → desktop）
npm test                          # 构建 + 核心 Agent Host 用户场景
npm run test:web                  # 真实 Node 服务 + fake Pi + Chrome 的 Web 功能冒烟
npm run test:platform:macos       # macOS Electron 生命周期 + 内置 Python/PDF 冒烟
npm run test:platform:windows     # Windows NSIS 安装器冒烟（仅 Windows x64，需已构建安装器）
npm run test:pi-smoke             # 真实本机 Pi RPC 冒烟（不纳入默认测试）
```

> 执行 Python 命令时使用本机环境：`/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10`（仅开发机；发布打包使用独立自包含 Python 3.10 runtime）。

## 关键约束（改动前必读）

- **不要用 `sudo` 启动**；桌面安装包使用内置 Pi/Python，Web 开发模式可用环境变量覆盖运行时。
- **用户数据统一在 `~/.transportx/traffic-agent/`**：任务工作区 `scenario/`、模型 `models.json`、认证 `auth.json`、会话/日志/缓存、受管模块 `modules/`。API Key 不返回前端。
- **Module 是统一安装单元**：可组合贡献 Skill / Extension / Native Runtime / Data / Knowledge。内置模块只提供 Workbench、Task、Geo、Citation、Web Bridge 等通用能力；`modules/installable/` 是用户本地可安装模块暂存目录，默认不入 Git，不是平台启动依赖。大体积交通知识库/数据库资产不写入仓库与安装包。
- **模块版本纪律**：每次改动某个 Module（manifest、Skill、Extension、脚本、数据目录内容）后，必须同步提升该模块 `manifest.json` 的 `version`（新能力升 minor、修复升 patch），并在 CHANGELOG 中说明；Resolved Session Plan 按精确版本冻结，版本号是会话可复现性的依据。
- **主题纪律（UI 改造后）**：`src/web/styles/tokens.css` 是 Light / Dark / Sand 三主题的**唯一 token 声明源**（primitive + semantic）。组件只消费 semantic token，禁止 `[data-theme] .component` 式覆盖，禁止在组件中写主题专属色值。功能文字不得低于 11px。新的样式修改应直接落在 `src/web/styles.css` 或遵循其分层结构，不要重复定义 token。
- **会话侧栏**：固定工具栏下方为能力扩展区 30% / 会话列表 70%（能力区可收起，移动端默认收起）。能力数据来自 `platform.getOverview()` 投影（`src/web/platform/capabilities/capability-projection.ts`），不要自行推测或复制服务端状态。
- **版本同步**：发布前同步 `package.json` 与 `src/server/config.ts` 的 `PLATFORM_VERSION`；`desktop/build/runtime-manifest.json` 由构建脚本自动生成，不要手改。
- **提交策略**：小型修复与小幅功能改动可直接提交 `main`；涉及新能力、架构调整或多环节联动的较大改动走「分支 → PR → 合并」流程（参考 PR #12 的 Video Capability）。
- **安全边界**：模块安装拒绝符号链接与路径逃逸；文件/Geo/Citation 资源按会话目录与 SHA-256 校验；Markdown 安全渲染；鉴权 Cookie 与 WebSocket 断连处理均有测试覆盖。
- **跨平台维护纪律**：所有 OS 相关的事实（python 入口与架构校验、ffmpeg 文件名 / chmod / 架构探测、签名环境变量、安装器 / 卸载器形为、安装器静默参数、release metadata）都集中于 [`desktop/scripts/platform-profile.mjs`](desktop/scripts/platform-profile.mjs)。`desktop/electron-builder.yml` 仅负责用 `extends:` 组合 [`electron-builder.common.yml`](desktop/electron-builder.common.yml) + [`electron-builder.mac.yml`](desktop/electron-builder.mac.yml) + [`electron-builder.win.yml`](desktop/electron-builder.win.yml)。增减新 OS 仅意味着：（1）在 `platform-profile.mjs` 增一条 profile；（2）新增一份 `electron-builder.<os>.yml` fragment 并在主文件 `extends` 中加入；（3）如果 profile.signing.hostArchRequired 不是 `x64/arm64`、或 ffmpeg/python 入口不一致，更新 [`test/desktop-runtime.test.ts`](test/desktop-runtime.test.ts) 的 snapshot 子例。**不允许在任何业务文件（`src/server/**`、`desktop/main.ts`、`desktop/agent-host-supervisor.ts`、`scripts/**`）重新引入 `process.platform === '...'` 分支、`path.sep` 拼接的边界判定、或 `.exe` 字符串拼接**；一律走现成 helper：`isWithin`（来自 `src/server/util/path.ts`）、`toPosixPath` / `relativePosixPath`（同上）。磁盘序列化一律 POSIX；内存判定一律 `path.relative`；混合写法在 review 阶段会被打回。同一 `npm run desktop:pack` 命令会根据 `process.platform` 自动走对应 profile，无需为 Windows 维护独立脚本。

## 发布流程

1. 提升版本：`package.json` + `src/server/config.ts`（两处一致）。
2. 更新 `docs/CHANGELOG.md`：遵循 Keep a Changelog，在 `Unreleased` 归集待发布的用户可见变更；发布时移入带 ISO 日期的版本段，并按 Added / Changed / Fixed / Security / Removed 分类。
3. 打包步骤全部由 `desktop/scripts/platform-profile.mjs` 驱动，不再为不同 OS 维护不同的命令/脚本：

   - macOS（已在 `platform-profile.darwin`）：

     ```bash
     TRANSPORTX_PYTHON_RUNTIME_DIR="$HOME/Library/Application Support/TransportX/python-3.10-runtime" \
     TRANSPORTX_ALLOW_UNSIGNED_BUILD=1 npm run desktop:pack    # 结构验收 / ad-hoc 签名测试包
     npm run desktop:pack                                       # 正式包，需要 Developer ID + 公证
     ```

   - Windows x64（已在 `platform-profile.win`）：`npm run desktop:pack` 在 Windows x64 主机上直接走入 `check-desktop-release.mjs` 的 win 分支。

   - 本机持久化的自包含 Python 3.10 runtime 位于 `~/Library/Application Support/TransportX/python-3.10-runtime`（mac）或 `C:\TransportX\runtime\python-3.10-win-x64`（win）；如缺失，可从 `desktop/build/runtimes/python`（上次构建残留）恢复，或按 `desktop/python-requirements.txt` 重新准备。
   - Video Capability 单独设置 `TRANSPORTX_VIDEO_MODULE_DIR` 与 `TRANSPORTX_FFMPEG_RUNTIME_DIR` 后运行 `npm run video:pack`；mac arm64 runtime 位于 `~/Library/Application Support/TransportX/ffmpeg-runtime`，win x64 位于 `C:\TransportX\runtime\ffmpeg-win-x64`，LICENSE/NOTICES 随模块包携带。
   - 产物在 `release/`：mac 产出 `latest-mac.yml` + DMG + blockmap + sha256 + `README-安装说明.txt`；win 产出 NSIS `setup.exe` + sha256 + 清单文件。同一句 `npm run desktop:pack` 下由 `process.platform` 决定产出哪个 artifact，**不要**在 macOS 上交叉打 Windows 包。
4. 正式对外分发需为各 profile 提供证书：

   - macOS：Developer ID Application + Apple 公证（Apple ID / App Store Connect API Key / keychain profile 之一）；凭据缺失时 `desktop:pack` 启动后会由 `check-desktop-release.mjs` 报错拦截。测试包走 ad-hoc 签名，首次启动需右键「打开」。
   - Windows x64：Authenticode 证书 + 可信时间戳（变量 `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`，或 Windows 证书库主题名 `WIN_CSC_NAME`，与 CSC_* 兼容）。凭据缺失时 `desktop:pack` 同样会被 `check-desktop-release.mjs` 拦截。

## 接入新 OS 平台

1. 在 `desktop/scripts/platform-profile.mjs` 增加一个 PLATFORM_PROFILES 条目，镜像 mac/win 的 schema（python / ffmpeg / signing / release）。在 `PROCESS_PLATFORM_TO_BUILDER` 中加 `linux: 'linux'`（或你期望的键）。
2. 新增 `desktop/electron-builder.<os>.yml`，仅含 `<os>:` 顶层 section + 安装器 segment；并在 `desktop/electron-builder.yml` 的 `extends` 列表中加上。
3. （仅以 ffmpeg / Python 为 source native binary 的 OS）安装 `desktop/scripts/check-desktop-release.mjs` 中所需的签名检测分支或删除不适用分支。
4. 同步 [`test/desktop-runtime.test.ts`](test/desktop-runtime.test.ts) 的 `PLATFORM_PROFILES` 子例（添加条目、赢 OS-特定约定），保证后续回归被防住。
5. 考虑是否需要安装器冒烟（mac/win 使用 NSIS / DMG；Linux 可使用 `scripts/desktop-smoke.mjs` 默认会验证已打包产物）。

完成后，所有运行时脚本、`package.json` 与 React 代码不需要任何改动。

## 文档索引

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 系统边界、依赖方向与模块职责（架构权威）
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — 按 Keep a Changelog 维护的发布历史

## 给 Agent 的日常工作流建议

- 改前端：先跑 `npm run typecheck:react`，涉及交互行为再跑 `npm run test:web`。
- 改服务端/契约：`npm run typecheck` + `npm test`（契约、边界与安全用例）。
- 改桌面/打包：`npm run typecheck:desktop`，结构验收用 `desktop:dir`，出包用 `desktop:pack`。
- 每轮改动遵循「先复现/定义成功标准 → 最小修改 → 运行对应检查」；不引入与任务无关的重构。
- 发布记录必须同步 `docs/CHANGELOG.md`；生成物目录不入 Git。
