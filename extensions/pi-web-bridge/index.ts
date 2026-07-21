import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const BRIDGE_ENTRY = 'pi-web-bridge';
const SCHEMA_VERSION = 1 as const;

type BridgeModel = { provider: string; id: string; name?: string; contextWindow?: number };
type BridgeTool = {
  name: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
  sourceInfo?: unknown;
  active: boolean;
};
type BridgeEnvelope = {
  schemaVersion: 1;
  revision: number;
  model?: BridgeModel;
  thinkingLevel: string;
  tools: BridgeTool[];
};

function bridgeModel(model: ExtensionContext['model']): BridgeModel | undefined {
  if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string') return undefined;
  return {
    provider: model.provider,
    id: model.id,
    ...(typeof model.name === 'string' ? { name: model.name } : {}),
    ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
  };
}

function parseEnvelope(value: unknown): BridgeEnvelope | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== SCHEMA_VERSION || !Number.isInteger(data.revision) || Number(data.revision) < 1) return null;
  if (typeof data.thinkingLevel !== 'string' || !Array.isArray(data.tools)) return null;
  return data as BridgeEnvelope;
}

export default function piWebBridge(pi: ExtensionAPI) {
  let revision = 0;
  let previousSignature = '';

  const collect = (ctx: ExtensionContext, modelOverride?: ExtensionContext['model'], thinkingOverride?: string) => {
    const active = new Set(pi.getActiveTools());
    const tools = pi.getAllTools().map<BridgeTool>((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      ...(tool.sourceInfo ? { sourceInfo: tool.sourceInfo } : {}),
      active: active.has(tool.name),
    }));
    return {
      ...(bridgeModel(modelOverride || ctx.model) ? { model: bridgeModel(modelOverride || ctx.model) } : {}),
      thinkingLevel: thinkingOverride || pi.getThinkingLevel(),
      tools,
    };
  };

  const publish = (ctx: ExtensionContext, modelOverride?: ExtensionContext['model'], thinkingOverride?: string) => {
    const state = collect(ctx, modelOverride, thinkingOverride);
    const signature = JSON.stringify(state);
    if (signature === previousSignature) return;
    previousSignature = signature;
    revision += 1;
    pi.appendEntry(BRIDGE_ENTRY, { schemaVersion: SCHEMA_VERSION, revision, ...state });
  };

  pi.on('session_start', async (_event, ctx) => {
    revision = 0;
    previousSignature = '';
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== BRIDGE_ENTRY) continue;
      const envelope = parseEnvelope(entry.data);
      if (!envelope || envelope.revision < revision) continue;
      revision = envelope.revision;
      const { schemaVersion: _schemaVersion, revision: _revision, ...state } = envelope;
      previousSignature = JSON.stringify(state);
    }
    publish(ctx);
  });
  pi.on('agent_start', async (_event, ctx) => publish(ctx));
  pi.on('model_select', async (event, ctx) => publish(ctx, event.model));
  pi.on('thinking_level_select', async (event, ctx) => publish(ctx, undefined, event.level));
}
