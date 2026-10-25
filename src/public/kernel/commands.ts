import type { ModelRefreshError } from '../../contracts/model.js';
/**
 * Command ports (migration plan §4.2). Components never fetch(), touch the
 * WebSocket or assemble RPC JSON themselves — they call these ports.
 * Transport/HTTP failures are converted to serializable AppErrors here and
 * thrown; the kernel stores never see raw Error instances.
 */

import type { LiveSession, ConversationView, WorkspaceIndex, ModelRecord, SessionAttachment, SessionAttachmentSource, SessionSnapshot } from '../app-types.js';
import { conversationView } from '../app-types.js';
import type { CreateConversationInput, ConversationRecordV1, WorkspaceManifestV1 } from '../../contracts/workspace.js';
import type { AppAction } from './actions.js';
import { appError, toAppError, type AppError, type AppErrorCategory } from '../../contracts/errors.ts';
import type { SessionProfileV1 } from '../../contracts/session-profile.ts';
import type { ModuleArchiveInspection, ModulePresentation } from '../../contracts/module.ts';
import type { ToolDiagnostic } from '../../contracts/tool-interface.ts';
import { parseCitationEnvelope, parseCitationDetail, type CitationDetail, type CitationEnvelope } from '../../contracts/citation.ts';
import type { GeoClientContextV1, GeoContextReferenceV1, GeoInteractionResponseV1 } from '../../contracts/geo.ts';
import type { CanvasContextV1, CanvasPresentationV1 } from '../../contracts/canvas.ts';
import type { AddLocalModelInput, LocalModelConnection, LocalModelConnectionInput } from '../../contracts/local-model.ts';
export type { AddLocalModelInput, LocalModelConnection, LocalModelConnectionInput } from '../../contracts/local-model.ts';

export type HttpInit = { signal?: AbortSignal; method?: string; body?: unknown; headers?: Record<string, string> };

/** Minimal structural subset of fetch()'s Response used by the kernel. */
export type HttpResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type HttpClient = (path: string, init?: HttpInit) => Promise<HttpResponse>;

export type CommandDeps = {
  http: HttpClient;
  liveSessionId(conversationId: string): string | null;
  dispatch: (action: AppAction) => void;
  isStreaming: (sessionId: string) => boolean;
  isCompacting: (sessionId: string) => boolean;
};

export type SendPromptInput = { sessionId: string; message: string; attachmentIds?: string[]; geoContextIds?: string[]; canvasContextIds?: string[]; clientCommandId?: string };
export type SteerInput = { sessionId: string; message: string; attachmentIds?: string[]; geoContextIds?: string[]; canvasContextIds?: string[] };
export type FollowUpInput = { sessionId: string; message: string };
export type SetModelInput = { sessionId: string; model: string };
export type SetThinkingLevelInput = { sessionId: string; level: string };
export type PiModelApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
export type AddModelInput = {
  provider: string;
  modelId: string;
  api: PiModelApi;
  baseUrl: string;
  apiKey?: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  images?: boolean;
};
export type UpdateModelInput = {
  provider: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  images: boolean;
};
export type ModelProviderAccess = {
  id: string;
  name: string;
  connected: boolean;
  credentialStored: boolean;
  custom?: boolean;
  baseUrl?: string;
  api?: PiModelApi;
  authMethods: Array<'api_key' | 'oauth'>;
  authSource?: string;
  modelCount: number;
};
export type RenameSessionInput = { conversationId: string; name: string; expectedRevision: number };
export type DeletionRequest = { requestId: string; expectedRevision: number; confirm: true; stopCurrent?: boolean };
export type ExtensionUiResponseInput = {
  sessionId: string | null;
  id?: string;
  response?: Record<string, unknown>;
};

export type WorkspaceFile = {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number | null;
  mtime?: number;
};

export type WorkspaceFileContent = { content: string; size: number; encoding?: 'utf8' | 'base64'; stale?: boolean };

export type UploadAttachmentInput = { sessionId: string; file: File; source: SessionAttachmentSource };

export type AgentState = {
  model?: ModelRecord | null;
  thinkingLevel?: string;
  autoCompactionEnabled?: boolean;
  isCompacting?: boolean;
};

