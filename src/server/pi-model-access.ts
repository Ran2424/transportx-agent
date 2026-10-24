const path = require('node:path');
import { assertHostWriter, readJsonObject } from './util/json-storage.js';
import { piModelRuntime } from './pi-model-runtime.js';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };

export type PiModelProviderAccess = {
  id: string;
  name: string;
  connected: boolean;
  credentialStored: boolean;
  custom: boolean;
  baseUrl?: string;
  api?: string;
  authMethods: Array<'api_key' | 'oauth'>;
  authSource?: string;
  modelCount: number;
};

function summarizeProvider(runtime: ModelRuntime, agentDir: string, providerId: string, storedProviderIds: Set<string>): PiModelProviderAccess {
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new Error(`未知模型供应商：${providerId}`);
  const status = runtime.getProviderAuthStatus(providerId);
  const authMethods: PiModelProviderAccess['authMethods'] = [];
  if (provider.auth.apiKey?.login) authMethods.push('api_key');
  if (provider.auth.oauth) authMethods.push('oauth');
  const configured = readModelsProvider(agentDir, provider.id);
  return {
    id: provider.id,
    name: provider.name || provider.id,
    connected: status.configured,
    credentialStored: storedProviderIds.has(provider.id),
    custom: !!configured,
    ...(configured?.baseUrl ? { baseUrl: configured.baseUrl } : {}),
    ...(configured?.api ? { api: configured.api } : {}),
    authMethods,
    ...(status.label || status.source ? { authSource: status.label || status.source } : {}),
    modelCount: runtime.getModels(provider.id).length,
  };
}

function readModelsProvider(agentDir: string, providerId: string): { baseUrl?: string; api?: string } | null {
  const config = readJsonObject(path.join(agentDir, 'models.json'));
  const providers = config.providers as Record<string, { baseUrl?: string; api?: string }> | undefined;
  return providers?.[providerId] || null;
}

export async function listPiModelProviders(agentDir: string) {
  return piModelRuntime(agentDir)(async (runtime) => {
    const storedProviderIds = new Set((await runtime.listCredentials()).map((item) => item.providerId));
    return runtime.getProviders()
      .map((provider) => summarizeProvider(runtime, agentDir, provider.id, storedProviderIds))
      .sort((left, right) => left.name.localeCompare(right.name));
  });
}

export async function listAvailablePiModels(agentDir: string) {
  return piModelRuntime(agentDir)(async (runtime) => {
    return availableModels(runtime);
  });
}

async function availableModels(runtime: ModelRuntime) {
  const models = await runtime.getAvailable();
  return models.map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutput: model.maxTokens,
    thinking: model.reasoning,
    images: model.input.includes('image'),
  }));
}

export async function refreshPiModelCatalog(runtime: ModelRuntime) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const result = await runtime.refresh({ allowNetwork: true, force: true, signal: controller.signal });
    const errors: import('../contracts/model.js').ModelRefreshError[] = [...result.errors].map(([provider, error]) => ({ provider, message: error.message }));
    if (result.aborted) errors.push({ message: '模型目录刷新超时，请重试；已有模型仍可使用。' });
    if (runtime.getError()) errors.push({ message: runtime.getError()! });
    return { models: await availableModels(runtime), errors };
  } finally { clearTimeout(timeout); }
}

let refreshing: { agentDir: string; promise: ReturnType<typeof refreshPiModelCatalog> } | undefined;
export function refreshPiModels(agentDir: string) {
  assertHostWriter(agentDir);
  if (refreshing?.agentDir === agentDir) return refreshing.promise;
  const promise = piModelRuntime(agentDir)(refreshPiModelCatalog).finally(() => { if (refreshing?.promise === promise) refreshing = undefined; });
  refreshing = { agentDir, promise };
  return promise;
}

export async function connectPiModelProvider(providerIdInput: string, apiKeyInput: string, agentDir: string) {
  assertHostWriter(agentDir);
  const providerId = providerIdInput.trim();
  const apiKey = apiKeyInput.trim();
  if (!providerId) throw new Error('请选择模型供应商');
  if (!apiKey || apiKey.length > 20_000) throw new Error('API Key 不能为空');
  return piModelRuntime(agentDir)(async (runtime) => {
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error(`未知模型供应商：${providerId}`);
    if (!provider.auth.apiKey?.login) throw new Error(`供应商 ${provider.name} 不支持在工作台中使用 API Key 接入`);
    let prompted = false;
    const interaction = {
      async prompt(prompt: { type: 'text' | 'secret' | 'select' | 'manual_code' }) {
        if (prompted || (prompt.type !== 'secret' && prompt.type !== 'text')) {
          throw new Error(`供应商 ${provider.name} 需要额外的交互式配置，请暂时使用 Pi 终端 /login`);
        }
        prompted = true;
        return apiKey;
      },
      notify() {},
    };
    await runtime.login(providerId, 'api_key', interaction);
    const storedProviderIds = new Set((await runtime.listCredentials()).map((item) => item.providerId));
    return summarizeProvider(runtime, agentDir, providerId, storedProviderIds);
  });
}

export async function disconnectPiModelProvider(providerIdInput: string, agentDir: string) {
  assertHostWriter(agentDir);
  const providerId = providerIdInput.trim();
  if (!providerId) throw new Error('模型供应商不能为空');
  return piModelRuntime(agentDir)(async (runtime) => {
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error(`未知模型供应商：${providerId}`);
    const storedProviderIds = new Set((await runtime.listCredentials()).map((item) => item.providerId));
    if (!storedProviderIds.has(providerId)) {
      throw new Error(`供应商 ${provider.name} 使用环境变量或模型配置接入，无法在工作台中移除`);
    }
    await runtime.logout(providerId);
  });
}

export async function ensurePiModelProviderConfigured(providerIdInput: string, agentDir: string) {
  const providerId = providerIdInput.trim();
  return piModelRuntime(agentDir)(async (runtime) => {
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error(`未知模型供应商：${providerId}`);
    if (!runtime.getProviderAuthStatus(providerId).configured) throw new Error(`供应商 ${provider.name} 尚未接入，请先填写 API Key`);
  });
}

export async function removePiModelProviderCredential(providerIdInput: string, agentDir: string) {
  assertHostWriter(agentDir);
  const providerId = providerIdInput.trim();
  return piModelRuntime(agentDir)(async (runtime) => {
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error(`未知模型供应商：${providerId}`);
    const storedProviderIds = new Set((await runtime.listCredentials()).map((item) => item.providerId));
    if (storedProviderIds.has(providerId)) await runtime.logout(providerId);
  });
}
