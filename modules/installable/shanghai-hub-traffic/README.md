# Shanghai Hub Traffic Data Module

模块 ID：`com.transportx.shanghai-hub-traffic`；数据资产 ID：`data:shanghai-hub-traffic`。

本模块治理上海“两场三站”及上海松江站的铁路、轨交、旅客到达预测、疏散方式、虹桥出租车蓄车场、功能点流量和网约车数据。源文件不进入仓库；发布数据库位于 `assets/databases/`，也不进入 Git。

重建与校验命令见 `skill/references/governance.md`。发布物必须同时包含六个 SQLite 文件和 `SHA256SUMS.txt`：

- `catalog.sqlite`
- `common.sqlite`
- `rail.sqlite`
- `forecast.sqlite`
- `hubops.sqlite`
- `ridehail.sqlite`

治理库 `.build/hub_traffic_governance.sqlite` 是可追溯中间产物，不随模块交付。
