import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { ProviderConfig } from '@earendil-works/pi-coding-agent' with { 'resolution-mode': 'import' };
import { CHATGPT_PLAN_PROVIDER } from '../contracts/chatgpt-plan.js';
import { readJsonObject, writeJsonAtomic } from './util/json-storage.js';

export const CHATGPT_API = 'https://api.openai.com/v1';
type PiOAuth = NonNullable<ProviderConfig['oauth']>;
export type ChatGPTCredential = Awaited<ReturnType<PiOAuth['login']>>;
const issuer = 'https://auth.openai.com';
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const planScope = 'chatgpt.tokens.use.direct';
const registrationClient = 'dynamic_agent_client';

async function createPiProxyFetch(): Promise<typeof fetch> {
  const { getPackageDir } = await import('@earendil-works/pi-coding-agent');
  const { EnvHttpProxyAgent, fetch: request } = createRequire(path.join(getPackageDir(), 'package.json'))('undici') as {
    EnvHttpProxyAgent: new (options: { allowH2: boolean }) => object;
    fetch(input: Parameters<typeof fetch>[0], options: RequestInit & { dispatcher: object }): Promise<Response>;
  };
  const dispatcher = new EnvHttpProxyAgent({ allowH2: false });
  return (input, options) => request(input, { ...options, dispatcher });
}

let proxyFetch: Promise<typeof fetch> | undefined;
export const requestChatGPT: typeof fetch = async (input, options) => {
  // Match Pi RPC's environment proxy handling without replacing the Host's global fetch.
  proxyFetch ??= createPiProxyFetch();
  return (await proxyFetch)(input, options);
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function oauthJson(request: typeof fetch, url: string, options: RequestInit = {}) {
  const response = await request(url, { ...options, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]) });
  if (!response.ok) throw new Error(`ChatGPT 授权服务返回 HTTP ${response.status}，请重试登录。`);
  return await response.json() as Record<string, unknown>;
}

function metadata(request: typeof fetch, signal?: AbortSignal) {
  return oauthJson(request, `${issuer}/.well-known/openid-configuration`, { signal });
}

function issuerUrl(value: unknown) {
  const url = new URL(text(value));
  if (url.origin !== issuer || url.username || url.password) throw new Error('ChatGPT 授权服务地址无效。');
  return url.href;
}

