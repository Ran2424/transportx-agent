const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');

import type { ChildProcess } from 'node:child_process';
import type { JsonRecord, LiveClient, ModelIdentity, RpcCommand, RpcResponse } from './types.js';
import {
  DEFAULT_DOMAIN_ID,
  PI_COMMAND,
  SESSION_ASSEMBLER,
  sessionAssemblerForProfile,
} from './config.js';
import { normalizeModel, parseModelSpecToModel } from './model-utils.js';
import type { SessionService } from './session-service.js';
import { readSessionFileEntries, SessionProjection } from './session-projection.js';
import { readAttachmentMessageRefs, recordAttachmentMessageRefs } from './session-attachments.js';
import { TimingMetricsStore } from './timing-metrics.js';
import { PiRpcTransport } from './pi-rpc-transport.js';
import { signalProcessTree } from './process-tree.js';
import type { ResolvedSessionPlan } from './session-assembly.js';
import { buildSessionPiLaunch } from './session-pi-launch.js';
import { createSessionWorkingDirectory, makeSessionId } from './session-workspace.js';
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

let citationEndpoint = process.env.TAU_CITATION_ENDPOINT || '';
export function setCitationEndpoint(value: string) { citationEndpoint = value; }
let spatialEndpoint = process.env.TAU_SPATIAL_ENDPOINT || '';
export function setSpatialEndpoint(value: string) { spatialEndpoint = value; }
let videoEndpoint = process.env.TAU_VIDEO_ENDPOINT || '';
export function setVideoEndpoint(value: string) { videoEndpoint = value; }
let geoEndpoint = process.env.TAU_GEO_ENDPOINT || '';
export function setGeoEndpoint(value: string) { geoEndpoint = value; }

export class PiRpcSession {
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
  terminating: boolean;
  exitCode: number | null;
  titleSet: boolean;
  pendingSessionNamePersistence: string | null;
  userMessages: string[];
  piVersion: string;
  capabilityTracker: SessionCapabilityTracker;
  resolvedSessionPlan: ResolvedSessionPlan | null;
  pendingAttachmentRefs: string[][];
  pendingGeoContextRefs: string[][];
  activeGeoContextIds: string[];
  serviceTokens: Record<SessionService, string>;
  citationRegistryId: string;
  pendingExtensionUiRequests: Map<string, PiRpcMessage>;
  timingMetrics: TimingMetricsStore;
  eventTiming: SessionEventTiming;

  constructor(manager: LiveSessionManager, opts: { id?: string; cwd: string; modelSpec?: string; appendSystemPrompt?: string; sessionFile?: string | null; entries?: JsonRecord[]; sessionName?: string | null; piVersion?: string; resolvedSessionPlan?: ResolvedSessionPlan | null }) {
    this.manager = manager;
    this.id = opts.id || makeSessionId();
    this.cwd = opts.cwd;
    this.modelSpec = opts.modelSpec || '';
    this.appendSystemPrompt = opts.appendSystemPrompt || '';
    this.child = null;
    this.pid = null;
    this.createdAt = new Date().toISOString();
    this.lastActiveAt = this.createdAt;
    this.isStreaming = false;
    this.isCompacting = false;
    this.autoCompactionEnabled = true;
    this.timingMetrics = new TimingMetricsStore(this.cwd);
    this.projection = new SessionProjection(this.timingMetrics.enrichEntries(opts.entries || []), readAttachmentMessageRefs(this.cwd), geoInteractionService.readMessageRefs(this.cwd));
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
    this.pendingSessionNamePersistence = !opts.sessionFile && this.sessionName ? this.sessionName : null;
    this.userMessages = [];
    this.piVersion = opts.piVersion || PI_RUNTIME_MINIMUM;
    this.capabilityTracker = new SessionCapabilityTracker(this.piVersion);
    this.resolvedSessionPlan = opts.resolvedSessionPlan || null;
    this.pendingAttachmentRefs = [];
    this.pendingGeoContextRefs = [];
    this.activeGeoContextIds = [];
    this.serviceTokens = { citation: crypto.randomUUID(), spatial: crypto.randomUUID(), video: crypto.randomUUID(), geo: crypto.randomUUID() };
    this.citationRegistryId = existingCitationRegistryId(this.cwd) || this.id;
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
    return { ...snapshot, ...(geoInteraction ? { geoInteraction } : {}) };
  }

