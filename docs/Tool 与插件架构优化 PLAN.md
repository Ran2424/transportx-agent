# Tool 与插件架构优化 PLAN

> 状态：P0 / P1 / P2 经 PR #75 / #76 / #77 验收合并；P3 真实恢复闭环通过，阶段 PR 待验收。2026-10-23 用户调整为优先完成完整可运行初版，后续聚焦关键真实路径，不扩展测试矩阵；未覆盖的发布边界单独记录。
> 日期：2026-10-22。基线：3.23.1 / `12d6d209db380f95396f3eafa174140c02375c78`；Pi `@earendil-works/pi-coding-agent@0.80.10`。  
> 最终执行规则：信任入口为 P0 硬门槛；区分 P1/P3 承诺；按兼容性规则升级；平台执行与真实 Agent 制作分别验收。执行证据见 [P0 记录](<Tool 与插件架构优化 P0 记录.md>)。  
> 当前架构权威：[ARCHITECTURE.md](ARCHITECTURE.md)。后续实现与本文有差异时，记录决策及验证依据，不用计划覆盖实现事实。

## 1. 核心决策与目标

Pi 继续作为唯一 Agent Runtime，负责模型循环、实际工具注册与激活、工具调用调度、Extension 事件和对话/Tool Result 历史。TransportX 负责 Module 装配、会话资源授权、领域操作、成果持久化和产品投影。

设计以 Module 交付领域 Capability 为中心。Pi Extension 是接入 Agent Runtime 的机制，不是 Module 的全部含义。区分三个概念，分别复用已有权威：

| 层次 | 定义与身份 | 权威及边界 |
|---|---|---|
| TransportX Capability | Module 提供的领域能力、依赖、资源与成果；试点直接复用所属 Module ID | Module System 负责交付、组合与版本，不另建 Capability Runtime/Registry |
| Pi Tool Interface | 模型可调用的接口：稳定 `toolId`、既有 `piName`、接口版本 | Tool Contract 声明预期接口；Pi 决定实际注册、激活与调度 |
| Execution Operation | 接口最终触发的领域动作；可由 Extension、Host 或双方执行 | 对应生产者负责执行与状态；Host Operation 是其中由 Host 受控执行的子集 |

一个 Capability 可以暴露多个 Pi Tool；一个 Tool 可以按已校验输入映射到多个 Operation；一个 Operation 也可以被多个接口复用。成果类型表示产出，不等于 Tool、Operation 或权限。初期不增加脱离 Module 的能力依赖求解器，也不强制每个 Module 只有一种能力或必须暴露 Tool。这是职责解释模型，不是所有工具必须实现的三层对象框架：简单 Pi-local 工具只需 Module 和 Pi 接口；只有出现不同授权、提交或恢复行为时，才明确拆分 Operation，不为对称性补对象、ID、策略或持久记录。

在此基础上推进三项改造：**Tool Contract** 只定义模型接口协议；**Binding** 关联 Capability、接口、生产者和状态归属，并区分装配预期与 Pi 运行观察；**Host Invocation** 仅为有需要的 Host Operation 提供调用关联和分级执行确认。执行策略是生产者实现的保障，不塞进接口身份。

成功标准是：一个独立交通模块能够被安装、装配、经 Pi 暴露接口并执行，结果及历史投影可核对；错误、取消和恢复有可验证的语义。无需统一所有工具的内部实现。

桌面用户添加自有工具是核心场景：用户提供脚本、程序或 API 资料及用途，由 Agent 完成适配、模块封装与校验，再通过现有桌面安装路径交付使用。用户不必学习 Manifest、Pi Extension 或架构分层；不为此新建万能工具框架、可视化制作器或公共 SDK。具体流程见第 7.3 节。

本方案综合两份输入意见：《TransportX Agent 与 Pi 的架构关系：重新审视 Tool 和插件系统》《transportx-agent：从 Tool Contract 到插件架构的系统性优化建议》。采纳后者关于领域契约、结果分层与会话绑定的方向；以前者对 Pi 权威、混合工具和生命周期的修正收敛实施范围。

明确不纳入本轮路线：第二套 Agent Loop/Tool Runtime、替代 Pi 的工具 Registry、改写 Pi 原生工具、统一 `/tools/execute` 网关、将全部 Extension 移入 Host、插件热重载、完整 Cordis 容器，以及另建一套对话日志或通用 Artifact 数据库。Replay 作为边界验收手段，不单独发展为新运行平台。

架构范围自本次评审后冻结，保留 P0–P4 顺序。新增抽象必须同时满足：已验证的真实执行问题、现有 Pi/Host/Module 无法清晰承担该职责、可独立重复的验收证据。P2 优先在现有组件中使用纯函数核对，不新增长期驻留的 Catalog/Binding/Capability 服务；不建设统一 Tool Execution Middleware、全局重试器、缓存插件或第二套执行队列。

## 2. 当前实现核查：已经具备什么，缺口在哪里

| 当前事实 | 实现依据 | 后续利用方式 |
|---|---|---|
| Module Manifest v2 声明入口、依赖、资产、Native Runtime 和 Canvas View，没有 tools 贡献项 | [module.ts](../src/contracts/module.ts)、[config.ts](../src/server/config.ts) | 先验证契约模型，再决定工具贡献的兼容扩展 |
| Registry 校验模块兼容性及缺失/禁用依赖，Assembly 按依赖顺序选择模块；Spatial 已依赖 Geo/Citation 并声明 `spatial.analysis-result` | [module-registry.ts](../src/server/module-registry.ts)、[Spatial Manifest](../modules/capabilities/spatial-analysis/manifest.json) | 沿用 Module 依赖，不从工具名称再推导一套能力依赖图 |
| Session Plan v3 解析模块、入口、资产及运行时；Pi 启动使用该计划，并可额外加载构建时项目 Extension | [session-assembly.ts](../src/server/session-assembly.ts)、[session-pi-launch.ts](../src/server/session-pi-launch.ts) | 复用装配和会话边界；区分 Module 与项目注入的来源 |
| Web Bridge 用 `getAllTools()` / `getActiveTools()` 发布名称、参数、sourceInfo 与 active；目前在 session_start、agent_start、模型/思考级别变化时采样 | [pi-web-bridge](../modules/capabilities/web-bridge/extensions/pi-web-bridge/index.ts) | 用实际注册结果核对声明，不能把采样推断为持续、原子的工具变更流 |
| Host 已校验 Bridge 格式、revision 与运行协议兼容性，尚未按自有工具契约逐项核对 | [session-capability-tracker.ts](../src/server/session-capability-tracker.ts)、[bridge.ts](../src/contracts/bridge.ts) | 扩展现有跟踪器，不新建平行发现通道 |
| 内部服务按会话、停止状态、计划中模块和对应 service token 授权 | [api-routes.ts](../src/server/api-routes.ts)、[session-service.ts](../src/server/session-service.ts) | 保留现有安全边界，再为确有差异的操作增加策略 |
| Host 在平台启动代码中创建领域 Service，内部路由及 service–Module 映射由平台代码固定；Manifest 无 Host 服务入口 | [server-main.ts](../src/server/server-main.ts)、[session-service.ts](../src/server/session-service.ts)、[module.ts](../src/contracts/module.ts) | 不把普通安装包的操作声明解释为可执行的 Host 插件 |
| Citation、Spatial、Canvas 各自实现 Host HTTP 客户端，未将 Pi execute 的 signal/toolCallId 贯穿请求；Geo 的 Host 请求已传 signal | [Citation](../modules/capabilities/citation/extensions/pi-citation/index.ts)、[Spatial](../modules/capabilities/spatial-analysis/extensions/pi-spatial-analysis/index.ts)、[Canvas](../modules/capabilities/canvas/extensions/pi-canvas/index.ts)、[Geo](../modules/capabilities/geo/extensions/pi-geo-visualization/index.ts) | 薄 Host Client 的直接试点；禁止笼统声称现有工具均支持端到端取消 |
| Geo Extension 维护 scene/revision，并从当前 Pi 分支恢复；Interaction 直接使用 Pi UI 和取消上下文 | Geo Extension；[Interaction](../modules/capabilities/interaction/extensions/pi-user-interaction/index.ts) | 保留原生 Extension 模式，作为抽象不能越界的检验样本 |
| Host 已有受管作业、并发上限、请求断开取消与进程树终止；作业表为内存状态 | [sessions.ts](../src/server/sessions.ts)、[process-runner.ts](../src/server/process-runner.ts) | 补跨边界确认与必要的持久执行状态，不重复实现已有作业调度 |
| Citation、Canvas、Geo、Spatial 已有领域结果协议和前端投影 | [contracts](../src/contracts)、[tool-projection.ts](../src/web/platform/conversation/tool-projection.ts) | 复用领域数据及现有 details，不再用通用 Envelope 重新定义领域实体 |
| 已有真实 Pi + 固定模型输出的 Citation/Canvas smoke，但使用简化 Host 路由；普通 Pi RPC smoke 主要验证 Task/Web Bridge 和消息队列 | [citation-smoke.mjs](../scripts/citation-smoke.mjs)、[pi-rpc-smoke.mjs](../scripts/pi-rpc-smoke.mjs) | 复用并升级为真实装配/路由/授权的边界验收，不能说当前没有真实工具集成测试 |

