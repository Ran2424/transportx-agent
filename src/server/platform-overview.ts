const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

import type { AppPaths } from './app-paths.js';
import type { AssetResolver } from './asset-resolver.js';
import type { ModuleRegistry } from './module-registry.js';

const SKILL_PREVIEW_BYTES = 48 * 1024;

/** Native file managers need the physical directory, outside Electron's archive. */
export function resolveModuleDirectory(packageRoot: string) {
  let current = path.resolve(packageRoot);
  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'app.asar') {
      const unpacked = path.join(path.dirname(current), 'app.asar.unpacked', path.relative(current, packageRoot));
      if (!fs.statSync(unpacked).isDirectory()) throw new Error('Module directory is unavailable');
      return fs.realpathSync(unpacked);
    }
    current = path.dirname(current);
  }
  if (!fs.statSync(packageRoot).isDirectory()) throw new Error('Module directory is unavailable');
  return fs.realpathSync(packageRoot);
}

function skillDescription(content: string) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return undefined;
  try {
    const metadata = yaml.load(frontmatter[1], { schema: yaml.JSON_SCHEMA });
    return typeof metadata?.description === 'string' ? metadata.description.trim() : undefined;
  } catch { return undefined; }
}

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
        const content = buffer.subarray(0, bytes).toString('utf8');
        const heading = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').match(/^#\s+(.+)$/m)?.[1]?.trim();
        return { entryPath, name: heading || path.basename(entryPath), description: skillDescription(content), content, truncated: size > SKILL_PREVIEW_BYTES };
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
      ...(module.manifest.presentation ? { presentation: module.manifest.presentation } : {}),
      version: module.manifest.version,
      type: module.manifest.type,
      origin: module.origin,
      removable: module.origin === 'installed',
      enabled: module.enabled,
      dependencies: module.manifest.dependencies,
      extensions: module.manifest.entrypoints?.piExtensions?.length || 0,
      skills: module.manifest.entrypoints?.skills?.length || 0,
      nativeRuntimes: module.manifest.contributes?.nativeRuntimes?.length || 0,
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
      logs: paths.logsDir,
    },
    modules,
    errors: [
      ...registry.errors.map((error) => ({ moduleId: error.moduleId, message: error.message })),
      ...(selectionError ? [{ message: selectionError }] : []),
    ],
  };
}
