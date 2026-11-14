import { citationResourceError } from './citation-resources.js';
const fs = require('node:fs');

import type { ApiRouteServices } from './api-services.js';
import type { CanvasService } from './canvas-service.js';
import type { RpcCommand } from './types.js';
import type { SessionAttachmentSource } from '../contracts/attachments.js';
import { ServerRouter } from './router.js';
import { registerWorkspaceApi } from './workspace-api.js';
import { resolveServiceSession, resolveLiveSessionParam, resolveResourceContextParam, resolveConversationTargetParam, runRequestJob, withRequestSignal } from './api-context.js';
import { registerSimulationApi } from './simulation-api.js';
import { registerReportApi } from './report-api.js';
import { validateToolRequest } from './tool-request.js';
import { CadInvocations } from './cad-invocations.js';
import { SpatialInvocations } from './spatial-invocations.js';
import { PI_AGENT_DIR, SESSIONS_DIR } from './config.js';
import path from 'node:path';
import { inspectTaskModule } from './module-authoring.js';
import { resolveSessionAttachments, attachmentFilePath } from './session-attachments.js';

export function createApiRouter(services: ApiRouteServices) {
  const cadInvocations = new CadInvocations(path.join(PI_AGENT_DIR, 'executions', 'cad'), SESSIONS_DIR, services.cad);
  const spatialInvocations = new SpatialInvocations(path.join(PI_AGENT_DIR, 'executions', 'spatial'), SESSIONS_DIR, services.spatial);
  const router = new ServerRouter(services, services.beginOperation);
  registerWorkspaceApi(router);
  registerSimulationApi(router, services);
  registerReportApi(router);
  router
    .get('/api/health', ({ req, res, deps }) => { res.setHeader('Cache-Control', 'no-store'); deps.json(res, 200, deps.health(req)); })
    .get(/^\/api\/conversations\/([^/]+)\/overview$/, ({ res, params, deps }) => { try { deps.json(res, 200, deps.conversationOverview(decodeURIComponent(params[0]))); } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), code: (error as { code?: string }).code }); } })
    .get('/api/platform/session-options', ({ res, deps }) => deps.json(res, 200, deps.sessionOptions()))
    .get(/^\/api\/conversations\/([^/]+)\/attachments$/, ({ res, params, deps }) => {
      const target = resolveConversationTargetParam(res, params[0], deps);
      if (target) deps.json(res, 200, { attachments: deps.listAttachments(target.directory) });
    })
    .get(/^\/api\/conversations\/([^/]+)\/attachments\/([^/]+)\/file$/, ({ req, res, url, params, deps }) => {
      const target = resolveConversationTargetParam(res, params[0], deps); if (!target) return;
      try { const attachment = resolveSessionAttachments(target.directory, [decodeURIComponent(params[1])])[0]; deps.serveRawFile(req, res, attachmentFilePath(target.directory, attachment), url.searchParams.get('download') === '1'); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/conversations\/([^/]+)\/resources$/, async ({ res, params, deps }) => {
      const session = resolveResourceContextParam(res, params[0], deps); if (session) await deps.serveResources(res, session);
    })
    .get(/^\/api\/conversations\/([^/]+)\/citations$/, ({ res, url, params, deps }) => {
      const session = resolveResourceContextParam(res, params[0], deps);
      if (!session) return;
      try {
        const offset = Number(url.searchParams.get('offset') || 0);
        const limit = Number(url.searchParams.get('limit') || 200);
        const ids = url.searchParams.get('ids')?.split(',');
        deps.json(res, 200, { citations: deps.citation.list(session, offset, limit, ids) });
      } catch (error) { deps.json(res, 409, { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/conversations\/([^/]+)\/video-resources\/([^/]+)\/metrics$/, ({ res, params, deps }) => {
      const session = resolveResourceContextParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.video.metrics(session, decodeURIComponent(params[1]))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/conversations\/([^/]+)\/citations\/evidence\/([^/]+)$/, ({ res, params, deps }) => {
      const session = resolveResourceContextParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.citation.detail(session, decodeURIComponent(params[1]))); }
      catch (error) { citationResourceError(res, error); }
    })
    .post(/^\/api\/conversations\/([^/]+)\/attachments$/, async ({ req, res, url, params, deps }) => {
      const target = resolveConversationTargetParam(res, params[0], deps);
      if (!target) return;
      const source = url.searchParams.get('source');
      if (source !== 'picker' && source !== 'drop' && source !== 'clipboard') return deps.json(res, 400, { error: 'Invalid attachment source' });
      try { deps.json(res, 200, { attachments: await deps.uploadAttachments(target.directory, req, source, target.conversation.id) }); }
      catch (cause) { deps.json(res, deps.errorStatus(cause), { error: deps.errorMessage(cause) }); }
    })
    .delete(/^\/api\/conversations\/([^/]+)\/attachments\/([^/]+)$/, ({ res, params, deps }) => {
      const target = resolveConversationTargetParam(res, params[0], deps);
      if (!target) return;
      try { deps.deleteAttachment(target.directory, decodeURIComponent(params[1])); deps.json(res, 200, { success: true }); }
      catch (cause) { deps.json(res, deps.errorStatus(cause), { error: deps.errorMessage(cause) }); }
    })
    .post(/^\/api\/conversations\/([^/]+)\/geo-contexts$/, async ({ req, res, params, deps }) => {
      const session = resolveResourceContextParam(res, params[0], deps);
      if (!session) return;
      try {
        const created = deps.geo.createContext(session, await deps.readBody(req));
        deps.json(res, 200, created);
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}) }); }
    })
    .post(/^\/api\/conversations\/([^/]+)\/canvas-presentations$/, async ({ req, res, params, deps }) => {
      const session = resolveResourceContextParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, { canvas: await deps.canvas.presentResource(session, await deps.readBody(req) as Parameters<CanvasService['present']>[1]) }); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post(/^\/api\/conversations\/([^/]+)\/canvas-contexts$/, async ({ req, res, params, deps }) => {
      const session = resolveResourceContextParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, { context: deps.canvas.createContext(session, await deps.readBody(req) as Parameters<CanvasService['createContext']>[1]) }); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .get(/^\/api\/conversations\/([^/]+)\/geo-contexts\/([^/]+)$/, ({ res, params, deps }) => {
      const session = resolveResourceContextParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.geo.getContext(session, decodeURIComponent(params[1]))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post(/^\/api\/conversations\/([^/]+)\/geo-screenshots$/, async ({ req, res, params, deps }) => {
      const session = resolveResourceContextParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.geo.saveScreenshot(session, await deps.readBody(req))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}) }); }
    })
    .post(/^\/api\/conversations\/([^/]+)\/geo-screenshots\/([^/]+)\/respond$/, async ({ req, res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, deps.geo.respondScreenshot(session, decodeURIComponent(params[1]), await deps.readBody(req))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}) }); }
    })
    .post(/^\/api\/conversations\/([^/]+)\/geo-interactions\/([^/]+)\/respond$/, async ({ req, res, params, deps }) => {
      const session = resolveLiveSessionParam(res, params[0], deps);
      if (!session) return;
      try { deps.json(res, 200, await deps.geo.respond(session, decodeURIComponent(params[1]), await deps.readBody(req))); }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), ...(error && typeof error === 'object' && 'code' in error ? { code: error.code } : {}) }); }
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
        deps.json(res, 200, { canvas: await deps.canvas.presentResource(session, body as Parameters<CanvasService['present']>[1]), toolCallId: body.toolCallId });
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
    .post('/api/internal/cad/inspect', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'cad');
        if (!session) return;
        await validateToolRequest('com.transportx.cad', body, 'cad.inspect');
        deps.json(res, 200, { result: await runRequestJob(deps.sessions, req, res, session, (signal) => deps.cad.inspect(session, body, signal)), toolCallId: body.toolCallId });
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; operationId?: string };
        const status = deps.errorStatus(error);
        deps.json(res, status, { error: deps.errorMessage(error), code: failure.code || 'cad_request_failed', phase: failure.phase || 'host', commit: failure.commit || (status >= 400 && status < 500 ? 'not_started' : 'unknown'), operationId: failure.operationId });
      }
    })
    .post('/api/internal/cad/draw', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'cad');
        if (!session) return;
        await validateToolRequest('com.transportx.cad', body, 'cad.draw');
        const confirmation = await withRequestSignal(req, res, (signal) => cadInvocations.execute(session, body, signal, (jobSignal, record) => services.sessions.runJob(session.id, (executionSignal) => deps.cad.draw(session, record.request, executionSignal, record.operationId, record.inputSha256), jobSignal)));
        deps.json(res, 200, { ...confirmation, toolCallId: body.toolCallId });
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; operationId?: string };
        const status = deps.errorStatus(error);
        deps.json(res, status, { error: deps.errorMessage(error), code: failure.code || 'cad_request_failed', phase: failure.phase || 'host', commit: failure.commit || (status >= 400 && status < 500 ? 'not_started' : 'unknown'), operationId: failure.operationId });
      }
    })
    .post('/api/internal/cad/verify', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'cad');
        if (!session) return;
        await validateToolRequest('com.transportx.cad', body, 'cad.verify');
        deps.json(res, 200, { result: await runRequestJob(deps.sessions, req, res, session, (signal) => deps.cad.verify(session, body, signal)), toolCallId: body.toolCallId });
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; operationId?: string };
        const status = deps.errorStatus(error);
        deps.json(res, status, { error: deps.errorMessage(error), code: failure.code || 'cad_request_failed', phase: failure.phase || 'host', commit: failure.commit || (status >= 400 && status < 500 ? 'not_started' : 'unknown'), operationId: failure.operationId });
      }
    })
    .post('/api/internal/cad/execution', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'cad');
        if (!session) return;
        await validateToolRequest('com.transportx.cad', body, 'cad.execution');
        const record = body.action === 'cancel' ? cadInvocations.cancel(session, { operationId: body.operationId, lookupToolCallId: body.lookupToolCallId }) : cadInvocations.query(session, { operationId: body.operationId, lookupToolCallId: body.lookupToolCallId });
        deps.json(res, 200, { operationId: record.operationId, state: record.state, result: record.result, error: record.error, ...('cancellationRequested' in record ? { cancellationRequested: record.cancellationRequested } : {}), toolCallId: body.toolCallId });
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; operationId?: string };
        const status = deps.errorStatus(error);
        deps.json(res, status, { error: deps.errorMessage(error), code: failure.code || 'cad_request_failed', phase: failure.phase || 'host', commit: failure.commit || (status >= 400 && status < 500 ? 'not_started' : 'unknown'), operationId: failure.operationId });
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
        deps.json(res, 200, await runRequestJob(deps.sessions, req, res, session, (signal) => deps.video.present(session, body, signal)));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/video/snapshot', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, await runRequestJob(deps.sessions, req, res, session, (signal) => deps.video.snapshot(session, body, signal)));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/video/clip', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, await runRequestJob(deps.sessions, req, res, session, (signal) => deps.video.clip(session, body, signal)));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/internal/video/sample-frames', async ({ req, res, deps }) => {
      try {
        const body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'video');
        if (!session) return;
        deps.json(res, 200, await runRequestJob(deps.sessions, req, res, session, (signal) => deps.video.sampleFrames(session, body, signal)));
      } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
    .post('/api/rpc', async ({ req, res, deps }) => {
      try {
        const command = await deps.readBody(req);
        if (command?.type === 'open_logs_directory' || command?.type === 'open_module_directory') deps.assertNative(req);
        deps.json(res, 200, await deps.handleRpc(command));
      }
      catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error) }); }
    })
;
  return router;
}
