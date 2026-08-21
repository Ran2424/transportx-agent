const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SessionCapabilityTracker } = require('../bin/session-capability-tracker.js');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'contracts', 'bridge.json'), 'utf8'));

test('Capability tracker accepts the latest compatible Bridge envelope', () => {
  const tracker = new SessionCapabilityTracker('0.80.10');
  const update = tracker.applyPayload(fixture.valid);
  assert.equal(update.kind, 'accepted');
  if (update.kind !== 'accepted') throw new Error('valid bridge envelope was rejected');
  assert.equal(update.envelope.thinkingLevel, 'medium');
  assert.deepEqual(update.mismatches, []);
  assert.equal(tracker.snapshot().ok, true);
  assert.equal(tracker.snapshot().piVersion, '0.80.10');
});

test('Capability tracker keeps prior capabilities when Bridge revision regresses', () => {
  const tracker = new SessionCapabilityTracker('0.80.10');
  tracker.applyPayload(fixture.valid);
  const update = tracker.applyPayload({ ...fixture.valid, revision: fixture.staleRevision });
  assert.equal(update.kind, 'rejected');
  assert.equal(tracker.snapshot().ok, true);
  assert.equal(tracker.snapshot().bridgeVersion, 1);
});

test('Capability tracker records invalid Bridge diagnostics and resets when no Bridge entry exists', () => {
  const tracker = new SessionCapabilityTracker('0.80.10');
  const invalid = tracker.applyPayload(fixture.invalidCapabilityVersion);
  assert.equal(invalid.kind, 'invalid');
  assert.equal(tracker.snapshot().ok, false);
  assert.ok(tracker.snapshot().diagnostics.length > 0);
  assert.equal(tracker.applyLatest([]).kind, 'missing');
  assert.equal(tracker.snapshot().ok, true);
});
