# metro.sqlite 表与字段

## 导航

- [定位与表清单](#定位)
- [静态网络字段](#静态网络字段)
- [映射与运维字段](#映射与运维字段)
- [客流字段](#客流字段)
- [连接与查询注意](#连接与查询注意)
- [样例查询](#样例查询)

## 定位

`metro.sqlite` 同时包含接近全网的静态线路/站点网络和局部站点小时客流。静态网络有20条统一线路、420个物理站；客流只有10个物理站、19个线路—站点组合。不能把静态覆盖误写成客流全网覆盖。

## 表清单

| 表 | 行数 | 粒度 | 主要用途 |
|---|---:|---|---|
| `dim_metro_line` | 20 | 一条统一线路 | 线路统一 ID、名称和 WGS84 几何 |
| `dim_metro_route_direction` | 46 | 一个方向或支线路径 | 高德方向、运营属性和 WGS84 几何 |
| `dim_metro_station` | 420 | 一个物理站 | 统一站点、坐标和映射质量 |
| `bridge_metro_route_station` | 1,200 | 方向线路—站序 | 路径拓扑和线路上下文点位 |
| `bridge_metro_line_station` | 532 | 统一线路—物理站 | 线路覆盖站点 |
| `map_metro_amap_station` | 420 | 一个高德源站到物理站映射 | 源 ID 接入 |
| `quality_metro_flow_station_mapping` | 19 | 一个客流源线路—站点映射 | 客流 ID 审计 |
| `ops_metro_collection_report` | 20 | 一次线路采集结果 | 高德采集状态 |
| `ops_metro_station_coordinate_quality` | 420 | 一个物理站坐标结果 | 坐标来源和异常 |
| `std_metro_station_hour` | 7,975 | 日期—小时—线路—物理站 | 接纳层客流 |
| `fact_metro_station_hour` | 7,975 | 日期—小时—线路—物理站 | 进出站客流分析 |
| `mart_metro_station_day` | 399 | 日期—线路—物理站 | 日客流和峰值小时 |

客流时间覆盖为 2025-08-11—2025-08-31，原始粒度已经是小时。

## 静态网络字段

### `dim_metro_line`

`line_id INTEGER`，`line_number INTEGER`，`line_name TEXT`，`station_count INTEGER`，`geometry_type TEXT`，`geometry_json TEXT`，`crs TEXT`，`geometry_source TEXT`，`geo_key TEXT`，`source_row_id INTEGER`

### `dim_metro_route_direction`

`route_direction_id TEXT`，`line_id INTEGER`，`canonical_name TEXT`，`route_name TEXT`，`route_type TEXT`，`start_station_name TEXT`，`end_station_name TEXT`，`schedule_description TEXT`，`operator_name TEXT`，`distance_km REAL`，`operation_status INTEGER`，`reverse_route_direction_id TEXT`，`stop_count INTEGER`，`crs TEXT`，`geometry_type TEXT`，`geometry_json TEXT`，`geo_key TEXT`，`collected_at TEXT`，`source_row_id INTEGER`

5、10、11号线存在多条方向或支线路径。`route_direction_id` 只用于方向路径，不能替代统一 `line_id`。

### `dim_metro_station`

`station_id INTEGER`，`station_name TEXT`，`line_names TEXT`，`longitude REAL`，`latitude REAL`，`crs TEXT`，`coordinate_source TEXT`，`mapping_method TEXT`，`source_station_ids TEXT`，`coordinate_quality TEXT`，`geo_key TEXT`，`source_row_id INTEGER`

419个物理站有 WGS84 坐标；严御路保留为 `UNKNOWN`，不得生成伪位置。

### `bridge_metro_route_station`

`relation_key TEXT`，`route_direction_id TEXT`，`line_id INTEGER`，`station_id INTEGER`，`source_station_id TEXT`，`station_name TEXT`，`stop_sequence INTEGER`，`longitude REAL`，`latitude REAL`，`crs TEXT`，`distance_to_route_m REAL`，`coordinate_quality TEXT`，`source_row_id INTEGER`

线路制图和某方向站序应使用这里的线路上下文坐标，不能用物理站质心替代全部站台位置。

### `bridge_metro_line_station`

`relation_id INTEGER`，`line_id INTEGER`，`station_id INTEGER`，`longitude REAL`，`latitude REAL`，`source_route_count INTEGER`，`distance_to_line_m REAL`，`coordinate_quality TEXT`，`source_row_id INTEGER`，`crs TEXT`

## 映射与运维字段

### `map_metro_amap_station`

`source_station_id TEXT`，`source_station_name TEXT`，`station_id INTEGER`，`canonical_station_name TEXT`，`mapping_method TEXT`，`confidence REAL`

### `quality_metro_flow_station_mapping`

`source_line_number INTEGER`，`source_station_id INTEGER`，`source_station_name TEXT`，`station_id INTEGER`，`mapping_method TEXT`

### `ops_metro_collection_report`

`canonical_name TEXT`，`queries TEXT`，`collection_status TEXT`，`directions_found INTEGER`，`candidate_names TEXT`，`api_info TEXT`，`api_infocode INTEGER`，`source_row_id INTEGER`

### `ops_metro_station_coordinate_quality`

`station_id INTEGER`，`status TEXT`，`coordinate_source TEXT`，`source_station_ids TEXT`，`mapping_method TEXT`，`source_row_id INTEGER`

## 客流字段

### `std_metro_station_hour`

`record_key INTEGER`，`date_key INTEGER`，`hour INTEGER`，`minute_key INTEGER`，`line_id INTEGER`，`station_id INTEGER`，`source_line_number INTEGER`，`source_station_id INTEGER`，`source_station_name TEXT`，`inbound_flow INTEGER`，`outbound_flow INTEGER`，`total_flow INTEGER`，`quality_status TEXT`，`source_table TEXT`，`source_row_id INTEGER`

### `fact_metro_station_hour`

`record_key INTEGER`，`date_key INTEGER`，`hour INTEGER`，`minute_key INTEGER`，`line_id INTEGER`，`station_id INTEGER`，`inbound_flow INTEGER`，`outbound_flow INTEGER`，`total_flow INTEGER`，`source_table TEXT`，`source_row_id INTEGER`

### `mart_metro_station_day`

`date_key INTEGER`，`line_id INTEGER`，`station_id INTEGER`，`observed_hours INTEGER`，`inbound_flow INTEGER`，`outbound_flow INTEGER`，`total_flow INTEGER`，`peak_hour INTEGER`，`peak_hour_flow INTEGER`

`inbound_flow + outbound_flow` 是进出站人次之和，不是去重乘客数。

## 连接与查询注意

- 客流只通过统一 `line_id`、`station_id` 连接维表。
- 站点名称可重名或包含线路语境，不应作为事实连接键。
- “上海体育场站”和“上海体育馆站”是两个轨交站；不要与场馆 POI 混淆。
- 线路几何和已确认坐标均为 `EPSG:4326`；米制距离计算前投影到 `EPSG:32651`。
- 日集市适合活动日对比；活动前后小时态势直接使用小时事实。
- 没有客流行不代表零客流，先确认该站是否在19个客流组合内。

## 样例查询

```sql
-- 活动日相关站点逐小时进出站客流
SELECT f.date_key, f.hour, l.line_name, s.station_name,
       f.inbound_flow, f.outbound_flow, f.total_flow
FROM metro.fact_metro_station_hour f
JOIN metro.dim_metro_line l USING (line_id)
JOIN metro.dim_metro_station s USING (station_id)
WHERE f.date_key IN (20250820, 20250821, 20250823, 20250824)
  AND s.station_name IN ('上海体育场', '上海体育馆')
ORDER BY f.date_key, f.hour, l.line_id, s.station_id;

-- 判断某站是否具有客流覆盖
SELECT s.station_id, s.station_name, COUNT(f.record_key) AS observed_rows
FROM metro.dim_metro_station s
LEFT JOIN metro.fact_metro_station_hour f USING (station_id)
WHERE s.station_name LIKE '%体育%'
GROUP BY s.station_id, s.station_name;
```