补充核查 Pi 0.80.10 的公开 Extension 类型：`execute(toolCallId, params, signal, onUpdate, ctx)`、`executionMode`、`tool_call` / `tool_result`、`session_start` / `session_tree` / `session_shutdown` 均已有定义。`tool_call` 的输入允许被前置 handler 修改，类型说明明确修改后不再自动校验。因此 Host 的最终请求校验必须保留，不能只依赖 Pi 注册时的 Schema。公开 API 的声明不是对卸载、事件先后或断开取消效果的运行时证明，后续用固定版本集成测试确认。

### 2.1 本轮局部源码核查与证据范围

当前工作树运行代码仍为上述基线。下表是架构修订时的实现与引用关系核查，当时未运行取消/崩溃故障注入、性能测量、漏洞扫描或全量测试；不是完整源码审计。后续已执行检查见 P0 记录。区分“源码确认”“设计风险”和“待运行验证”，未落地机制不能登记为现有缺陷。

| 核查点 | 源码确认的事实 | 尚需证明及处理 |
|---|---|---|
| Citation / Spatial / Canvas Client | 三者均自行读取环境、POST/JSON 解码；execute 忽略调用 ID，未接收 signal，fetch 未传取消；没有通信自动重试循环 | 取消链缺口已确认；错误、断开后的提交状态与可复用差异须由真实链路验证 |
| Spatial 提交 | `analyze()` 校验输出路径/大小/哈希/GeoJSON 后写 manifest；路由在其返回后独立登记 Citation，失败返回 warning | 无持久受理/operationId 保护；文件与 manifest 分步写入的崩溃窗口待故障注入，不能称为原子提交 |
| 校验前临时目录 | Spatial 在输入语义校验及主要 try/finally 之前创建输出/manifest 目录 | 非法输入可能遗留空目录；P1 同工具切片验证拒绝后的磁盘状态，再决定最小清理范围，不扩展为通用事务 |
| Job / 子进程 | `sessions.runJob()` 的 Map、job ID 和并发控制为内存态；ProcessRunner 已有 abort、超时、进程树终止及停止未确认错误 | 不能把内存 Job 当成重启后的提交事实；停止竞态和强杀后的资源状态待运行验证 |
| Tracker / 授权 | Tracker 已有 Bridge 解析、revision 拒收与运行协议诊断；`session-service.ts` 主要是服务名/Module/路由映射，实际会话鉴权在路由 | 复杂 Binding 状态系统尚未实现；持久 owner 不能直接从服务映射推导，须核实任务/会话归属和恢复路径 |
| Extension 信任 | Installer 校验包树/路径/运行时等；启动器将 Extension 加载到同一 Pi，并传递服务凭据；未见该链路的逐 Extension 隔离/自动代码信任审查 | 安装验证不证明代码可信；不声明具备不可信多租户隔离，见 ADR-T01 |
| Task 清理候选 | 默认内置清单无 Task，但真实 Pi smoke 直接加载它；历史解析和 fixture 仍使用 `pi-task-mode` / `tau-task` | 不能据“不在默认清单”删除整套 Task；区分可退役生产者、测试用途和持久格式读取，再单独决定 |

补充依据：[Spatial Service](../src/server/spatial-analysis-service.ts)、[ProcessRunner](../src/server/process-runner.ts)、[Module Installer](../src/server/module-installer.ts)、[Task 历史契约](../src/contracts/task.ts)、[Task 历史夹具](../test/fixtures/features/task-entries.json)。其余定位见上表已有实现链接。未发现证据的性能瓶颈、数据竞争或依赖漏洞保留为待核实项，不写成既成结论。

## 3. 底层模型：分别回答归属、执行与状态三个问题

工具分类用于说明职责，可以交叉。例如地图输入既是交互工具，也使用 Host 服务；不能用一个 `execution: host | local` 枚举代替完整边界。

| 范围/工具 | 实现与生命周期归属 | 实际执行边界 | 状态/资源事实来源 |
|---|---|---|---|
| Pi 原生 read / write / edit / bash | Pi | Pi 工具及其子进程 | Pi 历史、真实文件/进程；不纳入 TransportX 自有契约重写 |
| `tau_resolve_citation` | Citation Module + Pi 注册 | Host 校验来源、抓取网页和登记 | `.tau/citations.json`、原件/网页快照；Pi 保存使用记录 |
| `tau_spatial_analyze` | Spatial Module + Pi 注册 | Host + PythonRunner | 已校验输出与 execution manifest；可选引用失败不能回滚成功计算 |
| `canvas_present` / `canvas_inspect_context` | Canvas Module + Pi 注册 | Host 校验与构造；React 展示 | Pi 呈现工具结果、Host 显式 Context、客户端标签/阅读状态各守其边界 |
| `publish_geodata` / `present_visualization` | Geo Extension | Pi 侧发布资源、维护 scene/revision；Host 验证并服务资源 | Pi 当前分支及 Extension 恢复状态、资源 manifest；不是全部由 Host 写入 |
| `inspect_map_context` / `request_geo_input` / `capture_geo_screenshot` | Geo Module，混合交互 | Extension → Host → 工作台 → Host/Extension | Host Context/请求记录、任务截图及 Pi Tool Result |
| `tau_ask_user` | Interaction Extension + Pi | Pi UI / RPC 交互 | Pi 交互结果与当前 pending 状态；取消不等于授权 |
| 可安装 Video 与用户/项目 Extension | 对应包或项目 | 以实际实现为准 | 按已解析运行时、资源协议及注册证据核对，不能从核心目录推测可用性 |

基线配置内的 Extension 静态注册了上述 10 个 TransportX 工具；Web Bridge 自身不注册模型工具，Task 是留存的兼容源码，未进入当前内置装配清单。此数量只是源码盘点，当前运行时集合及 active 仍以 Pi 为准。

### 3.1 Capability–Tool–Operation 映射

下表中的稳定 Tool/Operation ID 是拟议关联标识，不是已发布字段或新增路由。Capability ID 直接沿用 Module ID，原有 `piName` 保持不变。

| Capability / 依赖 | Pi Tool Interface | Execution Operation 与状态归属 | 产出/消费 |
|---|---|---|---|
| `com.transportx.citation`；当前无模块依赖 | `citation.resolve` → `tau_resolve_citation` | 按输入分为 `citation.register-local`、`citation.capture-web`；均由 Host 校验、提交，网络与文件策略分别裁决 | 既有 SourceVersion/Evidence，`citation.set` |
| `com.transportx.spatial-analysis`；依赖 Geo、Citation | `spatial.analyze` → `tau_spatial_analyze` | Host `spatial.analyze`，再按 buffer/nearest/spatial_join 的业务语义校验；可选引用登记单独确认 | `spatial.analysis-result`、既有 Geo 数据/引用 |
| `com.transportx.geo`；依赖 Canvas | 五个接口：发布数据、呈现场景、读取上下文、地图输入、截图 | 资源发布与 scene/revision 属于 Extension；后三者跨 Host/工作台交互；分别声明 Operation，不能归为一个 Host 调用 | `geo.scene`、地图资源、交互结果、截图 |

P0 只形成试点映射草案，不要求全量 Operation 清单或公共类型。不复制 `dependencies` / `artifactTypes` 为另一份手工维护的 `requires` / `produces`：能力视图优先引用或投影现有声明。现有 Module 依赖是否必须装配，与一次执行后的可选后续动作是否成功是两件事；例如 Spatial 的 Citation 模块依赖仍遵守现有装配规则，登记 warning 不回滚计算。未来确需表达可选依赖时再明确降级路径与兼容性。

### 3.2 新工具的执行位置选择规则

先确定状态与生命周期归属，再确定执行位置；权限要求不能代替这一判断。

| 新操作的主要需要 | 首选位置 | 工程约束 |
|---|---|---|
| Pi Context、Session 事件、分支局部状态 | Extension-owned | 跟随 Pi 分支及事件恢复，不镜像一份 Host 状态 |
| 同步用户交互、Pi UI | Extension-owned；涉及工作台/资源时 Hybrid | 保留 Pi pending/取消机制；交互结果不自动构成授权 |
| 受控领域文件/数据库、Python/GIS 计算 | Host-backed | Extension 适配接口，Host 最终校验资源并执行 |
| 跨 Pi 进程恢复的持久作业 | Host-backed | Host 管理必要作业状态与提交；保障等级另按第 6 节选择 |
| 长期领域成果 | 通常由 Host 管理提交，允许 Extension 生成 | 明确实际生产者与授权资源协议；已有受控 Extension 发布方式可以保留 |
| 同时依赖 Pi 状态与 Host 资源 | Hybrid | 按步骤划定归属、提交点与信号传播，不让 Host 接管 Pi 生命周期 |
| 不涉及上述受控资源的简单本地计算 | 可留在 Extension | 不为一致形式增加 Host 往返或持久作业 |

Geo 的 scene/revision 是 Ownership Contract 的基准：当前分支及 Pi 历史决定恢复状态，Host 服务负责资源边界和交互服务。它不是等待 Host 化的遗留实现，不强制套用 Host Invocation。每个新工具在评审中给出状态所有者、恢复来源、执行步骤、最终校验位置和成果提交者；Hybrid 不能成为无法说明责任的统称。

### 3.3 权威与约束

| 问题 | 唯一权威 | 其他层允许做什么 |
|---|---|---|
| 预期提供哪些自有能力 | Module 声明/选择及能力到接口的 Binding | 引用 Tool Contract，装配、静态冲突检查与兼容诊断 |
| 实际注册/激活了哪些工具 | Pi Registry，经 Web Bridge 观测 | 显示、核对与标记观测时点；不能用声明覆盖观测 |
| 模型调用和调度 | Pi | 映射 Pi 支持的 executionMode；不增加模型工具调度器 |
| 某次 Host 操作能否执行 | Host 的可信会话、操作和资源策略 | Client 携带关联上下文；工具名称和调用 ID 不是授权凭据 |
| 对话与 Tool Result 历史 | Pi Session JSONL | Host/Kernel/React 读取投影，不复制一份会话历史 |
| 领域操作是否提交 | 对应生产者及持久结果/manifest | Host Invocation 记录关联与确认，前端不能凭 HTTP/模型文本推断提交 |

