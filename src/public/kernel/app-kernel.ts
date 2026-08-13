/**
 * Composition root of the browser application kernel: binds the transport to
 * normalizer -> dispatcher -> stores, and exposes stores, command ports,
 * dispatch and dispose. DOM-free; transport and HTTP are injected.
 */

import type { AppAction } from './actions.js';
import type { AppEvent } from '../app-types.js';
import { createCommands, type HttpClient, type KernelCommands } from './commands.js';
import { createDispatcher, type KernelStores } from './dispatcher.js';
import { createEventNormalizer } from './event-normalizer.js';
import { ConversationStore } from './stores/conversation-store.js';
import { ExtensionUiStore } from './stores/extension-ui-store.js';
import { RuntimeStore } from './stores/runtime-store.js';
import { SessionStore } from './stores/session-store.js';
import { ToolExecutionStore } from './stores/tool-execution-store.js';
import { eventTargetTransport, type EventTargetTransportSource, type KernelTransport } from './transport.js';
import { toAppError } from '../../contracts/errors.ts';

export type AppKernelOptions = {
  transport: KernelTransport | EventTargetTransportSource;
  http: HttpClient;
};

/**
 * UI-only event tap. Stores hold all application state; presentation-only
 * concerns can subscribe here without adding a second raw-WebSocket listener.
 * They subscribe here instead of adding a second raw-WebSocket listener.
 * Events fire after the corresponding actions have been applied, so stores
 * are already up to date when the listener runs.
 */
export type KernelUiEvent =
  | { kind: 'rpc'; sessionId: string | null; event: AppEvent }
  | { kind: 'state' };

export type AppKernel = {
  stores: KernelStores;
  commands: KernelCommands;
  dispatch(action: AppAction): void;
  onEvent(listener: (event: KernelUiEvent) => void): () => void;
  dispose(): void;
};

function isKernelTransport(transport: AppKernelOptions['transport']): transport is KernelTransport {
  return typeof (transport as KernelTransport).subscribe === 'function';
}

export function createAppKernel(options: AppKernelOptions): AppKernel {
  const transport: KernelTransport = isKernelTransport(options.transport)
    ? options.transport
    : eventTargetTransport(options.transport);

  const stores: KernelStores = {
    runtime: new RuntimeStore(),
    session: new SessionStore(),
    conversation: new ConversationStore(),
    toolExecution: new ToolExecutionStore(),
    extensionUi: new ExtensionUiStore(),
  };
  const apply = createDispatcher(stores);
  const normalizer = createEventNormalizer({ getActiveSessionId: () => stores.session.get().activeSessionId });

  let commands: KernelCommands;
  const flushingSessions = new Set<string>();

  // Flush prompts that were queued while a session was streaming. A prompt is
  // removed only after the Agent Host acknowledges it; failures leave it in
  // the queue for an explicit retry.
  const flushQueuedPrompts = () => {
    const { streamingBySession } = stores.session.get();
    const { bySession } = stores.conversation.get();
    for (const [sessionId, conv] of Object.entries(bySession)) {
      if (streamingBySession[sessionId] || conv.live.queued.length === 0 || flushingSessions.has(sessionId)) continue;
      flushingSessions.add(sessionId);
      void (async () => {
        try {
          while (!stores.session.isStreaming(sessionId)) {
            const queued = stores.conversation.get().bySession[sessionId]?.live.queued[0];
            if (!queued) break;
            await commands.agent.sendPrompt({ sessionId, message: queued.message, attachmentIds: queued.attachmentIds, clientCommandId: queued.clientCommandId });
            apply({ type: 'conversation/queueItemRemoved', sessionId, index: 0 });
          }
        } catch (cause) {
          apply({ type: 'error/raised', error: toAppError(cause, { code: 'queued_prompt_failed', category: 'transport', sessionId, retryable: true }) });
        } finally {
          flushingSessions.delete(sessionId);
        }
      })();
    }
  };

  const dispatch = (action: AppAction) => {
    apply(action);
    flushQueuedPrompts();
  };

  commands = createCommands({
    transport,
    http: options.http,
    dispatch,
    isStreaming: (sessionId) => stores.session.isStreaming(sessionId),
  });

  const uiListeners = new Set<(event: KernelUiEvent) => void>();
  const emitUiEvent = (event: KernelUiEvent) => {
    for (const listener of uiListeners) {
      try {
        listener(event);
      } catch {
        // A throwing UI listener must not break the kernel pipeline.
      }
    }
  };

  const unsubscribe = transport.subscribe((signal) => {
    for (const action of normalizer.normalizeSignal(signal)) apply(action);
    flushQueuedPrompts();
    if (signal.kind !== 'message') return;
    const message = signal.message as { type?: unknown; sessionId?: unknown; event?: AppEvent } | null;
    if (message?.type === 'event' && message.event) {
      // Mirror the normalizer's routing: extension_ui_request may arrive
      // sessionless; everything else falls back to the active session.
      const sessionId = typeof message.sessionId === 'string' && message.sessionId
        ? message.sessionId
        : (message.event.type === 'extension_ui_request' ? null : stores.session.get().activeSessionId);
      emitUiEvent({ kind: 'rpc', sessionId, event: message.event });
    } else if (message?.type === 'state') {
      emitUiEvent({ kind: 'state' });
    }
  });

  return {
    stores,
    commands,
    dispatch,
    onEvent(listener) {
      uiListeners.add(listener);
      return () => {
        uiListeners.delete(listener);
      };
    },
    dispose() {
      unsubscribe();
      uiListeners.clear();
    },
  };
}
