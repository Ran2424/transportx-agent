import fs from 'node:fs';
import crypto from 'node:crypto';
import { PI_AGENT_DIR } from './config.js';
import { workspaceMetadataPath } from './workspace-store.js';
import { trafficSnapshotProvenance } from './traffic-snapshots.js';
import type { CheckedPlan, DefinitionRef, ReviewedDefinition, TableOperation, TimeRole } from '../contracts/workspace-handoff.js';
import type { HandoffInput } from '../contracts/workspace-handoff-schema.mjs' with { 'resolution-mode': 'import' };
import { TABLE_OPERATIONS, TIME_ROLES } from '../contracts/workspace-handoff.js';
import type { WorkspaceTablePlan } from './workspace-table.js';

export type HandoffSession = { cwd: string; conversationId: string };
type Filter = { column: string; value: string | null };
type Upstream = NonNullable<ReturnType<typeof trafficSnapshotProvenance>>;
export type Candidate = {
  release_id: string; entry_id: string; collection_id: string; revision: number; digest: string;
  applicability?: unknown;
  feedback_ids?: string[];
};
export type Decision = { candidate: Candidate; state: 'applicable' | 'excluded' | 'unconfirmed'; reason: string };
export type Intent = {
  id: string; turnId: string; file: string; title: string; table: string; definition: DefinitionRef;
  csvSha: string; operation: TableOperation; metric?: string; sampleBasis: 'rows' | 'non_null';
  fields: ReviewedDefinition['definition']['fields']; filters: Filter[]; groupBy: string[]; timeRoles: TimeRole[];
  userAnchors: { column: string; label: string }[]; decisions: Decision[];
};
export const handoffError = (message: string, code = 'table_handoff_invalid', status = 409) =>
  Object.assign(new Error(message), { status, code });
export const handoffHash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const id = (value: unknown): value is string => typeof value === 'string' && /^intent_[a-f0-9]{32}$/.test(value);

export function handoffPath(session: HandoffSession, directory: string, name: string) {
  const root = fs.realpathSync(PI_AGENT_DIR);
  const relative = directory + '/' + handoffHash(fs.realpathSync(session.cwd) + '\0' + session.conversationId);
  const folder = workspaceMetadataPath(root, relative);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  return workspaceMetadataPath(root, relative + '/' + name + '.json');
}

export function readHandoffFile<T>(file: string): T | undefined {
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw handoffError('Unsafe handoff record.');
    return JSON.parse(fs.readFileSync(fd, 'utf8')) as T;
  } finally { fs.closeSync(fd); }
}

export function getIntent(session: HandoffSession, intentId: unknown) {
  if (!id(intentId)) throw handoffError('A valid handoff intent ID is required.');
  const intent = readHandoffFile<Intent>(handoffPath(session, 'table-handoff-intents', intentId));
  if (!intent || intent.id !== intentId) throw handoffError('Handoff intent is not available in this conversation.');
  return intent;
}

export function readHandoffSource(session: HandoffSession, file?: string) {
  if (!file || !/^traffic-snapshots\/[0-9a-f-]{36}\.csv$/.test(file))
    throw handoffError('Select an authorized data snapshot in this conversation first.');
  const target = workspaceMetadataPath(fs.realpathSync(session.cwd), file);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw handoffError('The selected snapshot is unavailable.');
  const upstream = trafficSnapshotProvenance(session.cwd, file, handoffHash(fs.readFileSync(target)));
  if (!upstream) throw handoffError('The selected snapshot has no registered identity.');
  return upstream;
}

function containsLabel(text: string, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const latin = /^[\p{Script=Latin}\p{Number}_]+(?:[ -][\p{Script=Latin}\p{Number}_]+)*$/u.test(label);
  const pattern = latin ? '(?:^|[^\\p{Script=Latin}\\p{N}_])' + escaped + '(?:$|[^\\p{Script=Latin}\\p{N}_])' : escaped;
  return new RegExp(pattern, 'iu').test(text);
}

