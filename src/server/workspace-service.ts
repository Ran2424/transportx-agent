import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  conversationPlanPath, parseCreateConversationStructured, parseWorkspaceManifestStructured,
  type CreateConversationInput, type ConversationRecordV1, type WorkspaceDefaultsV1, type WorkspaceManifestV1,
  type WorkspaceCatalogEntryV1, type ResolvedSessionPlanV3, type SessionProfileV1,
} from '../contracts/index.js';
import { WorkspaceStore, workspaceCreationDigest, workspaceMetadataPath } from './workspace-store.js';
import { workspaceDirectoryPrefix } from './session-workspace.js';
import { readJsonObject, writeJsonAtomic, mutateJson } from './util/json-storage.js';
import { isWithin, toPosixPath } from './util/path.js';

type Configuration = { domainId: string; modelSpec: string; profile: SessionProfileV1 };
type Options = {
  store: WorkspaceStore;
  defaultParentDirectory: string;
  expandHome(value: string): string;
  assemble(configuration: Configuration, directory: string): ResolvedSessionPlanV3;
  validateModel(modelSpec: string): Promise<void>;
  assertReady(workspaceId?: string): void;
  assertAllocationAllowed(directory: string): void;
};
const failure = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });

/** Shared creation commits persistent identity before any caller may activate Pi. */
export class WorkspaceService {
  constructor(private options: Options) {}
  private configuration(input: CreateConversationInput, defaults: WorkspaceDefaultsV1): Configuration {
    const configuration = { domainId: input.domainId ?? defaults.domainId, modelSpec: input.model ?? defaults.modelSpec, profile: input.profile ?? defaults.profile };
    if (!configuration.domainId || !configuration.modelSpec || !configuration.profile || configuration.profile.modules.selectionMode !== 'explicit') throw failure('workspace_defaults_incomplete', 'Choose a domain, model and complete explicit profile before creating this conversation.');
    return configuration as Configuration;
  }
  private async prepare(input: CreateConversationInput, inputSha256: string, directory: string, defaultsRevision: number, configuration: Configuration, plan: ResolvedSessionPlanV3): Promise<ConversationRecordV1> {
    const id = `conv_${crypto.randomUUID()}`, at = new Date().toISOString();
    await this.options.store.savePlan(directory, id, { ...plan, workspace: directory });
    const sessionsRoot = this.options.store.sessionsDirectory;
    fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
    // Pi writes the JSONL itself but requires its parent directory to exist.
    fs.mkdirSync(workspaceMetadataPath(fs.realpathSync(sessionsRoot), 'transportx'), { recursive: true, mode: 0o700 });
    return {
      id, creationRequestId: input.requestId, creationInputSha256: inputSha256, name: input.name, createdAt: at, updatedAt: at,
      defaultsRevision, modelSpec: configuration.modelSpec, appendSystemPrompt: input.appendSystemPrompt || '', state: 'created',
      history: { key: this.options.store.newHistoryKey(id), headerId: null }, plan: { path: conversationPlanPath(id), source: 'created' },
      privateState: 'isolated', lastStartFailure: null, deletion: null,
    };
  }
  async create(value: unknown) {
    const parsed = parseCreateConversationStructured(value);
    if (!parsed.ok) throw Object.assign(failure('invalid_conversation_input', parsed.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; '), 400), { diagnostics: parsed.diagnostics });
    const input = parsed.value, inputSha256 = workspaceCreationDigest(input), { store } = this.options;
    this.options.assertReady(input.workspace.kind === 'existing' ? input.workspace.workspaceId : undefined);
    if (input.workspace.kind === 'existing') {
      const target = input.workspace;
      const current = store.readWorkspace(target.workspaceId);
      const existing = current.manifest.conversations.find((record) => record.creationRequestId === input.requestId);
      if (existing) {
        if (existing.creationInputSha256 !== inputSha256) throw failure('workspace_revision_conflict', 'Creation request ID was already used for different input.');
        return { ...current, conversation: existing };
      }
      if (current.manifest.revision !== target.expectedRevision || current.manifest.defaultsRevision !== target.defaultsRevision) throw failure('workspace_revision_conflict', 'Workspace or defaults changed; reload before creating a conversation.');
      const configuration = this.configuration(input, current.manifest.defaults);
      await this.options.validateModel(configuration.modelSpec);
      const plan = this.options.assemble(configuration, current.directory);
      return store.commitConversation(target.workspaceId, input.requestId, inputSha256, target.expectedRevision, target.defaultsRevision, async (manifest, directory) => {
        this.options.assertReady(target.workspaceId);
        return this.prepare(input, inputSha256, directory, manifest.defaultsRevision, configuration, plan);
      });
    }
    const target = input.workspace;
    const existing = store.readCatalog().entries.find((entry) => entry.creationRequestId === input.requestId);
    if (existing) {
      if (existing.creationInputSha256 !== inputSha256) throw failure('workspace_revision_conflict', 'Creation request ID was already used for different input.');
      return this.completeNew(existing, input, inputSha256);
    }
    const configuration = this.configuration(input, { domainId: null, modelSpec: null, profile: null });
    await this.options.validateModel(configuration.modelSpec);
    if (target.kind === 'folder') {
      const requested = this.options.expandHome(target.directory);
      if (!path.isAbsolute(requested) || !fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) throw failure('workspace_missing', 'Choose an existing absolute project directory.', 404);
      const directory = fs.realpathSync(requested);
      const data = fs.realpathSync(store.userDataDirectory), sessions = fs.existsSync(store.sessionsDirectory) ? fs.realpathSync(store.sessionsDirectory) : path.resolve(store.sessionsDirectory), projects = fs.existsSync(this.options.defaultParentDirectory) ? fs.realpathSync(this.options.defaultParentDirectory) : path.resolve(this.options.defaultParentDirectory);
      if (isWithin(directory, data) || isWithin(directory, sessions) || isWithin(sessions, directory) || isWithin(data, directory) && !isWithin(projects, directory)) throw failure('workspace_identity_conflict', 'Project directory overlaps private application data.');
      this.options.assertAllocationAllowed(directory);
      const plan = this.options.assemble(configuration, directory);
      const entry = await store.reserveWorkspace(input.requestId, inputSha256, (catalog) => {
        if (catalog.entries.some((item) => isWithin(item.path, directory) || isWithin(directory, item.path))) throw failure('workspace_identity_conflict', 'This folder overlaps a registered workspace; select that workspace instead.');
        if (fs.existsSync(workspaceMetadataPath(directory, '.tau'))) throw failure('workspace_migration_required', 'This folder already has .tau metadata; use its registered workspace or migration report.');
        return directory;
      }, 'external');
      return this.completeNew(entry, input, inputSha256, plan);
    }
    const requestedParent = this.options.expandHome(target.parentDirectory || this.options.defaultParentDirectory);
    if (!target.parentDirectory) fs.mkdirSync(requestedParent, { recursive: true });
    if (!fs.statSync(requestedParent).isDirectory()) throw failure('workspace_missing', 'Parent directory is unavailable.', 404);
    const parent = fs.realpathSync(requestedParent);
    // Assemble before reserving/creating a task directory so invalid modules leave no task.
    const plan = this.options.assemble(configuration, parent);
    const prefix = workspaceDirectoryPrefix(target.name);
    const entry = await store.reserveWorkspace(input.requestId, inputSha256, (catalog) => {
      for (let index = 1; index <= 999; index++) {
        const candidate = path.join(parent, index === 1 ? prefix : `${prefix}-${index}`);
        if (fs.existsSync(candidate) || catalog.entries.some((item) => isWithin(item.path, candidate) || isWithin(candidate, item.path))) continue;
        this.options.assertAllocationAllowed(candidate); return candidate;
      }
      throw failure('workspace_identity_conflict', 'Cannot allocate a unique task directory.');
    });
    return this.completeNew(entry, input, inputSha256, plan);
  }
  private completeNew(entry: WorkspaceCatalogEntryV1, input: CreateConversationInput, inputSha256: string, draft?: ResolvedSessionPlanV3) {
    const { store } = this.options;
    if (['deleting', 'deleted'].includes(entry.state)) return Promise.reject(failure('conversation_deleted', 'This creation request belongs to a deleted workspace.', 410));
    if (entry.state === 'ready') {
      const current = store.readWorkspace(entry.workspaceId);
      const conversation = current.manifest.conversations.find((record) => record.creationRequestId === input.requestId && record.creationInputSha256 === inputSha256);
      if (!conversation) return Promise.reject(failure('workspace_identity_conflict', 'Created workspace does not contain its original conversation.'));
      return Promise.resolve({ ...current, conversation });
    }
    // The reservation's parent is canonical even before the workspace exists.
    // This bootstrap lease never waits for a Pi process or holds a catalog lease.
    return mutateJson(path.join(path.dirname(entry.path), entry.directoryOwnership === 'external' ? `.transportx-register-${crypto.createHash('sha256').update(entry.path).digest('hex')}` : `.transportx-create-${entry.workspaceId}`), async () => {
      this.options.assertReady(); this.options.assertAllocationAllowed(entry.path);
      const external = entry.directoryOwnership === 'external';
      let created = false;
      try { if (!external) { fs.mkdirSync(entry.path, { mode: 0o700 }); created = true; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const directory = fs.realpathSync(entry.path);
      if (path.relative(directory, entry.path) !== '' || fs.lstatSync(entry.path).isSymbolicLink() || !fs.statSync(directory).isDirectory()) throw failure('workspace_identity_conflict', 'Reserved workspace path changed.');
      if (external) {
        try { fs.mkdirSync(workspaceMetadataPath(directory, '.tau'), { mode: 0o700 }); created = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      const marker = workspaceMetadataPath(directory, '.tau/workspace-owner.json');
      if (created) writeJsonAtomic(marker, { version: 1, workspace: toPosixPath(directory), parent: toPosixPath(fs.realpathSync(path.dirname(directory))), workspaceId: entry.workspaceId, creationRequestId: input.requestId, creationInputSha256: inputSha256, ...(external ? { directoryOwnership: 'external' } : {}) });
      else {
        const owner = readJsonObject(marker);
        if (owner.version !== 1 || owner.workspace !== toPosixPath(directory) || owner.workspaceId !== entry.workspaceId || owner.creationRequestId !== input.requestId || owner.creationInputSha256 !== inputSha256 || external && owner.directoryOwnership !== 'external') throw failure('workspace_creation_incomplete', 'Workspace creation is incomplete or its directory ownership is unconfirmed; inspect its recovery report.');
      }
      const file = workspaceMetadataPath(directory, '.tau/workspace.json');
      let manifest: WorkspaceManifestV1;
      if (fs.existsSync(file)) {
        const parsed = parseWorkspaceManifestStructured(readJsonObject(file));
        if (!parsed.ok || parsed.value.id !== entry.workspaceId) throw failure('metadata_corrupt', 'Incomplete workspace manifest is invalid.');
        manifest = parsed.value;
      } else {
        const configuration = this.configuration(input, { domainId: null, modelSpec: null, profile: null });
        const plan = draft || this.options.assemble(configuration, directory);
        const record = await this.prepare(input, inputSha256, directory, 0, configuration, plan);
        const at = new Date().toISOString();
        if (input.workspace.kind === 'existing') throw failure('invalid_conversation_input', 'New workspace input is required.');
        manifest = { schemaVersion: 1, id: entry.workspaceId, revision: 1, name: input.workspace.name, createdAt: at, updatedAt: at, defaultsRevision: 0, defaults: configuration, citationRegistryId: entry.workspaceId, conversations: [record] };
      }
      const conversation = manifest.conversations.find((record) => record.creationRequestId === input.requestId && record.creationInputSha256 === inputSha256);
      if (!conversation) throw failure('workspace_identity_conflict', 'Incomplete manifest does not match this creation request.');
      await store.publishWorkspace(entry.workspaceId, manifest);
      return { directory: toPosixPath(directory), manifest, conversation };
    });
  }
}
