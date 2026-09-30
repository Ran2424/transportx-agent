const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { SESSION_COOKIE_NAME, _issueSessionTokenForTest, _setAuthForTest, _setCredentialsForTest, checkAuth } = require('../../bin/tau.js');

caseTest('a signed session cookie authenticates without Basic and is bound to credentials', () => {
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
});
