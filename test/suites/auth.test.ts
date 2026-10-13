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
    }

    // Auth RPC handler persists the new state and disconnects only when enabling
    {
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
    }

    // Auth RPC handler rejects state changes without configured credentials
    {
      const handlers = createAuthRpcHandlers({ configured: false, getEnabled: () => false, setEnabled() { }, notifyChanged() { }, disconnectClients() { } });
      assert.deepEqual(handlers.set_auth.handle({ type: 'set_auth', enabled: true }, reply), {
        success: false,
        error: 'No credentials configured. Set tau.user and tau.pass in settings.json',
      });
    }
  }

  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const http = require('node:http');
    const { WebAuth, WEB_COOKIE_NAME, hashWebPassword } = require('../../bin/web-auth.js');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-web-auth-'));
    const usersFile = path.join(directory, 'users.json');
    const sessionsFile = path.join(directory, 'sessions.json');
    const salt = 'abcdef0123456789abcdef0123456789';
    const passwordHash = (await hashWebPassword('test-login-password', salt)).toString('hex');
    fs.writeFileSync(usersFile, JSON.stringify({ schemaVersion: 1, users: { admin: { salt, passwordHash }, 'xiaqiang@tongji.edu.cn': { salt, passwordHash: (await hashWebPassword('ACDEFH3479', salt)).toString('hex') } } }));
    const auth = new WebAuth(usersFile, sessionsFile);
    let server: import('node:http').Server | undefined;
    try {
      const emailToken = await auth.login('xiaqiang@tongji.edu.cn', 'ACDEFH3479');
      assert.equal(auth.authenticate({ cookie: `${WEB_COOKIE_NAME}=${emailToken}` }).username, 'xiaqiang@tongji.edu.cn');
      assert.equal(await auth.login('admin', 'wrong-password'), null);
      assert.equal(await auth.login('unknown', 'test-login-password'), null);
      assert.equal(await auth.login('__proto__', 'test-login-password'), null);
      const token = await auth.login('admin', 'test-login-password');
      const headers = { cookie: `${WEB_COOKIE_NAME}=${token}` };
      assert.equal(auth.authenticate(headers).username, 'admin');
      assert.equal(new WebAuth(usersFile, sessionsFile).authenticate(headers).username, 'admin');
      assert.equal(fs.readFileSync(sessionsFile, 'utf8').includes(token), false);
      auth.logout(headers);
      assert.equal(auth.authenticate(headers), null);
      assert.equal(new WebAuth(usersFile, sessionsFile).authenticate(headers), null);
      const changed = await auth.login('admin', 'test-login-password');
      fs.writeFileSync(usersFile, JSON.stringify({ schemaVersion: 1, users: {} }));
      assert.equal(auth.authenticate({ cookie: `${WEB_COOKIE_NAME}=${changed}` }), null);
      const resetHash = (await hashWebPassword('changed-login-password', salt)).toString('hex');
      fs.writeFileSync(usersFile, JSON.stringify({ schemaVersion: 1, users: { admin: { salt, passwordHash: resetHash } } }));
      assert.equal(auth.authenticate({ cookie: `${WEB_COOKIE_NAME}=${changed}` }), null);
      fs.writeFileSync(usersFile, JSON.stringify({ schemaVersion: 1, users: { admin: { salt, passwordHash } } }));
      const expired = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
      for (const session of Object.values(expired.sessions) as Array<{ expiresAt: number }>) session.expiresAt = 1;
      fs.writeFileSync(sessionsFile, JSON.stringify(expired));
      assert.equal(new WebAuth(usersFile, sessionsFile).authenticate({ cookie: `${WEB_COOKIE_NAME}=${changed}` }), null);

      server = http.createServer((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
        void auth.handle(req, res, !req.headers.origin || req.headers.origin === `http://${req.headers.host}`).catch(() => { res.writeHead(503); res.end(); });
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const address = server!.address() as import('node:net').AddressInfo;
      const url = `http://127.0.0.1:${address.port}`;
      const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' }, body: JSON.stringify({ username: 'admin', password: 'test-login-password' }) });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')!;
      assert.match(cookie, /HttpOnly; SameSite=Lax; Max-Age=604800; Secure/);
      const denied = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: '{}' });
      assert.equal(denied.status, 403);
      const cookieHeader = cookie.split(';')[0];
      assert.equal((await fetch(`${url}/api/auth/session`, { headers: { Cookie: cookieHeader } }).then(r => r.json()) as { username: string }).username, 'admin');
      assert.equal((await fetch(`${url}/api/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookieHeader }, body: '{}' })).status, 200);
      assert.equal(auth.authenticate({ cookie: cookieHeader }), null);
    } finally {
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
