const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
import type { TestContext } from 'node:test';

process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-http-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
const PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');
process.env.TAU_PROJECTS_DIR = PROJECTS_DIR;

const { server, computeUrls, handleRpcCommand, liveManager, SESSIONS_DIR, PiRpcSession, _setSpawnPiForTest } = require('../bin/tau.js');
let base = '';
const PROJ_DIR = path.join(SESSIONS_DIR, '--tmp--httpproj');

function writeSessionFileAt(projectDir: string, fileName: string, lines: Array<Record<string, unknown>>) {
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, fileName);
  fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return filePath;
}

function fakeSession(id: string) {
  return {
    id,
    cwd: '/tmp/proj',
    model: 'openai/gpt-5.5',
    modelSpec: '',
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    autoCompactionEnabled: true,
    sessionFile: `/tmp/${id}.jsonl`,
    sessionName: null,
    contextUsage: null,
    entries: [],
    pendingExtensionUiRequests: new Map(),
    serviceTokens: { citation: 'citation-token', spatial: 'spatial-token', video: 'video-token' },
    manager: liveManager,
    metadata: () => ({ id, cwd: '/tmp/proj', model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
    liveMetadata: () => ({ id, model: 'openai/gpt-5.5', isStreaming: false, isCompacting: false, autoCompactionEnabled: true }),
    snapshot: () => ({ schemaVersion: 1, session: { id }, entries: [], model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
    terminate: async () => {},
    send: async () => ({ data: { commands: [] } }),
  };
}

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.kill = () => {};
  return child;
}

async function jsonBody(res: Response) {
  return JSON.parse(await res.text());
}

before((_: TestContext, done: () => void) => {
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    computeUrls(port);
    base = `http://127.0.0.1:${port}`;
    done();
  });
});

after((_: TestContext, done: () => void) => server.close(done));
beforeEach(() => liveManager.sessions.clear());

test('serves only session-scoped GeoJSON and supports ETag revalidation', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-resource-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const sha256 = 'a'.repeat(64);
  const resourceId = `geo_${sha256.slice(0, 24)}`;
  const dir = path.join(cwd, '.tau', 'geo-resources', resourceId);
  const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.geojson'), geojson);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ resourceId, sha256, bytes: Buffer.byteLength(geojson), featureCount: 0 }));
  const session = fakeSession('tau_geo');
  session.cwd = cwd;
  liveManager.sessions.set(session.id, session);

  const url = `${base}/api/live-sessions/${session.id}/geo-resources/${resourceId}/data`;
  const resource = await fetch(url);
  assert.equal(resource.headers.get('etag'), `"${sha256}"`);
  assert.deepEqual(await jsonBody(resource), { type: 'FeatureCollection', features: [] });
  assert.equal((await fetch(url, { headers: { 'If-None-Match': `"${sha256}"` } })).status, 304);
  assert.equal((await fetch(`${base}/api/live-sessions/${session.id}/geo-resources/..%2Fsecret/data`)).status, 400);
});

function fakeVideoResource(cwd: string, resourceId: string, bytes: Buffer) {
  const dir = path.join(cwd, '.tau', 'video-resources', resourceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'video.mp4'), bytes);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    resourceId,
    videoId: 'video_001',
    kind: 'source',
    relativePath: 'video.mp4',
    mimeType: 'video/mp4',
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    recordingStartTime: '2026-08-16T08:00:00+08:00',
    recordingEndTime: '2026-08-16T08:01:00+08:00',
    durationSeconds: 60,
    sourceAssetId: 'data:demo-videos',
    sourceRelativePath: 'videos/camera_001.mp4',
  }));
}

