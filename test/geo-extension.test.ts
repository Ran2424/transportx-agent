const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Value } = require('typebox/value');

import type { TestContext } from 'node:test';

type RegisteredTool = {
  name: string;
  parameters?: { type?: string; properties?: Record<string, unknown>; required?: string[]; anyOf?: unknown[] };
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

async function publishPoints(tools: Map<string, RegisteredTool>, cwd: string) {
  const geojson = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: { id: 'p1', name: 'Shanghai', count: 10 }, geometry: { type: 'Point', coordinates: [121.47, 31.23] } }],
  };
  fs.writeFileSync(path.join(cwd, 'points.geojson'), JSON.stringify(geojson));
  return tools.get('publish_geodata')!.execute(
    'call_publish',
    { path: 'points.geojson', title: 'Points', idField: 'id' },
    new AbortController().signal,
    undefined,
    { cwd },
  );
}

test('Pi GIS extension registers publishing and presentation tools', async () => {
  const { tools, handlers } = await loadExtension();
  assert.deepEqual(Array.from(tools.keys()).sort(), ['present_visualization', 'publish_geodata']);
  const schema = tools.get('present_visualization')!.parameters!;
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['command', 'visualizationId']);
  assert.ok(schema.properties?.command);
  assert.ok(schema.properties?.resourceId);
  assert.equal(schema.anyOf, undefined, 'root-level unions are not exposed correctly by Pi tool descriptions');
  assert.equal(typeof handlers.get('session_start'), 'function');
  assert.equal(typeof handlers.get('session_tree'), 'function');
});

test('present_visualization schema preserves numeric style values during Pi conversion', async () => {
  const { tools } = await loadExtension();
  const schema = tools.get('present_visualization')!.parameters!;
  const constant = {
    command: 'set_constant', visualizationId: 'city_map', layerId: 'places', channel: 'opacity', value: 0.8,
  };
  Value.Convert(schema, constant);
  assert.equal(constant.value, 0.8);
  assert.equal(typeof constant.value, 'number');

  const continuous = {
    command: 'set_continuous', visualizationId: 'city_map', layerId: 'places', channel: 'radius', field: 'count',
    stops: [{ value: 0, output: 4 }, { value: 10, output: 12 }],
  };
  Value.Convert(schema, continuous);
  assert.deepEqual(continuous.stops, [{ value: 0, output: 4 }, { value: 10, output: 12 }]);
});

test('present_visualization accepts command-style parameters and keeps revisions', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-extension-commands-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { tools } = await loadExtension();
  const present = tools.get('present_visualization')!;
  const published = await publishPoints(tools, cwd);
  const resourceId = published.details.resource.resourceId;
  const first = await present.execute('call_1', {
    command: 'create_map', visualizationId: 'city_map', title: 'Places map',
    resourceId, sourceId: 'places_source', layerId: 'places', layerType: 'circle', color: '#2563eb',
  }, new AbortController().signal, undefined, { cwd });
  assert.equal(first.details.visualization.revision, 1);
  assert.equal(first.details.visualization.scene.metadata.title, 'Places map');
  assert.equal(first.details.visualization.scene.sources[0].idField, 'id');
  const styled = await present.execute('call_2', {
    command: 'set_step', visualizationId: 'city_map', layerId: 'places', channel: 'radius', field: 'count',
    defaultValue: 4, stops: [{ value: 5, output: 6 }, { value: 10, output: 10 }],
  }, new AbortController().signal, undefined, { cwd });
  assert.equal(styled.details.visualization.revision, 2);
  assert.equal(styled.details.visualization.scene.layers[0].encoding.radius.mode, 'step');
  const focused = await present.execute('call_2', {
    command: 'set_camera', visualizationId: 'city_map', center: [121.47, 31.23], zoom: 11,
  }, new AbortController().signal, undefined, { cwd });
  assert.equal(focused.details.visualization.revision, 3);
  assert.deepEqual(focused.details.visualization.scene.view, { mode: 'camera', center: [121.47, 31.23], zoom: 11 });
  const cleared = await present.execute('call_3', {
    command: 'clear', visualizationId: 'city_map',
  }, new AbortController().signal, undefined, { cwd });
  assert.equal(cleared.details.visualization.revision, 4);
  const replaced = await present.execute('call_4', {
    command: 'create_map', visualizationId: 'city_map', title: 'Places map', resourceId, layerType: 'circle',
  }, new AbortController().signal, undefined, { cwd });
  assert.equal(replaced.details.visualization.revision, 5, 'clear must retain a revision tombstone');
});

