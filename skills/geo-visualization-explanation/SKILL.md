---
name: geo-visualization-explanation
description: 在 Tau 中使用 publish_geodata 和 present_visualization 构建、解释并调试声明式交互 Web GIS 地图。适用于发布 GeoJSON、绘制点/线/面图层、展示空间热点与专题样式、添加 POI 参考图层、切换图层、处理选择交互，或排查任何 Invalid GeoScene 错误。不适用于普通的静态 matplotlib 图表。
---

# 地理可视化说明

使用 Tau Geo 工具发布当前会话范围内的 GeoJSON，并呈现声明式二维地图。将数据准备、地图描述和 Web 渲染分开处理。

## 选择工作流

- 始终先调用 `publish_geodata`，再调用 `present_visualization`。呈现工具接收命令式参数，并在内部构建 GeoScene；不要手写 `scene`、`sources`、`layers` 或 `encoding` 对象。
- 先完成查询、聚合、空间关联、指标计算和结果校验，再发布数据。Geo 工具负责保存资源和表达分析结果，不代替 GIS 数据分析。
- 发布前聚合密集观测数据。`publish_geodata` 最多接受 50,000 个要素和 20 MiB 数据；不要把上百万个原始点发送到浏览器。
- 当地图使用受治理的上海交通数据库时，同时读取 `shanghai-traffic-data-assets`，并以其中的指标、实体和坐标参考系规则为准。

## Agent 命令决策

| 当前意图 | 使用命令 | 不要做 |
| --- | --- | --- |
| 首次展示一项分析 | `create_map` | 不要为同一分析连续创建多个 `visualizationId` |
| 叠加另一份结果或参考数据 | `add_layer` | 不要重建整张地图 |
| 设置固定、分类、分级或连续样式 | `set_constant`、`set_categorical`、`set_step`、`set_continuous` | 不要生成 MapLibre expression |
| 增加可解释属性 | `set_popup`、`set_metadata` | 不要把完整属性表塞进标题或说明 |
| 改变地图视角 | `set_camera` 或 `fit_bounds` | 不要通过重新创建地图改变视角 |
| 控制图层或高亮结果 | `set_visibility` 或 `select` | 不要把临时 hover 当成 Scene 事实 |
| 清除当前可视化 | `clear` | 不要创建空 GeoJSON 来模拟清除 |

每条 `present_visualization` 命令只修改一个关注点。工具成功后会返回完整、递增 revision 的 GeoScene Snapshot；后续命令继续使用同一个 `visualizationId`。

## 准备 GeoJSON

1. 可视化前，将源坐标转换为 WGS84 经纬度。不要期待工具自动转换 GCJ-02 或 BD-09。
2. 校验坐标顺序和范围：使用 `[经度, 纬度]`；经度范围为 `[-180, 180]`，纬度范围为 `[-90, 90]`。
3. 为每个要素提供稳定且唯一的顶层 `Feature.id`，或添加唯一的字符串/整数属性，并把属性名传给 `idField`。发布器目前只对显式传入的 `idField` 校验唯一性；顶层 `Feature.id` 的唯一性需自行验证。
4. 当线、普通点、高亮 POI 或不同专题组需要不同样式时，将它们拆分到不同数据源；GeoScene v1 没有筛选通道。
5. 调用 `publish_geodata` 前，将生成的 GeoJSON 写入当前任务目录。
6. 发布前检查根类型、要素数量、文件大小、几何类型、坐标范围和 ID 唯一性。数据需小于 50,000 个要素和 20 MiB；超出任一限制时，先提高聚合粒度。

在 GeoPandas 中使用 `idField: "id"` 时，导出前显式创建该属性：

```python
grid["id"] = grid.index.astype(str)
```

不要假设 DataFrame 索引会自动成为 GeoJSON 属性。

## 发布数据

调用 `publish_geodata` 时，传入 GeoJSON 相对路径、清晰的标题，并在使用属性 ID 时传入 `idField`。将返回的 `resourceId` 原样传给 `present_visualization`，同时使用 `command: "create_map"`；不要自行构造数据源对象。

发布失败时，修复数据，不要移除有意义的 `idField`：

- 缺少 ID：确保每个要素都包含对应属性。
- ID 重复：生成确定且唯一的值。
- 坐标无效：修正坐标参考系或坐标顺序。
- 数据过大：聚合、简化或拆分数据。

## 渐进构建地图

从 `publish_geodata` 返回的资源和一个固定样式图层开始：

```json
{
  "command": "create_map",
  "visualizationId": "hotspot_map",
  "title": "热点分布",
  "resourceId": "geo_0123456789abcdef01234567",
  "sourceId": "hotspots",
  "layerId": "hotspot_fill",
  "layerType": "fill",
  "layerTitle": "热点",
  "color": "#2563eb"
}
```

