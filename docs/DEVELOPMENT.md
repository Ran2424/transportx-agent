# 开发与运行指南

本文记录源码启动、命令行使用、桌面打包和验证入口。产品定位与功能见 [README](../README.md)，运行架构与数据目录见 [架构说明](ARCHITECTURE.md)。

## 开发启动

先安装依赖：

```bash
npm install
```

### 本地 Web 工作台

```bash
./start.sh
```

服务默认监听 <http://127.0.0.1:3000>。需要 React 热更新时，保留上述进程，再开一个终端运行：

```bash
npm run dev:web
```

Vite 地址为 <http://127.0.0.1:5173>，API 与 WebSocket 默认代理到 `127.0.0.1:3000`。

### Electron 开发模式

```bash
npm run desktop:dev
```

### 命令行模式

构建后可以直接在终端启动 TransportX Agent：

```bash
node bin/transportx.js
node bin/transportx.js --print "分析当前交通数据"
node bin/transportx.js modules list
```

通过 `npm link` 或安装 npm 包后，入口命令为 `transportx`。命令行默认不加载任何可选 Module；随平台提供的 Task、Citation、Web Bridge、Geo、Spatial Analysis 仍需通过可重复的 `--module <id[@version]>` 显式启用。Video 还必须先安装对应平台的能力包，再用相同参数选择。`--no-modules` 可用于明确声明不加载可选 Module：

```bash
transportx --module com.transportx.task@1.0.1
transportx --module com.transportx.shanghaidata@2.0.2 --print "统计早高峰流量"
transportx --append-system-prompt-file /absolute/path/to/eval-system-prompt.md --print "执行评测题"
transportx --no-modules --model provider/model
```

`--append-system-prompt-file` 读取 UTF-8 文件，将其内容追加在 TransportX 基础提示词和 CLI 会话上下文之后；它不能替换平台基础提示词。CLI 默认读取 TransportX 用户目录中的 `settings.json` 和已安装 Module，也可通过 `PI_CODING_AGENT_DIR` 显式覆盖。

CLI 仍通过 Agent Host 创建独立任务目录，并冻结精确的 Module 版本。Geo 框选、地图截图和视频播放等界面交互需要桌面工作台。

首次创建任务前，在“新建交通任务”或“设置”中添加一个 Pi 兼容模型。模型定义与密钥分开保存，API Key 不返回前端。


## 桌面打包

基础发布包内置 Pi CLI 和 Python 3.10，不依赖用户机器上的 Conda 或系统 Python。构建前必须准备对应平台和架构的可重定位 Python 运行时：

```bash
TRANSPORTX_PYTHON_RUNTIME_DIR=/absolute/path/to/python-runtime npm run desktop:pack
```

`npm run desktop:pack` 会根据当前宿主平台选择发布 Profile。macOS 正式包要求 Developer ID 签名和 Apple 公证；Windows 正式包要求 Authenticode 证书和可信时间戳。不要在 macOS 上交叉生成 Windows 正式包。

Video Capability 独立构建，不参与基础桌面包：

```bash
TRANSPORTX_FFMPEG_RUNTIME_DIR=/absolute/path/to/ffmpeg-runtime npm run video:pack
```

产物位于 `release/modules/transportx-video-<version>-<platform>-<arch>.zip`，包含编译后的 Extension、Skill、ffmpeg/ffprobe、校验值和许可证说明。必须在目标平台构建对应能力包。

### Windows 10/11 x64

Windows 使用每用户 NSIS 安装器，允许选择安装目录，支持同一 `appId` 原位升级，卸载时保留 `%APPDATA%\TransportX\traffic-agent\`。应用窗口使用与其他桌面平台一致的无边框壳，最小化、最大化和关闭按钮位于左侧。在原生 Windows x64 主机的 PowerShell 中：

```powershell
$env:TRANSPORTX_PYTHON_RUNTIME_DIR = 'C:\TransportX\runtime\python-3.10-win-x64'
$env:WIN_CSC_LINK = 'C:\secure\transportx-codesign.pfx'
$env:WIN_CSC_KEY_PASSWORD = '<certificate-password>'
npm ci
npm run desktop:pack
```

产物位于 `release/TransportX Traffic Agent-<version>-win-x64-setup.exe`。Video Capability 另行设置 `TRANSPORTX_FFMPEG_RUNTIME_DIR` 并运行 `npm run video:pack`，生成平台专属模块 ZIP。

内部结构验收可使用 `TRANSPORTX_ALLOW_UNSIGNED_BUILD=1`。如果离线 CI 的 Python 缺少项目依赖，还可额外设置 `TRANSPORTX_ALLOW_INCOMPLETE_PYTHON_RUNTIME=1`；该变量只能验证包结构，不能用于正式发行或功能验收。完整流程见 [Windows 发行指南](./WINDOWS_RELEASE.md)。

### macOS arm64

本机结构验收可生成 ad-hoc 签名包：

```bash
TRANSPORTX_PYTHON_RUNTIME_DIR="$HOME/Library/Application Support/TransportX/python-3.10-runtime" \
TRANSPORTX_ALLOW_UNSIGNED_BUILD=1 \
npm run desktop:pack
```

正式 DMG 不设置 `TRANSPORTX_ALLOW_UNSIGNED_BUILD`，并需提供签名与公证凭据。


## 使用限制

- 不要用 `sudo` 启动服务或桌面应用，否则用户数据和模块目录的权限会被破坏。
- 在线底图需要网络；使用 `none` 底图时可以离线显示任务内 GeoJSON。
- 交通数据库、知识库原文、模型密钥和用户安装的 Module 不随源码或安装包分发。
- 发布版只使用包内运行时；环境变量覆盖仅用于开发、测试和受控部署。

## 验证

| 命令 | 验证范围 |
|---|---|
| `npm run typecheck` | 全部 TypeScript 项目 |
| `npm test` | Agent Host 启动、任务环境、Module 安装与进程退出 |
| `npm run test:web` | 真实 Node 服务、fake Pi 与 Chrome 中的 React 用户场景 |
| `npm run test:platform:macos` | macOS Electron 生命周期、内置 Pi/Python、可选视频运行时隔离、PDF 与退出清理 |
| `npm run test:platform:windows` | Windows 未安装应用，或 NSIS 安装、启动、卸载和数据保留 |
| `npm run test:pi-smoke` | 本机真实 Pi RPC 冒烟；不纳入默认测试 |

Windows 测试需要设置 `TRANSPORTX_PACKAGED_APP` 或 `TRANSPORTX_WINDOWS_INSTALLER`，并在 Windows x64 主机运行。

