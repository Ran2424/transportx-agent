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
import { isWithin } from './util/path.js';

const failure = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });
function validated<T>(result: WorkspaceParseResult<T>): T {
  if (!result.ok) throw Object.assign(failure('metadata_corrupt', result.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ')), { diagnostics: result.diagnostics });
  return result.value;
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
  editWorkspace(workspaceId: string, expectedRevision: number, update: (manifest: WorkspaceManifestV1) => void) {
    const { directory } = this.readWorkspace(workspaceId);
    const file = workspaceMetadataPath(directory, '.tau/workspace.json');
    return mutateJson(file, async () => {
      const { manifest } = this.readWorkspace(workspaceId);
      if (manifest.revision !== expectedRevision) throw failure('workspace_revision_conflict', 'Workspace changed; reload before retrying.');
      const defaultsBefore = workspaceCreationDigest([manifest.defaultsRevision, manifest.defaults]);
      const tombstones = manifest.conversations.filter((record) => record.state === 'deleted').map((record) => ({ id: record.id, key: record.history.key, requestId: record.deletion!.requestId }));
      update(manifest);
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
  updateRuntime(workspaceId: string, conversationId: string, update: Pick<ConversationRecordV1, 'state' | 'lastStartFailure' | 'modelSpec' | 'history'>) {
    const { directory } = this.readWorkspace(workspaceId);
    const file = workspaceMetadataPath(directory, '.tau/workspace.json');
    return mutateJson(file, async () => {
      const { manifest } = this.readWorkspace(workspaceId);
      const record = manifest.conversations.find((item) => item.id === conversationId);
      if (!record || ['deleting', 'deleted'].includes(record.state)) throw failure('conversation_missing', 'Conversation is unavailable.', 404);
      if (!['created', 'ready', 'start-failed'].includes(update.state) || update.history.key !== record.history.key || record.history.headerId !== null && record.history.headerId !== update.history.headerId) throw failure('history_identity_mismatch', 'Runtime cannot replace a conversation history binding.');
      const history = this.inspectHistory(directory, record);
      if (history.headerId !== update.history.headerId) throw failure('history_identity_mismatch', 'Runtime history binding differs from the persisted Pi header.');
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
    const file = workspaceMetadataPath(directory, `.tau/${conversationPlanPath(conversationId)}`);
    return mutateJson(file, async () => {
      if (fs.existsSync(file)) {
        if (workspaceCreationDigest(readJsonObject(file)) !== workspaceCreationDigest(parsed.value)) throw failure('workspace_revision_conflict', 'A different frozen plan already exists.');
        return;
      }
      writeJsonAtomic(file, parsed.value);
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
