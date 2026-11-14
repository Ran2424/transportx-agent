import { SessionModelSync } from './model-session-sync.js';
import type { PiMessageQueue } from '../contracts/pi-rpc.js';
import { boundedDiagnostics } from '../contracts/diagnostics.js';
import { hostPlatform } from './host-platform.js';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

import type { ChildProcess } from 'node:child_process';
import type { JsonRecord, ModelIdentity, RpcCommand, RpcResponse } from './types.js';
import { modelLabel, normalizeModel, parseModelSpecToModel } from './model-utils.js';
import type { SessionService } from './session-service.js';
import { SessionProjection } from './session-projection.js';
import { readAttachmentMessageRefs } from './session-attachments.js';
import { TimingMetricsStore } from './timing-metrics.js';
import { PiRpcTransport } from './pi-rpc-transport.js';
import { signalProcessTree, terminateProcessTree } from './process-tree.js';
import type { ResolvedSessionPlan } from './session-assembly.js';
import type { SessionPiLaunchInput } from './session-pi-launch.js';
import { makeSessionId } from './session-workspace.js';
import { logHostEvent, logHostError } from './diagnostic-log.js';
import { mergeContextUsage, withUsageTotals } from './session-context-usage.js';
import { SessionEventTiming } from './session-event-timing.js';
import { liveSessionMetadata, sessionMetadata, sessionSnapshot } from './session-metadata.js';
import { SessionCapabilityTracker } from './session-capability-tracker.js';
import { inferSessionTitle, isGenericSessionName, sessionFileReadyForNameAppend } from './session-title.js';
import { PI_RUNTIME_MINIMUM } from '../contracts/index.js';
import { geoInteractionService } from './geo-interaction-service.js';
import { restoreCanvasContextMessage } from './canvas-service.js';
import type { WorkspaceRuntimeLease } from './workspace-runtime.js';
import type { PiSessionManager } from './pi-session-runtime.js';
import { latestConversationTimestamp, SessionEvents, type PiRpcMessage, type PiRpcPayload } from './session-events.js';

export type PersistentSessionLifecycle = {
  lease: WorkspaceRuntimeLease;
  isCurrent(session: PiRpcSession): boolean;
  isReady(session: PiRpcSession): boolean;
  sync(session: PiRpcSession): Promise<unknown>;
  closed(session: PiRpcSession): Promise<void>;
};

export class PiRpcSession {
  readonly conversationId: string;
  readonly workspaceId: string | null;
  readonly lifecycle?: PersistentSessionLifecycle;
  private readonly startupAbort = new AbortController();
  private runtimeProcess: ReturnType<WorkspaceRuntimeLease['processIntent']> | null = null;
  private historyIdentityError: Error | null = null;
  private exited = false;
  private readonly reservedSessionFile: string | null;
  manager: PiSessionManager;
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
  private persistingSessionName = false;
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
  readonly events = new SessionEvents(this, () => this.lifecycle?.sync(this));

  constructor(manager: PiSessionManager, opts: { id?: string; cwd: string; conversationId: string; workspaceId?: string; lifecycle?: PersistentSessionLifecycle; citationRegistryId?: string; modelSpec?: string; appendSystemPrompt?: string; sessionFile?: string | null; entries?: JsonRecord[]; sessionName?: string | null; piVersion?: string; resolvedSessionPlan?: ResolvedSessionPlan | null }) {
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
    this.lastConversationAt = latestConversationTimestamp(this.projection.entries) || '';
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
    this.serviceTokens = { citation: crypto.randomUUID(), spatial: crypto.randomUUID(), video: crypto.randomUUID(), geo: crypto.randomUUID(), canvas: crypto.randomUUID(), moduleAuthoring: crypto.randomUUID(), cad: crypto.randomUUID(), traffic: crypto.randomUUID() };
    this.citationRegistryId = opts.citationRegistryId || this.workspaceId || this.id;
    this.pendingExtensionUiRequests = new Map();
    this.eventTiming = new SessionEventTiming(this.timingMetrics);
    this.events.applyLatestBridgeEnvelope();
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
    return { ...snapshot, ...this.manager.clock(), ...this.events.snapshot(),
      workingElapsedMs: this.eventTiming.workingElapsedMs ?? null, workingDurationMs: this.eventTiming.workingDurationMs,
      pendingExtensionUiRequests: [...this.pendingExtensionUiRequests.values()], ...(geoInteraction ? { geoInteraction } : {}) };
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
    this.events.handleEvent(msg);
  }

