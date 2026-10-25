import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  parseWorkspaceMigrationStructured, type WorkspaceMigrationScopeV1, type WorkspaceMigrationStateV1,
  type WorkspaceMigrationItemV1, type WorkspaceMigrationHistoryV1,
} from '../contracts/index.js';
import { WorkspaceStore, workspaceMetadataPath, workspaceCreationDigest } from './workspace-store.js';
import { acquireWriteLease, assertHostWriter, readJsonObject, writeJsonAtomic } from './util/json-storage.js';
import { isWithin, relativePosixPath, toPosixPath } from './util/path.js';

const failure = (code: string, message: string, details: object = {}) => Object.assign(new Error(message), { code, status: 409, ...details });
const uuid = () => crypto.randomUUID();
const overlap = (left: string, right: string) => isWithin(left, right) || isWithin(right, left);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4096);

/** Canonicalize an existing prefix without creating missing scope directories. */
function location(value: string): string {
  const target = path.resolve(value);
  let existing = target;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw failure('migration_scope_unavailable', 'Cannot resolve migration scope.');
    existing = parent;
  }
  return toPosixPath(path.resolve(fs.realpathSync(existing), path.relative(existing, target)));
}

type Header = { cwd: string; id: string; sha256: string; size: number; mtimeMs: number };
export function historySources(root: string, issue: (file: string, code: string, reason: string) => void) {
  const sources: Array<{ file: string; key: string }> = [];
  if (!fs.existsSync(root)) return sources;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isFile() || entry.isSymbolicLink()) {
      if (entry.name.endsWith('.jsonl')) sources.push({ file: absolute, key: entry.name });
      else if (entry.isSymbolicLink()) issue(toPosixPath(absolute), 'history_symlink', 'History directories are not followed through symbolic links.');
    } else if (entry.isDirectory()) {
      try { for (const file of fs.readdirSync(absolute, { withFileTypes: true })) if (file.name.endsWith('.jsonl')) sources.push({ file: path.join(absolute, file.name), key: `${entry.name}/${file.name}` }); }
      catch (error) { issue(toPosixPath(absolute), 'history_directory_unreadable', message(error)); }
    }
  }
  return sources;
}
export function historyHeader(root: string, key: string): Header {
  const file = workspaceMetadataPath(root, key), stat = fs.lstatSync(file);
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0 || !Number.isFinite(stat.mtimeMs)) throw failure('history_identity_mismatch', 'History is not a regular file with reliable metadata.');
  const descriptor = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(64 * 1024), count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    const end = bytes.subarray(0, count).indexOf(10);
    if (end < 0) throw failure('history_identity_mismatch', 'History has no complete bounded header.');
    const first = bytes.subarray(0, end);
    let header: { type?: unknown; id?: unknown; cwd?: unknown };
    try { header = JSON.parse(first.toString('utf8')); }
    catch { throw failure('history_identity_mismatch', 'History header JSON is invalid; original bytes are preserved.'); }
    const cwd = header && typeof header.cwd === 'string' && header.cwd.length <= 8192 && !header.cwd.includes('\0') && path.isAbsolute(header.cwd) ? location(header.cwd) : null;
    const protectedPaths = cwd ? [cwd] : [];
    if (!header || header.type !== 'session' || typeof header.id !== 'string' || !header.id.trim() || header.id.length > 4096 || !cwd) throw failure('history_identity_mismatch', 'History header identity or workspace is invalid.', { protectedPaths });
    if (typeof header.cwd === 'string' && fs.existsSync(header.cwd) && fs.lstatSync(header.cwd).isSymbolicLink()) throw failure('history_identity_mismatch', 'History workspace is a symbolic-link entry; review the canonical target before import.', { protectedPaths: [...protectedPaths, toPosixPath(path.resolve(header.cwd))] });
    return { cwd, id: header.id, sha256: crypto.createHash('sha256').update(first).digest('hex'), size: stat.size, mtimeMs: stat.mtimeMs };
  } finally { fs.closeSync(descriptor); }
}

