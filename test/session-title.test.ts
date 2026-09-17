const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appendSessionNameEntry, inferSessionTitle, isGenericSessionName } = require('../bin/session-title.js');

test('Session title inference removes conversational prefixes and later sentences', () => {
  assert.equal(inferSessionTitle(['Please analyze Hongqiao Station congestion. Include source data.']), 'Analyze Hongqiao Station congestion');
  assert.equal(inferSessionTitle(['', '检索早高峰地铁站客流分布']), '检索早高峰地铁站客流分布');
});

test('Explicit session names are persisted as history metadata', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-session-name-'));
  const filePath = path.join(directory, 'session.jsonl');
  fs.writeFileSync(filePath, `${JSON.stringify({ type: 'session', id: 'session-1' })}\n`);
  try {
    appendSessionNameEntry(filePath, '课程设计');
    const entries = fs.readFileSync(filePath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.at(-1).type, 'session_info');
    assert.equal(entries.at(-1).name, '课程设计');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('A new live session persists its requested name when Pi reveals the session file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-live-session-name-'));
  const filePath = path.join(directory, 'session.jsonl');
  fs.writeFileSync(filePath, `${JSON.stringify({ type: 'session', id: 'pi-session' })}\n`);
  try {
    const { LiveSessionManager, PiRpcSession } = require('../bin/sessions.js');
    const manager = new LiveSessionManager();
    const session = new PiRpcSession(manager, { cwd: directory, sessionName: '课程设计' });
    manager.sessions.set(session.id, session);
    session.updateStateFromResponse({ data: { sessionFile: filePath } });
    assert.match(fs.readFileSync(filePath, 'utf8'), /"type":"session_info","name":"课程设计"/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Session title inference returns no title for empty messages and preserves generic-name detection', () => {
  assert.equal(inferSessionTitle(['', '  ']), null);
  assert.equal(isGenericSessionName('New Chat'), true);
  assert.equal(isGenericSessionName('早高峰分析'), false);
});
