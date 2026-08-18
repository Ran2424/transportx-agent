const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

import {
  formatVideoTimestamp,
  parseVideoCatalogStructured,
  parseVideoResourceManifestStructured,
  parseVideoTimestamp,
  recordingIntervalOverlaps,
  videoDiagnosticsMessage,
  videoOffsetSeconds,
  type VideoCatalogEntryV1,
  type VideoResourceManifestV1,
  type VideoSceneItemV1,
} from '../contracts/index.js';
import type { ResolvedSessionPlanV3 } from '../contracts/resolved-session-plan.js';
import { sha256File, within } from './asset-integrity.js';
import { VideoRunner } from './video-runner.js';
import type { VideoExecutables } from './runtime-resolver.js';

const MAX_CLIP_SECONDS = 300;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_FRAME_TOTAL_BYTES = 6 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const DEFAULT_FRAME_COUNT = 6;
const MAX_FRAME_COUNT = 12;
/** Metadata recording range vs ffprobe duration tolerance. */
const DURATION_TOLERANCE_SECONDS = 1.5;

export type VideoSessionContext = { cwd: string; resolvedSessionPlan: ResolvedSessionPlanV3 | null };

type CatalogRecord = { entry: VideoCatalogEntryV1; assetId: string; assetRoot: string };

export type VideoSearchQuery = { location?: string; cameraId?: string; startTime?: string; endTime?: string };

export type VideoCandidate = {
  videoId: string;
  cameraId?: string;
  title: string;
  locationName?: string;
  startTime: string;
  endTime: string;
};

export type VideoSnapshotResult = { videoId: string; timestamp: string; mimeType: 'image/jpeg'; dataBase64: string; bytes: number };

export type VideoClipResult = {
  videoId: string;
  resourceId: string;
  clipStartTime: string;
  clipEndTime: string;
  durationSeconds: number;
  title: string;
};

export type VideoSampledFrame = { timestamp: string; mimeType: 'image/jpeg'; dataBase64: string; bytes: number };

export type VideoSampleFramesResult = { videoId: string; startTime: string; endTime: string; frames: VideoSampledFrame[]; totalBytes: number };
export type VideoMetricsResult = { metrics: Array<{ id: string; label: string; unit: string; sampleIntervalSeconds: number; samples: Array<{ offsetSeconds: number; value: number }> }> };

function requiredString(body: Record<string, unknown>, key: string, max = 1000) {
  const value = typeof body[key] === 'string' ? body[key].trim() : '';
  if (!value || value.length > max) throw new Error(`${key} is required`);
  return value;
}

