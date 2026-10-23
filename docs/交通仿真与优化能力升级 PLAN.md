# 交通仿真（Traffic Simulation）模块 PLAN

> 状态：按当前 Tool / Module 实现修订接入方案，待实施；本轮只核查源码与执行记录，未安装、启动或验证第三方服务及 SUMO 仿真。
>
> 初稿：2026-10-22；本次修订：2026-10-23。TransportX 当前工作区版本：3.23.2（未发布）。
>
> 输入：GIS / SUMO / OR-Tools 讨论、无头仿真修订意见、AgentSUMO 评审材料，以及两个参考项目的固定提交源码。
>
> 当前实现以 [ARCHITECTURE.md](ARCHITECTURE.md) 和实际源码为准；工具接入遵循 [Tool 与插件架构优化 PLAN](<Tool 与插件架构优化 PLAN.md>)。两份 PLAN 的阶段编号各自独立。
>
> 本次架构基线：Module v2 / Session Plan v3；`CORE_TOOL_BINDINGS` 已覆盖 Canvas、Geo、Interaction、Citation、Spatial、Module Authoring 六个模块、十二个工具，支持逐工具契约读取与结果诊断。Tool P0–P3 已合并，P4 初版及核心推广状态见 [Tool PLAN](<Tool 与插件架构优化 PLAN.md>) 和实际源码；交通仿真仍需显式的平台接入。

## 1. 定位：为现有 Agent 提供交通实验能力

**交通仿真（Traffic Simulation）是可安装、按任务选用的模块，提供交通场景构建、仿真执行和方案评估能力。** 拟用 Module ID 为 `com.transportx.traffic-simulation`。用户通过现有对话和 GIS 提出假设、指定对象、比较方案；Pi 理解任务并组合工具，确定性的领域代码验证输入、运行实验和提交结果。

交通仿真模块的稳定价值在于“研究问题 → 可复现输入 → 候选场景 → 仿真实验 → 空间结果和证据”，不以某个求解器、MCP 服务或专用 Planner 定义产品。SUMO 是首个仿真内核；AgentSUMO 是首选复用候选；OR-Tools 是后续候选方案生成器。三者的实现与版本可以变化，场景归属、输入版本和结果含义必须明确。

保留五项方向：

1. **Pi 是唯一 Agent Runtime**：保留模型循环、工具注册/调度、Skill、Extension 与对话历史，不移植参考项目的 Agent Loop、Planner、Agent State、模型配置或 Web UI。
2. **复用现有专业执行代码**：先验证 AgentSUMO 的建网、需求、运行和分析链路；只补本平台所需的路径、运行时、作业和结果适配，不先重写一套完整 SUMO Provider。
3. **业务接口与执行后端分开**：模型调用 TransportX 的领域工具；MCP 是候选内部通信方式，既不是新增权限边界，也不是首版产品功能。
4. **先交付批量实验，再增加交互控制**：一场 Run 可以由受管作业完整运行；TraCI 可在该作业内使用。跨回合 `start/step/control` 长驻连接只在确有在线控制需求时增加。
5. **现有 GIS/Canvas 承担展示**：只运行无头 `sumo`，不启动或依赖 `sumo-gui`；先用道路/路线/指标快照和报告，时间回放另行建设。

### 1.1 首个可用版本：局部交通方案对照实验

首个样例调整为：**用户在地图选定一组道路，比较调整限速前后的交通运行情况**。它能验证路网、需求、干预、无头仿真、结果查询和 GIS 的贯通，无需先解决车队调度模型。

- 使用固定、可分发的本地 OSM 与明确标注的合成出行需求；基线道路和路线输入冻结。
- 干预只支持选定 Edge 的静态限速调整，生成独立场景变体；首版不改车道数、连接、信号相位或车辆在线行为。
- 两组保持相同需求、车辆、发车计划、路径和随机种子，只有声明的道路限速差异；先研究固定路径下的影响，不将其解释为出行者重新选路后的均衡结果。
- 两组分别完整运行，展示路段速度、旅行时间、等待、完成/未完成车辆及异常；允许结果无改善或变差。
- 限速变化示例只是验收用例。领域对象和结果接口应能承载其他明确的场景干预，但不提前实现其编辑器或参数全集。

面向实际用户的输入同时规划“小范围 GIS 选区 → 在线获取 OSM”和“导入已有路网/场景”。P0/P1 只用固定本地场景跑通首条闭环，在线 OSM 输入移到 P2，不作为 P1 退出条件。固定本地样例用于可复现验收，不把要求用户始终准备 OSM 文件写成产品限制；在线获取失败时说明原因并提供导入路径，不静默改用别处路网或合成拓扑。

### 1.2 首版完成定义与后续优化方向

用户用自然语言与现有 GIS 完成选区/选路、准备场景、查看输入诊断、创建变体、启动两场无头 Run、查询结果并获得地图与对比报告。运行不依赖地图窗口；关闭标签或浏览器不改变作业状态，任务停止/删除仍须经 Host 清理。

**首版完成不要求 OR-Tools、持续 TraCI 控制或逐车动画。** 后续接驳车辆站点访问 VRP 作为第一个自动生成方案的案例，仍采用容量、硬时间窗与总旅行时间目标；求解器只生成可验证候选，再复用同一场景变体、运行与比较链路。

## 2. 参考项目核查：哪些可以复用，哪些仍需证明

本次按固定提交进行静态核查，不等同于安装/运行验收，也不据此宣称参考项目已经生产就绪：

