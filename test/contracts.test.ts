const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function fixture(name: string) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'contracts', `${name}.json`), 'utf8'));
}

function diagnosticCodes(result: { diagnostics?: Array<{ code: string }> }) {
  return result.diagnostics?.map((item) => item.code) || [];
}

test('SessionSnapshot contract accepts v1 and diagnoses unknown versions explicitly', async () => {
  const session = fixture('session');
  const contract = await import('../src/contracts/session.ts');
  const server = require('../bin/session-projection.js');

  const valid = contract.parseSessionSnapshot(session.valid);
  assert.equal(valid.ok, true);
  if (!valid.ok) throw new Error('valid SessionSnapshot fixture was rejected');
  assert.equal(valid.value.entries.length, 2);
  assert.equal(server.SESSION_SNAPSHOT_SCHEMA_VERSION, 1);

  const invalidVersion = contract.parseSessionSnapshot(session.invalidVersion);
  assert.equal(invalidVersion.ok, false);
  assert.deepEqual(diagnosticCodes(invalidVersion), ['unknown_schema_version']);
  assert.equal(invalidVersion.diagnostics[0].path, 'session.schemaVersion');

  const invalidEntries = contract.parseSessionSnapshot(session.invalidEntries);
  assert.equal(invalidEntries.ok, false);
  assert.deepEqual(diagnosticCodes(invalidEntries), ['invalid_type']);
});

test('TaskSnapshot contract is shared by Extension and Web and diagnoses version/revision failures', async () => {
  const task = fixture('task');
  const contract = await import('../src/contracts/task.ts');
  const web = await import('../src/contracts/task.ts');
  const extension = await import('../extensions/pi-task-mode/task-state.ts');

  const valid = contract.parseTaskSnapshotStructured(task.valid);
  assert.equal(valid.ok, true);
  if (!valid.ok) throw new Error('valid TaskSnapshot fixture was rejected');
  assert.deepEqual(web.parseTaskSnapshot(task.valid), valid.value);
  assert.deepEqual(extension.parseTaskSnapshot(task.valid), valid.value);

  const invalidVersion = contract.parseTaskSnapshotStructured(task.invalidVersion);
  assert.equal(invalidVersion.ok, false);
  assert.deepEqual(diagnosticCodes(invalidVersion), ['unknown_schema_version']);

  const invalidRevision = contract.parseTaskSnapshotStructured(task.invalidRevision);
  assert.equal(invalidRevision.ok, false);
  assert.ok(diagnosticCodes(invalidRevision).includes('out_of_range'));

  const stale = contract.parseTaskSnapshot({ ...task.valid, revision: task.staleRevision });
  assert.ok(stale);
  if (!stale) throw new Error('stale TaskSnapshot fixture was not structurally valid');
  const regression = contract.acceptTaskSnapshotRevision(valid.value, stale);
  assert.equal(regression.accepted, false);
  assert.equal(regression.diagnostic?.code, 'revision_regression');
});

test('Geo envelope contract is shared by Extension/Web and diagnoses version/revision failures', async () => {
  const geo = fixture('geo');
  const contract = await import('../src/contracts/geo.ts');
  const web = await import('../src/contracts/geo.ts');

  const valid = contract.parseVisualizationEnvelopeStructured(geo.valid);
  assert.equal(valid.ok, true);
  if (!valid.ok) throw new Error('valid Geo envelope fixture was rejected');
  assert.deepEqual(web.parseVisualizationEnvelope(geo.valid), valid.value);

  const invalidVersion = contract.parseVisualizationEnvelopeStructured(geo.invalidVersion);
  assert.equal(invalidVersion.ok, false);
  assert.deepEqual(diagnosticCodes(invalidVersion), ['unknown_schema_version']);
  assert.equal(invalidVersion.diagnostics[0].path, 'envelope.version');

  const invalidRevision = contract.parseVisualizationEnvelopeStructured(geo.invalidRevision);
  assert.equal(invalidRevision.ok, false);
  assert.ok(diagnosticCodes(invalidRevision).includes('out_of_range'));

  const stale = contract.parseVisualizationEnvelope({ ...geo.valid, revision: geo.staleRevision });
  assert.ok(stale);
  if (!stale) throw new Error('stale Geo envelope fixture was not structurally valid');
  const regression = contract.acceptEnvelopeRevision(valid.value, stale);
  assert.equal(regression.accepted, false);
  assert.equal(regression.diagnostic?.code, 'revision_regression');
});

