# Video Capability V1 — 最终 SPEC

**状态：** Final（开发前须通过 Phase 0）  
**目标：** TransportX Traffic Agent  
**范围：** 本地 Demo MP4 的视频查询、展示、受控处理与基于图片的多模态理解  
**发布保证：** V1 正式保证 macOS arm64；Windows x64 仅保留架构接口，不作为本版本发布或验收阻塞项。

## 1. 目标与非目标

为现有 Agent 增加正式的视频基础能力，使其能够完成：

```text
查询视频 → 展示并定位 → 截图 / 裁剪 / 抽帧 → 图片多模态分析 → 回答用户
```

典型请求：

- “调取人民路口 08:30 左右的视频。”
- “看一下 08:32:10 是什么情况。”
- “看看 08:32 到 08:33 发生了什么。”
- “把 08:32:00 到 08:32:30 这一段截出来。”

V1 是 Agent 调用、展示、处理和理解受控视频数据的能力验证，不是视频监控平台。以下内容不在范围内：RTSP/GB28181、实时直播、VMS/NVR/NAS、厂商 SDK、任意格式兼容、多路同步、PTZ、目标跟踪、完整视频直接输入模型、正式视频 Citation/证据链。

## 2. 架构与边界

继续采用平台既有的单一能力扩展链路：

```text
Contract → Pi Extension → Agent Host → Browser Projection → React Video View
```

Video 不新增第二套服务、Electron Main 业务逻辑或独立视频 Runtime。受控处理调用链为：

```text
Pi Video Extension → Session Tool Endpoint + token → Video Service → VideoRunner → ffmpeg / ffprobe
```

浏览器播放是另一条链路：

```text
React <video> → 同源 Video Resource API → 现有 Browser Authentication → Session Video Resource
```

Pi 工具 token 只用于 Extension 到 Host 的内部请求，绝不出现在浏览器 URL、Video Scene、Pi JSONL 或日志中。React 不获得绝对路径。

## 3. 模块与运行时

新增 Capability Module：

```text
modules/capabilities/video/
├── manifest.json
├── extensions/pi-video/
│   └── index.ts
└── skills/SKILL.md
```

Demo 数据是独立的可安装 Data Module：

```text
modules/installable/demo-video/
├── manifest.json
└── data/
    ├── videos.json
    └── videos/*.mp4
```

Video Capability 是平台能力；录像数据属于 Data Module。Data Module 不作为平台启动依赖，未安装或未配置时工具必须返回“没有可用视频数据”，不得猜测文件路径。

正式桌面 Runtime 的组成扩展为：

```text
TransportX Runtime = Pi + Python + ffmpeg + ffprobe
```

V1 的 macOS arm64 包必须为 `ffmpeg` 与 `ffprobe` 在 runtime manifest 中记录受限相对路径、版本、架构和 SHA-256，并在打包应用中进行完整性校验与 smoke test。开发模式可以显式覆盖可执行文件路径；已打包应用不得依赖 `PATH` 或 Homebrew。二进制的许可证、归属和签名要求应随打包资产一并处理。Windows 仅预留 resolver/manifest 结构，不要求本 V1 提供二进制或实机验收。

## 4. Phase 0 — Playback Spike（硬性前置条件）

在编写正式能力前，必须在**已打包的目标 Electron macOS arm64 应用**中验证一套唯一的 Video Input Spec：

```text
候选 codec + container
→ <video> 正常播放
→ 同源 HTTP Range
→ Seek
→ 指定时间定位
→ ffmpeg / ffprobe 可用
```

通过后才固定 V1 的输入与输出编码规范。V1 仅接受该规范；不符合规范的 Demo 录像须在进入 Data Module 前转换。不得以“浏览器可能支持”为验收依据。

## 5. Demo Video 数据与时间语义

`videos.json` 的最低格式如下：

```json
{
  "schemaVersion": 1,
  "videos": [{
    "videoId": "video_001",
    "cameraId": "camera_001",
    "title": "人民路—中山路口",
    "locationName": "人民路—中山路口",
    "startTime": "2026-08-16T08:00:00+08:00",
    "endTime": "2026-08-16T09:00:00+08:00",
    "file": "videos/camera_001.mp4",
    "mimeType": "video/mp4",
    "longitude": 121.123,
    "latitude": 31.123
  }]
}
```

