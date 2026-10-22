const { test } = require('node:test') as typeof import('node:test');

test('Bridge capabilities refuse regressed revisions and diagnose incompatible envelopes', async () => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { SessionCapabilityTracker } = require('../../bin/session-capability-tracker.js');
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'contracts', 'bridge.json'), 'utf8'));
  assert.equal(require('../../bin/tool-contracts.js').readPilotToolContract(__dirname, 'com.transportx.citation'), null, 'legacy modules do not require new optional metadata');
  // Deliberate conformance capture imports only explicitly selected built
  // packages. Host discovery itself continues to read static metadata only.
  for (const directory of ['citation', 'spatial-analysis']) {
    const packageRoot = path.resolve(__dirname, '../../dist/tool-modules', directory);
    const contract = JSON.parse(fs.readFileSync(path.join(packageRoot, 'tool-contract.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'manifest.json'), 'utf8'));
    const { canonicalToolSchema } = require('../../bin/contracts/tool-interface.js');
    const registered: any[] = [];
    const extension = await import(require('node:url').pathToFileURL(path.join(packageRoot, manifest.entrypoints.piExtensions[0])).href);
    extension.default({ registerTool: (tool: any) => registered.push(tool), on: () => {} });
    assert.equal(registered.length, directory === 'spatial-analysis' ? 2 : 1);
    const primary = registered.find((tool: any) => tool.name === contract.piName);
    assert.ok(primary);
    assert.equal(canonicalToolSchema(primary.parameters), canonicalToolSchema(contract.input));
    if (directory === 'spatial-analysis') {
      const execution = JSON.parse(fs.readFileSync(path.join(packageRoot, 'execution-contract.json'), 'utf8'));
      assert.equal(canonicalToolSchema(registered.find((tool: any) => tool.name === execution.piName).parameters), canonicalToolSchema(execution.input));
    }
  }

  // Persisted observations never attest to a newly launched Pi process.
  {
    const tracker = new SessionCapabilityTracker('0.80.10');
    const entry = { id: 'sample', type: 'custom', customType: 'pi-web-bridge', data: fixture.valid };
    tracker.applyLatest([entry]);
    assert.equal(tracker.observation().live, false);
    tracker.applyPayload({ ...fixture.valid, revision: fixture.valid.revision + 1 }, 'fresh');
    assert.equal(tracker.observation().live, true);
    tracker.applyLatest([entry]);
    assert.equal(tracker.observation().live, false, 'switching to a branch without the live entry invalidates its sample');
  }

  {
    const { canonicalToolSchema } = require('../../bin/contracts/tool-interface.js');
    const { diagnoseTool } = require('../../bin/tool-diagnostics.js');
    const contract = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../modules/capabilities/citation/tool-contract.json'), 'utf8'));
    assert.equal(canonicalToolSchema({ type: 'object', description: 'one', properties: { description: { type: 'string' }, title: { const: { description: 'data' } } } }), canonicalToolSchema({ properties: { title: { const: { description: 'data' } }, description: { type: 'string', title: 'annotation' } }, type: 'object' }));
    assert.notEqual(canonicalToolSchema({ properties: { description: { type: 'string' } } }), canonicalToolSchema({ properties: {} }));
    const entryPath = path.resolve(__dirname, '../../modules/capabilities/citation/extensions/pi-citation/index.ts');
    const selected = { entrypoints: [{ kind: 'extension', path: entryPath }] };
    const tool = { name: contract.piName, active: true, sourceInfo: { path: entryPath }, parameters: contract.input };
    const observation = { live: true, envelope: { tools: [tool], revision: 2 } };
    const diagnose = (sample: any = observation, module: any = selected) => diagnoseTool(contract, module, sample, [], 'session');
    assert.equal(diagnoseTool(contract, selected, observation, []).reason, 'no_session');
    assert.equal(diagnose({ ...observation, live: false }).state, 'unverified');
    assert.equal(diagnoseTool(contract, undefined, observation, [], 'session').reason, 'not_selected');
    assert.equal(diagnose({ ...observation, envelope: { tools: [] } }).reason, 'missing_tool');
    assert.equal(diagnose({ ...observation, envelope: { tools: [{ ...tool, active: false }] } }).reason, 'inactive');
    assert.equal(diagnose({ ...observation, envelope: { tools: [{ ...tool, sourceInfo: {} }] } }).reason, 'source_unverified');
    assert.equal(diagnose({ ...observation, envelope: { tools: [{ ...tool, sourceInfo: { path: __filename } }] } }).reason, 'name_conflict');
    assert.equal(diagnose({ ...observation, envelope: { tools: [{ ...tool, parameters: { type: 'object' } }] } }).reason, 'schema_drift');
    assert.equal(diagnose().reason, 'host_not_verified');
    assert.equal(diagnoseTool(contract, selected, observation, [], 'session', { ...contract, semanticVersion: 'changed' }).reason, 'host_contract_drift');
    assert.equal(diagnoseTool(contract, selected, observation, [], 'session', { ...contract, contractVersion: '2.0.0' }).state, 'unavailable');
  }

  // Capability tracker keeps prior capabilities when Bridge revision regresses
  {
    const tracker = new SessionCapabilityTracker('0.80.10');
    tracker.applyPayload(fixture.valid);
    const update = tracker.applyPayload({ ...fixture.valid, revision: fixture.staleRevision });
    assert.equal(update.kind, 'rejected');
    assert.equal(tracker.snapshot().ok, true);
    assert.equal(tracker.snapshot().bridgeVersion, 1);
  }

  // Capability tracker records invalid Bridge diagnostics and resets when no Bridge entry exists
  {
    const tracker = new SessionCapabilityTracker('0.80.10');
    const invalid = tracker.applyPayload(fixture.invalidCapabilityVersion);
    assert.equal(invalid.kind, 'invalid');
    assert.equal(tracker.snapshot().ok, false);
    assert.ok(tracker.snapshot().diagnostics.length > 0);
    assert.equal(tracker.applyLatest([]).kind, 'missing');
    assert.equal(tracker.snapshot().ok, true);
  }
});
