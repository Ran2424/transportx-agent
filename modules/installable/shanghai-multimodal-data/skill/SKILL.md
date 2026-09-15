---
name: shanghai-multimodal-traffic-data
description: Describe and query the 2026-08-24 Shanghai multimodal traffic snapshot covering metro, bus, taxi, ride-hailing, shared-bike, grid, and station-proximity data.
---

# 上海多方式交通数据

本模块提供 2026-08-24 上海多方式交通观测快照，包括轨道交通站点小时进出站量、公交线路小时客流、出租车与网约车网格小时指标、共享单车网格小时锁车量，以及地铁站与网格、公交线路和其他地铁站之间的预计算距离关系。

## 数据访问

会话通过 `TRANSPORTX_DATA_ASSETS_JSON` 注入 `data:shanghai-multimodal-20260824`。资产目录中的数据库文件为 `shanghai_text2sql_simplified_v1.db`。数据库只读使用，不依赖固定安装路径。

## 数据目录

| 内容 | 主要对象 | 详细说明 |
|---|---|---|
| 数据范围与规模 | 日期、交通方式、对象与记录数量 | `references/coverage.md` |
| 表结构与连接 | 十张表、字段、粒度和连接键 | `references/schema.md` |
| 指标口径 | 进出站、公交、出租车、网约车、单车与距离 | `references/metrics.md` |
| 分析场景 | 单领域、多方式、网格与站点周边分析 | `references/scenarios.md` |
| 空间关系 | GeoHash 7、缓冲范围、线路距离和站间距离 | `references/spatial.md` |
| 数据版本 | 快照来源、转换边界和完整性校验 | `references/provenance.md` |

## 基本口径

- 数据只覆盖 `2026-08-24`，业务时间按上海本地时间解释，不能据此推断长期趋势。
- `NULL` 表示对应网格小时没有该指标观测；`0` 表示已有观测且数值为零。
- 共享单车半小时观测已汇总到小时，其他事实表也是小时粒度。
- 地铁、公交、出租车、网约车和共享单车指标含义不同，不直接相加为综合客流。
- 空间范围按预计算的 `distance_m` 判断，不以 GeoHash 前缀代替距离关系。
- `metro_station.station_name` 不含“站”后缀。

## 查询产物

- 可以执行检查性查询，但 `query.sql` 只保存一条直接回答问题的最终只读查询；需要分步计算时使用 CTE。
- 最终查询只返回符合问题条件的完整结果行。候选集合、中间聚合、排名辅助列、质量检查、摘要行和合计行不进入最终结果，除非问题明确要求。
- 题目提示词列出的结果字段必须全部返回，并使用给定字段名；额外字段仅在直接属于答案时保留。
- `NUMBER` 字段必须保持 SQLite 数值类型。需要控制小数精度时使用数值表达式或 `ROUND`；不得使用 `printf`、字符串拼接或其他会生成 TEXT 的格式化方式。
- “最高”“最低”“Top K”和条件筛选必须在最终查询中完成；要求保留并列时返回全部并列结果。
- `result.csv` 保存执行 `query.sql` 得到的原始完整结果，不另行拼接、摘要或改写。

先根据分析内容选择对应 Reference，只加载当前问题需要的数据说明。
