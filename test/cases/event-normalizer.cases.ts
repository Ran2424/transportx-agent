const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { createEventNormalizer } = require('../../public/kernel/event-normalizer.js');

caseTest('thinking level events do not raise an unknown RPC event error', () => {
  const normalizer = createEventNormalizer();
  const actions = normalizer.normalizeMessage({
    type: 'event',
    sessionId: 'session-1',
    event: { type: 'thinking_level_changed', level: 'high' },
  });
  assert.deepEqual(actions, []);
});

caseTest('compaction lifecycle is rendered and waits for agent_settled before ending the stream', () => {
  const normalizer = createEventNormalizer();
  const message = (event: Record<string, unknown>) => normalizer.normalizeMessage({ type: 'event', sessionId: 'session-1', event });
  assert.deepEqual(message({ type: 'agent_start' }).map((action: { type: string }) => action.type), ['conversation/streamStarted']);
  assert.deepEqual(message({ type: 'agent_end' }), []);
  assert.deepEqual(message({ type: 'compaction_start', reason: 'threshold' }), [{ type: 'session/compactionStarted', sessionId: 'session-1' }]);
  assert.deepEqual(message({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false }), [{ type: 'session/compactionEnded', sessionId: 'session-1' }]);
  assert.deepEqual(message({ type: 'agent_settled' }).map((action: { type: string }) => action.type), ['conversation/streamEnded']);
});

caseTest('Geo interaction websocket updates are validated before reaching stores', () => {
  const normalizer = createEventNormalizer();
  const [action] = normalizer.normalizeMessage({
    type: 'geo_interaction_updated',
    sessionId: 'session-1',
    request: { version: 999 },
  });
  assert.equal(action.type, 'error/raised');
  assert.equal(action.error.code, 'malformed_message');
});

caseTest('Geo screenshot websocket requests are validated before reaching stores', () => {
  const normalizer = createEventNormalizer();
  const request = { version: 1, requestId: `geoshot_${'a'.repeat(16)}`, sessionId: 'session-1', visualizationId: 'traffic_map', sceneRevision: 2, status: 'waiting', createdAt: '2026-09-02T01:00:00.000Z', expiresAt: '2026-09-02T01:01:00.000Z' };
  assert.equal(normalizer.normalizeMessage({ type: 'geo_screenshot_updated', sessionId: 'session-1', request })[0].type, 'session/geoScreenshotUpdated');
  assert.equal(normalizer.normalizeMessage({ type: 'geo_screenshot_updated', sessionId: 'session-1', request: { version: 999 } })[0].type, 'error/raised');
});
