# Agent 主动启用工具与动态加载 PLAN

> 状态：v3 Module-Centric 已完成 P0–P3 源码改造与本机验收；实际证据见 [Module 工具按需启用验收](<Module 工具按需启用验收.md>)。目标平台安装包与其他 Provider 验收不在本机通过结论内。
> 日期：2026-10-23；平台：3.23.2（未发布）；源码基线：`e4b65467726b336a08e952809e62f9096e004ddb`；Pi：`@earendil-works/pi-coding-agent@0.80.10`。实施前重新核对分支及版本。
> 输入：用户提供的 Module-Centric v3 评审意见及此前两版材料。本文原地替代 v2 的领域/工具组设计，保留同一实施入口；不另存多份有效 PLAN。
> 架构权威：[ARCHITECTURE.md](ARCHITECTURE.md)。相关计划：[Tool 与插件架构优化 PLAN](<Tool 与插件架构优化 PLAN.md>)、[交通仿真 PLAN](<交通仿真与优化能力升级 PLAN.md>)。本文阶段编号独立。

## 1. 决定：以 Module 为唯一开放单位

保留两个能力实体：**Module 和 Tool**。Module 是现有安装、版本、依赖、Skill、Extension 和资源的组织单元；Tool 仍由 Pi 注册和执行。无需在二者之间增加 CapabilityDomain、CapabilityGroup、Group ID 或独立 Capability Registry。

新会话首次模型请求只开放 **`read`、`write`、`edit`、`bash` 和 `manage_capabilities`**。专业工具随已装配 Extension 注册到 Pi，默认 inactive；Agent 根据任务使用 `enable(moduleId)` 开放该模块全部核对合格的工具，再调用原工具。

常驻管理工具保留四动作：`discover / inspect / enable / status`。discover、inspect、status 三个只读动作不改变 active；只有 enable 开放工具。已知 Module ID 可直接启用，不强制先搜索或查看。

本轮不做单工具启用，不做组关系或工具依赖闭包，不添加复杂分页/搜索框架、通用业务执行网关或第二套 Runtime。模型输入里的自然语言“领域”只是检索用词，不成为新实体；既有 `Module.type: domain` 继续表示 Workbench/CLI 等任务入口类型。

适用范围为 TransportX 受管 Workbench 会话和已核验 Session Plan 内的可信 Extension。代码导入仍在启动装配时完成；本设计的“动态加载”指工具定义按需对模型开放，不能解释为任意 Extension 热插拔或权限沙箱。

### 1.1 Tool 注册时机与动态启用边界

TransportX 采用 **Eager Registration + Lazy Activation（预注册、按需激活）**。

1. 当前 Session Plan 内的 Extension 在 Pi 初始化阶段完成 Tool 注册，注册后的工具构成当前运行实例的工具集合。
2. `manage_capabilities` 只负责发现、查看和启用已注册工具，不负责运行期间注册新 Tool。
3. 新 Module 的安装、启用或更新不影响已运行会话；需要在新会话中重新装配。
4. 首版不支持工具运行时晚注册，不建立动态注册事件监听、自动重注册或热加载框架。
5. Extension reload 后重新核对当前 Session Plan、Tool Registry 和有效分支的启用记录，再恢复 active 集合。
6. 首次模型请求及 reload 后的第一次模型请求，必须检查实际 Provider 请求中的工具集合，而不仅是 Pi 状态快照。
7. 第三方 Extension 必须在初始化期间注册完整工具集合；不符合约定的模块明确诊断为不兼容，不保证动态激活行为。

**架构不变量：在一个完成初始化的会话运行阶段，受管 Module 的工具成员集合保持不变；只有 active 集合随 Agent 决策变化。**

本轮不修改 Pi Runtime，不增加通用 Registry 监听器，也不为尚未支持的晚注册场景建立复杂校正机制。

## 2. 用户路径与五工具边界

用户只需说“展示 GeoJSON”“给道路做缓冲区”“引用这份报告”“运行仿真”。Agent 查找当前模块、必要时读取 Skill，再开启对应模块并完成业务；用户不用记住工具名或编辑底层配置，也不需要确认每次 Schema 开放。

| 初始工具 | 职责 |
|---|---|
| `read` | 读取文件、Skill 和已有成果 |
| `write` | 创建文件 |
| `edit` | 精确修改文件 |
| `bash` | 保留原生命令执行及现有解释器规则 |
| `manage_capabilities` | 发现/查看本会话模块、开放其工具、查询当前状态 |

“五工具”仅约束没有启用记录的新会话首个模型请求。同一分支内启用后工具逐步增加；恢复已有启用记录时可多于五个，不为满足数量指标破坏工作流。

