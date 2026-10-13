import type { LocalModelConnection, LocalModelConnectionInput } from '../contracts/local-model.js';

export function localModelConnection(input: LocalModelConnectionInput): LocalModelConnectionInput {
  let endpoint: URL;
  try { endpoint = new URL(String(input.baseUrl || '').trim()); }
  catch { throw new Error('本地服务地址无效'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('本地服务地址必须使用 HTTP 或 HTTPS，且不能包含凭据、查询参数或片段');
  }
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') || '/v1';
  const apiKey = String(input.apiKey || '').trim();
  if (apiKey.length > 20_000 || /[\r\n]/.test(apiKey)) throw new Error('API Key 无效');
  return { baseUrl: endpoint.toString().replace(/\/+$/, ''), ...(apiKey ? { apiKey } : {}) };
}

export async function discoverLocalModels(input: LocalModelConnectionInput): Promise<LocalModelConnection> {
  const connection = localModelConnection(input);
  let response: Response;
  try {
    response = await fetch(`${connection.baseUrl}/models`, {
      ...(connection.apiKey ? { headers: { Authorization: `Bearer ${connection.apiKey}` } } : {}),
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
  } catch {
    throw new Error('无法连接本地模型服务，请确认服务已启动且地址可访问');
  }
  if (response.status === 401 || response.status === 403) throw new Error('本地模型服务需要鉴权，请填写有效的 API Key');
  if (!response.ok) throw new Error(`获取模型列表失败（HTTP ${response.status}），请检查兼容接口地址是否包含 /v1`);
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new Error('本地模型服务未返回有效的模型列表'); }
  const entries = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(entries)) throw new Error('本地模型服务未返回兼容的模型列表');
  const models = new Map<string, { id: string; name: string }>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.length > 200 || /[\x00-\x1f]/.test(entry.id)) continue;
    const name = typeof entry.name === 'string' && entry.name.trim() && entry.name.length <= 200 ? entry.name : entry.id;
    if (!models.has(entry.id)) models.set(entry.id, { id: entry.id, name });
  }
  return { baseUrl: connection.baseUrl, models: [...models.values()] };
}
