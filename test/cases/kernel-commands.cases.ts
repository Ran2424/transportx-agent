const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { createAgentCommands, createCitationCommands, createExtensionUiCommands, createGeoCommands, createPlatformCommands, createReportCommands, createSessionCommands, createVideoCommands } = require('../../public/kernel/commands.js');
const { createAppKernel } = require('../../public/kernel/app-kernel.js');
const { ConversationStore } = require('../../public/kernel/stores/conversation-store.js');
const { SessionStore } = require('../../public/kernel/stores/session-store.js');
const { ToolExecutionStore } = require('../../public/kernel/stores/tool-execution-store.js');

function deps(handler: (command: Record<string, unknown>) => unknown, streaming = false) {
  const commands: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const actions: Record<string, unknown>[] = [];
  return {
    commands,
    paths,
    actions,
    value: {
      http: async (_path: string, init?: { body?: unknown }) => {
        paths.push(_path);
        commands.push(init?.body as Record<string, unknown>);
        const payload = handler(init?.body as Record<string, unknown>);
        return { ok: true, status: 200, async json() { return payload; }, async text() { return ''; } };
      },
      dispatch: (action: Record<string, unknown>) => actions.push(action),
      isStreaming: () => streaming,
      isCompacting: () => false,
    },
  };
}

caseTest('prompt uses acknowledged HTTP RPC before optimistic state', async () => {
  const fixture = deps((command) => ({ type: 'response', success: true, clientCommandId: command.clientCommandId, delivery: 'accepted' }));
  const agent = createAgentCommands(fixture.value);
  await agent.sendPrompt({ sessionId: 'session-1', message: '分析交通状态' });
  assert.equal(fixture.commands.length, 1);
  assert.equal(fixture.commands[0].type, 'prompt');
  assert.equal(typeof fixture.commands[0].clientCommandId, 'string');
  assert.deepEqual(fixture.actions.map((action) => action.type), ['conversation/promptSent']);
});

caseTest('failed prompt does not create optimistic sent state', async () => {
  const fixture = deps(() => ({ type: 'response', success: false, error: 'offline' }));
  const agent = createAgentCommands(fixture.value);
  await assert.rejects(() => agent.sendPrompt({ sessionId: 'session-1', message: '不会假成功' }), (error: { message?: string }) => error.message === 'offline');
  assert.deepEqual(fixture.actions, []);
  const firstId = fixture.commands[0].clientCommandId;
  await assert.rejects(() => agent.sendPrompt({ sessionId: 'session-1', message: '不会假成功' }));
  assert.notEqual(fixture.commands[1].clientCommandId, firstId);
});

caseTest('unknown prompt delivery keeps the original identity without automatic resend', async () => {
  const fixture = deps(() => ({ success: false, delivery: 'unknown', error: 'response lost' }));
  const agent = createAgentCommands(fixture.value);
  await assert.rejects(() => agent.sendPrompt({ sessionId: 'session-1', message: 'unknown delivery' }), (error: any) => error.code === 'delivery_unknown');
  assert.equal(fixture.commands.length, 1);
  await assert.rejects(() => agent.sendPrompt({ sessionId: 'session-1', message: 'unknown delivery' }));
  assert.equal(fixture.commands[0].clientCommandId, fixture.commands[1].clientCommandId);
});

