# Pi Traffic Workspace 桌面化与模块化实施规格

- 文档状态：**开发基线 / Final Draft**
- 版本：v1.1
- 更新时间：2026-08-08
- 当前基础：Pi CLI、Node Agent 服务、React Workspace、Browser Kernel、Pi Extension、项目级 Skill
- 正式技术路线：**Electron + Node Agent Host + 现有 React Workspace**
- 实施阶段：
  1. 第一阶段：桌面化
  2. 第二阶段：模块化

---

## 1. 最终决策

本项目采用 Electron 作为桌面宿主。现有 Node 服务演化为本地 Agent Host，现有 React Workspace 保持当前界面和交互，不在本次改造中进行工作台重设计、视觉体系调整或前端功能重构。Pi CLI 与 Python 作为受管理运行时随桌面应用发布。

本次改造只分为两个阶段：

1. **桌面化**：把当前项目变成可安装、可启动、可退出、可发布的本地桌面应用。
2. **模块化**：把现有 Task、Citation、Geo、交通 Skill、知识和数据从固定目录与硬编码装配中迁出。

总体原则：

- 先完成可使用的桌面产品，再进行模块化迁移。
- Electron Main 只负责桌面生命周期和 Agent Host 进程治理。
- Agent Host 是唯一业务核心，继续管理 Session、Pi、Python、文件、Citation 和 Geo。
- React Workspace 继续使用现有实现，不增加新的桌面工作台、Desktop Bridge、Browser Mock 或诊断页面。
- 第一阶段保留现有 HTTP/WebSocket 通信，不迁移到 Electron IPC。
- 第二阶段只模块化当前真实存在的能力，不建设通用插件市场和第三方运行时平台。
- Node、Pi CLI 和基础 Python 内置；知识与大型数据继续外置。

## 2. 目标与边界

当前项目已经能够完成交通分析任务，但仍以开发项目形态运行：依赖开发机环境和绝对路径，需要命令行启动，缺少统一安装、进程清理和跨平台发布方式，领域能力与平台装配也存在耦合。

本次改造后的目标是：用户安装桌面应用后，无需另外安装 Node、Pi CLI 或 Python，即可继续使用现有 React Workspace 完成交通分析任务。

本次范围包括：

- Electron 安装、启动、退出和发布；
- Agent Host 的桌面启动模式与进程治理；
- Pi CLI 和 Python 的内置与路径解析；
- 工作目录、用户数据目录和应用资源目录治理；
- 现有 Session、Task、File、Citation、Geo 和 Skill 能力保持可用；
- 第二阶段的模块清单、注册、资产解析和会话装配；
- 现有交通能力、知识和数据的模块化迁移。

本次明确不做：

- React 工作台布局、视觉风格和交互重构；
- 新的桌面工作台 UI、状态栏、命令面板或诊断页；
- Browser Mock 和新的前端状态架构；
- 将现有 Agent RPC 全量迁移到 Electron IPC；
- 第三方插件市场和任意 JavaScript UI Bundle；
- 完整模块权限系统或操作系统级沙箱；
- Agent 自动在线安装 Python/npm 依赖；
- SSH、WSL、多机 Agent 和远程执行；
- Git、终端、Worktree 等编码产品能力；
- 第二种 Agent Runtime 抽象。

## 3. 总体架构

```text
Pi Traffic Workspace Desktop
│
├─ Electron Main
│  ├─ 应用与窗口生命周期
│  ├─ 单实例
│  ├─ 应用资源和用户目录解析
│  ├─ Agent Host 启动、监控和退出
│  └─ 安装、签名和更新基础
│
├─ Agent Host（Node）
│  ├─ 现有 Server Composition Root
│  ├─ HTTP / WebSocket
│  ├─ Session / Task / File
│  ├─ Citation / Geo
│  ├─ Pi Process Manager
│  ├─ Python Runner
│  └─ Module Registry / Asset Resolver [第二阶段]
│
├─ Pi CLI Process
├─ Python Process
│
└─ React Workspace
   └─ 保持现有界面、Browser Kernel 和业务功能
```

