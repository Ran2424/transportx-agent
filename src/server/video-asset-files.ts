import fs from 'node:fs';
import path from 'node:path';
import { isWithin } from './util/path.js';

export function resolveSafeDataFile(assetRoot: string, relativeFile: string) {
  if (path.isAbsolute(relativeFile)) throw new Error(`Video file must be relative: ${relativeFile}`);
  const root = fs.realpathSync(assetRoot);
  const parts = relativeFile.split(/[\\/]+/);
  let cursor = root;
  for (const part of parts) {
    if (!part || part === '.' || part === '..') throw new Error(`Unsafe video file path: ${relativeFile}`);
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Video files cannot use symbolic links: ${relativeFile}`);
  }
  const resolved = fs.realpathSync(path.resolve(root, relativeFile));
  if (!isWithin(root, resolved) || !fs.statSync(resolved).isFile()) throw new Error(`Video file escapes the Data Root: ${relativeFile}`);
  return resolved;
}
