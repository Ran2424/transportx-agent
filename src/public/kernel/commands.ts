/**
 * Command ports (migration plan §4.2). Components never fetch(), touch the
 * WebSocket or assemble RPC JSON themselves — they call these ports.
 * Transport/HTTP failures are converted to serializable AppErrors here and
 * thrown; the kernel stores never see raw Error instances.
 */

import type { LiveSession, ModelRecord, SessionAttachment, SessionAttachmentSource, SessionSnapshot } from '../app-types.js';
import type { AppAction } from './actions.js';
import { appError, toAppError, type AppError, type AppErrorCategory } from '../../contracts/errors.ts';
import type { SessionProfileV1 } from '../../contracts/session-profile.ts';
import type { ModuleArchiveInspection } from '../../contracts/module.ts';
import { parseCitationEnvelope, type CitationEnvelope } from '../../contracts/citation.ts';
import type { GeoClientContextV1, GeoContextReferenceV1, GeoInteractionResponseV1 } from '../../contracts/geo.ts';
import type { CanvasContextV1 } from '../../contracts/canvas.ts';

export type HttpInit = { method?: string; body?: unknown; headers?: Record<string, string> };

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
  reasoning?: boolean;
  images?: boolean;
};
export type UpdateModelInput = {
  provider: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
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
export type CreateSessionInput = { cwd?: string; name?: string; model?: string; profile?: SessionProfileV1 };
export type ResumeSessionInput = { filePath: string; model?: string; cwd?: string; useCurrentConfiguration?: boolean };
export type RenameSessionInput = { name: string; sessionId?: string; filePath?: string };
export type ExtensionUiResponseInput = {
  sessionId: string | null;
  id?: string;
  response?: Record<string, unknown>;
};

export type HistorySession = {
  filePath?: string;
  name?: string | null;
  firstMessage?: string | null;
  timestamp?: string;
  mtime?: number;
  lastConversationAt?: string;
  sessionName?: string | null;
  sessionTimestamp?: string;
  live?: boolean;
};

export type HistoryProject = {
  path?: string;
  dirName?: string;
  sessions?: HistorySession[];
};

export type HistorySearchResult = HistorySession & {
  project?: string;
  matches?: Array<{ snippet?: string }>;
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
  version: string;
  type: 'module' | 'capability' | 'domain';
  origin: 'builtin' | 'installed' | 'external';
  removable: boolean;
  enabled: boolean;
  extensions: number;
  skills: number;
  nativeRuntimes?: number;
  skillFiles: Array<{ entryPath: string; name: string; content?: string; truncated?: boolean; error?: string }>;
  assets: Array<{ id: string; kind: 'knowledge' | 'data' | 'template'; configured: boolean; active: boolean; error?: string }>;
};

export type PlatformOverview = {
  storage: { root: string; scenario: string; models: string; settings: string; modules: string };
  modules: PlatformModule[];
  errors: Array<{ moduleId?: string; message: string }>;
};

export type SessionModuleOption = {
  id: string;
  name: string;
  version: string;
  type: 'module' | 'capability' | 'domain';
  origin: 'installed';
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
  list(): Promise<LiveSession[]>;
  listHistory(): Promise<HistoryProject[]>;
  searchHistory(query: string): Promise<HistorySearchResult[]>;
  create(input: CreateSessionInput): Promise<LiveSession>;
  resume(input: ResumeSessionInput): Promise<LiveSession>;
  rename(input: RenameSessionInput): Promise<{ name: string }>;
  loadSnapshot(sessionId: string): Promise<SessionSnapshot>;
  loadHistory(filePath: string): Promise<SessionSnapshot>;
  listFiles(sessionId: string, path?: string): Promise<{ path: string; items: WorkspaceFile[] }>;
  openInSystem(sessionId: string, path: string): Promise<void>;
  readFileContent(sessionId: string, path: string): Promise<WorkspaceFileContent>;
  listAttachments(sessionId: string): Promise<SessionAttachment[]>;
  uploadAttachment(input: UploadAttachmentInput): Promise<SessionAttachment>;
  deleteAttachment(sessionId: string, attachmentId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  deleteHistory(filePath: string): Promise<void>;
};

export type PlatformCommands = {
  getAvailableModels(sessionId?: string | null): Promise<Array<ModelRecord | string>>;
  getModelProviders(): Promise<ModelProviderAccess[]>;
  connectModelProvider(provider: string, apiKey: string): Promise<ModelProviderAccess>;
  disconnectModelProvider(provider: string): Promise<void>;
  getSessionOptions(): Promise<SessionOptions>;
  addModel(input: AddModelInput): Promise<{ provider: string; modelId: string; reference: string }>;
  updateModel(input: UpdateModelInput): Promise<{ provider: string; modelId: string; reference: string }>;
  deleteModel(provider: string, modelId: string): Promise<void>;
  deleteModelProvider(provider: string): Promise<void>;
  getOverview(): Promise<PlatformOverview>;
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
  list(sessionId: string): Promise<CitationEnvelope>;
  createOccurrence(sessionId: string, locatorId: string, role: 'support'): Promise<{ marker: string; citations: CitationEnvelope }>;
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
    const errorPayload = data as { error?: string; code?: string } | null;
    const message = errorPayload?.error ?? `HTTP ${response.status}`;
    throw appError({
      code: errorPayload?.code || 'http_error',
      category: context.category,
      message,
      sessionId: context.sessionId,
      retryable: response.status >= 500,
      diagnostics: { status: response.status, path },
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
    throw appError({ code: 'http_error', category: context.category, message: `HTTP ${response.status}`, sessionId: context.sessionId, retryable: response.status >= 500, diagnostics: { status: response.status, path } });
  }
  return { content: await response.text(), stale: response.headers?.get('X-Citation-Resource-Stale') === '1' };
}

async function rpcCommand(http: HttpClient, command: Record<string, unknown>): Promise<unknown> {
  const sessionId = command.sessionId as string | undefined;
  const data = await httpJson(http, '/api/rpc', { method: 'POST', body: command }, { category: 'session', sessionId });
  if (data && typeof data === 'object' && (data as { success?: unknown }).success === false) {
    const message = String((data as { error?: unknown }).error ?? 'RPC command failed');
    const deliveryUnknown = message.startsWith('RPC command timed out:');
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
      await rpcCommand(deps.http, { type: 'prompt', sessionId, message, clientCommandId: commandId, ...(attachmentIds?.length ? { attachmentIds } : {}), ...(geoContextIds?.length ? { geoContextIds } : {}), ...(canvasContextIds?.length ? { canvasContextIds } : {}) });
      pendingPromptIds.delete(promptKey);
      deps.dispatch({ type: 'conversation/promptSent', sessionId, message, attachmentIds, geoContextIds, ...(canvasContextIds?.length ? { canvasContextIds } : {}) });
    },

    async abort(sessionId) {
      await rpcCommand(deps.http, { type: 'abort', sessionId, clientCommandId: clientCommandId() });
    },

    async steer({ sessionId, message, attachmentIds, geoContextIds, canvasContextIds }) {
      await rpcCommand(deps.http, { type: 'steer', sessionId, message, clientCommandId: clientCommandId(), ...(attachmentIds?.length ? { attachmentIds } : {}), ...(geoContextIds?.length ? { geoContextIds } : {}), ...(canvasContextIds?.length ? { canvasContextIds } : {}) });
    },

    async followUp({ sessionId, message }) {
      await rpcCommand(deps.http, { type: 'follow_up', sessionId, message, clientCommandId: clientCommandId() });
    },

    async compact(sessionId) {
      await rpcCommand(deps.http, { type: 'compact', sessionId });
    },

    async setAutoCompaction(sessionId, enabled) {
      await rpcCommand(deps.http, { type: 'set_auto_compaction', sessionId, enabled });
    },

    async getState(sessionId) {
      const data = await rpcCommand(deps.http, { type: 'get_state', sessionId });
      return ((data as { data?: AgentState }).data ?? {}) as AgentState;
    },

    async setModel({ sessionId, model }) {
      await rpcCommand(deps.http, { type: 'set_model', sessionId, model });
    },

    async setThinkingLevel({ sessionId, level }) {
      await rpcCommand(deps.http, { type: 'set_thinking_level', sessionId, level });
    },
  };
}

export function createSessionCommands(deps: CommandDeps): SessionCommands {
  const context = { category: 'session' as AppErrorCategory };
  return {
    async list() {
      const data = await httpJson(deps.http, '/api/live-sessions', undefined, context);
      return ((data as { sessions?: LiveSession[] })?.sessions ?? []) as LiveSession[];
    },

    async listHistory() {
      const data = await httpJson(deps.http, '/api/sessions', undefined, context);
      return ((data as { projects?: HistoryProject[] })?.projects ?? []) as HistoryProject[];
    },

    async searchHistory(query) {
      if (query.trim().length < 2) return [];
      const data = await httpJson(deps.http, `/api/search?q=${encodeURIComponent(query.trim())}`, undefined, context);
      return ((data as { results?: HistorySearchResult[] })?.results ?? []) as HistorySearchResult[];
    },

    async create(input) {
      const data = await httpJson(deps.http, '/api/live-sessions', { method: 'POST', body: input }, context);
      return (data as { session: LiveSession }).session;
    },

    async resume(input) {
      const data = await httpJson(deps.http, '/api/live-sessions/resume', { method: 'POST', body: input }, context);
      return (data as { session: LiveSession }).session;
    },

    async rename(input) {
      const data = await rpcCommand(deps.http, { type: 'set_session_name', ...input });
      const name = String((data as { data?: { name?: unknown } })?.data?.name || '');
      if (!name) throw appError({ code: 'session_rename_invalid_response', category: 'session', message: '会话重命名响应无效', sessionId: input.sessionId, retryable: false });
      if (input.sessionId) deps.dispatch({ type: 'session/updated', session: { id: input.sessionId, sessionName: name } });
      return { name };
    },

    async loadSnapshot(sessionId) {
      const data = await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/snapshot`, undefined, { ...context, sessionId });
      return data as SessionSnapshot;
    },

    async loadHistory(filePath) {
      const data = await httpJson(deps.http, `/api/session-history?filePath=${encodeURIComponent(filePath)}`, undefined, context);
      return data as SessionSnapshot;
    },

    async listFiles(sessionId, path) {
      const params = new URLSearchParams({ sessionId });
      if (path) params.set('path', path);
      const data = await httpJson(deps.http, `/api/files?${params}`, undefined, { ...context, sessionId });
      return data as { path: string; items: WorkspaceFile[] };
    },

    async readFileContent(sessionId, path) {
      const params = new URLSearchParams({ sessionId, path });
      const data = await httpJson(deps.http, `/api/file/content?${params}`, undefined, { ...context, sessionId });
      return data as WorkspaceFileContent;
    },

    async openInSystem(sessionId, path) {
      await httpJson(deps.http, '/api/open', { method: 'POST', body: { filePath: path, sessionId } }, { ...context, sessionId });
    },

    async listAttachments(sessionId) {
      const data = await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/attachments`, undefined, { ...context, sessionId });
      const attachments = (data as { attachments?: SessionAttachment[] }).attachments ?? [];
      deps.dispatch({ type: 'session/attachmentsReceived', sessionId, attachments });
      return attachments;
    },

    async uploadAttachment({ sessionId, file, source }) {
      const form = new FormData();
      form.append('file', file, file.name);
      const data = await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/attachments?source=${encodeURIComponent(source)}`, { method: 'POST', body: form }, { ...context, sessionId });
      const attachment = (data as { attachments?: SessionAttachment[] }).attachments?.[0];
      if (!attachment) throw appError({ code: 'attachment_upload_invalid_response', category: 'transport', message: '附件上传响应无效', sessionId, retryable: false });
      deps.dispatch({ type: 'session/attachmentAdded', sessionId, attachment });
      return attachment;
    },

    async deleteAttachment(sessionId, attachmentId) {
      await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }, { ...context, sessionId });
      deps.dispatch({ type: 'session/attachmentRemoved', sessionId, attachmentId });
    },

    async close(sessionId) {
      await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, { ...context, sessionId });
    },

    async deleteHistory(filePath) {
      await httpJson(deps.http, '/api/sessions/delete', { method: 'POST', body: { filePath } }, context);
    },
  };
}

export function createCitationCommands(deps: CommandDeps): CitationCommands {
  const readEnvelope = (value: unknown, sessionId: string) => {
    const envelope = parseCitationEnvelope((value as { citations?: unknown })?.citations);
    if (envelope) return envelope;
    throw appError({ code: 'citation_invalid_response', category: 'session', message: '引用响应无效', sessionId, retryable: false });
  };
  return {
    async list(sessionId) {
      const data = await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/citations`, undefined, { category: 'session', sessionId });
      return readEnvelope(data, sessionId);
    },

    async createOccurrence(sessionId, locatorId, role) {
      const data = await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/citations/occurrences`, { method: 'POST', body: { locatorId, role } }, { category: 'session', sessionId });
      const marker = typeof (data as { marker?: unknown })?.marker === 'string' ? (data as { marker: string }).marker : '';
      if (!marker) throw appError({ code: 'citation_invalid_response', category: 'session', message: '引用创建响应无效', sessionId, retryable: false });
      return { marker, citations: readEnvelope(data, sessionId) };
    },
  };
}

export function createVideoCommands(deps: CommandDeps): VideoCommands {
  return {
    getMetrics(sessionId, resourceId) {
      return httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/video-resources/${encodeURIComponent(resourceId)}/metrics`, undefined, { category: 'session', sessionId });
    },
  };
}

