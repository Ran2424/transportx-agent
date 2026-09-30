const { suiteCase, suiteBefore: before, suiteAfter: after, suiteBeforeEach: beforeEach } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WebSocket } = require('ws');
import type { TestContext } from 'node:test';
import type { WebSocket as WsWebSocket } from 'ws';

// Loopback + isolated settings tree.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-ws-'));
process.env.TAU_HOST = '127.0.0.1';
process.env.PI_CODING_AGENT_DIR = TMP;
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(TMP, 'sessions');
fs.mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });

const { server, computeUrls, liveManager, _setAuthForTest } = require('../../bin/tau.js');

let base = '';
let wsUrl = '';

interface FakeWsSession {
  id: string;
  cwd: string;
  model: string;
  modelSpec: string;
  thinkingLevel: string;
  isStreaming: boolean;
  sessionFile: string;
  sessionName: string | null;
  contextUsage: { tokens?: number } | null;
  metadata: () => { id: string; cwd: string; model: string; isStreaming: boolean };
  snapshot: () => { session: { id: string }; entries: unknown[]; model: string; isStreaming: boolean };
  terminate: () => Promise<void>;
}

function fakeSession(id: string): FakeWsSession {
  return {
    id,
    cwd: '/tmp/proj',
    model: 'openai/gpt-5.5',
    modelSpec: '',
    thinkingLevel: 'off',
    isStreaming: false,
    sessionFile: `/tmp/${id}.jsonl`,
    sessionName: null,
    contextUsage: null,
    metadata: () => ({ id, cwd: '/tmp/proj', model: 'openai/gpt-5.5', isStreaming: false }),
    snapshot: () => ({ session: { id }, entries: [], model: 'openai/gpt-5.5', isStreaming: false }),
    terminate: async () => {},
  };
}

before((t: TestContext, done: () => void) => {
  _setAuthForTest(false);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    computeUrls(port);
    base = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
    done();
  });
});

after((t: TestContext, done: () => void) => {
  server.close(done);
});

beforeEach(() => {
  liveManager.sessions.clear();
});

function connect(opts: any = {}) {
  const headers = opts.headers || {};
  if (opts.origin !== null) headers.Origin = opts.origin ?? base;
  headers.Host = new URL(base).host;
  const ws = new WebSocket(wsUrl, { headers, ...opts });
  return ws;
}

function nextMessage(ws: WsWebSocket, timeout = 2000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for WS message')), timeout);
    ws.once('message', (data: Buffer) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
    ws.once('error', (e: Error) => { clearTimeout(timer); reject(e); });
  });
}

caseTest('cross-origin WebSocket upgrade is rejected', async () => {
  const ws = connect({ origin: 'http://evil.example' });
  // ws client does not surface the HTTP status on the error event, so we
  // only assert that the upgrade does not succeed.
  await assert.rejects(
    () => new Promise((_, reject) => {
      ws.on('error', reject);
      ws.on('open', () => reject(new Error('cross-origin upgrade should not succeed')));
    }),
  );
  try { ws.close(); } catch {}
});

caseTest('WebSocket disconnect does not terminate backend live sessions', async () => {
  const s = fakeSession('tau_1');
  let terminated = false;
  s.terminate = async () => { terminated = true; };
  liveManager.sessions.set('tau_1', s);
  const ws = connect();
  await nextMessage(ws);
  // close the browser-side connection and wait for the server to process it
  await new Promise((resolve) => {
    ws.on('close', resolve);
    ws.close();
  });
  // give the server a tick to run its close handler
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(terminated, false, 'disconnecting a client must not terminate child sessions');
  assert.equal(liveManager.sessions.has('tau_1'), true);
  assert.equal(liveManager.clients.size, 0);
});

caseTest('WebSocket is event-only and rejects side-effecting commands', async () => {
  const ws = connect();
  await nextMessage(ws);
  ws.send(JSON.stringify({ type: 'prompt', sessionId: 'missing', message: 'must use HTTP' }));
  const response = await nextMessage(ws);
  assert.equal(response.type, 'error');
  assert.equal(response.code, 'websocket_event_only');
  ws.close();
});
