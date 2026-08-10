# TransportX Traffic Agent UI 质感优化改造方案

- 日期：2026-08-09
- 状态：已改造完成
- 适用范围：`src/web/` React 桌面工作台
- 产品定义：TransportX Desktop Workbench
- 交互模型：Codex / VS Code 式高密度面板工作台
- 主题体系：Light / Dark / Sand
- 品牌原则：TransportX 品牌保留，强调色克制使用

## 1. 结论

本轮改造不调整 TransportX Traffic Agent 已有的工作台信息架构，也不改变文件栏、地图模式、任务面板、标签页和主对话区之间的产品关系。

本轮处理三个目标：

1. 在现有会话侧栏内部增加能力扩展区，并将侧栏可用内容区域按上 30%、下 70%拆分。
2. 建立 Light、Dark、Sand 三主题共用的设计系统，使主题只改变视觉 token，不改变布局和组件实现。
3. 统一全产品的表面、字体、间距、边框、圆角、控件和交互状态，使产品更接近成熟的本地桌面应用。

目标不是把界面改成另一个产品，而是让用户仍然认得当前 TransportX，同时明显感受到界面更精确、更稳定、更克制。

设计读法：面向交通分析人员的本地 Agent Workbench，学习 Codex 和 VS Code 的结构纪律，不复制它们的配色；TransportX 继续通过品牌标识、Sand 主题和克制的暖色交互建立识别度。

最终设计目标：

```text
TransportX Desktop Workbench

Interaction model  Codex / VS Code
Density            IDE-level
Structure          Panel-oriented
Brand              TransportX
Themes             Light / Dark / Sand
Accent philosophy  Restrained
```

建议设计参数：

- `DESIGN_VARIANCE: 4`
- `MOTION_INTENSITY: 3`
- `VISUAL_DENSITY: 7`

## 2. 改造边界

### 2.1 必须实现

- 会话侧栏内部增加能力扩展区。
- 固定工具栏以下的侧栏可用空间默认按 30:70 分配。
- 能力扩展区位于会话列表上方。
- 能力扩展区支持模块、技能、数据、知识四类内容。
- 能力扩展区与会话列表分别独立滚动。
- 能力扩展区支持收起。
- 建立 Light、Dark、Sand 三套完整主题。
- 三套主题共用相同布局、字号、间距、圆角、组件 DOM 和交互模式。
- 统一全部基础组件的视觉和交互状态。
- 清理重复和互相覆盖的 CSS 主题定义。
- 保持桌面、窄屏和移动端行为稳定。

### 2.2 明确不改

- 不增加新的 Activity Rail。
- 不把工作台重组为 Editor 与 Inspector 架构。
- 不改变当前会话侧栏的整体位置和默认宽度。
- 不改变主对话区的布局。
- 不在对话区内部插入能力扩展区。
- 不改变地图模式下地图与聊天区域的关系。
- 不改变文件栏的打开方式和停靠位置。
- 不改变任务面板当前的产品语义。
- 不改变报告预览和文件预览的既有打开逻辑。
- 不改动 URL、后端协议、Kernel、WebSocket 或 Extension 协议。
- 不借本轮视觉改造重写现有文案和业务流程。
- 不允许在组件样式中编写 Light、Dark、Sand 专属选择器。
- 不允许不同主题改变组件尺寸、布局密度或信息架构。

## 3. 当前实现基线

项目已经具备完整的 React 桌面工作台骨架：

- 顶部工具栏：`src/web/components/shell/Header.tsx`
- 工作台布局：`src/web/app/AppShell.tsx`
- 会话侧栏：`src/web/platform/sessions/SessionSidebar.tsx`
- 会话标签：`src/web/platform/sessions/LiveTabs.tsx`
- 对话区：`src/web/platform/conversation/ConversationWorkspace.tsx`
- 地图工作区：`src/web/features/geo/GeoWorkspace.tsx`
- 文件栏和任务浮层：`src/web/platform/workspace/WorkspaceDock.tsx`
- 设置：`src/web/platform/settings/SettingsDialog.tsx`
- 全局样式：`src/web/styles.css`

当前实现中值得保留的部分：

- 顶部工具栏、会话侧栏、主工作区和文件栏的布局关系已经稳定。
- 地图模式支持调整聊天区域宽度，并提供键盘操作的分隔条。
- 顶栏按钮已具备 `aria-pressed`、禁用状态和可访问名称。
- 对话框基于 Radix Dialog，具备较好的焦点管理基础。
- Terracotta 欢迎页已经形成可识别的品牌视觉。
- 桌面和移动端已经存在不同的侧栏呈现策略。

当前主要视觉问题：

