# 指标与业务聚合

机器可读口径以 `catalog.meta_metric` 为准。

| 指标代码 | 中文名称 | 粒度 | 单位 | 计算口径 |
|---|---|---|---|---|
| `ROAD_JAM_MINUTES` | 道路严重拥堵分钟数 | 路段—日期—小时 | 分钟 | `jam_seconds / 60.0` |
| `ROAD_CROWD_MINUTES` | 道路拥挤分钟数 | 路段—日期—小时 | 分钟 | `crowd_seconds / 60.0` |
| `METRO_INBOUND` | 轨交进站客流 | 站点—小时 | 人次 | `SUM(inbound_flow)` |
| `METRO_OUTBOUND` | 轨交出站客流 | 站点—小时 | 人次 | `SUM(outbound_flow)` |
| `BUS_BOARDINGS` | 公交上客交易数 | 线路—半小时 | 笔 | `SUM(bus_boarding_transactions)` |
| `RIDEHAIL_EVENTS` | 原始网约车上下车事件数 | 15分钟—事件类型 | 次 | `SUM(source_event_count)` |
| `TRIP_ENDPOINTS` | 统一订单上下车端点数 | 15分钟—端点类型 | 次 | `SUM(event_count)` |
| `VENUE_TRIPS` | 场馆到离场事件数 | 15分钟—方向 | 次 | `SUM(trip_count)` |
| `RAIN_1H_MAX` | 一小时累计降雨最大值 | 网格—小时 | 毫米 | `MAX(max_rainfall_1h_mm)` |

## 订单、事件和场馆方向

- 唯一订单数：`COUNT(*) FROM ridehail.fact_trip`。
- 场馆关联唯一订单数：`COUNT(*) FROM ridehail.fact_venue_trip`。
- 原始上/下车事件：端点集市的 `source_event_count`。
- 场馆完整订单补齐端点：`venue_enriched_event_count`。
- 全部统一订单端点：`event_count`。
- 场馆到场：`TO_VENUE` 的下车时刻。
- 场馆离场：`FROM_VENUE` 的上车时刻。
- `BOTH` 订单会生成一条到场事件和一条离场事件，但仍是一笔订单。

因此 `VENUE_TRIPS` 当前名称沿用既有指标代码，实际度量是“到场/离场业务事件数”。需要唯一订单时必须查询 `fact_venue_trip`。

## 可用业务层

| 领域 | 细粒度 | 小时 | 日 |
|---|---|---|---|
| 公交 | `fact_bus_line_30m` | `mart_bus_line_hour` | `mart_bus_line_day` |
| 轨交 | `fact_metro_station_hour` | 原始事实已是小时 | `mart_metro_station_day` |
| 道路 | `fact_road_state_event` | `mart_road_segment_hour` | `mart_road_segment_day` |
| 天气 | `fact_weather_observation` | `mart_weather_grid_hour` | `mart_weather_grid_day` |
| 订单端点 | `fact_ridehail_event` | `mart_ridehail_event_hour` | `mart_ridehail_event_day` |
| 场馆事件 | `fact_venue_event` | `mart_venue_trip_hour` | `mart_venue_trip_day` |

订单和场馆还提供 15 分钟集市。

## 口径限制

- 公交交易、轨交人次、网约车事件、端点和订单量纲不同，只能并列比较趋势。
- `inbound_flow + outbound_flow` 不是去重乘客数。
- 道路状态为逢变更新。持续时间由相邻事件推导；每段最后一个状态没有结束时刻，不计入持续时间。
- `rainfall_1h_mm` 是滚动一小时累计值，不对10分钟记录求和。
- 缺失时段表示未观测，不能自动补零。
- 空间聚合只使用 `crs='EPSG:4326'`；需要时按 `coordinate_status` 排除总体假设记录。

## 推荐查询顺序

1. `--coverage` 确认范围和粒度。
2. `--metrics` 确认指标和单位。
3. `--business` 选择最接近问题粒度的集市。
4. 只有集市无法回答时才查询 `fact_*`。
5. 输出中写明时间范围、对象覆盖、单位、CRS 和端点来源口径。
