const fs = require('node:fs');
const crypto = require('node:crypto');

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JsonRecord, RpcCommand, RpcResponse } from './types.js';
import type { LiveSessionManager, PiRpcSession } from './sessions.js';
import type { SessionAttachmentSource } from '../contracts/attachments.js';
import { ServerRouter } from './router.js';
import type { CitationService } from './citation-service.js';
import type { SpatialAnalysisService } from './spatial-analysis-service.js';
import type { VideoService } from './video-service.js';
import { parseSessionProfileStructured } from '../contracts/index.js';
import { sessionServiceLabel, type SessionService } from './session-service.js';
import type { GeoInteractionService } from './geo-interaction-service.js';

type ApiRouteServices = {
  sessions: LiveSessionManager;
  snapshotSchemaVersion: number;
  health(): JsonRecord;
  sessionOptions(): JsonRecord;
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
  citation: CitationService;
  spatial: SpatialAnalysisService;
  video: VideoService;
  geo: GeoInteractionService;
};

export function createApiRouter(services: ApiRouteServices) {
  const router = new ServerRouter(services);
  const pdfDownloads = new Map<string, { pdf: Buffer; filename: string; expiresAt: number }>();
  const createPdf = async (req: IncomingMessage, deps: ApiRouteServices) => {
    const body = await deps.readBody(req);
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : '';
    const html = typeof body.html === 'string' ? body.html : '';
    if (!title || !html) {
      const error = new Error('title and html required') as Error & { status?: number };
      error.status = 400;
      throw error;
    }
    if (html.length > 5 * 1024 * 1024) {
      const error = new Error('Rendered report is too large') as Error & { status?: number };
      error.status = 413;
      throw error;
    }
    return { pdf: await deps.renderReportPdf(title, html), filename: `${title.replace(/\.mdx?$/i, '') || 'report'}.pdf` };
  };
  router
    .get('/api/health', ({ res, deps }) => deps.json(res, 200, deps.health()))
    .get('/api/platform/session-options', ({ res, deps }) => deps.json(res, 200, deps.sessionOptions()))
    .get('/api/live-sessions', ({ res, deps }) => deps.json(res, 200, { sessions: deps.sessions.list() }))
    .post('/api/live-sessions', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const profile = body.profile === undefined ? undefined : parseSessionProfileStructured(body.profile);
        if (profile && !profile.ok) return deps.json(res, 400, { error: profile.diagnostics.map((item) => item.message).join('; '), diagnostics: profile.diagnostics });
        const domainId = typeof body.domainId === 'string' && body.domainId.trim() ? body.domainId.trim() : undefined;
        const appendSystemPrompt = typeof body.appendSystemPrompt === 'string' && body.appendSystemPrompt.trim() ? body.appendSystemPrompt.trim() : undefined;
        const session = await deps.sessions.create({ cwd: body.cwd, model: body.model || '', sessionName: name || null, ...(domainId ? { domainId } : {}), ...(profile?.ok ? { profile: profile.value } : {}), ...(appendSystemPrompt ? { appendSystemPrompt } : {}) });
        deps.json(res, 200, { session: session.metadata(), ...(body.profile === undefined ? { diagnostics: [{ code: 'profile_compat_default', path: 'profile', severity: 'warning', message: 'profile was omitted; the current Module selection was frozen as compat-default.' }] } : {}) });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code, details: 'details' in error ? error.details : [] } : {}) }); }
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
        const session = await deps.sessions.resume({ sessionFile: resolvedFile, cwd, model: body.model || '', entries, sessionName, useCurrentConfiguration: body.useCurrentConfiguration === true });
        deps.json(res, 200, { session: session.metadata(), ...(reusedPending ? { reused: true } : {}) });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code, details: 'details' in error ? error.details : [] } : {}) }); }
    })
    .get(/^\/api\/live-sessions\/([^/]+)\/snapshot$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (session) deps.json(res, 200, session.snapshot());
    })
    .get(/^\/api\/live-sessions\/([^/]+)\/attachments$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (session) deps.json(res, 200, { attachments: deps.listAttachments(session.cwd) });
    })
    .get(/^\/api\/live-sessions\/([^/]+)\/citations$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try {
        const registry = deps.citation.registry(session).load();
        if (registry.sessionId !== (session.citationRegistryId || session.id)) return deps.json(res, 404, { error: 'Citation registry not found in this session' });
        deps.json(res, 200, { citations: registry });
      } catch (error) { deps.json(res, 409, { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/live-sessions\/([^/]+)\/video-resources\/([^/]+)\/metrics$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.video.metrics(session, decodeURIComponent(params[1]))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post(/^\/api\/live-sessions\/([^/]+)\/citations\/occurrences$/, async ({ req, res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try {
        const body = await deps.readBody(req);
        if (typeof body.locatorId !== 'string') return deps.json(res, 400, { error: 'locatorId required' });
        const result = deps.citation.cite(session, {
          locatorId: body.locatorId,
          containerType: 'message',
          containerId: `composer:${session.id}`,
          ...(typeof body.role === 'string' ? { role: body.role as import('../contracts/citation.js').CitationRole } : {}),
        });
        deps.json(res, 200, { marker: `[[cite:${result.occurrence.occurrenceId}]]`, occurrence: result.occurrence, citations: result.envelope });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
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
    .post(/^\/api\/sessions\/([^/]+)\/geo-contexts$/, async ({ req, res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try {
        const created = deps.geo.createContext(session, await deps.readBody(req));
        deps.json(res, 200, created);
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}) }); }
    })
    .get(/^\/api\/sessions\/([^/]+)\/geo-contexts\/([^/]+)$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.geo.getContext(session, decodeURIComponent(params[1]))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post(/^\/api\/sessions\/([^/]+)\/geo-screenshots$/, async ({ req, res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.geo.saveScreenshot(session, await deps.readBody(req))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}) }); }
    })
    .post(/^\/api\/sessions\/([^/]+)\/geo-screenshots\/([^/]+)\/respond$/, async ({ req, res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.geo.respondScreenshot(session, decodeURIComponent(params[1]), await deps.readBody(req))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}) }); }
    })
    .post(/^\/api\/sessions\/([^/]+)\/geo-interactions\/([^/]+)\/respond$/, async ({ req, res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, await deps.geo.respond(session, decodeURIComponent(params[1]), await deps.readBody(req))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}) }); }
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
        const { pdf, filename } = await createPdf(req, deps);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Length': String(pdf.length),
          'Content-Disposition': `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'Cache-Control': 'no-store',
        });
        res.end(pdf);
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/reports/pdf/download', async ({ req, res, deps }) => {
      try {
        const { pdf, filename } = await createPdf(req, deps);
        const now = Date.now();
        for (const [id, entry] of pdfDownloads) if (entry.expiresAt <= now) pdfDownloads.delete(id);
        const id = crypto.randomUUID();
        pdfDownloads.set(id, { pdf, filename, expiresAt: now + 5 * 60 * 1000 });
        deps.json(res, 200, { url: `/api/reports/pdf/download/${id}` });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/reports\/pdf\/download\/([a-f0-9-]+)$/, ({ res, params }) => {
      const entry = pdfDownloads.get(params[0]);
      if (!entry || entry.expiresAt <= Date.now()) { res.writeHead(404); res.end(); return; }
      pdfDownloads.delete(params[0]);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(entry.pdf.length),
        'Content-Disposition': `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
        'Cache-Control': 'no-store',
      });
      res.end(entry.pdf);
    })
    .post('/api/internal/citations/resolve', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'citation');
        if (!session) return;
        const results = [];
        if (Array.isArray(body.knowledgeIds) && body.knowledgeIds.length) results.push(deps.citation.resolveKnowledge(session, body.knowledgeIds as string[]));
        if (Array.isArray(body.attachmentIds) && body.attachmentIds.length) results.push(deps.citation.resolveAttachments(session, body.attachmentIds as string[]));
        if (Array.isArray(body.artifacts) && body.artifacts.length) results.push(deps.citation.resolveArtifacts(session, body.artifacts as import('./citation-service.js').CitationArtifactInput[]));
        if (Array.isArray(body.datasets) && body.datasets.length) results.push(deps.citation.resolveDatasets(session, body.datasets as import('./citation-service.js').CitationDatasetInput[]));
        if (Array.isArray(body.webUrls) && body.webUrls.length) results.push(await deps.citation.resolveWeb(session, body.webUrls as string[]));
        if (!results.length) return deps.json(res, 400, { error: 'A citation source is required' });
        deps.json(res, 200, { citations: results.at(-1) });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/citations/cite', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'citation');
        if (!session) return;
        if (typeof body.locatorId !== 'string' || typeof body.containerType !== 'string' || typeof body.containerId !== 'string') return deps.json(res, 400, { error: 'locatorId, containerType and containerId are required' });
        const result = deps.citation.cite(session, { locatorId: body.locatorId, containerType: body.containerType as import('../contracts/citation.js').CitationContainerType, containerId: body.containerId, ...(typeof body.anchorId === 'string' ? { anchorId: body.anchorId } : {}), ...(typeof body.role === 'string' ? { role: body.role as import('../contracts/citation.js').CitationRole } : {}) });
        deps.json(res, 200, { occurrence: result.occurrence, citations: result.envelope });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/spatial/analyze', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'spatial');
        if (!session) return;
        deps.json(res, 200, { result: await deps.spatial.analyze(session, body) });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/geo/inspect', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'geo');
        if (!session) return;
        deps.json(res, 200, { result: deps.geo.inspect(session, body) });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/geo/request', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'geo');
        if (!session) return;
        deps.json(res, 200, { result: await deps.geo.request(session, body) });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}) }); }
    })
    .post('/api/internal/geo/screenshot', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'geo');
        if (!session) return;
        deps.json(res, 200, { result: await deps.geo.requestScreenshot(session, body) });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}) }); }
    })
    .post('/api/internal/video/search', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, deps.video.search(session, body));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/video/present', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, await deps.video.present(session, body));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/video/snapshot', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, await deps.video.snapshot(session, body));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/video/clip', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, await deps.video.clip(session, body));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/video/sample-frames', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, await deps.video.sampleFrames(session, body));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
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

function resolveServiceSession(res: ServerResponse, body: RpcCommand, services: ApiRouteServices, service: SessionService) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const token = typeof body.token === 'string' ? body.token : '';
  const session = services.sessions.get(sessionId);
  if (!session || !token || token !== session.serviceTokens[service]) { services.json(res, 403, { error: `${sessionServiceLabel[service]} host access denied` }); return null; }
  return session;
}

function resolveLiveSessionParam(res: ServerResponse, value: string, services: ApiRouteServices) {
  let id: string;
  try { id = decodeURIComponent(value); }
  catch { services.json(res, 400, { error: 'Malformed live session id' }); return null; }
  const session = services.sessions.get(id);
  if (!session) { services.json(res, 404, { error: 'Live session not found' }); return null; }
  return session;
}
