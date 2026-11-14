const { test } = require('node:test') as typeof import('node:test');

test('Signed cookies, remote access and authentication changes enforce credential boundaries', async () => {
  {
    const assert = require('node:assert/strict');
    const { SESSION_COOKIE_NAME, _issueSessionTokenForTest, _setAuthForTest, _setCredentialsForTest, checkAuth } = require('../../bin/tau.js');

    // a signed session cookie authenticates without Basic and is bound to credentials
    {
      _setCredentialsForTest('cookie-user', 'cookie-pass');
      _setAuthForTest(true);
      try {
        const expiresAt = Math.floor(Date.now() / 1000) + 60;
        const token = _issueSessionTokenForTest(expiresAt);
        assert.deepEqual(checkAuth({ headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }), { ok: true, via: 'cookie', expiresAt });
        _setCredentialsForTest('cookie-user', 'changed-pass');
        assert.equal(checkAuth({ headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }).ok, false);
      } finally {
        _setAuthForTest(false);
      }
    }
  }

  {
    const assert = require('node:assert/strict');
    const { createAuthRpcHandlers } = require('../../bin/rpc-handlers/auth.js');
    const reply = {
      success(data: unknown) { return { success: true, data }; },
      failure(error: string) { return { success: false, error }; },
    };

    // Remote Host cannot disable authentication
    {
      const handlers = createAuthRpcHandlers({ configured: true, required: true, getEnabled: () => true, setEnabled() { assert.fail('must remain enabled'); }, notifyChanged() { }, disconnectClients() { } });
      assert.equal(handlers.set_auth.handle({ enabled: false }, reply).success, false);
    }

    // Host access rejects unsafe remote settings and accepts authenticated explicit remote mode
    {
      const { validateHostAccess, allowsHostOrigin, requestScheme, assertLocalNativeAccess } = require('../../bin/host-access.js');
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
      validateHostAccess({ host: '0.0.0.0', user: '', pass: '', remoteAccess: true, authEnabled: false }, true);
      assert.throws(() => validateHostAccess({ host: '0.0.0.0', user: '', pass: '' }, true), /Non-loopback/);
      assert.throws(() => validateHostAccess(local, false, '127.0.0.1'), /requires/);
      assert.throws(() => validateHostAccess(local, false, 'not-an-ip'), /IP address/);
      validateHostAccess({ ...local, user: 'u', pass: 'p', remoteAccess: true }, false, '127.0.0.1');
      const request = { headers: { host: 'example.test', origin: 'https://example.test', 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '::ffff:127.0.0.1' } };
      assert.equal(requestScheme(request, ''), 'http');
      assert.equal(allowsHostOrigin(request, local.host, ''), false);
      assert.equal(allowsHostOrigin(request, local.host, '127.0.0.1'), true);
      assert.equal(allowsHostOrigin({ ...request, headers: { ...request.headers, origin: 'http://example.test' } }, local.host, '127.0.0.1'), false);
      assert.throws(() => assertLocalNativeAccess(request, local.host, false, '127.0.0.1'), { code: 'native_operation_forbidden' });
      assert.throws(() => assertLocalNativeAccess(request, '0.0.0.0', false, ''), { code: 'native_operation_forbidden' });
      assert.throws(() => assertLocalNativeAccess(request, local.host, true, ''), { code: 'native_operation_forbidden' });
      assertLocalNativeAccess(request, local.host, false, '');
    }

    // Auth RPC handler persists the new state and disconnects only when enabling
    {
      let enabled = false;
      const changes: boolean[] = [];
      let disconnects = 0;
      const handlers = createAuthRpcHandlers({
        configured: true,
        getEnabled: () => enabled,
        setEnabled: (value: boolean) => { enabled = value; return true; },
        notifyChanged: (value: boolean) => changes.push(value),
        disconnectClients: () => { disconnects += 1; },
      });
      assert.deepEqual(handlers.get_auth.handle({ type: 'get_auth' }, reply), { success: true, data: { configured: true, enabled: false } });
      assert.deepEqual(handlers.set_auth.handle({ type: 'set_auth', enabled: true }, reply), { success: true, data: { enabled: true } });
      assert.deepEqual(changes, [true]);
      assert.equal(disconnects, 1);
      assert.deepEqual(handlers.set_auth.handle({ type: 'set_auth', enabled: true }, reply), { success: true, data: { enabled: true } });
      assert.equal(disconnects, 1);
    }

    {
      const handlers = createAuthRpcHandlers({
        configured: true, getEnabled: () => true, setEnabled: () => false,
        notifyChanged: () => assert.fail('uncommitted auth state must not be broadcast'),
        disconnectClients: () => assert.fail('uncommitted auth state must not disconnect clients'),
      });
      assert.equal(handlers.set_auth.handle({ type: 'set_auth', enabled: false }, reply).success, false);
    }

    // Auth RPC handler rejects state changes without configured credentials
    {
      const handlers = createAuthRpcHandlers({ configured: false, getEnabled: () => false, setEnabled: () => false, notifyChanged() { }, disconnectClients() { } });
      assert.deepEqual(handlers.set_auth.handle({ type: 'set_auth', enabled: true }, reply), {
        success: false,
        error: 'No credentials configured. Set tau.user and tau.pass in settings.json',
      });
    }
  }
});
