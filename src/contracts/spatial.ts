import { asFiniteNumber, asInteger, asRecord, asString } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';

export const SPATIAL_ANALYSIS_PROTOCOL = 'transportx-spatial-analysis' as const;
export const SPATIAL_OPERATIONS = ['buffer', 'nearest', 'spatial_join'] as const;
export type SpatialOperation = typeof SPATIAL_OPERATIONS[number];

export type SpatialAnalysisResultV1 = {
  protocol: 'transportx-spatial-analysis';
  schemaVersion: 1;
  analysisId: string;
  operation: SpatialOperation;
  inputs: Array<{ role: 'input' | 'left' | 'right'; relativePath: string; sha256: string; crs: string; featureCount: number }>;
  parameters: Record<string, string | number | boolean>;
  counts: { input: number; output: number; unmatched: number; invalidGeometry: number; emptyGeometry: number };
  output: { relativePath: string; sha256: string; crs: 'EPSG:4326'; geometryTypes: string[]; featureCount: number };
  warnings: string[];
  durationMs: number;
  createdAt: string;
};

export type SpatialAnalysisResultParseResult =
  | { ok: true; value: SpatialAnalysisResultV1; diagnostics: [] }
  | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

const SHA256_RE = /^[a-f0-9]{64}$/;
const RELATIVE_PATH_RE = /^(?![A-Za-z]:)(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$)).+$/;

export function parseSpatialAnalysisResultStructured(value: unknown): SpatialAnalysisResultParseResult {
  const root = asRecord(value);
  const diagnostics: ContractDiagnostic[] = [];
  if (!root) return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'spatial', message: 'Spatial analysis result must be an object.' })] };
  const operation = asString(root.operation, 40) as SpatialOperation | null;
  if (root.protocol !== SPATIAL_ANALYSIS_PROTOCOL) diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'spatial.protocol', message: 'Unsupported spatial protocol.' }));
  if (root.schemaVersion !== 1) diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'spatial.schemaVersion', message: 'Unsupported spatial schemaVersion.', expected: 1, received: typeof root.schemaVersion === 'string' || typeof root.schemaVersion === 'number' ? root.schemaVersion : String(root.schemaVersion) }));
  if (!operation || !(SPATIAL_OPERATIONS as readonly string[]).includes(operation)) diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'spatial.operation', message: 'Unsupported spatial operation.' }));
  const analysisId = asString(root.analysisId, 120);
  const createdAt = asString(root.createdAt, 80);
  const durationMs = asFiniteNumber(root.durationMs);
  if (!analysisId || !createdAt || !Number.isFinite(Date.parse(createdAt)) || durationMs === null || durationMs < 0) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'spatial', message: 'analysisId, createdAt and non-negative durationMs are required.' }));

  const inputs: SpatialAnalysisResultV1['inputs'] = [];
  if (!Array.isArray(root.inputs) || !root.inputs.length) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'spatial.inputs', message: 'At least one input is required.' }));
  else root.inputs.forEach((candidate, index) => {
    const item = asRecord(candidate); const role = item?.role; const relativePath = asString(item?.relativePath, 1000); const sha256 = asString(item?.sha256, 64); const crs = asString(item?.crs, 120); const featureCount = asInteger(item?.featureCount);
    if ((role !== 'input' && role !== 'left' && role !== 'right') || !relativePath || !RELATIVE_PATH_RE.test(relativePath) || !sha256 || !SHA256_RE.test(sha256) || !crs || featureCount === null || featureCount < 0) diagnostics.push(diagnostic({ code: 'invalid_type', path: `spatial.inputs[${index}]`, message: 'Invalid spatial input record.' }));
    else inputs.push({ role, relativePath, sha256, crs, featureCount });
  });

  const parametersRoot = asRecord(root.parameters);
  const parameters: Record<string, string | number | boolean> = {};
  if (!parametersRoot) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'spatial.parameters', message: 'parameters must be an object.' }));
  else for (const [key, parameter] of Object.entries(parametersRoot)) {
    if (typeof parameter !== 'string' && typeof parameter !== 'number' && typeof parameter !== 'boolean' || typeof parameter === 'number' && !Number.isFinite(parameter)) diagnostics.push(diagnostic({ code: 'invalid_type', path: `spatial.parameters.${key}`, message: 'Spatial parameters must be finite JSON primitives.' }));
    else parameters[key] = parameter;
  }

  const countsRoot = asRecord(root.counts);
  const countNames = ['input', 'output', 'unmatched', 'invalidGeometry', 'emptyGeometry'] as const;
  const counts = {} as SpatialAnalysisResultV1['counts'];
  for (const name of countNames) {
    const count = asInteger(countsRoot?.[name]);
    if (count === null || count < 0) diagnostics.push(diagnostic({ code: 'out_of_range', path: `spatial.counts.${name}`, message: 'Spatial counts must be non-negative integers.' }));
    else counts[name] = count;
  }

  const outputRoot = asRecord(root.output); const outputPath = asString(outputRoot?.relativePath, 1000); const outputHash = asString(outputRoot?.sha256, 64); const outputCount = asInteger(outputRoot?.featureCount);
  const geometryTypes = Array.isArray(outputRoot?.geometryTypes) ? outputRoot.geometryTypes.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
  if (!outputPath || !RELATIVE_PATH_RE.test(outputPath) || !outputHash || !SHA256_RE.test(outputHash) || outputRoot?.crs !== 'EPSG:4326' || outputCount === null || outputCount < 0 || !Array.isArray(outputRoot?.geometryTypes) || geometryTypes.length !== outputRoot.geometryTypes.length) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'spatial.output', message: 'Invalid spatial output record.' }));
  const warnings = Array.isArray(root.warnings) ? root.warnings.filter((item): item is string => typeof item === 'string' && item.length <= 1000) : [];
  if (!Array.isArray(root.warnings) || warnings.length !== root.warnings.length) diagnostics.push(diagnostic({ code: 'invalid_type', path: 'spatial.warnings', message: 'warnings must be strings.' }));
  if (diagnostics.length || !operation || !analysisId || !createdAt || durationMs === null || !outputPath || !outputHash || outputCount === null || !parametersRoot) return { ok: false, value: null, diagnostics };
  return { ok: true, diagnostics: [], value: { protocol: SPATIAL_ANALYSIS_PROTOCOL, schemaVersion: 1, analysisId, operation, inputs, parameters, counts, output: { relativePath: outputPath, sha256: outputHash, crs: 'EPSG:4326', geometryTypes, featureCount: outputCount }, warnings, durationMs, createdAt } };
}
