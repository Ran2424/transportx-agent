---
name: decision-investigation
description: 对城市服务扰动的不确定状态比较候选调查，解释决策窗口、最大后悔和条件方案。
---

# 决策调查排序

1. 核实候选状态、方案、调查结果和决策时限。默认演练 `examples/east-bridge.exercise.json` 使用合成数据。通过 `manage_capabilities` 启用 `com.transportx.service-resilience`。
2. 现场 CSV 先用 `resilience_import` 导入，再用 `resilience_align` 查看对象、时段、来源和未知项。由人确认观测后显式更新案例。输入路径相对于当前任务目录。
3. 用 `resilience_investigate {casePath?}` 评估调查，或者传入 `sweep` 扫描一个道路耗时或服务容量。用 `resilience_pressure_test` 回查情景结果和地图。单变量扫描以试算点及相邻区间报告变化，联合变化需要明列状态。
4. 报告立即可选方案、到期前可用调查、其条件方案、剩余歧义和执行期限。调查耗时与方案准备耗时一起计入期限。按优先缺口再按总缺口解释最坏后悔值。两项按同一顺序联合比较，方案 ID 用于同分决胜。
5. 把调查排序解释为在案例假设下的选择。核对状态覆盖、观测可靠性、准备时间和实际获取成本后，交由负责人判断是否等待。报告输入的版本和证据位置。用 `canvas_present` 打开报告，用 `tau_resolve_citation` 登记证据。
