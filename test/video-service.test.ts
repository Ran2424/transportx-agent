const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { VideoService } = require('../bin/video-service.js');

const FFMPEG = process.env.TAU_TEST_FFMPEG || 'ffmpeg';
const FFPROBE = process.env.TAU_TEST_FFPROBE || 'ffprobe';
const ffmpegAvailable = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' }).status === 0
  && spawnSync(FFPROBE, ['-version'], { encoding: 'utf8' }).status === 0;

function makeDataRoot(t: any) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-data-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataRoot, 'videos'), { recursive: true });
  const make = (file: string, extra: string[] = []) => {
    const result = spawnSync(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=30',
      ...extra,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', '-y', path.join(dataRoot, 'videos', file),
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  make('camera_001.mp4');
  make('camera_002.mp4', ['-vf', 'hue=h=120']);
  fs.writeFileSync(path.join(dataRoot, 'videos.json'), `${JSON.stringify({
    schemaVersion: 1,
    videos: [
      { videoId: 'video_001', cameraId: 'camera_001', title: '人民路—中山路口', locationName: '人民路—中山路口', startTime: '2026-08-16T08:00:00+08:00', endTime: '2026-08-16T08:00:30+08:00', file: 'videos/camera_001.mp4', mimeType: 'video/mp4' },
      { videoId: 'video_002', cameraId: 'camera_002', title: '世纪大道—张杨路口', locationName: '世纪大道—张杨路口', startTime: '2026-08-16T08:30:00+08:00', endTime: '2026-08-16T08:30:30+08:00', file: 'videos/camera_002.mp4', mimeType: 'video/mp4' },
    ],
  }, null, 2)}\n`);
  return dataRoot;
}

function makeSession(t: any, dataRoot: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-session-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return {
    cwd,
    resolvedSessionPlan: { assets: [{ id: 'data:demo-videos', kind: 'data', path: dataRoot }] },
  } as any;
}

function service() {
  return new VideoService({ ffmpeg: { command: FFMPEG, args: [] }, ffprobe: { command: FFPROBE, args: [] } });
}

test('video search filters by location, camera and time overlap', { skip: !ffmpegAvailable }, async (t: any) => {
  const session = makeSession(t, makeDataRoot(t));
  const video = service();

  const all = video.search(session, {});
  assert.equal(all.candidates.length, 2);
  assert.ok(!('file' in all.candidates[0]) && !('path' in all.candidates[0]), 'candidates never expose paths');

  assert.equal(video.search(session, { location: '人民路' }).candidates[0].videoId, 'video_001');
  assert.equal(video.search(session, { location: '人民路 中山' }).candidates[0].videoId, 'video_001', 'multi-keyword location uses AND matching');
  assert.equal(video.search(session, { location: 'camera_001' }).candidates[0].videoId, 'video_001', 'location keywords also match the camera id');
  assert.equal(video.search(session, { location: '人民路 张杨' }).candidates.length, 0, 'all keywords must match');
  assert.equal(video.search(session, { cameraId: 'camera_002' }).candidates[0].videoId, 'video_002');
  assert.equal(video.search(session, { location: '不存在的地方' }).candidates.length, 0);

  const overlap = video.search(session, { startTime: '2026-08-16T08:00:20+08:00', endTime: '2026-08-16T08:10:00+08:00' });
  assert.deepEqual(overlap.candidates.map((item: any) => item.videoId), ['video_001']);
  const none = video.search(session, { startTime: '2026-08-16T09:00:00+08:00', endTime: '2026-08-16T09:10:00+08:00' });
  assert.equal(none.candidates.length, 0);

  assert.throws(() => video.search(session, { startTime: '2026-08-16T08:00:00+08:00' }), /together/);
  assert.throws(() => video.search(session, { startTime: '2026-08-16 08:00:00', endTime: '2026-08-16 09:00:00' }), /timezone offset/);
  assert.throws(() => video.search(session, { startTime: '2026-08-16T09:00:00+08:00', endTime: '2026-08-16T08:00:00+08:00' }), /before/);
});

test('video search reports no data when the session has no video assets', { skip: !ffmpegAvailable }, async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-empty-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = service().search({ cwd, resolvedSessionPlan: { assets: [] } } as any, {});
  assert.equal(result.candidates.length, 0);
});

