import { readFileSync } from 'node:fs';
import type { TSchema } from 'typebox';
import { parseToolInterfaceContract } from '../../../../../src/contracts/tool-interface.ts';
import { parseCanvasPresentation, parseCanvasContext } from '../../../../../src/contracts/canvas.ts';
import { HostCallError, postHostOperation } from '../../../../shared/host-client.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function contract(file: string) {
  const value = parseToolInterfaceContract(JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')));
  if (!value) throw new Error('Invalid Canvas Tool Contract');
  return value;
}
const presentContract = contract('tool-contract.json');
const inspectContract = contract('inspect-contract.json');

function canvasHost() {
  const endpoint = process.env.TAU_CANVAS_ENDPOINT;
  const sessionId = process.env.TAU_CANVAS_SESSION_ID;
  const token = process.env.TAU_CANVAS_TOKEN;
  if (!endpoint || !sessionId || !token) throw new Error('Canvas Agent Host bridge is unavailable for this session.');
  return { endpoint, sessionId, token };
}

export default function canvasExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'canvas_present',
    label: '在 Canvas 中呈现',
    description: 'Present, focus, update, clear, or navigate an authorized resource in the shared Canvas. Use a session-relative path for local documents.',
    parameters: presentContract.input as unknown as TSchema,
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as Record<string, unknown>;
      if (!params.resource && !params.viewId) throw new Error('resource or viewId is required.');
      const payload = await postHostOperation<{ canvas: unknown }>(canvasHost(), '/api/internal/canvas/present', params, { toolCallId, contractVersion: presentContract.contractVersion, signal, timeoutMs: 30_000 });
      const canvas = parseCanvasPresentation(payload.canvas);
      if (!canvas) throw new HostCallError('Canvas presentation was not confirmed. Inspect existing views before another request.', 'host_result_unknown', 'response_decode', 'unknown');
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
    parameters: inspectContract.input as unknown as TSchema,
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as Record<string, unknown>;
      const { contexts } = await postHostOperation<{ contexts: unknown[] }>(canvasHost(), '/api/internal/canvas/inspect', params, { toolCallId, contractVersion: inspectContract.contractVersion, signal, timeoutMs: 30_000 });
      if (!Array.isArray(contexts) || contexts.some((context) => !parseCanvasContext(context))) throw new HostCallError('Canvas contexts were not confirmed.', 'host_result_unknown', 'response_decode', 'unknown');
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(contexts, null, 2) }],
        details: { kind: 'tau-canvas-contexts' as const, contexts },
      };
    },
  });
}
