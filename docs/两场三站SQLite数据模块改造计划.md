# “两场三站”SQLite 数据模块改造计划

**编制日期**：2026-09-12
**目标**：将“铁路和轨交”“五一前后样例”“20250920-1021”三个数据包整理为可安装的 TransportX Module，提供标准 Skill 和 Data 资产，支持受控查询、数据治理、版本追踪和后续增量更新。

## 1. 方案结论

建议新建独立模块：

```text
com.transportx.shanghai-hub-traffic
```

建议 Data 资产 ID：

```text
data:shanghai-hub-traffic
```

不建议直接扩充 `com.transportx.shanghaidata`。现有模块面向上海体育场重大活动，主要覆盖道路、公交、轨交、天气和订单；本批数据面向机场、铁路枢纽、现场断面、预测、出租车场和网约车运行。两者的源系统、时间范围、业务粒度和质量规则不同。独立模块可以避免资产 ID、表名、版本和查询路由冲突，并允许两个模块同时加载。

发布资产采用参考模块已经验证的模式：

```text
一个 Module
  ├── 一个查询 Skill
  ├── 多个分域 SQLite
  ├── 一个 catalog.sqlite
  └── 一个 SHA256SUMS.txt
```

构建过程分为两部分：

1. 非发布的治理构建库保存原始接入、冲突、转换和质量结果。
2. 发布 Data 资产只保留 Agent 查询需要的标准维度、事实、集市和目录元数据。

## 2. 范围与成功标准

### 2.1 纳入范围

- 15 个源数据文件，3,602,908 条物理记录。
- 铁路列车停站、虹桥轨交日客流。
- 到达客流预测及其滚动版本。
- 小时和日疏散方式比例。
- 虹桥功能点断面流量。
- 出租车蓄车场状态。
- 网约车当前需求、窗口订单和撮合指标。
- 三个压缩包、源文件、Sheet 和 SQL 条件页的血缘信息。

### 2.2 不纳入默认发布事实

- `RT_VW` 出租车场文件中的重复记录。文件血缘保留，数据不重复发布。
- 五一铁路样例中与正式全年表重叠的记录。样例保留在标准审计层，不进入默认生产事实。
- 不能确认口径的派生日累计，例如对高频 `INNUM` 或 `TRAFFICNUM` 直接求和。
- 推测得到的旅客出租车等待时间。现有数据没有该指标。

### 2.3 验收标准

1. 每个源文件的物理行数、字段数和 SHA-256 均登记到 Catalog。
2. 默认事实中不存在业务键重复；预测版本不会被覆盖。
3. 样例、生产、重复副本和异常记录可以区分并追溯到源文件和源行。
4. 所有发布 SQLite 的 `PRAGMA integrity_check` 返回 `ok`。
5. 所有错误级质量规则通过后才生成 `SHA256SUMS.txt`。
6. Skill 能通过 `TRANSPORTX_DATA_ASSETS_JSON` 找到资产，不包含用户绝对路径。
7. 参考问题均有经过验证的 SQL；数据不支持的问题由 Skill 明确说明缺口。
8. Module Manifest 解析成功，Registry 无错误，安装并启用后能在新会话中查询。

## 3. Module 目录

建议源码目录：

```text
modules/installable/shanghai-hub-traffic/
├── manifest.json
├── skill/
│   ├── SKILL.md
│   ├── agents/
│   │   └── openai.yaml
│   ├── references/
│   │   ├── coverage.md
│   │   ├── schema.md
│   │   ├── metrics.md
│   │   ├── governance.md
│   │   ├── rail.md
│   │   ├── forecast.md
│   │   ├── taxi.md
│   │   └── ridehail.md
│   └── scripts/
│       ├── build_governance_db.py
│       ├── build_agent_data_assets.py
│       ├── query_assets.py
│       └── validate_assets.py
└── assets/
    └── databases/
        ├── catalog.sqlite
        ├── common.sqlite
        ├── rail.sqlite
        ├── forecast.sqlite
        ├── hubops.sqlite
        ├── ridehail.sqlite
        └── SHA256SUMS.txt
```