function decide(candidate: Candidate, operation: TableOperation, roles: TimeRole[]): Decision {
  const conditions = candidate.applicability as Record<string, unknown> | undefined;
  if (!conditions || !Array.isArray(conditions.operations) ||
      !conditions.operations.length || conditions.operations.some(op => !TABLE_OPERATIONS.includes(op)) ||
      (conditions.excluded_operations !== undefined && (!Array.isArray(conditions.excluded_operations) || conditions.excluded_operations.some(op => !TABLE_OPERATIONS.includes(op)))) ||
      (conditions.required_time_roles !== undefined && (!Array.isArray(conditions.required_time_roles) || conditions.required_time_roles.some(role => !TIME_ROLES.includes(role)))))
    return { candidate, state: 'unconfirmed', reason: 'No supported structured applicability is available.' };
  const excluded = (conditions.excluded_operations ?? []) as TableOperation[];
  if (excluded.includes(operation) || !conditions.operations.includes(operation))
    return { candidate, state: 'excluded', reason: 'The requested operation is outside this release’s applicability.' };
  const required = (conditions.required_time_roles ?? []) as TimeRole[];
  if (required.some(role => !roles.includes(role)))
    return { candidate, state: 'unconfirmed', reason: 'The task does not establish all time roles required by this release.' };
  return { candidate, state: 'applicable', reason: 'The requested operation and required time roles match.' };
}

export function prepareIntent(session: HandoffSession, input: HandoffInput, question: string, turnId: string, candidates: Candidate[]) {
  const upstream = readHandoffSource(session, input.file);
  const reviewed = upstream.reviewed;
  if (!reviewed) throw handoffError('This snapshot has no reviewed definition. Confirm one in Data Studio.', 'table_definition_needed');
  if (!input.file || !input.operation || !input.sampleBasis) throw handoffError('Specify operation and sample basis for the intended result.');
  if (input.operation === 'count' && input.sampleBasis === 'rows' && input.metric !== undefined)
    throw handoffError('A row count has no metric column.');
  const fields = reviewed.definition.fields;
  const metric = fields.find(field => field.column === input.metric);
  if (input.operation !== 'count' && metric?.role !== 'measure')
    throw handoffError('Choose a reviewed measure for the requested operation.', 'table_definition_needed');
  if (input.sampleBasis === 'non_null' && !metric)
    throw handoffError('A non-null sample basis needs a reviewed metric column.', 'table_definition_needed');
  const groupBy = input.groupBy ?? [];
  if (groupBy.some(column => !fields.some(field => field.column === column && field.role === 'dimension')))
    throw handoffError('Grouping requires reviewed dimension columns.', 'table_definition_needed');
  const timeRoles = input.timeRoles ?? [];
  for (const role of timeRoles) {
    const matches = fields.filter(field => field.role === role);
    if (matches.length !== 1) throw handoffError('A requested time role is missing or ambiguous: ' + role, 'table_definition_needed');
  }
  const resolved = new Map<string, string | null>();
  const userAnchors: Intent['userAnchors'] = [];
  function add(column: string, value: string | null) {
    if (resolved.has(column) && resolved.get(column) !== value)
      throw handoffError('More than one value is indicated for ' + column + '. Clarify the intended scope.', 'table_intent_ambiguous');
    resolved.set(column, value);
  }
  for (const field of fields.filter(item => item.role === 'dimension')) {
    for (const alias of field.aliases ?? []) {
      if (!containsLabel(question, alias.label)) continue;
      add(field.column, alias.value);
      userAnchors.push({ column: field.column, label: alias.label });
    }
  }
  if (userAnchors.length && /(?:\b(?:exclude|except|excluding|without)\b|排除|不包含|不包括|不含|除.+之外)/iu.test(question))
    throw handoffError('The question may exclude a matched value. This handoff only supports confirmed equality filters; clarify an affirmative scope.', 'table_intent_ambiguous');
  for (const filter of input.filters ?? []) {
    if (!fields.some(field => field.column === filter.column && field.role !== 'measure'))
      throw handoffError('A filter does not refer to a reviewed dimension or time column.', 'table_definition_needed');
    add(filter.column, filter.value);
  }
  if (resolved.size > 16) throw handoffError('The resolved scope exceeds the maximum supported filters.');
  const { scope, snapshot_id, revision, digest } = reviewed;
  const intent: Intent = {
    id: 'intent_' + crypto.randomUUID().replaceAll('-', ''), turnId, file: input.file,
    title: question, table: upstream.snapshot.table, definition: { scope, snapshot_id, revision, digest },
    csvSha: upstream.snapshot.csv_sha256, operation: input.operation, metric: input.metric, sampleBasis: input.sampleBasis,
    fields, filters: [...resolved].map(([column, value]) => ({ column, value })), groupBy, timeRoles, userAnchors,
    decisions: candidates.map(candidate => decide(candidate, input.operation!, timeRoles)),
  };
  fs.writeFileSync(handoffPath(session, 'table-handoff-intents', intent.id), JSON.stringify(intent), { flag: 'wx', mode: 0o600 });
  return intent;
}

