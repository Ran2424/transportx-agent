const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  SessionProjection,
  readSessionBranch,
  selectCurrentSessionBranch,
} = require('../bin/session-projection.js');
const { parsePiWebBridgeEnvelope } = require('../bin/pi-web-bridge.js');

const FIXTURES = path.join(__dirname, 'fixtures');

function readJsonl(relativePath: string) {
  const text = fs.readFileSync(path.join(FIXTURES, relativePath), 'utf8');
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    entries.push(JSON.parse(line));
  }
  return entries;
}

function readJson(relativePath: string) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, relativePath), 'utf8'));
}

type JsonRecord = Record<string, any>;

// ─── Session JSONL fixtures ───────────────────────────────────────────────

test('straight-session.jsonl projects to a deterministic snapshot', () => {
  const entries = readJsonl('sessions/straight-session.jsonl');
  assert.equal(entries[0].type, 'session');
  const projected = selectCurrentSessionBranch(entries);
  // session header is dropped; every other entry stays on the single branch
  assert.equal(projected.length, entries.length - 1);
  assert.deepEqual(
    projected.map((entry: JsonRecord) => entry.id || `<${entry.type}>`),
    ['a1b2c3d4', 'e5f6a7b8', 'c9d0e1f2', '11111111', '22222222', '33333333', '44444444', '55555555', '66666666', '<session_info>'],
  );

  const projection = new SessionProjection(entries);
  const snapshot = projection.snapshot();
  assert.equal(snapshot.schemaVersion, 1);
  assert.deepEqual(snapshot.entries, projected);
  // multi-turn: two user messages, three assistant messages, one toolResult
  const roles = projected.filter((entry: JsonRecord) => entry.type === 'message').map((entry: JsonRecord) => entry.message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'toolResult', 'assistant', 'user', 'assistant']);
  // assistant message carries thinking + toolCall blocks in real pi shape
  const first = projected.find((entry: JsonRecord) => entry.id === '22222222');
  assert.deepEqual(first.message.content.map((block: JsonRecord) => block.type), ['thinking', 'toolCall']);
});

test('branch-session.jsonl selects only the current parentId chain', () => {
  const filePath = path.join(FIXTURES, 'sessions/branch-session.jsonl');
  const projected = readSessionBranch(filePath);
  // abandoned side branch (bb000004/bb000005) is excluded; id-less sideband
  // entries (custom pi-task-mode, session_info) are retained in place
  assert.deepEqual(
    projected.map((entry: JsonRecord) => entry.id || `<${entry.type}:${entry.customType || ''}>`),
    ['bb000001', 'bb000002', 'bb000003', 'bb000006', '<custom:pi-task-mode>', 'bb000007', '<session_info:>'],
  );
  const leaf = projected.filter((entry: JsonRecord) => entry.id).at(-1);
  assert.equal(leaf.id, 'bb000007');
  assert.equal(projected.at(-1).name, '基线分支会话');
});

// ─── Pi RPC event stream fixtures ─────────────────────────────────────────

const EVENT_FIXTURES = ['events/stream-happy.json', 'events/stream-abort.json', 'events/stream-late-duplicate.json'];

for (const relativePath of EVENT_FIXTURES) {
  test(`${relativePath} is a well-formed AppEvent sequence`, () => {
    const fixture = readJson(relativePath);
    assert.equal(typeof fixture.sessionId, 'string');
    assert.ok(Array.isArray(fixture.events) && fixture.events.length >= 4);
    const types = fixture.events.map((event: JsonRecord) => event.type);
    assert.equal(types[0], 'agent_start');
    assert.equal(types.at(-1), 'agent_end');
    for (const event of fixture.events) {
      assert.equal(typeof event.type, 'string');
      if (event.type === 'message_update') {
        assert.ok(['thinking_delta', 'text_delta'].includes(event.assistantMessageEvent?.type));
        assert.equal(typeof event.assistantMessageEvent.delta, 'string');
      }
      if (event.type === 'message_start' || event.type === 'message_end') {
        assert.ok(['user', 'assistant', 'toolResult'].includes(event.message?.role));
      }
      if (event.type === 'tool_execution_start') {
        assert.ok(event.toolCallId && event.toolName);
      }
      if (event.type === 'tool_execution_end') {
        assert.ok(event.toolCallId);
        assert.equal(typeof event.isError, 'boolean');
      }
    }
  });
}

