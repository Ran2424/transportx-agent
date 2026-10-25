import { SessionModelSync } from './model-session-sync.js';
import { isPiExtensionDialogRequest, parsePiMessageQueue, type PiMessageQueue } from '../contracts/pi-rpc.js';
import { boundedDiagnostics } from '../contracts/diagnostics.js';
import { hostPlatform } from './host-platform.js';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocket } = require('ws');

import type { ChildProcess } from 'node:child_process';
import type { JsonRecord, LiveClient, ModelIdentity, RpcCommand, RpcResponse } from './types.js';
import { normalizeModel, parseModelSpecToModel } from './model-utils.js';
import type { SessionService } from './session-service.js';
import { readSessionFileEntries, SessionProjection } from './session-projection.js';
import { readAttachmentMessageRefs, recordAttachmentMessageRefs } from './session-attachments.js';
import { TimingMetricsStore } from './timing-metrics.js';
import { PiRpcTransport } from './pi-rpc-transport.js';
import { retryState, classifyFailure, messageOutcome, type RunOutcome, type RetryState } from '../contracts/run-feedback.js';
import { signalProcessTree, terminateProcessTree } from './process-tree.js';
import type { ResolvedSessionPlan, SessionAssembler } from './session-assembly.js';
import type { SessionPiLaunchInput } from './session-pi-launch.js';
import { makeSessionId, removeSessionWorkingDirectory, resolveSessionWorkspaceForDeletion } from './session-workspace.js';
import { readSessionHeaderCwd } from './session-history-reader.js';
import { listSessionHistoryFiles } from './session-history-files.js';
import { containedFile } from './util/resource-path.js';
import { logHostEvent, logHostError } from './diagnostic-log.js';
import { isWithin } from './util/path.js';
import { contextUsageAfterCompaction, mergeContextUsage, withUsageTotals } from './session-context-usage.js';
import { SessionEventTiming } from './session-event-timing.js';
import { liveSessionMetadata, sessionMetadata, sessionSnapshot } from './session-metadata.js';
import { SessionCapabilityTracker, type CapabilityUpdate } from './session-capability-tracker.js';
import { appendSessionNameEntry, inferSessionTitle, isGenericSessionName, sessionFileReadyForNameAppend } from './session-title.js';
import {
  PI_WEB_BRIDGE_ENTRY,
  PI_RUNTIME_MINIMUM,
  appError,
  protocolError,
  parseCitationRegistry,
  type CapabilityMismatchReason,
  type ContractDiagnostic,
  type SessionProfileV1,
} from '../contracts/index.js';
import { stripAttachmentContext } from '../contracts/attachments.js';
import { getVisualizationFromToolResult, stripGeoContextPrompt } from '../contracts/geo.js';
import { geoInteractionService } from './geo-interaction-service.js';
import { restoreCanvasContextMessage } from './canvas-service.js';
import { stripCanvasContextPrompt } from '../contracts/canvas.js';
import { migrateSessionCitations } from './citation-migration.js';
import type { WorkspaceRuntimeLease } from './workspace-runtime.js';

export type PersistentSessionLifecycle = {
  lease: WorkspaceRuntimeLease;
  isCurrent(session: PiRpcSession): boolean;
  isReady(session: PiRpcSession): boolean;
  sync(session: PiRpcSession): void;
  closed(session: PiRpcSession): Promise<void>;
};

