import type { RpcHandlerRegistry } from '../rpc-handlers.js';

export function createPlatformRpcHandlers(overview: (sessionId?: string) => unknown, openLogs: () => Promise<void>, openModule: (moduleId: string) => Promise<void>): RpcHandlerRegistry {
  return {
    get_platform_overview: {
      handle: (command, reply) => reply.success(overview(command.sessionId)),
    },
    open_module_directory: {
      handle: async (command, reply) => {
        if (!command.moduleId) return reply.failure('moduleId is required');
        try {
          await openModule(String(command.moduleId));
          return reply.success();
        } catch (cause) { return reply.failure(cause instanceof Error ? cause.message : String(cause)); }
      },
    },
    open_logs_directory: {
      handle: async (_command, reply) => { await openLogs(); return reply.success(); },
    },
  };
}
