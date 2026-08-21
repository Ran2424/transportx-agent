import type { RpcHandlerRegistry } from '../rpc-handlers.js';

type AuthRpcDependencies = {
  configured: boolean;
  getEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  notifyChanged(enabled: boolean): void;
  disconnectClients(): void;
};

export function createAuthRpcHandlers(deps: AuthRpcDependencies): RpcHandlerRegistry {
  return {
    get_auth: {
      handle: (_command, reply) => reply.success({ configured: deps.configured, enabled: deps.getEnabled() }),
    },
    set_auth: {
      handle: (command, reply) => {
        if (!deps.configured) return reply.failure('No credentials configured. Set tau.user and tau.pass in settings.json');
        const wasEnabled = deps.getEnabled();
        const enabled = command.enabled === true;
        deps.setEnabled(enabled);
        deps.notifyChanged(enabled);
        if (!wasEnabled && enabled) deps.disconnectClients();
        return reply.success({ enabled });
      },
    },
  };
}
