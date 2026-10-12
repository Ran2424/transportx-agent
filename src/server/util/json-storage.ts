import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readJsonObject(file: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
    return value;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw Object.assign(new Error(`JSON metadata is corrupt: ${file}. Restore a verified backup before writing.`, { cause }), { code: 'metadata_corrupt', status: 409 });
  }
}

export function writeJsonAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const previous = fs.existsSync(file) ? (readJsonObject(file), fs.readFileSync(file)) : null;
  const replace = (target: string, bytes: Buffer) => {
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temp, target);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temp, { force: true });
    }
  };
  if (previous) replace(`${file}.bak`, previous);
  replace(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
}

function isProcessAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code === 'EPERM'; }
}

function sleepSync(milliseconds: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** How long a lock without a readable owner.json is still attributed to a starting writer. */
const LEASE_GRACE_MS = 5_000;

function removeLockDir(lock: string): boolean {
  try { fs.rmSync(lock, { recursive: true, force: true }); return true; }
  catch { return false; }
}

/**
 * Returns true only when the existing lock was provably abandoned and has been
 * reclaimed. Returns false whenever a live writer may still own it, in which
 * case the caller must refuse to proceed.
 */
function reclaimStaleLease(lock: string): boolean {
  const ownerPath = path.join(lock, 'owner.json');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // Read owner.json directly: readJsonObject() returns {} for a missing file,
    // which would masquerade as a legible owner with a dead (undefined) pid.
    let owner: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) owner = parsed as Record<string, unknown>;
    } catch { owner = null; }
    if (owner) {
      // A legible owner whose process is still running keeps the lease;
      // a legible owner whose process is gone has abandoned it, regardless of age.
      return isProcessAlive(owner.pid) ? false : removeLockDir(lock);
    }
    // owner.json is missing or unreadable. A concurrent startup publishes it
    // immediately after mkdir, so only reclaim once the lock predates the grace
    // window; otherwise wait briefly and re-read.
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs >= LEASE_GRACE_MS) return removeLockDir(lock);
    } catch { return false; }
    sleepSync(200);
  }
  // Still fresh and unpublished after retries: assume a live writer owns it.
  return false;
}

/** A second live writer is refused; leases abandoned by dead processes are reclaimed. */
export function acquireWriteLease(target: string) {
  const lock = `${target}.transportx-lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      if (attempt === 0 && reclaimStaleLease(lock)) continue;
      throw Object.assign(new Error(`Another live writer owns ${lock}. Stop its processes before retrying.`), { code: 'writer_busy', status: 409 });
    }
  }
  const nonce = crypto.randomUUID();
  try { fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { fs.rmSync(lock, { recursive: true, force: true }); throw error; }
  return () => {
    const owner = readJsonObject(path.join(lock, 'owner.json'));
    if (owner.nonce === nonce) fs.rmSync(lock, { recursive: true });
  };
}

export function assertHostWriter(agentDir: string) {
  const ownerPath = path.join(agentDir, 'host.transportx-lock', 'owner.json');
  if (!fs.existsSync(path.dirname(ownerPath))) return;
  if (readJsonObject(ownerPath).pid !== process.pid) throw Object.assign(new Error('Another Host owns this Agent directory'), { code: 'writer_busy', status: 409 });
}

const mutations = new Map<string, Promise<unknown>>();
export function mutateJson<T>(file: string, execute: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = mutations.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    assertHostWriter(path.dirname(key));
    const release = acquireWriteLease(key);
    try { return await execute(); } finally { release(); }
  });
  mutations.set(key, operation);
  operation.finally(() => { if (mutations.get(key) === operation) mutations.delete(key); }).catch(() => {});
  return operation;
}
