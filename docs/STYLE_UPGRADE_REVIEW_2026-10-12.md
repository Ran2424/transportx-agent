# TransportX Agent 样式升级意见独立审阅

初次审阅：2026-10-12；修订日期：2026-10-13。审阅对象：初版样式建议、此前补充意见，以及用户提供的《TransportX Agent 样式升级报告：独立技术评审》。保留原文件名以延续引用。

审阅基线：当前工作区源码，平台版本 3.23.0，HEAD 为 `d217ab5`。工作区存在其他未提交改动，因此本报告描述当前磁盘内容，不将 HEAD 视为全部被审代码。

本次通过 GitHub 连接器确认补充评审提及的提交为 [e21fb4e3bf4c73ffd86f66b5dbd66ead843affea](https://github.com/Ran2424/transportx-agent/commit/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea)，并核查其与本地完整 HEAD `d217ab50f91218ce5da074fa46fafd6c5a4bd4af` 的[提交差异](https://github.com/Ran2424/transportx-agent/compare/d217ab50f91218ce5da074fa46fafd6c5a4bd4af...e21fb4e3bf4c73ffd86f66b5dbd66ead843affea)。第 10 节引用的 23 个产品源码及 Web 冒烟文件与本地 HEAD 逐字节一致，且均不在两个提交的差异清单中；因此可以为这些证据补上该远端固定提交链接。AGENTS.md、package.json 和 CHANGELOG 存在本地差异，另行区分。此处核验的是指定快照，不宣称它仍为最新 main。

第 1–10 节记录实施前的源码审查、主题色值计算及冒烟覆盖检查；其中源码链接和色值表对应实施前快照。第一、二阶段开发与运行验证分别见第 11、12 节，执行详情语义补充实现见第 13 节，第三阶段输入、引用与成果改进见第 14 节，整合后的完整分支与验证见第 15 节。各阶段的分支名称及未提交状态是当时记录，分支整合见第 15 节，Working 后续优化见第 16 节。视觉尺寸仍是候选值，真实系统输入法与屏幕阅读器验收不由合成事件代替。

## 1. 审阅结论

**总体方向采纳，实施范围分三阶段收敛。** “聊天便于阅读、执行便于扫视、输入集中操作、分析面板保持密度”符合本项目的使用方式。首阶段只处理输入正确性和基础可用性；消息宽度、工具展示进入第二阶段；输入区表面整合、引用和成果展示进入第三阶段。各阶段独立验收，不将整份报告作为一次开发任务执行。

后续补充意见在滚动稳定性、输入语义和成果可追溯性上有帮助，但有四处不能直接采纳：

1. 项目已经有间距、圆角、控件高度、表面与状态 token，应统一使用已有规则，不另建视觉体系。
2. 侧栏 30%／70% 是当前 AGENTS.md 的明确约束，本轮不能自行修改；两区也已经支持独立滚动和折叠。该比例并非永久最优，未来可凭用户测试作为产品决策调整，并同步规范。
3. 引用区已经显示来源、数量与位置，摘录默认不显示，不能再以“长摘录占满正文”为改版理由。
4. 工具没有通用的“等待确认”“已取消”状态和通用重试命令。把这些动作加入每个工具卡片，会超出样式升级范围。

首阶段重点是 **IME、发送条件一致性、键盘操作与功能文字可读性**。现有源码和色值计算能指出问题；阴影、圆角、欢迎页和大范围布局整合后置。这里的先后顺序是实施优先级，不将所有静态发现一律认定为发布阻断缺陷。

### 1.1 对新增独立评审的采纳情况

| 新意见 | 本次审视与修订 |
| --- | --- |
| 第一轮范围偏大，应拆成三阶段 | 采纳。第 9 节改为阶段边界、进入条件及独立验收，输入表面整合不与首阶段捆绑。 |
| 失败附件单独存在时，发送按钮可点击但不交付 | 采纳，已核对本地源码。第 5.1 节补上 ready 筛选与 pending.length 的不一致，以及普通发送／补充指令的边界场景。 |
| 不应因工具收起而削弱运行反馈 | 采纳原则，但不构成与旧报告的实质分歧：旧报告已要求运行文字、操作对象和可用耗时。修订为明确区分摘要与详情，默认收起详情作为待验证方案。 |
| 错误摘要不得泄露敏感原文 | 采纳。现有详情不能被视为已经普遍脱敏，不直接截取任意输出充当错误摘要。 |
| 侧栏比例是当前约束，不是永久最优 | 采纳。保留本轮约束，允许未来经产品决策和规范修改后调整。 |
| 成果自动发现长期有价值 | 采纳研究方向，按结构化成果契约单独立项，不扫描任意输出路径推测，不挤入三阶段展示修订。 |
| 证据应使用固定提交链接 | 采纳。保留本地导航，并给已核验匹配的源码增加固定提交链接；不把未提交文档伪装成远端版本。 |

新增评审对具体误发送概率、工具默认策略的体验优劣和视觉提升幅度没有提供运行证据。这些仍是后续验收事项，不能因两次审阅意见一致就标为已通过。

## 2. 逐项判定

| 原意见或补充意见 | 判定 | 源码依据与修订方向 |
| --- | --- | --- |
| 保留三主题、品牌色、无背景 Assistant、工具时间线、思考区和 Canvas | 采纳 | 基础成立；在现有结构上调整，不更换组件库和字体体系。 |
| 放宽 Assistant，改善窄面板阅读 | 采纳，补充外层约束 | `88%`、30px 右内边距和消息列表两侧 32px 同时压缩内容；不能只改消息宽度。[S1] |
| 宽窗口增加正文阅读上限 | 采纳目标，修正现状 | 列表已有 1040px 上限，Assistant 也已有上限；需要重新分配文字与宽内容的宽度，不是从无上限改成有上限。[S1] |
| 给每轮回复真实容器 | 有条件采纳 | `.assistant-turn` 对应单条 assistant entry，不对应完整用户轮次；先做条目内布局，完整轮次分组后置。[S2][S3] |
| 表格从 12px 调到约 13px | 可试验 | 12px 已证实；13px 不是预先确定的验收标准，需与横向滚动及窄面板共同验证。[S1] |
| 工具默认摘要、保留手动展开 | 优先采纳 | 摘要头已存在；问题主要是状态变化重置展开、可见状态不足，以及实时条目转历史时的状态保存。[S3][S4] |
| 工具完成显示文件数量、失败显示恢复入口 | 限定采纳 | 只展示结构化结果确实提供的数据；错误摘要可以增加，通用文件计数和重试不可推测。[S4][S5] |
| 把附件、地图、Canvas 放入输入容器 | 方向采纳，第三阶段独立实施 | 它们目前在 footer 中、form 外；先修交付条件，后整合表面，保留历史库和已排队消息的区别。[S6][S7] |
| 修复中文输入法 Enter | 优先采纳 | 当前 Enter 分支没有组合输入保护；这是正确性风险，需要输入法实测。[S6] |
| 按可交付内容决定发送按钮状态 | 首阶段采纳 | pending.length 包含失败附件，而提交只选 ready；运行中的补充指令也需要同一条件。[S6] |
| 回复操作改到末尾 | 作为候选方案 | 当前复制按钮仅 hover 显现；优先保证键盘与触屏可见，是否移动要用长回答画面比较。[S1][S8] |
| 引用先显示来源和数量、摘录按需展开 | 部分已经实现 | 来源与数量已有，摘录被 CSS 隐藏；可补可操作的证据详情，不必再增加一层默认折叠。[S9][S10] |
| 小幅强化成果入口 | 第三阶段采纳现有成果展示 | 只有正文引用且可解析的 artifact 会进入卡片，不能承诺列出所有生成文件；第二阶段收起工具时先保护已有成果入口。[S8][S9][S11] |
| 侧栏比例不应固定，只作为起点 | 本轮不采纳，允许后续产品决策 | 当前规范明确约束；未来需用户测试支持并同步规范。短窗口仍应检查最小高度。[S12] |
| 欢迎页缩小标题、减少介绍页感 | 后置试验 | 42–56px 与三栏介绍属实；欢迎页已存在主按钮，视觉是否失衡仍需画面验证。[S13] |

## 3. 消息阅读：应同时处理面板、消息和内容宽度

当前 `.conversation-thread` 最大宽度为 1040px，两侧各有 32px padding。Assistant 宽度为 `min(920px, 88%)`，内部再保留 30px 右侧空间。用户消息另有靠右容器。[S1]

以 **440px 宽聊天面板、桌面 CSS 条件**作静态估算，忽略滚动条占宽：

```text
列表可用宽度 = 440 - 32 × 2 = 376px
Assistant 正文宽度 ≈ 376 × 88% - 30 = 301px
```

这说明原建议对窄面板压缩的判断成立。地图或文档打开时的聊天宽度由 AppShell 的分栏与拖动逻辑控制，默认偏好是 440px。[S14] 当前紧凑 padding 只在整个窗口小于 860px 时触发；宽窗口中的窄聊天面板不会因此自动变紧凑。[S1]

建议第二阶段：

- Assistant 使用消息列的可用宽度，减少只为右上角复制按钮预留的空间。
- 按聊天面板实际宽度调节列表内边距，可采用容器查询或现有分栏状态；不要只依赖窗口媒体查询。
- 保留正文阅读上限，允许表格、代码和成果在消息列内占更多宽度。不要给每个段落、列表项机械地套不同宽度；复杂 Markdown 仍需要一致的对齐规则。
- 表格继续局部横向滚动，不用极小字号强行塞入，也不因聊天阅读升级扩大地图控件。
- 13px 表格、标题层级及轮次外间距用同一组会话比较后确定。

**轮次容器需要先定义语义。** 当前每条 assistant entry 包含其正文和关联工具，一次用户请求可能包含多个 assistant entry，实时正文和 `liveOnly` 工具还在列表尾部单独渲染。[S2][S3] 把 `display: contents` 改成 flex 容器可以区分条目内外间距，但不能自动得到“用户问题 → 全部工具 → 最终回复”的完整轮次。第二阶段先保留消息投影结构，只在间距问题无法局部解决时评估条目容器，不新增完整轮次分组系统。

现有滚动逻辑已经在距离底部小于 100px 时跟随，并在用户远离底部时停止跟随。[S2] 风险在布局变化、工具局部开合和异步图片加载，不是缺少跟随判断。应验证底部跟随与上文阅读位置，而不是直接重写滚动算法。若改真实容器，还要检查工具时间线伪元素的连接位置和 live/history 过渡。

## 4. 工具执行：改展开策略，不扩建工具流程系统

工具头已经包含图标、操作类别、参数摘要、耗时与展开按钮。`preview()` 取 path、command、query 等现有字符串。当前可见标题往往是“读取”“地图”等类别，不一定显示实际工具名；状态文字在 `sr-only` 与 title 中，视觉上主要靠图标颜色区分。[S4]

已确认的行为是：

```tsx
const [open, setOpen] = useState(tool.status === 'running');
useEffect(() => {
  setOpen(tool.status === 'running');
}, [tool.status]);
```

因此运行会展开，完成或错误会收起，覆盖用户在运行期间的选择。仅删除 effect 也不够：默认展开策略要明确，且实时工具可能从列表尾部移入历史 entry 内，跨父节点会造成组件重建风险。[S2][S3] React 的状态依附渲染树位置，单有相同 key 不能保证跨位置保留。[React 状态说明](https://react.dev/learn/preserving-and-resetting-state)

建议将本次会话内的展开选择按 `(sessionId, toolCallId)` 保存于会话视图层，或保证条目位置稳定。同一会话的实时／历史投影切换及切换会话后返回，均保留手动选择；不同会话严格隔离。会话关闭时清除对应记录，工具被权威完整投影确认移除或失效时清理对应条目，不因临时加载空列表而清除。仅在当前工作台生命周期内保存，不新增跨刷新偏好系统。此规则在第二阶段实施。

第二阶段应先固定摘要的可见内容，再以真实连续执行场景验证详情的默认开合。**默认收起参数和原始输出是候选策略，运行摘要始终可见才是验收要求。** 原报告与新增评审对此目标一致，不应把“收起详情”误读成隐藏整个执行过程。

状态规则建议为：

| 情况 | 默认展示与动作 |
| --- | --- |
| preparing | 摘要显示准备状态及已有参数字符数；详情默认收起作为候选，不假装操作对象已确定。 |
| running | 运行状态始终可见；有可靠操作对象时显示对象摘要，没有时显示工具名称或操作类别，不推断对象；耗时按实际数据展示；参数／输出详情默认收起作为候选，实测后确定；手动打开或关闭后尊重选择。 |
| completed | 保持用户选择，显示完成状态；有可靠结构化结果时才增加结果摘要。 |
| error / isError | 失败状态直接可见；只展示可公开的可靠错误原因，没有安全摘要时保留失败提示与详情入口，不猜测原因。 |
| 需要用户输入 | 沿用 ExtensionDialogLayer 对话框或 GeoRequestBanner，不从工具名称猜测确认状态。 |
| 用户停止运行 | 沿用会话级停止与取消反馈，不将所有未完成工具标记成失败或成功。 |

`ToolExecution.status` 只有 preparing、running、completed、error；取消属于 RunOutcome，用户确认由独立交互通道处理。[S5][S15] 所以“每个工具都有停止、重试、审批入口”不能列入这轮验收。现有失败回复的“编辑后重新提问”也不是单工具重试。[S8]

错误摘要不能简单使用任意工具输出的前 N 个字符。结果可能包含密钥、URL 查询参数、命令参数或私有文件内容，当前 ToolCard 的格式化、截断也不是通用脱敏保证。[S4][S16] 优先使用已有的安全分类或可公开结构化原因；若需专门处理某类结果，要限定来源并验证敏感样本。无可用原因时，明确显示“失败”比扩散原文或生成推测更合适。展示层改动不扩展工具执行契约。

还应修正“详情保留完整命令和原始结果”的措辞：当前工具文本参数预览上限 4000 字符，输出预览上限 12000 字符；输出复制使用未截断的格式化文本，但这不等于原始结构化结果全文。[S4][S16] 保留现有截断规则，不为外观升级无限增加 DOM 内容。

## 5. 输入区：统一表面，同时保留内容的交付语义

当前输入 form 已有圆角、表面背景、阴影和 focus-within 反馈，但历史库、待发送附件、地图与 Canvas 上下文是它的外部兄弟节点。[S6][S7] 统一放入输入表面的方向成立，重点是让用户确认这次会发送哪些内容。

第三阶段建议 form 内部依次放置“本次内容 → textarea → 操作栏”。历史库保留为次级入口，已排队消息继续作为已提交内容展示，不混入本次待发区。首阶段只处理输入正确性和发送条件，不先搬动这些区域。

| 内容 | 当前来源 | 改版必须保留的区别 |
| --- | --- | --- |
| 正在上传的附件 | pending uploading | 尚不能交付；当前 submit 会阻止上传中发送。 |
| 上传失败的附件 | pending error | 当前不进入 attachmentIds；有正文时仍可能发送成功，因此必须让失败和未包含状态可见。 |
| 本次已选附件 | pending ready + attachment | 发送时进入 attachmentIds；从这里移除只是取消选择，不删除历史资料。 |
| 历史已上传文件 | SessionAttachmentLibrary | 可以按需读取或复用，不等于本次发送，也不等于 Agent 已读取。 |
| 地图上下文 | geoContextStore | 保留选择类型与 summary，不能只剩不透明 ID。 |
| Canvas 上下文 | canvasContextStore | 目前显示 viewId；用已有可靠标题改善识别时，需追踪到实际视图，不把 ID 伪装成人类标题。 |

统一卡片尺寸不等于统一语义。附件、地图和 Canvas 可以共享间距与移除控件规则，仍须通过名称、类型与状态区分。多项选择时设置高度上限及滚动或展开入口，错误提示和移除操作不能因此不可达。历史库已有 180px 的内部滚动上限，待发送附件与上下文没有相同约束。[S7]

首阶段应先修的输入问题：

- **组合输入保护。** 当前 Enter 无条件进入发送分支。应在发送快捷键之前检查 `nativeEvent.isComposing`，必要时跟踪 compositionstart/end；具体兼容策略以 Electron 和浏览器实测为准。[S6] `isComposing` 的含义见 [MDN 官方文档](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing)。同一 submit 在运行中默认发送补充指令，需覆盖该模式。ExtensionDialogLayer 的 input 也有无保护的 Enter 分支，并应检查 select 模式自定义回答的 form 提交，避免只修主输入框。[S15]
- **上传入口的键盘可达性。** 现有上传控件为 label，内部 file input 是 `display: none`，label 没有独立键盘激活机制。[S6][S7] 仅增加 hover 提示不能解决；可用真实按钮打开文件选择，或保留可聚焦的原生输入实现。
- **可交付内容与发送条件一致。** 发送按钮、补充指令按钮和 Enter 入口应共享可交付内容与忙碌条件；详情见下节。修正视图条件，不新增消息交付协议。

### 5.1 新确认的边界：失败附件导致可点击但不交付

普通发送按钮的 disabled 条件以 `pending.length === 0` 判断是否有附件，而 submit 构建 attachmentIds 时只选 `status === 'ready' && attachment`。[S6] 当 pending 中只有失败附件、没有正文及地图／Canvas 上下文时，按钮仍可点击，但 submit 得到空 message，直接返回，不发命令。运行中的补充指令按钮没有相同的禁用判断，空内容也可进入无交付的路径。

这是源码可确定的条件不一致；本次未启动应用复现点击。建议复用与 submit 相同的 ready 筛选来判断是否有可交付内容，并将上传中、压缩中纳入提交条件。按钮反馈与快捷键保护应一致，不能只改按钮外观。

| 内容组合 | 当前静态行为 | 修订后的验收要求 |
| --- | --- | --- |
| 无正文，无上下文，只有失败附件 | 普通发送可点击，submit 返回；补充指令同样可点击 | 禁用两种发送动作，失败原因与移除入口仍可见，Enter 不交付。 |
| 完全空白，无任何附件／上下文 | 普通发送禁用，补充指令可点击但返回 | 普通发送和补充指令一致地不可交付。 |
| 无正文，至少一个 ready 附件 | 生成附件专用默认消息并交付 | 保留附件单独发送能力，不因禁用修复而要求正文。 |
| 无正文，有 Geo／Canvas 上下文 | 生成上下文专用默认消息并交付 | 保留上下文单独发送能力。 |
| 有正文或 ready 附件，另有失败附件 | 失败项被排除，有效内容仍可交付 | 有效内容可发送，但失败项及其未包含状态明确，失败提示不能随布局调整被隐藏。 |
| 有正文、ready 附件或上下文，但仍有上传中项 | submit 拒绝交付并提示等待 | 两种发送按钮体现等待状态，Enter 同样不交付；停止运行仍可操作。 |

这项修复无需增加确认弹窗、自动重传或新附件状态。保留失败项以供用户处理，避免把“有待处理项”当成“有可交付内容”。

发送、补充指令、停止、压缩中应共享稳定的操作区域。上传中可显示忙碌反馈，但仍要说明该状态会阻止交付。继续保留 textarea、粘贴图片、拖放、附件复用和按会话隔离的草稿行为。

现有 composerSmoke 已覆盖草稿隔离、上传迟到、历史复用、拒绝发送后保留选择及迟到 ACK 不清空新草稿。[S17] 这些是布局重组必须保持的行为，不应重写为另一套状态机制。

## 6. 视觉规则：现有体系的执行一致性比新增规则更重要

tokens.css 已有 4／8／12／16／24／32 间距、8／12／16 圆角、多档控件高度、11px 起的字号别名，以及三主题的 surface、text、border、selection、status、shadow。[S18]

因此“先补视觉规则”应改为：**先审计高频组件是否正确消费已有规则，形成一份使用映射，再进行局部校准。** 不新增第二个 token 文件，也不在组件里写主题专属颜色。功能尺寸可以遵循已有结构别名，不把有意设计的行高和光学对齐全部强改为 4 的倍数。

当前仍有 10px 功能字：附件说明、引用编号和数量等。[S1][S10] 11px 是项目下限，并不意味着所有文本用 11px 就易读；字号、颜色、透明度与显示位置需要一起检查。

### 6.1 对比度的静态检查结果

按 tokens.css 中不透明色值，以 sRGB 相对亮度公式计算，未计入元素 opacity、混色、hover 或截图像素：

| 色值组合 | Light | Dark | Sand |
| --- | --- | --- | --- |
| text-tertiary / surface-canvas | 2.91:1 | 3.57:1 | 3.09:1 |
| text-tertiary / surface-sidebar | 2.76:1 | 3.28:1 | 2.86:1 |
| interactive-primary-fg / interactive-primary-bg | 5.01:1 | 6.39:1 | 3.92:1 |

普通功能文字可用 4.5:1 作为验收基准；大字号、装饰、禁用控件等有不同适用条件。[W3C 对比度说明](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

这些计算指出两类具体问题：侧栏时间等有意义的小字不应仅靠 text-tertiary；Sand 的普通主按钮文字，例如 12px 的新建任务按钮、11px 的补充指令文字，其默认前景／背景组合低于该基准。[S7][S12][S18] 发送箭头属于图标，不能套用同一文字结论。

建议先将受影响功能文字映射到合适的语义颜色，检查可读性，再决定是否调整全局 tertiary；主按钮前景／背景在 tokens.css 中校准。避免为解决某一处而把所有边框和弱文字同时加深。引用 footer 的整体 opacity 为 .84、附件说明还有 .72，也应按实际合成后的颜色复核。[S1][S10]

### 6.2 焦点与操作可见性

复制按钮虽可聚焦，但 opacity 默认为 0，只有消息 hover 使其显现；全局 focus-visible 规则不改变其透明度。[S1] 优先补 focus-within／focus-visible 与无 hover 环境的可见状态，再比较顶部和末尾操作行。

部分组件用 `outline: 0` 替换默认焦点反馈。工具条目已有替代 ring，不能笼统地说所有焦点都缺失；思考开关和引用条目则需检查替代背景或文字变化是否足够。[S1][S10] 同时检查 16–18px 的移除按钮命中区域，视觉图形可以小，交互区域可以更大。

## 7. 引用和成果：展示优化与数据覆盖应分开立项

**原意见对引用区现状的描述不准确。** CitationFooter 已按 resource 分组，显示来源类别、标题、条目数及引用位置；CSS 隐藏 quote 和 hint，hover 或 focus 提供证据预览，点击打开来源。[S9][S10]

所以可以改善的是：让来源标题与位置易读，让触屏也能核对摘录，必要时增加可主动展开的证据详情。不要先把整个来源列表默认折叠，导致正文标号难以核对。失效引用警告也要保持可见。640px 以下现有预览浮层被隐藏，更应验证点击打开是否能完整提供证据。[S10]

**成果卡片已有，但不是所有文件的列表。** 投影只解析正文引用标记，解析成功且 scope 为 artifact 才进入 MessageArtifacts；Assistant 在非流式状态才显示这些卡片。[S8][S11] 没有标记的工具生成文件，不能靠修改卡片样式自动出现。

第二阶段工具展示变化应先保护已有成果入口；第三阶段再加强成果标题、格式与打开反馈。若需求变成“所有生成文件都自动列出”，则需要单独定义结构化成果契约、消息关联、去重及资源验证规则。此方向有产品价值，可在后续功能规划中优先于欢迎页装饰调整，但不能扫描任意工具输出的路径推测成果，不作为第三阶段展示优化的附带任务。

补充意见中的日期、版本、单位和区域也要分清：CitationWork 有 issuedAt、edition、standardNumber，resource 有 acquiredAt，但当前契约没有通用区域范围和计量单位字段。[S19] 已有可靠日期与版本可在详情中展示；不能把取得日期当作数据时段，也不能由路径或模型文案推导缺失元数据。

## 8. 侧栏与欢迎页的审阅意见

侧栏已实现能力区 `flex: 3 1 30%`、会话区 `flex: 7 1 70%`，各自有内部滚动；能力区和会话区都能折叠。能力区最小高度 120px，会话区 200px，极短窗口仍可能受最小高度之和影响。[S12] 这应列为边界检查，而不是声称缺少独立滚动。

30%／70% 是当前产品规范，不是由源码证明的最优比例。本次保持该约束；若真实任务与用户测试证明空间分配不足，可单独提出比例或结构调整方案，同时修改规范、定义回归场景，再实施。

会话重命名、删除入口目前由 onContextMenu 打开，增加可聚焦的“更多”入口合理。但会话行本身是 button，不能直接把另一个 button 嵌进去；应改为同一行内的独立选择按钮与操作按钮，并验证焦点返回。[S12]

欢迎页可后置缩小标题与留白。它使用 display 字体，而 header 品牌使用 brand 字体，两者不同。[S13][S18] 保留各自用途，不把“保留品牌字体”理解成将欢迎标题、聊天正文和文件名换成同一种展示字体。

## 9. 三阶段实施范围与验收

### 9.1 阶段边界与进入条件

| 阶段 | 工作内容 | 完成条件 |
| --- | --- | --- |
| 一：正确性与可用性 | IME、发送条件一致、键盘上传、复制焦点可见、涉及的 10px 功能文字和对比度 | 主输入／运行中补充／Extension 输入不因确认候选词而发送；失败附件单独存在时不可发送；附件或上下文单独可发；键盘动作可达，三主题目标文字达到适用标准。 |
| 二：阅读与执行反馈 | 面板适配、Assistant 宽度、工具可见摘要、安全错误提示及手动开合保存 | 宽／窄面板的长文、表格和代码可读；运行状态可见；状态转换、live/history 过渡和会话切换保留正确选择；滚动和已有成果入口不回退。 |
| 三：界面整合 | 本次输入内容统一表面与高度约束，已有引用和成果展示 | 历史／待发／已排队内容可区分，多附件与失败项不挤走输入和操作；已有成果可打开，证据可核对；不增加成果发现机制。 |

首阶段只交付可单独验证的修复，不捆绑输入表面整合。第二、三阶段实施前，保存同一组会话的宽／窄面板和三主题截图，记录希望解决的具体问题；没有画面证据的字号、默认开合和留白调整先作对比试验。每阶段通过自身验收后再推进，保留独立回退范围。

按用户要求，第一阶段在 `codex/style-upgrade-phase-one` 分支开发。第二、三阶段涉及多组件及状态联动，分别走分支、PR、合并流程；第二阶段先处理工具展开选择，再独立处理消息宽度，便于定位滚动回归。

每阶段提交应附以下证据，类型检查通过不等同于产品体验验收通过：

| 阶段 | 交付证据 |
| --- | --- |
| 一 | 对应回归结果、系统 IME 实测记录、三主题实际文字对比度与键盘操作结果；未完成的实测明确列为待验收。 |
| 二 | 同一会话宽／窄面板改前改后截图、工具状态转换、会话往返及滚动行为记录。 |
| 三 | 多附件、上传失败、地图／Canvas 上下文、引用核对与成果打开的完整交互记录。 |

欢迎页、侧栏行高细化与“更多”入口列为后续小项；13px 表格、标题层级和字号变化只有对应可读性证据时才纳入第二阶段，不作普遍放大。完整轮次聚合、通用工具重试／审批、多格式成果自动发现、富文本编辑器与侧栏结构调整单独决策，均不属于上述三阶段的附带任务。

### 9.2 验收场景

以下是各阶段验收要求；第一阶段已执行与待执行项目在第 11 节分别记录：

| 阶段 | 场景 | 应检查的结果 |
| --- | --- | --- |
| 一；二、三回归 | Light／Dark／Sand 的目标文字与键盘状态 | 以实际前景、背景及透明度检查可读性；焦点和错误提示可见。 |
| 二；三回归 | 宽窗口及地图／文档打开，在 1280 或更宽窗口拖窄聊天面板 | 内边距随面板适配；正文不被双重限制；分析面板保留密度。 |
| 二 | 长段落、长中文标题、宽表格、长代码 | 普通内容不造成整列横向溢出，表格与代码可局部滚动；候选字号用同一内容画面比较。 |
| 二 | 连续工具，手动展开／关闭，preparing → running → completed/error | 用户选择不被覆盖；运行状态始终可见，有可靠对象时显示，否则回退到工具名称或操作类别；耗时按实际数据展示，详情不自动反复撑开页面。 |
| 二 | 错误结果含测试密钥、带凭据的 URL 或私有片段 | 新增摘要不扩散敏感原文；没有安全原因时显示失败，不捏造原因。 |
| 二 | liveOnly 工具转入历史、切换会话 | 工具展开选择不因位置变化丢失，也不串到另一个会话。 |
| 二、三 | 正在流式生成，用户读上文；工具开合或图片加载 | 上文阅读不被强制拉回底部；在底部时跟随合理，不持续振荡。 |
| 一；二、三回归 | 中文／日文组合输入、Shift+Enter、普通 Enter | 确认候选词不交付；普通发送、运行中补充、Extension 输入及自定义回答分别检查。 |
| 一；三回归 | 仅失败附件、完全空白、ready 附件单独发送、上下文单独发送、有效内容与失败项混合 | 按第 5.1 节的内容矩阵检查按钮和 Enter；有效内容仍可交付，失败项未包含的事实可见。 |
| 一；三回归 | 仅键盘上传、移除、复制、打开引用；上传中与停止 | 控件可到达、可激活且焦点可见；上传等待不阻断停止动作。 |
| 三 | 多附件、上传失败、历史复用 | 本次选择、未包含内容与历史资料可区分；移除选择不删除资料；输入和操作栏仍可用。 |
| 各阶段相关回归 | 发送拒绝、迟到 ACK、切换会话、运行中补充与停止 | 保留现有草稿和交付边界；新草稿不会被旧响应清空。 |
| 二保护；三优化 | 有 artifact 标记／无标记文件、失效引用、触屏来源打开 | 卡片覆盖边界明确；已有成果可打开；来源位置与证据可核对，失效信息不被隐藏。 |
| 各阶段相关回归 | 短窗口、125%／150%／200% 缩放、减少动态效果 | 停止和发送入口可用，侧栏仍可访问；字体变化不截断关键状态。 |

测试应复用现有 Web 冒烟与 fake Pi 场景。现有脚本覆盖部分流式 Markdown、成果打开、对话框、草稿和三主题文档截图，不能等同于本次聊天视觉验收。[S17][S20]

每阶段后续改前端前先运行 `npm run typecheck:react` 留下基线，修改后再验证类型；先检查 `npm run test:budget`，交互变更运行 `npm run test:web`，遵守全项目实际注册节点不超过 40 的约束。新增必要断言合并到现有关键场景，不把每项视觉检查都注册为新测试。真实 Electron 窗口、输入法、触屏及画面对比仍需额外验收，不能用 fill／press 或 Web 冒烟通过替代。

### 9.3 文件范围修订

原意见列出的六个文件是入口，但不是完整范围。后续实现还应按实际改动涉及：

- `styles/tokens.css`：语义色值和现有视觉规则校准。
- `tool-projection.ts`、会话视图状态：工具生命周期与展开保存。
- `composer-attachments.tsx`、`session-attachment-library.tsx`：附件状态、选择与历史复用。
- `ExtensionDialogLayer.tsx`：交互输入的组合输入检查。
- `AppShell.tsx`：作为现有分栏约束依据，不必预先修改。
- `citation-projection.ts`：作为成果覆盖边界依据，不为样式需求预先重构。
- 现有 smoke 脚本与当前版本 CHANGELOG：按必要性补验收和记录。

纯工作台改动不自动触发 Module 版本升级；若实际修改模块 manifest、Skill、Extension 或模块脚本，则遵守独立模块版本纪律。此处为实施前的范围说明；各阶段实现进度见第 11、12 节，未实现的第三阶段不写成已完成的 Fixed 项；已实现的修改在 CHANGELOG 当前未发布版本中记录，不称为已上线。

## 10. 源码证据索引

本地链接用于当前工作区导航，行号可能随后续修改变化；每个源码入口另附已核验匹配的 GitHub 固定快照。固定快照统一使用 `e21fb4e3bf4c73ffd86f66b5dbd66ead843affea`，不链接 main，供跨机器复核。第 10 节之外的本地规范和发布记录不自动视为该快照。

| 编号 | 源码入口 | 核查内容 |
| --- | --- | --- |
| S1 | [styles.css：消息布局](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/styles.css:583>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/styles.css#L583) | 1040px 列表、32px 内边距、88% 消息、30px 预留、排版、复制与附件说明。 |
| S2 | [ConversationWorkspace.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/conversation/ConversationWorkspace.tsx:48>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/conversation/ConversationWorkspace.tsx#L48) | nearBottom、实时正文、entry 容器与 liveOnly 工具。 |
| S3 | [tool-projection.ts](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/conversation/tool-projection.ts:6>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/conversation/tool-projection.ts#L6) | 工具按 entry 和 liveOnly 投影、历史结果关联。 |
| S4 | [tool-card.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/conversation/tool-card.tsx:40>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/conversation/tool-card.tsx#L40) | 展开重置、状态文案、现有摘要和输出复制。 |
| S5 | [actions.ts](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/public/kernel/actions.ts:19>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/public/kernel/actions.ts#L19) | ToolExecution 的四种状态与独立交互事件。 |
| S6 | [conversation-composer.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/conversation/conversation-composer.tsx:26>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/conversation/conversation-composer.tsx#L26) | 交付内容筛选、form 外待发区、Enter 与上传入口。 |
| S7 | [styles.css：输入区](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/styles.css:675>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/styles.css#L675) | form 表面、焦点、历史库高度、上传控件、状态操作与选择区样式。 |
| S8 | [message-cards.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/conversation/message-cards.tsx:56>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/conversation/message-cards.tsx#L56) | 非流式成果、模型失败／取消、重新提问与复制。 |
| S9 | [message-citations.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/conversation/message-citations.tsx:84>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/conversation/message-citations.tsx#L84) | 来源分组、数量、引用位置、hover／focus 预览及打开行为。 |
| S10 | [styles.css：引用](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/styles.css:816>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/styles.css#L816) | 默认摘录隐藏、整体透明度、小字与移动端预览规则。 |
| S11 | [citation-projection.ts](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/features/citation/citation-projection.ts:43>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/features/citation/citation-projection.ts#L43) | 正文标记解析、artifact 分类与不可用标记。 |
| S12 | [SessionSidebar.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/sessions/SessionSidebar.tsx:199>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/sessions/SessionSidebar.tsx#L199)、[侧栏样式](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/styles.css:90>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/styles.css#L90) | 比例、滚动、折叠、时间文字与右键操作。 |
| S13 | [ConversationStage.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/conversation/ConversationStage.tsx:16>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/conversation/ConversationStage.tsx#L16)、[欢迎页样式](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/styles.css:204>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/styles.css#L204) | 已有新任务按钮、三栏介绍与展示字号。 |
| S14 | [AppShell.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/app/AppShell.tsx:4>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/app/AppShell.tsx#L4) | 分栏宽度、限制、ResizeObserver 与键盘拖动。 |
| S15 | [ExtensionDialogLayer.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/extension-ui/ExtensionDialogLayer.tsx:96>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/extension-ui/ExtensionDialogLayer.tsx#L96)、[run-feedback.ts](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/contracts/run-feedback.ts:4>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/contracts/run-feedback.ts#L4)、[GeoWorkspace.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/features/geo/GeoWorkspace.tsx:180>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/features/geo/GeoWorkspace.tsx#L180) | 对话框确认／输入、运行取消与地图请求横幅。 |
| S16 | [tool-card-formatting.ts](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/conversation/tool-card-formatting.ts:5>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/conversation/tool-card-formatting.ts#L5) | 参数和输出截断上限。 |
| S17 | [feedback-smoke.mjs](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/scripts/harness/feedback-smoke.mjs:63>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/scripts/harness/feedback-smoke.mjs#L63)、[composer-attachments.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/conversation/composer-attachments.tsx:16>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/conversation/composer-attachments.tsx#L16)、[session-attachment-library.tsx](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/platform/conversation/session-attachment-library.tsx:10>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/platform/conversation/session-attachment-library.tsx#L10) | 附件状态、草稿隔离、复用、迟到响应与拒绝发送。 |
| S18 | [tokens.css](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/web/styles/tokens.css:10>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/web/styles/tokens.css#L10) | 已有结构刻度、字体及三主题色值。 |
| S19 | [citation.ts](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/src/contracts/citation.ts:11>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/src/contracts/citation.ts#L11) | 日期、版本、资源与定位字段的实际边界。 |
| S20 | [react-smoke.mjs](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/scripts/react-smoke.mjs:84>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/scripts/react-smoke.mjs#L84)、[document-smoke.mjs](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/scripts/harness/document-smoke.mjs:185>) · [固定快照](https://github.com/Ran2424/transportx-agent/blob/e21fb4e3bf4c73ffd86f66b5dbd66ead843affea/scripts/harness/document-smoke.mjs#L185) | 已有流式、成果打开、文档主题截图与移动端检查。 |

审阅约束来自 [AGENTS.md](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/AGENTS.md>)；版本及发布状态来自 [package.json](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/package.json:3>) 和 [CHANGELOG](</Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/docs/CHANGELOG.md:9>)。


## 11. 第一阶段实施记录（2026-10-13）

### 11.1 范围与分支

第一阶段在 `codex/style-upgrade-phase-one` 开发，分支由原工作区分支 `codex/test-budget-total` 建立，HEAD 仍为 `d217ab5`。原工作区已有桌面、服务端、测试预算等未提交内容，切换分支保留这些内容；本阶段仅修改以下 UI 与 Web 冒烟文件，更新本报告及当前未发布版本 CHANGELOG，尚未提交、推送或合并。

| 文件 | 实施内容 |
| --- | --- |
| `src/web/lib/input-composition.ts` | 共用组合输入判断，覆盖 `isComposing` 及 keyCode 229。 |
| `conversation-composer.tsx` | 主输入／运行中补充保护，按钮与 Enter 共用交付条件，键盘上传入口。 |
| `ExtensionDialogLayer.tsx` | 输入与自定义回答的组合输入保护。 |
| `src/web/styles.css` | 聚焦／无悬停复制可见；相关附件与引用功能文字至少 11px；使用现有语义色，避免整体淡化文字。 |
| `src/web/styles/tokens.css` | Sand 次级文字由 `#6F6963` 调为 `#66615B`，主动作背景／悬停由 `#B96D4C`／`#A85A3A` 调为 `#A85A3A`／`#8F4A2E`。 |
| `scripts/harness/feedback-smoke.mjs`、`scripts/react-smoke.mjs` | 在现有脚本增加边界、键盘、无悬停及渲染对比度断言，未增加 Node 测试注册。 |

修改前，主输入两个合成组合 Enter 均产生了发送请求，回归断言报 `2 !== 0`；修改后均不发送。仅失败附件不可发送，有效正文与失败项混合时仍可发送且不携带失败项；上传中按钮与 Enter 均不可交付。ready 附件单独发送包含附件 ID，地图上下文单独存在时按钮可用，既有地图上下文交付审计仍通过。停止入口独立保留。

实测还发现两处叠加背景问题：Sand 选中会话时间文字、Dark 用户消息引用编号。前者通过 Sand 次级文字 token 校准，后者改用 `text-primary`；引用背景和边框继续保留品牌语义。没有新增 token 源，也没有组件主题覆盖。

### 11.2 自动验证与证据

基线及修改后的 `npm run typecheck:react` 均通过。`npm run test:budget` 为 **40/40**。完整 `npm run test:web`（全量构建、预算检查及实际 Chrome／Node Host／fake Pi 冒烟）通过；补充纯附件发送、上传中 Enter、键盘复制及地图上下文按钮断言后，再运行同一 `node scripts/react-smoke.mjs`，退出码为 0。

覆盖的新增检查包括：主输入、流式补充、Extension 输入及自定义回答的组合 Enter；普通 Enter、Shift+Enter；失败附件、有效正文与失败项混合、纯 ready 附件、上传中不可交付；键盘 Enter 打开文件选择器并上传；聚焦复制并用 Enter 激活；无悬停浏览器中复制常态可见。既有草稿／附件会话隔离、刷新恢复、拒绝发送、迟到 ACK、文档与成果、地图上下文、地图请求恢复及视频场景仍通过。

三主题检查采用同一会话，读取实际计算样式，将元素及祖先背景与透明度合成后计算文字对比度；每主题抽查 31 个元素，字号均不低于 11px。检查对象包括会话时间、消息附件说明、工具耗时、引用编号／数量、成果数量及可用发送按钮；不是全工作台的无障碍认证。

| 主题 | 抽查文字最低对比度 | 可用主按钮对比度 |
| --- | --- | --- |
| Light | 4.75:1 | 5.01:1 |
| Dark | 4.66:1 | 6.39:1 |
| Sand | 4.71:1 | 5.01:1 |

本地证据保存在 `.plans/style-upgrade-phase-one/validation/`：

- [逐元素对比度数据](../.plans/style-upgrade-phase-one/validation/contrast.json)
- 同一会话的 [Light](../.plans/style-upgrade-phase-one/validation/conversation-light.png)、[Dark](../.plans/style-upgrade-phase-one/validation/conversation-dark.png)、[Sand](../.plans/style-upgrade-phase-one/validation/conversation-sand.png) 截图，1280 × 900；已查看画面。这里是修改后截图，不充当第二阶段布局前后对比。
- [最终 Web 冒烟输出](../.plans/style-upgrade-phase-one/validation/web-smoke.log)。截图和日志属于本地验证产物，不提交生成物；提交 PR 时应将需要的证据附在 PR 上。

### 11.3 验收边界与下一阶段

**第一阶段代码实现及自动回归通过，真实产品验收仍有待办。** 上述 IME 检查是合成 KeyboardEvent，键盘检查由 Playwright 驱动，无悬停检查使用支持触摸的浏览器上下文；不能据此称 macOS／Windows 系统候选窗或真实触屏已验收。系统中文／日文输入法、真实 Electron 窗口、字体缩放及屏幕阅读器仍待实测，交付记录需注明系统、输入法、窗口与操作结果。

第一阶段结束时第二、三阶段尚未实施。随后已按计划保存宽／窄会话基线，并分别实施、验证工具展开状态和消息宽度；第二阶段记录见第 12 节，第三阶段仍待实施。


## 12. 第二阶段实施记录（2026-10-13）

### 12.1 范围与实际行为

第二阶段在 `codex/style-upgrade-phase-two` 开发，从第一阶段分支建立，保留其工作区内容。HEAD 仍为 `d217ab5`，两阶段改动尚未提交或推送；原有其他任务的桌面、服务端、测试预算改动仍保留。

先保存第一阶段完成后的视觉基线，再单独实施工具展示并跑完整 Web 冒烟，最后调整消息布局并回归。实现范围如下：

| 文件 | 第二阶段修改 |
| --- | --- |
| `tool-card.tsx`、`tool-expansion-store.ts` | 默认收起详情；准备中、执行中、已完成、出错直接显示；按会话与工具调用 ID 保存手动开合。 |
| `src/web/app/App.tsx` | 按现有会话和工具投影清理关闭会话及失效工具的开合记录。 |
| `message-cards.tsx`、`src/web/styles.css` | 正文与宽内容分别限制宽度，启用已有轮次容器布局，调整间距与表格字号，修正自动跟随的平滑滚动问题。 |
| `src/web/i18n/resources.ts` | 中英文短准备状态。 |
| `conversation-layout-smoke.mjs`、`react-smoke.mjs`、`baseline.json` | 在现有 Web 冒烟中增加状态、布局及滚动场景，保存比较证据。 |
| `test/suites/tool-utils.test.ts` | 合并开合状态保留、隔离与清理断言，未增加测试注册。 |

工具摘要仅取既有 `path`、`command`、`query`、`url`、`title`、`action` 字符串；没有可用摘要时显示工具名称。移除了任意字符串参数的回退读取，避免把无关参数作为操作对象。耗时继续使用既有实际计时数据。错误使用明确的“出错”状态；没有通用安全错误原因时不新增原因摘要，不截取原始结果。原始参数、结果及预览仍由用户展开详情访问。此修改不构成参数或输出的通用脱敏机制。

手动展开与手动关闭均保存在当前页面内存，键为 `(sessionId, toolCallId)`。同一会话实时工具转入历史、切换会话后返回均保留选择；不同会话相同 ID 相互隔离。加载中或运行中的会话暂保留记录，待完整投影可用后清理缺失工具；关闭会话时删除其记录。刷新应用后回到默认折叠，不增加持久化契约。

Assistant 使用会话列可用宽度；普通段落、标题、列表及引用块上限为 `72ch`，表格与代码不受该段落上限限制。会话内容外框仍为 1040px 上限。面板宽度不超过 600px 时，左右内边距使用已有 16px token。已有 `.assistant-turn` 从 `display: contents` 改为真实纵向容器，轮次外间距 16px、内部间距 8px；这是现有消息条目的布局分组，不新增工具步骤或逻辑轮次投影。表格使用现有 13px token，表头保持横向阅读，超宽内容在自身容器内滚动。

滚动回归发现，原有 `scroll-behavior: smooth` 下回到底部后，最后一段流式内容仍留下 34px 底部差值。改为 `auto` 后差值为 0px，上文阅读位置保持不变。保留 `nearBottom` 判断、RAF 更新及会话投影逻辑。

### 12.2 对比与验证证据

同一组 fake Pi 会话内容，通过真实 Node Host 和 Chrome 比较；窗口为 1600 × 1000，窄模式打开已有引用报告 Canvas 并用分栏键盘入口收窄聊天列。它验证通用分栏下的聊天布局，地图业务流程另由既有 Web 冒烟回归，不能称为实际交通数据或真实 Electron 验收。

| 场景 | 第一阶段后基线 | 第二阶段后 |
| --- | --- | --- |
| 宽模式可用内容宽度 | 976px | 976px |
| 宽模式普通段落宽度 | 829px | 658px |
| 宽模式表格容器宽度 | 829px | 976px |
| 332px 聊天列普通段落宽度 | 206px | 300px |
| Assistant 右内边距 | 30px | 0px |

三主题测量尺寸一致。窄模式表格容器 300px、内容 377px；代码容器 298px、内容 4794px，均局部滚动，会话列 `scrollWidth` 等于 `clientWidth`。宽模式段落变短、表格与代码变宽，验证了阅读上限与宽内容分离。

自动检查通过：修改前后 `npm run typecheck:react`；`npm run typecheck:test`；既有工具测试；`npm run test:budget` **40/40**；工具修改单独检查及最终完整 `npm run test:web`。完整 Web 冒烟包含第一阶段输入、键盘、三主题对比度，既有文档、成果、地图、Canvas、视频与桌面更新 UI 场景。

新增交互断言覆盖 preparing → running → completed/error、实时转历史、手动开合保持、切换会话返回、同 ID 跨会话隔离，以及测试密钥／私有错误输出不进入标题。连续工具运行与长回复流式输出时，上文位置不变；用户回到底部后最终差值为 0px。关闭与过期状态清理由合并到现有工具测试的断言检查。

本地验证产物位于 `.plans/style-upgrade-phase-two/validation/`：

- `before/`、`after/` 各有宽／窄 × Light／Dark／Sand 六张截图及 `layout.json`。截图采集重置 `scrollIntoView` 导致的外层横向滚动，以保留完整工作台画面；该操作只在测试脚本中。
- [工具状态画面](../.plans/style-upgrade-phase-two/validation/tool-states.png) 与工具阶段 [Web 输出](../.plans/style-upgrade-phase-two/validation/tools-web-smoke.log)。
- [最终完整 Web 输出](../.plans/style-upgrade-phase-two/validation/after/web-smoke.log)、[滚动位置记录](../.plans/style-upgrade-phase-two/validation/scroll.json)。
- 宽模式 [改前](../.plans/style-upgrade-phase-two/validation/before/wide-light.png)／[改后](../.plans/style-upgrade-phase-two/validation/after/wide-light.png)，窄模式 [改前](../.plans/style-upgrade-phase-two/validation/before/narrow-light.png)／[改后](../.plans/style-upgrade-phase-two/validation/after/narrow-light.png)。

截图与日志不入 Git，后续 PR 需附所需证据。基线日志、完整构建回归日志与截图采集复查日志分别保存，避免将不同运行混称为一次验证。

### 12.3 完成状态与待验收项

**第二阶段代码实现及自动回归通过；布局与默认折叠方案仍需真实使用验收。** 当前画面与尺寸为本机字体、同一受控会话的比较结果，不能证明所有交通回答均改善。真实 Electron、系统字体缩放、触屏、屏幕阅读器及系统 IME 实测继续保留为待办。默认折叠已证明能保持状态和选择，是否符合分析人员偏好仍应通过实际会话确认。

第二阶段结束时，第三阶段输入表面整合、引用与成果展示尚未实施，后续结果见第 14 节。本阶段没有扩展工具协议、重建消息投影、增加 token 源或更改侧栏 30%／70% 规则。


## 13. 补充：执行详情与 Working 折叠（2026-10-13）

用户进一步选择：在正文之间按连续执行片段分别折叠。判断为合适，实施难度中等；重点是保留正文边界、实时／历史一致性及可靠计时，而不是改变工具执行方式。本补充在 `codex/working-display` 分支实施，保留第一、二阶段和原工作区未提交内容。

“显示思考过程”设置改称“显示执行详情”，继续使用现有偏好存储键，默认值不变。开启时显示既有思考状态和工具卡片；关闭时每个连续片段默认只显示可点击的 `Working · 耗时`。Agent 正文形成片段边界，始终可见；成果、引用和模型反馈仍由正文消息显示，Extension 确认、输入及地图请求入口保持原有展示。按用户后续意见，折叠摘要不单独显示“出错”；展开后的工具卡片保留错误状态和原始详情。运行中的 Working 与 `· · ·` 使用已有语义色的流动渐变，完成后停用动画；系统减少动态效果偏好下使用静态文字。

点击 Working 展开该片段，恢复现有思考区和工具列表；思考内容仍遵循“默认展开思考内容”，工具参数和结果仍需各自展开。新增思考和工具不会关闭已展开的片段；重新收起再展开后，工具卡片自身的手动开合仍按第二阶段规则保留。片段开合属于当前会话视图状态，刷新或重新进入会话时回到默认折叠，没有新增持久化设置。

片段耗时定义为首次活动开始至最后活动结束的时间跨度，包含活动之间的等待，不等同于整次提问耗时，不累加并行工具时间。运行中更新，结束后冻结。复用 `.tau/timing-metrics.v1.json` 已记录的起始时间与时长：服务端只补充向消息投影传递 `startedAt`，实时事件及历史恢复继续传递该字段，文件 schema 与工具调用协议不变。单条历史活动仅有时长时可直接使用；多条活动缺完整起始时间时显示 `—`，不能用消息时间戳猜测。

实现入口为 `ConversationWorkspace.tsx`、`execution-group.tsx`、`execution-parts.ts`、`message-cards.tsx`、`tool-projection.ts` 及现有主题样式、设置文案。计时补充涉及 `session-event-timing.ts`、`timing-metrics.ts`、`app-types.ts` 与现有事件归一化／快照恢复。原会话 store 保持快照加实时覆盖结构，新增分组只作用于 React 视图。

验证合并到现有测试：连续执行合并、正文分隔、重叠活动跨度、缺失计时、不改变原始历史条目；Web 冒烟检查设置开关、正文始终可见、键盘展开、运行结束保持展开、工具选择保持、摘要不显示错误、工具详情保留错误、运行渐变／减少动态效果、三主题画面及刷新后耗时一致。刷新回归曾发现快照恢复遗漏工具起始时间，已补齐并加入事件归一化断言。最终 `npm run typecheck`、React 类型复查、`npm test`（40/40）及构建后的完整 Web 冒烟均通过，前两阶段输入、工具、正文宽度、文档、地图及滚动回归仍通过。测试注册仍为 40 个。

本地证据位于 `.plans/working-display/validation/`：[运行画面](../.plans/working-display/validation/working-active.png)、[Sand 折叠画面](../.plans/working-display/validation/collapsed-sand.png)、[展开画面](../.plans/working-display/validation/expanded.png)、Light／Dark 折叠画面、[实时／历史计时对比](../.plans/working-display/validation/result.json)及最终类型、Node 与 Web 检查日志。运行及展开画面采集前将执行片段滚入视野，保持对应状态可见。静态截图不证明动画效果；渐变动画及减少动态效果由浏览器样式断言验证。此处自动验证使用真实 Node Host／Chrome 和 fake Pi；真实 Electron、系统输入法及字体缩放验收仍按前述待办执行。


## 14. 第三阶段：输入表面、引用与成果（2026-10-13）

### 14.1 实施范围与结果

第三阶段在 `codex/style-upgrade-phase-three` 分支继续开发，沿用当前工作区的第一、二阶段及 Working 实现，保留其他未提交改动。此次未提交、推送或创建 PR，不将本机开发状态称为产品升级验收通过。

输入 form 按“本次内容 → 文字输入 → 操作栏”组织。待发送附件、地图和 Canvas 上下文均进入顶部选择区，历史文件库与已排队消息仍位于 form 外。顶部显示当前选择数量，数量包含上传中和失败项，用于表示需要处理的选择，不代表实际交付数量。附件保留文件名、格式、大小和状态；失败项直接标明“上传失败 · 未包含在本次消息”，有有效内容时仍可发送。移除控件使用 28px 命中区域并提供焦点反馈，从本次移除不删除历史文件。

附件和上下文共享卡片间距、圆角与移除规则，同时保留类型差异：地图显示实际 summary、选择模式；Canvas 显示所选视图的真实标题和版本。标题在附加时从匹配 viewId／revision 的视图取得，只保存在前端待发送状态；缺少标题时回退到真实 viewId，不推导标题，不改变 Canvas 协议。选择区高度上限为 `min(180px, 25vh)`，超出后在内部滚动，文字输入和操作栏位于滚动区外。常态输入表面取消阴影，聚焦时沿用现有边框与焦点环。

引用仍默认显示来源标题、数量、编号和定位入口；没有把整个来源列表折叠。每组来源增加原生 `details`，可通过鼠标、键盘或触屏主动查看摘录与来源信息。长摘录保留全文，在最高 240px 的详情区内滚动。仅显示契约已有的发布日期、版本和标准编号；路径置于详情，缺失摘录明确提示。原有悬停预览、来源打开与失效引用警告继续保留，不新增区域、单位或数据时段的推断。

成果卡片补充文件名、格式和明确的“打开”提示，标题允许换行，键盘焦点可见。打开行为继续复用文档 Canvas 与 FilePreview，加载、版本校验和失败反馈沿用既有入口。卡片覆盖仍限于正文引用且可解析的 artifact，不扫描工具输出、文件路径或任务目录发现成果。

### 14.2 混合发送回归发现与修复

新增多附件＋地图＋Canvas 的真实发送检查复现了两个已有问题：提示文字拼接顺序为附件 → 地图 → Canvas，但正文清理先处理附件，附件清理要求其标记位于文本末尾，因此残留附件提示会干扰正文与 Geo 历史关联；Canvas 恢复此前只处理字符串，不能从 Pi 文本块数组恢复 contextIds。

最小修复是在 Host、Geo 关联恢复和浏览器正文提取中按 Canvas → 地图 → 附件清理，并让现有 Canvas 恢复支持文本块数组，保留图片块及原始历史条目。此次仅修正既有提示的识别和展示，没有新增交付协议、第二套投影系统或新的上下文权限。回归断言合并到现有 Geo／Canvas 测试，测试注册总数保持 40。

### 14.3 文件与验收证据

| 文件 | 本阶段变化 |
| --- | --- |
| `conversation-composer.tsx`、`composer-attachments.tsx`、`styles.css` | 选择区进入输入表面、失败未包含状态、统一卡片和焦点、限定高度与常态阴影。 |
| `canvas-context-store.ts`、`app/App.tsx` | 附加时保存所选视图的可靠标题，不写入服务端契约。 |
| `message-citations.tsx`、`i18n/resources.ts` | 引用主动展开、既有元数据、成果文件名与打开文案，中英文同步。 |
| `sessions.ts`、`geo-interaction-service.ts`、`canvas-service.ts`、`public/kernel/stores/conversation-store.ts` | 修复混合提示清理和数组消息中的 Canvas 恢复。 |
| `composer-selection-smoke.mjs`、`document-smoke.mjs`、`react-smoke.mjs`、`baseline.json` | 多附件、失败、真实上下文、短窗口、拒绝与刷新恢复、引用和成果交互检查。 |
| 既有 `canvas-service.test.ts`、`geo-interaction-service.test.ts` | 数组恢复、非文本块保留、混合提示与 Geo 关联回归断言。 |

修改前 React 类型检查通过，最终全量类型检查和构建通过；构建后的完整 Node 回归 **40/40**、完整 Web 冒烟均通过。Web 回归验证六个成功附件与一个失败附件的混合选择，键盘移除一个成功附件后，实际交付为五个附件、一个地图上下文和一个 Canvas 上下文；失败项被排除，发送拒绝后所有有效选择保留。选择区实测为 180px，内部内容为 558px；1280 × 650 短窗口下输入和发送仍可见。

真实发送成功后本次选择清空；刷新后五个附件及两类上下文的 ID 均保持一致，用户消息仅一条，未出现附件内部提示。引用检查覆盖键盘展开、长摘录局部滚动、发布日期／版本／标准编号、触屏摘录核对及来源打开；成果卡片键盘打开文档成功。前两阶段的 IME 合成事件、历史复用、迟到确认、三主题实际文字对比度、宽／窄阅读、工具状态、Working、流式滚动、地图请求、视频和桌面更新 UI 回归仍通过。三阶段代码实现及自动回归完成，产品实测边界仍见下段。

本地证据位于 `.plans/style-upgrade-phase-three/validation/`：多附件 [列表画面](../.plans/style-upgrade-phase-three/validation/selection-files.png)，附件／上下文 [Sand 画面](../.plans/style-upgrade-phase-three/validation/selection-sand.png)与 Light／Dark 对应画面，[短窗口](../.plans/style-upgrade-phase-three/validation/selection-short.png)，引用与成果 [Light](../.plans/style-upgrade-phase-three/validation/citations-light.png)／[Dark](../.plans/style-upgrade-phase-three/validation/citations-dark.png)／Sand 画面及 [来源元数据](../.plans/style-upgrade-phase-three/validation/source-metadata.png)。尺寸与交付数量记录为 `selection.json`，混合发送刷新结果为 `delivery.json`。截图和日志不入 Git，PR 应附对应证据。

自动场景使用真实 Node Host／Chrome 和 fake Pi，包括真实文件上传、上下文创建和资源打开；触屏检查使用浏览器触屏模拟。真实 Electron、系统输入法、屏幕阅读器、实际触屏及系统字体缩放仍需产品验收。没有改动三主题 token 声明源、侧栏 30%／70% 规则、模块版本或平台版本。


## 15. 完整分支整合（2026-10-13）

统一交付分支为 `codex/style-upgrade`，基于 `d217ab50f91218ce5da074fa46fafd6c5a4bd4af`。三个阶段及 Working 补充此前都位于同一工作区，阶段分支指向相同基线，没有独立阶段提交需要 cherry-pick。此次将相关源码、测试和本报告提交为完整版本，验证后删除冗余的样式阶段分支，保留这一条样式开发分支。其他任务的分支与未提交文件保留。

整合内容包含第一阶段输入正确性与基础可用性，第二阶段阅读宽度、工具开合状态和滚动，Working 连续执行片段与运行渐变，以及第三阶段附件／地图／Canvas 输入整合、引用详情、成果入口和混合消息恢复。平台及模块版本沿用现有版本，变更归入 `3.23.0 - 未发布`。

阶段回归断言依赖工作区中已经完成的测试预算调整，因此一并纳入 40 个直接注册场景、预算预检和实际测试节点报告器，移除旧 case 回调层。测试所需的平台权限标志沿用唯一平台 Profile，并通过现有 Host 操作表消费。其他开发中的 OpenRouter 限制、启动恢复及退出修改不纳入本分支；共享测试文件中依赖这些功能的断言仅保留在原工作区，不放入整合提交。

分支验证使用从 Git 暂存树导出的独立源码目录，只共享已安装依赖，重新构建全部产物。这样检查的是将要提交的完整版本，不依赖原工作区中其他任务的代码或旧构建产物。本轮独立快照验证全部通过：`npm run typecheck`；`npm test`（含全量构建，实际注册与通过均为 **40/40**，无 skip／todo）；`npm run test:web`（含全量构建和完整 Web 冒烟）。Web 检查覆盖三个阶段、Working 动画与开合、混合附件／Geo／Canvas 发送及刷新恢复，并回归既有地图、视频和桌面更新 UI。

原工作区保存文件摘要，用于核对整合过程没有覆盖其他任务的内容。截图和日志继续保存在本机 `.plans/`，不进入 Git；分支提交不代表正式发布。真实 Electron、系统输入法、屏幕阅读器、实际触屏和系统字体缩放仍需产品验收。

本轮日志位于 `.plans/style-upgrade-integration/typecheck.log`、`node-test.log` 和 `web-smoke.log`；独立目录为 `snapshot/`，其 `.plans/` 保存此次重新采集的三主题、宽窄布局、Working、附件及引用画面。所有检查均针对整合源码，未使用原工作区构建产物。最终仅本报告在整合过程中发生正文修改，其他工作区文件摘要与整合前一致。分支版本已本地提交，尚未推送、创建 PR 或合并 main。


## 16. Working 等待、独立计时与黑白动效（2026-10-13）

本次继续在 `codex/style-upgrade` 开发。用户反馈运行时偶尔出现耗时 `—` 和“等待模型响应”，且 Working 文字不够突出；进一步要求从本轮正文发出后独立计算耗时。

实时计时优先采用权威用户消息的发送时间，从该时点连续增长，覆盖模型首个响应、工具执行和工具后的模型等待，不再要求思考或工具自身具备计时字段。用户消息尚未回显时，使用前端接收到本轮 `agent_start` 的时刻作为临时起点；工具／思考更新与重试不重置该时刻。完成的执行片段计至最后一次活动结束，沿用相同消息起点；历史没有用户时间时回退到原片段计时，没有完整记录时省略耗时与分隔符。没有新增持久化或工具协议，不从缺失记录补造时间。第 13 节首次活动跨度是此前实现，本节按用户后续要求调整计时口径。

关闭执行详情时，等待模型沿用正文之后的最后一个 Working 片段，保持已展开选择；首个活动之前也显示 Working 和独立耗时，该时段暂不提供空详情操作。显示执行详情时，原思考及工具展示保留，纯模型等待改用 Working。新空片段等待 180ms 后才出现，避免回复收尾的短暂空档闪现；真实等待依然可见，耗时起点不受展示延迟影响。模型失败、重试及用户确认仍保持原有独立反馈。

Working 文字使用唯一 token 源中的 `--text-working`：Light／Sand 黑色，Dark 白色；14px、600 字重。运行时文字内部进行两秒循环的透明渐变扫光，完成后停止；减少动态效果时使用静态黑／白文字。耗时维持次级文字，空详情按钮保留正常不透明度，避免等待时变淡。修正选择器优先级，Working 使用内容宽度和可见键盘焦点环。

回归合并到现有 Node 和 Web 场景，不增加测试注册数。检查首个模型活动前计时、工具完成后等待继续计时、历史缺失计时不显示占位、原开合选择、三主题真实渐变颜色与背景位置移动、减少动态效果，以及完整的前三阶段与 Working 流程。独立暂存树快照的全量类型检查、全量构建与 Node 回归 **40/40** 通过；补充滚动跟随后，React 类型复查及完整 `npm run test:web` 通过。首个活动前的三秒模型等待、工具后的等待均实测持续计时；历史刷新保持完成片段耗时；缺失计时只显示 Working。浏览器断言确认三主题的黑／白色、透明渐变及动画背景位置移动，减少动态效果时动画停止。新增等待行自动跟随底部，同时保留正在读上文时的位置。截图已检查，日志及截图位于 `.plans/working-refinement/`，均不入 Git。


## 17. 默认折叠执行详情（2026-10-13）

按用户要求，初始界面默认将思考和工具执行收起为 Working，点击仍可展开。思考正文原本已经默认收起，本次改变的是“显示执行详情”的初始状态。偏好改用 `tau-show-execution-details`，旧版在启动时自动写入的 `tau-show-thinking=true` 不再覆盖新默认值；切换后新偏好继续持久保存，不在每次启动时强制关闭。

改动仅涉及 App 偏好读取／保存及现有 Web 冒烟的初始设置步骤，保留此前阶段实现。独立暂存树快照的 React 类型检查、全量构建和完整 Web 冒烟通过，预算预检仍为 40/40。检查旧开启值不覆盖默认折叠、思考正文默认收起、手动选择刷新后保持，以及既有 Working、三主题、工具、输入和资源流程。模拟旧偏好的测试注入限制在主页面，不进入预览 iframe。本机 React 构建也已更新。日志位于 `.plans/working-default/`，不入 Git。


## 18. PR 前 main 集成验证（2026-10-13）

按用户要求，将完整样式分支通过 PR 合入 main，并保留 `codex/style-upgrade`。在独立工作区合并远端 main `e21fb4e3bf4c73ffd86f66b5dbd66ead843affea`，保留其桌面启动、IPC 退出、锁恢复及安全回归；六个重叠测试文件保留样式与计时断言，桌面及模型测试沿用 main，发布记录合并双方变更。第 15 节“尚未推送”等内容是该轮完成时的历史状态；本节更新当前交付步骤。

合并后的实际 PR 差异为三阶段 UI、Working、混合上下文恢复、相关回归和报告，不重复提交已进入 main 的测试预算迁移及启动修复。原工作区的其他任务未提交文件保留，不纳入 PR。

独立工作区重新运行 `npm run typecheck`、`npm test` 与 `npm run test:web`，全部通过。Node 实际注册与通过均为 **40/40**，无 skip／todo；完整 Web 冒烟包含默认折叠、持续计时、三主题动态与减少动态效果、宽窄布局、滚动、多附件及两类上下文、引用与成果打开，并回归地图、视频和更新 UI。日志位于独立工作区 `.plans/pr-validation/`，截图在其 `.plans/` 中，均不入 Git。真实系统输入法、屏幕阅读器、实际触屏及系统字体放大仍需产品验收。
