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
  private lastEnvelope: PiWebBridgeEnvelope | null = null;
  private liveEntryId: string | null = null;
  private observedAt: string | undefined;

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
      toolObservation: { revision: this.lastEnvelope?.revision, live: !!this.liveEntryId, observedAt: this.observedAt },
    };
  }

  observation() {
    return { envelope: this.lastEnvelope, live: !!this.liveEntryId, observedAt: this.observedAt };
  }

  invalidateObservation(resetRevision = false) {
    this.liveEntryId = null;
    if (resetRevision) this.lastBridgeRevision = null;
  }

  applyPayload(value: unknown, entryId?: string): CapabilityUpdate {
    const result = parsePiWebBridgeEnvelopeStructured(value);
    if (!result.ok) {
      this.diagnostics = result.diagnostics;
      this.invalidateObservation();
      return { kind: 'invalid', diagnostics: result.diagnostics };
    }
    const update = this.applyEnvelope(result.value);
    if (update.kind === 'accepted') {
      this.liveEntryId = entryId || null;
      this.observedAt = new Date().toISOString();
    }
    return update;
  }

  applyLatest(entries: JsonRecord[]): CapabilityUpdate {
    if (this.liveEntryId && !entries.some((entry) => entry.id === this.liveEntryId)) this.invalidateObservation();
    const hasBridgeEntry = entries.some((entry) => entry.type === 'custom' && entry.customType === PI_WEB_BRIDGE_ENTRY);
    if (!hasBridgeEntry) {
      this.capabilities = runtimeCapabilities(this.piVersion);
      this.mismatches = [];
      this.diagnostics = [];
      this.lastEnvelope = null;
      this.invalidateObservation(true);
      return { kind: 'missing' };
    }
    const result = latestPiWebBridgeEnvelopeStructured(entries);
    if (!result.ok) {
      this.diagnostics = result.diagnostics;
      this.invalidateObservation();
      return { kind: 'invalid', diagnostics: result.diagnostics };
    }
    return this.applyEnvelope(result.value);
  }

  private applyEnvelope(envelope: PiWebBridgeEnvelope): CapabilityUpdate {
    const verdict = acceptBridgeRevision(this.lastBridgeRevision, envelope);
    if (!verdict.accepted) return { kind: 'rejected', diagnostic: verdict.diagnostic };
    this.lastBridgeRevision = envelope.revision;
    this.lastEnvelope = envelope;
    this.diagnostics = [];
    const match = matchCapabilities({ ...envelope.capabilities, piVersion: this.piVersion });
    this.capabilities = match.capabilities;
    this.mismatches = match.ok ? [] : match.mismatches;
    return { kind: 'accepted', envelope, mismatches: this.mismatches };
  }
}
