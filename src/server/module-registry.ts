const fs = require('node:fs');
const path = require('node:path');

import { diagnosticMessage, parseModuleManifestStructured, type ContractDiagnostic, type ModuleManifest } from '../contracts/index.js';

export type ModuleOrigin = 'builtin' | 'installed' | 'external';
export type ModuleSource = { manifestPath: string; packageRoot?: string; enabled?: boolean; origin?: ModuleOrigin; moduleId?: string };
export type RegisteredModule = {
  manifest: ModuleManifest;
  manifestPath: string;
  packageRoot: string;
  enabled: boolean;
  origin: ModuleOrigin;
};
export type ModuleLoadError = { manifestPath: string; moduleId?: string; message: string; diagnostics?: ContractDiagnostic[] };

function compatible(range: string, platformVersion: string) {
  const platformMajor = Number(platformVersion.split('.')[0]);
  const minimum = range.match(/>=\s*(\d+)/);
  const maximum = range.match(/<\s*(\d+)/);
  return Number.isInteger(platformMajor) && (!minimum || platformMajor >= Number(minimum[1])) && (!maximum || platformMajor < Number(maximum[1]));
}

export class ModuleRegistry {
  readonly platformVersion: string;
  readonly modules = new Map<string, RegisteredModule>();
  readonly errors: ModuleLoadError[] = [];

  constructor(platformVersion: string) {
    this.platformVersion = platformVersion;
  }

  load(sources: ModuleSource[]) {
    for (const source of sources) this.loadOne(source);
    this.resolveDependencies();
    return this;
  }

  reload(sources: ModuleSource[]) {
    this.modules.clear();
    this.errors.length = 0;
    return this.load(sources);
  }

  private loadOne(source: ModuleSource) {
    const manifestPath = path.resolve(source.manifestPath);
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch (error) { this.errors.push({ manifestPath, message: error instanceof Error ? error.message : String(error) }); return; }
    const result = parseModuleManifestStructured(value);
    if (!result.ok) {
      this.errors.push({ manifestPath, message: result.diagnostics.map(diagnosticMessage).join('; '), diagnostics: result.diagnostics });
      return;
    }
    if (this.modules.has(result.value.id)) {
      this.errors.push({ manifestPath, moduleId: result.value.id, message: `Duplicate module id: ${result.value.id}` });
      return;
    }
    if (!compatible(result.value.platformVersion, this.platformVersion)) {
      this.errors.push({ manifestPath, moduleId: result.value.id, message: `Module ${result.value.id} ${result.value.version} is incompatible with platform ${this.platformVersion}` });
      return;
    }
    this.modules.set(result.value.id, { manifest: result.value, manifestPath, packageRoot: path.resolve(source.packageRoot || path.dirname(manifestPath)), enabled: source.enabled !== false, origin: source.origin || 'external' });
  }

  private resolveDependencies() {
    let changed = true;
    while (changed) {
      changed = false;
      for (const module of this.modules.values()) {
        if (!module.enabled) continue;
        const missing = module.manifest.dependencies.find((id) => !this.modules.get(id)?.enabled);
        if (!missing) continue;
        module.enabled = false;
        this.errors.push({ manifestPath: module.manifestPath, moduleId: module.manifest.id, message: `Missing or disabled dependency: ${missing}` });
        changed = true;
      }
    }
  }

  get(id: string) { return this.modules.get(id); }
  enabled() { return [...this.modules.values()].filter((module) => module.enabled); }

  dependencyOrder(rootId: string) {
    const ordered: RegisteredModule[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      if (visiting.has(id)) throw new Error(`Module dependency cycle at ${id}`);
      const module = this.modules.get(id);
      if (!module?.enabled) throw new Error(`Module is unavailable: ${id}`);
      visiting.add(id);
      module.manifest.dependencies.forEach(visit);
      visiting.delete(id);
      visited.add(id);
      ordered.push(module);
    };
    visit(rootId);
    return ordered;
  }
}
