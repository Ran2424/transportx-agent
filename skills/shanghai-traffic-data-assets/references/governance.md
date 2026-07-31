# 数据治理、质量与重建

## 导航

- [标准](#标准)
- [订单来源合并](#订单来源合并)
- [质量处理](#质量处理)
- [统一 ID](#统一-id)
- [隐私与查询边界](#隐私与查询边界)
- [查询质量结果](#查询质量结果)
- [分发与重建](#分发)

## 标准

| 事项 | 标准 |
|---|---|
| 资产版本 | 3.1.0 |
| 业务时区 | Asia/Shanghai |
| 发布坐标系 | EPSG:4326 |
| 未知坐标 | 保留记录并标 `UNKNOWN`，不得用于精确空间运算 |
| 订单实体 | 四类订单源按订单号合并，一单一行 |
| 订单标识 | 只发布 SHA-256 `order_hash` |
| 趋势层 | 15分钟、小时、日预聚合 |

## 订单来源合并

四类源代码：

- `RHD`：上车表；
- `RHA`：下车表；
- `PFV`：场馆离场完整订单；
- `PTV`：场馆到场完整订单。

合并步骤：

1. 每张源表先按订单号选择规范记录，同时统计源内重复行。
2. 四张表取订单号并集。
3. 场馆完整订单优先提供完整上下车时间、坐标和地点；同一订单同时命中两个场馆源时以 PFV 为优先值，并标记核心字段冲突。
4. 生成一个 `std_trip` 记录，保留 `source_coverage`、`venue_relation`、`source_duplicate_count` 和质量状态。
5. 从统一订单派生事件、场馆视图和集市，不再维护第二份场馆订单事实。

这个模型避免两类错误：把同一订单重复存储，以及把上、下车两个端点误计为两笔订单。

## 质量处理

- 逻辑删除订单不进入默认事实。
- 源内重复行汇总到 `source_duplicate_count`，本次共 647 行。
- 同时命中两个场馆源的 95,863 个订单中，9 个核心字段冲突，保留并标记 `venue_source_conflict=1`。
- 无效时间和超出上海合理范围的坐标留在标准层，默认订单事实排除。
- CRS 未知记录保留在事实中，字段明确标记。
- 事件采用端点级质量过滤；订单采用整单质量过滤。
- `catalog.meta_quality_result` 保存本次构建的规则结果。

错误级规则要求全部通过，当前包括：

- 32 个源数据集全部登记；
- 公交线路、轨交站点和高德轨交站点 ID 映射完整；
- 公交/轨交发布空间对象为 WGS84；
- 发布资产 CRS 只有 EPSG:4326/UNKNOWN，且无源坐标副本列；
- 点线距离规则通过；
- 默认事实不暴露原始业务 ID；
- 原始订单号不进入 Agent 资产。

## 统一 ID

- 轨交使用稳定 `line_id`、`station_id`。
- 高德方向/支线路径使用独立 `route_direction_id`，再映射统一线路。
- 公交官方站点与高德站点缺少可靠一一映射时，用 `OFFICIAL:`、`AMAP:` 前缀防碰撞。
- 订单使用不可逆 SHA-256 哈希；不发布原始订单号。
- 源 ID 只用于标准层、映射表和目录审计。

## 隐私与查询边界

- 订单级精确时间、坐标和地点属于敏感数据。一般分析优先使用 15 分钟、小时或日集市。
- 输出明细前确认用途和最小必要字段，不默认展示地点文本或精确坐标。
- 数据库和原始治理库不提交 Git。
- 数据集是徐汇/上海体育场相关样本，不可外推为上海全市订单或客流总量。

## 查询质量结果

```bash
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 \
  "<Shanghai traffic query tools directory>/query_assets.py" \
  --sql "SELECT r.severity,q.* FROM catalog.meta_quality_result q JOIN catalog.meta_quality_rule r USING(rule_code) ORDER BY r.severity,q.rule_code"
```

已知警告和数量见 `coverage.md`。

## 分发

- 本地安装包可包含 `assets/databases/*.sqlite`。
- Git 只版本化 SKILL、参考文档和脚本；数据库由 `.gitignore` 排除。
- 数据库缺失时，`query_assets.py` 会停止并报告缺少的文件。

## EVDATA 接入

EVDATA 路段 GeoJSON 与速度 CSV 使用独立导入脚本，脚本会校验 CRS、字段、路段 ID 全覆盖、
15 分钟对齐和复合主键唯一性，并同步更新 `road.sqlite` 与 `catalog.sqlite`。

```bash
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 \
  "<Shanghai traffic query tools directory>/import_evdata_road_speed.py" \
  --csv "/absolute/path/时代少年团数据.csv" \
  --geojson "/absolute/path/road_segment_80000.geojson"
```

导入是幂等的：只替换三个 EVDATA 对象和对应目录记录，不修改原道路状态表。
源速度单位未声明，因此资产登记为 `UNKNOWN`；高值只标警告，不静默删除。

## 重建

构建会删除并重建目标 SQLite 文件。只有用户明确要求、源治理库已核实且允许覆盖生成资产时执行。

```bash
SHANGHAI_TRAFFIC_SOURCE_DB=/absolute/source/traffic_governance.sqlite \
SHANGHAI_TRAFFIC_SKILL_DIR=/absolute/skill/path \
SHANGHAI_TRAFFIC_EVDATA_SPEED_CSV=/absolute/path/时代少年团数据.csv \
SHANGHAI_TRAFFIC_EVDATA_ROAD_GEOJSON=/absolute/path/road_segment_80000.geojson \
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 \
  "<Shanghai traffic query tools directory>/build_agent_data_assets.py"
```

两个 EVDATA 环境变量必须同时提供或同时省略。省略时只重建原治理库资产；提供时会在基础资产验证后接入 EVDATA。

重建后至少运行：

```bash
PYTHON=/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10
QUERY="<Shanghai traffic query tools directory>/query_assets.py"

"$PYTHON" "$QUERY" --coverage
"$PYTHON" "$QUERY" --order-sources
"$PYTHON" "$QUERY" --business
"$PYTHON" "$QUERY" --sql "SELECT * FROM catalog.meta_quality_result"
```

还要验证：

- `std_trip` 行数等于四源订单号并集；
- `COUNT(*) = COUNT(DISTINCT order_hash)`；
- 所有端点集市满足 `event_count = source_event_count + venue_enriched_event_count`；
- 所有 SQLite 文件 `PRAGMA integrity_check` 返回 `ok`。
