# Citation Update Plan — Evidence & Citation Infrastructure

> 状态：Citation v2 基础设施已实施；后续扩展待评审
>
> 更新时间：2026-08-10
>
> 范围：TransportX 平台内置 Citation capability；不包含某一城市或领域知识资产的重建。

## 1. 决策摘要

Citation 不应继续演化为“将 `[[cite:id]]` 改写成 LaTeX `\\cite{}` 的插件”。它应升级为 TransportX 平台统一的 **可信证据、引用、溯源和文档编译基础设施**（Evidence & Citation Infrastructure）。

这符合项目既有边界：Agent Host 是唯一业务核心，`src/contracts/` 是跨层权威协议，Pi Extension 是模型工具与受控结构化结果的桥接；领域 Module 只提供知识、数据和检索能力，不拥有平台引用机制。

目标架构如下：

```text
Knowledge / Attachment / Web / Data / Artifact
                    │
                    ▼
             Citation Resolver
                    │
                    ▼
       Work + Resource + Locator + Provenance
                    │
                    ▼
           Citation Occurrence / Citekey
                    │
                    ▼
              Citation Compiler
          ┌─────────┼─────────┐
          ▼         ▼         ▼
      Chat [1]   Report   LaTeX / CSL / RIS
```

`/cite` 是用户选择和编辑引用的交互入口；`[[cite:occ_xxx]]` 是 Agent 与渲染器间的受控内部标记；`\\cite{citekey}` 是 LaTeX 导出格式。三者不得互相充当底层数据模型。

## 2. 当前基线与问题

现有能力已经完成 Citation v2 的基础闭环：

- `src/contracts/` 以 Work、Resource、Locator、Occurrence 和 Provenance 表示知识、附件、网页、数据集和任务产物；
- Pi Extension 先以 `tau_resolve_citation` 将 `K-...` 知识 ID 或受控任务资源解析为候选 Locator，再以 `tau_cite({ locatorId })` 创建 Occurrence；
- Agent 正文只使用 `[[cite:occurrenceId]]` 标记；React 与报告预览按 Occurrence 显示编号、原始资料定位和引用依据；
- Agent Host 按 live session、已选 Module 资产、相对路径、真实路径边界及 SHA-256 提供受控原件访问；知识引用指向原始 PDF/HTML，而不是知识索引 JSONL 或 Markdown；
- Citation Compiler 不改写源 Markdown，预览和导出在编译时生成编号与出处列表。

这些基础必须保留，特别是来源哈希、会话隔离、恢复会话后可展示定位、以及不向 Renderer 暴露绝对路径的安全模型。

但当前模型仍是“对话证据卡”，尚不能承担完整书目与产物编译职责：

| 问题 | 当前行为 | 影响 |
|---|---|---|
| 身份映射完善 | Work/Resource/Locator/Occurrence 已解耦，但部分外部来源的书目信息仍不完整 | 导出格式可能缺少作者、发布日期或版本 |
| 编号局部 | `[1]` 每条 Assistant 消息重新编号，下一条用户消息会清空可用集合 | 不能为整份报告或跨轮次正文生成稳定引用序列 |
| 书目信息不足 | 来源只有 title、文件类型、路径和 hash | 无法生成 GB/T 7714、作者—年份或 BibTeX 书目 |
| Locator 选择质量 | Host 会返回多个候选 Locator，但模型仍可能选择过宽或不匹配的定位 | 一部文献的多页、表、图、条款需要更强的 Agent 复核约束 |
| 产物溯源覆盖 | 图、表、SQL 结果可作为受控证据，但生成作业尚未全部自动登记 provenance | 后续推论的来历可能需要人工补充 |
| 导出覆盖 | 预览与基础书目导出可复用编译结果，跨格式样式与长报告场景仍需验证 | HTML/PDF/DOCX/CSL/RIS 的一致性仍需扩展测试 |

## 3. 目标与非目标

### 3.1 目标

1. 让每一个结论能定位到稳定的来源、版本和精确位置。
2. 支持同一 Work 的多个 Resource 和多个 Locator。
3. 将编号、可读 citekey、系统真实 ID 解耦。
4. 让对话、报告预览、PDF、DOCX 和学术交换格式复用同一个编译结果。
5. 让网页、用户附件、数据查询、图表、地图和 Agent 产物成为一等 Evidence。
6. 保持本地优先、会话隔离、原件哈希校验、无绝对路径泄露和历史恢复能力。

