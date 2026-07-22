const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');

import type { ChildProcess } from 'node:child_process';
import type { JsonRecord, LiveClient, ModelIdentity, PendingCommand, RpcCommand, RpcResponse } from './types.js';
import {
  BUILTIN_EXTENSION_PATHS,
  BUILTIN_SKILL_PATHS,
  PI_COMMAND,
  PROJECT_PROMPT_PATH,
  PROJECT_ROOT,
  PROJECT_SKILLS_DIR,
  TRAFFIC_DATA_DIR,
  TRAFFIC_TOOLS_DIR,
  expandHome,
} from './config.js';
import { modelLabel, normalizeModel, parseModelSpecToModel } from './model-utils.js';
import { SessionProjection } from './session-projection.js';
import {
  PI_WEB_BRIDGE_ENTRY,
  PI_RUNTIME_MINIMUM,
  acceptBridgeRevision,
  appError,
  latestPiWebBridgeEnvelopeStructured,
  matchCapabilities,
  parsePiWebBridgeEnvelopeStructured,
  protocolError,
  runtimeCapabilities,
  type CapabilityMismatchReason,
  type ContractDiagnostic,
  type PiWebBridgeEnvelope,
  type RuntimeCapabilities,
} from '../contracts/index.js';

type SpawnFn = (cmd: string, args: string[], opts: JsonRecord) => ChildProcess;
type PiMessageContent = string | Array<{ type: string; text?: string }>;
type PiMessage = { role?: string; content?: PiMessageContent; usage?: JsonRecord; model?: string };
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
};

const PROJECT_PROMPT_PLACEHOLDERS: Record<string, (cwd: string) => string> = {
  PROJECT_ROOT: () => PROJECT_ROOT,
  TASK_WORKING_DIRECTORY: (cwd) => cwd,
  PROJECT_SKILLS_DIR: () => PROJECT_SKILLS_DIR,
  TRAFFIC_TOOLS_DIR: () => TRAFFIC_TOOLS_DIR,
  TRAFFIC_DATA_DIR: () => TRAFFIC_DATA_DIR,
  PROJECT_PROMPT_PATH: () => PROJECT_PROMPT_PATH,
};

export function renderProjectPrompt(template: string, cwd: string) {
  let rendered = template;
  for (const [name, resolveValue] of Object.entries(PROJECT_PROMPT_PLACEHOLDERS)) {
    rendered = rendered.replaceAll(`{{${name}}}`, resolveValue(cwd));
  }
  const unresolved = Array.from(new Set(rendered.match(/\{\{[A-Z0-9_]+\}\}/g) || []));
  if (unresolved.length) throw new Error(`Unknown project prompt placeholders: ${unresolved.join(', ')}`);
  return rendered.trim();
}

function loadProjectPrompt(cwd: string) {
  if (!fs.existsSync(PROJECT_PROMPT_PATH)) throw new Error(`Project prompt not found: ${PROJECT_PROMPT_PATH}`);
  return renderProjectPrompt(fs.readFileSync(PROJECT_PROMPT_PATH, 'utf8'), cwd);
}

