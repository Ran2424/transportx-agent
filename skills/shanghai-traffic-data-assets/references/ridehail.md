# ridehail.sqlite 表与字段

## 导航

- [定位与表清单](#定位)
- [订单关系与字段](#订单关系)
- [端点和场馆事件字段](#端点和场馆事件字段)
- [集市字段](#集市字段)
- [CRS 处理](#crs-处理)
- [连接与查询注意](#连接与查询注意)
- [样例查询](#样例查询)

## 定位

`ridehail.sqlite` 将上车表、下车表、场馆离场表和场馆到场表合并为一套订单资产。四类来源属于同一订单体系：场馆订单与网约车订单重叠率为97.48%，不是两套可以相加的订单事实。

活动名称、演出开始和结束时刻不写入本库。订单只保留自身发生时间、位置、来源覆盖、场馆方向和质量状态。

## 表清单

| 表 | 行数 | 粒度 | 主要用途 |
|---|---:|---|---|
| `std_trip` | 1,206,222 | 四源并集中的一笔订单 | 唯一标准接纳层、重复和异常审计 |
| `fact_trip` | 1,206,193 | 一笔有效完整或部分订单 | 订单量、OD和行程时长 |
| `fact_ridehail_event` | 2,269,148 | 一个上车或下车端点 | 端点时空趋势 |
| `fact_venue_trip` | 1,054,805 | 一笔有效场馆关联订单 | `fact_trip` 的业务子集 |
| `fact_venue_event` | 1,150,668 | 一次到场或离场业务事件 | 场馆方向趋势 |
| `mart_ridehail_event_15m` | 4,038 | 日期—15分钟—端点类型 | 细粒度端点趋势 |
| `mart_ridehail_event_hour` | 1,011 | 日期—小时—端点类型 | 小时端点趋势 |
| `mart_ridehail_event_day` | 44 | 日期—端点类型 | 日端点趋势 |
| `mart_venue_trip_15m` | 4,037 | 日期—15分钟—场馆方向 | 到场/离场细粒度趋势 |
| `mart_venue_trip_hour` | 1,010 | 日期—小时—场馆方向 | 到场/离场小时趋势 |
| `mart_venue_trip_day` | 43 | 日期—场馆方向 | 到场/离场日趋势 |

订单时间覆盖为 2025-08-10—2025-08-31。`std_trip` 比 `fact_trip` 多29条坐标超出上海合理范围的场馆关联记录；后者被事实层排除但仍可审计。

## 订单关系

| 集合 | 订单数 | 含义 |
|---|---:|---|
| 上车表与下车表并集 | 1,179,655 | 原始网约车来源订单 |
| 场馆离场表与到场表并集 | 1,054,834 | 场馆业务筛选订单 |
| 两集合交集 | 1,028,267 | 场馆集合的97.48% |
| 只在场馆来源出现 | 26,567 | 场馆完整表补充的订单 |
| 四源总并集 | 1,206,222 | `std_trip`，一单一行 |

因此不能删除场馆来源，也不能把它与网约车订单相加。正确口径是：四源按订单号合并，场馆表补充完整端点和方向，再派生场馆子集。

## 订单字段

### `std_trip`

`trip_key INTEGER`，`order_hash BLOB`，`source_coverage TEXT`，`venue_relation TEXT`，`venue_source_conflict INTEGER`，`pickup_at TEXT`，`pickup_date_key INTEGER`，`pickup_minute_key INTEGER`，`pickup_longitude REAL`，`pickup_latitude REAL`，`pickup_crs TEXT`，`pickup_coordinate_status TEXT`，`pickup_place TEXT`，`dropoff_at TEXT`，`dropoff_date_key INTEGER`，`dropoff_minute_key INTEGER`，`dropoff_longitude REAL`，`dropoff_latitude REAL`，`dropoff_crs TEXT`，`dropoff_coordinate_status TEXT`，`dropoff_place TEXT`，`trip_duration_seconds INTEGER`，`source_duplicate_count INTEGER`，`is_deleted INTEGER`，`quality_status TEXT`

### `fact_trip` 与 `fact_venue_trip`

两表字段相同：

`trip_key INTEGER`，`order_hash`，`source_coverage TEXT`，`venue_relation TEXT`，`venue_source_conflict INTEGER`，`pickup_at TEXT`，`pickup_date_key INTEGER`，`pickup_minute_key INTEGER`，`pickup_longitude REAL`，`pickup_latitude REAL`，`pickup_crs TEXT`，`pickup_coordinate_status TEXT`，`pickup_place TEXT`，`dropoff_at TEXT`，`dropoff_date_key INTEGER`，`dropoff_minute_key INTEGER`，`dropoff_longitude REAL`，`dropoff_latitude REAL`，`dropoff_crs TEXT`，`dropoff_coordinate_status TEXT`，`dropoff_place TEXT`，`trip_duration_seconds INTEGER`，`source_duplicate_count INTEGER`，`quality_status TEXT`

`fact_venue_trip` 等于 `fact_trip` 中 `venue_relation <> 'NONE'` 的子集，不是第二份订单。

关键枚举：

- `source_coverage`：`RHD` 上车、`RHA` 下车、`PFV` 场馆离场、`PTV` 场馆到场的组合；
- `venue_relation`：`NONE`、`TO_VENUE`、`FROM_VENUE`、`BOTH`；
- `venue_source_conflict=1`：同时命中场馆到场和离场源但核心字段不一致，当前9单，取场馆离场源为默认值；
- `quality_status`：包括 `OK`、`PARTIAL_TRIP`、`UNKNOWN_CRS` 等；
- `order_hash`：原订单号的 SHA-256 哈希，不可逆，也不得尝试恢复。

## 端点和场馆事件字段

### `fact_ridehail_event`

`event_key`，`trip_key INTEGER`，`order_hash`，`source_coverage TEXT`，`event_type`，`event_at TEXT`，`date_key INTEGER`，`minute_key INTEGER`，`longitude REAL`，`latitude REAL`，`crs TEXT`，`coordinate_status TEXT`，`endpoint_source`，`endpoint_quality_status`，`venue_relation TEXT`，`trip_quality_status TEXT`

`event_type` 为上车或下车。`endpoint_source`：

- `RIDEHAIL_SOURCE`：端点来自原始上车表或下车表；
- `VENUE_ENRICHMENT`：端点由场馆完整订单补齐。

一笔完整订单可产生两个端点，因此统计订单量不能对该表直接计数。

### `fact_venue_event`

`trip_key INTEGER`，`order_hash`，`venue_relation`，`venue_event_at TEXT`，`date_key INTEGER`，`minute_key INTEGER`，`longitude REAL`，`latitude REAL`，`crs TEXT`，`coordinate_status TEXT`，`trip_duration_seconds INTEGER`

`TO_VENUE` 取下车端，`FROM_VENUE` 取上车端；`BOTH` 可生成一条到场和一条离场事件，但仍是一笔订单。

## 集市字段

### `mart_ridehail_event_15m`

`date_key INTEGER`，`slot_15_start INTEGER`，`event_type TEXT`，`event_count INTEGER`，`source_event_count INTEGER`，`venue_enriched_event_count INTEGER`，`wgs84_event_count INTEGER`，`unknown_crs_event_count INTEGER`

### `mart_ridehail_event_hour`

`date_key INTEGER`，`hour INTEGER`，`event_type TEXT`，其余计数字段与15分钟表相同。

### `mart_ridehail_event_day`

`date_key INTEGER`，`event_type TEXT`，其余计数字段与15分钟表相同。

三个端点集市均满足：

```text
event_count = source_event_count + venue_enriched_event_count
```

### `mart_venue_trip_15m`

`date_key INTEGER`，`slot_15_start INTEGER`，`venue_relation TEXT`，`trip_count INTEGER`，`wgs84_trip_count INTEGER`，`avg_trip_duration_seconds REAL`

### `mart_venue_trip_hour`

`date_key INTEGER`，`hour INTEGER`，`venue_relation TEXT`，`trip_count INTEGER`，`wgs84_trip_count INTEGER`，`avg_trip_duration_seconds REAL`

### `mart_venue_trip_day`

`date_key INTEGER`，`venue_relation TEXT`，`trip_count INTEGER`，`wgs84_trip_count INTEGER`，`avg_trip_duration_seconds REAL`

这里的 `trip_count` 实际是到场/离场业务事件数。唯一场馆订单量应查询 `fact_venue_trip`。

## CRS 处理

发布坐标只保留 WGS84 或未知状态，不保留多套源坐标：

1. 能回连上车/下车表时，继承相应端点 CRS；
2. 已确认的 GCJ-02 端点转换为 WGS84；
3. 场馆端点无法回连时，基于多数可回连端点为 GCJ-02 的证据，按 GCJ-02 推定并转换，标记 `ASSUMED_GCJ02_FROM_DATASET_MAJORITY`；
4. 证据不足时保留坐标并标记 `crs='UNKNOWN'`。

当前有1,684个统一订单端点 CRS 未知。精确距离、缓冲和跨域空间连接必须排除未知记录，并说明是否包含推定坐标。

## 连接与查询注意

- 订单数：查询 `fact_trip`；场馆唯一订单数：查询 `fact_venue_trip`。
- 端点趋势：查询 `mart_ridehail_event_*`，并区分原始来源和场馆补齐。
- 到离场趋势：查询 `mart_venue_trip_*` 或 `fact_venue_event`。
- 通过 `trip_key` 在订单与事件间连接；日期连接 `common.dim_date`。
- 同一订单的上车与下车日期可能不同，OD分析应明确按上车日还是下车日。
- `PARTIAL_TRIP` 可用于单端点态势，但不能用于完整 OD 或行程时长分析。
- 活动时段筛选由 `SKILL.md` 给出的案例日程驱动，不要向订单表添加活动字段。

## 样例查询

```sql
-- 活动日按上车日统计唯一订单、完整订单和未知 CRS 订单
SELECT pickup_date_key,
       COUNT(*) AS trip_count,
       SUM(dropoff_at IS NOT NULL) AS complete_trip_count,
       SUM(pickup_crs = 'UNKNOWN' OR dropoff_crs = 'UNKNOWN') AS unknown_crs_trip_count
FROM ridehail.fact_trip
WHERE pickup_date_key IN (20250820, 20250821, 20250823, 20250824)
GROUP BY pickup_date_key
ORDER BY pickup_date_key;

-- 演前至散场窗口的场馆15分钟方向趋势
SELECT date_key, slot_15_start, venue_relation,
       trip_count, wgs84_trip_count
FROM ridehail.mart_venue_trip_15m
WHERE date_key = :date_key
  AND slot_15_start BETWEEN 900 AND 1425
ORDER BY slot_15_start, venue_relation;

-- 查看端点来源组成
SELECT date_key, hour, event_type,
       source_event_count, venue_enriched_event_count,
       unknown_crs_event_count
FROM ridehail.mart_ridehail_event_hour
WHERE date_key = :date_key
ORDER BY hour, event_type;
```