- `styles.css` 前后存在重复的主题 token 和组件覆盖，最终效果依赖声明顺序。
- 设置页面中的主题预览色与后续覆盖后的实际主题值不完全一致。
- 颜色 token 只有基础背景、文字、边框和强调色，缺少完整的表面和状态体系。
- 当前主题仍接近多套独立配色覆盖，没有形成三主题共用的 semantic token contract。
- 单一 `accent` 同时承担按钮、选中、焦点、链接和状态，进入 Dark Theme 后容易过亮或失去层级。
- 字号覆盖 7px 到 18px，部分功能文字过小。
- 圆角覆盖 5px 到 18px，并混合圆形控件，缺少明确规则。
- 多个组件分别定义 hover、active 和 focus，触感不一致。
- Terracotta 主按钮使用白字时存在普通文字对比度不足风险。
- 图标为项目内手写路径，扩展和视觉统一成本较高。
- 欢迎页标题和留白偏接近 SaaS Landing Page，与高密度工作台存在明显密度断层。
- Header 在任务状态下仍以品牌居中为主要视觉焦点，工具软件 Chrome 感不足。

## 4. 目标布局

### 4.1 工作台总体结构

工作台总体结构保持不变：

```text
┌──────────────────────── 顶部工具栏 ─────────────────────────┐
│ 会话侧栏 │                  主工作区               │ 文件栏 │
│          │ 对话 / 地图                            │ 可开关 │
│          │                                           │        │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 会话侧栏内部结构

会话侧栏默认宽度继续使用当前的 272px。侧栏固定工具栏不参与 30:70 计算。

```text
┌────────────── 会话侧栏 272px ──────────────┐
│ 固定工具栏                                 │
│ 主页 / 搜索 / 新建 / 刷新                  │
├────────────────────────────────────────────┤
│ 能力扩展区 30%                             │
│ 模块 / 技能 / 数据 / 知识                  │
│                                            │
├──────── 可操作的水平分隔区域 ──────────────┤
│ 会话列表 70%                               │
│ 当前会话 / 历史会话 / 运行状态             │
│                                            │
└────────────────────────────────────────────┘
```

建议组件结构：

```tsx
<aside className="session-sidebar">
  <SidebarToolbar />
  <div className="sidebar-split">
    <CapabilityPane />
    <SidebarSplitter />
    <SessionListPane />
  </div>
</aside>
```

### 4.3 比例和尺寸

- 固定工具栏：保持当前 `--react-top-rail-height`。
- 能力扩展区默认高度：侧栏剩余高度的 30%。
- 会话列表默认高度：侧栏剩余高度的 70%。
- 能力扩展区最小高度：120px。
- 会话列表最小高度：200px。
- 分隔条可操作热区：6px。
- 分隔条可见线条：1px。
- 双击分隔条恢复 30:70。
- 用户调整结果保存到 `localStorage`。
- 能力扩展区收起后保留 34px 标题栏。

如果第一阶段希望控制实现复杂度，可以先固定 30:70，只提供收起功能；拖动调整可在第二阶段补充。

## 5. 能力扩展区设计

### 5.1 产品定位

能力扩展区不是插件市场，也不是大卡片陈列区。它是用户快速查看当前本地 Agent 能力的紧凑入口。

它需要回答四个问题：

1. 当前安装了哪些能力？
2. 这些能力属于模块、技能、数据还是知识？
3. 哪些能力已经启用、正在使用或等待配置？
4. 用户如何查看详情或进入管理入口？

### 5.2 信息结构

```text
能力                                           更多
[模块] [技能] [数据] [知识]

