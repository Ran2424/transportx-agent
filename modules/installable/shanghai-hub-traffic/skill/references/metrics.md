# 指标口径

| 指标 | 单位 | 推荐对象 | 口径 |
|---|---|---|---|
| 铁路到达人数 | 人次 | `rail.mart_train_hub_halfhour/day` | `SUM(GET_OFF)`，按采用到站时刻 |
| 铁路出发人数 | 人次 | `rail.mart_train_hub_halfhour/day` | `SUM(GET_ON)`，按采用离站时刻 |
| 地铁进/出站 | 人次 | `rail.fact_metro_station_flow_day` | 源日值；总量等于进站加出站 |
| 到达预测 | 人次 | `forecast.fact_arrival_forecast_version` | 指定目标小时和发布时间版本 |
| 疏散比例 | 比例 | `forecast.fact_evac_mode_ratio_version` | 先检查完整方式数和比例和 |
| 功能点观测值 | 未确认 | `hubops.fact_site_flow_observation` | 保留 `INNUM`/`TRAFFICNUM` 原指标，不跨时点盲目求和 |
| 在蓄车辆 | 辆 | `hubops.fact_taxi_yard_state` | `current_vehicle_count` |
| 蓄车等客时间 | 分钟 | `hubops.fact_taxi_yard_state` | 源 `AVG_WAITING_TIME`，不能解释为旅客等待 |
| 网约车当前需求 | 辆 | `ridehail.fact_ridehail_demand_snapshot` | 源 `CNT` |
| 网约车窗口订单 | 单 | `ridehail.fact_ridehail_order_window` | 3/5/10 分钟源窗口，窗口类型未确认 |
| 撮合率 | 比例 | `ridehail.fact_ridehail_match_snapshot` | `MATCH_ORDERS / IDENTIFIED_ORDERS` 的源结果 |
| 创建到匹配耗时 | 分钟 | 同上 | 平均值和中位值分别使用对应源字段 |

公交、地铁、铁路上下客、网约车需求和订单是不同量纲，不得相加为“综合客流”。