caseTest('failed queued prompts do not resend on unrelated actions', async () => {
  let calls = 0;
  const kernel = createAppKernel({ transport: { subscribe() { return () => {}; } }, http: async () => {
    calls++;
    return { ok: true, status: 200, async json() { return { success: false, delivery: 'unknown', error: 'response lost' }; } };
  } });
  try {
    kernel.dispatch({ type: 'conversation/promptQueued', sessionId: 'one', message: 'queued', clientCommandId: 'original-id' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    kernel.dispatch({ type: 'session/activated', sessionId: 'other' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(kernel.stores.conversation.get().bySession.one.live.queued.length, 1);
    kernel.dispatch({ type: 'conversation/queueItemRemoved', sessionId: 'one', index: 0 });
    kernel.dispatch({ type: 'conversation/promptQueued', sessionId: 'one', message: 'next', clientCommandId: 'next-id' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
  } finally { kernel.dispose(); }
});

caseTest('streaming prompt keeps a stable command ID in the queue', async () => {
  const fixture = deps(() => ({ type: 'response', success: true }), true);
  const agent = createAgentCommands(fixture.value);
  await agent.sendPrompt({ sessionId: 'session-1', message: '排队分析' });
  assert.equal(fixture.commands.length, 0);
  assert.equal(fixture.actions[0].type, 'conversation/promptQueued');
  assert.equal(typeof fixture.actions[0].clientCommandId, 'string');
});

caseTest('compacting prompt stays queued until the session is ready', async () => {
  const fixture = deps(() => ({ type: 'response', success: true }));
  fixture.value.isCompacting = () => true;
  const agent = createAgentCommands(fixture.value);
  await agent.sendPrompt({ sessionId: 'session-1', message: '等待压缩结束' });
  assert.equal(fixture.commands.length, 0);
  assert.equal(fixture.actions[0].type, 'conversation/promptQueued');
});

caseTest('session snapshots hydrate and clear compaction state', () => {
  const store = new SessionStore();
  store.applySnapshot('session-1', {
    schemaVersion: 1,
    entries: [],
    isCompacting: true,
    session: { id: 'session-1', isStreaming: true, isCompacting: true },
  });
  assert.equal(store.isStreaming('session-1'), true);
  assert.equal(store.isCompacting('session-1'), true);
  store.setCompacting('session-1', false);
  assert.equal(store.isCompacting('session-1'), false);
});

caseTest('attachment commands update the session store through kernel actions', async () => {
  const attachment = { id: 'att-1', name: 'demand.csv', relativePath: 'attachments/att-1/demand.csv', size: 12, kind: 'table', source: 'file' };
  const fixture = deps((_command) => ({ attachments: [attachment] }));
  const session = createSessionCommands(fixture.value);
  await session.listAttachments('session-1');
  await session.uploadAttachment({ sessionId: 'session-1', file: new File(['x'], 'demand.csv'), source: 'file' });
  await session.deleteAttachment('session-1', attachment.id);
  assert.deepEqual(fixture.actions.map((action) => action.type), ['session/attachmentsReceived', 'session/attachmentAdded', 'session/attachmentRemoved']);
  assert.deepEqual(fixture.paths, [
    '/api/live-sessions/session-1/attachments',
    '/api/live-sessions/session-1/attachments?source=file',
    '/api/live-sessions/session-1/attachments/att-1',
  ]);

  const store = new SessionStore();
  store.setAttachments('session-1', [attachment]);
  store.addAttachment('session-1', { ...attachment, id: 'att-2' });
  store.removeAttachment('session-1', attachment.id);
  assert.deepEqual(Object.keys(store.get().attachmentsBySession['session-1']), ['att-2']);
  assert.equal(store.get().attachmentRevisionBySession['session-1'], 3);
});

caseTest('session rename uses the RPC port and updates live session state', async () => {
  const fixture = deps(() => ({ success: true, data: { name: '晚高峰分析' } }));
  const session = createSessionCommands(fixture.value);
  assert.deepEqual(await session.rename({ sessionId: 'session-1', name: '晚高峰分析' }), { name: '晚高峰分析' });
  assert.deepEqual(fixture.paths, ['/api/rpc']);
  assert.deepEqual(fixture.commands[0], { type: 'set_session_name', sessionId: 'session-1', name: '晚高峰分析' });
  assert.deepEqual(fixture.actions, [{ type: 'session/updated', session: { id: 'session-1', sessionName: '晚高峰分析' } }]);
});

caseTest('citation commands validate envelopes behind the HTTP command port', async () => {
  const citations = { protocol: 'pi-citation', version: '2.0', citationSetId: 'set-1', generatedAt: '2026-08-21T00:00:00.000Z', works: [], resources: [], locators: [], occurrences: [], provenance: [] };
  const fixture = deps((command) => command?.locatorId ? { marker: '[1]', citations } : { citations });
  const citation = createCitationCommands(fixture.value);
  assert.equal((await citation.list('session-1')).citationSetId, 'set-1');
  const created = await citation.createOccurrence('session-1', 'locator-1', 'support');
  assert.equal(created.marker, '[1]');
  assert.deepEqual(fixture.paths, ['/api/live-sessions/session-1/citations', '/api/live-sessions/session-1/citations/occurrences']);
  assert.deepEqual(fixture.commands[1], { locatorId: 'locator-1', role: 'support' });
});

caseTest('video metrics stay behind the HTTP command port', async () => {
  const fixture = deps(() => ({ metrics: [] }));
  const video = createVideoCommands(fixture.value);
  assert.deepEqual(await video.getMetrics('session-1', 'video_resource'), { metrics: [] });
  assert.deepEqual(fixture.paths, ['/api/live-sessions/session-1/video-resources/video_resource/metrics']);
});

caseTest('Geo screenshots stay behind the session HTTP command port', async () => {
  const fixture = deps(() => ({ filename: 'map-screenshot.png', path: '/tmp/map-screenshot.png', bytes: 68 }));
  const geo = createGeoCommands(fixture.value);
  const result = await geo.saveScreenshot('session-1', { visualizationId: 'map-1', sceneRevision: 2, dataUrl: 'data:image/png;base64,png' });
  assert.equal(result.filename, 'map-screenshot.png');
  assert.deepEqual(fixture.paths, ['/api/sessions/session-1/geo-screenshots']);
  assert.deepEqual(fixture.commands[0], { visualizationId: 'map-1', sceneRevision: 2, dataUrl: 'data:image/png;base64,png' });
});

caseTest('Agent-requested Geo screenshots complete through the session HTTP command port', async () => {
  const fixture = deps(() => ({ status: 'captured', filename: 'map-screenshot.png', relativePath: 'map-screenshot.png', bytes: 68 }));
  const geo = createGeoCommands(fixture.value);
  await geo.respondScreenshot('session-1', 'geoshot-1', { status: 'captured', dataUrl: 'data:image/png;base64,png' });
  assert.deepEqual(fixture.paths, ['/api/sessions/session-1/geo-screenshots/geoshot-1/respond']);
  assert.deepEqual(fixture.commands[0], { status: 'captured', dataUrl: 'data:image/png;base64,png' });
});

caseTest('PDF export stays behind the HTTP command port', async () => {
  const fixture = deps(() => ({ url: '/api/reports/download/report.pdf' }));
  const report = createReportCommands(fixture.value);
  assert.deepEqual(await report.exportPdf('交通报告', '<article>内容</article>'), { url: '/api/reports/download/report.pdf' });
  assert.deepEqual(fixture.paths, ['/api/reports/pdf/download']);
  assert.deepEqual(fixture.commands[0], { title: '交通报告', html: '<article>内容</article>' });
});

caseTest('report source stays behind the HTTP command port', async () => {
  const fixture = deps(() => ({}));
  fixture.value.http = async (path: string) => {
    fixture.paths.push(path);
    return { ok: true, status: 200, async json() { return {}; }, async text() { return '# 交通报告'; } };
  };
  const report = createReportCommands(fixture.value);
  assert.deepEqual(await report.loadSource('session-1', '/api/citations/report.md'), { content: '# 交通报告', encoding: 'utf8', size: 14 });
  assert.deepEqual(fixture.paths, ['/api/citations/report.md']);
});

caseTest('report source exposes an updated citation to the document reader', async () => {
  const fixture = deps(() => ({}));
  fixture.value.http = async () => ({
    ok: true, status: 200,
    headers: { get: (name: string) => name === 'X-Citation-Resource-Stale' ? '1' : null },
    async json() { return {}; }, async text() { return '# 新版报告'; },
  });
  const report = createReportCommands(fixture.value);
  assert.deepEqual(await report.loadSource('session-1', '/api/citations/report.md'), { content: '# 新版报告', encoding: 'utf8', size: 14, stale: true });
});

caseTest('extension response closes the dialog before the HTTP RPC acknowledges it', async () => {
  const fixture = deps(() => ({ type: 'response', success: false, error: 'request expired' }));
  const extension = createExtensionUiCommands(fixture.value);
  await assert.rejects(() => extension.respond({ sessionId: 'session-1', id: 'ui-1', response: { confirmed: true } }), (error: { message?: string }) => error.message === 'request expired');
  assert.deepEqual(fixture.actions, [{ type: 'extensionUi/resolved', sessionId: 'session-1', requestId: 'ui-1' }]);
  assert.equal(fixture.commands[0].type, 'extension_ui_response');
  assert.equal(typeof fixture.commands[0].clientCommandId, 'string');
});

caseTest('platform model provider commands preserve provider credentials behind RPC ports', async () => {
  const fixture = deps((command) => {
    if (command.type === 'get_model_providers') return { type: 'response', success: true, data: { providers: [{ id: 'xiaomi-token-plan-cn', name: 'Xiaomi Token Plan', connected: false, credentialStored: false, authMethods: ['api_key'], modelCount: 2 }] } };
    if (command.type === 'connect_model_provider') return { type: 'response', success: true, data: { provider: { id: command.provider, name: 'Xiaomi Token Plan', connected: true, credentialStored: true, authMethods: ['api_key'], modelCount: 2 } } };
    return { type: 'response', success: true };
  });
  const platform = createPlatformCommands(fixture.value);
  const providers = await platform.getModelProviders();
  assert.equal(providers[0].id, 'xiaomi-token-plan-cn');
  const connected = await platform.connectModelProvider('xiaomi-token-plan-cn', 'secret-key');
  assert.equal(connected.credentialStored, true);
  await platform.disconnectModelProvider('xiaomi-token-plan-cn');
  assert.deepEqual(fixture.commands.map((command) => command.type), ['get_model_providers', 'connect_model_provider', 'disconnect_model_provider']);
  assert.equal(fixture.commands[1].apiKey, 'secret-key');
});

caseTest('platform model management commands stay behind the RPC port', async () => {
  const fixture = deps((command) => ({ type: 'response', success: true, data: { model: { provider: command.provider, modelId: command.modelId, reference: `${command.provider}/${command.modelId}` } } }));
  const platform = createPlatformCommands(fixture.value);
  await platform.updateModel({ provider: 'custom', modelId: 'traffic-model', name: 'Traffic', contextWindow: 256000, reasoning: true, images: true });
  await platform.deleteModel('custom', 'traffic-model');
  await platform.deleteModelProvider('custom');
  assert.deepEqual(fixture.commands.map((command) => command.type), ['update_model', 'delete_model', 'delete_model_provider']);
  assert.equal(fixture.commands[0].contextWindow, 256000);
});

caseTest('authoritative user echo arriving before HTTP acknowledgement is not duplicated', () => {
  const store = new ConversationStore();
  store.messageStarted('session-1', { role: 'user', content: '分析交通状态' });
  store.promptSent('session-1', { message: '分析交通状态' });
  const conversation = store.get().bySession['session-1'];
  assert.equal(conversation.snapshotEntries.length, 1);
  assert.equal(conversation.live.optimisticPrompt, null);
});

caseTest('an identical prompt remains optimistic when the latest authoritative message is an assistant', () => {
  const store = new ConversationStore();
  store.messageStarted('session-1', { role: 'user', content: '再次分析' });
  store.streamCompleted('session-1', { role: 'assistant', content: '上一次结果' });
  store.promptSent('session-1', { message: '再次分析' });
  assert.equal(store.get().bySession['session-1'].live.optimisticPrompt?.message, '再次分析');
});

caseTest('thinking duration freezes on the first answer text and stays on the completed message', () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const store = new ConversationStore();
    store.messageStarted('session-1', { role: 'assistant', content: [] });
    now = 2_500;
    store.streamDelta('session-1', 'thinking', '分析路段状态');
    now = 4_000;
    store.streamDelta('session-1', 'text', '结论');
    assert.equal(store.get().bySession['session-1'].live.thinkingDurationMs, 3_000);

    now = 8_000;
    store.streamCompleted('session-1', { role: 'assistant', content: [{ type: 'thinking', thinking: '分析路段状态' }, { type: 'text', text: '结论' }] });
    const message = store.get().bySession['session-1'].snapshotEntries.at(-1)?.message;
    const thinking = Array.isArray(message?.content) ? message.content.find((block: { type?: string; durationMs?: number }) => block.type === 'thinking') : undefined;
    assert.equal(thinking?.durationMs, 3_000);
  } finally {
    Date.now = originalNow;
  }
});

caseTest('tool execution duration freezes at completion', () => {
  const originalNow = Date.now;
  let now = 2_000;
  Date.now = () => now;
  try {
    const store = new ToolExecutionStore();
    store.started('session-1', { toolCallId: 'tool-1', toolName: 'read', status: 'running' });
    now = 5_500;
    store.ended('session-1', 'tool-1', { toolName: 'read', result: 'ok' });
    const execution = store.get().bySession['session-1']['tool-1'];
    assert.equal(execution.durationMs, 3_500);
    assert.equal(execution.status, 'completed');
  } finally {
    Date.now = originalNow;
  }
});

caseTest('kernel batches text deltas to one animation frame and flushes before message completion', () => {
  const animationGlobal = globalThis as typeof globalThis & {
    requestAnimationFrame?: (callback: (time: number) => void) => number;
    cancelAnimationFrame?: (frame: number) => void;
  };
  const originalRequestAnimationFrame = animationGlobal.requestAnimationFrame;
  const originalCancelAnimationFrame = animationGlobal.cancelAnimationFrame;
  let frameCallback: ((time: number) => void) | null = null;
  let listener: ((signal: Record<string, unknown>) => void) | null = null;
  animationGlobal.requestAnimationFrame = (callback) => {
    frameCallback = callback;
    return 1;
  };
  animationGlobal.cancelAnimationFrame = () => {};
  const kernel = createAppKernel({
    transport: {
      subscribe(next: (signal: Record<string, unknown>) => void) {
        listener = next;
        return () => {};
      },
    },
    http: async () => ({ ok: true, status: 200, async json() { return {}; } }),
  });
  const emit = (event: Record<string, unknown>) => listener?.({ kind: 'message', message: { type: 'event', sessionId: 'session-1', event } });
  try {
    emit({ type: 'agent_start' });
    emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '长' } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '文本' } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '流' } });
    assert.equal(kernel.stores.conversation.get().bySession['session-1'].live.streamingText, '');

    assert.ok(frameCallback);
    frameCallback!(16);
    assert.equal(kernel.stores.conversation.get().bySession['session-1'].live.streamingText, '长文本流');

    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '结束' } });
    emit({ type: 'message_end', message: { role: 'assistant', content: '长文本流结束' } });
    const finalMessage = kernel.stores.conversation.get().bySession['session-1'].snapshotEntries.at(-1)?.message;
    assert.equal(finalMessage?.content, '长文本流结束');
  } finally {
    kernel.dispose();
    animationGlobal.requestAnimationFrame = originalRequestAnimationFrame;
    animationGlobal.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

caseTest('kernel projects streamed tool arguments before execution without exposing partial JSON', () => {
  const animationGlobal = globalThis as typeof globalThis & {
    requestAnimationFrame?: (callback: (time: number) => void) => number;
    cancelAnimationFrame?: (frame: number) => void;
  };
  const originalRequestAnimationFrame = animationGlobal.requestAnimationFrame;
  const originalCancelAnimationFrame = animationGlobal.cancelAnimationFrame;
  let frameCallback: ((time: number) => void) | null = null;
  let listener: ((signal: Record<string, unknown>) => void) | null = null;
  animationGlobal.requestAnimationFrame = (callback) => {
    frameCallback = callback;
    return 1;
  };
  animationGlobal.cancelAnimationFrame = () => {};
  const kernel = createAppKernel({
    transport: {
      subscribe(next: (signal: Record<string, unknown>) => void) {
        listener = next;
        return () => {};
      },
    },
    http: async () => ({ ok: true, status: 200, async json() { return {}; } }),
  });
  const emit = (event: Record<string, unknown>) => listener?.({ kind: 'message', message: { type: 'event', sessionId: 'session-1', event } });
  const partial = (args: Record<string, unknown>) => ({ role: 'assistant', content: [{ type: 'toolCall', id: 'write-1', name: 'write', arguments: args }] });
  try {
    emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, partial: partial({}) } });
    assert.equal(kernel.stores.toolExecution.get().bySession['session-1']['write-1'].status, 'preparing');

    emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{"path":', contentIndex: 0, partial: partial({}) } });
    emit({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '"report.md"}', contentIndex: 0, partial: partial({ path: 'report.md' }) } });
    assert.ok(frameCallback);
    frameCallback!(16);
    const preparing = kernel.stores.toolExecution.get().bySession['session-1']['write-1'];
    assert.equal(preparing.argumentChars, 20);
    assert.deepEqual(preparing.args, { path: 'report.md' });

    emit({ type: 'tool_execution_start', toolCallId: 'write-1', toolName: 'write', args: { path: 'report.md' } });
    const running = kernel.stores.toolExecution.get().bySession['session-1']['write-1'];
    assert.equal(running.status, 'running');
    assert.equal(running.argumentChars, 20);
  } finally {
    kernel.dispose();
    animationGlobal.requestAnimationFrame = originalRequestAnimationFrame;
    animationGlobal.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});