上面的 `resourceId` 仅用于演示所需的小写十六进制格式。必须替换为当前 `publish_geodata` 调用实际返回的 ID。

`create_map` 成功后，每条命令只增加一个关注点，并按以下顺序执行：

1. 使用 `set_step`、`set_continuous`、`set_categorical` 或 `set_constant` 设置一个通道。
2. 使用 `add_layer` 添加第二个数据源/图层或参考 POI 图层。
3. 使用 `set_popup` 添加详情。
4. 仅在需要改变导航、全屏或“回到范围”按钮时使用 `set_controls`。`fitToData: false` 会隐藏该按钮；`legend` 和 `layerSwitcher` 仍为预留标志，图层列表始终显示且尚无自动图例。
5. 使用 `set_metadata` 添加说明和警告。
6. 仅当根据资源范围自动推导的视图不合适时，使用 `set_camera` 或 `fit_bounds`。

优化地图时复用同一个 `visualizationId`。当用户要求在当前地图中“添加”“叠加”“标注”或“包含”内容时，更新该可视化，不要新建第二张地图。仅当用户明确要求单独地图时才创建新 ID。

## 遵守编码约束

- 颜色只使用十六进制字符串，例如 `#2563eb`、`#fff`、`#2563ebcc` 或 `#fffc`。不要使用 `rgb(...)`、`rgba(...)`、CSS 变量、URL 或颜色名称。
- 透明度使用 `[0, 1]` 范围内的数值。
- 为 `step` 和 `continuous` 提供 2–16 个严格递增的数值断点。
- `set_step` 命令必须包含 `defaultValue`；不要向 `set_continuous` 传入该字段。
- 仅使用图层类型支持的通道：
  - `circle`：`color`、`radius`、`opacity`、`strokeColor`、`strokeWidth`
  - `line`：`color`、`width`、`opacity`、`dash`
  - `fill`：`color`、`opacity`、`outlineColor`
  - `label`：`textField`、`color`、`size`、`haloColor`、`haloWidth`
- 将通道及其值传给对应命令。例如，使用 `command: "set_constant"`、`channel: "opacity"`、`value: 0.75`；不要自行构造 VisualValue、MapLibre `paint`、`layout` 或 JavaScript 表达式。

## 组合易读的专题地图

- 重叠的填充图层默认只让一个图层设置为 `visible: true`，其他备选图层设为 `visible: false`。Web 地图始终显示当前图层可见性列表；不要依赖预留的 `layerSwitcher` 标志。
- 当用户需要理解热点与场馆或车站的相对位置时，添加参考 POI 或标签图层。
- 当地图展示场馆、车站、机场等可命名 POI 点时，除非点位极其密集或用户明确不要标注，否则应同时添加 `label` 图层，并以名称字段设置 `textField`；不要只画无名称的圆点。
- 使用清晰的图层标题和简短的弹窗字段。
- 已知数据源范围时，优先使用带内边距的 bounds 视图；需要刻意安排固定构图时，使用 camera 视图。
- 在回复中说明时间范围、空间范围、聚合单元、坐标参考系和重要的覆盖限制。

### 上海地铁线路配色

> **风格规则：** 只要可视化使用上海地铁线路作为视觉编码，就必须按线路名称使用下表颜色，不要改用通用分类色板。

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

这些十六进制值来自上海市政府发布、由上海申通地铁集团提供的 [上海轨道交通网络示意图](https://english.shanghai.gov.cn/en-Latest-WhatsNew/20240924/b625d488216241f78f743cd87a40df0c.html)，并按图像内嵌 ICC 配置转换为适用于 Web 的 sRGB。设置线路颜色时，对线路字段使用 `set_categorical`；不要把连续色带用于不同线路。若需绘制磁浮、市域线或尚未列入表中的在建线路，先核对最新官方线路图，不要自行猜色。

## 从校验失败中恢复

当 `present_visualization` 拒绝某条命令时：

1. 保留上一次成功的场景。
2. 读取返回的校验问题路径和代码，只修改该命令对应的参数。
3. 检查颜色格式、通道名称、断点顺序、数据源/图层 ID、边界和弹窗格式。
4. 如果此前没有成功创建地图，使用一个固定样式图层重试 `create_map`。
5. 最小地图成功后，逐条重新添加命令。
6. 如果相同的 `visualizationId + command + layerId + channel` 在同一字段路径上连续失败两次，停止重试。保留最后成功的场景并报告工具故障，不要继续猜测参数。

不要反复提交互不相关的整体改写。当工具返回字段级错误时，以该错误为准。
