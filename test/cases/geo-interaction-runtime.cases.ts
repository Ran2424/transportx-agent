const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

caseTest('Geo interaction state adds, removes and limits stable Feature ids', async () => {
  const state = await import('../../src/public/visualization/geo/geo-interaction-state.ts');
  assert.deepEqual(state.toggleFeatureIds([], 'a', 2), { ids: ['a'], limitReached: false });
  assert.deepEqual(state.toggleFeatureIds(['a'], 2, 2), { ids: ['a', 2], limitReached: false });
  assert.deepEqual(state.toggleFeatureIds(['a', 2], 'c', 2), { ids: ['a', 2], limitReached: true });
  assert.deepEqual(state.toggleFeatureIds(['a', 2], 'a', 2), { ids: [2], limitReached: false });
});

caseTest('Geo interaction state replaces points and builds axis-aligned rectangles', async () => {
  const state = await import('../../src/public/visualization/geo/geo-interaction-state.ts');
  assert.deepEqual(state.pointGeometry(121.4, 31.2), { type: 'Point', coordinates: [121.4, 31.2] });
  assert.deepEqual(state.pointGeometry(121.5, 31.3), { type: 'Point', coordinates: [121.5, 31.3] });
  assert.deepEqual(state.rectangleGeometry([3, 4], [1, 2]), { type: 'Polygon', coordinates: [[[1, 2], [3, 2], [3, 4], [1, 4], [1, 2]]] });
  assert.equal(state.rectangleGeometry([1, 2], [1, 4]), null);
  assert.equal(state.viewportSummary([1, 2, 3, 4]), '1.00000, 2.00000 – 3.00000, 4.00000');
});

caseTest('Geo controller isolates user, request and hover state and removes every listener on destroy', async () => {
  // @ts-expect-error This test intentionally exercises the compiled browser artifact, which has no declaration file.
  const { GeoInteractionController } = await import('../../public/visualization/geo/geo-interaction-controller.js');
  const handlers = new Map<string, Set<(event: any) => void>>();
  const sources = new Map<string, any>([['roads-source', {}]]);
  const layers = new Set<string>();
  const states: Array<{ id: string | number; state: Record<string, boolean> }> = [];
  const events: any[] = [];
  const key = (type: string, layer?: string) => `${type}:${layer || ''}`;
  const map: any = {
    dragPan: { disable() {}, enable() {} },
    getCanvas: () => ({ style: { cursor: '' } }),
    getBounds: () => ({ getWest: () => 121.4, getSouth: () => 31.1, getEast: () => 121.5, getNorth: () => 31.3 }),
    addSource(id: string) { sources.set(id, { setData() {} }); },
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => sources.delete(id),
    addLayer(spec: { id: string }) { layers.add(spec.id); },
    getLayer: (id: string) => layers.has(id) ? { id } : undefined,
    removeLayer: (id: string) => layers.delete(id),
    setFeatureState(input: { id: string | number }, state: Record<string, boolean>) { states.push({ id: input.id, state }); },
    on(type: string, layerOrHandler: string | ((event: any) => void), maybeHandler?: (event: any) => void) {
      const layer = typeof layerOrHandler === 'string' ? layerOrHandler : undefined;
      const handler = typeof layerOrHandler === 'function' ? layerOrHandler : maybeHandler!;
      const bucket = handlers.get(key(type, layer)) || new Set(); bucket.add(handler); handlers.set(key(type, layer), bucket);
    },
    off(type: string, layerOrHandler: string | ((event: any) => void), maybeHandler?: (event: any) => void) {
      const layer = typeof layerOrHandler === 'string' ? layerOrHandler : undefined;
      const handler = typeof layerOrHandler === 'function' ? layerOrHandler : maybeHandler!;
      handlers.get(key(type, layer))?.delete(handler);
    },
  };
  const fire = (type: string, layer: string, id: string) => {
    for (const handler of handlers.get(key(type, layer)) || []) handler({ features: [{ id }], lngLat: { lng: 121.4, lat: 31.2 }, preventDefault() {} });
  };
  const fireMap = (type: string, lng: number, lat: number) => {
    for (const handler of handlers.get(key(type)) || []) handler({ lngLat: { lng, lat }, defaultPrevented: false, preventDefault() {} });
  };
  const controller = new GeoInteractionController(map, (event: any) => events.push(event));
  controller.bindLayer({ id: 'roads', sourceId: 'roads-source', type: 'line', encoding: {} }, 'roads-layer', 'roads-source', true);
  controller.setMode('feature');
  fire('click', 'roads-layer', 'road-1');
  assert.deepEqual(states.at(-1), { id: 'road-1', state: { selectedByUser: true } });
  controller.setMode('browse');
  assert.deepEqual(states.at(-1), { id: 'road-1', state: { selectedByUser: false } });
  controller.setMode('feature', { forRequest: true });
  fire('click', 'roads-layer', 'road-2');
  assert.deepEqual(states.at(-1), { id: 'road-2', state: { selectedForRequest: true } });
  fire('mousemove', 'roads-layer', 'road-2');
  assert.deepEqual(states.at(-1), { id: 'road-2', state: { hovered: true } });

  controller.bindLayer({ id: 'inline', sourceId: 'roads-source', type: 'line', encoding: {} }, 'inline-layer', 'roads-source', false);
  controller.setMode('feature');
  fire('click', 'inline-layer', 'inline-1');
  assert.deepEqual(events.at(-1), { type: 'unselectable_layer', layerId: 'inline' });

  controller.setMode('point');
  fireMap('click', 121.41, 31.21);
  fireMap('click', 121.42, 31.22);
  assert.deepEqual(controller.getDraft()?.geometry, { type: 'Point', coordinates: [121.42, 31.22] });

  controller.setMode('rectangle');
  fireMap('mousedown', 121.4, 31.1); fireMap('mousemove', 121.45, 31.2); fireMap('mouseup', 121.45, 31.2);
  const firstRectangle = controller.getDraft()?.geometry;
  fireMap('mousedown', 121.42, 31.12); fireMap('mousemove', 121.5, 31.3); fireMap('mouseup', 121.5, 31.3);
  assert.notDeepEqual(controller.getDraft()?.geometry, firstRectangle);

  controller.setMode('viewport');
  assert.deepEqual(controller.getDraft(), { mode: 'viewport', summary: '121.40000, 31.10000 – 121.50000, 31.30000' });
  controller.clear();
  assert.equal([...handlers.values()].reduce((count, bucket) => count + bucket.size, 0), 0);
  assert.equal(sources.has('tau-geo-user-draft'), false);
  assert.equal([...layers].some((id) => id.startsWith('tau-geo-draft-')), false);
});

caseTest('Geo layer compiler includes four independent interaction states', async () => {
  // @ts-expect-error This test intentionally exercises the compiled browser artifact, which has no declaration file.
  const { compileGeoLayer } = await import('../../public/visualization/geo/geo-layer-compiler.js');
  const rendered = compileGeoLayer({ id: 'roads', sourceId: 'roads-source', type: 'line', encoding: {} }, 'runtime-source', false);
  const serialized = JSON.stringify(rendered.specs);
  for (const name of ['selectedForRequest', 'selectedByUser', 'selectedByAgent', 'hovered']) assert.match(serialized, new RegExp(name));
});
