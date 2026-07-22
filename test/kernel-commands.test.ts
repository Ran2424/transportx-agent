const { test } = require('node:test');
const assert = require('node:assert/strict');

type JsonRecord = Record<string, any>;

async function createKernel(responder?: (path: string, init?: JsonRecord) => JsonRecord) {
  const kernelModule = '../public/kernel/app-kernel.js';
  const { createAppKernel } = await import(kernelModule);
  const sent: JsonRecord[] = [];
  const httpCalls: Array<{ path: string; init?: JsonRecord }> = [];
  const listeners = new Set<(signal: JsonRecord) => void>();
  const transport = {
    send: (data: unknown) => { sent.push(data as JsonRecord); },
    subscribe: (listener: (signal: JsonRecord) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const http = async (path: string, init?: JsonRecord) => {
    httpCalls.push({ path, init });
    const data = responder ? responder(path, init) : {};
    if (data instanceof Error) throw data;
    return {
      ok: data.ok !== false,
      status: data.status ?? 200,
      json: async () => data.body ?? data,
    };
  };
  const kernel = createAppKernel({ transport, http });
  const emit = (message: JsonRecord) => {
    for (const listener of listeners) listener({ kind: 'message', message });
  };
  return { kernel, sent, httpCalls, emit };
}

test('sendPrompt sends over the transport and tracks an optimistic prompt', async () => {
  const { kernel, sent, emit } = await createKernel();
  await kernel.commands.agent.sendPrompt({ sessionId: 's-1', message: '分析早高峰' });
  assert.deepEqual(sent, [{ type: 'prompt', sessionId: 's-1', message: '分析早高峰' }]);

  const live = kernel.stores.conversation.get().bySession['s-1'].live;
  assert.equal(live.optimisticPrompt.message, '分析早高峰');

  // The authoritative echo replaces the optimistic entry and is retained
  // until snapshot hydration, so a fast echo cannot make the user prompt vanish.
  emit({ type: 'event', sessionId: 's-1', event: { type: 'agent_start' } });
  emit({ type: 'event', sessionId: 's-1', event: { type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: '分析早高峰' }] } } });
  const conv = kernel.stores.conversation.get().bySession['s-1'];
  assert.equal(conv.live.optimisticPrompt, null);
  assert.equal(conv.snapshotEntries.length, 1);
});

test('sendPrompt while streaming queues and flushes after agent_end', async () => {
  const { kernel, sent, emit } = await createKernel();
  emit({ type: 'event', sessionId: 's-1', event: { type: 'agent_start' } });
  await kernel.commands.agent.sendPrompt({ sessionId: 's-1', message: '排队的问题' });
  assert.equal(sent.length, 0);
  assert.equal(kernel.stores.conversation.get().bySession['s-1'].live.queued.length, 1);

  emit({ type: 'event', sessionId: 's-1', event: { type: 'agent_end' } });
  assert.deepEqual(sent, [{ type: 'prompt', sessionId: 's-1', message: '排队的问题' }]);
  assert.equal(kernel.stores.conversation.get().bySession['s-1'].live.queued.length, 0);
});

test('abort, steer and followUp send the expected transport payloads', async () => {
  const { kernel, sent } = await createKernel();
  await kernel.commands.agent.abort('s-1');
  await kernel.commands.agent.steer({ sessionId: 's-1', message: '换个方向' });
  await kernel.commands.agent.followUp({ sessionId: 's-1', message: '补充一点' });
  assert.deepEqual(sent, [
    { type: 'abort', sessionId: 's-1' },
    { type: 'steer', sessionId: 's-1', message: '换个方向' },
    { type: 'follow_up', sessionId: 's-1', message: '补充一点' },
  ]);
});

test('agent settings commands go through POST /api/rpc', async () => {
  const { kernel, httpCalls } = await createKernel((_path, init) => {
    if (init?.body?.type === 'get_state') return { success: true, data: { thinkingLevel: 'high' } };
    return { success: true };
  });
  await kernel.commands.agent.compact('s-1');
  await kernel.commands.agent.setAutoCompaction('s-1', false);
  assert.deepEqual(await kernel.commands.agent.getState('s-1'), { thinkingLevel: 'high' });
  await kernel.commands.agent.setModel({ sessionId: 's-1', model: 'kimi-coding/k2p7' });
  await kernel.commands.agent.setThinkingLevel({ sessionId: 's-1', level: 'high' });
  assert.deepEqual(httpCalls.map((call) => call.init?.body?.type), [
    'compact',
    'set_auto_compaction',
    'get_state',
    'set_model',
    'set_thinking_level',
  ]);
});

