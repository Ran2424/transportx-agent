const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  SessionProjection,
  readSessionBranch,
  selectCurrentSessionBranch,
} = require('../bin/session-projection.js');

function entry(id: string, parentId: string | null, label: string) {
  return { type: 'message', id, parentId, timestamp: id, message: { role: 'user', content: label } };
}

test('session projection follows the last leaf parent chain and removes abandoned branches', () => {
  const root = entry('root', null, 'root');
  const shared = entry('shared', 'root', 'shared');
  const abandoned = entry('old', 'shared', 'old branch');
  const current = entry('new', 'shared', 'current branch');

  const projected = selectCurrentSessionBranch([
    { type: 'session', id: 'session-id', cwd: '/tmp' },
    root,
    shared,
    abandoned,
    current,
  ]);

  assert.deepEqual(projected.map((candidate: { id?: string }) => candidate.id), ['root', 'shared', 'new']);
});

test('session projection preserves legacy id-less sideband entries', () => {
  const projected = selectCurrentSessionBranch([
    entry('root', null, 'root'),
    entry('leaf', 'root', 'leaf'),
    { type: 'session_info', name: 'Renamed session' },
  ]);
  assert.equal(projected.length, 3);
  assert.equal(projected.at(-1).name, 'Renamed session');
});

test('session projection preserves sequential live entries before a Pi file exists', () => {
  const projection = new SessionProjection();
  projection.appendMessage({ role: 'user', content: 'hello' });
  projection.append({ type: 'custom', customType: 'test', data: { enabled: true } });
  assert.equal(projection.snapshot().schemaVersion, 1);
  assert.deepEqual(projection.entries.map((candidate: { type?: string }) => candidate.type), ['message', 'custom']);
});

test('session projection reads and selects a branch from Pi JSONL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-projection-'));
  const file = path.join(dir, 'session.jsonl');
  const rows = [
    { type: 'session', id: 'session-id', cwd: dir },
    entry('root', null, 'root'),
    entry('old', 'root', 'old'),
    entry('current', 'root', 'current'),
  ];
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  assert.deepEqual(readSessionBranch(file).map((candidate: { id?: string }) => candidate.id), ['root', 'current']);
});
