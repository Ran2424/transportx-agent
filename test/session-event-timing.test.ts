const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SessionEventTiming } = require('../bin/session-event-timing.js');
const { TimingMetricsStore } = require('../bin/timing-metrics.js');

test('records frozen thinking and tool durations from Pi events', (t: any) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-session-event-timing-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const timing = new SessionEventTiming(new TimingMetricsStore(cwd));
  const assistant = { role: 'assistant', responseId: 'response-1', content: [{ type: 'thinking', thinking: '分析中' }, { type: 'text', text: '结论' }] };

  timing.apply({ type: 'message_start', message: assistant }, 1_000);
  timing.apply({ type: 'message_update', assistantMessageEvent: { type: 'text_delta' } }, 1_180);
  const messageEnd = { type: 'message_end', message: assistant };
  timing.apply(messageEnd, 1_500);
  assert.equal((messageEnd.message.content as Array<{ durationMs?: number }>)[0].durationMs, 180);

  const toolStart = { type: 'tool_execution_start', toolCallId: 'tool-1' };
  const toolEnd = { type: 'tool_execution_end', toolCallId: 'tool-1' };
  timing.apply(toolStart, 2_000);
  timing.apply(toolEnd, 2_320);
  assert.deepEqual(toolEnd, { type: 'tool_execution_end', toolCallId: 'tool-1', startedAt: 2_000, endedAt: 2_320, durationMs: 320 });

  const toolResult = { type: 'message_end', message: { role: 'toolResult', toolCallId: 'tool-1', content: '完成' } };
  timing.apply(toolResult, 2_500);
  assert.equal((toolResult.message as { durationMs?: number }).durationMs, 320);
});
