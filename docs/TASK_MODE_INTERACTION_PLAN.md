# Pi 任务模式与 Web 人机交互实施方案

更新时间：2026-07-20

状态：建议实施，尚未开始开发

## 1. 结论

本项目当前需要的不是完整流程编辑器，而是一种轻量、可观察、可中断的 **Pi 任务模式**：Pi 在处理复杂问题前先拆分步骤，执行过程中持续更新状态；遇到信息不足、需要确认或需要用户选择时，暂停当前工具调用，由 Web 收集回答，再把结构化结果交还给 Pi 继续执行。

第一版建议自行开发一个内置 `pi-task-mode` Extension，并提供两个 Agent 工具：

- `tau_task`：创建、调整和更新任务步骤。
- `tau_ask_user`：发起确认、单选、短文本或长文本交互。

任务状态以工具结果的 `details` 为权威数据，通过现有 Pi RPC、Node Server 和 WebSocket 链路进入 Web；用户交互优先复用 Pi RPC 原生的 Extension UI 请求/响应协议。Web 不通过正则解析 Assistant 的自然语言来判断任务状态。

Taskflow 可以作为未来复杂 DAG、并行子 Agent、恢复和增量重算的可选运行引擎，但不是这一阶段的前置依赖。

## 2. 目标与非目标

### 2.1 第一版目标

- Web 可以在“对话模式”和“任务模式”之间切换。
- 复杂请求开始执行前，Pi 调用 `tau_task` 创建 2–8 个可读步骤。
- Web 显示全部步骤、当前步骤、已完成步骤和失败/阻塞状态。
- Pi 可以修订计划，但必须保留稳定的 task/step ID。
- Pi 可以调用 `tau_ask_user` 询问确认、单选、短文本和长文本。
- Extension 在等待回答时暂停，收到 Web 响应后在同一 Agent turn 中继续。
- live、历史查看和 resume 场景可以从工具结果重建任务快照。
- 每个会话最多只有一个正在等待回答的交互；其他请求进入队列。
- 简单问答不强制创建计划。

### 2.2 暂不实现

- 可视化流程编辑器和拖拽式 DAG 编排。
- 任意表单、复杂多选、文件上传式问卷。
- 从 Markdown 编号列表推断权威任务状态。
- 多个子 Agent 同时直接向用户弹窗。
- 后台调度、跨进程恢复、预算、缓存和增量重算。
- 直接 Fork 并维护完整 Taskflow Runtime。

## 3. 当前项目基线

方案基于现有实现，而不是假设一个新的 Web 应用：

- Node Server 已管理多个 `pi --mode rpc` 子进程，并把 RPC event 转发到浏览器。
- Web 已处理 `tool_execution_start`、`tool_execution_update` 和 `tool_execution_end`。
- Web 已实现 `extension_ui_request` / `extension_ui_response`，并支持 `select`、`confirm`、`input`、`editor` 和 `notify`。
- 后台会话的 Extension Dialog 已有排队和切换恢复机制。
- `FeatureRegistry` 当前只在工具结束时分发结果，返回类型仍偏向 GIS visualization。
- Pi 子进程当前固定加载 GIS Extension，尚未形成通用 Extension Registry。
- 工具结果的最终 `details` 可以进入 Pi 会话历史；浏览器端的增量状态目前主要用于工具卡片文本。

因此，本功能不需要重新设计通信底座，但需要把 Extension 加载、Feature 生命周期和结构化工具状态进一步通用化。

## 4. 总体架构

```text
Web Task Mode Toggle
        │
        ▼
Node Live Session（保存 session mode）
        │
        ▼
pi-task-mode Extension
  ├─ before_agent_start：按模式注入最小任务规则
  ├─ tau_task：发布 TaskSnapshot
  └─ tau_ask_user：调用 ctx.ui 询问用户
        │
        ▼
Pi JSONL RPC
  ├─ tool_execution_start/update/end
  └─ extension_ui_request/response
        │
        ▼
Node Server / WebSocket
        │
        ▼
TaskModeFeature
  ├─ TaskStore
  ├─ TaskPanel
  └─ Interaction Dialog Queue
```

职责边界：

