const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

import type { TauArgs, TauSettings, TauSettingsFile } from './types.js';
import type { Dirent } from 'node:fs';
import { ensureWritableAppPaths, resolveAppPaths } from './app-paths.js';
import { resolvePiExecutable, resolvePythonExecutable } from './runtime-resolver.js';
import { ModuleRegistry } from './module-registry.js';
import { AssetResolver } from './asset-resolver.js';
import { SessionAssembler } from './session-assembly.js';
import { ModuleInstaller } from './module-installer.js';

export function parseArgs(argv: string[]): TauArgs {
  const out: TauArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'open' || key === 'desktop') { out[key] = true; continue; }
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
export const PLATFORM_VERSION = '3.0.4';

export function expandHome(p: string) {
  if (!p || typeof p !== 'string') return p;
  return p.startsWith('~') ? path.join(USER_HOME, p.slice(1)) : p;
}

export function loadTauSettings(): TauSettings {
  let settings: TauSettingsFile['tau'] = {};
  try {
    const settingsPath = path.join(PI_AGENT_DIR, 'settings.json');
    settings = ((JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as TauSettingsFile).tau || {});
  } catch {}
  return {
    port: DESKTOP_MODE ? 0 : parseInt(String(ARGS.port || process.env.TAU_PORT || settings.port || '3001'), 10),
    host: DESKTOP_MODE ? '127.0.0.1' : ARGS.host || process.env.TAU_HOST || settings.host || '0.0.0.0',
    user: process.env.TAU_USER || settings.user || '',
    pass: process.env.TAU_PASS || settings.pass || '',
    authEnabled: settings.authEnabled,
    cookieSecret: process.env.TAU_COOKIE_SECRET || settings.cookieSecret || '',
    projectsDir: expandHome(ARGS['projects-dir'] || process.env.TAU_PROJECTS_DIR || settings.projectsDir || (DESKTOP_MODE ? APP_PATHS.scenarioDir : '')),
  };
}

export const TAU_SETTINGS = loadTauSettings();
export const AUTH_CONFIGURED = !!(TAU_SETTINGS.user && TAU_SETTINGS.pass);
export const PORT = TAU_SETTINGS.port;
export const HOST = TAU_SETTINGS.host;
export const STATIC_DIR = process.env.TAU_STATIC_DIR || findPublicDir();
export const REACT_STATIC_DIR = process.env.TAU_REACT_STATIC_DIR || findReactWebDir();
export const GEO_EXTENSION_PATH = process.env.TAU_GEO_EXTENSION_PATH || findGeoExtensionPath();
export const TASK_MODE_EXTENSION_PATH = process.env.TAU_TASK_MODE_EXTENSION_PATH || findTaskModeExtensionPath();
export const WEB_BRIDGE_EXTENSION_PATH = process.env.TAU_WEB_BRIDGE_EXTENSION_PATH || findWebBridgeExtensionPath();
export const CITATION_EXTENSION_PATH = process.env.TAU_CITATION_EXTENSION_PATH || findCitationExtensionPath();
export const BUILTIN_EXTENSION_PATHS = [GEO_EXTENSION_PATH, TASK_MODE_EXTENSION_PATH, WEB_BRIDGE_EXTENSION_PATH, CITATION_EXTENSION_PATH];
export const PROJECT_SKILLS_DIR = process.env.TAU_SKILLS_DIR || findProjectSkillsDir();
export const BUILTIN_SKILL_PATHS = findSkillPaths(PROJECT_SKILLS_DIR);
export const PROJECT_ROOT = path.dirname(PROJECT_SKILLS_DIR);
export const PROJECT_SYSTEM_PROMPT_PATH = path.resolve(path.join(PROJECT_ROOT, 'prompts', 'PI_SYSTEM.md'));
export const PROJECT_PROMPT_PATH = path.resolve(process.env.TAU_PROJECT_PROMPT_PATH || path.join(PROJECT_ROOT, 'prompts', 'PI_SESSION_CONTEXT.md'));
export const DEFAULT_DOMAIN_ID = process.env.TAU_DOMAIN_ID || 'com.transportx.workbench';
export const BUILTIN_MODULE_MANIFESTS = [
  'modules/capabilities/web-bridge/manifest.json',
  'modules/capabilities/task/manifest.json',
  'modules/capabilities/citation/manifest.json',
  'modules/capabilities/geo/manifest.json',
  'modules/official/traffic-report/manifest.json',
  'modules/official/workbench/manifest.json',
].map((manifestPath) => ({ manifestPath: path.join(APP_PATHS.appRoot, manifestPath), packageRoot: APP_PATHS.appRoot, origin: 'builtin' as const }));
export const LOCAL_MODULE_MANIFESTS = String(process.env.TAU_MODULE_MANIFESTS || '')
  .split(path.delimiter)
  .map((manifestPath) => expandHome(manifestPath.trim()))
  .filter(Boolean)
  .map((manifestPath) => ({ manifestPath, packageRoot: path.dirname(path.resolve(manifestPath)), origin: 'external' as const }));
