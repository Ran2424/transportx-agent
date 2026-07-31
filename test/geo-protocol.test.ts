const { test } = require('node:test');
const assert = require('node:assert/strict');

function scene(overrides: Record<string, unknown> = {}) {
  return { view: { mode: 'camera', center: [121.47, 31.23], zoom: 10 }, basemap: { id: 'none' }, sources: [{ id: 'places', type: 'geojson-inline', data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, properties: { name: 'Shanghai' }, geometry: { type: 'Point', coordinates: [121.47, 31.23] } }] } }], layers: [{ id: 'points', sourceId: 'places', type: 'circle', encoding: { color: { mode: 'constant', value: '#2563eb' }, radius: { mode: 'constant', value: 6 } } }], metadata: { title: 'Places' }, ...overrides };
}

test('GeoScene parser accepts the declarative subset and rejects unsafe or oversized input', async () => {
  const { parseGeoScene } = await import('../src/contracts/geo.ts');
  assert.equal(parseGeoScene(scene()).ok, true);
  const unsafe = scene({ layers: [{ id: 'points', sourceId: 'places', type: 'circle', encoding: { color: { mode: 'constant', value: 'url(https://example.com/x)' } } }] });
  assert.equal(parseGeoScene(unsafe).ok, false);
  const features = Array.from({ length: 1001 }, (_, id) => ({ type: 'Feature', id, properties: {}, geometry: { type: 'Point', coordinates: [121, 31] } }));
  assert.equal(parseGeoScene(scene({ sources: [{ id: 'places', type: 'geojson-inline', data: { type: 'FeatureCollection', features } }] })).ok, false);
});

test('GeoScene parser accepts styled light-basemap points and labels', async () => {
  const { parseGeoScene } = await import('../src/contracts/geo.ts');
  assert.equal(parseGeoScene(scene({ basemap: { id: 'light' }, sources: [{ id: 'places', type: 'geojson-inline', idField: 'station_id', data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { station_id: 's1', name: '上海体育馆' }, geometry: { type: 'Point', coordinates: [121.433, 31.183] } }] } }], layers: [{ id: 'stations', sourceId: 'places', type: 'circle', title: '地铁站点', encoding: { color: { mode: 'constant', value: '#ffffff' }, radius: { mode: 'constant', value: 5 }, strokeColor: { mode: 'constant', value: '#172033' } } }, { id: 'station_labels', sourceId: 'places', type: 'label', title: '站点名称', encoding: { textField: { mode: 'constant', value: 'name' }, color: { mode: 'constant', value: '#172033' }, haloColor: { mode: 'constant', value: '#ffffff' } } }] })).ok, true);
});

test('GeoScene parser accepts point chart layers and enforces chart semantics', async () => {
  const { parseGeoScene } = await import('../src/contracts/geo.ts');
  const chartLayer = {
    id: 'station_flow',
    sourceId: 'places',
    type: 'chart',
    encoding: {},
    chart: {
      type: 'pie',
      valueFields: ['in_flow', 'out_flow'],
      colors: ['#34c79b', '#8268bd'],
      size: 40,
      labelField: 'total_flow',
      labelFormat: 'integer',
    },
  };
  assert.equal(parseGeoScene(scene({ layers: [chartLayer] })).ok, true);
  assert.equal(parseGeoScene(scene({ layers: [{ ...chartLayer, chart: { ...chartLayer.chart, type: 'bar', valueFields: ['total_flow'], colors: ['#34c79b'] } }] })).ok, false);
  assert.equal(parseGeoScene(scene({ layers: [{ ...chartLayer, chart: { ...chartLayer.chart, type: 'pie', valueFields: ['total_flow'], colors: ['#34c79b'] } }] })).ok, false);
});
