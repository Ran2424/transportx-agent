# bus.sqlite 表与字段

## 定位

`bus.sqlite` 包含77条官方线路的属性、151条高德方向路径、1,272个来源系统站点，以及75条线路的半小时交易数据。公交事实度量的是交易笔数，不是去重乘客数；静态线路覆盖也不是上海公交全网。

## 表清单

| 表 | 行数 | 粒度 | 主要用途 |
|---|---:|---|---|
| `dim_bus_line` | 77 | 一条官方线路 | 统一线路键和运营属性 |
| `dim_bus_route_direction` | 151 | 一个高德方向线路 | 路径、方向和运营属性 |
| `dim_bus_stop` | 1,272 | 一个来源系统站点 | 站名、点位和来源身份 |
| `bridge_bus_line_stop` | 4,080 | 线路/方向—站序 | 路径拓扑和站序 |
| `ops_bus_collection_report` | 77 | 一次线路采集结果 | 高德采集审计 |
| `std_bus_line_30m` | 55,339 | 日期—半小时—官方线路 | 接纳层交易数据 |
| `fact_bus_line_30m` | 55,339 | 日期—半小时—官方线路 | 半小时上客和支付结构 |
| `mart_bus_line_hour` | 28,686 | 日期—小时—官方线路 | 小时趋势 |
| `mart_bus_line_day` | 1,574 | 日期—官方线路 | 日交易和峰值时段 |

客流时间覆盖为 2025-08-09—2025-08-29。77条线路中75条有交易事实，另2条只有静态信息。

## 静态网络字段

### `dim_bus_line`

`line_key TEXT`，`line_name TEXT`，`line_code_6 INTEGER`，`line_code_5 INTEGER`，`is_loop INTEGER`，`line_type TEXT`，`operation_mode TEXT`，`included_in_statistics INTEGER`，`operator_name TEXT`，`valid_until TEXT`，`start_stop_name TEXT`，`end_stop_name TEXT`，`business_system_id TEXT`，`first_departure_start TEXT`，`last_departure_start TEXT`，`first_departure_end TEXT`，`last_departure_end TEXT`，`updated_at TEXT`，`source_row_id INTEGER`

`line_key` 是统一事实连接键。`line_code_5`、`line_code_6` 是源业务编码，不应脱离来源语境直接连接。

### `dim_bus_route_direction`

`route_direction_key TEXT`，`requested_name TEXT`，`route_name TEXT`，`route_type TEXT`，`start_stop_name TEXT`，`end_stop_name TEXT`，`start_time TEXT`，`end_time TEXT`，`schedule_description TEXT`，`operator_name TEXT`，`distance_km REAL`，`basic_price_yuan REAL`，`total_price_yuan REAL`，`is_loop INTEGER`，`operation_status INTEGER`，`reverse_route_key TEXT`，`stop_count INTEGER`，`crs TEXT`，`geometry_type TEXT`，`geometry_json TEXT`，`geo_key TEXT`，`source_row_id INTEGER`

### `dim_bus_stop`

`stop_key TEXT`，`source_system TEXT`，`source_stop_id TEXT`，`stop_name TEXT`，`longitude REAL`，`latitude REAL`，`crs TEXT`，`served_line_keys TEXT`，`served_line_names TEXT`，`geo_key TEXT`，`updated_at TEXT`，`source_row_id INTEGER`

站点键使用 `OFFICIAL:` 或 `AMAP:` 前缀。来源系统中的同名站点未强制合并成同一物理站。

### `bridge_bus_line_stop`

`relation_key TEXT`，`relation_source TEXT`，`line_key TEXT`，`route_direction_key TEXT`，`stop_key TEXT`，`stop_sequence INTEGER`，`direction_code INTEGER`，`stop_role INTEGER`，`longitude REAL`，`latitude REAL`，`crs TEXT`，`distance_to_route_m REAL`，`coordinate_quality TEXT`，`source_row_id INTEGER`

高德方向关系通常有 `route_direction_key`；官方站序以 `line_key` 为主。查询前按 `relation_source` 确认来源语义。