### 3.2 非目标

- 不把 Citation 做成独立远程服务或第二套 Web UI。
- 不要求模型直接理解或生成任意 LaTeX/BibTeX 语法。
- 不在第一阶段自动判断自然语言论断是否被原文充分蕴含；系统保证的是来源、定位、版本与审计链可核查。
- 不将用户的 API Key、原始数据库连接信息或受限原始数据写入引用记录。

## 4. 核心模型

新模型采用四层实体，加一层溯源关系。它们必须定义于 `src/contracts/`，不依赖 Node、React 或 Pi。

### 4.1 Work：抽象文献或权威对象

Work 是“被引用的作品/规范/网页/数据集”的稳定身份，与某个下载文件解耦。

```text
work_01J...                 系统真实 ID
GBT33170_2_2016             可读 citekey
《大型活动安全要求 第2部分：人员管控》  展示标题
```

Work 至少包含：`workId`、`citekey`、标题、类型、作者/机构、发布日期、版本或标准号、语言、权威性类别和可选的 DOI/官方 URL。书目字段采用 CSL-JSON 可无损表达的子集，以避免将来格式转换时另建映射。

`citekey` 可读、可稳定导出，但不是安全边界；系统内部一律以不可猜测的 `workId` 关联。`[3]` 只由某次编译的输出范围决定，绝不能当作身份。

### 4.2 Resource：可打开、可校验的具体载体

Resource 表示某个 Work 的实际副本或版本，例如某版 PDF、附件、网页快照、数据集快照、查询结果或 API 响应。

Resource 必须保存：`resourceId`、`workId`、媒介类型、来源范围、受控相对位置或快照位置、SHA-256、采集/生成时间、版本信息与可用状态。它不保存浏览器可访问的任意绝对路径。

网页 Resource 必须保留受控内容快照、原始 URL、抓取时间和内容 hash；不能只引用一个会变化的实时 URL。数据 Resource 记录数据资产 ID、版本、时间窗、许可证/访问约束和结果 hash；不得记录密钥。

### 4.3 Locator：针对论断的精确位置

Locator 属于 Resource，表示具体可核验位置：PDF 页与坐标、条款、章节、HTML anchor、段落/行号、表格单元、图片区域、视频时间段、SQL 结果行、数据时间窗等。

一个 Work 可以有多个 Resource；一个 Resource 可以有多个 Locator；同一 Locator 可被多次引用。这样可直接解决“同一标准只引用第一个 `source_ref`”的问题。

Locator 应保存可显示摘录、定位语义和置信/复核状态。摘录是核验辅助，不是原件替代；原件变化时仍需依据 Resource hash 显示“已变更”。

### 4.4 Citation Occurrence：某次实际使用

Occurrence 代表一次具体的引用使用，连接 `workId + resourceId + locatorId` 与某个输出锚点。它可记录：

- `occurrenceId`；
- 引用用途：直接依据、背景、数据来源、方法来源、反例或产物来源；
- pin cite、前后缀、用户备注和验证状态；
- 输出范围（聊天消息、报告文档、图表说明、地图、PDF）；
- 输出内锚点（消息 ID、Markdown AST node ID、图/表编号等）。

内部正文标记使用 `[[cite:occ_xxx]]`。兼容期允许继续解析 `[[cite:<legacy-id>]]`，由 Host 映射为 occurrence。

### 4.5 Provenance Edge：由何而来

除引用外，平台维护有向溯源边：

```text
Figure 3
  └─ generated-from → analysis.csv
       └─ queried-from → dataset v2026.08
            └─ sourced-from → 原始交通数据
```

边应记录关系类型、生成工具/作业、时间、输入 Resource IDs 和可选参数摘要。它用于解释 Agent 产物的来历，不替代正式的 Occurrence。

## 5. 职责与边界

