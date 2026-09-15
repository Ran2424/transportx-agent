# 表结构与连接

## 维度表

### `metro_line`

一行一条轨道交通线路。

| 字段 | 含义 |
|---|---|
| `line_id` | 线路标识，主键 |
| `line_name` | 线路名称，唯一 |

### `metro_station`

一行一个物理轨道交通站点。

| 字段 | 含义 |
|---|---|
| `station_id` | 站点标识，主键 |
| `station_name` | 站点名称，唯一且不含“站”后缀 |

### `bus_line`

一行一条统一公交线路。

| 字段 | 含义 |
|---|---|
| `bus_line_id` | 公交线路标识，主键 |
| `line_name` | 公交线路名称；名称不保证唯一 |

### `grid`

一行一个 GeoHash 7 网格。

| 字段 | 含义 |
|---|---|
| `geohash` | 七位 GeoHash，主键 |

## 事实表

### `metro_flow_hour`

粒度为日期 × 小时 × 线路 × 物理站点。

| 字段 | 含义 |
|---|---|
| `stat_date` | 业务日期 |
| `stat_hour` | 小时，0—23 |
| `line_id` | 线路标识 |
| `station_id` | 物理站点标识 |
| `entry_flow` | 进站量 |
| `exit_flow` | 出站量 |

主键为 `(stat_date, stat_hour, line_id, station_id)`。同一换乘站可以在同一小时出现多条线路记录；物理站分析按 `station_id` 汇总，线路分析按 `line_id` 汇总。

### `bus_flow_hour`

粒度为日期 × 小时 × 公交线路。

| 字段 | 含义 |
|---|---|
| `stat_date` | 业务日期 |
| `stat_hour` | 小时，0—23 |
| `bus_line_id` | 公交线路标识 |
| `passenger_flow` | 公交客流量 |

主键为 `(stat_date, stat_hour, bus_line_id)`。

### `grid_flow_hour`

粒度为日期 × 小时 × 网格。五种网格指标分列保存。

| 字段 | 含义 |
|---|---|
| `stat_date` | 业务日期 |
| `stat_hour` | 小时，0—23 |
| `geohash` | GeoHash 7 网格 |
| `taxi_pickups` | 出租车上车量 |
| `taxi_dropoffs` | 出租车下车完单量 |
| `ridehail_orders` | 网约车下单量 |
| `ridehail_dropoffs` | 网约车下车完单量 |
| `bike_locks` | 共享单车锁车量 |

主键为 `(stat_date, stat_hour, geohash)`。指标列允许为 `NULL`，但每行至少有一项指标存在观测。

## 空间关系表

| 表 | 粒度 | 字段 |
|---|---|---|
| `metro_grid_distance` | 地铁站 × 1,000 米内网格 | `station_id`, `geohash`, `distance_m` |
| `metro_bus_line_distance` | 地铁站 × 1,000 米内公交线路 | `station_id`, `bus_line_id`, `distance_m` |
| `metro_station_distance` | 地铁站 × 2,000 米内其他地铁站 | `station_id`, `nearby_station_id`, `distance_m` |

## 连接关系

- `metro_flow_hour.line_id` → `metro_line.line_id`。
- `metro_flow_hour.station_id` → `metro_station.station_id`。
- `bus_flow_hour.bus_line_id` → `bus_line.bus_line_id`。
- `grid_flow_hour.geohash` → `grid.geohash`。
- 三张距离表通过相应实体标识连接维度表。
- 不同事实表先各自聚合到目标粒度，再连接共同的小时、网格或实体；直接连接明细事实可能产生多对多放大。
