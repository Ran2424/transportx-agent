const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function geoContext(mode: 'feature' | 'rectangle' | 'viewport' = 'feature', suffix = 'a') {
  const session: any = {
    version: 1,
    contextId: `geoctx_${suffix.repeat(16)}`,
    visualizationId: 'traffic_map',
    sceneRevision: 1,
    mode,
    createdAt: '2026-09-02T01:00:00.000Z',
    view: { center: [121.45, 31.2], zoom: 12, bounds: [121.4, 31.1, 121.5, 31.3], bearing: 0, pitch: 0 },
    visibleLayerIds: ['roads'],
    ...(mode === 'feature' ? { selection: { layerId: 'roads', featureIds: ['road-1', 'road-2'] } } : {}),
    ...(mode === 'rectangle' ? { geometry: { type: 'Polygon', coordinates: [[[121.4, 31.1], [121.5, 31.1], [121.5, 31.3], [121.4, 31.3], [121.4, 31.1]]] } } : {}),
    summary: mode,
  };
  return session;
}

function makeSession(cwd: string, options: { geo?: boolean; inline?: boolean } = {}) {
  const source = options.inline
    ? { id: 'road_source', type: 'geojson-inline', data: { type: 'FeatureCollection', features: [] }, idField: 'road_id' }
    : { id: 'road_source', type: 'geojson-resource', resourceId: 'geo_aaaaaaaaaaaaaaaaaaaaaaaa', idField: 'road_id' };
  const envelope = {
    protocol: 'pi-visualization', version: '1.0', kind: 'geo', visualizationId: 'traffic_map', revision: 1, operation: 'replace',
    scene: {
      view: { mode: 'bounds', bounds: [121.4, 31.1, 121.5, 31.3] }, basemap: { id: 'light' }, sources: [source],
      layers: [{ id: 'roads', sourceId: 'road_source', type: 'line', encoding: { color: { mode: 'constant', value: '#2563eb' } }, popup: { fields: [{ field: 'name', label: '名称' }] } }],
      metadata: { title: '道路' },
    },
    summary: { title: '道路' }, generatedAt: '2026-09-02T00:00:00.000Z',
  };
  const session: any = {
    id: `session_${path.basename(cwd)}`,
    cwd,
    entries: [{ type: 'message', message: { role: 'toolResult', details: { visualization: envelope } } }],
    resolvedSessionPlan: { modules: options.geo === false ? [] : [{ id: 'com.transportx.geo' }] },
    manager: { broadcast() {}, broadcastUpdated() {} },
    activeGeoContextIds: [],
    envelope,
  };
  return session;
}

function writeResource(cwd: string) {
  const resourceId = 'geo_aaaaaaaaaaaaaaaaaaaaaaaa';
  const dir = path.join(cwd, '.tau', 'geo-resources', resourceId);
  const body = JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { road_id: 'road-1', name: '一号路', secret: 'hidden' }, geometry: { type: 'LineString', coordinates: [[121.4, 31.1], [121.45, 31.2]] } },
    { type: 'Feature', properties: { road_id: 'road-2', name: '二号路', secret: 'hidden' }, geometry: { type: 'LineString', coordinates: [[121.45, 31.2], [121.5, 31.3]] } },
  ] });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'data.geojson'), body);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ resourceId, sha256: crypto.createHash('sha256').update(body).digest('hex'), bytes: Buffer.byteLength(body), featureCount: 2 }));
}

test('Geo Host stays silent when the Module is absent', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-none-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { GeoInteractionService } = require('../bin/geo-interaction-service.js');
  const service = new GeoInteractionService();
  const session = makeSession(cwd, { geo: false });
  assert.equal(service.snapshot(session), undefined);
  assert.throws(() => service.createContext(session, geoContext()), /unavailable/);
  assert.equal(fs.existsSync(path.join(cwd, '.tau', 'geo-interactions')), false);
});

