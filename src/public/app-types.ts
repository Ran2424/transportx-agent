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
import type { ResolvedSessionPlanV3 } from '../contracts/resolved-session-plan.js';
export type { SessionAttachment, SessionAttachmentKind, SessionAttachmentSource, SessionAttachmentStatus } from '../contracts/attachments.js';

export type SessionSnapshot = {
  schemaVersion: 1;
  entries: SessionEntry[];
  sessionId?: string;
  sessionFile?: string | null;
  session?: LiveSession;
  isStreaming?: boolean;
  isCompacting?: boolean;
  model?: ModelRecord | null;
  thinkingLevel?: string;
  pendingExtensionUiRequests?: AppEvent[];
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
  isCompacting?: boolean;
  autoCompactionEnabled?: boolean;
  createdAt?: string;
  lastActiveAt?: string;
  lastConversationAt?: string;
  contextUsage?: UsageRecord;
  resolvedSessionPlan?: ResolvedSessionPlanV3;
  capabilities?: RuntimeCapabilities & {
    ok: boolean;
    mismatches: CapabilityMismatchReason[];
    diagnostics?: ContractDiagnostic[];
  };
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
  attachmentIds?: string[];
  toolCallId?: string;
  toolName?: string;
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
  durationMs?: number;
};

export type AppEvent = {
  type?: string;
  sessionId?: string;
  session?: LiveSession;
  message?: AppMessage | string;
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
    contentIndex?: number;
    partial?: AppMessage;
    toolCall?: MessageContentBlock;
  };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  method?: string;
  id?: string;
  name?: string;
  error?: string;
  summary?: string;
  contextUsage?: UsageRecord;
  sessionFile?: string;
  [key: string]: unknown;
};

export type ExtensionUIRequest = { sessionId: string; event: AppEvent };
export type RpcCommand = { type: string; sessionId?: string; filePath?: string; [key: string]: unknown };
