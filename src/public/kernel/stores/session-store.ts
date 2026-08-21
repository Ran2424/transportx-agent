/**
 * Session store: live session list, the active session id and the per-session
 * streaming/compaction flags. isStreaming is derived here — and only here —
 * from agent_start/agent_settled events and server snapshots, avoiding duplicate
 * streaming state in presentation code.
 */

import type { LiveSession, SessionAttachment, SessionSnapshot } from '../../app-types.js';
import { createStore, type Store, type StoreListener } from '../store.js';

export type SessionStoreState = {
  sessions: LiveSession[];
  activeSessionId: string | null;
  streamingBySession: Record<string, boolean>;
  compactingBySession: Record<string, boolean>;
  attachmentsBySession: Record<string, Record<string, SessionAttachment>>;
  attachmentRevisionBySession: Record<string, number>;
};

const INITIAL: SessionStoreState = { sessions: [], activeSessionId: null, streamingBySession: {}, compactingBySession: {}, attachmentsBySession: {}, attachmentRevisionBySession: {} };

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

  isCompacting(sessionId: string): boolean {
    return !!this.store.get().compactingBySession[sessionId];
  }

  listReceived(sessions: LiveSession[]) {
    this.store.set((prev) => {
      const streamingBySession: Record<string, boolean> = {};
      const compactingBySession: Record<string, boolean> = {};
      const attachmentsBySession: Record<string, Record<string, SessionAttachment>> = {};
      const attachmentRevisionBySession: Record<string, number> = {};
      for (const session of sessions) {
        if (session.id) streamingBySession[session.id] = !!session.isStreaming;
        if (session.id) compactingBySession[session.id] = !!session.isCompacting;
        if (session.id && prev.attachmentsBySession[session.id]) attachmentsBySession[session.id] = prev.attachmentsBySession[session.id];
        if (session.id && prev.attachmentRevisionBySession[session.id]) attachmentRevisionBySession[session.id] = prev.attachmentRevisionBySession[session.id];
      }
      const activeSessionId = prev.activeSessionId && sessions.some((s) => s.id === prev.activeSessionId)
        ? prev.activeSessionId
        : null;
      return { sessions, activeSessionId, streamingBySession, compactingBySession, attachmentsBySession, attachmentRevisionBySession };
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
      const compactingBySession = session.isCompacting === undefined
        ? prev.compactingBySession
        : { ...prev.compactingBySession, [session.id]: !!session.isCompacting };
      return { ...prev, sessions, streamingBySession, compactingBySession };
    });
  }

  closed(sessionId: string) {
    this.store.set((prev) => {
      const sessions = prev.sessions.filter((s) => s.id !== sessionId);
      const streamingBySession = { ...prev.streamingBySession };
      const compactingBySession = { ...prev.compactingBySession };
      const attachmentsBySession = { ...prev.attachmentsBySession };
      const attachmentRevisionBySession = { ...prev.attachmentRevisionBySession };
      delete streamingBySession[sessionId];
      delete compactingBySession[sessionId];
      delete attachmentsBySession[sessionId];
      delete attachmentRevisionBySession[sessionId];
      const activeSessionId = prev.activeSessionId === sessionId ? null : prev.activeSessionId;
      return { sessions, activeSessionId, streamingBySession, compactingBySession, attachmentsBySession, attachmentRevisionBySession };
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

  setCompacting(sessionId: string, compacting: boolean) {
    this.store.set((prev) => ({
      ...prev,
      compactingBySession: { ...prev.compactingBySession, [sessionId]: compacting },
    }));
  }

  setAttachments(sessionId: string, attachments: SessionAttachment[]) {
    this.store.set((prev) => ({
      ...prev,
      attachmentsBySession: { ...prev.attachmentsBySession, [sessionId]: Object.fromEntries(attachments.map((attachment) => [attachment.id, attachment])) },
      attachmentRevisionBySession: { ...prev.attachmentRevisionBySession, [sessionId]: (prev.attachmentRevisionBySession[sessionId] ?? 0) + 1 },
    }));
  }

  addAttachment(sessionId: string, attachment: SessionAttachment) {
    this.store.set((prev) => ({
      ...prev,
      attachmentsBySession: { ...prev.attachmentsBySession, [sessionId]: { ...prev.attachmentsBySession[sessionId], [attachment.id]: attachment } },
      attachmentRevisionBySession: { ...prev.attachmentRevisionBySession, [sessionId]: (prev.attachmentRevisionBySession[sessionId] ?? 0) + 1 },
    }));
  }

  removeAttachment(sessionId: string, attachmentId: string) {
    this.store.set((prev) => {
      const attachments = { ...prev.attachmentsBySession[sessionId] };
      delete attachments[attachmentId];
      return {
        ...prev,
        attachmentsBySession: { ...prev.attachmentsBySession, [sessionId]: attachments },
        attachmentRevisionBySession: { ...prev.attachmentRevisionBySession, [sessionId]: (prev.attachmentRevisionBySession[sessionId] ?? 0) + 1 },
      };
    });
  }

  applySnapshot(sessionId: string, snapshot: SessionSnapshot) {
    if (snapshot.session) this.upsert({ ...snapshot.session, id: snapshot.session.id ?? sessionId });
    if (snapshot.isStreaming !== undefined) this.setStreaming(sessionId, !!snapshot.isStreaming);
    if (snapshot.isCompacting !== undefined) this.setCompacting(sessionId, !!snapshot.isCompacting);
  }
}
