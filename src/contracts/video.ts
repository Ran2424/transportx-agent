/**
 * Video Capability V1 contract surface.
 *
 * Shared by the Pi Video Extension, the Agent Host Video Service and the
 * React Video Workspace. All business times are Recording Absolute Time:
 * ISO 8601 with an explicit numeric timezone offset. Relative video offsets
 * are derived only inside the player and the VideoRunner.
 */

import { asFiniteNumber, asRecord, asString, type JsonRecord } from './common.ts';
import { diagnostic, diagnosticMessage, type ContractDiagnostic } from './diagnostic.ts';

export const VIDEO_SCENE_SCHEMA_VERSION = 1;
export const VIDEO_RESOURCE_MANIFEST_SCHEMA_VERSION = 1;
export const VIDEO_CATALOG_SCHEMA_VERSION = 1;

export type VideoKind = 'source' | 'derived';

export type VideoSceneItemV1 = {
  id: string;
  videoId: string;
  resourceId: string;
  title: string;
  cameraId?: string;
  recordingStartTime: string;
  recordingEndTime: string;
  durationSeconds: number;
  initialSeekSeconds?: number;
  kind: VideoKind;
};

export type VideoSceneSnapshotV1 = {
  schemaVersion: 1;
  revision: number;
  videos: VideoSceneItemV1[];
  activeVideoId?: string;
  /** Optional comparison pane item (side-by-side with the active item). */
  compareVideoId?: string;
};

/** Tool-result envelope persisted in Pi JSONL as details.video. */
export type VideoEnvelopeV1 = {
  schemaVersion: 1;
  revision: number;
  scene: VideoSceneSnapshotV1;
};

export type VideoResourceManifestV1 = {
  schemaVersion: 1;
  resourceId: string;
  videoId: string;
  kind: VideoKind;
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

export type VideoCatalogEntryV1 = {
  videoId: string;
  cameraId?: string;
  title: string;
  locationName?: string;
  startTime: string;
  endTime: string;
  file: string;
  mimeType: 'video/mp4';
  longitude?: number;
  latitude?: number;
  /** Optional time-aligned numeric signals stored in the same Data Asset. */
  metrics?: VideoMetricDefinitionV1[];
};

export type VideoMetricDefinitionV1 = {
  id: string;
  label: string;
  unit: string;
  file: string;
  sampleIntervalSeconds: number;
};

export type VideoCatalogV1 = {
  schemaVersion: 1;
  videos: VideoCatalogEntryV1[];
};

/**
 * Strict Recording Absolute Time: ISO 8601 date-time with seconds and an
 * explicit numeric timezone offset (no 'Z', no missing offset, no dates).
 */
export const VIDEO_TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?([+-])(\d{2}):(\d{2})$/;

export type ParsedVideoTimestamp = { iso: string; epochMs: number; offsetMinutes: number };

export function parseVideoTimestamp(value: unknown): ParsedVideoTimestamp | null {
  const text = asString(value, 64);
  if (!text) return null;
  const match = text.match(VIDEO_TIMESTAMP_RE);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, sign, offsetHour, offsetMinute] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  const oh = Number(offsetHour);
  const om = Number(offsetMinute);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60 || oh > 23 || om > 59) return null;
  const offsetMinutes = (sign === '-' ? -1 : 1) * (oh * 60 + om);
  const ms = fraction ? Number(`0${fraction}`) * 1000 : 0;
  const epochMs = Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMinutes * 60_000;
  const date = new Date(epochMs);
  // Reject impossible calendar dates (e.g. 2026-02-31) that Date.UTC rolls over.
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  if (shifted.getUTCFullYear() !== y || shifted.getUTCMonth() !== mo - 1 || shifted.getUTCDate() !== d) return null;
  if (!Number.isFinite(date.getTime())) return null;
  return { iso: text, epochMs, offsetMinutes };
}

export function formatVideoTimestamp(epochMs: number, offsetMinutes: number): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Seconds from the recording start to an absolute timestamp. */
export function videoOffsetSeconds(recordingStartIso: string, timestampIso: string): number | null {
  const start = parseVideoTimestamp(recordingStartIso);
  const target = parseVideoTimestamp(timestampIso);
  if (!start || !target) return null;
  return (target.epochMs - start.epochMs) / 1000;
}

