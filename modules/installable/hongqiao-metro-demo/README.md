# Hongqiao Metro Entrance Demo Data Module

虹桥枢纽高铁 B1 层南通道地铁入口监控 Demo 数据。

## 内容

| 文件 | 说明 |
|---|---|
| `data/videos.json` | Video Capability 数据目录（1 段录像） |
| `data/videos/hongqiao_b1_metro_entrance_20260630.mp4` | 录像本体（**不入 Git**，约 300–500MB，1280x720 H.264 faststart） |
| `data/flows/entry_counts_minute.csv` | YOLO 离线识别的每分钟进站客流（入 Git，小体积） |

## 数据来源与加工

- 原始录像：`2026-06-30-16-39-58_高铁B1层14南通道地铁入口_31011210071322000777@002$1$0$0_1.mp4`（1920x1080 H.264，25fps，4483.7s，约 1GB）。
- 转码（适配浏览器播放与体积控制）：

  ```bash
  ffmpeg -i <原始录像> -vf scale=1280:720 -c:v libx264 -preset veryfast -crf 27 \
    -pix_fmt yuv420p -movflags +faststart -an -y data/videos/hongqiao_b1_metro_entrance_20260630.mp4
  ```

- 客流识别（YOLO yolo26s + ByteTrack，ROI 进入法，5fps 采样）：

  ```bash
  python process_entry_roi_minute.py --duration 0 --annotate-seconds 0
  ```

  方法：行人轨迹脚点首次进入闸机前 ROI（1920x1080 坐标 `560,345,1450,520`）且向上（进站方向）移动，记为 1 次进站；每个轨迹只计一次，按绝对分钟（+08:00）聚合。

## 录像时间口径

- 文件名起始时刻 `2026-06-30-16-39-58` 视为北京时间（+08:00）。
- `videos.json` 的 `endTime` 与转码后 ffprobe 实际时长（4483.7s）对齐（16:39:58 + 4483s = 17:54:41），误差在 Video Service 校验容差内。
