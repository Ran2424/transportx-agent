const fs = require('node:fs');

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonRecord, RpcCommand, RpcResponse } from './types.js';
import type { LiveSessionManager, PiRpcSession } from './sessions.js';
import type { SessionAttachmentSource } from '../contracts/attachments.js';
import { ServerRouter } from './router.js';

type ApiRouteServices = {
  sessions: LiveSessionManager;
  snapshotSchemaVersion: number;
  health(): JsonRecord;
  json(res: ServerResponse, status: number, data: unknown): void;
  errorMessage(error: unknown): string;
  errorStatus(error: unknown): number;
  readBody(req: IncomingMessage): Promise<RpcCommand>;
  resolveSessionFile(filePath: string): string;
  sessionCwd(value: unknown): string | null;
  readSessionHeaderCwd(filePath: string): string | null;
  readSessionEntries(filePath: string): unknown[];
  deriveSessionName(entries: JsonRecord[]): string | null;
  serveProjects(res: ServerResponse): void;
  serveSessions(res: ServerResponse): void;
  serveSearch(res: ServerResponse, query: string): void | Promise<void>;
  resolveLivePath(session: PiRpcSession, requestedPath?: string | null): string;
  serveFiles(res: ServerResponse, path: string): void;
  serveFileContent(res: ServerResponse, path: string): void;
  serveResources(res: ServerResponse, session: PiRpcSession): Promise<void>;
  servePreview(res: ServerResponse, path: string): void;
  resolveOpen(body: RpcCommand): string;
  openNative(path: string): Promise<void>;
  handleRpc(command: RpcCommand): Promise<RpcResponse>;
  renderReportPdf(title: string, html: string): Promise<Buffer>;
  serveSessionFile(res: ServerResponse, dirName: string, fileName: string): void;
  listAttachments(cwd: string): unknown[];
  uploadAttachments(cwd: string, req: IncomingMessage, source: SessionAttachmentSource): Promise<unknown[]>;
  deleteAttachment(cwd: string, id: string): void;
};