export type PlatformModule = {
  id: string;
  name: string;
  presentation?: ModulePresentation;
  version: string;
  type: 'module' | 'capability' | 'domain';
  origin: 'builtin' | 'installed' | 'external';
  removable: boolean;
  enabled: boolean;
  extensions: number;
  skills: number;
  nativeRuntimes?: number;
  toolDiagnostics?: ToolDiagnostic[];
  skillFiles: Array<{ entryPath: string; name: string; description?: string; content?: string; truncated?: boolean; error?: string }>;
  assets: Array<{ id: string; kind: 'knowledge' | 'data' | 'template'; configured: boolean; active: boolean; error?: string }>;
};

export type PlatformOverview = {
  storage: { root: string; scenario: string; models: string; settings: string; modules: string; logs: string };
  modules: PlatformModule[];
  errors: Array<{ moduleId?: string; message: string }>;
};

export type SessionModuleOption = {
  id: string;
  name: string;
  presentation?: ModulePresentation;
  version: string;
  type: 'module' | 'capability' | 'domain';
  origin: 'installed' | 'builtin';
  compatible: boolean;
  enabledForNewSessions: boolean;
  selectedByDefault: boolean;
  dependencies: string[];
  assets: Array<{ id: string; kind: 'knowledge' | 'data' | 'template'; configured: boolean; integrity: 'verified' | 'unverified' | 'missing' }>;
};

export type SessionOptions = { schemaVersion: 1; modules: SessionModuleOption[] };

export type AgentCommands = {
  sendPrompt(input: SendPromptInput): Promise<void>;
  abort(sessionId: string): Promise<void>;
  steer(input: SteerInput): Promise<void>;
  followUp(input: FollowUpInput): Promise<void>;
  compact(sessionId: string): Promise<void>;
  setAutoCompaction(sessionId: string, enabled: boolean): Promise<void>;
  getState(sessionId: string): Promise<AgentState>;
  setModel(input: SetModelInput): Promise<void>;
  setThinkingLevel(input: SetThinkingLevelInput): Promise<void>;
};

export type SessionCommands = {
  list(): Promise<WorkspaceIndex>;
  searchHistory(query: string): Promise<Array<{ workspaceId: string; conversationId: string; name: string; matches: Array<{ snippet?: string }> }>>;
  create(input: CreateConversationInput): Promise<ConversationView>;
  activate(conversationId: string, input?: { stopCurrent?: boolean; confirmCurrentConfiguration?: { expectedRevision: number; domainId: string; modelSpec: string; profile: SessionProfileV1 } }): Promise<ConversationView>;
  rename(input: RenameSessionInput): Promise<void>;
  loadSnapshot(conversationId: string): Promise<SessionSnapshot>;
  listFiles(conversationId: string, path?: string): Promise<{ path: string; items: WorkspaceFile[] }>;
  openInSystem(conversationId: string, path: string): Promise<void>;
  readFileContent(conversationId: string, path: string): Promise<WorkspaceFileContent>;
  listAttachments(conversationId: string): Promise<SessionAttachment[]>;
  uploadAttachment(input: UploadAttachmentInput): Promise<SessionAttachment>;
  deleteAttachment(conversationId: string, attachmentId: string): Promise<void>;
  close(conversationId: string, stopCurrent?: boolean): Promise<void>;
  deleteConversation(conversationId: string, input: DeletionRequest): Promise<void>;
  updateWorkspace(workspaceId: string, input: Record<string, unknown>): Promise<void>;
  deleteWorkspace(workspaceId: string, input: DeletionRequest): Promise<void>;
  migration(path?: string, input?: Record<string, unknown>): Promise<unknown>;
};

