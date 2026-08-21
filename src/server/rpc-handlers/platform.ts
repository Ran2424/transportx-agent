import type { RpcHandlerRegistry } from '../rpc-handlers.js';

export function createPlatformRpcHandlers(overview: () => unknown): RpcHandlerRegistry {
  return {
    get_platform_overview: {
      handle: (_command, reply) => reply.success(overview()),
    },
  };
}
