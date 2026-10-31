# 观察、检查与交付

普通提交自动更新 Canvas，不需要 PNG/PDF 导出来触发展示。成功回执仅表示 Host 接受呈现，不能据此声称浏览器已完成渲染。

需要视觉核对时，在不新增 revision 的前提下导出预览并用 read 查看返回 PNG：

```json
{"fileId":"layout","exportPreview":true,"previewOptions":{"bounds":{"min":[0,0],"max":[100,80]},"layers":["OUTLINE","LABELS"],"width":1200,"height":900}}
```

bounds 使用图纸坐标，layers 只影响本次预览，宽高 256..4096 像素。不同观察参数产生不同预览文件，不覆盖之前的局部预览。省略 previewOptions 时输出整图；预览不改变图纸或用户 Canvas 的图层开关。

基础提交会重新打开并进行结构审计；cad_verify 用于进一步几何检查。默认 basic，只有显式采用交通约定时才用 traffic-v1；strict 对重复几何更严格。diagnostics.details.entityHandles 定位问题，truncated=true 时需要进一步查询。

闭合直线多段线会检查边界有效性；曲线边界的拓扑未检查时会明确报告。几何检查不证明布局符合用户参考图或专业规范，必须结合视觉观察和任务要求判断。

PNG/PDF 是预览，不承诺固定打印比例或与其他 CAD 软件像素一致。字体、渲染问题应报告实际诊断，禁止伪造已生成预览。导出已有图纸用 cad_verify，不能通过空位移等伪修改制造新修订。
