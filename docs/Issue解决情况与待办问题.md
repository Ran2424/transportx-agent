# Issue 解决情况与待办问题

> 记录日期：2026-10-10。
> 来源：用户提供的《Issue 解决情况分析报告》。本文整理原报告，不代表本次重新核验代码、运行测试或查询 GitHub 状态。
> 原报告仓库：`Ran2424/transportx-agent`；分析分支：`codex/architecture-review-pr8-architecture`；报告标注基线：`main@e307133`，涉及 16 个 commit。
> 下文的解决状态、代码行为与优先级均按原报告记录；可能根因与修复建议仍需在实施时验证。
> #44、#46、#47、#48 的后续实现见文末「2026-10-11 修复补记」；上文保留原报告时点的判断。

## 总览

原报告列出 6 个 OPEN Issue，没有任何一项能据此确认完全解决。

| Issue | 问题 | 与分析 PR 的关系 | 原报告判断 | 剩余问题 |
|---|---|---|---|---|
| [#48](https://github.com/Ran2424/transportx-agent/issues/48) | 对话时引用保存优化 | 边缘相关 | 部分解决 | 引用存储加固，但缺少会话已上传文件清单与可读状态提示 |
| [#47](https://github.com/Ran2424/transportx-agent/issues/47) | 地图 canvas 渲染后黑箱问题 | 无直接修复 | 未解决 | 截图未充分等待地图渲染，可能保存空白 PNG |
| [#46](https://github.com/Ran2424/transportx-agent/issues/46) | 工作台切换对话时编辑内容保存问题 | 间接相关 | 部分改进，核心问题未解决 | `retryDraft` 不等于按会话保存输入草稿 |
| [#44](https://github.com/Ran2424/transportx-agent/issues/44) | 测试环境依赖失败 | 新增模型测试涉及该问题 | 未解决 | 模型数量断言受目录漂移影响；Windows 符号链接测试依赖权限 |
| [#41](https://github.com/Ran2424/transportx-agent/issues/41) | 无法在同一工作文件夹持续工作 | 范围外 | 未解决 | 缺少多个对话共享目录与 Module 配置的项目概念 |
| [#36](https://github.com/Ran2424/transportx-agent/issues/36) | 对话保存出错 | 边缘相关 | 无法确认 | 保存基础设施已加固，但缺少原始错误与复现场景 |

## #48：对话时引用保存优化

**用户诉求**：引用集中放在一个文件夹；展示已上传文件清单；让用户知道上传一次后 AI 可以继续读取。

原报告记录的相关改动：

- `src/server/session-attachments.ts` 的索引读写使用 `readJsonObject` / `writeJsonAtomic`，损坏文件拒绝覆盖；附件目录 `<cwd>/.tau/attachments/` 已存在。
- `src/contracts/attachments.ts` 用 `messageRefs` 将附件与消息关联。
- `src/public/kernel/stores/session-store.ts` 增加 `attachmentsBySession` / `attachmentRevisionBySession`。
- `src/web/platform/conversation/ConversationWorkspace.tsx` 在进入会话时调用 `listAttachments`。
- `src/web/platform/conversation/composer-attachments.tsx` 已有单条消息的附件缩略图。

待解决：

- [ ] 展示本会话全部已上传文件，而不只展示待发送附件。
- [ ] 提供文件可供 AI 读取的状态说明；实际引用状态应与可读状态区分。
- [ ] 提供附件存储位置的提示或查看入口。

**结论**：存储层加固不能替代引用管理 UI，不能据此关闭 Issue。

## #47：地图截图为空白

**用户现象**：地图截图没有内容，但仍被保存到工作目录。

原报告提出的可能根因：

- `src/public/visualization/geo/geo-runtime-entry.ts` 的 `captureScreenshot()` 在 `document.fonts.ready` 后调用 `composeScreenshot`，未充分等待 MapLibre canvas 绘制完成。
- `src/web/features/geo/GeoWorkspace.tsx` 使用 `runtime.resize()` 与两次 `requestAnimationFrame`，可能不足以等待网络瓦片加载或 GPU 上传。
- 空白 PNG 仍能通过格式签名与大小校验，随后写入工作目录。

原报告记录：`src/server/geo-interaction-service.ts` 保留 10 MB 截图限制；`src/server/api-routes.ts` 普通 API 请求上限为 1 MB，地图截图路由为 16 MB。这些限制不解决渲染时序问题。

待解决：

- [ ] 复现地图初始化、慢速瓦片加载与 resize 后的截图行为。
- [ ] 截图前等待地图满足渲染就绪条件；具体事件与超时策略需验证。
- [ ] 对无有效内容的截图提供失败反馈或重试提示。

**结论**：原报告未发现对应渲染时序修复，建议单独处理。

## #46：切换会话时输入草稿未保存

**用户现象**：切换对话时编辑内容没有按会话保存；原报告提及的视频截图无法查看，细节仍待确认。

原报告记录的代码行为：

- `src/web/platform/conversation/conversation-composer.tsx` 使用 `const [value, setValue] = useState('')`，输入文本属于组件本地状态。
- `ConversationStage.tsx` 渲染 `ConversationWorkspace` 时没有 `key={session.id}`，切换会话会复用组件实例。
- 会话切换时的 effect 只重置 `citationEnvelope` 与 `retryDraft`，没有按会话保存、清空或恢复输入文本。
- 新增 `retryDraft` 仅服务于失败消息的重新提交；细粒度 store 订阅也没有提供每会话草稿机制。

待解决：

- [ ] 定义按 `sessionId` 保存与恢复草稿的机制。
- [ ] 明确草稿是否包含附件、地图上下文，以及刷新或重启后的保留范围。
- [ ] 验证 A → B → A 切换时文本和上下文不会串到其他会话。
- [ ] 验证成功发送、失败重试与草稿清理的行为。

原报告建议评估 `localStorage` 或服务端 `.tau/drafts/`，并评估按会话设置组件 `key`。这些是候选方案；单独增加 `key` 不会实现草稿保存。

**结论**：有重试能力改进，用户提出的每会话输入保存问题仍未解决。

## #44：测试依赖环境导致失败

### 模型目录漂移

**现象**：在线模型目录与 bundled 元数据数量不一致，原报告记录示例为 `438 !== 384`。

原报告在后续复核中修正了前文：`test/cases/pi-model-access.cases.ts` 是 PR 新增文件，并非未改动。该文件包含 `assert.equal(providerModels.length, candidate.modelCount)`，仍依赖模型数量精确相等。

`src/server/pi-model-config.ts`、`src/server/pi-model-access.ts` 的接口调整，以及 JSON 原子存储工具，不解决模型目录漂移。

- [ ] 将测试目标与外部模型目录数量变化解耦。
- [ ] 评估原报告建议的固定注入目录或放宽数量断言；采用哪种方式须根据实际测试目标确定。
- [ ] 在模型目录数量变化时验证测试仍能检查需要保证的行为。

### Windows 符号链接权限

**现象**：`test/cases/module-installer.cases.ts` 使用 `fs.symlinkSync`，Windows 环境缺少 `SeCreateSymbolicLinkPrivilege` 时可能抛出 `EPERM`。原报告未发现该文件的针对性修改。

- [ ] 在符号链接场景中检测环境是否具备创建权限。
- [ ] 环境不支持时，明确跳过理由，并在具备权限的环境保留符号链接拒绝测试。

原报告也提出以 `fs.linkSync` 降级的建议；硬链接与符号链接语义不同，实施时不能直接将其当作同一测试的替代。

**结论**：两个子问题均未解决。模型测试的新增可能使环境敏感问题更容易出现。

## #41：多个对话共享工作文件夹

**用户诉求**：引入项目工作文件夹，让多个对话共享同一目录与 Module 配置，支持持续工作。

原报告记录：

- `src/server/session-workspace.ts` 的 `createSessionWorkingDirectory()` 仍为新会话创建时间戳子目录。
- `src/server/platform-composition.ts` 的 `sessionAssemblerForProfile()` 用于按冻结计划重建会话，未提供跨会话共享目录。
- `src/server/session-history-handler.ts` 可以按 `cwd` 汇集历史，但 UI 仍是平铺会话列表。
- `src/web/platform/sessions/NewSessionDialog.tsx` 与 `SessionSidebar.tsx` 未在分析 PR 中改动。

待解决：

- [ ] 编写项目工作文件夹的需求与设计文档。
- [ ] 定义项目、会话、目录与 Module 配置之间的关系。
- [ ] 定义共享配置与会话冻结计划的兼容规则。
- [ ] 设计创建、选择及恢复共享工作目录的入口。

**结论**：属于独立功能需求，原报告建议另开功能 PR。

## #36：对话保存出错

**已知信息**：Issue 只有两张截图，没有文字错误说明；原报告无法从截图标题确定具体故障。

原报告记录的基础设施改进：

- `src/server/util/json-storage.ts` 提供原子写入、备份与损坏 metadata 的证据保全。
- `src/server/session-attachments.ts` 增强 multipart 解析、并发上传、逐字节 boundary 校验，并设置 100 MB 总请求体上限。
- `test/cases/session-attachments.cases.ts`、`session-metadata.cases.ts` 与 `session-history-reader.cases.ts` 增加覆盖。
- 原报告称 #50 的大附件 `Failed to fetch` 已在 main 修复，但未证明与 #36 是同一故障。

待解决：

- [ ] 补充错误文字、操作步骤、应用版本与相关日志。
- [ ] 确认故障发生在会话 metadata、历史、附件还是其他保存路径。
- [ ] 复现原始场景后验证对应修复。

**结论**：基础设施有所改进，仍无法确认该 Issue 已解决。

## 原报告建议的处理顺序

| 优先级 | 对应问题 | 建议行动 |
|---|---|---|
| P0 | #44 模型目录漂移 | 在合并前修复环境敏感的数量精确断言 |
| P1 | #44 Windows 符号链接权限 | 检测权限，明确跳过不支持的环境并保留安全行为覆盖 |
| P2 | #46 会话草稿 | 评估随当前 PR 补齐按会话保存与恢复草稿 |
| P3 | #47 地图截图 | 单独处理地图渲染就绪与空白截图反馈 |
| P3 | #48 引用管理 | 增加会话已上传清单、路径提示与可读状态 |
| P3 | #41 共享工作目录 | 先定义项目工作文件夹需求，再实施会话模型与 UI 改动 |
| P3 | #36 保存出错 | 补充错误信息并复现，再判断修复范围 |

## 验收判断

原报告认为，分析 PR 的主要工作是架构整改与软件更新能力；存储加固、细粒度订阅和失败重试，与上述用户问题只有部分交集，不能作为这 6 个 Issue 的统一解决方案。

关闭问题前，应分别提供对应场景的复现记录、修复提交与验收结果。#36 在取得原始错误前保持无法确认；#47 的渲染时序解释仍作为可能根因记录。

## 2026-10-11 修复补记

实施分支：`codex/fix-session-drafts-attachments-geo-tests`。本轮处理 #44、#46、#47、#48；GitHub Issue 是否关闭仍以远端状态为准。

| Issue | 本轮修改 | 验证方式 |
|---|---|---|
| #44 | 模型测试检查接入后存在可用模型、模型字段与凭据移除行为，不再与接入前的模型数量比较；安装、历史和视频资源测试共用权限感知的符号链接检查，权限不足只跳过对应子场景 | 真实 Pi ModelRuntime 接入与移除测试；模拟 `EPERM` 后确认其他安装安全检查继续执行；HTTP 资源越界检查 |
| #46 | 文本按 `sessionId` 写入浏览器本地存储；待发送附件按会话保留在内存，上传完成回写原会话；会话切换重建工作台局部状态；成功发送只清理已提交内容 | Chrome 中 A → B → A、上传途中切换、文本刷新恢复、成功发送后的草稿清理、明确拒绝时保留文本与附件、迟到确认不清空新草稿或其他会话 |
| #47 | 截图等待场景更新、字体与 MapLibre `idle`，检查请求版本与捕获时版本；识别透明、纯黑、纯白及无尺寸画布；资源错误、关闭、图形上下文丢失和超时均拒绝保存 | Geo runtime 用例覆盖等待与失败清理；Chrome 延迟 GeoJSON 响应，验证加载期间没有截图上传，完成后 PNG 包含道路像素；人工保存与 Agent 请求保存均验证 |
| #48 | 输入区提供可展开的已上传文件清单、路径、可读说明、预览及本轮复用；移除待发送选择保留已上传文件；清单响应按会话代次校验，迟到响应不会覆盖上传、删除或较新的清单 | Chrome 中验证会话隔离、刷新后清单恢复、Markdown 预览、复用不重复上传与消息附件关联；Kernel 用例验证旧清单响应不会覆盖新状态 |

本轮核对发现：当前附件实际存储在 `<cwd>/attachments/`，索引在 `<cwd>/.tau/attachments.json`；原报告的 `.tau/attachments/` 路径描述与当前实现不一致。UI 展示的是服务端返回的实际 `relativePath`。

截图采用的 [MapLibre `idle` 事件](https://maplibre.org/maplibre-gl-js/docs/API/type-aliases/MapEventType/#idle) 在相机移动、已请求瓦片加载与渐变动画结束后触发；本轮同时核对了项目内安装版本的事件实现。

验证记录：

- `npm run typecheck` 通过，覆盖最终的 Kernel 与工作台改动。
- `npm test` 通过：40 个注册套件，Node 报告 320 个测试条目通过、1 个模拟权限不足的子场景按预期跳过，0 失败。
- `npm run test:web` 覆盖真实 Node 服务、fake Pi 与 Chrome，验证上述工作台行为；地图截图检查了 PNG 的道路像素，而非仅检查文件大小或格式签名。
- `npm run test:budget` 保持 40/40 个注册套件、53 个归属明确的 case 文件。
- `git diff --check` 通过。

范围与限制：

- 文本草稿保存在当前浏览器存储中；待发送附件选择和 Geo / Canvas 上下文仅在当前页面运行期间保留。刷新后可从已上传清单再次选择附件。
- 「AI 可按需读取」表示文件可供使用，不表示模型已经读取或引用。
- 空白画布检查覆盖未绘制及纯黑、纯白情况，不承担所有地理数据缺失或内容正确性的判定。
- 符号链接权限不足通过模拟 `EPERM` 验证；尚未在真实 Windows 主机复测。
- #36、#41 保留原报告状态，本轮没有实施修复。