type SpawnFn = (cmd: string, args: string[], opts: JsonRecord) => ChildProcess;
type PiMessageContent = string | Array<{ type: string; text?: string; [key: string]: unknown }>;
type PiMessage = { role?: string; content?: PiMessageContent; usage?: JsonRecord; model?: string; timestamp?: unknown; attachmentIds?: string[]; [key: string]: unknown };
type PiRpcPayload = {
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
type PiRpcMessage = PiRpcPayload & {
  type?: string;
  success?: boolean;
  data?: PiRpcPayload;
  result?: PiRpcPayload;
  message?: PiMessage;
  assistantMessageEvent?: { type?: string; delta?: string };
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

function latestConversationTimestamp(entries: JsonRecord[]) {
  let latest: string | null = null;
  for (const entry of entries) {
    const timestamp = conversationTimestamp(entry);
    if (timestamp && (!latest || timestamp > latest)) latest = timestamp;
  }
  return latest;
}



export class PiRpcSession {
  readonly conversationId: string;
  readonly workspaceId: string | null;
  readonly lifecycle?: PersistentSessionLifecycle;
  private readonly startupAbort = new AbortController();
  private runtimeProcess: ReturnType<WorkspaceRuntimeLease['processIntent']> | null = null;
  private historyIdentityError: Error | null = null;
  private exited = false;
  private readonly reservedSessionFile: string | null;
  manager: LiveSessionManager;
  id: string;
  cwd: string;
  modelSpec: string;
  appendSystemPrompt: string;
  child: ChildProcess | null;
  pid: number | null;
  createdAt: string;
  lastActiveAt: string;
  lastConversationAt: string;
  isStreaming: boolean;
  isCompacting: boolean;
  autoCompactionEnabled: boolean;
  projection: SessionProjection;
  model: ModelIdentity | null;
  thinkingLevel: string;
  sessionFile: string | null;
  sessionName: string | null;
  contextUsage: JsonRecord | null;
  transport: PiRpcTransport;
  stdoutBuffer: string;
  private stderrBuffer = '';
  terminating: boolean;
  exitCode: number | null;
  titleSet: boolean;
  pendingSessionNamePersistence: string | null;
  userMessages: string[];
  piVersion: string;
  capabilityTracker: SessionCapabilityTracker;
  resolvedSessionPlan: ResolvedSessionPlan | null;
  pendingMessages: Array<{ commandId: string; text: string; attachmentIds: string[]; geoContextIds: string[]; canvasContextIds: string[] }>;
  activeGeoContextIds: string[];
  activeCanvasContextIds: string[];
  serviceTokens: Record<SessionService, string>;
  citationRegistryId: string;
  pendingExtensionUiRequests: Map<string, PiRpcMessage>;
  piQueue: PiMessageQueue = { steering: [], followUp: [] };
  timingMetrics: TimingMetricsStore;
  eventTiming: SessionEventTiming;
  readonly modelSync = new SessionModelSync();
  private termination: Promise<void> | null = null;
  private retry: RetryState | null = null;
  private runOutcome: RunOutcome | null = null;
  private streamingMessage: PiMessage | null = null;
  private activeTools = new Map<string, PiRpcMessage>();

  constructor(manager: LiveSessionManager, opts: { id?: string; cwd: string; conversationId: string; workspaceId?: string; lifecycle?: PersistentSessionLifecycle; citationRegistryId?: string; modelSpec?: string; appendSystemPrompt?: string; sessionFile?: string | null; entries?: JsonRecord[]; sessionName?: string | null; piVersion?: string; resolvedSessionPlan?: ResolvedSessionPlan | null }) {
    this.manager = manager;
    this.id = opts.id || makeSessionId();
    this.cwd = opts.cwd;
    this.conversationId = opts.conversationId;
    this.workspaceId = opts.workspaceId || null;
    this.lifecycle = opts.lifecycle;
    this.reservedSessionFile = opts.workspaceId ? opts.sessionFile || null : null;
    this.modelSpec = opts.modelSpec || '';
    this.appendSystemPrompt = opts.appendSystemPrompt || '';
    this.child = null;
    this.pid = null;
    this.createdAt = new Date().toISOString();
    this.lastActiveAt = this.createdAt;
    this.isStreaming = false;
    this.isCompacting = false;
    this.autoCompactionEnabled = true;
    this.timingMetrics = new TimingMetricsStore(this.cwd, this.conversationId);
    this.projection = new SessionProjection(this.timingMetrics.enrichEntries((opts.entries || []).map(restoreCanvasContextMessage)), readAttachmentMessageRefs(this.cwd, this.conversationId), geoInteractionService.readMessageRefs(this.cwd, this.conversationId));
    this.lastConversationAt = latestConversationTimestamp(this.projection.entries) || this.createdAt;
    const parsed = parseModelSpecToModel(this.modelSpec);
    this.model = parsed.model;
    this.thinkingLevel = parsed.level || 'off';
    this.sessionFile = opts.sessionFile || null;
    this.sessionName = opts.sessionName || null;
    this.contextUsage = null;
    this.transport = new PiRpcTransport();
    this.stdoutBuffer = '';
    this.terminating = false;
    this.exitCode = null;
    this.titleSet = !!this.sessionName;
    this.pendingSessionNamePersistence = (this.workspaceId || !opts.sessionFile) && this.sessionName ? this.sessionName : null;
    this.userMessages = [];
    this.piVersion = opts.piVersion || PI_RUNTIME_MINIMUM;
    this.capabilityTracker = new SessionCapabilityTracker(this.piVersion);
    this.resolvedSessionPlan = opts.resolvedSessionPlan || null;
    this.pendingMessages = [];
    this.activeGeoContextIds = [];
    this.activeCanvasContextIds = [];
    this.serviceTokens = { citation: crypto.randomUUID(), spatial: crypto.randomUUID(), video: crypto.randomUUID(), geo: crypto.randomUUID(), canvas: crypto.randomUUID(), moduleAuthoring: crypto.randomUUID(), cad: crypto.randomUUID() };
    this.citationRegistryId = opts.citationRegistryId || existingCitationRegistryId(this.cwd) || this.workspaceId || this.id;
    this.pendingExtensionUiRequests = new Map();
    this.eventTiming = new SessionEventTiming(this.timingMetrics);
    this.applyLatestBridgeEnvelope();
  }

  metadata() {
    return sessionMetadata(this, this.capabilityTracker.snapshot(), [...this.pendingExtensionUiRequests.values()]);
  }

  liveMetadata() {
    return liveSessionMetadata(this, this.capabilityTracker.snapshot());
  }

  snapshot() {
    const snapshot = sessionSnapshot(this.projection.snapshot(), this, this.capabilityTracker.snapshot(), [...this.pendingExtensionUiRequests.values()]);
    const geoInteraction = geoInteractionService.snapshot(this);
    return { ...snapshot, ...this.manager.clock(), streamingMessage: this.streamingMessage, retry: this.retry, outcome: this.runOutcome, activeToolEvents: [...this.activeTools.values()], pendingExtensionUiRequests: [...this.pendingExtensionUiRequests.values()], ...(geoInteraction ? { geoInteraction } : {}) };
  }

  get entries() {
    return this.projection.entries;
  }

  private readonly diagnose = boundedDiagnostics();

  async start() {
    if (!fs.existsSync(this.cwd) || !fs.statSync(this.cwd).isDirectory()) {
      throw new Error(`Directory not found: ${this.cwd}`);
    }
    if (!this.resolvedSessionPlan) throw new Error('A resolved Module session plan is required to start Pi.');
    if (this.workspaceId && !this.reservedSessionFile) throw new Error('A persistent conversation requires its reserved history path.');
    const input: SessionPiLaunchInput = {
      signal: this.startupAbort.signal,
      cwd: this.cwd,
      sessionId: this.id,
      sessionFile: this.sessionFile,
      modelSpec: this.modelSpec,
      appendSystemPrompt: this.appendSystemPrompt,
      resolvedSessionPlan: this.resolvedSessionPlan,
      serviceTokens: this.serviceTokens,
      endpoints: this.manager.runtime.endpoints,
    };
    const cancelled = () => Object.assign(new Error('Conversation activation was cancelled.'), { code: 'activation_cancelled', status: 409 });
    if (this.startupAbort.signal.aborted) throw cancelled();
    let onAbort!: () => void;
    const cancellation = new Promise<never>((_, reject) => { onAbort = () => reject(cancelled()); this.startupAbort.signal.addEventListener('abort', onAbort, { once: true }); });
    let launch: { args: string[]; env: NodeJS.ProcessEnv };
    try { launch = await Promise.race([Promise.resolve().then(() => this.manager.runtime.launch(input)), cancellation]); }
    finally { this.startupAbort.signal.removeEventListener('abort', onAbort); }
    if (this.terminating || this.startupAbort.signal.aborted) throw cancelled();
    const spawnFn = this.manager.runtime.spawn;
    this.runtimeProcess = this.lifecycle?.lease.processIntent('pi') || null;
    const child = spawnFn(this.manager.runtime.command, launch.args, {
      cwd: this.cwd,
      env: launch.env,
      detached: hostPlatform.detached,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.pid = child.pid || null;
    logHostEvent('info', 'pi_started', { sessionId: this.id, childPid: this.pid, cwd: this.cwd });

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      this.diagnose('pi_stderr', { sessionId: this.id, bytes: Buffer.byteLength(chunk) });
      this.stderrBuffer += chunk;
      if (Buffer.byteLength(this.stderrBuffer) > 32 * 1024) {
        logHostEvent('warn', 'pi_stderr_truncated', { sessionId: this.id, bytes: Buffer.byteLength(this.stderrBuffer) });
        this.stderrBuffer = '';
        return;
      }
      const lines = this.stderrBuffer.split(/\r?\n/);
      this.stderrBuffer = lines.pop() || '';
      for (const message of lines) if (message.trim()) logHostEvent('warn', 'pi_stderr', { sessionId: this.id, message });
    });
    child.on('error', (err: Error) => this.handleExit(null, null, err));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => this.handleExit(code, signal));
    this.runtimeProcess?.started(child);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Pi RPC process exited during startup (${signal || code})`));
      };
      child.once('error', onError);
      child.once('exit', onExit);
      setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      }, 100);
    });
    if (this.historyIdentityError) throw this.historyIdentityError;
    if (this.terminating || this.startupAbort.signal.aborted) throw cancelled();
    if (this.workspaceId) return; // Persistent activation awaits its explicit RPC handshake.

    // Give Pi a moment to enter RPC mode, then establish its canonical startup
    // state once. This discovers the session file so the projection can ingest
    // startup bridge entries; unlike the old implementation, prompts do not
    // trigger repeated get_state polling.
    setTimeout(() => {
      this.send({ type: 'get_state' }, { timeoutMs: 5000 }).catch(() => {});
      this.send({ type: 'get_session_stats' }, { timeoutMs: 5000 }).catch(() => {});
    }, 250);
  }

  send(command: RpcCommand, opts: { timeoutMs?: number; onLateResponse?: (response: RpcResponse) => void } = {}) {
    const child = this.child;
    if (!child || !child.stdin!.writable || this.terminating) {
      return Promise.reject(new Error('Pi RPC session is not running'));
    }
    return this.transport.send(child.stdin!, command, opts);
  }

  handleStdout(chunk: string) {
    if (this.lifecycle && !this.lifecycle.isCurrent(this)) return;
    if (Buffer.byteLength(this.stdoutBuffer) + Buffer.byteLength(chunk) > 16 * 1024 * 1024) {
      this.stdoutBuffer = '';
      void this.terminate('rpc_frame_too_large').catch((error) => console.error(`[Pi ${this.id}] ${error.message}`));
      return;
    }
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) this.handleLine(line);
  }

  handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { this.diagnose('pi_stdout_non_json', { sessionId: this.id, bytes: Buffer.byteLength(trimmed) }); return; }
    if (msg.type === 'response') {
      this.handleResponse(msg);
      return;
    }
    this.handleEvent(msg);
  }

  handleResponse(resp: PiRpcMessage) {
    this.transport.resolve(resp);
    this.updateStateFromResponse(resp);
    this.manager.broadcast({ type: 'event', sessionId: this.id, event: resp });
  }

  updateStateFromResponse(resp: PiRpcMessage) {
    const data: PiRpcPayload = resp.data || resp.result || resp;
    const command = resp.command || data.command;
    if (data.sessionFile) {
      if (!this.acceptSessionFile(data.sessionFile)) return;
      if (this.sessionFile && path.resolve(this.sessionFile) !== path.resolve(data.sessionFile)) this.capabilityTracker.invalidateObservation(true);
      this.sessionFile = data.sessionFile;
      this.persistPendingSessionName();
      this.reconcileProjection();
    }
    if (data.sessionName && !this.workspaceId) this.setSessionName(data.sessionName);
    if (data.contextUsage) {
      this.contextUsage = mergeContextUsage(this.contextUsage, data.contextUsage);
    }
    if (data.model) this.model = normalizeModel(data.model);
    if (data.thinkingLevel) this.thinkingLevel = data.thinkingLevel;
    if (typeof data.isStreaming === 'boolean') this.isStreaming = data.isStreaming;
    if (typeof data.isCompacting === 'boolean') this.isCompacting = data.isCompacting;
    if (typeof data.autoCompactionEnabled === 'boolean') this.autoCompactionEnabled = data.autoCompactionEnabled;
    if (data.level) this.thinkingLevel = data.level;
    if (data.tokens) this.contextUsage = withUsageTotals(this.contextUsage, data.tokens);
    if (command === 'set_model' || command === 'cycle_model') {
      if (data.model) this.model = normalizeModel(data.model);
      else if (data.provider && data.id) this.model = normalizeModel(data);
    }
    this.touch(true);
    this.lifecycle?.sync(this);
  }

  handleEvent(event: PiRpcMessage) {
    if (this.modelSync.consume(event)) return;
    this.touch(false);
    const type = event.type;
    if (this.workspaceId && type === 'session_info_changed') event = { ...event, name: this.sessionName || undefined };
    if (type === 'queue_update') {
      const queue = parsePiMessageQueue(event);
      if (queue) {
        this.piQueue = {
          steering: queue.steering.map((text) => this.messageText({ content: text })),
          followUp: queue.followUp.map((text) => this.messageText({ content: text })),
        };
        event = { ...event, ...this.piQueue };
      }
    }
    if (type === 'session_tree' || type === 'session_switch') this.capabilityTracker.invalidateObservation();
    const now = Date.now();
    if (type === 'thinking_level_changed') {
      const level = typeof event.thinkingLevel === 'string' ? event.thinkingLevel : typeof event.level === 'string' ? event.level : '';
      if (level) {
        this.thinkingLevel = level;
        this.touch(true);
      }
    }
    this.eventTiming.apply(event, now);
    if (type === 'agent_start' || type === 'auto_retry_start') this.runOutcome = null;
    if (type === 'message_end' && event.message?.role === 'assistant') this.runOutcome = messageOutcome(event.message);
    if (type === 'auto_retry_start') this.retry = retryState(event);
    if (type === 'auto_retry_end') this.runOutcome = event.success ? null : /cancelled/i.test(String(event.finalError)) ? { status: 'cancelled' } : { status: 'failed', reason: classifyFailure(event.finalError) };
    if (((type === 'message_end' && event.message?.role === 'assistant') || type === 'auto_retry_end') && this.runOutcome?.status === 'failed') {
      const message = type === 'auto_retry_end' ? event.finalError : event.message?.errorMessage;
      logHostEvent('error', 'pi_run_failed', { sessionId: this.id, reason: this.runOutcome.reason, message: typeof message === 'string' ? message : undefined });
    }
    if (type === 'auto_retry_end' || type === 'agent_settled') this.retry = null;
    if (type === 'message_start' && event.message?.role === 'assistant') this.streamingMessage = event.message;
    if (type === 'message_update') {
      const partial = event.message || (event.assistantMessageEvent as { partial?: PiMessage } | undefined)?.partial;
      if (partial?.role === 'assistant') this.streamingMessage = partial;
    }
    if (type === 'message_end' && event.message?.role === 'assistant') this.streamingMessage = null;
    if (typeof event.toolCallId === 'string') {
      if (type === 'tool_execution_start') this.activeTools.set(event.toolCallId, event);
      if (type === 'tool_execution_update') {
        const previous = this.activeTools.get(event.toolCallId);
        this.activeTools.set(event.toolCallId, { ...previous, ...event, type: 'tool_execution_start' });
      }
      if (type === 'tool_execution_end') this.activeTools.delete(event.toolCallId);
    }
    if (isPiExtensionDialogRequest(event) && typeof event.id === 'string' && event.id) this.pendingExtensionUiRequests.set(event.id, event);
    if (type === 'agent_start' || type === 'turn_start') this.isStreaming = true;
    if (type === 'compaction_start' || type === 'auto_compaction_start') this.isCompacting = true;
    if (type === 'compaction_end' || type === 'auto_compaction_end') {
      this.isCompacting = false;
      const result = event.result && typeof event.result === 'object' ? event.result as JsonRecord : null;
      this.contextUsage = contextUsageAfterCompaction(this.contextUsage, this.model?.contextWindow, result?.estimatedTokensAfter);
      this.reconcileProjection();
    }
    if (type === 'agent_settled') {
      this.lifecycle?.sync(this);
      this.isStreaming = false;
      this.streamingMessage = null;
      this.activeTools.clear();
      this.pendingExtensionUiRequests.clear();
      // Pi has flushed by the time a run settles; retry the pending name write.
      this.persistPendingSessionName();
      this.send({ type: 'get_session_stats' }, { timeoutMs: 5000 }).catch(() => {});
    }
    if (event.contextUsage) this.contextUsage = event.contextUsage;
    if (event.sessionFile) {
      if (!this.acceptSessionFile(event.sessionFile)) return;
      this.sessionFile = event.sessionFile;
      this.persistPendingSessionName();
    }
    if (type === 'session_info_changed' && !this.workspaceId) {
      this.sessionName = typeof event.name === 'string' ? event.name.trim() || null : null;
      this.titleSet = !!this.sessionName;
      this.pendingSessionNamePersistence = null;
    }
    if (type === 'session_name' && event.name) {
      if (!this.workspaceId && !this.setSessionName(event.name)) return;
      event.name = this.sessionName || event.name;
    }

    if ((type === 'message_start' || type === 'message_end') && event.message) {
      this.trackMessage(event.message, type);
    }
    if (type === 'message_end' && event.message) {
      const envelope = getVisualizationFromToolResult(event.message);
      if (envelope) geoInteractionService.invalidateForEnvelope(this, envelope);
    }
    const appendedEntry = event.entry && typeof event.entry === 'object' && !Array.isArray(event.entry)
      ? event.entry as JsonRecord
      : null;
    if (type === 'entry_appended' && appendedEntry?.type === 'custom') {
      this.projection.append(appendedEntry);
      if (appendedEntry.customType === PI_WEB_BRIDGE_ENTRY) this.applyBridgePayload(appendedEntry.data, typeof appendedEntry.id === 'string' ? appendedEntry.id : undefined);
    }
    // NOTE: the assistant `message_end` event carries `event.message.model` as
    // a bare id describing WHICH model produced that message, not a selection
    // change. Overwriting `this.model` with it downgraded the canonical
    // {provider,id} object to a bare string and propagated to all clients via
    // broadcastUpdated. Do NOT touch model identity here — only record usage.
    if (type === 'message_end' && event.message?.role === 'assistant') {
      if (event.message.usage) this.contextUsage = { ...(this.contextUsage || {}), usage: event.message.usage };
    }
    if (type === 'agent_settled') this.reconcileProjection();

    this.manager.broadcast({ type: 'event', sessionId: this.id, event });
    this.manager.broadcastUpdated(this.id);
  }

  applyBridgePayload(value: unknown, entryId?: string) {
    this.applyCapabilityUpdate(this.capabilityTracker.applyPayload(value, entryId), true);
  }

  applyLatestBridgeEnvelope() {
    this.applyCapabilityUpdate(this.capabilityTracker.applyLatest(this.projection.entries), false);
  }

  applyCapabilityUpdate(update: CapabilityUpdate, broadcastDiagnostics: boolean) {
    if (update.kind === 'invalid') {
      if (broadcastDiagnostics) this.manager.broadcastContractDiagnostic(this.id, update.diagnostics);
      return;
    }
    if (update.kind === 'rejected') {
      console.warn(`[Pi ${this.id}] ${update.diagnostic?.message ?? 'bridge revision regression ignored'}`);
      return;
    }
    if (update.kind !== 'accepted') return;
    if (update.envelope.model) this.model = update.envelope.model;
    this.thinkingLevel = update.envelope.thinkingLevel;
    if (update.mismatches.length) this.manager.broadcastCapabilityDiagnostic(this.id, update.mismatches);
  }

  reconcileProjection() {
    if (!this.sessionFile || !fs.existsSync(this.sessionFile)) return false;
    this.projection.replace(this.timingMetrics.enrichEntries(readSessionFileEntries(this.sessionFile).map(restoreCanvasContextMessage)));
    const lastConversationAt = latestConversationTimestamp(this.projection.entries);
    if (lastConversationAt) this.lastConversationAt = lastConversationAt;
    this.applyLatestBridgeEnvelope();
    return true;
  }

  trackMessage(message: PiMessage, eventType: string) {
    if (message.role === 'user' || message.role === 'assistant') {
      this.lastConversationAt = isoTimestamp(message.timestamp) || new Date().toISOString();
    }
    if (message.role === 'user' && eventType === 'message_start') {
      const text = this.messageText(message);
      if (text) this.userMessages.push(text.slice(0, 300));
      const rawText = typeof message.content === 'string' ? message.content : (message.content || []).filter((block) => block.type === 'text').map((block) => block.text || '').join('\n');
      const index = this.pendingMessages.findIndex((pending) => pending.text === rawText);
      const pending = index < 0 ? null : this.pendingMessages.splice(index, 1)[0];
      const attachmentIds = pending?.attachmentIds || [];
      const geoContextIds = pending?.geoContextIds || [];
      const canvasContextIds = pending?.canvasContextIds || [];
      this.activeGeoContextIds = [...geoContextIds];
      this.activeCanvasContextIds = [...canvasContextIds];
      const enriched = attachmentIds.length || geoContextIds.length || canvasContextIds.length
        ? { ...message, ...(attachmentIds.length ? { attachmentIds } : {}), ...(geoContextIds.length ? { geoContextIds } : {}), ...(canvasContextIds.length ? { canvasContextIds } : {}), content: typeof message.content === 'string' ? text : message.content?.map((block) => block.type === 'text' ? { ...block, text } : block) }
        : (typeof message.content === 'string' && message.content !== text ? { ...message, content: text } : message);
      if (attachmentIds.length) recordAttachmentMessageRefs(this.cwd, this.conversationId, { text, timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined, attachmentIds });
      if (geoContextIds.length) geoInteractionService.recordMessageRefs(this, { text, timestamp: typeof message.timestamp === 'number' || typeof message.timestamp === 'string' ? message.timestamp : undefined, contextIds: geoContextIds });
      this.projection.setMessageRefs(readAttachmentMessageRefs(this.cwd, this.conversationId));
      this.projection.setGeoMessageRefs(geoInteractionService.readMessageRefs(this.cwd, this.conversationId));
      this.projection.appendMessage(enriched as JsonRecord);
      this.maybeTitle();
    } else if (message.role !== 'user' && eventType === 'message_end') {
      this.projection.appendMessage(message as JsonRecord);
    }
  }

  registerPendingMessage(pending: PiRpcSession['pendingMessages'][number]) {
    if (this.pendingMessages.length >= 200) throw new Error('Pending message capacity reached');
    this.pendingMessages.push(pending);
  }

  discardPendingMessage(commandId: string) {
    const index = this.pendingMessages.findIndex((pending) => pending.commandId === commandId);
    if (index >= 0) this.pendingMessages.splice(index, 1);
  }

  messageText(message: PiMessage) {
    if (typeof message.content === 'string') return stripAttachmentContext(stripGeoContextPrompt(stripCanvasContextPrompt(message.content)));
    if (Array.isArray(message.content)) return stripAttachmentContext(stripGeoContextPrompt(stripCanvasContextPrompt(message.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n'))));
    return '';
  }

  abortGeoInteraction() {
    geoInteractionService.abortSession(this, 'agent_aborted');
    return this.manager.cancelJobs(this.id);
  }

  setSessionName(name: unknown) {
    const trimmed = String(name || '').trim();
    if (!trimmed || isGenericSessionName(trimmed)) return false;
    this.sessionName = trimmed;
    return true;
  }

  persistPendingSessionName() {
    if (!this.sessionFile || !this.pendingSessionNamePersistence) return;
    // Appending before Pi's first flush would pre-create the file and make
    // Pi's exclusive create throw EEXIST; stay pending and retry later.
    if (!sessionFileReadyForNameAppend(this.sessionFile)) return;
    try {
      appendSessionNameEntry(this.sessionFile, this.pendingSessionNamePersistence);
      this.pendingSessionNamePersistence = null;
    } catch (error) {
      console.error(`[Pi ${this.id}] Failed to persist session name: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  maybeTitle() {
    if (this.titleSet || (this.sessionName && !isGenericSessionName(this.sessionName)) || this.userMessages.length < 1) return;
    const title = inferSessionTitle(this.userMessages);
    if (!title) return;
    this.sessionName = title;
    this.titleSet = true;
    this.manager.broadcast({ type: 'event', sessionId: this.id, event: { type: 'session_name', name: this.sessionName } });
  }

  touch(broadcast: boolean) {
    this.lastActiveAt = new Date().toISOString();
    if (broadcast) this.manager.broadcastUpdated(this.id);
  }

  async stopForUpdate() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.terminating = true;
    try {
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          child.removeListener('exit', onExit);
          if (error) reject(error); else resolve();
        };
        const onExit = () => finish();
        const timer = setTimeout(() => finish(new Error('Pi did not stop for update')), 5000);
        child.once('exit', onExit);
        try { signalProcessTree(child, 'SIGTERM'); } catch (error) { finish(error as Error); }
      });
    } catch (error) {
      this.terminating = false;
      throw error;
    }
  }

  async terminate(reason = 'closed') {
    if (this.termination) return this.termination;
    this.terminating = true;
    this.startupAbort.abort();
    geoInteractionService.abortSession(this, reason === 'aborted_by_user' ? 'agent_aborted' : 'session_closed');
    this.transport.rejectAll(new Error(`Session terminated: ${reason}`));
    this.termination = (this.child ? terminateProcessTree(this.child) : Promise.resolve()).then(() => {
      this.pendingMessages = [];
      this.runtimeProcess?.stopped();
    }).catch((error) => { this.termination = null; throw error; });
    return this.termination;
  }

  handleExit(code: number | null, signal: string | null, err?: { message?: string }) {
    if (this.exited) return;
    if (err && this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) {
      logHostError('pi_process_error', err, { sessionId: this.id }); return;
    }
    this.exited = true;
    if (this.stderrBuffer.trim()) logHostEvent('warn', 'pi_stderr', { sessionId: this.id, message: this.stderrBuffer });
    this.stderrBuffer = '';
    logHostEvent(err || (!this.terminating && code !== 0) ? 'error' : 'info', 'pi_exited', { sessionId: this.id, exitCode: code, signal, message: err?.message });
    this.exitCode = code;
    this.terminating = true;
    try { this.runtimeProcess?.stopped(); }
    catch (error) { logHostError('pi_stop_record_failed', error, { sessionId: this.id }); }
    geoInteractionService.abortSession(this, 'agent_aborted');
    this.transport.rejectAll(err || new Error(`Pi process exited (${signal || code})`));
    this.manager.removeExited(this.id, err?.message || `process_exit:${signal || code}`);
  }

  cancelStart() {
    this.terminating = true; this.startupAbort.abort();
    this.transport.rejectAll(Object.assign(new Error('Conversation activation was cancelled.'), { code: 'activation_cancelled', status: 409 }));
  }

  private acceptSessionFile(file: string) {
    if (!this.reservedSessionFile || path.resolve(file) === path.resolve(this.reservedSessionFile)) return true;
    this.historyIdentityError = Object.assign(new Error('Pi changed its reserved conversation history path.'), { code: 'history_identity_mismatch', status: 409 });
    logHostError('history_identity_mismatch', this.historyIdentityError, { sessionId: this.id, conversationId: this.conversationId });
    const stop = this.manager.get(this.id) === this ? this.manager.delete(this.id, 'history_identity_mismatch') : this.terminate('history_identity_mismatch');
    void stop.catch((error) => logHostError('persistent_session_stop_failed', error, { sessionId: this.id }));
    return false;
  }
}

