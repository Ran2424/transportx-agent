import fs from 'node:fs';
import { isPiExtensionDialogRequest, parsePiMessageQueue, type PiMessageQueue } from '../contracts/pi-rpc.js';
import { PI_WEB_BRIDGE_ENTRY } from '../contracts/index.js';
import { retryState, classifyFailure, messageOutcome, type RunOutcome, type RetryState } from '../contracts/run-feedback.js';
import { getVisualizationFromToolResult } from '../contracts/geo.js';
import { stripGeoContextPrompt } from '../contracts/geo-interaction.js';
import { stripAttachmentContext } from '../contracts/attachments.js';
import { stripCanvasContextPrompt } from '../contracts/canvas.js';
import { geoInteractionService, type GeoInteractionSession } from './geo-interaction-service.js';
import { rememberPublishedGeoResource } from './geo-resource-access.js';
import { logHostError, logHostEvent } from './diagnostic-log.js';
import { contextUsageAfterCompaction } from './session-context-usage.js';
import { readAttachmentMessageRefs, recordAttachmentMessageRefs } from './session-attachments.js';
import { readSessionFileEntries, type SessionProjection } from './session-projection.js';
import { restoreCanvasContextMessage } from './canvas-service.js';
import type { CapabilityUpdate, SessionCapabilityTracker } from './session-capability-tracker.js';
import type { JsonRecord, ModelIdentity, RpcCommand } from './types.js';
import type { SessionEventTiming } from './session-event-timing.js';
import type { TimingMetricsStore } from './timing-metrics.js';

type PiMessageContent = string | Array<{ type: string; text?: string; [key: string]: unknown }>;
type PiMessage = { role?: string; content?: PiMessageContent; usage?: JsonRecord; model?: string; timestamp?: unknown; attachmentIds?: string[]; [key: string]: unknown };
export type PiRpcPayload = {
  command?: string;
  id?: string;
  provider?: string;
  model?: unknown;
  thinkingLevel?: string;
  level?: string;
  sessionFile?: string;
  sessionName?: string;
  name?: string;
  contextUsage?: JsonRecord;
  tokens?: JsonRecord;
  [key: string]: unknown;
};
export type PiRpcMessage = PiRpcPayload & {
  type?: string;
  success?: boolean;
  data?: PiRpcPayload;
  result?: PiRpcPayload;
  message?: PiMessage;
  assistantMessageEvent?: { type?: string; delta?: string; contentIndex?: number; partial?: PiMessage; toolCall?: { type: string; id?: unknown; name?: unknown } };
};