`assets/databases/` 和生成的 SQLite 不进入 Git。Git 只保存 manifest、Skill、References、构建脚本和测试。交付或安装包包含 SQLite 和校验清单。

## 4. Manifest 设计

首个可安装版本建议为 `1.0.0`：

```json
{
  "manifestVersion": 2,
  "id": "com.transportx.shanghai-hub-traffic",
  "name": "Shanghai Hub Traffic Data",
  "version": "1.0.0",
  "type": "module",
  "platformVersion": ">=3.0.0 <4.0.0",
  "dependencies": [],
  "entrypoints": {
    "skills": ["skill/SKILL.md"]
  },
  "contributes": {
    "assets": [
      {
        "id": "data:shanghai-hub-traffic",
        "kind": "data",
        "path": "assets/databases",
        "integrityFile": "assets/databases/SHA256SUMS.txt",
        "required": false
      }
    ]
  }
}
```

当前数据没有坐标和空间几何，不需要强制依赖 Geo。以后增加站点坐标、空间分析或地图工具时，再提升 minor 版本并增加 `com.transportx.geo` 依赖。

## 5. 数据库拆分

### 5.1 `catalog.sqlite`

Catalog 是 Agent 发现资产和治理审计的入口。复用参考模块的对象命名：

| 对象 | 内容 |
|---|---|
| `meta_build` | 资产版本、构建时间、Python 版本、时区和构建参数 |
| `meta_database` | 分库文件、用途、大小和 SHA-256 |
| `meta_table` | 表或视图、治理层、行数和中文说明 |
| `meta_column` | 字段名、类型、非空、主键位置和业务说明 |
| `meta_source_dataset` | 源文件、Sheet、源粒度、行数和目标对象 |
| `meta_source_file` | 压缩包、成员文件、哈希、大小、角色和重复关系 |
| `meta_relationship` | 跨库连接关系和基数 |
| `meta_entity_id` | 枢纽、铁路站、地铁站、功能点和蓄车场 ID 策略 |
| `meta_id_mapping` | 源代码到统一 ID 的映射及置信度 |
| `meta_metric` | 指标名称、单位、粒度、窗口和聚合限制 |
| `meta_analysis_guide` | 各领域推荐表、覆盖范围和限制 |
| `meta_quality_rule` | ERROR/WARN 质量规则 |
| `meta_quality_result` | 本次构建的检查结果和观测值 |
| `meta_conflict_summary` | 冲突类型、记录数、默认选择规则 |
| `meta_query_example` | 验证过的问题和 SQL |

`meta_column` 建议比参考模块多保存 `description_cn`、`unit`、`nullable_reason`，使 Agent 不需要仅凭英文列名判断含义。

### 5.2 `common.sqlite`

| 对象 | 粒度 | 主要字段 |
|---|---|---|
| `dim_date` | 一天 | `date_key`、日期、星期、节假日、调休、分析分段 |
| `dim_time` | 一分钟 | `minute_key`、小时、分钟、15/30/60 分钟桶 |
| `dim_hub` | 一个枢纽 | 统一 ID、代码、名称、机场/铁路、是否属于“两场三站” |
| `dim_location` | 一个场所或点位 | 统一 ID、类型、上级枢纽、标准名称 |
| `map_source_location` | 一个源代码映射 | 源系统、源代码、上下文、统一 ID、匹配方式 |
| `dim_transport_mode` | 一种交通方式 | 轨交、公交、出租车、网约车、私家车、步行 |
| `dim_analysis_period` | 一个分析分段 | 国庆前、核心期、国庆后及起止时间 |

`dim_hub` 初始包含：

