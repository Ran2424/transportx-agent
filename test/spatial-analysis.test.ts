const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SpatialAnalysisService } = require('../bin/spatial-analysis-service.js');
const { parseSpatialAnalysisResultStructured } = require('../bin/contracts/spatial.js');

const PYTHON = '/Users/ran/WorkSpace/SoftWare/miniconda3/envs/research/bin/python3.10';
const SCRIPT = path.join(process.cwd(), 'modules/capabilities/spatial-analysis/scripts/spatial_analysis.py');

function collection(features: any[]) { return { type: 'FeatureCollection', features }; }
function point(id: string, coordinates: number[], properties: Record<string, unknown> = {}) { return { type: 'Feature', id, properties, geometry: { type: 'Point', coordinates } }; }
function writeGeo(root: string, name: string, value: unknown) { fs.writeFileSync(path.join(root, name), `${JSON.stringify(value)}\n`); }
function service() { return new SpatialAnalysisService({ command: PYTHON, args: [], version: '3.10' }, SCRIPT); }
function session(cwd: string) { return { cwd } as any; }

test('spatial result contract rejects unknown schema, operations and unsafe output paths', () => {
  const result = parseSpatialAnalysisResultStructured({ protocol: 'transportx-spatial-analysis', schemaVersion: 2, operation: 'route', output: { relativePath: '../outside.geojson' } });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((item: any) => item.code === 'unknown_schema_version'));
  assert.ok(result.diagnostics.some((item: any) => item.path === 'spatial.operation'));
});

test('controlled buffer writes WGS84 GeoJSON and an auditable manifest', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-buffer-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  writeGeo(cwd, 'venues.geojson', collection([point('stadium', [121.44, 31.19])]));
  const result = await service().analyze(session(cwd), { operation: 'buffer', inputPath: 'venues.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 1000 });
  assert.equal(result.operation, 'buffer');
  assert.equal(result.counts.output, 1);
  assert.equal(result.output.crs, 'EPSG:4326');
  assert.ok(result.output.geometryTypes.includes('Polygon'));
  assert.ok(fs.existsSync(path.join(cwd, result.output.relativePath)));
  assert.ok(fs.existsSync(path.join(cwd, '.tau/spatial-results', result.analysisId, 'manifest.json')));
});

test('controlled nearest preserves unmatched left features and reports metric distance', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-nearest-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  writeGeo(cwd, 'venues.geojson', collection([point('near', [121.44, 31.19]), point('far', [121.50, 31.25])]));
  writeGeo(cwd, 'stations.geojson', collection([point('station-1', [121.4405, 31.19], { name: 'Station One' })]));
  const result = await service().analyze(session(cwd), { operation: 'nearest', leftPath: 'venues.geojson', rightPath: 'stations.geojson', leftCrs: 'EPSG:4326', rightCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', maxDistanceMeters: 1000, rightFields: ['name'] });
  const output = JSON.parse(fs.readFileSync(path.join(cwd, result.output.relativePath), 'utf8'));
  assert.equal(result.counts.output, 2);
  assert.equal(result.counts.unmatched, 1);
  assert.equal(output.features[0].properties.match_status, 'matched');
  assert.ok(output.features[0].properties.nearest_distance_m > 40 && output.features[0].properties.nearest_distance_m < 60);
  assert.equal(output.features[1].properties.match_status, 'unmatched');
});

test('controlled spatial join records point-to-area matches', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-join-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  writeGeo(cwd, 'points.geojson', collection([point('inside', [1, 1]), point('outside', [3, 3])]));
  writeGeo(cwd, 'areas.geojson', collection([{ type: 'Feature', id: 'district-a', properties: { name: 'A' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] } }]));
  const result = await service().analyze(session(cwd), { operation: 'spatial_join', leftPath: 'points.geojson', rightPath: 'areas.geojson', leftCrs: 'EPSG:4326', rightCrs: 'EPSG:4326', predicate: 'within', cardinality: 'one-to-one', rightFields: ['name'] });
  const output = JSON.parse(fs.readFileSync(path.join(cwd, result.output.relativePath), 'utf8'));
  assert.equal(result.counts.output, 2);
  assert.equal(result.counts.unmatched, 1);
  assert.equal(output.features[0].properties.matched_right_id, 'district-a');
  assert.equal(output.features[0].properties.right_name, 'A');
});

test('spatial service rejects EPSG:4326 distance and session path escape', async (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-security-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  writeGeo(cwd, 'input.geojson', collection([point('p', [121, 31])]));
  await assert.rejects(service().analyze(session(cwd), { operation: 'buffer', inputPath: 'input.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:4326', distanceMeters: 10 }), /metricCrs cannot be EPSG:4326/);
  await assert.rejects(service().analyze(session(cwd), { operation: 'buffer', inputPath: '../outside.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10 }), /relative \.geojson|Unsafe/);
});
