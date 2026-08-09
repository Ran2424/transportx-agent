# TransportX Traffic Agent 桌面化与模块化实施记录

- 文档状态：已实现基线
- 文档版本：v2.0
- 产品版本：3.0.1
- 更新时间：2026-08-09
- 正式实现：Electron + Node Agent Host + Pi CLI + Python 3.10 + React Workspace

本文记录从 Pi Traffic Workspace 开发项目到 TransportX Traffic Agent 桌面产品的实施结果。当前权威运行架构、依赖方向和安全边界见 [ARCHITECTURE.md](./ARCHITECTURE.md)；本文聚焦改造范围、落地结果、验收状态和仍待完成的发布工作。

## 1. 改造目标

改造前的项目依赖开发机环境、命令行启动和固定目录，领域 Skill 与 Knowledge/Data 资产耦合，缺少统一用户目录、模型接入、进程治理和安装包发布边界。

3.0 改造完成后的产品目标是：

- 用户通过桌面应用启动现有交通分析工作台；
- Node、Pi CLI 和基础 Python 随应用管理，不要求目标机器预装；
- macOS 文件统一保存在 `~/.transportx/traffic-agent/`；
- 应用不提供默认模型，用户通过前端添加 Pi 兼容模型；
- Module 统一管理 Skill、Extension、Data、Knowledge 和 Template；
- Data/Knowledge 不再放在 Skill 相邻目录；
- 每个 Session 保存实际使用的模型、模块、运行时和资产计划；
- macOS 安装包具有可验证、可签名和可公证的发布流程。

## 2. 实施结论

| 工作项 | 状态 | 当前结果 |
|---|---|---|
| 产品本地化与命名 | 完成 | UI、Manifest、运行时校验统一为 TransportX Traffic Agent |
| Electron 桌面宿主 | 完成 | 单实例、安全窗口、Agent Host 管理、PDF 桥 |
| Agent Host 桌面模式 | 完成 | 随机回环端口、ready/health、父进程检测、退出清理 |
| Pi CLI 内置解析 | 完成 | 桌面模式只从 Runtime Manifest 解析，不回退全局 Pi |
| Python 运行时 | 完成 | 可重定位 Python 3.10、统一 Runner、缓存外置 |
| macOS 用户目录 | 完成 | 根目录固定为 `~/.transportx/traffic-agent/` |
| 无默认模型 | 完成 | 新任务必须选择模型，前端支持添加 Pi 兼容模型 |
| Module Registry | 完成 | Manifest v1、兼容性、依赖、错误隔离和动态重载 |
| Module Installer | 完成 | Module 或单独 Skill/Extension/Data/Knowledge 安装与卸载 |
| Asset Resolver | 完成 | Data/Knowledge/Template 按 Manifest 解析 |
| Session Assembly | 完成 | 生成并保存 `ResolvedSessionPlan` |
| Skill 与资产解耦 | 完成 | 实体 Data/Knowledge 从 `skills/` 迁出，不提供相邻目录回退 |
| macOS Apple Silicon DMG | 测试包完成 | DMG、包内启动、签名完整性和退出清理已验证 |
| macOS 正式签名/公证 | 待凭据 | 需要有效 Developer ID Application 和 notarization 凭据 |
| Windows x64 安装包 | 配置存在，未验收 | 保留 NSIS 配置，尚未完成运行时和实机发布验证 |

## 3. 桌面宿主落地

新增 `desktop/`：

```text
desktop/
├─ main.ts                     Electron 生命周期和安全窗口
├─ agent-host-supervisor.ts    Runtime 校验、ready/health、日志与进程树
├─ app-paths.ts                Electron 用户目录解析
├─ electron-builder.yml        macOS DMG / Windows NSIS 配置
├─ python-requirements.txt     官方 Python 运行依赖
├─ assets/                     图标与 macOS entitlement
└─ scripts/
   ├─ check-mac-release.mjs    正式签名/公证凭据前置检查
   ├─ prepare-runtime.mjs      Python 与 Runtime Manifest 准备
   └─ after-pack.cjs           测试构建 ad-hoc 签名和严格验证
```

启动链：

```text
Electron ready
→ 解析只读 Resources 与用户目录
→ 校验 runtime-manifest.json
→ ELECTRON_RUN_AS_NODE 启动 Agent Host
→ 等待 transportx-agent-host-ready
→ 检查 /api/health 和 protocolVersion
→ BrowserWindow 加载随机回环地址
```

退出时先向 Agent Host 发送正常终止信号；超过时限后按进程组强制清理，防止残留 Pi/Python 子进程。Agent Host 日志写入用户 `logs/`，并限制单文件体积。

## 4. 运行时落地

### Pi CLI

