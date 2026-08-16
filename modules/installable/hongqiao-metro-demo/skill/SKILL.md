---
name: hongqiao-metro-entrance-demo
description: 虹桥枢纽高铁 B1 层南通道地铁入口的监控视频与 YOLO 预识别每分钟进站客流。用于“调取入口录像”“查看某时刻/某时段发生了什么”“截取片段”“分析每分钟进站客流”“客流高峰时现场是什么情况”等请求。
---

# 虹桥枢纽地铁入口监控 Demo 数据

本资产包含两部分（资产根目录由会话上下文的 `data:hongqiao-metro-demo` 给出）：

1. **监控视频**（约 74.7 分钟）：`videos/hongqiao_b1_metro_entrance_20260630.mp4`
   - 机位：虹桥枢纽高铁 B1 层 14 南通道地铁入口（地铁 2/10/17 号线进站口南1），摄像头编号 `31011210071322000777`。
   - 录像绝对时间：**2026-06-30 16:39:58 – 17:54:41（+08:00）**。
   - 画面视角：从站厅看向进站闸机；画面中“向上走”（远离镜头）即进站方向。
2. **每分钟进站客流表**：`flows/entry_counts_minute.csv`
   - 由 YOLO（yolo26s）+ ByteTrack 离线识别：行人轨迹脚点**首次进入闸机前 ROI 且向上移动**记为 1 次进站，每个轨迹只计一次，按绝对分钟聚合。
   - 列：`minute_index, absolute_start, absolute_end, relative_start_sec, relative_end_sec, entry_count`；时间为北京时间（+08:00）。
   - 这是算法估计值，存在漏检/误检；回答时表述为“基于视频算法识别的估计”。

## 使用方式

- **调视频 / 看现场**：使用 Video Capability 的 `video_search`（地点“虹桥”“地铁入口”或摄像头编号、时段均可检索）→ `video_present`（可用 `timestamp` 定位到具体时刻）。所有时间必须是带 `+08:00` 偏移的 ISO 8601。
- **某时刻发生了什么**：`video_snapshot`（需视觉模型）基于该时刻单帧回答。
- **某时段发生了什么**：`video_sample_frames` 基于采样帧综合回答，说明“根据抽取的关键帧”。
- **截取片段**：`video_clip`（单次最长 5 分钟），用户要看结果再用返回的 `resourceId` 调 `video_present`。
- **客流问题**：直接读取 `flows/entry_counts_minute.csv`（可用 Python/bash 读取 Data 资产目录下的文件）。可做每分钟趋势、峰值分钟、累计进站量等分析。

## 联合分析（视频 ↔ 客流）

客流表与视频使用同一套绝对时间（+08:00），可以互相定位：

- 用户问“什么时候进站人最多？”→ 查 CSV 找峰值分钟 → 可用 `video_present` 把视频定位到该分钟给用户看现场。
- 用户问“17:10 左右入口挤不挤？”→ 查 CSV 得该分钟进站数，并用 `video_snapshot`/`video_sample_frames` 给出画面证据。
- 引用画面结论时说明来自关键帧；引用客流结论时说明来自 YOLO 算法识别表，二者都不要夸大为精确统计。
