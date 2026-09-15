const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yauzl = require('yauzl') as typeof import('yauzl');
const { pipeline } = require('node:stream/promises') as typeof import('node:stream/promises');

import { diagnosticMessage, parseModuleManifestStructured, type ModuleArchiveCandidate, type ModuleArchiveInspection, type ModuleManifest } from '../contracts/index.js';
import { moduleRuntimeCompatible, type ModuleRegistry, type ModuleSource } from './module-registry.js';
import { sha256File, verifyChecksumFile } from './asset-integrity.js';
import { isWithin } from './util/path.js';

export type InstallKind = 'module';

const MAX_ARCHIVE_ENTRIES = 20_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_COMPRESSION_RATIO = 200;
const MAX_MANIFEST_BYTES = 256 * 1024;
const ARCHIVE_IMPORT_TTL_MS = 60 * 60 * 1000;

type ArchiveEntry = import('yauzl').Entry;
type PendingArchive = {
  archivePath: string;
  expiresAt: number;
  inspection: ModuleArchiveInspection;
  candidates: Map<string, ModuleArchiveCandidate>;
};

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

function archiveEntryIgnored(fileName: string) {
  const parts = fileName.replace(/\/$/, '').split('/');
  return parts.some((part) => part === '__MACOSX' || part === '.DS_Store' || part === '.git' || part === '__pycache__' || part.endsWith('.pyc') || part.startsWith('._'));
}

function archiveEntryUnsafe(entry: ArchiveEntry) {
  if (entry.isEncrypted()) return 'Encrypted ZIP entries are not supported';
  if (yauzl.validateFileName(entry.fileName)) return `Unsafe ZIP entry: ${entry.fileName}`;
  const unixMode = entry.externalFileAttributes >>> 16;
  if ((unixMode & 0o170000) === 0o120000) return `ZIP entries cannot be symbolic links: ${entry.fileName}`;
  if (entry.uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES) return `ZIP entry is too large: ${entry.fileName}`;
  if (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > MAX_ARCHIVE_COMPRESSION_RATIO) return `ZIP entry compression ratio is too high: ${entry.fileName}`;
  return null;
}

function archiveModuleKey(id: string, version: string) {
  return `${id}@${version}`;
}

