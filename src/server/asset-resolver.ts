const fs = require('node:fs');
const path = require('node:path');

import type { ModuleAsset } from '../contracts/index.js';
import type { ModuleRegistry, RegisteredModule } from './module-registry.js';

export type ResolvedAsset = ModuleAsset & { moduleId: string; moduleVersion: string; resolvedPath: string };

function within(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export class AssetResolver {
  private assets = new Map<string, { asset: ModuleAsset; module: RegisteredModule }>();
  private overrides: Record<string, string>;

  constructor(registry: ModuleRegistry, overrides: Record<string, string> = {}) {
    this.overrides = overrides;
    this.reload(registry, overrides);
  }

  reload(registry: ModuleRegistry, overrides: Record<string, string> = this.overrides) {
    this.assets.clear();
    this.overrides = overrides;
    for (const module of registry.enabled()) {
      for (const asset of module.manifest.contributes?.assets || []) {
        if (this.assets.has(asset.id)) throw new Error(`Duplicate asset id: ${asset.id}`);
        this.assets.set(asset.id, { asset, module });
      }
    }
    return this;
  }

  resolve(id: string): ResolvedAsset | null {
    const record = this.assets.get(id);
    if (!record) return null;
    const override = this.overrides[id];
    const resolvedPath = override ? path.resolve(override) : path.resolve(record.module.packageRoot, record.asset.path);
    if (!override && !within(record.module.packageRoot, resolvedPath)) throw new Error(`Asset path escapes package root: ${id}`);
    if (!fs.existsSync(resolvedPath)) {
      if (record.asset.required !== false) throw new Error(`Required asset is missing: ${id}`);
      return null;
    }
    if (record.asset.integrityFile) {
      const integrityPath = override ? path.join(resolvedPath, path.basename(record.asset.integrityFile)) : path.resolve(record.module.packageRoot, record.asset.integrityFile);
      if ((!override && !within(record.module.packageRoot, integrityPath)) || !fs.existsSync(integrityPath)) throw new Error(`Asset integrity file is missing: ${id}`);
    }
    return { ...record.asset, moduleId: record.module.manifest.id, moduleVersion: record.module.manifest.version, resolvedPath };
  }
}
