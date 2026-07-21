const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parsePiVersion, assertSupportedPiVersion } = require('../bin/pi-runtime.js');

test('Pi runtime version parser accepts semantic versions', () => {
  assert.deepEqual(parsePiVersion('0.80.10'), { major: 0, minor: 80, patch: 10, raw: '0.80.10' });
  assert.equal(parsePiVersion('not-a-version'), null);
});

test('Pi runtime compatibility is pinned to the tested 0.80 line', () => {
  assert.equal(assertSupportedPiVersion('0.80.10'), '0.80.10');
  assert.equal(assertSupportedPiVersion('0.80.99'), '0.80.99');
  assert.throws(() => assertSupportedPiVersion('0.80.9'), /Unsupported Pi version/);
  assert.throws(() => assertSupportedPiVersion('0.81.0'), /Unsupported Pi version/);
});
