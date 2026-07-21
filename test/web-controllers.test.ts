const { test } = require('node:test');
const assert = require('node:assert/strict');

test('AgentRuntime owns connection and active-session streaming state', async () => {
  const runtimeModule = '../public/runtime/agent-runtime.js';
  const sessionModule = '../public/controllers/session-controller.js';
  const [{ AgentRuntime }, { SessionController }] = await Promise.all([
    import(runtimeModule),
    import(sessionModule),
  ]);
  class FakeTransport extends EventTarget {
    connected = 0;
    connect() { this.connected++; }
    disconnect() {}
    forceReconnect() {}
    send() {}
  }
  const transport = new FakeTransport();
  const runtime = new AgentRuntime('ws://unused', transport as any);
  runtime.connect();
  assert.equal(runtime.store.snapshot.connection, 'connecting');
  transport.dispatchEvent(new CustomEvent('connected'));
  assert.equal(runtime.store.snapshot.connection, 'connected');

  runtime.activateSession('tau_1');
  transport.dispatchEvent(new CustomEvent('rpcEvent', { detail: { sessionId: 'tau_2', event: { type: 'agent_start' } } }));
  assert.equal(runtime.store.snapshot.isStreaming, false);
  transport.dispatchEvent(new CustomEvent('rpcEvent', { detail: { sessionId: 'tau_1', event: { type: 'agent_start' } } }));
  assert.equal(runtime.store.snapshot.isStreaming, true);
  transport.dispatchEvent(new CustomEvent('rpcEvent', { detail: { sessionId: 'tau_1', event: { type: 'agent_end' } } }));
  assert.equal(runtime.store.snapshot.isStreaming, false);

  const sessions = new SessionController();
  sessions.replace([{ id: 'tau_1', lastActiveAt: '2026-01-01T00:00:00Z' }]);
  sessions.upsert({ id: 'tau_1', sessionName: 'Updated' });
  sessions.upsert({ id: 'tau_2', lastActiveAt: '2026-01-02T00:00:00Z' });
  assert.equal(sessions.sessions.length, 2);
  assert.equal(sessions.get('tau_1')?.sessionName, 'Updated');
  assert.equal(sessions.mostRecent()?.id, 'tau_2');
});

test('ExtensionUIController queues background requests by session', async () => {
  const modulePath = '../public/controllers/extension-ui-controller.js';
  const { ExtensionUIController } = await import(modulePath);
  const shown: string[] = [];
  let active = 'tau_1';
  const dialogs = {
    currentRequest: null,
    showSelect(request: { id?: string }) { shown.push(String(request.id)); },
    showConfirm() {}, showInput() {}, showEditor() {}, showNotification() {}, clearCurrentDialog() {},
  };
  const controller = new ExtensionUIController({
    dialogs: dialogs as any,
    activeSessionId: () => active,
    isActiveSessionVisible: () => true,
    onChange() {},
  });
  controller.enqueue({ id: 'request-2', method: 'select' }, 'tau_2');
  assert.equal(controller.hasPending('tau_2'), true);
  controller.process();
  assert.deepEqual(shown, []);
  active = 'tau_2';
  controller.process();
  assert.deepEqual(shown, ['request-2']);
  assert.equal(controller.hasPending('tau_2'), false);
});
