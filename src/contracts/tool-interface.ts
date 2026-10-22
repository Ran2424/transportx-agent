import { asRecord } from './common.ts';

export type ToolInterfaceContract = {
  moduleId: string; toolId: string; piName: string; contractVersion: string;
  semanticVersion: string; input: Record<string, unknown>;
  output: { protocol: string; version: string | number; detailsKind: string };
};

export type ToolDiagnostic = {
  moduleId: string; toolId: string; piName: string; contractVersion: string;
  state: 'available' | 'unavailable' | 'unverified'; reason: string;
  sessionId?: string; observedRevision?: number; observedAt?: string;
};

export const PILOT_TOOL_IDS: Record<string, { toolId: string; piName: string }> = {
  'com.transportx.spatial-analysis': { toolId: 'spatial.analyze', piName: 'tau_spatial_analyze' },
  'com.transportx.citation': { toolId: 'citation.resolve', piName: 'tau_resolve_citation' },
};

export function parseToolInterfaceContract(value: unknown): ToolInterfaceContract | null {
  const record = asRecord(value), input = asRecord(record?.input), output = asRecord(record?.output);
  if (!record || !input || input.type !== 'object' || !output) return null;
  if (['moduleId', 'toolId', 'piName', 'semanticVersion'].some((key) => typeof record[key] !== 'string' || !record[key] || String(record[key]).length > 200)) return null;
  if (typeof record.contractVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(record.contractVersion)) return null;
  if (typeof output.protocol !== 'string' || typeof output.detailsKind !== 'string' || !['string', 'number'].includes(typeof output.version)) return null;
  return record as unknown as ToolInterfaceContract;
}

// Preserve property names (including "description"/"title") and literal data;
// strip annotations only while visiting a JSON Schema, not its property map.
export function canonicalToolSchema(value: unknown, mode: 'schema' | 'map' | 'data' = 'schema'): string {
  const normalize = (item: unknown, context: typeof mode): unknown => {
    if (Array.isArray(item)) return item.map((entry) => normalize(entry, context));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([key, child]) => {
      if (context === 'schema' && ['description', 'title', '$comment', 'examples'].includes(key)) return [];
      const next = context === 'data' ? 'data' : context === 'map' ? 'schema' : ['properties', 'patternProperties', '$defs', 'definitions'].includes(key) ? 'map' : ['const', 'enum', 'default'].includes(key) ? 'data' : 'schema';
      return [[key, normalize(child, next)]];
    }));
  };
  return JSON.stringify(normalize(value, mode));
}
