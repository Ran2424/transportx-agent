import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RpcCommand } from './types.js';
import type { PiRpcSession } from './sessions.js';
import type { ApiRouteServices } from './api-services.js';
import type { ServerRouter } from './router.js';
import { validateToolRequest } from './tool-request.js';
import { resolveResourceContextParam, resolveServiceSession, runRequestJob, withRequestSignal } from './api-context.js';

export function registerSimulationApi(router: ServerRouter<ApiRouteServices>, services: ApiRouteServices) {
  const runSimulation = (req: IncomingMessage, res: ServerResponse, session: PiRpcSession, request: { scenarioId?: unknown; toolCallId?: unknown; operationId?: unknown; experimentId?: unknown; slot?: unknown }) => {
    const reserved = services.traffic.prepareRun(session, request);
    if (reserved.state !== 'prepared') return Promise.resolve(reserved);
    return withRequestSignal(req, res, (signal) => services.sessions.runJob(session.id, (jobSignal) => services.traffic.run(session, { ...request, operationId: reserved.runId }, jobSignal), signal, (jobId) => services.traffic.bindJob(session, reserved.runId, jobId)));
  };
  for (const operation of ['prepare', 'run/prepare', 'run', 'execution', 'query', 'experiment'] as const) {
    router.post(`/api/internal/traffic/${operation}`, async ({ req, res, deps }) => {
      let body: RpcCommand = {};
      try {
        body = await deps.readBody(req);
        const session = resolveServiceSession(res, body, deps, 'traffic'); if (!session) return;
        const toolId = operation.startsWith('run') ? 'traffic.run' : operation === 'prepare' ? 'traffic.prepare' : `traffic.${operation}`;
        const input = await validateToolRequest('com.transportx.traffic-simulation', body, toolId);
        const request = { ...input, toolCallId: body.toolCallId, operationId: body.operationId };
        if (operation === 'run/prepare') return deps.json(res, 200, { runId: deps.traffic.prepareRun(session, request).runId });
        if (operation === 'execution' || operation === 'experiment') {
          const reply = await deps.workspaces.withRuntimeWrite(session, () => resolveServiceSession(res, body, deps, 'traffic') === session, () => {
            if (operation === 'experiment') {
              if (input.action === 'prepare' && input.experimentId !== undefined || input.action === 'query' && (input.baselineScenarioId !== undefined || input.variantScenarioId !== undefined || input.seeds !== undefined || typeof input.experimentId !== 'string')) throw Object.assign(new Error('Supply preparation conditions or one existing experiment reference.'), { status: 400, code: 'traffic_experiment_input_invalid' });
              const experiment = input.action === 'prepare' ? deps.traffic.prepareExperiment(session, input) : deps.traffic.experiment(session, String(input.experimentId));
              return { result: { protocol: 'transportx-traffic', version: 1, operation, experiment }, toolCallId: body.toolCallId };
            }
            const run = input.action === 'cancel' ? deps.traffic.cancel(session, input) : deps.traffic.recoverExecution(session, input);
            return { result: { protocol: 'transportx-traffic', version: 1, operation, run }, toolCallId: body.toolCallId, canvas: deps.traffic.presentation(session, run.runId) };
          });
          if (reply) deps.json(res, 200, reply);
          return;
        }
        const result = operation === 'prepare'
          ? { protocol: 'transportx-traffic', version: 1, operation: 'prepare', scenario: await runRequestJob(deps.sessions, req, res, session, (signal) => deps.traffic.prepareScenario(session, input, signal, input.geoContextId === undefined ? undefined : deps.geo.getContext(session, String(input.geoContextId)).context)) }
          : operation === 'run'
            ? { protocol: 'transportx-traffic', version: 1, operation: 'run', run: await runSimulation(req, res, session, request) }
            : { protocol: 'transportx-traffic', version: 1, operation: 'query', run: deps.traffic.queryExecution(session, { runId: input.runId }), query: deps.traffic.query(session, input) };
        deps.json(res, 200, { result, toolCallId: body.toolCallId, ...('run' in result && result.run ? { canvas: deps.traffic.presentation(session, result.run.runId) } : {}) });
      } catch (error) {
        deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), code: (error as { code?: string }).code, toolCallId: body.toolCallId, commit: operation === 'prepare' || operation === 'run/prepare' ? 'not_started' : 'unknown' });
      }
    });
  }
  router.get(/^\/api\/conversations\/([^/]+)\/simulation-experiments\/(experiment_[a-f0-9]{32})$/, ({ res, params, deps }) => {
    const session = resolveResourceContextParam(res, params[0], deps); if (!session) return;
    try { deps.json(res, 200, deps.traffic.experiment(session, params[1], false)); }
    catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), code: (error as { code?: string }).code }); }
  });
  router.get(/^\/api\/conversations\/([^/]+)\/simulation-runs(?:\/([^/]+)\/(index|geometry|query|chunks\/\d+))?$/, ({ res, params, url, deps }) => {
    const session = resolveResourceContextParam(res, params[0], deps); if (!session) return;
    try {
      const runId = params[1] ? decodeURIComponent(params[1]) : '', resource = params[2];
      const index = resource === 'index' ? deps.traffic.availableIndex(session, runId) : null;
      const value = !resource ? { runs: deps.traffic.list(session).map((run) => ({ run, canvas: deps.traffic.presentation(session, run.runId) })) }
        : resource === 'index' ? { run: { ...deps.traffic.queryExecution(session, { runId }), ...(index ? { latestComputedTime: index.computedTime, availableFrameTime: index.availableTime } : {}) }, index }
        : resource === 'geometry' ? deps.traffic.geometry(session, runId)
        : resource === 'query' ? deps.traffic.query(session, { runId, ...(url.searchParams.has('time') ? { time: Number(url.searchParams.get('time')) } : {}), ...(url.searchParams.has('objectId') ? { objectId: url.searchParams.get('objectId') } : {}), ...(url.searchParams.has('eventSequence') ? { eventSequence: Number(url.searchParams.get('eventSequence')) } : {}) })
        : deps.traffic.chunk(session, runId, Number(resource.split('/')[1]));
      deps.json(res, 200, value);
    } catch (error) { deps.json(res, deps.errorStatus(error), { error: deps.errorMessage(error), code: (error as { code?: string }).code }); }
  });
}
