import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { PI_RUNTIME_MINIMUM, appError, protocolError, type CapabilityMismatchReason, type ContractDiagnostic } from '../contracts/index.js';
import type { JsonRecord, LiveClient } from './types.js';
import type { PiRpcSession } from './sessions.js';
import type { SessionManagerDependencies } from './pi-session-runtime.js';
import { SessionJobs } from './session-jobs.js';

export class LiveSessionManager {
  sessions: Map<string, PiRpcSession>;
  clients: Set<LiveClient>;
  piVersion: string;
  liveMetadataSignatures: Map<string, string>;
  private closingSessions = new Map<string, Promise<boolean>>();
  private readonly jobs = new SessionJobs();
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
      if (client.canReceive && !client.canReceive()) continue;
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
  isRegistered(id: string, session: object) { return this.sessions.get(id) === session; }
  hasJobs(id: string) { return this.jobs.has(id); }
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
  runJob<T>(id: string, execute: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, onJob?: (jobId: string) => void) {
    const session = this.sessions.get(id);
    if (!session || session.terminating) return Promise.reject(Object.assign(new Error('Session is closing or unavailable'), { status: 409 }));
    return this.jobs.run(id, execute, signal, onJob);
  }
  cancelJobs(id: string) { return this.jobs.cancel(id); }
  async delete(id: string, reason = 'closed_by_user') {
    const closing = this.closingSessions.get(id);
    if (closing) return closing;
    const session = this.sessions.get(id);
    if (!session) return false;
    session.terminating = true;
    const termination = (async () => {
      await Promise.resolve();
      await this.cancelJobs(id);
      await session.terminate(reason);
      session.isStreaming = false;
      session.isCompacting = false;
      await session.lifecycle?.closed(session);
      const registered = this.sessions.delete(id);
      this.liveMetadataSignatures.delete(id);
      if (registered) {
        this.dependencies?.runtimeClosed?.(id);
        this.broadcast({ type: 'live_session_closed', sessionId: id, reason });
      }
      return true;
    })();
    this.closingSessions.set(id, termination);
    try { return await termination; }
    finally { this.closingSessions.delete(id); }
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
