const test = require('node:test');
const assert = require('node:assert/strict');

test('Canvas state keeps multiple items, activates a requested renderer and only auto-opens new publications', async () => {
  const { INITIAL_CANVAS_STATE, reduceCanvasState } = await import('../src/web/platform/canvas/canvas-state.ts');
  const items = [
    { id: 'video:morning', kind: 'video' as const, resourceId: 'video_morning', revision: 4, title: 'Morning camera' },
    { id: 'geo:network', kind: 'geo' as const, resourceId: 'network', revision: 3, title: 'Network map' },
  ];
  const published = reduceCanvasState(INITIAL_CANVAS_STATE, { type: 'itemsSynced', items, openLatest: true });
  assert.equal(published.isOpen, true);
  assert.equal(published.activeItemId, 'video:morning');
  const selected = reduceCanvasState(published, { type: 'itemActivated', itemId: 'geo:network' });
  assert.equal(selected.activeItemId, 'geo:network');
  const closed = reduceCanvasState(selected, { type: 'closed' });
  const retained = reduceCanvasState(closed, { type: 'itemsSynced', items, openLatest: false });
  assert.equal(retained.isOpen, false);
  assert.equal(retained.activeItemId, 'geo:network');
});