async function verifyIdentity(request: typeof fetch, idToken: string, clientId: string, nonce: string, signal: AbortSignal) {
  const [headerPart, claimsPart, signature, extra] = idToken.split('.');
  if (!headerPart || !claimsPart || !signature || extra !== undefined) throw new Error('ChatGPT 身份令牌格式无效。');
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString());
  if (header?.alg !== 'RS256' || !text(header.kid)) throw new Error('ChatGPT 身份令牌的签名信息无效。');
  if (claims?.iss !== issuer) throw new Error('ChatGPT 身份令牌的签发方不匹配。');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (audience.length !== 1 || audience[0] !== clientId || (claims.azp !== undefined && claims.azp !== clientId)) {
    throw new Error('ChatGPT 身份令牌的客户端标识不匹配。');
  }
  if (claims.nonce !== nonce) throw new Error('ChatGPT 身份令牌与本次登录请求不匹配，请重新登录。');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) throw new Error('ChatGPT 身份令牌已过期或有效期无效，请重新登录。');
  if (!text(claims.sub)) throw new Error('ChatGPT 身份令牌缺少账户标识。');
  const discovery = await metadata(request, signal);
  const { keys } = await oauthJson(request, issuerUrl(discovery.jwks_uri), { signal });
  const key = Array.isArray(keys) && keys.find((item) => item?.kid === header.kid && item.kty === 'RSA' && (!item.use || item.use === 'sig'));
  if (!key || !verify('RSA-SHA256', Buffer.from(`${headerPart}.${claimsPart}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url'))) {
    throw new Error('ChatGPT 身份签名验证失败，请重新登录。');
  }
  return { subject: text(claims.sub), email: claims.email_verified === true ? text(claims.email) : '' };
}

function credentials(token: Record<string, unknown>, previous: { clientId: string; scope?: string }): ChatGPTCredential {
  const access = text(token.access_token), refresh = text(token.refresh_token);
  const scope = text(token.scope) || previous.scope || '';
  if (!scope.split(/\s+/).includes(planScope)) throw new Error('未授予 ChatGPT 订阅使用权限。');
  if (!access || !refresh || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
    throw new Error('ChatGPT 返回的订阅凭据不完整，请重新登录。');
  }
  return { ...previous, access, refresh, expires: Date.now() + token.expires_in * 1000, scope };
}

function exchange(request: typeof fetch, fields: Record<string, string>, signal?: AbortSignal) {
  return oauthJson(request, tokenEndpoint, {
    method: 'POST',
    body: new URLSearchParams({ ...fields, resource: CHATGPT_API }),
    signal,
  });
}

export function chatGPTAuthorization(agentDir: string, request: typeof fetch = requestChatGPT, newAccount = false) {
  const registrationFile = path.join(agentDir, 'chatgpt-registration.json');
  return {
    async login(callbacks: Parameters<PiOAuth['login']>[0]): Promise<ChatGPTCredential> {
      const signal = AbortSignal.any([AbortSignal.timeout(180_000), ...(callbacks.signal ? [callbacks.signal] : [])]);
      const registration = readJsonObject(registrationFile);
      const hostId = text(registration.hostId) || `urn:uuid:${randomUUID()}`;
      const saved = readJsonObject(path.join(agentDir, 'auth.json'))[CHATGPT_PLAN_PROVIDER] as ChatGPTCredential | undefined;
      const registered = saved?.clientId ? saved : registration;
      const registeredClient = newAccount ? '' : text(registered.clientId);
      if (!registration.hostId) writeJsonAtomic(registrationFile, { hostId });
      const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      let receive!: (value: { code: string; clientId: string }) => void;
      let reject!: (reason: Error) => void;
      const callback = new Promise<{ code: string; clientId: string }>((resolve, fail) => { receive = resolve; reject = fail; });
      const abort = () => reject(new Error('ChatGPT 授权已取消或超时。'));
      const server = createServer((req, res) => {
        const query = URL.parse(req.url || '/', 'http://127.0.0.1');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (req.method !== 'GET' || query?.pathname !== '/auth/callback' || query.searchParams.get('state') !== state) {
          res.writeHead(400).end('Invalid ChatGPT callback.');
          return;
        }
        const code = query.searchParams.get('code');
        const returnedClient = query.searchParams.get('client_id');
        const clientId = returnedClient || registeredClient;
        if (query.searchParams.has('error') || !code || !clientId || clientId === registrationClient || (registeredClient && clientId !== registeredClient)) {
          res.writeHead(400).end('ChatGPT authorization was not completed. Return to TransportX.');
          reject(new Error('ChatGPT 授权未完成，请重试。'));
          return;
        }
        res.end('Authorization code received. Return to TransportX to check the connection status.');
        receive({ code, clientId });
      });
      try {
        signal.throwIfAborted();
        await once(server.listen(0, '127.0.0.1'), 'listening', { signal });
        const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/callback`;
        const authorizationUrl = new URL(`${issuer}/api/accounts/authorize`);
        authorizationUrl.search = new URLSearchParams({
          client_id: registeredClient || registrationClient,
          ...(registeredClient ? {} : { agent_name_hint: 'TransportX Agent' }),
          ext_agent_host_id: hostId,
          response_type: 'code', redirect_uri: redirectUri, resource: CHATGPT_API,
          scope: `openid profile email offline_access resource.invoke ${planScope}`,
          state, nonce, code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        }).toString();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        callbacks.onAuth({ url: authorizationUrl.href });
        const { code, clientId } = await callback;
        const token = await exchange(request, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri }, signal);
        const identity = await verifyIdentity(request, text(token.id_token), clientId, nonce, signal);
        if (registeredClient && registered.subject !== identity.subject) throw new Error('ChatGPT 登录账户与已登记的账户不一致。');
        const credential = credentials(token, { clientId });
        writeJsonAtomic(registrationFile, { hostId, clientId, ...identity });
        return { ...credential, ...identity, idToken: text(token.id_token) };
      } finally {
        signal.removeEventListener('abort', abort);
        server.close();
        server.closeAllConnections();
      }
    },
    async refreshToken(current: ChatGPTCredential) {
      const clientId = text(current.clientId);
      if (!clientId) throw new Error('ChatGPT 订阅连接需要重新登录。');
      const token = await exchange(request, { grant_type: 'refresh_token', client_id: clientId, refresh_token: current.refresh });
      return { ...current, ...credentials(token, { clientId, scope: text(current.scope) }) };
    },
    async revoke(current: ChatGPTCredential) {
      const clientId = text(current.clientId);
      if (!clientId) return;
      const { revocation_endpoint } = await metadata(request);
      const response = await request(issuerUrl(revocation_endpoint), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        body: new URLSearchParams({ token: current.refresh, token_type_hint: 'refresh_token', client_id: clientId }),
      });
      if (!response.ok) throw new Error('ChatGPT 授权撤销失败。');
    },
  };
}
