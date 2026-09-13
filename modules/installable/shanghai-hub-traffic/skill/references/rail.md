# 铁路与轨交查询

默认生产铁路事实是 `rail.fact_train_stop`。它排除五一样例，业务键为开行日期、车次、车站。

半小时到达和出发查询优先使用 `rail.mart_train_hub_halfhour`。跨午夜窗口使用完整 `slot_start` 过滤，不要只按小时过滤。

“两场三站”的铁路部分默认是 AOH、SHH、SNH。IMH 应单列。地铁某物理站的总量使用 `rail.mart_metro_station_day`，不要把同一站的多条线路当作多个物理站。