  get entries() {
    return this.projection.entries;
  }

  async start() {
    if (!fs.existsSync(this.cwd) || !fs.statSync(this.cwd).isDirectory()) {
      throw new Error(`Directory not found: ${this.cwd}`);
    }
    if (!this.resolvedSessionPlan) throw new Error('A resolved Module session plan is required to start Pi.');
    const launch = buildSessionPiLaunch({
      cwd: this.cwd,
      sessionId: this.id,
      sessionFile: this.sessionFile,
      modelSpec: this.modelSpec,
      appendSystemPrompt: this.appendSystemPrompt,
      resolvedSessionPlan: this.resolvedSessionPlan,
      serviceTokens: this.serviceTokens,
      endpoints: { citation: citationEndpoint, spatial: spatialEndpoint, video: videoEndpoint, geo: geoEndpoint },
    });
    const spawnFn: SpawnFn = _spawnPiForTest || spawn;
    const child = spawnFn(PI_COMMAND, launch.args, {
      cwd: this.cwd,
      env: launch.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.pid = child.pid || null;

    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.handleStdout(chunk));
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) console.error(`[Pi ${this.id}] ${line}`);
    });
    child.on('error', (err: Error) => this.handleExit(null, null, err));
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => this.handleExit(code, signal));

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

    // Give Pi a moment to enter RPC mode, then establish its canonical startup
    // state once. This discovers the session file so the projection can ingest
    // startup bridge entries; unlike the old implementation, prompts do not
    // trigger repeated get_state polling.
    setTimeout(() => {
      this.send({ type: 'get_state' }, { timeoutMs: 5000 }).catch(() => {});
      this.send({ type: 'get_session_stats' }, { timeoutMs: 5000 }).catch(() => {});
    }, 250);
  }

  send(command: RpcCommand, opts: { timeoutMs?: number } = {}) {
    const child = this.child;
    if (!child || !child.stdin!.writable || this.terminating) {
      return Promise.reject(new Error('Pi RPC session is not running'));
    }
    return this.transport.send(child.stdin!, command, opts);
  }

  handleStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) this.handleLine(line);
  }

  handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch { console.log(`[Pi ${this.id}] ${trimmed}`); return; }
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
      this.sessionFile = data.sessionFile;
      this.persistPendingSessionName();
      this.reconcileProjection();
    }
    if (data.sessionName) this.setSessionName(data.sessionName);
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
  }

  handleEvent(event: PiRpcMessage) {
    this.touch(false);
    const type = event.type;
    const now = Date.now();
    if (type === 'thinking_level_changed') {
      const level = typeof event.thinkingLevel === 'string' ? event.thinkingLevel : typeof event.level === 'string' ? event.level : '';
      if (level) {
        this.thinkingLevel = level;
        this.touch(true);
      }
    }
    this.eventTiming.apply(event, now);
    if (type === 'extension_ui_request' && typeof event.id === 'string' && event.id) this.pendingExtensionUiRequests.set(event.id, event);
    if (type === 'agent_start' || type === 'turn_start') this.isStreaming = true;
    if (type === 'compaction_start' || type === 'auto_compaction_start') this.isCompacting = true;
    if (type === 'compaction_end' || type === 'auto_compaction_end') {
      this.isCompacting = false;
      const result = event.result && typeof event.result === 'object' ? event.result as JsonRecord : null;
      this.contextUsage = contextUsageAfterCompaction(this.contextUsage, this.model?.contextWindow, result?.estimatedTokensAfter);
      this.reconcileProjection();
    }
    if (type === 'agent_settled') {
      this.isStreaming = false;
      this.pendingExtensionUiRequests.clear();
      // ===== 修复 BEGIN：第二条消息起全部卡死（EEXIST）=====
      // run 结束时 Pi 已完成首次落盘，是重试写入会话名称的可靠时机。
      this.persistPendingSessionName();
      // ===== 修复 END =====
      this.send({ type: 'get_session_stats' }, { timeoutMs: 5000 }).catch(() => {});
    }
    if (event.contextUsage) this.contextUsage = event.contextUsage;
    if (event.sessionFile) {
      this.sessionFile = event.sessionFile;
      this.persistPendingSessionName();
    }
    if (type === 'session_name' && event.name) {
      if (!this.setSessionName(event.name)) return;
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
      if (appendedEntry.customType === PI_WEB_BRIDGE_ENTRY) this.applyBridgePayload(appendedEntry.data);
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

  applyBridgePayload(value: unknown) {
    this.applyCapabilityUpdate(this.capabilityTracker.applyPayload(value), true);
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
    this.projection.replace(this.timingMetrics.enrichEntries(readSessionFileEntries(this.sessionFile)));
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
      const attachmentIds = this.pendingAttachmentRefs.shift() || [];
      const geoContextIds = this.pendingGeoContextRefs.shift() || [];
      const enriched = attachmentIds.length
        ? { ...message, attachmentIds, ...(geoContextIds.length ? { geoContextIds } : {}), content: typeof message.content === 'string' ? text : message.content?.map((block) => block.type === 'text' ? { ...block, text } : block) }
        : geoContextIds.length
        ? { ...message, geoContextIds, content: typeof message.content === 'string' ? text : message.content?.map((block) => block.type === 'text' ? { ...block, text } : block) }
        : (typeof message.content === 'string' && message.content !== text ? { ...message, content: text } : message);
      if (attachmentIds.length) recordAttachmentMessageRefs(this.cwd, { text, timestamp: typeof message.timestamp === 'number' ? message.timestamp : undefined, attachmentIds });
      if (geoContextIds.length) geoInteractionService.recordMessageRefs(this, { text, timestamp: typeof message.timestamp === 'number' || typeof message.timestamp === 'string' ? message.timestamp : undefined, contextIds: geoContextIds });
      this.projection.setMessageRefs(readAttachmentMessageRefs(this.cwd));
      this.projection.setGeoMessageRefs(geoInteractionService.readMessageRefs(this.cwd));
      this.projection.appendMessage(enriched as JsonRecord);
      this.maybeTitle();
    } else if (message.role !== 'user' && eventType === 'message_end') {
      this.projection.appendMessage(message as JsonRecord);
    }
  }

  registerPromptAttachments(attachmentIds: string[]) {
    this.pendingAttachmentRefs.push([...attachmentIds]);
  }

  discardPromptAttachments(attachmentIds: string[]) {
    for (let index = this.pendingAttachmentRefs.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingAttachmentRefs[index];
      if (pending.length === attachmentIds.length && pending.every((id, itemIndex) => id === attachmentIds[itemIndex])) {
        this.pendingAttachmentRefs.splice(index, 1);
        return;
      }
    }
  }

  registerPromptGeoContexts(contextIds: string[]) {
    this.activeGeoContextIds = [...contextIds];
    this.pendingGeoContextRefs.push([...contextIds]);
  }

  discardPromptGeoContexts(contextIds: string[]) {
    for (let index = this.pendingGeoContextRefs.length - 1; index >= 0; index -= 1) {
      const pending = this.pendingGeoContextRefs[index];
      if (pending.length === contextIds.length && pending.every((id, itemIndex) => id === contextIds[itemIndex])) {
        this.pendingGeoContextRefs.splice(index, 1);
        break;
      }
    }
    if (this.activeGeoContextIds.length === contextIds.length && this.activeGeoContextIds.every((id, index) => id === contextIds[index])) this.activeGeoContextIds = [];
  }

  messageText(message: PiMessage) {
    if (typeof message.content === 'string') return stripGeoContextPrompt(stripAttachmentContext(message.content));
    if (Array.isArray(message.content)) return stripGeoContextPrompt(stripAttachmentContext(message.content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n')));
    return '';
  }

  abortGeoInteraction() {
    geoInteractionService.abortSession(this, 'agent_aborted');
  }

  setSessionName(name: unknown) {
    const trimmed = String(name || '').trim();
    if (!trimmed || isGenericSessionName(trimmed)) return false;
    this.sessionName = trimmed;
    return true;
  }

  persistPendingSessionName() {
    if (!this.sessionFile || !this.pendingSessionNamePersistence) return;
    // ===== 修复 BEGIN：第二条消息起全部卡死（EEXIST）=====
    // 原实现见 fix-backup/sessions.ts.orig。
    // Pi 尚未完成首次 wx flush 时文件要么不存在、要么只有 session_info；
    // 此时追加会抢先创建文件，导致 Pi 首次 flush 抛 EEXIST。改为等文件
    // 含 Pi 头部（type === 'session'）后再追加；保持 pending 等待重试。
    if (!sessionFileReadyForNameAppend(this.sessionFile)) return;
    // ===== 修复 END =====
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

  async terminate(reason = 'closed') {
    if (this.terminating) return;
    this.terminating = true;
    geoInteractionService.abortSession(this, reason === 'aborted_by_user' ? 'agent_aborted' : 'session_closed');
    this.transport.rejectAll(new Error(`Session terminated: ${reason}`));
    if (!this.child || this.child.exitCode !== null) return;
    signalProcessTree(this.child, 'SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      signalProcessTree(this.child, 'SIGKILL');
    }
  }

  handleExit(code: number | null, signal: string | null, err?: { message?: string }) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    geoInteractionService.abortSession(this, 'agent_aborted');
    this.transport.rejectAll(err || new Error(`Pi process exited (${signal || code})`));
    this.manager.removeExited(this.id, err?.message || `process_exit:${signal || code}`);
  }
}

function existingCitationRegistryId(cwd: string) {
  try { return parseCitationRegistry(JSON.parse(fs.readFileSync(path.join(cwd, '.tau', 'citations.json'), 'utf8')))?.sessionId || null; }
  catch { return null; }
}

export class LiveSessionManager {
  sessions: Map<string, PiRpcSession>;
  clients: Set<LiveClient>;
  pendingResumes: Map<string, Promise<PiRpcSession>>;
  terminatingResumes: Map<string, Promise<void>>;
  piVersion: string;
  liveMetadataSignatures: Map<string, string>;

  constructor() {
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
    const payload = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }
  broadcastUpdated(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
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
  findBySessionFile(sessionFile: string) {
    const resolved = path.resolve(sessionFile);
    return Array.from(this.sessions.values()).find((s) => s.sessionFile && path.resolve(s.sessionFile) === resolved);
  }
  hasPendingResume(sessionFile: string) { return this.pendingResumes.has(path.resolve(sessionFile)); }
  hasTerminatingResume(sessionFile: string) { return this.terminatingResumes.has(path.resolve(sessionFile)); }
  async create({ cwd, model, sessionName, profile, domainId = DEFAULT_DOMAIN_ID, appendSystemPrompt = '' }: { cwd?: string; model?: string; sessionName?: string | null; profile?: SessionProfileV1; domainId?: string; appendSystemPrompt?: string }) {
    if (!model?.trim()) throw new Error('请先添加并选择模型');
    const resolved = createSessionWorkingDirectory(cwd, sessionName);
    const assembler = profile ? sessionAssemblerForProfile(profile) : SESSION_ASSEMBLER;
    const resolvedSessionPlan = assembler.assemble(domainId, resolved, profile);
    assembler.save(resolvedSessionPlan);
    const session = new PiRpcSession(this, { cwd: resolved, modelSpec: (model || '').trim(), appendSystemPrompt, sessionName, piVersion: this.piVersion, resolvedSessionPlan });
    await session.start();
    this.sessions.set(session.id, session);
    this.broadcast({ type: 'live_session_created', session: session.metadata() });
    return session;
  }
  async resume({ sessionFile, cwd, model, entries, sessionName, useCurrentConfiguration = false }: { sessionFile: string; cwd: string; model?: string; entries?: JsonRecord[]; sessionName?: string | null; useCurrentConfiguration?: boolean }) {
    const resolved = path.resolve(sessionFile);
    const existing = this.findBySessionFile(resolved);
    if (existing) return existing;
    const pending = this.pendingResumes.get(resolved);
    if (pending) return pending;
    const resumePromise = (async () => {
      try {
        await Promise.resolve();
        const terminating = this.terminatingResumes.get(resolved);
        if (terminating) await terminating.catch(() => {});
        const afterTerminationExisting = this.findBySessionFile(resolved);
        if (afterTerminationExisting) return afterTerminationExisting;
        const migratedPlanPath = path.join(cwd, '.tau', 'resolved-session-plan.v3.json');
        let resolvedSessionPlan: ResolvedSessionPlan;
        try {
          resolvedSessionPlan = SESSION_ASSEMBLER.load(cwd, fs.existsSync(migratedPlanPath) ? 'resolved-session-plan.v3.json' : 'resolved-session-plan.json');
        } catch (error) {
          if (!useCurrentConfiguration || !(error instanceof Error) || !('code' in error) || error.code !== 'legacy_plan_requires_confirmation') throw error;
          resolvedSessionPlan = SESSION_ASSEMBLER.assemble(DEFAULT_DOMAIN_ID, cwd);
          SESSION_ASSEMBLER.save(resolvedSessionPlan, 'resolved-session-plan.v3.json');
        }
        const session = new PiRpcSession(this, { cwd, modelSpec: (model || '').trim(), sessionFile: resolved, entries, sessionName, piVersion: this.piVersion, resolvedSessionPlan });
        await session.start();
        this.sessions.set(session.id, session);
        this.broadcast({ type: 'live_session_created', session: session.metadata() });
        return session;
      } finally {
        this.pendingResumes.delete(resolved);
      }
    })();
    this.pendingResumes.set(resolved, resumePromise);
    return resumePromise;
  }
  async delete(id: string, reason = 'closed_by_user') {
    const session = this.sessions.get(id);
    if (!session) return false;
    const resolvedFile = session.sessionFile ? path.resolve(session.sessionFile) : null;
    const termination = session.terminate(reason).then(() => undefined, () => undefined).finally(() => {
      if (resolvedFile && this.terminatingResumes.get(resolvedFile) === termination) this.terminatingResumes.delete(resolvedFile);
    });
    if (resolvedFile) this.terminatingResumes.set(resolvedFile, termination);
    this.sessions.delete(id);
    this.liveMetadataSignatures.delete(id);
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
    void termination;
    return true;
  }
  removeExited(id: string, reason: string) {
    if (!this.sessions.has(id)) return;
    this.sessions.delete(id);
    this.liveMetadataSignatures.delete(id);
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
  }
  async shutdown() {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    this.liveMetadataSignatures.clear();
    await Promise.allSettled(sessions.map((s) => s.terminate('server_shutdown')));
  }
}


export const liveManager = new LiveSessionManager();
let _spawnPiForTest: SpawnFn | null = null;
export function _setSpawnPiForTest(fn: SpawnFn | null | undefined) { _spawnPiForTest = fn || null; }
