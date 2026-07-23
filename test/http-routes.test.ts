const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
import type { TestContext } from 'node:test';

process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-http-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');
const PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');
process.env.TAU_PROJECTS_DIR = PROJECTS_DIR;

const { server, computeUrls, liveManager, SESSIONS_DIR, _setSpawnPiForTest } = require('../bin/tau.js');
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
    sessionFile: `/tmp/${id}.jsonl`,
    sessionName: null,
    contextUsage: null,
    entries: [],
    metadata: () => ({ id, cwd: '/tmp/proj', model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
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
  fs.utimesSync(older, new Date('2030-01-01'), new Date('2030-01-01'));
  fs.utimesSync(newer, new Date('2020-01-01'), new Date('2020-01-01'));
  const sessions = await jsonBody(await fetch(`${base}/api/sessions`));
  const project = sessions.projects.find((item: { path: string }) => item.path === path.resolve(projectPath));
  assert.deepEqual(project.sessions.map((item: { id: string }) => item.id), ['newer', 'older']);
  assert.equal(project.sessions[0].lastConversationAt, '2026-01-02T00:03:00.000Z');
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
  _setSpawnPiForTest(() => child);
  t.after(() => _setSpawnPiForTest(null));
  const resumed = await jsonBody(await fetch(`${base}/api/live-sessions/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base, Host: new URL(base).host },
    body: JSON.stringify({ filePath }),
  }));
  const snapshot = await jsonBody(await fetch(`${base}/api/live-sessions/${encodeURIComponent(resumed.session.id)}/snapshot`));
  assert.equal(snapshot.session.sessionName, 'Snapshot Chat');
  assert.equal(snapshot.session.sessionFile, path.resolve(filePath));
  assert.deepEqual(snapshot.entries, entries.slice(1));
  child.stdin.end();
});
