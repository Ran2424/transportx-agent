# 空间数据与坐标契约

## 发布标准

发布资产只使用两种 CRS 状态：

- `EPSG:4326`：已经确认或按受控规则转换为 WGS84；
- `UNKNOWN`：来源 CRS 无法确认，记录保留，但不能参与精确空间运算。

资产不保留第二套源坐标列。转换依据和不确定性通过 `coordinate_status`、质量表和治理文档说明；受控源值只保留在原始治理库。

## 已完成的转换

| 来源 | 处理 |
|---|---|
| 高德公交、轨交点线 | GCJ-02 逆转换为 WGS84 |
| 官方公交站点 | EPSG:32651 转换为 WGS84 |
| 网约车显式 GCJ-02 | 转换为 WGS84 |
| 网约车显式 WGS84 | 原值规范为 EPSG:4326 |
| 网约车显式 BD-09 | BD-09 转换为 WGS84 |
| 上海体育场场馆 | 使用用户确认的 WGS84 `(121.43348, 31.18334)` |
| 重要交通枢纽 POI | 使用 `common.dim_poi` 中用户确认的 WGS84 中心点 |
| 无法确认的坐标 | 保留记录，CRS 标记 `UNKNOWN` |

`common.dim_crs` 只登记 `EPSG:4326` 和 `UNKNOWN`。本次构建的 `common.dim_geo_feature` 中，5,873 个对象为 WGS84，9 个为 UNKNOWN。

## 场馆订单的 CRS 反推

场馆订单源没有 CRS 字段，但可以按订单号回连有显式 CRS 的上车表和下车表。

实际证据：

- 场馆离场表的上车端回连上车表后，显式 CRS 以 GCJ-02 为主，同时存在约 7% WGS84 和少量 BD-09/未知记录。
- 场馆到场表的下车端回连下车表后，显式 CRS 同样以 GCJ-02 为主，也存在 WGS84、BD-09 和未知记录。
- 因此不能把全部场馆坐标无条件视为 GCJ-02，也不能把看起来像上海经纬度的数值直接标为 WGS84。

构建规则：

1. 同订单对应端点存在时，继承其显式 CRS，再转换为 WGS84。
2. 对应端点标识为未知时，坐标保留并标 `UNKNOWN_CRS_FROM_MATCHED_*`。
3. 没有对应端点时，依据数据集多数为 GCJ-02，按 GCJ-02 推定并转换，标记 `ASSUMED_GCJ02_FROM_DATASET_MAJORITY`。

有效场馆到离场事件中的推断分布：

| 场馆方向 | 回连 GCJ-02 | 回连 WGS84 | 回连 BD-09 | 数据集多数假设 GCJ-02 | 回连但 CRS 未知 |
|---|---:|---:|---:|---:|---:|
| 离场 `FROM_VENUE` | 535,076 | 40,395 | 9 | 2,477 | 842 |
| 到场 `TO_VENUE` | 525,097 | 11,893 | 7 | 34,033 | 839 |

使用订单坐标做精确 OD、距离或网格分析时，应在结果中报告这些状态。对推定记录要求更严格时，可以只保留 `INFERRED_*` 或直接来源状态。

## 选择空间对象

| 问题 | 对象 |
|---|---|
| 统一轨交线路 | `metro.dim_metro_line.geometry_json` |
| 某一方向或支线路径 | `metro.dim_metro_route_direction.geometry_json` |
| 物理站点分布 | `metro.dim_metro_station.longitude/latitude` |
| 统一线路上的上下文站点 | `metro.bridge_metro_line_station` |
| 高德方向线路站序 | `metro.bridge_metro_route_station` |
| 公交方向线路 | `bus.dim_bus_route_direction.geometry_json` |
| 公交线路/方向站序 | `bus.bridge_bus_line_stop` |
| 订单 OD | `ridehail.fact_trip` 的 pickup/dropoff 坐标和 CRS |
| 场馆到离场点 | `ridehail.fact_venue_event` |
| 重要火车站、机场中心点 | `common.dim_poi` |
| 跨领域空间发现 | `common.dim_geo_feature` |

换乘站可以有一个物理实体和多个线路上下文点。实体计数、客流连接用物理 `station_id`；线路制图用关系表中的上下文点。

## 距离与投影

- 存储和交换：EPSG:4326。
- 上海米制缓冲、最近邻和点线距离：EPSG:32651。
- Web 瓦片显示：EPSG:3857，只用于显示。
- 不在经纬度上直接调用平面 `buffer` 或 `distance`。
- `haversine_km` 只用于两个 `EPSG:4326` 点，不用于点到线或 UNKNOWN 坐标。

本次构建中，1,200 条轨交方向站序、532 条统一线站关系和 3,428 条高德公交方向站序均未出现超过 25 米的点线偏差。

## 已知空间缺口

- 严御路站缺少可靠坐标，不绘制伪位置。
- 8 个天气网格 CRS 未确认，按网格名称和时间使用，不做精确空间连接。
- 道路发布段没有几何，不能制图、缓冲或计算网络邻接。
- 29 个场馆关联订单坐标超出上海合理范围，默认订单事实排除。
- 11号线延伸至昆山，全线路图会超出上海行政边界。
