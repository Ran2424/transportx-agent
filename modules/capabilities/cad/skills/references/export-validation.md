# 导出与检查

普通编辑不自动生成 PNG/PDF。用户需要预览成果时，在 cad_draw 请求中设置 exportPreview=true；可用空位移等伪编辑导出的做法被禁止，已有图纸导出请使用 cad_verify 的 exportPreview=true。

每次提交执行 DXF 重新打开与结构审计。需要几何诊断时再 cad_verify，默认 basic；只有明确采用交通图层约定时选择 traffic-v1。strict 对重复几何采用更严格检查，开放中心线仍然合法。

检查只代表实际运行的几何规则，不代表交通规范符合或工程审定。PNG/PDF 为预览，不承诺 AutoCAD 像素一致或固定打印比例；字体缺失应报告 warning。
