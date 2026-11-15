# TransportX 上下游互操作调研

调研日期 2026-11-15。源码基线 `7b34bee5afbdb12145fc497e71857e658c3ee4c0`。本记录整理上一轮调研、实测及工程建议。

**建议把 TransportX 做成能交付、复核和复算交通分析的工作台。优先建设数据接入与结果交接，专业计算复用成熟引擎。** Agent 组织问题、口径、工具和证据。工程师能在会话之外复算，再将校审与现场观测带回下一轮。

## 实测与决定

| 实测 | 结果 | 对下一步的影响 |
|---|---|---|
| 两批客流与真实 Host/Pi | 第一批 200。第二批有重复站点和缺报，直接 JOIN 得 260。测试脚本拦住发布，保留缺报和真零值。覆盖原件后旧引用返回 `409`，留存后复算仍为 200。 | 原始批次与质量报告需要显式存储，旧会话引用应绑定快照。质量闸门由测试脚本提供。 |
| 空间距离 | 标称 500 米缓冲，米制 CRS 约 500 米，美国测量英尺 CRS 约 152 米，仍被标记为 500 米。 | 使用 CAD 已有轴单位检查思路，在空间计算入口校验 CRS、轴单位和范围。 |
| GeoParquet → DuckDB → GeoPackage | Windows 本机独立库验证几何、EPSG:32651、缺报、真零值往返保留。 | 可把分析存储与 GIS 工程交付分开，用稳定要素键连接。 |
| MobilityData GTFS Validator 8.0.1 | Google 示例 `stop_times.txt` 有 13 条行长度错误。Cherriots 公开快照有 118,692 条到离站记录，格式错误为零，同时有 238 条站间运行过快告警。按日历与例外表复算 2026-11-15 有 467 个有效计划班次 ID。 | 格式验收和指标适用性分开。速度告警影响相关耗时判断，计划班次可单独评估。 |
| Windows SUMO | 合成场景在本机引擎运行。现有 Host 有 600 秒仿真时长、120 辆背景车、100 位旅客等预算，结果标记未校准。 | 保留小场景比较，把实际观测、标定、独立验证作为工程应用入口。 |

