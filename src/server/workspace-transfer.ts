import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  CITATION_REGISTRY_LIMIT, CONVERSATION_ID, WORKSPACE_ID, parseCitationRegistryStructured, parseWorkspaceManifestStructured,
  type CitationRegistry, type CitationSourceVersion, type ConversationRecordV1, type WorkspaceManifestV1,
} from '../contracts/index.js';
import { WorkspaceStore, workspaceMetadataPath, workspaceCreationDigest } from './workspace-store.js';
import { WorkspaceRuntimeGate, type WorkspaceRuntimeLease } from './workspace-runtime.js';
import { ConversationRuntime } from './conversation-runtime.js';
import { readJsonObject, writeJsonAtomic } from './util/json-storage.js';
import { isWithin, toPosixPath, relativePosixPath } from './util/path.js';
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
type MoveSide = { workspaceId: string; directory: string; rootIdentity: string; generation: string; record: ConversationRecordV1; privateFiles: Record<string, string> | null };
type MoveJournal = { schemaVersion: 1; conversationId: string; source: MoveSide; target: MoveSide; historyExists: boolean };

const failure = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });
const hashFile = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rootIdentity = (directory: string) => { const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('workspace_identity_conflict', 'Move directory is no longer a plain directory.'); return workspaceCreationDigest([stat.dev, stat.ino, stat.birthtimeMs]); };

/** Current intents block business until startup recovery has made the manifests unique. */
export function pendingWorkspaceTransfers(userDataDirectory: string) {
  const directory = workspaceMetadataPath(userDataDirectory, 'transfers');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => {
    if (name.endsWith('.json.bak') && CONVERSATION_ID.test(name.slice(0, -9))) return false;
    if (/\.json(?:\.bak)?\.[a-f0-9-]{36}\.tmp$/.test(name) && CONVERSATION_ID.test(name.split('.json')[0])) return false;
    if (!name.endsWith('.json') || !CONVERSATION_ID.test(name.slice(0, -5))) throw failure('metadata_corrupt', 'Unknown conversation transfer metadata.');
    return true;
  }).map((name) => workspaceMetadataPath(directory, name));
}

/**
 * Moves one durable conversation between workspaces. The Pi history keeps its reserved key;
 * its verified header cwd and the frozen plan workspace are the only identity fields that move.
 */
export class WorkspaceTransfer {
  private chain: Promise<unknown> = Promise.resolve();
  private recovery: Promise<void> | null = null;
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

