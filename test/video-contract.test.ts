const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseVideoTimestamp,
  formatVideoTimestamp,
  videoOffsetSeconds,
  recordingIntervalOverlaps,
  parseVideoSceneStructured,
  parseVideoEnvelopeStructured,
  getVideoSceneFromToolResult,
  parseVideoResourceManifestStructured,
  parseVideoCatalogStructured,
} = require('../bin/contracts/video.js');

test('video timestamps require ISO 8601 with an explicit numeric offset', () => {
  assert.ok(parseVideoTimestamp('2026-08-16T08:32:10+08:00'));
  assert.ok(parseVideoTimestamp('2026-08-16T00:32:10.500-05:30'));
  assert.equal(parseVideoTimestamp('2026-08-16T08:32:10'), null, 'missing offset');
  assert.equal(parseVideoTimestamp('2026-08-16T08:32:10Z'), null, 'Z suffix is not a numeric offset');
  assert.equal(parseVideoTimestamp('2026-08-16 08:32:10+08:00'), null, 'space separator');
  assert.equal(parseVideoTimestamp('2026-08-16'), null, 'date only');
  assert.equal(parseVideoTimestamp('2026-13-16T08:32:10+08:00'), null, 'month 13');
  assert.equal(parseVideoTimestamp('2026-02-31T08:32:10+08:00'), null, 'impossible date rolls over');
  assert.equal(parseVideoTimestamp('2026-08-16T24:00:00+08:00'), null, 'hour 24');
  assert.equal(parseVideoTimestamp(1735900330), null, 'non-string');
});

test('timestamp epoch math respects the numeric offset', () => {
  const a = parseVideoTimestamp('2026-08-16T08:00:00+08:00');
  const b = parseVideoTimestamp('2026-08-16T00:00:00+00:00');
  assert.equal(a.epochMs, b.epochMs);
  assert.equal(formatVideoTimestamp(a.epochMs + 90_000, a.offsetMinutes), '2026-08-16T08:01:30+08:00');
  assert.equal(videoOffsetSeconds('2026-08-16T08:00:00+08:00', '2026-08-16T08:01:30+08:00'), 90);
  assert.equal(videoOffsetSeconds('2026-08-16T08:00:00+08:00', '2026-08-16T07:59:00+08:00'), -60);
});

test('recording overlap uses strict interval intersection', () => {
  const start = '2026-08-16T08:00:00+08:00';
  const end = '2026-08-16T09:00:00+08:00';
  const ms = (iso: string) => parseVideoTimestamp(iso).epochMs;
  assert.equal(recordingIntervalOverlaps(ms('2026-08-16T08:30:00+08:00'), ms('2026-08-16T08:31:00+08:00'), start, end), true);
  assert.equal(recordingIntervalOverlaps(ms('2026-08-16T07:00:00+08:00'), ms('2026-08-16T08:00:01+08:00'), start, end), true, 'partial overlap at the start');
  assert.equal(recordingIntervalOverlaps(ms('2026-08-16T09:00:00+08:00'), ms('2026-08-16T10:00:00+08:00'), start, end), false, 'touching end does not overlap');
  assert.equal(recordingIntervalOverlaps(ms('2026-08-16T06:00:00+08:00'), ms('2026-08-16T07:00:00+08:00'), start, end), false);
});

const sceneItem = {
  id: 'video_abc',
  videoId: 'video_001',
  resourceId: 'video_abc',
  title: '人民路—中山路口',
  cameraId: 'camera_001',
  recordingStartTime: '2026-08-16T08:00:00+08:00',
  recordingEndTime: '2026-08-16T08:01:00+08:00',
  durationSeconds: 60,
  initialSeekSeconds: 32,
  kind: 'source',
};