const sameFilter = (a: Filter, b: Filter) => a.column === b.column && a.value === b.value;
const hasFilters = (actual: Filter[], requested: Filter[]) => requested.every(filter => actual.some(other => sameFilter(filter, other)));

export function checkHandoffPlan(session: HandoffSession, turnId: unknown, plan: WorkspaceTablePlan, upstream?: Upstream): CheckedPlan | undefined {
  const data = upstream?.reviewed;
  if (!data) {
    if (plan.intentId || plan.queryRole) throw handoffError('The selected source has no matching reviewed definition.');
    return;
  }
  if (!plan.intentId && !plan.filters.length && !plan.orderBy.length && !plan.aggregates.length && plan.limit <= 5) return;
  const intent = getIntent(session, plan.intentId);
  if (intent.turnId !== turnId || intent.file !== plan.file || intent.definition.revision !== data.revision ||
      intent.definition.digest !== data.digest || intent.csvSha !== upstream.snapshot.csv_sha256)
    throw handoffError('The intent belongs to a different turn, source or reviewed definition.', 'table_intent_mismatch');
  const role = plan.queryRole ?? 'primary';
  if (!hasFilters(plan.filters, intent.filters)) {
    const missing = intent.filters.filter(filter => !plan.filters.some(other => sameFilter(filter, other)));
    throw handoffError('The query is missing confirmed filters: ' + missing.map(item => item.column).join(', '), 'table_scope_missing');
  }
  const intended = (column: string) => intent.filters.some(filter => filter.column === column);
  for (const filter of plan.filters) {
    if ((intended(filter.column) && !intent.filters.some(other => sameFilter(filter, other))) ||
        !intent.fields.some(field => field.column === filter.column && field.role !== 'measure'))
      throw handoffError('The query narrows or conflicts with a confirmed filter on ' + filter.column, 'table_scope_conflict');
  }
  if (role !== 'support' && !hasFilters(intent.filters, plan.filters))
    throw handoffError('The main population has an additional unconfirmed filter.', 'table_scope_conflict');
  const requiredTimes = intent.timeRoles.map(role => ({ role, column: intent.fields.find(field => field.role === role)!.column }));
  let observedRole: TimeRole | undefined;
  let resultColumn: string | undefined;
  const sampleColumn = intent.sampleBasis === 'non_null' ? intent.metric : undefined;
  const isSample = (a: WorkspaceTablePlan['aggregates'][number]) => a.op === 'count' && a.column === sampleColumn;
  if (role === 'primary') {
    if (JSON.stringify(plan.groupBy) !== JSON.stringify(intent.groupBy))
      throw handoffError('The query grouping differs from the prepared intent.', 'table_method_mismatch');
    const measure = plan.aggregates.find(a => a.op === intent.operation &&
      a.column === (intent.operation === 'count' ? sampleColumn : intent.metric) &&
      (!['min','max'].includes(a.op) || a.numeric));
    if (!measure || !plan.aggregates.every(a => a === measure || isSample(a)) ||
        (intent.sampleBasis === 'non_null' && !plan.aggregates.some(isSample)))
      throw handoffError('The comparison operation, metric or sample basis differs from the prepared intent.', 'table_method_mismatch');
    resultColumn = measure.as;
  }
  if (role === 'time') {
    observedRole = requiredTimes.find(entry => entry.column === plan.groupBy[0])?.role;
    const count = plan.aggregates[0];
    if (!observedRole || plan.groupBy.length !== 1 || plan.aggregates.length !== 1 || count?.op !== 'count' || count.column !== undefined)
      throw handoffError('Time evidence must group by one intended time role and count the rows.', 'table_time_role_mismatch');
  }
  return { intentId: intent.id, role, definition: intent.definition, requiredTimes,
    operation: intent.operation, sampleBasis: intent.sampleBasis, metric: intent.metric, resultColumn,
    ...(observedRole ? { timeRole: observedRole } : {}), planDigest: handoffHash(JSON.stringify(plan)) };
}