规则：

- `videoId` 在已解析的 Data Asset 集合内全局唯一；`file` 必须是 Data Root 内的安全相对路径，禁止绝对路径、`..` 与 symlink 越界。
- 所有业务时间均为 ISO 8601 且显式带数值 timezone offset；校验不得仅依赖 `Date.parse()`。
- `startTime < endTime`。`durationSeconds` 以 `ffprobe` 的实际结果为准；元数据时间范围与文件时长不一致时拒绝 materialize 并报告数据错误。
- 搜索区间与录像区间只要有重叠即为候选：`requestedStart < recordingEnd && requestedEnd > recordingStart`。
- `timestamp`、截图与裁剪区间必须落在源录像的闭区间内；裁剪额外要求 `startTime < endTime`。
- 业务层始终使用 Recording Absolute Time；播放器和 ffmpeg 内部才转换为相对视频 offset。派生 Clip 仍保留原录像绝对时间，不重置为 `00:00–00:30`。
- 用户只给“08:32”等不含日期/时区的表达，且会话上下文无法唯一推定时，Agent 必须追问或呈现候选，不得自行猜测。

### 视频时序指标（可选）

视频 Data Module 可为任意录像声明多个数值型时序指标；这是通用的数据承载机制，不为客流、人数或某个算法设置专用 Contract。示例：

```json
"metrics": [{
  "id": "visible_people",
  "label": "画面当前人数",
  "unit": "人",
  "file": "metrics/visible_people_second.csv",
  "sampleIntervalSeconds": 1
}]
```

`file` 必须是 Data Root 内无 symlink 的安全相对路径。指标 CSV 固定为 `relative_second,absolute_time,value`：前两列用于验证与录像时间轴一致，`value` 为有限数值。浏览器只通过同源 Session Resource 的 metrics API 取得已解析数据；播放器依照当前播放位置与 `sampleIntervalSeconds` 渲染已声明指标。没有指标声明的录像保持原有播放器行为。派生 Clip 按其绝对录像范围自动裁剪原录像的指标序列。

## 6. Session Video Resource Manifest

不建设视频资源数据库。每一个向 Session 发布的视频使用一个轻量、持久化的资源目录：

```text
<session cwd>/.tau/video-resources/
  video_<id>/
    manifest.json
    video.mp4
```

所有源视频在首次 `video_present` 时 materialize/copy 到该目录；V1 视频大小受控，优先复用现有 Session Resource 安全模型。`manifest.json` 至少包含：

```ts
type VideoResourceManifestV1 = {
  schemaVersion: 1;
  resourceId: string;
  videoId: string;
  kind: 'source' | 'derived';
  relativePath: 'video.mp4';
  mimeType: 'video/mp4';
  bytes: number;
  sha256: string;
  recordingStartTime: string;
  recordingEndTime: string;
  durationSeconds: number;
  sourceAssetId?: string;
  sourceRelativePath?: string;
  parentResourceId?: string;
  clipStartTime?: string;
  clipEndTime?: string;
};
```

`kind` 必填。source 必须记录 Data Asset 来源；derived 必须记录 parent、clip 起止绝对时间。服务端仅从 manifest 中解析文件，先 realpath 验证资源目录、manifest 与视频都没有逃出 Session Resource Root，再提供或处理文件。派生产物的临时文件可写入 `<session cwd>/.tau/video-output/`，校验成功后以原子方式注册到 `video-resources/`。

Demo Data Module 不强制在每次 Session Assembly 对大视频全量哈希；但 materialize 后的 Session Resource 必须计算并保存 SHA-256、字节数与 ffprobe 结果。Session Restore 只依赖此 manifest 恢复已发布视频。

## 7. Contract、Scene 与兼容性

新增 `src/contracts/video.ts`，提供 `VideoSceneSnapshotV1`、资源 manifest 及严格解析/诊断函数。建议 Scene：

