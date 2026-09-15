const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

import {
  defaultSessionProfile,
  parseModuleManifestStructured,
  parseResolvedSessionPlanStructured,
  type ResolvedPlanEntrypoint,
  type ResolvedPlanModule,
  type ResolvedPlanNativeRuntime,
  type ResolvedSessionPlanV3,
  type SessionProfileV1,
} from '../contracts/index.js';
import type { Executable } from './runtime-resolver.js';
import type { ModuleRegistry, RegisteredModule } from './module-registry.js';
import type { AssetResolver, ResolvedAsset } from './asset-resolver.js';
import { verifyChecksumFile, sha256File } from './asset-integrity.js';
import { isWithin } from './util/path.js';

export type ResolvedSessionPlan = ResolvedSessionPlanV3;
const RETIRED_BUILTIN_MODULE_IDS = new Set(['com.transportx.timing']);
const INSTALLABLE_REPLACEMENTS_FOR_RETIRED_BUILTINS = new Set(['com.transportx.video']);

export class SessionPlanError extends Error {
  status = 409;
  constructor(readonly code: string, message: string, readonly details: Array<Record<string, string>> = []) { super(message); }
}

function resolvePackagePath(packageRoot: string, relativePath: string, label: string) {
  const resolved = path.resolve(packageRoot, relativePath);
  if (!isWithin(packageRoot, resolved)) throw new Error(`${label} escapes package root: ${relativePath}`);
  if (!fs.existsSync(resolved)) throw new Error(`${label} is missing: ${resolved}`);
  return preferUnpackedPath(resolved);
}

function resolvedEntrypoints(module: RegisteredModule, domainId: string): ResolvedPlanEntrypoint[] {
  const entries: ResolvedPlanEntrypoint[] = [];
  for (const entry of module.manifest.entrypoints?.piExtensions || []) {
    const entryPath = resolvePackagePath(module.packageRoot, entry, 'Pi extension');
    entries.push({ kind: 'extension', path: entryPath, sha256: sha256File(entryPath) });
  }
  for (const entry of module.manifest.entrypoints?.skills || []) {
    const entryPath = resolvePackagePath(module.packageRoot, entry, 'Skill');
    entries.push({ kind: 'skill', path: entryPath, sha256: sha256File(entryPath) });
  }
  if (module.manifest.id === domainId) for (const entry of module.manifest.entrypoints?.prompts || []) {
    const entryPath = resolvePackagePath(module.packageRoot, entry, 'Prompt');
    entries.push({ kind: 'prompt', path: entryPath, sha256: sha256File(entryPath) });
  }
  return entries;
}

function resolvedNativeRuntimes(module: RegisteredModule): ResolvedPlanNativeRuntime[] {
  const declared = module.manifest.contributes?.nativeRuntimes || [];
  const matching = declared.filter((runtime) => runtime.platform === process.platform && runtime.arch === process.arch);
  const matchingIds = new Set(matching.map((runtime) => runtime.id));
  const missingRuntime = (module.manifest.contributes?.requiredNativeRuntimes || []).find((id) => !matchingIds.has(id));
  if (missingRuntime) throw new Error(`Module ${module.manifest.id} has no ${missingRuntime} runtime for ${process.platform}/${process.arch}`);
  return matching.map((runtime) => {
    const ffmpegPath = resolvePackagePath(module.packageRoot, runtime.executables.ffmpeg.path, 'ffmpeg executable');
    const ffprobePath = resolvePackagePath(module.packageRoot, runtime.executables.ffprobe.path, 'ffprobe executable');
    if (sha256File(ffmpegPath) !== runtime.executables.ffmpeg.sha256) throw new Error(`ffmpeg checksum mismatch in Module ${module.manifest.id}`);
    if (sha256File(ffprobePath) !== runtime.executables.ffprobe.sha256) throw new Error(`ffprobe checksum mismatch in Module ${module.manifest.id}`);
    return {
      id: runtime.id,
      kind: runtime.kind,
      platform: runtime.platform,
      arch: runtime.arch,
      version: runtime.version,
      ffmpeg: { path: ffmpegPath, sha256: runtime.executables.ffmpeg.sha256 },
      ffprobe: { path: ffprobePath, sha256: runtime.executables.ffprobe.sha256 },
    };
  });
}

