---
name: shanghai-traffic-data-assets
description: Power the Major Event Traffic Situation Insight and Decision Support Agent with governed Shanghai Stadium multimodal traffic data. Use for the 2025 TNT concert case, event schedules, WGS84 networks, passenger flow, road states, unified ride-hailing and venue orders, weather, quality, metrics, and cross-domain SQL.
---

# 重大活动交通态势数据资产

本资产服务于“重大活动交通态势洞察及辅助决策智能体”，以上海体育场时代少年团演唱会为内置案例。会话上下文“已装载 Module 资源”会列出本 Skill 根目录和本资产 `data:shanghai-traffic` 的目录；使用该 Skill 根目录下的 `scripts/query_assets.py` 查询分域 SQLite 资产。正常会话通过 `TRANSPORTX_DATA_ASSETS_JSON` 注入全部 Data 资产，脚本只读取其中 `data:shanghai-traffic` 的目录；独立诊断时也可显式传入 `--data-root <Data 资产目录>`。脚本不会从 Skill 相邻目录寻找数据。

## Reference 文件位置（必须遵守）

- `<Skill 根目录>` 是会话上下文中此 `SKILL.md` 所在的目录。
- 所有 Reference 文件都位于 `<Skill 根目录>/references/`，例如 `<Skill 根目录>/references/metro.md`。
- `data:shanghai-traffic` 的资产根目录只包含数据库文件；**不得**从 `<Data 资产目录>/references/`、`assets/references/` 或当前任务目录读取 Reference。
- 读取 Reference 前，先以会话上下文给出的实际 Skill 根目录拼接路径；不要根据模块安装目录或资产目录自行猜测。

## 内置案例

活动名称：时代少年团「加冠礼」演唱会—「冠军」上海站。场馆：上海体育场。

| 日期 | 开始 | 结束 | 时区 |
|---|---|---|---|
| 2025-08-20 | 19:00 | 22:00 | Asia/Shanghai |
| 2025-08-21 | 19:00 | 22:00 | Asia/Shanghai |
| 2025-08-23 | 19:00 | 22:00 | Asia/Shanghai |
| 2025-08-24 | 19:00 | 22:00 | Asia/Shanghai |

