/**
 * Tool execution store: per-session map of toolCallId -> execution record.
 * Update/end events arriving for an unknown call create the record on the
 * fly so mid-stream attach still shows a coherent execution.
 */

import type { ToolExecution } from '../actions.js';
import { createStore, type Store, type StoreListener } from '../store.js';

export type ToolExecutionStoreState = {
  bySession: Record<string, Record<string, ToolExecution>>;
};

export class ToolExecutionStore {
  private readonly store: Store<ToolExecutionStoreState> = createStore<ToolExecutionStoreState>({ bySession: {} });

  get(): ToolExecutionStoreState {
    return this.store.get();
  }

  subscribe(listener: StoreListener<ToolExecutionStoreState>): () => void {
    return this.store.subscribe(listener);
  }

  private patch(sessionId: string, toolCallId: string, update: Partial<ToolExecution>) {
    if (!toolCallId) return;
    this.store.set((prev) => {
      const sessionMap = prev.bySession[sessionId] ?? {};
      const existing = sessionMap[toolCallId] ?? { toolCallId, status: 'running' as const };
      return {
        bySession: {
          ...prev.bySession,
          [sessionId]: { ...sessionMap, [toolCallId]: { ...existing, ...update } },
        },
      };
    });
  }

  started(sessionId: string, execution: ToolExecution) {
    this.patch(sessionId, execution.toolCallId, execution);
  }

  updated(sessionId: string, toolCallId: string, partialResult: unknown) {
    this.patch(sessionId, toolCallId, { partialResult });
  }

  ended(sessionId: string, toolCallId: string, update: { toolName?: string; result?: unknown; isError?: boolean }) {
    this.patch(sessionId, toolCallId, {
      toolName: update.toolName,
      result: update.result,
      isError: update.isError,
      status: update.isError ? 'error' : 'completed',
    });
  }

  dropSession(sessionId: string) {
    this.store.set((prev) => {
      if (!(sessionId in prev.bySession)) return prev;
      const bySession = { ...prev.bySession };
      delete bySession[sessionId];
      return { bySession };
    });
  }
}
