import fs = require('node:fs');
import path = require('node:path');

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Stats } from 'node:fs';
import { isWithin } from './util/path.js';

type AuthResult = { ok: boolean };

type StaticHandlerOptions = {
  reactStaticDir: string;
  mimeTypes: Record<string, string>;
  authEnabled(): boolean;
  checkAuth(req: IncomingMessage): AuthResult;
  sendAuthRequired(res: ServerResponse, req: IncomingMessage): void;
  maybeSetSessionCookie(req: IncomingMessage, res: ServerResponse, auth: AuthResult): void;
  handleApi(req: IncomingMessage, res: ServerResponse, urlPath: string): void;
};

function serveStaticFromRoot(res: ServerResponse, staticRootValue: string, requestPath: string, mimeTypes: Record<string, string>) {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }
  const staticRoot = path.resolve(staticRootValue);
  const filePath = path.resolve(path.join(staticRoot, decodedPath));
  if (!isWithin(staticRoot, filePath)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err: NodeJS.ErrnoException | null, stats: Stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

export function createStaticHandler(options: StaticHandlerOptions) {
  function serveReactStaticFile(res: ServerResponse, urlPath: string) {
    const pathname = urlPath.split('?')[0];
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400);
      res.end('Bad Request');
      return;
    }
    if (decodedPath.split('/').includes('..')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const requestPath = decodedPath === '/' || !path.extname(decodedPath) ? '/index.html' : decodedPath;
    serveStaticFromRoot(res, options.reactStaticDir, requestPath, options.mimeTypes);
  }

  function serveStaticFile(req: IncomingMessage, res: ServerResponse) {
    const urlPath = req.url || '/';
    const auth = options.checkAuth(req);
    if (options.authEnabled() && !urlPath.startsWith('/api/health') && !auth.ok) return options.sendAuthRequired(res, req);
    options.maybeSetSessionCookie(req, res, auth);
    if (urlPath.startsWith('/api/')) return options.handleApi(req, res, urlPath);
    const pathname = urlPath.split('?')[0];
    if (pathname === '/legacy' || pathname.startsWith('/legacy/')) { res.writeHead(404); res.end('Not Found'); return; }
    return serveReactStaticFile(res, urlPath);
  }

  return { serveStaticFile, serveReactStaticFile };
}