export type PlatformCommands = {
  getAvailableModels(sessionId?: string | null): Promise<Array<ModelRecord | string>>;
  refreshModels(sessionId?: string): Promise<{ models: Array<ModelRecord | string>; errors: ModelRefreshError[] }>;
  getModelProviders(): Promise<ModelProviderAccess[]>;
  connectModelProvider(provider: string, apiKey: string): Promise<ModelProviderAccess>;
  disconnectModelProvider(provider: string): Promise<void>;
  getSessionOptions(): Promise<SessionOptions>;
  addModel(input: AddModelInput): Promise<{ provider: string; modelId: string; reference: string }>;
  discoverLocalModels(input: LocalModelConnectionInput): Promise<LocalModelConnection>;
  addLocalModel(input: AddLocalModelInput): Promise<{ provider: string; modelId: string; reference: string }>;
  updateModel(input: UpdateModelInput): Promise<{ provider: string; modelId: string; reference: string }>;
  deleteModel(provider: string, modelId: string): Promise<void>;
  deleteModelProvider(provider: string): Promise<void>;
  getOverview(sessionId?: string): Promise<PlatformOverview>;
  openModuleDirectory(moduleId: string): Promise<void>;
  openLogsDirectory(): Promise<void>;
  installModule(sourcePath: string): Promise<PlatformOverview>;
  inspectModuleArchive(sourcePath: string): Promise<ModuleArchiveInspection>;
  installModuleArchive(importId: string, selections: Array<{ id: string; version: string }>): Promise<PlatformOverview>;
  discardModuleArchive(importId: string): Promise<void>;
  uninstallModule(moduleId: string): Promise<PlatformOverview>;
  setModuleEnabled(moduleId: string, enabled: boolean): Promise<PlatformOverview>;
  migrateLegacyModules(): Promise<PlatformOverview>;
  getAuth(): Promise<{ configured: boolean; enabled: boolean }>;
  setAuth(enabled: boolean): Promise<{ enabled: boolean }>;
};

export type ExtensionUiCommands = {
  respond(input: ExtensionUiResponseInput): Promise<void>;
};

export type CitationCommands = {
  list(sessionId: string, options?: { offset?: number; ids?: string[]; signal?: AbortSignal }): Promise<CitationEnvelope>;
  detail(sessionId: string, evidenceId: string, signal?: AbortSignal): Promise<CitationDetail>;
};

export type VideoCommands = {
  getMetrics(sessionId: string, resourceId: string): Promise<unknown>;
};

export type GeoCommands = {
  createContext(sessionId: string, context: GeoClientContextV1): Promise<GeoContextReferenceV1>;
  getContext(sessionId: string, contextId: string): Promise<GeoClientContextV1>;
  saveScreenshot(sessionId: string, input: { visualizationId: string; sceneRevision: number; dataUrl: string }): Promise<{ filename: string; path: string; bytes: number }>;
  respondScreenshot(sessionId: string, requestId: string, response: { status: 'captured'; dataUrl: string } | { status: 'failed'; reason: 'scene_revision_changed' | 'visualization_changed' | 'capture_failed' }): Promise<unknown>;
  respond(sessionId: string, requestId: string, response: { status: 'submitted'; context: GeoClientContextV1 } | { status: 'cancelled' } | { status: 'invalidated'; reason: 'scene_revision_changed' | 'visualization_changed' | 'resource_changed' }): Promise<{ response: GeoInteractionResponseV1; context?: GeoClientContextV1 }>;
};

export type CanvasCommands = {
  present(sessionId: string, input: { adapterId: string; resource: { scope: 'session-file'; path: string }; title?: string }): Promise<CanvasPresentationV1>;
  createContext(sessionId: string, input: { viewId: string; revision: number; target?: unknown; selection?: unknown }): Promise<CanvasContextV1>;
};

export type ReportCommands = {
  loadSource(sessionId: string, url: string): Promise<WorkspaceFileContent>;
  exportPdf(title: string, html: string): Promise<{ url: string }>;
};

