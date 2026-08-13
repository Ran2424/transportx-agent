const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

import {
  defaultSessionProfile,
  parseResolvedSessionPlanStructured,
  type ResolvedPlanEntrypoint,
  type ResolvedSessionPlanV3,
  type SessionProfileV1,
} from '../contracts/index.js';
import type { Executable } from './runtime-resolver.js';
import type { ModuleRegistry, RegisteredModule } from './module-registry.js';
import type { AssetResolver, ResolvedAsset } from './asset-resolver.js';
import { verifyChecksumFile } from './asset-integrity.js';

export type ResolvedSessionPlan = ResolvedSessionPlanV3;

export class SessionPlanError extends Error {
  status = 409;
  constructor(readonly code: string, message: string, readonly details: Array<Record<string, string>> = []) { super(message); }
}

function sha256File(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolvePackagePath(packageRoot: string, relativePath: string, label: string) {
  const resolved = path.resolve(packageRoot, relativePath);
  const relative = path.relative(path.resolve(packageRoot), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} escapes package root: ${relativePath}`);
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
    for (const installed of this.registry.enabled().filter((module) => module.origin !== 'builtin')) {
      for (const dependency of this.registry.dependencyOrder(installed.manifest.id)) {
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
      return {
        id: module.manifest.id,
        version: module.manifest.version,
        type: module.manifest.type,
        origin: module.origin,
        packageRoot: module.packageRoot,
        manifestSha256: sha256File(module.manifestPath),
        entrypoints: resolvedEntrypoints(module, domainId),
      };
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
    for (const module of plan.modules) {
      const manifestPath = path.join(module.packageRoot, 'manifest.json');
      if (!fs.existsSync(manifestPath)) throw new SessionPlanError('module_version_missing', `Module version is missing: ${module.id}@${module.version}`, [{ moduleId: module.id, expected: module.version, path: module.packageRoot }]);
      if (sha256File(manifestPath) !== module.manifestSha256) throw new SessionPlanError('module_content_mismatch', `Module manifest changed: ${module.id}@${module.version}`, [{ moduleId: module.id, expected: module.manifestSha256, actual: sha256File(manifestPath) }]);
      for (const entry of module.entrypoints) {
        if (!fs.existsSync(entry.path) || sha256File(entry.path) !== entry.sha256) throw new SessionPlanError('module_content_mismatch', `Module entrypoint changed: ${module.id}@${module.version}`, [{ moduleId: module.id, path: entry.path, expected: entry.sha256, actual: fs.existsSync(entry.path) ? sha256File(entry.path) : 'missing' }]);
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