export function recordingIntervalOverlaps(requestedStartMs: number, requestedEndMs: number, recordingStartIso: string, recordingEndIso: string): boolean {
  const start = parseVideoTimestamp(recordingStartIso);
  const end = parseVideoTimestamp(recordingEndIso);
  if (!start || !end) return false;
  return requestedStartMs < end.epochMs && requestedEndMs > start.epochMs;
}

export type VideoParseResult<T> = { ok: true; value: T; diagnostics: ContractDiagnostic[] } | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

function finish<T>(value: T | null, diagnostics: ContractDiagnostic[]): VideoParseResult<T> {
  return value !== null && !diagnostics.some((item) => item.severity === 'error')
    ? { ok: true, value, diagnostics }
    : { ok: false, value: null, diagnostics };
}

function parseTimestampField(record: JsonRecord, key: string, path: string, diagnostics: ContractDiagnostic[]): ParsedVideoTimestamp | null {
  const parsed = parseVideoTimestamp(record[key]);
  if (!parsed) diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.${key}`, message: 'Expected ISO 8601 date-time with an explicit numeric timezone offset (e.g. 2026-08-16T08:00:00+08:00).', received: typeof record[key] === 'string' ? (record[key] as string) : typeof record[key] }));
  return parsed;
}

export function parseVideoSceneItemStructured(value: unknown, path: string, diagnostics: ContractDiagnostic[]): VideoSceneItemV1 | null {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Video scene item must be an object.' }));
    return null;
  }
  const id = asString(record.id, 120);
  const videoId = asString(record.videoId, 120);
  const resourceId = asString(record.resourceId, 120);
  const title = asString(record.title, 300);
  const cameraId = record.cameraId === undefined ? undefined : asString(record.cameraId, 120) ?? undefined;
  const kind = record.kind === 'source' || record.kind === 'derived' ? record.kind : null;
  const durationSeconds = asFiniteNumber(record.durationSeconds);
  const initialSeekSeconds = record.initialSeekSeconds === undefined ? undefined : asFiniteNumber(record.initialSeekSeconds) ?? undefined;
  if (!id) diagnostics.push(diagnostic({ code: 'missing_required_field', path: `${path}.id`, message: 'Video scene item id is required.' }));
  if (!videoId) diagnostics.push(diagnostic({ code: 'missing_required_field', path: `${path}.videoId`, message: 'videoId is required.' }));
  if (!resourceId) diagnostics.push(diagnostic({ code: 'missing_required_field', path: `${path}.resourceId`, message: 'resourceId is required.' }));
  if (!title) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `${path}.title`, message: 'title is required.' }));
  if (!kind) diagnostics.push(diagnostic({ code: 'unsupported_value', path: `${path}.kind`, message: "kind must be 'source' or 'derived'.", received: typeof record.kind === 'string' ? record.kind : typeof record.kind }));
  if (durationSeconds === null || durationSeconds <= 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.durationSeconds`, message: 'durationSeconds must be positive.' }));
  if (initialSeekSeconds !== undefined && initialSeekSeconds < 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.initialSeekSeconds`, message: 'initialSeekSeconds cannot be negative.' }));
  const start = parseTimestampField(record, 'recordingStartTime', path, diagnostics);
  const end = parseTimestampField(record, 'recordingEndTime', path, diagnostics);
  if (start && end && start.epochMs >= end.epochMs) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.recordingEndTime`, message: 'recordingEndTime must be after recordingStartTime.' }));
  if (!id || !videoId || !resourceId || !title || !kind || durationSeconds === null || durationSeconds <= 0 || !start || !end) return null;
  return {
    id,
    videoId,
    resourceId,
    title,
    ...(cameraId ? { cameraId } : {}),
    recordingStartTime: start.iso,
    recordingEndTime: end.iso,
    durationSeconds,
    ...(initialSeekSeconds !== undefined ? { initialSeekSeconds } : {}),
    kind,
  };
}

