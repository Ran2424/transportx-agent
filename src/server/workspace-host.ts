import fs from 'node:fs';
import path from 'node:path';
import type { CreateConversationInput, SessionProfileV1, ResolvedSessionPlanV3, WorkspaceDefaultsV1 } from '../contracts/index.js';
import { WorkspaceStore, workspaceCreationDigest, workspaceMetadataPath } from './workspace-store.js';
import { WorkspaceMigration } from './workspace-migration.js';
import { WorkspaceMigrationRunner } from './workspace-migration-runner.js';
import { WorkspaceRuntimeGate } from './workspace-runtime.js';
import { WorkspaceService } from './workspace-service.js';
import { WorkspaceDeletion } from './workspace-deletion.js';
import { WorkspaceTransfer } from './workspace-transfer.js';
import { ConversationRuntime } from './conversation-runtime.js';
import type { LiveSessionManager } from './sessions.js';
import { readSessionSummary, searchSessionFile } from './session-history-reader.js';
import { isWithin, relativePosixPath } from './util/path.js';
import { asRecord } from '../contracts/common.js';
import { historicalResourceLinks } from './historical-resource-links.js';

type Configuration = { domainId: string; modelSpec: string; profile: SessionProfileV1 };
type Options = {
  store: WorkspaceStore; migration: WorkspaceMigration; runner: WorkspaceMigrationRunner; gate: WorkspaceRuntimeGate;
  runtime: ConversationRuntime; creation: WorkspaceService; deletion: WorkspaceDeletion; transfer?: WorkspaceTransfer; sessions: LiveSessionManager;
  assemble(configuration: Configuration, directory: string): ResolvedSessionPlanV3;
  validateModel(model: string): Promise<void>;
  beginOperation(): () => void;
};
const problem = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });
const name = (value: unknown) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw problem('invalid_name', 'Name must contain 1–120 characters.', 400); return value.trim(); };
const revision = (value: unknown): number => { if (!Number.isSafeInteger(value) || Number(value) < 0) throw problem('workspace_revision_conflict', 'A current revision is required.'); return Number(value); };