test('Feature Contexts require verified resource ids and inspect only explicit or active ids', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-context-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  writeResource(cwd);
  const { GeoInteractionService } = require('../bin/geo-interaction-service.js');
  const service = new GeoInteractionService();
  const session = makeSession(cwd);
  const created = service.createContext(session, geoContext());
  assert.equal(created.provenance?.idStrategy.kind, 'id-field');
  const explicit = service.inspect(session, { contextIds: [created.context.contextId], includeProvenance: true });
  assert.equal(explicit.status, 'ok');
  if (explicit.status !== 'ok') throw new Error('explicit Geo Context inspection failed');
  assert.equal(explicit.source, 'explicit');
  assert.equal(explicit.contexts[0].summary, '2 selected feature(s) in layer roads');
  assert.deepEqual(explicit.contexts[0].features, [{ id: 'road-1', properties: { name: '一号路' } }, { id: 'road-2', properties: { name: '二号路' } }]);
  assert.deepEqual(service.inspect(session, {}), { status: 'no_geo_context' });
  session.activeGeoContextIds = [created.context.contextId];
  assert.equal(service.inspect(session, {}).source, 'active_prompt');

  const inline = makeSession(cwd, { inline: true });
  inline.id = session.id;
  assert.throws(() => service.createContext(inline, { ...geoContext(), contextId: `geoctx_${'b'.repeat(16)}` }), /resource-backed/);
  assert.throws(() => service.validateMessageContexts(session, Array.from({ length: 9 }, () => created.context.contextId)), /at most 8/);
});

test('Geo Host rejects missing maps without creating interaction state and never rebinds by message text', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-no-map-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { GeoInteractionService, applyGeoMessageRefs } = require('../bin/geo-interaction-service.js');
  const service = new GeoInteractionService();
  const session = makeSession(cwd);
  session.entries = [];
  await assert.rejects(() => service.request(session, { visualizationId: 'missing', sceneRevision: 1, mode: 'viewport', prompt: '选择视野' }), /not available/);
  assert.equal(fs.existsSync(path.join(cwd, '.tau', 'geo-interactions')), false);
  const contextIds = [`geoctx_${'f'.repeat(16)}`];
  const entries = [{ message: { role: 'user', content: '相同文字', timestamp: 2 } }];
  assert.deepEqual(applyGeoMessageRefs(entries, [{ text: '相同文字', timestamp: 1, contextIds }]), entries);
});

test('Geo screenshots are validated and saved directly in the session directory', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-screenshot-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { GeoInteractionService } = require('../bin/geo-interaction-service.js');
  const service = new GeoInteractionService();
  const session = makeSession(cwd);
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6sAAAAASUVORK5CYII=';
  const first = service.saveScreenshot(session, { visualizationId: 'traffic_map', sceneRevision: 1, dataUrl });
  const second = service.saveScreenshot(session, { visualizationId: 'traffic_map', sceneRevision: 1, dataUrl });
  assert.equal(path.dirname(first.path), cwd);
  assert.match(first.filename, /^map-screenshot-\d{8}-\d{6}\.png$/);
  assert.notEqual(second.filename, first.filename);
  assert.equal(fs.readFileSync(first.path).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.throws(() => service.saveScreenshot(session, { visualizationId: 'traffic_map', sceneRevision: 1, dataUrl: 'data:image/png;base64,bm90LXBuZw==' }), /valid PNG/);
  assert.throws(() => service.saveScreenshot(session, { visualizationId: 'traffic_map', sceneRevision: 2, dataUrl }), /revision changed/);
});

