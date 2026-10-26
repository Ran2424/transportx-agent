const { test } = require('node:test') as typeof import('node:test');

test('Titles are inferred and persisted once after Pi flushes its session header', async () => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { inferSessionTitle, isGenericSessionName } = require('../../bin/session-title.js');

  // Session title inference removes conversational prefixes and later sentences
  {
    assert.equal(inferSessionTitle(['Please analyze Hongqiao Station congestion. Include source data.']), 'Analyze Hongqiao Station congestion');
    assert.equal(inferSessionTitle(['', '检索早高峰地铁站客流分布']), '检索早高峰地铁站客流分布');
  }

  // Session title inference returns no title for empty messages and preserves generic-name detection
  {
    assert.equal(inferSessionTitle(['', '  ']), null);
    assert.equal(isGenericSessionName('New Chat'), true);
    assert.equal(isGenericSessionName('早高峰分析'), false);
  }

  // Pending session name is deferred until Pi flushed, then persisted without pre-creating the file
  {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pending-name-'));
    const filePath = path.join(directory, 'session.jsonl');
    try {
      const { LiveSessionManager, PiRpcSession } = require('../../bin/sessions.js');
      const manager = new LiveSessionManager();
      const session = new PiRpcSession(manager, { conversationId: 'conv_00000000-0000-4000-8000-000000000001', cwd: directory, sessionName: '课程设计' });
      const writes: Array<{ command: any; resolve: (value: any) => void }> = [];
      session.send = (command: any) => new Promise((resolve) => writes.push({ command, resolve }));
      manager.sessions.set(session.id, session);
      assert.equal(session.setSessionName('Untitled'), false, 'legacy inferred placeholder names remain filtered');
      const managed = new PiRpcSession(manager, { conversationId: 'conv_00000000-0000-4000-8000-000000000002', workspaceId: 'ws_00000000-0000-4000-8000-000000000001', cwd: directory, sessionName: '用户原名' });
      assert.equal(managed.setSessionName('Untitled'), true, 'a managed conversation accepts the explicit Manifest title');
      assert.equal(managed.liveMetadata().sessionName, 'Untitled');
      // Pi revealed the session file but has not flushed yet: the name write must
      // not pre-create the file (Pi's first flush uses exclusive create).
      session.updateStateFromResponse({ data: { sessionFile: filePath } });
      assert.equal(fs.existsSync(filePath), false);
      assert.equal(session.pendingSessionNamePersistence, '课程设计');
      // A file without Pi's header is still not ready; the name stays pending.
      fs.writeFileSync(filePath, `${JSON.stringify({ type: 'session_info', name: '旧名' })}\n`);
      session.persistPendingSessionName();
      assert.equal(fs.readFileSync(filePath, 'utf8').trim().split('\n').length, 1);
      assert.equal(session.pendingSessionNamePersistence, '课程设计');
      assert.equal(writes.length, 0);
      // After Pi's first flush, ask Pi to persist its own tree entry and await confirmation.
      fs.writeFileSync(filePath, `${JSON.stringify({ type: 'session', id: 'pi-session' })}\n`);
      const nativeBytes = fs.readFileSync(filePath);
      session.persistPendingSessionName();
      session.persistPendingSessionName();
      assert.equal(writes.length, 1); assert.deepEqual(writes[0].command, { type: 'set_session_name', name: '课程设计' });
      assert.equal(session.pendingSessionNamePersistence, '课程设计', 'unacknowledged names remain pending');
      session.pendingSessionNamePersistence = '后续改名'; session.setSessionName('后续改名');
      writes[0].resolve({ success: true }); await new Promise((resolve) => setImmediate(resolve));
      assert.equal(session.pendingSessionNamePersistence, '后续改名'); assert.equal(writes.length, 2);
      assert.deepEqual(writes[1].command, { type: 'set_session_name', name: '后续改名' });
      writes[1].resolve({ success: true }); await new Promise((resolve) => setImmediate(resolve));
      assert.equal(session.pendingSessionNamePersistence, null);
      assert.deepEqual(fs.readFileSync(filePath), nativeBytes, 'Host does not append unstructured Native entries');
      session.pendingSessionNamePersistence = '确认失败'; session.setSessionName('确认失败'); session.persistPendingSessionName();
      writes[2].resolve({ success: false, error: 'fixture rejection' }); await new Promise((resolve) => setImmediate(resolve));
      assert.equal(session.pendingSessionNamePersistence, '确认失败');
      session.persistPendingSessionName(); writes[3].resolve({ success: true }); await new Promise((resolve) => setImmediate(resolve));
      assert.equal(session.pendingSessionNamePersistence, null);

      const { repairLegacySessionNameTail } = require('../../bin/session-title.js');
      const { pathToFileURL } = require('node:url');
      const { SessionManager } = await import(pathToFileURL(path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js')).href);
      const legacy = [
        { type: 'session', version: 3, id: 'original-native', timestamp: '2026-10-26T00:00:00.000Z', cwd: directory },
        { type: 'message', id: 'original-reply', parentId: null, timestamp: '2026-10-26T00:00:01.000Z', message: { role: 'assistant', content: '历史回答' } },
        { type: 'session_info', name: '旧自动名', timestamp: '2026-10-26T00:00:02.000Z' },
        { type: 'session_info', name: '旧显式名', explicit: true, timestamp: '2026-10-26T00:00:03.000Z' },
      ];
      fs.writeFileSync(filePath, legacy.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const originalBytes = fs.readFileSync(filePath);
      assert.equal(SessionManager.open(filePath, directory).getBranch().filter((entry: any) => entry.type === 'message').length, 0, 'the old id-less tail hides the original branch from real Pi');
      assert.equal(repairLegacySessionNameTail(filePath, 'Manifest 名称'), true);
      assert.deepEqual(fs.readFileSync(filePath).subarray(0, originalBytes.length), originalBytes);
      const restored = SessionManager.open(filePath, directory);
      assert.ok(restored.getLeafId()); assert.equal(restored.getBranch().filter((entry: any) => entry.type === 'message').length, 1);
      assert.equal(restored.getSessionName(), 'Manifest 名称');
      const repaired = fs.readFileSync(filePath); assert.equal(repairLegacySessionNameTail(filePath, 'Manifest 名称'), false); assert.deepEqual(fs.readFileSync(filePath), repaired);
      fs.writeFileSync(filePath, [legacy[0], { ...legacy[1], parentId: 'missing-parent' }, legacy[3]].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
      const brokenChain = fs.readFileSync(filePath); assert.throws(() => repairLegacySessionNameTail(filePath, 'x'), { code: 'history_identity_mismatch' }); assert.deepEqual(fs.readFileSync(filePath), brokenChain);
      fs.writeFileSync(filePath, JSON.stringify(legacy[0]) + '\n' + JSON.stringify({ ...legacy[3], unknownField: 'do not guess' }) + '\n');
      const unverified = fs.readFileSync(filePath); assert.throws(() => repairLegacySessionNameTail(filePath, 'x'), { code: 'history_identity_mismatch' }); assert.deepEqual(fs.readFileSync(filePath), unverified);
      fs.appendFileSync(filePath, '{broken-history-with-private-text\n'); const corrupt = fs.readFileSync(filePath);
      assert.throws(() => repairLegacySessionNameTail(filePath, 'x'), (error: any) => error.code === 'history_identity_mismatch' && !error.message.includes('private-text')); assert.deepEqual(fs.readFileSync(filePath), corrupt);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
