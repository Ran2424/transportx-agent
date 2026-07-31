# PROJECT-METRIC-DEFINITIONS 抽查样本

## PROJECT-METRIC-DEFINITIONS@sec-0001

- 标题：指标口径
- 来源定位：[{"pdf_page": null, "printed_page": null, "bbox": null, "quote": "权威机器可读口径位于 `catalog.meta_metric`。分析时优先使用下列指标，不临时发明同名不同义指标。\n\n| 指标代码 | 中文名称 | 粒度 | 单位 | 计算口径 |\n|---|---|---|---|---|\n| `ROAD_JAM_MINUTES` | 道路严重拥堵分钟数 | 路段-日期-小时 |", "source_unit": "PROJECT-METRIC-DEFINITIONS@src-0001", "line_start": 1, "line_end": 15}]

权威机器可读口径位于 `catalog.meta_metric`。分析时优先使用下列指标，不临时发明同名不同义指标。

| 指标代码 | 中文名称 | 粒度 | 单位 | 计算口径 |
|---|---|---|---|---|
| `ROAD_JAM_MINUTES` | 道路严重拥堵分钟数 | 路段-日期-小时 | 分钟 | `jam_seconds / 60.0` |
| `ROAD_CROWD_MINUTES` | 道路拥挤分钟数 | 路段-日期-小时 | 分钟 | `crowd_seconds / 60.0` |
| `METRO_INBOUND` | 轨交进站客流 | 站点-小时 | 人次 | `SUM(inbound_flow)` |
| `METRO_OUTBOUND` | 轨交出站客流 | 站点-小时 | 人次 | `SUM(outbound_flow)` |
| `BUS_BOARDINGS` | 公交上客交易数 | 线路-半小时 | 笔 | `SUM(bus_boarding_transactions)` |
| `RIDEHAIL_EVENTS` | 网约车上下车事件数 | 15分钟-事件类型 | 单 | `SUM(event_count)` |
| `VENUE_TRIPS` | 场馆到离场订单数 | 15分钟-方向 | 单 | `SUM(trip_count)` |
| `RAIN_1H_MAX` | 一小时累计降雨最大值 | 网格-小时 | 毫米 | `MAX(max_rainfall_1h_mm)` |

## PROJECT-METRIC-DEFINITIONS@sec-0002

- 标题：口径限制
- 来源定位：[{"pdf_page": null, "printed_page": null, "bbox": null, "quote": "- 公交“交易数”、轨交“人次”和网约车“订单/事件”量纲不同，只能并列比较趋势，不能直接求和。\n- 道路状态是逢变更新数据。持续时间由相邻事件推导；每个路段最后一条状态没有结束时间，不计入持续时长。\n- `RAIN_1H_MAX` 使用滚动一小时累计降雨最大值。对10分钟记录求和会重复累计。\n- 场馆到场使用 `TO", "source_unit": "PROJECT-METRIC-DEFINITIONS@src-0002", "line_start": 16, "line_end": 22}]

- 公交“交易数”、轨交“人次”和网约车“订单/事件”量纲不同，只能并列比较趋势，不能直接求和。
- 道路状态是逢变更新数据。持续时间由相邻事件推导；每个路段最后一条状态没有结束时间，不计入持续时长。
- `RAIN_1H_MAX` 使用滚动一小时累计降雨最大值。对10分钟记录求和会重复累计。
- 场馆到场使用 `TO_VENUE` 的下车时刻；场馆离场使用 `FROM_VENUE` 的上车时刻。
- 默认指标基于 `fact_*` 或 `mart_*`，已排除逻辑删除和同源重复订单。
