import fs from 'node:fs';
import path from 'node:path';
import type { ConversationRecordV1, ResolvedSessionPlanV3 } from '../contracts/index.js';
import { WorkspaceStore, workspaceMetadataPath } from './workspace-store.js';
import { WorkspaceRuntimeGate, type WorkspaceRuntimeLease } from './workspace-runtime.js';
import { LiveSessionManager, PiRpcSession, type PersistentSessionLifecycle } from './sessions.js';
import { SessionProjection, readSessionFileEntries } from './session-projection.js';
import { TimingMetricsStore } from './timing-metrics.js';
import { readAttachmentMessageRefs } from './session-attachments.js';
import { geoInteractionService } from './geo-interaction-service.js';
import { restoreCanvasContextMessage } from './canvas-service.js';
import { logHostError } from './diagnostic-log.js';

type Options = {
  store: WorkspaceStore;
  sessions: LiveSessionManager;
  gate: WorkspaceRuntimeGate;
  verifyPlan(plan: ResolvedSessionPlanV3, directory: string, modelSpec: string | null): ResolvedSessionPlanV3 | Promise<ResolvedSessionPlanV3>;
  assertReady(workspaceId: string): void;
};
type Instance = { session: PiRpcSession; lease: WorkspaceRuntimeLease; started: boolean; syncing: Promise<unknown>; failure: ConversationRecordV1['lastStartFailure'] };
const failure = (code: string, message: string, details: object = {}) => Object.assign(new Error(message), { code, status: 409, ...details });

