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
  return platform === 'darwin' ? path.join(path.resolve(homeDir), '.transportx', 'traffic-agent') : path.resolve(electronDefault);
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
