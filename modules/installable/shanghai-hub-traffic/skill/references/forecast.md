# 预测查询

`forecast.fact_arrival_forecast_version` 保留每个目标小时的全部发布时间。指定历史预测时同时过滤 `predicted_at` 和 `issued_at`；只需要最终版本时使用 `latest_arrival_forecast_hour`。

疏散比例长表视图为 `fact_evac_mode_ratio_version`。查询方式人数前要求原宽表记录 `available_mode_count=5`，并检查 `ratio_sum`、`ratio_quality_status`。比例和异常记录只用于审计。
