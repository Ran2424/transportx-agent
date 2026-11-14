import type { ModelRecord } from '../app-types.js';
import type { ModelRefreshError } from '../../contracts/model.js';
import type { ModuleArchiveInspection, ModulePresentation } from '../../contracts/module.ts';
import type { ToolDiagnostic } from '../../contracts/tool-interface.ts';
import type { AddLocalModelInput, LocalModelConnection, LocalModelConnectionInput } from '../../contracts/local-model.ts';
import { httpJson, rpcCommand, type CommandDeps } from './command-transport.js';

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
  credentialType?: 'api_key' | 'oauth';
  custom?: boolean;
  baseUrl?: string;
  api?: PiModelApi;
  authMethods: Array<'api_key' | 'oauth'>;
  authSource?: string;
  modelCount: number;
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

export type PlatformCommands = {
  getAvailableModels(sessionId?: string | null): Promise<Array<ModelRecord | string>>;
  refreshModels(sessionId?: string): Promise<{ models: Array<ModelRecord | string>; errors: ModelRefreshError[] }>;
  getModelProviders(): Promise<ModelProviderAccess[]>;
  connectModelProvider(provider: string, apiKey: string): Promise<ModelProviderAccess>;
  chatGPTSignIn(action: 'start' | 'status' | 'cancel', attemptId?: string, newAccount?: boolean): Promise<import('../../contracts/chatgpt-plan.js').ChatGPTSignIn>;
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
    async chatGPTSignIn(action, attemptId, newAccount) {
      const result = await rpcCommand(deps, { type: 'chatgpt_sign_in', action, attemptId, newAccount });
      return (result as { data: { signIn: import('../../contracts/chatgpt-plan.js').ChatGPTSignIn } }).data.signIn;
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
