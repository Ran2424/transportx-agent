const fs = require('node:fs');
const path = require('node:path');

import { isWithin, toPosixPath } from './util/path.js';
import { containedFile } from './util/resource-path.js';

const WORKSPACE_OWNER_FILE = 'workspace-owner.json';

export function makeSessionId() {
  return `tau_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function timestampForDirectory(date = new Date()) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
  ].join('') + '-' + [
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('');
}

function safeDirectoryName(name: unknown) {
  const cleaned = String(name || 'untitled')
    .normalize('NFKC')
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^\.+$/, 'untitled')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'untitled';
}

export function workspaceDirectoryPrefix(name?: string | null) {
  const timestamp = timestampForDirectory();
  return name ? `${timestamp}-${safeDirectoryName(name)}` : timestamp;
}

export function createSessionWorkingDirectory(parentCwd?: string, sessionName?: string | null) {
  const { APP_PATHS, TAU_SETTINGS, expandHome } = require('./config.js');
  const explicitParent = Boolean(parentCwd);
  const parent = path.resolve(expandHome(parentCwd || TAU_SETTINGS.projectsDir || APP_PATHS.scenarioDir));
  if (explicitParent) {
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
      throw new Error(`Directory not found: ${parent}`);
    }
  } else {
    fs.mkdirSync(parent, { recursive: true });
  }

  const prefix = workspaceDirectoryPrefix(sessionName);
  for (let i = 1; i <= 999; i++) {
    const name = i === 1 ? prefix : `${prefix}-${i}`;
    const candidate = path.join(parent, name);
    if (fs.existsSync(candidate)) continue;
    fs.mkdirSync(candidate);
    fs.mkdirSync(path.join(candidate, '.tau'));
    fs.writeFileSync(path.join(candidate, '.tau', WORKSPACE_OWNER_FILE), JSON.stringify({ version: 1, workspace: toPosixPath(fs.realpathSync(candidate)), parent: toPosixPath(fs.realpathSync(parent)) }));
    return candidate;
  }

  throw new Error(`Cannot create unique task directory in ${parent}`);
}

export function resolveSessionWorkspaceForDeletion(cwd: string, sessionFile?: string) {
  const { APP_PATHS, TAU_SETTINGS, SESSIONS_DIR } = require('./config.js');
  const resolved = path.resolve(cwd);
  const target = path.toNamespacedPath(resolved);
  let stat;
  try { stat = fs.lstatSync(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const refused = () => Object.assign(new Error(`Cannot verify task directory ownership: ${resolved}. Disable workspace deletion to keep this directory.`), { status: 409 });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !/^\d{8}-\d{6}(?:-.+)?$/.test(path.basename(resolved))) throw refused();
  // Keep canonical comparisons in ordinary paths; namespace prefixes are for filesystem calls.
  const real = fs.realpathSync(resolved);
  const historyRoot = fs.existsSync(SESSIONS_DIR) ? fs.realpathSync(SESSIONS_DIR) : path.resolve(SESSIONS_DIR);
  if (isWithin(real, historyRoot) || (sessionFile && isWithin(real, fs.realpathSync(sessionFile)))) throw refused();
  const ownerFile = path.join(resolved, '.tau', WORKSPACE_OWNER_FILE);
  if (fs.existsSync(ownerFile)) {
    const owner = JSON.parse(fs.readFileSync(containedFile(resolved, ownerFile), 'utf8'));
    if (owner.version !== 1 || typeof owner.workspace !== 'string' || typeof owner.parent !== 'string' || !isWithin(real, owner.workspace) || !isWithin(owner.workspace, real) || !isWithin(owner.parent, real) || isWithin(real, owner.parent) || path.relative(owner.parent, real) !== path.basename(real)) throw refused();
    return resolved;
  }
  // Older task directories have no owner marker; require the configured root and saved plan.
  const roots = [TAU_SETTINGS.projectsDir, APP_PATHS.scenarioDir].filter(Boolean);
  if (!roots.some((root: string) => fs.existsSync(root) && isWithin(fs.realpathSync(root), real) && !isWithin(real, fs.realpathSync(root)))) throw refused();
  const planFile = ['resolved-session-plan.v3.json', 'resolved-session-plan.json'].map((file) => path.join(resolved, '.tau', file)).find((file) => fs.existsSync(file));
  if (!planFile) throw refused();
  const plan = JSON.parse(fs.readFileSync(containedFile(resolved, planFile), 'utf8'));
  if (![2, 3].includes(plan.schemaVersion) || plan.platform?.name !== 'TransportX Agent' || typeof plan.workspace !== 'string' || !fs.existsSync(plan.workspace)) throw refused();
  const planWorkspace = fs.realpathSync(plan.workspace);
  if (!isWithin(real, planWorkspace) || !isWithin(planWorkspace, real)) throw refused();
  return resolved;
}

export async function removeSessionWorkingDirectory(cwd: string) {
  const resolved = path.resolve(cwd);
  const target = path.toNamespacedPath(resolved);
  const real = fs.realpathSync(resolved);
  const owner = { version: 1, workspace: toPosixPath(real), parent: toPosixPath(fs.realpathSync(path.dirname(real))) };
  try {
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    if (fs.existsSync(target)) throw Object.assign(new Error('Task directory still exists'), { code: 'ENOTEMPTY', path: cwd });
  } catch (error) {
    const cause = error as NodeJS.ErrnoException;
    let recoveryError = '';
    // A partial recursive removal may have deleted .tau before hitting a locked file.
    try {
      if (fs.existsSync(target) && !fs.lstatSync(target).isSymbolicLink() && path.relative(real, fs.realpathSync(resolved)) === '') {
        const metadata = path.join(resolved, '.tau');
        fs.mkdirSync(metadata, { recursive: true });
        if (!isWithin(real, fs.realpathSync(metadata))) throw new Error('Workspace metadata escapes its root');
        const marker = path.join(metadata, WORKSPACE_OWNER_FILE);
        if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify(owner), { flag: 'wx' });
      }
    } catch (recovery) { recoveryError = ` Ownership recovery failed: ${recovery instanceof Error ? recovery.message : String(recovery)}.`; }
    throw Object.assign(new Error(`Workspace cleanup failed (${cause.code || 'unknown'}): ${cause.path || cwd}. History retained; retry after resolving the error.${recoveryError}`), { status: 500, code: cause.code, path: cause.path || cwd });
  }
}
