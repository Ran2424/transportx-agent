import { createRequire } from 'node:module';
import { getSimulationProbeProfile } from '../../desktop/scripts/platform-profile.mjs';

const require = createRequire(import.meta.url);
const { ProcessRunner } = require('../../bin/process-runner.js');

export async function inspectNativeProcess(pid) {
  const profile = getSimulationProbeProfile();
  const result = await new ProcessRunner().run({ command: profile.processCommand, args: [] }, profile.processArgs(pid), { envMode: 'replace', env: {}, timeoutMs: 5000, maxBuffer: 65536 });
  const bytes = Number(result.stdout.trim().split(/\s+/)[0]) * 1024;
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error('native_memory_probe');
  if (result.stdout.includes('TRANSPORTX_TEST_PARENT_SECRET=') || result.stdout.includes('TAU_SESSION_TOKEN=')) throw new Error('native_environment_leak');
  return { rssBytes: bytes, parentMarkersAbsent: true };
}
