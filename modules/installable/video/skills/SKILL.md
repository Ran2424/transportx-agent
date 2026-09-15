---
name: video-playback
description: 查询、展示、定位并受控处理本地录像（Demo MP4），并通过截图/抽帧进行基于图片的多模态理解。用于“调取某路口某时段的视频”“看看某时刻发生了什么”“截取某一段”等请求。
---

# Video Capability（V1）

平台提供 5 个受控工具：`video_search`、`video_present`、`video_snapshot`、`video_clip`、`video_sample_frames`。所有业务时间一律使用 **Recording Absolute Time**：ISO 8601 且必须显式带数值时区偏移（例如 `2026-08-16T08:32:10+08:00`）。不要猜测不带时区的时间。

## 典型流程

1. **调录像**：`video_search`（可按地点、摄像头、时段重叠检索）→ 若候选不唯一，向用户呈现候选并澄清 → `video_present`。
2. **只要求查看**：仅调用 `video_present`；可用 `timestamp` 直接定位到某个绝对录像时刻。不要自动分析画面。
3. **明确时刻发生了什么**：`video_snapshot` → 基于返回的图片进行多模态分析 → 回答。必须说明结论基于该时刻的单帧画面。
4. **时间段发生了什么**：`video_sample_frames` → 基于多张时序采样帧综合回答。必须说明“根据抽取的关键帧/采样画面”，不得声称逐帧完整观看了录像。
5. **截取片段**：`video_clip`（单次最长 5 分钟，重编码、帧级精度）。裁剪不会自动展示；只有用户要求查看结果时，才用返回的 `resourceId` 调用 `video_present`。
6. **并排对比**（最多 2 个画面）：先正常 `video_present` 调出第一个画面，再用 `video_present(..., compare: true)` 把第二个画面放进对比窗格。可对比两个地点/摄像头，也可对比同一段录像的两个绝对时刻（两次调用分别带不同的 `timestamp`，系统会生成两个独立画面，各自暂停在对应时刻，相当于两张图片对比）。用户要求“只保留一个画面”时，再次不带 compare 调用 `video_present` 即可回到单画面。

## 视频资源前置条件

- `video_present`、`video_snapshot`、`video_clip`、`video_sample_frames` 每次调用都必须携带且只携带一个有效的视频引用：源录像使用 `videoId`，已生成的片段使用 `resourceId`。
- 处理源录像前，必须先成功调用 `video_search`；仅当结果唯一时，才将返回的 `videoId` 传入后续工具。不得把检索与依赖该 `videoId` 的工具并行调用，也不得省略引用后依赖工具报错来发现视频。
- 若当前会话已明确持有某个 `videoId` 或 `resourceId`，可以直接复用；不要重新猜测、拼接或省略它。

## 时间语义与澄清纪律

- 录像区间与请求区间只要有重叠即为候选。
- `timestamp`、截图与裁剪区间必须落在源录像的闭区间内；裁剪还要求 `startTime < endTime`。
- 用户只给出“08:32”这类不含日期/时区的表达，且会话上下文无法唯一推定时，**必须追问或呈现候选**，不得自行猜测日期或时区。
- 派生 Clip 保留原录像的绝对时间，不会重置为 00:00。

## 多模态门控

- `video_snapshot` / `video_sample_frames` 需要当前模型支持视觉输入；工具会在不支持时报错。此时请明确提示用户切换视觉模型，**不要**基于元数据或文件名猜测画面内容。
- 禁止只凭视频文件名或元数据描述视频内容。

## 数据边界

- 视频数据来自已安装的 Data Module（如 demo-video）。未安装或未配置时，`video_search` 会返回“没有可用视频数据”，此时如实告知用户，不要猜测文件路径。
- 工具不返回、你也无需构造任何绝对路径；派生片段通过 `resourceId` 引用。

## Canvas 视图

`video_present` 打开或激活指定录像的 Canvas 标签。用户要求切换回已有录像时，复用其 videoId 或 resourceId 调用该工具。不同录像可分别保留在顶部标签中；`compare=true` 保留现有双画面对比。