交通数据模块                              已启用
道路速度查询                              Skill
上海交通知识库                            Knowledge
重大活动保障数据                          Data
```

建议只展示以下信息：

- 名称
- 类型
- 所属模块或来源
- 当前状态
- 一个主要操作入口

长描述、安装表单、路径信息和完整配置不应直接展开在 272px 的侧栏中，应放入现有设置页面或独立详情弹层。

### 5.3 分类切换

- 分类固定为模块、技能、数据、知识。
- 使用紧凑 Tabs，不使用胶囊标签云。
- Tabs 高度为 28px 到 30px。
- 分类栏保持单行。
- 当前分类使用文字颜色和底部 2px 强调线表示。
- 不为每个分类配置不同颜色。

### 5.4 能力列表

- 列表行高为 36px 到 40px。
- 默认只显示一行名称。
- 次要类型或来源使用 11px 辅助文字。
- hover 时显示更多操作。
- 选中项使用 `--selection-bg` 和左侧 2px `--selection-border` 强调线。
- 状态点只用于真实的运行或可用状态。
- 禁止使用大面积卡片、图片、插画或市场式网格。
- 禁止在列表中同时出现多个强调色。

### 5.5 状态词汇

统一使用以下状态：

| 状态 | 含义 | 表现 |
|---|---|---|
| 已启用 | 当前可被 Agent 使用 | 中性文字 |
| 使用中 | 当前会话正在调用 | `--status-info` 状态点 |
| 待配置 | 缺少必要本地资源 | 警告文字 |
| 不可用 | 当前环境无法加载 | 弱化并禁用 |
| 更新可用 | 本地模块存在新版本 | 文本提示 |

### 5.6 空状态和异常状态

- 加载：使用与列表行一致的骨架，不使用大型转圈 Spinner。
- 空状态：说明当前分类暂无内容，并提供进入设置的入口。
- 错误状态：在能力区内部显示简短错误，不使用全局 Toast 代替持续错误。
- 无会话时：展示全局已安装能力。
- 有会话时：优先显示当前会话可用和正在使用的能力。

## 6. 会话列表设计

会话列表继续使用现有数据和交互，只进行质感统一。

- 会话区独立滚动。
- 当前会话使用 `--selection-bg` 加左侧 2px `--selection-border` 强调线。
- hover 与 selected 必须有不同强度。
- 会话标题最多两行，超出后省略。
- 时间、状态和数量不得低于 11px。
- 运行状态使用单个语义状态点。
- 会话组标题使用 11px、600 字重，不使用过大的字符间距。
- 空状态只保留一句说明和新建任务操作。
- 搜索、创建和刷新入口继续位于固定工具栏。

## 7. TransportX 三主题设计系统

### 7.1 核心原则

本地应用质感主要来自稳定的布局、精确的分隔、紧凑的控件、完整的交互状态和一致的材料层级，而不是大量阴影、渐变或装饰。

TransportX 只维护一套结构系统和三套视觉主题：

```text
                 TransportX Design System

                           │
              ┌────────────┴────────────┐
              │                         │
         Structural UI              Theme Tokens
              │                         │
       Codex / VS Code        ┌────────┼────────┐
              │               │        │        │
       高密度面板            Light     Dark     Sand
       精确边界
       克制圆角
       小尺寸控件
       强交互状态
       少阴影
```

三个主题只改变视觉 token，不改变以下内容：

- 侧栏宽度和 30:70 比例
- 控件高度
- 字号和字重层级
- 间距和圆角
- 组件 DOM
- 键盘与鼠标交互
- 响应式断点
- 信息架构

### 7.2 Theme Light

Light 接近 Codex 和 VS Code Light 的干净、高密度工具感。TransportX 暖色只用于少量关键交互。

| 角色 | 建议值 |
|---|---|
| Canvas | `#F7F7F6` |
| Sidebar | `#F1F1F0` |
| Surface | `#FFFFFF` |
| Raised | `#FFFFFF` |
| Text Primary | `#242424` |
| Text Secondary | `#66635F` |
| Text Tertiary | `#96918B` |
| Border | `rgba(36,36,36,.10)` |
| Border Strong | `rgba(36,36,36,.16)` |

视觉目标：干净、专业、高密度。页面不得因为是 Light Theme 就退化为大面积空白的网页风格。

### 7.3 Theme Dark

Dark 接近成熟 IDE 的深色材料层级，不使用纯黑，也不把大面积面板染成棕色。

| 角色 | 建议值 |
|---|---|
| Canvas | `#1E1E1E` |
| Sidebar | `#252526` |
| Surface | `#202020` |
| Raised | `#2A2A2A` |
| Text Primary | `#E7E7E7` |
| Text Secondary | `#A7A7A7` |
| Text Tertiary | `#747474` |
| Border | `rgba(255,255,255,.08)` |
| Border Strong | `rgba(255,255,255,.14)` |

Dark Theme 中的暖色主要用于 selected indicator、focus、主要操作和活动状态，不用于 Sidebar 或 Panel 的大面积背景。

### 7.4 Theme Sand

Sand 对应当前 TransportX 的 warm canvas + warm surface + terracotta accent。它是三套主题中的品牌主题，不是全局设计系统本身。

| 角色 | 建议值 |
|---|---|
| Canvas | `#F4F1EC` |
| Sidebar | `#ECE7DF` |
| Surface | `#FAF8F4` |
| Raised | `#FFFDFC` |
| Text Primary | `#262320` |
| Text Secondary | `#6F6963` |
| Text Tertiary | `#928A82` |
| Border | `rgba(38,35,32,.10)` |
| Border Strong | `rgba(38,35,32,.16)` |

Sand Theme 不应被称为 Yellow Theme。它的识别来自成套的暖色表面和 Terracotta 交互，不是黄色 Accent。

### 7.5 Primitive Token 与 Semantic Token

主题文件可以复用品牌 primitive，但组件只能消费 semantic token。

禁止把单一 `--color-accent` 同时用于按钮、选中、焦点、链接、Badge 和运行状态。建议至少建立以下语义接口：