- AgentSUMO：[`2ad1d91a02f442218d54f2b1aec25c3b813ed5df`](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/tree/2ad1d91a02f442218d54f2b1aec25c3b813ed5df)。
- ChatSUMO-Agent：[`2ec0cb6c148cc41e7c97668ed423470c8cbbda9b`](https://github.com/ChrisLi1221/ChatSUMO-Agent/tree/2ec0cb6c148cc41e7c97668ed423470c8cbbda9b)。

| 核查事实 | 对 TransportX 的含义 |
|---|---|
| AgentSUMO 的 [MCP 入口](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/agentsumo_mcp/main.py) 静态注册 26 个工具，通过 stdio 运行；[主 Agent](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/agentsumo/agent/agent_sumo.py) 另行调用 Anthropic 并管理工具循环 | 复用执行层有依据；不引入其 Agent，不将 26 个工具自动映射给 Pi |
| [独立包配置](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/packaging/mcp/pyproject.toml) 声明 Python ≥3.10，[主项目](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/pyproject.toml) 要求 ≥3.12 且 <3.13；[PyPI](https://pypi.org/project/agentsumo-mcp/0.1.2/) 提供 0.1.2 | 优先试独立包，不整体迁移；声明兼容不代表双平台实际安装成功。发布包与本次源码提交必须分别锁定、比对，不能因版本文本相同就视为相同内容 |
| AgentSUMO 的 [Runner](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/agentsumo_mcp/baseline/simulation_runner.py) 启动无头 `sumo`，在单次调用内循环 TraCI 并关闭；每 5 步采集车辆，先积累内存再写回放 JSON | 适合批量运行候选，不是等待下一次 Agent 命令的持续 Worker；首版必须能关闭轨迹采集或证明在明确规模上有界，隐藏前端回放不能减少采集内存 |
| [OSM 获取代码](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/agentsumo_mcp/baseline/osm_http.py) 包含 Overpass 镜像、缓存和区域 PBF 回退；自动区域表只有韩国、纽约、加州，并按 BBox 中心匹配 | 借鉴下载与缓存流程，不声称覆盖中国或任意大区域。P2 先接小范围在线获取；大 PBF 需另验覆盖、下载成本与 osmium 依赖，不默认下载 |
| [XML→SQLite](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/agentsumo_mcp/analysis/xml_to_sqlite.py) 已组织 trip、edge、network 等结果，但含按 `net_file` 和命名规则跳过/替换导入的逻辑 | 复用解析/schema 经验；必须按 Run 身份与原始输出版本导入，不能把同一路网多次运行视为重复或替换已有实验 |
| ChatSUMO 的 [普通 Runner](https://github.com/ChrisLi1221/ChatSUMO-Agent/blob/2ec0cb6c148cc41e7c97668ed423470c8cbbda9b/providers/provider_sumo_runner.py) 与[事件控制器](https://github.com/ChrisLi1221/ChatSUMO-Agent/blob/2ec0cb6c148cc41e7c97668ed423470c8cbbda9b/agent/traci_process.py) 使用不同运行路径，后者实际写死 `sumo-gui`；[Planner](https://github.com/ChrisLi1221/ChatSUMO-Agent/blob/2ec0cb6c148cc41e7c97668ed423470c8cbbda9b/agent/llm_planner.py) 另有领域动作选择 | 借鉴命令分解、事件校验及 Edge 查询；不能直接沿用事件执行链，更不能据 `gui=False` 声明推断实际无 GUI |

结论是**AgentSUMO 更适合作为首轮执行层候选，ChatSUMO 用于局部流程参考**。这是基于源码结构与适配成本的判断，执行可靠性、速度和包兼容性仍待 P0 实测。

## 3. 架构：保持平台边界，缩小新增基础设施

```text
用户 / TransportX GIS / 已有文件与数据
                ↓
Pi：唯一 Agent Loop + 交通仿真 Skill + 少量领域工具
                ↓
薄 Pi Extension → 已批准的 Host 交通实验操作
                ↓
Host：任务归属、受管作业、取消、成果校验与提交
                ↓
包内 Python 适配代码
  ├─ 首选验证：固定版本 AgentSUMO MCP（私有 stdio）
  └─ 若适配更小：直接复用其 Python 函数/脚本或有限修订
                ↓
无头 sumo / netconvert / duarouter → XML / 指标 / SQLite / GeoJSON
                ↓
既有 publish_geodata → present_visualization + Citation / 报告
```

图中两条复用路径是 P0 的选型对照，首个交付只保留被选中的一条，不建设可热插拔 Provider Registry、双后端回退或通用 MCP 平台。

### 3.1 各层职责

| 层 | 承担什么 | 不应接管什么 |
|---|---|---|
| Module / Skill | 交付能力、依赖、工作方法、输入说明与实验限制 | 不因 manifest 声明就取得任意 Host 执行权；Skill 不是进程管理或参数校验代码 |
| Pi Extension | 注册领域接口、传递 signal/toolCallId、返回有界摘要和结果引用 | 不嵌入第二套规划循环，不把全部上游工具/任意路径参数转发给模型 |
| Agent Host | 授权、场景/Run 归属、作业预算、状态确认、资源和输出验证 | 不动态 import 安装包中的任意 Host 代码；不维护第二套对话历史 |
| 包内执行适配 | 对接已选后端，处理参数/路径/版本与结果归一化 | 不另建 Session、全局文件服务、模型 Provider 或地图 UI |
| SUMO / TraCI | 执行确定配置并产生交通状态与原始输出 | 不决定用户意图或实验是否可比 |
| Canvas | 共享视图身份、标签、呈现生命周期、revision、受控资源引用与显式上下文 | 不承接仿真、指标计算或网络转换；不等同于 Document |
| Geo | Canvas 上的路网、道路选择与仿真指标图层 | scene/revision 与恢复仍归现有 Geo Extension，不搬到仿真服务 |
| Document | Canvas 上的 Markdown、表格、PDF 与 Office 报告 | 通过现有 Canvas 工具呈现，不增加独立仿真前端 |
| Citation | 输入、结果及分析依据的引用 | 沿用现有注册表，不接管 Run 或视图生命周期 |

展示分层固定为：

```text
Canvas：视图身份、标签、生命周期、资源引用、显式上下文
  ├─ Geo：路网、道路选择、仿真指标图层
  ├─ Document：Markdown、表格、PDF 等对比报告
  └─ Video 等已有领域适配
交通仿真模块：场景、变体、执行、指标和比较成果
Citation：输入、成果与分析依据的引用
```

计算结果交给 Geo 和 Document，视图生命周期复用 Canvas；首版不新增“仿真 Canvas”、Adapter 类型或专用前端插件。P2 报告明确通过 `canvas_present` 主动呈现，因此必须装配 Document；仅依赖 Geo 获得 Canvas 不会同时获得 Document。

Host 的交通实验服务采用平台批准的静态接入点；业务脚本与依赖随可安装模块交付。普通 Module 安装不能动态注册 Host 服务。未装配交通仿真模块的任务不能启动它的作业，第三方后端不接收 Host token 或模型 API Key。

### 3.2 当前升级机制：复用边界与交通仿真缺口

以实际源码和 [P0](<Tool 与插件架构优化 P0 记录.md>) / [P1](<Tool 与插件架构优化 P1 记录.md>) / [P2](<Tool 与插件架构优化 P2 记录.md>) / [P3](<Tool 与插件架构优化 P3 记录.md>) 执行记录为依据，不能只照旧架构文档中的阶段性描述判断能力缺失或完成。

| 当前机制 | 可以复用什么 | 交通仿真仍需实现什么 |
|---|---|---|
| [ModuleTrustStore](../src/server/module-trust.ts) | 桌面原生确认绑定包规范路径、ID、版本、入口和依赖；安装/启用/恢复前核对 | 走原目录/ZIP 安装与信任入口，不新增信任弹窗或布尔绕过；后端代码与依赖纳入实际交付检查 |
| [Manifest v2](../src/contracts/module.ts) / [Session Plan v3](../src/contracts/resolved-session-plan.ts) | 依赖闭包、入口、资产、运行时和当前任务装配 | 声明可选业务模块；不修改 Workbench 默认依赖，不靠放入源码目录自动启用 |
| [TypeBox 定义](../src/contracts/tool-definitions.mts) / [工具绑定](../src/contracts/tool-interface.ts) / [契约读取](../src/server/tool-contracts.ts) | `coreToolContracts`、`CORE_TOOL_BINDINGS`、`readToolContract / readModuleToolContracts` 已支持六模块十二工具及逐工具描述文件 | 增加交通工具绑定、定义和结果解析；保留现有多工具机制，只补独立业务包的源/批准契约/输出路径，不重新建设多工具支持 |
| [Host Client](../modules/shared/host-client.ts) | toolCallId、接口版本、signal、时限、HTTP/解码错误关联，无自动重试 | 在独立模块入口中 bundle；交通领域解析、错误码、Pi hook 与恢复指引仍由模块提供 |
| [Host 最终校验](../src/server/tool-request.ts) / [服务映射](../src/server/session-service.ts) | `validateToolRequest` 按绑定工具核对平台批准定义、会话/计划/token 与输入结构 | 批准契约根目录仍走 `coreModulePath`，operationId 校验还保留 Spatial 特例；显式补交通领域的路径、操作与服务授权，不能把包内契约当成权限 |
| [Spatial Owner](../src/server/spatial-owner.ts) / [执行确认](../src/server/spatial-invocations.ts) | 持久历史归属、派发前保留操作、同操作复用、manifest 核对与未知恢复的已验证模式 | 交通领域实现自己的 Run/输入/输出核验；不能直接把 Spatial 类或 `spatial_` ID 当公共执行引擎 |
| [runJob](../src/server/sessions.ts) / [PythonRunner](../src/server/python-runner.ts) | 有限作业、取消、容量和进程回收；Job 是内存事实 | 首版沿用等待完成的有界调用；持久受理/Run 清单另行确认，不把 Promise 或 jobId 当恢复依据 |
| [工具诊断](../src/server/tool-diagnostics.ts) / [overview](../src/server/server-main.ts) | 已按 `CORE_TOOL_BINDINGS` 逐工具核对，含 Host 与 Pi-local 工具的有效领域结果 | 沿现有分支补交通结果解析及执行确认语义；准备成功不等于 Run 完成，不新增诊断框架 |
| [工具卡错误投影](../src/web/platform/conversation/tool-card-utils.ts) | 已识别 Citation、Spatial、Module Authoring 的未知结果，以及已取消反馈和整轮重试限制 | 增加交通 kind/code 读取，保留已有消费行为，不借用其他领域名称冒充兼容 |

### 3.3 模块交付与装配约定

- 固定 `id: com.transportx.traffic-simulation`、`type: module`、`manifestVersion: 2`；使用 `presentation.locales` 提供“交通仿真 / Traffic Simulation”。原始工具名和 Skill 行为不随展示语言改变。
- 最小仿真/地图模块依赖 Geo 与 Citation，Canvas 由 Geo 的依赖闭包获得。完整 P2 还要求显式依赖 `com.transportx.document`，由 Document 声明文档 Adapter，再经 `canvas_present` 呈现报告；不能只因 Workbench 默认带 Document 就省略可安装包自己的依赖。空间分析按实际调用增加，不强制依赖本地运筹模块。
- Skill 与 Pi Extension 使用现有 `entrypoints`；成果类型可声明在 `contributes.artifactTypes`，样例/数据资源用已有 `contributes.assets`。**当前 Manifest 没有 `contributes.tools`、Host 服务入口或通用 MCP 配置字段**，本计划不预填这些未实现字段。
- Session Assembly 冻结所选版本、目录、入口与资产；新旧任务沿各自计划执行。代码信任不锁定可编辑脚本的每个字节，实验另记实际脚本/依赖哈希；Native Runtime 与资产完整性仍按现有规则检查。
- 最低 `platformVersion` 必须对应实际具有交通 Host 操作与契约支持的发行版本；不能因当前源码为 3.23.2，就宣称当前 3.23.2 已支持模块。修改模块内容时独立升版；本轮只有文档修订，不创建或升版模块。

拟议包布局遵循现有安装模型，非新增清单规范：

```text
com.transportx.traffic-simulation/
  manifest.json
  skill/SKILL.md
  extensions/pi-traffic-simulation/index.ts   # 构建后自包含入口
  contracts/                                # 同源生成的模型工具描述
  scripts/                                  # 包内执行适配与必要复用代码
  assets/traffic-examples/                   # 仅小型、可分发验证数据
  requirements.lock / third-party-notices/   # 依赖与复用来源
```

Contract 文件是包内静态描述，不伪装成可执行 Extension；由交通契约的显式读取映射定位。普通安装仍不获得 Host 插件加载权。最终 ZIP 不含符号链接，也不依赖 `../../modules/shared`、仓库 `src` 或开发机 node_modules；构建时可引用共享源码，产物必须独立验证。

### 3.4 Tool Contract、执行绑定与结果定义

遵循 Capability–Tool–Operation 的职责划分：Capability 身份复用 Module ID；`toolId` 是接口身份，`piName` 是模型调用名；Host Operation 由实际路由和受信任实现确定，不能让模型任意传操作名决定权限。

1. 模型输入在平台审查的 TypeBox 定义中单一编写，沿现有生成链输出包内 JSON；Pi 注册使用该包内 input。Host 使用同源生成、随平台交付的批准定义最终校验，不从用户可编辑包加载代码来决定权限。
2. 契约包含现有 `moduleId / toolId / piName / contractVersion / semanticVersion / input / output`；output 描述领域协议、版本及 `detailsKind`。模块版本、工具接口版本、执行语义版本和第三方后端版本分别管理。
3. 多工具身份与契约相对路径直接接入 `CORE_TOOL_BINDINGS`，同源定义接入 `coreToolContracts`。对独立业务包补有限的源码/批准契约/构建输出静态映射，替代目前只从 ID 推导内置目录的假设；不重建多工具读取、不新增运行时注册中心或公共插件 SDK。
4. Pi 仍以原生 `registerTool` 注册，Extension 负责解码和领域校验。契约 Schema 指纹不同只能说明漂移；接口主版本不兼容由 Host 拒绝，不能仅靠模型注册阶段的校验。
5. HTTP 上下文中的 sessionId、token、toolCallId、contractVersion 来自受信任启动/调用链，不混入领域模型 Schema。`operationId` 仅在需要查询/重复保护时使用，不要求模型替所有工具生成它。

候选关联示例：`com.transportx.traffic-simulation` → `traffic-simulation.run` → `traffic_run` → 固定的运行准备/执行动作；查询和取消映射到各自已批准动作。同一工具可触发准备和执行两次 Host 请求，二者共享 Pi toolCallId，但不等于两个仿真 Run。具体版本和文件名在 P0 形成可验证定义后冻结。

### 3.5 代码信任与 Host 授权分别接入

复用原生代码信任入口，不新增审批体系；已接受模块仍须通过 Host 当前会话、计划模块、服务凭据和资源归属校验。新增交通服务时需同步 `SESSION_SERVICES`、内部路由白名单、Session token/endpoint 创建、`buildSessionPiLaunch` 注入及服务初始化/停止流程。不能借用 Spatial/Citation token，不能复用其 Module ID，不接受包自报 endpoint 自动授权。

服务 token 只传给 Pi 侧可信适配；执行 SUMO/MCP/Python 的环境需显式收敛。当前 ProcessRunner 使用 `{ ...process.env, ...options.env }`，传入精简 env 仍会继承父进程变量；P1 前必须增加显式替换环境的启动选项并贯穿 PythonRunner，现有调用保持默认继承行为。交通适配只传所选解释器/原生入口、必要系统变量与任务缓存配置，验证父进程测试标记和服务凭据不会进入 Python/MCP/SUMO 子进程；嵌套后端沿收敛后的环境启动。

query/cancel 同样先做当前授权，再核对持久 Owner；持有 operationId 或知道任务目录不授予查询/执行权。这些检查限定 Host 能力，不宣称对可信本机代码实现 OS 隔离。

### 3.6 MCP 只作为内部接入候选

当前 [Session Service](../src/server/session-service.ts)、[Module 契约](../src/contracts/module.ts) 与 [Pi 启动链](../src/server/session-pi-launch.ts) 没有现成的 AgentSUMO 接入；不能将 Claude Desktop 的 MCP 配置直接当作 TransportX 能力。

如果 P0 选择 MCP，由受管 Python 适配进程启动固定入口的 stdio Server，握手后只调用批准的操作，工具目录核对已锁定的版本/Schema。协议结果由适配层转换为本平台领域结果，模型仍看到 Pi 工具。Server stderr 与协议 stdout 分流，RPC 取消不能代替子进程退出确认。

每个任务作业使用自己的工作目录、配置和后端进程，不跨会话共享其全局对象/TraCI label；完成或取消时回收整个进程树。`PythonRunner` 可承载一个有限时长的 Python 适配作业，内部 MCP 会话由适配代码管理，不把 stdio Server 当作无需结束的普通 `run()`。资源占用应计入 Host 预算，不能只数最外层进程。

如果维护这条链需要大幅修改上游、不能可靠取消、不能固定运行参数，或为了几项函数引入过多依赖，应选择直接复用已审查函数/脚本。保留来源、许可证、锁定版本和有限补丁，先不上公共 SDK。

## 4. 复用之前必须解决的具体差异

以下为固定源码中的适配点，不是已经复现的运行故障；“MCP 白名单”本身不能解决它们。

| 差异 | 首版要求 |
|---|---|
| [路径助手](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/agentsumo_mcp/utils/path_utils.py) 对绝对输出目录直接使用；[文件复制](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/agentsumo_mcp/utils/file_utils.py) 按文件名覆盖 | Host 从场景/Run ID 派生路径，每个 Run 独立目录；校验输入及 XML 中的间接文件引用，限制输出归属和符号链接。仅设置 cwd/输出根环境变量不等于文件隔离 |
| [设置代码](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/agentsumo_mcp/settings/settings.py) 含特定 macOS 默认路径和配置优先级；[需求生成](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/agentsumo_mcp/baseline/trip_generator.py) 调用裸 `python` | 统一使用 Host 为模块选择的解释器和显式原生入口；不得因依赖缺失转用系统 Python。开发覆盖与发布 runtime 分开 |
| Runner API 未显式提供 seed/step 配置，循环会在墙钟超时后 break；后续路径仍可返回 `success` | 记录实际命令、配置、种子、步长、最终时间、终止原因和输出完整性；补最小适配或换调用方式，不能照单信任上游 `status` |
| [路由生成](https://github.com/urban-ai-institute/kra35-prismx-agentsumo/blob/2ad1d91a02f442218d54f2b1aec25c3b813ed5df/agentsumo_mcp/baseline/route_generator.py) 使用 `--ignore-errors`；部分网络转换选项固定 | 核对生成/路由/实际发出/完成车辆数量与诊断，丢弃或不可达显式报告；不静默继承可能改变研究对象的默认过滤、自动重路由或错误忽略 |
| 回放整场积累内存，SQLite 有跨 Run 去重/替换规则 | 关闭不需要的轨迹采集或限定可证明规模；Run 独立数据库导入后校验，禁止覆盖历史实验。未来回放才增加分块与时间索引 |
| 独立包声明 Python ≥3.10，但完整链包含原生程序、工具脚本及可选 PBF 依赖 | 在模块专属环境验证实际 wheel、导入、工具发现和双平台路径；包声明不代替验证，不向平台基础 Python 隐式升级依赖 |

受控执行仍是本机受信任代码执行，不承诺 OS 沙箱。范围控制由代码、作业和资源协议落实，不能依赖 Prompt 告诉模型“不要越界”。

## 5. 领域对象、结果与可比性

### 5.1 最小对象及唯一归属

| 对象 | 最小事实与权威 |
|---|---|
| `TrafficScenario` | 所属任务、来源、范围/CRS、网络/需求/路线/车辆、时段、种子、步长和输入哈希；基础输入版本冻结 |
| `ScenarioVariant` | 父场景版本、声明的干预列表、目标 Edge 与单位、生成配置及派生输入哈希；基线是空干预，禁止原地改基线 |
| `SimulationRun` | 变体引用、持久 Owner 关联、后端/依赖/运行时版本与哈希、实际配置、operationId/jobId 关联、执行状态、最终仿真时间、结束原因、清理确认和输出引用 |
| 结果与比较清单 | 原始 XML/解析版本/SQLite 与 GeoJSON 引用、指标定义/单位/窗口/分母、共同输入核对、声明变量与异常；由 Host 校验后提交 |

后续 `OptimizationPlan` 记录模型、矩阵、约束、解/最优证明/终止原因与候选路径；经过同一变体准备和可行性校验后执行，不维护一套求解器专用实验状态。

Pi JSONL 是对话与工具历史，Geo Extension 是地图 scene/revision 权威，现有 Citation 是依据权威。交通仿真模块只保存交通领域输入、执行与成果事实；SQLite 不成为 Session 或 Job 的新权威。

```text
<task-cwd>/traffic-simulation/
  scenarios/<scenario-id>/   source、network、demand、routes、mapping、scenario.json
  variants/<variant-id>/     intervention.json、派生网络/配置、校验结果
  runs/<run-id>/             run.json、实际配置、原始 XML、results.sqlite、指标/GeoJSON
  comparisons/<id>/          comparison.json、图层、报告
```

路径以 POSIX 相对路径序列化；复用现有路径归属与 SHA-256 校验。Run 输出不写回模块目录、共享源场景或其他 Run。源码版本、模块版本号不能保证内容逐字复现；需记录脚本、锁文件、配置、输入与输出哈希，并保留所需副本。

源路网/需求可来自当前任务文件，或 Session Plan 明确解析的 Data 资产根目录；后者须按所选 assetId、实际根目录和完整性规则授权读取，不从用户请求接受任意资产根路径。交给第三方后端的输入在核对后按需暂存/引用，只给它本次必要文件；生成物始终写入当前任务。不能将平台资源边界简化成“所有读取都只能来自 cwd”，也不能把目录级资产授权扩大为所有 Module 文件访问权。

持久执行确认参照 Spatial 放在用户数据根的 `executions/traffic-simulation/<owner-hash>/`，只保存调用、输入版本、提交与 Run/成果引用；完整 XML/SQLite/GeoJSON 仍留在任务目录。该路径为拟议交通领域存储，不表示现有代码已实现。避免只将确认文件放进可复制的任务 cwd 后，就让另一个 Pi 历史自动继承旧操作权。

### 5.2 批量作业与交互 Worker 分开

首版批量 Run 采用 `prepared → running → finalizing → ended`；无法确认执行/提交时为 `unknown`。**结束原因和清理状态分别保存**，完成后关闭进程不能覆盖完成事实，终止请求不能直接标成已退出。

**默认复用当前同步有界作业，不在首版承诺立即返回的后台运行。** `runJob()` 返回完成 Promise，现有路由把请求 signal 传到 Job；简单提前结束 HTTP 响应不能获得可靠后台语义。交通 Extension 先受理取得持久关联，再执行并等待结果，时限按仿真预算配置，客户端覆盖 Host 执行/关闭预算。真实规模证明必须后台执行时，再单独设计受理提交、信号解绑、停止与恢复；不通过 fire-and-forget 绕过 Job 管理。

主路径采用已验证模式，交通领域的具体输入与提交点另行实现：

```text
Pi execute(toolCallId, params, signal)
  → prepare：当前授权 + 持久 Owner + 结构/语义/输入版本校验
            Host 签发并保存 operationId、Run ID 与调用关联，不启动 SUMO
  → execute：按原关联核对输入 → runJob → PythonRunner / 固定执行适配
  → finalizing：校验终止原因、XML/SQLite/GeoJSON、输入稳定性及输出哈希
  → 先提交交通结果 manifest → 更新执行确认 → 返回领域结果与独立 warning
失联/未确认取消：按 operationId 或原 toolCallId 查询，不重新派发
```

Owner 参照现有 `spatialOwner` 的已验证规则：受管 Pi JSONL 真实路径、header.id 与 header.cwd / Session cwd / Plan workspace 一致性。不可用活动 Session ID、cwd 单独值或请求正文代替；恢复同一持久历史可查询，复制到另一 JSONL 不继承操作权。首次受保护写入前必须形成有效持久归属，缺失时拒绝，不静默降级。

`toolCallId` 表示 Pi 调用，`operationId` 表示 Host 预留的逻辑操作，`jobId` 表示现有作业，Run ID 表示交通运行。按需关联，不强制相等，不为满足四层命名再生成 invocationId。查询优先读原执行确认与成果；再次 execute 原操作还应核对当前输入版本，不因结果曾成功就接受已改变的输入。

- 达到约定仿真时域或明确的需求耗尽条件后，核对最终时间、输出与样本覆盖才确认完成。时域结束仍有在网车辆可以是有效观测，但必须报告截尾，不用其冒充全部完成。
- 墙钟超时、取消、崩溃、未确认提交不算正常完成；已有结果可以诊断读取，不能直接生成正常收益结论。
- Host 重启后按清单与已提交文件核对；可确认的成果复用，不能确认则保持未知，不自动重跑。只凭旧 PID 或第三方成功文本不能证明进程归属和执行结果。
- 同一身份、操作 ID 和同一输入重发复用确认；输入冲突拒绝。新 ID 也不能绕过未确认 Run 的核对，防止模型重复启动昂贵实验。

Run 成功以必需输出校验和 manifest 提交为准，不能以第三方退出 0 或已写部分文件代替。提交后响应丢失、引用失败或 UI 解码失败不回滚成果；重启后按原请求、输入快照、Run manifest、输出路径/哈希和领域格式核验，能确认则返回原结果，不能确认则保留未知。执行记录损坏、缺失或找不到内存 Job 都不证明“从未运行”，不自动补跑，也不宣称跨崩溃 exactly-once。

交互 Worker 是后续执行模式：只有显式 step 推进，同一 Run 串行命令，跨工具调用保持连接。与批量 Run 共享身份和成果格式，但接口、取消与恢复语义分别验证；不让批量工具假装支持 step，也不宣称 MCP 长连接等于仿真长驻会话。

### 5.3 比较的是共同条件下的声明干预

不能要求两个 Run 的所有输入哈希相同，也不能只因都叫“baseline/policy”就认为可比。

1. 校验共同条件：源路网版本、出行需求/发车计划、车辆、种子、步长、时域、路由/重路由设置与指标口径。
2. 校验实验变量：变体中的限速变更对象、原值/新值和单位，派生网络只包含已声明变化。新网络哈希是预期结果，未声明的拓扑、需求或路线变化应拒绝或列为额外变量。
3. 首版固定路径比较，路径变化不在允许差异内；后续若研究重新选路或需求增长，须明确新的实验变量和相应共同条件，不能沿用旧口径。
4. 输出旅行/等待时间、路段速度、已发出/未发出/已完成/未完成车辆和异常传送等；缺失不是 0，基线为 0 时不计算普通变化百分比，记录指标分母与窗口。

单种子用于执行闭环验收，不能据此宣称真实交通收益。真实效果分析还需要需求/参数校准及多种子实验，这不改变首版先把执行与证据贯通的目标。

### 5.4 SQLite、地图与回放

XML 是原始运行输出，SQLite 是带 schema/解析版本的领域结果索引。优先每 Run 一份 `results.sqlite`，暂存导入、核对 Run ID/数量后提交；不可用同一路网文件名判断重复导入。跨 Run 比较经受控查询组合，不先建全局交通数据仓库。

首版查询输入为 Run、指标、时间窗和 Edge/分组，执行固定参数化查询，限制行数、耗时和输出体量。先不向模型开放任意 SQL，也不引入参考项目的通用 SQLite / Filesystem MCP Server。将来确需自由 SQL 时另行设计只读访问边界。

网络 geometry 和结果统计导出 WGS84 GeoJSON，保留网络/EdgeMapping、变体/Run、单位和采集窗口，沿用 `publish_geodata → present_visualization`。精确 GIS ID/Edge 映射优先，名称只作候选，不为道路查找先建向量数据库。

车辆时间回放属于派生成果读取，不等于在线仿真控制。未来若建设，先做抽样、分块落盘、时间索引与按窗口加载，并单独评估现有 Geo/Canvas 的适配；首版不推送全量逐车逐步轨迹，不新增动画协议。

### 5.5 模型摘要、产品反馈与历史读取

沿现有三层结果约定：领域 manifest/解析器维护事实；Pi `content` 提供有界摘要、资源引用与回读指引；`details` 提供版本化交通结果给当前工作台和历史重放。不创建三个结果数据库，不把 XML、SQLite 全库或 GeoJSON 全量塞进消息历史。

交通输出的拟议协议为 `transportx-traffic-simulation`，独立的成功/执行确认/错误 details kind 和解析器随契约定义；不冒用 `tau-spatial-analysis`。错误保留稳定 `code / phase / commit`、可选 field、调用关联和恢复指引；`not_started / not_committed / unknown` 沿薄 Host Client 语义解释，不从 HTTP 500、AbortError 或超时直接推断可安全重试。

Extension 要使用 Pi 错误通道；特别验证 Pi 在取消后可能先结算 tool_result 的竞态，借鉴 Spatial 的 pending/hook 处理，不让“结果未知”只留在成功文本中。成功后的迟到取消不能改写已提交事实，可选 Citation 登记失败单独返回 warning。

当前 `hostExecutionState` 已覆盖 Citation/Spatial 和 Module Authoring 的特定错误，交通接入时沿原消费位置补对应 kind/code/版本读取：未知显示查询指引并禁用盲目整轮重跑；读取/呈现重试只读成果，不重新执行 SUMO。新领域的旧版 Tool Result 后续保持可读，不靠改写 JSONL 或重跑修复展示。地图交给 Geo，报告交给 Document，二者复用 Canvas 生命周期；Citation 独立登记依据，不动态加载模块前端代码。

## 6. 功能与工具：按任务暴露，按能力渐进交付

首版建议以下领域接口，名称为待验证候选；原稿 8 个工具尚未实现，不作为已发布兼容承诺，也不为凑数量保留它们。

| 候选工具 | 输入/产出及执行边界 |
|---|---|
| `traffic_prepare_scenario` | 从地图上下文与授权数据准备网络、需求、路线并验证；返回版本/缺失项/诊断和图层引用，步骤可分别确认，不做不可观察的一键黑盒 |
| `traffic_create_variant` | 已冻结场景 + 选定 Edge 的限速干预 → 独立变体及差异校验；不提供任意网络编辑或 XML 执行入口 |
| `traffic_run` | 已验证变体 + 运行参数；适配器内部 prepare 取得 Run ID/操作 ID 后 execute 并等待有界作业完成，返回已确认结果；受理关联不等于仿真完成 |
| `traffic_get_state` | 查询 Run/已有调用的阶段、进度、最终时间与提交事实；进度不等于完成，不推进仿真 |
| `traffic_cancel_run` | 请求取消并查询停止/清理确认；不承诺回滚已执行仿真或删除已有输出 |
| `traffic_query_results` | 对已提交 Run 做指标/Edge/时间窗口查询，返回有界摘要和空间成果引用 |
| `traffic_compare_runs` | 核对变体声明与共同条件，生成比较、图层和依据；输入不符或执行未确认时拒绝正常收益结论 |

后续按真实用例增加 `traffic_optimize / traffic_apply_plan`；交互模式再增加 `traffic_start_simulation / traffic_step / traffic_stop_simulation`。两类能力可以独立启用，不能让用户安装 OR-Tools 才能跑基础仿真。

### 6.1 按 Operation 选择保障，不给整个模块统一套 Job

| 领域动作 | 保障选择 | 提交/查询依据 |
|---|---|---|
| 状态、已提交指标、地图上下文查询 | L1 | 当前授权 + 有界读取；读取已有运行记录不等于为查询再建 Invocation |
| 变体准备、导出快照、保存比较摘要 | L2 为起点 | 独立领域对象、输入版本、原子 manifest 与可核对的重复行为；如果派生计算实际昂贵，再提升该动作保障 |
| 转网/需求生成/场景构建、SUMO Run、后续求解 | L3 | 派发前持久关联、既有 Job、资源版本、提交 manifest、恢复查询及不重放未知操作 |
| 取消已有运行 | 原运行的控制动作 | 记录取消请求，按进程/提交确认结果；不创建第二个仿真 Job |

L1/L2/L3 是执行保障，不是信任或权限级别。网络取数还需独立的来源、下载/资源校验；从模型工具 `traffic_prepare_scenario` 进入的快速参数校验与实际转网可以有不同保障，不能因共用一个工具就绕过执行约束。

### 6.2 接入现有能力中心的三态诊断

在 `platform.getOverview(sessionId?)` 的现有只读核对点中加入交通工具：精确计划 → 当前 Pi Bridge → Extension 真实入口/sourceInfo → active 与 Schema → 交通领域已确认成功。多工具逐接口核对，不以一个 Run 成功证明全部工具都可用，也不把准备成功当作仿真完成。

沿用 `available / unavailable / unverified` 及原因、观察代次/时间；无会话、仅历史样本、尚无执行证明应保持未验证。诊断不能注册/激活工具、代替资源授权、自动启动 MCP 或 SUMO，也不保存第二张可用性表。运行环境检查在实际准备/执行入口按需进行，结果通过现有产品读取路径呈现，不声称当前 overview 已有通用 SUMO readiness 协议。

现有 `CORE_TOOL_BINDINGS`、`readToolContract / readModuleToolContracts`、批准契约读取、overview 与 `diagnoseTool` 已具备多工具核对，交通接入只增加绑定、批准路径与领域解析；仅添加包内 JSON 仍不会自动获得 Host 支持。保持现有第一方静态核对，先支持首条真实交通工具链。

Skill 说明交通建模、输入确认、实验口径和结果解释；代码负责权限、路径、状态及约束校验。运筹方法可参考本地已有的 `local.operations-research` Skill 模块，但它只是当前工作区的本地内容，既不保证部署用户已安装，也不提供受管求解器 runtime。未来优化能力需显式声明自己的算法依赖与执行契约，不能用 Skill 文本代替它们。

## 7. 实施顺序与交付门槛

本次重排阶段，替代原稿“P2 先持续 Worker、P3 必须 VRP 才形成首版”的顺序。**首个交付路径为 P0 → P1 → P2，正式发布另过 P5；P3/P4 为后续按需增强，不相互构成前置条件。**

| 阶段 | 交付内容 | 退出条件 |
|---|---|---|
| P0：复用选型与架构落点 | 固定本地场景、上游/包与显式本机环境，对照 MCP 与直接复用；确定首个契约、平台路径映射、Owner/提交点和时限 | 真实跑通无头 SUMO 和结果读取，选定一条复用路线；记录静态接入增量，不以在线取数或 MCP 工具列表代替运行证据 |
| P1：独立模块首条闭环 | 独立包安装→真实 Pi→批准 Host 操作→固定本地 SUMO 场景→成果落盘→Geo 地图；补契约/Client、环境替换、派发前持久受理及查询 | 模块移出仓库仍可执行，Contract/绑定/批准路径一致；成功/错误/未知进入历史和工具卡；验证收敛环境，网络/EdgeMapping/GIS 可核对；不要求在线 OSM |
| P2：批量方案实验初版 | 限速变体、两次 Run、SQLite/指标查询、比较与报告；显式装配 Document 主动呈现；补重启核验、逐工具诊断，随后接小范围在线 OSM 输入 | 两组无头实验/地图/Document 报告贯通，输入变量和结果一致；同操作不重复、未知不重算、恢复与 Owner 核对通过；在线取数有真实证据，失败可导入；现有核心工具保持兼容 |
| P3：自动生成候选方案（可选） | OR-Tools 接驳站点访问 VRP、路网矩阵、路径/停靠与约束验证，接入同一变体/Run/比较链路 | 容量/硬时间窗可核对；有解/已证最优/无解/超时分开；候选经合法路线和实际服务验证，不能仅凭目标值宣布改善 |
| P4：交互控制或时间回放（可选） | 按实际需求分别立项：长驻 TraCI Worker；抽样、分块时间回放 | 控制验证跨回合连续 step、取消、串行与未知处理；回放验证时间窗口/体量与读取性能。两项独立验收，不要求一起建设 |
| P5：桌面分发 | SUMO/模块 Python 解析与安装校验、Session 装配/恢复、独立平台包及许可/签名说明 | 两平台干净环境安装、运行、取消、恢复与卸载通过；解释器/依赖/原生程序归属和哈希可核对，不依赖开发机环境；损坏/缺失版本明确拒绝，旧成果读取策略明确 |

P0 的首轮工作是对选定复用链做有限验证，不是安装并开发全套 26 个工具。若核心差异需要维护一个庞大 fork，应明确否决该复用路径，保留有价值的局部实现，不用不断增加平台抽象维持它。

## 8. 平台落点、运行时与资源边界

| 当前基础 | 需要的最小增量 |
|---|---|
| Module / Session Plan / Trust / 现有 Installer | 一个可选业务 Module 及必要的静态契约核对；目录/ZIP 安装、启用、恢复与卸载仍走原入口，不加入内置默认依赖 |
| `tool-definitions.mts`、`generate-tool-contracts.mjs`、`build-tool-modules.mjs` | 接入 `coreToolContracts / CORE_TOOL_BINDINGS` 的现有生成与 bundle 链；保留六模块十二工具输出。当前路径仍从 ID 推导 official/capabilities 内置目录，需补独立业务包的源/批准契约/产物映射 |
| `tool-interface.ts`、`tool-contracts.ts`、`tool-request.ts` | 复用已有多工具身份/文件映射与逐工具读取，只补交通绑定、批准来源及领域校验；不新增 manifestVersion 或运行时插件注册中心 |
| `session-service.ts`、Session token/endpoints、`session-pi-launch.ts`、`api-routes.ts` 与组合根 | 增加明确的交通服务授权、内部路由、受理/执行/查询/取消；静态注入 Service 与停止钩子，包自报信息不授予权限 |
| `modules/shared/host-client.ts`、Pi 原生 API | bundle 薄通信进交通模块；领域错误、返回解析和取消竞态在自己的 Extension 中处理，不通过运行时跨包相对 import 共享源码 |
| `sessions.runJob()` / PythonRunner / ProcessRunner | 复用同步有界作业与清理，显式增加并贯穿环境替换选项；现有默认继承行为保持。验证 HTTP 断开、正常响应/迟到取消和内外层凭据收敛，不增加后台调度器 |
| Spatial Owner / Invocations 的已验证模式 | 新增最小交通领域确认与 Run manifest 核验；仅在确有共性时抽取 Owner 校验等小 helper，保留 Spatial 原协议/存储/历史行为 |
| `server-main.ts` overview、`tool-diagnostics.ts`、能力投影与工具卡 | 静态接入交通接口的来源/Schema/成功核验；补领域 kind/code 的未知、取消与重试限制，复用能力中心，不新增专用状态面板 |
| Canvas / Geo / Document / Citation | Canvas 提供视图底层；Geo 显示地图，Document 呈现报告，Citation 登记依据。P2 明确依赖 Document，不新建仿真 Canvas；引用失败不回滚仿真 |
| Native Runtime、Installer/Assembly/Plan 与 `platform-profile.mjs` | SUMO 分发扩展现有 ffmpeg 专用契约与校验；Python 依赖单独打包验证，更新最低平台版本，不以清单声明代替运行支持 |

### 8.1 独立业务包的一次平台接入

本计划采用下列明确的源码/产物落点，均为拟新增路径，尚未创建；通过有限静态映射接入现有构建与批准读取，不开放用户包任意指定平台路径：

| 角色 | 拟议落点及交付约束 |
|---|---|
| 受版本控制的模块源码 | `modules/optional/traffic-simulation/`，包括 manifest、Skill、Extension、脚本、有限复用源码及依赖锁定；不使用被忽略的 `modules/installable/` 作为唯一来源 |
| 模型输入定义/工具绑定 | 沿 `src/contracts/tool-definitions.mts` 与 `CORE_TOOL_BINDINGS` 增加交通项，绑定描述文件路径和 `execution: host`；只为实际 Pi-local 工具声明 pi-local |
| Host 批准契约 | 同源生成到 `modules/approved-contracts/traffic-simulation/`，不包含可执行模块入口；Host 通过平台静态映射从这里读取，不能改从用户安装目录读取批准定义 |
| 独立业务包输出 | `dist/tool-modules/traffic-simulation/`，含自包含 Extension 与包内生成契约；独立 ZIP 输出到 `release/modules/`，按版本与平台命名，不提交生成目录 |
| Host 服务及授权 | 拟新增 `src/server/traffic-experiment-service.ts`，在既有组合根静态创建；`SESSION_SERVICES` 与路由/token/启动注入显式绑定 `com.transportx.traffic-simulation` |

`coreModulePath()` 当前将模块 ID 推导到 `official/` 或 `capabilities/`，不足以同时表达上述源码与批准位置；只补源路径、批准路径和独立输出的有限第一方映射，现有多工具 Contract 读取与诊断继续复用。

当前桌面配置包含 `modules/**`，因此新增 `modules/optional/**` 时必须同步从基础安装包排除，且不能将可选 Extension 自动复制进默认 `dist/module-extensions` 镜像。平台只携带批准契约和操作支持，模块业务代码/运行时通过独立包交付；不能只“不加入默认依赖”却把整个可选模块装进基础包。

Host 的批准定义与可安装业务包独立交付：平台携带结构校验和已批准操作实现，业务包携带同源描述、Extension、脚本和依赖；二者按接口/执行语义核对。不从用户包加载任意 Host 模块，也不把业务包的 SUMO/Python 大依赖复制进平台基础安装包。

沿现有核心模块 bundle 链产出自包含 Extension，校验目录/ZIP、安装后物理路径、含空格路径、独立包移出源码树，以及桌面 asar/unpacked 的实际加载；仅将内置路径推导补为可选包静态映射，不重新实现 bundle 系统。外部 Python/原生程序必须指向真实磁盘文件，不能使用 asar 虚拟路径。新模块版本不能覆盖活动任务的旧版本和已提交成果。

### 8.2 SUMO 与模块 Python 的运行时交付

开发验证允许显式指定 SUMO 和模块专属 Python；发布版使用受校验的独立依赖环境及无头 `sumo / netconvert / duarouter` 和工具资源。基础 Python requirements 未包含 `traci / sumolib / ortools`，不在平台启动时自动 pip 安装或执行未固定版本的 `uvx`。环境检测和执行必须使用同一解释器，OR-Tools 只在优化能力启用时需要。

`requirements.lock` 只记录依赖选择，不能完成环境制作、安装、解析或恢复。以下是明确的开发交付项，开发首版的本机路径覆盖不替代 P5：

| 交付项 | 必须实现并核对 |
|---|---|
| 运行时解析 | 增加 SUMO 原生入口/工具资源与模块 Python 入口解析，区分开发覆盖和受管包；探测与运行使用同一实际路径，缺失时返回诊断，不静默回退系统解释器 |
| 契约与安装校验 | 扩展当前只支持 ffmpeg/ffprobe 的 Native Runtime 类型、解析、Registry 兼容性及 Installer 校验；模块 Python 环境明确平台/架构、解释器、依赖版本、相对路径、完整性与许可，不能把 SUMO 填进 ffmpeg 字段 |
| 模块 Python 环境制作 | 选定并实际验证自包含环境或可重定位制作方式，包含必要库/动态依赖；满足安装器拒绝符号链接的既有规则。移动安装目录后仍能导入并执行，不把开发 venv/Conda 路径作为成品 |
| Session 装配与恢复 | 将实际 SUMO/Python 版本、入口、依赖清单与完整性关联写入受管计划并在恢复时核对；同步 Session Plan 解析和兼容策略，旧 reader 不得把不支持的 runtime 当作可用 |
| 独立平台打包 | 模块打包脚本制作平台专属 ZIP，携带无头程序、工具脚本/typemap、Python 环境及第三方声明；校验基础安装包未携带该业务运行时，两平台分别验收安装/取消/恢复/卸载 |

正式 runtime/Plan 字段在 P0 可行性记录后确定，不能只靠增加 manifest 字段宣称支持。P1 使用显式本地环境时在 Run 记录实际解释器、程序、依赖版本与哈希，并明确这是开发配置，不伪装成已冻结的受管 runtime。

OS/架构、入口、权限、签名与发布元数据继续集中于 [platform-profile.mjs](../desktop/scripts/platform-profile.mjs)，业务文件不新增 OS 分支、`.exe` 拼接或个人绝对路径。P0 即核查双平台包来源和许可；P5 才做成品分发不意味着可以延后发现不可打包的依赖。

为研究范围、车辆/时域、下载/磁盘、单次查询、作业并发及进程树设置预算，以固定小场景和代表场景实测后冻结，不编造吞吐/时延数字。OSM 共享缓存只保存有来源/时间/哈希的原始数据；Run 输出独立。首版不自动下载大区域 PBF，缓存缺失不绕过资源预算。

当前 `runJob()` 限每 Session 2 个、Host 总计 4 个活动 Job，ProcessRunner 另限 4 个受管直接子进程；它们并未自动计数后端再启动的所有子孙进程。交通仿真首版每任务最多一个活动 Run，外层继续遵守既有限额，内层 MCP/SUMO 数量和内存需由交通服务校验，不能假定已有总进程/内存隔离。

## 9. 后续优化案例与首版保持什么关系

接驳车辆 VRP 保留为 P3 的首个候选生成器：单趟、非负任务量、完整站点访问、车辆容量和服务开始时刻的硬时间窗，目标为车队总路网旅行时间；不做成对乘客接送、拆单、多趟或静默弃单。

GIS/SUMO 网络经适配形成有向成本矩阵，记录车辆权限、单位、时间口径及不可达；OR-Tools 输出分配和访问顺序，再展开成合法 Edge 路径、停靠/服务与等待安排。实际服务事件进入完成率和违约统计，经过站点不能记为已服务。可借鉴 [OR-Tools VRP](https://developers.google.com/optimization/routing/vrp) 的接口，但具体模型与参数仍需验收。

方案在 SUMO 启动前准备为新变体/Run，禁止覆盖已启动仿真的已加载路由。求解状态区分有解、是否证明最优及终止原因；超时有解须验证，超时无解不等于证明不可行。它可以与已有运筹 Skill 组合，但网络、运行和比较不硬编码为 VRP 专属流程。

道路封闭、车道调整和信号干预也属于后续场景类型。拓扑变化需重新转网、映射与路径验证，不能借首版限速参数入口任意修改网络。滚动控制、强化学习、远程 Worker、公共 SDK 和大规模并行均等待具体需求。

## 10. 验证与本次决策边界

本次交付是方向与 PLAN 修订，不创建生产模块、不安装运行时、不启动 MCP 或仿真。证据分为“源码核查”“发布信息”“后续实际验证”，不能互相替代。

实施按关键真实路径验收：先固定输入和成功定义，复用已有测试入口，`npm run test:budget` 预检后将断言合并到既有场景，总注册节点不超过 40，不为每个工具新增一组隐藏测试。P0 走真实上游链，P1/P2 走真实 Pi + 生产装配/路由 + SUMO；fake 后端只验证必要故障，不替代闭环。按实际改动运行类型检查、核心/Web 或平台冒烟，纯文档修订不运行全量构建。

首版按少量纵向场景提供下列证据，不扩张为按工具排列的测试矩阵：

- 安装/装配/信任→包内 Contract→真实 Pi 注册→批准的 Host 操作→SUMO→结果→现有地图/工具卡，跑通一条固定样例；移走制作目录仍能使用独立包。
- 非法参数、错误接口版本、未装配/未授权、越界资源在执行前拒绝，未创建运行产物；查询旧操作仍核对 Owner，复制 JSONL 不获得旧操作权。
- 同操作复用原成果，参数或输入版本冲突拒绝；提交后丢响应和 Host 重启能核对原结果，提交前无法确认保持未知，不增加第二次 SUMO 派发。
- 取消贯穿 Pi signal→薄 Client→请求生命周期→Job→进程树，工具历史和 UI 区分取消请求、确认取消与未知；引用/呈现故障只重读原成果，不重新仿真。
- 交通工具三态诊断读取真实来源、active、Schema 与成功结果，保留六个核心模块既有工具的输出、诊断、恢复及打包行为；P2 通过 Document/Canvas 呈现报告，不新增仿真视图类型，双平台成品证据仍按 P5 单独记录。

固定模型响应可验证工具链，不能称为真实模型自主规划/制作；若声明 Agent 可独立安装或制作交通模块，还需沿 Tool PLAN 的相应真实任务验收，不从上述 smoke 推断。

| 本次方向决定 | P0 仍需拿到的证据 |
|---|---|
| 产品定位为交通实验与方案评估，首版批量对照 | 固定小场景、限速对象/单位、需求规模、时域、基线和比较指标 |
| AgentSUMO 执行层是优先候选，MCP 非硬依赖 | 源码与 wheel 内容、依赖与启动、私有 stdio 对比直接调用的必要修改和真实运行结果 |
| 复用升级后的 Pi/Host/Module 机制，保持少量领域工具 | 沿 CORE_TOOL_BINDINGS、逐工具契约/诊断增加交通绑定与结果解析，补独立源码/批准契约/包输出路径、环境替换、持久 Owner 和提交点，不重建多工具体系 |
| SQLite 管结果，Geo 管展示，先不用回放 | Run 独立导入、原始指标核对、查询体量、关闭采集或限制内存的实际机制 |
| OR-Tools、交互 Worker、回放按需后置 | 对应真实业务收益和独立验收条件，不再作为首版基础依赖 |

本次调整保留无头仿真、可安装 Module、网络映射、独立 Run、证据与双平台交付等约束；以当前六模块十二工具及 Canvas 分层为接入基线，补齐可选业务包静态路径、交通运行时/环境、持久确认和领域结果消费。P0 固定本地场景选路线，P1 跑通独立模块到地图的真实闭环，P2 完成双 Run/Document 报告后再接在线 OSM；长期 Worker、后台调度器、VRP 和回放仍后置。
