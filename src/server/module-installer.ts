const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

import { diagnosticMessage, parseModuleManifestStructured, type ModuleManifest } from '../contracts/index.js';
import type { ModuleRegistry, ModuleSource } from './module-registry.js';
import { verifyChecksumFile } from './asset-integrity.js';

export type InstallKind = 'module';

function within(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
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
    const assetRoot = resolvePackageEntry(packageRoot, asset.path, `Asset ${asset.id}`, asset.required === false);
    if (asset.integrityFile) {
      const integrityFile = resolvePackageEntry(packageRoot, asset.integrityFile, `Integrity file for ${asset.id}`, asset.required === false);
      if (fs.existsSync(assetRoot) && fs.existsSync(integrityFile)) verifyChecksumFile(assetRoot, integrityFile);
    }
  }
}

function versionParts(version: string) {
  return version.split(/[.+-]/).map((part) => Number(part)).map((part) => Number.isFinite(part) ? part : 0);
}

function newestVersion(versions: string[]) {
  return [...versions].sort((left, right) => {
    const a = versionParts(left), b = versionParts(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const difference = (a[index] || 0) - (b[index] || 0);
      if (difference) return difference;
    }
    return left.localeCompare(right);
  }).at(-1)!;
}

function migrateManifestV1(manifestPath: string) {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  if (raw.manifestVersion !== 1) return;
  raw.manifestVersion = 2;
  raw.type = raw.type === 'capability' || raw.type === 'domain' ? raw.type : 'module';
  fs.writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
}

export class ModuleInstaller {
  constructor(readonly modulesDir: string) {
    fs.mkdirSync(modulesDir, { recursive: true });
  }

  migrateLegacyPackages() {
    const migrated: string[] = [];
    for (const entry of fs.readdirSync(this.modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const legacyRoot = path.join(this.modulesDir, entry.name);
      const manifestPath = path.join(legacyRoot, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      const staging = path.join(this.modulesDir, `.migrating-${crypto.randomUUID()}`);
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { id?: string; version?: string };
        const id = raw.id;
        const version = raw.version;
        if (!id || id !== entry.name || !version) throw new Error(`Legacy module directory is invalid: ${entry.name}`);
        fs.renameSync(legacyRoot, staging);
        migrateManifestV1(path.join(staging, 'manifest.json'));
        fs.mkdirSync(legacyRoot);
        fs.renameSync(staging, path.join(legacyRoot, version));
        migrated.push(id);
      } catch (error) {
        if (fs.existsSync(staging) && !fs.existsSync(legacyRoot)) fs.renameSync(staging, legacyRoot);
        throw error;
      }
    }
    return migrated;
  }

  sources(): ModuleSource[] {
    if (!fs.existsSync(this.modulesDir)) return [];
    const sources: ModuleSource[] = [];
    for (const entry of fs.readdirSync(this.modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const moduleRoot = path.join(this.modulesDir, entry.name);
      const versions = fs.readdirSync(moduleRoot, { withFileTypes: true })
        .filter((candidate: { isDirectory(): boolean; name: string }) => candidate.isDirectory() && fs.existsSync(path.join(moduleRoot, candidate.name, 'manifest.json')))
        .map((candidate: { name: string }) => candidate.name);
      if (!versions.length) continue;
      const version = newestVersion(versions);
      sources.push({ manifestPath: path.join(moduleRoot, version, 'manifest.json'), packageRoot: path.join(moduleRoot, version), origin: 'installed', moduleId: entry.name });
    }
    return sources;
  }

  install(source: string, kind: InstallKind = 'module') {
    if (kind !== 'module') throw new Error('Only self-contained Module packages can be installed.');
    const sourcePath = path.resolve(source);
    if (!fs.existsSync(sourcePath)) throw new Error(`Install source not found: ${source}`);
    const manifestPath = fs.statSync(sourcePath).isDirectory() ? path.join(sourcePath, 'manifest.json') : sourcePath;
    if (path.basename(manifestPath) !== 'manifest.json' || !fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) throw new Error('A module source must be a directory containing manifest.json');
    const packageRoot = path.dirname(manifestPath);
    const manifest = readManifest(manifestPath);
    validateModulePackage(packageRoot, manifest);
    const moduleRoot = path.join(this.modulesDir, manifest.id);
    const target = path.join(moduleRoot, manifest.version);
    if (!within(this.modulesDir, target)) throw new Error(`Invalid module id: ${manifest.id}`);
    if (fs.existsSync(target)) throw new Error(`Module version is already installed: ${manifest.id}@${manifest.version}`);
    const staging = path.join(this.modulesDir, `.install-${crypto.randomUUID()}`);
    try {
      fs.mkdirSync(staging, { recursive: true });
      copyInstallSource(packageRoot, staging);
      const installedManifest = readManifest(path.join(staging, 'manifest.json'));
      validateModulePackage(staging, installedManifest);
      fs.mkdirSync(moduleRoot, { recursive: true });
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
    const target = path.join(this.modulesDir, id);
    if (!fs.existsSync(target) || !within(this.modulesDir, target) || target === path.resolve(this.modulesDir)) throw new Error('Installed module not found');
    fs.rmSync(target, { recursive: true, force: true });
    return { id };
  }
}
