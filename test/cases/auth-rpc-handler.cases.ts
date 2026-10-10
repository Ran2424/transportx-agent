const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { createAuthRpcHandlers } = require('../../bin/rpc-handlers/auth.js');

const reply = {
  success(data: unknown) { return { success: true, data }; },
  failure(error: string) { return { success: false, error }; },
};

caseTest('Remote Host cannot disable authentication', () => {
  const handlers = createAuthRpcHandlers({ configured: true, required: true, getEnabled: () => true, setEnabled() { assert.fail('must remain enabled'); }, notifyChanged() {}, disconnectClients() {} });
  assert.equal(handlers.set_auth.handle({ enabled: false }, reply).success, false);
});

caseTest('Host access rejects unsafe remote settings and accepts authenticated explicit remote mode', () => {
  const { validateHostAccess } = require('../../bin/host-access.js');
  const local = { host: '127.0.0.1', user: '', pass: '' };
  validateHostAccess(local);
  validateHostAccess({ ...local, host: '::1' });
  for (const value of [
    { host: '0.0.0.0', user: '', pass: '' },
    { host: '0.0.0.0', user: 'u', pass: 'p' },
    { host: '0.0.0.0', user: 'u', pass: 'p', remoteAccess: true, authEnabled: false },
    { host: 'localhost', user: '', pass: '' },
  ]) assert.throws(() => validateHostAccess(value), /Non-loopback/);
  validateHostAccess({ host: '0.0.0.0', user: 'u', pass: 'p', remoteAccess: true });
});

caseTest('Auth RPC handler persists the new state and disconnects only when enabling', () => {
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

caseTest('Auth RPC handler rejects state changes without configured credentials', () => {
  const handlers = createAuthRpcHandlers({ configured: false, getEnabled: () => false, setEnabled() {}, notifyChanged() {}, disconnectClients() {} });
  assert.deepEqual(handlers.set_auth.handle({ type: 'set_auth', enabled: true }, reply), {
    success: false,
    error: 'No credentials configured. Set tau.user and tau.pass in settings.json',
  });
});
