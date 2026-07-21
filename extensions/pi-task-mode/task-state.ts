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
  schemaVersion: 1;
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

const TASK_TERMINAL = new Set<TaskStatus>(['completed', 'failed', 'interrupted', 'cancelled']);
const STEP_STATUSES = new Set<TaskStepStatus>(['pending', 'running', 'completed', 'blocked', 'failed', 'skipped']);
const TASK_STATUSES = new Set<TaskStatus>(['planning', 'running', 'waiting_user', 'completed', 'failed', 'interrupted', 'cancelled']);

function requiredText(value: unknown, field: string) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function optionalText(value: unknown) {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  return text || undefined;
}

function validateStepInputs(value: unknown): TaskStepInput[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) throw new Error('steps must contain 2 to 8 items');
  const ids = new Set<string>();
  return value.map((candidate, index) => {
    const record = candidate && typeof candidate === 'object' ? candidate as Record<string, unknown> : {};
    const id = requiredText(record.id, `steps[${index}].id`);
    const title = requiredText(record.title, `steps[${index}].title`);
    if (ids.has(id)) throw new Error(`Duplicate step id: ${id}`);
    ids.add(id);
    return { id, title };
  });
}

function assertMutable(task: TaskSnapshot) {
  if (TASK_TERMINAL.has(task.status)) throw new Error(`Task ${task.taskId} is terminal: ${task.status}`);
}

function assertTaskId(task: TaskSnapshot, taskId: unknown) {
  if (taskId !== undefined && requiredText(taskId, 'taskId') !== task.taskId) throw new Error(`Task not found: ${String(taskId)}`);
}

export function isTerminalTask(task: TaskSnapshot) {
  return TASK_TERMINAL.has(task.status);
}

export function createTask(input: { taskId: string; title: unknown; steps: unknown }, now = Date.now()): TaskSnapshot {
  const steps = validateStepInputs(input.steps).map<TaskStepSnapshot>((step) => ({ ...step, status: 'pending' }));
  return {
    schemaVersion: 1,
    taskId: requiredText(input.taskId, 'taskId'),
    title: requiredText(input.title, 'title'),
    status: 'planning',
    revision: 1,
    steps,
    createdAt: now,
    updatedAt: now,
  };
}

export function reviseTask(task: TaskSnapshot, input: { taskId?: unknown; title?: unknown; steps: unknown }, now = Date.now()) {
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
    status: activeStepId ? 'running' as const : task.status === 'waiting_user' ? 'running' as const : task.status,
    revision: task.revision + 1,
    steps,
    ...(activeStepId ? { activeStepId } : { activeStepId: undefined }),
    updatedAt: now,
  };
}

export function updateTaskStep(task: TaskSnapshot, input: { taskId?: unknown; stepId: unknown; status: unknown; summary?: unknown }, now = Date.now()) {
  assertMutable(task);
  assertTaskId(task, input.taskId);
  const stepId = requiredText(input.stepId, 'stepId');
  if (!STEP_STATUSES.has(input.status as TaskStepStatus) || input.status === 'pending') throw new Error(`Invalid step status: ${String(input.status)}`);
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
    ...((status === 'running' && current.startedAt === undefined) ? { startedAt: now } : {}),
    ...((status === 'completed' || status === 'failed' || status === 'skipped') ? { completedAt: now } : {}),
  };
  const steps = task.steps.map((step, stepIndex) => stepIndex === index ? nextStep : step);
  const activeStepId = steps.find((step) => step.status === 'running')?.id;
  return {
    ...task,
    status: status === 'failed' ? 'failed' as const : 'running' as const,
    revision: task.revision + 1,
    steps,
    ...(activeStepId ? { activeStepId } : { activeStepId: undefined }),
    updatedAt: now,
  };
}

