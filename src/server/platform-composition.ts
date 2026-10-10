const fs = require('node:fs');

import { ModuleRegistry, moduleRuntimeCompatible } from './module-registry.js';
import { AssetResolver } from './asset-resolver.js';
import { SessionAssembler } from './session-assembly.js';
import { ModuleInstaller } from './module-installer.js';
import { parseSessionProfileStructured, type SessionProfileV1 } from '../contracts/index.js';
import { APP_PATHS, BUILTIN_MODULE_MANIFESTS, LOCAL_MODULE_MANIFESTS, TAU_SETTINGS, PLATFORM_VERSION, PI_EXECUTABLE, PYTHON_EXECUTABLE, saveTauSetting } from './config.js';

export const MODULE_INSTALLER = new ModuleInstaller(APP_PATHS.modulesDir);
export function moduleSources() {
  return [
    ...BUILTIN_MODULE_MANIFESTS,
    ...MODULE_INSTALLER.sourcesForEnabledModules(TAU_SETTINGS.enabledModuleIds),
    ...LOCAL_MODULE_MANIFESTS,
  ];
}
export const MODULE_REGISTRY = new ModuleRegistry(PLATFORM_VERSION).load(moduleSources());
export const ASSET_OVERRIDES = {
  ...(process.env.TAU_KNOWLEDGE_ROOT && process.env.TAU_KNOWLEDGE_ASSET_ID ? { [process.env.TAU_KNOWLEDGE_ASSET_ID]: process.env.TAU_KNOWLEDGE_ROOT } : {}),
  ...(process.env.TAU_DATA_ROOT && process.env.TAU_DATA_ASSET_ID ? { [process.env.TAU_DATA_ASSET_ID]: process.env.TAU_DATA_ROOT } : {}),
};
export const ASSET_RESOLVER = new AssetResolver(MODULE_REGISTRY, ASSET_OVERRIDES);
export const SESSION_ASSEMBLER = new SessionAssembler(MODULE_REGISTRY, ASSET_RESOLVER, PLATFORM_VERSION, PI_EXECUTABLE, PYTHON_EXECUTABLE);
export function sessionAssemblerForProfile(profile: SessionProfileV1) {
  const parsed = parseSessionProfileStructured(profile);
  if (!parsed.ok) throw new Error(parsed.diagnostics.map((item) => item.message).join('; '));
  const builtinIds = new Set(BUILTIN_MODULE_MANIFESTS.map(({ manifestPath }) => JSON.parse(fs.readFileSync(manifestPath, 'utf8')).id as string));
  const externalIds = new Set(LOCAL_MODULE_MANIFESTS.map(({ manifestPath }) => JSON.parse(fs.readFileSync(manifestPath, 'utf8')).id as string));
  const allowed = new Set([...builtinIds, ...externalIds, ...TAU_SETTINGS.enabledModuleIds]);
  for (const selection of parsed.value.modules.selected) if (!allowed.has(selection.id)) throw new Error(`Selected Module is not enabled for new tasks: ${selection.id}`);
  const registry = new ModuleRegistry(PLATFORM_VERSION).load([
    ...BUILTIN_MODULE_MANIFESTS,
    ...MODULE_INSTALLER.sourcesForSelectionsWithDependencies(parsed.value.modules.selected, new Set([...builtinIds, ...externalIds])),
    ...LOCAL_MODULE_MANIFESTS,
  ]);
  if (registry.errors.length) throw new Error(registry.errors.map((item) => item.message).join('; '));
  for (const selection of parsed.value.modules.selected) {
    const module = registry.get(selection.id);
    if (!module?.enabled) throw new Error(`Selected Module is unavailable: ${selection.id}@${selection.version}`);
    if (module.manifest.version !== selection.version) throw new Error(`Selected Module version is unavailable: ${selection.id}@${selection.version}`);
  }
  const assets = new AssetResolver(registry, ASSET_OVERRIDES);
  for (const selection of parsed.value.modules.selected) {
    const module = registry.get(selection.id)!;
    for (const asset of module.manifest.contributes?.assets || []) if ((asset.kind === 'data' || asset.kind === 'knowledge') && !assets.resolve(asset.id)) throw new Error(`Selected Module asset is not configured: ${asset.id}`);
  }
  return new SessionAssembler(registry, assets, PLATFORM_VERSION, PI_EXECUTABLE, PYTHON_EXECUTABLE);
}
export function reloadModules() {
  MODULE_REGISTRY.reload(moduleSources());
  ASSET_RESOLVER.reload(MODULE_REGISTRY);
  return MODULE_REGISTRY;
}

export function setModuleEnabled(moduleId: string, enabled: boolean) {
  const module = MODULE_REGISTRY.get(moduleId);
  if (!module || module.origin !== 'installed') throw new Error(`Only installed modules can be enabled or disabled: ${moduleId}`);
  if (enabled) {
    const runtime = moduleRuntimeCompatible(module.manifest);
    if (!runtime.compatible) throw new Error(`Module ${moduleId} has no ${runtime.missingRuntime} runtime for ${process.platform}/${process.arch}`);
  } else {
    const dependent = TAU_SETTINGS.enabledModuleIds.find((id) => id !== moduleId && MODULE_INSTALLER.sourcesForEnabledModules([id]).some((source) => source.moduleId === moduleId && source.enabled));
    if (dependent) throw new Error(`Module ${moduleId} is required by enabled Module ${dependent}`);
  }
  const selected = new Set(TAU_SETTINGS.enabledModuleIds);
  if (enabled) selected.add(moduleId); else selected.delete(moduleId);
  const value = [...selected].sort();
  if (!saveTauSetting('enabledModuleIds', value)) throw new Error('Unable to save module selection');
  TAU_SETTINGS.enabledModuleIds = value;
  reloadModules();
  return MODULE_REGISTRY;
}
