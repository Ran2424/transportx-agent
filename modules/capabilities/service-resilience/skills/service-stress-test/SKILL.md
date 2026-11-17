---
name: service-stress-test
description: 使用城市服务韧性模块比较扰动前后服务可达性、容量缺口和候选方案，并保留来源与假设。
---

# 城市服务压力测试

1. 明确分析范围、决策问题和数据日期。将获准使用的输入保存到任务目录，使用相对路径。默认案例 `examples/east-bridge.exercise.json` 是合成演练。通过 `manage_capabilities` 启用 `com.transportx.service-resilience`。
2. 用 `resilience_import {kind:'osm-overpass',sourcePath,speedKph,mode:'road'}` 导入路网，或用 `resilience_import {kind:'field-survey',sourcePath,columns}` 导入 CSV。`columns` 需映射 `observationId`、`objectId`、`periodId`、`value` 和 `source`。检查时段、坐标和单位，记录假设车速、道路排除情况及转向限制的覆盖范围。
3. 用 `resilience_align {casePath?,observationPath}` 检查对象和时段是否匹配。将未知对象和时段交由人复核，再准备有来源的案例。案例可内嵌 `nodes` 和 `edges`，或通过 `networkPath` 引用导入的网络。结构和限制见模块根目录的 `README.md`。
4. 用 `resilience_pressure_test {casePath?,stateId?,planId?,periodId?}` 运行全部方案比较。省略 `casePath` 时使用演练。地图使用指定的单个状态、方案和时段，筛选 ID 来自案例。
5. 区分不可达、容量不足和优先需求缺口。累加结果是按时段加权的需求人次。同一人可多次计入。标明有向路网、固定出行时间、服务容量和有效的中断约束。
6. 用 `publish_geodata` 和 `present_visualization` 打开地图，用 `canvas_present` 打开报告和表格。用 `tau_resolve_citation` 登记需要引用的原件或成果。交付记录应列出来源、覆盖、时段、假设、排除数量和证据文件，将演练和观测来源标明。

入口 `/resilience-demo` 运行演练，`/resilience-run <工作区相对案例路径>` 运行指定案例。超过输入大小、网络规模或案例工作量限制时缩小范围并报告，不绕过校验。
