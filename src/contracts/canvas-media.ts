import { asRecord, asString } from './common.ts';
import { parseVideoTimestamp } from './video.ts';

export type GeoCanvasTarget = { kind: 'map-view'; bounds: [number, number, number, number] };
export type VideoCanvasTarget = { kind: 'timestamp'; at: string } | { kind: 'offset'; seconds: number };

function exactKeys(record: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(record).every((key) => keys.has(key));
}

export function parseGeoCanvasTarget(value: unknown): GeoCanvasTarget | null {
  const record = asRecord(value);
  if (!record || record.kind !== 'map-view' || !exactKeys(record, ['kind', 'bounds'])) return null;
  const bounds = record.bounds;
  if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every((item) => typeof item === 'number' && Number.isFinite(item))) return null;
  const [west, south, east, north] = bounds as [number, number, number, number];
  return west >= -180 && east <= 180 && south >= -90 && north <= 90 && west < east && south < north
    ? { kind: 'map-view', bounds: [west, south, east, north] }
    : null;
}

export function parseVideoCanvasTarget(value: unknown): VideoCanvasTarget | null {
  const record = asRecord(value);
  if (!record) return null;
  if (record.kind === 'timestamp' && exactKeys(record, ['kind', 'at'])) {
    const at = asString(record.at, 64);
    return at && parseVideoTimestamp(at) ? { kind: 'timestamp', at } : null;
  }
  if (record.kind === 'offset' && exactKeys(record, ['kind', 'seconds'])) {
    return typeof record.seconds === 'number' && Number.isFinite(record.seconds) && record.seconds >= 0
      ? { kind: 'offset', seconds: record.seconds }
      : null;
  }
  return null;
}
