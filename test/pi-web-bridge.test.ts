const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Pi Web Bridge publishes a revisioned complete runtime envelope', async () => {
  const modulePath = '../extensions/pi-web-bridge/index.ts';
  const extension = (await import(modulePath)).default;
  const handlers = new Map<string, Function>();
  const entries: Array<{ customType: string; data: any }> = [];
  extension({
    on(name: string, handler: Function) { handlers.set(name, handler); },
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
    getActiveTools() { return ['read', 'tau_task']; },
    getThinkingLevel() { return 'medium'; },
    getAllTools() {
      return [
        { name: 'read', description: 'Read a file', parameters: { type: 'object' }, sourceInfo: { type: 'builtin' } },
        { name: 'tau_task', description: 'Track progress', parameters: { type: 'object' }, promptGuidelines: ['Keep status current'], sourceInfo: { type: 'extension' } },
      ];
    },
  });
  const context = {
    model: { provider: 'openai', id: 'gpt-5.5', name: 'GPT 5.5', contextWindow: 128000 },
    sessionManager: { getBranch: () => [] },
  };

  await handlers.get('session_start')!({}, context);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].customType, 'pi-web-bridge');
  assert.equal(entries[0].data.schemaVersion, 1);
  assert.equal(entries[0].data.revision, 1);
  assert.deepEqual(entries[0].data.model, context.model);
  assert.deepEqual(entries[0].data.tools.map((tool: { name: string; active: boolean }) => [tool.name, tool.active]), [['read', true], ['tau_task', true]]);

  await handlers.get('agent_start')!({}, context);
  assert.equal(entries.length, 1, 'unchanged manifests are not appended every turn');
  await handlers.get('thinking_level_select')!({ level: 'high' }, context);
  assert.equal(entries.at(-1)?.data.revision, 2);
  assert.equal(entries.at(-1)?.data.thinkingLevel, 'high');
  await handlers.get('model_select')!({ model: { provider: 'anthropic', id: 'claude-sonnet-4' } }, context);
  assert.equal(entries.at(-1)?.data.revision, 3);
  assert.equal(entries.at(-1)?.data.model.id, 'claude-sonnet-4');
});

test('server parser selects the latest valid Pi Web Bridge envelope', () => {
  const { latestPiWebBridgeEnvelope } = require('../bin/pi-web-bridge.js');
  const envelope = (revision: number, thinkingLevel: string) => ({
    schemaVersion: 1,
    revision,
    model: { provider: 'openai', id: 'gpt-5.5' },
    thinkingLevel,
    tools: [{ name: 'read', description: 'Read', parameters: {}, active: true }],
  });
  const latest = latestPiWebBridgeEnvelope([
    { type: 'custom', customType: 'pi-web-bridge', data: envelope(2, 'medium') },
    { type: 'custom', customType: 'pi-web-bridge', data: envelope(1, 'low') },
    { type: 'custom', customType: 'other', data: envelope(9, 'high') },
  ]);
  assert.equal(latest?.revision, 2);
  assert.equal(latest?.thinkingLevel, 'medium');
});
