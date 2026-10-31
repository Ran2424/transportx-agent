import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceHost } from './workspace-host.js';
import type { ServerRouter, RouteContext } from './router.js';
import type { MigrationSourceDecision, IsolatedMigrationDeletion } from './workspace-migration-runner.js';

type Services = {
  workspaces: WorkspaceHost;
  readBody(req: IncomingMessage): Promise<Record<string, unknown>>;
  json(res: ServerResponse, status: number, value: unknown): void;
  serveFiles(res: ServerResponse, directory: string, root?: string): void;
  serveFileContent(res: ServerResponse, file: string): void;
  servePreview(res: ServerResponse, file: string): void;
  serveRawFile(req: IncomingMessage, res: ServerResponse, file: string, download: boolean): void;
  openNative(file: string): Promise<void>;
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
  const source = (context: RouteContext<T>) => { const found = context.deps.workspaces.options.migration.read().items.find((item) => item.workspaceId === id(context)); if (!found) throw Object.assign(new Error('Workspace has no migration source.'), { code: 'workspace_missing', status: 404 }); return found.id; };
  router
    .get('/api/workspaces', endpoint(({ deps }) => deps.workspaces.index()))
    .get(/^\/api\/workspaces\/([^/]+)$/, endpoint((context) => context.deps.workspaces.workspace(id(context))))
    .patch(/^\/api\/workspaces\/([^/]+)$/, endpoint(async (context) => context.deps.workspaces.editWorkspace(id(context), await readInput(context.req, context.deps))))
    .post('/api/conversations', endpoint(async ({ req, deps }) => deps.workspaces.options.creation.create(await readInput(req, deps))))
    .get('/api/conversations/search', endpoint(({ url, deps }) => deps.workspaces.search(url.searchParams.get('q') || '')))
    .get(/^\/api\/conversations\/([^/]+)\/(?:snapshot|history)$/, endpoint((context) => context.deps.workspaces.snapshot(id(context))))
    .post(/^\/api\/conversations\/([^/]+)\/activate$/, endpoint(async (context) => context.deps.workspaces.activate(id(context), await readInput(context.req, context.deps))))
    .post(/^\/api\/conversations\/([^/]+)\/close$/, endpoint(async (context) => { const body = await readInput(context.req, context.deps); return context.deps.workspaces.options.runtime.close(id(context), body.stopCurrent === true); }))
    .post(/^\/api\/conversations\/([^/]+)\/move$/, endpoint(async (context) => context.deps.workspaces.moveConversation(id(context), await readInput(context.req, context.deps))))
    .patch(/^\/api\/conversations\/([^/]+)$/, endpoint(async (context) => context.deps.workspaces.renameConversation(id(context), await readInput(context.req, context.deps))))
    .delete(/^\/api\/conversations\/([^/]+)$/, endpoint(async (context) => context.deps.workspaces.options.deletion.conversation(id(context), await readInput(context.req, context.deps) as never)))
    .post(/^\/api\/workspaces\/([^/]+)\/delete$/, endpoint(async (context) => context.deps.workspaces.options.deletion.workspace(id(context), await readInput(context.req, context.deps) as never)))
    .post(/^\/api\/workspaces\/([^/]+)\/migration\/delete$/, endpoint(async (context) => context.deps.workspaces.options.runner.deleteIsolated(source(context), await readInput(context.req, context.deps) as unknown as IsolatedMigrationDeletion)))
    .get('/api/migration', endpoint(({ deps }) => deps.workspaces.migrationStatus()))
    .get(/^\/api\/migration\/items\/([^/]+)$/, endpoint((context) => context.deps.workspaces.options.runner.report(id(context))))
    .post('/api/migration/resume', endpoint(async ({ deps }) => { await deps.workspaces.options.migration.initialize(); void deps.workspaces.startConversions().catch(() => {}); return { accepted: true, migration: deps.workspaces.options.migration.status() }; }))
    .post('/api/migration/resolve', endpoint(async ({ req, deps }) => { const body = await readInput(req, deps); if (typeof body.itemId !== 'string') throw new Error('A migration itemId is required.'); return deps.workspaces.options.runner.resolveSource(body.itemId, body as unknown as MigrationSourceDecision); }))
    .get(/^\/api\/workspaces\/([^/]+)\/migration$/, endpoint((context) => context.deps.workspaces.options.runner.report(source(context))))
    .post(/^\/api\/workspaces\/([^/]+)\/migration\/resolve$/, endpoint(async (context) => { const body = await readInput(context.req, context.deps), runner = context.deps.workspaces.options.runner; return typeof body.sourceId === 'string' ? runner.resolvePrivate(source(context), body as never) : runner.resolveSource(source(context), body as unknown as MigrationSourceDecision); }))
    .get(/^\/api\/workspaces\/([^/]+)\/runtime-diagnostics$/, endpoint((context) => { const entry = context.deps.workspaces.options.store.readCatalog().entries.find((entry) => entry.workspaceId === id(context)); const item = context.deps.workspaces.options.migration.read().items.find((item) => item.workspaceId === id(context)); if (!entry && !item) throw new Error('Workspace is unavailable.'); return context.deps.workspaces.options.gate.diagnostics(entry?.path || item!.path); }))
    .post(/^\/api\/workspaces\/([^/]+)\/runtime-recovery$/, endpoint(async (context) => { const body = await readInput(context.req, context.deps), { store, migration, gate } = context.deps.workspaces.options; migration.assertSystemReady(); const entry = store.readCatalog().entries.find((entry) => entry.workspaceId === id(context)), item = migration.read().items.find((item) => item.workspaceId === id(context)); if (!entry && !item || typeof body.generation !== 'string' || !['recheck', 'stop-owned'].includes(String(body.action))) throw new Error('A current runtime generation and recovery action are required.'); return gate.recover(entry?.path || item!.path, body.generation, body.action as 'recheck' | 'stop-owned'); }))
    .get(/^\/api\/conversations\/([^/]+)\/files$/, endpoint((context) => { const target = context.deps.workspaces.target(id(context)); context.deps.serveFiles(context.res, context.deps.workspaces.file(id(context), context.url.searchParams.get('path')), target.directory); }))
    .get(/^\/api\/conversations\/([^/]+)\/files\/content$/, endpoint((context) => context.deps.serveFileContent(context.res, context.deps.workspaces.file(id(context), context.url.searchParams.get('path')))))
    .get(/^\/api\/conversations\/([^/]+)\/files\/preview$/, endpoint((context) => context.deps.servePreview(context.res, context.deps.workspaces.file(id(context), context.url.searchParams.get('path')))))
    .get(/^\/api\/conversations\/([^/]+)\/files\/raw$/, endpoint((context) => context.deps.serveRawFile(context.req, context.res, context.deps.workspaces.file(id(context), context.url.searchParams.get('path')), context.url.searchParams.get('download') === '1')))
    .head(/^\/api\/conversations\/([^/]+)\/files\/raw$/, endpoint((context) => context.deps.serveRawFile(context.req, context.res, context.deps.workspaces.file(id(context), context.url.searchParams.get('path')), context.url.searchParams.get('download') === '1')))
    .post(/^\/api\/conversations\/([^/]+)\/open$/, endpoint(async (context) => { const body = await readInput(context.req, context.deps); if (body.path !== undefined && typeof body.path !== 'string') throw new Error('Invalid file path.'); await context.deps.openNative(context.deps.workspaces.file(id(context), body.path as string | undefined)); return { opened: true }; }));
}
