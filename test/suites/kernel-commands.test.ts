const { test } = require('node:test') as typeof import('node:test');

test('Kernel delivery, attachments and reconnects reconcile authoritative session state', async () => {
  const assert = require('node:assert/strict');
  const { createAgentCommands, createReportCommands, createSessionCommands } = require('../../public/kernel/commands.js');
  const { createAppKernel } = require('../../public/kernel/app-kernel.js');
  const { ConversationStore } = require('../../public/kernel/stores/conversation-store.js');
  const { SessionStore } = require('../../public/kernel/stores/session-store.js');
  const { ToolExecutionStore } = require('../../public/kernel/stores/tool-execution-store.js');
  const clock = new ConversationStore();
  clock.streamStarted('clock', 'first');
  const startedAt = clock.get().bySession.clock.live.runStartedAt;
  assert.equal(typeof startedAt, 'number');
  clock.messageStarted('clock', { role: 'assistant', content: '' });
  clock.streamCompleted('clock', { role: 'assistant', content: '继续分析' });
  clock.streamStarted('clock', 'retry');
  assert.equal(clock.get().bySession.clock.live.runStartedAt, startedAt, 'message transitions and retries preserve the independent run clock');
  clock.hydrate('clock', { entries: [], isStreaming: true });
  assert.equal(clock.get().bySession.clock.live.runStartedAt, startedAt, 'active snapshot reconciliation preserves the clock');
  clock.streamEnded('clock');
  assert.equal(clock.get().bySession.clock.live.runStartedAt, null, 'the clock clears when the run ends');
  clock.streamStarted('other-clock', 'second');
  assert.equal(clock.get().bySession.clock.live.runStartedAt, null, 'another session cannot restart the previous clock');

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

  // prompt uses acknowledged HTTP RPC before optimistic state
  {
    const fixture = deps((command) => ({ type: 'response', success: true, clientCommandId: command.clientCommandId, delivery: 'accepted' }));
    const agent = createAgentCommands(fixture.value);
    await agent.sendPrompt({ sessionId: 'session-1', message: '分析交通状态' });
    assert.equal(fixture.commands.length, 1);
    assert.equal(fixture.commands[0].type, 'prompt');
    assert.equal(typeof fixture.commands[0].clientCommandId, 'string');
    assert.deepEqual(fixture.actions.map((action) => action.type), ['conversation/promptSent']);
  }

  // failed prompt does not create optimistic sent state
  {
    const fixture = deps(() => ({ type: 'response', success: false, error: 'offline' }));
    const agent = createAgentCommands(fixture.value);
    await assert.rejects(() => agent.sendPrompt({ sessionId: 'session-1', message: '不会假成功' }), (error: { message?: string }) => error.message === 'offline');
    assert.deepEqual(fixture.actions, []);
    const firstId = fixture.commands[0].clientCommandId;
    await assert.rejects(() => agent.sendPrompt({ sessionId: 'session-1', message: '不会假成功' }));
    assert.notEqual(fixture.commands[1].clientCommandId, firstId);
  }

  // unknown prompt delivery keeps the original identity without automatic resend
  {
    const fixture = deps(() => ({ success: false, delivery: 'unknown', error: 'response lost' }));
    const agent = createAgentCommands(fixture.value);
    await assert.rejects(() => agent.sendPrompt({ sessionId: 'session-1', message: 'unknown delivery' }), (error: any) => error.code === 'delivery_unknown');
    assert.equal(fixture.commands.length, 1);
    await assert.rejects(() => agent.sendPrompt({ sessionId: 'session-1', message: 'unknown delivery' }));
    assert.equal(fixture.commands[0].clientCommandId, fixture.commands[1].clientCommandId);
  }

  // failed queued prompts do not resend on unrelated actions
  {
    let calls = 0;
    const kernel = createAppKernel({
      transport: { subscribe() { return () => { }; } }, http: async () => {
        calls++;
        return { ok: true, status: 200, async json() { return { success: false, delivery: 'unknown', error: 'response lost' }; } };
      }
    });
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
  }

  // attachment commands update the session store through kernel actions
  {
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
  }

  // late attachment lists cannot overwrite uploads, deletions or a newer list
  {
    const attachment = { id: 'att-1', name: 'demand.csv', relativePath: 'attachments/att-1/demand.csv', status: 'ready' };
    for (const mutation of ['upload', 'delete', 'list']) {
      let release: (payload: unknown) => void = () => { };
      const held = new Promise((resolve) => { release = resolve; });
      let calls = 0;
      const fixture = deps(() => ++calls === 1 ? held : { attachments: [attachment] });
      const session = createSessionCommands(fixture.value);
      const stale = session.listAttachments('session-1');
      if (mutation === 'upload') await session.uploadAttachment({ sessionId: 'session-1', file: new File(['x'], 'demand.csv'), source: 'picker' });
      else if (mutation === 'delete') await session.deleteAttachment('session-1', attachment.id);
      else await session.listAttachments('session-1');
      release({ attachments: [] });
      await stale;
      assert.deepEqual(fixture.actions.map((action) => action.type), [mutation === 'upload' ? 'session/attachmentAdded' : mutation === 'delete' ? 'session/attachmentRemoved' : 'session/attachmentsReceived']);
      if (mutation === 'list') assert.deepEqual(fixture.actions[0].attachments, [attachment]);
    }
  }

  // report source exposes an updated citation to the document reader
  {
    const fixture = deps(() => ({}));
    fixture.value.http = async () => ({
      ok: true, status: 200,
      headers: { get: (name: string) => name === 'X-Citation-Resource-Stale' ? '1' : null },
      async json() { return {}; }, async text() { return '# 新版报告'; },
    });
    const report = createReportCommands(fixture.value);
    assert.deepEqual(await report.loadSource('session-1', '/api/citations/report.md'), { content: '# 新版报告', encoding: 'utf8', size: 14, stale: true });
  }

  // authoritative user echo arriving before HTTP acknowledgement is not duplicated
  {
    const store = new ConversationStore();
    store.messageStarted('session-1', { role: 'user', content: '分析交通状态' });
    store.promptSent('session-1', { message: '分析交通状态' });
    const conversation = store.get().bySession['session-1'];
    assert.equal(conversation.snapshotEntries.length, 1);
    assert.equal(conversation.live.optimisticPrompt, null);
  }

  // an identical prompt remains optimistic when the latest authoritative message is an assistant
  {
    const store = new ConversationStore();
    store.messageStarted('session-1', { role: 'user', content: '再次分析' });
    store.streamCompleted('session-1', { role: 'assistant', content: '上一次结果' });
    store.promptSent('session-1', { message: '再次分析' });
    assert.equal(store.get().bySession['session-1'].live.optimisticPrompt?.message, '再次分析');
  }

  // kernel batches text deltas to one animation frame and flushes before message completion
  {
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
    animationGlobal.cancelAnimationFrame = () => { };
    const kernel = createAppKernel({
      transport: {
        subscribe(next: (signal: Record<string, unknown>) => void) {
          listener = next;
          return () => { };
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
  }

  // kernel projects streamed tool arguments before execution without exposing partial JSON
  {
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
    animationGlobal.cancelAnimationFrame = () => { };
    const kernel = createAppKernel({
      transport: {
        subscribe(next: (signal: Record<string, unknown>) => void) {
          listener = next;
          return () => { };
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
  }

  // authoritative snapshots replace abandoned branches, overlays, tools and dialogs
  {
    const kernel = createAppKernel({ transport: { subscribe: () => () => { } }, http: async () => { throw new Error('unused'); } });
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
  }

  // reconnect recovers missed completion and rejects late revision, request and Host generation
  {
    let emit!: (signal: any) => void;
    const pending: Array<(data: any) => void> = [];
    const kernel = createAppKernel({
      transport: { subscribe(listener: (signal: any) => void) { emit = listener; return () => { }; } },
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
  }

  // in-flight snapshot restores partial output then replays newer stream deltas
  {
    let emit!: (signal: any) => void;
    let respond!: (data: any) => void;
    const kernel = createAppKernel({
      transport: { subscribe(listener: (signal: any) => void) { emit = listener; return () => { }; } },
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
  }

  // retry feedback is session scoped, clears on success and distinguishes cancellation
  {
    let emit!: (signal: any) => void;
    const kernel = createAppKernel({ transport: { subscribe(listener: (signal: any) => void) { emit = listener; return () => { }; } }, http: async () => { throw new Error('unused'); } });
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
    const { messageOutcome } = require('../../bin/contracts/run-feedback.js');
    const truncated = { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning only' }], stopReason: 'length', usage: { output: 16384, reasoning: 16384 } };
    assert.deepEqual(messageOutcome(truncated), { status: 'failed', reason: 'output_limit' });
    event('a', { type: 'auto_retry_end', success: false, finalError: 'Output token limit' });
    event('a', { type: 'agent_start' });
    assert.equal(kernel.stores.conversation.get().bySession.a.live.outcome, null);
    kernel.dispose();
  }

  // a background stream preserves active conversation and tool slice references
  {
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
  }

  // closing a session prevents a late snapshot from resurrecting its stores
  {
    let respond!: (data: any) => void;
    const kernel = createAppKernel({ transport: { subscribe: () => () => { } }, http: async () => ({ ok: true, status: 200, json: () => new Promise((resolve) => { respond = resolve; }), text: async () => '' }) });
    kernel.dispatch({ type: 'session/created', session: { id: 'a' } });
    const pending = kernel.commands.session.loadSnapshot('a');
    await new Promise((resolve) => setImmediate(resolve));
    kernel.dispatch({ type: 'session/closed', sessionId: 'a' });
    respond({ schemaVersion: 1, entries: [{ message: { role: 'assistant', content: 'late' } }], session: { id: 'a' } });
    kernel.dispatch({ type: 'session/snapshotReceived', sessionId: 'a', snapshot: await pending });
    assert.equal(kernel.stores.conversation.get().bySession.a, undefined);
    assert.equal(kernel.stores.session.get().sessions.length, 0);
    kernel.dispose();
  }
});