export function parseVideoSceneStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): VideoParseResult<VideoSceneSnapshotV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'videoScene', message: 'Video scene must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  if (record.schemaVersion !== VIDEO_SCENE_SCHEMA_VERSION) diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'videoScene.schemaVersion', message: 'Unsupported video scene schemaVersion.', expected: VIDEO_SCENE_SCHEMA_VERSION, received: typeof record.schemaVersion === 'number' ? record.schemaVersion : typeof record.schemaVersion }));
  const revision = asFiniteNumber(record.revision);
  if (revision === null || revision < 0) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'videoScene.revision', message: 'revision must be a non-negative number.' }));
  const rawVideos = Array.isArray(record.videos) ? record.videos : null;
  if (!rawVideos) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'videoScene.videos', message: 'videos must be an array.' }));
  const videos: VideoSceneItemV1[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of (rawVideos ?? []).entries()) {
    const item = parseVideoSceneItemStructured(candidate, `videoScene.videos[${index}]`, diagnostics);
    if (!item) continue;
    if (ids.has(item.id)) {
      diagnostics.push(diagnostic({ code: 'duplicate_id', path: `videoScene.videos[${index}].id`, message: `Duplicate video scene item id: ${item.id}` }));
      continue;
    }
    ids.add(item.id);
    videos.push(item);
  }
  const activeVideoId = record.activeVideoId === undefined ? undefined : asString(record.activeVideoId, 120) ?? undefined;
  if (activeVideoId && !videos.some((item) => item.id === activeVideoId)) diagnostics.push(diagnostic({ code: 'unknown_reference', path: 'videoScene.activeVideoId', message: 'activeVideoId does not reference a scene item.' }));
  const compareVideoId = record.compareVideoId === undefined ? undefined : asString(record.compareVideoId, 120) ?? undefined;
  if (compareVideoId && !videos.some((item) => item.id === compareVideoId)) diagnostics.push(diagnostic({ code: 'unknown_reference', path: 'videoScene.compareVideoId', message: 'compareVideoId does not reference a scene item.' }));
  if (compareVideoId && compareVideoId === activeVideoId) diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'videoScene.compareVideoId', message: 'compareVideoId must differ from activeVideoId.' }));
  if (!rawVideos || revision === null || revision < 0) return { ok: false, value: null, diagnostics };
  return finish({ schemaVersion: 1, revision, videos, ...(activeVideoId ? { activeVideoId } : {}), ...(compareVideoId ? { compareVideoId } : {}) }, diagnostics);
}

export function parseVideoScene(value: unknown): { ok: true; value: VideoSceneSnapshotV1 } | { ok: false; diagnostics: ContractDiagnostic[] } {
  const result = parseVideoSceneStructured(value);
  return result.ok ? { ok: true, value: result.value } : { ok: false, diagnostics: result.diagnostics };
}

export function parseVideoEnvelopeStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): VideoParseResult<VideoEnvelopeV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'video', message: 'Video envelope must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  if (record.schemaVersion !== VIDEO_SCENE_SCHEMA_VERSION) diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'video.schemaVersion', message: 'Unsupported video envelope schemaVersion.', expected: VIDEO_SCENE_SCHEMA_VERSION, received: typeof record.schemaVersion === 'number' ? record.schemaVersion : typeof record.schemaVersion }));
  const revision = asFiniteNumber(record.revision);
  if (revision === null || revision < 0) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'video.revision', message: 'revision must be a non-negative number.' }));
  const scene = parseVideoSceneStructured(record.scene, diagnostics);
  if (!scene.ok || revision === null || revision < 0) return { ok: false, value: null, diagnostics };
  return finish({ schemaVersion: 1, revision, scene: scene.value }, diagnostics);
}

/** Extract the newest valid video envelope from a Pi tool-result message. */
export function getVideoSceneFromToolResult(message: unknown): VideoEnvelopeV1 | null {
  const record = asRecord(message);
  const details = asRecord(record?.details);
  if (!details || details.video === undefined) return null;
  const parsed = parseVideoEnvelopeStructured(details.video);
  return parsed.ok ? parsed.value : null;
}

