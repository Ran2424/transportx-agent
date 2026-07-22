const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

type JsonRecord = Record<string, any>;

const FIXTURES = path.join(__dirname, 'fixtures', 'events');

function readFixture(name: string): JsonRecord {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

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
  return { kernel, sent, emit };
}

function replay(emit: (message: JsonRecord) => void, fixture: JsonRecord) {
  for (const event of fixture.events) {
    emit({ type: 'event', sessionId: fixture.sessionId, event });
  }
}

async function messageTextOf(message: JsonRecord): Promise<string> {
  const storeModule = '../public/kernel/stores/conversation-store.js';
  const { messageText } = await import(storeModule);
  return messageText(message);
}

function kernelState(kernel: any): JsonRecord {
  return JSON.parse(JSON.stringify({
    runtime: kernel.stores.runtime.get(),
    session: kernel.stores.session.get(),
    conversation: kernel.stores.conversation.get(),
    toolExecution: kernel.stores.toolExecution.get(),
    extensionUi: kernel.stores.extensionUi.get(),
  }));
}

test('kernel replays stream-happy into the expected conversation/tool/session state', async () => {
  const { kernel, emit } = await createKernel();
  const fixture = readFixture('stream-happy.json');
  replay(emit, fixture);
  const sid = fixture.sessionId;

  const conv = kernel.stores.conversation.get().bySession[sid];
  assert.equal(conv.snapshotEntries.length, 3);
  const [userEntry, firstAssistant, secondAssistant] = conv.snapshotEntries;
  assert.equal(userEntry.message.role, 'user');
  assert.equal(await messageTextOf(userEntry.message), '分析上海体育馆早高峰下车热点');
  assert.ok(firstAssistant.message.content.some((b: JsonRecord) => b.type === 'toolCall' && b.id === 'call_fixture_bash_1'));
  assert.equal(await messageTextOf(firstAssistant.message), '我先查一下可用的交通数据表。');
  assert.equal(await messageTextOf(secondAssistant.message), '查到了 ridehail.fact_ridehail_event，下车热点集中在漕溪北路与中山南二路。');

  // Overlay fully reconciled after agent_end.
  assert.deepEqual(conv.live, {
    runId: null,
    optimisticPrompt: null,
    streamingText: '',
    streamingThinking: '',
    active: false,
    queued: [],
  });

  const tool = kernel.stores.toolExecution.get().bySession[sid].call_fixture_bash_1;
  assert.equal(tool.status, 'completed');
  assert.equal(tool.toolName, 'bash');
  assert.equal(tool.isError, false);
  assert.ok(tool.result.content[0].text.includes('fact_ridehail_event'));
  assert.ok(tool.partialResult.content[0].text.includes('database_name'));

  assert.equal(kernel.stores.session.get().streamingBySession[sid], false);
  assert.equal(kernel.stores.runtime.get().lastError, null);
});

test('replaying the same fixtures twice yields deeply equal state', async () => {
  const first = await createKernel();
  const second = await createKernel();
  for (const name of ['stream-happy.json', 'stream-abort.json', 'stream-late-duplicate.json']) {
    const fixture = readFixture(name);
    replay(first.emit, fixture);
    replay(second.emit, fixture);
  }
  assert.deepEqual(kernelState(first.kernel), kernelState(second.kernel));
});

test('late/duplicate deltas are corrected by the authoritative message_end payload', async () => {
  const { kernel, emit } = await createKernel();
  const fixture = readFixture('stream-late-duplicate.json');
  replay(emit, fixture);

  const conv = kernel.stores.conversation.get().bySession[fixture.sessionId];
  assert.equal(conv.snapshotEntries.length, 1);
  // Duplicated/out-of-order deltas must not survive: the message_end text wins.
  assert.equal(
    await messageTextOf(conv.snapshotEntries[0].message),
    '上海早高峰的主要特征是内环高架与南北高架交汇处持续拥堵，早高峰时段为 7:30-9:00。',
  );
  assert.equal(conv.live.streamingText, '');
  assert.equal(conv.live.active, false);
});