test('publish_geodata creates an immutable session resource consumable by a scene', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-extension-geo-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { tools } = await loadExtension();
  const published = await publishPoints(tools, cwd);
  const resource = published.details.resource;
  assert.match(resource.resourceId, /^geo_[a-f0-9]{24}$/);
  assert.equal(resource.featureCount, 1);
  assert.equal(fs.existsSync(path.join(cwd, '.tau', 'geo-resources', resource.resourceId, 'data.geojson')), true);

  const present = tools.get('present_visualization')!;
  const result = await present.execute('call_present', {
    command: 'create_map', visualizationId: 'resource_map', title: 'Places map',
    resourceId: resource.resourceId, sourceId: 'places_source', layerId: 'places', layerType: 'circle',
  }, new AbortController().signal, undefined, { cwd });
  assert.equal(result.details.visualization.scene.sources[0].resourceId, resource.resourceId);
});

test('present_visualization reports a field path when a command creates an invalid scene', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-extension-invalid-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { tools } = await loadExtension();
  const published = await publishPoints(tools, cwd);
  const present = tools.get('present_visualization')!;
  await assert.rejects(() => present.execute('call_bad', {
    command: 'create_map', visualizationId: 'bad_map', title: 'Bad map',
    resourceId: published.details.resource.resourceId, layerType: 'label',
  }, new AbortController().signal, undefined, { cwd }), /scene\.layers\[0\]\.encoding\.textField \[missing_text_field\]/);
});

test('present_visualization reports command-specific missing parameters', async () => {
  const { tools } = await loadExtension();
  const present = tools.get('present_visualization')!;
  await assert.rejects(() => present.execute('call_missing', {
    command: 'create_map', visualizationId: 'missing_map',
  }, new AbortController().signal, undefined, { cwd: process.cwd() }), /Missing parameters for command create_map: title, resourceId, layerType/);
});

test('present_visualization reports converted style types and warns after a repeated failure', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-extension-retry-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { tools } = await loadExtension();
  const published = await publishPoints(tools, cwd);
  const present = tools.get('present_visualization')!;
  await present.execute('create', {
    command: 'create_map', visualizationId: 'retry_map', title: 'Retry map',
    resourceId: published.details.resource.resourceId, layerId: 'places', layerType: 'circle',
  }, new AbortController().signal, undefined, { cwd });

  const invalid = () => present.execute('invalid', {
    command: 'set_constant', visualizationId: 'retry_map', layerId: 'places', channel: 'radius', value: -1,
  }, new AbortController().signal, undefined, { cwd });
  await assert.rejects(invalid, /received value=-1 type=number/);
  await assert.rejects(invalid, /failed 2 times.*Stop retrying/s);

  const recovered = await present.execute('recover', {
    command: 'set_constant', visualizationId: 'retry_map', layerId: 'places', channel: 'radius', value: 6,
  }, new AbortController().signal, undefined, { cwd });
  assert.equal(recovered.details.visualization.revision, 2);
  assert.equal(recovered.details.visualization.scene.layers[0].encoding.radius.value, 6);
});

test('publish_geodata identifies the feature index for an invalid idField', async (t: TestContext) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-extension-id-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'missing-id.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [121.47, 31.23] } }],
  }));
  const { tools } = await loadExtension();
  await assert.rejects(() => tools.get('publish_geodata')!.execute(
    'publish', { path: 'missing-id.geojson', idField: 'id' }, new AbortController().signal, undefined, { cwd },
  ), /features\[0\]\.properties\.id is missing/);
});
