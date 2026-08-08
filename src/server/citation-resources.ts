const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCitationEnvelope, type CitationSource } from '../contracts/index.js';

type CitationResourceSession = { cwd: string; entries: Array<Record<string, any>>; resolvedSessionPlan?: { assets?: Array<{ kind?: string; path?: string }> } | null };
type CitationResourceDeps = {
  knowledgeRoot: string | ((session: CitationResourceSession) => string);
  getSession(sessionId: string): CitationResourceSession | null | undefined;
};

const ROUTE_RE = /^\/api\/live-sessions\/([^/]+)\/citation-sources\/([^/]+)\/(content|preview)$/;
const PDF_PAGE_CACHE = new Map<string, Buffer>();
const PDF_PAGE_CACHE_LIMIT = 24;

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

function within(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function findSource(entries: Array<Record<string, any>>, sourceId: string): CitationSource | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const message = entries[index]?.message;
    if (message?.role !== 'toolResult') continue;
    const envelope = parseCitationEnvelope(message.details?.citations);
    const source = envelope?.sources.find((candidate) => candidate.sourceId === sourceId);
    if (source) return source;
  }
  return null;
}

export function handleCitationResourceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  cleanPath: string,
  deps: CitationResourceDeps,
) {
  const match = cleanPath.match(ROUTE_RE);
  if (!match || req.method !== 'GET') return false;
  let sessionId: string;
  let sourceId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
    sourceId = decodeURIComponent(match[2]);
  } catch {
    json(res, 400, { error: 'Malformed citation resource URL' });
    return true;
  }
  const session = deps.getSession(sessionId);
  if (!session) {
    json(res, 404, { error: 'Live session not found' });
    return true;
  }
  const source = findSource(session.entries, sourceId);
  if (!source) {
    json(res, 404, { error: 'Citation source not found in this session' });
    return true;
  }
  const knowledgeRoot = typeof deps.knowledgeRoot === 'function' ? deps.knowledgeRoot(session) : deps.knowledgeRoot;
  if (match[3] === 'preview') {
    serveCitationPreview(req, res, session, source, knowledgeRoot);
  } else {
    serveCitationSource(res, session, source, knowledgeRoot);
  }
  return true;
}

function readCitationSource(session: CitationResourceSession, source: CitationSource, knowledgeRoot: string) {
  const root = fs.realpathSync(source.scope === 'knowledge' ? knowledgeRoot : session.cwd);
  const candidate = path.resolve(root, source.relativePath);
  const resolved = fs.realpathSync(candidate);
  if (!within(root, resolved) || !fs.statSync(resolved).isFile()) throw Object.assign(new Error('Citation source path is not allowed'), { code: 'EACCES' });
  const buffer = fs.readFileSync(resolved);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== source.sha256) throw Object.assign(new Error('Citation source has changed since it was registered'), { code: 'ECHANGED' });
  return { resolved, buffer, sha256 };
}

function sourceError(res: ServerResponse, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return json(res, 404, { error: 'Citation source not found' });
  if (code === 'EACCES') return json(res, 403, { error: 'Citation source path is not allowed' });
  if (code === 'ECHANGED') return json(res, 409, { error: 'Citation source has changed since it was registered' });
  return json(res, 500, { error: 'Failed to read citation source' });
}

function serveCitationSource(res: ServerResponse, session: CitationResourceSession, source: CitationSource, knowledgeRoot: string) {
  try {
    const { resolved, buffer, sha256 } = readCitationSource(session, source, knowledgeRoot);
    const headers: Record<string, string | number> = {
      'Content-Type': source.kind === 'document' && source.mimeType === 'text/html' ? 'text/plain; charset=utf-8' : source.mimeType,
      'Content-Length': buffer.length,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'ETag': `"${sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    };
    if (source.mimeType === 'image/svg+xml') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
    res.writeHead(200, headers);
    res.end(buffer);
  } catch (error) {
    sourceError(res, error);
  }
}

function serveCitationPreview(req: IncomingMessage, res: ServerResponse, session: CitationResourceSession, source: CitationSource, knowledgeRoot: string) {
  try {
    const { resolved, buffer, sha256 } = readCitationSource(session, source, knowledgeRoot);
    if (source.kind === 'image') {
      res.writeHead(200, {
        'Content-Type': source.mimeType,
        'Content-Length': buffer.length,
        'Cache-Control': 'private, max-age=3600',
        'ETag': `"${sha256}"`,
        'X-Content-Type-Options': 'nosniff',
        ...(source.mimeType === 'image/svg+xml' ? { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {}),
      });
      res.end(buffer);
      return;
    }
    if (source.kind !== 'pdf') return json(res, 415, { error: 'This citation source has no image preview' });
    const page = Number(new URL(req.url || '/', 'http://localhost').searchParams.get('page'));
    if (!Number.isInteger(page) || page < 1 || page > 10000) return json(res, 400, { error: 'A valid PDF page is required' });
    const cacheKey = `${sha256}:${page}`;
    let image = PDF_PAGE_CACHE.get(cacheKey);
    if (!image) {
      const rendered = Buffer.from(execFileSync('pdftocairo', ['-f', String(page), '-l', String(page), '-singlefile', '-png', '-scale-to-x', '1800', '-scale-to-y', '-1', resolved, '-'], { maxBuffer: 32 * 1024 * 1024 }));
      PDF_PAGE_CACHE.set(cacheKey, rendered);
      image = rendered;
      if (PDF_PAGE_CACHE.size > PDF_PAGE_CACHE_LIMIT) PDF_PAGE_CACHE.delete(PDF_PAGE_CACHE.keys().next().value!);
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': image.length,
      'Cache-Control': 'private, max-age=3600',
      'ETag': `"${cacheKey}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(image);
  } catch (error) {
    sourceError(res, error);
  }
}
