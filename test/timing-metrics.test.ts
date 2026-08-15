const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TimingMetricsStore } = require('../bin/timing-metrics.js');

test('timing metrics persist exact thinking and tool durations without changing raw entries', (t: any) => {
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
  assert.equal(enriched[1].message.durationMs, 1_250);
  assert.equal(rawEntries[0].message.content[0].durationMs, undefined);
  assert.equal(rawEntries[1].message.durationMs, undefined);
  assert.ok(fs.existsSync(path.join(cwd, '.tau', 'timing-metrics.v1.json')));
});

test('historical entries without exact timing metadata remain unannotated', (t: any) => {
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
});