caseTest('authoritative snapshots replace abandoned branches, overlays, tools and dialogs', () => {
  const kernel = createAppKernel({ transport: { subscribe: () => () => {} }, http: async () => { throw new Error('unused'); } });
  kernel.dispatch({ type: 'session/activated', sessionId: 'a' });
  kernel.dispatch({ type: 'conversation/messageAppended', sessionId: 'a', entry: { id: 'abandoned', message: { role: 'assistant', content: 'old branch' } } });
  kernel.dispatch({ type: 'conversation/streamDelta', sessionId: 'a', channel: 'text', delta: 'orphan partial' });
  kernel.dispatch({ type: 'tool/started', sessionId: 'a', execution: { toolCallId: 'orphan', status: 'running' } });
  kernel.dispatch({ type: 'extensionUi/requested', sessionId: 'a', request: { id: 'orphan-dialog' } });
  kernel.dispatch({ type: 'session/snapshotReceived', sessionId: 'a', snapshot: { schemaVersion: 1, entries: [{ id: 'selected', message: { role: 'assistant', content: 'selected branch' } }], isStreaming: false, pendingExtensionUiRequests: [] } });
  const state = kernel.stores.conversation.get().bySession.a;
  assert.deepEqual(state.snapshotEntries.map((entry: any) => entry.id), ['selected']);
  assert.equal(state.live.streamingText, '');
  assert.equal(kernel.stores.toolExecution.get().bySession.a, undefined);
  assert.equal(kernel.stores.extensionUi.get().current, null);
  kernel.dispose();
});

