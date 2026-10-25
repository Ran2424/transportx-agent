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

const NONCE_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

type LeaseOwner = { pid: number; nonce: string };
function readLease(lock: string): { file: string; owner: LeaseOwner } | null {
  try {
    if (!fs.lstatSync(lock).isDirectory()) return null;
    const files = fs.readdirSync(lock);
    if (files.length !== 1) return null;
    const file = path.join(lock, files[0]);
    if (!fs.lstatSync(file).isFile()) return null;
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as LeaseOwner;
    if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string' || !NONCE_PATTERN.test(owner.nonce)) return null;
    if (files[0] !== 'owner.json' && files[0] !== `owner.${owner.nonce}.json`) return null;
    return { file, owner };
  } catch { return null; }
}

function processExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function removeLeaseOwner(lock: string, file: string): boolean {
  // Only one contender can unlink this generation. A losing contender must not
  // remove the directory: it may already contain a new writer's owner file.
  try { fs.unlinkSync(file); } catch { return false; }
  try { fs.rmdirSync(lock); return true; } catch { return false; }
}

function reclaimStaleLease(lock: string): boolean {
  const lease = readLease(lock);
  if (!lease || !processExited(lease.owner.pid)) return false;
  let file = lease.file;
  if (path.basename(file) === 'owner.json') {
    // Migrate the previous format before claiming it. New writers never reuse
    // owner.json, so a delayed legacy contender cannot unlink their owner.
    const migrated = path.join(lock, `owner.${lease.owner.nonce}.json`);
    try { fs.renameSync(file, migrated); } catch { return false; }
    const current = readLease(lock);
    if (!current || current.owner.nonce !== lease.owner.nonce || current.owner.pid !== lease.owner.pid) {
      try { fs.renameSync(migrated, file); } catch {}
      return false;
    }
    file = migrated;
  }
  return removeLeaseOwner(lock, file);
}

/** Refuse unverified/live owners; reclaim only a confirmed dead generation. */
export function acquireWriteLease(target: string) {
  const lock = `${target}.transportx-lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      if (attempt === 0 && reclaimStaleLease(lock)) continue;
      throw Object.assign(new Error(`Another writer owns ${lock}, or its owner cannot be verified. Stop its processes and inspect the lock before retrying.`), { code: 'writer_busy', status: 409 });
    }
  }
  const nonce = crypto.randomUUID();
  const ownerFile = path.join(lock, `owner.${nonce}.json`);
  try { fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { try { fs.rmdirSync(lock); } catch {} throw error; }
  const release = () => {
    const lease = readLease(lock);
    if (lease?.owner.nonce === nonce) removeLeaseOwner(lock, ownerFile);
  };
  return Object.assign(release, { assertOwned() {
    const lease = readLease(lock);
    if (lease?.owner.nonce !== nonce || lease.owner.pid !== process.pid) throw Object.assign(new Error(`Writer lease generation changed: ${lock}`), { code: 'writer_busy', status: 409 });
  } });
}

export function assertHostWriter(agentDir: string) {
  const lock = path.join(agentDir, 'host.transportx-lock');
  if (!fs.existsSync(lock)) return;
  if (readLease(lock)?.owner.pid !== process.pid) throw Object.assign(new Error('Another Host owns this Agent directory, or its owner cannot be verified'), { code: 'writer_busy', status: 409 });
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