export function finishTask(task: TaskSnapshot, input: { taskId?: unknown; summary?: unknown }, now = Date.now()) {
  assertMutable(task);
  assertTaskId(task, input.taskId);
  const unfinished = task.steps.filter((step) => step.status !== 'completed' && step.status !== 'skipped');
  if (unfinished.length) throw new Error(`Task has unfinished steps: ${unfinished.map((step) => step.id).join(', ')}`);
  const summary = optionalText(input.summary);
  return {
    ...task,
    status: 'completed' as const,
    revision: task.revision + 1,
    activeStepId: undefined,
    ...(summary ? { summary } : {}),
    updatedAt: now,
  };
}

export function setTaskWaiting(task: TaskSnapshot, waiting: boolean, previousStatus?: TaskStatus, now = Date.now()) {
  assertMutable(task);
  return {
    ...task,
    status: waiting ? 'waiting_user' as const : (previousStatus === 'planning' ? 'planning' as const : 'running' as const),
    revision: task.revision + 1,
    updatedAt: now,
  };
}

function terminateTask(task: TaskSnapshot, status: 'failed' | 'interrupted' | 'cancelled', summary: unknown, now: number) {
  const text = optionalText(summary);
  const stepStatus: TaskStepStatus = status === 'failed' ? 'failed' : status === 'cancelled' ? 'skipped' : 'blocked';
  const steps = task.steps.map((step) => step.status === 'running' ? {
    ...step,
    status: stepStatus,
    ...((stepStatus === 'failed' || stepStatus === 'skipped') ? { completedAt: now } : {}),
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

export function failTask(task: TaskSnapshot, summary?: unknown, now = Date.now()) {
  assertMutable(task);
  return terminateTask(task, 'failed', summary, now);
}

export function cancelTask(task: TaskSnapshot, summary?: unknown, now = Date.now()) {
  assertMutable(task);
  return terminateTask(task, 'cancelled', summary, now);
}

export function interruptTask(task: TaskSnapshot, now = Date.now()) {
  if (isTerminalTask(task)) return task;
  return terminateTask(task, 'interrupted', undefined, now);
}

export function parseTaskSnapshot(value: unknown): TaskSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const task = value as Record<string, unknown>;
  if (task.schemaVersion !== 1 || typeof task.taskId !== 'string' || !task.taskId.trim() || typeof task.title !== 'string' || !task.title.trim()) return null;
  if (!TASK_STATUSES.has(task.status as TaskStatus) || !Number.isInteger(task.revision) || (task.revision as number) < 1) return null;
  if (!Number.isFinite(task.createdAt) || !Number.isFinite(task.updatedAt) || !Array.isArray(task.steps)) return null;
  const ids = new Set<string>();
  const steps: TaskStepSnapshot[] = [];
  for (const candidate of task.steps) {
    if (!candidate || typeof candidate !== 'object') return null;
    const step = candidate as Record<string, unknown>;
    if (typeof step.id !== 'string' || !step.id.trim() || ids.has(step.id) || typeof step.title !== 'string' || !step.title.trim()) return null;
    if (!STEP_STATUSES.has(step.status as TaskStepStatus)) return null;
    ids.add(step.id);
    steps.push({
      id: step.id,
      title: step.title,
      status: step.status as TaskStepStatus,
      ...(typeof step.summary === 'string' ? { summary: step.summary } : {}),
      ...(typeof step.startedAt === 'number' ? { startedAt: step.startedAt } : {}),
      ...(typeof step.completedAt === 'number' ? { completedAt: step.completedAt } : {}),
    });
  }
  if (steps.length < 2 || steps.length > 8) return null;
  return {
    schemaVersion: 1,
    taskId: task.taskId,
    title: task.title,
    status: task.status as TaskStatus,
    revision: task.revision as number,
    steps,
    ...(typeof task.activeStepId === 'string' ? { activeStepId: task.activeStepId } : {}),
    ...(typeof task.summary === 'string' ? { summary: task.summary } : {}),
    createdAt: task.createdAt as number,
    updatedAt: task.updatedAt as number,
  };
}