test('Bridge contract and Server parser share fixtures, capabilities, and structured diagnostics', async () => {
  const bridge = fixture('bridge');
  const contract = await import('../src/contracts/bridge.ts');
  const server = require('../bin/pi-web-bridge.js');

  const valid = contract.parsePiWebBridgeEnvelopeStructured(bridge.valid);
  assert.equal(valid.ok, true);
  if (!valid.ok) throw new Error('valid Bridge envelope fixture was rejected');
  assert.deepEqual(server.parsePiWebBridgeEnvelope(bridge.valid), valid.value);
  assert.equal(valid.value.capabilities.bridgeVersion, 1);
  assert.equal(valid.value.capabilities.geoSceneVersion, '1.0');

  const invalidVersion = contract.parsePiWebBridgeEnvelopeStructured(bridge.invalidVersion);
  assert.equal(invalidVersion.ok, false);
  assert.deepEqual(diagnosticCodes(invalidVersion), ['unknown_schema_version']);

  const invalidRevision = contract.parsePiWebBridgeEnvelopeStructured(bridge.invalidRevision);
  assert.equal(invalidRevision.ok, false);
  assert.ok(diagnosticCodes(invalidRevision).includes('out_of_range'));

  const invalidCapability = contract.parsePiWebBridgeEnvelopeStructured(bridge.invalidCapabilityVersion);
  assert.equal(invalidCapability.ok, false);
  assert.ok(diagnosticCodes(invalidCapability).includes('unknown_schema_version'));

  const stale = contract.parsePiWebBridgeEnvelope({ ...bridge.valid, revision: bridge.staleRevision });
  assert.ok(stale);
  if (!stale) throw new Error('stale Bridge envelope fixture was not structurally valid');
  const regression = contract.acceptBridgeRevision(valid.value, stale);
  assert.equal(regression.accepted, false);
  assert.equal(regression.diagnostic?.code, 'revision_regression');
});

test('Browser Kernel normalizes Server contract diagnostics into protocol AppErrors', async () => {
  const { createEventNormalizer } = await import('../src/public/kernel/event-normalizer.ts');
  const error = {
    code: 'contract_invalid',
    category: 'protocol',
    message: 'Unsupported Bridge capability version.',
    sessionId: 'session-contract',
    retryable: false,
  };
  const actions = createEventNormalizer().normalizeMessage({ type: 'contract_diagnostic', sessionId: 'session-contract', error });
  assert.deepEqual(actions, [{ type: 'error/raised', error }]);
});

test('Server creates initial capabilities and exposes incompatible Bridge diagnostics at session creation', () => {
  const bridge = fixture('bridge');
  const { LiveSessionManager, PiRpcSession } = require('../bin/sessions.js');
  const manager = new LiveSessionManager();
  const session = new PiRpcSession(manager, { cwd: process.cwd() });
  const metadata = session.metadata();
  assert.equal(metadata.capabilities.ok, true);
  assert.equal(metadata.capabilities.bridgeVersion, 1);
  assert.equal(metadata.capabilities.taskEnvelopeVersion, 1);
  assert.equal(metadata.capabilities.geoSceneVersion, '1.0');
  assert.deepEqual(metadata.capabilities.mismatches, []);

  const incompatible = new PiRpcSession(manager, {
    cwd: process.cwd(),
    entries: [{ type: 'custom', customType: 'pi-web-bridge', data: bridge.invalidCapabilityVersion }],
  });
  const invalidMetadata = incompatible.metadata();
  assert.equal(invalidMetadata.capabilities.ok, false);
  assert.ok(invalidMetadata.capabilities.diagnostics.some((item: { code: string }) => item.code === 'unknown_schema_version'));
});
