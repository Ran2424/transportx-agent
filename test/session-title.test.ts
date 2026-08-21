const { test } = require('node:test');
const assert = require('node:assert/strict');

const { inferSessionTitle, isGenericSessionName } = require('../bin/session-title.js');

test('Session title inference removes conversational prefixes and later sentences', () => {
  assert.equal(inferSessionTitle(['Please analyze Hongqiao Station congestion. Include source data.']), 'Analyze Hongqiao Station congestion');
  assert.equal(inferSessionTitle(['', '检索早高峰地铁站客流分布']), '检索早高峰地铁站客流分布');
});

test('Session title inference returns no title for empty messages and preserves generic-name detection', () => {
  assert.equal(inferSessionTitle(['', '  ']), null);
  assert.equal(isGenericSessionName('New Chat'), true);
  assert.equal(isGenericSessionName('早高峰分析'), false);
});