test('video resources support GET, HEAD and single byte ranges', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-resource-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const resourceId = `video_${'c'.repeat(16)}`;
  const payload = crypto.randomBytes(2048);
  fakeVideoResource(cwd, resourceId, payload);
  const session = fakeSession('tau_video');
  session.cwd = cwd;
  liveManager.sessions.set(session.id, session);

  const url = `${base}/api/live-sessions/${session.id}/video-resources/${resourceId}/data`;
  const full = await fetch(url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(full.headers.get('cache-control'), 'private, no-store');
  assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Number(full.headers.get('content-length')), payload.length);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload);

  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers.get('content-length')), payload.length);
  assert.equal(await head.text(), '');

  const ranged = await fetch(url, { headers: { Range: 'bytes=100-199' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 100-199/${payload.length}`);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), payload.subarray(100, 200));

  const suffix = await fetch(url, { headers: { Range: 'bytes=-50' } });
  assert.equal(suffix.status, 206);
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), payload.subarray(payload.length - 50));

  const open = await fetch(url, { headers: { Range: 'bytes=2000-' } });
  assert.equal(open.status, 206);
  assert.equal(open.headers.get('content-range'), `bytes 2000-${payload.length - 1}/${payload.length}`);

  for (const range of ['bytes=5000-6000', 'bytes=200-100', 'items=0-10', 'bytes=']) {
    const response = await fetch(url, { headers: { Range: range } });
    assert.equal(response.status, 416, range);
    assert.equal(response.headers.get('content-range'), `bytes */${payload.length}`);
  }
});

test('video resources are bound to their owning session and validated manifests', async (t: TestContext) => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-owner-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-other-'));
  t.after(() => { fs.rmSync(firstRoot, { recursive: true, force: true }); fs.rmSync(secondRoot, { recursive: true, force: true }); });
  const resourceId = `video_${'d'.repeat(16)}`;
  fakeVideoResource(firstRoot, resourceId, crypto.randomBytes(128));
  const owner = fakeSession('tau_video_owner'); owner.cwd = firstRoot;
  const other = fakeSession('tau_video_other'); other.cwd = secondRoot;
  liveManager.sessions.set(owner.id, owner); liveManager.sessions.set(other.id, other);

  assert.equal((await fetch(`${base}/api/live-sessions/${owner.id}/video-resources/${resourceId}/data`)).status, 200);
  assert.equal((await fetch(`${base}/api/live-sessions/${other.id}/video-resources/${resourceId}/data`)).status, 404, 'cross-session resourceId is rejected');
  assert.equal((await fetch(`${base}/api/live-sessions/${owner.id}/video-resources/..%2Fsecret/data`)).status, 400);
  assert.equal((await fetch(`${base}/api/live-sessions/${owner.id}/video-resources/video_xyz/data`)).status, 400, 'malformed resource id');

  // Manifest/bytes mismatch is reported as a conflict, not served silently.
  const manifestPath = path.join(firstRoot, '.tau', 'video-resources', resourceId, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.bytes = 1;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.equal((await fetch(`${base}/api/live-sessions/${owner.id}/video-resources/${resourceId}/data`)).status, 409);

  // A symlinked resource dir never escapes the session root.
  if (process.platform !== 'win32') {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'video.mp4'), 'secret');
    fs.writeFileSync(path.join(outside, 'manifest.json'), '{}');
    const linkId = `video_${'e'.repeat(16)}`;
    fs.symlinkSync(outside, path.join(firstRoot, '.tau', 'video-resources', linkId), 'dir');
    assert.equal((await fetch(`${base}/api/live-sessions/${owner.id}/video-resources/${linkId}/data`)).status, 403);
  }
});

test('video metric API exposes only declared, session-scoped time-series data', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-metrics-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-metrics-data-'));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const resourceId = `video_${'f'.repeat(16)}`;
  fakeVideoResource(cwd, resourceId, crypto.randomBytes(64));
  fs.mkdirSync(path.join(dataRoot, 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'metrics', 'visible_people.csv'), 'relative_second,absolute_time,value\n0,2026-08-16T08:00:00+08:00,3\n1,2026-08-16T08:00:01+08:00,4\n');
  fs.writeFileSync(path.join(dataRoot, 'videos.json'), JSON.stringify({ schemaVersion: 1, videos: [{ videoId: 'video_001', title: '测试视频', startTime: '2026-08-16T08:00:00+08:00', endTime: '2026-08-16T08:01:00+08:00', file: 'videos/test.mp4', mimeType: 'video/mp4', metrics: [{ id: 'visible_people', label: '画面人数', unit: '人', file: 'metrics/visible_people.csv', sampleIntervalSeconds: 1 }] }] }));
  const session = fakeSession('tau_video_metrics') as any;
  session.cwd = cwd;
  session.resolvedSessionPlan = { assets: [{ id: 'data:test-video', kind: 'data', path: dataRoot }] };
  liveManager.sessions.set(session.id, session);

  const response = await fetch(`${base}/api/live-sessions/${session.id}/video-resources/${resourceId}/metrics`);
  assert.equal(response.status, 200);
  assert.deepEqual(await jsonBody(response), { metrics: [{ id: 'visible_people', label: '画面人数', unit: '人', sampleIntervalSeconds: 1, samples: [{ offsetSeconds: 0, value: 3 }, { offsetSeconds: 1, value: 4 }] }] });
});

test('video internal endpoints require the session video token', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-internal-'));
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-internal-data-'));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dataRoot, 'videos.json'), JSON.stringify({
    schemaVersion: 1,
    videos: [{ videoId: 'video_001', cameraId: 'camera_001', title: '人民路—中山路口', startTime: '2026-08-16T08:00:00+08:00', endTime: '2026-08-16T08:01:00+08:00', file: 'videos/camera_001.mp4', mimeType: 'video/mp4' }],
  }));
  const session = fakeSession('tau_video_internal') as any;
  session.cwd = cwd;
  session.serviceTokens.video = 'video-secret';
  session.resolvedSessionPlan = { assets: [{ id: 'data:demo-videos', kind: 'data', path: dataRoot }] };
  liveManager.sessions.set(session.id, session);

  const denied = await fetch(`${base}/api/internal/video/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, token: 'wrong', location: '人民路' }) });
  assert.equal(denied.status, 403);
  const missing = await fetch(`${base}/api/internal/video/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, location: '人民路' }) });
  assert.equal(missing.status, 403);

  const allowed = await fetch(`${base}/api/internal/video/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, token: 'video-secret', location: '人民路' }) });
  assert.equal(allowed.status, 200);
  const body = await jsonBody(allowed);
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].videoId, 'video_001');
  assert.ok(!('file' in body.candidates[0]), 'candidates never expose file paths');
});

