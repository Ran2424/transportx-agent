import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUTH_CONFIGURED, PROJECT_AUTH, TAU_SETTINGS, saveTauSetting } from './config.js';
import { SESSION_COOKIE_NAME, SESSION_REFRESH_THRESHOLD_SECONDS, buildSessionCookie, issueSessionToken, parseCookies, verifySessionToken } from './auth.js';
import { requestScheme } from './host-access.js';
import { logHostEvent } from './diagnostic-log.js';

type AuthResult = { ok: boolean; via: 'disabled' | 'basic' | 'cookie' | 'project' | 'none'; expiresAt?: number };

export function createHostAuthentication(trustedProxy: string) {
  let authEnabled = !!PROJECT_AUTH || (AUTH_CONFIGURED && TAU_SETTINGS.authEnabled !== false);

  function checkBasicAuth(req: IncomingMessage) {
    if (!authEnabled) return true;
    const header = req.headers.authorization;
    if (!header?.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice(6), 'base64').toString(), colon = decoded.indexOf(':');
    return colon !== -1 && decoded.slice(0, colon) === TAU_SETTINGS.user && decoded.slice(colon + 1) === TAU_SETTINGS.pass;
  }

  function checkAuth(req: IncomingMessage): AuthResult {
    if (PROJECT_AUTH) {
      try { return { ok: !!PROJECT_AUTH.authenticate(req.headers), via: 'project' }; }
      catch { return { ok: false, via: 'none' }; }
    }
    if (!authEnabled) return { ok: true, via: 'disabled' };
    if (checkBasicAuth(req)) return { ok: true, via: 'basic' };
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
    if (token) {
      const verdict = verifySessionToken(token);
      if (verdict.valid) return { ok: true, via: 'cookie', expiresAt: verdict.expiresAt };
    }
    return { ok: false, via: 'none' };
  }

  function maybeSetSessionCookie(req: IncomingMessage, res: ServerResponse, auth: AuthResult) {
    if (PROJECT_AUTH) return;
    if (!authEnabled || !auth.ok || auth.via === 'disabled') return;
    let expiresAt = auth.expiresAt;
    if (expiresAt === undefined) {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
      if (token) {
        const verdict = verifySessionToken(token);
        if (verdict.valid) expiresAt = verdict.expiresAt;
      }
    }
    if (expiresAt !== undefined && expiresAt - Math.floor(Date.now() / 1000) >= SESSION_REFRESH_THRESHOLD_SECONDS) return;
    res.setHeader('Set-Cookie', buildSessionCookie(issueSessionToken(), { secure: requestScheme(req, trustedProxy) === 'https' }));
  }

  function sendAuthRequired(res: ServerResponse, req: IncomingMessage) {
    if (parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME]) res.setHeader('Set-Cookie', buildSessionCookie('', { secure: requestScheme(req, trustedProxy) === 'https', clear: true }));
    res.writeHead(401, { ...(PROJECT_AUTH ? {} : { 'WWW-Authenticate': 'Basic realm="Tau"' }), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
  }

  function setEnabled(enabled: boolean) {
    if (!saveTauSetting('authEnabled', enabled)) {
      logHostEvent('warn', 'auth_settings_commit_failed');
      return false;
    }
    authEnabled = enabled;
    return true;
  }

  return { checkAuth, sendAuthRequired, maybeSetSessionCookie, setEnabled, isEnabled: () => authEnabled, setEnabledForTest: (enabled: boolean) => { authEnabled = enabled; } };
}
