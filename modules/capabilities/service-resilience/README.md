# 城市服务韧性

本模块利用给定的路网、服务能力、需求、扰动状态和候选方案，比较服务可达性与供需缺口。它为桌面演练、情景分析和调查排序提供可复核的计算与证据。

创建工作区时，在高级设置的模块选项中勾选「城市服务韧性」。输入 `/resilience-demo` 运行内置演练，或输入 `/resilience-run <工作区相对案例路径>` 运行指定案例。工具调用省略 `casePath` 时使用[合成案例](examples/east-bridge.exercise.json)。对话中可用 `manage_capabilities` 启用模块工具。

## 从事件到复核

输入 `/resilience-workflow` 运行双服务点演练。也可传入 `/resilience-workflow <工作区相对配置路径>`。执行会保留对齐证据、方案定义、派生案例、可达性、组合扫描、调查排序及带哈希的交付清单。原始案例和观测保留在任务目录中。

| 工具 | 输入与输出 |
| --- | --- |
| `resilience_align_events` | 读取 [WGS84 GeoJSON 事件](examples/decision-events.exercise.geojson) 及[带时区的时段表](examples/decision-calendar.exercise.json)。按稳定 ID 或点、线、面的空间关系给出候选，记录部分重叠、时段外事件及多候选。只有来源非空、显式确认、ID 精确、动作匹配且覆盖一个完整实际时段的关闭事件才能用于后续复核。 |
| `resilience_compare_plans` | 读取[情景及方案定义](examples/decision-plans.exercise.json)并计算无扰动基线、中断无措施和所有选中状态×方案。可通过 `alignment:{path,sha256,stateId,eventIds}` 指定复核后的事件。工具会用原始文件重建对齐证据，验证哈希后才派生案例。方案产物含 RFC 6902 补丁及可复算的前后快照。 |
| `resilience_accessibility` | 使用派生的 `files.case.path` 和 `.sha256` 分别作为 `casePath`、`caseSha256`，再指定状态、时段和方案，查看基线与指定情景下各需求组的最短路线、时限、可选服务点与时耗差异。通过本地有向网络计算，容量竞争由方案比较另行分配。 |
| `resilience_sensitivity` | 使用同一派生案例，在选定状态和时段指定 1–3 个因素及试算值。支持道路耗时、服务容量、需求量、路段关闭及共享资源中断。总计最多 64 点，返回可行方案、两个缺口指标的 Pareto 集、相邻排序变化和联合影响证据。 |

配置包含 `casePath`、`eventPath`、`calendarPath`、`planPath`、`view:{stateId,planId,periodId}` 和 `sensitivity:{stateId,periodId,axes,constraints?}`。可选 `review:{stateId,eventIds}` 指明已复核事件及适用状态。省略 `review` 时工作流仍保留事件对齐结果，方案比较使用原始案例中的状态定义。权重超过一的时段代表多次服务机会，单次现场记录不能代表所有机会。新的现场证据可随配置发起另一次计算，复核清单和报告分别保留每轮哈希。

