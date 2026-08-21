const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createAuthRpcHandlers } = require('../bin/rpc-handlers/auth.js');

const reply = {
  success(data: unknown) { return { success: true, data }; },
  failure(error: string) { return { success: false, error }; },
};

test('Auth RPC handler persists the new state and disconnects only when enabling', () => {
  let enabled = false;
  const changes: boolean[] = [];
  let disconnects = 0;
  const handlers = createAuthRpcHandlers({
    configured: true,
    getEnabled: () => enabled,
    setEnabled: (value: boolean) => { enabled = value; },
    notifyChanged: (value: boolean) => changes.push(value),
    disconnectClients: () => { disconnects += 1; },
  });
  assert.deepEqual(handlers.get_auth.handle({ type: 'get_auth' }, reply), { success: true, data: { configured: true, enabled: false } });
  assert.deepEqual(handlers.set_auth.handle({ type: 'set_auth', enabled: true }, reply), { success: true, data: { enabled: true } });
  assert.deepEqual(changes, [true]);
  assert.equal(disconnects, 1);
  assert.deepEqual(handlers.set_auth.handle({ type: 'set_auth', enabled: true }, reply), { success: true, data: { enabled: true } });
  assert.equal(disconnects, 1);
});

test('Auth RPC handler rejects state changes without configured credentials', () => {
  const handlers = createAuthRpcHandlers({ configured: false, getEnabled: () => false, setEnabled() {}, notifyChanged() {}, disconnectClients() {} });
  assert.deepEqual(handlers.set_auth.handle({ type: 'set_auth', enabled: true }, reply), {
    success: false,
    error: 'No credentials configured. Set tau.user and tau.pass in settings.json',
  });
});
