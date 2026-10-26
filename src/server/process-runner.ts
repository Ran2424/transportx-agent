import { hostPlatform } from './host-platform.js';
const { spawn } = require('node:child_process');

import type { ChildProcess } from 'node:child_process';
import type { Executable } from './runtime-resolver.js';
import { signalProcessTree } from './process-tree.js';
import { managedRuntimeProcess } from './workspace-runtime.js';

export type ProcessRunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
  errorMessage?(stderr: string, error: Error): string;
};

const hostChildren = new Set<ChildProcess>();

export class ProcessRunner {
  get activeCount() { return this.children.size; }
  private readonly children = new Map<ChildProcess, { stop(): void; completion: Promise<unknown> }>();

  run(executable: Executable, args: string[], options: ProcessRunOptions): Promise<{ stdout: string; stderr: string }> {
    if (hostChildren.size >= 4) return Promise.reject(Object.assign(new Error('Host process capacity reached'), { status: 503 }));
    if (options.signal?.aborted) return Promise.reject(new Error('Analysis cancelled'));
    let tracked: ReturnType<typeof managedRuntimeProcess>;
    try { tracked = managedRuntimeProcess(options.cwd); }
    catch (error) { return Promise.reject(error); }
    const child: ChildProcess = spawn(executable.command, [...executable.args, ...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.env },
      detached: hostPlatform.detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let trackingError: Error | null = null;
    try { tracked?.started(child); } catch (error) { trackingError = error as Error; }
    hostChildren.add(child);
    let stop!: () => void;
    const completion = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      let stopped: Error | null = null;
      let spawnError: Error | null = null;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let stopDeadline: ReturnType<typeof setTimeout> | undefined;
      const halt = (reason: Error) => {
        if (stopped) return;
        stopped = reason;
        signalProcessTree(child, 'SIGTERM');
        forceTimer = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 1500);
        stopDeadline = setTimeout(() => reject(Object.assign(new Error('Analysis process exit was not confirmed'), { code: 'process_stop_unconfirmed', status: 503 })), 5000);
      };
      const cancelled = () => halt(new Error('Analysis cancelled'));
      stop = cancelled;
      const timer = setTimeout(() => halt(new Error('Analysis timed out')), options.timeoutMs);
      options.signal?.addEventListener('abort', cancelled, { once: true });
      const capture = (stream: ChildProcess['stdout']) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        stream?.on('data', (chunk: Buffer) => {
          if (stopped) return;
          bytes += chunk.length;
          if (bytes > options.maxBuffer) { halt(new Error('Analysis output exceeds the buffer limit')); return; }
          chunks.push(chunk);
        });
        return () => Buffer.concat(chunks).toString('utf8');
      };
      const stdout = capture(child.stdout);
      const stderr = capture(child.stderr);
      child.once('error', (error) => { spawnError = error; });
      child.once('exit', () => { if (stopped) signalProcessTree(child, 'SIGKILL'); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(stopDeadline);
        options.signal?.removeEventListener('abort', cancelled);
        this.children.delete(child);
        hostChildren.delete(child);
        try { tracked?.stopped(); }
        catch { return reject(Object.assign(new Error('Process exited but its runtime stop record could not be saved.'), { code: 'process_stop_unconfirmed', status: 503 })); }
        if (stopped) return reject(stopped);
        if (!spawnError && code === 0) return resolve({ stdout: stdout(), stderr: stderr() });
        signalProcessTree(child, 'SIGKILL');
        const error = spawnError || new Error(`Analysis process exited (${signal || code})`);
        const output = stderr();
        const wrapped = Object.assign(new Error(options.errorMessage?.(output, error) || output.trim() || error.message), { stderr: output });
        reject(wrapped);
      });
      if (trackingError) halt(trackingError);
    });
    this.children.set(child, { stop, completion });
    return completion;
  }

  async terminateAll() {
    const running = [...this.children.values()];
    for (const run of running) run.stop();
    const results = await Promise.allSettled(running.map((run) => run.completion));
    const failed = results.find((result) => result.status === 'rejected' && result.reason?.code === 'process_stop_unconfirmed');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}
