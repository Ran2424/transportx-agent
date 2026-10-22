import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

export async function spatialHostSmoke({ root, endpoint, json, rpc, until, providerInputs }) {
  // The input program is an ordinary, standalone CSV script. The generated
  // adapter uses only the public Pi API, its packaged script and bundled Python.
  const source = path.join(root, 'traffic-peak'); fs.mkdirSync(source);
  const program = `import csv,json,sys\nfrom collections import defaultdict\ncounts=defaultdict(float)\nwith open(sys.argv[1],newline='',encoding='utf-8') as handle:\n for row in csv.DictReader(handle): counts[(row['road'],row['hour'])]+=float(row['volume'])\npeaks={}\nfor (road,hour),volume in counts.items():\n if road not in peaks or volume>peaks[road]['volume']: peaks[road]={'road':road,'hour':hour,'volume':volume}\nwith open(sys.argv[2],'w',newline='',encoding='utf-8') as handle:\n writer=csv.DictWriter(handle,fieldnames=['road','hour','volume']);writer.writeheader();writer.writerows(peaks.values())\nprint(json.dumps(list(peaks.values())))\n`;
  fs.writeFileSync(path.join(source, 'peak.py'), program);
  fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ manifestVersion: 2, id: 'local.traffic-peak', name: 'CSV peak-hour tool', version: '1.0.0', type: 'module', platformVersion: '>=3.0.0 <4.0.0', dependencies: [], entrypoints: { piExtensions: ['index.ts'] } }));
  fs.writeFileSync(path.join(source, 'index.ts'), `
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url'; import { Type } from 'typebox';
export default function(pi) {
 pi.registerTool({ name: 'traffic_peak_hour', label: 'Peak-hour volume', description: 'Sum CSV road/hour/volume rows and save the largest hourly volume per road. Hours are supplied by the input; no timezone conversion.', parameters: Type.Object({ inputPath: Type.String() }),
 async execute(id, params, signal, update, ctx) {
  if (path.isAbsolute(params.inputPath) || params.inputPath.split(/[\\\\/]/).some(part=>part==='..') || !params.inputPath.endsWith('.csv')) throw new Error('Use a task-relative CSV path');
  const input=path.resolve(ctx.cwd,params.inputPath), output=path.join(ctx.cwd,'analysis','traffic-peak.csv');
  fs.mkdirSync(path.dirname(output),{recursive:true});
  const result=await pi.exec(process.env.TAU_PYTHON_COMMAND,[path.join(path.dirname(fileURLToPath(import.meta.url)),'peak.py'),input,output],{signal,timeout:10000});
  if(result.code!==0) throw new Error(result.stderr || 'CSV program failed');
  return {content:[{type:'text',text:result.stdout.slice(0,4000)}],details:{kind:'local.traffic-peak',output:'analysis/traffic-peak.csv'}};
 }});
}`);
  assert.equal((await rpc({ type: 'install_module', sourcePath: source })).success, true);
  const created = await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), model: 'probe/smoke', name: 'P1 Spatial acceptance' });
  const session = created.session;
  const snapshot = () => json(`/api/live-sessions/${session.id}/snapshot`);
  const toolResults = (state) => state.entries.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message);
  async function execute(prefix, input) {
    const before = toolResults(await snapshot()).length;
    const start = performance.now();
    assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message: prefix + JSON.stringify(input) })).success, true);
    const state = await until(async () => { const state = await snapshot(); return toolResults(state).length > before && !state.isStreaming && state; }, 'real Pi tool result', 30000);
    return { result: toolResults(state).at(-1), elapsedMs: Math.round(performance.now() - start) };
  }
  fs.writeFileSync(path.join(session.cwd, 'volumes.csv'), 'road,hour,volume\nA,08,10\nA,08,20\nA,09,15\nB,08,7\n');
  const peak = await execute('traffic:', { inputPath: 'volumes.csv' });
  assert.equal(peak.result.isError, false);
  assert.equal(peak.result.details.kind, 'local.traffic-peak');
  assert.match(fs.readFileSync(path.join(session.cwd, peak.result.details.output), 'utf8'), /A,08,30/);
  assert.equal(fs.readFileSync(path.join(root, 'modules/local.traffic-peak/1.0.0/peak.py'), 'utf8'), program, 'the business script is packaged unchanged');
  fs.rmSync(source, { recursive: true });
  assert.equal((await execute('traffic:', { inputPath: 'volumes.csv' })).result.isError, false, 'installed code does not depend on the source package directory');
  assert.equal(fs.existsSync(path.join(session.cwd, '.tau/spatial-results')), false, 'a Pi-local tool needs no Host Invocation');
  assert.equal((await execute('traffic:', { inputPath: '../outside.csv' })).result.isError, true);

  const points = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'venue', properties: {}, geometry: { type: 'Point', coordinates: [121.44, 31.19] } }] };
  fs.writeFileSync(path.join(session.cwd, 'points.geojson'), JSON.stringify(points));
  fs.writeFileSync(path.join(session.cwd, 'stations.geojson'), JSON.stringify(points));
  fs.writeFileSync(path.join(session.cwd, 'areas.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { district: 'A' }, geometry: { type: 'Polygon', coordinates: [[[121, 31], [122, 31], [122, 32], [121, 32], [121, 31]]] } }] }));
  const buffer = { operation: 'buffer', inputPath: 'points.geojson', inputCrs: 'EPSG:4326', metricCrs: 'EPSG:32651', distanceMeters: 10 };
  const valid = [];
  for (const input of [buffer, { operation: 'nearest', leftPath: 'points.geojson', rightPath: 'stations.geojson', leftCrs: 'EPSG:4326', rightCrs: 'EPSG:4326', metricCrs: 'EPSG:32651' }, { operation: 'spatial_join', leftPath: 'points.geojson', rightPath: 'areas.geojson', leftCrs: 'EPSG:4326', rightCrs: 'EPSG:4326', predicate: 'within', cardinality: 'one-to-one' }]) {
    const actual = await execute('spatial:', input);
    assert.equal(actual.result.isError, false, JSON.stringify(actual.result));
    assert.equal(actual.result.details.kind, 'tau-spatial-analysis');
    assert.equal(actual.result.details.result.counts.output, 1);
    assert.ok(actual.result.details.citations.evidence.length);
    assert.ok(JSON.stringify(actual.result.content).length <= 6100, 'full GeoJSON never enters the model summary');
    valid.push({ operation: input.operation, elapsedMs: actual.elapsedMs, outputBytes: fs.statSync(path.join(session.cwd, actual.result.details.result.output.relativePath)).size });
  }
  const manifests = path.join(session.cwd, '.tau/spatial-results');
  const scale = [];
  for (const count of [1000, 50000]) {
    const inputPath = `scale-${count}.geojson`;
    fs.writeFileSync(path.join(session.cwd, inputPath), JSON.stringify({ ...points, features: Array.from({ length: count }, (_, id) => ({ ...points.features[0], id })) }));
    const actual = await execute('spatial:', { operation: 'spatial_join', leftPath: inputPath, rightPath: 'areas.geojson', leftCrs: 'EPSG:4326', rightCrs: 'EPSG:4326', predicate: 'within', cardinality: 'one-to-one' });
    assert.equal(actual.result.isError, false);
    assert.equal(actual.result.details.result.counts.output, count);
    assert.ok(JSON.stringify(actual.result.content).length <= 6100);
    scale.push({ features: count, elapsedMs: actual.elapsedMs, inputBytes: fs.statSync(path.join(session.cwd, inputPath)).size, outputBytes: fs.statSync(path.join(session.cwd, actual.result.details.result.output.relativePath)).size, summaryChars: JSON.stringify(actual.result.content).length });
  }
  const beforeInvalid = fs.readdirSync(manifests).sort();
  const invalid = await execute('spatial:', { ...buffer, metricCrs: 'EPSG:4326' });
  assert.equal(invalid.result.isError, true, 'structured failures use Pi error semantics');
  assert.equal(invalid.result.details.error.code, 'spatial_input_invalid');
  assert.deepEqual(fs.readdirSync(manifests).sort(), beforeInvalid);
  const unauthorized = await fetch(`${endpoint}/api/internal/spatial/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...buffer, sessionId: session.id, token: 'wrong-token' }) });
  assert.equal(unauthorized.status, 403);

  // The relay only alters delivery after the real production route has replied.
  // It never replaces Host authorization, Python execution or domain commit.
  let relayMode = 'drop', forwarded = 0, lastRequest;
  const relay = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url.endsWith('/analyze')) lastRequest = JSON.parse(raw);
    if (req.url.endsWith('/analyze')) forwarded++;
    const response = await fetch(endpoint + req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw });
    let body = await response.text();
    if (relayMode === 'drop' && req.url.endsWith('/analyze')) { res.destroy(); return; }
    if (relayMode === 'bad_citations' && req.url.endsWith('/analyze')) body = JSON.stringify({ ...JSON.parse(body), citations: { evidence: [null] } });
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(body);
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  try {
    assert.equal((await rpc({ type: 'prompt', sessionId: session.id, message: `/p1_spatial_endpoint http://127.0.0.1:${relay.address().port}` })).success, true);
    const lost = await execute('spatial-fail-model:', buffer);
    assert.equal(lost.result.isError, true);
    assert.equal(lost.result.details.error.code, 'spatial_result_unknown');
    assert.equal(forwarded, 1, 'a lost response never triggers a second calculation');
    assert.equal(fs.readdirSync(manifests).length, beforeInvalid.length + 1, 'the committed result survives response loss');
    const existingId = lost.result.details.error.operationId;
    assert.ok(existingId);
    const countBeforeQuery = fs.readdirSync(manifests).length;
    const recovered = await execute('spatial-status:', { action: 'query', operationId: existingId });
    assert.equal(recovered.result.isError, false);
    assert.equal(recovered.result.details.result.analysisId, existingId);
    const bytes = fs.readFileSync(path.join(session.cwd, recovered.result.details.result.output.relativePath));
    const replay = await fetch(endpoint + '/api/internal/spatial/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lastRequest) });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).reused, true);
    assert.equal(fs.readdirSync(manifests).length, countBeforeQuery);
    assert.deepEqual(fs.readFileSync(path.join(session.cwd, recovered.result.details.result.output.relativePath)), bytes);
    const conflict = await fetch(endpoint + '/api/internal/spatial/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...lastRequest, distanceMeters: 11 }) });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, 'spatial_operation_conflict');
    relayMode = 'bad_citations';
    const presentation = await execute('spatial:', buffer);
    assert.equal(presentation.result.isError, false, 'optional citation presentation cannot erase a confirmed analysis');
    assert.ok(presentation.result.details.citationWarning);
    assert.ok(presentation.result.details.result.output.relativePath);
    relayMode = 'pass';
    await rpc({ type: 'prompt', sessionId: session.id, message: `/p1_spatial_endpoint ${endpoint}` });
  } finally { relay.closeAllConnections(); await new Promise((resolve) => relay.close(resolve)); }

  const large = { ...points, features: Array.from({ length: 15000 }, (_, id) => ({ ...points.features[0], id })) };
  fs.writeFileSync(path.join(session.cwd, 'large.geojson'), JSON.stringify(large));
  const beforeCancel = fs.readdirSync(manifests).sort();
  const count = toolResults(await snapshot()).length;
  await rpc({ type: 'prompt', sessionId: session.id, message: 'spatial:' + JSON.stringify({ ...buffer, inputPath: 'large.geojson' }) });
  await until(() => fs.readdirSync(manifests).some((id) => !beforeCancel.includes(id) && fs.existsSync(path.join(manifests, id, 'request.json'))), 'real Python request started');
  await rpc({ type: 'abort', sessionId: session.id });
  await until(async () => { const state = await snapshot(); return !state.isStreaming && toolResults(state).length > count; }, 'cancelled Pi call settles');
  const cancelled = toolResults(await snapshot()).at(-1);
  assert.equal(cancelled.isError, true);
  assert.ok(['spatial_result_unknown', 'spatial_cancelled'].includes(cancelled.details.error.code), 'cancellation stays unknown unless Host confirms no commit');
  await until(() => JSON.stringify(fs.readdirSync(manifests).sort()) === JSON.stringify(beforeCancel), 'confirmed process stop cleans call directories');

  // Consume this run's actual Tool Results through the production UI/history.
  const browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  try {
    const page = await browser.newPage({ locale: 'zh-CN' });
    await page.goto(endpoint, { waitUntil: 'domcontentloaded' });
    await page.locator('.session-row').filter({ hasText: 'P1 Spatial acceptance' }).first().click();
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    const details = page.getByRole('switch', { name: '显示执行详情', exact: true });
    if (await details.getAttribute('aria-checked') !== 'true') await details.click();
    await page.keyboard.press('Escape');
    await page.locator('.tool-status.unknown').first().waitFor();
    assert.ok(await page.locator('.tool-state-label').filter({ hasText: /结果未知|Result unknown/ }).count());
    await page.getByText('本轮工具结果未知，请先核验已有成果，再决定下一步。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /准备重试|Prepare retry/ }).count(), 0, 'a later model failure must not offer a blind prompt replay');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('.tool-status.unknown').first().waitFor();
  } finally { await browser.close(); }
  const state = await snapshot();
  const history = fs.readFileSync(state.sessionFile, 'utf8');
  assert.match(history, /local.traffic-peak/); assert.match(history, /spatial_result_unknown/);
  const modelResults = JSON.stringify(providerInputs.flatMap((request) => request.messages.filter((message) => message.role === 'tool')));
  assert.match(modelResults, /spatial_result_unknown/); assert.match(modelResults, /spatial_input_invalid/); assert.match(modelResults, /Spatial analysis spatial_/);
  return { valid, scale, independentCsvPackage: true, semanticRejectionNoDirectories: true, authorizationDenied: true, responseLossPreservesManifest: true, optionalCitationWarningRetainsResult: true, noAutomaticRetry: true, cancellationOutcome: cancelled.details.error.code, cancellationClearsDirectories: true, realResultsUiAndReload: true, unknownBlocksPromptReplayAfterModelFailure: true, modelHttpResultsVerified: true };
}
