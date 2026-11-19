---
name: service-stress-test
description: 使用城市服务韧性模块比较扰动前后服务可达性、容量缺口和候选方案，并保留来源与假设。
---

# 城市服务压力测试

1. 明确分析范围、决策问题和数据日期。将获准使用的输入保存到任务目录，使用相对路径。默认案例 `examples/east-bridge.exercise.json` 是合成演练。通过 `manage_capabilities` 启用 `com.transportx.service-resilience`。
2. 用 `resilience_import {kind:'osm-overpass',sourcePath,speedKph,mode:'road'}` 导入路网，或用 `resilience_import {kind:'field-survey',sourcePath,columns}` 导入 CSV。`columns` 需映射 `observationId`、`objectId`、`periodId`、`value` 和 `source`。检查时段、坐标和单位，记录假设车速、道路排除情况及转向限制的覆盖范围。
3. 用 `resilience_align {casePath?,observationPath}` 检查对象和时段是否匹配。将未知对象和时段交由人复核，再准备有来源的案例。案例可内嵌 `nodes` 和 `edges`，或通过 `networkPath` 引用导入的网络。结构和限制见模块根目录的 `README.md`。
4. 对 GeoJSON 中断事件，用 `resilience_align_events` 对照案例和带时区的时段表。只将经过人复核、全时段覆盖且对象 ID 精确的事件交给 `resilience_compare_plans`。对空间歧义、部分时间覆盖和加权时段，保留待复核状态。
5. 用 `resilience_compare_plans` 冻结情景并比较方案，记录方案文件、核准事件和证据哈希。用返回的 `files.case.path` 调用 `resilience_accessibility`，查看同一情景下按出行方式和时间阈值的通路。已有结构化案例也可直接用 `resilience_pressure_test` 比较。
6. 区分不可达、容量不足和优先需求缺口。累加结果是按时段加权的需求人次。同一人可多次计入。标明有向路网、固定出行时间、服务容量和有效的中断约束。
7. 用 `publish_geodata` 和 `present_visualization` 打开地图，用 `canvas_present` 打开报告和表格。用 `tau_resolve_citation` 登记需要引用的原件或成果。交付记录应列出来源、覆盖、时段、假设、排除数量和证据文件，将演练和观测来源标明。

入口 `/resilience-workflow` 运行从事件到复核的演练。`/resilience-run <工作区相对案例路径>` 直接分析指定案例。超过输入大小、网络规模或案例工作量限制时缩小范围并报告。
