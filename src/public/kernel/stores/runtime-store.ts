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
  health: import('../../../contracts/host-protocol.js').HostHealth | null;
};

export class RuntimeStore {
  private readonly store: Store<RuntimeStoreState> = createStore<RuntimeStoreState>({ connection: 'disconnected', lastError: null, health: null });

  get(): RuntimeStoreState {
    return this.store.get();
  }

  subscribe(listener: StoreListener<RuntimeStoreState>): () => void {
    return this.store.subscribe(listener);
  }

  connecting() {
    this.store.set((prev) => ({ ...prev, connection: 'connecting' }));
  }
  healthReceived(health: import('../../../contracts/host-protocol.js').HostHealth) { this.store.set((prev) => ({ ...prev, health })); }

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
