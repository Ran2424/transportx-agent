# 数据资产模型

## 分库与查询命名空间

| 数据库 | 内容 |
|---|---|
| `catalog` | 数据字典、血缘、实体ID、指标、质量规则与查询样例 |
| `common` | 日期、时间、活动、场馆、天气、坐标系和统一空间索引 |
| `road` | 道路状态事件与小时持续时间 |
| `metro` | 统一线路、高德方向线路、物理站点、线路站序与客流 |
| `bus` | 官方线路、高德方向线路、站点、线路站序与客流 |
| `ridehail` | 上下车事件、场馆订单与15分钟指标 |

`scripts/query_assets.py` 同时挂载以上六个命名空间，SQL 使用 `database.table`。

## 坐标字段约定

公交和轨交标准空间字段统一为 EPSG:4326：

- `longitude`、`latitude`、`geometry_json`：WGS84经纬度。
- `normalized_crs`：有标准空间值时为 `EPSG:4326`。
- `source_x`、`source_y`、`source_geometry_json`：原始源坐标或几何。
- `source_crs`：原始坐标系，例如 `GCJ-02` 或 `EPSG:32651`。
- `distance_to_route_m`、`distance_to_line_m`：WGS84对象投影到 EPSG:32651 后计算的米制点线距离。

未知坐标系的场馆、天气、网约车或支付订单不会被推断为WGS84。

## 轨交模型

| 对象 | 粒度 | 关键字段/用途 |
|---|---|---|
| `metro.dim_metro_line` | 统一线路 | `line_id`；20条稳定线路ID，几何来自高德方向线路并转为WGS84 |
| `metro.dim_metro_route_direction` | 高德方向或支线路径 | `route_direction_id`；保留高德线路ID、方向、支线、源几何和WGS84几何 |
| `metro.dim_metro_station` | 物理站点 | `station_id`；保留旧ID并追加新站，标准点位为WGS84 |
| `metro.map_metro_amap_station` | 高德站点ID映射 | `source_station_id` → `station_id`，记录方法和置信度 |
| `metro.bridge_metro_route_station` | 方向线路-站序 | 路线级站点坐标、序号和 `distance_to_route_m` |
| `metro.bridge_metro_line_station` | 统一线路-物理站点 | 线路上下文WGS84点和 `distance_to_line_m` |
| `metro.ops_metro_station_coordinate_quality` | 物理站点 | 坐标来源与缺失状态 |
| `metro.ops_metro_collection_report` | 统一线路 | 高德检索状态与方向数 |
| `metro.fact_metro_station_hour` | 日期-小时-线路-站点 | 通过维度映射的进出站客流 |
| `metro.mart_metro_station_day` | 日期-线路-站点 | 日客流和高峰小时 |

高德 `line_id` 是方向线路ID，不能直接替代统一 `line_id`。5、10、11号线包含多组方向/支线路径。路线制图优先使用 `bridge_metro_route_station`；物理站分布使用 `dim_metro_station`。

## 公交模型

| 对象 | 粒度 | 关键字段/用途 |
|---|---|---|
| `bus.dim_bus_line` | 官方线路 | `line_key`；公交客流的统一线路维度 |
| `bus.dim_bus_route_direction` | 高德方向线路 | `route_direction_key`；源GCJ‑02几何和标准WGS84几何 |
| `bus.dim_bus_stop` | 来源系统-站点 | `stop_key`；`OFFICIAL:`、`AMAP:`前缀避免错误合并 |
| `bus.bridge_bus_line_stop` | 线路/方向-站序 | 路线级站点坐标和 `distance_to_route_m` |
| `bus.fact_bus_line_30m` | 日期-半小时-官方线路 | 通过线路映射的客流事实 |
| `bus.mart_bus_line_day` | 日期-官方线路 | 日客流和高峰时段 |

同一高德公交 `stop_id` 在不同方向线路中可能返回不同坐标，因此路线制图使用 `bridge_bus_line_stop.longitude/latitude`，不要用主站点坐标替代全部停靠点。

## 公共、道路和天气

| 对象 | 粒度 | 说明 |
|---|---|---|
| `common.dim_date` | 日期 | 2025-08-09至2025-08-31 |
| `common.dim_time` | 分钟 | 0–1439及15/30分钟时段 |
| `common.dim_event` | 活动日期 | 4条用户提供的日期级记录，具体时刻未知 |
| `common.dim_geo_feature` | 空间实体 | 公交和轨交对象使用WGS84标准几何；其他领域遵循各自CRS状态 |
| `common.fact_weather_observation` | 网格-观测时间 | 通过质量校验的气象观测 |
| `common.mart_weather_grid_hour` | 网格-日期-小时 | 温度及滚动一小时累计降雨统计 |
| `road.dim_road_segment` | 发布段 | 源数据无几何，不得推断空间位置 |
| `road.fact_road_state_event` | 路段-状态时刻 | `FREE`、`CROWD`、`JAM`状态事件 |
| `road.mart_road_segment_hour` | 路段-日期-小时 | 按小时切分的状态持续秒数 |

## 网约车与场馆订单

`ridehail.fact_ridehail_event` 和 `ridehail.fact_venue_trip` 是去重、排除删除或无效坐标后的默认事实入口。订单号仅以 `order_hash` 保存。支付订单和部分事件的坐标系未知，不得与WGS84公交、轨交做高精度空间叠加。

## 连接原则

- 日期：事实表通过 `date_key` 连接 `common.dim_date`。
- 时间：分钟事实通过 `minute_key` 连接 `common.dim_time`；小时事实使用 `hour`。
- 轨交客流：只通过统一 `line_id`、`station_id` 连接。
- 轨交源ID：查询 `catalog.meta_id_mapping` 或 `metro.map_metro_amap_station`。
- 地理：业务维表的 `geo_key` 连接 `common.dim_geo_feature.geo_key`。