| 代码 | 标准名称 | 类型 | 默认“两场三站”范围 |
|---|---|---|---|
| PVG | 上海浦东国际机场 | AIRPORT | 是 |
| SHA | 上海虹桥国际机场 | AIRPORT | 是 |
| AOH | 上海虹桥站 | RAILWAY_STATION | 是 |
| SHH | 上海站 | RAILWAY_STATION | 是 |
| SNH | 上海南站 | RAILWAY_STATION | 是 |
| IMH | 上海松江站 | RAILWAY_STATION | 否，扩展范围 |

铁路表中的其他 14 个站、7 个地铁线路站点组合、49 个功能点和 3 个蓄车场进入 `dim_location`。名称不能作为唯一键；当前 49 个功能点只有 48 个名称。

### 5.3 `rail.sqlite`

| 对象 | 粒度 | 用途 |
|---|---|---|
| `std_train_stop` | 一个源批次中的开行日期—车次—车站 | 保存正式和样例记录、来源、冲突和质量状态 |
| `fact_train_stop` | 正式数据中的开行日期—车次—车站 | 默认铁路到发、时刻和客流查询 |
| `fact_metro_station_flow_day` | 日期—线路—地铁站 | 虹桥轨交日客流 |
| `mart_train_hub_halfhour` | 日期—半小时—铁路枢纽 | 到达列次、下车人数、出发列次、上车人数 |
| `mart_train_hub_day` | 日期—铁路枢纽 | 日到达、日出发和日到发总量 |
| `mart_metro_station_day` | 日期—物理站 | 对同一物理站的多线路记录汇总 |

铁路自然键：

```text
(departure_date, train_code, station_code)
```

`train_code`、`station_code`、地铁 `line_id` 和 `station_id` 全部使用 `TEXT`，保留前导零和字母。

`fact_train_stop` 默认以全年 CSV 为权威来源。五一样例的 82,178 行保留在 `std_train_stop`：82,153 个键与正式表重合，25 个键仅出现在样例。默认事实不使用样例补生产缺口，避免样例数据混入正式指标。

### 5.4 `forecast.sqlite`

| 对象 | 粒度 | 用途 |
|---|---|---|
| `std_arrival_forecast` | 源记录 | 保存原始文本、样例/生产角色和质量状态 |
| `fact_arrival_forecast_version` | 枢纽—目标小时—发布时间 | 保留所有预测版本 |
| `latest_arrival_forecast_hour` | 枢纽—目标小时 | 选择该目标时点的最新版本 |
| `std_evac_ratio` | 枢纽—目标时点—发布时间 | 保存五种方式宽表和原始缺失 |
| `fact_evac_mode_ratio_version` | 枢纽—目标时点—发布时间—方式 | 按方式查询的长表视图 |
| `latest_evac_mode_ratio_hour` | 枢纽—目标小时—方式 | 最新版本及完整性状态 |

到达预测唯一键：

```text
(hub_id, predicted_at, issued_at, ingestion_batch_id)
```

2025 批次每个目标小时有 168 个版本，预测时距为 0–167 小时。`issued_at` 不得被删除。五一样例只有单版本，通过 `dataset_role='SAMPLE'` 区分。

疏散比例在 `std_evac_ratio` 中保留宽表，避免扩大物理存储；`fact_evac_mode_ratio_version` 可以用 `UNION ALL` 视图转成长表。每条版本保存：

- `available_mode_count`
- `ratio_sum`
- `is_complete`
- `ratio_quality_status`

比例缺失、全零、合计不等于 1 或大于 1 的记录均保留，但默认方式需求计算只使用通过明确质量规则的记录。

### 5.5 `hubops.sqlite`

