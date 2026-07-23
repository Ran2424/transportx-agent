/**
 * Browser-internal type bundle. The contract authority for `AppError`,
 * `ModelIdentity`, task-mode/geo/bridge wire types and the SessionSnapshot
 * *core* (schemaVersion + entries) is `src/contracts/`. This module keeps the
 * Browser-internal extensions (live session metadata, MessageContentBlock
 * union, Browser-targeted message shape).
 *
 * The pure protocol `SessionSnapshot` is importable from `../contracts/index.js`
 * when only the wire shape is needed.
 */
import type { ContractDiagnostic } from '../contracts/diagnostic.js';
import type { CapabilityMismatchReason, RuntimeCapabilities } from '../contracts/capabilities.js';

export type SessionSnapshot = {
  schemaVersion: 1;
  entries: SessionEntry[];
  sessionId?: string;
  sessionFile?: string | null;
  session?: LiveSession;
  isStreaming?: boolean;
  model?: ModelRecord | null;
  thinkingLevel?: string;
};

export type SessionEntry = {
  id?: string;
  parentId?: string;
  type?: string;
  message?: AppMessage;
  customType?: string;
  data?: unknown;
  diagnostics?: ContractDiagnostic[];
  [key: string]: unknown;
};

export type ModelRecord = {
  provider?: string;
  id?: string;
  name?: string;
  model?: string;
  label?: string;
  context?: string | number;
  contextWindow?: string | number;
  context_window?: string | number;
  maxOutput?: string | number;
  max_output?: string | number;
  maxOut?: string | number;
  thinking?: boolean | string;
  images?: boolean | string;
  [key: string]: unknown;
};

export type LiveSession = {
  id: string;
  cwd?: string;
  sessionFile?: string | null;
  sessionName?: string | null;
  modelSpec?: string;
  modelLabel?: string;
  model?: ModelRecord | string | null;
  thinkingLevel?: string;
  isStreaming?: boolean;
  createdAt?: string;
  lastActiveAt?: string;
  lastConversationAt?: string;
  contextUsage?: UsageRecord;
  capabilities?: RuntimeCapabilities & {
    ok: boolean;
    mismatches: CapabilityMismatchReason[];
    diagnostics?: ContractDiagnostic[];
  };
};

export type LiveInstance = {
  sessionFile?: string | null;
  cwd?: string;
  port: string;
};

export type UsageRecord = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
  [key: string]: unknown;
};

export type MessageContentBlock = {
  type?: string;
  text?: string;
  thinking?: string;
  source?: { data?: string; media_type?: string };
  data?: string;
  media_type?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  durationMs?: number;
};

export type AppMessage = {
  id?: string;
  role?: string;
  content?: string | MessageContentBlock[];
  usage?: UsageRecord;
  images?: PendingImage[];
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
};

export type AppEvent = {
  type?: string;
  sessionId?: string;
  session?: LiveSession;
  message?: AppMessage | string;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  method?: string;
  id?: string;
  name?: string;
  error?: string;
  summary?: string;
  contextUsage?: UsageRecord;
  sessionFile?: string;
  [key: string]: unknown;
};

export type PendingImage = { data: string; mimeType: string };
export type PendingFilePath = { path: string; name: string; ext: string; sessionId?: string | null };
export type QueuedCommand = { type: string; message?: string; images?: PendingImage[]; sessionId?: string };
export type ExtensionUIRequest = { sessionId: string; event: AppEvent };
export type RpcCommand = { type: string; sessionId?: string; filePath?: string; [key: string]: unknown };

/**
 * The Server still emits the pure wire format
 * (`{schemaVersion: 1, entries: SessionEntry[]}`) when callers hit
 * `/api/sessions/{file}/entries`. Map it into the Browser-internal shape.
 */
export function asBrowserSessionSnapshot(snapshot: {
  schemaVersion: 1;
  entries: SessionEntry[];
}): SessionSnapshot {
  return { ...snapshot };
}
