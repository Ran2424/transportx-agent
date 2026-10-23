# Module 工具按需启用验收

2026-10-23；平台 3.23.2 未发布；Pi 0.80.10；基线 e4b6546。

## P0：真实 Pi 机制

`node scripts/tool-activation-smoke.mjs` 已通过。真实 Pi RPC 进程加载生产 Tool Activation 与 Geo Extension，受控 HTTP Provider 捕获实际 tools 字段；没有 fake Pi。首次请求及 discover/inspect/status 后均严格为 read/write/edit/bash/manage_capabilities，Schema 3664 字节。enable Geo 后同一 Agent 任务的下一次请求为 10 工具、11388 字节，实际 publish_geodata 成功。重复 enable 只有一条启用记录。

reload 后首个请求、跨进程恢复、原生压缩后均保留 10 工具；导航到启用前分支和 fork 到启用前均恢复五工具，回到原分支恢复 10 工具。恢复后 publish_geodata 历史只有一次，没有重放。

唯一持久来源是 Pi custom entry `transportx-tool-activation/v1`：assembly 记录初始化 Module 身份及成员，enable 记录成功开放意图。assembly 与 enable 都沿有效分支读取，不依赖压缩摘要。保存成员快照是为在 reload/resume 核对漂移，不是第二份工具 Registry，不保存 Schema 或 execute。Host 仅向 Pi 注入已核验计划内的模块身份、入口、展示/Skill 摘要和契约文件路径；实际工具来源通过 realpath 精确比较。当前环境尚未验证新协调器的 asar 包与 Windows 安装器。

受控 Provider 只证明真实 Pi 的请求与执行行为；真实模型自主选择、生产 Host 与独立安装包由后续阶段单独记录。