| 对象 | 粒度 | 用途 |
|---|---|---|
| `std_site_flow_observation` | 功能点—观测时间—源指标 | 统一接纳 `INNUM` 和 `TRAFFICNUM` |
| `fact_site_flow_observation` | 通过基本类型和键检查的观测记录 | 高频断面查询 |
| `fact_taxi_yard_state` | 蓄车场—5 分钟时点 | 容量、进出、在蓄、司机等客和状态 |
| `mart_taxi_yard_halfhour` | 蓄车场—半小时 | 平均/最大在蓄、进出量和平均司机等客时间 |

`INNUM` 和 `TRAFFICNUM` 不直接合并为同一个含义。统一表中使用不同 `metric_code`，并保存：

- `observed_value`
- `source_metric_name`
- `declared_window_minutes`
- `observed_interval_seconds`
- `window_status`

在业务方确认它们是瞬时值、离散区间值或滚动累计值之前，不生成日累计断面客流。

出租车场只导入 `V_ZHZX_RHPT_XYC_CURRENT_NUMBER_RT.xlsx`。`RT_VW` 在 Catalog 中登记为 `EXACT_DUPLICATE`，指向同一内容摘要。

`AVG_WAITING_TIME` 发布名称应为 `driver_queue_wait_minutes` 或保留原名并标注“疑似司机蓄车等客时间”。不得解释为旅客候车时间。

### 5.6 `ridehail.sqlite`

| 对象 | 粒度 | 用途 |
|---|---|---|
| `fact_ridehail_demand_snapshot` | 枢纽—15 分钟时点 | 当前用车需求和原始状态码 |
| `std_ridehail_order_window` | 枢纽—时点—源宽表 | 保存 THREE/FIVE/TEN 原值 |
| `fact_ridehail_order_window` | 枢纽—时点—窗口分钟数 | 3/5/10 分钟订单长表 |
| `fact_ridehail_match_snapshot` | 范围—5 分钟更新时间 | 创建、识别、匹配、比率和耗时 |
| `mart_ridehail_hub_hour` | 枢纽—小时 | 需求平均、峰值、订单窗口指标 |
| `mart_ridehail_hub_day` | 枢纽—日期 | 日均、峰值和缺测率 |

`ZT`、`STATUS` 只发布原始状态码和 `status_definition_status='UNCONFIRMED'`。码表确认后通过映射表增加告警等级，不回写历史原码。

## 6. 类型和时间标准

### 6.1 SQLite 类型

| 数据 | 类型 | 规则 |
|---|---|---|
| 代码、车次、线路和站点 ID | `TEXT` | 禁止数值化，保留前导零 |
| 本地时间 | `TEXT` | ISO 8601：`YYYY-MM-DD HH:MM:SS[.fff]` |
| 日期键 | `INTEGER` | `YYYYMMDD` |
| 日内分钟 | `INTEGER` | 0–1439 |
| 人数、车辆、订单、列次 | `INTEGER` | 标准事实中非负；异常保留在 std |
| 比例、时长 | `REAL` | 不对异常值静默裁剪 |
| 布尔标记 | `INTEGER` | `CHECK (value IN (0,1))` |
| 哈希 | `TEXT` | 小写 SHA-256 十六进制 |

所有业务时间按 `Asia/Shanghai` 解释。由于源文件没有时区字段，假设写入 `meta_build` 和 `coverage.md`。日期字符串中的午夜简写统一为 `00:00:00`。

### 6.2 通用血缘字段

所有 `std_*` 表至少包含：

```text
record_key
ingestion_batch_id
source_dataset_id
source_file_sha256
source_sheet
source_row_number
source_record_hash
dataset_role
quality_status
```

`dataset_role` 使用 `PRODUCTION`、`SAMPLE`、`DUPLICATE_COPY`。发布事实保留 `record_key` 或来源字段，使任意指标都能回溯到标准记录。

## 7. 冲突处理

### 7.1 原则

