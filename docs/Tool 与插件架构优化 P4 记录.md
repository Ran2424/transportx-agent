# Tool 与插件架构优化：P4 初版交付记录

> 2026-10-23。按用户追加要求优先交付完整可运行初版，不继续扩大测试/安全矩阵。P0–P3 已合并；本阶段将制作、安装、新任务调用和插件生命周期串起来。正式发布的目标平台验收另行记录。

## 已实现

Module Authoring 1.2.0 新增原生 Pi 工具 `tau_module_package`，输入从统一 TypeBox 来源生成包内 Tool Contract。inspect 静态验证任务内包，不 import Extension；install 复用原安装器和原生信任决定。Agent 不必让用户编辑 Manifest/settings，也不直接复制受管目录；生成、样例运行、检查、安装、实际调用分开。安装成功提示新任务使用，当前任务冻结计划不变。

制作 Skill 覆盖用户脚本、CLI、API 文档；可推断包名/ID，保留原程序，检查实际 Python 依赖，凭据留在外部配置。缺依赖或凭据时交付草稿并说明未运行，不擅改内置 runtime。薄 Host Client 仅随第三个实际模块 bundle，不新增 SDK、插件容器或万能执行器。

## 跑通的路径

| 场景 | 结果 |
|---|---|
| 真实模型 CSV 制作 | DeepSeek `deepseek-v4-flash` 自行读取制作 Skill，保留 `peak.py`，验证 A/08=30，生成 `local.p4-csv@1.0.0`，调用 inspect/install；安装成功 |
| 新任务调用生成工具 | 生产 Assembly + 真实 Pi + 同一真实模型调用新注册的 `tau_peak_hour`，返回 A/08=30、B/08=7；随后 Citation 输入错误经正常反馈纠正，不重算 CSV |
| 缺 Python 依赖 | 真实模型读取 Skill，实际检查得到 `ortools: None`，生成草稿及依赖说明；自检明确 `executionVerified:false`，仅 inspect，没有安装或虚报运行 |
| 私有 API 缺凭据 | 真实模型按提供的 API 文档生成 `local.p4-api`，使用 `TRANSPORTX_TRAFFIC_API_TOKEN` 配置名，静态检查后交付草稿；未安装、不宣称 API 请求成功 |
| 独立插件生命周期 | 目录 1.0.0 / ZIP 1.0.1 安装；禁用后新任务不选、已有任务仍能调用；显式恢复旧可信任务保持 1.0.0；新任务执行 1.0.1；占用时拒绝卸载，关闭后可卸载，JSONL 字节保留；缺版本给出原因，重装两个精确版本后恢复 |
| Video 独立分发 | 使用原可安装源和显式 ffmpeg runtime 构建 Video 1.4.1 darwin/arm64 ZIP，实际探测 ffmpeg/ffprobe 8.0 并携带许可；基础应用不夹带 Video runtime |

真实模型验收入口是 `scripts/module-authoring-smoke.mjs`，必须显式提供配置目录和模型；普通 CI 不调用真实模型。原始提示、生成包、样例、自检和 Pi JSONL 保留于本机隔离证据目录 `transportx-real-authoring-8MtDtG`，汇总为 `acceptance-report.json`；结束时已移除复制的 models/auth 凭据文件。仓库文档不保存密钥或完整认证配置。信任决定仅为这些自建包提供测试 stub，不称真人点击证明。

生成的三个包另存于 `release/modules/local.p4-*.zip`。CSV 是已实际安装/调用的示例，另外两个是有明确缺失条件的草稿。真实模型三个案例证明本轮模型能够制作，不承诺所有未知业务资料均能自动适配。

## 检查与打包

完整 typecheck 通过；核心 40/40 通过，没有新增测试节点。P3 完整真实 Pi–Host–Python 恢复链路及 P4 生命周期已通过；P2 的完整 Web 与实际 asar 结果读取证明保持。P4 macOS ad-hoc 应用包已经实际启动，通过桌面/PDF/原生确认检查；从真实 app.asar 启动内置 Electron/Host/Pi，使用包内 Python，完整 Spatial/Citation、目录与 ZIP 生命周期、tau_module_package 检查和安装均通过，当前任务计划保持冻结；Windows 安装器、签名公证、冷启动/长时间负载和正式发布矩阵不作为本次初版已验收结论。

开发在受管 `tool-plugin-p4` worktree 完成，以避开原目录并行修改的 Traffic Lab PLAN；原文档内容保留，P3 PR 已移出该无关变更。没有强推或重置。平台仍为 3.23.1 未发布，未正式对外发布。

最终交付代码见 [PR #79](https://github.com/Ran2424/transportx-agent/pull/79)。本机应用位于 `release/mac-arm64/TransportX Agent.app`，可分发初版归档为 `release/TransportX-Agent-3.23.1-tool-plugin-preview-mac-arm64.zip`；示例包和 Video 包在 `release/modules/`。这些是验收/预览产物，不冻结 3.23.1 的正式发布段。
