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
      manager.sessions.set(session.id, session);
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
      // After Pi's first flush the pending name is appended exactly once.
      fs.writeFileSync(filePath, `${JSON.stringify({ type: 'session', id: 'pi-session' })}\n`);
      session.persistPendingSessionName();
      assert.match(fs.readFileSync(filePath, 'utf8'), /"type":"session_info","name":"课程设计"/);
      assert.equal(session.pendingSessionNamePersistence, null);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
