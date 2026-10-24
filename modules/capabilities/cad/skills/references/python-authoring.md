# Python 与其他引擎接入

创作方式由任务决定。Python 可以使用 ezdxf、Shapely 或其他实际可用库；用 Host 注入的 TAU_PYTHON_COMMAND 检查并运行，不另建 Python 执行工具。

首次生成候选文件，如 candidates/layout.dxf，显式设置已知的单位。用 cad_draw 接入：

```json
{"kind":"import","sourcePath":"candidates/layout.dxf","fileId":"layout","title":"平面布置草图","units":"mm"}
```

一旦基础结构可供用户讨论即提交。复杂几何先计算或写脚本，主要内容与细节按阶段继续提交；不要把“生成最终文件”当作唯一展示节点。

继续修改可读取回执 drawing.path，或从原参数全量重建；候选仍写到 cad/ 之外：

```json
{"kind":"commit-candidate","fileId":"layout","sourcePath":"candidates/layout.dxf","baseRevision":1,"expectedSha256":"<上次回执的完整 sha256>","candidateMode":"based-on-current"}
```

全量重新生成用 candidateMode="rebuild"。这是生成方式声明，不是实体身份验证；两种模式提交后均重新查询引用。单位须与基础版本一致，不通过改单位头冒充几何缩放。提交不会反向改写生成脚本。

候选提交与原生 edit 共用版本、执行恢复和 Canvas；不要再 import 相同图纸或创建新 fileId。保留脚本和必要参数便于复现，但不要求额外的脚本元数据文件或专属生成框架。

提交失败时根据明确诊断修正；版本冲突重新 inspect，执行未知先 query，不能自动重绘。不要把整图替换误说成已保留全部实体句柄。
