import type { ResilienceCase, Observation } from './model.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ELEMENTS = 100_000;
const MAX_NODES = 4_000;
const MAX_EDGES = 10_000;
const MAX_ROWS = 5_000;

function fail(message: string): never { throw new Error(`Resilience input: ${message}`); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function osmId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)) return value;
  return undefined;
}
function distanceKm(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Imports a caller-provided Overpass response; speed is a scenario assumption. */
export function importOsmNetwork(input: unknown, routing: { speedKph: number; mode: string }): { nodes: ResilienceCase['nodes']; edges: ResilienceCase['edges']; notes: string[] } {
  if (!Number.isFinite(routing?.speedKph) || routing.speedKph <= 0 || routing.speedKph > 300 || typeof routing.mode !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(routing.mode)) fail('a positive scenario speed (at most 300 km/h) and mode are required');
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8'); } catch { return fail('OSM input must be JSON-serializable'); }
  if (size > MAX_BYTES) fail('OSM input exceeds 16 MiB');
  if (!record(input) || !Array.isArray(input.elements) || input.elements.length > MAX_ELEMENTS) fail('expected Overpass elements array of at most 100000 entries');
  const nodeMap = new Map<string, [number, number]>();
  const invalidNodes = new Set<string>();
  for (const el of input.elements) {
    if (!record(el) || el.type !== 'node') continue;
    const id = osmId(el.id);
    if (!id) continue;
    if (nodeMap.has(id) || invalidNodes.has(id)) { nodeMap.delete(id); invalidNodes.add(id); continue; }
    if (typeof el.lon !== 'number' || !Number.isFinite(el.lon) || Math.abs(el.lon) > 180 || typeof el.lat !== 'number' || !Number.isFinite(el.lat) || Math.abs(el.lat) > 90) { invalidNodes.add(id); continue; }
    nodeMap.set(id, [el.lon, el.lat]);
  }
  const nodes: ResilienceCase['nodes'] = [];
  const edges: ResilienceCase['edges'] = [];
  const used = new Set<string>();
  const wayCounts = new Map<string, number>();
  for (const el of input.elements) {
    if (record(el) && el.type === 'way') {
      const id = osmId(el.id);
      if (id) wayCounts.set(id, (wayCounts.get(id) ?? 0) + 1);
    }
  }
  const notes = [`Travel time uses the supplied scenario assumption of ${routing.speedKph} km/h for ${routing.mode}; it is not observed or OSM speed.`];
  let skipped = 0;
  let restrictions = 0;
  const routable = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'road']);
  const accessKeys = /^(access|vehicle|motor_vehicle|motorcar|hgv|bus|psv|bicycle|foot|emergency|conditional)(:|$)/;
  for (const el of input.elements) {
    if (!record(el)) continue;
    if (el.type === 'relation' && record(el.tags) && (el.tags.type === 'restriction' || typeof el.tags.restriction === 'string')) { restrictions++; continue; }
    if (el.type !== 'way') continue;
    const id = osmId(el.id);
    if (!id || wayCounts.get(id) !== 1) { skipped++; continue; }
    if (!record(el.tags) || typeof el.tags.highway !== 'string' || !routable.has(el.tags.highway) || !Array.isArray(el.nodes) || el.nodes.length < 2 || el.nodes.length > MAX_NODES || Object.keys(el.tags).some(key => accessKeys.test(key) || key.includes(':conditional'))) { skipped++; continue; }
    const ids = el.nodes.map(osmId);
    if (ids.some(n => !n || !nodeMap.has(n))) { skipped++; continue; }
    const one = el.tags.oneway;
    if (one !== undefined && !['yes', 'true', '1', '-1', 'no', 'false', '0'].includes(String(one).toLowerCase())) { skipped++; continue; }
    const oneWay = one === undefined ? (el.tags.junction === 'roundabout' || el.tags.highway === 'motorway' ? 'yes' : 'no') : String(one).toLowerCase();
    const direction = oneWay === '-1' ? 'reverse' : ['yes', 'true', '1'].includes(oneWay) ? 'forward' : 'both';
    const wayEdges: ResilienceCase['edges'] = [];
    const wayNodes = new Set<string>();
    for (let i = 0; i < ids.length - 1; i++) {
      const from = ids[i]!; const to = ids[i + 1]!;
      const km = distanceKm(nodeMap.get(from)!, nodeMap.get(to)!);
      if (!(km > 0)) { wayEdges.length = 0; break; }
      const minutes = km / routing.speedKph * 60;
      if (!Number.isFinite(minutes) || minutes > 1440) { wayEdges.length = 0; break; }
      wayNodes.add(from); wayNodes.add(to);
      if (direction !== 'reverse') wayEdges.push({ id: `osm:w:${id}:${i}:f`, from: `osm:n:${from}`, to: `osm:n:${to}`, minutes, modes: [routing.mode], requires: [] });
      if (direction !== 'forward') wayEdges.push({ id: `osm:w:${id}:${i}:r`, from: `osm:n:${to}`, to: `osm:n:${from}`, minutes, modes: [routing.mode], requires: [] });
    }
    if (!wayEdges.length) { skipped++; continue; }
    let additionalNodes = 0;
    for (const n of wayNodes) if (!used.has(n)) additionalNodes++;
    if (edges.length + wayEdges.length > MAX_EDGES || used.size + additionalNodes > MAX_NODES) fail('OSM network exceeds 4000 nodes or 10000 directed edges');
    edges.push(...wayEdges);
    for (const n of wayNodes) used.add(n);
  }
  for (const id of used) nodes.push({ id: `osm:n:${id}`, coordinates: nodeMap.get(id)! });
  if (skipped) notes.push(`${skipped} ways excluded due to unsupported or incomplete highway, geometry, direction, or access data.`);
  notes.push('Access restrictions and conditional access are not modeled; ways carrying such tags are excluded. Turn restrictions are not modeled.');
  if (restrictions) notes.push(`${restrictions} restriction relations were present but are not applied; do not treat paths as restriction-compliant.`);
  return { nodes, edges, notes };
}

