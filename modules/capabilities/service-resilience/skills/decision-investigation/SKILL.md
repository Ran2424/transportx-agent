---
name: decision-investigation
description: 对城市服务扰动的不确定状态比较候选调查，解释决策窗口、最大后悔和条件方案。
---

# 决策调查排序

1. 核实候选状态、方案、调查结果和决策时限。默认演练 `examples/east-bridge.exercise.json` 使用合成数据。通过 `manage_capabilities` 启用 `com.transportx.service-resilience`。
2. 现场 CSV 先用 `resilience_import` 导入，再用 `resilience_align` 查看对象、时段、来源和未知项。由人确认观测后显式更新案例。输入路径相对于当前任务目录。
3. 用 `resilience_sensitivity` 指定时段、因素组合和服务缺口底线，检查方案翻转、可行性、目标取舍与联合失效。按试算点和相邻区间表述。把候选问题补成含来源、返回时间、成本和条件行动的调查设计。用 `resilience_investigate {casePath?}` 评估这些已定义调查，用压力测试复查对应结果。
4. 报告立即可选方案、到期前可用调查、其条件方案、剩余歧义和执行期限。调查耗时与方案准备耗时一起计入期限。按优先缺口再按总缺口解释最坏后悔值。两项按同一顺序联合比较，方案 ID 用于同分决胜。
5. 把调查排序解释为在案例假设下的选择。核对状态覆盖、观测可靠性、准备时间和实际获取成本后，交由负责人判断是否等待。报告输入的版本和证据位置。用 `canvas_present` 打开报告，用 `tau_resolve_citation` 登记证据。
6. 观测返回后，复核对象、有效时段和来源，用 `resilience_compare_plans` 将经过确认的事件绑定到目标状态。以派生案例重算可达性与敏感性，记录新结果是否改变决定。
