const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

import { readJsonObject, writeJsonAtomic, assertHostWriter } from './util/json-storage.js';
import type { TauArgs, TauSettings, TauSettingsFile } from './types.js';
import { ensureWritableAppPaths, resolveAppPaths } from './app-paths.js';
import { projectAdapter } from './project-adapter.js';
import { resolveFfmpegExecutables, resolvePiExecutable, resolvePythonExecutable, type VideoExecutables } from './runtime-resolver.js';

export function parseArgs(argv: string[]): TauArgs {
  const out: TauArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'open' || key === 'desktop' || key === 'ready-json' || key === 'remote') { out[key] = true; continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
  }
  return out;
}

export const ARGS = parseArgs(process.argv.slice(2));
export const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
export const DESKTOP_MODE = ARGS.desktop === true || process.env.TAU_DESKTOP === '1';
export const APP_PATHS = resolveAppPaths();
if (DESKTOP_MODE) ensureWritableAppPaths(APP_PATHS);
export const PI_AGENT_DIR = DESKTOP_MODE ? APP_PATHS.piAgentDir : process.env.PI_CODING_AGENT_DIR || path.join(USER_HOME, '.pi', 'agent');
export const SESSIONS_DIR = DESKTOP_MODE ? APP_PATHS.sessionsDir : process.env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_AGENT_DIR, 'sessions');
export const PI_EXECUTABLE = resolvePiExecutable({ appRoot: APP_PATHS.appRoot, resourcesDir: APP_PATHS.resourcesDir, desktop: DESKTOP_MODE });
export const PI_COMMAND = PI_EXECUTABLE.command;
export const PI_COMMAND_ARGS = PI_EXECUTABLE.args;
export const PYTHON_EXECUTABLE = resolvePythonExecutable({ resourcesDir: APP_PATHS.resourcesDir, desktop: DESKTOP_MODE });
export const PYTHON_COMMAND = PYTHON_EXECUTABLE.command;
export const FFMPEG_EXECUTABLES: VideoExecutables | null = (() => {
  try {
    return resolveFfmpegExecutables({ resourcesDir: APP_PATHS.resourcesDir, desktop: DESKTOP_MODE });
  } catch {
    return null; // Video processing reports a clear error when ffmpeg is unavailable.
  }
})();
export const PLATFORM_VERSION = '3.23.2';

export function expandHome(p: string) {
  if (!p || typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(USER_HOME, p.slice(1)) : p;
}

export function loadTauSettings(): TauSettings {
  const file = readJsonObject(path.join(PI_AGENT_DIR, 'settings.json'));
  if (file.tau !== undefined && (!file.tau || typeof file.tau !== 'object' || Array.isArray(file.tau))) throw new Error('Invalid tau settings');
  const settings = (file.tau || {}) as NonNullable<TauSettingsFile['tau']>;
  return {
    port: DESKTOP_MODE ? 0 : parseInt(String(ARGS.port || process.env.TAU_PORT || settings.port || '3001'), 10),
    host: DESKTOP_MODE ? '127.0.0.1' : ARGS.host || process.env.TAU_HOST || settings.host || '127.0.0.1',
    remoteAccess: ARGS.remote === true || process.env.TAU_REMOTE === '1' || settings.remoteAccess === true,
    user: process.env.TAU_USER || settings.user || '',
    pass: process.env.TAU_PASS || settings.pass || '',
    authEnabled: settings.authEnabled,
    cookieSecret: process.env.TAU_COOKIE_SECRET || settings.cookieSecret || '',
    projectsDir: expandHome(ARGS['projects-dir'] || process.env.TAU_PROJECTS_DIR || settings.projectsDir || (DESKTOP_MODE ? APP_PATHS.scenarioDir : '')),
    enabledModuleIds: Array.isArray(settings.enabledModuleIds) ? settings.enabledModuleIds.filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id)) : [],
  };
}

export const TAU_SETTINGS = loadTauSettings();
export const PROJECT_AUTH = projectAdapter.createAuth(APP_PATHS, process.env);
export const AUTH_CONFIGURED = !!PROJECT_AUTH || !!(TAU_SETTINGS.user && TAU_SETTINGS.pass);
export const PORT = TAU_SETTINGS.port;
export const HOST = TAU_SETTINGS.host;
export const REACT_STATIC_DIR = process.env.TAU_REACT_STATIC_DIR || findReactWebDir();
export const PROJECT_SYSTEM_PROMPT_PATH = path.resolve(APP_PATHS.appRoot, 'src', 'server', 'prompts', 'PI_SYSTEM.md');
export const DEFAULT_DOMAIN_ID = process.env.TAU_DOMAIN_ID || 'com.transportx.workbench';
export const BUILTIN_MODULE_MANIFESTS = [
  'modules/capabilities/web-bridge/manifest.json',
  'modules/capabilities/tool-activation/manifest.json',
  'modules/capabilities/interaction/manifest.json',
  'modules/capabilities/citation/manifest.json',
  'modules/capabilities/canvas/manifest.json',
  'modules/capabilities/document/manifest.json',
  'modules/capabilities/geo/manifest.json',
  'modules/capabilities/spatial-analysis/manifest.json',
  'modules/capabilities/cad/manifest.json',
  'modules/official/traffic-report/manifest.json',
  'modules/official/module-authoring/manifest.json',
  'modules/official/cli/manifest.json',
  'modules/official/workbench/manifest.json',
].map((manifestPath) => {
  const absolutePath = path.join(APP_PATHS.appRoot, manifestPath);
  return { manifestPath: absolutePath, packageRoot: path.dirname(absolutePath), origin: 'builtin' as const };
});
export const LOCAL_MODULE_MANIFESTS = String(process.env.TAU_MODULE_MANIFESTS || '')
  .split(path.delimiter)
  .map((manifestPath) => expandHome(manifestPath.trim()))
  .filter(Boolean)
  .map((manifestPath) => ({ manifestPath, packageRoot: path.dirname(path.resolve(manifestPath)), origin: 'external' as const }));

function findReactWebDir() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'dist', 'web'));
  add(path.join(APP_PATHS.appRoot, 'dist', 'web'));
  add(path.join(process.cwd(), 'dist', 'web'));
  try {
    const pkgPath = require.resolve('transportx-agent/package.json');
    add(path.join(path.dirname(pkgPath), 'dist', 'web'));
  } catch {}
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html'))) || candidates[0];
}

export const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm',
};

export function saveTauSetting(key: string, value: unknown): boolean {
  const settingsPath = path.join(PI_AGENT_DIR, 'settings.json');
  try {
    assertHostWriter(PI_AGENT_DIR);
    const settings = readJsonObject(settingsPath) as TauSettingsFile;
    if (settings.tau !== undefined && (!settings.tau || typeof settings.tau !== 'object' || Array.isArray(settings.tau))) throw new Error('Invalid tau settings');
    if (!settings.tau) settings.tau = {};
    settings.tau[key] = value;
    writeJsonAtomic(settingsPath, settings);
    return true;
  } catch {
    return false;
  }
}