export function parseVideoResourceManifestStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): VideoParseResult<VideoResourceManifestV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'videoManifest', message: 'Video resource manifest must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  if (record.schemaVersion !== VIDEO_RESOURCE_MANIFEST_SCHEMA_VERSION) diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'videoManifest.schemaVersion', message: 'Unsupported video manifest schemaVersion.', expected: VIDEO_RESOURCE_MANIFEST_SCHEMA_VERSION, received: typeof record.schemaVersion === 'number' ? record.schemaVersion : typeof record.schemaVersion }));
  const resourceId = asString(record.resourceId, 120);
  const videoId = asString(record.videoId, 120);
  const kind = record.kind === 'source' || record.kind === 'derived' ? record.kind : null;
  const bytes = asFiniteNumber(record.bytes);
  const sha256 = asString(record.sha256, 64);
  const durationSeconds = asFiniteNumber(record.durationSeconds);
  if (!resourceId) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'videoManifest.resourceId', message: 'resourceId is required.' }));
  if (!videoId) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'videoManifest.videoId', message: 'videoId is required.' }));
  if (!kind) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'videoManifest.kind', message: "kind must be 'source' or 'derived'." }));
  if (record.relativePath !== 'video.mp4') diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'videoManifest.relativePath', message: "relativePath must be 'video.mp4'." }));
  if (record.mimeType !== 'video/mp4') diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'videoManifest.mimeType', message: "mimeType must be 'video/mp4'." }));
  if (bytes === null || bytes <= 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: 'videoManifest.bytes', message: 'bytes must be positive.' }));
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'videoManifest.sha256', message: 'sha256 must be a lowercase hex digest.' }));
  if (durationSeconds === null || durationSeconds <= 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: 'videoManifest.durationSeconds', message: 'durationSeconds must be positive.' }));
  const start = parseTimestampField(record, 'recordingStartTime', 'videoManifest', diagnostics);
  const end = parseTimestampField(record, 'recordingEndTime', 'videoManifest', diagnostics);
  if (start && end && start.epochMs >= end.epochMs) diagnostics.push(diagnostic({ code: 'out_of_range', path: 'videoManifest.recordingEndTime', message: 'recordingEndTime must be after recordingStartTime.' }));
  const sourceAssetId = record.sourceAssetId === undefined ? undefined : asString(record.sourceAssetId, 200) ?? undefined;
  const sourceRelativePath = record.sourceRelativePath === undefined ? undefined : asString(record.sourceRelativePath, 1000) ?? undefined;
  const parentResourceId = record.parentResourceId === undefined ? undefined : asString(record.parentResourceId, 120) ?? undefined;
  const clipStart = record.clipStartTime === undefined ? undefined : parseTimestampField(record, 'clipStartTime', 'videoManifest', diagnostics);
  const clipEnd = record.clipEndTime === undefined ? undefined : parseTimestampField(record, 'clipEndTime', 'videoManifest', diagnostics);
  if (kind === 'source' && !sourceAssetId) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'videoManifest.sourceAssetId', message: 'Source videos must record their Data Asset origin.' }));
  if (kind === 'derived' && (!parentResourceId || !clipStart || !clipEnd)) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'videoManifest.parentResourceId', message: 'Derived videos must record parentResourceId, clipStartTime and clipEndTime.' }));
  if (clipStart && clipEnd && clipStart.epochMs >= clipEnd.epochMs) diagnostics.push(diagnostic({ code: 'out_of_range', path: 'videoManifest.clipEndTime', message: 'clipEndTime must be after clipStartTime.' }));
  if (!resourceId || !videoId || !kind || bytes === null || bytes <= 0 || !sha256 || durationSeconds === null || durationSeconds <= 0 || !start || !end) return { ok: false, value: null, diagnostics };
  return finish({
    schemaVersion: 1,
    resourceId,
    videoId,
    kind,
    relativePath: 'video.mp4',
    mimeType: 'video/mp4',
    bytes,
    sha256,
    recordingStartTime: start.iso,
    recordingEndTime: end.iso,
    durationSeconds,
    ...(sourceAssetId ? { sourceAssetId } : {}),
    ...(sourceRelativePath ? { sourceRelativePath } : {}),
    ...(parentResourceId ? { parentResourceId } : {}),
    ...(clipStart ? { clipStartTime: clipStart.iso } : {}),
    ...(clipEnd ? { clipEndTime: clipEnd.iso } : {}),
  }, diagnostics);
}

