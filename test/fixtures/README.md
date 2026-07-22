# test/fixtures — 协议事实基线（React 迁移阶段 0）

本目录是「冻结事实和行为基线」的一部分：手工构造但与线上协议严格一致的输入样本。
所有 fixture 的 **provenance**：`npm run test:pi-smoke` 在当前环境可用（真实 pi 0.80.10 的
握手/命令/entry 追加冒烟通过），但它不覆盖完整 prompt 流式事件流（需要模型 API key）。
因此这里的会话/事件样本是**协议一致的合成数据**——字段形状逐一对照真实 pi 0.80.x 会话文件
（`~/.pi/agent/sessions/**.jsonl`）与 server/前端的实际消费代码核验，并由 `test/fixtures.test.ts` 固化。

## 目录与校验点

| 文件 | 形状来源 | 协议校验点（fixtures.test.ts 断言） |
| --- | --- | --- |
| `sessions/straight-session.jsonl` | 真实 pi 会话 JSONL（session/model_change/thinking_level_change/custom/message/session_info 行） | `bin/session-projection.js` 的 `SessionProjection` / `readSessionBranch` 投影出确定性 snapshot（schemaVersion=1、全部分支保留、id 链完整） |
| `sessions/branch-session.jsonl` | 同上，另加 parentId 旁路分支与无 id 的 custom/session_info 条目 | `selectCurrentSessionBranch`：从最后一个树条目沿 parentId 回溯，丢弃放弃分支（`bb000004`/`bb000005`），保留无 id sideband 条目 |
| `events/stream-happy.json` | WS `event` 消息内层的 Pi RPC 事件（`app-main.ts` `handleRPCEvent` 消费形状） | 关键字段：agent_start/turn_start/message_start/message_update(`assistantMessageEvent.delta`)/tool_execution_start·update·end/message_end/turn_end/agent_end；序列以 agent_start 开始、agent_end 结束 |
| `events/stream-abort.json` | 同上 | abort 序列：`message_end.message.stopReason === 'aborted'`，之后紧跟 turn_end/agent_end |
| `events/stream-late-duplicate.json` | 同上 | 重复/乱序 delta 后 `message_end` 携带权威全文；纠偏语义注释对应 `app-main.ts:1064-1090`（全文长度 >= 本地流式文本才覆盖） |
| `events/reconnect-snapshot.json` | WS `live_session_snapshot` 消息（`PiRpcSession.snapshot()`） | `schemaVersion === 1`、`entries` 与 `session` 元数据齐备；entries 内容与 stream-happy 的最终消息重叠，语义是「clear 后全量重渲染、不得重复追加」（`app-main.ts:1769`） |
| `features/task-entries.json` | pi-task-mode custom entry + tau_task/tau_ask_user toolResult | `src/public/features/task/task-protocol.ts`：`parseTaskStateEntry`（versioned 与 legacy 两种）、`parseTaskModeEntry`、`parseTaskToolResult`（`tau-task` 与 `tau-interaction`） |
| `features/geo-tool-result.json` | present_visualization toolResult（真实 GIS smoke 会话同款形状） | `src/public/visualization/geo/protocol.ts`：`getVisualizationFromToolResult` 解析出 envelope，`parseGeoScene` 接受内联 GeoJSON scene |
| `features/bridge-envelope.json` | pi-web-bridge custom entry（`entry_appended` 的 entry 内层） | `bin/pi-web-bridge.js` 的 `parsePiWebBridgeEnvelope`：schemaVersion/revision/model/thinkingLevel/tools |

## 如何再生成

1. 若有真实 pi + API key：跑 `npm run test:pi-smoke` 产生真实会话，从
   `$PI_CODING_AGENT_SESSION_DIR/<cwd-编码>/<timestamp>_<uuid>.jsonl` 截取对应行，
   替换 `sessions/*.jsonl`；把 WS 侧抓到的 event 序列整理为 `events/*.json` 同款结构。
2. 无真实 pi：用 `scripts/harness/fake-pi.mjs` 回放场景（`scripts/harness/scenarios/baseline.json`），
   其产出与本目录 fixture 同源同构；修改 fixture 后跑 `npm test`（`test/fixtures.test.ts` 会校验）。
3. 修改任何协议代码（session-projection / task-protocol / geo protocol / pi-web-bridge / app-main 事件处理）后，
   必须同步更新对应 fixture 并在本表更新「协议校验点」。

约定：JSONL 一行一条目、UTF-8、无尾随逗号；事件 fixture 是单个 JSON 对象
（`{ description, sessionId, events: [...] }`），`_note` 字段为注释、消费方应忽略。
