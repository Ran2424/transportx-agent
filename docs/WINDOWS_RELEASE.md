# Windows 10/11 x64 发行指南

本文是 TransportX Traffic Agent Windows 安装包的发布权威说明。首发范围仅为 64 位 Windows 10（22H2）和 Windows 11；不支持 Windows on ARM、便携版或自动在线安装 Python/ffmpeg。

## 交付物与边界

- 安装器：`TransportX Traffic Agent-<version>-win-x64-setup.exe`（NSIS）。
- 安装方式：每用户安装，允许选择目录；同一 `appId` 的新版本会原位升级。
- 用户数据：默认位于 `%APPDATA%\TransportX Traffic Agent`，卸载不会删除。任务、会话、模型密钥、日志和受管 Module 均在这里，不能置于安装目录。
- 内置运行时：Pi CLI、Python 3.10 x64、`ffmpeg.exe` 与 `ffprobe.exe`。已打包应用不得依赖系统 `PATH`、Conda、Homebrew、Python 或 ffmpeg。

## 发行前准备

必须在原生 Windows x64 主机或 Windows x64 CI runner 上构建和验收。不要从 macOS 交叉生成正式包：Python、视频二进制、NSIS 和进程退出行为都需要在目标平台实际运行。

准备两个可重定位目录：

- `TRANSPORTX_PYTHON_RUNTIME_DIR`：根目录包含 `python.exe`。在 `python.exe -B -I` 下必须为 Python 3.10 x64，并包含 `ssl`、`sqlite3`、PyYAML、numpy、matplotlib、pandas、pyproj 和 shapely。开发用 Conda 环境不是发行 runtime。
- `TRANSPORTX_FFMPEG_RUNTIME_DIR`：根目录包含 `ffmpeg.exe`、`ffprobe.exe`，以及相应 `LICENSE` 或 `NOTICES` 文件。二进制的来源、版本、SHA-256 和许可证应进入本次发行记录。

正式发行还需配置 Authenticode 证书。electron-builder 使用其标准证书变量：证书文件使用 `WIN_CSC_LINK`（或 `CSC_LINK`）及对应密码；Windows 证书库使用 `WIN_CSC_NAME`（或 `CSC_NAME`）。签名服务须支持可信时间戳。不要把证书、密码或私钥写入仓库。

## 构建命令

在 PowerShell 中：

```powershell
$env:TRANSPORTX_PYTHON_RUNTIME_DIR = 'C:\TransportX\runtime\python-3.10-win-x64'
$env:TRANSPORTX_FFMPEG_RUNTIME_DIR = 'C:\TransportX\runtime\ffmpeg-win-x64'
$env:WIN_CSC_LINK = 'C:\secure\transportx-codesign.pfx'
$env:WIN_CSC_KEY_PASSWORD = '<certificate-password>'
npm ci
npm run desktop:pack:win
```

仅内部结构验收可省略签名，并显式标记为未签名测试包：

```powershell
$env:TRANSPORTX_ALLOW_UNSIGNED_BUILD = '1'
npm run desktop:pack:win
```

`npm run desktop:dir:win` 产生未安装的 `release\win-unpacked\`，用于快速检查。两条 Windows 命令都拒绝在非 Windows 或非 x64 Node 环境中运行；构建脚本会在复制后实际启动 Python、ffmpeg 和 ffprobe，并将版本、相对路径、架构及 SHA-256 写入 `runtime-manifest.json`。

## 验收

先验证未安装包：

```powershell
$env:TRANSPORTX_PACKAGED_APP = (Resolve-Path '.\release\win-unpacked\TransportX Traffic Agent.exe').Path
npm run test:desktop-smoke
```

再验证最终 NSIS 安装器的静默安装、启动、卸载和用户数据保留：

```powershell
$env:TRANSPORTX_WINDOWS_INSTALLER = (Resolve-Path '.\release\TransportX Traffic Agent-<version>-win-x64-setup.exe').Path
npm run test:windows-installer-smoke
```

发布前还须在两台干净机器上人工完成：Windows 10 22H2 x64 与 Windows 11 x64 各一台。每台测试首次安装、创建任务、添加模型、视频播放与裁剪、PDF 导出、覆盖升级、卸载和重新安装。检查签名与安装器哈希：

```powershell
Get-AuthenticodeSignature '.\release\TransportX Traffic Agent-<version>-win-x64-setup.exe'
Get-FileHash '.\release\TransportX Traffic Agent-<version>-win-x64-setup.exe' -Algorithm SHA256
```

将安装器、SHA-256、签名状态、Python/ffmpeg 来源及版本、验收系统版本一并归档。SmartScreen 信誉由签名和发布历史逐步建立，代码签名本身不保证新发行者立刻不显示提示。
