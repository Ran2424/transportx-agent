import type { ServerResponse } from 'node:http';
import { logHostEvent } from '../diagnostic-log.js';

export function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  if (status >= 400) {
    const failure = body as { error?: unknown; code?: unknown; path?: unknown } | null;
    logHostEvent(status >= 500 ? 'error' : 'warn', 'http_failed', { status, method: res.req?.method, route: res.req?.url?.split('?')[0], code: failure?.code, path: failure?.path, message: typeof failure?.error === 'string' ? failure.error : undefined });
  }
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(body));
}
