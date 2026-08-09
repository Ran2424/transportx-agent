const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

export const AGENT_HOST_PROTOCOL_VERSION = 1;
export const RUNTIME_MANIFEST_VERSION = 1;

export type RuntimeEntry = {
  version: string;
  path: string;
  sha256: string;
};

export type RuntimeManifest = {
  manifestVersion: 1;
  product: { name: string; version: string };
  agentHost: RuntimeEntry & { protocolVersion: number };
  pi: RuntimeEntry;
  python: RuntimeEntry;
};

export type Executable = { command: string; args: string[]; version?: string };

function sha256(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveEntry(resourcesDir: string, entry: RuntimeEntry, label: string) {
  if (!entry.path || path.isAbsolute(entry.path)) throw new Error(`${label} runtime path must be relative`);
  const resolved = path.resolve(resourcesDir, entry.path);
  const relative = path.relative(path.resolve(resourcesDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${label} runtime path escapes resources`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${label} runtime is missing: ${resolved}`);
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256) || sha256(resolved) !== entry.sha256.toLowerCase()) {
    throw new Error(`${label} runtime checksum mismatch: ${resolved}`);
  }
  return resolved;
}

export function loadRuntimeManifest(resourcesDir: string): RuntimeManifest {
  const manifestPath = path.join(resourcesDir, 'runtime-manifest.json');
  let manifest: RuntimeManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as RuntimeManifest;
  } catch (error) {
    throw new Error(`Cannot read runtime manifest '${manifestPath}': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (manifest.manifestVersion !== RUNTIME_MANIFEST_VERSION) throw new Error(`Unsupported runtime manifest version: ${String(manifest.manifestVersion)}`);
  if (manifest.product?.name !== 'TransportX Traffic Agent') throw new Error('Runtime manifest product name mismatch');
  if (manifest.agentHost?.protocolVersion !== AGENT_HOST_PROTOCOL_VERSION) throw new Error(`Agent Host protocol mismatch: ${String(manifest.agentHost?.protocolVersion)}`);
  return manifest;
}

export function validateRuntimeManifest(resourcesDir: string, manifest = loadRuntimeManifest(resourcesDir)) {
  return {
    manifest,
    agentHost: resolveEntry(resourcesDir, manifest.agentHost, 'Agent Host'),
    pi: resolveEntry(resourcesDir, manifest.pi, 'Pi CLI'),
    python: resolveEntry(resourcesDir, manifest.python, 'Python'),
  };
}

function localPiEntrypoint(appRoot: string) {
  return path.join(appRoot, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
}

export function resolvePiExecutable(opts: { appRoot: string; resourcesDir: string; desktop: boolean; env?: NodeJS.ProcessEnv }): Executable {
  const env = opts.env || process.env;
  if (env.TAU_PI_COMMAND) return { command: env.TAU_PI_COMMAND, args: [] };
  if (env.TAU_PI_ENTRYPOINT) return { command: process.execPath, args: [path.resolve(env.TAU_PI_ENTRYPOINT)] };
  if (opts.desktop) {
    const manifest = loadRuntimeManifest(opts.resourcesDir);
    return { command: process.execPath, args: [resolveEntry(opts.resourcesDir, manifest.pi, 'Pi CLI')], version: manifest.pi.version };
  }
  const local = localPiEntrypoint(opts.appRoot);
  return fs.existsSync(local) ? { command: process.execPath, args: [local] } : { command: 'pi', args: [] };
}

export function resolvePythonExecutable(opts: { resourcesDir: string; desktop: boolean; env?: NodeJS.ProcessEnv }): Executable {
  const env = opts.env || process.env;
  if (env.TAU_PYTHON_COMMAND) return { command: env.TAU_PYTHON_COMMAND, args: [] };
  if (opts.desktop) {
    const manifest = loadRuntimeManifest(opts.resourcesDir);
    return { command: resolveEntry(opts.resourcesDir, manifest.python, 'Python'), args: [], version: manifest.python.version };
  }
  return { command: 'python3', args: [] };
}
