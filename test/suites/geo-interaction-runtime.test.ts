const { test } = require('node:test') as typeof import('node:test');

test('Geo controller and screenshots isolate state and clean up on every terminal path', async () => {
  const assert = require('node:assert/strict');

  // Legend keys preserve encoding semantics rather than inventing data ranges.
  {
    // @ts-expect-error This test exercises the compiled browser artifact, which has no declaration file.
    const { buildGeoLegend, geoLegendGroups, geoLegendItems, geoLegendCaption, formatGeoLegendNumber } = await import('../../public/visualization/geo/geo-legend.js');
    const layer = { id: 'flow', sourceId: 'roads', type: 'line', encoding: {}, popup: { fields: [{ field: 'flow', label: '交通量（辆/小时）' }] } };
    const stepped = buildGeoLegend({ ...layer, encoding: { color: { mode: 'step', field: 'flow', default: '#ffffff', stops: [{ value: 100, output: '#00ff00' }, { value: 500, output: '#ff0000' }] } } }, false);
    assert.deepEqual(stepped.sections[0].entries.map((entry: any) => [entry.label, entry.symbol.values.color]), [['< 100', '#ffffff'], ['100 – < 500', '#00ff00'], ['≥ 500', '#ff0000']]);
    assert.equal(stepped.sections[0].title, '交通量（辆/小时） · 颜色');
    const categorical = buildGeoLegend({ ...layer, encoding: { color: { mode: 'categorical', field: 'kind', categories: [{ value: '主干路', output: '#ff0000' }], fallback: '#888888' } } }, false, 'en-US');
    assert.deepEqual(categorical.sections[0].entries.map((entry: any) => entry.label), ['主干路', 'Other / unmatched']);
    assert.deepEqual(categorical.symbol.colorStops.map((stop: any) => stop.color), ['#ff0000', '#ff0000', '#888888', '#888888'], 'collapsed keys still show all category colors');
    assert.equal(categorical.sections[0].entries[0].symbol.colorStops, undefined, 'each category retains its own single-color key');
    const continuous = buildGeoLegend({ ...layer, encoding: { color: { mode: 'continuous', field: 'flow', stops: [{ value: 0, output: '#ffffff' }, { value: 10, output: '#ffff00' }, { value: 100, output: '#ff0000' }] } } }, false);
    assert.deepEqual(continuous.sections[0].ramp.map((stop: any) => stop.offset), [0, 0.1, 1], 'nonuniform stops retain their positions in the gradient');
    const sizes = buildGeoLegend({ ...layer, type: 'circle', encoding: { radius: { mode: 'continuous', field: 'flow', stops: [{ value: 0, output: 20 }, { value: 100, output: 100 }] } } }, false);
    assert.equal(sizes.sections[0].entries[0].symbol.sampleScale.factor, sizes.sections[0].entries[1].symbol.sampleScale.factor, 'large symbols use one scale so relative sizes remain distinguishable');
    assert.equal(buildGeoLegend({ ...layer, type: 'label' }, true).symbol.values.color, '#f8fafc');
    assert.equal(buildGeoLegend({ ...layer, type: 'fill' }, false).symbol.values.opacity, 0.5);
    const chart = buildGeoLegend({ ...layer, type: 'chart', chart: { type: 'bar', valueFields: ['flow'], colors: ['#123456'], size: 40, maxValue: 1000 } }, false);
    assert.equal(chart.sections[0].entries[0].label, '交通量（辆/小时）');
    assert.equal(chart.sections[0].entries[0].symbol.values.color, '#123456');
    assert.match(chart.sections[0].note, /1000/);
    const combined = buildGeoLegend({ ...layer, type: 'circle', encoding: { color: { mode: 'continuous', field: 'flow', stops: [{ value: 20000, output: '#ffffff' }, { value: 220000, output: '#ff0000' }] }, radius: { mode: 'step', field: 'flow', default: 4, stops: [{ value: 20000, output: 8 }, { value: 60000, output: 12 }] } } }, false);
    assert.equal(geoLegendGroups(combined.sections).length, 1, 'color and size share one metric heading');
    assert.equal(geoLegendGroups(combined.sections)[0].sections.length, 2, 'each encoding keeps its own breakpoints');
    assert.equal(combined.sections[0].ramp[1].label, '22万');
    assert.equal(formatGeoLegendNumber(20001, 'zh-CN'), '20001', 'compact labels must not round a boundary');
    assert.equal(combined.sections[1].mode, 'step', 'a discrete size encoding must not be presented as continuous');
    const linked = buildGeoLegend({ ...layer, type: 'circle', encoding: { color: { mode: 'continuous', field: 'value', stops: [{ value: 0, output: '#000' }, { value: 100, output: '#fff' }] }, radius: { mode: 'continuous', field: 'value', stops: [{ value: 0, output: 2 }, { value: 50, output: 5 }, { value: 100, output: 10 }] } } }, false);
    assert.equal(linked.sections[1].entries[1].symbol.values.color, '#808080ff', 'a size example uses the color for the same field value');
    const independent = buildGeoLegend({ ...layer, type: 'circle', encoding: { color: { mode: 'continuous', field: 'other', stops: [{ value: 0, output: '#000' }, { value: 100, output: '#fff' }] }, radius: { mode: 'continuous', field: 'value', stops: [{ value: 0, output: 2 }, { value: 50, output: 5 }, { value: 100, output: 10 }] } } }, false);
    assert.equal(independent.sections[1].entries[1].symbol.values.color, '#000', 'unrelated fields are never coupled');
    const reading = geoLegendItems([{ ...layer, id: 'data', title: '另一个名称', encoding: { color: { mode: 'categorical', field: 'category', categories: [], fallback: '#888888' } } }, { ...layer, title: '任意名称' }, { ...layer, id: 'label', type: 'label' }], false);
    assert.deepEqual(reading.map((item: any) => item.layer.id), ['flow', 'data'], 'plain symbols precede encoded items; label controls do not become legend keys');
    assert.equal(geoLegendCaption(combined.sections[1]), '点大小 · 分级');
    assert.equal(geoLegendCaption(linked.sections[1]), '点大小 · 连续');
  }

  // Geo controller isolates user, request and hover state and removes every listener on destroy
  {
    // @ts-expect-error This test intentionally exercises the compiled browser artifact, which has no declaration file.
    const { GeoInteractionController } = await import('../../public/visualization/geo/geo-interaction-controller.js');
    const handlers = new Map<string, Set<(event: any) => void>>();
    const sources = new Map<string, any>([['roads-source', {}]]);
    const layers = new Set<string>();
    const states: Array<{ id: string | number; state: Record<string, boolean> }> = [];
    const events: any[] = [];
    const key = (type: string, layer?: string) => `${type}:${layer || ''}`;
    const map: any = {
      dragPan: { disable() { }, enable() { } },
      getCanvas: () => ({ style: { cursor: '' } }),
      getBounds: () => ({ getWest: () => 121.4, getSouth: () => 31.1, getEast: () => 121.5, getNorth: () => 31.3 }),
      addSource(id: string) { sources.set(id, { setData() { } }); },
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
      for (const handler of handlers.get(key(type, layer)) || []) handler({ features: [{ id }], lngLat: { lng: 121.4, lat: 31.2 }, preventDefault() { } });
    };
    const fireMap = (type: string, lng: number, lat: number) => {
      for (const handler of handlers.get(key(type)) || []) handler({ lngLat: { lng, lat }, defaultPrevented: false, preventDefault() { } });
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
  }

  // Geo screenshots capture only after idle and release listeners on every terminal path
  {
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
    // 'waits for resource rendering and repaints an already idle map'
    {
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
    }
    for (const event of ['remove', 'error', 'webglcontextlost']) // `refuses capture after ${event}`
    {
      const map = makeMap();
      const capture = captureRenderedMap(map, () => assert.fail('must not capture an unavailable map'));
      const rejected = assert.rejects(capture, /closed|resources failed|context was lost/);
      if (event === 'webglcontextlost') map.canvas.dispatchEvent(new Event(event));
      else map.fire(event);
      await rejected;
      assert.equal(map.listenerCount(), 0);
      map.fire('idle');
    }
    // 'rejects maps that never finish rendering and capture failures'
    {
      const map = makeMap();
      await assert.rejects(captureRenderedMap(map, () => assert.fail('must not save before idle'), 10), /timed out/);
      assert.equal(map.listenerCount(), 0);
      const failed = captureRenderedMap(map, () => { throw new Error('blank canvas'); });
      const rejected = assert.rejects(failed, /blank canvas/);
      map.fire('idle');
      await rejected;
      assert.equal(map.listenerCount(), 0);
    }
  }
});