```ts
type VideoSceneSnapshotV1 = {
  schemaVersion: 1;
  revision: number;
  videos: VideoSceneItemV1[];
  activeVideoId?: string;
};

type VideoSceneItemV1 = {
  id: string;
  videoId: string;
  resourceId: string;
  title: string;
  cameraId?: string;
  recordingStartTime: string;
  recordingEndTime: string;
  durationSeconds: number;
  initialSeekSeconds?: number;
  kind: 'source' | 'derived';
};
```

Scene 是历史事实：已展示视频、active item、录像时间范围、资源 ID 与初始定位。以下播放器瞬态状态不得写入 Pi JSONL：`currentTime`、播放/暂停、音量、倍速、buffered。React 只管理这些本地状态。

React 必须从 Video Scene 的 Session Projection 生成视图，遵循 Geo 等持久化 Workspace Feature 的投影模式；不得引入与历史状态脱节的第二事实源。

如需在 Runtime Capabilities 中声明 `videoSceneVersion`，该字段必须是可选的向后兼容字段：缺失表示不声明 Video Scene V1，而不是使旧 Bridge Envelope 和旧 Session 恢复解析失败。为此增加 Contract Migration Test。若没有实际跨版本协商需求，V1 优先仅依赖 Video Scene 自身的 `schemaVersion: 1`，避免扩大全局 capability 契约。

## 8. Agent Tools

所有工具接收结构化业务参数，Extension 只将其转发到受 token 保护的 Host endpoint。Agent 不得传任意 ffmpeg/shell 命令、任意输入路径或输出路径。

### `video_search`

```ts
{ location?: string; cameraId?: string; startTime?: string; endTime?: string }
```

在当前 Session 解析的 Data Assets 中检索，按地点、摄像头和录像时间区间重叠返回候选元数据；不返回绝对路径。时间边界只给一侧时，Skill 必须先补全为明确的查询意图或向用户澄清。

### `video_present`

```ts
{ videoId: string; timestamp?: string }
```

解析 Data Video，安全 materialize 为 Session Resource，验证 `timestamp` 位于录像范围内，转换为 `initialSeekSeconds`，更新 Video Scene。只要求查看视频时仅调用本工具，不自动分析内容。

### `video_snapshot`

```ts
{ videoId: string; timestamp: string }
```

提取该绝对录像时刻的一帧，返回文字元数据及真实图片 content，供 Pi 多模态模型使用。图片输出写入受控目录并经大小、类型和路径校验。

### `video_clip`

```ts
{ videoId: string; startTime: string; endTime: string }
```

单次最长 5 分钟。V1 固定使用**重新编码**为 Phase 0 验证的 Input Spec，禁止 stream copy；其产品语义是帧级精度裁剪，允许最多约一个视频帧的时间误差。成功后注册新的 derived Session Video Resource 并返回 `videoId/resourceId`，但不自动改写当前 Video Scene；需展示时再调用 `video_present`。

### `video_sample_frames`

```ts
{ videoId: string; startTime: string; endTime: string; frameCount?: number }
```

在合法区间均匀采样，默认 6 帧、最大 12 帧；每帧最长边不超过 1280px，并带对应绝对录像时间。实现还必须限制一次调用的图片总字节数；超过限制时应降采样/拒绝并提示，不能静默截断为未知集合。

## 9. VideoRunner 与安全

`VideoRunner` 位于 Agent Host，直接以参数数组 spawn 已验证的 ffmpeg/ffprobe，不引入 Python 中间层。它提供：

```text
probe() / snapshot() / clip() / sampleFrames()
```

职责包括：固定输入/输出编码参数、受控工作目录、超时、AbortSignal 取消、进程树清理、受限 stdout/stderr 捕获、输出存在性/类型/大小校验、失败后临时文件清理。每个请求均由服务端从 Video Resource Manifest 推导输入路径和时间 offset。

安全要求：资源 ID 绑定 Session；禁止跨 Session resourceId、路径逃逸、symlink 越界和 Module Data Root 外文件；输出只能位于当前 Session 工作区；并发或取消的作业不得留下可被注册为有效资源的半成品。

## 10. Browser Video Resource API

