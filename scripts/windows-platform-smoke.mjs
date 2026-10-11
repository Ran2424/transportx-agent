import process from 'node:process';
import { builderPlatformFor } from '../desktop/scripts/platform-profile.mjs';

if (builderPlatformFor() !== 'win') throw new Error('Windows platform smoke must run on Windows.');

if (process.env.TRANSPORTX_WINDOWS_INSTALLER) {
  await import('./windows-installer-smoke.mjs');
} else if (process.env.TRANSPORTX_PACKAGED_APP) {
  await import('./desktop-smoke.mjs');
} else {
  throw new Error('Set TRANSPORTX_PACKAGED_APP for an unpacked app or TRANSPORTX_WINDOWS_INSTALLER for an NSIS installer.');
}