function isoTimestamp(value: unknown) {
  const date = typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function conversationTimestamp(entry: JsonRecord) {
  const message = entry.message as { role?: unknown; timestamp?: unknown } | undefined;
  if (message?.role !== 'user' && message?.role !== 'assistant') return null;
  return isoTimestamp(message.timestamp) || isoTimestamp(entry.timestamp);
}

export function latestConversationTimestamp(entries: JsonRecord[]) {
  let latest: string | null = null;
  for (const entry of entries) {
    const timestamp = conversationTimestamp(entry);
    if (timestamp && (!latest || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

type SessionEventSource = GeoInteractionSession & {
  workspaceId: string | null;
  manager: {
    broadcast(data: unknown): void;
    broadcastUpdated(id: string): void;
    broadcastCapabilityDiagnostic(id: string, mismatches: Extract<CapabilityUpdate, { kind: 'accepted' }>['mismatches']): void;
    broadcastContractDiagnostic(id: string, diagnostics: Extract<CapabilityUpdate, { kind: 'invalid' }>['diagnostics']): void;
  };
  model: ModelIdentity | null;
  modelSync: { consume(event: JsonRecord): boolean };
  thinkingLevel: string;
  contextUsage: JsonRecord | null;
  isStreaming: boolean;
  isCompacting: boolean;
  piQueue: PiMessageQueue;
  sessionFile: string | null;
  sessionName: string | null;
  pendingSessionNamePersistence: string | null;
  titleSet: boolean;
  pendingExtensionUiRequests: Map<string, PiRpcMessage>;
  projection: SessionProjection;
  capabilityTracker: SessionCapabilityTracker;
  timingMetrics: TimingMetricsStore;
  eventTiming: SessionEventTiming;
  lastConversationAt: string;
  userMessages: string[];
  pendingMessages: Array<{ text: string; attachmentIds: string[]; geoContextIds: string[]; canvasContextIds: string[] }>;
  activeCanvasContextIds: string[];
  acceptSessionFile(file: string): boolean;
  send(command: RpcCommand, options: { timeoutMs: number }): Promise<unknown>;
  persistPendingSessionName(): void;
  setSessionName(name: unknown): boolean;
  maybeTitle(): void;
  touch(broadcast: boolean): void;
};

export class SessionEvents {
  constructor(private readonly session: SessionEventSource, private readonly sync: () => Promise<unknown> | undefined) {}
  private retry: RetryState | null = null;
  private runOutcome: RunOutcome | null = null;
  private streamingMessage: PiMessage | null = null;
  private activeTools = new Map<string, PiRpcMessage>();

  snapshot() {
    return { streamingMessage: this.streamingMessage, retry: this.retry, outcome: this.runOutcome, activeToolEvents: [...this.activeTools.values()] };
  }

  handleEvent(event: PiRpcMessage) {
    if (this.session.modelSync.consume(event)) return;
    this.session.touch(false);
    const type = event.type;
    if (this.session.workspaceId && type === 'session_info_changed') event = { ...event, name: this.session.sessionName || undefined };
    if (type === 'queue_update') {
      const queue = parsePiMessageQueue(event);
      if (queue) {
        this.session.piQueue = {
          steering: queue.steering.map((text) => this.messageText({ content: text })),
          followUp: queue.followUp.map((text) => this.messageText({ content: text })),
        };
        event = { ...event, ...this.session.piQueue };
      }
    }
    if (type === 'session_tree' || type === 'session_switch') this.session.capabilityTracker.invalidateObservation();
    const now = Date.now();
    if (type === 'thinking_level_changed') {
      const level = typeof event.thinkingLevel === 'string' ? event.thinkingLevel : typeof event.level === 'string' ? event.level : '';
      if (level) {
        this.session.thinkingLevel = level;
        this.session.touch(true);
      }
    }
    this.session.eventTiming.apply(event, now);
    if (type === 'agent_start' || type === 'auto_retry_start') this.runOutcome = null;
    if (type === 'message_end' && event.message?.role === 'assistant') this.runOutcome = messageOutcome(event.message);
    if (type === 'auto_retry_start') this.retry = retryState(event);
    if (type === 'auto_retry_end') this.runOutcome = event.success ? null : /cancelled/i.test(String(event.finalError)) ? { status: 'cancelled' } : { status: 'failed', reason: classifyFailure(event.finalError) };
    if (((type === 'message_end' && event.message?.role === 'assistant') || type === 'auto_retry_end') && this.runOutcome?.status === 'failed') {
      const message = type === 'auto_retry_end' ? event.finalError : event.message?.errorMessage;
      logHostEvent('error', 'pi_run_failed', { sessionId: this.session.id, reason: this.runOutcome.reason, message: typeof message === 'string' ? message : undefined });
    }
    if (type === 'auto_retry_end' || type === 'agent_settled') this.retry = null;
    if (type === 'message_start' && event.message?.role === 'assistant') this.streamingMessage = event.message;
    if (type === 'message_update') {
      const update = event.assistantMessageEvent;
      const partial = event.message || update?.partial;
      if (partial?.role === 'assistant') this.streamingMessage = partial;
      if (update?.type?.startsWith('toolcall_')) {
        const block = update.toolCall ?? (Array.isArray(partial?.content) ? partial.content[update.contentIndex ?? -1] : undefined);
        if (block?.type === 'toolCall' && typeof block.id === 'string' && !this.activeTools.has(block.id)) {
          this.activeTools.set(block.id, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', toolCall: { type: 'toolCall', id: block.id, name: block.name } } });
        }
      }
    }
    if (type === 'message_end' && event.message?.role === 'assistant') this.streamingMessage = null;
    rememberPublishedGeoResource(this.session, event);
    if (typeof event.toolCallId === 'string') {
      if (type === 'tool_execution_start') this.activeTools.set(event.toolCallId, event);
      if (type === 'tool_execution_update') {
        const previous = this.activeTools.get(event.toolCallId);
        this.activeTools.set(event.toolCallId, { ...previous, ...event, type: 'tool_execution_start' });
      }
      if (type === 'tool_execution_end') this.activeTools.delete(event.toolCallId);
    }
    if (isPiExtensionDialogRequest(event) && typeof event.id === 'string' && event.id) this.session.pendingExtensionUiRequests.set(event.id, event);
    if (type === 'agent_start' || type === 'turn_start') this.session.isStreaming = true;
    if (type === 'compaction_start' || type === 'auto_compaction_start') this.session.isCompacting = true;
    if (type === 'compaction_end' || type === 'auto_compaction_end') {
      this.session.isCompacting = false;
      const result = event.result && typeof event.result === 'object' ? event.result as JsonRecord : null;
      this.session.contextUsage = contextUsageAfterCompaction(this.session.contextUsage, this.session.model?.contextWindow, result?.estimatedTokensAfter);
      this.reconcileProjection();
    }
    if (type === 'agent_settled') {
      void this.sync()?.catch((error) => logHostError('session_sync_failed', error, { sessionId: this.session.id }));
      this.session.isStreaming = false;
      this.streamingMessage = null;
      this.activeTools.clear();
      this.session.pendingExtensionUiRequests.clear();
      // Pi has flushed by the time a run settles; retry the pending name write.
      this.session.persistPendingSessionName();
      this.session.send({ type: 'get_session_stats' }, { timeoutMs: 5000 }).catch(() => {});
    }
    if (event.contextUsage) this.session.contextUsage = event.contextUsage;
    if (event.sessionFile) {
      if (!this.session.acceptSessionFile(event.sessionFile)) return;
      this.session.sessionFile = event.sessionFile;
      this.session.persistPendingSessionName();
    }
    if (type === 'session_info_changed' && !this.session.workspaceId) {
      this.session.sessionName = typeof event.name === 'string' ? event.name.trim() || null : null;
      this.session.titleSet = !!this.session.sessionName;
      this.session.pendingSessionNamePersistence = null;
    }
    if (type === 'session_name' && event.name) {
      if (!this.session.workspaceId && !this.session.setSessionName(event.name)) return;
      event.name = this.session.sessionName || event.name;
    }

    if ((type === 'message_start' || type === 'message_end') && event.message) {
      this.trackMessage(event.message, type);
    }
    if (type === 'message_end' && event.message) {
      const envelope = getVisualizationFromToolResult(event.message);
      if (envelope) geoInteractionService.invalidateForEnvelope(this.session, envelope);
    }
    const appendedEntry = event.entry && typeof event.entry === 'object' && !Array.isArray(event.entry)
      ? event.entry as JsonRecord
      : null;
    if (type === 'entry_appended' && appendedEntry?.type === 'custom') {
      this.session.projection.append(appendedEntry);
      if (appendedEntry.customType === PI_WEB_BRIDGE_ENTRY) this.applyBridgePayload(appendedEntry.data, typeof appendedEntry.id === 'string' ? appendedEntry.id : undefined);
    }
    // NOTE: the assistant `message_end` event carries `event.message.model` as
    // a bare id describing WHICH model produced that message, not a selection
    // change. Overwriting `this.session.model` with it downgraded the canonical
    // {provider,id} object to a bare string and propagated to all clients via
    // broadcastUpdated. Do NOT touch model identity here — only record usage.
    if (type === 'message_end' && event.message?.role === 'assistant') {
      if (event.message.usage) this.session.contextUsage = { ...(this.session.contextUsage || {}), usage: event.message.usage };
    }
    if (type === 'agent_settled') this.reconcileProjection();

    this.session.manager.broadcast({ type: 'event', sessionId: this.session.id, event });
    this.session.manager.broadcastUpdated(this.session.id);
  }

  applyBridgePayload(value: unknown, entryId?: string) {
    this.applyCapabilityUpdate(this.session.capabilityTracker.applyPayload(value, entryId), true);
  }

  applyLatestBridgeEnvelope() {
    this.applyCapabilityUpdate(this.session.capabilityTracker.applyLatest(this.session.projection.entries), false);
  }

  applyCapabilityUpdate(update: CapabilityUpdate, broadcastDiagnostics: boolean) {
    if (update.kind === 'invalid') {
      if (broadcastDiagnostics) this.session.manager.broadcastContractDiagnostic(this.session.id, update.diagnostics);
      return;
    }
    if (update.kind === 'rejected') {
      console.warn(`[Pi ${this.session.id}] ${update.diagnostic?.message ?? 'bridge revision regression ignored'}`);
      return;
    }
    if (update.kind !== 'accepted') return;
    if (update.envelope.model) this.session.model = update.envelope.model;
    this.session.thinkingLevel = update.envelope.thinkingLevel;
    if (update.mismatches.length) this.session.manager.broadcastCapabilityDiagnostic(this.session.id, update.mismatches);
  }

  reconcileProjection() {
    if (!this.session.sessionFile || !fs.existsSync(this.session.sessionFile)) return false;
    this.session.projection.replace(this.session.timingMetrics.enrichEntries(readSessionFileEntries(this.session.sessionFile).map(restoreCanvasContextMessage)));
    const lastConversationAt = latestConversationTimestamp(this.session.projection.entries);
    if (lastConversationAt) this.session.lastConversationAt = lastConversationAt;
    this.applyLatestBridgeEnvelope();
    return true;
  }

  trackMessage(message: PiMessage, eventType: string) {
    if (message.role === 'user' || message.role === 'assistant') {
      this.session.lastConversationAt = isoTimestamp(message.timestamp) || new Date().toISOString();
    }
    if (message.role === 'user' && eventType === 'message_start') {
      const text = this.messageText(message);
      if (text) this.session.userMessages.push(text.slice(0, 300));
      const rawText = typeof message.content === 'string' ? message.content : (message.content || []).filter((block) => block.type === 'text').map((block) => block.text || '').join('\n');
      const index = this.session.pendingMessages.findIndex((pending) => pending.text === rawText);
      const pending = index < 0 ? null : this.session.pendingMessages.splice(index, 1)[0];
      const attachmentIds = pending?.attachmentIds || [];
      const geoContextIds = pending?.geoContextIds || [];
      const canvasContextIds = pending?.canvasContextIds || [];
      this.session.activeGeoContextIds = [...geoContextIds];
      this.session.activeCanvasContextIds = [...canvasContextIds];
      const enriched = attachmentIds.length || geoContextIds.length || canvasContextIds.length
        ? { ...message, ...(attachmentIds.length ? { attachmentIds } : {}), ...(geoContextIds.length ? { geoContextIds } : {}), ...(canvasContextIds.length ? { canvasContextIds } : {}), content: typeof message.content === 'string' ? text : message.content?.map((block) => block.type === 'text' ? { ...block, text } : block) }
        : (typeof message.content === 'string' && message.content !== text ? { ...message, content: text } : message);
      if (attachmentIds.length) recordAttachmentMessageRefs(this.session.cwd, this.session.conversationId, { text, timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined, attachmentIds });
      if (geoContextIds.length) geoInteractionService.recordMessageRefs(this.session, { text, timestamp: typeof message.timestamp === 'number' || typeof message.timestamp === 'string' ? message.timestamp : undefined, contextIds: geoContextIds });
      this.session.projection.setMessageRefs(readAttachmentMessageRefs(this.session.cwd, this.session.conversationId));
      this.session.projection.setGeoMessageRefs(geoInteractionService.readMessageRefs(this.session.cwd, this.session.conversationId));
      this.session.projection.appendMessage(enriched as JsonRecord);
      this.session.maybeTitle();
    } else if (message.role !== 'user' && eventType === 'message_end') {
      this.session.projection.appendMessage(message as JsonRecord);
    }
  }

  private messageText(message: PiMessage) {
    if (typeof message.content === 'string') return stripAttachmentContext(stripGeoContextPrompt(stripCanvasContextPrompt(message.content)));
    if (Array.isArray(message.content)) return stripAttachmentContext(stripGeoContextPrompt(stripCanvasContextPrompt(message.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n'))));
    return '';
  }
}
