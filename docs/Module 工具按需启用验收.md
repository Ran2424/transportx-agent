# Module 工具按需启用验收

2026-10-23；平台 3.23.2 未发布；Pi 0.80.10；基线 e4b6546。

## P0：真实 Pi 机制

`node scripts/tool-activation-smoke.mjs` 已通过。真实 Pi RPC 进程加载生产 Tool Activation 与 Geo Extension，受控 HTTP Provider 捕获实际 tools 字段；没有 fake Pi。首次请求及 discover/inspect/status 后均严格为 read/write/edit/bash/manage_capabilities，Schema 3664 字节。enable Geo 后同一 Agent 任务的下一次请求为 10 工具、11388 字节，实际 publish_geodata 成功。重复 enable 只有一条启用记录。

reload 后首个请求、跨进程恢复、原生压缩后均保留 10 工具；导航到启用前分支和 fork 到启用前均恢复五工具，回到原分支恢复 10 工具。恢复后 publish_geodata 历史只有一次，没有重放。

唯一持久来源是 Pi custom entry `transportx-tool-activation/v1`：assembly 记录初始化 Module 身份及成员，enable 记录成功开放意图。assembly 与 enable 都沿有效分支读取，不依赖压缩摘要。保存成员快照是为在 reload/resume 核对漂移，不是第二份工具 Registry，不保存 Schema 或 execute。Host 仅向 Pi 注入已核验计划内的模块身份、入口、展示/Skill 摘要和契约文件路径；实际工具来源通过 realpath 精确比较。当前环境尚未验证新协调器的 asar 包与 Windows 安装器。

受控 Provider 只证明真实 Pi 的请求与执行行为；真实模型自主选择、生产 Host 与独立安装包由后续阶段单独记录。

## P1：Workbench

Tool Activation 1.0.0、Workbench 1.4.0、Web Bridge 1.2.0、Module Authoring 1.2.1 已接入。四动作只使用 Pi 原生工具观察/开放 API，来源与契约核对合格但 inactive 的工具沿原三态显示为 unverified/待启用；来源和 Schema 问题优先报告。Bridge 保持单一发布者，在启用事件重新读取 Pi，并在 shutdown/reload 清理订阅。

完整类型检查、构建与 Node 40/40 回归通过；预算仍为 40/40。现有场景补非法动作字段、未知 Module、只读无副作用、记账失败后的真实 active、重复/并行 enable、成员漂移与来源变更断言。没有注册新测试节点。

真实生产 Host + Pi + Python 3.10 + Chrome 的 activation 链路通过：首请求严格五工具；discover/inspect/status 不开放；Geo 的依赖 Canvas 不被连带开放；Document 与独立 Skill-only 包返回 no_tools；新安装模块不扩大当前 Plan。原 Canvas 场景实际验证 Markdown/CSV/PDF、固定版本引用、当轮上下文、Geo 发布/地图/截图/输入、Interaction 回答及历史恢复。Spatial/Citation 的计算、取消、提交后丢响应、未知结果查询和原成果复用保持通过。

启动 custom entry 在首次对话时落盘是 Pi 原有行为，验收先进行只读 status 后检查历史；不增加空白业务调用或产品持久化旁路。

## P2：独立扩展与历史执行

生产 Installer 安装源码树外的 `local.traffic-peak`，新任务装配后以实际工具名搜索、查看和查询状态，三次查询保持五工具，然后 enable 并执行原 CSV Python，A/08=30。删除制作目录后仍可执行；ZIP 更新至 1.0.1、禁用/启用、旧任务精确版本恢复、占用时拒绝卸载、卸载保留 JSONL、精确重装恢复均沿原生命周期通过。管理器没有该模块 ID 或工具名的硬编码；测试 Provider 仅负责确定性驱动调用。

`activation-model-smoke.mjs` 另将 `local.activation-sum` 安装至隔离受管目录并删除制作源，真实 DeepSeek `deepseek-v4-flash` 自行 inspect/enable，然后调用 `road_volume_sum` 得到 52/4。只读地图介绍实际使用 discover/status/inspect，active 保持五工具；地图任务自行 discover/enable Geo 后执行 inspect_map_context，正确报告无地图输入。

真实 Pi 晚注册负例返回 `registration_changed_requires_new_session`，enable 拒绝不兼容模块，reload 后收敛回有效分支集合。Pi 在晚注册发生时仍会自动开放新名称，这是明确不支持的插件行为；没有增加监听器或声称提供代码隔离。已知缺失工具、重复入口归属与来源漂移的拒绝断言合并在现有 suite。

