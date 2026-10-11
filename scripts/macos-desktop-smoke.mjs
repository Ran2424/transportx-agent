import process from 'node:process';
import { builderPlatformFor } from '../desktop/scripts/platform-profile.mjs';

if (builderPlatformFor() !== 'mac') throw new Error('macOS platform smoke must run on macOS.');
await import('./desktop-smoke.mjs');
