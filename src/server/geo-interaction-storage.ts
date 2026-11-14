import fs from 'node:fs';
import path from 'node:path';
import { isWithin } from './util/path.js';
import { conversationStatePath } from './workspace-store.js';
import { readJsonObject, writeJsonAtomic as writeMetadata } from './util/json-storage.js';

export function serviceError(message: string, status = 400, code?: string) {
  const error = new Error(message) as Error & { status?: number; code?: string };
  error.status = status;
  if (code) error.code = code;
  return error;
}

type GeoScope = { cwd: string; conversationId: string };
export function interactionRoot(scope: GeoScope) { return conversationStatePath(scope, 'geo-interactions'); }
export function contextDir(scope: GeoScope, contextId: string) { return path.join(interactionRoot(scope), 'contexts', contextId); }
export function requestDir(scope: GeoScope, requestId: string) { return path.join(interactionRoot(scope), 'requests', requestId); }
export function refsPath(scope: GeoScope) { return path.join(interactionRoot(scope), 'message-refs.json'); }

function assertNoSymlink(target: string) {
  try { if (fs.lstatSync(target).isSymbolicLink()) throw serviceError('Geo interaction storage cannot use symbolic links.', 403); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
}

function ensureStoragePath(cwd: string, target: string) {
  const sessionRoot = path.resolve(cwd);
  const resolved = path.resolve(target);
  if (!isWithin(sessionRoot, resolved)) throw serviceError('Geo interaction path escapes the session.', 403);
  assertNoSymlink(path.join(cwd, '.tau'));
  assertNoSymlink(resolved);
  for (let cursor = path.dirname(resolved); cursor !== sessionRoot && isWithin(sessionRoot, cursor); cursor = path.dirname(cursor)) assertNoSymlink(cursor);
  return resolved;
}

export function writeScreenshot(cwd: string, filename: string, image: Buffer) {
  const target = ensureStoragePath(cwd, path.join(cwd, filename));
  assertNoSymlink(target);
  fs.writeFileSync(target, image, { flag: 'wx', mode: 0o600 });
  return target;
}

export function writeJsonAtomic(cwd: string, target: string, value: unknown) {
  const resolved = ensureStoragePath(cwd, target);
  writeMetadata(resolved, value);
}

export function readMessageRefMetadata(scope: GeoScope) {
  return readJsonObject(ensureStoragePath(scope.cwd, refsPath(scope)), { version: 1, refs: [] });
}

export function readJson<T>(cwd: string, target: string): T | null {
  try {
    const resolved = ensureStoragePath(cwd, target);
    const realSession = fs.realpathSync(cwd);
    const realTarget = fs.realpathSync(resolved);
    if (!isWithin(realSession, realTarget) || !fs.statSync(realTarget).isFile()) throw serviceError('Geo interaction file is outside the session.', 403);
    return JSON.parse(fs.readFileSync(realTarget, 'utf8')) as T;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw cause;
  }
}