test('video scene parser accepts a valid scene and rejects malformed ones', () => {
  const ok = parseVideoSceneStructured({ schemaVersion: 1, revision: 3, videos: [sceneItem], activeVideoId: 'video_abc' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.videos[0].initialSeekSeconds, 32);

  for (const [name, candidate] of Object.entries({
    wrongSchema: { schemaVersion: 2, revision: 1, videos: [] },
    badActive: { schemaVersion: 1, revision: 1, videos: [sceneItem], activeVideoId: 'missing' },
    duplicated: { schemaVersion: 1, revision: 1, videos: [sceneItem, sceneItem] },
    reversedRange: { schemaVersion: 1, revision: 1, videos: [{ ...sceneItem, recordingEndTime: '2026-08-16T07:00:00+08:00' }] },
    naiveTime: { schemaVersion: 1, revision: 1, videos: [{ ...sceneItem, recordingStartTime: '2026-08-16 08:00:00' }] },
    missingKind: { schemaVersion: 1, revision: 1, videos: [{ ...sceneItem, kind: undefined }] },
  })) {
    const result = parseVideoSceneStructured(candidate);
    assert.equal(result.ok, false, name);
  }
});

test('video envelope projects from tool results and ignores other messages', () => {
  const envelope = { schemaVersion: 1, revision: 5, scene: { schemaVersion: 1, revision: 5, videos: [sceneItem], activeVideoId: 'video_abc' } };
  const parsed = parseVideoEnvelopeStructured(envelope);
  assert.equal(parsed.ok, true);
  assert.equal(getVideoSceneFromToolResult({ role: 'toolResult', details: { video: envelope } }).revision, 5);
  assert.equal(getVideoSceneFromToolResult({ role: 'toolResult', details: { visualization: {} } }), null, 'geo envelopes are not video');
  assert.equal(getVideoSceneFromToolResult({ role: 'assistant' }), null);
  assert.equal(getVideoSceneFromToolResult({ role: 'toolResult', details: { video: { schemaVersion: 9 } } }), null, 'invalid video envelope is skipped');
});

const sourceManifest = {
  schemaVersion: 1,
  resourceId: 'video_0123456789abcdef',
  videoId: 'video_001',
  kind: 'source',
  relativePath: 'video.mp4',
  mimeType: 'video/mp4',
  bytes: 522309,
  sha256: 'a'.repeat(64),
  recordingStartTime: '2026-08-16T08:00:00+08:00',
  recordingEndTime: '2026-08-16T08:01:00+08:00',
  durationSeconds: 60,
  sourceAssetId: 'data:demo-videos',
  sourceRelativePath: 'videos/camera_001.mp4',
};

test('resource manifest requires provenance per kind', () => {
  assert.equal(parseVideoResourceManifestStructured(sourceManifest).ok, true);
  assert.equal(parseVideoResourceManifestStructured({ ...sourceManifest, sourceAssetId: undefined }).ok, false, 'source without asset origin');
  const derived = {
    ...sourceManifest,
    resourceId: 'video_fedcba9876543210',
    kind: 'derived',
    sourceAssetId: undefined,
    sourceRelativePath: undefined,
    parentResourceId: 'video_0123456789abcdef',
    clipStartTime: '2026-08-16T08:00:10+08:00',
    clipEndTime: '2026-08-16T08:00:40+08:00',
  };
  assert.equal(parseVideoResourceManifestStructured(derived).ok, true);
  assert.equal(parseVideoResourceManifestStructured({ ...derived, parentResourceId: undefined }).ok, false, 'derived without parent');
  assert.equal(parseVideoResourceManifestStructured({ ...derived, clipEndTime: '2026-08-16T08:00:05+08:00' }).ok, false, 'clip end before start');
  assert.equal(parseVideoResourceManifestStructured({ ...sourceManifest, sha256: 'xyz' }).ok, false, 'bad sha256');
});

test('catalog parser enforces unique ids, safe relative files and strict times', () => {
  const entry = {
    videoId: 'video_001',
    cameraId: 'camera_001',
    title: '人民路—中山路口',
    locationName: '人民路—中山路口',
    startTime: '2026-08-16T08:00:00+08:00',
    endTime: '2026-08-16T08:01:00+08:00',
    file: 'videos/camera_001.mp4',
    mimeType: 'video/mp4',
    longitude: 121.47,
    latitude: 31.23,
  };
  const ok = parseVideoCatalogStructured({ schemaVersion: 1, videos: [entry] });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.videos[0].videoId, 'video_001');

  assert.equal(parseVideoCatalogStructured({ schemaVersion: 1, videos: [entry, { ...entry, videoId: 'video_002' }] }).ok, true);
  assert.equal(parseVideoCatalogStructured({ schemaVersion: 1, videos: [entry, entry] }).ok, false, 'duplicate videoId');
  assert.equal(parseVideoCatalogStructured({ schemaVersion: 1, videos: [{ ...entry, file: '/etc/passwd' }] }).ok, false, 'absolute path');
  assert.equal(parseVideoCatalogStructured({ schemaVersion: 1, videos: [{ ...entry, file: '../escape.mp4' }] }).ok, false, 'dot-dot escape');
  assert.equal(parseVideoCatalogStructured({ schemaVersion: 1, videos: [{ ...entry, startTime: '2026-08-16T08:00:00' }] }).ok, false, 'naive startTime');
  assert.equal(parseVideoCatalogStructured({ schemaVersion: 1, videos: [{ ...entry, mimeType: 'video/webm' }] }).ok, false, 'non-mp4');
  assert.equal(parseVideoCatalogStructured({ schemaVersion: 2, videos: [entry] }).ok, false, 'unknown schemaVersion');
});
