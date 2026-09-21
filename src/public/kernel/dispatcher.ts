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

      case 'session/listReceived': {
        // ===== 原实现（保留）=====
        stores.session.listReceived(action.sessions);
        // ===== 修复 BEGIN：第二条消息卡死 =====
        // 原实现见 fix-backup/dispatcher.ts.orig。
        // 问题：conversation overlay 的 live.active 只由 agent_settled 复位，
        // 该事件一旦丢失，输入框永远停留在 steer 模式，后续消息被静默吞掉。
        // 修复：服务端权威状态（全量列表/轮询）说会话不在流式时，同步关闭卡住的 overlay。
        for (const session of action.sessions) {
          if (session.id && session.isStreaming === false) {
            const conv = stores.conversation.get().bySession[session.id];
            if (conv?.live.active) stores.conversation.streamEnded(session.id);
          }
        }
        // ===== 修复 END =====
        break;
      }
      case 'session/created':
      case 'session/updated': {
        // ===== 原实现（保留）=====
        stores.session.upsert(action.session);
        // ===== 修复 BEGIN：第二条消息卡死 =====
        // 同上：live_session_updated 广播把 isStreaming 纠正为 false 时，
        // 同步复位 overlay（isStreaming 为 undefined 表示未携带该字段，不动）。
        if (action.session.id && action.session.isStreaming === false) {
          const conv = stores.conversation.get().bySession[action.session.id];
          if (conv?.live.active) stores.conversation.streamEnded(action.session.id);
        }
        // ===== 修复 END =====
        break;
      }
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
        for (const request of action.snapshot.pendingExtensionUiRequests || []) {
          stores.extensionUi.requested(action.sessionId, request, stores.session.get().activeSessionId);
        }
        break;
      case 'session/attachmentsReceived':
        stores.session.setAttachments(action.sessionId, action.attachments);
        break;
      case 'session/attachmentAdded':
        stores.session.addAttachment(action.sessionId, action.attachment);
        break;
      case 'session/attachmentRemoved':
        stores.session.removeAttachment(action.sessionId, action.attachmentId);
        break;
      case 'session/compactionStarted':
        stores.session.setCompacting(action.sessionId, true);
        break;
      case 'session/compactionEnded':
        stores.session.setCompacting(action.sessionId, false);
        break;
      case 'session/geoInteractionUpdated':
        stores.session.geoInteractionUpdated(action.sessionId, action.request, action.response);
        break;
      case 'session/geoScreenshotUpdated':
        stores.session.geoScreenshotUpdated(action.sessionId, action.request, action.requestId);
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
        stores.conversation.promptSent(action.sessionId, { message: action.message, attachmentIds: action.attachmentIds, geoContextIds: action.geoContextIds });
        break;
      case 'conversation/promptQueued':
        stores.conversation.promptQueued(action.sessionId, { message: action.message, attachmentIds: action.attachmentIds, geoContextIds: action.geoContextIds, clientCommandId: action.clientCommandId });
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
      case 'tool/preparing':
        stores.toolExecution.preparing(action.sessionId, action.execution);
        break;
      case 'tool/argumentsUpdated':
        stores.toolExecution.argumentsUpdated(action.sessionId, action.toolCallId, action);
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
