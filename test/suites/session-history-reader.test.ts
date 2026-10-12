const { test } = require('node:test') as typeof import('node:test');

test('History search tolerates malformed lines without hiding read failures or leaking content', async (t) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  // reads and searches a JSONL session without leaking parsing into the HTTP handler
  {
    const { readSessionHeaderCwd, readSessionSummary, searchSessionFile } = await import('../../src/server/session-history-reader.ts');
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
  }

  // malformed history warns once without content, while read failures remain visible
  {
    const { readSessionFileEntries } = require('../../bin/session-projection.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-history-diagnostic-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'redacted.jsonl');
    fs.writeFileSync(file, '{"type":"session"}\nsecret-key-do-not-log\n');
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...values) => { warnings.push(values); };
    try {
      assert.equal(readSessionFileEntries(file).length, 1);
      readSessionFileEntries(file);
      assert.equal(warnings.length, 1);
      assert.equal(JSON.stringify(warnings).includes('secret-key'), false);
      assert.throws(() => readSessionFileEntries(root));
      assert.deepEqual(readSessionFileEntries(path.join(root, 'missing')), []);
    } finally { console.warn = original; }
  }
});
