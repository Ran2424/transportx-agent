const { test } = require('node:test') as typeof import('node:test');

test('Controlled spatial operations produce auditable results and reject CRS and path misuse', async (t) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { SpatialAnalysisService } = require('../../bin/spatial-analysis-service.js');
  const { parseSpatialAnalysisResultStructured } = require('../../bin/contracts/spatial.js');
  const PYTHON = process.env.TAU_PYTHON_COMMAND || 'python3';
  const SCRIPT = path.join(process.cwd(), 'modules/capabilities/spatial-analysis/scripts/spatial_analysis.py');

  function collection(features: any[]) { return { type: 'FeatureCollection', features }; }

  function point(id: string, coordinates: number[], properties: Record<string, unknown> = {}) { return { type: 'Feature', id, properties, geometry: { type: 'Point', coordinates } }; }

  function writeGeo(root: string, name: string, value: unknown) { fs.writeFileSync(path.join(root, name), `${JSON.stringify(value)}\n`); }

  function service() { return new SpatialAnalysisService({ command: PYTHON, args: [], version: '3.10' }, SCRIPT); }

  function session(cwd: string) { return { cwd } as any; }

  {
    const { spatialOwner } = require('../../bin/spatial-owner.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-owner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const histories = path.join(root, 'sessions'); fs.mkdirSync(histories);
    const file = path.join(histories, 'owner.jsonl');
    const owner = { cwd: root, sessionFile: file, resolvedSessionPlan: { workspace: root } };
    assert.throws(() => spatialOwner(owner, histories), /ENOENT/);
    fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'persistent_pi_id', cwd: root }) + '\n');
    const original = spatialOwner(owner, histories);
    assert.deepEqual(original, { historyKey: 'owner.jsonl', piSessionId: 'persistent_pi_id' });
    assert.deepEqual(spatialOwner({ ...owner, id: 'another_live_id' }, histories), original);
    fs.appendFileSync(file, JSON.stringify({ type: 'custom', id: 'branch-entry', parentId: null }) + '\n');
    assert.deepEqual(spatialOwner(owner, histories), original, 'branch entries do not change owner');
    const copied = path.join(histories, 'copy.jsonl'); fs.copyFileSync(file, copied);
    assert.notDeepEqual(spatialOwner({ ...owner, sessionFile: copied }, histories), original, 'raw history copies have distinct owners');
    assert.throws(() => spatialOwner({ ...owner, resolvedSessionPlan: { workspace: histories } }, histories), /mismatch/);
    assert.throws(() => spatialOwner({ ...owner, cwd: histories }, histories), /mismatch/);
    assert.throws(() => spatialOwner(owner, path.join(root, 'outside')), /escapes/);
  }

  // spatial result contract rejects unknown schema, operations and unsafe output paths
  {
    const result = parseSpatialAnalysisResultStructured({ protocol: 'transportx-spatial-analysis', schemaVersion: 2, operation: 'route', output: { relativePath: '../outside.geojson' } });
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.some((item: any) => item.code === 'unknown_schema_version'));
    assert.ok(result.diagnostics.some((item: any) => item.path === 'spatial.operation'));
  }

  // controlled buffer writes WGS84 GeoJSON and an auditable manifest
  {
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
    const { CitationService } = require('../../bin/citation-service.js');
    const citation = new CitationService(), owner = { id: 'spatial_owner', cwd };
    const registered = citation.registerSpatialResult(owner, result);
    assert.equal(registered.sources[0].executionRef.inputHashes[0], result.inputs[0].sha256);
    assert.equal(citation.detail(owner, registered.evidence[0].evidenceId).preview.kind, 'table');
    citation.registerSpatialResult(owner, result);
    assert.equal(citation.registry(owner).load().sources.length, 1, 'registration retry is idempotent');
    fs.writeFileSync(citation.registry(owner).filePath, '{"version":"2.0"}');
    assert.throws(() => citation.registerSpatialResult(owner, result), /Unsupported/);
    assert.ok(fs.existsSync(path.join(cwd, result.output.relativePath)), 'citation failure preserves successful analysis output');

  }

  // controlled nearest preserves unmatched left features and reports metric distance
  {
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
  }

  // controlled spatial join records point-to-area matches
  {
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
  }

  // spatial service rejects EPSG:4326 distance and session path escape
  {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-spatial-security-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    writeGeo(cwd, 'input.geojson', collection([point('p', [121, 31])]));
    await assert.rejects(service().analyze(session(cwd), { operation: 'buffer', inputPath: 'input.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:4326', distanceMeters: 10 }), /metricCrs cannot be EPSG:4326/);
    assert.equal(fs.existsSync(path.join(cwd, 'analysis')), false, 'semantic rejection creates no output directory');
    assert.equal(fs.existsSync(path.join(cwd, '.tau')), false, 'semantic rejection creates no manifest directory');
    await assert.rejects(service().analyze(session(cwd), { operation: 'buffer', inputPath: '../outside.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10 }), /relative \.geojson|Unsafe/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(service().analyze(session(cwd), { operation: 'buffer', inputPath: 'input.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10 }, controller.signal), /abort|cancel/i);
    assert.equal(fs.existsSync(path.join(cwd, '.tau/citations.json')), false, 'failed and cancelled analyses never create evidence');
    writeGeo(cwd, 'bad.geojson', collection([{ type: 'Feature', geometry: { type: 'Unsupported', coordinates: [] }, properties: {} }]));
    await assert.rejects(service().analyze(session(cwd), { operation: 'buffer', inputPath: 'bad.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10 }), (error: any) => error.code === 'spatial_execution_failed' && error.commit === 'not_committed');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.tau/spatial-results')), [], 'confirmed Python failure cleans only this call directories');
    assert.deepEqual(fs.readdirSync(path.join(cwd, 'analysis/spatial')), []);
  }
});
