import { randomUUID } from 'node:crypto';
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
  type Release = { releaseId: string; revision: number; digest: string; lookupToolCallId: string };
  type Turn = { userSeen: boolean; releases: Map<string, Release> };
  const startTurn = (userSeen = false): Turn => ({ userSeen, releases: new Map() });
  let turn: Turn | undefined;
  pi.on('before_agent_start', (event) => {
    turn = startTurn();
    return {
      systemPrompt: event.systemPrompt + '\n\nFor transport definitions, analysis methods or decisions, use search_experience before choosing a method. Send only query, a short description of the intent. For a returned rule, check its applicability and exclusions, then call record_experience_use with its exact releaseId, a used or skipped disposition, and the reason. Compute the result from current evidence. Continue the task if no applicable rule is found.',
    };
  });
  pi.on('message_start', ({ message }) => {
    if (message.role !== 'user') return;
    if (turn && !turn.userSeen) turn.userSeen = true;
    else turn = startTurn(true);
  });
  pi.on('agent_settled', () => { turn = undefined; });
  pi.on('session_shutdown', () => { errors.clear(); turn = undefined; });
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
        const startedTurn = turn;
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
          if (entry.route === 'search') {
            const releases: Release[] = Array.isArray(result.experiences)
              ? result.experiences.flatMap((item: unknown) => {
                  if (!item || typeof item !== 'object') return [];
                  const { release_id, revision, digest } = item as Record<string, unknown>;
                  return typeof release_id === 'string' && typeof revision === 'number' && typeof digest === 'string'
                    ? [{ releaseId: release_id, revision, digest, lookupToolCallId: toolCallId }]
                    : [];
                })
              : [];
            const releaseIds = releases.map((release) => release.releaseId);
            pi.appendEntry('experience-exchange', {
              kind: 'search', toolCallId,
              status: releaseIds.length ? 'returned' : 'empty', releaseIds,
            });
            if (startedTurn && startedTurn === turn)
              for (const release of releases) startedTurn.releases.set(release.releaseId, release);
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            details: { kind: `experience-${entry.route}`, ...result },
          };
        } catch (error) {
          if (entry.route === 'search') {
            pi.appendEntry('experience-exchange', {
              kind: 'search', toolCallId, status: 'unavailable', releaseIds: [],
            });
          }
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
  const useContract = parseToolInterfaceContract(
    JSON.parse(readFileSync(new URL('../../use-contract.json', import.meta.url), 'utf8'))
  );
  if (!useContract) throw new Error('Invalid Experience Exchange use Tool Contract');
  pi.registerTool({
    name: 'record_experience_use',
    label: '记录交通经验取舍',
    description: 'Record whether a candidate returned by a successful search in this turn was used or skipped, and why. Returns a receipt ID.',
    parameters: useContract.input as unknown as TSchema,
    async execute(toolCallId, input, signal) {
      const { Check } = await import('typebox/value');
      const value = input as Record<string, unknown>;
      const valid = Check(useContract.input as any, value) &&
        typeof value.releaseId === 'string' && !!value.releaseId.trim() &&
        typeof value.reason === 'string' && !!value.reason.trim() &&
        (value.disposition === 'used' || value.disposition === 'skipped');
      const release = valid ? turn?.releases.get(value.releaseId as string) : undefined;
      if (!release) {
        errors.add(toolCallId);
        const message = 'Provide a release ID returned by a successful search this turn, a used or skipped disposition, and a reason.';
        return {
          content: [{ type: 'text' as const, text: message }],
          details: { kind: 'experience-use', accepted: false },
        };
      }
      const details = {
        kind: 'experience-use', accepted: true, receiptId: 'use_' + randomUUID(),
        ...release,
        disposition: value.disposition as 'used' | 'skipped', reason: (value.reason as string).trim(),
      };
      try {
        await postHostOperation({ endpoint: process.env.TAU_EXPERIENCE_ENDPOINT, sessionId: process.env.TAU_EXPERIENCE_SESSION_ID, token: process.env.TAU_EXPERIENCE_TOKEN },
          '/api/internal/experience/use', details, { toolCallId, contractVersion: useContract.contractVersion, signal, timeoutMs: 20_000 });
      } catch (error) {
        errors.add(toolCallId);
        return { content: [{ type: 'text' as const, text: 'Could not persist the use receipt. Continue the answer; retry this decision if appropriate.' }], details: { kind: 'experience-use', accepted: false } };
      }
      pi.appendEntry('experience-exchange', { ...details, kind: 'disposition', toolCallId });
      return { content: [{ type: 'text' as const, text: JSON.stringify(details) }], details };
    },
  });
}