| 模块 | 职责 |
|---|---|
| `pi-task-mode` Extension | 约束 Pi 行为、维护当前任务、调用用户交互、返回结构化结果 |
| Node Server | 管理会话模式、转发 RPC、关联 session/tool/request、恢复待处理状态 |
| Web TaskModeFeature | 消费任务快照、显示步骤、呈现交互、提交用户回答 |
| Assistant 文本 | 解释过程和最终结论，不承担任务状态协议 |

## 5. 共享任务协议

第一版使用版本化、不可执行的 JSON 协议。Web 不直接读取 Extension 的内部变量。

```ts
type TaskStatus =
  | 'planning'
  | 'running'
  | 'waiting_user'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

type TaskStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'skipped';

interface TaskStepSnapshot {
  id: string;
  title: string;
  status: TaskStepStatus;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
}

interface TaskSnapshot {
  schemaVersion: 1;
  taskId: string;
  sessionId?: string;
  title: string;
  status: TaskStatus;
  revision: number;
  steps: TaskStepSnapshot[];
  activeStepId?: string;
  summary?: string;
  createdAt: number;
  updatedAt: number;
}
```

协议约束：

- `taskId` 和 `step.id` 创建后保持稳定。
- `revision` 每次有效修改加一，Web 忽略旧 revision。
- 一个任务最多一个 `running` 步骤；并行执行留给未来 Taskflow Adapter。
- `completed`、`failed`、`interrupted`、`cancelled` 是终态，不接受普通进度回退。
- `summary` 是简短事实，不保存完整推理过程。
- Web 只渲染文本，不执行 Extension 返回的 HTML、JavaScript 或 CSS。

## 6. `tau_task` 工具

### 6.1 工具职责

`tau_task` 是 Agent 主动修改任务计划和步骤的唯一工具入口。`tau_ask_user` 只允许在 Extension 内部临时把当前任务切换为 `waiting_user`，回答后恢复为 `running`，不能改写步骤内容。第一版为 `tau_task` 提供四个 action：

```ts
type TauTaskAction =
  | 'start'
  | 'revise'
  | 'update_step'
  | 'finish';
```

建议输入：

```ts
interface TauTaskInput {
  action: TauTaskAction;
  taskId?: string;
  title?: string;
  steps?: Array<{
    id: string;
    title: string;
  }>;
  stepId?: string;
  status?: TaskStepStatus;
  summary?: string;
}
```

行为定义：

| action | 用途 | 最小校验 |
|---|---|---|
| `start` | 创建当前任务和初始步骤 | title 非空；2–8 步；step ID 唯一 |
| `revise` | 用户回答或执行发现改变后修订步骤 | taskId 匹配；已完成步骤默认保留 |
| `update_step` | 设置 running/completed/blocked/failed/skipped | stepId 存在；状态转换合法 |
| `finish` | 结束任务并记录最终摘要 | 所有未完成步骤有明确终态 |

每次调用返回完整快照：

```ts
return {
  content: [
    {
      type: 'text',
      text: '步骤 collect 已完成，开始执行 analyze。',
    },
  ],
  details: {
    kind: 'tau-task',
    task: snapshot,
  },
};
```

`content` 供 Agent 理解调用结果，`details.task` 供 Web、会话恢复和分支重建使用。

### 6.2 任务模式提示规则

Extension 在 `before_agent_start` 中只对任务模式追加以下约束：

```text
当前会话处于任务模式。

复杂任务执行前调用 tau_task.start 创建简短计划。
开始和完成步骤时调用 tau_task.update_step。
计划发生实质变化时调用 tau_task.revise。
缺少必要信息时调用 tau_ask_user，不得擅自猜测。
全部完成后调用 tau_task.finish。
简单问答无需创建任务。
```

工具自身还应通过 `promptGuidelines` 明确说明调用时机，避免完全依赖一段全局提示。

## 7. `tau_ask_user` 工具

### 7.1 第一版交互类型

```ts
type InteractionKind =
  | 'confirm'
  | 'select'
  | 'input'
  | 'editor';

interface TauAskUserInput {
  kind: InteractionKind;
  title: string;
  message: string;
  options?: Array<{
    value: string;
    label: string;
    description?: string;
  }>;
  required?: boolean;
}
```

第一版直接映射 Pi RPC 已支持的 UI 方法：

