export class RpcCommandLedger<T> {
  private readonly entries = new Map<string, { settledAt: number; pending: boolean; unknown: boolean; fingerprint: string; promise: Promise<T> }>();

  constructor(private readonly maxEntries = 200, private readonly ttlMs = 10 * 60_000, private readonly isUnknown: (value: T) => boolean = () => false) {}

  run(key: string, execute: () => Promise<T>, fingerprint = ''): Promise<T> {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return Promise.reject(Object.assign(new Error('Command ID payload conflict'), { code: 'command_conflict' }));
      return existing.promise;
    }
    if (this.entries.size >= this.maxEntries) {
      const completed = [...this.entries].find(([, entry]) => !entry.pending && !entry.unknown);
      if (!completed) return Promise.reject(Object.assign(new Error('Command ledger capacity reached'), { code: 'command_capacity' }));
      this.entries.delete(completed[0]);
    }
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    const entry = { settledAt: 0, pending: true, unknown: false, fingerprint, promise };
    this.entries.set(key, entry); // Reserve identity before execute can re-enter.
    try {
      void execute().then((value) => {
        entry.pending = false; entry.unknown = this.isUnknown(value); entry.settledAt = Date.now();
        resolve(value);
      }, (error) => {
        entry.pending = false; entry.unknown = true; entry.settledAt = Date.now(); reject(error);
      });
    } catch (error) {
      entry.pending = false; entry.unknown = true; reject(error);
    }
    return promise;
  }

  settle(key: string, value: T) {
    const entry = this.entries.get(key);
    if (!entry || entry.pending) return;
    entry.unknown = this.isUnknown(value);
    entry.settledAt = Date.now();
    entry.promise = Promise.resolve(value);
  }

  private prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.entries) if (!entry.pending && !entry.unknown && entry.settledAt < cutoff) this.entries.delete(key);
  }
}
