# Tool 与插件架构优化：P2 执行记录

> 2026-10-23；TransportX 3.23.1 / Pi 0.80.10。P0/P1 已合并；P2 在 `codex/tool-plugin-plan-p2` 验收。P3/P4 尚未验收。

## 两个实际用例与最小共性

先用原 Citation 适配器运行生产 Host，再提取通信。实际复现了 Host 接受 Pi Schema 不允许的 `sources[].unexpected`；修复后返回 400，接口主版本不兼容返回 409。文件/网页互斥规则及原错误指引保持。

唯一编写来源为 `src/contracts/tool-definitions.mts`；构建生成两包的 `tool-contract.json`。Pi 使用包内定义，Host 只读取平台批准的定义作最终校验，包自报信息不能扩大权限。静态装配检查不 import Extension。输入指纹去除注释和键序，保留属性名、const/enum 等业务数据；指纹漂移不直接宣布语义不兼容。

`modules/shared/host-client.ts` 仅处理可信请求上下文、signal/时限、HTTP/解析错误、调用关联。没有领域校验、注册、排队、重试或 SDK；两适配器继续保留各自协议、结果解析与 Pi hook。Citation 新增取消及未知状态、有界摘要；正常成功仍是 `tau-citations`，Spatial 仍是 `tau-spatial-analysis`。

Spatial 1.3.0、Citation 2.1.0、Web Bridge 1.0.2 独立升版。平台沿用 3.23.1 未发布段。

## 只读核对

现有 overview 按当前任务精确计划、实际 Pi Bridge、入口真实路径、active、Schema、接口语义和本任务确认的 Host 成功结果计算三态及原因。没有会话、仅历史样本、来源匿名或尚未调用为尚未验证；确实缺失/inactive/其他来源占名为不可用。可用代表该观察及已发生调用的证据，不承诺未来每个资源均授权。能力中心展示原因、观察代次与时间；切换任务或打开中心读取，不后台轮询、不自动激活、不另存可用性表。

Bridge 首次 agent_start 重新采样，即使恢复的 JSONL 内容相同；分支切换强制采样，旧代次不覆盖新观察。工具仍由 Pi 注册/激活，未迁移 Geo 或交互状态。

## 实际验收

- `npm run test:budget` 40/40；完整 typecheck、核心测试 40/40、真实 Pi RPC、完整 Web 回归通过。注册捕获核对两个 bundle 的工具名/参数与包内定义；源码静态检查不替代真实执行。
- `TRANSPORTX_TOOL_SMOKE_PHASE=citation node scripts/tool-host-smoke.mjs`：真实 Pi + 生产安装/装配/路由/Python，固定 HTTP 模型。Spatial P1 场景保持；Citation 文件登记/重复登记、互斥/结构拒绝、受控 HTTPS 网页、流式取消和提交后丢响应均通过。丢响应恰转发一次，新增 Evidence 保留，不自动重试。
- overview 无会话为尚未验证，实际成功后可用；用 Pi 原生 `setActiveTools` 停用后观察为 inactive；再启用和调用恢复可用。实际工作台消费这些结果，展示未知及能力核对，刷新仍可读。
- `local.traffic-peak` 从目录安装 1.0.0、ZIP 更新至 1.0.1，新任务选择新版并实际计算 CSV 的 A/08=30；原制作目录已删除。Pi-local 无 Host Invocation。
- 两模块分别 bundle 到 `dist/tool-modules/`；隔离平台根不含 `modules/shared`，只带普通平台依赖、包与契约，重复完整真实链路通过。不是公开公共 SDK。
- macOS arm64 Electron 应用实际构建，使用自包含 Python 3.10.20；桌面启动、原生信任 IPC、PDF 导航、视频 codec 与退出通过。首次 asar 调用发现 FileSet remap 后未按源路径解包，已增加 `dist/module-extensions/**` 解包模式，随后实际执行又发现 Spatial 外部 Python 入口使用 asar 虚拟路径；改为复用 preferUnpackedPath，不新加 OS 分支。再次打包后验收。

测试只对自建 fixture 的原生信任决定提供 stub；所有生产授权和领域执行保留。受控网页只替换测试域的外部 DNS/HTTPS 连接，Host 的 URL 安全校验、流读取、快照和 Registry 均为生产代码。没有把固定 HTTP 模型称为真实 Agent 自主制作证据。

## 测量与范围

同 P1 Apple M4/24 GiB、Darwin arm64、Node 24.2.0、Pi 0.80.10，固定 Provider、串行调用、缓存未清。首轮 P2 启动五次为 520/479/496/506/484 ms，中位 496 ms，较 P0 基线 441 ms 增 55 ms，满足单次 ≤1500 ms / 中位增量 ≤250 ms。1,000 / 50,000 点 spatial_join 为 168 / 1957 ms，较 P1 169 / 1816 ms；输出分别 169,932 / 8,588,932 字节、模型摘要 292 / 293 字符，满足既定 20 s / 6000 字符预算。50 ms 采样 Host/Pi/Python 最大 RSS 为 207,568 / 167,712 / 181,760 KiB，满足 Host 594,800 KiB / Python 512 MiB 预算；并行 Web 验收影响这一轮端到端延迟，另行串行复测，不将其称稳定尾延迟。

尚未验收：Windows 实际安装包、Spatial 持久执行确认/重启恢复、独立包完整生命周期与三个真实模型制作案例；分别交由后续阶段及目标平台。旧协议读取沿用原测试与真实 JSONL，不改写历史。

串行工具负载复测（期间桌面重打包仍在进行）：启动 535/577/634/505/572 ms，中位 572 ms，仍在既定预算；规模 189/2175 ms；Host/Pi/Python 采样最大 RSS 205,392/166,704/172,400 KiB。此处保留运行条件，不声称完全隔离的通信基准或稳定 p95。