test('Geo requests submit once, persist terminal state and restore through snapshots', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-request-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  writeResource(cwd);
  const { GeoInteractionService } = require('../bin/geo-interaction-service.js');
  const service = new GeoInteractionService();
  const session = makeSession(cwd);
  const pending = service.request(session, { visualizationId: 'traffic_map', sceneRevision: 1, mode: 'rectangle', prompt: '框选范围', timeoutSeconds: 600 });
  const request = service.snapshot(session)?.waitingRequest;
  assert.equal(request?.mode, 'rectangle');
  await assert.rejects(() => service.request(session, { visualizationId: 'traffic_map', sceneRevision: 1, mode: 'viewport', prompt: '选择视野' }), /already has/);
  const submitted = await service.respond(session, request!.requestId, { status: 'submitted', context: geoContext('rectangle', 'c') });
  assert.equal(submitted.response.status, 'submitted');
  assert.equal((await pending).context?.mode, 'rectangle');
  assert.equal(service.snapshot(session)?.waitingRequest, undefined);
  const duplicate = await service.respond(session, request!.requestId, { status: 'submitted', context: geoContext('rectangle', 'd') });
  assert.equal(duplicate.response.contextId, submitted.response.contextId);
  assert.equal(fs.existsSync(path.join(cwd, '.tau', 'geo-interactions', 'contexts', `geoctx_${'d'.repeat(16)}`)), false);
});

test('cancel, abort and revision invalidation resolve their waiting tools distinctly', async (t: any) => {
  const { GeoInteractionService } = require('../bin/geo-interaction-service.js');
  for (const terminal of ['cancelled', 'aborted', 'invalidated']) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `tau-geo-${terminal}-`));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    writeResource(cwd);
    const service = new GeoInteractionService();
    const session = makeSession(cwd);
    const pending = service.request(session, { visualizationId: 'traffic_map', sceneRevision: 1, mode: 'viewport', prompt: '选择视野' });
    const request = service.waitingRequest(session)!;
    if (terminal === 'cancelled') await service.respond(session, request.requestId, { status: 'cancelled' });
    if (terminal === 'aborted') service.abortSession(session, 'session_closed');
    if (terminal === 'invalidated') service.invalidateForEnvelope(session, { ...session.envelope, revision: 2 } as any);
    const result = await pending;
    assert.equal(result.response.status, terminal);
  }
});

test('expired persisted requests receive the timeout terminal state', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-expired-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  writeResource(cwd);
  const { GeoInteractionService } = require('../bin/geo-interaction-service.js');
  const service = new GeoInteractionService();
  const session = makeSession(cwd);
  const requestId = `georeq_${'e'.repeat(16)}`;
  const dir = path.join(cwd, '.tau', 'geo-interactions', 'requests', requestId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ version: 1, requestId, sessionId: session.id, visualizationId: 'traffic_map', sceneRevision: 1, mode: 'viewport', prompt: '选择', required: false, timeoutSeconds: 30, status: 'waiting', createdAt: '2026-09-02T00:00:00.000Z', expiresAt: '2026-09-02T00:00:30.000Z' }));
  assert.equal(service.waitingRequest(session), null);
  const response = JSON.parse(fs.readFileSync(path.join(dir, 'response.json'), 'utf8'));
  assert.deepEqual({ status: response.status, reason: response.reason }, { status: 'expired', reason: 'timeout' });
});

test('Feature request becomes invalidated when its resource changes before submit', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-resource-change-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  writeResource(cwd);
  const { GeoInteractionService } = require('../bin/geo-interaction-service.js');
  const service = new GeoInteractionService();
  const session = makeSession(cwd);
  const pending = service.request(session, { visualizationId: 'traffic_map', sceneRevision: 1, mode: 'feature', prompt: '选择道路', targetLayerIds: ['roads'] });
  const request = service.waitingRequest(session)!;
  fs.appendFileSync(path.join(cwd, '.tau', 'geo-resources', 'geo_aaaaaaaaaaaaaaaaaaaaaaaa', 'data.geojson'), ' ');
  const terminal = await service.respond(session, request.requestId, { status: 'submitted', context: { ...geoContext('feature', 'g'), summary: 'client supplied' } });
  assert.deepEqual({ status: terminal.response.status, reason: terminal.response.reason }, { status: 'invalidated', reason: 'resource_changed' });
  assert.equal((await pending).response.status, 'invalidated');
});
