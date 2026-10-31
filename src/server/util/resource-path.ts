import fs from 'node:fs';
import path from 'node:path';
import { isWithin } from './path.js';

/** Check both logical membership and the final symlink destination. */
export function containedFile(root: string, candidate: string) {
  const resolved = path.resolve(candidate);
  const canonicalRoot = fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root);
  if ((!isWithin(path.resolve(root), resolved) && !isWithin(canonicalRoot, resolved)) || !isWithin(canonicalRoot, fs.realpathSync(resolved))) throw Object.assign(new Error('File path escapes its root'), { status: 403 });
  if (!fs.statSync(resolved).isFile()) throw Object.assign(new Error('Not a file'), { status: 404 });
  return resolved;
}