caseTest('reconnect recovers missed completion and rejects late revision, request and Host generation', async () => {
  let emit!: (signal: any) => void;
  const pending: Array<(data: any) => void> = [];
  const kernel = createAppKernel({
    transport: { subscribe(listener: (signal: any) => void) { emit = listener; return () => {}; } },
    http: async () => ({ ok: true, status: 200, json: () => new Promise((resolve) => pending.push(resolve)), text: async () => '' }),
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const snapshot = (generation: string, revision: number, text: string) => ({ schemaVersion: 1, hostGeneration: generation, revision, entries: [{ message: { role: 'assistant', content: text } }], isStreaming: false, isCompacting: false });
  emit({ kind: 'connected' });
  emit({ kind: 'message', message: { type: 'state', hostGeneration: 'host-1', revision: 1, liveSessions: [{ id: 'a', isStreaming: true }] } });
  kernel.dispatch({ type: 'session/activated', sessionId: 'a' });
  emit({ kind: 'disconnected' });
  emit({ kind: 'connected' });
  emit({ kind: 'message', message: { type: 'state', hostGeneration: 'host-1', revision: 5, liveSessions: [{ id: 'a', isStreaming: false }] } });
  await tick();
  assert.equal(pending.length, 1);
  pending.shift()!(snapshot('host-1', 5, 'finished while disconnected'));
  await tick();
  assert.equal(kernel.stores.conversation.get().bySession.a.snapshotEntries[0].message.content, 'finished while disconnected');
  const delayed = kernel.commands.session.loadSnapshot('a');
  await tick();
  emit({ kind: 'message', message: { type: 'event', sessionId: 'a', hostGeneration: 'host-1', revision: 6, event: { type: 'message_end', message: { role: 'assistant', content: 'new event' } } } });
  pending.shift()!(snapshot('host-1', 5, 'stale response'));
  kernel.dispatch({ type: 'session/snapshotReceived', sessionId: 'a', snapshot: await delayed });
  assert.equal(kernel.stores.conversation.get().bySession.a.snapshotEntries.at(-1).message.content, 'new event');
  const old = kernel.commands.session.loadSnapshot('a');
  const latest = kernel.commands.session.loadSnapshot('a');
  await tick();
  const oldResponse = pending.shift()!;
  pending.shift()!(snapshot('host-1', 6, 'latest request'));
  kernel.dispatch({ type: 'session/snapshotReceived', sessionId: 'a', snapshot: await latest });
  oldResponse(snapshot('host-1', 6, 'old request'));
  kernel.dispatch({ type: 'session/snapshotReceived', sessionId: 'a', snapshot: await old });
  assert.equal(kernel.stores.conversation.get().bySession.a.snapshotEntries[0].message.content, 'latest request');
  emit({ kind: 'message', message: { type: 'state', hostGeneration: 'host-2', revision: 0, liveSessions: [] } });
  kernel.dispatch({ type: 'session/snapshotReceived', sessionId: 'a', snapshot: snapshot('host-1', 99, 'old Host') });
  assert.equal(kernel.stores.conversation.get().bySession.a, undefined);
  kernel.dispose();
});

caseTest('in-flight snapshot restores partial output then replays newer stream deltas', async () => {
  let emit!: (signal: any) => void;
  let respond!: (data: any) => void;
  const kernel = createAppKernel({
    transport: { subscribe(listener: (signal: any) => void) { emit = listener; return () => {}; } },
    http: async () => ({ ok: true, status: 200, json: () => new Promise((resolve) => { respond = resolve; }), text: async () => '' }),
  });
  emit({ kind: 'message', message: { type: 'state', hostGeneration: 'host', revision: 1, liveSessions: [{ id: 'a', isStreaming: true }] } });
  kernel.dispatch({ type: 'session/activated', sessionId: 'a' });
  const loading = kernel.commands.session.loadSnapshot('a');
  await new Promise((resolve) => setImmediate(resolve));
  emit({ kind: 'message', message: { type: 'event', hostGeneration: 'host', revision: 3, sessionId: 'a', event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' newer' } } } });
  respond({ schemaVersion: 1, hostGeneration: 'host', revision: 2, entries: [], isStreaming: true, streamingMessage: { role: 'assistant', content: 'authoritative partial' } });
  kernel.dispatch({ type: 'session/snapshotReceived', sessionId: 'a', snapshot: await loading });
  assert.equal(kernel.stores.conversation.get().bySession.a.live.streamingText, 'authoritative partial newer');
  emit({ kind: 'message', message: { type: 'event', hostGeneration: 'host', revision: 4, sessionId: 'a', event: { type: 'agent_settled' } } });
  assert.equal(kernel.stores.session.isStreaming('a'), false);
  kernel.dispose();
});

