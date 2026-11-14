import crypto from 'node:crypto';
import { boundedDiagnostics } from '../contracts/diagnostics.js';
import { performance } from 'node:perf_hooks';
import { logHostEvent } from './diagnostic-log.js';

export class SessionJobs {
  private readonly jobs = new Map<string, Set<{ id: string; controller: AbortController; completion: Promise<unknown> }>>();
  private readonly diagnose = boundedDiagnostics();

  has(id: string) { return !!this.jobs.get(id)?.size; }
  run<T>(id: string, execute: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, onJob?: (jobId: string) => void): Promise<T> {
    const owned = this.jobs.get(id) || new Set();
    const total = [...this.jobs.values()].reduce((count, jobs) => count + jobs.size, 0);
    if (owned.size >= 2 || total >= 4) return Promise.reject(Object.assign(new Error('Analysis job capacity reached'), { status: 503 }));
    const jobId = crypto.randomUUID();
    const started = performance.now();
    onJob?.(jobId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const job = { id: jobId, controller, completion: Promise.resolve() as Promise<unknown> };
    owned.add(job);
    this.jobs.set(id, owned);
    const completion = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error('Analysis cancelled');
      return execute(controller.signal);
    }).catch((error) => {
      logHostEvent('warn', 'analysis_job_failed', { sessionId: id, jobId, code: (error as { code?: string } | null)?.code, durationMs: Math.round(performance.now() - started) });
      throw error;
    }).finally(() => {
      signal?.removeEventListener('abort', abort);
      owned.delete(job);
      if (!owned.size) this.jobs.delete(id);
    });
    job.completion = completion;
    return completion;
  }
  async cancel(id: string) {
    const jobs = [...(this.jobs.get(id) || [])];
    if (!jobs.length) return;
    for (const job of jobs) job.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results = await Promise.race([
        Promise.allSettled(jobs.map((job) => job.completion)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Analysis jobs did not stop'), { code: 'process_stop_unconfirmed', status: 503 })), 5500); }),
      ]);
      const failed = results.find((result) => result.status === 'rejected' && result.reason?.code === 'process_stop_unconfirmed');
      if (failed?.status === 'rejected') {
        for (const job of jobs) this.diagnose('job_stop_unconfirmed', { sessionId: id, jobId: job.id });
        throw failed.reason;
      }
    } finally { clearTimeout(timer); }
  }
}
