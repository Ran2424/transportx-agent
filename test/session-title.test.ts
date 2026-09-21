const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { appendSessionNameEntry, inferSessionTitle, isGenericSessionName, sessionFileReadyForNameAppend } = require('../bin/session-title.js');

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

test('Session file is ready for a name append only after Pi flushed its own header', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-name-append-ready-'));
  const filePath = path.join(directory, 'session.jsonl');
  try {
    // Missing file: appending would pre-create it and break Pi's exclusive first flush (EEXIST).
    assert.equal(sessionFileReadyForNameAppend(filePath), false);
    // Empty file or a file holding only session_info has no Pi header yet.
    fs.writeFileSync(filePath, '');
    assert.equal(sessionFileReadyForNameAppend(filePath), false);
    fs.writeFileSync(filePath, `${JSON.stringify({ type: 'session_info', name: '旧名' })}\n`);
    assert.equal(sessionFileReadyForNameAppend(filePath), false);
    // Malformed first line is not a Pi header either.
    fs.writeFileSync(filePath, 'not json\n');
    assert.equal(sessionFileReadyForNameAppend(filePath), false);
    // First line type === 'session' means Pi completed its first flush.
    fs.writeFileSync(filePath, `${JSON.stringify({ type: 'session', id: 'pi-session' })}\n`);
    assert.equal(sessionFileReadyForNameAppend(filePath), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Pending session name is deferred until Pi flushed, then persisted without pre-creating the file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-pending-name-'));
  const filePath = path.join(directory, 'session.jsonl');
  try {
    const { LiveSessionManager, PiRpcSession } = require('../bin/sessions.js');
    const manager = new LiveSessionManager();
    const session = new PiRpcSession(manager, { cwd: directory, sessionName: '课程设计' });
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
});
