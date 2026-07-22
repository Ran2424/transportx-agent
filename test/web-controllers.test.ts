const { test } = require('node:test');
const assert = require('node:assert/strict');

type JsonRecord = Record<string, any>;

async function createController() {
  const storeModule = '../public/kernel/stores/tool-execution-store.js';
  const controllerModule = '../public/controllers/tool-execution-controller.js';
  const [{ ToolExecutionStore }, { ToolExecutionController }] = await Promise.all([
    import(storeModule),
    import(controllerModule),
  ]);
  const store = new ToolExecutionStore();
  const calls: any[] = [];
  const remembered: any[] = [];
  let featureResults: any[] = [];
  const renderer = {
    createToolCard: (exec: JsonRecord) => calls.push(['create', exec]),
    updateToolCard: (exec: JsonRecord) => calls.push(['update', exec]),
    finalizeToolCard: (toolCallId: string, result: unknown, isError: boolean, durationMs?: number) =>
      calls.push(['finalize', toolCallId, result, isError, durationMs !== undefined]),
    setVisualizationSummary: (toolCallId: string, summary: JsonRecord) => calls.push(['viz', toolCallId, summary]),
  };
  const controller = new ToolExecutionController({
    store,
    renderer: renderer as any,
    features: { handleToolResult: (input: JsonRecord) => { featureResults.push(input); return null; } } as any,
    workspace: { refreshResourceViewIfVisible: () => {} } as any,
    formatResult: (result: unknown) => JSON.stringify(result),
    rememberDuration: (toolCallId: string, durationMs: number, sessionId: string | null) =>
      remembered.push([toolCallId, typeof durationMs === 'number', sessionId]),
  });
  return { store, controller, calls, remembered, featureResults };
}

test('ToolExecutionController reads execution state from the kernel store', async () => {
  const { store, controller, calls, remembered } = await createController();

  // The kernel normalizer populates the store before the controller runs.
  store.started('s-1', { toolCallId: 't-1', toolName: 'read', args: { path: 'a' }, status: 'running' });
  controller.start({ type: 'tool_execution_start', toolCallId: 't-1' }, 's-1');
  store.updated('s-1', 't-1', { text: 'partial' });
  controller.update({ type: 'tool_execution_update', toolCallId: 't-1' }, 's-1');
  store.ended('s-1', 't-1', { toolName: 'read', result: { text: 'done' }, isError: false });
  controller.end({ type: 'tool_execution_end', toolCallId: 't-1', isError: false }, 's-1');

  assert.equal(calls[0][0], 'create');
  assert.equal(calls[0][1].toolName, 'read');
  assert.deepEqual(calls[0][1].args, { path: 'a' });
  assert.equal(calls[0][1].status, 'pending');
  assert.equal(calls[1][0], 'update');
  assert.equal(calls[1][1].status, 'streaming');
  assert.equal(calls[1][1].output, JSON.stringify({ text: 'partial' }));
  assert.deepEqual(calls[2], ['finalize', 't-1', { text: 'done' }, false, true]);
  assert.deepEqual(remembered, [['t-1', true, 's-1']]);
});

test('ToolExecutionController routes tool results to features', async () => {
  const { store, controller, featureResults } = await createController();

  store.ended('s-1', 't-2', { toolName: 'present_visualization', result: { ok: true }, isError: false });
  controller.end({ type: 'tool_execution_end', toolCallId: 't-2', toolName: 'present_visualization', isError: false }, 's-1');
  assert.deepEqual(featureResults, [
    { sessionKey: 's-1', toolName: 'present_visualization', result: { ok: true }, autoOpen: true },
  ]);

  controller.restoreToolResult(
    { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: 'x' }], details: null, toolCallId: 't-3' } as any,
    'history:/tmp/a.jsonl',
  );
  assert.equal(featureResults.length, 2);
  assert.equal(featureResults[1].sessionKey, 'history:/tmp/a.jsonl');
  assert.equal(featureResults[1].autoOpen, false);

  // Non-toolResult messages are ignored.
  controller.restoreToolResult({ role: 'assistant', content: 'hi' } as any, 's-1');
  assert.equal(featureResults.length, 2);
});
