import type { CanvasContextV1 } from '../../../contracts/canvas.ts';

const bySession = new Map<string, Array<CanvasContextV1 & { displayTitle?: string }>>();
const listeners = new Set<() => void>();
const EMPTY_CONTEXTS: Array<CanvasContextV1 & { displayTitle?: string }> = [];

function emit() { for (const listener of listeners) listener(); }

export const canvasContextStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  get(sessionId: string) { return bySession.get(sessionId) ?? EMPTY_CONTEXTS; },
  add(sessionId: string, context: CanvasContextV1, displayTitle?: string) {
    const current = bySession.get(sessionId) ?? [];
    bySession.set(sessionId, [...current.filter((item) => item.contextId !== context.contextId), { ...context, displayTitle }]);
    emit();
  },
  remove(sessionId: string, contextId: string) {
    bySession.set(sessionId, (bySession.get(sessionId) ?? []).filter((item) => item.contextId !== contextId));
    emit();
  },
  clear(sessionId: string) { if (bySession.delete(sessionId)) emit(); },
};
