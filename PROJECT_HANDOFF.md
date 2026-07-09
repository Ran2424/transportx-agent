# Pi Traffic Workspace 项目交接说明

更新时间：2026-07-09

这份文档给下一位 Agent 和人类开发者快速接手用。它说明项目是什么、怎么跑、主要代码在哪里、最近改了什么，以及继续开发时最容易踩到的坑。

## 一句话概览

`pi-traffic-workspace` 是一个基于 `pi-tau-web-server` 改造的交通 Agent 浏览器工作台。它不是镜像某一个 Pi TUI 会话，而是由独立 Node.js Web Server 管理多个 `pi --mode rpc` 子进程，再通过浏览器 UI 展示多任务会话、消息、工具调用、思考过程、文件浏览和会话统计。

核心链路：

```text
Browser UI
  <-> HTTP / WebSocket
Tau-style Node.js Server
  <-> JSONL RPC
pi --mode rpc child sessions
```

## 当前定位

项目目前主要是“交通工作台壳子 + Pi 多会话 Web UI”。它已经做了中文化和 UI 美化，但还没有接入真实交通业务能力。

已经有：

- 多个 Pi RPC 会话的创建、恢复、切换和关闭。
- 左侧历史会话与运行中会话同步。
- 顶部 live tabs、模型选择器、上下文统计、设置面板、命令面板。
- 消息渲染、思考卡片、工具调用卡片、代码块折叠。
- 右侧工作区面板，可以切换查看 `文件 / 技能 / 工具`。
- 默认新建任务目录指向 `scenario`：`/Users/ran/WorkSpace/3 Code Project/pi-tau-traffic/scenario`。

还没有：

- 真实交通数据库接入。
- 交通专用 Prompt / Skill / Tool。
- 交通业务结果卡片。
- 完整的 Pi `getAllTools()` RPC 桥接。当前工具页展示的是内置工具和会话中已观察到的工具调用。

## 运行方式

常规流程：

```bash
npm install
npm run build
pi-traffic-workspace
```

默认端口来自 `src/server/config.ts`：

```text
TAU_PORT 或 settings.json 中 tau.port，否则默认 3001
TAU_HOST 或 settings.json 中 tau.host，否则默认 0.0.0.0
```

本地调试常用：

```bash
rtk npm run build
rtk node bin/tau.js --host 127.0.0.1 --port 3000
```

停止服务：

```bash
Ctrl-C
lsof -nP -iTCP:3000 -sTCP:LISTEN
lsof -nP -iTCP:3001 -sTCP:LISTEN
```

如果在 Codex 沙箱里启动本地端口遇到 `listen EPERM: operation not permitted`，需要用权限提升重新运行。端口是否停干净要用 `lsof` 确认。

## 构建产物和 Git 跟踪

源码在：

```text
src/server/*.ts
src/public/*.ts
public/index.html
public/style.css
```

构建产物在：

```text
bin/*.js
public/*.js
```

但 `.gitignore` 忽略了 `bin/*.js` 和 `public/*.js`。也就是说，开发时改 TypeScript 源码后需要跑：

```bash
rtk npm run build
```

本地运行会使用编译后的 `bin/server-main.js` 和 `public/app-main.js`，但提交时重点看源码文件。

## 关键目录

```text
src/server/
  server-main.ts       # HTTP API、WebSocket、RPC 命令转发、文件/资源接口
  sessions.ts          # Pi RPC 子进程生命周期、live session、消息事件缓存
  config.ts            # 端口、host、sessions 目录、静态资源目录
  model-utils.ts       # provider/model 解析和模型列表
  types.ts             # server 侧共享类型

src/public/
  app-main.ts          # 浏览器主状态、WebSocket 事件、会话切换、右侧面板协调
  message-renderer.ts  # 用户/助手消息、Markdown、思考卡片、复制逻辑
  tool-card.ts         # 工具调用卡片、中文工具名、耗时、折叠/展开
  session-sidebar.ts   # 左侧会话列表、历史会话和 live session 混合展示
  file-browser.ts      # 右侧文件树，只负责文件浏览和拖拽插入路径
  model-picker.ts      # 模型和 thinking level 选择
  session-stats-card.ts# 上下文统计卡片
  themes.ts            # 主题定义

public/
  index.html           # 页面静态骨架
  style.css            # 全局 UI 样式

test/
  *.test.ts            # Node test runner 测试
```

