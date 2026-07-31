# PROJECT-DATA-ASSET-MODEL 抽查样本

## PROJECT-DATA-ASSET-MODEL@sec-0002

- 标题：分库与查询命名空间
- 来源定位：[{"pdf_page": null, "printed_page": null, "bbox": null, "quote": "| 数据库 | 内容 |\n|---|---|\n| `catalog` | 数据字典、血缘、实体ID、指标、质量规则与查询样例 |\n| `common` | 日期、时间、活动、场馆、天气、坐标系和统一空间索引 |\n| `road` | 道路状态事件与小时持续时间 |\n| `metro` | 统一线路、高德方向线路、物理站", "source_unit": "PROJECT-DATA-ASSET-MODEL@src-0002", "line_start": 3, "line_end": 15}]

| 数据库 | 内容 |
|---|---|
| `catalog` | 数据字典、血缘、实体ID、指标、质量规则与查询样例 |
| `common` | 日期、时间、活动、场馆、天气、坐标系和统一空间索引 |
| `road` | 道路状态事件与小时持续时间 |
| `metro` | 统一线路、高德方向线路、物理站点、线路站序与客流 |
| `bus` | 官方线路、高德方向线路、站点、线路站序与客流 |
| `ridehail` | 上下车事件、场馆订单与15分钟指标 |

`scripts/query_assets.py` 同时挂载以上六个命名空间，SQL 使用 `database.table`。

## PROJECT-DATA-ASSET-MODEL@sec-0008

- 标题：连接原则
- 来源定位：[{"pdf_page": null, "printed_page": null, "bbox": null, "quote": "- 日期：事实表通过 `date_key` 连接 `common.dim_date`。\n- 时间：分钟事实通过 `minute_key` 连接 `common.dim_time`；小时事实使用 `hour`。\n- 轨交客流：只通过统一 `line_id`、`station_id` 连接。\n- 轨交源ID：查询 `cat", "source_unit": "PROJECT-DATA-ASSET-MODEL@src-0008", "line_start": 76, "line_end": 82}]

- 日期：事实表通过 `date_key` 连接 `common.dim_date`。
- 时间：分钟事实通过 `minute_key` 连接 `common.dim_time`；小时事实使用 `hour`。
- 轨交客流：只通过统一 `line_id`、`station_id` 连接。
- 轨交源ID：查询 `catalog.meta_id_mapping` 或 `metro.map_metro_amap_station`。
- 地理：业务维表的 `geo_key` 连接 `common.dim_geo_feature.geo_key`。

## PROJECT-DATA-ASSET-MODEL@sec-0006

- 标题：公共、道路和天气
- 来源定位：[{"pdf_page": null, "printed_page": null, "bbox": null, "quote": "| 对象 | 粒度 | 说明 |\n|---|---|---|\n| `common.dim_date` | 日期 | 2025-08-09至2025-08-31 |\n| `common.dim_time` | 分钟 | 0–1439及15/30分钟时段 |\n| `common.dim_event` | 活动日期 | 4条", "source_unit": "PROJECT-DATA-ASSET-MODEL@src-0006", "line_start": 58, "line_end": 71}]

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
