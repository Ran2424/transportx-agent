const { test } = require('node:test') as typeof import('node:test');

test('HTTP enforces resource ownership, request limits, reliable delivery and safe history recovery', async (t) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { testSymlink } = require('../support/symlink.ts');

  process.env.TAU_HOST = '127.0.0.1';

  process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-http-'));
  process.env.TAU_USER_DATA_DIR = process.env.PI_CODING_AGENT_DIR;
  require('../../bin/diagnostic-log.js').initializeHostLogging(path.join(process.env.TAU_USER_DATA_DIR, 'logs'));

  process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');

  const PROJECTS_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'projects');

  process.env.TAU_PROJECTS_DIR = PROJECTS_DIR;

  const { server, listen, workspaceHost, computeUrls, handleRpcCommand, liveManager, SESSIONS_DIR, PiRpcSession, _setSpawnPiForTest } = require('../../bin/tau.js');
  const { createApiRouter } = require('../../bin/api-routes.js');

  let base = '';
  const request = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { 'X-TransportX-Protocol': '2', ...init.headers } });
  const { writeJsonAtomic } = require('../../bin/util/json-storage.js');
  function registerSession(session: any) {
    const store = workspaceHost.options.store, at = '2026-10-25T00:00:00.000Z';
    if (session.cwd === '/tmp/proj') session.cwd = path.join(PROJECTS_DIR, session.id);
    fs.mkdirSync(session.cwd, { recursive: true }); session.cwd = fs.realpathSync(session.cwd);
    const catalog = store.readCatalog(); let entry = catalog.entries.find((item: any) => item.path === session.cwd);
    let manifest: any;
    if (entry) manifest = store.readWorkspace(entry.workspaceId).manifest;
    else {
      entry = { workspaceId: `ws_${crypto.randomUUID()}`, path: session.cwd, creationRequestId: null, creationInputSha256: null, state: 'ready', deletion: null }; catalog.entries.push(entry); catalog.revision++;
      manifest = { schemaVersion: 1, id: entry.workspaceId, revision: 0, name: session.id, createdAt: at, updatedAt: at, defaultsRevision: 0, defaults: { domainId: null, modelSpec: null, profile: null }, citationRegistryId: session.id, conversations: [] };
    }
    session.workspaceId = entry.workspaceId;
    const key = `http/${session.conversationId}.jsonl`; session.sessionFile = path.join(SESSIONS_DIR, key);
    fs.mkdirSync(path.dirname(session.sessionFile), { recursive: true });
    fs.writeFileSync(session.sessionFile, JSON.stringify({ type: 'session', id: `native-${session.id}`, timestamp: at, cwd: session.cwd }) + '\n');
    // These HTTP service fixtures mock an already-authorized runtime; lifecycle exclusion is tested with real Pi in session-boundaries and Chrome smoke.
    session.lifecycle = { isReady: () => true, isCurrent: () => true };
    session.citationRegistryId = manifest.citationRegistryId;
    fs.mkdirSync(path.join(session.cwd, '.tau/conversations', session.conversationId), { recursive: true });
    writeJsonAtomic(path.join(session.cwd, '.tau/conversations', session.conversationId, 'plan.json'), { schemaVersion: 3, platform: { name: 'TransportX Agent', version: '3.23.2' }, domain: { id: 'com.transportx.workbench', version: '1.4.1' }, profile: { schemaVersion: 1, task: { kind: 'data-query', expectedOutputs: ['answer'] }, modules: { selectionMode: 'explicit', selected: [] } }, modules: [], assets: [], runtime: {}, workspace: session.cwd, createdAt: at });
    manifest.conversations.push({ id: session.conversationId, creationRequestId: null, creationInputSha256: null, name: session.id, createdAt: at, updatedAt: at, defaultsRevision: null, modelSpec: null, appendSystemPrompt: '', state: 'ready', history: { key, headerId: `native-${session.id}` }, plan: { path: `conversations/${session.conversationId}/plan.json`, source: 'created' }, privateState: 'isolated', lastStartFailure: null, deletion: null }); manifest.revision++;
    writeJsonAtomic(path.join(session.cwd, '.tau/workspace.json'), manifest); writeJsonAtomic(store.catalogFile, catalog);
    liveManager.sessions.set(session.id, session);
  }
  function geoPublication(session: any, resourceId: string) {
    const resource = JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/geo-resources', resourceId, 'manifest.json'), 'utf8'));
    session.entries.push({ type: 'message', message: { role: 'toolResult', toolName: 'publish_geodata', details: { kind: 'tau-geo-resource', resource } } });
  }
  function videoAuthorization(session: any, resourceId: string) {
    const resource = JSON.parse(fs.readFileSync(path.join(session.cwd, '.tau/video-resources', resourceId, 'manifest.json'), 'utf8'));
    const assetRoot = path.join(process.env.TAU_USER_DATA_DIR!, 'test-assets', session.id); fs.mkdirSync(path.join(assetRoot, 'videos'), { recursive: true });
    fs.copyFileSync(path.join(session.cwd, '.tau/video-resources', resourceId, 'video.mp4'), path.join(assetRoot, resource.sourceRelativePath));
    writeJsonAtomic(path.join(assetRoot, 'videos.json'), { schemaVersion: 1, videos: [{ videoId: resource.videoId, cameraId: 'camera_001', title: 'Test recording', locationName: 'Test', startTime: resource.recordingStartTime, endTime: resource.recordingEndTime, file: resource.sourceRelativePath, mimeType: 'video/mp4' }] });
    session.resolvedSessionPlan = { modules: [{ id: 'com.transportx.video' }], assets: [{ id: resource.sourceAssetId, kind: 'data', path: assetRoot }] };
  }


  const PROJ_DIR = path.join(SESSIONS_DIR, '--tmp--httpproj');

  function writeSessionFileAt(projectDir: string, fileName: string, lines: Array<Record<string, unknown>>) {
    fs.mkdirSync(projectDir, { recursive: true });
    const filePath = path.join(projectDir, fileName);
    fs.writeFileSync(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    return filePath;
  }

  function fakeSession(id: string): any {
    return {
      id,
      conversationId: `conv_${crypto.randomUUID()}`,
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
      serviceTokens: { citation: 'citation-token', spatial: 'spatial-token', video: 'video-token', geo: 'geo-token', canvas: 'canvas-token', cad: 'cad-token' },
      manager: liveManager,
      metadata: () => ({ id, cwd: '/tmp/proj', model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
      liveMetadata: () => ({ id, model: 'openai/gpt-5.5', isStreaming: false, isCompacting: false, autoCompactionEnabled: true }),
      snapshot: () => ({ schemaVersion: 1, session: { id }, entries: [], model: 'openai/gpt-5.5', isStreaming: false, sessionFile: `/tmp/${id}.jsonl` }),
      terminate: async () => { },
      send: async () => ({ data: { commands: [] } }),
      registerPendingMessage: () => { },
      discardPendingMessage: () => { },
      abortGeoInteraction: () => { },
    };
  }

  function makeFakeChild() {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;
    child.kill = () => { };
    return child;
  }

  async function jsonBody(res: Response) {
    return JSON.parse(await res.text());
  }

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

  t.after(() => new Promise<void>((resolve) => {
    server.close(resolve);
  }));

  t.after(() => fs.rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));

  await new Promise<void>((resolve) => {
    server.once('listening', () => {
      const port = server.address().port;
      computeUrls(port);
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
    listen(0);
  });
  const initialized = Date.now();
  while ((await (await request(`${base}/api/health`)).json()).dataState !== 'ready') { if (Date.now() - initialized > 5000) throw new Error('HTTP fixture inventory did not initialize'); await new Promise((resolve) => setTimeout(resolve, 20)); }

  // bounded JSON requests preserve UTF-8 and return readable 413 responses
  {
    liveManager.sessions.clear();
    const { readJsonBody } = require('../../bin/http/request.js');
    const req = new PassThrough() as any;
    const parsed = readJsonBody(req, 100);
    const value = Buffer.from('{"text":"道路"}');
    for (const byte of value) req.write(Buffer.from([byte]));
    req.end();
    assert.deepEqual(await parsed, { text: '道路' });
    const over = new PassThrough() as any;
    const rejected = assert.rejects(readJsonBody(over, 4), (error: any) => error.status === 413);
    over.write(Buffer.from('12345'));
    await rejected;
    for (let index = 0; index < 100; index++) over.write(Buffer.alloc(1024));
    over.end();
    const response = await request(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'prompt', message: 'x'.repeat(1024 * 1024) }) });
    assert.equal(response.status, 413);
    assert.match((await jsonBody(response)).error, /too large/);
    await request(`${base}/api/session-history?filePath=invalid&api_key=private-query-secret`);
    const log = fs.readFileSync(path.join(process.env.TAU_USER_DATA_DIR, 'logs', 'runtime.jsonl'), 'utf8');
    assert.ok(log.includes('host_logging_started'));
    assert.doesNotMatch(log, /private-query-secret/);
  }

  // multipart limits return a readable error over HTTP
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-upload-http-limit-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const session = fakeSession('tau_upload_limit');
    session.cwd = cwd;
    registerSession(session);
    const form = new FormData();
    for (let index = 0; index < 21; index++) form.append('file', new Blob(['x']), `${index}.txt`);
    const response = await request(`${base}/api/conversations/${session.conversationId}/attachments?source=picker`, { method: 'POST', body: form });
    assert.equal(response.status, 413);
    assert.match((await jsonBody(response)).error, /20 file limit/);
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.tau', 'attachment-tmp')), []);
  }

  // Internal service tokens authenticate independently of user credentials and require scope
  {
    liveManager.sessions.clear();
    const { _setAuthForTest, _setCredentialsForTest } = require('../../bin/tau.js');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-service-auth-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const session = fakeSession('tau_internal_auth') as any;
    session.cwd = cwd;
    session.resolvedSessionPlan = { modules: [{ id: 'com.transportx.canvas', canvasViews: [] }, { id: 'com.transportx.document', canvasViews: [{ adapterId: 'com.transportx.canvas.document', kind: 'document', protocolVersion: '1.0' }] }] };
    fs.writeFileSync(path.join(cwd, 'counts.csv'), 'road,count\nA,12\n');
    const { CanvasService } = require('../../bin/canvas-service.js');
    const canvas = new CanvasService({}, (_session: unknown, requested: string) => path.resolve(cwd, requested));
    const presentation = canvas.present(session, { adapterId: 'com.transportx.canvas.document', resource: { scope: 'session-file', path: 'counts.csv' } });
    session.entries.push({ message: { details: { canvas: presentation } } });
    const context = canvas.createContext(session, { viewId: presentation.viewId, revision: presentation.revision });
    session.activeCanvasContextIds = [context.contextId];
    registerSession(session);
    _setCredentialsForTest('test-user', 'test-pass');
    try {
      _setAuthForTest(true);
      const call = (body: Record<string, unknown>) => request(`${base}/api/internal/canvas/inspect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextIds: [context.contextId], ...body }) });
      assert.equal((await call({ sessionId: session.id, token: 'canvas-token' })).status, 200);
      for (const body of [{ sessionId: session.id }, { sessionId: session.id, token: 'geo-token' }, { sessionId: 'other', token: 'canvas-token' }]) assert.equal((await call(body)).status, 403);
      session.resolvedSessionPlan.modules = [];
      assert.equal((await call({ sessionId: session.id, token: 'canvas-token' })).status, 403);
      session.resolvedSessionPlan.modules = [{ id: 'com.transportx.canvas' }];
      session.terminating = true;
      assert.equal((await call({ sessionId: session.id, token: 'canvas-token' })).status, 403);
      for (const route of ['/api/live-sessions', '/api/health-extra', '/api/internal/unknown', '/api/internal/canvas/inspect']) assert.equal((await request(`${base}${route}`)).status, 401, route);
      const cad = await request(`${base}/api/internal/cad/inspect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id }) });
      assert.equal(cad.status, 403, 'CAD route requires a service token');
    } finally { _setAuthForTest(false); }
  }

  // serves only session-scoped GeoJSON and supports ETag revalidation
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-resource-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
    const sha256 = crypto.createHash('sha256').update(geojson).digest('hex');
    const resourceId = `geo_${sha256.slice(0, 24)}`;
    const dir = path.join(cwd, '.tau', 'geo-resources', resourceId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.geojson'), geojson);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ resourceId, sha256, bytes: Buffer.byteLength(geojson), featureCount: 0 }));
    const session = fakeSession('tau_geo');
    session.cwd = cwd; session.resolvedSessionPlan = { modules: [{ id: 'com.transportx.geo' }] }; geoPublication(session, resourceId);
    registerSession(session);

    const url = `${base}/api/conversations/${session.conversationId}/geo-resources/${resourceId}/data`;
    const resource = await request(url);
    assert.equal(resource.headers.get('etag'), `"${sha256}"`);
    assert.deepEqual(await jsonBody(resource), { type: 'FeatureCollection', features: [] });
    assert.equal((await request(url, { headers: { 'If-None-Match': `"${sha256}"` } })).status, 304);
    assert.equal((await request(`${base}/api/conversations/${session.conversationId}/geo-resources/..%2Fsecret/data`)).status, 400);
    fs.writeFileSync(path.join(dir, 'data.geojson'), geojson.replace('FeatureCollection', 'FeatureCollectioN'));
    assert.equal((await request(url, { headers: { 'If-None-Match': `"${sha256}"` } })).status, 409);
    assert.equal((await request(url.replace('/data', '/manifest'))).status, 409);
  }

  // video resources support GET, HEAD and single byte ranges
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-resource-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const resourceId = `video_${'c'.repeat(16)}`;
    const payload = crypto.randomBytes(2048);
    fakeVideoResource(cwd, resourceId, payload);
    const session = fakeSession('tau_video');
    session.cwd = cwd; videoAuthorization(session, resourceId);
    registerSession(session);

    const url = `${base}/api/conversations/${session.conversationId}/video-resources/${resourceId}/data`;
    const full = await request(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('cache-control'), 'private, no-store');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Number(full.headers.get('content-length')), payload.length);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload);

    const head = await request(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), payload.length);
    assert.equal(await head.text(), '');

    const ranged = await request(url, { headers: { Range: 'bytes=100-199' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 100-199/${payload.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), payload.subarray(100, 200));

    const suffix = await request(url, { headers: { Range: 'bytes=-50' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), payload.subarray(payload.length - 50));

    const open = await request(url, { headers: { Range: 'bytes=2000-' } });
    assert.equal(open.status, 206);
    assert.equal(open.headers.get('content-range'), `bytes 2000-${payload.length - 1}/${payload.length}`);

    for (const range of ['bytes=5000-6000', 'bytes=200-100', 'items=0-10', 'bytes=']) {
      const response = await request(url, { headers: { Range: range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get('content-range'), `bytes */${payload.length}`);
    }
  }

  // video resources are bound to their owning session and validated manifests
  {
    liveManager.sessions.clear();
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-owner-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-other-'));
    t.after(() => { fs.rmSync(firstRoot, { recursive: true, force: true }); fs.rmSync(secondRoot, { recursive: true, force: true }); });
    const resourceId = `video_${'d'.repeat(16)}`;
    fakeVideoResource(firstRoot, resourceId, crypto.randomBytes(128));
    const owner = fakeSession('tau_video_owner'); owner.cwd = firstRoot; videoAuthorization(owner, resourceId);
    const other = fakeSession('tau_video_other'); other.cwd = secondRoot;
    registerSession(owner); registerSession(other);

    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/video-resources/${resourceId}/data`)).status, 200);
    assert.equal((await request(`${base}/api/conversations/${other.conversationId}/video-resources/${resourceId}/data`)).status, 404, 'cross-session resourceId is rejected');
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/video-resources/..%2Fsecret/data`)).status, 400);
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/video-resources/video_xyz/data`)).status, 400, 'malformed resource id');

    // Manifest/bytes mismatch is reported as a conflict, not served silently.
    const manifestPath = path.join(firstRoot, '.tau', 'video-resources', resourceId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.bytes = 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/video-resources/${resourceId}/data`)).status, 409);

    // A symlinked resource dir never escapes the session root.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'video.mp4'), 'secret');
    fs.writeFileSync(path.join(outside, 'manifest.json'), '{}');
    await testSymlink(t, 'symlinked video resource cannot escape the session root', outside, path.join(firstRoot, '.tau', 'video-resources', `video_${'e'.repeat(16)}`), async () => {
      const linkId = `video_${'e'.repeat(16)}`;
      assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/video-resources/${linkId}/data`)).status, 403);
    }, 'dir');
  }

  // video metric API exposes only declared, session-scoped time-series data
  {
    liveManager.sessions.clear();
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
    fs.mkdirSync(path.join(dataRoot, 'videos'), { recursive: true }); fs.copyFileSync(path.join(cwd, '.tau/video-resources', resourceId, 'video.mp4'), path.join(dataRoot, 'videos/test.mp4'));
    const videoManifest = path.join(cwd, '.tau/video-resources', resourceId, 'manifest.json'); writeJsonAtomic(videoManifest, { ...JSON.parse(fs.readFileSync(videoManifest, 'utf8')), sourceAssetId: 'data:test-video', sourceRelativePath: 'videos/test.mp4' });
    session.resolvedSessionPlan = { modules: [{ id: 'com.transportx.video' }], assets: [{ id: 'data:test-video', kind: 'data', path: dataRoot }] };
    registerSession(session);

    const response = await request(`${base}/api/conversations/${session.conversationId}/video-resources/${resourceId}/metrics`);
    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), { metrics: [{ id: 'visible_people', label: '画面人数', unit: '人', sampleIntervalSeconds: 1, samples: [{ offsetSeconds: 0, value: 3 }, { offsetSeconds: 1, value: 4 }] }] });
  }

  // Geo resources cannot be read through another live session
  {
    liveManager.sessions.clear();
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-owner-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-other-'));
    t.after(() => { fs.rmSync(firstRoot, { recursive: true, force: true }); fs.rmSync(secondRoot, { recursive: true, force: true }); });
    const resourceId = `geo_${'b'.repeat(24)}`;
    const dir = path.join(firstRoot, '.tau', 'geo-resources', resourceId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ resourceId, sha256: crypto.createHash('sha256').update(JSON.stringify({ type: 'FeatureCollection', features: [] })).digest('hex'), bytes: 42, featureCount: 0 }));
    const owner = fakeSession('tau_geo_owner'); owner.cwd = firstRoot; owner.resolvedSessionPlan = { modules: [{ id: 'com.transportx.geo' }] }; geoPublication(owner, resourceId);
    const other = fakeSession('tau_geo_other'); other.cwd = secondRoot;
    registerSession(owner); registerSession(other);
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/geo-resources/${resourceId}/data`)).status, 200);
    assert.equal((await request(`${base}/api/conversations/${other.conversationId}/geo-resources/${resourceId}/data`)).status, 404);
  }

  // Geo interaction routes enforce capability, token scope and terminal response
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-routes-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const resourceId = `geo_${'c'.repeat(24)}`;
    const geojson = JSON.stringify({
      type: 'FeatureCollection', features: [
        { type: 'Feature', id: 'road-1', properties: { name: '一号路', secret: 'not-exposed' }, geometry: { type: 'LineString', coordinates: [[121.4, 31.1], [121.5, 31.3]] } },
      ]
    });
    const resourceDir = path.join(cwd, '.tau', 'geo-resources', resourceId);
    fs.mkdirSync(resourceDir, { recursive: true });
    fs.writeFileSync(path.join(resourceDir, 'data.geojson'), geojson);
    fs.writeFileSync(path.join(resourceDir, 'manifest.json'), JSON.stringify({
      resourceId,
      sha256: crypto.createHash('sha256').update(geojson).digest('hex'),
      bytes: Buffer.byteLength(geojson),
      featureCount: 1,
    }));
    const envelope = {
      protocol: 'pi-visualization', version: '1.0', kind: 'geo', visualizationId: 'route_map', revision: 1, operation: 'replace',
      scene: {
        view: { mode: 'bounds', bounds: [121.4, 31.1, 121.5, 31.3] }, basemap: { id: 'light' },
        sources: [{ id: 'roads_source', type: 'geojson-resource', resourceId }],
        layers: [{ id: 'roads', sourceId: 'roads_source', type: 'line', encoding: { color: { mode: 'constant', value: '#2563eb' } }, popup: { fields: [{ field: 'name', label: '名称' }] } }],
        metadata: { title: '道路' },
      },
      summary: { title: '道路' }, generatedAt: '2026-09-02T00:00:00.000Z',
    };
    const session = fakeSession('tau_geo_routes') as any;
    session.cwd = cwd;
    session.entries = [{ type: 'message', message: { role: 'toolResult', details: { visualization: envelope } } }];
    session.resolvedSessionPlan = { modules: [] };
    session.activeGeoContextIds = []; geoPublication(session, resourceId);
    registerSession(session);
    const context = {
      version: 1,
      contextId: `geoctx_${'a'.repeat(16)}`,
      visualizationId: 'route_map',
      sceneRevision: 1,
      mode: 'feature',
      createdAt: '2026-09-02T01:00:00.000Z',
      view: { center: [121.45, 31.2], zoom: 12, bounds: [121.4, 31.1, 121.5, 31.3], bearing: 0, pitch: 0 },
      visibleLayerIds: ['roads'],
      selection: { layerId: 'roads', featureIds: ['road-1'] },
      summary: 'client summary',
    };
    const contextUrl = `${base}/api/conversations/${session.conversationId}/geo-contexts`;
    const unavailable = await request(contextUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context) });
    assert.equal(unavailable.status, 409);
    assert.equal(fs.existsSync(path.join(cwd, '.tau', 'geo-interactions')), false);

    session.resolvedSessionPlan.modules = [{ id: 'com.transportx.geo' }];
    const createdResponse = await request(contextUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context) });
    assert.equal(createdResponse.status, 200);
    const created = await jsonBody(createdResponse);
    assert.equal(created.context.summary, 'client summary');
    assert.equal(created.provenance.geoResourceId, resourceId);
    const restored = await jsonBody(await request(`${contextUrl}/${context.contextId}`));
    assert.equal(restored.context.contextId, context.contextId);
    const screenshotResponse = await request(`${base}/api/conversations/${session.conversationId}/geo-screenshots`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visualizationId: 'route_map', sceneRevision: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6sAAAAASUVORK5CYII=' }),
    });
    assert.equal(screenshotResponse.status, 200);
    const screenshot = await jsonBody(screenshotResponse);
    assert.equal(path.dirname(screenshot.path), fs.realpathSync(cwd));
    assert.equal(fs.existsSync(screenshot.path), true);

    let screenshotRequestId = '';
    const broadcast = liveManager.broadcast.bind(liveManager);
    liveManager.broadcast = (data: any) => {
      if (data?.type === 'geo_screenshot_updated' && data.request?.requestId) screenshotRequestId = data.request.requestId;
      broadcast(data);
    };
    t.after(() => { liveManager.broadcast = broadcast; });
    const agentScreenshotPromise = request(`${base}/api/internal/geo/screenshot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, token: 'geo-token', visualizationId: 'route_map', sceneRevision: 1 }),
    });
    for (let attempt = 0; attempt < 50 && !screenshotRequestId; attempt += 1) {
      if (!screenshotRequestId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(screenshotRequestId, /^geoshot_/);
    const agentScreenshotResponse = await request(`${base}/api/conversations/${session.conversationId}/geo-screenshots/${screenshotRequestId}/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'captured', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6sAAAAASUVORK5CYII=' }),
    });
    assert.equal(agentScreenshotResponse.status, 200);
    const agentScreenshot = await jsonBody(await agentScreenshotPromise);
    assert.equal(agentScreenshot.result.status, 'captured');
    assert.equal(agentScreenshot.result.relativePath, agentScreenshot.result.filename);

    const inspectUrl = `${base}/api/internal/geo/inspect`;
    assert.equal((await request(inspectUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, token: 'wrong', contextIds: [context.contextId] }) })).status, 403);
    session.activeGeoContextIds = [context.contextId];
    const inspected = await jsonBody(await request(inspectUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, token: 'geo-token' }) }));
    assert.equal(inspected.result.source, 'active_prompt');
    assert.equal(inspected.result.contexts[0].summary, '1 selected feature(s) in layer roads');
    assert.deepEqual(inspected.result.contexts[0].features, [{ id: 'road-1', properties: { name: '一号路' } }]);

    const requestPromise = request(`${base}/api/internal/geo/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, token: 'geo-token', visualizationId: 'route_map', sceneRevision: 1, mode: 'viewport', prompt: '请确认当前视野' }),
    });
    let requestId = '';
    const requestsRoot = path.join(cwd, '.tau', 'conversations', session.conversationId, 'geo-interactions', 'requests');
    for (let attempt = 0; attempt < 50 && !requestId; attempt += 1) {
      if (fs.existsSync(requestsRoot)) requestId = fs.readdirSync(requestsRoot)[0] || '';
      if (!requestId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(requestId, /^georeq_/);
    const { selection: _selection, ...contextWithoutSelection } = context;
    const responseContext = { ...contextWithoutSelection, contextId: `geoctx_${'b'.repeat(16)}`, mode: 'viewport' };
    const responded = await jsonBody(await request(`${base}/api/conversations/${session.conversationId}/geo-interactions/${requestId}/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'submitted', context: responseContext }),
    }));
    assert.equal(responded.response.status, 'submitted');
    const requestResult = await jsonBody(await requestPromise);
    assert.equal(requestResult.result.response.status, 'submitted');
    assert.equal(requestResult.result.context.contextId, responseContext.contextId);
  }

  // serves Registry-backed citation resources without exposing arbitrary session files
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-resource-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const report = Buffer.from('# 交通报告\n\n拥堵集中在入口。');
    fs.writeFileSync(path.join(cwd, 'report.md'), report);
    fs.writeFileSync(path.join(cwd, 'secret.txt'), 'not cited');
    const sha256 = crypto.createHash('sha256').update(report).digest('hex');
    const resourceId = `resource:${sha256.slice(0, 24)}`;
    const registry = { protocol: 'pi-citation', version: '3.0', schemaVersion: 2, sessionId: 'tau_citation_owner', sources: [{ sourceVersionId: resourceId, sourceKey: 'session:report.md', title: '交通报告', acquiredAt: '2026-10-16', content: { kind: 'file', scope: 'session', path: 'report.md', mimeType: 'text/markdown', sha256, size: report.length } }], evidence: [{ evidenceId: 'e_report', sourceVersionId: resourceId, locator: { kind: 'document', section: '结论' }, contentKind: 'summary' }] };
    fs.mkdirSync(path.join(cwd, '.tau'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.tau', 'citations.json'), JSON.stringify(registry));
    const owner = fakeSession('tau_citation_owner');
    owner.cwd = cwd;
    const other = fakeSession('tau_citation_other');
    other.cwd = cwd;
    registerSession(owner);
    registerSession(other);
    const url = `${base}/api/conversations/${owner.conversationId}/citation-resources/${encodeURIComponent(resourceId)}/content`;
    const response = await request(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), report.toString());
    assert.equal(response.headers.get('etag'), `"${sha256}"`);
    const head = await request(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(report.length));
    assert.equal(await head.text(), '');
    const download = await request(`${url}?download=1`);
    assert.match(String(download.headers.get('content-disposition')), /^attachment;/);
    assert.equal((await request(`${url}?sha256=${sha256}`)).status, 200);
    const mismatch = await request(`${url}?sha256=${'b'.repeat(64)}`);
    assert.equal(mismatch.status, 409, 'a view pinned to another registry version cannot read current bytes');
    assert.equal(mismatch.headers.get('X-Citation-Error'), 'view-mismatch');
    assert.equal((await jsonBody(mismatch)).code, 'view-mismatch');
    const rewritten = Buffer.from('# 交通报告\n\n入口拥堵已缓解。');
    fs.writeFileSync(path.join(cwd, 'report.md'), rewritten);
    assert.equal((await request(`${url}?sha256=${sha256}`)).status, 409);
    const changedHead = await request(url, { method: 'HEAD' });
    assert.equal(changedHead.status, 409);
    assert.equal(changedHead.headers.get('X-Citation-Error'), 'content-changed');
    assert.equal(await changedHead.text(), '');
    assert.equal((await request(`${url}?download=1`)).status, 409);
    assert.equal((await request(`${base}/api/conversations/${other.conversationId}/citation-resources/${encodeURIComponent(resourceId)}/content`)).status, 409, 'shared citations retain their frozen content version');
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/citation-resources/missing/content`)).status, 404);
    const citations = await jsonBody(await request(`${base}/api/conversations/${owner.conversationId}/citations?limit=1`));
    assert.equal(citations.citations.evidence[0].evidenceId, 'e_report');
    const changedDetail = await jsonBody(await request(`${base}/api/conversations/${owner.conversationId}/citations/evidence/e_report`));
    assert.equal(changedDetail.source.sourceVersionId, resourceId);
    assert.equal(changedDetail.preview.code, 'content-changed');
    const currentUrl = `${base}/api/conversations/${owner.conversationId}/files/raw?${new URLSearchParams({ path: 'report.md' })}`;
    assert.equal((await request(currentUrl, { method: 'HEAD' })).status, 200);
    assert.equal(await (await request(currentUrl)).text(), rewritten.toString());
    const { CitationService } = require('../../bin/citation-service.js');
    const revised = new CitationService().resolve(owner, [{ path: 'report.md', locator: { kind: 'source' }, contentKind: 'source-only' }]);
    const revisedUrl = `${base}/api/conversations/${owner.conversationId}/citation-resources/${revised.sources[0].sourceVersionId}/content`;
    assert.equal(await (await request(`${revisedUrl}?download=1`)).text(), rewritten.toString());
    assert.equal((await request(url)).status, 409, 'registering the revision never rewrites the old citation');
    fs.rmSync(path.join(cwd, 'report.md'));
    const missing = await request(url);
    assert.equal(missing.status, 404);
    assert.equal((await jsonBody(missing)).code, 'missing');
    assert.equal((await request(currentUrl, { method: 'HEAD' })).status, 404);
    fs.writeFileSync(path.join(cwd, 'report.md'), report);
    const detail = await jsonBody(await request(`${base}/api/conversations/${owner.conversationId}/citations/evidence/e_report`));
    assert.equal(detail.preview.kind, 'text');
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/citations/occurrences`, { method: 'POST' })).status, 404);

    // A rejected mixed registration explains how to retry without losing either kind of evidence.
    Object.assign(owner, { resolvedSessionPlan: { modules: [{ id: 'com.transportx.citation' }] } });
    const register = (input: Record<string, unknown>) => request(`${base}/api/internal/citations/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: owner.id, token: 'citation-token', ...input }) });
    const sources = [{ path: 'report.md', locator: { kind: 'source' }, contentKind: 'source-only', deliverable: true }];
    const webUrls = ['https://public.example/report'];
    const mixed = await register({ sources, webUrls });
    assert.equal(mixed.status, 400);
    assert.match((await jsonBody(mixed)).error, /separate calls/);
    const localResponse = await register({ sources });
    assert.equal(localResponse.status, 200);
    const local = await jsonBody(localResponse);
    assert.deepEqual(local.deliverableEvidenceIds, [local.citations.evidence[0].evidenceId]);
    const lookup = t.mock.method(require('node:dns/promises'), 'lookup', async () => [{ address: '1.1.1.1', family: 4 }]);
    const httpsRequest = t.mock.method(require('node:https'), 'request', (_options: unknown, respond: (value: any) => void) => {
      const response = require('node:stream').Readable.from([Buffer.from('<html>public original</html>')]);
      response.headers = { 'content-type': 'text/html' }; response.statusCode = 200;
      const outgoing = new EventEmitter(); outgoing.setTimeout = () => {}; outgoing.end = () => respond(response);
      return outgoing;
    });
    try {
      const webResponse = await register({ webUrls });
      assert.equal(webResponse.status, 200);
      const web = await jsonBody(webResponse);
      assert.equal(web.citations.sources[0].metadata.url, webUrls[0]);
      const registered = (await jsonBody(await request(`${base}/api/conversations/${owner.conversationId}/citations`))).citations;
      for (const evidence of [...local.citations.evidence, ...web.citations.evidence]) assert.ok(registered.evidence.some((item: any) => item.evidenceId === evidence.evidenceId));
    } finally { lookup.mock.restore(); httpsRequest.mock.restore(); }
  }

  // serves session files inline or as downloads with PDF byte ranges
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-file-raw-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const payload = Buffer.from('%PDF-1.7\ntransportx-preview');
    const filePath = path.join(cwd, '课程设计.pdf');
    fs.writeFileSync(filePath, payload);
    const session = fakeSession('tau_file_raw');
    session.cwd = cwd;
    registerSession(session);
    const url = `${base}/api/conversations/${session.conversationId}/files/raw?${new URLSearchParams({ path: filePath })}`;
    const inline = await request(url);
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-type'), 'application/pdf');
    assert.match(String(inline.headers.get('content-disposition')), /^inline;/);
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()), payload);

    const ranged = await request(url, { headers: { Range: 'bytes=5-11' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 5-11/${payload.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), payload.subarray(5, 12));

    const download = await request(`${url}&download=1`);
    assert.match(String(download.headers.get('content-disposition')), /^attachment;/);
    assert.equal((await request(`${base}/api/conversations/${session.conversationId}/files/raw?${new URLSearchParams({ path: path.join(cwd, '..', 'secret.pdf') })}`)).status, 403);
  }

  // reads files within the live-session directory but blocks static traversal
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-files-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const report = path.join(cwd, 'report.md');
    fs.writeFileSync(report, '# Report\n\nTraffic analysis');
    const session = fakeSession('tau_files');
    session.cwd = cwd;
    registerSession(session);
    const content = await jsonBody(await request(`${base}/api/conversations/${session.conversationId}/files/content?path=${encodeURIComponent(report)}`));
    assert.equal(content.content, '# Report\n\nTraffic analysis');
    assert.equal((await request(`${base}/%2e%2e%2fsecret`)).status, 403);
    assert.equal((await request(`${base}/api/health`)).status, 200);
  }

  // normalizes model references before sending Pi set_model commands
  {
    liveManager.sessions.clear();
    const commands: Array<Record<string, unknown>> = [];
    const session = {
      ...fakeSession('tau_set_model'),
      modelSync: new (require('../../bin/model-session-sync.js').SessionModelSync)(),
      send: async (command: Record<string, unknown>) => {
        commands.push(command);
        if (command.type === 'get_commands') return { success: true, data: { commands: [{ name: 'transportx_reload_models', source: 'extension' }] } };
        if (command.type === 'prompt') session.modelSync.consume({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'transportx:model-sync', statusText: JSON.stringify({ token: String(command.message).split(' ')[1] }) });
        return { success: true, data: { model: { provider: 'deepseek', id: 'deepseek-v4-flash' } } };
      },
    };
    registerSession(session);

    const response = await handleRpcCommand({ type: 'set_model', sessionId: session.id, model: 'deepseek/deepseek-v4-flash' });
    assert.equal(response.success, true);
    assert.deepEqual(commands.map((command) => command.type), ['get_commands', 'prompt', 'set_model']);
    assert.equal(commands[2].provider, 'deepseek');
    assert.equal(commands[2].modelId, 'deepseek-v4-flash');
  }

  // reliable prompt command IDs are acknowledged and executed once
  {
    liveManager.sessions.clear();
    let calls = 0;
    const session = {
      ...fakeSession('tau_reliable_prompt'),
      send: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { success: true };
      },
    };
    registerSession(session);
    const command = { type: 'prompt', sessionId: session.id, message: '一次即可', clientCommandId: 'client-command-one' };
    const [first, duplicate] = await Promise.all([handleRpcCommand(command), handleRpcCommand(command)]);
    assert.equal(calls, 1);
    assert.equal(first.success, true);
    assert.equal(first.delivery, 'accepted');
    assert.equal(first.clientCommandId, 'client-command-one');
    assert.deepEqual(duplicate, first);
  }

  // Pi RPC prompt timeout is reported instead of optimistic success
  {
    liveManager.sessions.clear();
    const session = {
      ...fakeSession('tau_prompt_timeout'),
      send: async () => { throw new Error('RPC command timed out: prompt'); },
    };
    registerSession(session);
    const response = await handleRpcCommand({ type: 'prompt', sessionId: session.id, message: '不要假成功', clientCommandId: 'client-command-timeout' });
    assert.equal(response.success, false);
    assert.match(String(response.error), /timed out/);
  }

  // Pi RPC extension UI responses acknowledge after writing because Pi sends no response envelope
  {
    liveManager.sessions.clear();
    const manager = new (require('../../bin/sessions.js').LiveSessionManager)();
    const session = new PiRpcSession(manager, { conversationId: 'conv_00000000-0000-4000-8000-000000000001', cwd: '/tmp/pi-extension-ui' });
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
  }

  // PDF render and download cache enforce concurrency, byte and entry capacity
  {
    liveManager.sessions.clear();
    let size = 1;
    let blocked = true;
    const renders: Array<() => void> = [];
    const router = createApiRouter({
      readBody: async () => ({ title: 'report', html: '<p>report</p>' }),
      renderReportPdf: async () => { if (blocked) await new Promise<void>((resolve) => renders.push(resolve)); return Buffer.alloc(size); },
      json: (res: any, status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
      errorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
      errorStatus: (error: any) => error.status || 400,
    } as any);
    const reportServer = require('node:http').createServer((req: any, res: any) => router.dispatch(req, res, new URL(req.url, 'http://127.0.0.1')));
    await new Promise<void>((resolve) => reportServer.listen(0, '127.0.0.1', resolve));
    t.after(() => reportServer.close());
    const origin = `http://127.0.0.1:${reportServer.address().port}`;
    const post = () => request(`${origin}/api/reports/pdf/download`, { method: 'POST' });
    const pending = [post(), post()];
    while (renders.length < 2) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await post()).status, 503);
    blocked = false;
    renders.forEach((release) => release());
    await Promise.all(pending);
    const urls: string[] = [];
    for (let index = 0; index < 9; index++) urls.push((await jsonBody(await post())).url);
    assert.equal((await request(`${origin}${urls[0]}`)).status, 404);
    const consumed = await request(`${origin}${urls[8]}`);
    assert.equal(consumed.status, 200);
    await consumed.arrayBuffer();
    assert.equal((await request(`${origin}${urls[8]}`)).status, 404);
    size = 32 * 1024 * 1024;
    const first = (await jsonBody(await post())).url;
    await post();
    size = 1;
    await post();
    assert.equal((await request(`${origin}${first}`)).status, 404);
    size = 32 * 1024 * 1024 + 1;
    assert.equal((await post()).status, 413);
  }

  // history symlinks escaping the root are refused and SVG routes share sandbox headers
  {
    liveManager.sessions.clear();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-history-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const file = path.join(outside, 'secret.jsonl');
    fs.writeFileSync(file, '{"type":"session","cwd":"/tmp"}\n');
    const linked = path.join(SESSIONS_DIR, 'outside.jsonl');
    await testSymlink(t, 'history symlink cannot expose files outside the root', file, linked, async () => {
      const rejected = await request(`${base}/api/session-history?filePath=${encodeURIComponent(linked)}`);
      assert.notEqual(rejected.status, 200);
      assert.notEqual((await request(`${base}/api/sessions/./outside.jsonl`)).status, 200);
      assert.equal((await rejected.text()).includes('"cwd":"/tmp"'), false);
    });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-svg-policy-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    fs.writeFileSync(path.join(cwd, 'active.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>window.svgExecuted=true</script></svg>');
    const session = fakeSession('svg-policy');
    session.cwd = cwd;
    registerSession(session);
    for (const route of ['preview', 'raw']) {
      const response = await request(`${base}/api/conversations/${session.conversationId}/files/${route}?path=active.svg`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy') || '', /sandbox; default-src 'none'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    }
  }

  // RPC rejects invalid envelopes and shared fields before invoking effects
  {
    liveManager.sessions.clear();
    for (const body of [null, [], { type: 7 }, { type: 'set_session_name', name: 7 }, { type: 'prompt', sessionId: 'missing', message: 'x', attachmentIds: [7] }, { type: 'set_auto_compaction', enabled: 'false' }]) {
      const response = await request(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      assert.match((await jsonBody(response)).error, /Invalid RPC field/);
    }
    const { parseRpcCommand } = require('../../bin/rpc-command-input.js');
    const extension = { type: 'extension_ui_response', id: 'id', sessionId: 'session', value: { custom: true } };
    assert.equal(parseRpcCommand(extension), extension);
  }
});
