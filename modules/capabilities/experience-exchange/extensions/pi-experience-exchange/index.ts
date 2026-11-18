import { randomUUID } from 'node:crypto';
import type { TSchema } from 'typebox';
import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseToolInterfaceContract } from '../../../../../src/contracts/tool-interface.ts';
import { HostCallError, postHostOperation } from '../../../../shared/host-client.ts';

const entries = [
  {
    name: 'search_experience',
    label: '检索交通经验',
    file: 'search-contract.json',
    route: 'search',
    description:
      'Use before deciding an unstated scope, measurement, time basis, or method that could change the result. Search published experience with one short intent in the user’s language. Treat results as candidates and check applicability.',
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
const methodPolicy = [
  'Experience decision before method selection',
  'If a task leaves a consequential choice open about the population, definition, comparison, denominator, time basis, or method, call search_experience once before choosing that assumption or running the substantive calculation.',
  'A named data source or recognizable field names alone do not settle the intended scope or meaning. Reading the schema first is fine. For a lookup or calculation with the method and scope already specified, proceed directly.',
  'Use a short query in the user’s language about the actual intent. Compare candidate applicability and exclusions with that intent. For a plausible candidate you adopt or explicitly rule out, call record_experience_use with its exact releaseId, used or skipped, and why.',
  'For a structured applicability result, prepare the reviewed table intent with the candidate releaseId before making the decision. Supply intentId when recording that decision. Current evidence establishes facts. An empty search has no disposition.',
].join('\n');
export default function experienceExchange(pi: ExtensionAPI) {
  const errors = new Set<string>();
  type Release = { releaseId: string; revision: number; digest: string; lookupToolCallId: string };
  type Turn = { userSeen: boolean; releases: Map<string, Release> };
  const startTurn = (userSeen = false): Turn => ({ userSeen, releases: new Map() });
  let turn: Turn | undefined;
  pi.on('before_agent_start', (event) => {
    turn = startTurn();
    return {
      systemPrompt: methodPolicy + '\n\n' + event.systemPrompt,
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
        ...(typeof value.intentId === 'string' ? { intentId: value.intentId } : {}),
        disposition: value.disposition as 'used' | 'skipped', reason: (value.reason as string).trim(),
      };
      try {
        await postHostOperation({ endpoint: process.env.TAU_EXPERIENCE_ENDPOINT, sessionId: process.env.TAU_EXPERIENCE_SESSION_ID, token: process.env.TAU_EXPERIENCE_TOKEN },
          '/api/internal/experience/use', details, { toolCallId, contractVersion: useContract.contractVersion, signal, timeoutMs: 20_000 });
      } catch (error) {
        errors.add(toolCallId);
        const text = error instanceof HostCallError ? error.message : 'Could not confirm the use receipt.';
        return { content: [{ type: 'text' as const, text }], details: { kind: 'experience-use', accepted: false } };
      }
      pi.appendEntry('experience-exchange', { ...details, kind: 'disposition', toolCallId });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(details) }],
        details: { ...details, deliveryReference: 'experience:' + release.releaseId },
      };
    },
  });
}
