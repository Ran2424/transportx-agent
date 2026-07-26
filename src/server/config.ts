const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

import type { TauArgs, TauSettings, TauSettingsFile } from './types.js';
import type { Dirent } from 'node:fs';

export function parseArgs(argv: string[]): TauArgs {
  const out: TauArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'open') { out.open = true; continue; }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i++; }
  }
  return out;
}

export const ARGS = parseArgs(process.argv.slice(2));
export const USER_HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(USER_HOME, '.pi', 'agent');
export const SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR || path.join(PI_AGENT_DIR, 'sessions');
export const PI_COMMAND = process.env.TAU_PI_COMMAND || 'pi';

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
    port: parseInt(String(ARGS.port || process.env.TAU_PORT || settings.port || '3001'), 10),
    host: ARGS.host || process.env.TAU_HOST || settings.host || '0.0.0.0',
    user: process.env.TAU_USER || settings.user || '',
    pass: process.env.TAU_PASS || settings.pass || '',
    authEnabled: settings.authEnabled,
    cookieSecret: process.env.TAU_COOKIE_SECRET || settings.cookieSecret || '',
    projectsDir: expandHome(ARGS['projects-dir'] || process.env.TAU_PROJECTS_DIR || settings.projectsDir || ''),
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
export const KNOWLEDGE_ROOT = path.resolve(process.env.TAU_KNOWLEDGE_ROOT || '/Users/ran/WorkSpace/2 Unit Project/202 单位/上海交通指挥中心/揭榜挂帅/knowledge');
export const TRAFFIC_SKILL_DIR = path.join(PROJECT_SKILLS_DIR, 'shanghai-traffic-data-assets');
export const TRAFFIC_TOOLS_DIR = path.join(TRAFFIC_SKILL_DIR, 'scripts');
export const TRAFFIC_DATA_DIR = path.join(TRAFFIC_SKILL_DIR, 'assets', 'databases');
export const PROJECT_PROMPT_PATH = path.resolve(process.env.TAU_PROJECT_PROMPT_PATH || path.join(PROJECT_ROOT, 'prompts', 'PI_SESSION_CONTEXT.md'));

function findPublicDir() {
  const candidates: string[] = [];
  const add = (p: string) => candidates.push(path.resolve(p));
  add(path.join(__dirname, '..', 'public'));
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
