/**
 * Runtime store: transport connection state plus the last raised AppError.
 * Low-frequency updates; components read this for status indicators.
 */

import type { AppError } from '../../../contracts/errors.ts';
import { createStore, type Store, type StoreListener } from '../store.js';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export type RuntimeStoreState = {
  connection: ConnectionState;
  lastError: AppError | null;
};

export class RuntimeStore {
  private readonly store: Store<RuntimeStoreState> = createStore<RuntimeStoreState>({ connection: 'disconnected', lastError: null });

  get(): RuntimeStoreState {
    return this.store.get();
  }

  subscribe(listener: StoreListener<RuntimeStoreState>): () => void {
    return this.store.subscribe(listener);
  }

  connecting() {
    this.store.set((prev) => ({ ...prev, connection: 'connecting' }));
  }

  connected() {
    this.store.set((prev) => ({ ...prev, connection: 'connected' }));
  }

  disconnected() {
    this.store.set((prev) => ({ ...prev, connection: 'disconnected' }));
  }

  raiseError(error: AppError) {
    this.store.set((prev) => ({ ...prev, lastError: error }));
  }
}