### 3.4 ADR-T01：本地 Extension 的信任边界

**决策：信任入口是 P0 硬性退出门槛；当前门禁落实状态见 P0 记录，未通过不能开始 P1。** 当前路线服务于本地用户主动信任代码的使用方式，不宣称支持不可信用户/插件共用执行环境的多租户托管部署。

- 允许进入现有 Pi 的代码必须是平台审查的实现，或本机用户明确接受按其操作系统权限执行的代码；“外部来源”和“不可信代码”不能简单等同。安装成功、包哈希、Module 授权、来源标签均不是代码审查证明。
- 未被明确接受信任的代码不得进入该执行路径。P0 检查目录/ZIP 安装、启用、会话装配及项目注入的信任决策入口；现有流程不足就先记录并补最小阻断/告知，不能把文档声明当成门禁已实现，也不能未经设计就让后台判断用户已信任。
- Pi 子进程及其中 Extension 共享当前本机执行权限和进程环境。Host 的会话/资源校验保护其服务入口；鉴权 Cookie、service token、任务目录检查不提供逐 Extension 的进程/文件系统隔离。
- 本路线不接收不可信代码并声称隔离执行，也不新增通用插件沙箱。若未来支持不可信扩展或多用户托管，须另立执行身份、进程/文件系统/网络/凭据隔离与验证方案；通过前不开放该部署承诺。可信 owner 是业务资源归属，不替代 OS 租户身份。

取舍：保留本地可安装 Extension，明确其代码信任成本；Host 操作授权与代码信任分开。P0 以实际入口证据记录落实状态，无法保证的入口不能标记为已具备隔离能力。

执行规则：

1. 生成包、安装、启用和执行是不同授权范围。“帮我封装”不自动授权安装或执行；已有明确授权可按其范围复用，也允许用户一次明确授权该具体包的安装、启用、样例测试与后续运行，不要求每步重复弹窗。
2. 确认前提供模块来源、将执行的脚本/本地程序、主要依赖、文件与网络访问需求及尚不明确的部分。用户无需审阅 TypeScript；这些说明不被宣传为进程权限限制。静态检查可以先完成；会运行代码的样例测试本身也需要在已授权范围内。
3. 用户接受信任的动作必须来自实际用户入口或已有可验证的用户授权，Agent 生成 `trusted:true`、安装请求中的布尔值、来源标签均不能自证。目录/ZIP 安装、启用、历史恢复、项目注入、Pi 全局/项目自动发现及 reload 均须核查，不能通过写入自动加载目录绕过门槛。
4. 平台随应用发布并在受控装配中确认来源的内置代码，可依既有平台信任执行，不逐次询问。普通包不能靠同名 ID 或声称 builtin 获得例外；已授权工具的正常重复调用不新增确认。更新或访问范围变化超出原授权时重新处理相应范围，不借此恢复整包内容哈希锁。
5. 否定验收必须证明：未授权代码未加载、未执行，而非仅 UI 显示警告；原始安装 API 和非 UI 加载路径也受检查。这里约束受支持的 Agent/平台工作流，不声称能阻止已获信任的任意本机代码绕过 OS 权限；若要求抵御此类代码，必须另行隔离设计。

## 4. Tool Contract 与 Binding：接口、关联和执行策略分开

### 4.1 最小契约面

先区分三类描述，不要求三个文件、三个 Registry 或三个独立版本体系；表中的策略/映射仅为确有需求的工具填写，不是所有插件的必填模板：

| 描述 | 必要信息/试点范围 | 版本与执行约束 |
|---|---|---|
| Interface Contract | `toolId`、`piName`、`contractVersion`，输入/输出、错误、模型说明、单位/跨字段语义及既有结果投影 | `contractVersion` 管理接口兼容；JSON 结构不变但单位/含义变化仍可能破坏兼容 |
| Binding Metadata | Capability/Module 版本、Extension 来源、Tool 到 Operation 的条件映射、状态所有权、成果关联 | 随 Module 与 Session Plan 绑定；Host 路由只能由平台可信映射确定，声明不是执行授权 |
| Execution Policy | Operation 的效果、并发、超时、取消、幂等、确认/恢复和资源访问要求 | 记录实现位置、能力与测试证据；默认无未经验证的保障，不为每个策略字段增加版本号 |

Tool Contract 限定为第一行。后二者可随包声明或引用，供装配和核对使用，但只在生产者实际执行并验证后才构成保障。空间服务新增幂等支持通常是实现能力提升，不自动升级模型接口主版本；若改变工具可观察的取消/结果语义，仍需评估接口兼容。Ownership Contract 记录在 Binding 中，包含第 3.2 节要求的归属与恢复信息。

继续使用 TypeBox 及现有契约解析方式，不引入另一套 Schema DSL。模型公开 Schema 与 Host 结构校验从同一权威定义获得；语义校验函数另行显式绑定，覆盖 Citation 互斥输入、Spatial operation 所需字段、资源引用等。模型侧若因 Provider 支持范围而简化 Schema，必须声明被弱化的约束，并以 Host 拒绝和边界测试补齐；不把“能发给模型”当作“完整表达所有语义”。

契约文件只承载可序列化定义，不携带 `execute`、UI 回调或需要 Host 动态执行的任意代码。第一方纯定义可以用 TS/TypeBox 编写，发布时产生可校验的静态描述；生成物只有一个编写来源。静态发现不得 import Extension 以触发注册或其他副作用。语义校验和业务执行继续在已装配的可信实现内绑定。

### 4.2 Catalog 与两阶段 Binding

Catalog 仅指按已选模块读取静态声明的索引；不先实现独立服务、通用目录 API、持久注册表或全模块迁移。初期用试点显式映射，只有真实使用者需要时才抽取公共目录。

装配期和运行期是两个核对时点，不是两个 Binding Manager 或需要同步的生命周期系统：

| 阶段 | 输入及可确认事实 | 不能推断的事实 |
|---|---|---|
| Assembly Binding：Pi 启动前 | 已选 Module/版本、既有依赖闭包、包内契约有效性、声明中可预见的工具名冲突、入口/资源/Runtime、平台/协议要求，以及平台明确支持的 Host Operation 绑定与已知服务前置条件 | Extension 实际注册/active、动态注入工具、运行后的连接/资源状况 |
| Runtime Binding：Pi 启动后 | Bridge 观测的实际注册、Schema、来源、active、revision，与装配预期和当前 Host 服务条件核对 | 未被观测的动态变更、所有重名覆盖、未来每次请求的资源授权和成功 |

Assembly Binding 扩展现有 Registry/Session Assembly，不执行 Extension 来发现声明。项目额外注入及无声明的合法 Extension 保留“工具集合未知”，不能伪造完整静态清单。Host 服务可用性只报告实际验证的条件；启动前不能确认的条件留待运行检查，服务存在也不代表请求已获授权。

Expected ≠ Registered ≠ Usable 是概念区分，不要求三份状态表。唯一数据来源保持为 Session Plan/Module 声明、Pi 当前观察及 Host 执行检查；产品按需生成只读诊断。首批仅保留三个用户可理解的结果，不发布五态公共类型或建立独立状态机：

| 只读诊断 | 证据要求 |
|---|---|
| 已确认可用 | 当前观察范围内，已声明且可检查的必要装配/运行条件均已确认；不是未来执行或资源授权保证 |
| 已确认不可用 | 有有效证据确认缺失工具/依赖、inactive、Host 条件不满足或协议不兼容；附具体原因 |
| 尚未验证 | 证据不足、来源不明、工具集合未知，或观察不能代表当前上下文 |

保留原始条件、原因码及必要的 Bridge revision/观察上下文即可。`inactive`、`schema_drift`、`name_conflict`、`missing_dependency` 等是原因，不建设独立迁移流程；指纹不等本身不证明接口不兼容。只有声明确实区分 Operation 时才给出动作级诊断，不能因为两种动作权限不同就把整个模块标记为失效。无契约的合法外部工具可继续由 Pi 执行；无法核对其保障不等于它被禁止。

初期不持久化可用性、不另建后台轮询/TTL 引擎，复用已有观察和产品读取时点。Bridge 是采样通道；Pi 进程/分支上下文变化或无法确认观察仍适用时，显示“尚未验证”，必要查询必须使用已验证的公开 API。只记录时间不能证明快照实时，也不需要每次调用前重复扫描全部工具。是否需要更多状态、缓存或变更通知，须有真实产品场景和测量依据再决定。

产品继续消费 `platform.getOverview()` 的服务端只读投影，React 不复制一套判定规则。“已确认可用”始终不能代替 Host 对具体文件、URL、数据库及 owner 的执行时裁决；平台不为展示状态主动试写或触发领域操作。

核对要求：