  handleResponse(resp: PiRpcMessage) {
    const synced = this.updateStateFromResponse(resp);
    if (synced) void synced.then(() => this.transport.resolve(resp), (error) => this.transport.resolve({ ...resp, success: false, error: String(error) }));
    else this.transport.resolve(resp);
    this.manager.broadcast({ type: 'event', sessionId: this.id, event: resp });
  }

  updateStateFromResponse(resp: PiRpcMessage) {
    if (resp.success === false) return;
    const data: PiRpcPayload = resp.data || resp.result || resp;
    const command = resp.command || data.command;
    if (data.sessionFile) {
      if (!this.acceptSessionFile(data.sessionFile)) return;
      if (this.sessionFile && path.resolve(this.sessionFile) !== path.resolve(data.sessionFile)) this.capabilityTracker.invalidateObservation(true);
      this.sessionFile = data.sessionFile;
      this.persistPendingSessionName();
      this.events.reconcileProjection();
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
    const switching = command === 'set_model' || command === 'cycle_model';
    if (switching) {
      const confirmed = normalizeModel(data.model ?? (data.provider && data.id ? data : null));
      if (confirmed?.provider && confirmed.id) {
        this.model = confirmed;
        this.modelSpec = modelLabel(confirmed);
        if (this.contextUsage) this.contextUsage = { ...this.contextUsage, contextWindow: confirmed.contextWindow, percent: undefined };
      }
    }
    const synced = this.lifecycle?.sync(this);
    if (switching && synced) return synced.finally(() => this.touch(true));
    void synced?.catch((error) => logHostError('session_sync_failed', error, { sessionId: this.id }));
    this.touch(true);
  }

  registerPendingMessage(pending: PiRpcSession['pendingMessages'][number]) {
    if (this.pendingMessages.length >= 200) throw new Error('Pending message capacity reached');
    this.pendingMessages.push(pending);
  }

  discardPendingMessage(commandId: string) {
    const index = this.pendingMessages.findIndex((pending) => pending.commandId === commandId);
    if (index >= 0) this.pendingMessages.splice(index, 1);
  }

  abortGeoInteraction() {
    geoInteractionService.abortSession(this, 'agent_aborted');
    return this.manager.cancelJobs(this.id);
  }

  setSessionName(name: unknown) {
    const trimmed = String(name || '').trim();
    // Managed conversations use the user's Manifest title, including placeholders.
    if (!trimmed || (!this.workspaceId && isGenericSessionName(trimmed))) return false;
    this.sessionName = trimmed;
    return true;
  }

  persistPendingSessionName() {
    if (!this.sessionFile || !this.pendingSessionNamePersistence || this.persistingSessionName) return;
    // Appending before Pi's first flush would pre-create the file and make
    // Pi's exclusive create throw EEXIST; stay pending and retry later.
    if (!sessionFileReadyForNameAppend(this.sessionFile)) return;
    const name = this.pendingSessionNamePersistence;
    this.persistingSessionName = true;
    // Pi owns the Native tree and must assign the entry ID and current parent.
    void this.send({ type: 'set_session_name', name }, { timeoutMs: 5000 }).then((response) => {
      if (!response.success) throw new Error(String(response.error || 'Pi did not confirm the session name'));
      if (this.pendingSessionNamePersistence === name) this.pendingSessionNamePersistence = null;
    }).catch((error) => {
      console.error(`[Pi ${this.id}] Failed to persist session name: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.persistingSessionName = false;
      if (this.pendingSessionNamePersistence && this.pendingSessionNamePersistence !== name) this.persistPendingSessionName();
    });
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

  acceptSessionFile(file: string) {
    if (!this.reservedSessionFile || path.resolve(file) === path.resolve(this.reservedSessionFile)) return true;
    this.historyIdentityError = Object.assign(new Error('Pi changed its reserved conversation history path.'), { code: 'history_identity_mismatch', status: 409 });
    logHostError('history_identity_mismatch', this.historyIdentityError, { sessionId: this.id, conversationId: this.conversationId });
    const stop = this.manager.isRegistered(this.id, this) ? this.manager.delete(this.id, 'history_identity_mismatch') : this.terminate('history_identity_mismatch');
    void stop.catch((error) => logHostError('persistent_session_stop_failed', error, { sessionId: this.id }));
    return false;
  }
}
