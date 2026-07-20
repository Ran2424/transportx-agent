const { test } = require('node:test');
const assert = require('node:assert/strict');

test('FeatureRegistry registers workspace views and forwards session and tool-result lifecycle', async () => {
  const modulePath = '../src/public/features/feature-registry.ts';
  const { FeatureRegistry } = await import(modulePath);
  const views: unknown[] = [];
  const sessions: unknown[] = [];
  const workspace = { registerView(view: unknown) { views.push(view); } };
  const registry = new FeatureRegistry(workspace as any);
  const feature = {
    id: 'example',
    workspaceView: { id: 'example-view', panel: {} as HTMLElement, activate() {} },
    setSession(context: unknown, reset: boolean) { sessions.push({ context, reset }); },
    handleToolResult(context: { toolName?: string }) {
      return context.toolName === 'example_tool'
        ? { kind: 'visualization' as const, id: 'result', title: 'Example', revision: 1, layers: 0, sources: 0 }
        : null;
    },
  };

  registry.register(feature);
  assert.equal(views.length, 1);
  registry.setSession('session-1', 'session-1', true);
  assert.deepEqual(registry.sessionContext, { sessionKey: 'session-1', resourceSessionId: 'session-1' });
  assert.deepEqual(sessions, [{ context: { sessionKey: 'session-1', resourceSessionId: 'session-1' }, reset: true }]);
  assert.equal(registry.handleToolResult({ sessionKey: 'session-1', toolName: 'other', result: {}, autoOpen: false }), null);
  assert.equal(registry.handleToolResult({ sessionKey: 'session-1', toolName: 'example_tool', result: {}, autoOpen: false })?.id, 'result');
  assert.throws(() => registry.register(feature), /Duplicate feature/);
});
