import type { TSchema } from 'typebox';
import { readFileSync } from 'node:fs';
import { parseToolInterfaceContract } from '../../../../../src/contracts/tool-interface.ts';
import { parseCitationEnvelope } from '../../../../../src/contracts/citation.ts';
import { HostCallError, postHostOperation } from '../../../../shared/host-client.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
const contract = parseToolInterfaceContract(JSON.parse(readFileSync(new URL('../../tool-contract.json', import.meta.url), 'utf8')));
if (!contract) throw new Error('Invalid Citation Tool Contract');

type CitationToolResult = { content: { type: 'text'; text: string }[]; details: Record<string, unknown> };
function citationFailure(toolCallId: string, code: string, phase: string, message: string, field?: string): CitationToolResult {
  const error = { code, phase, toolCallId, field, message: message.slice(0, 1500), recovery: code === 'citation_result_unknown' ? 'Do not register again automatically. Inspect existing evidence in this task and reuse the registered Evidence IDs before requesting another call.' : 'Correct the reported input or availability issue before requesting another registration.' };
  return { content: [{ type: 'text', text: JSON.stringify(error) }], details: { kind: 'tau-citation-error', error } };
}

export default function citationExtension(pi: ExtensionAPI) {
  const pending = new Map<string, { dispatched: boolean; result?: CitationToolResult }>();
  pi.on('session_shutdown', () => pending.clear());
  pi.on('tool_result', (event) => {
    if (event.toolName !== 'tau_resolve_citation') return;
    const call = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    const result = call?.result || (call?.dispatched && event.isError ? citationFailure(event.toolCallId, 'citation_result_unknown', 'cancel_requested', 'Cancellation was requested but evidence registration was not confirmed.') : undefined);
    if (result) return { ...result, isError: result.details.kind === 'tau-citation-error' };
  });
  pi.on('before_agent_start', async (event) => ({ systemPrompt: `${event.systemPrompt}\n\nCitations use a single registration step: tau_resolve_citation returns evidence IDs. Put [[cite:evidenceId]] after the supported claim; use [[cite:id1,id2]] for multiple original sources. Reuse IDs directly; there is no tau_cite step. Knowledge/data modules own discovery: start with selected asset overview, browse bounded directories, retrieve a few candidates, then read specific originals/results. Never load all asset bodies at startup or cite a catalog hit as evidence. Knowledge summaries must cite every supporting original location with contentKind summary; only checkable verbatim text is an excerpt. Existing result files can be cited directly without exporting special evidence JSON. Metadata/querySummary is descriptive, not proof of execution. Inline results are registered only by Host producers. Paths are relative to the active session or selected asset. Set deliverable only for requested final files, never intermediate scripts or inputs. Report bodies use the same markers; do not handwrite reference lists or expose local paths as citations.` }));
  pi.registerTool({
    name: 'tau_resolve_citation', label: '登记引用依据', description: 'Pin concrete authorized originals/results and register typed evidence. Provide exactly one of sources (local files) or webUrls (public HTTPS pages); omit the other field entirely. For mixed references, make separate calls and reuse evidence IDs from both. Returns only this registration, never the accumulated registry.',
    parameters: contract!.input as unknown as TSchema,
    async execute(toolCallId, params, signal) {
      const call: { dispatched: boolean; result?: CitationToolResult } = { dispatched: false };
      pending.set(toolCallId, call);
      try {
        const host = { endpoint: process.env.TAU_CITATION_ENDPOINT, sessionId: process.env.TAU_CITATION_SESSION_ID, token: process.env.TAU_CITATION_TOKEN };
        const payload = await postHostOperation<{ citations?: unknown; deliverableEvidenceIds?: unknown }>(host, '/api/internal/citations/resolve', params as Record<string, unknown>, { toolCallId, contractVersion: contract!.contractVersion, signal, timeoutMs: 130_000, dispatched: () => { call.dispatched = true; } });
        const citations = parseCitationEnvelope(payload.citations);
        if (!citations) throw new HostCallError('Citation response could not be validated. Preserve registered evidence.', 'host_result_unknown', 'response_decode', 'unknown');
        const deliverableEvidenceIds = Array.isArray(payload.deliverableEvidenceIds) ? payload.deliverableEvidenceIds.filter((id): id is string => typeof id === 'string') : [];
        call.result = { content: [{ type: 'text', text: citations.evidence.map((item) => `[[cite:${item.evidenceId}]] · sourceVersionId=${item.sourceVersionId} · ${citations.sources.find((source) => source.sourceVersionId === item.sourceVersionId)?.title || '来源'}${item.text ? ` ${item.text.slice(0, 240)}` : ''}`).join('\n').slice(0, 6000) }], details: { kind: 'tau-citations', citations, deliverableEvidenceIds } };
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; field?: string };
        const unknown = call.dispatched && failure.commit !== 'not_started' && failure.commit !== 'not_committed';
        call.result = citationFailure(toolCallId, unknown ? 'citation_result_unknown' : failure.code === 'cancelled' ? 'citation_cancelled' : failure.code || 'citation_unavailable', failure.phase || 'prepare', failure.message, failure.field);
      }
      return call.result!;
    },
  });
}
