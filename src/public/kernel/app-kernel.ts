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
import type { SessionSnapshot } from '../app-types.js';

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
  const failedQueuedPrompts = new WeakSet<object>();
  let disposed = false;
  let connectionEpoch = 0;
  let hostGeneration: string | null = null;
  const revisions = new Map<string, number>();
  const snapshotRequests = new Map<string, number>();
  const closedSessions = new Set<string>();
  const recoveryNeeded = new Set<string>();
  type SnapshotOwner = { epoch: number; request: number; events: Array<{ revision: number; action: AppAction }>; bytes: number; overflow: boolean };
  const snapshotOwners = new WeakMap<object, SnapshotOwner>();
  const snapshotJournals = new Map<string, SnapshotOwner>();

  const acceptSnapshot = (id: string, snapshot: SessionSnapshot) => {
    const owner = snapshotOwners.get(snapshot);
    if (disposed || closedSessions.has(id) || (owner && (owner.epoch !== connectionEpoch || owner.request !== snapshotRequests.get(id)))) return false;
    if (snapshot.hostGeneration && hostGeneration && snapshot.hostGeneration !== hostGeneration) return false;
    if (owner?.overflow) { recoveryNeeded.add(id); return false; }
    if (snapshot.revision !== undefined && snapshot.revision < (revisions.get(id) ?? -1) && !owner) return false;
    if (snapshot.revision !== undefined) revisions.set(id, Math.max(revisions.get(id) ?? 0, snapshot.revision));
    return true;
  };
  const trackLifecycle = (action: AppAction) => {
    if (action.type === 'session/closed') closedSessions.add(action.sessionId);
    if (action.type === 'session/created') closedSessions.delete(action.session.id);
    if (action.type === 'session/listReceived') {
      for (const previous of stores.session.get().sessions) if (!action.sessions.some((session) => session.id === previous.id)) closedSessions.add(previous.id);
      for (const session of action.sessions) closedSessions.delete(session.id);
    }
  };

  // Flush prompts that were queued while a session was busy. A prompt is
  // removed only after the Agent Host acknowledges it; failures leave it in
  // the queue for an explicit retry.
  const flushQueuedPrompts = () => {
    const { streamingBySession, compactingBySession } = stores.session.get();
    const { bySession } = stores.conversation.get();
    for (const [sessionId, conv] of Object.entries(bySession)) {
      if (streamingBySession[sessionId] || compactingBySession[sessionId] || conv.live.queued.length === 0 || flushingSessions.has(sessionId) || failedQueuedPrompts.has(conv.live.queued[0])) continue;
      flushingSessions.add(sessionId);
      void (async () => {
        let attempted: object | null = null;
        try {
          while (!stores.session.isStreaming(sessionId) && !stores.session.isCompacting(sessionId)) {
            const queued = stores.conversation.get().bySession[sessionId]?.live.queued[0];
            if (!queued) break;
            attempted = queued;
            await commands.agent.sendPrompt({ sessionId, message: queued.message, attachmentIds: queued.attachmentIds, geoContextIds: queued.geoContextIds, canvasContextIds: queued.canvasContextIds, clientCommandId: queued.clientCommandId });
            apply({ type: 'conversation/queueItemRemoved', sessionId, index: 0 });
          }
        } catch (cause) {
          if (attempted) failedQueuedPrompts.add(attempted);
          apply({ type: 'error/raised', error: toAppError(cause, { code: 'queued_prompt_failed', category: 'transport', sessionId, retryable: true }) });
        } finally {
          flushingSessions.delete(sessionId);
        }
      })();
    }
  };

  const dispatch = (action: AppAction) => {
    trackLifecycle(action);
    if (action.type === 'session/snapshotReceived') {
      recoveryNeeded.delete(action.sessionId);
      if (!acceptSnapshot(action.sessionId, action.snapshot)) return;
      flushBufferedActions();
    }
    apply(action);
    if (action.type === 'session/snapshotReceived') {
      const owner = snapshotOwners.get(action.snapshot);
      for (const event of owner?.events ?? []) {
        if (action.snapshot.revision !== undefined && event.revision > action.snapshot.revision) apply(event.action);
      }
      if (snapshotJournals.get(action.sessionId) === owner) snapshotJournals.delete(action.sessionId);
    }
    flushQueuedPrompts();
  };

  commands = createCommands({
    http: options.http,
    dispatch,
    isStreaming: (sessionId) => stores.session.isStreaming(sessionId),
    isCompacting: (sessionId) => stores.session.isCompacting(sessionId),
  });
  const loadSnapshot = commands.session.loadSnapshot;
  commands.session.loadSnapshot = async (id) => {
    const request = (snapshotRequests.get(id) ?? 0) + 1;
    snapshotRequests.set(id, request);
    const epoch = connectionEpoch;
    const owner: SnapshotOwner = { epoch, request, events: [], bytes: 0, overflow: false };
    snapshotJournals.set(id, owner);
    try {
      const snapshot = await loadSnapshot(id);
      snapshotOwners.set(snapshot, owner);
      return snapshot;
    } catch (error) {
      if (snapshotJournals.get(id) === owner) snapshotJournals.delete(id);
      throw error;
    }
  };

  const refreshActiveSnapshot = () => {
    const id = stores.session.get().activeSessionId;
    if (!id || !stores.session.get().sessions.some((session) => session.id === id)) return;
    void commands.session.loadSnapshot(id).then((snapshot) => dispatch({ type: 'session/snapshotReceived', sessionId: id, snapshot })).catch((cause) => {
      if (!disposed && stores.session.get().activeSessionId === id) apply({ type: 'error/raised', error: toAppError(cause, { code: 'snapshot_recovery_failed', category: 'transport', sessionId: id, retryable: true }) });
    });
  };

  const unsubscribe = transport.subscribe((signal) => {
    if (signal.kind === 'connected' || signal.kind === 'disconnected') connectionEpoch++;
    const raw = signal.kind === 'message' ? signal.message as { type?: string; event?: { type?: string }; hostGeneration?: string; revision?: number; sessionId?: string; session?: { id?: string }; liveSessions?: { id: string }[] } : null;
    if (raw?.hostGeneration) {
      if (raw.type === 'state') {
        if (hostGeneration !== raw.hostGeneration) {
          hostGeneration = raw.hostGeneration;
          revisions.clear();
          snapshotRequests.clear();
          connectionEpoch++;
        }
      } else if (hostGeneration && hostGeneration !== raw.hostGeneration) return;
      const ids = raw.type === 'state' ? (raw.liveSessions ?? []).map((session) => session.id) : [raw.sessionId || raw.session?.id || ''];
      for (const id of ids) {
        if (!id || raw.revision === undefined) continue;
        if (raw.revision < (revisions.get(id) ?? -1)) return;
        revisions.set(id, raw.revision);
      }
    }
    for (const action of normalizer.normalizeSignal(signal)) {
      trackLifecycle(action);
      const id = 'sessionId' in action ? action.sessionId : 'session' in action ? action.session.id : null;
      const journal = id ? snapshotJournals.get(id) : undefined;
      if (journal && raw?.revision !== undefined) {
        journal.bytes += JSON.stringify(action).length;
        if (journal.events.length >= 2000 || journal.bytes > 2 * 1024 * 1024) journal.overflow = true;
        else journal.events.push({ revision: raw.revision, action });
      }
      if (bufferAction(action)) continue;
      flushBufferedActions();
      if (action.type === 'session/snapshotReceived' && !acceptSnapshot(action.sessionId, action.snapshot)) continue;
      apply(action);
    }
    if (raw?.type === 'state') refreshActiveSnapshot();
    if (raw?.event?.type === 'agent_settled' && raw.sessionId && recoveryNeeded.has(raw.sessionId)) refreshActiveSnapshot();
    flushQueuedPrompts();
  });

  return {
    stores,
    commands,
    dispatch,
    dispose() {
      disposed = true;
      unsubscribe();
      if (cancelScheduledFlush) cancelScheduledFlush();
      cancelScheduledFlush = null;
      pendingStreamDeltas.clear();
      pendingToolArguments.clear();
      snapshotJournals.clear();
    },
  };
}
