import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WorkspaceMigrationItemV1 } from '../contracts/index.js';
import { parseWorkspaceManifestStructured } from '../contracts/index.js';
import { WorkspaceMigration, historySources, historyHeader } from './workspace-migration.js';
import { WorkspaceRuntimeGate, type WorkspaceRuntimeLease } from './workspace-runtime.js';
import { workspaceMetadataPath, workspaceCreationDigest } from './workspace-store.js';
import { writeJsonAtomic, readJsonObject } from './util/json-storage.js';
import { assertWorkspaceProcessesStopped } from './process-inspection.js';
import { migrationSpaceRequirements, assertMigrationSpace } from './workspace-migration-space.js';
import { planWorkspaceMigration, migrationFileVersion, migrationJsonBytes, migrationBytesHash, legacyMetadataPaths, type WorkspaceMigrationPlan, type MigrationWrite } from './workspace-migration-plan.js';
import { toPosixPath, relativePosixPath } from './util/path.js';

type Journal = Omit<WorkspaceMigrationPlan, 'writes'> & { writes: Array<Omit<MigrationWrite, 'value'> & { staged: string }> };
const failure = (code: string, message: string) => Object.assign(new Error(message), { code, status: 409 });
const local = (item: WorkspaceMigrationItemV1, relative: string) => workspaceMetadataPath(item.path, `.tau/migrations/workspace-v1/${relative}`);

