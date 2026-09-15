# 场景—指标—数据关系

## 单领域运行

| 场景 | 指标 | 数据对象 |
|---|---|---|
| 地铁总量与小时变化 | 进站量、出站量 | `metro_flow_hour` |
| 地铁站点或线路比较 | 站点/线路进出站量 | `metro_flow_hour`, `metro_station`, `metro_line` |
| 公交总量与小时变化 | 公交客流量 | `bus_flow_hour` |
| 公交线路比较 | 线路客流量 | `bus_flow_hour`, `bus_line` |
| 出租车网格活动 | 上车量、下车完单量 | `grid_flow_hour`, `grid` |
| 网约车网格活动 | 下单量、下车完单量 | `grid_flow_hour`, `grid` |
| 共享单车网格活动 | 锁车量 | `grid_flow_hour`, `grid` |

## 多方式分析

| 场景 | 关系 | 数据对象 |
|---|---|---|
| 全市方式间比较 | 各方式独立汇总后并列 | 对应事实表 |
| 小时变化对齐 | 各事实先汇总到小时，再按 `stat_hour` 对齐 | `metro_flow_hour`, `bus_flow_hour`, `grid_flow_hour` |
| 网格多方式覆盖 | 同一 `geohash` 下各指标的观测集合 | `grid_flow_hour` |
| 网格热点比较 | 各指标在相同网格范围内分别聚合和排序 | `grid_flow_hour`, `grid` |

不同方式的总量用于并列、构成、时序或空间分布比较，不组成统一的“综合客流”。

## 站点周边分析

| 场景 | 空间关系 | 业务数据 |
|---|---|---|
| 地铁站周边网格 | `metro_grid_distance` | `grid_flow_hour` |
| 地铁站周边公交线路 | `metro_bus_line_distance` | `bus_flow_hour` |
| 邻近地铁站 | `metro_station_distance` | `metro_flow_hour` |

同一网格或线路可以位于多个地铁站的距离范围内。按站分别统计、范围并集去重和分配到唯一最近站是不同的数据口径。
