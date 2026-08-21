const { test } = require('node:test');
const assert = require('node:assert/strict');

test('projects historical, live and orphan tool executions into their conversation positions', async () => {
  const { projectTools } = await import('../src/web/platform/conversation/tool-projection.ts');
  const assistant = { id: 'assistant-1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'traffic.json' } }] } } as any;
  const result = { id: 'result-1', message: { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: 'done' }], durationMs: 120 } } as any;
  const orphan = { id: 'result-2', message: { role: 'toolResult', toolCallId: 'tool-2', toolName: 'write', content: [{ type: 'text', text: 'saved' }], isError: false } } as any;
  const projection = projectTools([assistant, result, orphan], {
    'tool-1': { toolCallId: 'tool-1', toolName: 'read', args: { path: 'override.json' }, partialResult: { content: 'partial' }, startedAt: 10, status: 'running' },
    'tool-3': { toolCallId: 'tool-3', toolName: 'bash', args: { command: 'pwd' }, status: 'preparing', argumentChars: 7 },
  });

  assert.deepEqual(projection.byEntry.get(assistant), [{ id: 'tool-1', name: 'read', args: { path: 'override.json' }, result: { content: 'partial' }, startedAt: 10, durationMs: 120, argumentChars: undefined, isError: undefined, status: 'running' }]);
  assert.deepEqual(projection.byEntry.get(orphan), [{ id: 'tool-2', name: 'write', args: {}, result: { content: [{ type: 'text', text: 'saved' }], details: undefined }, isError: false, durationMs: undefined, status: 'completed' }]);
  assert.deepEqual(projection.liveOnly, [{ id: 'tool-3', name: 'bash', args: { command: 'pwd' }, result: undefined, isError: undefined, startedAt: undefined, durationMs: undefined, argumentChars: 7, status: 'preparing' }]);
});