test('Geo resources cannot be read through another live session', async (t: TestContext) => {
  const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-owner-'));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-other-'));
  t.after(() => { fs.rmSync(firstRoot, { recursive: true, force: true }); fs.rmSync(secondRoot, { recursive: true, force: true }); });
  const resourceId = `geo_${'b'.repeat(24)}`;
  const dir = path.join(firstRoot, '.tau', 'geo-resources', resourceId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ resourceId, sha256: 'b'.repeat(64), bytes: 42, featureCount: 0 }));
  const owner = fakeSession('tau_geo_owner'); owner.cwd = firstRoot;
  const other = fakeSession('tau_geo_other'); other.cwd = secondRoot;
  liveManager.sessions.set(owner.id, owner); liveManager.sessions.set(other.id, other);
  assert.equal((await fetch(`${base}/api/live-sessions/${owner.id}/geo-resources/${resourceId}/data`)).status, 200);
  assert.equal((await fetch(`${base}/api/live-sessions/${other.id}/geo-resources/${resourceId}/data`)).status, 404);
});

test('serves Registry-backed citation resources without exposing arbitrary session files', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-resource-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const report = Buffer.from('# 交通报告\n\n拥堵集中在入口。');
  fs.writeFileSync(path.join(cwd, 'report.md'), report);
  fs.writeFileSync(path.join(cwd, 'secret.txt'), 'not cited');
  const sha256 = crypto.createHash('sha256').update(report).digest('hex');
  const resourceId = `resource:${sha256.slice(0, 24)}`;
  const registry = {
    protocol: 'pi-citation',
    version: '2.0',
    schemaVersion: 1,
    sessionId: 'tau_citation_owner',
    citationSetId: 'citations:http',
    generatedAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    works: [{ workId: 'work:report', type: 'report', title: '交通报告' }],
    resources: [{ resourceId, workId: 'work:report', kind: 'document', scope: 'artifact', relativePath: 'report.md', mimeType: 'text/markdown', sha256 }],
    locators: [{ locatorId: 'locator:report', resourceId, section: '结论' }],
    occurrences: [{ occurrenceId: 'occ:report', locatorId: 'locator:report', containerType: 'document', containerId: 'report.md' }],
    provenance: [],
  };
  fs.mkdirSync(path.join(cwd, '.tau'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.tau', 'citations.json'), JSON.stringify(registry));
  const owner = fakeSession('tau_citation_owner');
  owner.cwd = cwd;
  const other = fakeSession('tau_citation_other');
  other.cwd = cwd;
  liveManager.sessions.set(owner.id, owner);
  liveManager.sessions.set(other.id, other);
  const url = `${base}/api/live-sessions/${owner.id}/citation-resources/${encodeURIComponent(resourceId)}/content`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), report.toString());
  assert.equal(response.headers.get('etag'), `"${sha256}"`);
  assert.equal((await fetch(`${base}/api/live-sessions/${other.id}/citation-resources/${encodeURIComponent(resourceId)}/content`)).status, 404);
  assert.equal((await fetch(`${base}/api/live-sessions/${owner.id}/citation-resources/${encodeURIComponent('resource:secret')}/content`)).status, 404);
  const citations = await jsonBody(await fetch(`${base}/api/live-sessions/${owner.id}/citations`));
  assert.equal(citations.citations.locators[0].locatorId, 'locator:report');
  const occurrence = await jsonBody(await fetch(`${base}/api/live-sessions/${owner.id}/citations/occurrences`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ locatorId: 'locator:report', role: 'support' }),
  }));
  assert.match(occurrence.marker, /^\[\[cite:occurrence_/);
});

