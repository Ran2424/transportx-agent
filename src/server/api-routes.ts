import { citationResourceError } from './citation-resources.js';
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
import { serviceModuleIds, sessionServiceLabel, type SessionService } from './session-service.js';
import { validateToolRequest } from './tool-request.js';
import type { GeoInteractionService } from './geo-interaction-service.js';
import type { CanvasService } from './canvas-service.js';
import { SpatialInvocations } from './spatial-invocations.js';
import { PI_AGENT_DIR, SESSIONS_DIR } from './config.js';
import path from 'node:path';
import { inspectTaskModule } from './module-authoring.js';

type ApiRouteServices = {
  beginOperation?(url: URL): () => void;
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
  serveRawFile(req: IncomingMessage, res: ServerResponse, path: string, download: boolean): void;
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
  canvas: CanvasService;
};

export const REPORT_PDF_MAX_HTML_BYTES = 50 * 1024 * 1024;

export function createApiRouter(services: ApiRouteServices) {
  const spatialInvocations = new SpatialInvocations(path.join(PI_AGENT_DIR, 'executions', 'spatial'), SESSIONS_DIR, services.spatial);
  const router = new ServerRouter(services, services.beginOperation);
  const pdfDownloads = new Map<string, { pdf: Buffer; filename: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();
  let renderingPdfs = 0;
  const removePdf = (id: string) => {
    const entry = pdfDownloads.get(id);
    if (entry) clearTimeout(entry.timer);
    pdfDownloads.delete(id);
  };
  const createPdf = async (req: IncomingMessage, deps: ApiRouteServices) => {
    if (renderingPdfs >= 2) { req.resume(); throw Object.assign(new Error('PDF render capacity reached'), { status: 503 }); }
    renderingPdfs++;
    try {
      const body = await deps.readBody(req);
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 300) : '';
      const html = typeof body.html === 'string' ? body.html : '';
      if (!title || !html) {
        const error = new Error('title and html required') as Error & { status?: number };
        error.status = 400;
        throw error;
      }
      if (Buffer.byteLength(html, 'utf8') > REPORT_PDF_MAX_HTML_BYTES) {
        const error = new Error('Rendered report is too large') as Error & { status?: number };
        error.status = 413;
        throw error;
      }
      const pdf = await deps.renderReportPdf(title, html);
      if (pdf.length > 32 * 1024 * 1024) throw Object.assign(new Error('Rendered PDF exceeds 32 MB'), { status: 413 });
      return { pdf, filename: `${title.replace(/\.mdx?$/i, '') || 'report'}.pdf` };
    } finally { renderingPdfs--; }
  };
  const withRequestSignal = async <T>(req: IncomingMessage, res: ServerResponse, execute: (signal: AbortSignal) => Promise<T>) => {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.once('aborted', cancel);
    res.once('close', cancel);
    try { return await execute(controller.signal); }
    finally { req.off('aborted', cancel); res.off('close', cancel); }
  };
  const runJob = <T>(req: IncomingMessage, res: ServerResponse, session: PiRpcSession, execute: (signal: AbortSignal) => Promise<T>) => withRequestSignal(req, res, (signal) => services.sessions.runJob(session.id, execute, signal));
  const serveRawFile = ({ req, res, url, deps }: import('./router.js').RouteContext<ApiRouteServices>) => {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) return deps.json(res, 400, { error: 'No live session selected' });
    const session = deps.sessions.get(sessionId);
    if (!session) return deps.json(res, 404, { error: 'Live session not found' });
    try { deps.serveRawFile(req, res, deps.resolveLivePath(session, url.searchParams.get('path')), url.searchParams.get('download') === '1'); }
    catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
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
        const cwd = deps.sessionCwd(body.cwd) || deps.readSessionHeaderCwd(resolvedFile);
        if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
          return deps.json(res, 400, { error: 'Cannot resume session because its project directory no longer exists' });
        }
        const entries = deps.readSessionEntries(resolvedFile) as JsonRecord[];
        const sessionName = deps.deriveSessionName(entries);
        const reusedPending = deps.sessions.hasPendingResume(resolvedFile);
        const session = await deps.sessions.resume({ sessionFile: resolvedFile, cwd, model: body.model || '', entries, sessionName, useCurrentConfiguration: body.useCurrentConfiguration === true });
        deps.json(res, 200, { session: session.metadata(), ...(reusedPending || existing?.id === session.id ? { reused: true } : {}) });
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
    .get(/^\/api\/live-sessions\/([^/]+)\/citations$/, ({ res, url, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try {
        const offset = Number(url.searchParams.get('offset') || 0);
        const limit = Number(url.searchParams.get('limit') || 200);
        const ids = url.searchParams.get('ids')?.split(',');
        deps.json(res, 200, { citations: deps.citation.registry(session).list(offset, limit, ids) });
      } catch (error) { deps.json(res, 409, { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/live-sessions\/([^/]+)\/video-resources\/([^/]+)\/metrics$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.video.metrics(session, decodeURIComponent(params[1]))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/live-sessions\/([^/]+)\/citations\/evidence\/([^/]+)$/, ({ res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.citation.detail(session, decodeURIComponent(params[1]))); }
      catch (error) { citationResourceError(res, error); }
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
    .post(/^\/api\/sessions\/([^/]+)\/canvas-contexts$/, async ({ req, res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, { context: deps.canvas.createContext(session, await deps.readBody(req) as Parameters<CanvasService['createContext']>[1]) }); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
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
      try { await deps.sessions.delete(session.id, 'closed_by_user'); deps.json(res, 200, { success: true }); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
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
    .get('/api/file/raw', serveRawFile)
    .head('/api/file/raw', serveRawFile)
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
        for (const [id, entry] of pdfDownloads) if (entry.expiresAt <= now) removePdf(id);
        const cachedBytes = () => [...pdfDownloads.values()].reduce((total, entry) => total + entry.pdf.length, 0);
        while (pdfDownloads.size >= 8 || cachedBytes() + pdf.length > 64 * 1024 * 1024) removePdf(pdfDownloads.keys().next().value!);
        const id = crypto.randomUUID();
        const timer = setTimeout(() => removePdf(id), 5 * 60 * 1000);
        timer.unref();
        pdfDownloads.set(id, { pdf, filename, expiresAt: now + 5 * 60 * 1000, timer });
        deps.json(res, 200, { url: `/api/reports/pdf/download/${id}` });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/reports\/pdf\/download\/([a-f0-9-]+)$/, ({ res, params }) => {
      const entry = pdfDownloads.get(params[0]);
      if (!entry || entry.expiresAt <= Date.now()) { res.writeHead(404); res.end(); return; }
      removePdf(params[0]);
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(entry.pdf.length),
        'Content-Disposition': `attachment; filename="report.pdf"; filename*=UTF-8''${encodeURIComponent(entry.filename)}`,
        'Cache-Control': 'no-store',
      });
      res.end(entry.pdf);
    })
    .post('/api/internal/modules/package', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'moduleAuthoring');
        if (!session) return;
        await validateToolRequest('com.transportx.module-authoring', body);
        const { packageRoot, manifest } = inspectTaskModule(session.cwd, body.packagePath);
        if (body.action === 'inspect') return deps.json(res, 200, { action: 'inspect', id: manifest.id, version: manifest.version, entries: manifest.entrypoints, dependencies: manifest.dependencies, codeExecuted: false, toolCallId: body.toolCallId });
        const installed = await deps.handleRpc({ type: 'install_module', sourcePath: packageRoot });
        if (!installed.success) throw new Error(String(installed.error || 'Module installation was not accepted'));
        deps.json(res, 200, { action: 'install', id: manifest.id, version: manifest.version, installed: true, next: 'Create a new task to use the installed module. This task retains its frozen module plan.', toolCallId: body.toolCallId });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), code: 'module_package_failed', phase: 'package', commit: 'not_started' }); }
    })
    .post('/api/internal/citations/resolve', async ({ req, res, deps }) => {
      let toolCallId: string | undefined;
      const rejected = (message: string) => deps.json(res, 400, { error: message, toolCallId, code: 'citation_input_invalid', phase: 'validation', commit: 'not_started' });
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'citation');
        if (!session) return;
        toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : undefined;
        if (['knowledgeIds', 'attachmentIds', 'artifacts', 'datasets', 'value', 'executionRef'].some((key) => key in body)) return rejected('Unsupported citation input. Use concrete sources with typed locators.');
        if ('sources' in body && 'webUrls' in body) return rejected('sources and webUrls cannot be combined. Register local files with sources and public HTTPS pages with webUrls in separate calls; omit the other field entirely. Reuse evidence IDs from both calls. Do not put URLs in sources[].path.');
        await validateToolRequest('com.transportx.citation', body);
        if (Array.isArray(body.sources) && body.sources.length && !body.webUrls) {
          const inputs = body.sources as import('./citation-service.js').CitationInput[];
          const citations = deps.citation.resolve(session, inputs);
          const deliverableEvidenceIds = inputs.flatMap((input) => input.deliverable ? citations.evidence.filter((item) => citations.sources.some((source) => source.sourceVersionId === item.sourceVersionId && source.content.kind === 'file' && source.content.path === input.path && source.content.assetId === input.assetId)).map((item) => item.evidenceId) : []);
          return deps.json(res, 200, { citations, deliverableEvidenceIds, ...(toolCallId ? { toolCallId } : {}) });
        }
        if (Array.isArray(body.webUrls) && !body.sources) return deps.json(res, 200, { citations: await withRequestSignal(req, res, (signal) => deps.citation.resolveWeb(session, body.webUrls as string[], signal)), ...(toolCallId ? { toolCallId } : {}) });
        rejected('Provide exactly one non-empty array: sources for local files, or webUrls for public HTTPS pages. Omit the other field entirely.');
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; field?: string };
        deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), toolCallId, code: failure.code || 'citation_result_unknown', phase: failure.phase || 'host', commit: failure.commit || 'unknown', field: failure.field });
      }
    })
    .post('/api/internal/spatial/prepare', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'spatial');
        if (!session) return;
        await validateToolRequest('com.transportx.spatial-analysis', body);
        const record = spatialInvocations.prepare(session, body);
        deps.json(res, 200, { operationId: record.operationId, state: record.state, toolCallId: body.toolCallId });
      } catch (error) { const failure = error as Error & { code?: string; commit?: string }; deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), code: failure.code || 'spatial_prepare_failed', phase: 'prepare', commit: failure.commit || 'not_started' }); }
    })
    .post('/api/internal/spatial/execution', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'spatial');
        if (!session) return;
        await validateToolRequest('com.transportx.spatial-analysis', body, 'spatial.execution');
        if (body.action !== 'query' && body.action !== 'cancel') throw Object.assign(new Error('Expected query or cancel'), { status: 400 });
        const reference = { operationId: body.operationId, lookupToolCallId: body.lookupToolCallId };
        const record = body.action === 'cancel' ? spatialInvocations.cancel(session, reference) : spatialInvocations.query(session, reference);
        // Owner and normalized request remain Host metadata, not model/history.
        deps.json(res, 200, { operationId: record.operationId, state: record.state, jobId: record.jobId, result: record.result, error: record.error, ...('cancellationRequested' in record ? { cancellationRequested: record.cancellationRequested } : {}), toolCallId: body.toolCallId });
      } catch (error) { const failure = error as Error & { code?: string }; deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), code: failure.code || 'spatial_query_failed', phase: 'confirmation', commit: 'unknown' }); }
    })
    .post('/api/internal/spatial/analyze', async ({ req, res, deps }) => {
      let toolCallId: string | undefined;
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'spatial');
        if (!session) return;
        await validateToolRequest('com.transportx.spatial-analysis', body);
        if (body.toolCallId !== undefined && (typeof body.toolCallId !== 'string' || !body.toolCallId || body.toolCallId.length > 200)) return deps.json(res, 400, { error: 'Invalid Spatial toolCallId', code: 'spatial_input_invalid', phase: 'validation', commit: 'not_started' });
        toolCallId = body.toolCallId;
        const invocation = await withRequestSignal(req, res, (signal) => spatialInvocations.execute(session, body, signal, (jobSignal, analysisId, onJob, request) => services.sessions.runJob(session.id, (executionSignal) => deps.spatial.analyze(session, body, executionSignal, analysisId, request), jobSignal, onJob)));
        const { result } = invocation;
        // Citation failure must never re-enter SpatialAnalysisService's output cleanup.
        try { deps.json(res, 200, { ...invocation, ...(toolCallId ? { toolCallId } : {}), citations: deps.citation.registerSpatialResult(session, result) }); }
        catch (error) { deps.json(res, 200, { ...invocation, ...(toolCallId ? { toolCallId } : {}), citationWarning: `分析完成，依据登记失败：${deps.errorMessage(error)}` }); }
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; field?: string; operationId?: string };
        deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), toolCallId, operationId: failure.operationId, code: failure.code || 'spatial_result_unknown', phase: failure.phase || 'host', commit: failure.commit || 'unknown', field: failure.field });
      }
    })
    .post('/api/internal/geo/inspect', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'geo');
        if (!session) return;
        await validateToolRequest('com.transportx.geo', body, 'geo.inspect');
        deps.json(res, 200, { result: deps.geo.inspect(session, body), toolCallId: body.toolCallId });
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; field?: string };
        const status = deps.errorStatus(error);
        deps.json(res, status, { error: deps.errorMessage(error), code: failure.code || 'geo_request_failed', phase: failure.phase || 'host', commit: failure.commit || (status >= 400 && status < 500 ? 'not_started' : 'unknown'), field: failure.field });
      }
    })
    .post('/api/internal/canvas/present', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'canvas');
        if (!session) return;
        await validateToolRequest('com.transportx.canvas', body, 'canvas.present');
        deps.json(res, 200, { canvas: deps.canvas.present(session, body as Parameters<CanvasService['present']>[1]), toolCallId: body.toolCallId });
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; field?: string };
        const status = deps.errorStatus(error);
        deps.json(res, status, { error: deps.errorMessage(error), code: failure.code || 'canvas_request_failed', phase: failure.phase || 'host', commit: failure.commit || (status >= 400 && status < 500 ? 'not_started' : 'unknown'), field: failure.field });
      }
    })
    .post('/api/internal/canvas/inspect', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'canvas');
        if (!session) return;
        await validateToolRequest('com.transportx.canvas', body, 'canvas.inspect');
        deps.json(res, 200, { contexts: deps.canvas.inspectContexts(session, body.contextIds), toolCallId: body.toolCallId });
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; field?: string };
        const status = deps.errorStatus(error);
        deps.json(res, status, { error: deps.errorMessage(error), code: failure.code || 'canvas_request_failed', phase: failure.phase || 'host', commit: failure.commit || (status >= 400 && status < 500 ? 'not_started' : 'unknown'), field: failure.field });
      }
    })
    .post('/api/internal/geo/request', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'geo');
        if (!session) return;
        await validateToolRequest('com.transportx.geo', body, 'geo.request');
        deps.json(res, 200, { result: await withRequestSignal(req, res, (signal) => deps.geo.request(session, body, signal)), toolCallId: body.toolCallId });
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; field?: string };
        const status = deps.errorStatus(error);
        deps.json(res, status, { error: deps.errorMessage(error), code: failure.code || 'geo_request_failed', phase: failure.phase || 'host', commit: failure.commit || (status >= 400 && status < 500 ? 'not_started' : 'unknown'), field: failure.field });
      }
    })
    .post('/api/internal/geo/screenshot', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'geo');
        if (!session) return;
        await validateToolRequest('com.transportx.geo', body, 'geo.screenshot');
        deps.json(res, 200, { result: await withRequestSignal(req, res, (signal) => deps.geo.requestScreenshot(session, body, signal)), toolCallId: body.toolCallId });
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; field?: string };
        const status = deps.errorStatus(error);
        deps.json(res, status, { error: deps.errorMessage(error), code: failure.code || 'geo_request_failed', phase: failure.phase || 'host', commit: failure.commit || (status >= 400 && status < 500 ? 'not_started' : 'unknown'), field: failure.field });
      }
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
        deps.json(res, 200, await runJob(req, res, session, (signal) => deps.video.present(session, body, signal)));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/video/snapshot', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, await runJob(req, res, session, (signal) => deps.video.snapshot(session, body, signal)));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/video/clip', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, await runJob(req, res, session, (signal) => deps.video.clip(session, body, signal)));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/video/sample-frames', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, await runJob(req, res, session, (signal) => deps.video.sampleFrames(session, body, signal)));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/rpc', async ({ req, res, deps }) => {
      try { deps.json(res, 200, await deps.handleRpc(await deps.readBody(req))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/sessions/delete', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        if (body.deleteWorkspace !== undefined && typeof body.deleteWorkspace !== 'boolean') return deps.json(res, 400, { error: 'deleteWorkspace must be a boolean' });
        if (body.sessionId !== undefined) {
          if (typeof body.sessionId !== 'string' || !body.sessionId) return deps.json(res, 400, { error: 'sessionId required' });
          const session = deps.sessions.get(body.sessionId);
          if (!session) return deps.json(res, 200, { success: true, alreadyDeleted: true });
          if (session.sessionFile) deps.resolveSessionFile(session.sessionFile);
          await deps.sessions.deleteConversation({ sessionId: body.sessionId, deleteWorkspace: body.deleteWorkspace !== false });
          return deps.json(res, 200, { success: true });
        }
        if (!body.filePath || typeof body.filePath !== 'string') return deps.json(res, 400, { error: 'filePath required' });
        let sessionFile: string;
        try { sessionFile = deps.resolveSessionFile(body.filePath); }
        catch (error) {
          if (deps.errorMessage(error) === 'Session not found') return deps.json(res, 200, { success: true, alreadyDeleted: true });
          throw error;
        }
        await deps.sessions.deleteHistory(sessionFile, body.deleteWorkspace !== false);
        deps.json(res, 200, { success: true });
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), code: (error as NodeJS.ErrnoException).code, path: (error as NodeJS.ErrnoException).path }); }
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
  if (!session || session.terminating || !session.resolvedSessionPlan?.modules?.some((module) => module.id === serviceModuleIds[service]) || !token || token !== session.serviceTokens[service]) { services.json(res, 403, { error: `${sessionServiceLabel[service]} host access denied` }); return null; }
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
