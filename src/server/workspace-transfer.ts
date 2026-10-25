import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CITATION_REGISTRY_LIMIT, WORKSPACE_ID, parseCitationRegistryStructured, parseWorkspaceManifestStructured,
  type CitationRegistry, type CitationSourceVersion, type ConversationRecordV1, type WorkspaceManifestV1,
} from '../contracts/index.js';
import { WorkspaceStore, workspaceMetadataPath } from './workspace-store.js';
import { WorkspaceRuntimeGate } from './workspace-runtime.js';
import { ConversationRuntime } from './conversation-runtime.js';
import { readJsonObject, writeJsonAtomic } from './util/json-storage.js';
import { isWithin, toPosixPath } from './util/path.js';
import { conversationAttachmentIds, copySessionAttachments } from './session-attachments.js';

export const STANDALONE_NAME = 'Standalone';

type Options = {
  store: WorkspaceStore;
  runtime: ConversationRuntime;
  gate: WorkspaceRuntimeGate;
  assertSystemReady(): void;
  assertWorkspaceReady(workspaceId: string): void;
};
type Located = { directory: string; manifest: WorkspaceManifestV1; conversation: ConversationRecordV1; kind: 'standalone' | 'workspace' };
type MoveInput = { target: 'standalone' | string; stopCurrent?: boolean };

const failure = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Moves one durable conversation between workspaces. The Pi history keeps its reserved key;
 * its verified header cwd and the frozen plan workspace are the only identity fields that move.
 */
export class WorkspaceTransfer {
  private chain: Promise<unknown> = Promise.resolve();
  private recovered = false;
  constructor(private options: Options) {}

  private run<T>(execute: () => Promise<T>): Promise<T> {
    const operation = this.chain.catch(() => {}).then(execute);
    this.chain = operation.catch(() => {});
    return operation;
  }

  /** Waits for an in-flight move so the index never observes the two-manifest commit window. */
  settled() { return this.chain.catch(() => {}); }

  private locate(conversationId: string): Located[] {
    const matches: Located[] = [];
    for (const entry of this.options.store.readCatalog().entries) {
      if (entry.state !== 'ready') continue;
      let workspace: { directory: string; manifest: WorkspaceManifestV1 };
      try { workspace = this.options.store.readWorkspace(entry.workspaceId); } catch { continue; }
      const conversation = workspace.manifest.conversations.find((record) => record.id === conversationId);
      if (conversation) matches.push({ ...workspace, conversation, kind: entry.kind === 'standalone' ? 'standalone' : 'workspace' });
    }
    return matches;
  }

  /**
   * A move commits the target record before it removes the source record. A process crash can
   * therefore leave the same conversation in both manifests. The verified history header cwd is
   * the authoritative owner; recycle the non-owning record before any business projection runs.
   */
  async recover() {
    if (this.recovered) return;
    this.options.assertSystemReady();
    const byId = new Map<string, Located[]>();
    for (const entry of this.options.store.readCatalog().entries) {
      if (entry.state !== 'ready') continue;
      let workspace: { directory: string; manifest: WorkspaceManifestV1 };
      try { workspace = this.options.store.readWorkspace(entry.workspaceId); } catch { continue; }
      for (const conversation of workspace.manifest.conversations) {
        byId.set(conversation.id, [...(byId.get(conversation.id) || []), { ...workspace, conversation, kind: entry.kind === 'standalone' ? 'standalone' : 'workspace' }]);
      }
    }
    for (const [conversationId, matches] of byId) {
      if (matches.length < 2 || matches.some((match) => ['deleting', 'deleted'].includes(match.conversation.state))) continue;
      let owners: Located[];
      try {
        const headerCwd = fs.realpathSync(this.historyHeaderCwd(matches[0].conversation));
        owners = matches.filter((match) => fs.realpathSync(match.directory) === headerCwd);
      } catch {
        // A conversation that never wrote Pi history has no header owner. The target commit
        // stamps updatedAt, so the newest record is the committed side of the crash window.
        if (matches.some((match) => match.conversation.history.headerId !== null)) continue;
        const root = fs.existsSync(this.options.store.sessionsDirectory) ? fs.realpathSync(this.options.store.sessionsDirectory) : path.resolve(this.options.store.sessionsDirectory);
        if (fs.existsSync(workspaceMetadataPath(root, matches[0].conversation.history.key))) continue;
        const ordered = [...matches].sort((left, right) => Date.parse(right.conversation.updatedAt) - Date.parse(left.conversation.updatedAt));
        if (!(Date.parse(ordered[0].conversation.updatedAt) > Date.parse(ordered[1].conversation.updatedAt))) continue;
        owners = [ordered[0]];
      }
      if (owners.length !== 1) continue;
      for (const match of matches.filter((candidate) => candidate !== owners[0])) {
        await this.options.gate.serialize(match.directory, async () => {
          await this.edit(match.manifest.id, (manifest) => {
            const index = manifest.conversations.findIndex((record) => record.id === conversationId);
            if (index >= 0) manifest.conversations.splice(index, 1);
          });
          try { fs.rmSync(workspaceMetadataPath(match.directory, `.tau/conversations/${conversationId}`), { recursive: true, force: true }); } catch {}
        });
      }
    }
    this.recovered = true;
  }

