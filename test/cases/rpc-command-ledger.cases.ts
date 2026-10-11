const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { RpcCommandLedger } = require('../../bin/rpc-command-ledger.js');

caseTest('reliable RPC command IDs share one in-flight execution and cached result', async () => {
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

caseTest('different reliable RPC command IDs execute independently', async () => {
  const ledger = new RpcCommandLedger(10, 60_000);
  let calls = 0;
  const execute = async () => ({ call: ++calls });
  assert.deepEqual(await ledger.run('one', execute), { call: 1 });
  assert.deepEqual(await ledger.run('two', execute), { call: 2 });
});

caseTest('capacity pressure and TTL never permit reexecution of an in-flight command', async () => {
  const ledger = new RpcCommandLedger(1, 1);
  let calls = 0;
  let release!: (value: string) => void;
  const execute = () => { calls++; return new Promise<string>((resolve) => { release = resolve; }); };
  const first = ledger.run('one', execute);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(Promise.resolve().then(() => ledger.run('two', async () => 'two')), /capacity/i);
  const duplicate = ledger.run('one', execute);
  assert.equal(calls, 1);
  release('done');
  assert.equal(await first, 'done');
  assert.equal(await duplicate, 'done');
});

caseTest('same ID with a different payload is a conflict', async () => {
  const ledger = new RpcCommandLedger();
  await ledger.run('one', async () => 'first', 'payload-one');
  await assert.rejects(Promise.resolve().then(() => ledger.run('one', async () => 'second', 'payload-two')), /payload/i);
});

caseTest('unknown results stay pinned until a late authoritative response settles them', async () => {
  const ledger = new RpcCommandLedger(1, 1, (response: any) => response.delivery === 'unknown');
  let calls = 0;
  const execute = async () => { calls++; return { delivery: 'unknown' }; };
  await ledger.run('one', execute);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(() => ledger.run('two', execute), /capacity/i);
  assert.deepEqual(await ledger.run('one', execute), { delivery: 'unknown' });
  assert.equal(calls, 1);
  ledger.settle('one', { delivery: 'accepted' });
  assert.deepEqual(await ledger.run('one', execute), { delivery: 'accepted' });
});
