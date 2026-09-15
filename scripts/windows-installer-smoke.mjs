import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') throw new Error('Windows installer smoke must run on Windows.');

const installer = process.env.TRANSPORTX_WINDOWS_INSTALLER;
if (!installer) throw new Error('TRANSPORTX_WINDOWS_INSTALLER must point to the NSIS setup .exe.');
const installerPath = path.resolve(installer);
if (!fs.existsSync(installerPath) || path.extname(installerPath).toLowerCase() !== '.exe') throw new Error(`NSIS installer is missing or invalid: ${installerPath}`);

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transportx-windows-installer-'));
const installDir = path.join(temporaryRoot, 'install');
const dataRoot = path.join(temporaryRoot, 'user-data');
const productExecutable = path.join(installDir, 'TransportX Agent.exe');
const uninstaller = path.join(installDir, 'Uninstall TransportX Agent.exe');

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, timeout: 120_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(result.error?.message || result.stderr || result.stdout || '').trim()}`);
}

try {
  // NSIS requires /D to be the final argument. A temporary path without spaces
  // keeps this non-interactive check independent from the current user profile.
  run(installerPath, ['/S', `/D=${installDir}`]);
  if (!fs.existsSync(productExecutable) || !fs.existsSync(uninstaller)) throw new Error('NSIS installation did not create the application and uninstaller.');

  run(process.execPath, [path.join(process.cwd(), 'scripts', 'desktop-smoke.mjs')], {
    ...process.env,
    TRANSPORTX_PACKAGED_APP: productExecutable,
    TRANSPORTX_SMOKE_DATA_ROOT: dataRoot,
  });

  fs.mkdirSync(dataRoot, { recursive: true });
  const sentinel = path.join(dataRoot, 'uninstall-preserves-user-data.txt');
  fs.writeFileSync(sentinel, 'keep');
  run(uninstaller, ['/S']);
  if (fs.existsSync(installDir)) throw new Error('NSIS uninstall did not remove the application directory.');
  if (!fs.existsSync(sentinel)) throw new Error('NSIS uninstall unexpectedly removed user data.');
  console.log(`Windows NSIS installer smoke passed: ${path.basename(installerPath)}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
