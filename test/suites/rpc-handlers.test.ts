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
        async authorizeModules() { throw new Error('No trust entry outside Desktop'); },
        forgetModules() {},
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

    // Model sync uses a registered Pi command, requires its receipt and never
    // forwards an unknown command as a model prompt or during an active run.
    {
      const { SessionModelSync } = require('../../bin/model-session-sync.js');
      const sync = new SessionModelSync();
      let mode = 'ok';
      const sent: any[] = [];
      const session = {
        isStreaming: false, isCompacting: false,
        async send(command: any) {
          sent.push(command);
          if (command.type === 'get_commands') return { success: true, data: { commands: mode === 'missing' ? [] : [{ name: 'transportx_reload_models', source: 'extension' }] } };
          if (mode !== 'no-receipt') sync.consume({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'transportx:model-sync', statusText: JSON.stringify({ token: command.message.split(' ')[1], ...(mode === 'error' ? { error: 'invalid model configuration' } : {}) }) });
          return { success: true };
        },
      };
      await Promise.all([sync.reload(session), sync.reload(session)]);
      assert.deepEqual(sent.map((command) => command.type), ['get_commands', 'prompt'], 'concurrent callers share one synchronization');
      assert.equal(sync.consume({ type: 'extension_ui_request', method: 'notify' }), false, 'other extension UI traffic is unchanged');
      for (const modeValue of ['missing', 'no-receipt', 'error']) {
        mode = modeValue; sent.length = 0;
        await assert.rejects(sync.reload(session), mode === 'missing' ? /重新打开/ : mode === 'error' ? /invalid model/ : /未确认/);
        if (mode === 'missing') assert.equal(sent.length, 1);
      }
      session.isStreaming = true; sent.length = 0;
      await assert.rejects(sync.reload(session), /正在运行/);
      assert.equal(sent.length, 0);
      session.isStreaming = false; session.isCompacting = true;
      await assert.rejects(sync.reload(session), /正在运行/);
      session.isCompacting = false; mode = 'ok';
      await sync.reload(session);

      const ordered: string[] = [];
      const native = createNativeRpcHandlers({ getLiveSession: () => ({ ...session, send: async () => { ordered.push('set_model'); return { success: true }; } }), syncModels: async () => { ordered.push('sync'); }, errorMessage: (error: Error) => error.message });
      await native.set_model.handle({ type: 'set_model', sessionId: 'active', provider: 'deepseek', modelId: 'new' }, reply);
      assert.deepEqual(ordered, ['sync', 'set_model']);
      const rejected = createNativeRpcHandlers({ getLiveSession: () => session, syncModels: async () => { throw new Error('sync rejected'); }, errorMessage: (error: Error) => error.message });
      sent.length = 0;
      assert.equal((await rejected.set_model.handle({ type: 'set_model', sessionId: 'active', provider: 'deepseek', modelId: 'new' }, reply)).error, 'sync rejected');
      assert.equal(sent.length, 0, 'a failed sync prevents a false successful model switch');
    }

    // pending message identity protects reordered contexts and discards only a rejected command
    {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const { PiRpcSession, LiveSessionManager } = require('../../bin/sessions.js');
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pending-message-'));
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      const session = new PiRpcSession(new LiveSessionManager(), { conversationId: 'conv_00000000-0000-4000-8000-000000000001', cwd });
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
      let opened = 0;
      const moduleIds: string[] = [];
      const handlers = createPlatformRpcHandlers(() => ({ modules: 3 }), async () => { opened++; }, async (id: string) => { moduleIds.push(id); });
      assert.deepEqual(handlers.get_platform_overview.handle({ type: 'get_platform_overview' }, {
        success(data: unknown) { return { success: true, data }; },
        failure(error: string) { return { success: false, error }; },
      }), { success: true, data: { modules: 3 } });
      const openedReply = await handlers.open_logs_directory.handle({ type: 'open_logs_directory', path: '/unrelated' }, { success: () => ({ success: true }), failure: () => ({ success: false }) });
      assert.equal(openedReply.success, true);
      assert.equal(opened, 1);
      const moduleReply = { success: () => ({ success: true }), failure: (error: string) => ({ success: false, error }) };
      assert.deepEqual(await handlers.open_module_directory.handle({ type: 'open_module_directory' }, moduleReply), { success: false, error: 'moduleId is required' });
      assert.equal((await handlers.open_module_directory.handle({ type: 'open_module_directory', moduleId: 'com.transportx.geo', path: '/unrelated' }, moduleReply)).success, true);
      assert.deepEqual(moduleIds, ['com.transportx.geo']);
    }
  }
});
