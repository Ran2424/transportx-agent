# 指标口径

以 `catalog.meta_metric` 为机器可读权威。计算前先确认事实覆盖，指标定义不会把局部样本自动扩展为全市总量。

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

## 口径限制

- 公交“交易数”、轨交“人次”和网约车“订单/事件”量纲不同，只能并列比较趋势，不能直接求和。
- `metro.fact_metro_station_hour` 只覆盖10个所选站点；`bus.fact_bus_line_30m` 只覆盖75条已映射官方线路。聚合结果不是上海全市客流。
- `inbound_flow + outbound_flow` 是进出站记录之和，不等于去重乘客数，也不是换乘客流。
- 道路状态是逢变更新数据。持续时间由相邻事件推导；每个路段最后一条状态没有结束时间，不计入持续时长。
- `RAIN_1H_MAX` 使用滚动一小时累计降雨最大值。对10分钟记录求和会重复累计。
- 场馆到场使用 `TO_VENUE` 的下车时刻；场馆离场使用 `FROM_VENUE` 的上车时刻。
- 默认指标基于 `fact_*` 或 `mart_*`，已排除逻辑删除和同源重复订单。
- 跨域趋势通过 `date_key` 和规范化时间粒度并列连接；不要用不同粒度的原始时间字符串直接连接。

## 推荐查询顺序

1. 用 `--metrics` 读取机器口径。
2. 查询事实覆盖的日期、实体数和空值。
3. 按指标声明的粒度聚合。
4. 在结果标题或说明中写明覆盖对象和单位。