启用不等于执行：不启动 Python/SUMO/ffmpeg，不安装依赖，不自动读取 Skill，不登记引用，不查询或重跑分析。Host 仍在具体操作时判断资源、输入、归属、授权和提交。

## 3. 现有事实与唯一权威

| 事实 | 权威及本轮用途 |
|---|---|
| 安装、模块版本和依赖 | 现有 Manifest / Registry / Installer；不因搜索扩大安装或信任范围 |
| 当前会话装配范围 | [Session Assembly](../src/server/session-assembly.ts) 的 Resolved Session Plan v3 |
| 真实工具与 Schema | Pi `getAllTools()`；管理器不另存 execute 或整份 Schema |
| 当前开放集合 | Pi `getActiveTools()` / `setActiveTools()`；历史记录不能替代当前观察 |
| Module→Tool 归属 | 从当前 Plan 的真实 Extension 入口与 Pi sourceInfo 即时派生 |
| 业务可执行条件和结果 | 既有领域工具、Host Service 与领域成果协议 |
| 产品可用性投影 | 现有 Web Bridge / `platform.getOverview()`，前端不另建映射表 |

关键区别：**已装配 ≠ 已注册 ≠ 已开放 ≠ 运行环境就绪 ≠ 本次操作已授权。**

[Pi 启动链](../src/server/session-pi-launch.ts) 已关闭自动 Extension/Skill 发现，只加载显式入口；第一方六模块十二工具已有 [CORE_TOOL_BINDINGS](../src/contracts/tool-interface.ts) 和 Tool Contract。它们可增强已知工具核对，但不能成为独立插件发现的必需硬编码清单。

