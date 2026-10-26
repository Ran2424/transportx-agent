import fs from 'node:fs';
import path from 'node:path';
import { toPosixPath } from './util/path.js';

export type MigrationSpaceWrite = { path: string; backupBytes: number; newBytes: number; atomicBytes: number };
export type MigrationSpaceVolume = { volume: string; paths: string[]; backupBytes: number; newBytes: number; atomicBytes: number; marginBytes: number; requiredBytes: number; availableBytes: number };

export function migrationSpaceRequirements(writes: MigrationSpaceWrite[], observe = (location: string) => {
  let directory = path.resolve(location);
  while (!fs.existsSync(directory)) { const parent = path.dirname(directory); if (parent === directory) throw new Error('Cannot locate migration target volume.'); directory = parent; }
  directory = fs.realpathSync(directory);
  const stat = fs.statSync(directory), space = fs.statfsSync(directory, { bigint: true });
  const available = space.bavail * space.bsize;
  if (available < 0n || available > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Cannot reliably represent available disk space.');
  return { volume: String(stat.dev), availableBytes: Number(available) };
}): MigrationSpaceVolume[] {
  const volumes = new Map<string, MigrationSpaceVolume>();
  for (const write of writes) {
    if (![write.backupBytes, write.newBytes, write.atomicBytes].every((bytes) => Number.isSafeInteger(bytes) && bytes >= 0)) throw new Error('Invalid migration space estimate.');
    let observation: ReturnType<typeof observe>;
    try { observation = observe(write.path); }
    catch (cause) { throw Object.assign(new Error('Migration volume space cannot be verified.', { cause }), { code: 'migration_space_unknown', status: 409, path: toPosixPath(path.resolve(write.path)) }); }
    if (!Number.isSafeInteger(observation.availableBytes) || observation.availableBytes < 0 || !observation.volume) throw Object.assign(new Error('Migration volume space cannot be verified.'), { code: 'migration_space_unknown', status: 409 });
    const current = volumes.get(observation.volume) || { volume: observation.volume, paths: [], backupBytes: 0, newBytes: 0, atomicBytes: 0, marginBytes: 0, requiredBytes: 0, availableBytes: observation.availableBytes };
    current.paths.push(toPosixPath(path.resolve(write.path)));
    current.backupBytes += write.backupBytes; current.newBytes += write.newBytes; current.atomicBytes += write.atomicBytes;
    current.availableBytes = Math.min(current.availableBytes, observation.availableBytes); volumes.set(current.volume, current);
  }
  for (const volume of volumes.values()) {
    const bytes = volume.backupBytes + volume.newBytes + volume.atomicBytes;
    volume.marginBytes = Math.max(16 * 1024 * 1024, Math.ceil(bytes * 0.1)); volume.requiredBytes = bytes + volume.marginBytes;
    if (!Number.isSafeInteger(volume.requiredBytes)) throw Object.assign(new Error('Migration space estimate is too large.'), { code: 'migration_space_unknown', status: 409 });
  }
  return [...volumes.values()];
}

export function assertMigrationSpace(volumes: MigrationSpaceVolume[]) {
  if (volumes.some((volume) => volume.availableBytes < volume.requiredBytes)) throw Object.assign(new Error('Insufficient migration space. Free space on the listed volumes and explicitly retry.'), { code: 'migration_space_insufficient', status: 409, volumes });
}