/** Global inventory commits before per-workspace conversion; no Pi or private-state reads here. */
export class WorkspaceMigration {
  readonly directory: string;
  readonly stateFile: string;
  readonly reportFile: string;
  readonly scope: WorkspaceMigrationScopeV1;
  private fault: Error | null = null;
  private initializing: Promise<WorkspaceMigrationStateV1> | null = null;
  private heldWriter: ReturnType<typeof acquireWriteLease> | null = null;
  constructor(readonly store: WorkspaceStore, input: { agentDir: string; workspaceRoots: string[] }) {
    this.scope = { userData: location(store.userDataDirectory), agentDir: location(input.agentDir), sessionsDirectory: location(store.sessionsDirectory), workspaceRoots: [...new Set(input.workspaceRoots.map(location))].sort() };
    this.directory = path.join(this.scope.userData, 'migrations/workspace-v1');
    this.stateFile = path.join(this.directory, 'state.json');
    this.reportFile = path.join(this.directory, 'report.json');
  }
  read(): WorkspaceMigrationStateV1 {
    workspaceMetadataPath(this.scope.userData, relativePosixPath(this.scope.userData, this.stateFile));
    if (!fs.existsSync(this.stateFile)) throw failure('system_not_ready', 'Workspace inventory has not been committed.');
    const parsed = parseWorkspaceMigrationStructured(readJsonObject(this.stateFile));
    if (!parsed.ok) throw failure('metadata_corrupt', parsed.diagnostics[0].message);
    if (parsed.value.report !== toPosixPath(this.reportFile)) throw failure('metadata_corrupt', 'Migration report path differs from this inventory.');
    if (!parsed.value.scopes.some((scope) => workspaceCreationDigest(scope) === workspaceCreationDigest(this.scope))) throw failure('system_not_ready', 'This configured scope has not been inventoried.');
    return parsed.value;
  }
  private assertWriter() {
    const lock = path.join(this.scope.agentDir, 'host.transportx-lock');
    if (!fs.existsSync(lock)) throw failure('writer_busy', 'Agent Host Writer ownership is required before workspace inventory.');
    assertHostWriter(this.scope.agentDir);
  }
  private writer() {
    this.assertWriter();
    if (this.heldWriter) {
      try { this.heldWriter.assertOwned(); return this.heldWriter; }
      catch (error) { this.heldWriter = null; throw error; }
    }
    this.heldWriter = acquireWriteLease(workspaceMetadataPath(this.scope.userData, 'migrations/workspace-v1/coordinator'));
    return this.heldWriter;
  }
  private save(state: WorkspaceMigrationStateV1) {
    if (!this.heldWriter) throw failure('writer_busy', 'Global inventory has no Writer lease.');
    this.heldWriter.assertOwned();
    state.updatedAt = new Date().toISOString(); state.revision++;
    const parsed = parseWorkspaceMigrationStructured(state);
    if (!parsed.ok) throw failure('metadata_corrupt', parsed.diagnostics[0].message);
    writeJsonAtomic(this.stateFile, parsed.value);
    return parsed.value;
  }
  private blockFailure(error: unknown, release?: ReturnType<typeof acquireWriteLease>) {
    this.fault = error instanceof Error ? error : new Error(String(error));
    if (!release) return false;
    let trusted: WorkspaceMigrationStateV1 | null = null;
    try {
      release.assertOwned();
      const parsed = parseWorkspaceMigrationStructured(readJsonObject(this.stateFile));
      if (parsed.ok && parsed.value.scopes.every((scope) => scope.userData === this.scope.userData)) trusted = parsed.value;
    } catch {}
    if (trusted) {
      try { trusted.systemReadiness = 'blocked'; this.save(trusted); }
      catch { this.heldWriter = release; return true; }
    }
    return false;
  }
  async updateItem(id: string, update: (item: WorkspaceMigrationItemV1, state: WorkspaceMigrationStateV1) => void) {
    this.assertSystemReady();
    let release: ReturnType<typeof acquireWriteLease> | undefined, retain = false, reading = true, committing = false;
    try {
      release = this.writer();
      const state = this.read();
      reading = false;
      if (state.systemReadiness !== 'ready') throw failure('system_not_ready', 'Inventory is not ready for a target update.');
      const item = state.items.find((item) => item.id === id);
      if (!item) throw failure('workspace_missing', 'Migration source is unavailable.');
      const identity = workspaceCreationDigest([item.id, item.workspaceId, item.path, item.sessionsDirectory]);
      update(item, state);
      if (workspaceCreationDigest([item.id, item.workspaceId, item.path, item.sessionsDirectory]) !== identity) throw failure('workspace_identity_conflict', 'Target progress cannot replace source identity.');
      state.phase = state.items.every((item) => ['ready', 'isolated'].includes(item.state)) ? 'complete' : state.items.some((item) => ['failed', 'needs-review'].includes(item.state)) ? 'needs-attention' : 'converting';
      committing = true; this.save(state); return structuredClone(item);
    } catch (error) { if (reading || committing || ['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EACCES', 'EPERM'].includes((error as { code?: string }).code || '')) retain = this.blockFailure(error, release); throw error; }
    finally { if (!retain) { release?.(); if (this.heldWriter === release) this.heldWriter = null; } }
  }
  initialize(): Promise<WorkspaceMigrationStateV1> {
    if (this.initializing) return this.initializing;
    const operation = this.inventory(); this.initializing = operation;
    operation.finally(() => { if (this.initializing === operation) this.initializing = null; }).catch(() => {});
    return operation;
  }
  private async inventory() {
    let release: ReturnType<typeof acquireWriteLease> | undefined, retainWriter = false;
    try {
      release = this.writer(); this.fault = null;
      if (!fs.existsSync(this.stateFile) && fs.existsSync(`${this.stateFile}.bak`)) throw failure('metadata_corrupt', 'Migration inventory is missing but its backup exists. Explicit verified recovery is required.');
      let prior: WorkspaceMigrationStateV1 | null = null;
      if (fs.existsSync(this.stateFile)) {
        const parsed = parseWorkspaceMigrationStructured(readJsonObject(this.stateFile));
        if (!parsed.ok) throw failure('metadata_corrupt', parsed.diagnostics[0].message);
        prior = parsed.value;
        if (!prior.scopes.every((scope) => scope.userData === this.scope.userData)) throw failure('metadata_corrupt', 'Migration inventory belongs to another user-data directory.');
      }
      if (!fs.existsSync(this.store.catalogFile)) {
        if (prior || fs.existsSync(this.reportFile) || fs.existsSync(`${this.store.catalogFile}.bak`)) throw failure('metadata_corrupt', 'Workspace catalog is missing after prior migration. Inventory cannot recreate deletion tombstones.');
        const candidates = new Set<string>();
        for (const root of this.scope.workspaceRoots) if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) candidates.add(toPosixPath(path.join(root, entry.name)));
        for (const source of historySources(this.scope.sessionsDirectory, () => {})) {
          try { candidates.add(historyHeader(this.scope.sessionsDirectory, source.key).cwd); } catch {}
        }
        const unindexed = [...candidates].filter((directory) => fs.existsSync(path.join(directory, '.tau/workspace.json')));
        if (unindexed.length) throw failure('metadata_corrupt', 'New-format workspace markers exist without a catalog. Recover the catalog explicitly; first-install import cannot prove deletion tombstones.', { paths: unindexed });
        await this.store.initializeCatalog({ schemaVersion: 1, revision: 0, entries: [] });
      }
      const catalog = this.store.readCatalog();
      const scopes = prior?.scopes || [];
      if (!scopes.some((scope) => workspaceCreationDigest(scope) === workspaceCreationDigest(this.scope))) scopes.push(this.scope);
      let state: WorkspaceMigrationStateV1 = { schemaVersion: 1, targetWorkspaceSchema: 1, revision: prior?.revision || 0, scopes, systemReadiness: 'initializing', phase: 'inventory', items: prior?.items || [], report: toPosixPath(this.reportFile), updatedAt: new Date().toISOString() };
      state = this.save(state); // Other Hosts recheck this state before business writes.
      const drafts: WorkspaceMigrationItemV1[] = [];
      const previous = (kind: WorkspaceMigrationItemV1['kind'], target: string, sessionsDirectory: string) => state.items.find((item) => item.kind === kind && item.path === target && item.sessionsDirectory === sessionsDirectory);
      const candidate = (kind: WorkspaceMigrationItemV1['kind'], target: string, sessionsDirectory: string) => {
        const found = drafts.find((item) => item.kind === kind && item.path === target && item.sessionsDirectory === sessionsDirectory); if (found) return found;
        const old = previous(kind, target, sessionsDirectory);
        const item: WorkspaceMigrationItemV1 = old ? structuredClone(old) : { id: `mig_${uuid()}`, kind, path: target, sessionsDirectory, workspaceId: kind === 'workspace' ? `ws_${uuid()}` : null, histories: [], protectedPaths: kind === 'workspace' ? [target] : [], state: 'pending', stage: 'inventory', revision: 0, sourceDigest: null, preparedDigest: null, report: null, error: null, decisions: [] };
        drafts.push(item); return item;
      };
      const issue = (item: WorkspaceMigrationItemV1, code: string, explanation: string, paths: string[] = []) => {
        item.protectedPaths = [...new Set([...item.protectedPaths, ...paths])];
        if (item.state === 'isolated') return;
        item.state = 'needs-review'; item.error = { code, message: explanation.slice(0, 4096) };
      };
      const registeredKeys = new Set<string>();
      const registeredConversations = new Set<string>(), registeredHistories = new Set<string>();
      const deletedKeys = new Map<string, string>();
      const deletedConversations = new Map<string, string>();
      for (const entry of catalog.entries) if (entry.deletion) for (const id of entry.deletion.conversationIds) {
        if (deletedConversations.has(id) && deletedConversations.get(id) !== entry.workspaceId) throw failure('metadata_corrupt', 'Workspace deletion identities overlap in the catalog.');
        deletedConversations.set(id, entry.workspaceId);
      }
      for (const entry of catalog.entries) if (entry.deletion) for (const key of entry.deletion.historyKeys) {
        if (deletedKeys.has(key) && deletedKeys.get(key) !== entry.workspaceId) throw failure('metadata_corrupt', 'Workspace deletion targets overlap in the catalog.');
        deletedKeys.set(key, entry.workspaceId);
      }
      for (const entry of catalog.entries) {
        if (entry.deletion) for (const key of entry.deletion.historyKeys) for (const scope of scopes) registeredKeys.add(`${scope.sessionsDirectory}\n${key}`);
        if (entry.state === 'deleted' || entry.state === 'deleting') continue;
        const migrating = state.items.find((item) => item.kind === 'workspace' && item.workspaceId === entry.workspaceId && item.path === entry.path);
        if (migrating && entry.creationRequestId === null) {
          candidate('workspace', migrating.path, migrating.sessionsDirectory);
          for (const history of migrating.histories) for (const scope of scopes) registeredKeys.add(`${scope.sessionsDirectory}\n${history.key}`);
          if (entry.state === 'creating') continue;
        }
        let workspace: ReturnType<WorkspaceStore['readWorkspace']>;
        try { workspace = this.store.readWorkspace(entry.workspaceId); }
        catch (error) {
          const item = candidate('path', entry.path, this.scope.sessionsDirectory);
          issue(item, 'workspace_metadata_unavailable', message(error), [entry.path]);
          continue;
        }
        for (const record of workspace.manifest.conversations) {
          if (registeredConversations.has(record.id) || registeredHistories.has(record.history.key) || deletedKeys.has(record.history.key) && deletedKeys.get(record.history.key) !== entry.workspaceId || deletedConversations.has(record.id) && deletedConversations.get(record.id) !== entry.workspaceId) throw failure('metadata_corrupt', 'Registered workspaces reuse a conversation identity/history key or conflict with a deletion target. Repair the shared index before business writes.');
          registeredConversations.add(record.id); registeredHistories.add(record.history.key);
          for (const scope of scopes) registeredKeys.add(`${scope.sessionsDirectory}\n${record.history.key}`);
        }
      }
      for (const scope of scopes) {
        const root = scope.sessionsDirectory;
        const sources = historySources(root, (target, code, reason) => issue(candidate('path', target, root), code, reason));
        for (const source of sources) {
          if (registeredKeys.has(`${root}\n${source.key}`)) continue;
          if (state.items.some((item) => item.state === 'isolated' && item.kind !== 'workspace' && item.sessionsDirectory === root && item.path === toPosixPath(source.file))) continue;
          try {
            const header = historyHeader(root, source.key);
            const registered = catalog.entries.find((entry) => entry.path === header.cwd);
            if (registered) {
              const migrating = drafts.find((item) => item.workspaceId === registered.workspaceId && item.kind === 'workspace' && item.stage !== 'published' && item.sessionsDirectory === root);
              if (!migrating) {
                const item = candidate('history', toPosixPath(source.file), root);
                issue(item, 'unregistered_history', 'This history is not referenced by the registered workspace. Review it without importing a second legacy workspace.', [header.cwd]);
                continue;
              }
              if (migrating.stage !== 'inventory') issue(migrating, 'migration_source_changed', 'A new history appeared after preparation; preserve the prepared target for source review.');
            }
            const item = candidate('workspace', header.cwd, root);
            if (item.state === 'isolated') continue;
            const known = item.histories.find((history) => history.key === source.key);
            const version: WorkspaceMigrationHistoryV1 = { key: source.key, conversationId: known?.conversationId || `conv_${uuid()}`, headerId: header.id, headerSha256: header.sha256, size: header.size, mtimeMs: header.mtimeMs };
            if (known?.headerId && known.headerId !== header.id) issue(item, 'history_identity_mismatch', 'The native history identity changed; restore the original header or explicitly isolate its source.');
            else if (known && item.stage !== 'inventory' && workspaceCreationDigest(known) !== workspaceCreationDigest(version)) issue(item, 'migration_source_changed', 'History changed after migration preparation; preserve the prepared report and explicitly retry.');
            else if (known) Object.assign(known, version); else item.histories.push(version);
            if (!fs.existsSync(header.cwd)) issue(item, 'workspace_missing', 'History points to a missing workspace directory.');
          } catch (error) {
            const protectedPaths = (error as { protectedPaths?: string[] }).protectedPaths || [];
            issue(candidate('history', toPosixPath(source.file), root), 'history_header_invalid', message(error), protectedPaths);
          }
        }
        for (const configuredRoot of scope.workspaceRoots) {
          if (!fs.existsSync(configuredRoot)) continue;
          for (const child of fs.readdirSync(configuredRoot, { withFileTypes: true })) {
            const logical = toPosixPath(path.join(configuredRoot, child.name));
            if (!child.isDirectory() && !child.isSymbolicLink()) continue;
            if (child.isSymbolicLink()) {
              let canonical: string | null = null; try { canonical = location(logical); } catch {}
              issue(candidate('path', logical, root), 'workspace_symlink', 'Workspace discovery does not follow symbolic-link entries.', canonical ? [logical, canonical] : [logical]); continue;
            }
            const canonical = location(logical);
            if (catalog.entries.some((entry) => entry.path === canonical)) continue;
            const item = candidate('workspace', canonical, root);
            if (fs.existsSync(path.join(canonical, '.tau/workspace.json'))) {
              issue(item, 'workspace_identity_conflict', 'An unindexed new-format Manifest exists. Recover the catalog explicitly; do not reimport it as legacy.');
            }
          }
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      // Preserve diagnostics and committed identities even after a source disappears.
      for (const item of state.items) if (!drafts.some((candidate) => candidate.id === item.id)) drafts.push(item);
      for (const item of drafts) {
        if (item.kind === 'workspace' && !fs.existsSync(item.path) && !catalog.entries.some((entry) => entry.workspaceId === item.workspaceId && entry.deletion)) issue(item, 'workspace_missing', 'Inventory workspace is no longer available.');
        for (const other of drafts) {
          if (other.id === item.id || other.state === 'isolated') continue;
          if (item.kind === 'workspace' && other.protectedPaths.some((protectedPath) => overlap(item.path, protectedPath))) issue(item, 'workspace_path_conflict', 'Inventory paths overlap or alias another protected object.');
        }
      }
      state.items = drafts; state.systemReadiness = 'ready';
      state.phase = drafts.every((item) => ['ready', 'isolated'].includes(item.state)) ? 'complete' : drafts.some((item) => ['failed', 'needs-review'].includes(item.state)) ? 'needs-attention' : 'converting';
      release.assertOwned();
      writeJsonAtomic(this.reportFile, { schemaVersion: 1, inventoryRevision: state.revision + 1, items: drafts.map(({ id, workspaceId, kind, path, state, error }) => ({ id, workspaceId, kind, path, state, error })) });
      return this.save(state);
    } catch (error) { retainWriter = this.blockFailure(error, release); throw error; }
    finally { if (!retainWriter) { release?.(); if (this.heldWriter === release) this.heldWriter = null; } }
  }
  status() {
    try {
      if (this.fault) throw this.fault;
      this.assertWriter();
      const state = this.read(); this.store.readCatalog();
      const inventoryWriter = fs.existsSync(path.join(this.directory, 'coordinator.transportx-lock'));
      if (inventoryWriter && state.systemReadiness === 'ready') return { dataState: 'initializing' as const, phase: 'inventory' as const, pending: null, blocked: null, report: state.report, code: 'writer_busy', message: 'Global inventory Writer has not confirmed its release. Retry inventory after its owner finishes or resolves the write failure.' };
      return { dataState: state.systemReadiness, phase: state.phase, pending: state.items.filter((item) => ['pending', 'converting'].includes(item.state)).length, blocked: state.items.filter((item) => ['failed', 'needs-review'].includes(item.state)).length, report: state.report };
    } catch (error) { return { dataState: !this.fault && (error as { code?: string }).code === 'system_not_ready' ? 'initializing' as const : 'blocked' as const, phase: 'needs-attention' as const, pending: null, blocked: null, code: (error as { code?: string }).code || 'metadata_corrupt', message: message(error), report: toPosixPath(this.reportFile) }; }
  }
  assertSystemReady() {
    const state = this.status();
    if (state.dataState !== 'ready') throw failure('system_not_ready', 'Workspace inventory is not globally safe. Open migration diagnostics.', { migration: state });
  }
  assertWorkspaceReady(workspaceId: string) {
    this.assertSystemReady();
    const state = this.read();
    const own = state.items.find((item) => item.workspaceId === workspaceId);
    if (own && own.state !== 'ready') throw failure('workspace_migration_required', 'Workspace migration is incomplete.', { itemId: own.id, report: own.report || state.report });
    const { directory, manifest } = this.store.readWorkspace(workspaceId);
    if (own && own.path !== directory) throw failure('workspace_identity_conflict', 'Workspace path differs from its migration identity.');
    const affected = state.items.find((item) => item.workspaceId !== workspaceId && !['ready', 'isolated'].includes(item.state) && item.protectedPaths.some((target) => overlap(directory, target) || overlap(directory, location(target))));
    if (affected) throw failure('workspace_migration_required', 'A protected migration source overlaps this workspace.', { itemId: affected.id, report: affected.report || state.report });
    // A previously unbound file may already contain the first turn after a Host crash.
    // Changing SESSIONS_DIR must not recreate that logical history as an empty file.
    for (const root of new Set(state.scopes.map((scope) => scope.sessionsDirectory))) {
      if (root === this.scope.sessionsDirectory) continue;
      for (const record of manifest.conversations) {
        if (record.state === 'deleted') continue;
        const file = workspaceMetadataPath(root, record.history.key);
        if (!fs.existsSync(file)) continue;
        let header: Header;
        try { header = historyHeader(root, record.history.key); }
        catch { throw failure('workspace_migration_required', 'A history under a previous configured scope cannot be verified.', { report: state.report, historyKey: record.history.key, sessionsDirectory: root }); }
        if (header.cwd === directory) throw failure('workspace_migration_required', 'This workspace history belongs to a different configured SESSIONS_DIR. Restore that configuration or review its source report before activation.', { report: state.report, historyKey: record.history.key, sessionsDirectory: root });
      }
    }
  }
  assertAllocationAllowed(directory: string) {
    this.assertSystemReady();
    const canonical = location(directory);
    const source = this.read().items.find((item) => item.protectedPaths.some((target) => overlap(canonical, target) || overlap(canonical, location(target))));
    if (source) throw failure('workspace_migration_required', 'New workspace allocation overlaps an inventoried source.', { itemId: source.id });
  }
}