/** fetch() wrapper: network/HTTP-status/payload errors all become AppError. */
async function httpJson(
  http: HttpClient,
  path: string,
  init: HttpInit | undefined,
  context: { category: AppErrorCategory; sessionId?: string },
): Promise<unknown> {
  let response: HttpResponse;
  try {
    response = await http(path, init);
  } catch (cause) {
    throw toAppError(cause, {
      code: 'http_network_error',
      category: 'transport',
      sessionId: context.sessionId,
      retryable: true,
      diagnostics: { path },
    });
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON body; status decides success below.
  }
  if (!response.ok) {
    const errorPayload = data as { error?: string; code?: string; report?: string; itemId?: string; conversationId?: string } | null;
    const message = errorPayload?.error ?? `HTTP ${response.status}`;
    throw appError({
      code: errorPayload?.code || 'http_error',
      category: context.category,
      message,
      sessionId: context.sessionId,
      retryable: response.status >= 500,
      diagnostics: { status: response.status, path, ...(errorPayload?.report ? { report: errorPayload.report } : {}), ...(errorPayload?.itemId ? { itemId: errorPayload.itemId } : {}), ...(errorPayload?.conversationId ? { conversationId: errorPayload.conversationId } : {}) },
    });
  }
  // RPC envelopes carry both `success` and `error`; those are interpreted by
  // rpcCommand below, not by this generic payload check.
  const isRpcEnvelope = data && typeof data === 'object' && 'success' in data;
  if (!isRpcEnvelope && data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    throw appError({
      code: 'api_error',
      category: context.category,
      message: (data as { error: string }).error,
      sessionId: context.sessionId,
      retryable: false,
      diagnostics: { path },
    });
  }
  return data;
}

async function httpText(http: HttpClient, path: string, context: { category: AppErrorCategory; sessionId?: string }) {
  let response: HttpResponse;
  try {
    response = await http(path);
  } catch (cause) {
    throw toAppError(cause, { code: 'http_network_error', category: 'transport', sessionId: context.sessionId, retryable: true, diagnostics: { path } });
  }
  if (!response.ok) {
    throw appError({ code: response.headers?.get('X-Citation-Error') || 'http_error', category: context.category, message: `HTTP ${response.status}`, sessionId: context.sessionId, retryable: response.status >= 500, diagnostics: { status: response.status, path } });
  }
  return { content: await response.text(), stale: response.headers?.get('X-Citation-Resource-Stale') === '1' };
}

async function rpcCommand(deps: CommandDeps, command: Record<string, unknown>): Promise<unknown> {
  const sessionId = command.sessionId as string | undefined;
  if (sessionId) {
    const liveSessionId = deps.liveSessionId(sessionId);
    if (!liveSessionId && !['get_available_models', 'refresh_models'].includes(String(command.type))) throw appError({ code: 'conversation_not_active', category: 'session', message: '请先激活此会话。', sessionId, retryable: false });
    command = { ...command, sessionId: liveSessionId || undefined };
  }
  const data = await httpJson(deps.http, '/api/rpc', { method: 'POST', body: command }, { category: 'session', sessionId });
  if (data && typeof data === 'object' && (data as { success?: unknown }).success === false) {
    const message = String((data as { error?: unknown }).error ?? 'RPC command failed');
    const deliveryUnknown = (data as { delivery?: string }).delivery === 'unknown' || message.startsWith('RPC command timed out:');
    throw appError({
      code: deliveryUnknown ? 'delivery_unknown' : 'rpc_command_failed',
      category: 'session',
      message,
      sessionId,
      retryable: false,
      diagnostics: { command: String(command.type) },
    });
  }
  return data;
}

