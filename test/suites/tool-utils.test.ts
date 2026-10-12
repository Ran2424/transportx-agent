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
