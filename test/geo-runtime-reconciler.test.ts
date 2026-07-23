const { test } = require('node:test');
const assert = require('node:assert/strict');
import type { GeoSceneSnapshot } from '../src/contracts/geo.ts';

function scene(layerVisible?: boolean): GeoSceneSnapshot {
  return {
    view: { mode: 'camera', center: [121.47, 31.23], zoom: 10 },
    basemap: { id: 'none' },
    sources: [],
    layers: [{
      id: 'roads',
      sourceId: 'roads',
      type: 'line',
      ...(layerVisible === undefined ? {} : { visible: layerVisible }),
      encoding: { color: { mode: 'constant', value: '#2563eb' } },
    }],
    metadata: { title: 'Roads' },
  };
}

test('Geo Scene reconciliation preserves local layer visibility across Agent revisions', async () => {
  const { planGeoSceneUpdate, retainedLayerVisibility } = await import('../src/public/visualization/geo/geo-scene-reconciler.ts');
  const previous = scene();
  const patch = scene();
  patch.layers[0].encoding.color = { mode: 'constant', value: '#ef4444' };
  assert.deepEqual(planGeoSceneUpdate(previous, patch, 'patch'), {
    rebuildMap: false, reconcileContent: true, applyView: false, applySelection: true,
  });
  assert.deepEqual(planGeoSceneUpdate(previous, patch, 'focus'), {
    rebuildMap: false, reconcileContent: false, applyView: true, applySelection: false,
  });
  assert.deepEqual(planGeoSceneUpdate(previous, patch, 'replace'), {
    rebuildMap: true, reconcileContent: false, applyView: true, applySelection: true,
  });
  assert.equal(retainedLayerVisibility(previous, patch, new Map([['roads', false]])).get('roads'), false);
  assert.equal(retainedLayerVisibility(previous, scene(true), new Map([['roads', false]])).get('roads'), false);
  assert.equal(retainedLayerVisibility(previous, { ...patch, layers: [] }, new Map([['roads', false]])).has('roads'), false);
});
