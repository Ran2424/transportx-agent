const { test } = require('node:test') as typeof import('node:test');
import type { WebSocket as WsWebSocket } from 'ws';

test('WebSocket rejects unsafe origins and commands, bounds buffering and preserves sessions on disconnect', async (t) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { WebSocket } = require('ws');
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
      terminate: async () => { },
    };
  }

  function connect(opts: any = {}) {
    const { protocolVersion, ...connectionOptions } = opts;
    const headers = opts.headers || {};
    if (opts.origin !== null) headers.Origin = opts.origin ?? base;
    headers.Host = new URL(base).host;
    const ws = new WebSocket(wsUrl, { headers, ...connectionOptions });
    if (protocolVersion !== null) ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: protocolVersion ?? 2 })));
    return ws;
  }

  function nextMessage(ws: WsWebSocket, timeout = 2000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for WS message')), timeout);
      ws.once('message', (data: Buffer) => { clearTimeout(timer); resolve(JSON.parse(data.toString())); });
      ws.once('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
  }

  t.after(() => new Promise<void>((resolve) => {
    server.close(resolve);
  }));

  t.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

  await new Promise<void>((resolve) => {
    _setAuthForTest(false);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      computeUrls(port);
      base = `http://127.0.0.1:${port}`;
      wsUrl = `ws://127.0.0.1:${port}/ws`;
      resolve();
    });
  });

  for (const hello of [null, [], { type: 'hello', protocolVersion: 1 }]) {
    const client = connect({ protocolVersion: null });
    const closed = new Promise<number>((resolve) => client.once('close', resolve));
    await new Promise<void>((resolve) => client.once('open', resolve));
    client.send(JSON.stringify(hello));
    assert.equal(await closed, 4006, 'unsupported or malformed handshakes fail before state delivery');
    assert.equal((await fetch(base + '/api/health')).status, 200, 'malformed clients cannot crash the Host');
  }

  // slow WebSocket clients are removed before adding more buffered data
  {
    liveManager.sessions.clear();
    const { LiveSessionManager } = require('../../bin/sessions.js');
    const manager = new LiveSessionManager();
    let sent = 0;
    let closed = 0;
    const slow = { readyState: WebSocket.OPEN, bufferedAmount: 8 * 1024 * 1024, send() { assert.fail('must not buffer more'); }, terminate() { closed++; } };
    const healthy = { readyState: WebSocket.OPEN, bufferedAmount: 0, send() { sent++; }, terminate() { } };
    manager.addClient(slow);
    manager.addClient(healthy);
    manager.broadcast({ type: 'event' });
    assert.equal(closed, 1);
    assert.equal(sent, 1);
    assert.equal(manager.clients.has(slow), false);
  }

  // Project authentication revocation closes an existing connection.
  {
    const http = require('node:http');
    const { LiveSessionManager } = require('../../bin/sessions.js');
    const { attachWebSocketHandler } = require('../../bin/websocket-handler.js');
    const authServer = http.createServer();
    let valid = true;
    const handler = attachWebSocketHandler({
      server: authServer, sessions: new LiveSessionManager(),
      authEnabled: () => true, isAllowedOrigin: () => true,
      isAuthenticated: () => valid, recheckAuthentication: true, suppressChallenge: true,
    });
    await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve));
    const client = new WebSocket(`ws://127.0.0.1:${authServer.address().port}/ws`);
    client.once('open', () => client.send(JSON.stringify({ type: 'hello', protocolVersion: 2 })));
    try {
      await nextMessage(client);
      const closed = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('revoked login remained connected')), 23000);
        client.once('close', (code: number) => { clearTimeout(timer); resolve(code); });
      });
      valid = false;
      assert.equal(await closed, 4001, 'authentication is rechecked after the upgrade');
    } finally {
      client.terminate();
      handler.close();
      handler.wss.close();
      await new Promise<void>((resolve) => authServer.close(resolve));
    }
  }

  // cross-origin WebSocket upgrade is rejected
  {
    liveManager.sessions.clear();
    const ws = connect({ origin: 'http://evil.example' });
    // ws client does not surface the HTTP status on the error event, so we
    // only assert that the upgrade does not succeed.
    await assert.rejects(
      () => new Promise((_, reject) => {
        ws.on('error', reject);
        ws.on('open', () => reject(new Error('cross-origin upgrade should not succeed')));
      }),
    );
    try { ws.close(); } catch { }
  }

  // WebSocket disconnect does not terminate backend live sessions
  {
    liveManager.sessions.clear();
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
  }

  // WebSocket is event-only and rejects side-effecting commands
  {
    liveManager.sessions.clear();
    const ws = connect();
    await nextMessage(ws);
    ws.send(JSON.stringify({ type: 'prompt', sessionId: 'missing', message: 'must use HTTP' }));
    const response = await nextMessage(ws);
    assert.equal(response.type, 'error');
    assert.equal(response.code, 'websocket_event_only');
    ws.close();
  }
});