- 继续通过 Web Bridge 获取实际工具，保持既有 revision 检查；接受新 Envelope 后更新派生核对结果，UI 同时标识观察 revision/时点。
- `sourceInfo` 按 Pi 的公开结构和实际加载路径做归属核对。匿名、合成来源或路径无法验证时标记来源不明，不能只凭 `toolName` 认领第一方归属。
- 静态检查发现自有声明冲突；注册捕获测试检查同一 Extension 内重复注册。Pi 最终有效工具列表可能不保留被覆盖的定义，不能宣称单靠 `getAllTools()` 就检测了所有重复注册。
- 用户和项目的合法 Extension 可以没有 TransportX 契约。未知工具不自动视为非法，也不从 Registry 删除；与第一方工具重名时记录冲突证据。
- 当前没有已验证的工具变更专用通知。以现有生命周期采样和必要的公开查询建立观察点，实测 `setActiveTools` 后何时可见；不能虚构 `tools_changed` 事件或“每次调用都有原子快照”的保证。
- Bridge 的参数指纹表示 Pi 公开 Registry 的 Schema，不证明 Provider 转换后的最终 HTTP 请求相同。需要精确核对模型请求时，在可控 Provider HTTP 边界采集验证，不把 Bridge 当作完整请求日志。
- 默认只诊断声明漂移；安全/Host 协议不兼容在对应 Host 操作入口拒绝，缺失工具在产品中显示不可用。只有被证明无法安全启动的必要能力才引入会话级阻断及明确恢复路径，不能因一个可选工具异常终止全部会话。

装配期已经确认的必需依赖缺失或必需声明无效沿用装配失败/明确降级规则；上述“默认诊断”针对运行观察漂移，不撤销现有启动校验，也不承诺可选能力异常总能安全降级。

### 4.3 薄 Host Client

P1 先在 Spatial 原适配器中打通链路，不以共享 Client 或统一注册器为前提。P2 比较 Citation/Spatial 的真实用例，只抽稳定通信机制，再决定 Canvas/Geo 是否复用；Pi 注册辅助函数需额外重复证据，原生 `pi.registerTool()`、事件监听和定制 `onUpdate` 始终可用。

Host Client 只负责可信上下文传递、序列化/解码、signal/超时、HTTP/协议错误分类及必要调用关联。固定领域路由、输入/输出校验器和业务结果转换由对应适配器传入或绑定，不把 Citation 证据规则、Spatial 参数语义、Geo revision 或 Canvas 状态放进通信层。保留 `/api/internal/citations/resolve`、`/api/internal/spatial/analyze` 等领域 API，不建立通用执行网关。

上下文字段由 Client 从 Pi execute 和受信任启动环境组装；业务参数不得覆盖 session/token、契约身份或操作映射。Host 仍独立核对会话、service token、所选能力、输入与目标资源。收到 `toolCallId` 只用于关联；同一 Pi 进程中的可信 Extension 可访问环境凭据，不能把它包装成每个工具的独立沙箱。

Client 默认不重试有副作用请求。连接失败、HTTP 超时、Pi 取消、Host 拒绝和响应解码失败分开处理；请求发出后没有确认结果时先保留结果未知，不能统一改成“失败，可重试”。

## 5. 结果协议：领域值、模型内容与产品投影

规范的是三者之间的转换，而不是替换 Citation 3.0、Canvas 1.0 或 Geo 1.0 的数据模型：

| 层 | 内容 | 归属 |
|---|---|---|
| Canonical Result | 已校验的领域结果、实际资源 ID/版本/哈希和必要 warning | 对应 Host Service 或 Extension 生产者 |
| Model Presentation | 有界摘要、可纠正错误、下一步读取/查询指引 | 对应工具的纯投影；交给 Pi 回传模型 |
| Product Presentation | 现有 `details.kind`、Canvas Envelope、引用与成果投影 | 既有 contracts / Kernel / React Adapter |

先为 Host Client 统一成功、失败及 warning 的边界解析；是否在网络上传递公共 Envelope 由试点结果决定。已有领域端点可以由薄适配器归一化，不能为统一包装破坏旧 Tool Result 或历史重放。

领域结果只维护一份权威数据；模型摘要和 UI 从既有结果/资源引用轻量投影。Pi 已保存的 content/details 属于会话协议，不再建立对应的三份结果数据库或平行历史。首批不增加公共网络结果 Envelope；只有真实跨领域协议需求证明必要时再评估，不为接口外观重包现有协议。

Pi Tool Result 是 Pi 会话格式与 TransportX 产品协议的兼容边界。默认保留工具名、已有 `details.kind`、必要字段和领域 Envelope；统一生产规范、校验及摘要规则，不统一所有结果的物理结构。若确需改变 details，提供显式版本读取适配及旧会话 fixture，不能依靠重新执行工具修复历史。

每个工具迁移必须分别验证三条消费路径：

| 消费路径 | 必须保持的行为 |
|---|---|
| 当前执行 | 模型收到有界内容及正确错误语义；结构正确不等于 Pi 将其视为失败 |
| 历史会话重放 | 前版本 JSONL / Tool Result 的 details 可继续读取；无需重写历史或访问原执行中的瞬时状态 |
| 产品 UI | Citation、Canvas、Geo 和成果投影的 ID、定位、revision 及已有交互可用；新公共字段不是旧投影的必需输入 |

错误最少区分：输入无效、语义冲突、授权拒绝、资源失效、能力不可用、执行失败、取消请求/取消确认、结果未知、协议/呈现错误。结构字段包含稳定 code、phase、可读说明、可选字段位置与恢复指引；`canRetry` 若存在，必须由实际提交与幂等状态决定，不能仅从 HTTP 状态码推断。对模型使用 Pi 支持的错误通道，UI 从结构化信息投影；`ok:false` 文本若仍被 Pi 当作成功，不算完成集成。

结果已提交但摘要生成或响应校验失败时，保留提交事实和产物引用，反馈协议/呈现故障；禁止回滚已成功登记的 Evidence，或把成功分析当作从未执行而建议重试。Spatial 的 `citationWarning` 继续独立于计算成功状态。

大结果沿用任务文件、领域 manifest 和授权资源读取，模型获得摘要、数量、截断标记与回读入口。先按试点契约明确摘要上限并做断言；保持当前 Spatial 50,000 features / 100 MiB 输入输出约束及 Citation 既有限额，不把意见中的大数据示例当成已经支持的能力。大结果引用不自动标为交付成果，保留现有 `deliverable` 语义。

### 5.1 产品反馈的独立验收

以下是用户反馈与操作规则，不是新增公共状态 Enum；通过现有 Tool Card/消息、能力诊断及成果入口投影：

| 可观察事实 | 用户反馈与可用操作 |
|---|---|
| 尚未核验，或已确认 inactive/Host 暂不可用 | 分别说明“尚未验证”或具体不可用原因；不把未验证自动显示成故障，也不自动激活工具 |
| 已受理且仍运行 | 显示执行中；仅在链路支持时提供取消，点击后显示取消已请求而非已停止 |
| 取消尚未确认/响应丢失 | 显示结果未知及已知关联；有查询能力时查询，没有时说明需核验已有产物；不提供盲目重跑按钮 |
| 已确认失败或取消 | 说明是否有残留副作用；只有生产者确认未提交或已有可靠重复保护时才提供重新执行 |
| 已完成但结果读取/展示失败 | 保留完成状态与结果引用，提供重新读取/打开；展示重试不得重新发起领域计算 |
| 重新打开历史会话 | 从旧 Tool Result 及授权结果读取；不恢复虚假的运行中状态，不默认重启旧作业 |

测试区分领域重试、读取重试和用户主动的新执行，并覆盖延迟响应、会话切换后晚到结果、可理解文案及键盘可达操作。具体组件重构或性能问题需实际证据，不由此预设。

## 6. Host Invocation：确认领域执行事实

### 6.1 按 Operation 选择执行保障

保障等级根据业务效果、成本及恢复需求确定，不是权限/信任等级，也不是给整个 Tool 或 Module 统一贴标签。

| 等级 | 典型操作 | 所需保障及存储边界 |
|---|---|---|
| L1：查询/交互 | Canvas Context、部分地图读取/输入 | 最终请求校验、实际支持的取消传播和错误响应；不要求持久 Invocation。交互若引发写入，写入部分另判等级 |
| L2：普通持久变更 | Citation 登记、具有持久副作用的资源更新 | 明确提交点、天然幂等或重复保护、结果核验；优先复用领域对象/注册表，不默认增加作业或执行索引 |
| L3：长任务/高成本操作 | Spatial、耗时 GIS 计算 | 必要调用关联、Job 状态、持久提交确认、恢复查询及明确幂等策略；按需补最小 Invocation 索引 |

网页抓取的网络风险需要单独授权，不因属于 L2 就自动获得权限；若其成本或恢复要求达到 L3，应按具体 Operation 提升保障。Extension-owned 操作不被强制纳入这套 Host 记录机制。

Citation 先验证 SourceVersion/Evidence 的内容寻址、注册表写入、网页快照和多输入请求是否满足预期重复行为；相同 Evidence ID 不是整次请求天然幂等的证明。只有既有对象无法满足确认/重复保护时才增加必要记录。L1 不落持久执行记录，L2 不因字段整齐而获得持久 Job。

### 6.2 调用关联与授权分离

区分标识的含义，不建立一对一假设：

| 标识 | 含义及关联 |
|---|---|
| `toolCallId` | 一次 Pi 工具调用事件；可能触发零个或多个 Host 请求 |
| `invocationId` | Host 受理的一次执行；由 Host 创建，不必有独立 Job；L1 不要求持久化该标识 |
| `operationId` | 同一逻辑业务操作的重复保护标识；仅在需要时使用，可关联多次调用尝试；重复命中只关联原执行，不新建执行/Job |
| `jobId` | 实际计算作业；由既有作业管理创建，按实现关联 Invocation，不假定所有操作都有 Job 或固定基数 |

