# 网约车查询

最新需求按每个 `hub_id` 分别选择最大 `observed_at`，使用 `ridehail.fact_ridehail_demand_snapshot` 的 `demand_count`。`status_code` 只有原始 1/2/3，码表确认前不输出告警名称。

国庆分段通过 `common.dim_analysis_period` 连接：

- `NATIONAL_DAY_PRE`：2025-09-20 至 09-30。
- `NATIONAL_DAY_CORE`：2025-10-01 至 10-08。
- `NATIONAL_DAY_POST`：2025-10-09 至 10-20。

订单窗口使用 `fact_ridehail_order_window` 的 `window_minutes` 区分 3、5、10 分钟。撮合平均和中位耗时只在五一样例中提供；排除空值并披露负平均耗时异常。