caseTest('retry feedback is session scoped, clears on success and distinguishes cancellation', () => {
  let emit!: (signal: any) => void;
  const kernel = createAppKernel({ transport: { subscribe(listener: (signal: any) => void) { emit = listener; return () => {}; } }, http: async () => { throw new Error('unused'); } });
  const event = (sessionId: string, value: any) => emit({ kind: 'message', message: { type: 'event', sessionId, event: value } });
  event('a', { type: 'agent_start' });
  event('a', { type: 'message_end', message: { role: 'assistant', content: '', stopReason: 'error', errorMessage: '401 Bearer secret-token request-body-sensitive' } });
  event('a', { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: '401 Bearer secret-token' });
  assert.deepEqual(kernel.stores.conversation.get().bySession.a.live.retry, { attempt: 1, maxAttempts: 3, delayMs: 2000, reason: 'authentication' });
  assert.equal(kernel.stores.conversation.get().bySession.b, undefined);
  event('a', { type: 'auto_retry_end', success: true });
  assert.equal(kernel.stores.conversation.get().bySession.a.live.retry, null);
  assert.equal(kernel.stores.conversation.get().bySession.a.live.outcome, null);
  event('b', { type: 'auto_retry_end', success: false, finalError: 'Retry cancelled' });
  assert.deepEqual(kernel.stores.conversation.get().bySession.b.live.outcome, { status: 'cancelled' });
  event('a', { type: 'auto_retry_end', success: false, finalError: '429 secret-token' });
  event('a', { type: 'agent_settled' });
  assert.deepEqual(kernel.stores.conversation.get().bySession.a.live.outcome, { status: 'failed', reason: 'rate_limit' });
  event('a', { type: 'agent_start' });
  assert.equal(kernel.stores.conversation.get().bySession.a.live.outcome, null);
  kernel.dispose();
});

