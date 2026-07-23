---
name: shanghai-traffic-data-assets
description: Query and analyze the governed Shanghai Stadium multimodal traffic SQLite assets. Use for WGS84 metro or bus geometry, passenger flow, road states, unified ride-hailing and venue orders, weather, event dates, data coverage, quality, lineage, metrics, and cross-domain SQL.
---

# 上海交通数据资产

使用系统提示给出的 `query_assets.py` 查询分域 SQLite 资产。数据库目录由本地安装包提供；不要把当前任务目录误认为数据库目录。

## Agent 查询顺序

先发现，再查询。不要凭表名猜粒度、覆盖范围或坐标系。

```bash
PYTHON=/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10
QUERY="<Shanghai traffic query tools directory>/query_assets.py"

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
- 公交交易数、轨交人次、网约车事件和订单是不同量纲，不得相加为“综合总客流”。
- `rainfall_1h_mm` 是滚动一小时累计值；小时统计取最大值或平均值，不逐条求和。
- 四条活动记录只有日期，不得补写开演、进场或散场时刻。
- 原始订单号未分发，不得尝试恢复。

## 输出要求

回答数据问题时至少说明：

1. 使用的事实或集市对象；
2. 时间范围和粒度；
3. 实体与空间覆盖；
4. 指标单位；
5. CRS 及 `UNKNOWN`/推定记录处理；
6. 是否包含场馆补齐端点。

## 参考文件

- `references/coverage.md`：实际覆盖、行数和已知缺口。
- `references/schema.md`：表粒度、字段、主键和连接方式。
- `references/spatial.md`：WGS84 契约、场馆 CRS 推断和制图。
- `references/metrics.md`：指标口径和聚合限制。
- `references/governance.md`：血缘、质量、隐私和重建。

## 重建限制

日常查询不要运行构建脚本。只有用户明确要求重建且受控治理库路径已核实后，才按 `references/governance.md` 执行。构建会覆盖生成的 SQLite 数据库。