1. 原始记录不覆盖。
2. 完全相同的记录只发布一次，但所有来源关系保留。
3. 业务键相同、字段不同的记录标为冲突，不自动拼接成无来源的新记录。
4. 预测的不同发布时间是有效版本，不是冲突。
5. 样例数据不补生产数据缺口，除非用户显式选择样例视图。
6. 空值不覆盖非空值；真实零与缺失分开。
7. 名称只用于展示，统一代码用于关联。

### 7.2 已知冲突规则

| 冲突 | 处理 |
|---|---|
| 出租车 `RT` 与 `RT_VW` 完全一致 | `RT` 作为发布来源；`RT_VW` 只登记血缘 |
| 五一铁路与全年铁路 82,153 个键重合 | 全年生产表进入默认事实；样例留在 std |
| 25,198 条重叠铁路记录晚点字段不同 | 写入 `LATE_FIELD_CONFLICT`，不覆盖生产值 |
| 五一样例有 25 个生产表不存在的键 | 保留为 `SAMPLE_ONLY`，默认事实排除 |
| `AOH       ` 带尾随空格 | std 保留原值；统一键使用 `TRIM` 后代码 |
| 站点或点位同名 | 不按名称合并；使用源代码和上下文映射 |
| 预测同目标时点多版本 | `issued_at` 进入唯一键，全部保留 |

## 8. 数据质量门禁

### 8.1 ERROR 规则

- 所有源文件有 SHA-256、行数和字段清单。
- Excel 实际数据区被完整读取，不能相信错误的 `dimension ref="A1"`。
- 标准事实自然键唯一。
- 所有统一枢纽和点位代码能映射到维度。
- 日期和时间转换失败数为 0，或失败记录只停留在 std。
- 地铁 `daily_flow = in_flow + out_flow`。
- 预测版本键唯一，2025 生产批次每个目标时点保留 168 个版本。
- 默认铁路事实不包含 `dataset_role='SAMPLE'`。
- 默认出租车场事实不包含重复副本。
- 跨库关系验证查询无孤儿键。
- 所有 SQLite `integrity_check` 为 `ok`。
- `SHA256SUMS.txt` 与资产目录一致。

任何 ERROR 失败都停止发布。

### 8.2 WARN 规则

- 地铁日表缺少 6 个日期—站点组合。
- 网约车需求缺 23 个枢纽时点记录；订单窗口缺 18 条。
- 出租车场 90 行的容量、进出和等客字段为 `NULL`。
- 疏散比例字段缺失、五项全零、比例和偏离 1 或大于 1。
- 断面流量落库间隔发生 15 分钟、1 分钟和 3 分钟变化。
- 多个铁路站的非空 `LATE_FLAG` 全部为 1。
- 撮合平均耗时出现负值。
- 指标或状态码定义未确认。

WARN 不删除记录。Catalog 保存数量和影响，Skill 查询时说明限制。

## 9. 构建流程

### 9.1 治理构建库

`build_governance_db.py` 接收三个压缩包或三个已解压目录，生成工作区内的 `hub_traffic_governance.sqlite`。该库不进入 Module。

步骤：

1. 计算压缩包和成员文件 SHA-256。
2. 校验文件名、预期 Sheet、表头和列数。
3. 修复 CSV 首列表头的 `???` 前缀。
4. 绕过 XLSX 的错误工作表范围，流式读取真实 XML 行。
5. 将字符串 `NULL` 统一转为 SQL `NULL`，原值保存在原始审计字段。
6. 转换日期、整数和实数；转换失败进入质量记录。
7. 生成统一代码映射、记录哈希、重复组和冲突组。
8. 记录每个源文件的接纳数、拒绝数和警告数。

Python 必须使用项目规定的解释器：

```text
/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10
```

### 9.2 发布数据库

`build_agent_data_assets.py` 从治理构建库重建 6 个发布 SQLite。构建应是确定性的，同一源文件和脚本版本生成相同的业务内容。

推荐 SQLite 设置：

```sql
PRAGMA journal_mode=DELETE;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA temp_store=MEMORY;
```

