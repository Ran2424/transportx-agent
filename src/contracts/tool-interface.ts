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

export type CoreToolBinding = { toolId: string; piName: string; file: string; execution: 'host' | 'pi-local' };

// Platform-owned bindings; Pi remains the only tool registry and runtime.
export const CORE_TOOL_BINDINGS: Record<string, CoreToolBinding[]> = {
  'com.transportx.tool-activation': [
    { toolId: 'capabilities.manage', piName: 'manage_capabilities', file: 'tool-contract.json', execution: 'pi-local' },
  ],
  'com.transportx.module-authoring': [
    { toolId: 'module.package', piName: 'tau_module_package', file: 'tool-contract.json', execution: 'host' },
  ],
  'com.transportx.cad': [
    { toolId: 'cad.draw', piName: 'cad_draw', file: 'tool-contract.json', execution: 'host' },
    { toolId: 'cad.inspect', piName: 'cad_inspect', file: 'inspect-contract.json', execution: 'host' },
    { toolId: 'cad.verify', piName: 'cad_verify', file: 'verify-contract.json', execution: 'host' },
    { toolId: 'cad.execution', piName: 'cad_execution', file: 'execution-contract.json', execution: 'host' },
  ],
  'com.transportx.spatial-analysis': [
    { toolId: 'spatial.analyze', piName: 'tau_spatial_analyze', file: 'tool-contract.json', execution: 'host' },
    { toolId: 'spatial.execution', piName: 'tau_spatial_execution', file: 'execution-contract.json', execution: 'host' },
  ],
  'com.transportx.citation': [
    { toolId: 'citation.resolve', piName: 'tau_resolve_citation', file: 'tool-contract.json', execution: 'host' },
  ],
  'com.transportx.canvas': [
    { toolId: 'canvas.present', piName: 'canvas_present', file: 'tool-contract.json', execution: 'host' },
    { toolId: 'canvas.inspect', piName: 'canvas_inspect_context', file: 'inspect-contract.json', execution: 'host' },
  ],
  'com.transportx.geo': [
    { toolId: 'geo.present', piName: 'present_visualization', file: 'tool-contract.json', execution: 'pi-local' },
    { toolId: 'geo.publish', piName: 'publish_geodata', file: 'publish-contract.json', execution: 'pi-local' },
    { toolId: 'geo.inspect', piName: 'inspect_map_context', file: 'inspect-contract.json', execution: 'host' },
    { toolId: 'geo.request', piName: 'request_geo_input', file: 'request-contract.json', execution: 'host' },
    { toolId: 'geo.screenshot', piName: 'capture_geo_screenshot', file: 'screenshot-contract.json', execution: 'host' },
  ],
  'com.transportx.interaction': [
    { toolId: 'interaction.ask', piName: 'tau_ask_user', file: 'tool-contract.json', execution: 'pi-local' },
  ],
};

export function coreModulePath(moduleId: string) {
  if (!CORE_TOOL_BINDINGS[moduleId]) throw new Error(`No core tools for ${moduleId}`);
  return `${moduleId === 'com.transportx.module-authoring' ? 'official' : 'capabilities'}/${moduleId.slice('com.transportx.'.length)}`;
}

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
