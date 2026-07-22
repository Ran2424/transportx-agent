import type { SessionEntry } from '../../../public/app-types.js';
import type { ToolExecution } from '../../../public/kernel/actions.js';
import { getVisualizationFromToolResult, type VisualizationEnvelope } from '../../../contracts/geo.js';

export function projectVisualizations(entries: SessionEntry[], executions: ToolExecution[]): VisualizationEnvelope[] {
  const byId = new Map<string, VisualizationEnvelope>();
  const accept = (value: unknown) => { const item = getVisualizationFromToolResult(value); if (item && (!byId.has(item.visualizationId) || byId.get(item.visualizationId)!.revision < item.revision)) byId.set(item.visualizationId, item); };
  entries.forEach((entry) => accept(entry.message));
  executions.forEach((execution) => accept(execution.result));
  return [...byId.values()].filter((item) => item.scene).sort((a, b) => b.revision - a.revision);
}
