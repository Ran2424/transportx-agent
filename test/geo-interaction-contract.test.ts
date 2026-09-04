const { test } = require('node:test');
const assert = require('node:assert/strict');

function base(mode: 'feature' | 'point' | 'rectangle' | 'viewport') {
  return {
    version: 1,
    contextId: `geoctx_${'a'.repeat(16)}`,
    visualizationId: 'traffic_map',
    sceneRevision: 2,
    mode,
    createdAt: '2026-09-02T01:00:00.000Z',
    view: { center: [121.45, 31.2], zoom: 12, bounds: [121.4, 31.1, 121.5, 31.3], bearing: 0, pitch: 0 },
    visibleLayerIds: ['roads'],
    summary: '测试空间输入',
  };
}

test('Geo Context v1 accepts the four fixed input modes', async () => {
  const contract = await import('../src/contracts/geo.ts');
  const values = [
    { ...base('feature'), selection: { layerId: 'roads', featureIds: ['r1', 2] } },
    { ...base('point'), geometry: { type: 'Point', coordinates: [121.45, 31.2] } },
    { ...base('rectangle'), geometry: { type: 'Polygon', coordinates: [[[121.4, 31.1], [121.5, 31.1], [121.5, 31.3], [121.4, 31.3], [121.4, 31.1]]] } },
    base('viewport'),
  ];
  for (const value of values) assert.equal(contract.parseGeoClientContextStructured(value).ok, true, value.mode);
});

test('Geo Context v1 rejects mixed fields, invalid coordinates, duplicates and limits', async () => {
  const contract = await import('../src/contracts/geo.ts');
  assert.equal(contract.parseGeoClientContextStructured({ ...base('feature'), selection: { layerId: 'roads', featureIds: ['r1'] }, geometry: { type: 'Point', coordinates: [1, 1] } }).ok, false);
  assert.equal(contract.parseGeoClientContextStructured({ ...base('point'), geometry: { type: 'Point', coordinates: [181, 1] } }).ok, false);
  assert.equal(contract.parseGeoClientContextStructured({ ...base('rectangle'), geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [1, 2], [0, 2], [0, 0]]] } }).ok, false);
  assert.equal(contract.parseGeoClientContextStructured({ ...base('feature'), selection: { layerId: 'roads', featureIds: ['same', 'same'] } }).ok, false);
  assert.equal(contract.parseGeoClientContextStructured({ ...base('viewport'), visibleLayerIds: Array.from({ length: 65 }, (_, index) => `l${index}`) }).ok, false);
  assert.equal(contract.parseGeoClientContextStructured({ ...base('feature'), selection: { layerId: 'roads', featureIds: Array.from({ length: 1001 }, (_, index) => index) } }).ok, false);
  assert.equal(contract.parseGeoClientContextStructured({ ...base('viewport'), mode: 'polygon' }).ok, false);
});

test('Geo request and response contracts enforce feature-only fields and terminal reasons', async () => {
  const contract = await import('../src/contracts/geo.ts');
  const request = {
    version: 1,
    requestId: `georeq_${'b'.repeat(16)}`,
    sessionId: 'session-1',
    visualizationId: 'traffic_map',
    sceneRevision: 2,
    mode: 'feature',
    prompt: '请选择道路',
    required: true,
    targetLayerIds: ['roads'],
    maxFeatures: 2,
    timeoutSeconds: 600,
    status: 'waiting',
    createdAt: '2026-09-02T01:00:00.000Z',
    expiresAt: '2026-09-02T01:10:00.000Z',
  };
  assert.equal(contract.parseGeoInteractionRequestStructured(request).ok, true);
  assert.equal(contract.parseGeoInteractionRequestStructured({ ...request, mode: 'rectangle', targetLayerIds: ['roads'] }).ok, false);
  assert.equal(contract.parseGeoInteractionRequestStructured({ ...request, timeoutSeconds: 29 }).ok, false);

  const terminal = [
    { status: 'submitted', contextId: `geoctx_${'c'.repeat(16)}` },
    { status: 'cancelled', reason: 'user_cancelled' },
    { status: 'expired', reason: 'timeout' },
    { status: 'aborted', reason: 'session_closed' },
    { status: 'invalidated', reason: 'scene_revision_changed' },
  ];
  for (const item of terminal) {
    assert.equal(contract.parseGeoInteractionResponseStructured({ version: 1, requestId: request.requestId, completedAt: '2026-09-02T01:01:00.000Z', ...item }).ok, true, item.status);
  }
  assert.equal(contract.parseGeoInteractionResponseStructured({ version: 1, requestId: request.requestId, completedAt: '2026-09-02T01:01:00.000Z', status: 'expired', reason: 'user_cancelled' }).ok, false);
});

test('Session Snapshot validates and preserves waiting Geo interaction state', async () => {
  const { parseSessionSnapshot } = await import('../src/contracts/session.ts');
  const request = { version: 1, requestId: `georeq_${'d'.repeat(16)}`, sessionId: 'session-1', visualizationId: 'traffic_map', sceneRevision: 1, mode: 'viewport', prompt: '确认视野', required: false, timeoutSeconds: 600, status: 'waiting', createdAt: '2026-09-02T01:00:00.000Z', expiresAt: '2026-09-02T01:10:00.000Z' };
  const parsed = parseSessionSnapshot({ schemaVersion: 1, entries: [], geoInteraction: { contextCount: 2, waitingRequest: request } });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.geoInteraction?.waitingRequest?.requestId, request.requestId);
  assert.equal(parseSessionSnapshot({ schemaVersion: 1, entries: [], geoInteraction: { contextCount: -1 } }).ok, false);
});