function optionalString(body: Record<string, unknown>, key: string, max = 1000) {
  const value = body[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${key} must be a string`);
  return value.trim();
}

function requiredTimestamp(body: Record<string, unknown>, key: string) {
  const raw = requiredString(body, key, 64);
  const parsed = parseVideoTimestamp(raw);
  if (!parsed) throw new Error(`${key} must be ISO 8601 with an explicit numeric timezone offset (e.g. 2026-08-16T08:32:00+08:00)`);
  return parsed;
}

function resourcesRoot(cwd: string) {
  return path.join(cwd, '.tau', 'video-resources');
}

function outputRoot(cwd: string) {
  return path.join(cwd, '.tau', 'video-output');
}

function resolveSafeDataFile(assetRoot: string, relativeFile: string) {
  if (path.isAbsolute(relativeFile)) throw new Error(`Video file must be relative: ${relativeFile}`);
  const root = fs.realpathSync(assetRoot);
  const parts = relativeFile.split(/[\\/]+/);
  let cursor = root;
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw new Error(`Unsafe video file path: ${relativeFile}`);
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Video files cannot use symbolic links: ${relativeFile}`);
  }
  const resolved = fs.realpathSync(path.resolve(root, relativeFile));
  if (!within(root, resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Video file escapes the Data Root: ${relativeFile}`);
  return resolved;
}

function parseVideoMetricSamples(csvText: string, sourceStartTime: string, recordingStartTime: string, durationSeconds: number, sampleIntervalSeconds: number): Array<{ offsetSeconds: number; value: number }> {
  const sourceStart = parseVideoTimestamp(sourceStartTime);
  const recordingStart = parseVideoTimestamp(recordingStartTime);
  if (!sourceStart || !recordingStart) throw new Error('Video count source has invalid recording time metadata');
  const [header, ...rows] = csvText.trim().split(/\r?\n/);
  if (header !== 'relative_second,absolute_time,value') throw new Error('Video metric CSV has an unsupported header');
  if (rows.length > 20_000) throw new Error('Video metric CSV exceeds the supported sample limit');
  const samples: Array<{ offsetSeconds: number; value: number }> = [];
  let previousOffset = -1;
  for (const row of rows) {
    const [relativeSecond, absoluteTime, rawValue, ...extra] = row.split(',');
    const sourceOffset = Number(relativeSecond);
    const value = Number(rawValue);
    const timestamp = parseVideoTimestamp(absoluteTime);
    if (extra.length || !Number.isInteger(sourceOffset) || sourceOffset < 0 || sourceOffset % sampleIntervalSeconds !== 0 || sourceOffset <= previousOffset || !Number.isFinite(value) || !timestamp || timestamp.epochMs !== sourceStart.epochMs + sourceOffset * 1000) {
      throw new Error('Video metric CSV contains an invalid sample');
    }
    previousOffset = sourceOffset;
    const offsetSeconds = (timestamp.epochMs - recordingStart.epochMs) / 1000;
    if (offsetSeconds >= 0 && offsetSeconds <= durationSeconds) samples.push({ offsetSeconds, value });
  }
  return samples;
}

function sceneItemFromManifest(manifest: VideoResourceManifestV1, title: string, cameraId: string | undefined, initialSeekSeconds?: number): VideoSceneItemV1 {
  return {
    id: manifest.resourceId,
    videoId: manifest.videoId,
    resourceId: manifest.resourceId,
    title,
    ...(cameraId ? { cameraId } : {}),
    recordingStartTime: manifest.recordingStartTime,
    recordingEndTime: manifest.recordingEndTime,
    durationSeconds: manifest.durationSeconds,
    ...(initialSeekSeconds !== undefined && initialSeekSeconds > 0 ? { initialSeekSeconds } : {}),
    kind: manifest.kind,
  };
}

export class VideoService {
  private runner: VideoRunner | null;

  constructor(executables: VideoExecutables | null) {
    this.runner = executables ? new VideoRunner(executables) : null;
  }

  private requireRunner() {
    if (!this.runner) throw new Error('Video processing is unavailable: ffmpeg/ffprobe are not configured for this runtime');
    return this.runner;
  }

  /** Scan the session's resolved Data Assets for videos.json catalogs. */
  private catalog(session: VideoSessionContext): CatalogRecord[] {
    const records: CatalogRecord[] = [];
    const seen = new Set<string>();
    for (const asset of session.resolvedSessionPlan?.assets ?? []) {
      if (asset.kind !== 'data') continue;
      const catalogPath = path.join(asset.path, 'videos.json');
      if (!fs.existsSync(catalogPath)) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      } catch {
        throw new Error(`Video catalog is not valid JSON: ${asset.id}`);
      }
      const parsed = parseVideoCatalogStructured(raw);
      if (!parsed.ok) throw new Error(`Video catalog ${asset.id} is invalid: ${videoDiagnosticsMessage(parsed.diagnostics)}`);
      for (const entry of parsed.value.videos) {
        if (seen.has(entry.videoId)) throw new Error(`Duplicate videoId across Data Assets: ${entry.videoId}`);
        seen.add(entry.videoId);
        records.push({ entry, assetId: asset.id, assetRoot: asset.path });
      }
    }
    return records;
  }

  search(session: VideoSessionContext, body: Record<string, unknown>): { candidates: VideoCandidate[] } {
    const location = optionalString(body, 'location', 300);
    const locationTokens = location ? location.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const cameraId = optionalString(body, 'cameraId', 120);
    const startRaw = optionalString(body, 'startTime', 64);
    const endRaw = optionalString(body, 'endTime', 64);
    if ((startRaw && !endRaw) || (!startRaw && endRaw)) throw new Error('startTime and endTime must be provided together');
    let range: { startMs: number; endMs: number } | null = null;
    if (startRaw && endRaw) {
      const start = parseVideoTimestamp(startRaw);
      const end = parseVideoTimestamp(endRaw);
      if (!start || !end) throw new Error('startTime/endTime must be ISO 8601 with an explicit numeric timezone offset');
      if (start.epochMs >= end.epochMs) throw new Error('startTime must be before endTime');
      range = { startMs: start.epochMs, endMs: end.epochMs };
    }
    const candidates = this.catalog(session)
      .filter(({ entry }) => {
        if (cameraId && entry.cameraId !== cameraId) return false;
        if (locationTokens.length) {
          const haystack = `${entry.title} ${entry.locationName || ''} ${entry.cameraId || ''}`.toLowerCase();
          if (!locationTokens.every((token) => haystack.includes(token))) return false;
        }
        if (range && !recordingIntervalOverlaps(range.startMs, range.endMs, entry.startTime, entry.endTime)) return false;
        return true;
      })
      .map(({ entry }): VideoCandidate => ({
        videoId: entry.videoId,
        ...(entry.cameraId ? { cameraId: entry.cameraId } : {}),
        title: entry.title,
        ...(entry.locationName ? { locationName: entry.locationName } : {}),
        startTime: entry.startTime,
        endTime: entry.endTime,
      }));
    return { candidates };
  }

  loadManifest(session: VideoSessionContext, resourceId: string): { manifest: VideoResourceManifestV1; videoPath: string } {
    if (!/^video_[a-f0-9]{16}$/.test(resourceId)) throw new Error(`Invalid video resource id: ${resourceId}`);
    const root = resourcesRoot(session.cwd);
    const resourceDir = path.join(root, resourceId);
    const manifestPath = path.join(resourceDir, 'manifest.json');
    const videoPath = path.join(resourceDir, 'video.mp4');
    const realRoot = fs.realpathSync(root);
    const realDir = fs.realpathSync(resourceDir);
    const realManifest = fs.realpathSync(manifestPath);
    const realVideo = fs.realpathSync(videoPath);
    if (!within(realRoot, realDir) || !within(realDir, realManifest) || !within(realDir, realVideo)) throw new Error('Video resource path is not allowed');
    const parsed = parseVideoResourceManifestStructured(JSON.parse(fs.readFileSync(realManifest, 'utf8')));
    if (!parsed.ok) throw new Error(`Video resource manifest is invalid: ${videoDiagnosticsMessage(parsed.diagnostics)}`);
    if (parsed.value.resourceId !== resourceId) throw new Error('Video resource manifest id mismatch');
    return { manifest: parsed.value, videoPath: realVideo };
  }

  private findRecord(session: VideoSessionContext, videoId: string): CatalogRecord {
    const record = this.catalog(session).find((item) => item.entry.videoId === videoId);
    if (!record) throw new Error(`Video not found in the resolved Data Assets of this session: ${videoId}`);
    return record;
  }

  /** Resolve any video reference (source by videoId, or already-published derived by resourceId). */
  private async resolveResource(session: VideoSessionContext, opts: { videoId?: string; resourceId?: string }): Promise<{ manifest: VideoResourceManifestV1; videoPath: string; title: string; cameraId?: string }> {
    if (opts.resourceId) {
      const { manifest, videoPath } = this.loadManifest(session, opts.resourceId);
      let title = manifest.videoId;
      let cameraId: string | undefined;
      if (manifest.kind === 'source') {
        const record = this.catalog(session).find((item) => item.entry.videoId === manifest.videoId);
        title = record?.entry.title || title;
        cameraId = record?.entry.cameraId;
      } else {
        title = `Clip ${manifest.clipStartTime} – ${manifest.clipEndTime}`;
      }
      return { manifest, videoPath, title, cameraId };
    }
    if (!opts.videoId) throw new Error('videoId or resourceId is required');
    const record = this.findRecord(session, opts.videoId);
    const ensured = await this.ensureResourceAsync(session, record);
    return { ...ensured, title: record.entry.title, ...(record.entry.cameraId ? { cameraId: record.entry.cameraId } : {}) };
  }

  private ensureResourceAsync(session: VideoSessionContext, record: CatalogRecord): Promise<{ manifest: VideoResourceManifestV1; videoPath: string }> {
    const runner = this.requireRunner();
    const resourceId = `video_${crypto.createHash('sha256').update(`${record.assetId}:${record.entry.videoId}`).digest('hex').slice(0, 16)}`;
    return (async () => {
      const resolvedFile = resolveSafeDataFile(record.assetRoot, record.entry.file);
      try {
        const existing = this.loadManifest(session, resourceId);
        if (existing.manifest.kind === 'source' && existing.manifest.sourceAssetId === record.assetId) return existing;
      } catch { /* not materialized yet */ }
      const stat = fs.statSync(resolvedFile);
      if (stat.size > MAX_VIDEO_BYTES) throw new Error(`Video exceeds the ${MAX_VIDEO_BYTES / 1024 / 1024} MiB V1 size limit: ${record.entry.videoId}`);
      const probedDuration = (await runner.probe(resolvedFile)).durationSeconds;
      const start = parseVideoTimestamp(record.entry.startTime)!;
      const end = parseVideoTimestamp(record.entry.endTime)!;
      const metadataDuration = (end.epochMs - start.epochMs) / 1000;
      if (Math.abs(metadataDuration - probedDuration) > DURATION_TOLERANCE_SECONDS) {
        throw new Error(`Video metadata time range (${metadataDuration.toFixed(1)}s) does not match the probed duration (${probedDuration.toFixed(1)}s): ${record.entry.videoId}`);
      }
      const stagingDir = path.join(outputRoot(session.cwd), `stage_${resourceId}_${crypto.randomBytes(4).toString('hex')}`);
      fs.mkdirSync(stagingDir, { recursive: true });
      try {
        const stagedVideo = path.join(stagingDir, 'video.mp4');
        fs.copyFileSync(resolvedFile, stagedVideo);
        const manifest: VideoResourceManifestV1 = {
          schemaVersion: 1,
          resourceId,
          videoId: record.entry.videoId,
          kind: 'source',
          relativePath: 'video.mp4',
          mimeType: 'video/mp4',
          bytes: fs.statSync(stagedVideo).size,
          sha256: sha256File(stagedVideo),
          recordingStartTime: record.entry.startTime,
          recordingEndTime: record.entry.endTime,
          durationSeconds: probedDuration,
          sourceAssetId: record.assetId,
          sourceRelativePath: record.entry.file,
        };
        fs.writeFileSync(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        const targetDir = path.join(resourcesRoot(session.cwd), resourceId);
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.mkdirSync(resourcesRoot(session.cwd), { recursive: true });
        fs.renameSync(stagingDir, targetDir);
        return { manifest, videoPath: path.join(targetDir, 'video.mp4') };
      } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    })();
  }

  private assertWithinRecording(manifest: VideoResourceManifestV1, iso: string, label: string) {
    const start = parseVideoTimestamp(manifest.recordingStartTime)!;
    const end = parseVideoTimestamp(manifest.recordingEndTime)!;
    const target = parseVideoTimestamp(iso);
    if (!target) throw new Error(`${label} must be ISO 8601 with an explicit numeric timezone offset`);
    if (target.epochMs < start.epochMs || target.epochMs > end.epochMs) {
      throw new Error(`${label} ${iso} is outside the recording range ${manifest.recordingStartTime} – ${manifest.recordingEndTime}`);
    }
    return target;
  }

  async present(session: VideoSessionContext, body: Record<string, unknown>): Promise<{ item: VideoSceneItemV1 }> {
    const videoId = optionalString(body, 'videoId', 120);
    const resourceId = optionalString(body, 'resourceId', 120);
    const timestampRaw = optionalString(body, 'timestamp', 64);
    const resolved = await this.resolveResource(session, { videoId, resourceId });
    let initialSeekSeconds: number | undefined;
    if (timestampRaw) {
      const target = this.assertWithinRecording(resolved.manifest, timestampRaw, 'timestamp');
      const offset = videoOffsetSeconds(resolved.manifest.recordingStartTime, target.iso);
      if (offset === null) throw new Error('timestamp could not be converted to a video offset');
      initialSeekSeconds = Math.min(offset, resolved.manifest.durationSeconds);
    }
    return { item: sceneItemFromManifest(resolved.manifest, resolved.title, resolved.cameraId, initialSeekSeconds) };
  }

  metrics(session: VideoSessionContext, resourceId: string): VideoMetricsResult {
    const { manifest } = this.loadManifest(session, resourceId);
    const record = this.findRecord(session, manifest.videoId);
    const metrics = (record.entry.metrics ?? []).map((metric) => {
      const metricPath = resolveSafeDataFile(record.assetRoot, metric.file);
      const stat = fs.statSync(metricPath);
      if (stat.size > 2 * 1024 * 1024) throw new Error(`Video metric exceeds the supported size limit: ${metric.id}`);
      return {
        id: metric.id,
        label: metric.label,
        unit: metric.unit,
        sampleIntervalSeconds: metric.sampleIntervalSeconds,
        samples: parseVideoMetricSamples(fs.readFileSync(metricPath, 'utf8'), record.entry.startTime, manifest.recordingStartTime, manifest.durationSeconds, metric.sampleIntervalSeconds),
      };
    });
    return { metrics };
  }

  async snapshot(session: VideoSessionContext, body: Record<string, unknown>, signal?: AbortSignal): Promise<VideoSnapshotResult> {
    const videoId = optionalString(body, 'videoId', 120);
    const resourceId = optionalString(body, 'resourceId', 120);
    const timestamp = requiredTimestamp(body, 'timestamp');
    const resolved = await this.resolveResource(session, { videoId, resourceId });
    const target = this.assertWithinRecording(resolved.manifest, timestamp.iso, 'timestamp');
    const offset = videoOffsetSeconds(resolved.manifest.recordingStartTime, target.iso);
    if (offset === null) throw new Error('timestamp could not be converted to a video offset');

    const outDir = outputRoot(session.cwd);
    fs.mkdirSync(outDir, { recursive: true });
    const outputPath = path.join(outDir, `snap_${crypto.randomBytes(8).toString('hex')}.jpg`);
    try {
      await this.requireRunner().snapshot({ inputPath: resolved.videoPath, offsetSeconds: offset, outputPath }, { signal });
      const bytes = fs.statSync(outputPath).size;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(`Snapshot exceeds the ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MiB limit`);
      return { videoId: resolved.manifest.videoId, timestamp: timestamp.iso, mimeType: 'image/jpeg', dataBase64: fs.readFileSync(outputPath).toString('base64'), bytes };
    } finally {
      fs.rmSync(outputPath, { force: true });
    }
  }

  async clip(session: VideoSessionContext, body: Record<string, unknown>, signal?: AbortSignal): Promise<VideoClipResult> {
    const videoId = requiredString(body, 'videoId', 120);
    const start = requiredTimestamp(body, 'startTime');
    const end = requiredTimestamp(body, 'endTime');
    if (start.epochMs >= end.epochMs) throw new Error('startTime must be before endTime');
    const durationSeconds = (end.epochMs - start.epochMs) / 1000;

    const resolved = await this.resolveResource(session, { videoId });
    this.assertWithinRecording(resolved.manifest, start.iso, 'startTime');
    this.assertWithinRecording(resolved.manifest, end.iso, 'endTime');
    if (durationSeconds > MAX_CLIP_SECONDS) throw new Error(`Clips are limited to ${MAX_CLIP_SECONDS / 60} minutes`);
    const offset = videoOffsetSeconds(resolved.manifest.recordingStartTime, start.iso);
    if (offset === null) throw new Error('startTime could not be converted to a video offset');

    const outDir = outputRoot(session.cwd);
    fs.mkdirSync(outDir, { recursive: true });
    const tempOutput = path.join(outDir, `clip_${crypto.randomBytes(8).toString('hex')}.mp4`);
    const runner = this.requireRunner();
    try {
      await runner.clip({ inputPath: resolved.videoPath, startSeconds: offset, durationSeconds, outputPath: tempOutput }, { signal });
      const probed = await runner.probe(tempOutput, { signal });
      const stat = fs.statSync(tempOutput);
      if (stat.size > MAX_VIDEO_BYTES) throw new Error('Clip output exceeds the video size limit');

      const resourceId = `video_${crypto.createHash('sha256').update(`${resolved.manifest.resourceId}:${start.iso}:${end.iso}`).digest('hex').slice(0, 16)}`;
      const stagingDir = path.join(outDir, `stage_${resourceId}_${crypto.randomBytes(4).toString('hex')}`);
      fs.mkdirSync(stagingDir, { recursive: true });
      try {
        const stagedVideo = path.join(stagingDir, 'video.mp4');
        fs.renameSync(tempOutput, stagedVideo);
        const startOffset = parseVideoTimestamp(resolved.manifest.recordingStartTime)!.offsetMinutes;
        const manifest: VideoResourceManifestV1 = {
          schemaVersion: 1,
          resourceId,
          videoId: resolved.manifest.videoId,
          kind: 'derived',
          relativePath: 'video.mp4',
          mimeType: 'video/mp4',
          bytes: stat.size,
          sha256: sha256File(stagedVideo),
          recordingStartTime: formatVideoTimestamp(start.epochMs, startOffset),
          recordingEndTime: formatVideoTimestamp(end.epochMs, startOffset),
          durationSeconds: probed.durationSeconds,
          parentResourceId: resolved.manifest.resourceId,
          clipStartTime: start.iso,
          clipEndTime: end.iso,
        };
        fs.writeFileSync(path.join(stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
        const targetDir = path.join(resourcesRoot(session.cwd), resourceId);
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.mkdirSync(resourcesRoot(session.cwd), { recursive: true });
        fs.renameSync(stagingDir, targetDir);
        return {
          videoId: resolved.manifest.videoId,
          resourceId,
          clipStartTime: start.iso,
          clipEndTime: end.iso,
          durationSeconds: probed.durationSeconds,
          title: `Clip ${start.iso} – ${end.iso}`,
        };
      } finally {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tempOutput, { force: true });
    }
  }

  async sampleFrames(session: VideoSessionContext, body: Record<string, unknown>, signal?: AbortSignal): Promise<VideoSampleFramesResult> {
    const videoId = optionalString(body, 'videoId', 120);
    const resourceId = optionalString(body, 'resourceId', 120);
    const start = requiredTimestamp(body, 'startTime');
    const end = requiredTimestamp(body, 'endTime');
    if (start.epochMs >= end.epochMs) throw new Error('startTime must be before endTime');
    const frameCountRaw = body.frameCount;
    const frameCount = frameCountRaw === undefined ? DEFAULT_FRAME_COUNT : frameCountRaw;
    if (!Number.isInteger(frameCount) || (frameCount as number) < 1 || (frameCount as number) > MAX_FRAME_COUNT) throw new Error(`frameCount must be an integer between 1 and ${MAX_FRAME_COUNT}`);

    const resolved = await this.resolveResource(session, { videoId, resourceId });
    this.assertWithinRecording(resolved.manifest, start.iso, 'startTime');
    this.assertWithinRecording(resolved.manifest, end.iso, 'endTime');
    const startOffset = videoOffsetSeconds(resolved.manifest.recordingStartTime, start.iso);
    if (startOffset === null) throw new Error('startTime could not be converted to a video offset');
    const spanSeconds = (end.epochMs - start.epochMs) / 1000;

    const runner = this.requireRunner();
    const outDir = outputRoot(session.cwd);
    fs.mkdirSync(outDir, { recursive: true });
    const offsets = Array.from({ length: frameCount as number }, (_, index) => startOffset + ((index + 0.5) * spanSeconds) / (frameCount as number));

    const attempt = async (maxWidth: number): Promise<VideoSampledFrame[]> => {
      const frames: VideoSampledFrame[] = [];
      const outputs: string[] = [];
      try {
        for (const [index, offset] of offsets.entries()) {
          const outputPath = path.join(outDir, `frame_${crypto.randomBytes(8).toString('hex')}.jpg`);
          outputs.push(outputPath);
          await runner.snapshot({ inputPath: resolved.videoPath, offsetSeconds: offset, outputPath, maxWidth }, { signal, timeoutMs: 30_000 });
          const bytes = fs.statSync(outputPath).size;
          const epochMs = start.epochMs + ((index + 0.5) * (end.epochMs - start.epochMs)) / (frameCount as number);
          frames.push({
            timestamp: formatVideoTimestamp(epochMs, parseVideoTimestamp(resolved.manifest.recordingStartTime)!.offsetMinutes),
            mimeType: 'image/jpeg',
            dataBase64: fs.readFileSync(outputPath).toString('base64'),
            bytes,
          });
        }
        return frames;
      } finally {
        for (const output of outputs) fs.rmSync(output, { force: true });
      }
    };

    let frames = await attempt(1280);
    let totalBytes = frames.reduce((sum, frame) => sum + frame.bytes, 0);
    if (totalBytes > MAX_FRAME_TOTAL_BYTES) {
      frames = await attempt(640);
      totalBytes = frames.reduce((sum, frame) => sum + frame.bytes, 0);
    }
    if (totalBytes > MAX_FRAME_TOTAL_BYTES) {
      throw new Error(`Sampled frames exceed the ${MAX_FRAME_TOTAL_BYTES / 1024 / 1024} MiB per-call limit; reduce frameCount or the time range`);
    }
    return { videoId: resolved.manifest.videoId, startTime: start.iso, endTime: end.iso, frames, totalBytes };
  }

  terminateAll() {
    this.runner?.terminateAll();
  }
}
