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

caseTest('Geo screenshots capture only after idle and release listeners on every terminal path', async (t: any) => {
  // @ts-expect-error This test exercises the compiled browser artifact, which has no declaration file.
  const { captureRenderedMap } = await import('../../public/visualization/geo/geo-screenshot.js');
  const makeMap = () => {
    const handlers = new Map<string, Set<() => void>>();
    const canvas = new EventTarget();
    let resized = false, repainted = false;
    return {
      handlers, canvas,
      on(type: string, handler: () => void) { const bucket = handlers.get(type) || new Set(); bucket.add(handler); handlers.set(type, bucket); },
      off(type: string, handler: () => void) { handlers.get(type)?.delete(handler); },
      getCanvas: () => canvas,
      resize() { resized = true; },
      triggerRepaint() { repainted = true; },
      fire(type: string) { for (const handler of handlers.get(type) || []) handler(); },
      ready: () => resized && repainted,
      listenerCount: () => [...handlers.values()].reduce((count, bucket) => count + bucket.size, 0),
    };
  };
  await t.test('waits for resource rendering and repaints an already idle map', async () => {
    const map = makeMap();
    let captures = 0;
    const capture = captureRenderedMap(map, () => { captures++; return 'rendered PNG'; });
    assert.equal(map.ready(), true);
    map.fire('render');
    assert.equal(captures, 0, 'a render frame before tiles settle is insufficient');
    map.fire('idle');
    assert.equal(await capture, 'rendered PNG');
    assert.equal(captures, 1);
    assert.equal(map.listenerCount(), 0);
  });
  for (const event of ['remove', 'error', 'webglcontextlost']) await t.test(`refuses capture after ${event}`, async () => {
    const map = makeMap();
    const capture = captureRenderedMap(map, () => assert.fail('must not capture an unavailable map'));
    const rejected = assert.rejects(capture, /closed|resources failed|context was lost/);
    if (event === 'webglcontextlost') map.canvas.dispatchEvent(new Event(event));
    else map.fire(event);
    await rejected;
    assert.equal(map.listenerCount(), 0);
    map.fire('idle');
  });
  await t.test('rejects maps that never finish rendering and capture failures', async () => {
    const map = makeMap();
    await assert.rejects(captureRenderedMap(map, () => assert.fail('must not save before idle'), 10), /timed out/);
    assert.equal(map.listenerCount(), 0);
    const failed = captureRenderedMap(map, () => { throw new Error('blank canvas'); });
    const rejected = assert.rejects(failed, /blank canvas/);
    map.fire('idle');
    await rejected;
    assert.equal(map.listenerCount(), 0);
  });
});
