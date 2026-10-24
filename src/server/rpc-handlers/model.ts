import { addLocalPiModel, addPiModel, deletePiModel, deletePiModelProvider, updatePiModel } from '../pi-model-config.js';
import { connectPiModelProvider, disconnectPiModelProvider, listPiModelProviders, refreshPiModels } from '../pi-model-access.js';
import { discoverLocalModels } from '../local-model-service.js';
import type { AddLocalModelInput } from '../../contracts/local-model.js';
import type { RpcHandlerRegistry } from '../rpc-handlers.js';
import type { RpcCommand } from '../types.js';

type ModelRpcDependencies = {
  agentDir: string;
  getAvailableModels(): Promise<unknown>;
  syncModels?(sessionId: string): Promise<void>;
  errorMessage(error: unknown): string;
};

function provider(command: RpcCommand) { return String(command.provider || ''); }

export function createModelRpcHandlers(deps: ModelRpcDependencies): RpcHandlerRegistry {
  return {
    get_available_models: {
      handle: async (_command, reply) => reply.success({ models: await deps.getAvailableModels() }),
    },
    refresh_models: {
      handle: async (command, reply) => {
        try {
          const refreshed = await refreshPiModels(deps.agentDir);
          const result = { ...refreshed, errors: [...refreshed.errors] };
          if (command.sessionId && deps.syncModels) {
            try { await deps.syncModels(command.sessionId); }
            catch (error) { result.errors.push({ message: deps.errorMessage(error) }); }
          }
          return reply.success(result);
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
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
          return reply.success({ provider: connected });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    disconnect_model_provider: {
      handle: async (command, reply) => {
        try {
          await disconnectPiModelProvider(provider(command), deps.agentDir);
          return reply.success();
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    add_model: {
      handle: async (command, reply) => {
        try {
          const model = await addPiModel(command as Omit<Partial<import('../pi-model-config.js').AddPiModelInput>, 'api'> & { api?: string }, deps.agentDir);
          return reply.success({ model });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    discover_local_models: {
      handle: async (command, reply) => {
        try { return reply.success(await discoverLocalModels({ baseUrl: String(command.baseUrl || ''), apiKey: String(command.apiKey || '') })); }
        catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    add_local_model: {
      handle: async (command, reply) => {
        try {
          const model = await addLocalPiModel(command as AddLocalModelInput, deps.agentDir);
          return reply.success({ model });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    update_model: {
      handle: async (command, reply) => {
        try {
          const model = await updatePiModel(command as { provider: string; modelId: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; images?: boolean }, deps.agentDir);
          return reply.success({ model });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    delete_model: {
      handle: async (command, reply) => {
        try {
          await deletePiModel(provider(command), String(command.modelId || ''), deps.agentDir);
          return reply.success();
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    delete_model_provider: {
      handle: async (command, reply) => {
        try {
          await deletePiModelProvider(provider(command), deps.agentDir);
          return reply.success();
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
  };
}
