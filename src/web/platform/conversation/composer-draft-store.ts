import type { SessionAttachment } from '../../../public/app-types.js';
import { createStore } from '../../../public/kernel/store.js';

export type PendingAttachment = { localId: string; name: string; attachment?: SessionAttachment; status: 'uploading' | 'ready' | 'error'; error?: string };
type Draft = { message: string; pending: PendingAttachment[] };
const store = createStore<Record<string, Draft>>({});
const EMPTY: PendingAttachment[] = [];
const storageKey = (sessionId: string) => `tau-composer-draft:${sessionId}`;

export const composerDraftStore = {
  subscribe(listener: () => void) { return store.subscribe(listener); },
  getMessage(sessionId: string) {
    const draft = store.get()[sessionId];
    if (draft) return draft.message;
    try { return window.localStorage.getItem(storageKey(sessionId)) || ''; }
    catch { return ''; }
  },
  getPending(sessionId: string) { return store.get()[sessionId]?.pending || EMPTY; },
  setMessage(sessionId: string, message: string) {
    store.set((state) => ({ ...state, [sessionId]: { message, pending: this.getPending(sessionId) } }));
    try {
      if (message) window.localStorage.setItem(storageKey(sessionId), message);
      else window.localStorage.removeItem(storageKey(sessionId));
    } catch { /* Keep the in-memory draft when browser storage is unavailable or full. */ }
  },
  setPending(sessionId: string, update: PendingAttachment[] | ((current: PendingAttachment[]) => PendingAttachment[])) {
    const pending = typeof update === 'function' ? update(this.getPending(sessionId)) : update;
    const message = this.getMessage(sessionId);
    store.set((state) => ({ ...state, [sessionId]: { message, pending } }));
  },
};