```css
--surface-canvas;
--surface-sidebar;
--surface-default;
--surface-raised;
--surface-hover;

--text-primary;
--text-secondary;
--text-tertiary;

--border-default;
--border-strong;

--interactive-primary-bg;
--interactive-primary-bg-hover;
--interactive-primary-fg;

--selection-bg;
--selection-border;
--selection-fg;

--focus-ring;
--link-fg;

--status-success;
--status-warning;
--status-danger;
--status-info;
```

组件只允许这样引用：

```css
.ui-button-primary {
  color: var(--interactive-primary-fg);
  background: var(--interactive-primary-bg);
}

.ui-button-primary:hover {
  background: var(--interactive-primary-bg-hover);
}
```

禁止在组件文件中这样覆盖：

```css
[data-theme="dark"] .ui-button-primary { /* 禁止 */ }
[data-theme="sand"] .session-row { /* 禁止 */ }
```

### 7.6 三主题交互语义

三套主题可以从不同 primitive 生成同一个 semantic token：

| 语义 | Light | Dark | Sand |
|---|---|---|---|
| Primary Action | 深 Terracotta + 白字 | 亮暖色 + 深色字 | 深 Terracotta + 白字 |
| Selection | 极浅暖色背景 | 低明度暖色透明背景 | 浅 Terracotta 背景 |
| Focus Ring | 暖色半透明环 | 高可见暖色环 | 暖色半透明环 |
| Link | 深暖色或高对比中性色 | 浅暖色 | 深 Terracotta |
| Success | 低饱和绿色 | 提亮绿色 | 低饱和绿色 |
| Warning | 琥珀色 | 提亮琥珀色 | 棕橙色 |
| Danger | 深红色 | 提亮红色 | 砖红色 |

具体色值在实现时通过自动对比度测试确定，不能假设同一个 Accent 在三套主题中都满足对比度和层级要求。

### 7.7 状态与品牌约束

- TransportX 品牌色只服务品牌标识、主要操作、选中和焦点。
- 连接成功、失败、警告等状态使用独立语义色。
- 状态必须同时提供颜色和文字或图标。
- 不为模块、技能、数据、知识四类分别配置彩虹色。
- 每个主题内部保持单一强调色哲学。
- 三个主题的层级必须等价，不能只有 Sand Theme 被精细设计。

### 7.8 主题选择行为

- 新安装默认使用 Sand，保留 TransportX 的品牌第一印象。
- 用户选择 Light 或 Dark 后持久化，不在下次启动时被系统主题自动覆盖。
- 设置页面只展示 Light、Dark、Sand 三个正式选项。
- 主题预览必须直接读取主题元数据或 semantic token，不维护第二份手写色值。
- 切换主题只修改根节点 `data-theme`，不触发组件卸载或业务状态重置。

## 8. 字体和排版

### 8.1 字体策略

产品工作区建议使用系统级本地字体：

```css
font-family:
  -apple-system,
  BlinkMacSystemFont,
  "SF Pro Text",
  "PingFang SC",
  "Microsoft YaHei",
  sans-serif;
```

代码、路径、模型和数据值使用：

```css
font-family:
  ui-monospace,
  SFMono-Regular,
  Menlo,
  Monaco,
  Consolas,
  monospace;
```

欢迎页可以继续使用当前衬线品牌标题。衬线字体不进入能力区、会话列表、地图工具栏、任务列表和设置表单。

### 8.2 字号规范

| 场景 | 字号 | 建议字重 |
|---|---:|---:|
| 对话正文 | 14.5px | 400 |
| 普通正文 | 14px | 400 |
| 列表标题 | 12.5px 到 13px | 550 到 600 |
| 面板标题 | 12px 到 13px | 600 |
| 辅助信息 | 11px 到 12px | 400 |
| 路径和模型 | 12px | 400 |
| 状态栏 | 10px 到 11px | 500 |

功能文字原则上不得低于 11px。低于 11px 的内容只允许作为非必要装饰，不应承担状态和操作信息。

## 9. 间距、尺寸和圆角

### 9.1 间距

统一使用以下间距刻度：

```text
4 / 8 / 12 / 16 / 24 / 32
```

避免继续引入 5px、7px、9px、13px 等无体系的局部间距。

### 9.2 控件高度

| 控件 | 高度 |
|---|---:|
| 紧凑图标按钮 | 28px 到 30px |
| 默认按钮 | 32px |
| 搜索框 | 32px |
| 普通表单控件 | 36px |
| 标签页 | 36px 到 40px |
| 能力列表行 | 36px 到 40px |

### 9.3 圆角

建立明确的形状规则：

- 小型按钮、Tabs、搜索框：6px。
- 输入框、Select：8px。
- 对话输入容器：12px。
- Dialog 和 Popover：12px。
- 状态点和发送按钮允许圆形。
- 主面板、侧栏、地图画布不使用圆角。

