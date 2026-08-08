const path = require('node:path');

import type { AppPaths } from './app-paths.js';
import type { AssetResolver } from './asset-resolver.js';
import type { ModuleRegistry } from './module-registry.js';

export function platformOverview(paths: AppPaths, registry: ModuleRegistry, assets: AssetResolver, storage: { root: string; scenario: string } = { root: paths.piAgentDir, scenario: paths.scenarioDir }) {
  const modules = [...registry.modules.values()].map((module) => {
    const moduleAssets = (module.manifest.contributes?.assets || []).map((asset) => {
      try { return { id: asset.id, kind: asset.kind, configured: !!assets.resolve(asset.id) }; }
      catch (error) { return { id: asset.id, kind: asset.kind, configured: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    return {
      id: module.manifest.id,
      name: module.manifest.name,
      version: module.manifest.version,
      type: module.manifest.type,
      origin: module.origin,
      removable: module.origin === 'installed',
      enabled: module.enabled,
      extensions: module.manifest.entrypoints?.piExtensions?.length || 0,
      skills: module.manifest.entrypoints?.skills?.length || 0,
      assets: moduleAssets,
    };
  });
  return {
    storage: {
      root: storage.root,
      scenario: storage.scenario,
      models: path.join(storage.root, 'models.json'),
      settings: path.join(storage.root, 'settings.json'),
      modules: paths.modulesDir,
    },
    modules,
    errors: registry.errors.map((error) => ({ moduleId: error.moduleId, message: error.message })),
  };
}
