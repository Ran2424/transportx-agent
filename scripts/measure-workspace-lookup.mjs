import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const { WorkspaceStore } = require('../bin/workspace-store.js');
const { PiRpcTransport } = require('../bin/pi-rpc-transport.js');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-lookup-probe-'));
const root = fs.realpathSync(directory);
const workspaceCount = 30;
const delay = monitorEventLoopDelay({ resolution: 10 });
const measurements = [];
let realpathCalls = 0, catalogReads = 0;
const realpath = fs.realpathSync;
try {
  const store = new WorkspaceStore(root, path.join(root, 'sessions'));
  const at = '2026-11-14T00:00:00.000Z';
  const ids = [];
  const entries = Array.from({ length: workspaceCount }, (_, index) => {
    const workspaceId = 'ws_' + crypto.randomUUID(), id = 'conv_' + crypto.randomUUID(), cwd = path.join(root, 'workspace-' + index);
    ids.push(id);
    fs.mkdirSync(path.join(cwd, '.tau'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.tau/workspace.json'), JSON.stringify({
      schemaVersion: 1, id: workspaceId, revision: 0, name: path.basename(cwd), createdAt: at, updatedAt: at, defaultsRevision: 0,
      defaults: { domainId: null, modelSpec: null, profile: null }, citationRegistryId: workspaceId,
      conversations: [{ id, creationRequestId: null, creationInputSha256: null, name: id, createdAt: at, updatedAt: at, defaultsRevision: null, modelSpec: null, appendSystemPrompt: '', state: 'ready', history: { key: 'probe/' + id + '.jsonl', headerId: null }, plan: null, privateState: 'isolated', lastStartFailure: null, deletion: null }],
    }));
    return { workspaceId, path: cwd, creationRequestId: null, creationInputSha256: null, state: 'ready', deletion: null };
  });
  fs.writeFileSync(store.catalogFile, JSON.stringify({ schemaVersion: 1, revision: 0, entries }));
  fs.realpathSync = (...args) => { realpathCalls++; return realpath(...args); };
  const readCatalog = store.readCatalog.bind(store);
  store.readCatalog = () => { catalogReads++; return readCatalog(); };
  delay.enable();
  await new Promise(resolve => setTimeout(resolve, 25));
  for (let i = 0; i < 10; i++) {
    const started = performance.now();
    assert.equal(store.findConversation(ids.at(-1)).conversation.id, ids.at(-1));
    measurements.push(performance.now() - started);
    await new Promise(resolve => setTimeout(resolve, 12));
  }
  const transport = new PiRpcTransport();
  const incoming = [];
  const input = { writable: true, write: (payload, callback) => { incoming.push(JSON.parse(payload)); callback(); } };
  const pending = Array.from({ length: 16 }, (_, id) => transport.send(input, { type: 'prompt', id: 'probe-' + id }));
  const peakPendingRpc = transport.pendingCount;
  for (const value of incoming) transport.resolve({ id: value.id, success: true });
  await Promise.all(pending);
  assert.equal(transport.pendingCount, 0);
  measurements.sort((a, b) => a - b);
  console.log(JSON.stringify({
    workspaceCount, lookups: measurements.length,
    catalogReadsPerLookup: catalogReads / measurements.length,
    realpathCallsPerLookup: realpathCalls / measurements.length,
    lookupMedianMs: +measurements[5].toFixed(2), eventLoopP95Ms: +(delay.percentile(95) / 1e6).toFixed(2),
    peakPendingRpc, pendingRpcAfterReplies: transport.pendingCount,
  }));
} finally {
  delay.disable();
  fs.realpathSync = realpath;
  fs.rmSync(directory, { recursive: true, force: true });
}