需要时关联 `toolCallId ↔ invocationId ↔ operationId / jobId ↔ 领域结果/manifest ↔ Evidence/资源 ID`。它们用于追踪不同事实，不能用 Pi 调用编号充当业务意图，也不把关联表变成第二套 Tool History。

四个名字用于区分语义，不要求每个插件生成四个 ID。能复用已有 Job/领域成果标识就复用；L1 不新增持久关联，L2 优先查领域对象，L3 才补缺失的索引。只有确需重复保护时才创建 operationId，不将其加入所有工具的必填模型参数或通用插件协议。

需要重复保护的操作在首次执行前，由可信适配/Host 流程创建并保存 operationId 与业务意图的关联，生成和持久化落点在 P0/P3 明确；重试必须引用该已有关联，不能临时生成一个新 ID 却宣称是在重试。模型在 unknown 后重新组合的相似参数不自动认定为同一业务操作；不能从参数相似性或任意模型提供的 ID 推断意图。Host 原子核对可信 owner、操作类型、规范化请求、接口语义与资源版本；原 ID 对应已提交结果时查询并返回原成果。

Host 按可信任务/持久会话归属及具体操作限定查询范围。同一 active Session ID 在恢复后可能变化，不能作为唯一持久 owner；新会话在首次受保护写入前也必须建立可信持久归属，不能回退到同目录所有会话共享权限。

`toolCallId`、客户端传来的 contractVersion 和工具名都是关联/核对输入，不授予权限。Host 由实际路由及可信服务映射确定操作，再结合 Session Plan 和资源策略裁决。初期只为确有差异的网络访问、产物写入和长计算增加操作级限制；能力声明必须落实到执行检查，未实现的声明只能标为描述，不能宣传为隔离保障。

权限模型为：**Manifest/契约表达需求，可信 Session 上下文保存授予范围，Host 在执行时最终裁决**。这里的资源/操作需求不是 Module `dependencies`，也不表示当前 Manifest 已存在 `requiredCapabilities` 字段。有效授权由 Host 的可信配置、会话选择和用户资源授权共同确定；安装一个模块不能直接扩大 Host 权限。同一路由若包含不同动作，例如 Citation 的本地文件登记与公网抓取，Host 应在校验输入后区分动作并执行对应策略，不能只按路由或模型传入的工具名授权。

此策略只约束 Host 提供的操作，不是整个 Agent 的强隔离沙箱。Pi 原生 bash/write 及可执行本地代码的可信 Extension 可能直接访问工作空间；包内静态声明和 service token 不提供进程隔离。未来若支持执行不可信代码，需另行设计信任等级、进程/文件系统隔离，本 PLAN 不声称已解决。

### 6.3 取消、超时与提交

实施全程遵守三条约束：请求取消不等于执行停止；未收到响应不等于领域失败；只有确认未提交或有可靠重复保护时才能安全重试。**P1 到 P3 之间同样禁止自动重试提交状态不确定的操作**，适配器错误、模型恢复指引和 UI 均遵守；查不到 Job 不能作为未提交证明。没有恢复查询能力时保留未知并核验领域产物，不用临时重算补齐结果。

| 观察/状态 | 可确认的事实 | 允许的恢复操作 |
|---|---|---|
| running | Host 已受理，尚无终态确认 | 查询；请求取消 |
| succeeded | 该操作必需的结果已校验并提交；可有独立 warning | 返回原结果及资源引用 |
| failed | Host 已确认失败，并说明是否留下部分副作用 | 按操作策略处理，不能一律重试 |
| cancelled | Host 已确认执行停止，并确认没有新的未决提交；残留已说明 | 按明确策略重新发起 |
| unknown | 调用方无法确认，或重启后发现未结算执行记录 | 查询/核验已有结果，不能当作自动重试理由 |

`unknown` 是不确定性的表达，不伪造为一个已确认终态；请求取消也不是 cancelled。核查链路必须覆盖 Pi signal → Client fetch → Host 请求生命周期 → runJob → ProcessRunner → 领域提交。已有 `runJob`/进程终止能力继续使用；正常响应关闭或晚到取消不得覆盖已提交成功。

上述状态用于表达执行事实；L1 无持久记录时也不能把断开后的副作用伪报为已取消，但不因此补建完整状态机。对 Spatial 等 L3 操作，先复用其 execution manifest，补最小持久 Invocation 索引。受保护写操作在执行前原子占用 owner + operationId，绑定规范化请求、接口语义/契约版本和相关资源版本；同 ID 同请求返回既有状态，同 ID 不同请求返回冲突，执行中不启动第二份作业。它不等同于现有 UI `clientCommandId` ACK 去重，也不能宣称跨崩溃 exactly-once。

Host 崩溃后，已保留的 running 记录必须经 manifest/结果核验才能转入明确终态；不能确认就保留 unknown。先发布产物、尚未来得及更新索引的窗口也要覆盖。自动重算只有在能够证明无提交或有专门幂等实现时才允许。

持久记录只服务于这些操作的结果查询与重复保护，不为每个 SourceVersion/Evidence 再新增一份 Receipt，也不记录模型对话正文。结果本身仍通过现有领域注册表和 manifest 读取。

每个试点明确自身提交点：Citation 的注册表写入、网页快照的暂存/保留、Spatial 的结果与 manifest 校验、可选引用登记分别说明。不增加跨领域事务协调器；失败只清理自己未提交的临时文件，不删除既有结果或其他调用的产物。

### 6.4 三层生命周期

- Module：安装、启用和依赖选择继续由 TransportX 管理。禁用影响新任务；已运行任务、恢复和卸载按现有 Session Plan/占用规则处理。
- Pi Extension：Pi 负责加载、注册、事件与 session 生命周期；先实测公开 hook 的行为，不自行构造 Extension 卸载容器。
- Host Resource：Host 负责受管作业取消、领域提交及授权读取。既有成果可读性取决于原资源协议、文件存在性和当前授权，不依赖工具的 active 标记，也不因 Module 禁用自动扩大读取范围。

先把高风险操作的提交与结果查询做实，再将其扩展到其他工具。Invocation 只记录必要领域执行事实和关联，Pi JSONL 仍是 Agent 历史；不得在日志、Binding 或结果中保存 service token/API Key。

## 7. 版本、插件贡献与恢复兼容

### 7.1 先确定交付和信任边界，再稳定 Manifest

对采用额外静态 Tool Contract 的模块，描述必须随包交付，Host 在不执行 Extension 的情况下独立读取；简单 Pi-local 模块可仅声明入口并用 Pi 接口，不以额外契约为统一安装前置条件。Host 受控操作、特殊授权或持久执行等治理需求出现后才补对应声明。源码可用不能作为发布通过依据；第一方定义及生成流程维持单一编写来源，路径按包根解析，禁止隐式依赖开发目录。

运行时 Host Client 初期作为精简实现随所需模块构建/打包，维护源码可以共用，但安装后的模块必须自包含；避免让用户额外安装一个尚未稳定的 `@transportx/tool-sdk`。只有多个独立插件安装验证了加载、版本与兼容行为后，才评估平台公开稳定 SDK；若改为平台提供 API，必须明确导出入口、版本协商及旧包支持，不能隐式解析平台私有代码。

独立 Pi-local Module 试点在 P1 启动：先用生产安装/装配路径和真实 Pi 证明可执行，不要求公共 SDK、全部 Binding 或最终贡献格式。P2 抽取通信机制时，从 Citation/Spatial 实际打包副本验证客户端和契约加载，并尽早验证 ZIP；Pi-local 包不为测试 SDK 引入无用依赖。P4 完成全部分发形式及插件生命周期验收，再稳定贡献格式。试点可用显式映射引用包内描述，不能绕过生产 Installer/Assembly/执行路径。通过代表性证据后再确定是否给 Manifest v2 加可选 `contributes.tools`，不立即切换 manifestVersion 3，也不让 Manifest 宣告“工具已经可用”。

贡献声明只引用包内契约身份、版本和静态描述路径；不内联另一份完整 Schema。Installer/Registry 校验路径、符号链接、描述格式、归属和重复声明；Session Assembly 将预期契约选择与模块绑定。只在同一可装配组合中禁止模型名冲突，不能把不同版本的同一工具作为全局安装冲突。

一致性检查覆盖 `Manifest → 包内 Contract → Extension 注册 → 已批准 Operation`。前两者、依赖及可信 Host 绑定可以静态检查；实际注册/Schema 用注册捕获与真实 Pi 验证。静态契约不是插件代码完整性或隔离证明。除早期独立包试点外，推广前还必须验证内置 asar/unpacked 与独立 Video 包，不以其中一种代替其他分发形式。

**当前路线不开放第三方任意 Host 服务代码。** 平台内置/经过平台代码评审的可信集成才可扩展 Host Operation 和路由；`origin`、自称“可信”、模块名称或安装成功都不构成授权。普通可安装 Extension 可提供 Pi-local 能力，或使用平台明确公开并批准绑定的既有 Host Operation。当前操作入口主要按固定 service–Module 映射授权，不能假定已支持任意外部模块委托；确有需求时先定义消费方身份、依赖、授予范围和 Host 校验，再开放绑定。不借用内置模块 ID/token，不接受包声明任意 Endpoint 自动执行，也不在 Host 动态 import 安装包代码。

允许用户安装并执行普通 Extension，仍意味着信任其 Pi 进程内本地代码行为；“没有 Host 服务扩展权”不等于“运行在沙箱”。外部模块试点首先采用 Pi-local 路径，避免为验收而新增 Host 插件机制；若试点使用 Host Operation，必须先有上述平台批准的绑定和授权。

