import type { TauSettings } from './types.js';

export function isLoopbackHost(host: string) {
  return host === '127.0.0.1' || host === '::1';
}

export function validateHostAccess(settings: TauSettings) {
  if (isLoopbackHost(settings.host)) return;
  if (!settings.remoteAccess || !settings.user || !settings.pass || settings.authEnabled === false) {
    throw new Error('Non-loopback listening requires --remote (or TAU_REMOTE=1), user/password and enabled authentication');
  }
}
