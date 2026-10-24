---
name: cad-drafting
description: Create, view and iteratively revise general-purpose 2D DXF drawings with the user. Combine Python or other geometry engines with native CAD edits, versioned commits, inspection and Canvas presentation.
---

# CAD 协作工作空间

用于通用二维 DXF 创作与修改。Python、原生 CAD 操作和其他几何引擎均可使用；模块统一接入成果、管理版本、观察几何并在 Canvas 展示。先用 `manage_capabilities` 启用 CAD；需要显式聚焦或读取用户上下文时启用 Canvas。

## 协作创作

1. 根据任务选择创作方式。复杂布局、参数化或批量生成可用 Python；少量实体修改可直接用 `cad_draw(kind="edit")`。不需要逐个阅读模块源码来发现参数。
2. 首份可讨论的基础结构完成后即提交草图，不等所有细节完成。Python 候选文件首次用 `cad_draw(kind="import", sourcePath=...)` 接入；已有文件只查看用 `canvas_present`。
3. 后续 Python/其他引擎候选使用 `cad_draw(kind="commit-candidate")`，沿用返回的 fileId，传 baseRevision、expectedSha256、sourcePath 和 candidateMode。不要换 ID 重复导入来更新成果。
4. 在主要内容、细节完善及用户反馈等有意义的阶段提交新修订；按任务选择节点，不按工具调用次数机械提交。成功提交自动呈现/更新同一个 Canvas 标签，无需再次打开原始路径。回执 presentation.status="accepted" 不是浏览器渲染成功确认；需要聚焦时复用 presentation.viewId。
5. 用 `cad_inspect(include=["geometry"])` 按需观察几何；需要视觉判断时 `cad_verify(exportPreview=true, previewOptions=...)` 后读取返回的 PNG。检查与视觉观察分别判断，不能用 DXF 校验通过证明符合用户参考图。

## 连续修改

- 回执 drawing.fileId/revision/sha256 是后续提交依据；revision 作为下一次 baseRevision。冲突时重新查询，不能覆盖新版本。
- candidateMode="rebuild" 表示全量重建；"based-on-current" 表示生成器基于当前 DXF 修改。两者都要重新确认旧实体引用，不把相同 handle 当作身份保证，也不复用旧版本 contextId。
- 用户附加选区后，先 `canvas_inspect_context`，按需 `cad_inspect`。选区是意图参考，不限制编辑范围；当前 revision/hash 的一致性检查始终保留。
- 修改原生实体时使用 contextId，或明确的 fileId/baseRevision/expectedSha256。批量操作先 dryRun 核对命中对象；copy.count 按 1×、2×…位移排列。
- Python 使用当前 Host 的 TAU_PYTHON_COMMAND，可读取受管 revision，但候选写在任务目录的 cad/ 之外。不要直接覆盖受管 DXF、manifest 或作业文件。
- 不猜单位、比例或地理方向。局部示意坐标不等于真实测量坐标；需要坐标标定时先明确依据。
- 响应丢失或取消未确认时，用 `cad_execution` 查询原 operationId/lookupToolCallId，不能自动重提。确认提交后可用回执路径或 viewId 恢复展示。

## 按需参考

- Python 首稿与持续提交：[python-authoring.md](references/python-authoring.md)
- 原生编辑与选区：[editing.md](references/editing.md)
- GeoJSON 与坐标转换：[conversion.md](references/conversion.md)
- 局部预览、检查与交付：[export-validation.md](references/export-validation.md)
- 可选交通领域约定：[traffic-drafting.md](references/traffic-drafting.md)
- 运行时与字体：[runtime.md](references/runtime.md)

Viewer 首版支持查看、选择与附加上下文；不提供前端手绘保存，不承诺 DWG、三维编辑或工程审定。
