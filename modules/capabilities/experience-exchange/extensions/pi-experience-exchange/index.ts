import type { TSchema } from 'typebox';
import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseToolInterfaceContract } from '../../../../../src/contracts/tool-interface.ts';
import { postHostOperation } from '../../../../shared/host-client.ts';

const entries = [
  {
    name: 'search_experience',
    label: '检索交通经验',
    file: 'search-contract.json',
    route: 'search',
    description:
      'Look up potentially relevant published traffic experience using one short question or intent phrase. The results are candidate methods and checks. Verify applicability and then inspect current data.',
  },
  {
    name: 'submit_experience_feedback',
    label: '提交经验反馈',
    file: 'feedback-contract.json',
    route: 'feedback',
    description:
      'Submit an evidence-backed correction for review. Supply the exact experience reference only if actually used. Keep submission_id and payload unchanged when retrying an uncertain result.',
  },
] as const;
export default function experienceExchange(pi: ExtensionAPI) {
  const errors = new Set<string>();
  pi.on('before_agent_start', (event) => ({
    systemPrompt: event.systemPrompt + '\n\nFor a transport question involving a business definition, analysis method or decision, call search_experience once early with your question or a short intent phrase. Check the scope and exclusions of each returned rule. Use applicable rules to decide which current evidence to examine. If the search is empty, fails or a rule is out of scope, continue the original task with the available evidence. Complete the task in this turn rather than listing future steps.',
  }));
  pi.on('session_shutdown', () => errors.clear());
  pi.on('tool_result', (event) => {
    if (errors.delete(event.toolCallId)) return { isError: true };
  });
  for (const entry of entries) {
    const contract = parseToolInterfaceContract(
      JSON.parse(
        readFileSync(new URL(`../../${entry.file}`, import.meta.url), 'utf8')
      )
    );
    if (!contract) throw new Error('Invalid Experience Exchange Tool Contract');
    pi.registerTool({
      name: entry.name,
      label: entry.label,
      description: entry.description,
      parameters: contract.input as unknown as TSchema,
      async execute(
        toolCallId,
        params,
        signal
      ): Promise<{
        content: { type: 'text'; text: string }[];
        details: Record<string, unknown>;
      }> {
        try {
          const result = await postHostOperation<Record<string, unknown>>(
            {
              endpoint: process.env.TAU_EXPERIENCE_ENDPOINT,
              sessionId: process.env.TAU_EXPERIENCE_SESSION_ID,
              token: process.env.TAU_EXPERIENCE_TOKEN,
            },
            `/api/internal/experience/${entry.route}`,
            params as Record<string, unknown>,
            { toolCallId, contractVersion: contract.contractVersion, signal, timeoutMs: 45_000 }
          );
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            details: { kind: `experience-${entry.route}`, ...result },
          };
        } catch (error) {
          errors.add(toolCallId);
          const failure = error as Error & { commit?: string };
          const result = {
            code:
              failure.commit === 'unknown'
                ? 'experience_result_unknown'
                : 'experience_failed',
            message: failure.message,
            recovery:
              entry.route === 'search'
                ? 'Continue with current evidence. If you retry, send just the query.'
                : 'For an uncertain feedback submission retry the identical payload with the same submission_id.',
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            details: { kind: 'experience-error', error: result },
          };
        }
      },
    });
  }
}