function resolvedPlanModule(module: RegisteredModule, domainId: string): ResolvedPlanModule {
  return {
    id: module.manifest.id,
    version: module.manifest.version,
    type: module.manifest.type,
    origin: module.origin,
    packageRoot: module.packageRoot,
    manifestSha256: sha256File(module.manifestPath),
    entrypoints: resolvedEntrypoints(module, domainId),
    nativeRuntimes: resolvedNativeRuntimes(module),
  };
}

function resolvedIntegrity(asset: ResolvedAsset, module: RegisteredModule) {
  if (!asset.integrityFile) return { integrityStatus: 'unverified' as const };
  const packaged = path.resolve(module.packageRoot, asset.integrityFile);
  const integrityFile = fs.existsSync(packaged) ? packaged : path.join(asset.resolvedPath, path.basename(asset.integrityFile));
  if (!fs.existsSync(integrityFile)) throw new Error(`Asset integrity file is missing: ${asset.id}`);
  return { integrityStatus: 'verified' as const, integrityFile, integrityFileSha256: sha256File(integrityFile) };
}

export function preferUnpackedPath(filePath: string) {
  const marker = `${path.sep}app.asar${path.sep}`;
  if (!filePath.includes(marker)) return filePath;
  const unpacked = filePath.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(unpacked) ? unpacked : filePath;
}

export function planExtensions(plan: ResolvedSessionPlan) {
  return plan.modules.flatMap((module) => module.entrypoints.filter((entry) => entry.kind === 'extension').map((entry) => entry.path));
}

export function planSkills(plan: ResolvedSessionPlan) {
  return plan.modules.flatMap((module) => module.entrypoints.filter((entry) => entry.kind === 'skill').map((entry) => entry.path));
}

export function planPromptPath(plan: ResolvedSessionPlan) {
  return plan.modules.flatMap((module) => module.entrypoints.filter((entry) => entry.kind === 'prompt').map((entry) => entry.path))[0];
}

export class SessionAssembler {
  constructor(
    private registry: ModuleRegistry,
    private assets: AssetResolver,
    private platformVersion: string,
    private pi: Executable,
    private python: Executable,
  ) {}

  assemble(domainId: string, workspace: string, requestedProfile?: SessionProfileV1): ResolvedSessionPlan {
    const modules = this.registry.dependencyOrder(domainId);
    const included = new Set(modules.map((module) => module.manifest.id));
    const selected = requestedProfile
      ? requestedProfile.modules.selected.map((selection) => {
        const module = this.registry.get(selection.id);
        if (!module?.enabled) throw new Error(`Selected Module is unavailable: ${selection.id}@${selection.version}`);
        if (module.manifest.version !== selection.version) throw new Error(`Selected Module version is unavailable: ${selection.id}@${selection.version}`);
        return module;
      })
      : this.registry.enabled().filter((module) => module.origin !== 'builtin');
    for (const module of selected) {
      for (const dependency of this.registry.dependencyOrder(module.manifest.id)) {
        if (included.has(dependency.manifest.id)) continue;
        included.add(dependency.manifest.id);
        modules.push(dependency);
      }
    }
    const domain = modules.find((module) => module.manifest.id === domainId)!;
    const selectedAssets: ResolvedAsset[] = [];
    const resolvedModules = modules.map((module) => {
      for (const entry of module.manifest.contributes?.assets || []) {
        const resolved = this.assets.resolve(entry.id);
        if (resolved) selectedAssets.push(resolved);
      }
      return resolvedPlanModule(module, domainId);
    });
    const promptCount = resolvedModules.flatMap((module) => module.entrypoints).filter((entry) => entry.kind === 'prompt').length;
    if (promptCount !== 1) throw new Error(`Domain ${domainId} must contribute exactly one prompt`);
    const profile = requestedProfile || defaultSessionProfile(
      modules.filter((module) => module.origin !== 'builtin').map((module) => ({ id: module.manifest.id, version: module.manifest.version })),
      'compat-default',
    );
    return {
      schemaVersion: 3,
      platform: { name: 'TransportX Traffic Agent', version: this.platformVersion },
      profile,
      domain: { id: domain.manifest.id, version: domain.manifest.version },
      modules: resolvedModules,
      assets: selectedAssets.map((asset) => {
        const module = this.registry.get(asset.moduleId)!;
        return { id: asset.id, kind: asset.kind, moduleId: asset.moduleId, moduleVersion: asset.moduleVersion, path: asset.resolvedPath, ...resolvedIntegrity(asset, module) };
      }),
      runtime: { ...(this.pi.version ? { piVersion: this.pi.version } : {}), ...(this.python.version ? { pythonVersion: this.python.version } : {}) },
      workspace: path.resolve(workspace),
      createdAt: new Date().toISOString(),
    };
  }

