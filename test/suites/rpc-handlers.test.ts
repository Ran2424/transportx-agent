const { test } = require('node:test') as typeof import('node:test');

test('RPC dispatch validates pending contexts and enforces desktop installation boundaries', async (t) => {
  {
    const assert = require('node:assert/strict');
    const { createHtmlExportRpcHandlers } = require('../../bin/rpc-handlers/html-export.js');
    const reply = {
      success(data: unknown) { return { success: true, data }; },
      failure(error: string) { return { success: false, error }; },
    };

    // HTML export handler resolves a live session before delegating process execution
    {
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
    }
  }

  {
    const assert = require('node:assert/strict');
    const { createModuleRpcHandlers } = require('../../bin/rpc-handlers/module.js');
    const reply = {
      success(data: unknown) { return { success: true, data }; },
      failure(error: string) { return { success: false, error }; },
    };

    // Module RPC registry consistently gates installation commands outside Desktop
    {
      const handlers = createModuleRpcHandlers({
        desktopMode: false,
        installer: {},
        registry: { modules: new Map(), get() { return undefined; } },
        reloadModules() { },
        setModuleEnabled() { },
        hasActiveModule() { return false; },
        overview() { return {}; },
        errorMessage(error: unknown) { return String(error); },
      });
      const expected = 'Module installation is only available in the desktop app';
      for (const [type, handler] of Object.entries(handlers) as Array<[string, { handle(command: unknown, response: unknown): Promise<unknown> | unknown }]>) {
        assert.deepEqual(await handler.handle({ type }, reply), { success: false, error: expected });
      }
    }
  }

  {
    const assert = require('node:assert/strict');
    const { createNativeRpcHandlers } = require('../../bin/rpc-handlers/native.js');
    const reply = {
      success(data: unknown) { return { success: true, data }; },
      failure(error: string) { return { success: false, error }; },
    };

    // pending message identity protects reordered contexts and discards only a rejected command
    {
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
    }

    // failed ACK clears pending context; timeout keeps it for a late message
    {
      const discarded: string[] = [];
      let response: any = { success: false, error: 'rejected' };
      let pendingId = '';
      const session = {
        id: 'session', cwd: '/tmp', model: null, thinkingLevel: 'off', manager: { broadcastUpdated() { } },
        pendingExtensionUiRequests: new Map(),
        registerPendingMessage(pending: any) { pendingId = pending.commandId; },
        discardPendingMessage(id: string) { discarded.push(id); },
        async send() { if (response instanceof Error) throw response; return response; },
        abortGeoInteraction() { },
      };
      const handlers = createNativeRpcHandlers({ getLiveSession: () => session, resolveAttachments: () => [], buildAttachmentContext: () => '', buildGeoContext: () => '', buildCanvasContext: () => '', errorMessage: (error: Error) => error.message });
      assert.equal((await handlers.prompt.handle({ type: 'prompt', sessionId: 'session', message: 'same' }, reply)).delivery, 'rejected');
      assert.deepEqual(discarded, [pendingId]);
      response = Object.assign(new Error('RPC command timed out: prompt'), { delivery: 'unknown' });
      assert.equal((await handlers.prompt.handle({ type: 'prompt', sessionId: 'session', message: 'same' }, reply)).delivery, 'unknown');
      assert.equal(discarded.length, 1);
    }
  }

  {
    const assert = require('node:assert/strict');
    const { createPlatformRpcHandlers } = require('../../bin/rpc-handlers/platform.js');

    // Platform RPC registry serves the current overview
    {
      const handlers = createPlatformRpcHandlers(() => ({ modules: 3 }));
      assert.deepEqual(handlers.get_platform_overview.handle({ type: 'get_platform_overview' }, {
        success(data: unknown) { return { success: true, data }; },
        failure(error: string) { return { success: false, error }; },
      }), { success: true, data: { modules: 3 } });
    }
  }
});
