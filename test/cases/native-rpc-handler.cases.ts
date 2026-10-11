const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');

const { createNativeRpcHandlers } = require('../../bin/rpc-handlers/native.js');

const reply = {
  success(data: unknown) { return { success: true, data }; },
  failure(error: string) { return { success: false, error }; },
};

caseTest('pending message identity protects reordered contexts and discards only a rejected command', async (t: any) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { PiRpcSession, LiveSessionManager } = require('../../bin/sessions.js');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pending-message-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const session = new PiRpcSession(new LiveSessionManager(), { cwd });
  const pending = (commandId: string, text: string, canvasContextIds: string[]) => ({ commandId, text, attachmentIds: [], geoContextIds: [], canvasContextIds });
  session.registerPendingMessage(pending('first', 'first text', ['canvas-a']));
  session.registerPendingMessage(pending('second', 'second text', ['canvas-b']));
  session.trackMessage({ role: 'user', content: 'second text', timestamp: 1 }, 'message_start');
  assert.deepEqual(session.entries.at(-1).message.canvasContextIds, ['canvas-b']);
  assert.deepEqual(session.activeCanvasContextIds, ['canvas-b']);
  session.registerPendingMessage(pending('rejected', 'first text', ['canvas-a']));
  session.discardPendingMessage('rejected');
  assert.equal(session.pendingMessages[0].commandId, 'first');
  session.trackMessage({ role: 'user', content: 'unrelated extension message', timestamp: 2 }, 'message_start');
  assert.equal(session.pendingMessages.length, 1);
  session.trackMessage({ role: 'user', content: 'first text', timestamp: 3 }, 'message_start');
  assert.deepEqual(session.entries.at(-1).message.canvasContextIds, ['canvas-a']);
  assert.equal(session.pendingMessages.length, 0);
});

caseTest('failed ACK clears pending context; timeout keeps it for a late message', async () => {
  const discarded: string[] = [];
  let response: any = { success: false, error: 'rejected' };
  let pendingId = '';
  const session = {
    id: 'session', cwd: '/tmp', model: null, thinkingLevel: 'off', manager: { broadcastUpdated() {} },
    pendingExtensionUiRequests: new Map(),
    registerPendingMessage(pending: any) { pendingId = pending.commandId; },
    discardPendingMessage(id: string) { discarded.push(id); },
    async send() { if (response instanceof Error) throw response; return response; },
    abortGeoInteraction() {},
  };
  const handlers = createNativeRpcHandlers({ getLiveSession: () => session, resolveAttachments: () => [], buildAttachmentContext: () => '', buildGeoContext: () => '', buildCanvasContext: () => '', errorMessage: (error: Error) => error.message });
  assert.equal((await handlers.prompt.handle({ type: 'prompt', sessionId: 'session', message: 'same' }, reply)).delivery, 'rejected');
  assert.deepEqual(discarded, [pendingId]);
  response = Object.assign(new Error('RPC command timed out: prompt'), { delivery: 'unknown' });
  assert.equal((await handlers.prompt.handle({ type: 'prompt', sessionId: 'session', message: 'same' }, reply)).delivery, 'unknown');
  assert.equal(discarded.length, 1);
});

caseTest('Native RPC registry owns Pi transport metadata and attachment enrichment', async () => {
  const sent: Record<string, unknown>[] = [];
  const tracked: string[][] = [];
  let geoAborted = false;
  const attachment = { id: 'att-1', name: 'counts.png', relativePath: 'attachments/att-1/counts.png', mimeType: 'image/png', size: 12, sha256: 'a'.repeat(64), kind: 'image', source: 'picker', status: 'ready' };
  const session = {
    id: 'session-1', cwd: '/tmp/session-1', model: { images: true }, thinkingLevel: 'off', autoCompactionEnabled: true,
    pendingExtensionUiRequests: new Map(), manager: { broadcastUpdated() {} },
    async send(command: Record<string, unknown>) { sent.push(command); return { type: 'response', success: true }; },
    registerPendingMessage(pending: any) { tracked.push(pending.attachmentIds); },
    discardPendingMessage() {},
    abortGeoInteraction() { geoAborted = true; },
  };
  const handlers = createNativeRpcHandlers({
    getLiveSession: () => session,
    resolveAttachments: () => [attachment],
    attachmentBase64: () => 'base64-image',
    buildAttachmentContext: () => '\nattachment context',
    validateGeoContexts: (_session: unknown, ids: unknown) => ids as string[],
    buildGeoContext: () => '',
    validateCanvasContexts: (_session: unknown, ids: unknown) => ids as string[],
    buildCanvasContext: () => '',
    parseModel: () => ({ model: { provider: 'openai', id: 'gpt-5.5' } }),
    errorMessage(error: unknown) { return String(error); },
  });

  const result = await handlers.prompt.handle({ type: 'prompt', sessionId: session.id, message: '分析附件', attachmentIds: [attachment.id], clientCommandId: 'client-1' }, reply);
  assert.equal(result.success, true);
  assert.deepEqual(tracked, [[attachment.id]]);
  assert.deepEqual(sent, [{ type: 'prompt', sessionId: session.id, message: '分析附件\nattachment context', id: sent[0].id, images: [{ type: 'image', data: 'base64-image', mimeType: 'image/png' }] }]);
  assert.equal(handlers.prompt.native, true);
  assert.equal(handlers.prompt.reliable, true);
  assert.equal(handlers.compact.native, true);
  assert.equal(handlers.compact.reliable, false);
  assert.equal((await handlers.abort.handle({ type: 'abort', sessionId: session.id }, reply)).success, true);
  assert.equal(geoAborted, true);
});
