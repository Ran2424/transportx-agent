const test = require('node:test');
const assert = require('node:assert/strict');

const { RpcCommandLedger } = require('../bin/rpc-command-ledger.js');

test('reliable RPC command IDs share one in-flight execution and cached result', async () => {
  const ledger = new RpcCommandLedger(10, 60_000);
  let calls = 0;
  let release!: (value: { success: boolean }) => void;
  const execute = () => {
    calls += 1;
    return new Promise<{ success: boolean }>((resolve) => { release = resolve; });
  };
  const first = ledger.run('session:prompt:command', execute);
  const duplicate = ledger.run('session:prompt:command', execute);
  assert.equal(calls, 1);
  release({ success: true });
  assert.deepEqual(await first, { success: true });
  assert.deepEqual(await duplicate, { success: true });
  assert.deepEqual(await ledger.run('session:prompt:command', execute), { success: true });
  assert.equal(calls, 1);
});

test('different reliable RPC command IDs execute independently', async () => {
  const ledger = new RpcCommandLedger(10, 60_000);
  let calls = 0;
  const execute = async () => ({ call: ++calls });
  assert.deepEqual(await ledger.run('one', execute), { call: 1 });
  assert.deepEqual(await ledger.run('two', execute), { call: 2 });
});
