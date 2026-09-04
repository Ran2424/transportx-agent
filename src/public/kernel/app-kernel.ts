/**
 * Composition root of the browser application kernel: binds the transport to
 * normalizer -> dispatcher -> stores, and exposes stores, command ports,
 * dispatch and dispose. DOM-free; transport and HTTP are injected.
 */

import type { AppAction } from './actions.js';
import { createCommands, type HttpClient, type KernelCommands } from './commands.js';
import { createDispatcher, type KernelStores } from './dispatcher.js';
import { createEventNormalizer } from './event-normalizer.js';
import { ConversationStore } from './stores/conversation-store.js';
import { ExtensionUiStore } from './stores/extension-ui-store.js';
import { RuntimeStore } from './stores/runtime-store.js';
import { SessionStore } from './stores/session-store.js';
import { ToolExecutionStore } from './stores/tool-execution-store.js';
import type { KernelTransport } from './transport.js';
import { toAppError } from '../../contracts/errors.ts';

export type AppKernelOptions = {
  transport: KernelTransport;
  http: HttpClient;
};

export type AppKernel = {
  stores: KernelStores;
  commands: KernelCommands;
  dispatch(action: AppAction): void;
  dispose(): void;
};

export function createAppKernel(options: AppKernelOptions): AppKernel {
  const transport = options.transport;

  const stores: KernelStores = {
    runtime: new RuntimeStore(),
    session: new SessionStore(),
    conversation: new ConversationStore(),
    toolExecution: new ToolExecutionStore(),
    extensionUi: new ExtensionUiStore(),
  };
  const apply = createDispatcher(stores);
  const normalizer = createEventNormalizer({ getActiveSessionId: () => stores.session.get().activeSessionId });
  const pendingStreamDeltas = new Map<string, Array<Extract<AppAction, { type: 'conversation/streamDelta' }>>>();
  const pendingToolArguments = new Map<string, Extract<AppAction, { type: 'tool/argumentsUpdated' }>>();
  let cancelScheduledFlush: (() => void) | null = null;

  const flushBufferedActions = () => {
    if (cancelScheduledFlush) cancelScheduledFlush();
    cancelScheduledFlush = null;
    for (const segments of pendingStreamDeltas.values()) {
      for (const action of segments) apply(action);
    }
    pendingStreamDeltas.clear();
    for (const action of pendingToolArguments.values()) apply(action);
    pendingToolArguments.clear();
  };

  const scheduleBufferedFlush = () => {
    if (cancelScheduledFlush) return;
    if (typeof globalThis.requestAnimationFrame === 'function') {
      const frame = globalThis.requestAnimationFrame(() => {
        cancelScheduledFlush = null;
        flushBufferedActions();
      });
      cancelScheduledFlush = () => globalThis.cancelAnimationFrame(frame);
      return;
    }
    const timer = setTimeout(() => {
      cancelScheduledFlush = null;
      flushBufferedActions();
    }, 16);
    cancelScheduledFlush = () => clearTimeout(timer);
  };

  const bufferAction = (action: AppAction) => {
    if (action.type === 'conversation/streamDelta') {
      const segments = pendingStreamDeltas.get(action.sessionId) ?? [];
      const previous = segments.at(-1);
      if (previous?.channel === action.channel) previous.delta += action.delta;
      else segments.push({ ...action });
      pendingStreamDeltas.set(action.sessionId, segments);
      scheduleBufferedFlush();
      return true;
    }
    if (action.type === 'tool/argumentsUpdated') {
      const key = `${action.sessionId}:${action.toolCallId}`;
      const previous = pendingToolArguments.get(key);
      pendingToolArguments.set(key, previous ? {
        ...action,
        toolName: action.toolName ?? previous.toolName,
        args: action.args ?? previous.args,
        argumentChars: previous.argumentChars + action.argumentChars,
      } : action);
      scheduleBufferedFlush();
      return true;
    }
    return false;
  };

  let commands: KernelCommands;
  const flushingSessions = new Set<string>();

  // Flush prompts that were queued while a session was busy. A prompt is
  // removed only after the Agent Host acknowledges it; failures leave it in
  // the queue for an explicit retry.
  const flushQueuedPrompts = () => {
    const { streamingBySession, compactingBySession } = stores.session.get();
    const { bySession } = stores.conversation.get();
    for (const [sessionId, conv] of Object.entries(bySession)) {
      if (streamingBySession[sessionId] || compactingBySession[sessionId] || conv.live.queued.length === 0 || flushingSessions.has(sessionId)) continue;
      flushingSessions.add(sessionId);
      void (async () => {
        try {
          while (!stores.session.isStreaming(sessionId) && !stores.session.isCompacting(sessionId)) {
            const queued = stores.conversation.get().bySession[sessionId]?.live.queued[0];
            if (!queued) break;
            await commands.agent.sendPrompt({ sessionId, message: queued.message, attachmentIds: queued.attachmentIds, geoContextIds: queued.geoContextIds, clientCommandId: queued.clientCommandId });
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
    isCompacting: (sessionId) => stores.session.isCompacting(sessionId),
  });

  const unsubscribe = transport.subscribe((signal) => {
    for (const action of normalizer.normalizeSignal(signal)) {
      if (bufferAction(action)) continue;
      flushBufferedActions();
      apply(action);
    }
    flushQueuedPrompts();
  });

  return {
    stores,
    commands,
    dispatch,
    dispose() {
      unsubscribe();
      if (cancelScheduledFlush) cancelScheduledFlush();
      cancelScheduledFlush = null;
      pendingStreamDeltas.clear();
      pendingToolArguments.clear();
    },
  };
}
