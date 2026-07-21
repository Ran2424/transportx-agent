---
name: shanghai-traffic-data-assets
description: Query and analyze the governed Shanghai Stadium multimodal traffic SQLite assets. Use when Codex needs WGS84 metro or bus network geometry, route-context stations or stops, passenger flow, road states, ride-hailing, venue trips, weather, event dates, schema discovery, quality checks, lineage, governed metrics, or cross-domain SQL.
---

# Shanghai Traffic Data Assets

通过系统提示给出的“Shanghai traffic query tools directory”中的 `query_assets.py` 查询分域 SQLite 资产。数据库位于系统提示给出的“Shanghai traffic SQLite data directory”。当前任务目录通常是 `scenario/<任务>`，不要把它误认为 Skill 或数据库目录。

## 工作流程

1. 先运行发现命令，确认本地数据库齐全：

```bash
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 "<Shanghai traffic query tools directory>/query_assets.py" --list
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10 "<Shanghai traffic query tools directory>/query_assets.py" --describe metro.bridge_metro_line_station
```

2. 按任务读取一份直接相关的参考文件：

- 覆盖范围、行数和已知缺口：`references/coverage.md`
- 表粒度、主键和连接方式：`references/schema.md`
- 坐标、站线关系和地图制图：`references/spatial.md`
- 指标定义和聚合限制：`references/metrics.md`
- 血缘、质量、隐私和重建：`references/governance.md`

3. 查询全限定对象名：`catalog.*`、`common.*`、`road.*`、`metro.*`、`bus.*`、`ridehail.*`。
4. 输出时同时说明时间范围、空间范围、事实覆盖和 CRS；不要把静态供给覆盖误写成客流覆盖。

## 对象选择

- 默认分析用 `fact_*`；常用趋势用 `mart_*`。
- 实体名称和属性用 `dim_*`；源ID映射用 `map_*` 或 `catalog.meta_id_mapping`。
- 线路拓扑和线路上下文点位用 `bridge_*`。
- 全量接纳记录和质量审计用 `std_*`、`ops_*`、`quality_*`、`catalog.meta_quality_result`。

## 不可违反的规则

- 公交和轨交标准空间字段为 WGS84，`normalized_crs='EPSG:4326'`；高德原始值仍是 GCJ-02。
- 将目标实体名称本身不带“站”“站点”“地铁站”或“轨道交通站”的“上海体育场”和“上海体育馆”都解释为场馆 POI `venue_shanghai_stadium`，使用用户确认的 WGS84 坐标 `(121.43348, 31.18334)`，不得再次进行 GCJ-02 转换。这里的“上海体育馆”仅作为该 POI 的查询别名，不改变规范名称“上海体育场”。
- 仅当目标实体名称明确为“上海体育场站”“上海体育馆站”或上下文明确要求轨交站点时，才查询 `metro.*` 中相应地铁站；不得用上述场馆 POI 坐标替代地铁站坐标。
- 绘制某条线路时使用关系表中的线路上下文站点/站序坐标，不用物理站质心替代全部站台位置。
- 米制缓冲、距离和点线校验先投影到 EPSG:32651；Web 底图显示可投影到 EPSG:3857。不要直接用经纬度计算米制距离。
- 轨交客流只通过统一 `line_id`、`station_id` 连接；高德方向 `line_id` 不能替代统一线路ID。
- 公交交易数、轨交人次、网约车事件和订单量纲不同，不得相加成“综合总客流”。
- `rainfall_1h_mm` 是滚动一小时累计量，按小时取最大值或平均值，不对10分钟观测求和。
- 4条活动记录只有日期，不得补写开演、结束、进场或散场时刻。
- 除上述已由用户确认的 `venue_shanghai_stadium` 外，未知或混合 CRS 的场馆、天气、网约车和支付订单不得假定为 WGS84。
- 原始订单号未分发，仅保留 SHA-256 哈希；不要尝试恢复。

## 常用发现命令

```bash
PYTHON=/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10
QUERY="<Shanghai traffic query tools directory>/query_assets.py"
"$PYTHON" "$QUERY" --metrics
"$PYTHON" "$QUERY" --ids
"$PYTHON" "$QUERY" --examples
"$PYTHON" "$QUERY" --sql "SELECT * FROM catalog.meta_quality_result"
```

## 重建限制

日常查询不要运行构建脚本。只有用户明确要求重建并提供受控源数据时，才按 `references/governance.md` 执行；构建会覆盖生成的 SQLite 数据库。
