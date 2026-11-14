import { asRecord, asString, asInteger, type JsonRecord } from './common.ts';
import { GEO_ENVELOPE_PROTOCOL, GEO_ENVELOPE_VERSION } from './version.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { parseGeoScene, type GeoSceneSnapshot, type GeoParseResult } from './geo-scene.ts';

const SOURCE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type GeoEnvelopeOperation = 'replace' | 'patch' | 'focus' | 'select' | 'clear';

export type VisualizationEnvelope = {
  protocol: typeof GEO_ENVELOPE_PROTOCOL;
  version: typeof GEO_ENVELOPE_VERSION;
  kind: 'geo';
  visualizationId: string;
  revision: number;
  operation: GeoEnvelopeOperation;
  scene: GeoSceneSnapshot | null;
  summary: { title: string; description?: string };
  generatedAt: string;
};

export const VISUALIZATION_PROTOCOL: typeof GEO_ENVELOPE_PROTOCOL = GEO_ENVELOPE_PROTOCOL;
export const VISUALIZATION_VERSION: typeof GEO_ENVELOPE_VERSION = GEO_ENVELOPE_VERSION;

export function visualizationEnvelope(input: {
  visualizationId: string;
  revision: number;
  operation: GeoEnvelopeOperation;
  scene: GeoSceneSnapshot | null;
  summary: { title: string; description?: string };
  generatedAt?: string;
}): VisualizationEnvelope {
  return {
    protocol: VISUALIZATION_PROTOCOL,
    version: VISUALIZATION_VERSION,
    kind: 'geo',
    visualizationId: input.visualizationId,
    revision: input.revision,
    operation: input.operation,
    scene: input.scene,
    summary: { title: input.summary.title, ...(input.summary.description ? { description: input.summary.description } : {}) },
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

export type VisualizationEnvelopeResult = GeoParseResult<VisualizationEnvelope>;

export function parseVisualizationEnvelopeStructured(value: unknown, sink: ContractDiagnostic[] = []): VisualizationEnvelopeResult {
  const diagnostics = sink;
  const fail = (path: string, code: string, message: string): VisualizationEnvelopeResult => ({
    ok: false, value: null, diagnostics: [...diagnostics, diagnostic({ code: code as ContractDiagnostic['code'], path, message })],
  });
  const input = asRecord(value);
  if (!input) return fail('envelope', 'invalid_type', 'Envelope must be an object.');
  if (input.protocol !== GEO_ENVELOPE_PROTOCOL) {
    return fail('envelope.protocol', 'unknown_schema_version', `Unknown envelope protocol ${JSON.stringify(input.protocol)}; expected ${GEO_ENVELOPE_PROTOCOL}.`);
  }
  if (input.version !== GEO_ENVELOPE_VERSION) {
    return fail('envelope.version', 'unknown_schema_version', `Unknown envelope version ${JSON.stringify(input.version)}; expected ${GEO_ENVELOPE_VERSION}.`);
  }
  if (input.kind !== 'geo') return fail('envelope.kind', 'unsupported_value', `Unknown envelope kind ${JSON.stringify(input.kind)}; expected "geo".`);

  const visualizationId = asString(input.visualizationId, 80);
  if (!visualizationId || !SOURCE_ID_RE.test(visualizationId)) {
    return fail('envelope.visualizationId', 'invalid_type', 'visualizationId must be a 1-80 char identifier.');
  }
  const revision = asInteger(input.revision);
  if (revision === null || revision < 1) {
    return fail('envelope.revision', 'out_of_range', 'revision must be a positive integer.');
  }
  if (!['replace', 'patch', 'focus', 'select', 'clear'].includes(String(input.operation))) {
    return fail('envelope.operation', 'unsupported_value', 'operation must be replace, patch, focus, select, or clear.');
  }
  const summary = asRecord(input.summary);
  if (!summary || !asString(summary.title, 160)) return fail('envelope.summary.title', 'missing_required_field', 'summary.title is required and must be at most 160 characters.');
  const generatedAt = asString(input.generatedAt, 64);
  if (!generatedAt) return fail('envelope.generatedAt', 'invalid_type', 'generatedAt must be a string of at most 64 chars (typically ISO timestamp).');

  let scene: GeoSceneSnapshot | null = null;
  if (input.scene !== null) {
    const sceneResult = parseGeoScene(input.scene);
    if (!sceneResult.ok) return fail('envelope.scene', 'unsupported_value', `scene failed validation: ${sceneResult.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    scene = sceneResult.value;
  }
  if ((input.operation === 'clear') !== (scene === null)) {
    return fail('envelope.scene', 'unsupported_value', 'operation="clear" requires scene=null; other operations require a non-null scene.');
  }
  return {
    ok: true,
    value: {
      protocol: GEO_ENVELOPE_PROTOCOL,
      version: GEO_ENVELOPE_VERSION,
      kind: 'geo',
      visualizationId,
      revision,
      operation: input.operation as GeoEnvelopeOperation,
      scene,
      summary: { title: summary.title as string, ...(typeof summary.description === 'string' ? { description: summary.description.slice(0, 1000) } : {}) },
      generatedAt: generatedAt as string,
    },
    diagnostics: [],
  };
}

/**
 * Backwards-compatible boolean parser used by the Web Feature host: returns
 * the Envelope on success or `null` on any failure (covers all diagnostic
 * severities).
 */
export function parseVisualizationEnvelope(value: unknown): VisualizationEnvelope | null {
  return parseVisualizationEnvelopeStructured(value).value;
}

export function getVisualizationFromToolResult(result: unknown): VisualizationEnvelope | null {
  const root = asRecord(result);
  const details = asRecord(root?.details as JsonRecord | undefined);
  return parseVisualizationEnvelope(details?.visualization);
}

export function acceptEnvelopeRevision(
  previous: VisualizationEnvelope | null,
  next: VisualizationEnvelope,
): { accepted: boolean; diagnostic?: ContractDiagnostic } {
  if (previous && next.revision <= previous.revision) {
    return {
      accepted: false,
      diagnostic: diagnostic({
        code: 'revision_regression',
        path: 'envelope.revision',
        message: `Incoming envelope revision ${next.revision} is not greater than current ${previous.revision}.`,
        severity: 'warning',
        expected: previous.revision + 1,
        received: next.revision,
      }),
    };
  }
  return { accepted: true };
}