function clientCommandId() {
  return globalThis.crypto?.randomUUID?.() ?? `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function createAgentCommands(deps: CommandDeps): AgentCommands {
  const pendingPromptIds = new Map<string, string>();
  return {
    async sendPrompt({ sessionId, message, attachmentIds, geoContextIds, canvasContextIds, clientCommandId: requestedId }) {
      const promptKey = `${sessionId}\0${message}\0${(attachmentIds || []).join(',')}\0${(geoContextIds || []).join(',')}\0${(canvasContextIds || []).join(',')}`;
      const commandId = requestedId || pendingPromptIds.get(promptKey) || clientCommandId();
      pendingPromptIds.set(promptKey, commandId);
      // While streaming, prompts queue per session instead of hitting the
      // transport; the kernel flushes them when the run ends.
      if (deps.isStreaming(sessionId) || deps.isCompacting(sessionId)) {
        deps.dispatch({ type: 'conversation/promptQueued', sessionId, message, attachmentIds, geoContextIds, ...(canvasContextIds?.length ? { canvasContextIds } : {}), clientCommandId: commandId });
        return;
      }
      try {
        await rpcCommand(deps, { type: 'prompt', sessionId, message, clientCommandId: commandId, ...(attachmentIds?.length ? { attachmentIds } : {}), ...(geoContextIds?.length ? { geoContextIds } : {}), ...(canvasContextIds?.length ? { canvasContextIds } : {}) });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'delivery_unknown' && code !== 'http_network_error') pendingPromptIds.delete(promptKey);
        throw error;
      }
      pendingPromptIds.delete(promptKey);
      deps.dispatch({ type: 'conversation/promptSent', sessionId, message, attachmentIds, geoContextIds, ...(canvasContextIds?.length ? { canvasContextIds } : {}) });
    },

    async abort(sessionId) {
      await rpcCommand(deps, { type: 'abort', sessionId, clientCommandId: clientCommandId() });
    },

    async steer({ sessionId, message, attachmentIds, geoContextIds, canvasContextIds }) {
      await rpcCommand(deps, { type: 'steer', sessionId, message, clientCommandId: clientCommandId(), ...(attachmentIds?.length ? { attachmentIds } : {}), ...(geoContextIds?.length ? { geoContextIds } : {}), ...(canvasContextIds?.length ? { canvasContextIds } : {}) });
    },

    async followUp({ sessionId, message }) {
      await rpcCommand(deps, { type: 'follow_up', sessionId, message, clientCommandId: clientCommandId() });
    },

    async compact(sessionId) {
      await rpcCommand(deps, { type: 'compact', sessionId });
    },

    async setAutoCompaction(sessionId, enabled) {
      await rpcCommand(deps, { type: 'set_auto_compaction', sessionId, enabled });
    },

    async getState(sessionId) {
      const data = await rpcCommand(deps, { type: 'get_state', sessionId });
      return ((data as { data?: AgentState }).data ?? {}) as AgentState;
    },

    async setModel({ sessionId, model }) {
      await rpcCommand(deps, { type: 'set_model', sessionId, model });
    },

    async setThinkingLevel({ sessionId, level }) {
      await rpcCommand(deps, { type: 'set_thinking_level', sessionId, level });
    },
  };
}

export function createSessionCommands(deps: CommandDeps): SessionCommands {
  const context = { category: 'session' as AppErrorCategory };
  const attachmentGenerations = new Map<string, number>();
  const advanceAttachments = (sessionId: string) => {
    const generation = (attachmentGenerations.get(sessionId) || 0) + 1;
    attachmentGenerations.set(sessionId, generation);
    return generation;
  };
  const commands: SessionCommands = {
    async list() {
      const index = await httpJson(deps.http, '/api/workspaces', undefined, context) as WorkspaceIndex;
      deps.dispatch({ type: 'session/indexReceived', index });
      return index;
    },
    async searchHistory(query) {
      if (query.trim().length < 2) return [];
      const data = await httpJson(deps.http, `/api/conversations/search?q=${encodeURIComponent(query.trim())}`, undefined, context);
      return (data as { results: Array<{ workspaceId: string; conversationId: string; name: string; matches: Array<{ snippet?: string }> }> }).results;
    },
    async create(input) {
      const result = await httpJson(deps.http, '/api/conversations', { method: 'POST', body: input }, context) as { directory: string; manifest: WorkspaceManifestV1; conversation: ConversationRecordV1 };
      return conversationView(result.conversation, { ...result.manifest, path: result.directory }, null);
    },
    async activate(id, input = {}) {
      const result = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(id)}/activate`, { method: 'POST', body: input }, { ...context, sessionId: id }) as { runtime: LiveSession };
      deps.dispatch({ type: 'session/runtimeReceived', runtime: result.runtime });
      const snapshot = await commands.loadSnapshot(id);
      deps.dispatch({ type: 'session/snapshotReceived', sessionId: id, snapshot });
      return snapshot.session!;
    },
    async rename({ conversationId, ...input }) {
      await httpJson(deps.http, `/api/conversations/${encodeURIComponent(conversationId)}`, { method: 'PATCH', body: input }, { ...context, sessionId: conversationId });
      deps.dispatch({ type: 'session/updated', session: { id: conversationId, sessionName: input.name } });
    },
    async loadSnapshot(id) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(id)}/snapshot`, undefined, { ...context, sessionId: id }) as { workspace: { id: string; path: string; revision: number }; conversation: ConversationRecordV1; runtime: LiveSession | null; snapshot: SessionSnapshot; hostGeneration: string; revision: number };
      return { ...data.snapshot, hostGeneration: data.hostGeneration, revision: data.revision, sessionId: id, session: conversationView(data.conversation, data.workspace, data.runtime) };
    },
    async listFiles(sessionId, path) {
      const params = new URLSearchParams();
      if (path) params.set('path', path);
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/files?${params}`, undefined, { ...context, sessionId });
      return data as { path: string; items: WorkspaceFile[] };
    },

    async readFileContent(sessionId, path) {
      const params = new URLSearchParams({ path });
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/files/content?${params}`, undefined, { ...context, sessionId });
      return data as WorkspaceFileContent;
    },

    async openInSystem(sessionId, path) {
      await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/open`, { method: 'POST', body: { path } }, { ...context, sessionId });
    },

    async listAttachments(sessionId) {
      const generation = advanceAttachments(sessionId);
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/attachments`, undefined, { ...context, sessionId });
      const attachments = (data as { attachments?: SessionAttachment[] }).attachments ?? [];
      if (attachmentGenerations.get(sessionId) === generation) deps.dispatch({ type: 'session/attachmentsReceived', sessionId, attachments });
      return attachments;
    },

    async uploadAttachment({ sessionId, file, source }) {
      const form = new FormData();
      form.append('file', file, file.name);
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/attachments?source=${encodeURIComponent(source)}`, { method: 'POST', body: form }, { ...context, sessionId });
      const attachment = (data as { attachments?: SessionAttachment[] }).attachments?.[0];
      if (!attachment) throw appError({ code: 'attachment_upload_invalid_response', category: 'transport', message: '附件上传响应无效', sessionId, retryable: false });
      advanceAttachments(sessionId);
      deps.dispatch({ type: 'session/attachmentAdded', sessionId, attachment });
      return attachment;
    },

    async deleteAttachment(sessionId, attachmentId) {
      await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }, { ...context, sessionId });
      advanceAttachments(sessionId);
      deps.dispatch({ type: 'session/attachmentRemoved', sessionId, attachmentId });
    },

    async close(sessionId, stopCurrent = false) {
      await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/close`, { method: 'POST', body: { stopCurrent } }, { ...context, sessionId });
      const liveSessionId = deps.liveSessionId(sessionId); if (liveSessionId) deps.dispatch({ type: 'session/runtimeClosed', liveSessionId });
    },
    async deleteConversation(id, input) { await httpJson(deps.http, `/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE', body: input }, context); },
    async updateWorkspace(id, input) { await httpJson(deps.http, `/api/workspaces/${encodeURIComponent(id)}`, { method: 'PATCH', body: input }, context); },
    async deleteWorkspace(id, input) { await httpJson(deps.http, `/api/workspaces/${encodeURIComponent(id)}/delete`, { method: 'POST', body: input }, context); },
    async migration(path = '/api/migration', input) { return httpJson(deps.http, path, input ? { method: 'POST', body: input } : undefined, context); },
  };
  return commands;
}

