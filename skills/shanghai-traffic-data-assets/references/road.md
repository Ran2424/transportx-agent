# road.sqlite 表与字段

## 定位

`road.sqlite` 保存89个命名发布段的交通状态变化。数据支持“何时由畅通转为拥挤、每小时拥堵持续多久”等时间态势分析；源数据没有可靠道路几何，因此不支持路网制图、邻接关系或到场馆的距离分析。

## 表清单

| 表 | 行数 | 粒度 | 主要用途 |
|---|---:|---|---|
| `dim_road_segment` | 89 | 一个命名发布段 | 路段名称与统一键 |
| `std_road_state_event` | 21,775 | 发布段—状态变化时刻 | 接纳层、质量和血缘审计 |
| `fact_road_state_event` | 21,775 | 发布段—状态变化时刻 | 状态序列与持续时间 |
| `mart_road_segment_hour` | 39,494 | 发布段—日期—小时 | 小时畅通/拥挤/拥堵时长 |
| `mart_road_segment_day` | 1,704 | 发布段—日期 | 日状态时长 |

时间覆盖为 2025-08-11—2025-08-31。缺失小时表示未观测，不能自动补零。

## 字段

### `dim_road_segment`

`segment_key INTEGER`，`segment_id TEXT`，`segment_name TEXT`，`geo_key TEXT`，`location_available INTEGER`，`source_table TEXT`

`segment_key` 是事实连接键。当前 `location_available=0`，`geo_key` 不代表可用道路几何。

### `std_road_state_event` 与 `fact_road_state_event`

字段相同：

`event_key INTEGER`，`segment_key INTEGER`，`event_at TEXT`，`next_event_at TEXT`，`date_key INTEGER`，`minute_key INTEGER`，`state_code TEXT`，`state_name_cn TEXT`，`duration_seconds INTEGER`，`source_record_number INTEGER`，`quality_status TEXT`，`source_table TEXT`，`source_row_id INTEGER`

数据是逢变更新，不是固定频率采样。`duration_seconds` 为当前事件到同段下一事件的时间差；每段最后一个状态没有下一事件时不计持续时间。

### `mart_road_segment_hour`

`segment_key INTEGER`，`date_key INTEGER`，`hour INTEGER`，`free_seconds INTEGER`，`crowd_seconds INTEGER`，`jam_seconds INTEGER`，`observed_seconds INTEGER`，`state_event_count INTEGER`

状态持续时间会按小时边界切分，因此可直接计算某小时拥堵分钟数。覆盖率可用 `observed_seconds / 3600.0` 判断。

### `mart_road_segment_day`

`segment_key INTEGER`，`date_key INTEGER`，`observed_hours INTEGER`，`free_seconds INTEGER`，`crowd_seconds INTEGER`，`jam_seconds INTEGER`，`observed_seconds INTEGER`，`state_event_count INTEGER`

## 连接与查询注意

- 通过 `segment_key` 连接 `dim_road_segment`，通过 `date_key` 连接 `common.dim_date`。
- 业务趋势优先查询 `mart_road_segment_hour`；状态切换过程才查询 `fact_road_state_event`。
- `jam_seconds`、`crowd_seconds` 是持续时长，不是车辆数或速度。
- 不要仅凭 `segment_name` 与公交、轨交或场馆做空间连接。
- 多路段汇总前先明确是“路段分钟之和”还是“至少一个路段拥堵的钟表分钟”，两者不是同一指标。

## 可支撑分析

- 演前、演中、散场阶段的路段拥堵持续时长和峰值小时；
- 活动日与非活动日同路段、同时段对比；
- 各状态转换序列和拥堵开始、缓解时刻；
- 观测覆盖率评估。

不能支撑：道路速度、流量、行程时间、路网拓扑、精确空间缓冲。

## 样例查询

```sql
-- 活动日 18:00—23:00 各路段拥堵分钟
SELECT h.date_key, h.hour, d.segment_name,
       h.jam_seconds / 60.0 AS jam_minutes,
       h.observed_seconds / 3600.0 AS coverage_ratio
FROM road.mart_road_segment_hour h
JOIN road.dim_road_segment d USING (segment_key)
WHERE h.date_key IN (20250820, 20250821, 20250823, 20250824)
  AND h.hour BETWEEN 18 AND 23
ORDER BY h.date_key, h.hour, jam_minutes DESC;

-- 某路段的状态变化
SELECT e.event_at, e.next_event_at, e.state_name_cn, e.duration_seconds
FROM road.fact_road_state_event e
JOIN road.dim_road_segment d USING (segment_key)
WHERE d.segment_name = :segment_name
  AND e.date_key = :date_key
ORDER BY e.event_at;
```
