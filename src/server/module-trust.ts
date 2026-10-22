import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseModuleManifestStructured } from '../contracts/index.js';
import type { ResolvedSessionPlan } from './session-assembly.js';
import { preferUnpackedPath } from './session-assembly.js';
import { readJsonObject, writeJsonAtomic } from './util/json-storage.js';
import { isWithin, toPosixPath } from './util/path.js';
import { desktopMessageChannel } from './report-pdf.js';

export type ModuleTrustRequest = {
  id: string; version: string; name: string; packageRoot: string;
  entrypoints: string[]; dependencies: string[];
};

// Grants cover local code execution for this package/version and declared entries.
// They deliberately do not hash-lock user-editable code or claim OS isolation.
function describePackage(packageRoot: string): ModuleTrustRequest {
  const root = fs.realpathSync(packageRoot);
  const parsed = parseModuleManifestStructured(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')));
  if (!parsed.ok) throw new Error('Cannot establish trust for an invalid Module manifest');
  const manifest = parsed.value;
  const entrypoints = Object.values(manifest.entrypoints || {}).flat().sort();
  for (const entry of entrypoints) {
    if (!isWithin(root, fs.realpathSync(path.resolve(root, entry)))) throw new Error('Module entrypoint escapes its package');
  }
  return { id: manifest.id, version: manifest.version, name: manifest.name, packageRoot: root, entrypoints, dependencies: [...manifest.dependencies].sort() };
}

function scope(request: ModuleTrustRequest) {
  return JSON.stringify({ ...request, packageRoot: toPosixPath(request.packageRoot), name: undefined });
}

export class ModuleTrustStore {
  constructor(private file: string, private confirm: (request: ModuleTrustRequest) => Promise<boolean>) {}

  async ensure(packageRoots: string[]) {
    for (const root of new Set(packageRoots)) {
      const request = describePackage(root);
      const key = crypto.createHash('sha256').update(scope(request)).digest('hex');
      const grants = readJsonObject(this.file);
      if (grants[key] && typeof grants[key] === 'object' && (grants[key] as { entry?: string }).entry === 'desktop-native') continue;
      if (!await this.confirm(request)) throw new Error(`Module code trust was not accepted: ${request.id}@${request.version}. Enable it in the desktop app to review local code execution.`);
      if (scope(describePackage(root)) !== scope(request)) throw new Error('Module declaration changed during trust confirmation; review it again');
      // Re-read after the asynchronous decision so concurrent grants are retained.
      writeJsonAtomic(this.file, { ...readJsonObject(this.file), [key]: { ...request, packageRoot: toPosixPath(request.packageRoot), acceptedAt: new Date().toISOString(), entry: 'desktop-native' } });
    }
  }

  forget(packageRoots: string[]) {
    const roots = new Set(packageRoots.map((root) => toPosixPath(fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root))));
    const grants = readJsonObject(this.file);
    for (const [key, value] of Object.entries(grants)) if (value && typeof value === 'object' && roots.has(String((value as { packageRoot?: string }).packageRoot))) delete grants[key];
    writeJsonAtomic(this.file, grants);
  }
}

export async function confirmDesktopModuleTrust(request: ModuleTrustRequest) {
  const channel = desktopMessageChannel();
  if (!channel) return false;
  const id = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    const finish = (accepted: boolean) => { clearTimeout(timer); remove(); resolve(accepted); };
    const remove = channel.onMessage((value) => {
      const message = value as { type?: string; id?: string; accepted?: boolean };
      if (message?.type === 'transportx-module-trust-response' && message.id === id) finish(message.accepted === true);
    });
    const timer = setTimeout(() => finish(false), 120_000);
    channel.send({ type: 'transportx-module-trust-request', id, request });
  });
}

export async function ensureSessionModuleTrust(plan: ResolvedSessionPlan, builtinManifests: string[], store: ModuleTrustStore) {
  const builtins = new Set(builtinManifests.map((file) => fs.realpathSync(path.dirname(preferUnpackedPath(file)))));
  const pending: string[] = [];
  for (const module of plan.modules) {
    const descriptor = describePackage(preferUnpackedPath(module.packageRoot));
    if (descriptor.id !== module.id) throw new Error('Module identity differs from the session plan');
    const entries = new Set(descriptor.entrypoints.map((entry) => fs.realpathSync(preferUnpackedPath(path.join(descriptor.packageRoot, entry)))));
    for (const entry of module.entrypoints) if (!entries.has(fs.realpathSync(entry.path))) throw new Error(`Undeclared Module entrypoint: ${module.id}`);
    // Neither a stored origin label nor a familiar module id grants the exception.
    if (!builtins.has(descriptor.packageRoot)) {
      if (descriptor.version !== module.version) throw new Error('Module version differs from the session plan');
      pending.push(descriptor.packageRoot);
    }
  }
  await store.ensure(pending);
}
