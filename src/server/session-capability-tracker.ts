import {
  PI_WEB_BRIDGE_ENTRY,
  acceptBridgeRevision,
  latestPiWebBridgeEnvelopeStructured,
  matchCapabilities,
  parsePiWebBridgeEnvelopeStructured,
  runtimeCapabilities,
  type CapabilityMismatchReason,
  type ContractDiagnostic,
  type JsonRecord,
  type PiWebBridgeEnvelope,
  type RuntimeCapabilities,
} from '../contracts/index.js';

export type CapabilityUpdate =
  | { kind: 'missing' }
  | { kind: 'invalid'; diagnostics: ContractDiagnostic[] }
  | { kind: 'rejected'; diagnostic?: ContractDiagnostic }
  | { kind: 'accepted'; envelope: PiWebBridgeEnvelope; mismatches: CapabilityMismatchReason[] };

export class SessionCapabilityTracker {
  capabilities: RuntimeCapabilities;
  mismatches: CapabilityMismatchReason[];
  diagnostics: ContractDiagnostic[];
  private lastBridgeRevision: number | null;

  constructor(private readonly piVersion: string) {
    this.capabilities = runtimeCapabilities(piVersion);
    this.mismatches = [];
    this.diagnostics = [];
    this.lastBridgeRevision = null;
  }

  snapshot() {
    return {
      ...this.capabilities,
      ok: this.mismatches.length === 0 && this.diagnostics.length === 0,
      mismatches: this.mismatches,
      diagnostics: this.diagnostics,
    };
  }

  applyPayload(value: unknown): CapabilityUpdate {
    const result = parsePiWebBridgeEnvelopeStructured(value);
    if (!result.ok) {
      this.diagnostics = result.diagnostics;
      return { kind: 'invalid', diagnostics: result.diagnostics };
    }
    return this.applyEnvelope(result.value);
  }

  applyLatest(entries: JsonRecord[]): CapabilityUpdate {
    const hasBridgeEntry = entries.some((entry) => entry.type === 'custom' && entry.customType === PI_WEB_BRIDGE_ENTRY);
    if (!hasBridgeEntry) {
      this.capabilities = runtimeCapabilities(this.piVersion);
      this.mismatches = [];
      this.diagnostics = [];
      return { kind: 'missing' };
    }
    const result = latestPiWebBridgeEnvelopeStructured(entries);
    if (!result.ok) {
      this.diagnostics = result.diagnostics;
      return { kind: 'invalid', diagnostics: result.diagnostics };
    }
    return this.applyEnvelope(result.value);
  }

  private applyEnvelope(envelope: PiWebBridgeEnvelope): CapabilityUpdate {
    const verdict = acceptBridgeRevision(this.lastBridgeRevision, envelope);
    if (!verdict.accepted) return { kind: 'rejected', diagnostic: verdict.diagnostic };
    this.lastBridgeRevision = envelope.revision;
    this.diagnostics = [];
    const match = matchCapabilities({ ...envelope.capabilities, piVersion: this.piVersion });
    this.capabilities = match.capabilities;
    this.mismatches = match.ok ? [] : match.mismatches;
    return { kind: 'accepted', envelope, mismatches: this.mismatches };
  }
}
