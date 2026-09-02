/**
 * Normalized application actions (migration plan §4.1). Raw WebSocket
 * messages are converted into these by event-normalizer.ts — the raw type →
 * action mapping exists only there. Snapshot hydration reuses the same
 * domain actions as live events.
 */

import type {
  AppEvent,
  AppMessage,
  LiveSession,
  SessionAttachment,
  SessionEntry,
  SessionSnapshot,
} from '../app-types.js';
import type { AppError } from '../../contracts/errors.ts';
import type { GeoInteractionRequestV1, GeoInteractionResponseV1 } from '../../contracts/geo.ts';

export type ToolExecution = {
  toolCallId: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  argumentChars?: number;
  status: 'preparing' | 'running' | 'completed' | 'error';
};

export type StreamChannel = 'text' | 'thinking';

export type AppAction =
  // runtime
  | { type: 'runtime/connecting' }
  | { type: 'runtime/connected' }
  | { type: 'runtime/disconnected'; reason?: string }
  // session
  | { type: 'session/listReceived'; sessions: LiveSession[] }
  | { type: 'session/created'; session: LiveSession }
  | { type: 'session/updated'; session: LiveSession }
  | { type: 'session/closed'; sessionId: string }
  | { type: 'session/activated'; sessionId: string | null }
  | { type: 'session/snapshotReceived'; sessionId: string; snapshot: SessionSnapshot }
  | { type: 'session/attachmentsReceived'; sessionId: string; attachments: SessionAttachment[] }
  | { type: 'session/attachmentAdded'; sessionId: string; attachment: SessionAttachment }
  | { type: 'session/attachmentRemoved'; sessionId: string; attachmentId: string }
  | { type: 'session/compactionStarted'; sessionId: string }
  | { type: 'session/compactionEnded'; sessionId: string }
  | { type: 'session/geoInteractionUpdated'; sessionId: string; request?: GeoInteractionRequestV1; response?: GeoInteractionResponseV1 }
  // conversation
  | { type: 'conversation/streamStarted'; sessionId: string; runId: string }
  | { type: 'conversation/messageStarted'; sessionId: string; runId: string | null; message: AppMessage }
  | { type: 'conversation/streamDelta'; sessionId: string; runId: string | null; channel: StreamChannel; delta: string }
  | { type: 'conversation/streamCompleted'; sessionId: string; message: AppMessage }
  | { type: 'conversation/streamEnded'; sessionId: string }
  | { type: 'conversation/messageAppended'; sessionId: string; entry: SessionEntry }
  | { type: 'conversation/promptSent'; sessionId: string; message: string; attachmentIds?: string[]; geoContextIds?: string[] }
  | { type: 'conversation/promptQueued'; sessionId: string; message: string; attachmentIds?: string[]; geoContextIds?: string[]; clientCommandId: string }
  | { type: 'conversation/queueItemRemoved'; sessionId: string; index: number }
  | { type: 'conversation/queueDrained'; sessionId: string }
  // tool execution
  | { type: 'tool/preparing'; sessionId: string; execution: ToolExecution }
  | { type: 'tool/argumentsUpdated'; sessionId: string; toolCallId: string; toolName?: string; args?: Record<string, unknown>; argumentChars: number }
  | { type: 'tool/started'; sessionId: string; execution: ToolExecution }
  | { type: 'tool/updated'; sessionId: string; toolCallId: string; partialResult: unknown }
  | { type: 'tool/ended'; sessionId: string; toolCallId: string; toolName?: string; result?: unknown; isError?: boolean; startedAt?: number; endedAt?: number; durationMs?: number }
  // extension UI
  | { type: 'extensionUi/requested'; sessionId: string | null; request: AppEvent }
  | { type: 'extensionUi/resolved'; sessionId: string | null; requestId?: string }
  // errors
  | { type: 'error/raised'; error: AppError };