| `tau_ask_user.kind` | Extension UI | Web 组件 |
|---|---|---|
| `confirm` | `ctx.ui.confirm()` | 是/否确认框 |
| `select` | `ctx.ui.select()` | 单选列表 |
| `input` | `ctx.ui.input()` | 单行输入 |
| `editor` | `ctx.ui.editor()` | 多行输入 |

不使用 `ctx.ui.custom()`。Pi RPC 模式不支持 TUI custom component，它只会返回 `undefined`；复杂 Web 组件应由项目自己的协议在后续阶段扩展。

### 7.2 请求与回答

```text
Pi 调用 tau_ask_user
        ↓
Extension 调用 ctx.ui.select/confirm/input/editor
        ↓
Pi 发出 extension_ui_request，工具 Promise 暂停
        ↓
Node 按 sessionId 转发，Web 展示 Dialog
        ↓
用户提交 extension_ui_response
        ↓
Extension 恢复并返回工具结果
        ↓
Agent 获得回答，在同一任务中继续
```

工具结果必须同时包含给 Agent 的可读文本和给 Web 的结构化详情：

```ts
interface InteractionResultDetails {
  kind: 'tau-interaction';
  interactionId: string;
  interactionKind: InteractionKind;
  status: 'answered' | 'cancelled' | 'timed_out';
  value?: string | boolean;
}
```

`interactionId` 由 `tau_ask_user` 生成，用于任务语义和历史恢复；Pi RPC 的 `extension_ui_request.id` 仍只负责一次传输请求与响应的匹配，两者不强制相等。等待回答前，工具通过 `onUpdate` 发送 `waiting_user` 快照；收到回答后，最终工具结果发送恢复为 `running` 的新 revision。

安全规则：

- 关闭窗口是 `cancelled`，不是空回答，也不是批准。
- timeout 是 `timed_out`，不能使用自动批准作为默认值。
- `required: true` 被取消后，Agent 应停止相关步骤或重新解释为什么必须回答。
- 选择项由 Extension 生成稳定 value，Web 展示 label；第一版可在 Extension 内完成 label/value 映射。
- 同一会话最多一个 pending interaction。

## 8. 任务模式开启与持久化

Web 输入区增加模式切换：

```text
[ 对话模式 ] [ 任务模式 ]
```

建议链路：

1. Web 向 Node 发送应用级 `set_task_mode` 消息。
2. Node 更新对应 live session 的 `mode`，只允许 `chat | task`。
3. Node 通过 Extension command `/task on|off` 同步到 Pi；命令由 Pi 在 Agent loop 前处理，不作为普通问题交给模型。
4. Extension 使用自定义 session entry 持久化模式，并在 `session_start` 时从当前 branch 恢复。
5. `before_agent_start` 读取 Extension 状态，决定是否注入任务规则。

在正式实现前需要用 RPC spike 验证 `/task on|off` 经 `prompt` 命令发送时的 ack、历史记录和 busy-session 行为。如果命令链路不满足无痕切换，再增加一个最小的 Extension bridge；不要把模式标记拼接进用户可见消息。

任务模式默认按会话保存，不作为全局默认。resume 后沿用原模式，新建会话默认 `chat`，用户可以主动选择 `task`。

## 9. Web 端适配

### 9.1 Feature 生命周期扩展

当前 `WebFeature` 只处理最终工具结果。任务模式需要完整工具生命周期：

```ts
interface WebFeature {
  readonly id: string;
  readonly workspaceView?: WorkspaceView;
  setSession(context: FeatureSessionContext, reset: boolean): void;
  handleToolStart?(context: FeatureToolEventContext): void;
  handleToolUpdate?(context: FeatureToolEventContext): void;
  handleToolEnd?(context: FeatureToolEventContext): FeatureResult | null;
}
```

`FeatureResult` 应改成可辨识联合类型，避免继续把 GIS 字段作为所有功能的返回结构：

```ts
type FeatureResult =
  | { kind: 'visualization'; /* 当前 GIS 摘要 */ }
  | { kind: 'task'; taskId: string; revision: number };
```

### 9.2 Web 模块建议

当前原生 TypeScript 阶段：

```text
src/public/features/task-mode/
  task-mode-feature.ts      FeatureRegistry 接入点
  task-store.ts             会话隔离的 TaskSnapshot 存储
  task-panel.ts             步骤列表和当前状态
  task-contract.ts          Web 端校验与归一化
```

Extension：