Electron 启动 Agent Host 后，Agent Host 绑定随机回环端口并继续提供现有网页和 WebSocket。Electron BrowserWindow 直接加载 Agent Host 提供的 React 页面，因此现有前端仍然从当前页面地址推导 API 和 WebSocket 地址，不需要为桌面模式新建一套前端通信层。

Electron Renderer 保持安全默认值：

- `nodeIntegration: false`；
- `contextIsolation: true`；
- `sandbox: true`；
- 不向页面暴露完整 `ipcRenderer` 或 Node API；
- 当前阶段不需要的桌面系统能力不进入 Preload。

## 4. 现有代码的演化位置

| 当前实现 | 桌面化后的职责 | 主要调整 |
|---|---|---|
| `src/server/server-main.ts` | Agent Host 入口 | 支持桌面启动参数、随机回环端口、就绪通知和优雅退出 |
| `src/server/sessions.ts` | Pi 会话与进程管理 | 注入内置 Pi 路径，增加启动超时、取消和进程树清理 |
| `src/web/` | 生产界面 | 保持现有 UI 与功能，不进行重构 |
| `src/public/kernel/` | 浏览器连接和状态投影 | 继续处理现有 HTTP/WebSocket 协议 |
| `src/contracts/` | 跨边界公共契约 | 继续作为 Agent Host、Extension、Kernel 和 React 的权威协议 |
| `extensions/`、`skills/` | 第一阶段内置能力；第二阶段模块来源 | 第一阶段只修复打包路径，第二阶段纳入 Registry |

桌面化不复制 Session、File、Citation 或 Geo 服务，也不把这些逻辑搬到 Electron Main。

---

# 第一阶段：桌面化

## 5. 第一阶段目标

第一阶段完成后，项目应成为一个可安装的桌面应用：用户无需自行安装 Node、Pi CLI 或 Python，可以通过现有 React Workspace 创建和恢复会话、执行交通分析、调用 Python、查看 Citation、Geo 和任务产物，并在退出应用时正确清理所有子进程。

这一阶段只建立桌面运行边界，不进行模块系统重构。

## 6. Electron 桌面宿主

建议新增最小桌面目录：

```text
desktop/
├─ main.ts
├─ agent-host-supervisor.ts
├─ app-paths.ts
├─ build/
│  ├─ icons/
│  └─ entitlements.*
└─ electron-builder.yml
```

Electron Main 负责：

- 创建和关闭 BrowserWindow；
- 保证应用单实例；
- 解析 `resources` 和 `userData` 路径；
- 启动、监控和终止 Agent Host；
- Agent Host 启动失败时停止加载主页面并记录明确错误；
- 配置安装包、签名、公证和更新基础。

Electron Main 不负责 Agent 业务，不直接管理 Session、Task、Pi RPC、Python 任务、Citation 或 Geo。

## 7. Agent Host 启动与生命周期

推荐启动流程：

```text
Electron app ready
→ 解析应用资源和用户数据目录
→ 读取 runtime-manifest.json
→ 校验 Agent Host、Pi CLI 和 Python 文件
→ 启动 Agent Host
→ Agent Host 绑定 127.0.0.1:0
→ Agent Host 向父进程回报 ready、port、protocolVersion
→ Electron 检查 /health
→ BrowserWindow 加载 Agent Host 页面
```

Agent Host 应支持：

- 确定的 ready/exit 协议；
- 有界启动超时；
- 只监听 `127.0.0.1`；
- 父进程退出后的自我终止；
- 正常关闭与超时强制终止；
- Agent Host → Pi/Python 的完整进程树清理；
- stdout/stderr 有界日志；
- 启动失败和异常退出的本地日志记录。

Electron 可以优先使用自身携带的 Node Runtime 启动编译后的 Agent Host。第一周应验证生产依赖和原生模块的 Node ABI；如果不兼容，再改为随应用分发独立 Node，不同时维护两条正式路径。

## 8. 内置运行时

### 8.1 Pi CLI

正式产品默认使用固定版本的内置 Pi CLI：

