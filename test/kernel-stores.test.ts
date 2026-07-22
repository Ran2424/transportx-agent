const { test } = require('node:test');
const assert = require('node:assert/strict');

type JsonRecord = Record<string, any>;

async function createKernel() {
  const kernelModule = '../public/kernel/app-kernel.js';
  const { createAppKernel } = await import(kernelModule);
  const sent: JsonRecord[] = [];
  const listeners = new Set<(signal: JsonRecord) => void>();
  const transport = {
    send: (data: unknown) => { sent.push(data as JsonRecord); },
    subscribe: (listener: (signal: JsonRecord) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const kernel = createAppKernel({
    transport,
    http: async () => { throw new Error('unexpected http call'); },
  });
  const emit = (message: JsonRecord) => {
    for (const listener of listeners) listener({ kind: 'message', message });
  };
  return { kernel, sent, emit, listeners };
}

test('createStore notifies subscribers and isolates listener errors', async () => {
  const storeModule = '../public/kernel/store.js';
  const { createStore } = await import(storeModule);
  const store = createStore({ count: 0 });
  const seen: number[] = [];
  store.subscribe((state: { count: number }) => { seen.push(state.count); });
  store.subscribe(() => { throw new Error('boom'); });
  store.set((prev: { count: number }) => ({ count: prev.count + 1 }));
  store.set({ count: 5 });
  assert.deepEqual(seen, [0, 1, 5]);

  const late: number[] = [];
  const unsubscribe = store.subscribe((state: { count: number }) => { late.push(state.count); });
  unsubscribe();
  store.set({ count: 6 });
  assert.deepEqual(late, [5]);
});

test('transport signals update the runtime store', async () => {
  const { kernel, listeners } = await createKernel();
  assert.equal(kernel.stores.runtime.get().connection, 'disconnected');
  for (const listener of listeners) listener({ kind: 'connected' });
  assert.equal(kernel.stores.runtime.get().connection, 'connected');
  for (const listener of listeners) listener({ kind: 'disconnected' });
  assert.equal(kernel.stores.runtime.get().connection, 'disconnected');
});

test('extension UI store mirrors legacy enqueue/suspend/drop semantics', async () => {
  const { kernel } = await createKernel();
  const ui = () => kernel.stores.extensionUi.get();
  const request = (id: string, method: string) => ({ type: 'extension_ui_request', id, method });

  kernel.dispatch({ type: 'session/activated', sessionId: 's-a' });
  kernel.dispatch({ type: 'extensionUi/requested', sessionId: 's-a', request: request('r1', 'confirm') });
  assert.equal(ui().current?.request.id, 'r1');

  // A background session request queues instead of taking over the dialog.
  kernel.dispatch({ type: 'extensionUi/requested', sessionId: 's-b', request: request('r2', 'input') });
  assert.equal(ui().current?.request.id, 'r1');
  assert.equal(ui().queue.length, 1);

  // Duplicate request ids are dropped.
  kernel.dispatch({ type: 'extensionUi/requested', sessionId: 's-b', request: request('r2', 'input') });
  assert.equal(ui().queue.length, 1);

  // Tab switch suspends the current dialog and promotes the target session's.
  kernel.dispatch({ type: 'session/activated', sessionId: 's-b' });
  assert.equal(ui().current?.request.id, 'r2');
  assert.deepEqual(ui().queue.map((p: JsonRecord) => p.request.id), ['r1']);

  kernel.dispatch({ type: 'extensionUi/resolved', sessionId: 's-b', requestId: 'r2' });
  assert.equal(ui().current, null);
  assert.equal(ui().queue.length, 1);

  // Switching back restores the suspended request.
  kernel.dispatch({ type: 'session/activated', sessionId: 's-a' });
  assert.equal(ui().current?.request.id, 'r1');

  // Closing a session drops its current and queued requests.
  kernel.dispatch({ type: 'session/closed', sessionId: 's-a' });
  assert.equal(ui().current, null);
  assert.equal(ui().queue.length, 0);
});

test('session store derives streaming only from agent events and snapshots', async () => {
  const { kernel, emit } = await createKernel();
  const ev = (sessionId: string, event: JsonRecord) => emit({ type: 'event', sessionId, event });

  ev('s-1', { type: 'turn_start' });
  assert.equal(kernel.stores.session.get().streamingBySession['s-1'], undefined);
  ev('s-1', { type: 'agent_start' });
  assert.equal(kernel.stores.session.get().streamingBySession['s-1'], true);
  ev('s-1', { type: 'turn_end' });
  assert.equal(kernel.stores.session.get().streamingBySession['s-1'], true);
  ev('s-1', { type: 'agent_end' });
  assert.equal(kernel.stores.session.get().streamingBySession['s-1'], false);

  emit({ type: 'state', liveSessions: [{ id: 's-1', isStreaming: true }, { id: 's-2', isStreaming: false }] });
  assert.deepEqual(kernel.stores.session.get().streamingBySession, { 's-1': true, 's-2': false });

  kernel.dispatch({ type: 'session/activated', sessionId: 's-2' });
  emit({ type: 'live_session_closed', sessionId: 's-2' });
  assert.equal(kernel.stores.session.get().activeSessionId, null);
  assert.deepEqual(kernel.stores.session.get().sessions.map((s: JsonRecord) => s.id), ['s-1']);
});

test('runtime/connecting marks the runtime store as connecting', async () => {
  const { kernel } = await createKernel();
  assert.equal(kernel.stores.runtime.get().connection, 'disconnected');
  kernel.dispatch({ type: 'runtime/connecting' });
  assert.equal(kernel.stores.runtime.get().connection, 'connecting');
});

test('conversation/queueItemRemoved drops one queued prompt by index', async () => {
  const { kernel, emit } = await createKernel();
  emit({ type: 'event', sessionId: 's-1', event: { type: 'agent_start' } });
  kernel.dispatch({ type: 'conversation/promptQueued', sessionId: 's-1', message: '第一条' });
  kernel.dispatch({ type: 'conversation/promptQueued', sessionId: 's-1', message: '第二条' });
  kernel.dispatch({ type: 'conversation/promptQueued', sessionId: 's-1', message: '第三条' });

  kernel.dispatch({ type: 'conversation/queueItemRemoved', sessionId: 's-1', index: 1 });
  const queued = kernel.stores.conversation.get().bySession['s-1'].live.queued;
  assert.deepEqual(queued.map((q: JsonRecord) => q.message), ['第一条', '第三条']);
});

test('onEvent fires after stores are updated for rpc events and state messages', async () => {
  const { kernel, emit } = await createKernel();
  const seen: JsonRecord[] = [];
  kernel.onEvent((event: JsonRecord) => {
    if (event.kind === 'rpc') {
      // Stores must already reflect the event when the tap runs.
      seen.push({ kind: 'rpc', type: event.event.type, streaming: kernel.stores.session.get().streamingBySession['s-1'] });
    } else {
      seen.push({ kind: 'state', sessions: kernel.stores.session.get().sessions.length });
    }
  });

  emit({ type: 'event', sessionId: 's-1', event: { type: 'agent_start' } });
  emit({ type: 'event', sessionId: 's-1', event: { type: 'agent_end' } });
  emit({ type: 'state', liveSessions: [{ id: 's-1' }] });
  assert.deepEqual(seen, [
    { kind: 'rpc', type: 'agent_start', streaming: true },
    { kind: 'rpc', type: 'agent_end', streaming: false },
    { kind: 'state', sessions: 1 },
  ]);
});
