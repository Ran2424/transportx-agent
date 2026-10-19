import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { citationRelativePath, type CitationResourceErrorCode, type CitationSourceVersion } from '../contracts/index.js';
import { resourceSecurityHeaders } from './resource-policy.js';
import { CitationRegistryStore } from './citation-registry.js';
import { isWithin } from './util/path.js';
import { writeJson as json } from './http/response.js';

export type CitationResourceSession = { id: string; cwd: string; citationRegistryId?: string; resolvedSessionPlan?: { assets?: Array<{ id?: string; kind?: string; path?: string }> } | null };
export function hashCitationFile(file: string) {
  const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.allocUnsafe(64 * 1024);
  try { let bytes: number; while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
export function locateCitationFile(session: CitationResourceSession, content: { scope: 'session' | 'asset'; assetId?: string; path: string }) {
  if (!citationRelativePath(content.path)) throw Object.assign(new Error('Citation path is invalid.'), { code: 'EACCES' });
  const asset = content.scope === 'asset' ? session.resolvedSessionPlan?.assets?.find((item) => item.id === content.assetId && (item.kind === 'knowledge' || item.kind === 'data')) : undefined;
  const rootPath = content.scope === 'session' ? session.cwd : asset?.path;
  if (!rootPath) throw Object.assign(new Error('Citation asset is not authorized in this session.'), { code: 'EACCES' });
  const root = fs.realpathSync(rootPath), candidate = path.resolve(root, content.path);
  if (!isWithin(root, candidate) || fs.lstatSync(candidate).isSymbolicLink()) throw Object.assign(new Error('Citation path is outside its authorized root.'), { code: 'EACCES' });
  const resolved = fs.realpathSync(candidate), stat = fs.statSync(resolved);
  if (!isWithin(root, resolved) || !stat.isFile()) throw Object.assign(new Error('Citation source is not an authorized file.'), { code: 'EACCES' });
  return { resolved, stat };
}
export function verifyCitationFile(session: CitationResourceSession, source: CitationSourceVersion) {
  if (source.content.kind !== 'file') throw Object.assign(new Error('Inline evidence has no original file.'), { code: 'ENOTSUP' });
  const location = locateCitationFile(session, source.content);
  if (location.stat.size !== source.content.size || hashCitationFile(location.resolved) !== source.content.sha256) throw Object.assign(new Error('The cited version is unavailable: source content has changed.'), { code: 'ECHANGED' });
  return location;
}
export function citationResourceFailure(error: unknown): { code: CitationResourceErrorCode; status: number; error: string } {
  const code = (error as NodeJS.ErrnoException).code;
  const failure = code === 'ENOENT' || code === 'ENOTDIR' ? { code: 'missing' as const, status: 404 }
    : code === 'EACCES' || code === 'EPERM' ? { code: 'forbidden' as const, status: 403 }
    : code === 'ECHANGED' ? { code: 'content-changed' as const, status: 409 }
    : code === 'EVERSION' ? { code: 'view-mismatch' as const, status: 409 }
    : code === 'ENOTSUP' ? { code: 'unsupported' as const, status: 415 }
    : { code: 'read-failed' as const, status: 500 };
  return { ...failure, error: error instanceof Error ? error.message : 'Citation resource cannot be read.' };
}
export function citationResourceError(res: ServerResponse, error: unknown) {
  const failure = citationResourceFailure(error);
  res.setHeader('X-Citation-Error', failure.code);
  json(res, failure.status, { error: failure.error, code: failure.code });
}
export function handleCitationResourceRoute(req: IncomingMessage, res: ServerResponse, cleanPath: string, deps: { getSession(id: string): CitationResourceSession | null | undefined }) {
  const match = cleanPath.match(/^\/api\/live-sessions\/([^/]+)\/citation-resources\/([^/]+)\/(content|preview)$/);
  if (!match || !['GET', 'HEAD'].includes(req.method || '')) return false;
  try {
    const session = deps.getSession(decodeURIComponent(match[1]));
    if (!session) throw Object.assign(new Error('Live session not found.'), { code: 'ENOENT' });
    const source = new CitationRegistryStore(session.cwd, session.citationRegistryId || session.id).source(decodeURIComponent(match[2]));
    if (!source) throw Object.assign(new Error('SourceVersion not found in this session.'), { code: 'ENOENT' });
    const expected = new URL(req.url || '/', 'http://localhost').searchParams.get('sha256');
    if (expected && expected !== source.content.sha256) throw Object.assign(new Error('Citation source version does not match this view.'), { code: 'EVERSION' });
    const { resolved, stat } = verifyCitationFile(session, source);
    const mimeType = source.content.kind === 'file' ? source.content.mimeType : 'text/plain';
    if (match[3] === 'preview' && !mimeType.startsWith('image/')) throw Object.assign(new Error('Use evidence details or the original viewer for this source.'), { code: 'ENOTSUP' });
    const download = new URL(req.url || '/', 'http://localhost').searchParams.get('download') === '1';
    res.writeHead(200, { 'Content-Type': mimeType === 'text/html' ? 'text/plain; charset=utf-8' : mimeType, 'Content-Length': stat.size, 'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(path.basename(resolved))}`, 'Cache-Control': 'private, no-cache', ETag: `"${source.content.sha256}"`, ...resourceSecurityHeaders(mimeType) });
    if (req.method === 'HEAD') res.end();
    else { const stream = fs.createReadStream(resolved); stream.on('error', () => res.destroy()); stream.pipe(res); }
  } catch (error) { citationResourceError(res, error); }
  return true;
}