test('stream-happy.json covers the full run lifecycle with a tool call', () => {
  const { events } = readJson('events/stream-happy.json');
  const types = events.map((event: JsonRecord) => event.type);
  assert.deepEqual(
    [...new Set(types)],
    ['agent_start', 'turn_start', 'message_start', 'message_end', 'message_update', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'turn_end', 'agent_end'],
  );
  // deltas concatenate to the authoritative message_end text
  const deltas = events
    .filter((event: JsonRecord) => event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
    .map((event: JsonRecord) => event.assistantMessageEvent.delta);
  const finalTexts = events
    .filter((event: JsonRecord) => event.type === 'message_end' && event.message.role === 'assistant')
    .map((event: JsonRecord) => event.message.content.filter((block: JsonRecord) => block.type === 'text').map((block: JsonRecord) => block.text).join(''));
  assert.equal(finalTexts.join(''), deltas.join(''));
  // tool result end references the started call
  const start = events.find((event: JsonRecord) => event.type === 'tool_execution_start');
  const end = events.find((event: JsonRecord) => event.type === 'tool_execution_end');
  assert.equal(end.toolCallId, start.toolCallId);
  assert.equal(end.isError, false);
});

test('stream-abort.json ends with an aborted message_end and no dangling stream', () => {
  const { events } = readJson('events/stream-abort.json');
  const end = events.find((event: JsonRecord) => event.type === 'message_end' && event.message.role === 'assistant');
  assert.equal(end.message.stopReason, 'aborted');
  const types = events.map((event: JsonRecord) => event.type);
  assert.ok(types.indexOf('turn_end') > types.lastIndexOf('message_update'));
  assert.deepEqual(types.slice(-2), ['turn_end', 'agent_end']);
});

test('stream-late-duplicate.json carries an authoritative message_end at least as long as the streamed text', () => {
  const { events } = readJson('events/stream-late-duplicate.json');
  const streamed = events
    .filter((event: JsonRecord) => event.type === 'message_update')
    .map((event: JsonRecord) => event.assistantMessageEvent.delta)
    .join('');
  const end = events.find((event: JsonRecord) => event.type === 'message_end');
  const authoritative = end.message.content.filter((block: JsonRecord) => block.type === 'text').map((block: JsonRecord) => block.text).join('');
  // app-main.ts:1076 — message_end only overrides when it is at least as long
  assert.ok(authoritative.length >= streamed.length);
  assert.notEqual(authoritative, streamed, 'fixture must actually contain duplicate/out-of-order deltas');
});

test('reconnect-snapshot.json is a valid live_session_snapshot overlapping streamed content', () => {
  const snapshot = readJson('events/reconnect-snapshot.json');
  assert.equal(snapshot.type, 'live_session_snapshot');
  assert.equal(snapshot.schemaVersion, 1);
  assert.ok(Array.isArray(snapshot.entries) && snapshot.entries.length > 0);
  assert.ok(snapshot.session?.id && snapshot.sessionId);
  assert.equal(typeof snapshot.isStreaming, 'boolean');
  for (const entry of snapshot.entries) {
    assert.equal(entry.type, 'message');
    assert.ok(['user', 'assistant'].includes(entry.message?.role));
  }
  // overlap semantics: the assistant entry equals stream-happy's final text,
  // so re-rendering from the snapshot must not append a duplicate
  const { events } = readJson('events/stream-happy.json');
  const streamedFinal = events
    .filter((event: JsonRecord) => event.type === 'message_end' && event.message.role === 'assistant')
    .map((event: JsonRecord) => event.message.content.filter((block: JsonRecord) => block.type === 'text').map((block: JsonRecord) => block.text).join(''))
    .at(-1);
  const snapshotAssistant = snapshot.entries.find((entry: JsonRecord) => entry.message.role === 'assistant');
  const snapshotText = snapshotAssistant.message.content.filter((block: JsonRecord) => block.type === 'text').map((block: JsonRecord) => block.text).join('');
  assert.equal(snapshotText, streamedFinal);
});

// ─── Feature fixtures (task / geo / bridge) ───────────────────────────────

test('task-entries.json parses through task-protocol', async () => {
  const fixture = readJson('features/task-entries.json');
  // 与 geo-protocol.test.ts 相同模式：变量路径避免 TS 解析 src TS 模块类型
  const modulePath = '../src/public/features/task/task-protocol.ts';
  const { parseTaskStateEntry, parseTaskModeEntry, parseTaskToolResult } = await import(modulePath);

  const state = parseTaskStateEntry(fixture.stateEntry);
  assert.ok(state);
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.revision, 3);
  assert.equal(state.enabled, true);
  assert.equal(state.task.taskId, 'task_fixture_001');
  assert.equal(state.task.status, 'running');
  assert.equal(state.task.activeStepId, 'query');
  assert.equal(state.task.steps.length, 3);
  assert.equal(parseTaskModeEntry(fixture.stateEntry), true);

  const legacy = parseTaskStateEntry(fixture.legacyStateEntry);
  assert.ok(legacy);
  assert.equal(legacy.schemaVersion, 0);
  assert.equal(legacy.enabled, true);

  const disabled = parseTaskStateEntry(fixture.disabledStateEntry);
  assert.ok(disabled);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.task, null);

  const fromTool = parseTaskToolResult(fixture.toolResult);
  assert.ok(fromTool);
  assert.equal(fromTool.taskId, state.task.taskId);
  assert.equal(fromTool.revision, 3);
  assert.deepEqual(fromTool.steps.map((step: JsonRecord) => step.status), ['completed', 'running', 'pending']);

  const interaction = parseTaskToolResult(fixture.interactionToolResult);
  assert.ok(interaction);
  assert.equal(interaction.status, 'waiting_user');
});

