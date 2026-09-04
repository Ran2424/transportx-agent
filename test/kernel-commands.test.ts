const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentCommands, createCitationCommands, createExtensionUiCommands, createGeoCommands, createPlatformCommands, createReportCommands, createSessionCommands, createVideoCommands } = require('../public/kernel/commands.js');
const { createAppKernel } = require('../public/kernel/app-kernel.js');
const { ConversationStore } = require('../public/kernel/stores/conversation-store.js');
const { SessionStore } = require('../public/kernel/stores/session-store.js');
const { ToolExecutionStore } = require('../public/kernel/stores/tool-execution-store.js');

function deps(handler: (command: Record<string, unknown>) => unknown, streaming = false) {
  const commands: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const actions: Record<string, unknown>[] = [];
  return {
    commands,
    paths,
    actions,
    value: {
      transport: { send() { throw new Error('side-effecting commands must not use WebSocket'); } },
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

test('prompt uses acknowledged HTTP RPC before optimistic state', async () => {
  const fixture = deps((command) => ({ type: 'response', success: true, clientCommandId: command.clientCommandId, delivery: 'accepted' }));
  const agent = createAgentCommands(fixture.value);
  await agent.sendPrompt({ sessionId: 'session-1', message: '分析交通状态' });
  assert.equal(fixture.commands.length, 1);
  assert.equal(fixture.commands[0].type, 'prompt');
  assert.equal(typeof fixture.commands[0].clientCommandId, 'string');
  assert.deepEqual(fixture.actions.map((action) => action.type), ['conversation/promptSent']);
});

test('failed prompt does not create optimistic sent state', async () => {
  const fixture = deps(() => ({ type: 'response', success: false, error: 'offline' }));
  const agent = createAgentCommands(fixture.value);
  await assert.rejects(() => agent.sendPrompt({ sessionId: 'session-1', message: '不会假成功' }), (error: { message?: string }) => error.message === 'offline');
  assert.deepEqual(fixture.actions, []);
  const firstId = fixture.commands[0].clientCommandId;
  await assert.rejects(() => agent.sendPrompt({ sessionId: 'session-1', message: '不会假成功' }));
  assert.equal(fixture.commands[1].clientCommandId, firstId);
});

test('streaming prompt keeps a stable command ID in the queue', async () => {
  const fixture = deps(() => ({ type: 'response', success: true }), true);
  const agent = createAgentCommands(fixture.value);
  await agent.sendPrompt({ sessionId: 'session-1', message: '排队分析' });
  assert.equal(fixture.commands.length, 0);
  assert.equal(fixture.actions[0].type, 'conversation/promptQueued');
  assert.equal(typeof fixture.actions[0].clientCommandId, 'string');
});

test('compacting prompt stays queued until the session is ready', async () => {
  const fixture = deps(() => ({ type: 'response', success: true }));
  fixture.value.isCompacting = () => true;
  const agent = createAgentCommands(fixture.value);
  await agent.sendPrompt({ sessionId: 'session-1', message: '等待压缩结束' });
  assert.equal(fixture.commands.length, 0);
  assert.equal(fixture.actions[0].type, 'conversation/promptQueued');
});

test('session snapshots hydrate and clear compaction state', () => {
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

test('attachment commands update the session store through kernel actions', async () => {
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

test('citation commands validate envelopes behind the HTTP command port', async () => {
  const citations = { protocol: 'pi-citation', version: '2.0', citationSetId: 'set-1', generatedAt: '2026-08-21T00:00:00.000Z', works: [], resources: [], locators: [], occurrences: [], provenance: [] };
  const fixture = deps((command) => command?.locatorId ? { marker: '[1]', citations } : { citations });
  const citation = createCitationCommands(fixture.value);
  assert.equal((await citation.list('session-1')).citationSetId, 'set-1');
  const created = await citation.createOccurrence('session-1', 'locator-1', 'support');
  assert.equal(created.marker, '[1]');
  assert.deepEqual(fixture.paths, ['/api/live-sessions/session-1/citations', '/api/live-sessions/session-1/citations/occurrences']);
  assert.deepEqual(fixture.commands[1], { locatorId: 'locator-1', role: 'support' });
});

test('video metrics stay behind the HTTP command port', async () => {
  const fixture = deps(() => ({ metrics: [] }));
  const video = createVideoCommands(fixture.value);
  assert.deepEqual(await video.getMetrics('session-1', 'video_resource'), { metrics: [] });
  assert.deepEqual(fixture.paths, ['/api/live-sessions/session-1/video-resources/video_resource/metrics']);
});

test('Geo screenshots stay behind the session HTTP command port', async () => {
  const fixture = deps(() => ({ filename: 'map-screenshot.png', path: '/tmp/map-screenshot.png', bytes: 68 }));
  const geo = createGeoCommands(fixture.value);
  const result = await geo.saveScreenshot('session-1', { visualizationId: 'map-1', sceneRevision: 2, dataUrl: 'data:image/png;base64,png' });
  assert.equal(result.filename, 'map-screenshot.png');
  assert.deepEqual(fixture.paths, ['/api/sessions/session-1/geo-screenshots']);
  assert.deepEqual(fixture.commands[0], { visualizationId: 'map-1', sceneRevision: 2, dataUrl: 'data:image/png;base64,png' });
});

test('PDF export stays behind the HTTP command port', async () => {
  const fixture = deps(() => ({ url: '/api/reports/download/report.pdf' }));
  const report = createReportCommands(fixture.value);
  assert.deepEqual(await report.exportPdf('交通报告', '<article>内容</article>'), { url: '/api/reports/download/report.pdf' });
  assert.deepEqual(fixture.paths, ['/api/reports/pdf/download']);
  assert.deepEqual(fixture.commands[0], { title: '交通报告', html: '<article>内容</article>' });
});

test('report source stays behind the HTTP command port', async () => {
  const fixture = deps(() => ({}));
  fixture.value.http = async (path: string) => {
    fixture.paths.push(path);
    return { ok: true, status: 200, async json() { return {}; }, async text() { return '# 交通报告'; } };
  };
  const report = createReportCommands(fixture.value);
  assert.deepEqual(await report.loadSource('session-1', '/api/citations/report.md'), { content: '# 交通报告', encoding: 'utf8', size: 14 });
  assert.deepEqual(fixture.paths, ['/api/citations/report.md']);
});

test('extension response closes the dialog before the HTTP RPC acknowledges it', async () => {
  const fixture = deps(() => ({ type: 'response', success: false, error: 'request expired' }));
  const extension = createExtensionUiCommands(fixture.value);
  await assert.rejects(() => extension.respond({ sessionId: 'session-1', id: 'ui-1', response: { confirmed: true } }), (error: { message?: string }) => error.message === 'request expired');
  assert.deepEqual(fixture.actions, [{ type: 'extensionUi/resolved', sessionId: 'session-1', requestId: 'ui-1' }]);
  assert.equal(fixture.commands[0].type, 'extension_ui_response');
  assert.equal(typeof fixture.commands[0].clientCommandId, 'string');
});

test('platform model provider commands preserve provider credentials behind RPC ports', async () => {
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

test('platform model management commands stay behind the RPC port', async () => {
  const fixture = deps((command) => ({ type: 'response', success: true, data: { model: { provider: command.provider, modelId: command.modelId, reference: `${command.provider}/${command.modelId}` } } }));
  const platform = createPlatformCommands(fixture.value);
  await platform.updateModel({ provider: 'custom', modelId: 'traffic-model', name: 'Traffic', contextWindow: 256000, reasoning: true, images: true });
  await platform.deleteModel('custom', 'traffic-model');
  await platform.deleteModelProvider('custom');
  assert.deepEqual(fixture.commands.map((command) => command.type), ['update_model', 'delete_model', 'delete_model_provider']);
  assert.equal(fixture.commands[0].contextWindow, 256000);
});

test('authoritative user echo arriving before HTTP acknowledgement is not duplicated', () => {
  const store = new ConversationStore();
  store.messageStarted('session-1', { role: 'user', content: '分析交通状态' });
  store.promptSent('session-1', { message: '分析交通状态' });
  const conversation = store.get().bySession['session-1'];
  assert.equal(conversation.snapshotEntries.length, 1);
  assert.equal(conversation.live.optimisticPrompt, null);
});

test('an identical prompt remains optimistic when the latest authoritative message is an assistant', () => {
  const store = new ConversationStore();
  store.messageStarted('session-1', { role: 'user', content: '再次分析' });
  store.streamCompleted('session-1', { role: 'assistant', content: '上一次结果' });
  store.promptSent('session-1', { message: '再次分析' });
  assert.equal(store.get().bySession['session-1'].live.optimisticPrompt?.message, '再次分析');
});

test('thinking duration freezes on the first answer text and stays on the completed message', () => {
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

test('tool execution duration freezes at completion', () => {
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

test('kernel batches text deltas to one animation frame and flushes before message completion', () => {
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
      send() {},
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

test('kernel projects streamed tool arguments before execution without exposing partial JSON', () => {
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
      send() {},
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