- Agent Host 从应用资源目录解析实际路径；
- 会话启动时继续传入现有 Extension、Skill 和 Prompt；
- stdout 与 stderr 按 Session 记录；
- Session Cancel、Close 和 App Quit 都能终止 Pi 进程；
- 不依赖用户全局 Pi CLI。

### 8.2 Python

第一阶段只维护一个官方基础 Python 环境，包含当前交通任务真实使用的依赖。Skill 不再写开发机绝对解释器路径，而由统一 Python Runner 选择内置解释器。

Python Runner 统一负责：

- 解释器路径；
- 工作目录和环境变量；
- UTF-8 输出；
- 超时与取消；
- stdout/stderr 日志；
- 子进程清理。

第一阶段不允许 Agent 自动在线安装依赖。新增依赖随产品版本更新。

### 8.3 Runtime Manifest

构建产物生成运行时清单，至少记录应用、Electron、Agent Host 协议、Pi CLI 和 Python 的版本、相对路径与校验和。第一阶段把应用、Agent Host、Pi CLI、Python 和内置交通能力作为一个兼容版本发布。

## 9. 目录和数据治理

```text
Application Resources/          应用只读
├─ agent-host/
├─ runtimes/
│  ├─ pi/
│  └─ python/
├─ builtin-extensions/
├─ builtin-skills/
├─ prompts/
└─ runtime-manifest.json

Application Support/PiTau/      用户可写，升级保留
├─ settings/
├─ logs/
├─ sessions/
└─ cache/

User Workspace/                 用户选择的任务目录
└─ inputs / scripts / outputs

User-selected Data Root/        可选大型数据位置
└─ traffic-data/
```

约束：

- 正式代码不包含开发机绝对路径；
- 应用升级不覆盖 Session、设置和交通数据；
- 大型知识和交通数据不进入安装包；
- File API 阻止 `..` 路径穿越和符号链接越出工作目录；
- Python 默认工作目录与当前任务工作目录一致；
- 缓存可以清理，原始数据和历史任务不可被自动删除。

## 10. 第一阶段开发任务

第一阶段只保留四个开发任务：

1. **桌面宿主**：建立 Electron Main、BrowserWindow、单实例和构建配置。
2. **Agent Host 桌面模式**：完成随机端口、ready/health、父子进程和退出协议。
3. **运行时与路径治理**：内置 Pi CLI/Python，增加 Runtime Resolver、Python Runner 和目录迁移。
4. **打包与验收**：构建 macOS Apple Silicon 和 Windows x64 安装包，验证安装、升级、退出和现有交通黄金任务。

不为每个文件和小功能拆分独立架构任务，具体实现可以在阶段内部按开发需要形成 Issue。

## 11. 第一阶段验收标准

- [ ] macOS Apple Silicon 与 Windows x64 可以通过安装包安装和启动；
- [ ] 用户无需自行安装 Node、Pi CLI 或 Python；
- [ ] Electron 可以稳定启动和关闭 Agent Host；
- [ ] 正式运行不依赖开发机绝对路径；
- [ ] 现有 React Workspace 无需重构即可正常使用；
- [ ] Pi 会话可以创建、流式输出、取消、关闭和恢复历史；
- [ ] Python Skill 通过内置 Python 执行；
- [ ] File、Task、Citation 和 Geo 主流程保持正常；
- [ ] 至少一个真实交通任务从输入执行到产物；
- [ ] App 退出后没有 Agent Host、Pi 或 Python 孤儿进程；
- [ ] 覆盖升级后 Session、设置和外置数据不丢失；
- [ ] `npm test`、打包冒烟测试和目标平台实机测试通过。

只有第一阶段通过上述验收后，才进入第二阶段。

---

# 第二阶段：模块化

## 12. 第二阶段目标

第二阶段不建设开放插件平台，只把当前真实存在的 Task、Citation、Geo、交通 Prompt、Skill、Knowledge、Data 和 Template 从固定目录和主程序硬编码中迁出，形成可发现、可版本化、可按会话组合的官方模块与资产。

