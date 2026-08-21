import process from 'node:process';

if (process.platform === 'darwin') await import('./check-mac-release.mjs');
if (process.platform === 'win32') await import('./check-windows-release.mjs');
