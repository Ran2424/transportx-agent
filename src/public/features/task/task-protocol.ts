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

const TASK_STATUSES = new Set<TaskStatus>(['planning', 'running', 'waiting_user', 'completed', 'failed', 'interrupted', 'cancelled']);
const STEP_STATUSES = new Set<TaskStepStatus>(['pending', 'running', 'completed', 'blocked', 'failed', 'skipped']);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalTime(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function parseTaskSnapshot(value: unknown): TaskSnapshot | null {
  const task = record(value);
  if (!task || task.schemaVersion !== 1) return null;
  if (!optionalText(task.taskId) || !optionalText(task.title)) return null;
  if (!TASK_STATUSES.has(task.status as TaskStatus)) return null;
  if (!Number.isInteger(task.revision) || Number(task.revision) < 1) return null;
  if (optionalTime(task.createdAt) === undefined || optionalTime(task.updatedAt) === undefined) return null;
  if (!Array.isArray(task.steps) || task.steps.length < 2 || task.steps.length > 8) return null;

  const ids = new Set<string>();
  const steps: TaskStepSnapshot[] = [];
  let runningStepId: string | undefined;
  for (const candidate of task.steps) {
    const step = record(candidate);
    const id = optionalText(step?.id);
    const title = optionalText(step?.title);
    if (!step || !id || !title || ids.has(id) || !STEP_STATUSES.has(step.status as TaskStepStatus)) return null;
    if (step.status === 'running') {
      if (runningStepId) return null;
      runningStepId = id;
    }
    ids.add(id);
    steps.push({
      id,
      title,
      status: step.status as TaskStepStatus,
      ...(optionalText(step.summary) ? { summary: optionalText(step.summary) } : {}),
      ...(optionalTime(step.startedAt) !== undefined ? { startedAt: optionalTime(step.startedAt) } : {}),
      ...(optionalTime(step.completedAt) !== undefined ? { completedAt: optionalTime(step.completedAt) } : {}),
    });
  }

  const activeStepId = optionalText(task.activeStepId);
  if (activeStepId && (!ids.has(activeStepId) || activeStepId !== runningStepId)) return null;
  if (!activeStepId && runningStepId) return null;

  return {
    schemaVersion: 1,
    taskId: task.taskId as string,
    title: task.title as string,
    status: task.status as TaskStatus,
    revision: task.revision as number,
    steps,
    ...(activeStepId ? { activeStepId } : {}),
    ...(optionalText(task.summary) ? { summary: optionalText(task.summary) } : {}),
    createdAt: task.createdAt as number,
    updatedAt: task.updatedAt as number,
  };
}

export function parseTaskToolResult(result: unknown) {
  const details = record(record(result)?.details);
  if (!details || (details.kind !== 'tau-task' && details.kind !== 'tau-interaction')) return null;
  return parseTaskSnapshot(details.task);
}

export function parseTaskModeEntry(value: unknown) {
  return parseTaskStateEntry(value)?.enabled ?? null;
}

export function parseTaskStateEntry(value: unknown) {
  const entry = record(value);
  const data = record(entry?.data);
  if (!entry || entry.type !== 'custom' || entry.customType !== 'pi-task-mode' || typeof data?.enabled !== 'boolean') return null;
  return { enabled: data.enabled, task: parseTaskSnapshot(data.task) };
}
