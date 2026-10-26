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
import { isWithin, toPosixPath, relativePosixPath } from './util/path.js';

type Journal = Omit<WorkspaceMigrationPlan, 'writes'> & { writes: Array<Omit<MigrationWrite, 'value'> & { staged: string }> };
const failure = (code: string, message: string) => Object.assign(new Error(message), { code, status: 409 });
const local = (item: WorkspaceMigrationItemV1, relative: string) => workspaceMetadataPath(item.path, `.tau/migrations/workspace-v1/${relative}`);
export type MigrationSourceDecision = { requestId: string; expectedRevision: number; reportDigest: string; action: 'isolate' | 'retry' | 'reprepare' };
export type IsolatedMigrationDeletion = { requestId: string; expectedRevision: number; confirm: true };
const covers = (workspace: WorkspaceMigrationItemV1, source: WorkspaceMigrationItemV1) => source.kind !== 'workspace' && source.sessionsDirectory === workspace.sessionsDirectory && (source.path === workspace.path || workspace.histories.some((history) => toPosixPath(workspaceMetadataPath(workspace.sessionsDirectory, history.key)) === source.path));

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
  private singleHistoryProven(item: WorkspaceMigrationItemV1) {
    return !this.migration.read().items.some((source) => source.kind !== 'workspace' && source.state !== 'ready' && !(source.decisions.at(-1)?.action === 'retry' && covers(item, source)) && (source.protectedPaths.some((directory) => directory === item.path) || source.kind === 'history' && source.protectedPaths.length === 0));
  }
  private plan(item: WorkspaceMigrationItemV1, preparedAt?: string) { return planWorkspaceMigration(item, preparedAt, this.singleHistoryProven(item)); }
  private load(item: WorkspaceMigrationItemV1): Journal {
    const canonical = this.reportPath(item), archived = `${canonical}.${item.preparedDigest}.archived`;
    const file = item.stage === 'restoring' && !fs.existsSync(canonical) ? archived : canonical;
    if (item.report !== toPosixPath(canonical) || !item.preparedDigest || migrationBytesHash(fs.readFileSync(file)) !== item.preparedDigest) throw failure('metadata_corrupt', 'Prepared migration report differs from the committed inventory digest.');
    const report = readJsonObject(file) as unknown as Journal;
    if (report.schemaVersion !== 1 || report.itemId !== item.id || report.workspaceId !== item.workspaceId || report.directory !== item.path || report.sessionsDirectory !== item.sessionsDirectory || report.sourceDigest !== item.sourceDigest || !Number.isFinite(Date.parse(report.preparedAt)) || !Array.isArray(report.sources) || !Array.isArray(report.writes) || !Array.isArray(report.issues) || !parseWorkspaceManifestStructured(report.manifest).ok || report.manifest.id !== item.workspaceId) throw failure('metadata_corrupt', 'Prepared migration identity or Manifest is invalid.');
    const ids = new Set(item.histories.map((history) => history.conversationId));
    if (typeof report.singleHistoryProven !== 'boolean') throw failure('metadata_corrupt', 'Prepared history-scope evidence is missing.');
    for (const [index, write] of report.writes.entries()) {
      const parts = write.relative.split('/'), privateFile = parts.slice(3).join('/');
      const privateAllowed = parts[0] === '.tau' && parts[1] === 'conversations' && ids.has(parts[2]) && /^(?:plan\.json|attachment-message-refs\.json|canvas-contexts\.json|timing-metrics\.v1\.json|geo-interactions\/(?:message-refs\.json|contexts\/geoctx_[A-Za-z0-9_-]{12,64}\/(?:context|provenance)\.json|requests\/georeq_[A-Za-z0-9_-]{12,64}\/(?:request|response)\.json))$/.test(privateFile);
      if (!privateAllowed && !['.tau/attachments.json', '.tau/citations.json'].includes(write.relative) || write.staged !== `.tau/migrations/workspace-v1/staged/${index}.json` || write.backup !== null && write.backup !== `.tau/migrations/workspace-v1/backups/${write.relative}` || !Number.isSafeInteger(write.bytes) || write.bytes < 0 || 'value' in write) throw failure('metadata_corrupt', 'Prepared migration target escaped its fixed metadata scope.');
    }
    return report;
  }
  /** Source digests are computed from bytes, including malformed JSON, without returning its contents. */
  async report(id: string) {
    const item = this.item(id), files = new Set<string>(), observations: unknown[] = [], sources: Array<{ path: string; bytes: number; sha256: string }> = [];
    if (item.kind !== 'workspace') files.add(item.path);
    else {
      try { for (const relative of legacyMetadataPaths(item.path)) files.add(toPosixPath(workspaceMetadataPath(item.path, relative))); }
      catch (error) { observations.push({ path: item.path, code: (error as { code?: string }).code || 'metadata_corrupt' }); }
      for (const history of item.histories) { try { files.add(toPosixPath(workspaceMetadataPath(item.sessionsDirectory, history.key))); } catch { observations.push({ path: history.key, code: 'history_identity_mismatch' }); } }
      for (const source of historySources(item.sessionsDirectory, (file, code) => observations.push({ path: file, code }))) {
        try { if (historyHeader(item.sessionsDirectory, source.key).cwd === item.path) files.add(toPosixPath(source.file)); }
        catch (error) { if ((error as { protectedPaths?: string[] }).protectedPaths?.includes(item.path)) files.add(toPosixPath(source.file)); }
      }
    }
    for (const file of [...files].sort()) {
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) observations.push({ path: file, kind: stat.isSymbolicLink() ? 'symlink' : 'directory', mtimeMs: stat.mtimeMs, ino: stat.ino, dev: stat.dev });
        else sources.push({ path: file, ...await migrationFileVersion(file) });
      } catch (error) { observations.push({ path: file, code: (error as { code?: string }).code || 'unreadable' }); }
    }
    const versions = sources.map((source) => [source.path, source.bytes, source.sha256]).sort(([left], [right]) => String(left).localeCompare(String(right)));
    const reportDigest = workspaceCreationDigest(observations.length ? { versions, observations } : versions);
    let prepared: Journal | null = null, reportError: string | null = null;
    if (item.report && item.kind === 'workspace') { try { prepared = this.load(item); } catch { reportError = 'Prepared report is unavailable or differs from its committed digest.'; } }
    return { item, reportDigest, sources, observations, prepared, reportError };
  }
  async resolveSource(id: string, input: MigrationSourceDecision): Promise<WorkspaceMigrationItemV1> {
    if (!input || typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 8192 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(input.reportDigest) || !['isolate', 'retry', 'reprepare'].includes(input.action)) throw failure('invalid_migration_action', 'Migration source decision input is invalid.');
    const digest = workspaceCreationDigest(input), initial = this.item(id);
    const existing = initial.decisions.find((decision) => decision.requestId === input.requestId);
    if (existing && existing.inputSha256 !== digest) throw failure('workspace_revision_conflict', 'Migration request ID was used for different input.');
    if (existing && initial.decisions.at(-1) !== existing) return initial;
    const decide = async () => {
      const current = this.item(id), duplicate = current.decisions.find((decision) => decision.requestId === input.requestId);
      if (duplicate) { if (duplicate.inputSha256 !== digest) throw failure('workspace_revision_conflict', 'Migration request ID was used for different input.'); return; }
      const snapshot = await this.report(id);
      if (snapshot.item.revision !== input.expectedRevision || snapshot.reportDigest !== input.reportDigest) throw failure('workspace_revision_conflict', 'Source revision or report digest changed. Refresh its report before deciding.');
      if (snapshot.item.state === 'ready' || snapshot.item.stage === 'published') throw failure('invalid_migration_action', 'Published sources use the normal workspace lifecycle.');
      if (input.action === 'reprepare' && (snapshot.item.kind !== 'workspace' || !['prepared', 'backed-up', 'restoring'].includes(snapshot.item.stage) || !snapshot.prepared || fs.existsSync(workspaceMetadataPath(snapshot.item.path, '.tau/workspace.json')))) throw failure('invalid_migration_action', 'Reprepare requires a verified conversion that has not committed its Manifest. Finish publication of an existing Manifest instead.');
      if (input.action === 'reprepare' && snapshot.observations.length) throw failure('migration_source_changed', 'Repair cannot freeze unreadable or unknown source versions.');
      await this.migration.updateItem(id, (current) => {
        const duplicate = current.decisions.find((decision) => decision.requestId === input.requestId);
        if (duplicate) { if (duplicate.inputSha256 !== digest) throw failure('workspace_revision_conflict', 'Migration request ID was used for different input.'); return; }
        if (current.revision !== input.expectedRevision || current.stage !== snapshot.item.stage || current.preparedDigest !== snapshot.item.preparedDigest) throw failure('workspace_revision_conflict', 'Source progress changed before the decision committed.');
        if (input.action === 'reprepare') writeJsonAtomic(this.repairPath(current, digest), { schemaVersion: 1, itemId: id, inputSha256: digest, sources: snapshot.sources });
        current.decisions.push({ requestId: input.requestId, inputSha256: digest, reportDigest: input.reportDigest, action: input.action, sourceId: null, conversationId: null });
        current.revision++; current.error = null;
        current.state = input.action === 'isolate' ? 'isolated' : 'pending';
        if (input.action === 'reprepare') current.stage = 'restoring';
      });
    };
    const directories = new Set<string>();
    for (const target of [initial.path, ...initial.protectedPaths]) { try { if (fs.statSync(target).isDirectory()) directories.add(fs.realpathSync(target)); } catch {} }
    const targets = [...directories].sort(); if (!targets.length) targets.push(fs.realpathSync(this.migration.scope.userData));
    const serialize = (index: number): Promise<void> => index === targets.length ? decide() : this.gate.serialize(targets[index], () => serialize(index + 1));
    await serialize(0);
    let item = this.item(id);
    if (input.action === 'isolate' || item.state === 'ready') return this.maintenance.has(id) ? this.convert(id) : item;
    if (item.stage === 'restoring') await this.gate.serialize(item.path, () => this.restorePrepared(id));
    await this.migration.initialize(); item = this.item(id);
    for (const target of this.migration.read().items) if (target.kind === 'workspace' && target.state !== 'ready' && target.state !== 'isolated' && (target.id === id || covers(target, item))) await this.convert(target.id);
    return this.item(id);
  }
  /** Permanently remove a source that the user explicitly isolated from migration. */
  async deleteIsolated(id: string, input: IsolatedMigrationDeletion) {
    if (!input || input.confirm !== true || typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 200 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw failure('invalid_deletion_confirmation', 'Deleting an isolated source requires explicit confirmation, requestId and revision.');
    const initial = this.item(id);
    if (initial.state !== 'isolated') throw failure('invalid_migration_action', 'Only an isolated migration source can be deleted here.');
    if (initial.workspaceId === null) throw failure('workspace_missing', 'The isolated source has no workspace identity.');
    const directories = new Set<string>();
    for (const target of [initial.path, ...initial.protectedPaths]) {
      try { if (fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink()) directories.add(fs.realpathSync(target)); } catch {}
    }
    const targets = [...directories].sort();
    const execute = async () => {
      const current = this.item(id);
      if (current.state !== 'isolated') throw failure('invalid_migration_action', 'Only an isolated migration source can be deleted here.');
      if (current.revision !== input.expectedRevision) throw failure('workspace_revision_conflict', 'The isolated source changed. Refresh migration diagnostics before deleting it.');
      const catalogEntry = this.migration.store.readCatalog().entries.find((entry) => entry.workspaceId === current.workspaceId);
      if (catalogEntry) throw failure('invalid_migration_action', 'Published workspaces use the normal deletion lifecycle.');
      const lease = this.gate.takeDeletion(current.path, current.workspaceId!);
      try {
        if (current.kind === 'workspace') {
          if (fs.existsSync(current.path)) {
            const stat = fs.lstatSync(current.path);
            if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current.path) !== path.resolve(current.path)) throw failure('workspace_identity_conflict', 'The isolated workspace path is no longer its original canonical directory.');
            this.isolatedDeletionBoundary(current);
            await assertWorkspaceProcessesStopped(current.path, this.pythonCommand);
            // Recheck after the asynchronous process inspection, while still
            // holding the same cross-Host deletion lease.
            const fresh = fs.lstatSync(current.path);
            if (fresh.dev !== stat.dev || fresh.ino !== stat.ino || fresh.birthtimeMs !== stat.birthtimeMs) throw failure('workspace_identity_conflict', 'The isolated directory was replaced before deletion.');
            this.isolatedDeletionBoundary(current);
            await fs.promises.rm(current.path, { recursive: true, force: true });
          }
        } else {
          if (fs.existsSync(current.path)) {
            const stat = fs.lstatSync(current.path);
            if (!stat.isFile() || stat.isSymbolicLink()) throw failure('workspace_identity_conflict', 'The isolated source is no longer its original regular file.');
            await fs.promises.rm(current.path, { force: true });
          }
        }
        for (const history of current.histories) {
          const file = workspaceMetadataPath(current.sessionsDirectory, history.key);
          try { if (fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()) await fs.promises.rm(file, { force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        await this.migration.updateItem(id, (_item, state) => { state.items = state.items.filter((candidate) => candidate.id !== id); });
        try { await fs.promises.rm(this.reportPath(current), { force: true }); } catch {}
        return { deleted: true as const, id };
      } finally { lease.finish(); }
    };
    const serialize = (index: number): Promise<{ deleted: true; id: string }> => index === targets.length ? execute() : this.gate.serialize(targets[index], () => serialize(index + 1));
    return serialize(0);
  }
  private isolatedDeletionBoundary(item: WorkspaceMigrationItemV1) {
    const overlap = (directory: string) => isWithin(item.path, directory) || isWithin(directory, item.path);
    const catalog = this.migration.store.readCatalog();
    if (catalog.entries.some((entry) => overlap(fs.existsSync(entry.path) ? fs.realpathSync(entry.path) : entry.path))) throw failure('workspace_busy', 'A registered workspace or deletion record overlaps the isolated source.');
    const state = this.migration.read();
    if (state.items.some((other) => other.id !== item.id && other.kind === 'workspace' && overlap(other.path))) throw failure('workspace_busy', 'Another migration workspace overlaps the isolated source.');
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const child = path.join(directory, entry.name);
        if (fs.existsSync(path.join(child, '.tau/workspace.json')) || fs.existsSync(path.join(child, '.tau/workspace-owner.json'))) throw failure('workspace_busy', 'A nested workspace prevents recursive deletion.');
        visit(child);
      }
    };
    visit(item.path);
    const owner = readJsonObject(workspaceMetadataPath(item.path, '.tau/workspace-owner.json'));
    if (owner.version !== 1 || owner.workspace !== toPosixPath(item.path) || owner.parent !== toPosixPath(fs.realpathSync(path.dirname(item.path)))) throw failure('workspace_ownership_unproven', 'Isolation does not prove physical directory ownership.');
    for (const root of new Set(state.scopes.map((scope) => scope.sessionsDirectory))) for (const source of historySources(root, () => {})) {
      const own = root === item.sessionsDirectory && item.histories.find((history) => history.key === source.key);
      try {
        const header = historyHeader(root, source.key);
        if (own && (header.cwd !== item.path || header.id !== own.headerId || header.sha256 !== own.headerSha256)) throw failure('history_identity_mismatch', 'An isolated Native history changed ownership.');
        if (!own && overlap(header.cwd)) throw failure('workspace_busy', 'Another Native history references the isolated directory.');
      } catch (error) {
        if (own || (error as { code?: string }).code === 'workspace_busy' || (error as { protectedPaths?: string[] }).protectedPaths?.some(overlap)) throw error;
      }
    }
  }
  private repairPath(item: WorkspaceMigrationItemV1, digest: string) { return `${this.reportPath(item)}.repair-${digest}`; }
  /** Undo only the exact outputs in the frozen report; business files and Native history are never rolled back. */
  private async restorePrepared(id: string) {
    const item = this.item(id), journal = this.load(item), decision = [...item.decisions].reverse().find((decision) => decision.action === 'reprepare')!;
    const saved = readJsonObject(this.repairPath(item, decision.inputSha256)) as unknown as { schemaVersion: number; itemId: string; inputSha256: string; sources: Array<{ path: string; bytes: number; sha256: string }> };
    if (saved.schemaVersion !== 1 || saved.itemId !== id || saved.inputSha256 !== decision.inputSha256 || !Array.isArray(saved.sources) || workspaceCreationDigest(saved.sources.map((source) => [source.path, source.bytes, source.sha256]).sort(([left], [right]) => String(left).localeCompare(String(right)))) !== decision.reportDigest) throw failure('metadata_corrupt', 'Repair source snapshot differs from the confirmed report.');
    const verify = async () => {
      const snapshot = await this.report(id);
      if (snapshot.observations.length || workspaceCreationDigest(snapshot.sources.map((source) => source.path).sort()) !== workspaceCreationDigest(saved.sources.map((source) => source.path).sort())) throw failure('migration_source_changed', 'Repair source membership changed.');
      for (const source of snapshot.sources) {
        const original = saved.sources.find((entry) => entry.path === source.path)!;
        const write = journal.writes.find((entry) => toPosixPath(workspaceMetadataPath(item.path, entry.relative)) === source.path);
        if (source.sha256 !== original.sha256 && source.sha256 !== write?.previousSha256) throw failure('migration_source_changed', 'An unapproved source version prevents repair.');
      }
      for (const record of journal.manifest.conversations) if (historyHeader(item.sessionsDirectory, record.history.key).id !== record.history.headerId) throw failure('history_identity_mismatch', 'Repair cannot replace native history identities.');
    };
    let lease = this.maintenance.get(id);
    if (!lease) { lease = this.gate.takeMaintenance(item.path, item.workspaceId!); this.maintenance.set(id, lease); }
    try {
      await assertWorkspaceProcessesStopped(item.path, this.pythonCommand);
      await verify();
      if (fs.existsSync(workspaceMetadataPath(item.path, '.tau/workspace.json'))) throw failure('workspace_revision_conflict', 'A committed Manifest must finish publication instead of rolling back.');
      const allowed = new Set(journal.writes.map((write) => write.relative));
      const privateRoot = workspaceMetadataPath(item.path, '.tau/conversations');
      const directories: string[] = [];
      const inspect = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const file = workspaceMetadataPath(item.path, relativePosixPath(item.path, path.join(directory, entry.name)));
          if (entry.isDirectory()) inspect(file);
          else if (!entry.isFile() || !allowed.has(relativePosixPath(item.path, file))) throw failure('migration_target_exists', 'Unknown private data prevents restoring migration outputs.');
        }
        directories.push(directory);
      };
      if (fs.existsSync(privateRoot)) inspect(privateRoot);
      for (const write of journal.writes) {
        const file = workspaceMetadataPath(item.path, write.relative), current = fs.existsSync(file) ? (await migrationFileVersion(file)).sha256 : null;
        if (current !== write.previousSha256 && current !== write.sha256) throw failure('migration_target_exists', 'Unknown target bytes prevent migration repair.');
        if (write.backup) {
          const backup = workspaceMetadataPath(item.path, write.backup);
          if ((fs.existsSync(backup) || current !== write.previousSha256) && (await migrationFileVersion(backup)).sha256 !== write.previousSha256) throw failure('metadata_corrupt', 'Repair requires the verified original backup.');
        }
      }
      for (const write of journal.writes) {
        const file = workspaceMetadataPath(item.path, write.relative);
        if (write.previousSha256 === null) fs.rmSync(file, { force: true });
        else if ((await migrationFileVersion(file)).sha256 !== write.previousSha256) {
          const bytes = fs.readFileSync(workspaceMetadataPath(item.path, write.backup!)), temporary = `${file}.${crypto.randomUUID()}.repair`;
          let descriptor: number | undefined;
          try { descriptor = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined; fs.renameSync(temporary, file); }
          finally { if (descriptor !== undefined) fs.closeSync(descriptor); fs.rmSync(temporary, { force: true }); }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      for (const directory of directories) { if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory); }
      for (const file of [local(item, 'staged'), local(item, 'backup-manifest.json')]) if (fs.existsSync(file)) {
        const archive = `${file}.${item.preparedDigest}.archived`;
        if (fs.existsSync(archive)) throw failure('migration_target_exists', 'A repair archive already exists; preserve both versions for review.');
        fs.renameSync(file, archive);
      }
      await assertWorkspaceProcessesStopped(item.path, this.pythonCommand); await verify();
      await lease.finishWithCommit(() => this.migration.updateItem(id, (current) => {
        const report = this.reportPath(item), archive = `${report}.${item.preparedDigest}.archived`;
        if (fs.existsSync(report)) { if (fs.existsSync(archive)) throw failure('migration_target_exists', 'A report repair archive already exists.'); fs.renameSync(report, archive); }
        current.stage = 'inventory'; current.state = 'pending'; current.sourceDigest = null; current.preparedDigest = null; current.report = null; current.error = null;
      }));
      this.maintenance.delete(id);
    } catch (error) {
      try { await this.migration.updateItem(id, (current) => { current.state = 'failed'; current.error = { code: (error as { code?: string }).code || 'migration_failed', message: (error instanceof Error ? error.message : String(error)).slice(0, 4096) }; }); } catch {}
      throw error;
    } finally {
      if (this.maintenance.get(id) === lease) { try { lease.finish(); this.maintenance.delete(id); } catch { try { lease.unconfirmed(); } catch {} } }
    }
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
    if (journal.singleHistoryProven && !this.singleHistoryProven(item)) throw failure('migration_source_changed', 'Additional unresolved histories invalidate the single-history ownership proof.');
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
    if (duplicate) { if (duplicate.inputSha256 !== digest) throw failure('workspace_revision_conflict', 'Migration request ID was used for different input.'); return initial.state === 'ready' && this.maintenance.has(id) ? this.convert(id) : initial; }
    const result = await this.gate.serialize(initial.path, async () => {
      const item = this.item(id), report = this.load(item);
      const duplicate = item.decisions.find((decision) => decision.requestId === input.requestId);
      if (duplicate) { if (duplicate.inputSha256 !== digest) throw failure('workspace_revision_conflict', 'Migration request ID was used for different input.'); return item; }
      if (item.stage !== 'inventory' || item.revision !== input.expectedRevision || report.sourceDigest !== input.reportDigest) throw failure('workspace_revision_conflict', 'Migration report or revision changed.');
      const lease = this.gate.takeMaintenance(item.path, item.workspaceId!);
      try {
        await assertWorkspaceProcessesStopped(item.path, this.pythonCommand);
        const fresh = await this.plan(item, report.preparedAt);
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
    if (item.state === 'isolated') {
      if (lease) { await lease.finishWithCommit(async () => item); this.maintenance.delete(id); }
      return item;
    }
    if (item.state === 'ready') {
      if (lease) { await lease.finishWithCommit(async () => item); this.maintenance.delete(id); }
      return item;
    }
    if (!item.workspaceId || fs.realpathSync(item.path) !== path.resolve(item.path) || item.sessionsDirectory !== this.migration.scope.sessionsDirectory) throw failure('workspace_identity_conflict', 'Migration target path or sessions scope changed.');
    if (item.stage === 'restoring') throw failure('workspace_migration_required', 'Resume the recorded repair before conversion.');
    const conflict = this.migration.read().items.find((other) => other.id !== id && !['ready', 'isolated'].includes(other.state) && !(other.decisions.at(-1)?.action === 'retry' && covers(item, other)) && other.protectedPaths.some((target) => target === item.path));
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
        prepared = await this.plan(item, previous?.preparedAt as string | undefined);
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
          prepared = await this.plan(item, journal.preparedAt);
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
      const result = await lease.finishWithCommit(() => this.migration.updateItem(id, (current, state) => {
        current.stage = 'published'; current.state = 'ready'; current.error = null;
        for (const source of state.items) if (source.decisions.at(-1)?.action === 'retry' && covers(current, source)) {
          source.stage = 'published'; source.state = 'ready'; source.error = null; source.report = current.report; source.sourceDigest = current.sourceDigest; source.preparedDigest = current.preparedDigest;
        }
      }));
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
