import type { RpcHandlerRegistry } from '../rpc-handlers.js';
import type { RpcCommand, RpcResponse } from '../types.js';
import type { SessionAttachment } from '../../contracts/attachments.js';

type NativeSession = {
  id: string;
  cwd: string;
  model: Record<string, unknown> | null;
  thinkingLevel: string;
  autoCompactionEnabled: boolean;
  pendingExtensionUiRequests: Map<string, unknown>;
  manager: { broadcastUpdated(sessionId: string): void };
  send(command: RpcCommand, options: { timeoutMs: number }): Promise<RpcResponse>;
  registerPromptAttachments(attachmentIds: string[]): void;
  discardPromptAttachments(attachmentIds: string[]): void;
};

type NativeRpcDependencies<T extends NativeSession> = {
  getLiveSession(sessionId: string): T | null | undefined;
  resolveAttachments(cwd: string, attachmentIds: string[]): SessionAttachment[];
  attachmentBase64(cwd: string, attachment: SessionAttachment): string;
  buildAttachmentContext(attachments: SessionAttachment[]): string;
  parseModel(model: unknown): { model: { provider?: string; id?: string } | null };
  errorMessage(error: unknown): string;
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
    let trackedPromptAttachments: string[] | null = null;
    try {
      let rpcCommand = { ...command };
      delete rpcCommand.clientCommandId;
      if (['prompt', 'steer', 'follow_up'].includes(command.type || '')) {
        const rawIds = command.attachmentIds;
        const attachmentIds = rawIds === undefined ? [] : Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === 'string') : null;
        if (!attachmentIds) return reply.failure('attachmentIds must be an array');
        const attachments = deps.resolveAttachments(session.cwd, attachmentIds);
        const message = typeof command.message === 'string' ? command.message : '';
        const imageInputs = session.model && (session.model.images === true || (Array.isArray(session.model.input) && session.model.input.includes('image')))
          ? attachments.filter((attachment) => attachment.kind === 'image').map((attachment) => ({ type: 'image', data: deps.attachmentBase64(session.cwd, attachment), mimeType: attachment.mimeType }))
          : [];
        rpcCommand = { ...command, message: `${message}${deps.buildAttachmentContext(attachments)}`, ...(imageInputs.length ? { images: imageInputs } : {}) } as RpcCommand;
        delete rpcCommand.attachmentIds;
      }
      if (command.type === 'set_model' && (!command.provider || !command.modelId)) {
        const parsed = deps.parseModel(command.model);
        if (!parsed.model?.provider || !parsed.model.id) return reply.failure('模型格式无效，请使用 provider/model');
        rpcCommand = { ...command, provider: parsed.model.provider, modelId: parsed.model.id };
      }
      if (['prompt', 'steer', 'follow_up'].includes(command.type || '')) {
        trackedPromptAttachments = Array.isArray(command.attachmentIds) ? command.attachmentIds.filter((id): id is string => typeof id === 'string') : [];
        session.registerPromptAttachments(trackedPromptAttachments);
      }
      const response = await session.send(rpcCommand, { timeoutMs: command.type === 'prompt' ? 300000 : 60000 });
      if (command.type === 'extension_ui_response' && typeof command.id === 'string') session.pendingExtensionUiRequests.delete(command.id);
      if (command.type === 'set_auto_compaction' && response.success !== false) {
        session.autoCompactionEnabled = command.enabled === true;
        session.manager.broadcastUpdated(session.id);
      }
      if (response.success === false && previousLevel !== null) session.thinkingLevel = previousLevel;
      return { ...response, success: response.success !== false };
    } catch (error) {
      if (previousLevel !== null) session.thinkingLevel = previousLevel;
      if (trackedPromptAttachments) session.discardPromptAttachments(trackedPromptAttachments);
      return reply.failure(deps.errorMessage(error));
    }
  };
  return Object.fromEntries(NATIVE_COMMANDS.map((type) => [type, { native: true, reliable: RELIABLE_COMMANDS.has(type), handle }])) as RpcHandlerRegistry;
}
