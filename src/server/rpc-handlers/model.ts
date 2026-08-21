import { addPiModel, deletePiModel, deletePiModelProvider, updatePiModel } from '../pi-model-config.js';
import { connectPiModelProvider, disconnectPiModelProvider, listPiModelProviders } from '../pi-model-access.js';
import type { RpcHandlerRegistry } from '../rpc-handlers.js';
import type { RpcCommand } from '../types.js';

type ModelRpcDependencies = {
  agentDir: string;
  getAvailableModels(): Promise<unknown>;
  invalidateModelListCache(): void;
  errorMessage(error: unknown): string;
};

function provider(command: RpcCommand) { return String(command.provider || ''); }

export function createModelRpcHandlers(deps: ModelRpcDependencies): RpcHandlerRegistry {
  return {
    get_available_models: {
      handle: async (_command, reply) => reply.success({ models: await deps.getAvailableModels() }),
    },
    get_model_providers: {
      handle: async (_command, reply) => {
        try { return reply.success({ providers: await listPiModelProviders(deps.agentDir) }); }
        catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    connect_model_provider: {
      handle: async (command, reply) => {
        try {
          const connected = await connectPiModelProvider(provider(command), String(command.apiKey || ''), deps.agentDir);
          deps.invalidateModelListCache();
          return reply.success({ provider: connected });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    disconnect_model_provider: {
      handle: async (command, reply) => {
        try {
          await disconnectPiModelProvider(provider(command), deps.agentDir);
          deps.invalidateModelListCache();
          return reply.success();
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    add_model: {
      handle: async (command, reply) => {
        try {
          const model = await addPiModel(command as Omit<Partial<import('../pi-model-config.js').AddPiModelInput>, 'api'> & { api?: string }, deps.agentDir);
          deps.invalidateModelListCache();
          return reply.success({ model });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    update_model: {
      handle: async (command, reply) => {
        try {
          const model = await updatePiModel(command as { provider: string; modelId: string; name?: string; contextWindow?: number; reasoning?: boolean; images?: boolean }, deps.agentDir);
          deps.invalidateModelListCache();
          return reply.success({ model });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    delete_model: {
      handle: async (command, reply) => {
        try {
          await deletePiModel(provider(command), String(command.modelId || ''), deps.agentDir);
          deps.invalidateModelListCache();
          return reply.success();
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    delete_model_provider: {
      handle: async (command, reply) => {
        try {
          await deletePiModelProvider(provider(command), deps.agentDir);
          deps.invalidateModelListCache();
          return reply.success();
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
  };
}