async function readArchiveEntry(zip: import('yauzl').ZipFile, entry: ArchiveEntry, maxBytes: number) {
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maxBytes) {
      stream.destroy();
      throw new Error(`Archive entry is too large to inspect: ${entry.fileName}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function resolvePackageEntry(root: string, relativePath: string, label: string, optional = false) {
  if (path.isAbsolute(relativePath)) throw new Error(`${label} must use a relative path`);
  const resolved = path.resolve(root, relativePath);
  if (!isWithin(root, resolved)) throw new Error(`${label} escapes the module package`);
  if (!fs.existsSync(resolved) && !optional) throw new Error(`${label} is missing: ${relativePath}`);
  return resolved;
}

export function validateModulePackage(packageRoot: string, manifest: ModuleManifest) {
  assertSafeTree(packageRoot);
  const runtimeCompatibility = moduleRuntimeCompatible(manifest);
  if (!runtimeCompatibility.compatible) throw new Error(`Module ${manifest.id} has no ${runtimeCompatibility.missingRuntime} runtime for ${process.platform}/${process.arch}`);
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
  for (const runtime of manifest.contributes?.nativeRuntimes || []) {
    for (const [name, executable] of Object.entries(runtime.executables)) {
      const executablePath = resolvePackageEntry(packageRoot, executable.path, `Native runtime executable ${runtime.id}/${name}`);
      if (!fs.statSync(executablePath).isFile()) throw new Error(`Native runtime executable must be a file: ${runtime.id}/${name}`);
      if (sha256File(executablePath) !== executable.sha256) throw new Error(`Native runtime executable checksum mismatch: ${runtime.id}/${name}`);
    }
    if (runtime.notices) resolvePackageEntry(packageRoot, runtime.notices, `Native runtime notices ${runtime.id}`);
  }
}

function ensureNativeRuntimePermissions(packageRoot: string, manifest: ModuleManifest) {
  for (const runtime of manifest.contributes?.nativeRuntimes || []) {
    for (const executable of Object.values(runtime.executables)) fs.chmodSync(resolvePackageEntry(packageRoot, executable.path, `Native runtime executable ${runtime.id}`), 0o755);
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
  private readonly pendingArchives = new Map<string, PendingArchive>();

  constructor(readonly modulesDir: string) {
    fs.mkdirSync(modulesDir, { recursive: true });
    fs.rmSync(path.join(modulesDir, '.imports'), { recursive: true, force: true });
  }

  private archiveImportsDir() {
    return path.join(this.modulesDir, '.imports');
  }

  private removePendingArchive(importId: string) {
    const pending = this.pendingArchives.get(importId);
    this.pendingArchives.delete(importId);
    if (pending) fs.rmSync(pending.archivePath, { force: true });
  }

  private cleanupExpiredArchives() {
    const now = Date.now();
    for (const [importId, pending] of this.pendingArchives) if (pending.expiresAt <= now) this.removePendingArchive(importId);
  }

  discardArchive(importId: string) {
    this.removePendingArchive(importId);
  }

  async inspectArchive(source: string, reservedModuleIds = new Set<string>()): Promise<ModuleArchiveInspection> {
    this.cleanupExpiredArchives();
    const sourcePath = path.resolve(source);
    if (path.extname(sourcePath).toLowerCase() !== '.zip') throw new Error('Only .zip Module archives are supported');
    if (!fs.existsSync(sourcePath) || !fs.lstatSync(sourcePath).isFile()) throw new Error(`Module archive not found: ${source}`);
    const importId = crypto.randomUUID();
    const importsDir = this.archiveImportsDir();
    const archivePath = path.join(importsDir, `${importId}.zip`);
    fs.mkdirSync(importsDir, { recursive: true });
    fs.copyFileSync(sourcePath, archivePath);
    try {
      const zip = await yauzl.openPromise(archivePath, { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
      const manifestEntries: Array<{ entry: ArchiveEntry; id: string; version: string }> = [];
      const packageBytes = new Map<string, number>();
      const paths = new Set<string>();
      let uncompressedBytes = 0;
      try {
        if (zip.entryCount > MAX_ARCHIVE_ENTRIES) throw new Error(`Module archive contains too many entries (maximum ${MAX_ARCHIVE_ENTRIES})`);
        for await (const entry of zip.eachEntry()) {
          const unsafe = archiveEntryUnsafe(entry);
          if (unsafe) throw new Error(unsafe);
          if (paths.has(entry.fileName)) throw new Error(`Duplicate ZIP entry: ${entry.fileName}`);
          paths.add(entry.fileName);
          if (archiveEntryIgnored(entry.fileName)) continue;
          uncompressedBytes += entry.uncompressedSize;
          if (uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) throw new Error(`Module archive expands beyond ${Math.floor(MAX_ARCHIVE_UNCOMPRESSED_BYTES / 1024 / 1024)} MB`);
          const packageMatch = entry.fileName.match(/^([^/]+)\/([^/]+)\//);
          if (packageMatch) {
            const key = archiveModuleKey(packageMatch[1], packageMatch[2]);
            packageBytes.set(key, (packageBytes.get(key) || 0) + entry.uncompressedSize);
          }
          const manifestMatch = entry.fileName.match(/^([^/]+)\/([^/]+)\/manifest\.json$/);
          if (manifestMatch) manifestEntries.push({ entry, id: manifestMatch[1], version: manifestMatch[2] });
        }

        const modules: ModuleArchiveCandidate[] = [];
        const candidates = new Map<string, ModuleArchiveCandidate>();
        for (const item of manifestEntries) {
          const key = archiveModuleKey(item.id, item.version);
          let candidate: ModuleArchiveCandidate;
          try {
            const parsed = parseModuleManifestStructured(JSON.parse((await readArchiveEntry(zip, item.entry, MAX_MANIFEST_BYTES)).toString('utf8')));
            if (!parsed.ok) throw new Error(parsed.diagnostics.map(diagnosticMessage).join('; '));
            const manifest = parsed.value;
            if (manifest.id !== item.id || manifest.version !== item.version) throw new Error(`Archive path must match manifest: ${item.id}/${item.version}`);
            const target = path.join(this.modulesDir, manifest.id, manifest.version);
            const runtimeCompatibility = moduleRuntimeCompatible(manifest);
            const status = !runtimeCompatibility.compatible ? 'invalid' : reservedModuleIds.has(manifest.id) ? 'conflict' : fs.existsSync(target) ? 'installed' : 'ready';
            candidate = {
              id: manifest.id,
              name: manifest.name,
              version: manifest.version,
              type: manifest.type,
              dependencies: manifest.dependencies,
              skills: manifest.entrypoints?.skills?.length || 0,
              extensions: manifest.entrypoints?.piExtensions?.length || 0,
              assets: manifest.contributes?.assets?.length || 0,
              nativeRuntimes: manifest.contributes?.nativeRuntimes?.length || 0,
              uncompressedBytes: packageBytes.get(key) || 0,
              status,
              ...(!runtimeCompatibility.compatible ? { message: `No ${runtimeCompatibility.missingRuntime} runtime for ${process.platform}/${process.arch}` } : status === 'conflict' ? { message: `Module id conflicts with an existing built-in or external module: ${manifest.id}` } : status === 'installed' ? { message: 'This module version is already installed' } : {}),
            };
          } catch (error) {
            candidate = {
              id: item.id,
              name: item.id,
              version: item.version,
              type: 'module',
              dependencies: [],
              skills: 0,
              extensions: 0,
              assets: 0,
              nativeRuntimes: 0,
              uncompressedBytes: packageBytes.get(key) || 0,
              status: 'invalid',
              message: error instanceof Error ? error.message : String(error),
            };
          }
          if (candidates.has(key)) throw new Error(`Duplicate Module package in archive: ${key}`);
          candidates.set(key, candidate);
          modules.push(candidate);
        }
        if (!modules.length) throw new Error('No Module packages found. Expected <module-id>/<version>/manifest.json');
        const inspection: ModuleArchiveInspection = {
          importId,
          sourceName: path.basename(sourcePath),
          compressedBytes: fs.statSync(archivePath).size,
          uncompressedBytes,
          modules,
        };
        this.pendingArchives.set(importId, { archivePath, expiresAt: Date.now() + ARCHIVE_IMPORT_TTL_MS, inspection, candidates });
        return inspection;
      } finally {
        if (zip.isOpen) zip.close();
      }
    } catch (error) {
      fs.rmSync(archivePath, { force: true });
      throw error;
    }
  }

  async installArchive(importId: string, selections: Array<{ id: string; version: string }>) {
    this.cleanupExpiredArchives();
    const pending = this.pendingArchives.get(importId);
    if (!pending) throw new Error('Module archive preview has expired. Drop the archive again.');
    const keys = selections.map((selection) => archiveModuleKey(selection.id, selection.version));
    if (!keys.length || new Set(keys).size !== keys.length) throw new Error('Select one or more distinct Modules to install');
    const candidates = keys.map((key) => {
      const candidate = pending.candidates.get(key);
      if (!candidate || candidate.status !== 'ready') throw new Error(`Module is not available for installation: ${key}`);
      return candidate;
    });
    const staging = path.join(this.modulesDir, `.archive-install-${crypto.randomUUID()}`);
    const installed: Array<{ id: string; name: string; version: string; path: string }> = [];
    try {
      fs.mkdirSync(staging, { recursive: true });
      const zip = await yauzl.openPromise(pending.archivePath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
      try {
        for await (const entry of zip.eachEntry()) {
          if (archiveEntryIgnored(entry.fileName)) continue;
          const candidate = candidates.find((item) => entry.fileName.startsWith(`${item.id}/${item.version}/`));
          if (!candidate || entry.fileName.endsWith('/')) continue;
          const destination = path.resolve(staging, entry.fileName);
          if (!isWithin(staging, destination)) throw new Error(`Unsafe ZIP entry: ${entry.fileName}`);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          await pipeline(await zip.openReadStreamPromise(entry), fs.createWriteStream(destination, { flags: 'wx' }));
        }
      } finally {
        if (zip.isOpen) zip.close();
      }

      for (const candidate of candidates) {
        const packageRoot = path.join(staging, candidate.id, candidate.version);
        const manifest = readManifest(path.join(packageRoot, 'manifest.json'));
        if (manifest.id !== candidate.id || manifest.version !== candidate.version) throw new Error(`Archive contents changed for ${candidate.id}@${candidate.version}`);
        ensureNativeRuntimePermissions(packageRoot, manifest);
        validateModulePackage(packageRoot, manifest);
        const target = path.join(this.modulesDir, candidate.id, candidate.version);
        if (!isWithin(this.modulesDir, target) || fs.existsSync(target)) throw new Error(`Module version is already installed: ${candidate.id}@${candidate.version}`);
      }

      for (const candidate of candidates) {
        const packageRoot = path.join(staging, candidate.id, candidate.version);
        const target = path.join(this.modulesDir, candidate.id, candidate.version);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(packageRoot, target);
        installed.push({ id: candidate.id, name: candidate.name, version: candidate.version, path: target });
      }
      return installed;
    } catch (error) {
      for (const item of installed.reverse()) fs.rmSync(item.path, { recursive: true, force: true });
      throw error;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      this.removePendingArchive(importId);
    }
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

  catalog() {
    if (!fs.existsSync(this.modulesDir)) return [];
    const versions: Array<{ id: string; version: string; manifest: ModuleManifest; source: ModuleSource }> = [];
    for (const entry of fs.readdirSync(this.modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const moduleRoot = path.join(this.modulesDir, entry.name);
      for (const candidate of fs.readdirSync(moduleRoot, { withFileTypes: true })) {
        const manifestPath = path.join(moduleRoot, candidate.name, 'manifest.json');
        if (!candidate.isDirectory() || !fs.existsSync(manifestPath)) continue;
        const manifest = readManifest(manifestPath);
        if (manifest.id !== entry.name || manifest.version !== candidate.name) throw new Error(`Installed Module path does not match manifest: ${entry.name}/${candidate.name}`);
        versions.push({ id: manifest.id, version: manifest.version, manifest, source: { manifestPath, packageRoot: path.dirname(manifestPath), origin: 'installed', moduleId: manifest.id } });
      }
    }
    return versions.sort((left, right) => left.id.localeCompare(right.id) || versionParts(left.version).join('.').localeCompare(versionParts(right.version).join('.')));
  }

  sources(): ModuleSource[] {
    const byId = new Map<string, ReturnType<ModuleInstaller['catalog']>>();
    for (const entry of this.catalog()) byId.set(entry.id, [...(byId.get(entry.id) || []), entry]);
    return [...byId.values()].map((entries) => entries.find((entry) => entry.version === newestVersion(entries.map((entry) => entry.version)))!.source);
  }

  sourcesForEnabledModules(moduleIds: string[]): ModuleSource[] {
    const catalog = this.catalog();
    const sources = this.sources();
    const latest = new Map(sources.map((source) => [source.moduleId!, catalog.find((entry) => entry.source.manifestPath === source.manifestPath)!]));
    const enabled = new Set<string>();
    const visit = (id: string) => {
      if (enabled.has(id)) return;
      const entry = latest.get(id);
      if (!entry) return;
      enabled.add(id);
      entry.manifest.dependencies.forEach(visit);
    };
    moduleIds.forEach(visit);
    return sources.map((source) => ({ ...source, enabled: enabled.has(source.moduleId!) }));
  }

  sourcesForSelections(selections: Array<{ id: string; version: string }>): ModuleSource[] {
    const catalog = this.catalog();
    return selections.map((selection) => {
      const entry = catalog.find((candidate) => candidate.id === selection.id && candidate.version === selection.version);
      if (!entry) throw new Error(`Selected Module version is not installed: ${selection.id}@${selection.version}`);
      return entry.source;
    });
  }

  sourcesForSelectionsWithDependencies(selections: Array<{ id: string; version: string }>, providedModuleIds: Set<string> = new Set()): ModuleSource[] {
    const catalog = this.catalog();
    const newest = new Map(this.sources().map((source) => [source.moduleId!, source.manifestPath]));
    const selected = new Map<string, ModuleSource>();
    const visit = (id: string, version?: string) => {
      if (providedModuleIds.has(id) || selected.has(id)) return;
      const entry = version
        ? catalog.find((candidate) => candidate.id === id && candidate.version === version)
        : catalog.find((candidate) => candidate.id === id && candidate.source.manifestPath === newest.get(id));
      if (!entry) throw new Error(version ? `Selected Module version is not installed: ${id}@${version}` : `Module dependency is not installed: ${id}`);
      selected.set(id, entry.source);
      entry.manifest.dependencies.forEach((dependency) => visit(dependency));
    };
    selections.forEach((selection) => visit(selection.id, selection.version));
    return [...selected.values()];
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
    if (!isWithin(this.modulesDir, target)) throw new Error(`Invalid module id: ${manifest.id}`);
    if (fs.existsSync(target)) throw new Error(`Module version is already installed: ${manifest.id}@${manifest.version}`);
    const staging = path.join(this.modulesDir, `.install-${crypto.randomUUID()}`);
    try {
      fs.mkdirSync(staging, { recursive: true });
      copyInstallSource(packageRoot, staging);
      const installedManifest = readManifest(path.join(staging, 'manifest.json'));
      ensureNativeRuntimePermissions(staging, installedManifest);
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
    if (!fs.existsSync(target) || !isWithin(this.modulesDir, target) || target === path.resolve(this.modulesDir)) throw new Error('Installed module not found');
    fs.rmSync(target, { recursive: true, force: true });
    return { id };
  }
}
