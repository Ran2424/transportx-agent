const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createNativeRpcHandlers } = require('../bin/rpc-handlers/native.js');

const reply = {
  success(data: unknown) { return { success: true, data }; },
  failure(error: string) { return { success: false, error }; },
};

test('Native RPC registry owns Pi transport metadata and attachment enrichment', async () => {
  const sent: Record<string, unknown>[] = [];
  const tracked: string[][] = [];
  let geoAborted = false;
  const attachment = { id: 'att-1', name: 'counts.png', relativePath: 'attachments/att-1/counts.png', mimeType: 'image/png', size: 12, sha256: 'a'.repeat(64), kind: 'image', source: 'picker', status: 'ready' };
  const session = {
    id: 'session-1', cwd: '/tmp/session-1', model: { images: true }, thinkingLevel: 'off', autoCompactionEnabled: true,
    pendingExtensionUiRequests: new Map(), manager: { broadcastUpdated() {} },
    async send(command: Record<string, unknown>) { sent.push(command); return { type: 'response', success: true }; },
    registerPromptAttachments(ids: string[]) { tracked.push(ids); },
    discardPromptAttachments() {},
    registerPromptGeoContexts() {},
    discardPromptGeoContexts() {},
    registerPromptCanvasContexts() {},
    discardPromptCanvasContexts() {},
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
  assert.deepEqual(sent, [{ type: 'prompt', sessionId: session.id, message: '分析附件\nattachment context', clientCommandId: 'client-1', images: [{ type: 'image', data: 'base64-image', mimeType: 'image/png' }] }]);
  assert.equal(handlers.prompt.native, true);
  assert.equal(handlers.prompt.reliable, true);
  assert.equal(handlers.compact.native, true);
  assert.equal(handlers.compact.reliable, false);
  assert.equal((await handlers.abort.handle({ type: 'abort', sessionId: session.id }, reply)).success, true);
  assert.equal(geoAborted, true);
});
