# 数据模型和连接

## 分库

| 库 | 内容 |
|---|---|
| `catalog` | 构建、来源、字段、关系、指标、冲突、质量和查询样例 |
| `common` | 日期、时间、枢纽、点位、交通方式和国庆分段 |
| `rail` | 铁路停站、地铁日客流、半小时与日集市 |
| `forecast` | 到达预测和疏散比例的版本事实与最新视图 |
| `hubops` | 功能点流量、出租车蓄车场及半小时集市 |
| `ridehail` | 网约车需求、窗口订单、撮合指标和小时/日集市 |

## 治理层前缀

| 前缀 | 含义 |
|---|---|
| `dim_*` | 统一实体或公共维度 |
| `map_*` | 源代码到统一 ID 的映射 |
| `std_*` | 保留来源、样例和质量状态的标准接纳层 |
| `fact_*` | 默认业务事实或长表视图 |
| `mart_*` | 固定时间粒度的预聚合 |
| `meta_*` | Catalog 元数据和治理结果 |

## 主要连接

- 事实的 `date_key` 连接 `common.dim_date.date_key`。
- 事实的 `minute_key` 连接 `common.dim_time.minute_key`。
- `hub_id` 连接 `common.dim_hub.hub_id`。
- `location_id` 连接 `common.dim_location.location_id`。
- `record_key`、`source_file_id` 和 `source_row_number` 用于标准层与源记录追溯。
- 跨库关系由 `catalog.meta_relationship` 记录，并在构建验证中检查孤儿键。

## 关键自然键

| 对象 | 自然键 |
|---|---|
| `rail.std_train_stop` | `source_file_id, source_row_number` |
| `rail.fact_train_stop` | `departure_date, train_code, station_code` |
| `rail.fact_metro_station_flow_day` | `date_key, line_id, station_id` |
| `forecast.fact_arrival_forecast_version` | `hub_id, predicted_at, issued_at, dataset_role` |
| `forecast.std_evac_ratio_hour` | `hub_id, predicted_at, issued_at, dataset_role` |
| `hubops.fact_site_flow_observation` | `location_id, observed_at, metric_code, source_file_id` |
| `hubops.fact_taxi_yard_state` | `location_id, observed_at` |
| `ridehail.fact_ridehail_demand_snapshot` | `hub_id, observed_at` |
| `ridehail.fact_ridehail_order_window` | `hub_id, observed_at, window_minutes` |
| `ridehail.fact_ridehail_match_snapshot` | `hub_id, observed_at` |

所有代码使用 `TEXT`，避免丢失 `02` 等前导零。时间为 Asia/Shanghai 本地 ISO 8601 文本；`date_key` 为 `YYYYMMDD`，`minute_key` 为 0–1439。