空间匹配复用 [Turf](https://github.com/Turfjs/turf)，本地路径搜索复用 [TinyQueue](https://github.com/mourner/tinyqueue)，方案差异导出复用 [JSON-Patch](https://github.com/Starcounter-Jack/JSON-Patch)。路段匹配使用案例节点间的直连形状，空间命中属于候选。路径使用案例中的方向、方式和耗时。可以在 [双服务点案例](examples/decision-case.exercise.json) 中查看完整输入。

## 数据与调用

使用当前任务根目录下的可见相对路径。调用前核对来源、时间、空间范围、许可和字段映射。输入由操作员提供，观测经人工复核后才可作为案例条件。

- `resilience_import {kind:'osm-overpass', sourcePath, speedKph, mode:'road'}` 读取本地 Overpass JSON，产出带哈希的有向网络。按节点 ID 构图，保留平行边，处理明确的单行和环岛方向。出行耗时来自假设车速。导入结果标明被排除的道路以及转向、通行限制的覆盖范围。
- `resilience_import {kind:'field-survey', sourcePath, columns}` 读取本地 CSV。`columns` 包含 `observationId`、`objectId`、`periodId`、`value`、`source` 对应的列名。支持 BOM、引号、逗号和引号内换行。空必填值和重复观测 ID 会报错。输出保留原值和来源。
- `resilience_align {casePath?, observationPath}` 按对象 ID 与时段 ID 精确匹配。输出匹配项、未知项、覆盖情况及来源。
- `resilience_pressure_test {casePath?, stateId?, planId?, periodId?}` 计算全部状态与方案组合。用案例中的状态、方案与时段 ID 选择 GeoJSON 地图切片。
- `resilience_investigate {casePath?}` 对调查问题给出排序和证据。可再传 `sweep: {stateId, periodId, objectId, variable, values}`，在指定状态与时段扫描一项道路耗时（`edge-minutes`）或服务容量（`service-capacity`）。输入 2–12 个不同试算值，输出偏好方案变化的相邻取值区间。

导入上限为 16 MiB 输入、4000 个节点、10000 条有向边和 5000 条调查记录。案例另有组合工作量限制。超限时可缩小时空范围或减少比较方案。

## 案例结构

用[完整演练](examples/east-bridge.exercise.json)作为模板。ID 使用字母、数字、点、下划线、冒号或连字符，开头须为字母或数字。案例由以下字段组成。

| 字段 | 含义 |
| --- | --- |
| `title`、`provenance` | 案例名称。来源为 `{kind: "exercise"或"observations", note: "出处与假设"}`。情景输出始终是估算。 |
| `nodes`、`edges` 或 `networkPath` | 节点为 `{id,coordinates}`，坐标为 WGS84 `[经度,纬度]`。有向边为 `{id,from,to,minutes,modes,requires}`。也可用 `networkPath` 引用导入的网络 JSON。 |
| `services` | 服务为 `{id,node,kind,capacity,requires}`，容量按单个时段填写，包含为零的候选设施。 |
| `demands` | 需求组为 `{id,node,kind,mode,amount,priority,maxMinutes}`。同类服务才参与分配，`priority` 为布尔值。 |
| `periods` | 每段为 `{id,label,weight}`。受影响的时段用明确 ID 标记，权重为正整数，表示重复的需求和服务机会。 |
| `states`、`plans` | 各项为 `{id,label,periods}`。每个时段可覆盖 `closedEdges`、`closedServices`、`unavailableResources`、`edgeMinutes` 和 `serviceCapacity`。未覆盖的时段使用基值。方案可另填准备时间 `setupMinutes`。 |
| `investigations`、`decisionWindowMinutes` | 调查为 `{id,question,source,effort,leadMinutes,outcomes}`。每个结果为 `{label,stateIds}`，合起来覆盖所有候选状态，允许多个结果含同一状态。决定窗口用分钟。 |

路段和设施用 `requires` 声明桥梁、电源或其他共享资源。把同一资源 ID 放进状态的 `unavailableResources`，可在同一时段关闭所有相关路段与服务点。使用有数据依据的容量和耗时，并在 `provenance.note` 标明尚待确认的假设。

## 方法与解释

`runPressureTest(model)` 分别计算基线、扰动状态和方案组合。在各独立时段中，按出发节点、交通方式和时间阈值找到同类服务，以最大流优先满足优先需求。结果区分不可达与可达但容量不足。计量单位为按时段加权的服务需求人次，同一人可多次计入。关闭与共享资源约束优先于方案，冲突耗时取较长值，服务容量取较低值。模型使用固定的行程耗时和输入需求。

`rankInvestigations(model, result)` 以优先需求缺口、再以总缺口的字典序最小化最大后悔值。判断能否等待时，将调查耗时和方案的 `setupMinutes` 相加，默认准备耗时为零。只有等待严格改善最坏后悔值时才列作可等待。计算使用案例给定的状态和结果映射，不赋予概率。相同排序以方案 ID 决胜，后悔值的第二分量可能为负。没有可执行方案时显示未知。单变量扫描只报告找到的变化区间，内插和共同失效需另设状态考察。

通过 `publish_geodata` 和 `present_visualization` 展示地图，用 `canvas_present` 打开 Markdown 和 CSV。需要溯源时用 `tau_resolve_citation` 登记原始输入和计算成果。项目交付应包含来源、日期、范围、假设、未匹配项及结果文件，并明确注明演练数据或假设车速。
