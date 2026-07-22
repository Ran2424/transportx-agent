/**
 * Dispatcher: the single entry point that applies AppActions to the stores.
 * Cross-store coordination (e.g. closing a session also drops its
 * conversation/tool/extension-UI state) lives here and nowhere else.
 */

import type { AppAction } from './actions.js';
import type { ConversationStore } from './stores/conversation-store.js';
import type { ExtensionUiStore } from './stores/extension-ui-store.js';
import type { RuntimeStore } from './stores/runtime-store.js';
import type { SessionStore } from './stores/session-store.js';
import type { ToolExecutionStore } from './stores/tool-execution-store.js';

export type KernelStores = {
  runtime: RuntimeStore;
  session: SessionStore;
  conversation: ConversationStore;
  toolExecution: ToolExecutionStore;
  extensionUi: ExtensionUiStore;
};

export type Dispatch = (action: AppAction) => void;

export function createDispatcher(stores: KernelStores): Dispatch {
  return function dispatch(action: AppAction): void {
    switch (action.type) {
      case 'runtime/connecting':
        stores.runtime.connecting();
        break;
      case 'runtime/connected':
        stores.runtime.connected();
        break;
      case 'runtime/disconnected':
        stores.runtime.disconnected();
        break;

      case 'session/listReceived':
        stores.session.listReceived(action.sessions);
        break;
      case 'session/created':
      case 'session/updated':
        stores.session.upsert(action.session);
        break;
      case 'session/closed':
        stores.session.closed(action.sessionId);
        stores.conversation.dropSession(action.sessionId);
        stores.toolExecution.dropSession(action.sessionId);
        stores.extensionUi.dropSession(action.sessionId);
        break;
      case 'session/activated':
        stores.session.activated(action.sessionId);
        stores.extensionUi.activated(action.sessionId);
        break;
      case 'session/snapshotReceived':
        stores.session.applySnapshot(action.sessionId, action.snapshot);
        stores.conversation.hydrate(action.sessionId, action.snapshot);
        break;

      case 'conversation/streamStarted':
        stores.conversation.streamStarted(action.sessionId, action.runId);
        stores.session.setStreaming(action.sessionId, true);
        break;
      case 'conversation/messageStarted':
        stores.conversation.messageStarted(action.sessionId, action.message);
        break;
      case 'conversation/streamDelta':
        stores.conversation.streamDelta(action.sessionId, action.channel, action.delta);
        break;
      case 'conversation/streamCompleted':
        stores.conversation.streamCompleted(action.sessionId, action.message);
        break;
      case 'conversation/streamEnded':
        stores.conversation.streamEnded(action.sessionId);
        stores.session.setStreaming(action.sessionId, false);
        break;
      case 'conversation/messageAppended':
        stores.conversation.appendEntry(action.sessionId, action.entry);
        break;
      case 'conversation/promptSent':
        stores.conversation.promptSent(action.sessionId, { message: action.message, images: action.images });
        break;
      case 'conversation/promptQueued':
        stores.conversation.promptQueued(action.sessionId, { message: action.message, images: action.images });
        break;
      case 'conversation/queueItemRemoved':
        stores.conversation.removeQueued(action.sessionId, action.index);
        break;
      case 'conversation/queueDrained':
        stores.conversation.queueDrained(action.sessionId);
        break;

      case 'tool/started':
        stores.toolExecution.started(action.sessionId, action.execution);
        break;
      case 'tool/updated':
        stores.toolExecution.updated(action.sessionId, action.toolCallId, action.partialResult);
        break;
      case 'tool/ended':
        stores.toolExecution.ended(action.sessionId, action.toolCallId, action);
        break;

      case 'extensionUi/requested':
        stores.extensionUi.requested(action.sessionId, action.request, stores.session.get().activeSessionId);
        break;
      case 'extensionUi/resolved':
        stores.extensionUi.resolved(action.requestId, stores.session.get().activeSessionId);
        break;

      case 'error/raised':
        stores.runtime.raiseError(action.error);
        break;
    }
  };
}