export const MODULE_INSTALLER = new ModuleInstaller(APP_PATHS.modulesDir);
export function moduleSources() { return [...BUILTIN_MODULE_MANIFESTS, ...MODULE_INSTALLER.sources(), ...LOCAL_MODULE_MANIFESTS]; }
export const MODULE_REGISTRY = new ModuleRegistry(PLATFORM_VERSION).load(moduleSources());
export const ASSET_RESOLVER = new AssetResolver(MODULE_REGISTRY, {
  ...(process.env.TAU_KNOWLEDGE_ROOT && process.env.TAU_KNOWLEDGE_ASSET_ID ? { [process.env.TAU_KNOWLEDGE_ASSET_ID]: process.env.TAU_KNOWLEDGE_ROOT } : {}),
  ...(process.env.TAU_DATA_ROOT && process.env.TAU_DATA_ASSET_ID ? { [process.env.TAU_DATA_ASSET_ID]: process.env.TAU_DATA_ROOT } : {}),
});
export const SESSION_ASSEMBLER = new SessionAssembler(MODULE_REGISTRY, ASSET_RESOLVER, PLATFORM_VERSION, PI_EXECUTABLE, PYTHON_EXECUTABLE, {
  ...(process.env.TAU_KNOWLEDGE_ASSET_ID ? { knowledge: process.env.TAU_KNOWLEDGE_ASSET_ID } : {}),
  ...(process.env.TAU_DATA_ASSET_ID ? { data: process.env.TAU_DATA_ASSET_ID } : {}),
});
export function reloadModules() {
  MODULE_REGISTRY.reload(moduleSources());
  ASSET_RESOLVER.reload(MODULE_REGISTRY);
  return MODULE_REGISTRY;
}

function findPublicDir() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'public'));
  add(path.join(APP_PATHS.appRoot, 'public'));
  add(path.join(process.cwd(), 'public'));
  try {
    const pkgPath = require.resolve('pi-traffic-workspace/package.json');
    add(path.join(path.dirname(pkgPath), 'public'));
  } catch {}
  try {
    const pkgPath = require.resolve('pi-tau-web-server/package.json');
    add(path.join(path.dirname(pkgPath), 'public'));
  } catch {}
  add(path.join(process.cwd(), 'node_modules', 'pi-traffic-workspace', 'public'));
  add(path.join(process.cwd(), 'node_modules', 'pi-tau-web-server', 'public'));
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html'))) || candidates[0];
}

function findReactWebDir() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'dist', 'web'));
  add(path.join(APP_PATHS.appRoot, 'dist', 'web'));
  add(path.join(process.cwd(), 'dist', 'web'));
  try {
    const pkgPath = require.resolve('pi-traffic-workspace/package.json');
    add(path.join(path.dirname(pkgPath), 'dist', 'web'));
  } catch {}
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html'))) || candidates[0];
}

function findGeoExtensionPath() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'extensions', 'pi-geo-visualization', 'index.ts'));
  add(path.join(APP_PATHS.appRoot, 'extensions', 'pi-geo-visualization', 'index.ts'));
  add(path.join(process.cwd(), 'extensions', 'pi-geo-visualization', 'index.ts'));
  try {
    const pkgPath = require.resolve('pi-traffic-workspace/package.json');
    add(path.join(path.dirname(pkgPath), 'extensions', 'pi-geo-visualization', 'index.ts'));
  } catch {}
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function findTaskModeExtensionPath() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'extensions', 'pi-task-mode', 'index.ts'));
  add(path.join(APP_PATHS.appRoot, 'extensions', 'pi-task-mode', 'index.ts'));
  add(path.join(process.cwd(), 'extensions', 'pi-task-mode', 'index.ts'));
  try {
    const pkgPath = require.resolve('pi-traffic-workspace/package.json');
    add(path.join(path.dirname(pkgPath), 'extensions', 'pi-task-mode', 'index.ts'));
  } catch {}
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function findWebBridgeExtensionPath() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'extensions', 'pi-web-bridge', 'index.ts'));
  add(path.join(APP_PATHS.appRoot, 'extensions', 'pi-web-bridge', 'index.ts'));
  add(path.join(process.cwd(), 'extensions', 'pi-web-bridge', 'index.ts'));
  try {
    const pkgPath = require.resolve('pi-traffic-workspace/package.json');
    add(path.join(path.dirname(pkgPath), 'extensions', 'pi-web-bridge', 'index.ts'));
  } catch {}
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function findCitationExtensionPath() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'extensions', 'pi-citation', 'index.ts'));
  add(path.join(APP_PATHS.appRoot, 'extensions', 'pi-citation', 'index.ts'));
  add(path.join(process.cwd(), 'extensions', 'pi-citation', 'index.ts'));
  try {
    const pkgPath = require.resolve('pi-traffic-workspace/package.json');
    add(path.join(path.dirname(pkgPath), 'extensions', 'pi-citation', 'index.ts'));
  } catch {}
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function findProjectSkillsDir() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'skills'));
  add(path.join(APP_PATHS.appRoot, 'skills'));
  add(path.join(process.cwd(), 'skills'));
  try {
    const pkgPath = require.resolve('pi-traffic-workspace/package.json');
    add(path.join(path.dirname(pkgPath), 'skills'));
  } catch {}
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function findSkillPaths(skillsDir: string) {
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry: Dirent) => entry.isDirectory() && fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
      .map((entry: Dirent) => path.join(skillsDir, entry.name, 'SKILL.md'))
      .sort();
  } catch {
    return [];
  }
}

export const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function saveTauSetting(key: string, value: unknown): boolean {
  const settingsPath = path.join(PI_AGENT_DIR, 'settings.json');
  try {
    let settings: TauSettingsFile = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as TauSettingsFile; } catch {}
    if (!settings.tau) settings.tau = {};
    settings.tau[key] = value;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return true;
  } catch {
    return false;
  }
}