test('reconnect snapshot does not duplicate content already present in the overlay', async () => {
  const { kernel, emit } = await createKernel();
  const snapshot = readFixture('reconnect-snapshot.json');
  const sid = snapshot.sessionId;
  const finalText = '查到了 ridehail.fact_ridehail_event，下车热点集中在漕溪北路与中山南二路。';

  // Stream interrupted before message_end/agent_end: content lives only in the overlay.
  replay(emit, {
    sessionId: sid,
    events: [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '' }], model: 'k2p7' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '查到了 ridehail.fact_ridehail_event，' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '下车热点集中在漕溪北路与中山南二路。' } },
    ],
  });
  assert.equal(kernel.stores.conversation.get().bySession[sid].live.streamingText, finalText);

  emit(snapshot);
  const conv = kernel.stores.conversation.get().bySession[sid];
  assert.equal(conv.snapshotEntries.length, 2);
  assert.equal(conv.snapshotEntries[0].message.role, 'user');
  assert.equal(await messageTextOf(conv.snapshotEntries[1].message), finalText);
  assert.equal(conv.live.streamingText, '');
  assert.equal(conv.live.active, false);
  assert.equal(kernel.stores.session.get().streamingBySession[sid], false);
  const session = kernel.stores.session.get().sessions.find((s: JsonRecord) => s.id === sid);
  assert.equal(session.sessionName, '重连基线会话');
});

test('abort resets the streaming flag and keeps the partial message', async () => {
  const { kernel, emit } = await createKernel();
  const fixture = readFixture('stream-abort.json');
  replay(emit, fixture);
  const sid = fixture.sessionId;

  const conv = kernel.stores.conversation.get().bySession[sid];
  assert.equal(conv.snapshotEntries.length, 2);
  assert.equal(conv.snapshotEntries[0].message.role, 'user');
  assert.equal(conv.snapshotEntries[1].message.stopReason, 'aborted');
  assert.equal(
    await messageTextOf(conv.snapshotEntries[1].message),
    '第一段：内环高架……第二段：南北高架……第三段（写到一半被中止）',
  );
  assert.equal(kernel.stores.session.get().streamingBySession[sid], false);
  assert.equal(conv.live.active, false);
  assert.equal(conv.live.streamingText, '');
});

test('unknown event/message types raise diagnosable errors without touching stores', async () => {
  const { kernel, emit } = await createKernel();
  replay(emit, readFixture('stream-happy.json'));
  const before = JSON.stringify({
    conversation: kernel.stores.conversation.get(),
    toolExecution: kernel.stores.toolExecution.get(),
    session: kernel.stores.session.get(),
  });

  emit({ type: 'event', sessionId: 'tau_fixture_happy', event: { type: 'mystery_event', foo: 1 } });
  let error = kernel.stores.runtime.get().lastError;
  assert.equal(error.code, 'unknown_event_type');
  assert.equal(error.category, 'protocol');
  assert.equal(error.retryable, false);
  assert.equal(error.diagnostics.eventType, 'mystery_event');

  emit({ type: 'totally_unknown_ws_message' });
  error = kernel.stores.runtime.get().lastError;
  assert.equal(error.code, 'unknown_message_type');

  const snapshot = readFixture('reconnect-snapshot.json');
  emit({ ...snapshot, schemaVersion: 2 });
  error = kernel.stores.runtime.get().lastError;
  assert.equal(error.code, 'unsupported_schema_version');
  assert.equal(error.diagnostics.schemaVersion, 2);

  const after = JSON.stringify({
    conversation: kernel.stores.conversation.get(),
    toolExecution: kernel.stores.toolExecution.get(),
    session: kernel.stores.session.get(),
  });
  assert.equal(after, before);
});

test('events for different sessions stay isolated', async () => {
  const { kernel, emit } = await createKernel();
  const ev = (sessionId: string, event: JsonRecord) => emit({ type: 'event', sessionId, event });
  const assistantStart = { type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: '' }] } };
  const delta = (text: string) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });

  ev('s-a', { type: 'agent_start' });
  ev('s-b', { type: 'agent_start' });
  ev('s-a', assistantStart);
  ev('s-a', delta('AAA'));
  ev('s-b', assistantStart);
  ev('s-b', delta('BBB'));
  ev('s-b', { type: 'agent_end' });

  const bySession = kernel.stores.conversation.get().bySession;
  assert.equal(bySession['s-a'].live.streamingText, 'AAA');
  assert.equal(bySession['s-a'].live.active, true);
  assert.equal(bySession['s-b'].live.streamingText, '');
  assert.equal(bySession['s-b'].snapshotEntries.length, 1);
  assert.equal(await messageTextOf(bySession['s-b'].snapshotEntries[0].message), 'BBB');

  const streaming = kernel.stores.session.get().streamingBySession;
  assert.equal(streaming['s-a'], true);
  assert.equal(streaming['s-b'], false);
});
