const path = require('node:path');

export type DesktopPaths = {
  appRoot: string;
  resourcesDir: string;
  userDataDir: string;
  logsDir: string;
  agentHostEntrypoint: string;
};

export function resolveDesktopUserDataDir(homeDir: string, electronDefault: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  if (env.TAU_USER_DATA_DIR) return path.resolve(env.TAU_USER_DATA_DIR);
  if (platform === 'darwin') return path.join(path.resolve(homeDir), '.transportx', 'traffic-agent');
  // Match the macOS vendor/product split so the canonical
  // `~/.transportx/traffic-agent/` path has a single Windows equivalent.
  // The legacy behaviour was to defer to Electron's default which used the
  // productName ('TransportX Traffic Agent') as the leaf, breaking the
  // cross-OS symmetry.
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'TransportX', 'traffic-agent');
  return path.resolve(electronDefault);
}

export function resolveDesktopPaths(appRoot: string, resourcesDir: string, userDataDir: string): DesktopPaths {
  return {
    appRoot: path.resolve(appRoot),
    resourcesDir: path.resolve(resourcesDir),
    userDataDir: path.resolve(userDataDir),
    logsDir: path.join(path.resolve(userDataDir), 'logs'),
    agentHostEntrypoint: path.join(path.resolve(appRoot), 'bin', 'tau.js'),
  };
}