| 层 | 应承担的职责 | 不应承担的职责 |
|---|---|---|
| `src/contracts/` | Work/Resource/Locator/Occurrence/Provenance 协议、版本迁移和结构校验 | 文件读取、编号、React 展示 |
| Agent Host | Citation Registry、Resolver 调度、受控原件/快照、校验、编译、导出、访问授权 | 模型提示词推理、组件布局 |
| Pi Extension | 提供 `tau_cite`、`tau_resolve_citation` 等窄工具桥，将模型选择提交给 Host | 解析知识文件、生成参考文献、改写报告、分配最终编号 |
| Domain Module / Skill | 提供 Knowledge/Data 资产、检索结果、领域字段和复核流程 | 维护通用 Registry 或跨 Module 编译逻辑 |
| React Workspace | `/cite` 选择器、预览、引用卡、错误状态、编辑器锚点 | 路径校验、哈希校验、书目拼接 |
| Electron | 既有 PDF 生命周期与隔离渲染边界 | Citation 业务状态 |

因此，`extensions/pi-citation/` 将收敛为工具适配层。由它调用 Agent Host 的本地受控能力，或接收 Host 注入的专用 RPC，不再自行执行知识检索脚本或写入报告文件。

## 6. Citation Resolver

Resolver 屏蔽不同来源的获取与规范化差异。每个 Resolver 将输入解析为统一的 Work、Resource 和候选 Locator，并由 Agent Host 统一验证、去重、入库和返回。

```text
Resolver input
  → candidate Work / Resource / Locator
  → Host policy + hash/version verification
  → Citation Registry
  → occurrence candidates for Agent or /cite UI
```

首批 Resolver：

| Resolver | 输入与产物 | 关键约束 |
|---|---|---|
| `KnowledgeResolver` | `knowledge_id`、原件元数据、知识卡和多个 `source_refs` | 仅使用当前 `ResolvedSessionPlan` 已装配的 Knowledge 资产；保留 issuer、状态、效力和版本 |
| `AttachmentResolver` | 当前 session 的 attachment ID | 复用附件归属、大小、hash 和路径边界；先作为待核验来源，再由解析结果产生 Locator |
| `ArtifactResolver` | 当前任务受控输出 | 区分“可下载产物”与“可作为证据的产物”；生成 provenance edge |
| `WebResolver` | 搜索结果或用户确认 URL | 由 Host 抓取/清洗/快照；SSRF 防护、获取时间、URL 和 hash 必须入库 |
| `DatasetResolver` | Data asset、查询作业或结果 manifest | 记录数据版本、查询摘要、过滤条件、时间范围、结果 hash 与权限等级 |

新增 Resolver 不得要求修改现有 Citation 核心分支。其能力通过显式注册表和受限输入 schema 接入，避免把“网页”“数据库”等不断堆进 `tau_cite` 的参数。

## 7. Registry、持久化与安全

### 7.1 Session Citation Registry

第一阶段在每个 session workspace 的 `.tau/` 下建立原子写入的 Citation Registry，例如 `citations.json`。它与现有 `.tau/attachments.json` 的定位一致：保存 Citation 业务状态，但不替代 Pi JSONL 的对话历史事实。

- Registry 保存实体、关系、版本、hash、导入映射和编译所需元数据；
- Pi JSONL 保留 Agent 的工具调用、`[[cite:...]]` 标记和消息历史；
- 恢复任务时 Agent Host 先加载 Registry，再根据 JSONL 投影 occurrence 到消息；
- 导出时可生成不可变 Citation Bundle，支持把报告连同其引用快照移交或复核；
- 未来如需跨 session 复用，只迁移 Bundle，不让各 session 直接读写同一全局数据库。

### 7.2 安全与一致性

必须延续当前 Citation Resource 的规则：

1. Renderer 仅以 `resourceId`/`occurrenceId` 请求受控内容，不能传任意文件路径或 URL。
2. 本地 Resource 读取时执行真实路径边界、符号链接检查、文件类型检查和 SHA-256 比对。
3. Web 快照和数据查询只能由 Host 创建；外部 URL 需协议限制、DNS/IP SSRF 防护、重定向校验、大小/超时上限与内容清洗。
4. 访问受限数据时，引用卡只显示允许披露的元数据；导出 Bundle 必须剔除密钥、连接字符串和敏感原始数据。
5. 历史快照无法打开原件时仍展示保存的 Work、Locator、摘录和状态，但不得绕过 active session 读取文件。

## 8. Citation Compiler 与产物

