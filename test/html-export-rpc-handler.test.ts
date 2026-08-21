const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHtmlExportRpcHandlers } = require('../bin/rpc-handlers/html-export.js');

const reply = {
  success(data: unknown) { return { success: true, data }; },
  failure(error: string) { return { success: false, error }; },
};

test('HTML export handler resolves a live session before delegating process execution', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const session = { cwd: '/tmp/traffic-task', sessionFile: '/tmp/traffic-task/session.jsonl' };
  const handler = createHtmlExportRpcHandlers({
    getLiveSession: () => session,
    resolveSessionFile: (filePath: string) => filePath,
    async runExport(input: Record<string, unknown>) { calls.push(input); return '/tmp/traffic-task/session.html'; },
    errorMessage(error: unknown) { return String(error); },
  }).export_html;
  assert.deepEqual(await handler.handle({ type: 'export_html', sessionId: 'session-1', outputPath: 'report.html' }, reply), { success: true, data: { path: '/tmp/traffic-task/session.html' } });
  assert.deepEqual(calls, [{ file: session.sessionFile, cwd: session.cwd, outputPath: 'report.html' }]);
});