export function createCitationCommands(deps: CommandDeps): CitationCommands {
  const readEnvelope = (value: unknown, sessionId: string) => {
    const envelope = parseCitationEnvelope((value as { citations?: unknown })?.citations);
    if (envelope) return envelope;
    throw appError({ code: 'citation_invalid_response', category: 'session', message: '引用响应无效', sessionId, retryable: false });
  };
  return {
    async list(sessionId, options = {}) {
      const query = new URLSearchParams({ offset: String(options.offset || 0) });
      if (options.ids) query.set('ids', options.ids.join(','));
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/citations?${query}`, { signal: options.signal }, { category: 'session', sessionId });
      return readEnvelope(data, sessionId);
    },
    async detail(sessionId, evidenceId, signal) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/citations/evidence/${encodeURIComponent(evidenceId)}`, { signal }, { category: 'session', sessionId });
      const detail = parseCitationDetail(data);
      if (!detail) throw appError({ code: 'citation_invalid_response', category: 'session', message: '引用详情响应无效', sessionId, retryable: false });
      return detail;
    },
  };
}

export function createVideoCommands(deps: CommandDeps): VideoCommands {
  return {
    getMetrics(sessionId, resourceId) {
      return httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/video-resources/${encodeURIComponent(resourceId)}/metrics`, undefined, { category: 'session', sessionId });
    },
  };
}

export function createGeoCommands(deps: CommandDeps): GeoCommands {
  const context = (sessionId: string) => ({ category: 'session' as const, sessionId });
  return {
    async createContext(sessionId, geoContext) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/geo-contexts`, { method: 'POST', body: geoContext }, context(sessionId));
      return (data as { reference: GeoContextReferenceV1 }).reference;
    },
    async getContext(sessionId, contextId) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/geo-contexts/${encodeURIComponent(contextId)}`, undefined, context(sessionId));
      return (data as { context: GeoClientContextV1 }).context;
    },
    async saveScreenshot(sessionId, input) {
      return await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/geo-screenshots`, { method: 'POST', body: input }, context(sessionId)) as { filename: string; path: string; bytes: number };
    },
    async respondScreenshot(sessionId, requestId, response) {
      return await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/geo-screenshots/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: response }, context(sessionId));
    },
    async respond(sessionId, requestId, response) {
      return await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/geo-interactions/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: response }, context(sessionId)) as { response: GeoInteractionResponseV1; context?: GeoClientContextV1 };
    },
  };
}

