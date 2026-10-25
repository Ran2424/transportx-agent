import { asRecord, asString } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { parseSessionProfileStructured, type SessionProfileV1 } from './session-profile.ts';

export const WORKSPACE_SCHEMA_VERSION = 1 as const;
export const WORKSPACE_ID = /^ws_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export const CONVERSATION_ID = /^conv_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export type WorkspaceDefaultsV1 = { domainId: string | null; modelSpec: string | null; profile: SessionProfileV1 | null };
type DeletionError = null | { code: string; message: string };
export type ConversationRecordV1 = {
  id: string; creationRequestId: string | null; creationInputSha256: string | null;
  name: string; createdAt: string; updatedAt: string;
  defaultsRevision: number | null; modelSpec: string | null; appendSystemPrompt: string;
  state: 'created' | 'ready' | 'start-failed' | 'deleting' | 'deleted';
  history: { key: string; headerId: string | null };
  plan: null | { path: string; source: 'created' | 'legacy-workspace' | 'confirmed-current' };
  privateState: 'isolated' | 'needs-review';
  lastStartFailure: null | { code: string; message: string; at: string };
  deletion: null | { requestId: string; invocationOwnerKey: string | null; error: DeletionError; stage: 'frozen' | 'invocations-cleaned' | 'history-cleaned' };
};
export type WorkspaceManifestV1 = {
  schemaVersion: 1; id: string; revision: number; name: string; createdAt: string; updatedAt: string;
  defaultsRevision: number; defaults: WorkspaceDefaultsV1; citationRegistryId: string;
  conversations: ConversationRecordV1[];
};
export type WorkspaceCatalogEntryV1 = {
  workspaceId: string; path: string; creationRequestId: string | null; creationInputSha256: string | null;
  state: 'creating' | 'ready' | 'deleting' | 'deleted';
  /** Reserved system workspace that only holds conversations moved out of ordinary workspaces. */
  kind?: 'standalone';
  deletion: null | { requestId: string; manifestRevision: number; rootIdentity: string; conversationIds: string[]; historyKeys: string[]; invocationOwnerKeys: string[]; error: DeletionError; stage: 'frozen' | 'invocations-cleaned' | 'history-cleaned' | 'workspace-cleaned' };
};
export type WorkspaceCatalogV1 = { schemaVersion: 1; revision: number; entries: WorkspaceCatalogEntryV1[] };
export type CreateConversationInput = {
  requestId: string;
  workspace: { kind: 'new'; name: string; parentDirectory?: string } | { kind: 'existing'; workspaceId: string; expectedRevision: number; defaultsRevision: number };
  name: string; model?: string; profile?: SessionProfileV1; domainId?: string; appendSystemPrompt?: string;
};
export type WorkspaceParseResult<T> = { ok: true; value: T; diagnostics: [] } | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, max = 200) => typeof value === 'string' && value === value.trim() && !!asString(value, max) && !/[\u0000-\u001f]/.test(value);
const nullableText = (value: unknown, max = 200) => value === null || text(value, max);
const timestamp = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const oneOf = (value: unknown, allowed: string[]) => typeof value === 'string' && allowed.includes(value);
export function isWorkspaceHistoryKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && value.endsWith('.jsonl') && !/^[A-Za-z]:|^[\/\\]|[\\\u0000-\u001f]/.test(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}
export function conversationPlanPath(id: string) { return `conversations/${id}/plan.json`; }

