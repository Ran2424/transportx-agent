import { asRecord } from './common.ts';
import { diagnostic } from './diagnostic.ts';
import { CONVERSATION_ID, WORKSPACE_ID, isWorkspaceHistoryKey, type WorkspaceParseResult } from './workspace.ts';

export type WorkspaceMigrationScopeV1 = {
  userData: string;
  agentDir: string;
  sessionsDirectory: string;
  workspaceRoots: string[];
};
export type WorkspaceMigrationHistoryV1 = {
  key: string;
  conversationId: string;
  headerId: string | null;
  headerSha256: string | null;
  size: number | null;
  mtimeMs: number | null;
};
export type WorkspaceMigrationItemV1 = {
  id: string;
  kind: 'workspace' | 'history' | 'path';
  path: string;
  sessionsDirectory: string;
  workspaceId: string | null;
  histories: WorkspaceMigrationHistoryV1[];
  protectedPaths: string[];
  state: 'pending' | 'converting' | 'needs-review' | 'failed' | 'ready' | 'isolated';
  stage: 'inventory' | 'prepared' | 'backed-up' | 'restoring' | 'published';
  revision: number;
  sourceDigest: string | null;
  preparedDigest: string | null;
  report: string | null;
  error: null | { code: string; message: string };
  decisions: Array<{ requestId: string; inputSha256: string; reportDigest: string; action: 'bind' | 'isolate' | 'retry' | 'reprepare'; sourceId: string | null; conversationId: string | null }>;
};
export type WorkspaceMigrationStateV1 = {
  schemaVersion: 1;
  targetWorkspaceSchema: 1;
  revision: number;
  scopes: WorkspaceMigrationScopeV1[];
  systemReadiness: 'initializing' | 'blocked' | 'ready';
  phase: 'inventory' | 'converting' | 'needs-attention' | 'complete';
  items: WorkspaceMigrationItemV1[];
  report: string;
  updatedAt: string;
};

const pathValue = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^(?:\/|[A-Za-z]:\/)/.test(value) && !value.includes('\\') && !value.includes('\0') && !value.split('/').some((part) => part === '.' || part === '..');
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192;
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const choice = (value: unknown, values: string[]) => typeof value === 'string' && values.includes(value);
const fields = (value: unknown, names: string) => { const object = asRecord(value); return !!object && Object.keys(object).every((key) => names.split(' ').includes(key)); };