export function importSurveyObservations(csv: string, columns: { observationId: string; objectId: string; periodId: string; value: string; source: string }): Observation[] {
  if (typeof csv !== 'string' || Buffer.byteLength(csv, 'utf8') > MAX_BYTES) fail('CSV must be text of at most 16 MiB');
  const selected = [columns?.observationId, columns?.objectId, columns?.periodId, columns?.value, columns?.source];
  if (selected.some(x => typeof x !== 'string' || !x) || new Set(selected).size !== selected.length) fail('five distinct column names are required');
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let quoted = false; let closed = false;
  const text = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c;
    } else if (c === ',') { row.push(field); field = ''; closed = false; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = ''; closed = false;
      if (rows.length > MAX_ROWS + 1) fail('CSV exceeds 5000 observations');
    } else if (c === '"' && field === '' && !closed) quoted = true;
    else if (closed || c === '"') fail('malformed CSV quoting');
    else field += c;
  }
  if (quoted) fail('unterminated quoted CSV field');
  if (field !== '' || row.length || closed) { row.push(field); rows.push(row); }
  if (rows.length > MAX_ROWS + 1) fail('CSV exceeds 5000 observations');
  if (!rows.length) fail('CSV header is missing');
  const header = rows.shift()!;
  if (new Set(header).size !== header.length) fail('duplicate CSV column names');
  const indexes = selected.map(name => header.indexOf(name));
  if (indexes.some(i => i < 0)) fail('a mapped CSV column is missing');
  const observations: Observation[] = [];
  const seen = new Set<string>();
  for (const [index, values] of rows.entries()) {
    if (values.length !== header.length) fail(`CSV row ${index + 2} has the wrong number of columns`);
    const [id, objectId, periodId, value, source] = indexes.map(i => values[i]);
    if ([id, objectId, periodId, value, source].some(v => !v.trim())) fail(`CSV row ${index + 2} has an empty required value`);
    if (seen.has(id)) fail(`duplicate observation ID at CSV row ${index + 2}: ${id}`);
    seen.add(id); observations.push({ id, objectId, periodId, value, source });
  }
  return observations;
}

/** Exact matching only: returns observations and their original provenance without mutating state. */
export function alignObservations(observations: Observation[], objectIds: string[], periodIds: string[]) {
  const objects = new Set(objectIds); const periods = new Set(periodIds);
  const matched: Observation[] = [];
  const unknown: { observation: Observation; unknownObject: boolean; unknownPeriod: boolean }[] = [];
  for (const observation of observations) {
    const unknownObject = !objects.has(observation.objectId); const unknownPeriod = !periods.has(observation.periodId);
    if (unknownObject || unknownPeriod) unknown.push({ observation, unknownObject, unknownPeriod }); else matched.push(observation);
  }
  const coveredObjects = new Set(matched.map(o => o.objectId));
  const coveredPeriods = new Set(matched.map(o => o.periodId));
  return { matched, unknown, coverage: { observations: observations.length, matched: matched.length, unknown: unknown.length, objects: coveredObjects.size, totalObjects: objects.size, periods: coveredPeriods.size, totalPeriods: periods.size }, provenance: observations.map(({ id, source }) => ({ id, source })) };
}
