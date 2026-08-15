const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentCommands, createExtensionUiCommands, createPlatformCommands } = require('../public/kernel/commands.js');
const { ConversationStore } = require('../public/kernel/stores/conversation-store.js');

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
