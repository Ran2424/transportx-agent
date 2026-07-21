# 数据模型与连接

## 查询命名空间

| 数据库 | 内容 |
|---|---|
| `catalog` | 数据字典、血缘、ID策略、指标、质量规则和查询样例 |
| `common` | 日期、时间、活动、场馆、天气、CRS和统一空间索引 |
| `road` | 道路状态事件与小时持续时间 |
| `metro` | 统一线路、高德方向线路、物理站点、站序和客流 |
| `bus` | 官方线路、高德方向线路、来源站点、站序和客流 |
| `ridehail` | 上下车事件、场馆订单和15分钟指标 |

`scripts/query_assets.py` 会挂载全部命名空间。SQL 始终使用 `database.table`。

## 对象层次

| 前缀 | 语义 | 默认用途 |
|---|---|---|
| `dim_*` | 统一实体和公共维度 | 名称、属性、统一ID |
| `map_*` | 源ID到统一ID映射 | 源系统连接与审计 |
| `bridge_*` | 多对多、站序和关系粒度空间属性 | 网络拓扑、线路制图 |
| `std_*` | 接纳后的标准记录 | 血缘、重复和质量审计 |
| `fact_*` | 通过默认治理规则的事实 | 明细分析首选 |
| `mart_*` | 预聚合指标 | 趋势与高峰分析 |
| `ops_*`、`quality_*`、`meta_*` | 采集、质量和目录 | 资产审计 |

## Catalog

| 对象 | 用途 |
|---|---|
| `catalog.meta_table`、`meta_column` | 表与字段字典 |
| `catalog.meta_source_dataset`、`meta_source_extract_sql` | 来源文件、粒度、行数和抽取SQL |
| `catalog.meta_entity_id`、`meta_id_mapping` | 统一ID策略和源ID映射 |
| `catalog.meta_relationship` | 跨对象关系 |
| `catalog.meta_metric` | 机器可读指标口径 |
| `catalog.meta_quality_rule`、`meta_quality_result` | 质量规则与最近构建结果 |
| `catalog.meta_query_example` | 已验证查询样例 |

## Metro

| 对象 | 粒度 | 主键或连接键 | 用途 |
|---|---|---|---|
| `metro.dim_metro_line` | 统一线路 | `line_id` | 稳定线路ID和WGS84聚合几何 |
| `metro.dim_metro_route_direction` | 高德方向/支线 | `route_direction_id`、`line_id` | 保留方向、支线、原始与标准几何 |
| `metro.dim_metro_station` | 物理站点 | `station_id` | 统一物理实体；换乘站只保留一个实体 |
| `metro.map_metro_amap_station` | 高德站点映射 | `source_station_id`、`station_id` | 高德ID到物理站ID |
| `metro.bridge_metro_route_station` | 方向线路-站序 | `route_direction_id`、`station_id`、`stop_sequence` | 方向站序和路线级点位 |
| `metro.bridge_metro_line_station` | 统一线路-物理站 | `line_id`、`station_id` | 统一线路上下文点位 |
| `metro.std_metro_station_hour` | 日期-小时-源线路-源站点 | 源ID、`date_key`、`hour` | 全量接纳与映射审计 |
| `metro.fact_metro_station_hour` | 日期-小时-统一线路-物理站 | `date_key`、`hour`、`line_id`、`station_id` | 默认进出站客流 |
| `metro.mart_metro_station_day` | 日期-统一线路-物理站 | `date_key`、`line_id`、`station_id` | 日客流与高峰小时 |

高德方向线路ID不是统一 `line_id`。5、10、11号线存在多组方向或支线路径，必须通过映射连接。

## Bus

| 对象 | 粒度 | 主键或连接键 | 用途 |
|---|---|---|---|
| `bus.dim_bus_line` | 官方线路 | `line_key` | 公交客流统一线路维度 |
| `bus.dim_bus_route_direction` | 高德方向线路 | `route_direction_key`、`line_key` | WGS84方向几何 |
| `bus.dim_bus_stop` | 来源系统-站点 | `stop_key` | `OFFICIAL:`、`AMAP:`前缀避免未经验证的合并 |
| `bus.bridge_bus_line_stop` | 官方线路或高德方向-站序 | `line_key`/`route_direction_key`、`stop_key` | 官方与高德站序、关系级点位 |
| `bus.std_bus_line_30m` | 日期-半小时-源线路 | 源线路、`date_key`、`minute_key` | 客流映射审计 |
| `bus.fact_bus_line_30m` | 日期-半小时-官方线路 | `date_key`、`minute_key`、`line_key` | 默认上客交易事实 |
| `bus.mart_bus_line_day` | 日期-官方线路 | `date_key`、`line_key` | 日交易量和高峰时段 |

`bridge_bus_line_stop.relation_source` 区分 `AMAP` 和 `OFFICIAL`。不要把两种站序行数混为高德采集量。

## Common、Road 与 Weather

| 对象 | 粒度 | 连接键/限制 |
|---|---|---|
| `common.dim_date` | 日期 | `date_key`；2025-08-09至2025-08-31 |
| `common.dim_time` | 分钟 | `minute_key`；派生15/30分钟时段 |
| `common.dim_event` | 活动日期 | 只有4个日期，没有具体时刻 |
| `common.dim_geo_feature` | 空间对象 | `geo_key`；仅按各行CRS状态使用 |
| `common.fact_weather_observation` | 网格-观测时间 | `weather_grid_key`、`date_key`、`minute_key` |
| `common.mart_weather_grid_hour` | 网格-日期-小时 | 温度和滚动一小时累计降雨 |
| `road.dim_road_segment` | 发布段 | `segment_key`；源数据没有线路几何 |
| `road.fact_road_state_event` | 路段-状态时刻 | `FREE`、`CROWD`、`JAM` |
| `road.mart_road_segment_hour` | 路段-日期-小时 | 按小时切分状态持续秒数 |

## Ride-hailing 与 Venue Trips

| 对象 | 粒度 | 说明 |
|---|---|---|
| `ridehail.std_ridehail_event` | 订单事件 | 保留接纳记录、重复序号和CRS状态 |
| `ridehail.fact_ridehail_event` | 有效去重事件 | 默认上/下车事件事实 |
| `ridehail.mart_ridehail_event_15m` | 15分钟-事件类型 | 事件数和空间聚合 |
| `ridehail.std_venue_trip` | 场馆关联订单 | 保留接纳记录和质量状态 |
| `ridehail.fact_venue_trip` | 有效去重场馆订单 | 到场/离场默认事实 |
| `ridehail.mart_venue_trip_15m` | 15分钟-方向 | `TO_VENUE`、`FROM_VENUE` |

订单号仅存 `order_hash`。未知CRS或无效坐标的处理见 `governance.md`。

## 连接规则

- 日期事实通过 `date_key` 连接 `common.dim_date`。
- 分钟事实通过 `minute_key` 连接 `common.dim_time`；小时事实直接使用 `hour`。
- 轨交客流只通过统一 `line_id`、`station_id` 连接维表。
- 公交客流只通过 `line_key` 连接官方线路维表。
- 源ID审计查询 `catalog.meta_id_mapping` 或相应 `map_*` 表。
- 地理实体通过 `geo_key` 连接 `common.dim_geo_feature`，但连接不代表CRS自动兼容。
