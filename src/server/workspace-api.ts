import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceHost } from './workspace-host.js';
import type { ServerRouter, RouteContext } from './router.js';

type Services = {
  workspaces: WorkspaceHost;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  json(res: ServerResponse, status: number, value: unknown): void;
  serveFiles(res: ServerResponse, directory: string, root?: string): void;
  serveFileContent(res: ServerResponse, file: string): void;
  servePreview(res: ServerResponse, file: string): void;
  serveRawFile(req: IncomingMessage, res: ServerResponse, file: string, download: boolean): void;
  openNative(file: string): Promise<void>;
  assertNative(req: IncomingMessage): void;
};

export function registerWorkspaceApi<T extends Services>(router: ServerRouter<T>) {
  const endpoint = (run: (context: RouteContext<T>) => unknown | Promise<unknown>) => async (context: RouteContext<T>) => {
    try { const result = await run(context); if (!context.res.headersSent) context.deps.json(context.res, 200, result); }
    catch (error) {
      const problem = error as Error & { code?: string; status?: number; details?: unknown; diagnostics?: unknown; migration?: unknown; volumes?: unknown; report?: string; itemId?: string; conversationId?: string; liveSessionId?: string };
      context.deps.json(context.res, problem.status || (problem instanceof SyntaxError ? 400 : 409), { error: problem.message, code: problem.code || 'workspace_operation_failed', details: problem.details, diagnostics: problem.diagnostics, migration: problem.migration, volumes: problem.volumes, report: problem.report, itemId: problem.itemId, conversationId: problem.conversationId, liveSessionId: problem.liveSessionId });
    }
  };
  const readInput = async (req: IncomingMessage, deps: T) => {
    const input = await deps.readBody(req);
    if (!input || Array.isArray(input) || typeof input !== 'object' || ['cwd', 'filePath', 'outputPath', 'useCurrentConfiguration', 'deleteWorkspace'].some((key) => key in input) || input.stopCurrent !== undefined && typeof input.stopCurrent !== 'boolean') throw Object.assign(new Error('Invalid workspace operation input; use explicit workspace/conversation identities.'), { status: 400, code: 'invalid_workspace_input' });
    return input;
  };
  const id = (context: RouteContext<T>) => decodeURIComponent(context.params[0]);
  router
    .get('/api/workspaces', endpoint(({ deps }) => deps.workspaces.index()))
    .get(/^\/api\/workspaces\/([^/]+)$/, endpoint((context) => context.deps.workspaces.workspace(id(context))))
    .patch(/^\/api\/workspaces\/([^/]+)$/, endpoint(async (context) => context.deps.workspaces.editWorkspace(id(context), await readInput(context.req, context.deps))))
    .patch(/^\/api\/workspaces\/([^/]+)\/sidebar$/, endpoint(async (context) => context.deps.workspaces.setSidebarVisibility(id(context), (await readInput(context.req, context.deps)).hidden)))
    .post(/^\/api\/workspaces\/([^/]+)\/release$/, endpoint((context) => context.deps.workspaces.releaseMissingWorkspace(id(context))))
    .post('/api/conversations', endpoint(async ({ req, deps }) => deps.workspaces.create(await readInput(req, deps))))
    .get('/api/conversations/search', endpoint(({ url, deps }) => deps.workspaces.search(url.searchParams.get('q') || '')))
    .get(/^\/api\/conversations\/([^/]+)\/(?:snapshot|history)$/, endpoint((context) => context.deps.workspaces.snapshot(id(context))))
    .post(/^\/api\/conversations\/([^/]+)\/activate$/, endpoint(async (context) => context.deps.workspaces.activate(id(context), await readInput(context.req, context.deps))))
    .post(/^\/api\/conversations\/([^/]+)\/close$/, endpoint(async (context) => { const body = await readInput(context.req, context.deps); return context.deps.workspaces.closeConversation(id(context), body.stopCurrent === true); }))
    .post(/^\/api\/conversations\/([^/]+)\/move$/, endpoint(async (context) => context.deps.workspaces.moveConversation(id(context), await readInput(context.req, context.deps))))
    .patch(/^\/api\/conversations\/([^/]+)$/, endpoint(async (context) => context.deps.workspaces.renameConversation(id(context), await readInput(context.req, context.deps))))
    .delete(/^\/api\/conversations\/([^/]+)$/, endpoint(async (context) => context.deps.workspaces.deleteConversation(id(context), await readInput(context.req, context.deps) as never)))
    .post(/^\/api\/workspaces\/([^/]+)\/delete$/, endpoint(async (context) => context.deps.workspaces.deleteWorkspace(id(context), await readInput(context.req, context.deps) as never)))
    .post(/^\/api\/workspaces\/([^/]+)\/migration\/delete$/, endpoint(async (context) => context.deps.workspaces.deleteIsolatedWorkspace(id(context), await readInput(context.req, context.deps) as never)))
    .get('/api/migration', endpoint(({ deps }) => deps.workspaces.migrationStatus()))
    .get(/^\/api\/migration\/items\/([^/]+)$/, endpoint((context) => context.deps.workspaces.migrationReport(id(context))))
    .post('/api/migration/resume', endpoint(({ deps }) => deps.workspaces.resumeMigration()))
    .post('/api/migration/resolve', endpoint(async ({ req, deps }) => { const body = await readInput(req, deps); if (typeof body.itemId !== 'string') throw new Error('A migration itemId is required.'); return deps.workspaces.resolveMigrationSource(body.itemId, body as never); }))
    .get(/^\/api\/workspaces\/([^/]+)\/migration$/, endpoint((context) => context.deps.workspaces.workspaceMigrationReport(id(context))))
    .post(/^\/api\/workspaces\/([^/]+)\/migration\/resolve$/, endpoint(async (context) => context.deps.workspaces.resolveWorkspaceMigration(id(context), await readInput(context.req, context.deps))))
    .get(/^\/api\/workspaces\/([^/]+)\/runtime-diagnostics$/, endpoint((context) => context.deps.workspaces.runtimeDiagnostics(id(context))))
    .post(/^\/api\/workspaces\/([^/]+)\/runtime-recovery$/, endpoint(async (context) => context.deps.workspaces.recoverRuntime(id(context), await readInput(context.req, context.deps))))
    .get(/^\/api\/conversations\/([^/]+)\/files$/, endpoint((context) => { const target = context.deps.workspaces.target(id(context)); context.deps.serveFiles(context.res, context.deps.workspaces.file(id(context), context.url.searchParams.get('path')), target.directory); }))
    .get(/^\/api\/conversations\/([^/]+)\/files\/content$/, endpoint((context) => context.deps.serveFileContent(context.res, context.deps.workspaces.file(id(context), context.url.searchParams.get('path')))))
    .get(/^\/api\/conversations\/([^/]+)\/files\/preview$/, endpoint((context) => context.deps.servePreview(context.res, context.deps.workspaces.file(id(context), context.url.searchParams.get('path')))))
    .get(/^\/api\/conversations\/([^/]+)\/files\/raw$/, endpoint((context) => context.deps.serveRawFile(context.req, context.res, context.deps.workspaces.file(id(context), context.url.searchParams.get('path')), context.url.searchParams.get('download') === '1')))
    .head(/^\/api\/conversations\/([^/]+)\/files\/raw$/, endpoint((context) => context.deps.serveRawFile(context.req, context.res, context.deps.workspaces.file(id(context), context.url.searchParams.get('path')), context.url.searchParams.get('download') === '1')))
    .post(/^\/api\/conversations\/([^/]+)\/open$/, endpoint(async (context) => { context.deps.assertNative(context.req); const body = await readInput(context.req, context.deps); if (body.path !== undefined && typeof body.path !== 'string') throw new Error('Invalid file path.'); await context.deps.openNative(context.deps.workspaces.file(id(context), body.path as string | undefined)); return { opened: true }; }));
}
