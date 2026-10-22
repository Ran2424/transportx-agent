import fs from 'node:fs';
import { canonicalToolSchema, type ToolDiagnostic, type ToolInterfaceContract } from '../contracts/tool-interface.js';
import type { JsonRecord, PiWebBridgeEnvelope, ResolvedPlanModule } from '../contracts/index.js';
import { parseCitationEnvelope, parseSpatialAnalysisResultStructured } from '../contracts/index.js';

type Observation = { envelope: PiWebBridgeEnvelope | null; live: boolean; observedAt?: string };

// Read-only reconciliation at a product read point. No registration, activation,
// polling, resource authorization or stored availability state is performed.
export function diagnoseTool(contract: ToolInterfaceContract, selected: ResolvedPlanModule | undefined, observation: Observation | undefined, entries: JsonRecord[], sessionId?: string, hostContract = contract): ToolDiagnostic {
  const base = { moduleId: contract.moduleId, toolId: contract.toolId, piName: contract.piName, contractVersion: contract.contractVersion, ...(sessionId ? { sessionId } : {}), ...(observation?.envelope ? { observedRevision: observation.envelope.revision, observedAt: observation.observedAt } : {}) };
  const result = (state: ToolDiagnostic['state'], reason: string): ToolDiagnostic => ({ ...base, state, reason });
  if (!sessionId) return result('unverified', 'no_session');
  if (!selected) return result('unavailable', 'not_selected');
  if (!observation?.live || !observation.envelope) return result('unverified', 'no_live_observation');
  if (hostContract.contractVersion.split('.')[0] !== contract.contractVersion.split('.')[0]) return result('unavailable', 'host_contract_incompatible');
  if (hostContract.semanticVersion !== contract.semanticVersion || canonicalToolSchema(hostContract.input) !== canonicalToolSchema(contract.input)) return result('unverified', 'host_contract_drift');
  const tool = observation.envelope.tools.find((item) => item.name === contract.piName);
  if (!tool) return result('unavailable', 'missing_tool');
  if (!tool.active) return result('unavailable', 'inactive');
  const source = tool.sourceInfo as { path?: unknown } | undefined;
  if (!source || typeof source.path !== 'string' || source.path.startsWith('<')) return result('unverified', 'source_unverified');
  let sourcePath: string;
  try { sourcePath = fs.realpathSync(source.path); } catch { return result('unverified', 'source_unverified'); }
  const ownsSource = selected.entrypoints.some((entry) => {
    if (entry.kind !== 'extension') return false;
    try { return fs.realpathSync(entry.path) === sourcePath; } catch { return false; }
  });
  if (!ownsSource) return result('unavailable', 'name_conflict');
  if (canonicalToolSchema(tool.parameters) !== canonicalToolSchema(contract.input)) return result('unverified', 'schema_drift');
  const hostConfirmed = entries.some((entry) => {
    const message = entry.message as { role?: string; toolName?: string; isError?: boolean; details?: { kind?: string; citations?: unknown; result?: unknown } } | undefined;
    if (message?.role !== 'toolResult' || message.toolName !== contract.piName || message.isError || message.details?.kind !== contract.output.detailsKind) return false;
    return contract.toolId === 'citation.resolve' ? !!parseCitationEnvelope(message.details.citations) : parseSpatialAnalysisResultStructured(message.details.result).ok;
  });
  return hostConfirmed ? result('available', 'observed_and_executed') : result('unverified', 'host_not_verified');
}
