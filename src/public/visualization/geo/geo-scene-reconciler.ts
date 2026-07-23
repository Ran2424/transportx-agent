import type { GeoEnvelopeOperation, GeoSceneSnapshot } from '../../../contracts/geo.js';

export type GeoSceneUpdatePlan = {
  rebuildMap: boolean;
  reconcileContent: boolean;
  applyView: boolean;
  applySelection: boolean;
};

export function planGeoSceneUpdate(
  previous: GeoSceneSnapshot,
  next: GeoSceneSnapshot,
  operation: GeoEnvelopeOperation,
): GeoSceneUpdatePlan {
  const rebuildMap = operation === 'replace' || previous.basemap.id !== next.basemap.id;
  return {
    rebuildMap,
    reconcileContent: !rebuildMap && operation === 'patch',
    applyView: rebuildMap || operation === 'focus',
    applySelection: rebuildMap || operation === 'patch' || operation === 'select',
  };
}

export function retainedLayerVisibility(
  previous: GeoSceneSnapshot,
  next: GeoSceneSnapshot,
  overrides: ReadonlyMap<string, boolean>,
) {
  const retained = new Map<string, boolean>();
  const previousIds = new Set(previous.layers.map((layer) => layer.id));
  for (const layer of next.layers) {
    const override = overrides.get(layer.id);
    if (previousIds.has(layer.id) && override !== undefined) retained.set(layer.id, override);
  }
  return retained;
}
