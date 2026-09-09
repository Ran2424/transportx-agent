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
  const result = await tools.get('present_visualization').execute('show', { command: 'show_map', visualizationId: fixture.details.visualization.visualizationId }, undefined, undefined, ctx);
  assert.equal(result.details.visualization.revision, fixture.details.visualization.revision);
  assert.deepEqual(result.details.visualization.scene, fixture.details.visualization.scene);
  await assert.rejects(() => tools.get('present_visualization').execute('bad', { command: 'show_map', visualizationId: 'missing' }, undefined, undefined, ctx), /Visualization not found/);
});