## 10. 阴影和材质

- 顶部工具栏可保留轻度半透明和背景模糊。
- 会话侧栏、能力扩展区、对话区和文件栏不使用阴影。
- 菜单使用短距离软阴影。
- Dialog 使用中等范围语义阴影。
- 文件预览等大型浮层使用更强阴影，但不添加外发光。
- Light 和 Sand 使用低饱和灰或暖灰阴影，Dark 使用低透明度深色阴影。
- 阴影必须通过 `--shadow-menu`、`--shadow-dialog`、`--shadow-overlay` 等 semantic token 提供，组件不得写主题专属阴影值。
- 不使用玻璃拟态卡片、霓虹描边或大面积渐变。

## 11. 基础组件统一

### 11.1 Button

保留 Primary、Quiet、Outline 三种语义：

- Primary：高优先级确认操作。
- Quiet：工具栏和低优先级操作。
- Outline：Dialog 次要操作。

所有按钮必须具备：

- default
- hover
- pressed
- focus-visible
- disabled
- loading

按钮文字在桌面端不得换行。

### 11.2 IconButton

- 默认尺寸 30px。
- 图标视觉尺寸 16px 到 18px。
- 统一描边粗细。
- hover 使用 `--surface-hover`，激活状态使用 `--selection-bg`。
- Tooltip 延迟和位置保持一致。
- 图标只使用一个图标家族。

当前 `src/web/components/icons.tsx` 的手写路径可在第二阶段替换为 Phosphor 或 Tabler。第一阶段如果不引入依赖，至少应统一现有图标的尺寸和描边。

### 11.3 Input 和 Search

- 默认高度 32px 或 36px。
- placeholder 必须达到可读对比度。
- focus 使用 1px `--selection-border` 加 2px `--focus-ring`。
- 不使用 placeholder 代替标签。
- 搜索框清空按钮只在存在内容时显示。

### 11.4 Tabs

- 标签页和能力分类 Tabs 使用同一交互逻辑。
- 标签页可以保留容器形态，分类 Tabs 使用底部指示线。
- active、hover 和 pending 状态必须区分。
- 标签宽度不足时使用省略，不允许文字换行。

### 11.5 Menu、Popover 和 Dialog

- 全部使用 Raised Surface。
- 菜单项高度统一为 32px。
- 当前选项使用背景表示，不增加粗边框。
- 危险操作只在文字和 hover 状态使用 Danger 色。
- Dialog 的标题栏、内容区和底部操作区使用统一分隔线。
- 保留现有 Radix Dialog 的焦点管理和关闭行为。

### 11.6 Empty、Loading 和 Error

- Loading：使用匹配最终内容形状的骨架。
- Empty：解释为什么为空，并给出一个主要入口。
- Error：持续错误就地展示，瞬时操作结果才使用 Toast。
- 所有状态组件使用统一标题、正文、操作间距。

## 12. 现有核心区域的视觉调整

### 12.1 顶部工具栏

- 保持现有高度和结构。
- 图标按钮统一为 30px。
- 模型选择器使用 12px 等宽字体。
- 无任务状态允许保持当前居中的 TransportX 品牌结构。
- 有活动任务时，中部视觉焦点切换为当前任务名称，品牌标识弱化或缩减为低对比度标识。
- 有活动任务时，模型、任务名称、连接状态和工作区操作必须高于品牌展示优先级。
- Header 应被视为窗口 Chrome，不应继续强化网站导航栏式的品牌展示。
- 连接状态点只承担真实连接状态，不增加装饰点。

### 12.2 主对话区

- 不改变布局和宽度逻辑。
- 保留当前工具调用时间线形式。
- 对话正文保持 14.5px。
- 输入容器圆角统一为 12px。
- 输入区按钮统一为 30px 到 32px。
- 聚焦时使用 `--selection-border` 和 `--focus-ring`。
- 对话区不增加能力扩展内容。

### 12.3 地图模式

- 不改变地图和聊天区域的布局关系。
- 不改变当前聊天宽度调整逻辑。
- 地图工具栏、图层列表、Popup 和描述区改用统一 token。
- 地图 Popup 的字体、圆角和阴影与普通 Popover 对齐。
- 地图模式下左侧会话侧栏仍按能力区 30%、会话区 70%显示。

### 12.4 文件栏

- 不改变右侧停靠方式。
- 文件行高、图标、hover 和 selected 与能力列表保持同一密度。
- 路径使用等宽字体。
- 文件栏边界使用统一 Border Token。

### 12.5 任务面板

- 不改变当前打开方式和任务语义。
- 步骤标题不得低于 11px。
- 完成、运行、阻塞、失败状态使用统一语义色。
- 任务步骤状态必须同时使用图标或文字，不只依赖颜色。

