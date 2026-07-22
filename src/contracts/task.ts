/**
 * Task mode contract shared between Pi task-mode Extension, Server and Web
 * Feature. This is the authority for `TaskSnapshot`, the structured mutation
 * helpers (`createTask`, `reviseTask`, …) and the JSON parser.
 *
 * Behaviour changes from the previous split:
 *   - `parseTaskSnapshot` now collects structured `ContractDiagnostic` instead
 *     of returning null on the first failure (caller-facing API still returns
 *     `null` on hard failures for backwards compatibility — see
 *     `parseTaskSnapshotQuiet`).
 *   - The strict "running step requires activeStepId" rule that lived only in
 *     `src/public/features/task/task-protocol.ts` is now enforced here.
 */
import { asRecord, asString, asFiniteNumber, asPositiveInteger, type JsonRecord } from './common.ts';
import { TASK_SNAPSHOT_SCHEMA_VERSION } from './version.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';

export type TaskStatus = 'planning' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export type TaskStepStatus = 'pending' | 'running' | 'completed' | 'blocked' | 'failed' | 'skipped';

export type TaskStepSnapshot = {
  id: string;
  title: string;
  status: TaskStepStatus;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
};

export type TaskSnapshot = {
  schemaVersion: typeof TASK_SNAPSHOT_SCHEMA_VERSION;
  taskId: string;
  title: string;
  status: TaskStatus;
  revision: number;
  steps: TaskStepSnapshot[];
  activeStepId?: string;
  summary?: string;
  createdAt: number;
  updatedAt: number;
};

export type TaskStepInput = { id: string; title: string };

export type TaskParseDiagnostic = ContractDiagnostic;
export type TaskParseResult<T> =
  | { ok: true; value: T; diagnostics: [] }
  | { ok: false; value: null; diagnostics: TaskParseDiagnostic[] };

const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['planning', 'running', 'waiting_user', 'completed', 'failed', 'interrupted', 'cancelled']);
const STEP_STATUSES: ReadonlySet<TaskStepStatus> = new Set(['pending', 'running', 'completed', 'blocked', 'failed', 'skipped']);
const TASK_TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'interrupted', 'cancelled']);

function requiredText(value: unknown, field: string): string {
  const text = asString(value, 1000);
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function optionalText(value: unknown): string | undefined {
  const text = asString(value, 2000);
  return text ?? undefined;
}

function validateStepInputs(value: unknown): TaskStepInput[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) throw new Error('steps must contain 2 to 8 items');
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    const record = asRecord(candidate) ?? {};
    const id = requiredText(record.id, `steps[${index}].id`);
    const title = requiredText(record.title, `steps[${index}].title`);
    if (ids.has(id)) throw new Error(`Duplicate step id: ${id}`);
    ids.add(id);
    return { id, title };
  });
}

function assertMutable(task: TaskSnapshot): void {
  if (TASK_TERMINAL.has(task.status)) throw new Error(`Task ${task.taskId} is terminal: ${task.status}`);
}

function assertTaskId(task: TaskSnapshot, taskId: unknown): void {
  if (taskId !== undefined && requiredText(taskId, 'taskId') !== task.taskId) throw new Error(`Task not found: ${String(taskId)}`);
}

/* ----------------------------- State transitions ---------------------------- */

export function isTerminalTask(task: TaskSnapshot): boolean {
  return TASK_TERMINAL.has(task.status);
}

