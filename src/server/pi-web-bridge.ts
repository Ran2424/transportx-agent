import type { JsonRecord, ModelIdentity } from './types.js';

export const PI_WEB_BRIDGE_ENTRY = 'pi-web-bridge';

export type PiToolManifestItem = {
  name: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
  sourceInfo?: unknown;
  active: boolean;
};

export type PiWebBridgeEnvelope = {
  schemaVersion: 1;
  revision: number;
  model: ModelIdentity | null;
  thinkingLevel: string;
  tools: PiToolManifestItem[];
};

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

export function parsePiWebBridgeEnvelope(value: unknown): PiWebBridgeEnvelope | null {
  const data = record(value);
  if (!data || data.schemaVersion !== 1 || !Number.isInteger(data.revision) || Number(data.revision) < 1) return null;
  if (typeof data.thinkingLevel !== 'string' || !Array.isArray(data.tools)) return null;
  const rawModel = record(data.model);
  const model = rawModel && typeof rawModel.provider === 'string' && typeof rawModel.id === 'string'
    ? rawModel as ModelIdentity
    : null;
  const tools: PiToolManifestItem[] = [];
  for (const candidate of data.tools) {
    const tool = record(candidate);
    if (!tool || typeof tool.name !== 'string' || typeof tool.description !== 'string' || typeof tool.active !== 'boolean') return null;
    tools.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.every((item) => typeof item === 'string') ? { promptGuidelines: tool.promptGuidelines as string[] } : {}),
      ...(tool.sourceInfo !== undefined ? { sourceInfo: tool.sourceInfo } : {}),
      active: tool.active,
    });
  }
  return {
    schemaVersion: 1,
    revision: Number(data.revision),
    model,
    thinkingLevel: data.thinkingLevel,
    tools,
  };
}

export function latestPiWebBridgeEnvelope(entries: JsonRecord[]) {
  let latest: PiWebBridgeEnvelope | null = null;
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== PI_WEB_BRIDGE_ENTRY) continue;
    const envelope = parsePiWebBridgeEnvelope(entry.data);
    if (envelope && (!latest || envelope.revision > latest.revision)) latest = envelope;
  }
  return latest;
}
