import type { HandoffInput } from '../contracts/workspace-handoff-schema.mjs' with { 'resolution-mode': 'import' };
import { ServerRouter } from './router.js';
import type { ApiRouteServices } from './api-services.js';
import { resolveServiceSession, runRequestJob } from './api-context.js';
import { getHandoffCandidates } from './experience-run-use.js';
import { handoffError, prepareIntent, readHandoffSource } from './workspace-handoff.js';
import { closeHandoffReview, routeHandoffReview } from './workspace-handoff-review.js';
import { validateToolRequest } from './tool-request.js';

export function registerWorkspaceHandoff(router: ServerRouter<ApiRouteServices>) {
  router.post('/api/internal/analysis/handoff', async ({ req, res, deps }) => {
    try {
      const body = await deps.readBody(req);
      const session = resolveServiceSession(res, body, deps, 'evidenceAnalysis');
      if (!session) return;
      const { handoffTurn, handoffQuestion, ...toolBody } = body;
      const input = await validateToolRequest('com.transportx.evidence-analysis', toolBody, 'analysis.handoff') as HandoffInput;
      if (typeof handoffTurn !== 'string' || !/^[a-f0-9-]{36}$/.test(handoffTurn) ||
          typeof handoffQuestion !== 'string' || !handoffQuestion.trim() || handoffQuestion.length > 12000)
        throw handoffError('Handoff is available only in an active question with tracked context.');
      const result = await runRequestJob(deps.sessions, req, res, session, async signal => {
        switch (input.action) {
          case 'inspect': {
            const source = readHandoffSource(session, input.file);
            return { snapshot: source.snapshot, reviewedDefinition: source.reviewed ?? null };
          }
          case 'prepare':
            return { intent: prepareIntent(session, input, handoffQuestion, handoffTurn,
              getHandoffCandidates(session, input.candidateReleaseIds ?? [])) };
          case 'review':
            return { review: await routeHandoffReview(session, input, signal) };
          case 'resolve':
            return { review: closeHandoffReview(session, input) };
        }
      });
      deps.json(res, 200, { result, toolCallId: body.toolCallId });
    } catch (error) {
      deps.json(res, deps.errorStatus(error), {
        error: deps.errorMessage(error), code: (error as { code?: string })?.code,
        phase: 'handoff', commit: 'not_started',
      });
    }
  });
}
