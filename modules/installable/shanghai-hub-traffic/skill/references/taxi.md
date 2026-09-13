# 出租车与功能点

`hubops.fact_taxi_yard_state` 记录北、南、市域铁三个蓄车场的容量、进出、在蓄和等客指标。`driver_queue_wait_minutes` 沿用源 `AVG_WAITING_TIME`，当前证据不足以解释为旅客等待时间。

南1等上客点或排队通道的数据位于 `hubops.fact_site_flow_observation`。它只能回答点位观测值和变化；没有旅客排队开始、上车时刻或等待分钟数字段。

功能点数据在不同时段以约 15、1、3 分钟间隔落库。`INNUM` 和 `TRAFFICNUM` 的窗口未确认，不得直接跨时点求和。
