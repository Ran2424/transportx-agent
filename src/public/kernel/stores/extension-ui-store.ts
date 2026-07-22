/**
 * Extension UI store: current request plus a per-session queue. Semantics
 * mirror controllers/extension-ui-controller.ts — enqueue (dedup by request
 * id), suspendForSession on tab switch, dropSession on close — but DOM-free:
 * background sessions never take over `current`.
 */

import type { AppEvent } from '../../app-types.js';
import { createStore, type Store, type StoreListener } from '../store.js';

export type ExtensionUiPending = { sessionId: string | null; request: AppEvent };

export type ExtensionUiState = {
  current: ExtensionUiPending | null;
  queue: ExtensionUiPending[];
};

export class ExtensionUiStore {
  private readonly store: Store<ExtensionUiState> = createStore<ExtensionUiState>({ current: null, queue: [] });

  get(): ExtensionUiState {
    return this.store.get();
  }

  subscribe(listener: StoreListener<ExtensionUiState>): () => void {
    return this.store.subscribe(listener);
  }

  private static sameRequest(a: ExtensionUiPending, sessionId: string | null, request: AppEvent): boolean {
    return a.sessionId === sessionId && request.id !== undefined && a.request.id === request.id;
  }

  private has(sessionId: string | null, request: AppEvent): boolean {
    const { current, queue } = this.store.get();
    return (!!current && ExtensionUiStore.sameRequest(current, sessionId, request))
      || queue.some((p) => ExtensionUiStore.sameRequest(p, sessionId, request));
  }

  /** Promote the first queued request for the given session, if any. */
  private static promote(state: ExtensionUiState, sessionId: string | null): ExtensionUiState {
    if (state.current || sessionId === null) return state;
    const index = state.queue.findIndex((p) => p.sessionId === sessionId);
    if (index === -1) return state;
    const queue = [...state.queue];
    const [next] = queue.splice(index, 1);
    return { current: next, queue };
  }

  requested(sessionId: string | null, request: AppEvent, activeSessionId: string | null) {
    if (request.id !== undefined && this.has(sessionId, request)) return;
    this.store.set((prev) => {
      if (sessionId === null) return { ...prev, current: { sessionId, request } };
      if (!prev.current && sessionId === activeSessionId) return { ...prev, current: { sessionId, request } };
      return { ...prev, queue: [...prev.queue, { sessionId, request }] };
    });
  }

  resolved(requestId: string | undefined, activeSessionId: string | null) {
    this.store.set((prev) => {
      if (!prev.current) return prev;
      if (requestId !== undefined && prev.current.request.id !== requestId) return prev;
      return ExtensionUiStore.promote({ ...prev, current: null }, activeSessionId);
    });
  }

  /** Tab switch: suspend the current dialog back into the queue, then promote. */
  activated(sessionId: string | null) {
    this.store.set((prev) => {
      let state = prev;
      if (state.current?.sessionId && state.current.sessionId !== sessionId) {
        const suspended = state.current;
        const alreadyQueued = suspended.request.id !== undefined
          && state.queue.some((p) => ExtensionUiStore.sameRequest(p, suspended.sessionId, suspended.request));
        state = {
          current: null,
          queue: alreadyQueued ? state.queue : [suspended, ...state.queue],
        };
      }
      return ExtensionUiStore.promote(state, sessionId);
    });
  }

  dropSession(sessionId: string) {
    this.store.set((prev) => ({
      current: prev.current?.sessionId === sessionId ? null : prev.current,
      queue: prev.queue.filter((p) => p.sessionId !== sessionId),
    }));
  }
}