- 项目锁定 `@earendil-works/pi-coding-agent` 版本；
- 打包时记录 Pi 入口、版本与 SHA-256；
- 桌面模式缺少 Manifest 或哈希不匹配会停止启动；
- 开发模式才允许 `TAU_PI_COMMAND` / `TAU_PI_ENTRYPOINT` 覆盖。

### Python

- 构建输入必须是可重定位 Python 3.10 运行时；
- `prepare-runtime` 检查版本、CPU 架构、`ssl`、`sqlite3`、`yaml`、`numpy`、`matplotlib` 和复制后的路径边界；
- Python Runner 统一处理 cwd、UTF-8、超时、取消、输出限制和进程树；
- `PYTHONDONTWRITEBYTECODE` 与 `PYTHONPYCACHEPREFIX` 防止应用运行后修改 `.app` 签名资源；
- 不允许 Agent 在生产运行时在线安装 pip/npm 依赖。

### Runtime Manifest

Manifest v1 记录：

- 产品名称与版本；
- Agent Host 入口、协议版本与哈希；
- Pi CLI 入口、版本与哈希；
- Python 入口、版本与哈希。

Electron Supervisor 和 Agent Host Runtime Resolver 分别校验该清单，避免打包阶段和运行阶段使用不同路径。

## 5. 用户目录与模型

macOS 用户数据固定为：

```text
~/.transportx/traffic-agent/
├─ scenario/
├─ sessions/
├─ modules/
├─ settings/
├─ logs/
├─ cache/
├─ models.json
└─ auth.json
```

模型默认列表为空。用户可在“新建交通任务”、模型选择器或“设置”中点击“添加模型”，填写 Provider ID、Model ID、API 类型、Base URL 和 API Key。

模型定义写入 `models.json`，密钥单独写入 `auth.json`。两者使用原子替换并限制文件权限为 `0600`；API Key 不通过平台概览接口返回前端。新任务在没有明确模型时保持禁用状态。

## 6. Module 实施结果

### Manifest v1

支持以下类型：

- `module`：组合模块；
- `capability`：Task、Citation、Geo、Web Bridge 等代码能力；
- `domain`：领域 Prompt 与默认依赖组合；
- `skill`：Skill 和脚本；
- `knowledge`：知识索引与原件资产；
- `data`：数据库与数据说明；
- `template`：报告模板。

Manifest 显式声明平台版本、依赖、Pi Extension、Skill、Prompt、Artifact Type 和资产路径。系统不根据目录名猜测类型。

### 官方模块

```text
modules/
├─ capabilities/
│  ├─ task
│  ├─ citation
│  ├─ geo
│  └─ web-bridge
├─ official/
│  ├─ workbench               通用领域依赖与 Prompt
│  └─ traffic-report          通用报告 Template
└─ installable/
   ├─ shanghaidata            上海 Data Manifest + 查询 Skill
   ├─ traffic-assurance-knowledge
   │                          交通保障 Knowledge Manifest + 检索 Skill
   └─ plot-style              可选绘图经验与风格 Skill
```

Task、Citation、Geo 和 Web Bridge 的源码仍在 `extensions/`，Manifest 以显式入口引用；领域 Skill 归属各自 Module。大型 Data/Knowledge 实体不进入 Git 和安装包。

### 安装、卸载和安全检查

设置页允许安装完整 Module，也允许单独选择 Skill、Extension、Data 或 Knowledge。单独资源会生成 `local.<kind>.<name>` 受管 Module，并复制到用户 `modules/`。

安装器执行：

- Manifest Schema 和平台版本校验；
- 入口/资产相对路径校验；
- 包路径逃逸检查；
- 符号链接拒绝；
- 重复 ID 拒绝；
- `.git`、`.DS_Store`、`__MACOSX`、`__pycache__`、`.pyc` 过滤；
- 临时目录复制、校验后原子安装。

内置和外部只读 Module 不能通过设置页卸载；卸载用户 Module 不删除原始来源。

## 7. Data / Knowledge 解耦

旧结构中的：

```text
skills/shanghai-traffic-data-assets/
skills/search-traffic-assurance-knowledge/references/knowledge/
```

已移除。查询 Skill 分别迁移到用户安装模块 `modules/installable/shanghaidata/skill/` 和 `modules/installable/traffic-assurance-knowledge/skill/`，实体资产由各 Module 的 `contributes.assets` 声明。

Session Assembly 根据启用模块解析实际资产，并注入：

- `TRANSPORTX_TRAFFIC_DATA_ROOT`；
- `TRANSPORTX_KNOWLEDGE_ROOT`。

脚本缺少资产时明确失败，不再从 Skill 相邻目录或开发机绝对路径寻找数据。这使 Skill 可以独立升级，Data/Knowledge 可以单独安装、替换和卸载。

