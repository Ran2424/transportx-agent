import { boundedDiagnostics } from '../../contracts/diagnostics.js';
const diagnoseStore = boundedDiagnostics();

/**
 * Minimal external store: a snapshot getter plus subscribe/unsubscribe. Listeners are isolated so a
 * throwing subscriber cannot break state fan-out for the others.
 */

export type StoreListener<T> = (state: T) => void;

export type Store<T> = {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(listener: StoreListener<T>): () => void;
};

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<StoreListener<T>>();

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(state);
      } catch {
        diagnoseStore('store_listener_failed');
      }
    }
  };

  return {
    get: () => state,
    set(next) {
      state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      try {
        listener(state);
      } catch {
        diagnoseStore('store_initial_listener_failed');
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
