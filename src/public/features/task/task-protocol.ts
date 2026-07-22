/**
 * Re-export shim. The contract authority for task-mode is
 * `src/contracts/task.ts`. Legacy tests (`test/task-mode-web.test.ts`,
 * `test/task-mode-extension.test.ts`) and the Web Feature still import from
 * here; new code should import from `../../../contracts/index.js`.
 *
 * The behaviour of `parseTaskSnapshot` is now stricter than the previous
 * shim: a `running` step without `activeStepId` is rejected (and surfaced as a
 * `missing_required_field` diagnostic). Both call sites have always supplied
 * the field in practice.
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
} from '../../../contracts/task.ts';
export type {
  TaskStatus,
  TaskStepStatus,
  TaskStepSnapshot,
  TaskSnapshot,
  TaskStepInput,
  TaskParseDiagnostic,
  TaskParseResult,
} from '../../../contracts/task.ts';
