# Tool 与插件架构优化：P3 执行记录

> 2026-10-23。P2 [PR #77](https://github.com/Ran2424/transportx-agent/pull/77) 已合并，三平台 CI 39817343318 通过。用户追加要求优先完成完整初版，后续保留关键真实闭环和必要检查，不扩展测试矩阵。

Spatial Module 1.4.0 新增 `tau_spatial_execution`；原分析名称、输入与成功协议保持。Host 在计算前签发随机 operationId，持久绑定 P0 冻结的 Owner、规范化领域参数、接口语义和输入 SHA-256。调用关联索引按 toolCallId 定位该已签发操作；相似的新参数不会自动合并意图，模型不能用分析参数覆盖 Host 上下文。

API 保留原 analyze；新适配器先 prepare，再用 Host 签发 ID 执行。旧适配器仍可直接调用原 analyze，由 Host 受理并建立记录；没有 toolCallId 的旧调用不能被称为可靠重复重试。相同 ID/输入版本复用原成功结果，冲突返回 409，运行中或未知不重新派发。沿用原 Job/并发控制/PythonRunner，保存既有 jobId，不增加执行队列。

查询/取消经原 Spatial service token 与计划检查，再校验持久 Owner。换 live ID 恢复同 JSONL 可以查询；原样复制 JSONL 产生不同 owner，不能继承旧执行权。查询使用原请求、manifest、输出路径/哈希/GeoJSON 核验，源文件后来变化不改变历史成果；再次执行旧 ID 时源文件哈希变化仍会冲突。计算前后检查输入版本变化。取消只在确认未提交后为取消，提交不回滚，可选引用失败仍为 warning。

持久记录仅服务 Spatial 长任务，位置是用户数据根 `executions/spatial/<owner-hash>/`。Pi JSONL 仍是唯一工具历史。没有使用参数相似性、cwd、Citation ID 或活动会话 ID 代替持久归属；没有把操作 ID 当授权。丢失/损坏确认或进程停止未确认时保留未知和成果，不重算。

## 实际跑通

- 类型检查与 40/40 核心回归通过；没有新增注册测试。
- 真实 Pi + 生产 Host + 实际 Python：原 buffer/nearest/join、50,000 点、错误/取消、可选引用故障和原工作台历史展示保持通过。
- 提交后丢响应：真实 Pi 查询返回原结果；直接重放同操作返回 reused，成果字节、ID、manifest 数量不变；不同参数拒绝。
- 三种故障在测试专用 Node preload 中注入，保留真实计算/提交：manifest 原子 rename 前强杀 Host、rename 后强杀、Python 派发后计算中强杀。生产代码没有故障开关。重启生产 Host，沿原计划恢复真实 Pi，查询并重放已有操作。
- 提交前 / 提交后 / 计算中的恢复时间为 982 / 994 / 1157 ms，满足执行前固定的本机 10 s 预算；状态分别为 unknown / succeeded / unknown。每例实际 Python 派发次数恰为 1，重放和查询不增加。提交后结果 ID/哈希不变；复制相同历史到另一文件后，使用复制会话自己的合法 token 仍不能查询旧 owner。
- Citation 的实际多输入批次中，第二个文件不存在时 Registry 字节不变；重复文件登记与提交后丢响应的已有 Evidence 保持，无全工具 Invocation。
- 恢复复现了 macOS `/var` 与 `/private/var` 别名被错误判为跨工作区，Session Assembly 改为真实路径的 relative 比较；没有新 OS 分支。

复现：`TRANSPORTX_TOOL_SMOKE_PHASE=recovery node scripts/tool-host-smoke.mjs`，通过 `TAU_PYTHON_COMMAND` 提供 Python 3.10。使用固定模型 HTTP 响应，不称真实模型自主选择/制作。强杀计算时操作系统可能保留未提交子进程/输出；恢复没有凭旧 PID 重启或误杀生产作业，保持 unknown；测试只清理自身持有的子进程。未承诺断电恢复、自动继续未知计算或跨任务查询。

启动 510/536/722/457/466 ms（19 tools / 11 modules），中位 510 ms，满足 P0 预算。查询与模型摘要仅传结果引用，完整 GeoJSON 留在文件。P4 再补制作、完整生命周期与分发初版。
