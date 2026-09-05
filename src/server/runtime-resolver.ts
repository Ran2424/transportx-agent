const fs = require('node:fs');
const path = require('node:path');

import { sha256File } from './asset-integrity.js';
import { isWithin } from './util/path.js';

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
  /** Optional until the packaged runtime ships ffmpeg; required in desktop Video flows. */
  ffmpeg?: RuntimeEntry & { arch?: string };
  ffprobe?: RuntimeEntry & { arch?: string };
};

export type Executable = { command: string; args: string[]; version?: string };

function resolveEntry(resourcesDir: string, entry: RuntimeEntry, label: string) {
  if (!entry.path || path.isAbsolute(entry.path)) throw new Error(`${label} runtime path must be relative`);
  const resolved = path.resolve(resourcesDir, entry.path);
  if (!isWithin(resourcesDir, resolved)) throw new Error(`${label} runtime path escapes resources`);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`${label} runtime is missing: ${resolved}`);
  if (!/^[a-f0-9]{64}$/i.test(entry.sha256) || sha256File(resolved) !== entry.sha256.toLowerCase()) {
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

export type VideoExecutables = { ffmpeg: Executable; ffprobe: Executable };

/**
 * Resolve the controlled ffmpeg/ffprobe pair. Packaged apps must use the
 * runtime manifest entries (integrity-checked, PATH-independent); development
 * may override via TAU_FFMPEG_COMMAND/TAU_FFPROBE_COMMAND or fall back to PATH.
 */
export function resolveFfmpegExecutables(opts: { resourcesDir: string; desktop: boolean; env?: NodeJS.ProcessEnv }): VideoExecutables {
  const env = opts.env || process.env;
  if (env.TAU_FFMPEG_COMMAND && env.TAU_FFPROBE_COMMAND) {
    return { ffmpeg: { command: env.TAU_FFMPEG_COMMAND, args: [] }, ffprobe: { command: env.TAU_FFPROBE_COMMAND, args: [] } };
  }
  if (opts.desktop) {
    const manifest = loadRuntimeManifest(opts.resourcesDir);
    if (!manifest.ffmpeg || !manifest.ffprobe) throw new Error('Packaged runtime is missing ffmpeg/ffprobe entries');
    return {
      ffmpeg: { command: resolveEntry(opts.resourcesDir, manifest.ffmpeg, 'ffmpeg'), args: [], version: manifest.ffmpeg.version },
      ffprobe: { command: resolveEntry(opts.resourcesDir, manifest.ffprobe, 'ffprobe'), args: [], version: manifest.ffprobe.version },
    };
  }
  return { ffmpeg: { command: 'ffmpeg', args: [] }, ffprobe: { command: 'ffprobe', args: [] } };
}
