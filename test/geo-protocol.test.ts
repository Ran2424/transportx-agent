const { test } = require('node:test');
const assert = require('node:assert/strict');

function scene(overrides: Record<string, unknown> = {}) {
  return {
    view: { mode: 'camera', center: [121.47, 31.23], zoom: 10 },
    basemap: { id: 'none' },
    sources: [{
      id: 'places', type: 'geojson-inline',
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, properties: { name: 'Shanghai' }, geometry: { type: 'Point', coordinates: [121.47, 31.23] } }] },
    }],
    layers: [{
      id: 'points', sourceId: 'places', type: 'circle',
      encoding: { color: { mode: 'constant', value: '#2563eb' }, radius: { mode: 'constant', value: 6 } },
    }],
    metadata: { title: 'Places' },
    ...overrides,
  };
}

function envelope(revision: number, value: ReturnType<typeof scene> | null) {
  return {
    protocol: 'pi-visualization', version: '1.0', kind: 'geo', visualizationId: 'places_map', revision,
    operation: value ? 'replace' : 'clear', scene: value, summary: { title: 'Places' }, generatedAt: `2026-01-01T00:00:0${revision}.000Z`,
  };
}

test('GeoScene parser accepts the declarative subset and rejects unsafe or oversized input', async () => {
  const modulePath = '../src/public/visualization/geo/protocol.ts';
  const { parseGeoScene } = await import(modulePath);
  assert.equal(parseGeoScene(scene()).ok, true);
  const unsafe = scene({ layers: [{ id: 'points', sourceId: 'places', type: 'circle', encoding: { color: { mode: 'constant', value: 'url(https://example.com/x)' } } }] });
  const unsafeResult = parseGeoScene(unsafe);
  assert.equal(unsafeResult.ok, false);
  assert.equal(unsafeResult.issues[0].path, 'scene.layers[0].encoding.color');
  const features = Array.from({ length: 1001 }, (_, id) => ({ type: 'Feature', id, properties: {}, geometry: { type: 'Point', coordinates: [121, 31] } }));
  const oversizedResult = parseGeoScene(scene({ sources: [{ id: 'places', type: 'geojson-inline', data: { type: 'FeatureCollection', features } }] }));
  assert.equal(oversizedResult.ok, false);
  assert.equal(oversizedResult.issues[0].path, 'scene.sources[0].data.features');
  const selectionResult = parseGeoScene(scene({ selection: [{ sourceId: 'missing', featureIds: [1] }] }));
  assert.equal(selectionResult.ok, false);
  assert.equal(selectionResult.issues[0].path, 'scene.selection[0].sourceId');
});

test('GeoScene parser accepts the styled light-basemap point and label composition', async () => {
  const modulePath = '../src/public/visualization/geo/protocol.ts';
  const { parseGeoScene } = await import(modulePath);
  const styled = scene({
    basemap: { id: 'light' },
    sources: [{
      id: 'places', type: 'geojson-inline', idField: 'station_id',
      data: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: { station_id: 's1', name: '上海体育馆' }, geometry: { type: 'Point', coordinates: [121.433, 31.183] } }],
      },
    }],
    layers: [
      {
        id: 'stations', sourceId: 'places', type: 'circle', title: '地铁站点',
        encoding: { color: { mode: 'constant', value: '#ffffff' }, radius: { mode: 'constant', value: 5 }, strokeColor: { mode: 'constant', value: '#172033' } },
      },
      {
        id: 'station_labels', sourceId: 'places', type: 'label', title: '站点名称',
        encoding: { textField: { mode: 'constant', value: 'name' }, color: { mode: 'constant', value: '#172033' }, haloColor: { mode: 'constant', value: '#ffffff' } },
      },
    ],
  });
  assert.equal(parseGeoScene(styled).ok, true);
});

test('visualization store keeps clear tombstones and ignores stale or duplicate revisions', async () => {
  const modulePath = '../src/public/visualization/session-visualization-store.ts';
  const { SessionVisualizationStore } = await import(modulePath);
  const store = new SessionVisualizationStore();
  const first = envelope(1, scene());
  const cleared = envelope(2, null);
  assert.equal(store.accept('session', first), true);
  assert.equal(store.accept('session', cleared), true);
  assert.deepEqual(store.list('session'), []);
  assert.equal(store.accept('session', first), false);
  assert.equal(store.accept('session', cleared), false);
  assert.equal(store.get('session', 'places_map'), null);
});
