import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const ResourceSchema = Type.Union([
  Type.Object({ scope: Type.Literal('session-file'), path: Type.String({ minLength: 1, maxLength: 1000 }) }, { additionalProperties: false }),
  Type.Object({ scope: Type.Literal('citation'), resourceId: Type.String({ minLength: 1, maxLength: 160 }), sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, { additionalProperties: false }),
  Type.Object({ scope: Type.Literal('capability'), moduleId: Type.String({ minLength: 1, maxLength: 200 }), resourceId: Type.String({ minLength: 1, maxLength: 160 }), revision: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
]);

const PresentSchema = Type.Object({
  adapterId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  operation: Type.Optional(Type.Union([Type.Literal('present'), Type.Literal('focus'), Type.Literal('update'), Type.Literal('clear')])),
  resource: Type.Optional(ResourceSchema),
  target: Type.Optional(Type.Unknown()),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  viewId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
}, { additionalProperties: false });

const InspectSchema = Type.Object({
  contextIds: Type.Array(Type.String({ pattern: '^canvas_context_[a-f0-9-]+$' }), { minItems: 1, maxItems: 20 }),
}, { additionalProperties: false });

function canvasHost() {
  const endpoint = process.env.TAU_CANVAS_ENDPOINT;
  const sessionId = process.env.TAU_CANVAS_SESSION_ID;
  const token = process.env.TAU_CANVAS_TOKEN;
  if (!endpoint || !sessionId || !token) throw new Error('Canvas Agent Host bridge is unavailable for this session.');
  return { endpoint, sessionId, token };
}

async function hostRequest(path: string, body: Record<string, unknown>) {
  const host = canvasHost();
  const response = await fetch(`${host.endpoint}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, sessionId: host.sessionId, token: host.token }),
  });
  const payload = await response.json() as { error?: string; canvas?: unknown; contexts?: unknown };
  if (!response.ok) throw new Error(payload.error || 'Canvas Agent Host request failed.');
  return payload;
}

export default function canvasExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'canvas_present',
    label: '在 Canvas 中呈现',
    description: 'Present, focus, update, clear, or navigate an authorized resource in the shared Canvas. Use a session-relative path for local documents.',
    parameters: PresentSchema,
    async execute(_toolCallId, params) {
      if (!params.resource && !params.viewId) throw new Error('resource or viewId is required.');
      const { canvas } = await hostRequest('/api/internal/canvas/present', params as Record<string, unknown>);
      if (!canvas) throw new Error('Canvas Agent Host did not return a presentation.');
      return {
        content: [{ type: 'text' as const, text: 'Canvas presentation accepted.' }],
        details: { kind: 'tau-canvas' as const, canvas },
      };
    },
  });
  pi.registerTool({
    name: 'canvas_inspect_context',
    label: '读取已附加的 Canvas 上下文',
    description: 'Read only Canvas context IDs explicitly attached to the current user turn.',
    parameters: InspectSchema,
    async execute(_toolCallId, params) {
      const { contexts } = await hostRequest('/api/internal/canvas/inspect', params as Record<string, unknown>);
      if (!Array.isArray(contexts)) throw new Error('Canvas Agent Host did not return contexts.');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(contexts, null, 2) }],
        details: { kind: 'tau-canvas-contexts' as const, contexts },
      };
    },
  });
}
