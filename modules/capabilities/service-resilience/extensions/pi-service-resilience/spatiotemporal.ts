import booleanIntersects from '@turf/boolean-intersects';
import pointToLineDistance from '@turf/point-to-line-distance';
import type { Feature, Geometry, LineString, Point, Polygon } from 'geojson';
import type { ResilienceCase } from './model.js';

type Coord = [number, number];
type SupportedGeometry = Point | LineString | Polygon;
type Target = { id: string; kind: 'node' | 'edge' | 'service' | 'demand'; geometry: Point | LineString };
type Action = 'close-edge' | 'close-service';
const fail = (message: string): never => { throw new Error(`Spatiotemporal alignment: ${message}`); };
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonblank = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= 500;
const identifier = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(x);

// Require a real calendar date and an explicit UTC offset; Date.parse alone normalizes invalid dates.
function instant(value: unknown, label: string): number {
  if (typeof value !== 'string') return fail(`${label} must be a timezone-qualified ISO timestamp`);
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return fail(`${label} must be a timezone-qualified ISO timestamp`);
  const [, year, month, day, hour, minute, second, zone] = m;
  const y = Number(year), mo = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > days[mo - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59 ||
      (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59))) return fail(`${label} has an invalid date or offset`);
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return fail(`${label} is invalid`);
  return time;
}
function interval(start: unknown, end: unknown, label: string) {
  const a = instant(start, `${label} start`), b = instant(end, `${label} end`);
  if (a >= b) return fail(`${label} start must precede end`);
  return { start: a, end: b };
}
function coord(x: unknown): x is Coord {
  return Array.isArray(x) && x.length === 2 && x.every(n => typeof n === 'number' && Number.isFinite(n)) && Math.abs(x[0]) <= 180 && Math.abs(x[1]) <= 90;
}
function geometry(input: unknown): SupportedGeometry | null {
  if (input === null) return null;
  if (!record(input)) return fail('geometry must be Point, LineString, Polygon, or null');
  const c = input.coordinates;
  if (input.type === 'Point' && coord(c)) return { type: 'Point', coordinates: c };
  if (input.type === 'LineString' && Array.isArray(c) && c.length >= 2 && c.length <= 1000 && c.every(coord)) return { type: 'LineString', coordinates: c };
  if (input.type === 'Polygon' && Array.isArray(c) && c.length > 0 && c.length <= 100 && c.every(ring => Array.isArray(ring) && ring.length >= 4 && ring.every(coord) && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) && c.reduce((n, ring) => n + ring.length, 0) <= 1000) return { type: 'Polygon', coordinates: c };
  return fail('invalid or unsupported WGS84 geometry (Point, LineString and Polygon only; at most 1000 positions)');
}
const feature = <G extends Geometry>(g: G): Feature<G> => ({ type: 'Feature', properties: {}, geometry: g });
function pointDistance(a: number[], b: number[]) {
  const rad = Math.PI / 180, dlat = (b[1] - a[1]) * rad, dlon = (b[0] - a[0]) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dlon / 2) ** 2;
  return 12_742_017.6 * Math.asin(Math.min(1, Math.sqrt(h)));
}
function distance(event: SupportedGeometry, target: Point | LineString): number | undefined {
  if (event.type === 'Point' && target.type === 'Point') return pointDistance(event.coordinates, target.coordinates);
  if (event.type === 'Point' && target.type === 'LineString') return pointToLineDistance(feature(event), feature(target), { units: 'meters' });
  if (event.type === 'LineString' && target.type === 'Point') return pointToLineDistance(feature(target), feature(event), { units: 'meters' });
  return undefined;
}

