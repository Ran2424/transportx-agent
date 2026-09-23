/**
 * Version constants and version negotiation helpers for the project-owned
 * contracts. The companion file `src/contracts/diagnostic.ts` defines the
 * shared `ContractDiagnostic` shape used by every parser.
 */
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';

export const CONTRACT_VERSION = '1.28.0';

/**
 * Stable `schemaVersion` literals for the project-owned contract surfaces.
 *
 * - Session snapshot: schema v1 (browser/server side agreement).
 * - Task snapshot: schema v1 (Pi task-mode state entry + tool result details).
 * - Geo envelope: protocol version "1.0" (string-typed to match the wire envelope).
 * - Pi Web Bridge envelope: schema v1 (revisioned runtime manifest).
 */
export const SESSION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const TASK_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const GEO_ENVELOPE_PROTOCOL = 'pi-visualization' as const;
export const GEO_ENVELOPE_VERSION = '1.0' as const;
export const CITATION_ENVELOPE_PROTOCOL = 'pi-citation' as const;
export const CITATION_ENVELOPE_VERSION = '2.0' as const;
export const BRIDGE_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const CANVAS_PRESENTATION_PROTOCOL = 'pi-canvas' as const;
export const CANVAS_PRESENTATION_VERSION = '1.0' as const;
export const CANVAS_CONTEXT_PROTOCOL = 'pi-canvas-context' as const;
export const CANVAS_CONTEXT_VERSION = '1.0' as const;

/** Mirror contract version that the Browser Kernel / Server expects from Pi workers. */
export const PI_RUNTIME_MINIMUM = '0.80.10';

/**
 * Surface an unknown schema/revision as a structured diagnostic. Used by every
 * contract parser when the wire payload carries a different schema or revision
 * than the one this build understands.
 */
export function unknownVersionDiagnostic(input: {
  path: string;
  field: 'schemaVersion' | 'version' | 'revision';
  received: unknown;
  expected: number | string;
}): ContractDiagnostic {
  return diagnostic({
    code: 'unknown_schema_version',
    path: input.path,
    message: `${input.field}=${JSON.stringify(input.received)} is not supported (expected ${input.expected}).`,
    ...(input.field === 'revision' ? { severity: 'warning' } : {}),
    expected: input.expected,
    received: input.received as ContractDiagnostic['received'],
  });
}
