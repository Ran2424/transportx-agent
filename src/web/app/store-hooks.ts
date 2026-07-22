import { useSyncExternalStore } from 'react';
import type { ConversationStoreState } from '../../public/kernel/stores/conversation-store.js';
import type { ExtensionUiState } from '../../public/kernel/stores/extension-ui-store.js';
import type { RuntimeStoreState } from '../../public/kernel/stores/runtime-store.js';
import type { SessionStoreState } from '../../public/kernel/stores/session-store.js';
import type { ToolExecutionStoreState } from '../../public/kernel/stores/tool-execution-store.js';
import { useAppServices } from './AppProviders';

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
  return useStore(useAppServices().kernel.stores.runtime);
}

export function useSessionState(): SessionStoreState {
  return useStore(useAppServices().kernel.stores.session);
}

export function useExtensionUiState(): ExtensionUiState {
  return useStore(useAppServices().kernel.stores.extensionUi);
}

export function useConversationState(): ConversationStoreState {
  return useStore(useAppServices().kernel.stores.conversation);
}

export function useToolExecutionState(): ToolExecutionStoreState {
  return useStore(useAppServices().kernel.stores.toolExecution);
}
