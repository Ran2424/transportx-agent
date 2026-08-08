const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

import { diagnosticMessage, parseModuleManifestStructured, type ModuleManifest, type ModuleType } from '../contracts/index.js';
import type { ModuleRegistry, ModuleSource } from './module-registry.js';

export type InstallKind = 'module' | 'skill' | 'extension' | 'data' | 'knowledge';
const INSTALL_KINDS = new Set<InstallKind>(['module', 'skill', 'extension', 'data', 'knowledge']);

function within(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function slug(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function sourceName(sourcePath: string) {
  let name = path.basename(sourcePath).replace(/\.[^.]+$/, '');
  if (['asset', 'assets', 'data', 'databases', 'knowledge'].includes(name.toLowerCase())) {
    name = path.basename(path.dirname(sourcePath));
    if (['asset', 'assets'].includes(name.toLowerCase())) name = path.basename(path.dirname(path.dirname(sourcePath)));
  }
  return name;
}

function readManifest(manifestPath: string) {
  const result = parseModuleManifestStructured(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  if (!result.ok) throw new Error(result.diagnostics.map(diagnosticMessage).join('; '));
  return result.value;
}

function assertSafeTree(root: string) {
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Module packages cannot contain symbolic links: ${path.relative(root, target)}`);
      if (entry.isDirectory()) visit(target);
    }
  };
  visit(root);
}

function copyInstallSource(source: string, destination: string) {
  fs.cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (candidate: string) => {
      const name = path.basename(candidate);
      return name !== '.DS_Store' && name !== '__MACOSX' && name !== '.git' && name !== '__pycache__' && !name.endsWith('.pyc');
    },
  });
}

function resolvePackageEntry(root: string, relativePath: string, label: string, optional = false) {
  if (path.isAbsolute(relativePath)) throw new Error(`${label} must use a relative path`);
  const resolved = path.resolve(root, relativePath);
  if (!within(root, resolved)) throw new Error(`${label} escapes the module package`);
  if (!fs.existsSync(resolved) && !optional) throw new Error(`${label} is missing: ${relativePath}`);
  return resolved;
}

export function validateModulePackage(packageRoot: string, manifest: ModuleManifest) {
  assertSafeTree(packageRoot);
  for (const entry of manifest.entrypoints?.piExtensions || []) resolvePackageEntry(packageRoot, entry, 'Extension');
  for (const entry of manifest.entrypoints?.skills || []) resolvePackageEntry(packageRoot, entry, 'Skill');
  for (const entry of manifest.entrypoints?.prompts || []) resolvePackageEntry(packageRoot, entry, 'Prompt');
  for (const asset of manifest.contributes?.assets || []) {
    resolvePackageEntry(packageRoot, asset.path, `Asset ${asset.id}`, asset.required === false);
    if (asset.integrityFile) resolvePackageEntry(packageRoot, asset.integrityFile, `Integrity file for ${asset.id}`, asset.required === false);
  }
}

function standaloneManifest(kind: Exclude<InstallKind, 'module'>, sourcePath: string): ModuleManifest {
  const name = sourceName(sourcePath);
  const localName = slug(name);
  const type: ModuleType = kind === 'extension' ? 'capability' : kind;
  const base: ModuleManifest = {
    manifestVersion: 1,
    id: `local.${kind}.${localName}`,
    name,
    version: '1.0.0',
    type,
    platformVersion: '>=3.0.0 <4.0.0',
    dependencies: [],
  };
  if (kind === 'skill') return { ...base, entrypoints: { skills: ['skill/SKILL.md'] } };
  if (kind === 'extension') return { ...base, entrypoints: { piExtensions: [`extension/${fs.statSync(sourcePath).isDirectory() ? ['index.ts', 'index.js', 'index.mjs'].find((file) => fs.existsSync(path.join(sourcePath, file))) : path.basename(sourcePath)}`] } };
  const integrityFile = kind === 'knowledge' && fs.statSync(sourcePath).isDirectory() && fs.existsSync(path.join(sourcePath, 'SHA256SUMS.txt')) ? 'asset/SHA256SUMS.txt' : undefined;
  return { ...base, contributes: { assets: [{ id: `${kind}:local.${localName}`, kind, path: 'asset', ...(integrityFile ? { integrityFile } : {}) }] } };
}

export class ModuleInstaller {
  constructor(readonly modulesDir: string) {
    fs.mkdirSync(modulesDir, { recursive: true });
  }

  sources(): ModuleSource[] {
    if (!fs.existsSync(this.modulesDir)) return [];
    return fs.readdirSync(this.modulesDir, { withFileTypes: true })
      .filter((entry: { isDirectory(): boolean }) => entry.isDirectory())
      .map((entry: { name: string }) => path.join(this.modulesDir, entry.name, 'manifest.json'))
      .filter((manifestPath: string) => fs.existsSync(manifestPath))
      .map((manifestPath: string) => ({ manifestPath, packageRoot: path.dirname(manifestPath), origin: 'installed' as const }));
  }

  install(source: string, kind: InstallKind = 'module') {
    if (!INSTALL_KINDS.has(kind)) throw new Error(`Unsupported install kind: ${kind}`);
    const sourcePath = path.resolve(source);
    if (!fs.existsSync(sourcePath)) throw new Error(`Install source not found: ${source}`);
    let packageRoot = sourcePath;
    let manifest: ModuleManifest;
    if (kind === 'module') {
      const manifestPath = fs.statSync(sourcePath).isDirectory() ? path.join(sourcePath, 'manifest.json') : sourcePath;
      if (path.basename(manifestPath) !== 'manifest.json' || !fs.statSync(manifestPath).isFile()) throw new Error('A module source must be a directory containing manifest.json');
      packageRoot = path.dirname(manifestPath);
      manifest = readManifest(manifestPath);
      validateModulePackage(packageRoot, manifest);
    } else {
      if (kind === 'skill') {
        packageRoot = fs.statSync(sourcePath).isDirectory() ? sourcePath : path.dirname(sourcePath);
        if (!fs.existsSync(path.join(packageRoot, 'SKILL.md'))) throw new Error('A standalone Skill must contain SKILL.md');
      }
      if (kind === 'extension' && fs.statSync(sourcePath).isDirectory() && !['index.ts', 'index.js', 'index.mjs'].some((file) => fs.existsSync(path.join(sourcePath, file)))) throw new Error('A standalone extension directory must contain index.ts, index.js or index.mjs');
      manifest = standaloneManifest(kind, sourcePath);
    }
    const target = path.join(this.modulesDir, manifest.id);
    if (!within(this.modulesDir, target)) throw new Error(`Invalid module id: ${manifest.id}`);
    if (fs.existsSync(target)) throw new Error(`Module is already installed: ${manifest.id}`);
    const staging = path.join(this.modulesDir, `.install-${crypto.randomUUID()}`);
    try {
      fs.mkdirSync(staging, { recursive: true });
      if (kind === 'module') copyInstallSource(packageRoot, staging);
      else {
        const destination = path.join(staging, kind === 'skill' ? 'skill' : kind === 'extension' ? 'extension' : 'asset');
        if (fs.statSync(sourcePath).isDirectory()) copyInstallSource(sourcePath, destination);
        else { fs.mkdirSync(destination, { recursive: true }); fs.copyFileSync(sourcePath, path.join(destination, path.basename(sourcePath))); }
        fs.writeFileSync(path.join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      }
      const installedManifest = readManifest(path.join(staging, 'manifest.json'));
      validateModulePackage(staging, installedManifest);
      fs.renameSync(staging, target);
      return { id: installedManifest.id, name: installedManifest.name, version: installedManifest.version, path: target };
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  uninstall(id: string, registry?: ModuleRegistry) {
    const module = registry?.get(id);
    if (module && module.origin !== 'installed') throw new Error(`Built-in or external modules cannot be uninstalled: ${id}`);
    const dependent = registry?.enabled().find((candidate) => candidate.manifest.id !== id && candidate.manifest.dependencies.includes(id));
    if (dependent) throw new Error(`Module ${id} is required by ${dependent.manifest.id}`);
    const installed = this.sources().map((source) => ({ source, manifest: readManifest(source.manifestPath) })).find((item) => item.manifest.id === id);
    if (!installed) throw new Error(`Installed module not found: ${id}`);
    const target = path.dirname(installed.source.manifestPath);
    if (!within(this.modulesDir, target) || target === path.resolve(this.modulesDir)) throw new Error('Refusing to remove a path outside the managed module directory');
    fs.rmSync(target, { recursive: true, force: true });
    return { id };
  }
}