编译器输入是 Markdown/报告 AST、occurrence 集合和一个 `CitationProfile`，输出是带编号的内容、Reference List、Citation Map 与可选交换格式。它替代“插件直接改写 Markdown”的做法。

```text
Markdown / Report AST + Occurrences + CitationProfile
                         │
                         ▼
                 Citation Compiler
                         │
      ┌──────────────────┼──────────────────┐
      ▼                  ▼                  ▼
 rendered Markdown    HTML / PDF          DOCX
 reference list       cite map             .bib / CSL-JSON / RIS
```

首个 `CitationProfile` 定为 **GB/T 7714 数字制**，按整份报告首次出现顺序编号、去重并生成参考文献。随后增加：作者—年份、脚注、法规/标准专用文案、BibTeX、CSL-JSON 与 RIS。

编译应为纯函数式或显式产物写入：原始 Markdown 保留 occurrence 标记，不再被 `tau_cite` 就地重写。预览、PDF 和 DOCX 均消费同一份编译结果，避免编号和参考文献漂移。

聊天的编号范围由 `CitationProfile.scope` 决定，首版保留“单消息编号”以维持当前体验；报告默认“整篇文档编号”。以后可选择“会话连续编号”，但不将其作为默认行为。

## 9. `/cite` 交互与 Agent 工具

`/cite` 不直接暴露底层路径、hash 或 LaTeX 字符串。用户输入 `/cite` 后，Composer 打开来源选择器，可查看：当前会话来源、知识库、附件、网页、数据结果与任务产物；选择 Work 后可继续选择 Resource 和 Locator。

编辑态使用人类可读的临时表示，例如：

```md
[@GBT33170_2_2016, §8.4]
```

确认后写入受控 occurrence 标记：

```md
[[cite:occ_01J...]]
```

LaTeX 编译时，Compiler 根据 Work 的 `citekey` 导出：

```tex
\cite{GBT33170_2_2016}
```

Agent 侧工具保持窄而明确：

- `tau_resolve_citation`：请求 Resolver 解析某个已受控的知识 ID、attachment ID、artifact ID、网页搜索结果或数据作业；
- `tau_cite`：从已解析候选中创建或选择 Locator，并创建 Occurrence；
- `tau_compile_citations`：仅在明确的报告/导出请求中要求 Host 以指定 Profile 编译。

工具不得接受任意本机路径、任意 SQL 连接或未经 Host 记录的网页内容。

## 10. 兼容与迁移

`pi-citation/1.0` 只读兼容，不在原协议内改变既有字段语义。新模型应定义可协商的 `pi-citation/2.0`，解析器同时接受 v1 与 v2：

1. v1 `CitationSource` 导入为 Work + Resource；
2. v1 `CitationLocator` 导入为 Locator；
3. v1 `CitationRecord` 导入为 legacy Occurrence，并保留原 `citationId` 映射；
4. 既有 `[[cite:<legacy-id>]]` 在投影时通过映射显示，提醒但不阻塞历史会话；
5. 新写入只使用 v2 occurrence ID；
6. Registry 缺失的历史消息保持当前“引用不可用”的安全降级，不从任意路径猜测恢复。

迁移完成前，React 必须同时支持 v1 现有 Citation Footer 与 v2 Projection；资源路由也必须先按 session 与 Resource 校验，再提供预览。

## 11. 分阶段实施

### Phase 0 — 设计冻结与基线测试

确认术语、scope、CitationProfile、敏感数据策略和 v1→v2 迁移规则；为当前 v1 行为补齐 extension、projection、报告编译和资源访问回归测试。

**完成标准**：现有引用、报告预览、PDF 下载、会话恢复和跨 session 资源隔离均有可重复测试基线。

### Phase 1 — 重构模型与兼容读取

在 `src/contracts/` 增加 v2 Work/Resource/Locator/Occurrence/Provenance 协议、解析器和 v1 adapter；不改变现有 UI 外观与 `[[cite:id]]` 写法。

**完成标准**：同一 Work 可注册多个 Locator；老 envelope、老消息与新记录可同时投影；所有 ID、hash 与上限经过契约测试。

### Phase 2 — Citation 收归 Agent Host

新增 Host 侧 `citation-registry`、`citation-service` 与 Resolver registry；迁移 `tau_cite` 的知识解析、文件校验、引用注册和访问授权逻辑。Pi Extension 只转发受控请求与返回结构化 IDs。