Platform Core 继续保留 Session、Conversation、Model、Task 基础状态、File Workspace、Artifact、Runtime Resolver、设置和进程生命周期；交通指标口径、上海固定路径、交通 Prompt、交通知识目录、数据表路径和报告模板迁入领域包或资产包。

## 13. 包类型与 Manifest

第二阶段只定义当前需要的六类包：

| 类型 | 内容 | 示例 |
|---|---|---|
| Capability Module | 通用代码能力和现有 UI 贡献 | Task、Citation、Geo |
| Domain Pack | Prompt、任务模板和默认组合 | Traffic Assurance |
| Skill Pack | `SKILL.md`、脚本和 References | traffic-data-query |
| Knowledge Pack | 原件、目录、引用映射和索引 | 交通法规知识 |
| Data Pack | SQLite、GeoJSON、字段和质量信息 | 上海交通数据 |
| Template Pack | 报告和导出模板 | 交通分析报告 |

所有包使用显式 `manifest.json`，不通过任意目录扫描猜测包类型。Manifest v1 至少包含：

```json
{
  "manifestVersion": 1,
  "id": "com.pi-tau.geo",
  "name": "Geo Visualization",
  "version": "1.0.0",
  "type": "capability",
  "platformVersion": ">=3.0.0 <4.0.0",
  "dependencies": [],
  "entrypoints": {
    "piExtensions": ["extensions/pi-geo-visualization/index.js"],
    "skills": ["skills/geo-visualization/SKILL.md"]
  },
  "contributes": {
    "artifactTypes": ["geo.scene"]
  }
}
```

本阶段只支持内置官方包和本地导入的官方/开发包，不设计第三方权限审批、在线市场和任意 UI Bundle。

## 14. Module Registry、Asset Resolver 与 Session Assembly

模块化只增加三个核心组件。

### Module Registry

负责读取明确安装目录中的 Manifest，校验 Schema 和版本，解析依赖，记录启用状态、兼容性和加载错误。单个可选模块损坏不能阻止平台启动。

### Asset Resolver

Skill 和 Module 通过逻辑 ID 获取知识或数据，不再读取机器绝对路径。Data Pack 和 Knowledge Pack 使用不可变版本目录；安装新版本时先校验 Manifest、文件哈希和 Schema，再注册新目录，不原地覆盖活动版本。

### Session Assembly

创建会话前，根据 Domain Pack、启用模块、Skill、Knowledge、Data、Template、Runtime 和 Workspace 形成确定的 `ResolvedSessionPlan`，再启动 Pi Session。计划保存到 Session Metadata，用于说明历史任务实际使用的版本和资产。

```text
Domain Pack
+ Capability / Skill
+ Knowledge / Data / Template
+ Runtime / Workspace
        │
        ▼
Resolved Session Plan
        │
        ▼
Pi Session Launch
```

## 15. 模块化迁移方式

迁移按现有能力推进，不先开发完整插件 SDK：

1. 建立 Manifest v1、Module Registry 和包状态记录。
2. 迁移 Task、Citation 和 Geo，验证模块注册、Artifact 与现有 Renderer 契约。
3. 迁移 Traffic Domain、Skill、Knowledge、Data 和 Template，并用 Asset Resolver 替换绝对路径。
4. 引入 Session Assembly，清除 Platform Core 中的交通专用路径和硬编码装配，并用一个最小第二领域验证无需复制 Core。

现有官方前端组件继续共同构建。模块只通过已有公开契约贡献 Artifact 和 Workspace 内容，不在第二阶段加载外部 JavaScript UI。

## 16. 第二阶段验收标准

- [ ] Platform Core 不再包含上海固定数据路径和交通 Prompt/Template；
- [ ] Task、Citation 和 Geo 通过 Manifest 与 Module Registry 装配；
- [ ] Traffic Domain Pack 可以声明需要的能力、Skill、Knowledge 和 Data；
- [ ] Skill 不包含机器绝对 Python 或数据路径；
- [ ] Knowledge Pack 和 Data Pack 具有独立版本和校验信息；
- [ ] Asset Resolver 可以按逻辑 ID 返回会话所需资产；
- [ ] 每个 Session 保存 Resolved Session Plan；
- [ ] 单个可选模块失败不阻止平台启动；
- [ ] 历史任务可以说明 App、Pi、Module、Data 和 Knowledge 版本；
- [ ] 最小第二领域不需要复制 Session、File、Agent Host 或 React Shell。

