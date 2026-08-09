# 测试基线

更新时间：2026-08-09

默认测试固定为 30 项。筛选标准是失败后会造成真实产品事故：进程无法启动、持久化状态丢失、跨会话越权、协议失配、用户模块污染平台、桌面包不可运行，或客户端断连误杀后台任务。重复 happy-path、纯格式、实现细节和已由浏览器/Desktop smoke 覆盖的微型测试不进入默认集合。

## 默认验证

```bash
npm run typecheck
npm test
```

`npm test` 会先构建 Server、Browser Kernel、React 和 Geo runtime，再运行 30 项 Node 测试。当前覆盖包括：

- Agent Host 回环端口启动与 ready/health 协议。
- Session、Task、Geo、Citation、Bridge 契约的版本、修订和跨层一致性。
- 历史会话递归发现、分支投影、排序、恢复和持久化快照。
- HTTP 文件边界、会话间 Geo 隔离、Citation 产物边界与 Cookie 鉴权。
- Module 聚合/单资源安装、完整性校验、路径逃逸拒绝、平台/用户模块解耦和 Session Assembly。
- macOS 用户目录、Runtime Manifest 校验、Skill 打包规则和未签名测试构建钩子。
- Task Extension 持久化、恢复和会话结束状态转换。
- WebSocket 跨源拒绝，以及客户端断连不终止后台 Session。
- npm、lockfile 与 CHANGELOG 版本同步。

## 浏览器与 Pi 验证

```bash
npm run test:react-smoke
npm run test:desktop-smoke
npm run test:pi-smoke
```

- React smoke 使用真实 Chrome、Node 服务和 fake Pi，覆盖添加模型、模块设置、会话创建/切换、Conversation、Task Board、按需 Geo runtime、Extension Dialog、主题、键盘和移动端抽屉。
- Desktop smoke 使用真实 Electron 与 Agent Host，验证安全沙箱、Mac 应用目录初始化、无默认模型、PDF 导出和退出清理；设置 `TRANSPORTX_PACKAGED_APP` 后还会验证包内 Python 3.10 及运行依赖。
- Pi smoke 使用本机 Pi RPC offline 模式，验证真实进程协议；不在默认 30 项中运行。

删除 legacy UI 后，不再维护 legacy 浏览器基线。新增端到端场景应优先扩充 React 或 Desktop smoke；若必须新增默认 Node 用例，应同时删除或合并一项更低价值测试，保持 30 项上限。
