# Windows 10/11 x64 发行指南

本文是 TransportX Traffic Agent Windows 安装包的发布权威说明。首发范围仅为 64 位 Windows 10（22H2）和 Windows 11；不支持 Windows on ARM、便携版或自动在线安装 Python。

## 交付物与边界

- 安装器：`TransportX Traffic Agent-<version>-win-x64-setup.exe`（NSIS），由 [`desktop/electron-builder.win.yml`](../desktop/electron-builder.win.yml) 中的 `win.artifactName` 与 `nsis.deleteAppDataOnUninstall: false` 决定卸载行为。
- 安装方式：每用户安装，允许选择目录；同一 `appId` 的新版本会原位升级。
- 用户数据：默认位于 `%APPDATA%\TransportX\traffic-agent\`，卸载不会删除。任务、会话、模型密钥、日志和受管 Module 均在这里，不能置于安装目录。3.1.3 起不再读取旧目录 `%APPDATA%\TransportX Traffic Agent\`。
- 内置运行时：Pi CLI 与 Python 3.10 x64。`ffmpeg.exe` 与 `ffprobe.exe` 仅由额外安装的 Windows x64 Video Capability Module 提供；基础应用和视频能力均不得依赖系统 `PATH`、Conda、Python 或 ffmpeg。

## 发行前准备

必须在原生 Windows x64 主机或 Windows x64 CI runner 上构建和验收。不要从 macOS 交叉生成正式包：Python、视频二进制、NSIS 和进程退出行为都需要在目标平台实际运行。`desktop/scripts/check-desktop-release.mjs` 会按 `platform-profile.win.signing.hostArchRequired === 'x64'` 检查宿主架构，非 x64 Node 会立即报错。

基础安装包准备一个可重定位 Python 目录：

- `TRANSPORTX_PYTHON_RUNTIME_DIR`：根目录包含 `python.exe`。在 `python.exe -B -I` 下必须为 Python 3.10 x64（`platform.machine()` 必须为 `AMD64` / `x86_64`），并包含 `ssl`、`sqlite3`、PyYAML、numpy、matplotlib、pandas、pyproj 和 shapely。`platform-profile.mjs.PYTHON_REQUIRED_MODULES` 是这个清单的单一来源，任何新增 module 都必须同时改这里。

发布 Video Capability 时另行准备 `TRANSPORTX_FFMPEG_RUNTIME_DIR`：根目录包含 `ffmpeg.exe`、`ffprobe.exe`（`platform-profile.win.ffmpeg.binName(name)` 自动添加 `.exe`），以及相应 `LICENSE` 或 `NOTICES` 文件。二进制的来源、版本、SHA-256 和许可证应进入模块发行记录。

正式发行还需配置 Authenticode 证书。`desktop/scripts/check-desktop-release.mjs` 读取 `platform-profile.win.signing.requiredEnv`，electron-builder 使用其标准证书变量：证书文件使用 `WIN_CSC_LINK`（或 `CSC_LINK`）及对应密码；Windows 证书库使用 `WIN_CSC_NAME`（或 `CSC_NAME`）。签名服务须支持可信时间戳。不要把证书、密码或私钥写入仓库。

## 构建命令

`npm run desktop:pack` 是 macOS 与 Windows 共享的入口；脚本链会基于 `process.platform` 自动走到正确的 profile，无需手动切换。

### macOS（参考，不属本节）

```bash
TRANSPORTX_PYTHON_RUNTIME_DIR="$HOME/Library/Application Support/TransportX/python-3.10-runtime" \
TRANSPORTX_ALLOW_UNSIGNED_BUILD=1 npm run desktop:pack    # ad-hoc 测试包
npm run desktop:pack                                       # 正式包（需 Developer ID + 公证）
```

### Windows x64 — 正式包

在 PowerShell 中：

```powershell
$env:TRANSPORTX_PYTHON_RUNTIME_DIR = 'C:\TransportX\runtime\python-3.10-win-x64'
$env:WIN_CSC_LINK = 'C:\secure\transportx-codesign.pfx'
$env:WIN_CSC_KEY_PASSWORD = '<certificate-password>'
npm ci
npm run desktop:pack
# 实际执行：check-desktop-release.mjs(win) -> prepare-runtime.mjs(profile.win) -> electron-builder --config desktop/electron-builder.yml
```

Video Capability 单独生成：

```powershell
$env:TRANSPORTX_FFMPEG_RUNTIME_DIR = 'C:\TransportX\runtime\ffmpeg-win-x64'
npm run video:pack
# 产物：release\modules\transportx-video-<version>-win32-x64.zip
```

### Windows x64 — 内部未签名测试包

仅内部结构验收可省略签名，并显式标记为未签名测试包：

```powershell
$env:TRANSPORTX_ALLOW_UNSIGNED_BUILD = '1'
npm run desktop:pack
```

若离线 CI 或临时验收机上的 Python 3.10 缺少部分项目依赖，可以同时设置：

```powershell
$env:TRANSPORTX_ALLOW_UNSIGNED_BUILD = '1'
$env:TRANSPORTX_ALLOW_INCOMPLETE_PYTHON_RUNTIME = '1'
npm run desktop:pack
```

`TRANSPORTX_ALLOW_INCOMPLETE_PYTHON_RUNTIME` 只跳过 Python 依赖完整性预检，不会补齐缺少的模块。由此生成的应用不能用于功能验收或正式分发。正式包必须取消该变量，并通过完整的 Python runtime 探测与平台冒烟。

### Windows x64 — 快速结构预览（不安装）

```powershell
npm run desktop:dir:allow-unsigned
# 实际执行：check-desktop-release.mjs --allow-unsigned -> prepare-runtime.mjs -> electron-builder --dir
# 产物：release/win-unpacked/TransportX Traffic Agent.exe + resources/
```

基础构建脚本会在复制后实际启动 Python，并把版本、相对路径及 SHA-256 写入 `desktop/build/runtime-manifest.json`。Video Capability 打包脚本单独启动并校验 ffmpeg/ffprobe，把平台、架构、版本、路径及 SHA-256 写入模块 manifest。两类文件均为构建产物，不应手工修改或提交。

## 验收

先验证未安装包：

```powershell
$env:TRANSPORTX_PACKAGED_APP = (Resolve-Path '.\release\win-unpacked\TransportX Traffic Agent.exe').Path
npm run test:platform:windows
```

再验证最终 NSIS 安装器的静默安装、启动、卸载和用户数据保留：

```powershell
$env:TRANSPORTX_WINDOWS_INSTALLER = (Resolve-Path '.\release\TransportX Traffic Agent-<version>-win-x64-setup.exe').Path
npm run test:platform:windows
```

未安装应用与 NSIS 安装器场景都必须在 Windows x64 CI runner 或实机执行；macOS 验收使用 `npm run test:platform:macos`。

发布前还须在两台干净机器上人工完成：Windows 10 22H2 x64 与 Windows 11 x64 各一台。每台测试基础安装包启动、Video Capability 安装/禁用/卸载、视频播放与裁剪、PDF 导出、覆盖升级、卸载和重新安装。检查签名与安装器哈希：

```powershell
Get-AuthenticodeSignature '.\release\TransportX Traffic Agent-<version>-win-x64-setup.exe'
Get-FileHash '.\release\TransportX Traffic Agent-<version>-win-x64-setup.exe' -Algorithm SHA256
```

将安装器、Video Capability ZIP、SHA-256、签名状态、Python/ffmpeg 来源及版本、验收系统版本一并归档。SmartScreen 信誉由签名和发布历史逐步建立，代码签名本身不保证新发行者立刻不显示提示。

## 接入新平台（参考）

本节告诉维护者「如果加一个平台，profile 怎么扩」。Windows 的所有约定都集中在 [`desktop/scripts/platform-profile.mjs`](../desktop/scripts/platform-profile.mjs) 的 `PLATFORM_PROFILES.win` 中：

1. 在 `PLATFORM_PROFILES.win` 增 / 改条目时，同步更新 [`test/desktop-runtime.test.ts`](../test/desktop-runtime.test.ts) 的 `platform-profile registry exposes frozen mac/win profiles with required contract` 子例中的断言（OS-specific invariants）。
2. 修改 NSIS / `win:` 段时改 [`desktop/electron-builder.win.yml`](../desktop/electron-builder.win.yml)；如换 DMG/MAS/AppX 等其它 artifact，直接在该 fragment 内替换。
3. 任何运行时脚本如果要再次写 OS 分支，都需要先确认是不是真没有对应的 profile 字段；如确有必要（例如 OS 进程模型 `taskkill` 等纯 OS API），可以加，但需要 PR 中同时在 `PLATFORM_PROFILES` 增加对应字段并替换之。
