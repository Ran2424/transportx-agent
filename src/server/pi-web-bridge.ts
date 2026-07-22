/**
 * Re-export shim. The contract authority for the Pi Web Bridge envelope is
 * `src/contracts/bridge.ts`. Existing Server/tests imports remain valid while
 * new Server code imports directly from `src/contracts/`.
 */
export {
  PI_WEB_BRIDGE_ENTRY,
  parsePiWebBridgeEnvelope,
  parsePiWebBridgeEnvelopeStructured,
  latestPiWebBridgeEnvelope,
  latestPiWebBridgeEnvelopeStructured,
  acceptBridgeRevision,
} from '../contracts/bridge.js';

export type {
  PiToolManifestItem,
  PiWebBridgeEnvelope,
  BridgeDiagnostic,
  BridgeParseResult,
} from '../contracts/bridge.js';
