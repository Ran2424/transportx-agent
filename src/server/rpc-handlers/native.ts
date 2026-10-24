import type { RpcHandlerRegistry } from '../rpc-handlers.js';
import type { RpcCommand, RpcResponse } from '../types.js';
import type { SessionAttachment } from '../../contracts/attachments.js';
import crypto from 'node:crypto';

type NativeSession = {
  id: string;
  cwd: string;
  model: Record<string, unknown> | null;
  thinkingLevel: string;
  autoCompactionEnabled: boolean;
  pendingExtensionUiRequests: Map<string, unknown>;
  manager: { broadcastUpdated(sessionId: string): void };
  send(command: RpcCommand, options: { timeoutMs: number; onLateResponse?: (response: RpcResponse) => void }): Promise<RpcResponse>;
  registerPendingMessage(pending: { commandId: string; text: string; attachmentIds: string[]; geoContextIds: string[]; canvasContextIds: string[] }): void;
  discardPendingMessage(commandId: string): void;
  abortGeoInteraction(): void | Promise<void>;
};

type NativeRpcDependencies<T extends NativeSession> = {
  getLiveSession(sessionId: string): T | null | undefined;
  resolveAttachments(cwd: string, attachmentIds: string[]): SessionAttachment[];
  attachmentBase64(cwd: string, attachment: SessionAttachment): string;
  buildAttachmentContext(attachments: SessionAttachment[]): string;
  validateGeoContexts(session: T, contextIds: unknown): string[];
  buildGeoContext(contextIds: string[]): string;
  validateCanvasContexts(session: T, contextIds: unknown): string[];
  buildCanvasContext(contextIds: string[]): string;
  parseModel(model: unknown): { model: { provider?: string; id?: string } | null };
  errorMessage(error: unknown): string;
  syncModels?(session: T): Promise<void>;
  completeCommand?(command: RpcCommand, response: RpcResponse): void;
};

const NATIVE_COMMANDS = ['prompt', 'steer', 'follow_up', 'abort', 'compact', 'get_state', 'set_auto_compaction', 'set_model', 'cycle_model', 'set_thinking_level', 'cycle_thinking_level', 'get_session_stats', 'get_commands', 'extension_ui_response'] as const;
const RELIABLE_COMMANDS = new Set(['prompt', 'steer', 'follow_up', 'abort', 'extension_ui_response']);

export function createNativeRpcHandlers<T extends NativeSession>(deps: NativeRpcDependencies<T>): RpcHandlerRegistry {
  const handle = async (command: RpcCommand, reply: { success(data?: unknown): RpcResponse; failure(message: string): RpcResponse }) => {
    const session = command.sessionId ? deps.getLiveSession(command.sessionId) : null;
    if (!session) return reply.failure('No active Tau session. 没有活跃的交通任务，请先创建或选择一个任务。');
    const previousLevel = command.type === 'set_thinking_level' ? session.thinkingLevel : null;
    if (command.type === 'extension_ui_response' && (typeof command.id !== 'string' || !session.pendingExtensionUiRequests.has(command.id))) return reply.failure('Extension UI request is no longer pending');
    if (previousLevel !== null && command.level) session.thinkingLevel = command.level;
    let pendingId: string | null = null;
    try {
      if (command.type === 'abort') await session.abortGeoInteraction();
      let rpcCommand = { ...command };
      delete rpcCommand.clientCommandId;
      if (['prompt', 'steer', 'follow_up'].includes(command.type || '')) {
        const rawIds = command.attachmentIds;
        const attachmentIds = rawIds === undefined ? [] : Array.isArray(rawIds) && rawIds.every((id) => typeof id === 'string') ? rawIds as string[] : null;
        if (!attachmentIds) return reply.failure('attachmentIds must be an array');
        const attachments = deps.resolveAttachments(session.cwd, attachmentIds);
        const geoContextIds = command.geoContextIds === undefined ? [] : deps.validateGeoContexts(session, command.geoContextIds);
        const canvasContextIds = command.canvasContextIds === undefined ? [] : deps.validateCanvasContexts(session, command.canvasContextIds);
        const message = typeof command.message === 'string' ? command.message : '';
        if (!message.trim()) return reply.failure('message must be a non-empty string');
        const imageInputs = session.model && (session.model.images === true || (Array.isArray(session.model.input) && session.model.input.includes('image')))
          ? attachments.filter((attachment) => attachment.kind === 'image').map((attachment) => ({ type: 'image', data: deps.attachmentBase64(session.cwd, attachment), mimeType: attachment.mimeType }))
          : [];
        rpcCommand = { ...command, message: `${message}${deps.buildAttachmentContext(attachments)}${deps.buildGeoContext(geoContextIds)}${deps.buildCanvasContext(canvasContextIds)}`, ...(imageInputs.length ? { images: imageInputs } : {}) } as RpcCommand;
        delete rpcCommand.attachmentIds;
        delete rpcCommand.geoContextIds;
        delete rpcCommand.canvasContextIds;
        delete rpcCommand.clientCommandId;
        // Pi events contain text, not the RPC id; match enriched content rather
        // than queue order (steer can overtake follow_up).
        if (!message.startsWith('/') || attachmentIds.length || geoContextIds.length || canvasContextIds.length) {
          pendingId = crypto.randomUUID();
          rpcCommand.id = pendingId;
          session.registerPendingMessage({ commandId: pendingId, text: rpcCommand.message as string, attachmentIds, geoContextIds, canvasContextIds });
        }
      }
      if (command.type === 'set_model' && (!command.provider || !command.modelId)) {
        const parsed = deps.parseModel(command.model);
        if (!parsed.model?.provider || !parsed.model.id) return reply.failure('模型格式无效，请使用 provider/model');
        rpcCommand = { ...command, provider: parsed.model.provider, modelId: parsed.model.id };
      }
      if (command.type === 'set_model' || command.type === 'cycle_model') await deps.syncModels?.(session);
      delete rpcCommand.clientCommandId;
      const response = await session.send(rpcCommand, {
        timeoutMs: command.type === 'prompt' ? 300000 : 60000,
        onLateResponse: (late) => {
          if (late.success === false && pendingId) session.discardPendingMessage(pendingId);
          deps.completeCommand?.(command, { ...late, delivery: late.success === false ? 'rejected' : 'accepted' });
        },
      });
      if (response.success === false && pendingId) session.discardPendingMessage(pendingId);
      if (response.success !== false && command.type === 'extension_ui_response' && typeof command.id === 'string') session.pendingExtensionUiRequests.delete(command.id);
      if (command.type === 'set_auto_compaction' && response.success !== false) {
        session.autoCompactionEnabled = command.enabled === true;
        session.manager.broadcastUpdated(session.id);
      }
      if (response.success === false && previousLevel !== null) session.thinkingLevel = previousLevel;
      return { ...response, success: response.success !== false, delivery: response.success === false ? 'rejected' : 'accepted' };
    } catch (error) {
      if (previousLevel !== null) session.thinkingLevel = previousLevel;
      const unknown = (error as { delivery?: string })?.delivery === 'unknown' || deps.errorMessage(error).includes('RPC command timed out:');
      if (!unknown && pendingId) session.discardPendingMessage(pendingId);
      return { ...reply.failure(deps.errorMessage(error)), delivery: unknown ? 'unknown' : 'rejected' };
    }
  };
  return Object.fromEntries(NATIVE_COMMANDS.map((type) => [type, { native: true, reliable: RELIABLE_COMMANDS.has(type), handle }])) as RpcHandlerRegistry;
}