export function parseVideoCatalogStructured(value: unknown, diagnostics: ContractDiagnostic[] = []): VideoParseResult<VideoCatalogV1> {
  const record = asRecord(value);
  if (!record) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'videoCatalog', message: 'Video catalog must be an object.' }));
    return { ok: false, value: null, diagnostics };
  }
  if (record.schemaVersion !== VIDEO_CATALOG_SCHEMA_VERSION) diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'videoCatalog.schemaVersion', message: 'Unsupported video catalog schemaVersion.', expected: VIDEO_CATALOG_SCHEMA_VERSION, received: typeof record.schemaVersion === 'number' ? record.schemaVersion : typeof record.schemaVersion }));
  const rawVideos = Array.isArray(record.videos) ? record.videos : null;
  if (!rawVideos) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'videoCatalog.videos', message: 'videos must be an array.' }));
  const videos: VideoCatalogEntryV1[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of (rawVideos ?? []).entries()) {
    const path = `videoCatalog.videos[${index}]`;
    const item = asRecord(candidate);
    if (!item) {
      diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Catalog entry must be an object.' }));
      continue;
    }
    const videoId = asString(item.videoId, 120);
    const title = asString(item.title, 300);
    const file = asString(item.file, 1000);
    const cameraId = item.cameraId === undefined ? undefined : asString(item.cameraId, 120) ?? undefined;
    const locationName = item.locationName === undefined ? undefined : asString(item.locationName, 300) ?? undefined;
    const longitude = item.longitude === undefined ? undefined : asFiniteNumber(item.longitude) ?? undefined;
    const latitude = item.latitude === undefined ? undefined : asFiniteNumber(item.latitude) ?? undefined;
    const rawMetrics = item.metrics;
    const metrics: VideoMetricDefinitionV1[] = [];
    if (rawMetrics !== undefined && !Array.isArray(rawMetrics)) diagnostics.push(diagnostic({ code: 'invalid_type', path: `${path}.metrics`, message: 'metrics must be an array.' }));
    const metricIds = new Set<string>();
    for (const [metricIndex, candidate] of (Array.isArray(rawMetrics) ? rawMetrics : []).entries()) {
      const metricPath = `${path}.metrics[${metricIndex}]`;
      const metric = asRecord(candidate);
      if (!metric) {
        diagnostics.push(diagnostic({ code: 'invalid_type', path: metricPath, message: 'Video metric must be an object.' }));
        continue;
      }
      const id = asString(metric.id, 120);
      const label = asString(metric.label, 120);
      const unit = asString(metric.unit, 40);
      const metricFile = asString(metric.file, 1000);
      const sampleIntervalSeconds = asFiniteNumber(metric.sampleIntervalSeconds);
      if (!id) diagnostics.push(diagnostic({ code: 'missing_required_field', path: `${metricPath}.id`, message: 'Video metric id is required.' }));
      if (id && metricIds.has(id)) diagnostics.push(diagnostic({ code: 'duplicate_id', path: `${metricPath}.id`, message: `Duplicate video metric id: ${id}` }));
      if (!label) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `${metricPath}.label`, message: 'Video metric label is required.' }));
      if (!unit) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `${metricPath}.unit`, message: 'Video metric unit is required.' }));
      if (!metricFile || metricFile.startsWith('/') || /^[A-Za-z]:[\\/]/.test(metricFile) || metricFile.split(/[\\/]+/).some((part) => !part || part === '.' || part === '..')) diagnostics.push(diagnostic({ code: 'unsafe_value', path: `${metricPath}.file`, message: 'Video metric file must be a safe relative path inside the Data Root.' }));
      if (sampleIntervalSeconds === null || !Number.isInteger(sampleIntervalSeconds) || sampleIntervalSeconds <= 0 || sampleIntervalSeconds > 86_400) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${metricPath}.sampleIntervalSeconds`, message: 'sampleIntervalSeconds must be a positive integer no greater than one day.' }));
      if (!id || metricIds.has(id) || !label || !unit || !metricFile || sampleIntervalSeconds === null || !Number.isInteger(sampleIntervalSeconds) || sampleIntervalSeconds <= 0 || sampleIntervalSeconds > 86_400) continue;
      metricIds.add(id);
      metrics.push({ id, label, unit, file: metricFile, sampleIntervalSeconds });
    }
    if (!videoId) diagnostics.push(diagnostic({ code: 'missing_required_field', path: `${path}.videoId`, message: 'videoId is required.' }));
    if (videoId && ids.has(videoId)) diagnostics.push(diagnostic({ code: 'duplicate_id', path: `${path}.videoId`, message: `Duplicate videoId: ${videoId}` }));
    if (!title) diagnostics.push(diagnostic({ code: 'missing_text_field', path: `${path}.title`, message: 'title is required.' }));
    if (!file) diagnostics.push(diagnostic({ code: 'missing_required_field', path: `${path}.file`, message: 'file is required.' }));
    if (file && (file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) || file.split(/[\\/]+/).some((part) => !part || part === '.' || part === '..'))) diagnostics.push(diagnostic({ code: 'unsafe_value', path: `${path}.file`, message: 'file must be a safe relative path inside the Data Root.' }));
    if (item.mimeType !== 'video/mp4') diagnostics.push(diagnostic({ code: 'unsupported_value', path: `${path}.mimeType`, message: "Only 'video/mp4' sources are accepted in V1." }));
    const start = parseTimestampField(item, 'startTime', path, diagnostics);
    const end = parseTimestampField(item, 'endTime', path, diagnostics);
    if (start && end && start.epochMs >= end.epochMs) diagnostics.push(diagnostic({ code: 'out_of_range', path: `${path}.endTime`, message: 'endTime must be after startTime.' }));
    if (!videoId || ids.has(videoId) || !title || !file || !start || !end) continue;
    ids.add(videoId);
    videos.push({
      videoId,
      ...(cameraId ? { cameraId } : {}),
      title,
      ...(locationName ? { locationName } : {}),
      startTime: start.iso,
      endTime: end.iso,
      file,
      mimeType: 'video/mp4',
      ...(longitude !== undefined ? { longitude } : {}),
      ...(latitude !== undefined ? { latitude } : {}),
      ...(rawMetrics !== undefined ? { metrics } : {}),
    });
  }
  if (!rawVideos) return { ok: false, value: null, diagnostics };
  return finish({ schemaVersion: 1, videos }, diagnostics);
}

export function videoDiagnosticsMessage(diagnostics: ContractDiagnostic[]): string {
  return diagnostics.map(diagnosticMessage).join('; ');
}

/** Maximum items retained in a video scene; oldest non-visible items are evicted. */
export const VIDEO_SCENE_MAX_ITEMS = 6;

/**
 * Scene identity of a presented item. Presenting the same resource at a
 * specific timestamp creates a distinct item so two absolute times of one
 * recording can be compared side by side.
 */
export function videoSceneItemId(resourceId: string, initialSeekSeconds?: number): string {
  return initialSeekSeconds !== undefined && initialSeekSeconds > 0 ? `${resourceId}@${Math.round(initialSeekSeconds)}` : resourceId;
}

/**
 * Pure scene reducer for video_present. Upserts the item, then:
 * - compare: the item takes the comparison pane, the current active item stays;
 * - otherwise: the item becomes active; an existing comparison pane is kept.
 */
export function reduceVideoScenePresent(scene: VideoSceneSnapshotV1, presented: VideoSceneItemV1, opts: { compare?: boolean } = {}): VideoSceneSnapshotV1 {
  const revision = scene.revision + 1;
  let videos = scene.videos.filter((item) => item.id !== presented.id);
  videos.push(presented);

  let activeVideoId: string | undefined;
  let compareVideoId: string | undefined;
  if (opts.compare && scene.activeVideoId && scene.activeVideoId !== presented.id) {
    activeVideoId = scene.activeVideoId;
    compareVideoId = presented.id;
  } else {
    activeVideoId = presented.id;
    compareVideoId = scene.compareVideoId && scene.compareVideoId !== presented.id ? scene.compareVideoId : undefined;
  }

  if (videos.length > VIDEO_SCENE_MAX_ITEMS) {
    const keep = new Set([activeVideoId, compareVideoId].filter((id): id is string => !!id));
    const evictable = videos.filter((item) => !keep.has(item.id));
    const evictCount = videos.length - VIDEO_SCENE_MAX_ITEMS;
    const evicted = new Set(evictable.slice(0, evictCount).map((item) => item.id));
    videos = videos.filter((item) => !evicted.has(item.id));
  }
  if (compareVideoId && !videos.some((item) => item.id === compareVideoId)) compareVideoId = undefined;

  return { schemaVersion: 1, revision, videos, ...(activeVideoId ? { activeVideoId } : {}), ...(compareVideoId ? { compareVideoId } : {}) };
}