### 12.6 欢迎页

- 欢迎页只在无活动 Session 的 Empty Workspace 中出现。
- 保留 TransportX 品牌构图，但整体 Hero 尺寸和占屏面积缩小 20% 到 30%。
- 保留标题、主操作和三项核心能力。
- 标题从营销式巨幅字号收敛为桌面应用欢迎标题，桌面端建议控制在 42px 到 56px。
- 三项核心能力从大面积展示块收敛为紧凑的常用入口。
- Light、Dark、Sand 共用相同欢迎页布局，只改变主题 token。
- 欢迎页是品牌表达区域，可以使用衬线标题。
- 不将欢迎页视觉语言扩散到高密度工作区。
- 一旦进入任务，界面必须立即回归 IDE-level density。

## 13. 响应式策略

### 13.1 大于 1280px

- 保持完整工作台。
- 会话侧栏默认显示能力区和会话区。
- 文件栏、地图和任务面板按当前逻辑工作。

### 13.2 861px 到 1280px

- 保持桌面结构。
- 能力区默认仍为 30%。
- 如果侧栏高度不足，能力区允许收起。
- 不压缩功能文字到 11px 以下。

### 13.3 小于等于 860px

- 继续使用现有会话侧栏抽屉。
- 能力扩展区默认收起。
- 用户点击能力标题后在侧栏内展开。
- 会话列表始终是移动侧栏的主要内容。
- 地图和文件栏继续使用当前全屏覆盖策略。

### 13.4 小于等于 520px

- 固定工具栏按钮应保持至少 30px 的视觉尺寸和 40px 左右的触控热区。
- 能力分类 Tabs 必须保持单行。
- 能力条目只显示名称和状态，隐藏次要来源。
- 不在移动端启用能力区与会话区的拖动分隔条。

## 14. 动效与交互反馈

动效只用于反馈和状态变化：

| 场景 | 时长 | 建议 |
|---|---:|---|
| hover | 120ms | 颜色和背景 |
| pressed | 80ms | 轻微位移或缩放 |
| 面板展开 | 180ms | opacity + transform |
| 能力区收起 | 180ms 到 220ms | height 或 grid track |
| Dialog | 180ms | opacity + scale |

约束：

- 不使用持续漂浮、闪光和无意义循环动画。
- 不使用 React state 跟踪连续拖动值造成整树重渲染。
- 分隔条拖动期间关闭过渡。
- 所有非必要动效支持 `prefers-reduced-motion`。

## 15. 无障碍要求

- 正文和按钮达到 WCAG AA。
- 普通文本对比度至少为 4.5:1。
- 大文字和非文本控件至少为 3:1。
- 能力 Tabs 使用正确的 `tablist`、`tab` 和 `tabpanel` 语义。
- 上下分隔条使用 `role="separator"` 和 `aria-orientation="horizontal"`。
- 分隔条支持方向键调整高度。
- 收起按钮提供明确的 `aria-expanded`。
- 状态点必须附带可读状态文字。
- 所有图标按钮必须具有可访问名称。
- 焦点顺序与视觉顺序一致。
- 不移除现有 Dialog 焦点恢复机制。

## 16. 样式代码组织建议

当前 `src/web/styles.css` 已接近千行，并包含历史覆盖。建议在不改变构建方式的前提下拆分为：

```text
src/web/styles/
  tokens/
    primitives.css
    semantic.css
  themes/
    light.css
    dark.css
    sand.css
  base/
    reset.css
    typography.css
  components/
    button.css
    input.css
    tabs.css
    menu.css
    dialog.css
  shell/
    app-shell.css
    header.css
    sidebar.css
  features/
    capability.css
    conversation.css
    task.css
    geo.css
    citation.css
```

入口文件继续由 `styles.css` 统一导入：

```css
@import "tailwindcss";
@import "./styles/tokens/primitives.css";
@import "./styles/tokens/semantic.css";
@import "./styles/themes/light.css";
@import "./styles/themes/dark.css";
@import "./styles/themes/sand.css";
@import "./styles/base/reset.css";
@import "./styles/base/typography.css";
@import "./styles/components/button.css";
@import "./styles/components/input.css";
@import "./styles/components/tabs.css";
@import "./styles/components/menu.css";
@import "./styles/components/dialog.css";
@import "./styles/shell/app-shell.css";
@import "./styles/shell/header.css";
@import "./styles/shell/sidebar.css";
@import "./styles/features/capability.css";
@import "./styles/features/conversation.css";
@import "./styles/features/task.css";
@import "./styles/features/geo.css";
@import "./styles/features/citation.css";
```

规则：

