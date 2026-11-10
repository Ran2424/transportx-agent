# 夜间疏运合成小场景

全部道路、客流、班次、容量与周转规则为软件验证样例，未经观测校准。经纬度仅提供地图显示锚点，不代表虹桥实际路网、站点或运营规则，不能用于评价真实收益。

- `scenario.json`：公交接驳、网约车及末班地铁接续；6 名旅客、3 辆背景车辆，运行 200 秒。
- `road-scenario.json`：同一路网的纯道路运行，不包含旅客服务字段。
- `nodes.nod.xml` / `edges.edg.xml`：可复现网络源。
- `network.net.xml`：SUMO netconvert 1.28.0，以 `--proj.utm true --no-turnarounds true --xml-validation never` 从上述源文件生成。坐标单位为米，显示坐标为 WGS84。

使用 `traffic_prepare_scenario`，显式选择 `data:hongqiao-night-demo` 并指定上述场景文件。输入来源为 synthetic，模型状态为 not_calibrated。固定 seed 仅验证可复现性，不构成统计或现实效果证据。

## P2 finite multimodal examples

`multimodal-baseline.json` declares two pickup points, east/west transfer points, two finite shuttles and two finite ridehail cars. All 16 travelers have an explicit fixed route choice. Waiting capacity, berths, boarding/walking, external journey time and timetabled finite metro capacity are assumptions. Full queues retain upstream demand; service vehicles return through actual SUMO motion before another trip.

`multimodal-threshold.json` keeps the same network, demand, fleet and other conditions and changes only the bus queue-threshold policy. Prepare it with the baseline scenario ID and `interventions: ["policy"]`; it is not an independent empirical observation. Compare equal seeds using a bounded experiment manifest. An individual seed, incomplete pair or this synthetic result cannot establish real Hongqiao benefit.
