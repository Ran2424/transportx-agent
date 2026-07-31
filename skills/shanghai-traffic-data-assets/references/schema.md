# 数据模型、粒度与连接

本文件说明整体模型和跨库连接。需要完整字段、行数、限制和查询样例时，按领域读取 `catalog.md`、`common.md`、`road.md`、`metro.md`、`bus.md` 或 `ridehail.md`。

## 导航

- [查询命名空间与分层](#查询命名空间)
- [订单域](#订单域只保留一份订单)
- [公交](#公交)
- [轨交](#轨交)
- [道路、天气与公共维度](#道路天气与公共维度)
- [Catalog](#catalog)
- [连接规则](#连接规则)

## 查询命名空间

| 数据库 | 内容 |
|---|---|
| `catalog` | 目录、覆盖、来源关系、ID、指标、质量和样例 |
| `common` | 日期、时间、活动、场馆、天气、CRS和空间索引 |
| `road` | 道路状态事件、小时和日持续时间 |
| `metro` | 线路、方向、物理站、站序、小时和日客流 |
| `bus` | 官方线路、方向、来源站点、站序、半小时/小时/日客流 |
| `ridehail` | 单一订单事实、上下车端点、场馆事件和多时间粒度集市 |

## 分层含义

| 前缀 | 粒度定位 | 默认用途 |
|---|---|---|
| `dim_*` | 一个统一实体或公共维度值 | 名称、属性、统一 ID |
| `map_*` | 一个源 ID 到统一 ID 的映射 | 接入与审计 |
| `bridge_*` | 一条多对多关系或线路站序 | 拓扑和线路上下文 |
| `std_*` | 全量接纳后的标准记录 | 来源、重复、质量审计 |
| `fact_*` | 通过默认质量规则的明细 | 明细分析 |
| `mart_*` | 固定粒度预聚合 | 趋势、对比、高峰 |
| `ops_*`、`quality_*`、`meta_*` | 采集和治理记录 | 资产审计 |

## 订单域：只保留一份订单

### 对象

| 对象 | 粒度 | 关键字段 | 用途 |
|---|---|---|---|
| `ridehail.std_trip` | 一个四源订单并集中的订单 | `trip_key`、`order_hash` | 唯一存储的订单标准层 |
| `ridehail.fact_trip` | 一个有效完整或部分订单 | `trip_key`、`order_hash` | 订单数、OD、时长 |
| `ridehail.fact_ridehail_event` | 一个上车或下车端点 | `event_key`、`trip_key` | 端点时空分析 |
| `ridehail.fact_venue_trip` | 一个有效场馆关联订单 | `trip_key` | `fact_trip` 的筛选视图 |
| `ridehail.fact_venue_event` | 一次场馆到场或离场事件 | `trip_key`、`venue_relation` | 场馆方向与发生时刻 |
| `ridehail.mart_ridehail_event_15m/hour/day` | 时段—端点类型 | 时间键、`event_type` | 端点趋势 |
| `ridehail.mart_venue_trip_15m/hour/day` | 时段—场馆方向 | 时间键、`venue_relation` | 到场/离场趋势 |

### `fact_trip` 代表字段

| 字段 | 含义 |
|---|---|
| `source_coverage` | `RHD` 上车、`RHA` 下车、`PFV` 场馆离场、`PTV` 场馆到场的组合 |
| `venue_relation` | `NONE`、`TO_VENUE`、`FROM_VENUE`、`BOTH` |
| `venue_source_conflict` | 两个场馆完整订单源核心字段是否冲突；冲突时 PFV 为优先值 |
| `pickup_at`、`dropoff_at` | Asia/Shanghai 本地时间 |
| `pickup_date_key`、`dropoff_date_key` | 端点日期 |
| `pickup_minute_key`、`dropoff_minute_key` | 端点日内分钟 |
| `pickup_longitude/latitude` | 发布坐标；`pickup_crs` 为 EPSG:4326 时可做空间分析 |
| `dropoff_longitude/latitude` | 发布坐标；`dropoff_crs` 为 EPSG:4326 时可做空间分析 |
| `*_coordinate_status` | CRS 的直接、回连推断、总体假设或未知依据 |
| `trip_duration_seconds` | 下车时间减上车时间 |
| `source_duplicate_count` | 四类源中被折叠的重复行数 |
| `quality_status` | `OK`、`PARTIAL_TRIP`、`UNKNOWN_CRS` 等 |

### 事件口径

`fact_ridehail_event.endpoint_source`：

- `RIDEHAIL_SOURCE`：该端点来自原始上车表或下车表；
- `VENUE_ENRICHMENT`：该端点由场馆完整订单补齐。

三个端点集市均满足：

```text
event_count = source_event_count + venue_enriched_event_count
```

统计原始网约车事件用 `source_event_count`；统计统一订单的全部时空端点用 `event_count`。统计订单数用 `fact_trip`，不能数端点。

## 公交

| 对象 | 粒度 | 主连接键 |
|---|---|---|
| `bus.dim_bus_line` | 一条官方线路 | `line_key` |
| `bus.dim_bus_route_direction` | 一条高德方向线路 | `route_direction_key` |
| `bus.dim_bus_stop` | 来源系统中的一个站点 | `stop_key` |
| `bus.bridge_bus_line_stop` | 线路/方向—站序 | `line_key` 或 `route_direction_key`、`stop_key` |
| `bus.fact_bus_line_30m` | 日期—半小时—官方线路 | `date_key`、`minute_key`、`line_key` |
| `bus.mart_bus_line_hour` | 日期—小时—官方线路 | `date_key`、`hour`、`line_key` |
| `bus.mart_bus_line_day` | 日期—官方线路 | `date_key`、`line_key` |

公交站点使用 `OFFICIAL:`、`AMAP:` 前缀。缺少可靠映射时，不按同名强行合并。

## 轨交

| 对象 | 粒度 | 主连接键 |
|---|---|---|
| `metro.dim_metro_line` | 一条统一线路 | `line_id` |
| `metro.dim_metro_route_direction` | 一条高德方向或支线路径 | `route_direction_id`、`line_id` |
| `metro.dim_metro_station` | 一个物理站 | `station_id` |
| `metro.bridge_metro_route_station` | 方向线路—站序 | `route_direction_id`、`station_id` |
| `metro.bridge_metro_line_station` | 统一线路—物理站 | `line_id`、`station_id` |
| `metro.fact_metro_station_hour` | 日期—小时—统一线路—物理站 | `date_key`、`hour`、`line_id`、`station_id` |
| `metro.mart_metro_station_day` | 日期—统一线路—物理站 | `date_key`、`line_id`、`station_id` |

高德方向 ID 不能替代统一 `line_id`。5、10、11号线有多条方向或支线路径。

## 道路、天气与公共维度

| 对象 | 粒度 | 查询提示 |
|---|---|---|
| `common.dim_date` | 一天 | 所有事实用 `date_key` 连接 |
| `common.dim_time` | 日内一分钟 | `minute_key` 0—1439 |
| `common.dim_event` | 一次活动日期 | 只有日期精度；案例时刻仅在SKILL说明中维护 |
| `common.dim_poi` | 一个重要交通枢纽 | 用户确认的 WGS84 火车站、机场中心点 |
| `common.fact_weather_observation` | 网格—观测时刻 | 温度、滚动一小时降雨 |
| `common.mart_weather_grid_hour` | 网格—日期—小时 | 小时跨域分析 |
| `common.mart_weather_grid_day` | 网格—日期 | 日天气概览 |
| `road.fact_road_state_event` | 发布段—状态变化时刻 | 逢变更新 |
| `road.mart_road_segment_hour` | 发布段—日期—小时 | 各状态精确持续秒数 |
| `road.mart_road_segment_day` | 发布段—日期 | 日状态持续时间 |
| `road.dim_evdata_road_segment` | 一个 EVDATA 路段 | `road_id`、WGS84 MultiLineString |
| `road.fact_evdata_road_speed_15m` | EVDATA 路段—15分钟时刻 | `road_id`、`date_key`、`minute_key` |

## Catalog

| 对象 | 用途 |
|---|---|
| `meta_build` | 版本、构建时间、标准 CRS、标准时区、源库哈希 |
| `meta_table`、`meta_column` | 表和技术字段字典 |
| `meta_source_dataset` | 源数据集、粒度、行数和目标 |
| `meta_order_source_relation` | 网约车与场馆订单并集、重叠率和解释 |
| `meta_analysis_guide` | 分域推荐对象、粒度、覆盖、CRS和限制 |
| `meta_entity_id`、`meta_id_mapping` | 统一 ID 策略和映射 |
| `meta_relationship` | 主要跨对象关系 |
| `meta_metric` | 机器可读指标口径 |
| `meta_quality_rule`、`meta_quality_result` | 质量规则和本次构建结果 |
| `meta_query_example` | 已验证 SQL 样例 |

## 连接规则

- 日期通过 `date_key` 连接 `common.dim_date`。
- 分钟事实通过 `minute_key` 连接 `common.dim_time`；小时事实用 `hour`。
- 轨交客流只用统一 `line_id`、`station_id`。
- 公交客流只用官方 `line_key`。
- 空间连接前两侧都必须满足 `crs='EPSG:4326'`。
- 跨领域同日并列比较时保留各自单位，不把人次、交易、事件和订单相加。
- EVDATA 使用独立 `road_id`；未建立权威映射前，不与原状态数据的 `segment_key`/`segment_id` 连接。
