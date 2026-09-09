const { execFile } = require('node:child_process');

import type { ChildProcess } from 'node:child_process';
import type { Executable } from './runtime-resolver.js';
import { signalProcessTree } from './process-tree.js';

export type ProcessRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
  errorMessage?(stderr: string, error: Error): string;
};

export class ProcessRunner {
  private readonly children = new Set<ChildProcess>();

  run(executable: Executable, args: string[], options: ProcessRunOptions): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = execFile(executable.command, [...executable.args, ...args], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: { ...process.env, ...options.env },
        encoding: 'utf8',
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
        detached: process.platform !== 'win32',
      }, (error: Error | null, stdout: string, stderr: string) => {
        this.children.delete(child);
        if (!error) return resolve({ stdout, stderr });
        const wrapped = new Error(options.errorMessage?.(stderr, error) || stderr.trim() || error.message) as Error & { stderr?: string };
        wrapped.stderr = stderr;
        reject(wrapped);
      });
      this.children.add(child);
    });
  }

  terminateAll() {
    for (const child of this.children) signalProcessTree(child, 'SIGTERM');
    this.children.clear();
  }
}
