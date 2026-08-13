import { asRecord, asString } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';

export const SESSION_PROFILE_SCHEMA_VERSION = 1 as const;
export const SESSION_TASK_KINDS = ['data-query', 'spatial-analysis', 'assurance-analysis', 'report'] as const;
export const SESSION_OUTPUT_KINDS = ['answer', 'table', 'map', 'report'] as const;

export type SessionTaskKind = typeof SESSION_TASK_KINDS[number];
export type SessionOutputKind = typeof SESSION_OUTPUT_KINDS[number];

export type SessionProfileV1 = {
  schemaVersion: 1;
  task: {
    kind: SessionTaskKind;
    city?: string;
    project?: string;
    timeRange?: { start: string; end: string; timezone: string };
    spatialScope?: { label: string };
    expectedOutputs: SessionOutputKind[];
  };
  modules: {
    selectionMode: 'explicit' | 'compat-default';
    selected: Array<{ id: string; version: string }>;
  };
};

export type SessionProfileParseResult =
  | { ok: true; value: SessionProfileV1; diagnostics: [] }
  | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

export function defaultSessionProfile(selected: Array<{ id: string; version: string }> = [], selectionMode: 'explicit' | 'compat-default' = 'explicit'): SessionProfileV1 {
  return { schemaVersion: 1, task: { kind: 'data-query', expectedOutputs: ['answer'] }, modules: { selectionMode, selected } };
}

export function parseSessionProfileStructured(value: unknown): SessionProfileParseResult {
  const root = asRecord(value);
  const diagnostics: ContractDiagnostic[] = [];
  if (!root) return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'profile', message: 'Session profile must be an object.' })] };
  if (root.schemaVersion !== SESSION_PROFILE_SCHEMA_VERSION) diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'profile.schemaVersion', message: 'Unsupported session profile schemaVersion.', expected: SESSION_PROFILE_SCHEMA_VERSION, received: typeof root.schemaVersion === 'string' || typeof root.schemaVersion === 'number' ? root.schemaVersion : String(root.schemaVersion) }));
  const task = asRecord(root.task);
  const modules = asRecord(root.modules);
  if (!task) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'profile.task', message: 'task must be an object.' }));
  if (!modules) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'profile.modules', message: 'modules must be an object.' }));
  const kind = asString(task?.kind, 80) as SessionTaskKind | null;
  if (!kind || !(SESSION_TASK_KINDS as readonly string[]).includes(kind)) diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'profile.task.kind', message: 'Unsupported task kind.' }));
  const outputValues = task?.expectedOutputs;
  const expectedOutputs = Array.isArray(outputValues)
    ? outputValues.filter((item): item is SessionOutputKind => typeof item === 'string' && (SESSION_OUTPUT_KINDS as readonly string[]).includes(item))
    : [];
  if (!Array.isArray(outputValues) || !expectedOutputs.length || expectedOutputs.length !== outputValues.length || new Set(expectedOutputs).size !== expectedOutputs.length) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'profile.task.expectedOutputs', message: 'expectedOutputs must contain unique supported outputs.' }));
  const selectionMode = asString(modules?.selectionMode, 40);
  if (selectionMode !== 'explicit' && selectionMode !== 'compat-default') diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'profile.modules.selectionMode', message: 'selectionMode must be explicit or compat-default.' }));
  const selected: Array<{ id: string; version: string }> = [];
  const ids = new Set<string>();
  if (!Array.isArray(modules?.selected)) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'profile.modules.selected', message: 'selected must be an array.' }));
  else modules.selected.forEach((candidate, index) => {
    const item = asRecord(candidate);
    const id = asString(item?.id, 200);
    const version = asString(item?.version, 100);
    if (!id || !version || ids.has(id)) diagnostics.push(diagnostic({ code: 'invalid_type', path: `profile.modules.selected[${index}]`, message: 'Each selected Module requires a unique id and version.' }));
    else { ids.add(id); selected.push({ id, version }); }
  });
  const timeRange = task?.timeRange === undefined ? undefined : asRecord(task.timeRange);
  let parsedTimeRange: SessionProfileV1['task']['timeRange'];
  if (task?.timeRange !== undefined) {
    const start = asString(timeRange?.start, 80);
    const end = asString(timeRange?.end, 80);
    const timezone = asString(timeRange?.timezone, 100);
    if (!start || !end || !timezone || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) > Date.parse(end) || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(timezone)) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'profile.task.timeRange', message: 'timeRange requires ordered ISO dates and an IANA timezone.' }));
    else parsedTimeRange = { start, end, timezone };
  }
  const spatialScope = task?.spatialScope === undefined ? undefined : asRecord(task.spatialScope);
  const spatialLabel = spatialScope ? asString(spatialScope.label, 500) : null;
  if (task?.spatialScope !== undefined && !spatialLabel) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'profile.task.spatialScope', message: 'spatialScope.label is required.' }));
  if (diagnostics.length || !task || !modules || !kind || !expectedOutputs.length || (selectionMode !== 'explicit' && selectionMode !== 'compat-default')) return { ok: false, value: null, diagnostics };
  return { ok: true, diagnostics: [], value: {
    schemaVersion: 1,
    task: {
      kind,
      ...(asString(task.city, 200) ? { city: asString(task.city, 200)! } : {}),
      ...(asString(task.project, 300) ? { project: asString(task.project, 300)! } : {}),
      ...(parsedTimeRange ? { timeRange: parsedTimeRange } : {}),
      ...(spatialLabel ? { spatialScope: { label: spatialLabel } } : {}),
      expectedOutputs,
    },
    modules: { selectionMode, selected },
  } };
}

export function parseSessionProfile(value: unknown) {
  const result = parseSessionProfileStructured(value);
  return result.ok ? result.value : null;
}
