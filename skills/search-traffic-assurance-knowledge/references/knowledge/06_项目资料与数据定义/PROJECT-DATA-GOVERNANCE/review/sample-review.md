# PROJECT-DATA-GOVERNANCE 抽查样本

## PROJECT-DATA-GOVERNANCE@sec-0002

- 标题：数据层次
- 来源定位：[{"pdf_page": null, "printed_page": null, "bbox": null, "quote": "- `std_*`：标准层，保留接纳记录、源行号、质量状态和源ID。\n- `dim_*`：统一实体维度。\n- `map_*`：源系统ID到统一ID的显式映射。\n- `bridge_*`：线路、方向、站点和站序关系，并保存关系粒度的空间属性。\n- `fact_*`：默认分析视图，只暴露通过治理规则的记录。\n- `mart", "source_unit": "PROJECT-DATA-GOVERNANCE@src-0002", "line_start": 3, "line_end": 12}]

- `std_*`：标准层，保留接纳记录、源行号、质量状态和源ID。
- `dim_*`：统一实体维度。
- `map_*`：源系统ID到统一ID的显式映射。
- `bridge_*`：线路、方向、站点和站序关系，并保存关系粒度的空间属性。
- `fact_*`：默认分析视图，只暴露通过治理规则的记录。
- `mart_*`：常用预聚合指标。
- `ops_*`、`quality_*`、`meta_*`：采集、质量、血缘和口径审计。

## PROJECT-DATA-GOVERNANCE@sec-0007

- 标题：隐私和指标限制
- 来源定位：[{"pdf_page": null, "printed_page": null, "bbox": null, "quote": "- 原始订单号不进入资产包，仅保存不可逆SHA-256 `order_hash`。\n- 订单级精确时间和坐标属于敏感数据；对外输出优先使用15分钟聚合。\n- 公交交易数、轨交人次和网约车订单量纲不同，只能并列比较，不能直接求和。\n- `rainfall_1h_mm` 是滚动一小时累计量，不得对10分钟记录求和。\n- 活", "source_unit": "PROJECT-DATA-GOVERNANCE@src-0007", "line_start": 57, "line_end": 63}]

- 原始订单号不进入资产包，仅保存不可逆SHA-256 `order_hash`。
- 订单级精确时间和坐标属于敏感数据；对外输出优先使用15分钟聚合。
- 公交交易数、轨交人次和网约车订单量纲不同，只能并列比较，不能直接求和。
- `rainfall_1h_mm` 是滚动一小时累计量，不得对10分钟记录求和。
- 活动表只有用户提供的日期，不得根据交通峰值反推演出时刻。

## PROJECT-DATA-GOVERNANCE@sec-0004

- 标题：点线一致性
- 来源定位：[{"pdf_page": null, "printed_page": null, "bbox": null, "quote": "- 高德公交和轨交站序坐标来自相应方向线路的同一次采集，应落在同源线路几何上。\n- `distance_to_route_m <= 25` 标记为 `OK`；25–100米为 `REVIEW`；大于100米为 `OUTLIER`。\n- 统一线路的线路上下文站点使用 `bridge_metro_line_station`", "source_unit": "PROJECT-DATA-GOVERNANCE@src-0004", "line_start": 23, "line_end": 30}]

- 高德公交和轨交站序坐标来自相应方向线路的同一次采集，应落在同源线路几何上。
- `distance_to_route_m <= 25` 标记为 `OK`；25–100米为 `REVIEW`；大于100米为 `OUTLIER`。
- 统一线路的线路上下文站点使用 `bridge_metro_line_station`，而不是强迫换乘站所有线路共用一个平台点。
- 物理站点 `dim_metro_station` 可汇总多个高德站点ID。线路地图必须使用关系表中的线路上下文点。
- 公交同一 `stop_id` 的多条线路观测不会被丢弃；主站点点位不能替代路线停靠点。