表使用 `STRICT`，为时间—实体组合建立索引。完成后执行 `ANALYZE`、`PRAGMA optimize` 和 `PRAGMA integrity_check`。发布库不保留 WAL/SHM 文件。

### 9.3 完整性文件

质量检查全部完成后，为 6 个 SQLite 生成 `assets/databases/SHA256SUMS.txt`。Manifest 声明该文件，使安装、解析和会话装配都能验证资产完整性。

## 10. 查询接口

`query_assets.py` 复用参考模块的只读设计：

- 从 `TRANSPORTX_DATA_ASSETS_JSON` 精确选择 `data:shanghai-hub-traffic`。
- 独立诊断允许显式 `--data-root`。
- 以 `mode=ro&immutable=1` 打开数据库。
- `ATTACH` `catalog`、`common`、`rail`、`forecast`、`hubops`、`ridehail`。
- 设置 `PRAGMA query_only=ON`。
- 只接受 `SELECT`、`WITH` 和 `EXPLAIN QUERY PLAN`。
- 默认限制返回行数，最大不超过 5,000。
- SQL 使用全限定对象名，例如 `rail.mart_train_hub_day`。

建议提供：

```text
--list
--coverage
--metrics
--quality
--conflicts
--business
--describe DATABASE.TABLE
--examples
--sql
```

## 11. Skill 设计

### 11.1 触发范围

Skill 名称建议：

```yaml
name: shanghai-hub-traffic-data
description: Query governed Shanghai airport and railway-hub traffic data for train arrivals and departures, Hongqiao metro flow, arrival forecasts, evacuation modes, taxi yards, site flow, and ride-hailing demand around National Day and the May Day sample period.
```

该描述需与现有体育场 `shanghai-traffic-data-assets` 区分，避免两个 Skill 同时误触发。

### 11.2 `SKILL.md` 只保留的内容

- Data 资产 ID 和查询脚本定位方式。
- “先 coverage/metrics，再查业务表”的顺序。
- 生产、样例、预测版本和默认事实的边界。
- 不能违反的指标口径。
- Reference 路由。
- 重建限制：只有用户明确要求重建时运行构建脚本。

详细表结构、质量数量和 SQL 不写入主 Skill，分别放入 references。这一结构符合 `skill-creator` 的渐进式披露要求。

### 11.3 必须写入 Skill 的限制

- `AVG_WAITING_TIME` 不能直接解释为旅客等待出租车时间。
- 半小时铁路到达使用列车到站时刻和 `GET_OFF`，不能把小时预测平均拆成半小时。
- 预测问题必须说明使用最新版本还是指定发布时间版本。
- `ZT`、`FSTR_ZT`、`FSTR_QBB_ZT` 在码表确认前只输出原始代码。
- `INNUM`、`TRAFFICNUM` 在窗口未确认前不得求日累计。
- 缺测时点不能补零。
- “两场三站”默认排除 IMH；需要扩展范围时单列上海松江站。
- 铁路样例不进入默认生产统计。

## 12. 验证查询

首版至少固化以下查询到 `meta_query_example`，并在构建测试中执行：

1. 2025-10-08 00:00–03:00 三个出租车蓄车场状态。
2. 同时段司机等客时间；明确不是旅客候车时间。
3. 南1出租车点位流量；返回“无旅客等待分钟数字段”的治理说明。
4. 2025-10-07 23:00 至 10-08 04:00 虹桥火车站到达列次和下车人数。
5. 上述时段按半小时统计并找最大值。
6. 文件内最新时刻六枢纽网约车需求和原始状态码。
7. 五一样例创建到匹配的平均和中位时长，排除空值并报告负值异常。
8. 虹桥火车站国庆前、核心期、国庆后的网约车需求均值和峰值。
9. AOH、SHH、SNH 三站在三个分段的铁路日均到达、出发和总量。
10. 将 IMH 单列加入后的扩展范围对照。

