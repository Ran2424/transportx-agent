---
name: cad-drafting
description: Open, inspect and revise 2D DXF drawings together with the user. Use for entity selection, geometry edits, layers, labels and GeoJSON conversion.
---

# CAD 图纸协作

用户在 Canvas 查看并选择实体，Agent 通过受控工具修改；首版支持 2D DXF。

## 入口与流程

1. 用 `manage_capabilities` 启用 CAD；呈现或读取选区时另行启用 Canvas。依赖装配不自动开放工具。
2. 已有 DXF 用 `canvas_present` 打开：`adapterId="com.transportx.canvas.cad"`，`resource={"scope":"session-file","path":"图纸.dxf"}`。首次打开保存原始快照，重新打开复用同一图纸；不要为了查看调用绘图工具。
3. 用户附加选区后，用 `canvas_inspect_context` 读取本轮 contextId；再按需查询实体。
4. 编辑调用 `cad_draw`：`kind="edit"`、`contextId`、`operations`。Host 解析选区固定的图纸、revision 和哈希。也可显式传 `fileId/baseRevision/expectedSha256`。
5. 成功提交返回 drawing.fileId/revision/sha256；据此显式传 fileId/baseRevision/expectedSha256 继续编辑，不复用旧 contextId。同一 Canvas 标签更新。报告实际修改与诊断；需要导出或完整检查时再请求。

## 必要约束

- 不直接改受管 DXF、manifest 或作业文件；旧 revision 不覆盖。
- 不把经纬度当长度，不猜未知单位和地理方向；移动沿图纸 X/Y。
- 用户选区用于提示意图，不限制编辑范围。截断选区不能当成完整集合；按需查询当前图纸，版本和哈希检查仍保留。
- 响应丢失或取消未确认时，使用 `cad_execution` 查询原 operationId 或 lookupToolCallId，不能重复提交。
- Viewer 不支持前端绘制或保存；不承诺 DWG、道路等距偏移、自动渠化或工程审定。

## 按需读取

- 修改实体、新增标注、批量预检：[editing.md](references/editing.md)
- GeoJSON 转换与坐标：[conversion.md](references/conversion.md)
- PNG/PDF 与检查：[export-validation.md](references/export-validation.md)
- 交通图层与示意图约定：[traffic-drafting.md](references/traffic-drafting.md)
- 运行时或字体故障：[runtime.md](references/runtime.md)
