import type { TSchema } from 'typebox';
import { readFileSync } from 'node:fs';
import { parseToolInterfaceContract } from '../../../../../src/contracts/tool-interface.ts';
import { postHostOperation } from '../../../../shared/host-client.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseSpatialAnalysisResultStructured } from '../../../../../src/contracts/index.ts';

const contract = parseToolInterfaceContract(JSON.parse(readFileSync(new URL("../../tool-contract.json", import.meta.url), "utf8")));
const executionContract = parseToolInterfaceContract(JSON.parse(readFileSync(new URL("../../execution-contract.json", import.meta.url), "utf8")));
if (!contract || !executionContract) throw new Error("Invalid Spatial Tool Contract");

function spatialHost() {
  const endpoint = process.env.TAU_SPATIAL_ENDPOINT;
  const sessionId = process.env.TAU_SPATIAL_SESSION_ID;
  const token = process.env.TAU_SPATIAL_TOKEN;
  return { endpoint, sessionId, token };
}

type SpatialFailure = { code: string; phase: string; message: string; toolCallId: string; recovery: string; field?: string; operationId?: string };
type SpatialToolResult = { content: { type: 'text'; text: string }[]; details: Record<string, unknown> };

function failureResult(error: SpatialFailure): SpatialToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(error) }], details: { kind: 'tau-spatial-analysis-error', error } };
}

function unknownResult(toolCallId: string, phase: string, operationId?: string): SpatialToolResult {
  return failureResult({ code: 'spatial_result_unknown', phase, toolCallId, operationId, message: 'The Spatial result is unknown. A cancellation request or lost response does not confirm that execution stopped or that no result was committed.', recovery: 'Do not run the analysis again automatically. Use tau_spatial_execution to query this operationId, or lookupToolCallId when its preparation response was lost. This reads existing execution facts without recalculating. Preserve .tau/spatial-results and analysis/spatial outputs.' });
}

async function analyze(body: Record<string, unknown>, toolCallId: string, signal: AbortSignal | undefined, dispatched: () => void) {
  const payload = await postHostOperation<{ citations?: { evidence: { evidenceId: string }[] }; citationWarning?: string; result?: unknown }>(spatialHost(), '/api/internal/spatial/analyze', body, { toolCallId, contractVersion: contract!.contractVersion, signal, timeoutMs: 130_000, dispatched });
  const result = parseSpatialAnalysisResultStructured(payload.result);
  if (!result.ok) throw new Error('Spatial response could not be validated; preserve existing results');
  const citationsValid = Array.isArray(payload.citations?.evidence) && payload.citations.evidence.every((item) => item && typeof item.evidenceId === 'string');
  return { ...payload, result: result.value, citations: citationsValid ? payload.citations : undefined, citationWarning: typeof payload.citationWarning === 'string' ? payload.citationWarning : payload.citations && !citationsValid ? 'Analysis completed; citation response could not be displayed. Keep the existing analysis output and inspect its manifest; do not recompute it.' : undefined };
}