`TRANSPORTX_TOOL_SMOKE_PHASE=recovery node scripts/tool-host-smoke.mjs` 也已通过：提交前、提交后及计算中强杀 Host，恢复分别为 unknown/succeeded/unknown，每例 Python 派发恰为一次；查询和重放不重算，已提交成果 ID/哈希保留，复制 JSONL 不能取得原执行权。

实际模型证据保留在本机临时根 `transportx-activation-model-fxzt6H` 的 report.json 与 Pi JSONL，脚本退出已移除复制的 models/auth 文件。未将密钥或完整配置写入仓库。测试只授权自身 fixture 的原生信任决定，不声称真人点击或各平台安装包验收。

## P3：实测与取舍

Apple M4 / 24 GiB，macOS arm64，Node 24.2.0，Pi 0.80.10。固定 Provider 使用生产 Host 的同一装配集合，测试专用命令临时设置之前的 eager 集合后捕获真实 HTTP tools，再 reload 恢复正常行为；没有产品开关或第二套执行模式。

| 实际请求 | 工具数 | tools JSON 字节 |
|---|---:|---:|
| 原全量开放集合 | 17 | 19,940 |
| 新会话首次请求 | 5 | 3,664 |
| 开启 Geo 后 | 10 | 11,388 |
| Canvas/Geo/Citation/Interaction 连续使用并恢复后 | 14 | 17,616 |

其中 all-registered 为 21，包含 Pi 自带但原本不开放的 find/grep/ls 和管理器；没有用这 21 个冒充旧 eager 基线。新首请求 Schema 字节减少 81.6%。Geo 数值由 P0 同样生产定义的 Provider 捕获；其余为 Host 同装配对照。reload 后第一次实际请求为 10 工具。随着分支使用更多模块，工具继续累积；不承诺长期保持五工具。

真实模型第二次固定输入求和复测（DeepSeek deepseek-v4-flash，同一模块版本/输入；缓存未清）：

| 指标 | eager | progressive |
|---|---:|---:|
| 任务结果 | 52 / 4，成功 | 52 / 4，成功 |
| 模型请求 | 4 | 4 |
| 工具调用 | 4 | 4（含 enable） |
| 输入 token（未缓存） | 9,443 | 4,767 |
| cacheRead token | 29,696 | 14,208 |
| 合计输入 token | 39,139 | 18,975 |
| 输出 token | 359 | 511 |
| 任务耗时 | 4,822 ms | 5,474 ms |
| 初始化至 get_state | 440 ms | 425 ms |
| 初始化 Pi RSS | 215.6 MiB | 207.5 MiB |

内存来自各 Pi 自己的 process.memoryUsage，一次初始化时点，不是 Host 内存或稳定峰值。两个模式都完成完整 Extension 注册，不能据此宣称代码懒加载或显著内存收益。第一次求和样本也是 4 次模型请求、均成功，但 eager/progressive 工具调用为 4/5，耗时 6290/4399 ms；保留波动，不承诺统一加速。当前样本不足以估计总体成功率、p95 或其他 Provider 的缓存表现。

生产 Host 到首次工具/历史/Bridge 的最后五次观测为 493/483/456/456/452 ms，中位 456 ms。上轮同机 P0 记录中位 441 ms，但不是同一缓存和并发负载，不作为稳定差值；本轮未发现需要推迟 Extension 导入的启动瓶颈。

真实模型只读介绍与 Geo 执行均通过。复测只读介绍仅 discover+inspect（2 工具调用），首轮曾使用 7 次查询；没有证据需要引入新检索架构。四动作返回已按方案有界；保持按 Module 开放，不增加单工具粒度、自动回收或依赖传播。

第二次模型证据根 `transportx-activation-model-LvP31x`，已清除配置副本。可复核摘要见 [实测 JSON](acceptance/module-tool-activation.json)。最终构建、核心 40/40、完整 Web、真实 Pi RPC、完整类型检查通过；新增源码均小于 500 行。

## 范围与回退

本轮已验收源码与本机实际链路。未重新构建新协调器的 macOS/Windows 安装包，未运行其他 Provider 的原生 deferred 模式；PR CI 检查各 OS 的源码行为，目标机安装包仍需发布前验收。冻结旧 Plan 未包含协调器时继续使用原计划，不注入新模块；已有普通历史、引用、地图及业务结果不清理。

需要回退时撤回协调器依赖/默认装配与相关启动、Bridge、诊断改动，恢复全量开放行为；保留 `transportx-tool-activation/v1` custom entries、Pi JSONL、Spatial/Citation 账本及成果。使用新会话或明确选择相应版本的计划，不通过删除记录或重跑业务回退。分阶段提交可供评审或反向提交；不 reset 用户数据。
