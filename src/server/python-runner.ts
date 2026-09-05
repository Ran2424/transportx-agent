import type { Executable } from './runtime-resolver.js';
import { ProcessRunner } from './process-runner.js';

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
  private readonly runner = new ProcessRunner();

  constructor(executable: Executable) {
    this.executable = executable;
  }

  run(script: string, args: string[], opts: PythonRunOptions): Promise<PythonResult> {
    return this.runner.run(this.executable, [script, ...args], {
      cwd: opts.cwd,
      env: { ...opts.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      timeoutMs: opts.timeoutMs ?? 120_000,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      signal: opts.signal,
    });
  }

  terminateAll() {
    this.runner.terminateAll();
  }
}
