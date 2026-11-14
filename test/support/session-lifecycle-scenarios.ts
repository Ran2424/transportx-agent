import type { TestContext } from 'node:test';

async function assertConversationLifecycle(t: TestContext) {
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
    const { LiveSessionManager } = require('../../bin/live-session-manager.js');
    const { spawn } = require('node:child_process');
    let launchMode = 'ok', launches = 0, releaseLaunch: (() => void) | undefined, rejectPlan = false, rejectModel = false, holdPreflight = false, releasePreflight: (() => void) | undefined;
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
    const gate = new WorkspaceRuntimeGate(process.env.TAU_PYTHON_COMMAND || 'python3', path.join(root, 'logs'), path.join(root, 'coordination'));
    const lifecycle = new ConversationRuntime({ store, sessions: manager, gate, assertReady: () => {}, verifyPlan: async (plan: any) => {
      if (rejectPlan) throw Object.assign(new Error('Frozen module version unavailable.'), { code: 'module_version_missing' });
      if (holdPreflight) await new Promise<void>((resolve) => { releasePreflight = resolve; });
      if (rejectModel) throw Object.assign(new Error('Configured model unavailable.'), { code: 'model_unavailable' });
      return plan;
    } });
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
      rejectModel = true;
      await assert.rejects(lifecycle.activate(second.conversation.id, true), { code: 'model_unavailable' });
      assert.equal(manager.get(liveA.id), liveA, 'model validation completes before stopping A');
      rejectModel = false; holdPreflight = true;
      const checking = lifecycle.activate(second.conversation.id, true), cancelledCheck = assert.rejects(checking, { code: 'activation_cancelled' });
      const preflightDeadline = Date.now() + 2000;
      while (!releasePreflight) { assert.ok(Date.now() < preflightDeadline); await new Promise((resolve) => setImmediate(resolve)); }
      await lifecycle.close(second.conversation.id, true); await cancelledCheck;
      releasePreflight!(); holdPreflight = false; await new Promise((resolve) => setImmediate(resolve));
      assert.equal(manager.get(liveA.id), liveA, 'cancelling B during preflight leaves A running');
      assert.equal(launches, 1, 'a late validation result after close cannot launch Pi');
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

    // Existing project folders keep their exact root and original bytes; retries never allocate a child.
    const project = path.join(parent, '20261026-130000-已有项目'); fs.mkdirSync(project);
    const original = Buffer.from('road,count\n已有路段,42\n'); fs.writeFileSync(path.join(project, 'data.csv'), original);
    fs.mkdirSync(path.join(project, '.git')); fs.writeFileSync(path.join(project, '.git/config'), 'original repository config');
    const folderInput = { ...input, requestId: 'open-project', workspace: { kind: 'folder', name: '已有项目', directory: project } };
    await assert.rejects(service.create({ ...folderInput, workspace: { ...folderInput.workspace, parentDirectory: parent } }), { code: 'invalid_conversation_input' });
    await assert.rejects(service.create({ ...folderInput, model: 'missing' }), /model missing/);
    assert.equal(fs.existsSync(path.join(project, '.tau')), false);
    await assert.rejects(service.create({ ...folderInput, workspace: { ...folderInput.workspace, directory: path.join(parent, 'not-created') } }), { code: 'workspace_missing' });
    assert.equal(fs.existsSync(path.join(parent, 'not-created')), false);
    await assert.rejects(service.create({ ...folderInput, workspace: { ...folderInput.workspace, directory: root } }), { code: 'workspace_identity_conflict' });
    const [opened, repeated] = await Promise.all([service.create(folderInput), service.create(folderInput)]);
    assert.equal(opened.directory, require('../../bin/util/path.js').toPosixPath(project));
    assert.equal(opened.conversation.id, repeated.conversation.id);
    assert.equal(store.readPlan(project, opened.conversation).workspace, opened.directory);
    assert.equal(store.readCatalog().entries.find((entry: any) => entry.workspaceId === opened.manifest.id).directoryOwnership, 'external');
    assert.deepEqual(fs.readdirSync(project).sort(), ['.git', '.tau', 'data.csv']);
    assert.deepEqual(fs.readFileSync(path.join(project, 'data.csv')), original);
    assert.equal(fs.readFileSync(path.join(project, '.git/config'), 'utf8'), 'original repository config');
    assert.equal(fs.existsSync(path.join(store.sessionsDirectory, opened.conversation.history.key)), false);
    assert.equal((await restarted.create(folderInput)).conversation.id, opened.conversation.id);
    await assert.rejects(service.create({ ...folderInput, requestId: 'open-again' }), { code: 'workspace_identity_conflict' });
    const nested = path.join(project, 'nested'); fs.mkdirSync(nested);
    await assert.rejects(service.create({ ...folderInput, requestId: 'nested-project', workspace: { ...folderInput.workspace, directory: nested } }), { code: 'workspace_identity_conflict' });
    const oldProject = path.join(parent, 'old-project'); fs.mkdirSync(path.join(oldProject, '.tau'), { recursive: true });
    fs.writeFileSync(path.join(oldProject, '.tau/original.json'), 'original metadata');
    const catalogBefore = fs.readFileSync(store.catalogFile);
    await assert.rejects(service.create({ ...folderInput, requestId: 'old-project', workspace: { ...folderInput.workspace, directory: oldProject } }), { code: 'workspace_migration_required' });
    assert.deepEqual(fs.readFileSync(store.catalogFile), catalogBefore);
    assert.equal(fs.readFileSync(path.join(oldProject, '.tau/original.json'), 'utf8'), 'original metadata');
    const alias = path.join(parent, 'alias'); let linked = false;
    try { fs.symlinkSync(project, alias, 'dir'); linked = true; }
    catch (error) { t.diagnostic(`Project alias assertion unavailable: ${(error as Error).message}`); }
    if (linked) await assert.rejects(service.create({ ...folderInput, requestId: 'alias-project', workspace: { ...folderInput.workspace, directory: alias } }), { code: 'workspace_identity_conflict' });
    if (linked) {
      const privateHistory = path.join(parent, 'private-history'), historyAlias = path.join(root, 'history-alias'); fs.mkdirSync(privateHistory); fs.symlinkSync(privateHistory, historyAlias, 'dir');
      const aliasService = new WorkspaceService({ ...options, store: new WorkspaceStore(root, historyAlias) });
      await assert.rejects(aliasService.create({ ...folderInput, requestId: 'private-history-project', workspace: { ...folderInput.workspace, directory: privateHistory } }), { code: 'workspace_identity_conflict' });
      assert.deepEqual(fs.readdirSync(privateHistory), [], 'canonical Native history roots cannot become public projects');
      const projectsAlias = path.join(root, 'projects-alias'), aliasProject = path.join(parent, 'alias-root-project'); fs.symlinkSync(parent, projectsAlias, 'dir'); fs.mkdirSync(aliasProject);
      const aliasRootService = new WorkspaceService({ ...options, defaultParentDirectory: projectsAlias });
      assert.equal((await aliasRootService.create({ ...folderInput, requestId: 'canonical-project-root', workspace: { ...folderInput.workspace, directory: aliasProject } })).directory, require('../../bin/util/path.js').toPosixPath(aliasProject));
    }
    const { WorkspaceDeletion } = require('../../bin/workspace-deletion.js');
    const protectedDeletion = new WorkspaceDeletion({ store, assertSystemReady: () => {}, runtime: { withWorkspaceStopped: () => { throw new Error('must not stop external project'); } } });
    assert.throws(() => protectedDeletion.workspace(opened.manifest.id, { requestId: 'delete-project', expectedRevision: opened.manifest.revision, confirm: true }), { code: 'workspace_directory_external' });
    assert.throws(() => require('../../bin/session-workspace.js').resolveSessionWorkspaceForDeletion(project), /Cannot verify task directory ownership/);
    assert.deepEqual(fs.readFileSync(path.join(project, 'data.csv')), original);

    const recoveryProject = path.join(parent, 'recovery-project'); fs.mkdirSync(recoveryProject);
    const recoveryInput = { ...folderInput, requestId: 'folder-response-loss', workspace: { ...folderInput.workspace, directory: recoveryProject } };
    fs.renameSync = (source: string, target: string) => {
      if (target === store.catalogFile && JSON.parse(fs.readFileSync(source, 'utf8')).entries.some((entry: any) => entry.creationRequestId === recoveryInput.requestId && entry.state === 'ready')) throw Object.assign(new Error('catalog unavailable'), { code: 'ENOSPC' });
      return rename(source, target);
    };
    try { await assert.rejects(service.create(recoveryInput), { code: 'ENOSPC' }); }
    finally { fs.renameSync = rename; }
    const savedFolderManifest = JSON.parse(fs.readFileSync(path.join(recoveryProject, '.tau/workspace.json'), 'utf8'));
    const recoveredFolder = await restarted.create(recoveryInput);
    assert.equal(recoveredFolder.conversation.id, savedFolderManifest.conversations[0].id);
    assert.equal(recoveredFolder.directory, require('../../bin/util/path.js').toPosixPath(recoveryProject));
  }
}

module.exports = { assertConversationLifecycle };
