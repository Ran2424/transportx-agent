import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { WorkspaceHandoffSchema } from '../../../../../src/contracts/workspace-handoff-schema.mts';
import { HostCallError, postHostOperation } from '../../../../shared/host-client.ts';

export const HANDOFF = 'workspace_data_handoff';
export const handoffGuide = 'For a selected reviewed snapshot use workspace_data_handoff inspect before substantive queries. Search experience if the method calls for it, then prepare the user’s operation, metric, denominator, time roles and any resolved filters, including candidate release IDs. The Host keeps explicit aliases from the actual question. Ask the user to clarify consequential conflicts. Use the returned intentId and exact filters for the primary comparison; support queries may narrow the scope. For each requested time role group by its field and count all rows with queryRole=time. Submit the primary evidence and a time claim for each requested role.';

export type HandoffReviewResult = { id: string; target: string; status: string; evidenceRef: string; url?: string };

export function registerHandoffTool(pi: ExtensionAPI, current: () => { id: string; question: string } | undefined,
  markError: (toolCallId: string) => void, reviewReady: (review: HandoffReviewResult, turnId: string) => void) {
  pi.registerTool({
    name: HANDOFF,
    label: '核对数据口径与复核流转',
    description: 'Inspect the approved definition of a selected snapshot; prepare intent before executing a substantive comparison; route an observed failure for review; close a review after an approved and executed rerun. Updating a review requires the user’s direction.',
    parameters: WorkspaceHandoffSchema,
    async execute(toolCallId, input, signal) {
      const run = current();
      try {
        if (!run) throw new Error('Handoff requires an active question.');
        const { result } = await postHostOperation<{ result: { review?: HandoffReviewResult } }>(
          {
            endpoint: process.env.TAU_EVIDENCE_ANALYSIS_ENDPOINT,
            sessionId: process.env.TAU_EVIDENCE_ANALYSIS_SESSION_ID,
            token: process.env.TAU_EVIDENCE_ANALYSIS_TOKEN,
          },
          '/api/internal/analysis/handoff',
          { ...input, handoffTurn: run.id, handoffQuestion: run.question },
          { toolCallId, contractVersion: '1.0.0', signal, timeoutMs: 30_000 }
        );
        if (result.review) reviewReady(result.review, run.id);
        const details = { kind: 'data-handoff', accepted: true, ...result };
        return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
      } catch (error) {
        markError(toolCallId);
        const text = error instanceof Error ? error.message : 'Handoff was not confirmed.';
        const code = error instanceof HostCallError ? error.code : 'table_handoff_unavailable';
        return { content: [{ type: 'text' as const, text }], details: { kind: 'data-handoff', accepted: false, code } };
      }
    },
  });
}