export function createGeoCommands(deps: CommandDeps): GeoCommands {
  const context = (sessionId: string) => ({ category: 'session' as const, sessionId });
  return {
    async createContext(sessionId, geoContext) {
      const data = await httpJson(deps.http, `/api/sessions/${encodeURIComponent(sessionId)}/geo-contexts`, { method: 'POST', body: geoContext }, context(sessionId));
      return (data as { reference: GeoContextReferenceV1 }).reference;
    },
    async getContext(sessionId, contextId) {
      const data = await httpJson(deps.http, `/api/sessions/${encodeURIComponent(sessionId)}/geo-contexts/${encodeURIComponent(contextId)}`, undefined, context(sessionId));
      return (data as { context: GeoClientContextV1 }).context;
    },
    async saveScreenshot(sessionId, input) {
      return await httpJson(deps.http, `/api/sessions/${encodeURIComponent(sessionId)}/geo-screenshots`, { method: 'POST', body: input }, context(sessionId)) as { filename: string; path: string; bytes: number };
    },
    async respondScreenshot(sessionId, requestId, response) {
      return await httpJson(deps.http, `/api/sessions/${encodeURIComponent(sessionId)}/geo-screenshots/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: response }, context(sessionId));
    },
    async respond(sessionId, requestId, response) {
      return await httpJson(deps.http, `/api/sessions/${encodeURIComponent(sessionId)}/geo-interactions/${encodeURIComponent(requestId)}/respond`, { method: 'POST', body: response }, context(sessionId)) as { response: GeoInteractionResponseV1; context?: GeoClientContextV1 };
    },
  };
}

export function createCanvasCommands(deps: CommandDeps): CanvasCommands {
  return {
    async createContext(sessionId, input) {
      const data = await httpJson(deps.http, `/api/sessions/${encodeURIComponent(sessionId)}/canvas-contexts`, { method: 'POST', body: input }, { category: 'session', sessionId });
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
      const data = await rpcCommand(deps.http, {
        type: 'get_available_models',
        ...(sessionId ? { sessionId } : {}),
      });
      return ((data as { data?: { models?: Array<ModelRecord | string> } }).data?.models ?? []);
    },

    async getSessionOptions() {
      const data = await httpJson(deps.http, '/api/platform/session-options', undefined, { category: 'session' });
      return data as SessionOptions;
    },

    async getModelProviders() {
      const data = await rpcCommand(deps.http, { type: 'get_model_providers' });
      return ((data as { data?: { providers?: ModelProviderAccess[] } }).data?.providers ?? []);
    },

    async connectModelProvider(provider, apiKey) {
      const data = await rpcCommand(deps.http, { type: 'connect_model_provider', provider, apiKey });
      return (data as { data: { provider: ModelProviderAccess } }).data.provider;
    },

    async disconnectModelProvider(provider) {
      await rpcCommand(deps.http, { type: 'disconnect_model_provider', provider });
    },

    async addModel(input) {
      const data = await rpcCommand(deps.http, { type: 'add_model', ...input });
      return (data as { data: { model: { provider: string; modelId: string; reference: string } } }).data.model;
    },

    async updateModel(input) {
      const data = await rpcCommand(deps.http, { type: 'update_model', ...input });
      return (data as { data: { model: { provider: string; modelId: string; reference: string } } }).data.model;
    },

    async deleteModel(provider, modelId) {
      await rpcCommand(deps.http, { type: 'delete_model', provider, modelId });
    },

    async deleteModelProvider(provider) {
      await rpcCommand(deps.http, { type: 'delete_model_provider', provider });
    },

    async getOverview() {
      const data = await rpcCommand(deps.http, { type: 'get_platform_overview' });
      return ((data as { data?: PlatformOverview }).data ?? { storage: { root: '', scenario: '', models: '', settings: '', modules: '' }, modules: [], errors: [] });
    },

    async installModule(sourcePath) {
      const data = await rpcCommand(deps.http, { type: 'install_module', sourcePath });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
    },

    async inspectModuleArchive(sourcePath) {
      const data = await rpcCommand(deps.http, { type: 'inspect_module_archive', sourcePath });
      return (data as { data: { inspection: ModuleArchiveInspection } }).data.inspection;
    },

    async installModuleArchive(importId, selections) {
      const data = await rpcCommand(deps.http, { type: 'install_module_archive', importId, selections });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
    },

    async discardModuleArchive(importId) {
      await rpcCommand(deps.http, { type: 'discard_module_archive', importId });
    },

    async uninstallModule(moduleId) {
      const data = await rpcCommand(deps.http, { type: 'uninstall_module', moduleId });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
    },

    async setModuleEnabled(moduleId, enabled) {
      const data = await rpcCommand(deps.http, { type: 'set_module_enabled', moduleId, enabled });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
    },

    async migrateLegacyModules() {
      const data = await rpcCommand(deps.http, { type: 'migrate_legacy_modules' });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
    },

    async getAuth() {
      const data = await rpcCommand(deps.http, { type: 'get_auth' });
      return ((data as { data?: { configured?: boolean; enabled?: boolean } }).data ?? {
        configured: false,
        enabled: false,
      }) as { configured: boolean; enabled: boolean };
    },

    async setAuth(enabled) {
      const data = await rpcCommand(deps.http, { type: 'set_auth', enabled });
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
      await rpcCommand(deps.http, {
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
