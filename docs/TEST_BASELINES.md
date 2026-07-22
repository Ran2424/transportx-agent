# 测试基线（React 迁移阶段 0）

本文档是「冻结事实和行为基线」的操作手册：基线覆盖清单、手工验收清单、如何重跑。
对应迁移计划 `docs/REACT_UI_MIGRATION_PLAN.md` 第 9 节「阶段 0」。

最近一次验证（2026-07-22）：`npm run test:browser-baseline` 的 11/11 场景通过；在 Node 24.2.0、Chrome 150、darwin/arm64 环境记录 500 delta streaming 约 675ms、200 条历史消息首次渲染约 50ms。截图基线生成 6 套主题 × 桌面/移动共 12 张；PNG 按规则忽略，仅保留 `manifest.json` 哈希清单。阶段 2 的 `npm run test:react-smoke` 与阶段 3 的共享 Contract 测试也已通过。

## 组成

| 层 | 位置 | 跑法 |
| --- | --- | --- |
| 协议 fixture | `test/fixtures/**`（会话 JSONL / Pi 事件流 / Task·Geo·Bridge） | `npm test` 中的 `test/fixtures.test.ts` |
| 共享 Contract fixture | `test/fixtures/contracts/{session,task,geo,bridge}.json` | `test/contracts.test.ts`：合法/非法版本、非法 revision、revision regression、Bridge capabilities |
| fake-pi 线束 | `scripts/harness/fake-pi.mjs`、`scripts/harness/serve-with-fake-pi.mjs`、`scripts/harness/scenarios/baseline.json` | 被 browser-baseline 自动拉起，也可单独运行 |
| 浏览器基线 | `scripts/browser-baseline.mjs` | `npm run test:browser-baseline` |
| 性能基线 | `test/baselines/perf-baseline.json` | 随 browser-baseline 重新生成 |
| 截图基线 | `test/baselines/screenshots/*.png` + `manifest.json` | 随 browser-baseline 重新生成 |
| React 基座 smoke | `scripts/react-smoke.mjs` | `npm run test:react-smoke` |

Provenance：`npm run test:pi-smoke` 在当前环境可用（真实 pi 0.80.10 握手冒烟通过），但不覆盖完整
prompt 流式事件流（需模型 API key）；因此所有 fixture 与 fake-pi 回放均为**协议一致的合成事件**，
字段形状逐一对照真实 pi 0.80.x 会话文件与 server/前端实际消费代码核验（详见 `test/fixtures/README.md`）。

## 浏览器基线覆盖清单（`scripts/browser-baseline.mjs`，11 个场景）

1. **create**：通过 UI 模态框创建两个会话，标签标题正确。
2. **switch**：点击标签切换活动会话。
3. **streaming**：fake-pi 回放 text/thinking delta；断言流式内容增量增长、`agent_end` 后全文完整。
4. **abort**：流式中点击停止；断言输入恢复可用、部分内容只出现一次（无重复）。
5. **resume**：POST `/api/live-sessions/resume` 恢复预置 JSONL（`straight-session.jsonl`）；断言历史渲染、
   重连/切换后 snapshot 重叠内容不重复追加。
6. **close**：点击标签关闭按钮，标签移除。
7. **task**：`extension_ui_request(select)` 对话框出现→选择→消失；`tau_task` 结果后任务面板可见且含任务标题。
8. **lazy-geo**：以上所有非 Geo 场景中不得请求 `geo-runtime.js`（懒加载基线）。
9. **geo**：`present_visualization` 结果（含 envelope）后 `body.has-visualizations`、
   工作区自动打开、地图标题/图层列表正确；WebGL 可用性记入报告（headless Chrome 无 WebGL 时只断言面板/DOM 挂载）。
10. **screenshots**：6 主题（night/dawn/midnight/clean/terracotta/sage）× 桌面 1440×900 / 移动 390×844 共 12 张。
11. **perf**：500 delta 长 streaming 渲染耗时、200 条消息历史首次渲染耗时，写入 `perf-baseline.json`（只记录数字+环境，不设阈值）。

任一场景失败即退出码非 0，并打印场景名与关键 UI 状态。

## 手工验收清单（自动化未覆盖部分）

以下项目前没有自动化断言，迁移各阶段 PR 需人工过一遍：

- 截图人工比对：`test/baselines/screenshots/`（每次运行重新生成，PNG 不入库；`manifest.json` 记录 sha256，
  用于确认两次运行的截图是否变化）。重点看移动端侧栏/输入区与六主题对比度。
- Geo 地图的视觉效果（图层颜色/弹窗/底图）：自动化只断言了面板 DOM 与图层清单。
- 语音输入按钮、图片附件、文件浏览器、命令面板、导出 HTML：不在基线内，改动相关代码时手工验证。
- 真实 pi 冒烟（有 API key 的环境）：`npm run test:pi-smoke`。

## 如何重跑

```bash
npm test                        # 含 test/fixtures.test.ts（需先 build，npm test 会自动 build）
npm run test:react-smoke         # build + 真实 Node Server + Chrome 验证 /react/ 基座
npm run test:browser-baseline   # build + 起 fake-pi 线束 + Chrome 全量基线
node scripts/harness/serve-with-fake-pi.mjs --port 3009   # 单独起线束手工调试（打印 TAU_FAKE_READY 后等待）
```

环境要求：系统 Chrome（playwright `channel: 'chrome'`，可用 `TAU_BROWSER_CHANNEL` 覆盖）。

## 修改协议时

改了 `src/contracts/**`、`session-projection`、task/geo/bridge 兼容层或 `app-main` 事件处理中的任何一个，
必须同步更新 `test/fixtures/contracts/**`（以及受影响的阶段 0 fixture）、`test/fixtures/README.md` 的校验点表，并确认
`test/contracts.test.ts`、`test/fixtures.test.ts` 与 `npm run test:browser-baseline` 全绿。
