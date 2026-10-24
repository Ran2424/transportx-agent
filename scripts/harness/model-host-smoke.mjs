import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function modelHostSmoke({ rpc, json, root, session, providerInputs }) {
  const snapshot = () => json(`/api/live-sessions/${session.id}/snapshot`);
  const before = await snapshot();
  const history = (state) => state.entries.filter((entry) => entry.type === 'message');
  const tools = before.entries.filter((entry) => entry.customType === 'pi-web-bridge').at(-1).data.tools;
  const calls = providerInputs.length;
  assert.equal((await rpc({ type: 'add_model', provider: 'probe', modelId: 'refreshed-model', name: 'Refreshed Model', baseUrl: JSON.parse(fs.readFileSync(path.join(root, 'models.json'), 'utf8')).providers.probe.baseUrl, api: 'openai-completions', contextWindow: 1_000_000, maxTokens: 32768 })).success, true);
  const refreshed = await rpc({ type: 'refresh_models', sessionId: session.id });
  assert.equal(refreshed.success, true);
  assert.deepEqual(refreshed.data.errors, []);
  assert.ok(refreshed.data.models.some((model) => model.provider === 'probe' && model.id === 'refreshed-model'));
  assert.equal((await rpc({ type: 'set_model', sessionId: session.id, provider: 'probe', modelId: 'refreshed-model' })).success, true);
  const state = await rpc({ type: 'get_state', sessionId: session.id });
  assert.equal(state.data.model.id, 'refreshed-model', 'the existing Pi process accepts a newly added model');
  assert.equal(state.data.model.contextWindow, 1_000_000);
  assert.equal(state.data.model.maxTokens, 32768);
  const after = await snapshot();
  assert.deepEqual(history(after), history(before), 'model control creates no conversation messages');
  assert.deepEqual(after.entries.filter((entry) => entry.customType === 'pi-web-bridge').at(-1).data.tools, tools, 'model reload preserves activated tools');
  assert.equal(providerInputs.length, calls, 'model control makes no inference request');
  const modelsPath = path.join(root, 'models.json');
  const validConfig = fs.readFileSync(modelsPath, 'utf8');
  const broken = JSON.parse(validConfig);
  broken.providers.probe.models[0].contextWindow = 'invalid-window';
  fs.writeFileSync(modelsPath, JSON.stringify(broken));
  try {
    const rejected = await rpc({ type: 'set_model', sessionId: session.id, provider: 'probe', modelId: 'smoke' });
    assert.equal(rejected.success, false, 'native config errors must not be hidden by Pi prompt ACK');
    assert.match(rejected.error, /contextWindow|Invalid|invalid|model/i);
  } finally { fs.writeFileSync(modelsPath, validConfig); }
  assert.equal((await rpc({ type: 'set_model', sessionId: session.id, provider: 'probe', modelId: 'smoke' })).success, true);
  return { currentSessionSynchronized: true, inferenceCalls: 0, conversationUnchanged: true, activeToolsPreserved: true, nativeErrorsReported: true };
}