  /** Called by inventory before duplicate-identity checks, without requiring global ready. */
  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    const task = (async () => {
      for (const file of pendingWorkspaceTransfers(this.options.store.userDataDirectory)) {
        const journal = readJsonObject(file) as unknown as MoveJournal;
        const invalid = () => failure('metadata_corrupt', 'Conversation move intent cannot be verified.');
        if (journal.schemaVersion !== 1 || !CONVERSATION_ID.test(journal.conversationId) || path.basename(file) !== `${journal.conversationId}.json` || typeof journal.historyExists !== 'boolean') throw invalid();
        const sides = [journal.source, journal.target];
        for (const side of sides) {
          if (!side || !WORKSPACE_ID.test(side.workspaceId) || typeof side.directory !== 'string' || typeof side.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(side.generation) || side.rootIdentity !== rootIdentity(side.directory)) throw invalid();
          const current = this.options.store.readWorkspace(side.workspaceId);
          if (current.directory !== side.directory || side.record?.id !== journal.conversationId || !parseWorkspaceManifestStructured({ ...current.manifest, conversations: [side.record] }).ok) throw invalid();
          if (side.privateFiles !== null && (!side.privateFiles || typeof side.privateFiles !== 'object' || Array.isArray(side.privateFiles) || !Object.values(side.privateFiles).every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))) throw invalid();
        }
        if (journal.source.workspaceId === journal.target.workspaceId || journal.source.record.history.key !== journal.target.record.history.key) throw invalid();
        for (const side of sides) {
          const runtime = this.options.gate.diagnostics(side.directory);
          if (runtime.phase !== 'stopped') {
            if (!('generation' in runtime) || runtime.generation !== side.generation) throw failure('workspace_busy', 'Another runtime generation owns a pending move directory.');
            // Only the exact maintenance generation recorded in this intent
            // may be rechecked. This never signals or adopts a running Host.
            await this.options.gate.recover(side.directory, side.generation, 'recheck');
          }
        }
        await this.locked(sides, false, async (leases) => {
          const source = this.options.store.readWorkspace(journal.source.workspaceId), target = this.options.store.readWorkspace(journal.target.workspaceId);
          const before = source.manifest.conversations.find((record) => record.id === journal.conversationId), after = target.manifest.conversations.find((record) => record.id === journal.conversationId);
          if (before && workspaceCreationDigest(before) !== workspaceCreationDigest(journal.source.record) || after && workspaceCreationDigest(after) !== workspaceCreationDigest(journal.target.record)) throw invalid();
          const history = workspaceMetadataPath(this.options.store.sessionsDirectory, journal.target.record.history.key);
          if (fs.existsSync(history) !== journal.historyExists) throw failure('history_identity_mismatch', 'Move history presence changed before recovery.');
          const cwd = journal.historyExists ? toPosixPath(fs.realpathSync(this.historyHeaderCwd(journal.target.record))) : null;
          if (cwd !== null && cwd !== journal.source.directory && cwd !== journal.target.directory) throw invalid();
          // Native header replacement is the commit point. Empty histories use
          // the exact target record in the persisted intent, never timestamps.
          const committed = cwd === journal.target.directory || cwd === null && !!after;
          const kept = committed ? journal.target : journal.source, discarded = committed ? journal.source : journal.target;
          if (committed ? !after : !before) throw invalid();
          this.verifyPrivate(kept.directory, journal.conversationId, kept.privateFiles);
          const discardedRecord = committed ? before : after;
          if (discardedRecord) {
            this.verifyPrivate(discarded.directory, journal.conversationId, discarded.privateFiles);
            await this.edit(discarded.workspaceId, (manifest) => {
              const index = manifest.conversations.findIndex((record) => record.id === journal.conversationId);
              if (index < 0) return;
              if (workspaceCreationDigest(manifest.conversations[index]) !== workspaceCreationDigest(discarded.record)) throw invalid();
              manifest.conversations.splice(index, 1);
            });
          }
          this.removePrivate(discarded.directory, journal.conversationId, discarded.privateFiles);
          this.clearJournal(file, leases);
        });
      }
    })();
    this.recovery = task;
    task.finally(() => { if (this.recovery === task) this.recovery = null; }).catch(() => {});
    return task;
  }

  private privateFiles(directory: string, id: string): Record<string, string> | null {
    const root = workspaceMetadataPath(directory, `.tau/conversations/${id}`);
    if (!fs.existsSync(root)) return null;
    const files: Record<string, string> = {};
    const visit = (folder: string) => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = workspaceMetadataPath(root, relativePosixPath(root, path.join(folder, entry.name)));
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) files[relativePosixPath(root, file)] = hashFile(file);
      else throw failure('workspace_identity_conflict', 'Conversation private state contains an unsafe file.');
    } };
    visit(root); return files;
  }
  private verifyPrivate(directory: string, id: string, expected: Record<string, string> | null) {
    if (workspaceCreationDigest(this.privateFiles(directory, id)) !== workspaceCreationDigest(expected)) throw failure('workspace_revision_conflict', 'Conversation private state changed after the move intent.');
  }
  private removePrivate(directory: string, id: string, expected: Record<string, string> | null) {
    if (this.privateFiles(directory, id) === null) return;
    this.verifyPrivate(directory, id, expected);
    fs.rmSync(workspaceMetadataPath(directory, `.tau/conversations/${id}`), { recursive: true, force: true });
  }
  private clearJournal(file: string, leases: WorkspaceRuntimeLease[]) {
    // A crash after the intent disappears must not leave an unconfirmed
    // runtime. The locks still exclude every other Host until finish().
    for (const lease of leases) lease.checkpointStopped();
    fs.rmSync(`${file}.bak`, { force: true }); fs.rmSync(file, { force: true });
  }
  private locked<T>(sides: Array<{ directory: string; workspaceId: string }>, stop: boolean, execute: (leases: WorkspaceRuntimeLease[]) => Promise<T>, closeRuntimes = false): Promise<T> {
    const ordered = [...sides].sort((left, right) => left.directory < right.directory ? -1 : 1);
    const serialize = (index: number): Promise<T> => index === ordered.length ? take() : closeRuntimes
      ? this.options.runtime.withWorkspaceStopped(ordered[index].directory, stop, () => serialize(index + 1))
      : this.options.gate.serialize(ordered[index].directory, () => serialize(index + 1));
    const take = async () => {
      const leases: WorkspaceRuntimeLease[] = [];
      try { for (const side of ordered) leases.push(this.options.gate.takeMaintenance(side.directory, side.workspaceId)); return await execute(leases); }
      finally { const failures = []; for (const lease of leases.reverse()) { try { lease.finish(); } catch (error) { failures.push(error); } } if (failures.length) throw new AggregateError(failures, 'Move runtime leases could not be released safely.'); }
    };
    return serialize(0);
  }

  private historyHeaderCwd(record: ConversationRecordV1) {
    const root = fs.existsSync(this.options.store.sessionsDirectory) ? fs.realpathSync(this.options.store.sessionsDirectory) : path.resolve(this.options.store.sessionsDirectory);
    const file = workspaceMetadataPath(root, record.history.key);
    const descriptor = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024), count = fs.readSync(descriptor, buffer, 0, buffer.length, 0), end = buffer.subarray(0, count).indexOf(10);
      if (end < 0) throw failure('history_identity_mismatch', 'Pi history has no complete header.');
      const header = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      if (header?.type !== 'session' || typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd) || record.history.headerId === null || header.id !== record.history.headerId) throw failure('history_identity_mismatch', 'Pi history header is invalid or has changed identity.');
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
    if (fs.existsSync(to)) {
      const original = this.privateFiles(source.directory, source.conversation.id), existing = this.privateFiles(target.directory, source.conversation.id);
      const withoutPlan = (files: Record<string, string> | null) => { if (!files) return files; const copy = { ...files }; if (source.conversation.plan) delete copy['plan.json']; return copy; };
      if (workspaceCreationDigest(withoutPlan(original)) !== workspaceCreationDigest(withoutPlan(existing))) throw failure('workspace_revision_conflict', 'An unrelated private-state version already occupies the move target.');
      if (source.conversation.plan) {
        const fromPlan = readJsonObject(path.join(from, 'plan.json')), toPlan = readJsonObject(path.join(to, 'plan.json'));
        if (workspaceCreationDigest({ ...fromPlan, workspace: '' }) !== workspaceCreationDigest({ ...toPlan, workspace: '' })) throw failure('workspace_revision_conflict', 'A different frozen plan occupies the move target.');
      }
      return;
    }
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
      await this.recover();
      this.options.assertSystemReady();
      const matches = this.locate(conversationId);
      if (!matches.length) throw failure('conversation_missing', 'Conversation is unavailable.', 404);
      if (matches.length > 1) throw failure('workspace_identity_conflict', 'Conversation appears in more than one workspace; run the index diagnostics before moving it.');
      let source = matches[0];
      if (['deleting', 'deleted'].includes(source.conversation.state)) throw failure('conversation_missing', 'Conversation is being deleted.', 404);
      this.options.assertWorkspaceReady(source.manifest.id);
      let target = await this.target(input, source);
      if (target.manifest.id === source.manifest.id) return { ...target, conversation: source.conversation, standalone: target.kind === 'standalone' };
      const commit = async (leases: WorkspaceRuntimeLease[]) => {
        const fresh = this.locate(conversationId);
        if (fresh.length !== 1 || fresh[0].manifest.id !== source.manifest.id) throw failure('workspace_revision_conflict', 'Conversation ownership changed before the move acquired its leases.');
        source = fresh[0];
        target = { ...target, ...this.options.store.readWorkspace(target.manifest.id) };
        this.options.assertWorkspaceReady(source.manifest.id); this.options.assertWorkspaceReady(target.manifest.id);
        const history = this.options.store.inspectHistory(source.directory, source.conversation), sourceFiles = this.privateFiles(source.directory, conversationId);
        this.preparePrivateState(source, target);
        if (source.conversation.plan) await this.options.store.relocatePlan(source.directory, source.conversation, target.directory);
        copySessionAttachments(source.directory, target.directory, conversationAttachmentIds(source.directory, conversationId));
        await this.prepareCitations(source, target);
        const record = structuredClone({ ...source.conversation, history: { ...source.conversation.history, headerId: history.headerId }, updatedAt: new Date().toISOString() });
        const journal: MoveJournal = {
          schemaVersion: 1, conversationId, historyExists: history.sessionFile !== null,
          source: { workspaceId: source.manifest.id, directory: source.directory, rootIdentity: rootIdentity(source.directory), generation: leases.find((lease) => path.resolve(lease.directory) === path.resolve(source.directory))!.generation, record: structuredClone(source.conversation), privateFiles: sourceFiles },
          target: { workspaceId: target.manifest.id, directory: target.directory, rootIdentity: rootIdentity(target.directory), generation: leases.find((lease) => path.resolve(lease.directory) === path.resolve(target.directory))!.generation, record, privateFiles: this.privateFiles(target.directory, conversationId) },
        };
        const file = workspaceMetadataPath(this.options.store.userDataDirectory, `transfers/${conversationId}.json`);
        writeJsonAtomic(file, journal);
        await this.edit(target.manifest.id, (manifest) => {
          if (manifest.conversations.some((record) => record.id === conversationId)) throw failure('workspace_identity_conflict', 'The move target already owns this conversation.');
          if (manifest.conversations.some((record) => record.history.key === source.conversation.history.key)) throw failure('workspace_identity_conflict', 'Target workspace already reserves this conversation history.');
          manifest.conversations.push(record);
        });
        this.options.store.relocateHistory(record, source.directory, target.directory);
        await this.edit(source.manifest.id, (manifest) => {
          const index = manifest.conversations.findIndex((record) => record.id === conversationId);
          if (index < 0) return;
          if (workspaceCreationDigest(manifest.conversations[index]) !== workspaceCreationDigest(journal.source.record)) throw failure('workspace_revision_conflict', 'The source conversation changed before the move committed.');
          manifest.conversations.splice(index, 1);
        });
        this.removePrivate(source.directory, conversationId, sourceFiles);
        this.clearJournal(file, leases);
        const current = this.options.store.readWorkspace(target.manifest.id);
        const conversation = current.manifest.conversations.find((record) => record.id === conversationId)!;
        return { ...current, conversation, kind: target.kind, standalone: target.kind === 'standalone' };
      };
      return this.locked([{ directory: source.directory, workspaceId: source.manifest.id }, { directory: target.directory, workspaceId: target.manifest.id }], input.stopCurrent === true, commit, true);
    });
  }
}