export function createTask(input: { taskId: string; title: unknown; steps: unknown }, now: number = Date.now()): TaskSnapshot {
  const steps = validateStepInputs(input.steps).map<TaskStepSnapshot>((step) => ({ ...step, status: 'pending' }));
  return {
    schemaVersion: TASK_SNAPSHOT_SCHEMA_VERSION,
    taskId: requiredText(input.taskId, 'taskId'),
    title: requiredText(input.title, 'title'),
    status: 'planning',
    revision: 1,
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

export function reviseTask(
  task: TaskSnapshot,
  input: { taskId?: unknown; title?: unknown; steps: unknown },
  now: number = Date.now(),
): TaskSnapshot {
  assertMutable(task);
  assertTaskId(task, input.taskId);
  const nextInputs = validateStepInputs(input.steps);
  const nextIds = new Set(nextInputs.map((step) => step.id));
  for (const step of task.steps) {
    if (step.status === 'completed' && !nextIds.has(step.id)) throw new Error(`Cannot remove completed step: ${step.id}`);
  }
  const previous = new Map(task.steps.map((step) => [step.id, step]));
  const steps = nextInputs.map<TaskStepSnapshot>((step) => {
    const prior = previous.get(step.id);
    return prior ? { ...prior, title: step.title } : { ...step, status: 'pending' };
  });
  const activeStepId = steps.find((step) => step.status === 'running')?.id;
  return {
    ...task,
    title: optionalText(input.title) || task.title,
    status: activeStepId ? 'running' : task.status === 'waiting_user' ? 'running' : task.status,
    revision: task.revision + 1,
    steps,
    ...(activeStepId ? { activeStepId } : { activeStepId: undefined }),
    updatedAt: now,
  };
}

export function updateTaskStep(
  task: TaskSnapshot,
  input: { taskId?: unknown; stepId: unknown; status: unknown; summary?: unknown },
  now: number = Date.now(),
): TaskSnapshot {
  assertMutable(task);
  assertTaskId(task, input.taskId);
  const stepId = requiredText(input.stepId, 'stepId');
  if (!STEP_STATUSES.has(input.status as TaskStepStatus) || input.status === 'pending') {
    throw new Error(`Invalid step status: ${String(input.status)}`);
  }
  const status = input.status as Exclude<TaskStepStatus, 'pending'>;
  const index = task.steps.findIndex((step) => step.id === stepId);
  if (index < 0) throw new Error(`Step not found: ${stepId}`);
  const current = task.steps[index];
  if (current.status === 'completed' || current.status === 'skipped' || current.status === 'failed') {
    throw new Error(`Step ${stepId} is terminal: ${current.status}`);
  }
  if (status === 'running') {
    const active = task.steps.find((step) => step.status === 'running' && step.id !== stepId);
    if (active) throw new Error(`Step ${active.id} is already running`);
  }
  const summary = optionalText(input.summary);
  const nextStep: TaskStepSnapshot = {
    ...current,
    status,
    ...(summary ? { summary } : {}),
    ...(status === 'running' && current.startedAt === undefined ? { startedAt: now } : {}),
    ...(status === 'completed' || status === 'failed' || status === 'skipped' ? { completedAt: now } : {}),
  };
  const steps = task.steps.map((step, stepIndex) => stepIndex === index ? nextStep : step);
  const activeStepId = steps.find((step) => step.status === 'running')?.id;
  return {
    ...task,
    status: status === 'failed' ? 'failed' : 'running',
    revision: task.revision + 1,
    steps,
    ...(activeStepId ? { activeStepId } : { activeStepId: undefined }),
    updatedAt: now,
  };
}

export function finishTask(task: TaskSnapshot, input: { taskId?: unknown; summary?: unknown }, now: number = Date.now()): TaskSnapshot {
  assertMutable(task);
  assertTaskId(task, input.taskId);
  const unfinished = task.steps.filter((step) => step.status !== 'completed' && step.status !== 'skipped');
  if (unfinished.length) throw new Error(`Task has unfinished steps: ${unfinished.map((step) => step.id).join(', ')}`);
  const summary = optionalText(input.summary);
  return {
    ...task,
    status: 'completed',
    revision: task.revision + 1,
    activeStepId: undefined,
    ...(summary ? { summary } : {}),
    updatedAt: now,
  };
}

export function setTaskWaiting(task: TaskSnapshot, waiting: boolean, previousStatus?: TaskStatus, now: number = Date.now()): TaskSnapshot {
  assertMutable(task);
  return {
    ...task,
    status: waiting ? 'waiting_user' : previousStatus === 'planning' ? 'planning' : 'running',
    revision: task.revision + 1,
    updatedAt: now,
  };
}

function terminateTask(task: TaskSnapshot, status: 'failed' | 'interrupted' | 'cancelled', summary: unknown, now: number): TaskSnapshot {
  const text = optionalText(summary);
  const stepStatus: TaskStepStatus = status === 'failed' ? 'failed' : status === 'cancelled' ? 'skipped' : 'blocked';
  const steps = task.steps.map((step) => step.status === 'running' ? {
    ...step,
    status: stepStatus,
    ...(stepStatus === 'failed' || stepStatus === 'skipped' ? { completedAt: now } : {}),
  } : step);
  return {
    ...task,
    status,
    revision: task.revision + 1,
    steps,
    activeStepId: undefined,
    ...(text ? { summary: text } : {}),
    updatedAt: now,
  };
}

export function failTask(task: TaskSnapshot, summary?: unknown, now: number = Date.now()): TaskSnapshot {
  assertMutable(task);
  return terminateTask(task, 'failed', summary, now);
}

export function cancelTask(task: TaskSnapshot, summary?: unknown, now: number = Date.now()): TaskSnapshot {
  assertMutable(task);
  return terminateTask(task, 'cancelled', summary, now);
}

export function interruptTask(task: TaskSnapshot, now: number = Date.now()): TaskSnapshot {
  if (isTerminalTask(task)) return task;
  return terminateTask(task, 'interrupted', undefined, now);
}

/* ----------------------------------- Parser -------------------------------- */

/**
 * Parse a TaskSnapshot from a wire payload. Returns a structured diagnostic
 * describing unknown / out-of-range / bad-shape revisions.
 */
export function parseTaskSnapshotStructured(value: unknown): TaskParseResult<TaskSnapshot> {
  const diagnostics: TaskParseDiagnostic[] = [];
  if (!value || typeof value !== 'object') {
    return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'task', message: 'Task snapshot must be an object.' })] };
  }
  const task = value as JsonRecord;

  if (task.schemaVersion !== TASK_SNAPSHOT_SCHEMA_VERSION) {
    return {
      ok: false,
      value: null,
      diagnostics: [diagnostic({
        code: 'unknown_schema_version',
        path: 'task.schemaVersion',
        message: `Unsupported task schemaVersion ${JSON.stringify(task.schemaVersion)}; expected ${TASK_SNAPSHOT_SCHEMA_VERSION}.`,
        expected: TASK_SNAPSHOT_SCHEMA_VERSION,
        received: task.schemaVersion as number,
      })],
    };
  }

  const taskId = asString(task.taskId);
  const title = asString(task.title);
  if (!taskId) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'task.taskId', message: 'taskId is required.' }));
  if (!title) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'task.title', message: 'title is required.' }));

  if (!TASK_STATUSES.has(task.status as TaskStatus)) {
    diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'task.status', message: `Unknown task status ${JSON.stringify(task.status)}.` }));
  }

  const revision = asPositiveInteger(task.revision);
  if (revision === null) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path: 'task.revision', message: 'revision must be a positive integer.', received: task.revision as number }));
  }

  const createdAt = asFiniteNumber(task.createdAt);
  const updatedAt = asFiniteNumber(task.updatedAt);
  if (createdAt === null) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'task.createdAt', message: 'createdAt must be a finite number.' }));
  if (updatedAt === null) diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'task.updatedAt', message: 'updatedAt must be a finite number.' }));

  const stepsResult = parseSteps(task.steps, diagnostics);
  const activeStepId = asString(task.activeStepId);
  if (activeStepId && !stepsResult.byId.has(activeStepId)) {
    diagnostics.push(diagnostic({ code: 'unknown_reference', path: 'task.activeStepId', message: `activeStepId ${activeStepId} does not match any step id.` }));
  }
  const runningStepId = stepsResult.runningStepId;
  if (runningStepId && !activeStepId) {
    diagnostics.push(diagnostic({ code: 'missing_required_field', path: 'task.activeStepId', message: `activeStepId is required because step ${runningStepId} is running.` }));
  }

  if (diagnostics.some((diag) => diag.severity === 'error') || !taskId || !title || revision === null || createdAt === null || updatedAt === null) {
    return { ok: false, value: null, diagnostics };
  }

  return {
    ok: true,
    value: {
      schemaVersion: TASK_SNAPSHOT_SCHEMA_VERSION,
      taskId,
      title,
      status: task.status as TaskStatus,
      revision,
      steps: stepsResult.steps,
      ...(activeStepId ? { activeStepId } : {}),
      ...(typeof task.summary === 'string' ? { summary: task.summary } : {}),
      createdAt,
      updatedAt,
    },
    diagnostics: [],
  };
}

