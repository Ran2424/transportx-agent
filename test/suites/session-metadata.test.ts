const { test } = require('node:test') as typeof import('node:test');

test('Session snapshots preserve authoritative metadata and independently configured managers', async (t) => {
  const assert = require('node:assert/strict');
  const { sessionSnapshot } = require('../../bin/session-metadata.js');
  const source = {
    id: 'tau_1',
    pid: 123,
    cwd: '/tmp/session',
    modelSpec: 'openai/gpt-5',
    model: { provider: 'openai', id: 'gpt-5', name: 'GPT-5' },
    thinkingLevel: 'high',
    sessionFile: '/tmp/session/history.jsonl',
    sessionName: '早高峰分析',
    isStreaming: true,
    isCompacting: false,
    autoCompactionEnabled: true,
    createdAt: '2026-08-21T00:00:00.000Z',
    lastActiveAt: '2026-08-21T00:01:00.000Z',
    lastConversationAt: '2026-08-21T00:00:30.000Z',
    contextUsage: { tokens: 23000, contextWindow: 100000, percent: 23 },
    resolvedSessionPlan: { schemaVersion: 3 },
  };

  // combines the projection snapshot with the authoritative session metadata
  {
    const snapshot = sessionSnapshot({ messages: [{ role: 'user', content: '分析' }] }, source, { ok: true }, []);
    assert.equal(snapshot.messages.length, 1);
    assert.equal(snapshot.session.id, source.id);
    assert.equal(snapshot.session.resolvedSessionPlan, source.resolvedSessionPlan);
    assert.equal(snapshot.contextUsage.percent, 23);
  }

  // live snapshots include Host clock, current partial message and active tools
  {
    const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
    const manager = new LiveSessionManager();
    const session = new PiRpcSession(manager, { id: 'clocked', cwd: '/tmp/clocked' });
    session.handleEvent({ type: 'agent_start' });
    session.handleEvent({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'current partial' }] } });
    session.handleEvent({ type: 'tool_execution_start', toolCallId: 'call', toolName: 'read', args: { path: 'file' } });
    const snapshot = session.snapshot();
    assert.equal(typeof snapshot.hostGeneration, 'string');
    assert.ok(snapshot.revision >= 3);
    assert.equal(snapshot.streamingMessage.content[0].text, 'current partial');
    assert.equal(snapshot.activeToolEvents[0].toolCallId, 'call');
    session.handleEvent({ type: 'tool_execution_end', toolCallId: 'call', result: {} });
    session.handleEvent({ type: 'message_end', message: { role: 'assistant', content: 'finished' } });
    assert.equal(session.snapshot().streamingMessage, null);
    assert.equal(session.snapshot().activeToolEvents.length, 0);
    assert.notEqual(new LiveSessionManager().clock().hostGeneration, manager.clock().hostGeneration);
    const { buildAttachmentContext } = require('../../bin/contracts/attachments.js');
    session.handleEvent({ type: 'queue_update', steering: [`只分析早高峰${buildAttachmentContext([{ name: 'private.csv', relativePath: 'private.csv', size: 20 }])}`, '只分析早高峰'], followUp: ['然后生成报告'] });
    const waitingQueue = { steering: ['只分析早高峰', '只分析早高峰'], followUp: ['然后生成报告'] };
    assert.deepEqual(session.snapshot().session.piQueue, waitingQueue, 'snapshot retains duplicate queued texts without internal attachment context');
    assert.deepEqual(session.liveMetadata().piQueue, waitingQueue, 'session list restores background queues');
    session.handleEvent({ type: 'queue_update', steering: ['只分析早高峰'], followUp: ['然后生成报告'] });
    assert.equal(session.snapshot().session.piQueue.steering.length, 1, 'consumption removes one occurrence');
    session.handleEvent({ type: 'queue_update', steering: [1], followUp: [] });
    assert.equal(session.snapshot().session.piQueue.steering.length, 1, 'malformed queue does not replace the last valid state');
    session.handleEvent({ type: 'agent_settled' });
    assert.equal(session.snapshot().session.piQueue.steering.length, 1, 'settling alone does not claim pending Pi messages were consumed');
    session.handleEvent({ type: 'queue_update', steering: [], followUp: [] });
    assert.deepEqual(session.snapshot().session.piQueue, { steering: [], followUp: [] });
    for (const method of ['select', 'confirm', 'input', 'editor', 'notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']) {
      session.handleEvent({ type: 'extension_ui_request', id: method, method });
    }
    assert.deepEqual([...session.pendingExtensionUiRequests.keys()], ['select', 'confirm', 'input', 'editor']);
    assert.deepEqual(session.snapshot().pendingExtensionUiRequests.map((request: any) => request.method), ['select', 'confirm', 'input', 'editor'], 'reconnect restores only questions awaiting a response');
    session.pendingSessionNamePersistence = '旧名称';
    session.handleEvent({ type: 'session_info_changed', name: ' Pi 新名称 ' });
    assert.equal(session.snapshot().session.sessionName, 'Pi 新名称');
    assert.equal(session.titleSet, true);
    assert.equal(session.pendingSessionNamePersistence, null, 'a pending old title cannot overwrite a Pi rename');
    session.handleEvent({ type: 'session_info_changed' });
    assert.equal(session.snapshot().session.sessionName, null);
  }

  // core managers import without reading configuration and accept independent runtime dependencies
  {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { execFileSync } = require('node:child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-manager-isolation-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'settings.json'), 'corrupt');
    const output = execFileSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        const { LiveSessionManager, PiRpcSession } = require('./bin/sessions.js');
        assert.equal(require.cache[require.resolve('./bin/config.js')], undefined);
        assert.equal(require.cache[require.resolve('./bin/platform-composition.js')], undefined);
        const calls = [];
        const assembler = { assemble: (domain, cwd) => { calls.push(domain); return { modules: [], assets: [], workingDirectory: cwd }; }, save: () => {}, load: () => {} };
        PiRpcSession.prototype.start = async function () { calls.push(this.manager.runtime.command); };
        const dependencies = (domain) => ({ defaultDomainId: domain, assembler, assemblerForProfile: () => assembler, createWorkspace: () => process.env.PI_CODING_AGENT_DIR, command: domain + '-pi', spawn: () => {}, endpoints: {}, launch: () => ({ args: [], env: {} }) });
        (async () => {
          const a = new LiveSessionManager(dependencies('a'));
          const b = new LiveSessionManager(dependencies('b'));
          const sa = await a.create({ model: 'provider/model' });
          const sb = await b.create({ model: 'provider/model' });
          assert.deepEqual(calls, ['a','a-pi','b','b-pi']);
          assert.equal(a.get(sb.id), undefined);
          assert.equal(b.get(sa.id), undefined);
          process.stdout.write('isolated');
        })().catch(error => { console.error(error); process.exitCode = 1; });
      `], { encoding: 'utf8', env: { ...process.env, PI_CODING_AGENT_DIR: root, TAU_APP_ROOT: path.join(root, 'missing') } });
    assert.equal(output, 'isolated');
  }
});
