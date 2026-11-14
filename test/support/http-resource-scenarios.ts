import type { TestContext } from 'node:test';
import type { HttpHostFixture } from './http-host-fixture.ts';

async function assertHttpResourceAuthorization(fixture: HttpHostFixture, t: TestContext) {
  const assert = require('node:assert/strict');
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { testSymlink } = require('./symlink.ts');
  const { base, fakeSession, fakeVideoResource, geoPublication, jsonBody, liveManager, persistResourceContext, registerSession, request, videoAuthorization, writeJsonAtomic } = fixture;

  // serves only session-scoped GeoJSON and supports ETag revalidation
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-resource-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const geojson = JSON.stringify({ type: 'FeatureCollection', features: [] });
    const sha256 = crypto.createHash('sha256').update(geojson).digest('hex');
    const resourceId = `geo_${sha256.slice(0, 24)}`;
    const dir = path.join(cwd, '.tau', 'geo-resources', resourceId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.geojson'), geojson);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ resourceId, sha256, bytes: Buffer.byteLength(geojson), featureCount: 0 }));
    const session = fakeSession('tau_geo');
    session.cwd = cwd; session.resolvedSessionPlan = { modules: [{ id: 'com.transportx.geo' }] }; geoPublication(session, resourceId);
    registerSession(session);

    const url = `${base}/api/conversations/${session.conversationId}/geo-resources/${resourceId}/data`;
    const resource = await request(url);
    assert.equal(resource.headers.get('etag'), `"${sha256}"`);
    assert.deepEqual(await jsonBody(resource), { type: 'FeatureCollection', features: [] });
    assert.equal((await request(url, { headers: { 'If-None-Match': `"${sha256}"` } })).status, 304);
    assert.equal((await request(`${base}/api/conversations/${session.conversationId}/geo-resources/..%2Fsecret/data`)).status, 400);
    fs.writeFileSync(path.join(dir, 'data.geojson'), geojson.replace('FeatureCollection', 'FeatureCollectioN'));
    assert.equal((await request(url, { headers: { 'If-None-Match': `"${sha256}"` } })).status, 409);
    assert.equal((await request(url.replace('/data', '/manifest'))).status, 409);
  }

  // video resources support GET, HEAD and single byte ranges
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-resource-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const resourceId = `video_${'c'.repeat(16)}`;
    const payload = crypto.randomBytes(2048);
    fakeVideoResource(cwd, resourceId, payload);
    const session = fakeSession('tau_video');
    session.cwd = cwd; videoAuthorization(session, resourceId);
    registerSession(session);

    const url = `${base}/api/conversations/${session.conversationId}/video-resources/${resourceId}/data`;
    const full = await request(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.equal(full.headers.get('cache-control'), 'private, no-store');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Number(full.headers.get('content-length')), payload.length);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload);

    const head = await request(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), payload.length);
    assert.equal(await head.text(), '');

    const ranged = await request(url, { headers: { Range: 'bytes=100-199' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 100-199/${payload.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), payload.subarray(100, 200));

    const suffix = await request(url, { headers: { Range: 'bytes=-50' } });
    assert.equal(suffix.status, 206);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), payload.subarray(payload.length - 50));

    const open = await request(url, { headers: { Range: 'bytes=2000-' } });
    assert.equal(open.status, 206);
    assert.equal(open.headers.get('content-range'), `bytes 2000-${payload.length - 1}/${payload.length}`);

    for (const range of ['bytes=5000-6000', 'bytes=200-100', 'items=0-10', 'bytes=']) {
      const response = await request(url, { headers: { Range: range } });
      assert.equal(response.status, 416, range);
      assert.equal(response.headers.get('content-range'), `bytes */${payload.length}`);
    }
  }

  // video resources are bound to their owning session and validated manifests
  {
    liveManager.sessions.clear();
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-owner-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-other-'));
    t.after(() => { fs.rmSync(firstRoot, { recursive: true, force: true }); fs.rmSync(secondRoot, { recursive: true, force: true }); });
    const resourceId = `video_${'d'.repeat(16)}`;
    fakeVideoResource(firstRoot, resourceId, crypto.randomBytes(128));
    const owner = fakeSession('tau_video_owner'); owner.cwd = firstRoot; videoAuthorization(owner, resourceId);
    const other = fakeSession('tau_video_other'); other.cwd = secondRoot;
    registerSession(owner); registerSession(other);

    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/video-resources/${resourceId}/data`)).status, 200);
    assert.equal((await request(`${base}/api/conversations/${other.conversationId}/video-resources/${resourceId}/data`)).status, 404, 'cross-session resourceId is rejected');
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/video-resources/..%2Fsecret/data`)).status, 400);
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/video-resources/video_xyz/data`)).status, 400, 'malformed resource id');
    persistResourceContext(owner);
    const historicalVideo = await request(`${base}/api/conversations/${owner.conversationId}/video-resources/${resourceId}/data`, { headers: { Range: 'bytes=0-9' } });
    assert.equal(historicalVideo.status, 206);
    assert.equal((await historicalVideo.arrayBuffer()).byteLength, 10);

    // Manifest/bytes mismatch is reported as a conflict, not served silently.
    const manifestPath = path.join(firstRoot, '.tau', 'video-resources', resourceId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.bytes = 1;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/video-resources/${resourceId}/data`)).status, 409);

    // A symlinked resource dir never escapes the session root.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-outside-'));
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'video.mp4'), 'secret');
    fs.writeFileSync(path.join(outside, 'manifest.json'), '{}');
    await testSymlink(t, 'symlinked video resource cannot escape the session root', outside, path.join(firstRoot, '.tau', 'video-resources', `video_${'e'.repeat(16)}`), async () => {
      const linkId = `video_${'e'.repeat(16)}`;
      assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/video-resources/${linkId}/data`)).status, 403);
    }, 'dir');
  }

  // video metric API exposes only declared, session-scoped time-series data
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-metrics-'));
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-video-metrics-data-'));
    t.after(() => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(dataRoot, { recursive: true, force: true }); });
    const resourceId = `video_${'f'.repeat(16)}`;
    fakeVideoResource(cwd, resourceId, crypto.randomBytes(64));
    fs.mkdirSync(path.join(dataRoot, 'metrics'), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, 'metrics', 'visible_people.csv'), 'relative_second,absolute_time,value\n0,2026-08-16T08:00:00+08:00,3\n1,2026-08-16T08:00:01+08:00,4\n');
    fs.writeFileSync(path.join(dataRoot, 'videos.json'), JSON.stringify({ schemaVersion: 1, videos: [{ videoId: 'video_001', title: '测试视频', startTime: '2026-08-16T08:00:00+08:00', endTime: '2026-08-16T08:01:00+08:00', file: 'videos/test.mp4', mimeType: 'video/mp4', metrics: [{ id: 'visible_people', label: '画面人数', unit: '人', file: 'metrics/visible_people.csv', sampleIntervalSeconds: 1 }] }] }));
    const session = fakeSession('tau_video_metrics') as any;
    session.cwd = cwd;
    fs.mkdirSync(path.join(dataRoot, 'videos'), { recursive: true }); fs.copyFileSync(path.join(cwd, '.tau/video-resources', resourceId, 'video.mp4'), path.join(dataRoot, 'videos/test.mp4'));
    const videoManifest = path.join(cwd, '.tau/video-resources', resourceId, 'manifest.json'); writeJsonAtomic(videoManifest, { ...JSON.parse(fs.readFileSync(videoManifest, 'utf8')), sourceAssetId: 'data:test-video', sourceRelativePath: 'videos/test.mp4' });
    session.resolvedSessionPlan = { modules: [{ id: 'com.transportx.video' }], assets: [{ id: 'data:test-video', kind: 'data', path: dataRoot }] };
    registerSession(session);

    const response = await request(`${base}/api/conversations/${session.conversationId}/video-resources/${resourceId}/metrics`);
    assert.equal(response.status, 200);
    assert.deepEqual(await jsonBody(response), { metrics: [{ id: 'visible_people', label: '画面人数', unit: '人', sampleIntervalSeconds: 1, samples: [{ offsetSeconds: 0, value: 3 }, { offsetSeconds: 1, value: 4 }] }] });
    persistResourceContext(session);
    assert.equal((await request(`${base}/api/conversations/${session.conversationId}/video-resources/${resourceId}/metrics`)).status, 200);
  }

  // Geo resources cannot be read through another live session
  {
    liveManager.sessions.clear();
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-owner-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-other-'));
    t.after(() => { fs.rmSync(firstRoot, { recursive: true, force: true }); fs.rmSync(secondRoot, { recursive: true, force: true }); });
    const resourceId = `geo_${'b'.repeat(24)}`;
    const dir = path.join(firstRoot, '.tau', 'geo-resources', resourceId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ resourceId, sha256: crypto.createHash('sha256').update(JSON.stringify({ type: 'FeatureCollection', features: [] })).digest('hex'), bytes: 42, featureCount: 0 }));
    const owner = fakeSession('tau_geo_owner'); owner.cwd = firstRoot; owner.resolvedSessionPlan = { modules: [{ id: 'com.transportx.geo' }] }; geoPublication(owner, resourceId);
    const other = fakeSession('tau_geo_other'); other.cwd = secondRoot;
    registerSession(owner); registerSession(other);
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/geo-resources/${resourceId}/data`)).status, 200);
    assert.equal((await request(`${base}/api/conversations/${other.conversationId}/geo-resources/${resourceId}/data`)).status, 404);
    // History browsing reads published data without starting a runtime.
    const planFile = path.join(firstRoot, '.tau/conversations', owner.conversationId, 'plan.json');
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const geoModules = [{ id: 'com.transportx.geo', version: '1.5.0', type: 'capability', origin: 'builtin', packageRoot: path.resolve('modules/capabilities/geo'), entrypoints: [] }];
    writeJsonAtomic(planFile, { ...plan, modules: geoModules });
    fs.appendFileSync(owner.sessionFile, JSON.stringify({ ...owner.entries[0], id: 'geo-publication', parentId: null }) + '\n');
    liveManager.sessions.delete(owner.id);
    const historicalUrl = `${base}/api/conversations/${owner.conversationId}/geo-resources/${resourceId}`;
    const historicalData = await request(`${historicalUrl}/data`);
    assert.equal(historicalData.status, 200, await historicalData.text());
    assert.equal((await request(`${historicalUrl}/manifest`)).status, 200);
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/resources`)).status, 200);
    const { DOCUMENT_CANVAS_ADAPTER_ID, CANVAS_PRESENTATION_VERSION } = require('../../bin/contracts/index.js');
    writeJsonAtomic(planFile, { ...plan, modules: [...geoModules, { ...geoModules[0], id: 'com.transportx.canvas', canvasViews: [{ adapterId: DOCUMENT_CANVAS_ADAPTER_ID, kind: 'document', protocolVersion: CANVAS_PRESENTATION_VERSION }] }] });
    fs.writeFileSync(path.join(firstRoot, 'report.md'), '# Historical report');
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/canvas-presentations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adapterId: DOCUMENT_CANVAS_ADAPTER_ID, resource: { scope: 'session-file', path: 'report.md' } }) })).status, 200);
    assert.equal(liveManager.sessions.has(owner.id), false);
    const unpublished = fakeSession('tau_geo_unpublished'); unpublished.cwd = firstRoot;
    registerSession(unpublished);
    const unpublishedPlan = path.join(firstRoot, '.tau/conversations', unpublished.conversationId, 'plan.json');
    writeJsonAtomic(unpublishedPlan, { ...plan, modules: geoModules });
    liveManager.sessions.delete(unpublished.id);
    assert.equal((await request(`${base}/api/conversations/${unpublished.conversationId}/geo-resources/${resourceId}/data`)).status, 403);
    fs.appendFileSync(path.join(dir, 'data.geojson'), ' ');
    assert.equal((await request(`${historicalUrl}/data`)).status, 409);
  }

  // Geo interaction routes enforce capability, token scope and terminal response
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-geo-routes-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const resourceId = `geo_${'c'.repeat(24)}`;
    const geojson = JSON.stringify({
      type: 'FeatureCollection', features: [
        { type: 'Feature', id: 'road-1', properties: { name: '一号路', secret: 'not-exposed' }, geometry: { type: 'LineString', coordinates: [[121.4, 31.1], [121.5, 31.3]] } },
      ]
    });
    const resourceDir = path.join(cwd, '.tau', 'geo-resources', resourceId);
    fs.mkdirSync(resourceDir, { recursive: true });
    fs.writeFileSync(path.join(resourceDir, 'data.geojson'), geojson);
    fs.writeFileSync(path.join(resourceDir, 'manifest.json'), JSON.stringify({
      resourceId,
      sha256: crypto.createHash('sha256').update(geojson).digest('hex'),
      bytes: Buffer.byteLength(geojson),
      featureCount: 1,
    }));
    const envelope = {
      protocol: 'pi-visualization', version: '1.0', kind: 'geo', visualizationId: 'route_map', revision: 1, operation: 'replace',
      scene: {
        view: { mode: 'bounds', bounds: [121.4, 31.1, 121.5, 31.3] }, basemap: { id: 'light' },
        sources: [{ id: 'roads_source', type: 'geojson-resource', resourceId }],
        layers: [{ id: 'roads', sourceId: 'roads_source', type: 'line', encoding: { color: { mode: 'constant', value: '#2563eb' } }, popup: { fields: [{ field: 'name', label: '名称' }] } }],
        metadata: { title: '道路' },
      },
      summary: { title: '道路' }, generatedAt: '2026-09-02T00:00:00.000Z',
    };
    const session = fakeSession('tau_geo_routes') as any;
    session.cwd = cwd;
    session.entries = [{ type: 'message', message: { role: 'toolResult', details: { visualization: envelope } } }];
    session.resolvedSessionPlan = { modules: [] };
    session.activeGeoContextIds = []; geoPublication(session, resourceId);
    registerSession(session);
    const context = {
      version: 1,
      contextId: `geoctx_${'a'.repeat(16)}`,
      visualizationId: 'route_map',
      sceneRevision: 1,
      mode: 'feature',
      createdAt: '2026-09-02T01:00:00.000Z',
      view: { center: [121.45, 31.2], zoom: 12, bounds: [121.4, 31.1, 121.5, 31.3], bearing: 0, pitch: 0 },
      visibleLayerIds: ['roads'],
      selection: { layerId: 'roads', featureIds: ['road-1'] },
      summary: 'client summary',
    };
    const contextUrl = `${base}/api/conversations/${session.conversationId}/geo-contexts`;
    const unavailable = await request(contextUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context) });
    assert.equal(unavailable.status, 409);
    assert.equal(fs.existsSync(path.join(cwd, '.tau', 'geo-interactions')), false);

    session.resolvedSessionPlan.modules = [{ id: 'com.transportx.geo' }];
    persistResourceContext(session);
    const createdResponse = await request(contextUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(context) });
    assert.equal(createdResponse.status, 200);
    const created = await jsonBody(createdResponse);
    assert.equal(created.context.summary, 'client summary');
    assert.equal(created.provenance.geoResourceId, resourceId);
    const restored = await jsonBody(await request(`${contextUrl}/${context.contextId}`));
    assert.equal(restored.context.contextId, context.contextId);
    const screenshotResponse = await request(`${base}/api/conversations/${session.conversationId}/geo-screenshots`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visualizationId: 'route_map', sceneRevision: 1, dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6sAAAAASUVORK5CYII=' }),
    });
    assert.equal(screenshotResponse.status, 200);
    const screenshot = await jsonBody(screenshotResponse);
    assert.equal(path.dirname(screenshot.path), fs.realpathSync(cwd));
    assert.equal(fs.existsSync(screenshot.path), true);
    assert.equal(liveManager.sessions.has(session.id), false, 'map context and screenshot do not start Pi');
    liveManager.sessions.set(session.id, session);

    let screenshotRequestId = '';
    const broadcast = liveManager.broadcast.bind(liveManager);
    liveManager.broadcast = (data: any) => {
      if (data?.type === 'geo_screenshot_updated' && data.request?.requestId) screenshotRequestId = data.request.requestId;
      broadcast(data);
    };
    t.after(() => { liveManager.broadcast = broadcast; });
    const agentScreenshotPromise = request(`${base}/api/internal/geo/screenshot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, token: 'geo-token', visualizationId: 'route_map', sceneRevision: 1 }),
    });
    for (let attempt = 0; attempt < 50 && !screenshotRequestId; attempt += 1) {
      if (!screenshotRequestId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(screenshotRequestId, /^geoshot_/);
    const agentScreenshotResponse = await request(`${base}/api/conversations/${session.conversationId}/geo-screenshots/${screenshotRequestId}/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'captured', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl6sAAAAASUVORK5CYII=' }),
    });
    assert.equal(agentScreenshotResponse.status, 200);
    const agentScreenshot = await jsonBody(await agentScreenshotPromise);
    assert.equal(agentScreenshot.result.status, 'captured');
    assert.equal(agentScreenshot.result.relativePath, agentScreenshot.result.filename);

    const inspectUrl = `${base}/api/internal/geo/inspect`;
    assert.equal((await request(inspectUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, token: 'wrong', contextIds: [context.contextId] }) })).status, 403);
    session.activeGeoContextIds = [context.contextId];
    const inspected = await jsonBody(await request(inspectUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: session.id, token: 'geo-token' }) }));
    assert.equal(inspected.result.source, 'active_prompt');
    assert.equal(inspected.result.contexts[0].summary, '1 selected feature(s) in layer roads');
    assert.deepEqual(inspected.result.contexts[0].features, [{ id: 'road-1', properties: { name: '一号路' } }]);

    const requestPromise = request(`${base}/api/internal/geo/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, token: 'geo-token', visualizationId: 'route_map', sceneRevision: 1, mode: 'viewport', prompt: '请确认当前视野' }),
    });
    let requestId = '';
    const requestsRoot = path.join(cwd, '.tau', 'conversations', session.conversationId, 'geo-interactions', 'requests');
    for (let attempt = 0; attempt < 50 && !requestId; attempt += 1) {
      if (fs.existsSync(requestsRoot)) requestId = fs.readdirSync(requestsRoot)[0] || '';
      if (!requestId) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.match(requestId, /^georeq_/);
    const { selection: _selection, ...contextWithoutSelection } = context;
    const responseContext = { ...contextWithoutSelection, contextId: `geoctx_${'b'.repeat(16)}`, mode: 'viewport' };
    const responded = await jsonBody(await request(`${base}/api/conversations/${session.conversationId}/geo-interactions/${requestId}/respond`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'submitted', context: responseContext }),
    }));
    assert.equal(responded.response.status, 'submitted');
    const requestResult = await jsonBody(await requestPromise);
    assert.equal(requestResult.result.response.status, 'submitted');
    assert.equal(requestResult.result.context.contextId, responseContext.contextId);
  }

  // serves Registry-backed citation resources without exposing arbitrary session files
  {
    liveManager.sessions.clear();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-citation-resource-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const report = Buffer.from('# 交通报告\n\n拥堵集中在入口。');
    fs.writeFileSync(path.join(cwd, 'report.md'), report);
    fs.writeFileSync(path.join(cwd, 'secret.txt'), 'not cited');
    const sha256 = crypto.createHash('sha256').update(report).digest('hex');
    const resourceId = `resource:${sha256.slice(0, 24)}`;
    const registry = { protocol: 'pi-citation', version: '3.0', schemaVersion: 2, sessionId: 'tau_citation_owner', sources: [{ sourceVersionId: resourceId, sourceKey: 'session:report.md', title: '交通报告', acquiredAt: '2026-10-16', content: { kind: 'file', scope: 'session', path: 'report.md', mimeType: 'text/markdown', sha256, size: report.length } }], evidence: [{ evidenceId: 'e_report', sourceVersionId: resourceId, locator: { kind: 'document', section: '结论' }, contentKind: 'summary' }] };
    fs.mkdirSync(path.join(cwd, '.tau'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.tau', 'citations.json'), JSON.stringify(registry));
    const owner = fakeSession('tau_citation_owner');
    owner.cwd = cwd;
    const other = fakeSession('tau_citation_other');
    other.cwd = cwd;
    registerSession(owner);
    registerSession(other);
    const url = `${base}/api/conversations/${owner.conversationId}/citation-resources/${encodeURIComponent(resourceId)}/content`;
    const response = await request(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), report.toString());
    assert.equal(response.headers.get('etag'), `"${sha256}"`);
    persistResourceContext(owner);
    assert.equal((await request(url)).status, 200);
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/citations`)).status, 200);
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/citations/evidence/e_report`)).status, 200);
    assert.equal(liveManager.sessions.has(owner.id), false, 'citation browsing does not start Pi');
    liveManager.sessions.set(owner.id, owner);
    const head = await request(url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(report.length));
    assert.equal(await head.text(), '');
    const download = await request(`${url}?download=1`);
    assert.match(String(download.headers.get('content-disposition')), /^attachment;/);
    assert.equal((await request(`${url}?sha256=${sha256}`)).status, 200);
    const mismatch = await request(`${url}?sha256=${'b'.repeat(64)}`);
    assert.equal(mismatch.status, 409, 'a view pinned to another registry version cannot read current bytes');
    assert.equal(mismatch.headers.get('X-Citation-Error'), 'view-mismatch');
    assert.equal((await jsonBody(mismatch)).code, 'view-mismatch');
    const rewritten = Buffer.from('# 交通报告\n\n入口拥堵已缓解。');
    fs.writeFileSync(path.join(cwd, 'report.md'), rewritten);
    assert.equal((await request(`${url}?sha256=${sha256}`)).status, 409);
    const changedHead = await request(url, { method: 'HEAD' });
    assert.equal(changedHead.status, 409);
    assert.equal(changedHead.headers.get('X-Citation-Error'), 'content-changed');
    assert.equal(await changedHead.text(), '');
    assert.equal((await request(`${url}?download=1`)).status, 409);
    assert.equal((await request(`${base}/api/conversations/${other.conversationId}/citation-resources/${encodeURIComponent(resourceId)}/content`)).status, 409, 'shared citations retain their frozen content version');
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/citation-resources/missing/content`)).status, 404);
    const citations = await jsonBody(await request(`${base}/api/conversations/${owner.conversationId}/citations?limit=1`));
    assert.equal(citations.citations.evidence[0].evidenceId, 'e_report');
    const changedDetail = await jsonBody(await request(`${base}/api/conversations/${owner.conversationId}/citations/evidence/e_report`));
    assert.equal(changedDetail.source.sourceVersionId, resourceId);
    assert.equal(changedDetail.preview.code, 'content-changed');
    const currentUrl = `${base}/api/conversations/${owner.conversationId}/files/raw?${new URLSearchParams({ path: 'report.md' })}`;
    assert.equal((await request(currentUrl, { method: 'HEAD' })).status, 200);
    assert.equal(await (await request(currentUrl)).text(), rewritten.toString());
    const { CitationService } = require('../../bin/citation-service.js');
    const revised = new CitationService().resolve(owner, [{ path: 'report.md', locator: { kind: 'source' }, contentKind: 'source-only' }]);
    const revisedUrl = `${base}/api/conversations/${owner.conversationId}/citation-resources/${revised.sources[0].sourceVersionId}/content`;
    assert.equal(await (await request(`${revisedUrl}?download=1`)).text(), rewritten.toString());
    assert.equal((await request(url)).status, 409, 'registering the revision never rewrites the old citation');
    fs.rmSync(path.join(cwd, 'report.md'));
    const missing = await request(url);
    assert.equal(missing.status, 404);
    assert.equal((await jsonBody(missing)).code, 'missing');
    assert.equal((await request(currentUrl, { method: 'HEAD' })).status, 404);
    fs.writeFileSync(path.join(cwd, 'report.md'), report);
    const detail = await jsonBody(await request(`${base}/api/conversations/${owner.conversationId}/citations/evidence/e_report`));
    assert.equal(detail.preview.kind, 'text');
    assert.equal((await request(`${base}/api/conversations/${owner.conversationId}/citations/occurrences`, { method: 'POST' })).status, 404);

    // A rejected mixed registration explains how to retry without losing either kind of evidence.
    Object.assign(owner, { resolvedSessionPlan: { modules: [{ id: 'com.transportx.citation' }] } });
    const register = (input: Record<string, unknown>) => request(`${base}/api/internal/citations/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: owner.id, token: 'citation-token', ...input }) });
    const sources = [{ path: 'report.md', locator: { kind: 'source' }, contentKind: 'source-only', deliverable: true }];
    const webUrls = ['https://public.example/report'];
    const mixed = await register({ sources, webUrls });
    assert.equal(mixed.status, 400);
    assert.match((await jsonBody(mixed)).error, /separate calls/);
    const localResponse = await register({ sources });
    assert.equal(localResponse.status, 200);
    const local = await jsonBody(localResponse);
    assert.deepEqual(local.deliverableEvidenceIds, [local.citations.evidence[0].evidenceId]);
    const lookup = t.mock.method(require('node:dns/promises'), 'lookup', async () => [{ address: '1.1.1.1', family: 4 }]);
    const httpsRequest = t.mock.method(require('node:https'), 'request', (_options: unknown, respond: (value: any) => void) => {
      const response = require('node:stream').Readable.from([Buffer.from('<html>public original</html>')]);
      response.headers = { 'content-type': 'text/html' }; response.statusCode = 200;
      const outgoing = new EventEmitter(); outgoing.setTimeout = () => {}; outgoing.end = () => respond(response);
      return outgoing;
    });
    try {
      const webResponse = await register({ webUrls });
      assert.equal(webResponse.status, 200);
      const web = await jsonBody(webResponse);
      assert.equal(web.citations.sources[0].metadata.url, webUrls[0]);
      const registered = (await jsonBody(await request(`${base}/api/conversations/${owner.conversationId}/citations`))).citations;
      for (const evidence of [...local.citations.evidence, ...web.citations.evidence]) assert.ok(registered.evidence.some((item: any) => item.evidenceId === evidence.evidenceId));
    } finally { lookup.mock.restore(); httpsRequest.mock.restore(); }
  }
}

module.exports = { assertHttpResourceAuthorization };
