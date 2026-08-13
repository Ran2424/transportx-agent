export class RpcCommandLedger<T> {
  private readonly entries = new Map<string, { createdAt: number; promise: Promise<T> }>();

  constructor(private readonly maxEntries = 200, private readonly ttlMs = 10 * 60_000) {}

  run(key: string, execute: () => Promise<T>): Promise<T> {
    this.prune();
    const existing = this.entries.get(key);
    if (existing) return existing.promise;
    const promise = execute();
    this.entries.set(key, { createdAt: Date.now(), promise });
    this.prune();
    return promise;
  }

  private prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.entries) if (entry.createdAt < cutoff) this.entries.delete(key);
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}
