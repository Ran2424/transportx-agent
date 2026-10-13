const bySession = new Map<string, Map<string, boolean>>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export const toolExpansionStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  get(sessionId: string, toolCallId: string) { return bySession.get(sessionId)?.get(toolCallId); },
  set(sessionId: string, toolCallId: string, open: boolean) {
    const choices = bySession.get(sessionId) || new Map<string, boolean>();
    choices.set(toolCallId, open);
    bySession.set(sessionId, choices);
    emit();
  },
  // null retains a loading/running session until its complete projection is available.
  reconcile(sessions: Map<string, Set<string> | null>) {
    let changed = false;
    for (const [sessionId, choices] of bySession) {
      if (!sessions.has(sessionId)) { bySession.delete(sessionId); changed = true; continue; }
      const ids = sessions.get(sessionId);
      if (ids === null) continue;
      for (const id of choices.keys()) {
        if (!ids?.has(id)) { choices.delete(id); changed = true; }
      }
      if (!choices.size) bySession.delete(sessionId);
    }
    if (changed) emit();
  },
};
