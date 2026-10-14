const { test } = require('node:test') as typeof import('node:test');

test('Thinking and tool durations remain frozen across live events and history reload', async (t) => {
  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { SessionEventTiming } = require('../../bin/session-event-timing.js');
    const { TimingMetricsStore } = require('../../bin/timing-metrics.js');

    // records frozen thinking and tool durations from Pi events
    {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-session-event-timing-'));
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const timing = new SessionEventTiming(new TimingMetricsStore(cwd));
      const assistant = { role: 'assistant', responseId: 'response-1', content: [{ type: 'thinking', thinking: '分析中' }, { type: 'text', text: '结论' }] };

      timing.apply({ type: 'message_start', message: assistant }, 1_000);
      timing.apply({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }, 1_180);
      const messageEnd = { type: 'message_end', message: assistant };
      timing.apply(messageEnd, 1_500);
      assert.equal((messageEnd.message.content as Array<{ durationMs?: number }>)[0].durationMs, 180);
      assert.equal((messageEnd.message.content as Array<{ startedAt?: number }>)[0].startedAt, 1_000);

      const toolStart = { type: 'tool_execution_start', toolCallId: 'tool-1' };
      const toolEnd = { type: 'tool_execution_end', toolCallId: 'tool-1' };
      timing.apply(toolStart, 2_000);
      timing.apply(toolEnd, 2_320);
      assert.deepEqual(toolEnd, { type: 'tool_execution_end', toolCallId: 'tool-1', startedAt: 2_000, endedAt: 2_320, durationMs: 320 });

      const toolResult = { type: 'message_end', message: { role: 'toolResult', toolCallId: 'tool-1', content: '完成' } };
      timing.apply(toolResult, 2_500);
      assert.equal((toolResult.message as { durationMs?: number }).durationMs, 320);
      assert.equal((toolResult.message as { startedAt?: number }).startedAt, 2_000);
    }
  }

  {
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { TimingMetricsStore } = require('../../bin/timing-metrics.js');

    // timing metrics persist exact thinking and tool durations without changing raw entries
    {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-timing-'));
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const thinkingMessage = {
        role: 'assistant',
        responseId: 'response-timing-1',
        timestamp: 10_000,
        content: [{ type: 'thinking', thinking: '分析中' }, { type: 'text', text: '结论' }],
      };
      const toolResult = { role: 'toolResult', toolCallId: 'tool-timing-1', toolName: 'read', timestamp: 12_000, content: [{ type: 'text', text: '完成' }] };
      const store = new TimingMetricsStore(cwd);
      store.recordThinking(thinkingMessage, 1_000, 4_200, 3_200);
      store.recordTool('tool-timing-1', 5_000, 6_250, 1_250);

      const rawEntries: any[] = [{ type: 'message', message: thinkingMessage }, { type: 'message', message: toolResult }];
      const enriched = new TimingMetricsStore(cwd).enrichEntries(rawEntries);
      assert.equal(enriched[0].message.content[0].durationMs, 3_200);
      assert.equal(enriched[0].message.content[0].startedAt, 1_000);
      assert.equal(enriched[1].message.durationMs, 1_250);
      assert.equal(enriched[1].message.startedAt, 5_000);
      const existingDuration = new TimingMetricsStore(cwd).enrichEntries([{ type: 'message', message: { ...toolResult, durationMs: 1_250 } }]);
      assert.equal(existingDuration[0].message.startedAt, 5_000, 'reload restores exact start even when duration was already present');
      assert.equal(rawEntries[0].message.content[0].durationMs, undefined);
      assert.equal(rawEntries[1].message.durationMs, undefined);
      assert.equal(rawEntries[1].message.startedAt, undefined);
      assert.ok(fs.existsSync(path.join(cwd, '.tau', 'timing-metrics.v1.json')));
    }

    // historical entries without exact timing metadata remain unannotated
    {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-timing-empty-'));
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const entries = [
        { type: 'message', message: { role: 'user', timestamp: 1_000, content: '问题' } },
        { type: 'message', message: { role: 'assistant', timestamp: 9_000, content: [{ type: 'thinking', thinking: '旧思考' }, { type: 'text', text: '旧回答' }] } },
        { type: 'message', message: { role: 'toolResult', toolCallId: 'old-tool', timestamp: 10_000, content: '旧结果' } },
      ];
      const enriched = new TimingMetricsStore(cwd).enrichEntries(entries);
      assert.equal(enriched[1].message.content[0].durationMs, undefined);
      assert.equal(enriched[2].message.durationMs, undefined);
      assert.equal(fs.existsSync(path.join(cwd, '.tau', 'timing-metrics.v1.json')), false);
    }
  }
});
