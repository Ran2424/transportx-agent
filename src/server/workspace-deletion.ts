import fs from 'node:fs';
import path from 'node:path';
import type { ConversationRecordV1, WorkspaceCatalogEntryV1 } from '../contracts/index.js';
import { parseWorkspaceManifestStructured } from '../contracts/index.js';
import { WorkspaceStore, workspaceMetadataPath, conversationStatePath, workspaceCreationDigest } from './workspace-store.js';
import { WorkspaceRuntimeGate, type WorkspaceRuntimeLease } from './workspace-runtime.js';
import { ConversationRuntime } from './conversation-runtime.js';
import { executionOwner, executionOwnerKey, type OwnerSession } from './util/execution-owner.js';
import { readJsonObject } from './util/json-storage.js';
import { isWithin } from './util/path.js';
import { historySources, historyHeader } from './workspace-migration.js';
import { assertWorkspaceProcessesStopped } from './process-inspection.js';

type Input = { requestId: string; expectedRevision: number; confirm: boolean; stopCurrent?: boolean };
type Options = {
  store: WorkspaceStore; gate: WorkspaceRuntimeGate; runtime: ConversationRuntime; pythonCommand: string;
  assertReady(workspaceId: string): void; assertSystemReady(): void;
  historyDirectories(): string[];
  cleanupInvocations(context: OwnerSession): Promise<void>;
  verifyWorkspace(directory: string): string | null;
  removeWorkspace(directory: string): Promise<void>;
};
const failure = (code: string, message: string) => Object.assign(new Error(message), { code, status: 409 });
const detail = (error: unknown) => ({ code: (error as { code?: string }).code || 'deletion_failed', message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) || 'Deletion failed.' });
const rootIdentity = (directory: string) => { const stat = fs.lstatSync(directory, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== path.resolve(directory)) throw failure('workspace_identity_conflict', 'Deletion root is no longer its canonical directory.'); return workspaceCreationDigest([String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]); };