## 主要 API

后端核心接口：

```text
GET  /api/health
GET  /api/live-sessions
POST /api/live-sessions
POST /api/live-sessions/resume
GET  /api/live-sessions/:id/snapshot
DELETE /api/live-sessions/:id

POST /api/rpc
GET  /api/files?sessionId=...
GET  /api/file/preview?sessionId=...&path=...
POST /api/open
GET  /api/session-resources?sessionId=...
```

`/api/rpc` 里已有本地命令和 Pi 原生命令的区分。最近已允许转发 `get_commands`，用于读取当前会话可见的 slash commands。

`/api/session-resources` 当前返回：

```text
skills: 通过 Pi get_commands 过滤 source === "skill"
tools: 内置工具 read/bash/edit/write + 当前会话已出现过的 toolCall 统计
toolsComplete: false
```

注意：Pi 的扩展 API 有 `pi.getActiveTools()` / `pi.getAllTools()`，但当前 Pi RPC 没有原生 `get_tools`。如果要展示完整工具清单，需要后续做 Pi 侧桥接扩展或扩展 RPC。

## 最近 UI 状态

当前 UI 方向是白色、淡蓝、简洁、Codex 风格，尽量降低“AI 模板感”。

近期重点：

- 思考卡片和工具卡片统一了宽度、间距、耗时和完成状态。
- 思考卡片：
  - 新生成时默认展开。
  - 历史恢复时默认折叠。
  - 展开后宽度与工具卡片一致。
  - 高度不限制。
  - 复制按钮在卡片内部。
  - 完成后显示绿色 check 状态。
- 工具卡片：
  - `read` 显示为 `读取`。
  - `bash` 显示为 `命令`。
  - `edit` 显示为 `编辑`。
  - `write` 显示为 `创建`。
  - 成功状态弱化为简洁 check。
  - 路径和命令做中间截断，保留更关键的尾部信息。
- 代码块等渲染卡片支持折叠，默认高度为 50px。
- 工具和思考耗时会记录到浏览器 `localStorage`，用于历史打开时恢复显示。
- 右侧文件夹面板现在是工作区面板，可切换：
  - 文件：原文件浏览器。
  - 技能：当前 Pi 会话可见 skill commands。
  - 工具：内置工具和当前会话已调用工具。

## 本地存储键

前端用了几个重要的 `localStorage` 键：

```text
tau-active-live-session-id
tau-file-sidebar
tau-resource-sidebar-view
tau-tool-duration-cache-v1
tau-thinking-duration-cache-v1
tau-show-thinking
```

工具/思考耗时的恢复依赖这些缓存。旧历史记录如果当时没有记录耗时，之后无法凭空补回真实耗时。

## 重要约束和踩坑点

### 1. 模型不要拆 slash

Pi 模型是结构化对象：

```json
{ "provider": "openrouter", "id": "z-ai/glm-5.2" }
```

`id` 里可以包含 `/`，不能按 slash 拆。显示时拼成：

```text
provider/id
provider/id:thinking-level
```

### 2. live session 不等于历史 session

`/api/sessions` 只覆盖历史文件。新建运行中的任务必须从 live session 状态同步到左侧侧栏。不要只改顶部 tab，否则会重新出现“新建会话左侧不新增”的问题。

相关位置：

```text
src/public/app-main.ts
src/public/session-sidebar.ts
src/server/sessions.ts
```

### 3. 右侧资源面板职责要保持清晰

`FileBrowser` 只负责文件树。`技能 / 工具` 的渲染由 `app-main.ts` 协调。后续不要把 Pi 资源逻辑塞进 `file-browser.ts`，否则职责会变乱。

### 4. 工具完整清单现在不是完整 Pi getAllTools

当前工具页是实用版：

- 固定展示内置工具。
- 统计当前会话实际出现过的工具。

如果用户要求“所有注册工具、扩展工具、动态工具”，需要新做桥接，不要假装现有接口已经完整。

