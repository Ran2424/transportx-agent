const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

import { readJsonObject, writeJsonAtomic, mutateJson } from './util/json-storage.js';
import type { JsonRecord } from './types.js';
import type { AddLocalModelInput } from '../contracts/local-model.js';
import { localModelConnection } from './local-model-service.js';
import { connectPiModelProvider, ensurePiModelProviderConfigured, removePiModelProviderCredential } from './pi-model-access.js';

export const PI_MODEL_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const;
export type PiModelApi = typeof PI_MODEL_APIS[number];
export type AddPiModelInput = {
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
type AddPiModelPayload = Omit<Partial<AddPiModelInput>, 'api'> & { api?: string };

function readModelsConfig(agentDir: string) {
  const modelsPath = path.join(agentDir, 'models.json');
  const config = readJsonObject(modelsPath, { providers: {} });
  const providers = config.providers === undefined ? {} : config.providers && typeof config.providers === 'object' && !Array.isArray(config.providers)
    ? config.providers as JsonRecord
    : (() => { throw new Error('Invalid model providers'); })();
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw Object.assign(new Error('Corrupt model provider configuration'), { status: 409 });
    const models = (provider as JsonRecord).models;
    if (models !== undefined && (!Array.isArray(models) || models.some((model) => !model || typeof model !== 'object' || Array.isArray(model) || typeof model.id !== 'string' || !model.id))) throw Object.assign(new Error('Corrupt model definitions'), { status: 409 });
  }
  return { path: modelsPath, config, providers };
}

function validated(input: AddPiModelPayload): AddPiModelInput {
  const provider = String(input.provider || '').trim().toLowerCase();
  const modelId = String(input.modelId || '').trim();
  const api = String(input.api || '') as PiModelApi;
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(input.apiKey || '').trim();
  const name = String(input.name || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(provider)) throw new Error('Provider ID 只能包含小写字母、数字、点、下划线和连字符');
  if (!modelId || modelId.length > 200 || /[\x00-\x1f]/.test(modelId)) throw new Error('Model ID 无效');
  if (!PI_MODEL_APIS.includes(api)) throw new Error('不支持的 Pi API 类型');
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('API Base URL 无效'); }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('API Base URL 必须使用 HTTP 或 HTTPS');
  if (apiKey.length > 20_000) throw new Error('API Key 过长');
  if (name.length > 200) throw new Error('显示名称过长');
  const contextWindow = input.contextWindow === undefined || input.contextWindow === null ? undefined : Number(input.contextWindow);
  if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow <= 0)) throw new Error('上下文窗口必须是正整数');
  const maxTokens = input.maxTokens === undefined || input.maxTokens === null ? undefined : Number(input.maxTokens);
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || contextWindow !== undefined && maxTokens > contextWindow)) throw new Error('最大输出必须是正整数且不能超过上下文窗口');
  return { provider, modelId, api, baseUrl, ...(apiKey ? { apiKey } : {}), ...(name ? { name } : {}), ...(contextWindow !== undefined ? { contextWindow } : {}), ...(maxTokens !== undefined ? { maxTokens } : {}), reasoning: !!input.reasoning, images: !!input.images };
}

type ModelPatchInput = Pick<AddPiModelInput, 'name' | 'contextWindow' | 'maxTokens' | 'reasoning' | 'images'>;

function modelPatch(model: ModelPatchInput): JsonRecord {
  return {
    ...(model.name ? { name: model.name } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    reasoning: !!model.reasoning,
    input: model.images ? ['text', 'image'] : ['text'],
  };
}

async function addPiModelMutation(input: AddPiModelPayload, agentDir: string, local = false) {
  const model = validated(input);
  const { path: modelsPath, config, providers } = readModelsConfig(agentDir);
  const existingProvider = providerConfig(providers, model.provider);
  const existingModels = Array.isArray(existingProvider.models) ? existingProvider.models.filter((item) => item && typeof item === 'object') as JsonRecord[] : [];
  const definition: JsonRecord = { ...existingModels.find((item) => item.id === model.modelId), id: model.modelId, ...modelPatch(model) };
  const nextModels = existingModels.filter((item) => item.id !== model.modelId);
  nextModels.push(definition);
  const nextProviders = {
    ...providers,
    [model.provider]: {
      ...existingProvider,
      baseUrl: model.baseUrl,
      api: model.api,
      ...(local ? { name: `Local · ${new URL(model.baseUrl).host}`, apiKey: model.apiKey ? undefined : 'transportx-local' } : {}),
      models: nextModels,
    },
  };
  writeJsonAtomic(modelsPath, { ...config, providers: nextProviders });
  if (local && !model.apiKey) await removePiModelProviderCredential(model.provider, agentDir);
  if (model.apiKey) await connectPiModelProvider(model.provider, model.apiKey, agentDir);
  else await ensurePiModelProviderConfigured(model.provider, agentDir);
  return { provider: model.provider, modelId: model.modelId, reference: `${model.provider}/${model.modelId}` };
}

export type UpdatePiModelInput = {
  provider: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  images?: boolean;
};

function validatedUpdate(input: UpdatePiModelInput) {
  const provider = String(input.provider || '').trim().toLowerCase();
  const modelId = String(input.modelId || '').trim();
  const name = String(input.name || '').trim();
  if (!provider || !modelId || modelId.length > 200 || /[\x00-\x1f]/.test(modelId)) throw new Error('模型标识无效');
  if (name.length > 200) throw new Error('显示名称过长');
  const contextWindow = input.contextWindow === undefined || input.contextWindow === null ? undefined : Number(input.contextWindow);
  if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow <= 0)) throw new Error('上下文窗口必须是正整数');
  const maxTokens = input.maxTokens === undefined || input.maxTokens === null ? undefined : Number(input.maxTokens);
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || contextWindow !== undefined && maxTokens > contextWindow)) throw new Error('最大输出必须是正整数且不能超过上下文窗口');
  return { provider, modelId, name, contextWindow, maxTokens, reasoning: !!input.reasoning, images: !!input.images };
}

