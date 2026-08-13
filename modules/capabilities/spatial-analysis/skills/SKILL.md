---
name: controlled-spatial-analysis
description: 使用 tau_spatial_analyze 完成可复核的缓冲、最近邻和空间连接，并将结果交给 publish_geodata 展示。
---

# 受控空间分析

- 涉及缓冲距离、最近设施或点面归属时，使用 `tau_spatial_analyze`，不要按经纬度差值估算，也不要另写临时 Shapely 脚本。
- 所有输入必须先保存为当前任务目录内的相对 `.geojson` 路径，并明确声明输入 CRS。`buffer` 和 `nearest` 必须另外声明适合分析地区的米制 `metricCrs`；禁止使用 EPSG:4326 量距。
- `nearest` 设置阈值后要解释 unmatched 数量；`spatial_join` 的 one-to-one 如果可能多重匹配，默认让工具报错，或明确选择 one-to-many / first 策略。
- 只有确需修复无效几何时才传 `repairInvalid: true`，并在结论中报告 manifest 的 invalidGeometry、emptyGeometry 与 warnings。
- 工具输出的是 WGS84 GeoJSON。需要地图时，将返回的相对路径交给 `publish_geodata`，再调用地图展示工具。
- 最终回答应说明：输入范围和数量、CRS、距离/阈值或空间谓词、输出数量、未匹配与异常数量，并引用生成的 manifest 或结果文件。
