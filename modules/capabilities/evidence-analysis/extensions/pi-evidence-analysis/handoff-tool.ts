import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { WorkspaceHandoffSchema } from '../../../../../src/contracts/workspace-handoff-schema.mts';
import { HostCallError, postHostOperation } from '../../../../shared/host-client.ts';

export const HANDOFF = 'workspace_data_handoff';
export const handoffGuide = 'For a selected reviewed snapshot use workspace_data_handoff inspect before substantive queries. Search experience if the method calls for it, then prepare the user’s operation, metric, denominator, time roles and any resolved filters, including candidate release IDs. The Host keeps explicit aliases from the actual question. Ask the user to clarify consequential conflicts. Use the returned intentId and exact filters for the primary comparison; support queries may narrow the scope. For each requested time role group by its field and count all rows with queryRole=time. Submit the primary evidence and a time claim for each requested role.';

export type HandoffReviewResult = { id: string; target: string; status: string; evidenceRef: string; url?: string };

export function handoffReviewText(review: HandoffReviewResult, chinese: boolean) {
  const labels = chinese
    ? { pending: '复核提交尚未确认', routed: '复核已登记', resolution_pending: '重跑证据已保存，等待 Data Studio 确认关闭', resolved: '复核已关闭' }
    : { pending: 'Review submission unconfirmed', routed: 'Review recorded', resolution_pending: 'Rerun verified, waiting for Data Studio to confirm closure', resolved: 'Review resolved' };
  const label = labels[review.status as keyof typeof labels] ?? review.status;
  const retry = review.status === 'resolution_pending'
    ? (chinese ? '\n\n可用同一复核 ID 重试同步。' : '\n\nRetry synchronization with the same review ID.') : '';
  return label + ' · `' + review.id + '`' + retry +
    (review.url ? '\n\n[' + (chinese ? '打开对应 Studio' : 'Open the linked Studio') + '](' + review.url + ')' : '');
}

export function registerHandoffTool(pi: ExtensionAPI, current: () => { id: string; question: string } | undefined,
  markError: (toolCallId: string) => void, reviewReady: (review: HandoffReviewResult, turnId: string) => void) {
  pi.registerTool({
    name: HANDOFF,
    label: '核对数据口径与复核流转',
    description: 'Inspect or prepare a selected snapshot; route an observed failure; request closure after an approved and executed rerun; inspect_review shows the state; retry_resolution resends a verified closure using the same reviewId. Updating a review requires the user’s direction.',
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
          { toolCallId, contractVersion: '1.1.0', signal, timeoutMs: 30_000 }
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
