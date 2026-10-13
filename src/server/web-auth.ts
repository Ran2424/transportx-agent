import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCookies } from './auth.js';
import { readJsonObject, writeJsonAtomic } from './util/json-storage.js';

export const WEB_COOKIE_NAME = 'transportx_web_session';
export const WEB_SESSION_TTL = 7 * 24 * 3600;
type User = { salt: string; passwordHash: string };
type Session = { username: string; credential: string; expiresAt: number };

export function hashWebPassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key)));
}

export class WebAuth {
  private sessions: Record<string, Session>;
  private attempts = new Map<string, { count: number; expiresAt: number }>();

  constructor(readonly usersFile: string, readonly sessionsFile: string) {
    this.users();
    this.sessions = (readJsonObject(sessionsFile).sessions || {}) as Record<string, Session>;
  }

  private users(): Record<string, User> {
    const document = readJsonObject(this.usersFile);
    if (document.schemaVersion !== 1 || !document.users || typeof document.users !== 'object' || Array.isArray(document.users)) throw new Error('Invalid Web account whitelist');
    for (const [username, user] of Object.entries(document.users as Record<string, User>)) {
      if (!/^[a-zA-Z0-9_.@-]{1,64}$/.test(username) || !user || !/^[a-f0-9]{32}$/.test(user.salt) || !/^[a-f0-9]{128}$/.test(user.passwordHash)) throw new Error('Invalid Web account whitelist');
    }
    return document.users as Record<string, User>;
  }

  private credential(user: User) { return crypto.createHash('sha256').update(user.salt + user.passwordHash).digest('hex'); }
  private tokenKey(token: string) { return crypto.createHash('sha256').update(token).digest('hex'); }
  private save() { writeJsonAtomic(this.sessionsFile, { sessions: this.sessions }); }

  authenticate(headers: IncomingMessage['headers']): Session | null {
    const token = parseCookies(headers.cookie)[WEB_COOKIE_NAME];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
    const session = this.sessions[this.tokenKey(token)];
    if (!session || session.expiresAt <= Math.floor(Date.now() / 1000)) return null;
    const users = this.users();
    const user = Object.hasOwn(users, session.username) ? users[session.username] : undefined;
    return user && session.credential === this.credential(user) ? session : null;
  }

  async login(username: string, password: string): Promise<string | null> {
    const users = this.users();
    const user = Object.hasOwn(users, username) ? users[username] : undefined;
    const key = await hashWebPassword(password, user?.salt || '00000000000000000000000000000000');
    if (!user || !crypto.timingSafeEqual(key, Buffer.from(user.passwordHash, 'hex'))) return null;
    const now = Math.floor(Date.now() / 1000);
    for (const [id, session] of Object.entries(this.sessions)) if (session.expiresAt <= now) delete this.sessions[id];
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions[this.tokenKey(token)] = { username, credential: this.credential(user), expiresAt: now + WEB_SESSION_TTL };
    this.save();
    return token;
  }

  logout(headers: IncomingMessage['headers']) {
    const token = parseCookies(headers.cookie)[WEB_COOKIE_NAME];
    if (token) { delete this.sessions[this.tokenKey(token)]; this.save(); }
  }

  private cookie(token: string, secure: boolean) {
    return `${WEB_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? WEB_SESSION_TTL : 0}${secure ? '; Secure' : ''}`;
  }

  async handle(req: IncomingMessage, res: ServerResponse, originAllowed: boolean) {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!originAllowed) { reply(403, { error: 'Origin not allowed' }); return; }
    if (pathname === '/api/auth/session' && req.method === 'GET') {
      const session = this.authenticate(req.headers);
      reply(200, { enabled: true, username: session?.username || null }); return;
    }
    if (req.method !== 'POST' || !['/api/auth/login', '/api/auth/logout'].includes(pathname)) { reply(404, { error: 'Not found' }); return; }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) { reply(415, { error: 'JSON required' }); return; }
    const secure = req.headers['x-forwarded-proto'] === 'https';
    if (pathname === '/api/auth/logout') {
      this.logout(req.headers);
      res.setHeader('Set-Cookie', this.cookie('', secure));
      reply(200, { success: true }); return;
    }
    const now = Date.now();
    for (const [key, attempt] of this.attempts) if (attempt.expiresAt <= now) this.attempts.delete(key);
    const address = req.socket.remoteAddress || 'unknown';
    const attempt = this.attempts.get(address) || { count: 0, expiresAt: now + 60_000 };
    if (attempt.count >= 20 || this.attempts.size >= 1000) { reply(429, { error: 'Too many login attempts' }); return; }
    attempt.count++; this.attempts.set(address, attempt);
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 4096) { reply(413, { error: 'Login request too large' }); return; }
    }
    let input: { username?: unknown; password?: unknown };
    try { input = JSON.parse(body); } catch { reply(400, { error: 'Invalid JSON' }); return; }
    if (!input || typeof input.username !== 'string' || typeof input.password !== 'string' || input.username.length > 64 || input.password.length > 256) { reply(400, { error: 'Invalid credentials' }); return; }
    const token = await this.login(input.username, input.password);
    if (!token) { reply(401, { error: 'Invalid credentials' }); return; }
    res.setHeader('Set-Cookie', this.cookie(token, secure));
    reply(200, { success: true });
  }
}
