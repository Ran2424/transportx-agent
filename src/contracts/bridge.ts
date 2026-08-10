/**
 * Pi Web Bridge envelope shared between the Pi extension (`modules/capabilities/web-bridge/extensions/pi-web-bridge/`)
 * and the Server (`src/server/sessions.ts`). The extension emits a revised
 * manifest every time Pi's tool set, model or thinking level changes; the
 * server records the latest revision so the Browser Kernel can hydrate the
 * active runtime capabilities.
 *
 * Phase 3 changes:
 *   - Parsers expose structured `ContractDiagnostic` so unknown schemaVersion
 *     or revision regression surface to the Browser Kernel as `AppError`s.
 *   - `latestEnvelope()` is the single source of truth used by both sides.
 */
import { asRecord, asString, asPositiveInteger, asFiniteNumber, type JsonRecord } from './common.ts';
import type { ModelIdentity } from './common.ts';
import { BRIDGE_ENVELOPE_SCHEMA_VERSION } from './version.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import { parseRuntimeCapabilities, runtimeCapabilities, type RuntimeCapabilities } from './capabilities.ts';

export const PI_WEB_BRIDGE_ENTRY = 'pi-web-bridge';

export type PiToolManifestItem = {
  name: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
  sourceInfo?: unknown;
  active: boolean;
};

export type PiWebBridgeEnvelope = {
  schemaVersion: typeof BRIDGE_ENVELOPE_SCHEMA_VERSION;
  revision: number;
  model: ModelIdentity | null;
  thinkingLevel: string;
  tools: PiToolManifestItem[];
  capabilities: RuntimeCapabilities;
};

export type BridgeDiagnostic = ContractDiagnostic;
export type BridgeParseResult<T> =
  | { ok: true; value: T; diagnostics: [] }
  | { ok: false; value: null; diagnostics: BridgeDiagnostic[] };

function collect(diagnostics: BridgeDiagnostic[]) {
  return (path: string, code: string, message: string, severity: 'warning' | 'error' = 'error') => {
    diagnostics.push(diagnostic({ code: code as BridgeDiagnostic['code'], path, message, severity }));
  };
}

export function parsePiWebBridgeEnvelopeStructured(value: unknown, sink: BridgeDiagnostic[] = []): BridgeParseResult<PiWebBridgeEnvelope> {
  const target = sink;
  const fail = collect(target);
  const data = asRecord(value);
  if (!data) return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'envelope', message: 'Envelope must be an object.' })] };

  if (data.schemaVersion !== BRIDGE_ENVELOPE_SCHEMA_VERSION) {
    fail('envelope.schemaVersion', 'unknown_schema_version', `Unsupported schemaVersion ${JSON.stringify(data.schemaVersion)}; expected ${BRIDGE_ENVELOPE_SCHEMA_VERSION}.`);
    return { ok: false, value: null, diagnostics: target };
  }

  const revision = asPositiveInteger(data.revision);
  if (revision === null) {
    fail('envelope.revision', 'out_of_range', 'revision must be a positive integer.');
    return { ok: false, value: null, diagnostics: target };
  }

  if (typeof data.thinkingLevel !== 'string' || !data.thinkingLevel) {
    fail('envelope.thinkingLevel', 'invalid_type', 'thinkingLevel must be a non-empty string.');
    return { ok: false, value: null, diagnostics: target };
  }

  if (!Array.isArray(data.tools)) {
    fail('envelope.tools', 'invalid_type', 'tools must be an array.');
    return { ok: false, value: null, diagnostics: target };
  }

  const rawModel = asRecord(data.model);
  let model: ModelIdentity | null = null;
  if (rawModel) {
    if (typeof rawModel.provider !== 'string' || typeof rawModel.id !== 'string') {
      fail('envelope.model', 'unsupported_value', 'model.provider and model.id must be strings when model is provided.');
    } else {
      model = rawModel as ModelIdentity;
    }
  }

  const capabilityResult = data.capabilities === undefined
    ? { ok: true as const, value: runtimeCapabilities(), diagnostics: [] as [] }
    : parseRuntimeCapabilities(data.capabilities);
  if (!capabilityResult.ok) {
    target.push(...capabilityResult.diagnostics);
    return { ok: false, value: null, diagnostics: target };
  }

  const tools: PiToolManifestItem[] = [];
  for (let index = 0; index < data.tools.length; index++) {
    const tool = asRecord(data.tools[index]);
    const path = `envelope.tools[${index}]`;
    if (!tool) {
      fail(`${path}`, 'invalid_type', 'Tool entry must be an object.');
      return { ok: false, value: null, diagnostics: target };
    }
    if (typeof tool.name !== 'string' || !tool.name) {
      fail(`${path}.name`, 'missing_required_field', 'Tool name is required.');
      return { ok: false, value: null, diagnostics: target };
    }
    if (typeof tool.description !== 'string') {
      fail(`${path}.description`, 'invalid_type', 'Tool description must be a string.');
      return { ok: false, value: null, diagnostics: target };
    }
    if (typeof tool.active !== 'boolean') {
      fail(`${path}.active`, 'invalid_type', 'Tool active must be a boolean.');
      return { ok: false, value: null, diagnostics: target };
    }
    const promptGuidelines = Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.every((item) => typeof item === 'string')
      ? (tool.promptGuidelines as string[])
      : undefined;
    tools.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(promptGuidelines ? { promptGuidelines } : {}),
      ...(tool.sourceInfo !== undefined ? { sourceInfo: tool.sourceInfo } : {}),
      active: tool.active,
    });
  }

  if (target.some((diag) => diag.severity === 'error')) {
    return { ok: false, value: null, diagnostics: target };
  }

  return {
    ok: true,
    value: {
      schemaVersion: BRIDGE_ENVELOPE_SCHEMA_VERSION,
      revision,
      model,
      thinkingLevel: data.thinkingLevel,
      tools,
      capabilities: capabilityResult.value,
    },
    diagnostics: [],
  };
}