/** Persistent API authority. A real live instance is required only for execution/advanced views. */
export class WorkspaceHost {
  private background: Promise<unknown> | null = null;
  constructor(readonly options: Options) {}
  migrationStatus() { let inventory = null; try { inventory = this.options.migration.read(); } catch {} return { ...this.options.migration.status(), inventory }; }
  startConversions() {
    if (this.background) return this.background;
    const complete = this.options.beginOperation();
    const task = this.options.runner.convertPending(); this.background = task;
    task.finally(() => { complete(); if (this.background === task) this.background = null; }).catch(() => {}); return task;
  }
  target(id: string) { const target = this.options.store.findConversation(id); this.options.migration.assertWorkspaceReady(target.manifest.id); if (['deleted', 'deleting'].includes(target.conversation.state)) throw problem('conversation_missing', 'Conversation is unavailable.', 404); return target; }
  live(id: string, required = true) {
    const target = this.target(id);
    const session = this.boundRuntime(id, target.manifest.id);
    if (!session && required) throw problem('conversation_not_active', 'Activate this conversation explicitly to use this view.');
    return session || null;
  }
  private boundRuntime(id: string, workspaceId: string) { return [...this.options.sessions.sessions.values()].find((session) => session.conversationId === id && session.workspaceId === workspaceId && !session.terminating && session.lifecycle?.isReady(session)); }
  async workspace(id: string) {
    this.options.migration.assertSystemReady();
    return this.projectWorkspace(id, this.options.migration.read(), this.options.store.readCatalog());
  }
  private async projectWorkspace(id: string, state: ReturnType<WorkspaceMigration['read']>, catalog: ReturnType<WorkspaceStore['readCatalog']>) {
    const source = state.items.find((item) => item.workspaceId === id);
    const entry = catalog.entries.find((entry) => entry.workspaceId === id);
    const unavailable = (code: string, message: string, itemId?: string) => ({ id, path: entry?.path || source?.path || '', name: path.basename(entry?.path || source?.path || '') || id, revision: source?.revision ?? null, defaultsRevision: null, defaults: null, conversations: [], availability: source?.state === 'isolated' ? 'isolated' : entry?.state === 'deleting' ? 'deleting' : 'blocked', kind: entry?.kind === 'standalone' ? 'standalone' : 'workspace', migrationItemId: itemId || source?.id || null, error: { code, message }, directoryOwnership: entry?.directoryOwnership, deletion: entry?.deletion || null });
    if (!entry && !source) throw problem('workspace_missing', 'Workspace is not registered.', 404);
    if (entry?.state === 'deleted') throw problem('workspace_missing', 'Workspace was deleted.', 404);
    if (source && source.state !== 'ready') return unavailable('workspace_migration_required', 'Workspace migration is incomplete.', source.id);
    try { this.options.migration.assertWorkspaceReady(id); }
    catch (error) { return unavailable((error as { code?: string }).code || 'workspace_migration_required', (error as Error).message, (error as { itemId?: string }).itemId); }
    const { directory, manifest } = this.options.store.readWorkspace(id);
    const conversations = await Promise.all(manifest.conversations.filter((record) => record.state !== 'deleted').map(async (record) => {
      const runtime = record.state === 'deleting' ? null : this.boundRuntime(record.id, id);
      let lastConversationAt: string | null = runtime?.lastConversationAt || null;
      let hasMessages: boolean | null = !!runtime?.entries.some((entry) => ['user', 'assistant'].includes(String(asRecord(entry.message)?.role || '')));
      try { const history = this.options.store.inspectHistory(directory, record); if (history.sessionFile) { const summary = await readSessionSummary(history.sessionFile, (cwd) => typeof cwd === 'string' ? cwd : null); hasMessages = hasMessages || summary?.hasMessages || (summary ? false : null); if (typeof summary?.lastConversationAt === 'string' && summary.lastConversationAt && (!lastConversationAt || summary.lastConversationAt > lastConversationAt)) lastConversationAt = summary.lastConversationAt; } } catch { if (!hasMessages) hasMessages = null; }
      return { record, runtime: runtime?.metadata() || null, lastConversationAt, hasMessages };
    }));
    return { id, path: directory, name: manifest.name, createdAt: manifest.createdAt, revision: manifest.revision, defaultsRevision: manifest.defaultsRevision, defaults: manifest.defaults, conversations, availability: 'ready', kind: entry!.kind === 'standalone' ? 'standalone' : 'workspace', migrationItemId: source?.id || null, error: null, directoryOwnership: entry!.directoryOwnership, deletion: entry!.deletion };
  }
  async index() {
    this.options.migration.assertSystemReady();
    await this.options.transfer?.settled();
    await this.options.transfer?.recover();
    const catalog = this.options.store.readCatalog(), state = this.options.migration.read();
    const ids = new Set([...catalog.entries.filter((entry) => entry.state !== 'deleted' && (entry.kind === 'standalone' || entry.creationRequestId !== null || this.options.migration.includesWorkspace(entry.path, state.scopes))).map((entry) => entry.workspaceId), ...state.items.filter((item) => item.workspaceId && !catalog.entries.some((entry) => entry.workspaceId === item.workspaceId && entry.state === 'deleted')).map((item) => item.workspaceId!)]);
    const workspaces = [];
    for (const id of ids) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const workspace = await this.projectWorkspace(id, state, catalog);
      // Empty standalone reservations are storage details, not visible groups.
      if (workspace.kind !== 'standalone' || workspace.conversations.length) workspaces.push(workspace);
    }
    return { schemaVersion: 1, workspaces, migration: this.options.migration.status(), sources: state.items.filter((item) => !item.workspaceId) };
  }
  snapshot(id: string) { const target = this.target(id), result = this.options.runtime.snapshot(id); return { ...result, resourceLinks: historicalResourceLinks(result.snapshot.entries, id, target.directory, (value) => this.file(id, value)) }; }
  async search(query: string) {
    this.options.migration.assertSystemReady(); if (!query.trim()) return { results: [] };
    const results = [];
    for (const entry of this.options.store.readCatalog().entries) {
      if (entry.state !== 'ready') continue;
      try {
        this.options.migration.assertWorkspaceReady(entry.workspaceId);
        const { directory, manifest } = this.options.store.readWorkspace(entry.workspaceId);
        for (const record of manifest.conversations) if (!['deleted', 'deleting'].includes(record.state)) {
          const history = this.options.store.inspectHistory(directory, record), match = history.sessionFile ? await searchSessionFile(history.sessionFile, query, (cwd) => typeof cwd === 'string' ? cwd : null) : null;
          if (match || record.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) results.push({ workspaceId: entry.workspaceId, conversationId: record.id, name: record.name, matches: match?.matches || [] });
        }
      } catch {}
    }
    return { results };
  }
  file(id: string, requested?: string | null) {
    const { directory } = this.target(id), candidate = path.resolve(directory, requested || '.');
    let resolved: string;
    try { resolved = fs.realpathSync(candidate); }
    catch (error) { if (!isWithin(directory, candidate)) throw problem('resource_forbidden', 'File is outside the ordinary workspace file scope.', 403); const code = (error as NodeJS.ErrnoException).code; if (code === 'ENOENT' || code === 'ENOTDIR') throw problem('resource_missing', 'Workspace file is unavailable.', 404); if (code === 'EACCES' || code === 'EPERM') throw problem('resource_forbidden', 'Workspace file cannot be read.', 403); throw error; }
    const relative = relativePosixPath(directory, resolved);
    if (!isWithin(directory, resolved) || relative === '.tau' || relative.startsWith('.tau/')) throw problem('resource_forbidden', 'File is outside the ordinary workspace file scope.', 403);
    return resolved;
  }
  async renameConversation(id: string, input: Record<string, unknown>) {
    const target = this.target(id), next = name(input.name), expected = revision(input.expectedRevision);
    return this.options.gate.serialize(target.directory, async () => {
      this.target(id);
      const manifest = await this.options.store.editWorkspace(target.manifest.id, expected, (value) => { value.conversations.find((record) => record.id === id)!.name = next; });
      const session = this.live(id, false); if (session) { session.setSessionName(next); session.pendingSessionNamePersistence = next; session.persistPendingSessionName(); this.options.sessions.broadcastUpdated(session.id); }
      return { conversation: manifest.conversations.find((record) => record.id === id), revision: manifest.revision };
    });
  }
  async editWorkspace(id: string, input: Record<string, unknown>) {
    this.options.migration.assertWorkspaceReady(id);
    const target = this.options.store.readWorkspace(id);
    if (('name' in input) === ('defaults' in input)) throw problem('invalid_workspace_input', 'Edit either name or complete defaults.', 400);
    return this.options.gate.serialize(target.directory, async () => {
      this.options.migration.assertWorkspaceReady(id);
      if ('name' in input) return this.options.store.editWorkspace(id, revision(input.expectedRevision), (value) => { value.name = name(input.name); });
      const defaults = input.defaults as WorkspaceDefaultsV1;
      if (!defaults || !['domainId', 'modelSpec', 'profile'].every((key) => key in defaults)) throw problem('invalid_workspace_input', 'Complete workspace defaults are required.', 400);
      if (defaults.modelSpec) await this.options.validateModel(defaults.modelSpec);
      if (defaults.domainId && defaults.modelSpec && defaults.profile) this.options.assemble({ domainId: defaults.domainId, modelSpec: defaults.modelSpec, profile: defaults.profile }, target.directory);
      return this.options.store.updateDefaults(id, revision(input.expectedDefaultsRevision), defaults);
    });
  }
  async activate(id: string, input: Record<string, unknown>) {
    const target = this.target(id), confirmation = input.confirmCurrentConfiguration as (Configuration & { expectedRevision: number }) | undefined;
    if (confirmation) await this.options.gate.serialize(target.directory, async () => {
      const current = this.target(id); if (current.conversation.plan) throw problem('workspace_revision_conflict', 'This conversation already has its frozen plan.');
      const source = this.options.migration.read().items.find((item) => item.workspaceId === current.manifest.id);
      const report = source ? (await this.options.runner.report(source.id)).prepared : null;
      if (!Array.isArray(report?.notes) || !report.notes.some((note) => (note as { code?: string }).code === 'legacy_plan_requires_confirmation')) throw problem('invalid_session_plan', 'This plan error cannot be replaced with current configuration.');
      await this.options.validateModel(confirmation.modelSpec);
      let plan = this.options.assemble(confirmation, current.directory);
      const pointer = { path: `conversations/${id}/plan.json`, source: 'confirmed-current' as const }, file = workspaceMetadataPath(current.directory, `.tau/${pointer.path}`);
      if (fs.existsSync(file)) {
        const previous = this.options.store.readPlan(current.directory, { ...current.conversation, plan: pointer });
        if (workspaceCreationDigest(previous.profile) !== workspaceCreationDigest(plan.profile) || previous.domain.id !== plan.domain.id) throw problem('workspace_revision_conflict', 'A different confirmation plan is already saved.');
        plan = previous;
      }
      await this.options.store.editWorkspace(current.manifest.id, revision(confirmation.expectedRevision), async (manifest) => {
        const record = manifest.conversations.find((record) => record.id === id)!;
        if (record.plan || ['deleting', 'deleted'].includes(record.state)) throw problem('workspace_revision_conflict', 'Conversation changed before confirmation.');
        await this.options.store.savePlan(current.directory, id, plan);
        record.plan = pointer; record.modelSpec = confirmation.modelSpec;
      });
    });
    return { runtime: (await this.options.runtime.activate(id, input.stopCurrent === true)).metadata() };
  }
  create(input: CreateConversationInput) { return this.options.creation.create(input); }
  async moveConversation(id: string, input: Record<string, unknown>) {
    if (typeof input.target !== 'string') throw problem('invalid_move_input', 'Choose a registered workspace or the standalone destination.', 400);
    if (!this.options.transfer) throw problem('system_not_ready', 'Conversation transfer is unavailable in this Host.', 503);
    const result = await this.options.transfer.move(id, { target: input.target, stopCurrent: input.stopCurrent === true });
    return { workspace: { id: result.manifest.id, path: result.directory, revision: result.manifest.revision }, conversation: result.conversation, runtime: null, standalone: result.standalone };
  }
}
