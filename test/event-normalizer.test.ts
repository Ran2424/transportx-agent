const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createEventNormalizer } = require('../public/kernel/event-normalizer.js');

test('thinking level events do not raise an unknown RPC event error', () => {
  const normalizer = createEventNormalizer();
  const actions = normalizer.normalizeMessage({
    type: 'event',
    sessionId: 'session-1',
    event: { type: 'thinking_level_changed', level: 'high' },
  });
  assert.deepEqual(actions, []);
});
