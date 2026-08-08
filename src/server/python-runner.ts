const { execFile } = require('node:child_process');

import type { ChildProcess } from 'node:child_process';
import type { Executable } from './runtime-resolver.js';
import { signalProcessTree } from './process-tree.js';

export type PythonRunOptions = {
  cwd: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxBuffer?: number;
};

export type PythonResult = { stdout: string; stderr: string };

export class PythonRunner {
  executable: Executable;
  children = new Set<ChildProcess>();

  constructor(executable: Executable) {
    this.executable = executable;
  }

  run(script: string, args: string[], opts: PythonRunOptions): Promise<PythonResult> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = execFile(
        this.executable.command,
        [...this.executable.args, script, ...args],
        {
          cwd: opts.cwd,
          env: { ...process.env, ...opts.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          encoding: 'utf8',
          timeout: opts.timeoutMs ?? 120_000,
          maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
          signal: opts.signal,
          detached: process.platform !== 'win32',
        },
        (error: Error | null, stdout: string, stderr: string) => {
          this.children.delete(child);
          if (error) {
            const wrapped = new Error(stderr.trim() || error.message) as Error & { stderr?: string };
            wrapped.stderr = stderr;
            reject(wrapped);
          } else resolve({ stdout, stderr });
        },
      );
      this.children.add(child);
    });
  }

  terminateAll() {
    for (const child of this.children) {
      signalProcessTree(child, 'SIGTERM');
    }
    this.children.clear();
  }
}
