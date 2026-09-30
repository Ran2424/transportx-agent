const { suiteCase } = require('../support/test-suite.ts');
const caseTest = (...args: any[]) => suiteCase(__filename, ...args);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionWorkingDirectory, makeSessionId } = require('../../bin/session-workspace.js');

caseTest('creates unique, safe task directories under an explicit project root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-session-workspace-'));
  try {
    const first = createSessionWorkingDirectory(root, '  徐家汇 / 上午:分析  ');
    const second = createSessionWorkingDirectory(root, '  徐家汇 / 上午:分析  ');
    assert.equal(path.dirname(first), root);
    assert.equal(path.dirname(second), root);
    assert.notEqual(first, second);
    assert.match(path.basename(first), /^\d{8}-\d{6}-徐家汇-+上午-分析$/);
    assert.equal(path.basename(first).includes('/'), false);
    assert.equal(path.basename(first).includes(':'), false);
    assert.match(makeSessionId(), /^tau_[a-z0-9]+_[a-z0-9]{7}$/);
    assert.throws(() => createSessionWorkingDirectory(path.join(root, 'missing')), /Directory not found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
