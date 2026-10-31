const { test } = require('node:test') as typeof import('node:test');

test('Pi RPC events and Geo payloads normalize with explicit protocol handling', async () => {
  const assert = require('node:assert/strict');
  const { createEventNormalizer } = require('../../public/kernel/event-normalizer.js');

  // Keep this inventory exhaustive against the installed Pi version, including
  // the two event types emitted directly by RPC mode rather than AgentSession.
  {
    type PiEvent = import('@earendil-works/pi-coding-agent', { with: { 'resolution-mode': 'import' } }).AgentSessionEvent;
    type UiRequest = import('@earendil-works/pi-coding-agent', { with: { 'resolution-mode': 'import' } }).RpcExtensionUIRequest;
    const fixtures = {
      agent_start: {}, agent_end: {}, agent_settled: {}, turn_start: {}, turn_end: {},
      message_start: { message: { role: 'user', content: '分析' } },
      message_update: { assistantMessageEvent: { type: 'text_delta', delta: '分析结果' } },
      message_end: { message: { role: 'assistant', content: '分析结果' } },
      tool_execution_start: { toolCallId: 'read-1', toolName: 'read', args: {} },
      tool_execution_update: { toolCallId: 'read-1', partialResult: {} },
      tool_execution_end: { toolCallId: 'read-1', result: {}, isError: false },
      queue_update: { steering: [], followUp: [] },
      compaction_start: { reason: 'manual' }, compaction_end: { reason: 'manual' },
      entry_appended: { entry: { id: 'entry-1', type: 'custom', customType: 'test', data: {} } },
      session_info_changed: { name: '新会话名' }, thinking_level_changed: { level: 'high' },
      auto_retry_start: { attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: '429' },
      auto_retry_end: { success: true },
      extension_error: { error: 'Extension failed' }, response: { success: true, command: 'steer' },
      extension_ui_request: { id: 'ask-1', method: 'confirm', title: '确认', message: '继续？' },
    } satisfies Record<PiEvent['type'] | 'extension_error' | 'response' | 'extension_ui_request', Record<string, unknown>>;
    const normalizer = createEventNormalizer();
    for (const [type, payload] of Object.entries(fixtures)) {
      const actions = normalizer.normalizeMessage({ type: 'event', sessionId: 'session-1', event: { type, ...payload } });
      assert.equal(actions.some((action: any) => action.type === 'error/raised' && action.error.category === 'protocol'), false, type);
    }
    const deltas = {
      start: null, text_start: null, text_delta: 'conversation/streamDelta', text_end: null,
      thinking_start: null, thinking_delta: 'conversation/streamDelta', thinking_end: null,
      toolcall_start: 'tool/preparing', toolcall_delta: 'tool/argumentsUpdated', toolcall_end: 'tool/argumentsUpdated',
      done: null, error: null,
    } satisfies Record<Extract<PiEvent, { type: 'message_update' }>['assistantMessageEvent']['type'], string | null>;
    for (const [type, actionType] of Object.entries(deltas)) {
      const event = { type: 'message_update', assistantMessageEvent: { type, delta: '增量', contentIndex: 0, partial: { content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }] } } };
      const actions = normalizer.normalizeMessage({ type: 'event', sessionId: 'session-1', event });
      assert.deepEqual(actions.map((action: any) => action.type), actionType ? [actionType] : [], type);
    }
    const uiMethods = {
      select: 'extensionUi/requested', confirm: 'extensionUi/requested', input: 'extensionUi/requested', editor: 'extensionUi/requested',
      notify: 'extensionUi/requested', set_editor_text: 'extensionUi/requested',
      setStatus: null, setWidget: null, setTitle: null,
    } satisfies Record<UiRequest['method'], string | null>;
    const { isPiExtensionDialogRequest } = require('../../public/contracts/pi-rpc.js');
    for (const [method, actionType] of Object.entries(uiMethods)) {
      const event = { type: 'extension_ui_request', id: method, method };
      const actions = normalizer.normalizeMessage({ type: 'event', sessionId: 'session-1', event });
      assert.deepEqual(actions.map((action: any) => action.type), actionType ? [actionType] : [], method);
      assert.equal(isPiExtensionDialogRequest(event), ['select', 'confirm', 'input', 'editor'].includes(method), method);
    }
    assert.equal(normalizer.normalizeMessage({ type: 'event', event: { type: 'extension_ui_request', method: 'future_method' } })[0].error.code, 'unknown_extension_ui_method');
    assert.deepEqual(normalizer.normalizeMessage({ type: 'event', sessionId: 'session-1', event: { type: 'session_info_changed', name: ' 新会话名 ' } }), [{ type: 'session/updated', session: { id: 'session-1', sessionName: '新会话名' } }]);
    assert.deepEqual(normalizer.normalizeMessage({ type: 'event', sessionId: 'session-1', event: { type: 'session_info_changed' } }), [{ type: 'session/updated', session: { id: 'session-1', sessionName: null } }]);
  }

  // Pi emits queue updates when guidance is queued and again before delivery.
  {
    const normalizer = createEventNormalizer();
    const event = (payload: Record<string, unknown>) => normalizer.normalizeMessage({ type: 'event', sessionId: 'session-1', event: payload });
    assert.deepEqual(event({ type: 'queue_update', steering: ['只分析早高峰'], followUp: [] }), [{ type: 'session/updated', session: { id: 'session-1', piQueue: { steering: ['只分析早高峰'], followUp: [] } } }]);
    assert.deepEqual(event({ type: 'queue_update', steering: [], followUp: ['然后生成报告'] }), [{ type: 'session/updated', session: { id: 'session-1', piQueue: { steering: [], followUp: ['然后生成报告'] } } }]);
    assert.deepEqual(event({ type: 'queue_update', steering: [], followUp: [] }), [{ type: 'session/updated', session: { id: 'session-1', piQueue: { steering: [], followUp: [] } } }]);
    assert.equal(event({ type: 'queue_update', steering: ['有效', 1], followUp: [] })[0].error.code, 'malformed_pi_queue');
    assert.equal(event({ type: 'queue_update', steering: [] })[0].error.code, 'malformed_pi_queue');
    const message = { role: 'user', content: [{ type: 'text', text: '只分析早高峰' }] };
    assert.equal(event({ type: 'message_start', message })[0].type, 'conversation/messageStarted');
    assert.deepEqual(event({ type: 'message_end', message }), [{ type: 'conversation/streamCompleted', sessionId: 'session-1', message }]);
    assert.equal(event({ type: 'unexpected_pi_event' })[0].error.code, 'unknown_event_type', 'unrecognized events still raise diagnostics');
  }

  // compaction lifecycle is rendered and waits for agent_settled before ending the stream
  {
    const normalizer = createEventNormalizer();
    const message = (event: Record<string, unknown>) => normalizer.normalizeMessage({ type: 'event', sessionId: 'session-1', event });
    assert.deepEqual(message({ type: 'agent_start' }).map((action: { type: string }) => action.type), ['conversation/streamStarted']);
    assert.deepEqual(message({ type: 'agent_end' }), []);
    assert.deepEqual(message({ type: 'compaction_start', reason: 'threshold' }), [{ type: 'session/compactionStarted', sessionId: 'session-1' }]);
    assert.deepEqual(message({ type: 'compaction_end', reason: 'threshold', aborted: false, willRetry: false }), [{ type: 'session/compactionEnded', sessionId: 'session-1' }]);
    assert.deepEqual(message({ type: 'agent_settled' }).map((action: { type: string }) => action.type), ['conversation/streamEnded']);
    const toolEnd = message({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'timed-call', startedAt: 1000, durationMs: 250, content: 'done' } }).find((action: { type: string }) => action.type === 'tool/ended');
    assert.equal(toolEnd.startedAt, 1000, 'message result timing survives event normalization');
  }

  // Geo interaction websocket updates are validated before reaching stores
  {
    const normalizer = createEventNormalizer();
    const [action] = normalizer.normalizeMessage({
      type: 'geo_interaction_updated',
      sessionId: 'session-1',
      request: { version: 999 },
    });
    assert.equal(action.type, 'error/raised');
    assert.equal(action.error.code, 'malformed_message');
  }

  // Geo screenshot websocket requests are validated before reaching stores
  {
    const normalizer = createEventNormalizer();
    const request = { version: 1, requestId: `geoshot_${'a'.repeat(16)}`, sessionId: 'session-1', visualizationId: 'traffic_map', sceneRevision: 2, status: 'waiting', createdAt: '2026-09-02T01:00:00.000Z', expiresAt: '2026-09-02T01:01:00.000Z' };
    assert.equal(normalizer.normalizeMessage({ type: 'geo_screenshot_updated', sessionId: 'session-1', request })[0].type, 'session/geoScreenshotUpdated');
    assert.equal(normalizer.normalizeMessage({ type: 'geo_screenshot_updated', sessionId: 'session-1', request: { version: 999 } })[0].type, 'error/raised');
  }
});
