const { test } = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/features/geo-tool-result.json').presentVisualizationResult;

async function canvasApi() { return import('../src/web/platform/canvas/canvas-state.ts'); }
function mapResult(id: string, call: string, revision = 1) {
  const message = structuredClone(fixture);
  message.toolCallId = call;
  message.details.visualization.visualizationId = id;
  message.details.visualization.revision = revision;
  return { type: 'message', message };
}
const video = { id: 'video_abc', resourceId: 'video_abc', videoId: 'video_001', title: '东入口', recordingStartTime: '2026-08-16T08:00:00+08:00', recordingEndTime: '2026-08-16T08:01:00+08:00', durationSeconds: 60, kind: 'source' };

test('Canvas follows presentation order across types and deduplicates history/live results', async () => {
  const { projectCanvas } = await canvasApi();
  const first = mapResult('first', 'map-1', 99);
  const second = mapResult('second', 'map-2');
  const videoMessage = { toolCallId: 'video-1', details: { video: { schemaVersion: 1, revision: 1, scene: { schemaVersion: 1, revision: 1, videos: [video], activeVideoId: video.id } } } };
  const content = projectCanvas([first, second, { message: videoMessage }] as any, [{ toolCallId: 'map-1', status: 'completed', result: first.message }] as any);
  assert.equal(content.views.length, 3);
  assert.equal(content.presentation?.id, 'video:video_abc');
});

test('closing and selecting tabs survives unchanged snapshots; explicit Agent focus reopens a tab without a new revision', async () => {
  const { projectCanvas, syncCanvas, closeCanvasTab, activateCanvas, EMPTY_CANVAS } = await canvasApi();
  const entries = [mapResult('first', 'map-1'), mapResult('second', 'map-2')];
  const content = projectCanvas(entries as any, []);
  let state = syncCanvas(EMPTY_CANVAS, content);
  state = activateCanvas(state, 'geo:first');
  assert.equal(syncCanvas(state, content), state);
  state = closeCanvasTab(state, 'geo:first');
  assert.equal(syncCanvas(state, content), state);
  const focus = projectCanvas([...entries, mapResult('first', 'show-1')] as any, []);
  state = syncCanvas(state, focus);
  assert.equal(state.activeId, 'geo:first');
  assert.deepEqual(state.tabIds, ['geo:second', 'geo:first']);
  state = closeCanvasTab(closeCanvasTab(state, 'geo:first'), 'geo:second');
  assert.equal(state.open, false);
  assert.equal(syncCanvas(state, focus), state);
  assert.equal(EMPTY_CANVAS.tabIds.length, 0, 'other sessions do not inherit tabs');
});

test('clearing a map removes its view and failed tools cannot select a view', async () => {
  const { projectCanvas, syncCanvas, EMPTY_CANVAS } = await canvasApi();
  const first = mapResult('first', 'map-1');
  const initial = projectCanvas([first] as any, []);
  const clear = mapResult('first', 'clear-1', 2);
  clear.message.details.visualization.scene = null;
  clear.message.details.visualization.operation = 'clear';
  const content = projectCanvas([first, clear] as any, [{ toolCallId: 'bad', status: 'error', result: first.message }, { toolCallId: 'stale', status: 'completed', result: first.message }] as any);
  assert.equal(content.views.length, 0);
  assert.equal(syncCanvas(syncCanvas(EMPTY_CANVAS, initial), content).open, false);
});

test('show_map activates a restored map without changing its revision or contents', async () => {
  const extension = (await import('../modules/capabilities/geo/extensions/pi-geo-visualization/index.ts')).default;
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  extension({ registerTool: (tool: any) => tools.set(tool.name, tool), on: (name: string, handler: any) => handlers.set(name, handler) } as any);
  const ctx = { sessionManager: { getBranch: () => [{ type: 'message', message: fixture }] } };
  await handlers.get('session_start')({}, ctx);
  assert.ok(tools.has('capture_geo_screenshot'));
  const result = await tools.get('present_visualization').execute('show', { command: 'show_map', visualizationId: fixture.details.visualization.visualizationId }, undefined, undefined, ctx);
  assert.equal(result.details.visualization.revision, fixture.details.visualization.revision);
  assert.deepEqual(result.details.visualization.scene, fixture.details.visualization.scene);
  await assert.rejects(() => tools.get('present_visualization').execute('bad', { command: 'show_map', visualizationId: 'missing' }, undefined, undefined, ctx), /Visualization not found/);
});

