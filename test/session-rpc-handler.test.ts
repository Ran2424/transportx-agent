const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSessionReadRpcHandlers, createSessionRpcHandlers } = require('../bin/rpc-handlers/session.js');

const reply = {
  success(data: unknown) { return { success: true, data }; },
  failure(error: string) { return { success: false, error }; },
};

test('Session RPC handler appends a name and updates the live session', () => {
  const session = { sessionFile: '/tmp/session.jsonl' };
  const updates: Array<{ session: unknown; name: string }> = [];
  const handler = createSessionRpcHandlers({
    getLiveSession: () => session,
    findLiveSessionByFile: () => null,
    appendSessionName: (filePath: string, name: string) => { assert.equal(filePath, '/tmp/session.jsonl'); assert.equal(name, '早高峰'); return filePath; },
    updateLiveSessionName: (target: unknown, name: string) => updates.push({ session: target, name }),
  }).set_session_name;
  assert.deepEqual(handler.handle({ type: 'set_session_name', sessionId: 'session-1', name: '早高峰' }, reply), { success: true, data: { name: '早高峰' } });
  assert.deepEqual(updates, [{ session, name: '早高峰' }]);
});

test('Session RPC handler rejects an empty name before resolving a session', () => {
  const handler = createSessionRpcHandlers({
    getLiveSession() { throw new Error('should not resolve'); },
    findLiveSessionByFile() { throw new Error('should not resolve'); },
    appendSessionName() { throw new Error('should not append'); },
    updateLiveSessionName() { throw new Error('should not update'); },
  }).set_session_name;
  assert.deepEqual(handler.handle({ type: 'set_session_name', name: ' ' }, reply), { success: false, error: 'Name cannot be empty' });
});

test('Session read handlers keep message and snapshot responses in the registry', () => {
  const session = { id: 'session-1', entries: [{ type: 'message' }], snapshot: () => ({ schemaVersion: 1, entries: [] }) };
  const handlers = createSessionReadRpcHandlers(() => session);
  assert.deepEqual(handlers.get_messages.handle({ type: 'get_messages', sessionId: session.id }, reply), { success: true, data: { entries: session.entries } });
  assert.deepEqual(handlers.live_session_snapshot_request.handle({ type: 'live_session_snapshot_request', sessionId: session.id }, reply), { type: 'live_session_snapshot', sessionId: session.id, schemaVersion: 1, entries: [] });
});