test('serves a knowledge citation from the selected asset root instead of a task copy', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-knowledge-session-'));
  const knowledgeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-knowledge-root-'));
  t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(knowledgeRoot, { recursive: true, force: true }); });
  const original = Buffer.from('%PDF-original-source');
  const relativePath = 'knowledge:test/standard/source/original.pdf';
  fs.mkdirSync(path.join(knowledgeRoot, 'standard', 'source'), { recursive: true });
  fs.writeFileSync(path.join(knowledgeRoot, 'standard', 'source', 'original.pdf'), original);
  const sha256 = crypto.createHash('sha256').update(original).digest('hex');
  const resourceId = 'resource:knowledge-original';
  fs.mkdirSync(path.join(cwd, '.tau'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.tau', 'citations.json'), JSON.stringify({
    protocol: 'pi-citation', version: '2.0', schemaVersion: 1, sessionId: 'tau_knowledge_owner', citationSetId: 'citations:knowledge', generatedAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
    works: [{ workId: 'work:knowledge', type: 'standard', title: '原始规范' }],
    resources: [{ resourceId, workId: 'work:knowledge', kind: 'pdf', scope: 'knowledge', relativePath, mimeType: 'application/pdf', sha256 }],
    locators: [{ locatorId: 'locator:knowledge', resourceId, page: 12 }], occurrences: [], provenance: [],
  }));
  const owner = fakeSession('tau_knowledge_owner');
  owner.cwd = cwd;
  (owner as any).resolvedSessionPlan = { assets: [{ id: 'knowledge:test', kind: 'knowledge', path: knowledgeRoot }] };
  liveManager.sessions.set(owner.id, owner);

  const response = await fetch(`${base}/api/live-sessions/${owner.id}/citation-resources/${encodeURIComponent(resourceId)}/content`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/pdf');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), original);
});

