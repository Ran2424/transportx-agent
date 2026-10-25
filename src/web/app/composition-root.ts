import i18n from '../i18n';
import { createAppKernel } from '../../public/kernel/app-kernel.js';
import { WebSocketClient } from '../../public/websocket-client.js';
import { AGENT_HOST_PROTOCOL_VERSION, HOST_PROTOCOL_HEADER, compatibleHostHealth } from '../../contracts/host-protocol.js';
import { appError, toAppError } from '../../contracts/errors.js';
import { projectUi } from './project-ui';

const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
const transport = new WebSocketClient(wsUrl);

export const appKernel = createAppKernel({
  transport,
  http: async (path, init) => {
    const health = await refreshHostHealth();
    const body = init?.body as { type?: unknown } | undefined;
    const diagnostic = /^\/api\/(?:migration(?:\/|$)|workspaces\/[^/]+\/(?:migration|runtime-diagnostics|runtime-recovery))/.test(path) || path === '/api/rpc' && init?.method === 'POST' && ['get_auth', 'set_auth', 'open_logs_directory'].includes(String(body?.type));
    if (!diagnostic && health.dataState !== 'ready') throw appError({ code: 'host_data_not_ready', category: 'runtime', message: health.dataState === 'blocked' ? i18n.t('workspaceFlow.indexRepairNotice') : i18n.t('workspaceFlow.indexWaitHelp'), retryable: true });
    return fetch(path, {
    method: init?.method,
    signal: init?.signal,
    headers: { ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), [HOST_PROTOCOL_HEADER]: String(AGENT_HOST_PROTOCOL_VERSION), ...(init?.headers || {}) },
    body: init?.body === undefined ? undefined : init.body instanceof FormData ? init.body : JSON.stringify(init.body),
  }).then(response => { if (response.status === 401) projectUi.onUnauthorized?.(); return response; });
  },
});

export async function refreshHostHealth() {
  const response = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
  if (response.status === 401) projectUi.onUnauthorized?.();
  const health: unknown = await response.json();
  if (!response.ok || !compatibleHostHealth(health)) throw appError({ code: 'unsupported_host', category: 'protocol', message: i18n.t('workspaceFlow.incompatibleHost'), retryable: false });
  appKernel.dispatch({ type: 'runtime/healthReceived', health });
  return health;
}

let started = false;
async function connect(force = false) {
  appKernel.dispatch({ type: 'runtime/connecting' });
  try {
    const health = await refreshHostHealth();
    if (force) transport.forceReconnect(); else transport.connect();
    if (health.dataState === 'initializing') {
      const poll = async () => {
        try { if ((await refreshHostHealth()).dataState === 'initializing') window.setTimeout(() => void poll(), 500); }
        catch (cause) { appKernel.dispatch({ type: 'error/raised', error: toAppError(cause, { code: 'host_health_failed', category: 'transport', retryable: true }) }); }
      };
      window.setTimeout(() => void poll(), 500);
    }
  } catch (cause) { appKernel.dispatch({ type: 'runtime/disconnected' }); appKernel.dispatch({ type: 'error/raised', error: toAppError(cause, { code: 'host_health_failed', category: 'transport', retryable: true }) }); }
}
export function startBrowserApplication() { if (started) return; started = true; void connect(); }
export function reconnectBrowserApplication() { void connect(true); }