type ParseSteps = {
  steps: TaskStepSnapshot[];
  byId: Set<string>;
  runningStepId: string | null;
};

function parseSteps(value: unknown, diagnostics: TaskParseDiagnostic[]): ParseSteps {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    diagnostics.push(diagnostic({ code: 'out_of_range', path: 'task.steps', message: 'steps must contain between 2 and 8 entries.' }));
    return { steps: [], byId: new Set(), runningStepId: null };
  }
  const byId = new Set<string>();
  const steps: TaskStepSnapshot[] = [];
  let runningStepId: string | null = null;
  let runningCount = 0;
  for (let index = 0; index < value.length; index++) {
    const stepPath = `task.steps[${index}]`;
    const candidate = value[index];
    if (!candidate || typeof candidate !== 'object') {
      diagnostics.push(diagnostic({ code: 'invalid_type', path: stepPath, message: 'Step must be an object.' }));
      continue;
    }
    const step = candidate as JsonRecord;
    const id = asString(step.id, 80);
    const title = asString(step.title, 200);
    if (!id) diagnostics.push(diagnostic({ code: 'missing_required_field', path: `${stepPath}.id`, message: 'Step id is required.' }));
    if (!title) diagnostics.push(diagnostic({ code: 'missing_required_field', path: `${stepPath}.title`, message: 'Step title is required.' }));
    if (id && byId.has(id)) {
      diagnostics.push(diagnostic({ code: 'duplicate_id', path: `${stepPath}.id`, message: `Duplicate step id: ${id}` }));
      continue;
    }
    if (!STEP_STATUSES.has(step.status as TaskStepStatus)) {
      diagnostics.push(diagnostic({ code: 'unsupported_value', path: `${stepPath}.status`, message: `Unknown step status ${JSON.stringify(step.status)}.` }));
      continue;
    }
    if (step.status === 'running') {
      runningCount += 1;
      runningStepId = id ?? null;
    }
    if (id) byId.add(id);
    steps.push({
      id: id!,
      title: title!,
      status: step.status as TaskStepStatus,
      ...(typeof step.summary === 'string' ? { summary: step.summary } : {}),
      ...(typeof step.startedAt === 'number' ? { startedAt: step.startedAt } : {}),
      ...(typeof step.completedAt === 'number' ? { completedAt: step.completedAt } : {}),
    });
  }
  if (runningCount > 1) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'task.steps', message: 'At most one step may be running at a time.' }));
  }
  return { steps, byId, runningStepId };
}

