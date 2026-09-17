const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CitationResource } from '../contracts/index.js';
import { CitationRegistryStore } from './citation-registry.js';
import { isWithin } from './util/path.js';
import { writeJson as json } from './http/response.js';

type CitationResourceSession = { id: string; cwd: string; citationRegistryId?: string; resolvedSessionPlan?: { assets?: Array<{ id?: string; kind?: string; path?: string }> } | null };
type CitationResourceDeps = {
  knowledgeRoots: Array<{ id: string; path: string }> | ((session: CitationResourceSession) => Array<{ id: string; path: string }>);
  getSession(sessionId: string): CitationResourceSession | null | undefined;
};

const ROUTE_RE = /^\/api\/live-sessions\/([^/]+)\/citation-resources\/([^/]+)\/(content|preview)$/;
const PDF_PAGE_CACHE = new Map<string, Buffer>();
const PDF_PAGE_CACHE_LIMIT = 24;

export function handleCitationResourceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  cleanPath: string,
  deps: CitationResourceDeps,
) {
  const match = cleanPath.match(ROUTE_RE);
  if (!match || req.method !== 'GET') return false;
  let sessionId: string;
  let resourceId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
    resourceId = decodeURIComponent(match[2]);
  } catch {
    json(res, 400, { error: 'Malformed citation resource URL' });
    return true;
  }
  const session = deps.getSession(sessionId);
  if (!session) {
    json(res, 404, { error: 'Live session not found' });
    return true;
  }
  let resource: CitationResource | null = null;
  try {
    const registry = new CitationRegistryStore(session.cwd, session.citationRegistryId || session.id).load();
    if (registry.sessionId !== (session.citationRegistryId || session.id)) { json(res, 404, { error: 'Citation resource not found in this session' }); return true; }
    resource = registry.resources.find((item) => item.resourceId === resourceId) || null;
  }
  catch { json(res, 409, { error: 'Citation registry is invalid' }); return true; }
  if (!resource) {
    json(res, 404, { error: 'Citation resource not found in this session' });
    return true;
  }
  const knowledgeRoots = typeof deps.knowledgeRoots === 'function' ? deps.knowledgeRoots(session) : deps.knowledgeRoots;
  if (match[3] === 'preview') serveCitationPreview(req, res, session, resource, knowledgeRoots);
  else serveCitationResource(req, res, session, resource, knowledgeRoots);
  return true;
}

function resourceRoot(session: CitationResourceSession, resource: CitationResource, knowledgeRoots: Array<{ id: string; path: string }>) {
  if (resource.scope !== 'knowledge') return { root: session.cwd, relativePath: resource.relativePath };
  const [assetId, ...segments] = resource.relativePath.split('/');
  const root = knowledgeRoots.find((item) => item.id === assetId)?.path;
  if (!root || !segments.length) throw Object.assign(new Error('Knowledge citation asset is unavailable'), { code: 'EACCES' });
  return { root, relativePath: segments.join('/') };
}

function readCitationResource(session: CitationResourceSession, resource: CitationResource, knowledgeRoots: Array<{ id: string; path: string }>) {
  const location = resourceRoot(session, resource, knowledgeRoots);
  const root = fs.realpathSync(location.root);
  const candidate = path.resolve(root, location.relativePath);
  const resolved = fs.realpathSync(candidate);
  if (!isWithin(root, resolved) || !fs.statSync(resolved).isFile()) throw Object.assign(new Error('Citation resource path is not allowed'), { code: 'EACCES' });
  const buffer = fs.readFileSync(resolved);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (sha256 !== resource.sha256) throw Object.assign(new Error('Citation resource has changed since it was registered'), { code: 'ECHANGED' });
  return { resolved, buffer, sha256 };
}

function resourceError(res: ServerResponse, error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return json(res, 404, { error: 'Citation resource not found' });
  if (code === 'EACCES') return json(res, 403, { error: 'Citation resource path is not allowed' });
  if (code === 'ECHANGED') return json(res, 409, { error: 'Citation resource has changed since it was registered' });
  return json(res, 500, { error: 'Failed to read citation resource' });
}

function serveCitationResource(req: IncomingMessage, res: ServerResponse, session: CitationResourceSession, resource: CitationResource, knowledgeRoots: Array<{ id: string; path: string }>) {
  try {
    const { resolved, buffer, sha256 } = readCitationResource(session, resource, knowledgeRoots);
    const download = new URL(req.url || '/', 'http://localhost').searchParams.get('download') === '1';
    const headers: Record<string, string | number> = {
      'Content-Type': resource.kind === 'web' && resource.mimeType === 'text/html' ? 'text/plain; charset=utf-8' : resource.mimeType,
      'Content-Length': buffer.length,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`,
      'Cache-Control': 'private, max-age=0, must-revalidate',
      'ETag': `"${sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    };
    if (resource.mimeType === 'image/svg+xml') headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'";
    res.writeHead(200, headers);
    res.end(buffer);
  } catch (error) { resourceError(res, error); }
}

function serveCitationPreview(req: IncomingMessage, res: ServerResponse, session: CitationResourceSession, resource: CitationResource, knowledgeRoots: Array<{ id: string; path: string }>) {
  try {
    const { resolved, buffer, sha256 } = readCitationResource(session, resource, knowledgeRoots);
    if (resource.kind === 'image') {
      res.writeHead(200, {
        'Content-Type': resource.mimeType,
        'Content-Length': buffer.length,
        'Cache-Control': 'private, max-age=3600',
        'ETag': `"${sha256}"`,
        'X-Content-Type-Options': 'nosniff',
        ...(resource.mimeType === 'image/svg+xml' ? { 'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" } : {}),
      });
      res.end(buffer);
      return;
    }
    if (resource.kind !== 'pdf') return json(res, 415, { error: 'This citation resource has no image preview' });
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
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, 'Cache-Control': 'private, max-age=3600', 'ETag': `"${cacheKey}"`, 'X-Content-Type-Options': 'nosniff' });
    res.end(image);
  } catch (error) { resourceError(res, error); }
}
