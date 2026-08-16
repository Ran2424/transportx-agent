# Demo Video Data Module

两个合成的 60 秒 Demo 录像（MP4 / H.264 yuv420p / 320x180 / 10fps，无音频），用于验证 Video Capability V1 闭环：

- `camera_001.mp4` → `video_001` 人民路—中山路口 2026-08-16 08:00:00–08:01:00 (+08:00)
- `camera_002.mp4` → `video_002` 世纪大道—张杨路口 2026-08-16 08:30:00–08:31:00 (+08:00)

`videos.json` 中的录像时间区间与文件实际时长（ffprobe）一致；Video Service 会校验两者不一致时拒绝 materialize。

## 重新生成

```bash
node scripts/generate-demo-videos.mjs
```

需要本机 `ffmpeg` 可用（开发模式）。
