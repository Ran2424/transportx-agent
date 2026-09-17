const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('derives a stable session name from explicit metadata or the first user message', async () => {
  const { deriveSessionName, titleFromMessageContent } = await import('../src/server/session-history-reader.ts');
  const generic = (name: string) => name === 'New session';
  assert.equal(deriveSessionName([
    { type: 'message', message: { role: 'user', content: 'Please analyze weekday congestion at Xujiahui.' } },
    { type: 'session_info', name: 'New session' },
    { type: 'session_info', name: '徐家汇早高峰分析' },
  ] as any, generic), '徐家汇早高峰分析');
  assert.equal(deriveSessionName([{ type: 'session_info', name: 'New session', explicit: true }] as any, generic), 'New session');
  assert.equal(deriveSessionName([{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Please analyze weekday congestion at Xujiahui. Include delays.' }] } }] as any, generic), 'Analyze weekday congestion at Xujiahui');
  assert.equal(titleFromMessageContent([{ type: 'thinking', thinking: 'ignored' }]), null);
});

test('reads and searches a JSONL session without leaking parsing into the HTTP handler', async () => {
  const { readSessionHeaderCwd, readSessionSummary, searchSessionFile } = await import('../src/server/session-history-reader.ts');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-session-history-'));
  const filePath = path.join(directory, 'session.jsonl');
  fs.writeFileSync(filePath, [
    JSON.stringify({ type: 'session', id: 'session-1', timestamp: '2026-08-21T08:00:00.000Z', cwd: '~/traffic' }),
    JSON.stringify({ type: 'message', message: { role: 'user', timestamp: '2026-08-21T08:01:00.000Z', content: 'Please analyze weekday congestion at Xujiahui.' } }),
    JSON.stringify({ type: 'session_info', name: '徐家汇早高峰分析' }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', timestamp: '2026-08-21T08:02:00.000Z', content: 'Working on it.' } }),
    JSON.stringify({ type: 'message', message: { role: 'user', timestamp: '2026-08-21T08:03:00.000Z', content: 'Include delays too.' } }),
  ].join('\n'));
  try {
    const normalize = (cwd: unknown) => cwd === '~/traffic' ? '/projects/traffic' : null;
    assert.equal(readSessionHeaderCwd(filePath, normalize), '/projects/traffic');
    assert.deepEqual(await readSessionSummary(filePath, normalize), {
      id: 'session-1',
      timestamp: '2026-08-21T08:00:00.000Z',
      lastConversationAt: '2026-08-21T08:03:00.000Z',
      name: '徐家汇早高峰分析',
      firstMessage: 'Analyze weekday congestion at Xujiahui.',
      cwd: '/projects/traffic',
    });
    assert.deepEqual(await searchSessionFile(filePath, 'congestion', normalize), {
      filePath,
      project: '/projects/traffic',
      sessionId: 'session-1',
      sessionName: '徐家汇早高峰分析',
      sessionTimestamp: '2026-08-21T08:00:00.000Z',
      firstMessage: 'Please analyze weekday congestion at Xujiahui.',
      matches: [{ role: 'user', snippet: '…Please analyze weekday congestion at Xujiahui.' }],
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