test('session commands map to the live-session HTTP API', async () => {
  const { kernel, httpCalls } = await createKernel((path, init) => {
    if (path === '/api/live-sessions' && init?.method === 'POST') return { session: { id: 's-9' } };
    if (path === '/api/live-sessions') return { sessions: [{ id: 's-1' }] };
    if (path === '/api/sessions') return { projects: [{ path: '/tmp/proj', sessions: [{ filePath: '/tmp/a.jsonl' }] }] };
    if (path.startsWith('/api/search')) return { results: [{ filePath: '/tmp/a.jsonl', matches: [{ snippet: '早高峰' }] }] };
    if (path === '/api/live-sessions/resume') return { session: { id: 's-2' } };
    if (path.endsWith('/snapshot')) return { schemaVersion: 1, entries: [] };
    if (path.startsWith('/api/session-history')) return { schemaVersion: 1, entries: [{ type: 'message' }] };
    return { success: true };
  });

  assert.deepEqual(await kernel.commands.session.list(), [{ id: 's-1' }]);
  assert.deepEqual(await kernel.commands.session.listHistory(), [{ path: '/tmp/proj', sessions: [{ filePath: '/tmp/a.jsonl' }] }]);
  assert.equal((await kernel.commands.session.searchHistory('早高峰'))[0].matches?.[0].snippet, '早高峰');
  assert.deepEqual(await kernel.commands.session.create({ cwd: '/tmp', name: '测试', model: 'k2p7' }), { id: 's-9' });
  assert.deepEqual(await kernel.commands.session.resume({ filePath: '/tmp/a.jsonl', cwd: '/tmp/proj' }), { id: 's-2' });
  assert.deepEqual(await kernel.commands.session.loadSnapshot('s-1'), { schemaVersion: 1, entries: [] });
  assert.deepEqual(await kernel.commands.session.loadHistory('/tmp/a.jsonl'), { schemaVersion: 1, entries: [{ type: 'message' }] });
  await kernel.commands.session.close('s-1');
  await kernel.commands.session.deleteHistory('/tmp/a.jsonl');

  assert.deepEqual(httpCalls.map((c) => [c.init?.method ?? 'GET', c.path]), [
    ['GET', '/api/live-sessions'],
    ['GET', '/api/sessions'],
    ['GET', '/api/search?q=%E6%97%A9%E9%AB%98%E5%B3%B0'],
    ['POST', '/api/live-sessions'],
    ['POST', '/api/live-sessions/resume'],
    ['GET', '/api/live-sessions/s-1/snapshot'],
    ['GET', '/api/session-history?filePath=%2Ftmp%2Fa.jsonl'],
    ['DELETE', '/api/live-sessions/s-1'],
    ['POST', '/api/sessions/delete'],
  ]);
  // resume forwards an optional cwd for the project the session belongs to.
  assert.deepEqual(httpCalls[4].init?.body, { filePath: '/tmp/a.jsonl', cwd: '/tmp/proj' });
});

test('platform commands expose models and authentication through command ports', async () => {
  const { kernel, httpCalls } = await createKernel((_path, init) => {
    if (init?.body?.type === 'get_available_models') return { success: true, data: { models: ['provider/model'] } };
    if (init?.body?.type === 'get_auth') return { success: true, data: { configured: true, enabled: false } };
    return { success: true, data: { enabled: true } };
  });
  assert.deepEqual(await kernel.commands.platform.getAvailableModels('s-1'), ['provider/model']);
  assert.deepEqual(await kernel.commands.platform.getAuth(), { configured: true, enabled: false });
  assert.deepEqual(await kernel.commands.platform.setAuth(true), { enabled: true });
  assert.deepEqual(httpCalls.map((call) => call.init?.body?.type), ['get_available_models', 'get_auth', 'set_auth']);
});

test('HTTP failures are converted to serializable AppErrors', async () => {
  const networkDown = await createKernel(() => new Error('socket hangup'));
  await assert.rejects(
    networkDown.kernel.commands.session.list(),
    (error: JsonRecord) => error.code === 'http_network_error' && error.category === 'transport' && error.retryable === true,
  );

  const serverError = await createKernel(() => ({ ok: false, status: 500, body: { error: 'boom' } }));
  await assert.rejects(
    serverError.kernel.commands.session.loadSnapshot('s-1'),
    (error: JsonRecord) => error.code === 'http_error' && error.message === 'boom' && error.retryable === true && error.diagnostics.status === 500,
  );

  const rpcFailure = await createKernel(() => ({ success: false, error: 'No active Tau session' }));
  await assert.rejects(
    rpcFailure.kernel.commands.agent.setModel({ sessionId: 's-1', model: 'k2p7' }),
    (error: JsonRecord) => error.code === 'rpc_command_failed' && error.category === 'session' && error.retryable === false,
  );

  const apiError = await createKernel(() => ({ body: { error: 'Cannot resume session' } }));
  await assert.rejects(
    apiError.kernel.commands.session.resume({ filePath: '/tmp/a.jsonl' }),
    (error: JsonRecord) => error.code === 'api_error' && error.category === 'session',
  );
});

test('extension UI respond sends the response and resolves the current request', async () => {
  const { kernel, sent } = await createKernel();
  kernel.dispatch({ type: 'session/activated', sessionId: 's-1' });
  kernel.dispatch({ type: 'extensionUi/requested', sessionId: 's-1', request: { type: 'extension_ui_request', id: 'r1', method: 'select' } });
  assert.equal(kernel.stores.extensionUi.get().current?.request.id, 'r1');

  await kernel.commands.extensionUi.respond({ sessionId: 's-1', id: 'r1', response: { value: '选项一' } });
  assert.deepEqual(sent, [{ type: 'extension_ui_response', id: 'r1', sessionId: 's-1', value: '选项一' }]);
  assert.equal(kernel.stores.extensionUi.get().current, null);

  await kernel.commands.extensionUi.respond({ sessionId: 's-1', id: 'r2' });
  assert.deepEqual(sent[1], { type: 'extension_ui_response', id: 'r2', sessionId: 's-1', cancelled: true });
});