function existingCitationRegistryId(cwd: string) {
  try { return parseCitationRegistry(JSON.parse(fs.readFileSync(path.join(cwd, '.tau', 'citations.json'), 'utf8')))?.sessionId || null; }
  catch { return null; }
}

export type SessionManagerDependencies = {
  defaultDomainId: string;
  assembler: Pick<SessionAssembler, 'assemble' | 'save' | 'load'>;
  assemblerForProfile(profile: SessionProfileV1): Pick<SessionAssembler, 'assemble' | 'save' | 'load'>;
  createWorkspace(cwd?: string, name?: string | null): string;
  command: string;
  spawn: SpawnFn;
  endpoints: Record<SessionService, string>;
  launch(input: SessionPiLaunchInput): { args: string[]; env: NodeJS.ProcessEnv } | Promise<{ args: string[]; env: NodeJS.ProcessEnv }>;
};

export class LiveSessionManager {
  sessions: Map<string, PiRpcSession>;
  clients: Set<LiveClient>;
  pendingResumes: Map<string, Promise<PiRpcSession>>;
  terminatingResumes: Map<string, Promise<void>>;
  piVersion: string;
  liveMetadataSignatures: Map<string, string>;
  private closingSessions = new Map<string, Promise<boolean>>();
  private historyDeletes = new Map<string, Promise<void>>();
  private deletingWorkspaces = new Set<string>();
  private startingWorkspaces = new Set<string>();
  private jobs = new Map<string, Set<{ id: string; controller: AbortController; completion: Promise<unknown> }>>();
  private readonly diagnose = boundedDiagnostics();
  private startingSessions = 0;
  private readonly hostGeneration = crypto.randomUUID();
  private revision = 0;
  clock() { return { hostGeneration: this.hostGeneration, revision: this.revision }; }

