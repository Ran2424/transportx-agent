import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {
  parseResolvedSessionPlanStructured, parseCitationRegistryStructured, parseWorkspaceManifestStructured, selectCurrentSessionBranch,
  type WorkspaceManifestV1, type WorkspaceMigrationItemV1, type ResolvedSessionPlanV3,
} from '../contracts/index.js';
import { workspaceMetadataPath, workspaceCreationDigest, workspaceDiskPlan } from './workspace-store.js';
import { deriveSessionName } from './session-history-reader.js';
import { isGenericSessionName } from './session-title.js';
import { planCitationMigration } from './citation-migration.js';
import { migratePrivateState, type MigrationPrivateIssue } from './workspace-migration-private.js';
import { relativePosixPath, toPosixPath } from './util/path.js';
import type { JsonRecord } from './types.js';

export type MigrationSource = { path: string; bytes: number; sha256: string; kind: 'history' | 'metadata' };
export type MigrationWrite = { relative: string; value: unknown; bytes: number; sha256: string; previousSha256: string | null; previousBytes: number; backup: string | null };
export type WorkspaceMigrationPlan = {
  schemaVersion: 1; itemId: string; workspaceId: string; directory: string; sessionsDirectory: string; sourceDigest: string; preparedAt: string;
  sources: MigrationSource[]; writes: MigrationWrite[]; manifest: WorkspaceManifestV1;
  issues: MigrationPrivateIssue[]; assignments: Array<{ sourceId: string; conversationId: string | null; basis: string }>;
  notes: Array<{ code: string; file: string; message: string }>;
};
export const migrationJsonBytes = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
export const migrationBytesHash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code: string, message: string) => Object.assign(new Error(message), { code, status: 409 });

export function legacyMetadataPaths(directory: string) {
  const plan = ['.tau/resolved-session-plan.v3.json', '.tau/resolved-session-plan.json'].find((file) => fs.existsSync(workspaceMetadataPath(directory, file)));
  const files = [plan, '.tau/workspace-owner.json', '.tau/attachments.json', '.tau/citations.json', '.tau/canvas-contexts.json', '.tau/timing-metrics.v1.json', '.tau/geo-interactions/message-refs.json'].filter((file): file is string => !!file && fs.existsSync(workspaceMetadataPath(directory, file)));
  for (const [kind, names] of [['contexts', ['context.json', 'provenance.json']], ['requests', ['request.json', 'response.json']]] as const) {
    const root = workspaceMetadataPath(directory, `.tau/geo-interactions/${kind}`); if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink() || !(kind === 'contexts' ? /^geoctx_[A-Za-z0-9_-]{12,64}$/ : /^georeq_[A-Za-z0-9_-]{12,64}$/).test(entry.name)) throw fail('metadata_corrupt', 'Legacy Geo state contains an unexpected entry.');
      for (const name of names) { const file = `.tau/geo-interactions/${kind}/${entry.name}/${name}`; if (fs.existsSync(workspaceMetadataPath(directory, file))) files.push(file); }
    }
  }
  return files.sort();
}

export async function migrationFileVersion(file: string): Promise<{ bytes: number; sha256: string }> {
  const before = fs.statSync(file), hash = crypto.createHash('sha256');
  if (!before.isFile()) throw fail('metadata_corrupt', 'Migration source is not a regular file.');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  const after = fs.statSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) throw fail('migration_source_changed', 'Migration source changed while hashing.');
  return { bytes: before.size, sha256: hash.digest('hex') };
}