export function createCanvasCommands(deps: CommandDeps): CanvasCommands {
  return {
    async present(sessionId, input) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/canvas-presentations`, { method: 'POST', body: input }, { category: 'session', sessionId });
      return (data as { canvas: CanvasPresentationV1 }).canvas;
    },
    async createContext(sessionId, input) {
      const data = await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/canvas-contexts`, { method: 'POST', body: input }, { category: 'session', sessionId });
      return (data as { context: CanvasContextV1 }).context;
    },
  };
}

export function createReportCommands(deps: CommandDeps): ReportCommands {
  return {
    async loadSource(sessionId, url) {
      const { content, stale } = await httpText(deps.http, url, { category: 'session', sessionId });
      return { content, encoding: 'utf8', size: new Blob([content]).size, ...(stale ? { stale: true } : {}) };
    },

    async exportPdf(title, html) {
      const data = await httpJson(deps.http, '/api/reports/pdf/download', { method: 'POST', body: { title, html } }, { category: 'session' });
      const url = typeof (data as { url?: unknown })?.url === 'string' ? (data as { url: string }).url : '';
      if (!url) throw appError({ code: 'report_export_invalid_response', category: 'session', message: 'PDF 导出响应无效', retryable: false });
      return { url };
    },
  };
}

export function createPlatformCommands(deps: CommandDeps): PlatformCommands {
  return {
    async getAvailableModels(sessionId) {
      const data = await rpcCommand(deps, {
        type: 'get_available_models',
        ...(sessionId ? { sessionId } : {}),
      });
      return ((data as { data?: { models?: Array<ModelRecord | string> } }).data?.models ?? []);
    },

    async refreshModels(sessionId) {
      const response = await rpcCommand(deps, { type: 'refresh_models', ...(sessionId ? { sessionId } : {}) });
      return (response as { data: { models: Array<ModelRecord | string>; errors: ModelRefreshError[] } }).data;
    },

    async getSessionOptions() {
      const data = await httpJson(deps.http, '/api/platform/session-options', undefined, { category: 'session' });
      return data as SessionOptions;
    },

    async getModelProviders() {
      const data = await rpcCommand(deps, { type: 'get_model_providers' });
      return ((data as { data?: { providers?: ModelProviderAccess[] } }).data?.providers ?? []);
    },

    async connectModelProvider(provider, apiKey) {
      const data = await rpcCommand(deps, { type: 'connect_model_provider', provider, apiKey });
      return (data as { data: { provider: ModelProviderAccess } }).data.provider;
    },

    async disconnectModelProvider(provider) {
      await rpcCommand(deps, { type: 'disconnect_model_provider', provider });
    },

    async addModel(input) {
      const data = await rpcCommand(deps, { type: 'add_model', ...input });
      return (data as { data: { model: { provider: string; modelId: string; reference: string } } }).data.model;
    },

    async discoverLocalModels(input) {
      const data = await rpcCommand(deps, { type: 'discover_local_models', ...input });
      return (data as { data: LocalModelConnection }).data;
    },

    async addLocalModel(input) {
      const data = await rpcCommand(deps, { type: 'add_local_model', ...input });
      return (data as { data: { model: { provider: string; modelId: string; reference: string } } }).data.model;
    },

    async updateModel(input) {
      const data = await rpcCommand(deps, { type: 'update_model', ...input });
      return (data as { data: { model: { provider: string; modelId: string; reference: string } } }).data.model;
    },

    async deleteModel(provider, modelId) {
      await rpcCommand(deps, { type: 'delete_model', provider, modelId });
    },

    async deleteModelProvider(provider) {
      await rpcCommand(deps, { type: 'delete_model_provider', provider });
    },

    async getOverview(sessionId) {
      if (sessionId) return await httpJson(deps.http, `/api/conversations/${encodeURIComponent(sessionId)}/overview`, undefined, { category: 'session', sessionId }) as PlatformOverview;
      const data = await rpcCommand(deps, { type: 'get_platform_overview' });
      return ((data as { data?: PlatformOverview }).data ?? { storage: { root: '', scenario: '', models: '', settings: '', modules: '', logs: '' }, modules: [], errors: [] });
    },
    async openLogsDirectory() {
      await rpcCommand(deps, { type: 'open_logs_directory' });
    },
    async openModuleDirectory(moduleId) {
      await rpcCommand(deps, { type: 'open_module_directory', moduleId });
    },

    async installModule(sourcePath) {
      const data = await rpcCommand(deps, { type: 'install_module', sourcePath });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
    },

    async inspectModuleArchive(sourcePath) {
      const data = await rpcCommand(deps, { type: 'inspect_module_archive', sourcePath });
      return (data as { data: { inspection: ModuleArchiveInspection } }).data.inspection;
    },

    async installModuleArchive(importId, selections) {
      const data = await rpcCommand(deps, { type: 'install_module_archive', importId, selections });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
    },

    async discardModuleArchive(importId) {
      await rpcCommand(deps, { type: 'discard_module_archive', importId });
    },

    async uninstallModule(moduleId) {
      const data = await rpcCommand(deps, { type: 'uninstall_module', moduleId });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
    },

    async setModuleEnabled(moduleId, enabled) {
      const data = await rpcCommand(deps, { type: 'set_module_enabled', moduleId, enabled });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
    },

    async migrateLegacyModules() {
      const data = await rpcCommand(deps, { type: 'migrate_legacy_modules' });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
    },

    async getAuth() {
      const data = await rpcCommand(deps, { type: 'get_auth' });
      return ((data as { data?: { configured?: boolean; enabled?: boolean } }).data ?? {
        configured: false,
        enabled: false,
      }) as { configured: boolean; enabled: boolean };
    },

    async setAuth(enabled) {
      const data = await rpcCommand(deps, { type: 'set_auth', enabled });
      return ((data as { data?: { enabled?: boolean } }).data ?? { enabled }) as { enabled: boolean };
    },
  };
}

