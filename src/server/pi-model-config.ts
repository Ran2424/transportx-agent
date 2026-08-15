const fs = require('node:fs');
const path = require('node:path');

import type { JsonRecord } from './types.js';
import { connectPiModelProvider } from './pi-model-access.js';

export const PI_MODEL_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai'] as const;
export type PiModelApi = typeof PI_MODEL_APIS[number];
export type AddPiModelInput = {
  provider: string;
  modelId: string;
  api: PiModelApi;
  baseUrl: string;
  apiKey: string;
  name?: string;
  reasoning?: boolean;
  images?: boolean;
};
type AddPiModelPayload = Omit<Partial<AddPiModelInput>, 'api'> & { api?: string };

function readObject(filePath: string, fallback: JsonRecord) {
  if (!fs.existsSync(filePath)) return fallback;
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid JSON object: ${filePath}`);
  return value as JsonRecord;
}

function writeSecureJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
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
  if (!apiKey || apiKey.length > 20_000) throw new Error('API Key 不能为空');
  if (name.length > 200) throw new Error('显示名称过长');
  return { provider, modelId, api, baseUrl, apiKey, ...(name ? { name } : {}), reasoning: !!input.reasoning, images: !!input.images };
}

export async function addPiModel(input: AddPiModelPayload, agentDir: string) {
  const model = validated(input);
  const modelsPath = path.join(agentDir, 'models.json');
  const modelsFile = readObject(modelsPath, { providers: {} });
  const providers = modelsFile.providers && typeof modelsFile.providers === 'object' && !Array.isArray(modelsFile.providers)
    ? modelsFile.providers as JsonRecord
    : {};
  const existingProvider = providers[model.provider] && typeof providers[model.provider] === 'object' && !Array.isArray(providers[model.provider])
    ? providers[model.provider] as JsonRecord
    : {};
  const existingModels = Array.isArray(existingProvider.models) ? existingProvider.models.filter((item) => item && typeof item === 'object') as JsonRecord[] : [];
  const definition: JsonRecord = {
    id: model.modelId,
    ...(model.name ? { name: model.name } : {}),
    reasoning: model.reasoning,
    input: model.images ? ['text', 'image'] : ['text'],
  };
  const nextModels = existingModels.filter((item) => item.id !== model.modelId);
  nextModels.push(definition);
  const nextProviders = {
    ...providers,
    [model.provider]: {
      ...existingProvider,
      baseUrl: model.baseUrl,
      api: model.api,
      models: nextModels,
    },
  };
  writeSecureJson(modelsPath, { ...modelsFile, providers: nextProviders });
  await connectPiModelProvider(model.provider, model.apiKey, agentDir);
  return { provider: model.provider, modelId: model.modelId, reference: `${model.provider}/${model.modelId}` };
}
