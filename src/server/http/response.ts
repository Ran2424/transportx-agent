import type { ServerResponse } from 'node:http';

export function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(body));
}
