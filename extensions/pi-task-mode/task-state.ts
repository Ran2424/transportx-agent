/**
 * Re-export shim. The contract authority for task-mode state is
 * `src/contracts/task.ts`. `extensions/pi-task-mode/index.ts` imports its
 * `parseTaskSnapshot`, mutation helpers and types from this module to keep
 * the original import surface.
 */
export {
  parseTaskSnapshot,
  parseTaskSnapshotStructured,
  parseTaskStateEntry,
  parseTaskStateEntryStructured,
  parseTaskToolResult,
  parseTaskToolResultStructured,
  parseTaskModeEntry,
  acceptTaskSnapshotRevision,
  isTerminalTask,
  createTask,
  reviseTask,
  updateTaskStep,
  finishTask,
  failTask,
  cancelTask,
  interruptTask,
  setTaskWaiting,
} from '../../src/contracts/task.ts';

export type {
  TaskStatus,
  TaskStepStatus,
  TaskStepSnapshot,
  TaskSnapshot,
  TaskStepInput,
  TaskParseDiagnostic,
  TaskParseResult,
} from '../../src/contracts/task.ts';