### 7.2 计划与运行观察各保存什么

- Session Plan 仍是模块组合预期的权威；试点先引用既有 Module/版本/入口，仅在恢复确实需要时追加 Interface Contract/Binding 选择。执行证据不全部塞入计划，不保存可用性作为永久事实；扩展现有 v3 解析器保留旧读取路径。
- Pi 注册观察继续复用 Bridge。初期不另存可用性缓存、指纹数据库或诊断历史；实际需要缓存时再明确唯一来源和重建规则，缓存始终不授予权限或替代 Pi Registry。
- Schema 指纹区分接口字段与描述文案，规范化对象键；不能把原始 JSON 字符串字节相等当作语义兼容。跨字段约束版本和输出契约也参与兼容判断。
- 当前允许编辑 Module/Skill/Extension/Prompt 后恢复的规则保留，不借契约指纹恢复整包内容哈希锁。同版本指纹变化应诊断；Host wire 协议或安全约束不兼容时拒绝相应操作，并说明适配/升级方法。
- Module 版本、Tool Contract 版本、领域 Envelope 版本、Pi 版本分别管理。修改 Module 内容同步提升该模块版本；平台版本遵循当前未发布版本归集纪律。

接口兼容性包含字段、单位、跨字段约束与错误/结果含义。语义约束使用明确标识或随 contractVersion 管理，不能仅用 Schema 哈希。Execution Policy 随实现/Module 变化并记录验证证据，不为取消、超时、幂等等字段各自建立版本号；保障变化若改变接口可观察行为，仍按接口兼容规则处理。Binding 随 Module 版本和 Session Plan 记录，观察结果另行重建。

旧模块无工具贡献字段时走现有装配，标记“未声明契约”，不改写旧包。新字段若承载必须执行的安全/协议语义，必须设置能执行该语义的最低平台版本；旧 reader 丢弃字段不能等价于授予权限。遇到实际破坏兼容的协议变化再决定 schemaVersion 升级与显式迁移，不预先承诺所有新增字段都无条件兼容。

接口升级使用以下默认判定；Agent 修改用户工具时也必须应用，不能只按 Schema 哈希或代码行数决定版本：

| 改动 | 默认兼容判断与验证 |
|---|---|
| 描述、Prompt Guideline | 通常不破坏结构，检查模型选择/参数行为；不因此生成新工具名 |
| 增加可选字段 | 通常向后兼容；旧输入仍成功且缺省含义不变才成立 |
| 新增必填字段、删除/重命名字段 | 默认破坏兼容，除非保留并验证明确兼容读取路径 |
| 单位、坐标系、字段含义变化 | 即使 Schema 相同也按语义不兼容评估，禁止静默改变 |
| 缩小输入范围/收紧跨字段约束 | 原先有效输入会被拒绝时视为破坏兼容；错误修复需说明原承诺及迁移影响 |
| Result 现有必需字段/含义变化 | 按模型、历史和 UI 三条消费路径检查，原消费者失效即破坏兼容 |
| `details.kind` 变化 | 必须有旧历史读取/投影适配及 fixture，不重写旧 Pi JSONL |
| 仅增加 Host 内部监控/关联 | 通常不改接口版本；仍按所属实现/Module 的版本纪律发布 |
| 取消、重试、提交语义变化 | 单独评估可观察行为；保障增强不自动升级主版本，原有语义失效则需迁移 |

兼容新增按接口 minor、兼容修复按 patch、破坏性变化按 major 管理；Module 继续遵守自身版本规则，不要求与接口版本数字相同。`contractVersion` 不是 `piName` 后缀：保持 toolId/piName 稳定，确需并行不兼容接口时才新增名字并制定旧接口退役策略。更新前用旧包、旧输入及旧会话 fixture 验证；恢复不静默替换不兼容接口，Agent 不自动改写历史 JSONL。

### 7.3 桌面用户添加自有工具：由 Agent 完成封装

**用户提供业务信息，Agent 承担工具制作工作。** 典型请求是：“这是我的流量统计脚本，输入 CSV，输出各路段高峰小时流量，请把它做成以后能调用的工具。”也可以提供命令行用法、内部 API 文档或调用示例。仅需一次执行的临时脚本沿用任务工作流；用户明确需要复用/添加工具时再交付 Module。

用户需要提供已有资料、用途、可用的输入输出样例，以及运行依赖/访问条件中自己已知的信息。Agent 先检查这些资料，只有无法从中确定且影响实现的业务语义、依赖或授权才追问；模块 ID、目录布局、入口及适配代码由 Agent 按现有约定生成，不让用户填写架构表单。

1. **理解并选择最小封装**：以现有“模块制作”Skill 为起点。流程性知识用 Skill；需要模型可明确调用、带参数和结果的接口时写窄的 Pi Extension；已有脚本/程序作为包内实现或明确声明的外部依赖。默认可采用 Pi-local，不要求每个工具都有 Operation 对象、Host Client、四类 ID 或持久 Job。
2. **制作自包含交付物**：Agent 在工作目录生成 Manifest、必要 Extension/Skill、可分发的脚本及说明，并整理为可安装目录/ZIP。保留用户业务逻辑，只增加必要适配与校验；依赖未获分发许可的程序、内部服务或本机环境应通过配置引用，不复制进包或硬编码个人路径。
3. **检查运行条件与样例**：先完成不执行代码的入口、依赖与目标平台核查；样例测试涉及运行生成/外部代码时，按 ADR-T01 取得或核对已有授权后才运行。验证有效输入、关键错误及输出内容，缺依赖就说明并处理；不能以开发机可运行为通过，也不擅自修改应用内置运行时。API 凭据不写入包、Skill、样例或日志；没有受支持的凭据接入方式时明确指出缺口，不先设计通用配置中心。
4. **交付安装与新任务验证**：沿用现有桌面安装、启用及任务模块选择路径。Agent 完成当前权限和接口支持的步骤；若当前对话不能直接操作安装入口，交付已校验的包和最少安装操作，不把补代码/改清单留给用户。安装不等于已进入当前 Pi 进程，使用新建/按既有规则恢复的会话验证，不承诺热加载。
5. **确认真实可用并说明后续维护**：检查模块已装配、真实 Pi 已注册并能调用、结果进入历史且可阅读。区分已生成、已校验、已安装和已执行；未完成的环节如实报告。后续用户提供修改需求，由 Agent 更新包与模块版本，继续按现有安装/恢复规则验证，不要求平台发版来更新普通个人工具。

信任与授权沿用 ADR-T01：用户可明确接受自己工具的本机代码执行，无需逐个请求平台开发者审批；Agent 生成的代码同样需要检查，生成成功不是可信或可用证明。封装不能自动扩展 Host 权限、注册任意 Host 服务或加载自定义前端代码；需要这些能力时说明平台接入边界，不能把它们作为普通工具的必经步骤。

本场景优先完善既有制作 Skill、可复用示例与检查指引，让 Agent 能完成工作；只在多个真实封装案例出现相同缺口时补最小公共能力。当前章节是待实现/验证的交付要求，不表示已有完整自动封装与安装闭环。

## 8. 实施阶段与退出条件

测试贯穿各阶段，不集中到最后；每阶段先满足退出条件再扩大范围。

| 阶段 | 工作与交付 | 主要落点（拟） | 退出条件 |
|---|---|---|---|
| P0：权威与信任边界 | 试点归属草案、ADR-T01 的入口落实核查、owner/提交点定义、Pi API 行为和性能基线；明确 P1 的最小场景 | 现有启动/安装/装配、领域 Service、smoke 和决策记录 | Spatial 执行与授权归属无歧义；Geo 状态不迁移；不可信代码不以“已安装”获得信任；未知结果重试规则明确，不要求全量公共类型 |
| P1：Spatial 真实调用闭环 | 在原适配器打通真实 Pi→生产 Host 路由→Python/结果→Pi 历史与原 UI；贯穿取消/调用关联，检查输入拒绝与资源清理；并启动独立 Pi-local 包最小安装/执行试点 | Spatial Extension/Service、现有路由/Job、真实 Pi smoke；生产 Installer/Assembly | 单工具的授权/语义校验、错误/取消与三条结果消费通过；断开不伪报未提交，不自动重试未知结果；独立包能安装、装配并由真实 Pi 执行。不要求两个工具迁移、公共 Client 或完整 Binding |
| P2：最小公共机制 | 加入 Citation 第二用例后抽取稳定通信；单一接口定义加 Host 最终校验；在既有装配/Bridge 读取点生成必要三态诊断；验证两个模块的打包及外部包 ZIP | 两工具适配器/包内定义、薄通信实现、Registry/Assembly、Bridge/overview 投影 | 无双份 Schema 权威，领域逻辑未搬入通信层；已确认可用/不可用/未验证有证据；两类包实际加载/运行通过；没有独立可用性存储或自动激活 |
| P3：按风险补执行保障 | Spatial L3 打通 invocation/job/manifest、可信 operationId、提交确认、查询与恢复；Citation L2 先核实既有对象的重复行为；L1 保持无持久执行记录 | 现有路由、Job/领域 Service；Spatial 最小 Invocation 存储 | 超时/取消/重复/崩溃不会导致盲重算或重复提交；相似新参数不被误认为重试；成功后引用失败仍为 warning；无全工具持久 Job |
| P4：外部模块与贡献格式 | 完成独立包的 Binding/投影/禁用/恢复全链路与 asar/unpacked、Video 分发验证，再稳定最小贡献声明和作者规范 | Module 契约/Installer/Registry、构建与作者文档、现有投影/兼容测试 | 独立安装、执行、历史读取和禁用/恢复通过；无源码路径依赖；有证据才公开共性 API，不默认发布 SDK 或开放任意 Host 代码 |

