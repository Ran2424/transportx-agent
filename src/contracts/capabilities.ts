/**
 * Minimum runtime capability declaration shared by the Bridge extension,
 * Server session lifecycle and Browser Kernel.
 *
 * Keep this intentionally small. Capability growth must follow an actual
 * cross-version requirement rather than mirroring every Pi feature.
 */
import { asRecord } from './common.ts';
import { diagnostic, type ContractDiagnostic } from './diagnostic.ts';
import {
  BRIDGE_ENVELOPE_SCHEMA_VERSION,
  GEO_ENVELOPE_VERSION,
  TASK_SNAPSHOT_SCHEMA_VERSION,
  PI_RUNTIME_MINIMUM,
} from './version.ts';

export type ExtensionUiKind = 'select' | 'confirm' | 'input' | 'editor' | 'notify';

export type RuntimeCapabilities = {
  piVersion: string;
  bridgeVersion: typeof BRIDGE_ENVELOPE_SCHEMA_VERSION;
  taskEnvelopeVersion: typeof TASK_SNAPSHOT_SCHEMA_VERSION;
  geoSceneVersion: typeof GEO_ENVELOPE_VERSION;
  extensionUiKinds: ExtensionUiKind[];
  eventReplay: boolean;
};

export const SUPPORTED_EXTENSION_UI_KINDS: readonly ExtensionUiKind[] = ['select', 'confirm', 'input', 'editor', 'notify'];

export type CapabilityParseResult =
  | { ok: true; value: RuntimeCapabilities; diagnostics: [] }
  | { ok: false; value: null; diagnostics: ContractDiagnostic[] };

export function runtimeCapabilities(piVersion = PI_RUNTIME_MINIMUM): RuntimeCapabilities {
  return {
    piVersion,
    bridgeVersion: BRIDGE_ENVELOPE_SCHEMA_VERSION,
    taskEnvelopeVersion: TASK_SNAPSHOT_SCHEMA_VERSION,
    geoSceneVersion: GEO_ENVELOPE_VERSION,
    extensionUiKinds: [...SUPPORTED_EXTENSION_UI_KINDS],
    eventReplay: true,
  };
}

export function parseRuntimeCapabilities(value: unknown): CapabilityParseResult {
  const input = asRecord(value);
  if (!input) {
    return { ok: false, value: null, diagnostics: [diagnostic({ code: 'invalid_type', path: 'capabilities', message: 'Runtime capabilities must be an object.' })] };
  }
  const diagnostics: ContractDiagnostic[] = [];
  if (typeof input.piVersion !== 'string' || !input.piVersion) {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'capabilities.piVersion', message: 'piVersion must be a non-empty string.' }));
  }
  if (input.bridgeVersion !== BRIDGE_ENVELOPE_SCHEMA_VERSION) {
    diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'capabilities.bridgeVersion', message: `Unsupported bridgeVersion ${JSON.stringify(input.bridgeVersion)}.`, expected: BRIDGE_ENVELOPE_SCHEMA_VERSION, received: input.bridgeVersion as number }));
  }
  if (input.taskEnvelopeVersion !== TASK_SNAPSHOT_SCHEMA_VERSION) {
    diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'capabilities.taskEnvelopeVersion', message: `Unsupported taskEnvelopeVersion ${JSON.stringify(input.taskEnvelopeVersion)}.`, expected: TASK_SNAPSHOT_SCHEMA_VERSION, received: input.taskEnvelopeVersion as number }));
  }
  if (input.geoSceneVersion !== GEO_ENVELOPE_VERSION) {
    diagnostics.push(diagnostic({ code: 'unknown_schema_version', path: 'capabilities.geoSceneVersion', message: `Unsupported geoSceneVersion ${JSON.stringify(input.geoSceneVersion)}.`, expected: GEO_ENVELOPE_VERSION, received: input.geoSceneVersion as string }));
  }
  if (!Array.isArray(input.extensionUiKinds) || !input.extensionUiKinds.every((kind) => SUPPORTED_EXTENSION_UI_KINDS.includes(kind as ExtensionUiKind))) {
    diagnostics.push(diagnostic({ code: 'unsupported_value', path: 'capabilities.extensionUiKinds', message: 'extensionUiKinds contains an unsupported value.' }));
  }
  if (typeof input.eventReplay !== 'boolean') {
    diagnostics.push(diagnostic({ code: 'invalid_type', path: 'capabilities.eventReplay', message: 'eventReplay must be a boolean.' }));
  }
  if (diagnostics.length) return { ok: false, value: null, diagnostics };
  return {
    ok: true,
    value: {
      piVersion: input.piVersion as string,
      bridgeVersion: BRIDGE_ENVELOPE_SCHEMA_VERSION,
      taskEnvelopeVersion: TASK_SNAPSHOT_SCHEMA_VERSION,
      geoSceneVersion: GEO_ENVELOPE_VERSION,
      extensionUiKinds: [...input.extensionUiKinds as ExtensionUiKind[]],
      eventReplay: input.eventReplay as boolean,
    },
    diagnostics: [],
  };
}

export type CapabilityMismatchReason = {
  field: keyof RuntimeCapabilities;
  message: string;
  expected?: string | number;
  received?: string | number;
};

export type CapabilityMatchResult =
  | { ok: true; capabilities: RuntimeCapabilities }
  | { ok: false; capabilities: RuntimeCapabilities; mismatches: CapabilityMismatchReason[] };

/** Compare a Bridge declaration against the minimum supported contract set. */
export function matchCapabilities(advertised: RuntimeCapabilities): CapabilityMatchResult {
  const mismatches: CapabilityMismatchReason[] = [];
  if (advertised.bridgeVersion !== BRIDGE_ENVELOPE_SCHEMA_VERSION) {
    mismatches.push({ field: 'bridgeVersion', message: 'Bridge envelope version is incompatible.', expected: BRIDGE_ENVELOPE_SCHEMA_VERSION, received: advertised.bridgeVersion });
  }
  if (advertised.taskEnvelopeVersion !== TASK_SNAPSHOT_SCHEMA_VERSION) {
    mismatches.push({ field: 'taskEnvelopeVersion', message: 'Task snapshot version is incompatible.', expected: TASK_SNAPSHOT_SCHEMA_VERSION, received: advertised.taskEnvelopeVersion });
  }
  if (advertised.geoSceneVersion !== GEO_ENVELOPE_VERSION) {
    mismatches.push({ field: 'geoSceneVersion', message: 'Geo scene version is incompatible.', expected: GEO_ENVELOPE_VERSION, received: advertised.geoSceneVersion });
  }
  if (advertised.piVersion.localeCompare(PI_RUNTIME_MINIMUM, undefined, { numeric: true }) < 0) {
    mismatches.push({ field: 'piVersion', message: `Pi runtime is older than minimum ${PI_RUNTIME_MINIMUM}.`, expected: PI_RUNTIME_MINIMUM, received: advertised.piVersion });
  }
  const advertisedKinds = new Set(advertised.extensionUiKinds);
  const missingKinds = SUPPORTED_EXTENSION_UI_KINDS.filter((kind) => !advertisedKinds.has(kind));
  if (missingKinds.length) {
    mismatches.push({ field: 'extensionUiKinds', message: `Missing extension UI kinds: ${missingKinds.join(', ')}.`, received: missingKinds.join(', ') });
  }
  return mismatches.length
    ? { ok: false, capabilities: advertised, mismatches }
    : { ok: true, capabilities: advertised };
}