/** Fixed deletion targets outlive their dependencies. No stage infers invocation cleanup from missing files. */
export class WorkspaceDeletion {
  private leases = new Map<string, WorkspaceRuntimeLease>();
  constructor(private options: Options) {}
  private input(input: Input) {
    if (!input || input.confirm !== true || typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 200 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.stopCurrent !== undefined && typeof input.stopCurrent !== 'boolean') throw failure('invalid_deletion_confirmation', 'Deletion requires explicit confirmation, requestId and revision.');
  }
  private owner(directory: string, record: ConversationRecordV1) {
    const history = this.options.store.inspectHistory(directory, record);
    if (!history.sessionFile) return { key: null, context: null };
    const context: OwnerSession = { cwd: directory, sessionFile: history.sessionFile, resolvedSessionPlan: this.options.store.readPlan(directory, record) };
    return { key: executionOwnerKey(executionOwner(context, this.options.store.sessionsDirectory)), context };
  }
  private editConversation(id: string, update: (record: ConversationRecordV1) => void) {
    const target = this.options.store.findConversation(id);
    return this.options.store.editWorkspace(target.manifest.id, target.manifest.revision, (manifest) => update(manifest.conversations.find((record) => record.id === id)!));
  }
  private async withLease<T>(directory: string, workspaceId: string, execute: () => Promise<T>) {
    let lease = this.leases.get(workspaceId);
    if (!lease) { lease = this.options.gate.takeDeletion(directory, workspaceId); this.leases.set(workspaceId, lease); }
    try { const result = await lease.finishWithCommit(execute); this.leases.delete(workspaceId); return result; }
    finally { if (this.leases.get(workspaceId) === lease) { try { lease.finish(); this.leases.delete(workspaceId); } catch { try { lease.unconfirmed(); } catch {} } } }
  }
  conversation(id: string, input: Input) {
    this.input(input); this.options.assertSystemReady();
    const target = this.options.store.findConversation(id); this.options.assertReady(target.manifest.id);
    return this.options.runtime.withWorkspaceStopped(target.directory, !!input.stopCurrent, () => this.withLease(target.directory, target.manifest.id, async () => {
      let current = this.options.store.findConversation(id).conversation;
      if (current.deletion && current.deletion.requestId !== input.requestId) throw failure('workspace_revision_conflict', 'A different deletion request already owns this conversation.');
      if (current.state === 'deleted') return current;
      try {
        await assertWorkspaceProcessesStopped(target.directory, this.options.pythonCommand);
        if (!current.deletion) {
          const fresh = this.options.store.findConversation(id);
          if (fresh.manifest.revision !== input.expectedRevision) throw failure('workspace_revision_conflict', 'Workspace changed before conversation deletion.');
          const owner = this.owner(target.directory, fresh.conversation), history = this.options.store.inspectHistory(target.directory, fresh.conversation);
          await this.options.store.editWorkspace(fresh.manifest.id, input.expectedRevision, (manifest) => {
            const record = manifest.conversations.find((record) => record.id === id)!;
            record.history.headerId = history.headerId; record.state = 'deleting'; record.deletion = { requestId: input.requestId, invocationOwnerKey: owner.key, stage: 'frozen', error: null };
          });
          current = this.options.store.findConversation(id).conversation;
        }
        if (current.deletion!.stage === 'frozen') {
          const owner = this.owner(target.directory, current);
          if (owner.key !== current.deletion!.invocationOwnerKey) throw failure('history_identity_mismatch', 'Frozen invocation ownership changed.');
          if (owner.context) await this.options.cleanupInvocations(owner.context);
          await this.editConversation(id, (record) => { record.deletion!.stage = 'invocations-cleaned'; record.deletion!.error = null; });
          current = this.options.store.findConversation(id).conversation;
        }
        if (current.deletion!.stage === 'invocations-cleaned') {
          const file = workspaceMetadataPath(this.options.store.sessionsDirectory, current.history.key);
          if (fs.existsSync(file)) this.options.store.inspectHistory(target.directory, current);
          await fs.promises.rm(file, { force: true });
          await this.editConversation(id, (record) => { record.deletion!.stage = 'history-cleaned'; record.deletion!.error = null; });
        }
        await fs.promises.rm(conversationStatePath({ cwd: target.directory, conversationId: id }), { recursive: true, force: true });
        await this.editConversation(id, (record) => { record.state = 'deleted'; record.name = ''; record.plan = null; record.modelSpec = null; record.appendSystemPrompt = ''; record.lastStartFailure = null; record.deletion!.error = null; });
        return this.options.store.findConversation(id).conversation;
      } catch (error) {
        try { if (this.options.store.findConversation(id).conversation.state === 'deleting') await this.editConversation(id, (record) => { record.deletion!.error = detail(error); }); } catch {}
        throw error;
      }
    }));
  }
  private entry(id: string) { const entry = this.options.store.readCatalog().entries.find((entry) => entry.workspaceId === id); if (!entry) throw failure('workspace_missing', 'Workspace is not registered.'); return entry; }
  private editEntry(id: string, update: (entry: WorkspaceCatalogEntryV1) => void) { const catalog = this.options.store.readCatalog(); return this.options.store.editCatalog(catalog.revision, (value) => update(value.entries.find((entry) => entry.workspaceId === id)!)); }
  private manifest(entry: WorkspaceCatalogEntryV1) {
    const parsed = parseWorkspaceManifestStructured(readJsonObject(workspaceMetadataPath(entry.path, '.tau/workspace.json')));
    if (!parsed.ok || parsed.value.id !== entry.workspaceId) throw failure('metadata_corrupt', 'Deletion requires its original verified Manifest.');
    if (entry.deletion && parsed.value.revision !== entry.deletion.manifestRevision) throw failure('workspace_revision_conflict', 'Manifest changed after workspace deletion froze.');
    return parsed.value;
  }
  private async boundary(entry: WorkspaceCatalogEntryV1, keys: string[]) {
    if (fs.existsSync(entry.path)) {
      const identity = rootIdentity(entry.path);
      if (entry.deletion && identity !== entry.deletion.rootIdentity) throw failure('workspace_identity_conflict', 'The directory was replaced after deletion froze.');
    }
    const overlap = (directory: string) => isWithin(entry.path, directory) || isWithin(directory, entry.path);
    for (const other of this.options.store.readCatalog().entries) if (other.workspaceId !== entry.workspaceId && other.state !== 'deleted' && overlap(fs.existsSync(other.path) ? fs.realpathSync(other.path) : other.path)) throw failure('workspace_busy', 'Another registered workspace overlaps the deletion root.');
    for (const root of new Set(this.options.historyDirectories())) for (const source of historySources(root, () => {})) {
      try {
        const header = historyHeader(root, source.key);
        if (overlap(header.cwd) && (fs.realpathSync(root) !== fs.realpathSync(this.options.store.sessionsDirectory) || !keys.includes(source.key))) throw failure('workspace_busy', 'Another Native history references the deletion root.');
      } catch (error) {
        if ((error as { code?: string }).code === 'workspace_busy' || (error as { protectedPaths?: string[] }).protectedPaths?.some(overlap)) throw error;
      }
    }
    if (fs.existsSync(entry.path)) {
      const visit = async (directory: string): Promise<void> => {
        for (const item of await fs.promises.readdir(directory, { withFileTypes: true })) if (item.isDirectory() && !item.isSymbolicLink()) {
          const child = path.join(directory, item.name);
          if (fs.existsSync(path.join(child, '.tau/workspace.json'))) throw failure('workspace_busy', 'A nested workspace prevents recursive deletion.');
          await visit(child);
        }
      };
      await visit(entry.path); await assertWorkspaceProcessesStopped(entry.path, this.options.pythonCommand);
    }
  }
  workspace(id: string, input: Input) {
    this.input(input); this.options.assertSystemReady();
    const initial = this.entry(id);
    if (initial.deletion && initial.deletion.requestId !== input.requestId) throw failure('workspace_revision_conflict', 'A different request owns this workspace deletion.');
    if (initial.state === 'deleted') return this.leases.has(id) ? this.options.runtime.withWorkspaceStopped(initial.path, true, () => this.withLease(initial.path, id, async () => initial)) : Promise.resolve(initial);
    if (!initial.deletion) this.options.assertReady(id);
    return this.options.runtime.withWorkspaceStopped(initial.path, !!input.stopCurrent, () => this.withLease(initial.path, id, async () => {
      let entry = this.entry(id);
      try {
        if (!entry.deletion) {
          const manifest = this.manifest(entry);
          if (manifest.revision !== input.expectedRevision) throw failure('workspace_revision_conflict', 'Workspace changed before deletion.');
          const records = manifest.conversations.filter((record) => record.state !== 'deleted'), historyKeys = records.map((record) => record.history.key);
          if (records.some((record) => record.state === 'deleting')) throw failure('workspace_busy', 'Finish the recorded conversation deletion before deleting its workspace.');
          await this.boundary(entry, historyKeys);
          if (!this.options.verifyWorkspace(entry.path)) throw failure('workspace_ownership_unproven', 'This directory has no physical deletion ownership proof.');
          const owners = records.map((record) => this.owner(entry.path, record).key).filter((key): key is string => key !== null);
          await this.options.store.freezeWorkspaceDeletion(id, input.expectedRevision, { requestId: input.requestId, manifestRevision: manifest.revision, rootIdentity: rootIdentity(entry.path), conversationIds: manifest.conversations.map((record) => record.id), historyKeys: manifest.conversations.map((record) => record.history.key), invocationOwnerKeys: owners, error: null, stage: 'frozen' });
          entry = this.entry(id);
        }
        if (entry.deletion!.stage === 'frozen') {
          const manifest = this.manifest(entry), records = manifest.conversations.filter((record) => record.state !== 'deleted');
          if (workspaceCreationDigest(manifest.conversations.map((record) => record.history.key)) !== workspaceCreationDigest(entry.deletion!.historyKeys) || workspaceCreationDigest(manifest.conversations.map((record) => record.id)) !== workspaceCreationDigest(entry.deletion!.conversationIds)) throw failure('history_identity_mismatch', 'Frozen conversation or history targets changed.');
          const owners = records.map((record) => this.owner(entry.path, record));
          if (workspaceCreationDigest(owners.map((owner) => owner.key).filter(Boolean)) !== workspaceCreationDigest(entry.deletion!.invocationOwnerKeys)) throw failure('history_identity_mismatch', 'Frozen invocation owners changed.');
          for (const owner of owners) if (owner.context) await this.options.cleanupInvocations(owner.context);
          await this.editEntry(id, (value) => { value.deletion!.stage = 'invocations-cleaned'; value.deletion!.error = null; }); entry = this.entry(id);
        }
        if (entry.deletion!.stage === 'invocations-cleaned') {
          const manifest = this.manifest(entry);
          for (const key of entry.deletion!.historyKeys) {
            const file = workspaceMetadataPath(this.options.store.sessionsDirectory, key);
            if (fs.existsSync(file)) {
              const record = manifest.conversations.find((record) => record.history.key === key)!;
              if (record.state === 'deleted') throw failure('history_identity_mismatch', 'A deleted conversation history unexpectedly reappeared.');
              this.options.store.inspectHistory(entry.path, record);
            }
            await fs.promises.rm(file, { force: true });
          }
          await this.editEntry(id, (value) => { value.deletion!.stage = 'history-cleaned'; value.deletion!.error = null; }); entry = this.entry(id);
        }
        if (entry.deletion!.stage === 'history-cleaned') {
          await this.boundary(entry, []);
          if (fs.existsSync(entry.path)) { if (!this.options.verifyWorkspace(entry.path)) throw failure('workspace_ownership_unproven', 'Directory deletion ownership is unavailable.'); await this.options.removeWorkspace(entry.path); }
          await this.editEntry(id, (value) => { value.deletion!.stage = 'workspace-cleaned'; value.deletion!.error = null; });
        }
        await this.editEntry(id, (value) => { value.state = 'deleted'; }); return this.entry(id);
      } catch (error) { try { if (this.entry(id).state === 'deleting') await this.editEntry(id, (value) => { value.deletion!.error = detail(error); }); } catch {} throw error; }
    }));
  }
}
