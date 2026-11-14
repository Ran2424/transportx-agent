import type { TestContext } from 'node:test';

async function assertWorkspaceMigration(t: TestContext) {
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
}

module.exports = { assertWorkspaceMigration };
