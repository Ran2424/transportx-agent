---
name: cad-drafting
description: Draft, inspect, edit and verify 2D DXF traffic engineering drawings with the cad_inspect, cad_draw and cad_verify tools. Use for road centerlines, intersections, markings, signals, buffers, labels, layer edits and drawing validation.
---

# CAD 制图

使用 `cad_inspect` / `cad_draw` / `cad_verify` 完成 2D DXF 制图。DXF、revision 和 manifest 是唯一权威；不要绕过工具直接改文件。

## 适用场景

- 把空间分析输出的 GeoJSON 画成 2D DXF；
- 在已有 DXF 上移动、复制、删除、改图层、画标线/文字/块；
- 生成 PNG/PDF 预览；
- 重新打开 DXF，检查单位、图层、闭合边界、退化/重复几何。

## 硬规则

1. **只做 2D DXF**。用户给 DWG 时明确拒绝，并说明当前不支持 DWG。
2. **单位和坐标必须显式**：
   - 米制工程图 `units="m"`，`$INSUNITS=6`；
   - 毫米图 `units="mm"`，`$INSUNITS=4`，但 `from-geojson` 当前只支持米；
   - 不默认“米”，不默认“X 轴向东”。
3. GeoJSON 转 DXF 必须声明一种变换：
   - `epsg`：目标投影 CRS，轴单位必须是米；`target.code` 写成 `EPSG:32651` 这种形式；
   - `local`：以 `[lng, lat]` 为原点的 AEQD 本地坐标，X 向东、Y 向北，`rotationDeg` 逆时针为正。
4. **几何意图必须落在图层上**，不能只靠颜色区分。
5. **不要覆盖旧文件**。新图写到 `cad/<fileId>/r1.dxf`，编辑写到下一个 revision，历史版本保留；由 `cad_draw` 原子提交，不要手工移动或覆盖。
6. 开放的道路中心线、标线、悬空端点**不是错误**；只有 `HATCH/BOUNDARY/LANDUSE/PAVEMENT/ISLAND` 等面图层要求闭合。
7. 中文标注必须显式设置 CJK 字体；没有字体时报告 warning，不要静默出方框。
8. 图纸是“方案/示意，须工程师复核”，不得声称可直接施工。
9. 不要用 `eval`、不要执行用户给的任意 Python，也不要用脚本绕过 `cad_draw` 的 revision 校验和原子提交。

## 工作流

1. **先看输入**：读取 GeoJSON/DXF，确认要素类型、数量、现有图层、单位和范围。不要先写图。
2. **定契约**：写明 `fileId`、`units`、`target`、`layerMap`、闭合图层清单。
3. **先查询**：编辑已有图前调用 `cad_inspect`，拿到当前 `revision`、图层、实体和 extents。
4. **先 dryRun**：批量或多实体写入调用 `cad_draw` 并设置 `dryRun=true`，检查命中数、预计新增实体和样例句柄。
5. **再写入**：确认计划后用 `dryRun=false` 提交。
6. **必校验**：写入后调用 `cad_verify`；再按需 `cad_inspect` 检查结果。
7. **汇报**：文件名、revision、sha256、units、图层数、实体数、extents、校验 warning 和未解决项。

## `cad_draw` 三种模式

### `kind="from-geojson"`

- 必填：`sourcePath`、`target`、`layerMap`
- 可选：`fileId`、`title`、`units`、`labelField`、`labelLayer`、`fillLayers`、`repairInvalid`、`template`
- **不要传 `baseRevision`**
- `target` 示例：

```json
{ "kind": "epsg", "code": "EPSG:32651" }
```

### `kind="edit"`

- 必填：`fileId`、`baseRevision`、`operations`
- **不要传** `sourcePath`、`target`、`layerMap`
- `baseRevision` 必须等于 `cad_inspect` 返回的当前 revision；不匹配会返回 `409 cad.revision_mismatch`
- 旧 revision 不能覆盖；成功提交后 revision 递增

### `kind="import"`

- 必填：`sourcePath`，必须是 `.dxf`
- 可选：`fileId`、`title`、`units`
- **不要传** `baseRevision`、`operations`

## dryRun 行为

`dryRun=true` 只校验并返回计划：

- 不创建 `cad/<fileId>/rN.dxf`
- 不创建 PNG/PDF
- 不更新 manifest
- 返回 `plan.matchedCount`、`plan.wouldCreate`、`plan.sampleHandles`

确认计划后再用 `dryRun=false` 正式提交。

## GeoJSON 图层映射

- 用 `feature.properties["kind"]` 或 `layerKey` 指定字段映射到图层；
- `LineString` / `MultiLineString` → 开放 `LWPOLYLINE`；
- `Polygon` / `MultiPolygon` → 闭合 `LWPOLYLINE`，需要填充时加 `HATCH`；
- `Point` / `MultiPoint` → `POINT`，有标注字段时加 `TEXT`；
- Z 坐标丢弃并记录 warning；
- 无效几何默认报错；只有明确允许时才 `repairInvalid=true`。

## 校验清单

- 单位：`$INSUNITS` 是否为 4/6；导入图为 0 时要求用户明确单位。
- 空图：模型空间与 paper space 是否都为空。
- 图层：是否出现未声明的图层；生成几何是否落在 `0` 层。
- 闭合：只检查面图层；开放中心线只 warning。
- 退化：零长线、零半径圆、重复点。
- 重复：同图层同几何（量化到 1e-6）。
- 不支持实体：`ACIS` / `3DSOLID` / `PROXY` 保留但 warning。
- 范围：extents 为空、过大（>1e7）或过小（<1）。
- 文字：高度是否合理；CJK 字体是否存在。
- 预览：PNG/PDF 是否存在且非空。

## 禁止事项

- 不默认米制；
- 不把经纬度当米；
- 不把开放中心线判成错误；
- 不覆盖历史 revision；
- 不在前端声称可以手工编辑保存；
- 不引用 `.dxf` 作为 Citation 证据；
- 不声称“已通过全部校验”，除非 `cad_verify` 真的通过。