/** Align explicit event intervals to a supplied calendar; spatial candidates never authorize case changes. */
export function alignSpatiotemporal(model: ResilienceCase, eventData: unknown, periodsData: unknown, toleranceMeters: number) {
  if (!Number.isFinite(toleranceMeters) || toleranceMeters < 0 || toleranceMeters > 10000) fail('toleranceMeters must be between 0 and 10000');
  if (!record(periodsData) || !Array.isArray(periodsData.periods) || periodsData.periods.length !== model.periods.length) return fail('calendar must contain exactly one entry per case period');
  const seenPeriods = new Set<string>();
  const periods = periodsData.periods.map((p: unknown) => {
    if (!record(p) || !identifier(p.id) || !model.periods.some(item => item.id === p.id) || seenPeriods.has(p.id)) return fail('calendar contains an unknown or duplicate period ID');
    seenPeriods.add(p.id);
    return { id: p.id, ...interval(p.start, p.end, `period ${p.id}`), weight: model.periods.find(item => item.id === p.id)!.weight };
  });
  if (!record(eventData) || eventData.type !== 'FeatureCollection' || !Array.isArray(eventData.features) || eventData.features.length > 5000) return fail('events must be a GeoJSON FeatureCollection with at most 5000 features');
  const nodes = new Map(model.nodes.map(node => [node.id, node.coordinates]));
  const targets: Target[] = [
    ...model.nodes.map(n => ({ id: n.id, kind: 'node' as const, geometry: { type: 'Point' as const, coordinates: n.coordinates } })),
    ...model.edges.map(e => ({ id: e.id, kind: 'edge' as const, geometry: { type: 'LineString' as const, coordinates: [nodes.get(e.from)!, nodes.get(e.to)!] } })),
    ...model.services.map(s => ({ id: s.id, kind: 'service' as const, geometry: { type: 'Point' as const, coordinates: nodes.get(s.node)! } })),
    ...model.demands.map(d => ({ id: d.id, kind: 'demand' as const, geometry: { type: 'Point' as const, coordinates: nodes.get(d.node)! } })),
  ];
  const byId = new Map(targets.map(t => [t.id, t]));
  const rows: Record<string, unknown>[] = [];
  const confirmedChanges: { eventId: string; objectId: string; periodId: string; action: Action }[] = [];
  const ids = new Set<string>();
  let spatialWork = 0;
  let outputBytes = 0;
  for (const item of eventData.features) {
    if (!record(item) || item.type !== 'Feature' || !record(item.properties)) return fail('each event must be a GeoJSON Feature with properties');
    const p = item.properties, eventId = p.eventId ?? item.id;
    if (!identifier(eventId) || ids.has(eventId)) return fail('events require unique valid event IDs');
    ids.add(eventId);
    if (!nonblank(p.source)) return fail(`event ${eventId} requires a source`);
    if (p.objectId !== undefined && !identifier(p.objectId)) return fail(`event ${eventId} has an invalid objectId`);
    if (p.status !== undefined && !nonblank(p.status)) return fail(`event ${eventId} has an invalid status`);
    const eventInterval = interval(p.start, p.end, `event ${eventId}`);
    const g = geometry(item.geometry);
    const exact = typeof p.objectId === 'string' ? byId.get(p.objectId) : undefined;
    const offset = exact && g ? distance(g, exact.geometry) : undefined;
    const geometryConflict = Boolean(exact && g && !booleanIntersects(feature(g), feature(exact.geometry)) &&
      (offset === undefined || offset > toleranceMeters));
    const candidates: { objectId: string; kind: Target['kind']; method: 'intersection' | 'distance'; distanceMeters?: number }[] = [];
    if (!exact && g) {
      const positions = g.type === 'Point' ? 1 : g.type === 'LineString' ? g.coordinates.length : g.coordinates.reduce((n, ring) => n + ring.length, 0);
      spatialWork += targets.length * positions;
      if (spatialWork > 2_000_000) return fail('spatial candidate workload exceeds two million position comparisons');
      for (const target of targets) {
        if (booleanIntersects(feature(g), feature(target.geometry))) candidates.push({ objectId: target.id, kind: target.kind, method: 'intersection' });
        else if (toleranceMeters > 0) {
          const meters = distance(g, target.geometry);
          if (meters !== undefined && meters <= toleranceMeters) candidates.push({ objectId: target.id, kind: target.kind, method: 'distance', distanceMeters: meters });
        }
        if (candidates.length > 100) return fail(`event ${eventId} has more than 100 spatial candidates; narrow its geometry`);
      }
    }
    const selected = exact ?? (candidates.length === 1 ? byId.get(candidates[0].objectId) : undefined);
    const method = exact ? 'exact-id' : candidates.length ? 'spatial-candidate' : 'unmatched';
    const action: Action | null = p.action === 'close-edge' || p.action === 'close-service' ? p.action : null;
    const applicableAction = selected && ((selected.kind === 'edge' && action === 'close-edge') || (selected.kind === 'service' && action === 'close-service'));
    const overlaps = periods.filter(period => Math.max(period.start, eventInterval.start) < Math.min(period.end, eventInterval.end));
    const base = { eventId, source: p.source, suppliedObjectId: p.objectId ?? null, objectId: selected?.id ?? null, objectKind: selected?.kind ?? null, method, candidates, ambiguous: candidates.length > 1, geometryConflict, action, suppliedStatus: p.status ?? null, eventStart: p.start, eventEnd: p.end };
    outputBytes += (Buffer.byteLength(JSON.stringify(base)) + 600 + candidates.length * 100) * Math.max(1, overlaps.length);
    if (outputBytes > 12 * 1024 * 1024) return fail('alignment evidence is too large; split the input into smaller event files');
    if (!overlaps.length) {
      const nearestPeriod = periods.map(({ id, start, end }) => ({ id,
        gapMs: Math.max(start - eventInterval.end, eventInterval.start - end, 0) })).sort((a, b) => a.gapMs - b.gapMs)[0];
      rows.push({ ...base, periodId: null, timeStatus: 'no-overlap', status: 'pending', overlap: null, nearestPeriod });
    }
    for (const period of overlaps) {
      const start = Math.max(period.start, eventInterval.start), end = Math.min(period.end, eventInterval.end);
      const whole = start === period.start && end === period.end;
      const confirmed = Boolean(exact && !geometryConflict && p.status === 'confirmed' && applicableAction && whole && period.weight === 1);
      rows.push({ ...base, periodId: period.id, periodWeight: period.weight, timeStatus: whole ? 'full' : 'partial', status: confirmed ? 'confirmed' : 'pending', overlap: { start: new Date(start).toISOString(), end: new Date(end).toISOString(), durationMs: end - start, periodDurationMs: period.end - period.start } });
      if (confirmed && selected && action) confirmedChanges.push({ eventId, objectId: selected.id, periodId: period.id, action });
    }
  }
  return { rows, confirmedChanges, summary: { events: ids.size, rows: rows.length, confirmedChanges: confirmedChanges.length, pendingRows: rows.length - confirmedChanges.length }, assumptions: [
    'Intervals are half-open [start, end); a closure is actionable only when it covers the entire period.',
    'Single dated observations are pending for weighted periods, since one observation cannot establish every represented occurrence.',
    'Spatial intersections and distances are candidates only and never confirm a change. Edge geometry is the straight line between its case nodes.',
    'An exact ID paired with conflicting geometry remains pending. ID-only events may be explicitly confirmed.',
    'Distance tolerance applies only to point-to-point and point-to-line cases; polygon proximity and line-to-line proximity are not inferred. GeoJSON coordinates use WGS84; intersections are planar and may be unsuitable near the antimeridian.',
  ] };
}
