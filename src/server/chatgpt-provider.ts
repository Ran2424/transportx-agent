import { findPackageJSON } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { CHATGPT_PLAN_PROVIDER } from '../contracts/chatgpt-plan.js';
import { CHATGPT_API, chatGPTAuthorization, requestChatGPT, type ChatGPTCredential } from './chatgpt-oauth.js';

type PiStream = NonNullable<ProviderConfig['streamSimple']>;
type PiModel = Parameters<PiStream>[0];

const toolNamespace = 'transportx';
function positiveInteger(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
const unsupported = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent',
  'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation',
  'user', 'previous_response_id',
];

export function chatGPTResponsesPayload(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ChatGPT Responses payload.');
  const payload = { ...value } as Record<string, unknown>;
  for (const key of unsupported) delete payload[key];
  payload.store = false;
  payload.stream = true;
  if (Array.isArray(payload.input)) {
    payload.input = payload.input.map((item) => {
      if (item?.type === 'message' && item.role === 'system') return { ...item, role: 'developer' };
      if (item?.type === 'function_call') return { ...item, namespace: toolNamespace };
      return item;
    });
  }
  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter((tool) => tool?.type === 'function');
    if (tools.length) payload.tools = [{ type: 'namespace', name: toolNamespace, description: 'TransportX local workspace tools.', tools }];
    else delete payload.tools;
  }
  return payload;
}

function planAccess(credential: ChatGPTCredential) {
  if (!credential.access || typeof credential.scope !== 'string' || !credential.scope.split(/\s+/).includes('chatgpt.tokens.use.direct')) {
    throw new Error('请先使用 ChatGPT 登录并授予订阅使用权限。');
  }
  return credential.access;
}

export async function registerChatGPTPlanProvider(registry: Pick<ExtensionAPI, 'registerProvider'>, agentDir: string, request: typeof fetch = requestChatGPT, newAccount = false) {
  // Use the same pinned pi-ai installation as the bundled Pi CLI.
  const { getPackageDir } = await import('@earendil-works/pi-coding-agent');
  const manifest = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(path.join(getPackageDir(), 'package.json')));
  if (!manifest) throw new Error('Bundled Pi Responses provider is unavailable.');
  const entry = (file: string) => pathToFileURL(path.join(path.dirname(manifest), 'dist', file)).href;
  const [{ streamSimple }, { openaiProvider }] = await Promise.all([
    import(entry('api/openai-responses.js')),
    import(entry('providers/openai.js')),
  ]) as [{ streamSimple: PiStream }, { openaiProvider(): { getModels(): readonly PiModel[] } }];
  const known = new Map(openaiProvider().getModels().map((model) => [model.id, model]));
  const auth = chatGPTAuthorization(agentDir, request, newAccount);
  async function fetchModels(access: string, signal?: AbortSignal) {
    const response = await request(`${CHATGPT_API}/models`, {
      headers: { Authorization: `Bearer ${access}` }, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) throw new Error(`ChatGPT 订阅模型目录返回 HTTP ${response.status}。`);
    const catalog = await response.json() as { models?: Array<{ slug?: string; display_name?: string; visibility?: string; context_window?: number; max_output_tokens?: number }> };
    if (!Array.isArray(catalog.models)) throw new Error('ChatGPT 订阅模型目录格式无效。');
    const models = new Map<string, PiModel>();
    for (const item of catalog.models) {
      if (item?.visibility !== 'list' || typeof item.slug !== 'string' || !/^[\w.-]{1,120}$/.test(item.slug)) continue;
      const reference = known.get(item.slug);
      models.set(item.slug, {
        provider: CHATGPT_PLAN_PROVIDER, api: 'openai-responses', baseUrl: CHATGPT_API,
        id: item.slug, name: typeof item.display_name === 'string' && item.display_name.trim() || item.slug,
        reasoning: reference?.reasoning ?? true, input: reference?.input ?? ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: positiveInteger(item.context_window, reference?.contextWindow || 128_000),
        maxTokens: positiveInteger(item.max_output_tokens, reference?.maxTokens || 16_384),
        ...(reference?.thinkingLevelMap ? { thinkingLevelMap: reference.thinkingLevelMap } : {}),
      });
    }
    return [...models.values()];
  }
  const config: ProviderConfig = {
    name: 'ChatGPT',
    baseUrl: CHATGPT_API,
    api: 'openai-responses',
    oauth: {
      name: 'ChatGPT subscription',
      async login(callbacks) {
        const credential = await auth.login(callbacks);
        const models = await fetchModels(planAccess(credential), callbacks.signal);
        return { ...credential, catalogAt: Date.now(), models };
      },
      refreshToken: auth.refreshToken,
      getApiKey: planAccess,
    },
    async refreshModels({ credential, store, allowNetwork, signal }) {
      if (credential?.type !== 'oauth') return [];
      const access = planAccess(credential);
      if (!allowNetwork) {
        const cached = await store.read();
        const models = cached && 'clientId' in cached && cached.clientId === credential.clientId && (cached.checkedAt ?? 0) >= Number(credential.catalogAt)
          ? cached.models : credential.models;
        return Array.isArray(models) ? models.filter((model) => model?.provider === CHATGPT_PLAN_PROVIDER && model.baseUrl === CHATGPT_API) : [];
      }
      const available = await fetchModels(access, signal);
      const cache = { models: available, checkedAt: Date.now(), clientId: credential.clientId };
      await store.write(cache);
      return available;
    },
    streamSimple(model, context, options) {
      if (!options?.apiKey) throw new Error('ChatGPT 订阅连接需要重新登录。');
      const target = { ...model, api: 'openai-responses' as const, baseUrl: CHATGPT_API };
      return streamSimple(target, context, {
        ...options,
        async onPayload(payload, requestModel) {
          const prepared = await options.onPayload?.(payload, requestModel);
          return chatGPTResponsesPayload(prepared ?? payload);
        },
      });
    },
  };
  registry.registerProvider(CHATGPT_PLAN_PROVIDER, config);
}