/**
 * Backwards-compatible boolean parser used by the Server today: returns the
 * Envelope on success or `null` on any structural failure.
 */
export function parsePiWebBridgeEnvelope(value: unknown): PiWebBridgeEnvelope | null {
  return parsePiWebBridgeEnvelopeStructured(value).value;
}

/**
 * Walk Pi JSONL entries and return the latest valid revision of the Pi Web
 * Bridge envelope. Entries with revision regression against the current best
 * candidate are silently skipped — the extension always writes revisions
 * in order, so regression here always means "no newer envelope existed yet".
 *
 * Diagnostics are returned when ALL candidates fail validation, which lets the
 * Server surface a `protocol` AppError.
 */
export function latestPiWebBridgeEnvelopeStructured(
  entries: JsonRecord[],
  sink: BridgeDiagnostic[] = [],
): BridgeParseResult<PiWebBridgeEnvelope> {
  const diagnostics = sink;
  let latest: PiWebBridgeEnvelope | null = null;
  let hadCandidate = false;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== PI_WEB_BRIDGE_ENTRY) continue;
    hadCandidate = true;
    const result = parsePiWebBridgeEnvelopeStructured(entry.data, diagnostics);
    if (!result.ok) continue;
    if (!latest || result.value.revision > latest.revision) {
      latest = result.value;
    } else if (result.value.revision === latest.revision && diagnostics.length === 0) {
      diagnostics.push(diagnostic({
        code: 'revision_regression',
        path: 'envelope.revision',
        message: `Two envelopes share revision ${result.value.revision}; keeping the first.`,
        severity: 'warning',
        received: result.value.revision,
      }));
    }
  }
  if (latest) return { ok: true, value: latest, diagnostics: [] };
  if (hadCandidate) return { ok: false, value: null, diagnostics: diagnostics.length ? diagnostics : [diagnostic({ code: 'missing_required_field', path: 'entries', message: 'No valid pi-web-bridge envelope was found.' })] };
  return { ok: false, value: null, diagnostics: [diagnostic({ code: 'missing_required_field', path: 'entries', message: 'No pi-web-bridge envelope present in supplied entries.' })] };
}

/**
 * Backwards-compatible boolean variant.
 */
export function latestPiWebBridgeEnvelope(entries: JsonRecord[]): PiWebBridgeEnvelope | null {
  return latestPiWebBridgeEnvelopeStructured(entries).value;
}

/** Detect a revision regression against the previously known manifest. */
export function acceptBridgeRevision(
  previous: PiWebBridgeEnvelope | number | null,
  next: PiWebBridgeEnvelope,
): { accepted: boolean; diagnostic?: BridgeDiagnostic } {
  const previousRevision = typeof previous === 'number' ? previous : previous?.revision;
  if (previousRevision !== undefined && next.revision <= previousRevision) {
    return {
      accepted: false,
      diagnostic: diagnostic({
        code: 'revision_regression',
        path: 'envelope.revision',
        message: `Incoming bridge revision ${next.revision} is not greater than current ${previousRevision}.`,
        severity: 'warning',
        expected: previousRevision + 1,
        received: next.revision,
      }),
    };
  }
  return { accepted: true };
}

/** Helper used by callers that only need the minimum vocabulary. */
export function asNumberIfPresent(value: unknown): number | undefined {
  const n = asFiniteNumber(value);
  return n ?? undefined;
}

export const BRIDGE_CONTRACT_NAMESPACE = 'bridge' as const;
