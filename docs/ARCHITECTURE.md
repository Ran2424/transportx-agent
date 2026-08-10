# TransportX Traffic Agent 架构与目录治理

- 产品版本：3.0.3
- 架构状态：已实现基线
- 更新时间：2026-08-09
- 当前正式目标：macOS 12+ Apple Silicon；Windows x64 保留构建配置，尚待实机发布验收

TransportX Traffic Agent 是一个本地优先的交通分析 Agent 桌面产品。项目保持单仓库、单 npm 包和模块化单体，不拆分远程微服务，也不维护第二套 Web UI。Electron 管理桌面生命周期，Node Agent Host 是唯一业务服务，Pi 负责 Agent 推理和工具调用，Python 执行交通数据脚本，React Workspace 负责全部用户交互。

## 1. 系统全景

```text
TransportX Traffic Agent.app
│
├─ Electron Main
│  ├─ 单实例、窗口与退出生命周期
│  ├─ Agent Host 启动、健康检查和进程树清理
│  ├─ 外部链接隔离
│  └─ 隔离的 HTML → PDF 桥接
│
├─ Agent Host（Node）
│  ├─ HTTP / WebSocket / 同源认证
│  ├─ Session、File、Citation、Geo、Report
│  ├─ Model 配置
│  ├─ Module Registry / Installer / Asset Resolver
│  ├─ Session Assembly
│  └─ Pi / Python 进程管理
│
├─ Pi CLI Process
│  ├─ Task / Citation / Geo / Web Bridge Extensions
│  ├─ Skills 与 Session Prompt
│  └─ 模型供应商连接
│
├─ Python 3.10 Process
│  └─ 数据查询、分析和制图脚本
│
└─ React Workspace
   ├─ Browser Application Kernel
   ├─ Conversation / Session / Model / Settings / File
   └─ Task / Citation / Geo 功能界面
```

Electron 启动 Agent Host 后，Agent Host 监听随机 `127.0.0.1` 端口并输出版本化 ready 消息。Electron 校验 `/api/health` 后才加载页面。React 继续通过 HTTP 和 WebSocket 与同一个 Agent Host 通信，不复制业务逻辑到 Electron IPC。

## 2. 组件职责

### 2.1 Electron Main

`desktop/main.ts` 和 `desktop/agent-host-supervisor.ts` 只负责桌面边界：

- 保证应用单实例；
- 创建安全 BrowserWindow；
- 解析应用资源目录和用户目录；
- 校验 Runtime Manifest；
- 启动 Agent Host、等待 ready、检查 health；
- 保存有界日志并在退出时清理完整进程树；
- 使用禁用 JavaScript、阻断网络的隐藏窗口生成 PDF；
- 把外部 HTTP/HTTPS 链接交给系统浏览器。

Electron Main 不管理 Session、Task、Citation、Geo、模型或模块业务。Renderer 使用 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`，当前不暴露通用 Preload API。

### 2.2 Agent Host

`src/server/server-main.ts` 是业务组合入口，只装配依赖、认证、RPC 和生命周期。具体 HTTP 行为由 route/handler 负责：

- Session：Pi RPC 子进程、实时状态、历史恢复和分支投影；
- File：会话工作区文件、预览和本机打开；
- Citation：原件注册、会话隔离、摘要校验和只读访问；
- Geo：受会话约束的 GeoJSON 资源；
- Report：桌面模式调用 Electron PDF 桥，Web 模式使用受控后端；
- Platform：模型、模块、路径和运行时状态；
- WebSocket：同源升级、连接、心跳与命令端口。

Agent Host 是 Electron、命令行 Web 启动方式共用的唯一业务核心。

### 2.3 Pi 与 Python

桌面安装包固定使用内置 Pi CLI 和可重定位 Python 3.10，不回退到目标机器的全局命令。开发模式可以用受控环境变量覆盖运行时。

Pi 以 RPC 模式启动，每个 Session 注入本次解析出的 Extension、Skill、Prompt、模型和资产根目录。Python 统一通过 `PythonRunner` 执行，负责工作目录、UTF-8、超时、取消和进程清理。Python 缓存定向到用户缓存目录，并禁止在只读 `.app` 中生成字节码。

### 2.4 React Workspace 与 Browser Kernel

React 是唯一生产 UI。`src/public/kernel/` 负责传输事件标准化、命令端口和可重放状态；`src/web/` 负责 React 组合和展示。React 组件不直接解析原始 Pi RPC 消息，也不直接读取本机文件。

## 3. 权威契约和事实来源

| 信息 | 唯一权威 | 消费者 |
|---|---|---|
| Session、Task、Geo、Citation、Module 协议 | `src/contracts/` | Extension、Server、Kernel、React |
| 历史对话 | Pi Session JSONL | Session Projection、React Snapshot |
| 实时对话 | Agent Host live overlay | WebSocket 客户端；刷新后回归 Snapshot |
| 模型定义 | `models.json` | Pi、模型选择器、设置页 |
| 模型密钥 | `auth.json` | Pi；服务端不把密钥返回前端 |
| 模块声明 | `manifest.json` | Module Registry、Installer、Session Assembly |
| 桌面运行时 | `runtime-manifest.json` | Electron Supervisor、Runtime Resolver |
| 会话实际装配 | `ResolvedSessionPlan` | Session 启动、恢复和审计 |

`src/contracts/` 不依赖 Node、Electron、React、DOM 或 MapLibre。跨进程或跨层新增字段时，先更新契约和解析测试，再实现适配器。

## 4. 会话启动与装配

```text
用户选择模型和领域模块
        │
        ▼
