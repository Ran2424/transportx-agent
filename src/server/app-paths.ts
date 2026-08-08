const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

export type AppPaths = {
  appRoot: string;
  resourcesDir: string;
  userDataDir: string;
  scenarioDir: string;
  settingsDir: string;
  logsDir: string;
  sessionsDir: string;
  cacheDir: string;
  modulesDir: string;
  piAgentDir: string;
};

export function defaultUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === 'darwin') return path.join(home, '.transportx', 'traffic-agent');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'TransportX Traffic Agent');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'transportx-traffic-agent');
}

export function resolveAppPaths(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): AppPaths {
  const appRoot = path.resolve(env.TAU_APP_ROOT || process.cwd());
  const resourcesDir = path.resolve(env.TAU_RESOURCES_DIR || appRoot);
  const userDataDir = path.resolve(env.TAU_USER_DATA_DIR || defaultUserDataDir(platform, env));
  const piAgentDir = path.resolve(env.PI_CODING_AGENT_DIR || userDataDir);
  return {
    appRoot,
    resourcesDir,
    userDataDir,
    scenarioDir: path.join(userDataDir, 'scenario'),
    settingsDir: path.join(userDataDir, 'settings'),
    logsDir: path.join(userDataDir, 'logs'),
    sessionsDir: path.resolve(env.PI_CODING_AGENT_SESSION_DIR || path.join(piAgentDir, 'sessions')),
    cacheDir: path.join(userDataDir, 'cache'),
    modulesDir: path.join(userDataDir, 'modules'),
    piAgentDir,
  };
}

export function ensureWritableAppPaths(paths: AppPaths) {
  for (const dir of [paths.userDataDir, paths.scenarioDir, paths.settingsDir, paths.logsDir, paths.sessionsDir, paths.cacheDir, paths.modulesDir, paths.piAgentDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
