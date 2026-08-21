const { test } = require('node:test');
const assert = require('node:assert/strict');

test('derives a stable session name from explicit metadata or the first user message', async () => {
  const { deriveSessionName, titleFromMessageContent } = await import('../src/server/session-history-reader.ts');
  const generic = (name: string) => name === 'New session';
  assert.equal(deriveSessionName([
    { type: 'message', message: { role: 'user', content: 'Please analyze weekday congestion at Xujiahui.' } },
    { type: 'session_info', name: 'New session' },
    { type: 'session_info', name: '徐家汇早高峰分析' },
  ] as any, generic), '徐家汇早高峰分析');
  assert.equal(deriveSessionName([{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Please analyze weekday congestion at Xujiahui. Include delays.' }] } }] as any, generic), 'Analyze weekday congestion at Xujiahui');
  assert.equal(titleFromMessageContent([{ type: 'thinking', thinking: 'ignored' }]), null);
});
