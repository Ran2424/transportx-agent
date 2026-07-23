# 测试基线

更新时间：2026-07-23

默认测试固定为 49 项。数量不是目标；每项都应覆盖一个可回归的协议、状态转移、权限边界或用户可见行为。

## 默认验证

```bash
npm run typecheck
npm test
```

`npm test` 会先构建 Server、Browser Kernel、React 和 Geo runtime，再运行 Node 测试。当前关键覆盖包括：

- Session/Task/Geo/Bridge 共享契约与版本诊断。
- JSONL 分支投影、会话恢复、最后一次对话时间排序。
- HTTP 文件路径约束、Cookie 鉴权、WebSocket 同源与断开行为。
- 任务 Extension 的开启、持久化、恢复与未完成任务中断。
- 会话间 Geo 资源隔离和 ETag 重新验证。
- Markdown 原始 HTML 与不安全资源 URL 的安全渲染。

## 浏览器与 Pi 验证

```bash
npm run test:react-smoke
npm run test:pi-smoke
```

- React smoke 使用真实 Chrome、Node 服务和 fake Pi，覆盖会话创建/切换、Conversation、Task Board、按需 Geo runtime、Extension Dialog、主题、键盘和移动端抽屉。
- Pi smoke 使用本机 Pi RPC offline 模式，验证真实进程协议；不应在默认测试中运行。

删除 legacy UI 后，不再维护 legacy 浏览器基线。新增端到端场景应优先扩充 React smoke，新增 Node 用例时须在 49 项上限内替换低价值检查。
