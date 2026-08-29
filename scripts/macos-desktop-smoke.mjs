import process from 'node:process';

if (process.platform !== 'darwin') throw new Error('macOS platform smoke must run on macOS.');
await import('./desktop-smoke.mjs');
