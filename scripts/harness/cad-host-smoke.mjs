import { cadWorkspaceSmoke } from './cad-workspace-smoke.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { defaultSessionProfile } from '../../src/contracts/session-profile.ts';

// Real Pi, Host, Python and browser; only model tool choices are scripted.
export async function cadHostSmoke({ root, endpoint, json, rpc, until, providerInputs }) {
  const option = (await json('/api/platform/session-options')).modules.find((item) => item.id === 'com.transportx.cad');
  assert.ok(option?.enabledForNewSessions);
  assert.equal(option.selectedByDefault, false);
  const profile = defaultSessionProfile([{ id: option.id, version: option.version }]);
  const session = (await json('/api/live-sessions', { cwd: path.join(root, 'scenario'), model: 'probe/smoke', name: 'CAD module acceptance', profile })).session;
  const snapshot = (id = session.id) => json(`/api/live-sessions/${id}/snapshot`);
  const results = (state) => state.entries.filter((entry) => entry.message?.role === 'toolResult').map((entry) => entry.message);
  async function execute(tool, params, extra = {}, selected = session, isError = false) {
    const before = results(await snapshot(selected.id)).length;
    const ack = await rpc({ type: 'prompt', sessionId: selected.id, message: 'core:' + JSON.stringify({ tool, params }), ...extra });
    assert.equal(ack.success, true, JSON.stringify(ack));
    const state = await until(async () => { const value = await snapshot(selected.id); return !value.isStreaming && results(value).length > before && value; }, `CAD ${tool}`, 40000);
    const result = results(state).at(-1);
    assert.equal(result.isError, isError, JSON.stringify(result));
    return result;
  }
  const firstRequestIndex = providerInputs.length;
  await execute('manage_capabilities', { action: 'status' });
  assert.equal(providerInputs[firstRequestIndex].tools.length, 5);
  const capability = await execute('manage_capabilities', { action: 'inspect', moduleId: 'com.transportx.cad', toolName: 'cad_draw' });
  const metadata = JSON.parse(capability.content[0].text);
  assert.ok(metadata.description.length > 0, 'Host forwards the localized module description');
  assert.ok(metadata.tools[0].parameters.properties.operations.items.anyOf, 'tool inspection exposes nested operation schemas without source reads');
  const source = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { kind: 'road', name: '道路 ROAD-01' }, geometry: { type: 'LineString', coordinates: [[121.44, 31.19], [121.441, 31.19]] } }] };
  fs.writeFileSync(path.join(session.cwd, 'road.geojson'), JSON.stringify(source));
  const request = { kind: 'from-geojson', fileId: 'road', sourcePath: 'road.geojson', sourceCrs: 'EPSG:4326', target: { kind: 'local', origin: [121.44, 31.19] }, layerMap: { road: 'ROADS' }, labelField: 'name', labelLayer: 'LABELS' };
  const created = await execute('cad_draw', request);
  assert.equal(created.details.result.drawing.revision, 1);
  assert.equal(created.details.result.preview, undefined);
  const exported = (await execute('cad_verify', { fileId: 'road', exportPreview: true })).details.result;
  assert.ok(exported.preview.png && exported.preview.pdf);
  fs.copyFileSync(path.join(session.cwd, created.details.result.drawing.path), path.join(session.cwd, 'source.dxf'));
  const operation = await execute('cad_execution', { operationId: created.details.operationId, action: 'query' });
  assert.equal(operation.details.state, 'succeeded');
  const inspected = (await execute('cad_inspect', { fileId: 'road', include: ['summary', 'entities'] })).details.result;
  assert.equal(inspected.drawing.sha256, created.details.result.drawing.sha256);
  assert.ok(inspected.entities.some((entity) => entity.type === 'TEXT' && entity.text === '道路 ROAD-01'));
  const browser = await chromium.launch({ channel: process.env.TAU_BROWSER_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const output = process.env.TRANSPORTX_CAD_VALIDATION_DIR || path.join(root, 'cad-validation');
  fs.mkdirSync(output, { recursive: true });
  try {
    await page.addInitScript((id) => { if (window === window.top) localStorage.setItem('tau-active-live-session-id', id); }, session.id);
    await page.goto(endpoint);
    const panel = page.locator('.canvas-panel:not([hidden]) [data-testid=cad-canvas]');
    async function attachCurrent() {
      const [response] = await Promise.all([
        page.waitForResponse((response) => response.url().includes('/canvas-contexts') && response.request().method() === 'POST'),
        page.getByRole('button', { name: '附加当前 Canvas', exact: true }).click(),
      ]);
      const body = await response.json();
      assert.equal(response.status(), 200, JSON.stringify(body));
      return body.context;
    }
    await panel.locator('.cad-canvas-badge', { hasText: 'r1' }).waitFor();
    await panel.locator('canvas').waitFor();
    await page.getByRole('button', { name: '附加当前 Canvas', exact: true }).waitFor();
    for (const theme of ['light', 'dark', 'sand']) {
      await page.evaluate((theme) => document.documentElement.dataset.theme = theme, theme);
      assert.equal(await panel.evaluate((node) => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
      await page.screenshot({ path: path.join(output, `cad-${theme}.png`) });
      const paperPath = path.join(output, `cad-paper-${theme}.png`);
      await panel.locator('canvas').screenshot({ path: paperPath });
      const pixels = spawnSync(process.env.TAU_PYTHON_COMMAND || 'python3', ['-c', 'from PIL import Image; import sys; im=Image.open(sys.argv[1]).convert("RGB"); samples=list(im.getdata()); ratio=sum(min(p)>240 for p in samples)/len(samples); assert ratio>0.8, f"Actual CAD paper is not white: {ratio}"', paperPath], { encoding: 'utf8' });
      assert.equal(pixels.status, 0, pixels.stderr);
    }
    await panel.getByRole('button', { name: /^图层/ }).click();
    const road = panel.getByRole('checkbox', { name: '显示或隐藏图层 ROADS', exact: true });
    await road.uncheck(); assert.equal(await road.isChecked(), false);
    await panel.getByRole('button', { name: '全部显示', exact: true }).click();
    assert.equal(await road.isChecked(), true);
    await panel.getByRole('button', { name: /^图层/ }).click();
    const canvas = panel.locator('canvas');
    const box = await canvas.boundingBox();
    for (let y = 30; y < box.height - 30; y += 8) {
      await canvas.click({ position: { x: box.width / 2, y } });
      if (/已选 [1-9]/.test(await panel.locator('.cad-canvas-selection').innerText())) break;
    }
    assert.match(await panel.locator('.cad-canvas-selection').innerText(), /已选 [1-9]/);
    await panel.getByRole('button', { name: /^图层/ }).click();
    await panel.getByRole('checkbox', { name: '显示或隐藏图层 0', exact: true }).uncheck();
    await panel.getByRole('button', { name: /^图层/ }).click();
    await canvas.hover();
    await page.mouse.wheel(0, -180);

    await panel.getByRole('button', { name: '框选', exact: true }).click();
    assert.equal(await panel.getByRole('button', { name: '框选', exact: true }).getAttribute('aria-pressed'), 'true');
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + 2, bounds.y + 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height - 2, { steps: 5 });
    await page.mouse.up();
    assert.match(await panel.locator('.cad-canvas-selection').innerText(), /已选 [1-9]/);
    await panel.getByRole('button', { name: '点选', exact: true }).click();
    const context = await attachCurrent();
    assert.equal(context.revision, 1);
    assert.equal(context.selection.drawingSha256, inspected.summary.sha256);
    assert.ok(context.selection.handles.every((handle) => inspected.entities.some((entity) => entity.handle === handle)));
    const shared = await execute('canvas_inspect_context', { contextIds: [context.contextId] }, { canvasContextIds: [context.contextId] });
    assert.equal(shared.details.contexts[0].selection.drawingSha256, inspected.summary.sha256);
    const selected = (await execute('cad_inspect', { contextId: context.contextId, include: ['entities'] }, { canvasContextIds: [context.contextId] })).details.result;
    assert.deepEqual(selected.entities.map((entity) => entity.handle).sort(), [...context.selection.handles].sort());
    const selectedText = JSON.parse((await snapshot()).entries.filter((entry) => entry.message?.toolName === 'cad_inspect').at(-1).message.content[0].text);
    assert.equal(selectedText.summary.sha256, inspected.summary.sha256);
    assert.deepEqual(selectedText.entities, selected.entities);
    const modelResult = JSON.parse(providerInputs.at(-1).messages.filter((message) => message.role === 'tool').at(-1).content);
    assert.equal(modelResult.summary.sha256, inspected.summary.sha256);
    assert.deepEqual(modelResult.entities, selected.entities, 'actual Provider request includes query details');
    const edited = await execute('cad_draw', { kind: 'edit', contextId: context.contextId, operations: [...context.selection.handles.map((handle) => ({ op: 'setLayer', selector: { kind: 'handle', handle }, layer: 'REVIEW' })), { op: 'drawText', layer: 'REVIEW', position: [0, 5], text: '选区标注', height: 2.5 }] }, { canvasContextIds: [context.contextId] });
    assert.equal(edited.details.result.preview, undefined);
    const stale = await execute('cad_draw', { kind: 'edit', contextId: context.contextId, operations: [{ op: 'delete', selector: { kind: 'handle', handle: context.selection.handles[0] } }] }, { canvasContextIds: [context.contextId] }, session, true);
    assert.match(stale.details.error.code, /revision|context/);
    assert.equal(edited.details.result.drawing.revision, 2);
    const receipt = JSON.parse(edited.content[0].text.split('\n').at(-1)).drawing;
    assert.equal(receipt.sha256, edited.details.result.drawing.sha256);
    const continued = await execute('cad_draw', { kind: 'edit', fileId: receipt.fileId, baseRevision: receipt.revision, expectedSha256: receipt.sha256, operations: [{ op: 'drawText', layer: 'LABELS', position: [0, 8], text: 'Continuous edit outside reference selection', height: 1.5 }] }, { canvasContextIds: [context.contextId] });
    assert.equal(continued.details.result.drawing.revision, 3);
    const currentView = (await execute('canvas_present', { adapterId: 'com.transportx.canvas.cad', viewId: 'cad:road', operation: 'focus' })).details.canvas;
    assert.equal(currentView.revision, 3);
    await panel.locator('.cad-canvas-badge', { hasText: 'r3' }).waitFor();
    await panel.locator('canvas').waitFor();
    await page.screenshot({ path: path.join(output, 'cad-r3.png') });
    const afterContext = await attachCurrent();
    assert.ok(Math.abs(afterContext.target.zoom / context.target.zoom - 1) < 1e-6, 'revision keeps actual camera zoom');
    assert.ok(afterContext.target.center.every((value, index) => Math.abs(value - context.target.center[index]) < 1e-6), 'revision keeps camera center');
    await panel.getByRole('button', { name: /^图层/ }).click();
    assert.equal(await panel.getByRole('checkbox', { name: '显示或隐藏图层 0', exact: true }).isChecked(), false);
    await panel.getByRole('button', { name: /^图层/ }).click();

    await panel.locator('.cad-canvas-badge', { hasText: 'r3' }).waitFor();
    await panel.locator('.cad-canvas-revision-notice', { hasText: 'r3' }).waitFor();
    await canvas.click({ position: { x: 20, y: box.height - 60 } });
    assert.match(await panel.locator('.cad-canvas-selection').innerText(), /已选 0/);
    await execute('cad_draw', { ...request, fileId: 'second', title: 'Second CAD' });
    await page.getByRole('tab', { name: 'Second CAD', exact: true, selected: true }).waitFor();
    await panel.locator('.cad-canvas-badge', { hasText: 'r1' }).waitFor();
    await panel.locator('canvas').waitFor();
    await page.getByRole('tab', { name: 'road', exact: true }).click();
    await panel.locator('.cad-canvas-badge', { hasText: 'r3' }).waitFor();
    await panel.locator('canvas').waitFor();
    assert.equal(await page.locator('.cad-canvas-host canvas').count(), 1);
    const reloadResponse = page.waitForResponse((response) => response.url().includes('/api/file/raw?') && decodeURIComponent(response.url()).includes('road/r3.dxf'));
    await panel.getByRole('button', { name: '刷新图纸', exact: true }).click();
    await reloadResponse;
    await until(() => panel.getByRole('button', { name: '点选', exact: true }).isEnabled(), 'refreshed CAD ready');
    // User and Agent reopen the same source without creating another revision.
    await page.getByRole('button', { name: '打开或关闭文件栏', exact: true }).click();
    const openResponse = page.waitForResponse((response) => response.url().includes('/canvas-presentations') && response.request().method() === 'POST');
    await page.locator('.workspace-file-row').filter({ has: page.locator('strong', { hasText: /^source\.dxf$/ }) }).click();
    const response = await openResponse;
    const opening = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(opening));
    const opened = opening.canvas;
    await panel.locator('.cad-canvas-badge', { hasText: 'r1' }).waitFor();
    const repeated = (await execute('canvas_present', { adapterId: 'com.transportx.canvas.cad', operation: 'focus', resource: { scope: 'session-file', path: 'source.dxf' }, target: { kind: 'viewport', center: [10, 0], zoom: 2, units: 'm' } })).details.canvas;
    assert.equal(repeated.viewId, opened.viewId);
    assert.equal(repeated.operation, 'focus');
    assert.deepEqual(repeated.target, { kind: 'viewport', center: [10, 0], zoom: 2, units: 'm' });
    assert.equal(repeated.revision, opened.revision);
    assert.equal(fs.readFileSync(path.join(session.cwd, 'source.dxf')).equals(fs.readFileSync(path.join(session.cwd, opened.payload.path))), true);
    const updated = (await execute('canvas_present', { viewId: opened.viewId, operation: 'update' })).details.canvas;
    assert.equal(updated.revision, 1);
    assert.equal((await attachCurrent()).revision, 1);

    const workspace = await cadWorkspaceSmoke({ execute, session, page, panel, output });
    // Same fileId and revision in another session must load its own bytes.
    fs.mkdirSync(path.join(root, 'other-scenario'), { recursive: true });
    const other = (await json('/api/live-sessions', { cwd: path.join(root, 'other-scenario'), model: 'probe/smoke', name: 'CAD other session', profile })).session;
    fs.writeFileSync(path.join(other.cwd, 'road.geojson'), JSON.stringify({ ...source, features: [{ ...source.features[0], properties: { kind: 'road', name: 'OTHER SESSION' } }] }));
    await execute('cad_draw', request, {}, other);
    const otherDrawing = (await execute('cad_inspect', { fileId: 'road' }, {}, other)).details.result;
    await execute('cad_draw', { kind: 'edit', fileId: 'road', baseRevision: 1, expectedSha256: otherDrawing.summary.sha256, operations: [{ op: 'drawText', layer: 'REVIEW', text: 'Other revision two', height: 2.5, position: [0, 5] }] }, {}, other);
    await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/file/raw?') && response.url().includes(other.id) && decodeURIComponent(response.url()).includes('r2.dxf')),
      page.getByTestId('live-tabs').locator('.live-tab-select').filter({ hasText: 'CAD other session' }).click(),
    ]);
    await panel.locator('.cad-canvas-badge', { hasText: 'r2' }).waitFor();
    await panel.locator('canvas').waitFor();
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(output, 'cad-other-session.png') });
    const verify = (await execute('cad_verify', { fileId: 'road' })).details.result;
    assert.equal(verify.ok, true);
    return { workspace, firstRequestFive: true, optionalModuleSelected: true, nativePiAndApprovedContracts: true, dxfPngPdf: true, onDemandExportWithoutRevision: true, selectedEntityQuery: true, selectedAnnotation: true, staleSelectionRejected: true, continuousRevisionEdits: true, selectionIsReference: true, modelFacingInspectDetails: true, pointAndBoxSelection: true, refreshedDocument: true, userAndAgentOpenSameDrawing: true, crossSessionIsolation: true, queryExistingWrite: true, exactSelectionHash: true, revisionUpdate: true, cameraAndLayersPreserved: true, layerVisibility: true, blankClears: true, twoTabsOneHost: true, threeThemes: true, textEntity: '道路 ROAD-01', pageErrors: errors, screenshotDirectory: output };
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'cad-failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(output, 'cad-failure.html'), await page.content());
    console.error('CAD browser state:', await page.locator('.canvas-panel:not([hidden])').innerText().catch(() => ''), errors);
    throw error;
  } finally { await browser.close(); }
}