### 5. 构建产物被忽略

运行时依赖 `bin/*.js` 和 `public/*.js`，但 Git 不跟踪它们。改完源码后一定跑 `rtk npm run build`，否则本地预览看到的可能还是旧逻辑。

### 6. 不要大规模重构 UI

用户明确偏好“小范围整体美化”，不是重做交互架构。继续 UI 优化时，优先做间距、层级、卡片状态、中文文案和视觉降噪。

## 当前未提交改动提示

截至本文写入时，工作区已有多处 UI 相关改动，主要包括：

```text
public/index.html
public/style.css
src/public/app-main.ts
src/public/app-types.ts
src/public/message-renderer.ts
src/public/session-sidebar.ts
src/public/themes.ts
src/public/tool-card.ts
src/server/server-main.ts
```

还有 `.agents/` 未跟踪目录，这是技能目录相关内容。除非用户明确要求，不要随意删除或移动。

继续工作前请先运行：

```bash
git status --short
git diff --stat
```

如果要提交，遵守 `AGENTS.md` 的提交信息要求：标题要像人类说明真实结果，不要写很短的压缩标签。

## 验证方式

基础验证：

```bash
rtk npm run build
```

完整测试：

```bash
npm test
```

如果只是 UI 小改，至少需要：

- `rtk npm run build` 通过。
- 打开页面检查右侧面板、消息卡片、工具卡片、思考卡片没有明显错位。
- 如启动服务，结束后用 `lsof` 确认端口已释放。

## 建议的下一步

优先级从高到低：

1. 给 `/api/session-resources` 增加真正的完整工具桥接。
   - 可选方案：写 Pi 扩展，把 `pi.getAllTools()` / `pi.getActiveTools()` 暴露给 Tau。
   - 或者上游/本地扩展 Pi RPC，新增 `get_tools`。

2. 做交通任务模板。
   - 新建任务时选择 `早高峰拥堵排行`、`异常路段诊断`、`区域运行态势` 等模板。
   - 模板转成首条 prompt，避免空白会话。

3. 增加交通 Prompt / Skill。
   - 先做 prompt，不急着接真实数据。
   - 强制要求不能伪造数据，示例数据必须标注。

4. 增加 mock traffic tools。
   - 先证明工具调用和业务卡片链路。
   - 再考虑真实数据库。

5. 做交通业务结果卡片。
   - 不要把所有业务结果都塞进普通 Markdown。
   - 可在 `tool-card.ts` 识别 `traffic.*` 工具并渲染结构化卡片。

## 给下一位 Agent 的开工清单

开始前：

```bash
pwd
git status --short
git diff --stat
rtk npm run build
```

如果是 UI 任务：

- 先读 `public/style.css` 当前变量和卡片样式。
- 再读 `src/public/message-renderer.ts` 和 `src/public/tool-card.ts`。
- 小步修改，不要重写整个页面结构。

如果是会话/后端任务：

- 先读 `src/server/server-main.ts` 的 `handleRpcCommand` 和 `handleApiRoute`。
- 再读 `src/server/sessions.ts`。
- 确认 live session、history session、session file 三者边界。

如果是技能/工具查看任务：

- 先确认 Pi RPC 是否已经支持目标命令。
- 当前 `get_commands` 可用。
- 完整工具清单仍需要桥接，不要只从历史 toolCall 推断“所有工具”。

## 给人类开发者的查看路线

最快理解项目：

1. 读 `README.md`，理解项目从 Tau 改造成交通工作台的意图。
2. 读本文档，了解当前实际状态和坑点。
3. 打开 `public/index.html` 和 `public/style.css`，看 UI 外壳。
4. 打开 `src/public/app-main.ts`，看浏览器状态如何串起来。
5. 打开 `src/server/server-main.ts` 和 `src/server/sessions.ts`，看后端如何管理 Pi RPC 子进程。

如果只想体验：

```bash
npm install
npm run build
pi-traffic-workspace --host 127.0.0.1 --port 3001 --open
```

如果要继续做交通化，建议先做“模板 prompt + mock tool + 业务卡片”的闭环，再接真实数据。
