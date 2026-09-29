<div align="center">
  <img src="./src/web/assets/x-icon.svg" alt="TransportX" width="96" />
  <h1>TransportX Agent</h1>
  <p><strong>一个和你看同一张地图的交通分析 Agent。</strong></p>
  <p>用自然语言分析道路、公交、轨道、出行需求与交通数据。TransportX 将分析结果整理为地图、图表、带引用的结论和报告，同时保留相关源文件与工具记录。</p>
  <p>
    <img src="https://img.shields.io/badge/version-3.2.0-C46543?style=flat-square" alt="版本 3.2.0" />
    <img src="https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Windows%20x64-6B7280?style=flat-square" alt="macOS arm64 和 Windows x64" />
    <img src="https://img.shields.io/badge/license-MIT-3B82F6?style=flat-square" alt="MIT License" />
  </p>
  <p><a href="./README.md">English</a> · <strong>简体中文</strong></p>
</div>

## 为什么做 TransportX

Codex、Claude Code 等编程 Agent 进步很快，但实际使用通常仍离不开代码、终端和文件结构。对于需要分析交通数据、制作地图，却没有编程背景的业务人员，这仍是一道明显门槛。

TransportX 的出发点很简单：让交通分析人员能直接使用 Agent 完成提问、分析、制图和成果交付，并保留结果所依据的数据与过程。平台本身保持轻量，具体数据、知识、方法和工具通过 Module 装配，因此也可以适配交通之外的数据分析场景。

## 为交通分析设计

TransportX 把提问、证据核查、地图操作和成果交付放在同一个工作台中。每个任务都有独立的工作目录、会话记录、文件和确定的能力版本。

### 可组合的 Module 机制

TransportX 通过 Module 扩展能力，不把领域逻辑写死在平台中。Module 可以封装不同 Agent 工具中以 `SKILL.md` 为入口的 Skill，并与 Extension、数据集、知识库、报告模板和本地运行时一起分发。每个任务只装配所需模块并记录精确版本，因此新增领域能力不必修改平台核心，恢复任务时也能使用原来的能力组合。

### 共享 GIS 上下文

Agent 和分析人员使用同一份地图状态。Agent 可以发布 GeoJSON、叠加或更新图层；分析人员可以选择要素、标记点位、框选区域，或提交当前视野。TransportX 将这些操作作为结构化 Geo Context 附到下一轮消息中，后续分析沿用同一地图版本和空间范围，无需再次用文字描述位置。

| | TransportX 提供的能力 |
|---|---|
| **对话式分析** | 用自然语言提出问题，查看模型回复、工具调用、任务步骤和生成文件。 |
| **交互式 GIS** | 共享带版本的地图上下文：Agent 发布和更新图层，分析人员将要素、点位、矩形或当前视野交回 Agent。 |
| **数据、图表与视频** | 分析表格、数据库和代码，生成图表；安装 Video Capability 后可检索、播放、截图、裁剪、抽帧并计算时序指标。 |
| **可核查结论** | 让引用、地图上下文、源文件和工具输出与使用它们的结论保持关联。 |
| **报告交付** | 生成包含图件和引用的 Markdown 报告，并在桌面端导出 PDF。 |
| **版本化能力** | 复用以 `SKILL.md` 为入口的 Agent Skill，或通过 Module 加入自定义 Extension、Data、Knowledge、Template 和本地运行时。 |

## 工作方式

桌面端、Web 与 CLI 共用本地 Agent Host。Host 管理会话、资源、模型和版本化 Module；Pi 负责 Agent 执行循环，并调用选定的模型、Python 分析环境与领域服务。

## 设计原则

- **地图既是结果，也是输入。** Agent 可以生成空间图层；分析人员可以把点位、要素、矩形或当前视野作为结构化上下文交回 Agent。
- **分析过程可以复核。** 会话保留工具活动、来源引用、附件、地图和派生文件，不把所有信息压缩成聊天文本。
- **能力边界清楚。** 数据、领域知识、分析方法和本地工具通过 Module 安装，在任务创建时选择，并按版本恢复。

## 快速开始

从源码启动桌面应用：

```bash
npm install
npm run desktop:dev
```

首次创建任务前，请在“新建交通任务”或“设置”中添加一个 Pi 兼容模型。

> 交通数据库、知识库原文、模型凭据和用户安装的 Module 不随仓库分发。

## 平台支持

| 平台 | 状态 |
|---|---|
| macOS 12+ Apple Silicon | 桌面发行目标 |
| Windows 10 22H2 / Windows 11 x64 | 桌面发行目标 |
| Linux | 仅用于源码开发 |

桌面应用使用 Electron 和 React。Node.js Agent Host 在本机管理会话和资源边界，[Pi](https://github.com/earendil-works/pi) 负责模型调用与工具执行。Python 3.10 随桌面应用提供，视频运行时通过 Video Capability 独立安装。

## 文档

| 文档 | 内容 |
|---|---|
| [架构说明](./docs/ARCHITECTURE.md) | 进程边界、数据流、资源模型和安全约束 |
| [变更记录](./docs/CHANGELOG.md) | 版本更新和兼容性变化 |

## 致谢

TransportX 使用并受益于以下开源项目：

- [Pi](https://github.com/earendil-works/pi)：提供 Agent 运行时、模型接入与工具执行循环。
- [Pi Tau Web Server](https://github.com/milanglacier/pi-tau-web-server)：本项目浏览器工作台与 Pi RPC 会话架构的上游基础。
- [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js)：提供交互式地图渲染能力。
- [Electron](https://github.com/electron/electron) 与 [React](https://github.com/facebook/react)：提供桌面应用与界面开发基础。

感谢这些项目的维护者和贡献者。

也感谢以下协作者提供帮助并参与产品测试：

<table>
  <tr>
    <td align="center" width="25%">
      <a href="https://github.com/aowang-ai"><img src="https://github.com/aowang-ai.png?size=96" width="64" alt="@aowang-ai" /><br /><strong>@aowang-ai</strong></a>
    </td>
    <td align="center" width="25%">
      <a href="https://github.com/yonghenggudu"><img src="https://github.com/yonghenggudu.png?size=96" width="64" alt="@yonghenggudu" /><br /><strong>@yonghenggudu</strong></a>
    </td>
    <td align="center" width="25%">
      <a href="https://github.com/runningjian-ui"><img src="https://github.com/runningjian-ui.png?size=96" width="64" alt="@runningjian-ui" /><br /><strong>@runningjian-ui</strong></a>
    </td>
    <td align="center" width="25%">
      <a href="https://github.com/tataxing123"><img src="https://github.com/tataxing123.png?size=96" width="64" alt="@tataxing123" /><br /><strong>@tataxing123</strong></a>
    </td>
  </tr>
</table>

## License

MIT
