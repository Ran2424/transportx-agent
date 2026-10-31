import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CONVERSATION_ID, conversationPlanPath, isWorkspaceHistoryKey, parseWorkspaceCatalogStructured, parseWorkspaceManifestStructured,
  parseResolvedSessionPlanStructured, type WorkspaceCatalogV1, type WorkspaceCatalogEntryV1,
  type WorkspaceManifestV1, type ConversationRecordV1, type WorkspaceDefaultsV1, type WorkspaceParseResult,
  type ResolvedSessionPlanV3,
} from '../contracts/index.js';
import { readJsonObject, writeJsonAtomic, mutateJson } from './util/json-storage.js';
import { isWithin, toPosixPath } from './util/path.js';

const failure = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });
function validated<T>(result: WorkspaceParseResult<T>): T {
  if (!result.ok) throw Object.assign(failure('metadata_corrupt', result.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ')), { diagnostics: result.diagnostics });
  return result.value;
}

export function workspaceDiskPlan(plan: ResolvedSessionPlanV3): ResolvedSessionPlanV3 {
  return {
    ...plan, workspace: toPosixPath(plan.workspace),
    modules: plan.modules.map((module) => ({
      ...module, packageRoot: toPosixPath(module.packageRoot), entrypoints: module.entrypoints.map((entry) => ({ ...entry, path: toPosixPath(entry.path) })),
      nativeRuntimes: module.nativeRuntimes.map((runtime) => ({ ...runtime, ffmpeg: { ...runtime.ffmpeg, path: toPosixPath(runtime.ffmpeg.path) }, ffprobe: { ...runtime.ffprobe, path: toPosixPath(runtime.ffprobe.path) } })),
    })),
    assets: plan.assets.map((asset) => ({ ...asset, path: toPosixPath(asset.path), ...(asset.integrityFile ? { integrityFile: toPosixPath(asset.integrityFile) } : {}) })),
  };
}

/** Metadata never follows symlinks, including an existing intermediate .tau. */
export function workspaceMetadataPath(workspace: string, relative: string) {
  const target = path.resolve(workspace, relative);
  if (!isWithin(workspace, target) || path.relative(workspace, target) === '') throw failure('workspace_identity_conflict', 'Metadata path escapes the workspace.');
  let current = target;
  while (path.relative(workspace, current) !== '') {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw failure('workspace_identity_conflict', 'Workspace metadata contains a symbolic link.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    current = path.dirname(current);
  }
  return target;
}

export function conversationStatePath(scope: { cwd: string; conversationId: string }, relative = '') {
  if (!CONVERSATION_ID.test(scope.conversationId)) throw failure('workspace_identity_conflict', 'A persistent conversation identity is required for private state.');
  const directory = workspaceMetadataPath(path.resolve(scope.cwd), `.tau/conversations/${scope.conversationId}`);
  return relative ? workspaceMetadataPath(directory, relative) : directory;
}

export function workspaceCreationDigest(value: unknown): string {
  const canonical = (input: unknown): unknown => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : input;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

/** Persistence only: no Pi startup, migration discovery or deletion side effects. */
export class WorkspaceStore {
  readonly catalogFile: string;
  constructor(readonly userDataDirectory: string, readonly sessionsDirectory: string) {
    this.catalogFile = path.join(userDataDirectory, 'workspaces.json');
  }
  readCatalog(): WorkspaceCatalogV1 {
    if (!fs.existsSync(this.catalogFile)) throw failure('catalog_missing', 'Workspace catalog is missing; inventory or explicit recovery is required.');
    if (fs.lstatSync(this.catalogFile).isSymbolicLink()) throw failure('metadata_corrupt', 'Workspace catalog must not be a symbolic link.');
    return validated(parseWorkspaceCatalogStructured(readJsonObject(this.catalogFile)));
  }
  /** Only the startup inventory coordinator may initialize a missing catalog. */
  initializeCatalog(catalog: WorkspaceCatalogV1) {
    return mutateJson(this.catalogFile, async () => {
      if (fs.existsSync(this.catalogFile)) throw failure('workspace_revision_conflict', 'Workspace catalog already exists.');
      if (fs.existsSync(`${this.catalogFile}.bak`) || fs.existsSync(path.join(this.userDataDirectory, 'migrations/workspace-v1/state.json'))) throw failure('metadata_corrupt', 'A catalog backup or migration marker exists; explicit catalog recovery is required.');
      writeJsonAtomic(this.catalogFile, validated(parseWorkspaceCatalogStructured(catalog)));
    });
  }
  editCatalog(expectedRevision: number, update: (catalog: WorkspaceCatalogV1) => void) {
    return mutateJson(this.catalogFile, async () => {
      const catalog = this.readCatalog();
      if (catalog.revision !== expectedRevision) throw failure('workspace_revision_conflict', 'Workspace catalog changed; reload before retrying.');
      const tombstones = catalog.entries.filter((entry) => entry.state === 'deleted').map((entry) => structuredClone(entry));
      update(catalog); catalog.revision++;
      for (const tombstone of tombstones) {
        const current = catalog.entries.find((entry) => entry.workspaceId === tombstone.workspaceId);
        if (!current || workspaceCreationDigest(current) !== workspaceCreationDigest(tombstone)) throw failure('workspace_identity_conflict', 'Deleted workspace tombstones cannot be removed or replaced.');
      }
      writeJsonAtomic(this.catalogFile, validated(parseWorkspaceCatalogStructured(catalog)));
      return catalog;
    });
  }
  reserveWorkspace(requestId: string, inputSha256: string, allocate: (catalog: WorkspaceCatalogV1) => string, directoryOwnership?: 'external') {
    return mutateJson(this.catalogFile, async () => {
      const catalog = this.readCatalog();
      const previous = catalog.entries.find((entry) => entry.creationRequestId === requestId);
      if (previous) {
        if (previous.creationInputSha256 !== inputSha256) throw failure('workspace_revision_conflict', 'Creation request ID was already used for different input.');
        return previous;
      }
      const entry: WorkspaceCatalogEntryV1 = { workspaceId: `ws_${crypto.randomUUID()}`, path: toPosixPath(allocate(catalog)), creationRequestId: requestId, creationInputSha256: inputSha256, state: 'creating', deletion: null, ...(directoryOwnership ? { directoryOwnership } : {}) };
      catalog.entries.push(entry); catalog.revision++;
      writeJsonAtomic(this.catalogFile, validated(parseWorkspaceCatalogStructured(catalog)));
      return entry;
    });
  }
  /** A reserved standalone workspace is never shown as an ordinary workspace. */
  reserveStandaloneWorkspace(workspaceId: string, directory: string) {
    return mutateJson(this.catalogFile, async () => {
      const catalog = this.readCatalog(), canonical = toPosixPath(directory);
      const previous = catalog.entries.find((entry) => entry.workspaceId === workspaceId);
      if (previous) {
        if (previous.kind !== 'standalone' || previous.path !== canonical) throw failure('workspace_identity_conflict', 'Standalone reservation differs from its identity.');
        return previous;
      }
      if (catalog.entries.some((entry) => isWithin(entry.path, canonical) || isWithin(canonical, entry.path))) throw failure('workspace_identity_conflict', 'Standalone workspace overlaps an existing workspace or deletion tombstone.');
      const entry: WorkspaceCatalogEntryV1 = { workspaceId, path: canonical, creationRequestId: null, creationInputSha256: null, state: 'creating', kind: 'standalone', deletion: null };
      catalog.entries.push(entry); catalog.revision++;
      writeJsonAtomic(this.catalogFile, validated(parseWorkspaceCatalogStructured(catalog)));
      return entry;
    });
  }
  reserveMigratedWorkspace(workspaceId: string, directory: string) {
    return mutateJson(this.catalogFile, async () => {
      const catalog = this.readCatalog(), canonical = toPosixPath(fs.realpathSync(directory));
      const previous = catalog.entries.find((entry) => entry.workspaceId === workspaceId);
      if (previous) {
        if (previous.path !== canonical || previous.creationRequestId !== null || !['creating', 'ready'].includes(previous.state)) throw failure('workspace_identity_conflict', 'Migration reservation differs from its inventory identity.');
        return previous;
      }
      if (catalog.entries.some((entry) => isWithin(entry.path, canonical) || isWithin(canonical, entry.path))) throw failure('workspace_identity_conflict', 'Migration overlaps an existing workspace or deletion tombstone.');
      catalog.entries.push({ workspaceId, path: canonical, creationRequestId: null, creationInputSha256: null, state: 'creating', deletion: null }); catalog.revision++;
      writeJsonAtomic(this.catalogFile, validated(parseWorkspaceCatalogStructured(catalog)));
      return catalog.entries.at(-1)!;
    });
  }
  private entry(workspaceId: string, allowCreating = false): WorkspaceCatalogEntryV1 {
    const entry = this.readCatalog().entries.find((item) => item.workspaceId === workspaceId);
    if (!entry || entry.state === 'deleted') throw failure('workspace_missing', 'Workspace is not registered.', 404);
    if (entry.state !== 'ready' && !(allowCreating && entry.state === 'creating')) throw failure('workspace_migration_required', 'Workspace is not ready; open its migration report.');
    if (!fs.existsSync(entry.path)) throw failure('workspace_missing', 'Registered workspace directory is missing.', 404);
    const real = fs.realpathSync(entry.path);
    if (path.relative(real, entry.path) !== '' || !fs.statSync(real).isDirectory()) throw failure('workspace_identity_conflict', 'Registered workspace path no longer identifies its canonical directory.');
    for (const other of this.readCatalog().entries) {
      if (other.workspaceId === workspaceId || other.state === 'deleted') continue;
      const otherPath = fs.existsSync(other.path) ? fs.realpathSync(other.path) : path.resolve(other.path);
      if (isWithin(real, otherPath) || isWithin(otherPath, real)) throw failure('workspace_identity_conflict', 'Registered workspaces overlap or alias the same directory.');
    }
    return entry;
  }
  readWorkspace(workspaceId: string) {
    const entry = this.entry(workspaceId);
    const file = workspaceMetadataPath(entry.path, '.tau/workspace.json');
    const manifest = validated(parseWorkspaceManifestStructured(readJsonObject(file)));
    if (manifest.id !== workspaceId) throw failure('workspace_identity_conflict', 'Workspace manifest ID differs from its catalog entry.');
    return { directory: entry.path, manifest };
  }
  findConversation(conversationId: string) {
    if (!CONVERSATION_ID.test(conversationId)) throw failure('conversation_missing', 'Conversation is not registered.', 404);
    const matches: Array<{ directory: string; manifest: WorkspaceManifestV1; conversation: ConversationRecordV1 }> = [];
    for (const entry of this.readCatalog().entries) {
      if (entry.state !== 'ready') continue;
      let workspace: ReturnType<WorkspaceStore['readWorkspace']>;
      try { workspace = this.readWorkspace(entry.workspaceId); } catch { continue; }
      const conversation = workspace.manifest.conversations.find((record) => record.id === conversationId);
      if (conversation) matches.push({ ...workspace, conversation });
    }
    if (matches.length > 1) throw failure('workspace_identity_conflict', 'Conversation identity appears in more than one workspace.');
    if (!matches.length) throw failure('conversation_missing', 'Conversation is unavailable; inspect the workspace list and migration report.', 404);
    return matches[0];
  }
  /** Publishes metadata for an already reserved creating entry; caller holds no catalog lease. */
  publishWorkspace(workspaceId: string, manifest: WorkspaceManifestV1) {
    const entry = this.entry(workspaceId, true);
    const file = workspaceMetadataPath(entry.path, '.tau/workspace.json');
    return mutateJson(file, async () => {
      this.entry(workspaceId, true);
      if (manifest.id !== workspaceId) throw failure('workspace_identity_conflict', 'Workspace ID differs from its reservation.');
      const parsed = validated(parseWorkspaceManifestStructured(manifest));
      for (const conversation of parsed.conversations) if (conversation.plan) this.readPlan(entry.path, conversation);
      if (fs.existsSync(file)) {
        const current = validated(parseWorkspaceManifestStructured(readJsonObject(file)));
        if (workspaceCreationDigest(current) !== workspaceCreationDigest(parsed)) throw failure('workspace_revision_conflict', 'A different workspace manifest is already committed.');
      } else writeJsonAtomic(file, parsed);
      // Workspace → short catalog lease is the only allowed lock order.
      await mutateJson(this.catalogFile, async () => {
        const catalog = this.readCatalog();
        const current = catalog.entries.find((item) => item.workspaceId === workspaceId);
        if (!current || current.path !== entry.path || !['creating', 'ready'].includes(current.state)) throw failure('workspace_identity_conflict', 'Workspace reservation changed before publication.');
        if (current.state === 'ready') return;
        current.state = 'ready'; catalog.revision++;
        writeJsonAtomic(this.catalogFile, validated(parseWorkspaceCatalogStructured(catalog)));
      });
      return parsed;
    });
  }
  editWorkspace(workspaceId: string, expectedRevision: number, update: (manifest: WorkspaceManifestV1) => void | Promise<void>) {
    const { directory } = this.readWorkspace(workspaceId);
    const file = workspaceMetadataPath(directory, '.tau/workspace.json');
    return mutateJson(file, async () => {
      const { manifest } = this.readWorkspace(workspaceId);
      if (manifest.revision !== expectedRevision) throw failure('workspace_revision_conflict', 'Workspace changed; reload before retrying.');
      const defaultsBefore = workspaceCreationDigest([manifest.defaultsRevision, manifest.defaults]);
      const tombstones = manifest.conversations.filter((record) => record.state === 'deleted').map((record) => ({ id: record.id, key: record.history.key, requestId: record.deletion!.requestId }));
      await update(manifest);
      if (manifest.id !== workspaceId) throw failure('workspace_identity_conflict', 'Workspace identity cannot be changed.');
      if (workspaceCreationDigest([manifest.defaultsRevision, manifest.defaults]) !== defaultsBefore) throw failure('workspace_revision_conflict', 'Defaults must be edited with their own revision.');
      for (const tombstone of tombstones) {
        const current = manifest.conversations.find((record) => record.id === tombstone.id);
        if (!current || current.state !== 'deleted' || current.history.key !== tombstone.key || current.deletion?.requestId !== tombstone.requestId) throw failure('workspace_identity_conflict', 'Deleted conversation identities and history keys must be retained.');
      }
      manifest.revision++; manifest.updatedAt = new Date().toISOString();
      writeJsonAtomic(file, validated(parseWorkspaceManifestStructured(manifest)));
      return manifest;
    });
  }
  freezeWorkspaceDeletion(workspaceId: string, expectedRevision: number, deletion: NonNullable<WorkspaceCatalogEntryV1['deletion']>) {
    const { directory } = this.readWorkspace(workspaceId);
    return mutateJson(workspaceMetadataPath(directory, '.tau/workspace.json'), async () => {
      const { manifest } = this.readWorkspace(workspaceId);
      if (manifest.revision !== expectedRevision) throw failure('workspace_revision_conflict', 'Workspace changed before deletion targets froze.');
      const catalog = this.readCatalog();
      return this.editCatalog(catalog.revision, (value) => {
        const entry = value.entries.find((entry) => entry.workspaceId === workspaceId)!;
        if (entry.state !== 'ready') throw failure('workspace_revision_conflict', 'Workspace lifecycle changed before deletion.');
        entry.state = 'deleting'; entry.deletion = deletion;
      });
    });
  }
  commitConversation(workspaceId: string, requestId: string, inputSha256: string, expectedRevision: number, defaultsRevision: number, prepare: (manifest: WorkspaceManifestV1, directory: string) => Promise<ConversationRecordV1>) {
    const { directory } = this.readWorkspace(workspaceId);
    const file = workspaceMetadataPath(directory, '.tau/workspace.json');
    return mutateJson(file, async () => {
      const { manifest } = this.readWorkspace(workspaceId);
      const existing = manifest.conversations.find((record) => record.creationRequestId === requestId);
      if (existing) {
        if (existing.creationInputSha256 !== inputSha256) throw failure('workspace_revision_conflict', 'Creation request ID was already used for different input.');
        return { directory, manifest, conversation: existing };
      }
      if (manifest.revision !== expectedRevision || manifest.defaultsRevision !== defaultsRevision) throw failure('workspace_revision_conflict', 'Workspace or defaults changed; reload before creating a conversation.');
      const record = await prepare(manifest, directory);
      if (record.creationRequestId !== requestId || record.creationInputSha256 !== inputSha256) throw failure('workspace_identity_conflict', 'Prepared conversation does not match its creation request.');
      this.readPlan(directory, record);
      manifest.conversations.push(record); manifest.revision++; manifest.updatedAt = new Date().toISOString();
      writeJsonAtomic(file, validated(parseWorkspaceManifestStructured(manifest)));
      return { directory, manifest, conversation: record };
    });
  }
  updateDefaults(workspaceId: string, expectedDefaultsRevision: number, defaults: WorkspaceDefaultsV1) {
    const { directory } = this.readWorkspace(workspaceId);
    const file = workspaceMetadataPath(directory, '.tau/workspace.json');
    return mutateJson(file, async () => {
      const { manifest } = this.readWorkspace(workspaceId);
      if (manifest.defaultsRevision !== expectedDefaultsRevision) throw failure('workspace_revision_conflict', 'Workspace defaults changed; reload before retrying.');
      manifest.defaults = defaults; manifest.defaultsRevision++; manifest.updatedAt = new Date().toISOString();
      writeJsonAtomic(file, validated(parseWorkspaceManifestStructured(manifest)));
      return manifest;
    });
  }
  updateRuntime(workspaceId: string, conversationId: string, update: Pick<ConversationRecordV1, 'state' | 'lastStartFailure' | 'modelSpec' | 'history'>, isCurrent?: () => boolean) {
    if (isCurrent && !isCurrent()) return Promise.resolve(null);
    const { directory } = this.readWorkspace(workspaceId);
    const file = workspaceMetadataPath(directory, '.tau/workspace.json');
    return mutateJson(file, async () => {
      if (isCurrent && !isCurrent()) return null;
      const { manifest } = this.readWorkspace(workspaceId);
      const record = manifest.conversations.find((item) => item.id === conversationId);
      if (!record || ['deleting', 'deleted'].includes(record.state)) throw failure('conversation_missing', 'Conversation is unavailable.', 404);
      if (!['created', 'ready', 'start-failed'].includes(update.state) || update.history.key !== record.history.key || record.history.headerId !== null && record.history.headerId !== update.history.headerId) throw failure('history_identity_mismatch', 'Runtime cannot replace a conversation history binding.');
      if (update.state !== 'start-failed' || update.history.headerId !== record.history.headerId) {
        const history = this.inspectHistory(directory, record);
        if (history.headerId !== update.history.headerId) throw failure('history_identity_mismatch', 'Runtime history binding differs from the persisted Pi header.');
      }
      record.state = update.state; record.lastStartFailure = update.lastStartFailure;
      record.modelSpec = update.modelSpec; record.history = update.history;
      writeJsonAtomic(file, validated(parseWorkspaceManifestStructured(manifest)));
      return record;
    });
  }
  savePlan(directory: string, conversationId: string, plan: ResolvedSessionPlanV3) {
    if (!CONVERSATION_ID.test(conversationId)) throw failure('workspace_identity_conflict', 'Invalid conversation ID.');
    const parsed = parseResolvedSessionPlanStructured(plan);
    if (!parsed.ok || fs.realpathSync(plan.workspace) !== fs.realpathSync(directory)) throw failure('history_identity_mismatch', 'Frozen plan does not match this workspace.');
    const serialized = workspaceDiskPlan(parsed.value);
    const file = workspaceMetadataPath(directory, `.tau/${conversationPlanPath(conversationId)}`);
    return mutateJson(file, async () => {
      if (fs.existsSync(file)) {
        if (workspaceCreationDigest(readJsonObject(file)) !== workspaceCreationDigest(serialized)) throw failure('workspace_revision_conflict', 'A different frozen plan already exists.');
        return;
      }
      writeJsonAtomic(file, serialized);
    });
  }
  readPlan(directory: string, record: ConversationRecordV1): ResolvedSessionPlanV3 {
    if (!record.plan) throw failure('session_plan_missing', 'Historical session plan is unavailable.');
    if (!CONVERSATION_ID.test(record.id) || record.plan.path !== conversationPlanPath(record.id)) throw failure('workspace_identity_conflict', 'Frozen plan path does not belong to this conversation.');
    const file = workspaceMetadataPath(directory, `.tau/${record.plan.path}`);
    const parsed = parseResolvedSessionPlanStructured(readJsonObject(file));
    if (!parsed.ok || fs.realpathSync(parsed.value.workspace) !== fs.realpathSync(directory)) throw failure('history_identity_mismatch', 'Frozen plan is invalid or belongs to another workspace.');
    return parsed.value;
  }
  /** Rewrites only plan.workspace; every other frozen plan field must stay identical. */
  relocatePlan(sourceDirectory: string, record: ConversationRecordV1, targetDirectory: string) {
    if (!record.plan) return null;
    const source = this.readPlan(sourceDirectory, record);
    const target = toPosixPath(fs.realpathSync(targetDirectory));
    const relocated = { ...source, workspace: target };
    const parsed = parseResolvedSessionPlanStructured(relocated);
    if (!parsed.ok) throw failure('invalid_session_plan', 'Relocated session plan is invalid.');
    const withoutWorkspace = (plan: ResolvedSessionPlanV3) => ({ ...plan, workspace: '' });
    const file = workspaceMetadataPath(targetDirectory, `.tau/${record.plan.path}`);
    return mutateJson(file, async () => {
      if (fs.existsSync(file)) {
        const current = parseResolvedSessionPlanStructured(readJsonObject(file));
        if (!current.ok) throw failure('metadata_corrupt', 'Relocated session plan is invalid.');
        const currentWorkspace = fs.realpathSync(current.value.workspace);
        if (currentWorkspace !== fs.realpathSync(targetDirectory) && currentWorkspace !== fs.realpathSync(sourceDirectory)) throw failure('workspace_identity_conflict', 'Existing plan belongs to an unrelated workspace.');
        if (workspaceCreationDigest(withoutWorkspace(current.value)) !== workspaceCreationDigest(withoutWorkspace(parsed.value))) throw failure('workspace_revision_conflict', 'A different frozen plan already exists in the target conversation.');
      }
      writeJsonAtomic(file, workspaceDiskPlan(parsed.value));
      return parsed.value;
    });
  }
  /** Pi history keeps its reserved key; only the verified header cwd moves with the conversation. */
  relocateHistory(record: ConversationRecordV1, sourceDirectory: string, targetDirectory: string) {
    const root = fs.existsSync(this.sessionsDirectory) ? fs.realpathSync(this.sessionsDirectory) : path.resolve(this.sessionsDirectory);
    const file = workspaceMetadataPath(root, record.history.key);
    if (!fs.existsSync(file)) {
      if (record.history.headerId !== null) throw failure('history_missing', 'Previously bound Pi history is missing; the conversation cannot be moved safely.');
      return null;
    }
    if (!fs.lstatSync(file).isFile()) throw failure('history_identity_mismatch', 'Pi history is not a regular file.');
    const target = fs.realpathSync(targetDirectory);
    let header: { type?: unknown; id?: unknown; cwd?: unknown } = {}, end = -1;
    const descriptor = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024), count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      end = buffer.subarray(0, count).indexOf(10);
      if (end < 0) throw failure('history_identity_mismatch', 'Pi history has no complete header.');
      try { header = JSON.parse(buffer.subarray(0, end).toString('utf8')); }
      catch { throw failure('history_identity_mismatch', 'Pi history header JSON is invalid.'); }
    } finally { fs.closeSync(descriptor); }
    if (!header || header.type !== 'session' || typeof header.id !== 'string' || record.history.headerId !== null && record.history.headerId !== header.id) throw failure('history_identity_mismatch', 'Pi history header does not match this conversation.');
    if (typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) throw failure('history_identity_mismatch', 'Pi history header workspace is invalid.');
    let current: string;
    try { current = fs.realpathSync(header.cwd); }
    catch { throw failure('history_identity_mismatch', 'Pi history workspace no longer exists.'); }
    if (current === target) return header.id;
    if (current !== fs.realpathSync(sourceDirectory)) throw failure('history_identity_mismatch', 'Pi history belongs to another workspace.');
    header.cwd = toPosixPath(target);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    const output = fs.openSync(temp, 'wx', 0o600), input = fs.openSync(file, 'r');
    try {
      fs.writeSync(output, Buffer.from(`${JSON.stringify(header)}\n`));
      const chunk = Buffer.alloc(1024 * 1024);
      let position = end + 1;
      while (true) {
        const read = fs.readSync(input, chunk, 0, chunk.length, position);
        if (!read) break;
        fs.writeSync(output, chunk, 0, read);
        position += read;
      }
      fs.fsyncSync(output);
    } finally { fs.closeSync(input); fs.closeSync(output); }
    try { fs.renameSync(temp, file); } finally { fs.rmSync(temp, { force: true }); }
    return header.id;
  }
  newHistoryKey(conversationId: string) {
    if (!CONVERSATION_ID.test(conversationId)) throw failure('workspace_identity_conflict', 'Invalid conversation ID.');
    return `transportx/${conversationId}.jsonl`;
  }
  inspectHistory(directory: string, record: ConversationRecordV1) {
    if (!isWorkspaceHistoryKey(record.history.key)) throw failure('history_identity_mismatch', 'Invalid history key.');
    const root = fs.existsSync(this.sessionsDirectory) ? fs.realpathSync(this.sessionsDirectory) : path.resolve(this.sessionsDirectory);
    const file = workspaceMetadataPath(root, record.history.key);
    if (!fs.existsSync(file)) {
      if (record.history.headerId !== null) throw failure('history_missing', 'Previously bound Pi history is missing; automatic recreation is blocked.');
      return { file, sessionFile: null, headerId: null };
    }
    if (!fs.statSync(file).isFile()) throw failure('history_identity_mismatch', 'Pi history is not a regular file.');
    const descriptor = fs.openSync(file, 'r');
    let header: { type?: unknown; id?: unknown; cwd?: unknown };
    try {
      const buffer = Buffer.alloc(64 * 1024), count = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, count).toString('utf8'), end = text.indexOf('\n');
      if (end < 0) throw new Error('Missing complete header.');
      header = JSON.parse(text.slice(0, end));
      if (!header || header.type !== 'session' || typeof header.id !== 'string' || !header.id.trim() || typeof header.cwd !== 'string' || fs.realpathSync(header.cwd) !== fs.realpathSync(directory) || record.history.headerId !== null && record.history.headerId !== header.id) throw new Error('History owner mismatch.');
    } catch { throw failure('history_identity_mismatch', 'Pi history header is invalid or belongs to another conversation/workspace.'); }
    finally { fs.closeSync(descriptor); }
    return { file, sessionFile: file, headerId: header.id as string };
  }
}
