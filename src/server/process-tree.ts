const { execFile } = require('node:child_process');

import type { ChildProcess } from 'node:child_process';

export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(child.pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    execFile('taskkill', args, () => {});
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}

export function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(forceTimer);
      clearTimeout(deadline);
      child.off('exit', exited);
      if (error) reject(error); else resolve();
    };
    const exited = () => { signalProcessTree(child, 'SIGKILL'); finish(); };
    const forceTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 1500);
    const deadline = setTimeout(() => finish(Object.assign(new Error('Process exit was not confirmed'), { code: 'process_stop_unconfirmed', status: 503 })), 5000);
    child.once('exit', exited);
    signalProcessTree(child, 'SIGTERM');
  });
}
