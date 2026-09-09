import { GEO_CONTEXTS_PER_MESSAGE, type GeoContextReferenceV1 } from '../../../contracts/geo.js';
import { createStore } from '../../../public/kernel/store.js';

type GeoContextState = Record<string, GeoContextReferenceV1[]>;
const store = createStore<GeoContextState>({});
const EMPTY: GeoContextReferenceV1[] = [];

export const geoContextStore = {
  subscribe(listener: () => void) { return store.subscribe(listener); },
  get(sessionId: string) { return store.get()[sessionId] || EMPTY; },
  attach(sessionId: string, reference: GeoContextReferenceV1) {
    const current = store.get()[sessionId] || EMPTY;
    if (current.some((item) => item.contextId === reference.contextId)) return;
    if (current.length >= GEO_CONTEXTS_PER_MESSAGE) throw new Error(`一条消息最多附加 ${GEO_CONTEXTS_PER_MESSAGE} 个地图上下文。`);
    store.set((state) => ({ ...state, [sessionId]: [...current, reference] }));
  },
  remove(sessionId: string, contextId: string) {
    const current = store.get()[sessionId] || EMPTY;
    const next = current.filter((item) => item.contextId !== contextId);
    store.set(({ [sessionId]: _removed, ...rest }) => next.length ? { ...rest, [sessionId]: next } : rest);
  },
  clear(sessionId: string) {
    if (!store.get()[sessionId]) return;
    store.set(({ [sessionId]: _removed, ...rest }) => rest);
  },
};
