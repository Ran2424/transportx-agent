import fs from 'node:fs';
import { CORE_TOOL_BINDINGS, canonicalToolSchema, type ToolDiagnostic, type ToolInterfaceContract } from '../contracts/tool-interface.js';
import type { JsonRecord, PiWebBridgeEnvelope, ResolvedPlanModule } from '../contracts/index.js';
import { asRecord, parseCitationEnvelope, parseSpatialAnalysisResultStructured, parseCanvasPresentation, parseCanvasContext, parseVisualizationEnvelope, parseGeoClientContextStructured, parseGeoInteractionResponseStructured } from '../contracts/index.js';

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
  if (!tool.active) return result('unverified', 'inactive');
  const confirmed = entries.some((entry) => {
    const message = asRecord(entry.message);
    if (message?.role !== 'toolResult' || message.toolName !== contract.piName || message.isError) return false;
    const details = asRecord(message.details);
    if (!details) return false;
    if (contract.toolId === 'spatial.execution' && details.kind === 'tau-spatial-analysis') return parseSpatialAnalysisResultStructured(details.result).ok;
    if (details.kind !== contract.output.detailsKind) return false;
    const value = asRecord(details.result);
    switch (contract.toolId) {
      case 'capabilities.manage': return ['discover', 'inspect', 'enable', 'status'].includes(String(details.action));
      case 'citation.resolve': return !!parseCitationEnvelope(details.citations);
      case 'spatial.analyze': return parseSpatialAnalysisResultStructured(details.result).ok;
      case 'spatial.execution': return typeof details.operationId === 'string' && ['prepared', 'running', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(String(details.state));
      case 'module.package': return details.action === 'inspect' || details.action === 'install' && details.installed === true;
      case 'canvas.present': return !!parseCanvasPresentation(details.canvas);
      case 'canvas.inspect': return Array.isArray(details.contexts) && details.contexts.length > 0 && details.contexts.every((item) => !!parseCanvasContext(item));
      case 'geo.present': return !!parseVisualizationEnvelope(details.visualization) && !!parseCanvasPresentation(details.canvas);
      case 'geo.publish': {
        const resource = asRecord(details.resource);
        return !!resource && /^geo_[a-f0-9]{16,64}$/.test(String(resource.resourceId)) && /^[a-f0-9]{64}$/.test(String(resource.sha256)) && Number.isInteger(resource.featureCount);
      }
      case 'geo.inspect': return value?.status === 'no_geo_context' || value?.status === 'ok' && Array.isArray(value.contexts) && value.contexts.every((item) => parseGeoClientContextStructured(item).ok);
      case 'geo.request': return !!value && parseGeoInteractionResponseStructured(value.response).ok;
      case 'geo.screenshot': return value?.status === 'captured' && typeof value.relativePath === 'string' && typeof value.bytes === 'number' && value.bytes > 0;
      case 'interaction.ask': return typeof details.interactionId === 'string' && ['answered', 'cancelled'].includes(String(details.status));
      default: return false;
    }
  });
  const execution = CORE_TOOL_BINDINGS[contract.moduleId]?.find((binding) => binding.toolId === contract.toolId)?.execution;
  return confirmed ? result('available', 'observed_and_executed') : result('unverified', execution === 'pi-local' ? 'pi_not_verified' : 'host_not_verified');
}