caseTest('a background stream preserves active conversation and tool slice references', () => {
  const conversation = new ConversationStore();
  const tools = new ToolExecutionStore();
  conversation.streamStarted('a', 'a-run');
  tools.started('a', { toolCallId: 'a-call', status: 'running' });
  const activeConversation = conversation.get().bySession.a;
  const activeTools = tools.get().bySession.a;
  conversation.streamDelta('b', 'text', 'background');
  tools.started('b', { toolCallId: 'b-call', status: 'running' });
  assert.equal(conversation.get().bySession.a, activeConversation);
  assert.equal(tools.get().bySession.a, activeTools);
});

caseTest('closing a session prevents a late snapshot from resurrecting its stores', async () => {
  let respond!: (data: any) => void;
  const kernel = createAppKernel({ transport: { subscribe: () => () => {} }, http: async () => ({ ok: true, status: 200, json: () => new Promise((resolve) => { respond = resolve; }), text: async () => '' }) });
  kernel.dispatch({ type: 'session/created', session: { id: 'a' } });
  const pending = kernel.commands.session.loadSnapshot('a');
  await new Promise((resolve) => setImmediate(resolve));
  kernel.dispatch({ type: 'session/closed', sessionId: 'a' });
  respond({ schemaVersion: 1, entries: [{ message: { role: 'assistant', content: 'late' } }], session: { id: 'a' } });
  kernel.dispatch({ type: 'session/snapshotReceived', sessionId: 'a', snapshot: await pending });
  assert.equal(kernel.stores.conversation.get().bySession.a, undefined);
  assert.equal(kernel.stores.session.get().sessions.length, 0);
  kernel.dispose();
});
