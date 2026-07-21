const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ServerRouter } = require('../bin/router.js');

test('typed server router matches method, exact paths, and regexp params', async () => {
  const calls: Array<{ kind: string; params: string[]; marker: string }> = [];
  const router = new ServerRouter({ marker: 'deps' })
    .get('/health', ({ params, deps }: { params: string[]; deps: { marker: string } }) => calls.push({ kind: 'health', params, marker: deps.marker }))
    .delete(/^\/sessions\/([^/]+)$/, ({ params, deps }: { params: string[]; deps: { marker: string } }) => calls.push({ kind: 'delete', params, marker: deps.marker }));

  const response = {} as import('node:http').ServerResponse;
  assert.equal(router.dispatch({ method: 'GET' } as import('node:http').IncomingMessage, response, new URL('http://localhost/health')), true);
  assert.equal(router.dispatch({ method: 'POST' } as import('node:http').IncomingMessage, response, new URL('http://localhost/health')), false);
  assert.equal(router.dispatch({ method: 'DELETE' } as import('node:http').IncomingMessage, response, new URL('http://localhost/sessions/tau_1')), true);
  await Promise.resolve();
  assert.deepEqual(calls, [
    { kind: 'health', params: [], marker: 'deps' },
    { kind: 'delete', params: ['tau_1'], marker: 'deps' },
  ]);
});