/** Logical conversation lifecycle. Browsing never acquires a runtime or sends RPC. */
export class ConversationRuntime {
  private instances = new Map<string, Instance>();
  private activations = new Map<string, { promise: Promise<PiRpcSession>; directory: string; cancel: () => void }>();
  private failedStarts = new Map<string, { lease: WorkspaceRuntimeLease; failure: NonNullable<ConversationRecordV1['lastStartFailure']> }>();
  private stopping = false;
  constructor(private options: Options) {}
  private resolve(conversationId: string) {
    const target = this.options.store.findConversation(conversationId);
    this.options.assertReady(target.manifest.id);
    if (['deleting', 'deleted'].includes(target.conversation.state)) throw failure('conversation_missing', 'Conversation has been deleted or is being deleted.');
    return target;
  }
  private current(session: PiRpcSession) {
    const instance = this.instances.get(session.conversationId);
    return !!instance && instance.session === session && instance.lease.generation === session.lifecycle?.lease.generation;
  }
  private sync(session: PiRpcSession) {
    const instance = this.instances.get(session.conversationId);
    if (!instance || instance.session !== session) return Promise.resolve();
    const operation = instance.syncing.catch(() => {}).then(async () => {
      if (!this.current(session)) return;
      const target = this.options.store.findConversation(session.conversationId);
      const history = instance.failure ? target.conversation.history : { key: target.conversation.history.key, headerId: this.options.store.inspectHistory(target.directory, target.conversation).headerId };
      await this.options.store.updateRuntime(target.manifest.id, session.conversationId, {
        state: instance.failure ? 'start-failed' : instance.started || target.conversation.state === 'ready' ? 'ready' : target.conversation.state,
        history, modelSpec: session.modelSpec || target.conversation.modelSpec, lastStartFailure: instance.failure || (instance.started ? null : target.conversation.lastStartFailure),
      }, () => this.current(session));
      if (target.conversation.name !== session.sessionName) { session.setSessionName(target.conversation.name); session.pendingSessionNamePersistence = target.conversation.name; }
    });
    instance.syncing = operation;
    operation.catch((error) => logHostError('conversation_state_sync_failed', error, { conversationId: session.conversationId, sessionId: session.id }));
    return operation;
  }
  private busy(session: PiRpcSession) {
    return session.isStreaming || session.isCompacting || session.pendingExtensionUiRequests.size > 0 || session.piQueue.steering.length > 0 || session.piQueue.followUp.length > 0 || session.pendingMessages.length > 0 || this.options.sessions.hasJobs(session.id) || session.transport.pendingCount > 0;
  }
  private async requireIdle(session: PiRpcSession) {
    const occupied = () => failure('workspace_busy', 'The workspace conversation is busy. Return to it or explicitly stop it before switching.', { conversationId: session.conversationId, liveSessionId: session.id });
    if (this.busy(session)) throw occupied();
    const response = await session.send({ type: 'get_state' }, { timeoutMs: 5000 });
    const state = response.data as { isStreaming?: boolean; isCompacting?: boolean; pendingMessageCount?: number } | undefined;
    if (!response.success || typeof state?.isStreaming !== 'boolean' || typeof state.isCompacting !== 'boolean' || typeof state.pendingMessageCount !== 'number') throw failure('process_stop_unconfirmed', 'Pi idle state could not be verified.');
    if (state.isStreaming || state.isCompacting || state.pendingMessageCount || this.busy(session)) throw occupied();
  }
  private async stop(session: PiRpcSession, reason: string) {
    const lease = session.lifecycle!.lease;
    try {
      lease.stopping();
      if (this.options.sessions.get(session.id) === session) await this.options.sessions.delete(session.id, reason);
      else {
        await this.options.sessions.cancelJobs(session.id); await session.terminate(reason);
        await session.lifecycle!.closed(session);
      }
    } catch (error) {
      try { lease.unconfirmed(); } catch {}
      logHostError('conversation_stop_unconfirmed', error, { conversationId: session.conversationId, sessionId: session.id });
      throw failure('process_stop_unconfirmed', 'Stop or persistence could not be confirmed. Retry closing the conversation or open runtime diagnostics.');
    }
  }
  activate(conversationId: string, stopCurrent = false): Promise<PiRpcSession> {
    const existing = this.activations.get(conversationId); if (existing) return existing.promise;
    if (this.stopping) return Promise.reject(failure('system_not_ready', 'Host is shutting down.'));
    const target = this.resolve(conversationId);
    const controller = new AbortController();
    const operation = this.options.gate.serialize(target.directory, async () => {
      controller.signal.throwIfAborted();
      const current = this.resolve(conversationId);
      if (this.stopping) throw failure('system_not_ready', 'Host is shutting down.');
      const running = [...this.options.sessions.sessions.values()].find((session) => fs.existsSync(session.cwd) && fs.realpathSync(session.cwd) === fs.realpathSync(current.directory));
      if (running?.conversationId === conversationId && !running.terminating) return running;
      if (current.conversation.privateState !== 'isolated') throw failure('private_state_ambiguous', 'Review this conversation private-state migration before activation.');
      let abortPreflight!: () => void;
      const cancellation = new Promise<never>((_, reject) => {
        abortPreflight = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abortPreflight, { once: true });
      });
      let plan: ResolvedSessionPlanV3;
      try {
        plan = await Promise.race([Promise.resolve().then(() => this.options.verifyPlan(this.options.store.readPlan(current.directory, current.conversation), current.directory, current.conversation.modelSpec)), cancellation]);
      } finally { controller.signal.removeEventListener('abort', abortPreflight); }
      controller.signal.throwIfAborted();
      const history = this.options.store.inspectHistory(current.directory, current.conversation);
      if (running) {
        if (!running.lifecycle) throw failure('workspace_busy', 'An unregistered runtime still owns the workspace; close it before activation.');
        if (running.terminating && !stopCurrent) throw failure('process_stop_unconfirmed', 'A previous close is unconfirmed; retry closing it before switching.', { conversationId: running.conversationId });
        if (!stopCurrent) await this.requireIdle(running);
        controller.signal.throwIfAborted();
        await this.stop(running, stopCurrent ? 'explicit_switch' : 'idle_switch');
      }
      controller.signal.throwIfAborted();
      const lease = this.options.gate.take(current.directory, current.manifest.id, conversationId);
      let session: PiRpcSession | undefined;
      try {
        fs.mkdirSync(this.options.store.sessionsDirectory, { recursive: true, mode: 0o700 });
        fs.mkdirSync(path.dirname(workspaceMetadataPath(fs.realpathSync(this.options.store.sessionsDirectory), current.conversation.history.key)), { recursive: true, mode: 0o700 });
        const lifecycle: PersistentSessionLifecycle = {
          lease,
          isCurrent: (source) => this.current(source),
          isReady: (source) => this.current(source) && !!this.instances.get(source.conversationId)?.started,
          sync: (source) => { void this.sync(source); },
          closed: async (source) => {
            if (!this.current(source)) return;
            const instance = this.instances.get(source.conversationId)!;
            if (!instance.started && !instance.failure) instance.failure = { code: 'pi_start_failed', message: 'Pi stopped before activation completed.', at: new Date().toISOString() };
            await this.sync(source); lease.finish(); this.instances.delete(source.conversationId);
          },
        };
        session = new PiRpcSession(this.options.sessions, { cwd: current.directory, workspaceId: current.manifest.id, conversationId, citationRegistryId: current.manifest.citationRegistryId, sessionFile: history.file, sessionName: current.conversation.name, modelSpec: current.conversation.modelSpec || '', appendSystemPrompt: current.conversation.appendSystemPrompt, entries: history.sessionFile ? readSessionFileEntries(history.sessionFile) : [], resolvedSessionPlan: plan, piVersion: this.options.sessions.piVersion, lifecycle });
        const instance: Instance = { session, lease, started: false, syncing: Promise.resolve(), failure: null }; this.instances.set(conversationId, instance);
        await this.options.sessions.startInstance(session);
        const state = await session.send({ type: 'get_state' }, { timeoutMs: 10000 });
        controller.signal.throwIfAborted();
        if (!state.success || session.terminating) throw failure('pi_start_failed', 'Pi did not establish this conversation.');
        instance.started = true; lease.running(); await this.sync(session);
        controller.signal.throwIfAborted();
        this.options.sessions.broadcast({ type: 'live_session_created', session: session.metadata() });
        return session;
      } catch (error) {
        if (session && !this.current(session)) throw error; // Exit cleanup already committed and released this generation.
        const problem = error as Error & { code?: string };
        const detail = { code: problem.code || 'pi_start_failed', message: problem.message.slice(0, 4000), at: new Date().toISOString() };
        if (!session) this.failedStarts.set(conversationId, { lease, failure: detail });
        try {
          if (session) {
            const instance = this.instances.get(conversationId)!;
            instance.failure = detail; await this.stop(session, 'start_failed');
          } else {
            await this.options.store.updateRuntime(current.manifest.id, conversationId, { state: 'start-failed', history: current.conversation.history, modelSpec: current.conversation.modelSpec, lastStartFailure: detail });
            lease.finish(); this.failedStarts.delete(conversationId);
          }
        } catch (cleanup) {
          try { lease.unconfirmed(); } catch {}
          logHostError('conversation_start_cleanup_failed', cleanup, { conversationId });
          throw failure('process_stop_unconfirmed', 'Activation failed and stop or persistence could not be confirmed. Open runtime diagnostics.');
        }
        throw error;
      }
    });
    this.activations.set(conversationId, { promise: operation, directory: target.directory, cancel: () => controller.abort(failure('activation_cancelled', 'Conversation activation was cancelled.')) });
    operation.finally(() => { if (this.activations.get(conversationId)?.promise === operation) this.activations.delete(conversationId); }).catch(() => {});
    return operation;
  }
  close(conversationId: string, stopRunning = false) {
    this.activations.get(conversationId)?.cancel();
    const target = this.resolve(conversationId), starting = this.instances.get(conversationId);
    if (starting && !starting.started) starting.session.cancelStart();
    return this.options.gate.serialize(target.directory, async () => {
      const failed = this.failedStarts.get(conversationId);
      if (failed) {
        await this.options.store.updateRuntime(target.manifest.id, conversationId, { state: 'start-failed', history: target.conversation.history, modelSpec: target.conversation.modelSpec, lastStartFailure: failed.failure });
        failed.lease.finish(); this.failedStarts.delete(conversationId);
      }
      const instance = this.instances.get(conversationId);
      if (!instance) return { closed: true };
      if (!stopRunning && !instance.session.terminating) await this.requireIdle(instance.session);
      await this.stop(instance.session, 'closed_by_user');
      return { closed: true };
    });
  }
  /** Deletion owns the same queue from confirmed shutdown through its final stage commit. */
  withWorkspaceStopped<T>(directory: string, stopRunning: boolean, execute: () => Promise<T>) {
    const matches = (candidate: string) => path.resolve(candidate) === path.resolve(directory);
    for (const activation of this.activations.values()) if (matches(activation.directory)) activation.cancel();
    for (const instance of this.instances.values()) if (matches(instance.session.cwd) && !instance.started) instance.session.cancelStart();
    return this.options.gate.serialize(directory, async () => {
      for (const instance of this.instances.values()) if (matches(instance.session.cwd)) {
        if (!stopRunning && !instance.session.terminating) await this.requireIdle(instance.session);
        await this.stop(instance.session, 'workspace_deletion');
      }
      for (const [id, failed] of this.failedStarts) if (matches(failed.lease.directory)) {
        const target = this.options.store.findConversation(id);
        await this.options.store.updateRuntime(target.manifest.id, id, { state: 'start-failed', history: target.conversation.history, modelSpec: target.conversation.modelSpec, lastStartFailure: failed.failure });
        failed.lease.finish(); this.failedStarts.delete(id);
      }
      return execute();
    });
  }
  snapshot(conversationId: string) {
    const target = this.resolve(conversationId), instance = this.instances.get(conversationId);
    const history = this.options.store.inspectHistory(target.directory, target.conversation);
    const active = instance?.started && this.options.sessions.get(instance.session.id) === instance.session ? instance.session : null;
    const rows = history.sessionFile ? readSessionFileEntries(history.sessionFile).map(restoreCanvasContextMessage) : [];
    const snapshot = active ? active.snapshot() : new SessionProjection(new TimingMetricsStore(target.directory, conversationId).enrichEntries(rows), readAttachmentMessageRefs(target.directory, conversationId), geoInteractionService.readMessageRefs(target.directory, conversationId)).snapshot();
    return { workspace: { id: target.manifest.id, path: target.directory, name: target.manifest.name, revision: target.manifest.revision, defaultsRevision: target.manifest.defaultsRevision }, conversation: target.conversation, snapshot, runtime: active?.metadata() ?? null, ...this.options.sessions.clock() };
  }
  async shutdown() {
    this.stopping = true;
    for (const activation of this.activations.values()) activation.cancel();
    for (const instance of this.instances.values()) if (!instance.started) instance.session.cancelStart();
    await Promise.allSettled([...this.activations.values()].map((activation) => activation.promise));
    const results = await Promise.allSettled([...this.instances.keys(), ...this.failedStarts.keys()].map((id) => this.close(id, true)));
    await this.options.sessions.shutdown();
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Some persistent conversations could not be closed.');
  }
}