export function parseWorkspaceMigrationStructured(value: unknown): WorkspaceParseResult<WorkspaceMigrationStateV1> {
  const root = asRecord(value);
  const invalid = () => ({ ok: false as const, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'workspaceMigration', message: 'Workspace migration inventory is corrupt or unsupported. Restore a verified inventory before business writes.' })] });
  if (!root || !fields(root, 'schemaVersion targetWorkspaceSchema revision scopes systemReadiness phase items report updatedAt') || root.schemaVersion !== 1 || root.targetWorkspaceSchema !== 1 || !integer(root.revision) || !choice(root.systemReadiness, ['initializing', 'blocked', 'ready']) || !choice(root.phase, ['inventory', 'converting', 'needs-attention', 'complete']) || !pathValue(root.report) || typeof root.updatedAt !== 'string' || !Number.isFinite(Date.parse(root.updatedAt)) || !Array.isArray(root.scopes) || !root.scopes.length || !Array.isArray(root.items)) return invalid();
  for (const value of root.scopes) {
    const scope = asRecord(value);
    if (!scope || !fields(scope, 'userData agentDir sessionsDirectory workspaceRoots') || !pathValue(scope.userData) || !pathValue(scope.agentDir) || !pathValue(scope.sessionsDirectory) || !Array.isArray(scope.workspaceRoots) || !scope.workspaceRoots.every(pathValue) || new Set(scope.workspaceRoots).size !== scope.workspaceRoots.length) return invalid();
  }
  const ids = new Set(), workspaceIds = new Set(), conversations = new Set(), historyKeys = new Set();
  for (const value of root.items) {
    const item = asRecord(value);
    if (!item || !fields(item, 'id kind path sessionsDirectory workspaceId histories protectedPaths state stage revision sourceDigest preparedDigest report error decisions') || typeof item.id !== 'string' || !/^mig_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(item.id) || ids.has(item.id) || !choice(item.kind, ['workspace', 'history', 'path']) || !pathValue(item.path) || !pathValue(item.sessionsDirectory) || !Array.isArray(item.protectedPaths) || !item.protectedPaths.every(pathValue) || !choice(item.state, ['pending', 'converting', 'needs-review', 'failed', 'ready', 'isolated']) || !choice(item.stage, ['inventory', 'prepared', 'backed-up', 'restoring', 'published']) || !integer(item.revision) || item.sourceDigest !== null && !sha(item.sourceDigest) || item.preparedDigest !== null && !sha(item.preparedDigest) || item.report !== null && !pathValue(item.report) || !Array.isArray(item.histories) || !Array.isArray(item.decisions) || item.state === 'ready' && item.stage !== 'published') return invalid();
    ids.add(item.id);
    if (item.stage !== 'inventory' && (!sha(item.sourceDigest) || !sha(item.preparedDigest) || !pathValue(item.report))) return invalid();
    if (item.workspaceId !== null) {
      if (typeof item.workspaceId !== 'string' || !WORKSPACE_ID.test(item.workspaceId) || workspaceIds.has(item.workspaceId)) return invalid();
      workspaceIds.add(item.workspaceId);
    } else if (item.kind === 'workspace') return invalid();
    if (item.error !== null) { const error = asRecord(item.error); if (!error || !fields(error, 'code message') || !text(error.code) || !text(error.message)) return invalid(); }
    for (const value of item.histories) {
      const history = asRecord(value);
      if (!history || !fields(history, 'key conversationId headerId headerSha256 size mtimeMs') || !isWorkspaceHistoryKey(history.key) || typeof history.conversationId !== 'string' || !CONVERSATION_ID.test(history.conversationId) || conversations.has(history.conversationId) || history.headerId !== null && !text(history.headerId) || history.headerSha256 !== null && !sha(history.headerSha256) || history.size !== null && !integer(history.size) || history.mtimeMs !== null && !number(history.mtimeMs)) return invalid();
      const key = `${item.sessionsDirectory}\n${history.key}`;
      if (historyKeys.has(key)) return invalid();
      historyKeys.add(key); conversations.add(history.conversationId);
    }
    const requests = new Set();
    for (const value of item.decisions) {
      const decision = asRecord(value);
      if (!decision || !fields(decision, 'requestId inputSha256 reportDigest action sourceId conversationId') || !text(decision.requestId) || requests.has(decision.requestId) || !sha(decision.inputSha256) || !sha(decision.reportDigest) || !choice(decision.action, ['bind', 'isolate', 'retry', 'reprepare']) || decision.sourceId !== null && !text(decision.sourceId) || decision.conversationId !== null && (typeof decision.conversationId !== 'string' || !CONVERSATION_ID.test(decision.conversationId)) || ['retry', 'reprepare'].includes(String(decision.action)) && (decision.sourceId !== null || decision.conversationId !== null)) return invalid();
      requests.add(decision.requestId);
      if (decision.action === 'bind' && (decision.sourceId === null || !item.histories.some((history: unknown) => asRecord(history)?.conversationId === decision.conversationId))) return invalid();
    }
    if (item.state === 'isolated' && !item.decisions.some((decision: unknown) => { const record = asRecord(decision); return record?.action === 'isolate' && record.sourceId === null && record.conversationId === null; })) return invalid();
    if (item.stage === 'restoring' && !item.decisions.some((decision: unknown) => asRecord(decision)?.action === 'reprepare')) return invalid();
  }
  if (root.systemReadiness === 'ready' && root.phase === 'inventory') return invalid();
  if (root.phase === 'complete' && root.items.some((item) => !['ready', 'isolated'].includes(item.state))) return invalid();
  return { ok: true, value: structuredClone(value) as WorkspaceMigrationStateV1, diagnostics: [] };
}
