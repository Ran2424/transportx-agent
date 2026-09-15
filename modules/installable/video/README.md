# Video Capability Module

该模块提供视频检索、展示、截图、裁剪和抽帧工具。它不随 TransportX 桌面安装包分发，必须使用对应操作系统和 CPU 架构的能力包安装。

发布人员通过以下命令生成平台专属 ZIP：

```bash
TRANSPORTX_FFMPEG_RUNTIME_DIR=/absolute/path/to/ffmpeg-runtime npm run video:pack
```

生成的 ZIP 位于 `release/modules/`，包含自包含 Pi Extension、Skill、ffmpeg/ffprobe、版本、SHA-256 和许可证说明。视频数据 Module 应继续声明对 `com.transportx.video` 的依赖。
