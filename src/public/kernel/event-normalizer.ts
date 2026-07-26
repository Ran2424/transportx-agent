/**
 * Event normalizer (migration plan §4.1). Converts raw WebSocket messages
 * ({ type: 'state' | 'event' | 'live_session_*' | ... }) into AppActions.
 * This is the only place where raw message/event type strings are mapped to
 * domain actions. Unknown types, illegal schemaVersion and malformed shapes
 * produce error/raised actions — the stores are never touched silently.
 */

import type { AppEvent, AppMessage, LiveSession, SessionEntry, SessionSnapshot } from '../app-types.js';
import type { AppAction } from './actions.js';
import { appError, type AppError } from '../../contracts/errors.ts';
import type { TransportSignal } from './transport.js';

type RawMessage = { type?: unknown; [key: string]: unknown };

export type EventNormalizer = {
  normalizeSignal(signal: TransportSignal): AppAction[];
  normalizeMessage(message: unknown): AppAction[];
};

export function createEventNormalizer(options: { getActiveSessionId?: () => string | null } = {}): EventNormalizer {
  // Run ids are deterministic per normalizer instance so replaying the same
  // event sequence twice yields identical state.
  const streamSeqBySession = new Map<string, number>();
  const currentRunBySession = new Map<string, string>();

  const protocolError = (code: string, message: string, sessionId?: string, diagnostics?: AppError['diagnostics']): AppAction => ({
    type: 'error/raised',
    error: appError({ code, category: 'protocol', message, sessionId, retryable: false, diagnostics }),
  });

  const resolveSessionId = (sessionId: unknown): string | null => {
    if (typeof sessionId === 'string' && sessionId) return sessionId;
    return options.getActiveSessionId?.() ?? null;
  };

  const nextRunId = (sessionId: string): string => {
    const seq = (streamSeqBySession.get(sessionId) ?? 0) + 1;
    streamSeqBySession.set(sessionId, seq);
    const runId = `${sessionId}:run:${seq}`;
    currentRunBySession.set(sessionId, runId);
    return runId;
  };

  function normalizeRpcEvent(rawSessionId: unknown, event: AppEvent): AppAction[] {
    const eventType = event?.type;
    if (typeof eventType !== 'string') {
      return [protocolError('malformed_event', 'RPC event without a string type')];
    }
    // extension_ui_request may legitimately arrive without a session.
    if (eventType === 'extension_ui_request') {
      const sessionId = typeof rawSessionId === 'string' && rawSessionId ? rawSessionId : null;
      return [{ type: 'extensionUi/requested', sessionId, request: event }];
    }

    const sessionId = resolveSessionId(rawSessionId);
    if (!sessionId) {
      return [protocolError('missing_session_id', `Cannot route event "${eventType}" without a session id`)];
    }
    const runId = () => currentRunBySession.get(sessionId) ?? null;

    switch (eventType) {
      case 'agent_start':
        return [{ type: 'conversation/streamStarted', sessionId, runId: nextRunId(sessionId) }];
      case 'agent_end':
        // agent_end closes one low-level run only. Pi may immediately retry
        // it, compact and retry, or continue queued work; ending the overlay
        // here in that case prematurely flushes prompts and duplicates UI
        // error state. agent_settled below is the authoritative boundary.
        if (event.willRetry === true) return [];
        currentRunBySession.delete(sessionId);
        return [{ type: 'conversation/streamEnded', sessionId }];
      case 'agent_settled':
        // Newer Pi versions emit this after all automatic retries,
        // compaction retries and queued continuations have completed. It is
        // normally preceded by a final agent_end, but also repairs a stream
        // when a client attached after that event.
        if (!currentRunBySession.has(sessionId)) return [];
        currentRunBySession.delete(sessionId);
        return [{ type: 'conversation/streamEnded', sessionId }];
      case 'turn_start':
      case 'turn_end':
        // Streaming state derives from agent_start/agent_end only; turn
        // boundaries carry no store-visible change.
        return [];
      case 'message_start':
        return [{ type: 'conversation/messageStarted', sessionId, runId: runId(), message: event.message as AppMessage }];
      case 'message_update': {
        const deltaType = event.assistantMessageEvent?.type;
        const delta = event.assistantMessageEvent?.delta;
        if (typeof delta !== 'string') return [];
        if (deltaType === 'text_delta') {
          return [{ type: 'conversation/streamDelta', sessionId, runId: runId(), channel: 'text', delta }];
        }
        if (deltaType === 'thinking_delta') {
          return [{ type: 'conversation/streamDelta', sessionId, runId: runId(), channel: 'thinking', delta }];
        }
        return [];
      }
      case 'message_end': {
        const message = event.message as AppMessage;
        const actions: AppAction[] = [{ type: 'conversation/streamCompleted', sessionId, message }];
        // Tool results also arrive as messages; keep the execution map in sync.
        if (message?.toolCallId) {
          actions.push({ type: 'tool/ended', sessionId, toolCallId: message.toolCallId, toolName: message.toolName, result: { content: message.content, details: message.details }, isError: message.isError });
        }
        return actions;
      }
      case 'tool_execution_start':
        return [{
          type: 'tool/started',
          sessionId,
          execution: {
            toolCallId: String(event.toolCallId ?? ''),
            toolName: event.toolName,
            args: event.args,
            status: 'running',
          },
        }];
      case 'tool_execution_update':
        return [{ type: 'tool/updated', sessionId, toolCallId: String(event.toolCallId ?? ''), partialResult: event.partialResult }];
      case 'tool_execution_end':
        return [{
          type: 'tool/ended',
          sessionId,
          toolCallId: String(event.toolCallId ?? ''),
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
        }];
      case 'auto_compaction_start':
      case 'auto_compaction_end':
      case 'auto_retry_start':
      case 'auto_retry_end':
      case 'response':
        // Pi command responses are resolved by the server-side command port.
        // Retry/compaction lifecycle events are status-only notifications.
        // agent_settled remains the authoritative streaming boundary.
        return [];
      case 'entry_appended': {
        const entry = (event as { entry?: SessionEntry }).entry;
        return entry ? [{ type: 'conversation/messageAppended', sessionId, entry }] : [];
      }
      case 'extension_error':
        return [{
          type: 'error/raised',
          error: appError({
            code: 'extension_error',
            category: 'extension',
            message: String(event.error ?? 'Extension error'),
            sessionId,
            retryable: false,
          }),
        }];
      case 'session_name':
        return event.name
          ? [{ type: 'session/updated', session: { id: sessionId, sessionName: event.name } }]
          : [];
      default:
        return [protocolError('unknown_event_type', `Unknown RPC event type "${eventType}"`, sessionId, { eventType })];
    }
  }

  function normalizeMessage(message: unknown): AppAction[] {
    const raw = message as RawMessage | null;
    if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') {
      return [protocolError('malformed_message', 'WebSocket message without a string type')];
    }
    switch (raw.type) {
      case 'state': {
        if (raw.liveSessions !== undefined && !Array.isArray(raw.liveSessions)) {
          return [protocolError('malformed_message', 'state message with non-array liveSessions')];
        }
        return [{ type: 'session/listReceived', sessions: (raw.liveSessions ?? []) as LiveSession[] }];
      }
      case 'event':
        return normalizeRpcEvent(raw.sessionId, (raw.event ?? {}) as AppEvent);
      case 'live_session_created':
        return [{ type: 'session/created', session: raw.session as LiveSession }];
      case 'live_session_updated':
        return [{ type: 'session/updated', session: raw.session as LiveSession }];
      case 'live_session_closed': {
        const sessionId = (raw.sessionId ?? (raw.session as LiveSession | undefined)?.id) as string | undefined;
        return sessionId
          ? [{ type: 'session/closed', sessionId }]
          : [protocolError('malformed_message', 'live_session_closed without a session id')];
      }
      case 'live_session_snapshot': {
        if (raw.schemaVersion !== 1) {
          return [protocolError(
            'unsupported_schema_version',
            `Unsupported SessionSnapshot schemaVersion: ${String(raw.schemaVersion)}`,
            raw.sessionId as string | undefined,
            { schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : String(raw.schemaVersion) },
          )];
        }
        const sessionId = (raw.sessionId ?? (raw.session as LiveSession | undefined)?.id) as string | undefined;
        if (!sessionId) {
          return [protocolError('malformed_message', 'live_session_snapshot without a session id')];
        }
        const { type: _ignored, ...snapshot } = raw;
        return [{ type: 'session/snapshotReceived', sessionId, snapshot: snapshot as unknown as SessionSnapshot }];
      }
      case 'contract_diagnostic': {
        const error = raw.error as AppError | undefined;
        return error?.category === 'protocol'
          ? [{ type: 'error/raised', error }]
          : [protocolError('malformed_contract_diagnostic', 'Server contract diagnostic did not include a protocol AppError', raw.sessionId as string | undefined)];
      }
      case 'error':
        return [{
          type: 'error/raised',
          error: appError({
            code: 'server_error',
            category: 'runtime',
            message: String(raw.message ?? 'Server error'),
            retryable: false,
          }),
        }];
      case 'response':
      case 'session_switch':
        // RPC responses are consumed via HTTP command ports; session_switch
        // has no Browser Kernel state.
        return [];
      default:
        return [protocolError('unknown_message_type', `Unknown WebSocket message type "${raw.type}"`, undefined, { messageType: raw.type })];
    }
  }

  return {
    normalizeMessage,
    normalizeSignal(signal: TransportSignal): AppAction[] {
      if (signal.kind === 'connected') return [{ type: 'runtime/connected' }];
      if (signal.kind === 'disconnected') return [{ type: 'runtime/disconnected', reason: signal.reason }];
      return normalizeMessage(signal.message);
    },
  };
}
