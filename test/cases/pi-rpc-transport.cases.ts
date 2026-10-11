const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { PiRpcTransport } = require('../../bin/pi-rpc-transport.js');

caseTest('Pi RPC transport tracks response commands separately from session state', async () => {
  const writes: string[] = [];
  const input = { writable: true, write(payload: string, done: (error?: Error | null) => void) { writes.push(payload); done(); } };
  const transport = new PiRpcTransport();
  const pending = transport.send(input, { type: 'get_state', sessionId: 'session-1' });
  const outbound = JSON.parse(writes[0]);
  assert.equal(outbound.sessionId, undefined);
  assert.equal(transport.resolve({ type: 'response', id: outbound.id, success: true }), true);
  assert.equal((await pending).success, true);
  assert.equal(transport.resolve({ type: 'response', id: outbound.id, success: true }), false);
});

caseTest('Pi RPC transport acknowledges extension replies on write and rejects pending requests together', async () => {
  const input = { writable: true, write(_payload: string, done: (error?: Error | null) => void) { done(); } };
  const transport = new PiRpcTransport();
  const extension = await transport.send(input, { type: 'extension_ui_response', id: 'ui-1' });
  assert.equal(extension.success, true);
  const pending = transport.send(input, { type: 'get_commands' });
  transport.rejectAll(new Error('closed'));
  await assert.rejects(pending, /closed/);
});

caseTest('timeouts report unknown delivery and late responses are reconciled once', async () => {
  const transport = new PiRpcTransport();
  const responses: unknown[] = [];
  const input = { writable: true, write(_payload: string, done: () => void) { done(); } };
  await assert.rejects(transport.send(input, { id: 'late', type: 'prompt' }, { timeoutMs: 5, onLateResponse: (response: unknown) => responses.push(response) }), (error: any) => error.delivery === 'unknown');
  const response = { id: 'late', success: true };
  assert.equal(transport.resolve(response), true);
  assert.deepEqual(responses, [response]);
  assert.equal(transport.resolve(response), false);
});