**完成标准**：不启动 Pi 也可通过 Host API 创建、读取、校验并编译一个测试 Citation Registry；Extension 中不再读取知识脚本或改写文件。

### Phase 3 — 精确引用与现有来源整合

先实现 KnowledgeResolver 的多 locator 选择，再实现 AttachmentResolver 和 ArtifactResolver；为图、表、地图与数据作业写入首批 provenance edges。

**完成标准**：一份标准可在同一报告内引用两个不同条款/页；一张图可回溯到其输入数据或分析产物；任务产物可选择作为“产出”或“证据”。

### Phase 4 — Citation Compiler

引入 AST/锚点级编译管线，停止就地修改 Markdown。实现 GB/T 7714 数字制、整篇报告统一编号、Markdown/HTML/PDF 一致的 Reference List 和 Citation Map。

**完成标准**：同一报告在预览、PDF 和复制导出中编号一致；源 Markdown 未被编译步骤篡改；重复 Occurrence 正确去重。

### Phase 5 — citekey 与 `/cite`

提供 Citation Manager 与 Composer `/cite` picker，显示 Resource 状态与 Locator 预览；添加 citekey 冲突处理以及 BibTeX、CSL-JSON、RIS 导出。

**完成标准**：用户无需知道内部 ID 即可插入、变更或删除引用；同一报告能导出可被 LaTeX/参考文献管理器使用的文件。

### Phase 6 — 网页、数据与完整 Provenance

接入 WebResolver、DatasetResolver 和受控网页快照；扩展分析作业、Geo scene、图表与报告之间的溯源图。

**完成标准**：网页引用可显示快照时间与 hash；数据结论可追溯数据版本和查询摘要；用户可从最终图表回查其数据与分析链。

## 12. 验收矩阵

| 领域 | 必须覆盖的验证 |
|---|---|
| 契约 | v1/v2 解析、必填关联、ID 去重、长度上限、定位合法性、迁移诊断 |
| 安全 | 跨 session 拒绝、路径逃逸/符号链接拒绝、原件 hash 改变、网页 SSRF/重定向/超时、敏感元数据脱敏 |
| Resolver | Knowledge 多 locator、附件归属、产物 provenance、网页快照、数据版本与查询结果 hash |
| 编译 | GB/T 7714 顺序、去重、pin cite、多源混排、消息/报告 scope、Markdown/HTML/PDF 一致性、源文件不变 |
| UI | `/cite` 键盘与鼠标操作、预览、无权限/原件缺失、历史恢复、v1 legacy marker 显示 |
| 端到端 | Pi 调用工具 → Host Registry → 会话 JSONL → React 投影 → 报告/PDF/交换格式导出 |

每一阶段应先添加对应失败测试，再做最小实现。涉及服务端或契约的阶段至少运行 `npm run typecheck` 与 `npm test`；涉及工作台交互和报告编译时再运行 `npm run test:react-smoke`。

## 13. 待评审决策

以下决策会影响数据迁移与 UI，必须在 Phase 1 前确定：

1. Citation Registry 的第一期是否严格 session scoped；本计划建议“是”，跨 session 通过显式 Citation Bundle 导入。
2. 默认书目样式是否固定为 GB/T 7714 数字制；本计划建议“是”，满足中国交通业务报告的主路径。
3. 网页引用是否必须生成本地快照；本计划建议“是”，实时链接只能作为附加跳转入口。
4. 数据引用的可披露粒度：默认只展示资产 ID、版本、查询摘要、时间窗和 hash，敏感数据正文不随引用卡或 Bundle 导出。
5. `pi-citation/2.0` 是否与 v1 同期双读；本计划建议“是”，不得以一次性破坏历史会话换取模型整洁。

## 14. 最终定位

完成后，Citation 不再只是“给 Agent 输出 `[1]` 的插件”，而是：

> TransportX 平台统一的可信证据、精确引用、产物溯源与多格式文档编译基础设施。

平台负责机制与安全边界；Module 提供 Knowledge/Data 内容；Pi 负责模型工具桥；React 提供可理解、可编辑、可核验的体验。该分工与现有模块化单体、Session Assembly、跨层 contracts 和本地优先架构保持一致。
