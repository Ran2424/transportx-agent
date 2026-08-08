# 测试基线

更新时间：2026-08-09

默认测试当前为 89 项，其中 87 项通过，2 项依赖外部 Knowledge 实体资产的集成用例在资产未安装时跳过。数量不是目标；每项都应覆盖一个可回归的协议、状态转移、权限边界或用户可见行为。

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
- Module 聚合安装、四类单资源包装、动态装配、安全卸载、路径逃逸和符号链接拒绝。
- macOS 应用目录、Pi 模型与认证文件权限，以及创建会话必须显式选择模型。
- macOS 测试构建的 afterPack ad-hoc 签名钩子，以及 Python 探测不向 `.app` 写入字节码缓存。

## 浏览器与 Pi 验证

```bash
npm run test:react-smoke
npm run test:desktop-smoke
npm run test:pi-smoke
```

- React smoke 使用真实 Chrome、Node 服务和 fake Pi，覆盖添加模型、模块设置、会话创建/切换、Conversation、Task Board、按需 Geo runtime、Extension Dialog、主题、键盘和移动端抽屉。
- Desktop smoke 使用真实 Electron 与 Agent Host，验证安全沙箱、Mac 应用目录初始化、无默认模型、PDF 导出和退出清理；设置 `TRANSPORTX_PACKAGED_APP` 后还会验证包内 Python 3.10 及运行依赖。
- Pi smoke 使用本机 Pi RPC offline 模式，验证真实进程协议；不应在默认测试中运行。

删除 legacy UI 后，不再维护 legacy 浏览器基线。新增端到端场景应优先扩充 React 或 Desktop smoke；新增 Node 用例应保持聚焦并替换低价值检查。
