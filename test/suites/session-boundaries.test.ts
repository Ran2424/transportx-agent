const { test } = require('node:test') as typeof import('node:test');

test('Session close, history deletion and process cancellation preserve writer ownership', async (t) => {
  // Kernel identities survive process.title changes; stale PID identities never authorize a stop.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { spawn } = require('node:child_process');
    const { inspectProcess, inspectRecordedProcess, stopRecordedProcess } = require('../../bin/process-inspection.js');
    const { WorkspaceRuntimeGate, managedRuntimeProcess } = require('../../bin/workspace-runtime.js');
    const python = process.env.TAU_PYTHON_COMMAND || 'python3';
    const original = inspectProcess(process.pid, python); assert.equal(original.state, 'running', JSON.stringify(original));
    const title = process.title;
    try { process.title = 'transportx-process-title-test'; assert.deepEqual(inspectProcess(process.pid, python).identity, original.identity); }
    finally { process.title = title; }
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const observed = inspectProcess(child.pid, python); assert.equal(observed.state, 'running', JSON.stringify(observed));
    const reused = { ...observed.identity, startedAt: 'different-kernel-start' };
    assert.equal(inspectRecordedProcess(reused, python).state, 'replaced');
    await stopRecordedProcess(reused, python); assert.equal(child.exitCode, null, 'a recycled PID does not authorize termination');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tau-runtime-lease-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const gate = new WorkspaceRuntimeGate(python, path.join(root, 'logs'));
    const workspaceId = 'ws_00000000-0000-4000-8000-000000000001', conversationId = 'conv_00000000-0000-4000-8000-000000000002';
    const lease = gate.take(root, workspaceId, conversationId);
    const tracked = managedRuntimeProcess(root); tracked.started(child); lease.running();
    assert.throws(() => new WorkspaceRuntimeGate(python, root).take(root, workspaceId, conversationId), { code: 'workspace_busy' });
    assert.throws(() => lease.finish(), { code: 'process_stop_unconfirmed' });
    const diagnostic = gate.diagnostics(root);
    assert.equal(diagnostic.processes[0].observation.state, 'running');
    assert.equal(JSON.stringify(diagnostic).includes('token'), false);
    await stopRecordedProcess(observed.identity, python); tracked.stopped(); lease.stopping(); lease.finish();
    assert.equal(gate.diagnostics(root).phase, 'stopped');
    const next = gate.take(root, workspaceId, 'conv_00000000-0000-4000-8000-000000000003');
    assert.notEqual(next.generation, lease.generation);
    const { ProcessRunner } = require('../../bin/process-runner.js');
    const output = await new ProcessRunner().run({ command: process.execPath, args: [] }, ['-e', "setTimeout(()=>console.log('tracked-native'),150)"], { cwd: root, timeoutMs: 2000, maxBuffer: 1024 });
    assert.match(output.stdout, /tracked-native/);
    assert.equal(gate.diagnostics(root).processes[0].kind, 'managed');
    assert.equal(gate.diagnostics(root).processes[0].state, 'stopped', 'domain subprocess completion commits its runtime stop before returning');
    next.finish();
  }
  // New tasks and existing workspaces share a durable creation commit, including response-loss recovery.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { WorkspaceStore } = require('../../bin/workspace-store.js');
    const { WorkspaceService } = require('../../bin/workspace-service.js');
    const { defaultSessionProfile } = require('../../bin/contracts/session-profile.js');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-workspace-create-'));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const root = fs.realpathSync(temporary), parent = path.join(root, 'scenario'); fs.mkdirSync(parent);
    const store = new WorkspaceStore(root, path.join(root, 'sessions'));
    await store.initializeCatalog({ schemaVersion: 1, revision: 0, entries: [] });
    let validations = 0;
    const options = {
      store, defaultParentDirectory: parent, expandHome: (value: string) => value, assertReady: () => {}, assertAllocationAllowed: () => {},
      validateModel: async (model: string) => { validations++; if (model === 'missing') throw new Error('model missing'); },
      assemble: (configuration: any, directory: string) => {
        if (configuration.profile.modules.selected.some((module: any) => module.id === 'missing')) throw new Error('module missing');
        return { schemaVersion: 3, platform: { name: 'TransportX Agent', version: '3.23.2' }, profile: configuration.profile, domain: { id: configuration.domainId, version: '1.0.0' }, modules: [], assets: [], runtime: {}, workspace: directory, createdAt: new Date().toISOString() };
      },
    };
    const service = new WorkspaceService(options), profile = defaultSessionProfile();
    const input = { requestId: 'first', workspace: { kind: 'new', name: '共享交通资料' }, name: '首次分析', model: 'probe/first', domainId: 'com.transportx.workbench', profile };
    assert.deepEqual(fs.readdirSync(parent), [], 'opening/cancelling a form has no storage effect');
    await assert.rejects(service.create({ ...input, model: 'missing' }), /model missing/);
    await assert.rejects(service.create({ ...input, profile: defaultSessionProfile([{ id: 'missing', version: '1.0.0' }]) }), /module missing/);
    assert.deepEqual(fs.readdirSync(parent), []); assert.equal(store.readCatalog().entries.length, 0);
    const first = await service.create(input);
    assert.equal(first.conversation.state, 'created');
    assert.equal(first.manifest.defaults.profile.modules.selectionMode, 'explicit');
    assert.equal(fs.existsSync(path.join(store.sessionsDirectory, first.conversation.history.key)), false);
    assert.equal(fs.statSync(path.join(store.sessionsDirectory, 'transportx')).isDirectory(), true);
    assert.equal(first.conversation.plan.path, `conversations/${first.conversation.id}/plan.json`);
    fs.writeFileSync(path.join(first.directory, 'shared.csv'), 'road,count\nA,42\n');
    const validationCount = validations;
    await store.editWorkspace(first.manifest.id, first.manifest.revision, (manifest: any) => { manifest.name = '改过的展示名'; manifest.conversations[0].name = '改过的标题'; });
    const restarted = new WorkspaceService(options), retry = await restarted.create(input);
    assert.equal(retry.conversation.id, first.conversation.id); assert.equal(validations, validationCount, 'committed retries do not re-resolve mutable configuration');
    assert.equal(retry.manifest.name, '改过的展示名'); assert.equal(fs.readdirSync(parent).length, 1);
    await assert.rejects(service.create({ ...input, name: 'different input' }), { code: 'workspace_revision_conflict' });
    const next = { requestId: 'second', workspace: { kind: 'existing', workspaceId: first.manifest.id, expectedRevision: retry.manifest.revision, defaultsRevision: retry.manifest.defaultsRevision }, name: '独立分析', model: 'probe/second' };
    const [second, duplicate] = await Promise.all([service.create(next), service.create(next)]);
    assert.equal(second.conversation.id, duplicate.conversation.id); assert.equal(second.directory, first.directory);
    assert.notEqual(second.conversation.history.key, first.conversation.history.key);
    assert.equal(second.conversation.privateState, 'isolated'); assert.equal(second.manifest.conversations.length, 2);
    assert.equal(second.manifest.defaults.modelSpec, 'probe/first', 'overrides do not edit workspace defaults');
    assert.equal(store.readPlan(first.directory, first.conversation).profile.modules.selectionMode, 'explicit');
    assert.equal(fs.readFileSync(path.join(first.directory, 'shared.csv'), 'utf8'), 'road,count\nA,42\n');
    await assert.rejects(service.create({ ...next, requestId: 'stale-management' }), { code: 'workspace_revision_conflict' });
    await store.updateDefaults(first.manifest.id, 0, { ...first.manifest.defaults, modelSpec: 'probe/new-default' });
    await assert.rejects(service.create({ ...next, requestId: 'stale-defaults', workspace: { ...next.workspace, expectedRevision: second.manifest.revision } }), { code: 'workspace_revision_conflict' });
    const third = await service.create({ requestId: 'third', workspace: { ...next.workspace, expectedRevision: second.manifest.revision, defaultsRevision: 1 }, name: '使用新默认' });
    assert.equal(third.conversation.modelSpec, 'probe/new-default');
    assert.equal(store.readWorkspace(first.manifest.id).manifest.conversations[0].modelSpec, 'probe/first');

    // Persistent lifecycle uses real Pi RPC, isolated configuration and no model/network requests.
    const { ConversationRuntime } = require('../../bin/conversation-runtime.js');
    const { WorkspaceRuntimeGate } = require('../../bin/workspace-runtime.js');
    const { LiveSessionManager } = require('../../bin/sessions.js');
    const { spawn } = require('node:child_process');
    let launchMode = 'ok', launches = 0, releaseLaunch: (() => void) | undefined, rejectPlan = false;
    const assembler = { assemble: () => { throw new Error('Frozen plans must not be reassembled.'); }, save: () => {}, load: () => {} };
    const manager = new LiveSessionManager({ defaultDomainId: 'com.transportx.workbench', assembler, assemblerForProfile: () => assembler, createWorkspace: () => { throw new Error('Activation must not allocate another workspace.'); }, command: process.execPath,
      spawn: (...args: any[]) => { launches++; return spawn(...args); }, endpoints: {},
      launch: async (value: any) => {
        if (launchMode === 'refuse') throw Object.assign(new Error('Module trust was declined.'), { code: 'module_trust_declined' });
        if (launchMode === 'hold') await new Promise<void>((resolve) => { releaseLaunch = resolve; });
        if (launchMode === 'no-handshake' || launchMode === 'exits-during-handshake') return { args: ['-e', `process.stdin.resume(); ${launchMode === 'exits-during-handshake' ? "process.stdin.once('data',()=>process.exit(7));" : ''} setInterval(()=>{},1000);`], env: { ...process.env } };
        return { args: [path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '--mode', 'rpc', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--session', value.sessionFile], env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, 'isolated-pi') } };
      },
    });
    const gate = new WorkspaceRuntimeGate(process.env.TAU_PYTHON_COMMAND || 'python3', path.join(root, 'logs'));
    const lifecycle = new ConversationRuntime({ store, sessions: manager, gate, assertReady: () => {}, verifyPlan: (plan: any) => { if (rejectPlan) throw Object.assign(new Error('Frozen module version unavailable.'), { code: 'module_version_missing' }); return plan; } });
    const beforeActivity = store.readWorkspace(first.manifest.id).manifest;
    try {
      assert.equal(lifecycle.snapshot(first.conversation.id).runtime, null);
      assert.deepEqual(lifecycle.snapshot(first.conversation.id).snapshot.entries, []);
      const opening = lifecycle.activate(first.conversation.id);
      assert.equal(lifecycle.activate(first.conversation.id), opening, 'simultaneous activation joins the existing start');
      const liveA = await opening;
      assert.equal(launches, 1); assert.equal(liveA.conversationId, first.conversation.id);
      assert.equal(fs.existsSync(liveA.sessionFile), false, 'a real empty Pi keeps its reserved JSONL absent');
      assert.equal(liveA.metadata().sessionFile, null, 'the reserved path is not advertised as a persisted file');
      assert.equal(liveA.metadata().workspaceId, first.manifest.id);
      assert.equal(liveA.sessionName, '改过的标题');
      assert.equal(lifecycle.snapshot(second.conversation.id).runtime, null, 'browsing B does not activate it or close A');
      assert.equal(manager.get(liveA.id), liveA);
      liveA.isCompacting = true;
      await assert.rejects(lifecycle.activate(second.conversation.id), { code: 'workspace_busy' });
      await assert.rejects(lifecycle.close(first.conversation.id), { code: 'workspace_busy' });
      liveA.isCompacting = false;
      rejectPlan = true;
      await assert.rejects(lifecycle.activate(second.conversation.id, true), { code: 'module_version_missing' });
      assert.equal(manager.get(liveA.id), liveA, 'an invalid target never stops the current conversation');
      rejectPlan = false;
      const liveB = await lifecycle.activate(second.conversation.id);
      assert.equal(liveB.cwd, liveA.cwd); assert.notEqual(liveB.id, liveA.id); assert.equal(manager.get(liveA.id), undefined);
      assert.equal(gate.diagnostics(first.directory).processes.filter((item: any) => item.state === 'running').length, 1);
      await lifecycle.close(second.conversation.id); await lifecycle.close(second.conversation.id);
      assert.equal(gate.diagnostics(first.directory).phase, 'stopped');
      launchMode = 'refuse';
      await assert.rejects(lifecycle.activate(third.conversation.id), { code: 'module_trust_declined' });
      assert.equal(store.findConversation(third.conversation.id).conversation.state, 'start-failed');
      assert.equal(gate.diagnostics(first.directory).phase, 'stopped');
      launchMode = 'hold';
      const pending = lifecycle.activate(third.conversation.id), rejected = assert.rejects(pending, { code: 'activation_cancelled' });
      const deadline = Date.now() + 2000;
      while (!releaseLaunch) { assert.ok(Date.now() < deadline, 'activation reaches its pending trust decision'); await new Promise((resolve) => setImmediate(resolve)); }
      await lifecycle.close(third.conversation.id, true); await rejected;
      releaseLaunch!(); await new Promise((resolve) => setImmediate(resolve));
      assert.equal(launches, 2, 'a late trust decision after close cannot launch Pi');
      launchMode = 'no-handshake';
      const handshake = lifecycle.activate(third.conversation.id), cancelledHandshake = assert.rejects(handshake, { code: 'activation_cancelled' });
      const handshakeDeadline = Date.now() + 3000;
      while (![...manager.sessions.values()].some((session: any) => session.conversationId === third.conversation.id && session.transport.pendingCount)) { assert.ok(Date.now() < handshakeDeadline, 'runtime reaches the pending RPC handshake'); await new Promise((resolve) => setTimeout(resolve, 10)); }
      await lifecycle.close(third.conversation.id, true); await cancelledHandshake;
      assert.equal(gate.diagnostics(first.directory).phase, 'stopped');
      launchMode = 'exits-during-handshake';
      await assert.rejects(lifecycle.activate(third.conversation.id), /exited|stopped/);
      assert.equal(store.findConversation(third.conversation.id).conversation.state, 'start-failed');
      assert.equal(gate.diagnostics(first.directory).phase, 'stopped', 'an exit during the handshake releases only its own generation');
      launchMode = 'ok';
      const invalidRefs = path.join(first.directory, '.tau/conversations', third.conversation.id, 'attachment-message-refs.json');
      fs.writeFileSync(invalidRefs, 'null');
      await assert.rejects(lifecycle.activate(third.conversation.id), { code: 'metadata_corrupt' });
      assert.equal(fs.readFileSync(invalidRefs, 'utf8'), 'null');
      assert.equal(gate.diagnostics(first.directory).phase, 'stopped', 'a private-state constructor failure starts no Pi and retains the record');
      fs.rmSync(invalidRefs);
      const restored = await lifecycle.activate(first.conversation.id);
      assert.notEqual(restored.id, liveA.id); assert.equal(restored.conversationId, liveA.conversationId);
      const launchesBeforeClose = launches;
      const cancellations = manager.cancelJobs.bind(manager);
      manager.cancelJobs = async () => { throw new Error('Stop confirmation unavailable.'); };
      await assert.rejects(lifecycle.close(first.conversation.id, true), { code: 'process_stop_unconfirmed' });
      assert.equal(gate.diagnostics(first.directory).phase, 'stop-unconfirmed');
      await assert.rejects(lifecycle.activate(second.conversation.id), { code: 'process_stop_unconfirmed' });
      assert.equal(launches, launchesBeforeClose, 'an unconfirmed stop keeps the workspace unavailable to the next Pi');
      manager.cancelJobs = cancellations;
      await lifecycle.close(first.conversation.id);
      const saved = fs.readFileSync(path.join(first.directory, '.tau/workspace.json'), 'utf8');
      restored.handleStdout(JSON.stringify({ type: 'agent_settled' }) + '\n');
      assert.equal(fs.readFileSync(path.join(first.directory, '.tau/workspace.json'), 'utf8'), saved, 'an old runtime tail cannot mutate the new logical record');
      const afterActivity = store.readWorkspace(first.manifest.id).manifest;
      assert.equal(afterActivity.revision, beforeActivity.revision); assert.equal(afterActivity.updatedAt, beforeActivity.updatedAt);
      assert.equal(afterActivity.defaultsRevision, beforeActivity.defaultsRevision);
    } finally { releaseLaunch?.(); await lifecycle.shutdown(); }

    // Manifest commits before catalog publication. A failed catalog write must recover the same logical conversation.
    const rename = fs.renameSync;
    let failPublication = true;
    fs.renameSync = (source: string, target: string) => {
      if (failPublication && target === store.catalogFile && fs.existsSync(source)) {
        const catalog = JSON.parse(fs.readFileSync(source, 'utf8'));
        if (catalog.entries.some((entry: any) => entry.creationRequestId === 'response-loss' && entry.state === 'ready')) throw Object.assign(new Error('full catalog volume'), { code: 'ENOSPC' });
      }
      return rename(source, target);
    };
    const lostInput = { ...input, requestId: 'response-loss', workspace: { kind: 'new', name: '响应丢失' } };
    try { await assert.rejects(service.create(lostInput), { code: 'ENOSPC' }); }
    finally { failPublication = false; fs.renameSync = rename; }
    const reservation = store.readCatalog().entries.find((entry: any) => entry.creationRequestId === 'response-loss');
    assert.equal(reservation.state, 'creating');
    const committed = JSON.parse(fs.readFileSync(path.join(reservation.path, '.tau/workspace.json'), 'utf8'));
    const restored = await restarted.create(lostInput);
    assert.equal(restored.conversation.id, committed.conversations[0].id);
    assert.equal(store.readCatalog().entries.length, 2); assert.equal(fs.readdirSync(parent).length, 2);
    assert.equal(store.readCatalog().entries.find((entry: any) => entry.workspaceId === reservation.workspaceId).state, 'ready');
  }
  // Workspace RMW transactions preserve independent revisions and failed writes leave committed data intact.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { WorkspaceStore, workspaceCreationDigest } = require('../../bin/workspace-store.js');
    const { toPosixPath } = require('../../bin/util/path.js');
    const { defaultSessionProfile } = require('../../bin/contracts/session-profile.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-workspace-store-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = fs.realpathSync(root), workspaceDirectory = path.join(directory, 'workspace'); fs.mkdirSync(workspaceDirectory);
    const store = new WorkspaceStore(directory, path.join(directory, 'sessions'));
    assert.throws(() => store.readCatalog(), { code: 'catalog_missing' });
    await store.initializeCatalog({ schemaVersion: 1, revision: 0, entries: [] });
    const id = 'ws_00000000-0000-4000-8000-000000000001', conversationId = 'conv_00000000-0000-4000-8000-000000000002';
    const at = '2026-10-25T00:00:00.000Z', profile = defaultSessionProfile();
    await store.editCatalog(0, (catalog: any) => catalog.entries.push({ workspaceId: id, path: toPosixPath(workspaceDirectory), creationRequestId: 'new-workspace', creationInputSha256: 'a'.repeat(64), state: 'creating', deletion: null }));
    const plan = { schemaVersion: 3, platform: { name: 'TransportX Agent', version: '3.23.2' }, profile, domain: { id: 'com.transportx.workbench', version: '1.4.1' }, modules: [], assets: [], runtime: {}, workspace: workspaceDirectory, createdAt: at };
    await store.savePlan(workspaceDirectory, conversationId, plan);
    const windowsPlanId = 'conv_00000000-0000-4000-8000-000000000004';
    await store.savePlan(workspaceDirectory, windowsPlanId, { ...plan, modules: [{ id: 'fixture', version: '1.0.0', type: 'module', origin: 'installed', packageRoot: 'C:\\fixture', entrypoints: [{ kind: 'skill', path: 'C:\\fixture\\SKILL.md' }], nativeRuntimes: [], canvasViews: [] }] });
    const disk = JSON.parse(fs.readFileSync(path.join(workspaceDirectory, `.tau/conversations/${windowsPlanId}/plan.json`), 'utf8'));
    assert.deepEqual([disk.modules[0].packageRoot, disk.modules[0].entrypoints[0].path], ['C:/fixture', 'C:/fixture/SKILL.md']);
    await assert.rejects(store.savePlan(workspaceDirectory, conversationId, { ...plan, createdAt: '2026-10-26T00:00:00.000Z' }), { code: 'workspace_revision_conflict' });
    const record = { id: conversationId, creationRequestId: 'new-conversation', creationInputSha256: 'b'.repeat(64), name: '首次分析', createdAt: at, updatedAt: at, defaultsRevision: 0, modelSpec: 'probe/first', appendSystemPrompt: '', state: 'created', history: { key: store.newHistoryKey(conversationId), headerId: null }, plan: { path: `conversations/${conversationId}/plan.json`, source: 'created' }, privateState: 'isolated', lastStartFailure: null, deletion: null };
    const manifest = { schemaVersion: 1, id, revision: 0, name: '工作区', createdAt: at, updatedAt: at, defaultsRevision: 0, defaults: { domainId: 'com.transportx.workbench', modelSpec: 'probe/first', profile }, citationRegistryId: id, conversations: [record] };
    await store.publishWorkspace(id, manifest);
    assert.equal(store.readCatalog().entries[0].state, 'ready');
    assert.equal(fs.existsSync(path.join(store.sessionsDirectory, record.history.key)), false, 'zero-message existence does not require a Pi file');
    await Promise.all([
      store.editWorkspace(id, 0, (value: any) => { value.name = '名称已修改'; }),
      store.updateDefaults(id, 0, { ...manifest.defaults, modelSpec: 'probe/next' }),
    ]);
    const renamed = store.readWorkspace(id).manifest;
    assert.deepEqual([renamed.revision, renamed.defaultsRevision, renamed.name, renamed.defaults.modelSpec], [1, 1, '名称已修改', 'probe/next']);
    assert.equal(store.readPlan(workspaceDirectory, renamed.conversations[0]).domain.id, plan.domain.id);
    assert.equal(renamed.conversations[0].modelSpec, 'probe/first', 'default edits do not change old conversations');
    await assert.rejects(store.editWorkspace(id, 0, () => {}), { code: 'workspace_revision_conflict' });
    await store.updateRuntime(id, conversationId, { state: 'start-failed', history: record.history, modelSpec: 'probe/first', lastStartFailure: { code: 'pi_failed', message: 'Retry explicitly.', at } });
    const recovered = new WorkspaceStore(directory, store.sessionsDirectory).readWorkspace(id).manifest;
    assert.deepEqual([recovered.revision, recovered.defaultsRevision, recovered.updatedAt], [renamed.revision, renamed.defaultsRevision, renamed.updatedAt], 'runtime updates do not create management conflicts or alter activity ordering');
    assert.equal(recovered.conversations[0].state, 'start-failed');
    const reserved = store.inspectHistory(workspaceDirectory, recovered.conversations[0]);
    assert.equal(reserved.sessionFile, null);
    fs.mkdirSync(path.dirname(reserved.file), { recursive: true });
    fs.writeFileSync(reserved.file, JSON.stringify({ type: 'session', id: 'native-pi-id', cwd: workspaceDirectory }) + '\n');
    const bound = { ...record.history, headerId: 'native-pi-id' };
    await store.updateRuntime(id, conversationId, { state: 'ready', history: bound, modelSpec: 'probe/first', lastStartFailure: null });
    fs.rmSync(reserved.file);
    await assert.rejects(store.updateRuntime(id, conversationId, { state: 'created', history: record.history, modelSpec: 'probe/first', lastStartFailure: null }), { code: 'history_identity_mismatch' });
    assert.throws(() => store.inspectHistory(workspaceDirectory, store.readWorkspace(id).manifest.conversations[0]), { code: 'history_missing' });
    assert.equal(fs.existsSync(reserved.file), false, 'missing bound histories are never recreated by a read');
    const before = fs.readFileSync(path.join(workspaceDirectory, '.tau/workspace.json'));
    const rename = fs.renameSync;
    fs.renameSync = (source: string, target: string) => { if (target === path.join(workspaceDirectory, '.tau/workspace.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return rename(source, target); };
    try { await assert.rejects(store.editWorkspace(id, 1, (value: any) => { value.name = 'Must not commit'; }), { code: 'ENOSPC' }); }
    finally { fs.renameSync = rename; }
    assert.deepEqual(fs.readFileSync(path.join(workspaceDirectory, '.tau/workspace.json')), before);
    assert.equal(workspaceCreationDigest({ a: 1, nested: { b: 2, a: 3 } }), workspaceCreationDigest({ nested: { a: 3, b: 2 }, a: 1 }));
    await store.editWorkspace(id, 1, (value: any) => { value.conversations[0].state = 'deleted'; value.conversations[0].deletion = { requestId: 'deleted-conversation', invocationOwnerKey: null, stage: 'history-cleaned' }; });
    await assert.rejects(store.editWorkspace(id, 2, (value: any) => { value.conversations = []; }), { code: 'workspace_identity_conflict' });
    const metadata = path.join(workspaceDirectory, '.tau'), held = path.join(workspaceDirectory, '.tau-held');
    fs.renameSync(metadata, held);
    let linked = false;
    try { fs.symlinkSync(held, metadata, 'dir'); linked = true; }
    catch (error) { t.diagnostic(`Symlink assertion unavailable: ${(error as Error).message}`); }
    try { if (linked) assert.throws(() => store.readWorkspace(id), { code: 'workspace_identity_conflict' }); }
    finally { if (linked) fs.unlinkSync(metadata); fs.renameSync(held, metadata); }
    const revision = store.readCatalog().revision;
    await store.editCatalog(revision, (catalog: any) => { catalog.entries[0].state = 'deleted'; catalog.entries[0].deletion = { requestId: 'deleted-workspace', manifestRevision: 2, historyKeys: [record.history.key], invocationOwnerKeys: [], stage: 'workspace-cleaned' }; });
    await assert.rejects(store.editCatalog(revision + 1, (catalog: any) => { catalog.entries = []; }), { code: 'workspace_identity_conflict' });
    fs.writeFileSync(store.catalogFile, '{broken');
    assert.throws(() => store.readCatalog(), { code: 'metadata_corrupt' });
    await assert.rejects(store.initializeCatalog({ schemaVersion: 1, revision: 0, entries: [] }), { code: 'workspace_revision_conflict' });
    assert.equal(fs.readFileSync(store.catalogFile, 'utf8'), '{broken', 'corrupt catalogs are never reset to an empty catalog');
    fs.rmSync(store.catalogFile);
    await assert.rejects(store.initializeCatalog({ schemaVersion: 1, revision: 0, entries: [] }), { code: 'metadata_corrupt' });
    assert.equal(fs.existsSync(store.catalogFile), false, 'missing catalogs with surviving backups require explicit recovery');
  }
  {
    const assert = require('node:assert/strict');
    const { execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-cleanup-test-'));
    process.env.TAU_USER_DATA_DIR = userData;
    process.env.PI_CODING_AGENT_DIR = userData;
    process.env.PI_CODING_AGENT_SESSION_DIR = path.join(userData, 'sessions');
    process.env.TAU_PROJECTS_DIR = path.join(userData, 'scenario');
    fs.mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
    fs.mkdirSync(process.env.TAU_PROJECTS_DIR, { recursive: true });
    t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
    const { createSessionWorkingDirectory, makeSessionId } = require('../../bin/session-workspace.js');

    // history delete holds a file gate while waiting for an existing resume and Writer
    {
      const { LiveSessionManager } = require('../../bin/sessions.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-history-delete-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const file = path.join(root, 'history.jsonl');
      fs.writeFileSync(file, '{"type":"session"}\n');
      const manager = new LiveSessionManager();
      let resume!: (session: unknown) => void;
      let stop!: () => void;
      manager.pendingResumes.set(file, new Promise((resolve) => { resume = resolve; }));
      const deletion = manager.deleteHistory(file, false);
      deletion.catch(() => { });
      await assert.rejects(manager.resume({ sessionFile: file, cwd: root }), /delet/i);
      assert.ok(fs.existsSync(file));
      const session = { id: 'writer', sessionFile: file, terminate: () => new Promise<void>((resolve) => { stop = resolve; }) };
      manager.sessions.set(session.id, session);
      resume(session);
      await new Promise((resolve) => setImmediate(resolve));
      assert.ok(fs.existsSync(file));
      stop();
      await deletion;
      assert.equal(fs.existsSync(file), false);
    }

    // creates unique, safe task directories under an explicit project root
    {
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
    }

    // uses the configured cross-platform scenario directory when no project root is supplied
    {
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-default-workspace-'));
      t.after(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
      const created = execFileSync(process.execPath, ['-e', [
        "const { createSessionWorkingDirectory } = require('./bin/session-workspace.js');",
        "process.stdout.write(createSessionWorkingDirectory(undefined, 'default-root'));",
      ].join('')], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          TAU_USER_DATA_DIR: userDataDir,
          TAU_PROJECTS_DIR: '',
          PI_CODING_AGENT_DIR: path.join(userDataDir, 'pi'),
        },
      });
      assert.equal(path.dirname(created), path.join(userDataDir, 'scenario'));
    }

    // real Writer exit precedes history removal, and stop failures preserve history
    {
      const { spawn } = require('node:child_process');
      const { terminateProcessTree } = require('../../bin/process-tree.js');
      const { LiveSessionManager } = require('../../bin/sessions.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-writer-exit-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const file = path.join(root, 'history.jsonl');
      const child = spawn(process.execPath, ['-e', `const fs=require('fs');fs.writeFileSync(process.argv[1],'ready\\n');process.on('SIGTERM',()=>setTimeout(()=>{fs.appendFileSync(process.argv[1],'final\\n');process.exit(0)},100));setInterval(()=>{},1000);process.stdout.write('ready');`, file], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      t.after(() => { try { child.kill('SIGKILL'); } catch { } });
      await new Promise((resolve) => child.stdout.once('data', resolve));
      const manager = new LiveSessionManager();
      manager.sessions.set('writer', { id: 'writer', sessionFile: file, terminate: () => terminateProcessTree(child) });
      await manager.deleteHistory(file, false);
      assert.notEqual(child.exitCode, null);
      assert.equal(fs.existsSync(file), false);
      fs.writeFileSync(file, 'keep');
      manager.sessions.set('failed', { id: 'failed', sessionFile: file, terminate: async () => { throw new Error('stop failed'); } });
      await assert.rejects(manager.deleteHistory(file, false), /stop failed/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
    }

    // Node cleanup handles reserved names, shared directories, failures and retry without a shell.
    {
      const { LiveSessionManager } = require('../../bin/sessions.js');
      const { testSymlink } = require('../support/symlink.ts');
      const root = process.env.TAU_PROJECTS_DIR;
      const file = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, 'cleanup.jsonl');
      const history = (cwd: string, target = file) => fs.writeFileSync(target, JSON.stringify({ type: 'session', cwd }) + '\n');
      const manager = new LiveSessionManager();
      let cwd = createSessionWorkingDirectory(root, '保留名 cleanup');
      fs.mkdirSync(path.join(cwd, 'nested'));
      for (const name of ['nul', 'NUL.txt', 'con', 'aux', 'prn', 'COM1', 'LPT9']) fs.writeFileSync(path.toNamespacedPath(path.join(cwd, 'nested', name)), 'error output');
      history(cwd);
      await manager.deleteHistory(file);
      assert.equal(fs.existsSync(cwd), false);
      assert.equal(fs.existsSync(file), false);

      cwd = createSessionWorkingDirectory(root, 'shared');
      history(cwd);
      const other = path.join(process.env.PI_CODING_AGENT_SESSION_DIR, 'other.jsonl');
      history(cwd, other);
      await assert.rejects(manager.deleteHistory(file), /another session/);
      assert.ok(fs.existsSync(file) && fs.existsSync(cwd));
      await manager.deleteHistory(file, false);
      assert.ok(fs.existsSync(cwd));
      await manager.deleteHistory(other);
      assert.equal(fs.existsSync(cwd), false);

      cwd = createSessionWorkingDirectory(root, 'retry');
      history(cwd);
      const originalRm = fs.promises.rm;
      fs.promises.rm = async (target: string, options: unknown) => {
        if (target === path.toNamespacedPath(cwd)) {
          await originalRm(path.join(cwd, '.tau'), { recursive: true, force: true });
          throw Object.assign(new Error('access denied'), { code: 'EACCES', path: path.join(cwd, 'locked.csv') });
        }
        return originalRm(target, options);
      };
      try { await assert.rejects(manager.deleteHistory(file), (error: any) => error.code === 'EACCES' && /locked.csv/.test(error.message)); }
      finally { fs.promises.rm = originalRm; }
      assert.ok(fs.existsSync(file) && fs.existsSync(cwd));
      assert.ok(fs.existsSync(path.join(cwd, '.tau', 'workspace-owner.json')), 'partial cleanup preserves ownership for a later retry');
      await manager.deleteHistory(file);
      assert.equal(fs.existsSync(cwd), false);

      cwd = createSessionWorkingDirectory(root, 'gate');
      history(cwd);
      let release!: () => void;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      fs.promises.rm = async (target: string, options: unknown) => {
        if (target === path.toNamespacedPath(cwd)) { started(); await new Promise<void>((resolve) => { release = resolve; }); }
        return originalRm(target, options);
      };
      const deleting = manager.deleteHistory(file);
      try {
        await entered;
        await assert.rejects(manager.resume({ sessionFile: other, cwd }), /directory is being deleted/);
        release();
        await deleting;
      } finally { fs.promises.rm = originalRm; release?.(); await deleting; }

      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-cleanup-outside-'));
      t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
      const keep = path.join(outside, 'keep.txt');
      fs.writeFileSync(keep, 'keep');
      history(outside);
      await assert.rejects(manager.deleteHistory(file), /ownership/);
      await manager.deleteHistory(file, false);
      assert.equal(fs.readFileSync(keep, 'utf8'), 'keep');

      cwd = createSessionWorkingDirectory(root, 'links');
      history(cwd);
      const link = path.join(root, '20261014-120000-link');
      await testSymlink(t, 'cleanup root symlink', outside, link, async () => {
        history(link);
        await assert.rejects(manager.deleteHistory(file), /ownership/);
        assert.ok(fs.existsSync(file));
      }, 'dir');
      history(cwd);
      await testSymlink(t, 'cleanup child symlink', outside, path.join(cwd, 'external'), async () => {
        await manager.deleteHistory(file);
        assert.equal(fs.readFileSync(keep, 'utf8'), 'keep');
      }, 'dir');

      cwd = createSessionWorkingDirectory(root, 'legacy');
      fs.unlinkSync(path.join(cwd, '.tau', 'workspace-owner.json'));
      fs.writeFileSync(path.join(cwd, '.tau', 'resolved-session-plan.json'), JSON.stringify({ schemaVersion: 3, platform: { name: 'TransportX Agent' }, workspace: cwd }));
      history(cwd);
      await manager.deleteHistory(file);
      assert.equal(fs.existsSync(cwd), false);

      cwd = createSessionWorkingDirectory(root, 'missing');
      history(cwd);
      await originalRm(cwd, { recursive: true, force: true });
      await manager.deleteHistory(file);
      assert.equal(fs.existsSync(file), false);

      cwd = createSessionWorkingDirectory(root, 'no-history');
      manager.sessions.set('no-history', { id: 'no-history', cwd, sessionFile: null, terminate: async () => {} });
      await manager.deleteConversation({ sessionId: 'no-history' });
      assert.equal(fs.existsSync(cwd), false);

      cwd = createSessionWorkingDirectory(root, 'live-retry');
      history(cwd);
      const live = { id: 'live-retry', cwd, sessionFile: file, isStreaming: true, terminate: async () => {} };
      manager.sessions.set(live.id, live);
      const unrelated = createSessionWorkingDirectory(root, 'different-task');
      history(unrelated);
      await assert.rejects(manager.deleteConversation({ sessionId: live.id }), /does not match/);
      assert.ok(fs.existsSync(cwd) && fs.existsSync(unrelated) && fs.existsSync(file));
      history(cwd);
      fs.promises.rm = async (target: string, options: unknown) => {
        if (target === path.toNamespacedPath(cwd)) throw Object.assign(new Error('locked'), { code: 'EPERM' });
        return originalRm(target, options);
      };
      try { await assert.rejects(manager.deleteConversation({ sessionId: live.id }), /EPERM/); }
      finally { fs.promises.rm = originalRm; }
      assert.equal(manager.get(live.id), live, 'a failed cleanup retains the live deletion target');
      assert.equal(live.isStreaming, false);
      assert.ok(fs.existsSync(file));
      await manager.deleteConversation({ sessionId: live.id });
      assert.equal(manager.get(live.id), undefined);

      cwd = createSessionWorkingDirectory(root, 'late-flush');
      const flushing = { id: 'late-flush', cwd, sessionFile: null as string | null, terminate: async () => { history(cwd); flushing.sessionFile = file; } };
      manager.sessions.set(flushing.id, flushing);
      await manager.deleteConversation({ sessionId: flushing.id });
      assert.equal(fs.existsSync(file), false, 'a history file first flushed during termination is also deleted');
    }

    // session jobs enforce owner and Host limits and close waits for cancellation
    {
      const { LiveSessionManager } = require('../../bin/sessions.js');
      const manager = new LiveSessionManager();
      for (const id of ['a', 'b', 'c']) manager.sessions.set(id, { id, terminate: async () => { } });
      const releases: Array<() => void> = [];
      let aborted = false;
      const job = (signal: AbortSignal) => new Promise<void>((resolve) => { releases.push(resolve); signal.addEventListener('abort', () => { aborted = true; resolve(); }); });
      const running = [manager.runJob('a', job), manager.runJob('a', job), manager.runJob('b', job), manager.runJob('b', job)];
      await assert.rejects(manager.runJob('a', job), /capacity/);
      await assert.rejects(manager.runJob('c', job), /capacity/);
      await new Promise((resolve) => setImmediate(resolve));
      await manager.delete('a');
      assert.equal(aborted, true);
      assert.equal(manager.get('a'), undefined);
      await assert.rejects(manager.runJob('a', job), /unavailable/);
      await manager.cancelJobs('b');
      await Promise.all(running);
      await manager.runJob('c', async () => { });
    }

    // real controlled processes enforce global capacity and release it after confirmed abort
    {
      const { ProcessRunner } = require('../../bin/process-runner.js');
      const runner = new ProcessRunner();
      const other = new ProcessRunner();
      t.after(() => Promise.all([runner.terminateAll(), other.terminateAll()]));
      const controller = new AbortController();
      const executable = { command: process.execPath, args: [], version: 'test' };
      const options = { timeoutMs: 10000, maxBuffer: 1024, signal: controller.signal };
      const runs = Array.from({ length: 4 }, () => runner.run(executable, ['-e', 'setInterval(()=>{},1000)'], options));
      const outcomes = runs.map((run) => assert.rejects(run, /cancelled/));
      await assert.rejects(other.run(executable, ['-e', ''], options), /capacity/);
      assert.equal(runner.activeCount, 4);
      controller.abort();
      await Promise.all(outcomes);
      assert.equal(runner.activeCount, 0);
      const result = await other.run(executable, ['-e', "process.stdout.write('done')"], { timeoutMs: 10000, maxBuffer: 1024 });
      assert.equal(result.stdout, 'done');
    }

    // abort stops a descendant Writer even when its parent exits first
    {
      const { ProcessRunner } = require('../../bin/process-runner.js');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tau-descendant-'));
      t.after(() => fs.rmSync(root, { recursive: true, force: true }));
      const marker = path.join(root, 'writes');
      const ready = path.join(root, 'pid');
      const script = path.join(root, 'parent.cjs');
      fs.writeFileSync(script, `const {spawn}=require('child_process');const fs=require('fs');const child=spawn(process.execPath,['-e',"const fs=require('fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20)",process.argv[2]],{stdio:'ignore'});fs.writeFileSync(process.argv[3],String(child.pid));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`);
      const runner = new ProcessRunner();
      const controller = new AbortController();
      const run = runner.run({ command: process.execPath, args: [], version: 'test' }, [script, marker, ready], { timeoutMs: 10000, maxBuffer: 1024, signal: controller.signal });
      const rejected = assert.rejects(run, /cancelled/);
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(marker)) { assert.ok(Date.now() < deadline, 'descendant did not start'); await new Promise((resolve) => setTimeout(resolve, 20)); }
      const pid = Number(fs.readFileSync(ready, 'utf8'));
      t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch { } });
      controller.abort();
      await rejected;
      const bytes = fs.statSync(marker).size;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(fs.statSync(marker).size, bytes);
    }
  }

  {
    const assert = require('node:assert/strict');
    const { createSessionRpcHandlers } = require('../../bin/rpc-handlers/session.js');
    const reply = {
      success(data: unknown) { return { success: true, data }; },
      failure(error: string) { return { success: false, error }; },
    };

    // Session RPC handler appends a name and updates the live session
    {
      const session = { sessionFile: '/tmp/session.jsonl' };
      const updates: Array<{ session: unknown; name: string }> = [];
      const handler = createSessionRpcHandlers({
        getLiveSession: () => session,
        findLiveSessionByFile: () => null,
        appendSessionName: (filePath: string, name: string) => { assert.equal(filePath, '/tmp/session.jsonl'); assert.equal(name, '早高峰'); return filePath; },
        updateLiveSessionName: (target: unknown, name: string) => updates.push({ session: target, name }),
      }).set_session_name;
      assert.deepEqual(handler.handle({ type: 'set_session_name', sessionId: 'session-1', name: '早高峰' }, reply), { success: true, data: { name: '早高峰' } });
      assert.deepEqual(updates, [{ session, name: '早高峰' }]);
    }

    // Session RPC handler rejects an empty name before resolving a session
    {
      const handler = createSessionRpcHandlers({
        getLiveSession() { throw new Error('should not resolve'); },
        findLiveSessionByFile() { throw new Error('should not resolve'); },
        appendSessionName() { throw new Error('should not append'); },
        updateLiveSessionName() { throw new Error('should not update'); },
      }).set_session_name;
      assert.deepEqual(handler.handle({ type: 'set_session_name', name: ' ' }, reply), { success: false, error: 'Name cannot be empty' });
    }

    // Session RPC handler rejects names longer than the create-session limit
    {
      const handler = createSessionRpcHandlers({
        getLiveSession() { throw new Error('should not resolve'); },
        findLiveSessionByFile() { throw new Error('should not resolve'); },
        appendSessionName() { throw new Error('should not append'); },
        updateLiveSessionName() { throw new Error('should not update'); },
      }).set_session_name;
      assert.deepEqual(handler.handle({ type: 'set_session_name', name: 'x'.repeat(121) }, reply), { success: false, error: 'Name cannot exceed 120 characters' });
    }
  }
});