/** Target transactions use the runtime mutex; global progress writes remain short. */
export class WorkspaceMigrationRunner {
  private pending = new Map<string, Promise<WorkspaceMigrationItemV1>>();
  private maintenance = new Map<string, WorkspaceRuntimeLease>();
  constructor(private migration: WorkspaceMigration, private gate: WorkspaceRuntimeGate, private pythonCommand: string) {}
  private item(id: string) {
    this.migration.assertSystemReady();
    const item = this.migration.read().items.find((item) => item.id === id);
    if (!item) throw failure('workspace_missing', 'Migration source is unavailable.');
    return item;
  }
  private reportPath(item: WorkspaceMigrationItemV1) { return workspaceMetadataPath(this.migration.scope.userData, `migrations/workspace-v1/reports/${item.id}.json`); }
  private load(item: WorkspaceMigrationItemV1): Journal {
    const file = this.reportPath(item);
    if (item.report !== toPosixPath(file) || !item.preparedDigest || migrationBytesHash(fs.readFileSync(file)) !== item.preparedDigest) throw failure('metadata_corrupt', 'Prepared migration report differs from the committed inventory digest.');
    const report = readJsonObject(file) as unknown as Journal;
    if (report.schemaVersion !== 1 || report.itemId !== item.id || report.workspaceId !== item.workspaceId || report.directory !== item.path || report.sessionsDirectory !== item.sessionsDirectory || report.sourceDigest !== item.sourceDigest || !Number.isFinite(Date.parse(report.preparedAt)) || !Array.isArray(report.sources) || !Array.isArray(report.writes) || !Array.isArray(report.issues) || !parseWorkspaceManifestStructured(report.manifest).ok || report.manifest.id !== item.workspaceId) throw failure('metadata_corrupt', 'Prepared migration identity or Manifest is invalid.');
    const ids = new Set(item.histories.map((history) => history.conversationId));
    for (const [index, write] of report.writes.entries()) {
      const parts = write.relative.split('/'), privateFile = parts.slice(3).join('/');
      const privateAllowed = parts[0] === '.tau' && parts[1] === 'conversations' && ids.has(parts[2]) && /^(?:plan\.json|attachment-message-refs\.json|canvas-contexts\.json|timing-metrics\.v1\.json|geo-interactions\/(?:message-refs\.json|contexts\/geoctx_[A-Za-z0-9_-]{12,64}\/(?:context|provenance)\.json|requests\/georeq_[A-Za-z0-9_-]{12,64}\/(?:request|response)\.json))$/.test(privateFile);
      if (!privateAllowed && !['.tau/attachments.json', '.tau/citations.json'].includes(write.relative) || write.staged !== `.tau/migrations/workspace-v1/staged/${index}.json` || write.backup !== null && write.backup !== `.tau/migrations/workspace-v1/backups/${write.relative}` || !Number.isSafeInteger(write.bytes) || write.bytes < 0 || 'value' in write) throw failure('metadata_corrupt', 'Prepared migration target escaped its fixed metadata scope.');
    }
    return report;
  }
  private async preflight(item: WorkspaceMigrationItemV1, journal: Journal) {
    const manifestFile = workspaceMetadataPath(item.path, '.tau/workspace.json');
    if (fs.existsSync(manifestFile) && workspaceCreationDigest(readJsonObject(manifestFile)) !== workspaceCreationDigest(journal.manifest)) throw failure('workspace_revision_conflict', 'A different Manifest already exists; conversion cannot write its private targets.');
    let backups = 0, staged = 0, targets = 0, atomic = 0;
    for (const write of journal.writes) {
      const stage = workspaceMetadataPath(item.path, write.staged), target = workspaceMetadataPath(item.path, write.relative);
      if (fs.existsSync(stage)) { if ((await migrationFileVersion(stage)).sha256 !== write.sha256) throw failure('metadata_corrupt', 'Staged output checksum is invalid.'); }
      else staged += write.bytes;
      if (write.backup) {
        const backup = workspaceMetadataPath(item.path, write.backup);
        if (!fs.existsSync(backup)) backups += write.previousBytes;
        else if ((await migrationFileVersion(backup)).sha256 !== write.previousSha256) throw failure('metadata_corrupt', 'Original backup checksum is invalid.');
      }
      const existing = fs.existsSync(target) ? (await migrationFileVersion(target)).sha256 : null;
      if (existing !== write.sha256) {
        if (existing !== write.previousSha256) throw failure('migration_target_exists', 'An unknown target version blocks conversion.');
        targets += write.bytes; atomic += write.bytes + write.previousBytes * 2;
      }
    }
    const reportBytes = migrationJsonBytes(journal).length, stateBytes = migrationJsonBytes(this.migration.read()).length, catalogBytes = fs.statSync(this.migration.store.catalogFile).size + 16384;
    assertMigrationSpace(migrationSpaceRequirements([
      { path: item.path, backupBytes: backups, newBytes: staged + targets + migrationJsonBytes(journal.manifest).length + reportBytes * 2, atomicBytes: atomic + staged + reportBytes * 2 },
      { path: this.migration.scope.userData, backupBytes: 0, newBytes: reportBytes + stateBytes * 2 + catalogBytes * 2, atomicBytes: reportBytes * 2 + stateBytes * 4 + catalogBytes * 4 },
    ]));
  }
  private async verifySources(item: WorkspaceMigrationItemV1, journal: Journal) {
    const currentMetadata = legacyMetadataPaths(item.path).map((file) => toPosixPath(workspaceMetadataPath(item.path, file))).sort();
    const expectedMetadata = journal.sources.filter((source) => source.kind === 'metadata').map((source) => source.path).sort();
    if (workspaceCreationDigest(currentMetadata) !== workspaceCreationDigest(expectedMetadata)) throw failure('migration_source_changed', 'Legacy metadata membership changed after preparation.');
    const currentKeys: string[] = [];
    for (const source of historySources(item.sessionsDirectory, () => {})) {
      try { if (historyHeader(item.sessionsDirectory, source.key).cwd === item.path) currentKeys.push(source.key); }
      catch (error) { if ((error as { protectedPaths?: string[] }).protectedPaths?.includes(item.path)) throw failure('migration_source_changed', 'A related history header became invalid.'); }
    }
    if (workspaceCreationDigest(currentKeys.sort()) !== workspaceCreationDigest(journal.manifest.conversations.map((record) => record.history.key).sort())) throw failure('migration_source_changed', 'Workspace history membership changed after preparation.');
    for (const source of journal.sources) {
      const root = source.kind === 'history' ? item.sessionsDirectory : item.path;
      const file = workspaceMetadataPath(root, relativePosixPath(root, source.path));
      const current = await migrationFileVersion(file), write = journal.writes.find((write) => toPosixPath(workspaceMetadataPath(item.path, write.relative)) === source.path);
      if (current.sha256 !== source.sha256 && current.sha256 !== write?.sha256) throw failure('migration_source_changed', 'A frozen source changed outside the known conversion writes.');
    }
  }
  convert(id: string): Promise<WorkspaceMigrationItemV1> {
    const pending = this.pending.get(id); if (pending) return pending;
    const item = this.item(id);
    if (item.kind !== 'workspace') return Promise.reject(failure('workspace_migration_required', 'This source needs repair or explicit isolation; it is not a convertible workspace.'));
    const operation = this.gate.serialize(item.path, () => this.execute(id)); this.pending.set(id, operation);
    operation.finally(() => { if (this.pending.get(id) === operation) this.pending.delete(id); }).catch(() => {});
    return operation;
  }
  async resolvePrivate(id: string, input: { requestId: string; expectedRevision: number; reportDigest: string; action: 'bind' | 'isolate'; sourceId: string; conversationId: string | null }) {
    if (!input || typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 8192 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(input.reportDigest) || typeof input.sourceId !== 'string' || !/^source_[a-f0-9]{64}$/.test(input.sourceId) || !['bind', 'isolate'].includes(input.action)) throw failure('invalid_migration_action', 'Migration decision input is invalid.');
    const digest = workspaceCreationDigest(input), initial = this.item(id);
    if (input.action === 'isolate' ? input.conversationId !== null : !initial.histories.some((history) => history.conversationId === input.conversationId)) throw failure('invalid_migration_action', 'Migration decision target is invalid.');
    const duplicate = initial.decisions.find((decision) => decision.requestId === input.requestId);
    if (duplicate) { if (duplicate.inputSha256 !== digest) throw failure('workspace_revision_conflict', 'Migration request ID was used for different input.'); return initial; }
    const result = await this.gate.serialize(initial.path, async () => {
      const item = this.item(id), report = this.load(item);
      const duplicate = item.decisions.find((decision) => decision.requestId === input.requestId);
      if (duplicate) { if (duplicate.inputSha256 !== digest) throw failure('workspace_revision_conflict', 'Migration request ID was used for different input.'); return item; }
      if (item.stage !== 'inventory' || item.revision !== input.expectedRevision || report.sourceDigest !== input.reportDigest) throw failure('workspace_revision_conflict', 'Migration report or revision changed.');
      const lease = this.gate.takeMaintenance(item.path, item.workspaceId!);
      try {
        await assertWorkspaceProcessesStopped(item.path, this.pythonCommand);
        const fresh = await planWorkspaceMigration(item, report.preparedAt);
        if (fresh.sourceDigest !== input.reportDigest) throw failure('migration_source_changed', 'Migration source changed; old decisions cannot be applied.');
        const issue = fresh.issues.find((issue) => issue.sourceId === input.sourceId), assignment = fresh.assignments.find((assignment) => assignment.sourceId === input.sourceId);
        if (!issue && !assignment || input.action === 'isolate' && input.conversationId !== null || input.action === 'bind' && !(issue?.candidates.length === 1 && issue.candidates[0] === input.conversationId || assignment?.conversationId === input.conversationId)) throw failure('private_state_ambiguous', 'The chosen binding has no unique verified evidence. Explicitly isolate the association instead.');
        return await this.migration.updateItem(id, (current) => {
          if (current.revision !== input.expectedRevision) throw failure('workspace_revision_conflict', 'Migration decision revision changed.');
          current.decisions.push({ requestId: input.requestId, inputSha256: digest, reportDigest: input.reportDigest, action: input.action, sourceId: input.sourceId, conversationId: input.conversationId });
          current.revision++; current.state = 'pending'; current.error = null;
        });
      } finally { lease.finish(); }
    });
    return result.state === 'pending' ? this.convert(id) : result;
  }
  private async execute(id: string) {
    let item = this.item(id), lease = this.maintenance.get(id);
    if (item.state === 'isolated') return item;
    if (item.state === 'ready') {
      if (lease) { await lease.finishWithCommit(async () => item); this.maintenance.delete(id); }
      return item;
    }
    if (!item.workspaceId || fs.realpathSync(item.path) !== path.resolve(item.path) || item.sessionsDirectory !== this.migration.scope.sessionsDirectory) throw failure('workspace_identity_conflict', 'Migration target path or sessions scope changed.');
    const conflict = this.migration.read().items.find((other) => other.id !== id && !['ready', 'isolated'].includes(other.state) && other.protectedPaths.some((target) => target === item.path));
    if (conflict) throw failure('workspace_migration_required', 'Another unresolved source protects this workspace. Review the related report first.');
    try {
      if (!lease) { lease = this.gate.takeMaintenance(item.path, item.workspaceId); this.maintenance.set(id, lease); }
      await assertWorkspaceProcessesStopped(item.path, this.pythonCommand);
      let journal: Journal, prepared: WorkspaceMigrationPlan | null = null;
      if (item.stage === 'inventory') {
        const report = this.reportPath(item);
        let previous: ReturnType<typeof readJsonObject> | null = null;
        if (fs.existsSync(report)) {
          const bytes = fs.readFileSync(report); previous = readJsonObject(report);
          if (previous.itemId !== id || previous.workspaceId !== item.workspaceId || typeof previous.preparedAt !== 'string' || !Number.isFinite(Date.parse(previous.preparedAt)) || item.preparedDigest && migrationBytesHash(bytes) !== item.preparedDigest) throw failure('metadata_corrupt', 'Existing target report differs from its committed identity or digest.');
        }
        prepared = await planWorkspaceMigration(item, previous?.preparedAt as string | undefined);
        journal = { ...prepared, writes: prepared.writes.map(({ value: _value, ...write }, index) => ({ ...write, staged: `.tau/migrations/workspace-v1/staged/${index}.json` })) };
        const bytes = migrationJsonBytes(journal);
        if (previous && !item.preparedDigest && migrationBytesHash(fs.readFileSync(report)) !== migrationBytesHash(bytes)) throw failure('migration_target_exists', 'An uncommitted report cannot be reproduced from its source; preserve it for repair.');
        await this.preflight(item, journal);
        // This summary contains hashes/paths and association diagnostics, not message bodies or output values.
        item = await this.migration.updateItem(id, (current) => {
          writeJsonAtomic(report, journal);
          current.sourceDigest = journal.sourceDigest; current.preparedDigest = migrationBytesHash(bytes); current.report = toPosixPath(report);
          current.state = journal.issues.length ? 'needs-review' : 'converting'; current.error = journal.issues.length ? { code: 'private_state_ambiguous', message: 'Review unproven private-state associations before publishing this workspace.' } : null;
        });
        if (journal.issues.length) return item;
        item = await this.migration.updateItem(id, (current) => { current.stage = 'prepared'; current.state = 'converting'; current.error = null; });
      } else { journal = this.load(item); await this.preflight(item, journal); }
      await this.verifySources(item, journal);
      if (item.stage === 'prepared') {
        const missing = journal.writes.some((write) => !fs.existsSync(workspaceMetadataPath(item.path, write.staged)));
        if (missing && !prepared) {
          prepared = await planWorkspaceMigration(item, journal.preparedAt);
          if (prepared.sourceDigest !== journal.sourceDigest || workspaceCreationDigest(prepared.writes.map((write) => [write.relative, write.sha256])) !== workspaceCreationDigest(journal.writes.map((write) => [write.relative, write.sha256]))) throw failure('migration_source_changed', 'Prepared outputs cannot be reproduced from the frozen source.');
        }
        for (const write of journal.writes) {
          const staged = workspaceMetadataPath(item.path, write.staged);
          if (!fs.existsSync(staged)) writeJsonAtomic(staged, prepared!.writes.find((value) => value.relative === write.relative)!.value);
          if ((await migrationFileVersion(staged)).sha256 !== write.sha256) throw failure('metadata_corrupt', 'Staged private metadata checksum differs from its prepared output.');
          if (write.backup) {
            const backup = workspaceMetadataPath(item.path, write.backup), source = workspaceMetadataPath(item.path, write.relative);
            if (!fs.existsSync(backup)) {
              const bytes = fs.readFileSync(source);
              if (migrationBytesHash(bytes) !== write.previousSha256) throw failure('migration_source_changed', 'Backup input no longer matches the frozen original.');
              fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
              const temporary = `${backup}.${crypto.randomUUID()}.tmp`;
              let descriptor: number | undefined;
              try { descriptor = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined; fs.renameSync(temporary, backup); }
              finally { if (descriptor !== undefined) fs.closeSync(descriptor); fs.rmSync(temporary, { force: true }); }
            }
            if ((await migrationFileVersion(backup)).sha256 !== write.previousSha256) throw failure('metadata_corrupt', 'Backup checksum is invalid; original metadata cannot be overwritten.');
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        writeJsonAtomic(local(item, 'backup-manifest.json'), { schemaVersion: 1, itemId: id, sourceDigest: journal.sourceDigest, entries: journal.sources.map((source) => ({ ...source, overwrite: journal.writes.some((write) => toPosixPath(workspaceMetadataPath(item.path, write.relative)) === source.path), backup: journal.writes.find((write) => toPosixPath(workspaceMetadataPath(item.path, write.relative)) === source.path)?.backup || null, verified: true })), targets: journal.writes.map(({ relative, previousSha256, previousBytes, sha256, bytes, backup }) => ({ relative, previousSha256, previousBytes, sha256, bytes, backup, existed: previousSha256 !== null })) });
        item = await this.migration.updateItem(id, (current) => { current.stage = 'backed-up'; });
      }
      for (const write of journal.writes) {
        const staged = workspaceMetadataPath(item.path, write.staged), file = workspaceMetadataPath(item.path, write.relative);
        if ((await migrationFileVersion(staged)).sha256 !== write.sha256) throw failure('metadata_corrupt', 'Prepared stage data is no longer valid.');
        if (write.backup && (await migrationFileVersion(workspaceMetadataPath(item.path, write.backup))).sha256 !== write.previousSha256) throw failure('metadata_corrupt', 'Verified original backup is unavailable.');
        const existing = fs.existsSync(file) ? (await migrationFileVersion(file)).sha256 : null;
        if (existing !== write.sha256) {
          if (existing !== write.previousSha256) throw failure('migration_target_exists', 'Target contains bytes outside the known original/prepared versions.');
          writeJsonAtomic(file, JSON.parse(fs.readFileSync(staged, 'utf8')));
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await assertWorkspaceProcessesStopped(item.path, this.pythonCommand);
      await this.verifySources(item, journal);
      await this.migration.store.reserveMigratedWorkspace(item.workspaceId!, item.path);
      await this.migration.store.publishWorkspace(item.workspaceId!, journal.manifest);
      const result = await lease.finishWithCommit(() => this.migration.updateItem(id, (current) => { current.stage = 'published'; current.state = 'ready'; current.error = null; }));
      this.maintenance.delete(id); return result;
    } catch (error) {
      try { item = await this.migration.updateItem(id, (current) => { current.state = (error as { code?: string }).code === 'private_state_ambiguous' ? 'needs-review' : 'failed'; current.error = { code: (error as { code?: string }).code || 'migration_failed', message: (error instanceof Error ? error.message : String(error)).slice(0, 4096) }; }); } catch {}
      throw error;
    } finally {
      if (this.maintenance.get(id) === lease && lease) {
        try { lease.finish(); this.maintenance.delete(id); } catch { try { lease.unconfirmed(); } catch {} }
      }
    }
  }
  async convertPending() {
    const results: Array<{ id: string; state: string; error?: string }> = [];
    for (const item of this.migration.read().items) if (item.kind === 'workspace' && item.state === 'pending') {
      try { results.push({ id: item.id, state: (await this.convert(item.id)).state }); }
      catch (error) { results.push({ id: item.id, state: 'failed', error: (error as { code?: string }).code || 'migration_failed' }); }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return results;
  }
}