已核对本机固定版本的 [Pi Dynamic Tool Loading 文档](../node_modules/@earendil-works/pi-coding-agent/docs/extensions.md#dynamic-tool-loading) 和 `dist/core/agent-session.js`：

- 已注册工具可以在管理工具执行期间追加为 active，紧接着的模型请求可使用新增定义。
- 未注册名称会被 `setActiveTools()` 忽略，因此调用前核对成员、调用后回读集合。
- 支持原生 deferred 的 Provider 与普通 active 列表 fallback 分别验证，不承诺统一缓存收益。
- 某些 Registry refresh 路径会把新工具或全部 Extension 工具加入 active；首版排除运行时晚注册，reload 后按第 1.1 节重新核对并恢复 active。

第 14 节保留实施前 Registry 刷新风险证据；本轮已完成实际管理入口、生产 Host、独立模块与真实模型验收，结果见第 15 节及验收记录。

## 4. 管理工具接口

一个 Pi-local 工具，按 action 区分输入；实际沿现有 TypeBox / Tool Contract 同源生成机制实现：

```ts
type ManageCapabilitiesInput =
  | { action: 'discover'; query?: string }
  | { action: 'inspect'; moduleId: string; toolName?: string }
  | { action: 'enable'; moduleId: string }
  | { action: 'status'; moduleId?: string };
```

严格拒绝 action 无关字段，不接受 `groupId`、`domainId`、任意 `toolNames[]`、目录、URL、命令或 endpoint。inspect 的 toolName 仅在指定 Module 的已核对工具中查找，不作为启用或执行指令。

| action | 返回内容 | 允许副作用 |
|---|---|---|
| discover | 本会话 Module ID/版本、用途摘要、实际工具数、状态与匹配原因 | 无 |
| inspect | 指定 Module 的真实工具摘要；指定 toolName 时给用途、参数概要、结果类型和 Skill 入口 | 无 |
| enable | 该 Module 实际新增/已开放工具、模块身份和使用指引 | Pi active 集合、成功启用记录及 Bridge 刷新提示 |
| status | 当前模块选择、注册/归属核对和 active 数量及异常 | 无 |

### 4.1 发现与纯查看

```json
{"action":"discover","query":"GIS 道路地图"}
```

查询匹配 Module 名称、说明、现有中英文展示信息、真实 Tool 描述和 Skill frontmatter。先做精确 ID/名称与确定性关键词/别名排序，不增加模型分类、向量服务或 BM25。本轮没有新领域配置或分类标注要求，第三方包也不需要定义“所属业务领域”。

```json
{"action":"inspect","moduleId":"com.transportx.geo"}
```

在已装配并正确注册的任务中，应能看到 Geo 五个实际工具：`inspect_map_context`、`publish_geodata`、`present_visualization`、`request_geo_input`、`capture_geo_screenshot`。未装配或注册不完整时，报告真实范围及诊断，不套用固定示例冒充现场能力。

需要进一步理解时：

```json
{"action":"inspect","moduleId":"com.transportx.geo","toolName":"publish_geodata"}
```

只返回简短参数/结果概述及 Skill 入口，不复制完整 Tool Schema、长 Skill 或资产内容；完整参数定义在 enable 后由 Pi 提供。只读动作不启用工具、不启动后端、不写启用记录。常规工具历史及已有 Bridge 观察照常保留。

### 4.2 有界返回，不建立分页框架

无 query 的 discover 首版最多展示二十个模块；非空查询最多返回五个模块及少量命中工具名。返回 `total`、`truncated` 和缩小 query 的指引，保持输出体量可控。

inspect 默认最多二十条工具摘要，并附总数；超过时提示用 discover(query) 找具体工具，再以 `inspect(moduleId, toolName)` 定位。status 无目标时给有界模块状态摘要，指定模块时可查看详情。数量是本方案预算，不是 Pi 的限制。

首版不提供 cursor、快照代次分页、持久搜索索引或新增检索服务。将来真实包规模证明有需要时再改接口，不为预测中的海量目录提前建设。搜索到工具仍以 Module 为返回和启用单位。

第三方说明和 Skill 文本是可检索数据，不是协调器的系统指令、权限来源或可执行路径。

### 4.3 开放一个 Module

```json
{"action":"enable","moduleId":"com.transportx.geo"}
```

只开放当前 Plan 中这个 Module 的全部合格工具。以下是设计示例，不是实际执行证据：

```json
{
  "kind": "transportx-capability-management",
  "version": 1,
  "action": "enable",
  "moduleId": "com.transportx.geo",
  "moduleVersion": "1.5.0",
  "status": "enabled",
  "newlyActive": ["inspect_map_context", "publish_geodata", "present_visualization", "request_geo_input", "capture_geo_screenshot"],
  "alreadyActive": [],
  "guide": "读取本轮地图上下文；发布 GeoJSON 后使用地图呈现工具。",
  "skillEntries": ["<从当前已核验计划取得的 Skill 入口>"]
}
```

已知模块直接 enable，不强制 discover/inspect。重复启用幂等；查询/查看没有授权含义，不要求用户逐步批准。无真实工具且无已知缺失的模块返回 `no_tools`，说明 Skill/数据等仍可阅读；不能伪造 enabled。若第一方契约明确要求某工具但未注册，应返回缺失诊断，不能当成正常无工具模块。

### 4.4 status 只报告已有事实

```json
{"action":"status","moduleId":"com.transportx.geo"}
```

返回 `selected`、`registeredCount`、`activeCount`、`totalCount`、`state`、必要的 `reasons` 和观察时间。totalCount 指当前可核对的模块工具集合，存在明确预期成员时另列缺失，不为无声明的第三方模块编造“应有总数”。

状态可表达待启用、已开放、部分开放、来源未核对、明确缺失等。state 是即时查询摘要，不是新的持久可用性状态机；UI 继续使用现有三态及原因。

管理入口不判断本次业务授权，不为展示 installed 或 runtimeReady 新增全安装库访问或通用运行环境协议。未入 Plan 的 moduleId 返回 `not_in_session_plan`，不据此声称“未安装”。领域环境、凭据和具体输入能否执行，交给原工具和 Host；active 不能推导 ready 或 authorized。

## 5. Module→Tool 归属：独立包也使用同一路径

归属关系只在现有事实之间派生，不建立新的 Group 或 Catalog 实体：

1. 从 Host 核验的 Plan 取得 `moduleId@version`、实际 Extension 入口和 Skill 路径，不扫描所有已安装包。
2. 从 `getAllTools()` 读取真实 name、描述、Schema、sourceInfo；将四个原生工具和管理工具按实际来源区分。
3. 使用 realpath 和已有 unpacked/跨平台路径 helper，将 Tool sourceInfo 与 Module Extension 入口核对。不能用名称前缀、模块自报路径或字符串 startsWith 猜归属；同一入口归属不唯一时拒绝猜测。
4. 第一方可复用 CORE_TOOL_BINDINGS/Tool Contract 检查明确预期成员及 Schema；第三方使用真实注册和来源核对，不要求进入核心映射表。
5. 来源缺失、入口不符和可观察的同名覆盖明确诊断；无法归属的工具不自动开放。其他明确可核对模块仍可发现。
6. 纯 Skill/Data/Knowledge/Template 模块显示“本会话已装配，无 Pi Tool”，不新增占位工具。

独立包无需添加 `domains`、`groups`、`toolGroups`、`groupDependencies` 或另存所有工具名。通过安装/信任、进入新会话 Plan、实际注册且来源可核对，就可沿同一管理入口发现和启用；是否实际成立由 P2 独立包证明。

项目构建额外注入的 Extension 沿现有可信项目入口单独核验，不伪装成某个 Module。首版只承诺 Plan 内 Module 的 enable；发现无法归属的项目工具时报告范围限制，不另造虚拟 Module 或让它们悄悄常驻。

限制：Pi 最终 Registry 可能只保留同名覆盖后的工具；一次 getAllTools 快照不能检出所有过去的重复注册。检查来源是兼容和归属核对，不是对任意本机代码的隔离。基础工具同名冒充也须诊断，不为凑五个名称接受错误实现。

## 6. enable 行为与依赖

启用按完整 Module 验证，正常流程如下：

1. 核对 Module 在 Plan 中，身份、版本、入口与当前注册来源一致。
2. 派生其全部真实工具，检查可证明的预期成员和契约；存在归属冲突或明确缺失时，写 active 之前拒绝，不主动开放半模块。
3. 在协调器受控串行修改范围内重新读取 active，计算其与 Module 工具的去重并集。使用 Pi 的顺序执行能力，避免并行启用覆盖其他模块。
4. 调用 `setActiveTools()`，回读核对实际开放成员；未知名称不能被静默忽略后仍返回成功。
5. 首次成功时在当前 Pi 分支追加一条 Module 启用记录，返回实际变化，并通知 Bridge 从 Pi 重新采样。重复调用不重复写相同意图。

本轮不提供单工具启用，所以 Spatial 的运行与 `tau_spatial_execution` 查询/取消天然同时开放，不再需要恢复工具伴随策略。

**Module.dependencies 只决定装配，不自动传播 active。** 启用 Geo 不开放 Canvas/Citation；如需直接调用它们的工具，Agent 分别 enable。Canvas 仍是共享视图底层；Geo/Document/Video 的适配装配继续有效，不因其模型工具 inactive 停止渲染或资源服务。Document 无执行工具；Agent 要呈现报告，应在已装配 Document 的前提下开启 Canvas。

启用不改 Plan，不安装或热更新模块，不启动或取消业务，不自动扫描资源。任务内新制作并安装的模块进入新任务；Module Authoring 的安装/信任入口仍是原机制。

### 6.1 状态写入失败不套用业务执行账本

内存 active 与 JSONL 不是跨进程事务。调用前完整核对能避免常见半模块写入；调用后的意外部分状态则回报实际集合，不宣称具备跨崩溃原子性，也不盲目覆盖其他工具的 active。

active 已成功而记录或反馈失败时，明确记账异常与真实开放情况；当前进程可查询，重新打开后允许再次 enable，成本仅是开放 Schema。绝不因此重跑 Spatial、SUMO 或引用登记。

零增量重复启用无需重新计算业务，也不能因“alreadyActive”跳过来源和成员核对；记录仍须代表本分支经确认的 Module 开放意图。

## 7. 生命周期、刷新与唯一恢复记录

建议使用 Pi 原生 `custom entry`，拟定类型 `transportx-tool-activation/v1`；它是本机制唯一启用记录，Tool Result 只承担历史展示。保存 moduleId、Plan 版本和当时实际开放的工具名称集合，用于恢复时核对，不保存 Schema、领域状态或第二份 Plan。

P0 须证明记录在真实 Pi 恢复、分支和压缩后可读。若原生生命周期不能支持该方案，应先修订记录落点，不能同时增加第二份状态文件来掩盖问题。

| 生命周期 | 预期行为 |
|---|---|
| 全新会话 | 所选 Extension 注册完成，首次模型请求前收敛为五工具 |
| 同分支连续使用 | 只追加已启用模块的工具，不自动回收 |
| 同分支恢复 | 基础五工具与本分支已确认 Module 工具集合重建，不重放业务 |
| 分支切换/分叉 | 按目标分支记录重建，遵守 Pi 空闲/导航约束，不撤销进行中的调用 |
| 历史压缩 | 依靠原生分支记录，不依靠模型记忆 |
| 无启用记录的普通会话 | 使用基础集合，需要继续专业操作再 enable；历史成果不改写 |
| 新安装/更新/禁用模块 | 仍遵守原 Plan、精确版本和模块生命周期，不热扩展当前会话 |
| Extension reload | 重新核对当前 Plan、真实 Registry 和有效分支启用记录，再恢复 active；检查随后第一次实际 Provider 请求 |
| 运行时晚注册 | 不支持；发现违反初始化注册约定时诊断模块不兼容，不自动重注册或热加载 |

恢复以 moduleId@version、当前真实来源和记录成员共同核对。当前工具集合与已确认记录不一致时报告漂移，不自动开放新增成员；用户修改模块文件仍遵守现有可编辑代码规则，不能把冻结版本号当成内容逐字一致的保证。新增或变更工具成员应在新会话中重新装配，不能用当前实例的 enable 或 reload 实现成员热更新。

**P0 验证边界是初始化和 reload 后的集合恢复，不是支持任意 Registry 刷新。** 本机 Pi 的刷新代码存在自动追加新注册/全部 Extension 工具的分支，因此在已支持的初始化/reload 生命周期完成核对，并检查首次及 reload 后第一次实际 Provider 请求；不能仅凭参数排列或状态回读假设最后生效。

第 14 节的晚注册探针保留为边界决策证据：运行期间新增工具名称会自动开放，before_agent_start/turn_start 收窄不足以保证请求范围。首版据此要求初始化期间完整注册，不将这些场景转为复杂校正机制的开发任务。不兼容诊断沿已有装配、管理查询和 reload 核对点处理，不增加通用注册监听器或持续扫描。

正常 enable 使用 additive 更新；恢复、分支切换或 reload 后重建可能收窄，则接受 Pi 对非追加集合的正常 fallback。受管 Extension 遵守不自行重置 active 的约定；任意可信代码仍可调用 Pi API，不能宣称协调器已彻底限制所有外部插件。若在所承诺的初始化/reload 路径上不能保证请求范围，P0 明确未通过并修订设计，不以修改 Pi Runtime、扩大晚注册支持或 Bridge 样本替代验证。

本轮不恢复已删除 Task Module 或专用旧协议，不增加永久 legacy/progressive 双轨。普通会话历史、工具结果及成果文件继续按原机制读取，不为工具精简清理数据。

## 8. Skill、提示与产品观察

Skill 沿既有机制提供简介和真实路径，正文由 read 按需读取。读 Skill 不启用工具，启用也不要求先读完整正文。只有 Skill 的模块依然可以通过原基础工具使用；不把所有脚本强制封装成专业 Tool。

基础提示只增加短规则：

> 专业任务使用 manage_capabilities 查找当前会话 Module；需要了解工具时 inspect，明确要用哪个模块时直接 enable(moduleId)，再调用原领域工具。不要每次强制搜索。Skill 按需阅读；工具已开放不代表业务已经执行或成功。

- 用户附加地图/Canvas 时，保留本轮 context ID 和现有富化路径；Agent 开启对应模块，再调用 `inspect_map_context` 或 `canvas_inspect_context`，不能用管理工具的 inspect 代替上下文读取。
- 缺少用户输入时，先 enable Interaction 再调用 `tau_ask_user`。已有 UI 回应、原生安装确认和 Host 清理不依赖模型先启用 Interaction。
- Citation 当前无条件追加的长提示不因 inactive 消失；先量化，按需调整时保留引用正确性，不把整段提示重构作为启用机制的前置。
- 不在系统提示重复全量 Module/Tool 列表；discover 返回模块摘要，inspect 返回工具概要，enable 后由 Pi 提供 Schema。

### 8.1 Bridge 和诊断

协调器在 enable 成功及生命周期校正后，使用现有 Pi event bus 发送拟新增 `transportx:tool-activation-changed` 刷新提示；Web Bridge 从 Pi 读取 all/active，再由原 publisher 发布 revision。保持一个发布者，处理订阅清理及启动次序。

事件不是 Pi 内置 tools_changed，不携带可被当作 Registry 权威的任意列表。只读管理动作不为了展示而触发业务诊断或修改工具集合。

| 事实 | 现有产品投影的表达 |
|---|---|
| 已装配/注册且来源有效、inactive | 待启用；沿三态用 unverified 及专门原因，不报故障 |
| active、未有有效领域调用结果 | 已开放、执行尚未验证 |
| 来源/Schema/active/领域结果均符合原规则 | 已验证可用 |
| 明确缺失、来源冲突或不兼容 | 不可用，并展示原因 |
| 无当前会话或只有旧观察 | 未验证 |

前端继续消费 Host 的 overview 投影，不保存第二份 Module→Tool 表。管理工具的 status 是模型查询接口，不替代产品可用性核对；不能因其中一个工具成功就将整个 Module 标成已验证。

Bridge 已有完整工具描述可能写入 custom entry；减少模型 Schema 不自动减少日志体量。避免重复发布，是否进一步压缩观察内容另据测量决定。

## 9. 工作流和后续交通仿真

纯介绍：“目前有哪些地图工具？”→ discover 或 inspect Geo → 解释用途；active 不变。

明确需求：“显示这个 GeoJSON。”→ enable Geo → 原 `publish_geodata` / `present_visualization` → 地图；无需两次形式化检索。

完整分析：enable Geo 读取上下文 → enable Spatial 计算/查询 → enable Citation 登记依据 → enable Canvas 呈现已有 Document 报告。跨模块分别开放，保留各自业务协议和成果。

未来交通仿真在进入 Plan 且真实注册后，使用 `enable("com.transportx.traffic-simulation")` 开放模块工具，执行固定场景、限速变体、两次 Run、查询比较，再按需开启 Geo/Canvas/Citation。启用不启动 SUMO，不安装 OR-Tools，不重跑未知 Run，不要求先做工具组拆分。

若单个模块未来确实工具过多，再依据真实成本研究更细启用粒度或模块职责拆分；本轮不提前建立组实体。独立模块制作指南只需准确说明 Module、工具用途、入口和依赖，不生成新的分组清单。

## 10. 最小代码边界

只新增受版本管理的 `modules/capabilities/tool-activation/` Capability，作为 Workbench 依赖；模型仍只增加 manage_capabilities 一个工具：

```text
modules/capabilities/tool-activation/
  manifest.json
  extensions/pi-tool-activation/
    index.ts         # 注册与四动作分派、Pi 生命周期连接
    module-tools.ts  # Plan / Pi 工具归属及只读查询
    activation.ts    # enable、记录与恢复
  tool-contract.json # 现有同源生成链产物
```

具体是否需要三个文件，以实际职责为准；每个新增源码文件不超过 500 行，按职责拆分，不机械拆行。后续确有复杂生命周期用例再单独拆文件，不先建立通用 Manager 层。

| 既有位置 | 最小改动 |
|---|---|
| Workbench manifest | 基础依赖及对应 Module 升版 |
| session-pi-launch / 装配上下文 | 提供 Host 已核验 Plan 的受限身份和入口信息；保留显式加载 |
| tool-definitions / tool-interface / 生成打包链 | 新 Pi-local 管理工具契约及实际包路径，不以静态表替代独立包发现 |
| Web Bridge / tool-diagnostics / 能力投影 | 明确刷新点和“待启用”，保留原 revision 与三态 |
| 基础 Prompt / Module Authoring 指南 | 短发现指引；有实际内容改动才升级对应模块 |
| 现有测试与 smoke | 合并少量纵向验证，遵守注册预算 |

Host→Pi 具体传递 Plan 文件还是启动注入由 P0 探针确定，不接受模型指定文件、路径或安装包；不新增 HTTP service token、通用路由或永久 Catalog。CLI 目前没有这项基础依赖，本轮明确只承诺 Workbench；需要支持 CLI 时显式装配，不静默改变普通 Pi CLI。

## 11. 阶段和准入条件

| 阶段 | 交付 | 退出条件 |
|---|---|---|
| P0：机制验证 | 固定真实 Pi、最小四动作入口、初始化来源核对和 Provider 请求捕获 | 首次五工具；只读动作不改 active；enable Geo 后下一模型请求可调用；reload 后按 Plan/Registry/有效分支记录恢复且第一次实际请求符合预期；custom entry 恢复/分支/压缩有证据 |
| P1：Workbench 完整初版 | Module→Tool 派生、四动作、启用与恢复、Bridge/UI/短提示 | 文件任务无需 enable；Geo→Spatial→Citation→Canvas 跑通；Interaction 正常；未知能力说明范围；inactive 不报故障；新源文件不超过 500 行 |
| P2：独立扩展证明 | 独立可安装模块和 Skill-only 模块的安装/装配/发现/启用/执行 | 初始化完整注册，移出源码树仍可用，无需给管理器加模块硬编码；未入 Plan 不能启用；更新不热换旧 Plan；来源问题及违反注册约定有明确不兼容诊断 |
| P3：测量后优化 | 输入量、任务成功率、长会话累积和初始化成本对照 | 有实际问题才增加搜索、细启用粒度或延迟初始化，不将热加载列为本轮完成项 |

关键证据复用已有 suite/smoke：实际首次、启用后及 reload 后第一次模型请求；三个只读动作不产生副作用；重复/并行 enable；来源冲突与缺失；记录失败；分支隔离/恢复；领域未知结果不重算。晚注册负例只证明不兼容边界，不要求实现自动校正或通用监听。

固定模型可证明真实 Pi 工具链，但自主发现和调用须有真实模型任务证据。受控 Provider 请求捕获、生产 Host 执行、目标 OS 实机各证明不同边界；Bridge 快照不能代替模型请求，不虚报未验证 Provider 或打包结果。

先运行 test:budget，将必要断言合并进现有场景，Node 测试注册总数不超过 40。纯文档阶段不运行全量构建，实现后按代码范围执行类型检查和必要验证，不为每个 action/Tool 注册独立测试。

P1 前必须确认：

- [x] 首次五工具、同轮启用已注册工具，以及 reload 后第一次请求具备真实 Pi 证据。
- [x] 初始化后工具成员固定，第三方模块遵守完整预注册约定；不支持的晚注册明确诊断，不新增监听/重注册机制。
- [x] Host 已核验 Plan 的传递及 asar/unpacked 来源核对已定稿。
- [x] 模块全量成员、无工具/缺失区别和状态失败行为已明确。
- [x] custom entry 是唯一启用恢复记录，分支及压缩可读。
- [x] 未新增 Registry、工具组、通用依赖框架或业务执行入口。

## 12. 测量、版本与回退

固定同模型、Provider、任务和装配集合，比较首次 Schema 数/字节、真实输入 token、工具调用次数、成功率、总耗时、缓存及 Pi 启动/内存。没有 token 计数时报告字节，不编造节省比例。自然语言发现先观察模块命中和失败原因，不引入额外评测平台。

按模块开放可能一次增加多个工具；这是为了减少实体和调用次数的明确取舍。启用后的工具在长分支持续累积，出现实际退化再评估收回或更细粒度，不先建立自动关闭策略。代码冷加载只在导入成本确有瓶颈后另行设计，优先保持入口薄和域内延迟初始化。

开发走分支→PR→合并。实际修改 Module 时遵守版本纪律；当前未发布版本继续归集 CHANGELOG，不因文档更新升平台版本。回退协调器收窄逻辑和依赖改动可恢复旧开放行为；保留 custom entry 和成果，不重放或删除业务数据，不长期维护两套装配模式。

## 13. v3 对 v2 的取舍

| v2 | v3 当前决定 |
|---|---|
| 业务 Domain→Group→Tool | 只保留 Module→Tool，按业务意图搜索已有元数据 |
| groupId / domainId / target.kind | 输入仅 moduleId，inspect 可带 toolName |
| 按组或明确独立工具开启 | enable(moduleId) 开放模块全部核对合格工具 |
| 默认 #tools 组、组依赖闭包 | 直接派生 Module 工具，不新增声明或依赖规则 |
| cursor、目录快照分页 | 有界摘要、total/truncated，查询缩小范围或精确 inspect |
| status 推展安装/环境/权限字段 | 只报告 Plan / Registry / active 已知事实，领域执行条件仍交 Host |
| 主要关注启动收窄和 enable | 固定完整预注册约定，验证 reload 后恢复；晚注册探针只作为不支持边界的证据 |
| 外部 namespace/搜索经验转成目录结构 | 只保留渐进开放思想，不照搬外部实体或 SDK |

此前官方资料核查只说明按需工具开放具有参考价值，不能证明 TransportX 应新增业务领域和分组层，也不能替代固定 Pi 的验证。本轮不新增外部产品事实或性能承诺，具体实施以本文件和本地代码为准。

P0–P3 已按初始化完整注册→五工具请求→只读检查→按模块启用→业务执行→reload/分支/恢复→独立安装包→实测对照完成；没有引入 Domain/Group、第二份 Registry、晚注册监听或新业务 Runtime。

## 14. Pi Registry 刷新核查记录（2026-10-23）

结论：**有条件触发的自动开放行为已真实复现，不能只靠一次启动收窄。** 采用本机锁定 Pi 0.80.10 的真实 RPC 进程与显式测试 Extension，模型请求发送到隔离的本地受控 Provider，捕获实际 HTTP tools 字段。模型响应只用于驱动测试流程，无真实业务执行、外部模型调用或应用会话修改；不是 fake Pi，也不代表完整生产管理工具已实现。

本记录保留核查事实；首版实施范围以第 1.1 节为准。晚注册及其校正尝试属于不兼容场景探针，不构成首版的注册监听或自动修复需求。

| 场景 | 实际结果 | 意义 |
|---|---|---|
| session_start 将初始集合收窄到五工具 | 首次请求五工具 | 启动收窄可行 |
| 重新注册一个已经存在、inactive 的同名工具 | 仍为五工具 | 普通刷新不等于重新开放所有隐藏工具 |
| 运行期间 registerTool 新名称，未调用 setActiveTools 开放它 | active 及下一请求变为六工具 | 新名称会自动开放，绕过拟议 enable 流程 |
| 在一个工具 execute 内注册新名称 | 同一轮第二次模型请求包含新增工具 | before_agent_start 不能覆盖这种晚注册 |
| reload，仅启动时收窄 | 原先隐藏的预注册工具重新出现在请求中 | reload 的 includeAllExtensionTools 路径会重新开放工具 |
| reload 时 session_start(reason=reload) 重新收窄 | 下一请求恢复五工具 | 这个 reload 校正点在本探针中有效 |
| 每次 before_agent_start 收窄 | 可校正两次用户提问之间的新增；同轮晚注册仍进入请求 | 只能覆盖部分时序 |
| 再加 turn_start 收窄 | active 回读显示五工具，同轮下一请求仍包含第六个工具 | active 快照不能代替实际 Provider 请求证据；该做法尚不能用作修复 |

源码链：[Extension registerTool](../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js) 调用 runtime.refreshTools → [AgentSession](../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js) 的 _refreshToolRegistry：新名称追加进 active；reload 使用 includeAllExtensionTools。另有下一轮 context/tools 快照处理，不能仅凭生命周期 handler 已执行就推断请求工具集。

当前 TransportX 可达范围：

- 本次检查的内置 Extension 均在工厂初始化时注册；未发现它们在业务执行中晚注册工具或调用 ctx.reload。因此未观察到现有内置业务自行触发该问题；独立插件仍可能触发。
- [Host reloadModules](../src/server/platform-composition.ts) 刷新 ModuleRegistry / AssetResolver，不等于刷新活动 Pi Tool Registry，安装或启用模块不因此热加入旧会话。
- Host 原生命令白名单无 reload；已装配 Extension 自己定义的命令则可经 Pi RPC 调用 ctx.reload，本探针验证了该路径。不能把“UI 没有 reload 按钮”视为 Pi 不会 reload。
- 以下为实施前核查时的状态：当时 manage_capabilities 尚未实现。当前新 Workbench 已切换五工具模式，reload 与实际请求验收见第 15 节；晚注册仍属于不兼容行为。

本地证据保留在 Git 元数据下，不作为包内测试资产：

- `.git/local-backups/pi-tool-refresh-s4xqa10y/`：probe.mjs、results.json、startup-only/lifecycle 的观察样本。
- `.git/local-backups/pi-tool-refresh-turn-confirmed-nt01hbx4/`：turn_start 收窄但请求仍扩大的复现脚本及 results.json。

test:budget 预检为 40/40；未新增 Node 测试注册节点。上述结果仅完成刷新风险核查，Module 归属、enable 持久化、恢复/分支/压缩以及生产 Host 全链路仍按 P0/P1 独立验证。


## 15. 实施结果（2026-10-23）

- P0：真实 Pi 0.80.10 RPC 捕获 HTTP Provider tools，首次五工具；只读动作不变；同一任务 enable Geo 后发布成功；reload 后首请求、跨进程恢复、分支/fork 与原生压缩通过。
- P1：Tool Activation 1.0.0 / Workbench 1.4.0 / Web Bridge 1.2.0 / Module Authoring 1.2.1；生产 Host、Python 与浏览器跑通 Geo/Spatial/Citation/Canvas/Interaction。完整类型检查与核心 40/40 通过。
- P2：源码树外独立包目录/ZIP 安装，发现/查看/启用/实际执行、更新/禁用/恢复/卸载/重装；Skill-only 返回 no_tools，安装不扩展旧计划；真实模型自行开启独立模块与 Geo。晚注册在查询/enable/reload 核对点诊断不兼容；不支持监听或热加载。
- P3：实际 Provider Schema 对照、真实模型输入 token/调用数/成功率/延迟、初始化内存与长分支累积见验收记录。没有证据要求新增检索框架、粒度层级或延迟代码导入，本轮不增加。

唯一恢复日志采用同一 customType 的 assembly/enable 两种记录：前者保存初始化 Module 成员，用于跨 reload/恢复拒绝热变更；后者保存当前分支成功开放意图。没有第二份状态文件或工具目录。Host 通过启动环境注入受限模块身份/入口/契约路径与检索摘要，避免传递 execute、Schema 全文或额外服务 token。

重跑命令：`node scripts/tool-activation-smoke.mjs`；`TRANSPORTX_TOOL_SMOKE_PHASE=activation node scripts/tool-host-smoke.mjs`；`TRANSPORTX_TOOL_SMOKE_PHASE=recovery node scripts/tool-host-smoke.mjs`；真实模型按验收记录显式提供配置目录运行 `scripts/activation-model-smoke.mjs`。Python 使用显式 TAU_PYTHON_COMMAND。

限制：实测为本机 macOS arm64、OpenAI Completions 兼容接口与 DeepSeek 模型，不外推其他 Provider 的原生 deferred/cache 收益；新协调器未重新打安装包，Windows/Linux 交由 PR CI 与目标机验收。冻结旧 Plan 没有 Tool Activation 时不偷偷修改装配，普通工具历史和业务结果继续按原机制读取。