test('manual documents survive tool snapshots, close/reopen and repeated citation navigation', async () => {
  const { EMPTY_CANVAS, projectCanvas, syncCanvas, withCanvasDocuments, openCanvasDocument, closeCanvasTab, activateCanvas } = await canvasApi();
  const { resolveDocument } = await import('../src/web/platform/canvas/document-state.ts');
  const document = resolveDocument({ sessionId: 'one', title: '报告', path: 'report.md' }, '/task')!;
  let state = openCanvasDocument(EMPTY_CANVAS, document);
  assert.equal(state.open, true);
  state = syncCanvas(state, withCanvasDocuments(projectCanvas([], []), state));
  assert.deepEqual(state.tabIds, [document.id]);
  state = openCanvasDocument(state, document);
  assert.equal(state.documents.length, 1);
  assert.equal(state.tabIds.length, 1);
  const locator = { locatorId: 'section', resourceId: 'report', section: '结论' };
  state = openCanvasDocument(state, { ...document, locator });
  state = openCanvasDocument(state, { ...document, locator });
  assert.equal(state.documents[0].navigationId, 2, 'repeated navigation is an explicit request');
  state = closeCanvasTab(state, document.id);
  assert.equal(state.open, false);
  assert.equal(syncCanvas(state, withCanvasDocuments(projectCanvas([], []), state)), state);
  state = activateCanvas(state, document.id);
  const withMap = projectCanvas([mapResult('map', 'present')] as any, []);
  state = syncCanvas(state, withCanvasDocuments(withMap, state));
  state = syncCanvas(state, withCanvasDocuments(projectCanvas([], []), state));
  assert.deepEqual(state.tabIds, [document.id], 'removing a map does not remove the document');
  assert.deepEqual(EMPTY_CANVAS.documents, [], 'other sessions retain an empty initial state');
});

test('document identity uses full paths, owning sessions and pinned citation versions', async () => {
  const { resolveDocument, documentPath } = await import('../src/web/platform/canvas/document-state.ts');
  const request = { sessionId: 'one', title: '报告', path: 'output/../report.md' };
  const first = resolveDocument(request, '/task')!;
  assert.equal(first.id, resolveDocument({ ...request, path: '/task/report.md' }, '/task')!.id);
  assert.notEqual(first.id, resolveDocument({ ...request, path: 'other/report.md' }, '/task')!.id);
  assert.notEqual(first.id, resolveDocument({ ...request, sessionId: 'two' }, '/task')!.id);
  assert.equal(documentPath('output\\..\\report.md', 'C:\\task'), 'C:/task/report.md');
  const resource = { resourceId: 'report', workId: 'work', kind: 'document', scope: 'artifact', relativePath: 'report.md', mimeType: 'text/markdown', sha256: 'a'.repeat(64) } as const;
  const registry = { resources: [resource] } as any;
  const pinned = resolveDocument(request, '/task', registry)!;
  assert.equal(pinned.resource, resource);
  const canonical = resolveDocument({ ...request, path: '/private/task/report.md' }, '/task', registry, '/private/task')!;
  assert.equal(canonical.id, pinned.id, 'the server canonical root joins directory aliases to registered resources');
  assert.equal(resolveDocument({ ...request, path: '/task/report.md' }, '/task', registry, '/private/task')!.id, pinned.id);
  assert.equal(pinned.id, resolveDocument({ ...request, resource }, '/task')!.id);
  assert.notEqual(pinned.id, resolveDocument({ ...request, resource: { ...resource, sha256: 'b'.repeat(64) } }, '/task')!.id);
  assert.equal(resolveDocument(request, '/task', { resources: [{ ...resource, scope: 'knowledge' }] } as any)!.resource, undefined);
  assert.equal(resolveDocument(request, '/task', { resources: [resource, { ...resource, resourceId: 'second' }] } as any)!.resource, undefined, 'ambiguous registrations are not merged');
  assert.equal(resolveDocument({ ...request, path: 'image.png' }, '/task'), null);
});

test('document headings have unique anchors and ambiguous or absent citations do not guess', async () => {
  const { documentHeadings, documentTarget } = await import('../src/web/platform/canvas/document-state.ts');
  const headings = documentHeadings(['结论', '结论', '结论-2', 'Methods & data'].map((text) => ({ text, level: 2 })));
  assert.equal(new Set(headings.map((item) => item.id)).size, headings.length);
  const locator = { locatorId: 'one', resourceId: 'report' };
  assert.equal(documentTarget(headings, { ...locator, section: '结论' }), null);
  assert.equal(documentTarget(headings, { ...locator, nodeId: '#结论-2', section: '结论' }), '结论-2');
  assert.equal(documentTarget(headings, { ...locator, section: 'Methods & data' }), 'methods-data');
  assert.equal(documentTarget(headings, { ...locator, section: '不存在', quote: '结论' }), null);
});
