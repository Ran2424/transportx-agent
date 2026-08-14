const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentCommands, createExtensionUiCommands } = require('../public/kernel/commands.js');
const { ConversationStore } = require('../public/kernel/stores/conversation-store.js');
const { ToolExecutionStore } = require('../public/kernel/stores/tool-execution-store.js');

function deps(handler: (command: Record<string, unknown>) => unknown, streaming = false) {
  const commands: Record<string, unknown>[] = [];
  const actions: Record<string, unknown>[] = [];
  return {
    commands,
    actions,
    value: {
      transport: { send() { throw new Error('side-effecting commands must not use WebSocket'); } },
      http: async (_path: string, init?: { body?: unknown }) => {
        commands.push(init?.body as Record<string, unknown>);
        const payload = handler(init?.body as Record<string, unknown>);
        return { ok: true, status: 200, async json() { return payload; } };
      },
      dispatch: (action: Record<string, unknown>) => actions.push(action),
      isStreaming: () => streaming,
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

test('extension response remains pending until HTTP RPC acknowledges it', async () => {
  const fixture = deps(() => ({ type: 'response', success: false, error: 'request expired' }));
  const extension = createExtensionUiCommands(fixture.value);
  await assert.rejects(() => extension.respond({ sessionId: 'session-1', id: 'ui-1', response: { confirmed: true } }), (error: { message?: string }) => error.message === 'request expired');
  assert.deepEqual(fixture.actions, []);
  assert.equal(fixture.commands[0].type, 'extension_ui_response');
  assert.equal(typeof fixture.commands[0].clientCommandId, 'string');
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
