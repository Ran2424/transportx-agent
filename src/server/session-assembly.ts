const fs = require('node:fs');
const path = require('node:path');

import type { Executable } from './runtime-resolver.js';
import type { ModuleRegistry } from './module-registry.js';
import type { AssetResolver, ResolvedAsset } from './asset-resolver.js';

export type ResolvedSessionPlan = {
  schemaVersion: 1;
  platform: { name: 'TransportX Traffic Agent'; version: string };
  domain: { id: string; version: string };
  modules: Array<{ id: string; version: string; type: string }>;
  assets: Array<{ id: string; kind: 'knowledge' | 'data' | 'template'; moduleId: string; moduleVersion: string; path: string }>;
  piExtensions: string[];
  skills: string[];
  promptPath: string;
  runtime: { piVersion?: string; pythonVersion?: string };
  workspace: string;
  createdAt: string;
};

function resolvePackagePath(packageRoot: string, relativePath: string, label: string) {
  const resolved = path.resolve(packageRoot, relativePath);
  const relative = path.relative(path.resolve(packageRoot), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} escapes package root: ${relativePath}`);
  if (!fs.existsSync(resolved)) throw new Error(`${label} is missing: ${resolved}`);
  return preferUnpackedPath(resolved);
}

export function preferUnpackedPath(filePath: string) {
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!filePath.includes(marker)) return filePath;
  const unpacked = filePath.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpacked) ? unpacked : filePath;
}

function selectAsset(candidates: ResolvedAsset[], kind: 'knowledge' | 'data', preferredId?: string) {
  if (!candidates.length) return null;
  if (preferredId) {
    const preferred = candidates.find((asset) => asset.id === preferredId);
    if (!preferred) throw new Error(`Configured ${kind} asset is unavailable: ${preferredId}`);
    return preferred;
  }
  const priority = { builtin: 0, external: 1, installed: 2 } as const;
  const highest = Math.max(...candidates.map((asset) => priority[asset.moduleOrigin]));
  const winners = candidates.filter((asset) => priority[asset.moduleOrigin] === highest);
  if (winners.length > 1) throw new Error(`Multiple ${kind} assets are active (${winners.map((asset) => asset.id).join(', ')}); configure TAU_${kind.toUpperCase()}_ASSET_ID`);
  return winners[0];
}

export class SessionAssembler {
  constructor(
    private registry: ModuleRegistry,
    private assets: AssetResolver,
    private platformVersion: string,
    private pi: Executable,
    private python: Executable,
    private preferredAssets: Partial<Record<'knowledge' | 'data', string>> = {},
  ) {}

  assemble(domainId: string, workspace: string): ResolvedSessionPlan {
    const modules = this.registry.dependencyOrder(domainId);
    const included = new Set(modules.map((module) => module.manifest.id));
    for (const installed of this.registry.enabled().filter((module) => module.origin !== 'builtin')) {
      for (const dependency of this.registry.dependencyOrder(installed.manifest.id)) {
        if (included.has(dependency.manifest.id)) continue;
        included.add(dependency.manifest.id);
        modules.push(dependency);
      }
    }
    const domain = modules.find((module) => module.manifest.id === domainId)!;
    const piExtensions: string[] = [];
    const skills: string[] = [];
    const prompts: string[] = [];
    const assets: ResolvedAsset[] = [];
    for (const module of modules) {
      for (const entry of module.manifest.entrypoints?.piExtensions || []) piExtensions.push(resolvePackagePath(module.packageRoot, entry, 'Pi extension'));
      for (const entry of module.manifest.entrypoints?.skills || []) skills.push(resolvePackagePath(module.packageRoot, entry, 'Skill'));
      if (module.manifest.id === domainId) for (const entry of module.manifest.entrypoints?.prompts || []) prompts.push(resolvePackagePath(module.packageRoot, entry, 'Prompt'));
      for (const entry of module.manifest.contributes?.assets || []) {
        const resolved = this.assets.resolve(entry.id);
        if (resolved) assets.push(resolved);
      }
    }
    if (prompts.length !== 1) throw new Error(`Domain ${domainId} must contribute exactly one prompt`);
    const selectedAssets = assets.filter((asset) => asset.kind === 'template');
    for (const kind of ['knowledge', 'data'] as const) {
      const selected = selectAsset(assets.filter((asset) => asset.kind === kind), kind, this.preferredAssets[kind]);
      if (selected) selectedAssets.push(selected);
    }
    return {
      schemaVersion: 1,
      platform: { name: 'TransportX Traffic Agent', version: this.platformVersion },
      domain: { id: domain.manifest.id, version: domain.manifest.version },
      modules: modules.map((module) => ({ id: module.manifest.id, version: module.manifest.version, type: module.manifest.type })),
      assets: selectedAssets.map((asset) => ({ id: asset.id, kind: asset.kind, moduleId: asset.moduleId, moduleVersion: asset.moduleVersion, path: asset.resolvedPath })),
      piExtensions: [...new Set(piExtensions)],
      skills: [...new Set(skills)],
      promptPath: prompts[0],
      runtime: { ...(this.pi.version ? { piVersion: this.pi.version } : {}), ...(this.python.version ? { pythonVersion: this.python.version } : {}) },
      workspace: path.resolve(workspace),
      createdAt: new Date().toISOString(),
    };
  }

  save(plan: ResolvedSessionPlan) {
    const target = path.join(plan.workspace, '.tau', 'resolved-session-plan.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(plan, null, 2)}\n`);
    return target;
  }
}