export function makeId() {
  return `tau_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function isGenericSessionName(name: unknown) {
  const normalized = String(name || '').trim().toLowerCase();
  return normalized === 'chat' || normalized === 'new chat' || normalized === 'untitled' || normalized === 'untitled chat' || normalized === 'session';
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function timestampForDirectory(date = new Date()) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('') + '-' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('');
}

function safeDirectoryName(name: unknown) {
  const cleaned = String(name || 'untitled')
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^\.+$/, 'untitled')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'untitled';
}

function createSessionWorkingDirectory(parentCwd?: string, sessionName?: string | null) {
  const explicitParent = Boolean(parentCwd);
  const parent = path.resolve(expandHome(parentCwd || path.join(process.cwd(), 'scenario')));
  if (explicitParent) {
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new Error(`Directory not found: ${parent}`);
    }
  } else {
    fs.mkdirSync(parent, { recursive: true });
  }

  const prefix = `${timestampForDirectory()}-${safeDirectoryName(sessionName)}`;
  for (let i = 1; i <= 999; i++) {
    const name = i === 1 ? prefix : `${prefix}-${i}`;
    const candidate = path.join(parent, name);
    if (fs.existsSync(candidate)) continue;
    fs.mkdirSync(candidate);
    return candidate;
  }

  throw new Error(`Cannot create unique task directory in ${parent}`);
}

export class PiRpcSession {
  manager: LiveSessionManager;
  id: string;
  cwd: string;
  modelSpec: string;
  child: ChildProcess | null;
  pid: number | null;
  createdAt: string;
  lastActiveAt: string;
  isStreaming: boolean;
  projection: SessionProjection;
  model: ModelIdentity | null;
  thinkingLevel: string;
  sessionFile: string | null;
  sessionName: string | null;
  contextUsage: JsonRecord | null;
  pending: Map<string, PendingCommand>;
  stdoutBuffer: string;
  terminating: boolean;
  exitCode: number | null;
  titleSet: boolean;
  userMessages: string[];
  capabilities: RuntimeCapabilities;
  capabilityMismatches: CapabilityMismatchReason[];
  piVersion: string;
  lastBridgeRevision: number | null;
  contractDiagnostics: ContractDiagnostic[];

  constructor(manager: LiveSessionManager, opts: { id?: string; cwd: string; modelSpec?: string; sessionFile?: string | null; entries?: JsonRecord[]; sessionName?: string | null; piVersion?: string }) {
    this.manager = manager;
    this.id = opts.id || makeId();
    this.cwd = opts.cwd;
    this.modelSpec = opts.modelSpec || '';
    this.child = null;
    this.pid = null;
    this.createdAt = new Date().toISOString();
    this.lastActiveAt = this.createdAt;
    this.isStreaming = false;
    this.projection = new SessionProjection(opts.entries || []);
    const parsed = parseModelSpecToModel(this.modelSpec);
    this.model = parsed.model;
    this.thinkingLevel = parsed.level || 'off';
    this.sessionFile = opts.sessionFile || null;
    this.sessionName = opts.sessionName || null;
    this.contextUsage = null;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.terminating = false;
    this.exitCode = null;
    this.titleSet = false;
    this.userMessages = [];
    this.piVersion = opts.piVersion || PI_RUNTIME_MINIMUM;
    this.lastBridgeRevision = null;
    this.capabilities = runtimeCapabilities(this.piVersion);
    this.capabilityMismatches = [];
    this.contractDiagnostics = [];
    this.applyLatestBridgeEnvelope();
  }

  metadata() {
    return {
      id: this.id,
      pid: this.pid,
      cwd: this.cwd,
      modelSpec: this.modelSpec,
      model: this.model,
      modelLabel: modelLabel(this.model, this.modelSpec),
      thinkingLevel: this.thinkingLevel,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
      isStreaming: this.isStreaming,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      contextUsage: this.contextUsage,
      capabilities: {
        ...this.capabilities,
        ok: this.capabilityMismatches.length === 0 && this.contractDiagnostics.length === 0,
        mismatches: this.capabilityMismatches,
        diagnostics: this.contractDiagnostics,
      },
    };
  }

  snapshot() {
    return {
      ...this.projection.snapshot(),
      session: this.metadata(),
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      isStreaming: this.isStreaming,
      sessionFile: this.sessionFile,
      sessionName: this.sessionName,
      contextUsage: this.contextUsage,
    };
  }

  get entries() {
    return this.projection.entries;
  }

  async start() {
    if (!fs.existsSync(this.cwd) || !fs.statSync(this.cwd).isDirectory()) {
      throw new Error(`Directory not found: ${this.cwd}`);
    }
    const args = ['--mode', 'rpc'];
    for (const extensionPath of BUILTIN_EXTENSION_PATHS) {
      if (!fs.existsSync(extensionPath)) throw new Error(`Built-in extension not found: ${extensionPath}`);
      args.push('--extension', extensionPath);
    }
    for (const skillPath of BUILTIN_SKILL_PATHS) {
      if (!fs.existsSync(skillPath)) throw new Error(`Built-in skill not found: ${skillPath}`);
      args.push('--skill', skillPath);
    }
    args.push('--append-system-prompt', loadProjectPrompt(this.cwd));
    if (this.sessionFile) args.push('--session', this.sessionFile);
    if (this.modelSpec) args.push('--model', this.modelSpec);
    const spawnFn: SpawnFn = _spawnPiForTest || spawn;
    const child = spawnFn(PI_COMMAND, args, {
      cwd: this.cwd,
      env: { ...process.env, TAU_DISABLED: '1' },
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
    const id = command.id || `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const outbound = { ...command, id };
    delete outbound.sessionId;
    const timeoutMs = opts.timeoutMs ?? 60000;
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC command timed out: ${outbound.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, command: outbound.type });
      try {
        child.stdin!.write(JSON.stringify(outbound) + '\n', (err: Error | null | undefined) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err);
          }
        });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
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
    const id = resp.id;
    if (id && this.pending.has(id)) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(resp);
      }
    }
    this.updateStateFromResponse(resp);
    this.manager.broadcast({ type: 'event', sessionId: this.id, event: resp });
  }

  updateStateFromResponse(resp: PiRpcMessage) {
    const data: PiRpcPayload = resp.data || resp.result || resp;
    const command = resp.command || data.command;
    if (data.sessionFile) {
      this.sessionFile = data.sessionFile;
      this.reconcileProjection();
    }
    if (data.sessionName) this.setSessionName(data.sessionName);
    if (data.contextUsage) this.contextUsage = data.contextUsage;
    if (data.model) this.model = normalizeModel(data.model);
    if (data.thinkingLevel) this.thinkingLevel = data.thinkingLevel;
    if (data.level) this.thinkingLevel = data.level;
    if (data.tokens) this.contextUsage = { ...(this.contextUsage || {}), tokens: data.tokens };
    if (command === 'set_model' || command === 'cycle_model') {
      if (data.model) this.model = normalizeModel(data.model);
      else if (data.provider && data.id) this.model = normalizeModel(data);
    }
    this.touch(true);
  }

  handleEvent(event: PiRpcMessage) {
    this.touch(false);
    const type = event.type;
    if (type === 'agent_start' || type === 'turn_start') this.isStreaming = true;
    // agent_end is only a single low-level run. Keep the live session marked
    // busy while Pi is about to retry; agent_settled is the final boundary.
    if (type === 'agent_end' && event.willRetry !== true) this.isStreaming = false;
    if (type === 'agent_settled') this.isStreaming = false;
    if (event.contextUsage) this.contextUsage = event.contextUsage;
    if (event.sessionFile) this.sessionFile = event.sessionFile;
    if (type === 'session_name' && event.name) {
      if (!this.setSessionName(event.name)) return;
      event.name = this.sessionName || event.name;
    }

    if ((type === 'message_start' || type === 'message_end') && event.message) {
      this.trackMessage(event.message, type);
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
    if (type === 'agent_end') this.reconcileProjection();

    this.manager.broadcast({ type: 'event', sessionId: this.id, event });
    this.manager.broadcastUpdated(this.id);
  }

  applyBridgePayload(value: unknown) {
    const result = parsePiWebBridgeEnvelopeStructured(value);
    if (!result.ok) {
      this.contractDiagnostics = result.diagnostics;
      this.manager.broadcastContractDiagnostic(this.id, result.diagnostics);
      return;
    }
    this.applyBridgeEnvelope(result.value);
  }

  applyLatestBridgeEnvelope() {
    const hasBridgeEntry = this.projection.entries.some((entry) => entry.type === 'custom' && entry.customType === PI_WEB_BRIDGE_ENTRY);
    if (!hasBridgeEntry) {
      this.refreshCapabilities(null);
      return;
    }
    const result = latestPiWebBridgeEnvelopeStructured(this.projection.entries);
    if (!result.ok) {
      this.contractDiagnostics = result.diagnostics;
      return;
    }
    this.applyBridgeEnvelope(result.value);
  }

  applyBridgeEnvelope(envelope: PiWebBridgeEnvelope) {
    const verdict = acceptBridgeRevision(this.lastBridgeRevision, envelope);
    if (!verdict.accepted) {
      console.warn(`[Pi ${this.id}] ${verdict.diagnostic?.message ?? 'bridge revision regression ignored'}`);
      return;
    }
    if (envelope.model) this.model = envelope.model;
    this.thinkingLevel = envelope.thinkingLevel;
    this.lastBridgeRevision = envelope.revision;
    this.contractDiagnostics = [];
    this.refreshCapabilities(envelope);
  }

  refreshCapabilities(envelope: PiWebBridgeEnvelope | null) {
    if (!envelope) {
      this.capabilityMismatches = [];
      this.capabilities = runtimeCapabilities(this.piVersion);
      return;
    }
    const match = matchCapabilities({ ...envelope.capabilities, piVersion: this.piVersion });
    this.capabilities = match.capabilities;
    this.capabilityMismatches = match.ok ? [] : match.mismatches;
    if (this.capabilityMismatches.length) {
      this.manager.broadcastCapabilityDiagnostic(this.id, this.capabilityMismatches);
    }
  }

  reconcileProjection() {
    if (!this.projection.reconcile(this.sessionFile)) return false;
    this.applyLatestBridgeEnvelope();
    return true;
  }

  trackMessage(message: PiMessage, eventType: string) {
    if (message.role === 'user' && eventType === 'message_start') {
      const text = this.messageText(message);
      if (text) this.userMessages.push(text.slice(0, 300));
      this.projection.appendMessage(message as JsonRecord);
      this.maybeTitle();
    } else if (message.role !== 'user' && eventType === 'message_end') {
      this.projection.appendMessage(message as JsonRecord);
    }
  }

  messageText(message: PiMessage) {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) return message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return '';
  }

  setSessionName(name: unknown) {
    const trimmed = String(name || '').trim();
    if (!trimmed || isGenericSessionName(trimmed)) return false;
    this.sessionName = trimmed;
    return true;
  }

  maybeTitle() {
    if (this.titleSet || (this.sessionName && !isGenericSessionName(this.sessionName)) || this.userMessages.length < 1) return;
    const msg = this.userMessages.find((m) => m.trim().length > 8) || this.userMessages[0];
    if (!msg) return;
    let title = msg.replace(/^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i, '').replace(/\n.*/s, '').trim();
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) title = title.slice(0, sentenceEnd);
    if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, '') + '…';
    title = title.charAt(0).toUpperCase() + title.slice(1);
    this.sessionName = title || null;
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
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Session terminated: ${reason}`));
    }
    this.pending.clear();
    if (!this.child || this.child.exitCode !== null) return;
    try { this.child.kill('SIGTERM'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      try { this.child.kill('SIGKILL'); } catch {}
    }
  }

  handleExit(code: number | null, signal: string | null, err?: { message?: string }) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err || new Error(`Pi process exited (${signal || code})`));
    }
    this.pending.clear();
    this.manager.removeExited(this.id, err?.message || `process_exit:${signal || code}`);
  }
}

export class LiveSessionManager {
  sessions: Map<string, PiRpcSession>;
  clients: Set<LiveClient>;
  pendingResumes: Map<string, Promise<PiRpcSession>>;
  terminatingResumes: Map<string, Promise<void>>;
  piVersion: string;

  constructor() {
    this.sessions = new Map();
    this.clients = new Set();
    this.pendingResumes = new Map();
    this.terminatingResumes = new Map();
    this.piVersion = PI_RUNTIME_MINIMUM;
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
    if (s) this.broadcast({ type: 'live_session_updated', session: s.metadata() });
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
  async create({ cwd, model, sessionName }: { cwd?: string; model?: string; sessionName?: string | null }) {
    const resolved = createSessionWorkingDirectory(cwd, sessionName);
    const session = new PiRpcSession(this, { cwd: resolved, modelSpec: (model || '').trim(), sessionName, piVersion: this.piVersion });
    await session.start();
    this.sessions.set(session.id, session);
    this.broadcast({ type: 'live_session_created', session: session.metadata() });
    return session;
  }
  async resume({ sessionFile, cwd, model, entries, sessionName }: { sessionFile: string; cwd: string; model?: string; entries?: JsonRecord[]; sessionName?: string | null }) {
    const resolved = path.resolve(sessionFile);
    const existing = this.findBySessionFile(resolved);
    if (existing) return existing;
    const pending = this.pendingResumes.get(resolved);
    if (pending) return pending;
    const resumePromise = (async () => {
      try {
        const terminating = this.terminatingResumes.get(resolved);
        if (terminating) await terminating.catch(() => {});
        const afterTerminationExisting = this.findBySessionFile(resolved);
        if (afterTerminationExisting) return afterTerminationExisting;
        const session = new PiRpcSession(this, { cwd, modelSpec: (model || '').trim(), sessionFile: resolved, entries, sessionName, piVersion: this.piVersion });
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
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
    await termination;
    return true;
  }
  removeExited(id: string, reason: string) {
    if (!this.sessions.has(id)) return;
    this.sessions.delete(id);
    this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
  }
  async shutdown() {
    const sessions = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.allSettled(sessions.map((s) => s.terminate('server_shutdown')));
  }
}


export const liveManager = new LiveSessionManager();
let _spawnPiForTest: SpawnFn | null = null;
export function _setSpawnPiForTest(fn: SpawnFn | null | undefined) { _spawnPiForTest = fn || null; }