test('projects the selected history branch and sorts sessions by conversation time', async () => {
  const branchRows = [
    { type: 'session', id: 'branch', cwd: '/tmp' },
    { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'root' } },
    { type: 'message', id: 'old', parentId: 'root', message: { role: 'assistant', content: 'old answer' } },
    { type: 'message', id: 'current', parentId: 'root', message: { role: 'assistant', content: 'current answer' } },
  ];
  const branchFile = writeSessionFileAt(PROJ_DIR, 'branch.jsonl', branchRows);
  const [history, file] = await Promise.all([
    fetch(`${base}/api/session-history?filePath=${encodeURIComponent(branchFile)}`),
    fetch(`${base}/api/sessions/--tmp--httpproj/branch.jsonl`),
  ]);
  const historyBody = await jsonBody(history);
  assert.deepEqual(historyBody, await jsonBody(file));
  assert.deepEqual(historyBody.entries.map((entry: { id: string }) => entry.id), ['root', 'current']);

  const projectPath = path.join(PROJECTS_DIR, 'conversation-recency');
  const encodedDir = path.join(SESSIONS_DIR, '--tmp--conversation-recency');
  const older = writeSessionFileAt(encodedDir, 'older.jsonl', [
    { type: 'session', id: 'older', cwd: projectPath },
    { type: 'message', timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'user', content: 'older first' } },
    { type: 'message', timestamp: '2026-01-01T00:02:00.000Z', message: { role: 'assistant', content: 'older reply' } },
    { type: 'message', timestamp: '2026-01-01T00:03:00.000Z', message: { role: 'user', content: 'older follow-up' } },
  ]);
  const newer = writeSessionFileAt(encodedDir, 'newer.jsonl', [
    { type: 'session', id: 'newer', cwd: projectPath },
    { type: 'message', timestamp: '2026-01-02T00:01:00.000Z', message: { role: 'user', content: 'newer first' } },
    { type: 'message', timestamp: '2026-01-02T00:02:00.000Z', message: { role: 'assistant', content: 'newer reply' } },
    { type: 'message', timestamp: '2026-01-02T00:03:00.000Z', message: { role: 'user', content: 'newer follow-up' } },
  ]);
  const flatProjectPath = path.join(PROJECTS_DIR, 'flat-session');
  const flat = writeSessionFileAt(SESSIONS_DIR, 'flat.jsonl', [
    { type: 'session', id: 'flat', cwd: flatProjectPath },
    { type: 'message', timestamp: '2026-01-03T00:01:00.000Z', message: { role: 'user', content: 'flat first' } },
    { type: 'message', timestamp: '2026-01-03T00:02:00.000Z', message: { role: 'assistant', content: 'flat reply' } },
    { type: 'message', timestamp: '2026-01-03T00:03:00.000Z', message: { role: 'user', content: 'flat follow-up' } },
  ]);
  fs.utimesSync(older, new Date('2030-01-01'), new Date('2030-01-01'));
  fs.utimesSync(newer, new Date('2020-01-01'), new Date('2020-01-01'));
  const sessions = await jsonBody(await fetch(`${base}/api/sessions`));
  const flatHistory = await jsonBody(await fetch(`${base}/api/session-history?filePath=${encodeURIComponent(flat)}`));
  const project = sessions.projects.find((item: { path: string }) => item.path === path.resolve(projectPath));
  const flatProject = sessions.projects.find((item: { path: string }) => item.path === path.resolve(flatProjectPath));
  assert.deepEqual(project.sessions.map((item: { id: string }) => item.id), ['newer', 'older']);
  assert.equal(project.sessions[0].lastConversationAt, '2026-01-02T00:03:00.000Z');
  assert.deepEqual(flatProject.sessions.map((item: { id: string }) => item.id), ['flat']);
  assert.deepEqual(flatHistory.entries.map((entry: { message?: { content?: string } }) => entry.message?.content).filter(Boolean), ['flat first', 'flat reply', 'flat follow-up']);
});

test('reads files within the live-session directory but blocks static traversal', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-files-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const report = path.join(cwd, 'report.md');
  fs.writeFileSync(report, '# Report\n\nTraffic analysis');
  const session = fakeSession('tau_files');
  session.cwd = cwd;
  liveManager.sessions.set(session.id, session);
  const content = await jsonBody(await fetch(`${base}/api/file/content?sessionId=${session.id}&path=${encodeURIComponent(report)}`));
  assert.equal(content.content, '# Report\n\nTraffic analysis');
  assert.equal((await fetch(`${base}/%2e%2e%2fsecret`)).status, 403);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test('normalizes model references before sending Pi set_model commands', async () => {
  const commands: Array<Record<string, unknown>> = [];
  const session = {
    ...fakeSession('tau_set_model'),
    send: async (command: Record<string, unknown>) => {
      commands.push(command);
      return { success: true, data: { model: { provider: 'deepseek', id: 'deepseek-v4-flash' } } };
    },
  };
  liveManager.sessions.set(session.id, session);

  const response = await handleRpcCommand({ type: 'set_model', sessionId: session.id, model: 'deepseek/deepseek-v4-flash' });
  assert.equal(response.success, true);
  assert.equal(commands[0].provider, 'deepseek');
  assert.equal(commands[0].modelId, 'deepseek-v4-flash');
});

test('RPC registry rejects prototype property names as unknown commands', async () => {
  const session = fakeSession('tau_registry_unknown');
  liveManager.sessions.set(session.id, session);
  const response = await handleRpcCommand({ type: 'toString', sessionId: session.id });
  assert.equal(response.success, false);
  assert.match(String(response.error), /Unknown command/);
});

test('delegates auto-compaction state and settings to Pi RPC', async () => {
  const commands: Array<Record<string, unknown>> = [];
  const session = {
    ...fakeSession('tau_auto_compaction'),
    send: async (command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === 'get_state') return { success: true, data: { autoCompactionEnabled: false, isCompacting: true } };
      return { success: true };
    },
  };
  liveManager.sessions.set(session.id, session);

  const state = await handleRpcCommand({ type: 'get_state', sessionId: session.id });
  assert.equal(commands[0].type, 'get_state');
  assert.equal(state.data.autoCompactionEnabled, false);
  const updated = await handleRpcCommand({ type: 'set_auto_compaction', sessionId: session.id, enabled: false });
  assert.equal(updated.success, true);
  assert.deepEqual(commands[1], { type: 'set_auto_compaction', sessionId: session.id, enabled: false });
  assert.equal(session.autoCompactionEnabled, false);
});

