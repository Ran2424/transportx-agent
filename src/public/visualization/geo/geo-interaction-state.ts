import type { GeoPointV1, GeoRectangleV1 } from '../../../contracts/geo.js';

export function toggleFeatureIds(current: Array<string | number>, id: string | number, limit: number) {
  const ids = [...current];
  const key = `${typeof id}:${String(id)}`;
  const index = ids.findIndex((item) => `${typeof item}:${String(item)}` === key);
  if (index >= 0) { ids.splice(index, 1); return { ids, limitReached: false }; }
  if (ids.length >= limit) return { ids, limitReached: true };
  ids.push(id);
  return { ids, limitReached: false };
}

export function pointGeometry(longitude: number, latitude: number): GeoPointV1 {
  return { type: 'Point', coordinates: [longitude, latitude] };
}

export function rectangleGeometry(start: [number, number], end: [number, number]): GeoRectangleV1 | null {
  const west = Math.min(start[0], end[0]), east = Math.max(start[0], end[0]);
  const south = Math.min(start[1], end[1]), north = Math.max(start[1], end[1]);
  return west === east || south === north ? null : { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
}

export function viewportSummary(bounds: [number, number, number, number]) {
  return `${bounds[0].toFixed(5)}, ${bounds[1].toFixed(5)} – ${bounds[2].toFixed(5)}, ${bounds[3].toFixed(5)}`;
}
