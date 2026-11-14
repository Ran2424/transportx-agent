const { test } = require('node:test') as typeof import('node:test');

test('Session close, history deletion and process cancellation preserve writer ownership', async (t) => {
  const { toPosixPath } = require('../../bin/util/path.js');
  // Probe diagnostics distinguish native commands without treating failures as confirmed exits.
  {
    const assert = require('node:assert/strict'), childProcess = require('node:child_process');
    const { hostPlatform } = require('../../bin/host-platform.js'), diagnostics = require('../../bin/diagnostic-log.js');
    const modulePath = require.resolve('../../bin/process-inspection.js');
    const original = { sync: childProcess.execFileSync, async: childProcess.execFile, log: diagnostics.logHostEvent, profile: hostPlatform.processInspection, kill: process.kill };
    const records: any[] = [], signals: unknown[] = [];
    let mode = 'boot-timeout';
    const timeout = Object.assign(new Error('Native probe timed out'), { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', stderr: Buffer.from('CIM probe did not finish') });
    try {
      hostPlatform.processInspection = { ...original.profile, pythonScript: undefined, command: 'fixture-process', args: [], bootCommand: 'fixture-boot', bootArgs: [] };
      diagnostics.logHostEvent = (_level: string, event: string, fields: unknown) => { if (event === 'native_process_probe') records.push(fields); };
      childProcess.execFileSync = (command: string, _args: string[], options: any) => {
        assert.equal(options.timeout, 5000);
        if (command === 'fixture-boot') { if (mode === 'boot-timeout') throw timeout; return 'fixture-boot-id'; }
        if (mode === 'process-timeout') throw timeout;
        if (mode === 'command-error') throw Object.assign(new Error('CIM query failed'), { code: 'EIO', status: 7, signal: null, stderr: 'CIM access denied' });
        return JSON.stringify({ state: 'running', pid: mode === 'wrong-pid' ? process.pid + 1 : process.pid, startedAt: 'fixture-start', command: 'fixture-node', parentPid: process.ppid });
      };
      process.kill = ((_pid: number, signal: unknown) => { signals.push(signal); return true; }) as typeof process.kill;
      const inspection = require(modulePath);
      assert.equal(inspection.inspectProcess(process.pid, 'unused').state, 'unknown');
      assert.deepEqual(records.map(({ probe, outcome }) => [probe, outcome]), [['process-identity', 'success'], ['boot-identity', 'error']]);
      assert.equal(records[1].code, 'ETIMEDOUT'); assert.equal(records[1].signal, 'SIGTERM');
      assert.equal(records[1].stderr, 'CIM probe did not finish');
      mode = 'healthy';
      const running = inspection.inspectProcess(process.pid, 'unused'); assert.equal(running.state, 'running');
      mode = 'process-timeout';
      await assert.rejects(inspection.stopRecordedProcess(running.identity, 'unused'), { code: 'process_stop_unconfirmed' });
      assert.ok(signals.every((signal) => signal === 0), 'an unverified identity must never be signalled');
      assert.equal(records.at(-1).probe, 'process-identity'); assert.equal(records.at(-1).targetPid, process.pid);
      mode = 'command-error';
      assert.equal(inspection.inspectProcess(process.pid, 'unused').state, 'unknown');
      assert.equal(records.at(-1).status, 7); assert.equal(records.at(-1).stderr, 'CIM access denied');
      mode = 'wrong-pid';
      assert.equal(inspection.inspectProcess(process.pid, 'unused').state, 'unknown', 'a command completing does not bypass identity validation');
      childProcess.execFile = (...args: any[]) => { args.at(-1)(timeout, '', 'inventory stderr'); return {}; };
      await assert.rejects(inspection.workspaceProcessInventory(process.cwd(), 'fixture-python'), { code: 'process_stop_unconfirmed' });
      assert.equal(records.at(-1).probe, 'workspace-inventory'); assert.equal(records.at(-1).timeoutMs, 20000);
      assert.ok(records.every((record) => Number.isFinite(record.durationMs) && record.durationMs >= 0));
    } finally {
      childProcess.execFileSync = original.sync; childProcess.execFile = original.async; diagnostics.logHostEvent = original.log;
      hostPlatform.processInspection = original.profile; process.kill = original.kill; delete require.cache[modulePath];
    }
  }
  const { assertWorkspaceMigration } = require('../support/workspace-migration-scenarios.ts');
  await assertWorkspaceMigration(t);

  // Move intents recover before inventory and exclude both local and foreign runtimes.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
    const { spawn } = require('node:child_process'), { once } = require('node:events');
    const { WorkspaceStore } = require('../../bin/workspace-store.js'), { WorkspaceMigration } = require('../../bin/workspace-migration.js');
    const { WorkspaceTransfer, pendingWorkspaceTransfers } = require('../../bin/workspace-transfer.js'), { WorkspaceRuntimeGate } = require('../../bin/workspace-runtime.js'), { ConversationRuntime } = require('../../bin/conversation-runtime.js');
    const { acquireWriteLease } = require('../../bin/util/json-storage.js');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tau-move-recovery-'))), python = process.env.TAU_PYTHON_COMMAND || 'python3', at = '2026-10-26T00:00:00.000Z';
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let serial = 0;
    const ready = (child: any) => new Promise<void>((resolve, reject) => {
      let stderr = ''; child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk).slice(-2000); });
      const done = (error?: Error) => { clearTimeout(timer); child.removeListener('message', message); child.removeListener('exit', exit); child.removeListener('error', fail); error ? reject(error) : resolve(); };
      const message = () => done(), exit = () => done(new Error(`Fixture child exited before its barrier: ${stderr}`)), fail = (error: Error) => done(error);
      const timer = setTimeout(() => done(new Error(`Fixture child did not reach its barrier: ${stderr}`)), 30000);
      child.once('message', message); child.once('exit', exit); child.once('error', fail);
    });
    const fixture = async (empty = false) => {
      const directory = path.join(root, String(serial++)), data = path.join(directory, 'data'), scenario = path.join(directory, 'scenario'), guards = path.join(directory, 'guards'); fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(scenario);
      let release = acquireWriteLease(path.join(data, 'host')); t.after(() => release?.());
      const store = new WorkspaceStore(data, path.join(data, 'sessions')); await store.initializeCatalog({ schemaVersion: 1, revision: 0, entries: [] });
      const source = path.join(scenario, 'a-source'), target = path.join(scenario, 'b-target'), id = `conv_${crypto.randomUUID()}`;
      const record = { id, creationRequestId: null, creationInputSha256: null, name: 'Keep this conversation', createdAt: at, updatedAt: at, defaultsRevision: null, modelSpec: null, appendSystemPrompt: '', state: empty ? 'created' : 'ready', history: { key: `transportx/${id}.jsonl`, headerId: empty ? null : `native-${id}` }, plan: null, privateState: 'isolated', lastStartFailure: null, deletion: null };
      const workspace = async (cwd: string, records: any[]) => { fs.mkdirSync(cwd); const entry = await store.reserveWorkspace(crypto.randomUUID(), 'a'.repeat(64), () => cwd); await store.publishWorkspace(entry.workspaceId, { schemaVersion: 1, id: entry.workspaceId, revision: 0, name: path.basename(cwd), createdAt: at, updatedAt: at, defaultsRevision: 0, defaults: { domainId: null, profile: null, modelSpec: null }, citationRegistryId: entry.workspaceId, conversations: records }); return entry.workspaceId; };
      const sourceId = await workspace(source, [record]), targetId = await workspace(target, []), history = path.join(store.sessionsDirectory, record.history.key);
      fs.mkdirSync(path.dirname(history), { recursive: true });
      const body = JSON.stringify({ type: 'message', id: 'user-one', parentId: null, message: { role: 'user', content: 'Preserve these Native bytes', timestamp: 1 } }) + '\n';
      if (!empty) fs.writeFileSync(history, JSON.stringify({ type: 'session', id: record.history.headerId, cwd: source }) + '\n' + body);
      const privateFile = (cwd: string) => path.join(cwd, '.tau/conversations', id, 'state.json'); fs.mkdirSync(path.dirname(privateFile(source)), { recursive: true }); fs.writeFileSync(privateFile(source), '{"keep":true}');
      const start = async () => {
        let transfer: any;
        const migration = new WorkspaceMigration(store, { agentDir: data, workspaceRoots: [scenario], recoverTransfers: () => transfer.recover() }), gate = new WorkspaceRuntimeGate(python, path.join(directory, 'logs'), guards);
        const runtime = new ConversationRuntime({ store, gate, sessions: { sessions: new Map() }, assertReady: (id: string) => migration.assertWorkspaceReady(id), verifyPlan: (plan: any) => plan });
        transfer = new WorkspaceTransfer({ store, gate, runtime, assertSystemReady: () => migration.assertSystemReady(), assertWorkspaceReady: (id: string) => migration.assertWorkspaceReady(id) });
        await migration.initialize(); return { transfer, migration, gate };
      };
      return { ...(await start()), start, directory, data, scenario, guards, store, source, target, sourceId, targetId, id, history, body, empty, privateFile, unlock: () => { release(); release = null; }, relock: () => { release = acquireWriteLease(path.join(data, 'host')); } };
    };
    const verify = (f: any, owner: string) => {
      const matches = f.store.readCatalog().entries.flatMap((entry: any) => f.store.readWorkspace(entry.workspaceId).manifest.conversations.map((record: any) => ({ cwd: entry.path, record }))).filter((item: any) => item.record.id === f.id);
      assert.equal(matches.length, 1); assert.equal(matches[0].cwd, toPosixPath(owner)); assert.equal(matches[0].record.name, 'Keep this conversation');
      assert.equal(fs.readFileSync(f.privateFile(owner), 'utf8'), '{"keep":true}'); assert.deepEqual(pendingWorkspaceTransfers(f.data), []);
      if (!f.empty) { const bytes = fs.readFileSync(f.history, 'utf8'), end = bytes.indexOf('\n'); assert.equal(bytes.slice(end + 1), f.body); assert.equal(toPosixPath(JSON.parse(bytes.slice(0, end)).cwd), toPosixPath(owner)); }
    };
    for (const point of ['before-target', 'before-header', 'before-source', 'after-source', 'cleanup', 'partial-cleanup', 'clear-intent']) {
      const f = await fixture(), edit = f.store.editWorkspace.bind(f.store), relocate = f.store.relocateHistory.bind(f.store), rm = fs.rmSync;
      f.store.editWorkspace = async (id: string, ...args: any[]) => { if (point === 'before-target' && id === f.targetId || point === 'before-source' && id === f.sourceId) throw Object.assign(new Error(point), { code: 'EIO' }); const result = await edit(id, ...args); if (point === 'after-source' && id === f.sourceId) throw Object.assign(new Error(point), { code: 'EIO' }); return result; };
      f.store.relocateHistory = (...args: any[]) => { if (point === 'before-header') throw Object.assign(new Error(point), { code: 'EIO' }); return relocate(...args); };
      fs.rmSync = (file: string, ...args: any[]) => { if (point === 'partial-cleanup' && path.resolve(file) === path.dirname(f.privateFile(f.source))) { rm(f.privateFile(f.source)); throw Object.assign(new Error(point), { code: 'EIO' }); } if (point === 'cleanup' && path.resolve(file) === path.dirname(f.privateFile(f.source)) || point === 'clear-intent' && file === path.join(f.data, 'transfers', `${f.id}.json`)) throw Object.assign(new Error(point), { code: 'EIO' }); return rm(file, ...args); };
      try { await assert.rejects(f.transfer.move(f.id, { target: f.targetId }), { code: 'EIO' }); } finally { f.store.editWorkspace = edit; f.store.relocateHistory = relocate; fs.rmSync = rm; }
      assert.equal(f.migration.status().dataState, 'initializing'); assert.equal(pendingWorkspaceTransfers(f.data).length, 1);
      if (point === 'partial-cleanup') { const foreign = path.join(path.dirname(f.privateFile(f.source)), 'foreign.txt'); fs.writeFileSync(foreign, 'must survive'); await assert.rejects(f.start(), { code: 'workspace_revision_conflict' }); assert.equal(fs.readFileSync(foreign, 'utf8'), 'must survive'); fs.rmSync(foreign); }
      const restarted = await f.start(); assert.equal(restarted.migration.status().dataState, 'ready'); verify(f, ['before-target', 'before-header'].includes(point) ? f.source : f.target);
    }
    // Empty histories must resolve even when both management timestamps are identical.
    {
      const OriginalDate = Date;
      (globalThis as any).Date = class extends OriginalDate { constructor(value?: any) { super(value === undefined ? at : value); } static now() { return OriginalDate.parse(at); } };
      try {
        const f = await fixture(true), edit = f.store.editWorkspace.bind(f.store);
        f.store.editWorkspace = async (id: string, ...args: any[]) => { if (id === f.sourceId) throw Object.assign(new Error('empty crash'), { code: 'EIO' }); return edit(id, ...args); };
        try { await assert.rejects(f.transfer.move(f.id, { target: f.targetId }), { code: 'EIO' }); } finally { f.store.editWorkspace = edit; }
        const journal = JSON.parse(fs.readFileSync(path.join(f.data, 'transfers', `${f.id}.json`))); assert.equal(journal.source.record.updatedAt, journal.target.record.updatedAt);
        await f.start(); verify(f, f.target); assert.equal(fs.existsSync(f.history), false);
      } finally { (globalThis as any).Date = OriginalDate; }
    }
    // A different process owns the disk runtime lease; neither source nor target may be moved.
    for (const side of ['source', 'target']) {
      const f = await fixture(), cwd = side === 'source' ? f.source : f.target, workspaceId = side === 'source' ? f.sourceId : f.targetId;
      const code = `const {WorkspaceRuntimeGate}=require(process.argv[1]);const value=JSON.parse(process.argv[2]);const gate=new WorkspaceRuntimeGate(value.python,value.logs,value.guards);const lease=gate.takeMaintenance(value.cwd,value.workspaceId);process.send({ready:true});process.on('message',()=>{lease.finish();process.exit(0)});setInterval(()=>{},1000);`;
      const child = spawn(process.execPath, ['-e', code, path.resolve('bin/workspace-runtime.js'), JSON.stringify({ cwd, workspaceId, python, guards: f.guards, logs: path.join(f.directory, 'foreign-logs') })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      try { await ready(child); await assert.rejects(f.transfer.move(f.id, { target: f.targetId, stopCurrent: true }), { code: 'workspace_busy' }); verify(f, f.source); }
      finally { if (child.connected) { const exited = once(child, 'exit'); child.send({ stop: true }); await exited; } }
      await f.transfer.move(f.id, { target: f.targetId }); verify(f, f.target);
    }
    // Actual Host death leaves maintenance records behind; startup may recheck only the recorded generations.
    for (const point of ['before-header', 'before-source']) {
      const f = await fixture(); f.unlock();
      const code = `const fs=require('node:fs'),path=require('node:path');const v=JSON.parse(process.argv[1]),base=v.bin;const {WorkspaceStore}=require(path.join(base,'workspace-store.js')),{WorkspaceMigration}=require(path.join(base,'workspace-migration.js')),{WorkspaceTransfer}=require(path.join(base,'workspace-transfer.js')),{WorkspaceRuntimeGate}=require(path.join(base,'workspace-runtime.js')),{ConversationRuntime}=require(path.join(base,'conversation-runtime.js')),{acquireWriteLease}=require(path.join(base,'util/json-storage.js'));acquireWriteLease(path.join(v.data,'host'));const store=new WorkspaceStore(v.data,path.join(v.data,'sessions')),migration=new WorkspaceMigration(store,{agentDir:v.data,workspaceRoots:[v.scenario]}),gate=new WorkspaceRuntimeGate(v.python,path.join(v.directory,'child-logs'),v.guards),runtime=new ConversationRuntime({store,gate,sessions:{sessions:new Map()},assertReady:id=>migration.assertWorkspaceReady(id),verifyPlan:p=>p}),transfer=new WorkspaceTransfer({store,gate,runtime,assertSystemReady:()=>migration.assertSystemReady(),assertWorkspaceReady:id=>migration.assertWorkspaceReady(id)});const pause=()=>{process.send({crashWindow:true});return new Promise(()=>{});};if(v.point==='before-header')store.relocateHistory=pause;else{const edit=store.editWorkspace.bind(store);store.editWorkspace=(id,...args)=>id===v.sourceId?pause():edit(id,...args);}transfer.move(v.id,{target:v.targetId}).catch(e=>{console.error(e);process.exit(1)});setInterval(()=>{},1000);`;
      const child = spawn(process.execPath, ['-e', code, JSON.stringify({ ...f, bin: path.resolve('bin'), python, point })], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      await ready(child); const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; f.relock();
      const restarted = await f.start(); assert.equal(restarted.migration.status().dataState, 'ready'); verify(f, point === 'before-header' ? f.source : f.target);
      assert.equal(restarted.gate.diagnostics(f.source).phase, 'stopped'); assert.equal(restarted.gate.diagnostics(f.target).phase, 'stopped');
    }
    // Foreign edits and corrupt intents must block recovery without pruning either copy.
    {
      const f = await fixture(), edit = f.store.editWorkspace.bind(f.store);
      f.store.editWorkspace = async (id: string, ...args: any[]) => { if (id === f.sourceId) throw Object.assign(new Error('pending move'), { code: 'EIO' }); return edit(id, ...args); };
      try { await assert.rejects(f.transfer.move(f.id, { target: f.targetId }), { code: 'EIO' }); } finally { f.store.editWorkspace = edit; }
      fs.writeFileSync(f.privateFile(f.target), 'foreign change'); await assert.rejects(f.start(), { code: 'workspace_revision_conflict' });
      assert.equal(f.store.readWorkspace(f.sourceId).manifest.conversations.length, 1); assert.equal(f.store.readWorkspace(f.targetId).manifest.conversations.length, 1);
      fs.writeFileSync(f.privateFile(f.target), '{"keep":true}');
      const native = fs.readFileSync(f.history, 'utf8'); fs.writeFileSync(f.history, native.replace(`native-${f.id}`, 'changed-native-identity')); await assert.rejects(f.start(), { code: 'history_identity_mismatch' }); fs.writeFileSync(f.history, native);
      const file = path.join(f.data, 'transfers', `${f.id}.json`), journal = fs.readFileSync(file); fs.writeFileSync(file, '{}'); await assert.rejects(f.start(), { code: 'metadata_corrupt' }); fs.writeFileSync(file, journal);
      await f.start(); verify(f, f.target);
    }
    t.diagnostic('Move regression covers persisted intents, equal-time empty sessions, seven interrupted stages including partial cleanup, foreign-process leases and two SIGKILL Host restarts.');
  }
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
    const gate = new WorkspaceRuntimeGate(python, path.join(root, 'logs'), path.join(root, 'coordination'));
    const workspaceId = 'ws_00000000-0000-4000-8000-000000000001', conversationId = 'conv_00000000-0000-4000-8000-000000000002';
    const lease = gate.take(root, workspaceId, conversationId);
    const tracked = managedRuntimeProcess(root); tracked.started(child); lease.running();
    assert.throws(() => new WorkspaceRuntimeGate(python, root, path.join(root, 'coordination')).take(root, workspaceId, conversationId), { code: 'workspace_busy' });
    assert.throws(() => lease.finish(), { code: 'process_stop_unconfirmed' });
    const diagnostic = gate.diagnostics(root);
    assert.equal(diagnostic.processes[0].observation.state, 'running');
    assert.equal(JSON.stringify(diagnostic).includes('token'), false);
    await stopRecordedProcess(observed.identity, python); tracked.stopped(); lease.stopping(); lease.finish();
    assert.equal(gate.diagnostics(root).phase, 'stopped');
    const next = gate.take(root, workspaceId, 'conv_00000000-0000-4000-8000-000000000003');
    assert.notEqual(next.generation, lease.generation);
    const { ProcessRunner } = require('../../bin/process-runner.js');
    const registeredFile = path.join(root, 'managed-process-registered');
    const running = new ProcessRunner().run({ command: process.execPath, args: [] }, ['-e', "const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(timer);console.log('tracked-native');}},10);", registeredFile], { cwd: root, timeoutMs: 2000, maxBuffer: 1024 });
    // run() registers the child synchronously; let it exit only after identity inspection finishes.
    fs.writeFileSync(registeredFile, 'registered');
    const output = await running;
    assert.match(output.stdout, /tracked-native/);
    assert.equal(gate.diagnostics(root).processes[0].kind, 'managed');
    assert.equal(gate.diagnostics(root).processes[0].state, 'stopped', 'domain subprocess completion commits its runtime stop before returning');
    next.finish();
    const runtimeFile = path.join(root, 'coordination', fs.readdirSync(path.join(root, 'coordination')).find((name: string) => /^[a-f0-9]{64}\.json$/.test(name)));
    const stoppedRecord = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    const interrupted = { ...stoppedRecord, phase: 'running', host: observed.identity, processes: [{ id: 'interrupted-pi', kind: 'pi', state: 'running', pid: child.pid, identity: observed.identity }] };
    fs.writeFileSync(runtimeFile, JSON.stringify(interrupted));
    const recovered = gate.take(root, workspaceId, conversationId);
    assert.notEqual(recovered.generation, interrupted.generation, 'a confirmed exited Host and Pi do not permanently block activation');
    recovered.finish();
    for (const blocked of [
      { ...interrupted, host: original.identity },
      { ...interrupted, processes: [{ ...interrupted.processes[0], pid: process.pid, identity: original.identity }] },
      { ...interrupted, processes: [{ ...interrupted.processes[0], state: 'starting', pid: null, identity: null }] },
      { ...interrupted, processes: [{ ...interrupted.processes[0], state: 'starting', pid: process.pid, identity: null }] },
      { ...interrupted, processes: [{ ...interrupted.processes[0], pid: process.pid, identity: { ...original.identity, executableSha256: '0'.repeat(64) } }] },
    ]) {
      const bytes = JSON.stringify(blocked); fs.writeFileSync(runtimeFile, bytes);
      assert.throws(() => gate.take(root, workspaceId, conversationId), { code: 'process_stop_unconfirmed' });
      assert.equal(fs.readFileSync(runtimeFile, 'utf8'), bytes, 'an unsafe or unknown generation is never replaced');
    }
    const recycled = { ...original.identity, startedAt: 'previous-kernel-start' };
    fs.writeFileSync(runtimeFile, JSON.stringify({ ...interrupted, host: recycled, processes: [{ ...interrupted.processes[0], pid: process.pid, identity: recycled }] }));
    gate.take(root, workspaceId, conversationId).finish();
    assert.equal(inspectRecordedProcess(original.identity, python).state, 'running', 'recycled PIDs are not signalled during passive recovery');
    fs.writeFileSync(runtimeFile, JSON.stringify({ ...interrupted, host: { ...observed.identity, bootId: '0'.repeat(64) }, processes: [{ ...interrupted.processes[0], state: 'starting', pid: null, identity: null }] }));
    gate.take(root, workspaceId, conversationId).finish();
  }
  const { assertConversationLifecycle } = require('../support/session-lifecycle-scenarios.ts');
  await assertConversationLifecycle(t);

  const { assertWorkspaceWriters } = require('../support/workspace-writer-scenarios.ts');
  await assertWorkspaceWriters(t);

  // Deletion commits dependency order and resumes without reconstructing an Owner from its audit key.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
    const { WorkspaceStore, workspaceCreationDigest } = require('../../bin/workspace-store.js'), { WorkspaceRuntimeGate } = require('../../bin/workspace-runtime.js');
    const { ConversationRuntime } = require('../../bin/conversation-runtime.js'), { WorkspaceDeletion } = require('../../bin/workspace-deletion.js'), { LiveSessionManager } = require('../../bin/live-session-manager.js');
    const { defaultSessionProfile } = require('../../bin/contracts/session-profile.js');
    const { executionOwner, executionOwnerKey, removeExecutionMetadata } = require('../../bin/util/execution-owner.js');
    const { createSessionWorkingDirectory, resolveSessionWorkspaceForDeletion, removeSessionWorkingDirectory } = require('../../bin/session-workspace.js');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tau-staged-delete-'))), sessions = path.join(root, 'sessions'); fs.mkdirSync(sessions);
    const store = new WorkspaceStore(path.join(root, 'data'), sessions); await store.initializeCatalog({ schemaVersion: 1, revision: 0, entries: [] });
    const scenario = path.join(root, 'scenario'); fs.mkdirSync(scenario);
    const directory = createSessionWorkingDirectory(scenario, '分阶段删除'), reserved = await store.reserveWorkspace('delete-fixture', workspaceCreationDigest('fixture'), () => directory);
    const at = '2026-10-25T00:00:00.000Z', plan = { schemaVersion: 3, platform: { name: 'TransportX Agent', version: '3.23.2' }, profile: defaultSessionProfile(), domain: { id: 'com.transportx.workbench', version: '1.4.1' }, modules: [], assets: [], runtime: {}, workspace: directory, createdAt: at };
    const first = `conv_${crypto.randomUUID()}`, second = `conv_${crypto.randomUUID()}`;
    const records: any[] = [];
    for (const [id, key] of [[first, 'first.jsonl'], [second, 'second.jsonl']]) {
      fs.writeFileSync(path.join(sessions, key), JSON.stringify({ type: 'session', id: `native-${id}`, cwd: directory, timestamp: at }) + '\n');
      await store.savePlan(directory, id, plan);
      records.push({ id, creationRequestId: null, creationInputSha256: null, name: id, createdAt: at, updatedAt: at, defaultsRevision: null, modelSpec: null, appendSystemPrompt: '', state: 'ready', history: { key, headerId: `native-${id}` }, plan: { path: `conversations/${id}/plan.json`, source: 'legacy-workspace' }, privateState: 'isolated', lastStartFailure: null, deletion: null });
    }
    await store.publishWorkspace(reserved.workspaceId, { schemaVersion: 1, id: reserved.workspaceId, revision: 0, name: 'Delete', createdAt: at, updatedAt: at, defaultsRevision: 0, defaults: { domainId: null, profile: null, modelSpec: null }, citationRegistryId: reserved.workspaceId, conversations: records });
    const { WorkspaceMigration } = require('../../bin/workspace-migration.js'), { acquireWriteLease } = require('../../bin/util/json-storage.js');
    const agent = path.join(root, 'agent'); fs.mkdirSync(agent); const releaseWriter = acquireWriteLease(path.join(agent, 'host')); t.after(releaseWriter);
    const migration = new WorkspaceMigration(store, { agentDir: agent, workspaceRoots: [scenario] }); await migration.initialize();
    const firstFile = path.join(sessions, 'first.jsonl'), secondFile = path.join(sessions, 'second.jsonl'), business = path.join(directory, 'shared.txt'); fs.writeFileSync(business, 'shared result');
    const invocationRoots = [path.join(root, 'executions/cad'), path.join(root, 'executions/spatial')];
    for (const record of records) for (const invocations of invocationRoots) {
      const owner = executionOwner({ cwd: directory, sessionFile: path.join(sessions, record.history.key), resolvedSessionPlan: plan }, sessions), scoped = path.join(invocations, executionOwnerKey(owner));
      fs.mkdirSync(scoped, { recursive: true }); fs.writeFileSync(path.join(scoped, 'owned.json'), JSON.stringify({ owner }));
    }
    const python = process.env.TAU_PYTHON_COMMAND || 'python3', gate = new WorkspaceRuntimeGate(python, path.join(root, 'logs'), path.join(root, 'coordination'));
    const runtime = new ConversationRuntime({ store, sessions: new LiveSessionManager(), gate, assertReady: () => {}, verifyPlan: (value: any) => value });
    let cleanupCount = 0;
    const options = { store, gate, runtime, pythonCommand: python, assertReady: () => {}, assertSystemReady: () => {}, historyDirectories: () => [sessions], verifyWorkspace: resolveSessionWorkspaceForDeletion, removeWorkspace: removeSessionWorkingDirectory, cleanupInvocations: async (context: any) => { cleanupCount++; assert.ok(fs.existsSync(context.sessionFile)); assert.ok(fs.existsSync(path.join(directory, `.tau/conversations/${context.sessionFile === firstFile ? first : second}/plan.json`))); await removeExecutionMetadata(invocationRoots, context, sessions); } };
    const deletion = new WorkspaceDeletion(options); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const request = { requestId: 'delete-first', expectedRevision: 0, confirm: true };
    const rename = fs.renameSync; let stageFailed = false;
    fs.renameSync = (from: string, to: string) => { if (!stageFailed && to === path.join(directory, '.tau/workspace.json') && JSON.parse(fs.readFileSync(from)).conversations[0].deletion?.stage === 'invocations-cleaned') { stageFailed = true; throw Object.assign(new Error('invocation stage commit full'), { code: 'ENOSPC' }); } return rename(from, to); };
    try { await assert.rejects(deletion.conversation(first, request), { code: 'ENOSPC' }); } finally { fs.renameSync = rename; }
    assert.ok(fs.existsSync(firstFile)); assert.equal(store.findConversation(first).conversation.deletion.stage, 'frozen'); assert.equal(store.findConversation(first).conversation.deletion.error.code, 'ENOSPC');
    let historyFailed = false;
    fs.renameSync = (from: string, to: string) => { if (!historyFailed && to === path.join(directory, '.tau/workspace.json') && JSON.parse(fs.readFileSync(from)).conversations[0].deletion?.stage === 'history-cleaned') { historyFailed = true; throw Object.assign(new Error('history stage commit full'), { code: 'ENOSPC' }); } return rename(from, to); };
    try { await assert.rejects(deletion.conversation(first, request), { code: 'ENOSPC' }); } finally { fs.renameSync = rename; }
    assert.equal(fs.existsSync(firstFile), false); assert.equal(store.findConversation(first).conversation.deletion.stage, 'invocations-cleaned'); assert.ok(fs.existsSync(path.join(directory, `.tau/conversations/${first}/plan.json`)));
    const cleanedOwners = cleanupCount, completed = await new WorkspaceDeletion(options).conversation(first, request); assert.equal(completed.state, 'deleted'); assert.equal(cleanupCount, cleanedOwners, 'retry does not request Owner after its dependency was removed');
    assert.equal(fs.existsSync(path.join(directory, `.tau/conversations/${first}`)), false); assert.ok(fs.existsSync(secondFile)); assert.equal(fs.readFileSync(business, 'utf8'), 'shared result');
    assert.equal((await deletion.conversation(first, request)).state, 'deleted');
    const workspaceRequest = { requestId: 'delete-workspace', expectedRevision: store.readWorkspace(reserved.workspaceId).manifest.revision, confirm: true };
    let workspaceStageFailed = false;
    fs.renameSync = (from: string, to: string) => { if (!workspaceStageFailed && to === store.catalogFile && JSON.parse(fs.readFileSync(from)).entries[0].deletion?.stage === 'history-cleaned') { workspaceStageFailed = true; throw Object.assign(new Error('workspace history stage full'), { code: 'ENOSPC' }); } return rename(from, to); };
    try { await assert.rejects(deletion.workspace(reserved.workspaceId, workspaceRequest), { code: 'ENOSPC' }); } finally { fs.renameSync = rename; }
    assert.equal(fs.existsSync(secondFile), false); assert.ok(fs.existsSync(directory)); assert.equal(store.readCatalog().entries[0].deletion.stage, 'invocations-cleaned');
    await migration.initialize(); assert.equal(migration.status().dataState, 'ready'); assert.equal(migration.read().items.length, 0, 'a valid in-progress deletion is not reclassified as a failed migration source');
    const savedCleanup = cleanupCount; let removalFailed = false;
    options.removeWorkspace = async (target: string) => { fs.unlinkSync(path.join(target, '.tau/workspace.json')); removalFailed = true; throw Object.assign(new Error('locked business file'), { code: 'EBUSY' }); };
    await assert.rejects(deletion.workspace(reserved.workspaceId, workspaceRequest), { code: 'EBUSY' }); assert.equal(removalFailed, true); assert.equal(store.readCatalog().entries[0].deletion.stage, 'history-cleaned');
    options.removeWorkspace = async (target: string) => {
      await removeSessionWorkingDirectory(target);
      const recreated = target; fs.mkdirSync(recreated);
      try {
        const { spawnSync } = require('node:child_process');
        const observer = spawnSync(process.execPath, ['-e', "const {WorkspaceRuntimeGate}=require(process.argv[1]+'/bin/workspace-runtime.js');const gate=new WorkspaceRuntimeGate(process.argv[6],process.argv[2],process.argv[2]);try{const lease=gate.take(process.argv[3],process.argv[4],process.argv[5]);lease.finish();process.stdout.write('allowed');}catch(e){process.stdout.write(e.code||e.message);}", process.cwd(), path.join(root, 'coordination'), recreated, reserved.workspaceId, second, python], { encoding: 'utf8' });
        assert.equal(observer.status, 0, observer.stderr); assert.equal(observer.stdout, 'workspace_busy', 'another Host cannot acquire the deleted directory before catalog completion');
      } finally { fs.rmSync(recreated, { recursive: true, force: true }); }
    };
    let finalCommitFailed = false;
    fs.renameSync = (from: string, to: string) => { if (!finalCommitFailed && to === store.catalogFile && JSON.parse(fs.readFileSync(from)).entries[0].deletion?.stage === 'workspace-cleaned') { finalCommitFailed = true; throw Object.assign(new Error('final stage full'), { code: 'ENOSPC' }); } return rename(from, to); };
    try { await assert.rejects(new WorkspaceDeletion(options).workspace(reserved.workspaceId, workspaceRequest), { code: 'ENOSPC' }); } finally { fs.renameSync = rename; }
    assert.equal(fs.existsSync(directory), false); assert.equal(store.readCatalog().entries[0].deletion.stage, 'history-cleaned');
    const finishingDeletion = new WorkspaceDeletion(options), runtimeFile = path.join(root, 'coordination', fs.readdirSync(path.join(root, 'coordination')).find((name: string) => /^[a-f0-9]{64}\.json$/.test(name)));
    fs.renameSync = (from: string, to: string) => { if (to === runtimeFile && JSON.parse(fs.readFileSync(from)).phase === 'stopped') throw Object.assign(new Error('runtime finalization full'), { code: 'ENOSPC' }); return rename(from, to); };
    try { await assert.rejects(finishingDeletion.workspace(reserved.workspaceId, workspaceRequest), { code: 'ENOSPC' }); } finally { fs.renameSync = rename; }
    assert.equal(store.readCatalog().entries[0].state, 'deleted');
    assert.equal((await finishingDeletion.workspace(reserved.workspaceId, workspaceRequest)).state, 'deleted', 'the recorded request can finish its retained runtime lease after logical deletion'); assert.equal(cleanupCount, savedCleanup);
    await migration.initialize(); assert.equal(migration.read().items.length, 0); assert.deepEqual(store.readCatalog().entries[0].deletion.conversationIds, [first, second]);
    assert.equal(gate.diagnostics(directory).phase, 'stopped', 'runtime coordination remains available after the workspace is removed');
  }

});