function fields(value: unknown, keys: string, path: string, diagnostics: ContractDiagnostic[]) {
  const record = asRecord(value);
  if (!record) { diagnostics.push(diagnostic({ code: 'invalid_type', path, message: 'Expected an object.' })); return null; }
  const allowed = keys.split(' ');
  for (const key of Object.keys(record)) if (!allowed.includes(key)) diagnostics.push(diagnostic({ code: 'unsupported_value', path: `${path}.${key}`, message: 'Unknown field.' }));
  return record;
}
function check(valid: unknown, path: string, diagnostics: ContractDiagnostic[], message = 'Invalid or missing field.') {
  if (!valid) diagnostics.push(diagnostic({ code: 'invalid_type', path, message }));
}
function deletionError(value: unknown, path: string, diagnostics: ContractDiagnostic[]) {
  if (value === null) return;
  const error = fields(value, 'code message', path, diagnostics);
  if (error) check(text(error.code) && text(error.message, 4000), path, diagnostics);
}
function version(record: Record<string, unknown>, path: string, diagnostics: ContractDiagnostic[]) {
  if (record.schemaVersion !== 1) diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: `${path}.schemaVersion`, message: 'Unsupported workspace schemaVersion.', expected: 1 }));
}
function finish<T>(value: unknown, diagnostics: ContractDiagnostic[]): WorkspaceParseResult<T> {
  return diagnostics.length ? { ok: false, value: null, diagnostics } : { ok: true, value: structuredClone(value) as T, diagnostics: [] };
}
function creation(record: Record<string, unknown>, path: string, diagnostics: ContractDiagnostic[]) {
  check(record.creationRequestId === null && record.creationInputSha256 === null || text(record.creationRequestId) && sha(record.creationInputSha256), `${path}.creationRequestId`, diagnostics, 'Creation request and immutable input digest must both be present or both null.');
}
function defaults(value: unknown, path: string, diagnostics: ContractDiagnostic[]) {
  const record = fields(value, 'domainId modelSpec profile', path, diagnostics);
  if (!record) return;
  check(nullableText(record.domainId), `${path}.domainId`, diagnostics);
  check(nullableText(record.modelSpec, 500), `${path}.modelSpec`, diagnostics);
  check(record.profile === null || parseSessionProfileStructured(record.profile).ok, `${path}.profile`, diagnostics);
}
function conversation(value: unknown, path: string, diagnostics: ContractDiagnostic[]) {
  const record = fields(value, 'id creationRequestId creationInputSha256 name createdAt updatedAt defaultsRevision modelSpec appendSystemPrompt state history plan privateState lastStartFailure deletion', path, diagnostics);
  if (!record) return;
  check(typeof record.id === 'string' && CONVERSATION_ID.test(record.id), `${path}.id`, diagnostics);
  creation(record, path, diagnostics);
  check(record.state === 'deleted' && record.name === '' || text(record.name, 120), `${path}.name`, diagnostics);
  check(timestamp(record.createdAt) && timestamp(record.updatedAt), `${path}.createdAt`, diagnostics);
  check(record.defaultsRevision === null || integer(record.defaultsRevision), `${path}.defaultsRevision`, diagnostics);
  check(nullableText(record.modelSpec, 500), `${path}.modelSpec`, diagnostics);
  check(typeof record.appendSystemPrompt === 'string', `${path}.appendSystemPrompt`, diagnostics);
  check(oneOf(record.state, ['created', 'ready', 'start-failed', 'deleting', 'deleted']), `${path}.state`, diagnostics);
  check(oneOf(record.privateState, ['isolated', 'needs-review']), `${path}.privateState`, diagnostics);
  const history = fields(record.history, 'key headerId', `${path}.history`, diagnostics);
  if (history) { check(isWorkspaceHistoryKey(history.key), `${path}.history.key`, diagnostics); check(nullableText(history.headerId), `${path}.history.headerId`, diagnostics); }
  if (record.creationRequestId !== null && history) check(history.key === `transportx/${record.id}.jsonl`, `${path}.history.key`, diagnostics, 'New conversation history must use its reserved identity path.');
  if (record.plan !== null) {
    const plan = fields(record.plan, 'path source', `${path}.plan`, diagnostics);
    if (plan) { check(plan.path === conversationPlanPath(String(record.id)), `${path}.plan.path`, diagnostics); check(oneOf(plan.source, ['created', 'legacy-workspace', 'confirmed-current']), `${path}.plan.source`, diagnostics); }
  } else check(record.creationRequestId === null || record.state === 'deleted', `${path}.plan`, diagnostics, 'New conversations require a frozen plan.');
  if (record.lastStartFailure !== null) {
    const failure = fields(record.lastStartFailure, 'code message at', `${path}.lastStartFailure`, diagnostics);
    if (failure) check(text(failure.code) && typeof failure.message === 'string' && failure.message.length <= 4000 && timestamp(failure.at), `${path}.lastStartFailure`, diagnostics);
  }
  if (record.deletion !== null) {
    const deletion = fields(record.deletion, 'requestId invocationOwnerKey error stage', `${path}.deletion`, diagnostics);
    if (deletion) { check(text(deletion.requestId) && (deletion.invocationOwnerKey === null || sha(deletion.invocationOwnerKey)) && oneOf(deletion.stage, ['frozen', 'invocations-cleaned', 'history-cleaned']) && oneOf(record.state, ['deleting', 'deleted']), `${path}.deletion`, diagnostics); deletionError(deletion.error, `${path}.deletion.error`, diagnostics); }
  } else check(record.state !== 'deleting' && record.state !== 'deleted', `${path}.deletion`, diagnostics);
}

