import type { ModuleInstaller } from '../module-installer.js';
import type { ModuleRegistry } from '../module-registry.js';
import type { RpcHandlerRegistry, RpcReply } from '../rpc-handlers.js';

type ModuleRpcDependencies = {
  desktopMode: boolean;
  installer: ModuleInstaller;
  registry: ModuleRegistry;
  reloadModules(): void;
  setModuleEnabled(moduleId: string, enabled: boolean): void;
  hasActiveModule(moduleId: string): boolean;
  overview(): unknown;
  errorMessage(error: unknown): string;
};

const desktopOnlyMessage = 'Module installation is only available in the desktop app';

export function createModuleRpcHandlers(deps: ModuleRpcDependencies): RpcHandlerRegistry {
  const unavailable = (reply: RpcReply) => deps.desktopMode ? null : reply.failure(desktopOnlyMessage);
  return {
    install_module: {
      handle: (command, reply) => {
        const blocked = unavailable(reply); if (blocked) return blocked;
        let installed: { id: string; name: string; version: string; path: string } | null = null;
        try {
          installed = deps.installer.install(String(command.sourcePath || ''));
          deps.reloadModules();
          if (deps.registry.get(installed.id)?.origin !== 'installed') throw new Error(`Module id conflicts with an existing module: ${installed.id}`);
          deps.setModuleEnabled(installed.id, true);
          return reply.success({ installed, overview: deps.overview() });
        } catch (error) {
          if (installed) {
            try { deps.installer.uninstall(installed.id); } catch {}
            try { deps.reloadModules(); } catch {}
          }
          return reply.failure(deps.errorMessage(error));
        }
      },
    },
    inspect_module_archive: {
      handle: async (command, reply) => {
        const blocked = unavailable(reply); if (blocked) return blocked;
        try {
          const reservedModuleIds = new Set([...deps.registry.modules.values()].filter((module) => module.origin !== 'installed').map((module) => module.manifest.id));
          return reply.success({ inspection: await deps.installer.inspectArchive(String(command.sourcePath || ''), reservedModuleIds) });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    install_module_archive: {
      handle: async (command, reply) => {
        const blocked = unavailable(reply); if (blocked) return blocked;
        try {
          const selections = Array.isArray(command.selections)
            ? command.selections.filter((selection): selection is { id: string; version: string } => !!selection && typeof selection.id === 'string' && typeof selection.version === 'string')
            : [];
          const installed = await deps.installer.installArchive(String(command.importId || ''), selections);
          deps.reloadModules();
          for (const module of installed) deps.setModuleEnabled(module.id, true);
          return reply.success({ installed, overview: deps.overview() });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    discard_module_archive: {
      handle: (command, reply) => {
        const blocked = unavailable(reply); if (blocked) return blocked;
        deps.installer.discardArchive(String(command.importId || ''));
        return reply.success();
      },
    },
    uninstall_module: {
      handle: (command, reply) => {
        const blocked = unavailable(reply); if (blocked) return blocked;
        try {
          const moduleId = String(command.moduleId || '');
          if (deps.hasActiveModule(moduleId)) throw new Error('Close active tasks that use this module before uninstalling it');
          deps.installer.uninstall(moduleId, deps.registry);
          deps.reloadModules();
          return reply.success({ overview: deps.overview() });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    set_module_enabled: {
      handle: (command, reply) => {
        const blocked = unavailable(reply); if (blocked) return blocked;
        try {
          deps.setModuleEnabled(String(command.moduleId || ''), command.enabled === true);
          return reply.success({ overview: deps.overview() });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
    migrate_legacy_modules: {
      handle: (_command, reply) => {
        const blocked = unavailable(reply); if (blocked) return blocked;
        try {
          const migrated = deps.installer.migrateLegacyPackages();
          deps.reloadModules();
          return reply.success({ migrated, overview: deps.overview() });
        } catch (error) { return reply.failure(deps.errorMessage(error)); }
      },
    },
  };
}
