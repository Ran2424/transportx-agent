import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { hostPlatform } from './host-platform.js';
import { signalProcessTree } from './process-tree.js';

export type ProcessIdentity = { pid: number; startedAt: string; executableSha256: string; bootId: string };
export type ProcessObservation = { state: 'running'; identity: ProcessIdentity; parentPid: number; groupId: number | null } | { state: 'exited' } | { state: 'unknown'; reason: string };
let bootId: string | undefined;
export function currentBootId() {
  if (bootId) return bootId;
  const profile = hostPlatform.processInspection;
  const value = execFileSync(profile.bootCommand, profile.bootArgs, { encoding: 'utf8', timeout: 5000, maxBuffer: 16384, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (!value || value.length > 1000) throw new Error('System boot identity could not be verified.');
  bootId = crypto.createHash('sha256').update(value).digest('hex');
  return bootId;
}

/** Only OS-confirmed absence means exited; command errors remain unknown. */
export function inspectProcess(pid: number, pythonCommand: string): ProcessObservation {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown', reason: 'Invalid recorded PID.' };
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { state: 'exited' }; }
  try {
    const profile = hostPlatform.processInspection;
    const command = profile.pythonScript ? pythonCommand : profile.command!;
    const args = profile.pythonScript ? ['-c', profile.pythonScript, String(pid)] : profile.args!.map((arg) => arg.replaceAll('{pid}', String(pid)));
    const output = execFileSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16384, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C', LANG: 'C', PYTHONDONTWRITEBYTECODE: '1' } }).trim();
    const value = JSON.parse(output);
    if (value?.state === 'exited') return { state: 'exited' };
    if (value?.state !== 'running' || Number(value.pid) !== pid || typeof value.startedAt !== 'string' || !value.startedAt || typeof value.command !== 'string' || !value.command || !Number.isSafeInteger(value.parentPid)) throw new Error('Incomplete process inspection.');
    return { state: 'running', identity: { pid, startedAt: value.startedAt, executableSha256: crypto.createHash('sha256').update(value.command).digest('hex'), bootId: currentBootId() }, parentPid: value.parentPid, groupId: Number.isSafeInteger(value.groupId) ? value.groupId : null };
  } catch (error) {
    try { process.kill(pid, 0); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ESRCH') return { state: 'exited' }; }
    const code = (error as NodeJS.ErrnoException & { status?: number }).code || (error as { status?: number }).status;
    return { state: 'unknown', reason: code ? `Native process identity is unavailable (${code}).` : 'Native process identity could not be validated.' };
  }
}
export function inspectRecordedProcess(identity: ProcessIdentity, pythonCommand: string): ProcessObservation | { state: 'replaced' } {
  try { if (identity.bootId !== currentBootId()) return { state: 'exited' }; }
  catch (error) { return { state: 'unknown', reason: error instanceof Error ? error.message : 'Boot identity unavailable.' }; }
  const current = inspectProcess(identity.pid, pythonCommand);
  if (current.state === 'running' && current.identity.startedAt !== identity.startedAt) return { state: 'replaced' };
  if (current.state === 'running' && current.identity.executableSha256 !== identity.executableSha256) return { state: 'unknown', reason: 'Recorded process changed its executable; identity cannot be confirmed.' };
  return current;
}

/** Explicit recovery only. Never signal a PID whose recorded identity changed. */
export async function stopRecordedProcess(identity: ProcessIdentity, pythonCommand: string) {
  const start = Date.now();
  let forced = false, signalled = false;
  while (Date.now() - start < 5500) {
    const current = inspectRecordedProcess(identity, pythonCommand);
    if (current.state === 'exited' || current.state === 'replaced') return;
    if (current.state === 'unknown') throw Object.assign(new Error(current.reason), { code: 'process_stop_unconfirmed', status: 503 });
    if (!signalled || !forced && Date.now() - start >= 1500) {
      const signal = signalled ? 'SIGKILL' : 'SIGTERM';
      // A recorded group leader owns its process group; otherwise signal only
      // this exact PID. Windows tree operations are supplied by the profile.
      try {
        if (hostPlatform.tree === 'taskkill' || current.groupId === identity.pid) signalProcessTree({ pid: identity.pid, kill: (signal: NodeJS.Signals) => process.kill(identity.pid, signal) } as unknown as ChildProcess, signal);
        else process.kill(identity.pid, signal);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw Object.assign(new Error('Recorded process could not be signalled.'), { code: 'process_stop_unconfirmed', status: 503 }); }
      if (signalled) forced = true; signalled = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Object.assign(new Error('Recorded process stop could not be confirmed.'), { code: 'process_stop_unconfirmed', status: 503 });
}