[上海地铁保障指南](https://www.jfdaily.com/sgh/detail?id=1627654)明确四日每日 19:00—22:00；[上海市公安局公告](https://www.shanghai.gov.cn/nw31406/20250822/555caa8ba4894640ab88f64cbbf193ce.html)确认四个演出日和场馆。

态势分析建议分为演前集结、演中、散场三个阶段。若没有更具体的管控时间，默认使用 15:00—19:00、19:00—22:00、22:00—24:00 作为分析窗口；前后两个窗口是分析口径，不是官方开门或清场时间。2025-08-23 附近上海体育馆另有 UFC 赛事，解释当天异常时必须提示并发活动影响。

## Agent 查询顺序

先发现，再查询。不要凭表名猜粒度、覆盖范围或坐标系。

```bash
PYTHON="<会话上下文中的 Python 解释器>"
QUERY="<本 Skill 根目录>/scripts/query_assets.py"

"$PYTHON" "$QUERY" --coverage
"$PYTHON" "$QUERY" --business
"$PYTHON" "$QUERY" --order-sources
"$PYTHON" "$QUERY" --metrics
"$PYTHON" "$QUERY" --describe ridehail.fact_trip
```

查询 SQL 必须使用全限定对象名：`catalog.*`、`common.*`、`road.*`、`metro.*`、`bus.*`、`ridehail.*`。

## 先选对对象

- 订单数、OD、行程时长：`ridehail.fact_trip`。
- 上下车端点：`ridehail.fact_ridehail_event`。
- 场馆到场/离场事件：`ridehail.fact_venue_event`。
- 15分钟、小时、日趋势：相应 `mart_*`。
- 名称和属性：`dim_*`。
- 线路站序和线路上下文点位：`bridge_*`。
- 源 ID 映射：`map_*` 或 `catalog.meta_id_mapping`。
- 全量接纳、异常和血缘审计：`std_*`、`ops_*`、`quality_*`、`catalog.meta_quality_result`。

## 网约车与场馆订单

上车表、下车表、场馆离场表和场馆到场表来自同一订单体系。四类来源按订单号合并到 `ridehail.std_trip`，每个订单只存一行；订单号只保留 SHA-256 哈希。

场馆订单不是第二份订单事实：

- `fact_venue_trip` 是 `fact_trip` 中 `venue_relation <> 'NONE'` 的子集。
- `fact_ridehail_event` 是统一订单拆出的上、下车端点。
- `fact_venue_event` 按业务方向选择到场的下车端或离场的上车端。
- 统计订单必须数 `fact_trip`，不能把两个端点数成两单。
- 同时命中两个场馆源但核心字段不一致的订单保留 `venue_source_conflict=1`；默认值按场馆离场源优先。

`fact_ridehail_event.endpoint_source` 区分：

- `RIDEHAIL_SOURCE`：端点原本存在于上车表或下车表；
- `VENUE_ENRICHMENT`：端点由场馆完整订单补齐。

聚合表中的 `source_event_count` 只统计原始上/下车来源，`event_count` 包含补齐后的全部订单端点。两者不能混用。

## 时间与坐标契约

- 全部业务时间解释为 `Asia/Shanghai` 本地时间。
- `date_key` 为 `YYYYMMDD` 整数；`minute_key` 为 0—1439 的日内分钟。
- 15分钟桶使用 `slot_15_start`，小时使用 `hour`，日期使用 `date_key`。
- 发布资产唯一标准坐标系为 WGS84，即 `EPSG:4326`。
- 已确认的 GCJ-02、BD-09、EPSG:32651 坐标在构建时转换为 WGS84；发布表不保留第二套源坐标列。
- 无法确认 CRS 的记录不删除，`crs='UNKNOWN'`，并用 `coordinate_status` 说明原因。此类记录不得用于距离、缓冲、最近邻或跨域空间连接。

## EVDATA 道路速度

2025-08-18—2025-08-24 的 EVDATA 数据单独发布为 `road.dim_evdata_road_segment` 和
`road.fact_evdata_road_speed_15m`：207 个上海体育场周边路段、98,738 条路段—15分钟时刻记录。
GeoJSON 明确为 CRS84，按 `EPSG:4326` 发布。EVDATA `roadid` 与原有 89 个道路状态发布段
不是同一套 ID，未建立权威映射前不得强行合并。

用户已确认 `speed_avg` 的单位为 km/h。数据中没有大于 120 km/h 的记录。
207 个路段—7 天共 1,449 个路段日，其中 390 个覆盖全天 96 个时槽；
其余缺失表示未观测，不能补零。

如果需要涉及到道路相关的数据，优先使用 EVDATA 的数据。

## 上海地铁线路配色

只要可视化使用上海地铁线路作为视觉编码，就必须按线路名称使用下表颜色，不改用通用分类色板。

| 线路 | Web 十六进制色值 | 线路 | Web 十六进制色值 |
| --- | --- | --- | --- |
| 1 号线 | `#E3022C` | 10 号线 | `#C6AFD4` |
| 2 号线 | `#83C026` | 11 号线 | `#881C2C` |
| 3 号线 | `#FBD500` | 12 号线 | `#007860` |
| 4 号线 | `#461E84` | 13 号线 | `#E899C0` |
| 5 号线 | `#944D9A` | 14 号线 | `#626021` |
| 6 号线 | `#E20067` | 15 号线 | `#C9B28F` |
| 7 号线 | `#ED7001` | 16 号线 | `#98D2C0` |
| 8 号线 | `#0094D8` | 17 号线 | `#BB7970` |
| 9 号线 | `#88CAEC` | 18 号线 | `#C4984F` |
| 浦江线 | `#B5B5B6` |  |  |

这些值来自上海市政府发布、由上海申通地铁集团提供的[上海轨道交通网络示意图](https://english.shanghai.gov.cn/en-Latest-WhatsNew/20240924/b625d488216241f78f743cd87a40df0c.html)，并按图像内嵌 ICC 配置转换为 Web sRGB。设置线路颜色时使用 Geo 模块的 `set_categorical`；磁浮、市域线或新线路应先核对最新官方线路图。

## 重要交通枢纽 POI

使用 `common.dim_poi` 查询用户确认的重要场站中心点；这些坐标均为 WGS84（`EPSG:4326`），不得再次做 GCJ-02 转换。名称匹配时同时检查 `aliases`。

| `poi_key` | 标准名称 | 常用别名 | 类型 | 经度 | 纬度 |
|---|---|---|---|---:|---:|
| `poi_shanghai_railway_station` | 上海火车站 | 上海站 | `RAILWAY_STATION` | 121.45088 | 31.25145 |
| `poi_shanghai_south_railway_station` | 上海南站 | 火车南站、上海火车南站 | `RAILWAY_STATION` | 121.41757 | 31.14980 |
| `poi_shanghai_hongqiao_railway_station` | 上海虹桥站 | 虹桥站、虹桥火车站 | `RAILWAY_STATION` | 121.314 | 31.194 |
| `poi_shanghai_pudong_international_airport` | 上海浦东国际机场 | 浦东机场 | `AIRPORT` | 121.80528 | 31.14333 |

这些记录是交通枢纽 POI，不等同于同名轨交站。轨交客流仍使用 `metro.dim_metro_station` 的统一 `station_id`。

场馆订单的端点 CRS 按以下证据顺序确定：

1. 能按订单号回连上车表或下车表时，继承对应端点的显式 CRS；
2. 回连到未知标识时保留为 `UNKNOWN`；
3. 无法回连时，依据场馆数据集中绝大多数可回连端点为 GCJ-02 的结果，按 GCJ-02 推定并转换；字段标记为 `ASSUMED_GCJ02_FROM_DATASET_MAJORITY`。

推定不等于来源确认。精确空间分析应报告 `coordinate_status` 的组成。

## 不可违反的口径

- 场馆“上海体育场”和本资产中的查询别名“上海体育馆”指 `venue_shanghai_stadium`，使用用户确认的 WGS84 坐标 `(121.43348, 31.18334)`，不得再次做 GCJ-02 转换。
- 只有名称明确为“上海体育场站”“上海体育馆站”或上下文明确指轨交站时，才使用 `metro.*`。
- 线路制图使用关系表中的线路上下文站序坐标，不用物理站质心替代所有站台位置。
- 米制缓冲和距离先投影到 `EPSG:32651`；Web 显示可投影到 `EPSG:3857`。不要在经纬度上直接计算平面米制距离。
- 轨交客流只通过统一 `line_id`、`station_id` 连接；高德方向 ID 不能替代统一线路 ID。
- 轨交客流事实和日集市都是“线路—物理站”粒度。回答“某站”客流、峰值或排名时，必须先按 `station_id` 聚合其全部 `line_id`，再排序或取峰值；**严禁**直接对 `fact_metro_station_hour.total_flow`、`outbound_flow` 或 `mart_metro_station_day.peak_hour_flow` 排序后称为“某站”结果。站点小时问题用 `fact_metro_station_hour` 按 `date_key, hour, station_id` 聚合；站点日问题用 `mart_metro_station_day` 按 `date_key, station_id` 聚合。只有用户明确问“某线路在某站”时才保留 `line_id`。除非用户询问计算口径，否则不在题目或答案中暴露这一实现细节；具体 SQL 模板见 `references/metro.md`。
- 公交交易数、轨交人次、网约车事件和订单是不同量纲，不得相加为“综合总客流”。
- `rainfall_1h_mm` 是滚动一小时累计值；小时统计取最大值或平均值，不逐条求和。
- 四场演唱会均为 19:00—22:00；进场、交通管制和疏散窗口不得冒充演出开始/结束时间。
- 原始订单号未分发，不得尝试恢复。
- EVDATA 平均速度与原有 `FREE/CROWD/JAM` 状态是两套独立口径；未建立路段映射前不得互相换算或拼接。

## 输出要求

回答数据问题时至少说明：

1. 使用的事实或集市对象；
2. 时间范围和粒度；
3. 实体与空间覆盖；
4. 指标单位；
5. CRS 及 `UNKNOWN`/推定记录处理；
6. 是否包含场馆补齐端点。

## 参考文件

先读整体说明，再只加载本次查询涉及的分库 Reference。以下路径均相对于 `<Skill 根目录>`，不是 Data 资产目录：

- `references/coverage.md`：实际覆盖、行数和已知缺口。
- `references/schema.md`：表粒度、字段、主键和连接方式。
- `references/spatial.md`：WGS84 契约、场馆 CRS 推断和制图。
- `references/metrics.md`：指标口径和聚合限制。
- `references/governance.md`：血缘、质量、隐私和重建。
- `references/catalog.md`：目录库的表、字段、质量和发现查询。
- `references/common.md`：公共维度、活动日期、场馆和天气表。
- `references/road.md`：道路状态事件与小时、日持续时间表。
- `references/metro.md`：轨交线路、站点、映射和客流表。
- `references/bus.md`：公交线路、站序和交易表。
- `references/ridehail.md`：统一订单、端点、场馆事件和集市表。

## 重建限制

日常查询不要运行构建脚本。只有用户明确要求重建且受控治理库路径已核实后，才按 `references/governance.md` 执行。构建会覆盖生成的 SQLite 数据库。
