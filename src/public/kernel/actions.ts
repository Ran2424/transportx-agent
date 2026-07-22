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
  PendingImage,
  SessionEntry,
  SessionSnapshot,
} from '../app-types.js';
import type { AppError } from '../../contracts/errors.ts';

export type ToolExecution = {
  toolCallId: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  status: 'running' | 'completed' | 'error';
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
  // conversation
  | { type: 'conversation/streamStarted'; sessionId: string; runId: string }
  | { type: 'conversation/messageStarted'; sessionId: string; runId: string | null; message: AppMessage }
  | { type: 'conversation/streamDelta'; sessionId: string; runId: string | null; channel: StreamChannel; delta: string }
  | { type: 'conversation/streamCompleted'; sessionId: string; message: AppMessage }
  | { type: 'conversation/streamEnded'; sessionId: string }
  | { type: 'conversation/messageAppended'; sessionId: string; entry: SessionEntry }
  | { type: 'conversation/promptSent'; sessionId: string; message: string; images?: PendingImage[] }
  | { type: 'conversation/promptQueued'; sessionId: string; message: string; images?: PendingImage[] }
  | { type: 'conversation/queueItemRemoved'; sessionId: string; index: number }
  | { type: 'conversation/queueDrained'; sessionId: string }
  // tool execution
  | { type: 'tool/started'; sessionId: string; execution: ToolExecution }
  | { type: 'tool/updated'; sessionId: string; toolCallId: string; partialResult: unknown }
  | { type: 'tool/ended'; sessionId: string; toolCallId: string; toolName?: string; result?: unknown; isError?: boolean }
  // extension UI
  | { type: 'extensionUi/requested'; sessionId: string | null; request: AppEvent }
  | { type: 'extensionUi/resolved'; sessionId: string | null; requestId?: string }
  // errors
  | { type: 'error/raised'; error: AppError };
