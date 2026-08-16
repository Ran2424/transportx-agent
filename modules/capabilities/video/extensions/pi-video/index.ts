import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  VIDEO_SCENE_SCHEMA_VERSION,
  getVideoSceneFromToolResult,
  type VideoEnvelopeV1,
  type VideoSceneItemV1,
  type VideoSceneSnapshotV1,
} from '../../../../../src/contracts/index.ts';

type HostResponse<T> = T & { error?: string };

function videoHost() {
  const endpoint = process.env.TAU_VIDEO_ENDPOINT;
  const sessionId = process.env.TAU_VIDEO_SESSION_ID;
  const token = process.env.TAU_VIDEO_TOKEN;
  if (!endpoint || !sessionId || !token) throw new Error('Video Agent Host bridge is unavailable for this session.');
  return { endpoint, sessionId, token };
}

async function callHost<T>(operation: string, body: Record<string, unknown>): Promise<T> {
  const host = videoHost();
  const response = await fetch(`${host.endpoint}/api/internal/video/${operation}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, sessionId: host.sessionId, token: host.token }),
  });
  const payload = (await response.json()) as HostResponse<T>;
  if (!response.ok || payload.error) throw new Error(payload.error || 'Video Agent Host request failed.');
  return payload;
}

function assertVisionModel(ctx: ExtensionContext) {
  const model = ctx.model;
  const inputs: unknown = model && (model as { input?: unknown }).input;
  const supportsImage = Array.isArray(inputs) && inputs.includes('image');
  if (!supportsImage) {
    throw new Error('The current model does not support image input. Ask the user to switch to a vision-capable model before analyzing video frames; do not guess picture content from metadata.');
  }
}

type Candidate = { videoId: string; cameraId?: string; title: string; locationName?: string; startTime: string; endTime: string };

type SceneState = { revision: number; scene: VideoSceneSnapshotV1 };

export default function videoExtension(pi: ExtensionAPI) {
  let state: SceneState = { revision: 0, scene: { schemaVersion: VIDEO_SCENE_SCHEMA_VERSION, revision: 0, videos: [] } };

  const restore = (ctx: ExtensionContext) => {
    state = { revision: 0, scene: { schemaVersion: VIDEO_SCENE_SCHEMA_VERSION, revision: 0, videos: [] } };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'message' || entry.message.role !== 'toolResult') continue;
      const envelope = getVideoSceneFromToolResult(entry.message);
      if (envelope && envelope.revision >= state.revision) state = { revision: envelope.revision, scene: envelope.scene };
    }
  };

  pi.on('session_start', async (_event, ctx) => restore(ctx));
  pi.on('session_tree', async (_event, ctx) => restore(ctx));

  const presentItem = (item: VideoSceneItemV1): VideoEnvelopeV1 => {
    const videos = state.scene.videos.filter((existing) => existing.id !== item.id);
    videos.push(item);
    const revision = state.revision + 1;
    state = { revision, scene: { schemaVersion: VIDEO_SCENE_SCHEMA_VERSION, revision, videos, activeVideoId: item.id } };
    return { schemaVersion: VIDEO_SCENE_SCHEMA_VERSION, revision, scene: state.scene };
  };

  pi.registerTool({
    name: 'video_search',
    label: '检索录像',
    description: 'Search recorded demo videos in the resolved Data Assets of this session by location, camera and recording time-range overlap. Returns candidate metadata only (never absolute paths). startTime/endTime must be provided together as ISO 8601 with an explicit numeric timezone offset.',
    promptSnippet: 'Find recorded videos by location, camera or recording time range',
    parameters: Type.Object({
      location: Type.Optional(Type.String({ maxLength: 300, description: 'Location/title keywords, e.g. 人民路 or 虹桥 地铁入口; multiple space-separated keywords must all match' })),
      cameraId: Type.Optional(Type.String({ maxLength: 120 })),
      startTime: Type.Optional(Type.String({ maxLength: 64, description: 'ISO 8601 with numeric offset, e.g. 2026-08-16T08:30:00+08:00' })),
      endTime: Type.Optional(Type.String({ maxLength: 64 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const result = await callHost<{ candidates: Candidate[] }>('search', params as Record<string, unknown>);
      if (!result.candidates.length) {
        return { content: [{ type: 'text' as const, text: 'No video data is available for this query. The session may not have a video Data Module installed, or no recording matches the filters.' }], details: { kind: 'tau-video-search' as const, candidates: result.candidates } };
      }
      const lines = result.candidates.map((item) => `- ${item.videoId} | ${item.title}${item.cameraId ? ` | camera ${item.cameraId}` : ''} | ${item.startTime} – ${item.endTime}`);
      return {
        content: [{ type: 'text' as const, text: `Found ${result.candidates.length} video candidate(s):\n${lines.join('\n')}` }],
        details: { kind: 'tau-video-search' as const, candidates: result.candidates },
      };
    },
  });

  pi.registerTool({
    name: 'video_present',
    label: '展示录像',
    description: 'Materialize a recorded video as a session resource and present it in the Video Workspace, optionally seeking to an absolute recording timestamp. Use this when the user wants to view a video; it does not analyze the content. For a derived clip, pass its resourceId instead of videoId.',
    promptSnippet: 'Present a recorded video in the workspace, optionally at a specific recording time',
    parameters: Type.Object({
      videoId: Type.Optional(Type.String({ maxLength: 120 })),
      resourceId: Type.Optional(Type.String({ maxLength: 120, description: 'Session video resource id of a derived clip' })),
      timestamp: Type.Optional(Type.String({ maxLength: 64, description: 'Absolute recording time, ISO 8601 with numeric offset' })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      if (!params.videoId && !params.resourceId) throw new Error('videoId or resourceId is required.');
      const result = await callHost<{ item: VideoSceneItemV1 }>('present', params as Record<string, unknown>);
      const envelope = presentItem(result.item);
      const seek = result.item.initialSeekSeconds !== undefined ? ` Initial position: ${result.item.initialSeekSeconds.toFixed(1)}s into the recording.` : '';
      return {
        content: [{ type: 'text' as const, text: `Presenting "${result.item.title}" (${result.item.recordingStartTime} – ${result.item.recordingEndTime}).${seek}` }],
        details: { kind: 'tau-video-present' as const, video: envelope },
      };
    },
  });

  pi.registerTool({
    name: 'video_snapshot',
    label: '视频截图',
    description: 'Extract one frame at an absolute recording timestamp and return it as an image for multimodal analysis. Requires a vision-capable model.',
    promptSnippet: 'Capture the frame at a specific recording time for visual analysis',
    parameters: Type.Object({
      videoId: Type.Optional(Type.String({ maxLength: 120 })),
      resourceId: Type.Optional(Type.String({ maxLength: 120 })),
      timestamp: Type.String({ maxLength: 64, description: 'Absolute recording time, ISO 8601 with numeric offset' }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.videoId && !params.resourceId) throw new Error('videoId or resourceId is required.');
      assertVisionModel(ctx);
      const result = await callHost<{ videoId: string; timestamp: string; mimeType: 'image/jpeg'; dataBase64: string; bytes: number }>('snapshot', params as Record<string, unknown>);
      return {
        content: [
          { type: 'text' as const, text: `Frame extracted from ${result.videoId} at recording time ${result.timestamp}. Describe what is visible in this single frame; do not claim to have watched the full video.` },
          { type: 'image' as const, data: result.dataBase64, mimeType: result.mimeType },
        ],
        details: { kind: 'tau-video-snapshot' as const, videoId: result.videoId, timestamp: result.timestamp, bytes: result.bytes },
      };
    },
  });

  pi.registerTool({
    name: 'video_clip',
    label: '裁剪视频',
    description: 'Re-encode a frame-accurate clip (max 5 minutes) between two absolute recording times and register it as a derived session video resource. Does not change the presented scene; call video_present with the returned resourceId to view the clip.',
    promptSnippet: 'Cut a frame-accurate clip between two recording times',
    parameters: Type.Object({
      videoId: Type.String({ maxLength: 120 }),
      startTime: Type.String({ maxLength: 64 }),
      endTime: Type.String({ maxLength: 64 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const result = await callHost<{ videoId: string; resourceId: string; clipStartTime: string; clipEndTime: string; durationSeconds: number }>('clip', params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: `Clip created as resource ${result.resourceId} (${result.clipStartTime} – ${result.clipEndTime}, ${result.durationSeconds.toFixed(1)}s). Call video_present with resourceId="${result.resourceId}" if the user wants to view it.` }],
        details: { kind: 'tau-video-clip' as const, ...result },
      };
    },
  });

  pi.registerTool({
    name: 'video_sample_frames',
    label: '视频抽帧',
    description: 'Uniformly sample frames (default 6, max 12) over an absolute recording time range and return them as time-ordered images for multimodal analysis. Requires a vision-capable model.',
    promptSnippet: 'Sample time-ordered frames over a recording range for visual analysis',
    parameters: Type.Object({
      videoId: Type.Optional(Type.String({ maxLength: 120 })),
      resourceId: Type.Optional(Type.String({ maxLength: 120 })),
      startTime: Type.String({ maxLength: 64 }),
      endTime: Type.String({ maxLength: 64 }),
      frameCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!params.videoId && !params.resourceId) throw new Error('videoId or resourceId is required.');
      assertVisionModel(ctx);
      const result = await callHost<{ videoId: string; startTime: string; endTime: string; frames: Array<{ timestamp: string; mimeType: 'image/jpeg'; dataBase64: string; bytes: number }> }>('sample-frames', params as Record<string, unknown>);
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text' as const, text: `Sampled ${result.frames.length} key frames from ${result.videoId} between ${result.startTime} and ${result.endTime}. Answer based on these sampled frames only; never claim to have watched the recording frame by frame.` },
      ];
      for (const frame of result.frames) {
        content.push({ type: 'text' as const, text: `Frame at ${frame.timestamp}:` });
        content.push({ type: 'image' as const, data: frame.dataBase64, mimeType: frame.mimeType });
      }
      return {
        content,
        details: { kind: 'tau-video-sample-frames' as const, videoId: result.videoId, startTime: result.startTime, endTime: result.endTime, frameCount: result.frames.length },
      };
    },
  });
}