  private historyHeaderCwd(record: ConversationRecordV1) {
    const root = fs.existsSync(this.options.store.sessionsDirectory) ? fs.realpathSync(this.options.store.sessionsDirectory) : path.resolve(this.options.store.sessionsDirectory);
    const file = workspaceMetadataPath(root, record.history.key);
    const descriptor = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024), count = fs.readSync(descriptor, buffer, 0, buffer.length, 0), end = buffer.subarray(0, count).indexOf(10);
      if (end < 0) throw failure('history_identity_mismatch', 'Pi history has no complete header.');
      const header = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      if (header?.type !== 'session' || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)) throw failure('history_identity_mismatch', 'Pi history header is invalid.');
      return header.cwd;
    } finally { fs.closeSync(descriptor); }
  }

  private async edit(workspaceId: string, update: (manifest: WorkspaceManifestV1) => void) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = this.options.store.readWorkspace(workspaceId);
      try { return await this.options.store.editWorkspace(workspaceId, current.manifest.revision, update); }
      catch (error) {
        if ((error as { code?: string }).code !== 'workspace_revision_conflict' || attempt === 7) throw error;
      }
    }
    throw failure('workspace_revision_conflict', 'Workspace changed while moving the conversation.');
  }

  private async ensureStandalone(source: Located) {
    const directory = path.join(this.options.store.userDataDirectory, 'standalone', source.conversation.id);
    const canonical = toPosixPath(directory);
    const previous = this.options.store.readCatalog().entries.find((entry) => entry.kind === 'standalone' && entry.path === canonical);
    if (previous?.state === 'ready') {
      const workspace = this.options.store.readWorkspace(previous.workspaceId);
      const other = workspace.manifest.conversations.find((record) => record.id !== source.conversation.id && record.state !== 'deleted');
      if (other) throw failure('workspace_identity_conflict', 'Standalone workspace already contains another conversation.');
      return { ...workspace, conversation: source.conversation, kind: 'standalone' as const };
    }
    if (previous && !['creating'].includes(previous.state)) throw failure('workspace_revision_conflict', 'Standalone workspace is being removed; retry after its cleanup.');
    const workspaceId = previous?.workspaceId || `ws_${crypto.randomUUID()}`;
    if (fs.existsSync(directory)) {
      if (!fs.statSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw failure('workspace_identity_conflict', 'Standalone workspace path is not a plain directory.');
      if (fs.existsSync(workspaceMetadataPath(directory, '.tau/workspace.json')) && !previous) throw failure('workspace_identity_conflict', 'An unregistered standalone workspace already occupies this path.');
    } else {
      fs.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      fs.mkdirSync(directory, { mode: 0o700 });
    }
    const real = fs.realpathSync(directory);
    fs.mkdirSync(workspaceMetadataPath(real, '.tau'), { recursive: true, mode: 0o700 });
    const marker = workspaceMetadataPath(real, '.tau/workspace-owner.json');
    if (!fs.existsSync(marker)) writeJsonAtomic(marker, { version: 1, workspace: toPosixPath(real), parent: toPosixPath(fs.realpathSync(path.dirname(real))) });
    const entry = previous || await this.options.store.reserveStandaloneWorkspace(workspaceId, real);
    const file = workspaceMetadataPath(real, '.tau/workspace.json');
    if (!fs.existsSync(file)) {
      const at = new Date().toISOString();
      await this.options.store.publishWorkspace(entry.workspaceId, {
        schemaVersion: 1, id: entry.workspaceId, revision: 1, name: STANDALONE_NAME, createdAt: at, updatedAt: at,
        defaultsRevision: 0, defaults: source.manifest.defaults, citationRegistryId: source.manifest.citationRegistryId, conversations: [],
      });
    } else if (entry.state === 'creating') {
      const existing = parseWorkspaceManifestStructured(readJsonObject(file));
      if (!existing.ok || existing.value.id !== entry.workspaceId) throw failure('metadata_corrupt', 'Incomplete standalone workspace manifest is invalid.');
      await this.options.store.publishWorkspace(entry.workspaceId, existing.value);
    }
    const workspace = this.options.store.readWorkspace(entry.workspaceId);
    const other = workspace.manifest.conversations.find((record) => record.id !== source.conversation.id && record.state !== 'deleted');
    if (other) throw failure('workspace_identity_conflict', 'Standalone workspace already contains another conversation.');
    return { ...workspace, conversation: source.conversation, kind: 'standalone' as const };
  }

  private async target(input: MoveInput, source: Located): Promise<Located> {
    if (input.target === 'standalone') {
      if (source.kind === 'standalone') return source;
      return this.ensureStandalone(source);
    }
    if (!WORKSPACE_ID.test(input.target)) throw failure('invalid_move_target', 'Choose a registered workspace or the standalone destination.', 400);
    if (source.manifest.id === input.target) return source;
    this.options.assertWorkspaceReady(input.target);
    const entry = this.options.store.readCatalog().entries.find((candidate) => candidate.workspaceId === input.target);
    if (!entry || entry.kind === 'standalone') throw failure('workspace_missing', 'Target workspace is unavailable.', 404);
    const workspace = this.options.store.readWorkspace(input.target);
    return { ...workspace, conversation: source.conversation, kind: 'workspace' };
  }

  private preparePrivateState(source: Located, target: Located) {
    const relative = `.tau/conversations/${source.conversation.id}`;
    const from = workspaceMetadataPath(source.directory, relative), to = workspaceMetadataPath(target.directory, relative);
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
  }

  private async prepareCitations(source: Located, target: Located) {
    const sourceFile = workspaceMetadataPath(source.directory, '.tau/citations.json');
    if (!fs.existsSync(sourceFile)) return;
    const parsedSource = parseCitationRegistryStructured(readJsonObject(sourceFile));
    if (!parsedSource.ok) throw failure('metadata_corrupt', 'Source citation registry is invalid; the conversation cannot be moved safely.');
    const targetFile = workspaceMetadataPath(target.directory, '.tau/citations.json');
    const targetRegistry = fs.existsSync(targetFile) ? parseCitationRegistryStructured(readJsonObject(targetFile)) : null;
    if (targetRegistry && !targetRegistry.ok) throw failure('metadata_corrupt', 'Target citation registry is invalid; the conversation cannot be moved safely.');
    const before = targetRegistry?.value;
    const sources = before ? [...before.sources] : [], evidence = before ? [...before.evidence] : [];
    const sourceIds = new Set(sources.map((item) => item.sourceVersionId));
    const conflicts = new Set<string>();
    for (const candidate of parsedSource.value.sources) {
      const current = sources.find((item) => item.sourceVersionId === candidate.sourceVersionId);
      if (current && JSON.stringify(current) !== JSON.stringify(candidate)) { conflicts.add(candidate.sourceVersionId); continue; }
      if (!current) { sources.push(candidate); sourceIds.add(candidate.sourceVersionId); }
    }
    for (const candidate of parsedSource.value.evidence) {
      if (conflicts.has(candidate.sourceVersionId) || !sourceIds.has(candidate.sourceVersionId)) continue;
      if (!evidence.some((item) => item.evidenceId === candidate.evidenceId)) evidence.push(candidate);
    }
    for (const sourceVersion of parsedSource.value.sources) this.copyCitationFile(source, target, sourceVersion);
    const merged: CitationRegistry = { schemaVersion: 2, sessionId: target.manifest.citationRegistryId, protocol: parsedSource.value.protocol, version: parsedSource.value.version, sources, evidence };
    const validated = parseCitationRegistryStructured(merged);
    if (!validated.ok) throw failure('metadata_corrupt', 'Merged citation registry is invalid.');
    const serialized = JSON.stringify(validated.value);
    if (Buffer.byteLength(serialized) > CITATION_REGISTRY_LIMIT) throw failure('citation_registry_too_large', 'Citation registry exceeds 8 MiB and cannot be merged safely.');
    if (JSON.stringify(before) !== serialized) writeJsonAtomic(targetFile, validated.value);
  }

  private copyCitationFile(source: Located, target: Located, entry: CitationSourceVersion) {
    if (entry.content.kind !== 'file' || entry.content.scope !== 'session') return;
    if (!entry.content.path.startsWith('.tau/')) return;
    const origin = path.resolve(source.directory, entry.content.path), destination = path.resolve(target.directory, entry.content.path);
    if (!isWithin(source.directory, origin) || !isWithin(target.directory, destination) || !fs.existsSync(origin) || !fs.lstatSync(origin).isFile() || fs.lstatSync(origin).isSymbolicLink()) return;
    if (hashFile(origin) !== entry.content.sha256) return;
    if (fs.existsSync(destination)) {
      if (!fs.lstatSync(destination).isFile() || fs.lstatSync(destination).isSymbolicLink() || hashFile(destination) !== entry.content.sha256) throw failure('citation_resource_conflict', 'A cited file already exists with different content in the target workspace.');
      return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(origin, destination, fs.constants.COPYFILE_EXCL);
  }

  async move(conversationId: string, input: MoveInput) {
    if (!input || (input.target !== 'standalone' && (typeof input.target !== 'string' || !WORKSPACE_ID.test(input.target))) || input.stopCurrent !== undefined && typeof input.stopCurrent !== 'boolean') throw failure('invalid_move_input', 'Choose a registered workspace or the standalone destination.', 400);
    return this.run(async () => {
      this.options.assertSystemReady();
      await this.recover();
      const matches = this.locate(conversationId);
      if (!matches.length) throw failure('conversation_missing', 'Conversation is unavailable.', 404);
      if (matches.length > 1) throw failure('workspace_identity_conflict', 'Conversation appears in more than one workspace; run the index diagnostics before moving it.');
      const source = matches[0];
      if (['deleting', 'deleted'].includes(source.conversation.state)) throw failure('conversation_missing', 'Conversation is being deleted.', 404);
      this.options.assertWorkspaceReady(source.manifest.id);
      const target = await this.target(input, source);
      if (target.manifest.id === source.manifest.id) return { ...target, conversation: source.conversation, standalone: target.kind === 'standalone' };
      await this.options.runtime.close(conversationId, input.stopCurrent === true);
      const commit = async () => {
        try {
          this.options.store.inspectHistory(source.directory, source.conversation);
          this.preparePrivateState(source, target);
          if (source.conversation.plan) await this.options.store.relocatePlan(source.directory, source.conversation, target.directory);
          copySessionAttachments(source.directory, target.directory, conversationAttachmentIds(source.directory, conversationId));
          await this.prepareCitations(source, target);
          await this.edit(target.manifest.id, (manifest) => {
            if (manifest.conversations.some((record) => record.id === conversationId)) return;
            if (manifest.conversations.some((record) => record.history.key === source.conversation.history.key)) throw failure('workspace_identity_conflict', 'Target workspace already reserves this conversation history.');
            manifest.conversations.push(structuredClone({ ...source.conversation, updatedAt: new Date().toISOString() }));
          });
          this.options.store.relocateHistory(source.conversation, source.directory, target.directory);
          await this.edit(source.manifest.id, (manifest) => {
            const index = manifest.conversations.findIndex((record) => record.id === conversationId);
            if (index < 0) return;
            if (manifest.conversations[index].state === 'deleting') throw failure('conversation_missing', 'Conversation deletion started before the move completed.', 409);
            manifest.conversations.splice(index, 1);
          });
          const relative = `.tau/conversations/${conversationId}`;
          // The manifest is already authoritative; leftover private bytes are harmless and retried on the next move.
          if (target.directory !== source.directory) try { fs.rmSync(workspaceMetadataPath(source.directory, relative), { recursive: true, force: true }); } catch {}
          const current = this.options.store.readWorkspace(target.manifest.id);
          const conversation = current.manifest.conversations.find((record) => record.id === conversationId)!;
          return { ...current, conversation, kind: target.kind, standalone: target.kind === 'standalone' };
        } catch (error) {
          this.recovered = false;
          throw error;
        }
      };
      if (source.directory === target.directory) return commit();
      return this.options.gate.serialize(source.directory, () => this.options.gate.serialize(target.directory, commit));
    });
  }
}
