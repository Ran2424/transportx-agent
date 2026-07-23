const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
import type { TestContext } from 'node:test';

process.env.PI_CODING_AGENT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pirs-'));
process.env.PI_CODING_AGENT_SESSION_DIR = path.join(process.env.PI_CODING_AGENT_DIR, 'sessions');

const { PiRpcSession, normalizeModel, parseModelSpecToModel, handleRpcCommand, liveManager } = require('../bin/tau.js');
type FakeWrite = (data: string, cb?: (err?: Error | null) => void) => void;

function makeManager() {
  const broadcasts: Array<Record<string, unknown>> = [];
  return {
    broadcasts,
    broadcast(message: Record<string, unknown>) { broadcasts.push(message); },
    broadcastUpdated() {},
    removeExited() {},
  };
}

function makeSession(modelSpec = '') {
  const manager = makeManager();
  return { manager, session: new PiRpcSession(manager, { cwd: '/tmp', modelSpec }) };
}

test('renders the project context without unresolved or unsafe placeholders', () => {
  const { renderProjectPrompt } = require('../bin/sessions.js');
  const template = fs.readFileSync(path.join(process.cwd(), 'prompts', 'PI_SESSION_CONTEXT.md'), 'utf8');
  const rendered = renderProjectPrompt(template, '/tmp/example-task');
  assert.match(rendered, /miniconda3\/envs\/research\/bin\/python3\.10/);
  assert.match(rendered, /上海交通查询脚本目录：/);
  assert.ok(rendered.includes('/tmp/example-task'));
  assert.doesNotMatch(rendered, /\{\{/);
  assert.throws(() => renderProjectPrompt('{{UNKNOWN_PATH}}', '/tmp'), /Unknown project prompt placeholders/);
});

test('keeps a retried agent streaming until agent_settled and broadcasts every event', () => {
  const { session, manager } = makeSession();
  session.handleEvent({ type: 'turn_start' });
  session.handleEvent({ type: 'agent_start' });
  session.handleEvent({ type: 'agent_end', willRetry: true });
  assert.equal(session.isStreaming, true);
  session.handleEvent({ type: 'agent_settled' });
  assert.equal(session.isStreaming, false);
  assert.equal(manager.broadcasts.length, 4);
  assert.ok(manager.broadcasts.every((message) => message.type === 'event' && message.sessionId === session.id));
});

test('preserves canonical model identity and structured visualization output in snapshots', () => {
  const { session } = makeSession('openai/gpt-5.5:high');
  const usage = { input_tokens: 10, output_tokens: 5 };
  const visualization = { protocol: 'pi-visualization', version: '1.0', kind: 'geo', visualizationId: 'city_map', revision: 1 };
  session.handleEvent({ type: 'message_end', message: { role: 'assistant', content: 'done', model: 'gpt-5.5', usage } });
  session.handleEvent({
    type: 'message_end',
    message: { role: 'toolResult', toolCallId: 'call_map', toolName: 'present_visualization', content: [{ type: 'text', text: 'Map updated' }], details: { visualization }, isError: false },
  });
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-5.5' });
  assert.deepEqual(session.contextUsage.usage, usage);
  assert.deepEqual(session.snapshot().entries[1].message.details.visualization, visualization);
});

test('derives conversation recency from messages and normalizes model specifications', () => {
  const manager = makeManager();
  const session = new PiRpcSession(manager, {
    cwd: '/tmp',
    entries: [{ type: 'message', timestamp: '2026-07-21T05:00:00.000Z', message: { role: 'assistant', content: 'persisted reply' } }],
  });
  session.handleEvent({ type: 'message_start', message: { role: 'user', content: 'new prompt', timestamp: 1784725260000 } });
  session.handleEvent({ type: 'entry_appended', entry: { type: 'custom', customType: 'test-event', data: {} } });
  assert.equal(session.metadata().lastConversationAt, '2026-07-22T13:01:00.000Z');
  assert.deepEqual(normalizeModel('openrouter/z-ai/glm-5.2'), { provider: 'openrouter', id: 'z-ai/glm-5.2' });
  assert.deepEqual(parseModelSpecToModel('openrouter/z-ai/glm-5.2:high'), { model: { provider: 'openrouter', id: 'z-ai/glm-5.2' }, level: 'high' });
});

test('resolves child RPC responses and restores thinking level after a failed command', async () => {
  const { session } = makeSession('openai/gpt-4o:medium');
  session.child = { stdin: { writable: true, write: ((_data: string, cb?: (err?: Error | null) => void) => cb?.()) as FakeWrite } };
  const pending = session.send({ type: 'get_session_stats' }, { timeoutMs: 500 });
  const id = [...session.pending.keys()][0];
  session.handleResponse({ type: 'response', id, success: true, data: { sessionFile: '/tmp/s.jsonl', model: 'openai/gpt-5.5' } });
  await pending;
  assert.equal(session.sessionFile, '/tmp/s.jsonl');
  assert.deepEqual(session.model, { provider: 'openai', id: 'gpt-5.5' });

  liveManager.sessions.set(session.id, session);
  try {
    session.send = () => Promise.resolve({ type: 'response', success: false, error: 'nope' });
    const response = await handleRpcCommand({ type: 'set_thinking_level', level: 'high', sessionId: session.id });
    assert.equal(response.success, false);
    assert.equal(session.thinkingLevel, 'medium');
  } finally {
    liveManager.sessions.delete(session.id);
  }
});