本地证据位于旁边的 `transportx-local/evidence/`。对应文件为 `two-batch-validation.json`、`spatial-crs-unit-probe.json`、`geoparquet-geopackage-duckdb-probe.json`、`gtfs-ingest-probe.json`、`windows-sumo-compute.json`。GTFS 校验和格式互通在 Host 外运行。 [校验器](https://github.com/MobilityData/gtfs-validator) · [Cherriots 数据源](https://www.cherriots.org/data/) · [仿真源码](https://github.com/Ran2424/transportx-agent/blob/7b34bee/src/server/simulation-service.ts#L106)

课件的上海体育场案例用活动日历、轨交规则和只读脚本求活动日进站客流。把它变成可重复的工程流程，需要记录日历、物理站和站台映射、补报与指标规则的版本，同一个问题才能解释两批数据下答案为何变动。

## 复用边界

```mermaid
flowchart LR
    A[原始文件或 API] --> B[原始快照、校验、标准化]
    B --> C[TransportX 选择数据与方法]
    C --> D[专业工具执行]
    D --> E[结果、图层、复算清单]
    E --> F[校审、发布与决策]
    F --> G[校审反馈与现场观测]
    G --> B
```

- 复用 Skill、Pi Extension、Canvas、会话装配与任务产物引用。`ResolvedSessionPlan` 固定装配选择和原生运行时校验，同版本的 Skill 或 Extension 内容仍可变。复算清单应独立冻结数据、指标规则、脚本或引擎版本和参数。
- 普通模块先走 CLI 或 HTTP。Native Runtime 现有类型为 FFmpeg、SUMO。Canvas 用已有受信任适配器，`ProjectAdapter` 覆盖身份验证、模型配置和 Pi 扩展。新增内嵌视图需要 Host 与前端配合。
- Agent 工具接收明确的站点键、服务日、指标、数据版本。执行端限定身份、路径、数据范围、超时和取消。异步调用返回可查作业 ID，状态未知时查询同一作业。按需启用负责能力发现。共享部署的权限和进程隔离由执行层承担。
- 源站、站台、物理枢纽、有方向的道路、SUMO 边和 CAD 构件各有身份。保存来源 ID、版本、跨系统映射、未匹配和人工确认。图层可以轻量化，统计返回权威数据版本。

[TransportX 架构](https://github.com/Ran2424/transportx-agent/blob/7b34bee/docs/ARCHITECTURE.md) · [模块制作](https://github.com/Ran2424/transportx-agent/blob/7b34bee/modules/official/module-authoring/skill/SKILL.md) · [模块契约](https://github.com/Ran2424/transportx-agent/blob/7b34bee/src/contracts/module.ts) · [ProjectAdapter](https://github.com/Ran2424/transportx-agent/blob/7b34bee/src/server/project-adapter-types.ts)

## 开源接入选型

| 环节 | 近期建议 | 触发扩展的条件 |
|---|---|---|
| 文件与空间资产 | GDAL/PROJ 转换和校验，Parquet/GeoParquet 与 DuckDB 分析，GeoPackage 交给 QGIS | 多人查询共享空间数据用 PostGIS。发布固定大图层用 PMTiles。高频变化的 PostGIS 图层可用 Martin。现有空间入口上限 50,000 个要素和 100 MiB。 |
| 公交与其他交通数据 | GTFS Schedule、机构时区与服务日、计划和观测分类，固定 OSM 路网快照 | GTFS-RT 绑定静态版本和时效。传感器、道路事件、共享出行按现成供方选择 SensorThings、DATEX II 或 GBFS。 |
| 增量和治理 | 少量源用 Python 或 dlt，原件落地后验收，验收后推进游标 | 连接器或调度变多时评估 Airbyte 或 Dagster，有共享治理团队时接已有 OpenMetadata/DataHub，按需发 OpenLineage 血缘。 |
| 路线与可达性 | OpenTripPlanner 单次公交路径和换乘，R5 批量可达性，Valhalla 道路路由、矩阵和轨迹匹配 | 选择一个任务所需的引擎，冻结路网、班表、出发时间和步行换乘假设。 |
| 仿真 | SUMO 小场景配对对照，过程与输出可定位 | 数据支持时评估 SUMO–JuPedSim 行人、AequilibraE OD 分配及 MATSim 活动仿真。大作业走异步执行。 |
| CAD/BIM/视频 | DXF 原图与 GeoPackage 双向核查。上游用 CVAT 抽样校审，检测框可交给 ByteTrack 做跟踪，再把计数、时间和质量声明送入工作台 | 实际 BIM 需求再接 IfcOpenShell。实际车道级网络需求再接 OpenDRIVE，验收拓扑和坐标。 |
| 发布 | GeoPackage、指标表、报告和运行清单，QGIS 独立校审、Pandoc 导出 DOCX | 跨机构包评估 RO-Crate。外部 GIS 远程执行用 OGC API – Processes。其他 Agent 调用时评估 MCP。 |

- 数据格式与查询 [GDAL](https://gdal.org/en/stable/drivers/vector/) · [PROJ](https://proj.org/en/stable/apps/projinfo.html) · [GeoParquet](https://github.com/opengeospatial/geoparquet) · [DuckDB](https://github.com/duckdb/duckdb) · [PostGIS](https://postgis.net/docs/) · [PMTiles](https://github.com/protomaps/PMTiles) · [Martin](https://github.com/maplibre/martin)
- 来源与治理 [GTFS](https://gtfs.org/documentation/schedule/reference/) · [GTFS Realtime](https://gtfs.org/documentation/realtime/reference/) · [OSMnx](https://osmnx.readthedocs.io/en/stable/) · [SensorThings](https://www.ogc.org/standards/sensorthings/) · [DATEX II](https://datex2.eu/) · [GBFS](https://github.com/MobilityData/gbfs) · [dlt](https://dlthub.com/docs/general-usage/incremental-loading) · [Airbyte](https://github.com/airbytehq/airbyte) · [Dagster](https://github.com/dagster-io/dagster) · [ODCS](https://github.com/bitol-io/open-data-contract-standard) · [OpenMetadata](https://github.com/open-metadata/OpenMetadata) · [DataHub](https://github.com/datahub-project/datahub) · [OpenLineage](https://openlineage.io/docs/spec/object-model/)
- 专业计算 [OpenTripPlanner](https://docs.opentripplanner.org/en/latest/) · [R5](https://github.com/conveyal/r5) · [Valhalla](https://valhalla.github.io/valhalla/) · [SUMO–JuPedSim](https://sumo.dlr.de/docs/jupedsim.html) · [AequilibraE](https://github.com/AequilibraE/aequilibrae) · [MATSim](https://www.matsim.org/)
- 交接与复核 [GDAL DXF](https://gdal.org/en/stable/drivers/vector/dxf.html) · [IfcOpenShell](https://docs.ifcopenshell.org/ifcopenshell-python.html) · [OpenDRIVE](https://www.asam.net/standards/detail/opendrive/) · [CVAT](https://github.com/cvat-ai/cvat) · [ByteTrack](https://github.com/FoundationVision/ByteTrack) · [QGIS](https://docs.qgis.org/3.44/en/docs/user_manual/print_layout/create_output.html) · [Pandoc](https://pandoc.org/MANUAL.html) · [RO-Crate](https://www.researchobject.org/ro-crate/) · [OGC API – Processes](https://ogcapi.ogc.org/processes/) · [MCP](https://modelcontextprotocol.io/specification/2026-07-28)

## 第一个试点

选一个夜间枢纽、两个时刻表版本和一个明确服务日，回答末班窗口变化、按给定步行时间可达的计划接续，以及因数据不足无法判断的部分。具备真实到达、客流和候车数据后，再评估接续成功率及运力。

1. **能够复算。** 第二批含补报、重复或缺报时能解释变动，旧批次复跑一致。跨午夜、站台归并和缺报与零值进入样本。
2. **独立校审。** GeoPackage 和指标表可在工作台之外抽查，按站点核对数据批次、指标口径和源记录。
3. **反馈可验证。** 把映射错误、漏检、指标解释和仿真假设偏差带着证据登记到对应版本。Agent 提议更新，复核和历史回放通过后提升版本。观察同类错误、复算一致性和与现场观测的差距。

对外部署按实际交付检查 AGPL-3.0-only、各引擎和上游数据条款。其他候选项目按官方资料评估，其性能和部署须在项目条件下验证。 [TransportX 许可](https://github.com/Ran2424/transportx-agent/blob/7b34bee/LICENSE) · [OSM 数据许可](https://www.openstreetmap.org/copyright)