test('geo-tool-result.json parses through geo protocol', async () => {
  const fixture = readJson('features/geo-tool-result.json');
  const modulePath = '../src/public/visualization/geo/protocol.ts';
  const { getVisualizationFromToolResult, parseGeoScene } = await import(modulePath);

  const envelope = getVisualizationFromToolResult(fixture.presentVisualizationResult);
  assert.ok(envelope);
  assert.equal(envelope.protocol, 'pi-visualization');
  assert.equal(envelope.kind, 'geo');
  assert.equal(envelope.visualizationId, 'dropoff_heatmap');
  assert.equal(envelope.revision, 1);
  assert.equal(envelope.operation, 'replace');
  assert.ok(envelope.scene);
  assert.equal(envelope.scene.metadata.title, '下车热点热力图');
  assert.equal(envelope.scene.sources.length, 1);
  assert.equal(envelope.scene.layers.length, 2);

  const scene = parseGeoScene(fixture.presentVisualizationResult.details.visualization.scene);
  assert.equal(scene.ok, true);
  assert.deepEqual(scene.value.layers.map((layer: JsonRecord) => layer.type), ['circle', 'label']);
});

test('bridge-envelope.json parses through pi-web-bridge', () => {
  const { entry } = readJson('features/bridge-envelope.json');
  assert.equal(entry.type, 'custom');
  assert.equal(entry.customType, 'pi-web-bridge');
  const envelope = parsePiWebBridgeEnvelope(entry.data);
  assert.ok(envelope);
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.revision, 2);
  assert.deepEqual(envelope.model, { provider: 'kimi-coding', id: 'k2p7', contextWindow: 262144 });
  assert.equal(envelope.thinkingLevel, 'high');
  assert.equal(envelope.tools.length, 4);
  assert.ok(envelope.tools.every((tool: JsonRecord) => typeof tool.name === 'string' && typeof tool.active === 'boolean'));
});
