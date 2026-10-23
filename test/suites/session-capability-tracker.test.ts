const { test } = require('node:test') as typeof import('node:test');

test('Bridge capabilities refuse regressed revisions and diagnose incompatible envelopes', async () => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const { SessionCapabilityTracker } = require('../../bin/session-capability-tracker.js');
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'contracts', 'bridge.json'), 'utf8'));
  assert.equal(require('../../bin/tool-contracts.js').readToolContract(__dirname, 'com.transportx.citation'), null, 'legacy modules do not require new optional metadata');
  // Deliberate conformance capture imports only explicitly selected built
  // packages. Host discovery itself continues to read static metadata only.
  const { CORE_TOOL_BINDINGS, canonicalToolSchema } = require('../../bin/contracts/tool-interface.js');
  for (const [moduleId, bindings] of Object.entries(CORE_TOOL_BINDINGS) as Array<[string, any[]]>) {
    const directory = moduleId.slice('com.transportx.'.length);
    const packageRoot = path.resolve(__dirname, '../../dist/tool-modules', directory);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'manifest.json'), 'utf8'));
    const registered: any[] = [];
    const extension = await import(require('node:url').pathToFileURL(path.join(packageRoot, manifest.entrypoints.piExtensions[0])).href);
    const previousModules = process.env.TRANSPORTX_SESSION_MODULES_JSON;
    try {
      process.env.TRANSPORTX_SESSION_MODULES_JSON = '[]';
      extension.default({ registerTool: (tool: any) => registered.push(tool), on: () => {} });
    } finally {
      if (previousModules === undefined) delete process.env.TRANSPORTX_SESSION_MODULES_JSON;
      else process.env.TRANSPORTX_SESSION_MODULES_JSON = previousModules;
    }
    assert.equal(registered.length, bindings.length);
    for (const binding of bindings) {
      const contract = JSON.parse(fs.readFileSync(path.join(packageRoot, binding.file), 'utf8'));
      const tool = registered.find((tool: any) => tool.name === binding.piName);
      assert.ok(tool, `${moduleId}:${binding.piName} is registered`);
      assert.equal(canonicalToolSchema(tool.parameters), canonicalToolSchema(contract.input));
    }
  }

  // Persisted observations never attest to a newly launched Pi process.
  {
    const managerRoot = path.resolve(__dirname, '../../dist/tool-modules/tool-activation');
    const managerPath = path.join(managerRoot, 'extensions/pi-tool-activation/index.ts');
    const extension = await import(require('node:url').pathToFileURL(managerPath).href);
    const toolContract = JSON.parse(fs.readFileSync(path.join(managerRoot, 'tool-contract.json'), 'utf8'));
    const module = (id: string, extensions: string[], contractFiles: string[] = []) => ({ id, version: '1.0.0', name: id, description: '', searchText: '', skills: [], extensions, contractFiles });
    const definitions = [module('com.transportx.tool-activation', [managerPath], [path.join(managerRoot, 'tool-contract.json')]), module('local.fixture', [__filename])];
    definitions.push(module('local.ambiguous-a', [path.join(managerRoot, 'manifest.json')]), module('local.ambiguous-b', [path.join(managerRoot, 'manifest.json')]), module('com.transportx.citation', [], [path.resolve(__dirname, '../../modules/capabilities/citation/tool-contract.json')]));
    const hooks: Record<string, Function> = {};
    let manager: any, failRecord = false;
    const entries: any[] = [];
    let tools: any[] = ['read', 'write', 'edit', 'bash'].map((name) => ({ name, parameters: {}, sourceInfo: { path: `<builtin:${name}>`, source: 'builtin' } }));
    tools.push({ name: 'manage_capabilities', parameters: toolContract.input, sourceInfo: { path: managerPath } }, { name: 'fixture_tool', parameters: {}, description: 'Fixture', sourceInfo: { path: __filename } });
    let active: string[] = [];
    const previousModules = process.env.TRANSPORTX_SESSION_MODULES_JSON;
    try {
      process.env.TRANSPORTX_SESSION_MODULES_JSON = JSON.stringify(definitions);
      extension.default({
        registerTool: (tool: any) => { manager = tool; }, on: (name: string, hook: Function) => { hooks[name] = hook; },
        getAllTools: () => tools, getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names.filter((name) => tools.some((tool) => tool.name === name)); },
        appendEntry: (customType: string, data: any) => { if (failRecord) throw new Error('fixture disk failure'); entries.push({ type: 'custom', customType, data }); }, events: { emit: () => {} },
      });
    } finally {
      if (previousModules === undefined) delete process.env.TRANSPORTX_SESSION_MODULES_JSON;
      else process.env.TRANSPORTX_SESSION_MODULES_JSON = previousModules;
    }
    const ctx = { sessionManager: { getBranch: () => entries } };
    const call = async (input: any) => (await manager.execute('call', input, undefined, undefined, ctx)).details;
    hooks.session_start({}, ctx);
    assert.equal(active.length, 5);
    for (const action of ['discover', 'inspect', 'status']) {
      await call({ action, ...(action === 'discover' ? {} : { moduleId: 'local.fixture' }) });
      assert.equal(active.length, 5); assert.equal(entries.length, 1);
    }
    await assert.rejects(call({ action: 'enable', moduleId: 'local.fixture', query: 'unrelated' }), /Invalid fields/);
    assert.equal((await call({ action: 'enable', moduleId: 'local.absent' })).status, 'not_in_session_plan');
    assert.ok((await call({ action: 'enable', moduleId: 'local.ambiguous-a' })).reasons.includes('ambiguous_source'));
    assert.ok((await call({ action: 'enable', moduleId: 'com.transportx.citation' })).reasons.includes('missing_tool:tau_resolve_citation'));
    failRecord = true;
    assert.equal((await call({ action: 'enable', moduleId: 'local.fixture' })).status, 'active_but_record_failed');
    assert.ok(active.includes('fixture_tool')); assert.equal(entries.length, 1);
    failRecord = false;
    await Promise.all([call({ action: 'enable', moduleId: 'local.fixture' }), call({ action: 'enable', moduleId: 'com.transportx.tool-activation' })]);
    assert.equal(entries.filter((entry) => entry.data.kind === 'enable' && entry.data.moduleId === 'local.fixture').length, 1);
    tools.push({ name: 'late_tool', parameters: {}, sourceInfo: { path: __filename } });
    assert.ok((await call({ action: 'enable', moduleId: 'local.fixture' })).reasons.includes('registration_changed_requires_new_session'));
    hooks.session_start({ reason: 'reload' }, ctx);
    assert.equal(active.includes('fixture_tool'), false, 'member drift refuses the whole module on reload');
    assert.equal(active.includes('late_tool'), false);
    tools = tools.filter((tool) => tool.name !== 'late_tool');
    tools.find((tool) => tool.name === 'fixture_tool').sourceInfo.path = managerPath;
    assert.ok((await call({ action: 'enable', moduleId: 'local.fixture' })).reasons.includes('registration_changed_requires_new_session'));
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
    assert.equal(diagnose({ ...observation, envelope: { tools: [{ ...tool, active: false }] } }).state, 'unverified');
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