Video Resource API 使用现有同源 Browser Authentication，不使用 Pi token。接口只接受已验证的 `sessionId/resourceId`，并从 manifest 解析文件。

V1 必须支持：

- `GET` 与 `HEAD`；
- 单一 `Range: bytes=start-end`；
- `Accept-Ranges: bytes`、`206 Partial Content`、`Content-Range`、准确的 `Content-Length`；
- 无效或越界 Range 返回 `416`；
- `Cache-Control: private, no-store` 与 `X-Content-Type-Options: nosniff`。

V1 明确不支持 multipart byte ranges。视频不得通过 WebSocket 传输。

## 11. 多模态分析与 Agent Skill

V1 不提供 `video_analyze` 工具：

```text
明确时刻：video_snapshot → 图片多模态分析 → 回答
时间区间：video_sample_frames → 多张时序图片 → 综合回答
```

`video_snapshot` 与 `video_sample_frames` 可生成素材；当 Agent 要求模型理解画面时，必须先确认所选模型支持视觉输入。若不支持，明确提示用户切换视觉模型，而不是基于元数据或文件名猜测画面。

Skill 行为：

- 调录像：`video_search → 判断唯一候选或澄清 → video_present`。
- 只要求查看：仅 `video_present`。
- 截取：`video_clip`；只有用户要求查看结果才继续 `video_present`。
- 对时间段的回答必须说明“根据抽取的关键帧/采样画面”，不得声称已逐帧完整观看录像。
- 禁止只凭视频文件名或元数据描述视频内容。

## 12. UI

新增 `VideoWorkspace.tsx`，使用现有 Workspace 展示体系，具体采用 Float、Dock Tab 或当前容器中的最小改动方案由实现阶段依据现有 Workspace 结构确定；本 SPEC 不预设新的 UI 框架。

V1 只提供：标题、录像绝对时间、`<video>` 播放、原生播放/暂停与 Seek、初始自动定位、Loading、Error。无九宫格、复杂编辑器、PTZ、多视频同步或自定义播放器。React 不解释业务时间，仅使用 Contract 已计算的 display 元数据和 initial offset。

## 13. 开发阶段与验收

1. **Phase 0：Runtime / Playback Spike** → 已打包 macOS arm64 应用可播放唯一 Input Spec，Range、Seek、ffmpeg/ffprobe 均通过。
2. **Phase 1：Contract 与 Manifest** → video parser、Scene、兼容恢复测试、Session Resource Manifest。
3. **Phase 2：Demo Data 与检索** → Data Module、Asset Resolver 接入、`video_search`。
4. **Phase 3：播放** → Resource API、Range、`video_present`、Projection、Video View。
5. **Phase 4：处理** → VideoRunner、snapshot/clip/sampleFrames、取消与隔离。
6. **Phase 5：多模态** → 图片 tool result、视觉模型门控与 smoke。

至少覆盖：Video Contract、旧 Bridge/Session 迁移、Data 查询、Session Resource Manifest、HTTP GET/HEAD/Range/416、跨 Session 拒绝、symlink 与路径逃逸拒绝、VideoRunner 成功/超时/取消/半成品清理、Extension、Projection、React Smoke、打包 macOS Desktop Smoke。

多模态测试分两层：

- 确定性集成测试：截图成功，tool result 含 image content，视觉模型路径被调用；
- 可选真实模型 smoke：对固定测试图片产生非空视觉描述，不断言某一句具体自然语言。

## 14. Definition of Done

在 macOS arm64 打包应用中，以下闭环全部通过：

```text
自然语言 → video_search → video_present → Video View → 指定时间定位
→ video_snapshot / video_sample_frames → 视觉模型分析 → video_clip → 播放派生片段
```

并同时满足：ffmpeg/ffprobe 受控随包提供；资源 manifest 可支持 Session Restore；浏览器与 Pi 鉴权分离；Range/Seek 正常；裁剪为重编码且满足帧级精度语义；绝对时间带 offset 且范围校验严格；旧 Session 可恢复；Agent/React 无绝对路径；资源隔离、输出限制和多模态门控均有测试。
