const fs = require('node:fs');
const path = require('node:path');

import type { AppPaths } from './app-paths.js';
import type { AssetResolver } from './asset-resolver.js';
import type { ModuleRegistry } from './module-registry.js';

const SKILL_PREVIEW_BYTES = 48 * 1024;

function skillFiles(packageRoot: string, entries: string[]) {
  let root: string;
  try { root = fs.realpathSync(packageRoot); }
  catch { return entries.map((entryPath) => ({ entryPath, name: path.basename(entryPath), error: '技能包目录无法读取' })); }
  return entries.map((entryPath) => {
    const candidate = path.resolve(root, entryPath);
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return { entryPath, name: path.basename(entryPath), error: '技能文件路径无效' };
    try {
      const resolved = fs.realpathSync(candidate);
      const resolvedRelative = path.relative(root, resolved);
      if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) throw new Error('Skill file escapes package root');
      const size = fs.statSync(resolved).size;
      const descriptor = fs.openSync(resolved, 'r');
      try {
        const buffer = Buffer.alloc(Math.min(size, SKILL_PREVIEW_BYTES));
        const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
        return { entryPath, name: path.basename(entryPath), content: buffer.subarray(0, bytes).toString('utf8'), truncated: size > SKILL_PREVIEW_BYTES };
      } finally { fs.closeSync(descriptor); }
    } catch {
      return { entryPath, name: path.basename(entryPath), error: '技能文件无法读取' };
    }
  });
}

export function platformOverview(
  paths: AppPaths,
  registry: ModuleRegistry,
  assets: AssetResolver,
  storage: { root: string; scenario: string } = { root: paths.piAgentDir, scenario: paths.scenarioDir },
  activeAssetIds: ReadonlySet<string> = new Set(),
  selectionError?: string,
) {
  const modules = [...registry.modules.values()].map((module) => {
    const moduleAssets = (module.manifest.contributes?.assets || []).map((asset) => {
      try { return { id: asset.id, kind: asset.kind, configured: !!assets.resolve(asset.id), active: activeAssetIds.has(asset.id) }; }
      catch (error) { return { id: asset.id, kind: asset.kind, configured: false, active: false, error: error instanceof Error ? error.message : String(error) }; }
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
      skillFiles: skillFiles(module.packageRoot, module.manifest.entrypoints?.skills || []),
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
    errors: [
      ...registry.errors.map((error) => ({ moduleId: error.moduleId, message: error.message })),
      ...(selectionError ? [{ message: selectionError }] : []),
    ],
  };
}
