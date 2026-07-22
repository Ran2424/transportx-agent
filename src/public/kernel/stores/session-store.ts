/**
 * Session store: live session list, the active session id and the per-session
 * streaming flag. isStreaming is derived here — and only here — from
 * agent_start/agent_end events and server snapshots, ending the legacy
 * RuntimeStore/StateManager/LiveSession triple-write.
 */

import type { LiveSession, SessionSnapshot } from '../../app-types.js';
import { createStore, type Store, type StoreListener } from '../store.js';

export type SessionStoreState = {
  sessions: LiveSession[];
  activeSessionId: string | null;
  streamingBySession: Record<string, boolean>;
};

const INITIAL: SessionStoreState = { sessions: [], activeSessionId: null, streamingBySession: {} };

export class SessionStore {
  private readonly store: Store<SessionStoreState> = createStore<SessionStoreState>(INITIAL);

  get(): SessionStoreState {
    return this.store.get();
  }

  subscribe(listener: StoreListener<SessionStoreState>): () => void {
    return this.store.subscribe(listener);
  }

  isStreaming(sessionId: string): boolean {
    return !!this.store.get().streamingBySession[sessionId];
  }

  listReceived(sessions: LiveSession[]) {
    this.store.set((prev) => {
      const streamingBySession: Record<string, boolean> = {};
      for (const session of sessions) {
        if (session.id) streamingBySession[session.id] = !!session.isStreaming;
      }
      const activeSessionId = prev.activeSessionId && sessions.some((s) => s.id === prev.activeSessionId)
        ? prev.activeSessionId
        : null;
      return { sessions, activeSessionId, streamingBySession };
    });
  }

  upsert(session: LiveSession) {
    if (!session?.id) return;
    this.store.set((prev) => {
      const index = prev.sessions.findIndex((s) => s.id === session.id);
      const sessions = index === -1
        ? [...prev.sessions, session]
        : prev.sessions.map((s, i) => (i === index ? { ...s, ...session } : s));
      const streamingBySession = session.isStreaming === undefined
        ? prev.streamingBySession
        : { ...prev.streamingBySession, [session.id]: !!session.isStreaming };
      return { ...prev, sessions, streamingBySession };
    });
  }

  closed(sessionId: string) {
    this.store.set((prev) => {
      const sessions = prev.sessions.filter((s) => s.id !== sessionId);
      const streamingBySession = { ...prev.streamingBySession };
      delete streamingBySession[sessionId];
      const activeSessionId = prev.activeSessionId === sessionId ? null : prev.activeSessionId;
      return { sessions, activeSessionId, streamingBySession };
    });
  }

  activated(sessionId: string | null) {
    this.store.set((prev) => ({ ...prev, activeSessionId: sessionId }));
  }

  setStreaming(sessionId: string, streaming: boolean) {
    this.store.set((prev) => ({
      ...prev,
      streamingBySession: { ...prev.streamingBySession, [sessionId]: streaming },
    }));
  }

  applySnapshot(sessionId: string, snapshot: SessionSnapshot) {
    if (snapshot.session) this.upsert({ ...snapshot.session, id: snapshot.session.id ?? sessionId });
    if (snapshot.isStreaming !== undefined) this.setStreaming(sessionId, !!snapshot.isStreaming);
  }
}