  get runtime() {
    if (!this.dependencies) throw new Error('Session runtime dependencies were not provided');
    return this.dependencies;
  }

  constructor(private readonly dependencies?: SessionManagerDependencies) {
    this.sessions = new Map();
    this.clients = new Set();
    this.pendingResumes = new Map();
    this.terminatingResumes = new Map();
    this.piVersion = PI_RUNTIME_MINIMUM;
    this.liveMetadataSignatures = new Map();
  }
  setPiVersion(version: string) { this.piVersion = version || PI_RUNTIME_MINIMUM; }
  addClient(ws: LiveClient) { this.clients.add(ws); }
  removeClient(ws: LiveClient) { this.clients.delete(ws); }
  broadcast(data: unknown) {
    this.revision++;
    const payload = JSON.stringify({ ...(data as JsonRecord), ...this.clock() });
    const bytes = Buffer.byteLength(payload);
    for (const client of this.clients) {
      if ((client.bufferedAmount || 0) + bytes > 8 * 1024 * 1024) {
        client.terminate();
        this.removeClient(client);
        continue;
      }
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }
  broadcastUpdated(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.lifecycle && !s.lifecycle.isReady(s)) return;
    const session = s.liveMetadata();
    const signature = JSON.stringify(session);
    if (this.liveMetadataSignatures.get(id) === signature) return;
    this.liveMetadataSignatures.set(id, signature);
    this.broadcast({ type: 'live_session_updated', session });
  }
  broadcastCapabilityDiagnostic(sessionId: string, mismatches: CapabilityMismatchReason[]) {
    if (!mismatches.length) return;
    const error = appError({
      code: 'runtime_capability_drift',
      category: 'protocol',
      message: mismatches.map((m) => m.message).join('; '),
      sessionId,
      retryable: false,
      diagnostics: {
        count: mismatches.length,
        firstCode: typeof mismatches[0]?.field === 'string' ? mismatches[0].field : 'unknown',
      },
    });
    this.broadcast({ type: 'contract_diagnostic', sessionId, error, mismatches });
  }
  broadcastContractDiagnostic(sessionId: string, diagnostics: ContractDiagnostic[]) {
    if (!diagnostics.length) return;
    this.broadcast({
      type: 'contract_diagnostic',
      sessionId,
      error: protocolError(diagnostics, sessionId),
      diagnostics,
    });
  }
  list() { return Array.from(this.sessions.values()).map((s) => s.metadata()); }
  get(id: string) { return this.sessions.get(id); }
  hasJobs(id: string) { return !!this.jobs.get(id)?.size; }
  async startInstance(session: PiRpcSession) {
    if (!session.lifecycle || !session.workspaceId) throw new Error('Persistent runtime ownership is required.');
    if (this.sessions.size + this.startingSessions >= 32) throw Object.assign(new Error('Live session capacity reached'), { status: 503 });
    this.startingSessions++;
    try {
      await session.start();
      this.sessions.set(session.id, session);
      return session;
    } finally { this.startingSessions--; }
  }
  findBySessionFile(sessionFile: string) {
    const resolved = path.resolve(sessionFile);
    return Array.from(this.sessions.values()).find((s) => s.sessionFile && path.resolve(s.sessionFile) === resolved);
  }
  hasPendingResume(sessionFile: string) { return this.pendingResumes.has(path.resolve(sessionFile)); }
  hasTerminatingResume(sessionFile: string) { return this.terminatingResumes.has(path.resolve(sessionFile)); }
  runJob<T>(id: string, execute: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, onJob?: (jobId: string) => void): Promise<T> {
    const session = this.sessions.get(id);
    if (!session || session.terminating) return Promise.reject(Object.assign(new Error('Session is closing or unavailable'), { status: 409 }));
    const owned = this.jobs.get(id) || new Set();
    const total = [...this.jobs.values()].reduce((count, jobs) => count + jobs.size, 0);
    if (owned.size >= 2 || total >= 4) return Promise.reject(Object.assign(new Error('Analysis job capacity reached'), { status: 503 }));
    const jobId = crypto.randomUUID();
    onJob?.(jobId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const job = { id: jobId, controller, completion: Promise.resolve() as Promise<unknown> };
    owned.add(job);
    this.jobs.set(id, owned);
    const completion = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('Analysis cancelled');
      return execute(controller.signal);
    }).catch((error) => {
      this.diagnose('analysis_job_failed', { sessionId: id, jobId: job.id });
      throw error;
    }).finally(() => {
      signal?.removeEventListener('abort', abort);
      owned.delete(job);
      if (!owned.size) this.jobs.delete(id);
    });
    job.completion = completion;
    return completion;
  }
  async cancelJobs(id: string) {
    const jobs = [...(this.jobs.get(id) || [])];
    if (!jobs.length) return;
    for (const job of jobs) job.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.race([
        Promise.allSettled(jobs.map((job) => job.completion)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Analysis jobs did not stop'), { code: 'process_stop_unconfirmed', status: 503 })), 5500); }),
      ]);
      const failed = results.find((result) => result.status === 'rejected' && result.reason?.code === 'process_stop_unconfirmed');
      if (failed?.status === 'rejected') {
        for (const job of jobs) this.diagnose('job_stop_unconfirmed', { sessionId: id, jobId: job.id });
        throw failed.reason;
      }
    } finally { clearTimeout(timer); }
  }
  async create({ cwd, model, sessionName, profile, domainId = this.runtime.defaultDomainId, appendSystemPrompt = '' }: { cwd?: string; model?: string; sessionName?: string | null; profile?: SessionProfileV1; domainId?: string; appendSystemPrompt?: string }) {
    if (!model?.trim()) throw new Error('请先添加并选择模型');
    if (this.sessions.size + this.startingSessions >= 32) throw Object.assign(new Error('Live session capacity reached'), { status: 503 });
    this.startingSessions++;
    let workspace: string | undefined;
    try {
    if (cwd) this.assertWorkspaceAvailable(cwd);
    const resolved = this.runtime.createWorkspace(cwd, sessionName);
    this.assertWorkspaceAvailable(resolved);
    workspace = resolved;
    this.startingWorkspaces.add(resolved);
    const assembler = profile ? this.runtime.assemblerForProfile(profile) : this.runtime.assembler;
    const resolvedSessionPlan = assembler.assemble(domainId, resolved, profile);
    assembler.save(resolvedSessionPlan);
    const session = new PiRpcSession(this, { cwd: resolved, conversationId: `conv_${crypto.randomUUID()}`, modelSpec: (model || '').trim(), appendSystemPrompt, sessionName, piVersion: this.piVersion, resolvedSessionPlan });
    await session.start();
    this.sessions.set(session.id, session);
    this.broadcast({ type: 'live_session_created', session: session.metadata() });
    return session;
    } finally { this.startingSessions--; if (workspace) this.startingWorkspaces.delete(workspace); }
  }
  async resume({ sessionFile, cwd, model, entries, sessionName, useCurrentConfiguration = false }: { sessionFile: string; cwd: string; model?: string; entries?: JsonRecord[]; sessionName?: string | null; useCurrentConfiguration?: boolean }) {
    const resolved = path.resolve(sessionFile);
    this.assertWorkspaceAvailable(cwd);
    if (this.historyDeletes.has(resolved)) throw Object.assign(new Error('Session history is being deleted'), { status: 409 });
    const closing = this.terminatingResumes.get(resolved);
    if (closing) await closing;
    if (this.historyDeletes.has(resolved)) throw Object.assign(new Error('Session history is being deleted'), { status: 409 });
    const existing = this.findBySessionFile(resolved);
    if (existing?.terminating) throw Object.assign(new Error('Session Writer has not stopped'), { status: 409 });
    if (existing) return existing;
    const pending = this.pendingResumes.get(resolved);
    if (pending) return pending;
    if (this.sessions.size + this.startingSessions >= 32) throw Object.assign(new Error('Live session capacity reached'), { status: 503 });
    this.startingSessions++;
    const resumePromise = (async () => {
      try {
        await Promise.resolve();
        if (this.historyDeletes.has(resolved)) throw Object.assign(new Error('Session history is being deleted'), { status: 409 });
        this.assertWorkspaceAvailable(cwd);
        const terminating = this.terminatingResumes.get(resolved);
        if (terminating) await terminating;
        if (!fs.existsSync(resolved)) throw new Error('Session not found');
        const afterTerminationExisting = this.findBySessionFile(resolved);
        if (afterTerminationExisting) return afterTerminationExisting;
        const migratedPlanPath = path.join(cwd, '.tau', 'resolved-session-plan.v3.json');
        let resolvedSessionPlan: ResolvedSessionPlan;
        try {
          resolvedSessionPlan = this.runtime.assembler.load(cwd, fs.existsSync(migratedPlanPath) ? 'resolved-session-plan.v3.json' : 'resolved-session-plan.json');
        } catch (error) {
          if (!useCurrentConfiguration || !(error instanceof Error) || !('code' in error) || error.code !== 'legacy_plan_requires_confirmation') throw error;
          resolvedSessionPlan = this.runtime.assembler.assemble(this.runtime.defaultDomainId, cwd);
          this.runtime.assembler.save(resolvedSessionPlan, 'resolved-session-plan.v3.json');
        }
        try {
          const { APP_PATHS } = require('./config.js');
          const backup = migrateSessionCitations(cwd, APP_PATHS.userDataDir);
          if (backup) logHostEvent('info', 'citation_registry_migrated', { cwd, backup });
        } catch (cause) {
          logHostError('citation_migration_failed', cause, { cwd });
          throw Object.assign(new Error('Historical citations could not be migrated; original files are unchanged. See runtime logs.', { cause }), { code: 'citation_migration_failed', status: 409 });
        }
        const session = new PiRpcSession(this, { cwd, conversationId: `conv_${crypto.randomUUID()}`, modelSpec: (model || '').trim(), sessionFile: resolved, entries, sessionName, piVersion: this.piVersion, resolvedSessionPlan });
        await session.start();
        this.sessions.set(session.id, session);
        this.broadcast({ type: 'live_session_created', session: session.metadata() });
        return session;
      } finally {
        this.startingSessions--;
        this.pendingResumes.delete(resolved);
      }
    })();
    this.pendingResumes.set(resolved, resumePromise);
    return resumePromise;
  }
  async delete(id: string, reason = 'closed_by_user', cleanup?: () => Promise<void>) {
    const closing = this.closingSessions.get(id);
    if (closing) return closing;
    const session = this.sessions.get(id);
    if (!session) return false;
    const resolvedFile = session.sessionFile ? path.resolve(session.sessionFile) : null;
    session.terminating = true;
    const termination = (async () => {
      await Promise.resolve();
      await this.cancelJobs(id);
      await session.terminate(reason);
      session.isStreaming = false;
      session.isCompacting = false;
      await session.lifecycle?.closed(session);
      if (cleanup) await cleanup();
      const registered = this.sessions.delete(id);
      this.liveMetadataSignatures.delete(id);
      if (registered) this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
      return true;
    })();
    this.closingSessions.set(id, termination);
    const writer = termination.then(() => undefined);
    // Observers awaiting close/resume receive the rejection; avoid an orphan
    // rejection when no resume is currently waiting on this gate.
    writer.catch(() => {});
    if (resolvedFile) this.terminatingResumes.set(resolvedFile, writer);
    try { return await termination; }
    finally {
      this.closingSessions.delete(id);
      if (resolvedFile && this.terminatingResumes.get(resolvedFile) === writer) this.terminatingResumes.delete(resolvedFile);
    }
  }
  private assertWorkspaceAvailable(cwd: string) {
    const resolved = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
    if ([...this.deletingWorkspaces].some((workspace) => isWithin(workspace, resolved) || isWithin(resolved, workspace))) throw Object.assign(new Error('Task directory is being deleted'), { status: 409 });
  }
  deleteHistory(sessionFile: string, deleteWorkspace = true) {
    return this.deleteConversation({ sessionFile, deleteWorkspace });
  }
  deleteConversation({ sessionFile, sessionId, deleteWorkspace = true }: { sessionFile?: string; sessionId?: string; deleteWorkspace?: boolean }) {
    const requestedSession = sessionId ? this.get(sessionId) : undefined;
    const file = sessionFile || requestedSession?.sessionFile;
    let resolved = file ? path.resolve(file) : null;
    const key = resolved || `live:${sessionId}`;
    const existing = this.historyDeletes.get(key);
    if (existing) return existing;
    const deletion = (async () => {
      await Promise.resolve();
      if (resolved) await this.pendingResumes.get(resolved)?.catch(() => {});
      const session = requestedSession || (resolved ? this.findBySessionFile(resolved) : undefined);
      const { SESSIONS_DIR, expandHome } = require('./config.js');
      const normalize = (value: unknown) => typeof value === 'string' && value.trim() ? path.resolve(expandHome(value)) : null;
      const cwd = resolved ? readSessionHeaderCwd(resolved, normalize) : normalize(session?.cwd);
      let workspace: string | null = null;
      if (deleteWorkspace) {
        if (!cwd) throw Object.assign(new Error('Task directory is missing from session metadata. Disable workspace deletion to delete only the history.'), { status: 409 });
        if (session?.cwd) {
          const paths = [cwd, session.cwd].map((value) => fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value));
          if (path.relative(paths[0], paths[1]) !== '') throw Object.assign(new Error('History task directory does not match the live session. Workspace deletion refused.'), { status: 409 });
        }
        workspace = resolveSessionWorkspaceForDeletion(cwd, resolved || undefined);
      }
      const cleanup = async () => {
        if (!resolved && session?.sessionFile) {
          resolved = containedFile(SESSIONS_DIR, session.sessionFile);
          this.historyDeletes.set(resolved, operation);
        }
        if (workspace) {
          const real = fs.realpathSync(workspace);
          this.assertWorkspaceAvailable(real);
          this.deletingWorkspaces.add(real);
          try {
            const overlaps = (other: string) => {
              const canonical = fs.existsSync(other) ? fs.realpathSync(other) : path.resolve(other);
              return isWithin(real, canonical) || isWithin(canonical, real);
            };
            const historyCwds = listSessionHistoryFiles(SESSIONS_DIR)
              .filter(({ filePath }) => !resolved || path.relative(resolved, filePath) !== '')
              .map(({ filePath }) => readSessionHeaderCwd(filePath, normalize));
            const shared = [...this.sessions.values()].some((other) => other !== session && other.cwd && overlaps(other.cwd)) || [...this.startingWorkspaces].some(overlaps) || historyCwds.some((other) => other && overlaps(other));
            if (shared) throw Object.assign(new Error(`Task directory is used by another session: ${workspace}. Disable workspace deletion to keep it.`), { status: 409 });
            // Revalidate after stopping the Writer, before any filesystem mutation.
            resolveSessionWorkspaceForDeletion(workspace, resolved || undefined);
            await removeSessionWorkingDirectory(workspace);
          } finally { this.deletingWorkspaces.delete(real); }
        }
        if (resolved) await fs.promises.rm(path.toNamespacedPath(resolved), { force: true });
      };
      if (session) await this.closingSessions.get(session.id);
      if (session && this.sessions.has(session.id)) await this.delete(session.id, 'history_deleted', cleanup);
      else { if (resolved) await this.terminatingResumes.get(resolved); await cleanup(); }
    });
    const operation = deletion().finally(() => { this.historyDeletes.delete(key); if (resolved) this.historyDeletes.delete(resolved); });
    this.historyDeletes.set(key, operation);
    return operation;
  }
  removeExited(id: string, reason: string) {
    if (!this.sessions.has(id)) return;
    if (this.closingSessions.has(id)) return;
    this.delete(id, reason).catch((error) => console.error(`[Pi ${id}] Cleanup failed:`, error));
  }
  async shutdown() {
    const results = await Promise.allSettled([...this.sessions.keys()].map((id) => this.delete(id, 'server_shutdown')));
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Some session stops could not be confirmed.');
  }
}
