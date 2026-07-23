# common.sqlite 表与字段

## 导航

- [定位与表清单](#定位)
- [字段](#字段)
- [连接与查询注意](#连接与查询注意)
- [样例查询](#样例查询)

## 定位

`common.sqlite` 保存跨领域共享的日期、时间、CRS、空间实体和天气数据。它不保存订单事实。演唱会开始、结束时刻只在 `SKILL.md` 的案例说明中维护；`dim_event` 只有日期精度。

## 表清单

| 表 | 行数 | 粒度 | 主要用途 |
|---|---:|---|---|
| `dim_date` | 23 | 一天 | 跨领域日期连接、周末和活动日标记 |
| `dim_time` | 1,440 | 日内一分钟 | 分钟、15分钟、30分钟和时段解释 |
| `dim_crs` | 2 | 一个发布 CRS 状态 | WGS84 与未知 CRS 治理 |
| `dim_event` | 4 | 一个活动日期 | 活动日筛选，不提供演出时刻 |
| `dim_venue` | 1 | 一个场馆 | 上海体育场标准名称和 WGS84 点位 |
| `dim_geo_feature` | 5,878 | 一个空间实体 | 跨领域空间对象索引 |
| `dim_weather_grid` | 8 | 一个天气网格 | 徐汇天气网格名称和坐标状态 |
| `std_weather_observation` | 11,384 | 网格—观测时刻 | 接纳层天气观测和质量审计 |
| `fact_weather_observation` | 11,384 | 网格—观测时刻 | 有效温度、滚动一小时降雨 |
| `mart_weather_grid_hour` | 3,248 | 网格—日期—小时 | 小时天气联动 |
| `mart_weather_grid_day` | 168 | 网格—日期 | 日天气概览 |

## 字段

### `dim_date`

`date_key INTEGER`，`date_iso TEXT`，`year INTEGER`，`quarter INTEGER`，`month INTEGER`，`day INTEGER`，`weekday_iso INTEGER`，`weekday_name_cn TEXT`，`is_weekend INTEGER`，`week_of_year INTEGER`，`is_event_day INTEGER`，`event_id TEXT`

通过 `date_key` 连接各领域事实。`is_event_day=1` 只表示案例活动日期，不代表表中保存了活动时刻。

### `dim_time`

`minute_key INTEGER`，`time_hhmm TEXT`，`hour INTEGER`，`minute INTEGER`，`slot_15_start INTEGER`，`slot_30_start INTEGER`，`day_period_cn TEXT`

`minute_key` 范围为 0—1439。事实表中的 `slot_15_start`、`slot_30_start` 都是时桶起始分钟。

### `dim_crs`

`crs_code TEXT`，`crs_name_cn TEXT`，`is_geographic INTEGER`，`governance_note TEXT`

发布值只有 `EPSG:4326` 和 `UNKNOWN`。`UNKNOWN` 记录保留，但不能做距离和空间连接。

### `dim_event`

`event_id TEXT`，`event_series_id TEXT`，`event_name TEXT`，`venue_key TEXT`，`event_date_key INTEGER`，`event_date TEXT`，`time_precision TEXT`，`event_start_at TEXT`，`event_end_at TEXT`，`ingress_start_at TEXT`，`egress_end_at TEXT`，`source_type TEXT`，`source_note TEXT`

当前四条记录的 `time_precision='DATE_ONLY'`，所有时刻字段为空。不要从这里推断演唱会开始、结束或交通管控窗口；案例日程见 `SKILL.md`。

### `dim_venue`

`venue_key TEXT`，`venue_name TEXT`，`venue_type TEXT`，`longitude REAL`，`latitude REAL`，`crs TEXT`，`geo_key TEXT`，`notes TEXT`，`source_row_id INTEGER`

当前唯一场馆为 `venue_shanghai_stadium`。用户确认点位为 WGS84 `(121.43348, 31.18334)`。

### `dim_geo_feature`

`geo_key TEXT`，`domain_code TEXT`，`entity_type TEXT`，`entity_id TEXT`，`entity_name TEXT`，`geometry_type TEXT`，`geometry_json TEXT`，`longitude REAL`，`latitude REAL`，`crs TEXT`，`coordinate_quality TEXT`，`source_table TEXT`，`source_row_id INTEGER`

这是空间对象索引，不是事实表。点对象读经纬度，线对象读 `geometry_json`；使用前检查 `crs` 和 `coordinate_quality`。

### `dim_weather_grid`

`grid_key INTEGER`，`town_id INTEGER`，`town_name TEXT`，`district_name TEXT`，`longitude REAL`，`latitude REAL`，`crs TEXT`，`geo_key TEXT`

天气网格 CRS 尚未确认，当前为 `UNKNOWN`。可按 `grid_key`、名称和时间分析，不能与场馆或线路做精确空间距离。

### `std_weather_observation` 与 `fact_weather_observation`

字段相同：

`observation_key INTEGER`，`source_observation_id TEXT`，`grid_key INTEGER`，`observed_at TEXT`，`date_key INTEGER`，`minute_key INTEGER`，`temperature_c REAL`，`rainfall_1h_mm REAL`，`quality_status TEXT`，`source_table TEXT`，`source_row_id INTEGER`

`rainfall_1h_mm` 是滚动一小时累计值。`std_*` 用于审计，业务分析默认使用 `fact_*`。

### `mart_weather_grid_hour`

`grid_key INTEGER`，`date_key INTEGER`，`hour INTEGER`，`observation_count INTEGER`，`avg_temperature_c REAL`，`min_temperature_c REAL`，`max_temperature_c REAL`，`avg_rainfall_1h_mm REAL`，`max_rainfall_1h_mm REAL`

### `mart_weather_grid_day`

`grid_key INTEGER`，`date_key INTEGER`，`observed_hours INTEGER`，`observation_count INTEGER`，`avg_temperature_c REAL`，`min_temperature_c REAL`，`max_temperature_c REAL`，`max_rainfall_1h_mm REAL`

## 连接与查询注意

- 日期统一连接 `dim_date.date_key`，分钟连接 `dim_time.minute_key`。
- `event_id` 只用于活动日标记；不得把活动属性写回订单表。
- 天气事实按 `grid_key` 连接 `dim_weather_grid`。
- 小时降雨优先使用 `max_rainfall_1h_mm`，不能把近10分钟观测逐条相加。
- `dim_geo_feature` 便于发现空间实体，具体业务属性仍需连接原分库维表。

## 样例查询

```sql
-- 四个案例活动日及日期属性
SELECT date_key, date_iso, weekday_name_cn, is_weekend, event_id
FROM common.dim_date
WHERE is_event_day = 1
ORDER BY date_key;

-- 活动日天气小时概览；不做未知 CRS 的空间距离
SELECT w.date_key, w.hour, g.town_name,
       w.avg_temperature_c, w.max_rainfall_1h_mm
FROM common.mart_weather_grid_hour w
JOIN common.dim_weather_grid g USING (grid_key)
WHERE w.date_key IN (20250820, 20250821, 20250823, 20250824)
ORDER BY w.date_key, w.hour, g.town_name;
```
