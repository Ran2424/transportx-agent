<div align="center">
  <img src="./src/web/assets/x-icon.svg" alt="TransportX" width="96" />
  <h1>TransportX Agent</h1>
  <p><strong>面向交通分析 Agent 的本地桌面工作台。</strong></p>
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

<p align="center">
  <img src="./docs/images/product-home.png" alt="TransportX Agent 首页" width="920" />
</p>

## 为交通分析设计

TransportX 把提问、证据核查、地图操作和成果交付放在同一个工作台中。每个任务都有独立的工作目录、会话记录、文件和确定的能力版本。

| | TransportX 提供的能力 |
|---|---|
| **对话式分析** | 用自然语言提出问题，查看模型回复、工具调用、任务步骤和生成文件。 |
| **交互式 GIS** | 发布 GeoJSON，叠加线路、站点、网格和行政区，并将选中的要素或地图范围交回 Agent。 |
| **数据、图表与视频** | 分析表格、数据库和代码，生成图表；安装 Video Capability 后可检索、播放、截图、裁剪、抽帧并计算时序指标。 |
| **可核查结论** | 让引用、地图上下文、源文件和工具输出与使用它们的结论保持关联。 |
| **报告交付** | 生成包含图件和引用的 Markdown 报告，并在桌面端导出 PDF。 |
| **版本化能力** | 用 Module 安装 Skill、Extension、Data、Knowledge、Template 和本地运行时；任务记录实际使用的精确版本。 |

## 工作方式

<p align="center">
  <img src="./docs/images/architecture-overview.png" alt="TransportX Agent 整体架构与执行流程" width="920" />
</p>

桌面端、Web 与 CLI 共用本地 Agent Host。Host 管理会话、资源、模型和版本化 Module；Pi 负责 Agent 执行循环，并调用选定的模型、Python 分析环境与领域服务。

## 一个工作台，多种分析界面

<table>
  <tr>
    <td width="50%"><img src="./docs/images/product-task-setup.png" alt="为新任务选择模型和模块版本" width="100%" /></td>
    <td width="50%"><img src="./docs/images/product-multilayer-map.png" alt="在同一地图中展示轨道线路、站点和交通热力网格" width="100%" /></td>
  </tr>
  <tr>
    <td align="center">为每个任务选择模型与能力版本</td>
    <td align="center">叠加线路、站点、需求等空间图层</td>
  </tr>
  <tr>
    <td width="50%"><img src="./docs/images/product-map-selection.png" alt="在地图中框选区域并交回 Agent" width="100%" /></td>
    <td width="50%"><img src="./docs/images/product-chart-analysis.png" alt="交通数据分析图表预览" width="100%" /></td>
  </tr>
  <tr>
    <td align="center">把地图选择作为下一步分析的结构化上下文</td>
    <td align="center">在任务内查看图表和其他分析产物</td>
  </tr>
</table>

## 设计原则

- **地图既是结果，也是输入。** Agent 可以生成空间图层；分析人员可以把点位、要素、矩形或当前视野作为结构化上下文交回 Agent。
- **分析过程可以复核。** 会话保留工具活动、来源引用、附件、地图和派生文件，不把所有信息压缩成聊天文本。
- **能力边界清楚。** 数据、领域知识、分析方法和本地工具通过 Module 安装，在任务创建时选择，并按版本恢复。
- **工作区在本机。** 任务和凭据由本机管理；模型既可以在本地运行，也可以接入已配置的远程服务。

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

## License

MIT