function providerConfig(providers: JsonRecord, provider: string) {
  const value = providers[provider];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

async function updatePiModelMutation(input: UpdatePiModelInput, agentDir: string) {
  const model = validatedUpdate(input);
  const { path: modelsPath, config, providers } = readModelsConfig(agentDir);
  const existingProvider = providerConfig(providers, model.provider);
  const existingModels = Array.isArray(existingProvider.models) ? existingProvider.models.filter((item) => item && typeof item === 'object') as JsonRecord[] : [];
  const existingIndex = existingModels.findIndex((item) => item.id === model.modelId);
  if (existingIndex >= 0) existingModels[existingIndex] = { ...existingModels[existingIndex], ...modelPatch(model) };
  else {
    const overrides = existingProvider.modelOverrides && typeof existingProvider.modelOverrides === 'object' && !Array.isArray(existingProvider.modelOverrides) ? existingProvider.modelOverrides as JsonRecord : {};
    const previous = overrides[model.modelId] && typeof overrides[model.modelId] === 'object' && !Array.isArray(overrides[model.modelId]) ? overrides[model.modelId] as JsonRecord : {};
    existingProvider.modelOverrides = { ...overrides, [model.modelId]: { ...previous, ...modelPatch(model) } };
  }
  if (existingIndex >= 0) existingProvider.models = existingModels;
  writeJsonAtomic(modelsPath, { ...config, providers: { ...providers, [model.provider]: existingProvider } });
  return { provider: model.provider, modelId: model.modelId, reference: `${model.provider}/${model.modelId}` };
}

async function deletePiModelMutation(providerInput: string, modelIdInput: string, agentDir: string) {
  const provider = String(providerInput || '').trim().toLowerCase();
  const modelId = String(modelIdInput || '').trim();
  const { path: modelsPath, config, providers } = readModelsConfig(agentDir);
  const existingProvider = providerConfig(providers, provider);
  if (!providers[provider]) throw new Error('模型供应商不存在');
  const existingModels = Array.isArray(existingProvider.models) ? existingProvider.models.filter((item) => item && typeof item === 'object') as JsonRecord[] : [];
  const nextModels = existingModels.filter((item) => item.id !== modelId);
  const overrides = existingProvider.modelOverrides && typeof existingProvider.modelOverrides === 'object' && !Array.isArray(existingProvider.modelOverrides) ? existingProvider.modelOverrides as JsonRecord : {};
  const nextOverrides = { ...overrides };
  delete nextOverrides[modelId];
  if (nextModels.length === existingModels.length && Object.keys(nextOverrides).length === Object.keys(overrides).length) throw new Error('模型不存在或不可删除');
  const nextProvider = { ...existingProvider };
  if (nextModels.length) nextProvider.models = nextModels; else delete nextProvider.models;
  if (Object.keys(nextOverrides).length) nextProvider.modelOverrides = nextOverrides; else delete nextProvider.modelOverrides;
  writeJsonAtomic(modelsPath, { ...config, providers: { ...providers, [provider]: nextProvider } });
}

async function deletePiModelProviderMutation(providerInput: string, agentDir: string) {
  const provider = String(providerInput || '').trim().toLowerCase();
  const { path: modelsPath, config, providers } = readModelsConfig(agentDir);
  if (!providers[provider]) throw new Error('自定义模型供应商不存在');
  await removePiModelProviderCredential(provider, agentDir);
  const nextProviders = { ...providers };
  delete nextProviders[provider];
  writeJsonAtomic(modelsPath, { ...config, providers: nextProviders });
}

export function addPiModel(input: AddPiModelPayload, agentDir: string) { return mutateJson(path.join(agentDir, 'models.json'), () => addPiModelMutation(input, agentDir)); }
export function addLocalPiModel(input: AddLocalModelInput, agentDir: string) {
  const connection = localModelConnection(input);
  const provider = `local-${createHash('sha256').update(connection.baseUrl).digest('hex').slice(0, 12)}`;
  return mutateJson(path.join(agentDir, 'models.json'), () => addPiModelMutation({ ...input, ...connection, provider, api: 'openai-completions' }, agentDir, true));
}
export function updatePiModel(input: UpdatePiModelInput, agentDir: string) { return mutateJson(path.join(agentDir, 'models.json'), () => updatePiModelMutation(input, agentDir)); }
export function deletePiModel(provider: string, modelId: string, agentDir: string) { return mutateJson(path.join(agentDir, 'models.json'), () => deletePiModelMutation(provider, modelId, agentDir)); }
export function deletePiModelProvider(provider: string, agentDir: string) { return mutateJson(path.join(agentDir, 'models.json'), () => deletePiModelProviderMutation(provider, agentDir)); }