P0–P3 的首要成果分别为信任/Owner 决策与 Pi 基线、单工具闭环、两个用例的最小共性、Spatial 持久确认；均为下一阶段门槛。P4 的外部模块全生命周期、真实 Agent 制作、打包和历史兼容是正式声明对应产品能力前的发布门槛。性能基线、硬件、样本和允许退化范围随对应 PR 提交，不到全部阶段结束后补做。

Spatial 的阶段承诺固定如下，P1 退出必须在 Pi Tool Result 与 UI 表达未知结果，不诱导直接重算：

| 能力 | P1 | P3 |
|---|---|---|
| 真实 Pi→Host、最终校验、Pi signal 传播 | 必须实现并验证 | 保持回归 |
| 区分超时、确认失败、取消请求和结果未知 | 必须；运行期间 Job 关联按需 | 保持并补持久确认 |
| 跨 Host 重启的执行查询/崩溃后重复保护 | 不承诺，不以已有结果文件冒充完整恢复 | 必须故障注入验证 |
| 持久 operationId | 不要求 | 对需重复保护的 Spatial 操作实现并验证 |
| 自动重试有副作用操作 | 禁止 | 仅在证明未提交或可靠幂等时允许，不因有 ID 就开启 |

P0 必须固定持久 Owner 的现有标识、建立/认证者、恢复验证、分支/复制/新任务规则与旧执行查询权限，记录在 P0 交付中；P3 不得临时选用 active sessionId、cwd 或 Citation ID 代替该决策。新会话在可靠持久归属可确认前，不接受需持久重复保护的执行。

首批迁移固定为 **Spatial 的一次真实 Pi 调用 → 现有 Host 路由 → 领域校验/Python/结果 → 原有 Pi 历史与 UI**，优先覆盖取消和断开窗口。先用原适配器完成切片，P2 出现第二个已验证用例再抽共性；不把 SDK、Catalog、通用注册器或持久执行索引设为 P1 前置条件。

独立插件是贯穿各阶段的试点：P1 最小安装/装配/执行，P2 包分发与必要诊断，P4 全生命周期验收。P1 不要求它同步完成所有 UI/恢复/Binding 规则，P4 也不能才第一次安装。P1 至 P3 一直执行第 6.3 节禁止盲重试的过渡规则。

独立试点同时承接第 7.3 节的用户故事：P1 从用户提供的简单脚本/样例出发，由 Agent 制作包并跑通最小安装与调用；P2 验证依赖/分发及错误反馈；P4 补更新、禁用和历史恢复。此要求替换同一试点的输入方式，不额外启动一套工具制作框架项目。

每个阶段独立分支/PR，描述最终行为和证据。迁移一个工具即删除该工具由本次改造造成的重复定义/旧客户端，不新增永久双轨实现。第一方各模块独立提升版本并记 CHANGELOG；不因只修改本 PLAN 提升 Module 或平台版本。

## 9. 验收矩阵与测试预算

### 9.1 两类基础验收

**Tool Contract Conformance**：脱离真实模型，校验声明、实际注册捕获、输入/语义/输出、错误、权限与结果投影。实际注册捕获可以通过最小 ExtensionAPI 测试替身获得，但不代表 Pi 加载或真实 Host 授权已经通过。

**Pi Boundary Integration**：真实 Pi + 生产装配/Host 路由/领域服务，仅控制模型 HTTP 输出及必要外部网络/时钟。核对模型看到的参数/工具结果、Pi JSONL、真实文件与注册表；复用 citation-smoke 和 pi-rpc-smoke 的基础，不复制 DeepSeek 的 Session 格式。fake Pi 浏览器冒烟继续覆盖 UI，不能代替此层。

另行区分平台执行能力和 Agent 制作能力：前者用真实 Pi + 固定模型调用 + 生产安装/装配稳定回归，可进入 CI；后者必须让真实模型自行理解任务、选择 Skill、封装、处理依赖、测试并交付，不用固定模型输出或手工预制包替代。P1 先做标准脚本，正式宣称自主制作能力前完成下列三个真实模型用例并保存输入、生成包、测试结果、授权范围及限制（去除凭据）：

| 真实 Agent 制作用例 | 通过条件 |
|---|---|
| 标准 CSV 统计脚本 | 根据用途/样例生成可安装包，经授权完成真实调用，输出与期望一致 |
| 缺少 Python 依赖 | 识别并说明缺失条件，不擅改内置运行时、不把未运行报为成功 |
| 私有 API 凭据 | 不把密钥写入包/日志，不私取 Host 权限；缺少合法配置/授权时明确未完成范围 |

真实模型验收不全部加入每日 CI；固定生成后的包可以回归平台能力，但不能据此更新“自主制作已通过”的结论。

| 必测场景 | 可观察的通过标准 | 合并位置/入口 |
|---|---|---|
| Capability–Tool–Operation 及执行位置 | 一个 Capability 的多个工具、一个工具的多个动作可分别绑定；Geo 状态留在 Extension；Host 动作不能由模型任意指定 | module-system、contracts、注册捕获及真实 Pi |
| Citation 混传 sources/webUrls、URL 填文件 path、空输入 | 结构/语义错误可识别，分次正确请求可成功；拒绝不产生错误 Evidence | citation-service、http-routes、真实 Pi 边界脚本 |
| Spatial 各 operation 缺字段、CRS/资源越界 | 公开投影与 Host 规则一致，副作用前拒绝，保留已有安全检查 | contracts、spatial-analysis、http-routes |
| 输出值违约或模型摘要/UI 投影失败 | 不伪报成功，不删除已提交产物，不错误指导重试 | 两试点 Service 和 Pi 边界脚本 |
| 装配依赖/契约/静态冲突、Host 条件缺失 | 启动前只检查可证明部分；动态工具未知；声明不能开放 Host Endpoint 或越权 | module-system、module-installer、http-routes |
| 所选工具缺失、inactive、被重名覆盖、Schema/语义漂移 | 三类只读诊断与原因可解释；已注册不等于可用；原生/无契约工具仍正常；不维护第二份注册表 | module-system、session-capability-tracker、注册捕获 |
| Bridge revision 回退、切换分支/模型、延迟到达 | 使用当前观察代次，旧快照不覆盖新值；恢复后重新核对 | session-capability-tracker、现有 Kernel/Web 回归 |
| tool_call handler 修改输入后进入 Host | Host 最终校验拒绝不合法输入；Pi 初次校验不能代替此断言 | 真实 Pi + 真实路由 |
| Pi 取消/请求断开/正常关闭/计算终止 | 取消传播可见；确认停止后才能 cancelled；正常响应关闭不反写成功状态 | session-boundaries、http-routes、真实 Pi 边界脚本 |
| L1/L2/L3 及重复行为 | L1 无持久 Invocation；L2 验证领域对象/提交而非仅比较 ID；L3 持久确认与恢复通过 | citation-service、spatial-analysis、http-routes |
| operationId 重复、不同请求冒用、跨会话查询、相似新参数 | 可信关联的同一操作不启动第二个作业；请求/资源版本不匹配冲突；跨 owner 拒绝；不凭相似性合并业务意图 | http-routes、session-boundaries、领域执行断言；不借用 UI ACK 去重表 |
| 提交前、提交后响应丢失、Host 强杀与恢复 | 可查询真实提交；未知不自动重跑；既有产物字节及 ID 保持 | desktop-launch、领域执行与边界脚本 |
| Geo scene 修订/分支恢复、地图输入、截图 | Extension 状态所有权未迁移，原有 Geo/Canvas 行为与取消终态保持 | geo-interaction-runtime、geo-contract、test:web |
| 用户交互取消/拒绝/无 UI | 仍由 Pi 交互机制处理，不将取消解释为授权 | interaction-extension、test:web |
| 旧计划、旧注册表、无工具贡献旧模块、模块禁用后恢复 | 沿既有兼容/授权规则读取；不恢复内容哈希锁；不丢历史引用 | module-system、module-installer、citation-utils、http-routes |
| 当前调用、历史 Tool Result、产品 UI | 模型内容/错误正确；旧 details.kind/结构可读；Citation、Canvas、Geo 投影均保持，不重写旧 JSONL | 领域协议、tool-projection、真实 Pi 与 test:web |
| 结果未知/已完成但展示失败 | 未验证不被误报为失败；取消不伪报停止；查询/读取重试不触发领域重算；晚到响应不污染另一个会话 | 原 Tool Card/overview/成果投影、真实结果 + test:web |
| 本地/ZIP/内置包/独立 Video 包 | 可在无仓库源码路径的安装环境加载客户端与契约，拒绝包内逃逸路径 | module-installer、desktop-runtime、目标平台打包冒烟 |
| 独立交通模块完整生命周期 | 静态声明、安装装配、真实 Pi 注册/执行、Bridge、Binding、历史/UI、禁用新会话及旧会话恢复均有证据 | 第 9.2 节纵向 smoke，复用现有 suite 的安装/恢复断言 |
| 桌面用户提供自有工具资料，由 Agent 封装 | 用户无需编辑 Manifest/Extension；Agent 生成包、核查依赖与样例，经现有安装/装配进入真实 Pi；缺信息/缺依赖可解释，凭据不入包 | 第 7.3、9.2 节同一独立模块试点及制作流程记录 |

