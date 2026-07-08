# Pi Traffic Workspace

这是一个基于 [milanglacier/pi-tau-web-server](https://github.com/milanglacier/pi-tau-web-server) 的交通 Agent 浏览器工作台 demo。

它不再采用旧 Tau 的“Pi extension 镜像当前 TUI 会话”模式，而是采用更适合 demo 和工作台形态的独立 Web Server：

```text
Browser UI
  ↕ HTTP / WebSocket
Pi Traffic Workspace Server
  ↕ JSONL RPC
pi --mode rpc 子进程 1
pi --mode rpc 子进程 2
pi --mode rpc 子进程 N
```

这意味着浏览器页面可以同时管理多个 Pi RPC 会话。对交通 demo 来说，这比单会话 mirror 更合适：一个标签页可以跑“早高峰拥堵排行”，另一个标签页可以跑“异常路段诊断”，第三个标签页可以生成“运行简报”。

## 当前完成

第一阶段已经换底座并完成初步中文化：

- 上游基底已切换为 `pi-tau-web-server`
- 包名改为 `pi-traffic-workspace`
- CLI 命令改为 `pi-traffic-workspace`
- 保留独立 Node.js Web Server + 多 Pi RPC 子进程架构
- 保留会话标签页、历史会话侧栏、模型选择器、文件浏览器、设置面板、命令面板、工具卡片和统计卡片
- 对浏览器首屏、常用按钮、状态、弹窗、设置、会话侧栏、工具状态和模型选择器做了初步中文化
- 语音输入默认识别语言改为 `zh-CN`

暂未加入真实交通能力：

- 未新增 `traffic_prompt`
- 未新增交通 Skill / Prompt
- 未新增 mock traffic tools
- 未新增交通业务结果卡片

## 为什么新方案更好

旧 Tau 方案的核心是：

```text
Pi TUI 当前会话
  → Tau Extension
  → Browser mirror
```

它适合把终端会话映射到浏览器，但天然以“当前 TUI 会话”为中心。

新项目的核心是：

```text
Web Server
  → 管理多个 pi --mode rpc 子进程
  → 浏览器多任务标签页
```

它更适合交通工作台：

- 可以并行跑多个交通分析任务
- 浏览器刷新不会立刻杀掉后端 Pi 子进程
- 后端会话生命周期由 server 管理
- UI 弹窗、模型选择、工具调用和历史会话都已经 Web 化
- 后续可以把“交通任务”做成一等入口，而不是只在聊天框里包 Prompt

## 运行

安装依赖并构建后运行：

```bash
npm install
npm run build
pi-traffic-workspace
```

默认地址：

```text
http://localhost:3001
```

常用参数：

```bash
pi-traffic-workspace --host 127.0.0.1 --port 3001 --open
TAU_PORT=3001 TAU_HOST=0.0.0.0 TAU_PROJECTS_DIR="$HOME/projects" pi-traffic-workspace
```

为兼容上游，环境变量仍沿用 `TAU_*`。

## 推荐交通化路线

### 1. 中文工作台外壳

当前已经完成第一轮。下一步可以继续把术语统一为：

- Tau tab → 交通任务
- Session → 会话
- Project directory → 项目目录
- Tool call → 工具调用
- Model / Thinking → 模型 / 思考级别

### 2. 新增交通任务入口

在“新建交通任务”弹窗中增加任务模板：

```text
早高峰拥堵排行
异常路段诊断
区域运行态势
OD 出行分析
交通运行日报
```

提交时把模板转成 Pi 首条 prompt，而不是只创建空白 RPC 会话。

### 3. 新增交通 Prompt

建议新增：

```text
prompts/
  traffic-system.md
  traffic-analysis.md
  traffic-report.md
```

核心要求：

- 不得伪造真实数据
- 如果使用示例数据，必须标注“示例数据”
- 回答固定包含结论、查询条件、指标结果、分析说明、数据口径、后续建议

### 4. 新增交通 Skill

建议新增：

```text
skills/
  traffic-query/
    SKILL.md
```

覆盖：

- 时间范围解析
- 空间范围解析
- 指标选择
- 排名、对比、趋势、异常解释
- 简报生成

### 5. 新增 mock traffic tools

demo 阶段先不要接真实库，先加 mock：

```text
traffic.rank_congested_roads
traffic.query_metric
traffic.compare_period
traffic.generate_report
```

这样可以先证明 UI、工具调用卡片和分析链路。

### 6. 新增交通结果卡片

在 `src/public/tool-card.ts` 中识别 `traffic.*` 工具，显示业务化卡片：

```text
区域：中心城区
时间：昨日早高峰 07:00-09:00
指标：拥堵指数
平均速度：24.6 km/h
拥堵 TOP 5
数据来源：demo_traffic_data
说明：示例数据，仅用于 demo 展示
```

## 当前目录重点

```text
src/server/
  server-main.ts       # 独立 Web Server、HTTP API、WebSocket、RPC 分发
  sessions.ts          # Pi RPC 子进程和 live session 管理
  config.ts            # 配置、端口、静态资源目录

src/public/
  app-main.ts          # 浏览器主交互和状态
  model-picker.ts      # 模型选择器
  session-sidebar.ts   # 历史会话侧栏
  tool-card.ts         # 工具调用卡片
  message-renderer.ts  # 消息渲染

public/
  index.html           # 页面骨架
  style.css            # 样式
```

## 来源

本项目基于 `milanglacier/pi-tau-web-server` 改造，保留其多 Pi RPC 会话架构，并向交通 Agent 工作台方向中文化和领域化。

License: MIT
