import type { SessionEntry } from '../../../public/app-types.js';
import type { ToolExecution } from '../../../public/kernel/actions.js';
import { acceptTaskSnapshotRevision, parseTaskStateEntry, parseTaskToolResult, type TaskSnapshot } from '../../../contracts/task.js';

export type TaskFeatureState = { enabled: boolean; task: TaskSnapshot | null };

/** Pure task-domain projection shared by snapshot hydration and live tool updates. */
export function projectTaskState(entries: SessionEntry[], executions: ToolExecution[]): TaskFeatureState {
  let enabled = false;
  let task: TaskSnapshot | null = null;
  const accept = (candidate: TaskSnapshot | null) => {
    if (candidate && acceptTaskSnapshotRevision(task, candidate).accepted) task = candidate;
  };
  for (const entry of entries) {
    const state = parseTaskStateEntry(entry);
    if (state) { enabled = state.enabled; accept(state.task); }
    accept(parseTaskToolResult(entry.message));
  }
  for (const execution of executions) accept(parseTaskToolResult(execution.result));
  return { enabled, task };
}
