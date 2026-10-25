const { test } = require('node:test') as typeof import('node:test');

test('Session close, history deletion and process cancellation preserve writer ownership', async (t) => {
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
