const path = require('node:path');

export type PiModelProviderAccess = {
  id: string;
  name: string;
  connected: boolean;
  credentialStored: boolean;
  authMethods: Array<'api_key' | 'oauth'>;
  authSource?: string;
  modelCount: number;
};

async function createRuntime(agentDir: string) {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  return ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: path.join(agentDir, 'models.json'),
    allowModelNetwork: false,
  });
}

type PiRuntime = Awaited<ReturnType<typeof createRuntime>>;

function summarizeProvider(runtime: PiRuntime, providerId: string, storedProviderIds: Set<string>): PiModelProviderAccess {
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new Error(`未知模型供应商：${providerId}`);
  const status = runtime.getProviderAuthStatus(providerId);
  const authMethods: PiModelProviderAccess['authMethods'] = [];
  if (provider.auth.apiKey?.login) authMethods.push('api_key');
  if (provider.auth.oauth) authMethods.push('oauth');
  return {
    id: provider.id,
    name: provider.name || provider.id,
    connected: status.configured,
    credentialStored: storedProviderIds.has(provider.id),
    authMethods,
    ...(status.label || status.source ? { authSource: status.label || status.source } : {}),
    modelCount: runtime.getModels(provider.id).length,
  };
}

export async function listPiModelProviders(agentDir: string) {
  const runtime = await createRuntime(agentDir);
  const storedProviderIds = new Set((await runtime.listCredentials()).map((item) => item.providerId));
  return runtime.getProviders()
    .map((provider) => summarizeProvider(runtime, provider.id, storedProviderIds))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function listAvailablePiModels(agentDir: string) {
  const runtime = await createRuntime(agentDir);
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

export async function connectPiModelProvider(providerIdInput: string, apiKeyInput: string, agentDir: string) {
  const providerId = providerIdInput.trim();
  const apiKey = apiKeyInput.trim();
  if (!providerId) throw new Error('请选择模型供应商');
  if (!apiKey || apiKey.length > 20_000) throw new Error('API Key 不能为空');
  const runtime = await createRuntime(agentDir);
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
  return summarizeProvider(runtime, providerId, storedProviderIds);
}

export async function disconnectPiModelProvider(providerIdInput: string, agentDir: string) {
  const providerId = providerIdInput.trim();
  if (!providerId) throw new Error('模型供应商不能为空');
  const runtime = await createRuntime(agentDir);
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new Error(`未知模型供应商：${providerId}`);
  const storedProviderIds = new Set((await runtime.listCredentials()).map((item) => item.providerId));
  if (!storedProviderIds.has(providerId)) {
    throw new Error(`供应商 ${provider.name} 使用环境变量或模型配置接入，无法在工作台中移除`);
  }
  await runtime.logout(providerId);
}
