import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import {
  BRIDGE_ENVELOPE_SCHEMA_VERSION,
  PI_WEB_BRIDGE_ENTRY,
  parsePiWebBridgeEnvelope,
  runtimeCapabilities,
  type ModelIdentity,
  type PiToolManifestItem,
} from '../../../../../src/contracts/index.ts';

type BridgeModel = ModelIdentity & { provider: string; id: string };

function bridgeModel(model: ExtensionContext['model']): BridgeModel | undefined {
  if (!model || typeof model.provider !== 'string' || typeof model.id !== 'string') return undefined;
  return {
    provider: model.provider,
    id: model.id,
    ...(typeof model.name === 'string' ? { name: model.name } : {}),
    ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
  };
}

export default function piWebBridge(pi: ExtensionAPI) {
  let revision = 0;
  let previousSignature = '';

  const collect = (ctx: ExtensionContext, modelOverride?: ExtensionContext['model'], thinkingOverride?: string) => {
    const active = new Set(pi.getActiveTools());
    const tools = pi.getAllTools().map<PiToolManifestItem>((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      ...(tool.sourceInfo ? { sourceInfo: tool.sourceInfo } : {}),
      active: active.has(tool.name),
    }));
    return {
      model: bridgeModel(modelOverride || ctx.model) || null,
      thinkingLevel: thinkingOverride || pi.getThinkingLevel(),
      tools,
      capabilities: runtimeCapabilities(),
    };
  };

  const publish = (ctx: ExtensionContext, modelOverride?: ExtensionContext['model'], thinkingOverride?: string) => {
    const state = collect(ctx, modelOverride, thinkingOverride);
    const signature = JSON.stringify(state);
    if (signature === previousSignature) return;
    previousSignature = signature;
    revision += 1;
    pi.appendEntry(PI_WEB_BRIDGE_ENTRY, { schemaVersion: BRIDGE_ENVELOPE_SCHEMA_VERSION, revision, ...state });
  };

  pi.on('session_start', async (_event, ctx) => {
    revision = 0;
    previousSignature = '';
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== PI_WEB_BRIDGE_ENTRY) continue;
      const envelope = parsePiWebBridgeEnvelope(entry.data);
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
