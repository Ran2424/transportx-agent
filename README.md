<div align="center">
  <img src="./src/web/assets/x-icon.svg" alt="TransportX" width="96" />
  <h1>TransportX Traffic Agent</h1>
  <p><strong>A local-first desktop workspace for traffic analysis agents.</strong></p>
  <p>Ask about roads, transit, traffic demand, and mobility data. TransportX turns the work into maps, charts, cited findings, and reports while keeping the source files and tool history close at hand.</p>
  <p>
    <img src="https://img.shields.io/badge/version-3.2.0-C46543?style=flat-square" alt="Version 3.2.0" />
    <img src="https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Windows%20x64-6B7280?style=flat-square" alt="macOS arm64 and Windows x64" />
    <img src="https://img.shields.io/badge/license-MIT-3B82F6?style=flat-square" alt="MIT License" />
  </p>
  <p><strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a></p>
</div>

## Why TransportX

Coding agents such as Codex and Claude Code have improved quickly, but using them still often means working with code, terminals, and unfamiliar file structures. That remains a real barrier for many domain specialists, particularly non-programmers who need to analyze traffic data or build map-based explanations.

TransportX began with a simple goal: make agent-assisted analysis practical for transport professionals. It is a lightweight desktop workspace for asking questions, inspecting maps and charts, and delivering results with their evidence attached. The core stays small. Modules add the data, knowledge, methods, and tools required by a field, which also makes the platform useful beyond transport.

<p align="center">
  <img src="./docs/images/product-home.png" alt="TransportX Traffic Agent home screen" width="920" />
</p>

## Built for traffic analysis

TransportX gives analysts one place to ask questions, inspect evidence, work with maps, and deliver results. Each task has its own workspace, conversation history, files, and resolved capability versions.

| | What TransportX provides |
|---|---|
| **Conversational analysis** | Ask questions in natural language and follow the model's responses, tool calls, task steps, and generated files. |
| **Interactive GIS** | Publish GeoJSON, combine routes, stations, grids, and administrative boundaries, then send selected features or map extents back to the agent. |
| **Data, charts, and video** | Analyze tables, databases, and code; create charts; install Video Capability for search, playback, snapshots, clips, frame sampling, and time-series metrics. |
| **Traceable findings** | Keep citations, map context, source files, and tool output connected to the conclusion that used them. |
| **Report delivery** | Build Markdown reports with figures and citations, then export them as PDF from the desktop app. |
| **Versioned capabilities** | Install Skills, Extensions, Data, Knowledge, Templates, and native runtimes as Modules. Every task records the exact versions it used. |

## One workspace, multiple analysis surfaces

<table>
  <tr>
    <td width="50%"><img src="./docs/images/product-task-setup.png" alt="Select a model and module versions for a new task" width="100%" /></td>
    <td width="50%"><img src="./docs/images/product-multilayer-map.png" alt="Transit lines, stations, and a traffic heat grid on one map" width="100%" /></td>
  </tr>
  <tr>
    <td align="center">Select the model and capability versions for each task</td>
    <td align="center">Combine routes, stations, demand, and other spatial layers</td>
  </tr>
  <tr>
    <td width="50%"><img src="./docs/images/product-map-selection.png" alt="Select a region on the map and return it to the agent" width="100%" /></td>
    <td width="50%"><img src="./docs/images/product-chart-analysis.png" alt="Traffic analysis chart preview" width="100%" /></td>
  </tr>
  <tr>
    <td align="center">Use map selections as structured context for the next analysis step</td>
    <td align="center">Inspect charts and other generated artifacts without leaving the task</td>
  </tr>
</table>

## Design principles

- **The map is both output and input.** The agent can create spatial layers, and analysts can return a point, feature, rectangle, or viewport as structured context.
- **Work stays inspectable.** Sessions retain tool activity, source references, attachments, maps, and derived artifacts instead of flattening everything into chat text.
- **Capabilities are explicit.** Data, domain knowledge, analysis methods, and native tools are installed as Modules, selected when a task starts, and pinned for recovery.
- **The workspace is local.** Tasks and credentials are managed on the machine. Models can run locally or through a configured remote provider.

## Quick start

Run the desktop app from source:

```bash
npm install
npm run desktop:dev
```

Before creating the first task, add a Pi-compatible model from **New Traffic Task** or **Settings**.

> Traffic databases, source knowledge collections, model credentials, and user-installed Modules are not distributed with the repository.

For the web workspace, CLI, runtime preparation, packaging, and test commands, see the [development guide](./docs/DEVELOPMENT.md).

## Platform support

| Platform | Status |
|---|---|
| macOS 12+ on Apple Silicon | Desktop release target |
| Windows 10 22H2 / Windows 11 x64 | Desktop release target |
| Linux | Source development only |

The desktop app is built with Electron and React. A local Node.js Agent Host owns sessions and resource boundaries, while [Pi](https://github.com/earendil-works/pi) runs the model and tool loop. Python 3.10 ships with the desktop application; the video runtime is installed separately with Video Capability.

## Documentation

| Guide | Covers |
|---|---|
| [Development and runtime](./docs/DEVELOPMENT.md) | Web, desktop, CLI, packaging, and tests |
| [Architecture](./docs/ARCHITECTURE.md) | Process boundaries, data flow, resource model, and security constraints |
| [Installable Modules](./modules/installable/README.md) | Data, knowledge, style, and capability packages |
| [Windows release](./docs/WINDOWS_RELEASE.md) | Windows x64 runtime, signing, and installer validation |
| [Changelog](./docs/CHANGELOG.md) | Releases and compatibility changes |

## Acknowledgements

TransportX builds on and has benefited from these open-source projects:

- [Pi](https://github.com/earendil-works/pi) provides the agent runtime, model integration, and tool loop.
- [Pi Tau Web Server](https://github.com/milanglacier/pi-tau-web-server) is the upstream foundation for the browser workspace and Pi RPC session architecture.
- [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) powers interactive map rendering.
- [Electron](https://github.com/electron/electron) and [React](https://github.com/facebook/react) provide the desktop and interface foundations.

Thank you to their maintainers and contributors.

## License

MIT
