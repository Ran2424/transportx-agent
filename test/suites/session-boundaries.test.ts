const { test } = require('node:test') as typeof import('node:test');

test('Session close, history deletion and process cancellation preserve writer ownership', async (t) => {
  const { toPosixPath } = require('../../bin/util/path.js');
  // Legacy conversion preserves Native bytes, stops at unowned processes and resumes verified writes.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { spawn } = require('node:child_process'), { once } = require('node:events');
    const { WorkspaceStore } = require('../../bin/workspace-store.js'), { WorkspaceMigration } = require('../../bin/workspace-migration.js');
    const { WorkspaceRuntimeGate } = require('../../bin/workspace-runtime.js'), { WorkspaceMigrationRunner } = require('../../bin/workspace-migration-runner.js');
    const { acquireWriteLease } = require('../../bin/util/json-storage.js'), { defaultSessionProfile } = require('../../bin/contracts/session-profile.js');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tau-conversion-中文 空格-')));
    const userData = path.join(root, 'data'), agentDir = path.join(root, 'agent'), scenario = path.join(root, 'scenario'), sessions = path.join(root, 'sessions');
    fs.mkdirSync(agentDir); fs.mkdirSync(scenario); fs.mkdirSync(sessions);
    const release = acquireWriteLease(path.join(agentDir, 'host'));
    t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
    const write = (directory: string, relative: string, value: unknown) => { const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); return file; };
    const at = '2026-10-25T00:00:00.000Z';
    const single = path.join(scenario, 'single'), ambiguous = path.join(scenario, 'ambiguous'), corrupt = path.join(scenario, 'corrupt'), empty = path.join(scenario, 'empty'), repairing = path.join(scenario, 'repairing');
    for (const directory of [single, ambiguous, corrupt, empty, repairing]) {
      fs.mkdirSync(directory);
      write(directory, '.tau/resolved-session-plan.v3.json', { schemaVersion: 3, platform: { name: 'TransportX Agent', version: '3.23.2' }, profile: defaultSessionProfile(), domain: { id: 'com.transportx.workbench', version: '1.4.1' }, modules: [], assets: [], runtime: {}, workspace: directory, createdAt: at });
    }
    const unavailablePlan = JSON.parse(fs.readFileSync(path.join(empty, '.tau/resolved-session-plan.v3.json'))); unavailablePlan.workspace = path.join(root, 'missing-old-location');
    write(empty, '.tau/resolved-session-plan.v3.json', unavailablePlan); write(empty, '.tau/workspace-owner.json', { version: 1, workspace: empty, parent: scenario });
    const canvas = { protocol: 'pi-canvas-context', version: '1.0', contextId: 'canvas_context_abcdefghijkl', adapterId: 'fixture', viewId: 'view', revision: 1, resources: [], createdAt: at };
    const attachment = { id: 'att_abcdefghijkl', relativePath: 'attachments/original.txt', sha256: 'a'.repeat(64) };
    const attachmentIndex = write(single, '.tau/attachments.json', { version: 1, attachments: [attachment], messageRefs: [{ text: '同一问题', timestamp: 1000, attachmentIds: [attachment.id] }] });
    write(single, '.tau/canvas-contexts.json', [canvas]);
    const geoId = `geoctx_${'a'.repeat(16)}`, requestId = `georeq_${'b'.repeat(16)}`;
    write(single, `.tau/geo-interactions/contexts/${geoId}/context.json`, { version: 1, contextId: geoId, visualizationId: 'traffic_map', sceneRevision: 2, mode: 'viewport', createdAt: at, view: { center: [121.45, 31.2], zoom: 12, bounds: [121.4, 31.1, 121.5, 31.3], bearing: 0, pitch: 0 }, visibleLayerIds: ['roads'], summary: '历史视野' });
    const requestFile = write(single, `.tau/geo-interactions/requests/${requestId}/request.json`, { version: 1, requestId, sessionId: 'expired-live-instance', visualizationId: 'traffic_map', sceneRevision: 2, mode: 'viewport', prompt: '确认视野', required: false, timeoutSeconds: 600, status: 'waiting', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:10:00.000Z' });
    write(single, '.tau/timing-metrics.v1.json', { schemaVersion: 1, updatedAt: at, records: { 'tool:same-id': { kind: 'tool', sourceId: 'same-id', startedAt: 1000, endedAt: 1100, durationMs: 100 } } });
    write(ambiguous, '.tau/attachments.json', { version: 1, attachments: [attachment], messageRefs: [{ text: '同一问题', timestamp: 1000, attachmentIds: [attachment.id] }] });
    write(ambiguous, '.tau/timing-metrics.v1.json', { schemaVersion: 1, updatedAt: at, records: { 'tool:same-id': { kind: 'tool', sourceId: 'same-id', startedAt: 1000, endedAt: 1100, durationMs: 100 } } });
    const badIndex = write(corrupt, '.tau/canvas-contexts.json', {}), nativeFiles: string[] = [];
    write(repairing, '.tau/attachments.json', { version: 1, attachments: [attachment], messageRefs: [{ text: '同一问题', timestamp: 1000, attachmentIds: [attachment.id] }] });
    for (const [key, directory] of [['single', single], ['ambiguous-a', ambiguous], ['ambiguous-b', ambiguous], ['corrupt', corrupt], ['repairing', repairing]]) {
      const rows = [{ type: 'session', version: 3, id: `native-${key}`, cwd: directory, timestamp: at }, { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: '同一问题', timestamp: 1000, attachmentIds: [attachment.id] } }, { type: 'message', id: 'm2', parentId: 'm1', message: { role: 'assistant', timestamp: 1000, content: [{ type: 'toolCall', id: 'same-id', name: 'read', arguments: { path: key } }] } }, { type: 'message', id: 'm3', parentId: 'm2', message: { role: 'toolResult', toolCallId: 'same-id', toolName: 'read', timestamp: 1100, content: [{ type: 'text', text: key }] } }];
      const file = path.join(sessions, `${key}.jsonl`); fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n'); nativeFiles.push(file);
    }
    const nativeBytes = nativeFiles.map((file) => fs.readFileSync(file)), oldIndex = fs.readFileSync(attachmentIndex), badBytes = fs.readFileSync(badIndex);
    const resource = path.join(single, '.tau/video-resources/large.bin'); fs.mkdirSync(path.dirname(resource)); fs.closeSync(fs.openSync(resource, 'w')); fs.truncateSync(resource, 32 * 1024 * 1024); const resourceStat = fs.statSync(resource);
    const store = new WorkspaceStore(userData, sessions); await store.initializeCatalog({ schemaVersion: 1, revision: 0, entries: [] });
    const migration = new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] }); await migration.initialize();
    const items = migration.read().items, a = items.find((item: any) => item.path === toPosixPath(single)), b = items.find((item: any) => item.path === toPosixPath(ambiguous)), c = items.find((item: any) => item.path === toPosixPath(corrupt)), d = items.find((item: any) => item.path === toPosixPath(empty)), e = items.find((item: any) => item.path === toPosixPath(repairing));
    const python = process.env.TAU_PYTHON_COMMAND || 'python3', gate = new WorkspaceRuntimeGate(python, path.join(root, 'logs'), path.join(root, 'coordination')), runner = new WorkspaceMigrationRunner(migration, gate, python);
    assert.equal((await runner.convert(d.id)).state, 'ready'); assert.equal(store.readWorkspace(d.workspaceId).manifest.conversations.length, 0, 'managed zero-history directory becomes a workspace without an invented conversation');
    assert.ok(JSON.parse(fs.readFileSync(migration.read().items.find((item: any) => item.id === d.id).report)).notes.some((note: any) => note.code === 'invalid_session_plan'), 'unavailable old plan location is diagnosed without substituting the current configuration');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: single, stdio: 'ignore' });
    t.after(() => { if (child.exitCode === null) child.kill(); }); await once(child, 'spawn');
    await assert.rejects(runner.convert(a.id), { code: 'process_stop_unconfirmed' });
    assert.equal(child.exitCode, null, 'cwd discovery grants no authority to kill an unrecorded process'); assert.deepEqual(fs.readFileSync(attachmentIndex), oldIndex);
    const exited = once(child, 'exit'); child.kill(); await exited;
    const rename = fs.renameSync; let interrupted = false;
    fs.renameSync = (from: string, to: string) => { const normalized = toPosixPath(to); if (!interrupted && normalized.includes('/conversations/') && normalized.endsWith('/canvas-contexts.json')) { interrupted = true; throw Object.assign(new Error('target volume full'), { code: 'ENOSPC' }); } return rename(from, to); };
    try { await assert.rejects(runner.convert(a.id), { code: 'ENOSPC' }); } finally { fs.renameSync = rename; }
    assert.equal(migration.read().items.find((item: any) => item.id === a.id).stage, 'backed-up'); migration.assertWorkspaceReady(d.workspaceId);
    assert.deepEqual(fs.readFileSync(path.join(single, '.tau/migrations/workspace-v1/backups/.tau/attachments.json')), oldIndex);
    const frozen = migration.read().items.find((item: any) => item.id === a.id), journal = JSON.parse(fs.readFileSync(frozen.report));
    const staged = path.join(single, journal.writes.find((write: any) => write.relative.endsWith('/canvas-contexts.json')).staged), stagedBytes = fs.readFileSync(staged);
    fs.appendFileSync(staged, ' '); await assert.rejects(runner.convert(a.id), { code: 'metadata_corrupt' }); fs.writeFileSync(staged, stagedBytes);
    const publish = store.publishWorkspace.bind(store);
    store.publishWorkspace = async (...args: any[]) => {
      fs.renameSync = (from: string, to: string) => { if (to === store.catalogFile) throw Object.assign(new Error('catalog volume full after Manifest commit'), { code: 'ENOSPC' }); return rename(from, to); };
      try { return await publish(...args); } finally { fs.renameSync = rename; }
    };
    try { await assert.rejects(runner.convert(a.id), { code: 'ENOSPC' }); } finally { store.publishWorkspace = publish; }
    assert.equal(fs.existsSync(path.join(single, '.tau/workspace.json')), true); assert.equal(store.readCatalog().entries.find((entry: any) => entry.workspaceId === a.workspaceId).state, 'creating');
    await migration.initialize(); migration.assertWorkspaceReady(d.workspaceId);
    const updateItem = migration.updateItem.bind(migration); let heldAtCommit = false;
    migration.updateItem = (id: string, update: any) => updateItem(id, (current: any, state: any) => { update(current, state); if (id === a.id && current.stage === 'published') { assert.throws(() => gate.takeMaintenance(single, a.workspaceId), { code: 'workspace_busy' }); heldAtCommit = true; } });
    const resumedRunner = new WorkspaceMigrationRunner(migration, gate, python);
    try { assert.equal((await resumedRunner.convert(a.id)).state, 'ready'); } finally { migration.updateItem = updateItem; }
    assert.equal(heldAtCommit, true, 'runtime mutex remains held through the final global publication');
    const migrated = store.readWorkspace(a.workspaceId).manifest, conversation = migrated.conversations[0], privateRoot = path.join(single, '.tau/conversations', conversation.id);
    assert.equal(conversation.id, a.histories[0].conversationId); assert.equal(conversation.history.headerId, 'native-single'); assert.equal(conversation.plan.source, 'legacy-workspace');
    assert.equal(JSON.parse(fs.readFileSync(path.join(privateRoot, 'attachment-message-refs.json'))).refs.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(privateRoot, 'canvas-contexts.json'))).contexts.length, 1);
    assert.equal(JSON.parse(fs.readFileSync(attachmentIndex)).messageRefs, undefined); assert.equal(JSON.parse(fs.readFileSync(attachmentIndex)).attachments[0].sourceConversationId, null);
    assert.equal(JSON.parse(fs.readFileSync(path.join(privateRoot, `geo-interactions/contexts/${geoId}/context.json`))).contextId, geoId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(privateRoot, `geo-interactions/requests/${requestId}/response.json`))).status, 'expired'); assert.equal(JSON.parse(fs.readFileSync(requestFile)).status, 'waiting', 'migration closes old requests only in the new private scope');
    const ledger = fs.readFileSync(path.join(single, '.tau/migrations/workspace-v1/backup-manifest.json'), 'utf8'); assert.equal(ledger.includes('video-resources'), false); assert.equal(fs.statSync(resource).size, resourceStat.size); assert.equal(fs.statSync(resource).mtimeMs, resourceStat.mtimeMs);
    const review = await runner.convert(b.id); assert.equal(review.state, 'needs-review'); migration.assertWorkspaceReady(a.workspaceId); assert.equal(fs.existsSync(path.join(ambiguous, '.tau/workspace.json')), false);
    const report = JSON.parse(fs.readFileSync(review.report)), issue = report.issues[0]; assert.equal(report.issues.length, 2); assert.equal(issue.candidates.length, 2, 'same text, tool ID and time range cannot disambiguate histories with different arguments/results'); assert.equal(report.writes.some((write: any) => 'value' in write), false);
    const reportBytes = fs.readFileSync(review.report); fs.appendFileSync(review.report, ' '); await assert.rejects(runner.convert(b.id), { code: 'metadata_corrupt' }); assert.deepEqual(fs.readFileSync(review.report), Buffer.concat([reportBytes, Buffer.from(' ')]), 'unknown report bytes are preserved'); fs.writeFileSync(review.report, reportBytes);
    const changedFile = path.join(ambiguous, '.tau/timing-metrics.v1.json'), beforeChange = fs.readFileSync(changedFile); fs.appendFileSync(changedFile, ' ');
    await assert.rejects(runner.resolvePrivate(b.id, { requestId: 'stale-source', expectedRevision: review.revision, reportDigest: review.sourceDigest, action: 'isolate', sourceId: issue.sourceId, conversationId: null }), { code: 'migration_source_changed' }); fs.writeFileSync(changedFile, beforeChange);
    await assert.rejects(runner.resolvePrivate(b.id, { requestId: 'bad-bind', expectedRevision: review.revision, reportDigest: review.sourceDigest, action: 'bind', sourceId: issue.sourceId, conversationId: issue.candidates[0] }), { code: 'private_state_ambiguous' });
    let resolved = review; let firstInput: any;
    for (const issue of report.issues) {
      const input = { requestId: `isolate-${issue.sourceId}`, expectedRevision: resolved.revision, reportDigest: resolved.sourceDigest, action: 'isolate', sourceId: issue.sourceId, conversationId: null };
      firstInput ||= input; resolved = await runner.resolvePrivate(b.id, input);
    }
    assert.equal(resolved.state, 'ready'); assert.equal((await runner.resolvePrivate(b.id, firstInput)).state, 'ready', 'retry deduplication precedes stale expectedRevision');
    const firstId = b.histories[0].conversationId; assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ambiguous, '.tau/conversations', firstId, 'attachment-message-refs.json'))).refs, []);
    await assert.rejects(runner.convert(c.id), { code: 'metadata_corrupt' }); migration.assertWorkspaceReady(a.workspaceId); assert.deepEqual(fs.readFileSync(badIndex), badBytes);
    const sourceReport = await runner.report(c.id), isolate = { requestId: 'whole-source-isolate', expectedRevision: sourceReport.item.revision, reportDigest: sourceReport.reportDigest, action: 'isolate' };
    const isolated = await runner.resolveSource(c.id, isolate); assert.equal(isolated.state, 'isolated'); assert.deepEqual(fs.readFileSync(badIndex), badBytes);
    write(corrupt, '.tau/canvas-contexts.json', []); await migration.initialize(); assert.equal(migration.read().items.find((item: any) => item.id === c.id).state, 'isolated', 'rescan cannot silently undo isolation after a source is repaired');
    assert.equal((await runner.resolveSource(c.id, isolate)).revision, isolated.revision, 'whole-source retries deduplicate before stale revision checks');
    const repairedReport = await runner.report(c.id);
    await assert.rejects(runner.resolveSource(c.id, { requestId: 'stale-whole-source', expectedRevision: repairedReport.item.revision, reportDigest: sourceReport.reportDigest, action: 'retry' }), { code: 'workspace_revision_conflict' });
    assert.equal((await runner.resolveSource(c.id, { requestId: 'retry-repaired-source', expectedRevision: repairedReport.item.revision, reportDigest: repairedReport.reportDigest, action: 'retry' })).state, 'ready');
    let failedRepair = false;
    fs.renameSync = (from: string, to: string) => { const normalized = toPosixPath(to); if (!failedRepair && normalized.startsWith(toPosixPath(path.join(repairing, '.tau/conversations'))) && normalized.endsWith('/plan.json')) { failedRepair = true; throw Object.assign(new Error('repair fixture interruption'), { code: 'ENOSPC' }); } return rename(from, to); };
    try { await assert.rejects(runner.convert(e.id), { code: 'ENOSPC' }); } finally { fs.renameSync = rename; }
    const originalRepair = migration.read().items.find((item: any) => item.id === e.id), repairNative = path.join(sessions, 'repairing.jsonl');
    fs.appendFileSync(repairNative, JSON.stringify({ type: 'message', id: 'm4', parentId: 'm3', message: { role: 'user', content: '新增的真实源消息', timestamp: 1200 } }) + '\n'); nativeBytes[4] = fs.readFileSync(repairNative);
    await assert.rejects(runner.convert(e.id), { code: 'migration_source_changed' });
    const unknown = path.join(repairing, '.tau/conversations', e.histories[0].conversationId, 'notes.txt'); fs.writeFileSync(unknown, 'Do not overwrite unrecognized private data');
    const repairReport = await runner.report(e.id), reprepare = { requestId: 'reprepare-source', expectedRevision: repairReport.item.revision, reportDigest: repairReport.reportDigest, action: 'reprepare' };
    const sharedBeforeRepair = fs.readFileSync(path.join(repairing, '.tau/attachments.json'));
    await assert.rejects(runner.resolveSource(e.id, reprepare), { code: 'migration_target_exists' }); assert.deepEqual(fs.readFileSync(path.join(repairing, '.tau/attachments.json')), sharedBeforeRepair); fs.unlinkSync(unknown);
    let repairCommitFailed = false;
    fs.renameSync = (from: string, to: string) => { if (to === migration.stateFile && !repairCommitFailed && JSON.parse(fs.readFileSync(from)).items.some((item: any) => item.id === e.id && item.stage === 'inventory' && item.preparedDigest === null)) { repairCommitFailed = true; throw Object.assign(new Error('repair stage commit full'), { code: 'ENOSPC' }); } return rename(from, to); };
    try { await assert.rejects(runner.resolveSource(e.id, reprepare), { code: 'ENOSPC' }); } finally { fs.renameSync = rename; }
    assert.equal(migration.status().dataState, 'blocked'); await migration.initialize();
    assert.equal((await new WorkspaceMigrationRunner(migration, gate, python).resolveSource(e.id, reprepare)).state, 'ready');
    assert.equal(store.readWorkspace(e.workspaceId).manifest.conversations[0].id, e.histories[0].conversationId); assert.equal(fs.existsSync(`${originalRepair.report}.${originalRepair.preparedDigest}.archived`), true, 'old verified conversion report survives reprepare');
    migration.assertWorkspaceReady(a.workspaceId); migration.assertWorkspaceReady(d.workspaceId);
    for (const [index, file] of nativeFiles.entries()) assert.deepEqual(fs.readFileSync(file), nativeBytes[index], 'conversion never rewrites Native JSONL');
    const uncertain = path.join(scenario, 'uncertain-single'); fs.mkdirSync(uncertain);
    write(uncertain, '.tau/workspace-owner.json', { version: 1, workspace: uncertain, parent: scenario }); write(uncertain, '.tau/canvas-contexts.json', [canvas]);
    const uncertainHistory = path.join(sessions, 'uncertain.jsonl'), opaque = path.join(sessions, 'opaque.jsonl');
    fs.writeFileSync(uncertainHistory, JSON.stringify({ type: 'session', id: 'native-uncertain', cwd: uncertain, timestamp: at }) + '\n'); fs.writeFileSync(opaque, 'broken unscoped history\n');
    await migration.initialize(); const uncertainItem = migration.read().items.find((item: any) => item.path === toPosixPath(uncertain));
    const unproven = await runner.convert(uncertainItem.id); assert.equal(unproven.state, 'needs-review', 'an unscoped damaged history prevents inferring sole ownership from a count of one readable history');
    const unprovenReport = JSON.parse(fs.readFileSync(unproven.report)); assert.equal(unprovenReport.singleHistoryProven, false); assert.equal(unprovenReport.issues.length, 1); migration.assertWorkspaceReady(a.workspaceId);
    const opaqueItem = migration.read().items.find((item: any) => item.path === toPosixPath(opaque)), opaqueReport = await runner.report(opaqueItem.id);
    await runner.resolveSource(opaqueItem.id, { requestId: 'isolate-opaque', expectedRevision: opaqueItem.revision, reportDigest: opaqueReport.reportDigest, action: 'isolate' }); await migration.initialize();
    assert.equal((await runner.convert(uncertainItem.id)).state, 'needs-review', 'isolating an unknown history never grants ownership of private state');
    assert.equal((await runner.resolvePrivate(uncertainItem.id, { requestId: 'isolate-unproven-canvas', expectedRevision: unproven.revision, reportDigest: unproven.sourceDigest, action: 'isolate', sourceId: unprovenReport.issues[0].sourceId, conversationId: null })).state, 'ready');
    assert.equal(fs.readFileSync(opaque, 'utf8'), 'broken unscoped history\n');
    assert.equal(migration.status().dataState, 'ready'); assert.equal(gate.diagnostics(single).phase, 'stopped');
    t.diagnostic('Migration fixtures verify old-source conversion on this host; they do not replace real Pi or Windows/Linux acceptance.');
  }
  // A committed global inventory protects unknown sources without making every workspace unavailable.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { WorkspaceStore, workspaceCreationDigest } = require('../../bin/workspace-store.js');
    const { WorkspaceMigration } = require('../../bin/workspace-migration.js');
    const { parseWorkspaceMigrationStructured } = require('../../bin/contracts/index.js');
    const { acquireWriteLease } = require('../../bin/util/json-storage.js');
    const { migrationSpaceRequirements, assertMigrationSpace } = require('../../bin/workspace-migration-space.js');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tau-migration-inventory-')));
    const userData = path.join(root, 'data'), agentDir = path.join(root, 'agent'), scenario = path.join(root, 'scenario'), sessions = path.join(root, 'sessions');
    fs.mkdirSync(agentDir); fs.mkdirSync(scenario); fs.mkdirSync(sessions);
    const release = acquireWriteLease(path.join(agentDir, 'host'));
    t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
    const store = new WorkspaceStore(userData, sessions);
    await store.initializeCatalog({ schemaVersion: 1, revision: 0, entries: [] });
    const readyIds: string[] = [];
    for (let index = 0; index < 29; index++) {
      const directory = path.join(scenario, `registered-${index}`); fs.mkdirSync(directory);
      const reserved = await store.reserveWorkspace(`fixture-${index}`, workspaceCreationDigest(index), () => directory);
      await store.publishWorkspace(reserved.workspaceId, { schemaVersion: 1, id: reserved.workspaceId, revision: 0, name: `Healthy ${index}`, createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z', defaultsRevision: 0, defaults: { domainId: null, profile: null, modelSpec: null }, citationRegistryId: reserved.workspaceId, conversations: [] });
      readyIds.push(reserved.workspaceId);
    }
    const legacy = path.join(scenario, 'legacy-no-history'), broken = path.join(sessions, 'broken.jsonl'); fs.mkdirSync(legacy);
    fs.writeFileSync(broken, 'not a session header\n');
    const healthyHistory = path.join(sessions, 'empty.jsonl');
    fs.writeFileSync(healthyHistory, JSON.stringify({ type: 'session', id: 'native-empty', cwd: legacy }) + '\n');
    const largeHistory = path.join(sessions, 'large-body.jsonl');
    fs.writeFileSync(largeHistory, JSON.stringify({ type: 'session', id: 'native-empty', cwd: legacy }) + '\n');
    fs.truncateSync(largeHistory, 32 * 1024 * 1024);
    const largeVersion = fs.statSync(largeHistory);
    const nativeBytes = fs.readFileSync(healthyHistory), brokenBytes = fs.readFileSync(broken);
    fs.mkdirSync(path.join(legacy, '.tau')); fs.writeFileSync(path.join(legacy, '.tau/attachments.json'), 'corrupt old private index');
    const migration = new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] });
    assert.equal(migration.status().dataState, 'initializing');
    const pending = migration.initialize(); assert.equal(migration.initialize(), pending, 'duplicate inventory joins the same Writer');
    const competitor = new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] });
    await assert.rejects(competitor.initialize(), { code: 'writer_busy' });
    const inventoried = await pending;
    assert.equal(inventoried.systemReadiness, 'ready'); assert.equal(inventoried.phase, 'needs-attention');
    assert.ok(migration.status().blocked > 0); assert.ok(migration.status().pending > 0);
    for (const id of readyIds) migration.assertWorkspaceReady(id);
    const item = inventoried.items.find((value: any) => value.path === toPosixPath(legacy));
    assert.equal(item.histories.length, 2); assert.ok(item.histories.every((history: any) => history.headerId === 'native-empty'));
    assert.notEqual(item.histories[0].conversationId, item.histories[1].conversationId, 'repeated native header IDs do not merge different source files');
    assert.throws(() => migration.assertWorkspaceReady(item.workspaceId), { code: 'workspace_migration_required' });
    assert.throws(() => migration.assertAllocationAllowed(path.join(legacy, 'nested-task')), { code: 'workspace_migration_required' });
    migration.assertAllocationAllowed(path.join(scenario, 'new-independent-task'));
    const reloaded = await new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] }).initialize();
    const resumed = reloaded.items.find((value: any) => value.id === item.id);
    assert.equal(resumed.workspaceId, item.workspaceId); assert.equal(resumed.histories.find((history: any) => history.key === 'empty.jsonl').conversationId, item.histories.find((history: any) => history.key === 'empty.jsonl').conversationId);
    assert.deepEqual(fs.readFileSync(healthyHistory), nativeBytes); assert.deepEqual(fs.readFileSync(broken), brokenBytes);
    assert.equal(fs.existsSync(path.join(legacy, '.tau/workspace.json')), false, 'global inventory does not publish an unconverted workspace');
    assert.equal(fs.readFileSync(path.join(legacy, '.tau/attachments.json'), 'utf8'), 'corrupt old private index', 'legacy private bytes are not parsed or rewritten by global inventory');
    assert.equal(fs.statSync(largeHistory).size, largeVersion.size); assert.equal(fs.statSync(largeHistory).mtimeMs, largeVersion.mtimeMs, 'large malformed bodies stay untouched for target-stage validation');
    assert.equal(fs.readFileSync(migration.reportFile, 'utf8').includes('not a session header'), false, 'header errors do not copy raw source text into the report');
    const moved = path.join(root, 'moved-legacy'); fs.renameSync(legacy, moved); fs.symlinkSync(path.join(scenario, 'registered-1'), legacy, 'junction');
    assert.throws(() => migration.assertWorkspaceReady(readyIds[1]), { code: 'workspace_migration_required' }, 'a changed path alias is rechecked against its current canonical target');
    migration.assertWorkspaceReady(readyIds[2]); fs.unlinkSync(legacy); fs.renameSync(moved, legacy);
    const duplicate = structuredClone(reloaded); duplicate.items.push(structuredClone(duplicate.items[0]));
    assert.equal(parseWorkspaceMigrationStructured(duplicate).ok, false);
    const volumes = migrationSpaceRequirements([{ path: userData, backupBytes: 100, newBytes: 200, atomicBytes: 300 }, { path: legacy, backupBytes: 400, newBytes: 500, atomicBytes: 600 }], (target: string) => ({ volume: target === userData ? 'catalog-volume' : 'workspace-volume', availableBytes: target === userData ? 32 * 1024 * 1024 : 1024 }));
    assert.equal(volumes.length, 2); assert.equal(volumes[0].requiredBytes, 16 * 1024 * 1024 + 600);
    const large = migrationSpaceRequirements([{ path: legacy, backupBytes: 0, newBytes: 256 * 1024 * 1024, atomicBytes: 0 }], () => ({ volume: 'large', availableBytes: 512 * 1024 * 1024 }));
    assert.equal(large[0].marginBytes, Math.ceil(256 * 1024 * 1024 * 0.1));
    assert.throws(() => assertMigrationSpace(volumes), { code: 'migration_space_insufficient' });
    assert.throws(() => migrationSpaceRequirements([{ path: legacy, backupBytes: 0, newBytes: 1, atomicBytes: 1 }], () => { throw new Error('volume unavailable'); }), { code: 'migration_space_unknown' });
    assertMigrationSpace(migrationSpaceRequirements([{ path: root, backupBytes: 0, newBytes: 1, atomicBytes: 1 }]));
    const rename = fs.renameSync;
    fs.renameSync = (source: string, target: string) => { if (target === migration.stateFile) throw Object.assign(new Error('inventory volume full'), { code: 'ENOSPC' }); return rename(source, target); };
    try { await assert.rejects(migration.initialize(), { code: 'ENOSPC' }); }
    finally { fs.renameSync = rename; }
    assert.equal(migration.status().dataState, 'blocked');
    const observer = new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] });
    assert.equal(observer.status().dataState, 'initializing', 'an old ready file cannot bypass an inventory write failure while its Writer remains held');
    assert.throws(() => observer.assertSystemReady(), { code: 'system_not_ready' });
    await migration.initialize();
    assert.equal(observer.status().dataState, 'ready', 'explicit retry verifies the held generation, commits inventory and releases its Writer');
    const nativeRoot = path.join(scenario, 'registered-0'), key = 'unbound-before-crash.jsonl';
    const current = store.readWorkspace(readyIds[0]);
    await store.editWorkspace(readyIds[0], current.manifest.revision, (manifest: any) => manifest.conversations.push({ id: 'conv_00000000-0000-4000-8000-000000000099', creationRequestId: null, creationInputSha256: null, name: 'Before crash', createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z', defaultsRevision: null, modelSpec: null, appendSystemPrompt: '', state: 'created', history: { key, headerId: null }, plan: null, privateState: 'isolated', lastStartFailure: null, deletion: null }));
    fs.writeFileSync(path.join(sessions, key), JSON.stringify({ type: 'session', id: 'written-before-bind', cwd: nativeRoot }) + '\n');
    const changedSessions = path.join(root, 'changed-sessions'); fs.mkdirSync(changedSessions);
    const changedStore = new WorkspaceStore(userData, changedSessions), changedScope = new WorkspaceMigration(changedStore, { agentDir, workspaceRoots: [scenario] });
    await changedScope.initialize();
    assert.throws(() => changedScope.assertWorkspaceReady(readyIds[0]), { code: 'workspace_migration_required' }, 'changing the sessions scope cannot recreate an unbound but persisted first turn as empty');
    changedScope.assertWorkspaceReady(readyIds[1]);
    migration.assertWorkspaceReady(readyIds[0]);
    const duplicateWorkspace = store.readWorkspace(readyIds[1]);
    await store.editWorkspace(readyIds[1], duplicateWorkspace.manifest.revision, (manifest: any) => manifest.conversations.push(structuredClone(store.readWorkspace(readyIds[0]).manifest.conversations[0])));
    const duplicateIndex = new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] });
    await assert.rejects(duplicateIndex.initialize(), { code: 'metadata_corrupt' });
    assert.equal(migration.status().dataState, 'blocked', 'a shared conversation-identity collision blocks all business');
    await store.editWorkspace(readyIds[1], duplicateWorkspace.manifest.revision + 1, (manifest: any) => { manifest.conversations = []; });
    await duplicateIndex.initialize();
    const deleted = store.readWorkspace(readyIds[28]), deletionKey = 'deleted-workspace.jsonl';
    fs.writeFileSync(path.join(sessions, deletionKey), JSON.stringify({ type: 'session', id: 'deleted-native', cwd: deleted.directory }) + '\n');
    const catalog = store.readCatalog();
    await store.editCatalog(catalog.revision, (value: any) => { const entry = value.entries.find((entry: any) => entry.workspaceId === readyIds[28]); entry.state = 'deleted'; entry.deletion = { requestId: 'deleted-fixture', manifestRevision: deleted.manifest.revision, historyKeys: [deletionKey], invocationOwnerKeys: [], conversationIds: [], rootIdentity: 'a'.repeat(64), error: null, stage: 'workspace-cleaned' }; });
    const tombstones = await migration.initialize();
    assert.equal(tombstones.items.some((item: any) => item.path === toPosixPath(deleted.directory) || item.histories.some((history: any) => history.key === deletionKey)), false, 'scope rescans never reimport a deleted workspace or its residual history');
    const catalogBytes = fs.readFileSync(store.catalogFile), badCatalog = JSON.parse(catalogBytes.toString());
    badCatalog.entries.find((entry: any) => entry.workspaceId === readyIds[28]).deletion.historyKeys.push(key);
    fs.writeFileSync(store.catalogFile, JSON.stringify(badCatalog));
    const badTombstone = new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] });
    await assert.rejects(badTombstone.initialize(), { code: 'metadata_corrupt' });
    assert.equal(migration.status().dataState, 'blocked', 'deletion targets cannot overlap another registered conversation');
    fs.writeFileSync(store.catalogFile, catalogBytes); await badTombstone.initialize();
    const unknownRoot = path.join(root, 'unknown-new-format'); fs.mkdirSync(path.join(unknownRoot, 'task/.tau'), { recursive: true });
    fs.writeFileSync(path.join(unknownRoot, 'task/.tau/workspace.json'), '{}');
    const missingCatalog = new WorkspaceStore(path.join(root, 'missing-catalog'), path.join(root, 'other-sessions'));
    const unsafeFirstInstall = new WorkspaceMigration(missingCatalog, { agentDir, workspaceRoots: [unknownRoot] });
    await assert.rejects(unsafeFirstInstall.initialize(), { code: 'metadata_corrupt' });
    await assert.rejects(unsafeFirstInstall.initialize(), { code: 'metadata_corrupt' });
    assert.equal(fs.existsSync(missingCatalog.catalogFile), false, 'new-format markers without a catalog do not become an empty first installation on retry');
    const stateBytes = fs.readFileSync(migration.stateFile);
    fs.writeFileSync(migration.stateFile, 'null');
    const corrupt = new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] });
    await assert.rejects(corrupt.initialize(), { code: 'metadata_corrupt' });
    assert.throws(() => corrupt.assertSystemReady(), { code: 'system_not_ready' });
    assert.equal(fs.readFileSync(migration.stateFile, 'utf8'), 'null');
    fs.writeFileSync(migration.stateFile, stateBytes);
    fs.rmSync(store.catalogFile);
    await assert.rejects(new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] }).initialize(), { code: 'metadata_corrupt' });
    assert.equal(fs.existsSync(store.catalogFile), false, 'a prior inventory never recreates a missing catalog from surviving histories');
  }
  // Pi history locations do not grant discovery authority over unrelated project directories.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
    const { WorkspaceStore } = require('../../bin/workspace-store.js'), { WorkspaceMigration } = require('../../bin/workspace-migration.js');
    const { WorkspaceHost } = require('../../bin/workspace-host.js'), { acquireWriteLease, writeJsonAtomic } = require('../../bin/util/json-storage.js');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tau-discovery-scope-'))), scenario = path.join(root, 'scenario'), agentDir = path.join(root, 'agent'), sessions = path.join(root, 'sessions');
    const local = path.join(scenario, 'owned'), external = path.join(root, 'other-pi-project'), prefix = path.join(root, 'scenario-unrelated'), explicit = path.join(root, 'explicit-application-workspace');
    for (const directory of [local, external, prefix, explicit, agentDir, sessions]) fs.mkdirSync(directory, { recursive: true });
    const release = acquireWriteLease(path.join(agentDir, 'host')); t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
    for (const [key, cwd] of [['local', local], ['external', external], ['prefix', prefix]]) fs.writeFileSync(path.join(sessions, `${key}.jsonl`), JSON.stringify({ type: 'session', id: key, cwd }) + '\n');
    const externalHistory = fs.readFileSync(path.join(sessions, 'external.jsonl'));
    const store = new WorkspaceStore(path.join(root, 'data'), sessions), migration = new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] });
    await migration.initialize(); assert.deepEqual(migration.read().items.map((item: any) => item.path), [toPosixPath(local)]);
    const legacyId = `ws_${crypto.randomUUID()}`;
    await store.reserveMigratedWorkspace(legacyId, external);
    const manifest = (id: string) => ({ schemaVersion: 1, id, revision: 0, name: 'Scope fixture', createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z', defaultsRevision: 0, defaults: { domainId: null, profile: null, modelSpec: null }, citationRegistryId: id, conversations: [] });
    await store.publishWorkspace(legacyId, manifest(legacyId));
    const marker = fs.readFileSync(path.join(external, '.tau/workspace.json'));
    const created = await store.reserveWorkspace('explicit-custom-parent', 'a'.repeat(64), () => explicit);
    await store.publishWorkspace(created.workspaceId, manifest(created.workspaceId));
    const prior = migration.read(), excluded = { ...structuredClone(prior.items[0]), id: `mig_${crypto.randomUUID()}`, workspaceId: legacyId, path: toPosixPath(external), histories: [], protectedPaths: [toPosixPath(external)] };
    prior.items.push(excluded); writeJsonAtomic(migration.stateFile, prior);
    assert.ok(!migration.read().items.some((item: any) => item.path === toPosixPath(external)), 'old out-of-scope discoveries cannot resume before re-inventory');
    await migration.initialize();
    const host = new WorkspaceHost({ store, migration, sessions: { sessions: new Map() } });
    const index = await host.index();
    assert.deepEqual(index.workspaces.map((item: any) => item.path).sort(), [toPosixPath(local), toPosixPath(explicit)].sort());
    assert.throws(() => migration.assertWorkspaceReady(legacyId), { code: 'workspace_out_of_scope' });
    migration.assertWorkspaceReady(created.workspaceId);
    assert.equal(JSON.parse(fs.readFileSync(path.join(migration.directory, 'excluded-sources.json'))).items[0].id, excluded.id);
    await migration.initialize(); assert.equal(migration.read().items.length, 1, 'excluded sources are not rediscovered on restart');
    assert.deepEqual(fs.readFileSync(path.join(sessions, 'external.jsonl')), externalHistory);
    assert.deepEqual(fs.readFileSync(path.join(external, '.tau/workspace.json')), marker);
    assert.ok(store.readCatalog().entries.some((entry: any) => entry.workspaceId === legacyId), 'catalog provenance and deletion protection remain intact');
  }
  // A production-sized legacy inventory keeps health checks and list projection responsive.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { WorkspaceStore } = require('../../bin/workspace-store.js'), { WorkspaceMigration } = require('../../bin/workspace-migration.js');
    const { WorkspaceHost } = require('../../bin/workspace-host.js'), { acquireWriteLease } = require('../../bin/util/json-storage.js');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tau-large-inventory-'))), scenario = path.join(root, 'scenario'), agentDir = path.join(root, 'agent');
    fs.mkdirSync(scenario); fs.mkdirSync(agentDir);
    const release = acquireWriteLease(path.join(agentDir, 'host'));
    t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
    for (let index = 0; index < 1200; index++) fs.mkdirSync(path.join(scenario, `legacy-workspace-${index}`));
    const store = new WorkspaceStore(path.join(root, 'data'), path.join(root, 'sessions')), migration = new WorkspaceMigration(store, { agentDir, workspaceRoots: [scenario] });
    let last = performance.now(), longestGap = 0, beats = 0;
    const heartbeat = setInterval(() => { const now = performance.now(); longestGap = Math.max(longestGap, now - last); last = now; beats++; migration.status(); }, 20);
    try {
      await migration.initialize();
      const host = new WorkspaceHost({ store, migration });
      const beforeList = performance.now(), index = await host.index();
      assert.equal(index.workspaces.length, 1200);
      assert.ok(index.workspaces.every((workspace: any) => workspace.availability === 'blocked'));
      assert.ok(performance.now() - beforeList < 3000, 'pending rows reuse one inventory instead of parsing it for every workspace');
      longestGap = Math.max(longestGap, performance.now() - last);
      assert.ok(beats > 2, 'health status runs during inventory instead of waiting for its completion');
      assert.ok(longestGap < 1000, `inventory/list blocked the Host for ${longestGap.toFixed(0)}ms`);
      t.diagnostic(`1200 legacy workspaces: longest health heartbeat gap ${longestGap.toFixed(0)}ms`);
    } finally { clearInterval(heartbeat); }
  }
  // Isolation grants no authority over nested workspaces or unowned directories.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const { WorkspaceStore } = require('../../bin/workspace-store.js'), { WorkspaceMigration } = require('../../bin/workspace-migration.js');
    const { WorkspaceMigrationRunner } = require('../../bin/workspace-migration-runner.js'), { WorkspaceRuntimeGate } = require('../../bin/workspace-runtime.js');
    const { acquireWriteLease, writeJsonAtomic } = require('../../bin/util/json-storage.js');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tau-isolated-delete-'))), data = path.join(root, 'data'), scenario = path.join(root, 'scenario');
    fs.mkdirSync(data); fs.mkdirSync(scenario);
    const release = acquireWriteLease(path.join(data, 'host'));
    t.after(() => { release(); fs.rmSync(root, { recursive: true, force: true }); });
    const store = new WorkspaceStore(data, path.join(data, 'sessions')); await store.initializeCatalog({ schemaVersion: 1, revision: 0, entries: [] });
    const migration = new WorkspaceMigration(store, { agentDir: data, workspaceRoots: [scenario] });
    const python = process.env.TAU_PYTHON_COMMAND || 'python3', coordination = path.join(root, 'guards'), gate = new WorkspaceRuntimeGate(python, path.join(root, 'logs'), coordination), runner = new WorkspaceMigrationRunner(migration, gate, python);
    const parent = path.join(scenario, 'owned-parent'), child = path.join(parent, 'registered-child'); fs.mkdirSync(child, { recursive: true });
    writeJsonAtomic(path.join(parent, '.tau/workspace-owner.json'), { version: 1, workspace: toPosixPath(parent), parent: toPosixPath(scenario) });
    const entry = await store.reserveWorkspace('nested-child', 'a'.repeat(64), () => child), at = '2026-10-26T00:00:00.000Z';
    await store.publishWorkspace(entry.workspaceId, { schemaVersion: 1, id: entry.workspaceId, revision: 0, name: 'Keep child', createdAt: at, updatedAt: at, defaultsRevision: 0, defaults: { domainId: null, profile: null, modelSpec: null }, citationRegistryId: entry.workspaceId, conversations: [] });
    const sentinel = path.join(child, 'user-report.txt'); fs.writeFileSync(sentinel, 'keep this registered workspace');
    const isolate = async (directory: string) => { await migration.initialize(); const item = migration.read().items.find((item: any) => item.path === toPosixPath(directory)), report = await runner.report(item.id); return runner.resolveSource(item.id, { requestId: `isolate-${item.id}`, expectedRevision: item.revision, reportDigest: report.reportDigest, action: 'isolate' }); };
    const remove = (item: any) => runner.deleteIsolated(item.id, { requestId: `delete-${item.id}`, expectedRevision: item.revision, confirm: true });
    await assert.rejects(remove(await isolate(parent)), { code: 'workspace_busy' });
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep this registered workspace');
    assert.equal(store.readWorkspace(entry.workspaceId).manifest.name, 'Keep child');
    const unowned = path.join(scenario, 'unowned'); fs.mkdirSync(unowned); fs.writeFileSync(path.join(unowned, 'report.txt'), 'unowned data');
    await assert.rejects(remove(await isolate(unowned)), { code: 'workspace_ownership_unproven' });
    assert.equal(fs.readFileSync(path.join(unowned, 'report.txt'), 'utf8'), 'unowned data');
    const plain = path.join(scenario, 'owned-empty'); fs.mkdirSync(plain);
    writeJsonAtomic(path.join(plain, '.tau/workspace-owner.json'), { version: 1, workspace: toPosixPath(plain), parent: toPosixPath(scenario) });
    fs.mkdirSync(store.sessionsDirectory, { recursive: true });
    const native = path.join(store.sessionsDirectory, 'owned.jsonl'), nativeBytes = JSON.stringify({ type: 'session', id: 'owned-native', cwd: plain }) + '\n'; fs.writeFileSync(native, nativeBytes);
    const owned = await isolate(plain), otherGate = new WorkspaceRuntimeGate(python, path.join(root, 'other-logs'), coordination), lease = otherGate.takeMaintenance(plain, owned.workspaceId);
    try { await assert.rejects(remove(owned), { code: 'workspace_busy' }); assert.equal(fs.existsSync(plain), true); } finally { lease.finish(); }
    const nested = path.join(plain, 'unindexed'); writeJsonAtomic(path.join(nested, '.tau/workspace-owner.json'), { version: 1, workspace: toPosixPath(nested), parent: toPosixPath(plain) });
    await assert.rejects(remove(owned), { code: 'workspace_busy' }); fs.rmSync(nested, { recursive: true });
    const foreign = path.join(store.sessionsDirectory, 'another.jsonl'); fs.writeFileSync(foreign, JSON.stringify({ type: 'session', id: 'another-native', cwd: plain }) + '\n');
    await assert.rejects(remove(owned), { code: 'workspace_busy' }); assert.equal(fs.readFileSync(native, 'utf8'), nativeBytes); fs.unlinkSync(foreign);
    fs.writeFileSync(native, nativeBytes.replace('owned-native', 'replaced-native')); await assert.rejects(remove(owned), { code: 'history_identity_mismatch' }); fs.writeFileSync(native, nativeBytes);
    assert.equal((await remove(owned)).deleted, true); assert.equal(fs.existsSync(plain), false);
    assert.equal(fs.existsSync(native), false);
    await migration.initialize(); assert.equal(migration.read().items.some((item: any) => item.id === owned.id), false);
  }
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
    await store.editWorkspace(id, 1, (value: any) => { value.conversations[0].state = 'deleted'; value.conversations[0].deletion = { requestId: 'deleted-conversation', invocationOwnerKey: null, error: null, stage: 'history-cleaned' }; });
    await assert.rejects(store.editWorkspace(id, 2, (value: any) => { value.conversations = []; }), { code: 'workspace_identity_conflict' });
    const metadata = path.join(workspaceDirectory, '.tau'), held = path.join(workspaceDirectory, '.tau-held');
    fs.renameSync(metadata, held);
    let linked = false;
    try { fs.symlinkSync(held, metadata, 'dir'); linked = true; }
    catch (error) { t.diagnostic(`Symlink assertion unavailable: ${(error as Error).message}`); }
    try { if (linked) assert.throws(() => store.readWorkspace(id), { code: 'workspace_identity_conflict' }); }
    finally { if (linked) fs.unlinkSync(metadata); fs.renameSync(held, metadata); }
    const revision = store.readCatalog().revision;
    await store.editCatalog(revision, (catalog: any) => { catalog.entries[0].state = 'deleted'; catalog.entries[0].deletion = { requestId: 'deleted-workspace', manifestRevision: 2, historyKeys: [record.history.key], invocationOwnerKeys: [], conversationIds: [], rootIdentity: 'a'.repeat(64), error: null, stage: 'workspace-cleaned' }; });
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

  // Deletion commits dependency order and resumes without reconstructing an Owner from its audit key.
  {
    const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
    const { WorkspaceStore, workspaceCreationDigest } = require('../../bin/workspace-store.js'), { WorkspaceRuntimeGate } = require('../../bin/workspace-runtime.js');
    const { ConversationRuntime } = require('../../bin/conversation-runtime.js'), { WorkspaceDeletion } = require('../../bin/workspace-deletion.js'), { LiveSessionManager } = require('../../bin/sessions.js');
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