---

## 17. 契约、日志与测试

`src/contracts/` 继续作为 Agent Host、Extension、Browser Kernel、React 和 Module 之间的唯一权威协议。Contract 不依赖 React、Electron、MapLibre 或 Server 内部 Store，React 不解析原始 Pi RPC，Electron Main 不导入 Agent Host 业务对象。

关键错误使用稳定错误码，例如运行时缺失、Host 启动超时、Session 启动失败、工作目录非法、资产缺失和模块不兼容。详细异常进入本地日志，API Key、Token 和用户文件内容不进入普通日志。

测试保持现有分层，不为桌面化重建前端测试体系：

- 现有 TypeScript、Contract 和单元测试；
- Agent Host 的 Pi/Python 启动、取消、超时和进程清理测试；
- 安装、升级、非 ASCII 路径、带空格路径和退出无孤儿进程的打包冒烟测试；
- 数据查询、知识 Citation、数据 + Geo + 报告三类交通黄金任务；
- 第二阶段增加 Manifest、Registry、Asset Resolver 和 Session Assembly 测试。

## 18. 主要风险

### Python 跨平台分发

这是第一阶段最高风险。应最先验证 macOS ARM64、Windows x64、Shapely/pyproj 等原生依赖、相对路径、包体积和安装后的执行权限。

### Electron 与 Node 兼容

应尽早用真实安装包验证 Electron 自带 Node 与生产依赖的 ABI。出现不可接受的原生模块问题时，再切换为独立 bundled Node。

### 进程清理

App → Agent Host → Pi/Python 是进程树。每层都应支持 graceful shutdown，超时后强制结束，并在 macOS 与 Windows 实机验证无孤儿进程。

### 模块化过度设计

第二阶段只支持官方模块，只迁移当前已有能力。每迁移一个真实模块再调整 Manifest 和 Module API，不先建设 Sidecar SDK、插件市场或通用权限平台。

## 19. 版本与发布原则

第一阶段中，Electron、Agent Host、Pi CLI、Python 和内置 Extension/Skill 作为一个原子兼容版本发布。大型知识和数据独立存储，不随应用重复分发。

第二阶段分别记录 Platform、Capability、Domain、Skill、Knowledge、Data 和 Template 版本，但 Pi CLI 与基础 Python 仍优先跟随 Platform 发布。历史 Session 保存当时的运行时、模块和资产版本，保证专业任务可追溯。

第一阶段目标平台为 macOS Apple Silicon 和 Windows x64。外部分发需要 macOS Developer ID 与 notarization、Windows Authenticode，以及安装、覆盖升级、卸载、用户数据保留和孤儿进程测试。

## 20. 参考实现的使用原则

本项目借鉴而不复制参考项目：

- DeepSeek Reasonix：一个 Agent Core 支持多客户端、稳定契约和模块化边界；不采用 Wails/Go、编码 Agent 工作台和完整插件生态。
- T3 Code：Electron 管理独立 Agent Host、本机通信、ready/health/exit 和进程治理；不采用远程 SSH/WSL、多 Backend Pool 和复杂远程认证。

参考资料：

- [DeepSeek Reasonix](https://github.com/esengine/DeepSeek-Reasonix)
- [T3 Code architecture overview](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)
- [T3 Code connection runtime](https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md)

## 21. 最终交付

第一阶段交付的是可安装、可直接使用现有交通分析能力的 Pi Traffic Workspace Desktop。第二阶段交付的是完成现有能力迁移的模块化 Pi Agent Platform。

整个改造过程只保留两个阶段，不增加独立的前端重构阶段、诊断阶段或插件生态阶段：

```text
当前项目
   │
   ▼
第一阶段：桌面化
Electron + Agent Host + 内置 Pi/Python + 现有 React
   │
   ▼
第二阶段：模块化
Registry + Asset Resolver + Session Assembly + 官方模块/资产
```
