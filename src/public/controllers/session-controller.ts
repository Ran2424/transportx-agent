import type { LiveSession } from '../app-types.js';

export class SessionController {
  readonly sessions: LiveSession[] = [];
  activeSessionId: string | null = null;

  replace(sessions: LiveSession[]) {
    this.sessions.splice(0, this.sessions.length, ...(sessions || []));
  }

  upsert(session: LiveSession) {
    const index = this.sessions.findIndex((candidate) => candidate.id === session.id);
    if (index === -1) this.sessions.push(session);
    else this.sessions[index] = { ...this.sessions[index], ...session };
    return this.sessions.find((candidate) => candidate.id === session.id)!;
  }

  remove(sessionId: string) {
    const index = this.sessions.findIndex((candidate) => candidate.id === sessionId);
    if (index !== -1) this.sessions.splice(index, 1);
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
  }

  activate(sessionId: string | null) { this.activeSessionId = sessionId; }
  get(sessionId: string | null | undefined) { return sessionId ? this.sessions.find((candidate) => candidate.id === sessionId) || null : null; }
  mostRecent() {
    return [...this.sessions].sort((a, b) =>
      new Date(b.lastActiveAt || b.createdAt || 0).getTime() - new Date(a.lastActiveAt || a.createdAt || 0).getTime()
    )[0] || null;
  }
}