- `primitives.css` 只存放品牌色阶、尺寸、字号、间距和圆角等基础值。
- `semantic.css` 定义组件必须消费的 token contract。
- `themes/*.css` 为 semantic token 赋值。
- 每个主题只赋值 token，不覆盖组件选择器。
- 组件样式不得使用主题专属色值或 primitive 色值。
- Component 永远不知道当前使用的是 Light、Dark 还是 Sand。
- 新增第四套主题时，不应修改 Button、Tabs、Sidebar 等组件文件。
- 禁止在文件末尾通过重复选择器修正前面的组件。
- 设置页面主题预览必须读取与实际主题相同的数据来源。

### 16.1 主题 ID 和迁移

产品正式主题 ID 建议统一为：

```text
light
dark
sand
```

当前本地偏好中可能仍存在 `night`、`midnight`、`dawn`、`clean`、`terracotta` 和 `sage`。实施时需要提供一次兼容映射或安全回退，避免升级后出现空主题：

- `clean` 映射到 `light`。
- `night`、`midnight`、`dawn` 映射到 `dark`。
- `terracotta` 映射到 `sand`。
- 其他未知值回退到产品默认主题。

`sage` 是否保留为隐藏兼容主题或回退到 Light，需要在实现前由产品决定，不应由组件代码自行判断。

## 17. 建议实施阶段

### 阶段 1：三主题 token contract

目标：先建立 Light、Dark、Sand 共用的设计系统，再调整任何组件外观。

- 拆分并清理 `styles.css`。
- 建立 primitive 和 semantic 两层 token。
- 创建 `light.css`、`dark.css`、`sand.css`。
- 建立旧主题 ID 的迁移策略。
- 同步设置页面的主题名称、预览和持久化值。
- 为核心 semantic token 建立自动对比度检查。

验证：

- 现有页面结构和交互不变。
- Light、Dark、Sand 可以切换和持久化。
- 切换主题不会改变任何元素尺寸和位置。
- 组件文件中不存在 `[data-theme] .component` 式覆盖。

### 阶段 2：基础组件与桌面质感

目标：把 IDE-level 的尺寸、边界和交互纪律落到基础组件。

- 统一 Button、IconButton、Input、Tabs、Menu、Popover 和 Dialog。
- 统一 Header、会话行、工具调用、输入区和状态组件。
- 修正每个主题下的主按钮和辅助文字对比度。
- 收敛字号、间距、圆角和阴影。
- 实现 Header 的空闲状态与任务状态视觉优先级。
- 将欢迎页 Hero 缩小 20% 到 30%。

验证：

- 三主题下所有组件尺寸完全一致。
- Normal、Hover、Selected、Focus、Disabled 状态均可辨认。
- 有活动任务时，任务名称高于品牌展示优先级。
- 欢迎页只出现在 Empty Workspace。

### 阶段 3：会话侧栏固定 3:7

目标：在正确位置加入能力扩展区。

- 从 `SessionSidebar` 中拆出 `SidebarToolbar` 和 `SessionListPane`。
- 增加 `CapabilityPane`。
- 增加 30:70 布局和收起状态。
- 接入模块、技能、数据、知识的只读列表数据。
- 增加 Loading、Empty、Error 状态。
- 第一版不实现拖动分隔条，先稳定密度、滚动、选中、收起和三主题表现。

验证：

- 能力区位于会话侧栏上部。
- 对话区 DOM 和视觉布局没有变化。
- 地图模式、文件栏和任务面板行为没有变化。
- 常见 MacBook 窗口高度下至少能辨认 3 个能力条目。

### 阶段 4：可选分隔条和偏好保存

目标：在固定 30:70 已验证可用后，补充桌面应用级调整体验。

- 增加可拖动水平分隔条。
- 支持键盘调整。
- 双击恢复 30:70。
- 保存用户偏好。
- 处理窗口高度变化后的比例约束。

验证：

- 能力区不低于 120px。
- 会话区不低于 200px。
- 调整过程中无明显卡顿。
- 重启应用后恢复用户设置。

### 阶段 5：三主题完整视觉校验

目标：完成全局质感统一和回归。

- 检查顶栏、会话列表、能力区、对话、地图、文件、任务、设置和 Dialog。
- 校验 Light、Dark、Sand 的等价层级。
- 执行三主题交互状态矩阵。
- 校验键盘操作和焦点状态。
- 更新三主题桌面和移动端基线截图。

## 18. 主要影响文件

阶段 1，主题系统预计影响：

- `src/web/styles.css`
- `src/web/styles/tokens/primitives.css`
- `src/web/styles/tokens/semantic.css`
- `src/web/styles/themes/light.css`
- `src/web/styles/themes/dark.css`
- `src/web/styles/themes/sand.css`
- `src/web/app/App.tsx`
- `src/web/platform/settings/SettingsDialog.tsx`

阶段 2，基础组件和桌面质感预计影响：

