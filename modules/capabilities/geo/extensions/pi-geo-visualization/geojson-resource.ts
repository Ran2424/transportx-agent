import fs from 'node:fs';
import path from 'node:path';
import type { GeoJsonFeatureCollection, GeoSceneSnapshot } from '../../../../../src/contracts/geo-scene.ts';

export const MAX_BYTES = 100 * 1024 * 1024;
const MAX_FEATURES = 50_000;
export function isWithin(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function walkCoordinates(value: unknown, visitor: (lng: number, lat: number) => void): void {
  if (!Array.isArray(value) || value.length === 0) return;
  if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
    visitor(value[0], value[1]);
    return;
  }
  for (const child of value) walkCoordinates(child, visitor);
}

export function inspectGeoJson(data: GeoJsonFeatureCollection, idField?: string) {
  if (data.features.length > MAX_FEATURES) {
    throw new Error(`GeoJSON has ${data.features.length} features; the limit is ${MAX_FEATURES}. Aggregate, simplify, or split the data before publication.`);
  }
  const types = new Set<string>();
  const ids = new Set<string>();
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [featureIndex, feature] of data.features.entries()) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    types.add(geometry.type);
    if (idField) {
      const value = feature.properties?.[idField];
      if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`features[${featureIndex}].properties.${idField} is missing or is not a string/number`);
      const key = String(value);
      if (ids.has(key)) throw new Error(`features[${featureIndex}].properties.${idField} duplicates id value: ${key}`);
      ids.add(key);
    }
    const visit = (lng: number, lat: number) => {
      if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
        throw new Error(`features[${featureIndex}] contains coordinates outside WGS84 longitude/latitude ranges`);
      }
      bounds[0] = Math.min(bounds[0], lng);
      bounds[1] = Math.min(bounds[1], lat);
      bounds[2] = Math.max(bounds[2], lng);
      bounds[3] = Math.max(bounds[3], lat);
    };
    if (geometry.type === 'GeometryCollection') {
      for (const child of geometry.geometries || []) walkCoordinates(child.coordinates, visit);
    } else walkCoordinates(geometry.coordinates, visit);
  }
  return {
    geometryTypes: Array.from(types).sort(),
    bounds: bounds.every(Number.isFinite) ? bounds : null,
  };
}

export function resourceDirectory(cwd: string, resourceId: string) {
  return path.join(cwd, '.tau', 'geo-resources', resourceId);
}

export function readResourceManifest(cwd: string, resourceId: string) {
  const manifestPath = path.join(resourceDirectory(cwd, resourceId), 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Geo resource not found: ${resourceId}`);
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    resourceId: string;
    bounds?: [number, number, number, number] | null;
    idField?: string;
  };
}

export function assertSceneResources(cwd: string, scene: GeoSceneSnapshot) {
  for (const source of scene.sources) {
    if (source.type !== 'geojson-resource') continue;
    const manifest = path.join(resourceDirectory(cwd, source.resourceId), 'manifest.json');
    if (!fs.existsSync(manifest)) throw new Error(`Geo resource not found: ${source.resourceId}`);
  }
}
