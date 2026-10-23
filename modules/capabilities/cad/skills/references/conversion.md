# GeoJSON 转 DXF

使用 cad_draw 的 kind="from-geojson"，提供 sourcePath、sourceCrs、target、layerMap；不要传编辑用的 baseRevision 或 contextId。

- sourceCrs 必须来自真实数据；现有 Spatial 输出为 EPSG:4326。
- target.kind="epsg" 时提供投影 EPSG code，轴单位必须是米。
- target.kind="local" 时 origin 为经纬度，使用 AEQD，X 向东、Y 向北；rotationDeg 逆时针为正，scale 显式表示缩放。
- 转换结果使用米；原始 DXF 可为米或毫米。未知单位不猜测。
- layerMap 映射实际属性值。LineString 转开放多段线，Polygon 转闭合多段线，Point 转点；需要时声明 fillLayers 和 labelField。
- Z 坐标丢弃并报告；无效几何仅在明确允许 repairInvalid 时修复。

kind="import" 用于明确注册或调整单位；仅查看已有 DXF 用 canvas_present。修改 CAD 不会自动更新 GeoJSON、GIS 分析或其他图纸实体。
