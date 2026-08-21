const { test } = require('node:test');
const assert = require('node:assert/strict');

const { liveSessionMetadata, sessionMetadata, sessionSnapshot } = require('../bin/session-metadata.js');

const source = {
  id: 'tau_1',
  pid: 123,
  cwd: '/tmp/session',
  modelSpec: 'openai/gpt-5',
  model: { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
  thinkingLevel: 'high',
  sessionFile: '/tmp/session/history.jsonl',
  sessionName: '早高峰分析',
  isStreaming: true,
  isCompacting: false,
  autoCompactionEnabled: true,
  createdAt: '2026-08-21T00:00:00.000Z',
  lastActiveAt: '2026-08-21T00:01:00.000Z',
  lastConversationAt: '2026-08-21T00:00:30.000Z',
  contextUsage: { tokens: 23000, contextWindow: 100000, percent: 23 },
  resolvedSessionPlan: { schemaVersion: 3 },
};

test('keeps immutable session details out of the live metadata overlay', () => {
  const capabilities = { ok: true };
  const full = sessionMetadata(source, capabilities, [{ id: 'request-1' }]);
  const live = liveSessionMetadata(source, capabilities);

  assert.equal(full.modelLabel, 'openai/gpt-5');
  assert.equal(full.resolvedSessionPlan, source.resolvedSessionPlan);
  assert.deepEqual(full.pendingExtensionUiRequests, [{ id: 'request-1' }]);
  assert.equal(live.resolvedSessionPlan, undefined);
  assert.equal(live.cwd, undefined);
  assert.equal(live.isStreaming, true);
  assert.equal(live.contextUsage.tokens, 23000);
});

test('combines the projection snapshot with the authoritative session metadata', () => {
  const snapshot = sessionSnapshot({ messages: [{ role: 'user', content: '分析' }] }, source, { ok: true }, []);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.session.id, source.id);
  assert.equal(snapshot.session.resolvedSessionPlan, source.resolvedSessionPlan);
  assert.equal(snapshot.contextUsage.percent, 23);
});