  save(plan: ResolvedSessionPlan, fileName = 'resolved-session-plan.json') {
    const target = path.join(plan.workspace, '.tau', fileName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`);
    fs.renameSync(temporary, target);
    return target;
  }

  load(workspace: string, fileName = 'resolved-session-plan.json') {
    const target = path.join(path.resolve(workspace), '.tau', fileName);
    if (!fs.existsSync(target)) throw new SessionPlanError('legacy_plan_requires_confirmation', 'Resolved session plan v3 is missing.', [{ path: target }]);
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    const parsed = parseResolvedSessionPlanStructured(raw);
    if (!parsed.ok) throw new SessionPlanError(raw?.schemaVersion === 2 ? 'legacy_plan_requires_confirmation' : 'invalid_session_plan', parsed.diagnostics.map((item) => item.message).join('; '), [{ path: target }]);
    return this.verify(parsed.value, workspace);
  }

  verify(plan: ResolvedSessionPlan, workspace = plan.workspace) {
    if (path.resolve(plan.workspace) !== path.resolve(workspace)) throw new SessionPlanError('workspace_mismatch', 'Resolved session plan belongs to another workspace.', [{ expected: path.resolve(workspace), actual: path.resolve(plan.workspace) }]);
    for (let index = 0; index < plan.modules.length; index++) {
      let module = plan.modules[index];
      const manifestPath = path.join(module.packageRoot, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        if (module.origin === 'builtin' && INSTALLABLE_REPLACEMENTS_FOR_RETIRED_BUILTINS.has(module.id)) {
          const replacement = this.registry.get(module.id);
          if (!replacement?.enabled || replacement.origin !== 'installed') {
            throw new SessionPlanError('module_version_missing', `Install and enable ${module.id} before resuming this session.`, [{ moduleId: module.id, expected: module.version, path: module.packageRoot }]);
          }
          module = resolvedPlanModule(replacement, plan.domain.id);
          plan.modules[index] = module;
          console.warn(`[Tau] Replaced retired builtin Module ${module.id} with installed version ${module.version} while resuming a session.`);
        } else {
        if (module.origin === 'builtin' && RETIRED_BUILTIN_MODULE_IDS.has(module.id)) continue;
        throw new SessionPlanError('module_version_missing', `Module version is missing: ${module.id}@${module.version}`, [{ moduleId: module.id, expected: module.version, path: module.packageRoot }]);
        }
      }
      const currentManifestPath = path.join(module.packageRoot, 'manifest.json');
      // Builtin modules ship with the platform and are replaced in place on upgrade;
      // their old versions no longer exist, so content drift is tolerated (and logged)
      // instead of making every older session unloadable. Installed/external modules
      // keep exact-version enforcement because multiple versions coexist.
      const builtin = module.origin === 'builtin';
      if (sha256File(currentManifestPath) !== module.manifestSha256) {
        const message = `Module manifest changed: ${module.id}@${module.version}`;
        if (!builtin) throw new SessionPlanError('module_content_mismatch', message, [{ moduleId: module.id, expected: module.manifestSha256, actual: sha256File(currentManifestPath) }]);
        console.warn(`[Tau] Tolerating builtin module drift while resuming a session: ${message}`);
      }
      for (const entry of module.entrypoints) {
        if (!fs.existsSync(entry.path) || sha256File(entry.path) !== entry.sha256) {
          const message = `Module entrypoint changed: ${module.id}@${module.version}`;
          if (!builtin) throw new SessionPlanError('module_content_mismatch', message, [{ moduleId: module.id, path: entry.path, expected: entry.sha256, actual: fs.existsSync(entry.path) ? sha256File(entry.path) : 'missing' }]);
          console.warn(`[Tau] Tolerating builtin module drift while resuming a session: ${message} (${entry.path})`);
        }
      }
      for (const runtime of module.nativeRuntimes) {
        const manifest = parseModuleManifestStructured(JSON.parse(fs.readFileSync(currentManifestPath, 'utf8')));
        const declared = manifest.ok ? manifest.value.contributes?.nativeRuntimes?.find((candidate) => candidate.id === runtime.id && candidate.platform === runtime.platform && candidate.arch === runtime.arch && candidate.version === runtime.version) : undefined;
        if (!declared) throw new SessionPlanError('module_content_mismatch', `Native runtime is not declared by Module ${module.id}@${module.version}`, [{ moduleId: module.id, runtimeId: runtime.id }]);
        const expectedFfmpeg = resolvePackagePath(module.packageRoot, declared.executables.ffmpeg.path, 'ffmpeg executable');
        const expectedFfprobe = resolvePackagePath(module.packageRoot, declared.executables.ffprobe.path, 'ffprobe executable');
        if (runtime.ffmpeg.path !== expectedFfmpeg || runtime.ffprobe.path !== expectedFfprobe || runtime.ffmpeg.sha256 !== declared.executables.ffmpeg.sha256 || runtime.ffprobe.sha256 !== declared.executables.ffprobe.sha256) {
          throw new SessionPlanError('module_content_mismatch', `Native runtime plan changed: ${module.id}@${module.version}`, [{ moduleId: module.id, runtimeId: runtime.id }]);
        }
        for (const executable of [runtime.ffmpeg, runtime.ffprobe]) {
          if (!fs.existsSync(executable.path) || sha256File(executable.path) !== executable.sha256) {
            throw new SessionPlanError('module_content_mismatch', `Native runtime changed: ${module.id}@${module.version}`, [{ moduleId: module.id, path: executable.path, expected: executable.sha256, actual: fs.existsSync(executable.path) ? sha256File(executable.path) : 'missing' }]);
          }
        }
      }
    }
    for (const asset of plan.assets) {
      if (!fs.existsSync(asset.path)) throw new SessionPlanError('asset_missing', `Session asset is missing: ${asset.id}`, [{ path: asset.path }]);
      if (asset.integrityStatus === 'verified') {
        if (!asset.integrityFile || !asset.integrityFileSha256 || !fs.existsSync(asset.integrityFile)) throw new SessionPlanError('asset_missing', `Asset integrity file is missing: ${asset.id}`, [{ path: asset.integrityFile || '' }]);
        const actual = sha256File(asset.integrityFile);
        if (actual !== asset.integrityFileSha256) throw new SessionPlanError('asset_integrity_mismatch', `Asset integrity manifest changed: ${asset.id}`, [{ expected: asset.integrityFileSha256, actual }]);
        try { verifyChecksumFile(asset.path, asset.integrityFile); }
        catch (error) { throw new SessionPlanError('asset_integrity_mismatch', error instanceof Error ? error.message : String(error), [{ path: asset.path }]); }
      }
    }
    return plan;
  }
}
