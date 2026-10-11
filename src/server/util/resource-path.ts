import fs from 'node:fs';
import path from 'node:path';
import { isWithin } from './path.js';

/** Check both logical membership and the final symlink destination. */
export function containedFile(root: string, candidate: string) {
  const resolved = path.resolve(candidate);
  if (!isWithin(root, resolved) || !isWithin(fs.realpathSync(root), fs.realpathSync(resolved))) throw Object.assign(new Error('File path escapes its root'), { status: 403 });
  if (!fs.statSync(resolved).isFile()) throw Object.assign(new Error('Not a file'), { status: 404 });
  return resolved;
}