矩阵中的简称指向现有 `test/suites/*.test.ts`。这些是场景内的直接断言，不生成新的测试注册回调层；不循环/条件注册，不添加子测试或 skip/todo。Node 实际节点保持不超过 40，先运行 `npm run test:budget`。真实 Pi 与发布包等额外场景沿已有独立 smoke 入口运行，报告实际执行范围；固定模型输出只证明连接与执行语义，不证明真实模型会自主选择正确工具。

每阶段至少运行对应类型检查和核心回归；改变契约/服务端时运行 `npm run typecheck`、`npm test`，涉及产品呈现再运行 `npm run test:web`。Pi Binding 阶段必须运行真实 Pi smoke，打包共享客户端或契约路径变化时运行目标 OS 的安装包检查；无目标平台证据就记录未验收，不能以本机源码通过代替。Python 执行遵循项目环境约定，不将个人解释器绝对路径写入发布代码。

### 9.2 独立交通模块纵向验收（P1 启动，P4 完成）

制作不依赖仓库私有路径的最小交通 Module fixture，例如对显式传入的交通计数计算汇总；它在 Pi-local 执行，静态描述与所需运行代码都在包内。不引入真实用户数据或新 Host 服务。P1 使用最小试点映射；随后接入实际需要的诊断，P4 验证完整链路。测试可控制模型输出，但不可用 fake Pi 替代真实注册与执行。

该试点至少有一次从“用户脚本 + 用途 + 输入输出样例”开始的真实 Agent 封装记录。优先选只依赖目标 Python 运行时已有库的简单统计脚本，核对 Agent 生成的 Manifest、适配代码及样例结果后，再沿下述安装/执行链验证。生成后的固定包可作为回归 fixture；手工预制包或固定模型调用的 smoke 只能证明安装/执行，不能单独证明 Agent 已能完成制作流程。用缺依赖或不完整业务说明的输入检查 Agent 能识别问题，不伪报封装完成。

1. 在无仓库模块路径的隔离测试数据根中，经生产目录/ZIP 安装路径安装；Manifest 与包内 Contract 可静态验证，检查时不执行 Extension。
2. 用生产 Session Assembly 选择模块及依赖，保存预期绑定；不直接手工向 Pi 注入测试入口来跳过装配。
3. 真实 Pi 加载 Extension，执行注册；核对工具名、Schema、来源及 active。
4. Web Bridge 观察实际工具；运行核对与包内声明、装配来源匹配，未确认条件显示“尚未验证”。
5. 通过受控模型响应触发真实工具调用，检查 Extension 的计算结果；Pi-local 不被要求创建 Host Invocation。
6. Tool Result 进入 Pi JSONL，并经生产投影路径在工作台展示；前端交互断言可以分段执行，但必须消费该次真实结果，而不是重造同形 fake 结果。
7. 禁用模块后，新 Session 不再装配；运行中会话、占用/卸载及旧计划恢复沿现有规则逐项验证，保存的结果仍可按协议读取。禁止以“禁用”默认抹掉历史或在恢复时偷偷替换新版本。
8. 断开仓库源码路径、仅保留安装包和平台运行环境重复加载。P1 至少完成安装、装配、实际执行及最小包加载；P2 验证 ZIP/两种客户端包和必要诊断；P4 退出补齐上述投影、禁用、恢复等全部证据。

若后续以 Host-backed 外部包复验，先由平台提供明确批准的 Operation 绑定及消费方授权，再验拒绝与成功路径；包自报 Endpoint、内置身份或权限需求均不得获得执行权。该复验不作为引入任意第三方 Host 代码的理由。

### 9.3 性能与资源验收：先测量，再设预算

目前没有本轮性能测量结果，不声称 Binding、HTTP 或结果投影已造成瓶颈。P0 在基线提交上确定可复现数据与运行环境，P1 同条件测量单工具闭环；公共抽象在 P2 加入前后做对照。优先复用 smoke/浏览器测量入口，不先建设追踪平台或给每个函数打点。

| 指标 | 测量边界与样本 | 验收依据 |
|---|---|---|
| 会话启动/工具核对 | 冷/热启动分别记录：装配开始→Pi ready→首次有效 Bridge；记录模块/工具数量与核对耗时 | 与未加机制的同环境基线对照；没有每次调用全表扫描或隐含后台轮询 |
| 调用额外延迟 | 固定模型响应，分段记录适配器编码、Host 往返、领域执行及结果投影；只读小请求与 Spatial 分开 | 区分通信开销和计算/模型耗时，报告端到端与各阶段分布 |
| 大结果内存/传输 | 小样本、代表性样本及既有限额内边界样本；记录 Node/Python/工作台各自峰值 RSS、HTTP/WS 字节和模型摘要大小 | 公开记录实际数据规模；摘要有契约上限，完整 GeoJSON 不因通用包装重复进入模型/历史/网络 |
| 恢复/确认耗时 | P3 注入提交前、提交后响应丢失、Host 强杀，记录重启→核验→可查询结果的时间 | 结果 ID/哈希一致、无重复计算；不能确认时保持未知，不用“恢复很快”代替正确性 |
| UI 与清理 | 真实结果的首个可用展示时间；重复调用/取消/会话切换后检查 active Job/子进程、监听器、临时文件及内存趋势 | 已确认退出的资源回到基线；停止未确认单独报告，不能隐藏为清理成功；大结果不要求整体进 React 状态 |

每份记录包含提交、OS/架构、运行时版本、数据量、冷/热状态、并发、样本数及原始摘要；条件可比时报告中位数/尾延迟，样本不足不宣称稳定 p95。不混用不同机器/数据作为退化证据，凭据和原始敏感输入不进入性能日志。

数值预算在 P0 基线之后、对应改造之前明确：延迟/启动用绝对上限与允许增量，内存/传输用数据规模对应上限，恢复用确认耗时与一致性要求。不能在没有测量时填造毫秒或百分比，也不能只写“无明显退化”。预算、样本和例外理由作为阶段评审交付；缺少数据时标记未验收，不先宣称性能通过。后续只在测得退化或产品需要时增加缓存/采样优化。

### 9.4 发布与回退

每次迁移保留一份前版本会话/模块/结果 fixture，验证新读取与恢复策略。部署回退要分别检查代码、契约、Manifest/Session Plan 及 Invocation 数据格式；只允许能读取现有数据的旧版本接管，不删除新字段/记录来伪造兼容。对尚未稳定的派生 Binding 缓存可重建，对已提交 Invocation/领域结果不可丢弃。正式发布前更新 ARCHITECTURE 与作者文档，描述已经实现的保障；本 PLAN 中未完成的字段与策略仍标为计划。

## 10. 需要在试点中形成证据的决策

| 问题 | 本 PLAN 的默认选择 | 改变选择所需证据 |
|---|---|---|
| 是否需要通用注册包装器 | 先共用契约/Host Client；原生注册可直接绑定 | 两个试点确有一致重复，且 Geo/交互无需迁移状态或丢失 Pi API 能力 |
| 是否引入独立 Capability 身份/求解器 | 试点复用 Module ID/依赖，Tool 与 Operation 单独关联 | 真实模块组合证明复用 Module 表达不了能力边界，且有迁移成本与单一权威方案 |
| 是否增加更多可用性状态/缓存 | 先三个只读诊断，复用现有来源与观察；证据不足显示尚未验证 | 真实产品行为需要额外区分，且测量证明按需计算不足；不能只因分类整齐而增加存储与同步 |
| 是否升级 Manifest/Session Plan 主版本 | 先验证最小声明；优先评估可选扩展与最低平台版本 | 旧 reader 会错误解释必须执行的语义，且可选扩展不能安全表达 |
| 是否在启动时阻断契约漂移 | 默认诊断，Host 操作边界拒绝不兼容请求 | 必要能力无安全降级，且启动握手时序及可恢复错误已通过真实 Pi 测试 |
| 是否所有 Host 操作都需要持久 Job | 按 L1/L2/L3 选择，Spatial 先验证最小索引 | 具体操作确有无法用领域对象解决的恢复/重复保护需求；不能只因字段统一就升级机制 |
| 是否发布公共 SDK / 开放 Host 插件 | 先随模块打包精简客户端；Host 仅平台批准的实现/绑定 | 多个独立包有稳定兼容证据；任意 Host 插件须另行完成信任与隔离设计，不隐含在工具贡献字段中 |
| 是否重构所有历史协议/日志 | 沿用 Pi JSONL 与现有领域协议，补稳定关联 | 明确的历史无法恢复问题及可回滚迁移方案，而非接口整齐度 |
| 是否删除 Task 等兼容源码 | 不纳入本轮运行时改造；先区分生产者、smoke 调用及历史读取 | 引用搜索、发布承诺与旧会话验证证明可退役的具体范围；不因默认未装配就删除持久读取 |

第一项实施工作是完成 P0 的信任入口、owner/提交点及 Pi 行为核查，并确定 Spatial 单工具闭环的测试与测量数据。公共类型、状态、映射或持久记录只有在存在真实问题、唯一权威和可验证用例时才进入实现。若草案必须接管 Pi 调度、搬迁 Geo 状态、复制会话历史或新增平行权限系统才能成立，应缩小范围。

## 参考

- 当前架构与持久化约束：[ARCHITECTURE.md](ARCHITECTURE.md)、[引用依据模块升级 PLAN](<引用依据模块升级 PLAN.md>)。
- DeepSeek Harness 的边界与工具机制参考固定在 `687f282e8625c6b8d11ff58211a90524be2e4317`：[架构](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md)、[工具契约](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/tools.md)、[测试策略](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/testing.md)。仅借鉴设计与验收方法，不引入其插件容器、会话格式或执行循环。