### `ops_bus_collection_report`

`requested_name TEXT`，`collection_status TEXT`，`directions_found INTEGER`，`api_info TEXT`，`api_infocode INTEGER`，`candidate_names TEXT`，`source_row_id INTEGER`

## 交易字段

### `std_bus_line_30m`

`record_key INTEGER`，`date_key INTEGER`，`minute_key INTEGER`，`slot_code INTEGER`，`line_key TEXT`，`source_line_code_5 INTEGER`，`industry_code INTEGER`，`total_transactions INTEGER`，`bus_boarding_transactions INTEGER`，`metro_entry_transactions INTEGER`，`transit_card_transactions INTEGER`，`card_transfer_from_bus INTEGER`，`card_transfer_from_metro INTEGER`，`qr_transactions INTEGER`，`qr_transfer_from_bus INTEGER`，`qr_transfer_from_metro INTEGER`，`source_created_time TEXT`，`quality_status TEXT`，`source_table TEXT`，`source_row_id INTEGER`

### `fact_bus_line_30m`

`record_key INTEGER`，`date_key INTEGER`，`minute_key INTEGER`，`line_key TEXT`，`total_transactions INTEGER`，`bus_boarding_transactions INTEGER`，`metro_entry_transactions INTEGER`，`transit_card_transactions INTEGER`，`card_transfer_from_bus INTEGER`，`card_transfer_from_metro INTEGER`，`qr_transactions INTEGER`，`qr_transfer_from_bus INTEGER`，`qr_transfer_from_metro INTEGER`，`source_table TEXT`，`source_row_id INTEGER`

### `mart_bus_line_hour`

`date_key INTEGER`，`hour INTEGER`，`line_key TEXT`，`observed_slots INTEGER`，`total_transactions INTEGER`，`bus_boarding_transactions INTEGER`，`transit_card_transactions INTEGER`，`qr_transactions INTEGER`

### `mart_bus_line_day`

`date_key INTEGER`，`line_key TEXT`，`observed_slots INTEGER`，`total_transactions INTEGER`，`bus_boarding_transactions INTEGER`，`transit_card_transactions INTEGER`，`qr_transactions INTEGER`，`peak_minute_key INTEGER`，`peak_boarding_transactions INTEGER`

`observed_slots` 用于判断当日或小时是否完整；缺少半小时记录不能按零交易处理。

## 连接与查询注意

- 事实只用 `line_key` 连接 `dim_bus_line`。
- `bus_boarding_transactions` 是公交上客交易；`total_transactions` 还包含其他交易类别，使用前确认指标。
- 公交交易数不能与轨交人次、网约车事件直接相加。
- 空间查询只使用 `crs='EPSG:4326'` 的站点或路径。
- 按场馆附近站点统计前，需要自行定义 WGS84 空间范围并投影计算米制距离；不要仅按“体育场”名称匹配。
- `served_line_keys`、`served_line_names` 是便于浏览的列表文本，不是规范关系；拓扑连接使用 `bridge_bus_line_stop`。

## 样例查询

```sql
-- 活动日 15:00—23:00 线路小时上客交易
SELECT h.date_key, h.hour, l.line_name,
       h.bus_boarding_transactions, h.observed_slots
FROM bus.mart_bus_line_hour h
JOIN bus.dim_bus_line l USING (line_key)
WHERE h.date_key IN (20250820, 20250821, 20250823, 20250824)
  AND h.hour BETWEEN 15 AND 23
ORDER BY h.date_key, h.hour, h.bus_boarding_transactions DESC;

-- 查看一条线路的方向与站序
SELECT d.route_name, b.stop_sequence, s.stop_name,
       b.longitude, b.latitude, b.coordinate_quality
FROM bus.bridge_bus_line_stop b
JOIN bus.dim_bus_route_direction d USING (route_direction_key)
JOIN bus.dim_bus_stop s USING (stop_key)
WHERE b.route_direction_key = :route_direction_key
ORDER BY b.stop_sequence;
```