export function parseWorkspaceManifestStructured(value: unknown): WorkspaceParseResult<WorkspaceManifestV1> {
  const diagnostics: ContractDiagnostic[] = [];
  const root = fields(value, 'schemaVersion id revision name createdAt updatedAt defaultsRevision defaults citationRegistryId conversations', 'workspace', diagnostics);
  if (root) {
    version(root, 'workspace', diagnostics);
    check(typeof root.id === 'string' && WORKSPACE_ID.test(root.id), 'workspace.id', diagnostics);
    check(integer(root.revision) && integer(root.defaultsRevision), 'workspace.revision', diagnostics);
    check(text(root.name, 120), 'workspace.name', diagnostics);
    check(timestamp(root.createdAt) && timestamp(root.updatedAt), 'workspace.createdAt', diagnostics);
    check(text(root.citationRegistryId), 'workspace.citationRegistryId', diagnostics);
    defaults(root.defaults, 'workspace.defaults', diagnostics);
    check(Array.isArray(root.conversations), 'workspace.conversations', diagnostics);
    if (Array.isArray(root.conversations)) {
      const ids = new Set(), keys = new Set(), requests = new Set();
      root.conversations.forEach((value, index) => {
        const path = `workspace.conversations[${index}]`; conversation(value, path, diagnostics);
        const record = asRecord(value), history = asRecord(record?.history);
        if (!record || !history) return;
        check(!ids.has(record.id) && !keys.has(history.key) && (record.creationRequestId === null || !requests.has(record.creationRequestId)), path, diagnostics, 'Conversation identity, history key and creation request must be unique.');
        ids.add(record.id); keys.add(history.key); if (record.creationRequestId !== null) requests.add(record.creationRequestId);
      });
    }
  }
  const result = finish<WorkspaceManifestV1>(value, diagnostics);
  if (result.ok && result.value.defaults.profile) {
    const profile = parseSessionProfileStructured(result.value.defaults.profile);
    if (profile.ok) result.value.defaults.profile = profile.value;
  }
  return result;
}

