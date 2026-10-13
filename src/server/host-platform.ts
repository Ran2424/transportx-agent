const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

// Built from the authoritative release profile, never hand-maintained here.
type HostOperations = {
  posixPermissions: boolean;
  desktopDataRoot?: 'electron';
  detached: boolean; tree: string; treeCommand?: string; treeArgs?: string[]; treeForceArg?: string;
  openCommand: string; detachedOpen: boolean; utilityHost: boolean; insetTitleBar: boolean;
  dataRoot: { env: string | null; fallback: string[]; parts: string[] };
};
const profiles: Record<string, HostOperations> = require('./host-platform.json');
export function hostOperations(platform: NodeJS.Platform = process.platform) {
  const profile = profiles[platform];
  if (!profile) throw new Error(`Host operations missing for ${platform}`);
  return profile;
}
export const hostPlatform = hostOperations();

export function platformDataRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string) {
  const profile = hostOperations(platform).dataRoot;
  return path.join(profile.env && env[profile.env] || path.join(home, ...profile.fallback), ...profile.parts);
}

export function openNativeTarget(target: string): Promise<void> {
  if (hostPlatform.detachedOpen) {
    const child = spawn(hostPlatform.openCommand, [target], { detached: true, stdio: 'ignore' });
    child.unref();
    return new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  }
  return new Promise((resolve, reject) => execFile(hostPlatform.openCommand, [target], (error: NodeJS.ErrnoException | null) => error ? reject(error) : resolve()));
}
