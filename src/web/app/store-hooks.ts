import { useCallback, useSyncExternalStore } from 'react';
import type { ExtensionUiState } from '../../public/kernel/stores/extension-ui-store.js';
import type { RuntimeStoreState } from '../../public/kernel/stores/runtime-store.js';
import type { SessionStoreState } from '../../public/kernel/stores/session-store.js';
import { appKernel, reconnectBrowserApplication } from './composition-root';

type ExternalStore<T> = {
  get(): T;
  subscribe(listener: (state: T) => void): () => void;
};

function useStore<T>(store: ExternalStore<T>): T {
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.get(),
    () => store.get(),
  );
}

export function useRuntimeState(): RuntimeStoreState {
  return useStore(appKernel.stores.runtime);
}

export function useSessionState(): SessionStoreState {
  return useStore(appKernel.stores.session);
}

export function useExtensionUiState(): ExtensionUiState {
  return useStore(appKernel.stores.extensionUi);
}

function useSlice<T, S>(store: ExternalStore<T>, selector: (state: T) => S): S {
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  return useSyncExternalStore(subscribe, () => selector(store.get()), () => selector(store.get()));
}

export function useConversation(sessionId: string | null) {
  return useSlice(appKernel.stores.conversation, (state) => sessionId ? state.bySession[sessionId] : undefined);
}
export function useToolExecutions(sessionId: string | null) {
  return useSlice(appKernel.stores.toolExecution, (state) => sessionId ? state.bySession[sessionId] : undefined);
}
export function useSession(sessionId: string) {
  return useSlice(appKernel.stores.session, (state) => state.sessions.find((session) => session.id === sessionId));
}
export function useSessionAttachments(sessionId: string) {
  return useSlice(appKernel.stores.session, (state) => state.attachmentsBySession[sessionId]);
}
export function useSessionCompacting(sessionId: string) {
  return useSlice(appKernel.stores.session, (state) => !!state.compactingBySession[sessionId]);
}
