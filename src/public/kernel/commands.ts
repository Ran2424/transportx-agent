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

export type HttpInit = { method?: string; body?: unknown; headers?: Record<string, string> };

/** Minimal structural subset of fetch()'s Response used by the kernel. */
export type HttpResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type HttpClient = (path: string, init?: HttpInit) => Promise<HttpResponse>;

export type CommandDeps = {
  transport: { send(data: unknown): void };
  http: HttpClient;
  dispatch: (action: AppAction) => void;
  isStreaming: (sessionId: string) => boolean;
};

export type SendPromptInput = { sessionId: string; message: string; attachmentIds?: string[]; clientCommandId?: string };
export type SetTaskModeInput = { sessionId: string; enabled: boolean };
export type SteerInput = { sessionId: string; message: string; attachmentIds?: string[] };
export type FollowUpInput = { sessionId: string; message: string };
export type SetModelInput = { sessionId: string; model: string };
export type SetThinkingLevelInput = { sessionId: string; level: string };
export type PiModelApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
export type AddModelInput = {
  provider: string;
  modelId: string;
  api: PiModelApi;
  baseUrl: string;
  apiKey: string;
  name?: string;
  reasoning?: boolean;
  images?: boolean;
};
export type ModelProviderAccess = {
  id: string;
  name: string;
  connected: boolean;
  credentialStored: boolean;
  authMethods: Array<'api_key' | 'oauth'>;
  authSource?: string;
  modelCount: number;
};
export type CreateSessionInput = { cwd?: string; name?: string; model?: string; profile?: SessionProfileV1 };
export type ResumeSessionInput = { filePath: string; model?: string; cwd?: string; useCurrentConfiguration?: boolean };
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
};

export type WorkspaceFileContent = { content: string; size: number; encoding?: 'utf8' | 'base64' };

export type UploadAttachmentInput = { sessionId: string; file: File; source: SessionAttachmentSource };

export type AgentState = {
  model?: ModelRecord | null;
  thinkingLevel?: string;
  autoCompactionEnabled?: boolean;
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
  setTaskMode(input: SetTaskModeInput): Promise<void>;
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
  loadSnapshot(sessionId: string): Promise<SessionSnapshot>;
  loadHistory(filePath: string): Promise<SessionSnapshot>;
  listFiles(sessionId: string, path?: string): Promise<{ path: string; items: WorkspaceFile[] }>;
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
  getOverview(): Promise<PlatformOverview>;
  installModule(sourcePath: string): Promise<PlatformOverview>;
  uninstallModule(moduleId: string): Promise<PlatformOverview>;
  setModuleEnabled(moduleId: string, enabled: boolean): Promise<PlatformOverview>;
  migrateLegacyModules(): Promise<PlatformOverview>;
  getAuth(): Promise<{ configured: boolean; enabled: boolean }>;
  setAuth(enabled: boolean): Promise<{ enabled: boolean }>;
};

export type ExtensionUiCommands = {
  respond(input: ExtensionUiResponseInput): Promise<void>;
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
    async sendPrompt({ sessionId, message, attachmentIds, clientCommandId: requestedId }) {
      const promptKey = `${sessionId}\0${message}\0${(attachmentIds || []).join(',')}`;
      const commandId = requestedId || pendingPromptIds.get(promptKey) || clientCommandId();
      pendingPromptIds.set(promptKey, commandId);
      // While streaming, prompts queue per session instead of hitting the
      // transport; the kernel flushes them when the run ends.
      if (deps.isStreaming(sessionId)) {
        deps.dispatch({ type: 'conversation/promptQueued', sessionId, message, attachmentIds, clientCommandId: commandId });
        return;
      }
      await rpcCommand(deps.http, { type: 'prompt', sessionId, message, clientCommandId: commandId, ...(attachmentIds?.length ? { attachmentIds } : {}) });
      pendingPromptIds.delete(promptKey);
      deps.dispatch({ type: 'conversation/promptSent', sessionId, message, attachmentIds });
    },

    async setTaskMode({ sessionId, enabled }) {
      await rpcCommand(deps.http, {
        type: 'prompt',
        sessionId,
        clientCommandId: clientCommandId(),
        message: `/task ${enabled ? 'on' : 'off'} --silent`,
      });
    },

    async abort(sessionId) {
      await rpcCommand(deps.http, { type: 'abort', sessionId, clientCommandId: clientCommandId() });
    },

    async steer({ sessionId, message, attachmentIds }) {
      await rpcCommand(deps.http, { type: 'steer', sessionId, message, clientCommandId: clientCommandId(), ...(attachmentIds?.length ? { attachmentIds } : {}) });
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

    async listAttachments(sessionId) {
      const data = await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/attachments`, undefined, { ...context, sessionId });
      return ((data as { attachments?: SessionAttachment[] }).attachments ?? []);
    },

    async uploadAttachment({ sessionId, file, source }) {
      const form = new FormData();
      form.append('file', file, file.name);
      const data = await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/attachments?source=${encodeURIComponent(source)}`, { method: 'POST', body: form }, { ...context, sessionId });
      const attachment = (data as { attachments?: SessionAttachment[] }).attachments?.[0];
      if (!attachment) throw appError({ code: 'attachment_upload_invalid_response', category: 'transport', message: '附件上传响应无效', sessionId, retryable: false });
      return attachment;
    },

    async deleteAttachment(sessionId, attachmentId) {
      await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachmentId)}`, { method: 'DELETE' }, { ...context, sessionId });
    },

    async close(sessionId) {
      await httpJson(deps.http, `/api/live-sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, { ...context, sessionId });
    },

    async deleteHistory(filePath) {
      await httpJson(deps.http, '/api/sessions/delete', { method: 'POST', body: { filePath } }, context);
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

    async getOverview() {
      const data = await rpcCommand(deps.http, { type: 'get_platform_overview' });
      return ((data as { data?: PlatformOverview }).data ?? { storage: { root: '', scenario: '', models: '', settings: '', modules: '' }, modules: [], errors: [] });
    },

    async installModule(sourcePath) {
      const data = await rpcCommand(deps.http, { type: 'install_module', sourcePath });
      return (data as { data: { overview: PlatformOverview } }).data.overview;
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
      await rpcCommand(deps.http, {
        type: 'extension_ui_response',
        id,
        clientCommandId: clientCommandId(),
        ...(sessionId ? { sessionId } : {}),
        ...(response ?? { cancelled: true }),
      });
      deps.dispatch({ type: 'extensionUi/resolved', sessionId, requestId: id });
    },
  };
}

export type KernelCommands = {
  agent: AgentCommands;
  session: SessionCommands;
  platform: PlatformCommands;
  extensionUi: ExtensionUiCommands;
};

export function createCommands(deps: CommandDeps): KernelCommands {
  return {
    agent: createAgentCommands(deps),
    session: createSessionCommands(deps),
    platform: createPlatformCommands(deps),
    extensionUi: createExtensionUiCommands(deps),
  };
}
