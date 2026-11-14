import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { TLSSocket } from 'node:tls';
import type { TauSettings } from './types.js';

export function isLoopbackHost(host: string) {
  return host === '127.0.0.1' || host === '::1';
}

export function validateHostAccess(settings: TauSettings, projectAuth = false, trustedProxy = '') {
  if (trustedProxy && !isIP(trustedProxy)) throw new Error('TAU_TRUSTED_PROXY_IP must be one IP address.');
  if (isLoopbackHost(settings.host) && !trustedProxy) return;
  if (!settings.remoteAccess || (!projectAuth && (!settings.user || !settings.pass || settings.authEnabled === false))) {
    throw new Error('Non-loopback listening requires --remote (or TAU_REMOTE=1), user/password and enabled authentication');
  }
}

const socketAddress = (request: IncomingMessage) => request.socket.remoteAddress?.replace(/^::ffff:/i, '') || '';
const fromProxy = (request: IncomingMessage, trustedProxy: string) => !!trustedProxy && socketAddress(request) === trustedProxy.replace(/^::ffff:/i, '');

export function requestScheme(request: IncomingMessage, trustedProxy: string) {
  const forwarded = request.headers['x-forwarded-proto'];
  if (fromProxy(request, trustedProxy) && (forwarded === 'https' || forwarded === 'http')) return forwarded;
  return (request.socket as TLSSocket).encrypted ? 'https' : 'http';
}

export function allowsHostOrigin(request: IncomingMessage, host: string, trustedProxy: string) {
  if (!request.headers.host) return false;
  try {
    const origin = new URL(`${requestScheme(request, trustedProxy)}://${request.headers.host}`);
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return false;
    const local = isLoopbackHost(host) && !fromProxy(request, trustedProxy);
    if (local && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) return false;
    return request.headers.origin === undefined || request.headers.origin === origin.origin;
  } catch { return false; }
}

export function assertLocalNativeAccess(request: IncomingMessage, host: string, projectAuth: boolean, trustedProxy: string) {
  if (!projectAuth && isLoopbackHost(host) && isLoopbackHost(socketAddress(request)) && !fromProxy(request, trustedProxy)) return;
  throw Object.assign(new Error('Native operations can only be opened on the local workstation'), { code: 'native_operation_forbidden', status: 403 });
}
