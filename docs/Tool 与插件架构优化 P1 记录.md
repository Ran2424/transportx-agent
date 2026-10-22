# Tool 与插件架构优化：P1 执行记录

> 2026-10-22；TransportX 3.23.1 / Pi 0.80.10。P0 已通过 PR #75 和三平台 CI；本阶段在 `codex/tool-plugin-plan-p1` 开发。P1 本机闭环通过，阶段完整回归/PR 验收进行中；P2–P4 尚未完成。

## 实现边界

Spatial 保留 `tau_spatial_analyze`、原 TypeBox 输入、原领域路由及成功 `details.kind = tau-spatial-analysis`。在原适配器贯穿调用 ID、signal、130 秒时限和输出校验，没有提取公共 Client、Registry 或新的 Runtime。Pi `tool_result` 公共 hook 负责正确的 `isError`；短期 Map 仅关联本次 execute 的已确认响应/取消竞态，在结果和 shutdown 时清理，不是持久作业表。

Host 的服务 token、计划 Module、停止状态和资源授权仍为最终边界，调用 ID 不授予权限。语义拒绝发生在目录创建前；Python 确认失败/停止后只清理本次目录。输出祖先符号链接拒绝，结果经原协议/哈希/GeoJSON 校验后原子写入 manifest；提交写入异常或进程停止未确认保留文件供核验。可选 Citation 登记或返回呈现异常保留计算成功及结果引用。

未收到响应时返回“结果未知”，说明核验 `.tau/spatial-results` 与 `analysis/spatial`，不自动重试。请求取消与确认停止分开：收到 Host 未提交确认才显示已取消，否则保留未知；晚到取消不覆盖已收到的成功响应。UI 复用原 Tool Card 和主题 token，显示未知/已取消；若随后模型失败，本轮的未知分析阻止“准备重试”复制整个提示词，并说明先核验成果。没有新增重算按钮或持久恢复承诺。

Spatial Module 版本提升至 **1.2.0**；其他 Module 未改。平台版本继续归集 3.23.1 未发布段。

## 可重复验收

```bash
rtk npm run test:budget
rtk npm run typecheck
rtk npm test
rtk proxy env TAU_PYTHON_COMMAND="<Python 3.10>" TRANSPORTX_TOOL_SMOKE_PHASE=spatial node scripts/tool-host-smoke.mjs
rtk npm run test:web
```

`tool-host-smoke` 使用真实 Pi、生产 Installer/Assembly/Host 路由、实际 Python 与本地固定 Provider。临时目录/凭据完全隔离；仅原生决定由测试父进程为自己创建的 fixture 授权。中继仅注入响应交付故障，实际授权、计算、提交仍经过生产代码。

已通过的本机切片：

- buffer、nearest、spatial_join 均实际执行，计数、输出、Citation Evidence、Pi 历史和有界模型摘要通过。
- 非法 metric CRS 经真实 Host 拒绝，Pi 标记 `isError`，没有新成果目录；错误 token 经生产路由拒绝。
- Host 提交后中继丢弃响应：Pi 保存未知，manifest 增加且保留，转发计数恰为一次，没有自动重算。
- Host 已确认结果而可选 Citation 响应损坏：仍是成功分析，保留结果引用并返回 warning。
- 15,000 点样本在 Python 请求创建后取消：确认停止后本次目录消失，先前成功 manifest 不变；Pi 依据实际确认显示取消或未知。
- 丢响应后模型 API 再失败：工作台消费本次真实结果，显示未知及核验指引，不提供整轮准备重试；页面刷新后读取历史仍成立。
- 独立 CSV 脚本封装为 `local.traffic-peak@1.0.0`，通过生产安装、计划装配与真实 Pi 调用。业务脚本保持原样，只用 Pi 公共 API、包内文件及 Python 标准库；A 路段 08 时合计 30。删除原制作目录后仍可调用；路径错误为 Pi 错误，Pi-local 不创建 Host Invocation。

这验证平台执行和当前 Agent 编写适配器的最小闭环，不等于 P4 的三个真实模型自主制作案例。原生信任入口的 OS 对话框决定仍由 fixture 模拟，不称真人操作证明。

## 测量范围与剩余门槛

同 P0 的 Apple M4/24 GiB、Darwin arm64、Node 24.2.0、Pi 0.80.10，串行固定 Provider，缓存未清。一次代表性观测：buffer 223 ms / 2719 字节输出，nearest 141 ms / 223 字节，spatial_join 142 ms / 216 字节；包含两次本地模型往返，不是纯通信耗时，不宣称 p95。摘要 ≤6000 字符；完整 GeoJSON 留在文件。启动仍执行 P0 五样本入口，按 ≤1500 ms、较基线中位数增加 ≤250 ms 的预算复核。

追加规模与资源观测：同一生产链路完成 1,000 / 50,000 点 spatial_join，分别为 169 / 1816 ms，输入 100,931 / 5,138,931 字节、输出 169,932 / 8,588,932 字节、模型摘要 292 / 293 字符；核对输出数量与摘要上限；50,000 是现有要素数限额，不将其外推成 100 MiB 任意几何都已测量。另用当前 Darwin 的 `ps` 每 50 ms 采样，改造前 main 小工具路径 Host/Pi 单进程最大观测 RSS 为 70,512 / 168,448 KiB；P1 含规模、故障及浏览器验收的完整链路为 Host 256,256、Pi 157,808、领域 Python 167,456 KiB。数据规模不同，不把这两组称为同负载内存退化对照；采样可能漏掉瞬时峰值，不是内核 high-water mark，harness RSS 不作为生产指标。

规模执行前固定本机验收上限：Host 采样 RSS ≤小工具基线 +512 MiB（594,800 KiB），Python 单进程 ≤512 MiB，规模调用 ≤20,000 ms，模型摘要 ≤6000 字符；本轮通过。采样脚本为本机审计驱动，原始数值如上，平台生产路径不新增 OS 分支或常驻测量服务。P2 共性提取以当前 P1 的同一全链路、同样数据重测，不以小工具数据替代规模对照。

独立包 ZIP、两个 Host 客户端的共性和工具诊断留待 P2；持久 operationId、跨重启查询、提交窗口故障恢复留待 P3；完整外部生命周期、asar/unpacked、Video 分发、真实模型制作及正式发布包留待 P4。尚未完成的测量不列为通过。