export function createExtensionUiCommands(deps: CommandDeps): ExtensionUiCommands {
  return {
    async respond({ sessionId, id, response }) {
      // An extension response is a terminal local UI action. Pi may take time
      // to acknowledge it while continuing the run, so keep the dialog from
      // blocking the workbench after the user has made a choice.
      deps.dispatch({ type: 'extensionUi/resolved', sessionId, requestId: id });
      await rpcCommand(deps, {
        type: 'extension_ui_response',
        id,
        clientCommandId: clientCommandId(),
        ...(sessionId ? { sessionId } : {}),
        ...(response ?? { cancelled: true }),
      });
    },
  };
}

export type KernelCommands = {
  agent: AgentCommands;
  session: SessionCommands;
  citation: CitationCommands;
  video: VideoCommands;
  geo: GeoCommands;
  canvas: CanvasCommands;
  report: ReportCommands;
  platform: PlatformCommands;
  extensionUi: ExtensionUiCommands;
};

export function createCommands(deps: CommandDeps): KernelCommands {
  return {
    agent: createAgentCommands(deps),
    session: createSessionCommands(deps),
    citation: createCitationCommands(deps),
    video: createVideoCommands(deps),
    geo: createGeoCommands(deps),
    canvas: createCanvasCommands(deps),
    report: createReportCommands(deps),
    platform: createPlatformCommands(deps),
    extensionUi: createExtensionUiCommands(deps),
  };
}