- `src/web/components/ui/button.tsx`
- `src/web/components/ui/dialog.tsx`
- `src/web/components/shell/Header.tsx`
- `src/web/platform/conversation/ConversationStage.tsx`
- `src/web/platform/conversation/ConversationWorkspace.tsx`

阶段 3，会话侧栏 3:7 预计新增或影响：

- `src/web/platform/sessions/SessionSidebar.tsx`
- `src/web/platform/capabilities/CapabilityPane.tsx`
- `src/web/platform/capabilities/capability-projection.ts`
- 对应的 Kernel command 或现有 platform overview 读取层

是否需要新增数据协议，应在实施前先确认现有 `PlatformOverview` 是否已经包含能力区所需的模块、技能、数据和知识信息。视觉实施不得自行推测或复制服务端状态。

## 19. 验收标准

### 19.1 布局

- [ ] 能力扩展区位于会话侧栏上部，不在对话栏内部。
- [ ] 固定工具栏以下默认按 30:70 分配。
- [ ] 会话侧栏整体位置和默认宽度不变。
- [ ] 主对话区布局不变。
- [ ] 地图模式布局不变。
- [ ] 文件栏布局和打开方式不变。
- [ ] 任务面板既有行为不变。

### 19.2 视觉

- [ ] 产品提供 Light、Dark、Sand 三套正式主题。
- [ ] Sand Theme 保留 TransportX 现有暖色品牌识别。
- [ ] 三主题只改变视觉 token，不改变布局、尺寸、字号、圆角、DOM 和交互。
- [ ] 每套主题中的 Canvas、Sidebar、Surface 和 Raised 四级表面清晰可辨。
- [ ] 组件只消费 semantic token，不消费主题专属色值。
- [ ] 组件文件中不存在主题专属选择器覆盖。
- [ ] Primary Action、Selection、Focus、Link 和 Status 使用独立 semantic token。
- [ ] 主面板不使用多余阴影和卡片边框。
- [ ] 控件圆角符合统一规则。
- [ ] 功能文字不低于 11px。
- [ ] hover、pressed、focus 和 disabled 状态完整。
- [ ] 三主题下主按钮和辅助文字均通过 WCAG AA。

### 19.3 三主题状态矩阵

以下矩阵必须在 Button、IconButton、Input、Tabs、Session Row、Capability Row、Menu Item 和 Dialog 中完成验证：

| Theme | Normal | Hover | Selected | Focus | Disabled |
|---|---|---|---|---|---|
| Light | [ ] | [ ] | [ ] | [ ] | [ ] |
| Dark | [ ] | [ ] | [ ] | [ ] | [ ] |
| Sand | [ ] | [ ] | [ ] | [ ] | [ ] |

### 19.4 能力扩展区

- [ ] 模块、技能、数据、知识分类均可访问。
- [ ] 能力区和会话区分别滚动。
- [ ] 能力区可收起。
- [ ] Loading、Empty 和 Error 状态完整。
- [ ] 使用中、待配置、不可用等状态具有文字说明。
- [ ] 272px 宽度下无横向滚动。
- [ ] 固定 30:70 版本完成验证后，才进入可拖动分隔条阶段。

### 19.5 桌面应用体验

- [ ] 1440px 桌面窗口下结构稳定。
- [ ] 1024px 窗口下无控件重叠。
- [ ] 860px 临界宽度下切换正确。
- [ ] 390px 移动端侧栏可正常使用。
- [ ] 键盘可以操作能力 Tabs、分隔条和收起按钮。
- [ ] `prefers-reduced-motion` 下无多余动效。
- [ ] 无活动任务时允许显示居中品牌。
- [ ] 有活动任务时 Header 中任务名称高于品牌展示优先级。
- [ ] 欢迎页 Hero 相比现状缩小 20% 到 30%。
- [ ] 欢迎页只存在于 Empty Workspace。

### 19.6 回归

- [ ] React TypeScript 检查通过。
- [ ] React smoke test 通过。
- [ ] 地图交互回归通过。
- [ ] 文件预览回归通过。
- [ ] 任务模式回归通过。
- [ ] 更新 Light、Dark、Sand 的桌面和移动端截图基线。
- [ ] 旧主题偏好升级后能够安全映射或回退。

## 20. 最终设计判断

本轮改造应被视为一次设计系统升级和定向视觉优化，而不是工作台重构。

会话侧栏的能力扩展区让模块、技能、数据和知识从设置深处进入日常工作流；原有对话、地图、文件和任务布局继续保持用户已经建立的操作习惯。

结构层学习 Codex 和 VS Code 的纪律，品牌层继续做 TransportX，当前暖色界面成为正式的 Sand Theme。Light、Dark、Sand 共用同一套 semantic token contract 和组件实现，让产品从“单主题网页式工作台”转变为“可长期维护的本地交通分析应用”。