/**
 * Backwards-compatible short-circuit: returns `null` on any hard failure
 * instead of a diagnostic. Used by call sites that just want a TaskSnapshot
 * or `null` and do not yet understand `ContractDiagnostic`.
 */
export function parseTaskSnapshot(value: unknown): TaskSnapshot | null {
  const result = parseTaskSnapshotStructured(value);
  return result.ok ? result.value : null;
}

/** Detect revision regression against a previously seen TaskSnapshot. */
export function acceptTaskSnapshotRevision(
  previous: TaskSnapshot | null,
  next: TaskSnapshot,
): { accepted: boolean; diagnostic?: TaskParseDiagnostic } {
  if (previous && next.revision <= previous.revision) {
    return {
      accepted: false,
      diagnostic: diagnostic({
        code: 'revision_regression',
        path: 'task.revision',
        message: `Incoming task revision ${next.revision} is not greater than current ${previous.revision}.`,
        severity: 'warning',
        expected: previous.revision + 1,
        received: next.revision,
      }),
    };
  }
  return { accepted: true };
}

export type TaskToolResultKind = 'tau-task' | 'tau-interaction';

export function parseTaskToolResultStructured(value: unknown): TaskParseResult<TaskSnapshot> {
  const details = asRecord(value);
  if (!details || (details.kind !== 'tau-task' && details.kind !== 'tau-interaction')) {
    return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'details', message: 'details.kind must be tau-task or tau-interaction.' })] };
  }
  return parseTaskSnapshotStructured(details.task);
}

export function parseTaskToolResult(result: unknown): TaskSnapshot | null {
  const outer = asRecord(result);
  return parseTaskToolResultStructured(outer?.details).value;
}

/** Parse the custom `pi-task-mode` state entry written by the Extension. */
export function parseTaskStateEntryStructured(value: unknown): TaskParseResult<{
  schemaVersion: 0 | 1;
  revision: number;
  enabled: boolean;
  task: TaskSnapshot | null;
}> {
  const entry = asRecord(value);
  const data = asRecord(entry?.data);
  if (!entry || entry.type !== 'custom' || entry.customType !== 'pi-task-mode' || typeof data?.enabled !== 'boolean') {
    return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'entry', message: 'Expected a pi-task-mode custom entry with boolean enabled.' })] };
  }
  const versioned = data.schemaVersion === 1 && Number.isInteger(data.revision) && Number(data.revision) >= 1;
  const legacy = data.schemaVersion === undefined && data.revision === undefined;
  if (!versioned && !legacy) {
    return { ok: false, value: null, diagnostics: [diagnostic({ code: 'unknown_schema_version', path: 'entry.data', message: 'Task state entry has invalid schemaVersion/revision combination.' })] };
  }
  const taskResult = data.task === undefined ? { ok: true, value: null as TaskSnapshot | null, diagnostics: [] as TaskParseDiagnostic[] } : parseTaskSnapshotStructured(data.task);
  if (!taskResult.ok) {
    return { ok: false, value: null, diagnostics: taskResult.diagnostics };
  }
  return {
    ok: true,
    value: {
      schemaVersion: versioned ? 1 : 0,
      revision: versioned ? Number(data.revision) : 0,
      enabled: data.enabled,
      task: taskResult.value,
    },
    diagnostics: [],
  };
}

/**
 * Backwards-compatible short-circuit variant returning the parsed value or
 * `null`. Used by Web Feature UI code that only needs the latest state shape
 * (no diagnostic surface).
 */
export function parseTaskStateEntry(value: unknown): {
  schemaVersion: 0 | 1;
  revision: number;
  enabled: boolean;
  task: TaskSnapshot | null;
} | null {
  const result = parseTaskStateEntryStructured(value);
  return result.ok ? result.value : null;
}

export function parseTaskModeEntry(value: unknown): boolean | null {
  const result = parseTaskStateEntryStructured(value);
  return result.ok ? result.value.enabled : null;
}

// Re-export the "tasks." constant used as a small piece of public surface.
export const TASK_CONTRACT_NAMESPACE = 'tasks' as const;
