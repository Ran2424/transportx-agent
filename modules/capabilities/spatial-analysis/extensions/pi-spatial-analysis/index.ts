import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

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

async function analyze(body: Record<string, unknown>) {
  const host = spatialHost();
  const response = await fetch(`${host.endpoint}/api/internal/spatial/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, sessionId: host.sessionId, token: host.token }),
  });
  const payload = await response.json() as { error?: string; result?: { analysisId?: string; operation?: string; output?: { relativePath?: string; featureCount?: number }; counts?: { unmatched?: number } } };
  if (!response.ok || !payload.result) throw new Error(payload.error || 'Spatial Analysis Agent Host request failed.');
  return payload.result;
}

export default function spatialAnalysisExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'tau_spatial_analyze',
    label: '受控空间分析',
    description: 'Run a Host-controlled buffer, nearest-neighbor, or spatial join over session-relative GeoJSON. Distance operations require an explicit metric CRS. The output is WGS84 GeoJSON that can be passed to publish_geodata.',
    parameters: SpatialAnalyzeSchema,
    async execute(_toolCallId, params) {
      const result = await analyze(params as Record<string, unknown>);
      return {
        content: [{ type: 'text' as const, text: `Spatial analysis ${result.analysisId} completed. Output: ${result.output?.relativePath}; features: ${result.output?.featureCount}; unmatched: ${result.counts?.unmatched || 0}. Use publish_geodata to display it.` }],
        details: { kind: 'tau-spatial-analysis' as const, result },
      };
    },
  });
}
