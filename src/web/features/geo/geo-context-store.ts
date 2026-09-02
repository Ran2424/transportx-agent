import type { GeoClientContextV1, GeoContextReferenceV1 } from '../../../contracts/geo.js';

export type AttachedGeoContext = { reference: GeoContextReferenceV1; context: GeoClientContextV1 };
const bySession = new Map<string, AttachedGeoContext[]>();
const listeners = new Set<() => void>();
const EMPTY: AttachedGeoContext[] = [];

function publish() { for (const listener of listeners) listener(); }

export const geoContextStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  get(sessionId: string) { return bySession.get(sessionId) || EMPTY; },
  attach(sessionId: string, item: AttachedGeoContext) {
    const current = bySession.get(sessionId) || [];
    if (current.some((entry) => entry.reference.contextId === item.reference.contextId)) return;
    if (current.length >= 8) throw new Error('一条消息最多附加 8 个地图上下文。');
    bySession.set(sessionId, [...current, item]);
    publish();
  },
  remove(sessionId: string, contextId: string) {
    bySession.set(sessionId, (bySession.get(sessionId) || []).filter((item) => item.reference.contextId !== contextId));
    publish();
  },
  clear(sessionId: string) { if (bySession.delete(sessionId)) publish(); },
};