Module Registry 解析依赖与启用状态
        │
        ▼
Asset Resolver 解析 Skill / Extension / Data / Knowledge / Template
        │
        ▼
Session Assembly 生成 ResolvedSessionPlan
        │
        ├─ Pi CLI + model
        ├─ Pi Extensions
        ├─ Skills + Prompt
        ├─ Knowledge/Data 环境变量
        └─ Workspace cwd
        ▼
Pi RPC Session
```

每个新任务必须显式选择模型。默认任务根目录是 `~/.transportx/traffic-agent/scenario/`，每个任务使用独立子目录。创建和恢复时都保存确定的装配计划，避免后续模块升级改变历史任务的解释。

Pi JSONL 是历史事实来源。服务端通过 `SessionProjection` 选择最后叶节点所属分支；浏览器只维护降低延迟的实时 overlay，重连或刷新后由服务端 Snapshot 重新校正。

## 5. Module 模型

### 5.1 Module 是统一生命周期单元

Module 可以组合贡献：

- Skill：行为、分析口径、查询说明和脚本；
- Extension：Pi 侧工具与结构化状态桥；
- Data：数据库、GeoJSON、字段和质量信息；
- Knowledge：法规、预案、项目资料、索引与引用映射；
- Template：报告和导出模板。

Skill、Extension、Data、Knowledge 也可以单独安装。安装器会把单独资源包装为只有一个贡献项的受管 Module，因此发现、版本校验、装配和卸载始终只有一套逻辑。

### 5.2 Manifest 与来源

Manifest v1 支持 `module`、`capability`、`domain`、`skill`、`knowledge`、`data`、`template` 类型，声明平台版本、依赖、Pi 入口和资产。Registry 区分三种来源：

- `builtin`：仓库随应用发布的官方模块；
- `installed`：复制到用户 `modules/` 目录的受管模块；
- `external`：开发或受控部署显式传入的只读 Manifest。

Registry 拒绝重复 ID 和不兼容平台版本，按依赖顺序装配；缺失依赖会禁用相关模块，但单个可选模块损坏不阻止平台启动。

平台与用户模块按“机制”和“内容”分层：

| 层级 | 模块 | 职责 |
|---|---|---|
| 平台内置 | Workbench、Task、Geo、Citation、Web Bridge | 会话装配、任务状态、地图呈现、可信引用和前后端桥接等通用机制 |
| 平台内置 | Geo 操作说明、通用交通报告模板 | 使用内置机制所需的通用说明与基础输出结构，不包含城市或项目数据 |
| 用户安装 | `shanghaidata` | 上海数据、数据字典、查询脚本、数据口径和上海专属地图表达约定 |
| 用户安装 | `traffic-assurance-knowledge` | 交通保障法规、标准、预案、案例知识及检索流程 |
| 用户安装 | `plot-style` | 图表选型、审美经验、参考参数和 matplotlib 风格模板 |

内置 Workbench 不依赖任何用户模块。删除全部用户模块后，任务、会话、文件、Geo 和 Citation 等平台能力仍应正常启动；城市、项目、案例、知识库和风格模板不得写入内置依赖图。

### 5.3 Data / Knowledge 与 Skill 解耦

Data 和 Knowledge 不再存放于 Skill 相邻目录。Skill 只包含行为与查询工具，不拥有资产路径。Asset Resolver 从 Module Manifest 解析资产，并在 Session 启动时注入：

- `TRANSPORTX_TRAFFIC_DATA_ROOT`；
- `TRANSPORTX_KNOWLEDGE_ROOT`。

查询脚本不得回退到开发机绝对路径或 Skill 相邻目录。Knowledge/Data 的实体资产不进入 Git 仓库和应用安装包，由用户单独安装或迁移。

若同类资产同时存在，Session Assembly 优先选择用户安装资产，其次是外部资产，最后是内置资产；同一优先级存在多个候选时停止创建任务，并要求通过 `TAU_DATA_ASSET_ID` 或 `TAU_KNOWLEDGE_ASSET_ID` 明确选择。设置页显示当前生效资产。带 `integrityFile` 的资产在安装及每次解析时执行 SHA-256 校验，内容不一致会被拒绝。

## 6. 目录治理

### 6.1 仓库目录

```text
desktop/                       Electron、Supervisor、打包配置和运行时准备脚本
extensions/                    官方 Pi Extension 源码
modules/
  capabilities/               Task、Citation、Geo、Web Bridge
  official/                   Workbench 与通用 Template
  installable/                独立交付、不随应用打包的用户模块源码