Session Assembly 对同类资产采用“用户安装 > 外部加载 > 内置”的选择顺序；同一优先级出现多个候选时要求用 `TAU_DATA_ASSET_ID` 或 `TAU_KNOWLEDGE_ASSET_ID` 明确选择。设置页标记当前生效资产。Knowledge 的 `SHA256SUMS.txt` 在安装和运行时都会校验，旧包中的 `knowledge/` 清单前缀会在独立安装时规范化。

macOS 安装包把 Data/Knowledge 查询 Skill 和通用 Skill 解包到 `app.asar.unpacked`。凡需交给 Python 或其他外部进程的路径，Session Assembly 与 Citation/Geo Extension 均解析为真实文件系统路径，不把 `app.asar` 虚拟路径传给子进程。

## 8. Session Assembly

创建会话时，平台组合：

```text
Domain Module
+ Capability Modules
+ Skill Modules
+ Knowledge / Data / Template Assets
+ Pi / Python Runtime
+ Model
+ Workspace
= ResolvedSessionPlan
```

计划记录 Platform、Pi、Python、Module、Extension、Skill、Prompt 和资产版本/路径，再传给 SessionManager 启动 Pi。历史 Session 因而可以说明当时使用的实际组合，而不是依赖当前全局配置推断。

## 9. 前端改造

React Workspace 保持唯一 UI，并新增必要的产品入口：

- 产品名称和 PWA Manifest 更新为 TransportX Traffic Agent；
- 新建任务强制显式选择模型；
- 模型选择器和设置页增加“添加模型”；
- 设置页展示当前 Extension、Skill、Data、Knowledge、Template 和 Module 错误；
- 支持安装/卸载 Module 或单独资源；
- 展示用户数据根目录、场景目录和模块目录；
- 桌面 PDF 导出改由 Electron 安全桥完成。

本轮没有新增第二套 Desktop UI，也没有把业务通信迁移到 Electron IPC。

## 10. 目录清理

已清理：

- 旧 launchd daemon；
- 字体测试脚本和图片；
- 旧 PWA 图标；
- Skill 内嵌的 Data/Knowledge 实体与索引；
- 构建缓存、Python 字节码和安装包中间目录；
- 开发机绝对 Python/数据路径回退。

历史任务工作区迁移到用户 `scenario/` 后不再存放于仓库。`bin/`、`dist/`、`dist-desktop/`、`public/geo-runtime.*`、`desktop/build/` 和 `release/` 均为生成物，不提交 Git。

## 11. macOS 分发问题与修复

初始测试 DMG 在其他 Mac 上出现“应用已损坏”或“因为出现问题而无法打开”。对方设备为 `arm64`、macOS 15.7.3，因此排除了 CPU 和最低系统版本问题。根因包括：

1. Electron 链接签名与应用 ad-hoc 签名组合无效；
2. 带 hardened runtime 参数的 ad-hoc 签名造成 Framework Team ID 不一致；
3. 首次 Python 探测在 `.app` 内生成/修改 `__pycache__`，破坏 sealed resources。

修复后，测试构建在 DMG 生成前重新应用最小 ad-hoc 签名并执行 `codesign --verify --deep --strict`；Python 探测使用 `-B`，运行环境禁止写字节码。最终 Apple Silicon DMG 已完成：

- `hdiutil verify`；
- 启动前严格签名验证；
- 完整桌面冒烟；
- 启动后严格签名验证；
- 只读 DMG 内完整启动；
- DMG SHA-256 校验。

ad-hoc 签名只解决包体结构完整性，不替代 Apple Developer ID。正式外发仍必须使用 Developer ID Application、notarization 和 stapling；否则 Gatekeeper 可能继续阻止下载来源的应用。

## 12. 验证结果

- `npm run typecheck`：通过；
- `npm test`：30 项必要回归全部通过，0 项失败；
- `npm run test:react-smoke`：通过；
- `npm run test:desktop-smoke`：开发模式通过；
- 真实 `.app` 和只读 DMG 桌面冒烟：通过；
- 应用完整启动前后严格代码签名：通过；
- DMG 镜像和 SHA-256：通过。

## 13. 当前发布边界

当前可以交付受信任测试用户的 macOS Apple Silicon DMG。正式公开发布前仍需：

1. 配置有效的 Developer ID Application 证书；
2. 配置 Apple notarization 凭据；
3. 生成正式签名 DMG 并 stapling；
4. 在至少一台非开发 Mac 上以下载隔离属性完成安装、升级、首次启动和卸载验证；
5. 单独完成 Windows x64 Runtime、NSIS 和 Authenticode 验收。

Intel Mac、在线模块市场、第三方 UI Bundle、远程 Agent、SSH/WSL、自动在线安装依赖和操作系统级 Module 沙箱不属于 3.0 已实现范围。