/** Full reads happen only in the frozen target workspace, never in global startup inventory. */
export async function planWorkspaceMigration(item: WorkspaceMigrationItemV1, preparedAt = new Date().toISOString()): Promise<WorkspaceMigrationPlan> {
  if (item.kind !== 'workspace' || !item.workspaceId || !fs.existsSync(item.path) || fs.realpathSync(item.path) !== path.resolve(item.path)) throw fail('workspace_identity_conflict', 'Migration target is not its canonical inventoried workspace.');
  const sources: MigrationSource[] = [], metadata = new Map<string, unknown>(), notes: WorkspaceMigrationPlan['notes'] = [];
  if (fs.existsSync(workspaceMetadataPath(item.path, '.tau/conversations'))) throw fail('workspace_identity_conflict', 'Unpublished new-format private directories already exist. Recover their index before legacy conversion.');
  const readMetadata = async (relative: string) => {
    const file = workspaceMetadataPath(item.path, relative);
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw fail('metadata_corrupt', `Migration metadata exceeds its bound: ${relative}`);
    const bytes = fs.readFileSync(file), version = { bytes: bytes.length, sha256: migrationBytesHash(bytes) };
    sources.push({ path: toPosixPath(file), ...version, kind: 'metadata' });
    let value: unknown;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw fail('metadata_corrupt', `Legacy metadata JSON is invalid: ${relative}`); }
    metadata.set(relative, value); return value;
  };
  const histories: Array<{ conversationId: string; entries: JsonRecord[]; key: string; timestamp: string }> = [];
  for (const history of item.histories) {
    const file = workspaceMetadataPath(item.sessionsDirectory, history.key), stat = fs.statSync(file);
    if (stat.size !== history.size || stat.mtimeMs !== history.mtimeMs) throw fail('migration_source_changed', 'History changed after inventory; rescan the source before conversion.');
    const descriptor = fs.openSync(file, 'r');
    try {
      const bytes = Buffer.alloc(64 * 1024), count = fs.readSync(descriptor, bytes, 0, bytes.length, 0), end = bytes.subarray(0, count).indexOf(10);
      if (end < 0 || migrationBytesHash(bytes.subarray(0, end)) !== history.headerSha256) throw fail('migration_source_changed', 'History header changed after inventory.');
    } finally { fs.closeSync(descriptor); }
    const version = await migrationFileVersion(file), entries: JsonRecord[] = [];
    const stream = fs.createReadStream(file, { encoding: 'utf8' }), lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw fail('history_invalid', 'History contains malformed rows; preserve it for source repair or explicit isolation.'); }
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('history_invalid', 'History contains a non-object row.');
        entries.push(value as JsonRecord);
      }
    } finally { lines.close(); stream.destroy(); }
    const header = entries[0];
    if (!header || header.type !== 'session' || header.id !== history.headerId || typeof header.cwd !== 'string' || fs.realpathSync(header.cwd) !== fs.realpathSync(item.path)) throw fail('history_identity_mismatch', 'History no longer belongs to the inventoried workspace.');
    if ((await migrationFileVersion(file)).sha256 !== version.sha256) throw fail('migration_source_changed', 'History changed while parsing.');
    sources.push({ path: toPosixPath(file), ...version, kind: 'history' });
    const timestamp = typeof header.timestamp === 'string' && Number.isFinite(Date.parse(header.timestamp)) ? new Date(header.timestamp).toISOString() : new Date(stat.mtimeMs).toISOString();
    if (timestamp !== header.timestamp) notes.push({ code: 'history_time_fallback', file: history.key, message: 'Missing/invalid header timestamp uses the inventoried file modification time.' });
    histories.push({ conversationId: history.conversationId, entries, key: history.key, timestamp });
  }
  const planRelative = ['.tau/resolved-session-plan.v3.json', '.tau/resolved-session-plan.json'].find((relative) => fs.existsSync(workspaceMetadataPath(item.path, relative)));
  let plan: ResolvedSessionPlanV3 | null = null;
  let managed = histories.length > 0;
  if (planRelative) {
    try {
      const raw = await readMetadata(planRelative), parsed = parseResolvedSessionPlanStructured(raw);
      const legacy = raw as { schemaVersion?: unknown; platform?: { name?: unknown }; workspace?: unknown } | null;
      if (legacy && [2, 3].includes(Number(legacy.schemaVersion)) && ['TransportX Agent', 'TransportX Traffic Agent'].includes(String(legacy.platform?.name)) && typeof legacy.workspace === 'string' && fs.existsSync(legacy.workspace) && fs.realpathSync(legacy.workspace) === fs.realpathSync(item.path)) managed = true;
      if (parsed.ok && fs.existsSync(parsed.value.workspace) && fs.realpathSync(parsed.value.workspace) === fs.realpathSync(item.path)) plan = workspaceDiskPlan(parsed.value);
      else notes.push({ code: (raw as { schemaVersion?: unknown })?.schemaVersion === 2 ? 'legacy_plan_requires_confirmation' : 'invalid_session_plan', file: planRelative, message: 'Original plan is preserved; this history has no verified v3 plan and cannot activate.' });
    } catch (error) {
      if ((error as { code?: string }).code !== 'metadata_corrupt') throw error;
      notes.push({ code: 'invalid_session_plan', file: planRelative, message: 'Original plan is corrupt and is preserved; current configuration cannot be substituted for it.' });
    }
  } else notes.push({ code: 'legacy_plan_requires_confirmation', file: '.tau/resolved-session-plan.json', message: 'No historical plan exists. Explicit current-configuration confirmation is required before activation.' });
  const owner = await readMetadata('.tau/workspace-owner.json') as { version?: unknown; workspace?: unknown } | null;
  if (owner && owner.version === 1 && typeof owner.workspace === 'string' && fs.existsSync(owner.workspace) && fs.realpathSync(owner.workspace) === fs.realpathSync(item.path)) managed = true;
  for (const relative of ['.tau/attachments.json', '.tau/canvas-contexts.json', '.tau/timing-metrics.v1.json', '.tau/geo-interactions/message-refs.json']) await readMetadata(relative);
  for (const [kind, names] of [['contexts', ['context.json', 'provenance.json']], ['requests', ['request.json', 'response.json']]] as const) {
    const relative = `.tau/geo-interactions/${kind}`, root = workspaceMetadataPath(item.path, relative);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      if (entry.isFile() && entry.name.startsWith('.')) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink() || !(kind === 'contexts' ? /^geoctx_[A-Za-z0-9_-]{12,64}$/ : /^georeq_[A-Za-z0-9_-]{12,64}$/).test(entry.name)) throw fail('metadata_corrupt', 'Legacy Geo state contains an unexpected entry.');
      for (const name of names) await readMetadata(`${relative}/${entry.name}/${name}`);
    }
  }
  let citationRegistryId = item.workspaceId, citationWrite: unknown = null;
  const citation = await readMetadata('.tau/citations.json');
  if (metadata.has('.tau/citations.json')) {
    const converted = planCitationMigration(item.path);
    const parsed = parseCitationRegistryStructured(converted?.registry || citation);
    if (!parsed.ok) throw fail('metadata_corrupt', 'Citation registry cannot be validated.');
    citationRegistryId = parsed.value.sessionId; citationWrite = converted ? parsed.value : null;
  }
  if (!managed) throw fail('workspace_ownership_unproven', 'No history, saved plan or valid managed-directory marker proves this legacy candidate. Keep it for review rather than enrolling an arbitrary folder.');
  const sourceDigest = workspaceCreationDigest(sources.map((source) => [source.path, source.bytes, source.sha256]).sort(([left], [right]) => String(left).localeCompare(String(right))));
  const privateState = migratePrivateState(item, sourceDigest, histories, metadata, preparedAt);
  const createdAt = histories.length ? histories.map((history) => history.timestamp).sort()[0] : new Date(fs.statSync(item.path).mtimeMs).toISOString();
  const manifest: WorkspaceManifestV1 = {
    schemaVersion: 1, id: item.workspaceId, revision: item.revision, name: path.basename(item.path).trim().slice(0, 120) || '历史工作区', createdAt, updatedAt: createdAt,
    defaultsRevision: 0, defaults: { domainId: null, modelSpec: null, profile: null }, citationRegistryId,
    conversations: histories.map((history) => {
      const branch = selectCurrentSessionBranch(history.entries), models = branch.filter((entry) => entry.type === 'model_change' && typeof entry.provider === 'string' && typeof entry.modelId === 'string');
      const model = models.at(-1);
      return { id: history.conversationId, creationRequestId: null, creationInputSha256: null, name: (deriveSessionName(branch, isGenericSessionName) || path.basename(history.key, '.jsonl')).slice(0, 120), createdAt: history.timestamp, updatedAt: history.timestamp, defaultsRevision: null, modelSpec: model ? `${model.provider}/${model.modelId}` : null, appendSystemPrompt: '', state: 'ready', history: { key: history.key, headerId: String(history.entries[0].id) }, plan: plan ? { path: `conversations/${history.conversationId}/plan.json`, source: 'legacy-workspace' } : null, privateState: 'isolated', lastStartFailure: null, deletion: null };
    }),
  };
  const outputs = [...privateState.files];
  if (plan) for (const history of histories) outputs.push({ relative: `.tau/conversations/${history.conversationId}/plan.json`, value: plan });
  if (privateState.sharedAttachments) outputs.push({ relative: '.tau/attachments.json', value: privateState.sharedAttachments });
  if (citationWrite) outputs.push({ relative: '.tau/citations.json', value: citationWrite });
  const writes: MigrationWrite[] = [];
  for (const output of outputs.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)) {
    const file = workspaceMetadataPath(item.path, output.relative), old = sources.find((source) => source.path === toPosixPath(file));
    if (fs.existsSync(file) && !old) throw fail('migration_target_exists', 'An unexpected private target already exists; do not overwrite it.');
    const bytes = migrationJsonBytes(output.value);
    writes.push({ ...output, bytes: bytes.length, sha256: migrationBytesHash(bytes), previousSha256: old?.sha256 || null, previousBytes: old?.bytes || 0, backup: old ? `.tau/migrations/workspace-v1/backups/${relativePosixPath(item.path, file)}` : null });
  }
  if (!parseWorkspaceManifestStructured(manifest).ok) throw fail('metadata_corrupt', 'Migration generated an invalid Manifest.');
  return { schemaVersion: 1, itemId: item.id, workspaceId: item.workspaceId, directory: item.path, sessionsDirectory: item.sessionsDirectory, sourceDigest, preparedAt, sources, writes, manifest, issues: privateState.issues, assignments: privateState.assignments, notes };
}