export function parseWorkspaceCatalogStructured(value: unknown): WorkspaceParseResult<WorkspaceCatalogV1> {
  const diagnostics: ContractDiagnostic[] = [];
  const root = fields(value, 'schemaVersion revision entries', 'catalog', diagnostics);
  if (root) {
    version(root, 'catalog', diagnostics); check(integer(root.revision), 'catalog.revision', diagnostics);
    check(Array.isArray(root.entries), 'catalog.entries', diagnostics);
    if (Array.isArray(root.entries)) {
      const ids = new Set(), paths = new Set(), requests = new Set();
      root.entries.forEach((value, index) => {
        const path = `catalog.entries[${index}]`;
        const entry = fields(value, 'workspaceId path creationRequestId creationInputSha256 state deletion kind', path, diagnostics);
        if (!entry) return;
        check(typeof entry.workspaceId === 'string' && WORKSPACE_ID.test(entry.workspaceId), `${path}.workspaceId`, diagnostics);
        check(text(entry.path, 4096) && /^(?:\/|[A-Za-z]:\/)/.test(String(entry.path)) && !String(entry.path).includes('\\') && !String(entry.path).split('/').some((part) => part === '.' || part === '..'), `${path}.path`, diagnostics);
        creation(entry, path, diagnostics);
        check(oneOf(entry.state, ['creating', 'ready', 'deleting', 'deleted']), `${path}.state`, diagnostics);
        check(entry.kind === undefined || entry.kind === 'standalone', `${path}.kind`, diagnostics);
        check(!ids.has(entry.workspaceId) && !paths.has(entry.path) && (entry.creationRequestId === null || !requests.has(entry.creationRequestId)), path, diagnostics, 'Catalog identity, path and creation request must be unique.');
        ids.add(entry.workspaceId); paths.add(entry.path); if (entry.creationRequestId !== null) requests.add(entry.creationRequestId);
        if (entry.deletion !== null) {
          const deletion = fields(entry.deletion, 'requestId manifestRevision rootIdentity conversationIds historyKeys invocationOwnerKeys error stage', `${path}.deletion`, diagnostics);
          if (deletion) { check(text(deletion.requestId) && integer(deletion.manifestRevision) && sha(deletion.rootIdentity) && Array.isArray(deletion.historyKeys) && deletion.historyKeys.every(isWorkspaceHistoryKey) && new Set(deletion.historyKeys).size === deletion.historyKeys.length && Array.isArray(deletion.invocationOwnerKeys) && deletion.invocationOwnerKeys.every(sha) && oneOf(deletion.stage, ['frozen', 'invocations-cleaned', 'history-cleaned', 'workspace-cleaned']) && oneOf(entry.state, ['deleting', 'deleted']), `${path}.deletion`, diagnostics); deletionError(deletion.error, `${path}.deletion.error`, diagnostics); }
          if (deletion) check(Array.isArray(deletion.conversationIds) && deletion.conversationIds.every((id) => typeof id === 'string' && CONVERSATION_ID.test(id)) && new Set(deletion.conversationIds).size === deletion.conversationIds.length, `${path}.deletion.conversationIds`, diagnostics);
        } else check(entry.state !== 'deleting' && entry.state !== 'deleted', `${path}.deletion`, diagnostics);
      });
    }
  }
  return finish(value, diagnostics);
}

export function parseCreateConversationStructured(value: unknown): WorkspaceParseResult<CreateConversationInput> {
  const diagnostics: ContractDiagnostic[] = [];
  const root = fields(value, 'requestId workspace name model profile domainId appendSystemPrompt', 'create', diagnostics);
  if (root) {
    check(text(root.requestId), 'create.requestId', diagnostics);
    check(text(root.name, 120), 'create.name', diagnostics);
    const workspace = asRecord(root.workspace);
    if (workspace?.kind === 'new') {
      fields(workspace, 'kind name parentDirectory', 'create.workspace', diagnostics);
      check(text(workspace.name, 120), 'create.workspace.name', diagnostics);
      check(workspace.parentDirectory === undefined || text(workspace.parentDirectory, 4096), 'create.workspace.parentDirectory', diagnostics);
      check(text(root.model, 500) && text(root.domainId), 'create.model', diagnostics, 'A new workspace requires explicit model and domain.');
      check(root.profile !== undefined, 'create.profile', diagnostics, 'A new workspace requires an explicit profile.');
    } else if (workspace?.kind === 'existing') {
      fields(workspace, 'kind workspaceId expectedRevision defaultsRevision', 'create.workspace', diagnostics);
      check(typeof workspace.workspaceId === 'string' && WORKSPACE_ID.test(workspace.workspaceId) && integer(workspace.expectedRevision) && integer(workspace.defaultsRevision), 'create.workspace', diagnostics);
    } else check(false, 'create.workspace.kind', diagnostics, 'Select new or existing workspace explicitly.');
    check(root.model === undefined || text(root.model, 500), 'create.model', diagnostics);
    check(root.domainId === undefined || text(root.domainId), 'create.domainId', diagnostics);
    if (root.profile !== undefined) { const profile = parseSessionProfileStructured(root.profile); check(profile.ok && profile.value.modules.selectionMode === 'explicit', 'create.profile', diagnostics, 'Creation requires a complete explicit SessionProfileV1.'); }
    check(root.appendSystemPrompt === undefined || typeof root.appendSystemPrompt === 'string', 'create.appendSystemPrompt', diagnostics);
  }
  const result = finish<CreateConversationInput>(value, diagnostics);
  if (result.ok && result.value.profile) {
    const profile = parseSessionProfileStructured(result.value.profile);
    if (profile.ok) result.value.profile = profile.value;
  }
  return result;
}
