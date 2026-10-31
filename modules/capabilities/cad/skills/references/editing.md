# 选区编辑

先读取用户本轮附加的 Canvas Context，再用 cad_inspect(contextId, include=["entities"]) 查询选中实体；`cad_inspect` 默认只返回摘要，实体详情按 include/selector/limit/cursor 有界读取。contextId 默认聚焦非空选区，显式 selector 可查询选区外实体；fileId 查询整份当前图纸。

```json
{"kind":"edit","contextId":"本轮的 contextId","operations":[{"op":"setLayer","selector":{"kind":"handle","handle":"2F"},"layer":"REVIEW"}]}
```

用户附加的选区是理解意图的参考，不是编辑范围限制。按任务需要可使用 handle、图层或区域 selector；不要把选区当成额外的授权边界。用户明确提出的范围约束仍须遵守。

contextId 指向固定版本。提交后用回执 drawing.fileId、drawing.revision（作为 baseRevision）、drawing.sha256（作为 expectedSha256）继续修正，不复用旧 contextId。旧上下文仍可作为参考；显式版本或文件哈希过期时重新 cad_inspect，不能盲目覆盖。

新增文字、线或填充不要求已有 handle；根据实际坐标确定位置、图层与尺寸。

批量或复杂操作先 `dryRun=true`，检查命中数、预计新增/修改/删除和样例句柄；dry-run 不提交文件。单个明确修改无需重复完整预检。

没有 Canvas 选区的显式图纸编辑：先 cad_inspect，再传该次查询的 fileId、baseRevision、expectedSha256。Host 拒绝旧版本和被外部改动的内容。

move/copy 的 dx/dy 使用图纸单位并沿图纸轴；平移不是曲线等距偏移。道路地理方向需依据转换记录换算，未知时先澄清。

结果未知时查询已有执行；取消请求不等于执行已停止。校验回执不能确认时保留现场，不删除文件或再次绘图。
