import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseSpatialAnalysisResultStructured } from '../../../../../src/contracts/index.ts';

const SpatialAnalyzeSchema = Type.Object({
  operation: Type.Union([Type.Literal('buffer'), Type.Literal('nearest'), Type.Literal('spatial_join')]),
  inputPath: Type.Optional(Type.String({ maxLength: 1000 })),
  leftPath: Type.Optional(Type.String({ maxLength: 1000 })),
  rightPath: Type.Optional(Type.String({ maxLength: 1000 })),
  inputCrs: Type.Optional(Type.String({ maxLength: 120 })),
  leftCrs: Type.Optional(Type.String({ maxLength: 120 })),
  rightCrs: Type.Optional(Type.String({ maxLength: 120 })),
  metricCrs: Type.Optional(Type.String({ maxLength: 120 })),
  distanceMeters: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  maxDistanceMeters: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  dissolve: Type.Optional(Type.Boolean()),
  predicate: Type.Optional(Type.Union([Type.Literal('intersects'), Type.Literal('within'), Type.Literal('contains')])),
  cardinality: Type.Optional(Type.Union([Type.Literal('one-to-one'), Type.Literal('one-to-many')])),
  multipleMatchStrategy: Type.Optional(Type.Union([Type.Literal('error'), Type.Literal('first')])),
  rightFields: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { maxItems: 20 })),
  repairInvalid: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

function spatialHost() {
  const endpoint = process.env.TAU_SPATIAL_ENDPOINT;
  const sessionId = process.env.TAU_SPATIAL_SESSION_ID;
  const token = process.env.TAU_SPATIAL_TOKEN;
  if (!endpoint || !sessionId || !token) throw new Error('Spatial Analysis Agent Host bridge is unavailable for this session.');
  return { endpoint, sessionId, token };
}

type SpatialFailure = { code: string; phase: string; message: string; toolCallId: string; recovery: string };
type SpatialToolResult = { content: { type: 'text'; text: string }[]; details: Record<string, unknown> };

function failureResult(error: SpatialFailure): SpatialToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(error) }], details: { kind: 'tau-spatial-analysis-error', error } };
}

function unknownResult(toolCallId: string, phase: string): SpatialToolResult {
  return failureResult({ code: 'spatial_result_unknown', phase, toolCallId, message: 'The Spatial result is unknown. A cancellation request or lost response does not confirm that execution stopped or that no result was committed.', recovery: 'Do not run the analysis again automatically. Inspect existing .tau/spatial-results manifests and analysis/spatial outputs in this task. Persistent execution queries are not available yet.' });
}

async function analyze(body: Record<string, unknown>, toolCallId: string, signal: AbortSignal | undefined, dispatched: () => void) {
  const host = spatialHost();
  if (signal?.aborted) throw Object.assign(new Error('Spatial call was cancelled before dispatch'), { code: 'spatial_cancelled', phase: 'prepare', commit: 'not_started' });
  const lifetime = AbortSignal.any([AbortSignal.timeout(130_000), ...(signal ? [signal] : [])]);
  dispatched();
  const response = await fetch(`${host.endpoint}/api/internal/spatial/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, sessionId: host.sessionId, token: host.token, toolCallId }),
    signal: lifetime,
  });
  const payload = await response.json() as { citations?: { evidence: { evidenceId: string }[] }; citationWarning?: string; error?: string; result?: unknown; code?: string; phase?: string; commit?: string; toolCallId?: string };
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Spatial Host authorization was refused'), { code: 'spatial_authorization_denied', phase: 'authorization', commit: 'not_started' });
    throw Object.assign(new Error(String(payload.error || 'Spatial Host request failed').slice(0, 1500)), { code: payload.code, phase: payload.phase, commit: payload.commit });
  }
  if (payload.toolCallId !== undefined && payload.toolCallId !== toolCallId) throw new Error('Spatial response call association is invalid');
  const result = parseSpatialAnalysisResultStructured(payload.result);
  if (!result.ok) throw new Error('Spatial response could not be validated; preserve existing results');
  const citationsValid = Array.isArray(payload.citations?.evidence) && payload.citations.evidence.every((item) => item && typeof item.evidenceId === 'string');
  return { ...payload, result: result.value, citations: citationsValid ? payload.citations : undefined, citationWarning: typeof payload.citationWarning === 'string' ? payload.citationWarning : payload.citations && !citationsValid ? 'Analysis completed; citation response could not be displayed. Keep the existing analysis output and inspect its manifest; do not recompute it.' : undefined };
}

export default function spatialAnalysisExtension(pi: ExtensionAPI) {
  const pending = new Map<string, { dispatched: boolean; result?: SpatialToolResult }>();
  pi.on('session_shutdown', () => pending.clear());
  pi.on('tool_result', (event) => {
    if (event.toolName !== 'tau_spatial_analyze') return;
    const call = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    // Pi can settle an aborted call before execute's fetch has returned. Keep
    // unknown in that window; a confirmed response is retained after late abort.
    const result = call?.result || (call?.dispatched && event.isError ? unknownResult(event.toolCallId, 'cancel_requested') : undefined);
    if (result) return { ...result, isError: result.details.kind === 'tau-spatial-analysis-error' };
  });
  pi.registerTool({
    name: 'tau_spatial_analyze',
    label: '受控空间分析',
    description: 'Run a Host-controlled buffer, nearest-neighbor, or spatial join over session-relative GeoJSON. Distance operations require an explicit metric CRS. The output is WGS84 GeoJSON that can be passed to publish_geodata.',
    parameters: SpatialAnalyzeSchema,
    async execute(toolCallId, params, signal) {
      const call: { dispatched: boolean; result?: SpatialToolResult } = { dispatched: false };
      pending.set(toolCallId, call);
      try {
        const payload = await analyze(params as Record<string, unknown>, toolCallId, signal, () => { call.dispatched = true; });
        const result = payload.result!;
        const markers = Array.isArray(payload.citations?.evidence) ? payload.citations.evidence.filter((item) => typeof item.evidenceId === 'string').map((item) => `[[cite:${item.evidenceId}]]`).join(' ') : '';
        call.result = {
          content: [{ type: 'text' as const, text: `Spatial analysis ${result.analysisId} completed. Output: ${result.output?.relativePath}; features: ${result.output?.featureCount}; unmatched: ${result.counts?.unmatched || 0}. Use publish_geodata to display it. ${markers || payload.citationWarning || ''}`.slice(0, 6000) }],
          details: { kind: 'tau-spatial-analysis' as const, result, citations: payload.citations, citationWarning: payload.citationWarning },
        };
      } catch (error) {
        const failure = error as Error & { code?: string; phase?: string; commit?: string };
        call.result = failure.commit === 'not_started' || failure.commit === 'not_committed' || !call.dispatched
          ? failureResult({ code: failure.code || 'spatial_unavailable', phase: failure.phase || 'prepare', message: String(failure.message).slice(0, 1500), toolCallId, recovery: 'The Host did not commit this analysis. Correct the reported input or availability issue before requesting a new execution.' })
          : unknownResult(toolCallId, failure.phase || (signal?.aborted ? 'cancel_requested' : failure.name === 'TimeoutError' ? 'timeout' : 'transport_or_response'));
      }
      return call.result!;
    },
  });
}