export default function spatialAnalysisExtension(pi: ExtensionAPI) {
  const pending = new Map<string, { dispatched: boolean; operationId?: string; result?: SpatialToolResult }>();
  pi.on('session_shutdown', () => pending.clear());
  pi.on('tool_result', (event) => {
    if (event.toolName !== 'tau_spatial_analyze' && event.toolName !== 'tau_spatial_execution') return;
    const call = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    // Pi can settle an aborted call before execute's fetch has returned. Keep
    // unknown in that window; a confirmed response is retained after late abort.
    const result = call?.result || (call?.dispatched && event.isError ? unknownResult(event.toolCallId, 'cancel_requested', call.operationId) : undefined);
    if (result) return { ...result, isError: result.details.kind === 'tau-spatial-analysis-error' };
  });
  pi.registerTool({
    name: 'tau_spatial_analyze',
    label: '受控空间分析',
    description: 'Run a Host-controlled buffer, nearest-neighbor, or spatial join over session-relative GeoJSON. Distance operations require an explicit metric CRS. The output is WGS84 GeoJSON that can be passed to publish_geodata.',
    parameters: contract!.input as unknown as TSchema,
    async execute(toolCallId, params, signal) {
      const call: { dispatched: boolean; operationId?: string; result?: SpatialToolResult } = { dispatched: false };
      pending.set(toolCallId, call);
      try {
        const prepared = await postHostOperation<{ operationId: string }>(spatialHost(), '/api/internal/spatial/prepare', params as Record<string, unknown>, { toolCallId, contractVersion: contract!.contractVersion, signal, timeoutMs: 15_000, dispatched: () => { call.dispatched = true; } });
        if (!/^spatial_[a-f0-9]{32}$/.test(prepared.operationId)) throw new Error('Invalid Spatial operation association');
        call.operationId = prepared.operationId;
        const payload = await analyze({ ...params as Record<string, unknown>, operationId: call.operationId }, toolCallId, signal, () => { call.dispatched = true; });
        const result = payload.result!;
        const markers = Array.isArray(payload.citations?.evidence) ? payload.citations.evidence.filter((item) => typeof item.evidenceId === 'string').map((item) => `[[cite:${item.evidenceId}]]`).join(' ') : '';
        call.result = {
          content: [{ type: 'text' as const, text: `Spatial analysis ${result.analysisId} completed. Output: ${result.output?.relativePath}; features: ${result.output?.featureCount}; unmatched: ${result.counts?.unmatched || 0}. Use publish_geodata to display it. ${markers || payload.citationWarning || ''}`.slice(0, 6000) }],
          details: { kind: 'tau-spatial-analysis' as const, result, citations: payload.citations, citationWarning: payload.citationWarning, operationId: call.operationId },
        };
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string; field?: string };
        call.result = failure.commit === 'not_started' || failure.commit === 'not_committed' || !call.dispatched
          ? failureResult({ code: failure.code === 'cancelled' ? 'spatial_cancelled' : failure.code || 'spatial_unavailable', phase: failure.phase || 'prepare', field: failure.field, message: String(failure.message).slice(0, 1500), toolCallId, recovery: 'The Host did not commit this analysis. Correct the reported input or availability issue before requesting a new execution.' })
          : unknownResult(toolCallId, failure.phase || (signal?.aborted ? 'cancel_requested' : failure.name === 'TimeoutError' ? 'timeout' : 'transport_or_response'), call.operationId);
      }
      return call.result!;
    },
  });
  pi.registerTool({
    name: 'tau_spatial_execution', label: '查询空间分析执行',
    description: 'Query or request cancellation of an existing Spatial operation in this persistent task. Supply exactly one operationId or lookupToolCallId from the original call. Never computes or repeats an analysis. Unknown or missing records are not proof of non-execution.',
    parameters: executionContract!.input as unknown as TSchema,
    async execute(toolCallId, params, signal) {
      const call: { dispatched: boolean; result?: SpatialToolResult } = { dispatched: false };
      pending.set(toolCallId, call);
      try {
        const payload = await postHostOperation<{ operationId: string; state: string; result?: unknown; cancellationRequested?: boolean }>(spatialHost(), '/api/internal/spatial/execution', params as Record<string, unknown>, { toolCallId, contractVersion: contract!.contractVersion, signal, timeoutMs: 15_000 });
        const parsed = parseSpatialAnalysisResultStructured(payload.result);
        if (payload.state === 'succeeded' && !parsed.ok) throw new Error('Committed Spatial result could not be decoded; preserve its manifest');
        call.result = { content: [{ type: 'text', text: JSON.stringify({ ...payload, result: parsed.ok ? { analysisId: parsed.value.analysisId, output: parsed.value.output.relativePath } : undefined, recovery: 'This is an existing execution query. A cancellation request is not confirmation of stopping. Do not recalculate an unknown operation.' }).slice(0, 6000) }], details: parsed.ok ? { kind: 'tau-spatial-analysis', result: parsed.value, operationId: payload.operationId, recovered: true } : { kind: 'tau-spatial-execution', ...payload } };
      } catch (error) {
        call.result = failureResult({ code: 'spatial_query_unconfirmed', phase: 'confirmation', toolCallId, message: String(error).slice(0, 1500), recovery: 'The read/cancellation result is unconfirmed. Preserve existing outputs; retrying this query never recalculates the analysis.' });
      }
      return call.result;
    },
  });

}
