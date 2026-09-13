---
name: shanghai-hub-traffic-data
description: Query governed Shanghai airport and railway-hub traffic data for train arrivals and departures, Hongqiao metro flow, arrival forecasts, evacuation modes, taxi yards, site flow, and ride-hailing demand around National Day and the May Day sample period. Do not use for Shanghai Stadium event traffic, which belongs to the separate Shanghai event data skill.
---

# 上海枢纽交通数据

本资产服务于上海“两场三站”及扩展枢纽分析。正常会话通过 `TRANSPORTX_DATA_ASSETS_JSON` 注入 Data 资产；使用其中的 `data:shanghai-hub-traffic`，并以本 Skill 根目录下的 `scripts/query_assets.py` 只读查询。不要写死安装路径，也不要从 Skill 相邻目录猜测 Data 资产位置。

## 查询顺序

先确认覆盖和口径，再查询业务对象：

```bash
PYTHON="<会话上下文中的 Python 解释器>"
QUERY="<本 Skill 根目录>/scripts/query_assets.py"

"$PYTHON" "$QUERY" --coverage
"$PYTHON" "$QUERY" --metrics
"$PYTHON" "$QUERY" --quality
"$PYTHON" "$QUERY" --business
```

SQL 使用全限定对象名：`catalog.*`、`common.*`、`rail.*`、`forecast.*`、`hubops.*`、`ridehail.*`。

## 选择数据对象

- 铁路到达、出发和上下客：`rail.fact_train_stop`；半小时和日分析优先用 `rail.mart_train_hub_halfhour`、`rail.mart_train_hub_day`。
- 虹桥地铁日客流：`rail.fact_metro_station_flow_day` 或物理站汇总 `rail.mart_metro_station_day`。
- 到达客流预测：`forecast.fact_arrival_forecast_version`；最新版本用 `forecast.latest_arrival_forecast_hour`。
- 疏散方式比例：`forecast.fact_evac_mode_ratio_version`；先检查完整性和比例和。
- 出租车蓄车场：`hubops.fact_taxi_yard_state`；半小时用 `hubops.mart_taxi_yard_halfhour`。
- 虹桥功能点流量：`hubops.fact_site_flow_observation`。指标窗口未确认时不要跨时点求和。
- 网约车当前需求：`ridehail.fact_ridehail_demand_snapshot`。
- 网约车 3/5/10 分钟订单：`ridehail.fact_ridehail_order_window`。
- 网约车撮合：`ridehail.fact_ridehail_match_snapshot`。
- 来源、关系、冲突和质量：`catalog.meta_*`。

## 不可违反的口径

- 默认“两场三站”铁路范围是 AOH、SHH、SNH；IMH 上海松江站属于扩展范围，需单列或明确纳入。
- 五一铁路表是样例快照，不进入默认生产事实。需要审计时查 `rail.std_train_stop`。
- 同一目标时点的不同 `issued_at` 是预测版本，不是重复。回答预测问题时说明使用最新版本还是指定发布时间。
- 半小时铁路到达用到站时刻和 `GET_OFF` 口径，不能把小时预测均分成两个半小时。
- `AVG_WAITING_TIME` 按现有证据只可称为出租车蓄车等客时间，不能称为旅客候车时间。
- `ZT`、`FSTR_ZT`、`FSTR_QBB_ZT`、`STATUS` 的业务码表未确认，只输出原始代码。
- `INNUM`、`TRAFFICNUM` 的统计窗口未确认。不同采样间隔的记录不得直接求和为日客流。
- 缺测与真实零分开；不得补零。
- 疏散比例缺项、全零或比例和异常时，不计算方式人数。

## 输出要求

回答至少说明使用对象、时间范围、粒度、实体范围、单位、生产或样例角色，以及影响结论的质量警告。

## References

- 整体表结构和连接键：`references/schema.md`
- 覆盖范围和缺口：`references/coverage.md`
- 指标定义与限制：`references/metrics.md`
- 冲突、质量、血缘和重建：`references/governance.md`
- 铁路和轨交查询：`references/rail.md`
- 预测查询：`references/forecast.md`
- 出租车与断面查询：`references/taxi.md`
- 网约车查询：`references/ridehail.md`

## 重建限制

日常查询不得运行构建脚本。只有用户明确要求重建，且源目录和输出目录已核实时，才能按 `references/governance.md` 执行。构建会替换目标 SQLite。