## 13. 测试与安装验收

### 13.1 数据测试

- 源文件行数回归。
- 字段映射和类型转换测试。
- 自然键和业务冲突测试。
- 样例隔离测试。
- 预测 168 版本测试。
- 时间桶边界测试，覆盖跨午夜的 23:00–04:00。
- 地铁加总恒等式测试。
- 缺失与真实零区分测试。
- 比例和、负时长和采样间隔警告测试。
- 每个事实表关键索引的 `EXPLAIN QUERY PLAN` 测试。

### 13.2 Module 测试

1. 使用 `parseModuleManifestStructured` 验证 Manifest。
2. 检查所有入口和资产路径都位于包内，没有符号链接或路径逃逸。
3. 校验 `SHA256SUMS.txt`。
4. 通过 `ModuleRegistry` 验证模块已启用且无 Registry 错误。
5. 在只设置 `TRANSPORTX_DATA_ASSETS_JSON` 的环境中运行 `query_assets.py --coverage`。
6. 新建会话，确认 Skill、Data 资产和引用路径进入 Resolved Session Plan。
7. 执行 10 条验证查询并核对结果粒度、范围和单位。

## 14. 实施阶段

### 阶段一：冻结口径

输出字段映射表、源文件登记表、状态码待确认清单、三段日期定义和“两场三站”范围。确认 `AVG_WAITING_TIME`、`INNUM`、`TRAFFICNUM`、`THREE/FIVE/TEN` 的业务含义。

**验收**：未确认字段有明确状态，不以推测名称进入正式指标。

### 阶段二：治理接入

实现治理构建库、Excel/CSV 读取、类型转换、批次、哈希、重复和冲突记录。

**验收**：15 个文件全部接纳；物理行数合计 3,602,908；重复和样例关系与已知分析一致。

### 阶段三：发布模型

生成 `common`、`rail`、`forecast`、`hubops`、`ridehail` 和 `catalog` 六个 SQLite，建立事实、视图、集市和索引。

**验收**：错误级质量规则全部通过，数据库完整性为 `ok`。

### 阶段四：Skill 与查询工具

编写短入口 Skill、分域 References、只读查询脚本和验证 SQL。

**验收**：参考问题能由正确对象回答；不支持的旅客等待时间不会被错误推算。

### 阶段五：Module 打包与加载

生成 `SHA256SUMS.txt`，验证 Manifest 和 Registry，通过设置页安装并显式启用。不要直接复制到已安装模块目录，也不要手工改启用列表。

**验收**：新会话能解析 `data:shanghai-hub-traffic`，Skill 查询不依赖源码目录或用户绝对路径。

### 阶段六：后续增量

后续批次先进入治理库，按源文件哈希和业务键幂等接入。新增字段或表时提升 minor 版本；数据修复提升 patch 版本；同步更新 Module Manifest 和 `docs/CHANGELOG.md`。

## 15. 实施前需要确认的业务问题

以下问题不阻止先建治理层，但会阻止相关指标进入默认业务集市：

1. `AVG_WAITING_TIME` 是否确定为出租车司机蓄车等客时间？
2. 是否有旅客排队开始和上车时间，或上客点排队长度数据？
3. `INNUM`、`TRAFFICNUM`、`TRAFFICNUM_15SUM` 的统计窗口和累计规则是什么？
4. `THREE/FIVE/TEN` 是滚动订单窗口还是离散窗口？
5. 各状态字段 1、2、3 的含义和告警阈值是什么？
6. 疏散比例未满 1 的剩余方式是什么，大于 1 的记录如何处理？
7. `LATE_FLAG` 在国铁、金山铁路和市域铁路中的含义是否一致？
8. “两场三站”默认是否严格排除上海松江站？

这些问题确认后，更新 `meta_metric`、状态码映射、质量规则和 Skill Reference，不修改原始记录。