export function createApiRouter(services: ApiRouteServices) {
  const router = new ServerRouter(services);
  router
    .get('/api/health', ({ res, deps }) => deps.json(res, 200, deps.health()))
    .get('/api/live-sessions', ({ res, deps }) => deps.json(res, 200, { sessions: deps.sessions.list() }))
    .post('/api/live-sessions', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const session = await deps.sessions.create({ cwd: body.cwd, model: body.model || '', sessionName: name || null });
        deps.json(res, 200, { session: session.metadata() });
      } catch (error) { deps.json(res, 400, { error: deps.errorMessage(error) }); }
    })
    .post('/api/live-sessions/resume', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        if (!body.filePath || typeof body.filePath !== 'string') return deps.json(res, 400, { error: 'filePath required' });
        const resolvedFile = deps.resolveSessionFile(body.filePath);
        const existing = deps.sessions.findBySessionFile(resolvedFile);
        if (existing) return deps.json(res, 200, { session: existing.metadata(), reused: true });
        const cwd = deps.sessionCwd(body.cwd) || deps.readSessionHeaderCwd(resolvedFile);
        if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
          return deps.json(res, 400, { error: 'Cannot resume session because its project directory no longer exists' });
        }
        const entries = deps.readSessionEntries(resolvedFile) as JsonRecord[];
        const sessionName = deps.deriveSessionName(entries);
        const reusedPending = deps.sessions.hasPendingResume(resolvedFile);
        const session = await deps.sessions.resume({ sessionFile: resolvedFile, cwd, model: body.model || '', entries, sessionName });
        deps.json(res, 200, { session: session.metadata(), ...(reusedPending ? { reused: true } : {}) });
      } catch (error) { deps.json(res, 400, { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/live-sessions\/([^/]+)\/snapshot$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (session) deps.json(res, 200, session.snapshot());
    })
    .get(/^\/api\/live-sessions\/([^/]+)\/attachments$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (session) deps.json(res, 200, { attachments: deps.listAttachments(session.cwd) });
    })
    .post(/^\/api\/live-sessions\/([^/]+)\/attachments$/, async ({ req, res, url, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      const source = url.searchParams.get('source');
      if (source !== 'picker' && source !== 'drop' && source !== 'clipboard') return deps.json(res, 400, { error: 'Invalid attachment source' });
      try { deps.json(res, 200, { attachments: await deps.uploadAttachments(session.cwd, req, source) }); }
      catch (cause) { deps.json(res, deps.errorStatus(cause), { error: deps.errorMessage(cause) }); }
    })
    .delete(/^\/api\/live-sessions\/([^/]+)\/attachments\/([^/]+)$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.deleteAttachment(session.cwd, decodeURIComponent(params[1])); deps.json(res, 200, { success: true }); }
      catch (cause) { deps.json(res, deps.errorStatus(cause), { error: deps.errorMessage(cause) }); }
    })
    .get(/^\/api\/live-sessions\/([^/]+)$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (session) deps.json(res, 404, { error: 'Not found' });
    })
    .delete(/^\/api\/live-sessions\/([^/]+)$/, async ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      await deps.sessions.delete(session.id, 'closed_by_user');
      deps.json(res, 200, { success: true });
    })
    .get('/api/projects', ({ res, deps }) => deps.serveProjects(res))
    .get('/api/sessions', ({ res, deps }) => deps.serveSessions(res))
    .get('/api/search', ({ res, url, deps }) => deps.serveSearch(res, url.searchParams.get('q') || ''))
    .get('/api/files', ({ res, url, deps }) => {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return deps.json(res, 400, { error: 'No live session selected' });
      const session = deps.sessions.get(sessionId);
      if (!session) return deps.json(res, 404, { error: 'Live session not found' });
      try { deps.serveFiles(res, deps.resolveLivePath(session, url.searchParams.get('path') || session.cwd)); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .get('/api/file/content', ({ res, url, deps }) => {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return deps.json(res, 400, { error: 'No live session selected' });
      const session = deps.sessions.get(sessionId);
      if (!session) return deps.json(res, 404, { error: 'Live session not found' });
      try { deps.serveFileContent(res, deps.resolveLivePath(session, url.searchParams.get('path'))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .get('/api/session-resources', async ({ res, url, deps }) => {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return deps.json(res, 400, { error: 'No live session selected' });
      const session = deps.sessions.get(sessionId);
      if (!session) return deps.json(res, 404, { error: 'Live session not found' });
      try { await deps.serveResources(res, session); }
      catch (error) { deps.json(res, 500, { error: deps.errorMessage(error) }); }
    })
    .get('/api/file/preview', ({ res, url, deps }) => {
      const sessionId = url.searchParams.get('sessionId');
      if (!sessionId) return deps.json(res, 400, { error: 'No live session selected' });
      const session = deps.sessions.get(sessionId);
      if (!session) return deps.json(res, 404, { error: 'Live session not found' });
      try { deps.servePreview(res, deps.resolveLivePath(session, url.searchParams.get('path'))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/open', async ({ req, res, deps }) => {
      try {
        await deps.openNative(deps.resolveOpen(await deps.readBody(req)));
        deps.json(res, 200, { ok: true });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/reports/pdf', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : '';
        const html = typeof body.html === 'string' ? body.html : '';
        if (!title || !html) return deps.json(res, 400, { error: 'title and html required' });
        if (html.length > 5 * 1024 * 1024) return deps.json(res, 413, { error: 'Rendered report is too large' });
        const pdf = await deps.renderReportPdf(title, html);
        const filename = `${title.replace(/\.mdx?$/i, '') || 'report'}.pdf`;
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(pdf.length),
          'Content-Disposition': `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store',
        });
        res.end(pdf);
      } catch (error) { deps.json(res, 500, { error: deps.errorMessage(error) }); }
    })
    .post('/api/rpc', async ({ req, res, deps }) => {
      try { deps.json(res, 200, await deps.handleRpc(await deps.readBody(req))); }
      catch (error) { deps.json(res, 400, { error: deps.errorMessage(error) }); }
    })
    .post('/api/sessions/delete', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        if (!body.filePath || typeof body.filePath !== 'string') return deps.json(res, 400, { error: 'filePath required' });
        fs.unlinkSync(deps.resolveSessionFile(body.filePath));
        deps.json(res, 200, { success: true });
      } catch (error) { deps.json(res, 400, { error: deps.errorMessage(error) }); }
    })
    .get('/api/session-history', ({ res, url, deps }) => {
      try {
        const sessionFile = deps.resolveSessionFile(url.searchParams.get('filePath') || '');
        deps.json(res, 200, { schemaVersion: deps.snapshotSchemaVersion, entries: deps.readSessionEntries(sessionFile) });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/sessions\/([^/]+)\/([^/]+)$/, ({ res, params, deps }) => deps.serveSessionFile(res, params[0], params[1]));
  return router;
}

function resolveLiveSessionParam(res: ServerResponse, value: string, services: ApiRouteServices) {
  let id: string;
  try { id = decodeURIComponent(value); }
  catch { services.json(res, 400, { error: 'Malformed live session id' }); return null; }
  const session = services.sessions.get(id);
  if (!session) { services.json(res, 404, { error: 'Live session not found' }); return null; }
  return session;
}