test('present materializes a source resource with a verified manifest and seek offset', { skip: !ffmpegAvailable }, async (t: any) => {
  const session = makeSession(t, makeDataRoot(t));
  const video = service();
  const first = await video.present(session, { videoId: 'video_001', timestamp: '2026-08-16T08:00:10+08:00' });
  assert.equal(first.item.kind, 'source');
  assert.equal(first.item.initialSeekSeconds, 10);
  assert.match(first.item.resourceId, /^video_[a-f0-9]{16}$/);

  const resourceDir = path.join(session.cwd, '.tau', 'video-resources', first.item.resourceId);
  const manifest = JSON.parse(fs.readFileSync(path.join(resourceDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'source');
  assert.equal(manifest.sourceAssetId, 'data:demo-videos');
  assert.equal(manifest.durationSeconds > 29 && manifest.durationSeconds < 31, true);
  assert.equal(manifest.bytes, fs.statSync(path.join(resourceDir, 'video.mp4')).size);
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/);

  const again = await video.present(session, { videoId: 'video_001' });
  assert.equal(again.item.resourceId, first.item.resourceId, 'materialize is idempotent');
  assert.equal(again.item.initialSeekSeconds, undefined);

  await assert.rejects(() => video.present(session, { videoId: 'video_001', timestamp: '2026-08-16T08:01:00+08:00' }), /outside the recording range/);
  await assert.rejects(() => video.present(session, { videoId: 'video_404' }), /not found/i);
});

test('snapshot extracts a frame inside the recording range only', { skip: !ffmpegAvailable }, async (t: any) => {
  const session = makeSession(t, makeDataRoot(t));
  const video = service();
  const result = await video.snapshot(session, { videoId: 'video_002', timestamp: '2026-08-16T08:30:05+08:00' });
  assert.equal(result.mimeType, 'image/jpeg');
  assert.ok(result.bytes > 0 && result.bytes <= 5 * 1024 * 1024);
  assert.ok(Buffer.from(result.dataBase64, 'base64').length === result.bytes);
  await assert.rejects(() => video.snapshot(session, { videoId: 'video_002', timestamp: '2026-08-16T08:31:00+08:00' }), /outside the recording range/);
  await assert.rejects(() => video.snapshot(session, { videoId: 'video_002', timestamp: '2026-08-16T08:30:05' }), /timezone offset/);
});

test('clip re-encodes a derived resource with absolute clip times', { skip: !ffmpegAvailable }, async (t: any) => {
  const session = makeSession(t, makeDataRoot(t));
  const video = service();
  const clip = await video.clip(session, { videoId: 'video_001', startTime: '2026-08-16T08:00:05+08:00', endTime: '2026-08-16T08:00:15+08:00' });
  assert.match(clip.resourceId, /^video_[a-f0-9]{16}$/);
  assert.equal(clip.durationSeconds > 9 && clip.durationSeconds < 11, true, `clip duration ${clip.durationSeconds}`);

  const presented = await video.present(session, { resourceId: clip.resourceId, timestamp: '2026-08-16T08:00:08+08:00' });
  assert.equal(presented.item.kind, 'derived');
  assert.equal(presented.item.recordingStartTime, '2026-08-16T08:00:05+08:00', 'derived clips keep absolute recording time');
  assert.equal(presented.item.initialSeekSeconds, 3);

  const manifest = JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau', 'video-resources', clip.resourceId, 'manifest.json'), 'utf8'));
  assert.equal(manifest.kind, 'derived');
  assert.ok(manifest.parentResourceId);
  assert.equal(manifest.clipStartTime, '2026-08-16T08:00:05+08:00');

  // The derived clip is decodable and seekable like any source resource.
  const snap = await video.snapshot(session, { resourceId: clip.resourceId, timestamp: '2026-08-16T08:00:06+08:00' });
  assert.ok(snap.bytes > 0);

  await assert.rejects(() => video.clip(session, { videoId: 'video_001', startTime: '2026-08-16T08:00:20+08:00', endTime: '2026-08-16T08:00:10+08:00' }), /before/);
  await assert.rejects(() => video.clip(session, { videoId: 'video_001', startTime: '2026-08-16T07:00:00+08:00', endTime: '2026-08-16T08:00:10+08:00' }), /outside the recording range/);
});

test('sample frames are uniform, timestamped and byte-limited', { skip: !ffmpegAvailable }, async (t: any) => {
  const session = makeSession(t, makeDataRoot(t));
  const video = service();
  const result = await video.sampleFrames(session, { videoId: 'video_001', startTime: '2026-08-16T08:00:00+08:00', endTime: '2026-08-16T08:00:30+08:00' });
  assert.equal(result.frames.length, 6, 'default frame count');
  assert.ok(result.totalBytes <= 6 * 1024 * 1024);
  assert.equal(result.frames[0].timestamp, '2026-08-16T08:00:02+08:00');
  assert.equal(result.frames[5].timestamp, '2026-08-16T08:00:27+08:00');
  for (const frame of result.frames) assert.ok(frame.bytes > 0);

  const three = await video.sampleFrames(session, { videoId: 'video_001', startTime: '2026-08-16T08:00:00+08:00', endTime: '2026-08-16T08:00:30+08:00', frameCount: 3 });
  assert.equal(three.frames.length, 3);

  await assert.rejects(() => video.sampleFrames(session, { videoId: 'video_001', startTime: '2026-08-16T08:00:00+08:00', endTime: '2026-08-16T08:00:30+08:00', frameCount: 13 }), /frameCount/);
  await assert.rejects(() => video.sampleFrames(session, { videoId: 'video_001', startTime: '2026-08-16T08:00:00+08:00', endTime: '2026-08-16T08:01:00+08:00' }), /outside the recording range/);
});

test('catalog rejects metadata whose time range mismatches the probed duration', { skip: !ffmpegAvailable }, async (t: any) => {
  const dataRoot = makeDataRoot(t);
  const catalog = JSON.parse(fs.readFileSync(path.join(dataRoot, 'videos.json'), 'utf8'));
  catalog.videos[0].endTime = '2026-08-16T08:05:00+08:00'; // 5 minutes vs 30s file
  fs.writeFileSync(path.join(dataRoot, 'videos.json'), JSON.stringify(catalog));
  const session = makeSession(t, dataRoot);
  await assert.rejects(() => service().present(session, { videoId: 'video_001' }), /does not match the probed duration/);
});