prompts/                       会话 Prompt 源文件
skills/                        不属于领域 Module 的通用 Skill
src/
  contracts/                  跨层纯协议
  server/                     Agent Host 和本地平台服务
  public/                     Browser Kernel、Markdown、Geo runtime 源码
  web/                        React Workspace
test/                          Contract、Server、Module、Desktop 回归测试
dist/、dist-desktop/、bin/     本地构建产物，不提交
release/                       本地安装包交付目录，不提交
```

### 6.2 安装包只读资源

```text
TransportX Traffic Agent.app/Contents/Resources/
├─ app.asar                    Agent Host、Pi CLI、React 和平台内置模块
├─ app.asar.unpacked/          需要由 Python/外部进程直接读取的 Skill 与脚本
├─ runtime-manifest.json       产品、Agent Host、Pi、Python 版本和 SHA-256
└─ runtimes/python/            可重定位 Python 3.10
```

安装后不得修改 `.app` 内容。日志、模型、Session、Module、Python/Matplotlib 缓存和任务产物全部写入用户目录。

`modules/installable/` 在 Electron 打包时被显式排除。需要交付其中的模块时，应把对应目录连同实际资产作为独立安装包发布，不能借由应用资源目录自动注册。

### 6.3 macOS 用户目录

```text
~/.transportx/traffic-agent/
├─ scenario/                   新任务工作区
├─ sessions/                   Pi Session JSONL
├─ modules/                    用户安装的受管 Module
├─ settings/                   平台设置
├─ logs/                       Agent Host 等本地日志
├─ cache/                      Python、Matplotlib 等可清理缓存
├─ models.json                 Pi 模型定义
└─ auth.json                   Pi 密钥，权限 0600
```

`TAU_USER_DATA_DIR` 只用于开发和受控部署覆盖。应用升级不得覆盖用户目录；卸载单个 Module 只删除 `modules/<module-id>/` 中的受管副本。

## 7. 安全边界

1. Agent Host 只监听随机回环端口，不对局域网开放。
2. HTTP/WebSocket 使用同源检查和本地认证，跨源升级被拒绝。
3. Renderer 禁用 Node 集成并启用上下文隔离和沙箱。
4. File、Preview、Citation 和 Geo 都以 active Session cwd 为路径边界，拒绝路径穿越、符号链接越界和跨会话读取。
5. Module 安装拒绝符号链接、绝对入口、包路径逃逸、重复 ID 和缺失入口；复制时过滤 `.git`、缓存和 macOS 垃圾文件。
6. API Key 与模型定义分离，写入采用临时文件原子替换，密钥文件限制为当前用户读写。
7. Runtime Manifest 在桌面启动前校验 Agent Host、Pi CLI 和 Python 的路径与 SHA-256。
8. PDF 隐藏窗口禁用 JavaScript，并取消非 `about:`/`data:` 请求，避免报告 HTML 获得桌面权限。

这些约束提供应用级边界，但 Module 仍是本机受信任代码/数据包，不等同于操作系统级第三方插件沙箱。

## 8. macOS 打包与分发

当前构建基线：Electron 43.3.0、Pi 0.80.10、Python 3.10.x、macOS 12+ Apple Silicon。构建顺序为：

```text
check-mac-release
→ TypeScript / React / Desktop build
→ prepare-runtime（版本、架构、依赖、可重定位性、哈希）
→ electron-builder
→ 签名 / DMG / 公证
```

正式外发必须使用 `Developer ID Application` 签名、Apple notarization 和 stapling。发布前置检查在缺少证书或公证凭据时停止。`TRANSPORTX_ALLOW_UNSIGNED_BUILD=1` 仅用于受信任测试；测试构建会应用并严格验证 ad-hoc 签名，但 Gatekeeper 不会把它视为正式发行版。

首次运行回归必须同时验证：DMG 校验、运行前严格签名、应用完整启动、运行后严格签名、只读 DMG 内启动和退出后无孤儿进程。

## 9. 依赖方向

```text
Electron Main ───────────────> Desktop Supervisor（不得依赖 Agent 业务对象）
Extension / Server / React ──> contracts
server-main ─────────────────> handlers + sessions + module/runtime services
Session Assembly ────────────> Registry + Asset Resolver + Runtime Resolver
React components ────────────> Kernel stores + Command ports
React Geo runtime ───────────> contracts + maplibre-gl
```

禁止反向依赖：Contract 不导入平台代码；Kernel 不导入 React；Server handler 不依赖 UI；React 不直接读取文件或解析原始 Pi RPC；Electron Main 不复制 Agent Host 业务。

## 10. 验证基线

- `npm run typecheck`：Server、Public、React 和 Desktop 类型检查；
- `npm test`：30 项必要默认回归，覆盖进程、契约、持久化、安全边界、模块生命周期和桌面打包；
- `npm run test:react-smoke`：真实 Server、fake Pi 和浏览器工作台；
- `npm run test:desktop-smoke`：Electron、Agent Host、模型入口、模块设置、内置 Python、PDF 和退出清理；
- `TRANSPORTX_PACKAGED_APP=... npm run test:desktop-smoke`：真实 `.app`/DMG 运行时验证；
- `npm run test:pi-smoke`：显式执行的真实 Pi RPC 离线冒烟。

测试数量不是架构目标。新增或修改跨边界行为时，应覆盖协议、状态转移、权限边界或用户可见回归；纯实现细节不单独增加脆弱测试。

## 11. 当前限制与后续边界

- 正式验收平台目前是 macOS Apple Silicon；Intel Mac 和 Windows 安装包尚未完成发布验证。
- 仓库不分发实际 Knowledge/Data 资产，换机后需要重新安装或迁移用户 Module。
- 当前不提供在线模块市场、任意第三方 UI Bundle、远程 Agent、SSH/WSL 或第二种 Agent Runtime。
- Module 权限建立在本机可信来源之上；若未来开放第三方市场，必须另行设计签名、权限声明和执行隔离。

## 12. 演进规则

1. 新能力先定义或复用 Contract，再实现 Extension、Server、Kernel 和 React 适配器。
2. 新领域能力优先作为 Module/资产贡献，不在 Platform Core 写固定路径和领域 Prompt。
3. `server-main.ts` 只做组合；新增 API 进入类型化 route 和对应 handler。
4. 用户数据只能写入平台用户目录或当前 Session cwd，安装包资源始终只读。
5. 大型 Geo runtime 保持按需加载；只有真实性能数据证明必要时才拆分更多 bundle。
6. 发布产物必须用目标平台实机验证，正式公开分发不得绕过代码签名和公证。