```text
extensions/pi-task-mode/
  index.ts                  工具注册、mode command、状态恢复
  task-state.ts             状态转换和协议校验
```

服务端仅在确有独立职责时增加模块：

```text
src/server/task-mode.ts     mode 消息、session 关联和恢复
```

不要为第一版引入数据库。TaskSnapshot 的权威持久化来自 Pi 工具结果和 Extension session entry；Node 只维护 live session 所需的快速状态。

### 9.3 UI 形态

第一版把任务摘要放在聊天区顶部或消息流中的固定 TaskCard，不新增完整右侧工作区：

```text
分析上海体育场周边交通

✓ 收集场馆及周边交通数据
● 分析地铁站和道路可达性
○ 生成 GIS 可视化
○ 整理分析结论

当前：正在分析地铁站覆盖范围
```

交互继续使用现有全局 Dialog，但需要：

- 显示来源会话和当前任务/步骤。
- 后台会话出现问题时，在 live tab 上显示等待标记。
- 切换回对应会话后恢复未回答 Dialog。
- WebSocket 重连后重新呈现仍有效的 pending request。
- 同一请求只能提交一次，重复 response 由服务端拒绝或忽略。

## 10. 状态恢复

### 10.1 Extension 恢复

`session_start` 遍历当前 branch：

- 读取最新 `tau_task` tool result 的 `details.task`。
- 读取最近的任务模式 session entry。
- 忽略 revision 更低或 schemaVersion 不支持的快照。
- 如果任务在进程异常退出时仍是 `running/waiting_user`，恢复为 `interrupted`，不假装仍在运行。

### 10.2 Web 恢复

- live snapshot：读取当前工具结果并订阅后续事件。
- history：从历史 `toolResult.details.task` 重建最后快照，只读显示。
- resume：先从历史重建，再接受新工具调用产生的更高 revision。
- browser refresh：从 Node live session snapshot 恢复；不要只依赖页面内存。

## 11. 主 Agent 与子 Agent 的交互边界

用户交互权集中在宿主 Pi：

```text
子 Agent 发现缺少信息
        ↓
返回 needs_input 给宿主 Pi
        ↓
宿主 Pi 调用 tau_ask_user
        ↓
用户回答
        ↓
宿主 Pi 再决定继续、修订计划或停止
```

第一版不允许子 Agent 直接打开 Web Dialog。这样可以避免并行问题争抢焦点、回答错配、会话取消后残留请求，以及子进程无法访问宿主 UI 协议的问题。

如果未来接入 Taskflow，Taskflow Adapter 应将 phase 状态映射为同一个 `TaskSnapshot`；需要用户输入的 phase 先暂停并上报宿主，由宿主统一调用 `tau_ask_user`。

## 12. 自然语言解析的边界

Web 可以继续解析以下确定性 RPC event：

- `tool_execution_start`：显示“正在读取文件/执行命令/生成地图”等临时活动。
- `tool_execution_update`：更新工具输出或 Taskflow 快照。
- `tool_execution_end`：完成工具卡片并处理结构化 `details`。
- `extension_ui_request`：显示等待用户状态。

Web 不把以下内容作为权威状态：

- Assistant 输出中的 `1. ... 2. ...` 编号列表。
- “我接下来会……”之类的叙述。
- Markdown checkbox。
- thinking 内容。

自然语言可以作为 TaskCard 的说明文本，但不能驱动步骤状态转换或交互提交。

## 13. 分阶段实施

### 阶段 0：RPC 与行为验证

- 编写最小 Extension，验证两个工具在 `pi --mode rpc` 中可注册和调用。
- 验证 `/task on|off` 命令的无痕切换、busy session 和 resume 行为。
- 验证 select/confirm/input/editor 的取消、timeout 和后台会话切换。
- 保存真实 start/update/end 和 extension UI payload 作为契约 fixture。

验收：不依赖自然语言解析，用户回答可以回到同一工具调用并让 Agent 继续。

### 阶段 1：Extension 与契约

- 实现 `TaskSnapshot` 校验和状态转换。
- 实现 `tau_task`、`tau_ask_user` 和 `/task` command。
- 实现 branch/session 状态恢复。
- 为非法 action、重复 ID、非法状态回退、取消和 timeout 编写测试。
- 将 Pi 子进程 Extension 加载改成可配置 Registry，同时保留 GIS 默认扩展。

