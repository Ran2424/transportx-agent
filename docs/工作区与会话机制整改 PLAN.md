# 工作区与会话机制整改 PLAN

- 状态：PR 1 / PR 2A 已进入集成验收；本文件保留设计约束，实际完成范围与证据见 [P0 记录](<工作区与会话机制整改 P0 记录.md>)。PR 2B / PR 3 及 P2 仍按阶段推进。
- 日期：2026-10-25。
- 核查基线：3.23.2 当前工作目录源码，包含本地尚未提交的改动；不是对远端 main 的运行验收。
- 问题来源：[#41 同一工作文件夹持续工作](https://github.com/Ran2424/transportx-agent/issues/41)、[#87 改名与目录名称](https://github.com/Ran2424/transportx-agent/issues/87)、[#88 空会话与残留目录](https://github.com/Ran2424/transportx-agent/issues/88)，以及用户补充的整改意见。
- 当前架构权威：[ARCHITECTURE.md](ARCHITECTURE.md)。本文中的新结构、API 和行为均为目标设计；实施后再同步架构正文。
- 本次修订：唯一新 API 保留，启动改为“全局安全就绪 + 工作区独立迁移就绪”；异常历史不阻塞无关工作区。补充主分支原子切换、精确备份/空间预检、历史资源链接投影、客户端失败安全及锁异常恢复；T1–T4 和各批次实施结果见 P0 记录，不以设计表格代替运行验收。

## 1. 决策与范围

采用“轻量工作区 + 多会话归属 + 独立任务快捷创建”。工作区保存资料、成果和默认配置；会话保存独立对话历史与实际执行配置；任务继续表示用户的工作目标，不新增 Task 持久实体。

第一版固定以下规则：

1. 一个工作区可有零个或多个会话；一个会话只属于一个工作区，不提供跨工作区移动会话。
2. “新建独立任务”创建工作区和首个会话；“在工作区内新建会话”复用目录。两者共用会话初始化流程。
3. 点击“创建”并收到持久化成功后，零消息会话也可恢复。打开或取消表单不创建目录。
4. 工作区提供默认值，新会话可覆盖；每个会话保存自己的冻结计划。更新默认值不追溯修改旧会话。
5. 同一工作区同一时刻最多一个 Pi 实例，包含启动、运行和停止中的实例；不同工作区沿用现有全局容量限制。
6. 关闭停止运行但保留会话；删除会话保留共享资料；删除工作区文件使用独立入口。
7. 会话标题、工作区展示名称、物理目录名是三个不同概念。首版不提供目录改名或搬迁。
8. 排他只支持同一台机器、本地文件系统上的多窗口与多 Host 进程；不支持网络共享磁盘上的多机器并发协作。
9. 新版本只有一套工作区/会话 API 和一份 CLI 实现。首次启动统一清点，在全局安全条件成立后允许新建独立工作区和使用已完成迁移的工作区；待处理工作区单独阻塞。旧工作区/私有状态格式仅由迁移器处理，历史链接可由受控新投影解析，不恢复旧运行分支。

不在首版范围：数据库替换、Project/Task 管理系统、跨工作区权限系统、完整历史自动注入、新 Agent Runtime、同工作区多 Agent 并行、任意外部文件夹直接接入、自动删除残留目录、物理目录迁移。

#87 的名称归属和路径可达性安排在 PR 3；物理目录改名仍为后续 P2。本轮整改不直接关闭 #87。

首批交付为“所有客户端使用新 API，正常工作区可独立迁移及使用，两条共享同一工作区的独立会话能安全创建、恢复、关闭，异常工作区可诊断/修复”。迁移器和歧义处理能力须随版本交付，但不要求用户所有旧数据在首次启动全部处理完。高级离线预览后置；全局索引、Writer 与删除墓碑不可靠时仍全局阻塞。

## 2. 当前实现与整改位置

| 当前实现 | 依据 | 整改要求 |
|---|---|---|
| 新建会话总是分配时间戳子目录；cwd 表示父目录 | [session-workspace.ts](../src/server/session-workspace.ts)、[sessions.ts](../src/server/sessions.ts) 的 create | 将目录分配与会话创建拆开；已有目录只通过已登记的 workspaceId 复用 |
| 创建目录、保存计划后启动 Pi，成功才加入 live map | [sessions.ts](../src/server/sessions.ts) | 持久会话提交先于 Pi 启动；启动失败仍可见、可重试 |
| 历史按 cwd 聚合，只收录有用户消息的 JSONL | [session-history-handler.ts](../src/server/session-history-handler.ts)、[session-history-reader.ts](../src/server/session-history-reader.ts) | 已登记会话由 Manifest 列表驱动；JSONL 仅提供消息与摘要，不决定会话是否存在 |
| 一个 cwd 只有一份 resolved-session-plan*.json | [session-assembly.ts](../src/server/session-assembly.ts) | 每条会话保存独立计划，并按会话定位加载 |
| Pi 实例构造时生成 id；恢复会产生新的运行标识 | [sessions.ts](../src/server/sessions.ts)、[session-metadata.ts](../src/server/session-metadata.ts) | 增加持久 conversationId，不将 live id 当作长期身份 |
| 附件元数据和消息关联写入同一份 attachments.json | [session-attachments.ts](../src/server/session-attachments.ts) | 保留共享文件库，拆出按会话保存的消息关联 |
| Canvas、Geo 交互和耗时以 cwd 定位状态 | [canvas-service.ts](../src/server/canvas-service.ts)、[geo-interaction-service.ts](../src/server/geo-interaction-service.ts)、[timing-metrics.ts](../src/server/timing-metrics.ts) | 会话私有数据增加 conversationId 作用域 |
| Citation Registry 位于 cwd，registryId 沿用首次注册身份 | [citation-registry.ts](../src/server/citation-registry.ts)、[sessions.ts](../src/server/sessions.ts) | 复用既有稳定 Registry 身份，不批量重写引用 ID |
| 删除会话默认连同目录删除，但已经检查共享占用 | [api-routes.ts](../src/server/api-routes.ts)、[sessions.ts](../src/server/sessions.ts) | 改变默认语义；保留停止、归属和共享占用校验 |
| 侧栏平铺且用 /scenario/ 路径判断是否展示 | [SessionSidebar.tsx](../src/web/platform/sessions/SessionSidebar.tsx) | 按工作区索引分组，不能遗漏自定义父目录中的已登记工作区 |
| 文件和资源 API 依赖 liveSessionId | [api-routes.ts](../src/server/api-routes.ts)、[file-api-handler.ts](../src/server/file-api-handler.ts) | 公开会话资源入口统一按 conversationId；内部执行仍校验 live ID/token；高级离线预览放入 PR 2B |
| CAD/Spatial 执行 Owner 依赖 JSONL 相对路径、header.id 和 cwd 核验 | [execution-owner.ts](../src/server/util/execution-owner.ts)、[cad-invocations.ts](../src/server/cad-invocations.ts)、[spatial-invocations.ts](../src/server/spatial-invocations.ts) | 保留旧 Owner 算法和历史路径；workspaceId 不能替代执行归属证明 |
| CLI 创建 /api/live-sessions，cwd 也是父目录 | [transportx.ts](../src/server/transportx.ts)、[commands.ts](../src/public/kernel/commands.ts) | 同步改用新 API；现有参数直接生成新契约输入，不保留旧请求实现 |

补充核查：本地 Pi 0.80.10 的 SessionManager 支持 --session 指向尚不存在的 JSONL，但通常在产生 assistant 消息后才首次写文件。单独收到 sessionFile 路径不能证明历史已经落盘。新建空会话不能依赖这一时机，也不能通过伪造 assistant 消息强制落盘。

“仅切换会话导致空会话消失”尚未运行复现；当前 App 的 selectSession 不主动关闭原实例。PR 1 必须分别覆盖切换、关闭、刷新、Host 重启，不能把四种行为当作同一原因。

## 3. 身份、权威与目录结构

### 3.1 三种产品身份与 Pi 历史身份

| 标识 | 生命周期 | 用途 |
|---|---|---|
| workspaceId：ws_<uuid> | 创建至工作区删除 | 工作区归属与查找，与目录名无关 |
| conversationId：conv_<uuid> | 创建至会话删除；恢复不变 | 标题、冻结计划、私有状态和 UI 选中身份 |
| liveSessionId：现有 tau_* | 一次 Pi 实例 | RPC、服务 token、运行中事件、作业取消 |
| piSessionId：JSONL header.id | 一份 Pi 历史 | 保持 Pi 原生身份与领域执行 Owner，不替换为 conversationId |

不修改现有 SessionSnapshot schema 的含义：消息仍由 Pi JSONL 与现有投影决定。持久工作区/会话契约在 src/contracts/ 新增独立模块；LiveSession metadata 增加 workspaceId、conversationId，不把现有 id 字段改成另一种身份。

### 3.2 目标布局

```text
<user-data>/
├─ workspaces.json                         工作区定位表及未完成管理操作
├─ migrations/workspace-v1/                 系统迁移状态、源清单与总报告
└─ sessions/                               沿用现有 SESSIONS_DIR 配置
   ├─ <原有目录>/<旧历史>.jsonl             不搬迁、不重写
   └─ transportx/<conversationId>.jsonl      新会话预留路径，由 Pi 写入

<workspace-root>/                          原有目录或新建时间戳目录
├─ attachments/<attachmentId>/             共享上传文件
├─ 报告、数据、cad/ 等                       共享资料与成果
└─ .tau/
   ├─ workspace-owner.json                 保留现有受管目录归属证明
   ├─ workspace.json                       工作区及会话元数据权威
   ├─ attachments.json                     共享附件元数据；新写入不含 messageRefs
   ├─ citations.json                       共享证据，保留 Registry 身份与历史 ID
   ├─ citation-snapshots/、geo-resources/、spatial-results/、video-resources/
   ├─ conversations/<conversationId>/
   │  ├─ plan.json                         本会话实际冻结计划
   │  ├─ attachment-message-refs.json       本会话附件消息关联
   │  ├─ canvas-contexts.json              本会话显式附加上下文
   │  ├─ geo-interactions/                 本会话 contexts、requests、message-refs
   │  └─ timing-metrics.v1.json            本会话执行耗时
   └─ migrations/workspace-v1/             旧元数据备份、校验信息与迁移报告
```

SESSIONS_DIR 可能与 user-data/sessions 不同，所有历史 key 均相对实际 SESSIONS_DIR。新目录只增加一级 transportx，仍兼容现有历史文件枚举深度。

状态权威固定为：workspace.json 管理会话存在性、名称、归属和计划指针；JSONL 管理消息、分支及 Pi 历史；领域 manifest 管理成果修订和提交；live map 管理当前进程状态。workspaces.json 只负责发现路径和管理操作恢复，不复制会话名称、默认配置或消息。

### 3.3 首版持久契约

以下为拟实施契约，字段名和状态须在 PR 1 评审后冻结。时间使用 ISO 8601；磁盘路径统一 POSIX，内存解析使用现有 path helper。

```ts
type WorkspaceCatalogV1 = {
  schemaVersion: 1;
  revision: number;
  entries: Array<{
    workspaceId: string;
    path: string;                         // 规范化绝对目录，POSIX 序列化
    creationRequestId: string | null;      // 旧目录登记为 null
    creationInputSha256: string | null;    // 不随后续名称/默认值编辑变化
    state: 'creating' | 'ready' | 'deleting' | 'deleted';
    deletion: null | {
      requestId: string;
      manifestRevision: number;
      historyKeys: string[];              // 删除前固定的受管历史集合
      invocationOwnerKeys: string[];      // 已核验目标摘要，不授予离线清理权限
      stage: 'frozen' | 'invocations-cleaned' | 'history-cleaned' | 'workspace-cleaned';
    };
  }>;
};

type WorkspaceManifestV1 = {
  schemaVersion: 1;
  id: string;
  revision: number;                       // 名称、归属、创建/删除、迁移等管理变更
  name: string;
  createdAt: string;
  updatedAt: string;
  defaultsRevision: number;               // 默认配置版本，独立于管理版本
  defaults: {
    domainId: string | null;
    modelSpec: string | null;
    profile: SessionProfileV1 | null;
  };
  citationRegistryId: string;              // 旧目录沿用 citations.json.sessionId
  conversations: ConversationRecordV1[];
};

type ConversationRecordV1 = {
  id: string;
  creationRequestId: string | null;
  creationInputSha256: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
  defaultsRevision: number | null;        // 旧会话无法证明时为 null
  modelSpec: string | null;               // 最近明确选择；旧值未知时允许 null
  appendSystemPrompt: string;             // 保留现有创建输入的恢复语义
  state: 'created' | 'ready' | 'start-failed' | 'deleting' | 'deleted';
  history: {
    key: string;                         // SESSIONS_DIR 内相对路径，创建时预留
    headerId: string | null;              // 读取有效磁盘 header 后才绑定
  };
  plan: null | {
    path: string;                        // 固定为 conversations/<id>/plan.json
    source: 'created' | 'legacy-workspace' | 'confirmed-current';
  };
  privateState: 'isolated' | 'needs-review';
  lastStartFailure: null | { code: string; message: string; at: string };
  deletion: null | {
    requestId: string;
    invocationOwnerKey: string | null;     // 目标摘要；空会话为 null，不代替 Owner 校验
    stage: 'frozen' | 'invocations-cleaned' | 'history-cleaned';
  };
};
```

约束：

- 新会话提交时 plan 必须存在且通过校验；plan=null 仅用于展示原计划丢失的迁移记录。旧目录无法证明的默认值保持 null，新建前要求补齐，不以当前配置冒充历史。计划/资源不可用的历史可迁入新结构并显示诊断，但不能因此获得激活资格。
- plan.source 必须随 API 和 UI 展示：created 为“本会话创建时冻结”；legacy-workspace 为“旧工作区现存计划，历史配置未经逐会话验证”；confirmed-current 为“用户确认后的当前配置，不能证明原配置”。用户确认不把后两者改标为 created。
- history.key 是预留地址，不表示文件存在；对外 sessionFile 投影在未落盘时允许为 null。headerId 已绑定而文件丢失时显示 history-missing 并阻止自动重建，以免覆盖或丢失原历史。
- created 表示尚未成功启动；ready 表示曾完成启动；start-failed 表示最近启动失败。三者都不是“进程正在运行”。closed 不持久化为单独业务状态。
- deleted 记录保留 id 和历史 key 作为防重新导入的墓碑，UI 不显示；完成清理后可清空标题、错误和附加 prompt 等非必要字段。
- catalog 的 deleted 记录保留已删除历史 key，避免工作区 Manifest 已移除后，遗留历史又被发现流程导入。删除请求先核对 requestId/完成状态，再判断 revision；同一已完成请求不因 revision 增加而报冲突。
- 工作区/会话名称沿用现有 120 字符限制；历史 key、plan.path 不接受客户端任意路径。history.key 不允许绝对路径、..、符号链接或越出 SESSIONS_DIR；计划固定在本会话子目录。
- UUID 不授予权限。Host 必须用定位表、真实路径、Manifest ID 和现有认证交叉验证；不能直接把请求中的 workspaceId 拼成目录。
- API Key、服务 token、PID、isStreaming、工具激活观察不写入 Manifest。动态工具开放仍从 Pi 有效分支记录恢复。

### 3.4 写入、重试与异常恢复

复用 [json-storage.ts](../src/server/util/json-storage.ts) 的原子写入、备份和租约机制；新增工作区级操作门禁，按真实目录串行化完整读改写。不得只串行最后一次 write，也不得认为 rename 能防止两个旧快照互相覆盖。

- 名称、会话创建/删除、归属与迁移决策使用 expectedRevision，成功后增加 revision。默认配置编辑只核对 expectedDefaultsRevision 并增加 defaultsRevision，不受运行活动影响；创建会话同时检查所使用的 defaultsRevision。所有变更在租约内重读最新内容，仅应用本次字段变更，冲突返回 409，不提交客户端整份旧 Manifest。
- lastConversationAt 从 Pi 历史摘要及当前 live 投影派生，不写核心 Manifest，不新增活动持久化服务。ready/start-failed、最后明确模型和错误等恢复信息可按既有同步时机串行落盘，但不增加管理 revision；updatedAt 表示管理/默认配置修改时间，不参与活动排序。runtime 事件的 hostGeneration/revision 沿现有协议，与管理版本无关。
- 同一 Host 的管理操作按工作区串行；同一台机器的不同 Host 对同一真实目录也要取得租约。现有 agentDir Writer 锁不能代替本机跨不同配置 Host 的工作区锁。目录锁、PID、nonce 不具备跨机器分布式租约语义；网络盘、NAS 和同步目录中的并发写入不在支持范围，不为其新增锁协议。
- 新建请求携带 requestId；同一 requestId 重试返回原工作区/会话，同 key 不同规范化输入返回 409。新工作区先在定位表预留路径与 creating 状态，再创建目录和 Manifest；现有工作区通过 conversation.creationRequestId 去重。
- creationInputSha256 对经过校验的完整创建输入做规范化哈希，包含目标、显式配置及默认值版本；去重先比较该不可变值，不能与后续已改名或更新配置的记录直接比较。重试不再次解析新默认值。
- 同一目录的完整管理流程先取得工作区门禁；仅在需要更新定位表时短暂取得 catalog 租约，禁止反向持有 catalog 锁再等待工作区，以免死锁。新目录分配先预留后释放 catalog 锁，再进入工作区流程。
- plan 先写入并校验，Manifest 原子替换是会话创建提交点；Pi 只在提交后启动。进程崩溃留下的未被 Manifest 引用的 plan 属于待核查元数据，不自动变成会话。
- 定位表创建成功但 Manifest 未提交：恢复页显示“创建未完成”，允许完成或放弃；只有确认目录由本请求创建且没有用户文件时才可清理。不能自动递归删除目录。
- Manifest 已提交但响应丢失：requestId 找回同一条记录。已提交但 Pi 未启动：仍显示 created，用户可启动。
- Manifest 损坏或版本不支持：保留原件，显示阻塞原因，不回退为空对象覆盖。通过已验证备份恢复必须显式进行。
- 已存在新格式迁移标记而 catalog 缺失/损坏时，先检查现有 .bak 并验证 schema、路径和删除记录；备份可解析不代表包含最新墓碑。无法证明恢复完整时进入只读恢复模式，扫描结果仅列为候选，不自动登记、激活、续作删除或清除墓碑。用户逐项核对后显式恢复定位表；疑似删除中的目录与残留历史继续隔离，不能按“发现了文件”推断仍有效。首次升级由第 8 节的迁移流程登记，不能把 catalog 丢失当成再次自动导入的理由。
- 自定义且无历史的目录无法保证自动发现，提供“重新登记已知受管目录”。目录改名、复制导致 ID/路径冲突时只诊断，不自动合并。定位表恢复使用已有备份机制，不新增第二份删除数据库。

运行租约和元数据写租约使用不同锁文件：前者覆盖 Pi 生命周期，后者只覆盖一次完整读改写。等待 Pi 停止或向 Pi 发 RPC 时不得持有 Manifest 写租约，否则退出回调无法持久化。实例切换/删除由生命周期队列串行，通过短写事务记录阶段；运行中的正常元数据更新仍可提交。实例退出回调必须核对当前实例代次，不能把新实例状态改回旧状态。

### 3.5 系统迁移记录

新增 user-data/migrations/workspace-v1/state.json，复用既有原子 JSON 写入和备份，不新增迁移服务进程或通用事务引擎。

| 字段 | 约束 |
|---|---|
| schemaVersion / targetWorkspaceSchema | 分别表示迁移记录格式和目标工作区格式；目标固定为 1 |
| scope | 当前实例实际 userData、agentDir、SESSIONS_DIR、默认/配置工作区根目录的规范路径；配置范围变化时对新范围补迁移 |
| systemReadiness | initializing / blocked / ready；由 Writer、Schema、可靠 catalog/墓碑和已提交的全局源清单共同决定，独立于各工作区转换进度 |
| phase | inventory / converting / needs-attention / complete，仅表示总迁移进度；未 complete 不等于所有业务不可用 |
| items | 每个源对象的稳定 ID、定位/摘要、阶段、目标、错误及 pending / converting / needs-review / failed / ready / isolated 状态；工作区内全部会话按一个发布单位处理，不存第二份消息正文 |
| report | 总报告与各工作区报告位置；包括已迁移、待处理、经用户确认隔离的对象及原因 |

systemReadiness=ready 后，新建独立工作区可用，items=ready 的工作区可用；其他旧工作区仅开放新迁移/修复入口。无需用户先确认所有异常对象。默认阻塞是保护状态，不等于用户同意隔离；只有明确确认后才标 isolated。phase=complete 仍要求全部源对象已迁入或明确隔离，不能隐藏问题来宣称迁移完成。

GET /api/workspaces 将正常记录和待迁移对象投影到同一列表，附 availability=ready/migrating/blocked/isolated、原因及报告入口；未转换对象不伪造可运行 Manifest。每个业务请求根据真实工作区和当前迁移状态重新校验，不能只信列表投影。涉及路径别名或重叠的工作区作为一个受影响集合阻塞，不能通过另一别名绕过。

该记录只承担全局安全门禁、迁移进度和追溯，不替代 Manifest。全局源清单至少记录已发现对象、待确认路径和保护范围；备份/转换各工作区可以随后进行。catalog、墓碑、Writer 或全局清单不能可靠读取/持久保存时 systemReadiness=blocked；单个文件损坏、缺目录、局部空间不足或归属歧义只阻塞相关对象。正常业务不读取未迁移旧私有状态。

## 4. 创建、恢复与切换流程

### 4.1 新建入口

入口只有两个：“新建独立任务”“在此工作区新建会话”。首版 UI 不要求用户先创建空工作区；工作区在删除最后一条会话后可以为空。

新建独立任务：填写工作区名称、首个会话标题、模型和模块配置。会话标题默认“首次分析”，允许修改；工作区名默认采用用户输入的任务名。沿用现有时间戳加安全名称的目录规则，不因展示改名而变化。

工作区内新建：预填该工作区默认配置，只要求填写会话标题；可展开模型、模块、研究范围进行覆盖。默认不把覆盖保存为工作区默认值，设置页另行修改默认配置。

完整服务端顺序：

```text
验证输入/模型配置/目录边界
  → 解析已有工作区，或预留并创建新目录
  → 校验 defaultsRevision，合并默认值与本次完整覆盖
  → 生成 conversationId，预留 history.key
  → 装配并验证本会话 plan，原子保存
  → 原子提交 Manifest：state=created
  → 返回已保存的会话，或继续显式请求激活
  → 取得工作区运行租约，通过原 ModuleTrust 流程启动 Pi
  → 成功为 ready；失败为 start-failed，保存可读原因
```

profile 覆盖沿用完整 SessionProfileV1，不增加深层 patch 合并规则；未传则使用工作区默认完整 profile。桌面、Web、CLI 新建均提交明确选择；旧计划中的 compat-default 作为历史数据原样保留，不保留省略 profile 的旧创建 API。

模块版本不可用、资产缺失、信任拒绝均保留原计划或已提交记录；不得自动切换版本。创建前能完成的静态校验尽量前置；创建提交后发生的失败通过启动状态展示。

### 4.2 空会话与历史绑定

新会话固定传 --session <SESSIONS_DIR/transportx/conversationId.jsonl>；Host 不另写消息或伪造 Pi header。首次产生有效 JSONL 后，核对真实文件、header.cwd 与计划，再写入 headerId。

Host 在启动、同步 Pi 状态、关闭和重启对账时均检查该预留路径。若 Pi 已落盘但 Host 尚未更新 Manifest，按预留 key 找回，不能只扫描时间戳猜测归属。

没有文件且 headerId=null 的 created/ready/start-failed 会话可按空会话重新启动，逻辑 ID 和标题不变。对外显示“暂无消息”，而不是伪造用户或 assistant 内容。

Pi 在首次 assistant 前的用户输入持久性是现有运行时边界；本方案保证空会话身份可恢复，不承诺所有未落盘输入可恢复。首次 CAD/Spatial 工具是否在有效 header 落盘后执行，必须在 PR 1 编码前通过第 9.1 节的真实 Pi 探针确认，不能仅在完工时验收。

若工具先于 header 落盘，暂停依赖该前提的实现，核查 Pi 原生持久化入口或调整首次执行流程，重新评审后再继续。禁止 Host 伪造 header/assistant 消息、降低 executionOwner 校验或自动重放领域操作。检测到首轮失败/中断且历史未落盘时提示状态；取消零用户消息过滤不能代替完整修复。

### 4.3 工作区运行排他

Host 按 canonical cwd 管理 WorkspaceRuntimeGate；门禁覆盖 Pi 启动、空闲、执行、压缩、问答等待、Pi 队列、停止及受管作业清理，不只覆盖 prompt HTTP 请求。

运行协调文件与锁位于固定用户配置目录的 `runtime-guards/`，使用平台 profile 的 home fallback，不随 `TAU_USER_DATA_DIR` 或 `PI_CODING_AGENT_DIR` 改变。锁不放在将被删除的工作区内部；目录删除后，仍可凭 catalog 中的固定目标查看诊断、核验代次并完成提交。删除目标另外保存目录身份及会话 ID 墓碑，不能对同路径重建的新目录继续递归清理。

1. 浏览另一条会话的历史不启动 Pi，也不停止当前运行。
2. 用户请求激活 B，若同工作区 A 空闲，等待 A 持久化、受管作业结束及进程树停止后，再启动 B。
3. A 正在执行、压缩、等待输入或有 steering/follow-up 队列：返回 workspace_busy，展示 A 和状态。用户可以返回 A，或明确选择“停止 A 并切换”；不能静默取消或转移队列。
4. 停止失败、进程是否退出无法确认：保留门禁，返回 process_stop_unconfirmed，不启动 B。受管作业终态与“结果 unknown”分别展示，不能把未知结果当作未执行。
5. 多窗口同时激活 A/B：在服务端串行后只允许一个实例；同 conversationId 的重复激活复用同一启动 Promise。
6. 同目录即使出现重复 workspaceId 或路径别名，也按 realpath 排他。本机跨 Host 租约必须在启动前获取，整个 Pi 生命周期持有；不承诺多机器通过共享盘使用同一工作区。
7. Host 崩溃后不能仅因锁内 PID 失效就假定 Pi/作业已停止。结合现有 supervisor/进程树清理及真实 Pi 故障探针确认停止，无法确认时阻止该工作区激活并提供下述恢复入口；不承诺任意 bash 脱管进程的 OS 隔离。

Extension 的调用沿 liveSessionId、token、当前计划和 terminating 校验；实例停止后旧 token 立即失效。资源只读浏览不获得新的执行 token。

运行阻塞页必须显示 process_stop_unconfirmed 的具体原因、工作区、锁代次、已识别 Host/Pi/受管作业及其最后核验状态、日志位置。提供“重新核验”和“停止已确认归属的进程并重新核验”；后者需用户明确操作，复用现有进程树停止机制，仅处理可证明归属的对象。PID 重用、归属未知或无法观测的进程不自动终止。

无法自动确认时，说明已知进程及在系统进程管理器中检查/停止的步骤；用户完成后重新核验，只有当前锁代次一致且相关 Writer/作业已确认停止才释放门禁。没有“忽略检查强制解锁”或直接删除锁文件的入口。该工作区不能执行期间，其他健康工作区继续使用；若是全局 Host Writer 冲突才全局阻塞。

## 5. 状态共享、资源读取与上下文

### 5.1 状态作用域审计

| 状态 | 目标作用域 | 实施要求 |
|---|---|---|
| 普通输入、上传原件、成果、CAD 修订 | 工作区 | 可在多个会话使用，保留领域 manifest 与哈希核验 |
| 附件元数据 | 工作区 | 增加上传来源 conversationId；跨会话可选择复用，不自动附加 |
| 附件 messageRefs | 会话 | 新记录带 conversationId，当前文本/时间戳匹配只在本会话关联集中执行 |
| 冻结计划 | 会话 | 每次恢复按记录的 plan.path 加载，不再读取工作区默认计划 |
| Canvas 显式附加、Geo contexts/requests/messageRefs | 会话 | 新会话禁止读取另一会话的私有 contextId；已发布资源文件仍可显式打开再附加 |
| thinking/tool 耗时 | 会话 | 避免 toolCallId 重名及每实例缓存覆盖共享索引 |
| Citation 来源版本与 Evidence | 工作区 | 保留 Registry ID、sourceVersionId、evidenceId；新证据可记录来源会话，不改旧 ID |
| Geo/Video/Spatial 资源 manifest | 工作区资源 | 逐项核查现有 sessionId 字段；来源会话标识不等于当前 live 授权；新字段须明确持久归属 |
| CAD/Spatial invocation | 原 Pi 历史 Owner | 不移动原 JSONL；不能仅按工作区或新会话查另一条会话的 invocation |
| 活动 Canvas 标签、选区、草稿、文档位置 | 会话 UI | 以 conversationId 保留；跨 live 重建可恢复展示偏好，旧请求响应不能落入新实例 |
| streaming、队列、等待问答、能力观察 | live 实例 | 切换时清理或完成，不伪造离线运行状态；实时能力仍来自 platform.getOverview 投影 |

所有“cwd 唯一索引”必须逐项登记并验收后才开放共享入口。不能假定同一时刻一个 Pi 就不需要拆分会话状态：先后运行也会串用关联，浏览器操作也可能并发写入共享索引。

这里的放行针对可达的具体入口，不要求 PR 2A 完成所有高级预览。PR 2A 必须完成全部会话私有状态隔离；任何未完成归属或权限校验的跨会话领域入口，在 UI、公共 API 和内部工具服务上均不开放，不能只隐藏按钮。已支持的本会话领域能力保留原有安全路径。

### 5.2 引用与资产权限

Citation Registry 可共享，文件读取仍由当前会话计划和真实资源范围决定：

- 工作区普通文件按工作区边界读取；来源版本继续核对 SHA-256、大小和 locator。
- 引用指向模块资产时，按当前读取会话计划验证 assetId、模块版本和授权根目录。无权限时可以显示受限的证据元信息，但不泄露绝对资产路径、内容或下载链接。
- 不能因证据由 A 登记，就允许未选择该资产的 B 读取。不能只过滤下载接口而让详情、预览或批量引用列表泄露原文。
- 原件变化继续使用 content-changed 等既有状态；不替换历史证据或自动保存所有文件快照。

上述规则是权限底线，不能因 PR 2B 后置而放宽。PR 2A 若开放共享引用或任何读取共享 Registry 的入口，必须同步完成其元信息、原文、预览及工具结果的授权过滤；无法安全开放则返回明确的不可用原因。PR 2B 增加跨会话复用体验和高级离线读取，不负责替 PR 2A 补已暴露接口的越权漏洞。

### 5.3 关闭会话后的只读浏览

历史消息浏览与激活 Pi 分开。PR 1 提供零消息和消息历史读取；PR 2A 提供工作区普通文件列表、基础读取/下载、附件选择与复用，不要求在 B 运行时完整离线呈现 A 的全部领域资源。

PR 2B 再补 Citation、Geo/Video、Document/Office、CAD 的高级离线预览；未支持的视图明确提示“此阶段需激活原会话查看”，经用户操作走正常排他流程，不能为了预览静默抢占 Pi。

资源上下文由 Host 根据 workspaceId + conversationId 生成：有活动实例时绑定真实 liveSessionId，无实例时构造经过计划核验的持久只读上下文；不能构造假的 PiRpcSession。公开资源统一从新 conversation 路由进入，复用底层解析，不保留 /api/live-sessions/* 旧路由。

历史计划缺失或完整性校验失败时，只展示可安全读取的历史及普通工作区文件；计划资产读取受阻，不能自动改用全局当前配置。CAD/Spatial invocation 查询仍需有效历史 Owner；普通成果查看不等于跨会话获得执行查询权。

### 5.4 新会话获得什么上下文

默认仅使用本会话 plan 中的范围、模块和工作区说明，以及共享文件入口；不把整个目录或其他会话全文自动放入模型上下文。首版复用附件库、文件打开和显式附加成果入口；跨会话摘要可由用户明确提供，不新增自动摘要服务。

共享文件会继续变化，冻结计划不等于冻结所有输入数据；可复现性仍依赖领域已有的内容哈希与提交 manifest。

### 5.5 分阶段资源边界

| 资源入口 | PR 2A 最低交付 | PR 2B 增量 |
|---|---|---|
| 消息历史、普通文件、上传附件 | 可独立浏览/读取，显式复用，路径和消息关联校验完成 | 管理与预览体验完善 |
| 当前活动会话的 Canvas/Geo/Video/CAD/Spatial | 私有状态隔离，沿原计划与 token 校验；不得退回共享私有索引 | 不改变该安全要求 |
| 其他会话的 Citation 与领域资源 | 仅开放已完成归属/授权核验的入口，其余在服务端拒绝 | 逐项验收后开放共享引用与高级离线预览 |
| CAD/Spatial invocation 查询与清理 | 保留原历史 Owner，验证首轮和恢复；不跨会话代查 | 增强资源入口，但不扩大 Owner 权限 |

关闭高级视图不影响普通成果文件在工作区内的显式复用；不额外构建通用资源网关。

### 5.6 历史资源链接投影

T3 必须抽样真实历史中的附件、Markdown 图片/链接、工具结果、Canvas、Geo/Video 与文档资源，区分地址是运行时生成还是已写入 JSONL/展示数据；抽样与实现结果见 P0 记录，不能仅凭静态搜索假定不存在旧 URL。

如存在 /api/file/raw 或含旧 liveSessionId 的持久 URL，新读取投影按“当前已验证 conversation/history 归属 → 已注册资源 ID 或受控相对路径 → 真实路径/哈希/当前计划权限”生成新地址。旧 live ID 不能证明归属，不做任意字符串替换，也不把旧认证参数带入新 URL。仅解析已知本地旧格式，不代理外部地址或接受任意绝对路径。

能够证明资源身份的历史链接在新 API 中可用；无法证明的显示“历史资源无法定位”及来源诊断，保留原文字/记录，不静默指向其他会话。不为此批量改写 JSONL 或保留旧 HTTP 路由。投影仅处理历史表示，底层始终由同一新资源服务授权；文档内部相对路径仍按原文档目录安全解析。

PR 2A 用固定真实历史样本验收新生成地址、图片/附件/文档/地图链接、哈希变化、跨会话拒绝与原 JSONL 字节不变。原活动会话可用的资源路径迁到新入口；高级无 Pi 离线视图仍可留在 PR 2B。验收须观察实际网络请求与打开结果，不仅搜索源码中的旧 URL。

## 6. 交互与 API 方案

### 6.1 界面行为

侧栏保留能力区 30% / 会话区 70% 和现有折叠规则；会话区改为“工作区 → 会话”两级。工作区显示名称、对话数、最近真实活动和运行状态；空工作区与空会话可见。工作区按子会话最近对话时间排序，无消息时回退创建时间，不因轮询和浏览文件顶到最前。

顶部标签表示已打开的逻辑会话，可以有多个；只有一个标签在同工作区拥有 live 实例。历史浏览与“继续对话”分开，前者不抢占执行。选中项持久化 conversationId，重连后重新获取对应 liveSessionId；晚到事件沿现有 hostGeneration/revision 门禁，并核对实例映射。

| 用户操作 | 首版行为 |
|---|---|
| 新建独立任务 | 新目录、新工作区、首个会话；提交后可重试启动 |
| 在工作区新建会话 | 同目录、独立计划与上下文；创建本身不打断正在执行的会话 |
| 继续会话 | 走运行排他流程；忙碌时由用户选择 |
| 修改会话标题 | 改 Manifest；JSONL 名称作为兼容投影按既有安全时机补写，不因旧名称覆盖持久标题 |
| 修改工作区名称 | 只改展示名；名称编辑旁说明实际目录不变 |
| 关闭会话 | 关闭标签并停止对应实例；忙碌时沿明确停止流程，保留历史 |
| 删除会话 | 单独确认；不提供“同时删除工作区”复选框 |
| 删除工作区 | 展示真实路径、会话数量和文件范围；进入独立删除流程 |
| 查看路径 | 工作区菜单和文件面板提供打开文件夹、复制路径 |
| 配置默认值 | 设置页编辑，保存后仅影响后续新会话 |
| 首次启动迁移与歧义处理（PR 1） | 全局就绪后进入工作台并显示迁移进度；待处理工作区单独修复，健康工作区及新建任务可用 |

沿用 semantic token、功能文字至少 11px、Light/Dark/Sand 与 i18n。业务“项目”字段文案改为“项目名称”，不重命名 SessionProfileV1.task.project 契约字段。

### 6.2 拟新增接口

新持久接口与现有运行接口分工：

| 方法与路径 | 输入或返回 |
|---|---|
| GET /api/workspaces | 工作区及会话摘要、运行投影、迁移/不可用诊断；包含零消息记录 |
| GET /api/workspaces/:workspaceId | 工作区详情、revision、默认配置及已登记会话 |
| PATCH /api/workspaces/:workspaceId | 名称使用 expectedRevision；完整 defaults 使用 expectedDefaultsRevision；首版一次只编辑一类 |
| POST /api/conversations | 统一创建，见下方输入；返回已保存记录，不把启动当作保存成功条件 |
| GET /api/conversations/:conversationId/history | 已保存元数据和现有 SessionSnapshot；未落盘时 entries=[] |
| POST /api/conversations/:conversationId/activate | 激活/恢复 Pi；明确的 stopCurrent 选择；返回运行 metadata |
| POST /api/conversations/:conversationId/close | 幂等关闭，等待 Writer/作业停止；保留持久记录 |
| PATCH /api/conversations/:conversationId | expectedRevision + name；返回新的 workspace revision |
| DELETE /api/conversations/:conversationId | requestId + expectedRevision；删除历史及私有状态，不删除共享文件 |
| POST /api/workspaces/:workspaceId/delete | requestId + expectedRevision；明确请求删除工作区文件及相关会话 |
| GET /api/migration | 系统迁移阶段、scope、进度和无法归属工作区的诊断项；迁移模式也可读取 |
| POST /api/migration/resume | 幂等恢复中断迁移；同一迁移任务只运行一份，不表示重做已完成对象 |
| POST /api/migration/resolve | requestId、reportDigest 与系统隔离项处理选择；不接受任意路径或绕过安全校验 |
| GET /api/workspaces/:workspaceId/migration | 工作区报告、reportDigest、来源与候选归属；迁移模式也可读取 |
| POST /api/workspaces/:workspaceId/migration/resolve | requestId、expectedRevision、reportDigest 与 bind/isolate 决策；迁移模式也可调用 |
| GET /api/conversations/:conversationId/snapshot | 持久记录与现有 Snapshot；运行投影可为空，不再通过旧 live-session 快照 URL 查询 |
| GET /api/workspaces/:workspaceId/runtime-diagnostics | 当前锁代次、归属/进程/作业核验状态、阻塞原因与日志位置；不返回服务 token |
| POST /api/workspaces/:workspaceId/runtime-recovery | action=recheck 或 stop-owned，携带期望锁代次；停止需用户明确操作，核验通过才释放 |

```ts
type CreateConversationInput = {
  requestId: string;
  workspace:
    | { kind: 'new'; name: string; parentDirectory?: string }
    | { kind: 'existing'; workspaceId: string; expectedRevision: number; defaultsRevision: number };
  name: string;
  model?: string;
  profile?: SessionProfileV1;
  domainId?: string;
  appendSystemPrompt?: string;
};
```

workspace 为互斥联合，禁止同时传 workspaceId 和父目录，也不接受裸 cwd 表示“猜测复用”。新工作区必须明确有效 profile/domain/model；新 UI 的 defaults 初始化为首个会话配置。

2026-10-25 实施确认：existing 工作区创建同时传 expectedRevision 与 defaultsRevision，分别校验管理版本和所用默认配置版本。相同 requestId 先核对不可变输入摘要并返回原记录，再对尚未提交的新请求做版本校验；不因已成功请求导致的版本增加而重复创建。

GET history 的 entries 沿用现有消息契约，不新增第二套消息对象。新只读资源接口统一使用 /api/conversations/:conversationId/ 下的命名空间：PR 2A 只交付 files/attachments 的基础入口，citations、geo-resources、video-resources 等高级离线映射在 PR 2B 逐项验收后启用。参数、下载与错误码复用既有实现，不开放任意资产路径入口。

新 UI 的 Kernel command port 调用以上持久接口；发送 prompt、steer、follow-up、Extension UI 回答和服务工具继续用 liveSessionId。Browser Kernel 增加持久索引及 conversationId → liveSessionId 映射，组件不直接调用 fetch 或拼 RPC。

主要错误：workspace_busy、workspace_revision_conflict、workspace_missing、workspace_identity_conflict、history_missing、history_identity_mismatch、metadata_corrupt、private_state_ambiguous、process_stop_unconfirmed；计划和模块错误沿用现有码。响应提供可执行的下一步，不能把未知结果自动转换为重试。

### 6.3 API 与 CLI 一次切换

旧数据迁移解决存储兼容，不通过旧 HTTP 入口或日常恢复分派解决。正式切换时同版桌面、Web、CLI 全部使用第 6.2 节的新契约；删除旧实现及其专用输入类型、Kernel command 和调用分支，不保留旧 API 转发器。

| 旧入口 | 切换后的唯一入口 |
|---|---|
| POST /api/live-sessions | POST /api/conversations，再 POST /api/conversations/:id/activate |
| POST /api/live-sessions/resume，按 filePath 恢复 | 迁移时绑定 history.key；运行时仅按 conversationId 激活 |
| GET /api/live-sessions 及其 metadata/snapshot 入口 | GET /api/workspaces 的运行投影及 GET /api/conversations/:id/snapshot |
| /api/live-sessions/:id 下的公开文件/引用/领域资源路由 | /api/conversations/:id/ 下对应资源入口，Host 内部解析 live 绑定或持久只读上下文 |
| /api/sessions/:id 下的 Geo/Canvas 上下文、截图及交互响应 | /api/conversations/:id/ 下对应操作；写操作同时核对当前 live 实例和请求归属 |
| /api/files、/api/file/content、/api/file/raw、/api/file/preview、/api/session-resources | /api/conversations/:id/files 及对应 content/raw/preview/resources 子入口，不接受 sessionId 作为公开资源身份 |
| /api/search 的旧历史结果、/api/open 的会话文件分支 | /api/conversations/search 返回持久 ID；会话文件由 /api/conversations/:id/open 打开 |
| GET /api/sessions、GET /api/projects、/api/session-history、旧按文件取历史入口 | GET /api/workspaces 与 GET /api/conversations/:id/history |
| POST /api/sessions/delete、DELETE /api/live-sessions/:id | 新 conversation close/delete 与独立 workspace delete |
| set_session_name 的旧 filePath/sessionId 管理入口 | PATCH /api/conversations/:id；名称管理不再通过运行实例定位 |

Pi RPC、WebSocket 运行事件和 /api/internal/* 领域工具通道继续使用 liveSessionId、服务 token 与原 Owner 校验；它们是同一系统的执行协议，不是第二套用户会话管理 API。改造其上游归属解析，不为统一 URL 重写 Pi 或领域工具协议。移除公开旧路由后不保留行为转发；旧客户端需升级，不能继续操作新数据。

鉴权、模型、Module 管理及无会话身份的通用接口不因本次整改另建副本。报告等通用操作若原输入依赖 sessionId，改为接收并核验 conversationId；不保留旧身份输入分支。T3 清单必须覆盖表外的会话消费者与资源 URL 生成器，不能只删除创建/恢复两条路由。

CLI 目前只有一份 transportx.ts，本次同步修改它调用新 API，不另建“新版 CLI”。--cwd 保持父目录语义，但直接组成 workspace.kind=new/parentDirectory 输入；若以后添加复用入口，必须显式传 workspaceId。关闭通过 conversation close，prompt/abort 等仍向当前 live 实例发送。命令行参数可保持使用习惯，不等于维护旧 HTTP 调用。

切换时同步提升 AGENT_HOST_PROTOCOL_VERSION；平台发布版本按届时 CHANGELOG 纪律确定，本次不改版本号。版本互操作承诺区分两种方向：

- 新客户端连接旧 Host：调用业务前检查 health 协议版本和就绪字段，缺字段/版本不符即停止并显示“Host 版本不兼容，请升级或重启”，不尝试旧接口。
- 旧客户端连接新 Host：优先保证失败安全；旧路由不存在。新业务写 HTTP 要求当前协议版本头 X-TransportX-Protocol，WebSocket 在执行命令前完成当前版本握手，缺失/不符统一拒绝且不产生数据修改；迁移/修复写接口同样适用。对能识别的客户端返回 unsupported_client/升级说明，不能保证任意旧版本能够正确展示。

版本检查不替代认证、token 或资源权限。普通图片/文档 GET 使用新服务的认证与资源校验，不强迫浏览器图片请求设置自定义头；内部工具继续走原服务 token，不混入浏览器协议握手。PR 2A 必须测试新客户端/旧 Host、旧客户端/新 Host，而非仅验证同版正常连接。

### 6.4 首次启动与升级体验

新版 Host 首次启动统一清点已知旧数据，覆盖桌面、Web 和 CLI；安装器只更新程序，不推测用户目录。后续按 scope、schema 和未完成记录继续；新增旧目录仍调用同一迁移器，不启用旧 API。

现有 Host 在 Writer 租约后、listen/ready 前做 Citation 扫描。本次需要进度和修复界面，改为先开放经认证的 health、静态 UI 和迁移入口，再区分两个就绪层级：

| 层级 | 条件 | 可用范围 |
|---|---|---|
| 全局 initializing | 校验 Writer、Schema、catalog/墓碑，提交源清单及保护路径 | 仅启动状态、认证和迁移/诊断白名单 |
| 全局 blocked | Writer 冲突、全局索引/墓碑不可验证，或全局状态无法可靠落盘 | 全局停止普通业务，修复入口可达，不以忽略错误放行 |
| 全局 ready，工作区 pending/converting/needs-review/failed/isolated | 全局基础可靠，该工作区尚未通过转换/校验 | 新建独立工作区及其他 ready 工作区可用；受影响工作区仅迁移/只读报告/诊断 |
| 全局 ready，工作区 ready | 该工作区全部会话归属、计划指针与私有状态已验证提交 | 通过唯一新 API 正常浏览、创建、激活及执行；具体计划/资产错误仍独立校验 |

health.dataState=initializing/blocked/ready 对应 systemReadiness；另返回迁移 phase 与 pending/blocked 数量，两者不混用。ready-json 只表示地址可连接，Supervisor/CLI 同版理解就绪状态，不因长迁移超过现有启动等待而反复重启 Host。

全局 ready 后直接进入工作台，展示不阻塞的迁移进度与待处理数量。迁移器逐工作区持有门禁，分步处理并让出事件循环；只阻塞正在转换或有冲突的目录，不持有全局 catalog 写锁等待用户或执行长转换。新增工作区不得与 inventory 保护路径或其别名重叠。

全局未就绪时，服务端拒绝普通业务，返回 system_not_ready；全局就绪后，针对未就绪工作区的业务返回 workspace_migration_required 并附新报告入口，针对正常工作区照常处理。鉴权、目标状态和路径重叠均在服务端复核；不能只禁用 UI。旧路由在所有状态下均不提供运行服务。

交互 CLI 仅对本次目标工作区提供迁移/resolve 选择；非交互模式若目标被阻塞，返回原因与报告位置，不自动确认或发送 prompt。无关历史待处理不阻塞 CLI 新建独立任务或使用健康工作区。CLI/桌面使用同一迁移与恢复 API，不新增第二个后端。

异常工作区修复或明确隔离后更新其状态；无需为了进入工作台而批量确认全部历史。全局 phase=complete 仍表示清单全部已处理，是进度结果而非普通业务启动条件。

## 7. 关闭、删除与写入失败

### 7.1 两类删除共用的四个阶段

1. **预检与冻结**：在工作区生命周期门禁内校验用户确认、revision、真实路径、历史绑定及占用；停止接收新写入，等待 pending start/resume、Pi Writer、受管作业和交互停止。停止不明则不执行不可逆清理。停止后重新枚举并核对目标，避免漏掉最后落盘的历史。
2. **持久化删除目标**：使用仍存在的工作区、计划和 JSONL 核验 executionOwner，保存固定 historyKeys、Owner 摘要与 stage=frozen；单会话放在 Manifest，工作区级放在 catalog。空会话无文件且从未绑定 header 时无 invocation Owner；历史意外缺失/不匹配则阻塞，不伪造 Owner。记录提交前不得删除任何依赖文件。
3. **执行不可逆清理**：统一按“invocation 元数据 → JSONL → 私有状态/工作区文件”顺序执行。invocation 清理在工作区、计划和 JSONL 均可核验时完成；每阶段完成后原子保存 stage，写入失败不得开始下一阶段。某阶段内部分清理失败可幂等重做，不能把失败记为完成。
4. **完成或恢复**：全部清理成功后标记 deleted 墓碑；否则保留 deleting、阶段和错误。重启只从已提交阶段继续，不重新扩大目标，不将缺失文件视为 invocation 已清理的证明。

首版不新增“仅凭 Owner Key 离线删除 invocation”的通道。invocationOwnerKey 是审计/目标核对摘要，不替代真实 executionOwner 校验。阶段达到 invocations-cleaned 后才允许删 JSONL，达到 history-cleaned 后才允许清理其余私有状态或工作区；因此正常恢复不需要在依赖已删除后再次调用 Owner 校验。若依赖因外部操作提前丢失且阶段未完成，保留阻塞诊断，不能跳过校验。未来若需要离线清理，必须另行证明其授权、目标边界和重复执行安全。

### 7.2 删除会话

按四阶段处理；stage 与 requestId 保存在会话 deletion 中。依次完成 invocation 清理并保存 invocations-cleaned，删除 JSONL 并保存 history-cleaned，最后清理本会话私有状态并标记 deleted。Manifest 留在工作区内，不会随私有状态删除而消失。

共享附件、分析文件、引用与报告全部保留，不根据“看起来未使用”自动清理。迁移备份独立保留，提示其与日志的保留范围，不宣称彻底擦除。历史扫描检查墓碑，重复请求不能重新导入已删除记录。

### 7.3 删除工作区

四阶段目标固定在 catalog 中，目录删除前另核验 workspace-owner、其他历史/live/starting 会话、路径别名与嵌套占用。发现目标外引用或重叠则拒绝；workspace.json 不授予递归删除资格。

顺序固定为：清理全部已核验 invocation 并提交 invocations-cleaned → 删除固定历史集合并提交 history-cleaned → 复核目录归属、沿现有递归删除/失败恢复逻辑清理工作区 → 提交 workspace-cleaned 并标记 deleted。目录先于历史删除的旧方案作废。

catalog 的阶段记录不在被删除目录内；中断后不依赖已移除的 Manifest 才能继续。每阶段的故障注入必须证明：未提交前依赖尚在，提交后重试不再调用依赖已失去的核验。stage 不能消除非原子文件删除的失败，只限定继续条件。

归属证明缺失的迁入目录可保留文件并删除其已核验会话；物理删除仍满足原有受管目录证明。全局未就绪或目标工作区未就绪时，其普通删除入口关闭；无关 ready 工作区不受影响。隔离对象只提供修复/隔离管理，不能因迁移器记录了路径而获得递归删除资格。

## 8. 首次启动清点与工作区独立迁移

### 8.1 范围、就绪与部分可用性

新版 Host 首次启动统一清点实际 SESSIONS_DIR、已有 catalog、默认/配置根目录及历史 header.cwd 指向的已知目录，零用户消息历史也纳入；不扫描整块磁盘、不跟随符号链接。未知且没有配置/历史线索的文件夹不承诺自动发现。

先验证全局 Writer、Schema、catalog/删除墓碑并提交 inventory、稳定 ID 和受保护路径，再将 systemReadiness 置 ready。随后正常工作区和新任务可用，逐工作区转换继续进行；一处损坏历史不要求用户先确认隔离才能进入应用。catalog/墓碑不可信或全局状态不可持久化仍全局 blocked，不能用部分可用性绕过全局安全条件。

全局清点限于目录/文件元信息及有界 header 读取；完整 JSONL 解析、字节哈希、资源校验和备份在目标工作区阶段执行，不把全部大历史读取塞进全局 ready 前。单文件读取/解析失败登记为问题项，不直接中止整个清点；若失败使共享索引、唯一性或保护边界本身不能证明，才升级为全局风险。

同一真实目录中的全部会话作为一个转换发布单位，不能先发布其中一条再继续用旧私有索引。pending/converting/needs-review/failed 的工作区单独阻塞；路径别名/重叠对象一起阻塞。无合法 header 的文件保留为诊断项，未知身份不伪造 Manifest；它不因此获得激活入口。确认其不能损害全局索引/目标边界后，其余对象可继续。

以后新配置范围/登记旧目录仍使用同一迁移器。未完成对象只走新迁移/报告 API，不回退旧日常恢复；新建工作区在新命名空间登记，补扫时按 schema/index 排除，不能把它重新当作旧源导入。

### 8.2 单工作区转换与提交

1. **冻结目标**：取得本机目录门禁，确认目标旧 Pi/作业停止；无法确认只阻塞本目录并进入运行诊断。Host Writer 冲突则全局阻塞。其他健康工作区可执行，不要求它们为本目录迁移停机。
2. **固定身份和源版本**：以源清单分配的 workspaceId/conversationId、history key/header.id/cwd、路径与摘要确认输入。重复 header.id 不合并不同文件；源变化则暂停本对象并重新清点。
3. **空间预检与精确备份**：按第 8.3 节生成将修改文件的清单、目标和大小，在各卷预检空间后才写入；完成备份并核验。新目标仅写暂存；源 JSONL、业务文件和领域资源不搬迁、不改写。
4. **完整转换**：单/多历史和空历史同一流程生成记录、独立计划及附件/Canvas/Geo/耗时私有状态；共享文件、引用/资源 ID、Owner 保留。计划未知保留诊断，不推测过去配置。
5. **校验或局部阻塞**：验证历史数量/字节、归属、计划指针、资源定位和私有隔离。歧义/损坏/失联对象标 needs-review/failed，UI 可修复或明确隔离；不会阻塞其他工作区，也不能静默跳过本目录的问题。
6. **工作区发布**：验证通过后以 Manifest 原子提交为发布点，再更新 catalog/items 并标 ready。中断时按已保存 ID 和摘要恢复；不能在 catalog/目标校验完成前激活，也不在已发布目录恢复旧写入分派。
7. **汇总进度**：所有对象 ready 或经用户明确确认 isolated 后才标 phase=complete；未达到 complete 可以继续使用健康对象。默认待处理状态不是用户同意隔离，报告持续展示剩余问题。

原计划优先取 resolved-session-plan.v3.json，否则 resolved-session-plan.json；按原 schema 规则转换并标 source=legacy-workspace。现存一份计划不能证明各会话初始配置，API/UI 保留该标识。缺失/损坏计划保留原件和诊断；仅原 legacy_plan_requires_confirmation 认可情形可显式确认当前配置并标 confirmed-current，不将所有错误绕过。

默认模型/范围未知时保持 null，新建前补齐；名称与缺失时间按报告中明确的回退依据处理。迁移器只建立可证明的新归属，不恢复无法证明的历史事实：初始模块、未落盘消息、歧义附件来源都不能推断补齐。Pi JSONL 继续作为原生消息权威，不另建旧业务 API 或消息库。

### 8.3 精确备份与空间预检

禁止递归备份整个 .tau。每个工作区转换前生成 backup-manifest，逐项记录源/目标、是否覆盖、原大小与 SHA-256、预计新大小、备份位置及核验结果；只备份本次实际覆盖/改写的原文件。备份失败或未验证前不得覆盖，重复尝试复用经摘要确认的备份，不无限追加副本。

| 对象 | 保护方式 |
|---|---|
| 将被改写的 attachments.json、citations.json 或其他旧 JSON 元数据 | 按精确清单备份原字节；Citation 复用现有专用迁移，不再并发运行第二份扫描 |
| 原计划、Canvas/Geo/耗时旧索引，只读取并复制到新作用域 | 原件保留，清单记录大小/哈希；没有覆盖就不再复制为备份 |
| 新 Manifest、plan、私有索引等原来不存在的目标 | 记录“原目标不存在”，暂存验证后提交；意外已有目标须核对，不能直接覆盖 |
| catalog、系统迁移记录等共享元数据 | 使用原子写入/.bak 并记录版本；不能把新 catalog 中后来创建的健康工作区信息回滚掉 |
| Citation 快照、Geo/Spatial/Video 资源、CAD、上传原件与其他业务文件 | 原件保留，沿已有 manifest/大小/哈希核验；不整目录复制，不为未修改的大文件重复做备份 |
| 确实必须修改某份资源文件 | 加入单独的修改及备份清单，估算实际字节；没有经确认的转换规则则阻塞该对象，不能临时扩大迁移范围 |

空间按实际备份卷、目标工作区卷和 user-data 卷分别计算：所需空间 = 原件备份字节 + 新元数据字节上界 + 原子替换/.bak 的峰值临时字节 + 预检报告列明的余量。余量至少 16 MiB 且不少于前三项合计的 10%，用于文件系统与日志波动，不作为可承诺的硬盘配额。

不足或无法可靠查询时不开始该工作区转换，显示所需/可用空间、卷与路径，保留原件；若全局索引/日志无法安全落盘则全局 blocked。其他程序仍可能抢占空间，因此运行中 ENOSPC 也须按原子写入/阶段恢复处理，不能只依赖一次预检。用户清理后显式重试，不自动删除资源腾空间。

### 8.4 私有状态与歧义闭环

| 情况 | 处理 |
|---|---|
| 单历史目录 | 可校验私有状态归该会话，保留旧原件，只写新会话子目录 |
| 多历史中有唯一证据 | 按完整消息/显式资源关联分配，不仅凭文本或 toolCallId |
| 无法证明的关联 | needs-review，显示来源、候选与理由，不复制给全部会话或交给模型 |
| 明确确认隔离旧关联 | 原件/报告保留，建立新的空私有状态；消息、共享文件和成果不删 |
| 旧路径、旧 ID、旧 URL | 迁移归属与状态，历史 URL 由第 5.6 节的受控新读取投影解析，不保留旧运行路由 |
| 缺字段或损坏 | 标未知/不可用，不伪造历史事实，不把非空坏文件初始化为空 |

工作台与 CLI 通过同一迁移报告/resolve API 操作。bind/conversationId 必须由服务端根据源摘要、消息/ID 与边界重新验证；无法证明只能隔离。reportDigest/revision 防止过期覆盖，requestId 保证重复提交幂等。客户端不传任意路径，隔离不等于删除。

决策在门禁内生成新状态并记录报告，Manifest 最后提交；受影响工作区只有状态校验通过才 ready。用户可暂不处理，继续用其他健康工作区。全部隔离选项需要明确确认，不作为进入应用的强制前置；isolated 对象以后仍可从新修复入口恢复。

源文件与报告保留可追溯。privateState=isolated 只读本会话新私有目录；任何新/迁入会话都不回退工作区级旧关联索引。迁移/运行锁不能核验时走第 4.3 节的产品恢复入口，不提供跳过检查继续。

### 8.5 中断、并发与升级失败恢复

逐工作区保存稳定身份、源摘要、备份清单和提交阶段；这是局部可恢复转换，不是整组文件的原子事务。中断后验证已完成目标，只重做未完成阶段，不新增第二份目录或 ID。迁移 Writer 与正常业务在同一目录排他；catalog 只持有短写租约，不等待用户或长 I/O。

已发布工作区随后可产生新对话/成果，其他对象迁移失败不能恢复整份旧 catalog 或全局备份，把这些新记录覆盖掉。恢复只撤销本次未发布对象的确定写入，并在租约内合并共享索引；无法证明归属的临时文件保留诊断。已发布对象修复也须先停其 Writer，不能回到旧运行路径。

catalog/全局标记损坏时先核对备份、Manifest、源清单和墓碑；不能当首次安装重新导入。仅源对象损坏则局部阻塞；全局唯一性、墓碑或共享索引无法证明时才全局 blocked。scope 增量只处理新范围，原 ID 不重算。

现有 Citation 启动扫描/恢复补迁移由同一启动协调器安排到目标转换中，避免并发改写同一源。正常业务启动后不再全量扫描旧私有状态；需要的数据 schema 升级仅由同一专用迁移器处理。

升级失败可回到新诊断页、重试局部迁移或恢复经验证的局部备份；这不意味着程序自动降级或开放旧 API。若需安装旧版本，必须先停全部进程，评估健康工作区的新写入并保留其历史/成果，再按报告处理；不承诺直接整库回滚。旧格式导入器保留用于以后登记，不成为日常 fallback。

## 9. 分阶段实施与验收

所有条目均为待验收。本次只修订方案，不改运行代码、执行迁移或提升版本。实现走分支 → PR；Module 实际改动仍独立升版本。

开发顺序为“技术验证 → PR 1（新结构/API/迁移器）→ PR 2A（核心多会话与全部客户端）→ PR 2B（高级预览）→ PR 3（管理体验）”。PR 1 可以单独评审，但不能单独合入可发布的 main；PR 1/2A 先合入同一集成分支，完成构建、兼容方向、迁移及端到端验收后，通过一次完整合并进入 main。主分支、可发布标签及安装包不得出现“新服务端 + 旧客户端”的中间状态，不为开发阶段增设旧 API 转发器。

统一发布同时替换桌面 Renderer、Host、CLI 和 Web 静态资源；按同一构建/协议标识校验，旧窗口、缓存页面或外部 CLI 不匹配时停止写入并提示可识别的升级路径。PR 2B/3 不阻塞核心切换；用户的全部历史是否已处理完不是发布或业务就绪条件。

### 9.1 技术验证：PR 1 编码前置条件（P0）

先验证 Pi/Host 技术前提，可编写局部探针，不开始生产生命周期改造。运行证据记录于 P0 记录，不能依据源码推断通过。

| 编号 | 探针 | 必须取得的证据与失败处理 |
|---|---|---|
| T1 | 真实 Pi 空会话与预留路径 | 无输入、首轮失败/中断、正常首轮分别记录有效 header 首次出现时机及 --session 绑定；不覆盖已有非空历史 |
| T2 | 首轮 CAD/Spatial 执行 Owner | 两个全新会话分别以 CAD、Spatial 为首个领域请求，走真实 Pi + 生产 Host；在首次工具派发/Host 接收时记录 header、cwd、plan 与 Owner 成功证据、实际结果及重启后一致性 |
| T3 | 状态、API 与客户端调用审计 | 完整调用图覆盖 Host/Extension、Kernel/Web/CLI、资源 URL 与迁移钩子；抽样真实历史确认持久链接与动态链接，逐项安排新投影/入口及验收 |
| T4 | 本机运行及迁移门禁原型 | 两个 Host 对同目标只允许一个 Writer/Pi；未确认旧进程停止不接管；全局风险阻塞业务、局部迁移风险不阻塞健康工作区，恢复诊断可达 |

T2 失败先验证 Pi 原生持久化能力或重新评审首次执行顺序，不能降低 Owner 校验、预写假 header 或以已有历史代替新会话。T3/T4 失败先调整作用域和门禁。证据记录 Pi/Host 基线、时间序列、实际结果和平台；fake Pi 不替代 T1/T2。

### 9.2 PR 1：新数据结构、唯一 API 与系统迁移（P0）

范围：持久身份、catalog/Manifest、独立计划/私有路径、空会话恢复、关闭/删除；唯一新 API、全局/工作区两级就绪、逐工作区迁移器、精确备份与空间预检，包含旧多历史与 bind/isolate 最小界面。删除旧公开路由/适配器，不保留日常旧格式恢复。集成分支内暂不开放第二条会话创建，待 PR 2A；本 PR 不单独合入 main。

主要文件：contracts 新契约；Host 元数据与迁移实现；session-workspace、assembly、history、metadata、Pi launch、状态存储及 api-routes；启动协调、Supervisor/CLI ready 消费；迁移页与 Kernel 管理端口。复用 Pi/领域原生协议，不重写 Agent Loop。

| 编号 | 场景 | 通过标准 |
|---|---|---|
| A1 | 打开/取消表单；创建后零输入 | 前者无目录，后者有可列出的稳定 workspaceId/conversationId |
| A2 | 空会话切换、关闭、刷新、Host 重启 | 分别验证标题、配置与 ID 不变，entries=[] 不依赖 Pi 文件存在 |
| A3 | Pi 启动失败/信任拒绝 | 已保存记录可见并可重试，不重复目录、不自动换模块 |
| A4 | 迁移与创建任一步写入失败/崩溃 | 稳定 ID、备份和阶段可恢复；未提交源不丢失、源变化不带入过期结果，不重复转换 |
| A5 | 重复启动、请求及响应丢失 | 同数据范围仅一个迁移 Writer；同 requestId 幂等，不同输入冲突 |
| A6 | JSONL 落盘与 Manifest 绑定之间崩溃 | 由预留 key 找回并校验 header；已绑定文件缺失不被重建覆盖 |
| A7 | 关闭/删除/恢复竞态 | Writer/作业停前无清理；删除依赖顺序及阶段正确，共享资料保留 |
| A8 | 已知单历史/多历史/空历史/无历史样本迁移 | 每个源对象可追踪为 ready/待处理/隔离，状态准确；JSONL 字节、路径、引用 ID 和 Owner 不变，不伪造原计划 |
| A9 | 歧义、损坏、缺目录与两级门禁 | bind 验证、isolate 确认、原件保留；仅目标工作区阻塞，不要求先处理全部异常；全局索引/墓碑不可信则全局停止业务 |
| A10 | 版本、catalog 与入口一致性 | 活动不引发管理 409；catalog/备份不可信不复活墓碑；旧公开路由/旧输入适配被删除，无 filePath 旧恢复 fallback |
| A11 | 大型 .tau、跨卷空间不足与运行中 ENOSPC | 只备份实际改写元数据，不复制视频/资源目录；预检按卷列清单和峰值，空间不足不开始目标转换；中断不破坏原件 |
| A12 | 29 个正常工作区 + 1 个损坏工作区 | 无需确认隔离第 30 个即可使用已迁移目录及新建任务；局部恢复不覆盖其他工作区新增记录；全局 phase 未 complete 不误报为全局不可用 |

放行至集成下一阶段：T1–T4、A1–A12 全通过，真实 Pi 复验新结构下首次领域 Owner 与中断，两级门禁和逐工作区恢复完整。歧义 UI/多历史转换能力不得后置；用户未处理的个别历史可继续留在新诊断状态，不阻止后续集成。

### 9.3 PR 2A：核心共享与客户端统一切换（P0）

范围：开放同工作区多会话，完成全部私有状态隔离、运行排他、独立计划/默认值、基础文件/附件读取与复用、侧栏/标签及 Kernel 身份映射。桌面、Web、CLI 改用唯一新 API；CLI 只有一条实现路径。当前活动会话的已有领域能力迁到新公开资源定位下；未完成校验的高级跨会话入口在服务端关闭。

主要文件：持久服务与运行门禁；附件、Canvas、Geo、耗时及已开放 Citation/领域权限；Kernel commands/stores、App/Sidebar/Tabs、资源 URL、transportx.ts、测试 harness。删除旧端点消费者、陈旧命令类型和旧测试预期，不保留 fallback 代码。

| 编号 | 场景 | 通过标准 |
|---|---|---|
| B1 | 同工作区 A 整理、B 分析、C 写报告 | cwd 相同，三份历史/计划独立，可显式复用文件，不继承他会话全文 |
| B2 | 不同模块及默认值变更后恢复 | 各自计划不变，新会话用新默认；缺版本明确拒绝，不自动替换 |
| B3 | 同文本/时间/toolCallId 的私有状态 | 附件、Canvas/Geo 关联及耗时不串用，他会话 contextId 被拒绝 |
| B4 | 无资产权限或未开放的共享入口 | API、预览、工具结果不泄露原文/路径；未支持入口由服务端拒绝 |
| B5 | 本机多窗口/多 Host 同时激活 | 最多一份 Pi，重复激活复用启动；忙碌、压缩、等待、队列不静默丢弃 |
| B6 | 停止切换、超时、Host 崩溃与恢复 | 原因/进程/作业/日志可见；重新核验、明确停止已确认归属进程后安全恢复；未知归属不杀、锁代次过期拒绝，无强制忽略检查；其他工作区可用 |
| B7 | B 运行时浏览 A 历史与普通文件/附件 | 不启动 A；共享可用、私有关联隔离，未支持高级预览明确提示 |
| B8 | 删除会话及整个工作区，分阶段中断 | 先 invocation 后历史再目录；阶段写失败不前进，重试不访问已删依赖，不误删其他会话 |
| B9 | 迁入的旧多历史目录继续与新增会话 | 仅经新 API 恢复并增加新会话，旧关联隔离后不串用；不存在旧写入分派或半迁移对象被激活 |
| B10 | 桌面、Web 与交互/非交互 CLI | 只请求新端点；CLI 仅在目标未就绪时阻止 prompt，无关异常历史不阻塞新任务；进度可达，无超时重启循环 |
| B11 | 真实历史资源 URL 与展示恢复 | 附件/图片/文档/地图等新地址实际打开；失配/越权正确拒绝；不请求旧路由、不改原 JSONL 字节，不将旧 live ID 当授权 |
| B12 | 新客户端/旧 Host、旧客户端/新 Host | 前者业务前显示不兼容；后者缺版本头/握手不写数据，对可识别版本提示升级，不承诺任意旧 UI 能理解错误 |

主分支合并/发布门槛：A/B 全部通过，完整调用图中的桌面、Web、CLI、历史资源和执行响应均端到端验证。静态搜索仅辅助；以实际网络/命令跟踪确认全部已支持流程的旧业务端点请求数为 0，旧消费者/转发器/日常旧写入分支无残留，协议不匹配不能误写新数据。记录健康/异常工作区并存的升级结果，验证同一构建的各组件，再一次合入 main 并发布。高级离线预览不阻塞，用户全部历史处理完也不是前提。

### 9.4 PR 2B：高级资源与离线预览（P1）

范围仅为共享 Citation 与领域复用体验、Geo/Video、Document/Office、CAD 高级离线预览及其安全验证。迁移器与旧多历史处理能力已随切换交付；尚未处理的对象继续由同一入口修复，不新增第二轮旧数据机制，也不补 PR 2A 安全缺口。

| 编号 | 场景 | 通过标准 |
|---|---|---|
| D1 | B 运行时离线看 A 的引用/领域成果 | 不启动 A；各入口授权/哈希有效，晚到响应不污染 B |
| D2 | 从已迁入旧历史打开高级成果 | 使用同一新 API 与既有资源 ID；原计划可信度标识保留，无旧 API fallback |
| D3 | 跨会话复用资产引用 | 新会话未选资产时元信息/原文/下载权限不扩大 |
| D4 | 缺失、变更及过期资源 | 既有 missing/content-changed 等状态准确，不替换历史证据 |
| D5 | 历史计划不可用或执行 Owner 不匹配 | 允许范围内只读，资产/执行查询明确受阻，不以 workspaceId 替代 Owner |
| D6 | 新增预览请求取消/切换/重连 | 不启动隐式 Pi、不重放领域操作、不改变系统迁移完成标记 |

逐资源通过 D1–D6 后开放对应入口，不再改变核心数据/API 切换策略。

### 9.5 PR 3：管理体验（P1）及后续 P2

P1：工作区展示改名、路径复制/打开、零会话说明和旧目录整理体验。迁移进度/修复在 PR 1，分组/错误反馈在 PR 2A，不能拖到本阶段；不新增归档体系。

| 编号 | 场景 | 通过标准 |
|---|---|---|
| C1 | 工作区/会话分别改名 | 互不联动，重启保留，目录不变且说明可见 |
| C2 | 打开/复制路径、以后登记旧目录 | Host 校验路径；调用同一迁移器，不启用旧 API、不扩大递归删除资格 |
| C3 | 三主题、窄屏、中英文与错误状态 | 沿用 token/侧栏比例，文字至少 11px，状态不只靠颜色 |

后续 P2：物理目录搬迁、外部目录直接接入、多 Agent 并行。物理搬迁需另审计划、JSONL header、归属、领域引用和 Owner 影响，不以 fs.rename 代替方案。#87 在本轮仍不直接关闭。

### 9.6 检查方式与测试预算

本节定义实施验收方式；已运行的探针、平台范围与未完成项见 P0 记录。实施先跑 npm run test:budget，Node 实际注册总数不超过 40；上述断言并入现有综合场景，不新增子测试或隐藏 case 列表。预算不减少关键故障覆盖，真实 Pi、文件系统故障注入和本机跨进程验证保留独立证据。

- 服务端/契约：npm run typecheck + npm test，覆盖身份、逐工作区迁移、精确备份、API 删除、两级门禁、删除阶段与 CLI。
- UI：npm run typecheck:react + npm run test:web，覆盖迁移页、歧义处理、忙碌/队列与切换；只用新端点。
- 真实 Pi：先验 T1/T2，再验证迁入历史与新空会话的首次领域执行、重启 Owner 和不重复提交。
- 平台：现有 path/profile helper，不新增业务 OS 分支；macOS/Windows 验证中文/空格路径、文件锁、缺目录、只读和停止失败。
- 发布：集成分支完成构建/端到端/跨版本验收才一次合入 main；验证长迁移不超时、旧客户端不能误写、真实历史链接可恢复及旧业务端点实际请求数为 0。记录源码/样本/组件构建标识；安装包未验收明确标注，不将源码检查当发布通过。

## 10. 完成定义

#88：创建成功的逻辑会话在关闭/重启后仍可见，失败可诊断和重试。#41：旧会话迁入同一新模型，同工作区独立对话共享文件、隔离上下文并恢复各自计划。#87：名称归属和路径入口改善，物理改名仍未完成，保持 Issue 未完全解决。

正式切换完成意味着：全局索引、Writer、Schema 和墓碑安全；正常工作区可验证迁移及使用，异常工作区独立阻塞/修复；客户端只用唯一新 API/CLI 路径，原消息/资料及 Owner 保留，创建、恢复、关闭和删除安全。全部历史处理完只是迁移进度 complete 的定义，不是应用可用的前提。旧工作区格式只由迁移器导入；历史链接经受控新投影处理，日常无旧业务接口、旧目录写入分派或第二套消息存储。
