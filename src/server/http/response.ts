import type { ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream';
import { logHostEvent, redactDiagnosticText } from '../diagnostic-log.js';

export function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  const failure = body as { success?: unknown; error?: unknown; code?: unknown; path?: unknown } | null | undefined;
  if (status >= 400) {
    logHostEvent(status >= 500 ? 'error' : 'warn', 'http_failed', { status, method: res.req?.method, route: res.req?.url?.split('?')[0], code: failure?.code, path: failure?.path, message: typeof failure?.error === 'string' ? failure.error : undefined });
  }
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const payload = JSON.stringify(body, status >= 400 || failure?.success === false ? (key, value: unknown) => {
    if (/^(?:api[_-]?key|authorization|cookie|password|[\w-]*token|secret)$/i.test(key)) return '[REDACTED]';
    return typeof value === 'string' ? redactDiagnosticText(value) : value;
  } : undefined);
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(payload);
}

export function failRequest(res: ServerResponse, error: unknown, status = 500) {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  logHostEvent('error', 'http_operation_failed', { status, method: res.req?.method, route: res.req?.url?.split('?')[0], causeCode: code });
  writeJson(res, status, { code: status === 503 ? 'update_preparing' : 'http_operation_failed', error: status === 503 ? 'Host is preparing an update' : 'The Host could not complete this request.' });
}

export function streamResponse(source: Readable, res: ServerResponse) {
  pipeline(source, res, (error) => {
    if (!error) return;
    const code = (error as NodeJS.ErrnoException).code;
    logHostEvent(code === 'ERR_STREAM_PREMATURE_CLOSE' ? 'debug' : 'warn', 'http_stream_closed', {
      method: res.req?.method, route: res.req?.url?.split('?')[0], status: res.statusCode, code,
    });
  });
}