test('reliable prompt command IDs are acknowledged and executed once', async () => {
  let calls = 0;
  const session = {
    ...fakeSession('tau_reliable_prompt'),
    send: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { success: true };
    },
    registerPromptAttachments: () => {},
    discardPromptAttachments: () => {},
  };
  liveManager.sessions.set(session.id, session);
  const command = { type: 'prompt', sessionId: session.id, message: '一次即可', clientCommandId: 'client-command-one' };
  const [first, duplicate] = await Promise.all([handleRpcCommand(command), handleRpcCommand(command)]);
  assert.equal(calls, 1);
  assert.equal(first.success, true);
  assert.equal(first.delivery, 'accepted');
  assert.equal(first.clientCommandId, 'client-command-one');
  assert.deepEqual(duplicate, first);
});

test('Pi RPC prompt timeout is reported instead of optimistic success', async () => {
  const session = {
    ...fakeSession('tau_prompt_timeout'),
    send: async () => { throw new Error('RPC command timed out: prompt'); },
    registerPromptAttachments: () => {},
    discardPromptAttachments: () => {},
  };
  liveManager.sessions.set(session.id, session);
  const response = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: '不要假成功', clientCommandId: 'client-command-timeout' });
  assert.equal(response.success, false);
  assert.match(String(response.error), /timed out/);
});

test('Pi RPC extension UI responses acknowledge after writing because Pi sends no response envelope', async () => {
  const manager = new (require('../bin/sessions.js').LiveSessionManager)();
  const session = new PiRpcSession(manager, { cwd: '/tmp/pi-extension-ui' });
  const child = makeFakeChild();
  const received: string[] = [];
  child.stdin.on('data', (chunk: Buffer) => received.push(chunk.toString()));
  (session as any).child = child;

  const response = await Promise.race([
    session.send({ type: 'extension_ui_response', id: 'ui-1', value: 'northbound' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('extension UI response was not acknowledged')), 100)),
  ]);

  assert.equal((response as { success: boolean }).success, true);
  assert.match(received.join(''), /"type":"extension_ui_response"/);
});

test('resuming a stored session publishes the persisted conversation snapshot', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-resume-http-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const entries = [
    { type: 'session', id: 'resume', timestamp: '2026-01-01T00:00:00.000Z', cwd },
    { type: 'message', message: { role: 'user', content: 'resume this historical thread' } },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'historical reply' }] } },
    { type: 'session_info', name: 'Snapshot Chat' },
  ];
  const filePath = writeSessionFileAt(PROJ_DIR, 'resume.jsonl', entries);
  const child = makeFakeChild();
  let piArgs: string[] = [];
  _setSpawnPiForTest((_cmd: string, args: string[]) => {
    piArgs = args;
    return child;
  });
  t.after(() => _setSpawnPiForTest(null));
  const blockedResponse = await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath }),
  });
  assert.equal(blockedResponse.status, 409);
  assert.equal((await jsonBody(blockedResponse)).code, 'legacy_plan_requires_confirmation');
  const resumed = await jsonBody(await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath, useCurrentConfiguration: true }),
  }));
  assert.ok(resumed.session, JSON.stringify(resumed));
  const snapshot = await jsonBody(await fetch(`${base}/api/live-sessions/${encodeURIComponent(resumed.session.id)}/snapshot`));
  assert.equal(snapshot.session.sessionName, 'Snapshot Chat');
  assert.equal(snapshot.session.sessionFile, path.resolve(filePath));
  assert.deepEqual(snapshot.entries, entries.slice(1));
  const systemPromptIndex = piArgs.indexOf('--system-prompt');
  assert.ok(systemPromptIndex >= 0);
  assert.equal(piArgs[systemPromptIndex + 1], fs.readFileSync(path.join(process.cwd(), 'prompts', 'PI_SYSTEM.md'), 'utf8').trim());
  child.stdin.end();
});
