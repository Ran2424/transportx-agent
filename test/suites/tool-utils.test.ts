const { test } = require('node:test') as typeof import('node:test');

test('Tool projection, file icons and localized truncation preserve conversation output', async () => {
  {
    const assert = require('node:assert/strict');

    // classifies Tool Card icons and resolves supplied file paths
    {
      const { compactCharacterCount, toolFileName, toolFilePath, toolIconName } = await import('../../src/web/platform/conversation/tool-card-utils.ts');
      assert.equal(toolIconName('present_visualization'), 'map');
      assert.equal(toolIconName('read_csv'), 'file');
      assert.equal(toolIconName('apply-patch'), 'write');
      assert.equal(toolFilePath({ sourceInfo: { path: 'reports/result.md' } }), 'reports/result.md');
      assert.equal(toolFileName('reports\\result.md'), 'result.md');
      assert.equal(compactCharacterCount(12_345), '12k');
    }
  }

  {
    const assert = require('node:assert/strict');

    // projects historical, live and orphan tool executions into their conversation positions
    {
      const { projectTools } = await import('../../src/web/platform/conversation/tool-projection.ts');
      const { toolExpansionStore: expansion } = await import('../../src/web/platform/conversation/tool-expansion-store.ts');
      expansion.set('view-a', 'shared-id', true);
      expansion.set('view-b', 'shared-id', false);
      expansion.reconcile(new Map([['view-a', null], ['view-b', new Set(['shared-id'])]]));
      assert.equal(expansion.get('view-a', 'shared-id'), true, 'loading preserves manual choice');
      assert.equal(expansion.get('view-b', 'shared-id'), false, 'sessions are isolated');
      expansion.reconcile(new Map([['view-a', new Set<string>()], ['view-b', new Set(['shared-id'])]]));
      assert.equal(expansion.get('view-a', 'shared-id'), undefined, 'complete projection removes expired choices');
      expansion.reconcile(new Map());
      assert.equal(expansion.get('view-b', 'shared-id'), undefined, 'session close clears choices');

      const { groupExecutionParts, executionTiming } = await import('../../src/web/platform/conversation/execution-parts.ts');
      const first = { id: 'first', tool: { id: 'first', name: 'read', args: {}, startedAt: 1000, durationMs: 2000, status: 'completed' } } as any;
      const parallel = { id: 'parallel', tool: { id: 'parallel', name: 'read', args: {}, startedAt: 1500, durationMs: 2000, status: 'completed' } } as any;
      assert.equal(executionTiming([first, parallel], false).durationMs, 2500, 'overlapping activity uses elapsed span, not summed duration');
      assert.equal(executionTiming([{ id: 'old', thinking: { text: 'old', active: false, startedAt: null, durationMs: null } }], false).durationMs, null, 'missing timing is not fabricated');
      const grouped = groupExecutionParts([{ kind: 'activity', activity: first }, { kind: 'activity', activity: parallel }, { kind: 'message', entry: { message: { role: 'assistant', content: '正文' } }, index: 0 }, { kind: 'activity', activity: first }]);
      assert.deepEqual(grouped.map((row) => row.kind), ['execution', 'message', 'execution'], 'body messages separate consecutive execution segments');
      assert.equal(grouped[0].kind === 'execution' && grouped[0].activities.length, 2);
      assert.equal(grouped[2].kind === 'execution' && grouped[2].id, 'execution-1');
      const prompt = { kind: 'message', entry: { message: { role: 'user', content: '开始分析', timestamp: 500 } }, index: 0 } as any;
      const waiting = groupExecutionParts([prompt], true, 600);
      assert.equal(waiting[1].kind === 'execution' && waiting[1].startedAt, 500, 'Working starts at the acknowledged user message, before any model activity');
      const afterTool = groupExecutionParts([prompt, { kind: 'activity', activity: first }], true, 600);
      assert.equal(afterTool.length, 2, 'model waiting reuses the tool segment instead of adding another status');
      assert.deepEqual(executionTiming([], true, true, 500), { active: true, startedAt: 500, durationMs: null });
      assert.equal(executionTiming([first], true, true, 500).startedAt, 500, 'completed tools do not pause or restart the independent Working clock');
      assert.equal(executionTiming([first, parallel], false, false, 500).durationMs, 3000, 'finished segment includes waiting since the prompt');
      assert.equal(executionTiming([{ id: 'missing', tool: { status: 'preparing' } } as any], true, true, 500).startedAt, 500, 'live Working does not require tool timing metadata');
      assert.equal(groupExecutionParts([prompt], false).length, 1, 'an ended run leaves no empty Working row');
      assert.deepEqual(executionTiming([], false), { active: false, startedAt: null, durationMs: null });
      const next = { id: 'next', tool: { ...first.tool, id: 'next', startedAt: 4000, durationMs: 700 } } as any;
      const body = { kind: 'message', entry: { message: { role: 'assistant', content: '先确认数据' } }, index: 1 } as any;
      const segments = groupExecutionParts([prompt, { kind: 'activity', activity: first }, body, { kind: 'activity', activity: next }], true, 500);
      const segment = segments[3];
      assert.equal(segment.kind, 'execution');
      if (segment.kind === 'execution') {
        assert.equal(segment.startedAt, null, 'a new segment does not inherit the prompt clock');
        assert.equal(executionTiming(segment.activities, true, true, segment.startedAt).startedAt, 4000);
        assert.equal(executionTiming(segment.activities, false, false, segment.startedAt).durationMs, 700, 'history reports only this segment, not earlier execution');
      }
      const nextWaiting = groupExecutionParts([prompt, body], true, 500).at(-1)!;
      assert.equal(nextWaiting.kind === 'execution' && nextWaiting.startedAt, null, 'an empty later segment cannot fall back to the original prompt');

      const assistant = { id: 'assistant-1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'traffic.json' } }] } } as any;
      const result = { id: 'result-1', message: { role: 'toolResult', toolCallId: 'tool-1', toolName: 'read', content: [{ type: 'text', text: 'done' }], durationMs: 120 } } as any;
      const orphan = { id: 'result-2', message: { role: 'toolResult', toolCallId: 'tool-2', toolName: 'write', content: [{ type: 'text', text: 'saved' }], isError: false } } as any;
      const projection = projectTools([assistant, result, orphan], {
        'tool-1': { toolCallId: 'tool-1', toolName: 'read', args: { path: 'override.json' }, partialResult: { content: 'partial' }, startedAt: 10, status: 'running' },
        'tool-3': { toolCallId: 'tool-3', toolName: 'bash', args: { command: 'pwd' }, status: 'preparing', argumentChars: 7 },
      });

      assert.deepEqual(projection.byEntry.get(assistant), [{ id: 'tool-1', name: 'read', args: { path: 'override.json' }, result: { content: 'partial' }, startedAt: 10, durationMs: 120, argumentChars: undefined, isError: undefined, status: 'running' }]);
      assert.deepEqual(projection.byEntry.get(orphan), [{ id: 'tool-2', name: 'write', args: {}, result: { content: [{ type: 'text', text: 'saved' }], details: undefined }, isError: false, startedAt: undefined, durationMs: undefined, status: 'completed' }]);
      assert.deepEqual(projection.liveOnly, [{ id: 'tool-3', name: 'bash', args: { command: 'pwd' }, result: undefined, isError: undefined, startedAt: undefined, durationMs: undefined, argumentChars: 7, status: 'preparing' }]);
    }
  }

  {
    const assert = require('node:assert/strict');

    // Tool-result truncation text follows the requested locale
    {
      const { formatToolResultText } = await import('../../src/public/tool-result.ts');
      const result = { content: [{ type: 'text', text: 'word!'.repeat(10_020) }] };

      assert.match(formatToolResultText(result, 'en-US'), /Tool output was too long and has been truncated: 50,100 characters/);
      assert.match(formatToolResultText(result, 'zh-CN'), /工具输出过长，已截断 50,100 字符/);
    }
  }
});
