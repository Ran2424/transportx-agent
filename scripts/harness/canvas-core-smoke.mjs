import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

// Production Host + real Pi tools + real browser. Only model selection is scripted.
export async function canvasCoreSmoke({ root, endpoint, json, rpc, until }) {
  let session = (await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), model: 'probe/smoke', name: 'Canvas core acceptance' })).session;
  const snapshot = () => json(`/api/live-sessions/${session.id}/snapshot`);
  const results = (state) => state.entries.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message);
  async function execute(tool, params, extra = {}) {
    const before = results(await snapshot()).length;
    const ack = await rpc({ type: 'prompt', sessionId: session.id, message: 'core:' + JSON.stringify({ tool, params }), ...extra });
    assert.equal(ack.success, true, JSON.stringify(ack));
    const state = await until(async () => { const value = await snapshot(); return !value.isStreaming && results(value).length > before && value; }, `real ${tool}`, 40000);
    return results(state).at(-1);
  }
  const success = (result) => { assert.equal(result.isError, false, JSON.stringify(result)); return result.details; };
  const browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 960 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.addInitScript((id) => { if (window === window.top) localStorage.setItem('tau-active-live-session-id', id); }, session.id);
    await page.goto(endpoint);
    await page.getByLabel('消息输入').waitFor();
    fs.writeFileSync(path.join(session.cwd, 'report.md'), '# Core Canvas report\n\n## Conclusion\n\nOriginal content.');
    fs.writeFileSync(path.join(session.cwd, 'counts.csv'), 'road,volume\nA,12\nB,24\n');
    const pdf = await browser.newPage();
    await pdf.setContent('<section style="break-after:page">Canvas page 1</section><section>Canvas page 2</section>');
    fs.writeFileSync(path.join(session.cwd, 'report.pdf'), await pdf.pdf()); await pdf.close();
    const present = { adapterId: 'com.transportx.canvas.document', resource: { scope: 'session-file', path: 'report.md' } };
    const opened = success(await execute('canvas_present', present)).canvas;
    await page.locator('[data-testid=document-workspace] h1', { hasText: 'Core Canvas report' }).waitFor();
    const stamp = fs.statSync(path.join(session.cwd, 'report.md')).mtime;
    fs.writeFileSync(path.join(session.cwd, 'report.md'), '# Core Canvas report\n\n## Conclusion\n\nUpdated content.');
    fs.utimesSync(path.join(session.cwd, 'report.md'), stamp, stamp);
    const updated = success(await execute('canvas_present', { viewId: opened.viewId, operation: 'update' })).canvas;
    assert.ok(updated.revision > opened.revision);
    await page.locator('.canvas-panel:not([hidden])').getByText('Updated content.', { exact: true }).waitFor();
    const focused = success(await execute('canvas_present', { viewId: opened.viewId, operation: 'focus', target: { kind: 'locator', section: 'Conclusion' } })).canvas;
    assert.equal(focused.revision, updated.revision);
    success(await execute('canvas_present', { ...present, resource: { scope: 'session-file', path: 'counts.csv' }, target: { kind: 'rows', start: 1, end: 2 } }));
    await page.locator('.canvas-panel:not([hidden]) table').getByText('24', { exact: true }).waitFor();
    success(await execute('canvas_present', { ...present, resource: { scope: 'session-file', path: 'report.pdf' }, target: { kind: 'page', number: 2 } }));
    await page.locator('.canvas-panel:not([hidden]) iframe[src*="page=2"]').waitFor();

    const citations = success(await execute('tau_resolve_citation', { sources: [{ path: 'report.md', locator: { kind: 'document', section: 'Conclusion' }, contentKind: 'source-only' }] })).citations;
    const pinned = success(await execute('canvas_present', { ...present, resource: { scope: 'capability', moduleId: 'com.transportx.citation', resourceId: citations.sources[0].sourceVersionId } })).canvas;
    const context = (await json(`/api/sessions/${session.id}/canvas-contexts`, { viewId: pinned.viewId, revision: pinned.revision, target: { kind: 'locator', section: 'Conclusion' } })).context;
    const inspected = success(await execute('canvas_inspect_context', { contextIds: [context.contextId] }, { canvasContextIds: [context.contextId] }));
    assert.equal(inspected.contexts[0].contextId, context.contextId);
    assert.equal((await execute('canvas_inspect_context', { contextIds: [context.contextId] })).isError, true, 'old contexts do not leak into a new turn');
    assert.equal((await execute('canvas_present', { ...present, resource: { scope: 'session-file', path: '../outside.md' } })).isError, true);

    fs.writeFileSync(path.join(session.cwd, 'points.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 1, properties: { name: 'A' }, geometry: { type: 'Point', coordinates: [121.44, 31.19] } }] }));
    const published = success(await execute('publish_geodata', { path: 'points.geojson' })).resource;
    const map = success(await execute('present_visualization', { command: 'create_map', visualizationId: 'core_map', title: 'Core map', resourceId: published.resourceId, layerType: 'circle', basemap: 'none' }));
    await page.locator('.canvas-panel:not([hidden]) .geo-map canvas').waitFor();
    const screenshot = success(await execute('capture_geo_screenshot', { visualizationId: 'core_map', sceneRevision: map.visualization.revision }));
    assert.ok(fs.statSync(path.join(session.cwd, screenshot.result.relativePath)).size > 8);
    const pendingInput = execute('request_geo_input', { visualizationId: 'core_map', sceneRevision: 1, mode: 'viewport', prompt: 'Confirm this map extent', timeoutSeconds: 30 });
    const banner = page.locator('.geo-request-banner');
    await banner.waitFor();
    await banner.getByRole('button', { name: '提交', exact: true }).click();
    const selected = success(await pendingInput).result;
    assert.equal(selected.response.status, 'submitted');
    const geo = success(await execute('inspect_map_context', { contextIds: [selected.context.contextId] }));
    assert.equal(geo.result.contexts[0].mode, 'viewport');
    success(await execute('canvas_present', { viewId: map.canvas.viewId, operation: 'focus' }));
    const geoContext = (await json(`/api/sessions/${session.id}/canvas-contexts`, { viewId: map.canvas.viewId, revision: 1 })).context;
    assert.equal(success(await execute('canvas_inspect_context', { contextIds: [geoContext.contextId] }, { canvasContextIds: [geoContext.contextId] })).contexts[0].adapterId, 'com.transportx.canvas.geo');

    const asking = execute('tau_ask_user', { kind: 'confirm', title: 'Core interaction', message: 'Confirm fixture action?' });
    await page.getByRole('dialog', { name: 'Core interaction', exact: true }).getByRole('button', { name: '是', exact: true }).click();
    assert.equal(success(await asking).value, true);
    const overview = (await rpc({ type: 'get_platform_overview', sessionId: session.id })).data;
    const diagnostics = overview.modules.filter((module) => ['com.transportx.canvas', 'com.transportx.geo', 'com.transportx.interaction'].includes(module.id)).flatMap((module) => module.toolDiagnostics);
    assert.equal(diagnostics.length, 8);
    assert.ok(diagnostics.every((tool) => tool.state === 'available'), JSON.stringify(diagnostics));
    assert.ok(!overview.modules.some((module) => module.id === 'com.transportx.task'));
    const previous = await snapshot();
    const bytes = fs.readFileSync(previous.sessionFile, 'utf8');
    await fetch(`${endpoint}/api/live-sessions/${session.id}`, { method: 'DELETE' });
    session = (await json('/api/live-sessions/resume', { filePath: previous.sessionFile, cwd: session.cwd, model: 'probe/smoke' })).session;
    assert.equal(fs.readFileSync(previous.sessionFile, 'utf8'), bytes, 'resuming does not rewrite existing results');
    const shown = success(await execute('present_visualization', { command: 'show_map', visualizationId: 'core_map' }));
    assert.equal(shown.visualization.revision, 1, 'Geo restores its scene from Pi history');
    success(await execute('canvas_present', { viewId: pinned.viewId, operation: 'focus' }));
    const cleared = success(await execute('canvas_present', { viewId: opened.viewId, operation: 'clear' }));
    assert.equal(cleared.canvas.operation, 'clear');
    assert.ok(fs.existsSync(path.join(session.cwd, 'report.md')), 'clearing a view does not delete its document');
    assert.deepEqual(errors, []);
    const report = { realPi: true, productionHost: true, browser: true, markdownUpdateSameMtime: true, csvRows: true, pdfPage: true, pinnedCitation: true, currentTurnContexts: true, geoPublishRenderScreenshotAndInput: true, interactionAnswered: true, eightCoreToolsAvailable: true, taskNotReenabled: true, historyAndGeoRestore: true, clearPreservesFile: true };
    console.log(JSON.stringify(report));
    return report;
  } finally { await browser.close(); }
}
