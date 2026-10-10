const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { liveSessionMetadata, sessionMetadata, sessionSnapshot } = require('../../bin/session-metadata.js');

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

caseTest('keeps immutable session details out of the live metadata overlay', () => {
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

caseTest('combines the projection snapshot with the authoritative session metadata', () => {
  const snapshot = sessionSnapshot({ messages: [{ role: 'user', content: '分析' }] }, source, { ok: true }, []);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.session.id, source.id);
  assert.equal(snapshot.session.resolvedSessionPlan, source.resolvedSessionPlan);
  assert.equal(snapshot.contextUsage.percent, 23);
});

caseTest('live snapshots include Host clock, current partial message and active tools', () => {
  const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
  const manager = new LiveSessionManager();
  const session = new PiRpcSession(manager, { id: 'clocked', cwd: '/tmp/clocked' });
  session.handleEvent({ type: 'agent_start' });
  session.handleEvent({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'current partial' }] } });
  session.handleEvent({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', args: { path: 'file' } });
  const snapshot = session.snapshot();
  assert.equal(typeof snapshot.hostGeneration, 'string');
  assert.ok(snapshot.revision >= 3);
  assert.equal(snapshot.streamingMessage.content[0].text, 'current partial');
  assert.equal(snapshot.activeToolEvents[0].toolCallId, 'call');
  session.handleEvent({ type: 'tool_execution_end', toolCallId: 'call', result: {} });
  session.handleEvent({ type: 'message_end', message: { role: 'assistant', content: 'finished' } });
  assert.equal(session.snapshot().streamingMessage, null);
  assert.equal(session.snapshot().activeToolEvents.length, 0);
  assert.notEqual(new LiveSessionManager().clock().hostGeneration, manager.clock().hostGeneration);
});
