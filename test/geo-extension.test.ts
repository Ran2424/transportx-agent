const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

import type { TestContext } from 'node:test';

type RegisteredTool = {
  name: string;
  execute(toolCallId: string, params: Record<string, any>, signal: AbortSignal, onUpdate: undefined, ctx: Record<string, any>): Promise<any>;
};

async function loadExtension() {
  const modulePath = '../extensions/pi-geo-visualization/index.ts';
  const extension = (await import(modulePath)).default;
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Function>();
  extension({
    registerTool(tool: RegisteredTool) { tools.set(tool.name, tool); },
    on(name: string, handler: Function) { handlers.set(name, handler); },
  });
  return { tools, handlers };
}

function pointScene(source: Record<string, unknown>) {
  return {
    view: { mode: 'bounds', bounds: [120, 30, 122, 32], padding: 24 },
    basemap: { id: 'none' },
    sources: [source],
    layers: [{
      id: 'places', sourceId: 'places_source', type: 'circle', title: 'Places',
      encoding: {
        color: { mode: 'constant', value: '#2563eb' },
        radius: { mode: 'constant', value: 6 },
      },
      popup: { fields: [{ field: 'name', label: 'Name' }] },
    }],
    metadata: { title: 'Places map' },
  };
}

test('Pi GIS extension registers publishing and presentation tools', async () => {
  const { tools, handlers } = await loadExtension();
  assert.deepEqual(Array.from(tools.keys()).sort(), ['present_visualization', 'publish_geodata']);
  assert.equal(typeof handlers.get('session_start'), 'function');
  assert.equal(typeof handlers.get('session_tree'), 'function');
});

test('present_visualization returns a validated revisioned scene snapshot', async () => {
  const { tools } = await loadExtension();
  const present = tools.get('present_visualization')!;
  const scene = pointScene({
    id: 'places_source', type: 'geojson-inline',
    data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', id: 1, properties: { name: 'Shanghai' }, geometry: { type: 'Point', coordinates: [121.47, 31.23] } }],
    },
  });
  const first = await present.execute('call_1', { visualizationId: 'city_map', operation: 'replace', scene }, new AbortController().signal, undefined, { cwd: process.cwd() });
  assert.equal(first.details.visualization.revision, 1);
  assert.equal(first.details.visualization.scene.metadata.title, 'Places map');
  const focused = await present.execute('call_2', {
    visualizationId: 'city_map', operation: 'focus', view: { mode: 'camera', center: [121.47, 31.23], zoom: 11 },
  }, new AbortController().signal, undefined, { cwd: process.cwd() });
  assert.equal(focused.details.visualization.revision, 2);
  assert.deepEqual(focused.details.visualization.scene.view, { mode: 'camera', center: [121.47, 31.23], zoom: 11 });
  const cleared = await present.execute('call_3', {
    visualizationId: 'city_map', operation: 'clear',
  }, new AbortController().signal, undefined, { cwd: process.cwd() });
  assert.equal(cleared.details.visualization.revision, 3);
  const replaced = await present.execute('call_4', {
    visualizationId: 'city_map', operation: 'replace', scene,
  }, new AbortController().signal, undefined, { cwd: process.cwd() });
  assert.equal(replaced.details.visualization.revision, 4, 'clear must retain a revision tombstone');
});

test('publish_geodata creates an immutable session resource consumable by a scene', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-extension-geo-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const geojson = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { id: 'p1', name: 'Point' }, geometry: { type: 'Point', coordinates: [121.5, 31.2] } }],
  };
  fs.writeFileSync(path.join(cwd, 'points.geojson'), JSON.stringify(geojson));
  const { tools } = await loadExtension();
  const publish = tools.get('publish_geodata')!;
  const published = await publish.execute('call_publish', { path: 'points.geojson', title: 'Points', idField: 'id' }, new AbortController().signal, undefined, { cwd });
  const resource = published.details.resource;
  assert.match(resource.resourceId, /^geo_[a-f0-9]{24}$/);
  assert.equal(resource.featureCount, 1);
  assert.equal(fs.existsSync(path.join(cwd, '.tau', 'geo-resources', resource.resourceId, 'data.geojson')), true);

  const present = tools.get('present_visualization')!;
  const result = await present.execute('call_present', {
    visualizationId: 'resource_map',
    operation: 'replace',
    scene: pointScene({ id: 'places_source', type: 'geojson-resource', resourceId: resource.resourceId, idField: 'id' }),
  }, new AbortController().signal, undefined, { cwd });
  assert.equal(result.details.visualization.scene.sources[0].resourceId, resource.resourceId);
});

test('present_visualization rejects invalid engine-shaped input', async () => {
  const { tools } = await loadExtension();
  const present = tools.get('present_visualization')!;
  await assert.rejects(() => present.execute('call_bad', {
    visualizationId: 'bad_map', operation: 'replace',
    scene: {
      ...pointScene({ id: 'places_source', type: 'geojson-inline', data: { type: 'FeatureCollection', features: [] } }),
      layers: [{ id: 'bad', sourceId: 'places_source', type: 'circle', encoding: { paint: { mode: 'constant', value: 'map.addLayer(...)' } } }],
    },
  }, new AbortController().signal, undefined, { cwd: process.cwd() }), /Invalid GeoScene/);
});