验收：Extension 单测通过；TUI 与 RPC 均可使用标准交互方法；RPC 不调用 `ctx.ui.custom()`。

### 阶段 2：Web TaskCard

- 扩展 FeatureRegistry 的 start/update/end 生命周期。
- 实现按 session 隔离的 TaskStore。
- 实现 TaskCard、当前步骤、完成/失败状态和模式切换。
- 复用现有 DialogHandler，增加任务来源信息和 waiting-user 状态。
- 恢复 live、history 和 resume 的任务快照。

验收：两个并行 live session 的任务状态和 Dialog 不串线；刷新页面后任务卡可以恢复。

### 阶段 3：健壮性与体验

- 增加 WebSocket 重连后的 pending interaction 恢复。
- 增加重复 response 幂等和过期 request 拒绝。
- 增加键盘、焦点、移动端和 reduced-motion 验收。
- 增加一个 GIS 任务模式端到端样例。
- 更新 ARCHITECTURE、PROJECT_HANDOFF 和截图。

验收：取消、超时、断线、resume、切换会话和 Agent abort 都有明确终态。

### 阶段 4：可选 Taskflow Adapter

只有出现并行 DAG、后台运行或断点恢复的真实需求后再实施：

- 固定并验证 taskflow 版本。
- 将 Taskflow RunState 归一化成 `TaskSnapshot`。
- 宿主统一处理 approval/needs_input。
- 不增加流程编辑器。

验收：简单任务模式和 Taskflow 任务使用同一个 Web TaskCard，不暴露上游内部数据结构。

## 14. 测试矩阵

| 层级 | 必测内容 |
|---|---|
| Extension 单元测试 | start/revise/update/finish、状态转换、恢复、取消、timeout |
| RPC 集成测试 | tool 生命周期、四类 Dialog、response 关联、abort |
| Feature 测试 | schema/revision、session 隔离、非法 details 忽略 |
| 浏览器测试 | 模式切换、TaskCard、焦点、后台等待标记、会话切换 |
| 恢复测试 | live snapshot、history、resume、浏览器刷新、Pi 子进程重启 |
| 安全测试 | cancelled 不批准、过期 response 不生效、文本/HTML 安全显示 |

## 15. 工作量估算

以一名熟悉当前项目的工程师、包含测试和回归估算：

| 工作项 | 估算 |
|---|---:|
| RPC spike、契约和模式切换验证 | 1–2 人日 |
| `pi-task-mode` Extension 和单测 | 2–3 人日 |
| Feature 生命周期、TaskStore 和 TaskCard | 2–4 人日 |
| Dialog 关联、恢复和异常路径 | 2–3 人日 |
| 浏览器回归、文档和样例 | 1–2 人日 |
| **第一版总计** | **8–14 人日** |

如果只实现能演示的 happy path，可压缩到 4–6 人日，但会缺少历史恢复、断线和取消语义，不应作为正式完成标准。

## 16. 与 React 迁移的关系

任务模式协议、Extension 和服务端链路不依赖 React，可以先实施。Web 端需要保持 controller/store 与视图分离：

- 当前原生 TypeScript 使用 `TaskStore + TaskPanel`。
- React 迁移后只替换为 `TaskStore + TaskCard React Component`。
- RPC event、TaskSnapshot、Extension 和测试 fixture 保持不变。

如果 React 阶段 1 已经开始，TaskCard 可以作为第一个垂直业务组件进入 React；否则不应为了一个 TaskCard 提前启动全量 React 重写。完整 UI 迁移边界见 [React UI 迁移评估与实施方案](./REACT_UI_MIGRATION_PLAN.md)。

## 17. 实施前决策

开始编码前需要确认：

- 第一版任务模式按会话启用，而不是全局默认。
- 第一版只支持 confirm/select/input/editor，不实现复杂多选。
- 用户取消不会自动批准或自动采用默认值。
- 只有宿主 Pi 可以调用用户交互工具。
- Taskflow 不作为第一版依赖。
- 任务状态只信任结构化工具结果，不解析 Assistant 自然语言。

## 18. 官方参考

- [Pi Extensions：工具、事件、交互和状态管理](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi RPC：工具执行事件和 Extension UI Protocol](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [Taskflow：host-neutral core 与多宿主 Adapter](https://github.com/heggria/taskflow)
