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
    this.patch(sessionId, execution.toolCallId, { ...execution, startedAt: execution.startedAt ?? Date.now() });
  }

  preparing(sessionId: string, execution: ToolExecution) {
    this.patch(sessionId, execution.toolCallId, { ...execution, status: 'preparing', argumentChars: execution.argumentChars ?? 0 });
  }

  argumentsUpdated(sessionId: string, toolCallId: string, update: { toolName?: string; args?: Record<string, unknown>; argumentChars: number }) {
    const existing = this.store.get().bySession[sessionId]?.[toolCallId];
    this.patch(sessionId, toolCallId, {
      toolName: update.toolName ?? existing?.toolName,
      args: update.args ?? existing?.args,
      argumentChars: (existing?.argumentChars ?? 0) + update.argumentChars,
      status: existing?.status === 'running' ? 'running' : 'preparing',
    });
  }

  updated(sessionId: string, toolCallId: string, partialResult: unknown) {
    this.patch(sessionId, toolCallId, { partialResult });
  }

  ended(sessionId: string, toolCallId: string, update: { toolName?: string; result?: unknown; isError?: boolean; startedAt?: number; endedAt?: number; durationMs?: number }) {
    const existing = this.store.get().bySession[sessionId]?.[toolCallId];
    const endedAt = update.endedAt ?? Date.now();
    const startedAt = update.startedAt ?? existing?.startedAt;
    this.patch(sessionId, toolCallId, {
      toolName: update.toolName,
      result: update.result,
      isError: update.isError,
      startedAt,
      endedAt,
      durationMs: update.durationMs ?? (startedAt === undefined ? undefined : Math.max(0, endedAt - startedAt)),
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
