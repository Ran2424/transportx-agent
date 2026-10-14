import type { RpcHandlerRegistry } from '../rpc-handlers.js';

export function createPlatformRpcHandlers(overview: () => unknown, openLogs: () => Promise<void>): RpcHandlerRegistry {
  return {
    get_platform_overview: {
      handle: (_command, reply) => reply.success(overview()),
    },
    open_logs_directory: {
      handle: async (_command, reply) => { await openLogs(); return reply.success(); },
    },
  };
}
